// The controllers the simulator runs, each its own program on its own memory and I/O (plc/controller.ts
// controllerRuns). The default controller's host reads and writes the parts' tags as they are. Another one's reads the
// tags that name it (`Cell2::%IX0.0`) with the name taken off, so its program sees %IX0.0, and its outputs go back to
// the parts with the name put on. Their outputs are one table the parts read (sim/behaviorBus.ts), as one program's are.
//
// Every host interleaves its scans on the same step, so two controllers keep the lockstep one does (PlcHost). The
// variables of every host are one watch table, keyed as the organizer names them: an instance's variables by the
// instance (`LineB.Run`), which are unique across controllers. A force or a write goes to the host that runs the
// instance it names, and anything else to the default controller.

import { CONTROLLER_SEP, tagsForController } from '../core/io/controllerTag'
import type { TagValue, WiredBindings } from '../plc'
import type { WatchPlan } from '../plc/types'
import { PlcHost } from './plcHost'
import type { PlcFrameState, PlcFrameWire, PlcWorldPort, ScanTime } from './plcHost'

/** One controller's program as the worker is sent it. */
export interface PlcRun {
  /** the controller's name; null for the default one */
  controller: string | null
  source: string
  periodSec?: number
  wired?: WiredBindings
  /** the program instances it runs, which own the variables named `Instance.Name` */
  instances?: readonly string[]
}

interface Member {
  controller: string | null
  host: PlcHost
  /** instance names, upper-cased, for routing a variable's name to this host */
  owns: ReadonlySet<string>
  port: PlcWorldPort
  /** its last outputs, with its name put on; null for the default host, whose outputs go on as they are */
  out: Record<string, number | boolean>
}

/** `tags` with `controller`'s name put on every key. */
function prefixed(tags: Readonly<Record<string, TagValue>>, controller: string): Record<string, TagValue> {
  const out: Record<string, TagValue> = {}
  for (const k in tags) out[controller + CONTROLLER_SEP + k] = tags[k]!
  return out
}

export class PlcGroup {
  readonly #members: Member[]
  // the world of the step being interleaved, and its tag writes, read once for every host
  #world: PlcWorldPort | null = null
  #writes: Record<string, number | boolean> | null = null
  #dirty = false

