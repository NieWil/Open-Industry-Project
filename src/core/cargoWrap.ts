// Stretch film on a unitised load: which bodies make up the load standing on a pallet, and the box the film
// draws around them. One pure function, shared by the sim (a wrapper's ctx.wrap, and a pallet authored as
// already wrapped when the run starts) and the idle cargo frame (the same authored pallet before Run), so the
// film a load shows stopped is the film it keeps once physics owns it.
//
// The film is an open-ended box in the anchor's frame (the pallet the load stands on). It rides that body: the
// renderer places it off the anchor's pose every frame, so a wrapped load carries its film down a lane, onto a
// truck's forks and into a rack.

import { qApply, qConjugate, qMul } from './rig/rigPose'
import type { Quat, Vec3 } from './rig/rigPose'

/** one cargo body as the wrap sees it: world centre, orientation, half extents */
export interface WrapBody {
  pos: Vec3
  quat: Quat
  half: Vec3
}

/** the film box in the anchor's local frame */
export interface FilmBox {
  min: Vec3
  max: Vec3
}

/** a body belongs to the load when its centre is over the anchor's footprint, give or take this much (m). Small,
 *  so the case beside it on a lane or in the next rack bay (whose centre is half a case past the edge) never joins */
const FOOTPRINT_SLACK = 0.05
/** ...and when it rests on the anchor or on something already in the load: its underside within this of that top */
const REST_GAP = 0.03
/** how far the film stands off the load it wraps, so it never z-fights the cases */
const FILM_STANDOFF = 0.006

/**
 * The load standing on `bodies[anchor]` and the film box around it, or null when nothing stands on it (film on a
 * bare pallet is not a wrapped load). Members are gathered bottom-up: a body joins when its centre is over the
 * anchor's footprint and its underside rests on the anchor's top or on a body already in the load, so a load on
 * the next rack level up, with daylight between, stays out.
 *
 * A pallet anchor's film starts at the pallet's mid-height, the way film is run down over the top deck boards;
 * any other anchor's starts at its underside.
 */
export function wrapLoad(anchor: number, bodies: readonly WrapBody[], anchorIsPallet: boolean): { members: number[]; box: FilmBox } | null {
  const a = bodies[anchor]
  if (!a) return null
  const inv = qConjugate(a.quat)
  const cands: { i: number; min: Vec3; max: Vec3 }[] = []
  for (let i = 0; i < bodies.length; i++) {
    if (i === anchor) continue
    const b = bodies[i]!
    const c = qApply(inv, [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]])
    if (c[1] <= 0) continue
    if (Math.abs(c[0]) > a.half[0] + FOOTPRINT_SLACK || Math.abs(c[2]) > a.half[2] + FOOTPRINT_SLACK) continue
    // the body's box in the anchor's frame: its three half-axes, rotated, summed per axis
    const rel = qMul(inv, b.quat)
    const ex = qApply(rel, [b.half[0], 0, 0])
    const ey = qApply(rel, [0, b.half[1], 0])
    const ez = qApply(rel, [0, 0, b.half[2]])
    const h: Vec3 = [
      Math.abs(ex[0]) + Math.abs(ey[0]) + Math.abs(ez[0]),
      Math.abs(ex[1]) + Math.abs(ey[1]) + Math.abs(ez[1]),
      Math.abs(ex[2]) + Math.abs(ey[2]) + Math.abs(ez[2]),
    ]
    cands.push({ i, min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]], max: [c[0] + h[0], c[1] + h[1], c[2] + h[2]] })
  }
  cands.sort((p, q) => p.min[1] - q.min[1] || p.i - q.i)
  const min: Vec3 = [-a.half[0], anchorIsPallet ? 0 : -a.half[1], -a.half[2]]
  const max: Vec3 = [a.half[0], a.half[1], a.half[2]]
  let top = a.half[1]
  const members: number[] = []
  for (const c of cands) {
    if (c.min[1] > top + REST_GAP) break // daylight: everything above belongs to something else
    members.push(c.i)
    top = Math.max(top, c.max[1])
    for (const k of [0, 2] as const) {
      min[k] = Math.min(min[k], c.min[k])
      max[k] = Math.max(max[k], c.max[k])
    }
  }
  if (members.length === 0) return null
  max[1] = top
  return {
    members,
    box: {
      min: [min[0] - FILM_STANDOFF, min[1], min[2] - FILM_STANDOFF],
      max: [max[0] + FILM_STANDOFF, max[1] + FILM_STANDOFF, max[2] + FILM_STANDOFF],
    },
  }
}

