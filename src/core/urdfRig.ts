// A URDF robot (core/urdf.ts) as a part's rig: a rig link per URDF link, a rig joint per moving URDF joint.
//
// The two models line up. A rig link's offset and quat place it in its parent's frame, and a rig joint turns its link
// about (or slides it along) an axis in the link's own frame, which is what a URDF joint's origin and axis mean. So
// each URDF link keeps its frame, its geometry is drawn in that frame (one GLB node per link, written by the
// importer), and nothing is re-expressed per link. URDF is Z-up and the app is Y-up: each root link is turned once
// (-90° about X), and everything below it follows.
//
// Joint value 0 is the pose the robot was described in, as in URDF. A `mimic` joint becomes a rig joint that follows
// its leader. Each `<collision>` element becomes a hidden box or cylinder link under its link (a mesh one, the box
// that bounds the mesh), the visual and collider split the built-in parts use.

import type { Box3Like } from './glbBox'
import type { PartBounds, RigGeometry, RigJoint, RigLink } from './parts/partPackage'
import { qApply, qMul, rigWorldPoses, type Quat } from './rig/rigPose'
import { rpyToQuat, type UrdfCollision, type UrdfRobot, type UrdfVec3 } from './urdf'
import type { RobotDecl } from './robot/robotController'
import { FINGER_TRAVEL, ROBOT_FINGER_LINKS, ROBOT_TOOL_LAMP, TOOL_GRIP_Y } from './robot/robotTools'

/** the asset id of the GLB holding the robot's link meshes */
export const URDF_ASSET = 'urdf'

/** -90° about X: URDF's +Z up becomes the app's +Y up, and +X stays +X */
export const Z_UP_TO_Y_UP: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]

/** What was imported other than as written, for the import's summary. `subject` is the URDF name involved. */
export interface UrdfRigNote {
  /**
   * `unknown-link`: a joint names a link the file does not have, so it was left out.
   * `second-parent`: a link is the child of more than one joint; the first one places it.
   * `fixed-in-place`: a floating or planar joint, which a rig cannot move, holds its link where it was described.
   * `no-limit`: a revolute or prismatic joint without a usable `<limit>`; it got ±π (or ±1 m).
   * `mimic`: a joint follows one the part cannot follow (missing, fixed, or itself following), so it moves on its own.
   */
  code: 'unknown-link' | 'second-parent' | 'fixed-in-place' | 'no-limit' | 'mimic'
  subject: string
}

export interface UrdfRig {
  geometry: RigGeometry
  /** the rig link name each URDF link became (names are made safe for GLB node lookup, and unique) */
  linkNames: Map<string, string>
  notes: UrdfRigNote[]
  /** the robot the arm is: its joints from the root to the tool, its grip, and the finger that opens and closes with
   *  it; null for a rig with no joint above its tool */
  robot: RobotDecl | null
  /** the arm has its own hand from the URDF (RobotDeclaration.hand), which it grips with until its `tool` param
   *  picks one of the app's tools */
  hand: boolean
}

/** how far the app tool's grip zone reaches along the approach (m), centred on the grip point: a box is taken when
 *  its centre is inside, so this takes any case up to 0.7 m tall under the tool without reaching into the layer below
 *  it, as the six-axis robot's tool does */
const GRIP_REACH = 0.7

/** A name three's GLTFLoader keeps as written: it drops `[ ] . : /` and turns whitespace into `_`. A name ending in
 *  `_visual` gets one more `_`, since core/urdfGlb.ts names each link's mesh `<link>_visual`. */
export function safeRigName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'link'
  return safe.endsWith('_visual') ? `${safe}_` : safe
}

function unique(name: string, used: Set<string>): string {
  let out = name
  for (let n = 2; used.has(out); n++) out = `${name}_${n}`
  used.add(out)
  return out
}

