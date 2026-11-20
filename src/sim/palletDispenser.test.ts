/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAuthoredCargoFrame, CARGO_KIND_PALLET } from '../core/frame'
import { fillHolds } from '../core/heldStock'
import { clearPackages, getPackage, registerPackage } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { PALLET_SIZE, SCENE_VERSION } from '../core/types'
import { DEFAULT_PALLET_STANDARD, PALLET_STANDARDS, palletCollider, palletPieces } from '../core/pallet'
import { instantiatePartScript } from '../core/parts/partScript'
import type { PartInstance, SceneJSON, SdkPart } from '../core/types'
import { authoredZoneCounts } from '../core/zoneCounts'
import { settleIdlePose } from './idlePose'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// The Pallet Dispenser (examples/parts/pallet-dispenser), driven headless in a real SimWorld: the committed
// behavior over the committed rig, set down over a plain conveying deck. What it has to get right is that it is
// commanded and interlocked (one pallet per request, set down where the stack stood, never onto a pallet still
// standing in its bay) and that it conserves cargo: the magazine holds real pallets, so a pallet loaded into it is
// the pallet that comes out, nothing a truck loads disappears, and nothing it holds is counted as leaving the line.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** a committed example part: its rig.json is the manifest (holds and all) */
function loadExample(dir: string): { manifest: PackageManifest; behavior: string } {
  const manifest = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as PackageManifest
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return { manifest, behavior }
}

/** The shipped behavior's own per-size table and tine, read from its top level: a second definePart() appended to the
 *  script is the one instantiatePartScript keeps, and it hands those constants out. */
function shippedDispenser() {
  const { behavior } = loadExample('pallet-dispenser')
  const shipped = instantiatePartScript(behavior).def!
  const probe = instantiatePartScript(`${behavior}\ndefinePart({ step() {}, constants: { SIZES, PITCH, TINE_T, TINE_W, TINE_Y } })`).def as unknown as {
    constants: { SIZES: Record<string, { length: number; width: number; tip: number; tz: number; gx: number; gz: number }>; PITCH: number; TINE_T: number; TINE_W: number; TINE_Y: number }
  }
  const k = probe.constants
  return { def: shipped, sizes: k.SIZES, pitch: k.PITCH, tineT: k.TINE_T, tineW: k.TINE_W, tineY: k.TINE_Y }
}

const DECK_Y = 1
const PH = PALLET_SIZE[1]
const HOLD = 0.25 // the dispenser's holding height: the underside of the bottom held pallet
const RED: [number, number, number] = [1, 0, 0]

interface Opts {
  params?: Record<string, unknown>
  /** author the magazine's stock the way the Inspector's Fill does (core/heldStock fillHolds): real pallets, parented */
  fill?: boolean
  /** deck speed toward +x, m/s (0 = a stopped conveyor, which leaves a dispensed pallet standing in the bay) */
  speed?: number
  /** real pallets standing in the magazine when the run starts */
  stack?: number
  /** a stand-in for the supply truck: at `at` s, this many pallets appear standing in the magazine, tinted `color` */
  load?: { at: number; n: number; color: [number, number, number] }
}

