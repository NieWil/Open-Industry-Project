import type { PartInstance } from '../types'
import type { RigLink } from '../parts/partPackage'
import type { ParamValue } from '../parts/partApi'
import { getPackage } from '../parts/partRegistry'
import { resolvePartParams } from '../parts/partScript'
import { partQuat } from '../frame'
import { rigGuardWallLink, rigHasGuardWall } from '../rig/rigGuards'
import { bedOf, bedView, rigInclineRad } from '../parts/partGeometry'
import { beltGuardWalls } from './beltGuards'
import { curvedGuardWalls } from './curvedGuards'
import { functionStaticWalls } from './functionGuards'
import { qApply, qMul, rigWorldPoses, linkHalfExtents } from '../rig/rigPose'
import type { Quat, RigParams, Vec3 } from '../rig/rigPose'
import { guardColliderCrossSection } from '../geometry/collisionShapes'
import { isOpener, keptSegments, rigGuardSide } from './guardOpenings'
import type { GuardOpenings, Range } from './guardOpenings'
import { computeSceneOpenings } from './guardOpenings'
import { computeSceneExtents } from './guardExtents'
import type { GuardExtents } from './guardExtents'
import { memoizeByParticipants } from '../memoParts'

/**
 * Guard-run merging: the side-guard counterpart of the butted-belt deck merge (deckClusters.ts).
 *
 * A side guard is built as one collider per part per side. Two conveyors butted end-to-end therefore present
 * cargo with two separate guard bodies meeting at the seam, and Jolt's enhanced internal edge removal does not
 * span separate bodies (the same limitation deckClusters.ts works around; see the GHOST_* notes in
 * sim/world.ts). Cargo squared against the wall by roller skew rides the upstream guard, then hits the
 * downstream guard's leading edge and is kicked ~35 mm off the wall. It recovers only if something keeps pressing
 * the cargo back, so a skewed -> skewed seam hides it and a skewed -> straight seam leaves it permanent.
 *
 * So there is no seam: collinear, coplanar, equal-cross-section guard spans that touch end-to-end are emitted
 * as one longer box by a single owner part (lowest id, deterministic, the cluster-owner pattern deckClusters.ts
 * uses), and suppressed on every other member.
 *
 * Why span overrides rather than world geometry: this resolver returns spans in each part's own local
 * centreline X, the frame `openings` and `extents` already use. The builder computes the box pose, orientation,
 * incline tilt and cross-section the same way for merged and unmerged guards and only takes a different span
 * list. Nothing about guard placement is recomputed here, so a merged guard cannot drift from an unmerged one.
 * Both sides call the same keptSegments(), so the split logic has exactly one implementation.
 */

/** ends this close along the wall axis count as touching (a butt seam, not a gap) */
const SEAM_TOL = 0.02
/** two guard walls this close in the perpendicular/vertical directions are the same wall plane */
const PLANE_TOL = 0.002
/** cross-sections (half height / half thickness) within this are interchangeable */
const SECTION_TOL = 0.002
/** |dot| of two wall axes above this counts as collinear (~1.1 deg) */
const PARALLEL_DOT = 0.9998
/** broad-phase grid cell (m) - about a short conveyor, matching computeSceneOpenings' footprint grid */
const GRID_CELL = 4

/**
 * Per-part guard span overrides, keyed by wall. A wall present here replaces the spans the builder would
 * otherwise emit for it: the run owner carries the union of every member's spans (measured in the owner
 * wall's own local X, so it reaches past its own bed ends), and every non-owner member carries an empty list.
 *
 * Keyed rather than sided because a belt contributes many walls per side (one per guard chord - runs, bends,
 * pulley-wrap stubs), so `left`/`right` cannot address them. Keys come from the same enumeration the builder
 * walks (`rig:<linkName>` from buildRigBodies, `belt:<side>:<index>` from beltGuardWalls), which is why both
 * sides must read walls from one shared function.
 */
export interface GuardRun {
  walls: Record<string, Range[]>
}

type Side = 'left' | 'right'

