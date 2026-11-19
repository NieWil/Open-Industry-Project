import { describe, expect, it } from 'vitest'
import type { RenderStats } from '../render/api'
import { BenchRun, createScreenWakeLock, readBenchParams, readSavedBench, type BenchHost, type BenchPose } from './bench'

const STATS: RenderStats = {
  drawCalls: 42,
  drawPath: 'replay',
  triangles: 1234,
  cpuMs: 4,
  cpuTotalMs: 0,
  frames: 0,
  gpuMs: 3,
  gpuTotalMs: 0,
  gpuFrames: 0,
  refreshMs: null,
  missedFrames: 0,
  backend: 'WebGPU',
  matrixLiveParts: 2,
  textures: 53,
  geometries: 199,
}

/** a host whose clock the test drives by hand, so a five-minute schedule runs instantly */
function makeHost(over: Partial<BenchHost> = {}) {
  const saved: string[] = []
  const poses: BenchPose[] = []
  const clock = { t: 0 }
  let missed = 0
  const host: BenchHost = {
    now: () => clock.t,
    stats: () => ({ ...STATS, missedFrames: missed }),
    setCameraPose: (p) => poses.push(p),
    gpuErrors: () => 0,
    hidden: () => false,
    wakeLock: () => 'held',
    save: (json) => saved.push(json),
    build: 'abc1234',
    startedAt: '2026-08-22T00:00:00.000Z',
    scene: 'demo',
    parts: () => 37,
    device: { ua: 'test', css: [390, 844], dpr: 3, cores: 6, memGB: 8, gpuAvailable: false },
    config: () => ({
      tier: 'mobile',
      dprCap: 1.5,
      dprActual: 1.5,
      msaa: 0,
      singlePass: true,
      singlePassHonoured: false,
      shadowMap: 1024,
      backend: 'WebGPU',
      drawPath: 'replay',
      countersNote: 'drawCalls and triangles are per-replay encode tallies, not scene totals - see bench.ts',
    }),
    startPose: { px: 11, py: 9.5, pz: 6.5, tx: 4.5, ty: 1.2, tz: -4.5 },
    ...over,
  }
  return { host, saved, poses, clock, missFrame: () => missed++ }
}

/**
 * Feed `sec` seconds of frames at `dtMs`, advancing the injected clock in sync. The run times its
 * own frames off that clock (the view's dt is clamped and unusable for measurement), so moving the
 * clock is the frame interval.
 */
function run(bench: BenchRun, clock: { t: number }, sec: number, dtMs = 16.7) {
  const end = clock.t + sec * 1000
  while (clock.t < end) {
    clock.t += dtMs
    bench.frame()
  }
}

describe('readBenchParams', () => {
  it('is off without the flag, and off when explicitly disabled', () => {
    expect(readBenchParams('?scene=demo').enabled).toBe(false)
    expect(readBenchParams('?bench=off').enabled).toBe(false)
    expect(readBenchParams('?bench=0').enabled).toBe(false)
  })

  it('defaults to the five-minute schedule with the decay-legible windows', () => {
    const p = readBenchParams('?bench')
    expect(p.enabled).toBe(true)
    expect(p.totalSec).toBe(300)
    expect(p.boundariesSec).toEqual([30, 60, 180, 300])
  })

  it('?bench=<sec> shortens the run and drops the windows past it', () => {
    expect(readBenchParams('?bench=45').boundariesSec).toEqual([30, 45])
    expect(readBenchParams('?bench=10').boundariesSec).toEqual([10])
  })

  it('?benchwin names the schedule outright (how the e2e gate runs one in seconds)', () => {
    const p = readBenchParams('?bench&benchwin=5,2,8')
    expect(p.boundariesSec).toEqual([2, 5, 8])
    expect(p.totalSec).toBe(8)
  })
})

describe('BenchRun', () => {
  it('closes one window per boundary and completes', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2,4'))
    run(bench, clock, 4.1)
    expect(bench.complete).toBe(true)
    const r = bench.result()
    expect(r.windows.map((w) => w.at)).toEqual(['0-2s', '2s-4s'])
    expect(r.events.complete).toBe(true)
    expect(r.windows[0]!.frames).toBeGreaterThan(100)
  })

  it('reports frame-interval quantiles, not an average', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=3'))
    run(bench, clock, 2, 10)
    // one much slower stretch: it must move worst/p95 without dragging the median with it
    run(bench, clock, 1.1, 40)
    const w = bench.result().windows[0]!
    expect(w.medianMs).toBeLessThan(20)
    expect(w.p95Ms).toBeGreaterThan(30)
    expect(w.worstMs).toBeGreaterThanOrEqual(40)
  })

  it('checkpoints every closed window, so a killed tab still has its numbers', () => {
    const { host, clock, saved } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2,4,6'))
    run(bench, clock, 4.1)
    expect(saved.length).toBe(2) // two windows closed, two writes; the run itself never finished
    const parked = readSavedBench(saved[saved.length - 1]!)
    expect(parked?.events.complete).toBe(false) // truncated: the finding, not an error
    expect(parked?.windows).toHaveLength(2)
  })

  it('drives a deterministic orbit around the opening view', () => {
    const { host, clock, poses } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2'))
    run(bench, clock, 2.1)
    const radius = (p: BenchPose) => Math.hypot(p.px - p.tx, p.pz - p.tz)
    const last = poses[poses.length - 1]!
    // the camera moved, stayed on the same circle, and kept looking at the same target
    expect(last.px).not.toBeCloseTo(poses[0]!.px, 3)
    expect(radius(last)).toBeCloseTo(radius(poses[0]!), 6)
    expect(last.tx).toBe(host.startPose.tx)
    // and it is a pure function of elapsed time: same input, same pose
    expect(bench.poseAt(1.5)).toEqual(bench.poseAt(1.5))
  })

  it('marks a backgrounded run instead of banking the resume frame as jank', () => {
    let hidden = false
    const { host, clock } = makeHost({ hidden: () => hidden })
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=4'))
    run(bench, clock, 1)
    hidden = true
    run(bench, clock, 1)
    hidden = false
    clock.t += 30_000 // the tab was away; rAF resumes with one enormous interval
    bench.frame()
    run(bench, clock, 1.1)
    const r = bench.result()
    expect(r.events.backgrounded).toBe(true)
    expect(r.windows[0]!.worstMs).toBeLessThan(100) // the away-time never became a frame sample
  })

  it('differences the cumulative missed-frame counter per window', () => {
    const { host, clock, missFrame } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2,4'))
    run(bench, clock, 2.1)
    missFrame()
    missFrame()
    run(bench, clock, 2.1)
    const r = bench.result()
    expect(r.windows[0]!.missedFrames).toBe(0)
    expect(r.windows[1]!.missedFrames).toBe(2)
  })

  it('records the load cost separately from the measurement windows', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=3'))
    bench.noteCover(8400)
    run(bench, clock, 0.5, 120) // slow settling frames, inside the transient window
    run(bench, clock, 2.6, 16.7)
    const r = bench.result()
    expect(r.load.coverMs).toBe(8400)
    expect(r.load.transientWorstMs).toBeGreaterThanOrEqual(120)
  })

  it('carries the resolved config and a context loss into the blob', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2'))
    bench.noteContextLost()
    run(bench, clock, 2.1)
    const r = bench.result()
    expect(r.config.dprCap).toBe(1.5)
    expect(r.config.singlePassHonoured).toBe(false) // WebGPU ignores the tier's singlePass
    expect(r.events.contextLost).toBe(1)
    expect(r.workload).toMatchObject({ scene: 'demo', parts: 37, path: 'orbit', plannedSec: 2 })
  })
})

