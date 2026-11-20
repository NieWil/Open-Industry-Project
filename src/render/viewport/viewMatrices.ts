// The view-owned world-matrix walk and the static-part matrix freeze, poseRev/structureVersion driven,
// plus which parts container (bundled or live) a part's visual goes in.

import type { Group, Object3D } from 'three'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartInstance, PartType } from '../../core/types'
import { markBundleDirtyPart, notifyBundleStructureChanged, wantsBundleLiveSplit } from '../bundleGroups'
import { visualStructureEpoch } from '../parts/structureRev'
import { visualPoseEpoch } from '../parts/poseRev'
import type { Entry } from './viewTypes'
import type { RenderView } from './view'

/** the owned matrix walk's own state (`view.matrices`) */
export class ViewMatrixState {
  // pose + structure epochs at the last walk - the idle short-circuit for the frozen-entry poll
  // (updateWorldMatrices). -1 forces the first walk to run the full poll (a first-content bump is harmless).
  lastWalkPoseEpoch = -1
  lastWalkStructEpoch = -1
  // frame counter for the dev-only escape detector's ~5 s cadence (detectMatrixEscapes)
  matrixEscapeFrame = 0
  // how many entries the last walk recomposed live (getStats → the stats overlay)
  matrixLiveParts = 0
}

/** what the matrix walk and the part containers reach on the view beyond {@link ViewMatrixState} */
export type MatrixHost = Pick<
  RenderView,
  | 'ensureFreshPose'
  | 'entries'
  | 'livePartsGroup'
  | 'matrices'
  | 'partContainer'
  | 'partsGroup'
  | 'pool'
  | 'scene'
>

// Parts whose group transform and entire subtree stay fixed while the sim runs.
// They animate only via shader uniforms (roller spin), texture offsets (belts),
// emissive (stack light) or child visibility (none of which move a transform), and
// load no async child meshes that would need a late matrix bake (the async roller
// GLB is an in-place geometry/instance swap, not a new child). Freezing them (baking
// world matrices once on placement, then matrixAutoUpdate = false across the subtree)
// drops their per-frame compose + matrixWorld multiply (often large: a conveyor is ~180
// meshes), which profiling showed is the dominant main-thread cost in dense scenes.
// Excluded: moving-child parts (gantry, turntable_conveyor,
// chain_transfer, blade_stop, building/dock doors),
// async-GLB parts that add children late (box, pallet, agv), and group containers.
// No built-in type is matrix-static, so this set is empty; SDK (`custom`) parts freeze via isMatrixStaticPart below.
const MATRIX_STATIC_TYPES = new Set<PartType>([])

// The same freeze eligibility for a `custom` (SDK) part, decided from its package geometry. Every SDK
// geometry kind is matrix-static, because the freeze is driven by poseRev/structureVersion, not a predicate:
//  - `function`/`deck` conveying beds convey via surface velocity + shader scroll (no transform moves);
//  - a `rig`, jointed or not, self-reports every runtime transform move by bumping poseRev (applyJoints/
//    applySubPoses/squashTick/probeTick in sdk/rig.ts and its rig*.ts modules), and every async child attach (GLB/roller/chain)
//    bumps structureVersion; ensureFreshPose re-bakes on either, so a diverter mid-swing re-bakes exactly
//    the frames it moves and freezes again the moment it holds still;
//  - `cargo` stubs never carry the running pose (the instanced SimBoxes batch does, boxes.ts); their
//    transforms only move through syncScene/apply(), both already tallied.
// Anything not understood (future kinds, missing package) stays live: a wrongly frozen part stops moving on screen.
export function isMatrixStaticPart(part: PartInstance): boolean {
  if (part.type !== 'part') return MATRIX_STATIC_TYPES.has(part.type)
  const g = getPackage(part.packageId)?.geometry
  if (!g) return false
  return g.kind === 'drawn' || g.kind === 'rig' || g.kind === 'cargo'
}

// What the render-bundle dirty-list means by "the runtime can move this part without a syncScene":
// jointed/aimed/subPose'd rigs and GLB-link rigs (beam stretch, squash, frame-routed joints). The bundle
// classification uses this conservative predicate (walk these on every active replay frame), independent
// of the wider poseRev-driven freeze eligibility.
export function isRuntimeMovablePart(part: PartInstance): boolean {
  if (part.type !== 'part') return !MATRIX_STATIC_TYPES.has(part.type)
  const g = getPackage(part.packageId)?.geometry
  if (!g) return true
  if (g.kind === 'drawn') return false
  if (g.kind === 'rig') return g.joints.length > 0 || g.links.some((l) => l.shape.kind === 'mesh')
  return true
}

