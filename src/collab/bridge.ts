import * as Y from 'yjs'
import type { PartInstance, SceneJSON, SimRate } from '../core/types'
import type { PartPackage } from '../core/parts/partPackage'
import { definitionsUsedBy } from '../core/parts/partPackage'
import { sameController, type Controller } from '../core/controller'
import { carryCargoPose, carryingAncestor, cargoPoseOf, isCargoPart, sameCargoPose, withCargoPose } from '../core/frame'
import { getPackage } from '../core/parts/partRegistry'
import { PackageGate } from './codeTrust'
import { applySceneDiff } from './diff'
import { onRoomAssetsArrived } from './roomAssets'
import {
  appendEditEvent,
  claimRoomBuild,
  docToScene,
  editedPackageIds,
  eventsArray,
  LOCAL_ORIGIN,
  metaMap,
  orderArray,
  packagesMap,
  partsMap,
  readEditFeed,
  readPackages,
  readRoomBuild,
  readSimHz,
  readStDoc,
  ST_CONTROLLER_META,
  PLCS_META,
  DISPLAY_META,
  UNITS_META,
  LENGTH_UNIT_META,
  stProgramText,
  writePackage,
  writeSimHz,
  writeStDoc,
} from './schema'
import type { FeedEvent } from './schema'

/** marks the transaction a program edit runs in, the one kind the room's undo takes the program's text and meta from */
const PROGRAM_EDIT = Symbol('oip-collab-program-edit')

/** a committed edit as the store reports it to the feed (the bridge adds actor + clientID) */
export interface EditEventInput {
  label: string
  time: number
  kind: 'scene' | 'package' | 'program'
  coalesceKey?: string
}

/** a feed entry as handed back to the store for display (client resolved to actor + mine) */
export interface FeedEventView {
  label: string
  time: number
  kind: 'scene' | 'package' | 'program'
  actor: string
  mine: boolean
}

/** undo/redo backed by the shared doc, handed to the store so Ctrl+Z works in a room */
export interface UndoDelegate {
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
}

/** a part's live (uncommitted) pose streamed from a dragging peer (matches session.DragPose) */
export interface DragPose {
  id: string
  position: [number, number, number]
  rotationY: number
  rotationX?: number
  rotationZ?: number
}

/**
 * The live-drag presence channel (Yjs awareness), supplied by the editor in room mode so the
 * bridge can render peers' in-progress drags on top of the committed scene without routing
 * the high-frequency poses through the persisted doc.
 */
export interface PresenceSource {
  /** fire `cb` whenever any peer's awareness changes (drag poses included) */
  subscribe(cb: () => void): () => void
  /** parts other peers are dragging right now, keyed by part id */
  remoteDragPoses(): Map<string, DragPose>
  /** true while this client is dragging (then the local drag owns the view, not remote overrides) */
  isLocalDragging(): boolean
}

/**
 * The slice of the EditorStore the bridge needs. Declared structurally (rather than importing
 * EditorStore) so the collab module depends only on `core`, keeping the project-reference
 * graph acyclic - the editor imports collab, never the reverse.
 */
export interface BridgeStore {
  /** `running` is this client's private sim preview (see {@link authoredCargoView} for why the bridge reads it) */
  /** `stScanMs` is the program's scan time as the store holds it, after it adopted the room's (it rounds on the way in) */
  /** `packageEdit` is the Part Editor's session: while it is open `scene` is the part alone and the line is `document` */
  getState(): {
    scene: SceneJSON
    selectedIds: readonly string[]
    running: boolean
    stScanMs?: number
    userPackages?: readonly PartPackage[]
    packageEdit?: { document: SceneJSON } | null
  }
  subscribe(cb: () => void): () => void
  applyRemote(scene: SceneJSON): void
  setTransient(scene: SceneJSON): void
  selectMany(ids: readonly string[]): void
  setUndoDelegate(delegate: UndoDelegate | null): void
  /** register custom-part packages received from a peer (render + Inspector + catalog); `edited` names the room
   *  entries that are edits rather than snapshots (schema.editedPackageIds); `removed`, the parts a peer deleted. */
  applyRemotePackages(pkgs: PartPackage[], edited?: ReadonlySet<string>, removed?: readonly string[]): void
  /** install the writers the store calls on a committed package edit / new authored part, and on a deleted part. */
  setPackageSink(sink: ((pkg: PartPackage) => void) | null, remove?: (id: string, revertTo: PartPackage | null) => void): void
  /** install the writer the store calls with the label of every committed edit (the shared feed). */
  setEditEventSink(sink: ((e: EditEventInput) => void) | null): void
  /** hand the store the room's edit feed for the History dock (called on every feed change). */
  applyRemoteEditFeed(events: FeedEventView[]): void
  /** install the writer that keeps a program change (room mode: the shared Y.Text + meta). */
  setStProgramSink(sink: ((doc: { source: string; scanMs: number; controller: Controller | null; dialect?: string }) => void) | null): void
  /** install the transaction a program edit runs in, so the room's undo reverts it as one step. See store.commitProgram. */
  setProgramTransaction(run: ((apply: () => void) => void) | null): void
  /** hand the store the room's shared PLC program (join + every later change). See store. `dialect` null = IEC. */
  applyRemoteStProgram(source: string, scanMs?: number, controller?: Controller | null, dialect?: string | null): void
  /** install the writer that keeps a physics step-rate change (room mode: the `meta` simHz key). */
  setSimHzSink(sink: ((hz: SimRate) => void) | null): void
  /** hand the store the room's physics step rate (join + every later change). See store. */
  applyRemoteSimHz(hz: SimRate): void
  /** a newer build of the app has joined the room: go view-only and say why (see ROOM_BUILD_META). Optional so a
   *  test store that does not care about builds need not stub it. */
  yieldToNewerBuild?(): void
}

