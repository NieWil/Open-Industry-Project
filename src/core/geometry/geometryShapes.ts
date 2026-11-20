// The builder's solid-shape ops: `g.bevelBox`, `g.lathe`, `g.extrude`, `g.transform` (docs/part-authoring-guide.md,
// "Code or a model?"). They let a part describe engineered hardware (a chamfered housing, a turned knob, a slotted
// plate with holes) as the handful of numbers a drawing gives, instead of hand-winding triangles in `g.surface()`.
// Each returns an ordinary MeshDescription, so they compose with `merge` and every other op.
//
// Shading is decided by vertex sharing, because the host derives normals from the triangles: a flat face gets
// vertices of its own (hard edges), and the round bands of a lathe share their ring vertices (smooth around,
// creased between bands). Winding is decided per face against the face's known outward normal, so the ops are
// right by construction rather than by the caller's vertex order.
//
// Pure + deterministic, budget-capped like the rest of the builder (meshDescription GeometryBudgetError).

import type { MeshDescription } from '../parts/partApi'
import { GeometryBudgetError, MAX_DESCRIPTION_VERTICES } from './meshDescription'

type V2 = readonly [number, number]
type V3 = readonly [number, number, number]
/** the axis a lathe turns about / an extrusion runs along */
export type ShapeAxis = 'x' | 'y' | 'z'
/** a box face: its axis and side */
export type BoxFace = 'x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+'

