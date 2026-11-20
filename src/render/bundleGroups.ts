import type { Camera, Object3D } from 'three'
import { Group } from 'three'
import { hasUrlFlag } from './urlFlags'

/**
 * WebGPU render bundles, on by default under WebGPU (`?nobundle` turns them off). view.partsGroup and
 * the instance pool's output group become BundleGroups, so the main pass records its commands once and
 * replays them until the structure changes. Encode cost is paid per edit instead of per draw.
 * Gate: e2e/verify-render-bundles.mjs.
 *
 * What animates on replay without a re-record: object matrices and material uniforms, but only via
 * viewport/bundleReplayRefresh.ts's walk on active frames. Stock replay's refresh list is desynced
 * and freezes rig poses (e2e/probes/bundle-rig-freeze.mjs; `?bundlelive` moves movable parts out of
 * the bundles as the internals-independent fallback). `static` is forced false on every group, or
 * three skips even the per-object refresh check.
 *
 * What needs a re-record: anything that changes the draw list (a mesh added/removed/(un)hidden, a
 * geometry or material swap, an InstancedMesh count change). three doesn't detect it. Structural
 * seams call notifyBundleStructureChanged, and view.tick's syncBundleInvalidation polls
 * structureVersion for async stragglers. A missed seam shows as "data changed, pixels didn't"; add
 * the notify. Camera moves don't re-record (see markBundleCameraState; `?nobundlecam` reverts).
 *
 * The groups are created inert (isBundleGroup=false) and activated only around the consolidated
 * outline's main scene pass (including the shadow update inside it). The mask pass and wall/overlay
 * sub-passes share scene + camera + target, so an active bundle there would replay the main pass's
 * draw list instead of their own filtered one.
 *
 * Renders inert everywhere else by construction: WebGL (the ctor is only registered on the
 * WebGPU path), XR, thumbnails, compileAsync.
 */

/** BundleGroup surface we rely on; structurally typed so the ctor can be injected lazily
 *  (three/webgpu is a dynamically-imported chunk that must stay off the WebGL path). */
type BundleGroupLike = Group & { isBundleGroup: boolean; static: boolean; needsUpdate: boolean }

let bundleCtor: (new () => BundleGroupLike) | null = null
const groups: BundleGroupLike[] = []
let dirty = false // structural: draw list changed → re-disable culling on new content + re-record
let dirtyCamera = false // camera moved: re-record (no traverse; see markBundleCameraState)
// live-edit hold: frames remaining to render the main pass unbundled after a structural change. A
// bundle bakes its draw list. On r185 WebGPU the re-record a draw-list change requests happens one
// frame late: the requesting frame still replays the prior encode, which is the stale draw seen with
// the roof auto-hide and the async building-assembly (the procedural to tiled roof swap). Rendering the
// changed frame live (setBundlesActive(false), the same as the ?nobundle path, confirmed correct) skips
// the stale replay. The record then happens on the next, structurally stable frame. No cost in steady
// state: only frames that changed the draw list go live, and the re-record path drew those unbundled
// anyway. Gate: e2e/verify-roof-bundle-liveedit.mjs.
let liveHoldFrames = 0

/** On by default; `?nobundle` turns it off. Only takes effect on WebGPU: on WebGL the ctor below is
 *  never registered, so the groups stay plain and every bundle behaviour is inert. Node/headless
 *  (no `location`) ⇒ on, same convention as wantsInstancePool. */
export function wantsRenderBundles(): boolean {
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search)
    if (params.has('nobundle')) return false // kill-switch, wins everywhere
  }
  return true
}

/** read by the outline main pass (consolidatedOutlineNode) each frame: while true, render the main
 *  scene pass unbundled so a just-changed draw list can't replay its stale prior encode (the
 *  live-edit hold, see liveHoldFrames). */
export function bundleReplaySuppressed(): boolean {
  return liveHoldFrames > 0
}

/**
 * On by default with render bundles: camera moves refresh the replayed bundles' shared uniform groups
 * instead of re-recording, keeping bundled draws off the encode path while orbiting (probe
 * e2e/probes/bundle-campatch.mjs: orbit draws 576→22, post-orbit parity 0.08%). See
 * viewport/bundleReplayRefresh.ts for the mechanism. `?nobundlecam` reverts to camera
 * re-records: the rollback switch, and the A-side of the probe's A/B.
 */
