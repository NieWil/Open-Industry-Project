// `g.subtract`: cut closed solids out of a closed solid (a bore through a hub, a slot in a housing, a window in a
// guard). A binary-space-partition solid subtraction over the builder's own MeshDescriptions: each solid becomes a
// BSP tree of its polygons, the solid keeps what lies outside every cutter, and each cutter keeps what lies inside
// the solid, turned inside out to line the cut.
//
// Shading survives the cut. The host derives normals from shared vertices (meshDescriptionGeometry.ts), so a lathe's
// round band shares its ring vertices and a flat face has vertices of its own. A cut splits every polygon into
// pieces with vertices of their own, which would facet a turned hub. So each input triangle carries the surface it
// came from (the triangles joined to it through shared vertices) and the output re-welds vertices only within one
// surface: a round band is round again, flat faces stay creased against their neighbours.
//
// Pure + deterministic (fixed split order, no hashing of floats beyond a fixed quantum), iterative rather than
// recursive (a convex solid's tree is as deep as it has faces), and budget-capped like the rest of the builder.

import type { MeshDescription } from '../parts/partApi'
import { GeometryBudgetError, MAX_DESCRIPTION_VERTICES } from './meshDescription'

type V3 = readonly [number, number, number]

/** a point closer than this to a plane lies on it (metres): far below any drawn detail, well above float noise */
const PLANE_EPS = 1e-5
/** vertices of one surface closer than this are welded into one (metres) */
const WELD_QUANTUM = 1e-6
/** polygon fragments one subtraction may create before it is refused, the CSG analogue of the vertex budget */
const MAX_FRAGMENTS = 400_000

interface Vert {
  readonly p: V3
  readonly u: number
  readonly v: number
}
interface Plane {
  readonly n: V3
  readonly w: number
}
interface Poly {
  readonly verts: readonly Vert[]
  readonly plane: Plane
  /** the input surface this piece came from: vertices are welded only within one */
  readonly surface: number
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

const COPLANAR = 0
const FRONT = 1
const BACK = 2
const SPANNING = 3

/** counts fragments across one subtraction, so a pathological pair is refused instead of stalling the tick */
class Budget {
  fragments = 0
  add(k: number): void {
    this.fragments += k
    if (this.fragments > MAX_FRAGMENTS) throw new Error(`subtract: the cut splits into more than ${MAX_FRAGMENTS} pieces; use fewer facets or fewer cutters`)
  }
}

const flipPoly = (p: Poly): Poly => ({
  verts: [...p.verts].reverse(),
  plane: { n: [-p.plane.n[0], -p.plane.n[1], -p.plane.n[2]], w: -p.plane.w },
  surface: p.surface,
})

/** sort `poly` against `plane` into the four lists; a spanning polygon is cut in two along the plane */
function splitPolygon(plane: Plane, poly: Poly, coFront: Poly[], coBack: Poly[], front: Poly[], back: Poly[], budget: Budget): void {
  let polyType = 0
  const types: number[] = []
  for (const vtx of poly.verts) {
    const t = dot(plane.n, vtx.p) - plane.w
    const type = t < -PLANE_EPS ? BACK : t > PLANE_EPS ? FRONT : COPLANAR
    polyType |= type
    types.push(type)
  }
  if (polyType === COPLANAR) (dot(plane.n, poly.plane.n) > 0 ? coFront : coBack).push(poly)
  else if (polyType === FRONT) front.push(poly)
  else if (polyType === BACK) back.push(poly)
  else {
    const f: Vert[] = []
    const b: Vert[] = []
    const n = poly.verts.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ti = types[i]!, tj = types[j]!
      const vi = poly.verts[i]!, vj = poly.verts[j]!
      if (ti !== BACK) f.push(vi)
      if (ti !== FRONT) b.push(vi)
      if ((ti | tj) === SPANNING) {
        const t = (plane.w - dot(plane.n, vi.p)) / dot(plane.n, sub(vj.p, vi.p))
        const mid: Vert = {
          p: [vi.p[0] + (vj.p[0] - vi.p[0]) * t, vi.p[1] + (vj.p[1] - vi.p[1]) * t, vi.p[2] + (vj.p[2] - vi.p[2]) * t],
          u: vi.u + (vj.u - vi.u) * t,
          v: vi.v + (vj.v - vi.v) * t,
        }
        f.push(mid)
        b.push(mid)
      }
    }
    budget.add(1)
    if (f.length >= 3) front.push({ verts: f, plane: poly.plane, surface: poly.surface })
    if (b.length >= 3) back.push({ verts: b, plane: poly.plane, surface: poly.surface })
  }
}

