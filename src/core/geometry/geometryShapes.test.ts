import { describe, expect, it } from 'vitest'
import type { MeshDescription } from '../parts/partApi'
import { bevelBoxDescription, extrudeDescription, latheDescription, transformDescription, triangulateWithHoles } from './geometryShapes'
import { createGeometryBuilder } from './geometryBuilder'

// A generated solid is right when it is closed (every edge, welded by position, has exactly one partner running
// the other way: no gaps, consistent winding) and its signed volume is the solid's volume (positive = every face
// points out). Those two checks catch a flipped face, a missing cap and a wrong dimension alike.

type P = [number, number, number]
const verts = (d: MeshDescription): P[] => {
  const out: P[] = []
  for (let i = 0; i < d.positions.length; i += 3) out.push([d.positions[i]!, d.positions[i + 1]!, d.positions[i + 2]!])
  return out
}
const signedVolume = (d: MeshDescription): number => {
  const v = verts(d)
  let s = 0
  for (let t = 0; t < d.indices.length; t += 3) {
    const a = v[d.indices[t]!]!, b = v[d.indices[t + 1]!]!, c = v[d.indices[t + 2]!]!
    s += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  }
  return s / 6
}
/** directed edges that lack their reverse, after welding coincident vertices */
const openEdges = (d: MeshDescription): number => {
  const key = (p: P): string => p.map((x) => x.toFixed(6)).join(',')
  const v = verts(d).map(key)
  const edges = new Map<string, number>()
  const add = (a: string, b: string): void => { if (a !== b) edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1) }
  for (let t = 0; t < d.indices.length; t += 3) {
    const a = v[d.indices[t]!]!, b = v[d.indices[t + 1]!]!, c = v[d.indices[t + 2]!]!
    add(a, b); add(b, c); add(c, a)
  }
  let open = 0
  for (const [k, n] of edges) {
    const [a, b] = k.split('|')
    if ((edges.get(`${b}|${a}`) ?? 0) !== n) open++
  }
  return open
}
const ngonArea = (n: number, r: number): number => (n / 2) * r * r * Math.sin((2 * Math.PI) / n)
const square: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]

describe('bevelBox', () => {
  it('is a closed, outward solid a little smaller than its box', () => {
    const d = bevelBoxDescription([2, 1, 0.5], [1, 2, 3], 0.05)
    expect(openEdges(d)).toBe(0)
    const v = signedVolume(d)
    expect(v).toBeLessThan(1) // the chamfers take a little off
    expect(v).toBeGreaterThan(1 - 0.05 * 0.05 * 0.5 * 4 * (2 + 1 + 0.5)) // ...no more than the 12 edge wedges
  })
  it('stays closed with square faces, and is exactly the box with no bevel', () => {
    expect(openEdges(bevelBoxDescription([1, 1, 1], [0, 0, 0], 0.1, ['y-', 'x+']))).toBe(0)
    expect(signedVolume(bevelBoxDescription([1, 2, 3], [0, 0, 0], 0))).toBeCloseTo(6, 9)
  })
})

describe('lathe', () => {
  it('turns a capped cylinder about each axis: closed, outward, the prism volume', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const d = latheDescription([[0, 0], [1, 0], [1, 2], [0, 2]], { axis, segments: 12, center: [3, -1, 2] })
      expect(openEdges(d)).toBe(0)
      expect(signedVolume(d)).toBeCloseTo(ngonArea(12, 1) * 2, 9)
    }
  })
  it('a cone tip, and flat facets for a hex head', () => {
    const cone = latheDescription([[0, 0], [1, 0], [0, 3]], { segments: 16 })
    expect(openEdges(cone)).toBe(0)
    expect(signedVolume(cone)).toBeCloseTo((ngonArea(16, 1) * 3) / 3, 9)
    const hex = latheDescription([[0, 0], [0.5, 0], [0.5, 0.2], [0, 0.2]], { segments: 6, smooth: false, axis: 'z' })
    expect(openEdges(hex)).toBe(0)
    expect(signedVolume(hex)).toBeCloseTo(ngonArea(6, 0.5) * 0.2, 9)
  })
  it('a hollow ring (outer wall, top, inner bore): walking with the outside on the right faces the bore inward', () => {
    // walked from the bottom of the outer wall, up, inward across the top, down the bore, out across the bottom
    const d = latheDescription([[2, 0], [2, 1], [1, 1], [1, 0], [2, 0]], { segments: 24 })
    expect(openEdges(d)).toBe(0)
    expect(signedVolume(d)).toBeCloseTo((ngonArea(24, 2) - ngonArea(24, 1)) * 1, 9)
  })
  it('smooth bands share their ring vertices (round), faceted ones do not (flat)', () => {
    const round = latheDescription([[1, 0], [1, 1]], { segments: 8 })
    const flat = latheDescription([[1, 0], [1, 1]], { segments: 8, smooth: false })
    expect(round.positions.length / 3).toBe(16)
    expect(flat.positions.length / 3).toBe(32)
  })
})

