// Agent tools for robots: teach a waypoint by position, and read where a pose puts the tool. Waypoints, jobs and the
// tool are ordinary params, so update_part writes them; what an agent cannot do from a param list is turn a point in
// the scene into joint angles, which these do with core's inverse kinematics (core/robot/robotIk.ts).

import { getPackage } from '../../core/parts/partRegistry'
import { resolvePartParams } from '../../core/parts/partScript'
import type { ParamValue } from '../../core/parts/partApi'
import { qApply, rigWorldPoses, type RigParams, type Vec3 } from '../../core/rig/rigPose'
import { robotUnit } from '../../core/robot/robotController'
import { IK_REACHED, robotKinematics, solveRobotIkFrom, solveRobotIkKeeping, type RobotIkResult, type RobotKinematics } from '../../core/robot/robotIk'
import type { SdkPart } from '../../core/types'
import { AgentToolError, assertEditable, findPart, optBool, optNum, round, str, type AgentTool, type AgentToolContext } from './toolKit'
import { addNewPart } from '../controller/partAuthoring'
import { XacroError, xacroArgChoices } from '../../core/xacro'

/** A placed robot: its kinematics, resolved params, and where it stands. */
interface PlacedRobot {
  kin: RobotKinematics
  params: Record<string, ParamValue>
  scale: number
  position: Vec3
  rotationY: number
}

function placedRobot({ store }: AgentToolContext, id: string): PlacedRobot {
  const part = findPart(store.getState().scene, id)
  const pkg = part.type === 'part' ? getPackage((part as SdkPart).packageId) : undefined
  if (!pkg || pkg.geometry.kind !== 'rig') throw new AgentToolError(`${id} is not a robot (it has no rig)`)
  const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
  // the grip point is the tool's the robot carries (an arm with its own hand may carry an app tool instead)
  const kin = robotKinematics(pkg.geometry, pkg.behavior, params)
  if (!kin) throw new AgentToolError(`${id} is not a robot: its part declares no robot controller`)
  const scale = typeof params.scale === 'number' && params.scale > 0 ? params.scale : 1
  return { kin, params, scale, position: [...part.position], rotationY: part.rotationY }
}

// the part's frame from the world's and back: turned rotationY about +Y, then placed at its position
const toLocal = (r: PlacedRobot, w: Vec3): Vec3 => {
  const d: Vec3 = [w[0] - r.position[0], w[1] - r.position[1], w[2] - r.position[2]]
  const c = Math.cos(r.rotationY)
  const s = Math.sin(r.rotationY)
  return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]]
}
const toWorldDir = (r: PlacedRobot, v: Vec3): Vec3 => {
  const c = Math.cos(r.rotationY)
  const s = Math.sin(r.rotationY)
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]
}
const toWorld = (r: PlacedRobot, v: Vec3): Vec3 => {
  const d = toWorldDir(r, v)
  return [d[0] + r.position[0], d[1] + r.position[1], d[2] + r.position[2]]
}

/** A waypoint row (Inspector units: degrees, millimetres for a sliding joint) as native joint values, and back. */
const rowToValues = (kin: RobotKinematics, row: readonly number[]): Record<string, number> =>
  Object.fromEntries(kin.joints.map((j, i) => [j.name, (row[i] ?? 0) / robotUnit(j.type)]))
const valuesToRow = (kin: RobotKinematics, values: Readonly<Record<string, number>>): number[] =>
  kin.joints.map((j) => Math.round((values[j.name] ?? 0) * robotUnit(j.type) * 100) / 100)

/** The row a call starts from: a waypoint by index, else the idle pose. */
function startRow(r: PlacedRobot, waypoint: number | undefined): number[] {
  const rows = (key: string): number[][] => (Array.isArray(r.params[key]) ? (r.params[key] as unknown as number[][]) : [])
  if (waypoint !== undefined) {
    const row = rows('waypoints')[waypoint]
    if (!row) throw new AgentToolError(`waypoint ${waypoint} does not exist (the robot has ${rows('waypoints').length})`)
    return row
  }
  return rows('pose')[0] ?? r.kin.joints.map(() => 0)
}

