/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { validateScene } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// A load cell (a rig link's `loadCell`, read by ctx.weight) and a mark on the body a beam hit (ctx.markHit), in a
// real SimWorld. What has to hold for a load cell is what makes it a scale and not a lookup: it reads the physics
// body's mass, the sum of a stack, nothing beside the platform, a ramp while a case comes on, the same when the case
// is asleep, and more while the platform accelerates the load. For markHit: only the body the beam hit is marked.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const DECK_Y = 1
const BOX_H = 0.4

function loadExample(dir: string): { manifest: PackageManifest; behavior: string } {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as {
    id: string
    name: string
    category?: string
    geometry: PackageManifest['geometry']
  }
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return { manifest: { id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry }, behavior }
}
const box = loadExample('box')

/** a 1.2 m weigh belt (x -0.6..0.6), top at its origin, run at the `run` tag's speed; publishes `kg` */
const scale = buildPackage(
  {
    id: 'acme.scale',
    name: 'Scale',
    geometry: {
      kind: 'rig',
      links: [{ name: 'deck', shape: { kind: 'box', size: [1.2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true, loadCell: true }],
      joints: [],
      bounds: { length: 1.2, width: 1, top: 0.05, bottom: -0.1 },
    },
  },
  "definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: ctx.readNumber('run'), y: 0, z: 0 }); ctx.writeNumber('kg', ctx.weight('deck')) } })",
)

/** a 1.5 m infeed belt, run at the `feed` tag's speed; placed at x -1.35 it butts the scale's tail */
const infeed = buildPackage(
  {
    id: 'acme.infeed',
    name: 'Infeed',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1.5, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1.5, width: 1, top: 0.05 } },
  },
  "definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: ctx.readNumber('feed'), y: 0, z: 0 }) } })",
)

/** a lift whose weighing deck rises at 0.5 m/s while `go` is true */
const lift = buildPackage(
  {
    id: 'acme.lift',
    name: 'Lift',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'car', shape: { kind: 'frame' }, offset: [0, 0, 0] },
        { name: 'deck', parent: 'car', shape: { kind: 'box', size: [1.2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true, loadCell: true },
      ],
      joints: [{ name: 'up', link: 'car', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 2 }],
      bounds: { length: 1.2, width: 1, top: 0.05, bottom: -0.1 },
    },
  },
  `let y = 0
definePart({ joints: ['up'], step(ctx) {
  if (ctx.readTag('go')) y = Math.min(2, y + 0.5 * ctx.dt)
  ctx.joints.up = y
  ctx.writeNumber('kg', ctx.weight('deck'))
} })`,
)

/** a long stopped deck */
const deck = buildPackage(
  { id: 'acme.deck', name: 'Deck', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [12, 0.1, 1.4] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 12, width: 1.4, top: 0.1 } } },
  'definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: 0 }) } })',
)

/**
 * A labeller over the deck: a beam across it at x 0 (`eye`), one across empty deck at x 3 (`miss`) and a zone over
 * both cases. Each change of the `op` tag runs one call: 1 markHit on the eye, 2 mark on the zone, 3 markHit on the
 * clear beam.
 */
const labeller = buildPackage(
  {
    id: 'acme.labeller',
    name: 'Labeller',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'z', shape: { kind: 'box', size: [2, 1, 1.4] }, offset: [0.35, 0.5, 0], hidden: true, collision: 'none', zone: { size: [2, 1, 1.4] } },
        { name: 'eye', shape: { kind: 'frame' }, offset: [0, 0.2, 1], beam: { range: 2, axis: [0, 0, -1] } },
        { name: 'miss', shape: { kind: 'frame' }, offset: [3, 0.2, 1], beam: { range: 2, axis: [0, 0, -1] } },
      ],
      joints: [],
      bounds: { length: 2, width: 1.4, top: 1 },
    },
  },
  `let last = 0
definePart({ step(ctx) {
  const op = ctx.readNumber('op')
  if (op !== last) {
    if (op === 1) ctx.markHit('eye', 'labelId', 7)
    if (op === 2) ctx.mark('z', 'labelId', 9)
    if (op === 3) ctx.markHit('miss', 'labelId', 5)
    last = op
  }
} })`,
)

function boxAt(id: string, x: number, y: number, mass: number): PartInstance {
  return { id, type: 'part', packageId: 'oip.box', position: [x, y, 0], rotationY: 0, params: { mass } }
}

