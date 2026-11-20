import type { PartInstance } from '../types'

/**
 * What one scene sync changed, by part: every part added, removed, or replaced by a new object (parts are immutable
 * snapshots, so a replaced reference is an edit), with the version before and after. The view's sync builds one per
 * scene change and hands the same delta to every consumer that reacts to edits, so a consumer that reads none of the
 * changed parts can skip its work: a streamed edit (a drag, a scrub, a peer's drag) then costs what it touches instead
 * of the whole scene. docs/scene-change-consumers.md.
 *
 * `full` is the fail-open case: a load, or a sync with no previous scene to compare against. Every consumer treats it
 * as "everything changed".
 */
export interface SceneDelta {
  readonly full: boolean
  /** id → the part before (absent: added) and after (absent: removed) */
  readonly changed: ReadonlyMap<string, { readonly prev?: PartInstance; readonly next?: PartInstance }>
}

/** Collects a {@link SceneDelta} while a sync walks the scene. */
export class SceneDeltaBuilder {
  private readonly changed = new Map<string, { prev?: PartInstance; next?: PartInstance }>()
  constructor(private readonly full: boolean) {}

  /** `prev` undefined: the part is new; `next` undefined: it left. A part whose own object is unchanged but whose
   *  neighbour-derived context moved (a guard opening, a roller grid) is recorded with prev === next. */
  record(id: string, prev: PartInstance | undefined, next: PartInstance | undefined): void {
    this.changed.set(id, { ...(prev ? { prev } : {}), ...(next ? { next } : {}) })
  }

  build(): SceneDelta {
    return { full: this.full, changed: this.changed }
  }
}

/** True when the delta can have changed anything a consumer reading the parts `reads` accepts: a full change, or a
 *  changed part whose version before or after it reads (a part that stops being read changed what was read). */
export function deltaTouches(delta: SceneDelta, reads: (p: PartInstance) => boolean): boolean {
  if (delta.full) return true
  for (const { prev, next } of delta.changed.values()) {
    if ((prev && reads(prev)) || (next && next !== prev && reads(next))) return true
  }
  return false
}