/** one part's contribution to a wall: its solid spans plus the world-space frame they live in */
interface WallSpan {
  partId: string
  side: Side
  /** identifies this wall to the builder that will emit it */
  key: string
  /** world origin of the wall box (its centre) and its orientation */
  origin: Vec3
  quat: Quat
  /** unit world direction of the wall's local +X (the length axis) */
  axis: Vec3
  /** half height / half thickness - merging requires these to match */
  hy: number
  hz: number
  /** solid spans in this wall's own local X, centred on `origin` */
  spans: Range[]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/**
 * The guard links of a rig part, with each side's solid spans resolved exactly as buildRigBodies resolves
 * them: openings and snap extents applied through the shared keptSegments(). Returns [] for any part that is
 * not a rig, declares no guards, or has them switched off.
 */
function wallSpansOf(part: PartInstance, openings: GuardOpenings | undefined, extents: GuardExtents | undefined): WallSpan[] {
  if (part.type !== 'part') return []
  const pkg = getPackage(part.packageId)
  if (!pkg) return []
  // Belt-like parts: walls come from the shared builder enumeration, one per guard chord. Collinear chords
  // are already collapsed there, so what arrives here is one wall per straight line, the granularity the
  // cross-part merge works at (a bend's chords turn and never merge).
  if (pkg.geometry.kind !== 'rig') {
    const out: WallSpan[] = []
    for (const w of beltGuardWalls(part, pkg, openings, extents)) {
      const quat: Quat = w.quat
      out.push({
        partId: part.id,
        side: w.side === -1 ? 'left' : 'right',
        key: w.key,
        origin: w.pos,
        quat,
        axis: qApply(quat, [1, 0, 0]),
        hy: w.hy,
        hz: w.hz,
        spans: [[-w.halfLen, w.halfLen]],
      })
    }
    if (out.length > 0) return out
    // Curved parts: chord walls + straight tangent stubs, from the shared builder enumeration. Only the
    // stubs are straight, so only they can pair with a butted neighbour. The chords turn and sameWall's
    // parallel test drops them, with no special case.
    for (const w of curvedGuardWalls(part)) {
      out.push({
        partId: part.id,
        side: w.side === -1 ? 'left' : 'right',
        key: w.key,
        origin: w.pos,
        quat: w.quat,
        axis: qApply(w.quat, [1, 0, 0]),
        hy: w.hy,
        hz: w.hz,
        spans: [[-w.halfLen, w.halfLen]],
      })
    }
    if (out.length > 0) return out
    // Spur parts, whose guards are coarse `collision:'box'` boxes. Restricted to the spur: that is the one
    // addFunctionStaticColliders call site that takes a merge run, and it folds the same `extents` and `openings`
    // in, so both sides derive the wall list from identical params and the keys address the same boxes. The other
    // call sites take no run, so admitting them here could desync. Only sideGuard boxes merge. A rail or
    // frame submesh is a different wall with a different cross-section, and merging across roles would
    // silently reshape one into the other.
    if (bedView(part, 'spur') === null) return out
    const pq = partQuat(part)
    for (const w of functionStaticWalls(part, pkg, extents, openings)) {
      if (!w.sideGuard) continue
      const d = qApply(pq, [w.localCx, w.localCy, w.localCz])
      out.push({
        partId: part.id,
        side: w.sideGuard,
        key: w.key,
        origin: [part.position[0] + d[0], part.position[1] + d[1], part.position[2] + d[2]],
        quat: pq,
        axis: qApply(pq, [1, 0, 0]),
        hy: w.hy,
        hz: w.hz,
        spans: [[-w.hx, w.hx]],
      })
    }
    return out
  }
  // A rig with no guard link can never join a run, so return before the forward kinematics below. Most rigs
  // are this case (platforms, stairs, robots, gantries), and FK over their 28-37 links on every scene edit is
  // wasted work. Same predicate `participates()` uses, so the two can't drift.
  if (!rigHasGuardWall(pkg)) return []
  const geo = pkg.geometry
  const params = part.params as RigParams
  const scale = typeof part.params.scale === 'number' && part.params.scale > 0 ? part.params.scale : 1
  const inclineRad = rigInclineRad(geo, part.params as unknown as Record<string, unknown>)
  const poses = rigWorldPoses(geo, {}, undefined, scale, params, inclineRad)
  const pq = partQuat(part)
  // the resolved params (defaults folded in) - what buildRigBodies gates its showParam skip on. Reading the
  // raw instance params here would count a default-off guard as a wall the builder never emits.
  const resolved = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
  const out: WallSpan[] = []
  for (const link of geo.links as RigLink[]) {
    // One shared rule for which links are mergeable guard walls (core/rig/rigGuards.ts), so the resolver and
    // buildRigBodies can't disagree about what exists. Only a sideGuard: a sideRail carries
    // GROUND_FRICTION and is admitted to the conveyor ghost gates, where a guard is friction 0 and
    // is not. Merging across roles would silently reclassify one into the other.
    if (!rigGuardWallLink(link, resolved)) continue
    const side = rigGuardSide(link)!
    const lp = poses.get(link.name)
    if (!lp) continue
    const he = linkHalfExtents(link, params)
    const backX = (side === 'left' ? extents?.leftBack : extents?.rightBack) ?? -he[0]
    const frontX = (side === 'left' ? extents?.leftFront : extents?.rightFront) ?? he[0]
    const open = (side === 'left' ? openings?.left : openings?.right) ?? []
    const spans = keptSegments(backX, frontX, open)
    if (spans.length === 0) continue
    // world pose of the link - the composition buildRigBodies performs (composeRigLink)
    const wp = qApply(pq, lp.pos)
    const quat = qMul(pq, lp.quat)
    // Same guard-collider normalization buildRigBodies applies (core/geometry/collisionShapes.ts): the resolver must
    // match walls on the cross-section the body will have, not the authored visual one, or a roller would
    // never pair with a belt whose collider it is about to become identical to.
    const gx = guardColliderCrossSection(he[2])
    const dz = qApply(quat, [0, 0, (side === 'left' ? -1 : 1) * gx.outwardShift])
    const origin: Vec3 = [part.position[0] + wp[0] + dz[0], part.position[1] + wp[1] + dz[1], part.position[2] + wp[2] + dz[2]]
    out.push({ partId: part.id, side, key: `rig:${link.name}`, origin, quat, axis: qApply(quat, [1, 0, 0]), hy: he[1], hz: gx.hz, spans })
  }
  return out
}

/**
 * Do two wall contributions lie on the same physical wall - collinear axes, coincident wall plane, and the
 * same cross-section? Position along the axis is not considered here (that's the seam test); this only asks
 * whether one longer box could stand in for both.
 */
function sameWall(a: WallSpan, b: WallSpan): boolean {
  if (Math.abs(a.hy - b.hy) > SECTION_TOL) return false
  if (Math.abs(a.hz - b.hz) > SECTION_TOL) return false
  if (Math.abs(dot(a.axis, b.axis)) < PARALLEL_DOT) return false
  // b's origin must sit on a's axis line: the component of the offset perpendicular to the axis is the
  // distance between the two wall centrelines (catches parallel-but-offset walls, e.g. different bed widths).
  const d = sub(b.origin, a.origin)
  const along = dot(d, a.axis)
  const perp: Vec3 = [d[0] - along * a.axis[0], d[1] - along * a.axis[1], d[2] - along * a.axis[2]]
  return Math.hypot(perp[0], perp[1], perp[2]) <= PLANE_TOL
}

/** a wall's spans projected onto a shared world axis, as distances from `ref` along it */
function projected(w: WallSpan, ref: Vec3, axis: Vec3): Range[] {
  // the wall's own local +X may run opposite the shared axis; project both endpoints and re-order
  const base = dot(sub(w.origin, ref), axis)
  const flip = dot(w.axis, axis) < 0 ? -1 : 1
  return w.spans.map(([lo, hi]) => {
    const a = base + flip * lo
    const b = base + flip * hi
    return (a <= b ? [a, b] : [b, a]) as Range
  })
}

/** do two span sets touch or overlap (within SEAM_TOL) anywhere? */
function spansTouch(a: readonly Range[], b: readonly Range[]): boolean {
  for (const [alo, ahi] of a) {
    for (const [blo, bhi] of b) {
      if (blo - ahi <= SEAM_TOL && alo - bhi <= SEAM_TOL) return true
    }
  }
  return false
}

/** union of ranges that touch/overlap within SEAM_TOL, ascending - a butt seam becomes one solid span */
function unionSpans(ranges: Range[]): Range[] {
  if (ranges.length < 2) return ranges.map((r) => [r[0], r[1]] as Range)
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Range[] = [[sorted[0]![0], sorted[0]![1]]]
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!
    const last = out[out.length - 1]!
    if (r[0] - last[1] <= SEAM_TOL) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/**
 * Every part whose move can change a guard run. Must cover everything computeGuardRunsUncached reads, or that
 * part's move never invalidates the memo and the merge silently goes stale on a live edit.
 *
 * Two groups, and the second is easy to forget: the wall sources wallSpansOf draws from, plus every part that
 * can change a source's openings or extents. The resolver runs computeSceneOpenings/computeSceneExtents
 * itself, so an opener (a butting conveyor, a guard-mounted diverter) changes a host's spans without being a
 * wall source at all. `isOpener` covers the openers, the hosts and the extent-capable movers in one predicate.
 *
 * A rig is admitted only when it can actually contribute a wall (or is an opener). 21 of the 22 rigs in
 * examples/parts declare no guard link. Admitting them all would make dragging a platform re-resolve the
 * whole scene: measured 1.8 ms/frame at 400 conveyors for an edit whose correct answer is "nothing changed".
 */
function participates(p: PartInstance): boolean {
  if (p.type !== 'part') return false
  const pkg = getPackage(p.packageId)
  if (!pkg) return false
  if (pkg.geometry.kind === 'rig') return rigHasGuardWall(pkg) || isOpener(p)
  const kind = bedOf(p)?.kind
  return kind === 'path' || kind === 'arc' || kind === 'spur' || isOpener(p)
}

export const computeGuardRuns = memoizeByParticipants(participates, computeGuardRunsUncached)

function computeGuardRunsUncached(parts: readonly PartInstance[]): Map<string, GuardRun> {
  const result = new Map<string, GuardRun>()
  const openings = computeSceneOpenings(parts)
  const extents = computeSceneExtents(parts)
  const walls: WallSpan[] = []
  for (const p of parts) {
    for (const w of wallSpansOf(p, openings.get(p.id), extents.get(p.id))) walls.push(w)
  }
  if (walls.length < 2) return result

  // connected components over "same wall and spans touch": a chain of three butted beds merges into one run
  const parent = walls.map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]!
    for (let c = x; parent[c] !== root; ) { const next = parent[c]!; parent[c] = root; c = next }
    return root
  }
  // Broad phase. Pairing every wall against every other is quadratic and this resolver runs on every scene
  // edit. Walls can only merge if their spans touch, so bucket each wall by the world XZ cells its span AABB
  // covers (expanded by SEAM_TOL) and only test pairs sharing a cell, as computeSceneOpenings' footprint grid
  // does. Expanding by the tolerance keeps it conservative: a pair that could merge is never filtered out, so
  // this only affects speed.
  //
  // Measured marginal cost of this resolver on the production path (resolveScene has already warmed the
  // openings/extents memos it reads), grid vs naive: 2.4/7.4 ms at 100 conveyors, 3.4/27.3 at 400,
  // 10.2/118.9 at 800 - 12x at scale, and near-linear instead of quadratic.
  const buckets = new Map<number, number[]>()
  const cellsOf = (w: WallSpan): number[] => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [lo, hi] of w.spans) {
      for (const t of [lo, hi]) {
        const x = w.origin[0] + w.axis[0] * t
        const z = w.origin[2] + w.axis[2] * t
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
    if (minX > maxX) return []
    const c0x = Math.floor((minX - SEAM_TOL) / GRID_CELL), c1x = Math.floor((maxX + SEAM_TOL) / GRID_CELL)
    const c0z = Math.floor((minZ - SEAM_TOL) / GRID_CELL), c1z = Math.floor((maxZ + SEAM_TOL) / GRID_CELL)
    const out: number[] = []
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) out.push(cx * 73856093 ^ cz * 19349663)
    return out
  }
  const wallCells = walls.map(cellsOf)
  for (let i = 0; i < walls.length; i++) {
    for (const c of wallCells[i]!) {
      const b = buckets.get(c)
      if (b) b.push(i)
      else buckets.set(c, [i])
    }
  }
  // stamp array dedupes candidates across the cells a wall spans, without allocating a Set per wall
  const stamp = new Int32Array(walls.length).fill(-1)
  for (let i = 0; i < walls.length; i++) {
    const a = walls[i]!
    for (const c of wallCells[i]!) {
      for (const j of buckets.get(c) ?? []) {
        if (j <= i || stamp[j] === i) continue
        stamp[j] = i
        const b = walls[j]!
        if (a.partId === b.partId) continue
        if (!sameWall(a, b)) continue
        if (!spansTouch(projected(a, a.origin, a.axis), projected(b, a.origin, a.axis))) continue
        parent[find(i)] = find(j)
      }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < walls.length; i++) {
    const root = find(i)
    const arr = groups.get(root)
    if (arr) arr.push(i)
    else groups.set(root, [i])
  }

  const patch = (partId: string, key: string, spans: Range[]): void => {
    let run = result.get(partId)
    if (!run) { run = { walls: {} }; result.set(partId, run) }
    run.walls[key] = spans
  }
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue // a lone wall keeps its own spans: no override, builder path unchanged
    // Owner = lowest part id, so the merged body's home group is deterministic and order-independent
    const ownerIdx = idxs.reduce((best, i) => (walls[i]!.partId < walls[best]!.partId ? i : best), idxs[0]!)
    const owner = walls[ownerIdx]!
    // union every member's spans in the owner's local X: project onto the owner's axis relative to its
    // origin, which is its local-X coordinate (the axis is unit and the origin is the box centre).
    const all: Range[] = []
    for (const i of idxs) all.push(...projected(walls[i]!, owner.origin, owner.axis))
    patch(owner.partId, owner.key, unionSpans(all))
    for (const i of idxs) {
      if (i === ownerIdx) continue
      patch(walls[i]!.partId, walls[i]!.key, [])
    }
  }
  return result
}

/**
 * Change signature: the spans a part will emit for each side. Folded into simResolvedKey so that a member
 * joining/leaving a run, or any member moving, rebuilds the owner (which holds the merged body) as well as
 * the member itself, exactly as deckClusterKey does for the merged deck.
 */
export function guardRunsKey(run: GuardRun | undefined): string {
  if (!run) return ''
  return Object.keys(run.walls)
    .sort()
    .map((k) => `${k}=${run.walls[k]!.map(([a, b]) => `${a.toFixed(4)}:${b.toFixed(4)}`).join(',')}`)
    .join('|')
}
