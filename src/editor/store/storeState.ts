// The editor store's state shape (EditorState and the types it is built from), its initial value, and the pure
// reads over it (the edit target, rig-node keys, the guard-openings target). Extracted from store.ts verbatim; the
// types stay re-exported there.
import type { Controller } from '../../core/controller'
import type { FlexPose } from '../../core/parts/partGeometry'
import type { PartPackage } from '../../core/parts/partPackage'
import { guardArcRange } from '../../core/guards/guardOpeningEdit'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../../core/types'
import type { PartInstance, PartType, SceneJSON, SimRate } from '../../core/types'
import type { ProjectionMode } from '../../render/api'
import type { StFileReportData } from '../components/plc/StFileReport'
import type { UnopenedProject } from '../project/projectFile'
import type { FollowTarget } from '../live/followTarget'
import {
  readExternalPlc,
  readFaceSnap,
  readFlowArrows,
  readGridSnap,
  readLiveSnap,
  readShowGrid,
  readShowNotes,
  readShowStats,
  readSpace,
  readTrackball,
  readTreeTypes,
  readVertexSnapCollision,
  readVertexSnapOrigin,
} from './storePrefs'
import type { ExternalPlcSettings } from './storePrefs'
import { plcSetupOf } from './storePlcs'
import type { PlcSetup } from './storePlcs'
import type { PropertyClipboard } from './storeProperties'

/** Dev-only (see setState): recursively freeze a part snapshot so any in-place mutation throws at the
 *  offending line. Already-frozen subtrees short-circuit, so unchanged parts re-entering the store are O(1). */
export function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return
  Object.freeze(v)
  for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
}

// 'transform' is the combined move+rotate gizmo (the default tool)
/** What a scene file holds once validated (core/scene/scene.ts validateScene): what {@link EditorStore.importScene} adds. */
export interface SceneFileContents {
  scene: SceneJSON
  stProgram?: string
  stScanMs?: number
  controller?: Controller
  stDialect?: string
  simHz?: SimRate
}

export type ToolMode = 'transform' | 'select' | 'move' | 'rotate' | 'ruler' | 'list'

/** transform-basis toggle: 'local' aligns the gizmo to the part's yaw, 'global' to world axes */
export type TransformSpace = 'local' | 'global'

/** A transient "this custom part failed to build" toast (a desktop file-save/load that didn't compile, or
 *  an in-app package edit that failed validation and was blocked). */
export interface PartBuildNotice {
  /** monotonic id so React can key the list and the toast can dismiss exactly itself */
  key: number
  /** the failing package id (also keys the catalog badge) */
  id: string
  /** human-readable part name for the toast headline */
  name: string
  /** the build/validation error message */
  error: string
}

/** A transient statement about something the app just did (or declined to do), shown on the toast surface and
 *  self-dismissing. Not a question and not a prompt: nothing here is answered by the toast. */
export interface Notice {
  /** monotonic id so the toast's dismissal timer is keyed on this notice, not on any re-render */
  key: number
  title: string
  message: string
  /** one follow-up the toast offers as a button: a command id (editor/commands.ts), run on click */
  action?: { label: string; command: string }
}

/** "Use Snap" grid increments (Configure Snap dialog) */
export interface GridSnap {
  enabled: boolean
  /** translate increment in meters (0 disables translate snapping) */
  translate: number
  /** rotate increment in degrees (0 disables rotate snapping) */
  rotate: number
}

/** one overlapping part offered in the Alt+RMB / List-Select-tool picker */
export interface ListSelectItem {
  id: string
  name: string
  type: PartType
  /** custom parts only: the referenced package, so the picker can show the real part name (not "Custom Part") */
  packageId?: string
}

/** active follow-mode target (double-F): drives the "Following X" viewport badge. null = not following */
export interface FollowState {
  /** the part ids being followed (== the current selection while following) */
  ids: string[]
  /** display text for the badge, e.g. "Box 3" or "2 parts" */
  label: string
}

