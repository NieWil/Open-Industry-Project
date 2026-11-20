// A portable, three.js-shaped mesh description: the output of the geometry-function tier
// (docs/procedural-geometry.md). It is plain data computed by deterministic core code: flat vertex
// buffers a host turns into a three.js BufferGeometry (web) without the part ever touching three.js.
// It is in `core/` (no three import) so the same description can feed render, physics/collision,
// snapping, and export, not just the renderer.
//
// The core op here is the sweep (`sweepProfileAlongPath`, `sweepProfileAlongX`) that reproduces a swept
// conveyor bed. The schema is intentionally thin (flat buffers, three.js conventions) because there's no
// need for an abstract cross-engine IR (see the doc).

// The MeshDescription type is defined in partApi.ts (the part-authoring SDK surface: the geometry tier's
// output is part-facing data, and the SDK generator lifts only partApi). Re-exported here so the geometry ops that
// produce it, and their existing importers, keep a single import site.
export type { MeshDescription } from '../parts/partApi'
import type { MeshDescription } from '../parts/partApi'

/** Hard ceiling on one description's vertices, the geometry analogue of the determinism guard and the
 *  per-tick spawn caps: a runaway geometry function can't allocate without bound. Tune as real parts arrive. */
export const MAX_DESCRIPTION_VERTICES = 200_000

/** Thrown when a geometry op would exceed {@link MAX_DESCRIPTION_VERTICES}. */
export class GeometryBudgetError extends Error {
  constructor(requested: number) {
    super(`geometry exceeds the vertex budget: ${requested} > ${MAX_DESCRIPTION_VERTICES}`)
    this.name = 'GeometryBudgetError'
  }
}

