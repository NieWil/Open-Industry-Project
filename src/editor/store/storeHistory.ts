// The undo history's shapes: one undo step (HistoryEntry), a commit's coalescing options, and the History dock's
// edit feed (EditEvent / EditHistory), and the history the store owns (UndoHistory). The public types stay re-exported
// from store.ts.
import type { Controller } from '../../core/controller'
import type { PartPackage } from '../../core/parts/partPackage'
import { renamePartInScene } from '../../core/parts/partRename'
import type { SceneJSON } from '../../core/types'

/** How close in time two edits with the same coalescing key must be to merge into one undo step. */
export const COALESCE_MS = 800

export interface CommitOptions {
  coalesceKey?: string
  before?: SceneJSON
}

// One undo step. A scene edit swaps SceneJSON; a package edit (author mode: geometry/joints/mesh of a
// custom part) swaps the registered PartPackage. Both live in one stack so Ctrl+Z is uniform: undoing a
// node move in the studio and a part move in the factory work identically.
export type HistoryEntry =
  | { kind: 'scene'; label: string; coalesceKey?: string; before: SceneJSON; after: SceneJSON; time: number }
  | { kind: 'package'; label: string; coalesceKey?: string; id: string; before: PartPackage; after: PartPackage; time: number }
  // a program edit (store.commitProgram): the code, scan time and task table together, and the scene when the edit
  // rewired parts, so no one undo step can take back half of it
  | { kind: 'program'; label: string; coalesceKey?: string; before: ProgramDoc; after: ProgramDoc; sceneBefore?: SceneJSON; sceneAfter?: SceneJSON; time: number }

export type ProgramEntry = Extract<HistoryEntry, { kind: 'program' }>

/** The ST program document: its code, its scan time, its controller table and its dialect (absent = IEC). */
export interface ProgramDoc {
  source: string
  scanMs: number
  controller: Controller | null
  dialect?: string
}

/**
 * One row of the History dock's edit feed: what happened and when. This shape - not the raw
 * undo stacks - is the panel's contract: in solo mode it is projected from the snapshot
 * stacks, and a future room mode feeds the same shape from a shared activity log (with actor
 * attribution) instead, so the panel never needs to know which mechanism owns undo. It
 * carries no scene/package snapshots: labels + times only, safe to grow, sync
 * and (eventually) persist.
 */
export interface EditEvent {
  label: string
  time: number
  /** 'scene' = an edit to the open scene; 'package' = an author-mode custom-part (definition) edit;
   *  'program' = an edit to the PLC program's structure (tasks, programs, an import) */
  kind: 'scene' | 'package' | 'program'
  /** who made the edit - present on room-feed events (solo events are all yours; no actor shown) */
  actor?: string
  /** true when a room-feed event was written by this client (the panel renders it as "You") */
  mine?: boolean
}

/** a committed edit as reported to the room's shared feed (the collab bridge adds actor + clientID) */
export interface EditEventInput {
  label: string
  time: number
  kind: 'scene' | 'package' | 'program'
  coalesceKey?: string
}

/** The edit feed: `events` oldest → newest; entries before `cursor` are applied, the rest have
 *  been undone (redoable). Jumping to position N means exactly the first N events are applied. */
export interface EditHistory {
  events: readonly EditEvent[]
  cursor: number
}

export const EMPTY_HISTORY: EditHistory = { events: [], cursor: 0 }

/** the room's undo (the collab bridge's Y.UndoManager, scoped to this client's edits) */
export interface UndoDelegate {
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
}

/**
 * The undo history the store owns (EditorStore.history): the solo snapshot stacks, the coalescing barrier, the
 * History dock's memoised projection of them, and, in a room, the delegate undo and the shared edit feed used
 * instead of them. It holds and orders entries; applying one (a scene, a package, a program document) stays the store's,
 * because that is a state write through the edit gate. Its one dependency is whether the store is in a room.
 */
export class UndoHistory {
  constructor(private readonly inRoom: () => boolean) {}

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  // undo/redo create a history boundary later commits must not coalesce across
  private coalesceBarrier = false
  // in a room, undo/redo delegate to a Y.UndoManager (scoped to this client's edits) wired
  // by the collab bridge; null in solo mode (the snapshot stacks above are used instead)
  private undoDelegate: UndoDelegate | null = null
  // room mode: the shared edit feed as last handed over by the bridge (getEditHistory returns it while
  // in a room). null in solo mode / before the first feed sync.
  private remoteFeed: EditHistory | null = null
  // getEditHistory memo: rebuild the projection only when a stack actually changed, so the
  // History panel gets a referentially-stable snapshot across unrelated state updates. The
  // stack tops' identities are a sufficient key: entries are immutable once pushed - only the
  // top is ever replaced in place (coalescing), everything else moves via push/pop/filter,
  // all of which change a length or a top.
  private historyMemo: {
    undoLen: number
    redoLen: number
    undoTop: HistoryEntry | undefined
    redoTop: HistoryEntry | undefined
    value: EditHistory
  } | null = null

  /** the solo undo stack, oldest first (read-only view; see EditorStore.undoStack) */
  get undoEntries(): readonly HistoryEntry[] {
    return this.undoStack
  }

  get undoDepth(): number {
    return this.undoStack.length
  }