const newell = (pts: readonly V3[]): V3 => {
  let x = 0, y = 0, z = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!
    x += (a[1] - b[1]) * (a[2] + b[2])
    y += (a[2] - b[2]) * (a[0] + b[0])
    z += (a[0] - b[0]) * (a[1] + b[1])
  }
  return [x, y, z]
}
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const area2 = (p: readonly V2[]): number => {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!, b = p[(i + 1) % p.length]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

/** positions/uvs/indices under construction, budget-checked per vertex */
class Acc {
  readonly positions: number[] = []
  readonly uvs: number[] = []
  readonly indices: number[] = []
  vertex(p: V3, u = 0, v = 0): number {
    const i = this.positions.length / 3
    if (i >= MAX_DESCRIPTION_VERTICES) throw new GeometryBudgetError(i + 1)
    this.positions.push(p[0], p[1], p[2])
    this.uvs.push(u, v)
    return i
  }
  /** a flat convex polygon on vertices of its own, wound to face `n`; a collapsed one is skipped */
  polygon(pts: readonly V3[], n: V3, uv?: (p: V3) => V2): void {
    const m = newell(pts)
    if (dot(m, m) < 1e-24) return
    const ids = pts.map((p) => { const t = uv ? uv(p) : ([0, 0] as V2); return this.vertex(p, t[0], t[1]) })
    if (dot(m, n) < 0) ids.reverse()
    for (let i = 1; i + 1 < ids.length; i++) this.indices.push(ids[0]!, ids[i]!, ids[i + 1]!)
  }
  /** a flat face given as points + triangles (a triangulated concave or holed face), wound to face `n` */
  triangles(pts: readonly V3[], tris: readonly (readonly [number, number, number])[], n: V3, uv?: (p: V3) => V2): void {
    const ids = pts.map((p) => { const t = uv ? uv(p) : ([0, 0] as V2); return this.vertex(p, t[0], t[1]) })
    for (const [a, b, c] of tris) {
      const m = newell([pts[a]!, pts[b]!, pts[c]!])
      if (dot(m, m) < 1e-24) continue
      if (dot(m, n) >= 0) this.indices.push(ids[a]!, ids[b]!, ids[c]!)
      else this.indices.push(ids[a]!, ids[c]!, ids[b]!)
    }
  }
  build(): MeshDescription {
    return { positions: this.positions, uvs: this.uvs, indices: this.indices }
  }
}

// ---- bevelBox ---------------------------------------------------------------------------------------------

/**
 * An axis-aligned box with every edge chamfered by `bevel`: 6 faces, 12 edge strips, 8 corner triangles, all flat.
 * An edge is chamfered only where both of its faces are; `square` names faces that meet a neighbour flush (a
 * housing sitting on a slab), so their edges stay square instead of cutting a groove the real part doesn't have.
 */
export function bevelBoxDescription(size: V3, center: V3, bevel: number, square: readonly BoxFace[] = []): MeshDescription {
  const acc = new Acc()
  const lo = [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2]
  const hi = [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2]
  const b = Math.max(0, Math.min(bevel, size[0] / 2, size[1] / 2, size[2] / 2))
  const bev = (k: number, s: number): boolean => !square.includes(`${'xyz'[k]}${s > 0 ? '+' : '-'}` as BoxFace)
  // the corner at signs s on the face of axis a: full extent along a, inset along each axis whose edge with it is chamfered
  const V = (a: number, s: readonly number[]): V3 => {
    const q = [0, 0, 0]
    for (let k = 0; k < 3; k++) {
      const e = s[k]! > 0 ? hi[k]! : lo[k]!
      q[k] = k === a || !bev(a, s[a]!) || !bev(k, s[k]!) ? e : e - s[k]! * b
    }
    return [q[0]!, q[1]!, q[2]!]
  }
  const out = (pts: readonly V3[]): V3 => {
    const m = [0, 0, 0]
    for (const p of pts) for (let k = 0; k < 3; k++) m[k]! += (p[k]! - center[k]!) / pts.length
    return [m[0]!, m[1]!, m[2]!]
  }
  const sg = (a: number, sa: number, c: number, sc: number, d: number, sd: number): number[] => {
    const q = [0, 0, 0]
    q[a] = sa; q[c] = sc; q[d] = sd
    return q
  }
  for (let a = 0; a < 3; a++) {
    const c = (a + 1) % 3, d = (a + 2) % 3
    for (const sa of [-1, 1]) {
      // the face's outline, corner by corner round it. A square face runs out to the box's edges, but at a corner
      // where the other two faces' shared edge is chamfered, that chamfer notches it: two points instead of one.
      const f: V3[] = []
      for (const [sc, sd] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const s = sg(a, sa, c, sc, d, sd)
        if (!bev(a, sa) && bev(c, sc) && bev(d, sd) && b > 0) {
          // walking c then d round the face: the notch point on the d side comes first when moving along +c... keep
          // them in perimeter order by which neighbour the walk arrives from
          const onC = V(c, s), onD = V(d, s)
          const arriveAlongC = (sc === 1 && sd === -1) || (sc === -1 && sd === 1)
          if (arriveAlongC) f.push(onD, onC)
          else f.push(onC, onD)
        } else f.push(V(a, s))
      }
      acc.polygon(f, out(f), (p) => [p[c]!, p[d]!])
      for (const sc of [-1, 1]) {
        const e = [V(a, sg(a, sa, c, sc, d, -1)), V(a, sg(a, sa, c, sc, d, 1)), V(c, sg(a, sa, c, sc, d, 1)), V(c, sg(a, sa, c, sc, d, -1))]
        acc.polygon(e, out(e))
      }
    }
  }
  for (let n = 0; n < 8; n++) {
    const s = [n & 1 ? 1 : -1, n & 2 ? 1 : -1, n & 4 ? 1 : -1]
    // a corner triangle only where all three faces are chamfered; next to a square face that area is the notch
    if (!bev(0, s[0]!) || !bev(1, s[1]!) || !bev(2, s[2]!)) continue
    const t = [V(0, s), V(1, s), V(2, s)]
    acc.polygon(t, out(t))
  }
  return acc.build()
}

// ---- lathe ------------------------------------------------------------------------------------------------

export interface LatheOptions {
  /** facets around the axis (default 16) */
  segments?: number
  /** the axis turned about (default 'y') */
  axis?: ShapeAxis
  /** a point on the axis (default the origin) */
  center?: V3
  /** angle of the first facet vertex, radians (default 0) */
  startAngle?: number
  /** round within each profile segment (default true); false = flat facets, e.g. a hex bolt head */
  smooth?: boolean
}

/**
 * A surface of revolution from a profile of `[radius, height]` pairs (height measured along the axis from
 * `center`). Walk the profile with the outside on your right (radius to the right, height up): up an outer wall,
 * inward across a top face, down an inner bore. A point with radius 0 closes that end: flat if its neighbour is
 * at the same height (a cap), pointed otherwise (a cone tip). Round within each segment, creased between them.
 * Facet angles, with a the facet angle: axis 'z' puts radius r at (r·cos a, r·sin a); 'y' at (r·cos a, ·, r·sin a);
 * 'x' at (·, r·cos a, r·sin a).
 */
export function latheDescription(profile: readonly V2[], opts: LatheOptions = {}): MeshDescription {
  const acc = new Acc()
  const N = Math.max(3, Math.floor(opts.segments ?? 16))
  const axis = opts.axis ?? 'y'
  const c = opts.center ?? [0, 0, 0]
  const a0 = opts.startAngle ?? 0
  const smooth = opts.smooth !== false
  const place = (r: number, h: number, k: number): V3 => {
    const a = a0 + ((k % N) * 2 * Math.PI) / N // facet N is facet 0 exactly: the seam closes with no float gap
    const u = r * Math.cos(a), w = r * Math.sin(a)
    return axis === 'z' ? [c[0] + u, c[1] + w, c[2] + h] : axis === 'y' ? [c[0] + u, c[1] + h, c[2] + w] : [c[0] + h, c[1] + u, c[2] + w]
  }
  const normal = (nr: number, nh: number, k: number): V3 => {
    const a = a0 + (k * 2 * Math.PI) / N
    const u = nr * Math.cos(a), w = nr * Math.sin(a)
    return axis === 'z' ? [u, w, nh] : axis === 'y' ? [u, nh, w] : [nh, u, w]
  }
  // v runs along the profile, 0..1 by arc length; u around the axis
  let total = 0
  for (let i = 0; i + 1 < profile.length; i++) total += Math.hypot(profile[i + 1]![0] - profile[i]![0], profile[i + 1]![1] - profile[i]![1])
  let run = 0
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, h0] = profile[i]!, [r1, h1] = profile[i + 1]!
    const dr = r1 - r0, dh = h1 - h0
    const len = Math.hypot(dr, dh)
    const v0 = total > 0 ? run / total : 0
    run += len
    const v1 = total > 0 ? run / total : 0
    if (len < 1e-12 || (r0 <= 0 && r1 <= 0)) continue
    const nr = dh / len, nh = -dr / len // outward: the right-hand side of the walk
    if ((r0 <= 0 || r1 <= 0) && Math.abs(dh) < 1e-12) {
      // a flat cap: the ring at the non-zero radius
      const r = Math.max(r0, r1), h = r0 > 0 ? h0 : h1
      const ring: V3[] = []
      for (let k = 0; k < N; k++) ring.push(place(r, h, k))
      acc.polygon(ring, normal(0, nh, 0))
      continue
    }
    if (smooth) {
      const ring0: number[] = [], ring1: number[] = []
      for (let k = 0; k < N; k++) {
        ring0.push(acc.vertex(place(r0, h0, k), k / N, v0))
        ring1.push(acc.vertex(place(r1, h1, k), k / N, v1))
      }
      // wind by the first quad against its outward normal; every quad of the band winds the same way
      const q = [place(r0, h0, 0), place(r0, h0, 1), place(r1, h1, 1), place(r1, h1, 0)]
      const fwd = dot(newell(r0 > 0 && r1 > 0 ? q : r0 > 0 ? [q[0]!, q[1]!, q[2]!] : [q[0]!, q[2]!, q[3]!]), normal(nr, nh, 0.5)) >= 0
      for (let k = 0; k < N; k++) {
        const A = ring0[k]!, B = ring0[(k + 1) % N]!, C = ring1[(k + 1) % N]!, D = ring1[k]!
        const tri = (x: number, y: number, z: number): void => { if (fwd) acc.indices.push(x, y, z); else acc.indices.push(x, z, y) }
        if (r0 > 0) tri(A, B, C)
        if (r1 > 0) tri(A, C, D)
      }
    } else {
      for (let k = 0; k < N; k++) {
        const pts = [place(r0, h0, k), place(r0, h0, k + 1), place(r1, h1, k + 1), place(r1, h1, k)]
        acc.polygon(r0 <= 0 ? [pts[0]!, pts[2]!, pts[3]!] : r1 <= 0 ? [pts[0]!, pts[1]!, pts[2]!] : pts, normal(nr, nh, k + 0.5))
      }
    }
  }
  return acc.build()
}

