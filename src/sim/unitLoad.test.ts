/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { groupRoot } from '../core/scene/hierarchy'
import { validateScene } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// Product state in a real SimWorld: ctx.join / mark / marked and a beam's marks (and the host's own split), driven by small test parts
// through tags. What has to hold is what makes a unit load a unit load: its pieces stay drawn and counted where they
// stand, the load is one body that moves and is lifted as one, and taking it apart gives every piece its own body back
// where it stands. The stretch wrapper (stretchWrapper.test.ts) is the machine; this is the host underneath it.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadExample(dir: string): { manifest: PackageManifest; behavior: string } {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as {
    id: string
    name: string
    category?: string
    geometry: PackageManifest['geometry']
    materials?: PackageManifest['materials']
  }
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return { manifest: { id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry, materials: rig.materials }, behavior }
}

const DECK_Y = 1
const PALLET_H = 0.135
const CASE_H = 0.4

/** A conveying deck along x at DECK_Y, driven at the `deck` tag's speed (m/s). */
const deck = buildPackage(
  {
    id: 'acme.deck',
    name: 'Deck',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [12, 0.1, 1.4] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 12, width: 1.4, top: 0.1 } },
  },
  "definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: ctx.readNumber('deck'), y: 0, z: 0 }) } })",
)

/**
 * A station over the load: a zone round it and a beam across it at case height. Each change of the `op` tag runs one
 * product-state call on the zone (1 join, 3 mark wrapped); it reports ctx.marked and what the beam's hit
 * carries as tags.
 */
const station = buildPackage(
  {
    id: 'acme.station',
    name: 'Station',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'z', shape: { kind: 'box', size: [1.6, 1.6, 1.4] }, offset: [0, 0.8, 0], hidden: true, collision: 'none', zone: { size: [1.6, 1.6, 1.4] } },
        { name: 'eye', shape: { kind: 'frame' }, offset: [0, 0.35, 1.2], beam: { range: 3, axis: [0, 0, -1] } },
      ],
      joints: [],
      bounds: { length: 1.6, width: 1.4, top: 1.6 },
    },
  },
  `let last = 0
definePart({ step(ctx) {
  const op = ctx.readNumber('op')
  if (op !== last) {
    if (op === 1) ctx.join('z')
    if (op === 3) ctx.mark('z', 'wrapped', true)
    if (op === 4) ctx.mark('z', 'checked', 'yes') // the wrong kind for a declared boolean attribute
    if (op === 5) ctx.mark('z', 'checked', true)
    last = op
  }
  ctx.writeNumber('marked', ctx.marked('z', 'wrapped'))
  const hit = ctx.sense('eye')
  ctx.writeTag('eyeWrapped', !!(hit.hit && hit.marks && hit.marks.wrapped))
} })`,
)

/** A plate on a lift over the load's top course, gripping only what is inside a small zone round one top case. */
const lift = buildPackage(
  {
    id: 'acme.lift',
    name: 'Lift',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'car', shape: { kind: 'frame' }, offset: [0, 0, 0] },
        { name: 'hand', parent: 'car', shape: { kind: 'frame' }, offset: [0, 0, 0], grip: { zone: { size: [0.3, 0.3, 0.3] } } },
      ],
      joints: [{ name: 'up', link: 'car', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 2 }],
      bounds: { length: 0.3, width: 0.3, top: 0.3 },
    },
  },
  "definePart({ joints: ['up'], grippers: ['hand'], step(ctx) { ctx.joints.up = ctx.readNumber('lift'); ctx.grips.hand = ctx.readTag('grip') } })",
)

/** A cargo product type with two attributes: a case carrying an SKU and whether it has been checked. */
const productCase = buildPackage(
  { id: 'acme.case', name: 'Case', geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } } },
  `definePart({ params: {
    sku: { type: 'string', default: 'A-100', attribute: true },
    checked: { type: 'boolean', default: false, attribute: true },
  }, step() {} })`,
)

/** a pallet at the origin with two courses of four 0.6 x 0.4 x 0.4 cases, touching, on it */
function load(): PartInstance[] {
  const parts: PartInstance[] = [{ id: 'pal', type: 'part', packageId: 'oip.pallet', position: [0, DECK_Y + PALLET_H / 2, 0], rotationY: 0, params: {} }]
  let n = 0
  for (let course = 0; course < 2; course++) {
    for (const x of [-0.3, 0.3]) {
      for (const z of [-0.2, 0.2]) {
        parts.push({ id: `c${n++}`, type: 'part', packageId: 'oip.box', position: [x, DECK_Y + PALLET_H + CASE_H * (course + 0.5), z], rotationY: 0, params: {} })
      }
    }
  }
  return parts
}