/** The tool's X axis (the plate's length, the clamp's closing direction, a TCP's X), in its approach link's frame:
 *  which way the tool faces, read and set as a yaw */
const FACE_AXIS: Vec3 = [1, 0, 0]

/** A heading in the world's horizontal plane, degrees counter-clockwise seen from above from +X (90 = -Z), as a
 *  direction in the part's frame. */
const yawToLocal = (r: PlacedRobot, deg: number): Vec3 => {
  const a = (deg * Math.PI) / 180 - r.rotationY
  return [Math.cos(a), 0, -Math.sin(a)]
}

/** Where a pose puts the grip point and which way the tool points and faces, in the world. */
function toolAt(r: PlacedRobot, values: Readonly<Record<string, number>>) {
  const poses = rigWorldPoses(r.kin.geometry, values, undefined, r.scale, r.params as RigParams)
  const grip = poses.get(r.kin.end)!
  const ap = r.kin.approach ? poses.get(r.kin.approach.link) : undefined
  const dir = ap && r.kin.approach ? toWorldDir(r, qApply(ap.quat, r.kin.approach.axis)) : null
  const face = ap ? toWorldDir(r, qApply(ap.quat, FACE_AXIS)) : null
  // a yaw only means something while the tool's X lies near the horizontal (a tool pointing down, or sideways)
  const yaw = face && Math.hypot(face[0], face[2]) > 0.5 ? round((Math.atan2(-face[2], face[0]) * 180) / Math.PI) : undefined
  return {
    grip: toWorld(r, grip.pos).map(round),
    ...(dir ? { approach: dir.map(round), tiltFromDownDeg: round((Math.acos(Math.max(-1, Math.min(1, -dir[1]))) * 180) / Math.PI) } : {}),
    ...(yaw !== undefined ? { yawDeg: yaw } : {}),
  }
}

const vec = (args: Record<string, unknown>, key: string): Vec3 => {
  const v = args[key]
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new AgentToolError(`${key} must be [x, y, z] in metres`)
  return [v[0], v[1], v[2]]
}

