// Worker-side PLC host: owns the compiled ST program while a scene runs and interleaves its
// fixed-period scans between the physics steps, entirely inside the sim worker. Each step the
// loop calls interleave() before world.step(): the scan reads the tags behaviors wrote on the
// previous step (%I), runs however many whole scan periods one step of sim time covers, and
// applies its outputs (%Q) so the very next step's behaviors read them. That is the same
// lockstep the headless project-test runner uses (editor/project/projectTestRunner.ts), so the live sim
// and the test harness share one interleave semantics.
//
// The scan accumulator is driven from the fixed step dt (sim time), not wall clock. So the scan/step
// interleave is exactly reproducible, immune to render frame rate, main-thread jank, and tab throttling,
// and a timeScale change scales PLC time with physics automatically (more steps per real second →
// proportionally more scans). A main-thread driver would sample inputs at whatever cadence rAF managed;
// this samples at the sim's own rate, the true information rate of the world. See src/plc/DEVICE-IO.md.

import { LocalPlcLink, SimController, TaskScheduler } from '../plc'
import type { RecordPatch } from './frameWire'
import type { Schedulable, TaskInfo, WiredBindings } from '../plc'
import type { TagValue } from '../plc'
import type { WatchLayout } from '../core/watchTable'
import type { WatchPlan } from '../plc/types'

/** The slice of SimWorld the host needs - narrow so tests can drive it with a stub. */
export interface PlcWorldPort {
  /** part→PLC: the tags behaviors wrote on the last step, flattened across parts (last wins) */
  behaviorTagWrites(): Record<string, number | boolean>
  /** PLC→part: hold the scan's output tags for behaviors to read on their next step */
  setBehaviorInputTags(tags: Record<string, number | boolean>): void
  /** physics steps taken so far: 0 means no part has published a tag yet (see {@link PlcHost.interleave}) */
  readonly stepCount: number
}

/** PLC state shipped with each worker frame, for the watch table / IO monitor / scan HUD. */
export interface PlcFrameState {
  /** every program variable (program-local names), for the watch table */
  watch: Readonly<Record<string, TagValue>>
  /** %I latched before the most recent scan */
  inputs: Readonly<Record<string, TagValue>>
  /** %Q the most recent scan resolved */
  outputs: Readonly<Record<string, TagValue>>
  scansRun: number
  overruns: number
  /** how long each task's scans take to execute, for the Watch dock's scan-time line */
  scanTimes: ScanTime[]
}

/**
 * One task's measured execution time: the real time its scans took on this machine, in ms. Its interval is sim time
 * and holds whatever this is (the scan interleaves with the physics steps), so a long scan slows the whole sim
 * rather than making the task late. It is the number to read when a program feels heavy.
 * The browser's clock has a 5 µs grain in a cross-origin isolated page, so a short scan's `lastMs` reads 0 or
 * 0.005; the average over many scans is finer than that.
 */
export interface ScanTime {
  /** the task's name; '' for a program with no tasks, which scans on the scan-time field */
  task: string
  kind: TaskInfo['kind']
  /** the task's interval in seconds; a continuous task runs once per physics step instead */
  periodSec: number
  /** scans timed since the program started, or since the last reset */
  scans: number
  lastMs: number
  avgMs: number
  maxMs: number
}

/** Running totals for one task's scans. */
interface ScanTally {
  scans: number
  totalMs: number
  lastMs: number
  maxMs: number
}
const emptyTally = (): ScanTally => ({ scans: 0, totalMs: 0, lastMs: 0, maxMs: 0 })

/**
 * Drop STRING-valued tags on the way to the world. Scene behaviours are driven by numbers
 * and booleans - a conveyor speed, a solenoid - and nothing in `core`/`sim` consumes text,
 * so a program's STRING variables are watch-table/display values only. Filtering here (at
 * the one boundary) keeps the simulation side numeric instead of threading `string` through
 * every behaviour that reads a tag.
 */
function driveable(tags: Record<string, TagValue>): Record<string, number | boolean> {
  // nearly always nothing to drop: then the image itself goes on (a scan's output image is built fresh and never
  // written after, and the world holds what it is handed by reference, read-only), instead of a copy per scan
  let strings = false
  for (const k in tags) if (typeof tags[k] === 'string') { strings = true; break }
  if (!strings) return tags as Record<string, number | boolean>
  const out: Record<string, number | boolean> = {}
  for (const [k, v] of Object.entries(tags)) if (typeof v !== 'string') out[k] = v
  return out
}

/** Most scans one physics step may drain. The UI floors the scan time at 1 ms (MIN_SCAN_MS),
 *  which needs ceil(16.7/1) = 17 per 60 Hz step - 64 leaves generous slack, while still
 *  bounding a pathological direct caller. Sim time can't backlog (each step adds exactly one
 *  step of it), so unlike a render-frame driver this cap never trips on a UI hitch.
 *  Per task, for a controller with several. */
