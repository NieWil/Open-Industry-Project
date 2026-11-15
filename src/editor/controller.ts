import { Vector3 } from 'three'
import type { BoxFrame } from '../core/frame'
import { subscribePartDiagnostics } from '../core/parts/partDiagnostics'
import { getPackage, onPackagesChanged } from '../core/parts/partRegistry'
import type { AuthorableShapeKind } from './rigTree'
import type { RigShape } from '../core/parts/partPackage'
import { IdleUseSession } from '../sim/idlePose'
import type { PartDiagnostic } from '../sim/validatePart'
import { moveViewportState, persistViewportState } from './store/storePrefs'
import { onCurrentDocumentChange, SCENE_SLOT, sceneSlotKey, slotDocumentId } from './project/documentStore'
import type { SnapCandidate, SnapPose } from '../core/snap/snapFeatures'
import type { PartInstance, PartType, SceneJSON } from '../core/types'
import type { DisplayUnits } from '../core/units'
import { sceneDisplayUnits } from '../core/scene/sceneUnits'
import type { BoxPick, IRenderView, ResizeHandle } from '../render/api'
import type { PlcFault, SimClient, StepDone } from '../sim/client'
import type { StepStats } from '../sim/protocol'
import type { ScanTime } from '../sim/plcHost'
import type { ProcessImageSnapshot, TagValue } from '../plc'
import { keepProjectVersion } from './store/storePackages'
// the link's sessions are loaded on use (loadExternalPlc): only what the first frame shows is static
import { desktopAdsHost, desktopEipHost, desktopOpcUaHost, desktopPlcIoHost } from './links/externalPlcStatus'
import type { AdsHost, EipHost, ExternalPlcLink, ExternalPlcStatus, OpcUaHost, PlcIoHost, PlcTagList } from './links/externalPlcStatus'
import { desktopOpcUaServerHost, OPC_UA_SERVER_OFF } from './links/opcUaServer'
import type { OpcUaServerHost, OpcUaServerStatus, PublishedProgram } from './links/opcUaServer'
import { programOutOfDate, type ReloadBlocker } from './program/programReload'
import { coverSceneSwapIfArriving } from './sceneSwapCover'
import type { EditorState, EditorStore, LiveCargoPose, ToolMode, TransformSpace } from './store/store'
// controller/ area modules: each owns its state in an object this class holds (see the class comment)
import * as dragOps from './controller/drag'
import type { Drag } from './controller/drag'
import * as pilotOps from './controller/pilot'
import * as placementOps from './controller/placement'
import * as setpointOps from './controller/setpoints'
import type { LiveSetpoints } from './controller/setpoints'
import * as runOps from './controller/simRun'
import * as programOps from './controller/program'
import { NO_PROGRAM } from './controller/program'
import type { PlcFaults, ProgramStatus } from './controller/program'
import * as linkOps from './controller/plcLinks'
import * as authoringOps from './controller/partAuthoring'
import * as cameraOps from './controller/camera'
import * as viewSceneOps from './controller/viewScene'
import * as useOps from './controller/useSessions'
import * as presenceOps from './controller/dragPresence'
import * as gizmoOps from './controller/gizmo'
import { IS_COARSE_POINTER } from './controller/gizmo'
import * as cargoOps from './controller/liveCargo'
import * as snapOps from './controller/snapRest'
import * as repositionOps from './controller/reposition'
import * as vertexSnapOps from './controller/vertexSnap'
import * as pointerOps from './controller/pointer'
import * as keyboardOps from './controller/keyboard'
import * as catalogOps from './controller/catalogPlace'
import { LiveView } from './controller/liveView'
import { selectionSet } from './store/selectionSet'

/** {@link EditorController.plcAliases} with no program attached */
const NO_PLC_ALIASES: ReadonlyMap<string, string> = new Map()

export type { PlcFaults, ProgramStatus }

// a running cargo body's live pose. Declared in the store (its other consumer: a copy gesture rebases
// onto it - see LiveCargoHost) and re-exported here for the controller/ modules that read it.
export type { LiveCargoPose }

// The `Drag` discriminated union and the per-kind begin/move/commit handlers live in
// ./controller/drag.ts; the placement-staging session (and `PlacingPreview`) in
// ./controller/placement.ts; pilot mode in ./controller/pilot.ts. The other subsystems (Play / Stop, the PLC
// program and links, part authoring, camera, view scenes, Use sessions, gizmo, live cargo, snapping, reposition, vertex
// snap, pointer / keyboard input, catalog placement) live in ./controller/ too, one module each; the methods
// here that delegate to them keep the public API. An area with state of its own keeps it in an object defined
// in its module and held here (the walk overlays, camera, placement, catalog press, reposition, pointer press,
// pilot, program, PLC links, Use sessions, live snap, drag presence). What several areas share stays on this
// class: the store / view / sim, the drag in flight, the pointer, the latest frame, live and run-scoped cargo,
// the vertex-snap arm, the face-snap axis, and the store-sync `prev*` bookkeeping of onStoreChange.

export class EditorController {
  // Each area under ./controller/ owns its state in an object held here (WalkOverlays, CameraState, PlacementState,
  // ProgramState, PlcLinkState, ...) and takes only the narrow slice of this controller it needs (a `Pick<>` of
  // it). Members marked "internal" are public only because such a slice names them: they are not API.
  boxCount = 0

  /** the sim worker's cumulative step-cost counters for the current run (null until its first
   *  frame) - the stats overlay window-diffs two reads for its `phys` line */
  get stepStats(): StepStats | null {
    return this.sim.stepStats
  }

  readonly store: EditorStore
  readonly view: IRenderView
  readonly sim: SimClient
  /** internal - for controller/ modules */
  readonly container: HTMLElement
  private readonly unsubscribe: () => void
  private unsubscribeDocument: () => void = () => {}
  /** file the camera on screen under the slot it belongs to (pagehide: a project switch reloads the page) */
  private readonly flushCamera = (): void => {
    if (!this.camera.key || this.store.getState().focusedPartId !== null) return
    persistViewportState(this.camera.key, { pose: this.view.cameraPose(), projection: this.view.projectionMode(), auto: this.view.projectionAuto() })
  }
  // author mode: re-apply placed visuals when a part package's geometry changes in the registry (live edit / hot-reload)
  private unsubscribePackages: () => void = () => {}
  private readonly unsubscribeDiagnostics: () => void
  /** internal - for controller/ modules */
  drag: Drag | null = null
  /** the live snap of the gesture in flight (controller/snapRest.ts LiveSnapState); e2e scripts read `snap.candidate`
   *  at runtime */
  private readonly snap: snapOps.LiveSnapState = snapOps.createLiveSnapState()
  // vertex snap: non-null while the
  // hold-key is down. `source` is the world-space vertex under the cursor the next
  // drag will grab (null when no vertex is near). The actual drag lives in `this.drag`
  // (kind 'vertexSnap') so RMB/Esc cancel + commit flow through the shared drag paths.
  // internal - for controller/ modules
  vsnap: { source: Vector3 | null } | null = null
  private prevMode: EditorState['mode']
  private prevRunning: boolean
  private prevScene: SceneJSON
  // store.sceneLoads at the last store change: a move is a wholesale scene load (the swap cover's cue)
  private prevSceneLoads: number
  private prevWalkDoors: EditorState['walkDoors'] = null
  // the walk session's view overlays (dock doors, pulled flexes) and the flex sim-push throttle (controller/viewScene.ts)
  private readonly walk = new viewSceneOps.WalkOverlays()
  private prevWalkFlex: EditorState['walkFlex'] = null
  private prevTool: ToolMode
  private prevTrackball: boolean
  private prevSpace: TransformSpace
  // the camera's bookkeeping: its slot, the Focus (F) press run, the part-focus return pose, the mirrored
  // projection (controller/camera.ts)
  private readonly camera = new cameraOps.CameraState()
  // part-scene focus ("open scene"): the part currently isolated in the viewport, or null
  private prevFocus: string | null = null
  // whether the view was last told to hold departing parts (a definition session open; onStoreChange)
  private prevHolding = false
  private prevFlowArrows: boolean
  private prevShowGrid: boolean
  private prevDisplayUnits: DisplayUnits
  private prevDemoSession: boolean
  // a finished ruler measurement stays drawn until cleared (tool switch / Esc / fresh click)
  rulerVisible = false
  /** the placement in progress: staging session, preview, custom part, wheel yaw (controller/placement.ts)
   *  (internal - for controller/ modules) */
  readonly placement = new placementOps.PlacementState()
  /** placing-session key at the last store sync (`type:packageId`, null when not placing) - a change re-arms the session */
  private prevPlacingKey: string | null = null
  /** last scene pushed into the running sim via the live-edit stream: per-move placement transients
   *  all share one base scene (the sim never sees the staged preview), so they dedupe to no pushes */
  private prevSimScene: SceneJSON | null = null
  // a press-drag from a catalog card in flight (controller/catalogPlace.ts CatalogPress)
  private readonly catalogPress = new catalogOps.CatalogPress()
  // the Shift+G collision reposition in flight, its wheel yaw and face-alignment flag (controller/reposition.ts)
  private readonly repo = new repositionOps.RepositionState()
  // Alt face snap (surface alignment), shared by the Shift+G reposition and catalog
  // placement: the axis (0..5 = +X+Y+Z−X−Y−Z) that turns toward the surface normal (whether alignment is
  // currently applied in a reposition is the reposition's own state: RepositionState.alignApplied).
  // internal - for controller/ modules
  surfaceAlignAxis = 1
  /** internal - for controller/ modules */
  lastPointer: { x: number; y: number } | null = null
  // the pointer's memory between events: a pending touch tap, the last press (controller/pointer.ts PointerPress)
  private readonly press = new pointerOps.PointerPress()
  // live poses of the selected cargo boxes/pallets, keyed by part id and refreshed each sim
  // frame so their gizmo follows the moving bodies (empty when no live cargo is selected).
  // Rotation is the body quat decomposed to the part's YXZ fields so a drag starts from the real
  // orientation (dragStartScene): a tumbled box rotates from its tumble, not upright.
  // Holds the whole selection, not just a single box: a rubber band over a running line selects
  // many, and averaging their authored spawn poses would anchor the gizmo where the group started
  // (and a drag from that basis would teleport every box back there before applying the delta).
  // internal - for controller/ modules
  readonly liveCargo = new Map<string, LiveCargoPose>()
  // walk mode: the carried cargo, the held flex conveyor and the "In auto" memo (controller/pilot.ts)
  // internal - for controller/ modules (simRun drops the carry at Stop)
  readonly pilot = new pilotOps.PilotState()
  // ids of run-scoped cargo: boxes promoted from transient spawner bodies during this run (selectBox /
  // pilot carry) plus cargo dropped from the catalog while running (a product injected into the live line,
  // see placePart). All are live sim content, not the authored design, so Stop removes them. Otherwise a
  // selected/followed spawner box or a mid-run drop would leave a frozen box behind on Stop.
  // internal - for controller/ modules
  readonly runPromotedBoxes = new Set<string>()
  // cargo parts frozen in place by the Use key (C) while the sim runs - kinematic until used again,
  // picked up by the pilot, or the run ends. A live-sim action like the gizmo-grab freeze, never a
  // design edit; cleared on both run edges (fresh bodies always spawn dynamic).
  // internal - for controller/ modules
  readonly frozenCargo = new Set<string>()
  // latest sim frame (live-box/pilot tracking, lamp/pose overlays)
  lastFrame: BoxFrame | null = null
  // the attached ST program: what is attached and running, its status and faults, who it drives (controller/program.ts)
  private readonly program = new programOps.ProgramState()
  /** The socket an external PLC connects through: the desktop shell's, or null in a browser tab (where the
   *  mode is not offered). Public so a test can hand in its own. */
  plcIoHost: PlcIoHost | null = desktopPlcIoHost()
  /** The desktop shell's OPC UA client, or null in a browser tab. Public for the same reason. */
  opcUaHost: OpcUaHost | null = desktopOpcUaHost()
  /** The desktop shell's EtherNet/IP client (libplctag), or null in a browser tab. Public for the same reason. */
  eipHost: EipHost | null = desktopEipHost()
  /** The desktop shell's ADS client (TwinCAT's TcAdsDll), or null in a browser tab. */
  adsHost: AdsHost | null = desktopAdsHost()
  // the links to PLCs outside the app: the external-PLC link's module, session and status, its tag browse, and
  // the simulated PLC's OPC UA server (controller/plcLinks.ts)
  private readonly links = new linkOps.PlcLinkState()
  // which Play this is: an attach that waited on that module must not attach to (or release) a later run's world
  // (internal - for controller/ modules)
  runSerial = 0
  /** The desktop shell's OPC UA server, or null in a browser tab. Public so a test can hand in its own. */
  opcUaServerHost: OpcUaServerHost | null = desktopOpcUaServerHost()
  // the static idle actuation preview's memo and the devices a stopped-scene Use is operating (controller/useSessions.ts)
  private readonly uses = new useOps.UseSessions()
  private readonly live = new LiveView(this) // following another connection's shared run (controller/liveView.ts)

