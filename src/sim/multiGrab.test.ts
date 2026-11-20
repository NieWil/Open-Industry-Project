import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../core/types'
import type { SdkPart, SceneJSON } from '../core/types'
import { registerPackage, unregisterPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// C-multigrab at the host seam (world.handleGrips): a gripper holds every cargo body inside its pickup volume at
// once, which is the palletizer layer head (lift a whole formed layer) and the loaded fork (a pallet plus the stack
// riding on it). There is no single/multi mode: the count is a consequence of the tool, so the same seam that
// lifts five cases under a layer plate lifts exactly one under a volume the size of one case. The volume is the
// link's `grip.zone` oriented box, falling back to the `grip.radius` sphere when a rig declares none.
//
// The discriminator throughout is physical, not a feedback flag (measured.grips is only a boolean): the hand
// lifts after grabbing, so a held box rises with it and a missed one falls under gravity.

const Jolt = await initJolt()

const PKG = 'test.multigrab'

/** the hand sits at y = 0.5; its default pickup volume is 1.4 (x) × 0.4 (y) × 1.2 (z) centred there */
const HAND_Y = 0.5
const ZONE: [number, number, number] = [1.4, 0.4, 1.2]

// Commands the hand shut and hoists it steadily, so whatever it caught rides up with it; `releaseAfter` ticks
// later the grip opens, which is how the release path (every held body back to dynamic) gets exercised.
const GRAB_AND_LIFT = `
  let lift = 0
  let t = 0
  definePart({
    joints: ['lift'],
    grippers: ['hand'],
    params: {
      releaseAfter: { type: 'number', default: 1000000, min: 1, max: 1000000, step: 1, label: 'Release after (ticks)' },
    },
    step(ctx) {
      t += 1
      ctx.grips.hand = t <= ctx.params.releaseAfter
      lift = Math.min(lift + ctx.dt * 2, 1.5)
      ctx.joints.lift = lift
    },
  })`

/** `zone: null` builds the hand with a `grip.radius` sphere instead of a box volume (the no-zone fallback) */
function setup(opts: {
  params?: Record<string, unknown>
  zone?: [number, number, number] | null
  zoneOffset?: [number, number, number]
  grabRadius?: number
} = {}): SimWorld {
  const { params = {}, zone = ZONE, zoneOffset, grabRadius } = opts
  registerPackage(
    buildPackage(
      {
        id: PKG,
        name: 'MultiGrab',
        geometry: {
          kind: 'rig',
          links: [
            { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
            {
              name: 'hand',
              parent: 'base',
              shape: { kind: 'frame' },
              offset: [0, HAND_Y, 0],
              ...(zone ? { grip: { zone: { size: zone, ...(zoneOffset ? { offset: zoneOffset } : {}) } } } : grabRadius !== undefined ? { grip: { radius: grabRadius } } : {}),
            },
          ],
          joints: [{ name: 'lift', link: 'hand', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 2 }],
        },
      },
      GRAB_AND_LIFT,
    ),
  )
  const parts = [{ id: 'g', type: 'part', packageId: PKG, position: [0, 0, 0], rotationY: 0, params } as SdkPart]
  return new SimWorld(Jolt, { version: SCENE_VERSION, parts } as SceneJSON)
}

/** box centres (y) in spawn order, read off the frame snapshot */
function boxYs(w: SimWorld): number[] {
  const f = w.frame()
  const ys: number[] = []
  for (let i = 0; i < f.ids.length; i++) ys.push(f.positions[i * 3 + 1] as number)
  return ys
}

/** a 2 + 3 layer inside the volume, plus one box parked outside it (x = 1.2 > the 0.7 half-extent) */
function spawnLayerPlusStray(w: SimWorld): void {
  for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.4, 0.25], [0, 0.25], [0.4, 0.25]] as const) {
    w.spawnBoxAt(x, HAND_Y, z, 0.14, 0.1, 0.14)
  }
  w.spawnBoxAt(1.2, HAND_Y, 0, 0.14, 0.1, 0.14) // the stray: out of the volume, must never be caught
}

function run(w: SimWorld, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.step()
}