function world(extra: PartInstance[] = [], withLoad = true): SimWorld {
  const pallet = loadExample('pallet')
  const box = loadExample('box')
  const eye = loadExample('diffuse-sensor')
  const unitLoad = loadExample('unit-load')
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [deck, station, lift, productCase, buildPackage(pallet.manifest, pallet.behavior), buildPackage(box.manifest, box.behavior), buildPackage(eye.manifest, eye.behavior), buildPackage(unitLoad.manifest, unitLoad.behavior)],
    parts: [
      { id: 'deck', type: 'part', packageId: 'acme.deck', position: [0, DECK_Y, 0], rotationY: 0, params: {} },
      { id: 'st', type: 'part', packageId: 'acme.station', position: [0, DECK_Y, 0], rotationY: 0, params: {} },
      ...extra,
      ...(withLoad ? load() : []),
    ],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

type Inner = { units: Set<{ members: unknown[] }>; boxes: { partId: string | null; unit: unknown }[] }
const units = (w: SimWorld): number => (w as unknown as Inner).units.size
const tag = (w: SimWorld, part: string, name: string): unknown => w.frame().tags?.[part]?.[name]
/** every cargo piece's world position, by part id */
function poses(w: SimWorld): Map<string, [number, number, number]> {
  const f = w.frame()
  const out = new Map<string, [number, number, number]>()
  for (let i = 0; i < f.count; i++) out.set(f.partIds[i]!, [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!])
  return out
}
function steps(w: SimWorld, n: number, tags: Record<string, number | boolean> = {}): void {
  w.setBehaviorInputTags(tags)
  for (let i = 0; i < n; i++) w.step()
}

/** take every unit load apart, the way the host does when a hand lifts a piece out of one */
function splitAll(w: SimWorld): void {
  const inner = w as unknown as { units: Set<unknown>; splitUnit(u: unknown): void }
  for (const u of [...inner.units]) inner.splitUnit(u)
}

describe('unit loads (ctx.join, and the host taking one apart)', () => {
  it('joins a load into one body without moving a piece, and the pieces are still drawn and counted where they stand', () => {
    const w = world()
    steps(w, 60, { op: 0, deck: 0 }) // settle
    const before = poses(w)
    const bodiesBefore = w.bodyStats().bodies
    steps(w, 2, { op: 1, deck: 0 })
    expect(units(w)).toBe(1)
    expect(w.bodyStats().bodies).toBe(bodiesBefore - 8) // nine bodies became one
    const after = poses(w)
    expect(after.size).toBe(9) // every piece still has its row
    for (const [id, p] of before) {
      const q = after.get(id)!
      // the pieces' rows are composed from the unit's pose: they must not jump (a centre-of-mass offset would move
      // every piece by the load's half-height)
      expect(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])).toBeLessThan(0.005)
    }
    w.dispose()
  })

  it('carries a unit load down a running deck as one piece', () => {
    const w = world()
    steps(w, 60, { op: 0, deck: 0 })
    steps(w, 2, { op: 1, deck: 0 })
    const start = poses(w)
    steps(w, 120, { op: 1, deck: 0.4 })
    const end = poses(w)
    const dx = end.get('pal')![0] - start.get('pal')![0]
    expect(dx).toBeGreaterThan(0.3) // it moved...
    for (const [id, p] of start) {
      const q = end.get(id)!
      expect(Math.abs(q[0] - p[0] - dx)).toBeLessThan(0.002) // ...every piece exactly as far as the pallet
      expect(Math.abs(q[1] - p[1])).toBeLessThan(0.002)
      expect(Math.abs(q[2] - p[2])).toBeLessThan(0.002)
    }
    w.dispose()
  })

  it('splits back into its pieces, each with its own body where it stands, keeping the marks', () => {
    const w = world()
    steps(w, 60, { op: 0, deck: 0 })
    const bodiesLoose = w.bodyStats().bodies
    steps(w, 2, { op: 1, deck: 0 })
    steps(w, 2, { op: 3, deck: 0 }) // mark it while joined
    const joined = poses(w)
    splitAll(w)
    steps(w, 2, { op: 3, deck: 0 })
    expect(units(w)).toBe(0)
    expect(w.bodyStats().bodies).toBe(bodiesLoose)
    const split = poses(w)
    for (const [id, p] of joined) {
      const q = split.get(id)!
      expect(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])).toBeLessThan(0.005)
    }
    steps(w, 2, { op: 3, deck: 0 })
    expect(tag(w, 'st', 'marked')).toBe(9) // the unit's mark stayed on every piece
    w.dispose()
  })

  it('lifts the whole unit when a gripper closes on one case of it, and only that case when it is loose', () => {
    // the plate starts at the top course's centre height over one case (0.3, _, 0.2): its zone holds that case only
    const topCase: [number, number, number] = [0.3, DECK_Y + PALLET_H + CASE_H * 1.5, 0.2]
    const liftPart: PartInstance = { id: 'lift', type: 'part', packageId: 'acme.lift', position: topCase, rotationY: 0, params: {} }
    for (const joined of [true, false]) {
      const w = world([liftPart])
      steps(w, 60, { op: 0, deck: 0, grip: false, lift: 0 })
      if (joined) steps(w, 2, { op: 1, deck: 0, grip: false, lift: 0 })
      const before = poses(w)
      steps(w, 2, { op: joined ? 1 : 0, deck: 0, grip: true, lift: 0 })
      steps(w, 60, { op: joined ? 1 : 0, deck: 0, grip: true, lift: 0.5 })
      const after = poses(w)
      const rose = [...before].filter(([id, p]) => after.get(id)![1] - p[1] > 0.4).map(([id]) => id)
      if (joined) expect(rose.sort()).toEqual([...before.keys()].sort()) // pallet and every case, together
      else expect(rose).toEqual(['c7']) // the one case under the plate
      w.dispose()
    }
  })
})

