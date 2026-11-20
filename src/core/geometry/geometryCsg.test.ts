import { describe, expect, it } from 'vitest'
import type { MeshDescription } from '../parts/partApi'
import { createGeometryBuilder } from './geometryBuilder'

// g.subtract. A cut is right when the result encloses the solid's volume less exactly the volume cut away
// (positive = every face, the cut's lining included, points out of the material), when a point in the cut is
// outside the result, and when the surfaces keep their shading: a round band shares its vertices again after
// the cut, a flat face keeps vertices of its own. A cut leaves T-junctions where one face was split and its
// neighbour was not, which is why closure is not checked edge for edge here.

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
/** is `p` inside the solid: crossings of a ray from it, counted with the faces' winding (+1 out, -1 in) */
const inside = (d: MeshDescription, p: P): boolean => {
  const v = verts(d)
  const dir: P = [0.5773, 0.5774, 0.5775] // skew, so it never runs along an edge of these axis-aligned shapes
  let winding = 0
  for (let t = 0; t < d.indices.length; t += 3) {
    const a = v[d.indices[t]!]!, b = v[d.indices[t + 1]!]!, c = v[d.indices[t + 2]!]!
    const e1: P = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2: P = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const h: P = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]]
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2]
    if (Math.abs(det) < 1e-14) continue
    const s: P = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det
    if (u < 0 || u > 1) continue
    const q: P = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
    const w = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det
    if (w < 0 || u + w > 1) continue
    if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 0) winding += det > 0 ? 1 : -1
  }
  return winding !== 0
}
const ngonArea = (n: number, r: number): number => (n / 2) * r * r * Math.sin((2 * Math.PI) / n)

