// The face engine for findSnap (snapFeatures.ts): 'face' mounts onto a host's footprint faces, and the
// generic flush placement against them.

import { SNAP_FACE_MIN_Y_OVERLAP, SNAP_FACE_THRESHOLD, SNAP_ROTATION_COST_WEIGHT } from '../types'
import type { PartInstance } from '../types'
import { angleDiff, clamp, normalizeAngle } from '../math'
import { rotateXZ as rotXZ } from '../transforms'
import type { SnapMount } from '../parts/partApi'
import { isConveyorLike, partFootprint, toWorldXZ } from '../parts/partGeometry'
import { bodyOverlapsXZ, flushOnEdges, nearestRectEdge, posedClone, rectMoverFaces, type WorldEdge } from './snapShared'
import type { SnapCandidate, SnapPose } from './snapFeatures'

// --- the face engine: implicit footprint faces ('face' mounts + generic flush) ---

/**
 * The four vertical side faces of a part's footprint box in world space (honouring the tail-origin `cx`
 * offset), plus the box's world Y extent - the implicit `'face'` surface every part advertises. Null when the
 * footprint is degenerate (a group container, an unresolved package, a flat decal thinner than the overlap
 * minimum), which is what keeps those out of the face engine entirely.
 */
function footprintWorldEdges(part: PartInstance): { edges: WorldEdge[]; y0: number; y1: number } | null {
  const fp = partFootprint(part)
  if (fp.hx < 0.01 || fp.hz < 0.01) return null
  const y0 = part.position[1] + fp.y0
  const y1 = part.position[1] + fp.y1
  if (y1 - y0 < SNAP_FACE_MIN_Y_OVERLAP) return null
  const cx = fp.cx ?? 0
  const cz = fp.cz ?? 0
  const local = [
    { a: { x: cx + fp.hx, z: cz - fp.hz }, b: { x: cx + fp.hx, z: cz + fp.hz }, out: { x: 1, z: 0 } },
    { a: { x: cx - fp.hx, z: cz + fp.hz }, b: { x: cx - fp.hx, z: cz - fp.hz }, out: { x: -1, z: 0 } },
    { a: { x: cx - fp.hx, z: cz + fp.hz }, b: { x: cx + fp.hx, z: cz + fp.hz }, out: { x: 0, z: 1 } },
    { a: { x: cx + fp.hx, z: cz - fp.hz }, b: { x: cx - fp.hx, z: cz - fp.hz }, out: { x: 0, z: -1 } },
  ]
  const edges = local.map((e) => {
    const a = toWorldXZ(part, e.a.x, e.a.z)
    const b = toWorldXZ(part, e.b.x, e.b.z)
    const o = rotXZ(e.out.x, e.out.z, part.rotationY)
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, outX: o.x, outZ: o.z }
  })
  return { edges, y0, y1 }
}

/**
 * A `'face'` mount: the device seats on the nearest vertical face of the target's footprint box. Every part
 * advertises its four side faces implicitly, with no host declaration. Unlike the rail mount (seatOnRail, a
 * point-to-segment seat at a fixed elevation), a face seat is 2-D: the contact slides along the face with the
 * cursor and in height, both clamped to the face rect. A push button can sit anywhere on a cabinet's flank,
 * and a Y-handle drag moves it up and down the face. The device basis is yaw-only: local +Z faces the host
 * (`face: 'in'`, default) or away (`'out'`, the usual wall-mounted-button authoring; its front looks out).
 * `fitRangeParam` is ignored (a face has no span to fit). A mount declaring `attach: true` marks the
 * candidate so the commit soft-parents the device under its host (the button moves with the cabinet).
 */
