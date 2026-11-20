// The part runtime's guards against part code that is wrong rather than malicious: an endless loop, a NaN
// command, a negative size, and a part writing into what it sensed. Unguarded, each reaches the host - a hung
// sim worker, a NaN cargo position in Jolt, a box launched ~30 m, one part repainting a box or poisoning
// every other part's clear beam.

import { describe, expect, it } from 'vitest'
import { instrumentLoops, LOOP_GUARD } from '../core/loopGuard'
import { instantiatePartScript } from '../core/parts/partScript'
import { DEFAULT_SIM_HZ } from '../core/types'
import { create, destroy, error, step } from './embeddedBehavior'

const DT = 1 / DEFAULT_SIM_HZ
const input = (extra: Record<string, unknown> = {}) => JSON.stringify({ simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: {}, ...extra })
const run = (src: string, extra?: Record<string, unknown>) => {
  const h = create(src, '{}')
  expect(h, error()).toBeGreaterThan(0)
  const out = JSON.parse(step(h, input(extra), DT)) as Record<string, unknown>
  const err = error()
  destroy(h)
  return { out, err }
}

describe('loop budget', () => {
  it.each([
    ['for (;;)', 'for (;;) {}'],
    ['while (true)', 'while (true) {}'],
    ['do … while (true)', 'do { n++ } while (true)'],
    ['for with a test that never fails', 'for (let i = 0; i >= 0; i++) {}'],
  ])('stops %s in step() with a located error instead of hanging', (_name, loop) => {
    const t0 = Date.now()
    const { err } = run(`definePart({ step(ctx) { let n = 0; ${loop} } })`)
    expect(err).toMatch(/loop .* iterations in one call/)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('stops an endless loop in geometry() and at the top level', () => {
    const geo = instantiatePartScript(`definePart({ step() {}, geometry(g) { while (1) {} } })`)
    expect(geo.def).not.toBeNull()
    expect(() => geo.def!.geometry!({} as never, {} as never, {} as never)).toThrow(/iterations in one call/)
    expect(instantiatePartScript(`for (;;) {}\ndefinePart({ step() {} })`).error).toMatch(/iterations in one call/)
  })

  it('budgets each call, not the lifetime: a real workload runs every tick', () => {
    const h = create(`definePart({ step(ctx) { let s = 0; for (let i = 0; i < 2000000; i++) s += i; ctx.setSurfaceVelocity({ x: s > 0 ? 1 : 0, y: 0, z: 0 }) } })`, '{}')
    for (let t = 0; t < 10; t++) {
      const out = JSON.parse(step(h, input(), DT)) as { surfaceVelocity: number[] }
      expect(error()).toBe('')
      expect(out.surfaceVelocity[0]).toBe(1)
    }
    destroy(h)
  })

  it('leaves strings, comments, for-of and line numbers alone', () => {
    const src = [`const s = "while (x)" // for (;;)`, `for (const k of [1]) {}`, `/* while (y) */ for (let i = 0; i < 3; i++) {}`].join('\n')
    const out = instrumentLoops(src)
    expect(out.split('\n')).toHaveLength(3)
    expect(out.split('\n')[0]).toBe(`const s = "while (x)" // for (;;)`)
    expect(out.split('\n')[1]).toBe(`for (const k of [1]) {}`)
    expect(out.split('\n')[2]).toContain(`${LOOP_GUARD}() && ( i < 3)`)
  })

  it('a misread (an object method named `while`) falls back to the untouched script', () => {
    const { err, out } = run(`const o = { while(a) { return a } }; definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: o.while(2), y: 0, z: 0 }) } })`)
    expect(err).toBe('')
    expect((out.surfaceVelocity as number[])[0]).toBe(2)
  })
})

describe('bad commands never reach the host', () => {
  it('setSurfaceVelocity ignores NaN / Infinity', () => {
    const { out } = run(`definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: NaN, y: 0, z: Infinity }) } })`)
    expect(out.surfaceVelocity).toEqual([0, 0, 0])
  })

  it('spawn drops a non-positive size (the rest of the request stands)', () => {
    const { out } = run(`definePart({ step(ctx) { ctx.spawn({ size: [-0.4, 0.3, 0.3] }); ctx.spawn({ size: [0.4, 0, 0.3] }); ctx.spawn({ size: [0.4, 0.3, 0.3] }) } })`)
    const spawns = out.spawns as { size?: number[] }[]
    expect(spawns).toHaveLength(3)
    expect(spawns[0]!.size).toBeUndefined()
    expect(spawns[1]!.size).toBeUndefined()
    expect(spawns[2]!.size).toEqual([0.4, 0.3, 0.3])
  })
})

describe('ctx.sense hands out copies', () => {
  const WRITER = `definePart({ step(ctx) { const a = ctx.sense('eye'); a.hit = true; a.color[0] = 9; const b = ctx.sense('nope'); b.hit = true; b.color[1] = 9 } })`
  const READER = `definePart({ step(ctx) { const m = ctx.sense('missing'); const e = ctx.sense('eye'); ctx.setSurfaceVelocity({ x: m.hit ? 1 : 0, y: m.color[1], z: e.color[0] }) } })`

  it("one part writing into a miss can't poison another part's clear beam", () => {
    run(WRITER, { beams: { eye: { hit: true, distance: 0.5, color: [0.2, 0.3, 0.4] } } })
    const { out } = run(READER)
    expect(out.surfaceVelocity).toEqual([0, 0, 0])
  })

  it('a hit read twice in one tick is the host value both times', () => {
    const h = create(`definePart({ step(ctx) { ctx.sense('eye').color[0] = 9; ctx.setSurfaceVelocity({ x: ctx.sense('eye').color[0], y: 0, z: 0 }) } })`, '{}')
    const out = JSON.parse(step(h, input({ beams: { eye: { hit: true, distance: 0.5, color: [0.2, 0.3, 0.4] } } }), DT)) as { surfaceVelocity: number[] }
    expect(out.surfaceVelocity[0]).toBeCloseTo(0.2)
    destroy(h)
  })
})

describe('init() runs at the first step, where it can see and command the placed part', () => {
  it('sees the real position and its commands land in the first tick', () => {
    const h = create(`let seen = null; definePart({ joints: ['lift'], init(ctx) { seen = ctx.position.x; ctx.setJoint('lift', 0.2) }, step(ctx) { ctx.writeNumber('seen', seen) } })`, '{}')
    expect(h).toBeGreaterThan(0)
    const out = JSON.parse(step(h, input({ position: [3, 0, 0] }), DT)) as { joints: Record<string, number>; tags: Record<string, number> }
    expect(out.joints.lift).toBe(0.2) // not wiped by the first tick's output reset
    expect(out.tags.seen).toBe(3) // not the origin
    destroy(h)
  })

  it('runs once', () => {
    const h = create(`let n = 0; definePart({ init() { n++ }, step(ctx) { ctx.writeNumber('n', n) } })`, '{}')
    for (let i = 0; i < 3; i++) step(h, input(), DT)
    expect((JSON.parse(step(h, input(), DT)) as { tags: Record<string, number> }).tags.n).toBe(1)
    destroy(h)
  })

  it('a throwing init is a reported first-tick error, not a failed create', () => {
    const h = create(`definePart({ init() { throw new Error('bad setup') }, step() {} })`, '{}')
    expect(h).toBeGreaterThan(0)
    expect(step(h, input(), DT)).toBe('{}')
    expect(error()).toMatch(/bad setup/)
    destroy(h)
  })

  it('a throwing dispose is reported, not swallowed', () => {
    const h = create(`definePart({ dispose() { throw new Error('bad teardown') }, step() {} })`, '{}')
    destroy(h)
    expect(error()).toMatch(/dispose\(\) threw: bad teardown/)
  })
})
