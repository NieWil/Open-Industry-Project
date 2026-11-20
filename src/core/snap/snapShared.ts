// Geometry and param helpers the snap solvers (snapFeatures.ts) share: yaw and segment maths, a rectangle's
// world edges, a posed copy of a part, footprint overlap, and clamping a param to its spec.

import { SNAP_ROTATION_COST_WEIGHT } from '../types'
import type { PartInstance } from '../types'
import { angleDiff, clamp, normalizeAngle } from '../math'
import { rotateXZ as rotXZ } from '../transforms'
import type { SnapSpec } from '../parts/partApi'
import { partFootprint, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { getPackage } from '../parts/partRegistry'
import type { SnapPose } from './snapFeatures'

export const EPS = 1e-7
/** yaw whose forwardXZ points along (x, z) */
export function dirYaw(x: number, z: number): number {
  return Math.atan2(-z, x)
}

export function closestOnSegXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { x: number; z: number } {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  if (len2 < 1e-12) return { x: ax, z: az }
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1)
  return { x: ax + t * dx, z: az + t * dz }
}

export function nearerYaw(proposed: number, a: number, b: number): number {
  const da = Math.abs(angleDiff(a, proposed))
  const db = Math.abs(angleDiff(b, proposed))
  return normalizeAngle(da <= db ? a : b)
}

export interface WorldEdge {
  ax: number
  az: number
  bx: number
  bz: number
  /** outward unit normal (world XZ), pointing away from the part */
  outX: number
  outZ: number
}

/** the four top-face edges of an axis-aligned rect part (half-extents hl in X, hw in Z), world XZ */
export function rectWorldEdges(part: PartInstance, hl: number, hw: number): WorldEdge[] {
  const local = [
    { a: { x: hl, z: -hw }, b: { x: hl, z: hw }, out: { x: 1, z: 0 } },
    { a: { x: -hl, z: hw }, b: { x: -hl, z: -hw }, out: { x: -1, z: 0 } },
    { a: { x: -hl, z: hw }, b: { x: hl, z: hw }, out: { x: 0, z: 1 } },
    { a: { x: hl, z: -hw }, b: { x: -hl, z: -hw }, out: { x: 0, z: -1 } },
  ]
  return local.map((e) => {
    const a = toWorldXZ(part, e.a.x, e.a.z)
    const b = toWorldXZ(part, e.b.x, e.b.z)
    const o = rotXZ(e.out.x, e.out.z, part.rotationY)
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, outX: o.x, outZ: o.z }
  })
}

/** nearest rect edge to (px, pz) plus the closest point on it */
export function nearestRectEdge(edges: WorldEdge[], px: number, pz: number): { edge: WorldEdge; cx: number; cz: number } {
  let edge = edges[0]!
  let cx = px
  let cz = pz
  let best = Infinity
  for (const e of edges) {
    const c = closestOnSegXZ(px, pz, e.ax, e.az, e.bx, e.bz)
    const d = Math.hypot(px - c.x, pz - c.z)
    if (d < best) {
      best = d
      edge = e
      cx = c.x
      cz = c.z
    }
  }
  return { edge, cx, cz }
}

/** slide a contact point along an edge so a part of half-extent `half` stays within it; a part too wide to fit
 *  centres on the edge instead (it overhangs either way, so evenly rather than all off one end) */
export function clampAlongEdge(edge: WorldEdge, cx: number, cz: number, half: number): { x: number; z: number } {
  const ex = edge.bx - edge.ax
  const ez = edge.bz - edge.az
  const len = Math.hypot(ex, ez)
  if (len < 0.01) return { x: cx, z: cz }
  const dirx = ex / len
  const dirz = ez / len
  // A mover wider than the edge has an empty slide range (half > len − half). Clamping to `half` would pin its
  // centre on the far corner and hang the whole part off that end: a 2 m stair on a 1 m deck edge seats flush to
  // the corner, a 6 m rail on a 2 m edge overhangs it entirely. Centre it instead; at 2·half == len both
  // branches agree, so the ordinary slide is untouched.
  const t = 2 * half >= len ? len / 2 : clamp((cx - edge.ax) * dirx + (cz - edge.az) * dirz, half, len - half)
  return { x: edge.ax + dirx * t, z: edge.az + dirz * t }
}

export function posedClone(moving: PartInstance, proposed: SnapPose): PartInstance {
  return {
    ...moving,
    position: [proposed.position[0], proposed.position[1], proposed.position[2]],
    rotationY: proposed.rotationY,
  }
}

/** a host's declared snap block, where its declared sockets live (undefined for a non-part or no block) */
export function snapOf(part: PartInstance): SnapSpec | undefined {
  return part.type === 'part' ? getPackage(part.packageId)?.snap : undefined
}

/** body-overlap test: do the two footprint boxes overlap in XZ? */
export function bodyOverlapsXZ(moving: PartInstance, proposed: SnapPose, target: PartInstance): boolean {
  const m = posedClone(moving, proposed)
  const fm = partFootprint(m)
  const ft = partFootprint(target)
  const fmcx = fm.cx ?? 0
  const fmcz = fm.cz ?? 0
  const ftcx = ft.cx ?? 0
  const ftcz = ft.cz ?? 0
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const corners: [number, number][] = [
    [fmcx - fm.hx, fmcz - fm.hz],
    [fmcx + fm.hx, fmcz - fm.hz],
    [fmcx - fm.hx, fmcz + fm.hz],
    [fmcx + fm.hx, fmcz + fm.hz],
  ]
  for (const [sx, sz] of corners) {
    const w = toWorldXZ(m, sx, sz)
    const l = toLocalXZ(target, w.x, w.z)
    minX = Math.min(minX, l.x)
    maxX = Math.max(maxX, l.x)
    minZ = Math.min(minZ, l.z)
    maxZ = Math.max(maxZ, l.z)
  }
  return minX < ftcx + ft.hx && maxX > ftcx - ft.hx && minZ < ftcz + ft.hz && maxZ > ftcz - ft.hz
}

