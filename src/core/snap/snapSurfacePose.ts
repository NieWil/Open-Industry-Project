// The pose of a part dropped onto a surface: resting on it (surfaceRestPose), or turned onto its normal while
// Alt is held (surfaceAlignPose).

import type { PartInstance } from '../types'
import { clamp, normalizeAngle } from '../math'
import { rotateXZ as rotXZ } from '../transforms'
import { partFootprint } from '../parts/partGeometry'
import type { SnapPose } from './snapFeatures'

interface V3 {
  x: number
  y: number
  z: number
}
const cross3 = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const rotY3 = (v: V3, yaw: number): V3 => {
  const r = rotXZ(v.x, v.z, yaw)
  return { x: r.x, y: v.y, z: r.z }
}

/** basis columns of a YXZ euler (the scene's rotation order - Rz, then Rx, then Ry) */
function basisFromYXZ(ex: number, ey: number, ez: number): { X: V3; Y: V3; Z: V3 } {
  const apply = (v: V3): V3 => {
    let { x, y, z } = v
    let c = Math.cos(ez)
    let s = Math.sin(ez)
    ;[x, y] = [x * c - y * s, x * s + y * c]
    c = Math.cos(ex)
    s = Math.sin(ex)
    ;[y, z] = [y * c - z * s, y * s + z * c]
    c = Math.cos(ey)
    s = Math.sin(ey)
    ;[x, z] = [x * c + z * s, -x * s + z * c]
    return { x, y, z }
  }
  return { X: apply({ x: 1, y: 0, z: 0 }), Y: apply({ x: 0, y: 1, z: 0 }), Z: apply({ x: 0, y: 0, z: 1 }) }
}

/** the footprint box's farthest reach toward −n at basis (X, Y, Z) - the plane-touch support distance
 *  (the AABB-offset rule): position the origin at `plane point + n × support` and the box touches
 *  the plane without penetrating it */
function footprintSupport(
  fp: { hx: number; hz: number; y0: number; y1: number; cx?: number; cz?: number },
  X: V3,
  Y: V3,
  Z: V3,
  n: V3,
): number {
  const fcx = fp.cx ?? 0
  const fcz = fp.cz ?? 0
  let minDot = Infinity
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const ly of [fp.y0, fp.y1]) {
        const lx = fcx + sx * fp.hx
        const lz = fcz + sz * fp.hz
        const wx = X.x * lx + Y.x * ly + Z.x * lz
        const wy = X.y * lx + Y.y * ly + Z.y * lz
        const wz = X.z * lx + Y.z * ly + Z.z * lz
        const d = wx * n.x + wy * n.y + wz * n.z
        if (d < minDot) minDot = d
      }
    }
  }
  return -minDot
}

const unit3 = (v: [number, number, number]): V3 => {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return { x: v[0] / len, y: v[1] / len, z: v[2] / len }
}

/**
 * Rest `moving` at its current orientation so its lowest-reaching footprint corner touches the plane
 * {point, normal} - the no-penetration seat for the editor's plain drop onto a conveying surface,
 * corrected to the physics-true plane. Unlike {@link surfaceAlignPose} this changes no rotation: on a flat
 * belt the underside sits exactly flush; on an inclined bed a level box touches corner-first (never
 * buried into the slope, which would pop at Run) and settles flat naturally when the sim starts.
 */
export function surfaceRestPose(
  moving: PartInstance,
  point: [number, number, number],
  normal: [number, number, number],
): [number, number, number] {
  const n = unit3(normal)
  const b = basisFromYXZ(moving.rotationX ?? 0, moving.rotationY, moving.rotationZ ?? 0)
  const support = footprintSupport(partFootprint(moving), b.X, b.Y, b.Z, n)
  return [point[0] + n.x * support, point[1] + n.y * support, point[2] + n.z * support]
}

/**
 * Explicit surface alignment - the pure core of the editor's Shift+G + Alt face snap. Pose `moving` so it backs
 * onto the surface under the cursor: its footprint box touches the surface plane at the picked point
 * (`position = pick + normal × support`), at the picked height. No policy: any mover, any surface (a wall, a
 * cabinet flank, an inclined roller bed); the held key is the intent.
 *
 * `alignAxis` (0=+X, 1=+Y, 2=+Z, 3=−X, 4=−Y, 5=−Z; default 1) picks which local axis turns onto the normal. The
 * alignment replaces the orientation with the canonical aligned basis (remaining twist least-rolled toward
 * world-up, Gram-Schmidt), so a box Alt-dropped on a 15° bed lies flat; releasing Alt restores the part's pose, and
 * `extraYaw` (scroll-to-rotate) spins about world Y on top. Expressed as the scene's YXZ euler (rotationY +
 * optional rotationX/rotationZ, the tilt fields planar systems ignore).
 */
export function surfaceAlignPose(
  moving: PartInstance,
  point: [number, number, number],
  normal: [number, number, number],
  alignAxis: number,
  extraYaw: number,
): SnapPose {
  const n = unit3(normal)
  const axis = ((alignAxis % 6) + 6) % 6
  const sign = axis >= 3 ? -1 : 1
  const d: V3 = { x: sign * n.x, y: sign * n.y, z: sign * n.z }
  // the up helper: world-up, falling back to world-X when the normal is near-vertical
  const h: V3 = Math.abs(d.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const hd = h.x * d.x + h.y * d.y + h.z * d.z
  let u: V3 = { x: h.x - hd * d.x, y: h.y - hd * d.y, z: h.z - hd * d.z }
  const uLen = Math.hypot(u.x, u.y, u.z) || 1
  u = { x: u.x / uLen, y: u.y / uLen, z: u.z / uLen }
  // right-handed basis columns with the chosen axis on d and the twist leaning to the helper (least roll)
  let X: V3
  let Y: V3
  let Z: V3
  if (axis % 3 === 0) {
    X = d
    Y = u
    Z = cross3(d, u)
  } else if (axis % 3 === 1) {
    X = u
    Y = d
    Z = cross3(u, d)
  } else {
    X = cross3(u, d)
    Y = u
    Z = d
  }
  // scroll-to-rotate spins the whole aligned basis about world Y (the collision-reposition angle)
  if (extraYaw !== 0) {
    X = rotY3(X, extraYaw)
    Y = rotY3(Y, extraYaw)
    Z = rotY3(Z, extraYaw)
  }
  // basis → YXZ euler (the scene's rotation order; matches three's Euler 'YXZ' extraction)
  let ey: number
  let ez: number
  const zy = clamp(Z.y, -1, 1)
  const ex = Math.asin(-zy)
  if (Math.abs(zy) < 0.9999999) {
    ey = Math.atan2(Z.x, Z.z)
    ez = Math.atan2(X.y, Y.y)
  } else {
    ey = Math.atan2(-X.z, X.x)
    ez = 0
  }
  // back onto the face: the footprint box (at the full aligned orientation) touches the surface plane at
  // the pick. An axis-aligned face on the plane touches flat, not corner-first.
  const support = footprintSupport(partFootprint(moving), X, Y, Z, n)
  const near0 = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v)
  return {
    position: [point[0] + n.x * support, point[1] + n.y * support, point[2] + n.z * support],
    rotationY: normalizeAngle(ey),
    rotationX: near0(ex),
    rotationZ: near0(ez),
  }
}