/**
 * A fingerprint of the poses currently being dragged by peers. Awareness fires once per FIELD, and a
 * dragging peer publishes `drag` AND `cursor` every frame - so half the ticks carry no new pose. This
 * lets the bridge skip rebuilding a display scene that would come out identical.
 */
function dragKey(drags: Map<string, DragPose>): string {
  let k = ''
  for (const d of drags.values()) {
    k += `${d.id}:${d.position[0]},${d.position[1]},${d.position[2]},${d.rotationY},${d.rotationX ?? 0},${d.rotationZ ?? 0};`
  }
  return k
}

/** the committed scene with each dragging peer's part swapped to its live pose (for display only) */
export function overrideScene(base: SceneJSON, drags: Map<string, DragPose>): SceneJSON {
  if (drags.size === 0) return base
  return {
    ...base,
    parts: base.parts.map((p) => {
      const d = drags.get(p.id)
      if (!d) return p
      const np = { ...p, position: [d.position[0], d.position[1], d.position[2]], rotationY: d.rotationY } as PartInstance
      if (d.rotationX) np.rotationX = d.rotationX
      else delete np.rotationX
      if (d.rotationZ) np.rotationZ = d.rotationZ
      else delete np.rotationZ
      return np
    }),
  }
}

/**
 * The local scene as the shared doc should see it while this client runs its own private sim.
 *
 * "Shared design, personal run" (docs/collab.md): each client runs its own sim off the shared
 * scene, so sim runtime must not propagate. Cargo breaks that rule, because handling a live box
 * goes through `store.commit` like any authoring edit. Grabbing a spawner box (click, band-select,
 * pilot pick-up) promotes it into a real part. Dragging a running box commits the pose physics gave
 * it, and injecting or duplicating cargo mid-run adds more. All of it is run-scoped, and the
 * controller drops it on Stop. Without this view the commit reaches the doc first, and a peer who
 * never pressed Play receives our physics state as an authored edit: phantom boxes in their scene,
 * and their boxes moved to wherever our belt carried them.
 *
 * So while running, the doc's cargo pose is frozen. A cargo id the doc already holds keeps the doc's
 * position and rotation (physics owns where a box is mid-run, core/frame CargoPose), and one it
 * doesn't hold never arrives. Everything else still propagates live: a box's settings (size, colour,
 * mass) are authoring, and so is moving a conveyor mid-run. The editor store draws the same line for
 * the solo document (the store's RunOwnership, storeDocument.ts; docs/document-and-run.md).
 *
 * One pose change is authoring: a box carried by an ancestor this change moved (a pallet-load group
 * dragged mid-run). Its doc pose follows the ancestor's rigid motion, so peers see the load move with
 * its group and Stop re-asserts it there. Seeing that takes `prevLocal`, the local scene this change
 * started from; without it nothing is treated as carried.
 */
export function authoredCargoView(local: SceneJSON, doc: SceneJSON, prevLocal?: SceneJSON): SceneJSON {
  const docCargo = new Map<string, PartInstance>()
  for (const p of doc.parts) if (isCargoPart(p)) docCargo.set(p.id, p)
  const docIds = new Set(doc.parts.map((p) => p.id))
  const prevById = prevLocal ? new Map(prevLocal.parts.map((p) => [p.id, p])) : null
  const localById = prevById ? new Map(local.parts.map((p) => [p.id, p])) : null
  // an ancestor whose own move counts as authoring: not another box (moving that is operating) and not run-local
  const skip = (id: string): boolean => docCargo.has(id) || !docIds.has(id)
  let changed = false
  const parts: PartInstance[] = []
  for (const p of local.parts) {
    if (!isCargoPart(p)) {
      parts.push(p)
      continue
    }
    const authored = docCargo.get(p.id)
    if (authored === undefined) {
      changed = true // born this run (promoted / injected / duplicated): never enters the doc
      continue
    }
    // the doc's pose (carried along if an ancestor's move took the box with it), our everything-else
    let pose = cargoPoseOf(authored)
    const was = prevById?.get(p.id)
    if (was && localById && !sameCargoPose(cargoPoseOf(was), cargoPoseOf(p))) {
      const by = carryingAncestor(p.id, prevById!, localById, skip)
      if (by) pose = carryCargoPose(pose, by.before, by.after)
    }
    const kept = withCargoPose(p, pose)
    if (kept !== p) changed = true
    parts.push(kept)
  }
  return changed ? { ...local, parts } : local
}