describe('C-multigrab - a gripper holds every cargo body in its volume', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    unregisterPackage(PKG)
  })

  it('lifts the whole layer when the volume spans it, and leaves the box outside the volume behind', () => {
    const w = (world = setup())
    spawnLayerPlusStray(w)
    run(w, 40)
    const ys = boxYs(w)
    const layer = ys.slice(0, 5)
    // every in-volume box rode up with the hand…
    for (const y of layer) expect(y).toBeGreaterThan(HAND_Y + 0.5)
    // …and stayed in formation: one rigid load, so their heights agree
    expect(Math.max(...layer) - Math.min(...layer)).toBeLessThan(0.01)
    // …while the box outside the volume was never grabbed and fell
    expect(ys[5] as number).toBeLessThan(HAND_Y)
  })

  it('picks exactly one case when the volume is the size of one case - the count follows the tool, not a mode', () => {
    // 0.3 m of lateral reach: the box centre must land within 0.15 m of the hand, so only the middle one qualifies
    const w = (world = setup({ zone: [0.3, 0.4, 0.3] }))
    for (const x of [-0.3, 0, 0.3]) w.spawnBoxAt(x, HAND_Y, 0, 0.14, 0.1, 0.14)
    run(w, 40)
    const ys = boxYs(w)
    expect(ys.filter((y) => y > HAND_Y + 0.5)).toHaveLength(1)
    expect(ys[1] as number).toBeGreaterThan(HAND_Y + 0.5) // and it is the one the hand was over
  })

  it('falls back to the grip radius sphere with no zone - still every body it touches, measured to the surface', () => {
    // the un-migrated shape: no zone, a 0.5 m reach. Everything the sphere touches comes along, which is exactly
    // why a tool wider than its load has to declare a zone instead.
    const w = (world = setup({ zone: null, grabRadius: 0.5 }))
    spawnLayerPlusStray(w)
    run(w, 40)
    const ys = boxYs(w)
    for (const y of ys.slice(0, 5)) expect(y).toBeGreaterThan(HAND_Y + 0.5)
    expect(ys[5] as number).toBeLessThan(HAND_Y) // the stray is 1.06 m from the hand surface: out of reach
  })

  it('bounds the pick by the volume, not a sphere: a shallow zone ignores cargo below the plate', () => {
    // 0.12 m of vertical reach - the cargo sits 0.3 m under the hand, so nothing is inside the volume
    const w = (world = setup({ zone: [1.4, 0.12, 1.2] }))
    for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [0, 0.25]] as const) {
      w.spawnBoxAt(x, HAND_Y - 0.3, z, 0.14, 0.1, 0.14)
    }
    run(w, 40)
    expect(boxYs(w).filter((y) => y > HAND_Y)).toHaveLength(0)
  })

  it('places the volume at its link-local offset, so a fork reaches a load ahead of the grab frame', () => {
    // volume 1.0 wide, shoved 1.2 m out along +X: it covers x ∈ [0.7, 1.7] and nothing at the link itself
    const w = (world = setup({ zone: [1.0, 0.4, 1.2], zoneOffset: [1.2, 0, 0] }))
    w.spawnBoxAt(0, HAND_Y, 0, 0.14, 0.1, 0.14) // at the frame - outside the shifted volume
    w.spawnBoxAt(1.2, HAND_Y, 0, 0.14, 0.1, 0.14) // out on the "tines" - inside
    run(w, 40)
    const ys = boxYs(w)
    expect(ys[0] as number).toBeLessThan(HAND_Y) // fell: the volume no longer covers the link origin
    expect(ys[1] as number).toBeGreaterThan(HAND_Y + 0.5) // lifted: reached out to the load
  })

  it('releases the whole load together when the grip opens', () => {
    const w = (world = setup({ params: { releaseAfter: 30 } }))
    spawnLayerPlusStray(w)
    run(w, 30)
    const lifted = boxYs(w).slice(0, 5)
    expect(lifted.every((y) => y > HAND_Y + 0.3)).toBe(true)
    // the grip opens on tick 31: every held body goes back to dynamic and falls away from the hand
    run(w, 40)
    const dropped = boxYs(w).slice(0, 5)
    for (const [i, y] of dropped.entries()) expect(y).toBeLessThan((lifted[i] as number) - 0.2)
  })
})
