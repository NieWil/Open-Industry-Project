// Conveyor snapping for findSnap (snapFeatures.ts): end to end, onto a straight conveyor's flank, and the ends of
// a curve.

import { SNAP_CONVEYOR_END_MAX_TURN, SNAP_CONVEYOR_FLANK_MAX_TURN, SNAP_CONVEYOR_RELEASE, SNAP_CONVEYOR_TURN_COST, SNAP_CONVEYOR_VISIBLE_THRESHOLD, SNAP_HEIGHT_COST_WEIGHT } from '../types'
import type { PartInstance } from '../types'
import { conveyorSpeedOf, isConveyorReversed, conveyorSpeedParams } from '../conveyor/conveyorDirection'
import { angleDiff, clamp, normalizeAngle } from '../math'
import { rotateXZ as rotXZ } from '../transforms'
import type { LocalEnd } from '../parts/partGeometry'
import { bedOf, bedView, conveyorEndsOf, conveyorLocalEnds, isConveyorLike, partFootprint, resolveInclineRad, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { dirYaw, EPS, posedClone } from './snapShared'
import type { SnapCandidate, SnapPose } from './snapFeatures'

// --- conveyors ---------------------------------------------------------

/**
 * Conveyor to conveyor. Every join the mover could make is solved (each of its ends onto each end of the target
 * and, on a straight target, onto each flank: a side merge) and the cheapest one that engages is chosen. There is
 * no up-front "end or side?" mode: choosing one from the mover's origin and axis would send a merge-angled spur to
 * the target's far end and leave dead zones where the other mode is never tried.
 *
 * A join engages when the mover's mating end moves at most SNAP_CONVEYOR_VISIBLE_THRESHOLD (SNAP_CONVEYOR_RELEASE
 * while `holdJoin` names a held join) and turns at most a quarter turn onto an end or 45° onto a flank. Measured at
 * the mating end, never the nearest end or origin: a conveyor dropped on an equal one has an end at each target end,
 * yet mating either moves the body its own length (a body-overlap gate would let that through as a 4 m jump). An end
 * starting inside the target's footprint may also move as far as it is deep ({@link engages}): out through the
 * nearest edge, never along the bed. Cost = that move + SNAP_CONVEYOR_TURN_COST per radian (+ the height weight).
 * A curve on either side pairs its ends by its own rule ({@link snapCurved}), under the same engage rule.
 */
export function snapConveyor(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  holdJoin?: string,
): SnapCandidate | null {
  if (!isConveyorLike(target)) return null
  const reach = holdJoin !== undefined ? SNAP_CONVEYOR_RELEASE : SNAP_CONVEYOR_VISIBLE_THRESHOLD
  if (isCurvedPart(moving) || isCurvedPart(target)) return snapCurved(moving, proposed, target, reach, holdJoin)
  let best: SnapCandidate | null = null
  const consider = (m: ConveyorMate | null, maxTurn: number): void => {
    if (m === null || (holdJoin !== undefined && m.cand.join !== holdJoin) || !engages(m, reach, maxTurn)) return
    if (best === null || m.cand.cost < best.cost - 1e-9) best = m.cand
  }
  const localEnds = conveyorLocalEnds(moving)
  for (const t of conveyorEndsOf(target)) {
    for (const e of localEnds) {
      consider(conveyorMate(proposed, target, e, t.outX, t.outZ, t.x, t.z, t.y, `${e.end} -> end:${t.end}`), SNAP_CONVEYOR_END_MAX_TURN)
    }
  }
  // Beds with straight ends and side guards merge onto a flank (the bed's sideMerge): straights, spurs, belts, and
  // the turntable (whose snap features report straight ends + guards at the home orientation).
  const merge = bedOf(moving)?.sideMerge() ?? null
  if (merge) {
    // a spur merging onto a side keeps a flange clearance from the bed edge (the spur gap); its
    // frame/guard rails then extend back to the host wall via guardExtents. An SDK spur declares its own clearance on
    // the length face handle (`sideGap`, default = the belt spur's). A square T (a straight or a belt) stands its end
    // face on the host frame's outer wall face (`Flank.frameOut`). Butting it on the bed edge instead would put
    // everything reaching that face (above all a belt's end drum) up to a wall thickness inside the host's frame
    // wall. Its rails then end on that face as they are, and only their top flange steps back past the host's
    // (guardExtents.ts railCuts). A turntable mover still butts the edge (its plate is not a framed end).
    for (const f of straightFlanks(target)) {
      const gap = merge.gap ?? (merge.framedEnd ? f.frameOut : 0)
      for (const e of localEnds) consider(flankMate(proposed, target, e, f, gap), SNAP_CONVEYOR_FLANK_MAX_TURN)
    }
  }
  return best
}

/** one solved conveyor join, with what engaging it costs the mover */
interface ConveyorMate {
  cand: SnapCandidate
  /** XZ distance the mover's mating end travels to the join */
  move: number
  /** |yaw change|, radians */
  turn: number
  /**
   * How deep the mating end starts inside the target's footprint (0 outside): its distance to the nearest edge.
   * The engage distance grows by it ({@link engages}), so an end dropped into a bed is pushed out through its
   * nearest edge (a spur dropped onto a bed pops out to the flank) but never carried along the bed to a far end.
   */
  depth: number
}

/**
 * Does a solved join engage: its mating end moves at most `reach`, and it turns the mover at most `maxTurn`. An
 * end that starts inside the target is pushed out through its nearest edge, so the reach grows by its depth, but
 * only for a join that carries it out (a turn within 45°), never one that swings it round onto another socket.
 */
function engages(m: ConveyorMate, reach: number, maxTurn: number): boolean {
  if (m.turn > maxTurn + 1e-6) return false
  const slack = m.turn <= SNAP_CONVEYOR_FLANK_MAX_TURN + 1e-6 ? m.depth : 0
  return m.move <= reach + slack + EPS
}

/** mate end `e` onto the point (x, z) facing -(outX, outZ), and price it (see {@link snapConveyor}) */
function conveyorMate(
  proposed: SnapPose,
  target: PartInstance,
  e: LocalEnd,
  outX: number,
  outZ: number,
  x: number,
  z: number,
  y: number,
  join: string,
): ConveyorMate | null {
  const cand = endMateCandidate(proposed, target, e, outX, outZ, x, z, y)
  if (cand === null) return null
  const r = rotXZ(e.x, e.z, proposed.rotationY) // the end's world offset at the proposed pose (endMateCandidate's frame)
  const move = Math.hypot(proposed.position[0] + r.x - x, proposed.position[2] + r.z - z)
  const turn = Math.abs(angleDiff(cand.pose.rotationY, proposed.rotationY))
  const dy = Math.abs(proposed.position[1] - cand.pose.position[1])
  cand.cost = move + SNAP_CONVEYOR_TURN_COST * turn + SNAP_HEIGHT_COST_WEIGHT * dy
  cand.join = join
  return { cand, move, turn, depth: depthInTargetBox(target, proposed.position[0] + r.x, proposed.position[2] + r.z) }
}

/** one side-guard run of a straight target, in its local frame: x0..x1 along the bed at z, outward (world) */
interface Flank {
  side: 'left' | 'right'
  x0: number
  x1: number
  z: number
  outX: number
  outZ: number
  /** how far the bed's frame stands out past this flank (its outer wall face): where a square T's end is placed */
  frameOut: number
}

/**
 * The flanks a conveyor can side-merge onto (its bed's flanks): a straight's, a belt's, a turntable's.
 * A spur is not one: it is itself a merge, so it takes end joins only (checkLayout.ts warns). Nor is an
 * inclined bed: a side merge seats the mover flat at one height, but a tilted flank climbs along its length, so the
 * two surfaces would disagree across the whole mouth (16 cm over a 0.6 m mouth at 15 degrees). Elevation belongs
 * on straight runs joined end to end (docs/conveyor-incline.md); an inclined mover still merges onto a flat bed.
 */
function straightFlanks(target: PartInstance): Flank[] {
  const bed = bedOf(target)
  if (bed === null || bed.endJoinsOnly) return []
  const flanks = bed.flanks()
  if (flanks === null) return []
  if (resolveInclineRad(target) !== 0) return []
  const { x0, x1, hw, frameOut } = flanks
  const l = rotXZ(0, -1, target.rotationY)
  const r = rotXZ(0, 1, target.rotationY)
  return [
    { side: 'left', x0, x1, z: -hw, outX: l.x, outZ: l.z, frameOut },
    { side: 'right', x0, x1, z: hw, outX: r.x, outZ: r.z, frameOut },
  ]
}

/**
 * Side merge: end `e` is placed on the flank straight across from where it is now, body extending outward. An end
 * a little past either end of the run is placed on the corner; the clamp counts toward the move, so the engage
 * distance keeps it local (an end off the target's end face is far from any flank point, and meets that end instead).
 * `gap` is how far off the flank the end is placed (a spur's flange clearance, a square T's host wall thickness); the snap
 * cue stays on the flank itself.
 */
function flankMate(proposed: SnapPose, target: PartInstance, e: LocalEnd, f: Flank, gap: number): ConveyorMate | null {
  const r = rotXZ(e.x, e.z, proposed.rotationY)
  const l = toLocalXZ(target, proposed.position[0] + r.x, proposed.position[2] + r.z)
  const contact = toWorldXZ(target, clamp(l.x, f.x0, f.x1), f.z)
  const y = target.position[1]
  const m = conveyorMate(proposed, target, e, f.outX, f.outZ, contact.x + f.outX * gap, contact.z + f.outZ * gap, y, `${e.end} -> flank:${f.side}`)
  if (m && gap > 0) m.cand.junction = { x: contact.x, y, z: contact.z }
  return m
}

/** A curved conveyor - a built-in curved type or an SDK curved bed (a custom part with an `arc` handle), so an
 *  SDK curved conveyor routes through the curved free-end-stable snap the same way the built-in does. */
function isCurvedPart(part: PartInstance): boolean {
  return bedView(part, 'arc') !== null
}

/**
 * Output-end rule: a curve discharges at its exit (front) unless reversed - by a negative authored
 * speed or the snap's own `reverse` flag, which is why this reads the folded direction (conveyorDirection.ts)
 * rather than the raw param. A straight discharges at its front (reverse ignored).
 */
function isOutputEnd(part: PartInstance, end: 'front' | 'back'): boolean {
  if (isCurvedPart(part)) {
    return (end === 'front') !== conveyorSpeedOf(part) < 0
  }
  return end === 'front'
}

/**
 * Curved-conveyor snap (curved-snap transform + closest-free-end-pair search): among the (moving
 * end, target end) joins that engage, pick the one that moves the other (free) moving end the least - so
 * dragging by one end doesn't flip the curve. The quarter-turn limit of an end join applies as to any conveyor: a
 * curve fixes its flow by its reverse flag (below), never by swinging round. The per-type end stub already carries
 * the snap gap.
 * When the mated ends are flow-incompatible (both discharge or both feed the junction), the moving conveyor's
 * flow is reversed by toggling its hidden `reverse` flag.
 */
function snapCurved(
  moving: PartInstance,
  proposed: SnapPose,
  target: PartInstance,
  reach: number,
  holdJoin?: string,
): SnapCandidate | null {
  const localEnds = conveyorLocalEnds(moving)
  const targetEnds = conveyorEndsOf(target)
  const pairs = localEnds.length === 2 && targetEnds.length >= 2
  const sel = posedClone(moving, proposed)
  let best: SnapCandidate | null = null
  let bestFree = Infinity
  let bestRot = Infinity
  let bestReverse = false
  for (let i = 0; i < localEnds.length; i++) {
    const e = localEnds[i]!
    const freeLocal = pairs ? localEnds[1 - i]! : null
    const freeOld = freeLocal ? toWorldXZ(sel, freeLocal.x, freeLocal.z) : null
    for (const t of targetEnds) {
      const m = conveyorMate(proposed, target, e, t.outX, t.outZ, t.x, t.z, t.y, `${e.end} -> end:${t.end}`)
      if (m === null || !engages(m, reach, SNAP_CONVEYOR_END_MAX_TURN)) continue
      if (holdJoin !== undefined && m.cand.join !== holdJoin) continue
      // with no free end to keep still (a one-ended part), the nearest join is chosen
      let freeMove = m.move
      if (freeLocal && freeOld) {
        const freeNew = toWorldXZ(posedClone(moving, m.cand.pose), freeLocal.x, freeLocal.z)
        freeMove = Math.hypot(freeNew.x - freeOld.x, freeNew.z - freeOld.z)
      }
      if (freeMove < bestFree - 1e-9 || (freeMove <= bestFree + 1e-9 && m.turn < bestRot)) {
        bestFree = freeMove
        bestRot = m.turn
        best = m.cand
        bestReverse = isOutputEnd(moving, e.end) === isOutputEnd(target, t.end)
      }
    }
  }
  if (best === null) return null
  if (bestReverse) {
    // Toggle the hidden `reverse` flag, never the authored speed (a hidden,
    // engine-owned param). Negating `speed` here would rewrite the number the user typed in the
    // Inspector, and re-snapping would flip it back and forth under them. A toggle also composes: snapping an
    // already-reversed curve into another flow-incompatible mate restores its forward flow.
    const reverseKey = conveyorSpeedParams(moving).reverse // the conveyor's declared reverse flag (a curve's)
    if (reverseKey) best = { ...best, paramOverrides: { ...best.paramOverrides, [reverseKey]: !isConveyorReversed(moving) } }
  }
  return best
}

/**
 * How far a world point sits inside the target's footprint box: its distance to the nearest edge (0 outside). Always
 * 0 on a curved target, whose box is the arc's bounds: most of it is the empty inside of the bend, not bed.
 */
function depthInTargetBox(target: PartInstance, px: number, pz: number): number {
  if (isCurvedPart(target)) return 0
  const fp = partFootprint(target)
  const fcx = fp.cx ?? 0
  const fcz = fp.cz ?? 0
  const l = toLocalXZ(target, px, pz)
  return Math.max(0, Math.min(fcx + fp.hx - l.x, l.x - (fcx - fp.hx), fcz + fp.hz - l.z, l.z - (fcz - fp.hz)))
}

/**
 * Pose the moving part so end `e` sits at (cx, cz) with its outward equal to
 * -(outX, outZ). `targetEndY` is the mating point's world height; the origin is
 * dropped by the moving end's own surface offset so an inclined belt end meets
 * the target end at the right height (no-op for flat ends).
 */
function endMateCandidate(
  proposed: SnapPose,
  target: PartInstance,
  e: LocalEnd,
  outX: number,
  outZ: number,
  cx: number,
  cz: number,
  targetEndY: number,
): SnapCandidate | null {
  const yaw = normalizeAngle(dirYaw(-outX, -outZ) - dirYaw(e.outX, e.outZ))
  const r = rotXZ(e.x, e.z, yaw)
  const x = cx - r.x
  const z = cz - r.z
  const y = targetEndY - (e.y ?? 0)
  // the origin's move; a conveyor join re-prices it by its mating end's move (conveyorMate)
  const move = Math.hypot(x - proposed.position[0], z - proposed.position[2])
  const dy = Math.abs(proposed.position[1] - y)
  return {
    pose: { position: [x, y, z], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: cx, y: targetEndY, z: cz },
  }
}