  /** Compile and attach every controller's program. Throws as PlcHost does, the error naming its controller. */
  constructor(runs: readonly PlcRun[]) {
    this.#members = runs.map((r) => {
      const host = faultsNamed(r.controller, () => new PlcHost(r.source, r.periodSec, r.wired))
      const m: Member = { controller: r.controller, host, owns: new Set((r.instances ?? []).map((n) => n.toUpperCase())), port: null!, out: {} }
      m.port = this.#portFor(m)
      return m
    })
  }

  /** The port a host reads and writes the world through: its own tags in, its outputs collected for the merge. */
  #portFor(m: Member): PlcWorldPort {
    const world = (): PlcWorldPort => this.#world!
    return {
      behaviorTagWrites: () => {
        const all = (this.#writes ??= world().behaviorTagWrites())
        return m.controller === null ? all : tagsForController(all, m.controller)
      },
      setBehaviorInputTags: (tags) => {
        m.out = m.controller === null ? tags : (prefixed(tags, m.controller) as Record<string, number | boolean>)
        this.#dirty = true
      },
      get stepCount() {
        return world().stepCount
      },
    }
  }

  /** The default controller's host. Absent while a PLC outside the app runs the default controller and the group holds
   *  only the others (editor/controller/program.ts), so nothing may take the first member for it. */
  get #main(): Member | undefined {
    return this.#members.find((m) => m.controller === null)
  }

  /** The host that runs the instance `name` is in, or the default controller's, or (with no default here) the first. */
  #ownerOf(name: string): Member {
    const instance = name.split('.')[0]!.toUpperCase()
    return this.#members.find((m) => m.controller !== null && m.owns.has(instance)) ?? this.#main ?? this.#members[0]!
  }

  /** `values` split by the host each name goes to. */
  #split<V>(values: Readonly<Record<string, V>>): Map<Member, Record<string, V>> {
    const out = new Map<Member, Record<string, V>>(this.#members.map((m) => [m, {}]))
    for (const [k, v] of Object.entries(values)) out.get(this.#ownerOf(k))![k] = v
    return out
  }

  /** One step's scans on every controller (PlcHost.interleave), their outputs handed to the world as one table. */
  interleave(world: PlcWorldPort, stepSec: number): void {
    // one default host reads and writes the world as it is; any other needs its port, which puts its name on
    if (this.#members.length === 1 && this.#members[0]!.controller === null) return this.#members[0]!.host.interleave(world, stepSec)
    this.#world = world
    this.#writes = null
    this.#dirty = false
    for (const m of this.#members) faultsNamed(m.controller, () => m.host.interleave(m.port, stepSec))
    if (!this.#dirty) return
    const merged: Record<string, number | boolean> = {}
    for (const m of this.#members) Object.assign(merged, m.out)
    world.setBehaviorInputTags(merged)
  }

  get perf(): PlcHost['perf'] {
    const sum = { inputsMs: 0, scanMs: 0, imageMs: 0, scans: 0 }
    for (const m of this.#members) for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += m.host.perf[k]
    return sum
  }

  force(name: string, value: TagValue): void {
    this.#ownerOf(name).host.force(name, value)
  }

  setForces(forces: Readonly<Record<string, TagValue>>): void {
    for (const [m, own] of this.#split(forces)) m.host.setForces(own)
  }

  write(values: Readonly<Record<string, TagValue>>): void {
    for (const [m, own] of this.#split(values)) if (Object.keys(own).length > 0) m.host.write(own)
  }

  /** The scan-time field: the default controller's program with no tasks of its own scans on it. */
  setPeriod(periodSec: number): void {
    this.#main?.host.setPeriod(periodSec)
  }

  /** Re-bind one controller's program to the scene's wiring (null: the default one). */
  rebind(wired: WiredBindings, controller: string | null = null): void {
    this.#members.find((m) => m.controller === controller)?.host.rebind(wired)
  }

  resetScanTimes(): void {
    for (const m of this.#members) m.host.resetScanTimes()
  }

  /** Every controller's tasks, another controller's named `Cell2::Task`. */
  scanTimes(): ScanTime[] {
    return this.#members.flatMap((m) => m.host.scanTimes().map((t) => (m.controller === null ? t : { ...t, task: m.controller + CONTROLLER_SEP + (t.task || 'Main') })))
  }

  /** Where the watch table's values are in memory (PlcHost.watchPlan), when one default controller is all there is:
   *  several controllers' tables are merged by name, which is a table's work. */
  watchPlan(): WatchPlan | null {
    const main = this.#main
    return main && this.#members.length === 1 ? main.host.watchPlan() : null
  }

  /** One frame's PLC state for every controller: one watch table, and the process images with each name put on. */
  snapshot(opts: { watch: false }): PlcFrameWire
  snapshot(opts?: { watch?: true }): PlcFrameState
  snapshot(opts?: { watch?: boolean }): PlcFrameWire {
    const main = this.#main
    const shot = (h: PlcHost): PlcFrameWire => (opts?.watch === false ? h.snapshot({ watch: false }) : h.snapshot())
    if (main && this.#members.length === 1) return shot(main.host)
    const shots = this.#members.map((m) => ({ m, s: shot(m.host) }))
    // the default controller's images go on as they are, another's with its name put on
    const named = (m: Member, tags: Readonly<Record<string, TagValue>>): Record<string, TagValue> => (m.controller === null ? { ...tags } : prefixed(tags, m.controller))
    const others = shots.filter(({ m }) => m !== main)
    const own = shots.find(({ m }) => m === main)?.s
    return {
      // the default controller's own names win over another's copy of the same top-level variable
      ...(shots[0]!.s.watch ? { watch: Object.assign({}, ...others.map(({ s }) => s.watch), own?.watch ?? {}) as PlcFrameState['watch'] } : {}),
      inputs: Object.assign({}, ...shots.map(({ m, s }) => named(m, s.inputs))),
      outputs: Object.assign({}, ...shots.map(({ m, s }) => named(m, s.outputs))),
      // the scans the frame counts are the default controller's, or the first one's when a PLC outside runs the default
      scansRun: (own ?? shots[0]!.s).scansRun,
      overruns: shots.reduce((n, { s }) => n + s.overruns, 0),
      scanTimes: this.scanTimes(),
    }
  }
}

/** Run `fn`, putting the controller's name before the message of anything it throws, so a fault says whose it was. */
function faultsNamed<T>(controller: string | null, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    // defineProperty, not assignment: under lockdown Error.prototype is frozen, and assigning a property it has throws
    if (controller !== null && e instanceof Error) {
      try {
        Object.defineProperty(e, 'message', { value: `${controller}: ${e.message}` })
      } catch {
        // a frozen error keeps its own message: the fault still stops the run, unnamed
      }
    }
    throw e
  }
}
