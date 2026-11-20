import { describe, expect, it } from 'vitest'
import { createGeometryBuilder } from './geometryBuilder'
import { GeometryBudgetError } from './meshDescription'

// The geometry-function tier's domain-general builder ops (docs/procedural-geometry.md, Tier 2). A part
// composes sweep / fillet / arc / box / merge into a MeshDescription. Nothing belt-specific is in `g`.
// A bent belt, which the manifest's single sweep can't express, is built here from segment corners + fillet.
// This shows the general ops are enough: the belt logic is in the part, not the builder.

// belt deck cross-section in the [up, width] plane: a width×thickness slab, top face at up=0, CCW.
function deckSection(width: number, thickness: number): Array<[number, number]> {
  const hw = width / 2
  return [
    [-thickness, -hw],
    [-thickness, hw],
    [0, hw],
    [0, -hw],
  ]
}
const ys = (positions: number[]): number[] => positions.filter((_, i) => i % 3 === 1)
// walk [length, tiltDeg] rows into a corner polyline (cumulative tilt) - exactly what a belt's geometry() does
function beltCorners(segs: Array<[number, number]>): Array<[number, number, number]> {
  const DEG = Math.PI / 180
  const pts: Array<[number, number, number]> = [[0, 0, 0]]
  let tilt = 0
  let x = 0
  let y = 0
  for (const [len, deg] of segs) {
    tilt += deg * DEG
    x += Math.cos(tilt) * len
    y += Math.sin(tilt) * len
    pts.push([x, y, 0])
  }
  return pts
}

describe('geometryBuilder - general ops (sweep/fillet/arc/box/merge); a bent belt is composed, not built-in', () => {
  it('sweeps a profile along a single straight run (filleted no-op) into a flat bed', () => {
    const g = createGeometryBuilder()
    const mesh = g.sweep(deckSection(1.0, 0.1), g.fillet(beltCorners([[2, 0]]), 0.2))
    // a straight run = 2 corners; fillet has no interior corner to round → 2 stations × 4 hard-edged corners × 2
    expect(mesh.positions).toHaveLength(16 * 3)
    expect(mesh.indices).toHaveLength(24)
    const y = ys(mesh.positions)
    expect(Math.max(...y) - Math.min(...y)).toBeCloseTo(0.1, 6) // flat: just the slab thickness
  })

  it('fillet bends a Z-frame path - it climbs then levels (the single-sweep manifest can not)', () => {
    const g = createGeometryBuilder()
    const path = g.fillet(beltCorners([[1, 0], [1, 20], [1, -20]]), 0.2)
    expect(Math.max(...path.map((p) => p[1]))).toBeGreaterThan(0.2) // the apex rises
    expect(path.length).toBeGreaterThan(8) // run corners + filleted arc samples, not just 4 corners
    const mesh = g.sweep(deckSection(1.0, 0.1), path)
    const y = ys(mesh.positions)
    expect(Math.max(...y) - Math.min(...y)).toBeGreaterThan(0.3) // the swept bed spans the climb
  })

  it('fillet leaves a straight (no interior corner) polyline unchanged', () => {
    expect(createGeometryBuilder().fillet([[0, 0, 0], [1, 0, 0]], 0.2)).toEqual([[0, 0, 0], [1, 0, 0]])
  })

  it('arc samples a circle: segments + 1 points all on the radius', () => {
    const a = createGeometryBuilder().arc([0, 0, 0], 1, 0, Math.PI, 4)
    expect(a).toHaveLength(5)
    expect(a[0]![0]).toBeCloseTo(1, 9)
    expect(a[4]![0]).toBeCloseTo(-1, 9)
    for (const p of a) expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 9)
  })

  it('box is a 24-vertex axis-aligned box centred at the given point', () => {
    const b = createGeometryBuilder().box([2, 1, 0.5], [3, 0, 0])
    expect(b.positions).toHaveLength(24 * 3)
    const xs = b.positions.filter((_, i) => i % 3 === 0)
    expect(Math.min(...xs)).toBeCloseTo(2, 9)
    expect(Math.max(...xs)).toBeCloseTo(4, 9)
  })

  it('throws GeometryBudgetError rather than allocate an unbounded mesh', () => {
    const g = createGeometryBuilder()
    const longPath = Array.from({ length: 60_000 }, (_, i) => [i * 0.01, 0, 0] as const)
    expect(() => g.sweep(deckSection(1.0, 0.1), longPath)).toThrow(GeometryBudgetError)
  })

  it('merge concatenates pieces and re-bases the second piece indices onto the first', () => {
    const g = createGeometryBuilder()
    const a = g.box([1, 1, 1], [0, 0, 0])
    const b = g.box([1, 1, 1], [3, 0, 0])
    const merged = g.merge(a, b)
    const aVerts = a.positions.length / 3
    expect(merged.positions).toHaveLength(a.positions.length + b.positions.length)
    expect(merged.indices.slice(a.indices.length)).toEqual(b.indices.map((i) => i + aVerts))
  })

  it('surface() is the low-level vertex hatch: push verts + tris/quads → a MeshDescription', () => {
    const g = createGeometryBuilder()
    const s = g.surface()
    const a = s.vertex(0, 0, 0, 0, 0)
    const b = s.vertex(1, 0, 0, 1, 0)
    const c = s.vertex(1, 1, 0, 1, 1)
    const d = s.vertex(0, 1, 0, 0, 1)
    expect([a, b, c, d]).toEqual([0, 1, 2, 3]) // vertex() returns the running index
    s.quad(a, b, c, d) // CCW quad = two triangles
    const t = s.vertex(2, 0, 0)
    s.triangle(b, t, c)
    const desc = s.build()
    expect(desc.positions).toHaveLength(5 * 3)
    expect(desc.uvs).toHaveLength(5 * 2)
    expect(desc.indices).toEqual([0, 1, 2, 0, 2, 3, 1, 4, 2]) // quad's 2 tris + the explicit tri
    // a part can compose surface() output with the high-level ops via merge (same MeshDescription shape)
    expect(() => g.merge(desc, g.box([1, 1, 1], [5, 0, 0]))).not.toThrow()
  })

  it('surface() budget-caps the vertex count', () => {
    const s = createGeometryBuilder().surface()
    expect(() => {
      for (let i = 0; i < 200_001; i++) s.vertex(i, 0, 0)
    }).toThrow(GeometryBudgetError)
  })

  it('is deterministic - identical inputs produce byte-identical positions', () => {
    const m = (): number[] => createGeometryBuilder().sweep(deckSection(1.0, 0.1), createGeometryBuilder().fillet(beltCorners([[1, 0], [2, 15]]), 0.2)).positions
    expect(m()).toEqual(m())
  })
})
