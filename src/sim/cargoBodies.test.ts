// Cargo with its own body (docs/cargo-bodies.md, core/cargoBody.ts): a rig declaring `cargo` is one dynamic body whose
// collider is its links, and a cylinder link stays round. These pin what that is for: a drum on its side rolls where a
// box of the same size slides to a stop, a drum stands on its end, and a spawner makes drums as their own shape.

import initJolt from 'jolt-physics'
import type Jolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { CARGO_CAP_FORK_POCKETS, CARGO_CAP_HEAVY, CARGO_CAP_LOAD_BASE, CARGO_CAP_SEPARATE_CONTACTS, CARGO_KIND_BOX, CARGO_KIND_PALLET, CARGO_KIND_PART, CARGO_KIND_TOTE, capsOfKind, cargoSeatOn, cargoView } from '../core/frame'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PackageManifest, PartPackage } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance } from '../core/types'
import { buildPackage } from './buildPackage'
import { validatePart } from './validatePart'
import { SimWorld } from './world'

const J = await initJolt()

const R = 0.29 // a 200 l drum: 0.58 m across, 0.88 m tall
const H = 0.88

/** A drum: one cylinder link. `onSide` lays it along X, so it rolls along Z. */
function drumManifest(onSide: boolean): PackageManifest {
  return {
    id: onSide ? 'acme.drum-side' : 'acme.drum',
    name: 'Drum',
    geometry: { kind: 'rig', links: [{ name: 'shell', shape: { kind: 'cylinder', radius: R, height: H }, offset: [0, 0, 0], ...(onSide ? { rotation: [0, 0, Math.PI / 2] } : {}) }], joints: [] },
    cargo: { friction: 0.5 },
  }
}
const DRUM_BEHAVIOR = "definePart({ params: { mass: { type: 'number', default: 20 }, color: { type: 'color', default: '#2a5d8f' } }, step() {} })"

function load(m: PackageManifest, behavior = DRUM_BEHAVIOR): PartPackage {
  const pkg = buildPackage(m, behavior)
  registerPackage(pkg)
  return pkg
}

/** A plain box cargo part the drum's size (a rig declaring cargo, so the two differ only in shape). */
const crateManifest: PackageManifest = {
  id: 'acme.crate',
  name: 'Crate',
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [H, 2 * R, 2 * R] }, offset: [0, 0, 0] }], joints: [] },
  cargo: { friction: 0.5 },
}

interface LiveBody {
  partId: string | null
  kind: number
  shapeKey?: string
  body: Jolt.Body
}
const live = (w: SimWorld, id: string): LiveBody => (w as unknown as { boxes: LiveBody[] }).boxes.find((x) => x.partId === id)!
const pos = (w: SimWorld, id: string): [number, number, number] => {
  const p = live(w, id).body.GetPosition()
  return [p.GetX(), p.GetY(), p.GetZ()]
}
function shove(w: SimWorld, id: string, vz: number): void {
  const bi = (w as unknown as { bodyInterface: Jolt.BodyInterface }).bodyInterface
  const v = new J.Vec3(0, 0, vz)
  bi.SetLinearVelocity(live(w, id).body.GetID(), v)
  // A velocity set on an awake body leaves its sleep timer running, and after half a second at rest the body sleeps
  // within the step and loses the shove. At 60 Hz the settle above happens to end asleep, which SetLinearVelocity
  // wakes with a fresh timer; at 120 Hz it ends awake and the drum stopped dead.
  bi.ResetSleepTimer(live(w, id).body.GetID())
  J.destroy(v)
}

