import { Group, Mesh, MeshBasicMaterial, Vector3 } from 'three'
import type { BufferGeometry } from 'three'
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js'
import { collisionProxy, shapeCornersLocal } from '../../core/geometry/collisionShapes'
import type { PartInstance } from '../../core/types'
import { applyPartRotation } from '../parts/common'

// Proxies are raycast-only (never added to the rendered scene), but Mesh.raycast
// still reads material.side, so a single shared throwaway material suffices.
const PROXY_MATERIAL = new MeshBasicMaterial()

function disposeChildren(group: Group): void {
  for (const child of group.children) (child as Mesh).geometry?.dispose()
  group.clear()
}

/**
 * Build/refresh `group` as a part's invisible collision-raycast proxy: one convex
 * mesh per {@link collisionProxy} shape, in the part's local frame, with the part's
 * world transform on the group. surfaceAt/surfaceBelow raycast these instead of the
 * cosmetic visual, so a dropped box rests on the part's true collision deck rather
 * than sinking into the gaps between its rendered strips/rollers.
 *
 * The group lives outside the rendered scene graph, so its world matrix is computed
 * here (the renderer never visits it).
 */
export function refreshCollisionProxy(group: Group, part: PartInstance): void {
  disposeChildren(group)
  for (const shape of collisionProxy(part)) {
    const pts = shapeCornersLocal(shape).map((p) => new Vector3(p.x, p.y, p.z))
    const mesh = new Mesh(new ConvexGeometry(pts) as BufferGeometry, PROXY_MATERIAL)
    mesh.userData.partId = part.id
    group.add(mesh)
  }
  group.position.set(part.position[0], part.position[1], part.position[2])
  applyPartRotation(group, part)
  group.updateMatrixWorld(true)
}

export function disposeCollisionProxy(group: Group): void {
  disposeChildren(group)
}
