// Placement-staging subsystem of the EditorController (../controller.ts, see
// docs/placement-staging.md). The staging session, its preview, the custom part being placed and the
// wheel angle are this area's own state (PlacementState, held by the controller as `placement`); every
// function takes that plus the narrow slice of the controller it uses (PlacementDeps: the store, the view,
// and the shared snap / rest helpers).

import { isCargoPart } from '../../core/frame'
import { createPart, createSdkPart, nextId } from '../../core/scene/scene'
import { getPackage } from '../../core/parts/partRegistry'
import { partFootprint } from '../../core/parts/partGeometry'
import { PART_DEFS } from '../../core/types'
import type { PartInstance, PartType, SceneJSON } from '../../core/types'
import { surfaceAlignPose } from '../../core/snap/snapSurfacePose'
import type { SnapCandidate, SnapPose } from '../../core/snap/snapFeatures'
import type { EditorController } from '../controller'

// --- placement -----------------------------------------------------------

export interface PlacingPreview {
  part: PartInstance
  candidate: SnapCandidate | null
  /** pointer position the preview was computed for */
  clientX: number
  clientY: number
}

/** A placement in progress: the staging session, the preview under the cursor, what is being placed, its yaw. */
export class PlacementState {
  /**
   * Placement-staging session (docs/placement-staging.md). The preview is the real part staged
   * into a transient scene: `id` is the placed part's pre-allocated final id (the staged preview
   * and the drop commit share it - that identity is what makes the drop seamless), `base` is the
   * scene the preview stages onto and the commit applies to, `staged` is the last transient we
   * streamed (identity-tracked so an external edit - undo, a collab peer - is distinguishable from
   * our own stream), and `exclude` is the self-exclusion set every placement raycast/snap takes.
   */
  session: { id: string; type: PartType; base: SceneJSON; staged: SceneJSON | null; exclude: ReadonlySet<string> } | null = null
  /** the last preview computed under the cursor (a click commits it if the pointer has not moved) */
  preview: PlacingPreview | null = null
  /** package id for a custom-part placement in flight; read by computePlacing's custom-part branch */
  pendingPackageId: string | null = null
  /** accumulated mouse-wheel yaw applied to the placement preview (see onWheel) */
  angle = 0
}

/** what placement reads and drives: the store and view, and the shared snap / rest helpers it steers the draft with */
export type PlacementDeps = Pick<
  EditorController,
  | 'store'
  | 'view'
  | 'readOnly'
  | 'surfaceAlignAxis'
  | 'runPromotedBoxes'
  | 'resetSnap'
  | 'applyLiveSnap'
  | 'trueSurfaceOf'
  | 'restUnderCursor'
  | 'resurfaceRest'
  | 'reRestSurfaceParams'
>

/**
 * Arm a placement-staging session (docs/placement-staging.md): pin the base scene and
 * pre-allocate the placed part's final id. The staged preview and the drop commit share that
 * id, so the entry the preview built is the placed part: no teardown, rebuild or pipeline
 * re-warm at the drop. The view tags the id so the (not-yet-existing) entry gets the preview
 * treatment the moment the first previewPlacing stages it.
 */
export function beginPlacingSession(pl: PlacementState, ec: PlacementDeps, type: PartType): void {
  const base = ec.store.getState().scene
  const id = nextId(base, type)
  pl.session = { id, type, base, staged: null, exclude: new Set([id]) }
  ec.view.setStaging(id)
}

/** Unwind the placement-staging session: un-tag the view, drop the preview state, and revert an
 *  in-flight staged transient back to the base scene (a no-op when nothing is staged). */
export function endPlacingSession(pl: PlacementState, ec: PlacementDeps): void {
  const session = pl.session
  pl.session = null
  ec.view.setStaging(null)
  pl.preview = null
  ec.resetSnap()
  if (session?.staged && ec.store.getState().scene === session.staged) {
    ec.store.setTransient(session.base)
  }
}

