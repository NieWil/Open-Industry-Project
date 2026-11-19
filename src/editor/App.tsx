import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { WebGLRenderer } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { IRenderView } from '../render/api'
import { RenderView } from '../render/viewport/view'
import { createWebGPURenderer, wantsWebGPU } from '../render/viewport/createRenderer'
import { getPartThumbnails, renderPackageThumbnails } from '../render/viewport/thumbnails'
import { whenCoverHidden, whenScenePainted } from '../render/renderReady'
import { gpuErrorReport } from '../render/gpuErrorWatch'
import { noteActiveRenderer, renderQuality, shadowMapSize } from '../render/quality'
import type { PartType } from '../core/types'
import type { PartPackage } from '../core/parts/partPackage'
import { sameAsBuiltIn } from '../core/builtInVersion'
import { resolveKeyAction } from '../core/keymap'
import type { SimClient } from '../sim/client'
import { getCollabContext } from '../collab/session'
import { Catalog } from './components/Catalog'
import { CommandPalette } from './components/CommandPalette'
import { importBehaviorEditor } from './components/behaviorEditorChunk'
import { DockColumn } from './components/DockColumn'
import { DockSlot } from './components/DockSlot'
import { HistoryPanel } from './components/HistoryPanel'
import { ProblemsPanel } from './components/ProblemsPanel'
import { Inspector } from './components/Inspector'
import { PopoutWindow } from './components/PopoutWindow'
import { inDialogOrMenu, keyBelongsToTarget, useKeydownEverywhere, useKeyupEverywhere } from './dialogHost'
import { PresenceOverlay } from './components/PresenceOverlay'
import { PresentOverlay } from './components/PresentOverlay'
import { ModelLoadingIndicator } from './components/ModelLoadingIndicator'
import { ViewportLoadingCover } from './components/ViewportLoadingCover'
import { PilotHud } from './components/PilotHud'
import { FollowBadge } from './components/FollowBadge'
import { ViewportHint } from './components/ViewportHint'
import { PilotTouchControls } from './components/PilotTouchControls'
import { PilotFab } from './components/PilotFab'
import { ResizeCorner, ResizeGutter, type ResizeTrack } from './components/ResizeGutter'
import { SceneTree } from './components/SceneTree'
import { PlcPanel } from './components/plc/PlcPanel'
import type { SettingsTab } from './components/SettingsOverlay'
import { ProjectsOverlay } from './components/ProjectsOverlay'
import { FolderLinkBanner } from './components/FolderLinkBanner'
import { beginFolderLink, reconnectProjectFolder, restoreFolderLink, saveProjectToFolderHandle, unlinkProjectFolder } from './project/projectFolderLink'
import { resolveFolderConflict, restoreFolderSync, syncFolderNow, syncedFolderPath } from './project/projectFolderSync'
import { splitFiling } from './project/projectSplit'
import { connectDesktopOpenRequests } from './desktop/desktopProjectBridge'
import { connectDesktopFileOpens } from './desktop/desktopFileOpen'
import { importProjectFile } from './project/importProjectFile'
import { TutorialOverlay } from './components/TutorialOverlay'
import { PHONE_QUERY } from './demo/phoneDemo'
import { UpdatePrompt } from './components/UpdatePrompt'
import { DesktopUpdateToast } from './components/DesktopUpdateToast'
import { BenchOverlay } from './components/BenchOverlay'
import { BENCH_STORAGE_KEY, BenchRun, createScreenWakeLock, readBenchParams, readSavedBench } from './bench'
import { StatsOverlay } from './components/StatsOverlay'
import type { FrameStats } from './components/StatsOverlay'
import { AnnotationOverlay } from './components/AnnotationOverlay'
import { PartBuildToast } from './components/PartBuildToast'
import { NoticeToast } from './components/NoticeToast'
import { TranslateToast } from './components/TranslateToast'
import { installDemoForkHost } from './demo/demoFork'
import { AutosaveBanner } from './components/AutosaveBanner'
import { UnopenedProjectBanner } from './components/UnopenedProjectBanner'
import { OtherTabBanner } from './components/OtherTabBanner'
import { NewerBuildBanner } from './components/NewerBuildBanner'
import { RoomCodePrompt } from './components/RoomCodePrompt'
import { NameDialogHost } from './components/NameDialog'
import { PartChangeDialogHost } from './components/PartChangeDialog'
import { ExportProjectDialog } from './components/ExportProjectDialog'
import { Toolbar } from './components/Toolbar'
import { ViewportSelectMenu } from './components/ViewportSelectMenu'
import { ViewportToolbar } from './components/ViewportToolbar'
import { GuardOpeningsBanner } from './components/GuardOpeningsBanner'
import { EditorController } from './controller'
import { connectDesktopAgent } from './agent/desktopAgent'
import type { AgentSession } from './agent/agentSession'
import { discardUnopenedProject, downloadProject, downloadUnopenedProject, savedWorkingCopyText } from './project/projectFile'
import { DEMO_SCENE_NAME } from './demo/demoScenes'
import { assetsBusy } from '../render/gltf'
import { connectDesktopPackages } from './parts/packageSource'
import { loadBundledExamples } from './parts/bundledExamples'
import {
  activateDockPanel,
  BOTTOM_MAX_SHARE,
  BOTTOM_MIN,
  bottomDockHeight,
  buildDockGrid,
  clearMaximized,
  clickDockTab,
  defaultDockLayout,
  DOCK_SIZES_VERSION,
  dockGridCorners,
  dockSizeVar,
  dockPanelTitle,
  floatDockPanel,
  FLOATABLE_PANELS,
  isColumnCollapsed,
  isFloating,
  isPoppedOut,
  locate,
  MAXIMIZABLE_PANELS,
  migrateDockSizes,
  moveDockPanel,
  moveDockPanelBefore,
  parseBottomHeights,
  popoutDockPanel,
  POPOUT_PANELS,
  readDockLayout,
  revealDockPanel,
  revealNeedsDocks,
  saveDockLayout,
  tabShowsPanel,
  toggleMaximizePanel,
  type BottomHeights,
  type DockLayout,
  type DockLocation,
  type DockPanelId,
  type DockSide,
  type DockSlotId,
} from './dockLayout'
import { DESKTOP_MAC, DESKTOP_SHELL, getDesktopUpdate, getOipMenuApi } from './desktop/desktopMenuBridge'
import { commandEnabled, desktopMenuModel, menuEnablement, runCommand, runMenuCommand, setCommandCtx, type CommandUi } from './commands'
import type { EditorStore } from './store/store'
import type { ProjectJSON } from '../core/project/project'
import { RestoreIcon } from './components/toolbarIcons'
import { importPartFiles, partFilesOf } from './parts/importPartFiles'
import { handToPartsDock, readPartDrop } from './parts/partDrop'
import { defineMessages, t } from '../core/i18n'

// Lazy so Monaco + its TS worker stay OUT of the main bundle and only download when the editor is opened.
// One app-level mount (driven by store.behaviorEditTarget) is shared by every "edit behavior" entry point.
// The import lives in behaviorEditorChunk so the </> / Edit-script triggers can preload it on hover.
const BehaviorEditor = lazy(importBehaviorEditor)
// Lazy for the same reason as the panels' own chunks: Controller Properties is a dialog opened on demand (the
// organizer's Controller node, the toolbar's link status, Simulation > PLC Controllers…), never before the first frame
const ControllerDialog = lazy(() => import('./components/plc/ControllerDialog').then((m) => ({ default: m.ControllerDialog })))
const AssignControllerDialog = lazy(() => import('./components/plc/AssignControllerDialog').then((m) => ({ default: m.AssignControllerDialog })))
// Settings and the test results are opened on demand too; lazy, they kept the eager-JS budget (scripts/lib/eager-js.mjs)
// from a raise when the flow-facts and rig-gizmo work grew the first frame
const SettingsOverlay = lazy(() => import('./components/SettingsOverlay').then((m) => ({ default: m.SettingsOverlay })))
const GetPartsWindow = lazy(() => import('./components/GetPartsWindow').then((m) => ({ default: m.GetPartsWindow })))
const PublishPartDialog = lazy(() => import('./components/PublishPartDialog').then((m) => ({ default: m.PublishPartDialog })))
const TestResultsOverlay = lazy(() => import('./components/TestResultsOverlay').then((m) => ({ default: m.TestResultsOverlay })))
// desktop only, and loaded at an agent's first call, so it stays off the first frame
// LAZY: the watch dock is a background tab until a program is being debugged, and it brings the declaration reader
const WatchPanel = lazy(() => import('./components/plc/WatchPanel').then((m) => ({ default: m.WatchPanel })))
const AgentActivity = lazy(() => import('./components/AgentActivity').then((m) => ({ default: m.AgentActivity })))

const M = defineMessages('app', {
  tabScene: 'Scene',
  tabParts: 'Parts',
  tabInspect: 'Inspect',
  tabPlc: 'PLC',
  rendererUnavailable: 'Renderer unavailable: {error}',
  restoreTitle: 'Restore {panel} (Esc)',
  restorePanel: 'Restore panel',
  popoutFailed: 'Could not open a separate window: {reason}.\n\nAllow pop-ups for this site and try again.',
  savedProject: 'the saved project',
  namedProject: '“{name}”',
  discardConfirm:
    'Discard {which}? It is removed from this browser for good. Download it first to keep a copy. What is on screen is saved as a new project instead.',
})

// The app half of the window title. Matches the <title> in app/index.html, which is what the tab reads
// until the first render replaces it with the document name (see the title effect in App).
const APP_TITLE = 'Open Industry Project'

const noSubscribe = (): (() => void) => () => {}
/** a file the user picked that failed to import, said as the importers say their own failures */
const alertFailure = (e: unknown): void => alert(e instanceof Error ? e.message : String(e))

