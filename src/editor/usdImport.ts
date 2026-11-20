// Import a USD model (.usd / .usda / .usdc / .usdz, or a folder of layers) as a GLB.
//
// The USD reader is @huggingface/usd-web-viewer: USD composition (references, payloads, variants, instancing,
// overrides) in Rust compiled to wasm, run in its own worker, building three.js meshes and materials. Nothing here
// loads until an import starts: the package, its worker and its 2.3 MB wasm are their own chunks, kept out of the
// first frame and out of the offline precache (vite.config.ts globIgnores).
//
// What comes back is a three.js tree. This file turns it into what core/usdToGlb writes: triangles with their world
// transforms applied, and each material's maps baked into the images glTF reads. The reader samples any channel
// of an image with a scale and bias (UsdUVTexture); glTF reads fixed channels, so each output image is computed
// pixel by pixel from the reader's own per-map description (material.userData.patches).
//
// Orientation: the reader decodes images flipped (imageOrientation 'flipY', texture.flipY false) and keeps USD's
// UVs, whose origin is the bottom left. Writing those pixels and those UVs into a glTF, whose origin is the top
// left, samples the same texels, so neither is flipped here.
import * as THREE from 'three'
import { getOipModelApi } from './desktop/desktopModelBridge'
import { usdToGlb, type UsdImage, type UsdMaterial, type UsdPiece, type UsdTextureRef, type UsdToGlbStats, type UsdWrap } from '../core/usdToGlb'

export type UsdDetail = 'full' | 'reduced'

export interface UsdImportOptions {
  /** 'reduced' simplifies each mesh to about a quarter of its triangles */
  detail: UsdDetail
  /** the longest side of an imported texture, in pixels */
  maxTextureSize: number
}

export const DEFAULT_USD_OPTIONS: UsdImportOptions = { detail: 'full', maxTextureSize: 1024 }
export const USD_TEXTURE_SIZES = [512, 1024, 2048] as const

export const isUsdFile = (name: string): boolean => /\.(usd|usda|usdc|usdz)$/i.test(name)

/**
 * The files of a picked folder that could be its root layer: the USD files nearest the top. A model's own layers
 * (payloads, sub-layers) sit in folders below the file that pulls them in. Sorted, so the choice is stable.
 */
export function usdRootCandidates(paths: readonly string[]): string[] {
  const usd = paths.filter(isUsdFile).map((p) => p.replaceAll('\\', '/'))
  if (usd.length === 0) return []
  const depth = (p: string): number => p.split('/').length
  const top = Math.min(...usd.map(depth))
  return usd.filter((p) => depth(p) === top).sort()
}

export interface UsdImportStats extends UsdToGlbStats {
  /** meshes in the composed model, instances counted */
  parts: number
  /** triangles before 'reduced' detail */
  sourceTriangles: number
  layers: number
  /** what the reader could not show faithfully. `layer-missing` from a lone file usually means its folder is needed */
  warnings: { code: string; message: string }[]
}

/**
 * How many layers the model rooted at `root` pulls in that are not among `files`. A model is often several files,
 * and a lone root layer can be no more than an index of the others; this composes it without textures to find out
 * before anything is converted. Unreadable is 0: the conversion then says what is wrong.
 */
export async function missingUsdLayers(files: ReadonlyMap<string, Blob>, root: string): Promise<number> {
  const { loadUsd } = await import('@huggingface/usd-web-viewer')
  try {
    const loaded = await loadUsd(root, { files, textures: 'none' })
    try {
      await loaded.complete
      return loaded.info.stats.missing
    } finally {
      loaded.dispose()
    }
  } catch {
    return 0
  }
}

/**
 * On the desktop, the picked root layer's folder: the USD layers and images under it, keyed as the reader resolves
 * them, read by the shell from the file's own path. Null in a browser, which can read only what it was handed, and
 * for a file the shell cannot place or read.
 */
export async function usdFolderOf(file: File): Promise<{ files: Map<string, Blob>; root: string; folder: string } | null> {
  const api = getOipModelApi()
  const path = api?.pathOf(file)
  if (!api || !path || /\.usdz$/i.test(file.name)) return null
  const read = await api.readUsd(path)
  if ('error' in read || !read.files || !read.root) return null
  const files = new Map<string, Blob>(read.files.map((f) => [f.path, new Blob([f.bytes as Uint8Array<ArrayBuffer>])]))
  const folder = path.split(/[\\/]/).slice(-2, -1)[0] ?? ''
  return { files, root: read.root, folder }
}

