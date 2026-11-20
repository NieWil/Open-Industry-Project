import { describe, expect, it } from 'vitest'
import { usdToGlb, type UsdMaterial, type UsdPiece } from './usdToGlb'

/** a quad (two triangles) spanning lo..hi in X and Y at height z, in glTF's frame */
function quad(material: number, lo: [number, number], hi: [number, number], z = 0, uv = true, nrm = true): UsdPiece {
  const pos = new Float32Array([lo[0], lo[1], z, hi[0], lo[1], z, lo[0], hi[1], z, hi[0], hi[1], z])
  return {
    material,
    pos,
    nrm: nrm ? new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) : null,
    uv: uv ? new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]) : null,
    idx: new Uint32Array([0, 1, 2, 2, 1, 3]),
  }
}

const mat = (name: string, extra: Partial<UsdMaterial> = {}): UsdMaterial => ({
  name,
  baseColor: [1, 1, 1, 1],
  metallic: 0,
  roughness: 0.5,
  alphaMode: 'OPAQUE',
  doubleSided: false,
  ...extra,
})

const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' }
const webp = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), mimeType: 'image/webp' }

interface Gltf {
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  nodes: { name: string; mesh: number }[]
  meshes: { primitives: { attributes: Record<string, number>; indices: number; material: number }[] }[]
  materials: Record<string, unknown>[]
  textures?: Record<string, unknown>[]
  images?: { bufferView: number; mimeType: string }[]
  accessors: { bufferView: number; componentType: number; count: number; min?: number[]; max?: number[] }[]
  bufferViews: { byteOffset: number; byteLength: number }[]
}

function parse(glb: Uint8Array): { gltf: Gltf; bin: DataView } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  expect(view.getUint32(0, true)).toBe(0x46546c67)
  expect(view.getUint32(8, true)).toBe(glb.length)
  const jsonLength = view.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Gltf
  const binAt = 20 + jsonLength
  expect(view.getUint32(binAt + 4, true)).toBe(0x004e4942)
  return { gltf, bin: new DataView(glb.buffer, glb.byteOffset + binAt + 8, view.getUint32(binAt, true)) }
}

