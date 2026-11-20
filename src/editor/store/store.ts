import { sceneSettings } from '../../core/scene/scenePlcs'
import { partDisplayName } from '../../core/parts/partDisplayName'
import { dockOpeningBlocker } from '../../core/building/buildingDocks'
import { builtInPackage, getPackage, registerPackage, registerScenePackages } from '../../core/parts/partRegistry'
import { definitionsUsedBy } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PackageStatus } from '../parts/packageSource'
import { DEMO_SCENE_NAME } from '../demo/demoScenes'
import { createSdkPart, emptyScene, nextId } from '../../core/scene/scene'
import { floorRestPose, withFlexPose } from '../../core/parts/partGeometry'
import type { FlexPose } from '../../core/parts/partGeometry'
import { assembleProject, legacySceneText, loadStoredProject, noteLegacyWrite, saveStoredProject } from '../project/projectFile'
import { keepsSharedTests } from '../project/sharedProject'
import { SCENE_SLOT } from '../project/documentStore'
import type { SaveResult, UnopenedProject } from '../project/projectFile'
import type { ProjectJSON } from '../../core/project/project'
import { missingLibraryCopies } from '../../core/project/project'
import { warmShippedAssets } from '../parts/shippedAssetCache'
import type { TestSpec } from '../../core/project/projectTest'
import { clampScanMs, DEFAULT_SCAN_MS, readStProgram, readStScanMs, saveStProgram, saveStScanMs } from '../program/stProgram'
import { sameController } from '../../core/controller'
import type { Controller } from '../../core/controller'
import { isKnownDialect, storedDialect } from '../../core/dialect'
import type { StFileReportData } from '../components/plc/StFileReport'
import type { DockPanelId } from '../dockLayout'
import { DEFAULT_SIM_HZ, SCENE_VERSION, toSimRate } from '../../core/types'
import type { PartInstance, PartType, SceneJSON, SimRate } from '../../core/types'
import type { ProjectionMode } from '../../render/api'
import {
  EXTERNAL_PLC_KEY,
  FACESNAP_KEY,
  FLOWARROWS_KEY,
  GRIDSNAP_KEY,
  LIVESNAP_KEY,
  SHOWGRID_KEY,
  SHOWNOTES_KEY,
  SHOWSTATS_KEY,
  SPACE_KEY,
  TRACKBALL_KEY,
  TREETYPES_KEY,
  VSNAP_COLLISION_KEY,
  VSNAP_ORIGIN_KEY,
  persistPref,
} from './storePrefs'
import type { ExternalPlcSettings, PlcLinkSettings, UaServerSettings } from './storePrefs'
import { addPlc, plcSetupOf, removePlc, renamePlc, setPlcLink, setRunsOn } from './storePlcs'
import { restoreUserPackages as restoreUserPackagesFromStorage, syncUserCatalog } from './storePackages'
import * as library from './storePackages'
import type { LibraryAreas } from './storePackages'
import { openingSpecsToRows, removeFromWall, rowsToOpeningSpecs } from '../../core/guards/guardOpeningEdit'
import { deepFreeze, guardOpeningsTarget, initialEditorState, rigNodeKey } from './storeState'
import type { EditorState, FollowState, GridSnap, ListSelectMenu, Notice, ToolMode, TransformSpace } from './storeState'
import { COALESCE_MS, UndoHistory } from './storeHistory'
import type { CommitOptions, EditEvent, EditEventInput, EditHistory, HistoryEntry, ProgramDoc, ProgramEntry, UndoDelegate } from './storeHistory'
import { documentSceneOf, livePackagesFor, RunOwnership } from './storeDocument'
import type { LiveCargoHost } from './storeDocument'
import { AutosaveSchedule } from './storeAutosave'
import { LiveEditSession } from './storeLiveEdit'
import { StoreSubscribers } from './storeListeners'
import { ProgramChannels } from './storeProgram'
import type { ProgramSink } from './storeProgram'
import { RevealRequests } from './storeReveal'
import { RoomSinks } from './storeRoom'
import * as tree from './storeTree'
import * as copy from './storeCopy'
import { selectionSet } from './selectionSet'

export const AUTOSAVE_KEY = 'oip-web/autosave'
// The preference / clipboard / user-package storage keys (and their read/write helpers) live in the
// store modules (storePrefs / storeClipboard / storePackages); the keys stay re-exported here so
// existing './store' imports keep working unchanged.
export { FACESNAP_KEY, FLOWARROWS_KEY, GRIDSNAP_KEY, LIVESNAP_KEY, SHOWGRID_KEY, SHOWNOTES_KEY, SHOWSTATS_KEY, SPACE_KEY, TRACKBALL_KEY, TREETYPES_KEY, VSNAP_COLLISION_KEY, VSNAP_ORIGIN_KEY } from './storePrefs'
export { CLIPBOARD_KEY } from './storeClipboard'
export { USERPKG_KEY } from './storePackages'

// The state shape and its pure reads (storeState), the undo history's shapes (storeHistory) and the document /
// run-ownership helpers (storeDocument) live in their own modules; re-exported here so existing './store'
// imports keep working unchanged.
//
// The store is the one public facade, but each area with state of its own owns it in an object the store holds (a
// private readonly field) and delegates to: who hears a change (StoreSubscribers), the undo history (UndoHistory),
// what the run owns (RunOwnership), the autosave's schedule (AutosaveSchedule), an open live edit (LiveEditSession),
// the program's channels (ProgramChannels), the room's writers (RoomSinks) and the reveal requests (RevealRequests).
// Each gets only what it needs (a callback, an argument), never the store. What stays here is what spans them: the
// state and its one write path (setState), the edit gate (commit), applying an undo step, the project and the demo
// session, and the part library.
export type { EditTarget, EditorState, FollowState, GridSnap, ListSelectItem, ListSelectMenu, Notice, PartBuildNotice, SceneFileContents, ToolMode, TransformSpace } from './storeState'
export { editStack, editTarget, editTargetFocusId, guardOpeningsTarget, rigNodeKey } from './storeState'
export type { CommitOptions, EditEvent, EditEventInput, EditHistory } from './storeHistory'
export type { LiveCargoHost, LiveCargoPose } from './storeDocument'
export { documentSceneOf } from './storeDocument'

/** projectTests() with no project: one shared array, so a memo on it holds while no tests are kept */
const NO_TESTS: readonly TestSpec[] = Object.freeze([])

export class EditorStore {
  private state: EditorState
  // who hears a change: React (subscribe) and the view/controller (subscribeView). See StoreSubscribers.
  private readonly subscribers = new StoreSubscribers()
  // collaborative (room) mode: a Yjs doc + IndexedDB are the source of truth, so the
  // local snapshot undo stack (which would revert others' concurrent edits) is suppressed
  // and localStorage autosave is skipped. See src/collab.
  /** internal - for store modules */
  collab = false
  // the undo history: the solo snapshot stacks, or in a room the delegate undo and the shared feed (UndoHistory)
  private readonly history = new UndoHistory(() => this.collab)
  // an open live edit (beginLiveEdit): the parts its commits changed, and whether it has written yet
  private readonly liveEdit = new LiveEditSession()
  // view-only mode: opened via a shared read-only room link (?room=…&view). Authoring commits
  // are dropped here and the collab bridge never writes to the doc, so this client can pan and
  // run its own private sim but can't mutate the shared scene. See src/collab.
  private readOnly = false
  // room mode: the writers the collab bridge installs - a committed package, each edit's feed line, the step
  // rate (RoomSinks). All null in solo mode.
  private readonly room = new RoomSinks()
  // what the current run owns: the controller's live-cargo seam and, while running, every placed box's designed
  // pose. The one definition of "run-owned" the edit gate, the undo history and the autosave read (RunOwnership).
  private readonly run = new RunOwnership()
  /** what the part-library operations (storePackages.ts) reach of this store's own areas */
  private readonly libraryAreas: LibraryAreas = { history: this.history, room: this.room, readOnly: () => this.readOnly }
  // when the solo autosave writes: the trailing write, what it still owes, the legacy key's age (AutosaveSchedule)
  private readonly autosave = new AutosaveSchedule()
  // the program's sink, transaction and the mounted ST editor's channels (ProgramChannels)
  private readonly program = new ProgramChannels()
  // "bring this on screen" requests: a dock panel, a place in the code, the organizer's tasks (RevealRequests)
  private readonly reveals = new RevealRequests()
  // monotonic key for build-failure toasts so each notice has a stable React key / dismiss handle
  private noticeSeq = 0
  // monotonic key for viewport hints so a re-flash restarts the badge's dismiss timer
  private hintSeq = 0
  // The in-memory project: its scene, program, library and tests. The scene's content is mirrored live in
  // `state.scene` (+ the ST program buffer + userPackages); captureLiveScene folds the live state back in before a
  // save. Null until loadProject (the legacy no-project path persists a fresh doc via assembleProject instead).
  private project: ProjectJSON | null = null

  constructor(scene?: SceneJSON) {
    this.state = initialEditorState(scene, readStProgram(), readStScanMs())
    // the constructor bypasses setState, so the initial scene gets the same dev freeze (see setState)
    if (import.meta.env.DEV) for (const p of this.state.scene.parts) deepFreeze(p)
  }

  /**
   * React subscription (useSyncExternalStore). Skips transient updates: while a gizmo
   * drag or manipulator motion streams a new scene every pointer-move/frame via
   * setTransient, the editor chrome (Inspector, tree, catalog) must not re-render each
   * time: that synchronous React work starves the render loop and drops the framerate.
   * The viewport tracks the drag live through subscribeView; the panels refresh on commit.
   */
  subscribe = (cb: () => void): (() => void) => this.subscribers.subscribe(cb)

  /** view/controller subscription: fires on every change, transient updates included */
  subscribeView = (cb: (transient: boolean) => void): (() => void) => this.subscribers.subscribeView(cb)

  /** @internal test hook - React's subscribers (e2e/verify-crash-boundary notifies them by hand) */
  get listeners(): ReadonlySet<() => void> {
    return this.subscribers.listeners
  }

  // True while the demo is on screen as an ephemeral source (loaded persist:false so viewing it never
  // clobbers a returning user's autosave): the `?scene=demo` entry URL or the in-app Demo action. The
  // first persisting edit forks it into a scene of the user's own and retires the `?scene=demo` param
  // (see stashDemoSession / clearDemoUrl): the demo has become their work, and leaving the param in the
  // URL would re-open the demo over that work on the next reload.
  //
  // Kept in state (not a plain field) so the switcher re-renders when the view enters/leaves the demo;
  // the accessor pair preserves the `store.demoSession = true` spelling the boot path uses.
  get demoSession(): boolean {
    return this.state.demoSession
  }
  set demoSession(on: boolean) {
    // a fresh peek can never inherit a previous fork's slot (see demoForkedSlot). Every entry path goes
    // through this setter, which is why the clear lives here rather than in enterDemoSession.
    if (on) this.demoForkedSlot = null
    if (on !== this.state.demoSession) this.setState({ demoSession: on })
  }

  /**
   * The slot {@link stashDemoSession} just forked the demo view into (SCENE_SLOT), when that is what ended the
   * demo session. The viewport reads it on the demoSession true->false transition to tell apart the two
   * ways a peek can end, which are otherwise the same flag flip. A fork keeps the same document under a
   * new identity, so the camera carries onto the new slot (nothing moves the camera at that moment, so a
   * settle write would never fire and the slot would open at world zero on the next visit). A drop
   * discards the demo, so the scene coming back gets its own remembered framing instead of the demo's.
   * Nothing but the camera hand-off needs the distinction - see EditorController.onStoreChange.
   */
  demoForkedSlot: string | null = null

  /**
   * Bumped by every wholesale scene replacement ({@link loadScene}: a scene tab, the demo, Open, New, a
   * project), before the setState that publishes it, so a listener can tell "a different scene" from an
   * edit of the same one. The viewport reads it to decide whether to cover the swap while the incoming
   * scene arrives (EditorController.onStoreChange, sceneSwapCover.ts). Not state: nothing renders it.
   */
  sceneLoads = 0

  /** re-entrancy guard for {@link stashDemoSession} - see the comment at its head */
  private stashingDemo = false

  // Raised only while {@link enterDemoSession} swaps the demo in. Loading a scene broadcasts its ST
  // program, and a mounted ST editor's listener re-enters persistProject - which would see the flag
  // already up and stash a half-loaded demo as a scene, minting the very tab this model exists to avoid.
  private enteringDemo = false

  /** subscribe to imported-ST-program events (a loaded scene bundled a PLC program) */
  onStProgramLoad = (cb: (source: string) => void): (() => void) => this.program.onLoad(cb)

  /**
   * Install the writer that keeps a program change (room mode: the shared Y.Text). Null restores
   * the solo behaviour - localStorage plus the unified project doc, written by the store itself.
   * The sink only persists; `state.stProgram` is the truth either way.
   */
  setStProgramSink(sink: ProgramSink | null): void {
    this.program.setSink(sink)
  }