/** open viewport list-select popup: overlapping parts at a screen point (the selection menu) */
export interface ListSelectMenu {
  x: number
  y: number
  items: ListSelectItem[]
  /** the gesture held Shift: a pick appends to the selection rather than replacing it */
  append: boolean
}

/**
 * The active "open in its own scene" scope as one typed, kind-aware value - the single read model the
 * edit-document seam consumes. A pure derivation of the authoritative
 * session fields (`focusedPartId` + `packageEdit`) via {@link editTarget}. One level deep: there is at most one
 * opened scope, never a stack of them.
 */
export type EditTarget =
  /** inspecting / authoring a placed custom part at its world position (`enterPartFocus`) */
  | { kind: 'part-focus'; id: string }
  /** editing a part package's rig via its origin throwaway (`enterPackageEdit`, the Catalog ✎); `partId`
   *  is the throwaway the focus machinery isolates - null only in the stranded-session window */
  | { kind: 'package-edit'; packageId: string; partId: string | null }

/** The focused part id a target isolates in the viewport, or null when there's nothing to isolate
 *  (a package session whose throwaway was stranded by an undo). The key the render seam filters on. */
export function editTargetFocusId(t: EditTarget): string | null {
  if (t.kind === 'part-focus') return t.id
  return t.partId
}

/** The active edit target derived from the authoritative session fields (a package session also sets
 *  `focusedPartId`, so it wins over a plain part-focus). null at the base scene. Pure - no behavior. */
export function editTarget(s: EditorState): EditTarget | null {
  if (s.packageEdit) return { kind: 'package-edit', packageId: s.packageEdit.packageId, partId: s.focusedPartId }
  if (s.focusedPartId) return { kind: 'part-focus', id: s.focusedPartId }
  return null
}

/** The edit scope as a stack (base scene implicit at the bottom). Depth ≤ 1 today; v3 nesting grows it. */
export function editStack(s: EditorState): EditTarget[] {
  const t = editTarget(s)
  return t ? [t] : []
}

