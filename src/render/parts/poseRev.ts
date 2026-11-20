import type { Object3D } from 'three'

/**
 * The single write point for per-part pose changes; structureRev.ts is the same for structure. A part
 * visual bumps `userData.poseRev` whenever a content update moves a transform in its subtree without a
 * structural rebuild: the apply() reflow/refresh/rebuild in sdkPart.ts, and the runtime rig mutators
 * that move nodes outside apply() (applyJoints/applySubPoses, squash relax, beam stretch; sdk/rig.ts and its rig*.ts modules).
 * A frozen (matrix-static) part reports this way so view.ensureFreshPose re-bakes its frozen world
 * matrices instead of rendering them stale.
 *
 * Bumping through here also advances a module-global epoch, so the per-frame "did any frozen part's
 * pose move?" check (view.updateWorldMatrices) is an O(1) integer compare instead of an O(parts)
 * sweep of two megamorphic userData reads per frozen entry every idle frame. Never write
 * userData.poseRev directly anywhere else: that would move a part's counter without the epoch, and
 * the epoch consumer would skip its re-bake (the data moves but the pixels don't).
 */

let epoch = 1

/** bump `root.userData.poseRev` (the per-part counter) and the global epoch */
export function bumpPoseRev(root: Object3D): void {
  root.userData.poseRev = ((root.userData.poseRev as number) ?? 0) + 1
  epoch++
}

/** monotonic global epoch: moves whenever any visual's poseRev is bumped */
export function visualPoseEpoch(): number {
  return epoch
}
