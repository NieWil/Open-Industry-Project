import { describe, expect, it } from 'vitest'
import { inspectGlb } from './glbInspect'

// inspectGlb is the authoring affordance that lists a GLB's node + material names so an author can split it
// (shape.node) / recolour it (shape.materials) without scripting a node walk. Drive it with a hand-built GLB
// container (header + JSON chunk) so the test is hermetic - no disk read, no node types.
function makeGlb(json: object): string {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const pad = (4 - (jsonBytes.length % 4)) % 4 // chunks are 4-byte aligned (space-padded)
  const chunkLen = jsonBytes.length + pad
  const total = 12 + 8 + chunkLen
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true) // version
  view.setUint32(8, total, true)
  view.setUint32(12, chunkLen, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  buf.set(jsonBytes, 20)
  for (let i = 0; i < pad; i++) buf[20 + jsonBytes.length + i] = 0x20 // ' '
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin)
}

const SENSOR_LIKE = makeGlb({
  nodes: [{ name: 'Body', mesh: 0 }, { name: 'Connector', mesh: 1 }, { name: 'Root', children: [0, 1] }],
  materials: [
    { name: 'color', pbrMetallicRoughness: { metallicFactor: 1, baseColorTexture: { index: 0 } } }, // textured metal
    { name: 'color-2', pbrMetallicRoughness: { metallicFactor: 1 } }, // raw untextured metal
  ],
})

describe('inspectGlb', () => {
  it('lists the model node + material names', () => {
    const c = inspectGlb(SENSOR_LIKE)
    expect(c.nodes).toEqual(['Body', 'Connector', 'Root'])
    expect(c.materials.map((m) => m.name)).toEqual(['color', 'color-2'])
  })

  it('reports metalness + whether each material is textured (the renders-dark signal)', () => {
    const mats = inspectGlb(SENSOR_LIKE).materials
    expect(mats.find((m) => m.name === 'color')).toMatchObject({ metalness: 1, textured: true })
    expect(mats.find((m) => m.name === 'color-2')).toMatchObject({ metalness: 1, textured: false })
  })

  it('says when a texture sets the metalness, so a factor of 1 is not taken for a fully metallic surface', () => {
    const c = inspectGlb(makeGlb({ materials: [{ name: 'decal', pbrMetallicRoughness: { metallicFactor: 1, metallicRoughnessTexture: { index: 0 } } }] }))
    expect(c.materials[0]).toMatchObject({ metalness: 1, textured: false, metalnessTextured: true })
    expect(inspectGlb(SENSOR_LIKE).materials.every((m) => !m.metalnessTextured)).toBe(true)
  })

  it('defaults metalness to 1 when unspecified (glTF default)', () => {
    const c = inspectGlb(makeGlb({ materials: [{ name: 'plain' }] }))
    expect(c.materials[0]).toMatchObject({ name: 'plain', metalness: 1, textured: false })
  })

  it('returns empty for non-GLB / garbage input instead of throwing', () => {
    expect(inspectGlb('not a glb!!')).toEqual({ nodes: [], materials: [] })
    expect(inspectGlb('')).toEqual({ nodes: [], materials: [] })
  })
})
