// Runtime diagnostics channel for custom parts. Build-time problems have their own typed surface
// (sim/validatePart.ts). This one records runtime problems that would otherwise be silent: a step() that
// throws, a geometry() that throws (the host falls back), and a behavior commanding a joint/lamp the rig
// doesn't have. Entries are keyed by the placed part instance and deduplicated (a throwing step() repeats
// 60×/s: one entry, a bumped count). The editor observes them (console + Inspector) without the sim
// touching the DOM.
//
// core-pure and dependency-free: hosts (sim/world.ts, core/geometry/geometryEval.ts) report; the editor
// subscribes. Listeners fire only when a new unique diagnostic appears. Count bumps are silent, so a
// per-tick error can never flood the UI.

export type PartDiagnosticSource =
  | 'compile' // the behavior source failed to load (determinism scan, syntax error, no definePart call)
  | 'step' // step()/init() threw while the sim ran (the host keeps the last tick's output)
  | 'geometry' // geometry() threw or exceeded the vertex budget (the host falls back to manifest geometry)
  | 'unknown-name' // the behavior commanded a joint/gripper/lamp/subpose name the rig doesn't declare
  | 'fit' // the part took cargo it does not physically fit (forks through a pallet face whose channels they miss)
  | 'build' // the sim built the part without its bodies (its package never reached the sim, or the physics world is full)

export interface RuntimePartDiagnostic {
  source: PartDiagnosticSource
  /** the placed scene part instance ('' when the problem isn't tied to one, e.g. a catalog validate) */
  partId: string
  /** the part package ('' when unknown) */
  packageId: string
  message: string
  /** times this exact diagnostic repeated (a throwing step() ticks at sim rate) */
  count: number
  /** sim seconds of the first/latest occurrence, when the reporter runs inside the sim loop */
  firstSimTime?: number
  lastSimTime?: number
}

/** What subscribers see: a new unique diagnostic (log/forward it) or a clear (refresh a view).
 *  Plain data - structured-clone-safe, so the sim worker forwards these verbatim to the main thread. */
export type PartDiagnosticsEvent = { kind: 'report'; entry: RuntimePartDiagnostic } | { kind: 'clear'; partId?: string } | { kind: 'dropped' }

// Unique diagnostics keyed by source+part+package+message. Bounded: past the cap, new unique entries
// are dropped (existing ones still bump their counts) - a pathological behavior can't grow this without
// bound, and the first 200 problems are always the ones worth reading.
const MAX_ENTRIES = 200
const entries = new Map<string, RuntimePartDiagnostic>()
const listeners = new Set<(e: PartDiagnosticsEvent) => void>()
// Bumped on any change; snapshot arrays are cached against it so React's useSyncExternalStore gets a
// stable reference between changes.
let rev = 0
// whether a new unique diagnostic has been dropped at the cap since the last full clear: a list that stopped
// recording must say so, or it reads as complete
let overflowed = false
let snapshotRev = -1
let snapshot: RuntimePartDiagnostic[] = []

const keyOf = (source: string, partId: string, packageId: string, message: string): string => `${source}\0${partId}\0${packageId}\0${message}`

/** Record one runtime problem. Deduplicates: a repeat bumps `count`/`lastSimTime` silently; only a new
 *  unique diagnostic notifies subscribers (so a per-tick error logs once, not 60×/s). */
export function reportPartDiagnostic(d: { source: PartDiagnosticSource; message: string; partId?: string; packageId?: string; simTime?: number }): void {
  const partId = d.partId ?? ''
  const packageId = d.packageId ?? ''
  const key = keyOf(d.source, partId, packageId, d.message)
  const hit = entries.get(key)
  rev++
  if (hit) {
    hit.count++
    if (d.simTime !== undefined) hit.lastSimTime = d.simTime
    return
  }
  if (entries.size >= MAX_ENTRIES) {
    notePartDiagnosticsDropped()
    return
  }
  const entry: RuntimePartDiagnostic = { source: d.source, partId, packageId, message: d.message, count: 1 }
  if (d.simTime !== undefined) {
    entry.firstSimTime = d.simTime
    entry.lastSimTime = d.simTime
  }
  entries.set(key, entry)
  for (const fn of listeners) fn({ kind: 'report', entry })
}

/** All current diagnostics (stable array reference until something changes). */
export function allPartDiagnostics(): readonly RuntimePartDiagnostic[] {
  if (snapshotRev !== rev) {
    snapshot = [...entries.values()]
    snapshotRev = rev
  }
  return snapshot
}

/** Diagnostics for one placed part instance. */
export function partDiagnosticsFor(partId: string): readonly RuntimePartDiagnostic[] {
  return allPartDiagnostics().filter((d) => d.partId === partId)
}

/** Drop diagnostics - all of them, or one part's (a behavior re-attach starts that part fresh).
 *  Notifies subscribers (with no entry) so a UI showing the cleared part refreshes. */
export function clearPartDiagnostics(partId?: string): void {
  let changed = false
  if (partId === undefined) {
    changed = entries.size > 0 || overflowed
    entries.clear()
    overflowed = false
  } else {
    for (const [k, v] of entries) {
      if (v.partId === partId) {
        entries.delete(k)
        changed = true
      }
    }
  }
  if (!changed) return
  rev++
  const e: PartDiagnosticsEvent = partId === undefined ? { kind: 'clear' } : { kind: 'clear', partId }
  for (const fn of listeners) fn(e)
}

/** Subscribe to changes: a 'report' event per new unique diagnostic (log/forward it), a 'clear' event
 *  when entries are dropped (refresh a view). Count bumps are silent, so a per-tick repeat can't flood
 *  the UI. Returns the unsubscribe. */
export function subscribePartDiagnostics(fn: (e: PartDiagnosticsEvent) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Whether new diagnostics were dropped at the cap since the last full clear, so the list is not all of them. */
export function partDiagnosticsOverflowed(): boolean {
  return overflowed
}

/** Record that a new diagnostic was dropped at the cap: here, or in the sim worker's own instance, whose
 *  `dropped` event the main thread mirrors through this. Notifies once, on the first drop, so a behavior
 *  minting a new message every tick can't flood the UI either. */
export function notePartDiagnosticsDropped(): void {
  if (overflowed) return
  overflowed = true
  rev++
  for (const fn of listeners) fn({ kind: 'dropped' })
}

/** Monotonic change counter - the cheap `getSnapshot` seed for a React external-store subscription. */
export function partDiagnosticsRev(): number {
  return rev
}