/**
 * The film box round the load made of exactly `members` standing on `bodies[anchor]` (an authored unit load's
 * children): the same box {@link wrapLoad} would draw, but over the pieces the author named rather than whatever
 * happens to rest there. Always a box, even for a bare anchor (then the anchor's own).
 */
export function fitLoad(anchor: number, members: readonly number[], bodies: readonly WrapBody[], anchorIsPallet: boolean): FilmBox {
  const a = bodies[anchor]!
  const inv = qConjugate(a.quat)
  const min: Vec3 = [-a.half[0], anchorIsPallet ? 0 : -a.half[1], -a.half[2]]
  const max: Vec3 = [a.half[0], a.half[1], a.half[2]]
  for (const i of members) {
    if (i === anchor) continue
    const b = bodies[i]
    if (!b) continue
    const c = qApply(inv, [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]])
    const rel = qMul(inv, b.quat)
    const ex = qApply(rel, [b.half[0], 0, 0])
    const ey = qApply(rel, [0, b.half[1], 0])
    const ez = qApply(rel, [0, 0, b.half[2]])
    for (let k = 0; k < 3; k++) {
      const h = Math.abs(ex[k]!) + Math.abs(ey[k]!) + Math.abs(ez[k]!)
      min[k] = Math.min(min[k]!, c[k]! - h)
      max[k] = Math.max(max[k]!, c[k]! + h)
    }
  }
  return {
    min: [min[0] - FILM_STANDOFF, min[1], min[2] - FILM_STANDOFF],
    max: [max[0] + FILM_STANDOFF, max[1] + FILM_STANDOFF, max[2] + FILM_STANDOFF],
  }
}

/**
 * Which body a wrap anchors to, of the ones a wrapper's zone holds: the lowest pallet, else the lowest body.
 * `lowest` compares centre heights. -1 when the list is empty.
 */
export function wrapAnchor(candidates: readonly { index: number; y: number; pallet: boolean }[]): number {
  let best = -1
  let bestY = Infinity
  let bestPallet = false
  for (const c of candidates) {
    const better = c.pallet !== bestPallet ? c.pallet : c.y < bestY
    if (best < 0 || better) {
      best = c.index
      bestY = c.y
      bestPallet = c.pallet
    }
  }
  return best
}

/**
 * Where the film web leaves the load: the corner of the film box (in plan, anchor-local x/z) that a line from the roll
 * at `roll` touches on the side trailing the roll's travel (`travel`, its direction of motion). A web runs from the
 * roll back to the last corner it wrapped round, so of the two corners tangent to the roll, it is the one behind it.
 */
export function webCorner(box: FilmBox, roll: readonly [number, number], travel: readonly [number, number]): [number, number] {
  const cx = (box.min[0] + box.max[0]) / 2
  const cz = (box.min[2] + box.max[2]) / 2
  // toward the load's centre, and which way round from it counts as "behind" the roll
  const ox = cx - roll[0]
  const oz = cz - roll[1]
  const behind = Math.sign(ox * -travel[1] - oz * -travel[0]) || 1
  let best: [number, number] = [box.min[0], box.min[2]]
  let bestAngle = -Infinity
  for (const x of [box.min[0], box.max[0]]) {
    for (const z of [box.min[2], box.max[2]]) {
      const dx = x - roll[0]
      const dz = z - roll[1]
      const angle = behind * Math.atan2(ox * dz - oz * dx, ox * dx + oz * dz)
      if (angle > bestAngle) {
        bestAngle = angle
        best = [x, z]
      }
    }
  }
  return best
}
