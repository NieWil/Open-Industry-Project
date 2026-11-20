// Canonical world-space planar transform primitives for the soft-parenting scene model.
//
// Positions are world meters (see PartBase.position). The scene has no true local-transform
// hierarchy: a `parent` is a soft reference and the editor treats a parent + its subtree as a
// rigid group (translate/yaw carries the subtree - see core/scene/hierarchy.subtreeIds). Every place
// that composes that planar rotation - partGeometry's local<->world helpers, prefab
// relativize/stamp, and the editor's group move/rotate - routes through `rotateXZ` here, so
// there is one definition of the rotation convention.
//
// Scope: this layer is pure and three-free, so it can live in `core`. Full 3D tilt rotation
// (pitch/roll via quaternion/Euler) depends on `three`, which `core` forbids, so it stays in the
// editor (controller.moveRotate's tilt branch). Only the planar yaw/translate path that the whole
// app shares is here. A scoped local-transform "island" for assemblies, if one is ever added,
// would extend this module.

import type { PartInstance } from './types'

/**
 * world<-local planar rotation about +Y: a local offset (x,z) rotated by `yaw` radians.
 * Convention: +X maps to (cos, -sin) (matches partGeometry.forwardXZ and the editor carry
 * math). The inverse (world->local) is the same call with `-yaw`.
 */
export function rotateXZ(x: number, z: number, yaw: number): { x: number; z: number } {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { x: x * c + z * s, z: -x * s + z * c }
}

/**
 * Orbit a world point (x,z) by `yaw` about a world pivot (px,pz) - the rigid motion every
 * part of a yaw-rotated group undergoes. For a part sitting at the pivot this is a no-op, so a
 * single centred selection rotates in place; for an off-pivot part it swings around the pivot.
 */
export function yawAboutPivot(
  x: number,
  z: number,
  px: number,
  pz: number,
  yaw: number,
): { x: number; z: number } {
  const r = rotateXZ(x - px, z - pz, yaw)
  return { x: px + r.x, z: pz + r.z }
}

/** a part-local XZ offset to world XZ, by the part's position and yaw */
export function toWorldXZ(part: PartInstance, lx: number, lz: number): { x: number; z: number } {
  const r = rotateXZ(lx, lz, part.rotationY)
  return { x: part.position[0] + r.x, z: part.position[2] + r.z }
}

/** a world XZ point to the part's local XZ, the inverse of {@link toWorldXZ} */
export function toLocalXZ(part: PartInstance, wx: number, wz: number): { x: number; z: number } {
  return rotateXZ(wx - part.position[0], wz - part.position[2], -part.rotationY)
}
