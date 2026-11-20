// Read a GLB's geometry extents without a renderer: the container's JSON chunk, each POSITION accessor's min/max,
// and the node tree's TRS. Used by the CLIs (scripts/lib/glb.mjs re-exports it for measure-glb.mjs and
// check-part.mjs) and by the import_model agent tool, which places a mesh link's box the way the host places the
// mesh, so "the model is where the part says it is" can be checked headless. Accessor min/max survive Draco, so a
// compressed GLB measures too. No imports: the CLIs load this file with node's own type stripping.

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON, read as the spec lays it out */
type GltfJson = any
/* eslint-enable @typescript-eslint/no-explicit-any */

export type Vec3 = [number, number, number]
export interface Box3Like {
  min: number[]
  max: number[]
}

/** The glTF JSON of a GLB container. Throws on bytes that are not a GLB. */
export function parseGlb(buf: Uint8Array): { json: GltfJson } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb')
  let off = 12
  let json: GltfJson = null
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const start = off + 8
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(buf.subarray(start, start + len)))
    off = start + len + ((4 - (len % 4)) % 4)
  }
  return { json }
}

// 4x4 column-major matrix helpers
export function ident(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}
export function mul(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!
      o[c * 4 + r] = s
    }
  return o
}
export function fromTRS(t?: readonly number[], r?: readonly number[], s?: readonly number[]): number[] {
  const [x, y, z, w] = (r ?? [0, 0, 0, 1]) as number[]
  const [sx, sy, sz] = (s ?? [1, 1, 1]) as number[]
  const [tx, ty, tz] = (t ?? [0, 0, 0]) as number[]
  const x2 = x! + x!, y2 = y! + y!, z2 = z! + z!
  const xx = x! * x2, xy = x! * y2, xz = x! * z2
  const yy = y! * y2, yz = y! * z2, zz = z! * z2
  const wx = w! * x2, wy = w! * y2, wz = w! * z2
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ]
}
export function nodeMatrix(n: GltfJson): number[] {
  return n.matrix ? n.matrix.slice() : fromTRS(n.translation, n.rotation, n.scale)
}
export function apply(m: readonly number[], p: readonly number[]): Vec3 {
  return [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!]
}

export const emptyBox = (): Box3Like => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
export const isEmpty = (b: Box3Like): boolean => !(b.min[0]! <= b.max[0]!)
export function growBox(box: Box3Like, p: readonly number[]): void {
  for (let k = 0; k < 3; k++) {
    box.min[k] = Math.min(box.min[k]!, p[k]!)
    box.max[k] = Math.max(box.max[k]!, p[k]!)
  }
}

/** The local-AABB corners of one mesh's primitives, transformed by `m`, grown into `box`. */
function growMesh(json: GltfJson, meshIndex: number, m: readonly number[], box: Box3Like): void {
  for (const prim of json.meshes?.[meshIndex]?.primitives ?? []) {
    const a = json.accessors?.[prim.attributes?.POSITION]
    if (!a?.min || !a?.max) continue
    for (let i = 0; i < 8; i++) growBox(box, apply(m, [i & 1 ? a.max[0] : a.min[0], i & 2 ? a.max[1] : a.min[1], i & 4 ? a.max[2] : a.min[2]]))
  }
}

/** The fields of a mesh link's shape that decide which part of the GLB it draws, and at what size. */
export interface MeshShapeLike {
  node?: string
  hideNodes?: readonly string[]
  keepNode?: string
  fitHeight?: number
  scale?: number
  /** nodes other links of the same asset keep (drawnElsewhere), left out of what this one keeps */
  drawnElsewhere?: readonly string[]
}

/** A rig link as far as carving goes: its shape's asset and which of its nodes it draws. */
interface CarvingLink {
  shape: { kind: string; asset?: string; node?: string; keepNode?: string }
}

/**
 * The GLB nodes other mesh links keep (`keepNode`) out of the asset `link` draws. Each node is drawn by one link,
 * the nearest that keeps it, so `link` leaves these out of whatever it keeps: a whole-scene link leaves out every
 * piece split from it, and a piece leaves out a piece split from inside it. Undefined when there are none, and for
 * a `node` ref, which draws one mesh as it is.
 */