/** A dispenser standing over a long deck (its top at DECK_Y), so dispensed pallets have room to leave. */
function dispenserWorld(opts: Opts = {}): SimWorld {
  return new SimWorld(Jolt, dispenserScene(opts))
}
function dispenserScene({ params = {}, fill = false, speed = 0, stack = 0, load }: Opts = {}): SceneJSON {
  const { manifest, behavior } = loadExample('pallet-dispenser')
  const cargo = loadExample('pallet')
  const deck = buildPackage(
    {
      id: 'acme.deck',
      name: 'Deck',
      geometry: {
        kind: 'rig',
        links: [{ name: 'deck', shape: { kind: 'box', size: [60, 0.1, 1.4] }, offset: [29.4, -0.05, 0], conveys: true }],
        joints: [],
        bounds: { length: 60, width: 1.4, top: 0.1 },
      },
    },
    `definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: ${speed}, y: 0, z: 0 }) } })`,
  )
  const packages = [deck, buildPackage(manifest, behavior), buildPackage(cargo.manifest, cargo.behavior)]
  const parts: PartInstance[] = [
    { id: 'deck', type: 'part', packageId: 'acme.deck', position: [0, DECK_Y, 0], rotationY: 0, params: {} },
    { id: 'disp', type: 'part', packageId: manifest.id, position: [0, DECK_Y, 0], rotationY: 0, params: { standHeight: DECK_Y, autoFeed: false, ...params } },
    // a stack of real pallets standing in the magazine, as a truck would have set it down
    ...Array.from({ length: stack }, (_, i): PartInstance => ({
      id: `s${i}`, type: 'part', packageId: cargo.manifest.id, position: [0, DECK_Y + PH * (i + 0.5), 0], rotationY: 0, params: {},
    })),
  ]
  if (load) {
    packages.push(
      buildPackage(
        { id: 'acme.truck', name: 'Truck', geometry: { kind: 'rig', links: [{ name: 'at', shape: { kind: 'frame' }, offset: [0, 0, 0] }], joints: [], bounds: { length: 0.1, width: 0.1, top: 0.1 } } },
        // eight a tick, the host's spawn limit, bottom up
        `let i = 0; definePart({ step(ctx) { if (ctx.simTime < ${load.at}) return
          for (let k = 0; k < 8 && i < ${load.n}; k++, i++) ctx.spawn({ kind: 'pallet', color: ${JSON.stringify(load.color)}, mass: 30, offset: [0, i * ${PH} + ${PH / 2} + 0.001 * (i + 1), 0] }) } })`,
      ),
    )
    parts.push({ id: 'truck', type: 'part', packageId: 'acme.truck', position: [0, DECK_Y, 0], rotationY: 0, params: {} })
  }
  for (const pkg of packages) registerPackage(pkg)
  let scene: SceneJSON = { version: SCENE_VERSION, packages, parts }
  if (fill) scene = fillHolds(scene, 'disp') ?? scene
  const res = validateScene(scene)
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return res.scene
}

const runFor = (w: SimWorld, seconds: number): void => {
  const until = w.frame().simTime + seconds
  while (w.frame().simTime < until) w.step()
}