  /**
   * Replace the authored ST program wholesale - a scene import, a project scene switch, the demo,
   * "New simulation", the tutorial. Updates state (what the controller attaches and every exporter
   * reads), persists through the sink, and broadcasts so a mounted ST editor swaps its buffer.
   *
   * State is what counts; the broadcast is just the open editor catching up. The PLC panel is only
   * mounted while it is the front tab of its dock slot, so a broadcast alone would vanish whenever
   * it sits behind another tab.
   *
   * `persist: false` sets the program without keeping it. The demo's paired program uses this, so
   * peeking at ?scene=demo never overwrites a returning user's saved work, while the exporter and the
   * room seeder still see it (a demo shared from that session carries its logic).
   */
  loadStProgram(source: string, opts?: { scanMs?: number; persist?: boolean; controller?: Controller | null; dialect?: string | null }): void {
    const scanMs = opts?.scanMs !== undefined ? clampScanMs(opts.scanMs) : this.state.stScanMs
    // a controller table belongs to the program it arrived with: a program loaded without one runs alone; and a file
    // report about the program that was here would describe the wrong program. So does its dialect: a program loaded
    // without one is IEC, never the dialect of the program it replaced
    this.setState({ stProgram: source, stScanMs: scanMs, controller: opts?.controller ?? null, stDialect: storedDialect(opts?.dialect), stFileReport: null })
    if (opts?.persist !== false) this.persistStProgram()
    this.program.broadcastLoad(source)
  }

  /**
   * The buffer changed at the keyboard (the ST editor's onChange). Same store of record, but no
   * broadcast: the editor that produced the keystroke owns its own document, and echoing back into
   * it would fight the cursor. In a room the sink is a no-op for text - CodeMirror is bound
   * straight to the shared Y.Text - so this just keeps state in sync with what was typed.
   */
  setStProgram(source: string): void {
    if (source === this.state.stProgram) return
    this.setState({ stProgram: source })
    // a keystroke: the write trails the typing instead of serialising the whole project per key (deferPersist)
    if (this.program.hasSink) this.persistStProgram()
    else {
      this.autosave.markProgram()
      this.deferPersist()
    }
  }

  /** Retune the program's scan (cycle) time. Clamped here - the one adoption point for a value that
   *  can arrive from a hand-edited file, a project doc, or a peer. */
  setStScanMs(ms: number): void {
    const scanMs = clampScanMs(ms)
    if (scanMs === this.state.stScanMs) return
    this.setState({ stScanMs: scanMs })
    this.persistStProgram()
  }

  /** Replace the program's controller table (its tasks and program instances), or clear it with null so the
   *  program runs alone on its scan time. Kept like any other change to the program. */
  setController(controller: Controller | null): void {
    if (sameController(controller, this.state.controller)) return
    this.setState({ controller })
    this.persistStProgram()
  }

  /** Install the transaction a room applies a program edit in (collab bridge); null restores solo. */
  setProgramTransaction(run: ((apply: () => void) => void) | null): void {
    this.program.setTransaction(run)
  }

  /** subscribe to code changes made by program edits and their undo/redo (the mounted ST editor applies them) */
  onStProgramEdit = (cb: (source: string) => void): (() => void) => this.program.onEdit(cb)

  /**
   * An edit to the program's structure (its task table, its scan time, a PROGRAM added or renamed, a file imported),
   * with the code and the scene wiring it changes, as one undo step. Typing stays the code editor's own history; the
   * controller organizer, the POU strip's program commands and import commit through here, so no Ctrl+Z takes back
   * half of one (the code without its table, a table row without its PROGRAM, tags renamed with parts still wired to
   * the old names). In a room it runs inside the bridge's transaction, which the room's undo reverts as one step.
   *
   * `dialect` is the program's language family (core/dialect.ts): undefined leaves it, null (or 'iec') makes it IEC,
   * any other string sets it. An import that replaces the code says which language the new code is in.
   */
  commitProgram(
    label: string,
    next: { source?: string; scanMs?: number; controller?: Controller | null; dialect?: string | null },
    opts?: { scene?: SceneJSON },
  ): void {
    if (this.readOnly) return
    // A program in a dialect this build does not read is kept exactly as written: an edit that reads it as IEC (the
    // organizer, Assign I/O, a PROGRAM rename) is refused here, whichever panel made it. Only a wholesale replacement
    // that says what dialect it brings (an import) may take its place.
    if (!isKnownDialect(this.state.stDialect) && next.dialect === undefined) return
    const before: ProgramDoc = { source: this.state.stProgram, scanMs: this.state.stScanMs, controller: this.state.controller, dialect: this.state.stDialect }
    const after: ProgramDoc = {
      source: next.source ?? before.source,
      scanMs: next.scanMs !== undefined ? clampScanMs(next.scanMs) : before.scanMs,
      controller: next.controller !== undefined ? next.controller : before.controller,
      dialect: next.dialect !== undefined ? storedDialect(next.dialect) : before.dialect,
    }
    const scene = opts?.scene
    const same = after.source === before.source && after.scanMs === before.scanMs && sameController(after.controller, before.controller) && after.dialect === before.dialect
    if (!scene && same) return
    if (this.collab) {
      this.room.feed(() => ({ label, time: Date.now(), kind: 'program' }))
      this.program.inTransaction(() => this.applyProgramDoc(after, scene))
      return
    }
    // scene snapshots are documents, like a scene entry's (see commit) - and a definition session's scene is none
    const docScene = scene && !this.state.packageEdit
    this.history.record({ kind: 'program', label, before, after, ...(docScene ? { sceneBefore: this.run.documentOf(this.state.scene), sceneAfter: this.run.documentOf(scene) } : {}), time: Date.now() })
    this.applyProgramDoc(after, scene)
  }

  /** Put a program document (and a scene with it) in place: kept, and the mounted ST editor told of new code. */
  private applyProgramDoc(doc: ProgramDoc, scene?: SceneJSON): void {
    const codeChanged = doc.source !== this.state.stProgram
    this.setState({ stProgram: doc.source, stScanMs: doc.scanMs, controller: doc.controller, stDialect: doc.dialect, ...(scene ? { scene } : {}) })
    this.persistStProgram()
    if (scene) this.persist()
    if (codeChanged) this.program.broadcastEdit(doc.source)
  }

  /**
   * The code an undo or redo of a program edit leaves: the current code when the edit did not touch the code, the
   * other side of the edit when the code is still exactly as the edit left it. Null when the code has changed since:
   * taking the edit back would take that work with it, so the entry is dropped and a notice says why nothing moved.
   */
  private programCode(entry: ProgramEntry, dir: 'undo' | 'redo'): string | null {
    const [from, to] = dir === 'undo' ? [entry.after.source, entry.before.source] : [entry.before.source, entry.after.source]
    if (from === to) return this.state.stProgram
    if (this.state.stProgram === from) return to
    this.setState({
      undoNotice: {
        key: this.noticeSeq++,
        title: `Can't ${dir} "${entry.label}"`,
        message: `The code has changed since, and ${dir === 'undo' ? 'undoing' : 'redoing'} it would lose that work. It is no longer in the undo history, and the code stays as it is.`,
      },
    })
    return null
  }

  /**
   * Ctrl+Z pressed in the code editor. When the newest step on the project's stack is a program edit that changed the
   * code, and the code is exactly as it left it (nothing typed since, or typed and undone again), that edit is the
   * editor's newest step too: it is undone here, whole, and this returns true. Otherwise the editor undoes its own
   * typing. Solo only: in a room the code's undo is the shared binding's, and program edits undo from the scene.
   *
   * `tableToo` also takes a program edit that did not touch the code - a task deleted, a program unscheduled. The
   * code editor leaves those alone (Ctrl+Z while typing must not quietly revert the task table in another dock);
   * the PLC panel's organizer and ladder view ask for them, because there the table edit is the thing just done,
   * and in a popped-out window no other Ctrl+Z exists to take it back.
   */
  undoProgramEditAt(source: string, tableToo = false): boolean {
    if (this.collab) return false
    const top = this.history.undoTop()
    if (top?.kind !== 'program' || (!tableToo && top.before.source === top.after.source) || top.after.source !== source) return false
    this.undo()
    return true
  }

  /** Ctrl+Y (or Ctrl+Shift+Z) in the code editor: the redo side of {@link undoProgramEditAt}. */
  redoProgramEditAt(source: string, tableToo = false): boolean {
    if (this.collab) return false
    const top = this.history.redoTop()
    if (top?.kind !== 'program' || (!tableToo && top.before.source === top.after.source) || top.before.source !== source) return false
    this.redo()
    return true
  }

  /** Dismiss the undo notice (its timer or the user's ✕). */
  dismissUndoNotice(): void {
    if (this.state.undoNotice) this.setState({ undoNotice: null })
  }

  /** Dismiss the demo-fork notice (its timer or the user's ✕). */
  dismissDemoForkNotice(): void {
    if (this.state.demoForkNotice) this.setState({ demoForkNotice: null })
  }

  /** Say what a save did and where the work is (editor/project/saveProject.ts, projectFolderSync). */
  showSaveNotice(title: string, message: string, action?: Notice['action']): void {
    this.setState({ saveNotice: { key: this.noticeSeq++, title, message, ...(action ? { action } : {}) } })
  }

  /** Dismiss the save notice (its timer, the user's ✕, or its action). */
  dismissSaveNotice(): void {
    if (this.state.saveNotice) this.setState({ saveNotice: null })
  }

  /** Show a report in the PLC panel, replacing the last one (see EditorState.stFileReport). */
  showStFileReport(report: Omit<StFileReportData, 'id'>): void {
    this.setState({ stFileReport: { ...report, id: this.program.nextReportId() } })
  }

  /** Dismiss the PLC panel's report: its ✕, or, with `staleOnly` on an edit, only a receipt the program has moved past.
   *  Never an import's checklist that way: it is a to-do list for exactly those edits (keepOnEdit). */
  dismissStFileReport(opts?: { staleOnly?: boolean }): void {
    const report = this.state.stFileReport
    if (!report || (opts?.staleOnly && report.keepOnEdit)) return
    this.setState({ stFileReport: null })
  }

  /** Show or hide warnings in the Problems dock (its toggle, and the PLC panel's "Show in Problems"). */
  setProblemsShowWarnings(show: boolean): void {
    if (show !== this.state.problemsShowWarnings) this.setState({ problemsShowWarnings: show })
  }

  /**
   * Adopt a program that arrived from the shared doc (a room's Y.Text landing after join, or a
   * peer's replacement). State only: it is the durable copy in a room, so persisting would echo,
   * and a mounted editor is already bound to the same text. No-op when nothing changed, which is
   * what keeps sink -> doc -> store from looping.
   */
  applyRemoteStProgram(source: string, scanMs?: number, controller?: Controller | null, dialect?: string | null): void {
    const nextScan = scanMs !== undefined ? clampScanMs(scanMs) : this.state.stScanMs
    const nextController = controller !== undefined ? controller : this.state.controller
    // like the table: undefined keeps this client's, null is the room's IEC
    const nextDialect = dialect !== undefined ? storedDialect(dialect) : this.state.stDialect
    if (
      source === this.state.stProgram &&
      nextScan === this.state.stScanMs &&
      sameController(nextController, this.state.controller) &&
      nextDialect === this.state.stDialect
    )
      return
    this.setState({ stProgram: source, stScanMs: nextScan, controller: nextController, stDialect: nextDialect })
  }

  /** Install the writer that keeps a step-rate change (room mode: the shared meta key). Null = solo. */
  setSimHzSink(sink: ((hz: SimRate) => void) | null): void {
    this.room.setSimHzSink(sink)
  }

  /**
   * Set the active scene's physics step rate (the Inspector's scene properties). Coerced here (toSimRate), the
   * one adoption point for a value that can arrive from the UI, a project doc, a scene file, or a peer. Kept
   * through the sink in a room, into the scene's slot of the project doc solo.
   *
   * Inert in the demo preview, which the Inspector says: the demo is an ephemeral view that only an edit to its
   * layout forks. `persist: false` sets it without keeping it: a scene load, where the document already holds
   * the rate. A running world is never retuned: it keeps the rate it was built at until the next run
   * (SimClient.runHz).
   */
  setSimHz(hz: number, opts?: { persist?: boolean }): void {
    const persist = opts?.persist !== false
    if (persist && (this.readOnly || this.state.demoSession)) return
    const next = toSimRate(hz)
    if (next === this.state.simHz) return
    this.setState({ simHz: next })
    if (!persist) return
    if (!this.room.keepSimHz(next)) this.persistProject()
  }

  /** Adopt the room's step rate (join + a peer's change). State only: the doc is the durable copy, so
   *  persisting would echo, and the equality check is what keeps sink -> doc -> store from looping. */
  applyRemoteSimHz(hz: SimRate): void {
    if (hz === this.state.simHz) return
    this.setState({ simHz: hz })
  }

  /** Keep the current program: through the sink in a room, else localStorage + the project doc. */
  private persistStProgram(): void {
    const { stProgram, stScanMs, controller, stDialect } = this.state
    if (this.program.keep({ source: stProgram, scanMs: stScanMs, controller, ...(stDialect !== undefined ? { dialect: stDialect } : {}) })) return
    saveStProgram(stProgram)
    saveStScanMs(stScanMs)
    noteLegacyWrite('program')
    // fold it into the unified project autosave too: a program-only change has no scene commit to
    // ride along with (see projectFile.ts)
    this.persistProject()
  }

  /** subscribe to panel-reveal requests (App applies them to the dock layout) */
  onRevealPanel = (cb: (panel: DockPanelId) => void): (() => void) => this.reveals.onRevealPanel(cb)

  /** ask the app to surface a dock panel: front tab of its slot, dock un-collapsed */
  revealPanel(panel: DockPanelId): void {
    this.reveals.revealPanel(panel)
  }

  /** subscribe to ST cursor-reveal requests (the mounted ST editor applies them) */
  onRevealStOffset = (cb: (offset: number) => void): (() => void) => this.reveals.onRevealStOffset(cb)

  /** ask the ST editor to put the cursor at `offset` and scroll it into view */
  revealStOffset(offset: number): void {
    this.reveals.revealStOffset(offset)
  }

