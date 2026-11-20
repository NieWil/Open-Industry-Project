// Import a URDF robot (a .urdf file and the folder holding its meshes) as a new part: a rig link per URDF link, a
// joint per moving URDF joint, and one GLB holding every link's geometry in that link's frame.
//
// core/urdf.ts reads the file and core/urdfRig.ts builds the rig. This file loads the meshes the links name (STL,
// COLLADA .dae and OBJ, with three's loaders, each loaded only when an import starts) and the URDF primitives (box,
// cylinder, sphere), and writes them with core/urdfGlb.ts.
//
// Collision: each `<collision>` becomes a hidden box or cylinder link (core/urdfRig.ts). A collision mesh is loaded
// here only to measure it: it collides as the box that bounds it in its own frame.
//
// Colours: a COLLADA mesh's own materials are kept, and so are an OBJ's from the .mtl file it names. A material
// painted with an image keeps the image (shrunk to TEXTURE_MAX_SIZE, encoded once however many meshes use it) and the
// mesh its texture coordinates, through the welding and simplifying below. An STL file has no colours, so it and the
// primitives take the URDF material's colour, or a neutral grey when the visual names none. URDF colours are sRGB.

import * as THREE from 'three'
import { parseUrdf, parseUrdfRoot, resolveMeshPath, rpyToQuat, type UrdfCollision, type UrdfGeometry, type UrdfRobot, type UrdfVisual } from '../core/urdf'
import { expandXacro, isXacroEntry, isXacroText, XACRO_YAML_TAGS, xacroSwitches } from '../core/xacro'
import { safeRigName, urdfToRig, URDF_ASSET, type UrdfRigNote } from '../core/urdfRig'
import { linkMeshesToGlb, type LinkImage, type LinkMeshes, type LinkPiece } from '../core/urdfGlb'
import { robotBehavior } from '../core/robot/robotPart'
import { robotKinematicsOf, robotReadyPose } from '../core/robot/robotIk'
import type { RobotDecl } from '../core/robot/robotController'
import { bytesToBase64 } from '../core/parts/partAssets'
import type { Box3Like } from '../core/glbBox'
import type { PartAsset, PartMaterial, RigGeometry } from '../core/parts/partPackage'
import { ROBOT_TOOL_MATERIALS } from '../core/robot/robotTools'

/** The pose an imported arm idles in and calls Home: elbow up, tool down, in front of it (robotReadyPose). */
const readyPoseOf = (geometry: RigGeometry, decl: RobotDecl): Record<string, number> | null => {
  const kin = robotKinematicsOf(geometry, decl)
  return kin ? robotReadyPose(kin) : null
}

import { isUrdfFile } from './parts/modelPartImport'
export { isUrdfFile }

/** Above this many triangles in all, the meshes are simplified toward it: robot CAD exports are often far finer than
 *  a simulation needs, and every link is drawn on its own (a moving link is never merged with its neighbours). */
export const URDF_TRIANGLE_BUDGET = 150_000

/** The longest side an imported texture keeps (px): a robot is seen from metres away in a cell, and this keeps a
 *  textured robot's images near 1 MB (a UR20's one 2K image becomes 1K) */
export const TEXTURE_MAX_SIZE = 1024

export interface UrdfImport {
  /** the part's name: the robot's, else the file's */
  name: string
  geometry: RigGeometry
  /** the GLB as a part asset; absent when no link has geometry */
  assets: PartAsset[]
  /** the materials the app's tools draw with, for a robot that carries them */
  materials: PartMaterial[]
  /** the behavior: a robot's (the host's controller over the arm, with waypoints, jobs and a grip), or undefined for a
   *  rig with no joint above its tool, which gets New part's template */
  behavior?: string
  stats: {
    links: number
    joints: number
    triangles: number
    /** triangles before simplifying; equal to `triangles` when the robot was within the budget */
    sourceTriangles: number
    glbBytes: number
  }
  /** mesh file names the folder had no file for (those visuals are left out) */
  missing: string[]
  /** mesh files that were found but could not be read: an unsupported format or a broken file */
  unreadable: string[]
  notes: UrdfRigNote[]
  /** a xacro description's arguments and the values it was expanded with; empty for a URDF */
  args: Record<string, string>
  /** a xacro description's on/off arguments that add or remove links, with the value used (xacroSwitches) */
  switches: Record<string, boolean>
}