describe('marks (ctx.mark / marked, a beam hit)', () => {
  it('counts marked cargo in a zone and hands a beam the marks of what it hits', () => {
    const w = world()
    steps(w, 30, { op: 0, deck: 0 })
    expect(tag(w, 'st', 'marked')).toBe(0)
    expect(tag(w, 'st', 'eyeWrapped')).toBe(false)
    steps(w, 3, { op: 3, deck: 0 })
    expect(tag(w, 'st', 'marked')).toBe(9) // loose, every piece in the zone got it
    expect(tag(w, 'st', 'eyeWrapped')).toBe(true)
    w.dispose()
  })
})

describe('authored unit loads (oip.unit-load: its children are the load)', () => {
  const ul = (wrapped: boolean): PartInstance => ({ id: 'ul', type: 'part', packageId: 'oip.unit-load', position: [0, DECK_Y, 0], rotationY: 0, params: { wrapped, loadId: 'L-42' } })
  /** the load, filed under the unit load, and one more case standing on top of it that is not filed under it */
  function authored(wrapped: boolean): PartInstance[] {
    const pieces = load().map((p) => ({ ...p, parent: 'ul' }))
    const stray: PartInstance = { id: 'stray', type: 'part', packageId: 'oip.box', position: [0, DECK_Y + PALLET_H + CASE_H * 2.5, 0], rotationY: 0, params: {} }
    return [ul(wrapped), ...pieces, stray]
  }
  const worldOf = (parts: PartInstance[]): SimWorld => {
    const pallet = loadExample('pallet')
    const box = loadExample('box')
    const u = loadExample('unit-load')
    const res = validateScene({ version: SCENE_VERSION, packages: [deck, buildPackage(pallet.manifest, pallet.behavior), buildPackage(box.manifest, box.behavior), buildPackage(u.manifest, u.behavior)], parts: [{ id: 'deck', type: 'part', packageId: 'acme.deck', position: [0, DECK_Y, 0], rotationY: 0, params: {} }, ...parts] })
    if (!res.ok) throw new Error(res.errors.join('; '))
    return new SimWorld(Jolt, res.scene)
  }

  it('joins exactly its children, never a case that merely stands on the load', () => {
    const w = worldOf(authored(true))
    steps(w, 2, { deck: 0 })
    const inner = w as unknown as { units: Set<{ members: { partId: string | null }[] }> }
    expect(inner.units.size).toBe(1)
    const members = [...inner.units][0]!.members.map((m) => m.partId).sort()
    expect(members).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'pal'])
    // the film is fitted to the members too: it stops at the second course, under the stray case on top
    const f = w.frame()
    const film = f.dressings!.find((d) => d.id === 'film')!
    expect(film.max[1]).toBeCloseTo(PALLET_H / 2 + 2 * CASE_H + 0.006, 3)
    expect(f.marks?.['ul']).toEqual({ wrapped: true, loadId: 'L-42' })
    w.dispose()
  })

  it('starts an unwrapped unit load loose, without film, its pieces carrying its attributes', () => {
    const w = worldOf(authored(false))
    steps(w, 2, { deck: 0 })
    expect((w as unknown as { units: Set<unknown> }).units.size).toBe(0)
    const f = w.frame()
    expect(f.dressings ?? []).toEqual([])
    expect(f.marks?.['c3']).toEqual({ wrapped: false, loadId: 'L-42' })
    expect(f.marks?.['stray']).toBeUndefined()
    w.dispose()
  })

  it('selects as one: a click on any of its pieces resolves to the unit load', () => {
    const parts = authored(true)
    expect(groupRoot(parts, 'c5')).toBe('ul')
    expect(groupRoot(parts, 'pal')).toBe('ul')
    expect(groupRoot(parts, 'stray')).toBe('stray')
  })
})