/** A 3-D point on a sweep path (metres, part-local). */
export type Vec3 = readonly [number, number, number]

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const length3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
const normalize = (a: Vec3): Vec3 => {
  const l = length3(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const WORLD_UP: Vec3 = [0, 1, 0]

/**
 * Loft a closed 2-D cross-section profile along an arbitrary 3-D `path`: the conveyor-bed primitive
 * (extrude a belt/frame/guard section down the part's length, straight, inclined or curved). `profile`
 * is the section as `[u, w]` pairs ordered CCW, where `u` is the cross-section's up offset (thickness /
 * height) and `w` is its width offset; `path` is the bed centreline as ≥2 points.
 *
 * At each station the section is oriented by a path-aligned frame: tangent `T` (the path direction),
 * width axis `W = normalize(T × worldUp)` (kept horizontal so the deck never banks), and up axis
 * `U = W × T` (tilts with an incline, perpendicular to the deck). A profile point `[pu, pw]` goes to
 * `centre + pu·U + pw·W`. Quads bridge consecutive rings; the ends stay open unless `opts.caps` (a belt bed
 * is open-ended, its end-drum wrap handled separately). `u` runs along normalized arc length, `v` around the
 * profile.
 *
 * Pure + deterministic. Throws {@link GeometryBudgetError} rather than allocate past the budget. A near-
 * vertical tangent (a conveyor never does this) falls back to a +Z width reference to avoid a degenerate
 * frame; `opts.frame: 'transport'` is the frame for a path that does climb vertically (a pipe riser).
 */
export function sweepProfileAlongPath(
  profile: ReadonlyArray<readonly [number, number]>,
  path: readonly Vec3[],
  opts?: SweepOptions,
): MeshDescription {
  if (profile.length < 3) throw new Error('sweepProfileAlongPath: profile needs ≥3 points (a closed section)')
  if (path.length < 2) throw new Error('sweepProfileAlongPath: need ≥2 stations to sweep between')
  return loftSectionsAlongPath(() => profile, profile.length, path, opts)
}

/**
 * {@link sweepProfileAlongPath} with a cross-section that changes along the path: a hopper narrowing to its
 * throat, a round-to-square duct transition, a tapered arm. `sections` is either one section per path station,
 * or exactly two (the first at the start, the last at the end, blended by arc length between). Every section
 * has the same number of points, and point j of one section joins point j of the next, so start each at the
 * matching place (a round-to-square transition puts its circle's points where the square's corners and edges
 * are). A section may shrink to a single repeated point (a cone tip). Orientation, caps and uvs are the sweep's.
 */
export function loftSections(
  sections: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  path: readonly Vec3[],
  opts?: SweepOptions,
): MeshDescription {
  const n = path.length
  if (n < 2) throw new Error('loft: need ≥2 stations to loft between')
  if (sections.length !== n && sections.length !== 2) {
    throw new Error(`loft: give one section per path station (${n}) or two (start and end), not ${sections.length}`)
  }
  const m = sections[0]!.length
  if (m < 3) throw new Error('loft: a section needs ≥3 points (a closed section)')
  for (const s of sections) if (s.length !== m) throw new Error(`loft: every section needs the same number of points (${m}); point j of one joins point j of the next`)
  if (sections.length === n) return loftSectionsAlongPath((i) => sections[i]!, m, path, opts)
  // two sections: blend by arc length, so stations bunched on a bend don't bunch the taper
  const arc: number[] = [0]
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1]! + length3(sub(path[i]!, path[i - 1]!))
  const total = arc[n - 1]! || 1
  const a = sections[0]!, b = sections[1]!
  return loftSectionsAlongPath((i) => {
    const t = arc[i]! / total
    return a.map((p, j) => [p[0] + (b[j]![0] - p[0]) * t, p[1] + (b[j]![1] - p[1]) * t] as const)
  }, m, path, opts)
}

/** the swept-frame width axis at each station: kept level, or carried along the path without twisting */
function sectionWidthAxes(path: readonly Vec3[], tangentAt: (i: number) => Vec3, frame: 'level' | 'transport'): Vec3[] {
  const n = path.length
  const level = (t: Vec3): Vec3 => {
    let w = cross(t, WORLD_UP)
    if (length3(w) < 1e-6) w = cross(t, [0, 0, 1]) // near-vertical fallback (conveyors never hit this)
    return normalize(w)
  }
  if (frame === 'level') return path.map((_, i) => level(tangentAt(i)))
  // rotation-minimising frame by double reflection (Wang, Jüttler, Zheng, Liu 2008): start level, then carry the
  // width axis station to station with the least turn, so a path that bends up to vertical neither flips nor twists
  const out: Vec3[] = [level(tangentAt(0))]
  for (let i = 0; i + 1 < n; i++) {
    const r = out[i]!, t = tangentAt(i), t1 = tangentAt(i + 1)
    const v1 = sub(path[i + 1]!, path[i]!)
    const c1 = dot(v1, v1)
    if (c1 < 1e-24) { out.push(r); continue }
    const rL = sub(r, scale3(v1, (2 / c1) * dot(v1, r)))
    const tL = sub(t, scale3(v1, (2 / c1) * dot(v1, t)))
    const v2 = sub(t1, tL)
    const c2 = dot(v2, v2)
    const w = c2 < 1e-24 ? rL : sub(rL, scale3(v2, (2 / c2) * dot(v2, rL)))
    // re-orthogonalise against the tangent so rounding can't drift the frame over a long path
    out.push(normalize(sub(w, scale3(t1, dot(w, t1)))))
  }
  return out
}

/** the turn (radians) past which a section corner is a hard edge; a 12-sided tube turns 30° and stays smooth */
const CREASE_TURN = (40 * Math.PI) / 180

/** which section points are hard edges: a corner counts when it turns past CREASE_TURN at any station whose two
 *  edges there have length (a loft's cone tip has none) */
function sharpCorners(sectionAt: (i: number) => ReadonlyArray<readonly [number, number]>, m: number, n: number): boolean[] {
  const cosLimit = Math.cos(CREASE_TURN)
  const sharp: boolean[] = new Array<boolean>(m).fill(false)
  for (let i = 0; i < n; i++) {
    const s = sectionAt(i)
    for (let j = 0; j < m; j++) {
      if (sharp[j]) continue
      const a = s[(j + m - 1) % m]!, b = s[j]!, c = s[(j + 1) % m]!
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1]
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy)
      if (lu < 1e-12 || lv < 1e-12) continue
      if ((ux * vx + uy * vy) / (lu * lv) < cosLimit) sharp[j] = true
    }
  }
  return sharp
}

