import { describe, expect, it } from 'vitest'
import { LocalPlcLink } from './link/plcLink'
import {
  DEFAULT_MAX_CATCHUP_SCANS,
  DEFAULT_SCAN_PERIOD_SEC,
  OVERRUN_SUSTAIN_FRAMES,
  type Scannable,
  ScanEngine,
} from './scanEngine'
import { SimController } from './simController'

/** Records the dt of every scan it is asked to run. */
class RecordingScannable implements Scannable {
  readonly dts: number[] = []
  tick(dt: number): void {
    this.dts.push(dt)
  }
}

describe('ScanEngine fixed timestep', () => {
  it('runs floor(elapsed / period) scans and carries the remainder', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01 })

    expect(eng.advance(0.035)).toEqual({ scans: 3, overrun: false }) // 0.035 -> 3 scans, 0.005 left
    expect(eng.advance(0.01)).toEqual({ scans: 1, overrun: false }) // 0.005 + 0.01 = 0.015 -> 1 scan
    expect(s.dts).toHaveLength(4)
  })

  it('always scans with exactly the fixed period, never the frame dt', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01 })
    eng.advance(0.016) // a 60 fps frame
    eng.advance(0.033) // a 30 fps frame
    expect(s.dts.every((dt) => dt === 0.01)).toBe(true)
  })

  it('accrues sub-period frames until a whole scan is due', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01 })
    expect(eng.advance(0.004).scans).toBe(0) // not enough yet
    expect(eng.advance(0.004).scans).toBe(0) // 0.008, still short
    expect(eng.advance(0.004).scans).toBe(1) // 0.012 -> one scan, 0.002 carried
  })

  it('tracks wall-clock over many frames regardless of frame pacing (within the catch-up budget)', () => {
    const even = new RecordingScannable()
    const jittery = new RecordingScannable()
    // budget high enough to absorb the biggest ragged frame (0.3 s = 30 scans) without shedding
    const a = new ScanEngine(even, { periodSec: 0.01, maxCatchUp: 64 })
    const b = new ScanEngine(jittery, { periodSec: 0.01, maxCatchUp: 64 })
    // both advance the same 1.0 s total, one steadily, one in ragged frames
    for (let i = 0; i < 100; i++) a.advance(0.01)
    for (const dt of [0.05, 0.003, 0.2, 0.007, 0.04, 0.1, 0.3, 0.1, 0.097, 0.103]) b.advance(dt)
    expect(even.dts).toHaveLength(100)
    expect(jittery.dts).toHaveLength(100) // same scan count for the same elapsed time
  })

  it('clamps catch-up and sheds backlog on a long stall (overrun)', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01, maxCatchUp: 4 })
    const r = eng.advance(1.0) // 100 scans due, but capped
    expect(r).toEqual({ scans: 4, overrun: true }) // the mechanical per-frame shed still fires
    expect(s.dts).toHaveLength(4)
    // ...but a single isolated shed is not a reported task overrun (a one-off hitch), so the
    // cumulative telemetry stays at 0 - only sustained shedding counts (see the next test).
    expect(eng.overruns).toBe(0)
    // backlog was shed: the next normal frame starts clean, no lingering burst
    expect(eng.advance(0.01)).toEqual({ scans: 1, overrun: false })
  })

  it('a one-off frame hitch (e.g. selecting a part) sheds but is not a reported overrun', () => {
    // selecting a part while running compiles its selection-outline pipeline for a
    // single frame; that lone slow frame inflates the next frame's sim-clock delta past the
    // catch-up budget. The backlog is shed (correct), but it must not be reported as a task
    // overrun or the PLC panel falsely warns "raise your scan time".
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01, maxCatchUp: 4 })
    for (let i = 0; i < 5; i++) eng.advance(0.01) // steady 100 Hz frames, keeping up
    expect(eng.advance(1.0).overrun).toBe(true) // the one-frame hitch sheds backlog
    for (let i = 0; i < 5; i++) eng.advance(0.01) // and we're back to keeping up
    expect(eng.overruns).toBe(0) // no false task overrun from the isolated hitch
  })

  it('reports a *sustained* inability to hold the period as a task overrun', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01, maxCatchUp: 4 })
    // every frame sheds (the logic genuinely can't keep up): the run past OVERRUN_SUSTAIN_FRAMES
    // starts counting. With the threshold at 3, frames 3..8 count -> 6 reported overruns.
    for (let i = 0; i < 8; i++) expect(eng.advance(1.0).overrun).toBe(true)
    expect(eng.overruns).toBe(8 - (OVERRUN_SUSTAIN_FRAMES - 1))
    // a frame that keeps up resets the run, so the next isolated shed doesn't immediately re-count
    eng.advance(0.01)
    const afterRecover = eng.overruns
    expect(eng.advance(1.0).overrun).toBe(true)
    expect(eng.overruns).toBe(afterRecover) // lone shed after recovery isn't reported
  })

  it('reset() drops accrued time so there is no catch-up burst after a gap', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01 })
    eng.advance(0.007) // partial period accrued
    eng.reset()
    expect(eng.advance(0.005).scans).toBe(0) // the 0.007 was dropped, 0.005 alone is short
  })

  it('retunes the cycle time live via periodSec', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s, { periodSec: 0.01 })
    eng.advance(0.02) // 2 scans at 10 ms
    eng.periodSec = 0.005
    eng.advance(0.02) // 4 scans at 5 ms
    expect(s.dts).toEqual([0.01, 0.01, 0.005, 0.005, 0.005, 0.005])
    expect(eng.periodSec).toBe(0.005)
  })

  it('counts cumulative scans and exposes sensible defaults', () => {
    const s = new RecordingScannable()
    const eng = new ScanEngine(s)
    expect(eng.periodSec).toBe(DEFAULT_SCAN_PERIOD_SEC)
    eng.advance(DEFAULT_SCAN_PERIOD_SEC * 3)
    expect(eng.scansRun).toBe(3)
    expect(DEFAULT_MAX_CATCHUP_SCANS).toBeGreaterThanOrEqual(1)
  })

  it('rejects a non-positive period', () => {
    const s = new RecordingScannable()
    expect(() => new ScanEngine(s, { periodSec: 0 })).toThrow()
    const eng = new ScanEngine(s)
    expect(() => (eng.periodSec = -1)).toThrow()
  })
})