/** The reader's description of how a material input samples its image: texel.channel * scale + bias. */
interface Patch {
  channel?: string
  scale?: number[]
  bias?: number[]
}

/**
 * Convert the USD model whose root layer is `root` (a key of `files`) to a GLB. `files` holds every file the model
 * may read, keyed by its path relative to the others (a picked folder's webkitRelativePath, or one .usdz).
 */
export async function importUsd(
  files: ReadonlyMap<string, Blob>,
  root: string,
  options: UsdImportOptions,
  onProgress?: (fraction: number) => void,
): Promise<{ glb: Uint8Array; stats: UsdImportStats }> {
  const { loadUsd } = await import('@huggingface/usd-web-viewer')
  const loaded = await loadUsd(root, {
    files,
    textures: 'full',
    maxTextureSize: options.maxTextureSize,
    onProgress: onProgress ? (p) => onProgress(p.fraction * 0.9) : undefined,
  })
  try {
    await loaded.complete
    loaded.root.updateMatrixWorld(true)
    const simplifier = options.detail === 'reduced' ? await loadSimplifier() : null
    const textures = new TextureBaker(options.maxTextureSize)
    const materials: UsdMaterial[] = []
    const materialIndex = new Map<string, number>()
    const byObject = new Map<THREE.Material, number>()
    const materialFor = async (m: THREE.Material): Promise<number> => {
      let i = byObject.get(m)
      if (i !== undefined) return i
      const out = await convertMaterial(m, textures)
      // materials alike but for their name are one: a model often has a copy of a material per part
      const key = JSON.stringify({ ...out, name: '' })
      i = materialIndex.get(key)
      if (i === undefined) {
        materials.push(out)
        i = materials.length - 1
        materialIndex.set(key, i)
      }
      byObject.set(m, i)
      return i
    }

    const pieces: UsdPiece[] = []
    let parts = 0
    let sourceTriangles = 0
    const meshes: THREE.Mesh[] = []
    loaded.root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
    })
    const instanceMatrix = new THREE.Matrix4()
    for (const mesh of meshes) {
      let geometry = mesh.geometry
      if (!geometry.getAttribute('normal')) {
        geometry = geometry.clone()
        geometry.computeVertexNormals()
      }
      const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null
      const copies = instanced ? instanced.count : 1
      for (let k = 0; k < copies; k++) {
        const world = mesh.matrixWorld.clone()
        if (instanced) world.multiply(instanceMatrix.fromArray(instanced.instanceMatrix.array, k * 16))
        parts++
        for (const group of groupsOf(geometry)) {
          const material = Array.isArray(mesh.material) ? mesh.material[group.materialIndex ?? 0] : mesh.material
          if (!material) continue
          const piece = pieceOf(geometry, group, world, await materialFor(material), uvChannelOf(material))
          if (!piece) continue
          sourceTriangles += piece.idx.length / 3
          pieces.push(simplifier ? simplify(piece, simplifier) : piece)
        }
      }
    }
    onProgress?.(0.95)
    const { glb, stats } = usdToGlb(pieces, materials, textures.images)
    onProgress?.(1)
    const warnings = loaded.info.warnings.map((w) => ({ code: w.code, message: w.message }))
    return { glb, stats: { ...stats, parts, sourceTriangles, layers: loaded.info.stats.layers, warnings } }
  } finally {
    loaded.dispose()
  }
}

/** A geometry's material groups, or one group over everything it draws. */
function groupsOf(g: THREE.BufferGeometry): { start: number; count: number; materialIndex?: number }[] {
  if (g.groups.length) return g.groups
  const count = g.index ? g.index.count : g.getAttribute('position').count
  return [{ start: 0, count, materialIndex: 0 }]
}

/** The UV set the material's maps read (three's texture.channel: 0 is `uv`, 1 is `uv1`, ...). */
function uvChannelOf(m: THREE.Material): number {
  const s = m as THREE.MeshStandardMaterial
  return (s.map ?? s.normalMap ?? s.roughnessMap ?? s.metalnessMap ?? s.aoMap ?? s.emissiveMap)?.channel ?? 0
}

