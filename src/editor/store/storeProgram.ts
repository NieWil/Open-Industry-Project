// Where the ST program document goes besides store state: the sink that keeps a change in a room, the transaction a
// room applies a program edit in, and the mounted ST editor's two channels (a wholesale replacement, an edit or its
// undo). Owned by the store (EditorStore.program). The document itself is `state.stProgram` / stScanMs / controller /
// stDialect, written only by the store; and the solo half of keeping it (stProgram.ts's localStorage keys) stays in
// store.ts, the one module the program-seam lint rule lets read it (eslint.config.js stProgramSeamBan).
import type { Controller } from '../../core/controller'

/** what a room keeps of a program change (see ProgramChannels.setSink) */
export type ProgramSink = (doc: { source: string; scanMs: number; controller: Controller | null; dialect?: string }) => void

export class ProgramChannels {
  // Where a program change goes to be kept: the room's shared Y.Text in a room, null solo (then
  // the store persists it itself, into localStorage + the project doc). Wired by the boot path -
  // the store never learns which mode it is in, exactly like packageSink / editEventSink.
  private stProgramSink: ProgramSink | null = null

  // A wholesale program replacement (scene import, project scene switch, the demo, the tutorial)
  // has to reach a mounted ST editor so its buffer swaps too. Keystrokes do not
  // broadcast (see EditorStore.setStProgram) - that would fight the editor that produced them.
  private stProgramListeners = new Set<(source: string) => void>()

  // In a room a program edit runs inside this: one shared-doc transaction, which the room's undo takes back as one
  // step (the collab bridge installs it). Null solo.
  private programTxn: ((apply: () => void) => void) | null = null

  // the mounted ST editor, told when a program edit (or its undo) changes the code. It applies the change without
  // recording it in its own history, which would let a Ctrl+Z there take back the code and leave the rest
  private stProgramEditListeners = new Set<(source: string) => void>()

  // ids for stFileReport: a new report is a new key, which is what resets its checklist's ticks
  private stFileReportSeq = 0

  setSink(sink: ProgramSink | null): void {
    this.stProgramSink = sink
  }

  /** is a room keeping the program (rather than the store, solo)? */
  get hasSink(): boolean {
    return this.stProgramSink !== null
  }

  /** Keep a program change through the room's sink. False solo (no sink): the store keeps it itself. */
  keep(doc: Parameters<ProgramSink>[0]): boolean {
    if (!this.stProgramSink) return false
    this.stProgramSink(doc)
    return true
  }

  /** subscribe to imported-ST-program events (a loaded scene bundled a PLC program) */
  onLoad(cb: (source: string) => void): () => void {
    this.stProgramListeners.add(cb)
    return () => this.stProgramListeners.delete(cb)
  }

  /** a wholesale replacement: a mounted ST editor swaps its buffer */
  broadcastLoad(source: string): void {
    for (const cb of this.stProgramListeners) cb(source)
  }

  setTransaction(run: ((apply: () => void) => void) | null): void {
    this.programTxn = run
  }

  /** run a room's program edit inside the room's transaction (directly when none is installed) */
  inTransaction(apply: () => void): void {
    if (this.programTxn) this.programTxn(apply)
    else apply()
  }

  /** subscribe to code changes made by program edits and their undo/redo (the mounted ST editor applies them) */
  onEdit(cb: (source: string) => void): () => void {
    this.stProgramEditListeners.add(cb)
    return () => this.stProgramEditListeners.delete(cb)
  }

  /** a program edit (or its undo/redo) changed the code: the mounted ST editor applies it */
  broadcastEdit(source: string): void {
    for (const cb of this.stProgramEditListeners) cb(source)
  }

  /** the next stFileReport id */
  nextReportId(): number {
    return ++this.stFileReportSeq
  }
}