/**
 * A closed round cylinder of `radius` and full `height`, centred at `center` along `axis` (default 'y'): flat caps,
 * smooth wall. The lathe of the obvious profile, here because it is the cutter a bore or a pin hole needs most.
 */
export function cylinderDescription(radius: number, height: number, center: V3 = [0, 0, 0], opts: { axis?: ShapeAxis; segments?: number } = {}): MeshDescription {
  const h = height / 2
  return latheDescription([[0, -h], [radius, -h], [radius, h], [0, h]], { axis: opts.axis, segments: opts.segments ?? 24, center })
}

// ---- extrude ----------------------------------------------------------------------------------------------

export interface ExtrudeOptions {
  /** the axis the outline is extruded along (default 'z'); the outline's (a, b) span the other two, in x, y, z order */
  axis?: ShapeAxis
  /** holes through the plate, each a simple polygon inside the outline (their walls stay square) */
  holes?: readonly (readonly V2[])[]
  /** chamfer on the outline's edges, both faces (default 0) */
  bevel?: number
  /** outline edges left square (edge i runs outline[i] → outline[i+1]) - where the plate meets a neighbour flush */
  square?: readonly number[]
}

const lineMeet = (p: V2, d: V2, q: V2, e: V2): V2 => {
  const den = d[0] * e[1] - d[1] * e[0]
  if (Math.abs(den) < 1e-15) return p
  const s = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
  return [p[0] + s * d[0], p[1] + s * d[1]]
}