  /** subscribe to "type into the code" requests (the mounted ST editor serves them while it shows text) */
  onFocusStCode = (cb: () => void): (() => void) => this.reveals.onFocusStCode(cb)

  /** ask the ST editor to take the keyboard (a click on the PLC panel's dock tab) */
  focusStCode(): void {
    this.reveals.focusStCode()
  }

  /** subscribe to "show the tasks" requests (the mounted PLC panel's organizer serves them) */
  onRevealStOrganizer = (cb: () => void): (() => void) => this.reveals.onRevealStOrganizer(cb)

  /** ask the PLC panel's organizer to show the controller's tasks */
  revealStOrganizer(): void {
    this.reveals.revealStOrganizer()
  }
  onRevealTreeSelection = (cb: () => void): (() => void) => this.reveals.onRevealTreeSelection(cb)

  getState = (): EditorState => this.state

  get canUndo(): boolean {
    return this.history.canUndo
  }

  get canRedo(): boolean {
    return this.history.canRedo
  }

  /** @internal test hook - the solo undo stack, oldest first (e2e/verify-flex-conveyor-drag reads its depth) */
  get undoStack(): readonly HistoryEntry[] {
    return this.history.undoEntries
  }

  /** wire the collab bridge's Y.UndoManager-backed undo (room mode); null restores solo undo */
  setUndoDelegate(delegate: UndoDelegate | null): void {
    this.history.setDelegate(delegate)
  }

  /**
   * The edit feed shown by the History dock. Solo: a projection of the snapshot undo stacks
   * (cursor tracks undo/redo; jumping is supported). Room: the shared activity feed handed
   * over by the collab bridge - attributed, capped, and read-only (no jump; the client-scoped
   * Y.UndoManager owns undo there).
   */
  getEditHistory(): EditHistory {
    return this.history.getEditHistory()
  }

  /**
   * Jump to a history position (the History dock's click-to-jump): 0 = before the oldest
   * recorded edit, events.length = the newest. Implemented as repeated undo()/redo() so mixed
   * scene + package entries replay in order through the exact code paths Ctrl+Z uses.
   */
  jumpToHistory(cursor: number): void {
    if (this.collab) return // rooms have no snapshot stacks to walk (see getEditHistory)
    while (this.history.undoDepth > cursor && this.history.undoDepth > 0) this.undo()
    while (this.history.undoDepth < cursor && this.history.redoDepth > 0) this.redo()
  }

  /**
   * Enter/leave collaborative (room) mode. In a room the shared Yjs doc owns history and
   * persistence: the snapshot undo stack is disabled (undoing your snapshot would clobber
   * peers' concurrent edits; the room's Y.UndoManager handles undo, collab/bridge.ts) and localStorage
   * autosave is skipped (IndexedDB/the server are the durable store).
   */
  setCollabMode(enabled: boolean): void {
    this.collab = enabled
    if (enabled) this.history.clear()
    this.history.setRemoteFeed(null) // fresh on enter (the bridge syncs it), stale on leave - drop either way
    this.setState({ collab: enabled })
  }

  /**
   * Enter view-only mode (a shared read-only room link). Authoring commits become no-ops and
   * the collab bridge is wired to never push to the doc, so this client watches the live scene
   * and can run its own private sim, but cannot edit the shared design. The UI reads
   * `state.readOnly` to disable editing affordances and show a "View only" badge.
   */
  setReadOnly(enabled: boolean): void {
    this.readOnly = enabled
    this.setState({ readOnly: enabled })
  }

  /**
   * Apply a scene received from a remote peer (the collab bridge). Behaves like a transient
   * set: it drives the viewport + any running sim via viewListeners and refreshes the React
   * panels, but pushes no undo history, clears no redo, and does not persist. It leaves
   * all local state (selection, tool, mode, running) untouched. Echo back into the doc is
   * prevented by the bridge's origin/re-entrancy guards.
   */
  applyRemote(scene: SceneJSON): void {
    // with the Part Editor open the line is parked (packageEdit.document), so a peer's edit lands there, not in the session
    const pe = this.state.packageEdit
    this.setState(pe ? { packageEdit: { ...pe, document: scene } } : { scene })
  }

  /** force-write the current scene to the solo autosave key (no-op in collab mode) */
  flushAutosave(): void {
    this.persist()
  }

  /**
   * Set the authored scene without an undo entry, persisting (solo) and broadcasting (collab) - but only
   * persisting when the document changed (documentChanged). Used to reset runtime-only state on Stop (the
   * run-promoted spawner boxes): a sim run's side effects were never edits, so they must not become an
   * undoable step, and dropping them changes nothing the document ever held - so no write, and no demo fork
   * from a Stop after someone clicked a moving box.
   */
  setAuthored(scene: SceneJSON): void {
    const changed = this.run.documentChanged(this.state.scene, scene, this.state.packageEdit)
    this.setState({ scene })
    if (changed) this.persist()
  }

  /**
   * A scene change the run owns, not the user: minting a part for a spawner box someone clicked so the
   * editor has something to select, outline and drag. It updates the scene (the renderer, inspector and
   * gizmo all address cargo by part id) and stops there - no undo entry, and no autosave.
   *
   * Both omissions are deliberate. `stop()` deletes these parts again, so an undo entry for one is an
   * entry for something the user never authored, and a write is a write of content that will not exist
   * in a moment. Writing would also be the expensive half of clicking a moving box: persist() serialises
   * the scene and the whole project document synchronously (measured 10-16 ms of a 13-21 ms commit on a
   * 199-part scene), and it calls `stashDemoSession`, so merely selecting a box in a `?scene=demo`
   * session would adopt the demo as the user's project.
   *
   * A later real edit still persists, and documentOf keeps the run's cargo out of that write too.
   */
  setRunScene(scene: SceneJSON): void {
    if (this.readOnly) return
    this.setState({ scene })
  }

  commit(label: string, after: SceneJSON, opts?: CommitOptions): void {
    // view-only client: drop the edit so it never persists or reaches the shared doc. Re-assert
    // the authoritative scene first, so any in-flight transient preview (a drag/inspector change
    // that slipped through) is reverted on screen instead of left stuck. All authoring funnels
    // through commit, so this single gate makes the whole editor read-only (the bridge enforces
    // doc integrity independently).
    if (this.readOnly) {
      this.setState({ scene: this.state.scene })
      return
    }
    // The edit gate. An edit is a change to the document (documentChanged), whichever gesture made it. Only then
    // is there an undo step, an autosave (and with it a folder write and a demo fork) or a room-feed line.
    // Moving, deleting or copying a box the run owns reaches here like any drag or delete, and is run state:
    // it shows on screen and stops there. Decided here rather than by each caller picking a write path, so no
    // caller (Stop, a live-box drag) can fork the demo by picking the wrong one.
    const before = opts?.before ?? this.state.scene
    if (!this.run.documentChanged(before, after, this.state.packageEdit)) {
      this.setState({ scene: after })
      return
    }
    // the undo step's `before` is the document as it stood - taken before a carry moves any box's designed pose
    const docBefore = this.run.documentOf(before)
    this.run.carry(before, after)
    const live = this.liveEdit.active
    this.liveEdit.track(before, after)
    if (this.collab) {
      // no snapshot history in a room, but the edit's label still reaches the shared feed -
      // the bridge's scene diffing would otherwise lose it (this is the only label crossing)
      this.room.feed(() => ({ label, time: Date.now(), kind: 'scene', coalesceKey: opts?.coalesceKey }))
      this.setState({ scene: after })
      this.persist()
      return
    }
    const now = Date.now()
    // the newest step, unless an undo/redo boundary sits on it (UndoHistory.coalescibleTop)
    const top = this.history.coalescibleTop()
    if (
      opts?.coalesceKey !== undefined &&
      top?.kind === 'scene' &&
      top.coalesceKey === opts.coalesceKey &&
      // a live edit is one gesture however long the hand pauses in it
      (now - top.time < COALESCE_MS || this.liveEdit.wrote)
    ) {
      // a continuing gesture (a scrub, a colour drag, typing in a number field): the undo step absorbed it,
      // and so does the autosave - its first commit wrote, the rest trail (see deferPersist)
      this.history.replaceTop({ ...top, after: this.run.documentOf(after), time: now })
      if (live) {
        this.commitLive(after)
        return
      }
      this.setState({ scene: after })
      this.deferPersist()
      return
    } else {
      // the history holds documents: a box the run owns in either snapshot would come back as authored content
      // from an undo after Stop (withRunParts puts the live ones back when an entry is applied mid-run)
      this.history.record({
        kind: 'scene',
        label,
        coalesceKey: opts?.coalesceKey,
        before: docBefore,
        after: this.run.documentOf(after),
        time: now,
      })
    }
    if (live) {
      this.commitLive(after)
      return
    }
    this.setState({ scene: after })
    this.persist()
  }

  /**
   * Open a live edit: a pointer gesture on an Inspector field (a scrub, a held spin arrow) that commits at input
   * rate. Its commits are still real edits (the edit gate, one coalesced undo step) but they go through the
   * transient stream, like a part drag's setTransient: no React render and no autosave per step, and the parts they change
   * are ejected from the instance pool and the render bundles for the gesture (liveEditIds → the controller's
   * pushPoolDrag), so a length scrub doesn't rebuild the pool or re-record every bundle per step. endLiveEdit is
   * the release: one React render, one trailing autosave, one re-pool. In a room nothing changes but the
   * ejection - the bridge reads the React channel, so peers keep seeing every step.
   */
  beginLiveEdit(): void {
    this.liveEdit.begin()
  }

  endLiveEdit(): void {
    const live = this.liveEdit.end()
    if (!live) return
    if (!live.wrote && live.ids.size === 0) return
    // a fresh state object: React (and the collab bridge) catch up, and the controller's pushPoolDrag re-pools
    this.setState({})
    if (live.wrote) this.deferPersist()
  }

  /** the parts an open live edit has changed so far, or null (see beginLiveEdit) */
  liveEditIds(): string[] | null {
    return this.liveEdit.ids()
  }

  private commitLive(after: SceneJSON): void {
    this.liveEdit.markWrote()
    this.autosave.markScene() // written by endLiveEdit's deferPersist, or flushPersist on unload
    this.setState({ scene: after }, true)
  }

  /** Commit a part package edit to the undo history and the registry (storePackages.ts). */
  commitPackage(label: string, pkg: PartPackage, opts?: { coalesceKey?: string; before?: PartPackage }): void {
    library.commitPackage(this, this.libraryAreas, label, pkg, opts)
  }

  setTransient(scene: SceneJSON, selectedIds?: readonly string[]): void {
    // selectedIds is threaded only by a Shift+drag duplicate, which retargets the selection onto
    // the staged clones so the view/gizmo follow them; like the scene it stays out of React (the
    // transient stream) and is reconciled by the release commit / cancel revert.
    this.setState(selectedIds ? { scene, selectedIds: [...selectedIds] } : { scene }, true)
  }

  /**
   * Author-mode live preview of a package edit during a drag: register it + a transient store pump. The pump
   * notifies the controller (subscribeView → onStoreChange → pushGizmo) so the gizmo follows the node, exactly
   * like a part drag through setTransient. React skips the transient stream, and no undo step is recorded.
   * The release `commitPackage` records the single undo entry and triggers the React re-render.
   */
  setTransientPackage(pkg: PartPackage): void {
    if (this.readOnly) return
    registerPackage(pkg)
    this.setState({ packageRev: this.state.packageRev + 1 }, true)
  }

  undo(): void {
    // in a room the Y.UndoManager reverts this client's edits in the shared doc; the bridge's
    // observer then flows the result back through applyRemote, so no setState here
    if (this.collab) {
      this.history.delegateUndo()
      return
    }
    const entry = this.history.takeUndo()
    if (!entry) return
    // an edit made outside the part being edited is undone in the scene it was made in: leave the session first
    if (entry.kind !== 'package' && this.state.packageEdit) this.exitPartFocus()
    if (entry.kind === 'program') {
      const code = this.programCode(entry, 'undo')
      if (code === null) return
      this.history.pushRedo(entry)
      this.applyProgramDoc({ ...entry.before, source: code }, entry.sceneBefore && this.run.adopt(entry.sceneBefore, this.state.scene))
      return
    }
    this.history.pushRedo(entry)
    if (entry.kind === 'package') {
      registerPackage(entry.before)
      this.setState({ packageRev: this.state.packageRev + 1 })
      syncUserCatalog(this, entry.before)
      return
    }
    this.setState({ scene: this.run.adopt(entry.before, this.state.scene) })
    this.persist()
  }

  redo(): void {
    if (this.collab) {
      this.history.delegateRedo()
      return
    }
    const entry = this.history.takeRedo()
    if (!entry) return
    if (entry.kind !== 'package' && this.state.packageEdit) this.exitPartFocus()
    if (entry.kind === 'program') {
      const code = this.programCode(entry, 'redo')
      if (code === null) return
      this.history.pushUndo(entry)
      this.applyProgramDoc({ ...entry.after, source: code }, entry.sceneAfter && this.run.adopt(entry.sceneAfter, this.state.scene))
      return
    }
    this.history.pushUndo(entry)
    if (entry.kind === 'package') {
      registerPackage(entry.after)
      this.setState({ packageRev: this.state.packageRev + 1 })
      syncUserCatalog(this, entry.after)
      return
    }
    this.setState({ scene: this.run.adopt(entry.after, this.state.scene) })
    this.persist()
  }