export interface UrdfRigInputs {
  /** the URDF links that have geometry in the GLB (a node named by `linkNames`); the others become frames */
  drawn: ReadonlySet<string>
  /** those links' geometry bounds in their own frames, for the part's bounds */
  boxes?: ReadonlyMap<string, Box3Like>
  /** each mesh collision element's bounds in its own frame (its `scale` applied), as loaded by the importer. One
   *  that is absent (its file missing or unreadable, which the importer reports) gets no collider. */
  collisionBoxes?: ReadonlyMap<UrdfCollision, Box3Like>
}

/** the smallest collider side (m): a flat plate's mesh has no thickness */
const MIN_COLLIDER = 0.001

/** +90° about X: a rig cylinder runs along +Y, a URDF cylinder along +Z */
const Y_TO_Z: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]

/** The rig for `robot`. */
export function urdfToRig(robot: UrdfRobot, { drawn, boxes, collisionBoxes }: UrdfRigInputs): UrdfRig {
  const notes: UrdfRigNote[] = []
  const linkNames = new Map<string, string>()
  const usedLinks = new Set<string>()
  for (const l of robot.links) if (!linkNames.has(l.name)) linkNames.set(l.name, unique(safeRigName(l.name), usedLinks))

  // the joint that places each link: the first one naming it as the child
  const parentJoint = new Map<string, UrdfRobot['joints'][number]>()
  for (const j of robot.joints) {
    if (!linkNames.has(j.parent) || !linkNames.has(j.child) || j.parent === j.child) {
      notes.push({ code: 'unknown-link', subject: j.name })
      continue
    }
    if (parentJoint.has(j.child)) {
      notes.push({ code: 'second-parent', subject: j.child })
      continue
    }
    parentJoint.set(j.child, j)
  }
  // a joint chain that loops back has no root; break it at the first link of the loop met in file order
  const children = new Map<string, string[]>()
  for (const [child, j] of parentJoint) children.set(j.parent, [...(children.get(j.parent) ?? []), child])
  const order: string[] = []
  const placed = new Set<string>()
  const visit = (name: string): void => {
    const stack = [name]
    while (stack.length) {
      const n = stack.shift()!
      if (placed.has(n)) continue
      placed.add(n)
      order.push(n)
      stack.push(...(children.get(n) ?? []))
    }
  }
  for (const l of robot.links) if (!parentJoint.has(l.name)) visit(l.name)
  for (const l of robot.links)
    if (!placed.has(l.name)) {
      parentJoint.delete(l.name)
      visit(l.name)
    }

  // rig joint names first, in file order, so a follower can name a leader placed after it
  const jointNames = new Map<string, string>()
  const usedJoints = new Set<string>()
  const moving = (j: UrdfRobot['joints'][number]): boolean => j.type === 'revolute' || j.type === 'continuous' || j.type === 'prismatic'
  const placing = new Set(parentJoint.values())
  for (const j of robot.joints) if (placing.has(j) && moving(j)) jointNames.set(j.name, unique(safeRigName(j.name), usedJoints))
  const byName = new Map(robot.joints.map((j) => [j.name, j]))

  const links: RigLink[] = []
  const joints: RigJoint[] = []
  const colliders: RigLink[] = []
  for (const urdfName of order) {
    const name = linkNames.get(urdfName)!
    const shape: RigLink['shape'] = drawn.has(urdfName) ? { kind: 'mesh', asset: URDF_ASSET, node: name } : { kind: 'frame' }
    const urdfLink = robot.links.find((l) => l.name === urdfName)
    for (const c of urdfLink?.collisions ?? []) {
      const collider = colliderOf(c, collisionBoxes)
      if (collider) colliders.push({ name: unique(`${name}_collision`, usedLinks), parent: name, ...collider, hidden: true })
    }
    const j = parentJoint.get(urdfName)
    if (!j) {
      links.push({ name, shape, offset: [0, 0, 0], quat: Z_UP_TO_Y_UP })
      continue
    }
    links.push({ name, parent: linkNames.get(j.parent)!, shape, offset: [...j.origin.xyz], quat: rpyToQuat(j.origin.rpy) })
    if (j.type === 'fixed') continue
    if (j.type === 'floating' || j.type === 'planar') {
      notes.push({ code: 'fixed-in-place', subject: j.name })
      continue
    }
    const type = j.type === 'prismatic' ? 'prismatic' : 'revolute'
    let min: number
    let max: number
    if (j.type === 'continuous') {
      min = -Math.PI
      max = Math.PI
    } else if (j.limit && j.limit.lower < j.limit.upper) {
      min = j.limit.lower
      max = j.limit.upper
    } else {
      notes.push({ code: 'no-limit', subject: j.name })
      min = type === 'revolute' ? -Math.PI : -1
      max = type === 'revolute' ? Math.PI : 1
    }
    const joint: RigJoint = { name: jointNames.get(j.name)!, link: name, type, axis: unitAxis(j.axis), min, max }
    if (j.mimic) {
      const leader = byName.get(j.mimic.joint)
      const leaderName = leader && !leader.mimic ? jointNames.get(leader.name) : undefined
      if (leaderName && leader !== j) {
        joint.mimic = { joint: leaderName, ...(j.mimic.multiplier !== 1 ? { multiplier: j.mimic.multiplier } : {}), ...(j.mimic.offset !== 0 ? { offset: j.mimic.offset } : {}) }
      } else notes.push({ code: 'mimic', subject: j.name })
    }
    joints.push(joint)
  }

  // colliders after the links they hang from: each is drawn by nothing and only collides
  const geometry: RigGeometry = { kind: 'rig', links: [...links, ...colliders], joints, posable: true }
  const tool = toolLinkOf(order)
  if (tool !== null) geometry.tool = linkNames.get(tool)!
  const robotArm = robotOf(geometry, usedLinks, usedJoints)
  const bounds = boxes ? restBounds(geometry, linkNames, boxes) : null
  if (bounds) geometry.bounds = bounds
  return { geometry, linkNames, notes, robot: robotArm?.decl ?? null, hand: robotArm?.hand ?? false }
}