/**
 * The doc's scene with this client's run-local cargo merged back in - the mirror of
 * {@link authoredCargoView}. Without it a peer's edit landing mid-run would rebuild our scene from
 * the doc and delete the boxes our own physics is still stepping, leaving their bodies dangling
 * (the sim frame reports part ids the scene no longer has).
 */
export function withRunLocalCargo(doc: SceneJSON, local: SceneJSON): SceneJSON {
  const known = new Set(doc.parts.map((p) => p.id))
  const runLocal = local.parts.filter((p) => !known.has(p.id) && isCargoPart(p))
  return runLocal.length === 0 ? doc : { ...doc, parts: [...doc.parts, ...runLocal] }
}

/** The line as the store holds it: the scene, or the scene parked while the Part Editor is open. */
const documentOf = (s: ReturnType<BridgeStore['getState']>): SceneJSON => s.packageEdit?.document ?? s.scene

/** a run of the line: a run in the Part Editor tests the part, and the room's scene is not in it */
const lineRunning = (s: ReturnType<BridgeStore['getState']>): boolean => s.running && !s.packageEdit

/**
 * Two-way bridge between the EditorStore and a collaborative Y.Doc.
 *
 * store -> doc: subscribe to the store's React channel (which by design excludes every
 *   transient - gizmo drags, manipulator motion, momentary button pulses, and sim-runtime
 *   mutations), and on a scene-identity change diff prev vs next into minimal Yjs ops inside
 *   a `LOCAL_ORIGIN` transaction. Only committed structural intent is synced.
 *
 * doc -> store: on a foreign transaction, rebuild the whole SceneJSON and hand it to
 *   `store.applyRemote` (no undo/persist), then prune any vanished ids from the selection.
 *
 * Echo prevention is two-layered: (1) the doc observer ignores `LOCAL_ORIGIN` transactions
 * (our own writes); (2) `applyingRemote` makes the store->doc handler a no-op while we are
 * applying a remote scene, so the resulting store notification doesn't re-diff/re-write.
 */
export class CollabBridge {
  /** the doc-facing scene we last diffed against, cargo-masked while running (see authoredCargoView) */
  private prevScene: SceneJSON
  /** the raw store scene behind `prevScene`, so an unchanged store notification still short-circuits in O(1) */
  private prevRaw: SceneJSON
  /** last seen local run state, to catch the Stop edge (see pushToDoc) */
  private wasRunning: boolean
  /** last seen Part Editor state, to catch it opening and closing (see pushToDoc) */
  private wasEditingPart: boolean
  /** the room's edited package ids as last seen, so an id that leaves it is a part someone deleted */
  private lastEdited = new Set<string>()
  private applyingRemote = false
  private unsubStore: () => void
  /** set once nothing from this client can reach the doc any more: view-only from the start, or a newer build joined */
  private writesStopped = false
  /** watches the room's build claim; null when this client does not check builds (a viewer, or no build stamp) */
  private buildObserver: (() => void) | null = null
  private readonly afterTxn: (txn: Y.Transaction) => void
  /**
   * Scene undo, scoped to this client's edits (trackedOrigins = LOCAL_ORIGIN). A per-client
   * snapshot undo would revert peers' concurrent edits; the Y.UndoManager merges correctly,
   * undoing only your own changes. Typing in the ST text has its own undo via y-codemirror.next;
   * this one also tracks the program's text and meta atoms, but only in a transaction marked as a
   * program edit (store.commitProgram), so an organizer edit, its code and its rewiring undo as one
   * step while a load or a step-rate change stays out of undo. captureTimeout 0 → one step per edit.
   */
  private readonly undoManager: Y.UndoManager | null
  // true while the view is showing a remote peer's in-progress drag (a transient override of
  // the committed scene); cleared back to the authoritative scene when the drag ends
  private overriding = false
  /**
   * Memo of `docToScene(ydoc)`, dropped whenever the doc changes. A peer's drag re-renders the
   * committed scene with their live poses on top at 60 Hz. The doc does not change during the drag,
   * only the ephemeral overlay does, so decoding all of Yjs each time is wasted work.
   */
  private docSceneCache: SceneJSON | null = null
  /** the drag poses last rendered, so an awareness tick carrying no new pose is a no-op */
  private lastDragKey = ''
  /** pending animation-frame handle for the coalesced presence re-render (0 = none scheduled) */
  private presenceRaf = 0
  private readonly unsubPresence: (() => void) | undefined
  // deep observer on the packages map: a peer's authored/edited custom-part package (geometry + behavior)
  private readonly packagesObserver: (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, txn: Y.Transaction) => void
  private readonly unsubAssets: () => void
  private readonly unsubGate: () => void
  // observer on the shared edit feed - fires for local AND remote appends (both update the History dock)
  private readonly feedObserver: () => void
  // observers on the shared PLC program (its Y.Text) and its scan time (a `meta` key). Both flow
  // into store state, so the program the controller attaches is always the room's current one -
  // including one that lands after a slow join, which would otherwise leave the client running an
  // empty program until Stop/Play.
  private readonly stObserver: () => void
  /** the scan time the store held right after it last took the room's in: a program write compares with this */
  private adoptedScanMs: number | undefined
  // observer on the room's physics step rate (the `meta` simHz key), mirrored into store state
  private readonly simHzObserver: () => void