/**
 * The robot descriptions of a picked folder that could be the robot: its .urdf files and the xacro files that build
 * a robot (not those that only define macros for one), those nearest the top, sorted. A description package keeps
 * them in `urdf/` (or `robots/`) beside `meshes/`, so the shallowest is the robot and deeper ones are usually test or
 * variant files.
 */
export async function urdfCandidates(files: ReadonlyMap<string, Blob>): Promise<string[]> {
  const found: string[] = []
  for (const [path, blob] of files) {
    if (!isUrdfFile(path)) continue
    if (/\.xacro$/i.test(path) && !isXacroEntry(await blob.text())) continue
    found.push(path.replaceAll('\\', '/'))
  }
  if (found.length === 0) return []
  const depth = (p: string): number => p.split('/').length
  const top = Math.min(...found.map(depth))
  return found.filter((p) => depth(p) === top).sort()
}

/** the files a xacro description may read besides its meshes: other xacro files, URDF, YAML and package manifests */
const XACRO_TEXT = /\.(xacro|urdf|ya?ml)$|(^|\/)package\.xml$/i

/**
 * The robot `root` describes: a URDF read as it is, or a xacro description expanded with `args` first (core/xacro.ts),
 * with its arguments and the on/off ones among them that change the robot. Throws XacroError when the expansion stops;
 * its xacroArgChoices say what an argument can be when that is why.
 */
export async function readRobotDescription(
  files: ReadonlyMap<string, Blob>,
  root: string,
  args: Readonly<Record<string, string>> = {},
): Promise<{ robot: UrdfRobot; args: Record<string, string>; switches: Record<string, boolean> }> {
  const blob = files.get(root)
  if (!blob) throw new Error(`${root} is not among the picked files`)
  const text = await blob.text()
  if (!isXacroText(text)) return { robot: parseUrdf(text), args: {}, switches: {} }
  const texts = new Map<string, string>()
  for (const [path, b] of files) if (XACRO_TEXT.test(path)) texts.set(path, path === root ? text : await b.text())
  // the YAML reader loads only with a xacro import; each file is parsed once, since xacroSwitches expands again
  const { parse } = await import('yaml')
  const yaml = new Map<string, unknown>()
  const parseYaml = (t: string): unknown => {
    if (!yaml.has(t)) yaml.set(t, parse(t, { customTags: XACRO_YAML_TAGS }) as unknown)
    return yaml.get(t)
  }
  const xacroFiles = { paths: [...files.keys()], read: (p: string) => texts.get(p), parseYaml }
  const expanded = expandXacro(root, xacroFiles, args)
  return { robot: parseUrdfRoot(expanded.robot), args: expanded.args, switches: xacroSwitches(root, xacroFiles, expanded) }
}

/**
 * Import the robot whose description is `root` (a key of `files`): a URDF, or a xacro file expanded with `args`.
 * `files` holds the picked folder's files by relative path.
 */