  get redoDepth(): number {
    return this.redoStack.length
  }

  get canUndo(): boolean {
    if (this.inRoom()) return this.undoDelegate?.canUndo() ?? false
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    if (this.inRoom()) return this.undoDelegate?.canRedo() ?? false
    return this.redoStack.length > 0
  }

  setDelegate(delegate: UndoDelegate | null): void {
    this.undoDelegate = delegate
  }

  /** the room's undo / redo (no-op without a delegate) */
  delegateUndo(): void {
    this.undoDelegate?.undo()
  }

  delegateRedo(): void {
    this.undoDelegate?.redo()
  }

  /** the room's edit feed: replaced on every bridge sync, dropped on entering or leaving a room */
  setRemoteFeed(feed: EditHistory | null): void {
    this.remoteFeed = feed
  }

  /** the newest undo entry */
  undoTop(): HistoryEntry | undefined {
    return this.undoStack[this.undoStack.length - 1]
  }

  /** the next redo entry */
  redoTop(): HistoryEntry | undefined {
    return this.redoStack[this.redoStack.length - 1]
  }

  /** the newest undo entry when a commit may still fold into it: none across an undo/redo boundary */
  coalescibleTop(): HistoryEntry | undefined {
    return this.coalesceBarrier ? undefined : this.undoTop()
  }

  /** a new edit: pushed as the newest step, ending the redo tail and any undo/redo boundary */
  record(entry: HistoryEntry): void {
    this.undoStack.push(entry)
    this.redoStack = []
    this.coalesceBarrier = false
  }

  /** a continuing edit folded into the newest step (see coalescibleTop): the redo tail ends */
  replaceTop(entry: HistoryEntry): void {
    this.undoStack[this.undoStack.length - 1] = entry
    this.redoStack = []
  }

  /** take the newest step for an undo; a taken step raises the boundary later commits must not coalesce across */
  takeUndo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop()
    if (entry) this.coalesceBarrier = true
    return entry
  }

  /** take the next step for a redo (the same boundary as takeUndo) */
  takeRedo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop()
    if (entry) this.coalesceBarrier = true
    return entry
  }

  /** an undone step, onto the redo tail */
  pushRedo(entry: HistoryEntry): void {
    this.redoStack.push(entry)
  }

  /** a redone step, back onto the undo stack (the rest of the redo tail stays) */
  pushUndo(entry: HistoryEntry): void {
    this.undoStack.push(entry)
  }

  /** forget every step (a scene replaced wholesale, a room entered) */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }

  /** forget the package steps of the parts `drop` names (a deleted or replaced part must not come back via Ctrl+Z) */
  dropPackages(drop: (id: string) => boolean): void {
    this.undoStack = this.undoStack.filter((e) => e.kind !== 'package' || !drop(e.id))
    this.redoStack = this.redoStack.filter((e) => e.kind !== 'package' || !drop(e.id))
  }

  /**
   * Part `from` is now part `to` (store.renameUserPackage). Every step is rewritten as if the part always had the new
   * id, so undoing an earlier step cannot bring back a placed part that names an id the library no longer has.
   */
  renamePart(from: string, to: string): void {
    const pkg = (p: PartPackage): PartPackage => (p.id === from ? { ...p, id: to } : p)
    const scene = (s: SceneJSON): SceneJSON => renamePartInScene(s, from, to)
    const entry = (e: HistoryEntry): HistoryEntry => {
      if (e.kind === 'scene') return { ...e, before: scene(e.before), after: scene(e.after) }
      if (e.kind === 'package') return e.id === from ? { ...e, id: to, before: pkg(e.before), after: pkg(e.after) } : e
      return {
        ...e,
        ...(e.sceneBefore ? { sceneBefore: scene(e.sceneBefore) } : {}),
        ...(e.sceneAfter ? { sceneAfter: scene(e.sceneAfter) } : {}),
      }
    }
    this.undoStack = this.undoStack.map(entry)
    this.redoStack = this.redoStack.map(entry)
  }

  /**
   * The edit feed shown by the History dock. Solo: a projection of the snapshot undo stacks
   * (cursor tracks undo/redo; jumping is supported). Room: the shared activity feed handed
   * over by the collab bridge - attributed, capped, and read-only (no jump; the client-scoped
   * Y.UndoManager owns undo there).
   */
  getEditHistory(): EditHistory {
    if (this.inRoom()) return this.remoteFeed ?? EMPTY_HISTORY
    const undoTop = this.undoStack[this.undoStack.length - 1]
    const redoTop = this.redoStack[this.redoStack.length - 1]
    const m = this.historyMemo
    if (m && m.undoLen === this.undoStack.length && m.redoLen === this.redoStack.length && m.undoTop === undoTop && m.redoTop === redoTop) {
      return m.value
    }
    const toEvent = (e: HistoryEntry): EditEvent => ({ label: e.label, time: e.time, kind: e.kind })
    const events = [
      ...this.undoStack.map(toEvent),
      // redoStack is pop-ordered (next redo last); reverse it for chronological display
      ...[...this.redoStack].reverse().map(toEvent),
    ]
    const value: EditHistory = { events, cursor: this.undoStack.length }
    this.historyMemo = { undoLen: this.undoStack.length, redoLen: this.redoStack.length, undoTop, redoTop, value }
    return value
  }
}