describe('product attributes (params flagged `attribute`)', () => {
  it("start a run as the authored product's marks, take a machine's mark of their kind, and refuse another kind", () => {
    const one: PartInstance = { id: 'case', type: 'part', packageId: 'acme.case', position: [0, DECK_Y + 0.2, 0], rotationY: 0, params: { sku: 'B-7' } }
    const w = world([one], false)
    steps(w, 5, { op: 0, deck: 0 })
    // the authored SKU and the default for checked, carried from the first step and read out per part
    expect(w.frame().marks?.['case']).toEqual({ sku: 'B-7', checked: false })
    expect(tag(w, 'st', 'marked')).toBe(0)
    steps(w, 3, { op: 4, deck: 0 }) // 'yes' for a boolean: refused
    expect(w.frame().marks?.['case']?.checked).toBe(false)
    steps(w, 3, { op: 5, deck: 0 })
    expect(w.frame().marks?.['case']?.checked).toBe(true)
    w.dispose()
  })
})

describe('a real sensor reading a mark (oip.diffuse-sensor, "Only marked targets")', () => {
  it('reads clear on an unmarked load in its beam, and blocked once the load is marked', () => {
    // across the load at the lower course, beam (local +Z) turned to point -z; its lens is 0.1 m up the housing
    const sensor: PartInstance = {
      id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [0, DECK_Y + PALLET_H + 0.1, 1.2], rotationY: Math.PI,
      params: { maxRange: 2, mark: 'wrapped', enableComms: true, tag: 'Seen' },
    }
    const w = world([sensor])
    steps(w, 30, { op: 0, deck: 0 })
    expect(tag(w, 'eye', 'Seen')).toBe(false) // the load is in the beam, but nothing marked it
    steps(w, 3, { op: 3, deck: 0 })
    expect(tag(w, 'eye', 'Seen')).toBe(true)
    w.dispose()
  })
})

describe('a unit load taken apart by what removes or takes hold of a piece', () => {
  it('splits before a piece is removed, so the rest keep standing', () => {
    const w = world()
    steps(w, 60, { op: 0, deck: 0 })
    steps(w, 2, { op: 1, deck: 0 })
    const inner = w as unknown as { removeBox(i: number): void; boxes: { partId: string | null }[] }
    inner.removeBox(inner.boxes.findIndex((b) => b.partId === 'c7'))
    expect(units(w)).toBe(0)
    const before = poses(w)
    steps(w, 60, { op: 1, deck: 0 }) // (op unchanged: no new join)
    const after = poses(w)
    expect(after.size).toBe(8)
    for (const [id, p] of before) expect(Math.abs(after.get(id)![1] - p[1])).toBeLessThan(0.01)
    w.dispose()
  })

  it('splits when a hand picks up one piece of it', () => {
    const w = world()
    steps(w, 60, { op: 0, deck: 0 })
    steps(w, 2, { op: 1, deck: 0 })
    w.holdBody('c7', true)
    expect(units(w)).toBe(0)
    w.holdBody('c7', false)
    w.dispose()
  })
})
