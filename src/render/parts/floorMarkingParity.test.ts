import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type FuncGeo } from './examplePart'
const { behavior: MARKING_BEHAVIOR, geometry: MARKING_GEO } = examplePart<FuncGeo>('oip.floor-marking')

// The Floor Marking, authored on the geometry-function tier to match the built-in shader decal
// (markingShader.ts): the five styles (solid / hazard / dashed / border / stripes) emitted as flat two-colour
// band polygons, one MeshPart per colour, each tinted live via the MeshPart.colorParam channel. Render-only:
// no collision, no conveys, empty step, so the part has no sim body. Known divergences from the shader
// (documented in the build script): hazard/dash phase is part-local, and only full alpha cutout is
// reproduced (a #rrggbb00 secondary drops its bands). Partial translucency is not (bands are opaque geometry).

const geo = MARKING_GEO
const MARK = { length: 2, width: 8, style: 'hazard', stripeSize: 0.3, borderWidth: 0.1 }
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(MARKING_BEHAVIOR, params as never)
  if (!parts) throw new Error('floor-marking geometry() returned no parts')
  return parts
}
const byColor = (parts: MeshPart[], param: string): MeshPart => {
  const p = parts.find((x) => x.colorParam === param)
  if (!p) throw new Error(`missing marking part tinted by: ${param}`)
  return p
}
const axis = (pos: number[], a: 0 | 1 | 2): number[] => pos.filter((_, i) => i % 3 === a)
/** summed area of a flat (XZ-plane) triangle soup, m² */
const area = (d: MeshPart['desc']): number => {
  let sum = 0
  for (let i = 0; i < d.indices.length; i += 3) {
    const [a, b, c] = [d.indices[i]! * 3, d.indices[i + 1]! * 3, d.indices[i + 2]! * 3]
    const [ax, az] = [d.positions[a]!, d.positions[a + 2]!]
    sum += Math.abs((d.positions[b]! - ax) * (d.positions[c + 2]! - az) - (d.positions[c]! - ax) * (d.positions[b + 2]! - az)) / 2
  }
  return sum
}