export async function importUrdf(files: ReadonlyMap<string, Blob>, root: string, args: Readonly<Record<string, string>> = {}): Promise<UrdfImport> {
  const { robot, args: used, switches } = await readRobotDescription(files, root, args)
  const paths = [...files.keys()]
  const meshes = new MeshCache(files)
  const images = new ImageStore()
  const missing = new Set<string>()
  const unreadable = new Set<string>()

  // every visual as pieces in its link's frame
  const byLink = new Map<string, LinkPiece[]>()
  for (const link of robot.links) {
    const pieces: LinkPiece[] = []
    for (const visual of link.visuals) {
      const placed = visualMatrix(visual)
      if (visual.geometry.kind === 'mesh') {
        const path = resolveMeshPath(visual.geometry.filename, root, paths)
        if (!path) {
          missing.add(visual.geometry.filename)
          continue
        }
        const loaded = await meshes.get(path)
        if (!loaded) {
          unreadable.add(path)
          continue
        }
        const own = loaded.ownColors
        for (const m of loaded.meshes) {
          const world = placed.clone().multiply(m.matrix)
          const color = own ? m.color : urdfColor(visual)
          const image = own && m.map ? await images.add(m.map) : null
          pieces.push(...piecesOf(m.geometry, world, color, image === null ? undefined : { image, flipY: m.map!.flipY }))
        }
      } else {
        const g = primitiveGeometry(visual.geometry)
        if (g) pieces.push(...piecesOf(g, placed, urdfColor(visual)))
      }
    }
    if (pieces.length) byLink.set(link.name, pieces)
  }

  // each collision mesh's bounds in its own frame (scale applied): the hidden box it collides as
  const collisionBoxes = new Map<UrdfCollision, Box3Like>()
  for (const link of robot.links)
    for (const c of link.collisions) {
      if (c.geometry.kind !== 'mesh') continue
      const path = resolveMeshPath(c.geometry.filename, root, paths)
      if (!path) {
        missing.add(c.geometry.filename)
        continue
      }
      const loaded = await meshes.get(path)
      if (!loaded) {
        unreadable.add(path)
        continue
      }
      const scale = new THREE.Matrix4().makeScale(...c.geometry.scale)
      const box = new THREE.Box3()
      for (const m of loaded.meshes) {
        m.geometry.computeBoundingBox()
        box.union(m.geometry.boundingBox!.clone().applyMatrix4(scale.clone().multiply(m.matrix)))
      }
      if (!box.isEmpty()) collisionBoxes.set(c, { min: box.min.toArray(), max: box.max.toArray() })
    }

  const sourceTriangles = [...byLink.values()].flat().reduce((n, p) => n + p.idx.length / 3, 0)
  if (sourceTriangles > URDF_TRIANGLE_BUDGET) await simplifyAll(byLink, URDF_TRIANGLE_BUDGET / sourceTriangles)

  const boxes = new Map<string, Box3Like>()
  for (const [name, pieces] of byLink) boxes.set(name, boxOf(pieces))
  const rig = urdfToRig(robot, { drawn: new Set(byLink.keys()), boxes, collisionBoxes })
  const nodes: LinkMeshes[] = [...byLink].map(([urdfName, pieces]) => ({ name: rig.linkNames.get(urdfName) ?? safeRigName(urdfName), pieces }))
  const { glb, triangles } = linkMeshesToGlb(nodes, images.images)
  const assets: PartAsset[] = nodes.length ? [{ id: URDF_ASSET, mime: 'model/gltf-binary', data: bytesToBase64(glb) }] : []
  // a model picked by an argument (UR's ur_type) names the part with the robot, "ur (ur5e)", and a switch turned on
  // by its name, "panda (hand)"
  const chosen = Object.entries(args).flatMap(([k, v]) => (/^true$/i.test(v) ? [k] : v === '' || /^false$/i.test(v) ? [] : [v]))
  const name = (robot.name || root.split('/').pop()!.replace(/(\.urdf)?(\.xacro)?$/i, '')) + (chosen.length ? ` (${chosen.join(', ')})` : '')
  const decl = rig.robot
  const armJoints = decl?.joints?.map((n) => rig.geometry.joints.find((j) => j.name === n)!) ?? []
  return {
    name,
    geometry: rig.geometry,
    assets,
    materials: decl?.tool ? ROBOT_TOOL_MATERIALS : [],
    ...(decl ? { behavior: robotBehavior(name, decl, armJoints, { tools: decl.tool !== undefined, hand: rig.hand, ready: readyPoseOf(rig.geometry, decl) }) } : {}),
    stats: { links: rig.linkNames.size, joints: rig.geometry.joints.length, triangles, sourceTriangles, glbBytes: nodes.length ? glb.length : 0 },
    missing: [...missing].sort(),
    unreadable: [...unreadable].sort(),
    notes: rig.notes,
    args: used,
    switches,
  }
}

/** A visual's frame in its link's frame, with a mesh's `scale` applied first. */
function visualMatrix(v: UrdfVisual): THREE.Matrix4 {
  const q = rpyToQuat(v.origin.rpy)
  const scale = v.geometry.kind === 'mesh' ? v.geometry.scale : [1, 1, 1]
  return new THREE.Matrix4().compose(new THREE.Vector3(...v.origin.xyz), new THREE.Quaternion(q[0], q[1], q[2], q[3]), new THREE.Vector3(scale[0], scale[1], scale[2]))
}

