// Read a URDF robot description: the links, their visual geometry and the joints between them.
//
// URDF is the open robot description format of ROS. A robot is a tree of links joined by joints; each joint places
// its child link in its parent's frame (`origin`) and moves it about or along `axis`, given in the child's frame.
// Units are metres and radians, +Z is up. core/urdfRig.ts turns the result into a part's rig.
//
// parseUrdf reads plain URDF and refuses xacro with a code of its own; core/xacro.ts expands a xacro description,
// whose result parseUrdfRoot reads.

import { parseXml, xmlKid, xmlKids, type XmlNode } from './xml'
import { isXacroText } from './xacro'

export type UrdfVec3 = [number, number, number]

/** A frame relative to another: translate by `xyz`, then rotate by `rpy` (roll about X, pitch about Y, yaw about Z,
 *  about the fixed axes, in that order). */
export interface UrdfPose {
  xyz: UrdfVec3
  rpy: UrdfVec3
}

export type UrdfGeometry =
  /** `filename` as written: `package://<package>/<path>`, `file://<path>` or a path relative to the URDF file */
  | { kind: 'mesh'; filename: string; scale: UrdfVec3 }
  | { kind: 'box'; size: UrdfVec3 }
  /** a cylinder along its local Z */
  | { kind: 'cylinder'; radius: number; length: number }
  | { kind: 'sphere'; radius: number }

export interface UrdfVisual {
  origin: UrdfPose
  geometry: UrdfGeometry
  /** the colour URDF gives the visual, its named material resolved; absent when it names none */
  rgba?: [number, number, number, number]
}

/** A link's collision geometry: what it is solid as, apart from how it looks. */
export interface UrdfCollision {
  origin: UrdfPose
  geometry: UrdfGeometry
}

export interface UrdfLink {
  name: string
  visuals: UrdfVisual[]
  collisions: UrdfCollision[]
}

export type UrdfJointType = 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar'

export interface UrdfJoint {
  name: string
  type: UrdfJointType
  parent: string
  child: string
  /** the child link's frame in the parent link's frame, at joint value 0 */
  origin: UrdfPose
  /** in the child link's frame; URDF's default is +X */
  axis: UrdfVec3
  /** radians for a revolute joint, metres for a prismatic one; absent when the file gives no `<limit>` */
  limit?: { lower: number; upper: number; velocity?: number }
  /** this joint follows another: value = joint's value × multiplier + offset */
  mimic?: { joint: string; multiplier: number; offset: number }
}

export interface UrdfRobot {
  name: string
  links: UrdfLink[]
  joints: UrdfJoint[]
}

/** Why a file could not be read. `xacro` is a macro file, which core/xacro.ts expands first. */
export class UrdfError extends Error {
  constructor(
    readonly code: 'not-urdf' | 'xacro' | 'no-links',
    message: string,
  ) {
    super(message)
  }
}

const JOINT_TYPES = new Set<string>(['revolute', 'continuous', 'prismatic', 'fixed', 'floating', 'planar'])

/** Parse a URDF document. Throws {@link UrdfError} for a file that is not plain URDF. */
export function parseUrdf(text: string): UrdfRobot {
  if (isXacroText(text)) throw new UrdfError('xacro', 'This is a xacro file. Expand it to URDF first.')
  let root: XmlNode
  try {
    root = parseXml(text, 'URDF')
  } catch (e) {
    throw new UrdfError('not-urdf', (e as Error).message)
  }
  return parseUrdfRoot(root)
}

/** Read a URDF document already parsed: a plain file's root, or a xacro description expanded (core/xacro.ts). */
export function parseUrdfRoot(root: XmlNode): UrdfRobot {
  if (root.name !== 'robot') throw new UrdfError('not-urdf', `The file's root element is <${root.name}>, not <robot>.`)

  // materials named at the top level, which a visual may refer to by name alone
  const named = new Map<string, [number, number, number, number]>()
  for (const m of xmlKids(root, 'material')) {
    const rgba = rgbaOf(xmlKid(m, 'color'))
    if (m.attrs.name && rgba) named.set(m.attrs.name, rgba)
  }

  const links: UrdfLink[] = []
  for (const l of xmlKids(root, 'link')) {
    if (!l.attrs.name) continue
    const visuals: UrdfVisual[] = []
    for (const v of xmlKids(l, 'visual')) {
      const geometry = geometryOf(xmlKid(v, 'geometry'))
      if (!geometry) continue
      const mat = xmlKid(v, 'material')
      const rgba = rgbaOf(xmlKid(mat, 'color')) ?? (mat?.attrs.name ? named.get(mat.attrs.name) : undefined)
      visuals.push({ origin: poseOf(xmlKid(v, 'origin')), geometry, ...(rgba ? { rgba } : {}) })
    }
    const collisions: UrdfCollision[] = []
    for (const c of xmlKids(l, 'collision')) {
      const geometry = geometryOf(xmlKid(c, 'geometry'))
      if (geometry) collisions.push({ origin: poseOf(xmlKid(c, 'origin')), geometry })
    }
    links.push({ name: l.attrs.name, visuals, collisions })
  }
  if (links.length === 0) throw new UrdfError('no-links', 'The robot has no links.')

  const joints: UrdfJoint[] = []
  for (const j of xmlKids(root, 'joint')) {
    const type = j.attrs.type ?? ''
    const parent = xmlKid(j, 'parent')?.attrs.link
    const child = xmlKid(j, 'child')?.attrs.link
    if (!j.attrs.name || !JOINT_TYPES.has(type) || !parent || !child) continue
    const lim = xmlKid(j, 'limit')
    const limit = lim
      ? {
          lower: num(lim.attrs.lower, 0),
          upper: num(lim.attrs.upper, 0),
          ...(lim.attrs.velocity !== undefined ? { velocity: num(lim.attrs.velocity, 0) } : {}),
        }
      : undefined
    const mim = xmlKid(j, 'mimic')
    const mimic = mim?.attrs.joint ? { joint: mim.attrs.joint, multiplier: num(mim.attrs.multiplier, 1), offset: num(mim.attrs.offset, 0) } : undefined
    joints.push({
      name: j.attrs.name,
      type: type as UrdfJointType,
      parent,
      child,
      origin: poseOf(xmlKid(j, 'origin')),
      axis: vec3(xmlKid(j, 'axis')?.attrs.xyz, [1, 0, 0]),
      ...(limit ? { limit } : {}),
      ...(mimic ? { mimic } : {}),
    })
  }
  return { name: root.attrs.name ?? '', links, joints }
}