export function snapFaceMount(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  mount: SnapMount,
): SnapCandidate | null {
  if (target.type !== 'part') return null
  const host = footprintWorldEdges(target)
  if (!host) return null
  // the mount point at the proposed pose steers the seat (not the origin) - an offset contact picks the face
  // it is actually over, matching how seatOnRail gates on the seat
  const seat = toWorldXZ(posedClone(moving, proposed), mount.at[0], mount.at[2])
  const seatY = proposed.position[1] + mount.at[1] + (mount.yOffset ?? 0)
  const { edge, cx, cz } = nearestRectEdge(host.edges, seat.x, seat.z)
  const contactY = clamp(seatY, host.y0, host.y1)
  const dirZ = mount.face === 'out' ? { x: edge.outX, z: edge.outZ } : { x: -edge.outX, z: -edge.outZ }
  const yaw = normalizeAngle(Math.atan2(dirZ.x, dirZ.z))
  const off = mount.outwardOffset ?? 0
  const r = rotXZ(mount.at[0], mount.at[2], yaw)
  const x = cx - r.x + edge.outX * off
  const z = cz - r.z + edge.outZ * off
  const y = contactY - mount.at[1] - (mount.yOffset ?? 0)
  // engage: the seat must come within the face threshold of its contact - 3-D, so a face high on a tall host
  // doesn't engage a device dragged at floor level. A body overlapping the host in plan mounts regardless
  // (dropped on the cabinet → its nearest face), mirroring the conveyor override gate.
  const gateDist = Math.hypot(seat.x - cx, seatY - contactY, seat.z - cz)
  const override = bodyOverlapsXZ(moving, proposed, target)
  if (!override && gateDist > SNAP_FACE_THRESHOLD) return null
  const rot = Math.abs(angleDiff(yaw, proposed.rotationY))
  const rankDist = Math.hypot(x - proposed.position[0], y - proposed.position[1], z - proposed.position[2])
  return {
    pose: { position: [x, y, z], rotationY: yaw },
    targetId: target.id,
    cost: rankDist + SNAP_ROTATION_COST_WEIGHT * rot,
    junction: { x: cx, y: contactY, z: cz },
    override,
    ...(mount.attach ? { attach: true } : {}),
  }
}

/**
 * Ambient face-flush, for a mover whose package declares `snap: { flush: true }` (crates, pallets, racks -
 * parts that get tiled): its footprint box is placed flush against the nearest vertical face of a neighbour
 * part's footprint box, through {@link flushOnEdges} with corner-flush always on (a small crate aligns a shared
 * corner with a bigger one). Y is kept from the proposal (the floor/leg rest resolvers own height), but the two
 * boxes must overlap vertically to engage, so a floor decal or a part on another storey never snaps to a box that
 * only lines up in plan. The engage gate is the tight face threshold, not the 3 m structural gate, so a box snaps
 * only when brought close.
 */
export function snapFaceFlush(moving: PartInstance, proposed: SnapPose, target: PartInstance): SnapCandidate | null {
  if (target.type !== 'part') return null
  // A conveyor is a flush target only while the mover is clear of its bed in plan: a box approaching the
  // flank (or an inclined bed's frame - the footprint's Y extent grows with the tilt) butts it like any
  // other face, but a part steered over the bed - a spawner hovering on the belt tail, cargo being dropped
  // onto the belt - must never be pulled to the flank; those flows keep their rest-on-surface placement.
  if (isConveyorLike(target) && bodyOverlapsXZ(moving, proposed, target)) return null
  const host = footprintWorldEdges(target)
  if (!host) return null
  const fm = partFootprint(moving)
  if (fm.hx < 0.01 || fm.hz < 0.01) return null
  const py = proposed.position[1]
  const m0 = py + fm.y0
  const m1 = py + fm.y1
  if (Math.min(m1, host.y1) - Math.max(m0, host.y0) < SNAP_FACE_MIN_Y_OVERLAP) return null
  const best = flushOnEdges(proposed, target.rotationY, host.edges, rectMoverFaces(fm.cx ?? 0, fm.hx, fm.hz, fm.cz ?? 0), SNAP_FACE_THRESHOLD, true)
  if (best === null) return null
  return {
    pose: { position: [best.x, py, best.z], rotationY: normalizeAngle(best.yaw) },
    targetId: target.id,
    cost: best.move + SNAP_ROTATION_COST_WEIGHT * best.rot,
    junction: { x: best.jx, y: (Math.max(m0, host.y0) + Math.min(m1, host.y1)) / 2, z: best.jz },
  }
}