  constructor(store: EditorStore, view: IRenderView, sim: SimClient, container: HTMLElement) {
    this.store = store
    this.uses.publishedUsedIds = store.getState().usedIds // the store's own empty list is not a change to act on
    this.uses.publishedJoggedIds = store.getState().joggedIds
    this.view = view
    this.sim = sim
    this.container = container

    container.addEventListener('pointerdown', this.onPointerDown)
    container.addEventListener('contextmenu', this.onContextMenu)
    container.addEventListener('pointermove', this.onPointerMove)
    container.addEventListener('pointerup', this.onPointerUp)
    container.addEventListener('pointercancel', this.onPointerCancel)
    // capture phase + non-passive so a placement/reposition wheel-rotate can
    // stop the event before the view reads it as zoom (see onWheel)
    container.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('blur', this.onWindowBlur)

    sim.onFrame = (frame) => {
      this.lastFrame = frame
      // an external PLC exchanges its I/O once per frame, like a fieldbus (editor/links/externalPlc.ts), and so does
      // each named controller's (controller/plcLinks.ts)
      linkOps.exchangeFrame(this.links, this.sim, frame.tags)
      // the simulated PLC's OPC UA servers read the program's variables as the watch table does
      this.updateUaServers(this.plcWatch, this.program.plcAttached)
      this.view.applyBoxFrame(frame)
      this.live.share(frame)
      this.boxCount = frame.count
      this.trackSelectedBox(frame)
      pilotOps.pilotFrameTick(this.pilot, this, frame)
      // surface a fast-forward this machine can't actually hold (null = keeping up). Deduped in
      // the store, so this is a compare per frame - see sim/simClockRate.ts.
      this.store.setSpeedActual(sim.clock.shortfall)
    }
    sim.onError = (message) => {
      this.stop()
      if (typeof alert === 'function') alert(`Simulation error: ${message}`)
    }
    // The worker sent no frame for seconds and was ended (sim/client.ts watchdog): part code stuck where the loop
    // budget cannot stop it. The run is over; the next Play starts a fresh worker.
    sim.onHang = (part) => {
      this.stop()
      if (typeof alert === 'function') {
        alert(
          part
            ? `The simulation stopped responding while running the part ${part}, and was stopped. That part's code may never finish: check it, or remove it and run again.`
            : 'The simulation stopped responding and was stopped.',
        )
      }
    }
    // The attached program faulted in the worker (a runtime scan fault - division by zero, array
    // bounds, a loop cap; a compile failure is a backstop, the source was validated here first).
    // The worker already dropped it to STOP; mirror the detach and put the positioned message on
    // the program panel's status channel (stopProgram resets the status, so the fault is set after).
    sim.onPlcFault = (f) => {
      console.error('PLC scan fault - stopping the program:', f.message)
      const source = this.program.runningSource ?? '' // stopProgram forgets it
      this.stopProgram()
      this.program.fault = { ...f, source }
      // before the status goes out: the panel reads `plcFaults` from its status listener, and nothing polls afterwards.
      const what = 'runtime fault'
      this.program.lastFault = { message: `${what}: ${f.message}`, ...(f.line !== undefined ? { line: f.line, col: f.col ?? 1, ...(f.offset !== undefined ? { offset: f.offset } : {}) } : {}) }
      this.setProgramStatus({
        ...NO_PROGRAM,
        error: f.line !== undefined ? `${what}: ${f.message} (line ${f.line}, col ${f.col})` : `${what}: ${f.message}`,
      })
    }
    // Custom-part runtime diagnostics (core/parts/partDiagnostics): a throwing step()/geometry(), a compile
    // failure at attach, an unknown commanded joint/lamp. One console line per unique problem (deduped
    // at the source - a per-tick repeat can't spam); the Inspector shows them on the selected part.
    this.unsubscribeDiagnostics = subscribePartDiagnostics((e) => {
      if (e.kind !== 'report') return
      const d = e.entry
      console.warn(`[part${d.partId ? ` ${d.partId}` : ''}${d.packageId ? ` (${d.packageId})` : ''}] ${d.source}: ${d.message}`)
    })

    const s = store.getState()
    this.prevMode = s.mode
    this.prevRunning = s.running
    this.prevScene = s.scene
    this.prevTool = s.tool
    this.prevTrackball = s.trackball
    this.prevSpace = s.space
    this.prevFlowArrows = s.flowArrows
    this.prevShowGrid = s.showGrid
    this.prevDisplayUnits = sceneDisplayUnits(s.scene)
    this.camera.projection = s.projection
    this.prevSceneLoads = store.sceneLoads
    view.syncScene(s.scene)
    view.setSelection(s.selectedIds)
    view.setRunning(s.running)
    view.setFlowArrowsVisible(s.flowArrows)
    view.setGridVisible(s.showGrid)
    view.setDisplayUnits(sceneDisplayUnits(s.scene))
    view.setProjection(s.projection)

    // Put the camera back where this scene was left (workspace state, like the dock sizes), falling
    // back to the scene's opening view the first time it is seen. Set instantly, not eased: nobody is
    // watching the camera travel to an opening frame, and a cold load can stretch the 0.25 s ease over
    // seconds of wall clock and stop part-way (see IRenderView.setCameraPose).
    this.prevDemoSession = store.demoSession
    this.restoreCamera()
    // and remember it again whenever it comes to rest. One write per gesture, not per frame.
    view.onCameraSettled = (pose, projection) => {
      // Not while a sub-scope owns the viewport. Part focus, master edit and package edit all frame
      // one part close up (all three set focusedPartId), and none of them survives a reload - the
      // main scene's camera is preFocusPose, restored on the way out. Recording the close-up would
      // reopen the whole factory at it.
      if (this.store.getState().focusedPartId !== null) return
      persistViewportState(this.viewportKey(), { pose, projection, auto: this.view.projectionAuto() })
    }
    // the view switches projection on its own too (axis-snap auto-ortho, orbiting off-axis,
    // pilot/VR forcing perspective) - mirror those into the store so the toolbar
    // toggle stays truthful. camera.projection is settled first: setProjection re-enters
    // onStoreChange synchronously, and the stale prev would bounce the mode back at the view.
    view.onProjectionChanged = (mode) => {
      this.camera.projection = mode
      this.store.setProjection(mode)
    }
    // ...and on the way out of the page. Opening another project reloads, and a camera is otherwise filed only when
    // it comes to rest after a move: a projection toggle (no move) or an orbit in the last ~400 ms before the switch
    // would be lost. Filed under the slot it was restored into (camera.key), never viewportKey(): by unload the
    // document pointer may already name the incoming project.
    window.addEventListener('pagehide', this.flushCamera)
    this.pushGizmo(s)
    this.pushResizeHandles(s)
    this.pushRobotGizmo(s)
    // subscribeView (not subscribe): the controller must see every transient drag/motion
    // update to keep the viewport + gizmo on the moving part, even though React skips them
    this.unsubscribe = store.subscribeView(this.onStoreChange)
    // The open document can take a new id without a reload: a linked folder opened in place, or the first id
    // minted for the document on screen. Nothing moved the camera, so it stays - but it now belongs to the new
    // document's slot, and is filed there at once, the way the demo fork hands over. Deferred a microtask: the
    // id moves before the incoming project is applied, and the key has to name the scene that ends up on screen.
    this.unsubscribeDocument = onCurrentDocumentChange(() =>
      queueMicrotask(() => {
        if (this.store.demoSession) return // '@demo' belongs to no document
        // The document's first id (the key had no document in it yet): what it saved under bare scene ids
        // until now is its own (a first visit's demo fork frames its scene before the library has minted
        // an id), so it moves with it, and cannot be taken by the next project that asks for a scene-1.
        if (!this.camera.key.startsWith('@') && slotDocumentId(this.camera.key) === null) moveViewportState(SCENE_SLOT, sceneSlotKey(SCENE_SLOT))
        this.camera.key = this.viewportKey()
        if (this.store.getState().focusedPartId !== null) return
        persistViewportState(this.camera.key, { pose: this.view.cameraPose(), projection: this.view.projectionMode(), auto: this.view.projectionAuto() })
      }),
    )
    // the store's live-cargo seam: copying a part (duplicate / copy) must read a running box's live
    // pose, and cargo minted mid-run is run-scoped. Only the controller knows either. See LiveCargoHost.
    store.setLiveCargoHost({
      pose: (id) => this.liveCargoPose(id),
      runScoped: (ids) => {
        for (const id of ids) this.runPromotedBoxes.add(id)
      },
      runScopedIds: () => this.runPromotedBoxes,
    })
    // a geometry edit (author mode), dev part hot-reload, or desktop reload re-registers the package: rebuild its
    // render instances, and - if the sim is running - live-swap it into the world too (else the worker keeps the
    // old behaviour/geometry until the next Run).
    this.unsubscribePackages = onPackagesChanged((id) => {
      this.view.refreshPackage(id)
      this.reloadSimPackage(id)
      // refreshPackage rebuilt this package's rig instances back to rest - re-pose the idle actuation preview
      // (a package edit can also change the behavior, so forget every cached key and re-settle from scratch).
      this.uses.idlePoseKeys.clear()
      this.dropUseSessions() // a device being operated runs the old behavior: back to the (new) design
      this.refreshIdlePoses(this.editTargetViewScene(this.store.getState()))
    })
    // initial idle actuation preview for a stopped scene loaded at startup (devices show their authored state)
    this.refreshIdlePoses(this.editTargetViewScene(s))
    // a SCADA may be waiting for the simulated PLC's OPC UA server from the moment the app opens
    this.syncOpcUaServer()
    // a scene that runs on an external PLC: have the link's code in hand before Play needs it
    if (this.externalPlcAvailable && linkOps.anyLinkOn(s.externalPlc)) void linkOps.loadExternalPlc(this.links).catch(() => {})
  }

  run(): void {
    runOps.run(this)
  }

  startExternalPlc(): boolean {
    return linkOps.startExternalPlc(this.links, this.program, this)
  }

  /** Whether this surface can serve an external PLC at all (the desktop app can; a browser tab cannot). */
  get externalPlcAvailable(): boolean {
    return this.plcIoHost !== null
  }

  /**
   * The PLC's tag names, for the tag picker, or null when none have been read. Over OPC UA from the last browse of
   * a run's link (kept after Stop) or of {@link readPlcTags}; over ADS and EtherNet/IP from {@link readPlcTags} alone. Its `protocol`
   * and `endpoint` say which PLC: a caller compares them to the settings, since the link may have changed since. Changes notify through {@link onExternalPlcStatus}.
   */
  get plcTagList(): Readonly<PlcTagList> | null {
    return this.links.plcTags
  }

  /** Whether the tag picker can read the default controller's PLC's tags: the desktop app can, over OPC UA, ADS or EtherNet/IP. */
  get plcTagsAvailable(): boolean {
    const mode = this.store.getState().externalPlc.mode
    return mode === 'opcua' ? this.opcUaHost !== null : mode === 'ads' ? !!this.adsHost?.symbols : mode === 'eip' ? !!this.eipHost?.tags : false
  }

  /**
   * Read the default controller's PLC's tag names now, over OPC UA, ADS or EtherNet/IP, for the tag picker. While a run holds the
   * link this does nothing: an OPC UA run's own browse is the fresher answer, and it goes into {@link plcTagList} by itself.
   */
  readPlcTags(): void {
    linkOps.readPlcTags(this.links, this)
  }

  /** A running cargo part's position in the latest sim frame, or null (stopped, or not a body the sim moves). */
  livePosition(partId: string): [number, number, number] | null {
    const f = this.lastFrame
    const i = f ? f.partIds.indexOf(partId) : -1
    if (!f || i < 0) return null
    return [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!]
  }

  /** The external-PLC link's state, for the toolbar's link status and Controller Properties. */
  get externalPlcStatus(): Readonly<ExternalPlcStatus> {
    return this.links.externalSession ? this.links.externalSession.status() : this.links.externalStatus
  }

  /**
   * A named controller's link state (`Cell2::...` tags, core/io/controllerTag.ts), for Controller Properties and the
   * toolbar's link status: its run's, or its last one, kept after Stop. Changes notify through {@link onExternalPlcStatus}.
   */
  namedPlcStatus(name: string): Readonly<ExternalPlcStatus> {
    return linkOps.namedStatus(this.links, name)
  }