  select(id: string | null): void {
    if (id === null) {
      this.clearSelection()
      return
    }
    const cur = this.state.selectedIds
    if (cur.length === 1 && cur[0] === id && this.state.selectedRigNode === null) return
    this.setState({ selectedIds: [id] })
  }

  /**
   * shift-click. The active node is the
   * last id in `selectedIds`. Shift-clicking:
   *  - an unselected part adds it, making it the active node (appended to the back);
   *  - the already-active part deselects it;
   *  - an already-selected, non-active part promotes it to the active node (moved to the
   *    back) rather than deselecting - so a shift-click switches which part is active.
   */
  toggleSelect(id: string): void {
    const cur = this.state.selectedIds
    if (!cur.includes(id)) {
      this.setState({ selectedIds: [...cur, id] })
      return
    }
    if (id === cur[cur.length - 1]) {
      this.setState({ selectedIds: cur.filter((x) => x !== id) })
    } else {
      this.setState({ selectedIds: [...cur.filter((x) => x !== id), id] })
    }
  }

  clearSelection(): void {
    if (this.state.selectedIds.length === 0 && this.state.selectedRigNode === null) return
    this.setState({ selectedIds: [], selectedRigNode: null })
  }

  openListSelect(menu: ListSelectMenu): void {
    this.setState({ listSelect: menu })
  }

  closeListSelect(): void {
    if (this.state.listSelect === null) return
    this.setState({ listSelect: null })
  }

  /** Open the in-browser behavior-script editor for a custom part's package (the scene-tree </> badge, the
   * Inspector "Edit behavior…" button, etc. all funnel here so there's one shared editor mount in App). */
  openBehaviorEditor(packageId: string): void {
    if (this.state.behaviorEditTarget === packageId) return
    this.setState({ behaviorEditTarget: packageId })
  }

  closeBehaviorEditor(): void {
    if (this.state.behaviorEditTarget === null) return
    this.setState({ behaviorEditTarget: null })
  }

  /** Select a part and ask the Inspector to bring one of its params into view and focus (see `paramFocus`). */
  requestParamFocus(partId: string, param: string): void {
    this.setState({ selectedIds: [partId], paramFocus: { partId, param, seq: (this.state.paramFocus?.seq ?? 0) + 1 } })
  }

  clearParamFocus(): void {
    if (this.state.paramFocus === null) return
    this.setState({ paramFocus: null })
  }

  selectMany(ids: readonly string[]): void {
    this.setState({ selectedIds: [...ids] })
  }

  /**
   * Author-mode: select one internal rig link of a custom part for read-only inspection (the rig's
   * structure is authored in the part script, not editable here). Clears the part-level selection - the
   * two are mutually exclusive. Caller gates this to the part's open scene; the store just records it.
   */
  selectRigNode(partId: string, linkName: string): void {
    const cur = this.state.selectedRigNode
    if (cur && cur.partId === partId && cur.linkName === linkName) return
    this.setState({ selectedRigNode: { partId, linkName } })
  }

  /** Author-mode rig-node lock (editor-only): suppress one link's viewport selection + transform gizmo.
   *  A locked node keeps any existing tree selection (so it's still inspectable); the gizmo is hidden by
   *  gizmoVisible and the viewport click-pick skips it (see controller). Not undoable, not serialized. */
  setRigNodeLocked(partId: string, linkName: string, locked: boolean): void {
    const key = rigNodeKey(partId, linkName)
    const cur = this.state.lockedRigNodes
    if (locked === cur.has(key)) return
    const next = new Set(cur)
    if (locked) next.add(key)
    else next.delete(key)
    this.setState({ lockedRigNodes: next })
  }

  isRigNodeLocked(partId: string, linkName: string): boolean {
    return this.state.lockedRigNodes.has(rigNodeKey(partId, linkName))
  }

  setTool(tool: ToolMode): void {
    if (tool === this.state.tool) return
    this.setState({ tool })
  }

  setLiveSnap(liveSnap: boolean): void {
    if (liveSnap === this.state.liveSnap) return
    this.setState({ liveSnap })
    persistPref(LIVESNAP_KEY, String(liveSnap))
  }

  setFaceSnap(faceSnap: boolean): void {
    if (faceSnap === this.state.faceSnap) return
    this.setState({ faceSnap })
    persistPref(FACESNAP_KEY, String(faceSnap))
  }

  setSpace(space: TransformSpace): void {
    if (space === this.state.space) return
    this.setState({ space })
    persistPref(SPACE_KEY, space)
  }

  toggleSpace(): void {
    this.setSpace(this.state.space === 'local' ? 'global' : 'local')
  }

  setGridSnap(patch: Partial<GridSnap>): void {
    const next = { ...this.state.gridSnap, ...patch }
    const cur = this.state.gridSnap
    if (next.enabled === cur.enabled && next.translate === cur.translate && next.rotate === cur.rotate) return
    this.setState({ gridSnap: next })
    persistPref(GRIDSNAP_KEY, JSON.stringify(next))
  }

  toggleGridSnap(): void {
    this.setGridSnap({ enabled: !this.state.gridSnap.enabled })
  }

  setShowNotes(showNotes: boolean): void {
    if (showNotes === this.state.showNotes) return
    this.setState({ showNotes })
    persistPref(SHOWNOTES_KEY, String(showNotes))
  }

  toggleShowNotes(): void {
    this.setShowNotes(!this.state.showNotes)
  }

  setFlowArrows(flowArrows: boolean): void {
    if (flowArrows === this.state.flowArrows) return
    this.setState({ flowArrows })
    persistPref(FLOWARROWS_KEY, String(flowArrows))
  }

  toggleFlowArrows(): void {
    this.setFlowArrows(!this.state.flowArrows)
  }

  setShowStats(showStats: boolean): void {
    if (showStats === this.state.showStats) return
    this.setState({ showStats })
    persistPref(SHOWSTATS_KEY, String(showStats))
  }

  toggleShowStats(): void {
    this.setShowStats(!this.state.showStats)
  }

  setTreeTypes(treeTypes: boolean): void {
    if (treeTypes === this.state.treeTypes) return
    this.setState({ treeTypes })
    persistPref(TREETYPES_KEY, String(treeTypes))
  }

  toggleTreeTypes(): void {
    this.setTreeTypes(!this.state.treeTypes)
  }

  /** Enter or leave guard-openings mode. Entering is refused unless the selection is one conveyor that authors
   *  guardOpenings; returns whether the mode is now on. */
  setSideGuardMode(sideGuardMode: boolean): boolean {
    if (sideGuardMode && (this.state.readOnly || !guardOpeningsTarget(this.state))) return false
    if (sideGuardMode !== this.state.sideGuardMode) this.setState({ sideGuardMode, selectedGuardOpening: null })
    return sideGuardMode
  }

  toggleSideGuardMode(): boolean {
    return this.setSideGuardMode(!this.state.sideGuardMode)
  }

  /** Remove the selected guard opening from its wall, one undo step (a both-sided row keeps cutting the other
   *  wall). False when there is none to remove. What Delete does in guard-openings mode. */
  removeSelectedGuardOpening(): boolean {
    const s = this.state
    const part = guardOpeningsTarget(s)
    const sel = s.selectedGuardOpening
    if (s.readOnly || !s.sideGuardMode || !part || !sel) return false
    const specs = rowsToOpeningSpecs((part.params as { guardOpenings?: number[][] }).guardOpenings ?? [])
    if (!specs[sel.index]) {
      this.setSelectedGuardOpening(null)
      return false
    }
    const rows = openingSpecsToRows(removeFromWall(specs, sel.index, sel.guard))
    this.commit('Remove guard opening', {
      ...s.scene,
      parts: s.scene.parts.map((p) => (p.id === part.id ? ({ ...p, params: { ...p.params, guardOpenings: rows } } as unknown as PartInstance) : p)),
    })
    this.setSelectedGuardOpening(null)
    return true
  }

  setSelectedGuardOpening(sel: { index: number; guard: 'left' | 'right' } | null): void {
    const cur = this.state.selectedGuardOpening
    if (sel === cur || (sel && cur && sel.index === cur.index && sel.guard === cur.guard)) return
    this.setState({ selectedGuardOpening: sel })
  }

  /** Change the default controller's link (any subset): what runs it and its protocol are edits, the rest this computer's
   *  address (storePlcs.ts). Applies on the next Play, except the OPC UA server, which starts and stops as it is switched. */
  setExternalPlc(patch: Partial<ExternalPlcSettings>): void {
    setPlcLink(this, null, patch)
  }

  /** This computer's PLC preferences (storePlcs.ts), kept in localStorage. */
  setPlcPrefs(plcPrefs: ExternalPlcSettings): void {
    this.setState({ plcPrefs })
    persistPref(EXTERNAL_PLC_KEY, JSON.stringify(plcPrefs))
  }

  /** Add a PLC controller to the scene, as an edit; false when the name is refused or the list is full. */
  addNamedPlc(name: string): boolean {
    return addPlc(this, name)
  }

  /** Rename a controller and every tag on it, as one edit (storePlcs.ts renamePlc); false when refused. */
  renameNamedPlc(from: string, to: string): boolean {
    return renamePlc(this, from, to)
  }

  /** Run a controller (null: the default one) in the simulator or on a PLC outside it, as an edit (storePlcs.ts). */
  setPlcRunsOn(name: string | null, runsOn: 'app' | 'plc'): void {
    setRunsOn(this, name, runsOn)
  }

  /** Change a named controller's link (any subset), or remove it from the scene (null). */
  setNamedPlc(name: string, patch: Partial<PlcLinkSettings & UaServerSettings> | null): void {
    if (patch === null) removePlc(this, name)
    else setPlcLink(this, name, patch)
  }

  setShowGrid(showGrid: boolean): void {
    if (showGrid === this.state.showGrid) return
    this.setState({ showGrid })
    persistPref(SHOWGRID_KEY, String(showGrid))
  }

  toggleGrid(): void {
    this.setShowGrid(!this.state.showGrid)
  }

  setTrackball(trackball: boolean): void {
    if (trackball === this.state.trackball) return
    this.setState({ trackball })
    persistPref(TRACKBALL_KEY, String(trackball))
  }

  toggleTrackball(): void {
    this.setTrackball(!this.state.trackball)
  }

  /**
   * Not persisted as a preference: an orthographic frustum is derived from the camera→target distance
   * (EditorCamera.setFocusDistance), so restoring "orthographic" apart from the pose it was framed at
   * would come back at an arbitrary zoom. It is kept with that pose, per scene, and restored with it -
   * see EditorController.restoreCamera / editor/store/storePrefs viewport state.
   */
  setProjection(projection: ProjectionMode): void {
    if (projection === this.state.projection) return
    this.setState({ projection })
  }

  toggleProjection(): void {
    this.setProjection(this.state.projection === 'perspective' ? 'orthographic' : 'perspective')
  }

  setVertexSnapOriginMode(vertexSnapOriginMode: boolean): void {
    if (vertexSnapOriginMode === this.state.vertexSnapOriginMode) return
    this.setState({ vertexSnapOriginMode })
    persistPref(VSNAP_ORIGIN_KEY, String(vertexSnapOriginMode))
  }

  setVertexSnapCollision(vertexSnapCollision: boolean): void {
    if (vertexSnapCollision === this.state.vertexSnapCollision) return
    this.setState({ vertexSnapCollision })
    persistPref(VSNAP_COLLISION_KEY, String(vertexSnapCollision))
  }

  startPlacing(type: PartType, packageId: string | null = null): void {
    if (this.readOnly) return // a viewer can't add parts (no placement ghost)
    this.setState({ mode: 'placing', placingType: type, placingPackageId: packageId, selectedIds: [] })
  }

  cancelPlacing(): void {
    if (this.state.mode !== 'placing') return
    this.setState({ mode: 'idle', placingType: null, placingPackageId: null })
  }

  /**
   * Fold a batch of desktop package build results into the UI: clear the error badge for any part that now
   * builds, set it for any that fails, and raise a one-shot toast per new failure. Without this the
   * PackageLibrary's statuses would be computed and discarded, and a custom part that failed to compile on save
   * would silently keep its last-good version with no signal to the author. See connectDesktopPackages.
   */
  applyPackageStatuses(statuses: PackageStatus[]): void {
    const errors = { ...this.state.packageBuildErrors }
    const notices = [...this.state.partBuildNotices]
    for (const s of statuses) {
      if (s.ok) {
        delete errors[s.id]
        continue
      }
      const message = s.error ?? 'failed to build'
      // only toast a failure that is new or whose message changed - re-emitting the same error on every
      // unrelated workspace rescan would spam the corner.
      if (errors[s.id] !== message) {
        notices.push({ key: this.noticeSeq++, id: s.id, name: s.name, error: message })
      }
      errors[s.id] = message
    }
    this.setState({ packageBuildErrors: errors, partBuildNotices: notices })
  }

  /** Dismiss a build-failure toast (auto-dismiss timer or the user's ✕). The badge stays until a good rebuild. */
  dismissPartBuildNotice(key: number): void {
    this.setState({ partBuildNotices: this.state.partBuildNotices.filter((n) => n.key !== key) })
  }

  /** Add (or replace by id) an in-app authored part in the library (storePackages.ts). */
  addUserPackage(pkg: PartPackage): void {
    library.addUserPackage(this, this.libraryAreas, pkg)
  }

  /** Everything that still places a part, as holders a person reads (storePackages.ts). */
  packageUsage(packageId: string): string[] {
    return library.packageUsage(this, packageId)
  }