/** One group's triangles as a piece: only the vertices they use, in world space; winding kept for a mirrored transform. */
function pieceOf(g: THREE.BufferGeometry, group: { start: number; count: number }, world: THREE.Matrix4, material: number, uvChannel: number): UsdPiece | null {
  const position = g.getAttribute('position')
  const normal = g.getAttribute('normal')
  const uv = g.getAttribute(uvChannel === 0 ? 'uv' : `uv${uvChannel}`) ?? g.getAttribute('uv')
  const index = g.index
  const end = Math.min(group.start + group.count, index ? index.count : position.count)
  const triCount = Math.floor((end - group.start) / 3)
  if (triCount === 0) return null
  const remap = new Int32Array(position.count).fill(-1)
  const used: number[] = []
  const idx = new Uint32Array(triCount * 3)
  for (let i = 0; i < triCount * 3; i++) {
    const v = index ? index.getX(group.start + i) : group.start + i
    if (remap[v] === -1) {
      remap[v] = used.length
      used.push(v)
    }
    idx[i] = remap[v]!
  }
  // a mirrored transform (negative determinant) turns the triangles inside out unless the winding is reversed
  if (world.determinant() < 0)
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]!
      idx[i + 1] = idx[i + 2]!
      idx[i + 2] = t
    }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(world)
  const pos = new Float32Array(used.length * 3)
  const nrm = normal ? new Float32Array(used.length * 3) : null
  const uvs = uv ? new Float32Array(used.length * 2) : null
  const v3 = new THREE.Vector3()
  used.forEach((v, j) => {
    v3.fromBufferAttribute(position, v).applyMatrix4(world).toArray(pos, j * 3)
    if (nrm && normal) v3.fromBufferAttribute(normal, v).applyMatrix3(normalMatrix).normalize().toArray(nrm, j * 3)
    if (uvs && uv) {
      uvs[j * 2] = uv.getX(v)
      uvs[j * 2 + 1] = uv.getY(v)
    }
  })
  return { material, pos, nrm, uv: uvs, idx }
}

type Simplifier = (typeof import('meshoptimizer'))['MeshoptSimplifier']

async function loadSimplifier(): Promise<Simplifier> {
  const { MeshoptSimplifier } = await import('meshoptimizer')
  await MeshoptSimplifier.ready
  return MeshoptSimplifier
}

/** Small parts are left as they are: their triangles are few and their shape is what they are made of. */
const SIMPLIFY_MIN_TRIANGLES = 200
const SIMPLIFY_RATIO = 0.25
/** the most a simplified surface may move, as a fraction of the piece's size */
const SIMPLIFY_ERROR = 0.01

/**
 * About a quarter of the piece's triangles. Vertices on an open edge stay put (LockBorder): a piece's UV seams are
 * open edges, since each side of a seam has vertices of its own, so textures don't tear.
 */
function simplify(p: UsdPiece, simplifier: Simplifier): UsdPiece {
  if (p.idx.length / 3 < SIMPLIFY_MIN_TRIANGLES) return p
  const target = Math.floor((p.idx.length * SIMPLIFY_RATIO) / 3) * 3
  const [idx] = simplifier.simplify(p.idx, p.pos, 3, target, SIMPLIFY_ERROR, ['LockBorder'])
  if (idx.length === 0 || idx.length >= p.idx.length) return p
  // keep only the vertices the simplified triangles still use
  const remap = new Int32Array(p.pos.length / 3).fill(-1)
  const used: number[] = []
  const out = new Uint32Array(idx.length)
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i]!
    if (remap[v] === -1) {
      remap[v] = used.length
      used.push(v)
    }
    out[i] = remap[v]!
  }
  const pick = (src: Float32Array | null, n: number): Float32Array | null => {
    if (!src) return null
    const dst = new Float32Array(used.length * n)
    used.forEach((v, j) => {
      for (let k = 0; k < n; k++) dst[j * n + k] = src[v * n + k]!
    })
    return dst
  }
  return { material: p.material, pos: pick(p.pos, 3)!, nrm: pick(p.nrm, 3), uv: pick(p.uv, 2), idx: out }
}

const WRAP: Record<number, UsdWrap> = { [THREE.RepeatWrapping]: 'repeat', [THREE.ClampToEdgeWrapping]: 'clamp', [THREE.MirroredRepeatWrapping]: 'mirror' }