/**
 * Which scene container a part's visual belongs in. Under `?bundlelive`, runtime-movable SDK
 * parts (isRuntimeMovablePart, the bundle classification's conservative predicate, not the
 * wider poseRev-driven freeze eligibility) go to livePartsGroup so they render outside the
 * bundle replay entirely (see the field doc). Everything else, including buildings (whose
 * dock-door tick marks the part on motion), stays in the bundle-capable partsGroup.
 */
export function partContainer(view: MatrixHost, part: PartInstance): Group {
  // a structural drag (resize/scale/guard-opening) regenerates the part's geometry every
  // frame, a draw-list change the bundle would otherwise re-record in full per frame (the
  // "resizing a conveyor spikes draw calls" bug). The dragged parts render from the unbundled
  // sibling for the drag instead (mirroring the pool's structural ejection, same seam):
  // one re-record at the start and end, and the other ~550 draws replay throughout.
  if (view.pool.bundleDragEjected.has(part.id)) return view.livePartsGroup
  if (!wantsBundleLiveSplit()) return view.partsGroup // default: bundleReplayRefresh owns replay freshness
  return part.type === 'part' && isRuntimeMovablePart(part) ? view.livePartsGroup : view.partsGroup
}

/** Re-home a visual whose bundle eligibility flipped (a package edit adding/removing the
 *  first joint). Membership moves the draw between bundle and live encode → re-record. */
export function syncPartContainer(view: MatrixHost, entry: Entry): void {
  const want = view.partContainer(entry.part)
  if (entry.visual.object.parent !== want) {
    want.add(entry.visual.object)
    notifyBundleStructureChanged()
  }
}

/**
 * Drop a static part's subtree from the per-frame world-matrix walk (updateWorldMatrices;
 * the view owns the walk, and three's renderer-driven one is disabled at the scene root).
 * The freeze is driven by poseRev/structureVersion. Every matrix-static part bakes its world
 * matrices once here and clears matrixAutoUpdate across the subtree. From then on every
 * mutation path self-reports:
 *  - scene-level changes (create / update / selection) route through this;
 *  - content-level ones (package-edit reflow, refresh) bump poseRev in apply();
 *  - runtime ones (frame-routed joints/subPoses, squash relax, beam stretch) bump poseRev at
 *    their write sites in sdk/rig.ts and its rig*.ts modules;
 *  - async child attaches bump structureVersion.
 * ensureFreshPose() compares both revs per frame and before frozen-matrix reads, and re-bakes on
 * movement, so a swinging diverter re-bakes exactly the frames it moves and re-freezes when it
 * holds still. Only a live pointer drag unfreezes (below). Code that needs world matrices
 * on a frozen part (vertex snap) already forces updateWorldMatrix on demand; raycasts use
 * the baked matrix, correct because the part hasn't moved. InstancedMesh instance matrices
 * and shader uniforms are independent of node matrixAutoUpdate, so roller spin / belt
 * scroll still animate. Re-enabling marks the subtree dirty so the next frame recomputes it.
 */
export function syncMatrixFreeze(view: MatrixHost, entry: Entry): void {
  const obj = entry.visual.object
  // Published for the render-bundle dirty-list (classifyBundleObject): a part the runtime can
  // move without a syncScene (jointed/aimed/subPose'd rigs, GLB-link rigs) must refresh on every
  // active replay frame. The sdkPart appliers (applyJoints/applySubPoses) exist on every rig, inert
  // or not, so applier presence can't tell them apart; this predicate tells a fence from a diverter.
  obj.userData.runtimeMovable = isRuntimeMovablePart(entry.part)
  // Freeze-ness keys on the drag seam, not selection (measured: 100 selected-and-unfrozen
  // subtrees re-entering three's per-frame matrix walk cost ~2.5ms/frame). A frozen part's
  // pose edits still apply via poseRev self-invalidation (ensureFreshPose). Only a live pointer
  // drag, which sets matrices continuously (eject or write-through mode), unfreezes, via
  // setPoolDragEject's re-sync.
  const id = entry.part.id
  const freeze =
    isMatrixStaticPart(entry.part) && !(view.pool.poolDragEject?.has(id) ?? false) && !(view.pool.poolWriteThrough?.has(id) ?? false)
  if (freeze) {
    // Recompose every node's local matrix from its TRS first: an already-frozen subtree has
    // matrixAutoUpdate === false, so updateWorldMatrix alone would bake world matrices from stale
    // locals. The root moves when a soft-parent (Group) carries the unselected part through a gizmo
    // drag; descendants move when a package edit reflows link offsets/scales (author node drag,
    // collab/master-edit resize), so the whole subtree recomposes, not just the root. Every
    // part-visual node is TRS-driven (the one hand-composed .matrix, dockDoor's, belongs to a
    // building, which is never matrix-static), so recompose-from-TRS is safe here.
    obj.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false })
    obj.updateWorldMatrix(true, true)
    entry.bakedPoseRev = (obj.userData.poseRev as number | undefined) ?? 0
    entry.bakedStructRev = (obj.userData.structureVersion as number | undefined) ?? 0
  } else if (!obj.matrixAutoUpdate) {
    obj.traverse((o) => {
      o.matrixAutoUpdate = true
      o.matrixWorldNeedsUpdate = true
    })
    obj.updateWorldMatrix(true, true)
  }
}