export function computePlacing(pl: PlacementState, ec: PlacementDeps, type: PartType, clientX: number, clientY: number, alt: boolean): PlacingPreview | null {
  const session = pl.session
  if (!session) return null
  // The draft carries the session's pre-allocated id (it is the part that will be committed),
  // and every self-exclusion (rest surface, snap, re-rest) keys off that id, since the previous
  // preview of it is already staged in the scene. A custom part's draft is built from its
  // package (geometry + baked params); everything else from the static PART_DEFS defaults.
  // A custom placement with no resolvable package can't preview.
  let draft: PartInstance
  if (type === 'part') {
    const pkg = pl.pendingPackageId ? getPackage(pl.pendingPackageId) : undefined
    if (!pkg) return null
    draft = createSdkPart(pkg, session.id, [0, PART_DEFS.part.defaultY, 0], pl.angle, { placed: true, units: ec.store.getState().scene.units })
  } else {
    draft = createPart(type, session.id, [0, PART_DEFS[type].defaultY, 0], pl.angle)
  }
  // drop-snap: rest the part on the collision surface under the cursor; with nothing under it, rest on the
  // floor. A legged deck (rest: 'surfaceBelow') stands `standHeight` above the surface so its legs reach it;
  // everything else rests its footprint flush (conveyors keep belt height - see floorRest). Shared with
  // Shift+G reposition via restUnderCursor so both treat custom parts identically. Holding Alt is the
  // face snap, same as the reposition gesture: the ghost backs onto the surface under the cursor
  // (the physics-true plane on conveyor tops), its alignment axis (X/Y/Z keys) turned onto the normal and
  // the scroll angle spinning on top - so a part can be placed straight onto a wall, a flank, or an
  // inclined bed from the catalog. Declared snap still evaluates after either path; N / Shift+N are the snap kill-switches, not Alt.
  const surface = ec.view.surfaceAt(clientX, clientY, session.exclude)
  if (alt && surface) {
    const plane = ec.trueSurfaceOf(surface)
    const aligned = surfaceAlignPose(draft, plane.point, plane.normal, ec.surfaceAlignAxis, pl.angle)
    draft.position = [...aligned.position] as [number, number, number]
    draft.rotationY = aligned.rotationY
    if (aligned.rotationX) draft.rotationX = aligned.rotationX
    if (aligned.rotationZ) draft.rotationZ = aligned.rotationZ
  } else {
    const rested = ec.restUnderCursor(draft, surface, clientX, clientY)
    if (!rested) {
      ec.resetSnap()
      return null
    }
    // A zero-footprint part (an annotation) has nothing to rest on. Rested, it would lie flat on whatever is
    // under the cursor, which for a note means face-down on the concrete. Hover it its `defaultY` above the
    // rest point instead: chest height above the floor, or above the belt when dropped on a conveyor, so a
    // note reads against the machine it is about. Derived from the footprint rather than a type test, because
    // nothing with zero extent can rest on anything; `group` is the only other such type and is never placed.
    const fp = partFootprint(draft)
    if (fp.hx === 0 && fp.hz === 0 && fp.y0 === 0 && fp.y1 === 0) {
      draft.position = [rested[0], rested[1] + PART_DEFS[type].defaultY, rested[2]]
    } else {
      draft.position = rested
    }
  }
  const proposed: SnapPose = {
    position: [...draft.position] as [number, number, number],
    rotationY: draft.rotationY,
  }
  // Alt (face align) is explicit and complete: suppress the ambient snap so a neighbour can't pull a
  // declared-flush mover (a box) off the aligned pose. Without Alt, ambient snap runs.
  const candidate = ec.applyLiveSnap(draft, proposed, alt, session.exclude)
  if (!candidate) return { part: draft, candidate: null, clientX, clientY }
  // A snap can raise the draft to the target conveyor's belt height (a non-default floor plane); re-resolve
  // its rest:'surfaceBelow' param so the preview legs already reach the floor (WYSIWYG), matching what the
  // commit writes. Exclude the draft's own id from the downward raycast. No-op for non-legged parts.
  const part = ec.resurfaceRest({
    ...draft,
    position: [...candidate.pose.position] as [number, number, number],
    rotationY: candidate.pose.rotationY,
    params: { ...draft.params, ...(candidate.paramOverrides ?? {}) },
  } as PartInstance, session.exclude)
  return { part, candidate, clientX, clientY }
}

