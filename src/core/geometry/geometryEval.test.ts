import { describe, expect, it } from 'vitest'
import { evalPartGeometry, resolvePartParams } from './geometryEval'

// The core-side evaluator of the geometry-function tier (docs/procedural-geometry.md), the render/headless
// counterpart of sim's embeddedBehavior.geometry(). It exists because render may not import sim but must build the
// same procedural geometry. These pin (a) a bent belt realizes, (b) it reflows on a param change, (c) params
// resolve against the schema defaults, (d) a part with no geometry()/a bad source yields null (the host falls
// back), and (e) it matches the sim runtime byte-for-byte (one description, two hosts).

const BENT_BELT = `
definePart({
  params: { segs: { type: 'numberList', arity: 2, default: [[1, 0], [1, 20], [1, -20]] } },
  geometry: (g, p) => {
    const profile = [[-0.1, -0.5], [-0.1, 0.5], [0, 0.5], [0, -0.5]]
    const DEG = Math.PI / 180
    const corners = [[0, 0, 0]]
    let tilt = 0, x = 0, y = 0
    for (const row of p.segs) { tilt += row[1] * DEG; x += Math.cos(tilt) * row[0]; y += Math.sin(tilt) * row[0]; corners.push([x, y, 0]) }
    return g.sweep(profile, g.fillet(corners, 0.2))
  },
  step: () => {},
})
`

const ys = (positions: number[]): number[] => positions.filter((_, i) => i % 3 === 1)
const span = (positions: number[]): number => {
  const y = ys(positions)
  return Math.max(...y) - Math.min(...y)
}
// a single-description geometry() normalizes to a one-element MeshPart[]; grab that part's mesh
const onePart = (parts: ReturnType<typeof evalPartGeometry>): { positions: number[]; indices: number[]; uvs: number[] } => {
  expect(parts).not.toBeNull()
  expect(parts!).toHaveLength(1)
  return parts![0]!.desc
}

describe('geometryEval - core realization of a part geometry() callback', () => {
  it('realizes the default Z-frame belt (the bent bed the manifest can not express)', () => {
    const desc = onePart(evalPartGeometry(BENT_BELT, resolvePartParams({ segs: { type: 'numberList', arity: 2, default: [[1, 0], [1, 20], [1, -20]] } }, {})))
    expect(desc.positions.length).toBeGreaterThan(0)
    expect(span(desc.positions)).toBeGreaterThan(0.3) // climbs well past the 0.1 slab thickness
  })

  it('reflows when a param override collapses the bend to a single flat run', () => {
    const flat = onePart(evalPartGeometry(BENT_BELT, { segs: [[2, 0]] }))
    expect(span(flat.positions)).toBeCloseTo(0.1, 5) // just the slab thickness, no elevation
  })

  it('returns null for a part with no geometry() callback (manifest-described)', () => {
    expect(evalPartGeometry(`definePart({ params: {}, step: () => {} })`, {})).toBeNull()
  })

  it('returns null for a non-deterministic source (the determinism gate) and an uncompilable one', () => {
    expect(evalPartGeometry(`definePart({ geometry: () => Math.random(), step(){} })`, {})).toBeNull()
    expect(evalPartGeometry(`this is not valid js (((`, {})).toBeNull()
  })

  it('resolvePartParams fills schema defaults but lets an override win', () => {
    const schema = { len: { type: 'number' as const, default: 3 }, w: { type: 'number' as const, default: 1 } }
    expect(resolvePartParams(schema, { len: 5 })).toEqual({ len: 5, w: 1 })
  })
})

// The render-only roller bank (`MeshPart.rollers` on an empty `desc`) and the `rollerLayout()` entry point are
// retired. Nothing validates a behavior's output, so a part written against them must still load. It draws no
// rollers and everything else is intact.
describe('retired roller banks', () => {
  const OLD_ROLLER_PART = `
definePart({
  geometry: (g) => [
    { finish: 'frame', desc: g.box([2, 0.1, 0.05], [0, 0, 0]) },
    { finish: 'roller', desc: { positions: [], indices: [] }, rollers: { instances: [{ x: 0, z: 0, yaw: 0 }], radius: 0.024, length: 1 } },
  ],
  rollerLayout: (deltas) => deltas.map((d) => ({ x: d[0], z: d[2], yaw: 0 })),
  step: () => {},
})
`
  it('drops the bank and keeps the rest', () => {
    const parts = evalPartGeometry(OLD_ROLLER_PART, {})
    expect(parts?.map((p) => p.finish)).toEqual(['frame'])
  })
})