const DOCK_SIZE_KEY = 'oip-web/dock-sizes'
// left/right (+ left2/right2 for the secondary/inner columns) = side column widths;
// leftTop/rightTop (+ *2) = height of each column's Top sub-slot when it's split Top/Bottom.
// The bottom dock's height is per panel, not here: see dockLayout's DEFAULT_BOTTOM_HEIGHT.
// right = 320: at 280 a conveyor's or a robot's Inspector ran 60-70px wider than its column.
// left = 260: at 220 the demo's tree cut 7 of its 22 names short, two of them to the same "Layer com...";
// 240 still cut 2, and 260 is where all of them fit, at 1366 as at 1920 (a tree's names do not grow with the window).
const DEFAULT_SIZES = {
  left: 260,
  right: 320,
  left2: 220,
  right2: 280,
  leftTop: 260,
  rightTop: 260,
  leftTop2: 260,
  rightTop2: 260,
}
type DockSizes = typeof DEFAULT_SIZES

/** the stored dock-sizes blob, brought up to date (dockLayout's migrateDockSizes); {} when there is none */
function readStoredDockSizes(): Record<string, unknown> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(DOCK_SIZE_KEY)
    return raw ? migrateDockSizes(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

function readDockSizes(): DockSizes {
  const parsed = readStoredDockSizes()
  const pick = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const out = { ...DEFAULT_SIZES }
  for (const key of Object.keys(DEFAULT_SIZES) as (keyof DockSizes)[]) {
    out[key] = pick(parsed[key], DEFAULT_SIZES[key])
  }
  return out
}

const readBottomHeights = (): BottomHeights => parseBottomHeights(readStoredDockSizes())

/**
 * The bottom dock's current height, read off the screen when a drag starts: its row is the last in the grid, so it
 * runs from the gutter to the bottom of the shell. Read rather than taken from state because a panel that has never
 * been dragged stands at a share of the window (the PLC editor's default), which is no px number until laid out.
 */
const bottomDockOnScreen = (gutter: HTMLElement): number => {
  const root = gutter.closest('.app')
  return root ? root.getBoundingClientRect().bottom - gutter.getBoundingClientRect().bottom : BOTTOM_MIN
}

/** the tallest the bottom dock may be dragged: a share of the shell below the toolbar, so some viewport always stays */
const bottomDockMax = (gutter: HTMLElement): number => {
  const root = gutter.closest('.app')
  return root ? (root.clientHeight - 48) * BOTTOM_MAX_SHARE : 480
}

// The docked desktop layout needs width for the side docks AND height for the
// toolbar + bottom catalog dock. Width is the constraint in portrait; height is
// the constraint in landscape. A phone held sideways is wide (so a width-only test
// misses it) but only ~400px tall, so the docks can't fit - catch it with a
// landscape max-height clause. Tablets in landscape are ~750px+ tall and DO fit,
// so that threshold is the phone-height ceiling (560), not 820: this rescues phones
// without pulling iPad-landscape (810px+ tall, wide enough for docks) into drawers.
const MOBILE_QUERY = '(max-width: 820px), (orientation: landscape) and (max-height: 560px)'
// Phones get a view/select/run experience: no part authoring, so the Parts catalog
// and the viewport transform tools are dropped (tablets keep the full touch editor).
// Orientation-independent so a phone stays a phone when rotated: ≤560 on its short side.
// PHONE_QUERY lives in phoneDemo.ts, because the boot reads it too (an empty phone opens the demo).

type MobilePanel = 'tree' | 'catalog' | 'inspector' | 'st'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = (): void => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

function TreeTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 5h12M4 10h12M4 15h12" strokeLinecap="round" />
    </svg>
  )
}

function PartsTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1" />
      <rect x="11" y="3.5" width="5.5" height="5.5" rx="1" />
      <rect x="3.5" y="11" width="5.5" height="5.5" rx="1" />
      <rect x="11" y="11" width="5.5" height="5.5" rx="1" />
    </svg>
  )
}

function InspectTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3.5 6h13M3.5 14h13" strokeLinecap="round" />
      <circle cx="8" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="13" cy="14" r="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** The PLC tab: a chip with two legs, the "there's a controller in here" glyph */
function PlcTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
      <path d="M8 3v2.5M12 3v2.5M8 14.5V17M12 14.5V17M3 8h2.5M3 12h2.5M14.5 8H17M14.5 12H17" strokeLinecap="round" />
    </svg>
  )
}

interface MobileTabBarProps {
  panel: MobilePanel | null
  onToggle: (panel: MobilePanel) => void
  /** the Parts catalog tab - hidden on phones, which don't author parts */
  showCatalog: boolean
  /** the PLC tab - hidden when the panel is in a window of its own (see App) */
  showPlc: boolean
}

/** Mobile nav: one tap toggles each panel's drawer open/closed */
function MobileTabBar({ panel, onToggle, showCatalog, showPlc }: MobileTabBarProps) {
  const tab = (id: MobilePanel, label: string, Icon: () => ReactElement) => (
    <button
      className={`mobile-tab${panel === id ? ' active' : ''}`}
      aria-pressed={panel === id}
      onClick={() => onToggle(id)}
    >
      <Icon />
      {label}
    </button>
  )
  return (
    <nav className="mobile-tabbar">
      {tab('tree', t(M.tabScene), TreeTabIcon)}
      {showCatalog && tab('catalog', t(M.tabParts), PartsTabIcon)}
      {tab('inspector', t(M.tabInspect), InspectTabIcon)}
      {showPlc && tab('st', t(M.tabPlc), PlcTabIcon)}
    </nav>
  )
}

/** a copy of `prev` with `ids` added (present) or removed - for the in-flight thumbnail set */
function setWith(prev: ReadonlySet<string>, ids: readonly string[], present: boolean): Set<string> {
  const next = new Set(prev)
  for (const id of ids) {
    if (present) next.add(id)
    else next.delete(id)
  }
  return next
}

function nullView(): IRenderView {
  return {
    syncScene() {},
    setHoldDeparted() {},
    setSelection() {},
    setStaging() {},
    setPoolDragEject() {},
    warmPart() {},
    heldParts: () => 0,
    whenPartsRevealed: () => Promise.resolve(),
    flashSnap() {},
    vertexSnapSource: () => null,
    vertexSnapTarget: () => null,
    cameraPlanePoint: () => null,
    showVertexMarkers() {},
    setFlowArrowsVisible() {},
    setGridVisible() {},
    setDisplayUnits() {},
    applyBoxFrame() {},
    applyIdlePose() {},
    setHandPosed() {},
    clearBoxes() {},
    setRunning() {},
    resetFrameClock() {},
    setRobotGizmo() {},
    pickRobotHandle: () => null,
    setRobotHighlight() {},
    beginRobotDrag() {},
    robotDragResult: () => null,
    endRobotDrag() {},
    hasRigGizmo: () => false,
    rigGizmoJointAngle: () => 0,
    poseRigGizmoJoint() {},
    pickPart: () => null,
    pickPartsAt: () => [],
    pickBox: () => null,
    groundPoint: () => null,
    measurePoint: () => null,
    surfaceBelow: () => null,
    surfaceAt: () => null,
    partsInRect: () => [],
    cargoBodiesInRect: () => [],
    setRigNodeHighlight() {},
    refreshPackage() {},
    rigLinkGizmo: () => null,
    rigJointPose: () => null,
    rigJogged: () => false,
    resetRigJog() {},
    setRigJointPose() {},
    pickRigLink: () => null,
    setGizmo() {},
    pickGizmoHandle: () => null,
    setGizmoHighlight() {},
    beginGizmoDrag() {},
    gizmoDragDelta: () => null,
    gizmoConstrain() {},
    endGizmoDrag() {},
    setTransformReadout() {},
    setResizeHandles() {},
    setSideGuardMode() {},
    pickGuardWall: () => null,
    setGuardWallHover() {},
    setSelectedGuardOpening() {},
    beginGuardWallDrag() {},
    setGuardJunctionOpenings() {},
    pickResizeHandle: () => null,
    setResizeHighlight() {},
    beginResizeDrag() {},
    resizeDragExtent: () => null,
    resizeDragPoint: () => null,
    endResizeDrag() {},
    setRuler() {},
    snapToAxis() {},
    focusOn() {},
    startFollow() {},
    stopFollow() {},
    isFollowing: () => false,
    isNavigating: () => false,
    cameraPose: () => ({ px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 }),
    lookPose: () => ({ px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 }),
    zoomWheel() {},
    pointerDownThrough() {},
    setCameraPose() {},
    setProjection() {},
    projectionMode: () => 'perspective',
    projectionAuto: () => false,
    loadProjection() {},
    onProjectionChanged: null,
    onCameraSettled: null,
    vrSupported: () => Promise.resolve(false),
    enterVR: () => Promise.resolve(false),
    exitVR() {},
    isVRPresenting: () => false,
    partWorldPosition: () => null,
    worldToScreen: () => ({ x: 0, y: 0, visible: false }),
    setPilotActive() {},
    pilotLookBox: () => null,
    pilotLookParts: () => [],
    pilotLookDockLeaf: () => null,
    pilotHoldPoint: () => null,
    setPilotSpeedLimit() {},
    pilotBodyPosition: () => null,
    pilotPose: () => null,
    pilotSetMove() {},
    pilotLook() {},
    pilotInteract() {},
    setPilotAimLive() {},
    setPilotAvatars() {},
    showRotationFeedback() {},
    getStats: () => ({ drawCalls: 0, drawPath: null, triangles: 0, cpuMs: 0, cpuTotalMs: 0, frames: 0, gpuMs: null, gpuTotalMs: null, gpuFrames: 0, refreshMs: null, missedFrames: 0, backend: 'WebGL', matrixLiveParts: 0, textures: 0, geometries: 0 }),
    dispose() {},
  }
}

interface AppProps {
  store: EditorStore
  sim: SimClient
}

