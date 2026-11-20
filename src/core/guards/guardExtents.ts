import { FRAME_FLANGE_WIDTH, FRAME_WALL_THICKNESS, GUARD_CONTACT_HEIGHT, GUARD_CONTACT_TOLERANCE } from '../types'
import type { PartInstance } from '../types'
import type { ParamValue } from '../parts/partApi'
import type { PartEnd } from '../parts/partGeometry'
import { bedOf, bedView, conveyorEndsOf, isConveyorLike, resolveInclineRad, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import type { BedMergeFaces } from '../conveyor/conveyorBeds'
import { getPackage } from '../parts/partRegistry'
import { beltXToSExt, buildBeltPath, sampleBeltPathExt } from '../conveyor/beltPath'
import { memoizeLocalized } from '../memoParts'

/**
 * Geometry-derived snap extents (plus the extents half of the side-snap geometry pass).
 *
 * The counterpart to guardOpenings.ts: where deriveGuardOpenings *opens* a straight host's guard where a
 * neighbour's end butts its side, this remaps the butting mover's own frame rails and side guards to the host's
 * outer wall plane. Both mover kinds end on that plane:
 *
 * - A spur stops a sideGap short of the bed edge, so its rails extend to the wall plane and reach the conveyor
 *   it feeds.
 * - A straight roller or belt side-merges with its end face on the wall plane (snapFeatures seats a square T
 *   there). One butted on the bed edge instead (an older scene) overshoots by the wall thickness and retracts.
 *   Otherwise its wall/flange would pierce the host's frame at the mouth corners. A straight only retracts: a
 *   gapped one never grows.
 *
 * The host's frame never opens. Its side channel runs unbroken through the junction, as on a real line; only
 * its guards open.
 *
 * Each value is a mover-local centreline X overriding that side's leading end (facing the host). Transient,
 * never serialised; the renderer remaps the rail/guard meshes and the sim the guard colliders.
 */
export interface GuardExtents {
  /** -Z side, downstream (+X) end */
  leftFront?: number
  /** -Z side, upstream (-X) end */
  leftBack?: number
  /** +Z side, downstream (+X) end */
  rightFront?: number
  /** +Z side, upstream (-X) end */
  rightBack?: number
  /** how each overridden end is cut (the junction's shared mitre), absent when none is */
  mitres?: GuardMitres
  /**
   * How each overridden end's frame rail is cut to fit the host's frame, which stays whole (the host frame never
   * opens). Same `x` as the extents row and the same `d` (from the guard line, `inner`), but a different `c`: not a
   * mitre, the host's own wall plane across the rail. So the rail's wall (d -0.01..0) ends on the host frame's outer
   * wall face and its top flange (d 0..0.02) on the host flange's outer edge, which is that plane moved
   * FRAME_FLANGE_WIDTH out: {@link railFlangeOffset} further into the piece. Present for every end that has an
   * extents value, square T included (c 0, where only the flange steps back). Visual only.
   */
  railCuts?: GuardMitres
}

/**
 * A mitred guard end. Two guards meeting at a junction corner cannot both end square without one running through
 * the other. The corner is where their inner faces meet, and everything outboard of that (the 5 mm sheet, the
 * 20-25 mm top return) crosses the other guard's band at the junction angle. That shows as the spur's end sticking
 * through the host's guard, worst at shallow angles. So both guards are cut on one plane, the bisector of the
 * angle between them. The corner closes like a picture frame at any splay and neither reaches the other's side.
 *
 * `x` is the end at the guard's inner face (the same X the opening / extents row carries), in the guard's own frame;
 * at outward distance `d` from that face the end sits `c * d` further back into the piece. So `c` is cot(phi/2), phi
 * being the angle between the two guards: 1 for a square T, ~1.7 for a 60 degree spur's acute corner, ~0.58 for its
 * obtuse one. Visual only: the colliders keep their square ends, and cargo only ever meets the inner faces, which
 * already meet exactly at `x`.
 */
export interface GuardMitre {
  x: number
  c: number
}

/** a part's mitred guard ends per side, plus `inner`: |local Z| of its guards' inner face (where `d` is 0) */
export interface GuardMitres {
  left: GuardMitre[]
  right: GuardMitre[]
  inner: number
}

/** longest pull-back per metre outward: a guard meeting another almost head-on (phi -> 0) is not a junction */
const MAX_MITRE = 8

/** cot(phi/2) of the angle between two plan unit vectors - the mitre coefficient of {@link GuardMitre} */
export function mitreCoefficient(ax: number, az: number, bx: number, bz: number): number {
  const cos = ax * bx + az * bz
  const sin = Math.abs(ax * bz - az * bx)
  if (sin < 1e-6) return cos > 0 ? MAX_MITRE : 0
  return Math.min((1 + cos) / sin, MAX_MITRE)
}

/** the mitre cut on `side` at `x` (within 1 mm), else 0 - how every consumer asks about a piece's end */
export function mitreAt(mitres: GuardMitres | undefined, side: 'left' | 'right', x: number): number {
  if (!mitres) return 0
  for (const m of mitres[side]) if (Math.abs(m.x - x) < 1e-3) return m.c
  return 0
}

/** the cut on `side` at `x` (within 1 mm), or null where there is none: unlike {@link mitreAt}, for cuts whose `c`
 *  may be 0 and still mean something (a rail's square cope still steps its flange back) */
export function cutAt(cuts: GuardMitres | undefined, side: 'left' | 'right', x: number): number | null {
  if (!cuts) return null
  for (const m of cuts[side]) if (Math.abs(m.x - x) < 1e-3) return m.c
  return null
}

/** how much further into the piece a rail's flange ends than its wall under the rail cut `c`: the host flange's outer
 *  edge is its wall plane moved FRAME_FLANGE_WIDTH out, measured along a rail crossing it at slope c */
export function railFlangeOffset(c: number): number {
  return FRAME_FLANGE_WIDTH * Math.hypot(1, c)
}

/** ascending x per side, so a part's cuts don't depend on the order its neighbours were visited in (the incremental
 *  resolver hands them over in a different order than a full pass) */
export function sortCuts(m: GuardMitres): GuardMitres {
  const byX = (a: GuardMitre, b: GuardMitre) => a.x - b.x
  return { left: [...m.left].sort(byX), right: [...m.right].sort(byX), inner: m.inner }
}

/** stable text for change detection */
export function mitresKey(m: GuardMitres | undefined): string {
  if (!m) return ''
  const row = (r: GuardMitre[]) => r.map((e) => `${e.x.toFixed(4)}:${e.c.toFixed(4)}`).join(',')
  return `${row(m.left)}/${row(m.right)}`
}

/**
 * Mitre rows [x, c, side ±1] for a drawn part's `guardMitres` param (the host-fed opt-in, like guardOpenings):
 * one per mitred end across its openings and its extents. Its geometry() cuts each guard piece whose end lands on a
 * row's `x`, in the part's own plan X (a belt matches its piece ends' plan X, not their arc length).
 */
export function guardMitreRows(...sources: (GuardMitres | undefined)[]): number[][] {
  const rows: number[][] = []
  for (const m of sources) {
    if (!m) continue
    for (const e of m.left) rows.push([e.x, e.c, -1])
    for (const e of m.right) rows.push([e.x, e.c, 1])
  }
  return rows
}

/**
 * Inclined beds. Both junction resolvers measure in plan (toLocalXZ), but an inclined straight rig (tiltDeg)
 * lays its guards and rails along its slope, pivoting about the bed centre (rigWorldPoses' inclineRad). Its
 * consumers (the rig guard splitter, the sim's rig bodies) read openings and extents as distances along that
 * slope. A point `d` along the bed sits `d * cos` out in plan, so plan values are divided by {@link guardSlope}
 * on their way out. Without that division, a spur meeting a 20 degree roller 1.2 m from its centre gets its
 * opening ~7 cm off the mouth.
 */
export function guardSlope(part: PartInstance): number {
  return Math.cos(resolveInclineRad(part)) // 1 for anything that doesn't incline
}

/**
 * Height of `host`'s running surface at a plan local X: a belt's path (it may climb), an inclined bed's slope,
 * else the deck plane at the part origin. The junction height gate compares a mover's end against it.
 */
export function hostSurfaceY(host: PartInstance, planX: number): number {
  const belt = bedView(host, 'path')
  if (belt) {
    const path = buildBeltPath(belt.segments, belt.height)
    return host.position[1] + sampleBeltPathExt(path, beltXToSExt(path, planX)).y
  }
  return host.position[1] + planX * Math.tan(resolveInclineRad(host))
}

/** does `end` meet `host`'s running surface at a height a guard can stand between (GUARD_CONTACT_HEIGHT)? */
export function endAtHostHeight(end: PartEnd, host: PartInstance, planX: number): boolean {
  return Math.abs(end.y - hostSurfaceY(host, planX)) <= GUARD_CONTACT_HEIGHT
}

/** local +X (flow) and +Z (lateral) axes of a part, as world XZ unit vectors */
function partAxes(part: PartInstance): { fx: number; fz: number; zx: number; zz: number } {
  const o = toWorldXZ(part, 0, 0)
  const xa = toWorldXZ(part, 1, 0)
  const za = toWorldXZ(part, 0, 1)
  return { fx: xa.x - o.x, fz: xa.z - o.z, zx: za.x - o.x, zz: za.z - o.z }
}

/** a mover's local face geometry: a spur's rails extend to the host's wall plane, a straight's or a belt's retract
 *  to it (the bed's {@link BedMergeFaces}) */
type MoverShape = BedMergeFaces

/** any snap-extent-capable mover: a spur, a straight or a belt */
function moverShapeOf(part: PartInstance): MoverShape | null {
  return bedOf(part)?.mergeFaces(part) ?? null
}

/**
 * A host's bed span in plan (an inclined bed's length foreshortened by its slope) + half-width in its local frame,
 * or null when the part can't host a merge. Hosts are the beds whose guards open (the bed's guardHost: a belt,
 * tail-origin 0..extent, or a straight, centre-origin ±length/2), so the opening and the extension are produced for
 * the same junction. A bed that takes end joins only (a spur) is not one.
 */
function hostGeom(host: PartInstance): { lo: number; hi: number; hw: number } | null {
  const bed = bedOf(host)
  if (bed === null || bed.endJoinsOnly) return null
  const g = bed.guardHost(host)
  return g ? { lo: g.bedLo * g.slope, hi: g.bedHi * g.slope, hw: g.hw } : null
}

/** one side's junction corner: where the mover's guard line meets the host's outer wall plane */
export interface JunctionCorner {
  /** world XZ of the corner (the point the mover's guard on this side terminates at) */
  x: number
  z: number
  /** the same point as a mover-local centreline X measured along the bed (what a `guardExtents` row carries) */
  localX: number
  /** does the mover's guard actually end here? A spur always extends to it; a straight only retracts to it, so one
   *  parked with a gap keeps its own face and never reaches the corner (the retract-only veto, stated once) */
  reaches: boolean
  /** the corner's {@link GuardMitre} coefficient, in plan (0 until both corners are known: the host's guard runs
   *  away from the other corner, and that direction is half the angle) */
  mitre: number
  /** the mover's rail cut here ({@link GuardExtents.railCuts}): the host's wall plane across the rail, as the
   *  along-bed pull-back per metre outward. 0 for a square T; negative where the plane leans back over the rail. */
  cope: number
}

/** the mouth a mover cuts in one side of a host: both guard corners + which mover end faces the wall */
export interface JunctionMouth {
  dirSign: 1 | -1
  left?: JunctionCorner
  right?: JunctionCorner
}

/** the per-(mover, host) setup both sides share, hoisted so a pair runs one moverShapeOf / hostGeom /
 *  partAxes / conveyorEndsOf instead of one per side (this runs on the scene-edit path at n=800) */
interface MouthContext {
  shape: MoverShape
  geom: { lo: number; hi: number; hw: number }
  sAx: ReturnType<typeof partAxes>
  hAx: ReturnType<typeof partAxes>
  ends: PartEnd[]
}

function mouthOnSide(mover: PartInstance, host: PartInstance, sideHost: 1 | -1, ctx: MouthContext): JunctionMouth | null {
  const { shape, geom, sAx, hAx, ends } = ctx
  // host outer wall plane: point at local z = side*(hw+wall), outward normal = host ±Z
  const planePt = toWorldXZ(host, 0, sideHost * (geom.hw + FRAME_WALL_THICKNESS))
  const nx = sideHost * hAx.zx
  const nz = sideHost * hAx.zz

  // gate: a mover end must sit on this plane, within the host's length, and at the host's surface height
  let touches = false
  for (const e of ends) {
    if (Math.abs((e.x - planePt.x) * nx + (e.z - planePt.z) * nz) > GUARD_CONTACT_TOLERANCE) continue
    const loc = toLocalXZ(host, e.x, e.z)
    if (loc.x < geom.lo - GUARD_CONTACT_TOLERANCE || loc.x > geom.hi + GUARD_CONTACT_TOLERANCE) continue
    if (!endAtHostHeight(e, host, loc.x)) continue
    touches = true
    break
  }
  if (!touches) return null

  // dirSign>0: the mover's front approaches the wall (remap front); <0: back
  const dirSign: 1 | -1 = sAx.fx * nx + sAx.fz * nz > 0 ? -1 : 1
  const out: JunctionMouth = { dirSign }

  for (const sideMover of [-1, 1] as const) {
    const innerZ = sideMover * (shape.width / 2)
    const trailingX = (dirSign > 0 ? shape.faceX(-1, innerZ) : shape.faceX(1, innerZ)) * shape.slope
    const ro = toWorldXZ(mover, trailingX, sideMover * (shape.width / 2 + FRAME_WALL_THICKNESS))
    const rdx = sAx.fx * dirSign
    const rdz = sAx.fz * dirSign
    const denom = rdx * nx + rdz * nz
    if (Math.abs(denom) < 0.001) continue
    const t = ((planePt.x - ro.x) * nx + (planePt.z - ro.z) * nz) / denom
    if (t < 0.01) continue
    const wx = ro.x + rdx * t
    const wz = ro.z + rdz * t
    const localX = toLocalXZ(mover, wx, wz).x / shape.slope
    // a straight never grows. It reaches the corner when its face is on the wall plane (where the snap engine seats a
    // square T) or past it (a T butted on the bed edge, as in older scenes, retracts to it). If the plane lies beyond
    // its face (a mover parked with a deliberate gap), its end stays where it is. Only a spur extends to close a gap.
    const reaches = shape.spur || (dirSign > 0 ? localX < shape.faceX(1, innerZ) + 1e-4 : localX > shape.faceX(-1, innerZ) - 1e-4)
    // the rail's cut: where the same wall plane crosses the rail's inner face (the bed edge, one wall thickness in from
    // the guard line) gives the slope of the plane across the rail, as the along-bed pull-back per metre outward
    const ri = toWorldXZ(mover, trailingX, innerZ)
    const ti = ((planePt.x - ri.x) * nx + (planePt.z - ri.z) * nz) / denom
    const railInnerX = toLocalXZ(mover, ri.x + rdx * ti, ri.z + rdz * ti).x / shape.slope
    const cope = (-dirSign * (localX - railInnerX)) / FRAME_WALL_THICKNESS
    out[sideMover < 0 ? 'left' : 'right'] = { x: wx, z: wz, localX, reaches, mitre: 0, cope }
  }
  if (out.left && out.right) {
    // the mitre bisects the angle between the two guards leaving each corner: the host's runs along its axis away
    // from the other corner, the mover's runs back up its own axis away from the host (the ray reversed)
    const hostX = (c: JunctionCorner) => toLocalXZ(host, c.x, c.z).x
    const sx = -sAx.fx * dirSign
    const sz = -sAx.fz * dirSign
    for (const [c, other] of [[out.left, out.right], [out.right, out.left]] as const) {
      const away = Math.sign(hostX(c) - hostX(other)) || 1
      c.mitre = mitreCoefficient(hAx.fx * away, hAx.fz * away, sx, sz)
    }
  }
  return out.left === undefined && out.right === undefined ? null : out
}

/**
 * Where `mover`'s two side-guard lines cross `host`'s outer wall plane, for both host sides: the corners
 * of the mouth the merge makes. Null per side when the mover doesn't butt it.
 *
 * The single derivation of the junction, shared like beltGuards/functionGuards/curvedGuards. The extents resolver
 * turns each corner into that side's rail/guard end override, and the openings resolver spans the host's guard
 * between them. Derived separately they disagree: a mouth plane ± FRAME_WALL_THICKNESS margin equals the guard
 * offset only for parallel faces, so on a spur's splayed face one corner opens ~14 mm too far and the other
 * ~21 mm too little. Keyed to the corners, the host's guard ends where the mover's begins at any splay.
 *
 * Returns the raw geometry, no retract-only veto: whether a mover adopts a corner is the extents resolver's
 * policy (a deliberately-gapped straight declines), but the mouth still opens.
 */
export function junctionMouths(mover: PartInstance, host: PartInstance): { hostLeft: JunctionMouth | null; hostRight: JunctionMouth | null } {
  const none = { hostLeft: null, hostRight: null }
  const shape = moverShapeOf(mover)
  const geom = hostGeom(host)
  if (!shape || !geom || host.id === mover.id) return none
  const ctx: MouthContext = { shape, geom, sAx: partAxes(mover), hAx: partAxes(host), ends: conveyorEndsOf(mover) }
  return { hostLeft: mouthOnSide(mover, host, -1, ctx), hostRight: mouthOnSide(mover, host, 1, ctx) }
}

/**
 * Snap extents for `mover` from every straight host whose side it butts. `mover`
 * must be a spur belt/roller conveyor (rails extend to the host wall plane) or a
 * straight conveyor (rails retract to it); other types return {}. Hosts are limited
 * to straight roller/belt conveyors (the same family deriveGuardOpenings opens),
 * so the opening and the extent are produced for the same junction.
 */
export function deriveGuardExtents(mover: PartInstance, others: readonly PartInstance[]): GuardExtents {
  const result: GuardExtents = {}
  const shape = moverShapeOf(mover)
  if (!shape) return result
  const mitres: GuardMitres = { left: [], right: [], inner: shape.width / 2 + FRAME_WALL_THICKNESS }
  const railCuts: GuardMitres = { left: [], right: [], inner: mitres.inner }

  for (const host of others) {
    if (host.id === mover.id) continue
    const mouths = junctionMouths(mover, host)
    for (const mouth of [mouths.hostLeft, mouths.hostRight]) {
      if (!mouth) continue
      const { dirSign } = mouth

      for (const sideMover of [-1, 1] as const) {
        const corner = sideMover < 0 ? mouth.left : mouth.right
        if (!corner || !corner.reaches) continue
        const side = sideMover < 0 ? 'left' : 'right'
        const key = `${side}${dirSign > 0 ? 'Front' : 'Back'}` as 'leftFront' | 'leftBack' | 'rightFront' | 'rightBack'
        result[key] = corner.localX
        // along the bed, like the X: an inclined mover's guard runs up its slope
        if (corner.mitre > 0) mitres[side].push({ x: corner.localX, c: corner.mitre / shape.slope })
        railCuts[side].push({ x: corner.localX, c: corner.cope })
      }
    }
  }
  if (mitres.left.length > 0 || mitres.right.length > 0) result.mitres = sortCuts(mitres)
  if (railCuts.left.length > 0 || railCuts.right.length > 0) result.railCuts = sortCuts(railCuts)
  return result
}

function hasExtents(e: GuardExtents): boolean {
  return (
    e.leftFront !== undefined ||
    e.leftBack !== undefined ||
    e.rightFront !== undefined ||
    e.rightBack !== undefined
  )
}

/**
 * Per-mover snap-extent map for a whole scene, keyed by part id. Only extent-capable movers - SDK
 * spur-view parts (extend) and straight conveyors (retract) - with at least one derived extent appear.
 *
 * Memoized per mover on the identity of that mover and of the hosts the broad phase handed it
 * (memoParts.ts `memoizeLocalized`): dragging one part re-derives only the movers whose host set
 * actually moved, instead of the whole scene once per frame.
 */
export const computeSceneExtents = memoizeLocalized<GuardExtents>({
  isTarget: (p) => isConveyorLike(p) && moverShapeOf(p) !== null,
  isInfluencer: (p) => isConveyorLike(p) && hostGeom(p) !== null,
  tolerance: GUARD_CONTACT_TOLERANCE,
  derive: (part, near) => {
    const e = deriveGuardExtents(part, near)
    return hasExtents(e) ? e : undefined
  },
})


/**
 * Fold host-derived snap extents into an extent-capable mover's params as `guardExtents` rows, the extents
 * counterpart of the neighbour-opening fold (sdkPart's withNeighborOpenings). Rows are [side ±1, backX m, frontX m]
 * in the part's own local X, one per side with at least one overridden end. The other end keeps the part's own
 * face X (the spur's sheared face, a straight's ±length/2, a belt's drum-overhang face). A no-op unless the part
 * is an extent-capable mover and declares a `guardExtents` param (the opt-in convention). geometry() stays
 * world-unaware: the host resolves the neighbours and passes the result in as data. Shared by the renderer
 * (rail/guard meshes) and the sim (guard colliders) so the visible junction and the collision walls always agree.
 */
export function withSnapExtents(
  part: PartInstance,
  params: Record<string, ParamValue>,
  extents: GuardExtents | undefined,
): Record<string, ParamValue> {
  if (!extents || !hasExtents(extents) || part.type !== 'part') return params
  const shape = moverShapeOf(part)
  if (!shape || !getPackage(part.packageId)?.params.guardExtents) return params
  const rows: number[][] = []
  for (const side of [-1, 1] as const) {
    const f = side < 0 ? extents.leftFront : extents.rightFront
    const b = side < 0 ? extents.leftBack : extents.rightBack
    if (f === undefined && b === undefined) continue
    const z = side * (shape.width / 2)
    rows.push([side, b ?? shape.faceX(-1, z), f ?? shape.faceX(1, z)])
  }
  if (rows.length === 0) return params
  return { ...params, guardExtents: rows as unknown as ParamValue }
}

/** stable key for change detection between renders (positions drift continuously during a drag) */
export function extentsKey(e: GuardExtents | undefined): string {
  if (!e) return ''
  return JSON.stringify([e.leftBack ?? null, e.leftFront ?? null, e.rightBack ?? null, e.rightFront ?? null]) + mitresKey(e.mitres) + '|' + mitresKey(e.railCuts)
}
