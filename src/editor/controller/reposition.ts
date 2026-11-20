// Shift+G collision reposition of the EditorController (../controller.ts). The gesture in
// flight, its wheel yaw and whether the Alt face alignment is applied are this area's own state
// (RepositionState, held by the controller). The gesture freezes and steers live cargo through the drag
// helpers (./drag.ts), which work on the whole controller, so every function takes the controller too.

import { normalizeAngle } from '../../core/math'
import { subtreeIds } from '../../core/scene/hierarchy'
import { rotateXZ } from '../../core/transforms'
import { surfaceAlignPose } from '../../core/snap/snapSurfacePose'
import type { SnapPose } from '../../core/snap/snapFeatures'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { EditorState } from '../store/store'
import * as dragOps from './drag'
import type { EditorController } from '../controller'

/** The Shift+G gesture in flight: session state, never the document (the commit is the edit). */
export class RepositionState {
  // Shift+G collision reposition: a keyboard-started, mouse-steered modal gesture
  // (no button held); click commits, Esc cancels. Repositions the part onto collision surfaces under the cursor.
  // `id` is the active node (last-selected) the cursor raycast drives; `carried` is the
  // rest of the selection plus every subtree, each moving rigidly with it. `carriedStart` holds those parts as the
  // gesture found them, resolved once so a pointer move doesn't search the scene for each.
  active: { start: SceneJSON; id: string; moved: boolean; carried: string[]; carriedStart: PartInstance[] } | null = null
  // accumulated mouse-wheel yaw applied to the reposition target (see onWheel)
  angle = 0
  // whether the Alt face alignment (EditorController.surfaceAlignAxis) is currently applied (resets on Alt release)
  alignApplied = false
}

/** enter the modal reposition gesture for the selection (the active node steers it) */
export function beginReposition(r: RepositionState, ec: EditorController, s: EditorState): void {
  if (r.active || ec.drag || s.mode === 'placing') return
  if (s.selectedIds.length === 0 || !ec.lastPointer) return
  // a locked part anywhere in the selection blocks the gesture (skip locked nodes)
  if (ec.selectedParts(s).some((p) => p.locked)) return
  // active node: the last-selected part drives the collision raycast; everything
  // else (the rest of the selection and every subtree) moves rigidly with it.
  const id = s.selectedIds[s.selectedIds.length - 1]!
  const part = s.scene.parts.find((p) => p.id === id)
  if (!part) return
  const carried = subtreeIds(s.scene.parts, s.selectedIds).filter((cid) => cid !== id)
  const byId = new Map(s.scene.parts.map((p) => [p.id, p]))
  const carriedStart = carried.flatMap((cid) => byId.get(cid) ?? [])
  r.angle = 0
  ec.surfaceAlignAxis = 1
  r.alignApplied = false
  r.active = { start: s.scene, id, moved: false, carried, carriedStart }
  ec.syncPoolDragEject() // eject from the instance pool before the first transient below moves anything
  // a running cargo body is physics-owned (updateScene skips live cargo), so the
  // scene transient alone won't move it. Freeze the whole carried set for the gesture and steer
  // the bodies directly, mirroring a gizmo grab. Freezing only the steering box would leave the rest
  // of a banded group conveying away mid-reposition.
  dragOps.setDraggedBodyFrozen(ec, [id, ...carried], true)
  updateReposition(r, ec, ec.lastPointer.x, ec.lastPointer.y, false)
}

/**
 * rest the repositioned part on the surface under the cursor (centered on it),
 * else rest its underside on the floor (conveyors keep belt
 * height - see floorRest). Structural snap still applies. Holding Alt is the
 * face snap: the part backs onto the surface under the
 * cursor - its bounds touch the face at the pick, at the picked height (a wall,
 * a cabinet flank, an inclined bed) - and its alignment axis (X/Y/Z keys, Shift
 * for negative, default +Y) turns to the surface normal, yaw-projected under the
 * planar seam. Releasing Alt restores the part's own yaw and resets the axis.
 */