export const MAX_SCANS_PER_STEP = 64

/** The shortest task interval the sim scans on time at `stepHz`. Anything shorter comes due faster than a step
 *  may drain it, so scans are dropped every few steps and the task's timers fall behind sim time. That is a pure
 *  function of the document, not of the machine (sim time can't backlog), so the Problems dock reports it before
 *  Run (editor/problems.ts). Only a TASK written in the program text can go below it: the scan-time field and the
 *  controller table both floor at 1 ms. */
export function shortestHeldIntervalSec(stepHz: number): number {
  return 1 / stepHz / MAX_SCANS_PER_STEP
}

/** How often the variable table rides a frame (see {@link PlcHost.snapshot}). Faster than anything reads it. */
export const WATCH_HZ = 10

/** {@link PlcFrameState} as a frame carries it: the variable table only on the frames that bring a new one. */
/** {@link PlcFrameWire} as a frame carries it: `inputs` and `outputs` only as far as they changed since the last
 *  frame (frameWire.ts RecordEncoder). One of the record, a patch on the last one, or its name in `ioKept`. */
export type PlcFrameSent = Omit<PlcFrameWire, 'inputs' | 'outputs'> & {
  inputs?: PlcFrameState['inputs']
  outputs?: PlcFrameState['outputs']
  ioKept?: ('inputs' | 'outputs')[]
  ioPatches?: Partial<Record<'inputs' | 'outputs', RecordPatch>>
}

export type PlcFrameWire = Omit<PlcFrameState, 'watch'> & {
  watch?: PlcFrameState['watch']
  /** in place of `watch`: a copy of the controller's memory, read through the layout its program sent (core/watchTable.ts) */
  watchBytes?: ArrayBuffer
  /** where the watch values are in `watchBytes`: sent once per program, with its first copy */
  watchLayout?: WatchLayout
  /** which attached program the table is of: the same number means the same keys (core/watchKeys.ts) */
  watchKeys?: number
}

export class PlcHost {
  readonly #link: LocalPlcLink
  readonly #ctl: SimController
  readonly #engine: TaskScheduler
  // one tally per task, or one for a program with no tasks; indexed as the scheduler numbers them
  #tallies: ScanTally[] = []

  /** Compile + attach a program. Throws StError on a compile error (the main thread validated
   *  the same source before shipping it, so a throw here is only a defensive backstop). */
  constructor(source: string, periodSec?: number, wired?: WiredBindings) {
    // the scene's bindings by wiring, computed where the scene is (editor/controller.ts runProgram)
    const link = new LocalPlcLink(source, wired)
    this.#link = link
    const ctl = new SimController(link)
    this.#ctl = ctl
    // the scheduler drives the controller through this, so each scan is timed where it runs
    const timed: Schedulable = {
      get tasks() {
        return ctl.tasks
      },
      tick: (dt) => {
        const t0 = performance.now()
        const out = ctl.tick(dt)
        this.#record(0, performance.now() - t0)
        return out
      },
      tickTask: (index, dt) => {
        const t0 = performance.now()
        const out = ctl.tickTask(index, dt)
        this.#record(index, performance.now() - t0)
        return out
      },
    }
    this.#engine = new TaskScheduler(timed, { ...(periodSec !== undefined ? { periodSec } : {}), maxCatchUp: MAX_SCANS_PER_STEP })
  }

  #record(index: number, ms: number): void {
    const t = (this.#tallies[index] ??= emptyTally())
    t.scans++
    t.totalMs += ms
    t.lastMs = ms
    if (ms > t.maxMs) t.maxMs = ms
  }

  /** Start the scan-time averages and maxima over (the Watch dock's Reset). The first scans include the engine
   *  warming up, so a maximum read after a reset is the steady one. */
  resetScanTimes(): void {
    this.#tallies = []
  }

