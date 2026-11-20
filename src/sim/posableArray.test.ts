import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import type { RigLink } from '../core/parts/partPackage'
import { posableArraysJson } from '../core/rig/rigPose'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { create, destroy, stepDirect } from './embeddedBehavior'
import { SimWorld } from './world'

// A posable array (array.posable): a row of identical solids whose count follows a param and which the behavior
// moves one by one, ctx.setSubPose(link, pose, i). The carriers of a sorter, a slat conveyor or a bucket elevator.

const Jolt = await initJolt()

/** a row of 0.2 m carriers at a 0.5 m pitch along X, as many as fit `length` */
const carriers: RigLink = {
  name: 'carrier',
  shape: { kind: 'frame' },
  offset: [0, 0.1, 0],
  collision: { box: [0.2, 0.2, 0.2] },
  array: { pitch: { axis: 0, spanParam: 'length', pitch: 0.5 }, posable: true },
}

const manifest = (links: RigLink[] = [carriers]): PackageManifest => ({
  id: 'acme.carriers',
  name: 'Carriers',
  category: 'Equipment',
  geometry: { kind: 'rig', links, joints: [], bounds: { length: 4, width: 1, top: 0.2 } },
})

const params = `length: { type: 'number', default: 2, min: 0.5, max: 10 }`

/** one step of `source` created the way the sim creates a rig behavior, with the rig's posable arrays */
function stepOnce(source: string, paramsJson = '{}'): { subPoses: Record<string, { instances?: ({ position?: number[] } | null)[] }>; tags: Record<string, unknown> } {
  const h = create(source, paramsJson, undefined, posableArraysJson(manifest().geometry))
  expect(h).toBeGreaterThan(0)
  const out = stepDirect(h, { simTime: 1 } as never, 1 / 60)
  destroy(h)
  return out as never
}

describe('posable arrays: the behavior side', () => {
  it('ctx.arrayCount follows the span param: round(span / pitch)', () => {
    const src = `definePart({ params: { ${params} }, step(ctx){ ctx.writeNumber('n', ctx.arrayCount('carrier')); ctx.writeNumber('other', ctx.arrayCount('nope')) } })`
    expect(stepOnce(src).tags).toMatchObject({ n: 4, other: 0 })
    expect(stepOnce(src, JSON.stringify({ length: 3.1 })).tags).toMatchObject({ n: 6 })
  })

  it('setSubPose with an index poses that instance; the rest stand at rest (null)', () => {
    const src = `definePart({ params: { ${params} }, step(ctx){ ctx.setSubPose('carrier', { position: [1, 2, 3] }, 2) } })`
    expect(stepOnce(src).subPoses).toEqual({ carrier: { instances: [null, null, { position: [1, 2, 3] }, null] } })
  })

  it('ignores an index outside the row, a fractional one, and an index on a link that is not a posable array', () => {
    const src = `definePart({ params: { ${params} }, step(ctx){
      ctx.setSubPose('carrier', { position: [1, 0, 0] }, 4)
      ctx.setSubPose('carrier', { position: [1, 0, 0] }, -1)
      ctx.setSubPose('carrier', { position: [1, 0, 0] }, 1.5)
      ctx.setSubPose('arm', { position: [1, 0, 0] }, 0)
    } })`
    expect(stepOnce(src).subPoses).toEqual({})
  })

  it('a whole-link pose and instance poses on one link keep each other', () => {
    const src = `definePart({ params: { ${params} }, step(ctx){
      ctx.setSubPose('carrier', { position: [0, 0, 1] }, 0)
      ctx.setSubPose('carrier', { position: [0, 5, 0] })
    } })`
    expect(stepOnce(src).subPoses).toEqual({ carrier: { position: [0, 5, 0], instances: [{ position: [0, 0, 1] }, null, null, null] } })
  })
})

