// Edge snapping for findSnap (snapFeatures.ts): end-to-end chains of linear parts, seats along a deck edge,
// edge mounts facing into a deck, and edge-to-edge tiles.

import { SNAP_HEIGHT_COST_WEIGHT, SNAP_HEIGHT_TOLERANCE, SNAP_ROTATION_COST_WEIGHT, SNAP_STAIRS_HEIGHT_PADDING, SNAP_VISIBLE_THRESHOLD, STAIRS_MIN_RISE } from '../types'
import type { PartInstance } from '../types'
import { forwardXZ, normalizeAngle } from '../math'
import { rotateXZ as rotXZ } from '../transforms'
import type { SnapChain, SnapEdgeMount, SnapSurface, SnapTile } from '../parts/partApi'
import { edgeMountContact } from './snapConnectors'
import { clampAlongEdge, clampToParamSpec, dirYaw, flushOnEdges, nearerYaw, nearestRectEdge, numParamOf, rectMoverFaces, rectWorldEdges } from './snapShared'
import type { SnapCandidate, SnapPose } from './snapFeatures'

// --- end-to-end chaining of a linear part (SDK barriers) ------------------

/**
 * End-to-end chain snap (docs/part-snap-chain.md): the barrier family, open to any part that declares `chain`.
 * A linear part (extent along local +X, half = length/2) dropped near a same-group chain part either extends
 * collinearly off the nearer end (facings roughly parallel) or forms a 90-degree L-corner (perpendicular). At an
 * L-corner the two parts share one post: the mover omits its mating post and the target un-omits the shared end
 * (via the declared `omit*Param` booleans), so the corner post draws once. Group-gated (guard rails chain only
 * with guard rails; the fence family shares a group); the mover's `reach` sets the engage distance.
 */
export function snapChain(moving: PartInstance, proposed: SnapPose, target: PartInstance, mine: SnapChain, theirs: SnapChain): SnapCandidate | null {
  if (mine.group !== theirs.group) return null
  const mLen = numParamOf(moving, mine.lengthParam)
  const tLen = numParamOf(target, theirs.lengthParam)
  if (mLen === null || tLen === null) return null
  const vis = mine.reach
  const [tx, ty, tz] = target.position
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > SNAP_HEIGHT_TOLERANCE) return null
  const [px, , pz] = proposed.position
  const tF = forwardXZ(target.rotationY)
  const tHalf = tLen / 2
  const mHalf = mLen / 2
  const fm = forwardXZ(proposed.rotationY)

  // the mover's omit-post overrides (only when it names the params); the target un-omits its shared end
  const movingOmit = (start: boolean, end: boolean): Record<string, boolean> | undefined => {
    const o: Record<string, boolean> = {}
    if (mine.omitStartParam) o[mine.omitStartParam] = start
    if (mine.omitEndParam) o[mine.omitEndParam] = end
    return Object.keys(o).length > 0 ? o : undefined
  }
  const targetUnomit = (end: 'start' | 'end'): Record<string, boolean> | undefined => {
    const name = end === 'end' ? theirs.omitEndParam : theirs.omitStartParam
    return name ? { [name]: false } : undefined
  }

  if (Math.abs(fm.x * tF.x + fm.z * tF.z) >= 0.5) {
    // collinear extension off the nearer end
    const d = tHalf + mHalf
    const cands = [
      { x: tx + tF.x * d, z: tz + tF.z * d, plus: true },
      { x: tx - tF.x * d, z: tz - tF.z * d, plus: false },
    ]
    const c =
      Math.hypot(px - cands[0]!.x, pz - cands[0]!.z) <= Math.hypot(px - cands[1]!.x, pz - cands[1]!.z)
        ? cands[0]!
        : cands[1]!
    const move = Math.hypot(px - c.x, pz - c.z)
    if (move > vis) return null
    const sign = c.plus ? 1 : -1
    const overrides = movingOmit(false, false)
    return {
      pose: {
        position: [c.x, ty, c.z],
        rotationY: nearerYaw(proposed.rotationY, target.rotationY, target.rotationY + Math.PI),
      },
      targetId: target.id,
      cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
      junction: { x: tx + sign * tF.x * tHalf, y: ty, z: tz + sign * tF.z * tHalf },
      ...(overrides ? { paramOverrides: overrides } : {}),
    }
  }

  // L-corner: moving end meets target end at 90 degrees
  let cx = -tF.z
  let cz = tF.x
  if (fm.x * cx + fm.z * cz < 0) {
    cx = -cx
    cz = -cz
  }
  const cornerYaw = normalizeAngle(dirYaw(cx, cz))
  const tEnds = [
    { x: tx + tF.x * tHalf, z: tz + tF.z * tHalf, plus: true },
    { x: tx - tF.x * tHalf, z: tz - tF.z * tHalf, plus: false },
  ]
  let bestX = px
  let bestZ = pz
  let bestEnd = tEnds[0]!
  let movingPlusEnd = true
  let bestD = Infinity
  for (const te of tEnds) {
    for (const mSign of [1, -1] as const) {
      const x = te.x - mSign * cx * mHalf
      const z = te.z - mSign * cz * mHalf
      const d = (px - x) ** 2 + (pz - z) ** 2
      if (d < bestD) {
        bestD = d
        bestX = x
        bestZ = z
        bestEnd = te
        movingPlusEnd = mSign === 1
      }
    }
  }
  const move = Math.hypot(px - bestX, pz - bestZ)
  if (move > vis) return null
  const overrides = movingOmit(!movingPlusEnd, movingPlusEnd)
  const targetOverrides = targetUnomit(bestEnd.plus ? 'end' : 'start')
  return {
    pose: { position: [bestX, ty, bestZ], rotationY: cornerYaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: bestEnd.x, y: ty, z: bestEnd.z },
    ...(overrides ? { paramOverrides: overrides } : {}),
    ...(targetOverrides ? { targetParamOverrides: targetOverrides } : {}),
  }
}