/** a BSP node: a splitting plane, the polygons lying in it, and the half-spaces in front of and behind it */
class BspNode {
  plane: Plane | null = null
  front: BspNode | null = null
  back: BspNode | null = null
  polys: Poly[] = []
}

/** every node of a tree, parents before children */
function nodesOf(root: BspNode): BspNode[] {
  const out: BspNode[] = []
  const stack = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    out.push(n)
    if (n.back) stack.push(n.back)
    if (n.front) stack.push(n.front)
  }
  return out
}

/** add `polys` to the tree under `root`, growing it where they fall outside its planes */
function build(root: BspNode, polys: readonly Poly[], budget: Budget): void {
  const work: [BspNode, readonly Poly[]][] = [[root, polys]]
  while (work.length > 0) {
    const [node, list] = work.pop()!
    if (list.length === 0) continue
    if (!node.plane) node.plane = list[0]!.plane
    const front: Poly[] = []
    const back: Poly[] = []
    for (const p of list) splitPolygon(node.plane, p, node.polys, node.polys, front, back, budget)
    if (front.length > 0) work.push([(node.front ??= new BspNode()), front])
    if (back.length > 0) work.push([(node.back ??= new BspNode()), back])
  }
}

/** turn the solid inside out: every polygon and plane flipped, front and back swapped */
function invert(root: BspNode): void {
  for (const n of nodesOf(root)) {
    n.polys = n.polys.map(flipPoly)
    if (n.plane) n.plane = { n: [-n.plane.n[0], -n.plane.n[1], -n.plane.n[2]], w: -n.plane.w }
    const f = n.front
    n.front = n.back
    n.back = f
  }
}

/** the parts of `polys` that lie outside the solid `root` describes */
function clipPolygons(root: BspNode, polys: readonly Poly[], budget: Budget): Poly[] {
  if (!root.plane) return [...polys]
  const kept: Poly[] = []
  const work: [BspNode, readonly Poly[]][] = [[root, polys]]
  while (work.length > 0) {
    const [node, list] = work.pop()!
    const front: Poly[] = []
    const back: Poly[] = []
    for (const p of list) splitPolygon(node.plane!, p, front, back, front, back, budget)
    if (front.length > 0) {
      if (node.front) work.push([node.front, front])
      else kept.push(...front)
    }
    // behind a leaf plane is inside the solid: dropped
    if (back.length > 0 && node.back) work.push([node.back, back])
  }
  return kept
}

/** remove from every polygon of `a` whatever lies inside the solid `b` */
function clipTo(a: BspNode, b: BspNode, budget: Budget): void {
  for (const n of nodesOf(a)) n.polys = clipPolygons(b, n.polys, budget)
}

const allPolygons = (root: BspNode): Poly[] => nodesOf(root).flatMap((n) => n.polys)

/** the polygons outside `cutter`, of the solid `solid`, plus the cutter's surface inside it turned to line the cut */
function subtractPolys(solid: readonly Poly[], cutter: readonly Poly[], budget: Budget): Poly[] {
  const a = new BspNode()
  const b = new BspNode()
  build(a, solid, budget)
  build(b, cutter, budget)
  invert(a)
  clipTo(a, b, budget)
  clipTo(b, a, budget)
  invert(b)
  clipTo(b, a, budget)
  invert(b)
  build(a, allPolygons(b), budget)
  invert(a)
  return allPolygons(a)
}

/** six times the signed volume a closed, outward-wound mesh encloses: positive for a solid, not for an open,
 *  flat or inside-out one */
