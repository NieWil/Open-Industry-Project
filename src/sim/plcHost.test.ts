// The in-worker PLC scan host: fixed-period scans interleaved between fixed physics steps, driven
// by sim time (the step dt), never wall clock. These tests drive PlcHost against a stub world port
// exactly the way the worker loop does (interleave(port, 1/60) once per "step") and pin down the
// properties running in the worker gives: deterministic scan cadence, outputs holding between
// scans, one-step reaction latency, alias projection, and the faulted-PLC detach path.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SIM_HZ } from '../core/types'
import { StError } from '../plc'
import { controllerFor, runnableSource } from '../plc/controller'
import type { StFault } from '../plc'
import { PlcHost, shortestHeldIntervalSec } from './plcHost'
import type { PlcWorldPort } from './plcHost'

const STEP = 1 / DEFAULT_SIM_HZ

/** a stub SimWorld: behaviors "wrote" whatever the test staged; records every %Q push */
class StubPort implements PlcWorldPort {
  writes: Record<string, number | boolean> = {}
  pushes: Record<string, number | boolean>[] = []
  // a world whose parts have stepped, so every interleave scans (the hold before the first step has its own test)
  stepCount = 1
  behaviorTagWrites(): Record<string, number | boolean> {
    return { ...this.writes }
  }
  setBehaviorInputTags(tags: Record<string, number | boolean>): void {
    this.pushes.push(tags)
  }
  /** the values behaviors would read right now (last push, held) */
  get held(): Record<string, number | boolean> | undefined {
    return this.pushes[this.pushes.length - 1]
  }
}

const ECHO = `VAR_INPUT Go : BOOL; END_VAR
VAR_OUTPUT Run : BOOL; END_VAR
Run := Go;
`