  /** Subscribe to external-PLC status changes (listening, a master connecting, a failure); returns an unsubscribe. */
  onExternalPlcStatus(cb: () => void): () => void {
    this.links.watchers.add(cb)
    return () => this.links.watchers.delete(cb)
  }

  /** the external-PLC link of the current run, or null (internal - for controller/program.ts: it owns the I/O) */
  get externalSession(): ExternalPlcLink | null {
    return this.links.externalSession
  }

  /** The simulated PLC's OPC UA server's state, for Controller Properties. */
  get opcUaServerStatus(): Readonly<OpcUaServerStatus> {
    return this.links.uaServer ? this.links.uaServer.status() : OPC_UA_SERVER_OFF
  }

  /** Whether this surface can run the OPC UA server at all (the desktop app can; a browser tab cannot). */
  get opcUaServerAvailable(): boolean {
    return this.opcUaServerHost !== null
  }

  private syncOpcUaServer(): void {
    linkOps.syncOpcUaServer(this.links, this.program, this)
  }

  /** internal - for controller/program.ts: the default controller's program (null when it runs on an external PLC), and
   *  each simulated controller's own on its own server */
  publishToUaServer(program: PublishedProgram | null): void {
    if (program) linkOps.publishToUaServer(this.links, this.store, program)
    linkOps.publishNamedUaServers(this.links, this.program, this)
  }

  /** internal - for controller/program.ts: every OPC UA server's values, and whether a program runs here */
  updateUaServers(watch: Readonly<Record<string, TagValue>> | null, live: boolean): void {
    linkOps.updateUaServers(this.links, watch, live)
  }

  /** A simulated controller's own OPC UA server's state, for Controller Properties. */
  namedUaServerStatus(name: string): Readonly<OpcUaServerStatus> {
    return linkOps.namedUaServerStatus(this.links, name)
  }

  /** internal - for controller/simRun.ts */
  detachExternalPlc(): void {
    linkOps.detachExternalPlc(this.links)
    programOps.setLinkDriven(this.program, this.sim, [])
  }

  togglePause(): void {
    runOps.togglePause(this)
  }

  setPaused(paused: boolean): void {
    runOps.setPaused(this, paused)
  }

  step(): void {
    runOps.step(this)
  }

  stepBy(opts: { steps?: number; until?: number }): Promise<StepDone | null> {
    return runOps.stepBy(this, opts)
  }

  /** Set the simulation speed multiplier. Applies live to a
   *  running sim and persists for the next run; usable while stopped. */
  setTimeScale(scale: number): void {
    this.store.setTimeScale(scale)
    this.sim.setTimeScale(scale) // no-op when stopped; run() re-pushes the current value
  }

  stop(): void {
    runOps.stop(this)
  }

  /**
   * Open a custom part "as its own scene" (isolate + frame, the part-focus view). Stops a running
   * simulation first: this is an authoring/inspection mode, and a live sim would otherwise keep driving
   * the now-hidden full scene (boxes spawning, cargo moving) out of sight while you edit the part's
   * definition. Mirrors master-edit, which is likewise unavailable while running. The single entry point
   * for every "Open Part Editor" affordance (scene tree, inspector, new-part on-ramp).
   */
  openPartScene(id: string): void {
    if (this.store.getState().running) this.stop()
    this.store.enterPartFocus(id)
  }

  /**
   * Open a catalog package's *definition* as a scene - the "edit a definition" path for the Parts dock's
   * ✎ button. Opens the package rig at the origin in a throwaway session (the scene-isolation model's
   * "edit a definition → at origin"), so it works with no placement and never mutates the user's saved
   * scene - the throwaway gets a scene of its own while the document's is parked, and Back puts that back (see
   * store `enterPackageEdit` / `exitPartFocus`). Stops a running sim first (the openPartScene
   * invariant). Clicking ✎ while already in a package-edit session *switches* to the new part's scene
   * (the current one's edits are already committed to its package, so closing it loses nothing); clicking
   * the part already open is a no-op. No-op in read-only mode, in a room, or for an unregistered package id.
   * Returns false when nothing was opened.
   */
  editPartPackage(packageId: string): boolean {
    if (this.readOnly) return false
    const pe = this.store.getState().packageEdit
    if (pe?.packageId === packageId) return true // already editing this package's rig - stay put
    if (this.store.getState().running) this.stop()
    if (pe) this.store.exitPartFocus() // switch sessions: close the current one (drops its scene) first
    if (!this.store.enterPackageEdit(packageId)) return false
    const partId = this.store.getState().packageEdit?.partId
    if (partId) this.store.selectRigNode(partId, 'body')
    return true
  }

  // ── Scene swaps ── all routed through here so the shared invariant holds:
  // changing which scene is live stops a running sim and leaves any part-focus / package-edit session first
  // (the worker would otherwise keep simulating the old scene's bodies under the new scene's state).

  /**
   * Back to the full scene (the breadcrumb, Close Part Editor). Leaving a definition session swaps the live scene (the
   * session's own scene goes and the parked document comes back, store.exitPartFocus), so a running sim stops
   * first, as for any scene swap. Leaving a plain part-focus only changes what is shown, and keeps running.
   */
  closePartScene(): void {
    if (this.store.getState().packageEdit && this.store.getState().running) this.stop()
    this.store.exitPartFocus()
  }

  /** Stop the sim + leave any authoring sub-scope, so the live scene can be swapped cleanly. Idempotent
   *  (each step is guarded), so a caller that can't know which branch it will take - sceneFile's
   *  openDemoScene, which reloads into the demo - may call it up front. */
  leaveForSceneSwap(): void {
    if (this.store.getState().running) this.stop()
    if (this.store.getState().focusedPartId || this.store.getState().packageEdit) this.store.exitPartFocus()
  }

  /**
   * Compile-validate an ST program here (throws StError on a compile error), then ship the source to
   * the sim worker, which compiles it too and interleaves its fixed-period scans between physics steps
   * (sim/plcHost.ts) - the device-IO tag bridge closes entirely worker-side, at scan/step cadence.
   * The editor keeps only what its own UI needs: the authoring warnings (`unbound`/`unwired`, see
   * {@link unhandledProgramTags}) and the driven-keys mirror for the pilot's "In auto" prompt.
   */
  runProgram(source: string, opts?: { periodSec?: number }): { unbound: string[]; unwired: string[]; warnings: string[] } {
    return programOps.runProgram(this.program, this, source, opts)
  }

  private rebindProgram(parts: SceneJSON['parts']): void {
    programOps.rebindProgram(this.program, this.sim, parts)
  }

  /** Compile + attach the scene's ST program so it drives the running sim. Called on the run edge
   *  by run() and on live re-attach from the ST editor. Captures the bind/compile result into
   *  programStatus so the editor panel can show it - and so a compile error doesn't throw out of
   *  run(). The source comes from one place, `state.stProgram` (see EditorState), the same one the
   *  exporter and the room seeder read, so what runs can never differ from what is saved. */
  attachProgram(): void {
    programOps.attachProgram(this.program, this)
  }

  /**
   * What runs after the program on screen failed to attach (a compile error, or its controller table's): the program
   * from before it, still driving the line ('previous'), or nothing ('none'). Null when the last attach succeeded.
   */
  get programAttachFailure(): 'previous' | 'none' | null {
    if (!this.program.attachFailed) return null
    return this.program.plcAttached ? 'previous' : 'none'
  }

  private adoptLateProgram(): void {
    programOps.adoptLateProgram(this.program, this)
  }

  /**
   * Why the running sim cannot take the document's program again right now, or null when it can: it is not running
   * (Play attaches the program as it is), an external PLC owns the I/O for this run, or a part scene is open.
   */
  get programReloadBlocker(): ReloadBlocker | null {
    const s = this.store.getState()
    if (!s.running) return 'stopped'
    if (this.links.externalSession) return 'external'
    if (s.focusedPartId !== null) return 'partScene'
    return null
  }

  /**
   * Whether a reload would run something different from what runs now: the program, its controller table or a scan
   * time baked into it changed since the attach, or the PLC dropped the program on a fault. False whenever a reload
   * is blocked, so this alone decides whether the PLC dock's Reload is lit (commands.ts `sim.reloadProgram`).
   */
  get programOutOfDate(): boolean {
    return this.programReloadBlocker === null && programOutOfDate(this.program.attached, this.store.getState())
  }

  /**
   * Take the document's program into the running sim. A restart of the program, not a patch: the worker builds a new
   * scan host, so its variables, timers and steps start over while the plant keeps its state. No-op when blocked.
   */
  reloadProgram(): void {
    if (this.programReloadBlocker !== null) return
    this.attachProgram()
  }

  /** Current ST program attach status (bindings + compile error). */
  get programStatus(): Readonly<ProgramStatus> {
    return this.program.status
  }

  /**
   * The last runtime fault of the program this editor ran (division by zero, an index out of bounds, a loop
   * cap), with the program text that faulted, or null. Kept past Stop, unlike the status line: a fault ends
   * the run, so clearing it with the run would leave no trace of why the line stopped. A new attach clears it;
   * a reader compares `source` with the current program to tell a fault from one the author has since
   * edited away. Changes notify through {@link onProgramStatus}.
   */
  get plcFault(): Readonly<PlcFault & { source: string }> | null {
    return this.program.fault
  }

  /** Subscribe to program-status changes (attach/detach/error); returns an unsubscribe. */
  onProgramStatus(cb: () => void): () => void {
    this.program.watchers.add(cb)
    return () => this.program.watchers.delete(cb)
  }

  private setProgramStatus(next: ProgramStatus): void {
    programOps.setProgramStatus(this.program, next)
  }

  /** The tag keys the attached program (or an external PLC) drives: output ownership, mirrored for the editor's own
   *  UI (the pilot "In auto" prompt, the Inspector's setpoints). Read-only; e2e scripts read `.size` too. */
  get plcDrivenKeys(): ReadonlySet<string> {
    return this.program.drivenKeys
  }

  /** bumps whenever {@link plcDrivenKeys} is replaced, so per-frame consumers can memoize on it */
  get plcDrivenRev(): number {
    return this.program.drivenRev
  }

  private syncScanPeriod(): void {
    programOps.syncScanPeriod(this.program, this)
  }

  /** stop driving the scene from an ST program */
  stopProgram(): void {
    programOps.stopProgram(this.program, this)
  }

  /** narrow a scene to the isolated open-part scene (forSim, a no-op when none is open) before it's pushed
   *  live. SDK parts own their motion via the device-IO tag bridge, not param overrides, so this is only the
   *  part-scene isolation. */
  commsScene(scene: SceneJSON): SceneJSON {
    return this.forSim(scene)
  }

  /**
   * Live-swap a hot-reloaded package into the running sim. Re-embeds every scene package from the registry,
   * not just the edited id, because the worker re-registers all of them on a syncPackages update: embedding
   * the scene's stale snapshot of a package hot-reloaded earlier in this run would regress the worker's copy,
   * silently reverting that edit on the part's next rebuild. The worker rebuilds exactly the parts whose
   * package rev changed (partSignature folds it in). No-op when stopped - the next Run rebuilds from the
   * registry anyway. Pairs with view.refreshPackage (the render half).
   */
  private reloadSimPackage(id: string): void {
    if (!this.store.getState().running) return
    const pkg = getPackage(id)
    if (!pkg) return
    const scene = this.commsScene(this.store.getState().scene)
    const fresh = (scene.packages ?? []).filter((p) => p.id !== id).map((p) => getPackage(p.id) ?? p)
    this.sim.update({ ...scene, packages: [...fresh, pkg] }, true)
  }

  /**
   * Toggle a BOOL of the running program (Ctrl+T). Written once, between scans: a bit the program
   * drives is overwritten by its next scan (so the toggle is a pulse), one it only reads stays until toggled
   * back. `key` is the watch key (`Name`, or `Instance.Name` under a CONFIGURATION). False when there is no
   * running program or the key is not a BOOL of it.
   */
  togglePlcBit(key: string): boolean {
    return programOps.togglePlcBit({ ec: this, p: this.program }, key)
  }

  /**
   * Write a value typed under an operand into the running program (click the number while online and type). Written
   * once, between scans, like {@link togglePlcBit}: a tag the program itself writes is overwritten by its next scan,
   * one it only reads holds the value. `key` is the watch key. The reason it was refused, or null when written.
   */
  writePlcValue(key: string, text: string): string | null {
    return programOps.writePlcValue({ ec: this, p: this.program }, key, text)
  }

