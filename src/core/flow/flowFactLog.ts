// The main thread's record of the current run's flow facts (core/flow/flowFacts.ts): the latest record per fact id, as the
// sim worker posted them, with a change counter a view can subscribe to.
//
// Modelled on the runtime part-diagnostics channel (core/parts/partDiagnostics.ts), with two differences. It is an object,
// owned by the SimClient that feeds it, not module state: facts belong to one run of one world. And a listener fires
// once per batch (one posted frame that carried facts), never per frame: the worker attaches facts to a frame only
// when its steps produced or updated one, so a run with nothing to report never wakes a view at all.
//
// Lifetime: kept after Stop, like a part's runtime diagnostics, so the run can be read once it is over; cleared when
// the next run starts.
import type { FlowFact } from './flowFacts'

export class FlowFactLog {
  private readonly byId = new Map<number, FlowFact>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshotRev = -1
  private snapshot: readonly FlowFact[] = []

  /** Take a batch from one posted frame: a fact seen before (a stall that ended, a flicker that repeated) replaces
   *  its earlier record. Notifies once for the batch; an empty batch changes nothing. */
  accept(facts: readonly FlowFact[]): void {
    if (facts.length === 0) return
    for (const f of facts) this.byId.set(f.id, f)
    this.bump()
  }

  /** Drop every fact (a new run starts). Notifies only when there was something to drop. */
  clear(): void {
    if (this.byId.size === 0) return
    this.byId.clear()
    this.bump()
  }

  /** Every fact, oldest id first: a stable array reference until the log changes, so a memo can key on it. */
  all(): readonly FlowFact[] {
    if (this.snapshotRev !== this.revision) {
      this.snapshot = [...this.byId.values()]
      this.snapshotRev = this.revision
    }
    return this.snapshot
  }

  get size(): number {
    return this.byId.size
  }

  /** The latest record of one fact. */
  get(id: number): FlowFact | undefined {
    return this.byId.get(id)
  }

  /** Monotonic change counter: the `getSnapshot` of a React external-store subscription. */
  rev(): number {
    return this.revision
  }

  /** Called after each change (a batch accepted, a clear). Returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private bump(): void {
    this.revision++
    for (const fn of this.listeners) fn()
  }
}