describe('extrude', () => {
  const hole = (cx: number, cy: number, r: number): [number, number][] => [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]]
  it('a plate with holes: closed, outward, outline minus holes times thickness - along each axis', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const d = extrudeDescription(square, 0, 0.5, { axis, holes: [hole(-0.5, 0, 0.2), hole(0.5, 0.3, 0.1)] })
      expect(openEdges(d)).toBe(0)
      expect(signedVolume(d)).toBeCloseTo((4 - 0.16 - 0.04) * 0.5, 9)
    }
  })
  it('a concave outline, either winding, either order of from/to', () => {
    const L: [number, number][] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]
    for (const o of [L, [...L].reverse()]) {
      const d = extrudeDescription(o, 1, 0, {})
      expect(openEdges(d)).toBe(0)
      expect(signedVolume(d)).toBeCloseTo(3, 9)
    }
  })
  it('a bevel takes the edges off both faces and stays closed; a square edge keeps its full face', () => {
    const d = extrudeDescription(square, 0, 1, { bevel: 0.1 })
    expect(openEdges(d)).toBe(0)
    const v = signedVolume(d)
    expect(v).toBeLessThan(4)
    // the 0.8 m core slab, plus a frustum at each face from the 2 m square in to the 1.8 m chamfered one
    const frustum = (0.1 / 3) * (4 + 1.8 * 1.8 + 2 * 1.8)
    expect(v).toBeCloseTo(4 * 0.8 + 2 * frustum, 9)
    const kept = extrudeDescription(square, 0, 1, { bevel: 0.1, square: [0] })
    expect(openEdges(kept)).toBe(0)
    expect(signedVolume(kept)).toBeGreaterThan(v)
  })
})

describe('triangulateWithHoles', () => {
  it('covers exactly the outline minus its holes', () => {
    const outline: [number, number][] = [[0, 0], [4, 0], [4, 3], [0, 3]]
    const holes: [number, number][][] = [[[1, 1], [1, 2], [2, 2], [2, 1]], [[2.5, 0.5], [2.5, 2.5], [3.5, 2.5], [3.5, 0.5]]]
    const { points, triangles } = triangulateWithHoles(outline, holes)
    let area = 0
    for (const [a, b, c] of triangles) {
      const A = points[a]!, B = points[b]!, C = points[c]!
      area += ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2
    }
    expect(area).toBeCloseTo(12 - 1 - 2, 9)
  })
})

describe('transform + the builder surface', () => {
  it('scales and translates; refuses a mirror', () => {
    const box = bevelBoxDescription([1, 1, 1], [0, 0, 0], 0)
    const t = transformDescription(box, { scale: [2, 3, 4], translate: [10, 0, 0] })
    expect(signedVolume(t)).toBeCloseTo(24, 9)
    expect(Math.min(...verts(t).map((p) => p[0]))).toBeCloseTo(9, 9)
    expect(() => transformDescription(box, { scale: [-1, 1, 1] })).toThrow(/positive/)
  })
  it('rotates by a quaternion: +90° about y takes +x to −z, and keeps the solid outward and closed', () => {
    const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const
    const d = transformDescription(bevelBoxDescription([2, 1, 0.5], [3, 0, 0], 0.05), { rotate: q, translate: [0, 1, 0] })
    expect(openEdges(d)).toBe(0)
    expect(signedVolume(d)).toBeCloseTo(signedVolume(bevelBoxDescription([2, 1, 0.5], [3, 0, 0], 0.05)), 9)
    const zs = verts(d).map((p) => p[2])
    expect((Math.min(...zs) + Math.max(...zs)) / 2).toBeCloseTo(-3, 9) // the box centred at x 3 now sits at z −3
  })
  it('is reachable from g (a part script uses these through the builder)', () => {
    const g = createGeometryBuilder()
    const d = g.merge(g.bevelBox([1, 1, 1], [0, 0, 0], 0.05), g.lathe([[0, 2], [0.3, 2], [0.3, 3], [0, 3]], { axis: 'y' }), g.extrude(square, 4, 5))
    expect(openEdges(d)).toBe(0)
    expect(signedVolume(g.transform(d, { scale: 2 }))).toBeGreaterThan(0)
  })
})
