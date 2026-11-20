import type { WebGPURenderer } from 'three/webgpu'
import {
  bundleCameraMovedThisFrame,
  bundleDirtyPartsThisFrame,
  bundleSceneActive,
  bundleViewCamera,
  forceBundleLiveSplit,
  setBundleCameraPatchActive,
} from '../bundleGroups'
import { TICK_UNIFORM_GROUP } from '../parts/common'

/**
 * Render-bundle replay refresh (default-on; `?nobundlecam` reverts). A render bundle stores commands and
 * resource handles, never uniform bytes, so a camera move can refresh the replayed bundles instead of
 * re-recording them (bundleGroups.ts `markBundleCameraState`). Stock replay leaves the shared uniform
 * groups stale: `Bindings._update` gates them behind a version compare that replay frames don't reliably bump.
 *
 * Record captures the renderObjects actually encoded. Replay refreshes the dirty and camera-sensitive draws
 * (part 1), re-ships the camera into the shared groups (part 2), repairs the camera after a nested shadow
 * render, and re-records instead of replaying a recording three has disposed part of. Each step and the
 * bug it prevents: docs/three-coupling.md, "Render-bundle replay".
 *
 * Feature-detects three 0.187 internals (`_renderBundle`, `_nodes`, `_bundles`, `backend`,
 * `_bindings.has` / `_bindings.deleteForRender`). If a bump moves them it warns and forces the
 * `?bundlelive` split (forceBundleLiveSplit), since stock replay freezes rig poses. Diagnostics on
 * `globalThis.__oipBundleCam`. Canaries: bundleReplayRefresh.test.ts. Gates: e2e/verify-render-bundles.mjs,
 * e2e/verify-bundle-camera-integrity.mjs.
 */

interface BindingLike {
  isNodeUniformsGroup?: boolean
  isBuffer?: boolean
  groupNode?: { shared?: boolean; name?: string }
  updateRanges?: unknown[]
  update(): boolean
  clearUpdateRanges(): void
}
interface BindGroupLike {
  bindings: BindingLike[]
}
interface Object3DLike {
  userData?: Record<string, unknown>
  parent?: Object3DLike | null
  material?: unknown
}
interface NodeLike {
  getUpdateType?(): unknown // three r185 Node: NodeUpdateType string ('none'|'frame'|'render'|'object')
  getUpdateBeforeType?(): unknown
}
interface BuilderStateLike {
  updateNodes?: NodeLike[]
  updateBeforeNodes?: NodeLike[]
}
interface NodeFrameLike {
  updateNode(node: object): void
  updateBeforeNode(node: object): void
}
interface RenderObjectLike {
  object?: Object3DLike
  camera?: unknown // three r185 RenderObject.camera - the record filter's nested-render discriminator
  getBindings(): BindGroupLike[]
  getNodeBuilderState?(): BuilderStateLike // three r185 RenderObject; optional so a moved internal degrades to the full walk
}
/** one NodeBuilderState's contribution to the cam-node set: its representative draw (for
 *  nodeFrame material/object context) + the non-OBJECT nodes it introduced (deduped globally) */
export interface CamNodeGroup {
  ro: RenderObjectLike
  before: object[]
  update: object[]
}
/** a recorded instance-pool draw + the row count and summed buffer versions it was last seen at */
interface PoolDraw {
  ro: RenderObjectLike
  id: string
  count: number
  versions: number
}
interface PoolObjectLike {
  count?: number
  instanceMatrix?: { version: number }
  geometry?: { attributes: Record<string, { version: number }> }
}
/** everything an InstancePoolManager write moves: the instance matrix and every wrapper attribute
 *  (belt fabric, the aSel selection channel). Versions only grow, so a sum can't alias a change. */
function poolVersions(o: PoolObjectLike): number {
  let v = o.instanceMatrix?.version ?? 0
  const attrs = o.geometry?.attributes
  if (attrs) for (const k in attrs) v += attrs[k]!.version
  return v
}
const warnedPoolEscapes = new Set<string>()