  /** Delete a part from the library, or revert a built-in's copy (storePackages.ts). Whether it did. */
  removeUserPackage(packageId: string): boolean {
    return library.removeUserPackage(this, this.libraryAreas, packageId)
  }

  /** Give a project's own part a new id, moving every placed copy (storePackages.ts). '' or why not. */
  renameUserPackage(from: string, to: string): string {
    return library.renameUserPackage(this, this.libraryAreas, from, to)
  }

  /** Take the app's current version of these built-ins as the project's copies (storePackages.ts). */
  updateFromApp(packageIds: readonly string[]): string[] {
    return library.updateFromApp(this, this.libraryAreas, packageIds)
  }

  /**
   * In a room, send a library change that is not a part edit (taking the app's version, keeping the project's) to
   * everyone there, with its line in the room's feed. Nothing in solo, where the library is saved with the project.
   */
  sharePackageChange(pkg: PartPackage, label: string): void {
    if (!this.collab) return
    this.room.feed(() => ({ label, time: Date.now(), kind: 'package' }))
    this.room.sendPackage(pkg)
  }

  /**
   * Restore in-app authored parts from localStorage at startup: validate each, register it (so render + the
   * Inspector resolve it and any placed instance picks up its latest version, overriding the possibly-stale
   * copy a loaded scene embedded), and surface it in the catalog so it stays placeable. Solo only. The
   * project-doc boot path uses {@link adoptProjectLibrary} instead, seeding from the loaded project's shared
   * library; this remains for the legacy/no-project fallback. (Body lives in storePackages.ts, with the
   * rest of the user-package persistence - syncUserCatalog / persistUserPackages.)
   */
  restoreUserPackages(): void {
    restoreUserPackagesFromStorage(this)
  }

  /** Register a project's library as the registry and catalog's parts, replacing the last (storePackages.ts). */
  adoptProjectLibrary(pkgs: readonly PartPackage[]): void {
    library.adoptProjectLibrary(this, pkgs)
  }

  /** Wire the collab bridge's package writer and remover (room mode); null in solo mode. See RoomSinks. */
  setPackageSink(sink: ((pkg: PartPackage) => void) | null, remove?: (id: string, revertTo: PartPackage | null) => void): void {
    this.room.setPackageSink(sink, remove)
  }

  /** Wire the collab bridge's edit-feed writer (room mode); null in solo mode. See RoomSinks. */
  setEditEventSink(sink: ((e: EditEventInput) => void) | null): void {
    this.room.setEditEventSink(sink)
  }

  /** Wire the controller's live-cargo seam (live poses + run-scoped adoption). See {@link LiveCargoHost}. */
  setLiveCargoHost(host: LiveCargoHost | null): void {
    this.run.setHost(host)
  }

  /**
   * Apply the room's shared edit feed (the collab bridge, on every feed change - local appends
   * included). Replaces the History dock's content while in a room; the cursor sits past the
   * newest event because a feed has no redo tail (jumping is solo-only).
   */
  applyRemoteEditFeed(events: EditEvent[]): void {
    this.history.setRemoteFeed({ events, cursor: events.length })
    this.setState({}) // no field changes; the fresh state identity re-renders the History panel
  }

  /** Register the parts a peer sent, and drop the ones a peer deleted (storePackages.ts). */
  applyRemotePackages(pkgs: PartPackage[], edited: ReadonlySet<string> = new Set(), removed: readonly string[] = []): void {
    library.applyRemotePackages(this, pkgs, edited, removed, this.room)
  }


  /**
   * Open a custom part "in its own scene" (sub-scene editing): the viewport isolates + frames it,
   * the Scene dock shows its rig as the tree. Selects the part so its inspector/gizmo are live. A no-op
   * unless the id is a custom part currently in the scene.
   */
  enterPartFocus(id: string): void {
    const part = this.state.scene.parts.find((p) => p.id === id)
    if (!part || part.type !== 'part') return
    if (this.state.focusedPartId === id) return
    this.setState({ focusedPartId: id, selectedIds: [id], selectedRigNode: null, mode: 'idle', placingType: null, placingPackageId: null })
  }

  /**
   * Open a part package's rig "as its own scene" to edit the definition with no placement (the Catalog ✎).
   * Stamps a throwaway custom instance of the package at the origin and focuses it, so the rig-node tools
   * (which only need a focused part in `scene.parts`) edit the package via the usual `commitPackage` path.
   * The session gets a scene of its own holding just the throwaway, and the document's scene is parked
   * (`packageEdit.document`) until Back: the throwaway is never in the document, so no undo step, autosave or
   * folder write can hold it, while everything that reads `scene` (tree, Inspector, picking, drags, Play) sees
   * the part it is editing with no special case. Only the session's package edits reach the history. Blocked
   * while running a sim is the caller's job (openPartScene pattern). In a room the bridge keeps the room's scene in the
   * parked document while it is open (collab/bridge.ts). No-op in read-only, or when a session is already open / the
   * package is unknown. Returns false when nothing was opened.
   */
  enterPackageEdit(packageId: string): boolean {
    if (this.readOnly || this.state.packageEdit) return false
    const pkg = getPackage(packageId)
    if (!pkg) return false
    const scene = this.state.scene
    const id = nextId(scene, 'part')
    // The session's scene and the session arrive in one state change, not through commit: opening it is not an
    // edit, and a state with the session open but its throwaway missing is what the controller's stranded-session
    // guard tears down. It is left unnamed, so every label of it (breadcrumb, Scene dock row, Inspector) is the
    // package's name and follows a rename of the part (partDisplayName).
    // Origin in x/z, but resting on the floor so the throwaway isn't half-buried. A raw y=0 seats the part's
    // origin on the floor, which only looks right for a bottom-origin part. A conveyor-mounted rig (Diverter, Blade
    // Stop, Chain Transfer) has its origin at the belt surface, so y=0 would sink its housing through the floor, and
    // a legged deck would hang its legs below it. floorRestPose is the placement drop's own floor branch.
    const base = createSdkPart(pkg, id, [0, 0, 0])
    const draft = { ...base, position: floorRestPose(base, 0, 0) }
    const document = this.run.documentOf(scene)
    this.setState({
      scene: { ...document, parts: [draft] },
      packageEdit: { packageId, partId: id, document },
      focusedPartId: id,
      selectedIds: [id],
      selectedRigNode: null,
      mode: 'idle',
      placingType: null,
      placingPackageId: null,
    })
    return true
  }

  /** Leave the part-scene and return to the full factory scene (the breadcrumb "Back"). For a package-edit
   *  session (`packageEdit`), also drop the throwaway origin instance - the package edits already live in the
   *  registry/catalog via commitPackage, so the session's scene is dropped and the parked document's
   *  scene put back, in the same state change that ends the session and its focus (not through commit: neither
   *  is an edit). A running sim is the caller's to stop first (controller.closePartScene): the live scene changes. */
  exitPartFocus(): void {
    const pe = this.state.packageEdit
    if (pe) {
      this.setState({
        scene: pe.document,
        packageEdit: null,
        focusedPartId: null,
        selectedRigNode: null,
        selectedIds: [],
      })
      return
    }
    if (this.state.focusedPartId === null) return
    this.setState({ focusedPartId: null, selectedRigNode: null })
  }

  /** Set the first-party bundled custom-part examples (called once at startup). */
  setBundledPackages(packages: PartPackage[]): void {
    this.setState({ bundledPackages: packages })
  }

  enterPilot(): void {
    if (this.state.mode === 'pilot') return
    this.setState({ mode: 'pilot', placingType: null, selectedIds: [], selectedRigNode: null, pilotPrompt: null })
  }

  exitPilot(): void {
    if (this.state.mode !== 'pilot') return
    this.setState({ mode: 'idle', pilotPrompt: null })
  }

  setPilotPrompt(prompt: string | null): void {
    if (prompt === this.state.pilotPrompt) return
    this.setState({ pilotPrompt: prompt })
  }

  /** Flash a transient hint over the viewport (auto-dismissed by the ViewportHint badge). A fresh
   * key even for identical text, so a repeat press visibly restarts the badge's dismiss timer. */
  flashViewportHint(text: string): void {
    this.setState({ viewportHint: { key: this.hintSeq++, text } })
  }

  /** Dismiss the hint iff it is still the one identified by `key` (a newer flash wins). */
  dismissViewportHint(key: number): void {
    if (this.state.viewportHint?.key !== key) return
    this.setState({ viewportHint: null })
  }

  /** mirror the camera's follow-mode target into state (drives the "Following X" badge); the
   * controller reconciles this each frame against the view's actual follow state */
  setFollowing(following: FollowState | null): void {
    const cur = this.state.following
    if (cur === following) return
    if (cur && following && cur.label === following.label && cur.ids.join(',') === following.ids.join(',')) return
    this.setState({ following })
  }

  /** mirror whether a camera-navigation gesture (freefly/pilot) owns the viewport into state; the
   * controller reconciles this each frame against view.isNavigating(). Deduped so it notifies React
   * only on the enter/exit edge, not every polled frame. */
  setNavigating(navigating: boolean): void {
    if (this.state.navigating === navigating) return
    this.setState({ navigating })
  }

  setRunning(running: boolean): void {
    if (running === this.state.running) return
    // Play snapshots where every placed box starts (RunOwnership's designed poses); Stop puts each one back there, in
    // the same setState as `running`, so nothing downstream sees a stopped scene with boxes where a mid-run drag left them.
    const scene = this.run.setRunning(running, this.state.scene)
    // starting or stopping always clears pause; only togglePause sets it while running. The
    // achieved-speed reading belongs to the run that produced it, so it clears on both edges.
    this.setState({ running, paused: false, speedActual: null, ...(scene !== this.state.scene ? { scene } : {}) })
  }

  setPaused(paused: boolean): void {
    if (paused === this.state.paused) return
    this.setState({ paused })
  }

  /** set the sim-clock speed multiplier; the controller pushes it to the running sim */
  setTimeScale(scale: number): void {
    if (scale === this.state.timeScale) return
    // the previous reading was measured against the old target - the clock re-measures
    this.setState({ timeScale: scale, speedActual: null })
  }

  /** mirror the sim clock's achieved rate (null = keeping up) into state. Polled per frame by the
   * controller, so it must stay deduped: only the enter/leave edge (and a 0.1 change) notifies React. */
  setSpeedActual(actual: number | null): void {
    if (actual === this.state.speedActual) return
    this.setState({ speedActual: actual })
  }

  // distraction-free mode: a transient view toggle (not persisted)
  toggleDistractionFree(): void {
    this.setState({ distractionFree: !this.state.distractionFree })
  }

  loadScene(scene: SceneJSON, opts?: { persist?: boolean }): void {
    // a view-only client must not replace the shared scene with a local one (New/Load); the UI
    // disables those entry points, this guards the rest (e.g. keyboard) for defence in depth
    if (this.readOnly) return
    // Register the scene's embedded custom-part packages into the main-thread registry so render
    // (createCustomVisual) + the Inspector (partParamSpecs) can resolve each custom part's geometry +
    // param schema. The sim worker registers its own copy separately (SimWorld constructor).
    registerScenePackages(scene.packages)
    this.history.clear()
    this.sceneLoads++ // before the setState below: its listeners read it
    // walkDoors: the walk session's door state names buildings by id, and a different scene can reuse the id. A
    // definition session ends: the document it parked is the one being replaced.
    const endSession = this.state.packageEdit ? { packageEdit: null, focusedPartId: null, selectedRigNode: null } : {}
    this.setState({ scene, selectedIds: [], walkDoors: null, walkFlex: null, usedIds: [], joggedIds: [], ...endSession })
    // a different scene's boxes: its own placed poses are the designed ones (ids can repeat across scenes)
    this.run.rebase(this.state.running, this.state.scene)
    // persist:false loads the scene live without writing the autosave key - used by the
    // ?scene=demo entry so opening the demo for a look never clobbers a returning user's
    // saved work. The first real edit persists normally (the demo becomes their work then).
    if (opts?.persist !== false) this.persist()
  }

  selectedParts(): PartInstance[] {
    const { scene, selectedIds } = this.state
    return scene.parts.filter((p) => selectionSet(selectedIds).has(p.id))
  }

  duplicateSelection(): void {
    const dup = this.duplicateSelectionDetached()
    if (!dup) return
    this.commit(this.state.selectedIds.length > 1 ? 'Duplicate parts' : 'Duplicate part', dup.scene)
    // select the clones of the originally-selected parts
    this.setState({ selectedIds: dup.selectionIds })
  }

  /**
   * Duplicate the selected subtree without committing: the raw material for a Shift+drag
   * duplicate. Returns the scene with fresh-id clones appended plus the ids of the clones of the
   * originally-selected roots (the new selection / drag target), or null if nothing is selected.
   * The caller stages the clones through a transient drag and records a single "Duplicate" undo step
   * on release (before = the pre-clone scene). Shares cloneWithFreshIds with duplicateSelection /
   * paste, so subtree relinking and name/id/instance freshening are identical.
   */
  duplicateSelectionDetached(): { scene: SceneJSON; selectionIds: string[] } | null {
    return copy.duplicateSelectionDetached(this, this.run.host)
  }