export const solveRobotPose: AgentTool = {
  name: 'solve_robot_pose',
  description:
    "The joint row that puts a robot's grip point (where its tool takes a load: the vacuum cups' rim, the clamp pads, a hand's TCP) at a point in the scene, " +
    'by inverse kinematics. Use it to teach waypoints by position: put the row into the robot\'s `waypoints` (and a name into `waypointNames`) with update_part, ' +
    'then build `jobs` from them. By default the tool points straight down, as for a pick from above; `down: false` leaves its direction free. ' +
    '`yawDeg` also sets which way the tool faces, as `yawDeg` in the answer reads it: the heading of its X axis (the plate\'s length, the clamp\'s closing direction), degrees counter-clockwise seen from above from world +X (90 = -Z). ' +
    'A palletizer that lays a case turned a quarter from how it picked it sets the place yaw 90 from the pick\'s. A plate or clamp turned 180 is the same tool: if a joint runs short, try the yaw 180 off. Without it the tool faces however the nearest pose has it. ' +
    'The arm stays in the configuration of the start (`from`, a waypoint index, else the idle pose): elbow up stays elbow up and the wrist keeps its side, so the poses of one job move smoothly between each other; start from a neighbouring waypoint. ' +
    'Where that configuration cannot reach the point, the answer is reached false with the closest pose, and says whether another configuration reaches it; `anyConfiguration: true` allows the switch (the arm swings over to it between waypoints). ' +
    'Answers `reached` (within 2 mm and 1°), the miss, and `configuration`: kept or changed. Nothing is changed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the robot part id' },
      target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'where the grip point goes, world [x, y, z] in metres (y is up)' },
      down: { type: 'boolean', description: 'point the tool straight down (default true)' },
      from: { type: 'number', description: 'the waypoint row to start from (default the idle pose)' },
      yawDeg: { type: 'number', description: 'which way the tool faces: its X axis heading, degrees counter-clockwise from world +X seen from above (default free)' },
      anyConfiguration: { type: 'boolean', description: 'allow another arm configuration than the start\'s when that one cannot reach the point (default false)' },
    },
    required: ['id', 'target'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const r = placedRobot(ctx, str(args, 'id'))
    const down = optBool(args, 'down') ?? true
    if (down && !r.kin.approach) throw new AgentToolError('this robot has no tool frame to point down: call again with down: false')
    const yawDeg = optNum(args, 'yawDeg')
    if (yawDeg !== undefined && !(down && r.kin.approach)) throw new AgentToolError('yawDeg sets which way a tool pointing down faces: call it with down left true, on a robot with a tool frame')
    // the given start first, then the robot's other waypoints (another configuration is looked for among them and the
    // solver's own spread of starts)
    const from = optNum(args, 'from')
    const waypoints = Array.isArray(r.params.waypoints) ? (r.params.waypoints as unknown as number[][]) : []
    const starts = [startRow(r, from), ...waypoints.filter((_, i) => i !== from)].map((row) => rowToValues(r.kin, row))
    const goal: Parameters<typeof solveRobotIkKeeping>[0] = {
      geometry: r.kin.geometry,
      params: r.params as RigParams,
      scale: r.scale,
      joints: r.kin.joints.map((j) => j.name),
      end: r.kin.end,
      target: toLocal(r, vec(args, 'target')),
      ...(down && r.kin.approach ? { approach: { ...r.kin.approach, toward: [0, -1, 0] as Vec3 } } : {}),
      ...(yawDeg !== undefined && r.kin.approach ? { face: { link: r.kin.approach.link, axis: FACE_AXIS, toward: yawToLocal(r, yawDeg) } } : {}),
    }
    const hits = (x: RobotIkResult): boolean => x.miss < IK_REACHED.miss && x.turn < IK_REACHED.turn
    // the start's configuration first; another only when asked for, or to say whether one exists
    const kept = solveRobotIkKeeping(goal, starts[0]!)
    const other = hits(kept) ? null : solveRobotIkFrom(goal, starts)
    const switched = other !== null && hits(other) && optBool(args, 'anyConfiguration') === true
    const result = switched ? other : kept
    const reached = hits(result)
    return {
      row: valuesToRow(r.kin, result.values),
      columns: r.kin.joints.map((j) => `${j.name} ${j.type === 'prismatic' ? 'mm' : '°'}`),
      reached,
      missMm: round(result.miss * 1000),
      ...(down ? { tiltDeg: round((result.turn * 180) / Math.PI) } : {}),
      ...toolAt(r, result.values),
      ...(reached ? { configuration: switched ? 'changed' : 'kept' } : {}),
      ...(reached
        ? {}
        : other && hits(other)
          ? { note: "not reachable in the start's arm configuration: this is its closest pose. Another configuration reaches it: call again with anyConfiguration: true (the arm swings over to it), or start from a waypoint nearer the point." }
          : { note: 'not reachable as asked: this is the closest pose. Check the point is within reach, or try down: false or another starting waypoint.' }),
    }
  },
}

export const getRobotPose: AgentTool = {
  name: 'get_robot_pose',
  description:
    "Where a robot's grip point is in the scene for a joint row, and which way its tool points (`approach`, a world direction; `tiltFromDownDeg` 0 = straight down). " +
    'Give `row` (degrees, millimetres for a sliding joint, in the waypoint columns), or `waypoint` (an index into its waypoints); neither = its idle pose. Nothing is changed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the robot part id' },
      row: { type: 'array', items: { type: 'number' }, description: 'joint values in the waypoint columns' },
      waypoint: { type: 'number', description: 'a waypoint index' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const r = placedRobot(ctx, str(args, 'id'))
    const given = args.row
    if (given !== undefined && (!Array.isArray(given) || !given.every((x) => typeof x === 'number' && Number.isFinite(x)))) throw new AgentToolError('row must be numbers')
    const row = Array.isArray(given) ? (given as number[]) : startRow(r, optNum(args, 'waypoint'))
    return { row, columns: r.kin.joints.map((j) => `${j.name} ${j.type === 'prismatic' ? 'mm' : '°'}`), ...toolAt(r, rowToValues(r.kin, row)) }
  },
}

