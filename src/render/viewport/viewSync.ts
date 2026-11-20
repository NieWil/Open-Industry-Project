// The scene diff: syncScene adds, updates and removes part entries, holds fresh
// parts for the pipeline warm, and re-pools; plus the building-less backdrop and each part's flow arrow.

import { Box3, WebGLRenderer } from 'three'
import { isCargoPart } from '../../core/frame'
import { effectivelyHiddenSet } from '../../core/scene/hierarchy'
import { resolveScene, renderResolvedKey } from '../../core/scene/sceneResolve'
import { SceneDeltaBuilder } from '../../core/scene/sceneDelta'
import { getPackage, registryRevision } from '../../core/parts/partRegistry'
import type { BuildingPart, SceneJSON } from '../../core/types'
import { defaultBuilding } from '../../core/scene/scene'
import { disposeCollisionProxy } from './collisionProxyMesh'
import { DEFAULT_LIGHTING } from '../env'
import { bundleGroupsRegistered, markBundleDirtyParts, notifyBundleStructureChanged } from '../bundleGroups'
import { createPartVisual } from '../parts/registry'
import { bumpStructureVersion, clearWarmOnlyVisual } from '../parts/structureRev'
import { flowArrowInstances, flowArrowSignature } from '../parts/flowArrow'
import type { Entry } from './viewTypes'
import type { RenderView } from './view'
import { wantsSwapCompile, REVEAL_BUDGET_POINTS, revealCostOf } from './viewWarmFlags'
import { partKindKey } from './viewWarm'
import { poseChanged } from './viewPool'

/** what the scene diff reaches on the view */
export type SyncHost = Pick<
  RenderView,
  | 'backdrop'
  | 'backdropGroup'
  | 'compileSwap'
  | 'entries'
  | 'env'
  | 'flowArrowBank'
  | 'flowArrowsVisible'
  | 'held'
  | 'hidden'
  | 'holdDeparted'
  | 'instancePool'
  | 'intendedVisible'
  | 'lastResolved'
  | 'lastScene'
  | 'partContainer'
  | 'pool'
  | 'poolExempt'
  | 'poolRebuild'
  | 'proxyGroup'
  | 'pumpWarm'
  | 'refreshOutline'
  | 'renderer'
  | 'sceneConsumers'
  | 'seen'
  | 'selection'
  | 'stagingId'
  | 'structureRev'
  | 'syncFlowArrow'
  | 'syncMatrixFreeze'
  | 'syncPartContainer'
  | 'syncSerial'
  | 'warm'
>