export function drawnElsewhere(links: readonly CarvingLink[], link: CarvingLink): string[] | undefined {
  const s = link.shape
  if (s.kind !== 'mesh' || s.node !== undefined) return undefined
  const out: string[] = []
  for (const l of links) {
    const o = l.shape
    if (l === link || o.kind !== 'mesh' || o.asset !== s.asset || o.node !== undefined || !o.keepNode || o.keepNode === s.keepNode) continue
    if (!out.includes(o.keepNode)) out.push(o.keepNode)
  }
  return out.length > 0 ? out : undefined
}

/**
 * The box a mesh link's GLB occupies in the LINK's frame, mirroring how the host builds it:
 * - `node`: that node's mesh alone, in its MESH-LOCAL frame (its transform reset);
 * - whole scene: the full tree, normalised by `fitHeight` (scale to height, XZ-centred, underside on y=0) using
 *   the FULL scene's box, then carved - `hideNodes` drops subtrees, `keepNode` keeps one subtree, and
 *   `drawnElsewhere` drops the subtrees other links keep from inside it;
 * - `scale` multiplies the result. (`sizeParams` node stretching is not applied: default params give ~1.)
 */
export function meshLinkBox(json: GltfJson, shape: MeshShapeLike): Box3Like | null {
  const box = emptyBox()
  const nodes: GltfJson[] = json.nodes ?? []
  if (shape.node !== undefined) {
    const n = nodes.find((x) => x.name === shape.node)
    if (n?.mesh != null) growMesh(json, n.mesh, ident(), box)
  } else {
    const hide = new Set(shape.hideNodes ?? [])
    const elsewhere = new Set(shape.drawnElsewhere ?? [])
    const scene = json.scenes?.[json.scene ?? 0]
    const full = emptyBox()
    const carved = emptyBox()
    // `kept`: inside the keepNode subtree (always true without a keepNode)
    const visit = (i: number, parent: readonly number[], keptAbove: boolean): void => {
      const n = nodes[i]
      const world = mul(parent, nodeMatrix(n))
      const kept = keptAbove || n.name === shape.keepNode
      const hidden = hide.has(n.name) || (kept && n.name !== shape.keepNode && elsewhere.has(n.name))
      if (n.mesh != null) {
        growMesh(json, n.mesh, world, full)
        if (kept && !hidden) growMesh(json, n.mesh, world, carved)
      }
      // a hidden node drops its WHOLE subtree from the carve, but the fit still measures it
      for (const c of n.children ?? []) {
        if (hidden) visitFullOnly(c, world)
        else visit(c, world, kept)
      }
    }
    const visitFullOnly = (i: number, parent: readonly number[]): void => {
      const n = nodes[i]
      const world = mul(parent, nodeMatrix(n))
      if (n.mesh != null) growMesh(json, n.mesh, world, full)
      for (const c of n.children ?? []) visitFullOnly(c, world)
    }
    for (const r of scene?.nodes ?? []) visit(r, ident(), shape.keepNode === undefined)
    if (isEmpty(carved)) return null
    let s = 1
    let t = [0, 0, 0]
    if (typeof shape.fitHeight === 'number' && full.max[1]! > full.min[1]!) {
      s = shape.fitHeight / (full.max[1]! - full.min[1]!)
      t = [-((full.min[0]! + full.max[0]!) / 2) * s, -full.min[1]! * s, -((full.min[2]! + full.max[2]!) / 2) * s]
    }
    for (let k = 0; k < 3; k++) {
      box.min[k] = carved.min[k]! * s + t[k]!
      box.max[k] = carved.max[k]! * s + t[k]!
    }
  }
  if (isEmpty(box)) return null
  const u = typeof shape.scale === 'number' ? shape.scale : 1
  return { min: box.min.map((v) => v * u), max: box.max.map((v) => v * u) }
}
