// Drives a PlcLink from live scene IO, one call per tick. The only device IO is the device-IO tag bridge:
// custom-part behaviors write program inputs by name (fed in via `setExternalInputs`) and read the program
// outputs the host hands back after each scan. So this folds the external inputs into a frozen process
// image, runs one scan, and exposes %I/%Q for a monitor. It stays decoupled from the sim internals so the
// same controller works whether the logic is a local ST program or (later) a real PLC over WebSocket, and
// whoever hosts it: the sim worker's step loop (sim/plcHost.ts), or a test fake.

import type { PlcLink } from './link/plcLink'
import type { TagValue, TaskInfo } from './types'

/** A device-side process image: each tag's value at one scan boundary. */
export type ProcessImage = Readonly<Record<string, TagValue>>

/** The %I / %Q pair captured around one scan, for a monitor / IO-table view. */
export interface ProcessImageSnapshot {
  /** %I - device inputs latched at the top of the scan */
  inputs: ProcessImage
  /** %Q - outputs the scan resolved */
  outputs: ProcessImage
}

export class SimController {
  // the most recent process image (%I latched / %Q produced), for a monitor view
  #lastInputs: ProcessImage = {}
  #lastOutputs: ProcessImage = {}
  // device inputs supplied directly by name - the part→PLC half of a custom part's device-IO bus: the tags a
  // custom-part behavior wrote (ctx.writeTag/writeNumber), latched here by the controller each frame and folded
  // into the input image so the program reads them.
  #externalInputs: ProcessImage = {}

  constructor(private readonly link: PlcLink) {}

  /** snapshot of the program's variables, for a watch/monitor table */
  get watch(): Readonly<Record<string, TagValue>> {
    return this.link.watch
  }

  /** everything the controller holds, large arrays included - asked once, to save it (CompiledProgram.memory) */
  get memory(): Readonly<Record<string, TagValue>> {
    return this.link.memory ?? this.link.watch
  }

  /** The most recent device process image: %I latched before the last scan and the %Q it
   *  produced. Both empty until the first {@link tick}. For a monitor / IO-table view. */
  get processImage(): ProcessImageSnapshot {
    return { inputs: this.#lastInputs, outputs: this.#lastOutputs }
  }

  /**
   * Supply device inputs by tag name - the part→PLC half of a custom part's device-IO bus (the tags its
   * behavior wrote). Latched; folded into the next {@link sampleInputs}. Held as given, so the caller hands it over:
   * a fresh object it does not write again (the world's `behaviorTagWrites` builds one per step, as the output image
   * is built fresh per scan and handed on the same way).
   */
  setExternalInputs(tags: ProcessImage): void {
    this.#externalInputs = tags
  }

  sampleInputs(): ProcessImage {
    // the custom-part tag writes are the whole input image now (the declarative sensor/button bindings are gone).
    // Not copied: it is already frozen by the contract above, and the world's object is a dictionary-mode one (one
    // Object.assign per part), whose spread cost ~17 us a scan on a 77-tag line - more than the rest of the IO.
    return this.#externalInputs
  }

  /**
   * Solve the program for one scan against a frozen input image, advancing its internal
   * time (timers / counters / edge memory) by `dt` seconds. Returns the resulting output
   * image (%Q). Also records the %I/%Q for the watch.
   */
  scan(pii: ProcessImage, dt: number): Record<string, TagValue> {
    const piq = this.link.step(pii, dt)
    this.#lastInputs = pii
    this.#lastOutputs = piq
    return piq
  }

  /**
   * One control cycle: read inputs → scan. `dt` is the (fixed) scan period in seconds; drive it from a
   * {@link ScanEngine} so PLC timing holds its cycle time exactly. Returns the output image (%Q); the host
   * (sim/plcHost.ts) hands the resulting values to the world so custom-part behaviors read what the program
   * drove this scan.
   */
  tick(dt: number): Record<string, TagValue> {
    return this.scan(this.sampleInputs(), dt)
  }

  /** the controller's tasks; empty for one program on the host's scan time (what a TaskScheduler reads) */
  get tasks(): readonly TaskInfo[] {
    return this.link.tasks ?? []
  }

  /** {@link tick}, for one task of a controller: the same frozen input image, the same %I/%Q record */
  tickTask(index: number, dt: number): Record<string, TagValue> {
    if (!this.link.stepTask) throw new Error('this PLC link runs one program; it has no tasks to scan')
    const pii = this.sampleInputs()
    const stepTask = this.link.stepTask.bind(this.link)
    const piq = stepTask(index, pii, dt)
    this.#lastInputs = pii
    this.#lastOutputs = piq
    return piq
  }
}
