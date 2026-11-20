// The attached custom-part behaviors and the bus they talk over: the behavior records in attach order (the order
// tickBehaviors runs them in), the PLC->part tag table and output ownership, pending "use" clicks, and every
// conveying part's commanded speed (the spawner interlock's source). SimWorld owns one; its tickBehaviors drives
// the records through it each step.
import * as behavior from './embeddedBehavior'
import { flatRecEq } from './worldTypes'
import type { BehaviorRecord } from './worldTypes'

export class BehaviorBus {
  // custom-part behavior scripts (src/sim/embeddedBehavior.ts) driving a deck's surface velocity each
  // tick. Each holds a mutable `linear` ConveyorEntry that the contact listener reads live. Attach order is run order.
  readonly behaviors: BehaviorRecord[] = []
  // PLC→part device-IO bus: the latest tag values behaviors read. Two writers fill it: the program in the worker,
  // each scan (setInputTags), and the links to PLCs outside the app, from the main thread (setLinkTags). A run can
  // have both, the program for the default controller's tags and a named controller's link for `Cell2::...` ones
  // (core/io/controllerTag.ts), so each keeps its own layer and neither replaces the other's.
  private programTags: Record<string, number | boolean> = {}
  private linkTags: Record<string, number | boolean> = {}
  private inputTags: Record<string, number | boolean> = {}
  // Output ownership (ctx.tagDriven): tag keys the attached controller drives (its program outputs), pushed
  // once on attach / cleared on detach. Values are just `true`: behaviors read it with the same lookup as
  // the value table.
  private drivenTags: Record<string, number | boolean> = {}
  // C-interaction: part ids "used" since the last tick; tickBehaviors delivers ctx.used()=true once, then clears.
  private readonly pendingUse = new Set<string>()
  /** part id -> the conveyor's current commanded speed (m/s), for spawner interlocks. Kept
   *  current via buildPart/destroyPart: a PLC speed change rewrites the conveyor's params,
   *  which changes its partSignature and rebuilds it through this same path. Read anywhere; written only here. */
  readonly conveyorSpeeds = new Map<string, number>()
  // tickBehaviors' per-tick snapshot of conveyorSpeeds, rebuilt only when a speed changed (bumps the rev). Running
  // conveyors hold their speed most ticks, and rebuilding it every tick would be the largest cost of tickBehaviors' own
  // (profiled at 1000 Hz). A rebuild is always a new object, so behaviors holding the old one by reference
  // (embeddedBehavior's inConveyorSpeeds ref-swap) never see it change under them.
  private conveyorSpeedsRev = 0
  private conveyorSnapshotRev = -1
  private conveyorSnapshot: Record<string, number> | undefined = undefined

  /** attach a record; it runs after every record attached before it */
  add(rec: BehaviorRecord): void {
    this.behaviors.push(rec)
  }

  /** the record attached last (a builder tags the one it just attached with its part id) */
  last(): BehaviorRecord | undefined {
    return this.behaviors[this.behaviors.length - 1]
  }

  /** PLC→part: hold the latest ST tag values so the next tick feeds them to behaviors as inputs.
   *  Value-diffed: a push that changes nothing keeps the current table object. That matters because
   *  behaviors hold tag tables by reference (embeddedBehavior ref-swaps cur/prev, so replacing the object
   *  is the change signal). */
  setInputTags(tags: Record<string, number | boolean>): void {
    if (flatRecEq(this.programTags, tags)) return
    this.programTags = tags
    this.joinInputs()
  }

  /** PLC→part from the links to PLCs outside the app: every tag they drive, as last written. Value-diffed the same way. */
  setLinkTags(tags: Record<string, number | boolean>): void {
    if (flatRecEq(this.linkTags, tags)) return
    this.linkTags = tags
    this.joinInputs()
  }

  /** The table behaviors read: one layer as it is when the other is empty (the usual run, and no copy), else both. */
  private joinInputs(): void {
    if (Object.keys(this.linkTags).length === 0) this.inputTags = this.programTags
    else if (Object.keys(this.programTags).length === 0) this.inputTags = this.linkTags
    else this.inputTags = { ...this.programTags, ...this.linkTags }
  }

  /** the tag table the current tick hands every behavior */
  get tags(): Record<string, number | boolean> {
    return this.inputTags
  }

  /** Output ownership: hold the global tag keys the attached controller drives (ctx.tagDriven). */
  setDrivenTags(tags: string[]): void {
    const rec: Record<string, number | boolean> = {}
    for (const t of tags) rec[t] = true
    this.drivenTags = rec
  }

  /** the driven-key table the current tick hands every behavior */
  get driven(): Record<string, number | boolean> {
    return this.drivenTags
  }

  /** part→PLC: the tags behaviors wrote on the last step, flattened across parts in attach order, last wins,
   *  partId-gated (SimWorld.behaviorTagWrites) */
  tagWrites(): Record<string, number | boolean> {
    const flat: Record<string, number | boolean> = {}
    for (const b of this.behaviors) if (b.partId && b.tags) Object.assign(flat, b.tags)
    return flat
  }

  /** C-interaction: register a "use" on a part; wasUsed reads true for it on the next tick */
  use(partId: string): void {
    this.pendingUse.add(partId)
  }

  wasUsed(partId: string): boolean {
    return this.pendingUse.has(partId)
  }

  /** end of a tick: each "use" pulses ctx.used() for exactly the tick after the click */
  clearUses(): void {
    this.pendingUse.clear()
  }

  /** Record a part's commanded conveyor speed; the snapshot behaviors read is rebuilt only when one changes. */
  setConveyorSpeed(id: string, v: number): void {
    if (Object.is(this.conveyorSpeeds.get(id), v)) return
    this.conveyorSpeeds.set(id, v)
    this.conveyorSpeedsRev++
  }

  /** a speed-bearing part no longer exists to interlock against */
  deleteConveyorSpeed(id: string): void {
    if (this.conveyorSpeeds.delete(id)) this.conveyorSpeedsRev++
  }

  /** every conveying part's commanded speed as one object, the same object until a speed changes; undefined ⇒ no
   *  conveyors */
  speedSnapshot(): Record<string, number> | undefined {
    if (this.conveyorSnapshotRev !== this.conveyorSpeedsRev) {
      this.conveyorSnapshot = this.conveyorSpeeds.size ? Object.fromEntries(this.conveyorSpeeds) : undefined
      this.conveyorSnapshotRev = this.conveyorSpeedsRev
    }
    return this.conveyorSnapshot
  }

  /** destroy these behavior instances and drop their records (their part is rebuilt or deleted) */
  remove(recs: readonly BehaviorRecord[]): void {
    const gone = new Set(recs)
    for (const b of recs) behavior.destroy(b.handle)
    let n = 0
    for (const b of this.behaviors) if (!gone.has(b)) this.behaviors[n++] = b
    this.behaviors.length = n
  }

  /** destroy every behavior instance and drop the records (the world is going) */
  destroyAll(): void {
    for (const b of this.behaviors) behavior.destroy(b.handle)
    this.behaviors.length = 0
  }
}