/**
 * The robot an imported arm is. The controller drives the joints between the root and the tool (the gizmo's IK chain).
 * Every arm gets the app's tools (core/robot/robotTools.ts): a mount turned so the tool hangs out along the frame's +Z
 * (the outward direction of ROS-Industrial's tool0 and of a TCP frame), with the grip point and the two finger links
 * the tools use, as the six-axis robot carries them. The mount is on the tool link, or on the link a hand of the
 * URDF's own is fixed to. An arm whose URDF carries a hand (a single sliding joint beside the arm; a two-finger hand's
 * second finger follows it by mimic) also grips with that hand at the tool frame (`decl.hand`), which it carries while
 * its `tool` param is 'hand': the hand's links have `showParam: 'tool=hand'`. Writes those links, joints and grips
 * into `geometry`.
 */
function robotOf(geometry: RigGeometry, usedLinks: Set<string>, usedJoints: Set<string>): { decl: RobotDecl; hand: boolean } | null {
  const moving = geometry.joints.filter((j) => !j.mimic)
  if (moving.length === 0) return null
  const parentOf = new Map(geometry.links.map((l) => [l.name, l.parent]))
  // no link named as a tool frame: the last moving joint's link, unless that joint slides after another, where it is
  // a hand's finger and the link the finger hangs from is the hand
  const last = moving[moving.length - 1]!
  const toolName = geometry.tool ?? (last.type === 'prismatic' && moving.length > 1 ? (parentOf.get(last.link) ?? last.link) : last.link)
  const above = new Set<string>()
  for (let n: string | undefined = toolName; n !== undefined && !above.has(n); n = parentOf.get(n)) above.add(n)
  const arm = moving.filter((j) => above.has(j.link))
  if (arm.length === 0) return null
  const others = moving.filter((j) => !above.has(j.link))
  const finger = others.length === 1 && others[0]!.type === 'prismatic' ? others[0]! : null
  const joints = arm.map((j) => j.name)
  let hand: RobotDecl['hand']
  let flange = toolName
  if (finger) {
    // the URDF's own hand: a zone at the tool frame, between the fingers. The controller drives the finger with the
    // grip, so it is cosmetic: no pose gizmo ring, no waypoint column
    geometry.links.find((l) => l.name === toolName)!.grip = { zone: { size: [0.08, 0.08, 0.08] } }
    finger.cosmetic = true
    hand = { gripper: toolName, gripJoint: { name: finger.name, open: finger.max, closed: finger.min } }
    // The hand is the link its finger hangs from and everything under it. Another tool replaces it on the link it is
    // fixed to. A hand that is also the arm's last link (a finger straight on the wrist) cannot come off, so that arm
    // keeps only its own hand.
    const body = parentOf.get(finger.link)
    const handLinks = body === undefined ? [] : subtreeOf(geometry, body)
    const armLinks = new Set(arm.map((j) => j.link))
    const mountOn = body === undefined ? undefined : parentOf.get(body)
    if (mountOn === undefined || handLinks.some((l) => armLinks.has(l.name))) return { decl: { joints, gripper: toolName, gripJoint: hand.gripJoint }, hand: true }
    for (const l of handLinks) l.showParam = 'tool=hand'
    flange = mountOn
  }
  const mount = unique('toolMount', usedLinks)
  const gripper = unique('gripper', usedLinks)
  const fingerA = unique(ROBOT_FINGER_LINKS[0], usedLinks)
  const fingerB = unique(ROBOT_FINGER_LINKS[1], usedLinks)
  const grip = unique('toolGrip', usedJoints)
  const grip2 = unique('toolGrip2', usedJoints)
  geometry.links.push(
    // the tool frame's +Y points back at the wrist: -90 degrees about X turns the tool link's +Z to the mount's -Y
    { name: mount, parent: flange, shape: { kind: 'frame' }, offset: [0, 0, 0], quat: Z_UP_TO_Y_UP },
    {
      name: gripper,
      parent: mount,
      shape: { kind: 'frame' },
      offset: [0, -TOOL_GRIP_Y, 0],
      // what the tool picks: the tool size in plan, a fixed reach along the approach
      grip: {
        zone: {
          size: [0.4, GRIP_REACH, 0.4],
          sizeParams: [
            { axis: 0, param: 'toolSizeX' },
            { axis: 2, param: 'toolSizeZ' },
          ],
        },
      },
    },
    { name: fingerA, parent: mount, shape: { kind: 'frame' }, offset: [0, 0, 0] },
    { name: fingerB, parent: mount, shape: { kind: 'frame' }, offset: [0, 0, 0] },
  )
  geometry.joints.push(
    { name: grip, link: fingerA, type: 'prismatic', axis: [1, 0, 0], min: -FINGER_TRAVEL, max: FINGER_TRAVEL, cosmetic: true },
    { name: grip2, link: fingerB, type: 'prismatic', axis: [-1, 0, 0], min: -FINGER_TRAVEL, max: FINGER_TRAVEL, mimic: { joint: grip } },
  )
  return {
    decl: { joints, gripper, lamp: ROBOT_TOOL_LAMP, tool: mount, gripJoint: { name: grip, open: FINGER_TRAVEL, closed: -FINGER_TRAVEL }, ...(hand ? { hand } : {}) },
    hand: hand !== undefined,
  }
}

