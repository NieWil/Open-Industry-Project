import { describe, expect, it } from 'vitest'
import { GpuFrameTimes, RefreshEstimate } from './frameMeter'

/** a resolved batch the way three's render pool holds it: `r:<calls>:<id>:f<frame>` to the pass's ms */
const batch = (passes: [frame: number, ms: number][]): Map<string, number> =>
  new Map(passes.map(([f, ms], i) => [`r:${i}:${100 + i}:f${f}`, ms]))

describe('GpuFrameTimes', () => {
  it('adds each frame of a batch once, summing its passes', () => {
    const g = new GpuFrameTimes()
    g.collect(batch([[10, 4], [10, 6], [11, 9], [11, 1], [12, 12]]))
    expect(g.frames).toBe(3)
    expect(g.totalMs).toBe(32)
  })

  it('skips a batch handed over again, and frames already counted', () => {
    const g = new GpuFrameTimes()
    const b = batch([[10, 4], [11, 5]])
    g.collect(b)
    g.collect(b)
    g.collect(batch([[11, 5], [12, 7]]))
    expect(g.frames).toBe(3)
    expect(g.totalMs).toBe(16)
  })

  it('ignores keys without a frame id and values that are not times', () => {
    const g = new GpuFrameTimes()
    g.collect(new Map([['r:0:1', 5], ['r:1:2:f3', Number.NaN], ['r:2:3:f3', 2]]))
    expect(g.frames).toBe(1)
    expect(g.totalMs).toBe(2)
  })
})

describe('RefreshEstimate', () => {
  const feed = (r: RefreshEstimate, dt: (i: number) => number, n: number) => {
    for (let i = 0; i < n; i++) r.push(dt(i))
  }

  it('assumes 60 Hz before a full window', () => {
    const r = new RefreshEstimate()
    feed(r, () => 8.3, 200)
    expect(r.intervalMs).toBeCloseTo(16.67, 1)
  })

  it('reads a 120 Hz display once its frames show it', () => {
    const r = new RefreshEstimate()
    feed(r, () => 8.3, 320)
    expect(r.intervalMs).toBeCloseTo(8.3, 1)
  })

  it('never takes a scene slow from the start for a slow display', () => {
    const r = new RefreshEstimate()
    feed(r, () => 33.3, 1024)
    expect(r.intervalMs).toBeCloseTo(16.67, 1)
  })

  it('reads a 60 Hz display from a run held at 30 fps with some frames on time', () => {
    const r = new RefreshEstimate()
    feed(r, (i) => (i % 5 === 0 ? 16.7 : 33.3), 512)
    expect(r.intervalMs).toBeCloseTo(16.7, 1)
  })

  it('is not pulled down by the odd fast frame of a 120 Hz panel', () => {
    const r = new RefreshEstimate()
    feed(r, (i) => (i % 60 === 0 ? 8.3 : 16.7), 512)
    expect(r.intervalMs).toBeCloseTo(16.7, 1)
  })

  it('keeps the fastest reading when the run slows down', () => {
    const r = new RefreshEstimate()
    feed(r, () => 16.7, 320)
    feed(r, () => 40, 1024)
    expect(r.intervalMs).toBeCloseTo(16.7, 1)
  })
})