interface Pallet { id: number; x: number; y: number; z: number; tiltDeg: number; color: [number, number, number] }
function pallets(w: SimWorld): Pallet[] {
  const f = w.frame()
  const out: Pallet[] = []
  for (let i = 0; i < f.count; i++) {
    if (f.kinds[i] !== CARGO_KIND_PALLET) continue
    const qx = f.quats[i * 4]!, qz = f.quats[i * 4 + 2]!
    const upY = 1 - 2 * (qx * qx + qz * qz)
    out.push({
      id: f.ids[i]!, x: f.positions[i * 3]!, y: f.positions[i * 3 + 1]!, z: f.positions[i * 3 + 2]!,
      tiltDeg: (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI,
      color: [f.colors[i * 3]!, f.colors[i * 3 + 1]!, f.colors[i * 3 + 2]!],
    })
  }
  return out
}
/** cargo the world's holders table says is held (the magazine is the only thing here that holds any) */
const heldIds = (w: SimWorld): Set<number> => new Set((w as unknown as { holders: Map<number, unknown> }).holders.keys())
/** standing in the bay: under the magazine, on the conveyor */
const inBay = (w: SimWorld): Pallet[] => pallets(w).filter((p) => Math.abs(p.x) < 0.6 && Math.abs(p.z) < 0.5 && p.y < DECK_Y + PH)
/** the magazine, bottom first */
const magazine = (w: SimWorld): Pallet[] => {
  const held = heldIds(w)
  return pallets(w).filter((p) => held.has(p.id)).sort((a, b) => a.y - b.y)
}

describe('Pallet Dispenser (SDK part, headless)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('its stock is authored: Fill places real pallets at the holding positions, and the run grips those same parts where they stand', () => {
    const scene = dispenserScene({ fill: true })
    const authored = scene.parts.filter((p) => p.parent === 'disp')
    expect(authored).toHaveLength(10) // the capacity: what the stopped scene shows
    world = new SimWorld(Jolt, scene)
    const atStart = pallets(world)
    runFor(world, 10)
    const mag = magazine(world)
    expect(pallets(world)).toHaveLength(10)
    expect(mag).toHaveLength(10) // every one of them gripped
    // ...the authored parts themselves, not stand-ins, and not a mm lower than where they were placed
    expect(world.frame().partIds.filter((id) => id !== null).sort()).toEqual(authored.map((p) => p.id).sort())
    for (const p of mag) expect(Math.abs(p.y - atStart.find((q) => q.id === p.id)!.y)).toBeLessThan(0.003)
    expect(inBay(world)).toHaveLength(0) // and with Auto dispense off it does nothing on its own
    expect(mag[0]!.y - DECK_Y).toBeCloseTo(HOLD + PH / 2, 2)
    for (let i = 1; i < mag.length; i++) expect(mag[i]!.y - mag[i - 1]!.y).toBeCloseTo(PH, 2) // a stack, pallet on pallet
    for (const p of mag) expect(Math.hypot(p.x, p.z)).toBeLessThan(0.01)
  })

  // The stopped editor draws the dispenser in the pose its own step() settles to (sim/idlePose), and that pose depends
  // on what it holds. Fed nothing, it would read every zone empty and park (carriage down on the conveyor, forks out),
  // and a filled magazine would draw its pallets floating over nothing. Fed the authored cargo in its zones, it holds
  // them up.
  it('previews, stopped, holding the pallets authored in it, and parked when it has none', () => {
    const scene = dispenserScene({ fill: true })
    const disp = scene.parts.find((p) => p.id === 'disp') as SdkPart
    const pkg = getPackage(disp.packageId)!
    const pose = (parts: PartInstance[]) => settleIdlePose(pkg.behavior, disp.params, 0, authoredZoneCounts(disp, pkg, buildAuthoredCargoFrame(parts)))!.joints
    const filled = pose(scene.parts)
    expect(authoredZoneCounts(disp, pkg, buildAuthoredCargoFrame(scene.parts))!.held).toBe(10)
    expect(filled.lift).toBeCloseTo(0, 3) // at the holding height (the rig's rest), under the bottom pallet
    expect(filled.forkW).toBeCloseTo(0, 3) // forks in, in its pockets
    const empty = pose(scene.parts.filter((p) => p.parent !== 'disp'))
    expect(empty.lift).toBeCloseTo(-HOLD, 3) // parked on the conveyor for a truck
    expect(empty.forkW).toBeGreaterThan(0.2) // forks out
  })

  it('fills to its capacity, and holds what was placed even when that is fewer', () => {
    expect(dispenserScene({ fill: true, params: { capacity: 4 } }).parts.filter((p) => p.parent === 'disp')).toHaveLength(4)
    const three = dispenserScene({ fill: true, params: { capacity: 3 } })
    world = new SimWorld(Jolt, { ...three, parts: three.parts.map((p) => (p.id === 'disp' ? { ...p, params: { ...p.params, capacity: 10 } } : p)) } as SceneJSON)
    runFor(world, 3)
    expect(magazine(world)).toHaveLength(3)
    expect(magazine(world)[0]!.y - DECK_Y).toBeCloseTo(HOLD + PH / 2, 2)
  })

  it('still honours a saved scene\'s retired Pallets at start count, when nothing is placed', () => {
    world = dispenserWorld({ params: { stock: 4 } })
    runFor(world, 3)
    expect(pallets(world)).toHaveLength(4)
    expect(magazine(world)).toHaveLength(4)
  })

  it('sets one pallet down per Use: the bottom one of the magazine, where the stack stood', () => {
    world = dispenserWorld({ fill: true })
    runFor(world, 4)
    const bottomId = magazine(world)[0]!.id
    world.usePart('disp')
    runFor(world, 1)
    expect(inBay(world)).toHaveLength(0) // still lowering the stack: nothing is let go until it stands on the conveyor
    runFor(world, 8)
    const bay = inBay(world)
    expect(bay.map((p) => p.id)).toEqual([bottomId]) // the same pallet, not a new one standing in for it
    expect(pallets(world)).toHaveLength(10) // nothing made, nothing deleted
    expect(magazine(world)).toHaveLength(9)
    // on the deck, under the magazine's centre, standing: not dropped from height, not pressed into the deck
    expect(Math.hypot(bay[0]!.x, bay[0]!.z)).toBeLessThan(0.02)
    expect(bay[0]!.y - DECK_Y).toBeGreaterThan(PH / 2 - 0.004)
    expect(bay[0]!.y - DECK_Y).toBeLessThan(PH / 2 + 0.004)
  })

  it('never sets a stack down on a pallet still standing in its bay', () => {
    world = dispenserWorld({ fill: true }) // a stopped conveyor: the first pallet never leaves
    runFor(world, 4)
    world.usePart('disp')
    runFor(world, 1)
    world.usePart('disp') // a second request, arriving mid-cycle
    runFor(world, 20)
    expect(inBay(world)).toHaveLength(1) // held: the bay is occupied
    expect(magazine(world)).toHaveLength(9)
  })

  it('holds the carriage, forks and stack where they are while its enable is down, then finishes the dispense', () => {
    world = dispenserWorld({ fill: true, params: { dispenseTag: 'Disp', enableTag: 'En', busyTag: 'Busy' } })
    const w = world
    w.setBehaviorDrivenTags(['Disp', 'En'])
    const busy = (): unknown => w.frame().tags?.['disp']?.['Busy']
    const joints = (): Record<string, number> => ({ ...(w.frame().joints?.['disp'] ?? {}) })
    w.setBehaviorInputTags({ Disp: false, En: true })
    runFor(w, 4)
    // a request while the enable is down is refused, not kept for later
    w.setBehaviorInputTags({ Disp: false, En: false })
    w.step()
    w.setBehaviorInputTags({ Disp: true, En: false })
    runFor(w, 1)
    expect(busy()).toBe(false)
    w.setBehaviorInputTags({ Disp: false, En: true })
    runFor(w, 3)
    expect(inBay(w)).toHaveLength(0)
    // a fresh edge starts one; drop the enable while the stack is on its way down
    w.setBehaviorInputTags({ Disp: true, En: true })
    runFor(w, 0.8)
    const lowering = joints()
    expect(lowering['lift']).toBeLessThan(-0.05)
    w.setBehaviorInputTags({ Disp: true, En: false })
    w.step()
    const held = joints()
    const bottomY = magazine(w)[0]!.y
    runFor(w, 3)
    expect(joints()).toEqual(held)
    expect(magazine(w)).toHaveLength(10) // nothing let go
    expect(Math.abs(magazine(w)[0]!.y - bottomY)).toBeLessThan(0.002) // the stack held where it was
    expect(inBay(w)).toHaveLength(0)
    expect(busy()).toBe(true)
    // enable back: the cycle carries on from there and sets the bottom pallet down
    w.setBehaviorInputTags({ Disp: true, En: true })
    runFor(w, 10)
    expect(inBay(w)).toHaveLength(1)
    expect(magazine(w)).toHaveLength(9)
    expect(busy()).toBe(false)
  })

  it('serves the waiting request once the bay is carried clear', () => {
    world = dispenserWorld({ fill: true, speed: 0.6 })
    runFor(world, 4)
    world.usePart('disp')
    runFor(world, 1)
    world.usePart('disp')
    runFor(world, 25)
    expect(magazine(world)).toHaveLength(8)
    expect(pallets(world)).toHaveLength(10)
  })

  it('keeps the bay stocked by itself with Auto dispense on, and stops when the magazine is empty', () => {
    world = dispenserWorld({ params: { autoFeed: true, capacity: 3, autoRefill: false }, fill: true, speed: 0.6 })
    runFor(world, 60)
    expect(pallets(world)).toHaveLength(3) // three held, three dispensed, and then nothing
    expect(magazine(world)).toHaveLength(0)
  })

  // What only a held stack can do: the stack never stands on its own, so a conveyor that never stops (no program
  // holding it while the machine is busy) takes each pallet away as it is let go, and nothing else moves.
  it('empties a full magazine onto a conveyor that never stops, every pallet standing and none pressed into the deck', () => {
    world = dispenserWorld({ params: { autoFeed: true }, fill: true, speed: 0.6 })
    const ids = new Set(pallets(world).map((p) => p.id))
    expect(ids.size).toBe(10)
    let lowest = Infinity
    for (let t = 0; t < 90; t += 0.5) {
      runFor(world, 0.5)
      // a pallet out on the conveyor, clear of the machine: where it rides says how it was set down
      for (const p of pallets(world)) if (p.x > 1.5) lowest = Math.min(lowest, p.y - DECK_Y)
    }
    const all = pallets(world)
    expect(all).toHaveLength(10)
    expect(all.every((p) => ids.has(p.id))).toBe(true)
    expect(magazine(world)).toHaveLength(0)
    expect(all.filter((p) => p.x > 0.8)).toHaveLength(10) // every one carried out
    expect(all.filter((p) => p.tiltDeg > 3)).toEqual([]) // none tipped
    expect(lowest).toBeGreaterThan(PH / 2 - 0.004) // none sunk into the deck
    expect(world.measurements().completedTotal).toBe(0) // and none of it counted as leaving the line
  })

  it('grips a stack set down in its empty magazine, and dispenses those same pallets, tint and all', () => {
    world = dispenserWorld({ params: { stock: 0 }, load: { at: 1, n: 3, color: RED } })
    runFor(world, 2)
    const loaded = pallets(world)
    expect(loaded).toHaveLength(3)
    expect(magazine(world)).toHaveLength(0) // standing: not taken in until it has been left a moment
    runFor(world, 6) // settle, forks in, lifted to the holding position
    expect(magazine(world).map((p) => p.id).sort()).toEqual(loaded.map((p) => p.id).sort())
    expect(magazine(world)[0]!.y - DECK_Y).toBeCloseTo(HOLD + PH / 2, 1)
    world.usePart('disp')
    runFor(world, 10)
    const bay = inBay(world)
    expect(bay).toHaveLength(1)
    expect(loaded.some((p) => p.id === bay[0]!.id)).toBe(true) // one of the truck's pallets
    expect(bay[0]!.color).toEqual(RED) // ...still wearing its own tint, not the dispenser's white
    expect(pallets(world)).toHaveLength(3)
    expect(world.measurements().completedTotal).toBe(0)
  })

  it('does not take in a single pallet set down in it: that is a dispensed one waiting in the bay, not a load', () => {
    world = dispenserWorld({ params: { stock: 0 }, load: { at: 1, n: 1, color: RED } })
    runFor(world, 10)
    expect(pallets(world)).toHaveLength(1)
    expect(magazine(world)).toHaveLength(0)
  })

  it('keeps every pallet of a stack taller than the magazine: the extra ones stay real, standing on the stack', () => {
    world = dispenserWorld({ params: { stock: 0, capacity: 10 }, load: { at: 1, n: 12, color: RED } })
    runFor(world, 10)
    expect(pallets(world)).toHaveLength(12) // none deleted
    expect(magazine(world)).toHaveLength(10) // the positions it has
  })

  it('takes a stack placed standing on the conveyor in as a load, not as held stock, and makes none of its own', () => {
    world = dispenserWorld({ params: { stock: 10 }, stack: 3 })
    const placed = pallets(world).map((p) => p.id).sort()
    runFor(world, 1)
    expect(magazine(world)).toHaveLength(0) // parked under it, not gripping it where it stands
    runFor(world, 5)
    expect(pallets(world)).toHaveLength(3) // the retired count made none: the placed ones are the stock
    expect(magazine(world).map((p) => p.id).sort()).toEqual(placed)
  })

  // A held body left kinematic under a removed rig would hang in the air for the rest of the run.
  it('lets go of its load when it is deleted mid-run, and the pallets fall to the deck', () => {
    const scene = dispenserScene({ params: { stock: 10 }, stack: 3 })
    world = new SimWorld(Jolt, scene)
    runFor(world, 6)
    expect(magazine(world)).toHaveLength(3)
    world.updateScene({ ...scene, parts: scene.parts.filter((p) => p.id !== 'disp') })
    expect(heldIds(world).size).toBe(0)
    runFor(world, 3)
    const all = pallets(world)
    expect(all).toHaveLength(3)
    expect(Math.min(...all.map((p) => p.y))).toBeLessThan(DECK_Y + PH) // the bottom one rests on the deck
  })

  for (const std of PALLET_STANDARDS) {
    it(`${std.label}: Fill places pallets of its size, and a Use sets the bottom one down standing`, () => {
      world = dispenserWorld({ params: { palletSize: std.value }, fill: true })
      runFor(world, 4)
      const f = world.frame()
      const sizes = new Set<string>()
      for (let i = 0; i < f.count; i++) {
        if (f.kinds[i] === CARGO_KIND_PALLET) sizes.add(`${(f.halfExtents[i * 3]! * 2).toFixed(3)}x${(f.halfExtents[i * 3 + 2]! * 2).toFixed(3)}`)
      }
      expect([...sizes]).toEqual([`${std.length.toFixed(3)}x${std.width.toFixed(3)}`])
      expect(magazine(world)).toHaveLength(10)
      const bottomId = magazine(world)[0]!.id
      world.usePart('disp')
      runFor(world, 9)
      const bay = inBay(world)
      expect(bay.map((q) => q.id)).toEqual([bottomId])
      expect(pallets(world)).toHaveLength(10)
      expect(magazine(world)).toHaveLength(9)
      expect(Math.hypot(bay[0]!.x, bay[0]!.z)).toBeLessThan(0.02)
      expect(bay[0]!.tiltDeg).toBeLessThan(1)
      expect(bay[0]!.y - DECK_Y).toBeGreaterThan(PH / 2 - 0.004)
      expect(bay[0]!.y - DECK_Y).toBeLessThan(PH / 2 + 0.004)
    })
  }

  it('makes new pallets of its size when it reloads itself', () => {
    world = dispenserWorld({ params: { stock: 0, autoRefill: true, palletSize: '1200x800' } })
    runFor(world, 20)
    const f = world.frame()
    expect(f.count).toBeGreaterThan(0)
    for (let i = 0; i < f.count; i++) {
      expect([f.halfExtents[i * 3]! * 2, f.halfExtents[i * 3 + 2]! * 2].map((v) => +v.toFixed(4))).toEqual([1.2, 0.8])
    }
  })

  it('keeps its copies of the pallet in step with core/pallet.ts', () => {
    // part.js can't import core, so it copies the pallet's footprints and pieces; these are the numbers it derives
    const { sizes, pitch, tineY, def } = shippedDispenser()
    const palletSize = def.params!.palletSize as { default: string; options: { value: string; label: string }[] }
    expect(palletSize.default).toBe(DEFAULT_PALLET_STANDARD)
    expect(palletSize.options).toEqual(PALLET_STANDARDS.map((s) => ({ value: s.value, label: s.label })))
    expect(pitch).toBe(PALLET_SIZE[1])
    // the tines centred in the pocket's height: over the runners, under the deck boards
    const c0 = palletCollider(PALLET_SIZE[0], PALLET_SIZE[2])
    expect(tineY).toBeCloseTo((c0.runners[0]!.thickness + (PALLET_SIZE[1] - c0.deckThickness)) / 2, 8)
    expect(Object.keys(sizes)).toEqual(PALLET_STANDARDS.map((s) => s.value))
    for (const std of PALLET_STANDARDS) {
      const t = sizes[std.value]!
      expect([t.length, t.width], std.label).toEqual([std.length, std.width])
      // the tines' |z|: the middle of the fork channel between the centre block and the outer one
      const c = palletCollider(std.length, std.width)
      const zs = [...new Set(c.blocks.map((b) => b.z))].sort((a, b) => a - b)
      const hz = c.blocks[0]!.hz
      expect(t.tz, std.label).toBeCloseTo((zs[1]! + hz + zs[2]! - hz) / 2, 8)
    }
  })

  it('sets its tines in the fork channels of every size it offers, clear of every piece of the pallet', () => {
    // the table and the tine the shipped behavior draws with, held to the pallet as it is now
    const { sizes, tineT, tineW, tineY } = shippedDispenser()
    expect(Object.keys(sizes).sort()).toEqual(PALLET_STANDARDS.map((s) => s.value).sort())
    for (const std of PALLET_STANDARDS) {
      const t = sizes[std.value]!
      const pieces = palletPieces(std.length, std.width)
      // a tine, in the pallet's frame (centre origin; the dispenser's datum is the pallet's underside)
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const lo = [sx > 0 ? t.tip : -std.length / 2 - 0.1, tineY - tineT / 2 - PH / 2, sz * t.tz - tineW / 2]
          const hi = [sx > 0 ? std.length / 2 + 0.1 : -t.tip, tineY + tineT / 2 - PH / 2, sz * t.tz + tineW / 2]
          for (const piece of pieces) {
            const hit = [0, 1, 2].every((k) => lo[k]! < piece.center[k]! + piece.half[k]! - 1e-9 && piece.center[k]! - piece.half[k]! < hi[k]! - 1e-9)
            expect(hit, `${std.label}: tine ${sx},${sz} through a ${piece.kind}`).toBe(false)
          }
        }
      }
      // and the guides stand outside the pallet
      expect(t.gx).toBeGreaterThan(std.length / 2)
      expect(t.gz).toBeGreaterThan(std.width / 2)
    }
  })

  it('reloads an empty magazine by itself when told to', () => {
    world = dispenserWorld({ params: { autoFeed: true, capacity: 1, autoRefill: true }, fill: true, speed: 0.6 })
    runFor(world, 45)
    expect(pallets(world).length).toBeGreaterThanOrEqual(2)
  })
})