describe('g.subtract', () => {
  it('bores a cylinder through a box: the box less the bore, the bore open, the wall solid', () => {
    const d = g.subtract(g.box([1, 1, 1], [0, 0, 0]), g.cylinder(0.2, 1.2, [0, 0, 0], { axis: 'y' }))
    expect(signedVolume(d)).toBeCloseTo(1 - ngonArea(24, 0.2) * 1, 9)
    expect(inside(d, [0, 0.1, 0.05])).toBe(false)
    expect(inside(d, [0.4, 0.1, 0.4])).toBe(true)
  })

  it('cuts a blind pocket and a notch flush with a face: no face left behind on the shared plane', () => {
    const plate = g.box([1, 0.2, 1], [0, 0.1, 0])
    // a pocket from the top down to half depth; its top face lies on the plate's top face
    const pocket = g.subtract(plate, g.box([0.4, 0.1, 0.4], [0, 0.15, 0]))
    expect(signedVolume(pocket)).toBeCloseTo(0.2 - 0.4 * 0.1 * 0.4, 9)
    expect(inside(pocket, [0, 0.17, 0])).toBe(false)
    expect(inside(pocket, [0, 0.03, 0])).toBe(true)
    // a notch out of a corner, flush with three faces
    const notch = g.subtract(plate, g.box([0.3, 0.2, 0.3], [0.35, 0.1, 0.35]))
    expect(signedVolume(notch)).toBeCloseTo(0.2 - 0.3 * 0.2 * 0.3, 9)
  })

  it('takes several cutters at once, and a cutter that misses changes nothing', () => {
    const housing = g.bevelBox([0.6, 0.3, 0.4], [0, 0.15, 0], 0.01)
    const full = signedVolume(housing)
    const holes = [-0.2, 0, 0.2].map((x) => g.cylinder(0.03, 0.5, [x, 0.15, 0], { axis: 'z', segments: 16 }))
    const d = g.subtract(housing, ...holes)
    expect(signedVolume(d)).toBeCloseTo(full - 3 * ngonArea(16, 0.03) * 0.4, 9)
    const miss = g.subtract(housing, g.box([0.1, 0.1, 0.1], [2, 2, 2]))
    expect(signedVolume(miss)).toBeCloseTo(full, 9)
  })

  it('keeps a turned surface round and a flat one flat across the cut', () => {
    const R = 0.05
    const hub = g.subtract(g.cylinder(R, 0.04, [0, 0, 0], { segments: 24 }), g.cylinder(0.01, 0.05, [0, 0, 0], { segments: 24 }))
    const v = verts(hub)
    const uses = new Map<number, number>()
    for (const i of hub.indices) uses.set(i, (uses.get(i) ?? 0) + 1)
    // the outer wall's vertices are shared by the band's triangles on both sides (smooth), never one apiece
    const wall = v.map((p, i) => [p, i] as const).filter(([p]) => Math.abs(Math.hypot(p[0], p[2]) - R) < 1e-9 && Math.abs(p[1]) < 0.02 - 1e-9)
    expect(wall.length).toBe(0) // the wall has no vertices off its two rims...
    const rimTop = v.map((p, i) => [p, i] as const).filter(([p]) => Math.abs(Math.hypot(p[0], p[2]) - R) < 1e-9 && Math.abs(p[1] - 0.02) < 1e-9)
    // ...and each rim point appears twice: once welded into the wall band, once on the flat cap
    expect(rimTop.length).toBe(48)
    expect(rimTop.filter(([, i]) => (uses.get(i) ?? 0) >= 3).length).toBeGreaterThanOrEqual(24)
    expect(signedVolume(hub)).toBeCloseTo((ngonArea(24, R) - ngonArea(24, 0.01)) * 0.04, 9)
  })

  it('is deterministic', () => {
    const run = (): MeshDescription => g.subtract(g.bevelBox([0.3, 0.3, 0.3], [0, 0, 0], 0.02), g.cylinder(0.08, 0.4, [0.05, 0, 0], { axis: 'x' }))
    expect(run()).toEqual(run())
  })

  it('refuses an open or inside-out solid, naming the fix', () => {
    const open = g.sweep([[0, -0.1], [0.1, 0], [0, 0.1], [-0.1, 0]], [[0, 0, 0], [1, 0, 0]])
    const box = g.box([1, 1, 1], [0, 0, 0])
    expect(() => g.subtract(box, open)).toThrow(/cutter is not a closed surface.*caps: true/)
    expect(() => g.subtract(open, box)).toThrow(/solid is not a closed surface/)
    const insideOut = { ...box, indices: box.indices.map((_, i, a) => a[i - (i % 3) + (2 - (i % 3))]!) }
    expect(() => g.subtract(box, box, insideOut)).toThrow(/cutter 2 encloses no volume.*inside out/)
    // a clockwise profile: walls facing in, caps facing out, so the surface does not close
    const clockwise = g.sweep([[0, 0], [0, 0.1], [0.1, 0.1], [0.1, 0]], [[0, 0, 0], [1, 0, 0]], { caps: true })
    expect(() => g.subtract(box, clockwise)).toThrow(/counter-clockwise/)
  })

  it("accepts every closed shape the builder makes, as solid and as cutter", () => {
    const shapes: [string, MeshDescription][] = [
      ['box', g.box([0.2, 0.2, 0.2], [0, 0, 0])],
      ['bevelBox, square faces', g.bevelBox([0.3, 0.2, 0.25], [0, 0, 0], 0.02, ['y-', 'x+'])],
      ['cylinder', g.cylinder(0.1, 0.2, [0, 0, 0], { axis: 'x' })],
      ['hex lathe', g.lathe([[0, 0], [0.05, 0], [0.05, 0.02], [0.02, 0.03], [0.02, 0.1], [0, 0.1]], { segments: 6, smooth: false })],
      ['extrude, holes + bevel', g.extrude([[-0.2, -0.1], [0.2, -0.1], [0.2, 0.1], [0, 0.15], [-0.2, 0.1]], 0, 0.02, { holes: [[[-0.05, -0.05], [-0.05, 0.05], [0.05, 0.05], [0.05, -0.05]]], bevel: 0.004 })],
      ['capped concave sweep', g.sweep([[0, 0], [0.33, 0], [0.33, 0.05], [0.3, 0.05], [0.3, 0.02], [0, 0.02]], [[0, 0, 0], [1, 0, 0], [1.5, 0, 0.5]], { caps: true })],
      ['capped loft', g.loft([[[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]], [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]]], [[0, 0.5, 0], [0, 0, 0]], { caps: true })],
    ]
    const far = g.box([0.01, 0.01, 0.01], [9, 9, 9])
    for (const [name, s] of shapes) {
      expect(() => g.subtract(s, far), name).not.toThrow()
      expect(() => g.subtract(g.box([20, 20, 20], [0, 0, 0]), s), name).not.toThrow()
    }
  })

  it('takes a cut solid as the solid of the next cut, T-junctions and all', () => {
    const plate = g.box([1, 0.2, 1], [0, 0.1, 0])
    const pocketed = g.subtract(plate, g.box([0.4, 0.1, 0.4], [0, 0.15, 0]))
    const drilled = g.subtract(pocketed, g.cylinder(0.05, 0.3, [0.3, 0.1, 0.3]))
    expect(signedVolume(drilled)).toBeCloseTo(0.2 - 0.4 * 0.1 * 0.4 - ngonArea(24, 0.05) * 0.2, 9)
    // and a cut piece can be the cutter too
    const d = g.subtract(g.box([2, 2, 2], [0, 0, 0]), pocketed)
    expect(signedVolume(d)).toBeCloseTo(8 - (0.2 - 0.4 * 0.1 * 0.4), 9)
  })
})
