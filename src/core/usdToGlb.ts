// A USD model, read and composed (editor/usdImport.ts) -> a GLB the existing model import takes.
//
// USD composes a model from many layers (references, payloads, variants, overrides), which the USD reader resolves.
// What reaches this file is the composed result as triangles with their world transforms already applied, plus
// materials and their encoded images. Everything after that is here, in core, because it is pure arithmetic over
// typed arrays and both surfaces need the same answer. GLB stays the one format the rest of the app reads: nothing
// downstream of this function knows the model was ever USD.
//
// Pieces that share a material are merged into one mesh. A model built from many parts with few materials (a roller
// conveyor: 29 parts, 8 materials) then draws in a handful of calls instead of one per part.

import { ARRAY_BUFFER, bytesOf, ELEMENT_ARRAY_BUFFER, FLOAT, GlbBin, packGlb, UNSIGNED_INT, UNSIGNED_SHORT } from './glbPack'

/** One triangulated piece in glTF's frame: metres, +Y up, its world transform applied, UV origin at the top left. */
export interface UsdPiece {
  /** index into the materials list */
  material: number
  pos: Float32Array
  nrm: Float32Array | null
  uv: Float32Array | null
  idx: Uint32Array
}

/** An encoded image: PNG, JPEG or WebP bytes. */
export interface UsdImage {
  bytes: Uint8Array
  mimeType: string
}

export type UsdWrap = 'repeat' | 'clamp' | 'mirror'

export interface UsdTextureRef {
  /** index into the images list */
  image: number
  /** glTF's KHR_texture_transform: uv' = offset + rotate(rotation) * (scale * uv), rotation in radians */
  offset?: [number, number]
  scale?: [number, number]
  rotation?: number
  wrapS?: UsdWrap
  wrapT?: UsdWrap
}

export interface UsdMaterial {
  name: string
  /** linear RGBA */
  baseColor: [number, number, number, number]
  metallic: number
  roughness: number
  /** linear RGB */
  emissive?: [number, number, number]
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND'
  alphaCutoff?: number
  doubleSided: boolean
  baseColorTexture?: UsdTextureRef
  /** roughness in G, metalness in B, as glTF reads it */
  metallicRoughnessTexture?: UsdTextureRef
  /** occlusion in R; often the same image as metallicRoughnessTexture */
  occlusionTexture?: UsdTextureRef
  normalTexture?: UsdTextureRef & { strength?: number }
  emissiveTexture?: UsdTextureRef
}

const WRAP_GL: Record<UsdWrap, number> = { repeat: 10497, clamp: 33071, mirror: 33648 }

export interface UsdToGlbStats {
  /** meshes written: one per material used */
  meshes: number
  triangles: number
  /** the model's size in metres (x, y, z) */
  size: [number, number, number]
  images: number
}

/**
 * Write `pieces` as a GLB: merged by material, centred on the origin in X and Z with the base on Y = 0 (so it sits
 * on the node's origin the way a catalog part does), with only the materials and images the pieces use.
 */