/** The texture's UV transform and wrap, as glTF's KHR_texture_transform and sampler read them. */
function refOf(texture: THREE.Texture, image: number): UsdTextureRef {
  const ref: UsdTextureRef = { image, wrapS: WRAP[texture.wrapS] ?? 'repeat', wrapT: WRAP[texture.wrapT] ?? 'repeat' }
  // The reader writes UsdTransform2d straight into the matrix: [c*sx, -s*sy, tx; s*sx, c*sy, ty]. That is
  // KHR_texture_transform's translation * rotation * scale with the same angle, so the parts read back directly.
  if (!texture.matrixAutoUpdate) {
    const e = texture.matrix.elements
    const sx = Math.hypot(e[0]!, e[1]!)
    const sy = Math.hypot(e[3]!, e[4]!)
    const rotation = Math.atan2(e[1]!, e[0]!)
    if (sx !== 1 || sy !== 1 || e[6] !== 0 || e[7] !== 0 || rotation !== 0) {
      ref.offset = [e[6]!, e[7]!]
      ref.scale = [sx, sy]
      ref.rotation = rotation
    }
  }
  return ref
}

/** A material as glTF reads it: its factors, and its maps baked into glTF's fixed channels. */
async function convertMaterial(material: THREE.Material, textures: TextureBaker): Promise<UsdMaterial> {
  const m = material as THREE.MeshStandardMaterial
  const patches = (m.userData?.patches ?? {}) as Record<string, Patch | undefined>
  const name = materialName(m.name)
  const color = m.color ?? new THREE.Color(0.8, 0.8, 0.8)
  const out: UsdMaterial = {
    name,
    baseColor: [color.r, color.g, color.b, m.opacity ?? 1],
    metallic: m.metalness ?? 0,
    roughness: m.roughness ?? 1,
    alphaMode: m.alphaTest > 0 ? 'MASK' : m.transparent ? 'BLEND' : 'OPAQUE',
    doubleSided: m.side === THREE.DoubleSide,
  }
  if (m.alphaTest > 0) out.alphaCutoff = m.alphaTest
  if (m.emissive && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0)) out.emissive = [m.emissive.r, m.emissive.g, m.emissive.b]

  if (m.map || m.alphaMap) {
    const image = await textures.bake([
      { tex: m.map, patch: patches.diffuseColor, component: 0, colour: true },
      { tex: m.map, patch: patches.diffuseColor, component: 1, colour: true },
      { tex: m.map, patch: patches.diffuseColor, component: 2, colour: true },
      { tex: m.alphaMap, patch: patches.opacity, component: 0 },
    ])
    if (image !== null) out.baseColorTexture = refOf((m.map ?? m.alphaMap)!, image)
  }
  if (m.roughnessMap || m.metalnessMap || m.aoMap) {
    // occlusion R, roughness G, metalness B: one image serves both glTF slots that read it
    const image = await textures.bake([
      { tex: m.aoMap, patch: patches.occlusion, component: 0 },
      { tex: m.roughnessMap, patch: patches.roughness, component: 0 },
      { tex: m.metalnessMap, patch: patches.metallic, component: 0 },
      null,
    ])
    if (image !== null) {
      const ref = refOf((m.roughnessMap ?? m.metalnessMap ?? m.aoMap)!, image)
      if (m.roughnessMap || m.metalnessMap) out.metallicRoughnessTexture = ref
      if (m.aoMap) out.occlusionTexture = ref
    }
  }
  if (m.normalMap) {
    const n = (component: number): ChannelSource => ({ tex: m.normalMap, patch: patches.normal ?? NORMAL_PATCH, component, normal: true })
    const image = await textures.bake([n(0), n(1), n(2), null])
    if (image !== null) out.normalTexture = { ...refOf(m.normalMap, image), strength: Math.abs(m.normalScale?.x ?? 1) }
  }
  if (m.emissiveMap) {
    const e = (component: number): ChannelSource => ({ tex: m.emissiveMap, patch: patches.emissiveColor, component, colour: true })
    const image = await textures.bake([e(0), e(1), e(2), null])
    if (image !== null) out.emissiveTexture = refOf(m.emissiveMap, image)
  }
  return out
}

/**
 * A material's name as the Inspector lists it: the last segment of its USD path, without the opacity class some
 * libraries put first ("opaque__paper__decals_black_a" -> "paper_decals_black_a").
 */
export function materialName(path: string): string {
  const last = path.split('/').pop() ?? ''
  const tidy = last.replace(/^(opaque|translucent|transparent|masked|cutout)__/i, '').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '')
  return tidy || last || 'material'
}

/** three's own normal map decode, texel * 2 - 1, for a normal map the reader did not remap */
const NORMAL_PATCH: Patch = { channel: 'rgb', scale: [2, 2, 2, 2], bias: [-1, -1, -1, -1] }

