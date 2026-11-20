import { describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type FuncGeo } from './examplePart'
const { behavior: SHAPE_BEHAVIOR, geometry: SHAPE_GEO, head: SHAPE_HEAD } = examplePart<FuncGeo>('oip.shape')

// The Shape part: parametric box / cylinder / cone / ramp primitives on the geometry-function tier - the
// stand-in massing a twin needs before a real model exists (a pillar, a machine footprint, a plinth, a ramp).
//
// The assertions that matter are the two things a primitive can get silently wrong:
//   1. Winding. three derives normals from the faces (realizeMeshDescription → computeVertexNormals), so a
//      flipped quad renders inside-out - dark and hollow-looking - with nothing failing. Every shape here is
//      convex, so "every face normal points away from the vertex centroid" is an exact test of all of them.
//   2. Extents. length/width/height carry the three face handles, so the emitted solid must fill exactly the
//      footprint box the editor draws its resize dots on, base-origin on local y=0.

const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(SHAPE_BEHAVIOR, { length: 1, width: 1, height: 1, sides: 20, solid: true, color: '#9aa3ad', ...params } as never)
  if (!parts) throw new Error('shape geometry() returned no parts')
  return parts
}
const only = (params: Record<string, unknown>): MeshPart => {
  const parts = realize(params)
  expect(parts.length).toBe(1) // one submesh, one material: a primitive is never multi-part
  return parts[0]!
}

const vert = (mp: MeshPart, i: number): [number, number, number] => [mp.desc.positions[i * 3]!, mp.desc.positions[i * 3 + 1]!, mp.desc.positions[i * 3 + 2]!]

const aabb = (mp: MeshPart): { min: [number, number, number]; max: [number, number, number] } => {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mp.desc.positions.length / 3; i++) {
    const p = vert(mp, i)
    for (const a of [0, 1, 2] as const) {
      if (p[a] < min[a]) min[a] = p[a]
      if (p[a] > max[a]) max[a] = p[a]
    }
  }
  return { min, max }
}

/** Faces whose normal points inward (toward the solid's interior) - empty for a correctly wound convex mesh. */
function inwardFaces(mp: MeshPart): number[] {
  const n = mp.desc.positions.length / 3
  const c: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const p = vert(mp, i)
    c[0] += p[0] / n
    c[1] += p[1] / n
    c[2] += p[2] / n
  }
  const bad: number[] = []
  const idx = mp.desc.indices
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const A = vert(mp, idx[t]!), B = vert(mp, idx[t + 1]!), C = vert(mp, idx[t + 2]!)
    // three's computeVertexNormals: normal = (C − B) × (A − B)
    const u = [C[0] - B[0], C[1] - B[1], C[2] - B[2]]
    const v = [A[0] - B[0], A[1] - B[1], A[2] - B[2]]
    const nx = u[1]! * v[2]! - u[2]! * v[1]!
    const ny = u[2]! * v[0]! - u[0]! * v[2]!
    const nz = u[0]! * v[1]! - u[1]! * v[0]!
    if (Math.hypot(nx, ny, nz) < 1e-12) continue // degenerate sliver: no normal to judge
    // face centre relative to the interior point; a convex solid has every face facing away from it
    const dx = (A[0] + B[0] + C[0]) / 3 - c[0]
    const dy = (A[1] + B[1] + C[1]) / 3 - c[1]
    const dz = (A[2] + B[2] + C[2]) / 3 - c[2]
    if (nx * dx + ny * dy + nz * dz <= 0) bad.push(t / 3)
  }
  return bad
}

const SHAPES = ['box', 'cylinder', 'cone', 'ramp'] as const

describe('Shape part (oip.shape)', () => {
  it('is a Structure-category function part whose bounds are the default 1 m cube', () => {
    expect(SHAPE_HEAD.category).toBe('Structure')
    expect(SHAPE_GEO.kind).toBe('drawn')
    expect(SHAPE_GEO.conveys).toBeUndefined() // inert scenery: never a conveying surface
    expect(SHAPE_GEO.bounds).toEqual({ length: 1, width: 1, top: 1 })
  })

  it.each(SHAPES)('%s: every face winds outward (a flipped one renders inside-out)', (shape) => {
    expect(inwardFaces(only({ shape, length: 2, width: 3, height: 1.5 }))).toEqual([])
  })

  it.each(SHAPES)('%s: fills the footprint box exactly, base-origin on y=0', (shape) => {
    const box = aabb(only({ shape, length: 2, width: 3, height: 1.5 }))
    expect(box.min[0]).toBeCloseTo(-1, 6)
    expect(box.max[0]).toBeCloseTo(1, 6)
    expect(box.min[1]).toBeCloseTo(0, 6)
    expect(box.max[1]).toBeCloseTo(1.5, 6)
    expect(box.min[2]).toBeCloseTo(-1.5, 6)
    expect(box.max[2]).toBeCloseTo(1.5, 6)
  })

  it.each(SHAPES)('%s: declares a convex-hull collider, or none when Solid is cleared', (shape) => {
    // 'hull', not 'box': the AABB box channel would collide a cylinder as its bounding square and a
    // ramp as a solid block (nothing could ride up it). The box's hull is its 8 corners - exact either way.
    expect(only({ shape }).collision).toBe('hull')
    expect(only({ shape, solid: false }).collision).toBeUndefined()
  })

  it.each(SHAPES)('%s: tints from the color param and carries the neutral mesh material', (shape) => {
    const mp = only({ shape })
    expect(mp.colorParam).toBe('color')
    expect(mp.finish).toBe('mesh')
    expect(mp.instances).toBeUndefined() // a real-size solid, not an instanced unit template: the hull IS the mesh
  })

  it('box is g.box: 24 verts (4 per face, so it shades flat)', () => {
    expect(only({ shape: 'box' }).desc.positions.length / 3).toBe(24)
  })

  it('the round shapes take their two radii from length/2 and width/2 (a squashed cylinder is elliptical)', () => {
    const cyl = only({ shape: 'cylinder', length: 4, width: 1, height: 1 })
    const box = aabb(cyl)
    expect(box.max[0]).toBeCloseTo(2, 6) // rx = length/2
    expect(box.max[2]).toBeCloseTo(0.5, 6) // rz = width/2
    // ...and no vertex escapes that ellipse
    for (let i = 0; i < cyl.desc.positions.length / 3; i++) {
      const [x, , z] = vert(cyl, i)
      expect((x / 2) ** 2 + (z / 0.5) ** 2).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('`sides` drives the round shapes tessellation and is clamped to a sane range', () => {
    const at = (sides: number): number => only({ shape: 'cylinder', sides }).desc.positions.length / 3
    expect(at(8)).toBeLessThan(at(32))
    expect(at(3)).toBe(at(2)) // clamped up to a triangle
    expect(at(48)).toBe(at(999)) // clamped down to the cap
    expect(inwardFaces(only({ shape: 'cone', sides: 3 }))).toEqual([]) // still wound right at the minimum
  })

  it('falls back to a unit shape on missing/degenerate params instead of emitting nothing', () => {
    const box = aabb(only({ shape: 'box', length: 0, width: -1, height: undefined }))
    expect(box.max[0] - box.min[0]).toBeCloseTo(1, 6)
    expect(box.max[1] - box.min[1]).toBeCloseTo(1, 6)
    expect(box.max[2] - box.min[2]).toBeCloseTo(1, 6)
  })
})
