// When the store's solo autosave writes: the trailing write a continuing gesture defers, what it still owes (the scene,
// the program), how stale the legacy fallback key may get, and who hears a successful write of the project document.
// Owned by the store (EditorStore.autosave). What a write contains (the project document, the legacy scene key, the
// program's own keys) stays the store's (persist / persistProject / persistStProgram), as does the decision that a
// change is a document edit (the edit gate). This only schedules and remembers.

/** how far a gesture's trailing autosave may lag it (see defer) */
const PERSIST_TRAIL_MS = 400
/** how stale the legacy fallback copy may get while the primary project autosave is healthy (see EditorStore.persist) */
const LEGACY_BACKUP_MS = 5000

export class AutosaveSchedule {
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private scenePersistPending = false
  private programPersistPending = false
  /** when the legacy fallback key was last refreshed (see EditorStore.persist) */
  private lastLegacyBackup = 0
  private readonly persistListeners = new Set<() => void>()

  /**
   * Autosave for an edit that continues a gesture. persist() is synchronous and whole-project (10-16 ms on a
   * 199-part scene, see EditorStore.setRunScene), and a scrub, a colour drag or typing commits at input rate, so
   * persisting per event would use up the frame. The gesture's first commit still writes at once; the rest mark the
   * document dirty and one trailing write (`flush`) runs PERSIST_TRAIL_MS later. A timer rather than a debounce, so
   * continuous input still writes on that period, and any other write of the project (persistProject, from any path)
   * absorbs a pending one (settle). EditorStore.flushPersist() is the unload / hand-off entry point.
   */
  defer(flush: () => void): void {
    this.scenePersistPending = true
    if (this.persistTimer !== null) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      flush()
    }, PERSIST_TRAIL_MS)
  }

  /** the scene owes a write that a later one will make (a live edit's step: endLiveEdit or flushPersist writes it) */
  markScene(): void {
    this.scenePersistPending = true
  }

  /** the program owes a write that a later one will make (a keystroke, see EditorStore.setStProgram) */
  markProgram(): void {
    this.programPersistPending = true
  }

  /** does the scene still owe a write? */
  get scenePending(): boolean {
    return this.scenePersistPending
  }

  /** does a deferred autosave still have to land? */
  get pending(): boolean {
    return this.scenePersistPending || this.programPersistPending
  }

  /** whether the program owed a write, and from now on it does not (the caller is writing it) */
  takeProgramPending(): boolean {
    const owed = this.programPersistPending
    this.programPersistPending = false
    return owed
  }

  /** stop the trailing write's timer, if one is waiting */
  cancelTimer(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  /** a write of the project is happening now: the scene owes nothing more and no trailing write is needed */
  settleScene(): void {
    this.scenePersistPending = false
    this.cancelTimer()
  }

  /**
   * Is the legacy fallback key due a refresh? Always when the primary write failed (then it is the only copy of the
   * user's work); otherwise once it is LEGACY_BACKUP_MS stale. A yes counts as the refresh.
   */
  legacyBackupDue(primaryOk: boolean, now: number): boolean {
    if (primaryOk && now - this.lastLegacyBackup < LEGACY_BACKUP_MS) return false
    this.lastLegacyBackup = now
    return true
  }

  /** hear every successful write of the project document (see EditorStore.onProjectPersisted) */
  onPersisted(cb: () => void): () => void {
    this.persistListeners.add(cb)
    return () => this.persistListeners.delete(cb)
  }

  /** a write of the project document succeeded */
  notifyPersisted(): void {
    for (const cb of this.persistListeners) cb()
  }
}