describe('Floor Marking (geometry-function tier - the shader decal styles as colorParam-tinted band geometry)', () => {
  it('is a valid render-only function package: no conveys, no collision, an empty step', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.floor-marking', name: 'Floor Marking', params: {}, behavior: MARKING_BEHAVIOR, geometry: geo })).toEqual([])
    expect(geo.kind).toBe('drawn')
    expect((geo as { conveys?: boolean }).conveys).toBeUndefined()
    for (const p of realize(MARK)) expect(p.collision).toBeUndefined()
  })

  it('emits one submesh per colour, tinted by the primary/secondary color params (MeshPart.colorParam)', () => {
    const parts = realize(MARK)
    expect(parts).toHaveLength(2)
    expect(byColor(parts, 'primaryColor').finish).toBe('mesh')
    expect(byColor(parts, 'secondaryColor').finish).toBe('mesh')
  })

  it('paints flat at the decal lift (y = 0.01, the built-in MARKING_HEIGHT_OFFSET), spanning length × width', () => {
    const prim = byColor(realize(MARK), 'primaryColor').desc
    const ys = axis(prim.positions, 1)
    expect(Math.min(...ys)).toBeCloseTo(0.01, 6)
    expect(Math.max(...ys)).toBeLessThan(0.012)
    expect(Math.min(...axis(prim.positions, 0))).toBeCloseTo(-1, 4) // x ∈ [−L/2, L/2]
    expect(Math.max(...axis(prim.positions, 2))).toBeCloseTo(4, 4) // z ∈ [−W/2, W/2]
  })

  it('hazard: the two colours tile the whole rectangle (areas sum to L·W, roughly half each)', () => {
    const parts = realize(MARK)
    const p = area(byColor(parts, 'primaryColor').desc)
    const s = area(byColor(parts, 'secondaryColor').desc)
    expect(p + s).toBeCloseTo(2 * 8, 3)
    expect(p).toBeGreaterThan(6)
    expect(s).toBeGreaterThan(6)
  })

  it('solid: a single primary sheet covering the rectangle (the empty secondary part is dropped)', () => {
    const parts = realize({ ...MARK, style: 'solid' })
    expect(parts).toHaveLength(1)
    expect(parts[0]!.colorParam).toBe('primaryColor')
    expect(area(parts[0]!.desc)).toBeCloseTo(16, 4)
  })

  it('border: primary-only outline whose area is the perimeter band (interior open - the floor shows through)', () => {
    const parts = realize({ ...MARK, style: 'border' })
    expect(parts).toHaveLength(1)
    // 2·bw·(L+W) − 4·bw² = 2·0.1·10 − 0.04
    expect(area(parts[0]!.desc)).toBeCloseTo(1.96, 4)
  })

  it('stripes: bands tile the rect from the long-axis edge, starting primary (shader uv-phase parity)', () => {
    const parts = realize({ ...MARK, style: 'stripes' })
    const p = byColor(parts, 'primaryColor').desc
    const s = byColor(parts, 'secondaryColor').desc
    expect(area(p) + area(s)).toBeCloseTo(16, 3)
    // width 8 > length 2 ⇒ stripes run across Z from z = −4; the first stripeSize band is primary
    expect(Math.min(...axis(p.positions, 2))).toBeCloseTo(-4, 4)
    expect(Math.min(...axis(s.positions, 2))).toBeCloseTo(-4 + 0.3, 4)
  })

  it('dashed: a full primary field + secondary dashes floated above it, centred on the short axis', () => {
    const parts = realize({ ...MARK, style: 'dashed' })
    const p = byColor(parts, 'primaryColor').desc
    const s = byColor(parts, 'secondaryColor').desc
    expect(area(p)).toBeCloseTo(16, 4) // the field spans the whole marking
    expect(Math.min(...axis(s.positions, 1))).toBeGreaterThan(0.01) // dashes float above the field (no z-fight)
    // width 8 > length 2 ⇒ dashes run along Z, centred fifth of X: x ∈ [−0.2, 0.2]
    expect(Math.min(...axis(s.positions, 0))).toBeCloseTo(-0.2, 4)
    expect(Math.max(...axis(s.positions, 0))).toBeCloseTo(0.2, 4)
  })

  it('stripeSize drives the band count (smaller stripes → more hazard bands), area conserved', () => {
    const tris = (sz: number): number => byColor(realize({ ...MARK, stripeSize: sz }), 'secondaryColor').desc.indices.length / 3
    expect(tris(0.15)).toBeGreaterThan(tris(0.3))
    const parts = realize({ ...MARK, stripeSize: 0.15 })
    expect(area(byColor(parts, 'primaryColor').desc) + area(byColor(parts, 'secondaryColor').desc)).toBeCloseTo(16, 3)
  })

  it('alpha cutout: a fully-transparent secondary (#rrggbb00) drops its bands so the floor shows through', () => {
    expect(realize({ ...MARK })).toHaveLength(2) // opaque secondary ⇒ both colours present
    const cut = realize({ ...MARK, secondaryColor: '#1a1a1a00' }) // alpha 0 ⇒ secondary bands omitted
    expect(cut).toHaveLength(1)
    expect(cut[0]!.colorParam).toBe('primaryColor')
    // an opaque #rrggbbaa secondary (alpha ff) keeps its bands - only alpha 00 cuts out
    expect(realize({ ...MARK, secondaryColor: '#1a1a1aff' })).toHaveLength(2)
  })

  it('is deterministic - identical params → byte-identical band positions', () => {
    expect(byColor(realize(MARK), 'primaryColor').desc.positions).toEqual(byColor(realize(MARK), 'primaryColor').desc.positions)
  })
})