export const importRobot: AgentTool = {
  name: 'import_robot',
  description:
    'Make a new robot part from a URDF or xacro file on this computer, as Import part > A robot (unzipped folder)... does: a rig link per URDF link, a joint per moving joint, ' +
    'its meshes (STL, COLLADA, OBJ) in one model, its <collision> as hidden colliders, and the robot controller (waypoints, jobs, PLC tags). ' +
    "The meshes are the files it names (a xacro's includes and YAML too), read from its ROS package and those it finds with $(find). " +
    'A xacro file is expanded first, with `args` set (its <xacro:arg> values; defaults otherwise). When an argument names a model the package lacks ' +
    "(a UR description's ur_type), the call is refused with the values it can take: call again with args set to one. " +
    "The answer's `switches` are the on/off arguments that add or remove links (an arm's own hand), with the value used: set one with args { \"hand\": \"true\" }. " +
    'An arm with no hand of its own carries the app\'s tools (`tool`: vacuum plate or clamp gripper). ' +
    'Answers the new part id (place it with add_part), and what was not imported as written. One part in the library; nothing placed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute path of the .urdf or .xacro file' },
      args: { type: 'object', additionalProperties: { type: 'string' }, description: 'a xacro file\'s arguments, by name (e.g. { "ur_type": "ur5e" })' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    assertEditable(ctx.store)
    const readModel = ctx.shell?.readModel
    if (!readModel) throw new AgentToolError('importing a robot needs the desktop app')
    const path = str(args, 'path')
    if (!/\.(urdf|xacro)$/i.test(path)) throw new AgentToolError('give the robot as a .urdf or .xacro file')
    const given = args.args ?? {}
    if (typeof given !== 'object' || Array.isArray(given) || !Object.values(given as object).every((v) => typeof v === 'string')) throw new AgentToolError('args must be an object of strings')
    const xacroArgs = given as Record<string, string>
    const file = await readModel(path)
    if ('error' in file) throw new AgentToolError(file.error)
    const files = new Map<string, Blob>((file.files ?? [{ path: file.name, bytes: file.bytes }]).map((f) => [f.path, new Blob([f.bytes as Uint8Array<ArrayBuffer>])]))
    const { importUrdf } = await import('../urdfImport')
    let result: Awaited<ReturnType<typeof importUrdf>>
    try {
      result = await importUrdf(files, file.root ?? file.name, xacroArgs)
    } catch (e) {
      if (e instanceof XacroError) {
        const choose = xacroArgChoices(e, [...files.keys()])
        if (choose) throw new AgentToolError(`the argument ${choose.arg} is '${choose.value}', a model the package does not have: call again with args { "${choose.arg}": one of ${choose.choices.join(', ')} }`)
        throw new AgentToolError(`could not expand ${file.name}: ${e.message}`)
      }
      throw new AgentToolError(`could not import ${file.name}: ${(e as Error).message}`)
    }
    const id = addNewPart(ctx.store, {
      name: result.name,
      geometry: result.geometry,
      assets: result.assets,
      materials: result.materials,
      ...(result.behavior ? { behavior: result.behavior } : {}),
    })
    const pkg = getPackage(id)!
    const kin = pkg.geometry.kind === 'rig' ? robotKinematics(pkg.geometry, pkg.behavior) : null
    return {
      id,
      name: result.name,
      links: result.stats.links,
      joints: result.stats.joints,
      ...(kin ? { robot: { waypointColumns: kin.joints.map((j) => `${j.name} ${j.type === 'prismatic' ? 'mm' : '°'}`), gripPoint: kin.end, tools: 'tool' in pkg.params } } : {}),
      triangles: result.stats.triangles,
      ...(result.missing.length ? { missingMeshes: result.missing } : {}),
      ...(result.unreadable.length ? { unreadableMeshes: result.unreadable } : {}),
      ...(result.notes.length ? { notes: result.notes } : {}),
      ...(Object.keys(result.args).length ? { args: result.args } : {}),
      ...(Object.keys(result.switches).length ? { switches: result.switches } : {}),
    }
  },
}