describe('PlcHost interleave', () => {
  it('scan cadence is exact in sim time: N seconds of steps = N/period scans, any period', () => {
    for (const periodSec of [0.01, 0.05, 1 / 60]) {
      const host = new PlcHost(ECHO, periodSec)
      const port = new StubPort()
      const steps = DEFAULT_SIM_HZ * 2 // 2 sim-seconds
      for (let i = 0; i < steps; i++) host.interleave(port, STEP)
      // fixed-timestep draining: whole scans only, tracking sim time exactly (±1 for the residue)
      expect(Math.abs(host.snapshot().scansRun - Math.floor(2 / periodSec))).toBeLessThanOrEqual(1)
      expect(host.snapshot().overruns).toBe(0)
    }
  })

  it('is deterministic: two identical runs produce identical push sequences', () => {
    const run = (): string => {
      const host = new PlcHost(ECHO, 0.01)
      const port = new StubPort()
      for (let i = 0; i < 120; i++) {
        port.writes = { Go: i % 10 < 5 } // a 12 Hz square wave off the step index
        host.interleave(port, STEP)
      }
      return JSON.stringify(port.pushes)
    }
    expect(run()).toBe(run())
  })

  it('reacts one step later: a tag written on step N drives outputs before step N+1', () => {
    // scan faster than the step so every step drains at least one scan
    const host = new PlcHost(ECHO, 0.005)
    const port = new StubPort()
    host.interleave(port, STEP) // step 0: Go=false
    expect(port.held!.Run).toBe(false)
    port.writes = { Go: true } // behaviors set Go during step 0
    host.interleave(port, STEP) // scan before step 1 sees it
    expect(port.held!.Run).toBe(true)
  })

  it('hands the world the output image alone, in IEC too: an internal variable stays the program\'s, a wired one reaches the part', () => {
    // a field device only sees a real PLC's I/O, and project tests run this way (projectTestRunner.ts)
    const prog = `VAR_INPUT Go : BOOL; END_VAR
VAR_OUTPUT Run : BOOL; END_VAR
VAR Busy : BOOL; Lamp : BOOL; END_VAR
Busy := Go;
Lamp := Go;
Run := Go;
`
    const host = new PlcHost(prog, 0.005, { inputs: [], outputs: ['Lamp'] }) // a stack light wired to Lamp
    const port = new StubPort()
    port.writes = { Go: true }
    host.interleave(port, STEP)
    expect(port.held).toMatchObject({ Run: true, Lamp: true })
    expect(port.held).not.toHaveProperty('Busy')
    // the watch views still see every variable: they read the snapshot, not the parts' tag bus
    expect(host.snapshot().watch.Busy).toBe(true)
  })

  it('outputs hold between scans (period > step): pushes only on scan steps', () => {
    const host = new PlcHost(ECHO, 0.05) // 50 ms period = every 3rd 60 Hz step
    const port = new StubPort()
    for (let i = 0; i < 12; i++) host.interleave(port, STEP)
    // 12 steps = 200 ms = 4 scans -> 4 pushes, not 12 (the held values persist in between)
    expect(port.pushes.length).toBe(host.snapshot().scansRun)
    expect(port.pushes.length).toBe(4)
  })

  it('a fault throws out of interleave (the worker detaches on it), saying which fault it is', () => {
    const index = `VAR_INPUT D : INT; END_VAR
VAR_OUTPUT Q : INT; END_VAR
VAR a : ARRAY[0..3] OF INT; END_VAR
Q := a[D];
`
    const host = new PlcHost(index, 0.005)
    const port = new StubPort()
    port.writes = { D: 3 }
    host.interleave(port, STEP) // fine
    port.writes = { D: 4 }
    let fault: unknown = null
    try {
      host.interleave(port, STEP)
    } catch (e) {
      fault = e
    }
    expect(fault).toBeInstanceOf(StError)
    expect((fault as StFault).fault).toMatchObject({ name: 'array subscript out of range' })
  })

  it('a runtime scan fault throws StError out of interleave (the worker detaches on it)', () => {
    const div = `VAR_INPUT D : INT; END_VAR
VAR_OUTPUT Q : INT; END_VAR
Q := 10 / D;
`
    const host = new PlcHost(div, 0.005)
    const port = new StubPort()
    port.writes = { D: 5 }
    host.interleave(port, STEP) // fine
    port.writes = { D: 0 }
    expect(() => host.interleave(port, STEP)).toThrow(StError)
  })

  it("runs a CONFIGURATION's tasks at their own rates, whatever the scan-time field says", () => {
    const host = new PlcHost(
      `PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    TASK Slow(INTERVAL := T#50ms, PRIORITY := 2);
    PROGRAM FastCount WITH Fast : Counter;
    PROGRAM SlowCount WITH Slow : Counter;
  END_RESOURCE
END_CONFIGURATION`,
      0.1, // the scene's scan time: a controller's tasks carry their own
    )
    const port = new StubPort()
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) host.interleave(port, STEP) // one sim-second
    const { watch } = host.snapshot()
    expect(Math.abs((watch['FastCount.n'] as number) - 100)).toBeLessThanOrEqual(1)
    expect(Math.abs((watch['SlowCount.n'] as number) - 20)).toBeLessThanOrEqual(1)
    // and the qualified outputs reach the world, where a part reads them by that name
    expect(port.held!['SlowCount.n']).toBe(watch['SlowCount.n'])
  })

  it('holds a task at the shortest interval the step rate allows, and drops scans below it', () => {
    const counted = (interval: string): number => {
      const host = new PlcHost(`PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := ${interval}, PRIORITY := 1);
    PROGRAM FastCount WITH Fast : Counter;
  END_RESOURCE
END_CONFIGURATION`)
      const port = new StubPort()
      for (let i = 0; i < DEFAULT_SIM_HZ; i++) host.interleave(port, STEP) // one sim-second
      return host.snapshot().watch['FastCount.n'] as number
    }
    // the rule the Problems dock warns on, rounded up to a whole microsecond as its message rounds it
    // (written in fractional ms: the engine's TIME literals stop at ms)
    const shortestUs = Math.ceil(shortestHeldIntervalSec(DEFAULT_SIM_HZ) * 1e6)
    expect(Math.abs(counted(`T#${shortestUs / 1000}ms`) - Math.floor(1e6 / shortestUs))).toBeLessThanOrEqual(1)
    // below it the cap binds: one sim-second runs fewer scans than the interval asks for
    expect(counted(`T#${(shortestUs - 60) / 1000}ms`)).toBeLessThan(Math.floor(1e6 / (shortestUs - 60)) - 1)
  })

  it('snapshot carries the watch/process image the editor panels render', () => {
    const host = new PlcHost(ECHO, 0.005)
    const port = new StubPort()
    port.writes = { Go: true }
    host.interleave(port, STEP)
    const snap = host.snapshot()
    expect(snap.watch.Run).toBe(true)
    expect(snap.inputs.Go).toBe(true)
    expect(snap.outputs.Run).toBe(true)
    expect(snap.scansRun).toBeGreaterThan(0)
  })

  it('times every scan: one row for a program on the scan-time field, reset on request', () => {
    const host = new PlcHost(ECHO, 0.005)
    const port = new StubPort()
    for (let i = 0; i < 30; i++) host.interleave(port, STEP)
    const [row, ...rest] = host.snapshot().scanTimes
    expect(rest).toEqual([])
    expect(row).toMatchObject({ task: '', kind: 'periodic', periodSec: 0.005, scans: host.snapshot().scansRun })
    expect(row!.maxMs).toBeGreaterThanOrEqual(row!.avgMs)
    expect(row!.maxMs).toBeGreaterThanOrEqual(row!.lastMs)
    host.resetScanTimes()
    expect(host.snapshot().scanTimes[0]).toMatchObject({ scans: 0, lastMs: 0, avgMs: 0, maxMs: 0 })
  })

  it("times a CONFIGURATION's tasks each on their own, at their own intervals", () => {
    const host = new PlcHost(`PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    TASK Slow(INTERVAL := T#50ms, PRIORITY := 2);
    PROGRAM FastCount WITH Fast : Counter;
    PROGRAM SlowCount WITH Slow : Counter;
  END_RESOURCE
END_CONFIGURATION`)
    const port = new StubPort()
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) host.interleave(port, STEP) // one sim-second
    const { scanTimes, watch } = host.snapshot()
    expect(scanTimes.map((s) => [s.task.toUpperCase(), s.periodSec])).toEqual([
      ['FAST', 0.01],
      ['SLOW', 0.05],
    ])
    expect(scanTimes[0]!.scans).toBe(watch['FastCount.n'])
    expect(scanTimes[1]!.scans).toBe(watch['SlowCount.n'])
  })
})