describe('usdToGlb', () => {
  it('merges pieces that share a material into one mesh, and keeps the others apart', () => {
    const { glb, stats } = usdToGlb([quad(0, [0, 0], [1, 1]), quad(1, [2, 0], [3, 1]), quad(0, [4, 0], [5, 1])], [mat('steel'), mat('rubber')], [])
    const { gltf } = parse(glb)
    expect(gltf.meshes.length).toBe(2)
    expect(gltf.nodes.map((n) => n.name)).toEqual(['steel', 'rubber'])
    const steel = gltf.accessors[gltf.meshes[0]!.primitives[0]!.attributes.POSITION!]!
    expect(steel.count).toBe(8)
    expect(stats).toMatchObject({ meshes: 2, triangles: 6, images: 0 })
  })

  it('puts the model on the origin: centred in X and Z, base on Y = 0', () => {
    // a quad standing in the XY plane from y = 2 to 3, at z = 5
    const { glb, stats } = usdToGlb([quad(0, [10, 2], [12, 3], 5)], [mat('a')], [])
    const pos = parse(glb).gltf.accessors[0]!
    expect(pos.min).toEqual([-1, 0, 0])
    expect(pos.max).toEqual([1, 1, 0])
    expect(stats.size).toEqual([2, 1, 0])
  })

  it('offsets the indices of each merged piece by the vertices before it', () => {
    const { glb } = usdToGlb([quad(0, [0, 0], [1, 1]), quad(0, [2, 0], [3, 1])], [mat('a')], [])
    const { gltf, bin } = parse(glb)
    const acc = gltf.accessors[gltf.meshes[0]!.primitives[0]!.indices]!
    const bv = gltf.bufferViews[acc.bufferView]!
    const idx = Array.from({ length: acc.count }, (_, i) => bin.getUint16(bv.byteOffset + i * 2, true))
    expect(idx).toEqual([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7])
  })

  it('keeps normals only when every merged piece has them, and fills UVs a piece lacks', () => {
    const { glb } = usdToGlb([quad(0, [0, 0], [1, 1]), quad(0, [2, 0], [3, 1], 0, false, false)], [mat('a')], [])
    const attrs = parse(glb).gltf.meshes[0]!.primitives[0]!.attributes
    expect(attrs.NORMAL).toBeUndefined()
    expect(attrs.TEXCOORD_0).toBeDefined()
  })

  it('embeds each used image once, and only the used ones', () => {
    const materials = [
      mat('a', { baseColorTexture: { image: 1 }, metallicRoughnessTexture: { image: 1 } }),
      mat('b', { baseColorTexture: { image: 1 } }),
      mat('unused', { baseColorTexture: { image: 0 } }),
    ]
    const { glb, stats } = usdToGlb([quad(0, [0, 0], [1, 1]), quad(1, [2, 0], [3, 1])], materials, [png, png])
    const { gltf } = parse(glb)
    expect(gltf.images?.length).toBe(1)
    expect(gltf.textures).toEqual([{ source: 0 }])
    expect(gltf.materials.length).toBe(2)
    expect(stats.images).toBe(1)
    expect(gltf.extensionsUsed).toBeUndefined()
  })

  it('declares and requires EXT_texture_webp for a WebP image', () => {
    const { glb } = usdToGlb([quad(0, [0, 0], [1, 1])], [mat('a', { baseColorTexture: { image: 0 } })], [webp])
    const { gltf } = parse(glb)
    expect(gltf.textures).toEqual([{ extensions: { EXT_texture_webp: { source: 0 } } }])
    expect(gltf.extensionsUsed).toEqual(['EXT_texture_webp'])
    expect(gltf.extensionsRequired).toEqual(['EXT_texture_webp'])
  })

  it('writes a texture transform only when it is not the identity', () => {
    const materials = [mat('tiled', { baseColorTexture: { image: 0, scale: [4, 2] } }), mat('plain', { baseColorTexture: { image: 0, scale: [1, 1], offset: [0, 0] } })]
    const { glb } = usdToGlb([quad(0, [0, 0], [1, 1]), quad(1, [2, 0], [3, 1])], materials, [png])
    const { gltf } = parse(glb)
    const pbr = (i: number) => gltf.materials[i]!.pbrMetallicRoughness as Record<string, Record<string, unknown>>
    expect(pbr(0).baseColorTexture!.extensions).toEqual({ KHR_texture_transform: { offset: [0, 0], scale: [4, 2], rotation: 0 } })
    expect(pbr(1).baseColorTexture!.extensions).toBeUndefined()
    expect(gltf.extensionsUsed).toEqual(['KHR_texture_transform'])
  })

  it('carries the material factors, alpha mode, double sidedness and normal strength', () => {
    const m = mat('glass', { baseColor: [0.2, 0.4, 0.6, 0.5], metallic: 1, roughness: 0.1, alphaMode: 'BLEND', doubleSided: true, normalTexture: { image: 0, strength: 2 } })
    const { glb } = usdToGlb([quad(0, [0, 0], [1, 1])], [m], [png])
    const out = parse(glb).gltf.materials[0]!
    expect(out).toMatchObject({
      name: 'glass',
      alphaMode: 'BLEND',
      doubleSided: true,
      normalTexture: { index: 0, scale: 2 },
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 0.5], metallicFactor: 1, roughnessFactor: 0.1 },
    })
  })

  it('adds a sampler only for a wrap other than repeat, shared by textures that use it', () => {
    const materials = [
      mat('clamped', { baseColorTexture: { image: 0, wrapS: 'clamp', wrapT: 'clamp' }, normalTexture: { image: 1, wrapS: 'clamp', wrapT: 'clamp' } }),
      mat('tiled', { baseColorTexture: { image: 0 } }),
    ]
    const { glb } = usdToGlb([quad(0, [0, 0], [1, 1]), quad(1, [2, 0], [3, 1])], materials, [png, webp])
    const { gltf } = parse(glb) as { gltf: Gltf & { samplers?: unknown[] } }
    expect(gltf.samplers).toEqual([{ wrapS: 33071, wrapT: 33071 }])
    // one image, read through two textures: clamped and repeating
    expect(gltf.textures).toEqual([{ sampler: 0, source: 0 }, { sampler: 0, extensions: { EXT_texture_webp: { source: 1 } } }, { source: 0 }])
  })

  it('writes occlusion and emissive', () => {
    const m = mat('lamp', { emissive: [1, 0.5, 0], occlusionTexture: { image: 0 }, metallicRoughnessTexture: { image: 0 }, emissiveTexture: { image: 0 } })
    const out = parse(usdToGlb([quad(0, [0, 0], [1, 1])], [m], [png]).glb).gltf
    expect(out.materials[0]).toMatchObject({ emissiveFactor: [1, 0.5, 0], occlusionTexture: { index: 0 }, emissiveTexture: { index: 0 } })
    expect(out.images?.length).toBe(1)
  })

  it('switches to 32-bit indices past 65535 vertices', () => {
    const n = 70000
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) pos[i * 3] = i / n
    const piece: UsdPiece = { material: 0, pos, nrm: null, uv: null, idx: new Uint32Array([0, 1, n - 1]) }
    const { gltf } = parse(usdToGlb([piece], [mat('a')], []).glb)
    expect(gltf.accessors[gltf.meshes[0]!.primitives[0]!.indices]!.componentType).toBe(5125)
  })

  it('numbers a repeated material name, since a mesh link carves the model by node name', () => {
    const { glb } = usdToGlb([quad(0, [0, 0], [1, 1]), quad(1, [2, 0], [3, 1]), quad(2, [4, 0], [5, 1])], [mat('steel', { roughness: 0.2 }), mat('steel'), mat('steel', { roughness: 0.9 })], [])
    const { gltf } = parse(glb)
    expect(gltf.nodes.map((n) => n.name)).toEqual(['steel', 'steel_2', 'steel_3'])
    expect(gltf.materials.map((m) => m.name)).toEqual(['steel', 'steel_2', 'steel_3'])
  })

  it('drops pieces with no triangle', () => {
    const empty: UsdPiece = { material: 0, pos: new Float32Array(3), nrm: null, uv: null, idx: new Uint32Array(0) }
    const { stats } = usdToGlb([empty, quad(0, [0, 0], [1, 1])], [mat('a')], [])
    expect(stats).toMatchObject({ meshes: 1, triangles: 2 })
  })
})
