import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from './partPackage'
import { validatePartPackage } from './partValidate'

// Validation of a package material's `pattern` (PartMaterial.pattern): the two-colour texture the host paints in
// place of an albedo image. A pattern is data an agent writes by hand, so every field it can get wrong is named.

function withMaterials(materials: unknown[], assets: unknown[] = []): unknown {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.marked-post',
    name: 'Marked Post',
    params: {},
    behavior: 'definePart({ step(){} })',
    materials,
    assets,
    geometry: {
      kind: 'rig',
      links: [{ name: 'post', shape: { kind: 'box', size: [0.1, 1, 0.1] }, offset: [0, 0.5, 0] }],
      joints: [],
    },
  }
}
const problems = (pkg: unknown): string[] => validatePartPackage(pkg).map((p) => `${p.field}: ${p.message}`)
const hazard = { kind: 'stripes', colors: [[1, 0.6, 0], [0.02, 0.02, 0.02]], angle: 45 }

describe('material pattern validation', () => {
  it('accepts stripes and a checker, alone or projected by triplanar', () => {
    expect(problems(withMaterials([
      { id: 'tape', pattern: hazard },
      { id: 'tape3d', pattern: { ...hazard, ratio: 0.3 }, triplanar: { space: 'object', scale: 5 } },
      { id: 'flag', pattern: { kind: 'checker', colors: [[1, 1, 1], [0, 0, 0]] }, metalness: 0.1 },
    ]))).toEqual([])
  })

  it('names each malformed field', () => {
    const got = problems(withMaterials([
      { id: 'a', pattern: { kind: 'dots', colors: [[1, 1, 1], [0, 0, 0]] } },
      { id: 'b', pattern: { kind: 'stripes', colors: [[1, 1, 1]] } },
      { id: 'c', pattern: { ...hazard, ratio: 1 } },
      { id: 'd', pattern: { ...hazard, angle: 30 } },
      { id: 'e', pattern: 'stripes' },
    ]))
    expect(got).toEqual([
      "materials[0].pattern.kind: pattern.kind must be 'stripes' or 'checker'",
      'materials[1].pattern.colors: pattern.colors must be two [r, g, b] colours',
      'materials[2].pattern.ratio: pattern.ratio must be a number between 0 and 1',
      'materials[3].pattern.angle: pattern.angle must be 0, 45, 90 or 135',
      'materials[4].pattern: pattern must be an object',
    ])
  })

  it('takes an albedo or a pattern, not both, and lets triplanar project either', () => {
    const asset = { id: 'img', mime: 'image/webp', data: 'AAAA' }
    expect(problems(withMaterials([{ id: 'x', albedo: 'img', pattern: hazard }], [asset]))).toEqual([
      'materials[0].pattern: a material takes an albedo texture or a pattern, not both',
    ])
    expect(problems(withMaterials([{ id: 'x', triplanar: { space: 'world', scale: 2 } }]))).toEqual([
      'materials[0].triplanar: triplanar needs an albedo texture or a pattern to sample',
    ])
  })
})