// --- seat along a host deck edge (SDK barriers onto a platform rim) -------

/**
 * Seat along a host deck edge (docs/part-snap-edge-mount.md), open to any part that declares `edgeMount`. The host advertises a rectangular deck as a {@link SnapSurface} of the kind this
 * part's `edgeMount.accepts` names; the part sits flush on the nearest deck edge, sliding along it (clamped by
 * its `alongParam` half-extent), local +X along the edge and +Z outward, pushed out by `outwardOffset` (a guard
 * rail's half-post). Decks are coplanar (y := target y). The mates table hands it each host surface of the
 * accepted kind, so a barrier's edge-mount is inert against everything but a deck.
 */
export function snapEdgeMount(moving: PartInstance, proposed: SnapPose, target: PartInstance, em: SnapEdgeMount, deck: SnapSurface): SnapCandidate | null {
  const dLen = numParamOf(target, deck.lengthParam)
  const dWid = numParamOf(target, deck.widthParam)
  const along = numParamOf(moving, em.alongParam)
  if (dLen === null || dWid === null || along === null) return null
  const ty = target.position[1]
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > SNAP_HEIGHT_TOLERANCE) return null
  const [px, , pz] = proposed.position
  const edges = rectWorldEdges(target, dLen / 2, dWid / 2)
  const { edge, cx, cz } = nearestRectEdge(edges, px, pz)
  const contact = clampAlongEdge(edge, cx, cz, along / 2)
  // yaw such that local +Z = outward, so local +X runs along the edge
  const yaw = normalizeAngle(Math.atan2(edge.outX, edge.outZ))
  const off = em.outwardOffset ?? 0
  const x = contact.x + edge.outX * off
  const z = contact.z + edge.outZ * off
  const move = Math.hypot(x - px, z - pz)
  if (move > em.reach) return null
  return {
    pose: { position: [x, ty, z], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: contact.x, y: ty, z: contact.z },
  }
}

// --- an edge mount facing into the deck (a flight, ramp or ladder climbing onto a platform) --------

/**
 * Seat a part facing into a host deck: its local +X points inward, its {@link SnapEdgeMount.at} contact is placed on
 * the nearest deck edge (sliding along it, clamped by half its `alongParam` width), and its width runs along the
 * edge. The generalization of the stairs-to-platform snap (docs/part-snap-stairs.md): what makes it a stair is
 * declared, so a ramp or a ladder is the same connector.
 *
 * With {@link SnapEdgeMount.fromFloor} the part stands on the deck's floor (deck top less its `heightParam`) and
 * the named param is fitted so the contact reaches the deck top: `round((rise − base) / perUnit)`, the rise per
 * unit being the scale of that param's axis-1 `atParams` entry, clamped to the param's range. A fixed rise per unit
 * meets the deck only within half a unit; the connection's `lift` absorbs the residual (structureCuts.ts). The
 * deck must carry a `heightParam` for that. Without `fromFloor` the contact sits at the deck height.
 *
 * Returns null when the deck lacks what the mount needs, a param is missing, or the drop is out of reach.
 */
