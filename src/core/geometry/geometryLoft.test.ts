import { describe, expect, it } from 'vitest'
import type { MeshDescription } from '../parts/partApi'
import { createGeometryBuilder } from './geometryBuilder'

// g.loft (a sweep whose section changes along the path) and the sweep's `frame: 'transport'`. A loft is right when
// it is closed, outward (positive signed volume) and encloses the volume the sections imply; a frame is right when
// the section neither flips nor twists where the path turns vertical.

const g = createGeometryBuilder()
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
const sq = (s: number): [number, number][] => [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]]
const circle = (r: number, n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)])

describe('g.loft', () => {
  it('a two-section hopper is a closed, outward frustum of the right volume, whichever way the path runs', () => {
    const h = 0.8, a = 1, b = 0.3
    const frustum = (h / 3) * (a * a + b * b + a * b)
    for (const path of [[[0, h, 0], [0, 0, 0]], [[0, 0, 0], [0, h, 0]], [[0, 0, 0], [h, 0, 0]]] as P[][]) {
      const d = g.loft([sq(a), sq(b)], path, { caps: true })
      expect(openEdges(d)).toBe(0)
      expect(signedVolume(d)).toBeCloseTo(frustum, 9)
    }
  })

  it('blends two sections by distance along the path, not by point count', () => {
    // stations bunched at the start: the section halfway along the length is halfway between the two
    const path: P[] = [[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0], [2, 0, 0]]
    const d = g.loft([sq(1), sq(0)], path, { caps: true })
    const v = verts(d)
    // station 2 sits at x 0.2 of 2: its square is 0.9 wide (8 vertices a ring: every corner is a hard edge)
    const ring = v.slice(16, 24)
    for (const p of ring) {
      expect(p[0]).toBeCloseTo(0.2, 12)
      expect(Math.abs(p[1])).toBeCloseTo(0.45, 12)
      expect(Math.abs(p[2])).toBeCloseTo(0.45, 12)
    }
  })

  it('takes one section per station, and a section shrunk to a point is a cone tip with no cap', () => {
    const tip: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]]
    const d = g.loft([sq(1), sq(0.5), tip], [[0, 0, 0], [0, 0.5, 0], [0, 1, 0]], { caps: true })
    expect(openEdges(d)).toBe(0)
    const lower = (0.5 / 3) * (1 + 0.25 + 0.5)
    const upper = (0.5 / 3) * 0.25
    expect(signedVolume(d)).toBeCloseTo(lower + upper, 9)
  })

  it('refuses sections that cannot be joined point to point', () => {
    expect(() => g.loft([sq(1), circle(0.5, 8)], [[0, 0, 0], [1, 0, 0]])).toThrow(/same number of points/)
    expect(() => g.loft([sq(1), sq(1), sq(1)], [[0, 0, 0], [1, 0, 0]])).toThrow(/one section per path station/)
    expect(() => g.loft([[[0, 0], [1, 0]], [[0, 0], [1, 0]]], [[0, 0, 0], [1, 0, 0]])).toThrow(/≥3 points/)
  })

  it('with the same section everywhere is exactly the sweep', () => {
    const path: P[] = [[0, 0, 0], [1, 0.2, 0], [2, 0.2, 1]]
    const prof = circle(0.1, 10)
    expect(g.loft([prof, prof], path, { caps: true })).toEqual(g.sweep(prof, path, { caps: true }))
  })
})

describe("sweep frame: 'transport'", () => {
  // a pipe that runs along +X, bends up through a quarter arc and climbs straight up
  const path: P[] = [
    [-1, 0, 0],
    ...g.arc([0, 1, 0], 1, -Math.PI / 2, 0, 16).map((p) => [p[0], p[1], p[2]] as P),
    [1, 2, 0],
  ]
  const marker: [number, number][] = [[0, 0.1], [0.05, 0], [0, -0.1], [-0.05, 0]] // point 0 is the +width side

  it('carries the section round the bend without turning it: the width side stays on +Z all the way up', () => {
    const v = verts(g.sweep(marker, path, { frame: 'transport' }))
    const ringSize = v.length / path.length // a sharp corner has a vertex per edge
    for (let i = 0; i < path.length; i++) {
      const p = v[i * ringSize]!
      expect(p[2]).toBeCloseTo(0.1, 9)
    }
  })

  it("is why it exists: 'level' cannot hold the width side once the path is vertical", () => {
    const v = verts(g.sweep(marker, path))
    const top = v[(path.length - 1) * (v.length / path.length)]!
    expect(Math.abs(top[2] - 0.1)).toBeGreaterThan(0.05)
  })

  it('stays a closed, outward tube', () => {
    const d = g.sweep(circle(0.05, 12), path, { frame: 'transport', caps: true })
    expect(openEdges(d)).toBe(0)
    expect(signedVolume(d)).toBeGreaterThan(0)
  })
})