function world(links: RigLink[], source: string, length = 2): SimWorld {
  clearPackages()
  const pkg = buildPackage(manifest(links), source)
  const res = validateScene({ version: SCENE_VERSION, packages: [pkg], parts: [{ id: 'cp_1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params: { length } }] })
  expect(res.ok).toBe(true)
  if (!res.ok) throw new Error('scene')
  return new SimWorld(Jolt, res.scene)
}

/** x of the one box after `steps` steps, starting at (x, 0.3, z) */
function pushed(w: SimWorld, x: number, z: number, steps = 90): number {
  w.spawnBoxAt(x, 0.3, z, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
  for (let i = 0; i < steps; i++) w.step()
  const out = w.frame().positions[0] ?? NaN
  w.dispose()
  return out
}

describe('posable arrays: the sim side', () => {
  // instance i sweeps along +X from x = -1 through the box's place, the others parked 3 m to the side
  const sweep = (i: number): string => `definePart({ params: { ${params} }, step(ctx){
    const n = ctx.arrayCount('carrier')
    for (let k = 0; k < n; k++) ctx.setSubPose('carrier', { position: k === ${i} ? [-1 + ctx.simTime * 2, 0.1, 0] : [0, 0.1, -3] }, k)
  } })`

  it('a posed instance is a kinematic solid that pushes cargo', () => {
    // the box at x = 0.2 sits in the swept instance's path; the others are parked 3 m to one side
    expect(pushed(world([carriers], sweep(3)), 0.2, 0)).toBeGreaterThan(0.8)
  })

  it('an instance past the default count exists once the span param grows it', () => {
    // at length 2 there are 4 instances, so index 5 is ignored and the box stays put; at length 3.1 there are 6
    expect(pushed(world([carriers], sweep(5), 2), 0.2, 0)).toBeLessThan(0.3)
    expect(pushed(world([carriers], sweep(5), 3.1), 0.2, 0)).toBeGreaterThan(0.8)
  })

  it('an unposed instance stands at its rest place in the row and is solid there', () => {
    // nothing is posed: instance 0 rests at x = -0.75 in the link frame, so a box dropped onto it stays up on it
    const w = world([carriers], `definePart({ params: { ${params} }, step(ctx){} })`)
    w.spawnBoxAt(-0.75, 0.6, 0, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1])
    for (let i = 0; i < 60; i++) w.step()
    const y = w.frame().positions[1] ?? NaN
    w.dispose()
    expect(y).toBeGreaterThan(0.2) // resting on the carrier (top at 0.2), not on the floor
  })
})

// A conveying carrier: each copy a deck of its own (a cross-belt sorter's belts). Two 1 m decks, 2.5 m apart.
const belts: RigLink = {
  name: 'belt',
  shape: { kind: 'box', size: [1, 0.1, 1] },
  offset: [0, 0.05, 0],
  conveys: true,
  array: { pitch: { axis: 0, spanParam: 'length', pitch: 2.5 }, posable: true },
}

/** the box's position after `steps`, dropped on the deck centred at x */
function ride(source: string, x: number, steps = 60): number[] {
  const w = world([belts], source, 5) // length 5: two copies, resting at x = -1.25 and +1.25
  w.spawnBoxAt(x, 0.25, 0, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1])
  for (let i = 0; i < steps; i++) w.step()
  const f = w.frame()
  const out = [f.positions[0] ?? NaN, f.positions[1] ?? NaN, f.positions[2] ?? NaN]
  w.dispose()
  return out
}

describe('posable arrays that convey: a deck per copy', () => {
  it("a copy's own belt carries its cargo along the copy's +X; the other copy, given no speed, holds still", () => {
    const run = `definePart({ params: { ${params} }, step(ctx){ ctx.setSurfaceSpeed(1, 'belt', 1) } })`
    expect(ride(run, 1.25)[0]).toBeGreaterThan(1.25 + 0.5) // on copy 1: carried along +X
    expect(ride(run, -1.25)[0]).toBeCloseTo(-1.25, 1) // on copy 0: no speed, stays put
  })

  it('a moving copy carries its cargo with it, belt stopped', () => {
    // copy 1 slides along +Z at 0.5 m/s: the box on it rides along, like a carrier going round a sorter
    const slide = `definePart({ params: { ${params} }, step(ctx){ ctx.setSubPose('belt', { position: [1.25, 0.05, ctx.simTime * 0.5] }, 1) } })`
    expect(ride(slide, 1.25, 120)[2]).toBeGreaterThan(0.8)
  })

  it('the part-wide surface commands never run the copies', () => {
    const wide = `definePart({ params: { ${params} }, step(ctx){ ctx.setSurfaceSpeed(1); ctx.setSurfaceVelocity({ x: 1, y: 0, z: 0 }) } })`
    expect(ride(wide, 1.25)[0]).toBeCloseTo(1.25, 1)
  })

  it('a frame with a collision box conveys too: a deck that draws nothing, its look from geometry()', () => {
    const framed: RigLink = { ...belts, shape: { kind: 'frame' }, collision: { box: [1, 0.1, 1] } }
    const w = world([framed], `definePart({ params: { ${params} }, step(ctx){ ctx.setSurfaceSpeed(1, 'belt', 1) } })`, 5)
    w.spawnBoxAt(1.25, 0.25, 0, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1])
    for (let i = 0; i < 60; i++) w.step()
    const x = w.frame().positions[0] ?? NaN
    w.dispose()
    expect(x).toBeGreaterThan(1.25 + 0.5)
  })

  it('every copy runs when no index is given', () => {
    const all = `definePart({ params: { ${params} }, step(ctx){ ctx.setSurfaceSpeed(-1, 'belt') } })`
    expect(ride(all, -1.25)[0]).toBeLessThan(-1.25 - 0.5)
  })
})

describe('a conveying deck posed with setSubPose', () => {
  it('moves with its pose and carries its cargo, with no joint under it', () => {
    const deck: RigLink = { name: 'shuttle', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, 0.05, 0], conveys: true }
    const w = world([deck], `definePart({ params: { ${params} }, step(ctx){ ctx.setSubPose('shuttle', { position: [0, 0.05, ctx.simTime * 0.5] }) } })`)
    w.spawnBoxAt(0, 0.25, 0, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1])
    for (let i = 0; i < 120; i++) w.step()
    const z = w.frame().positions[2] ?? NaN
    w.dispose()
    expect(z).toBeGreaterThan(0.8) // the shuttle drove 1 m along +Z and the box went with it
  })
})