/**
 * A flat plate: the 2-D `outline` (any simple polygon, concave allowed) extruded from `from` to `to` along the
 * axis, with optional `holes` and an edge `bevel`. Faces are flat, walls face out of the solid (into a hole).
 */
export function extrudeDescription(outline: readonly V2[], from: number, to: number, opts: ExtrudeOptions = {}): MeshDescription {
  const acc = new Acc()
  const axis = opts.axis ?? 'z'
  const put = (a: number, b: number, h: number): V3 => (axis === 'z' ? [a, b, h] : axis === 'y' ? [a, h, b] : [h, a, b])
  const dir = (a: number, b: number, h: number): V3 => put(a, b, h)
  const z0 = Math.min(from, to), z1 = Math.max(from, to)
  const flip = area2(outline) < 0
  const p = flip ? [...outline].reverse() : [...outline]
  const n = p.length
  const sq = new Set((opts.square ?? []).map((i) => (flip ? (((n - 2 - i) % n) + n) % n : i)))
  const b = Math.max(0, Math.min(opts.bevel ?? 0, (z1 - z0) / 2))
  const dirs = p.map((a, i) => {
    const c = p[(i + 1) % n]!
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1
    return [(c[0] - a[0]) / l, (c[1] - a[1]) / l] as V2
  })
  // each edge's line pulled inward (left of a counter-clockwise walk) by its chamfer
  const inset: V2[] = p.map((_, i) => {
    const prev = (i - 1 + n) % n
    const off = (k: number): V2 => {
      const w = sq.has(k) ? 0 : b
      return [p[k]![0] - dirs[k]![1] * w, p[k]![1] + dirs[k]![0] * w]
    }
    return lineMeet(off(prev), dirs[prev]!, off(i), dirs[i]!)
  })
  const holes = (opts.holes ?? []).map((h) => (area2(h) > 0 ? [...h].reverse() : [...h])) // clockwise
  // walls: face the right-hand side of the walk (out of a counter-clockwise outline, into a clockwise hole)
  const wall = (a: V2, c: V2, h0: number, h1: number): void => {
    const nx = c[1] - a[1], ny = -(c[0] - a[0])
    acc.polygon([put(a[0], a[1], h0), put(c[0], c[1], h0), put(c[0], c[1], h1), put(a[0], a[1], h1)], dir(nx, ny, 0))
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const a = p[i]!, c = p[j]!, ia = inset[i]!, ic = inset[j]!
    wall(a, c, z0 + b, z1 - b)
    if (b > 0) {
      const outN: V3 = [dirs[i]![1], -dirs[i]![0], 0]
      for (const [zr, zc, s] of [[z1 - b, z1, 1], [z0 + b, z0, -1]] as const) {
        const q = [put(a[0], a[1], zr), put(c[0], c[1], zr), put(ic[0], ic[1], zc), put(ia[0], ia[1], zc)]
        const m = newell(q)
        const want = dir(outN[0], outN[1], s)
        acc.polygon(q, dot(m, want) >= 0 ? m : [-m[0], -m[1], -m[2]])
      }
    }
  }
  for (const h of holes) for (let i = 0; i < h.length; i++) wall(h[i]!, h[(i + 1) % h.length]!, z0, z1)
  const { points, triangles } = triangulateWithHoles(inset, holes)
  for (const [h, s] of [[z1, 1], [z0, -1]] as const) {
    acc.triangles(points.map((q) => put(q[0], q[1], h)), triangles, dir(0, 0, s), (q) => {
      const ab = axis === 'z' ? [q[0], q[1]] : axis === 'y' ? [q[0], q[2]] : [q[1], q[2]]
      return [ab[0]!, ab[1]!]
    })
  }
  return acc.build()
}