function geometryOf(g: XmlNode | undefined): UrdfGeometry | null {
  const shape = g?.children.find((c) => !c.name.startsWith('#'))
  if (!shape) return null
  switch (shape.name) {
    case 'mesh':
      return shape.attrs.filename ? { kind: 'mesh', filename: shape.attrs.filename, scale: vec3(shape.attrs.scale, [1, 1, 1]) } : null
    case 'box':
      return { kind: 'box', size: vec3(shape.attrs.size, [0, 0, 0]) }
    case 'cylinder':
      return { kind: 'cylinder', radius: num(shape.attrs.radius, 0), length: num(shape.attrs.length, 0) }
    case 'sphere':
      return { kind: 'sphere', radius: num(shape.attrs.radius, 0) }
    default:
      return null
  }
}

function poseOf(o: XmlNode | undefined): UrdfPose {
  return { xyz: vec3(o?.attrs.xyz, [0, 0, 0]), rpy: vec3(o?.attrs.rpy, [0, 0, 0]) }
}

function rgbaOf(c: XmlNode | undefined): [number, number, number, number] | undefined {
  const parts = c?.attrs.rgba?.trim().split(/\s+/).map(Number)
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined
  return parts as [number, number, number, number]
}

function vec3(s: string | undefined, fallback: UrdfVec3): UrdfVec3 {
  const parts = s?.trim().split(/\s+/).map(Number)
  if (!parts || parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return fallback
  return parts as UrdfVec3
}

function num(s: string | undefined, fallback: number): number {
  const n = s === undefined ? NaN : Number(s)
  return Number.isFinite(n) ? n : fallback
}

/** The quaternion (x, y, z, w) of URDF's roll-pitch-yaw: Rz(yaw) · Ry(pitch) · Rx(roll). */
export function rpyToQuat([r, p, y]: UrdfVec3): [number, number, number, number] {
  const cr = Math.cos(r / 2)
  const sr = Math.sin(r / 2)
  const cp = Math.cos(p / 2)
  const sp = Math.sin(p / 2)
  const cy = Math.cos(y / 2)
  const sy = Math.sin(y / 2)
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy]
}

/**
 * The file a mesh `filename` names, among `paths` (the files of the picked folder, relative to it, `/`-separated).
 * `urdfPath` is the URDF file's own path among them. A `package://<pkg>/<rest>` name is matched by its longest tail
 * that one of the paths ends with, since the folder picked may be the package itself, its parent, or a workspace
 * above both. A relative name is resolved against the URDF file's folder first. Null when no file matches.
 */
export function resolveMeshPath(filename: string, urdfPath: string, paths: readonly string[]): string | null {
  const norm = (p: string): string => p.replaceAll('\\', '/')
  const all = paths.map(norm)
  const set = new Set(all)
  let name = norm(filename)
  const scheme = /^(package|file|model):\/\/\/?/i.exec(name)
  if (!scheme) {
    const dir = norm(urdfPath).split('/').slice(0, -1)
    const joined = collapse([...dir, ...name.split('/')])
    if (set.has(joined)) return joined
  }
  name = name.slice(scheme?.[0].length ?? 0)
  const parts = name.split('/').filter((s) => s !== '' && s !== '.')
  // the longest tail first: package name and all, then without it, down to the bare file name
  for (let k = 0; k < parts.length; k++) {
    const tail = parts.slice(k).join('/')
    const hits = all.filter((p) => p === tail || p.endsWith(`/${tail}`))
    if (hits.length > 0) return hits.sort((a, b) => a.length - b.length)[0]!
  }
  return null
}

function collapse(parts: string[]): string {
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}