  /**
   * Force a variable of the running program: hold it at `text`, or at the value it has now, until released. The
   * program reads the held value and the parts see it, whatever the scene feeds or the program writes. A write
   * ({@link writePlcValue}, {@link togglePlcBit}) to a forced variable changes the held value. A force stays until
   * released, through Stop and into the next run from its first scan, as on a controller; an attach drops one its
   * program no longer has, and loading another scene drops them all. Never saved. The reason it was refused, or null
   * when held.
   */
  forcePlcValue(key: string, text?: string): string | null {
    return programOps.forcePlcValue({ ec: this, p: this.program }, key, text)
  }

  /** Release one forced variable, or every one when `key` is left out. */
  releasePlcForces(key?: string): void {
    programOps.releasePlcForces({ ec: this, p: this.program }, key)
  }

  /** The attached program's bare-name aliases (LocalPlcLink.aliases): the rule a part's tag binds by. Empty with
   *  no program attached. */
  get plcAliases(): ReadonlyMap<string, string> {
    return (this.program.plcAttached ? this.program.uaProgram?.aliases : undefined) ?? NO_PLC_ALIASES
  }

  /** The running program's forced variables and the values they are held at, by watch key. */
  get plcForces(): Readonly<Record<string, number | boolean>> {
    return this.sim.forces
  }

  /** Subscribe to forces being set or released; returns an unsubscribe. */
  onPlcForces(cb: () => void): () => void {
    this.program.forceWatchers.add(cb)
    return () => this.program.forceWatchers.delete(cb)
  }

  /** Live variable image of the running program (null when none), for a watch table. Rendered from
   *  the worker's frame-borne PLC state (the program scans in the worker); the validation compile's
   *  initial image fills in until the first frame arrives.
   *
   *  It is a 10 Hz mirror, not a per-frame one: the table is carried on one published frame in ten
   *  (sim/plcHost.ts WATCH_HZ) and sim/client.ts carries the last one forward in between, so a read
   *  can be up to ~0.15 s stale and a pulse shorter than that is invisible here. Fine for the readers
   *  it was sized for (a watch table, the rung editor - they look eight times a second), but anything
   *  correlating a tag with a per-frame event (a body being born, a pose) is comparing a 17 ms stream
   *  against a 100 ms one and needs a grace on both sides. Without it, a gate like
   *  verify-no-spawn-before-attach reports correct spawns as births on a shut gate. */
  get plcWatch(): Readonly<Record<string, TagValue>> | null {
    return linkOps.plcImage(this.links, this.ownPlcWatch, this.lastFrame) ?? this.live.watch() // else a followed run's (liveView.ts)
  }

  /** The image of the program a write or force can reach: this app's program, else a followed run's. Unlike
   *  {@link plcWatch} it leaves out an external PLC's tags, which a force here would never reach. */
  get plcProgramWatch(): Readonly<Record<string, TagValue>> | null {
    return this.ownPlcWatch ?? this.live.watch()
  }

  private get ownPlcWatch(): Readonly<Record<string, TagValue>> | null {
    return this.program.plcAttached ? (this.sim.plcState?.watch ?? this.program.seedWatch) : null
  }

  /** Per-part effective param values the running behaviors reported this frame (`ctx.report`), keyed by
   *  part id then param name - measured from each behavior's own output rather than re-derived here, so
   *  it can't drift from what the script computed. Undefined when nothing has reported (or no frame yet).
   *  (internal - for controller/setpoints.ts) */
  get reportedValues(): Record<string, Record<string, number | boolean>> | undefined {
    return this.lastFrame?.values
  }

  /** The live marks (product state) on one authored product this frame: its attributes as machines have left
   *  them. Empty when the sim is stopped or nothing has marked it. (internal - for controller/setpoints.ts) */
  marksOf(partId: string): Readonly<Record<string, number | boolean | string>> {
    return this.lastFrame?.marks?.[partId] ?? {}
  }

  /** Named display values one part published on the latest frame (ctx.display): what its live caption
   *  plates are showing right now. Empty when the sim is stopped or the part published nothing. The same
   *  bag the renderer paints from, so anything the editor draws from it cannot disagree with the scene. */
  displaysOf(partId: string): Record<string, number | boolean | string> {
    return this.lastFrame?.displays?.[partId] ?? {}
  }


  /** The running program's variable image, where a part's tag is looked up. Null when no program is attached. */
  get plcGlobalTags(): Readonly<Record<string, TagValue>> | null {
    return setpointOps.globalTags(this)
  }

  /**
   * What the running scene is commanding into a part's number params through its analog setpoint tags
   * (`setpointFor`, e.g. a conveyor's `speedTag` → `speed`), keyed by target param. Null when nothing
   * commands it - sim stopped, comms off, no setpoint tag bound - in which case the authored params rule.
   * The Inspector shows these in place of the authored values while they're in force. A bound setpoint
   * that no program drives reports 0, because that is what the behavior reads.
   */
  liveSetpoints(partId: string): LiveSetpoints | null {
    return setpointOps.liveSetpoints(this, this.store.getState().scene.parts, partId)
  }

  /** latest device process image (%I / %Q) of the running program (null when none) */
  get plcProcessImage(): ProcessImageSnapshot | null {
    if (!this.program.plcAttached) return null
    const s = this.sim.plcState
    return s ? { inputs: s.inputs, outputs: s.outputs } : { inputs: {}, outputs: {} }
  }

  /** The controller's fault (plc/faults.ts): the one that stopped the program. It stands as it was after the program
   *  stops, until the next program starts. */
  get plcFaults(): PlcFaults {
    return { source: this.program.faultSource, fault: this.program.lastFault }
  }

  /** cumulative scan-engine telemetry since the program started (null when none). With the scan
   *  interleaved in the worker, sim time can't backlog - a nonzero `overruns` only means the
   *  cycle time was pushed below what one physics step can drain (see PlcHost). Resets on each Run. */
  get plcScanStats(): { scansRun: number; overruns: number } | null {
    if (!this.program.plcAttached) return null
    const s = this.sim.plcState
    return { scansRun: s?.scansRun ?? 0, overruns: s?.overruns ?? 0 }
  }

  /** How long each task's scans take to execute, from the latest frame (sim/plcHost.ts ScanTime). Null when no
   *  program runs here, empty until its first frame. */
  get plcScanTimes(): readonly ScanTime[] | null {
    if (!this.program.plcAttached) return null
    return this.sim.plcState?.scanTimes ?? []
  }

  /** Start the scan-time averages and maxima over; the next frame carries the fresh ones. */
  resetPlcScanTimes(): void {
    if (this.program.plcAttached) this.sim.resetScanTimes()
  }

  // (e2e verify-camera-persistence calls it at runtime)
  private viewportKey(): string {
    return cameraOps.viewportKey(this.store)
  }

  /**
   * This scene's opening view: what it is framed at before anyone has framed it themselves.
   * Public because the device benchmark (editor/bench.ts) starts its orbit here rather than from
   * wherever the camera was left - two runs are only comparable if they start from one pose.
   */
  openingView(): { px: number; py: number; pz: number; tx: number; ty: number; tz: number } {
    return cameraOps.openingView(this.store)
  }

  private restoreCamera(): void {
    cameraOps.restoreCamera(this.camera, this)
  }

  /**
   * "Reset View": forget this scene's remembered camera and go back to its opening view - the
   * counterpart to Reset Panel Layout, and the way out of a camera left somewhere useless. Eased,
   * not instant: this one is watched, and the motion shows where it went.
   */
  resetCamera(): void {
    cameraOps.resetCamera(this)
  }

  /** an axis view: Numpad 1 / 3 / 7 and the palette's Front View and the rest (controller/camera.ts) */
  viewAlongAxis(id: cameraOps.AxisViewId): void {
    cameraOps.viewAlongAxis(this.view, id)
  }

  dispose(): void {
    dragOps.cancelActiveDrag(this)
    this.container.removeEventListener('pointerdown', this.onPointerDown)
    this.container.removeEventListener('contextmenu', this.onContextMenu)
    this.container.removeEventListener('pointermove', this.onPointerMove)
    this.container.removeEventListener('pointerup', this.onPointerUp)
    this.container.removeEventListener('pointercancel', this.onPointerCancel)
    this.container.removeEventListener('wheel', this.onWheel, { capture: true })
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('blur', this.onWindowBlur)
    this.unsubscribe()
    this.unsubscribeDocument()
    this.unsubscribePackages()
    this.unsubscribeDiagnostics()
    window.removeEventListener('pagehide', this.flushCamera)
    this.view.onCameraSettled = null
    this.store.setLiveCargoHost(null)
    this.sim.onFrame = () => {}
    this.live.dispose()
    linkOps.stopUaServers(this.links)
  }

  /**
   * Author mode: edit one rig link's geometry (offset, rest rotation, or primitive shape size) on a custom
   * part's package, applied live. Re-registers the package as a working copy, which fires
   * onPackagesChanged → view.refreshPackage so every placed instance rebuilds with the new geometry. Not a
   * scene commit, but one step on the same undo stack (store.commitPackage), and kept in the project library.
   */
  editRigLink(
    packageId: string,
    linkName: string,
    patch: { offset?: [number, number, number]; rotation?: [number, number, number]; shape?: RigShape },
  ): void {
    authoringOps.editRigLink(this, packageId, linkName, patch)
  }

  /**
   * Author mode: toggle a rig link's visibility (the Scene-tree eye). Render-only and persisted in the
   * package - commitPackage → refreshPackage rebuilds every instance with the link's render group hidden;
   * the sim/collision body is unchanged (like a frame/label link is visual-only the other way round). A
   * package edit, so it goes on scene undo via commitPackage exactly like editRigLink.
   */
  setRigLinkHidden(packageId: string, linkName: string, hidden: boolean): void {
    authoringOps.setRigLinkHidden(this, packageId, linkName, hidden)
  }

  /**
   * Author mode: rename a rig link, cascading the new name through every structural reference in the rig
   * geometry: child links' `parent`, two-point aim targets (`aim.target`), and joints' `link`. A link name
   * is a reference key, not just a label, so a bare relabel would orphan those. Joint names are left alone
   * (a separate identifier the behavior commands via setJoint).
   *
   * The link name can also reach the behavior script as a string argument (`setGrip('hand', …)`,
   * `setSubPose('hand', …)`). Rewriting freeform JS can't be guaranteed safe, so it's guarded: when the
   * (already-valid) rename has such whole-string-literal references, `confirmBehaviorRewrite(count)` is asked
   * whether to also rewrite them; geometry + behavior then go into one undo entry. Without the callback (or
   * on a `false` answer) only the geometry cascades and the author updates the script by hand.
   *
   * No-op (returns false) when the new name is blank, unchanged, references an unknown link, or collides with
   * another link; the prompt is never shown for an invalid rename. On scene undo via commitPackage.
   */
  renameRigNode(packageId: string, linkName: string, rawName: string, confirmBehaviorRewrite?: (count: number) => boolean): boolean {
    return authoringOps.renameRigNode(this, packageId, linkName, rawName, confirmBehaviorRewrite)
  }

  /**
   * Author mode: rename a rig joint. Only for a joint the behavior script never mentions (behaviorMentions):
   * a script can reach a joint as a string and as a property (`ctx.joints.shoulder`), and rewriting the property
   * forms reliably needs a real parse, so a mentioned joint is renamed in the script by its author instead. No-op
   * (false) when blank, unchanged, colliding with another joint, or mentioned. One undo step, via commitPackage.
   */
  renameRigJoint(packageId: string, jointName: string, rawName: string): boolean {
    return authoringOps.renameRigJoint(this, packageId, jointName, rawName)
  }

  /**
   * Author mode: import a GLB model and apply it to a rig link - the link's shape becomes a `mesh`
   * referencing the embedded GLB (base64, so the part stays self-contained + portable). Applied live
   * (registerPackage → rebuild → attachMesh loads it). Replaces the link's current shape; a part that is just
   * this model is fitted to it in the same step (core/parts/modelFit.ts), and `fitted` says so.
   *
   * `warning` is advisory (or null). The import always proceeds (the embedded model is what
   * makes the part self-contained, and we don't know the browser's real quota), but the embedding is what
   * pushes the project doc over localStorage, so an oversized model is called out at the moment it's
   * picked rather than only via the autosave banner later. See LARGE_EMBED_B64 and projectFile.SaveResult.
   */
  setLinkMesh(packageId: string, linkName: string, glb: Uint8Array): { warning: string | null; fitted: boolean; unreadable?: true } {
    return authoringOps.importLinkMesh(this, packageId, linkName, glb)
  }

  /**
   * Author mode: add a child node under `parentLinkName` so you can compose a
   * multi-node part - the "add child node" of the part scene. `kind` picks the primitive it is born as
   * (the Inspector's add-node selector); it defaults to a box, which is what the scene tree's context-menu
   * entry adds. Selects the new node. Applied live.
   */
  addRigNode(packageId: string, parentLinkName: string, kind: AuthorableShapeKind = 'box'): void {
    authoringOps.addRigNode(this, packageId, parentLinkName, kind)
  }