export function wantsBundleCameraPatch(): boolean {
  return typeof location !== 'undefined' && !new URLSearchParams(location.search).has('nobundlecam')
}

// Per-frame dirty-part ids for the active-frame subset refresh (bundleReplayRefresh part 1):
// view.syncScene marks the ids its per-entry diff saw change; flushBundleInvalidation snapshots
// the accumulator into this frame's read set and clears it, so a mark is consumed by exactly the
// frame that renders it and a part stops being walked the frame after it settles.
let dirtyPartsAccum = new Set<string>()
let dirtyPartsFrame: ReadonlySet<string> = new Set()

/** view.syncScene: the parts whose entries updated this sync (pose/params/grid) - cheap, idempotent */
export function markBundleDirtyParts(ids: Iterable<string>): void {
  if (groups.length === 0) return
  for (const id of ids) dirtyPartsAccum.add(id)
}

/** single-part variant for the per-frame activity seams (owned walk, tick loop) - no allocation */
export function markBundleDirtyPart(id: string): void {
  if (groups.length === 0) return
  dirtyPartsAccum.add(id)
}

/** read by bundleReplayRefresh during each bundle render of the current frame */
export function bundleDirtyPartsThisFrame(): ReadonlySet<string> {
  return dirtyPartsFrame
}

/**
 * `?bundlelive` opt-in: runtime-movable parts (jointed/aimed rigs, subPose'd links, i.e. not
 * isMatrixStaticPart) render from view.livePartsGroup, outside the bundles, so their per-frame
 * matrix motion never meets the replay's baked object matrices. Off by default because
 * bundleReplayRefresh's per-object walk already refreshes bundled matrices on active frames at
 * full coverage (A/B'd via e2e/probes/bundle-rig-freeze.mjs: a six-axis robot animates mid-run either
 * way, but the split raises demo idle draws 22 → 325, since every jointless GLB dressing part leaves
 * the bundle too). Under stock replay a bundled robot's arm freezes mid-run, so this split is the
 * internals-independent fix. installBundleReplayRefresh forces it on (forceBundleLiveSplit) when a
 * three bump moves the r185 internals it feature-detects, so correctness doesn't depend on someone
 * noticing the patch silently did nothing and setting the flag by hand.
 */
export function wantsBundleLiveSplit(): boolean {
  if (liveSplitForced) return true
  return hasUrlFlag('bundlelive')
}

// set once, at renderer creation - before RenderView exists, so no part was homed under the
// un-forced answer (view.partContainer re-reads wantsBundleLiveSplit on every sync anyway)
let liveSplitForced = false

/** bundleReplayRefresh.ts calls this when its feature-detect fails: without the replay-refresh
 *  patch, stock replay freezes bundled rig poses mid-run, so movable parts must leave the
 *  bundles (the `?bundlelive` split) automatically. */
export function forceBundleLiveSplit(): void {
  liveSplitForced = true
}

// Bundle camera-patch state (`?nobundlecam` turns the patch off): once the replay-refresh patch is installed, markBundleCameraState forwards
// camera moves here (per-frame flag + which camera is the view camera) instead of setting
// dirtyCamera - the patch consumes them during this frame's bundle renders.
let cameraPatchInstalled = false
let cameraMovedThisFrame = false
let viewCamera: Camera | null = null

/** bundleReplayRefresh.ts calls this once installed; from then on camera moves stop re-recording. */
export function setBundleCameraPatchActive(on: boolean): void {
  cameraPatchInstalled = on
}

/** read by bundleReplayRefresh during each bundle render of the current frame */
export function bundleCameraMovedThisFrame(): boolean {
  return cameraMovedThisFrame
}

/** the camera whose moves the patch must chase (shadow/light cameras keep stock behaviour) */
export function bundleViewCamera(): Camera | null {
  return viewCamera
}

// Scene-activity flag for the replay per-object refresh (bundleReplayRefresh part 1): running
// it every frame costs ~3ms at demo scale even fully parked (needsRefresh is always true for
// hasNode materials), so the view tells the patch when anything could have moved - a sim frame
// (+ stop-relax tail), a syncScene (edits/drags/undo/collab), a camera move. Parked frames skip
// the whole walk.
let sceneActive = false
let activitySerial = 0

export function markBundleSceneActivity(active: boolean): void {
  sceneActive = active
  if (active) activitySerial++
}

/** read by bundleReplayRefresh during each bundle render of the current frame */
export function bundleSceneActive(): boolean {
  return sceneActive
}