describe('cargo with its own body', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('is a part-bodied cargo view: its pieces, bounds and declared mass, colour and friction', () => {
    load(drumManifest(true))
    const v = cargoView(createSdkPart(load(drumManifest(true)), 'd', [0, 1, 0], 0))!
    expect(v.kind).toBe(CARGO_KIND_PART)
    // lying along X: H long, 2R tall and deep
    expect(v.halfExtents[0]).toBeCloseTo(H / 2, 4)
    expect(v.halfExtents[1]).toBeCloseTo(R, 4)
    expect(v.halfExtents[2]).toBeCloseTo(R, 4)
    expect(v.mass).toBe(20)
    expect(v.color).toBe('#2a5d8f')
    expect(v.body?.friction).toBe(0.5)
    expect(v.body?.pieces).toHaveLength(1)
    expect(v.body?.pieces[0]!.shape).toBe('cylinder')
  })

  it('rolls on its side where a box of its size slides to a stop', { timeout: 60000 }, () => {
    const drum = load(drumManifest(true))
    const crate = load(crateManifest)
    const parts: PartInstance[] = [createSdkPart(drum, 'drum', [0, R + 0.01, 0], 0), createSdkPart(crate, 'crate', [3, R + 0.01, 0], 0)]
    world = new SimWorld(J, { version: SCENE_VERSION, parts, packages: [drum, crate] }, { hz: 60 })
    for (let i = 0; i < 30; i++) world.step() // settle
    // it rests on its curve: its centre one radius up
    expect(pos(world, 'drum')[1]).toBeCloseTo(R, 2)
    expect(live(world, 'drum').kind).toBe(CARGO_KIND_PART)
    shove(world, 'drum', 2)
    shove(world, 'crate', 2)
    for (let i = 0; i < 60 * 2; i++) world.step()
    const rolled = pos(world, 'drum')[2]
    const slid = pos(world, 'crate')[2]
    // measured: the crate slides 0.35 m before friction stops it; the drum rolls 2.57 m, at the 4.2 rad/s of rolling
    expect(slid).toBeLessThan(0.8)
    expect(rolled).toBeGreaterThan(2)
    // and it is rolling, not sliding: it turns about its own axis (X)
    const w = live(world, 'drum').body.GetAngularVelocity()
    expect(Math.abs(w.GetX())).toBeGreaterThan(1)
  })

  it('stands on its end when it is upright, and stays there', { timeout: 60000 }, () => {
    const drum = load(drumManifest(false))
    world = new SimWorld(J, { version: SCENE_VERSION, parts: [createSdkPart(drum, 'drum', [0, H / 2 + 0.01, 0], 0)], packages: [drum] }, { hz: 60 })
    for (let i = 0; i < 60; i++) world.step()
    expect(pos(world, 'drum')[1]).toBeCloseTo(H / 2, 2)
  })

  it('shares one collider between bodies of the same shape', { timeout: 60000 }, () => {
    const drum = load(drumManifest(true))
    const parts = [0, 1, 2].map((i) => createSdkPart(drum, `d${i}`, [i * 1.2, R + 0.01, 0], 0))
    world = new SimWorld(J, { version: SCENE_VERSION, parts, packages: [drum] }, { hz: 60 })
    const keys = new Set(['d0', 'd1', 'd2'].map((id) => live(world!, id).shapeKey))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toMatch(/^acme\.drum-side\|/)
  })

  // Jolt frees a shape with the last body that uses it. A line whose sink removed every carton of one product then
  // built the next carton on the freed collider, and the step after it read a body record something else had
  // overwritten ("memory access out of bounds", and a world that never finished disposing).
  it('keeps the shared collider when the last body of its shape is removed', { timeout: 60000 }, () => {
    const drum = load(drumManifest(true))
    const parts = [0, 1].map((i) => createSdkPart(drum, `d${i}`, [i * 1.2, R + 0.01, 0], 0))
    world = new SimWorld(J, { version: SCENE_VERSION, parts, packages: [drum] }, { hz: 60 })
    const shape = live(world, 'd0').body.GetShape()
    // Jolt.js holds the last shape result it handed out, and so a reference to that shape, until the next one
    const other = new J.StaticCompoundShapeSettings()
    const at = new J.Vec3(0, 0, 0)
    const turn = new J.Quat(0, 0, 0, 1)
    const half = new J.Vec3(0.1, 0.1, 0.1)
    other.AddShapeShape(at, turn, new J.BoxShape(half, 0.01), 0)
    other.Create()
    for (const o of [other, at, turn, half]) J.destroy(o)
    // the two bodies, and the cache
    expect(shape.GetRefCount()).toBe(3)
    const cargo = (world as unknown as { cargo: { removeBox(index: number): void } }).cargo
    cargo.removeBox(1)
    cargo.removeBox(0)
    expect(shape.GetRefCount()).toBe(1)
  })
})