  constructor(
    private readonly store: BridgeStore,
    private readonly ydoc: Y.Doc,
    private readonly presence?: PresenceSource,
    // view-only link: never write to the shared doc. The store also drops authoring commits
    // (store.setReadOnly); this is the independent guarantee that no local change can mutate
    // the room. doc -> store and presence still flow, so a viewer sees the live scene + peers.
    readOnly = false,
    // the local display name stamped onto feed events at write time (defaults keep tests terse)
    private readonly getActor: () => string = () => 'Someone',
    // decides whose part CODE may run here (see codeTrust.ts). Every package the doc hands the store goes
    // through it. The default trusts no code but this client's own, so a caller that omits it gets the safe behaviour.
    private readonly gate: PackageGate = new PackageGate(),
    // this build's stamp (vite.config.ts __BUILD_TIME__): given, an editor claims the room for its build and goes
    // view-only when a newer build has claimed it (see ROOM_BUILD_META). Absent (tests, a build without git), no check.
    build?: number,
  ) {
    this.prevScene = documentOf(store.getState())
    this.prevRaw = this.prevScene
    this.wasRunning = lineRunning(store.getState())
    this.wasEditingPart = !!store.getState().packageEdit

    // doc -> store: one rebuild per foreign transaction that moved the scene. The scene is decoded
    // from exactly these three types (docToScene), so a transaction that touched none of them cannot
    // have changed it. The others each have a narrow observer below: the edit feed, the shared ST
    // program's Y.Text, and the `meta` keys (scan time, step rate, build claim).
    //
    // The filter matters. The room's ST program is co-edited text, and y-codemirror writes one
    // transaction per keystroke. Rebuilding on each of them is a full docToScene + applyRemote: ~9 ms
    // on the demo scene (204 parts, 21 packages) on every client in the room, before any React or
    // viewport work. That includes the typist's own machine, because CodeMirror's binding writes under
    // its own origin, not LOCAL_ORIGIN, so the echo guard below does not catch it.
    const sceneTypes = [partsMap(ydoc), orderArray(ydoc), packagesMap(ydoc)]
    // ...plus four keys of `meta`, the scene's Units, Length, controllers and display list (schema.ts UNITS_META,
    // LENGTH_UNIT_META, PLCS_META, DISPLAY_META); the rest
    // of meta has its own observers
    const meta = metaMap(ydoc)
    const movedScene = (txn: Y.Transaction): boolean => {
      for (const t of txn.changedParentTypes.keys()) if ((sceneTypes as readonly unknown[]).includes(t)) return true
      // (a loop, not a spread: this runs on every transaction, one per keystroke in the room's program)
      for (const [t, keys] of txn.changed) if ((t as unknown) === meta && (keys.has(UNITS_META) || keys.has(LENGTH_UNIT_META) || keys.has(PLCS_META) || keys.has(DISPLAY_META))) return true
      return false
    }
    this.afterTxn = (txn: Y.Transaction): void => {
      // the memo is invalid after any scene write, including our own - checked before the origin
      // early-out below, which decides whether to re-render, not whether the doc moved
      if (!movedScene(txn)) return
      this.docSceneCache = null
      if (txn.origin === LOCAL_ORIGIN) return
      this.applyDisplay(true)
    }
    ydoc.on('afterTransaction', this.afterTxn)

    // doc -> store for the shared edit feed. Set up regardless of readOnly (a viewer sees the
    // feed) and NOT filtered on origin (our own appends update the panel through the same path).
    this.feedObserver = (): void => this.syncFeedFromDoc()
    eventsArray(ydoc).observe(this.feedObserver)
    this.syncFeedFromDoc() // adopt the feed already in the doc at join time

    // live-drag presence: re-render peers' in-progress drags, at most once per displayed frame
    this.unsubPresence = presence?.subscribe(() => this.schedulePresenceDisplay())

    // doc -> store for custom-part PACKAGES (geometry + behavior script). Set up regardless of readOnly:
    // a viewer must still receive peers' authored parts to render them. Ignores our own (LOCAL_ORIGIN) writes.
    // A package arrives ADMITTED: its code only if this client trusts it (codeTrust.ts), viewers included.
    this.packagesObserver = (_events, txn): void => {
      if (txn.origin === LOCAL_ORIGIN) {
        this.lastEdited = editedPackageIds(this.ydoc) // our own part is a delete to notice later, our own delete not news
        return
      }
      this.syncPackagesFromDoc()
    }
    packagesMap(ydoc).observeDeep(this.packagesObserver)
    this.syncPackagesFromDoc() // adopt any packages already in the doc at join time

    // The user allowed the room's code: register what was held, then re-materialize the scene so its embedded
    // packages carry the real code too (the sim reads those when the registry lacks one).
    let trusted = gate.trusted
    this.unsubGate = gate.subscribe(() => {
      if (trusted || !gate.trusted) return
      trusted = true
      this.docSceneCache = null
      this.syncPackagesFromDoc()
      this.applyDisplay(true)
    })

    // A package whose model was not here yet was left out of the room's read (roomAssets.ts); when the bytes land,
    // read the packages and the scene again so its parts appear.
    this.unsubAssets = onRoomAssetsArrived(() => {
      this.docSceneCache = null
      this.syncPackagesFromDoc()
      this.applyDisplay(true)
    })

    // doc -> store for the shared PLC program. Set up regardless of readOnly (a viewer runs its own
    // private sim off the room's logic) and NOT filtered on origin: a local keystroke reaches the
    // Y.Text through CodeMirror's binding, not through our sink, so this is how state learns of it.
    // The store's own equality check absorbs the echo.
    this.stObserver = (): void => this.syncStProgramFromDoc()
    stProgramText(ydoc).observe(this.stObserver)
    metaMap(ydoc).observe(this.stObserver)
    this.syncStProgramFromDoc() // adopt the program already in the doc at join time

    // doc -> store for the scene's physics step rate, the same shape as the program and for the same
    // reason it includes viewers: every peer steps its own world, so they must all step it at one rate
    this.simHzObserver = (): void => this.store.applyRemoteSimHz(readSimHz(this.ydoc))
    metaMap(ydoc).observe(this.simHzObserver)
    this.simHzObserver() // adopt the room's rate at join time

    // The build check. A room a newer build has joined may hold what this build cannot read, and every write-back
    // path of an older build loses what it could not: so this client watches instead of writing, and the store says
    // why. At join that is a view-only start; later (a newer tab joins while this one is open) it is stopWriting().
    if (build !== undefined && !readOnly) {
      const room = readRoomBuild(ydoc)
      if (room !== undefined && room > build) {
        store.yieldToNewerBuild?.()
        readOnly = true
      } else {
        claimRoomBuild(ydoc, build)
        this.buildObserver = (): void => this.checkBuild(build)
        metaMap(ydoc).observe(this.buildObserver)
      }
    }

    if (readOnly) {
      // no store -> doc push and no undo writer: this client only ever reads the shared doc
      this.writesStopped = true
      this.unsubStore = () => {}
      this.undoManager = null
      return
    }

    // store -> doc for the PLC program: a wholesale replacement (import, scene switch, demo) or a
    // scan-time edit. Ordinary typing does not come through here - CodeMirror writes the Y.Text
    // directly, which is what makes two people editing the program merge instead of clobber.
    //
    // The store hands over the whole program document on every program commit (Assign I/O, a rename, a scan-time
    // edit). So the table and the scan time go to the room only when this client changed them, compared with the
    // room's value as the store adopted it. The doc observer applies a remote change synchronously, so the room as
    // it reads now is what the store last took in. Writing them back unconditionally would lose data when two builds
    // share a room. A table this client cannot read (a newer build's) would be adopted as none and written back as
    // none, deleting it for everyone on the next unrelated program edit. A readable one would lose the fields this
    // build does not know. A scan time would lose whatever the store rounds away on adopting it (2.5 ms back as 3).
    store.setStProgramSink(({ source, scanMs, controller, dialect }) => {
      const room = readStDoc(this.ydoc)
      // a table the room holds that this client cannot read is not this client's to replace, whatever it holds
      const unreadable = metaMap(this.ydoc).get(ST_CONTROLLER_META) !== undefined && room.controller === null
      const table = unreadable || sameController(controller, room.controller) ? undefined : controller
      // the scan time as the store took it from the room, not the room's own value: the store rounds on the way in
      const scan = room.scanMs !== undefined && scanMs === this.adoptedScanMs ? undefined : scanMs
      // the dialect only when this client changed it: every client reads any dialect string, so the store's copy is
      // the room's until a wholesale load here replaces the program (null takes the room back to IEC)
      const lang = (dialect ?? undefined) === room.dialect ? undefined : (dialect ?? null)
      writeStDoc(this.ydoc, source, scan, undefined, table, lang)
    })
    // store -> doc for the scene's step rate (the Inspector's scene properties)
    store.setSimHzSink((hz) => writeSimHz(this.ydoc, hz))

    // store -> doc for packages: the store calls this on a committed package edit or a new authored part
    store.setPackageSink(
      (pkg) => this.pushPackage(pkg),
      (id, revertTo) => this.removePackage(id, revertTo),
    )

    // store -> doc for the edit feed: the store reports every committed edit's label here
    store.setEditEventSink((e) => this.pushEvent(e))

    // store -> doc
    this.unsubStore = store.subscribe(() => this.pushToDoc())

    // packagesMap is tracked too, so Ctrl+Z reverts a custom-part behavior/geometry edit in a room exactly
    // like a scene edit. The revert is a non-LOCAL_ORIGIN transaction, so it flows back through the packages
    // observer → syncPackagesFromDoc → registry, and propagates to peers like any other doc change.
    // (`movedScene` is the rebuild filter above: what the scene is decoded from, so a change to the scene's settings
    // in meta, such as the display list, is a step too.)
    this.undoManager = new Y.UndoManager([...sceneTypes, stProgramText(ydoc), metaMap(ydoc)], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
      captureTransaction: (tr) => tr.meta.get(PROGRAM_EDIT) === true || movedScene(tr),
    })
    // a program edit's code, table and rewiring land in one marked transaction: one step for the undo above
    store.setProgramTransaction((apply) =>
      ydoc.transact((tr) => {
        tr.meta.set(PROGRAM_EDIT, true)
        apply()
      }, LOCAL_ORIGIN),
    )
    const undo = this.undoManager
    store.setUndoDelegate({
      undo: () => undo.undo(),
      redo: () => undo.redo(),
      canUndo: () => undo.undoStack.length > 0,
      canRedo: () => undo.redoStack.length > 0,
    })
  }

  private pushToDoc(): void {
    if (this.applyingRemote) return
    const state = this.store.getState()
    // The Part Editor opening or closing. While it is open the line is parked in the store, and only a peer changes it
    // (applyAuthoritative puts their edits there): the session's own edits are package edits, which the package sink
    // carries. Each edge re-asserts the room's scene rather than diffing, so a peer's drag that was on screen as the
    // editor opened is never written to the room as an edit.
    const editing = !!state.packageEdit
    if (editing !== this.wasEditingPart) {
      this.wasEditingPart = editing
      this.overriding = false
      this.applyAuthoritative(true)
      return
    }
    if (editing) return
    const { scene: raw, running } = state
    // The Stop edge: our private run is over, so the doc's cargo is the truth again. Re-assert it
    // instead of letting the run's leftovers (this run's boxes, poses physics moved) ride out on the
    // next unrelated commit - that would land as a delayed, unexplained teleport for every peer.
    // Stop's own drop of run-scoped boxes runs right after this and finds nothing left to remove.
    if (this.wasRunning && !running) {
      this.wasRunning = false
      this.overriding = false
      this.applyAuthoritative(true)
      return
    }
    this.wasRunning = running
    if (raw === this.prevRaw) return
    const prevRaw = this.prevRaw
    this.prevRaw = raw
    // prevRaw lets a box carried by a group moved mid-run follow it into the doc (see authoredCargoView)
    const next = running ? authoredCargoView(raw, this.docScene(), prevRaw) : raw
    const prev = this.prevScene
    this.prevScene = next
    this.ydoc.transact(() => {
      applySceneDiff(this.ydoc, prev, next)
      this.syncReferencedPackages(next)
    }, LOCAL_ORIGIN)
  }

  /** store -> doc: write one committed package (only its changed fields). LOCAL_ORIGIN so we ignore the echo. */
  private pushPackage(pkg: PartPackage): void {
    // A held package's stand-in code is swapped back for its author's, so a data edit made here can't erase it.
    const out = this.gate.docForm(pkg)
    // Code this client AUTHORED (a new part, or a script it changed) is its own from now on, so a peer's later copy
    // of it is nothing new to trust. A data edit re-sends code someone else wrote, which stays theirs.
    const inRoom = packagesMap(this.ydoc).get(pkg.id)?.get('behavior')
    if (out === pkg && pkg.behavior !== inRoom) this.gate.noteOwn(pkg.behavior)
    // an edit, not a snapshot: for a built-in part it is a fork, and must win over every peer's own copy
    this.ydoc.transact(() => writePackage(packagesMap(this.ydoc), out, { edited: true }), LOCAL_ORIGIN)
  }

  /**
   * store -> doc: a deleted part leaves the room, or goes back to a snapshot of the app's version while it is still
   * placed (`revertTo`). Either way it stops being an edit, which is how a peer's bridge tells it was deleted.
   */
  private removePackage(id: string, revertTo: PartPackage | null): void {
    this.ydoc.transact(() => {
      const map = packagesMap(this.ydoc)
      if (!revertTo) return void map.delete(id)
      writePackage(map, revertTo)
      map.get(id)?.delete('edited')
    }, LOCAL_ORIGIN)
  }

  /** store -> doc: append a committed edit's label to the shared feed, stamped with who wrote it */
  private pushEvent(e: EditEventInput): void {
    const event: FeedEvent = {
      label: e.label,
      time: e.time,
      kind: e.kind,
      actor: this.getActor(),
      client: this.ydoc.clientID,
    }
    if (e.coalesceKey !== undefined) event.ck = e.coalesceKey
    this.ydoc.transact(() => appendEditEvent(eventsArray(this.ydoc), event), LOCAL_ORIGIN)
  }

  /** doc -> store: the room's shared PLC program + scan time (see the observers in the constructor) */
  private syncStProgramFromDoc(): void {
    const { source, scanMs, controller, dialect } = readStDoc(this.ydoc)
    // null, not undefined, for a room with none: an IEC room makes an IEC program here, never "keep what you had"
    this.store.applyRemoteStProgram(source, scanMs, controller, dialect ?? null)
    this.adoptedScanMs = this.store.getState().stScanMs
  }

  /** doc -> store: hand the panel the feed, with each entry's clientID resolved to actor + mine */
  private syncFeedFromDoc(): void {
    const myId = this.ydoc.clientID
    this.store.applyRemoteEditFeed(
      readEditFeed(this.ydoc).map((e) => ({ label: e.label, time: e.time, kind: e.kind, actor: e.actor, mine: e.client === myId })),
    )
  }

  /**
   * Make sure every definition the scene uses is in the room: each custom part's, and what those name (a spawner's
   * product, a unit load's pieces), which whoever presses Play needs. Authored parts and edits already arrive
   * through the package sink; this is the safety net for a part PLACED from a package that never went through the
   * sink (e.g. one a desktop user loaded from a parts folder, or pasted from another project). Only writes packages
   * the doc is MISSING - never overwrites a sink-pushed/edited version with a placement snapshot.
   */
  private syncReferencedPackages(scene: SceneJSON): void {
    const map = packagesMap(this.ydoc)
    for (const pkg of definitionsUsedBy(scene.parts, getPackage)) {
      const id = pkg.id
      if (map.has(id)) continue
      const out = this.gate.docForm(pkg) // never a held package's stand-in
      // a part this client brought (its project's parts, a parts folder), not a room package it is restoring
      if (out === pkg && !this.gate.cameFromRoom(id)) this.gate.noteOwn(pkg.behavior)
      // a part from this client's own library (authored, or a built-in it forked) is an edit; anything else placed
      // here is a snapshot, which a peer's own copy of a built-in beats
      const mine = this.store.getState().userPackages?.some((u) => u.id === id) ?? false
      writePackage(map, out, { edited: mine })
    }
  }

  /**
   * doc -> store: register the packages whose ADMITTED form actually differs from what's registered locally. The
   * id-keyed JSON compare keeps a peer's no-op or our own already-applied change from re-registering (which
   * would needlessly rebuild every instance's visual), and guarantees convergence - once applied, the
   * registry holds the exact object we compared against, so the next observation is a no-op. Comparing the
   * admitted form (not the doc's) is what keeps a held package from re-registering on every observation.
   */
  private syncPackagesFromDoc(): void {
    const changed = this.gate.review(readPackages(this.ydoc)).filter((p) => {
      const cur = getPackage(p.id)
      return cur === undefined || JSON.stringify(cur) !== JSON.stringify(p)
    })
    const edited = editedPackageIds(this.ydoc)
    const removed = [...this.lastEdited].filter((id) => !edited.has(id))
    this.lastEdited = edited
    if (changed.length > 0 || removed.length > 0) this.store.applyRemotePackages(changed, edited, removed)
  }

  /**
   * Render the current display scene. With a peer mid-drag, that's the committed scene with
   * their parts swapped to the live poses - pushed as a transient (which never re-enters the
   * doc), so a 60 Hz drag stream costs zero doc ops. Otherwise it's the authoritative scene
   * via applyRemote. `structural` (a doc change, vs an awareness-only change) also prunes the
   * selection of any deleted parts.
   */
  private applyDisplay(structural: boolean): void {
    // a live local drag already drives the view via the controller's own transients
    if (this.presence?.isLocalDragging()) return
    // the Part Editor shows the part alone: a peer's drag has nothing to draw there, and their edits go to the parked line
    if (this.store.getState().packageEdit) {
      if (structural) this.applyAuthoritative(true)
      return
    }

    const drags = this.presence?.remoteDragPoses()
    if (drags && drags.size > 0) {
      // Awareness fires per FIELD, so a dragging peer's own cursor stream doubles the tick rate,
      // and every other peer's cursor adds more. Rebuilding the display scene for a tick that
      // moved nothing costs a full store update + re-render for an identical picture - with a
      // 120-part scene that alone took the observer from 60 fps to 8. Render only real motion.
      const key = dragKey(drags)
      if (!structural && this.overriding && key === this.lastDragKey) return
      this.lastDragKey = key
      this.store.setTransient(overrideScene(this.runMerged(this.docScene()), drags))
      this.overriding = true
      return
    }
    this.lastDragKey = ''
    // no active remote drag: re-assert the authoritative scene, but only when something
    // actually changed (a doc edit, or a drag we were overriding just ended) - not on every
    // remote cursor twitch
    if (!structural && !this.overriding) return
    this.overriding = false
    this.applyAuthoritative(structural)
  }

  /** push the doc's scene (plus our run-local cargo) into the store as the authoritative one */
  private applyAuthoritative(structural: boolean): void {
    const scene = this.runMerged(this.docScene())
    this.applyingRemote = true
    try {
      this.store.applyRemote(scene)
      const raw = documentOf(this.store.getState())
      this.prevRaw = raw
      // what the DOC now holds, which is `scene` minus the run-local cargo we just merged back in
      this.prevScene = lineRunning(this.store.getState()) ? authoredCargoView(raw, this.docScene()) : raw
      // a remote delete may have removed parts this client had selected (in the Part Editor, the selection is the part's)
      if (structural && !this.store.getState().packageEdit) {
        const present = new Set(scene.parts.map((p) => p.id))
        const sel = this.store.getState().selectedIds
        const pruned = sel.filter((id) => present.has(id))
        if (pruned.length !== sel.length) this.store.selectMany(pruned)
      }
    } finally {
      this.applyingRemote = false
    }
  }

  /** the doc's scene as this client must SEE it: with our own run's cargo kept (see withRunLocalCargo) */
  private runMerged(doc: SceneJSON): SceneJSON {
    return lineRunning(this.store.getState()) ? withRunLocalCargo(doc, this.store.getState().scene) : doc
  }

  /**
   * Coalesce presence-driven re-renders onto the animation frame. A peer's drag arrives as a
   * stream of WebSocket messages at their pointer's rate, each handled in its own task. Applying
   * every one runs several rebuilds per displayed frame, and all but the last are overwritten
   * before anyone sees them. Rendering the newest pose once per frame gives the same picture for a
   * fraction of the work. It also scales with the client: one that paints 10 fps does 10 rebuilds a
   * second instead of 60, rather than starving its frame loop.
   *
   * Falls back to applying inline where there is no frame clock (tests, non-DOM hosts).
   */
  private schedulePresenceDisplay(): void {
    if (typeof requestAnimationFrame !== 'function') {
      this.applyDisplay(false)
      return
    }
    if (this.presenceRaf !== 0) return
    this.presenceRaf = requestAnimationFrame(() => {
      this.presenceRaf = 0
      this.applyDisplay(false)
    })
  }

  /** the committed scene as the doc holds it (its embedded packages admitted), decoded at most once per doc change */
  private docScene(): SceneJSON {
    if (this.docSceneCache === null) this.docSceneCache = this.gate.admitScene(docToScene(this.ydoc))
    return this.docSceneCache
  }

  /**
   * A newer build claimed the room while this client was editing it. Everything this client writes to the doc stops
   * (the scene push, every sink, undo), and the doc -> store side keeps running, so it becomes what a view-only
   * link is. The ST editor is the one exception: a mounted one writes its text straight into the shared Y.Text, and
   * it only reads view-only when it mounts. Text is the one thing an older build cannot damage.
   */
  private stopWriting(): void {
    if (this.writesStopped) return
    this.writesStopped = true
    this.unsubStore()
    this.unsubStore = () => {}
    this.store.setPackageSink(null)
    this.store.setEditEventSink(null)
    this.store.setStProgramSink(null)
    this.store.setProgramTransaction(null)
    this.store.setSimHzSink(null)
    this.store.setUndoDelegate(null)
    this.undoManager?.destroy()
  }

  /** the room's build claim moved: yield to a newer build, or re-assert this one if an older claim won the race */
  private checkBuild(build: number): void {
    const room = readRoomBuild(this.ydoc)
    if (room !== undefined && room > build) {
      this.stopWriting()
      this.store.yieldToNewerBuild?.()
      return
    }
    // Two claims made at once resolve by the map's last-writer-wins, which can keep the OLDER one; the newest
    // editor re-asserts, and the older, seeing it, yields. Converges on the newest build present.
    if (!this.writesStopped && (room === undefined || room < build)) claimRoomBuild(this.ydoc, build)
  }

  destroy(): void {
    this.stopWriting()
    if (this.buildObserver) metaMap(this.ydoc).unobserve(this.buildObserver)
    this.unsubPresence?.()
    if (this.presenceRaf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.presenceRaf)
    this.ydoc.off('afterTransaction', this.afterTxn)
    packagesMap(this.ydoc).unobserveDeep(this.packagesObserver)
    this.unsubGate()
    this.unsubAssets()
    eventsArray(this.ydoc).unobserve(this.feedObserver)
    stProgramText(this.ydoc).unobserve(this.stObserver)
    metaMap(this.ydoc).unobserve(this.stObserver)
    metaMap(this.ydoc).unobserve(this.simHzObserver)
  }
}