const DEFAULT_GREY = 0.7

/** The visual's URDF colour as linear RGBA. */
function urdfColor(v: UrdfVisual): LinkPiece['color'] {
  const [r, g, b, a] = v.rgba ?? [DEFAULT_GREY, DEFAULT_GREY, DEFAULT_GREY, 1]
  const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)
  return [c.r, c.g, c.b, a]
}

/** URDF's primitives: a box centred on the origin, a cylinder along Z, a sphere. */
function primitiveGeometry(g: Exclude<UrdfGeometry, { kind: 'mesh' }>): THREE.BufferGeometry | null {
  switch (g.kind) {
    case 'box':
      return g.size.every((n) => n > 0) ? new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2]) : null
    case 'cylinder':
      // three's cylinder runs along Y
      return g.radius > 0 && g.length > 0 ? new THREE.CylinderGeometry(g.radius, g.radius, g.length, 32).rotateX(Math.PI / 2) : null
    case 'sphere':
      return g.radius > 0 ? new THREE.SphereGeometry(g.radius, 24, 16) : null
  }
}

/** One mesh of a loaded file, in the file's frame, with the colour its material gives it (linear RGBA) and the image
 *  it is painted with, if any. */
interface FileMesh {
  geometry: THREE.BufferGeometry
  matrix: THREE.Matrix4
  color: LinkPiece['color']
  map: THREE.Texture | null
}

/** Loaded mesh files by path, each read once: a gripper's two fingers often share one file. */
class MeshCache {
  private readonly cache = new Map<string, Promise<{ meshes: FileMesh[]; ownColors: boolean } | null>>()
  constructor(private readonly files: ReadonlyMap<string, Blob>) {}

  get(path: string): Promise<{ meshes: FileMesh[]; ownColors: boolean } | null> {
    let p = this.cache.get(path)
    if (!p) {
      p = this.load(path).catch(() => null)
      this.cache.set(path, p)
    }
    return p
  }

  private async load(path: string): Promise<{ meshes: FileMesh[]; ownColors: boolean } | null> {
    const blob = this.files.get(path)
    if (!blob) return null
    const ext = path.split('.').pop()!.toLowerCase()
    if (ext === 'stl') {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
      const geometry = new STLLoader().parse(await blob.arrayBuffer())
      return { meshes: [{ geometry, matrix: new THREE.Matrix4(), color: [1, 1, 1, 1], map: null }], ownColors: false }
    }
    if (ext === 'dae') {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
      const images = folderImages(this.files)
      const collada = new ColladaLoader(images.manager).parse(await blob.text(), `${dirOf(path)}/`)
      await images.loaded()
      if (!collada) return null
      // three's loader turns a Z_UP file to Y-up; a URDF link frame is Z-up, so turn the result back. A Z_UP file
      // then stays as authored and a Y_UP one stands up in the link frame, as ROS tools show them.
      const toZUp = new THREE.Matrix4().makeRotationX(Math.PI / 2)
      return { meshes: meshesOf(collada.scene).map((m) => ({ ...m, matrix: toZUp.clone().multiply(m.matrix) })), ownColors: true }
    }
    if (ext === 'obj') {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
      const text = await blob.text()
      const loader = new OBJLoader()
      // the .mtl file the OBJ names gives its colours and images; without one it keeps OBJLoader's own grey unless the
      // URDF gives a colour
      const mtlName = /^\s*mtllib\s+(.+?)\s*$/m.exec(text)?.[1]
      const mtlPath = mtlName ? findFile(this.files, `${dirOf(path)}/${mtlName}`) : null
      const mtl = mtlPath ? this.files.get(mtlPath) : undefined
      if (!mtl) return { meshes: meshesOf(loader.parse(text)), ownColors: false }
      const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js')
      const images = folderImages(this.files)
      const creator = new MTLLoader(images.manager).parse(await mtl.text(), `${dirOf(mtlPath!)}/`)
      creator.preload()
      const group = loader.setMaterials(creator).parse(text)
      await images.loaded()
      return { meshes: meshesOf(group), ownColors: true }
    }
    return null
  }
}