export function syncScene(view: SyncHost, scene: SceneJSON, opts?: { load?: boolean }): void {
  // a load's cold parts compile as one batch (compileSwap), not one kind at a time (pumpWarm)
  const swapLoad = opts?.load === true && wantsSwapCompile()
  const swapHeld: string[] = []
  const pool = view.pool // this sync's pool + warm bookkeeping (viewPool.ts / viewWarm.ts)
  const warm = view.warm
  view.syncSerial++
  // what this sync changes, for the scene-change consumers run at the end (viewSceneConsumers.ts). Full (fail open)
  // on a load, the first sync, or a package edit since the last one: those change parts under unchanged references.
  const rev = registryRevision()
  const delta = new SceneDeltaBuilder(opts?.load === true || view.lastScene === null || rev !== view.sceneConsumers.syncedRegistryRev)
  view.sceneConsumers.syncedRegistryRev = rev
  const wtStructuralBefore = pool.poolWTStructural.size // detect mid-drag promotions this sync
  view.lastScene = scene
  view.hidden = effectivelyHiddenSet(scene.parts)
  // one pass resolves every neighbour-derived input (roller grid, guard openings, spur extents, stair→platform
  // cut) into a per-part bundle threaded through visual.update - see docs/seam-resolvers.md
  const resolved = resolveScene(scene.parts, 'render')
  view.lastResolved = resolved
  const seen = view.seen
  seen.clear()
  // tracks whether the parent structure / part set changed this sync, so refreshOutline's
  // membership signature only moves when the outline set actually could (see structureRev)
  let structureChanged = false
  // dirty-scoped pool path (instancePool.tryUpdateParts): the ids whose entries updated this
  // sync (pose/params/grid/openings/extents), and whether any part's scene-graph visibility
  // flipped. When the sync was only entry updates - no add/remove/reparent, no visibility
  // flip, exempt set unchanged - pool membership provably couldn't move, so the changed
  // parts' rows are validated + rewritten in place instead of running the O(scene) walk.
  const poolDirty = new Set<string>()
  // parts promoted to the structural set this sync (the merge-seam ejection below) - when they
  // are the sync's only structural event, the pool path takes the scoped ejection instead of
  // the O(scene) rebuild (the snap-engage hitch)
  const promotedNow: string[] = []
  let poolVisChanged = false
  // this sync's fresh warm-kind parts, admitted as one batch after the loop (see the
  // reveal-budget block below): small batches reveal in this sync; a bulk duplicate holds
  // everything for the frame-budgeted drain
  const freshWarm: { id: string; cost: number }[] = []
  for (const part of scene.parts) {
    seen.add(part.id)
    const ctx = resolved.get(part.id)
    const rSig = renderResolvedKey(part.id, ctx)
    let entry = view.entries.get(part.id)
    let changed = false
    const held = entry ? undefined : view.held.get(part.id)
    if (held) {
      // a part held while a definition session had the scene (holdDeparted): its visual comes back as it was left,
      // re-applied only if it changed meanwhile - its instance, its neighbours' cut/grid, or its package (an edit
      // in that session; refreshPackage only reaches live entries)
      view.held.delete(part.id)
      entry = held.entry
      view.partContainer(part).add(entry.visual.object)
      view.entries.set(part.id, entry)
      if (entry.part !== part || entry.resolvedSig !== rSig || packageOf(part) !== held.pkg) entry.visual.update(part, ctx)
      entry.part = part
      entry.resolvedSig = rSig
      entry.boundsDirty = true
      entry.visual.setSelected(view.selection.has(part.id))
      structureChanged = true
      changed = true
      delta.record(part.id, undefined, part)
    } else if (!entry) {
      const visual = createPartVisual(part)
      clearWarmOnlyVisual(visual.object) // adopted into the scene: its structure moves the epoch again
      view.partContainer(part).add(visual.object)
      entry = { part, visual, resolvedSig: rSig, flowSig: '', bbox: new Box3(), boundsDirty: true, proxy: null, bakedPoseRev: 0, bakedStructRev: 0 }
      view.entries.set(part.id, entry)
      if (rSig) visual.update(part, ctx)
      if (view.selection.has(part.id)) visual.setSelected(true)
      // WebGPU: hold this fresh part hidden and warm its pipelines off the draw path (pumpWarm) instead
      // of letting the next draw compile them cold (a big frame drop, esp. for procedural parts). Only
      // after the initial load compile settled - before that compileStaged owns the parts' staging -
      // and only for a kind that hasn't compiled yet (kindWarm): pipelines are shared per kind, so a
      // duplicate/paste of anything already warm reveals immediately instead of trickling in.
      // The placement-staging drop never reaches this branch: the staged preview and the committed part
      // share one id, so the commit re-syncs the existing (already-warm) entry. Only the session start
      // adds an entry (docs/placement-staging.md).
      if (warm.incrementalWarmReady && !(view.renderer instanceof WebGLRenderer)) {
        if (!warm.kindWarm.has(partKindKey(part))) {
          warm.warming.add(part.id)
          if (swapLoad) swapHeld.push(part.id)
          else warm.warmQueue.add(part.id)
        } else if (!isCargoPart(part)) {
          // Warm kind: pipelines are cache hits, but three still does per-object first-draw setup
          // (cheap for cache-hitting plain meshes, heavy for instanced banks - see
          // REVEAL_BUDGET_POINTS). Batch admission is decided after the loop, once the sync's
          // whole batch is known. Cargo is exempt: it renders through the instanced batch and
          // its per-part mesh is held hidden by intendedVisible.
          freshWarm.push({ id: part.id, cost: revealCostOf(entry.visual.object) })
        }
      }
      structureChanged = true // a new part enters the tree
      changed = true
      delta.record(part.id, undefined, part)
    } else if (
      entry.part !== part ||
      entry.resolvedSig !== rSig
    ) {
      // a neighbour moving can change this part's grid, guard openings, spur extents, or stair→platform cut even if its own pose didn't
      delta.record(part.id, entry.part, part)
      if (entry.part.parent !== part.parent) structureChanged = true // reparent shifts subtree membership
      // moved-without-a-drag stream detection (poolMovedAt): a pose change in two consecutive
      // syncs is a stream (Inspector scrub, a collab peer's drag) - eject the part from the
      // instance pool so each further step stops re-baking it. A one-shot move (undo, a single
      // committed edit) never trips this and keeps its single re-bake. Parts under our own
      // pointer drag are the drag seam's business (poolDragEject / poolWriteThrough) and skipped.
      if (
        view.instancePool &&
        !pool.poolDragEject?.has(part.id) &&
        !pool.poolWriteThrough?.has(part.id) &&
        poseChanged(entry.part, part)
      ) {
        if (pool.recentMoveSerial.get(part.id) === view.syncSerial - 1) pool.poolMovedAt.set(part.id, performance.now())
        pool.recentMoveSerial.set(part.id, view.syncSerial)
      }
      // Write-through fallback: a structural change during a pure-move drag can't ride the
      // fast paths, so the affected part is ejected from both merge seams (pool + bundle) for
      // the rest of the drag and draws live-encoded; drag end returns it through the existing
      // exactly-once re-bake/re-record. Two flavours of the same hazard:
      //  - the dragged part: a param change regenerates its hardware (liveReRest regrowing a
      //    legged deck's stand, a snap's live param fold), or its resolved context rebuilds its
      //    rig (a stair's whole-flight lift keys the geometry signature) - pose-only row writes
      //    then reference the dead bake ("ghost geometry at the old snap spot").
      //  - a passive host: a neighbour-derived cut (stair→platform railing gap, guard opening)
      //    rewrites its bank counts/matrices in place while it sits folded in the pool and
      //    recorded in a bundle. Without promotion here, only the drag's first transition falls
      //    through to the full rebuild; every later engage/disengage in the same gesture takes the
      //    write-through fast path and neither merge layer refreshes. That is the intermittent
      //    "railing only opens/closes on commit" bug (fails with ?nobundle or ?noinstancepool
      //    alone, correct with both off: each layer misses it independently).
      // The seam-level invalidation rule: a changed resolved signature means this part's drawn
      // geometry restructured from the neighbour side (cut/opening/grid) - bump its structure
      // version here, at the one place that provably sees every such change, so every retained
      // layer (bundle epoch poll, registries refresh) re-records without the mutation site
      // (rig refresh, functionMesh reconcile, …) having to know those layers exist. Mutation-site
      // bumps remain only for changes that arrive outside a sync (async GLB/roller attaches).
      // Discrete by construction: resolved keys are quantized, so this can't fire per-frame on a
      // pose stream - and mid-drag the block below takes the affected parts out of the retained
      // layers entirely at the first transition.
      if (entry.resolvedSig !== rSig) bumpStructureVersion(entry.visual.object)
      if (
        pool.poolWriteThrough &&
        !pool.poolWTStructural.has(part.id) &&
        (entry.resolvedSig !== rSig ||
          (pool.poolWriteThrough.has(part.id) && entry.part.params !== part.params))
      ) {
        pool.poolWTStructural.add(part.id)
        promotedNow.push(part.id)
        if (bundleGroupsRegistered() && !pool.bundleDragEjected.has(part.id)) {
          pool.bundleDragEjected.add(part.id)
          view.syncPartContainer(entry) // re-home to the live group → one re-record, then per-frame encode
        }
      }
      // render bundles: a params/grid/openings/extents change is not notified coarsely here.
      // The mutation sites that actually change the draw list bump the visual's
      // structureVersion (functionMesh reconcile, rig link regrow, sdkPart rebuild) and
      // syncBundleInvalidation's poll picks that up. Pose-only moves and in-place
      // matrix/attribute rewrites (a reposition drag's standHeight churn) replay without a re-record.
      // Notifying on params identity would re-record every frame of a drag (the "moving a part
      // spikes draw calls to 500+" bug).
      // Caveat: pose/matrix freshness on replay is owned by bundleReplayRefresh's per-object
      // walk (stock replay's own refresh list is desynced; under it a bundled robot's arm
      // freezes mid-run). `?bundlelive` (partContainer) is the internals-independent fallback.
      entry.visual.update(part, ctx)
      entry.part = part
      entry.resolvedSig = rSig
      entry.boundsDirty = true
      changed = true
      poolDirty.add(part.id) // candidate for the dirty-scoped pool path (validated there)
    }
    view.syncFlowArrow(entry)
    {
      // render bundles: a bundle bakes visibility at record time, so a hide/unhide (hidden set,
      // warming hold, staging) must re-record
      const vis = view.intendedVisible(entry)
      if (entry.visual.object.visible !== vis) {
        if (!changed) delta.record(part.id, part, part) // shown/hidden with no edit of its own (a hidden parent)
        entry.visual.object.visible = vis
        poolVisChanged = true // pool eligibility moved - the dirty-scoped path must not run
        notifyBundleStructureChanged()
      }
    }
    // freeze a static part's matrix only after its visibility is settled, so the
    // once-baked subtree drops out of the per-frame walk (the flow arrow lives in the
    // shared FlowArrowBank, posed via syncFlowArrow, not in this subtree)
    if (changed) {
      view.syncPartContainer(entry)
      view.syncMatrixFreeze(entry)
    }
  }
  // Reveal-budget batch admission (see REVEAL_BUDGET_POINTS). Decided over the sync's whole
  // batch: if the fresh warm-kind parts together fit the budget - every small add - they stay
  // revealed in this sync. A single fresh part is admitted wholesale even when bank-heavy (the
  // single-duplicate same-commit instant contract, guarded by verify-webgpu-duplicate-instant-
  // reveal). A bulk batch (group duplicate/paste) holds everything for the frame-budgeted drain:
  // clones stage stacked exactly on their originals, so deferring the whole batch renders
  // pixel-identical frames - and it keeps the batch's first-draw setup and its pool-bank growth
  // (held parts aren't pool-eligible until they reveal) off the commit/grab frame entirely.
  //
  // A load that brings cold kinds takes its warm-kind parts into the same compile batch instead:
  // the scene is covered while it arrives (editor/sceneSwapCover.ts), so there is no live frame to
  // protect, and compileAsync does their per-object first-draw setup concurrently with the cold
  // kinds' pipelines rather than a budget's worth per frame after them. A load of kinds that are
  // all warm keeps the budget: A/B'd, revealing that at once is a ~1.45 s frozen frame
  // where the budget is a ~1.6 s cover that keeps presenting.
  if (swapHeld.length > 0) {
    let hid = false
    for (const f of freshWarm) {
      warm.warming.add(f.id)
      swapHeld.push(f.id)
      const entry = view.entries.get(f.id)
      if (entry && entry.visual.object.visible) {
        entry.visual.object.visible = false
        poolVisChanged = true // pool eligibility moved - the dirty-scoped path must not run
        hid = true
      }
    }
    if (hid) notifyBundleStructureChanged() // visibility is baked into a recorded bundle
    freshWarm.length = 0
    for (const id of swapHeld) warm.swapQueue.add(id)
  }
  if (freshWarm.length > 1 && freshWarm.reduce((s, f) => s + f.cost, 0) > REVEAL_BUDGET_POINTS) {
    let held = false
    for (const f of freshWarm) {
      warm.warming.add(f.id)
      warm.revealQueue.add(f.id)
      const entry = view.entries.get(f.id)
      if (entry && entry.visual.object.visible) {
        entry.visual.object.visible = false
        poolVisChanged = true // pool eligibility moved - the dirty-scoped path must not run
        held = true
      }
    }
    if (held) notifyBundleStructureChanged() // visibility is baked into a recorded bundle
  }
  for (const [id, entry] of view.entries) {
    if (!seen.has(id)) {
      entry.visual.object.removeFromParent()
      // held (a definition session took the scene): detached whole, to come back on Back without a rebuild. The
      // merge layers let it go like any departed part (instancePool restores its sources' visibility on its next
      // rebuild), and nothing of it is freed while it is held
      if (view.holdDeparted) view.held.set(id, { entry, pkg: packageOf(entry.part) })
      else entry.visual.dispose()
      view.flowArrowBank.remove(id) // the arrow lives in the shared bank, not the visual subtree
      if (entry.proxy) {
        disposeCollisionProxy(entry.proxy)
        view.proxyGroup.remove(entry.proxy)
        entry.proxy = null // built again on demand, as for a new entry
      }
      view.entries.delete(id)
      delta.record(id, entry.part, undefined)
      pool.bundleDragEjected.delete(id) // a part deleted mid-drag must not pin a stale eject
      // a budget-held clone removed before its reveal (undo / Shift+drag cancel) leaves the queue
      // now; warmQueue ids stay - pumpWarm already tolerates and clears removed entries itself
      if (warm.revealQueue.delete(id)) warm.warming.delete(id)
      structureChanged = true // a part left the tree
    }
  }
  // the held parts a sync outside a definition session did not bring back are gone for good
  if (!view.holdDeparted && view.held.size > 0) {
    for (const { entry } of view.held.values()) entry.visual.dispose()
    view.held.clear()
  }
  // moved-stream bookkeeping: forget one-shot movers (no move for two syncs) and departed parts.
  // poolMovedAt (the actually-ejected set) expires on wall-clock quiet in tick() instead, so a
  // stream that stalls across syncs (a scrub pause) doesn't re-pool mid-interaction.
  for (const [id, serial] of pool.recentMoveSerial) {
    if (serial < view.syncSerial - 1 || !seen.has(id)) pool.recentMoveSerial.delete(id)
  }
  for (const id of pool.poolMovedAt.keys()) if (!seen.has(id)) pool.poolMovedAt.delete(id)
  if (structureChanged) {
    view.structureRev++
    notifyBundleStructureChanged() // a part entered/left/reparented → the bundle's draw list moved
  }
  // No scene building -> show the non-content warehouse backdrop so the viewport isn't a grey void;
  // a scene building clears it (and owns the lighting itself).
  const building = scene.parts.find((p): p is BuildingPart => p.type === 'building')
  syncBackdrop(view, building === undefined)
  // the building owns world lighting; the backdrop drives it when shown, else defaults
  const lightSource = building ?? view.backdrop?.part
  view.env.setLighting(
    lightSource
      ? {
          brightness: lightSource.params.brightness,
          backgroundColor: lightSource.params.backgroundColor,
        }
      : DEFAULT_LIGHTING,
  )
  // the reactions to an edit (the idle cargo batch, the stopped beam probes, ...), each run only when this sync
  // changed a part it reads
  view.sceneConsumers.run(delta.build())
  // render bundles: hand the diff's dirty ids to the active-frame subset refresh - a synced
  // edit's draws refresh this frame even though they're outside the always-active bucket
  // (bundleReplayRefresh part 1; structural changes re-record via the notify seams instead)
  if (poolDirty.size > 0) markBundleDirtyParts(poolDirty)
  // Re-pool static hardware after the parts settle - cheapest applicable path first:
  //  1. Pure-move drag: membership can't change - stream the dragged parts' poses into the
  //     pool buffers in place instead of running the signature walk (which would see moved
  //     pooled matrices and re-bake every frame).
  //  2. Dirty-scoped edit: the sync was only entry updates (poolDirty), with no add/remove/
  //     reparent, no visibility flip, no mid-drag structural promotion, and an unchanged
  //     exempt set - membership provably couldn't move, so tryUpdateParts validates the dirty
  //     parts' recorded rows (same meshes/counts/geometry/materials) and rewrites them in
  //     place. An Inspector pose commit or constant-count param scrub costs O(edited part)
  //     instead of the O(scene) walk + re-bake. Validation failure (a bank re-minted or
  //     re-counted) falls through to 3.
  //  3. Full rebuild: anything structural - part added/removed/reparented (structureChanged),
  //     a dragged part's params regenerated its hardware (poolWTStructural promotion above;
  //     the rebuild ejects it via poolExempt), a visibility flip, or an exempt-set move (e.g.
  //     the moved-stream detector ejecting a scrubbed part this sync).
  if (
    pool.poolWriteThrough &&
    view.instancePool &&
    !structureChanged &&
    pool.poolWTStructural.size === wtStructuralBefore
  ) {
    view.instancePool.writeThrough(pool.poolWriteThrough)
  } else if (
    pool.poolWriteThrough &&
    view.instancePool &&
    !structureChanged &&
    !poolVisChanged &&
    promotedNow.length > 0 &&
    // always true today - promotedNow is pushed in lockstep with the set's only add-site (which
    // is guarded by !has). Kept as a tripwire: a future second promotion site would break the
    // equality and fall through to the full rebuild instead of riding an ejection that misses it.
    pool.poolWTStructural.size === wtStructuralBefore + promotedNow.length
  ) {
    // 1b. Scoped promotion ejection: this sync's only structural event is the merge-seam
    // promotion (a cut transition mid-drag). A full poolRebuild here would be the snap-engage
    // hitch (23ms O(scene) walk at 120 conveyors - e2e/probes/promotion-rebuild-cost.mjs). Instead
    // the promoted parts' pooled rows zero in place and their sources go live (ejectParts),
    // then the drag continues. The exempt key is refreshed to the post-promotion set, which the
    // pool reflects after the ejection, so gated rebuild paths don't fire the skipped walk
    // mid-drag; the poisoned signature guarantees the release's full re-bake regardless.
    view.instancePool.ejectParts(new Set(promotedNow))
    pool.poolExemptKey = [...view.poolExempt()].sort().join(',')
    view.instancePool.writeThrough(pool.poolWriteThrough)
  } else if (
    view.instancePool &&
    !structureChanged &&
    !poolVisChanged &&
    pool.poolWTStructural.size === wtStructuralBefore &&
    poolDirty.size > 0 &&
    [...view.poolExempt()].sort().join(',') === pool.poolExemptKey &&
    view.instancePool.tryUpdateParts(poolDirty)
  ) {
    // dirty-scoped path handled it - rows rewritten in place, signature poisoned by
    // writeThrough so the next full rebuild (whatever triggers it) does a real re-bake
  } else {
    view.poolRebuild()
  }
  view.refreshOutline()
  // WebGPU: warm any freshly-added parts' pipelines off the draw path before they're drawn
  if (warm.warmQueue.size > 0) void view.pumpWarm()
  if (warm.swapQueue.size > 0) void view.compileSwap()
}