/**
 * Monotone count of active frames: advances every frame the scene is active, holds while it is
 * parked. Keys the outline's mask-pass projection cache (subPassCache.ts). Mask-relevant content
 * can change on any active frame without a structural notify (the cargo batch repacks its rows as
 * bodies spawn/despawn while the sim runs), so active frames re-record and the replay only spans
 * parked stretches, the "select a part and orbit a static scene" case the cache exists for.
 */
export function bundleActivitySerial(): number {
  return activitySerial
}

/** createRenderer.ts injects three/webgpu's BundleGroup here once the WebGPU chunk is loaded. */
export function registerBundleGroupCtor(ctor: new () => Group): void {
  bundleCtor = ctor as new () => BundleGroupLike
}

/**
 * A scene container that becomes a (deactivated) BundleGroup when bundles are on, else a plain
 * Group. Callers keep the Group type: BundleGroup extends Group, and every bundle behaviour
 * is driven from this module.
 */
export function createBundleCapableGroup(): Group {
  if (!bundleCtor || !wantsRenderBundles()) return new Group()
  const g = new bundleCtor()
  g.static = false // keep the per-object matrix/material refresh on replay (see module doc)
  g.isBundleGroup = false // inert until setBundlesActive(true) around the main scene pass
  groups.push(g)
  dirty = true
  return g
}

/**
 * Mount an opaque-only bundle group (the instance pool's output, the part batches) immediately
 * before the parts group it merges from, so its bundle executes before the one carrying that
 * group's transparent draws.
 *
 * three executes bundles at the end of the pass (`finishRender` -> `executeBundles`) in scene-child
 * order, so the order of two bundle groups is a draw order, and a `depthWrite:false` draw in the
 * earlier one can be painted over by the later one. Appended after view.partsGroup, the pool's
 * merged conveyors would punch through the spawner/despawner markers' fill, flickering during load
 * as frames alternate bundled/unbundled. Gate: e2e/verify-cue-over-bundles.mjs.
 *
 * These groups hold no transparent draws (`poolable()` / `batchable()` reject them), so
 * opaque-vs-opaque stays depth-correct either way. Reordering `scene.children` after `add()` is safe:
 * only traversal order changes.
 *
 * Before the sibling rather than first in the scene, keeping the reorder minimal: only the merge's
 * order relative to the group it merges from matters, so env.ts's lights and containers stay put.
 */
export function mountOpaqueBundleGroupBefore(scene: Object3D, group: Group, sibling: Object3D): void {
  scene.add(group)
  const at = scene.children.indexOf(sibling)
  const i = scene.children.indexOf(group)
  // sibling not mounted (or the group already precedes it): the plain append stands
  if (at === -1 || i === -1 || i < at) return
  scene.children.splice(i, 1)
  scene.children.splice(at, 0, group)
}

/** Forget a group on dispose (view/pool teardown), so a recreated view starts clean. */
export function releaseBundleGroup(group: Group): void {
  const i = groups.indexOf(group as BundleGroupLike)
  if (i !== -1) groups.splice(i, 1)
}

/** cheap gate for per-frame polls: false when bundles are off or nothing registered */
export function bundleGroupsRegistered(): boolean {
  return groups.length > 0
}

// Monotonic structural epoch: bumps whenever the draw list is marked stale. Consumers that cache
// anything derived from the scene's draw-list structure (viewport/subPassCache.ts's projected
// wall render lists) compare epochs instead of hooking the flush. Coarse by design (any structural
// notify anywhere invalidates), because a stale projected list is the same bug family as a stale
// bundle ("data changed, pixels didn't"), and re-projecting costs one traversal.
let structureEpoch = 1

export function bundleStructureEpoch(): number {
  return structureEpoch
}

/** Mark the draw list stale. Idempotent and cheap (a flag); call from every structural seam. */
export function notifyBundleStructureChanged(): void {
  structureEpoch++
  if (groups.length > 0) dirty = true
}

/**
 * Monotone count of re-records that have actually happened. Bumped on each frame that will render
 * bundled with a pending `needsUpdate`, which is the frame whose bundle render re-encodes the draw
 * list. Distinct from {@link bundleStructureEpoch}, which counts re-records requested.
 *
 * gpuRetire.ts depends on the distinction. Under the live-edit hold a dirty frame renders unbundled
 * and records nothing (see flushBundleInvalidation). During a burst of structural changes, such as
 * the tail of a scene load, the epoch advances one per frame while no record happens. A retirement
 * keyed on the epoch would count those live frames as its settle window and free resources the
 * recording made before the burst still uses: "[Buffer (unlabeled)] used in submit while destroyed",
 * and the main pass stays black until the changes stop and a record happens. This count holds still
 * whenever nothing is re-recording, which is the property the retirement queue needs.
 */