function world(parts: PartInstance[]): SimWorld {
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [scale, infeed, lift, deck, labeller, buildPackage(box.manifest, box.behavior)],
    parts,
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

const onScale = (): PartInstance => ({ id: 'scale', type: 'part', packageId: 'acme.scale', position: [0, DECK_Y, 0], rotationY: 0, params: {} })
const kg = (w: SimWorld, part = 'scale'): number => w.frame().tags?.[part]?.kg as number
function steps(w: SimWorld, n: number, tags: Record<string, number | boolean> = {}): void {
  w.setBehaviorInputTags(tags)
  for (let i = 0; i < n; i++) w.step()
}
function poseX(w: SimWorld, id: string): number {
  const f = w.frame()
  for (let i = 0; i < f.count; i++) if (f.partIds[i] === id) return f.positions[i * 3]!
  throw new Error(`no ${id}`)
}

describe('load cell (ctx.weight)', () => {
  it('reads 0 empty, and each case at its own physics mass', () => {
    const empty = world([onScale()])
    steps(empty, 30, { run: 0 })
    expect(kg(empty)).toBe(0)
    empty.dispose()
    for (const mass of [10, 7]) {
      const w = world([onScale(), boxAt('b', 0, DECK_Y + BOX_H / 2, mass)])
      steps(w, 90, { run: 0 })
      expect(kg(w)).toBeCloseTo(mass, 1)
      w.dispose()
    }
  })

  it('reads a stack as the sum of its courses', () => {
    const w = world([onScale(), boxAt('lo', 0, DECK_Y + BOX_H / 2, 10), boxAt('hi', 0, DECK_Y + BOX_H * 1.5, 7)])
    steps(w, 120, { run: 0 })
    expect(kg(w)).toBeCloseTo(17, 1)
    w.dispose()
  })

  it('keeps reading a case that has gone to sleep on the platform', () => {
    const w = world([onScale(), boxAt('b', 0, DECK_Y + BOX_H / 2, 10)])
    steps(w, 900, { run: 0 })
    expect(w.bodyStats().active).toBe(0) // the case is asleep: the solver reports no contact for it
    expect(kg(w)).toBeCloseTo(10, 1)
    w.dispose()
  })

  it('does not count a case queued against the one on the platform', () => {
    // a fully on the scale (x -0.6..0), b behind it on the infeed (x -1.2..-0.6), pushed against it by the infeed
    const w = world([onScale(), { id: 'in', type: 'part', packageId: 'acme.infeed', position: [-1.35, DECK_Y, 0], rotationY: 0, params: {} }, boxAt('a', -0.3, DECK_Y + BOX_H / 2, 10), boxAt('b', -0.9, DECK_Y + BOX_H / 2, 7)])
    steps(w, 120, { run: 0, feed: 0.3 })
    expect(kg(w)).toBeGreaterThan(9.5)
    expect(kg(w)).toBeLessThan(10.5)
    w.dispose()
  })

  it('ramps up as a case crosses onto the platform, then reads it whole', () => {
    const w = world([onScale(), { id: 'in', type: 'part', packageId: 'acme.infeed', position: [-1.35, DECK_Y, 0], rotationY: 0, params: {} }, boxAt('b', -1.5, DECK_Y + BOX_H / 2, 10)])
    steps(w, 30, { run: 0, feed: 0 })
    let partial = false
    w.setBehaviorInputTags({ run: 0.4, feed: 0.4 })
    for (let i = 0; i < 2000 && poseX(w, 'b') < 0; i++) {
      w.step()
      const x = poseX(w, 'b')
      const r = kg(w)
      if (x < -0.95) expect(r).toBe(0) // wholly on the infeed
      if (x > -0.75 && x < -0.45 && r > 2 && r < 8) partial = true // across the seam: a share of it
    }
    expect(partial).toBe(true)
    steps(w, 90, { run: 0, feed: 0 })
    expect(kg(w)).toBeCloseTo(10, 1)
    w.dispose()
  })

  it('reads a load cantilevered past the edge in full: nothing else holds it up', () => {
    // a 1.6 m case, its centre of gravity over the 1.2 m platform and 0.5 m of it hanging past the +x edge
    const w = world([onScale(), { id: 'long', type: 'part', packageId: 'oip.box', position: [0.3, DECK_Y + BOX_H / 2, 0], rotationY: 0, params: { mass: 20, length: 1.6 } }])
    steps(w, 90, { run: 0 })
    expect(kg(w)).toBeCloseTo(20, 1)
    steps(w, 900, { run: 0 }) // and the same once it is asleep
    expect(w.bodyStats().active).toBe(0)
    expect(kg(w)).toBeCloseTo(20, 1)
    w.dispose()
  })

  it('shares a case bridging two scales by its centre of gravity, and the two always add up to it', () => {
    // two scales butted at x = 0; a 1 m case 20 kg, its centre at x 0.2: most of it on the right scale
    const parts: PartInstance[] = [
      { id: 'left', type: 'part', packageId: 'acme.scale', position: [-0.6, DECK_Y, 0], rotationY: 0, params: {} },
      { id: 'right', type: 'part', packageId: 'acme.scale', position: [0.6, DECK_Y, 0], rotationY: 0, params: {} },
      { id: 'c', type: 'part', packageId: 'oip.box', position: [0.2, DECK_Y + BOX_H / 2, 0], rotationY: 0, params: { mass: 20, length: 1 } },
      // and a case stacked on it off its centre, so the stack's centre of gravity is not the case's own
      { id: 'top', type: 'part', packageId: 'oip.box', position: [0.45, DECK_Y + BOX_H * 1.5, 0], rotationY: 0, params: { mass: 10, length: 0.4 } },
    ]
    const w = world(parts)
    steps(w, 90, { run: 0 })
    const awake = [kg(w, 'left'), kg(w, 'right')]
    expect(awake[0]! + awake[1]!).toBeCloseTo(30, 1)
    expect(awake[1]!).toBeGreaterThan(awake[0]! * 2) // the weight sits over the right scale
    steps(w, 900, { run: 0 })
    expect(w.bodyStats().active).toBe(0)
    // asleep, nothing moved: the same readings, and the stacked case is not counted again as standing on a scale
    expect(kg(w, 'left')).toBeCloseTo(awake[0]!, 3)
    expect(kg(w, 'right')).toBeCloseTo(awake[1]!, 3)
    w.dispose()
  })

  it('reads more while the platform accelerates the load up, and the load at a steady climb', () => {
    const w = world([{ id: 'lift', type: 'part', packageId: 'acme.lift', position: [0, DECK_Y, 0], rotationY: 0, params: {} }, boxAt('b', 0, DECK_Y + BOX_H / 2, 10)])
    steps(w, 90, { go: false })
    expect(kg(w, 'lift')).toBeCloseTo(10, 1)
    let peak = 0
    w.setBehaviorInputTags({ go: true })
    for (let i = 0; i < 10; i++) {
      w.step()
      peak = Math.max(peak, kg(w, 'lift'))
    }
    expect(peak).toBeGreaterThan(12) // the start of the climb: the deck pushes the case up to speed
    steps(w, 120, { go: true })
    expect(kg(w, 'lift')).toBeGreaterThan(9.5) // climbing at a steady 0.5 m/s: its weight again
    expect(kg(w, 'lift')).toBeLessThan(10.5)
    w.dispose()
  })
})

describe('mark on the body a beam hit (ctx.markHit)', () => {
  const two = (): SimWorld =>
    world([
      { id: 'deck', type: 'part', packageId: 'acme.deck', position: [0, DECK_Y, 0], rotationY: 0, params: {} },
      { id: 'lab', type: 'part', packageId: 'acme.labeller', position: [0, DECK_Y, 0], rotationY: 0, params: {} },
      boxAt('c1', 0, DECK_Y + BOX_H / 2, 10), // in the eye
      boxAt('c2', 0.7, DECK_Y + BOX_H / 2, 10), // beside it, in the zone too
    ])

  it('marks only the case the beam hit', () => {
    const w = two()
    steps(w, 30, { op: 0 })
    steps(w, 2, { op: 1 })
    const marks = w.frame().marks ?? {}
    expect(marks.c1?.labelId).toBe(7)
    expect(marks.c2).toBeUndefined()
    w.dispose()
  })

  it('a zone mark, for contrast, marks every case in the zone', () => {
    const w = two()
    steps(w, 30, { op: 0 })
    steps(w, 2, { op: 2 })
    const marks = w.frame().marks ?? {}
    expect(marks.c1?.labelId).toBe(9)
    expect(marks.c2?.labelId).toBe(9)
    w.dispose()
  })

  it('marks nothing through a clear beam', () => {
    const w = two()
    steps(w, 30, { op: 0 })
    steps(w, 2, { op: 3 })
    expect(w.frame().marks ?? {}).toEqual({})
    w.dispose()
  })
})