export function snapEdgeMountInto(moving: PartInstance, proposed: SnapPose, target: PartInstance, em: SnapEdgeMount, deck: SnapSurface): SnapCandidate | null {
  const dLen = numParamOf(target, deck.lengthParam)
  const dWid = numParamOf(target, deck.widthParam)
  const width = numParamOf(moving, em.alongParam)
  if (dLen === null || dWid === null || width === null) return null
  const deckTop = target.position[1] // the platform's origin sits at its deck top
  const params = { ...(moving.params as Record<string, unknown>) }
  let fitted: { param: string; value: number } | null = null
  let baseY = deckTop - edgeMountContact(em, params)[1] // no floor fit: the contact sits at the deck height
  let heightTol = SNAP_HEIGHT_TOLERANCE
  if (em.fromFloor) {
    const dHeight = deck.heightParam ? numParamOf(target, deck.heightParam) : null
    if (dHeight === null || dHeight <= 0) return null
    const unit = em.atParams?.find((r) => r.axis === 1 && r.param === em.fromFloor!.param)
    const perUnit = unit?.scale
    if (!unit || !perUnit || perUnit <= 0) return null
    // the rise the fit must cover: at least STAIRS_MIN_RISE, less what the contact already stands at unfitted
    const targetRise = Math.max(STAIRS_MIN_RISE, dHeight)
    const base = edgeMountContact(em, { ...params, [em.fromFloor.param]: 0 })[1]
    const value = clampToParamSpec(moving, em.fromFloor.param, Math.max(1, Math.round((targetRise - base) / perUnit)))
    params[em.fromFloor.param] = value
    fitted = { param: em.fromFloor.param, value }
    baseY = deckTop - dHeight
    // live-snap gate: a padded tolerance so a part resized to a tall deck still engages from its foot
    heightTol = Math.max(SNAP_HEIGHT_TOLERANCE, targetRise * 0.5 + SNAP_STAIRS_HEIGHT_PADDING)
  }
  const at = edgeMountContact(em, params)

  const [px, , pz] = proposed.position
  const edges = rectWorldEdges(target, dLen / 2, dWid / 2)
  const { edge, cx, cz } = nearestRectEdge(edges, px, pz)
  const contact = clampAlongEdge(edge, cx, cz, width / 2)
  // up-slope direction = into the deck (−outward). The part's local +X points this way (rotXZ(1,0,yaw)=dir), so
  // its origin sits the contact's local offset back from the contact.
  const dirX = -edge.outX
  const dirZ = -edge.outZ
  const yaw = dirYaw(dirX, dirZ)
  const back = rotXZ(at[0], at[2], yaw)
  const originX = contact.x - back.x
  const originZ = contact.z - back.z
  const originY = baseY

  const move = Math.hypot(originX - px, originZ - pz)
  if (move > em.reach) return null
  const dy = Math.abs(proposed.position[1] - originY)
  if (dy > heightTol) return null

  const current = fitted ? numParamOf(moving, fitted.param) : null
  return {
    pose: { position: [originX, originY, originZ], rotationY: yaw },
    targetId: target.id,
    cost: move + SNAP_HEIGHT_COST_WEIGHT * dy,
    junction: { x: contact.x, y: deckTop, z: contact.z },
    ...(fitted && current !== fitted.value ? { paramOverrides: { [fitted.param]: fitted.value } } : {}),
  }
}

// --- edge-to-edge structural snapping (SDK floor markings / decks) --------

/**
 * Edge-to-edge structural snap (docs/part-snap-edges.md), open to any part that declares `tile`. The moving part's rectangle meets the target's edge flush through {@link flushOnEdges}: orientation in
 * 90-degree steps of the target yaw, sliding along the edge; a `cornerFlush` part also aligns shared corners.
 * Both parts must declare `tile` in the same group (a floor marking snaps only to floor markings). The
 * rectangle half-extents come from each part's named length/width params (so a resized instance matches),
 * mirroring the built-in's `params.length/width`. Decks end up coplanar (y := target y).
 */
export function snapTile(moving: PartInstance, proposed: SnapPose, target: PartInstance, mine: SnapTile, theirs: SnapTile): SnapCandidate | null {
  if (mine.group !== theirs.group) return null
  const mLen = numParamOf(moving, mine.lengthParam)
  const mWid = numParamOf(moving, mine.widthParam)
  const tLen = numParamOf(target, theirs.lengthParam)
  const tWid = numParamOf(target, theirs.widthParam)
  if (mLen === null || mWid === null || tLen === null || tWid === null) return null
  const ty = target.position[1]
  const dy = Math.abs(proposed.position[1] - ty)
  if (dy > SNAP_HEIGHT_TOLERANCE) return null
  const edges = rectWorldEdges(target, tLen / 2, tWid / 2)
  const best = flushOnEdges(proposed, target.rotationY, edges, rectMoverFaces(0, mLen / 2, mWid / 2), SNAP_VISIBLE_THRESHOLD, mine.cornerFlush ?? false)
  if (best === null) return null
  return {
    pose: { position: [best.x, ty, best.z], rotationY: normalizeAngle(best.yaw) },
    targetId: target.id,
    cost: best.move + SNAP_HEIGHT_COST_WEIGHT * dy + SNAP_ROTATION_COST_WEIGHT * best.rot,
    junction: { x: best.jx, y: ty, z: best.jz },
  }
}