export function placePart(pl: PlacementState, ec: PlacementDeps, type: PartType, preview: PlacingPreview): void {
  if (ec.readOnly) return
  const session = pl.session
  if (!session) return
  const base = session.base
  // singleton: one building per scene; placing it is single-shot
  if (type === 'building' && base.parts.some((p) => p.type === 'building')) {
    ec.store.cancelPlacing()
    return
  }
  // Close the session before committing: the commit's sync must find the view un-tagged (so the
  // entry's shadows/layers/pool membership settle) and the sim gate un-sessioned (the committed
  // scene must be pushed). The staged entry itself is not torn down: the commit re-syncs it in
  // place under the same pre-allocated id, which is what makes the drop seamless: no rebuild,
  // no pipeline re-warm, no blank frame (docs/placement-staging.md).
  pl.session = null
  ec.view.setStaging(null)
  const placed = {
    ...preview.part,
    id: session.id,
    position: [...preview.part.position] as [number, number, number],
    params: { ...preview.part.params },
    // the building is a structural backdrop - locked by default so it isn't selected/dragged by accident
    ...(type === 'building' ? { locked: true } : {}),
    // an attach snap (a 'face'-mounted button placed straight onto a cabinet): the new device is
    // soft-parented under its host, so moving the host carries it from the first drop
    ...(preview.candidate?.attach ? { parent: preview.candidate.targetId } : {}),
  } as PartInstance
  let parts = [...base.parts, placed]
  const c = preview.candidate
  if (c?.targetParamOverrides) {
    parts = parts.map((p) =>
      p.id === c.targetId ? ({ ...p, params: { ...p.params, ...c.targetParamOverrides } } as PartInstance) : p,
    )
  }
  // A custom part must carry its package with the scene (self-contained save/share), so embed it on
  // first placement if the scene doesn't already have it.
  let packages = base.packages
  let label = PART_DEFS[type].label
  if (placed.type === 'part') {
    const pkg = getPackage(placed.packageId)
    if (pkg) {
      label = pkg.name
      if (!(packages ?? []).some((p) => p.id === pkg.id)) packages = [...(packages ?? []), pkg]
    }
  }
  let scene: SceneJSON = { ...base, parts, ...(packages ? { packages } : {}) }
  // A snap can raise the placed deck to the target conveyor's belt height (a non-default floor
  // plane) without touching its rest:'surfaceBelow' param, so the legs stay sized for the pre-snap
  // height and never reach the floor. Re-resolve that param from the surface now beneath the placed
  // part - the same one-shot re-rest the move-drag commit runs (see reRestSurfaceParams).
  if (c) scene = ec.reRestSurfaceParams(scene, [placed.id])
  // Cargo dropped onto a running line is a transient product ("inject one and watch it flow"), not staged
  // design, so tag it run-scoped and let Stop drop it, the same rule as a promoted spawner box (Stop
  // returns the line to how it was authored). Placement while stopped is durable authoring, untouched.
  // Scoped to cargo: equipment/structure placed mid-run is a real edit and must persist. Tagged before the
  // commit: the store's edit gate reads run-ownership to decide whether this is an edit at all, and a box
  // tagged after it would be saved and put in the undo history as authored content.
  if (ec.store.getState().running && isCargoPart(placed)) ec.runPromotedBoxes.add(placed.id)
  // undo must return to the base scene: the store currently holds our staged transient,
  // and an undo onto that would resurrect the preview as a phantom part
  ec.store.commit(`Place ${label}`, scene, { before: base })
  // a newly placed part becomes the selection (matching paste/duplicate), so the Inspector opens
  // on it immediately; in click-to-place the gizmo stays hidden until placing mode ends
  ec.store.select(placed.id)
  const s = ec.store.getState()
  if (type === 'building') ec.store.cancelPlacing()
  // click-to-place stays in placing mode: re-arm on the committed scene with a fresh id
  else if (s.mode === 'placing') beginPlacingSession(pl, ec, type)
  ec.resetSnap()
}

/**
 * Recompute the placement preview under the cursor and stage it: the real part, streamed into
 * a transient scene exactly like a reposition drag (docs/placement-staging.md). Because the
 * staged part is genuinely in scene.parts, everything scene-derived previews live with no extra code:
 * roller grids, guard openings cut into the snap host, spur rail folds, platform railing gaps.
 * Shared by pointer-move and drag-over; losing the preview (off-viewport, no surface) reverts
 * the transient to the session's base scene.
 */
export function previewPlacing(pl: PlacementState, ec: PlacementDeps, clientX: number, clientY: number, alt: boolean): void {
  const s = ec.store.getState()
  if (s.mode !== 'placing' || !s.placingType) return
  const session = pl.session
  if (!session) return
  const preview = computePlacing(pl, ec, s.placingType, clientX, clientY, alt)
  pl.preview = preview
  if (preview) {
    const staged: SceneJSON = { ...session.base, parts: [...session.base.parts, preview.part] }
    session.staged = staged
    ec.store.setTransient(staged)
  } else if (session.staged) {
    const wasStaged = ec.store.getState().scene === session.staged
    session.staged = null
    if (wasStaged) ec.store.setTransient(session.base)
  }
}
