// A typed relative transform on a selection ("+= 1.2" in an Inspector Position field, "+= 90" in Rotation Y).
// It moves the parts the way the gizmo's move and yaw drags do: the selection's descendants ride along
// (soft parenting, see hierarchy.subtreeIds), and a yaw orbits everything about the selection's footprint centre.

import { normalizeAngle } from '../math'
import { partFootprint } from '../parts/partGeometry'
import { toWorldXZ, yawAboutPivot } from '../transforms'
import type { PartInstance } from '../types'
import { subtreeIds } from './hierarchy'

/** The yaw pivot of a selection: the mean of its parts' footprint centres, as the gizmo's rotate drag uses. */
export function selectionPivotXZ(parts: readonly PartInstance[], ids: readonly string[]): [number, number] {
  const want = new Set(ids)
  let x = 0
  let z = 0
  let n = 0
  for (const p of parts) {
    if (!want.has(p.id)) continue
    const fp = partFootprint(p)
    const c = fp.cx || fp.cz ? toWorldXZ(p, fp.cx ?? 0, fp.cz ?? 0) : { x: p.position[0], z: p.position[2] }
    x += c.x
    z += c.z
    n++
  }
  return n > 0 ? [x / n, z / n] : [0, 0]
}

/** `parts` with the selection and its descendants moved by `delta` (world metres). */
export function translateParts(parts: readonly PartInstance[], ids: readonly string[], delta: readonly [number, number, number]): PartInstance[] {
  const moved = new Set(subtreeIds(parts, ids))
  return parts.map((p) =>
    moved.has(p.id)
      ? { ...p, position: [p.position[0] + delta[0], p.position[1] + delta[1], p.position[2] + delta[2]] as [number, number, number] }
      : p,
  )
}

/** `parts` with the selection and its descendants turned by `yaw` radians about the selection's pivot. */
export function yawParts(parts: readonly PartInstance[], ids: readonly string[], yaw: number): PartInstance[] {
  const [px, pz] = selectionPivotXZ(parts, ids)
  const moved = new Set(subtreeIds(parts, ids))
  return parts.map((p) => {
    if (!moved.has(p.id)) return p
    const o = yawAboutPivot(p.position[0], p.position[2], px, pz, yaw)
    return { ...p, position: [o.x, p.position[1], o.z] as [number, number, number], rotationY: normalizeAngle(p.rotationY + yaw) }
  })
}
