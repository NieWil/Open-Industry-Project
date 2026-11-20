// Ray-vs-box intersection for sensor beams (C-sensing) - pure plain-number math, deterministic,
// headless-testable, shared by the sim (a sensor custom part's beam, in the worker) and reusable by render.
// A slab test on the same quaternion helpers as core/rig/rigPose, so a sensor rig's beam casts against cargo box
// OBBs without three.js.

import type { BoxFrame } from './frame'
import type { Quat, Vec3 } from './rig/rigPose'

/**
 * Ray (origin `o`, unit dir `d`) vs an axis-aligned box of half-extents `h` centred at the origin. Returns
 * the entry distance (0 if the origin is already inside), or null if it misses / the box is behind the origin.
 */
export function rayAabb(o: Vec3, d: Vec3, h: Vec3): number | null {
  let tmin = -Infinity
  let tmax = Infinity
  for (let a = 0; a < 3; a++) {
    const oa = o[a]!
    const da = d[a]!
    const ha = h[a]!
    if (Math.abs(da) < 1e-9) {
      if (oa < -ha || oa > ha) return null // parallel to the slab and outside it
    } else {
      let t1 = (-ha - oa) / da
      let t2 = (ha - oa) / da
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      if (t1 > tmin) tmin = t1
      if (t2 < tmax) tmax = t2
      if (tmin > tmax) return null
    }
  }
  if (tmax < 0) return null // box entirely behind the emitter
  return tmin >= 0 ? tmin : 0 // 0 = the emitter is already inside the box
}

// scratch tuples for rayObb's box-local ray (no per-call garbage - this runs per box per beam per sim
// step; single-threaded and consumed synchronously by rayAabb, so sharing is safe)
const _roO: Vec3 = [0, 0, 0]
const _roD: Vec3 = [0, 0, 0]

/**
 * Ray (world origin `origin`, unit dir `dir`) vs an oriented box (`boxPos`, `boxQuat`, half-extents `half`):
 * transform the ray into the box's local frame (inverse rotation) and run the slab test. Returns the entry
 * distance, or null if it misses. The rotation is the inlined scalar form of qApply(qConjugate(q), v) -
 * same formula and operation order as rigPose.qApply, without the per-call array allocations.
 */
export function rayObb(origin: Vec3, dir: Vec3, boxPos: Vec3, boxQuat: Quat, half: Vec3): number | null {
  const qx = -boxQuat[0]
  const qy = -boxQuat[1]
  const qz = -boxQuat[2]
  const qw = boxQuat[3]
  // ray origin → box-local
  const vx = origin[0] - boxPos[0]
  const vy = origin[1] - boxPos[1]
  const vz = origin[2] - boxPos[2]
  let tx = 2 * (qy * vz - qz * vy)
  let ty = 2 * (qz * vx - qx * vz)
  let tz = 2 * (qx * vy - qy * vx)
  _roO[0] = vx + qw * tx + (qy * tz - qz * ty)
  _roO[1] = vy + qw * ty + (qz * tx - qx * tz)
  _roO[2] = vz + qw * tz + (qx * ty - qy * tx)
  // ray direction → box-local
  const ux = dir[0]
  const uy = dir[1]
  const uz = dir[2]
  tx = 2 * (qy * uz - qz * uy)
  ty = 2 * (qz * ux - qx * uz)
  tz = 2 * (qx * uy - qy * ux)
  _roD[0] = ux + qw * tx + (qy * tz - qz * ty)
  _roD[1] = uy + qw * ty + (qz * tx - qx * tz)
  _roD[2] = uz + qw * tz + (qx * ty - qy * tx)
  return rayAabb(_roO, _roD, half)
}

/**
 * Ray (world `origin`, unit `dir`) vs an upright capsule: axis along world Y through (`cx`, `cy`, `cz`), `halfLen`
 * the half-length of its straight section, `radius` its radius. Returns the entry distance (0 if the origin is
 * already inside), or null on a miss. The walking pilot's body is this shape, and it is what a sensor beam sees
 * of a person. The capsule is the union of a finite cylinder and two end spheres, so its first entry is the
 * nearest of the cylinder's side entry (inside the straight section) and each sphere's entry: a ray entering
 * through a flat cylinder cap is inside an end sphere by then, so that sphere's entry is never later.
 */
export function rayCapsuleY(origin: Vec3, dir: Vec3, cx: number, cy: number, cz: number, halfLen: number, radius: number): number | null {
  const ox = origin[0] - cx
  const oy = origin[1] - cy
  const oz = origin[2] - cz
  const dx = dir[0]
  const dy = dir[1]
  const dz = dir[2]
  const r2 = radius * radius
  // origin inside: its distance to the axis segment is within the radius
  const sy = oy < -halfLen ? oy + halfLen : oy > halfLen ? oy - halfLen : 0
  if (ox * ox + sy * sy + oz * oz <= r2) return 0
  let best = Infinity
  // side of the cylinder (XZ circle), accepted only where the entry lies on the straight section
  const a = dx * dx + dz * dz
  if (a > 1e-12) {
    const b = ox * dx + oz * dz
    const c = ox * ox + oz * oz - r2
    const disc = b * b - a * c
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a
      const y = oy + t * dy
      if (t >= 0 && y >= -halfLen && y <= halfLen) best = t
    }
  }
  // the two end spheres
  for (const ey of [-halfLen, halfLen]) {
    const py = oy - ey
    const b = ox * dx + py * dy + oz * dz
    const c = ox * ox + py * py + oz * oz - r2
    const disc = b * b - c
    if (disc < 0) continue
    const t = -b - Math.sqrt(disc)
    if (t >= 0 && t < best) best = t
  }
  return best === Infinity ? null : best
}