  /** each task's {@link ScanTime}, in the controller's task order */
  scanTimes(): ScanTime[] {
    const tasks = this.#ctl.tasks
    const rows = tasks.length === 0 ? [{ task: '', kind: 'periodic' as const, periodSec: this.#engine.periodSec }] : tasks.map((t) => ({ task: t.name, kind: t.kind, periodSec: t.periodSec }))
    return rows.map((r, i) => {
      const t = this.#tallies[i] ?? emptyTally()
      return { ...r, scans: t.scans, lastMs: t.lastMs, avgMs: t.scans > 0 ? t.totalMs / t.scans : 0, maxMs: t.maxMs }
    })
  }

  /** Write one variable of the running program (a toggled bit); it shows in the next frame's watch. */
  force(name: string, value: TagValue): void {
    this.#link.force(name, value)
  }

  /** Hold variables at a value across scans until released (LocalPlcLink.setForces); the whole table each time. */
  setForces(forces: Readonly<Record<string, TagValue>>): void {
    this.#link.setForces(forces)
  }

  /** retune the cycle time live (the ST editor's scan-ms field); applies from the next step. A
   *  program with a CONFIGURATION ignores it: each of its tasks runs on its own interval. */
  setPeriod(periodSec: number): void {
    this.#engine.periodSec = periodSec
  }

  /** re-bind to the scene's wiring after an edit mid-run; the program keeps its variables, timers and scan phase */
  rebind(wired: WiredBindings): void {
    this.#link.bind(wired)
  }

  /** Write program variables by name before the next scan (an HMI's write, over the OPC UA server; LocalPlcLink.write). */
  write(values: Readonly<Record<string, TagValue>>): void {
    this.#link.write(values)
  }

  /**
   * One step's worth of control: latch %I from the world's last-step tag writes, drain the whole
   * scans `stepSec` of sim time covers (0..n - outputs hold between scans, like a real PLC), and
   * hand %Q back to the world for the step about to run. Call once per physics step, before
   * world.step().
   *
   * The first scan follows the parts' first step. Before a world has stepped, no part has published a tag, and a scan
   * then would read every input at its zero value: a normally-closed E-stop (TRUE = healthy) would read as struck on
   * scan 1 and latch the line on every Play. So on a world that has not stepped this does nothing (no scan, no PLC
   * time), and the parts take their first step on no PLC output, as at power-up. The first scan, before the second
   * step, sees what they published, by the same path as every scan after it. Our rule (IEC leaves when field inputs
   * are first valid to the implementation); a program attached to a world already running scans at once.
   * The project-test runner keeps the same rule (editor/project/projectTestRunner.ts).
   *
   * May throw an StError / StFault - a runtime fault (a subscript out of range, a division by zero, a
   * loop the watchdog would have caught) - the caller detaches the program and reports, mirroring a faulted PLC
   * dropping out of Run.
   */
  interleave(world: PlcWorldPort, stepSec: number): void {
    if (world.stepCount === 0) return
    const t0 = performance.now()
    this.#ctl.setExternalInputs(world.behaviorTagWrites())
    const t1 = performance.now()
    const { scans } = this.#engine.advance(stepSec)
    const t2 = performance.now()
    const p = this.perf
    p.inputsMs += t1 - t0
    p.scanMs += t2 - t1
    p.scans += scans
    if (scans === 0) return
    // The output image the scan itself produced (%Q: every VAR_OUTPUT and every output bound by wiring, fresh per
    // scan): what a part is commanded by, and all a field device sees of a real PLC. Not the whole variable table,
    // for two reasons. The contract: a scene that read an internal variable here would work against this PLC and
    // break against a real one over the wire, and in project tests, which hand parts the outputs alone
    // (editor/project/projectTestRunner.ts). checkWiring calls such a read `undriven`, "stays at its zero value", and here
    // it does. A part that should see a variable is wired to it, which binds it as an output (plc/wiring.ts
    // wiredBindings). And the cost: the table lists every array element and UDT member a program holds (thousands
    // of values for a large one). Rebuilt after every scan, it measured five times the scan's own cost on a large
    // line, and 38% of the demo's IEC program's PLC time. The table is for the watch views, and is built when a
    // frame carries one (snapshot()).
    world.setBehaviorInputTags(driveable(this.#ctl.processImage.outputs))
    p.imageMs += performance.now() - t2
  }

  /** cumulative split of interleave()'s cost (ms): latching the parts' tag writes in, the scans themselves, and
   *  handing the resulting image back to the world. Shipped as StepStats.plcSplit; window-diff like the rest. */
  readonly perf = { inputsMs: 0, scanMs: 0, imageMs: 0, scans: 0 }

  /** Where the watch table's values are in the controller's memory, when it is one buffer: a frame then carries a
   *  copy of the bytes and not the table (core/watchTable.ts). Null on the walker engine. */
  watchPlan(): WatchPlan | null {
    return this.#link.watchPlan()
  }

  /**
   * current PLC state for the frame payload (fresh objects - safe to structured-clone).
   *
   * `watch: false` leaves the variable table out ({@link PlcFrameWire}). It is by far the largest thing here (a real
   * program publishes five thousand values). Building it, cloning it across the thread boundary and collecting
   * it again on every frame would take a twelfth of the main thread's time for readers (the watch table, the rung
   * editor) that look eight times a second. The worker sends it at {@link WATCH_HZ}; the client keeps the last one.
   */
  snapshot(opts: { watch: false }): PlcFrameWire
  snapshot(opts?: { watch?: true }): PlcFrameState
  snapshot(opts?: { watch?: boolean }): PlcFrameWire {
    const { inputs, outputs } = this.#ctl.processImage
    return {
      ...(opts?.watch === false ? {} : { watch: this.#ctl.watch }),
      inputs,
      outputs,
      scansRun: this.#engine.scansRun,
      overruns: this.#engine.overruns,
      scanTimes: this.scanTimes(),
    }
  }
}