/** One output channel: which texture and component it reads, through the reader's channel/scale/bias. */
interface ChannelSource {
  tex: THREE.Texture | null | undefined
  patch: Patch | undefined
  /** for an rgb read, which of r, g, b this output channel takes */
  component: number
  /** the image holds sRGB colour: the remap applies to linear values */
  colour?: boolean
  /** a decoded normal (-1..1) is stored as (n + 1) / 2 */
  normal?: boolean
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

/** Bakes images glTF can read from the reader's textures, encoded at most `maxSize` on a side, each kept once. */
class TextureBaker {
  readonly images: UsdImage[] = []
  private readonly byHash = new Map<string, number>()
  private readonly pixelCache = new Map<string, Uint8ClampedArray>()

  constructor(private readonly maxSize: number) {}

  /**
   * One RGBA image from four channel sources (null: 255). Returns its index in `images`, or null when no source
   * has an image the browser can draw.
   */
  async bake(channels: (ChannelSource | null)[]): Promise<number | null> {
    const sources = channels.filter((c): c is ChannelSource & { tex: THREE.Texture } => !!c?.tex && drawable(c.tex.image))
    if (sources.length === 0) return null
    const w0 = Math.max(...sources.map((s) => imageWidth(s.tex.image)))
    const h0 = Math.max(...sources.map((s) => imageHeight(s.tex.image)))
    const scale = Math.min(1, this.maxSize / Math.max(w0, h0))
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const out = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let c = 0; c < 4; c++) {
      const src = channels[c]
      if (!src?.tex || !drawable(src.tex.image)) continue
      const pixels = this.pixels(src.tex, w, h)
      const p = src.patch
      const ch = p?.channel && 'rgba'.includes(p.channel) && p.channel.length === 1 ? 'rgba'.indexOf(p.channel) : -1
      // an rgb read takes this output channel's own component; a single-channel read takes that channel
      const from = ch >= 0 ? ch : src.component
      const s = p?.scale?.[from] ?? 1
      const b = p?.bias?.[from] ?? 0
      const identity = s === 1 && b === 0 && !src.normal
      for (let i = 0; i < w * h; i++) {
        const texel = pixels[i * 4 + from]!
        if (identity) {
          out[i * 4 + c] = texel
          continue
        }
        let v = texel / 255
        if (src.colour) v = srgbToLinear(v)
        v = v * s + b
        if (src.normal) v = (v + 1) / 2
        if (src.colour) v = linearToSrgb(Math.min(1, Math.max(0, v)))
        out[i * 4 + c] = Math.round(v * 255)
      }
    }
    const encoded = await encode(out, w, h)
    const key = `${encoded.mimeType}:${hash(encoded.bytes)}:${encoded.bytes.length}`
    let index = this.byHash.get(key)
    if (index === undefined) {
      this.images.push(encoded)
      index = this.images.length - 1
      this.byHash.set(key, index)
    }
    return index
  }

  /** The texture's pixels at w x h, as stored (no colour conversion, not premultiplied where the browser allows). */
  private pixels(tex: THREE.Texture, w: number, h: number): Uint8ClampedArray {
    const key = `${tex.source.uuid}:${w}x${h}`
    const cached = this.pixelCache.get(key)
    if (cached) return cached
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
    if (!ctx) throw new Error('This browser cannot read images for conversion.')
    // an ImageBitmap from the reader's worker, or raw RGBA (a DataTexture's { data, width, height })
    const image = tex.image as CanvasImageSource | { data: ArrayLike<number>; width: number; height: number }
    if ('data' in image) ctx.drawImage(imageDataCanvas(new ImageData(Uint8ClampedArray.from(image.data), image.width, image.height)), 0, 0, w, h)
    else ctx.drawImage(image, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    this.pixelCache.set(key, data)
    return data
  }
}

function imageDataCanvas(data: ImageData): OffscreenCanvas {
  const c = new OffscreenCanvas(data.width, data.height)
  c.getContext('2d')!.putImageData(data, 0, 0)
  return c
}

function drawable(image: unknown): boolean {
  return !!image && imageWidth(image) > 0 && imageHeight(image) > 0
}
const imageWidth = (image: unknown): number => (image as { width?: number }).width ?? 0
const imageHeight = (image: unknown): number => (image as { height?: number }).height ?? 0

/** WebP where the browser encodes it (Chromium, Firefox), else PNG (Safari's canvas cannot write WebP). */
async function encode(rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): Promise<UsdImage> {
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0)
  let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
  if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/png' })
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type }
}

/** FNV-1a: enough to find images that encoded to the same bytes */
function hash(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return (h >>> 0).toString(16)
}