function signedVolume6(desc: MeshDescription): number {
  let vol = 0
  const P = desc.positions
  const I = desc.indices
  for (let k = 0; k + 2 < I.length; k += 3) {
    const a = I[k]! * 3, b = I[k + 1]! * 3, c = I[k + 2]! * 3
    vol += dot([P[a]!, P[a + 1]!, P[a + 2]!], cross([P[b]!, P[b + 1]!, P[b + 2]!], [P[c]!, P[c + 1]!, P[c + 2]!]))
  }
  return vol
}

/**
 * Is the mesh's surface closed: does every edge have a partner running the other way? Edges are matched by
 * position, and an edge left over is still closed when other leftover edges along the same line cover it the
 * other way: a T-junction, where one face was split and its neighbour was not, which every cut leaves behind.
 * So the result of one subtract is a valid solid for the next.
 */
function isClosed(desc: MeshDescription): boolean {
  const P = desc.positions
  const I = desc.indices
  const ids = new Map<string, number>()
  const id = (i: number): number => {
    const key = `${Math.round(P[i * 3]! / WELD_QUANTUM)}|${Math.round(P[i * 3 + 1]! / WELD_QUANTUM)}|${Math.round(P[i * 3 + 2]! / WELD_QUANTUM)}`
    let k = ids.get(key)
    if (k === undefined) ids.set(key, (k = i))
    return k
  }
  const count = new Map<string, number>()
  const edges: [number, number][] = []
  for (let t = 0; t + 2 < I.length; t += 3) {
    const v = [id(I[t]!), id(I[t + 1]!), id(I[t + 2]!)]
    for (let e = 0; e < 3; e++) {
      const a = v[e]!, b = v[(e + 1) % 3]!
      if (a === b) continue
      const key = `${a}|${b}`
      if (!count.has(key)) edges.push([a, b])
      count.set(key, (count.get(key) ?? 0) + 1)
    }
  }
  // edges without a partner, each as many times as it is unmatched
  const loose: [V3, V3][] = []
  const at = (i: number): V3 => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!]
  for (const [a, b] of edges) {
    const extra = count.get(`${a}|${b}`)! - (count.get(`${b}|${a}`) ?? 0)
    for (let k = 0; k < extra; k++) loose.push([at(a), at(b)])
  }
  if (loose.length === 0) return true
  if (loose.length > 20_000) return false // far past any T-junction pattern: a sheet with a long open rim
  // each loose edge must be cancelled along its own length by the loose edges lying on its line
  const TOL = 1e-7
  for (const [a, b] of loose) {
    const d = sub(b, a)
    const len2 = dot(d, d)
    if (len2 < 1e-24) continue
    const onLine = (p: V3): boolean => {
      const s = sub(p, a)
      const t = dot(s, d) / len2
      const off: V3 = [s[0] - d[0] * t, s[1] - d[1] * t, s[2] - d[2] * t]
      return dot(off, off) < TOL * TOL
    }
    // each collinear loose edge as an interval of this edge's parameter, +1 running with it, -1 against
    const events: [number, number][] = []
    for (const [c, e] of loose) {
      if (!onLine(c) || !onLine(e)) continue
      const tc = dot(sub(c, a), d) / len2
      const te = dot(sub(e, a), d) / len2
      if (Math.abs(te - tc) < 1e-12) continue
      const sign = te > tc ? 1 : -1
      events.push([Math.min(tc, te), sign], [Math.max(tc, te), -sign])
    }
    events.sort((x, y) => x[0] - y[0])
    let cover = 0
    let prev = 0
    for (const [t, delta] of events) {
      // a stretch of this edge (parameter 0..1) where the edges on its line don't cancel is an open rim
      const lo = Math.max(prev, 0), hi = Math.min(t, 1)
      if (cover !== 0 && hi - lo > 1e-9) return false
      cover += delta
      prev = t
    }
  }
  return true
}