interface BundleLike {
  bundleGroup: object
  camera: object
}
interface BundleDataLike {
  __oipDrawn?: RenderObjectLike[]
  // fixed per recording (rebuilt with __oipDrawn on every re-record):
  __oipCamSensitive?: RenderObjectLike[] // draws whose object ancestry carries a viewTick (camera-driven mutators)
  __oipAlwaysActive?: RenderObjectLike[] // draws runtime ticks can mutate - refreshed on every active frame
  __oipByPart?: Map<string, RenderObjectLike[]> // the rest, keyed by owning partId - refreshed when the part is marked dirty
  __oipPoolDraws?: PoolDraw[] // the instance-pool subset of __oipByPart, with the buffer state last seen (POOL BACKSTOP)
  __oipSharedBindings?: BindingLike[] // the deduped shared uniforms groups the recorded draws reference
  __oipTickBindings?: BindingLike[] // the TICK-group subset (belt/chain scroll, spin) - uploaded on active frames
  __oipCamNodes?: CamNodeGroup[] // part 2's walk: deduped non-OBJECT nodes, grouped by builder state
  __oipNodeCover?: RenderObjectLike[] // fallback layer: one draw per unique NodeBuilderState
  __oipFreshRecord?: boolean // set at record; the first replay walks the full list once (see below)
  __oipDisposeEpoch?: number // disposal count this recording has been verified against (stale guard)
  // three's own fields on the bundle's backend data. The stale guard clears `version` to force
  // a re-record of this recording without touching the shared BundleGroup version.
  version?: number
  bundleGPU?: unknown
}

/**
 * Whether a captured draw can change on a camera-only frame: its object (or an ancestor) carries
 * a `viewTick`, the camera-driven mutator hook. view.tick calls it with the camera each frame. The
 * building's roof auto-hide uses it; billboards and labels would too. Everything else in a bundle
 * only moves on sim/edit frames, which keep the full refresh walk. Exported for tests.
 */
export function isCameraSensitiveObject(o: Object3DLike | null | undefined): boolean {
  let n = o ?? null
  while (n) {
    if (typeof n.userData?.viewTick === 'function') return true
    n = n.parent ?? null
  }
  return false
}

/** Why a draw is in the always-refresh bucket. Record-time census only (`__oipBundleAlways`), so a
 *  bucket that grows can be attributed to one cause. Ordered by precedence. */
export type AlwaysReason = 'instancePool' | 'dynamicInstances' | 'unattributed'

/**
 * Classify a captured draw for the active-frame dirty-list.
 *
 * The refresh set is activity-based: `always` covers only what mutates outside any markable seam, a
 * `dynamicInstances` bank (unset in production) or a draw with no owning part. The rest is keyed by
 * `part` and refreshed only on frames the part was marked:
 *  - view.syncScene marks the parts its diff saw change (edits, drags, undo, collab);
 *  - the owned matrix walk marks a part whose subtree recomposes (every matrix mutator bumps poseRev);
 *  - part ticks and viewTicks return `true` when they mutated a material or attribute, so a stopped
 *    conveyor's no-op tick doesn't refresh its subtree;
 *  - unconditional frame appliers (applyLamps) mark on invocation.
 * A pool is keyed by its `userData.poolMarkId`, marked by InstancePoolManager's write paths (and on
 * every edit frame), so a running scene doesn't re-walk ~50 unchanged pool draws per frame. A pool
 * without an id stays in `always`. Demo census: ~45 of 340 bundled meshes mutate on a sim frame.
 * e2e/probes/sim-dirty-census.mjs detects a mutation that escapes every mark seam.
 *
 * Not handled here: the shared TICK-group uniforms (parts/tickUniformGroup.ts), including roller spin,
 * which are uploaded as bytes directly over `__oipTickBindings`. Exported for tests.
 */
export function classifyBundleObject(o: Object3DLike | null | undefined): { part: string | null; always: boolean } {
  const d = classifyBundleObjectDetailed(o)
  return { part: d.part, always: d.always }
}

/** {@link classifyBundleObject} plus the reason for an `always` verdict (null when not always). The
 *  plain form delegates here, so the two can't drift. */
export function classifyBundleObjectDetailed(o: Object3DLike | null | undefined): { part: string | null; always: boolean; reason: AlwaysReason | null } {
  let part: string | null = null
  let always = false
  let reason: AlwaysReason | null = null
  const mark = (r: AlwaysReason): void => {
    always = true
    if (reason === null) reason = r
  }
  if (o) {
    if (o.userData?.instancePool === true) {
      // the pool group sits outside every part, so its ancestry has no partId. The mark id is its owner.
      const poolId = o.userData.poolMarkId
      if (typeof poolId === 'string') return { part: poolId, always: false, reason: null }
      mark('instancePool')
    }
    if (o.userData?.dynamicInstances === true) mark('dynamicInstances')
  }
  let n = o ?? null
  while (n) {
    if (typeof n.userData?.partId === 'string') {
      part = n.userData.partId
      break
    }
    n = n.parent ?? null
  }
  if (part === null) mark('unattributed') // conservative: refresh what we can't attribute
  return { part, always, reason }
}

/**
 * Part 2's node cover: one representative draw per unique NodeBuilderState. The builder state is
 * shared per pipeline (three's nodeBuilderCache), so its updateNodes/updateBeforeNodes lists are
 * identical across same-material draws. The cover's node union equals the full list's, and each
 * representative carries the right material for its own nodes' frame context. RENDER-scope nodes
 * (the camera family this pass refreshes) are renderId-gated, first visit only, exactly as stock.
 * Returns undefined when the internal moved (a three bump). Callers then fall back to the full walk,
 * which is slower but gives the same result. Exported for tests.
 */
