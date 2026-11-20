import type { PartInstance } from '../types'
import type { PartPackage } from '../parts/partPackage'
import type { ParamValue } from '../parts/partApi'
import { resolvePartParams } from '../parts/partScript'
import { withSnapExtents } from './guardExtents'
import type { GuardExtents } from './guardExtents'
import { withGuardGaps } from './guardOpenings'
import type { GuardOpenings } from './guardOpenings'
import { evalPartGeometry } from '../geometry/geometryEval'
import { guardColliderCrossSection } from '../geometry/collisionShapes'
import { packageRev } from '../parts/partRegistry'

/**
 * The single enumeration of the coarse static-box colliders a `function`-geometry SDK part contributes: the
 * `collision: 'box'` submesh channel (spur conveyors, plain straight SDK conveyors). Shared by the sim's
 * builder (world.ts addFunctionStaticColliders) and the cross-part merge resolver (guardRuns.ts), for the same
 * reason beltGuardWalls is: the merge is keyed by wall, so both sides must walk the same list in the same
 * order or a merge decision is applied to the wrong box.
 *
 * A spur's side guards are authored as one `collision:'box'` MeshPart per side (so the AABB is a thin side
 * wall rather than a hull across the whole bed), and its cross-section matches the rig roller's guard exactly
 * (same 0.305 height at the same 0.1475 centre, same 0.005 thickness), so a spur butted collinear with a
 * roller forms a mergeable wall. Without this, a skew-driven box riding the guard is knocked 14.6 mm off it
 * at the seam, against 0.00 mm for a roller->roller butt (merged) and 0.00 mm for the roller alone.
 */

/**
 * The sibling channel, for solids an AABB would misrepresent: `collision: 'hull'` submeshes, enumerated as
 * part-local convex-hull point sets ({@link functionStaticHulls}). Hulls never take part in the guard merge
 * (they are shapes, not walls), so only the sim reads them, and the wall enumeration above is untouched.
 */

/** Local-space AABB of a flat [x,y,z,...] position buffer. */
function aabbOf(pos: ArrayLike<number>): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null {
  if (pos.length < 3) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i + 2 < pos.length; i += 3) {
    const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY, minZ, maxZ } : null
}

export interface StaticWall {
  /** stable identity for a merge override - the index is stable because both callers use this enumeration */
  key: string
  /** the submesh's declared side guard (MeshPart.sideGuard); only these walls take part in the guard merge */
  sideGuard?: 'left' | 'right'
  /** the submesh's declared surface friction (MeshPart.friction); absent keeps the wall default. Never on a guard */
  friction?: number
  /** part-local box centre (the caller composes it with the part pose) */
  localCx: number
  localCy: number
  localCz: number
  /** half extents; hx is the length along the part's local +X, the axis a merged span is measured in */
  hx: number
  hy: number
  hz: number
}

/**
 * Memo on (package revision, resolved params). The walls are a pure function of those (the part's pose never
 * enters, because these are part-local boxes), so every identical spur in a scene shares one geometry evaluation.
 * The key uses the revision, not just the id: a package edited in place (the browser behavior editor) keeps its
 * id and its params, and keyed on the id alone the sim would keep building the old geometry's guard walls while
 * the renderer redraws the new one.
 * This runs on the scene-edit path (guardRuns reads it), and evalPartGeometry measured ~0.5 ms per spur, which a
 * line of 400 spurs turns into ~80 ms of repeated work per edit without the memo.
 *
 * Results are shared and must be treated as immutable by callers (the repo's memo convention). Bounded so a
 * long editing session that sweeps a param through many values can't grow it without limit.
 */
const WALL_MEMO = new Map<string, StaticWall[]>()
const WALL_MEMO_MAX = 512

/**
 * Every `collision: 'box'` box a function part contributes, in part-local space and authored order.
 * Empty for a part with no such submeshes (an inert or purely-conveying part).
 * The returned array is shared/cached - do not mutate it.
 */