/** a one-pixel PNG: what an image the folder does not have loads as, instead of a request off the page */
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
/** how long a mesh file's images may take to load before the mesh is taken without them (ms) */
const IMAGE_LOAD_MS = 15_000

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/')

/**
 * The folder file an image reference names: the path as written from the mesh file's folder (`..` and `./` worked
 * out, a `file://` prefix dropped, since descriptions are often written on the author's machine), else the one file
 * of that name anywhere in the folder. Null when there is none, or several and none at the written path.
 */
function findFile(files: ReadonlyMap<string, Blob>, ref: string): string | null {
  let p = decodeURIComponent(ref.replaceAll('\\', '/'))
  const scheme = p.lastIndexOf('file://')
  if (scheme >= 0) p = p.slice(scheme + 'file://'.length)
  const parts: string[] = []
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') parts.pop()
    else parts.push(s)
  }
  const exact = parts.join('/')
  if (files.has(exact)) return exact
  const name = parts[parts.length - 1]?.toLowerCase()
  const same = [...files.keys()].filter((k) => k.split('/').pop()!.toLowerCase() === name)
  return same.length === 1 ? same[0]! : null
}

/**
 * A loading manager that serves a mesh file's images from the picked folder (as object URLs, so nothing is requested
 * off the page; a missing one loads as a blank pixel), and `loaded()`, which waits for them and frees the URLs. A
 * mesh's loader asks for its images while it parses, so they are all asked for by the time `loaded()` is called.
 */
function folderImages(files: ReadonlyMap<string, Blob>): { manager: THREE.LoadingManager; loaded(): Promise<void> } {
  const manager = new THREE.LoadingManager()
  const urls: string[] = []
  manager.setURLModifier((url) => {
    // an image inlined in the file comes through with the mesh's folder in front of it
    const data = url.indexOf('data:')
    if (data >= 0) return url.slice(data)
    const path = findFile(files, url)
    if (!path) return BLANK_PNG
    const u = URL.createObjectURL(files.get(path)!)
    urls.push(u)
    return u
  })
  let started = false
  let done: () => void = () => {}
  const finished = new Promise<void>((resolve) => (done = resolve))
  manager.onStart = () => (started = true)
  manager.onLoad = () => done()
  return {
    manager,
    async loaded() {
      if (started) await Promise.race([finished, new Promise((r) => setTimeout(r, IMAGE_LOAD_MS))])
      for (const u of urls) URL.revokeObjectURL(u)
    },
  }
}

/**
 * The images meshes are painted with, encoded for the GLB: each shrunk to TEXTURE_MAX_SIZE and encoded once, as WebP
 * where the browser can write it (else PNG), however many meshes use it. A blank or unreadable image is no image.
 */
class ImageStore {
  readonly images: LinkImage[] = []
  private readonly bySource = new Map<string, Promise<number | null>>()
  /** encoded bytes already stored: each mesh file loads its own copy of a shared image (a UR20's seven meshes one
   *  texture), and identical encodings are one image */
  private readonly byBytes = new Map<string, number>()

  add(tex: THREE.Texture): Promise<number | null> {
    let p = this.bySource.get(tex.source.uuid)
    if (!p) {
      p = this.encode(tex).catch(() => null)
      this.bySource.set(tex.source.uuid, p)
    }
    return p
  }

  private async encode(tex: THREE.Texture): Promise<number | null> {
    const image = tex.image as CanvasImageSource & { width?: number; height?: number }
    const w0 = image?.width ?? 0
    const h0 = image?.height ?? 0
    // the blank pixel a missing image loads as
    if (w0 <= 1 && h0 <= 1) return null
    const scale = Math.min(1, TEXTURE_MAX_SIZE / Math.max(w0, h0))
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(w0 * scale)), Math.max(1, Math.round(h0 * scale)))
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
    if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let h = 0x811c9dc5
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
    const key = `${blob.type}:${bytes.length}:${(h >>> 0).toString(16)}`
    const known = this.byBytes.get(key)
    if (known !== undefined) return known
    this.images.push({ bytes, mimeType: blob.type })
    this.byBytes.set(key, this.images.length - 1)
    return this.images.length - 1
  }
}