  /**
   * The walking character opens or closes one dock-door leaf, independently of
   * the other leaves. A walk-session change, not an edit (see {@link EditorState.walkDoors}): it starts from
   * what the building shows - the authored `openDoors`, or this session's own state for it - and never
   * touches the scene, so nothing is committed, persisted or undoable and the demo view does not fork. Walk
   * mode only. A leaf will not close onto something standing in its doorway (a conveyor run out of the trailer):
   * the press is refused with a hint, and the door stays open. Returns true when the leaf moved.
   */
  toggleWalkDoorLeaf(buildingId: string, leafKey: string): boolean {
    if (this.state.mode !== 'pilot') return false
    const part = this.state.scene.parts.find((p) => p.id === buildingId)
    if (!part || part.type !== 'building') return false
    const open = new Set(this.state.walkDoors?.[buildingId] ?? part.params.openDoors ?? [])
    if (open.has(leafKey)) {
      // judged on the scene the character walks in: a flex pulled out of the doorway this session no longer blocks it
      const walkFlex = this.state.walkFlex
      const parts = walkFlex === null
        ? this.state.scene.parts
        : this.state.scene.parts.map((p) => (walkFlex[p.id] ? withFlexPose(p, walkFlex[p.id]!) : p))
      const blocker = dockOpeningBlocker(part, leafKey, parts)
      if (blocker) {
        this.flashViewportHint(`Door blocked by ${partDisplayName(blocker, parts)}`)
        return false
      }
      open.delete(leafKey)
    } else open.add(leafKey)
    this.setState({ walkDoors: { ...this.state.walkDoors, [buildingId]: [...open] } })
    return true
  }

  /**
   * The walking character lays a flex conveyor into a new shape and place (`pose`, core flexPull). A walk-session
   * change, not an edit (see {@link EditorState.walkFlex}). Walk mode only.
   */
  setWalkFlex(partId: string, pose: FlexPose): boolean {
    if (this.state.mode !== 'pilot') return false
    if (!this.state.scene.parts.some((p) => p.id === partId)) return false
    this.setState({ walkFlex: { ...this.state.walkFlex, [partId]: pose } })
    return true
  }

  copySelection(): void {
    copy.copySelection(this, this.run.host)
  }

  paste(): void {
    copy.paste(this, this.run.host)
  }

  deleteSelection(): void {
    tree.deleteSelection(this)
  }

  /** "Cut" (Ctrl+X): copy the selection to the clipboard, then
   * delete it. The clipboard write isn't undoable; the deletion is the one undo
   * step, so undo restores the parts while the clipboard stays primed for paste. */
  cutSelection(): void {
    if (this.state.selectedIds.length === 0) return
    this.copySelection()
    this.deleteSelection()
  }

  /**
   * "Move Up"/"Move Down" (Ctrl+Up / Ctrl+Down): shift
   * every selected part one slot toward the top (dir -1) or bottom (dir +1) of the
   * order, preserving their relative order. The whole move is a no-op when any
   * selected part already sits at that edge - a block pinned to the end can't be
   * pushed off it.
   */
  moveSelection(dir: -1 | 1): void {
    tree.moveSelection(this, dir)
    this.reveals.revealTreeSelection() // the selection is unchanged, so the tree would not follow the row by itself
  }

  rename(id: string, name: string): void {
    tree.rename(this, id, name)
  }

  setVisible(ids: readonly string[], visible: boolean): void {
    tree.setVisible(this, ids, visible)
  }

  /**
   * lock/unlock: toggle each part's locked flag in one undo
   * step. Locked parts drop out of viewport picking and show no gizmo, but stay
   * selected and fully editable from the tree. Mirrors setVisible's flag handling.
   */
  setLocked(ids: readonly string[], locked: boolean): void {
    tree.setLocked(this, ids, locked)
  }

  /**
   * "Select as one" / "Select parts individually" (the UI name for the `grouped` flag): toggle it on
   * each part in one undo step. A flagged part absorbs viewport clicks on its descendants (the subtree
   * selects as one); the tree still selects parts individually. Mirrors setLocked.
   */
  setGrouped(ids: readonly string[], grouped: boolean): void {
    tree.setGrouped(this, ids, grouped)
  }

  reorder(orderedIds: readonly string[]): void {
    tree.reorder(this, orderedIds)
  }

  /**
   * Soft-parenting reparent (tree drag / "Unparent"): set `ids`' parent to
   * `parentId`, or to a root with null. Positions are unchanged (world-space).
   * A part is skipped if the move would make it its own ancestor (a cycle).
   */
  reparent(ids: readonly string[], parentId: string | null): void {
    tree.reparent(this, ids, parentId)
  }

  /**
   * "Unparent" (the tree menu, a drop on the tree's empty space): lift `ids` to the top of the
   * document being edited. That is the scene root at the base scene, but the focused part inside a
   * part-scene / package session, whose subtree is all the dock shows there. Lifting a part past it
   * would make the part vanish from the dock.
   */
  unparent(ids: readonly string[]): void {
    tree.unparent(this, ids)
  }

  /**
   * "Reparent to New Node": wrap the selection in
   * a fresh Group node at its centroid and parent it under their common parent (or the
   * root - the focused part, inside a focus session: see `unparent`). Only the top-level
   * members of the selection move (a selected child of another selected part rides along
   * inside its subtree). Selects the new node.
   *
   * The node is born `grouped` and named so it's usable in one
   * action: in this flat-by-default scene an un-flagged container would make viewport
   * clicks still hit the children, so it'd "feel broken" until a second Ctrl+G - instead
   * clicking any conveyor inside it now selects the whole container immediately.
   */
  reparentToNewNode(): void {
    tree.reparentToNewNode(this)
  }

  /**
   * Tree drag-and-drop: move `draggedIds` relative to `targetId`. `inside` makes
   * them children of the target; `before`/`after` makes them siblings ordered around
   * it. Combines reparent + reorder in one undo step; aborts if the target sits inside
   * a dragged part's own subtree (a cycle).
   */
  moveInTree(draggedIds: readonly string[], targetId: string, dropPos: 'before' | 'after' | 'inside'): void {
    tree.moveInTree(this, draggedIds, targetId, dropPos)
  }

  /** internal - for store modules (the single state-write path; not for app code) */
  setState(partial: Partial<EditorState>, transient = false): void {
    // Dev-only enforcement of the part-immutability invariant: derived scene caches
    // (core/memoParts.ts) key on part reference identity, so an in-place part mutation
    // would serve stale derivations far from the offender. Freezing every part that
    // enters the store makes the mutation throw at its own call site instead. Unchanged
    // parts are already frozen (Object.isFrozen short-circuits), so a transient drag
    // frame only freezes the parts it replaced.
    if (import.meta.env.DEV && partial.scene) for (const p of partial.scene.parts) deepFreeze(p)
    // Selection is one axis with two shapes: scene parts (selectedIds) XOR a single rig link
    // (selectedRigNode). The exclusivity is enforced here, the single write path, so no call site
    // has to remember to clear the other side. A patch
    // that selects parts wins over a stale rig selection, and vice versa; setting selectedIds to
    // [] does not touch a rig selection (clearing both is clearSelection's job).
    if (partial.selectedIds !== undefined && partial.selectedIds.length > 0) partial = { ...partial, selectedRigNode: null }
    else if (partial.selectedRigNode != null) partial = { ...partial, selectedIds: [] }
    // The walk session ends with walk mode, however it is left (Esc, the toolbar, a placement or part-focus
    // entry that sets mode directly) - so its door state is dropped here, on the one write path, rather than
    // in each exit.
    if (partial.mode !== undefined && partial.mode !== 'pilot' && this.state.walkDoors !== null) partial = { ...partial, walkDoors: null }
    if (partial.mode !== undefined && partial.mode !== 'pilot' && this.state.walkFlex !== null) partial = { ...partial, walkFlex: null }
    // Guard-openings mode ends with its target, however that goes (a click elsewhere, Esc, undoing the part away,
    // entering placement or walk mode), and a new selection drops the selected opening. Decided here, on the one
    // write path, so no exit has to remember it.
    if (this.state.sideGuardMode || this.state.selectedGuardOpening) {
      const next = { ...this.state, ...partial }
      if (partial.selectedGuardOpening === undefined && next.selectedGuardOpening) {
        // the selected opening is a row index, so it lapses with the rows: any scene change (an undo, an Inspector
        // edit, a peer's edit) may have moved what that index points at, and Delete must never hit the wrong one.
        // A gizmo edit re-selects its opening after committing (controller, finishGuardOpening).
        const same = partial.selectedIds === undefined || (partial.selectedIds.length === this.state.selectedIds.length && partial.selectedIds.every((id, i) => id === this.state.selectedIds[i]))
        if (!same || (partial.scene !== undefined && partial.scene !== this.state.scene)) partial = { ...partial, selectedGuardOpening: null }
      }
      const touched = partial.selectedIds !== undefined || partial.selectedRigNode !== undefined || partial.mode !== undefined || partial.scene !== undefined
      if (next.sideGuardMode && touched && !guardOpeningsTarget(next)) partial = { ...partial, sideGuardMode: false, selectedGuardOpening: null }
    }
    this.state = { ...this.state, ...partial }
    // the controllers as Play uses them follow the document's list and this computer's addresses (storePlcs.ts)
    if (partial.scene || partial.plcPrefs || partial.packageEdit !== undefined) this.state.externalPlc = plcSetupOf(documentSceneOf(this.state), this.state.plcPrefs)
    // the view always tracks the live scene (smooth gizmo drag); React skips the
    // transient stream and re-renders only on structural changes / commits (StoreSubscribers.notify)
    this.subscribers.notify(transient)
  }

  private persist(): void {
    // in a room the Yjs doc + IndexedDB are the durable store; don't overwrite the user's
    // solo autosave with room state
    if (this.collab) return
    if (typeof localStorage === 'undefined') return
    // The project doc is the primary autosave and stays exact: written on every edit, always.
    const result = this.persistProject()
    // a demo preview that could not be kept (stashDemoSession) is still up: nothing of it is saved, here either
    if (this.state.demoSession) return
    // The legacy scene key is a fallback with two readers (projectFile.readLegacyScene): a
    // pre-project browser migrating, and a project doc that fails to parse. Neither needs it fresh to
    // the millisecond, and rewriting it on every commit costs ~375 KB of synchronous serialisation per
    // edit on the demo, at interaction rate during a gizmo drag, for a copy nobody reads unless the
    // primary is broken.
    //
    // So: write it when the primary failed (then it is the only copy of the user's work and must be
    // fresh), or when it has gone stale. Throttled by a timestamp rather than a timer, so
    // there is no flush to forget on unload - the worst case is a backup a few seconds behind a primary
    // that is itself always current (AutosaveSchedule.legacyBackupDue).
    if (!this.autosave.legacyBackupDue(result.ok, Date.now())) return
    try {
      // compact, with models by hash (projectFile.legacySceneText)
      localStorage.setItem(AUTOSAVE_KEY, legacySceneText(this.sceneSansDraft()))
      noteLegacyWrite('scene')
    } catch {
      // best-effort: quota or serializer failures must not break editing. Not reported here - this is the
      // transitional fallback key and it is strictly smaller than the project doc, so anything that breaks
      // it breaks persistProject() too, which does raise the warning.
    }
  }

  /**
   * Autosave for an edit that continues a gesture: the gesture's first commit wrote at once, and the rest trail it by
   * one timed write (AutosaveSchedule.defer, which says why). Any other write of the project (persistProject, from any
   * path) absorbs a pending one. flushPersist() is the unload / hand-off door.
   */
  private deferPersist(): void {
    if (this.collab) return
    this.autosave.defer(() => this.flushPersist())
  }

  /** Write any autosave deferPersist is holding, now. Called on page hide/unload (main.tsx) and harmless when idle. */
  flushPersist(): void {
    this.autosave.cancelTimer()
    // either write goes through persistProject, which absorbs both pending flags
    if (this.autosave.scenePending) this.persist()
    else if (this.autosave.takeProgramPending()) this.persistStProgram()
  }

  /** does a deferred autosave still have to be written? (tests, and callers about to read the stored project) */
  get persistPending(): boolean {
    return this.autosave.pending
  }

  /**
   * Write the unified project autosave: the active scene + its bound ST program + the authored part library,
   * as one document (the new primary autosave unit). Called from persist() (scene edits), persistUserPackages()
   * (library edits), and persistStProgram() (program edits) so the doc tracks all three. Solo only - a room
   * persists through the Yjs doc.
   */
  persistProject(): SaveResult {
    // The first real edit of a ?scene=demo session makes the demo the user's own work: give it a scene
    // slot of its own (beside anything they already had) and stop being a demo session. This must run before
    // the capture below: it is what points activeScene at the demo's own slot instead of whatever slot
    // the adopted project had active, which the capture would otherwise overwrite with the demo.
    if (!this.stashDemoSession()) return { ok: true } // a preview that cannot be kept (stashDemoSession) writes nothing
    // this write captures the live scene + program, so it absorbs anything deferPersist was holding
    // (the program's legacy keys are written too; the scene's legacy key is throttled by design anyway)
    if (this.autosave.takeProgramPending()) {
      saveStProgram(this.state.stProgram)
      saveStScanMs(this.state.stScanMs)
      noteLegacyWrite('program')
    }
    this.autosave.settleScene()
    // nothing to write is not a failure - persist()'s fallback must not fire for these
    if (this.collab) return { ok: true }
    // every write carries a complete library: whatever the edit placed is the project's own copy from now on
    this.completeLibrary()
    if (typeof localStorage === 'undefined') return { ok: true }
    let result: SaveResult
    try {
      if (this.project) {
        // fold the live scene + program back into the project, then write the whole of it
        this.captureLiveScene()
        result = saveStoredProject(this.project)
      } else {
        // legacy / pre-loadProject path: assemble + persist a one-scene project
        result = saveStoredProject(
          assembleProject(
            this.sceneWithBroughtDefinitions(),
            this.state.stProgram,
            this.state.userPackages,
            undefined,
            this.state.stScanMs,
            this.state.simHz,
            this.state.controller,
            this.state.stDialect,
          ),
        )
      }
    } catch (e) {
      // never break editing on a persist failure - but DO report it (see reportAutosave)
      result = { ok: false, quota: false, message: `This project could not be autosaved: ${e instanceof Error ? e.message : String(e)}` }
    }
    this.reportAutosave(result)
    if (result.ok) this.autosave.notifyPersisted()
    return result
  }