/**
 * The freeze cache's self-invalidation: the visual bumps userData.poseRev whenever a content update
 * moves any transform (see createCustomVisual's apply). If a frozen part's rev moved since its
 * matrices were last baked, re-bake them before they're read or rendered. This keeps "frozen" and
 * "correct" decoupled: no mutation path (author node drag, Monaco Apply, hot-reload, undo, collab)
 * needs to know about the freeze, because moving a transform anywhere in the visual flags it.
 * Called per-frame from updateWorldMatrices (every frozen entry, before the render), from the
 * tick-registry loops (callback owners read matrices earlier in the frame), and before
 * off-frame frozen-matrix reads (followAnchor, rigLinkGizmo).
 */
export function ensureFreshPose(view: MatrixHost, entry: Entry): void {
  const obj = entry.visual.object
  if (obj.matrixAutoUpdate) return // live part: the owned walk updates it every frame
  const rev = (obj.userData.poseRev as number | undefined) ?? 0
  const struct = (obj.userData.structureVersion as number | undefined) ?? 0
  if (rev === entry.bakedPoseRev && struct === entry.bakedStructRev) return
  entry.bakedPoseRev = rev
  entry.bakedStructRev = struct
  // activity mark for the bundle replay refresh: this subtree's matrices actually recompose
  // below, so its captured draws need a refresh this frame. Every matrix mutator funnels here
  // (poseRev), so this is the single mark point for all frame-driven motion: rigs, AGVs,
  // squash relax, beam stretch. Extra marks from off-frame callers are harmless (a re-bake
  // means matrices changed, so refreshing those draws is correct whenever it happens).
  markBundleDirtyPart(entry.part.id)
  // clamp while baking: late-attached children (async GLB/roller/chain arrivals, a fresh flow
  // arrow) arrive with matrixAutoUpdate=true inside the frozen subtree. The owned walk never
  // visits frozen subtrees, so a live straggler would otherwise keep an identity matrixWorld
  // forever; folding it into the freeze here bakes it and keeps the freeze invariant whole.
  obj.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false })
  obj.updateWorldMatrix(true, true)
}

/**
 * The per-frame world-matrix walk, owned by the view. three r185's scene.updateMatrixWorld()
 * recurses into every child unconditionally (matrixWorldAutoUpdate=false skips the multiply
 * but never the visit), so the stock renderer-driven walk costs O(scene nodes) per frame even
 * when nothing moves (the largest idle cost at scale: ~2-2.6ms/frame at a ×4-duplicated demo
 * line). With scene.matrixWorldAutoUpdate=false the renderers skip that walk entirely (both
 * backends gate on it) and this updates only what can move:
 *  - every scene child except the two part containers: the overlay/dynamic subtrees (gizmo,
 *    handles, ruler dots, presence avatars, sim boxes + their outlines, env lights, instance
 *    pools, backdrop, snap flashes, vsnap markers, XR rig). These are small, and walking all
 *    non-parts children keeps any future ad-hoc scene child correct by default;
 *  - live part entries (buildings/dock doors, drag-unfrozen parts, non-freezable kinds);
 *  - frozen entries only re-bake through ensureFreshPose when poseRev/structureVersion moved,
 *    including bumps from part ticks that ran earlier this same frame (squash relax, beam
 *    stretch), so re-bakes happen the same frame, matching the stock walk's timing.
 * Runs after every mutator (part ticks, frame appliers, follow, gizmo scaling) and before
 * syncBundleInvalidation + renderFrame, both of which read matrixWorld.
 */