/** Every mesh under `root`, with its transform relative to `root` (a COLLADA file's up axis and unit included). */
function meshesOf(root: THREE.Object3D): FileMesh[] {
  root.updateMatrixWorld(true)
  const out: FileMesh[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }]
    for (const group of groups) {
      const m = mats[group.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined
      const c = m?.color ?? new THREE.Color(DEFAULT_GREY, DEFAULT_GREY, DEFAULT_GREY)
      const alpha = m?.transparent ? (m.opacity ?? 1) : 1
      const geometry = groups.length > 1 ? subGeometry(mesh.geometry, group.start, group.count) : mesh.geometry
      out.push({ geometry, matrix: mesh.matrixWorld.clone(), color: [c.r, c.g, c.b, alpha], map: m?.map ?? null })
    }
  })
  return out
}

/** The triangles of one material group, as a geometry of its own. */
function subGeometry(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal', 'uv']) {
    const a = g.getAttribute(name)
    if (a) out.setAttribute(name, a)
  }
  const total = g.index ? g.index.count : g.getAttribute('position').count
  const end = Math.min(start + count, total)
  const idx = new Uint32Array(end - start)
  for (let i = start; i < end; i++) idx[i - start] = g.index ? g.index.getX(i) : i
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

/** A geometry's triangles under `world` as one piece, welded, normals kept; painted with `texture.image` when the
 *  geometry has texture coordinates. */
function piecesOf(source: THREE.BufferGeometry, world: THREE.Matrix4, color: LinkPiece['color'], texture?: { image: number; flipY: boolean }): LinkPiece[] {
  // STL and COLLADA both load as one vertex per triangle corner, so every geometry is welded. A closed welded mesh has
  // about half a vertex per triangle. Normals stored per corner (a Panda link: 61k corners, 60.9k distinct position
  // and normal pairs) share nothing and cost three vertices a triangle, so those are recomputed with a crease angle.
  // A textured mesh welds only corners whose texture coordinates match too, so an image's seams stay seams.
  const textured = texture !== undefined && source.getAttribute('uv') !== undefined
  if (!textured) source = withoutUv(source)
  let g = weld(source)
  const triangles = (g.index?.count ?? 0) / 3
  if (!g.getAttribute('normal') || g.getAttribute('position').count > SHARED_VERTS_PER_TRIANGLE * triangles) g = creased(g)
  const position = g.getAttribute('position')
  const nrmAttr = g.getAttribute('normal')
  const count = g.index ? g.index.count : position.count
  const triCount = Math.floor(count / 3)
  if (triCount === 0) return []
  const idx = new Uint32Array(triCount * 3)
  for (let i = 0; i < idx.length; i++) idx[i] = g.index ? g.index.getX(i) : i
  // a mirrored scale (common for a left/right pair from one file) turns the triangles inside out unless the winding
  // is reversed
  if (world.determinant() < 0)
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]!
      idx[i + 1] = idx[i + 2]!
      idx[i + 2] = t
    }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(world)
  const pos = new Float32Array(position.count * 3)
  const nrm = new Float32Array(position.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).applyMatrix4(world).toArray(pos, i * 3)
    v.fromBufferAttribute(nrmAttr, i).applyMatrix3(normalMatrix).normalize().toArray(nrm, i * 3)
  }
  const uvAttr = textured ? g.getAttribute('uv') : undefined
  if (!uvAttr || !texture) return [{ color, pos, nrm, idx }]
  // glTF's v runs down the image; a texture three flips on upload has it running up
  const uv = new Float32Array(position.count * 2)
  for (let i = 0; i < position.count; i++) {
    uv[i * 2] = uvAttr.getX(i)
    uv[i * 2 + 1] = texture.flipY ? 1 - uvAttr.getY(i) : uvAttr.getY(i)
  }
  return [{ color, pos, nrm, idx, uv, image: texture.image }]
}

/** `g` without texture coordinates, so an untextured mesh welds on position and normal alone. */
function withoutUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute('uv')) return g
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal']) {
    const a = g.getAttribute(name)
    if (a) out.setAttribute(name, a)
  }
  if (g.index) out.setIndex(g.index)
  return out
}