/** one description's triangles as polygons, each tagged with its surface (offset by `surfaceBase`) */
function toPolys(desc: MeshDescription, surfaceBase: number): Poly[] {
  const nv = (desc.positions.length / 3) | 0
  // union-find over vertex indices: triangles that share a vertex are one surface
  const parent: number[] = new Array<number>(nv).fill(0)
  for (let i = 0; i < nv; i++) parent[i] = i
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  const join = (x: number, y: number): void => {
    const rx = find(x), ry = find(y)
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry)
  }
  const I = desc.indices
  for (let k = 0; k + 2 < I.length; k += 3) {
    join(I[k]!, I[k + 1]!)
    join(I[k + 1]!, I[k + 2]!)
  }
  const P = desc.positions
  const UV = desc.uvs
  const vert = (i: number): Vert => ({ p: [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!], u: UV[i * 2] ?? 0, v: UV[i * 2 + 1] ?? 0 })
  const out: Poly[] = []
  for (let k = 0; k + 2 < I.length; k += 3) {
    const a = vert(I[k]!), b = vert(I[k + 1]!), c = vert(I[k + 2]!)
    const n = cross(sub(b.p, a.p), sub(c.p, a.p))
    const len = Math.hypot(n[0], n[1], n[2])
    if (len < 1e-14) continue // a sliver has no plane, and no area to lose
    const nn: V3 = [n[0] / len, n[1] / len, n[2] / len]
    out.push({ verts: [a, b, c], plane: { n: nn, w: dot(nn, a.p) }, surface: surfaceBase + find(I[k]!) })
  }
  return out
}

/** polygons back into one description: fanned into triangles, vertices welded within each surface */
function toDescription(polys: readonly Poly[]): MeshDescription {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const welded = new Map<string, number>()
  const q = (x: number): number => Math.round(x / WELD_QUANTUM)
  const index = (vtx: Vert, surface: number): number => {
    const key = `${surface}|${q(vtx.p[0])}|${q(vtx.p[1])}|${q(vtx.p[2])}`
    let i = welded.get(key)
    if (i === undefined) {
      i = positions.length / 3
      if (i >= MAX_DESCRIPTION_VERTICES) throw new GeometryBudgetError(i + 1)
      positions.push(vtx.p[0], vtx.p[1], vtx.p[2])
      uvs.push(vtx.u, vtx.v)
      welded.set(key, i)
    }
    return i
  }
  for (const p of polys) {
    // every piece is convex (a convex triangle cut by planes stays convex), so a fan triangulates it
    const ids = p.verts.map((vtx) => index(vtx, p.surface))
    for (let k = 1; k + 1 < ids.length; k++) {
      const a = ids[0]!, b = ids[k]!, c = ids[k + 1]!
      if (a === b || b === c || a === c) continue // welded shut: a sliver thinner than the weld quantum
      indices.push(a, b, c)
    }
  }
  return { positions, uvs, indices }
}

/**
 * `solid` with each of `cutters` cut out of it. Every input must be a closed, outward-facing solid (a box, a
 * bevelBox, a lathe whose profile closes on the axis, an extrude, a sweep or loft with `caps`): an open sheet has
 * no inside to cut with, and is refused rather than producing a mesh with holes in it.
 */
export function subtractDescriptions(solid: MeshDescription, cutters: readonly MeshDescription[]): MeshDescription {
  const check = (d: MeshDescription, what: string): void => {
    if (!isClosed(d)) {
      throw new Error(`subtract: the ${what} is not a closed surface, so it has no inside: it is open, or some of its faces point in and some out. A sweep or loft needs { caps: true } and a counter-clockwise profile; a lathe profile must start and end on the axis`)
    }
    if (!(signedVolume6(d) > 1e-15)) {
      throw new Error(`subtract: the ${what} encloses no volume: it is flat, or inside out (its faces point in)`)
    }
  }
  check(solid, 'solid')
  cutters.forEach((c, i) => check(c, cutters.length === 1 ? 'cutter' : `cutter ${i + 1}`))
  const budget = new Budget()
  let surfaceBase = (solid.positions.length / 3) | 0
  let polys = toPolys(solid, 0)
  for (const c of cutters) {
    polys = subtractPolys(polys, toPolys(c, surfaceBase), budget)
    surfaceBase += (c.positions.length / 3) | 0
  }
  return toDescription(polys)
}