let recordSerial = 0
/** a `needsUpdate` has been published to the groups and no bundled frame has consumed it yet */
let pendingRecord = false

export function bundleRecordSerial(): number {
  return recordSerial
}

/**
 * Camera handling. view.tick calls this every frame with whether the camera moved and which
 * camera is the view camera. Default: moves are forwarded to viewport/bundleReplayRefresh.ts, which
 * uploads the new camera into the replayed bundles' shared uniform groups, no re-record
 * (e2e/probes/bundle-campatch.mjs: draws stay at 22, 0.08% parity vs re-recording).
 *
 * Fallback (`?nobundlecam`, or three internals moved): a camera move re-records. Stock replay
 * freezes the camera (e2e/probes/bundle-probe.mjs) because the camera is only in shared uniform
 * groups, and Bindings._update gates shared-group uploads on a version no replay frame bumps, so the
 * camera bytes are never uploaded even with a forced refresh. bundleReplayRefresh.ts bypasses that gate.
 *
 * Fallback cost: a re-record frame is ~one normal unbundled encode (the HUD's draw calls returning
 * while orbiting); parked-camera frames replay at ~zero encode either way.
 */
export function markBundleCameraState(moved: boolean, camera?: Camera): void {
  if (camera !== undefined) viewCamera = camera
  if (cameraPatchInstalled) {
    cameraMovedThisFrame = moved // consumed by bundleReplayRefresh during this frame's draws
    return
  }
  if (moved && groups.length > 0) dirtyCamera = true
}

/**
 * Apply pending invalidation once per frame (view.tick, right before the draw): bump each
 * group's version so every render context (main pass + shadow passes) re-records on its next
 * use. A structural change also re-disables frustum culling on the current content: a bundle
 * bakes the record-time cull set, so a mesh culled while recording would hole out when the
 * camera orbits.
 */
export function flushBundleInvalidation(): void {
  // snapshot the dirty-part accumulator for this frame's replays (independent of re-record state)
  if (dirtyPartsAccum.size > 0 || dirtyPartsFrame.size > 0) {
    dirtyPartsFrame = dirtyPartsAccum
    dirtyPartsAccum = new Set()
  }
  // census-probe diagnostic (e2e/probes/sim-dirty-census.mjs): the frame's consumed dirty set,
  // so the escape detector can check "changed ⇒ always-bucket ∪ marked" per frame
  ;(globalThis as Record<string, unknown>).__oipBundleDirtyParts = dirtyPartsFrame
  // Live-edit hold: a structural change (dirty) renders this frame unbundled, because the requested
  // re-record replays a frame late on r185 WebGPU (see liveHoldFrames). The needsUpdate set
  // below survives the unbundled frame (no bundle render consumes it), so the record happens on the
  // next, stable frame. Camera-only moves (dirtyCamera) never suppress; the campatch handles those.
  if (dirty) liveHoldFrames = 1
  else if (liveHoldFrames > 0) liveHoldFrames--
  // Count a re-record, before the early-out below: this frame renders bundled (liveHoldFrames === 0)
  // and a needsUpdate is outstanding, so its bundle render re-encodes the draw list. Anything waiting
  // for the old encode to be gone (gpuRetire's queue) keys off this, never off the request count.
  if (pendingRecord && liveHoldFrames === 0) {
    pendingRecord = false
    recordSerial++
  }
  if (!dirty && !dirtyCamera) return
  for (const g of groups) {
    if (dirty) {
      g.traverse((o) => {
        o.frustumCulled = false
      })
    }
    g.needsUpdate = true
  }
  // only a structural re-record replaces the baked draw list (and with it the resource handles a
  // retirement is waiting on); a camera-only needsUpdate re-encodes the same objects
  if (dirty) pendingRecord = true
  dirty = false
  dirtyCamera = false
}

/** Flip the groups' bundle behaviour on/off around a specific render (see module doc). */
export function setBundlesActive(on: boolean): void {
  for (const g of groups) g.isBundleGroup = on
}