// scratch tuples for castBeamFrame (no per-box garbage on the hot loop)
const _cbPos: Vec3 = [0, 0, 0]
const _cbQuat: Quat = [0, 0, 0, 1]
const _cbHalf: Vec3 = [0, 0, 0]

/**
 * Nearest cargo OBB a beam hits in a {@link BoxFrame} (index into the frame's arrays + entry distance),
 * or null when clear within `range`. The stopped-editor twin of the sim's castBeam: both run the same
 * rayObb slab test over cargo boxes, so the idle beam preview matches what the running sensor would read.
 */
export function castBeamFrame(origin: Vec3, dir: Vec3, range: number, frame: BoxFrame): { index: number; distance: number } | null {
  let bestT = Infinity
  let best = -1
  for (let i = 0; i < frame.count; i++) {
    const p3 = i * 3
    const p4 = i * 4
    _cbPos[0] = frame.positions[p3]!
    _cbPos[1] = frame.positions[p3 + 1]!
    _cbPos[2] = frame.positions[p3 + 2]!
    _cbQuat[0] = frame.quats[p4]!
    _cbQuat[1] = frame.quats[p4 + 1]!
    _cbQuat[2] = frame.quats[p4 + 2]!
    _cbQuat[3] = frame.quats[p4 + 3]!
    _cbHalf[0] = frame.halfExtents[p3]!
    _cbHalf[1] = frame.halfExtents[p3 + 1]!
    _cbHalf[2] = frame.halfExtents[p3 + 2]!
    const t = rayObb(origin, dir, _cbPos, _cbQuat, _cbHalf)
    if (t !== null && t <= range && t < bestT) {
      bestT = t
      best = i
    }
  }
  return best < 0 ? null : { index: best, distance: bestT }
}

const differs = (a: Float32Array, b: Float32Array, at: number, n: number): boolean => {
  for (let k = at; k < at + n; k++) if (a[k] !== b[k]) return true
  return false
}

/**
 * The rows whose beam-visible state (pose, size, tint) differs between two cargo frames, or null when the row count
 * differs: rows then shift, so there is no row-for-row answer. A beam cast against `b` can only answer differently
 * from the same cast against `a` if it enters one of these rows in `a` or in `b`.
 */
export function changedCargoRows(a: BoxFrame, b: BoxFrame): number[] | null {
  if (a.count !== b.count) return null
  const rows: number[] = []
  for (let i = 0; i < a.count; i++) {
    const p3 = i * 3
    if (
      differs(a.positions, b.positions, p3, 3) ||
      differs(a.quats, b.quats, i * 4, 4) ||
      differs(a.halfExtents, b.halfExtents, p3, 3) ||
      differs(a.colors, b.colors, p3, 3)
    ) {
      rows.push(i)
    }
  }
  return rows
}

/** values per cast in a {@link castsCrossRows} list: origin xyz, unit dir xyz, range */
export const BEAM_CAST_STRIDE = 7

const _ccO: Vec3 = [0, 0, 0]
const _ccD: Vec3 = [0, 0, 0]

/**
 * Whether any of `casts` (a flat list, {@link BEAM_CAST_STRIDE} values per cast) enters one of `rows` of `frame` within
 * its range. Costs casts x rows, against castBeamFrame's casts x every row.
 */
export function castsCrossRows(casts: readonly number[], frame: BoxFrame, rows: readonly number[]): boolean {
  for (let c = 0; c + BEAM_CAST_STRIDE <= casts.length; c += BEAM_CAST_STRIDE) {
    _ccO[0] = casts[c]!
    _ccO[1] = casts[c + 1]!
    _ccO[2] = casts[c + 2]!
    _ccD[0] = casts[c + 3]!
    _ccD[1] = casts[c + 4]!
    _ccD[2] = casts[c + 5]!
    const range = casts[c + 6]!
    for (const i of rows) {
      const p3 = i * 3
      const p4 = i * 4
      _cbPos[0] = frame.positions[p3]!
      _cbPos[1] = frame.positions[p3 + 1]!
      _cbPos[2] = frame.positions[p3 + 2]!
      _cbQuat[0] = frame.quats[p4]!
      _cbQuat[1] = frame.quats[p4 + 1]!
      _cbQuat[2] = frame.quats[p4 + 2]!
      _cbQuat[3] = frame.quats[p4 + 3]!
      _cbHalf[0] = frame.halfExtents[p3]!
      _cbHalf[1] = frame.halfExtents[p3 + 1]!
      _cbHalf[2] = frame.halfExtents[p3 + 2]!
      const t = rayObb(_ccO, _ccD, _cbPos, _cbQuat, _cbHalf)
      if (t !== null && t <= range) return true
    }
  }
  return false
}