describe("validating a part's own cargo body", () => {
  it('accepts a centred drum', () => {
    expect(validatePart(drumManifest(true), DRUM_BEHAVIOR).diagnostics).toEqual([])
  })

  it('refuses a rig with joints, one with nothing to collide, and one off its origin', () => {
    const jointed = { ...drumManifest(false), geometry: { kind: 'rig' as const, links: [{ name: 'a', shape: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] }, offset: [0, 0, 0] as [number, number, number] }], joints: [{ name: 'j', link: 'a', type: 'revolute' as const, axis: [0, 1, 0] as [number, number, number], min: -1, max: 1 }] } }
    expect(validatePart(jointed, DRUM_BEHAVIOR).diagnostics.map((d) => d.message).join(' ')).toMatch(/no joints/)
    const ghost = { ...drumManifest(false), geometry: { kind: 'rig' as const, links: [{ name: 'a', shape: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] }, offset: [0, 0, 0] as [number, number, number], collision: 'none' as const }], joints: [] } }
    expect(validatePart(ghost, DRUM_BEHAVIOR).diagnostics.map((d) => d.message).join(' ')).toMatch(/no colliding link/)
    const offCentre = { ...drumManifest(false), geometry: { kind: 'rig' as const, links: [{ name: 'a', shape: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] }, offset: [0, 0.5, 0] as [number, number, number] }], joints: [] } }
    expect(validatePart(offCentre, DRUM_BEHAVIOR).diagnostics.map((d) => d.message).join(' ')).toMatch(/centred/)
  })

  it('refuses a cargo declaration on a geometry that is not a rig, and params of the wrong type', () => {
    const notRig = { ...drumManifest(false), geometry: { kind: 'cargo' as const, cargoKind: 'box' as const, size: { length: 1, width: 1, height: 1 } } }
    expect(validatePart(notRig, DRUM_BEHAVIOR).diagnostics.map((d) => d.message).join(' ')).toMatch(/rig geometry/)
    const badMass = { ...drumManifest(false), cargo: { massParam: 'color' } }
    expect(validatePart(badMass, DRUM_BEHAVIOR).diagnostics.map((d) => d.message).join(' ')).toMatch(/massParam must name a `number` param/)
  })
})

describe('what cargo is to the machines around it (capabilities, core/frame.ts cargoCapsOf)', () => {
  afterEach(() => clearPackages())

  const plasticPallet: PackageManifest = {
    id: 'acme.plastic-pallet',
    name: 'Plastic pallet',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1.2, 0.15, 0.8] }, offset: [0, 0, 0] }], joints: [] },
    cargo: { forkPockets: true, heavy: true, loadBase: true },
  }
  const crate: PackageManifest = {
    id: 'acme.crate-nest',
    name: 'Nesting crate',
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.6, 0.3, 0.4] }, offset: [0, 0, 0] }], joints: [] },
    cargo: { nestDepth: 0.02 },
  }
  const PLAIN = "definePart({ params: { mass: { type: 'number', default: 20 } }, step() {} })"

  it('a part declares them; a stored box, pallet or tote that declares none keeps its kind\'s', () => {
    const pallet = cargoView(createSdkPart(load(plasticPallet, PLAIN), 'p', [0, 1, 0], 0))!
    expect(pallet.caps).toBe(CARGO_CAP_FORK_POCKETS | CARGO_CAP_HEAVY | CARGO_CAP_LOAD_BASE)
    expect(cargoView(createSdkPart(load(crate, PLAIN), 'c', [0, 1, 0], 0))!.nestDepth).toBe(0.02)
    // a drum declares nothing: no capabilities
    expect(cargoView(createSdkPart(load(drumManifest(true)), 'd', [0, 1, 0], 0))!.caps).toBe(0)
    expect(capsOfKind(CARGO_KIND_PALLET)).toBe(CARGO_CAP_FORK_POCKETS | CARGO_CAP_HEAVY | CARGO_CAP_LOAD_BASE)
    expect(capsOfKind(CARGO_KIND_TOTE)).toBe(CARGO_CAP_SEPARATE_CONTACTS)
    expect(capsOfKind(CARGO_KIND_BOX)).toBe(0)
  })

  it('a body carries its part\'s capabilities into the sim', { timeout: 60000 }, () => {
    const pkg = load(plasticPallet, PLAIN)
    const w = new SimWorld(J, { version: SCENE_VERSION, parts: [createSdkPart(pkg, 'p', [0, 0.1, 0], 0)], packages: [pkg] }, { hz: 60 })
    try {
      const b = (w as unknown as { boxes: { partId: string | null; caps: number }[] }).boxes.find((x) => x.partId === 'p')!
      expect(b.caps).toBe(CARGO_CAP_FORK_POCKETS | CARGO_CAP_HEAVY | CARGO_CAP_LOAD_BASE)
      expect(w.frame().caps?.[0]).toBe(CARGO_CAP_FORK_POCKETS | CARGO_CAP_HEAVY | CARGO_CAP_LOAD_BASE)
    } finally {
      w.dispose()
    }
  })

  it('a nesting part sets down on another of its shape its nest depth lower, as a tote does', () => {
    const pkg = load(crate, PLAIN)
    const host = createSdkPart(pkg, 'h', [1, 0.15, 2], 0.4)
    const seat = cargoSeatOn(createSdkPart(pkg, 'm', [1.01, 0.6, 2], 0.4 + Math.PI), host)
    expect(seat).toEqual([1, 0.15 + 0.15 + 0.15 - 0.02, 2])
    // not onto another shape
    const other = load({ ...crate, id: 'acme.other' }, PLAIN)
    expect(cargoSeatOn(createSdkPart(other, 'o', [1, 0.6, 2], 0.4), host)).toBeNull()
  })
})
