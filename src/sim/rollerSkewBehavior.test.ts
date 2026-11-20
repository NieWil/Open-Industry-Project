import initJolt from 'jolt-physics'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SIM_HZ } from '../core/types'
import { create, destroy, step } from './embeddedBehavior'

// The actual committed Roller Conveyor behavior (examples/parts/roller-conveyor/behavior.ts) driven through the
// embedded-behavior harness, exercising the skew path: a skewed roller bed must drive cargo along the roller
// normal (`forward` rotated by the skew angle about vertical) at magnitude speed/cos(skew), so the forward
// throughput stays `speed` and a lateral speed·tan(skew) squares cargo against a side guard.
await initJolt() // the harness pulls in world.ts' Jolt bindings transitively; init once

const BEHAVIOR = readFileSync(fileURLToPath(new URL('../../examples/parts/roller-conveyor/behavior.ts', import.meta.url)), 'utf8')
const dt = 1 / DEFAULT_SIM_HZ
/** no accel / decel ramp: these cases are about the direction skew gives the velocity, read on the first step */
const INSTANT = { accelTime: 0, decelTime: 0 }

function svOf(json: string): [number, number, number] {
  return (JSON.parse(json) as { surfaceVelocity: [number, number, number] }).surfaceVelocity
}
const input = (forward: [number, number, number]) => JSON.stringify({ simTime: 0, position: [0, 0, 0], forward, tags: {} })

describe('Roller Conveyor behavior - skew angles the surface velocity', () => {
  it('skew 0 drives straight along forward (unchanged)', () => {
    const h = create(BEHAVIOR, JSON.stringify({ ...INSTANT, speed: 1, skew: 0 }))
    expect(svOf(step(h, input([1, 0, 0]), dt))).toEqual([1, 0, 0])
    destroy(h)
  })

  it('skew rotates the velocity yet keeps forward throughput = speed, adding lateral speed·tan(skew)', () => {
    const speed = 2
    const skew = 30
    const rad = (skew * Math.PI) / 180
    const h = create(BEHAVIOR, JSON.stringify({ ...INSTANT, speed, skew }))
    const [vx, vy, vz] = svOf(step(h, input([1, 0, 0]), dt))
    // forward = +X, so vx is the forward throughput and vz the lateral
    expect(vx).toBeCloseTo(speed, 6) // throughput unchanged by skew
    expect(vz).toBeCloseTo(-speed * Math.tan(rad), 6) // +skew squares toward −Z
    expect(vy).toBe(0)
    // magnitude = speed / cos(skew)
    expect(Math.hypot(vx, vz)).toBeCloseTo(speed / Math.cos(rad), 6)
    destroy(h)
  })

  it('flips the lateral side when the skew sign flips', () => {
    const pos = svOf(step(create(BEHAVIOR, JSON.stringify({ ...INSTANT, speed: 1.5, skew: 25 })), input([1, 0, 0]), dt))
    const neg = svOf(step(create(BEHAVIOR, JSON.stringify({ ...INSTANT, speed: 1.5, skew: -25 })), input([1, 0, 0]), dt))
    expect(pos[0]).toBeCloseTo(neg[0], 6) // same forward throughput
    expect(pos[2]).toBeCloseTo(-neg[2], 6) // opposite lateral
  })

  it('holds the invariant under a rotated part (forward −Z): throughput along forward stays speed', () => {
    const speed = 1
    const skew = 40
    const fwd: [number, number, number] = [0, 0, -1] // part yawed 90°
    const sv = svOf(step(create(BEHAVIOR, JSON.stringify({ ...INSTANT, speed, skew })), input(fwd), dt))
    const throughput = sv[0] * fwd[0] + sv[2] * fwd[2] // sv · forward
    expect(throughput).toBeCloseTo(speed, 6)
    expect(Math.hypot(sv[0], sv[2])).toBeCloseTo(speed / Math.cos((skew * Math.PI) / 180), 6)
  })

  it('a run-gate of 0 (skew present) still stops the bed - skew never leaks a residual velocity', () => {
    // a driven false runTag ⇒ commanded gated to 0; with skew set, s/cos of 0 is still 0
    const h = create(BEHAVIOR, JSON.stringify({ ...INSTANT, speed: 2, skew: 30, runTag: 'run' }))
    const withRunFalse = JSON.stringify({ simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: { run: false }, driven: { run: true } })
    expect(svOf(step(h, withRunFalse, dt))).toEqual([0, 0, 0])
    destroy(h)
  })

  it('an undriven runTag does not gate - the authored speed still drives the skewed bed', () => {
    // output ownership: with no controller driving 'run', typing the tag name must not dead-stop the bed
    // (a gate keyed off the tag name would make the Inspector speed silently do nothing)
    const h = create(BEHAVIOR, JSON.stringify({ ...INSTANT, speed: 2, skew: 30, runTag: 'run' }))
    const undriven = JSON.stringify({ simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: { run: false } })
    const sv = svOf(step(h, undriven, dt))
    expect(Math.hypot(sv[0], sv[2])).toBeCloseTo(2 / Math.cos((30 * Math.PI) / 180), 6)
    destroy(h)
  })
})