export interface EditorState {
  scene: SceneJSON
  /**
   * The ST/PLC program bound to the live scene, and its scan (cycle) time in ms.
   *
   * The store of record while the app is live: attach, export, room seed and project autosave all
   * read it here, so a program can never be attached and running while the exporter ships a
   * different one (or none). Where it is durably kept is a sink's business (see setStProgramSink), which
   * is the one thing that legitimately differs between solo and a room.
   *
   * The scan time lives beside the source because it is part of the program, not a machine
   * preference: a shared room, an exported scene, and a project scene all carry the pair.
   */
  stProgram: string
  stScanMs: number
  /**
   * The program's controller table (core/controller.ts): the tasks it runs on and the PROGRAM instances
   * each task runs, or null for one program on `stScanMs`. Part of the same document as the source and
   * the scan time, so it is kept, shared and exported with them, and replaced when they are.
   */
  controller: Controller | null
  /**
   * The language family the program's text is written in (core/dialect.ts). Absent means IEC 61131-3, the only one
   * this build runs; any other value is a program this build cannot read. It is kept exactly as it arrived and saved
   * back unchanged, while the program is refused at the run edge (EditorController.attachProgram), listed as one error
   * in Problems, and shown read-only: `!isKnownDialect(state.stDialect)`. Part of the program document, so it is
   * replaced with the program (a wholesale load without one is IEC) and undone with it (commitProgram).
   */
  stDialect?: string
  /**
   * The active scene's physics step rate in whole Hz, MIN_SIM_HZ..MAX_SIM_HZ (core/project/project.ts ProjectMachine.simHz),
   * set in the Inspector with nothing selected. It sets how often the world moves and its sensors sample, and so
   * the soonest a PLC output can follow the input that caused it (one step). The run edge ships it to the worker
   * and the project test runner reads the same field off the saved scene, so a test and a Play step the same
   * machine. Loaded with the project (applyProject), written back into it (captureLiveScene), and
   * kept like the program is - the project doc solo, the room's `meta` in a room (setSimHzSink).
   */
  simHz: SimRate
  /**
   * The scene's controllers as Play uses them (storePlcs.ts): the document's list (SceneJSON.plcs), whether the
   * program here runs the default one and each one's protocol, with this computer's addresses from `plcPrefs`.
   * Derived, kept current by setState whenever the document's scene or the preferences change; every reader of a
   * link's settings reads this.
   */
  externalPlc: PlcSetup
  /**
   * This computer's PLC preferences, in localStorage, never in the document: each controller's address, and the
   * simulated PLC's OPC UA server. Written only through the store's controller edits (storePlcs.ts).
   */
  plcPrefs: ExternalPlcSettings
  selectedIds: string[]
  tool: ToolMode
  liveSnap: boolean
  /** the generic face-flush fallback (boxes landing flush on neighbour faces) - a separately toggleable
   *  slice of live snap (Shift+N / Snap Settings); declared snaps (conveyor mates, face mounts) unaffected */
  faceSnap: boolean
  space: TransformSpace
  gridSnap: GridSnap
  /** show the flow-direction arrows over conveyors */
  flowArrows: boolean
  /** show the floor reference grid in the viewport (defaults off) */
  showGrid: boolean
  /** draw the scene's annotation chips over the viewport (defaults ON - a placed note is content). Off is
   *  for when the notes are in the way of the thing they annotate, and for a clean presentation shot. */
  showNotes: boolean
  /** show the performance stats overlay (fps/ms/cargo/draws) in the viewport (defaults off) */
  showStats: boolean
  /** show the dim type subtitle on scene-tree rows (defaults on; off yields the width to part names) */
  treeTypes: boolean
  /** "Use Trackball" (U): the rotate gizmo's interior sphere does free trackball rotation */
  trackball: boolean
  /**
   * Viewport camera projection (Perspective/Orthogonal toggle, O / Numpad 5). Mirrors
   * the view's effective projection: the view also changes it itself (orbit-gizmo axis snap
   * engages auto-ortho, orbiting off-axis / pilot / VR revert to perspective) and reports
   * back through controller.onProjectionChanged. Not persisted here: it is stored with the camera pose
   * it was framed at instead (see setProjection).
   */
  projection: ProjectionMode
  /**
   * Guard-openings mode (G): the one selected conveyor that authors `guardOpenings` shows its openings' edge dots
   * instead of its size handles, and a drag along a guard cuts a new one. A session state, never persisted, and
   * it ends by itself when the selection stops being such a conveyor (setState), so it cannot linger unseen.
   */
  sideGuardMode: boolean
  /** guard-openings mode: the opening clicked last (a row of the selected part's guardOpenings, on one wall) */
  selectedGuardOpening: { index: number; guard: 'left' | 'right' } | null
  /** vertex snap "Snap Origin to Vertex" mode (B): click a vertex to jump the selection's origin onto it, vs the default drag-a-vertex-onto-a-vertex */
  vertexSnapOriginMode: boolean
  /** "Snap to Collision Vertices" (default) vs "Snap to Mesh Vertices"; hold Shift while snapping to invert */
  vertexSnapCollision: boolean
  /** 'pilot' is the first-person walk-around mode */
  mode: 'idle' | 'placing' | 'pilot'
  placingType: PartType | null
  /** when placing a 'part' instance, the package id being placed (drives the catalog card highlight) */
  placingPackageId: string | null
  /** The project's part library: every custom part this project defines - authored here ("New part"), imported, or a
   *  built-in edited in this project (a project-local version that shadows the built-in by id). It is the one source of
   *  a project's part definitions: the registry holds the built-ins overlaid by this, and nothing else (a scene's
   *  embedded snapshot only fills an id neither knows). It is stored with the project - in its folder's parts/ on the
   *  desktop, written and read back by the folder sync like any other project file - so a part edited in one project
   *  can never surface in another (the cross-project leak came from a second, profile-wide source). */
  userPackages: PartPackage[]
  /** bumped on every package (geometry) edit/undo so React re-reads the registry - packages live outside
   *  SceneJSON, so this is what makes the Inspector reflect an author-mode edit or its undo. */
  packageRev: number
  /** custom-package id -> latest build error, for parts whose most recent edit failed to compile. Persists
   *  until a successful rebuild clears it; drives a ⚠ badge on the catalog card. */
  packageBuildErrors: Record<string, string>
  /** transient "part failed to build" toasts (auto-dismissed by PartBuildToast) */
  partBuildNotices: PartBuildNotice[]
  /** why the last undo or redo took no step: a program edit whose code has changed since (auto-dismissed) */
  undoNotice: Notice | null
  /** the demo view has just forked into a scene of the user's own, said once (auto-dismissed). See forkNotice */
  demoForkNotice: Notice | null
  /**
   * What the last PLC file transfer (or program command) had to say, shown in the PLC panel: an import's checklist, an
   * export's receipt, a refusal. Store state rather than panel state because the File menu and the palette run the
   * transfers too (editor/program/stFileTransfer.ts) while that panel may be a background tab or not mounted at all, and an
   * import's checklist is the one message that must not vanish on the way.
   */
  stFileReport: StFileReportData | null
  /** the Problems dock lists warnings as well as errors: its own toggle, and the PLC panel's "Show in Problems" */
  problemsShowWarnings: boolean
  /** Why the solo autosave last failed, or null when it's healthy. Sticky (not a timed toast): while this
   *  is set, everything since the last good write is lost on reload, so the warning has to outlive a
   *  glance. Cleared by the next successful write. Usually localStorage quota - see projectFile.SaveResult. */
  autosaveError: string | null
  /** The stored project this session could not open (projectFile.unopenedProject), or null. While set,
   *  nothing is saved over it, so it gets its own banner with the way out (download or discard) rather
   *  than the generic autosave warning. */
  unopenedProject: UnopenedProject | null
  /** Another tab wrote the working copy this tab last saved (projectFile.workingCopySuperseded), so this tab
   *  has stopped saving and is view-only until it reloads. Sticky for the session. */
  supersededByOtherTab: boolean
  /** A newer build of the app has joined this collab room (collab/schema.ts ROOM_BUILD_META), so this tab is
   *  view-only there until it reloads onto that build. Sticky for the session. */
  roomNewerBuild: boolean
  /** first-party custom-part examples bundled with the app (always present, browser + desktop) */
  bundledPackages: PartPackage[]
  /** "open scene" focus: the custom part opened in its own isolated part-scene, or null. The
   * viewport hides every other part and frames this one; the Scene dock shows its rig as the tree. */
  focusedPartId: string | null
  /** Author-mode rig-node selection: one internal link of a custom part, picked for read-only inspection
   * while that part is opened in its own scene (mirrors selecting a node inside an opened scene). Its
   * structure lives in the part script, so this is inspect-only. Mutually exclusive with selectedIds -
   * setting either clears the other. */
  selectedRigNode: { partId: string; linkName: string } | null
  /** Author-mode rig-node lock (editor-only, never serialized): the set of `${partId}\0${linkName}` rig
   * links whose viewport selection + transform gizmo is suppressed (mirrors a locked scene part - still
   * tree-selectable for inspection, just not click-pickable or draggable in the viewport). Keyed via
   * {@link rigNodeKey}. */
  lockedRigNodes: ReadonlySet<string>
  /** packageId of the custom part whose behavior script is open in the in-browser editor, or null. App-level
   * so the editor can be opened from anywhere (scene-tree </> badge, Inspector, …) into one shared mount. */
  behaviorEditTarget: string | null
  /** a request for the Inspector to show one param of one part: open its group, scroll to it, focus it. Raised by a
   *  rig node's "Change Width" (a node axis the part's Width sets), consumed and cleared by the Inspector. UI state
   *  only - never part of the document. `seq` makes a repeat request for the same field a new one. */
  paramFocus: { partId: string; param: string; seq: number } | null
  /** what Copy Properties last took (storeProperties.ts), for Paste Properties. Never part of the document. */
  propertyClipboard: PropertyClipboard | null
  running: boolean
  paused: boolean
  /** sim-clock speed multiplier the user asked for: 0.5 slow-mo … 8 fast-forward, 1 = realtime */
  timeScale: number
  /** The rate the sim clock is actually holding (sim seconds per real second), set only while the
   * worker is persistently short of {@link timeScale}; null while it is keeping up, or stopped.
   * Mirrored from SimClient.clock by the controller - see sim/simClockRate.ts for why it can differ. */
  speedActual: number | null
  /** the view is drawing someone else's run, not a run of its own (controller/liveView.ts) */
  liveFollowing: boolean
  /** whom this client chose to watch (their presence id), or null; a session choice, never saved */
  liveWatch: number | null
  /** this client said no to the owner's current spotlight (live/followTarget.ts) */
  spotlightDismissed: boolean
  /** whose run this client follows now, and why (live/followTarget.ts, kept current by main.tsx joinLiveShare) */
  liveTarget: FollowTarget | null
  /** this client moved its own camera while following, so it no longer follows the other's view (controller/liveCamera.ts) */
  liveViewDetached: boolean
  distractionFree: boolean
  /** Present: only the scene, for a projector or a display (components/PresentOverlay.tsx); a session choice, never saved */
  presenting: boolean
  /** a display link's Present, which cannot be left from inside the app (main.tsx); only its URL sets it */
  presentLocked: boolean
  /** one's own Present with the values panel open for editing the project's display list (components/PresentValues.tsx) */
  presentEditing: boolean
  /** view-only (shared read-only link): authoring is disabled and nothing this client does reaches the shared doc */
  readOnly: boolean
  /** collaborative (room) mode: a shared Yjs doc owns the scene. Mirrors the private `collab` flag so the UI
   * can gate features that aren't room-safe yet (e.g. deleting a part: the package sink has no removal channel). */
  collab: boolean
  /** viewport list-select popup (Alt+RMB / List Select tool); null when closed */
  listSelect: ListSelectMenu | null
  /** pilot-mode crosshair prompt ('Pick up' / 'Drop'); null shows no prompt */
  pilotPrompt: string | null
  /**
   * Dock-door leaves the walking character has used this walk session: building id → the leaf keys that
   * building shows open. Walk mode is a session, not authoring - what the character does is never committed,
   * persisted, collab-synced or undoable, and so never forks the demo view. The controller overlays this onto
   * the view-only scene (editTargetViewScene); the authored `openDoors` param is untouched. Null outside walk
   * mode: dropped when walk mode ends (setState) or the scene is replaced (loadScene).
   */
  walkDoors: Readonly<Record<string, readonly string[]>> | null
  /**
   * Flex conveyors the walking character has pulled into a new shape this walk session: part id -> the pose and params
   * that shape takes (the path points and the bed length, and where the unit stands: pulling the infeed moves its
   * origin, and a pull past full stretch rolls the whole unit; core flexPull). The same kind of state as
   * {@link walkDoors}: never committed, persisted, collab-synced or undoable. The controller overlays it on the view
   * scene AND on the scene the sim runs (a running flex carries along the bed the character laid), and both go back
   * to the authored shape and place when walk mode ends (setState) or the scene is replaced (loadScene).
   */
  walkFlex: Readonly<Record<string, FlexPose>> | null
  /**
   * Parts a stopped-scene Use is operating (the editor's C or the walking character's E): each is showing what the
   * press left it doing, not its authored state. Published by the controller, which owns the devices' live
   * sessions (useSessions); the Inspector reads it to say so and offer Reset. The same kind of state as
   * {@link walkDoors} - never committed, persisted, collab-synced or undoable - but it outlives walk mode: Use is
   * one model in and out of it. Emptied when the scene is replaced (loadScene), which drops the sessions.
   */
  usedIds: readonly string[]
  /**
   * Posable rigs the pose gizmo holds away from their saved idle pose (dragged, or showing a waypoint): the
   * viewport shows a pose that is not saved. The same kind of state as {@link usedIds}, published by the controller
   * (useSessions) for the Inspector to say so and offer Reset. Emptied when the scene is replaced.
   */
  joggedIds: readonly string[]
  /** transient editor-viewport hint (e.g. "In auto - PLC controlled" off a dead C press); the
   * ViewportHint badge auto-dismisses it. `key` is monotonic so a re-flash restarts the timer. */
  viewportHint: { key: number; text: string } | null
  /** follow mode (double-F): the selection the camera is tracking, or null when not following */
  following: FollowState | null
  /** true while a camera-navigation gesture (RMB/Shift+F freefly or pilot) owns the viewport. Freefly
   * lives in the render layer, so React only learns of it through this polled mirror; the viewport
   * toolbar reads it to go pointer-inert, so a stray click (e.g. when a pointer-lock fallback leaves a
   * live but hidden cursor over the toolbar) can't toggle a tool mid-flight. Keyboard tool shortcuts are
   * already suppressed in the controller via view.isNavigating(). */
  navigating: boolean
  /** active "edit a part package's rig as its own scene" session (the Catalog ✎): a throwaway custom
   * instance of the package stamped at the origin (`partId`) so the rig can be focused + edited without
   * a placement. Together with `focusedPartId` this is the authoritative edit scope. The session has a scene of
   * its own: `scene` holds just the throwaway while it is open, and the document's scene is parked in `document`
   * until Back puts it back (`exitPartFocus`). So the throwaway is never in the document - not in an undo step, an
   * autosave or a folder write - and nothing that reads `scene` needs to know about the session. Read the
   * document's scene through {@link documentSceneOf}. null when not editing a package. Read it as a typed value
   * via {@link editTarget} / {@link editStack}. See `enterPackageEdit`. */
  packageEdit: { packageId: string; partId: string; document: SceneJSON } | null
  /** True while the viewport is showing the built-in demo as an ephemeral source rather than one of the
   *  project's scenes: the `?scene=demo` entry URL, or the in-app Demo action. Nothing is minted while
   *  this is up; the first persisting edit forks the demo into the user's own scene
   *  ({@link EditorStore.stashDemoSession}). State rather than a plain field because the switcher renders
   *  it - it labels the live entry `(preview)` and puts the scene-level actions out of reach. */
  demoSession: boolean
  /** the project's display name (the container above the scenes) */
  projectName: string
  /** how many tests the project carries (core/project/project.ts `tests`). Here rather than read off the held
   *  project because it gates a command's enablement, which re-evaluates on every render, and
   *  {@link snapshotProject} captures the live scene as a side effect, so it must not be called for a
   *  question this cheap. The specs themselves travel with the project; only the count is state. */
  testCount: number
  /** the linked project folder's name while the app is following one (see projectFolderLink.ts), else
   *  null. Display + enablement only; the handle itself never enters store state. */
  linkedFolder: string | null
  /** why the last read of that folder failed - an invalid document, a bad part script, lost access.
   *  Sticky like {@link autosaveError}: the folder is the source of truth while linked, so a failed
   *  read means what is on screen no longer matches the disk, and that must not be missable. */
  folderError: string | null
  /** non-fatal note about the linked folder (files it holds that project.json never references).
   *  Separate from folderError: a warning must never gate the link the way an error does. */
  folderNote: string | null
  /**
   * The name of a folder this document is remembered as following but is not following yet, because
   * the browser wants permission re-granted and only a user gesture can ask (projectFolderLink's
   * restore path). Distinct from {@link linkedFolder}, which means the sweep is live: while this is
   * set the disk is not the source of truth, so it must not read as a working link.
   */
  pausedFolder: string | null
  /**
   * The folder the open project lives in, kept in sync both ways (projectFolderSync.ts): its full path on
   * the desktop, its name in the browser (which exposes no path). null for a project stored in the app
   * or browser only.
   */
  folderPath: string | null
  /** Files changed both here and in that folder since the two last agreed, differently. While set, the
   *  folder is neither written nor read; the banner asks which version to keep. */
  folderConflict: string[] | null
  /** what an explicit Save did, and where the work is: "Saved", "Saved in this browser", "Saved as a
   *  folder" (auto-dismissed). editor/project/saveProject.ts, and the desktop folder flows. */
  saveNotice: Notice | null
}