/** the shared body of sweep and loft: `sectionAt(i)` is station i's section, each `m` points */
function loftSectionsAlongPath(
  sectionAt: (i: number) => ReadonlyArray<readonly [number, number]>,
  m: number,
  path: readonly Vec3[],
  opts?: SweepOptions,
): MeshDescription {
  const n = path.length
  const caps = opts?.caps === true
  // A section corner that turns more than CREASE_TURN is a hard edge: each edge leaving it gets a vertex of its own,
  // so the host's averaged normals never blend two faces of an angular section. Shared corners smoothed a flat guard
  // face into a light/dark wedge on a bend, where the stations fan out unevenly. A round section (16+ sides) turns
  // less per corner and stays smooth.
  const sharp = sharpCorners(sectionAt, m, n)
  // ring layout: point j's vertex for the edge arriving at it is inV[j], for the edge leaving it outV[j]
  const inV: number[] = []
  const outV: number[] = []
  let ringSize = 0
  for (let j = 0; j < m; j++) {
    inV.push(ringSize)
    if (sharp[j]) ringSize++
    outV.push(ringSize)
    ringSize++
  }
  const vertCount = ringSize * n + (caps ? 2 * m : 0)
  if (vertCount > MAX_DESCRIPTION_VERTICES) throw new GeometryBudgetError(vertCount)

  // tangent at a station: the adjacent segment at an end, the central difference in the interior
  const tangentAt = (i: number): Vec3 =>
    normalize(i === 0 ? sub(path[1]!, path[0]!) : i === n - 1 ? sub(path[n - 1]!, path[n - 2]!) : sub(path[i + 1]!, path[i - 1]!))
  const widths = sectionWidthAxes(path, tangentAt, opts?.frame ?? 'level')

  // cumulative arc length → a uniform u, so texture density doesn't bunch on a curve
  const arc: number[] = [0]
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1]! + length3(sub(path[i]!, path[i - 1]!))
  const total = arc[n - 1]! || 1

  const positions: number[] = []
  const uvs: number[] = []
  const ends: ReadonlyArray<readonly [number, number]>[] = []
  for (let i = 0; i < n; i++) {
    const profile = sectionAt(i)
    if (i === 0 || i === n - 1) ends.push(profile)
    // v runs along the cross-section perimeter arc-length (not the index j/m), so a wide flat deck gets a
    // proportionally wide v-band and a texture maps by real distance around the profile, as a belt fabric needs.
    const vAt: number[] = []
    let perim = 0
    for (let j = 0; j < m; j++) {
      vAt.push(perim)
      const a = profile[j]!
      const b = profile[(j + 1) % m]!
      perim += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    const vTotal = perim || 1
    const c = path[i]!
    const t = tangentAt(i)
    const w = widths[i]!
    const up = cross(w, t) // unit: w ⊥ t, both unit
    const u = arc[i]! / total
    for (let j = 0; j < m; j++) {
      const pu = profile[j]![0]
      const pw = profile[j]![1]
      const x = c[0] + up[0] * pu + w[0] * pw, y = c[1] + up[1] * pu + w[1] * pw, z = c[2] + up[2] * pu + w[2] * pw
      for (let k = sharp[j] ? 2 : 1; k > 0; k--) {
        positions.push(x, y, z)
        uvs.push(u, vAt[j]! / vTotal)
      }
    }
  }
  // quads between consecutive rings; the profile is closed, so j wraps modulo m
  const indices: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * ringSize
    const b = (i + 1) * ringSize
    for (let j = 0; j < m; j++) {
      const p0 = outV[j]!
      const p1 = inV[(j + 1) % m]!
      // two CCW triangles per quad: (a+p0, a+p1, b+p1) and (a+p0, b+p1, b+p0)
      indices.push(a + p0, a + p1, b + p1, a + p0, b + p1, b + p0)
    }
  }
  if (caps) {
    // each end closed by the section itself, on vertices of its own so it shades flat instead of averaging
    // with the walls. Wound so its normal faces out of the solid: back along the path at the start, on along
    // it at the end.
    const cap = (ring: number, profile: ReadonlyArray<readonly [number, number]>, outward: Vec3): void => {
      const tris = triangulatePolygon(profile)
      // the facing summed over the whole section, so a sliver first triangle can't decide it; a section shrunk
      // to a point (a loft's cone tip) has nothing to close
      const at = (k: number): number => (ring * ringSize + outV[k]!) * 3
      const p = (k: number): Vec3 => [positions[at(k)]!, positions[at(k) + 1]!, positions[at(k) + 2]!]
      let facing = 0
      for (const [a, b, c] of tris) facing += dot(cross(sub(p(b), p(a)), sub(p(c), p(a))), outward)
      if (tris.length === 0 || Math.abs(facing) < 1e-18) return
      const base = positions.length / 3
      for (let j = 0; j < m; j++) {
        const v = at(j)
        positions.push(positions[v]!, positions[v + 1]!, positions[v + 2]!)
        uvs.push(profile[j]![1], profile[j]![0])
      }
      const flip = facing < 0
      for (const [i, j, k] of tris) indices.push(base + i, base + (flip ? k : j), base + (flip ? j : k))
    }
    const t0 = tangentAt(0)
    cap(0, ends[0]!, [-t0[0], -t0[1], -t0[2]])
    cap(n - 1, ends[ends.length - 1]!, tangentAt(n - 1))
  }
  return { positions, indices, uvs }
}