describe('posable arrays that grip: a gripper per copy', () => {
  // three magazine positions 1 m apart, each a gripper whose volume covers the box standing under it
  const positions: RigLink = {
    name: 'pos',
    shape: { kind: 'frame' },
    offset: [0, 0.1, 0],
    grip: { zone: { size: [0.4, 0.3, 0.4] } },
    array: { pitch: { axis: 0, spanParam: 'length', pitch: 1 }, posable: true },
  }

  it('copy i closes on the box under it and carries it; the others hold nothing', () => {
    const src = `let t = 0
definePart({ params: { ${params} }, step(ctx){
      t += ctx.dt
      ctx.setGrip('pos', true, 1)
      ctx.setSubPose('pos', { position: [0, 0.1 + Math.max(0, t - 0.5) * 0.5, 0] }, 1)
      ctx.writeTag('held1', ctx.measured.grips['pos#1'] === true)
      ctx.writeTag('held0', ctx.measured.grips['pos#0'] === true)
    } })`
    const w = world([positions], src, 3) // copies rest at x = -1, 0, 1
    for (const x of [-1, 0, 1]) w.spawnBoxAt(x, 0.1, 0, 0.1, 0.1, 0.1, 0, 10, [1, 1, 1])
    for (let i = 0; i < 90; i++) w.step()
    const f = w.frame()
    const y = (k: number): number => f.positions[k * 3 + 1] ?? NaN
    const tags = f.tags?.cp_1 ?? {}
    w.dispose()
    expect(y(1)).toBeGreaterThan(0.3) // lifted 0.25 m with its copy
    expect(y(0)).toBeLessThan(0.15) // its neighbours stay on the floor
    expect(y(2)).toBeLessThan(0.15)
    expect(tags).toMatchObject({ held1: true, held0: false })
  })
})