export function updateReposition(r: RepositionState, ec: EditorController, clientX: number, clientY: number, alt: boolean): void {
  const repos = r.active
  if (!repos) return
  const part = repos.start.parts.find((p) => p.id === repos.id)
  if (!part) return
  // exclude every moving part (active node + carried) so the selection never rests on itself
  const moving = new Set(repos.carried)
  moving.add(repos.id)
  const surface = ec.view.surfaceAt(clientX, clientY, moving)
  let pose: SnapPose
  if (alt && surface) {
    // face snap (Alt): back the part onto the face under the cursor,
    // aligning the chosen axis to the surface normal; scroll-to-rotate composes on top
    const plane = ec.trueSurfaceOf(surface)
    pose = surfaceAlignPose(part, plane.point, plane.normal, ec.surfaceAlignAxis, r.angle)
    r.alignApplied = true
    const AXIS_NAMES = ['+X', '+Y', '+Z', '-X', '-Y', '-Z'] as const
    ec.view.setTransformReadout(`Face Snap  (${AXIS_NAMES[ec.surfaceAlignAxis]} → surface)`)
  } else {
    if (r.alignApplied) {
      // Alt released mid-gesture: the part's own yaw returns on the next pose below (poses derive from
      // the drag-start yaw each move); reset the axis to the default
      r.alignApplied = false
      ec.surfaceAlignAxis = 1
    }
    ec.view.setTransformReadout(null)
    // same rest logic as placement (restUnderCursor): a legged SDK deck (rest:'surfaceBelow') stands its
    // deck standHeight above the surface/floor so its legs reach it, instead of burying its footprint.
    const position = ec.restUnderCursor(part, surface, clientX, clientY)
    if (!position) return
    pose = { position, rotationY: normalizeAngle(part.rotationY + r.angle) }
  }
  // Alt (face align) is explicit and complete: suppress the ambient snap so a neighbour can't pull a
  // declared-flush mover (a box) off the aligned pose. Without Alt, ambient snap runs.
  const c = ec.applyLiveSnap(part, pose, alt, moving)
  if (c) pose = c.pose
  if (
    pose.position[0] !== part.position[0] ||
    pose.position[1] !== part.position[1] ||
    pose.position[2] !== part.position[2] ||
    pose.rotationY !== part.rotationY ||
    (pose.rotationX ?? part.rotationX ?? 0) !== (part.rotationX ?? 0) ||
    (pose.rotationZ ?? part.rotationZ ?? 0) !== (part.rotationZ ?? 0)
  ) {
    repos.moved = true
  }
  const poses = new Map<string, SnapPose>([[repos.id, pose]])
  // carry the rest rigidly: each
  // carried part keeps its offset+yaw relative to the active node, which moved from its
  // start pose to `pose` (translate + yaw about the active node)
  if (repos.carriedStart.length > 0) {
    const dyaw = normalizeAngle(pose.rotationY - part.rotationY)
    for (const dp of repos.carriedStart) {
      // carried offset relative to the active node's start pose, rotated by the
      // active node's yaw delta, re-based onto its new position
      const r = rotateXZ(dp.position[0] - part.position[0], dp.position[2] - part.position[2], dyaw)
      poses.set(dp.id, {
        position: [pose.position[0] + r.x, pose.position[1] + (dp.position[1] - part.position[1]), pose.position[2] + r.z],
        rotationY: normalizeAngle(dp.rotationY + dyaw),
      })
    }
  }
  // preview the snap's param resize live (chain transfer adopting the host
  // roller pitch / lane length, barrier omit posts) so the part changes size as
  // it engages - matching placement, and the commit (withSnapOverrides) that
  // folds the same candidate. snap.candidate is the `c` just set above.
  // re-rest legs live too: a snap that raised the deck to a neighbour's belt height must grow the legs to
  // the floor in the preview, not just on commit (matches the gizmo-drag liveReRest + placement preview).
  let previewScene = dragOps.stagedPreview(ec, repos.start, poses, repos.id)
  previewScene = ec.reRestSurfaceParams(previewScene, [repos.id, ...repos.carried])
  ec.store.setTransient(previewScene)
  // mirror the steered poses onto the live cargo bodies (no-op when stopped or not cargo);
  // `poses` already holds the carried parts' rigidly-carried poses, built just above
  dragOps.syncDraggedBody(ec, [repos.id, ...repos.carried], poses, true)
}

export function commitReposition(r: RepositionState, ec: EditorController): void {
  const repos = r.active
  if (!repos) return
  r.active = null
  ec.view.setTransformReadout(null) // clear the face-snap alignment readout
  // release the frozen cargo bodies so they settle from the repositioned poses
  dragOps.setDraggedBodyFrozen(ec, [repos.id, ...repos.carried], false)
  if (!repos.moved) {
    ec.resetSnap()
    return
  }
  let after = ec.withSnapOverrides(ec.store.getState().scene, repos.id)
  // a snap may have raised the deck to a neighbour conveyor's belt height (a non-default floor plane);
  // re-resolve rest:'surfaceBelow' params (leg height) from the surface now beneath each moved part so
  // the legs reach the floor again - matches the gizmo-drag commit (reRestSurfaceParams).
  after = ec.reRestSurfaceParams(after, [repos.id, ...repos.carried])
  ec.commitTransform(repos.carried.length > 0 ? 'Reposition parts' : 'Reposition part', after, { before: repos.start })
  ec.resetSnap()
}

/** the wheel turned during the gesture: add a rotate-snap step to its yaw and re-steer under the cursor */
export function turnReposition(r: RepositionState, ec: EditorController, step: number, alt: boolean): void {
  r.angle = normalizeAngle(r.angle + step)
  if (ec.lastPointer) updateReposition(r, ec, ec.lastPointer.x, ec.lastPointer.y, alt)
}

/** `revert: false` ends the gesture and leaves the scene as it is now (dragOps.dropOvertakenGesture) */
export function cancelReposition(r: RepositionState, ec: EditorController, revert = true): void {
  const repos = r.active
  if (!repos) return
  r.active = null
  ec.view.setTransformReadout(null) // clear the face-snap alignment readout
  const moved = [repos.id, ...repos.carried]
  if (revert) {
    // restore every moved body to its pre-gesture pose, then release them (matches the scene revert)
    const back = new Map<string, SnapPose>()
    for (const id of moved) {
      const p = repos.start.parts.find((sp) => sp.id === id)
      if (p) back.set(id, { position: p.position, rotationY: p.rotationY })
    }
    dragOps.syncDraggedBody(ec, moved, back, true)
  }
  dragOps.setDraggedBodyFrozen(ec, moved, false)
  if (revert) ec.store.setTransient(repos.start)
  ec.resetSnap()
}