  /**
   * Teach-pendant capture: the custom rig part's current posed joint values as one waypoint row, ordered
   * like the rig's joints - revolute in degrees, prismatic in metres (the shipped manipulators' waypoint
   * convention). The pose is the rig gizmo's held authoring pose (set by an IK/joint-ring drag; an unposed
   * joint reads 0 = rest), so "pose the arm with the gizmo → Capture Pose" trains a waypoint the way a real
   * robot pendant does. Returns null for anything but a jointed custom rig. The Inspector offers it on any
   * numberList param whose row width matches the joint count.
   */
  captureRigPose(partId: string): number[] | null {
    return authoringOps.captureRigPose(this, partId)
  }

  /**
   * The inverse of captureRigPose: show a joint row (a taught waypoint, a job's Move step) on the rig, in the same
   * units - revolute in degrees, prismatic in metres, ordered like the rig's joints. It poses the gizmo's held
   * authoring pose, exactly as dragging the arm there would, so Capture Pose after it reads the row back.
   */
  previewRigPose(partId: string, row: readonly number[]): void {
    authoringOps.previewRigPose(this, partId, row)
    this.noteRigJog(partId)
  }

  /**
   * Author mode: delete a node and its whole subtree (and any joints that drive those links). No-op if
   * it would empty the rig (a part needs ≥1 node). Selects the deleted node's parent. Applied live.
   */
  deleteRigNode(packageId: string, linkName: string): void {
    authoringOps.deleteRigNode(this, packageId, linkName)
  }

  /** Author mode: add, edit, or remove (null) the joint that drives a link; the behavior commands it by name
   *  via ctx.setJoint, and the name stays stable across edits so those references stay valid. Applied live. */
  setRigJoint(packageId: string, linkName: string, joint: Parameters<typeof authoringOps.setRigJoint>[3]): void {
    authoringOps.setRigJoint(this, packageId, linkName, joint)
  }

  /** Author mode: the Part Editor's rig edits (split, pivot, merge back, parent, PLC control), in controller/partAuthoring.ts. */
  readonly rig = authoringOps.rigEdits(this)

  /**
   * Author mode (in-browser behavior editor): validate a candidate behavior script against the part's own
   * rig the same way the desktop hot-reload loop does, without committing. Reuses validatePart so the browser
   * path can never drift from disk import. Returns all diagnostics (located, typed) - [] when clean. Drives
   * the editor's live squiggles while typing; the actual commit happens in `editBehavior`.
   */
  validateBehavior(packageId: string, source: string): PartDiagnostic[] {
    return authoringOps.validateBehavior(this, packageId, source)
  }

  /** Open the in-browser behavior editor for a custom part - a passthrough to the store so callers that hold
   * the controller (e.g. the Inspector) reach the same single, app-level editor mount as the scene tree. */
  openBehaviorEditor(packageId: string): void {
    this.store.openBehaviorEditor(packageId)
  }

  /**
   * Author mode (in-browser behavior editor): replace a custom part's behavior script. On success commits the
   * rebuilt package live (registerPackage → instances pick up the new script on the next sim run) and returns
   * []; on failure returns the diagnostics without mutating anything. The project library keeps it (on the desktop, in the project folder).
   */
  editBehavior(packageId: string, source: string): PartDiagnostic[] {
    return authoringOps.editBehavior(this, packageId, source)
  }

  /**
   * Import a part file (.part.json - see editor/parts/partFile.ts) into the user's library: validate + re-bake
   * it, register it as the authoritative copy, and surface it in the catalog. Returns a human-readable
   * error, or null on success/cancel. `confirmReplace` (when given) gates overwriting an id that's already
   * loaded - declining is a silent no-op, like cancelling a file dialog. Replacing a bundled example
   * shadows it with the imported user copy (the same copy-on-write the in-app edit flow uses).
   */
  importPart(file: string | Uint8Array, confirmReplace?: (existingName: string) => boolean): Promise<string | null> {
    return authoringOps.importPart(this, file, confirmReplace)
  }

  /** importPart, then place one copy where the file was dropped on the viewport (the drop point stands in for a card
   *  dragged there). Declining the replace places nothing. */
  async dropPartFile(file: Uint8Array, clientX: number, clientY: number, confirmReplace?: (existingName: string) => boolean): Promise<string | null> {
    const res = await authoringOps.importPartFile(this, file, confirmReplace)
    if ('error' in res) return res.error
    if (res.id !== null) catalogOps.placePackageAt(this, res.id, clientX, clientY)
    return null
  }

  /**
   * "Save as a New Part": a copy of this part under its own id and name, added to the project's library, so a variant
   * (a heavy-duty conveyor beside the standard one) sits next to the original instead of replacing it. Placed parts
   * keep the part they are. Made from a built-in (or the project's copy of one), it records which built-in and which
   * version (core/builtInVersion.ts asNewPartFrom). Returns the new id, or null when there is nothing to copy.
   */
  saveAsNewPart(packageId: string): string | null {
    return authoringOps.saveAsNewPart(this, packageId)
  }

  /**
   * Author mode: create a new blank custom part and open it as a scene to author. Builds a minimal rig
   * (a single box link) + a starter behavior, registers it, and adds it to the catalog only: a new part is
   * not placed in the working scene (it reaches the scene only when the user drags it in from the catalog).
   * Then opens the package as its own scene via the Catalog ✎ throwaway-draft session (editPartPackage), so
   * the geometry editor is immediately live on it with the root node selected, without durably mutating
   * the scene. Returns the new package id (null on a view-only link or in a shared room, where the Part
   * Editor is refused).
   */
  createBlankPart(from?: Parameters<typeof authoringOps.createBlankPart>[1]): string | null {
    return authoringOps.createBlankPart(this, from)
  }

  /** A part's own name and catalog category (the definition's, not a placed copy's). Returns '' or why not. */
  setPartInfo(packageId: string, patch: { name?: string; category?: string }): string {
    return authoringOps.setPartInfo(this, packageId, patch)
  }

  /**
   * Freeze the worker while the tab is hidden (other tab / minimized / phone locked), and restore the
   * user's pause state when it returns. The physics worker runs on its own setInterval clock that keeps
   * ticking (throttled) in a background tab. The PLC scan interleaves with the physics steps inside
   * that worker (sim/plcHost.ts), so control logic and physics share one clock and a hidden tab can't
   * desync them - but pausing the worker is still worth it to stop physics advancing a sim no one can
   * see (spawners spewing boxes offscreen) and to save CPU. Gated on `running`: a stopped sim has
   * nothing to freeze. We leave store.paused untouched so the Play/Pause button stays as
   * the user left it - this is an invisible background optimization, not a user pause. Visibility (not
   * window blur) is the signal: a side-by-side window the user can still see should keep running.
   */
  private readonly onVisibilityChange = (): void => {
    const s = this.store.getState()
    if (document.visibilityState === 'hidden') {
      if (s.running) this.sim.setPaused(true)
      return
    }
    // Back on screen. Drop the stale render frame so the first rAF dt is a fresh ~16ms frame rather
    // than the whole hidden gap clamped to 0.1s - this dt still drives the camera, DRS, and (while
    // stopped) manual motions. Not gated on `running`: frame-clock hygiene isn't sim-specific.
    this.view.resetFrameClock()
    if (!s.running) return
    // Resume the worker. It resyncs its step clock on unpause (worker.ts) so no hidden-gap backlog
    // bursts physics forward, and the in-worker scan runs between the steps, so nothing to resync here.
    // See docs/sim-clock.md.
    this.sim.setPaused(s.paused) // restore the user's intent (normally resume)
  }