/** `root` and every link under it, root first. */
function subtreeOf(geometry: RigGeometry, root: string): RigLink[] {
  const out = geometry.links.filter((l) => l.name === root)
  for (let i = 0; i < out.length; i++) for (const l of geometry.links) if (l.parent === out[i]!.name) out.push(l)
  return out
}

/** How a link's name says it is the tool frame: ROS-Industrial names the flange frame `tool0` (REP 199), and arms also
 *  publish a TCP, a flange or an end-effector link. Higher wins. */
const TOOL_NAMES: [RegExp, number][] = [
  [/^tool0$/i, 4],
  [/tcp/i, 3],
  [/flange/i, 2],
  [/(^|_)(ee|end_effector)(_link)?$/i, 1],
]

/** The URDF link the teach gizmo drags as the tool, by its name, or null to leave the gizmo its default. `order` is
 *  root first, so a tie goes to the link nearer the root. */
function toolLinkOf(order: readonly string[]): string | null {
  let best: string | null = null
  let score = 0
  for (const name of order) {
    const s = TOOL_NAMES.find(([re]) => re.test(name))?.[1] ?? 0
    if (s > score) {
      best = name
      score = s
    }
  }
  return best
}

/** A collision element as a hidden link's shape and place in its URDF link's frame; null for a mesh not loaded. */
function colliderOf(c: UrdfCollision, boxes: ReadonlyMap<UrdfCollision, Box3Like> | undefined): Pick<RigLink, 'shape' | 'offset' | 'quat'> | null {
  const q = rpyToQuat(c.origin.rpy)
  const at = c.origin.xyz
  const side = (n: number): number => Math.max(MIN_COLLIDER, n)
  const g = c.geometry
  switch (g.kind) {
    case 'box':
      return { shape: { kind: 'box', size: [side(g.size[0]), side(g.size[1]), side(g.size[2])] }, offset: [...at], quat: q }
    case 'sphere':
      return { shape: { kind: 'box', size: [side(2 * g.radius), side(2 * g.radius), side(2 * g.radius)] }, offset: [...at], quat: q }
    case 'cylinder':
      return { shape: { kind: 'cylinder', radius: side(g.radius), height: side(g.length) }, offset: [...at], quat: qMul(q, Y_TO_Z) }
    case 'mesh': {
      const box = boxes?.get(c)
      if (!box || !(box.min[0]! <= box.max[0]!)) return null
      const centre: [number, number, number] = [(box.min[0]! + box.max[0]!) / 2, (box.min[1]! + box.max[1]!) / 2, (box.min[2]! + box.max[2]!) / 2]
      const d = qApply(q, centre)
      // a mesh's bounds are float32: rounded to 0.1 mm, finer than a collider needs
      return {
        shape: { kind: 'box', size: [side(round(box.max[0]! - box.min[0]!)), side(round(box.max[1]! - box.min[1]!)), side(round(box.max[2]! - box.min[2]!))] },
        offset: [round(at[0] + d[0]), round(at[1] + d[1]), round(at[2] + d[2])],
        quat: q,
      }
    }
  }
}