  /**
   * Hear every successful write of the project document - the one moment that is guaranteed to follow
   * any change to it (a scene edit, a program, a rename, a scene added or removed, a part authored). The
   * desktop folder sync (projectFolderSync.ts) schedules its write from here. A store subscription could
   * not stand in for it: that fires on every hover and selection, and knows nothing about which of those
   * changed the document.
   */
  onProjectPersisted(cb: () => void): () => void {
    return this.autosave.onPersisted(cb)
  }

  /**
   * Keep the library complete (docs/part-sources.md): every part the document places, and every part those name, is
   * the project's own copy. A built-in it lacks comes in at the app's current version, stamped with that version's
   * fingerprint, so the app can say when it later changes and never changes the project by itself. Not an edit and
   * not an undo step: the copy is the part the scene already runs (registering it rebuilds nothing). Solo only: a
   * room's packages arrive over the doc.
   */
  private completeLibrary(): void {
    if (this.collab || this.readOnly) return
    const placed = [this.run.documentOf(documentSceneOf(this.state)).parts]
    const missing = missingLibraryCopies(this.state.userPackages, placed)
    if (missing.length === 0) return
    for (const pkg of missing) registerPackage(pkg, true)
    this.setState({ userPackages: [...this.state.userPackages, ...missing] })
    // their models' bytes, for the next write to put in the project folder or a .oip (shippedAssetCache.ts)
    void warmShippedAssets(missing)
  }

  /** Raise / clear the sticky autosave warning. Only writes state on a change so a healthy autosave (every
   *  commit) doesn't re-render the app on each edit. */
  private reportAutosave(result: SaveResult): void {
    const next = result.ok ? null : result.message
    if (next !== this.state.autosaveError) this.setState({ autosaveError: next })
  }

  /**
   * The demo view has produced real, persisted work, so keep that work as a project of its own and stop being
   * a demo session. This is the copy-on-write half of the model: viewing the demo mints nothing, editing it is what
   * makes it yours. Called first thing in {@link persistProject}, guarded by demoSession, so it fires
   * exactly once and no-ops in a normal session.
   *
   * A returning user gets a new project (through {@link demoForkHost}): theirs is filed untouched and stays
   * in the projects list, and the screen becomes a one-scene project named {@link DEMO_SCENE_NAME}. Where
   * there is no library to file theirs into, the demo stays a preview (a project holds one scene, so there is
   * nowhere else for it) and this returns false, which persistProject reads as "write nothing". The new project
   * goes in empty because the captureLiveScene right after this (same persistProject call) fills it with the live
   * demo scene + program. A first-ever visitor has no project yet, so ensureProject builds one from the live demo,
   * and the demo is that project. Only its name needs setting.
   */
  private stashDemoSession(): boolean {
    if (!this.state.demoSession || this.enteringDemo || this.stashingDemo) return !this.state.demoSession
    // The flag goes down in the same setState as the new project, at the end of this: one notification in
    // which demoSession and the project have moved together. Clearing it up here would publish a state the
    // viewport acts on before what it acts on exists: the camera hand-off resolves to the outgoing slot, and
    // editing the demo teleports you to world zero. The guard below stops a re-entrant persist (a mounted ST
    // editor's program listener) from forking a second slot mid-fork, since ensureProject notifies while
    // demoSession is still up.
    this.stashingDemo = true
    try {
      this.clearDemoUrl()
      const returning = this.project !== null
      const project = this.ensureProject()
      if (!returning) {
        // a first visit has no project to keep: the demo is its project, named after the demo
        project.name = DEMO_SCENE_NAME
        this.demoForkedSlot = SCENE_SLOT
        this.setState({ projectName: project.name, demoSession: false, demoForkNotice: this.forkNotice() })
        return true
      }
      // A returning user's project is not where the demo goes: it becomes a project of its own, filed beside
      // theirs, which is left exactly as it was (it was banked when the demo opened, and the capture that would
      // write the demo over it no-ops while demoSession is up). The host (demoFork.ts) files theirs, gives the
      // screen a new document id and lets go of their folder.
      const forkedAs = this.collab ? null : (this.demoForkHost?.(project) ?? null)
      if (forkedAs !== null) {
        this.project = assembleProject(emptyScene(), '', [], forkedAs)
        this.demoForkedSlot = SCENE_SLOT
        // Their parts and tests stay with the project left. The library on screen is already the demo's own:
        // enterDemoSession emptied it, so it holds only parts added during the demo. Emptying it again here dropped
        // the part whose adding forked the demo (a library or shelf copy), and the user had to add it twice.
        this.setState({
          projectName: forkedAs,
          testCount: 0,
          demoSession: false,
          demoForkNotice: this.projectForkNotice(forkedAs, (this.demoForkLeft = project.name)),
        })
        return true
      }
      // No library to file theirs into (a browser keeping one project, or a host with none): the demo cannot become
      // a project without taking theirs, so it stays a preview, and its edits stay in this page. Said once.
      if (!this.demoUnkeptNoticed) {
        this.demoUnkeptNoticed = true
        this.setState({
          demoForkNotice: {
            key: this.noticeSeq++,
            title: 'Your demo changes are not kept here',
            message: `This browser keeps one project, so the demo cannot become one of its own without replacing “${project.name}”. Your changes to it are not saved.`,
          },
        })
      }
      return false
    } finally {
      this.stashingDemo = false
    }
  }

  /**
   * The one-off notice {@link stashDemoSession} raises, in the same setState as the fork so the toast can never
   * describe a slot that is not there yet.
   *
   * After the fact, not a confirm before it. The fork takes nothing away (the demo becomes a project
   * beside the user's own and none of theirs is touched), so a prompt on the first edit would get in the way of
   * exactly what the demo invites users to do. What does need saying is what moved on its own and cannot be undone from the
   * edit: the project on screen is a new one, and `?scene=demo` has been retired from the URL (clearDemoUrl), so a
   * reload does not reopen the example over this work. The standing signal that the demo is the built-in example
   * is the project menu's own label ("Palletizing demo" with an Example badge, its rename inert); this is the moment that
   * stops being true.
   */
  private forkNotice(): Notice {
    return {
      key: this.noticeSeq++,
      title: `${DEMO_SCENE_NAME} is now your project`,
      message: 'Editing the demo made it yours. It saves as you work, and a reload comes back to it instead of the demo.',
    }
  }

  /** the "your demo changes are not kept here" notice has been shown (see stashDemoSession) */
  private demoUnkeptNoticed = false

  /** the project the demo last forked away from, which its notice names (see {@link renameDemoFork}) */
  private demoForkLeft: string | null = null

  /**
   * Renumber the project the demo just forked into, the notice that announced it included: the fork host names it
   * before the library's names have always been read, and corrects it once they are (demoFork.ts). The notice
   * keeps its key, so a toast still up only changes its words; one already dismissed is not brought back.
   */
  renameDemoFork(name: string): void {
    this.renameProject(name)
    const shown = this.state.demoForkNotice
    if (shown !== null && this.demoForkLeft !== null && this.state.projectName === name) {
      this.setState({ demoForkNotice: { ...this.projectForkNotice(name, this.demoForkLeft), key: shown.key } })
    }
  }

  /** {@link forkNotice} for the fork into a project of its own: what moved is the whole document, so it names
   *  the project left behind and the way back to it. */
  private projectForkNotice(name: string, left: string): Notice {
    return {
      key: this.noticeSeq++,
      title: `${name} is now a project of your own`,
      message: `Editing the demo copied it into a new project. “${left}” is untouched: open it again from Projects.`,
      action: { label: 'Projects', command: 'file.projects' },
    }
  }

  /**
   * Who files the user's project when an edit forks the demo into a project of its own (demoFork.ts): it files
   * `outgoing`, gives the screen a new document id, and lets go of the folder `outgoing` lives in. Returns the
   * new project's name when it did ({@link DEMO_SCENE_NAME}, numbered past any project already called that, which
   * only the host can see), and null where it cannot (no project library). The demo then stays a preview, its edits
   * unsaved (a project holds one scene, so there is nowhere else for it). Unset (headless hosts, tests) means the same.
   */
  private demoForkHost: ((outgoing: ProjectJSON) => string | null) | null = null

  setDemoForkHost(host: ((outgoing: ProjectJSON) => string | null) | null): void {
    this.demoForkHost = host
  }

  /**
   * Stop showing the demo without keeping it: the user navigated away from a source they never touched,
   * so there is nothing to fork. The project behind it is untouched (captureLiveScene no-ops while the flag is
   * up); leaving the demo is a reload into it (sceneFile.leaveDemo).
   */
  dropDemoSession(): void {
    if (!this.state.demoSession) return
    this.demoSession = false
    this.clearDemoUrl()
  }

  /**
   * Show the built-in demo as an ephemeral source: it takes the viewport but becomes nothing, so pressing Demo
   * has no side effects. Press it ten times and the projects list is what it was. Editing it is what makes
   * it theirs ({@link stashDemoSession}).
   *
   * The scene being left is banked into its own slot first, which is also what `ensureProject` is doing
   * here: a first-ever visitor has no project doc, so without it the demo would later assemble a
   * one-scene project out of itself and take their unsaved scene with it.
   *
   * `bank: false` is the `?scene=demo` boot path (main.tsx): the demo is what the visit opens on, so there
   * is nothing on screen to bank - and banking would capture the default empty scene over the active slot
   * of the project it just adopted for ownership (loadProject `adoptOnly`, which leaves the
   * tabs unpublished because the viewport is showing the demo, not any of them).
   */
  enterDemoSession(scene: SceneJSON, program: string, opts?: { bank?: boolean; scanMs?: number; controller?: Controller | null }): void {
    if (this.readOnly) return
    if (opts?.bank !== false && !this.state.demoSession) {
      this.ensureProject()
      this.persistProject() // captures the live scene into its slot and writes the doc
    }
    // Order matters: the flag goes up before the load so nothing in flight can persist the demo into a
    // slot, and enteringDemo holds off stashDemoSession for the same window (see the field).
    this.enteringDemo = true
    this.demoSession = true
    // The demo runs this build's parts. The project's library holds its own copy of every part it uses, built-ins
    // included, so left live it would draw the demo with that project's older copies and offer to "update" them.
    // The library stays in the project document (captureLiveScene no-ops in a demo), which the fork files as it was.
    if (this.project && this.state.userPackages.length > 0) this.adoptProjectLibrary([])
    try {
      // persist:false on both halves: viewing the demo must never overwrite the user's saved scene or
      // program. Its program is still live (it attaches, exports, and seeds a room like any other).
      this.loadScene(scene, { persist: false })
      // the controller table comes with its program: the demo's picks which of its two versions runs
      this.loadStProgram(program, { persist: false, ...(opts?.scanMs !== undefined ? { scanMs: opts.scanMs } : {}), controller: opts?.controller ?? null })
      // the demo steps at its own rate, the default, not the rate of the scene it was entered from
      this.setSimHz(DEFAULT_SIM_HZ, { persist: false })
    } finally {
      this.enteringDemo = false
    }
  }

  /**
   * Fork the demo view into a scene of the user's own without waiting for an edit.
   *
   * No UI surface calls this: copy-on-write already covers the case (edit it and it
   * is yours; nudge-then-undo leaves you an untouched copy, since the fork has happened by then and undo
   * is scene-local), and a button for it would take switcher width a phone does not have. Kept as the
   * named operation an Examples library would want, and pinned by storeProject.test.ts so it keeps
   * working. {@link persistProject} already is the promotion sequence
   * (stash → capture into the new slot → write), so this is just its name.
   */
  keepDemoCopy(): void {
    if (!this.state.demoSession) return
    this.persistProject()
  }

  /**
   * Drop the `?scene=demo` entry param once the session stops being an ephemeral peek. The param is read
   * only at boot ({@link bootSolo}) and its branch returns before the autosave branch, so left in the URL
   * the next reload re-opens the demo instead of the work we just saved. replaceState: no navigation, no
   * history entry; path, hash, and any other params like ?webgpu are kept.
   */
  private clearDemoUrl(): void {
    if (typeof window === 'undefined' || typeof history === 'undefined') return
    try {
      const url = new URL(window.location.href)
      if (!url.searchParams.has('scene')) return
      url.searchParams.delete('scene')
      history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    } catch {
      // best-effort: a malformed URL or disabled history must never break persistence
    }
  }

  // ───────────────────────── Project ─────────────────────────

  /**
   * Adopt a project: seed its library and load its scene live. The single boot entry for a loaded project. After
   * this the store owns the project, and every save captures the live scene back into it.
   *
   * `adoptOnly` takes ownership of the project without touching the live scene or making its library live: the
   * `?scene=demo` boot path, which loads the ephemeral demo over the top (main.tsx). There ownership is what
   * matters: it is what the demo's first persisting edit files away untouched when it forks the demo into a project
   * of its own ({@link stashDemoSession}). The library stays in the document: the demo runs this build's parts
   * ({@link enterDemoSession}).
   */
  loadProject(project: ProjectJSON, opts?: { adoptOnly?: boolean }): void {
    if (this.readOnly) return
    this.project = project
    // published before the adoptOnly bail: a peek adopts ownership of the document, so its tests are
    // the ones "Run Project Tests" would run even while the demo is what's on screen
    this.setState({ testCount: project.tests?.length ?? 0, projectName: project.name })
    if (!opts?.adoptOnly) this.adoptProjectLibrary(project.packages ?? [])
    if (opts?.adoptOnly) return
    this.applyProject()
  }

