// The GLB of an imported URDF robot: one node per link, holding that link's visual geometry in the link's own frame.
//
// A rig mesh link that names a `node` draws that node's geometry with its node transform reset (render/parts/sdk/
// materials.ts prepareMeshInstance), so the vertices here are already in the link frame and the nodes carry no
// transform. Each link's pieces are merged by material (a colour, and the image a textured mesh is painted with) into
// one primitive per material. A textured piece keeps its texture coordinates; the colour then tints the image.

import { ARRAY_BUFFER, bytesOf, ELEMENT_ARRAY_BUFFER, FLOAT, GlbBin, packGlb, UNSIGNED_INT, UNSIGNED_SHORT } from './glbPack'

/** Triangles in a link's frame (metres), with the colour they are drawn in. */
export interface LinkPiece {
  /** linear RGBA; with an image, the tint over it */
  color: [number, number, number, number]
  pos: Float32Array
  nrm: Float32Array | null
  idx: Uint32Array
  /** texture coordinates, glTF's way up (v = 0 at the image's top), with `image` */
  uv?: Float32Array | null
  /** index into the images linkMeshesToGlb is given: what this piece is painted with */
  image?: number
}

/** An encoded image a piece is painted with: PNG, JPEG or WebP bytes. */
export interface LinkImage {
  bytes: Uint8Array
  mimeType: string
}

export interface LinkMeshes {
  /** the GLB node name: the rig link's name */
  name: string
  pieces: LinkPiece[]
}

/** Write `links` as a GLB, a node per link that has triangles, with the `images` its textured pieces name. Returns
 *  the bytes and the triangle count. */
export function linkMeshesToGlb(links: readonly LinkMeshes[], images: readonly LinkImage[] = []): { glb: Uint8Array; triangles: number } {
  const bin = new GlbBin()
  const accessors: object[] = []
  const materials: object[] = []
  const materialIndex = new Map<string, number>()
  const meshes: object[] = []
  const nodes: object[] = []
  const gltfImages: object[] = []
  const textures: object[] = []
  const textureIndex = new Map<number, number>()
  let webp = false
  let triangles = 0

  /** a piece's image, when it has one it can be drawn with: its texture coordinates and an image that exists */
  const imageOf = (p: LinkPiece): number | undefined => (p.image !== undefined && images[p.image] && p.uv && p.uv.length === (p.pos.length / 3) * 2 ? p.image : undefined)
  const textureFor = (image: number): number => {
    let t = textureIndex.get(image)
    if (t === undefined) {
      const img = images[image]!
      gltfImages.push({ bufferView: bin.push(img.bytes), mimeType: img.mimeType })
      const source = gltfImages.length - 1
      if (img.mimeType === 'image/webp') {
        webp = true
        textures.push({ extensions: { EXT_texture_webp: { source } } })
      } else textures.push({ source })
      t = textures.length - 1
      textureIndex.set(image, t)
    }
    return t
  }
  const materialFor = (c: LinkPiece['color'], image: number | undefined): number => {
    const key = `${c.map((v) => v.toFixed(4)).join(',')}|${image ?? ''}`
    let i = materialIndex.get(key)
    if (i === undefined) {
      const pbr: Record<string, unknown> = { baseColorFactor: c, metallicFactor: 0, roughnessFactor: 0.6 }
      if (image !== undefined) pbr.baseColorTexture = { index: textureFor(image) }
      const m: Record<string, unknown> = { name: `${image !== undefined ? 'textured' : 'color'}_${materials.length + 1}`, pbrMetallicRoughness: pbr }
      if (c[3] < 1) m.alphaMode = 'BLEND'
      materials.push(m)
      i = materials.length - 1
      materialIndex.set(key, i)
    }
    return i
  }

  for (const link of links) {
    const kept = link.pieces.filter((p) => p.idx.length >= 3 && p.pos.length >= 9)
    if (kept.length === 0) continue
    const byColor = new Map<number, LinkPiece[]>()
    for (const p of kept) {
      const m = materialFor(p.color, imageOf(p))
      byColor.set(m, [...(byColor.get(m) ?? []), p])
    }
    const primitives: object[] = []
    for (const [material, list] of byColor) {
      let verts = 0
      let count = 0
      for (const p of list) {
        verts += p.pos.length / 3
        count += p.idx.length
      }
      const pos = new Float32Array(verts * 3)
      const nrm = list.every((p) => p.nrm) ? new Float32Array(verts * 3) : null
      // one material is one image, so a primitive's pieces are all textured or none are
      const uv = imageOf(list[0]!) !== undefined ? new Float32Array(verts * 2) : null
      const idx = new Uint32Array(count)
      let v = 0
      let i = 0
      for (const p of list) {
        pos.set(p.pos, v * 3)
        if (nrm) nrm.set(p.nrm!, v * 3)
        if (uv) uv.set(p.uv!, v * 2)
        for (let k = 0; k < p.idx.length; k++) idx[i + k] = p.idx[k]! + v
        v += p.pos.length / 3
        i += p.idx.length
      }
      triangles += count / 3
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
      const small = verts <= 0xffff
      const outIdx = small ? Uint16Array.from(idx) : idx
      const indices = accessors.length
      accessors.push({ bufferView: bin.push(bytesOf(outIdx), ELEMENT_ARRAY_BUFFER), componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT, count: idx.length, type: 'SCALAR' })
      primitives.push({ attributes, indices, material })
    }
    // the mesh gets a name of its own: three's loader numbers a repeated name, and a primitive mesh named like a
    // later link's node (`link` + `link_1`) would be found in that node's place
    meshes.push({ name: `${link.name}_visual`, primitives })
    nodes.push({ name: link.name, mesh: meshes.length - 1 })
  }

  const gltf = {
    asset: { version: '2.0', generator: 'oip-web URDF import' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, j) => j) }],
    nodes,
    meshes,
    materials,
    accessors,
    ...(textures.length ? { textures, images: gltfImages } : {}),
    ...(webp ? { extensionsUsed: ['EXT_texture_webp'], extensionsRequired: ['EXT_texture_webp'] } : {}),
  }
  return { glb: packGlb(gltf, bin), triangles }
}