describe('readSavedBench', () => {
  it('rejects junk and foreign schema versions rather than mixing them in', () => {
    expect(readSavedBench(null)).toBeNull()
    expect(readSavedBench('not json')).toBeNull()
    expect(readSavedBench('{"v":2,"windows":[]}')).toBeNull()
    expect(readSavedBench('{"v":1,"windows":[]}')).not.toBeNull()
  })
})

describe('BenchRun instrumentation added after the first iPhone run', () => {
  it('reports a stall at full size, not at the view dt clamp', () => {
    // RenderView clamps the dt it hands onFrame to 100 ms, so a stall of any length would read out
    // as worstMs 100.0. The run must time its own frames, or every hitch measures the same.
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=4'))
    run(bench, clock, 1)
    clock.t += 850 // one long stall, well past the clamp but short of the resume guard
    bench.frame()
    run(bench, clock, 3.1)
    const w = bench.result().windows[0]!
    expect(w.worstMs).toBeCloseTo(850, 0)
    expect(bench.result().events.backgrounded).toBe(false) // a stall is jank, not a resume
  })

  it('reports the fastest frame, which is one refresh step', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=3'))
    run(bench, clock, 0.5, 8.3) // a one-step (120 Hz) stretch...
    run(bench, clock, 2.6, 25) // ...then a drop to three steps per frame
    const w = bench.result().windows[0]!
    expect(w.minMs).toBeCloseTo(8.3, 1)
    expect(w.medianMs).toBeCloseTo(25, 0) // the cadence it settled at, with the fast stretch still visible in minMs
  })

  it('timestamps a context loss and notes a restore', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=6'))
    run(bench, clock, 2)
    bench.noteContextLost()
    run(bench, clock, 1)
    bench.noteContextRestored()
    run(bench, clock, 3.1)
    const e = bench.result().events
    expect(e.contextLost).toBe(1)
    expect(e.contextLostAtSec).toBeGreaterThan(1.9)
    expect(e.contextLostAtSec).toBeLessThan(2.2)
    expect(e.contextRestored).toBe(true)
  })

  it('records when the first frame landed, so a null transient is explainable', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=6'))
    clock.t += 4000 // nothing rendered for 4 s after the run started (a load stall)
    run(bench, clock, 2.1)
    const load = bench.result().load
    expect(load.firstFrameAtSec).toBeGreaterThan(3.9)
    expect(load.transientWorstMs).toBeNull() // correctly null, and firstFrameAtSec says why
  })

  it('carries GPU residency per window, so a purge is attributable', () => {
    const { host, clock } = makeHost()
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2'))
    run(bench, clock, 2.1)
    const w = bench.result().windows[0]!
    expect(w.textures).toBe(53)
    expect(w.geometries).toBe(199)
  })
})

describe('createScreenWakeLock', () => {
  it('reports unavailable where the API is absent, instead of pretending', () => {
    // node, and equally a phone on a LAN dev server over plain http: no secure context, no API.
    // The run must say so - a slept screen otherwise produces a blob indistinguishable from a good one.
    expect(createScreenWakeLock().state()).toBe('unavailable')
  })

  it('releases the lock the moment the run finishes', () => {
    let released = 0
    const { host, clock } = makeHost({ onDone: () => released++ })
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2'))
    run(bench, clock, 1)
    expect(released).toBe(0)
    run(bench, clock, 1.2)
    expect(bench.complete).toBe(true)
    expect(released).toBe(1) // exactly once, not once per frame after completion
  })

  it('carries the lock state into the blob', () => {
    const { host, clock } = makeHost({ wakeLock: () => 'interrupted' })
    const bench = new BenchRun(host, readBenchParams('?bench&benchwin=2'))
    run(bench, clock, 2.1)
    expect(bench.result().events.wakeLock).toBe('interrupted')
  })
})