/** One vertex per distinct position and normal, over the triangles `g` draws (its index, if it has one). A flat
 *  face's triangles share their normal, so this joins each flat face and leaves its edges sharp. Only the vertices
 *  the triangles use are kept, so a material group of a shared vertex buffer brings just its own. */
function weld(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = g.getAttribute('position')
  const normal = g.getAttribute('normal')
  const uvAttr = g.getAttribute('uv')
  const key = (i: number): string => {
    const p = `${position.getX(i).toFixed(6)},${position.getY(i).toFixed(6)},${position.getZ(i).toFixed(6)}`
    const n = normal ? `${p},${normal.getX(i).toFixed(3)},${normal.getY(i).toFixed(3)},${normal.getZ(i).toFixed(3)}` : p
    return uvAttr ? `${n},${uvAttr.getX(i).toFixed(5)},${uvAttr.getY(i).toFixed(5)}` : n
  }
  const seen = new Map<string, number>()
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const corners = g.index ? g.index.count : position.count
  const idx = new Uint32Array(corners)
  for (let c = 0; c < corners; c++) {
    const i = g.index ? g.index.getX(c) : c
    const k = key(i)
    let j = seen.get(k)
    if (j === undefined) {
      j = pos.length / 3
      seen.set(k, j)
      pos.push(position.getX(i), position.getY(i), position.getZ(i))
      if (normal) nrm.push(normal.getX(i), normal.getY(i), normal.getZ(i))
      if (uvAttr) uv.push(uvAttr.getX(i), uvAttr.getY(i))
    }
    idx[c] = j
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  if (normal) out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  if (uvAttr) out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

/** past this many vertices a triangle, a welded mesh's normals are taken to be per corner */
const SHARED_VERTS_PER_TRIANGLE = 1.5
/** faces meeting at less than this stay smooth; a sharper edge keeps a normal per side */
const CREASE_COS = Math.cos((30 * Math.PI) / 180)

/** `g` (indexed) with its normals recomputed: positions welded, each corner's normal the area-weighted mean of the
 *  faces around its position that meet its own face within the crease angle, then equal corners joined. */
function creased(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = g.getAttribute('position')
  const uvAttr = g.getAttribute('uv')
  const index = g.index!
  const corners = index.count - (index.count % 3)
  // positions welded
  const pid = new Uint32Array(corners)
  const ids = new Map<string, number>()
  const pts: number[] = []
  for (let c = 0; c < corners; c++) {
    const i = index.getX(c)
    const k = `${position.getX(i).toFixed(6)},${position.getY(i).toFixed(6)},${position.getZ(i).toFixed(6)}`
    let p = ids.get(k)
    if (p === undefined) {
      p = pts.length / 3
      ids.set(k, p)
      pts.push(position.getX(i), position.getY(i), position.getZ(i))
    }
    pid[c] = p
  }
  // face normals, area-weighted (unnormalised cross products), and the faces around each position
  const faces = corners / 3
  const fn = new Float64Array(faces * 3)
  const around: number[][] = Array.from({ length: pts.length / 3 }, () => [])
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [pid[f * 3]! * 3, pid[f * 3 + 1]! * 3, pid[f * 3 + 2]! * 3]
    const u = [pts[b]! - pts[a]!, pts[b + 1]! - pts[a + 1]!, pts[b + 2]! - pts[a + 2]!]
    const v = [pts[c]! - pts[a]!, pts[c + 1]! - pts[a + 1]!, pts[c + 2]! - pts[a + 2]!]
    fn[f * 3] = u[1]! * v[2]! - u[2]! * v[1]!
    fn[f * 3 + 1] = u[2]! * v[0]! - u[0]! * v[2]!
    fn[f * 3 + 2] = u[0]! * v[1]! - u[1]! * v[0]!
    for (let k = 0; k < 3; k++) around[pid[f * 3 + k]!]!.push(f)
  }
  const unit = (f: number): [number, number, number] => {
    const l = Math.hypot(fn[f * 3]!, fn[f * 3 + 1]!, fn[f * 3 + 2]!) || 1
    return [fn[f * 3]! / l, fn[f * 3 + 1]! / l, fn[f * 3 + 2]! / l]
  }
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const idx = new Uint32Array(corners)
  const seen = new Map<string, number>()
  for (let c = 0; c < corners; c++) {
    const own = unit(Math.floor(c / 3))
    const n: [number, number, number] = [0, 0, 0]
    for (const g2 of around[pid[c]!]!) {
      const o = unit(g2)
      if (own[0] * o[0] + own[1] * o[1] + own[2] * o[2] < CREASE_COS) continue
      n[0] += fn[g2 * 3]!
      n[1] += fn[g2 * 3 + 1]!
      n[2] += fn[g2 * 3 + 2]!
    }
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    const nx = n[0]! / l
    const ny = n[1]! / l
    const nz = n[2]! / l
    // a corner keeps its own texture coordinates: two corners at one point on either side of an image seam differ
    const u = uvAttr ? uvAttr.getX(index.getX(c)) : 0
    const w = uvAttr ? uvAttr.getY(index.getX(c)) : 0
    const k = uvAttr ? `${pid[c]},${nx.toFixed(3)},${ny.toFixed(3)},${nz.toFixed(3)},${u.toFixed(5)},${w.toFixed(5)}` : `${pid[c]},${nx.toFixed(3)},${ny.toFixed(3)},${nz.toFixed(3)}`
    let j = seen.get(k)
    if (j === undefined) {
      j = pos.length / 3
      seen.set(k, j)
      const p = pid[c]! * 3
      pos.push(pts[p]!, pts[p + 1]!, pts[p + 2]!)
      nrm.push(nx, ny, nz)
      if (uvAttr) uv.push(u, w)
    }
    idx[c] = j
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  if (uvAttr) out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

function boxOf(pieces: readonly LinkPiece[]): Box3Like {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of pieces)
    for (let i = 0; i < p.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p.pos[i + k]!)
        max[k] = Math.max(max[k]!, p.pos[i + k]!)
      }
  return { min, max }
}

/** Small pieces are left as they are: their triangles are few and their shape is what they are made of. */
const SIMPLIFY_MIN_TRIANGLES = 200
/** the most a simplified surface may move, as a fraction of the piece's size */
const SIMPLIFY_ERROR = 0.01

/** Simplify every piece toward `ratio` of its triangles. Open edges stay put (LockBorder), so a seam between two
 *  flat faces, where each side has vertices of its own, does not open a crack. */
async function simplifyAll(byLink: Map<string, LinkPiece[]>, ratio: number): Promise<void> {
  const { MeshoptSimplifier } = await import('meshoptimizer')
  await MeshoptSimplifier.ready
  for (const [name, pieces] of byLink) {
    byLink.set(
      name,
      pieces.map((p) => {
        if (p.idx.length / 3 < SIMPLIFY_MIN_TRIANGLES) return p
        const target = Math.max(3, Math.floor((p.idx.length * ratio) / 3) * 3)
        const [idx] = MeshoptSimplifier.simplify(p.idx, p.pos, 3, target, SIMPLIFY_ERROR, ['LockBorder'])
        if (idx.length === 0 || idx.length >= p.idx.length) return p
        return compact({ ...p, idx })
      }),
    )
  }
}

/** Keep only the vertices a piece's triangles use. */
function compact(p: LinkPiece): LinkPiece {
  const remap = new Int32Array(p.pos.length / 3).fill(-1)
  const used: number[] = []
  const idx = new Uint32Array(p.idx.length)
  for (let i = 0; i < p.idx.length; i++) {
    const v = p.idx[i]!
    if (remap[v] === -1) {
      remap[v] = used.length
      used.push(v)
    }
    idx[i] = remap[v]!
  }
  const pos = new Float32Array(used.length * 3)
  const nrm = p.nrm ? new Float32Array(used.length * 3) : null
  const uv = p.uv ? new Float32Array(used.length * 2) : null
  used.forEach((v, j) => {
    pos.set(p.pos.subarray(v * 3, v * 3 + 3), j * 3)
    if (nrm) nrm.set(p.nrm!.subarray(v * 3, v * 3 + 3), j * 3)
    if (uv) uv.set(p.uv!.subarray(v * 2, v * 2 + 2), j * 2)
  })
  return { ...p, pos, nrm, idx, ...(uv ? { uv } : {}) }
}