/** Options for {@link sweepProfileAlongPath}. */
export interface SweepOptions {
  /** close both ends with the section itself. Off by default: a belt bed is open-ended (its drum wrap is built
   *  separately) and a piece that continues into another sweep hides its end anyway. Turn it on for anything
   *  that visibly stops (a guard, a frame rail), or its end shows as a hollow tube. */
  caps?: boolean
  /** how the section is oriented along the path. 'level' (the default) keeps its width axis horizontal, so a deck
   *  or a spiral chute never banks; it cannot follow a path that runs vertical. 'transport' starts level and then
   *  carries the section along with the least possible turn: a pipe that bends up into a riser, a coil. */
  frame?: 'level' | 'transport'
}

/**
 * Triangulate a simple (non-self-intersecting) 2-D polygon by ear clipping: indices into `poly`, three per
 * triangle, in the polygon's own winding. Handles concave sections (an L-shaped guard with a top return).
 * O(n^3) worst case, which is nothing at cross-section sizes.
 */
export function triangulatePolygon(poly: ReadonlyArray<readonly [number, number]>): [number, number, number][] {
  const n = poly.length
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!
    area += a[0] * b[1] - b[0] * a[1]
  }
  const ccw = area > 0
  const cross2 = (o: number, a: number, b: number): number => {
    const O = poly[o]!, A = poly[a]!, B = poly[b]!
    const c = (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0])
    return ccw ? c : -c
  }
  const inside = (p: number, a: number, b: number, c: number): boolean =>
    cross2(a, b, p) >= 0 && cross2(b, c, p) >= 0 && cross2(c, a, p) >= 0
  const idx = poly.map((_, i) => i)
  const out: [number, number, number][] = []
  let guard = 0
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length]!, b = idx[k]!, c = idx[(k + 1) % idx.length]!
      if (cross2(a, b, c) <= 0) continue // reflex (or degenerate): not an ear
      let blocked = false
      for (const q of idx) {
        if (q === a || q === b || q === c) continue
        if (inside(q, a, b, c)) { blocked = true; break }
      }
      if (blocked) continue
      out.push([a, b, c])
      idx.splice(k, 1)
      clipped = true
      break
    }
    if (!clipped) break // not a simple polygon: stop rather than emit crossing triangles
  }
  if (idx.length === 3) out.push([idx[0]!, idx[1]!, idx[2]!])
  return out
}

/** The straight case of {@link sweepProfileAlongPath}: sweep the section along the +X axis at the given
 *  stations. The bed runs flat down +X (tangent `+X` → width `+Z`, up `+Y`), so a profile `[y, z]` maps
 *  to `[x, y, z]`. */
export function sweepProfileAlongX(profile: ReadonlyArray<readonly [number, number]>, xs: readonly number[]): MeshDescription {
  return sweepProfileAlongPath(
    profile,
    xs.map((x) => [x, 0, 0] as Vec3),
  )
}

/**
 * The stations for a straight, inclined or curved bed, centred on the local origin facing +X, split
 * into `segments` (≥1, ≤256) spans. Feed to {@link sweepProfileAlongPath}. The path is:
 *   - straight along +X by default;
 *   - inclined `tiltDeg`° about the origin (a climbing belt), which the manifest can't do;
 *   - or (if `arcRadius` > 0) a horizontal arc of that radius with `length` as the arc length, bowing toward
 *     −Z (the curved-conveyor convention), which the manifest can't do either. The arc overrides tilt.
 */
export function sweepBedPath(opts: { length: number; segments?: number; tiltDeg?: number; arcRadius?: number }): Vec3[] {
  const segs = Math.max(1, Math.min(256, Math.floor(opts.segments ?? 1)))
  const length = opts.length
  const out: Vec3[] = []
  const radius = opts.arcRadius ?? 0
  if (radius > 0) {
    // centre at [0, 0, −radius] so a=0 sits at the origin with a +X tangent; the bed bows toward −Z
    const total = length / radius // total sweep angle (rad)
    for (let i = 0; i <= segs; i++) {
      const a = -total / 2 + (total * i) / segs
      out.push([radius * Math.sin(a), 0, radius * (Math.cos(a) - 1)])
    }
    return out
  }
  const tilt = ((opts.tiltDeg ?? 0) * Math.PI) / 180
  const c = Math.cos(tilt)
  const s = Math.sin(tilt)
  for (let i = 0; i <= segs; i++) {
    const t = -length / 2 + (length * i) / segs
    out.push([t * c, t * s, 0])
  }
  return out
}