/**
 * Triangulate a counter-clockwise outline with clockwise holes: each hole is joined to the outline by a slit
 * (the classic bridge), then the single resulting polygon is ear-clipped. Returns the points used (the outline,
 * then each hole, with the bridge endpoints repeated) and triangles indexing them.
 */
export function triangulateWithHoles(outline: readonly V2[], holes: readonly (readonly V2[])[]): { points: V2[]; triangles: [number, number, number][] } {
  let poly: V2[] = [...outline]
  const segsCross = (p1: V2, p2: V2, q1: V2, q2: V2): boolean => {
    const o = (a: V2, b: V2, c: V2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    const d1 = o(q1, q2, p1), d2 = o(q1, q2, p2), d3 = o(p1, p2, q1), d4 = o(p1, p2, q2)
    return ((d1 > 1e-15 && d2 < -1e-15) || (d1 < -1e-15 && d2 > 1e-15)) && ((d3 > 1e-15 && d4 < -1e-15) || (d3 < -1e-15 && d4 > 1e-15))
  }
  const pending = holes.map((h) => [...h]).sort((A, B) => Math.max(...B.map((q) => q[0])) - Math.max(...A.map((q) => q[0])))
  for (let hi = 0; hi < pending.length; hi++) {
    const hole = pending[hi]!
    let j = 0
    for (let k = 1; k < hole.length; k++) if (hole[k]![0] > hole[j]![0]) j = k
    const H = hole[j]!
    const others = pending.slice(hi + 1)
    let best = -1, bestD = Infinity
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i]!
      const d = Math.hypot(P[0] - H[0], P[1] - H[1])
      if (d >= bestD) continue
      let blocked = false
      const edges = (ring: readonly V2[]): void => {
        for (let k = 0; k < ring.length && !blocked; k++) if (segsCross(H, P, ring[k]!, ring[(k + 1) % ring.length]!)) blocked = true
      }
      edges(poly)
      edges(hole)
      for (const o of others) edges(o)
      if (!blocked) { best = i; bestD = d }
    }
    if (best < 0) continue // no clear bridge (a hole outside the outline): leave it out of the face
    const loop = [...hole.slice(j), ...hole.slice(0, j), H]
    poly = [...poly.slice(0, best + 1), ...loop, poly[best]!, ...poly.slice(best + 1)]
  }
  return { points: poly, triangles: earClip(poly) }
}