/** a part's numeric instance param by name (null when missing/non-numeric) */
export function numParamOf(part: PartInstance, name: string): number | null {
  const v = (part.params as Record<string, unknown>)[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** a custom part's declared numeric range for a param (±Infinity where unbounded / not a number param) */
export function paramRange(moving: PartInstance, param: string): { lo: number; hi: number } {
  const spec = moving.type === 'part' ? getPackage(moving.packageId)?.params?.[param] : undefined
  return {
    lo: spec?.type === 'number' && typeof spec.min === 'number' ? spec.min : -Infinity,
    hi: spec?.type === 'number' && typeof spec.max === 'number' ? spec.max : Infinity,
  }
}

/** clamp an auto-fit value to a custom part's declared param range (the SDK twin of the built-ins'
 *  PART_DEFS clamp) - an unbounded/non-number spec passes the value through */
export function clampToParamSpec(moving: PartInstance, param: string, value: number): number {
  const { lo, hi } = paramRange(moving, param)
  return clamp(value, lo, hi)
}

/** one of the mover's four face midlines, in its own local frame: the centre `c`, outward `out`, and the half-extent
 *  of the face along itself (what the corner-flush spots inset by) */
interface MoverFace {
  c: { x: number; z: number }
  out: { x: number; z: number }
  alongHalf: number
}

/** a rectangle's four face midlines, (+X, −X, +Z, −Z), centred at local (cx, cz) */
export function rectMoverFaces(cx: number, hx: number, hz: number, cz = 0): MoverFace[] {
  return [
    { c: { x: cx + hx, z: cz }, out: { x: 1, z: 0 }, alongHalf: hz },
    { c: { x: cx - hx, z: cz }, out: { x: -1, z: 0 }, alongHalf: hz },
    { c: { x: cx, z: cz + hz }, out: { x: 0, z: 1 }, alongHalf: hx },
    { c: { x: cx, z: cz - hz }, out: { x: 0, z: -1 }, alongHalf: hx },
  ]
}

/**
 * The flush solver shared by `tile` (a same-group rectangle, {@link snapTile}) and ambient `flush` (any part's
 * footprint faces, {@link snapFaceFlush}): a mover rectangle is placed flush against one of the target's edges.
 * For every (target edge, mover face) pair: orientation in 90-degree steps of the target yaw (the mover face whose
 * outward is anti-parallel to the edge's is chosen), then the centre slid along the edge, plus - with `corners` -
 * the two corner-flush spots (a shared corner aligns; the tiling gesture). Each spot is gated on its own move
 * before ranking by move + rotation. `cost` blends move with rotation, so a rotation-free candidate just past the
 * threshold can out-rank a nearer one that needs a turn. Gating after ranking would then reject the whole snap
 * instead of falling back to the candidate in range. Measured on two shipped 2x8 floor markings: without the
 * filter, a drop at (-4.25, -7.5) returns nothing although a candidate sits 2.80 m away, inside the 3 m gate,
 * because the best-ranked one is 3.29 m out.
 */
export function flushOnEdges(
  proposed: SnapPose,
  targetYaw: number,
  edges: readonly WorldEdge[],
  faces: readonly MoverFace[],
  threshold: number,
  corners: boolean,
): { x: number; z: number; yaw: number; rot: number; move: number; jx: number; jz: number } | null {
  const [px, , pz] = proposed.position
  let best: { x: number; z: number; yaw: number; rot: number; move: number; jx: number; jz: number } | null = null
  let bestCost = Infinity
  for (const te of edges) {
    const ex = te.bx - te.ax
    const ez = te.bz - te.az
    const eLen = Math.hypot(ex, ez)
    const dir = eLen > 1e-4 ? { x: ex / eLen, z: ez / eLen } : { x: 1, z: 0 }
    for (const me of faces) {
      // orientation candidates: target yaw + k·90°; the mover face outward anti-parallel to the target face is chosen
      let yaw = targetYaw
      let bestDot = -Infinity
      for (let k = 0; k < 4; k++) {
        const cand = targetYaw + (k * Math.PI) / 2
        const o = rotXZ(me.out.x, me.out.z, cand)
        const d = -(o.x * te.outX + o.z * te.outZ)
        if (d > bestDot) {
          bestDot = d
          yaw = cand
        }
      }
      const rc = rotXZ(me.c.x, me.c.z, yaw)
      // centre-clamp slides; the corner-flush spots align shared corners (a mover overhanging a smaller target)
      const spots = [closestOnSegXZ(px + rc.x, pz + rc.z, te.ax, te.az, te.bx, te.bz)]
      if (corners && eLen > 1e-4) {
        spots.push({ x: te.ax + dir.x * me.alongHalf, z: te.az + dir.z * me.alongHalf })
        spots.push({ x: te.bx - dir.x * me.alongHalf, z: te.bz - dir.z * me.alongHalf })
      }
      const rot = Math.abs(angleDiff(yaw, proposed.rotationY))
      for (const sp of spots) {
        const x = sp.x - rc.x
        const z = sp.z - rc.z
        const move = Math.hypot(x - px, z - pz)
        if (move > threshold) continue
        const cost = move + SNAP_ROTATION_COST_WEIGHT * rot
        if (cost < bestCost) {
          bestCost = cost
          best = { x, z, yaw, rot, move, jx: sp.x, jz: sp.z }
        }
      }
    }
  }
  return best
}
