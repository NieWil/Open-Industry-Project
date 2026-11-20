import {
  AgXToneMapping,
  Box3,
  Color,
  Group,
  MOUSE,
  PCFShadowMap,
  Plane,
  Raycaster,
  SRGBColorSpace,
  Scene,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { Object3D } from 'three'
// type-only: erased at build, so the heavy three/webgpu bundle is never pulled into
// the default chunk. The WebGPURenderer instance arrives via options.renderer (App
// dynamic-imports + initialises it on the WebGPU path, createRenderer.ts).
import type { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { BoxFrame } from '../../core/frame'
import { buildAuthoredCargoFrame, cargoFramesEqual, isCargoPart, memoizeAuthoredCargoFrame } from '../../core/frame'
import { castBeamFrame, castsCrossRows, changedCargoRows } from '../../core/beamCast'
import { activeNav, middleDragAction } from '../../core/navigation'
import { isConveyorLike } from '../../core/parts/partGeometry'
import type { DisplayUnits } from '../../core/units'
import { sensorBeamDebug, sensorBeamGroup, syncSensorBeams } from '../sensorBeamOverlay'
import type { ResolvedContext } from '../../core/scene/sceneResolve'
import type { BuildingPart, PartInstance, SceneJSON } from '../../core/types'
import { disposeCollisionProxy, refreshCollisionProxy } from './collisionProxyMesh'
import { DEFAULT_CAMERA_POSE } from '../api'
import type {
  BoxPick,
  GizmoConstraint,
  GizmoHandle,
  GizmoSnap,
  GizmoState,
  GuardWallPoint,
  IRenderView,
  PilotHandlers,
  ProjectionMode,
  RenderStats,
  ResizeHandle,
  RobotHandle,
  ScreenProjector,
} from '../api'
import { EditorCamera } from './editorCamera'
import { WHEEL_ZOOM, wheelZoomLog } from './wheelZoom'
import { SimBoxes } from './boxes'
import { InstancePoolManager, wantsInstancePool } from './instancePool'
import { createEnvironment, OVERLAY_LAYER } from '../env'
import { setWebGPURenderMode } from '../renderMode'
import {
  bundleGroupsRegistered,
  bundleRecordSerial,
  bundleReplaySuppressed,
  createBundleCapableGroup,
  markBundleDirtyPart,
  notifyBundleStructureChanged,
  releaseBundleGroup,
} from '../bundleGroups'
import { setLoadStage, signalScenePainted } from '../renderReady'
import type { Environment } from '../env'
import { Freelook } from './freelook'
import { Pilot } from './pilot'
import type { PilotColliders } from './pilot'
import { auditGpuTextures } from './gpuTextureAudit'
import { auditStaticFold } from '../staticFold'
import type { GpuTextureAuditResult } from './gpuTextureAudit'
import { TransformGizmo } from './gizmo'
import { ResizeHandles } from './handles'
import { RigGizmoOverlay } from './rigGizmoOverlay'
import { OrbitGizmo } from './orbitGizmo'
import * as robotGizmoDrag from './robotGizmoDrag'
import type { RobotDrag } from './robotGizmoDrag'
import * as vertexSnapPick from './vertexSnapPick'
import { createWebGPUOutline } from './outline'
import { ConsolidatedSelectionOutline } from './consolidatedOutline'
import type { ISelectionOutline } from './outline'
import { OutlineMaskMergeManager, wantsOutlineMaskMerge } from './outlineMaskMerge'
import type { OutlineMaskMergeSurface } from './outlineMaskMerge'
import { ViewXR } from './xr'
import { renderQuality, createAdaptiveQuality } from '../quality'
import { HitchCounter } from './frameHitch'
import { FrameMeter } from './frameMeter'
import type { AdaptiveQuality } from '../quality'
import type { PartVisual } from '../parts/registry'
import { advanceAnimClock, animClockValue } from '../parts/animClock'
import { FlowArrowBank } from './flowArrowBank'
import type {
  Entry,
  IRenderViewTestSurface,
  MergeCoherenceCheck,
  MergeCoherenceReport,
  PartViewTick,
  RenderViewOptions,
  VRState,
} from './viewTypes'
import * as viewWarm from './viewWarm'
import { ViewWarmState } from './viewWarm'
import * as viewSync from './viewSync'
import { SceneConsumers, drawsSensorBeam } from './viewSceneConsumers'
import * as viewPool from './viewPool'
import { POOL_MOVED_QUIET_MS, ViewPoolState } from './viewPool'
import * as viewMatrices from './viewMatrices'
import { ViewMatrixState } from './viewMatrices'
import * as viewBundles from './viewBundles'
import { ViewBundleState } from './viewBundles'
import * as viewFrameRouting from './viewFrameRouting'
import { FrameRoutingState } from './viewFrameRouting'
import * as viewOutline from './viewOutline'
import { findLinkGroup, ViewOutlineState } from './viewOutline'
import * as viewRegistries from './viewRegistries'
import { ViewRegistries } from './viewRegistries'
import * as viewPicking from './viewPicking'
import { ViewPickScratch } from './viewPicking'
import * as viewPilot from './viewPilot'
import { PILOT_HOLD_DISTANCE, ViewWalkState } from './viewPilot'
import * as viewCamera from './viewCamera'
import { CameraNavState } from './viewCamera'
import * as viewOverlays from './viewOverlays'
import { ViewOverlayState } from './viewOverlays'
import type { SubPose } from '../../core/rig/rigPose'
export type { Entry, IRenderViewTestSurface, MergeCoherenceCheck, MergeCoherenceReport, RenderViewOptions, VRState } from './viewTypes'

/** how close (CSS px) the pointer must come to a guard wall for guard-openings mode to treat it as ON the guard */
const GUARD_WALL_PICK_PX = 14

/** Orbit zoom-out ceiling (camera → target). Sized for a whole site, not a cell: a distribution centre runs
 *  150-300 m, and framing 300 m across at the 50 deg FOV needs ~320 m of distance. */
const ORBIT_MAX_DISTANCE = 500
/** Far clip plane: the far corner of a 300 m site seen from ORBIT_MAX_DISTANCE, with margin. Raising it costs
 *  no depth precision that matters: with near at 0.1 the depth resolution is set by near once far >> near. */
const CAMERA_FAR = 2000

// Most of the view's logic lives in the view*.ts modules beside this file. Each area owns its state in an
// object held here (`warm`, `pool`, `bundles`, `nav`, `overlays`, `walk`, `registries`, `matrices`,
// `routing`, `outlineState`, `pickScratch`) and declares what else it reaches on the view as a narrow
// `Pick<RenderView, ...>` host type in its own module. A non-private member that IRenderView does not
// list is internal to those modules (or an e2e test hook, marked as one).
export class RenderView implements IRenderView, IRenderViewTestSurface {
  readonly container: HTMLElement
  /** internal - for viewport modules */
  readonly renderer: WebGLRenderer | WebGPURenderer
  /** internal - for viewport modules */
  readonly scene = new Scene()
  /** internal - for viewport modules */
  readonly camera: EditorCamera
  readonly controls: OrbitControls
  readonly env: Environment
  // bundle-capable (bundleGroups.ts): the parts container is the main-pass
  // render-bundle root; structural mutations below call notifyBundleStructureChanged()
  readonly partsGroup = createBundleCapableGroup()
  // `?bundlelive` (wantsBundleLiveSplit): runtime-movable parts (isRuntimeMovablePart:
  // jointed/aimed rigs, subPose'd mesh links, cargo/sweeps) go in this plain sibling instead,
  // encoding fresh every frame while the static bulk replays. Under stock bundle replay their
  // baked object matrices freeze (a bundled robot's arm keeps its record-time pose mid-run).
  // bundleReplayRefresh's per-object walk is the default fix, and this split is the fallback if a
  // three bump breaks that patch. Empty (all parts in partsGroup) unless the flag is on.
  readonly livePartsGroup = new Group()

  /** internal - the shared sim-animation clock, for gates that ask whether animation is advancing */
  get animClock(): number {
    return animClockValue()
  }
  // Flow-direction arrows for every conveyor, rendered through two instanced draws (shafts + head
  // cones) instead of ~9 meshes per conveyor. Its group is a direct scene child on OVERLAY_LAYER,
  // drawn in the overlay sub-pass (collectOverlays). flowArrowBank.ts explains why it is not in the
  // main pass (WebGPU bundles execute last, over any base-pass overlay).
  readonly flowArrowBank = new FlowArrowBank()
  // off-scene container owning the per-entry collision-raycast proxies (never rendered)
  readonly proxyGroup = new Group()
  /** internal - walk mode's own state (viewPilot.ts): built here, so the presence group + avatar capsule
   *  are created between the proxy group and the sim boxes */
  readonly walk = new ViewWalkState()
  readonly boxes = new SimBoxes()
  // selection outline: the EffectComposer ConsolidatedSelectionOutline on WebGL, or the
  // node-based twin (consolidatedOutlineNode.ts) under WebGPU. null only if the WebGPU factory
  // failed to register, in which case renderFrame() draws the scene directly (no outline).
  readonly outline: ISelectionOutline | null
  // constructed in the constructor body, after setWebGPURenderMode(). The gizmo picks its
  // ring material (WebGL halfRing onBeforeCompile vs the TSL node material) at build time
  // from isWebGPURenderMode(), so it must not be a field initializer. Those run first, while
  // the flag still has its WebGL default, and WebGPU rings would draw as full circles.
  readonly gizmo: TransformGizmo
  readonly handles = new ResizeHandles()
  /** internal - the robot pose gizmo's drawing, for viewport modules (robotGizmoDrag.ts) */
  readonly rigGizmoOverlay = new RigGizmoOverlay()
  /** internal - for viewport modules */
  readonly entries = new Map<string, Entry>()
  readonly seen = new Set<string>()
  /** internal - while on, a part leaving the scene is held instead of disposed (a definition session has the scene,
   *  and its parts come back on Back); the scene diff (viewSync.ts) holds and restores them */
  holdDeparted = false
  /** internal - the held parts, by id, with the package each drew from when it left (viewSync.ts) */
  readonly held = new Map<string, { entry: Entry; pkg: unknown }>()
  // scene-global InstancedMesh pooling (default-on; `?noinstancepool` turns it off): merges structurally-identical
  // static hardware of the non-selected parts into shared world-space pools. null when off.
  readonly instancePool: InstancePoolManager | null = null
  // ids hidden directly or by a hidden ancestor (visible-in-tree); recomputed
  // each syncScene and consulted by mesh visibility + every part pick/surface query
  /** internal - for viewport modules */
  hidden = new Set<string>()
  /** internal - for viewport modules */
  readonly raycaster = new Raycaster()
  private readonly beamHit: { distance: number; color: Color } = { distance: 0, color: new Color() }
  // Sensor-beam probe state (see probeBeam): the worker's beam results from the latest frame (running
  // source of truth), the idle authored-cargo frame the stopped path casts against, the change gate
  // (a stopped scene only changes through syncs, so probes re-run on the sync/package/run seams instead
  // of every frame), and the part whose probeTick is currently being called (routes beamHits lookups).
  lastBeamHits: BoxFrame['beamHits']
  private idleCargoFrame: BoxFrame | null = null
  // reuses that frame across syncs that touch no cargo (a streamed drag of anything else)
  private readonly idleCargoMemo = memoizeAuthoredCargoFrame()
  /** what reacts to a scene edit, and which parts each reads (viewSceneConsumers.ts) */
  readonly sceneConsumers = this.createSceneConsumers()
  beamProbeDirty = true
  // The idle cargo frame changed and nothing else did. The next stopped pass then re-probes only the sensors whose
  // last casts (beamCasts) enter a changed row, in the frame they were probed against (probedCargoFrame) or the new
  // one: a full pass costs sensors x every cargo row (~3.4 ms per pointer-move dragging a box in the demo, 25 casts
  // x 1053 rows), where a beam's answer can only change through a row that moved.
  private beamCargoDirty = false
  // the sensor parts a sync edited (a pose or param change, not an add or remove): the same partial pass re-probes
  // just them, where a full pass re-casts every sensor (~3.5 ms per pointer-move dragging a diffuse sensor in the
  // demo, ~6.5 ms for a light curtain)
  private readonly beamSensorsDirty = new Set<string>()
  private probedCargoFrame: BoxFrame | null = null
  // per sensor part, the beams its last stopped probe cast (BEAM_CAST_STRIDE values each); empty while running
  private readonly beamCasts = new Map<string, number[]>()
  // the list the sensor being probed records its casts into (probeBeam), null outside a recording probe
  private probeCasts: number[] | null = null
  // sensor part roots currently hidden, so their reveal can re-arm the beam probe (see tick)
  private readonly beamHiddenParts = new WeakSet<object>()
  private lastProbeSimActive = false
  // the registries' probeRegistryRev at the last probe pass that actually ran. The gate re-fires
  // whenever the registry changed since, wherever in the frame the rebuild happened (see ViewRegistries)
  private probedRegistryRev = -1
  private probePartId = ''
  private readonly beamOriginArr: [number, number, number] = [0, 0, 0]
  private readonly beamDirArr: [number, number, number] = [0, 0, 0]
  private readonly pointer = new Vector2()
  readonly groundPlane = new Plane(new Vector3(0, 1, 0), 0)
  readonly hitPoint = new Vector3()
  /** internal - the part picks' scratch (viewPicking.ts) */
  readonly pickScratch = new ViewPickScratch()
  /** internal - for viewport modules */
  readonly projTmp = new Vector3()
  /** internal - for viewport modules */
  readonly camTmp = new Vector3()
  /** internal - for viewport modules: vertex-snap scratch + markers (vertexSnapPick.ts) */
  readonly vsnap = vertexSnapPick.createVertexSnapState()
  private readonly resizeObserver: ResizeObserver
  // the ResizeObserver only marks this; the next tick applies it (see resize / applyResize)
  private pendingResize = false
  // last size the drawing buffer + offscreen targets were actually built at, so a resize
  // notification that rounds to the same pixels costs nothing
  private sizedW = -1
  private sizedH = -1
  private sizedPixelRatio = -1
  private readonly onFrame: ((dt: number) => void) | undefined
  // closed-loop dynamic resolution, built always, but a no-op unless ?drs is set
  private readonly adaptive: AdaptiveQuality | null = null
  readonly freelook: Freelook
  readonly pilot: Pilot
  /** render-frame serial, bumped once per tick - the pilot crosshair cache key */
  tickSerial = 0
  readonly orbitGizmo: OrbitGizmo
  /** internal - editor camera navigation's own state (viewCamera.ts) */
  readonly nav = new CameraNavState()
  /** see IRenderView.onProjectionChanged */
  onProjectionChanged: ((mode: ProjectionMode) => void) | null = null

  /** see IRenderView.onCameraSettled */
  onCameraSettled:
    | ((pose: { px: number; py: number; pz: number; tx: number; ty: number; tz: number }, projection: ProjectionMode) => void)
    | null = null

  selection = new Set<string>()
  // Bumped whenever a syncScene adds/removes a part or changes any part's parent - i.e. whenever
  // the soft-parent structure that subtreeIds walks could differ. A transform-only sync (the drag
  // path) leaves it untouched, so refreshOutline's membership signature stays stable and its
  // O(K×N) subtree rebuild is skipped. Structural edits bump it and force the outline to re-derive.
  structureRev = 0
  /** internal - the per-frame tick-callback registries (viewRegistries.ts) */
  readonly registries = new ViewRegistries()
  /** internal - the outline membership's signature + rig highlight (viewOutline.ts) */
  readonly outlineState = new ViewOutlineState()
  // the robot whose editor gizmo (joint rings + IK handle) is shown, and the live drag
  /** internal - for viewport modules (robotGizmoDrag.ts) */
  robotGizmoId: string | null = null
  /** internal - for viewport modules (robotGizmoDrag.ts) */
  robotDrag: RobotDrag | null = null
  /** internal - the transform readout is showing the robot gizmo's joint readout (robotGizmoDrag.ts) */
  robotReadout = false
  // Placement staging (docs/placement-staging.md): the id of the scene part that is the live
  // placement preview. The editor stages the real part into a transient scene and tags it here.
  // The entry renders like any other part (real shadows, wall occlusion). The tag only excludes
  // it from picking / rest-surface raycasts / the instance pool / the idle cargo batch, and
  // forces its flow arrow on.
  stagingId: string | null = null
  /** internal - instance-pool membership bookkeeping (viewPool.ts) */
  readonly pool = new ViewPoolState()
  syncSerial = 0
  // palette-merged mask (null under ?nomaskmerge): the outline twins render its one merged
  // mesh instead of each selected part's meshes; fed by refreshOutline
  readonly maskMerge: OutlineMaskMergeManager | null = null
  // Non-content viewport backdrop: the default warehouse, shown only when the scene has no building
  // of its own, so a building-less scene (e.g. a single part) isn't a disorienting grey void. It
  // is in its own group outside partsGroup, so it renders + casts wall shadows + drives lighting
  // like a real building, but is never raycast, selected, box-selected, frozen, or serialized. It is
  // not a scene part. Cleared as soon as the scene gains a building (no double building).
  readonly backdropGroup = new Group()
  backdrop: { visual: PartVisual; part: BuildingPart } | null = null
  lastScene: SceneJSON | null = null
  // last-computed per-part neighbour-derived contexts (resolveScene), kept so a package hot-reload
  // (refreshPackage) re-applies each part with its resolved inputs (e.g. rebuilding a snapped platform/stair
  // from its cut geo) instead of momentarily dropping the cut/grid/openings until the next scene sync
  lastResolved: Map<string, ResolvedContext> | undefined
  running = false
  // global flow-direction arrow toggle
  flowArrowsVisible = false
  // floor reference grid toggle; mirrors env's grid.visible so the toggle can dedupe (see setGridVisible)
  gridVisible = false
  // true once the worker has delivered a box frame for the current run; gates the authored→sim
  // cargo handoff so the authored mesh stays visible until a live body is actually there to replace it
  simHasFrame = false
  // latest worker frame's sim clock (frame.simTime); the per-tick delta drives the belt/roller/chain
  // scroll so they slave to sim time (freeze on pause, track timeScale) instead of wall-clock - see tick()
  lastFrameSimTime = 0
  private animSimBaseline: number | null = null
  private rafId = 0
  private lastTime: number | null = null
  // frame-cost stats (getStats → overlay): EMA of the main-thread ms spent inside tick(),
  // plus a hitch counter keyed off a decaying-min estimate of the display refresh interval
  // (snaps down to the fastest frame seen, drifts up ~0.5%/frame so a monitor change - or
  // sustained slowness - re-baselines instead of counting every frame forever)
  private cpuMsEma = 0
  // the same main-thread ms, summed, and the frames it covers: the overlay window-diffs these against real time
  // (RenderStats.cpuTotalMs says why the EMA alone can't give a frame rate or a load)
  private cpuMsTotal = 0
  private framesTotal = 0
  // GPU ms per frame (WebGPU timestamps; empty on WebGL) and the display's refresh interval
  private readonly frameMeter = new FrameMeter()
  // hitch detection (frameHitch.ts): a rolling median baseline. A running-minimum estimate
  // would count a 120 Hz panel's fast frames as evidence that the app's own healthy 60 fps
  // cadence was janking
  private readonly hitchCounter = new HitchCounter()
  disposed = false
  // immersive VR walkthrough (WebXR); null under the WebGPU renderer, which has no
  // WebXR binding. See xr.ts for the loop/camera handover rules
  readonly xr: ViewXR | null
  private painted = false // first-frame guard for the loading cover (renderReady.ts)
  /** how the last frame produced its draw tally - see the latch in tick() and RenderStats.drawPath */
  private drawPath: 'replay' | 'record' | null = null
  /** internal - the pipeline-warm machinery's own state (viewWarm.ts) */
  readonly warm = new ViewWarmState()
  private freelookDist = 8
  /** internal - the overlays' own state (viewOverlays.ts): built here, so the ruler group + geometry are
   *  created by the last field initialisers; the rest in its build(), below */
  readonly overlays = new ViewOverlayState()

  // --- e2e test hooks ---
  // Read-only forwards to state held in an area's own object, kept under the names the e2e
  // fleet and its probes read through window.__oip.view. Nothing in the app reads these (the viewport
  // modules go to the owner directly), so none of them sits on a per-frame path.
  /** @internal test hook - forwards to {@link ViewWarmState.warming} */
  get warming(): ReadonlySet<string> {
    return this.warm.warming
  }
  /** @internal test hook - forwards to {@link ViewWarmState.warmQueue} */
  get warmQueue(): ReadonlySet<string> {
    return this.warm.warmQueue
  }
  /** @internal test hook - forwards to {@link ViewWarmState.stagedReveal} */
  get stagedReveal(): boolean {
    return this.warm.stagedReveal
  }
  /** @internal test hook - forwards to {@link ViewWarmState.incrementalWarmReady} */
  get incrementalWarmReady(): boolean {
    return this.warm.incrementalWarmReady
  }
  /** @internal test hook - forwards to {@link ViewWarmState.extrasWarmDone} */
  get extrasWarmDone(): boolean {
    return this.warm.extrasWarmDone
  }
  /** @internal test hook - forwards to {@link CameraNavState.focusAnim} */
  get focusAnim(): CameraNavState['focusAnim'] {
    return this.nav.focusAnim
  }
  /** @internal test hook - forwards to {@link CameraNavState.zoomPending} */
  get zoomPending(): number {
    return this.nav.zoomPending
  }
  /** @internal test hook - forwards to {@link ViewBundleState.lastStructBumpAt} */
  get lastStructBumpAt(): number {
    return this.bundles.lastStructBumpAt
  }
  /** @internal test hook - forwards to {@link ViewBundleState.lastBundleVisualEpoch} */
  get lastBundleVisualEpoch(): number {
    return this.bundles.lastBundleVisualEpoch
  }
  /** @internal test hook - forwards to {@link ViewPoolState.settledStructEpoch} */
  get settledStructEpoch(): number {
    return this.pool.settledStructEpoch
  }
  /** @internal test hook - forwards to {@link ViewPoolState.lastPooledStructEpoch} */
  get lastPooledStructEpoch(): number {
    return this.pool.lastPooledStructEpoch
  }
  /** @internal test hook - forwards to {@link ViewPoolState.poolMovedAt} */
  get poolMovedAt(): ReadonlyMap<string, number> {
    return this.pool.poolMovedAt
  }
  /** @internal test hook - forwards to {@link ViewPoolState.poolDragEject} */
  get poolDragEject(): ReadonlySet<string> | null {
    return this.pool.poolDragEject
  }
  /** @internal test hook - forwards to {@link ViewPoolState.poolWriteThrough} */
  get poolWriteThrough(): ReadonlySet<string> | null {
    return this.pool.poolWriteThrough
  }
  /** @internal test hook - forwards to {@link ViewPoolState.poolWTStructural} */
  get poolWTStructural(): ReadonlySet<string> {
    return this.pool.poolWTStructural
  }
  /** @internal test hook - forwards to {@link ViewPoolState.bundleDragEjected} */
  get bundleDragEjected(): ReadonlySet<string> {
    return this.pool.bundleDragEjected
  }

  constructor(container: HTMLElement, options?: RenderViewOptions) {
    this.container = container
    this.onFrame = options?.onFrame

    // default = WebGLRenderer; options.renderer carries an initialised WebGPURenderer
    // on the WebGPU path (set up by App via createRenderer.ts)
    this.renderer = options?.renderer ?? new WebGLRenderer({ antialias: renderQuality.msaaSamples > 0 })
    // let WebGPU-incompatible part visuals (the raw-GLSL floor-marking ShaderMaterial)
    // hide themselves instead of rendering as opaque black (see renderMode.ts / floorMarking.ts)
    setWebGPURenderMode(!(this.renderer instanceof WebGLRenderer))
    // build the gizmo now the render-mode flag is set, so its rings choose the right
    // (WebGL vs TSL/WebGPU) half-ring material (see the field declaration above)
    this.gizmo = new TransformGizmo()
    // phones over-render at native DPR (often ~3x); the mobile tier caps lower (quality.ts).
    // This is the largest single fill-rate saving, since it scales every per-fragment cost.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderQuality.pixelRatioCap))
    // shadows render correctly on both backends, so they stay enabled under WebGPU too
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap
    this.renderer.toneMapping = AgXToneMapping
    this.renderer.toneMappingExposure = 1.2
    container.appendChild(this.renderer.domElement)

    this.camera = new EditorCamera(50, 1, 0.1, CAMERA_FAR)
    this.camera.position.set(DEFAULT_CAMERA_POSE.px, DEFAULT_CAMERA_POSE.py, DEFAULT_CAMERA_POSE.pz)
    this.camera.lookAt(DEFAULT_CAMERA_POSE.tx, DEFAULT_CAMERA_POSE.ty, DEFAULT_CAMERA_POSE.tz)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    // MIDDLE is the navigation style's plain middle drag (core/navigation.ts), re-read in onShiftChange
    this.controls.mouseButtons = { LEFT: null, MIDDLE: this.plainMiddle(), RIGHT: null }
    // touch: one finger orbits, two fingers pinch-zoom + pan. The editor never starts a
    // capture-drag on touch (see controller onPointer*), so one-finger drags reach here.
    this.controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }
    // every update turns about the orbit pivot when one is set (updateOrbitControls). Patched on the instance, not
    // around the frame loop's call: OrbitControls' own pointer handlers call this.update() too, and a rotation
    // applied there would skip the pivot. defineProperty, not assignment, per the lockdown rule (AGENTS.md).
    const ocUpdate = this.controls.update.bind(this.controls)
    Object.defineProperty(this.controls, 'update', {
      value: (deltaTime?: number | null): boolean => this.updateOrbitControls(ocUpdate, deltaTime),
      writable: true,
      configurable: true,
    })
    this.controls.enableDamping = true
    // the orbit clamp only guards a degenerate rig: wheel zoom closes on the surface under the
    // cursor (wheelZoom.ts) and carries the target along, so a coarse clamp here would push it back
    this.controls.minDistance = WHEEL_ZOOM.minTargetDistance
    this.controls.maxDistance = ORBIT_MAX_DISTANCE
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05
    // the view handles the wheel: detach OrbitControls' own wheel dolly (a three internal, see
    // docs/three-coupling.md). `enableZoom = false` would take the touch pinch with it.
    const ocWheel = (this.controls as unknown as { _onMouseWheel?: EventListener })._onMouseWheel
    if (typeof ocWheel === 'function') this.renderer.domElement.removeEventListener('wheel', ocWheel)
    else console.warn('[oip] OrbitControls._onMouseWheel moved: its wheel dolly will run alongside the cursor zoom (docs/three-coupling.md)')
    this.renderer.domElement.addEventListener('wheel', this.onZoomWheel, { passive: false })

    // Shift (also Ctrl / Meta) swapping orbit and pan is OrbitControls' own, decided at pointerdown
    // (three's _onMouseDown). This only re-reads the navigation style, so a pick in Settings applies
    // without a reload. Don't also swap MIDDLE on Shift: that cancels three's swap, so Shift+middle orbits.
    window.addEventListener('keydown', this.onShiftChange)
    window.addEventListener('keyup', this.onShiftChange)
    window.addEventListener('blur', this.onWindowBlur)
    this.renderer.domElement.addEventListener('pointerdown', this.onShiftChange)

    // cancel navigation: snapshot on an orbit/pan drag start so a right-click
    // or Esc mid-drag snaps the camera back. The abort listeners run in the capture
    // phase so they run before freelook's RMB-to-fly and the editor's own Esc handling.
    this.controls.addEventListener('start', this.onNavStart)
    this.controls.addEventListener('end', this.onNavEnd)
    container.addEventListener('pointerdown', this.onNavAbortDown, true)
    window.addEventListener('keydown', this.onNavAbortKey, true)

    this.freelook = new Freelook(this.renderer.domElement, this.camera, {
      // freelook doesn't work in an orthogonal view - the RMB gesture pans
      // the view plane instead and Shift+F doesn't engage
      isOrthographic: () => this.camera.orthographic,
      panBy: (dx, dy) => this.panBy(dx, dy),
      onPanStart: () => {
        this.nav.focusAnim = null
        this.stopFollow() // panning owns the rig; a running follow/focus would fight it
      },
      onStart: () => {
        this.nav.focusAnim = null
        this.nav.zoomPending = 0 // an unfinished wheel zoom must not land when the flight ends
        this.nav.orbitPivot = null
        this.stopFollow() // flying free breaks follow mode
        this.freelookDist = this.camera.position.distanceTo(this.controls.target)
        this.controls.enabled = false
      },
      onEnd: () => {
        this.controls.enabled = true
        const fwd = this.camera.getWorldDirection(this.camTmp)
        this.controls.target.copy(this.camera.position).addScaledVector(fwd, this.freelookDist)
        this.hideFlySpeed()
      },
      onSpeedChange: (speed) => this.showFlySpeed(speed),
    })

    this.overlays.build(container)

    this.orbitGizmo = new OrbitGizmo(container, this.camera, {
      snapToAxis: (dir) => this.snapToAxis(dir),
      orbitBy: (dx, dy) => this.orbitBy(dx, dy),
      beginOrbit: () => this.beginOrbit(),
      cancelOrbit: () => this.cancelOrbit(),
    })

    // default Line threshold is 1 world meter - spawner edge lines would steal picks
    this.raycaster.params.Line.threshold = 0.02

    this.env = createEnvironment(this.scene)

    // first-person walk-around: collides against the placed parts near its feet
    // (pilotCollidersNear - the floor is an invisible y=0 plane inside the pilot),
    // and is carried by the conveyor (if any) under its feet
    this.pilot = new Pilot(
      this.renderer.domElement,
      this.camera,
      (x, y, z) => this.pilotCollidersNear(x, y, z),
      {
        onExit: () => this.walk.pilotHandlers?.onExit(),
        onInteract: () => this.walk.pilotHandlers?.onInteract(),
      },
      (object, x, z) => this.pilotSurfaceVelocity(object, x, z),
    )

    this.scene.add(
      this.partsGroup,
      this.livePartsGroup,
      this.flowArrowBank.group,
      sensorBeamGroup,
      this.backdropGroup,
      this.boxes.group,
      this.boxes.dressing.group,
      this.gizmo.root,
      this.handles.root,
      this.rigGizmoOverlay.root,
      this.overlays.rulerGroup,
      this.walk.presenceGroup,
    )

    // The scene root and parts container are identity transforms that never move.
    // three's updateMatrixWorld (r184) recomposes every auto-update node each frame
    // and a self-dirtying ancestor sets force=true for its whole subtree -
    // so leaving these on would re-multiply every part's world matrix every frame even
    // when frozen (see syncMatrixFreeze). Disabling their auto-update keeps force=false
    // at the top, letting frozen static subtrees opt out of the per-frame matrix walk.
    // Dynamic children (sim boxes, gizmos, animated parts) keep matrixAutoUpdate=true
    // and so still self-dirty + update normally relative to the identity root.
    this.scene.matrixAutoUpdate = false
    this.partsGroup.matrixAutoUpdate = false
    this.livePartsGroup.matrixAutoUpdate = false
    // The view owns the world-matrix walk (updateWorldMatrices, run each tick before the
    // bundle patch + render). three r185's scene.updateMatrixWorld() recurses into every
    // child unconditionally (matrixWorldAutoUpdate=false skips only the multiply, never
    // the visit), so the renderer-driven walk costs O(scene nodes) per frame even when
    // nothing moves (measured 2-2.6ms at a ×4-duplicated demo line, the largest idle
    // cost). Turning it off at the one gate both backends honor (`if (scene.
    // matrixWorldAutoUpdate) scene.updateMatrixWorld()`) and walking only movable roots
    // makes idle matrix cost scale with what moved, not with what exists.
    this.scene.matrixWorldAutoUpdate = false

    // Scene-global static-hardware pooling: merges structurally-identical InstancedMeshes of the
    // non-selected parts into shared world-space pools (fewer draw calls / pipelines). Default on;
    // `?noinstancepool` is the kill-switch. Rebuilt from syncScene/setSelection (see rebuild()'s
    // early-out signature); dynamic correctness pinned by instancePool.test.ts.
    if (wantsInstancePool()) {
      this.instancePool = new InstancePoolManager(this.scene, [this.partsGroup, this.livePartsGroup])
    }

    // The transform/resize/ruler manipulators are always-on-top (depthTest-off) overlays;
    // put them on OVERLAY_LAYER so the WebGPU path draws them in its final sub-pass, over the
    // bundled main pass (consolidatedOutlineNode.renderLayeredScene; WebGL draws them inline, last by
    // renderOrder). Their meshes are all built up front, so enabling the layer once here covers them
    // (the lazily-grown handle pools opt in per-mesh in handles.ts).
    // frustumCulled=false keeps the WebGPU overlay pass's cached projection (subPassCache)
    // camera-independent: a gizmo culled off-screen at record time would otherwise stay
    // missing from the replayed list as the camera orbits back. These are a handful of tiny
    // always-on-top meshes drawn only while their root is visible, so culling would save nothing.
    for (const root of [this.gizmo.root, this.handles.root, this.overlays.rulerGroup]) {
      root.traverse((o) => { o.layers.enable(OVERLAY_LAYER); o.frustumCulled = false })
    }

    // WebGL uses the EffectComposer ConsolidatedSelectionOutline; WebGPU swaps in the node-based
    // twin (its EffectComposer is WebGL-only), built via the factory createRenderer registered
    // after loading three/webgpu. renderFrame() runs whichever is non-null.
    // Palette-merged mask (outlineMaskMerge.ts): the twins render the whole selection's unique
    // meshes as one draw. `?nomaskmerge` switches them to their per-mesh mask path.
    if (wantsOutlineMaskMerge()) {
      this.maskMerge = new OutlineMaskMergeManager()
      this.scene.add(this.maskMerge.group)
    }
    const getMaskMerge = (): OutlineMaskMergeSurface | null => this.maskMerge
    this.outline =
      this.renderer instanceof WebGLRenderer
        ? new ConsolidatedSelectionOutline(this.renderer, this.scene, this.camera, renderQuality, getMaskMerge)
        : createWebGPUOutline(this.renderer, this.scene, this.camera, () => this.collectOverlays(), getMaskMerge)

    // Dynamic resolution (gated). Tick'd each frame from the loop; a no-op unless ?drs.
    this.adaptive = createAdaptiveQuality(renderQuality, (pixelRatio) => this.applyPixelRatio(pixelRatio))

    // The renderer and scene exist, so from here the cover is waiting on the building's GLBs and
    // textures, not on boot. The cover shows each load stage as text rather than an animation (see
    // LoadStage in renderReady.ts): the pre-warm below stalls presentation outright, and a label stays
    // readable through that where a spinner freezes.
    setLoadStage('models')
    if (!(this.renderer instanceof WebGLRenderer)) viewWarm.startStagedPrewarm(this, this.renderer)

    // VR walkthrough (WebGL only). While a session presents, the session's rAF drives
    // tick() through renderer.setAnimationLoop and the view's own loop stays parked.
    this.xr =
      this.renderer instanceof WebGLRenderer
        ? new ViewXR(this.renderer, this.scene, this.camera, {
            suspendLoop: () => cancelAnimationFrame(this.rafId),
            resumeLoop: () => {
              if (this.disposed) return
              this.lastTime = null // fresh dt on the first post-session frame (resetFrameClock)
              this.rafId = requestAnimationFrame(this.loop)
            },
            tick: (now) => this.tick(now),
          })
        : null

    this.applyResize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)

    this.rafId = requestAnimationFrame(this.loop)
  }

  syncScene(scene: SceneJSON, opts?: { load?: boolean }): void {
    viewSync.syncScene(this, scene, opts)
  }

  setHoldDeparted(on: boolean): void {
    this.holdDeparted = on
  }

  /**
   * Dev/E2E invariant (see gpuTextureAudit.ts): cross-check every scene texture's CPU-side image size
   * against the GPUTexture the WebGPU backend actually holds. A mismatch means an in-place image swap the
   * backend never re-allocated for: the "stale until browser refresh" class (e.g. the belt weave
   * swap). Console: `window.__oip.view.auditGpuTextures()`. Returns null on WebGL (the class can't occur:
   * texImage2D re-specifies the texture on every upload).
   */
  auditGpuTextures(): GpuTextureAuditResult | null {
    return auditGpuTextures(this.scene, this.renderer)
  }

  /**
   * Dev/E2E invariant (auditGpuTextures' sibling for the merge layers): at an idle point, every
   * merge mechanism's output must still match the live sources it was derived from. A mismatch
   * means sources changed with no re-derive scheduled, i.e. the pixels on screen are stale. That is
   * the "railing only opens on commit" class, which shows up as intermittent, GPU-dependent user
   * reports when nothing asserts this.
   *
   * Every mechanism here is half batching and half invalidation, and the bugs are in the second
   * half, so this is one audit over all of them rather than per-module debug hooks:
   *  - `instancePool`  merged static hardware vs a fresh signature walk over its sources
   *  - `staticFold`    every folded root (building walls/roof/floor/dock doors) vs its baked sig
   *  - `outlineMaskMerge` the merged selection mask vs the meshes it was baked from
   *  - `cargoSelection` the SimBoxes aSel rows vs the tiers the last refreshOutline shipped
   *
   * Call from e2e gates after actions settle, never mid-drag (the pool's write-through
   * legitimately invalidates its signature until the release re-bakes). `ok` is the AND over every
   * check that ran; `reason` names the first failure, so existing callers keep working.
   * Console: window.__oip.view.auditMergeCoherence().
   */
  auditMergeCoherence(): MergeCoherenceReport {
    const checks: MergeCoherenceCheck[] = []
    if (this.instancePool) {
      const r = this.instancePool.auditCoherence(this.poolExempt())
      checks.push({ name: 'instancePool', ...r })
    }
    // fold roots are nested inside building visuals (walls/roof/floor/dock doors), so find them by
    // the signature the fold stamps rather than by a path the view would have to know about
    this.scene.traverse((o) => {
      if (typeof o.userData.staticFoldSig !== 'string') return
      const r = auditStaticFold(o)
      checks.push({ name: `staticFold:${o.name || o.id}`, ...r })
    })
    if (this.maskMerge) checks.push({ name: 'outlineMaskMerge', ...this.maskMerge.auditCoherence() })
    checks.push({ name: 'cargoSelection', ...this.boxes.auditSelectionRows() })
    // each scene-change consumer's retained output vs a fresh derivation: a `reads` that missed a dependency
    checks.push(...this.sceneConsumers.audit())
    const failed = checks.find((c) => !c.ok)
    return { ok: !failed, reason: failed ? `${failed.name}: ${failed.reason}` : '', checks }
  }

  pumpWarm(): Promise<void> {
    return viewWarm.pumpWarm(this)
  }

  compileSwap(): Promise<void> {
    return viewWarm.compileSwap(this)
  }

  private drainRevealQueue(): void {
    viewWarm.drainRevealQueue(this)
  }

  /** see IRenderView.heldParts: `warming` is the one set both holds (pumpWarm, drainRevealQueue) keep */
  heldParts(): number {
    return this.warm.warming.size
  }

  /** see IRenderView.whenPartsRevealed */
  whenPartsRevealed(): Promise<void> {
    if (this.warm.warming.size === 0 || this.disposed) return Promise.resolve()
    return new Promise((resolve) => this.warm.revealWaiters.push(resolve))
  }

  private flushRevealWaiters(): void {
    viewWarm.flushRevealWaiters(this)
  }

  /**
   * A part entry's intended scene-graph visibility: hidden parts and pipeline-warming parts are
   * held invisible; cargo renders through the instanced batch, so its per-part mesh stays hidden
   * (0 draws), except the placement-staging preview, which renders its real GLB visual directly
   * (it has no sim body and is filtered out of the idle batch, so the entry is its only pixels).
   */
  intendedVisible(entry: Entry): boolean {
    return !this.warm.warming.has(entry.part.id) && this.shownOnceReleased(entry)
  }

  /** {@link intendedVisible} minus the warm hold: whether the entry draws once nothing holds it back */
  shownOnceReleased(entry: Entry): boolean {
    const id = entry.part.id
    if (this.hidden.has(id)) return false
    return !isCargoPart(entry.part) || id === this.stagingId
  }

  poolExempt(): ReadonlySet<string> {
    return viewPool.poolExempt(this)
  }

  private poolRebuildOnStructureSettled(): void {
    viewPool.poolRebuildOnStructureSettled(this)
  }

  poolRebuild(onlyIfExemptChanged = false): void {
    viewPool.poolRebuild(this, onlyIfExemptChanged)
  }

  setPoolDragEject(ids: readonly string[] | null, structural = true): void {
    viewPool.setPoolDragEject(this, ids, structural)
  }

  setSelection(ids: readonly string[]): void {
    const next = new Set(ids)
    for (const id of this.selection) {
      if (!next.has(id)) this.entries.get(id)?.visual.setSelected(false)
    }
    for (const id of next) {
      if (!this.selection.has(id)) this.entries.get(id)?.visual.setSelected(true)
    }
    this.selection = next
    // (matrix freeze does not track selection: it keys on the drag seam, see syncMatrixFreeze.
    // setPoolDragEject re-syncs the affected entries at drag boundaries)
    // Cargo outlining follows the whole subtree (see refreshOutline). Selected cargo stays in the
    // instanced batch: refreshOutline sends the selection tiers to boxes.setSelectionTiers (the
    // aSel channel the mask discards on), so nothing to do here.
    // Deferred ejection: selection does not change pool membership (parts leave the pool at
    // drag start via setPoolDragEject, not on select), so this is exempt-key-gated and a plain
    // selection change skips even the signature walk. It is called here because this is the lazy
    // re-pool point. setPoolDragEject clears without rebuilding, and every store change goes
    // through setSelection, so a finished drag's parts re-enter the pool at their committed
    // poses on the very next change (the cleared drag ids change the key).
    this.poolRebuild(true)
    this.refreshOutline()
  }

  /**
   * Author-mode rig-node highlight: outline one internal link of a custom part (its own meshes, not the
   * down-chain it parents, so picking a shoulder doesn't light the whole arm). Pass null to clear. Mirrors
   * the store's read-only rig-node selection; independent of the part-level `setSelection`.
   */
  setRigNodeHighlight(sel: { partId: string; linkName: string } | null): void {
    const a = this.outlineState.rigHighlight
    if (a === sel || (a && sel && a.partId === sel.partId && a.linkName === sel.linkName)) return
    this.outlineState.rigHighlight = sel
    this.refreshOutline()
  }

  /**
   * Re-apply every placed instance of a package after its geometry/assets changed in the registry - author-mode
   * geometry edits, or desktop hot-reload. The visual's geomSignature now reflects the new geometry, so update()
   * rebuilds the rig. Re-resolves any rig-node highlight against the rebuilt link groups.
   */
  refreshPackage(id: string): void {
    this.beamProbeDirty = true // a package edit can move/resize beam links or cargo bounds
    // revoke the kind's pipeline warmth: the edited/hot-reloaded geometry+materials may need new
    // pipelines, so the next add of this kind goes back through the warm-hold instead of drawing cold
    this.warm.kindWarm.delete(`part:${id}`)
    for (const entry of this.entries.values()) {
      const p = entry.part
      if (p.type === 'part' && (p as { packageId?: string }).packageId === id) {
        entry.visual.update(p, this.lastResolved?.get(p.id))
        // a package edit can move the arrow signature (segments/height derive from pkg params);
        // re-sync now, since a parked scene runs no syncScene until the next edit
        this.syncFlowArrow(entry)
        // update bumped the visual's poseRev; a frozen instance re-bakes now rather than at the next
        // frame's sweep, because instancePool.rebuild below bakes pooled copies from these matrices
        this.ensureFreshPose(entry)
      }
    }
    // A cargo part with its own body draws through the cargo batch, from visuals the batch keeps: they take the
    // edited package too. A stopped scene sends no new cargo frame, so the idle one is built again against the
    // package, which redraws those bodies. Only when the batch holds a shape of it: this runs once per package of
    // a library being adopted.
    if (this.boxes.refreshPackage(id)) this.applyIdleCargoFrame()
    // the rebuild swapped in fresh hardware meshes; re-pool so stale (disposed) sources aren't left baked
    this.poolRebuild()
    // force: selection/rig/structure are unchanged, but the rebuilt link meshes the rig-highlight
    // tier holds by reference are stale, so the membership-signature gate must not short-circuit
    this.refreshOutline(true)
  }

  /**
   * Author-mode gizmo placement for a rig node: the link's world position (where the move gizmo sits) plus
   * its parent's world matrix (the frame the link's offset is expressed in; the controller inverts it to
   * convert a world-space drag delta into a parent-local offset delta). Null if the link isn't rendered.
   */
  rigLinkGizmo(partId: string, linkName: string): { worldPos: [number, number, number]; parentWorld: number[] } | null {
    const entry = this.entries.get(partId)
    if (!entry) return null
    // this read can happen between frames (controller pushGizmo on store change). If the part is frozen
    // and its pose data just moved, re-bake first so the gizmo doesn't trail the node by a frame
    this.ensureFreshPose(entry)
    const root = entry.visual.object
    const g = findLinkGroup(root, linkName)
    if (!g || !g.parent) return null
    g.updateWorldMatrix(true, false)
    const wp = new Vector3().setFromMatrixPosition(g.matrixWorld)
    g.parent.updateWorldMatrix(true, false)
    return { worldPos: [wp.x, wp.y, wp.z], parentWorld: [...g.parent.matrixWorld.elements] }
  }

  /** global flow-arrow visibility (the "." toggle); rebuilds nothing, just shows/hides */
  setFlowArrowsVisible(visible: boolean): void {
    if (visible === this.flowArrowsVisible) return
    this.flowArrowsVisible = visible
    for (const entry of this.entries.values()) {
      // the staging preview's arrow stays visible regardless of the global toggle
      this.flowArrowBank.setVisible(entry.part.id, visible || entry.part.id === this.stagingId)
    }
    // The arrows are outside the bundles (the overlay bank), but the toggle runs off a pref
    // change with no syncScene, so the frame is parked. Without an epoch bump the outline
    // pass would replay its cached pre-toggle projection and never draw the new list
    // (arrows invisible until the next unrelated edit). The bump invalidates those caches.
    notifyBundleStructureChanged()
  }

  /** show/hide the floor reference grid (the ground plane is unaffected) */
  setGridVisible(visible: boolean): void {
    if (visible === this.gridVisible) return
    this.gridVisible = visible
    this.env.setGridVisible(visible)
    // Same seam as setFlowArrowsVisible: the grid enters/leaves collectOverlays here, but the
    // toggle runs off a pref change with no syncScene, so the frame is parked. Without an epoch
    // bump the sub-passes would replay their cached pre-toggle projections. Gate: verify-floor-grid.mjs.
    notifyBundleStructureChanged()
  }

  private showFlySpeed(speed: number): void {
    viewOverlays.showFlySpeed(this, speed)
  }

  private hideFlySpeed(): void {
    viewOverlays.hideFlySpeed(this)
  }

  /** how the measure tool writes a length; an open ruler re-reads at once. DOM labels only, so no bundle epoch. */
  setDisplayUnits(units: DisplayUnits): void {
    if (units === this.overlays.displayUnits) return
    this.overlays.displayUnits = units
    this.updateRulerLabel()
  }

  /** world-space origin of a placed part (its visual root), for presence markers; null if absent */
  partWorldPosition(id: string): [number, number, number] | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const obj = entry.visual.object
    obj.updateWorldMatrix(true, false)
    const v = new Vector3().setFromMatrixPosition(obj.matrixWorld)
    return [v.x, v.y, v.z]
  }

  /**
   * Project a world point to CSS-pixel screen coords (for the DOM presence overlay).
   * `visible` is false when the point is off-screen or behind the camera, so the caller can
   * hide a remote cursor/selection marker that isn't in view.
   */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = new Vector3(x, y, z).project(this.camera)
    const rect = this.renderer.domElement.getBoundingClientRect()
    const sx = rect.left + ((v.x + 1) / 2) * rect.width
    const sy = rect.top + ((1 - v.y) / 2) * rect.height
    const visible = v.z > -1 && v.z < 1 && v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1
    return { x: sx, y: sy, visible }
  }

  syncFlowArrow(entry: Entry): void {
    viewSync.syncFlowArrow(this, entry)
  }

  refreshTickRegistries(): void {
    viewRegistries.refreshTickRegistries(this)
  }

  private collectOverlays(): Object3D[] {
    return viewRegistries.collectOverlays(this)
  }

  refreshOutline(force = false): void {
    viewOutline.refreshOutline(this, force)
  }

  warmPart(part: PartInstance, opts?: { pipeline?: boolean }): void {
    viewWarm.warmPart(this, part, opts)
  }

  /**
   * Placement staging (docs/placement-staging.md): tag one scene part id as the live placement
   * preview. The editor stages the part itself into the scene (a transient scene streamed
   * per pointer-move), and it renders as a completely normal part: real materials, real shadows,
   * occluded by walls exactly like a reposition drag. So the preview is pixel-identical to the
   * part the drop commits (roof auto-hide / the building-shell toggle already cover occlusion,
   * same as every other drag). The tag only governs interaction: the staged id is excluded from
   * picking, rest-surface raycasts, the instance pool and the idle cargo batch, and its flow
   * arrow is forced on. On a drop the same entry becomes the committed part (the editor
   * pre-allocates the final id), so nothing is torn down or rebuilt. That shared identity
   * makes the drop seamless (no flash, no re-warm).
   */
  setStaging(partId: string | null): void {
    this.stagingId = partId
  }

  flashSnap(x: number, z: number, y = 0): void {
    viewOverlays.flashSnap(this, x, z, y)
  }

  // --- vertex snapping ----------
  // The screen-space nearest-vertex queries + snap markers live in vertexSnapPick.ts
  // (per-view scratch/marker state on this.vsnap). The view owns the camera projection;
  // the controller drives the modal interaction + markers. These wrappers keep the
  // IRenderView surface.

  /** nearest snap vertex (world) on any of `ids`, within `thresholdPx` of the cursor; null if none */
  vertexSnapSource(clientX: number, clientY: number, ids: readonly string[], thresholdPx: number, useCollision: boolean): Vector3 | null {
    return vertexSnapPick.vertexSnapSource(this, clientX, clientY, ids, thresholdPx, useCollision)
  }

  /** nearest snap vertex (world) on a visible part not in `exclude`, within `thresholdPx`; with its part id */
  vertexSnapTarget(
    clientX: number,
    clientY: number,
    exclude: ReadonlySet<string>,
    thresholdPx: number,
    useCollision: boolean,
  ): { point: Vector3; partId: string } | null {
    return vertexSnapPick.vertexSnapTarget(this, clientX, clientY, exclude, thresholdPx, useCollision)
  }

  /** intersect the cursor ray with the camera-facing plane through `through` (free-drag fallback) */
  cameraPlanePoint(clientX: number, clientY: number, through: Vector3): Vector3 | null {
    return vertexSnapPick.cameraPlanePoint(this, clientX, clientY, through)
  }

  /** show/update the vertex-snap source + target markers; null hides each */
  showVertexMarkers(source: Vector3 | null, target: Vector3 | null): void {
    vertexSnapPick.showVertexMarkers(this, source, target)
  }

  /** internal - frame routing's repeat gates and driven / hand-posed rigs (viewFrameRouting.ts) */
  readonly routing = new FrameRoutingState()

  applyBoxFrame(frame: BoxFrame): void {
    viewFrameRouting.applyBoxFrame(this, frame)
  }

  setHandPosed(partIds: readonly string[]): void {
    this.routing.handPosed = new Set(partIds)
  }

  applyIdlePose(partId: string, pose: { joints?: Record<string, number>; subPoses?: Record<string, SubPose>; lamps?: Record<string, boolean> }): void {
    // stopped-sim only: while running, applyBoxFrame drives this rig every frame and would fight this pose (unless
    // the rig is hand-posed, when the frames stand aside for it)
    if (this.running && !this.routing.handPosed.has(partId)) return
    const obj = this.entries.get(partId)?.visual.object
    if (!obj) return
    // same appliers the running frame routes to (applyBoxFrame): joints first, then subPose overrides win.
    if (pose.joints) (obj.userData.applyJoints as ((j: Record<string, number>) => void) | undefined)?.(pose.joints)
    if (pose.subPoses) (obj.userData.applySubPoses as ((p: Record<string, SubPose>) => void) | undefined)?.(pose.subPoses)
    // a beam on a link this pose moved casts from where the link now stands. Stopped, the beam probe reruns only on
    // a scene, cargo or registry change, so without this the beam stays drawn where the link was (a lift's deck
    // eye left at the lower level). Running, the frame's probe pass re-aims it.
    if (!this.running && (pose.joints || pose.subPoses) && typeof obj.userData.probeTick === 'function') {
      const ref = this.registries.probeTickRefs.find((r) => r.entry.part.id === partId)
      if (ref) this.probeSensor(ref, true)
    }
    if (pose.lamps) {
      const applyLamps = obj.userData.applyLamps as ((l: Record<string, boolean>) => void) | undefined
      if (applyLamps) {
        applyLamps(pose.lamps)
        markBundleDirtyPart(partId) // emissive paint, like the running frame's lamp routing
      }
    }
  }

  /**
   * Render authored box/pallet cargo through the instanced SimBoxes batch while idle
   * (sim stopped), built straight from the scene - instead of one GLB mesh per part.
   * Selected cargo outlines from inside the batch via its aSel rows (boxes.setSelectionTiers).
   * No-op while a live sim frame drives the batch (running && simHasFrame) so it never clobbers
   * the physics-driven frame.
   */
  applyIdleCargoFrame(): void {
    if (this.running && this.simHasFrame) return
    if (!this.lastScene) return
    // drop user-hidden cargo so the batch matches the per-part visibility toggle (this.hidden was
    // just recomputed in syncScene; setSelection/setRunning reuse that snapshot). The placement-
    // staging preview also stays out when it is cargo: its entry renders the real GLB directly
    // (intendedVisible), so batching it too would draw the preview twice. A staged unit load stays
    // in: it draws nothing of its own, and the pallet and cases it stacks exist only in this batch
    // (their rows carry its id, so picking and rest surfaces already skip them as the staged part).
    // (no cargo-count cap here: the SimBoxes batch grows its instance buffers on demand,
    // so authored cargo past MAX_BOXES renders idle and running, and the sim does not cap it either)
    // keep the frame for the stopped-path beam probe (castBeamFrame), so beams see exactly the cargo
    // this batch renders, and re-run the probes against it when it is a new frame (the memo returns
    // the same one while no cargo changed)
    const frame = this.idleCargoMemo(this.idleCargoParts())
    if (frame !== this.idleCargoFrame) this.beamCargoDirty = true
    this.idleCargoFrame = frame
    this.boxes.apply(frame)
  }

  private idleCargoParts(): PartInstance[] {
    return this.lastScene ? this.lastScene.parts.filter((p) => !this.hidden.has(p.id) && (p.id !== this.stagingId || !isCargoPart(p))) : []
  }

  /**
   * The view's scene-change consumers (viewSceneConsumers.ts), in the order they run after a sync. Each states the
   * parts it reads; its audit runs in auditMergeCoherence.
   */
  private createSceneConsumers(): SceneConsumers {
    const consumers = new SceneConsumers()
    // 'self': the cargo memo compares its own input, and hiding a group changes which cargo it draws without
    // touching a cargo part, which no part predicate could say
    consumers.register({
      name: 'idleCargoFrame',
      reads: 'self',
      apply: () => this.applyIdleCargoFrame(),
      audit: () => {
        if (this.running && this.simHasFrame) return { ok: true, reason: '' } // the sim's frame owns the batch
        const fresh = buildAuthoredCargoFrame(this.idleCargoParts())
        const kept = this.idleCargoFrame
        return !kept || cargoFramesEqual(kept, fresh) ? { ok: true, reason: '' } : { ok: false, reason: 'the idle cargo frame differs from a fresh build of the scene' }
      },
    })
    // the stopped beam probe reads each sensor's own pose and params (positions are world-space, so a parent's move
    // rewrites its children) and the cargo frame, whose change applyIdleCargoFrame flags above. An edited sensor is
    // re-probed alone (runPartialBeamProbes); a sensor added or removed, or a full delta, re-probes them all
    consumers.register({
      name: 'sensorBeams',
      reads: drawsSensorBeam,
      apply: (delta) => {
        if (delta.full) {
          this.beamProbeDirty = true
          return
        }
        for (const [id, { prev, next }] of delta.changed) {
          if (!(prev && drawsSensorBeam(prev)) && !(next && drawsSensorBeam(next))) continue
          if (!prev || !next) {
            this.beamProbeDirty = true
            return
          }
          this.beamSensorsDirty.add(id)
        }
      },
      audit: () => this.auditSensorBeams(),
    })
    return consumers
  }

  /** Re-probe every sensor beam now and report whether any beam moved: a beam that changes here was stale on screen. */
  private auditSensorBeams(): { ok: boolean; reason: string } {
    // running: beams follow the sim's frames; dirty: a probe is already scheduled for the next frame
    if (this.running || this.beamProbeDirty || this.beamCargoDirty || this.beamSensorsDirty.size > 0) return { ok: true, reason: '' }
    const before = sensorBeamDebug().beams
    this.runBeamProbes()
    const after = sensorBeamDebug().beams
    const near = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => Math.abs(v - b[i]!) < 1e-4)
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const a = before[i]
      const b = after[i]
      if (!a || !b || a.visible !== b.visible || !near(a.origin, b.origin) || !near(a.end, b.end) || !near(a.color, b.color)) {
        return { ok: false, reason: `sensor beam ${i} changed on a fresh probe: it was stale` }
      }
    }
    return { ok: true, reason: '' }
  }

  /** one stopped/running beam probe pass over every sensor rig (the per-frame gate in tickBody decides when) */
  private runBeamProbes(): void {
    // stopped, each sensor's casts are recorded for the next cargo-only pass; running, beams read the worker's hits
    const record = !(this.running && this.simHasFrame)
    this.beamCasts.clear()
    for (const ref of this.registries.probeTickRefs) this.probeSensor(ref, record)
    this.probedCargoFrame = record ? this.idleCargoFrame : null
  }

  /**
   * The stopped pass after a change that only moved cargo (beamCargoDirty) or edited some sensors (beamSensorsDirty):
   * re-probe the edited sensors, and the sensors whose recorded casts enter a changed cargo row before or after the
   * change. Every other sensor would cast the same answer. A change in the cargo row count has no row-for-row diff, so
   * it takes the full pass.
   */
  private runPartialBeamProbes(): void {
    const before = this.probedCargoFrame
    const after = this.idleCargoFrame
    const rows = this.beamCargoDirty ? (before && after ? changedCargoRows(before, after) : null) : []
    if (!rows) {
      this.runBeamProbes()
      return
    }
    for (const ref of this.registries.probeTickRefs) {
      const id = ref.entry.part.id
      const casts = this.beamCasts.get(id)
      const crossed = rows.length > 0 && casts !== undefined && (castsCrossRows(casts, before!, rows) || castsCrossRows(casts, after!, rows))
      if (crossed || this.beamSensorsDirty.has(id)) this.probeSensor(ref, true)
    }
    this.probedCargoFrame = after
  }

  private probeSensor(ref: ViewRegistries['probeTickRefs'][number], record: boolean): void {
    const id = ref.entry.part.id
    this.ensureFreshPose(ref.entry)
    this.probePartId = id // routes this part's frame.beamHits in probeBeam
    let casts: number[] | null = null
    if (record) {
      casts = []
      this.beamCasts.set(id, casts)
    }
    this.probeCasts = casts
    try {
      if (ref.probeTick(this.probeBeam) === true) markBundleDirtyPart(id)
    } finally {
      this.probeCasts = null
    }
  }

  clearBoxes(): void {
    this.boxes.clear()
    this.simHasFrame = false
  }

  setRunning(running: boolean): void {
    this.running = running
    // a fresh run re-waits for the worker's first frame; the idle authored frame already
    // on screen stays until the first live frame replaces it (no blink). Stopping drops the
    // live/promoted state and repaints the authored cargo so the view is self-sufficient.
    this.simHasFrame = false
    // re-establish the sim-clock baseline so the first frame of a new run advances the scroll by 0
    // (a clean start), not by the whole gap since the previous run's last frame
    this.animSimBaseline = null
    // lamp routing is change-gated per applier (applyBoxFrame). A run boundary repaints lamps
    // outside that seam (rig refresh paints the idle param-bound lamp state on stop), so drop the
    // cache: the next run's first frame must paint even if it commands the same map
    this.routing.lastRoutedLamps = new WeakMap()
    this.routing.lastRoutedDisplays = new WeakMap() // same reason: a new run must repaint its panels from scratch
    if (!running) {
      this.boxes.clear()
      this.applyIdleCargoFrame()
      if (this.routing.ranSinceStop) this.resetRunPoses()
      this.routing.ranSinceStop = false
    } else this.routing.ranSinceStop = true
  }

  /**
   * Stop: return every run-driven visual to its authored state. While running, applyBoxFrame drives rig
   * links (joints/subPoses) and mobile roots (basePoses) straight into the scene graph. Nothing else ever
   * moves them back, so without this a stopped robot would stay at its last sim joint angles and a driven AGV
   * wherever it stopped ("pixels moved, data didn't": the authored part never changed).
   * Joints are position-control, so an empty command returns every declared joint to rest and clears the
   * rig's held last-pose (refresh would otherwise re-apply the run's final values). Re-running the part's
   * own apply() then restores the authored root transform, reflows links to rest (subPose residue), and
   * re-applies the authored idle `pose` param (posable manipulators). Behavior-settled devices (blade
   * stop, gate) are re-posed on top by the controller's refreshIdlePoses, which runs after this on the
   * same run→stop edge.
   */
  private resetRunPoses(): void {
    let reset = false
    for (const [id, entry] of this.entries) {
      const applyJoints = entry.visual.object.userData.applyJoints as ((j: Record<string, number>) => void) | undefined
      if (!applyJoints && !this.routing.baseDriven.has(id)) continue
      // a rig drops its subPoses too; applyJoints({}) alone left a setSubPose-driven link where the run put it
      const resetRunPose = entry.visual.object.userData.resetRunPose as (() => void) | undefined
      if (resetRunPose) resetRunPose()
      else applyJoints?.({})
      entry.visual.update(entry.part, this.lastResolved?.get(id))
      this.ensureFreshPose(entry) // re-bake the frozen subtree now (mirrors refreshPackage)
      entry.boundsDirty = true
      reset = true
    }
    this.routing.baseDriven.clear()
    // ...and re-pool, as refreshPackage does. update() re-runs apply(), which rewrites the rigs'
    // instanced banks in place (instanceMatrix.version changes; racks, platforms, stairs, roller
    // lanes are all rigs) without a structure bump. poolRebuildOnStructureSettled never fires, so
    // without this the merged copies would stay baked from the run's last frame
    // (verify-merge-coherence's "after stopping the sim").
    if (reset) this.poolRebuild()
  }

  resetFrameClock(): void {
    // next loop() hits the `lastTime === null` branch → dt = 1/60 (one fresh frame) instead
    // of (now - staleLastTime) clamped to 0.1s. Used on tab-resume to kill the dt spike.
    this.lastTime = null
  }

  // --- robot editor gizmo (joint rings + IK handle) ---
  // Handle picking + drag math live in robotGizmoDrag.ts (the active gizmo id + live
  // drag stay on this.robotGizmoId / this.robotDrag). These wrappers keep the
  // IRenderView surface.

  /** which robot's gizmo handles are interactive; visibility itself follows selection */
  setRobotGizmo(partId: string | null): void {
    robotGizmoDrag.setRobotGizmo(this, partId)
  }

  pickRobotHandle(clientX: number, clientY: number): RobotHandle | null {
    return robotGizmoDrag.pickRobotHandle(this, clientX, clientY)
  }

  setRobotHighlight(handle: RobotHandle | null): void {
    robotGizmoDrag.setRobotHighlight(this, handle)
  }

  beginRobotDrag(handle: RobotHandle, clientX: number, clientY: number): void {
    robotGizmoDrag.beginRobotDrag(this, handle, clientX, clientY)
  }

  robotDragResult(clientX: number, clientY: number, free?: boolean): { jointDeltaDeg?: number; ik?: number[]; sizeValue?: number } | null {
    return robotGizmoDrag.robotDragResult(this, clientX, clientY, free)
  }

  endRobotDrag(): void {
    robotGizmoDrag.endRobotDrag(this)
  }

  // --- custom-rig gizmo (a self-posing gizmo; the rig has no j-params, so the visual holds the pose) ---

  /** true if the part's gizmo is a custom-rig gizmo (poses its own visual) rather than the built-in robot's */
  hasRigGizmo(partId: string): boolean {
    return robotGizmoDrag.hasRigGizmo(this, partId)
  }

  /** the current held pose angle (deg) of a rig gizmo's joint i - the drag-start reference */
  rigGizmoJointAngle(partId: string, i: number): number {
    return robotGizmoDrag.rigGizmoJointAngle(this, partId, i)
  }

  /** pose a rig gizmo's joint i to an absolute angle (deg) - the joint-drag path (the IK path is solveIK) */
  poseRigGizmoJoint(partId: string, i: number, deg: number): void {
    robotGizmoDrag.poseRigGizmoJoint(this, partId, i, deg)
  }

  /** the rig gizmo's full held authoring pose (joint name → radians / metres) - the teach-pendant capture
   *  source. Null for a part without a self-posing rig gizmo; an unposed joint is absent (= rest 0). */
  setRigJointPose(partId: string, pose: Record<string, number>): void {
    robotGizmoDrag.setRigJointPose(this, partId, pose)
  }

  rigJointPose(partId: string): Record<string, number> | null {
    return robotGizmoDrag.rigJointPose(this, partId)
  }

  rigJogged(partId: string): boolean {
    return robotGizmoDrag.rigJogged(this, partId)
  }

  resetRigJog(partId: string): void {
    robotGizmoDrag.resetRigJog(this, partId)
  }

  /**
   * The entry's cached world AABB, recomputing it (and the collision proxy) first if a
   * scene sync marked it stale. Every bbox/proxy consumer must come through here. The
   * per-frame syncs of a gizmo drag only set boundsDirty, so the traversal runs on
   * the first ray/vertex-snap that actually needs the bound, not on every drag frame.
   * (internal - public for viewport modules: vertexSnapPick's broad-phase reads it)
   */
  boundsOf(entry: Entry): Box3 {
    if (entry.boundsDirty) {
      entry.boundsDirty = false
      this.refreshBounds(entry)
    }
    return entry.bbox
  }

  /** recompute an entry's cached world AABB + collision proxy after its visual is (re)built */
  private refreshBounds(entry: Entry): void {
    entry.bbox.setFromObject(entry.visual.object)
    this.syncProxy(entry)
    // cargo's visual is an empty stub (it renders through the instanced batch), so derive the
    // broadphase AABB from its collision proxy instead of leaving it empty (which forces an
    // always-scan) - the proxy's world matrix is already baked by refreshCollisionProxy.
    if (entry.bbox.isEmpty() && entry.proxy) entry.bbox.setFromObject(entry.proxy)
    // a small margin guards the broadphase against grazing rays on thin slabs
    // (e.g. the 0.08 m-tall roller-bed pick proxy) and async-loaded geometry
    if (!entry.bbox.isEmpty()) entry.bbox.expandByScalar(0.05)
  }

  partContainer(part: PartInstance): Group {
    return viewMatrices.partContainer(this, part)
  }

  syncPartContainer(entry: Entry): void {
    viewMatrices.syncPartContainer(this, entry)
  }

  syncMatrixFreeze(entry: Entry): void {
    viewMatrices.syncMatrixFreeze(this, entry)
  }

  ensureFreshPose(entry: Entry): void {
    viewMatrices.ensureFreshPose(this, entry)
  }

  /** internal - the owned matrix walk's own state (viewMatrices.ts) */
  readonly matrices = new ViewMatrixState()

  private updateWorldMatrices(): void {
    viewMatrices.updateWorldMatrices(this)
  }

  /**
   * Keep an entry's collision-raycast proxy in sync with its part. Conveyors get a
   * proxy (their visual deck is gappy strips/rollers); every other part raycasts its
   * visual directly, which already is its faithful collision surface.
   */
  private syncProxy(entry: Entry): void {
    // SDK conveyors proxy their gappy deck; cargo (built-in box/pallet + C-cargo custom parts) proxies its box
    // so drops/measure still land on it even though cargo renders through the instanced batch (hidden visual).
    const wantsProxy = isConveyorLike(entry.part) || isCargoPart(entry.part)
    if (!wantsProxy) {
      if (entry.proxy) {
        disposeCollisionProxy(entry.proxy)
        this.proxyGroup.remove(entry.proxy)
        entry.proxy = null
      }
      return
    }
    if (!entry.proxy) {
      entry.proxy = new Group()
      this.proxyGroup.add(entry.proxy)
    }
    refreshCollisionProxy(entry.proxy, entry.part)
  }

  raycastParts(maxDist = Infinity): Object3D[] {
    return viewPicking.raycastParts(this, maxDist)
  }

  private pilotCollidersNear(x: number, y: number, z: number): PilotColliders {
    return viewPilot.pilotCollidersNear(this, x, y, z)
  }

  pickPart(clientX: number, clientY: number): string | null {
    return viewPicking.pickPart(this, clientX, clientY)
  }

  pickPartsAt(clientX: number, clientY: number): string[] {
    return viewPicking.pickPartsAt(this, clientX, clientY)
  }

  pickRigLink(clientX: number, clientY: number, partId: string): string | null {
    return viewPicking.pickRigLink(this, clientX, clientY, partId)
  }

  pickBox(clientX: number, clientY: number): BoxPick | null {
    this.setPointerRay(clientX, clientY)
    return this.boxes.pick(this.raycaster)
  }

  groundPoint(clientX: number, clientY: number): { x: number; z: number } | null {
    this.setPointerRay(clientX, clientY)
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.hitPoint)
    return hit ? { x: hit.x, z: hit.z } : null
  }

  surfaceAt(
    clientX: number,
    clientY: number,
    excludeIds?: ReadonlySet<string>,
  ): { point: [number, number, number]; normal: [number, number, number]; partId?: string } | null {
    return viewPicking.surfaceAt(this, clientX, clientY, excludeIds)
  }

  measurePoint(clientX: number, clientY: number): [number, number, number] | null {
    // prefer a real part surface under the cursor; otherwise the floor plane
    const surf = this.surfaceAt(clientX, clientY)
    if (surf) return surf.point
    const ground = this.groundPoint(clientX, clientY)
    return ground ? [ground.x, 0, ground.z] : null
  }

  surfaceBelow(
    part: PartInstance,
    excludeIds: ReadonlySet<string>,
  ): { point: [number, number, number]; normal: [number, number, number] } | null {
    return viewPicking.surfaceBelow(this, part, excludeIds)
  }

  setRuler(a: [number, number, number] | null, b: [number, number, number] | null): void {
    viewOverlays.setRuler(this, a, b)
  }

  partsInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    return viewPicking.partsInRect(this, x0, y0, x1, y1)
  }

  cargoBodiesInRect(x0: number, y0: number, x1: number, y1: number): BoxPick[] {
    return viewPicking.cargoBodiesInRect(this, x0, y0, x1, y1)
  }

  setGizmo(state: GizmoState | null): void {
    this.gizmo.setState(state)
  }

  pickGizmoHandle(clientX: number, clientY: number): GizmoHandle | null {
    this.setPointerRay(clientX, clientY)
    return this.gizmo.pick(this.raycaster)
  }

  setGizmoHighlight(handle: GizmoHandle | null): void {
    this.gizmo.setHighlight(handle)
  }

  beginGizmoDrag(handle: GizmoHandle, clientX: number, clientY: number): void {
    this.setPointerRay(clientX, clientY)
    // the camera forward seeds the view/axis constraint planes (camera normal);
    // the pixel coords seed the trackball's grab point
    this.gizmo.beginDrag(handle, this.raycaster.ray, this.camera.getWorldDirection(this.camTmp), { x: clientX, y: clientY }, this.camera.orthographic)
  }

  gizmoConstrain(target: GizmoConstraint): void {
    this.gizmo.constrain(target)
  }

  setTransformReadout(text: string | null): void {
    this.setLabel(text)
  }

  /** internal - the readout pinned beside a world point instead of the transform gizmo (the robot gizmo's
   *  joint readout, robotGizmoDrag.ts); null clears it and the pin */
  showAnchoredReadout(text: string | null, anchor: Vector3 | null): void {
    this.overlays.labelAnchor = anchor
    this.setLabel(text)
  }

  gizmoDragDelta(
    clientX: number,
    clientY: number,
    snap?: GizmoSnap | null,
  ): {
    translation?: [number, number, number]
    rotationDelta?: number
    rotationAxis?: [number, number, number]
  } | null {
    this.setPointerRay(clientX, clientY)
    return this.gizmo.dragDelta(this.raycaster.ray, snap, { x: clientX, y: clientY })
  }

  endGizmoDrag(): void {
    this.gizmo.endDrag()
  }

  setResizeHandles(part: PartInstance | null): void {
    this.handles.setPart(part)
  }

  setSideGuardMode(on: boolean): void {
    this.handles.setSideGuardMode(on)
  }

  /** the pointer's pixel plus a world-to-pixel projection, for picking and dragging along a guard wall */
  private screenProjector(clientX: number, clientY: number): ScreenProjector {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const v = new Vector3()
    return {
      x: clientX,
      y: clientY,
      project: (p) => {
        v.set(p.x, p.y, p.z).project(this.camera)
        if (v.z < -1 || v.z > 1) return null
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }
      },
    }
  }

  pickGuardWall(clientX: number, clientY: number): GuardWallPoint | null {
    this.setPointerRay(clientX, clientY)
    return this.handles.pickWall(this.raycaster.ray, this.screenProjector(clientX, clientY), GUARD_WALL_PICK_PX)
  }

  setGuardWallHover(hit: GuardWallPoint | null): void {
    this.handles.setWallHover(hit)
  }

  setSelectedGuardOpening(sel: { index: number; guard: 'left' | 'right' } | null): void {
    this.handles.setSelectedOpening(sel)
  }

  beginGuardWallDrag(guard: 'left' | 'right'): void {
    this.handles.beginWallDrag(guard)
  }

  setGuardJunctionOpenings(j: { left: [number, number][]; right: [number, number][] } | null): void {
    this.handles.setJunctionOpenings(j)
  }

  pickResizeHandle(clientX: number, clientY: number): ResizeHandle | null {
    this.setPointerRay(clientX, clientY)
    return this.handles.pick(this.raycaster)
  }

  setResizeHighlight(handle: ResizeHandle | null): void {
    this.handles.setHighlight(handle)
  }

  beginResizeDrag(handle: ResizeHandle, clientX: number, clientY: number): void {
    this.setPointerRay(clientX, clientY)
    this.handles.beginDrag(handle)
  }

  resizeDragExtent(clientX: number, clientY: number): number | null {
    this.setPointerRay(clientX, clientY)
    return this.handles.dragExtent(this.raycaster.ray, this.screenProjector(clientX, clientY))
  }

  resizeDragPoint(clientX: number, clientY: number): { x: number; z: number } | null {
    this.setPointerRay(clientX, clientY)
    return this.handles.dragPoint(this.raycaster.ray)
  }

  endResizeDrag(): void {
    this.handles.endDrag()
  }

  focusOn(ids: readonly string[], opts?: { instant?: boolean }): void {
    viewCamera.focusOn(this, ids, opts)
  }

  startFollow(ids: readonly string[]): void {
    viewCamera.startFollow(this, ids)
  }

  stopFollow(): void {
    this.nav.followIds = null
    this.nav.followCenter = null
  }

  isFollowing(): boolean {
    return this.nav.followIds !== null
  }

  private updateFollow(): void {
    viewCamera.updateFollow(this)
  }

  snapToAxis(dir: Vector3): void {
    viewCamera.snapToAxis(this, dir)
  }

  private beginOrbit(): void {
    viewCamera.beginOrbit(this)
  }

  private cancelOrbit(): void {
    viewCamera.cancelOrbit(this)
  }

  /** OrbitControls orbit/pan drag began: snapshot the camera for a possible abort */
  private onNavStart = (): void => {
    this.nav.navStartPos.copy(this.camera.position)
    this.nav.navStartTarget.copy(this.controls.target)
    this.nav.navStartProjection = this.snapshotProjection()
    this.nav.orbitPivot = this.pickOrbitPivot()
    this.nav.orbitSnap = null
    this.nav.navigating = true
    this.nav.navCancelled = false
    // a chorded right-click fires pointermove (not pointerdown); watch moves for
    // the right button while a drag is live so the abort takes effect
    this.container.addEventListener('pointermove', this.onNavAbortMove, true)
  }

  private pickOrbitPivot(): Vector3 | null {
    return viewCamera.pickOrbitPivot(this)
  }

  private updateOrbitControls(update: (deltaTime?: number | null) => boolean, deltaTime?: number | null): boolean {
    return viewCamera.updateOrbitControls(this, update, deltaTime)
  }

  /** drag released: clear the navigation snapshot and lift any abort freeze */
  private onNavEnd = (): void => {
    viewCamera.endOrbitSnap(this)
    this.nav.navigating = false
    this.container.removeEventListener('pointermove', this.onNavAbortMove, true)
    if (this.nav.navCancelled) {
      this.nav.navCancelled = false
      this.controls.enabled = true
    }
  }

  private onNavAbortDown = (e: PointerEvent): void => {
    this.nav.navPointer = { id: e.pointerId, type: e.pointerType }
    if (e.button === 2 && this.nav.navigating && !this.nav.navCancelled) {
      this.cancelNavigation()
      e.preventDefault()
      e.stopPropagation()
    }
  }

  private onNavAbortMove = (e: PointerEvent): void => {
    this.nav.altHeld = e.altKey // orbit snapping follows Alt pressed or released mid-drag
    if (this.nav.navigating && !this.nav.navCancelled && (e.buttons & 2) !== 0) {
      this.cancelNavigation()
    } else if (this.nav.navigating && e.buttons === 0) {
      this.endLostNavigation()
    }
  }

  /**
   * An orbit or pan drag whose release never arrived (Alt-Tab mid-drag takes the pointerup with it): OrbitControls
   * still holds the pointer, so the camera went on turning as the mouse hovered and the next press was ignored. Hand
   * it the release it missed, on the document where it listens. Its end event then runs onNavEnd as usual, which
   * also re-enables the controls after a right-click cancel. The camera stays where the drag left it.
   */
  private endLostNavigation(): void {
    const p = this.nav.navPointer
    if (!p) return
    this.renderer.domElement.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { pointerId: p.id, pointerType: p.type, bubbles: true }))
  }

  private onNavAbortKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.nav.navigating && !this.nav.navCancelled) {
      this.cancelNavigation()
      e.preventDefault()
      e.stopPropagation()
    }
  }

  private cancelNavigation(): void {
    viewCamera.cancelNavigation(this)
  }

  private panBy(dxPx: number, dyPx: number): void {
    viewCamera.panBy(this, dxPx, dyPx)
  }

  private orbitBy(dxPx: number, dyPx: number): void {
    viewCamera.orbitBy(this, dxPx, dyPx)
  }

  isNavigating(): boolean {
    return this.freelook.active || this.pilot.active
  }

  /**
   * Wheel over the canvas: zoom toward what is under the cursor (wheelZoom.ts). The editor's own
   * wheel use (turning a part being placed) stops the event at the container before it gets here;
   * freelook takes the wheel for fly speed, and orbit controls are disabled during a cancelled drag.
   */
  private readonly onZoomWheel = (e: WheelEvent): void => {
    if (!this.controls.enabled || this.isNavigating() || this.xr?.presenting === true) return
    e.preventDefault()
    // invert never applies to a pinch: a ctrlKey wheel is one (wheelZoom.ts), and spreading two fingers
    // means "closer" whatever the wheel does. A real Ctrl+wheel deliberately goes the default way too,
    // because guessing pinch from the delta's size is wrong on smooth-scrolling mice
    const amount = activeNav().invertZoom && !e.ctrlKey ? -wheelZoomLog(e) : wheelZoomLog(e)
    if (amount === 0) return
    this.nav.focusAnim = null // the wheel takes over from an F-focus ease in flight
    this.zoomPivotAt(e.clientX, e.clientY)
    this.nav.zoomPending += amount
  }

  private zoomPivotAt(clientX: number, clientY: number): void {
    viewCamera.zoomPivotAt(this, clientX, clientY)
  }

  private stepWheelZoom(dt: number): void {
    viewCamera.stepWheelZoom(this, dt)
  }

  zoomWheel(e: WheelEvent): void {
    this.onZoomWheel(e)
  }

  pointerDownThrough(e: PointerEvent): void {
    // OrbitControls and freelook listen on the canvas and capture the pointer there, so the rest of the
    // drag reaches them even though the press began on a chip. The event's own fields are its init dict.
    this.renderer.domElement.dispatchEvent(new PointerEvent(e.type, e))
  }

  cameraPose(): { px: number; py: number; pz: number; tx: number; ty: number; tz: number } {
    const p = this.camera.position
    const t = this.controls.target
    return { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z }
  }

  lookPose(): { px: number; py: number; pz: number; tx: number; ty: number; tz: number } {
    return viewCamera.lookPose(this, this.isNavigating())
  }

  private trackCameraSettle(): void {
    viewCamera.trackCameraSettle(this)
  }

  /** explicit (toolbar / O key) projection switch - sticky, unlike axis-snap auto-ortho */
  setProjection(mode: ProjectionMode): void {
    // no-op when already in `mode`, so the store→view echo of a view-initiated change
    // (axis-snap auto-ortho) can't demote it to a sticky explicit ortho
    if (mode === this.camera.projectionMode) return
    this.applyProjection(mode, false)
  }

  projectionMode(): ProjectionMode {
    return this.camera.projectionMode
  }

  projectionAuto(): boolean {
    return this.nav.orthoAuto
  }

  /** see IRenderView.loadProjection: applyProjection re-seats orthoAuto + orthoRefQuat even when the mode is unchanged */
  loadProjection(mode: ProjectionMode, auto: boolean): void {
    this.applyProjection(mode, auto)
  }

  applyProjection(mode: ProjectionMode, auto: boolean): void {
    viewCamera.applyProjection(this, mode, auto)
  }

  private snapshotProjection(): { mode: ProjectionMode; auto: boolean } {
    return viewCamera.snapshotProjection(this)
  }

  private syncProjection(): void {
    viewCamera.syncProjection(this)
  }

  vrSupported(): Promise<boolean> {
    return this.xr ? this.xr.supported() : Promise.resolve(false)
  }

  /**
   * VR is walk mode in a headset (xr.ts): once the session presents, the pilot walks the floor rig
   * the camera rides. The editor enters walk mode on `onChange(true)` (setPilotActive then spawns on
   * the floor under the editor camera); a walk already under way just carries on, in the headset.
   */
  enterVR(onChange?: (presenting: boolean) => void): Promise<boolean> {
    const xr = this.xr
    if (!xr) return Promise.resolve(false)
    this.applyProjection('perspective', false) // a headset's projection is inherently perspective
    this.walk.vrTarget = this.controls.target.clone()
    return xr
      .enter((presenting) => {
        this.pilot.setHeadset(presenting ? xr.rig : null)
        onChange?.(presenting)
        if (!presenting) this.walk.vrTarget = null
      })
      .then((ok) => {
        if (!ok) this.walk.vrTarget = null
        return ok
      })
  }

  exitVR(): void {
    this.xr?.exit()
  }

  isVRPresenting(): boolean {
    return this.xr?.presenting === true
  }

  setCameraPose(
    pose: { px: number; py: number; pz: number; tx: number; ty: number; tz: number },
    opts?: { instant?: boolean },
  ): void {
    viewCamera.setCameraPose(this, pose, opts)
  }

  setPilotActive(active: boolean, handlers?: PilotHandlers): void {
    viewPilot.setPilotActive(this, active, handlers)
  }

  pilotPose(): { position: [number, number, number]; yaw: number } | null {
    return this.pilot.active ? this.pilot.pose : null
  }

  // --- mobile touch controls: the virtual joystick + look pad + buttons feed the pilot here ---
  pilotSetMove(forward: number, strafe: number): void {
    this.pilot.setMoveAxis(forward, strafe)
  }

  pilotLook(dxPx: number, dyPx: number): void {
    this.pilot.applyLook(dxPx, dyPx)
  }

  pilotInteract(): void {
    this.pilot.interact()
  }

  setPilotAvatars(avatars: ReadonlyArray<{ id: number; color: string; position: [number, number, number]; yaw: number }>): void {
    viewPilot.setPilotAvatars(this, avatars)
  }

  pilotLookBox(): BoxPick | null {
    return viewPilot.pilotLookBox(this)
  }

  /** the editor's verdict on the aimed thing (its prompt is non-empty); a headset shows it on the laser */
  setPilotAimLive(live: boolean): void {
    this.walk.pilotAimLive = live
  }

  vrState(): VRState | null {
    const xr = this.xr
    if (!xr?.presenting) return null
    const r = xr.rig
    return { rig: { position: [r.position.x, r.position.y, r.position.z], yaw: r.rotation.y }, laser: xr.laserState() }
  }

  private tickHeadsetWalk(xr: ViewXR, dt: number): void {
    viewPilot.tickHeadsetWalk(this, xr, dt)
  }

  pilotHoldPoint(): { position: [number, number, number]; rotationY: number } | null {
    return this.pilot.active ? this.pilot.holdPoint(PILOT_HOLD_DISTANCE) : null
  }

  setPilotSpeedLimit(limit: number | null): void {
    this.pilot.setSpeedLimit(limit)
  }

  pilotBodyPosition(): [number, number, number] | null {
    return this.pilot.bodyPosition()
  }

  private pilotSurfaceVelocity(object: Object3D, x: number, z: number): { vx: number; vz: number } | null {
    return viewPilot.pilotSurfaceVelocity(this, object, x, z)
  }

  pilotLookParts(): string[] {
    return viewPilot.pilotLookParts(this)
  }

  pilotLookDockLeaf(): { partId: string; leafKey: string } | null {
    return viewPilot.pilotLookDockLeaf(this)
  }

  showRotationFeedback(angleRad: number | null): void {
    this.gizmo.setRotationFeedback(angleRad)
    this.setLabel(angleRad === null ? null : `${((angleRad * 180) / Math.PI).toFixed(1)} deg`)
  }

  private setLabel(text: string | null): void {
    viewOverlays.setLabel(this, text)
  }

  getStats(): RenderStats {
    // WebGL's WebGLInfo.render.calls is per-frame (the outline resets info each frame),
    // so it is the draw count. WebGPU's common Renderer info is different: `calls` is
    // cumulative since app start (would climb forever); `frameCalls` counts render-pass
    // invocations of the current frame (our layered pipeline = ~7, not draw calls); and
    // `drawCalls` is the real per-frame draw count. We reset info once per frame ourselves
    // (outlineNode), so prefer WebGPU's `drawCalls`, else fall back to WebGL's `calls`.
    const info = this.renderer.info.render as { calls: number; triangles: number; drawCalls?: number }
    const backend = this.renderer instanceof WebGLRenderer ? 'WebGL' : 'WebGPU'
    return {
      drawCalls: info.drawCalls ?? info.calls,
      drawPath: this.drawPath,
      triangles: info.triangles,
      cpuMs: this.cpuMsEma,
      cpuTotalMs: this.cpuMsTotal,
      frames: this.framesTotal,
      // null until a frame has been resolved, so the overlay never shows a misleading 0.00
      gpuMs: this.frameMeter.gpu.frames > 0 ? this.frameMeter.gpu.ema : null,
      gpuTotalMs: this.frameMeter.gpu.frames > 0 ? this.frameMeter.gpu.totalMs : null,
      gpuFrames: this.frameMeter.gpu.frames,
      refreshMs: this.frameMeter.refresh.intervalMs,
      missedFrames: this.hitchCounter.missed,
      backend,
      matrixLiveParts: this.matrices.matrixLiveParts,
      // residency, not throughput (see RenderStats): both backends keep the same memory tally
      textures: this.renderer.info.memory.textures,
      geometries: this.renderer.info.memory.geometries,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // no frame will ever flush these now; a waiter (the scene-swap cover) must not outlive the view
    for (const resolve of this.warm.revealWaiters) resolve()
    this.warm.revealWaiters = []
    releaseBundleGroup(this.partsGroup) // forget the bundle registration (a remount re-creates it)
    this.xr?.dispose() // ends any live session; its resumeLoop no-ops once disposed
    cancelAnimationFrame(this.rafId)
    this.resizeObserver.disconnect()
    this.walk.dispose() // the peer avatars + their capsule
    this.freelook.dispose()
    this.pilot.dispose()
    window.removeEventListener('keydown', this.onShiftChange)
    window.removeEventListener('keyup', this.onShiftChange)
    window.removeEventListener('blur', this.onWindowBlur)
    this.renderer.domElement.removeEventListener('pointerdown', this.onShiftChange)
    this.renderer.domElement.removeEventListener('wheel', this.onZoomWheel)
    this.controls.removeEventListener('start', this.onNavStart)
    this.controls.removeEventListener('end', this.onNavEnd)
    this.container.removeEventListener('pointerdown', this.onNavAbortDown, true)
    this.container.removeEventListener('pointermove', this.onNavAbortMove, true)
    window.removeEventListener('keydown', this.onNavAbortKey, true)
    this.overlays.dispose() // the DOM labels + the ruler's meshes (the snap flashes are disposed below)
    this.orbitGizmo.dispose()
    this.controls.dispose()
    if (this.backdrop) {
      this.backdrop.visual.dispose()
      this.backdrop = null
    }
    this.outline?.dispose()
    this.instancePool?.dispose()
    this.maskMerge?.dispose()
    this.gizmo.dispose()
    this.handles.dispose()
    this.rigGizmoOverlay.dispose()
    for (const entry of this.entries.values()) {
      entry.visual.dispose()
      if (entry.proxy) disposeCollisionProxy(entry.proxy)
    }
    this.entries.clear()
    for (const flash of this.overlays.flashes) {
      this.scene.remove(flash.mesh)
      flash.material.dispose()
    }
    this.overlays.flashes.length = 0
    this.boxes.dispose()
    this.env.dispose()
    this.renderer.dispose()
    // dispose() frees three's GPU resources but leaves the WebGL context itself alive until
    // GC; across repeated remounts (e.g. dev HMR) those leak and the browser eventually
    // force-loses the oldest → black artifacts. forceContextLoss() releases it immediately.
    if (this.renderer instanceof WebGLRenderer) this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  /**
   * Sensor-beam cargo probe (passed to each sensor visual's probeTick): nearest
   * box/pallet along the ray, with the hit body's tint. While the sim runs, the
   * answer is the worker's own beam cast carried in the frame (frame.beamHits,
   * the same query that fed ctx.sense, so the drawn beam can never disagree with
   * the tag the PLC read). Stopped, it runs the sim's rayObb slab test against
   * the idle authored-cargo frame (castBeamFrame), so beams see exactly the cargo
   * the batch renders. It re-runs only when the scene changes (see the probe gate
   * in tickBody). Returns a reused object, consumed synchronously by the caller.
   */
  private readonly probeBeam = (origin: Vector3, dir: Vector3, maxDist: number, linkName: string): { distance: number; color: Color } | null => {
    if (this.running && this.simHasFrame) {
      const h = this.lastBeamHits?.[this.probePartId]?.[linkName]
      if (!h || !h.hit || h.distance > maxDist) return null
      this.beamHit.distance = h.distance
      this.beamHit.color.setRGB(h.color[0]!, h.color[1]!, h.color[2]!, SRGBColorSpace)
      return this.beamHit
    }
    this.probeCasts?.push(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist)
    const frame = this.idleCargoFrame
    if (!frame || frame.count === 0) return null
    this.beamOriginArr[0] = origin.x
    this.beamOriginArr[1] = origin.y
    this.beamOriginArr[2] = origin.z
    this.beamDirArr[0] = dir.x
    this.beamDirArr[1] = dir.y
    this.beamDirArr[2] = dir.z
    const hit = castBeamFrame(this.beamOriginArr, this.beamDirArr, maxDist, frame)
    if (!hit) return null
    const c3 = hit.index * 3
    this.beamHit.distance = hit.distance
    this.beamHit.color.setRGB(frame.colors[c3]!, frame.colors[c3 + 1]!, frame.colors[c3 + 2]!, SRGBColorSpace)
    return this.beamHit
  }

  private readonly loop = (now: number): void => {
    this.rafId = requestAnimationFrame(this.loop)
    this.tick(now)
  }

  /** one view frame: sim tick, part visuals, camera, render. Driven by the rAF loop
   *  above normally, or by the XR session's animation loop while VR presents. */
  private readonly tick = (now: number): void => {
    const synthetic = this.lastTime === null // first frame / resetFrameClock: dt is a placeholder, not a real interval
    const dt = this.lastTime === null ? 1 / 60 : Math.min((now - this.lastTime) / 1000, 0.1)
    if (!synthetic) {
      this.hitchCounter.push(dt)
      this.frameMeter.refresh.push(now - this.lastTime!)
    }
    this.lastTime = now
    const cpuStart = performance.now()
    this.tickBody(dt)
    const cpuMs = performance.now() - cpuStart
    this.cpuMsEma = this.cpuMsEma === 0 ? cpuMs : this.cpuMsEma + 0.1 * (cpuMs - this.cpuMsEma)
    this.cpuMsTotal += cpuMs
    this.framesTotal++
    // GPU frame time (WebGPU only): the backend wrote per-pass timestamps this frame (trackTimestamp,
    // createRenderer.ts). They resolve a frame or two later in batches, and each resolved frame is counted
    // once (frameMeter.ts says why the resolve's return value isn't used). A device without the
    // timestamp-query feature has no render pool, and WebGL's classic renderer has none at all: the gpu
    // stats stay empty and the overlay shows "-".
    if (!(this.renderer instanceof WebGLRenderer) && !this.disposed) {
      const gpu = this.renderer
      void gpu
        .resolveTimestampsAsync()
        .then(() => {
          const pool = (gpu.backend as unknown as { timestampQueryPool?: { render?: { timestamps?: Map<string, number> } } }).timestampQueryPool?.render
          if (pool?.timestamps) this.frameMeter.gpu.collect(pool.timestamps)
        })
        .catch(() => {})
    }
  }

  private tickBody(dt: number): void {
    this.tickSerial++ // new frame: the pilot crosshair cache (pilotCrosshairHits) re-arms
    // A pending resize is applied here, at the top of the frame that will draw it: before
    // syncProjection (an ortho frustum folds from camera.aspect) and before the render.
    // Held while stagedReveal parks the draw (the canvas is showing the last painted frame
    // and resizing would clear it), so it applies on the first frame that actually paints.
    if (this.pendingResize && !this.warm.stagedReveal) {
      this.pendingResize = false
      this.applyResize()
    }
    this.onFrame?.(dt)
    this.adaptive?.tick(dt) // dynamic resolution (gated by ?drs); no-op otherwise
    // in VR the headset owns the camera (WebXRManager writes its pose each frame);
    // the desktop camera drivers would fight it. The walk still runs: it moves the rig, not the camera
    const xr = this.xr
    const inXR = xr?.presenting === true
    if (xr && inXR) {
      if (this.pilot.active) this.tickHeadsetWalk(xr, dt)
    } else {
      this.updateFocus(dt)
      if (this.pilot.active) this.pilot.update(dt)
      else if (this.freelook.active) this.freelook.update(dt)
      // suspended during an ortho RMB pan (freelook.isPanning), like a flight: update()
      // would apply any leftover damped orbit delta + lookAt mid-gesture, rotating the
      // rig underneath the pure translation the pan is applying
      else if (!this.freelook.isPanning) {
        this.stepWheelZoom(dt)
        this.controls.update()
      }
    }
    // "running" to a part means the sim is actually producing output, not merely requested: the
    // authored cargo mesh hides only once a live body exists to replace it (no one-frame blink)
    const simActive = this.running && this.simHasFrame
    // How much to advance the sim-slaved view animations (belt/roller/chain scroll, lamp squash): the
    // delta of the worker's sim clock since the last tick, not this render frame's wall-clock dt. A
    // paused worker stops sending frames, so simTime freezes and this delta is 0. The belt/rollers
    // then freeze exactly like the PLC scan + turntable slew, which slave to the same clock (see
    // EditorController.simFrameDelta / docs/sim-clock.md). It also includes timeScale already (the
    // worker scaled its stepping), and on a backgrounded tab (auto-paused) it can't accumulate a
    // huge dt and jump on refocus. Stopped, it falls back to wall-clock dt so a Stop-relax (lamp
    // squash easing to 0) still plays; those ticks early-out on !simActive anyway.
    let animDt = dt
    if (simActive) {
      const prev = this.animSimBaseline
      this.animSimBaseline = this.lastFrameSimTime
      animDt = prev === null ? 0 : Math.max(0, this.lastFrameSimTime - prev)
    } else {
      this.animSimBaseline = null
    }
    // The shared sim-animation clock (animClock.ts): one uniform every shader-integrated animation
    // integrates against (belt-fabric scroll, roller spin), so the whole scene animates off this
    // single advance instead of each part rewriting its own buffer per frame. Advanced only while the
    // sim runs (and on sim time, like the slaved animations above), and before the part ticks so
    // every consumer's rebase sees a clock wrap in the frame it happens.
    if (simActive) advanceAnimClock(animDt)
    // Sensor-beam probe gate: while the sim runs, cargo moves every tick so probes run every frame
    // (they're frame.beamHits lookups; the worker already cast the rays). Stopped, a scene only
    // changes through the sync/package/run seams, which set beamProbeDirty, so idle frames skip
    // the probes entirely and the published guard-hole uniforms persist. (The stopped
    // query is O(cargo) and the exact change signal exists, so gating is cheaper than re-casting every
    // tick.) The simActive edge forces one pass so a run/stop handoff repaints beams against the fresh
    // cargo source.
    // Refresh the registries before the gate is computed (it is O(1) unless something
    // structural changed): a sensor whose rig just attached must be visible to this frame's
    // probeRegistryRev compare, or the gate reads a rev that the rebuild bumps moments later
    // and the pass is skipped with the beam still unpublished.
    this.refreshTickRegistries()
    // A sensor that just became visible again needs a probe, and its reveal is not otherwise a
    // seam. Parts are hidden and re-shown outside the sync/package/run signals: WebGPU's staged
    // compile hides every non-building part for phase 1, and the incremental pipeline warm hides
    // each newly added part until it is warm. A probe that runs in that window bails on `!root.visible`
    // before it can decide the beam should draw, so without this re-arm the beam never appears
    // (the WebGPU-only "mounted sensor has no beam" case). Walking probeTickRefs, not the overlay
    // group, keeps catalog thumbnail rigs, whose beams are never probed, from arming it forever.
    for (const ref of this.registries.probeTickRefs) {
      const obj = ref.entry.visual.object
      if (!obj.visible) this.beamHiddenParts.add(obj)
      else if (this.beamHiddenParts.delete(obj)) this.beamProbeDirty = true
    }
    const probeBeams =
      simActive ||
      this.beamProbeDirty ||
      this.lastProbeSimActive !== simActive ||
      this.probedRegistryRev !== this.registries.probeRegistryRev
    this.lastProbeSimActive = simActive
    // only cargo moved or some sensors were edited (a box or sensor drag): re-probe just the sensors that can have
    // changed (runPartialBeamProbes)
    const probeSomeBeams = !probeBeams && (this.beamCargoDirty || this.beamSensorsDirty.size > 0)
    // Registry loops, not an every-entry sweep: most parts register no per-frame callback, so
    // this costs O(ticking parts) instead of O(all parts) × 3 megamorphic userData reads per
    // frame (refreshTickRegistries). Frozen parts without callbacks get no blanket
    // ensureFreshPose here: updateWorldMatrices re-bakes every frozen entry before the render,
    // and the off-frame matrix readers re-bake at their own read sites (followAnchor,
    // rigLinkGizmo). Only callback owners need fresh matrices this early in the frame.
    // (already refreshed above, before the beam-probe gate; O(1) unless something changed)
    for (const ref of this.registries.tickRefs) {
      // frozen (matrix-static) parts: re-bake if the visual reported a pose mutation before the
      // tick reads its matrices (integer compare, no-op otherwise)
      this.ensureFreshPose(ref.entry)
      // ticks report whether they mutated a material/attribute this frame (belt scroll, roller
      // spin, chain scroll, fabric banks): the activity mark the bundle replay refresh walks
      // instead of the capability bucket. Matrix mutations mark via ensureFreshPose (poseRev).
      if (ref.tick(animDt, simActive) === true) markBundleDirtyPart(ref.entry.part.id)
    }
    // viewTicks (building roof auto-hide) report a mutation the same way. The mark keeps the
    // subtree out of the bundle always-active bucket (classifyBundleObject), and the replay
    // walk consumes marks even on parked frames (bundleReplayRefresh part 1's gate)
    // ...and are told whether a person is holding the camera (pilot walk / VR), in which case the
    // near-wall auto-hide does nothing: walls dissolving as you approach look like a broken building
    // (wallAutoHide.ts). Passed every frame rather than on the mode edge: the pilot spawns at the
    // editor camera's XZ, so runs dropped from an orbit outside the shell must be put back on entry.
    const firstPerson = this.pilot.active || inXR
    for (const ref of this.registries.viewTickRefs) {
      if (ref.viewTick(this.camera, firstPerson) === true) markBundleDirtyPart(ref.entry.part.id)
    }
    // sensor beams probe cargo (a per-tick raycast, gated above)
    if (probeBeams) {
      this.runBeamProbes()
      // this registry generation has now been probed; a rebuild later in the frame bumps past it
      // and re-fires the gate next frame
      this.probedRegistryRev = this.registries.probeRegistryRev
    } else if (probeSomeBeams) {
      this.runPartialBeamProbes()
    }
    // Beams are instances of the scene-level bank, not children of their parts, so hiding a part does
    // not hide its beam. Mirror it every frame, not only on probe frames: parts are hidden
    // and revealed outside any probe seam (WebGPU's staged compile hides them all for phase 1),
    // and a beam hidden in that window would otherwise never come back. Cheap: one flag per beam,
    // and the instance-buffer rewrite runs only when something actually moved/retinted/(un)hid.
    syncSensorBeams()
    // the non-content backdrop building animates (dock doors/fans) like any building, but isn't an
    // entry, so it's ticked here
    if (this.backdropGroup.visible && this.backdrop) {
      const o = this.backdrop.visual.object
      // a door easing reports true; with no part id to mark for the replay refresh, the backdrop re-records
      if ((o.userData.tick as ((dt: number, running: boolean) => boolean | void) | undefined)?.(animDt, simActive) === true) {
        notifyBundleStructureChanged()
      }
      ;(o.userData.viewTick as PartViewTick | undefined)?.(this.camera, firstPerson)
    }
    // the probe pass above consumed this frame's dirtiness; the next stopped re-probe waits for a seam
    if (probeBeams) this.beamProbeDirty = false
    if (probeBeams || probeSomeBeams) {
      this.beamCargoDirty = false
      this.beamSensorsDirty.clear()
    }
    // Moved-stream expiry (poolMovedAt): once every ejected non-drag mover has held still for the
    // quiet period, one rebuild re-pools them all. Wall-clock (not sync-count) so the re-pool
    // can't fire in the middle of a stalled scrub/stream, and it fires without needing another
    // user edit to trigger a rebuild.
    if (this.pool.poolMovedAt.size > 0 && this.instancePool) {
      let newest = 0
      for (const t of this.pool.poolMovedAt.values()) if (t > newest) newest = t
      if (performance.now() - newest > POOL_MOVED_QUIET_MS) {
        this.pool.poolMovedAt.clear()
        this.poolRebuild()
      }
    }
    // frame-budgeted reveal of a bulk duplicate's held clones: a budget's worth becomes visible
    // in this frame's draw (before the matrix walk + render below)
    this.drainRevealQueue()
    this.flushRevealWaiters()
    // after the part ticks: copy any per-instance attribute the ticks wrote (belt fabric scroll)
    // into the pool's merged banks. Version-gated, so an idle scene copies nothing.
    this.instancePool?.syncInstancedAttrs()
    // follow runs after the part ticks so it tracks this frame's positions (a robot/manipulator
    // moved by its tick above), and after controls.update() so it is applied after the damping
    if (!inXR) this.updateFollow()
    this.updateFlashes(dt)
    this.syncProjection()
    this.trackCameraSettle()
    const h = this.container.clientHeight || 1
    this.gizmo.updateScale(this.camera, h)
    this.handles.updateScale(this.camera, h)
    robotGizmoDrag.updateRobotGizmo(this, h)
    this.orbitGizmo.update()
    if (this.overlays.labelText !== null) this.updateDegreeLabel()
    if (this.overlays.rulerEnds) {
      this.scaleRulerEndpoints()
      this.updateRulerLabel()
    }
    // While the deferred parts are still compiling their pipelines (compileStaged phase 2), skip the
    // draw so the frame doesn't force a synchronous on-draw compile (a hitch). The canvas holds the
    // last painted frame (the building shell) until they're warm, then paints them in cleanly.
    if (this.warm.stagedReveal) return
    // rewrite the flow-arrow instance buffers if any arrow shape/pose/visibility moved this
    // frame (syncFlowArrow / the toggle); a parked frame is a boolean check
    this.flowArrowBank.flush()
    // a model that loaded into a cargo shape draws now, though a stopped or paused scene sends no new cargo frame
    this.boxes.refreshLoadedShapes()
    // late-arriving children (GLB links, roller/chain lanes) join the pool once their burst settles
    this.poolRebuildOnStructureSettled()
    // the owned world-matrix walk: after every mutator above, before the bundle patch + render
    this.updateWorldMatrices()
    // palette-merged mask: after the matrix walk (it reads the selected meshes' fresh
    // matrixWorld), before the outline draws it. Re-bakes only when the merged set went stale.
    this.maskMerge?.tick()
    // Which path is this frame's draw count coming from? A replayed frame tallies one draw per
    // bundle execute (~26 on the demo). A frame that re-recorded, or one held unbundled by the
    // live-edit hold, tallies every draw in the list (~620). Same scene, same pixels, 24× apart,
    // so the stats overlay has to say which, or its `draws` number looks like an unexplained spike
    // (e2e/probes/draw-spike-after-cover.mjs). Latched here because the overlay polls on its own
    // 250 ms timer and would otherwise sample the flag between frames.
    //
    // The serial is read before the invalidation flush, not after. flushBundleInvalidation is where
    // a pending record is applied (bundleGroups.ts), so a serial captured after it compares a frame
    // against itself and reports 'replay' for a frame that re-recorded (measured: a "draws 909"
    // with no marker, e2e/probes/stats-rec-marker.mjs).
    const serialBefore = bundleRecordSerial()
    this.syncBundleInvalidation()
    const suppressed = bundleReplaySuppressed()
    this.renderFrame()
    this.drawPath = !bundleGroupsRegistered()
      ? null
      : suppressed || bundleRecordSerial() !== serialBefore
        ? 'record'
        : 'replay'
    // WebGL paints fully on the first draw (synchronous shader compile); tell the
    // loading cover. WebGPU signals from compileAsync in the constructor instead.
    if (!this.painted && this.renderer instanceof WebGLRenderer) {
      this.painted = true
      signalScenePainted()
      // ...and only now schedule the interaction warm: the scene is on screen, so a compile can no
      // longer delay showing it. WebGPU does the same from the end of its staged-compile chain, but
      // that is in a branch the WebGL path never enters, so WebGL needs this call.
      this.scheduleWebGLInteractionWarm()
    }
  }

  private scheduleWebGLInteractionWarm(): void {
    viewWarm.scheduleWebGLInteractionWarm(this)
  }

  /** internal - the per-frame bundle poll's own bookkeeping (viewBundles.ts) */
  readonly bundles = new ViewBundleState()

  private syncBundleInvalidation(): void {
    viewBundles.syncBundleInvalidation(this)
  }

  /**
   * Draw one frame. Both backends run through an outline (set in the constructor): the WebGL
   * path uses ConsolidatedSelectionOutline's EffectComposer, WebGPU the node twin. Each tallies
   * renderer.info per frame for the stats overlay. The `else` is a fallback for when no outline
   * registered (e.g. the WebGPU factory failed to load), drawing the scene straight to the canvas.
   */
  private renderFrame(): void {
    // in VR, render the scene straight through: the composer's screen-quad passes
    // would flatten WebXRManager's per-eye ArrayCamera pass into a mono frame
    if (this.xr?.presenting) {
      this.renderer.render(this.scene, this.camera)
      return
    }
    if (this.outline) this.outline.render()
    else this.renderer.render(this.scene, this.camera)
  }

  private updateDegreeLabel(): void {
    viewOverlays.updateDegreeLabel(this)
  }

  private scaleRulerEndpoints(): void {
    viewOverlays.scaleRulerEndpoints(this)
  }

  private updateRulerLabel(): void {
    viewOverlays.updateRulerLabel(this)
  }

  /** what a middle drag with no modifier does, by the navigation style; OrbitControls swaps it under Shift */
  private plainMiddle(): MOUSE {
    return middleDragAction(false) === 'pan' ? MOUSE.PAN : MOUSE.ROTATE
  }

  private readonly onShiftChange = (e: KeyboardEvent | PointerEvent): void => {
    this.controls.mouseButtons.MIDDLE = this.plainMiddle()
    // the ruler's per-axis components are revealed only while Shift is held; the per-frame
    // updateRulerLabel() reads this so the bracket appears/vanishes live (even mid-measure).
    this.overlays.rulerShift = e.shiftKey
    this.nav.altHeld = e.altKey
  }

  // Alt+Tab away loses Alt's keyup: drop it so the next orbit doesn't snap
  private readonly onWindowBlur = (): void => {
    this.nav.altHeld = false
    if (this.nav.navigating) this.endLostNavigation()
  }

  /** Dynamic-resolution hook: re-point the renderer + composer at a new pixel ratio, clamped to the
   *  device's real DPR, then re-size so the offscreen targets re-allocate at the new resolution */
  private applyPixelRatio(pixelRatio: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatio))
    this.outline?.setPixelRatio?.(this.renderer.getPixelRatio())
    // DRS runs from inside tickBody, ahead of this frame's draw: apply straight away so the
    // frame that asked for the new resolution is the one that renders at it
    this.applyResize()
  }

  /**
   * Re-point the drawing buffer + offscreen targets at the container's current size.
   *
   * Guarded on the rounded size (and pixel ratio) because every setSize below disposes and
   * re-allocates the composer's MSAA colour target, its depth texture and the outline mask:
   * megabytes of GPU allocation, and a driver revalidation of everything that referenced them.
   * A dock drag that moves the gutter by less than a pixel of layout must not trigger that.
   */
  private applyResize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const pixelRatio = this.renderer.getPixelRatio()
    if (w === this.sizedW && h === this.sizedH && pixelRatio === this.sizedPixelRatio) return
    this.sizedW = w
    this.sizedH = h
    this.sizedPixelRatio = pixelRatio
    this.renderer.setSize(w, h)
    this.outline?.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /**
   * ResizeObserver handler: only marks the resize; the next tick applies it.
   *
   * Resizing the drawing buffer blanks it. Calling setSize and re-rendering right here (the
   * observer runs after layout, before paint) would stop a live dock drag flickering the empty
   * buffer, but costs a second full render (layered scene + mask + composite) on every frame
   * of the drag, on top of the loop's own. Deferring puts the
   * setSize and the repaint in the same rAF callback, so no frame can paint a blanked buffer
   * and only one render happens. The downside is that the frame already in flight paints the
   * previous buffer stretched into the new box: one frame, only while actively dragging.
   */
  private resize(): void {
    this.pendingResize = true
  }

  /** internal - for viewport modules: aim `this.raycaster` through a client-pixel cursor position */
  setPointerRay(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
  }

  private updateFocus(dt: number): void {
    viewCamera.updateFocus(this, dt)
  }

  private updateFlashes(dt: number): void {
    viewOverlays.updateFlashes(this, dt)
  }
}