  private onStoreChange = (transient = false): void => {
    // A scene that arrives during an open drag or reposition from anything but the gesture's own moves (a project
    // load, a folder reload, an agent's edit). Each move rebuilds the scene from the one the gesture started on, so
    // the next move would write that old scene over the new one and the release would commit it. A gesture's own
    // moves are transient and its release closes it before committing, so a lasting scene change here is not its own.
    if (!transient && this.store.getState().scene !== this.prevScene) dragOps.dropOvertakenGesture(this)
    const s = this.store.getState()
    // a part removed out from under an in-flight reposition: drop the gesture
    const repos = this.repo.active
    if (repos && !s.scene.parts.some((p) => p.id === repos.id)) this.repo.active = null
    // package-edit: if an undo (or other edit) stranded the package-rig session's throwaway, tear the
    // session down. Checked before the focus guard below - both would fire, but only this one also clears
    // the packageEdit session. exitPartFocus both clears the session and (if the draft survived) removes
    // it; here the draft is already gone.
    if (s.packageEdit && !s.scene.parts.some((p) => p.id === s.packageEdit!.partId)) {
      this.store.exitPartFocus()
      return
    }
    // part-scene focus: if the focused part was deleted, leave focus (the re-entrant call rebuilds clean)
    if (s.focusedPartId && !s.scene.parts.some((p) => p.id === s.focusedPartId)) {
      this.store.exitPartFocus()
      return
    }
    // leaving a part scene (Back / Close / a stranded session) while the isolated sim runs: stop first, so we
    // don't drop the user back into the full factory scene still running - its spawners would start spawning.
    // Mirrors stop-on-enter. stop()'s synchronous setState re-enters here with running cleared, which does the
    // normal exit (camera restore, view resync to the full scene); this outer frame then bails.
    if (s.running && s.focusedPartId === null && this.prevFocus !== null) {
      this.stop()
      return
    }
    // syncScene walks the whole scene (per-part signatures + the global roller-grid / opening /
    // extent / platform passes), so gate it on a real scene change: a selection / tool / mode
    // toggle keeps the same scene reference and must not pay for a full-scene geometry recompute. In
    // a big scene an O(N) resync on every click would be the dominant selection cost. setSelection
    // stays unconditional - it's incremental (flips only the entries that changed and
    // re-evaluates their matrix-freeze), and must run after syncScene so a freshly-added,
    // freshly-selected part's entry exists before its selection visual is applied.
    const sceneChanged = s.scene !== this.prevScene
    // Camera hand-off, ahead of syncScene: both branches change which scene the viewport belongs to,
    // which is a camera concern rather than a scene edit.
    // Tracked on every change, not only inside the branch below: pressing Demo again re-enters a demo
    // session, and a flag the hand-off only ever cleared would make it once per session. The second
    // fork would fall through to the scene-switch branch and reframe the new slot from scratch.
    const demoRetired = this.prevDemoSession && !s.demoSession
    this.prevDemoSession = s.demoSession
    if (demoRetired) {
      // A demo peek just ended, and the store says how (EditorStore.demoForkedSlot). The two endings
      // want opposite things from the camera and are the same flag flip from here.
      if (this.store.demoForkedSlot !== null) {
        // Forked (stashDemoSession): the document did not change (the same scene continues under a new
        // identity), so the camera carries over to the new slot instead of being swapped. Without this the
        // demo's opening frame is recorded under a key nothing reads again, and the next reload opens the
        // work at the world-zero default: the exact inconsistency between opening the demo and reloading
        // it. viewportKey() already names the new slot (a fork into a project of its own announced its
        // document before the stash's one setState).
        this.camera.key = this.viewportKey()
        persistViewportState(this.camera.key, { pose: this.view.cameraPose(), projection: this.view.projectionMode(), auto: this.view.projectionAuto() })
      } else {
        // Dropped (dropDemoSession): the demo is discarded, so the scene coming back is framed the way its
        // owner left it - carrying the demo's camera into it would be someone else's view of someone
        // else's factory.
        this.restoreCamera()
      }
    }
    // The renderer is fed a view-only scene, not s.scene directly: the active edit target derives what to
    // show (it never reaches the store, sim, or disk, so the real scene is untouched). The only
    // non-main target is part-focus; see editTargetViewScene.
    const focusChanged = s.focusedPartId !== this.prevFocus
    // the walk session's door state is part of the view scene too (editTargetViewScene), so a leaf the
    // character uses, or the session ending, re-syncs the view without any change to the authored scene
    const walkDoorsChanged = s.walkDoors !== this.prevWalkDoors
    this.prevWalkDoors = s.walkDoors
    // a flex the character pulls is the same kind of session state, and the running sim follows it too (forSim)
    const walkFlexChanged = s.walkFlex !== this.prevWalkFlex
    this.prevWalkFlex = s.walkFlex
    if (walkFlexChanged && s.running && !sceneChanged) this.pushWalkFlexToSim()
    const viewScene = this.editTargetViewScene(s)
    // deferred pool drag seam: sync the parts under a live drag before syncScene routes the
    // pool update (eject for structural drags, write-through for pure moves - see pushPoolDrag).
    // The begin*Drag handlers push the same set at pointer-down; this keeps it correct across
    // duplicate retargets and reposition, and clears it once the drag is gone.
    this.pushPoolDrag(s)
    // A wholesale scene load (store.loadScene), as opposed to an edit of the same scene. Only the sync
    // can say whether the incoming scene draws in one frame or assembles itself over several, so the
    // cover is decided right after it, in the same task, before any frame paints (sceneSwapCover.ts).
    const sceneLoaded = this.store.sceneLoads !== this.prevSceneLoads
    this.prevSceneLoads = this.store.sceneLoads
    // forces outlive Stop but not the scene: another project's program can reuse a variable name
    if (sceneLoaded) this.releasePlcForces()
    // a definition session (Catalog ✎) swaps the document's scene for its own: the document's parts are held, not
    // disposed, while it is open, and come back on Back without a rebuild (~0.5 s on the demo scene, plus the shader
    // programs three would release and recompile). Set before the sync it governs: on at the session's opening sync,
    // off at the closing one, which restores them and disposes the session's throwaway part.
    const holding = s.packageEdit !== null
    if (holding !== this.prevHolding) {
      if (holding) useOps.dropJogs(this.uses, this) // a jogged arm leaving the view: back to its saved pose
      this.view.setHoldDeparted(holding)
      this.prevHolding = holding
    }
    if (sceneChanged || focusChanged || walkDoorsChanged || walkFlexChanged) this.view.syncScene(viewScene, sceneLoaded ? { load: true } : undefined)
    if (sceneLoaded) coverSceneSwapIfArriving(this.view)
    if (focusChanged) {
      const enteringPart = s.focusedPartId !== null && this.prevFocus === null
      const exitingPart = s.focusedPartId === null && this.prevFocus !== null
      this.prevFocus = s.focusedPartId
      if (enteringPart) {
        // remember the factory view so we can restore it exactly when the user returns
        this.camera.preFocusPose = this.view.cameraPose()
        this.view.focusOn([s.focusedPartId as string])
      } else if (exitingPart && this.camera.preFocusPose) {
        // back to the main scene: return the viewport to how it was before opening the part
        this.view.setCameraPose(this.camera.preFocusPose)
        this.camera.preFocusPose = null
      } else {
        // part→part switch (no main-scene view to restore): just frame the new part
        this.view.focusOn(s.focusedPartId ? [s.focusedPartId] : [])
      }
    }
    this.view.setSelection(s.selectedIds)
    // author mode: mirror the read-only rig-node selection (tree- or viewport-driven) as a link outline
    this.view.setRigNodeHighlight(s.selectedRigNode)
    // F-follow: a selection change ends the consecutive-press run, or retargets an active follow
    cameraOps.syncFocusSelection(this.camera, this.view, s)
    // collab: stream the parts being dragged so peers see the motion live (no-op in solo mode)
    this.publishDragPresence(s)
    // the ST program is document state, so the engine follows it the same way the sim follows
    // the scene: retune a live scan, and adopt a program that arrives after we started with none
    this.syncScanPeriod()
    this.adoptLateProgram()
    // live-edit: push scene changes into the running sim (no-op when stopped).
    // scene identity only changes on an actual edit, so selection-only changes skip it.
    if (sceneChanged) {
      if (s.running) {
        // Placement staging: the staged preview is render-only until the drop. The running sim
        // sees the session's base scene, and only when that changes. Per-move staging transients
        // all share one base, so they dedupe to zero pushes; the drop commit (session already
        // closed by placePart) pushes the committed scene like any other edit.
        const staging = this.placement.session
        const simScene = staging && s.scene === staging.staged ? staging.base : s.scene
        if (simScene !== this.prevSimScene) {
          this.prevSimScene = simScene
          this.sim.update(this.commsScene(simScene))
          this.rebindProgram(simScene.parts)
        }
      }
      this.prevScene = s.scene
      // The scene changed under an open placement session by something other than our own staging
      // stream (undo/redo, a collab peer, hot-reload): the session's base is stale and its
      // pre-allocated id could now collide, so re-arm it on the new scene. The next pointer-move
      // re-stages the preview there.
      const p = this.placement.session
      if (p && s.scene !== p.staged && s.scene !== p.base) {
        this.placement.session = null
        this.view.setStaging(null)
        placementOps.beginPlacingSession(this.placement, this, p.type)
      }
    }
    if (s.externalPlc !== this.links.uaServerSettings) this.syncOpcUaServer()
    // the view runs while this client runs, and while it draws another connection's shared run (controller/liveView.ts)
    const runningChanged = (s.running || s.liveFollowing) !== this.prevRunning
    if (runningChanged) {
      this.view.setRunning((this.prevRunning = s.running || s.liveFollowing))
      // returning to idle: setRunning(false) just reset every rig to its authored rest pose (resetRunPoses),
      // so the cached idle keys no longer describe what's on screen - forget them and re-pose every device
      // from the authored state below (the blade drops back if `active` is off).
      if (!this.prevRunning) this.uses.idlePoseKeys.clear()
      // either edge: a run starts from the design, not from what a stopped Use left a device doing, and what the
      // run left it doing is gone at Stop. A jogged arm is the same: back to its saved pose.
      this.dropUseSessions()
      useOps.dropJogs(this.uses, this)
    }
    // jogs: one the controller did not publish away (loadScene clears the list) is dropped; and a changed scene may
    // have changed a jogged rig's saved idle pose, which the gizmo yields to (rigGizmo applyIdle)
    if (s.joggedIds !== this.uses.publishedJoggedIds) useOps.dropJogs(this.uses, this)
    else if (sceneChanged && this.uses.jogged.size > 0) useOps.syncJoggedIds(this.uses, this)
    // a change to `usedIds` this controller did not publish (loadScene clears it): drop the sessions it no longer lists
    if (s.usedIds !== this.uses.publishedUsedIds) {
      const keep = new Set(s.usedIds)
      for (const id of [...this.uses.sessions.keys()]) if (!keep.has(id)) useOps.dropUseSession(this.uses, id)
      useOps.syncUsedIds(this.uses, this.store)
    }
    // static idle actuation preview (stopped only): re-pose sim-driven devices whenever the rendered scene
    // changed (an edit / param toggle / placement), the edit target moved (part-focus), or we just stopped.
    // Skipped while running (applyBoxFrame owns the rig) and memoized, so a plain selection/drag costs nothing.
    // A flex the walking character pulls changes shape in the walk overlay, not the scene: it is posed the same way,
    // and in the same pass as the syncScene that rebuilt it, or it is drawn at rest (straight). While running, the
    // view poses it rather than the sim's frames, which lag its shape (poseWalkedFlexes).
    if (!s.running && (sceneChanged || focusChanged || runningChanged || walkFlexChanged)) this.refreshIdlePoses(viewScene)
    if (walkFlexChanged || runningChanged) this.poseWalkedFlexes(s, viewScene)
    if (s.flowArrows !== this.prevFlowArrows) {
      this.view.setFlowArrowsVisible(s.flowArrows)
      this.prevFlowArrows = s.flowArrows
    }
    if (s.showGrid !== this.prevShowGrid) {
      this.view.setGridVisible(s.showGrid)
      this.prevShowGrid = s.showGrid
    }
    // the measure tool reads lengths in the scene's Units, so a switch (or a scene with other Units) re-labels it
    const units = sceneDisplayUnits(s.scene)
    if (units !== this.prevDisplayUnits) {
      this.view.setDisplayUnits(units)
      this.prevDisplayUnits = units
    }
    // Live state, not `s`: a scene switch earlier in this same pass (restoreCamera) already put the incoming
    // scene's projection into the store and the view, and `s` still holds the outgoing one. Comparing it
    // would bounce every tab switch straight back to the previous scene's projection.
    const liveProjection = this.store.getState().projection
    if (liveProjection !== this.camera.projection) {
      this.camera.projection = liveProjection
      this.view.setProjection(liveProjection)
    }
    // Placement staging session lifecycle (docs/placement-staging.md): the session must re-arm
    // whenever the placed kind changes (mode enter, card switch) and fully unwind when placing
    // ends. endPlacingSession's transient revert re-enters this handler synchronously (the same
    // accepted pattern as the stop() re-entry above), so the key and session are settled first
    // and the nested frame no-ops here.
    const placingKey = s.mode === 'placing' ? `${s.placingType ?? ''}:${s.placingPackageId ?? ''}` : null
    if (placingKey !== this.prevPlacingKey) {
      const fresh = this.prevPlacingKey === null
      this.prevPlacingKey = placingKey
      placementOps.endPlacingSession(this.placement, this)
      if (placingKey !== null && s.placingType) {
        // a fresh placement session starts unrotated (a card switch keeps the wheel rotation)
        if (fresh) this.placement.angle = 0
        placementOps.beginPlacingSession(this.placement, this, s.placingType)
      }
    }
    if (this.prevMode !== 'pilot' && s.mode === 'pilot') {
      this.view.setPilotActive(true, { onExit: this.pilotExit, onInteract: this.pilotInteract })
    } else if (this.prevMode === 'pilot' && s.mode !== 'pilot') {
      pilotOps.dropCarried(this.pilot, this)
      pilotOps.releaseFlex(this.pilot, this) // the store dropped the walk's flex shapes in the same change
      this.sim.setPilotBody(null) // remove the push capsule (no-op if the sim isn't running)
      this.view.setPilotActive(false)
      // (a device the character operated stays as it was left: Use is one model in and out of walk mode, and
      // what it holds is shown and reset in the Inspector. The walk's own state - dock doors, flex shapes - was
      // dropped by the store in the same change.)
    }
    this.prevMode = s.mode
    // tool / Use-Trackball / space all change which handle (or the interior trackball
    // ball) sits under the cursor without the pointer moving, so re-evaluate the hover
    // highlight after the gizmo rebuilds below instead of waiting for the next mouse move.
    const gizmoConfigChanged =
      this.prevTool !== s.tool || this.prevTrackball !== s.trackball || this.prevSpace !== s.space
    // leaving the ruler tool drops any drawn measurement
    if (this.prevTool === 'ruler' && s.tool !== 'ruler') this.clearRuler()
    this.prevTool = s.tool
    this.prevTrackball = s.trackball
    this.prevSpace = s.space
    this.pushGizmo(s)
    this.pushResizeHandles(s)
    this.pushRobotGizmo(s)
    if (gizmoConfigChanged && this.lastPointer && !this.drag && !IS_COARSE_POINTER) {
      this.refreshHoverHighlight(s, this.lastPointer.x, this.lastPointer.y)
    }
  }

  refreshHoverHighlight(s: EditorState, x: number, y: number): void {
    gizmoOps.refreshHoverHighlight(this, s, x, y)
  }

  pickFlexDot(s: EditorState, x: number, y: number): ResizeHandle | null {
    return gizmoOps.pickFlexDot(this, s, x, y)
  }

  /** internal - for controller/ modules */
  selectedParts(s: EditorState): PartInstance[] {
    return s.scene.parts.filter((p) => selectionSet(s.selectedIds).has(p.id))
  }

  /**
   * The single seam that decides what the viewport renders for the *active edit target*: always a view-only
   * scene that never reaches the store, sim, or disk (the authored scene stays untouched). The main scene
   * renders as-is, plus the walk session's dock doors (withWalkDoors); part-focus isolates one part via focusViewScene. This is the generalization point for the
   * edit-document model: a package-rig target will add its own
   * branch here (render its definition without stamping a throwaway into scene.parts), retiring package-edit's
   * throwaway-at-origin. Keep this a pure derivation of state - no side effects.
   * (internal - for controller/ modules)
   */
  editTargetViewScene(s: EditorState): SceneJSON {
    return viewSceneOps.editTargetViewScene(this.walk, s)
  }

  private poseWalkedFlexes(s: EditorState, scene: SceneJSON): void {
    viewSceneOps.poseWalkedFlexes(this.view, s, scene)
  }

  private pushWalkFlexToSim(): void {
    viewSceneOps.pushWalkFlexToSim(this.walk, this)
  }

  /**
   * Static idle actuation preview: while the sim is stopped, pose each sim-driven device (blade stop, safety
   * gate, diverter - a non-posable jointed rig) at the settled state its own behavior holds for the authored
   * params, so an author can see it actuate - flip the blade stop's `active` and watch the blade rise in the
   * roller gap - without pressing Play. Fully derived (no separate idle pose to author): settleIdlePose runs
   * the real behavior with neutral input, so the preview can't drift from the sim. Posable manipulators
   * (robot/gantry/AGV) own their idle pose via the `pose` param + gizmo and are skipped; a continuous-motion
   * joint (a turntable's spin) never settles and falls back to rest inside settleIdlePose.
   *
   * Memoized per part on (behavior source + params): a move-drag or selection keeps the same key and re-settles
   * nothing (position/rotation don't affect the pose). The run→stop edge and a package rebuild clear the memo
   * (idlePoseKeys) so the rig, freshly reset to rest by those, is re-posed from the authored state.
   * (internal - for controller/ modules)
   */
  private refreshIdlePoses(scene: SceneJSON): void {
    useOps.refreshIdlePoses(this.uses, this, scene)
  }