export function deriveNodeCover(drawn: readonly RenderObjectLike[]): RenderObjectLike[] | undefined {
  const seen = new Set<object>()
  const cover: RenderObjectLike[] = []
  for (const ro of drawn) {
    if (typeof ro.getNodeBuilderState !== 'function') return undefined
    const state = ro.getNodeBuilderState()
    if (seen.has(state)) continue
    seen.add(state)
    cover.push(ro)
  }
  return cover
}

/**
 * Part 2's cam-node set: the globally deduped non-OBJECT updateBefore/update nodes of every
 * captured draw, grouped by the builder state that first introduced them. Its representative
 * draw supplies the nodeFrame's material/object context, matching the frame the node would see
 * on the stock walk's first visit. OBJECT-scope nodes are dropped: their outputs go to per-object
 * uniform groups this pass never uploads, and on a camera frame the objects didn't move. Part 1
 * fully refreshes the ones that can (viewTick ancestry). What remains is the RENDER/FRAME-scope
 * handful (camera family + per-material singletons), the values the shared groups' byte-compare
 * below actually uploads. Returns undefined when any internal moved (a three bump); callers then
 * fall back to the node-cover walk. Exported for tests.
 */
export function deriveCamNodes(drawn: readonly RenderObjectLike[]): CamNodeGroup[] | undefined {
  const seenStates = new Set<object>()
  // updateBefore/update are distinct gates a node can carry both of - dedup each list separately
  const seenBefore = new Set<object>()
  const seenUpdate = new Set<object>()
  const groups: CamNodeGroup[] = []
  for (const ro of drawn) {
    if (typeof ro.getNodeBuilderState !== 'function') return undefined
    const state = ro.getNodeBuilderState()
    if (seenStates.has(state)) continue
    seenStates.add(state)
    if (!Array.isArray(state.updateBeforeNodes) || !Array.isArray(state.updateNodes)) return undefined
    const before: object[] = []
    const update: object[] = []
    for (const n of state.updateBeforeNodes) {
      if (typeof n.getUpdateBeforeType !== 'function') return undefined
      if (seenBefore.has(n)) continue
      seenBefore.add(n)
      if (n.getUpdateBeforeType() !== 'object') before.push(n)
    }
    for (const n of state.updateNodes) {
      if (typeof n.getUpdateType !== 'function') return undefined
      if (seenUpdate.has(n)) continue
      seenUpdate.add(n)
      if (n.getUpdateType() !== 'object') update.push(n)
    }
    if (before.length > 0 || update.length > 0) groups.push({ ro, before, update })
  }
  return groups
}

/** the deduped shared uniforms groups a draw list references - the buffers part 2 ships the camera into */
function deriveSharedBindings(drawn: readonly RenderObjectLike[]): BindingLike[] {
  const shared = new Set<BindingLike>()
  for (const ro of drawn) {
    for (const bindGroup of ro.getBindings()) {
      for (const binding of bindGroup.bindings) {
        if (binding.isNodeUniformsGroup === true && binding.groupNode?.shared === true) shared.add(binding)
      }
    }
  }
  return [...shared]
}
interface BackendLike {
  get(o: object): BundleDataLike
  draw(renderObject: RenderObjectLike, info: unknown): void
  updateBinding(binding: BindingLike): void
  addBundle(renderContext: object, renderBundle: object): void
}
interface RendererInternals {
  backend: BackendLike
  _nodes: {
    updateBefore(ro: RenderObjectLike): void
    updateForRender(ro: RenderObjectLike): void
    updateAfter(ro: RenderObjectLike): void
    getNodeFrameForRender?(ro: RenderObjectLike): NodeFrameLike // feature-detected: the cam-node walk needs it
  }
  _geometries: { updateForRender(ro: RenderObjectLike): void }
  // `has` is three's DataMap membership test - our liveness probe for a recorded draw (see the
  // stale-RenderObject guard in the replay walk)
  _bindings: {
    updateForRender(ro: RenderObjectLike): void
    has(ro: RenderObjectLike): boolean
    deleteForRender(ro: RenderObjectLike): void
  }
  _bundles: { get(group: object, camera: object, ctx: object): object }
  // three r185 Renderer.info - `calls` counts render calls and is never restored across a nested
  // render, which is what makes it the cheap nested-render detector part 2's repair pass needs
  info?: { calls: number }
  _currentRenderContext: object
  _bundleNeedsUpdate(group: object, data: BundleDataLike): boolean
  _renderBundle(bundle: BundleLike, sceneRef: unknown, lightsNode: unknown): void
}

