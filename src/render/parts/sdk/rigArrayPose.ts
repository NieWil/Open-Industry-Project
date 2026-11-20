// Posable array links (array.posable) in the view: each instance's draws, the link's own instanced primitive and the
// geometry() banks attached to the link, placed in the link's frame from the behavior's setSubPose(link, pose, i), or
// at the instance's rest place in the row when it isn't posed. The sim moves the instance bodies by the same rule
// (core posedInstanceInto), so a carrier is drawn where it collides.

import { Matrix4, Quaternion, Vector3 } from 'three'
import type { InstancedMesh } from 'three'
import type { InstancePose } from '../../../core/rig/rigPose'
import type { Vec3Tuple } from '../../../core/parts/partPackage'

const POSE = new Float64Array(7)
const _pos = new Vector3()
const _quat = new Quaternion()
const _scale = new Vector3()
const _mat = new Matrix4()

/** places one instance in its link's frame: posedInstanceInto with the rig's pose state (RigPlacement.instancePoseInto) */
export type InstancePlacer = (out: Float64Array, pose: InstancePose | null | undefined, rest: readonly number[]) => void

/** Write the first `rest.length` instances of `mesh` from `poses` (or rest), each at `scale`. */
export function writePosedInstances(mesh: InstancedMesh, rest: readonly Vec3Tuple[], poses: readonly (InstancePose | null)[] | undefined, scale: Vec3Tuple, place: InstancePlacer): void {
  const n = Math.min(rest.length, mesh.instanceMatrix.count)
  _scale.set(scale[0], scale[1], scale[2])
  for (let i = 0; i < n; i++) {
    place(POSE, poses?.[i], rest[i]!)
    _pos.set(POSE[0]!, POSE[1]!, POSE[2]!)
    _quat.set(POSE[3]!, POSE[4]!, POSE[5]!, POSE[6]!)
    _mat.compose(_pos, _quat, _scale)
    mesh.setMatrixAt(i, _mat)
  }
  mesh.instanceMatrix.needsUpdate = true
  // the instances move every frame, so the culling bounds must follow them (as linkBank's writeSlotMatrices does)
  if (n > 0) mesh.computeBoundingSphere()
}

/** One posable array link's draws and the instance poses last applied to them. */
export interface PosedArray {
  /** each instance's rest place in the link's frame (its array delta), from the last refresh */
  rest: Vec3Tuple[]
  /** the poses last applied; undefined at rest (stopped, or before the first frame) */
  poses: (InstancePose | null)[] | undefined
  /** the link's own instanced primitive and its per-copy size, when the link draws one */
  primitive: () => { mesh: InstancedMesh; scale: Vec3Tuple } | null
  /** the geometry() banks drawn once per instance on this link */
  banks: () => InstancedMesh[]
  /** where one instance stands in the link's frame */
  place: InstancePlacer
}

const UNIT: Vec3Tuple = [1, 1, 1]

/** Place every draw of one posable array at its current poses. */
export function placePosedArray(pa: PosedArray): void {
  const prim = pa.primitive()
  if (prim) writePosedInstances(prim.mesh, pa.rest, pa.poses, prim.scale, pa.place)
  for (const bank of pa.banks()) writePosedInstances(bank, pa.rest, pa.poses, UNIT, pa.place)
}