export function functionStaticWalls(part: PartInstance, pkg: PartPackage, extents?: GuardExtents, openings?: GuardOpenings): StaticWall[] {
  // the same host facts the renderer folds in (functionMesh.ts), so a gap or an extent moves the collider with the mesh
  const params = withGuardGaps(part, withSnapExtents(part, resolvePartParams(pkg.params, part.params as Record<string, ParamValue>), extents), openings)
  const memoKey = `${pkg.id}@${packageRev(pkg.id)}|${JSON.stringify(params)}`
  const hit = WALL_MEMO.get(memoKey)
  if (hit) return hit
  const meshParts = evalPartGeometry(pkg.behavior, params, { partId: part.id, packageId: pkg.id })
  const out: StaticWall[] = []
  let i = 0
  for (const mp of meshParts ?? []) {
    if (mp.collision !== 'box') continue
    const bb = aabbOf(mp.desc.positions)
    if (!bb) continue
    const localCz = (bb.minZ + bb.maxZ) / 2
    const hzRaw = (bb.maxZ - bb.minZ) / 2
    // Guard collider normalization (core/geometry/collisionShapes.ts): a spur authors its guards at the 0.005 visual
    // sheet thickness; thicken the collider outward from the inner face so it shares the belt/curve envelope
    // and can merge across families. Applied here, in the one enumeration both the builder and guardRuns
    // read, so the two can never disagree about the box. Non-guard submeshes are left exactly as authored.
    const gx = mp.sideGuard ? guardColliderCrossSection(hzRaw) : null
    out.push({
      key: `fn:${i++}`,
      ...(mp.sideGuard !== undefined ? { sideGuard: mp.sideGuard } : mp.friction !== undefined ? { friction: mp.friction } : {}),
      localCx: (bb.minX + bb.maxX) / 2,
      localCy: (bb.minY + bb.maxY) / 2,
      localCz: gx ? localCz + (mp.sideGuard === 'left' ? -1 : 1) * gx.outwardShift : localCz,
      hx: (bb.maxX - bb.minX) / 2,
      hy: (bb.maxY - bb.minY) / 2,
      hz: gx ? gx.hz : hzRaw,
    })
  }
  if (WALL_MEMO.size >= WALL_MEMO_MAX) WALL_MEMO.clear()
  WALL_MEMO.set(memoKey, out)
  return out
}

export interface StaticHull {
  /** stable identity (authored submesh order), for parity with {@link StaticWall.key} */
  key: string
  /** authored MeshPart finish - informational; hulls never merge */
  finish?: string
  /** the submesh's declared surface friction (MeshPart.friction); absent keeps the hull default */
  friction?: number
  /** part-local hull points (the caller composes them with the part pose) */
  points: readonly { x: number; y: number; z: number }[]
}

/**
 * Hull-point cap. A convex hull is built from every point given, so a dense visual mesh declared
 * `staticHull` would cost far more to build and collide than the shape warrants. Past the cap the submesh
 * degrades to its 8 AABB corners (exactly what the `'static'` box channel would produce),
 * which over-covers but never leaves a visible solid with no collider (cargo falling through it).
 */
const HULL_MAX_POINTS = 256

/** Quantized key for point dedup: authored rings/faces share corners, and a hull gains nothing from repeats. */
const ptKey = (x: number, y: number, z: number): string => `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`

const HULL_MEMO = new Map<string, StaticHull[]>()

/**
 * Every `collision: 'hull'` submesh a function part contributes, as part-local hull points in authored
 * order. Empty for a part with no such submeshes (every part authored before the channel existed).
 * Memoized on (package, resolved params) like {@link functionStaticWalls}; the returned array is shared/cached
 * - do not mutate it.
 *
 * Two deliberate differences from the wall enumeration, both because a hull is a shape and never a mergeable
 * wall: `key` indexes the authored submesh (so a sibling toggling its collision doesn't renumber the hulls),
 * and no `extents` are folded in - snap extents only exist to reach a merged host's wall plane.
 */
export function functionStaticHulls(part: PartInstance, pkg: PartPackage): StaticHull[] {
  const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
  const memoKey = `${pkg.id}@${packageRev(pkg.id)}|${JSON.stringify(params)}`
  const hit = HULL_MEMO.get(memoKey)
  if (hit) return hit
  const meshParts = evalPartGeometry(pkg.behavior, params, { partId: part.id, packageId: pkg.id })
  const out: StaticHull[] = []
  let i = 0
  for (const mp of meshParts ?? []) {
    const key = `fnhull:${i++}`
    if (mp.collision !== 'hull') continue
    const pos = mp.desc.positions
    const seen = new Set<string>()
    const points: { x: number; y: number; z: number }[] = []
    for (let p = 0; p + 2 < pos.length; p += 3) {
      const x = pos[p]!, y = pos[p + 1]!, z = pos[p + 2]!
      const k = ptKey(x, y, z)
      if (seen.has(k)) continue
      seen.add(k)
      points.push({ x, y, z })
    }
    if (points.length < 4) continue // fewer than a tetrahedron's worth: no volume to collide
    const facts = { ...(mp.finish !== undefined ? { finish: mp.finish } : {}), ...(mp.friction !== undefined ? { friction: mp.friction } : {}) }
    if (points.length > HULL_MAX_POINTS) {
      const bb = aabbOf(pos)
      if (!bb) continue
      const corners: { x: number; y: number; z: number }[] = []
      for (const x of [bb.minX, bb.maxX]) for (const y of [bb.minY, bb.maxY]) for (const z of [bb.minZ, bb.maxZ]) corners.push({ x, y, z })
      out.push({ key, ...facts, points: corners })
      continue
    }
    out.push({ key, ...facts, points })
  }
  if (HULL_MEMO.size >= WALL_MEMO_MAX) HULL_MEMO.clear()
  HULL_MEMO.set(memoKey, out)
  return out
}