// A one-input holder feeding the `Go` tag over the device-IO bridge (setExternalInputs); everything else is
// inert. The integration test below proves the engine gives a real ST timer frame-rate-independent timing
// through the full SimController process-image path.
class StubIo {
  pressed = false
}

describe('ScanEngine + SimController (process image, fixed timing)', () => {
  // a 100 ms on-delay: Lamp lights once Go has been held for PT
  const PROGRAM =
    'VAR_INPUT Go : BOOL; END_VAR VAR_OUTPUT Lamp : BOOL; END_VAR VAR d : TON; END_VAR\n' +
    'd(IN := Go, PT := T#0.1s);\nLamp := d.Q;'
  const makeCtrl = (io: StubIo) => {
    const ctrl = new SimController(new LocalPlcLink(PROGRAM))
    ctrl.setExternalInputs({ Go: io.pressed })
    return ctrl
  }

  it('a TON fires after the same wall-clock time however the frames are chunked', () => {
    const smooth = new StubIo()
    const ragged = new StubIo()
    smooth.pressed = ragged.pressed = true
    const ctrlA = makeCtrl(smooth)
    const ctrlB = makeCtrl(ragged)
    const engA = new ScanEngine(ctrlA, { periodSec: 0.01 })
    const engB = new ScanEngine(ctrlB, { periodSec: 0.01 })

    // ~90 ms of smooth 60 fps frames vs. two ragged frames: neither has reached PT=100 ms
    for (let i = 0; i < 6; i++) engA.advance(0.015)
    engB.advance(0.05)
    engB.advance(0.04)
    expect(ctrlA.watch.Lamp).toBe(false)
    expect(ctrlB.watch.Lamp).toBe(false)

    // carry both well past 100 ms total (to ~150 ms) - the timer has latched regardless of
    // how the elapsed time was chopped into frames
    for (let i = 0; i < 4; i++) engA.advance(0.015)
    engB.advance(0.06)
    expect(ctrlA.watch.Lamp).toBe(true)
    expect(ctrlB.watch.Lamp).toBe(true)
  })

  it('exposes the latched %I and resolved %Q as the process image', () => {
    const io = new StubIo()
    io.pressed = true
    const ctrl = makeCtrl(io)
    const eng = new ScanEngine(ctrl, { periodSec: 0.01 })
    eng.advance(0.01)
    expect(ctrl.processImage.inputs).toEqual({ Go: true }) // %I latched from the device
    expect(ctrl.processImage.outputs).toHaveProperty('Lamp') // %Q produced by the scan
  })
})