  /**
   * A stopped-scene Use on `partId` (pilot.ts idleUsePart, from C and E alike): the press goes to the device's live
   * session, which is opened on the first press at the authored state. `key` is the idleKey the device is posed
   * from; `open` builds its session. (internal - for controller/ modules)
   */
  pressIdle(partId: string, key: string, open: () => IdleUseSession | null): void {
    useOps.pressIdle(this.uses, this, partId, key, open)
  }

  /** Put an operated device back to its design (the Inspector's Reset): end its session and re-pose it. */
  resetUse(partId: string): void {
    useOps.resetUse(this.uses, this, partId)
  }

  /** a pose gizmo gesture (a joint or IK drag, a waypoint shown) may have moved this rig off its saved pose */
  noteRigJog(partId: string): void {
    useOps.noteJog(this.uses, this, partId)
  }

  /** Put a jogged rig back at its saved idle pose (the Inspector's Reset). */
  resetJog(partId: string): void {
    useOps.resetJog(this.uses, this, partId)
  }

  /** @internal test hook (e2e verify-walk-session): the devices a stopped-scene Use is operating, by part id */
  get useSessions(): ReadonlyMap<string, { session: IdleUseSession; key: string }> {
    return this.uses.sessions
  }

  private dropUseSessions(): void {
    useOps.dropUseSessions(this.uses, this.store)
  }

  private tickUseSessions(dt: number): void {
    useOps.tickUseSessions(this.uses, this, dt)
  }

  private forSim(scene: SceneJSON): SceneJSON {
    return viewSceneOps.forSim(this.walk, this.store, scene)
  }

  // collab live-drag streaming: whether a drag has been published, so exactly one "drag ended" follows (controller/dragPresence.ts)
  private readonly presence = new presenceOps.DragPresence()

  /**
   * Push the parts the just-begun drag will move to the pool's drag seam now, at
   * pointer-down / gesture start, while the hand is still stationary. Structural drags
   * (resize/guard-opening: they regenerate hardware) eject their parts from the instance
   * pool up front, so the one-time re-bake can't read as a hitch when motion starts; pure-move
   * drags (gizmo/rotate/vertex-snap/reposition) keep their parts pooled and stream poses through
   * writeThrough instead. Called by the begin*Drag handlers right after they set
   * `drag`/`reposition`; the mirror push in onStoreChange keeps the set current for the drag's
   * lifetime and clears it on release.
   */
  syncPoolDragEject(): void {
    this.pushPoolDrag(this.store.getState())
  }

  private pushPoolDrag(s: EditorState): void {
    presenceOps.pushPoolDrag(this, s)
  }

  private publishDragPresence(s: EditorState): void {
    presenceOps.publishDragPresence(this.presence, this, s)
  }

  /** view-only room (a shared read-only link): editing affordances are inert. Selection,
   * camera, measuring, and running a private sim stay available; transforms/placement don't.
   * (internal - for controller/ modules) */
  get readOnly(): boolean {
    return this.store.getState().readOnly
  }

  gizmoVisible(s: EditorState): boolean {
    return gizmoOps.gizmoVisible(this, s)
  }

  liveCargoSelected(s: EditorState): boolean {
    return cargoOps.liveCargoSelected(this, s)
  }

  /** the one selected running cargo part, or null (multi-selection included) - internal */
  selectedLiveCargo(s: EditorState): PartInstance | null {
    return cargoOps.selectedLiveCargo(this, s)
  }

  /**
   * Every selected running cargo part. Physics owns these bodies, so their authored transform is
   * a stale spawn pose - anything anchored on them (gizmo centre, drag start scene) must read the
   * live pose out of liveCargo instead.
   * (internal - for controller/ modules)
   */
  selectedLiveCargoParts(s: EditorState): PartInstance[] {
    return cargoOps.selectedLiveCargoParts(this, s)
  }

  private liveCargoPose(id: string): LiveCargoPose | null {
    return cargoOps.liveCargoPose(this, id)
  }

  refreshLiveCargo(frame: BoxFrame, s: EditorState): void {
    cargoOps.refreshLiveCargo(this, frame, s)
  }

  /**
   * World point the transform gizmo sits at - and the pivot a yaw rotation orbits:
   * a part's footprint centre, not its data origin. Conveyors are tail-origin for
   * stable multi-segment path math (beltPath); the tail is a storage detail, so the
   * user's handle belongs on the bed centre. `partFootprint.cx` / `cz` are the local
   * origin->centroid offset - set for the straight/spur conveyors and for a part whose
   * bounds declare an off-centre box (the diverter: its origin sits toward its push face);
   * every other part is centred, so this no-ops for it.
   * (internal - for controller/ modules)
   */
  partGizmoCenter(part: PartInstance): [number, number, number] {
    return gizmoOps.partGizmoCenter(this, part)
  }

  /** internal - for controller/ modules */
  pushGizmo(s: EditorState): void {
    gizmoOps.pushGizmo(this, s)
  }

  private trackSelectedBox(frame: BoxFrame): void {
    cargoOps.trackSelectedBox(this, frame)
  }

  private pushResizeHandles(s: EditorState): void {
    gizmoOps.pushResizeHandles(this, s)
  }

  singleRigGizmoId(s: EditorState): string | null {
    return gizmoOps.singleRigGizmoId(this, s)
  }

  private pushRobotGizmo(s: EditorState): void {
    gizmoOps.pushRobotGizmo(this, s)
  }

  // --- live snap controller ----------------------------------------------

  /** internal - for controller/ modules */
  resetSnap(): void {
    snapOps.resetSnap(this.snap)
  }

  /**
   * sticky-join wrapper over core findSnap/findSnapToTarget (the policy: controller/liveSnap.ts).
   * `excludeIds` drops parts from the candidate set: on a group reposition every
   * moving part (active + carried) is excluded so the selection snaps only to
   * external parts, never to its own members (which would fight the rigid carry).
   * (internal - for controller/ modules)
   */
  applyLiveSnap(
    moving: PartInstance,
    proposed: SnapPose,
    alt: boolean,
    excludeIds?: ReadonlySet<string>,
  ): SnapCandidate | null {
    return snapOps.applyLiveSnap(this.snap, this, moving, proposed, alt, excludeIds)
  }

  /** fold the active snap's param overrides into the scene before committing */
  /** Fold the live snap candidate's param overrides (mover resize + target adoption) into `scene`, so a
   *  preview/commit reflects the size the snap will impose - e.g. the stairs' numSteps refit to a platform
   *  deck, without which the structure-cut resolver sees a non-fitting flight and the railing only opens on
   *  commit. An `attach` candidate (a `'face'`-mounted button) also soft-parents the mover under its target -
   *  folded here so the tree shows the attachment live during the gesture (preview == commit), skipped if it
   *  would create a hierarchy cycle. No-op without a candidate or consequences. (internal - for controller/
   *  modules) */
  withSnapOverrides(scene: SceneJSON, movingId: string | null): SceneJSON {
    return snapOps.withSnapOverrides(this.snap, scene, movingId)
  }

  // --- placement -----------------------------------------------------------

  /**
   * Where a part rests when steered under the cursor - the single source of truth for both placement and the
   * Shift+G collision reposition, so a custom (SDK) part is treated identically by both. A `rest: 'surfaceBelow'`
   * part (a legged deck, e.g. the SDK belt conveyor) stands its deck `standHeight` above the surface/floor so its
   * legs reach down to it; every other part rests its footprint on the surface (restOnSurface) or floor
   * (floorRest). Without this shared path, reposition would fall through to restOnSurface and bury a legged
   * deck's underside on the floor instead of standing it on its legs. Returns null when there is no ground under the cursor.
   * (internal - for controller/ modules)
   */
  restUnderCursor(
    part: PartInstance,
    surface: { point: [number, number, number]; normal: [number, number, number]; partId?: string } | null,
    clientX: number,
    clientY: number,
  ): [number, number, number] | null {
    return snapOps.restUnderCursor(this, part, surface, clientX, clientY)
  }

  /**
   * The physics-true plane for a cursor surface hit. The viewport surface set is the padded pick/rest
   * proxy: a conveyor's box top sits partFootprint's +0.05 pad above the real rollers, so anything seated
   * on it floats and then drops when the sim starts. For a bed-top hit (up-ish normal) on a conveying
   * part, re-derive the plane from core's conveying-surface truth at the hit XZ (incline- and belt-profile-
   * aware). Side/flank hits and non-conveyors return the hit unchanged (their proxies are exact).
   * (internal - for controller/ modules)
   */
  trueSurfaceOf(surface: { point: [number, number, number]; normal: [number, number, number]; partId?: string }): {
    point: [number, number, number]
    normal: [number, number, number]
  } {
    return snapOps.trueSurfaceOf(this.store, surface)
  }

  /**
   * One-shot "re-rest" at a move/drop commit (your UX table's Drop/snap event): re-resolve every moved part's
   * `rest: 'surfaceBelow'` param from the surface now beneath it (a downward raycast), so dragging a legged
   * conveyor up grows its legs to reach the floor (or a platform) again. geometry() stays pure - only the
   * host-owned param is rewritten, and the visual reflows from it. Cheap: only the moved parts, only rest params.
   * (internal - for controller/ modules)
   */
  reRestSurfaceParams(scene: SceneJSON, ids: readonly string[]): SceneJSON {
    return snapOps.reRestSurfaceParams(this.view, scene, ids)
  }

  /**
   * Re-resolve one part's `rest: 'surfaceBelow'` param (its leg length, e.g. standHeight) from the surface
   * now beneath it - a downward raycast that excludes `exclude`. Returns the part unchanged when it has no
   * such param or the value already matches. Shared by the placement preview, the reposition transient, and the
   * three commit re-rests so a snap that raises the deck to a neighbour's belt height (a non-default floor
   * plane) grows the legs back down to the floor - live in the preview, not just on commit.
   * (internal - for controller/ modules)
   */
  resurfaceRest(part: PartInstance, exclude: ReadonlySet<string>): PartInstance {
    return snapOps.resurfaceRest(this.view, part, exclude)
  }

  /**
   * Promote one transient spawner box (see promoteCargoBoxes). Returns the promoted id, or null if
   * the oip.box package isn't registered - the caller then falls back to the transient body.
   * (internal - for controller/ modules)
   */
  promoteCargoBox(box: BoxPick): string | null {
    return cargoOps.promoteCargoBox(this, box)
  }

  /**
   * promoteCargoBox over a whole set: every body becomes a part in one scene write instead of one per
   * box (a rubber band over a running line can cover dozens). Ids come from a single allocator pass so
   * they don't collide before the write. Returns the promoted ids (empty if the oip.box package
   * isn't registered).
   *
   * Not a commit: these parts are run-scoped (stop() drops them), so they get no undo entry and no
   * autosave. See store.setRunScene, which also keeps ~10-16 ms of synchronous localStorage writing off
   * the click that selects a moving box.
   * (internal - for controller/ modules)
   */
  promoteCargoBoxes(boxes: readonly BoxPick[]): string[] {
    return cargoOps.promoteCargoBoxes(this, boxes)
  }

  selectBox(box: BoxPick, shift: boolean): void {
    cargoOps.selectBox(this, box, shift)
  }

  // --- pilot mode (first-person walk-around) -------------------------------
  // Implemented in ./controller/pilot.ts; these arrow-fn fields keep stable callback
  // identities for view.setPilotActive (see onStoreChange).

  /** Esc / pointer-lock loss inside pilot mode: drop carried cargo and return to the editor */
  private pilotExit = (): void => pilotOps.pilotExit(this.pilot, this)

  /**
   * Interact button (E / F / click): a ray from the crosshair;
   * carriable cargo under the crosshair wins first, otherwise toggle the
   * hand-operable part there (push button, safety gate, interactive custom part).
   */
  private pilotInteract = (): void => pilotOps.pilotInteract(this.pilot, this)

  /**
   * "Use" (C) for the current selection: operates the device and never edits the scene. Running, the press
   * goes to the part's worker behavior (ctx.used()); stopped, to the device's live session (useSessions), as E does.
   * See pilot.ts useSelection.
   */
  useSelection(): void {
    pilotOps.useSelection(this.pilot, this)
  }

  /** @internal test hook (e2e verify-flex-pull-drawn writes it): the flex conveyor grip the walking character holds */
  get pilotFlex(): pilotOps.PilotState['flex'] {
    return this.pilot.flex
  }