/** probe diagnostics: how often we recorded / refresh-replayed, forced shared-group uploads, and
 *  how many per-object part-1 refreshes ran (with the selective path this stays ~flat on orbit).
 *  drawnTotal/coverTotal accumulate per recording; part 2 saves work to the extent cover ≪ drawn. */
export interface BundleCamStats {
  records: number
  refreshFrames: number
  uploads: number
  tickUploads: number // TICK-group buffers shipped on active frames (part 1.5) - the scroll/spin path
  part1Walked: number
  drawnTotal: number
  coverTotal: number
  camNodesTotal: number // -1 per recording where deriveCamNodes fell back (internals moved)
  staleSkipped: number // recorded draws skipped mid-walk because three had disposed their RenderObject
  staleRecords: number // recordings re-recorded because a baked draw's RenderObject was disposed
  disposals: number // RenderObject disposals seen (the stale guard's O(1) epoch)
  camRepairs: number // part-2 walks where a nested render forced the camera-node repair pass
}

export function installBundleReplayRefresh(renderer: WebGPURenderer): void {
  const r = renderer as unknown as RendererInternals
  // named, so the warn below says which internal moved (a bump, or a renderer that isn't on
  // WebGPUBackend - addBundle is WebGPU-only) instead of leaving it to be re-derived
  const missing = [
    typeof r._renderBundle !== 'function' && '_renderBundle',
    typeof r._bundleNeedsUpdate !== 'function' && '_bundleNeedsUpdate',
    !r._nodes && '_nodes',
    !r._geometries && '_geometries',
    typeof r._bindings?.has !== 'function' && '_bindings.has',
    typeof r._bindings?.deleteForRender !== 'function' && '_bindings.deleteForRender',
    !r._bundles && '_bundles',
    typeof r.backend?.addBundle !== 'function' && 'backend.addBundle',
  ].filter((m): m is string => m !== false)
  if (missing.length > 0) {
    // Three internals moved. Stock replay is not a safe fallback: its desynced refresh list
    // freezes bundled rig poses mid-run (module doc). So force the internals-independent
    // `?bundlelive` split instead of degrading silently. Movable parts leave the bundles, and
    // camera moves revert to re-records (markBundleCameraState never gets the patch handoff).
    console.warn(
      `[oip] render-bundle replay-refresh patch: three internals moved (r187 shape not found: ${missing.join(', ')}) - ` +
        'forcing the ?bundlelive split so bundled rig poses cannot freeze mid-run; ' +
        'camera moves fall back to bundle re-records',
    )
    forceBundleLiveSplit()
    return
  }

  const orig = r._renderBundle
  const backend = r.backend
  const stats: BundleCamStats = { records: 0, refreshFrames: 0, uploads: 0, tickUploads: 0, part1Walked: 0, drawnTotal: 0, coverTotal: 0, camNodesTotal: 0, staleSkipped: 0, staleRecords: 0, disposals: 0, camRepairs: 0 }
  ;(globalThis as Record<string, unknown>).__oipBundleCam = stats
  // Always-bucket census, accumulated across recordings: draw counts by cause and by owning part.
  // The bucket is re-walked every active frame, so this shows whether shrinking it is worthwhile
  // and which rule to change. Record-time only ⇒ no per-frame cost.
  const alwaysCensus: Record<string, number> = {}
  const alwaysCensusByPart: Record<string, number> = {}
  ;(globalThis as Record<string, unknown>).__oipBundleAlways = { byReason: alwaysCensus, byPart: alwaysCensusByPart }

  // Disposal epoch: the O(1) half of the stale-recording guard below. three disposes a
  // RenderObject whenever its cache key changes (a material version bump, a material/geometry
  // dispose), and `RenderObjects.createRenderObject`'s onDispose routes every such disposal
  // through `bindings.deleteForRender`. Counting them here is the only signal available: three
  // never tells a bundle that one of its baked draws was disposed.
  let disposeEpoch = 0
  const origDeleteForRender = r._bindings.deleteForRender.bind(r._bindings)
  r._bindings.deleteForRender = (ro) => {
    disposeEpoch++
    stats.disposals = disposeEpoch
    origDeleteForRender(ro)
  }

  r._renderBundle = function (this: RendererInternals, bundle, sceneRef, lightsNode) {
    const renderBundle = this._bundles.get(bundle.bundleGroup, bundle.camera, this._currentRenderContext)
    const renderBundleData = backend.get(renderBundle)

    // Stale-recording guard. A recorded bundle bakes resource handles (module doc), so when
    // three disposes a RenderObject whose draw is in this recording, the recording is invalid.
    // `bindings.deleteForRender` refcounts the bind groups, and when the count reaches zero it
    // destroys the group's GPUBuffers and `release()`s its bindings. Replaying then submits
    // destroyed buffers ("used in submit while destroyed"). Refreshing the dead draw rebuilds it
    // through `Bindings.getForRender`'s INITIALIZE path, which reads `binding.texture` for the
    // sampler descriptor without first re-reading the live `textureNode.value`. The released null
    // reaches WebGPUTextureUtils.updateSampler as `texture.minFilter` ("Cannot read properties of
    // null"). Without this guard that shows up as an intermittent WebGPU gate failure: a stale draw
    // rebuilt from a torn-down binding, not a texture-upload race.
    //
    // Re-record instead of replaying. The epoch compare makes the common case one integer test.
    // The O(draws) verify only runs on a frame where something was disposed, and when that
    // disposal doesn't touch this recording we re-stamp so it doesn't run again.
    if (
      !this._bundleNeedsUpdate(bundle.bundleGroup, renderBundleData) &&
      renderBundleData.__oipDisposeEpoch !== disposeEpoch
    ) {
      let stale = false
      for (const ro of renderBundleData.__oipDrawn ?? []) {
        if (!this._bindings.has(ro)) {
          stale = true
          break
        }
      }
      if (stale) {
        stats.staleRecords++
        // Invalidate this recording only. `_bundleNeedsUpdate` compares the group's version
        // against the recording's, so clearing ours takes the record path below on this same
        // frame and a stale recording never reaches the replay branch. Not
        // `bundleGroup.needsUpdate = true`: that bumps the group version, which invalidates
        // every (camera, renderContext) bundle built from that group, including the shadow
        // bundles and the layered overlay pass. Measured, that turns 24 stale detections into
        // ~140 extra recordings spread over the rest of the session.
        renderBundleData.version = -1
      } else {
        renderBundleData.__oipDisposeEpoch = disposeEpoch
      }
    }

    if (this._bundleNeedsUpdate(bundle.bundleGroup, renderBundleData)) {
      // Record: capture the renderObjects actually encoded into this bundle (ground truth).
      //
      // Filtered to this bundle's (renderContext, camera). A shadowed material's updateBefore
      // runs the nested shadow-map render mid-record, and its draws (light camera, shadow
      // context) pass through the same backend.draw. An unfiltered capture would put them at
      // the head of the list (the nested render fires inside the first draw's update chain).
      // That corrupts everything derived from the list, worst of all deriveCamNodes: shadow-draw
      // representatives would own the globally deduped camera nodes, so part 2's per-frame walk
      // would run them under the light camera's nodeFrame and upload the shadow camera's
      // matrices into every recorded shared group. The whole bundle then renders from the shadow
      // camera (the "zoomed-out isometric scene" flash on hide/resize, hidden whenever frequent
      // re-records rewrite the groups with the view camera).
      const drawn: RenderObjectLike[] = []
      const nested: RenderObjectLike[] = []
      const recordCtx = this._currentRenderContext
      const origDraw = backend.draw
      backend.draw = (renderObject, info) => {
        // r === this (the patch is installed on r); read the live current context per draw
        if (r._currentRenderContext === recordCtx && renderObject.camera === bundle.camera) drawn.push(renderObject)
        else nested.push(renderObject)
        origDraw.call(backend, renderObject, info)
      }
      try {
        orig.call(this, bundle, sceneRef, lightsNode)
      } finally {
        backend.draw = origDraw
      }
      // Fallback if a three bump breaks the identity comparisons (e.g. renderObject.camera
      // moves): an all-filtered-out capture would stop part 1's replay refresh entirely and
      // freeze bundled rig poses, which is worse than the wrong camera. Keep the raw list and
      // warn, as the install-time feature-detect does on failure.
      if (drawn.length === 0 && nested.length > 0) {
        console.warn(
          '[oip] render-bundle record capture: no draws matched this bundle\'s context+camera - ' +
            'three internals may have moved; falling back to the unfiltered capture',
        )
        drawn.push(...nested)
      }
      renderBundleData.__oipDrawn = drawn
      // Derived per recording, so replay frames skip an O(draws) re-derivation:
      //  - the camera-sensitive subset a camera-only frame must still refresh (viewTick ancestry)
      //  - the deduped shared uniforms groups part 2 uploads the camera into (fixed for this
      //    recording - bindings only re-mint through changes that force a re-record)
      renderBundleData.__oipCamSensitive = drawn.filter((ro) => isCameraSensitiveObject(ro.object))
      const always: RenderObjectLike[] = []
      const byPart = new Map<string, RenderObjectLike[]>()
      const poolDraws: PoolDraw[] = []
      const addToPart = (id: string, ro: RenderObjectLike): void => {
        const arr = byPart.get(id)
        if (arr) arr.push(ro)
        else byPart.set(id, [ro])
      }
      for (const ro of drawn) {
        const c = classifyBundleObjectDetailed(ro.object)
        if (c.always) {
          always.push(ro)
          // census by cause (record-time only; replay frames never re-derive it). The always bucket is
          // walked on every active frame, so this records which rule put each draw there.
          // See e2e/probes/bundle-always-census.mjs
          alwaysCensus[c.reason ?? 'unattributed'] = (alwaysCensus[c.reason ?? 'unattributed'] ?? 0) + 1
          const key = c.part ?? '#unattributed'
          alwaysCensusByPart[key] = (alwaysCensusByPart[key] ?? 0) + 1
        } else {
          addToPart(c.part!, ro)
          if (ro.object?.userData?.instancePool === true) {
            const o = ro.object as PoolObjectLike
            poolDraws.push({ ro, id: c.part!, count: o.count ?? 0, versions: poolVersions(o) })
          }
        }
      }
      renderBundleData.__oipAlwaysActive = always
      renderBundleData.__oipByPart = byPart
      renderBundleData.__oipPoolDraws = poolDraws
      renderBundleData.__oipSharedBindings = deriveSharedBindings(drawn)
      // the TICK-group subset (parts/tickUniformGroup.ts): the ticking material uniforms (belt/
      // chain scroll, roller spin) live in one shared binding per material, uploaded directly on
      // active frames below, so ticking parts don't mark dirty per frame
      renderBundleData.__oipTickBindings = renderBundleData.__oipSharedBindings.filter((b) => b.groupNode?.name === TICK_UNIFORM_GROUP)
      renderBundleData.__oipCamNodes = deriveCamNodes(drawn)
      renderBundleData.__oipNodeCover = deriveNodeCover(drawn)
      renderBundleData.__oipFreshRecord = true
      // this recording is built from draws that are live right now, so it is verified against
      // the current disposal count (stale-recording guard)
      renderBundleData.__oipDisposeEpoch = disposeEpoch
      stats.records++
      stats.drawnTotal += drawn.length
      stats.coverTotal += renderBundleData.__oipNodeCover?.length ?? drawn.length
      stats.camNodesTotal += renderBundleData.__oipCamNodes?.reduce((s, g) => s + g.before.length + g.update.length, 0) ?? -1
      return
    }

    const drawn = renderBundleData.__oipDrawn
    if (drawn) {
      // Replay, part 1: per-object refresh over the captured list. This is the stock replay loop,
      // but over the ground-truth list (stock's desynced one leaves a dragged conveyor's roller bank
      // behind its pooled frame; see the module doc).
      //
      // Gated on scene activity (+ camera moves, which drive viewTicks). needsRefresh can't gate
      // it (hasNode materials always report true), and the full walk costs ~3 ms/frame parked.
      //  - Active frame: the always-active bucket + parts marked dirty this frame, + the
      //    camera-sensitive subset if the camera moved. The full walk refreshes ~742 renderObjects
      //    per frame at demo scale, against ~45 bundled meshes a sim frame actually mutates.
      //  - Camera-only frame: just the camera-sensitive subset, the draws with a viewTick in their
      //    ancestry (part 2 uploads the camera itself). This keeps an orbit near parked cost.
      //  - The first replay after a record walks the full list (below).
      const active = bundleSceneActive()
      const camMoved = bundleCameraMovedThisFrame()
      const dirtyIds = bundleDirtyPartsThisFrame()
      // First replay after a re-record: walk the full captured list once, regardless of frame
      // kind or subset selection. A record can bake a mid-change snapshot (measured: the roof
      // fold baked wrong at a stop-frame re-record, staying wrong until the part next marked).
      // This repairs it once, on the one frame a bad snapshot can exist.
      const fresh = renderBundleData.__oipFreshRecord === true
      if (fresh) renderBundleData.__oipFreshRecord = false
      // Marks alone also open the walk (dirtyIds.size). A mutation can happen on a frame that is
      // neither active nor camera-moved: the roof auto-hide ease settling after the camera
      // parks (viewTick marks), or a late pose re-bake. Dropping its mark would render it stale
      // until the next active frame. This is why viewTick subtrees can stay out of the
      // always-active bucket.
      // POOL BACKSTOP. Pools are refreshed by their marks (instancePool.ts `markPool`), but a pool
      // write that forgets to mark would otherwise render stale rows until something else walks it.
      // Every write moves the row count or a buffer version, so compare those (a few integer reads
      // per pool) and walk any pool that moved unmarked. Dev builds log it: an escape means a write
      // path is missing its markPool. Material state is not covered here, since no buffer shows an
      // in-place repaint. That is why the view marks every pool on an edit frame.
      let escaped: RenderObjectLike[] | null = null
      const poolDraws = renderBundleData.__oipPoolDraws
      if (poolDraws) {
        for (const p of poolDraws) {
          const o = p.ro.object as PoolObjectLike
          const count = o.count ?? 0
          const versions = poolVersions(o)
          if (count === p.count && versions === p.versions) continue
          p.count = count
          p.versions = versions
          if (fresh || dirtyIds.has(p.id)) continue
          ;(escaped ??= []).push(p.ro)
          if (import.meta.env.DEV && !warnedPoolEscapes.has(p.id)) {
            warnedPoolEscapes.add(p.id)
            console.warn(`[oip] instance pool ${p.id} changed without a bundle mark (refreshed by the backstop) - an InstancePoolManager write path is missing markPool`)
          }
        }
      }
      let staleDraw = false // a walked draw's RenderObject was disposed since the record
      if (active || camMoved || fresh || dirtyIds.size > 0 || escaped) {
        let list: Iterable<RenderObjectLike> = drawn
        if (!fresh && (active || dirtyIds.size > 0) && renderBundleData.__oipAlwaysActive) {
          if (dirtyIds.size === 0 && !camMoved) list = renderBundleData.__oipAlwaysActive
          else {
            const merged = new Set<RenderObjectLike>(renderBundleData.__oipAlwaysActive)
            const byPart = renderBundleData.__oipByPart
            if (byPart) for (const id of dirtyIds) for (const ro of byPart.get(id) ?? []) merged.add(ro)
            if (camMoved) for (const ro of renderBundleData.__oipCamSensitive ?? []) merged.add(ro)
            list = merged
          }
        } else if (!fresh && !active) {
          list = renderBundleData.__oipCamSensitive ?? drawn
        }
        if (escaped && list !== drawn) {
          if (!active && !camMoved && !fresh && dirtyIds.size === 0) list = escaped // nothing else asked for a walk
          else {
            const merged = new Set<RenderObjectLike>(list)
            for (const ro of escaped) merged.add(ro)
            list = merged
          }
        }
        for (const ro of list) {
          // Second half of the stale guard, for a draw disposed during this walk. updateBefore
          // can run a nested render (the shadow-map pass), which can dispose RenderObjects, so
          // the pre-check above is not enough on its own. Skip the dead draw (refreshing it
          // would rebuild it through the null-binding path) and re-record on the next use.
          if (!this._bindings.has(ro)) {
            stats.staleSkipped++
            staleDraw = true
            continue
          }
          // No needsRefresh check: the walked set is exact (marked parts + the reduced always
          // bucket), and the monitor compare returns true for every hasNode material anyway, while
          // its matrix/property snapshots take real time per object.
          this._nodes.updateBefore(ro)
          this._geometries.updateForRender(ro)
          this._nodes.updateForRender(ro)
          this._bindings.updateForRender(ro)
          this._nodes.updateAfter(ro)
          stats.part1Walked++
        }
      }
      // A stale draw invalidates the recording, not just this frame's refresh (see the guard):
      // re-record on the next use (this recording only), rebuilding the list from live draws.
      if (staleDraw) renderBundleData.version = -1
      // Replay, part 1.5: upload the ticking material uniforms (belt/chain scroll, roller spin)
      // into their shared TICK-group buffers (parts/tickUniformGroup.ts). These are plain value
      // uniforms that read the live numbers/Vector2s the ticks mutate, so no node walk is needed.
      // `update()` byte-compares, and only advanced materials upload. This is why running
      // conveyors don't mark their parts dirty (a per-object walk doesn't upload a shared group
      // anyway; see the module doc). Active frames only: ticks advance only while the sim runs
      // (+ the stop-relax tail, which activity covers) or on edit frames (syncScene sets
      // activity). `fresh` is a cheap safety margin.
      if (active || fresh) {
        const tickBindings = renderBundleData.__oipTickBindings
        if (tickBindings) {
          for (const binding of tickBindings) {
            if (binding.update()) {
              backend.updateBinding(binding)
              stats.tickUploads++
            }
            if (binding.isBuffer === true && binding.updateRanges && binding.updateRanges.length > 0) {
              binding.clearUpdateRanges()
            }
          }
        }
      }
      // Replay, part 2: upload the view camera into the shared uniform groups the recorded draws
      // reference, bypassing the group-version gate the per-object refresh above still goes
      // through (see module doc). Runs every view-camera replay frame, not just when the camera
      // moved. A bundle's recorded shared groups are captured at record time and the live
      // (unbundled) sub-passes never touch them again, so the recorded camera stays at its
      // record-time value. On a parked scene that never fires a camMoved frame (a fresh load left
      // at the default camera), a bundle recorded mid-load, before the canvas/projection settled,
      // would replay with that stale camera forever (the load-time roof/scene skew). Uploading the
      // live camera each replay keeps the recorded groups current. The cost is the deduped cam-node
      // walk (below) plus a byte-compared upload that does nothing when the camera is unchanged and
      // the recorded group already matches. View-camera bundles only: shadow bundles' light
      // cameras don't move on orbit.
      if (bundle.camera === bundleViewCamera()) {
        stats.refreshFrames++
        // refresh camera-node values over the deduped cam-node set, the RENDER/FRAME-scope
        // handful the shared-group upload below actually uploads (module doc: the full-draw walk
        // is the dominant orbit CPU cost; draw-level dedup recovers little). Fallback layers keep
        // a three bump slower but correct: node cover (one draw per builder state) → full list.
        // __oipBundleCamWalk ('cover'|'full') is the probes' same-session A/B seam.
        const walkMode = (globalThis as Record<string, unknown>).__oipBundleCamWalk
        const camNodes = renderBundleData.__oipCamNodes
        const getFrame = this._nodes.getNodeFrameForRender
        if (camNodes && typeof getFrame === 'function' && walkMode === undefined) {
          // A nested render is the only thing in here that can corrupt the walk (below), and it
          // always bumps `info.calls` (Renderer._renderScene, never restored). Sampling it lets
          // the repair pass be skipped on almost every frame.
          const callsBefore = this.info?.calls ?? 0
          for (const g of camNodes) {
            let nodeFrame = getFrame.call(this._nodes, g.ro)
            for (const n of g.before) nodeFrame.updateBeforeNode(n)
            // An updateBefore node can run a nested render (ShadowNode.updateBefore runs the
            // shadow-map pass right here). three's shared NodeFrame then has its renderId
            // restored but its camera/object/material still set to the nested pass's (the light
            // camera). The camera-family update nodes read `frame.camera`, so without a re-fetch
            // they'd write the shadow camera into the global camera nodes, and the upload below
            // would put it into every recorded shared group. The whole bundle would render from
            // the light's orthographic view (the stale zoomed-out-isometric flash on hide/resize,
            // hidden whenever re-records or unbundled shadowed draws reset the values later in the
            // frame).
            if (g.before.length > 0) nodeFrame = getFrame.call(this._nodes, g.ro)
            for (const n of g.update) nodeFrame.updateNode(n)
          }
          // Repair pass. The re-fetch above fixes only the group that ran
          // the nested render. `deriveCamNodes` dedups globally, so the camera family belongs to the
          // first builder state, and a ShadowNode in a later group overwrites it with the light
          // camera. The upload would then put the shadow camera into every shared group (the
          // "zoomed-out isometric" flash). This happens in ordinary running: the building's baked
          // walls (MeshBasicMaterial, camera nodes but no shadow node) draw first in its bundle, so
          // they own the camera family, and the first shadow-carrying group (a lit material, e.g. the
          // dock door) comes after them. Whenever the frozen sun shadow re-renders on a replay frame
          // (something moved), it first runs from that group: ~21 repairs per 358 refresh frames
          // with the demo running and the camera orbiting. Gated by
          // e2e/verify-bundle-camera-integrity.mjs.
          //
          // Re-running the update lists (never `before`, which would re-fire the shadow render) is
          // exact: NodeFrame.updateNode is renderId-gated, first visit only, so only nodes stamped at
          // the nested renderId re-run. Gated on info.calls moving, so clean frames skip it.
          if ((this.info?.calls ?? 0) !== callsBefore) {
            stats.camRepairs++
            for (const g of camNodes) {
              const nodeFrame = getFrame.call(this._nodes, g.ro)
              for (const n of g.update) nodeFrame.updateNode(n)
            }
          }
        } else {
          const list = walkMode === 'full' ? drawn : (renderBundleData.__oipNodeCover ?? drawn)
          for (const ro of list) {
            this._nodes.updateBefore(ro)
            this._nodes.updateForRender(ro)
          }
        }
        // upload the recording's deduped shared groups (captured at record, so no per-frame
        // O(draws × bindGroups) re-derivation). The derive fallback is defensive: the two
        // fields are written together.
        const bindings = renderBundleData.__oipSharedBindings ?? deriveSharedBindings(drawn)
        for (const binding of bindings) {
          if (binding.update()) {
            backend.updateBinding(binding)
            stats.uploads++
          }
          if (binding.isBuffer === true && binding.updateRanges && binding.updateRanges.length > 0) {
            binding.clearUpdateRanges()
          }
        }
      }
      // Stock replay would now loop its own desynced refresh list (redundant, since parts 1+2
      // above do the refresh) and re-attach the bundle. Do only the attach.
      backend.addBundle(this._currentRenderContext, renderBundle)
      return
    }
    orig.call(this, bundle, sceneRef, lightsNode) // no capture for this recording (paranoia): stock replay
  }

  setBundleCameraPatchActive(true) // markBundleCameraState now forwards moves here, no re-record
}