/** Stable key for {@link EditorState.lockedRigNodes}: a part instance + one of its rig links. The NUL
 *  separator can't appear in a part id or link name, so the two fields never collide. */
export function rigNodeKey(partId: string, linkName: string): string {
  return `${partId}\0${linkName}`
}

/** The conveyor guard-openings mode edits: the one selected, unlocked part that authors guardOpenings, while
 *  editing (not placing or walking). Null means the mode has nothing to edit and must be off. */
export function guardOpeningsTarget(s: Pick<EditorState, 'selectedIds' | 'scene' | 'mode'>): PartInstance | null {
  if (s.mode !== 'idle' || s.selectedIds.length !== 1) return null
  const part = s.scene.parts.find((p) => p.id === s.selectedIds[0])
  return part && part.locked !== true && guardArcRange(part) !== null ? part : null
}

/** The state a new EditorStore starts in (its constructor): `scene`, or an empty one, with the machine preferences
 *  read from localStorage and the program as given (the store reads the solo buffer: stProgram.ts is its own seam). */
export function initialEditorState(scene: SceneJSON | undefined, stProgram: string, stScanMs: number): EditorState {
  const plcPrefs = readExternalPlc()
  return {
    scene: scene ?? { version: SCENE_VERSION, parts: [] },
    // Seeded from the solo buffer so a store that is never handed a document (a bare `new
    // EditorStore()` in a test, the legacy no-project boot) still starts with the user's program.
    // Every real boot path replaces it: the project load, the demo, a room's shared doc.
    stProgram,
    stScanMs,
    // the solo buffer predates controller tables; every boot path that carries one replaces this
    controller: null,
    // every real boot path replaces this with the document's own rate (project, room, demo)
    simHz: DEFAULT_SIM_HZ,
    plcPrefs,
    externalPlc: plcSetupOf(scene ?? { parts: [] }, plcPrefs),
    selectedIds: [],
    tool: 'transform',
    liveSnap: readLiveSnap(),
    faceSnap: readFaceSnap(),
    space: readSpace(),
    gridSnap: readGridSnap(),
    flowArrows: readFlowArrows(),
    showGrid: readShowGrid(),
    showNotes: readShowNotes(),
    showStats: readShowStats(),
    treeTypes: readTreeTypes(),
    trackball: readTrackball(),
    projection: 'perspective',
    sideGuardMode: false,
    selectedGuardOpening: null,
    vertexSnapOriginMode: readVertexSnapOrigin(),
    vertexSnapCollision: readVertexSnapCollision(),
    mode: 'idle',
    placingType: null,
    placingPackageId: null,
    userPackages: [],
    packageRev: 0,
    packageBuildErrors: {},
    partBuildNotices: [],
    undoNotice: null,
    demoForkNotice: null,
    stFileReport: null,
    problemsShowWarnings: false,
    autosaveError: null,
    unopenedProject: null,
    supersededByOtherTab: false,
    roomNewerBuild: false,
    bundledPackages: [],
    focusedPartId: null,
    selectedRigNode: null,
    lockedRigNodes: new Set(),
    behaviorEditTarget: null,
    paramFocus: null,
    propertyClipboard: null,
    running: false,
    paused: false,
    timeScale: 1,
    speedActual: null,
    liveFollowing: false,
    liveWatch: null,
    spotlightDismissed: false,
    liveTarget: null,
    liveViewDetached: false,
    distractionFree: false,
    presenting: false,
    presentLocked: false,
    presentEditing: false,
    readOnly: false,
    collab: false,
    listSelect: null,
    pilotPrompt: null,
    walkDoors: null,
    walkFlex: null,
    usedIds: [],
    joggedIds: [],
    viewportHint: null,
    following: null,
    navigating: false,
    packageEdit: null,
    demoSession: false,
    projectName: 'Untitled Project',
    testCount: 0,
    linkedFolder: null,
    folderError: null,
    folderNote: null,
    pausedFolder: null,
    folderPath: null,
    folderConflict: null,
    saveNotice: null,
  }
}
