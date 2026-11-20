// An open live edit (EditorStore.beginLiveEdit): a pointer gesture on an Inspector field that commits at input rate.
// Owned by the store (EditorStore.liveEdit), which reads it in commit to use the transient stream and coalesce the
// gesture into one undo step; this holds only which parts the gesture changed and whether it has written yet.
import type { SceneJSON } from '../../core/types'

/** one open live edit: the parts its commits changed, and whether it has written yet */
export interface LiveEditGesture {
  readonly ids: Set<string>
  wrote: boolean
}

export class LiveEditSession {
  // an open live edit (beginLiveEdit): the parts its commits changed, and whether it has written yet
  private liveEdit: LiveEditGesture | null = null

  /** open one, unless one is open already */
  begin(): void {
    this.liveEdit ??= { ids: new Set(), wrote: false }
  }

  /** close the open one and hand it back (null when none was open) */
  end(): LiveEditGesture | null {
    const live = this.liveEdit
    this.liveEdit = null
    return live
  }

  /** is a live edit open? */
  get active(): boolean {
    return this.liveEdit !== null
  }

  /** has the open live edit written yet? (false when none is open) */
  get wrote(): boolean {
    return this.liveEdit?.wrote === true
  }

  /** an open live edit's commit has written (its autosave trails: endLiveEdit, or flushPersist on unload) */
  markWrote(): void {
    this.liveEdit!.wrote = true
  }

  /** note the parts a commit changed in an open live edit, matched by index (a commit that adds or removes parts notes none) */
  track(before: SceneJSON, after: SceneJSON): void {
    const live = this.liveEdit
    if (live && before.parts.length === after.parts.length) {
      for (let i = 0; i < after.parts.length; i++) if (after.parts[i] !== before.parts[i]) live.ids.add(after.parts[i]!.id)
    }
  }

  /** the parts the open live edit has changed so far, or null */
  ids(): string[] | null {
    return this.liveEdit && this.liveEdit.ids.size > 0 ? [...this.liveEdit.ids] : null
  }
}