  set pilotFlex(v: pilotOps.PilotState['flex']) {
    this.pilot.flex = v
  }

  /** called once per rendered frame (App onFrame): pilot prompt, idle sweeps, UI mirrors. The PLC
   *  scan doesn't run here: it interleaves with the physics steps inside the sim worker
   *  (sim/plcHost.ts), so control logic is co-timed with physics by construction. */
  tick(dt: number): void {
    const s = this.store.getState()
    pilotOps.updatePilotPrompt(this.pilot, this)
    this.tickUseSessions(dt) // devices a stopped Use is operating (zero cost when there are none)
    // keep the "Following X" viewport badge in sync with the camera's actual follow state - the
    // view can drop follow on its own (freelook/pilot/lost target), so poll rather than push
    this.syncFollowBadge(s)
    // mirror freefly/pilot camera-navigation into state so the viewport toolbar can go pointer-inert
    // while flying (a stray click must not toggle a tool mid-flight). Freefly is a render-layer gesture
    // React can't observe directly, so poll it here like the follow badge. Deduped in the store.
    this.store.setNavigating(this.view.isNavigating())
  }

  private syncFollowBadge(s: EditorState): void {
    cameraOps.syncFollowBadge(this, s)
  }

  /** stop follow mode from the badge's click: reset the F press
   * counter so the next Focus press starts fresh at a one-shot focus */
  stopFollowing(): void {
    cameraOps.stopFollowing(this.camera, this)
  }

  /**
   * Commit a transform the viewport made (gizmo drag, vertex snap, reposition, snap-to-floor) and end
   * the consecutive-F run unless it is following. The count belongs to the selection and a move doesn't change the selection, so without
   * this F, move the part, F would start following instead of re-focusing on where the part now is. An
   * active follow keeps its count: onStoreChange reads it to retarget the follow when the
   * selection changes.
   */
  commitTransform(...args: Parameters<EditorStore['commit']>): void {
    this.store.commit(...args)
    cameraOps.endFocusRun(this.camera)
  }

  /** One "Focus Selection" (F) press (controller/camera.ts focusPress). (internal - for controller/keyboard.ts) */
  focusPress(ids: readonly string[], selectedIds: readonly string[]): void {
    cameraOps.focusPress(this.camera, this.view, ids, selectedIds)
  }

  listSelect(clientX: number, clientY: number, append: boolean): void {
    pointerOps.listSelect(this, clientX, clientY, append)
  }

  /**
   * Snap-to-Floor (PageDown): drop each selected part
   * straight down so its underside rests on the highest surface beneath it, or on
   * the floor (y=0) when nothing else is below. Never raises a part. Multi-select
   * snaps each part independently and skips the rest of the selection as a rest
   * surface.
   */
  snapSelectedToFloor(): void {
    snapOps.snapSelectedToFloor(this)
  }

  // --- VR walkthrough (WebXR) ----------------------------------------------

  /** immersive-vr availability, for gating the toolbar's VR button */
  vrSupported(): Promise<boolean> {
    return this.view.vrSupported()
  }

  /**
   * Enter VR, which is walk mode in a headset: the session presenting enters the walk, the session
   * ending (from the headset or exitVR) leaves it, and leaving the walk ends the session (the view).
   * So a VR walk is a walk session like any other: Use operates and never edits, and carried cargo
   * and hand-cycled devices go back when it ends. `onChange` tracks presenting for button state.
   */
  enterVR(onChange?: (presenting: boolean) => void): Promise<boolean> {
    return this.view.enterVR((presenting) => {
      if (presenting) this.store.enterPilot()
      else this.store.exitPilot()
      onChange?.(presenting)
    })
  }

  exitVR(): void {
    this.view.exitVR()
  }

  // --- ruler (measure tool) ------------------------------------------------

  /** internal - for controller/ modules */
  clearRuler(): void {
    if (!this.rulerVisible) return
    this.view.setRuler(null, null)
    this.rulerVisible = false
  }

  // --- collision reposition (Shift+G) --------------------------------------

  /** The Shift+G gesture in flight (`id` steers, `carried` moves with it), or null. Read across the input modules; e2e
   *  scripts read it too. */
  get reposition(): Readonly<repositionOps.RepositionState['active']> {
    return this.repo.active
  }

  beginReposition(s: EditorState): void {
    repositionOps.beginReposition(this.repo, this, s)
  }

  updateReposition(clientX: number, clientY: number, alt: boolean): void {
    repositionOps.updateReposition(this.repo, this, clientX, clientY, alt)
  }

  /** the wheel turned during the gesture (internal - for controller/pointer.ts onWheel) */
  turnReposition(step: number, alt: boolean): void {
    repositionOps.turnReposition(this.repo, this, step, alt)
  }

  commitReposition(): void {
    repositionOps.commitReposition(this.repo, this)
  }

  cancelReposition(revert = true): void {
    repositionOps.cancelReposition(this.repo, this, revert)
  }

  // --- pointer -------------------------------------------------------------

  private onContextMenu = (e: MouseEvent): void => pointerOps.onContextMenu(this, e)

  // --- vertex snapping -----------------------------------------------------
  // Hold B to arm. Two modes (store.vertexSnapOriginMode):
  //  - Vertex→Vertex (default): the vertex under the cursor on the selection is the
  //    source; LMB-drag translates the whole selection (subtree) so it sits on a
  //    vertex of another part, free-dragging on the camera plane when none is near.
  //  - Origin→Vertex: a single click jumps the selection's origin onto the nearest
  //    scene vertex (no drag).
  // Source geometry is the collision proxy by default ("Snap to Collision Vertices");
  // store.vertexSnapCollision sets the default and holding Shift inverts it live.
  // LMB-up commits, B-up / Esc / RMB cancels.

  armVertexSnap(): void {
    vertexSnapOps.armVertexSnap(this)
  }

  updateVertexSnapSource(clientX: number, clientY: number, shift: boolean): void {
    vertexSnapOps.updateVertexSnapSource(this, clientX, clientY, shift)
  }

  originSnapToVertex(clientX: number, clientY: number, shift: boolean): void {
    vertexSnapOps.originSnapToVertex(this, clientX, clientY, shift)
  }

  beginVertexSnapDrag(e: PointerEvent): boolean {
    return vertexSnapOps.beginVertexSnapDrag(this, e)
  }

  moveVertexSnap(drag: Drag & { kind: 'vertexSnap' }, clientX: number, clientY: number, shift: boolean): void {
    vertexSnapOps.moveVertexSnap(this, drag, clientX, clientY, shift)
  }

  disarmVertexSnap(): void {
    vertexSnapOps.disarmVertexSnap(this)
  }

  private onPointerDown = (e: PointerEvent): void => pointerOps.onPointerDown(this.press, this, e)

  private onPointerMove = (e: PointerEvent): void => pointerOps.onPointerMove(this.press, this, e)

  private onPointerUp = (e: PointerEvent): void => pointerOps.onPointerUp(this.press, this, e)

  private onPointerCancel = (e: PointerEvent): void => pointerOps.onPointerCancel(this.press, this, e)
  // focus leaving mid-drag (Alt-Tab) may take the release with it: cancel the drag, as Escape does
  private readonly onWindowBlur = (): void => dragOps.cancelActiveDrag(this)

  resolveTap(clientX: number, clientY: number, shift: boolean): void {
    pointerOps.resolveTap(this, clientX, clientY, shift)
  }

  // --- catalog placement (pointer-based) -----------------------------------
  // A catalog card captures the pointer on press and forwards move/up here. A
  // press that stays put is a click (enters click-to-place; commit + re-place in
  // the viewport). A press that travels is a drag (the staged preview follows; release
  // over the viewport drops it one-shot). Either way the wheel rotates the preview,
  // since wheel events aren't pointer-captured and still reach onWheel.

  /** The placement-staging session in flight, or null (docs/placement-staging.md). Read by the tutorial and the live snap. */
  get placing(): placementOps.PlacementState['session'] {
    return this.placement.session
  }

  /** @internal test hook (e2e verify-snap-flash-gate / -elevated-legs): the preview last computed under the cursor */
  get placingPreview(): placementOps.PlacingPreview | null {
    return this.placement.preview
  }

  /** @internal test hook (e2e verify-face-snap writes it): the custom part a placement in flight builds */
  get pendingPackageId(): string | null {
    return this.placement.pendingPackageId
  }

  set pendingPackageId(id: string | null) {
    this.placement.pendingPackageId = id
  }

  /** What still references a custom part (human-readable); non-empty blocks deletion. */
  packageUsage(packageId: string): string[] {
    return this.store.packageUsage(packageId)
  }

  /** Delete an authored part from the user library (not a scene edit). A copy shadowing a bundled or
   *  folder part reverts to the shadowed version instead of vanishing. Refused while anything still
   *  references it - check {@link packageUsage} first to tell the user what's blocking. */
  removeUserPackage(packageId: string): boolean {
    return this.store.removeUserPackage(packageId)
  }

  /** Take the app's current version of these built-ins as the project's copies (store.updateFromApp). */
  updateFromApp(packageIds: readonly string[]): string[] {
    return this.store.updateFromApp(packageIds)
  }

  /** Keep this project's version of a built-in the app has updated, and stop asking (storePackages.keepProjectVersion). */
  keepProjectVersion(packageId: string): boolean {
    return keepProjectVersion(this.store, packageId)
  }

  /**
   * Catalog card hovered: warm this part's assets ahead of a possible placement
   * (preload on hover so the drop doesn't block on a cold GLB fetch/decode). Fire-and-forget;
   * the view dedupes per session, so this is safe to call on every card enter. A custom part with no
   * resolvable package can't be built, so it's skipped.
   */
  // `warmPipeline` (hover, WebGPU) also compiles the part's render pipeline off the draw path, not just its
  // assets - so a heavy first-of-its-kind drop (e.g. the belt) doesn't flash invisible while its shader
  // compiles. The idle catalog sweep leaves it false (assets only): pacing all ~30 pipeline compiles behind
  // genuine hover intent, not the background sweep, keeps the sweep cheap. See view.warmPart.
  warmCatalogPart(type: PartType, packageId?: string, warmPipeline = false): void {
    catalogOps.warmCatalogPart(this, type, packageId, warmPipeline)
  }

  /**
   * Idle background sweep: warm every catalog part through the same `warmPart` seam hover uses, so the
   * whole catalog is warm shortly after the scene paints, derived from the registry instead of a
   * hand-maintained model list (which drifts). Three properties keep it off the interactive path:
   *   - deferred behind the scene being painted and its own assets going quiet, so it never competes
   *     with the building or the loaded scene's own parts for bandwidth. `whenAssetsQuiet()` (gltf.ts)
   *     waits for a real lull across models and textures; `modelsSettled()` would not do, since it
   *     snapshots the load cache at call time, which on a fresh load holds only the building's
   *     entries, so the sweep would race the scene's parts (visible as pop-in after the cover lifts);
   *   - Save-Data / metered links skip it entirely (pure speculation) - Electron has no `saveData`, so it
   *     warms aggressively there, exactly the native-asset-pack posture we want;
   *   - paced one part per idle slice, and `warmPart` dedupes, so a hover that races the sweep is a cache
   *     hit (foreground priority via the fetch), never double work.
   * `isCancelled` lets the caller abandon it on unmount / scene switch mid-drain.
   */
  warmCatalog(isCancelled: () => boolean = () => false): Promise<void> {
    return catalogOps.warmCatalog(this, isCancelled)
  }

  /** card pressed: enter placing mode so the staged preview can follow during the press */
  beginCatalogPlace(type: PartType, clientX: number, clientY: number, packageId?: string): void {
    catalogOps.beginCatalogPlace(this.catalogPress, this, type, clientX, clientY, packageId)
  }

  /** pointer moved while a card is held: steer the preview (and feed wheel-rotate) */
  catalogPlaceMove(clientX: number, clientY: number, alt: boolean): void {
    catalogOps.catalogPlaceMove(this.catalogPress, this, clientX, clientY, alt)
  }

  /** card released: a click stays in placing mode, a drag drops one part */
  endCatalogPlace(clientX: number, clientY: number, alt: boolean): void {
    catalogOps.endCatalogPlace(this.catalogPress, this, clientX, clientY, alt)
  }

  /** the press was interrupted (e.g. pointercancel): abandon a drag in flight */
  cancelCatalogPlace(): void {
    catalogOps.cancelCatalogPlace(this.catalogPress, this)
  }

  private onWheel = (e: WheelEvent): void => pointerOps.onWheel(this, e)

  // --- keyboard ------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => keyboardOps.onKeyDown(this, e)

  private onKeyUp = (e: KeyboardEvent): void => keyboardOps.onKeyUp(this, e)
}