  /**
   * Take a newer copy of the same project: a linked folder's sweep (projectFolderLink, projectFolderSync).
   *
   * `keepLiveScene` is the caller's word that the scene on screen, and the library it resolves against, did
   * not change in the new copy. Then the scene is not reloaded at all: its undo history, its selection and any
   * edit made here survive, and only the rest - tests, the name - moves to the new copy. Otherwise it
   * is loadProject. The caller stops a running sim first when the live scene is going to be replaced
   * (controller.leaveForSceneSwap).
   *
   * During a demo preview nothing on screen is the project's, so the new copy is adopted behind it.
   */
  refreshProject(project: ProjectJSON, opts: { keepLiveScene: boolean }): void {
    if (this.readOnly) return
    if (this.state.demoSession) {
      this.loadProject(project, { adoptOnly: true })
      return
    }
    if (!opts.keepLiveScene) {
      this.loadProject(project)
      return
    }
    this.project = project
    // the library as the folder has it now: a behavior.js edited outside the app (VS Code, an agent) hot-reloads
    // through here - the folder sync read it - with no second watcher on parts/ (adoptProjectLibrary replaces)
    this.adoptProjectLibrary(project.packages ?? [])
    this.captureLiveScene() // the live scene, edits made here and all, into the new copy
    this.setState({ projectName: project.name, testCount: project.tests?.length ?? 0 })
    this.persistProject()
  }

  /** Publish the unopened stored project (boot, main.tsx) or clear it (projectFile.discardUnopenedProject). */
  setUnopenedProject(unopened: UnopenedProject | null): void {
    if (unopened === this.state.unopenedProject) return
    this.setState({ unopenedProject: unopened })
  }

  /**
   * A newer build of the app has joined this room (collab/bridge.ts). An older build cannot represent everything a
   * newer one writes, and each of its write-back paths loses what it could not read, so this tab stops editing the
   * room rather than damage it. Reload loads the newer build. The bridge has already stopped writing; read-only is
   * what every authoring surface honours, as for yieldToOtherTab. Running the sim is still allowed.
   */
  yieldToNewerBuild(): void {
    if (this.state.roomNewerBuild) return
    this.setReadOnly(true)
    this.setState({ roomNewerBuild: true })
  }

  /**
   * Another tab now holds the working copy (main.tsx, on projectFile.onWorkingCopySuperseded). This tab goes
   * view-only rather than keep taking edits it can no longer save: read-only is the state every authoring
   * surface already honours, and it also stops the projects it files. Running the sim is still allowed.
   */
  yieldToOtherTab(): void {
    if (this.state.supersededByOtherTab) return
    this.setReadOnly(true)
    this.setState({ supersededByOtherTab: true })
  }

  /**
   * The document to file in the library before a different one replaces it on screen, or null when there is
   * nothing of the user's to file: in a room the collab doc is the document, and a demo preview with no
   * project behind it would mint one out of a view that is in no slot. A preview with a project behind it
   * files that project, untouched (captureLiveScene no-ops while the demo is up).
   */
  outgoingProject(): ProjectJSON | null {
    if (this.collab) return loadStoredProject()?.project ?? null // in a room this browser's own is its working copy (sharedProject.ts)
    if (this.state.demoSession && !this.project) return null
    return this.snapshotProject()
  }

  /** Publish the linked-folder status (projectFolderLink.ts owns the handle and the sweep; the store
   *  only carries what a surface renders). Writes only on a change, so a sweep that finds nothing new
   * (the common case, once a second) never re-renders the app. */
  setFolderLink(name: string | null, error: string | null, note: string | null = null): void {
    if (name === this.state.linkedFolder && error === this.state.folderError && note === this.state.folderNote) return
    this.setState({ linkedFolder: name, folderError: error, folderNote: note })
  }

  /** Publish a remembered-but-unpermitted folder (see {@link EditorState.pausedFolder}). Same
   *  write-on-change rule as {@link setFolderLink}. */
  setFolderPaused(name: string | null): void {
    if (name === this.state.pausedFolder) return
    this.setState({ pausedFolder: name })
  }

  /** Publish the folder the project lives in on the desktop (see {@link EditorState.folderPath}). */
  setFolderPath(path: string | null): void {
    if (path === this.state.folderPath) return
    this.setState({ folderPath: path })
  }

  /** Publish (or clear) the files changed on both sides (see {@link EditorState.folderConflict}). */
  setFolderConflict(paths: string[] | null): void {
    const same = (a: string[] | null, b: string[] | null): boolean =>
      a === b || (a !== null && b !== null && a.length === b.length && a.every((p, i) => p === b[i]))
    if (same(paths, this.state.folderConflict)) return
    this.setState({ folderConflict: paths })
  }

  /**
   * Snapshot the full project (the scene, its program, the authored library and the tests), with the
   * live scene + ST program captured into it first. The export seam for a folder, an .oip download and the library.
   * Returns the store's own held project, not a copy: serialize it immediately, don't hold or mutate it.
   */
  snapshotProject(): ProjectJSON {
    const project = this.ensureProject()
    this.captureLiveScene()
    return project
  }

  /** Get the held project, lazily building one from the current live state if none was loaded (a first-ever
   *  visitor edits before any project doc exists). */
  private ensureProject(): ProjectJSON {
    if (!this.project) {
      this.project = assembleProject(
        this.sceneWithBroughtDefinitions(),
        this.state.stProgram,
        this.state.userPackages,
        this.state.projectName,
        this.state.stScanMs,
        this.state.simHz,
        this.state.controller,
        this.state.stDialect,
      )
      this.setState({ projectName: this.project.name })
    }
    return this.project
  }

  /** Load the held project into the live store: its scene (parts + copies of their packages), its program and its
   *  step rate. The authored library was registered (authoritatively) by adoptProjectLibrary at loadProject.
   *  Resets undo. */
  private applyProject(): void {
    const project = this.project
    if (!project) return
    this.setState({ projectName: project.name })
    // A project keeps no copies of its parts' packages (core/project/project.ts): the live scene gets them back here from the
    // library and the built-ins - the registry, which loadProject filled before this - so it is self-contained for
    // everything that hands it on (the sim worker, a room, a scene file).
    const own = livePackagesFor(project.scene.parts, project.scene.packages ?? [])
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: project.scene.parts,
      ...(own.length > 0 ? { packages: own } : {}),
      ...sceneSettings(project.scene),
    }
    // The step rate goes in first: loading the program below persists, and that persist captures the live state into
    // this project. With the outgoing rate still live it would write that over this project's own (and a 120 Hz
    // project would open, and save itself, at 60).
    const hz = project.simHz ?? DEFAULT_SIM_HZ
    this.setSimHz(hz, { persist: false })
    this.loadScene(scene, { persist: false }) // registers the scene's snapshots; clears undo + selection
    this.loadStProgram(project.stProgram ?? '', {
      scanMs: project.stScanMs ?? DEFAULT_SCAN_MS,
      controller: project.controller ?? null,
      dialect: project.stDialect ?? null,
    })
  }

  /** Capture the live scene + ST program into the held project (the inverse of applyProject). Run before persisting
   *  so edits aren't lost. */
  private captureLiveScene(): void {
    const project = this.project
    if (!project) return
    // The demo view is not the project's, so there is nothing here to capture - capturing would write the demo
    // straight over it. The one path that does want the demo kept clears this flag first (stashDemoSession, which
    // runs at the top of persistProject).
    if (this.state.demoSession) return
    const prog = this.state.stProgram
    const sans = this.sceneSansDraft()
    const pkgs = this.broughtDefinitions(sans)
    project.scene = { version: SCENE_VERSION, parts: sans.parts, ...(pkgs.length > 0 ? { packages: pkgs } : {}), ...sceneSettings(sans) }
    if (prog !== '') {
      project.stProgram = prog
      project.stScanMs = this.state.stScanMs
    } else {
      delete project.stProgram
      delete project.stScanMs
    }
    // A table the program no longer has goes explicitly, and so does a dialect the project no longer has. An empty
    // program keeps its dialect, though: the family is the controller's, chosen before any code exists
    // (core/dialect.ts), and dropping it would turn a project marked with another dialect back into IEC on the next reload
    if (prog !== '' && this.state.controller) project.controller = this.state.controller
    else delete project.controller
    if (this.state.stDialect !== undefined) project.stDialect = this.state.stDialect
    else delete project.stDialect
    // the step rate, with or without a program; the default stays implicit
    if (this.state.simHz !== DEFAULT_SIM_HZ) project.simHz = this.state.simHz
    else delete project.simHz
    const library = this.libraryPackages()
    if (library.length > 0) project.packages = library
    else delete project.packages
  }

  /**
   * The definitions `scene`'s parts use that are neither the project's library nor the app's built-ins: a part a scene
   * file or a paste from another project brought in. The project keeps each definition once (core/project/project.ts),
   * so these are the only copies a saved scene keeps, and saving moves them into the library (keepDefinitionsOnce).
   * Worked out from the parts, not read from the scene's stored copies, so a part added without its copy is not lost.
   */
  private broughtDefinitions(scene: SceneJSON): PartPackage[] {
    const libraryIds = new Set(this.state.userPackages.map((p) => p.id))
    const stored = new Map((scene.packages ?? []).map((p) => [p.id, p]))
    return definitionsUsedBy(scene.parts, (id) => getPackage(id) ?? stored.get(id)).filter((p) => !libraryIds.has(p.id) && !builtInPackage(p.id))
  }

  /** The shared library = the authored parts only (userPackages). A placed part's snapshot stays in the scene's
   *  `scene.packages` - folding it in here would adopt it as an authoritative user part on the next boot and freeze
   *  it at its placement-day content (the placed-part-freeze bug; see projectFile.assembleProject, which keeps the
   *  same split for the pre-loadProject path). */
  private libraryPackages(): PartPackage[] {
    return [...this.state.userPackages]
  }

  /**
   * Rename the project. A pure relabel (no scene reload), but it is the name the browser tab, the desktop window
   * title and the project menu all read, so it is the one place a returning user is told which document they came
   * back to.
   *
   * Inert during the demo preview and in a room, both for the same reason: this has to persist to mean anything.
   * persistProject() opens with stashDemoSession(), so renaming while the demo view is up would fork the demo into a
   * project of its own. A rename minting a document is exactly the copy-on-write surprise the demo session exists to
   * avoid. In a room the collab doc is the document and persistProject() is a no-op there, so the label would
   * silently be lost on the next reload. Both are disabled at the command as well.
   */
  renameProject(name: string): void {
    if (this.readOnly || this.state.demoSession || this.collab) return
    const trimmed = name.trim()
    if (trimmed === '' || trimmed === this.state.projectName) return
    const project = this.ensureProject()
    project.name = trimmed
    this.setState({ projectName: trimmed })
    this.persistProject()
  }

  /**
   * Keep a test in the project (core/project/project.ts `tests`), replacing the one of the same name. It changes the
   * project's structure, so it is kept at once and is not an undo step. The spec is taken as validated
   * (validateTestSpec). False when it was not kept: a view-only editor, or a room this browser does not own (a room
   * carries no tests; the owner's are its project's, written back with the room: sharedProject.ts).
   */
  saveProjectTest(spec: TestSpec): boolean {
    if (this.readOnly || (this.collab && !keepsSharedTests())) return false
    const project = this.ensureProject()
    const kept = (project.tests ?? []).filter((t) => spec.name === undefined || t.name !== spec.name)
    project.tests = [...kept, spec]
    this.setState({ testCount: project.tests.length })
    this.persistProject()
    return true
  }

  /** The tests the project keeps, read without building or capturing a project (snapshotProject does both). A new
   *  array after every save or delete, so a memo can depend on it. */
  projectTests(): readonly TestSpec[] {
    return this.project?.tests ?? NO_TESTS
  }

  /** Drop the kept test named `name`, as {@link saveProjectTest} keeps one: not an undo step. False when not kept. */
  deleteProjectTest(name: string): boolean {
    if (this.readOnly || (this.collab && !keepsSharedTests())) return false
    const project = this.ensureProject()
    const kept = (project.tests ?? []).filter((t) => t.name !== name)
    if (kept.length === (project.tests ?? []).length) return false
    project.tests = kept
    this.setState({ testCount: kept.length })
    this.persistProject()
    return true
  }

  /** The document's scene: what sceneSansDraft returns, for a reader outside the store (the agent review compares
   *  two of them, agent/agentSession.ts). Shared, never mutated. */
  documentScene(): SceneJSON {
    return this.sceneSansDraft()
  }

  /** The scene as persisted: the document, i.e. the one a definition session parked while it is open (so a reload
   *  mid-session returns to the scene as it was), else the live scene minus the run's cargo (documentOf). */
  private sceneSansDraft(): SceneJSON {
    return this.state.packageEdit?.document ?? this.run.documentOf(this.state.scene)
  }

  /** the document's scene carrying {@link broughtDefinitions} as its copies: what a project is assembled from */
  private sceneWithBroughtDefinitions(): SceneJSON {
    const scene = this.sceneSansDraft()
    const brought = this.broughtDefinitions(scene)
    const { packages: _stored, ...sans } = scene
    return brought.length > 0 ? { ...sans, packages: brought } : sans
  }
}