export function App({ store, sim }: AppProps) {
  // Remove the boot skeleton (app/index.html) now that the real shell exists. It is a layout effect, so the
  // skeleton is gone in the same frame the app first paints. A passive effect or a rAF would leave one frame
  // with both on screen. It sits above the app (z-index) until then, so the reverse overlap can't
  // happen either. Idempotent: the node is absent on every render after the first, and in the e2e
  // harness's own pages.
  useLayoutEffect(() => {
    document.getElementById('boot-skeleton')?.remove()
  }, [])

  const state = useSyncExternalStore(store.subscribe, store.getState)
  const viewportRef = useRef<HTMLDivElement>(null)
  const frameStats = useRef<FrameStats>({ dtEma: 0 })
  // a ref the rAF onFrame reads so it always sees the live controller (the
  // closure is created before the controller exists)
  const ctrlRef = useRef<EditorController | null>(null)
  // ?bench (bench.ts): the live run, read by the rAF onFrame the same way ctrlRef is. `benchRun`
  // mirrors it into state only so the overlay mounts; the object itself mutates in place.
  const benchRef = useRef<BenchRun | null>(null)
  const [benchRun, setBenchRun] = useState<BenchRun | null>(null)
  const [benchEnabled] = useState(() => readBenchParams(typeof location === 'undefined' ? '' : location.search).enabled)
  // Read once, before this load's run can overwrite the slot: a blob parked here by an earlier
  // load is the only evidence of a run whose tab was killed, which is the outcome the benchmark
  // most needs to report (an iOS tab kill at a raised pixel ratio).
  const [benchRecovered] = useState(() => {
    try {
      return readSavedBench(localStorage.getItem(BENCH_STORAGE_KEY))
    } catch {
      return null
    }
  })
  const [controller, setController] = useState<EditorController | null>(null)
  // what a connected agent is doing and has changed (agent/agentSession.ts): handed over by the agent door once its
  // tools load, so null in the browser and until then
  const [agentSession, setAgentSession] = useState<AgentSession | null>(null)
  // the chip's chunk loads at the agent's first call, not at boot
  const agentCalled = useSyncExternalStore(agentSession?.subscribe ?? noSubscribe, () => (agentSession ? agentSession.getSnapshot().busy !== null || agentSession.getSnapshot().calls > 0 : false))
  const [view, setView] = useState<IRenderView | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  const [thumbnails, setThumbnails] = useState<Map<PartType, string>>(() => new Map())
  // runtime-rendered thumbnails for custom-part packages, keyed by package id (built-ins have static webp
  // assets; packages are dynamic so there are none - without this a custom card shows only a placeholder glyph)
  const [packageThumbnails, setPackageThumbnails] = useState<Map<string, string>>(() => new Map())
  // package ids whose offscreen thumbnail render is in-flight - drives the catalog's
  // shimmer skeleton so a still-rendering card reads differently from one that genuinely has no image
  const [pendingThumbs, setPendingThumbs] = useState<ReadonlySet<string>>(() => new Set())
  const [sizes, setSizes] = useState<DockSizes>(readDockSizes)
  // the bottom dock's height per panel, for those someone has dragged (the rest stand at their defaults)
  const [bottomHeights, setBottomHeights] = useState<BottomHeights>(readBottomHeights)
  // which dock slot (Left / Right / Bottom) holds each panel - reorganizable
  const [dockLayout, setDockLayout] = useState<DockLayout>(readDockLayout)
  // null = closed; otherwise the tab the dialog opens on (Keyboard from '?' and the Help menu,
  // Preferences from the Settings command)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [getPartsOpen, setGetPartsOpen] = useState(false)
  // the part Publish to Part Library is open for, by package id
  const [publishPartId, setPublishPartId] = useState<string | null>(null)
  // the projects list (File > Projects). Plain boolean: it reads the library itself and holds no
  // state of its own worth lifting - every action in it ends in a reload (documentStore).
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [controllerPropsOpen, setControllerPropsOpen] = useState(false)
  const [assignControllerOpen, setAssignControllerOpen] = useState(false)
  // The project a test run is grading. Cloned at open (see commandUi) so the run is judged against the
  // document as it was when the user asked, not as it drifts while the specs step.
  const [testProject, setTestProject] = useState<ProjectJSON | null>(null)
  const isMobile = useMediaQuery(MOBILE_QUERY)
  // phones are view/select/run only - no part authoring (catalog + transform tools dropped)
  const isPhone = useMediaQuery(PHONE_QUERY)
  // touch (no mouse-look / pointer lock): pilot mode shows its on-screen joystick instead. Matches
  // the same query the renderer uses to put the Pilot in touch mode, so the two never disagree.
  const isTouch = useMediaQuery('(pointer: coarse)')
  const [mobilePanel, setMobilePanel] = useState<MobilePanel | null>(null)
  // hidden PLC-program picker (.st / PLCopen XML), the same arrangement: the PLC panel's Import button, the File
  // menu and the palette all reach it through the file.importPlc command
  const plcImportRef = useRef<HTMLInputElement>(null)
  // hidden project-file picker (.oip), the same arrangement again: the scene switcher's Import button, the File
  // menu, the palette and the desktop menu all reach it through the file.importProject command
  const projectImportRef = useRef<HTMLInputElement>(null)

  // On tablets you place by tapping a catalog card then tapping the viewport, so the
  // Parts sheet stays open across placements. Leaving that sheet (or switching panels)
  // ends placing mode, so a stray viewport tap can't drop an unexpected part. On phones
  // there's no catalog at all, so the Parts panel is force-closed if a resize leaves it open.
  useEffect(() => {
    if (isPhone && mobilePanel === 'catalog') setMobilePanel(null)
    if (isMobile && mobilePanel !== 'catalog' && state.mode === 'placing') store.cancelPlacing()
    // narrowing to the mobile layout drops the desktop docks entirely, taking the ⛶ that
    // restores a maximized panel with them - clear it so a resize can't strand one
    if (isMobile) setDockLayout(clearMaximized)
  }, [isMobile, isPhone, mobilePanel, state.mode, store])

  // Persist the dock sizes on a trailing delay, never inline with the change: the write is a
  // synchronous JSON.stringify + localStorage round-trip, and a gutter drag or a reset can
  // produce several in quick succession, so one 0.5 s one-shot timer absorbs the burst.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(DOCK_SIZE_KEY, JSON.stringify({ ...sizes, bottom: bottomHeights, version: DOCK_SIZES_VERSION }))
      } catch {
        // best-effort UI preference
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [sizes, bottomHeights])

  useEffect(() => saveDockLayout(dockLayout), [dockLayout])

  // ── Document identity ───────────────────────────────────────────────────
  // The app opens straight onto the autosave (main.tsx), so the window title names the open document, as VS Code
  // and Blender do. In the browser this is the tab. The desktop shell hides the OS title bar (main.cjs), so there it
  // is the taskbar / window-switcher entry. In-window the project menu carries the name (ProjectMenu.tsx).
  //
  // A room stays the bare app name on purpose: the collab doc is the document there and `projectName`
  // is still this browser’s own local default. The demo names itself as the example, because it is no
  // project of the user's until an edit forks it (store.stashDemoSession).
  useEffect(() => {
    const doc = state.collab ? null : state.demoSession ? `${DEMO_SCENE_NAME} (example)` : state.projectName.trim()
    document.title = doc ? `${doc} - ${APP_TITLE}` : APP_TITLE
  }, [state.collab, state.demoSession, state.projectName])

  // ── Commands ───────────────────────────────────────────────────────────────────────────────────
  // Every app-level action (File/Edit/Simulation/View) lives once in editor/commands.ts; the toolbar,
  // the native menu, the palette and the tree's context menu all render that list. This block publishes the
  // live context the registry runs against and, in the desktop shell, keeps the native menu in sync with it.
  // Export Project's choices (ExportProjectDialog), open on the project as it was when asked
  const [exportChoices, setExportChoices] = useState<ProjectJSON | null>(null)
  const commandUi = useMemo<CommandUi>(
    () => ({
      openProjectExport: () => setExportChoices(store.snapshotProject()),
      openPlcImportPicker: () => plcImportRef.current?.click(),
      openProjectFilePicker: () => projectImportRef.current?.click(),
      resetLayout: () => {
        setDockLayout(defaultDockLayout())
        setSizes({ ...DEFAULT_SIZES })
        setBottomHeights({})
      },
      showShortcuts: () => setSettingsTab('shortcuts'),
      showSettings: () => setSettingsTab('preferences'),
      showGetParts: () => setGetPartsOpen(true),
      showPublishPart: (packageId) => setPublishPartId(packageId),
      showCommandPalette: () => setPaletteOpen(true),
      showControllerProperties: () => setControllerPropsOpen(true),
      showAssignController: () => setAssignControllerOpen(true),
      showProjects: () => setProjectsOpen(true),
      // snapshotProject returns the store's own held document ("serialize it immediately, don't hold
      // or mutate it"), and a run outlives this call - so clone before handing it to the overlay
      runTests: () => setTestProject(structuredClone(store.snapshotProject())),
    }),
    [store],
  )
  // Reload PLC Program's enablement reads the controller's attach record, which moves without a store change (an
  // attach, a fault dropping the program): re-render on it, so the menu enablement pushed below still describes it.
  const subscribeProgram = useCallback((cb: () => void) => controller?.onProgramStatus(cb) ?? (() => {}), [controller])
  useSyncExternalStore(subscribeProgram, () => controller?.programStatus ?? null)
  // Published on every render rather than through a ref read at call time: enablement is derived from
  // this exact state, and the menu enablement pushed below has to describe the frame the user sees.
  setCommandCtx({ store, controller, state, ui: commandUi })

  // The native menu dispatches by command id; unknown or disabled ids are dropped by runCommand, so a
  // menu item whose enabled flag is one IPC hop stale can't do what the on-screen button refuses to.
  useEffect(() => {
    const api = getOipMenuApi()
    if (!api) return
    return api.onCommand((id) => runMenuCommand(id))
  }, [])

  // The menu structure is data in commands.ts, so main renders it instead of holding a second copy of
  // every label. It is sent once. After that only the {id: enabled} map is sent, and only when it changes,
  // because this effect runs on each render, which for a scene edit means every commit.
  const sentEnablement = useRef('')
  useEffect(() => {
    getOipMenuApi()?.setMenu?.(desktopMenuModel())
    sentEnablement.current = ''
  }, [])
  useEffect(() => {
    const api = getOipMenuApi()
    if (!api?.setMenuEnabled) return
    const map = menuEnablement()
    const key = JSON.stringify(map)
    if (key === sentEnablement.current) return
    sentEnablement.current = key
    api.setMenuEnabled(map)
  })

  // Ctrl+Shift+P opens the palette - the web's only path to the commands that have no button. Capture
  // phase and its own listener, like the shortcuts overlay above it, so it works with focus anywhere
  // that isn't a text field (typing Ctrl+Shift+P into the ST editor should reach the editor).
  // Listens in every window the app has open (dialogHost.ts), so it works from a popped-out panel too.
  useKeydownEverywhere((e) => {
    if (resolveKeyAction(e, 'editor') !== 'ui.commands') return
    if (keyBelongsToTarget(e)) return
    e.preventDefault()
    setPaletteOpen((v) => !v)
  }, true)

  // Ctrl+S is the app's Save (commands.ts file.save), bound here rather than by a menu so it works in the
  // browser, which has no menu. Unbound, it reaches the browser's "Save page as" and saves the app's HTML.
  // Capture phase, and not skipped in text fields: code editors save from inside the editor, and the browser
  // dialog must be kept out of there too. The default is prevented even when
  // Save is unavailable (a view-only link), for the same reason.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (resolveKeyAction(e, 'editor') !== 'file.save') return
      e.preventDefault()
      if (!e.repeat) runCommand('file.save')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The transport's keys (keymap sim.playPause / sim.stop / sim.step): Space plays or pauses, Shift+Space stops,
  // Shift+Period steps a paused run. These are
  // for the browser, where F5 (the desktop menu's key) reloads the page. They are ignored where Space already means
  // something: text (the ST code, a name field), a dialog or menu (Space confirms or picks there), and free fly,
  // whose boost is Space. Everywhere else Space toggles the run, even on a focused button, as in a video player.
  // After a mouse click on Pause the focus stays on it, and Space must toggle the run once, not also click the
  // button. Enter still presses a focused button. The browser clicks a button on Space's keyup, so that is
  // suppressed too. Listens in every window, so the keys also work from a popped-out ladder.
  const transportSpace = useRef(false)
  const transportAction = (e: KeyboardEvent): 'sim.playPause' | 'sim.stop' | 'sim.step' | null => {
    const action = resolveKeyAction(e, 'editor')
    if (action !== 'sim.playPause' && action !== 'sim.stop' && action !== 'sim.step') return null
    if (keyBelongsToTarget(e, { spaceOnButton: false }) || inDialogOrMenu(e.target)) return null
    // free fly, not walk mode: in walk mode Space is free, so it pauses the run and the user can look at the line
    if (controller?.view.isNavigating() && state.mode !== 'pilot') return null
    return action
  }
  useKeydownEverywhere((e) => {
    const action = transportAction(e)
    if (!action) return
    e.preventDefault() // no page scroll, no button press
    if (action === 'sim.step') {
      // a held Step repeats on purpose: each auto-repeat is one more step
      if (commandEnabled('sim.step')) runCommand('sim.step')
      return
    }
    transportSpace.current = true
    if (e.repeat) return // held down, it must not flicker between paused and running
    if (action === 'sim.stop') runCommand('sim.stop')
    else runCommand(commandEnabled('sim.run') ? 'sim.run' : 'sim.pause')
  }, true)
  useKeyupEverywhere((e) => {
    if (e.code !== 'Space' || !transportSpace.current) return
    transportSpace.current = false
    e.preventDefault()
  }, true)


  const moveDock = useCallback(
    // `before` undefined (the ▾ menu) appends; a panel id / null (tab drag-reorder) inserts at that spot
    (panel: DockPanelId, to: DockSlotId, before?: DockPanelId | null) =>
      setDockLayout((l) =>
        before === undefined ? moveDockPanel(l, panel, to) : moveDockPanelBefore(l, panel, to, before),
      ),
    [],
  )
  const activateDock = useCallback(
    (panel: DockPanelId) => setDockLayout((l) => activateDockPanel(l, panel)),
    [],
  )
  // left-click on a dock tab: the fold toggle (clickDockTab rolls up the bottom dock or folds a side column to a rail).
  // A left-click that leaves the PLC panel open also puts the keyboard in its code, so the click that brings it up is
  // the one that starts typing. Judged on the current layout, like onRevealPanel below.
  const clickTab = useCallback(
    (panel: DockPanelId) => {
      setDockLayout((l) => clickDockTab(l, panel))
      if (panel === 'st' && tabShowsPanel(clickDockTab(dockLayout, panel), panel)) store.focusStCode()
    },
    [store, dockLayout],
  )
  const floatDock = useCallback((panel: DockPanelId) => setDockLayout((l) => floatDockPanel(l, panel)), [])
  const canFloat = useCallback((panel: DockPanelId) => FLOATABLE_PANELS.includes(panel), [])
  // Where a popped-out panel came from, so closing its window puts it back there rather than at
  // some default. A ref, not layout state: it describes an undo target for a window that only
  // exists in this session, and dockLayout deliberately does not persist popouts at all.
  const popoutOrigin = useRef<Record<string, DockLocation>>({})
  const popoutDock = useCallback(
    (panel: DockPanelId) =>
      setDockLayout((l) => {
        const next = popoutDockPanel(l, panel)
        if (next !== l) popoutOrigin.current[panel] = locate(l, panel)
        return next
      }),
    [],
  )
  const canPopout = useCallback((panel: DockPanelId) => POPOUT_PANELS.includes(panel), [])
  // The window is gone (closed by the user, or it could never open). Put the panel back where it
  // was: a panel that stays "popped out" with no window is a panel with nowhere to render.
  const returnPopout = useCallback((panel: DockPanelId) => {
    const home = popoutOrigin.current[panel] ?? 'floating'
    delete popoutOrigin.current[panel]
    setDockLayout((l) => (home === 'floating' || home === 'popout' ? floatDockPanel(l, panel) : moveDockPanel(l, panel, home)))
  }, [])
  const maximizeDock = useCallback((panel: DockPanelId) => setDockLayout((l) => toggleMaximizePanel(l, panel)), [])
  const canMaximize = useCallback((panel: DockPanelId) => MAXIMIZABLE_PANELS.includes(panel), [])
  const restoreDock = useCallback(() => setDockLayout(clearMaximized), [])
  // the panel currently holding the screen (desktop only - mobile puts the docks in drawers,
  // where there's nothing to maximize into)
  const maxPanel = isMobile ? null : dockLayout.maximized

  // Esc restores. Deliberately its own capture-phase listener rather than the controller's
  // keydown, which bails the moment focus is in a text field - and a maximized PLC editor is
  // exactly that, so routing it there would make the key work everywhere except where it's
  // needed. It asks keyBelongsToTarget first, so Esc still means "escape" inside CodeMirror, its
  // find panel, the ladder find bar or an input, and only restores when nothing there uses it.
  useEffect(() => {
    if (!maxPanel) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // the find bars own Escape (it closes them), on their buttons too; this listener runs first, in capture
      if (keyBelongsToTarget(e)) return
      e.preventDefault()
      e.stopPropagation()
      restoreDock()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [maxPanel, restoreDock])

  // Shift+/ opens the keyboard reference. Its own listener rather than the controller's switch:
  // the dialog is App state, and the controller bails while a drag or a text field owns the keys —
  // "what are the shortcuts?" should answer from anywhere except mid-typing.
  useKeydownEverywhere((e) => {
    if (keyBelongsToTarget(e)) return
    if (resolveKeyAction(e, 'editor') !== 'ui.shortcuts') return
    e.preventDefault()
    // toggles, and always on the keyboard tab: ? is a question about the keys
    setSettingsTab((v) => (v === null ? 'shortcuts' : null))
  })

  // "Surface this panel" requests from outside the dock UI (the tutorial, opening the PLC panel as
  // it writes the interlock program into it). The layout is App state, so the store only asks.
  // Distraction-free hides the dock slots, so a reveal that lands in one leaves df first - otherwise
  // the palette's Problems / Controller commands bring a tab forward inside a dock nobody can see.
  // Df is store state, toggled outside the layout updater (which must stay pure), so the listener
  // re-subscribes per layout change to judge the current layout.
  useEffect(
    () =>
      store.onRevealPanel((panel) => {
        if (store.getState().distractionFree && revealNeedsDocks(dockLayout, panel)) store.toggleDistractionFree()
        setDockLayout((l) => revealDockPanel(l, panel))
      }),
    [store, dockLayout],
  )

  // Catalog icons load as static /thumbnails/*.webp (generated by `npm run
  // thumbnails`), so the part GLBs aren't downloaded just to draw the catalog.
  // This is the fallback path: if a static thumbnail is ever missing (e.g. a new
  // part added before regenerating), render the whole set in-browser, once.
  const runtimeRequested = useRef(false)
  const requestRuntimeThumbnails = useCallback(() => {
    if (runtimeRequested.current) return
    runtimeRequested.current = true
    getPartThumbnails()
      .then(setThumbnails)
      .catch(() => {})
  }, [])

  // Bundled custom-part cards load a committed /thumbnails/pkg/*.webp too (baked by `npm run thumbnails`),
  // so a normal session doesn't spin up the offscreen renderer for them. This is their missing-file fallback:
  // a package whose static thumb 404s (e.g. added before regenerating) is recorded here and rendered in-browser
  // by the effect below - the package-card counterpart of requestRuntimeThumbnails for built-ins.
  const [staticThumbMisses, setStaticThumbMisses] = useState<ReadonlySet<string>>(() => new Set())
  const onPackageThumbnailMissing = useCallback((id: string) => {
    setStaticThumbMisses((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  // Defer offscreen thumbnail rendering until the scene has actually painted. Under WebGPU the catalog
  // spins up a second WebGPU device and renders one pass per package - measured ~6s of contention on the
  // cold-load critical path if it runs alongside the scene's own pipeline compile. Waiting for
  // whenScenePainted (WebGL: frame 1; WebGPU: after the scene's compileAsync) puts the scene first, then
  // an idle slice lets the first interactive frames land before the thumbnail GPU work begins. The catalog
  // shows pending/placeholder cards until then.
  const [thumbsReady, setThumbsReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void whenScenePainted().then(() => {
      if (cancelled) return
      const start = (): void => { if (!cancelled) setThumbsReady(true) }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 1500 })
      else setTimeout(start, 300)
    }).catch((e: unknown) => console.warn('[oip] catalog thumbnail start failed', e))
    return () => { cancelled = true }
  }, [])

  // Idle background sweep: once the scene has painted, warm the whole catalog through the same warmPart
  // path hover uses, so every part is preloaded shortly after load.
  // Held until scene paint + an idle slice (never competes with first interaction); the sweep is itself
  // Save-Data–gated, paced, and deduped in the controller/view. Re-armed per controller mount; cancelled on
  // unmount / scene switch so a mid-drain teardown stops cleanly. See controller.warmCatalog.
  useEffect(() => {
    if (!controller) return
    let cancelled = false
    void whenScenePainted().then(() => {
      if (cancelled) return
      const run = (): void => { if (!cancelled) void controller.warmCatalog(() => cancelled) }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 8000 })
      else setTimeout(run, 3000)
    }).catch((e: unknown) => console.warn('[oip] catalog warm start failed', e))
    return () => { cancelled = true }
  }, [controller])

  // Render a catalog card thumbnail for each custom-part package that needs one, offscreen, from the same visual
  // factory the viewport uses. Re-renders a package only when its content object changes (an authored geometry/
  // material edit replaces it). Packages with an author-supplied pkg.thumbnail are skipped. Pristine bundled
  // examples are skipped too: they load a committed /thumbnails/pkg/*.webp (baked by `npm run thumbnails`), like
  // built-ins. So a normal session renders offscreen only for desktop-folder / in-app authored parts (and any
  // bundled thumb that 404s, recorded in staticThumbMisses). Phones hide the catalog.
  const renderedPkgThumbs = useRef<Map<string, PartPackage>>(new Map())
  useEffect(() => {
    if (isPhone || !thumbsReady) return
    const byId = new Map<string, PartPackage>()
    // a project's untouched copy of a built-in is the built-in: it keeps the committed image (docs/part-sources.md)
    for (const p of state.bundledPackages) byId.set(p.id, p)
    for (const p of state.userPackages) if (!sameAsBuiltIn(p, byId.get(p.id))) byId.set(p.id, p)
    const pristineBundled = new Set(state.bundledPackages) // identity: a shadowing copy wins byId and isn't pristine
    const todo = [...byId.values()].filter(
      (p) =>
        !p.thumbnail &&
        renderedPkgThumbs.current.get(p.id) !== p &&
        (!pristineBundled.has(p) || staticThumbMisses.has(p.id)),
    )
    if (todo.length === 0) return
    let cancelled = false
    const ids = todo.map((p) => p.id)
    setPendingThumbs((prev) => setWith(prev, ids, true))
    renderPackageThumbnails(todo)
      .then((map) => {
        if (cancelled || map.size === 0) return
        for (const p of todo) renderedPkgThumbs.current.set(p.id, p)
        setPackageThumbnails((prev) => {
          const next = new Map(prev)
          for (const [id, url] of map) next.set(id, url)
          return next
        })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPendingThumbs((prev) => setWith(prev, ids, false))
      })
    return () => {
      cancelled = true
      setPendingThumbs((prev) => setWith(prev, ids, false))
    }
  }, [isPhone, thumbsReady, state.bundledPackages, state.userPackages, state.packageRev, staticThumbMisses])

  useEffect(() => {
    const container = viewportRef.current
    if (!container) return
    // set once the view is built; the cleanup runs it (or marks for teardown if the
    // async WebGPU renderer is still resolving when the effect is torn down)
    let cancelled = false
    let teardown: (() => void) | null = null

    // mount the view + controller with an optional pre-built renderer (WebGPU passes one
    // in; WebGL leaves it undefined so RenderView builds its own). Synchronous so the
    // default WebGL path behaves exactly as before.
    const mount = (renderer?: WebGLRenderer | WebGPURenderer) => {
      if (cancelled) {
        renderer?.dispose()
        return
      }
      let v: IRenderView
      try {
        v = new RenderView(container, {
          renderer,
          onFrame: (dt) => {
            const s = frameStats.current
            s.dtEma = s.dtEma === 0 ? dt : s.dtEma + 0.1 * (dt - s.dtEma)
            ctrlRef.current?.tick(dt)
            benchRef.current?.frame()
          },
        })
        setViewError(null)
      } catch (err) {
        setViewError(err instanceof Error ? err.message : String(err))
        v = nullView()
      }
      const ctrl = new EditorController(store, v, sim, container)
      ctrlRef.current = ctrl
      setView(v)
      setController(ctrl)
      // first-party bundled custom-part examples → catalog (browser + desktop). A room boot has loaded them already,
      // ahead of the room's packages (main.tsx bootRoom); building all of them again costs ~60 ms for nothing.
      if (store.getState().bundledPackages.length === 0) loadBundledExamples(store)
      // A folder linked in an earlier session resumes here: silently when the browser still holds the
      // permission, otherwise as a paused banner offering Reconnect (only a click can ask for it back).
      // Fire-and-forget: the link is optional, and boot must not wait on IndexedDB.
      void restoreFolderLink(store, ctrl)
      // Desktop only: the project is stored in its folder there, kept in sync both ways (projectFolderSync.ts).
      // Picks the open document's folder back up, or waits for its first edit to give it one.
      // ...once an older project's scenes have their own folders: the first round would remove their files from
      // this one before the folders existed (projectSplit.ts)
      // ...and not on the demo's page: the demo is a project of its own, not the one whose folder this is (an edit
      // that forks it gives it a folder of its own, demoFork.ts)
      void splitFiling()
        .then(() => (store.getState().demoSession ? undefined : restoreFolderSync(store, ctrl)))
        .catch((e: unknown) => console.warn('[oip] restoring the folder link failed', e))
      // Desktop only: File > Open Recent, and a folder named on the command line or by a second launch.
      // An edit that makes the demo yours files this project and opens the demo as a project of its own (demoFork.ts)
      const stopDemoFork = installDemoForkHost(store, ctrl)
      const stopOpenRequests = connectDesktopOpenRequests(store)
      // ...and a .oip / .oippart double-clicked or opened with the app, at launch or while it runs (desktopFileOpen.ts)
      const stopFileOpens = connectDesktopFileOpens(store, ctrl)
      // Electron only: stream a desktop parts folder into the catalog (no-op in the browser). Surface
      // each build result so a part that fails to compile on save raises a toast + catalog badge instead
      // of silently keeping its last-good version.
      const pkgSource = connectDesktopPackages(store)
      // Desktop only: serve the agent tools to the shell's MCP server (agent/desktopAgent.ts, docs/agent-tools.md)
      const stopAgent = connectDesktopAgent(store, ctrl, setAgentSession)
      if (import.meta.env.DEV || new URLSearchParams(location.search).has('hook')) {
        const hook = (window.__oip ??= {})
        Object.assign(hook, {
          view: v,
          controller: ctrl,
          // Explicit settle signal for gates that count the scene. Part GLBs load async, so a
          // scene that looks finished can still be missing whole parts: the demo reads ~210
          // drawables while the chain transfers, AGV and diverters are still loading, and ~330
          // once they arrive. Timed waits and "the count stopped changing" both sample the climb
          // (e2e/probes/draw-settle-curve.mjs), so gates wait on this instead.
          assetsBusy,
          // ?bench: the live run's result blob, so a gate can read it without driving the UI
          bench: () => benchRef.current?.result() ?? null,
          linkFolder: (dir: unknown) => beginFolderLink(dir as Parameters<typeof beginFolderLink>[0], store, { controller: ctrl }),
          // the restore path, for a gate: showDirectoryPicker cannot be driven from a test browser,
          // so proving a link survives a reload needs the boot half reachable on its own
          restoreFolder: () => restoreFolderLink(store, ctrl),
          unlinkFolder: () => unlinkProjectFolder(store),
          // the working copy as a reload would open it, once its writes have landed (projectFile.savedWorkingCopyText)
          savedProject: savedWorkingCopyText,
          // Save Project to Folder without its picker (a native dialog a test browser cannot drive)
          saveFolder: (dir: unknown) => saveProjectToFolderHandle(dir as Parameters<typeof saveProjectToFolderHandle>[0], store, ctrl),
          // the desktop's two-way folder sync, for the Electron gates: run a round now, settle a conflict
          folderSync: {
            now: syncFolderNow,
            resolve: (side: 'disk' | 'mine') => resolveFolderConflict(side),
            path: syncedFolderPath,
          },
        })
      }
      // ?bench (bench.ts): start the fixed-workload run once the loading cover is gone, so the
      // load cost is reported as `load` rather than smeared into the first measurement window.
      // The run then owns the camera for its whole duration.
      const benchParams = readBenchParams(location.search)
      if (benchParams.enabled) {
        void whenCoverHidden().then(() => {
          if (cancelled) return
          // hold the screen awake for the run. Needs a secure context, so a phone pointed at a LAN
          // dev server over http reports 'unavailable' and the blob says so rather than quietly
          // measuring a screen that went to sleep.
          const wake = createScreenWakeLock()
          const run = new BenchRun(
            {
              now: () => performance.now(),
              stats: () => v.getStats(),
              setCameraPose: (pose) => v.setCameraPose(pose, { instant: true }),
              gpuErrors: () => gpuErrorReport().count,
              hidden: () => document.visibilityState === 'hidden',
              wakeLock: () => wake.state(),
              onDone: () => wake.release(),
              save: (json) => {
                try {
                  localStorage.setItem(BENCH_STORAGE_KEY, json)
                } catch {
                  /* private mode / quota - the on-screen copy still works */
                }
              },
              // the built entry's content hash, so two pastes from different builds cannot be
              // compared by accident (vite.config.ts defines it; 'dev' outside a build)
              build: __BUILD_ID__,
              startedAt: new Date().toISOString(),
              scene: store.demoSession ? 'demo' : store.getState().projectName,
              parts: () => store.getState().scene.parts.length,
              device: {
                ua: navigator.userAgent,
                css: [window.innerWidth, window.innerHeight],
                dpr: window.devicePixelRatio,
                cores: navigator.hardwareConcurrency ?? null,
                memGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
                // asked of the platform, never inferred from the UA (Apple freezes its OS token)
                gpuAvailable: typeof navigator.gpu !== 'undefined',
              },
              // resolved values, not the URL params: an ignored ?dpr shows up as the unchanged cap
              // instead of becoming an invisible duplicate arm (bench.ts design note 4)
              config: () => {
                const st = v.getStats()
                return {
                  tier: renderQuality.tier,
                  dprCap: renderQuality.pixelRatioCap,
                  dprActual: Math.min(window.devicePixelRatio, renderQuality.pixelRatioCap),
                  msaa: renderQuality.msaaSamples,
                  singlePass: renderQuality.singlePass,
                  // Both paths honour it (WebGPU through consolidatedOutlineNode.renderSinglePass).
                  // Kept in the blob because older pastes carry `false` and must stay readable.
                  // e2e/verify-webgpu-mobile-singlepass.mjs guards it.
                  singlePassHonoured: true,
                  shadowMap: shadowMapSize,
                  backend: st.backend,
                  drawPath: st.drawPath,
                  countersNote:
                    st.drawPath === 'replay'
                      ? 'drawCalls and triangles are per-replay encode tallies, not scene totals - see bench.ts'
                      : null,
                }
              },
              // the scene's opening view, not wherever the camera was left: the orbit is only
              // comparable across runs if it starts from the same place
              startPose: ctrl.openingView(),
            },
            benchParams,
          )
          run.noteCover(performance.now())
          // a lost context on a phone is usually memory pressure, and it is a result (WebGL only;
          // the WebGPU device exposes its own `lost` promise, not this event)
          const canvas = container.querySelector('canvas')
          canvas?.addEventListener('webglcontextlost', () => run.noteContextLost())
          // a restore is not a recovery: three re-initialises, but textures whose sources were
          // released come back black while the frame counters keep reporting a healthy scene
          canvas?.addEventListener('webglcontextrestored', () => run.noteContextRestored())
          benchRef.current = run
          setBenchRun(run)
        }).catch((e: unknown) => console.warn('[oip] bench run failed to start', e))
      }

      teardown = () => {
        pkgSource?.disconnect()
        stopAgent()
        stopOpenRequests()
        stopFileOpens()
        stopDemoFork()
        benchRef.current?.releaseWakeLock()
        benchRef.current = null
        ctrlRef.current = null
        ctrl.dispose()
        v.dispose()
        setController(null)
        setView(null)
      }
    }

    // experimental ?webgpu: build the WebGPURenderer async (dynamic import + device
    // init), then mount; on any failure fall back to the standard WebGL view
    if (wantsWebGPU()) {
      createWebGPURenderer()
        .then((renderer) => {
          noteActiveRenderer('webgpu')
          mount(renderer)
        })
        .catch((err) => {
          console.warn('[oip] WebGPU unavailable, falling back to WebGL', err)
          noteActiveRenderer('webgl')
          mount()
        })
    } else {
      noteActiveRenderer('webgl')
      mount()
    }

    return () => {
      cancelled = true
      teardown?.()
    }
  }, [store, sim])

  // distraction-free mode: collapse to just toolbar + viewport, drop the docks
  const df = state.distractionFree
  // mobile takes precedence over distraction-free: a full-bleed viewport with the
  // docks moved into slide-in drawers (toggled from the bottom tab bar)
  // Every dock size is also set on the app root as a custom property (`--dk-left`, …). The grid
  // tracks and the column panes read those, so a gutter drag updates one property per frame
  // instead of re-rendering the editor to rebuild this style object (ResizeGutter). React still
  // owns the committed value, which is written into the template's inline fallbacks.
  // the bottom dock stands at the height of the panel in front (dockLayout's BottomHeights), so switching tabs moves it
  const bottomFront = dockLayout.active.bottom
  const dockTrack = bottomDockHeight(bottomFront, bottomHeights)
  // the bottom dock's height drag, shared by its gutter and the corners where a left column's gutter crosses it
  const bottomResize: ResizeTrack = {
    axis: 'y',
    sign: -1,
    value: bottomDockOnScreen,
    cssVar: dockSizeVar('dock'),
    // the height is the front panel's own: dragging with the PLC in front leaves Parts where it was
    onResize: (h) => bottomFront && setBottomHeights((b) => ({ ...b, [bottomFront]: Math.round(h) })),
    min: BOTTOM_MIN,
    max: bottomDockMax,
  }
  const widthResize = (widthKey: 'left' | 'right' | 'left2' | 'right2', sign: 1 | -1): ResizeTrack => ({
    axis: 'x',
    sign,
    value: sizes[widthKey],
    cssVar: dockSizeVar(widthKey),
    onResize: (v) => setSizes((s) => ({ ...s, [widthKey]: v })),
    min: 160,
    max: 560,
  })
  const sizeVars = useMemo(
    () => ({
      ...Object.fromEntries(Object.entries(sizes).map(([key, px]) => [dockSizeVar(key), `${px}px`])),
      [dockSizeVar('dock')]: dockTrack,
    }),
    [sizes, dockTrack],
  )
  const presenting = state.presenting // only the scene (components/PresentOverlay.tsx; its grid is in toolbar.css)
  const appStyle: CSSProperties = {
    ...(isMobile
      ? {
          gridTemplateColumns: 'minmax(0, 1fr)',
          gridTemplateRows: 'auto minmax(0, 1fr)',
          gridTemplateAreas: '"toolbar" "viewport"',
        }
      : df
        ? {
            gridTemplateColumns: 'minmax(0, 1fr)',
            gridTemplateRows: '48px minmax(0, 1fr)',
            gridTemplateAreas: '"toolbar" "viewport"',
          }
        : buildDockGrid(dockLayout, { ...sizes, dock: dockTrack })),
    ...sizeVars,
  }

  // desktop docks render in the grid; on mobile they move into the drawer below.
  // A maximized panel owns the whole shell, so the docks stand down for it too.
  const showDocks = !isMobile && !df && !maxPanel && !presenting

  // render a movable panel's content for whichever dock slot currently holds it
  const renderDockPanel = (panel: DockPanelId) => {
    switch (panel) {
      case 'tree':
        return (
          <div className="left-panel">
            {/* keyed on scene loads: opening a project or the demo swaps the scene in place, and the tree's filter,
                collapsed groups and rename belong to the scene they were made in (part ids repeat across scenes) */}
            <SceneTree key={store.sceneLoads} store={store} state={state} controller={controller} />
          </div>
        )
      case 'inspector':
        return <Inspector store={store} state={state} controller={controller} packageThumbnails={packageThumbnails} />
      case 'catalog':
        return (
          <Catalog
            state={state}
            controller={controller}
            thumbnails={thumbnails}
            packageThumbnails={packageThumbnails}
            pendingThumbnails={pendingThumbs}
            onThumbnailMissing={requestRuntimeThumbnails}
            onPackageThumbnailMissing={onPackageThumbnailMissing}
          />
        )
      case 'st':
        return controller ? <PlcPanel store={store} state={state} controller={controller} docked onPopoutDocked={() => popoutDock('st')} /> : null
      case 'history':
        return <HistoryPanel store={store} state={state} />
      case 'problems':
        return <ProblemsPanel store={store} state={state} controller={controller} />
      case 'watch':
        return (
          <Suspense fallback={null}>
            <WatchPanel store={store} state={state} controller={controller} />
          </Suspense>
        )
    }
  }

  // One side dock column (a Top/Bottom stack) plus its width-resize gutter, placed
  // by grid-area. Renders nothing when both sub-slots are empty, so the column
  // collapses. Left columns grow toward the viewport (gutter on their right, sign
  // +1); right columns mirror it (gutter on their left, sign -1).
  const renderDockColumn = (spec: {
    side: DockSide
    topId: DockSlotId
    bottomId: DockSlotId
    gridArea: string
    gutterArea: string
    splitKey: 'leftTop' | 'rightTop' | 'leftTop2' | 'rightTop2'
    widthKey: 'left' | 'right' | 'left2' | 'right2'
  }) => {
    if (!showDocks) return null
    if (dockLayout[spec.topId].length === 0 && dockLayout[spec.bottomId].length === 0) return null
    const sign = spec.side === 'left' ? 1 : -1
    const column = (
      <DockColumn
        key={`${spec.gridArea}-col`}
        side={spec.side}
        topId={spec.topId}
        bottomId={spec.bottomId}
        gridArea={spec.gridArea}
        layout={dockLayout}
        topSize={sizes[spec.splitKey]}
        sizeVar={dockSizeVar(spec.splitKey)}
        onResizeSplit={(v) => setSizes((s) => ({ ...s, [spec.splitKey]: v }))}
        onActivate={activateDock}
        onTabClick={clickTab}
        onMaximize={maximizeDock}
        canMaximize={canMaximize}
        onMove={moveDock}
        onFloat={floatDock}
        canFloat={canFloat}
        onPopout={popoutDock}
        canPopout={canPopout}
        renderPanel={renderDockPanel}
      />
    )
    const gutter = (
      <ResizeGutter
        key={`${spec.gridArea}-gut`}
        className="gutter"
        style={{ gridArea: spec.gutterArea, cursor: 'col-resize' }}
        {...widthResize(spec.widthKey, sign)}
      />
    )
    if (isColumnCollapsed(dockLayout, spec.widthKey)) return column // a rail: no width to drag, and no gutter area
    return sign === 1 ? [column, gutter] : [gutter, column]
  }

  // pilot mode owns the screen - hide the mobile chrome while walking around
  const showMobileChrome = isMobile && state.mode !== 'pilot' && !presenting

  // The PLC sheet, unless the ST panel is in an OS window of its own. A phone can't reach that state,
  // but a desktop window narrowed past the mobile breakpoint with a popout already open can. Mounting the
  // sheet then would put two live CodeMirrors on one buffer (the same hazard the floating panel's maxPanel
  // gate prevents), so the sheet is not offered.
  const showMobilePlc = !!controller && !isPoppedOut(dockLayout, 'st')

  // `phone` is the CSS twin of isPhone: the tightest tier, where chrome a tablet still has
  // room for (sim speed, the Share label) has to come out of the toolbar.
  // desktop-shell/-mac carry the window chrome the Electron shell hands to the page: with the OS title
  // bar hidden, the toolbar is the title bar (drag region + room for the window buttons).
  return (
    <div
      className={`app${isMobile ? ' mobile' : ''}${isPhone ? ' phone' : ''}${DESKTOP_SHELL ? ' desktop-shell' : ''}${DESKTOP_MAC ? ' desktop-mac' : ''}${presenting ? ' presenting' : ''}`}
      style={appStyle}
    >
      {!presenting && <Toolbar store={store} state={state} controller={controller} />}
      {renderDockColumn({
        side: 'left',
        topId: 'leftTop',
        bottomId: 'leftBottom',
        gridArea: 'leftA',
        gutterArea: 'gutlA',
        splitKey: 'leftTop',
        widthKey: 'left',
      })}
      {renderDockColumn({
        side: 'left',
        topId: 'leftTop2',
        bottomId: 'leftBottom2',
        gridArea: 'leftB',
        gutterArea: 'gutlB',
        splitKey: 'leftTop2',
        widthKey: 'left2',
      })}
      {/* `visibility` - never unmount, never `display:none`. The maximized panel shares this
          grid cell and paints over it; keeping the element laid out keeps the drawing buffer
          sized to something real and keeps the live WebGL/WebGPU context (and the render
          bundles holding baked resource handles) intact across the toggle. It also stops the
          canvas taking pointer events from underneath the panel. */}
      <div
        className="viewport"
        ref={viewportRef}
        style={maxPanel ? { visibility: 'hidden' } : undefined}
        // A part file dropped here is imported and placed where it landed; a model or a robot goes to the Parts dock. Any
        // file drag is taken (names aren't readable until the drop), so the browser never opens a dropped file.
        onDragOver={(e) => {
          if (!state.readOnly && e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (state.readOnly || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          const drop = readPartDrop(e)
          const files = partFilesOf(drop.files)
          if (handToPartsDock(drop)) store.revealPanel('catalog')
          else if (controller && files.length > 0) void importPartFiles(controller, files, drop.at)
        }}
      >
        {viewError && <div className="viewport-fallback">{t(M.rendererUnavailable, { error: viewError })}</div>}
        {state.mode !== 'pilot' && !isPhone && !presenting && <ViewportToolbar store={store} state={state} controller={controller} />}
        {presenting && <PresentOverlay store={store} state={state} controller={controller} />}
        {state.showStats && !presenting && (
          <StatsOverlay frameStats={frameStats} controller={controller} view={view} running={state.running} simHz={state.simHz} timeScale={state.timeScale} />
        )}
        {benchEnabled && <BenchOverlay run={benchRun} recovered={benchRecovered} />}
        {/* the scene's own notes - visible in pilot mode too, since walking the plant and reading the
            labels is half of what they are for */}
        <AnnotationOverlay store={store} view={view} controller={controller} show={state.showNotes} />
        <ViewportSelectMenu store={store} state={state} />
        {state.mode !== 'pilot' && !presenting && <FollowBadge following={state.following} controller={controller} />}
        {!presenting && <GuardOpeningsBanner store={store} state={state} />}
        {state.viewportHint && !presenting && <ViewportHint hint={state.viewportHint} store={store} pilot={state.mode === 'pilot'} />}
        {state.mode === 'pilot' && <PilotHud prompt={state.pilotPrompt} />}
        {state.mode === 'pilot' && isTouch && view && (
          <PilotTouchControls view={view} store={store} prompt={state.pilotPrompt} />
        )}
        {/* the toolbar's pilot button is hidden on the mobile layout; give touch users this FAB
            instead. Large touch tablets keep the toolbar button (room to spare), so no FAB there. */}
        {state.mode !== 'pilot' && !presenting && isMobile && isTouch && <PilotFab store={store} />}
        <ModelLoadingIndicator />
        {/* an agent's call in flight, and the review of its edits (docs/agent-tools.md, "Working beside a person"):
            in the viewport's corner, never over a dock it would cover */}
        {agentSession && agentCalled && !presenting && (
          <Suspense fallback={null}>
            <AgentActivity session={agentSession} store={store} state={state} controller={controller} />
          </Suspense>
        )}
        {!viewError && <ViewportLoadingCover />}
        {view && getCollabContext() && !presenting && <PresenceOverlay view={view} />}
      </div>
      {/* The maximized panel: same grid cell as the viewport, painted over it (see the CSS).
          Rendered here - after the viewport, before the right columns - so DOM order alone
          would already put it on top; the z-index in the stylesheet is what actually beats
          the positioned .viewport. */}
      {maxPanel && (
        <div className="dock-maximized">
          <div className="dock-maximized-bar">
            <span className="dock-maximized-title">{dockPanelTitle(maxPanel)}</span>
            <button
              type="button"
              className="dock-slot-max-btn"
              title={t(M.restoreTitle, { panel: dockPanelTitle(maxPanel) })}
              aria-label={t(M.restorePanel)}
              onClick={restoreDock}
            >
              <RestoreIcon />
            </button>
          </div>
          <div className="dock-slot-content">{renderDockPanel(maxPanel)}</div>
        </div>
      )}
      {renderDockColumn({
        side: 'right',
        topId: 'rightTop2',
        bottomId: 'rightBottom2',
        gridArea: 'rightB',
        gutterArea: 'gutrB',
        splitKey: 'rightTop2',
        widthKey: 'right2',
      })}
      {renderDockColumn({
        side: 'right',
        topId: 'rightTop',
        bottomId: 'rightBottom',
        gridArea: 'rightA',
        gutterArea: 'gutrA',
        splitKey: 'rightTop',
        widthKey: 'right',
      })}
      {showDocks && dockLayout.bottom.length > 0 && (
        <>
          {/* collapsed = no height to drag, and buildDockGrid drops the `gutd` row it lives in */}
          {!dockLayout.bottomCollapsed && <ResizeGutter className="gutter gutter-dock" {...bottomResize} />}
          {/* where a column's width gutter meets the height gutter: one drag sets both */}
          {dockGridCorners(dockLayout).map((c) => (
            <ResizeCorner
              key={c.widthKey}
              className={`gutter gutter-corner gutter-corner-${c.side}`}
              style={{ gridRow: c.row, gridColumn: c.column }}
              tracks={[widthResize(c.widthKey, c.side === 'left' ? 1 : -1), bottomResize]}
            />
          ))}
          <DockSlot
            slot="bottom"
            panels={dockLayout.bottom}
            active={dockLayout.active.bottom}
            collapsed={dockLayout.bottomCollapsed}
            onActivate={activateDock}
            onTabClick={clickTab}
            onMaximize={maximizeDock}
            canMaximize={canMaximize}
            onMove={moveDock}
            onFloat={floatDock}
            canFloat={canFloat}
            onPopout={popoutDock}
            canPopout={canPopout}
            renderPanel={renderDockPanel}
          />
        </>
      )}
      {showMobileChrome && (
        <>
          {/* side drawers are modal (tap-away to close); the Parts sheet stays open
              so you can place several parts in a row, dismissed via its tab */}
          {(mobilePanel === 'tree' || mobilePanel === 'inspector') && (
            <div className="mobile-backdrop" onPointerDown={() => setMobilePanel(null)} />
          )}
          {mobilePanel === 'tree' && (
            <div className="mobile-drawer left">
              <div className="left-panel">
                <SceneTree key={store.sceneLoads} store={store} state={state} controller={controller} />
              </div>
            </div>
          )}
          {mobilePanel === 'inspector' && (
            <div className="mobile-drawer right">
              <Inspector store={store} state={state} controller={controller} packageThumbnails={packageThumbnails} />
            </div>
          )}
          {!isPhone && mobilePanel === 'catalog' && (
            <div className="mobile-drawer bottom">
              <Catalog
                state={state}
                controller={controller}
                thumbnails={thumbnails}
                packageThumbnails={packageThumbnails}
                pendingThumbnails={pendingThumbs}
                onThumbnailMissing={requestRuntimeThumbnails}
                onPackageThumbnailMissing={onPackageThumbnailMissing}
              />
            </div>
          )}
          {/* The PLC program, read-only. The controller attaches it on Play in EVERY layout
              (controller.run), so a touch device already runs the logic - this is the surface that
              lets you see it, which matters most on the phone a shared link lands on. Like the
              parts sheet it is non-modal: the point is to watch the code and the scene at once.
              Editing stays desktop-only (StEditor's `viewOnly`), which is the same line the phone
              already draws for part authoring. */}
          {mobilePanel === 'st' && controller && showMobilePlc && (
            <div className="mobile-drawer st">
              {/* the tasks it runs on are in the panel's organizer, drawn over the code on a phone */}
              <PlcPanel store={store} state={state} controller={controller} docked viewOnly />
            </div>
          )}
          <MobileTabBar
            panel={mobilePanel}
            onToggle={(p) => setMobilePanel((cur) => (cur === p ? null : p))}
            showCatalog={!isPhone}
            showPlc={showMobilePlc}
          />
        </>
      )}
      {/* floating overlay (not a grid dock): kept in distraction-free mode, only the docks drop.
          Hidden when the PLC editor has been docked into the layout (it renders in its slot then),
          and whenever ANY panel is maximized: if that panel is this one the full-bleed host
          renders it instead (two live mounts would fight over the same CodeMirror buffer), and if
          it's another one, a fixed-position window at z-index 30 would float over the panel that
          is supposed to own the screen. Restoring brings this window back where it was. */}
      {!isMobile && controller && isFloating(dockLayout, 'st') && !maxPanel && (
        <PlcPanel
          store={store}
          state={state}
          controller={controller}
          onDock={() => moveDock('st', 'bottom')}
          onMaximize={() => maximizeDock('st')}
          onPopout={() => popoutDock('st')}
          boundsRef={viewportRef}
        />
      )}
      {/* The PLC editor in a window of its own - the one arrangement that can sit on a second
          monitor. It renders in `docked` form (the OS window supplies the title bar).
          Deliberately not gated on maxPanel or isMobile: this panel is not in this window any
          more, so this window's dimensions and this window's maximized panel say nothing about
          it. isMobile in particular is a media query on this document,
          and the whole point of popping out is to put the editor beside something - snap the two
          windows side by side on a 1366 laptop (or stack them, which lands under the 560px
          short-landscape clause) and this document turns "mobile", which would have torn down a
          window sitting perfectly happily on its own. A phone cannot reach this state: the
          pop-out affordances are desktop-only and a popout is never restored from storage.
          Closing the window returns the panel to wherever it came from. */}
      {controller && isPoppedOut(dockLayout, 'st') && (
        <PopoutWindow
          title={dockPanelTitle('st')}
          geometryKey="oip-web/popout-geometry/st"
          onClose={() => returnPopout('st')}
          onUnavailable={(reason) => {
            // alert, matching how this file reports a failed scene load: the user just clicked
            // "Pop out" and is owed an answer, and the usual reason (a popup blocker) is one
            // only they can fix
            alert(t(M.popoutFailed, { reason }))
            returnPopout('st')
          }}
        >
          <PlcPanel
            store={store}
            state={state}
            controller={controller}
            docked
            onReturnToDock={() => returnPopout('st')}
          />
        </PopoutWindow>
      )}
      {settingsTab && (
        <Suspense fallback={null}>
          <SettingsOverlay
            store={store}
            state={state}
            initialTab={settingsTab}
            onClose={() => setSettingsTab(null)}
          />
        </Suspense>
      )}
      {getPartsOpen && (
        <Suspense fallback={null}>
          <GetPartsWindow
            store={store}
            state={state}
            onClose={() => setGetPartsOpen(false)}
            onPublish={(id) => {
              setGetPartsOpen(false)
              setPublishPartId(id)
            }}
          />
        </Suspense>
      )}
      {publishPartId !== null &&
        (() => {
          const pkg = state.userPackages.find((p) => p.id === publishPartId)
          if (!pkg) return null
          const thumbnail = pkg.thumbnail ?? packageThumbnails.get(pkg.id)
          return (
            <Suspense fallback={null}>
              <PublishPartDialog store={store} pkg={pkg} {...(thumbnail ? { thumbnail } : {})} onClose={() => setPublishPartId(null)} onRenamed={setPublishPartId} />
            </Suspense>
          )
        })()}
      {/* the projects list: every project this browser holds. Not a start screen - /app/ still opens onto the
          working copy, and this is what a returning user reaches for when there is a second one */}
      {projectsOpen && <ProjectsOverlay store={store} state={state} onClose={() => setProjectsOpen(false)} />}
      {/* the project's own pass/fail criteria, run in-tab (Simulation → Run Project Tests) */}
      {testProject && (
        <Suspense fallback={null}>
          <TestResultsOverlay project={testProject} onClose={() => setTestProject(null)} />
        </Suspense>
      )}
      {/* every command, searchable - and the only path to the ones with no button (Ctrl+Shift+P) */}
      {paletteOpen && <CommandPalette store={store} state={state} controller={controller} onClose={() => setPaletteOpen(false)} />}
      {/* where the program and the PLCs run (Simulation > PLC Controllers…), and which one parts' tags go to (Assign to Controller…) */}
      <Suspense fallback={null}>
        {controllerPropsOpen && controller && <ControllerDialog store={store} state={state} controller={controller} onClose={() => setControllerPropsOpen(false)} />}
        {assignControllerOpen && <AssignControllerDialog store={store} state={state} onClose={() => setAssignControllerOpen(false)} />}
      </Suspense>
      {/* active onboarding tour - desktop only (it drives the catalog + PLC panel, absent on mobile) */}
      {!isMobile && controller && <TutorialOverlay store={store} state={state} controller={controller} view={view} />}
      {/* in-browser behavior-script editor (Monaco) - one shared mount, opened from anywhere via the store */}
      {state.behaviorEditTarget && (
        <Suspense fallback={null}>
          <BehaviorEditor packageId={state.behaviorEditTarget} controller={controller} onClose={() => store.closeBehaviorEditor()} />
        </Suspense>
      )}
      {/* custom-part build-failure toasts (desktop authoring); inert in the browser */}
      <PartBuildToast notices={state.partBuildNotices} onDismiss={(k) => store.dismissPartBuildNotice(k)} />
      <NoticeToast notice={state.undoNotice} onDismiss={() => store.dismissUndoNotice()} testId="undo-notice" />
      {/* said once, AFTER the edit that forked the demo into a project of the user's own (store.forkNotice) */}
      <NoticeToast
        notice={state.demoForkNotice}
        onDismiss={() => store.dismissDemoForkNotice()}
        testId="demo-fork-notice"
        tone="info"
      />
      {/* what an explicit Save did and where the work is (saveProject.ts), or a project getting its folder */}
      <NoticeToast
        notice={state.saveNotice}
        onDismiss={() => store.dismissSaveNotice()}
        onAction={(command) => runCommand(command)}
        testId="save-notice"
        tone="info"
      />
      {/* the browser translating the editor into its language (autoTranslate.ts) */}
      <TranslateToast />
      {/* answers askName() (nameDialog.ts): the app's own prompt, since window.prompt throws in Electron */}
      <NameDialogHost />
      <PartChangeDialogHost />
      {exportChoices && <ExportProjectDialog store={store} project={exportChoices} onClose={() => setExportChoices(null)} />}
      {/* in a room: asks before other people's part code runs here (the gate already holds it back) */}
      <RoomCodePrompt parts={state.scene.parts} />
      {/* sticky "autosave is failing" warning (usually localStorage quota, e.g. a large imported model) - or,
          while a stored project could not be opened, the banner that explains THAT refusal and its way out */}
      {state.unopenedProject ? (
        <UnopenedProjectBanner
          unopened={state.unopenedProject}
          onDownload={downloadUnopenedProject}
          onDiscard={() => {
            const which = state.unopenedProject?.name ? t(M.namedProject, { name: state.unopenedProject.name }) : t(M.savedProject)
            const ok = confirm(t(M.discardConfirm, { which }))
            if (ok) discardUnopenedProject(store)
          }}
        />
      ) : state.roomNewerBuild ? (
        <NewerBuildBanner
          shown
          desktop={DESKTOP_SHELL}
          onReload={() => location.reload()}
          onUpdate={getDesktopUpdate}
        />
      ) : state.supersededByOtherTab ? (
        <OtherTabBanner shown onReload={() => location.reload()} onExport={() => void downloadProject(store)} />
      ) : (
        <AutosaveBanner error={state.autosaveError} onExport={() => void downloadProject(store)} />
      )}
      {/* sticky "the linked folder no longer loads" warning - the folder is the source of truth while
          linked, so a failed sweep means the screen and the disk have diverged */}
      <FolderLinkBanner
        folder={state.linkedFolder}
        error={state.folderError}
        note={state.folderNote}
        paused={state.pausedFolder}
        conflict={state.folderConflict}
        onReconnect={() => void reconnectProjectFolder(store, controller)}
        onResolve={(side) => void resolveFolderConflict(side)}
        onUnlink={() => unlinkProjectFolder(store)}
      />
      {/* "new version available - Reload" toast; also owns SW registration + update polling. Not in the
          desktop app: it carries its build and is updated as an app, and a service worker there would be
          a second cache able to serve the build an update just replaced */}
      {DESKTOP_SHELL ? <DesktopUpdateToast /> : <UpdatePrompt />}
      {/* every surface's "Import PLC Program…" lands here: file.importPlc → CommandUi.openPlcImportPicker → this
          input. data-testid for the same reason as above: a gate selecting on `input[type=file]` picks whichever
          hidden input comes first in the DOM. */}
      <input
        ref={plcImportRef}
        data-testid="st-import-file"
        type="file"
        accept=".st,.txt,.xml,text/plain,text/xml,application/xml"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // so choosing the same file twice fires again
          // lazy, like the exports (commands.ts): the readers load when a file does
          if (file) void import('./program/stFileTransfer').then((m) => m.importStFile(store, file)).catch(alertFailure)
        }}
      />
      {/* every surface's "Import Project…" lands here: file.importProject → CommandUi.openProjectFilePicker → this
          input. A project (.oip, or the older one-file .json) or a SCENE file (.json): both open as a project of
          their own, so there is one door (there was a separate Open Scene File). data-testid because the catalog's
          part import is another hidden json input, with a different confirm. */}
      <input
        ref={projectImportRef}
        data-testid="project-import"
        type="file"
        accept=".oip,.json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // so choosing the same file twice fires again
          if (!file) return
          void file.arrayBuffer().then((buf) => importProjectFile(store, controller, new Uint8Array(buf), file.name)).catch(alertFailure)
        }}
      />
    </div>
  )
}