export function updateWorldMatrices(view: MatrixHost): void {
  for (const child of view.scene.children) {
    if (child === view.partsGroup || child === view.livePartsGroup) continue
    // Skip subtrees whose world matrices no frame consumes: a hidden overlay (gizmo/handles/ruler
    // when nothing is selected; walked the frame they turn visible, before that frame's render),
    // and the instance-pool output (identity nodes that never move; per-instance edits go through
    // syncInstancedAttrs / write-through, not the node matrix). updateWorldMatrix(false, true)
    // recomposes the whole subtree unconditionally (it honors neither .visible nor
    // matrixAutoUpdate), so without the skip these would get a useless full walk every frame.
    if (!child.visible || child.userData.instancePoolGroup === true) continue
    child.updateWorldMatrix(false, true)
  }
  // Frozen (matrix-static) entries self-invalidate through poseRev/structureVersion, and both
  // funnel through a global epoch (poseRev.ts / structureRev.ts). When neither moved since the
  // last walk, no frozen bake can be stale, so skip the per-entry ensureFreshPose poll entirely
  // (it is two megamorphic userData reads × N frozen parts, the O(parts) idle sweep). A frozen
  // part moved by a syncScene is already re-baked in syncMatrixFreeze that same sync. The only
  // invalidations this poll exists to catch, runtime rig motion (poseRev) and async child
  // attaches (structureVersion), both advance an epoch, so a stale bake always opens the gate.
  // Live entries (buildings/dock doors, drag-unfrozen parts) recompose every frame regardless.
  const poseEpoch = visualPoseEpoch()
  const structEpoch = visualStructureEpoch()
  const frozenMayHaveMoved = poseEpoch !== view.matrices.lastWalkPoseEpoch || structEpoch !== view.matrices.lastWalkStructEpoch
  view.matrices.lastWalkPoseEpoch = poseEpoch
  view.matrices.lastWalkStructEpoch = structEpoch
  let live = 0
  for (const entry of view.entries.values()) {
    const obj = entry.visual.object
    if (obj.matrixAutoUpdate) {
      obj.updateWorldMatrix(false, true)
      // live parts recompose unconditionally, so their bundled draws refresh every frame, the
      // conservative floor (drag-unfrozen parts stay correct). A building is the exception: it is
      // live only for its dock doors' hand-composed matrices (dockDoor.ts, which a freeze's
      // recompose-from-TRS would overwrite), and every way one changes has its own signal. A door
      // easing re-records the bundle each frame it moves (building.ts tick), a wall/roof flip
      // re-records and is marked by viewTick, and an edit is marked by syncScene. Marking it here
      // too would keep the dirty set non-empty, so no parked frame would skip the replay refresh
      // walk (bundleReplayRefresh.ts), and every frame would re-render the key shadow from inside it.
      if (entry.part.type !== 'building') markBundleDirtyPart(entry.part.id)
      live++
    } else if (frozenMayHaveMoved) view.ensureFreshPose(entry)
  }
  view.matrices.matrixLiveParts = live
  if (import.meta.env.DEV) detectMatrixEscapes(view)
}

// dev-only escape detector for the owned matrix walk (the census-probe pattern): a mover the
// walk can't see renders stale ("data moved, pixels did not"), so report it loudly in dev. Two
// invariants, checked every ~5s: (1) every direct child of the part containers is a known
// entry visual (anything else is invisible to the entry loop); (2) a frozen root has no
// matrixAutoUpdate=true descendant, since a live straggler under a frozen root is never walked.
// ensureFreshPose clamps these on re-bake; a persistent one means a mutation path forgot
// to bump poseRev/structureVersion.
export function detectMatrixEscapes(view: MatrixHost): void {
  if (++view.matrices.matrixEscapeFrame % 300 !== 0) return
  const offenders: string[] = []
  const known = new Set<Object3D>()
  for (const e of view.entries.values()) known.add(e.visual.object)
  for (const container of [view.partsGroup, view.livePartsGroup]) {
    for (const child of container.children) {
      if (!known.has(child)) offenders.push(`non-entry child "${child.name || child.type}" in a parts container`)
    }
  }
  for (const [id, e] of view.entries) {
    const root = e.visual.object
    if (root.matrixAutoUpdate) continue // live: the walk covers the whole subtree
    let stray = 0
    root.traverse((o) => { if (o.matrixAutoUpdate) stray++ })
    if (stray > 0) offenders.push(`part ${id} (${e.part.name ?? e.part.type}): ${stray} live node(s) under its frozen root`)
  }
  if (offenders.length > 0) console.error('[oip] matrix-walk escapes - these can render stale:', offenders)
}