describe('PlcHost: the first scan', () => {
  // a normally-closed E-stop: TRUE while healthy, and a trip that latches on the first FALSE it reads
  const ESTOP = `VAR_INPUT EStopOK : BOOL; END_VAR
VAR_OUTPUT Tripped : BOOL; END_VAR
IF NOT EStopOK THEN Tripped := TRUE; END_IF;
`

  it("waits for the parts' first step, so a normally-closed input reads TRUE on scan 1", () => {
    const host = new PlcHost(ESTOP, STEP)
    const port = new StubPort()
    port.stepCount = 0 // a world fresh from Play: no part has published yet
    host.interleave(port, STEP) // before step 0: nothing to read, so no scan and no PLC time
    expect(host.snapshot().scansRun).toBe(0)
    expect(port.pushes).toEqual([])
    port.stepCount = 1
    port.writes = { EStopOK: true } // the button published its closed contact during step 0
    host.interleave(port, STEP) // before step 1: scan 1
    expect(host.snapshot().scansRun).toBe(1)
    expect(host.snapshot().inputs).toEqual({ EStopOK: true })
    for (let i = 0; i < 10; i++) host.interleave(port, STEP)
    expect(port.held!.Tripped).toBe(false)
  })

  it('a program attached to a running world scans at once', () => {
    const host = new PlcHost(ESTOP, STEP)
    const port = new StubPort()
    port.stepCount = 120
    port.writes = { EStopOK: true }
    host.interleave(port, STEP)
    expect(host.snapshot().scansRun).toBe(1)
    expect(port.held!.Tripped).toBe(false)
  })
})

describe('PlcHost: a program wholly inside one PROGRAM', () => {
  // the composed source a scene runs (plc/controller.ts runnableSource with the default table): one instance, `Line`
  const SOURCE = `PROGRAM Line
VAR_INPUT Go : BOOL; END_VAR
VAR_OUTPUT Run : BOOL; END_VAR
VAR Lamp : BOOL; END_VAR
Run := Go;
Lamp := Go;
END_PROGRAM
`
  const WRAPPED = runnableSource(SOURCE, controllerFor(SOURCE, null, 5))

  it('answers to the bare names too: a part wired to Go / Run is connected, and so is one wired to Line.Go / Line.Run', () => {
    const host = new PlcHost(WRAPPED, 0.005)
    const port = new StubPort()
    port.writes = { Go: true } // a part wired to the bare name
    host.interleave(port, STEP)
    expect(port.held).toMatchObject({ Run: true, 'Line.Run': true })
    port.writes = { 'Line.Go': false } // a part wired to the qualified name, as before
    host.interleave(port, STEP)
    expect(port.held).toMatchObject({ Run: false, 'Line.Run': false })
    // the watch table keeps the program's own names: one row per variable
    expect(Object.keys(host.snapshot().watch)).toEqual(['Line.Go', 'Line.Run', 'Line.Lamp'])
  })

  it('binds a plain VAR by wiring under its bare name', () => {
    const host = new PlcHost(WRAPPED, 0.005, { inputs: [], outputs: ['Lamp'] }) // a stack light wired to Lamp
    const port = new StubPort()
    port.writes = { Go: true }
    host.interleave(port, STEP)
    expect(port.held!.Lamp).toBe(true)
  })
})