/**
 * Show/hide the non-content warehouse backdrop. Built lazily the first time a building-less scene
 * is synced and kept thereafter (toggled visible), so switching between building-less scenes doesn't
 * thrash the GLB load. It's a normal building visual in {@link backdropGroup} (outside partsGroup),
 * so it renders and lights like any building, but picking,
 * selection, and serialization - all keyed off scene parts / entries - never see it.
 */
export function syncBackdrop(view: SyncHost, show: boolean): void {
  if (show && !view.backdrop) {
    const part = defaultBuilding('__backdrop')
    const visual = createPartVisual(part)
    clearWarmOnlyVisual(visual.object) // ditto: the backdrop is drawn, so it owns its epoch bumps
    visual.update(part)
    view.backdropGroup.add(visual.object)
    view.backdrop = { visual, part }
  }
  view.backdropGroup.visible = show
}

/** (re)derive a part's flow arrow when its geometry signature changes; keep the shared
 *  instanced bank (flowArrowBank.ts) in sync with the part's pose + the toggle */
export function syncFlowArrow(view: SyncHost, entry: Entry): void {
  // The arrow lives in the view's shared FlowArrowBank - two instanced draws for the whole
  // scene, rendered from the overlay sub-pass - not in the entry's visual and not in any
  // bundle-capable group. Outside the part root because sdkPart.rebuild strips every child of
  // the part root on a package edit / hot reload, and the arrow's sig (params-derived)
  // wouldn't move to rebuild it. Outside the main pass because the WebGPU backend executes
  // render bundles at the end of the pass (finishRender → executeBundles, after all base
  // draws), so a depth-write-off arrow drawn in the base transparent pass is painted over by
  // the bundled conveyor hardware - only the post-main overlay pass delivers always-on-top.
  // Bank-mutation notifies honor the drag-eject gate: the sig tracks length, so an
  // unconditional notify would re-record every frame of a structural conveyor resize.
  const id = entry.part.id
  const inBundle = !view.pool.bundleDragEjected.has(id)
  const sig = flowArrowSignature(entry.part)
  if (sig !== entry.flowSig) {
    entry.flowSig = sig
    view.flowArrowBank.setArrow(id, sig ? flowArrowInstances(entry.part) : null)
    // a (re)build can land on a parked frame (refreshPackage on an idle scene) - bump the
    // epoch so the outline pass re-projects its cached draw list (see setFlowArrowsVisible)
    if (inBundle) notifyBundleStructureChanged()
  }
  if (entry.flowSig) {
    // pose mirror: the visual root's transform is the part's world pose (part containers sit
    // at identity; soft-parented groups keep world-space), refreshed by apply() before this
    // runs in the same sync. The bank no-ops when the pose is unchanged.
    const v = entry.visual.object
    view.flowArrowBank.setPose(id, v.position, v.quaternion, v.scale)
    // the placement-staging preview always shows its arrow (the placement-orientation cue,
    // independent of the global flow-arrow toggle)
    const vis = view.flowArrowsVisible || id === view.stagingId
    if (view.flowArrowBank.setVisible(id, vis) && inBundle) {
      notifyBundleStructureChanged() // parked-frame flip → re-project caches
    }
  }
}

/** the registered package a part draws from (its identity changes when the package is edited), or null */
function packageOf(part: { type: string }): unknown {
  const id = (part as { packageId?: string }).packageId
  return part.type === 'part' && id ? (getPackage(id) ?? null) : null
}