function unitAxis(a: UrdfVec3): [number, number, number] {
  const len = Math.hypot(a[0], a[1], a[2])
  return len > 1e-9 ? [a[0] / len, a[1] / len, a[2] / len] : [1, 0, 0]
}

// `+ 0` turns -0 into 0
const round = (n: number): number => Math.round(n * 1e4) / 1e4 + 0

/** The part's footprint at joint value 0: every link's box, placed by the rig, in the part's frame. */
function restBounds(geometry: RigGeometry, linkNames: ReadonlyMap<string, string>, boxes: ReadonlyMap<string, Box3Like>): PartBounds | null {
  const poses = rigWorldPoses(geometry, {})
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const [urdfName, box] of boxes) {
    const pose = poses.get(linkNames.get(urdfName) ?? '')
    if (!pose || !(box.min[0]! <= box.max[0]!)) continue
    for (let c = 0; c < 8; c++) {
      const corner: [number, number, number] = [c & 1 ? box.max[0]! : box.min[0]!, c & 2 ? box.max[1]! : box.min[1]!, c & 4 ? box.max[2]! : box.min[2]!]
      const p = qApply(pose.quat, corner)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, p[k]! + pose.pos[k]!)
        hi[k] = Math.max(hi[k]!, p[k]! + pose.pos[k]!)
      }
    }
  }
  if (!(lo[0]! <= hi[0]!)) return null
  const bounds: PartBounds = { length: round(hi[0]! - lo[0]!), width: round(hi[2]! - lo[2]!), top: round(hi[1]!), bottom: round(lo[1]!) }
  const cx = round((lo[0]! + hi[0]!) / 2)
  const cz = round((lo[2]! + hi[2]!) / 2)
  if (cx !== 0) bounds.centerX = cx
  if (cz !== 0) bounds.centerZ = cz
  return bounds
}