describe('PlcHost: a program bound by wiring', () => {
  // plain VARs: no direction of their own, so without the scene's bindings the eye never reaches the program
  const PLAIN = 'VAR Eye : BOOL; Run : BOOL; END_VAR\nRun := NOT Eye;\n'

  it('writes a wired input into a plain VAR and returns the wired output; unbound, the VAR stays internal', () => {
    const run = (host: PlcHost): number | boolean | undefined => {
      const port = new StubPort()
      port.writes = { Eye: true }
      host.interleave(port, STEP)
      return port.held!['Run']
    }
    const unbound = new PlcHost(PLAIN, 0.005)
    expect(run(unbound)).toBeUndefined() // unbound, Run is the program's own variable: no part sees it
    expect(unbound.snapshot().watch['Run']).toBe(true) // and the eye never got in
    const bound = new PlcHost(PLAIN, 0.005, { inputs: ['Eye'], outputs: ['Run'] })
    expect(run(bound)).toBe(false)
    const { inputs, outputs } = bound.snapshot()
    expect([inputs, outputs]).toEqual([{ Eye: true }, { Run: false }])
  })

  it('re-binds in place when the scene is rewired mid-run, keeping the variables and timers it has', () => {
    // a counter that must survive the rebind, and an eye wired only after the program started
    const src = 'VAR Eye : BOOL; Run : BOOL; n : INT; END_VAR\nn := n + 1;\nRun := NOT Eye;\n'
    const host = new PlcHost(src, STEP, { inputs: [], outputs: ['Run'] })
    const port = new StubPort()
    port.writes = { Eye: true }
    for (let i = 0; i < 10; i++) host.interleave(port, STEP)
    expect(port.held!['Run']).toBe(true) // the eye is not wired yet
    const before = host.snapshot().watch['n'] as number
    host.rebind({ inputs: ['Eye'], outputs: ['Run'] })
    host.interleave(port, STEP)
    expect(port.held!['Run']).toBe(false)
    expect(host.snapshot().watch['n']).toBe(before + 1) // one more scan, not a fresh program
  })
})

describe('what the world is handed of the output image', () => {
  const TEXT = `VAR_INPUT Go : BOOL; END_VAR
VAR_OUTPUT Run : BOOL; Label : STRING; Count : INT; END_VAR
Run := Go;
IF Go THEN Label := 'running'; Count := Count + 1; ELSE Label := 'stopped'; END_IF;
`

  it('is the same table while no output changes, and a new one when one does, never with a STRING in it', () => {
    const host = new PlcHost(TEXT, 0.005)
    const port = new StubPort()
    for (let i = 0; i < 4; i++) host.interleave(port, STEP)
    const idle = port.held!
    expect(idle).toEqual({ Run: false, Count: 0 })
    expect(port.pushes[port.pushes.length - 2]).toBe(idle)
    port.writes = { Go: true }
    host.interleave(port, STEP)
    const running = port.held!
    expect(running).not.toBe(idle)
    expect(running['Run']).toBe(true)
    expect('Label' in running).toBe(false)
    expect(idle).toEqual({ Run: false, Count: 0 }) // the table handed before was not written over
    port.writes = { Go: false }
    host.interleave(port, STEP)
    const count = port.held!['Count']
    host.interleave(port, STEP)
    host.interleave(port, STEP)
    expect(port.held).toEqual({ Run: false, Count: count })
    expect(port.pushes[port.pushes.length - 2]).toBe(port.held)
  })

  it('hands the image itself on when it holds no STRING', () => {
    const host = new PlcHost(ECHO, 0.005)
    const port = new StubPort()
    host.interleave(port, STEP)
    expect(port.held).toBe(host.snapshot().outputs)
  })
})