/** ear clipping for a counter-clockwise polygon that may touch itself at bridge points (repeated coordinates) */
function earClip(poly: readonly V2[]): [number, number, number][] {
  const cross = (o: V2, a: V2, b: V2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const same = (a: V2, b: V2): boolean => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12
  const idx = poly.map((_, i) => i)
  const out: [number, number, number][] = []
  let guard = 0
  while (idx.length > 3 && guard++ < poly.length * poly.length * 2) {
    let clipped = false
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length]!, ib = idx[k]!, ic = idx[(k + 1) % idx.length]!
      const A = poly[ia]!, B = poly[ib]!, C = poly[ic]!
      const c = cross(A, B, C)
      if (c <= 1e-18) {
        // collinear or reflex; a zero-area sliver (a bridge's doubled edge) is dropped rather than kept as an ear
        if (Math.abs(c) <= 1e-18 && (same(A, C) || same(A, B) || same(B, C))) { idx.splice(k, 1); clipped = true; break }
        continue
      }
      let blocked = false
      for (const q of idx) {
        if (q === ia || q === ib || q === ic) continue
        const Q = poly[q]!
        if (same(Q, A) || same(Q, B) || same(Q, C)) continue
        if (cross(A, B, Q) >= 0 && cross(B, C, Q) >= 0 && cross(C, A, Q) >= 0) { blocked = true; break }
      }
      if (blocked) continue
      out.push([ia, ib, ic])
      idx.splice(k, 1)
      clipped = true
      break
    }
    if (!clipped) break // not a simple polygon: stop rather than emit crossing triangles
  }
  if (idx.length === 3 && cross(poly[idx[0]!]!, poly[idx[1]!]!, poly[idx[2]!]!) > 1e-18) out.push([idx[0]!, idx[1]!, idx[2]!])
  return out
}

// ---- transform --------------------------------------------------------------------------------------------

/**
 * Scale, rotate, then translate a description - author in whatever units and orientation a drawing gives, map
 * once. `rotate` is a unit quaternion [x, y, z, w] (a turn never flips a face). Scales must be positive: a negative
 * one mirrors, which reverses every face's winding (build the mirrored piece directly, or turn it half round).
 */
export function transformDescription(desc: MeshDescription, opts: { scale?: number | V3; rotate?: readonly [number, number, number, number]; translate?: V3 }): MeshDescription {
  const s: V3 = typeof opts.scale === 'number' ? [opts.scale, opts.scale, opts.scale] : (opts.scale ?? [1, 1, 1])
  if (!(s[0] > 0 && s[1] > 0 && s[2] > 0)) throw new Error('transform: scale must be positive (a mirror would turn every face inside out)')
  const t = opts.translate ?? [0, 0, 0]
  let [qx, qy, qz, qw] = opts.rotate ?? [0, 0, 0, 1]
  const ql = Math.hypot(qx, qy, qz, qw) || 1
  qx /= ql; qy /= ql; qz /= ql; qw /= ql
  // filled, not holey: writing into holes is ~25x slower once Array.prototype is frozen (SES lockdown)
  const positions: number[] = new Array(desc.positions.length).fill(0)
  for (let i = 0; i < desc.positions.length; i += 3) {
    const x = desc.positions[i]! * s[0], y = desc.positions[i + 1]! * s[1], z = desc.positions[i + 2]! * s[2]
    // v' = v + 2w(q × v) + 2 q × (q × v)
    const cx = qy * z - qz * y, cy = qz * x - qx * z, cz = qx * y - qy * x
    positions[i] = x + 2 * (qw * cx + qy * cz - qz * cy) + t[0]
    positions[i + 1] = y + 2 * (qw * cy + qz * cx - qx * cz) + t[1]
    positions[i + 2] = z + 2 * (qw * cz + qx * cy - qy * cx) + t[2]
  }
  return { positions, uvs: [...desc.uvs], indices: [...desc.indices] }
}