export function usdToGlb(pieces: readonly UsdPiece[], materials: readonly UsdMaterial[], images: readonly UsdImage[]): { glb: Uint8Array; stats: UsdToGlbStats } {
  const kept = pieces.filter((p) => p.idx.length >= 3 && p.pos.length >= 9)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of kept)
    for (let i = 0; i < p.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, p.pos[i + k]!)
        hi[k] = Math.max(hi[k]!, p.pos[i + k]!)
      }
  const shift = kept.length ? [-(lo[0]! + hi[0]!) / 2, -lo[1]!, -(lo[2]! + hi[2]!) / 2] : [0, 0, 0]

  const byMaterial = new Map<number, UsdPiece[]>()
  for (const p of kept) {
    const list = byMaterial.get(p.material)
    if (list) list.push(p)
    else byMaterial.set(p.material, [p])
  }

  const bin = new GlbBin()
  const accessors: object[] = []
  const gltfMaterials: object[] = []
  const meshes: object[] = []
  const nodes: object[] = []
  const imageIndex = new Map<number, number>()
  const gltfImages: object[] = []
  const textureIndex = new Map<string, number>()
  const textures: object[] = []
  const samplerIndex = new Map<string, number>()
  const samplers: object[] = []
  let webp = false
  let transform = false
  const textureInfo = (ref: UsdTextureRef | undefined): Record<string, unknown> | null => {
    if (!ref || !images[ref.image]) return null
    let source = imageIndex.get(ref.image)
    if (source === undefined) {
      const img = images[ref.image]!
      gltfImages.push({ bufferView: bin.push(img.bytes), mimeType: img.mimeType })
      source = gltfImages.length - 1
      imageIndex.set(ref.image, source)
    }
    // glTF's default sampler repeats both ways, so only another wrap needs one
    const wrapS = ref.wrapS ?? 'repeat'
    const wrapT = ref.wrapT ?? 'repeat'
    let sampler: number | undefined
    if (wrapS !== 'repeat' || wrapT !== 'repeat') {
      const key = `${wrapS},${wrapT}`
      sampler = samplerIndex.get(key)
      if (sampler === undefined) {
        samplers.push({ wrapS: WRAP_GL[wrapS], wrapT: WRAP_GL[wrapT] })
        sampler = samplers.length - 1
        samplerIndex.set(key, sampler)
      }
    }
    const texKey = `${source},${sampler ?? ''}`
    let tex = textureIndex.get(texKey)
    if (tex === undefined) {
      const img = images[ref.image]!
      const withSampler = sampler === undefined ? {} : { sampler }
      // WebP is an extension in glTF 2.0; three's GLTFLoader reads it built in
      if (img.mimeType === 'image/webp') {
        webp = true
        textures.push({ ...withSampler, extensions: { EXT_texture_webp: { source } } })
      } else textures.push({ ...withSampler, source })
      tex = textures.length - 1
      textureIndex.set(texKey, tex)
    }
    const info: Record<string, unknown> = { index: tex }
    const offset = ref.offset ?? [0, 0]
    const scale = ref.scale ?? [1, 1]
    const rotation = ref.rotation ?? 0
    if (offset[0] !== 0 || offset[1] !== 0 || scale[0] !== 1 || scale[1] !== 1 || rotation !== 0) {
      transform = true
      info.extensions = { KHR_texture_transform: { offset, scale, rotation } }
    }
    return info
  }

  let triangles = 0
  const usedNames = new Set<string>()
  for (const [matIndex, list] of byMaterial) {
    let verts = 0
    let indices = 0
    for (const p of list) {
      verts += p.pos.length / 3
      indices += p.idx.length
    }
    const pos = new Float32Array(verts * 3)
    // normals only if every piece has them (a merged mesh would otherwise mix lit and unlit); UVs if any piece has
    // them, zero for the rest, since an untextured piece never reads them
    const nrm = list.every((p) => p.nrm) ? new Float32Array(verts * 3) : null
    const uv = list.some((p) => p.uv) ? new Float32Array(verts * 2) : null
    const idx = new Uint32Array(indices)
    let v = 0
    let i = 0
    for (const p of list) {
      const n = p.pos.length / 3
      for (let j = 0; j < n; j++) {
        pos[(v + j) * 3] = p.pos[j * 3]! + shift[0]!
        pos[(v + j) * 3 + 1] = p.pos[j * 3 + 1]! + shift[1]!
        pos[(v + j) * 3 + 2] = p.pos[j * 3 + 2]! + shift[2]!
      }
      if (nrm) nrm.set(p.nrm!, v * 3)
      if (uv && p.uv) uv.set(p.uv, v * 2)
      for (let k = 0; k < p.idx.length; k++) idx[i + k] = p.idx[k]! + v
      v += n
      i += p.idx.length
    }
    triangles += indices / 3

    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let j = 0; j < pos.length; j += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, pos[j + k]!)
        max[k] = Math.max(max[k]!, pos[j + k]!)
      }
    const attributes: Record<string, number> = { POSITION: accessors.length }
    accessors.push({ bufferView: bin.push(bytesOf(pos), ARRAY_BUFFER), componentType: FLOAT, count: verts, type: 'VEC3', min, max })
    if (nrm) {
      attributes.NORMAL = accessors.length
      accessors.push({ bufferView: bin.push(bytesOf(nrm), ARRAY_BUFFER), componentType: FLOAT, count: verts, type: 'VEC3' })
    }
    if (uv) {
      attributes.TEXCOORD_0 = accessors.length
      accessors.push({ bufferView: bin.push(bytesOf(uv), ARRAY_BUFFER), componentType: FLOAT, count: verts, type: 'VEC2' })
    }
    // 16-bit indices when they fit
    const small = verts <= 0xffff
    const outIdx = small ? Uint16Array.from(idx) : idx
    const indicesAccessor = accessors.length
    accessors.push({ bufferView: bin.push(bytesOf(outIdx), ELEMENT_ARRAY_BUFFER), componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT, count: idx.length, type: 'SCALAR' })

    const m = materials[matIndex] ?? DEFAULT_MATERIAL
    const pbr: Record<string, unknown> = { baseColorFactor: m.baseColor, metallicFactor: m.metallic, roughnessFactor: m.roughness }
    const base = textureInfo(m.baseColorTexture)
    if (base) pbr.baseColorTexture = base
    const mr = textureInfo(m.metallicRoughnessTexture)
    if (mr) pbr.metallicRoughnessTexture = mr
    const material: Record<string, unknown> = { name: m.name, pbrMetallicRoughness: pbr }
    const normal = textureInfo(m.normalTexture)
    if (normal) material.normalTexture = m.normalTexture?.strength !== undefined && m.normalTexture.strength !== 1 ? { ...normal, scale: m.normalTexture.strength } : normal
    const occlusion = textureInfo(m.occlusionTexture)
    if (occlusion) material.occlusionTexture = occlusion
    if (m.emissive && m.emissive.some((c) => c > 0)) material.emissiveFactor = m.emissive
    const emissive = textureInfo(m.emissiveTexture)
    if (emissive) material.emissiveTexture = emissive
    if (m.alphaMode !== 'OPAQUE') material.alphaMode = m.alphaMode
    if (m.alphaMode === 'MASK' && m.alphaCutoff !== undefined) material.alphaCutoff = m.alphaCutoff
    if (m.doubleSided) material.doubleSided = true
    // node names are what a mesh link carves by (keepNode, hideNodes), so a repeated name is numbered
    const name = uniqueName(m.name, usedNames)
    material.name = name
    gltfMaterials.push(material)
    meshes.push({ name, primitives: [{ attributes, indices: indicesAccessor, material: gltfMaterials.length - 1 }] })
    nodes.push({ name, mesh: meshes.length - 1 })
  }

  const extensionsUsed = [...(webp ? ['EXT_texture_webp'] : []), ...(transform ? ['KHR_texture_transform'] : [])]
  const gltf = {
    asset: { version: '2.0', generator: 'oip-web USD import' },
    ...(extensionsUsed.length ? { extensionsUsed } : {}),
    // a viewer that can't read WebP can't show the model at all, so the extension is required, not optional
    ...(webp ? { extensionsRequired: ['EXT_texture_webp'] } : {}),
    scene: 0,
    scenes: [{ nodes: nodes.map((_, j) => j) }],
    nodes,
    meshes,
    materials: gltfMaterials,
    ...(textures.length ? { textures, images: gltfImages } : {}),
    ...(samplers.length ? { samplers } : {}),
    accessors,
  }
  const size: [number, number, number] = kept.length ? [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!] : [0, 0, 0]
  return { glb: packGlb(gltf, bin), stats: { meshes: meshes.length, triangles, size, images: gltfImages.length } }
}

/** `name`, or `name_2`, `name_3`... when it is taken */
function uniqueName(name: string, used: Set<string>): string {
  let out = name
  for (let n = 2; used.has(out); n++) out = `${name}_${n}`
  used.add(out)
  return out
}

const DEFAULT_MATERIAL: UsdMaterial = { name: 'material', baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.6, alphaMode: 'OPAQUE', doubleSided: false }
