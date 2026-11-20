// The agent's robot tools (robotAgentTools.ts) on the six-axis robot, placed off the origin and turned: a waypoint taught
// by position comes back to that position, a pick from above holds the tool straight down, and an unreachable point
// says so. Also core's solver (core/robot/robotIk.ts) on random reachable targets.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callAgentTool, type AgentToolContext } from './tools'
import { EditorStore } from '../store/store'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import type { PackageManifest } from '../../core/parts/partPackage'
import { rigWorldPoses } from '../../core/rig/rigPose'
import { robotKinematics, solveRobotIk } from '../../core/robot/robotIk'
import { buildPackage } from '../../sim/buildPackage'

const DIR = new URL('../../../examples/parts/six-axis-robot/', import.meta.url)
const ROBOT = buildPackage(JSON.parse(readFileSync(new URL('rig.json', DIR), 'utf8')) as PackageManifest, readFileSync(new URL('behavior.ts', DIR), 'utf8'))
const AT: [number, number, number] = [2, 0, 1]
const TURN = 0.7

function ctx(): AgentToolContext {
  const store = new EditorStore()
  store.setBundledPackages([ROBOT])
  store.loadScene({ parts: [{ id: 'r1', type: 'part', packageId: ROBOT.id, position: AT, rotationY: TURN, params: {} }], packages: [ROBOT] } as never)
  return { store, controller: null }
}

async function ok(c: AgentToolContext, name: string, args: unknown): Promise<Record<string, unknown>> {
  const r = await callAgentTool(c, name, args)
  if (!r.ok) throw new Error(`${name} refused: ${r.error}`)
  return r.value as Record<string, unknown>
}

const dist = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

beforeEach(() => registerPackage(ROBOT))
afterEach(() => unregisterPackage(ROBOT.id))

describe('agent robot tools', () => {
  it('teaches a waypoint by position: the row it solves puts the grip point back where the waypoint had it', async () => {
    const c = ctx()
    const pick = await ok(c, 'get_robot_pose', { id: 'r1', waypoint: 1 })
    const solved = await ok(c, 'solve_robot_pose', { id: 'r1', target: pick.grip, down: false, from: 0 })
    expect(solved.reached).toBe(true)
    const back = await ok(c, 'get_robot_pose', { id: 'r1', row: solved.row })
    expect(dist(back.grip as number[], pick.grip as number[])).toBeLessThan(0.002)
    expect(solved.columns).toEqual(['j1 °', 'j2 °', 'j3 °', 'j4 °', 'j5 °', 'j6 °'])
  })

  it('picks from above: the tool held straight down at a point in front of the turned robot', async () => {
    const c = ctx()
    // 1.6 m out along the robot's own +X at 0.9 m high, in world coordinates
    const target = [AT[0] + 1.6 * Math.cos(TURN), 0.9, AT[2] - 1.6 * Math.sin(TURN)]
    const solved = await ok(c, 'solve_robot_pose', { id: 'r1', target })
    expect(solved.reached).toBe(true)
    expect(solved.tiltDeg as number).toBeLessThan(1)
    const back = await ok(c, 'get_robot_pose', { id: 'r1', row: solved.row })
    expect(dist(back.grip as number[], target)).toBeLessThan(0.002)
    expect(back.tiltFromDownDeg as number).toBeLessThan(1)
  })

  it('faces the tool a set way: a quarter turn apart at the same point, as a palletizer turns a case', async () => {
    const c = ctx()
    const target = [AT[0] + 1.6 * Math.cos(TURN), 0.9, AT[2] - 1.6 * Math.sin(TURN)]
    const yaws: number[] = []
    for (const yawDeg of [20, 110]) {
      const solved = await ok(c, 'solve_robot_pose', { id: 'r1', target, yawDeg })
      expect(solved.reached).toBe(true)
      expect(Math.abs((solved.yawDeg as number) - yawDeg)).toBeLessThan(1)
      const back = await ok(c, 'get_robot_pose', { id: 'r1', row: solved.row })
      expect(dist(back.grip as number[], target)).toBeLessThan(0.002)
      expect(back.tiltFromDownDeg as number).toBeLessThan(1)
      yaws.push(back.yawDeg as number)
    }
    expect(yaws[1]! - yaws[0]!).toBeCloseTo(90, 0)
  })

  it('keeps the arm in the configuration of its start: the elbow and the wrist stay on their side wherever it reaches', async () => {
    const c = ctx()
    const start = (await ok(c, 'get_robot_pose', { id: 'r1' })).row as number[]
    const side = (row: number[]) => [Math.sign(row[2]!), Math.sign(row[4]!)]
    // points all round the robot, behind its idle pose as well as in front, so the base swings up to a half turn
    const at = (out: number, around: number, high: number) => [AT[0] + out * Math.cos(TURN + around), high, AT[2] - out * Math.sin(TURN + around)]
    for (const [out, around, high] of [[1.6, 0, 0.9], [1.4, 1.2, 0.6], [1.2, -2, 1.2], [1.8, 3, 0.8]]) {
      const solved = await ok(c, 'solve_robot_pose', { id: 'r1', target: at(out!, around!, high!) })
      expect(solved, JSON.stringify([out, around, high, solved.missMm, solved.note])).toMatchObject({ reached: true, configuration: 'kept' })
      expect(side(solved.row as number[])).toEqual(side(start))
    }
    // close in and low, this configuration's elbow would bend past its limit: the answer says so instead of switching,
    // and switches only when asked
    const close = at(1.0, -0.6, 0.4)
    const refused = await ok(c, 'solve_robot_pose', { id: 'r1', target: close })
    expect(refused.reached).toBe(false)
    expect(refused.note).toMatch(/another configuration reaches it.*anyConfiguration: true/i)
    const switched = await ok(c, 'solve_robot_pose', { id: 'r1', target: close, anyConfiguration: true })
    expect(switched).toMatchObject({ reached: true, configuration: 'changed' })
    expect(side(switched.row as number[])).not.toEqual(side(start))
  })

  it('says when a point is out of reach, and refuses a part that is not a robot', async () => {
    const c = ctx()
    const far = await ok(c, 'solve_robot_pose', { id: 'r1', target: [AT[0] + 20, 1, AT[2]] })
    expect(far.reached).toBe(false)
    expect(far.note).toMatch(/not reachable/)
    const r = await callAgentTool(c, 'solve_robot_pose', { id: 'nope', target: [0, 0, 0] })
    expect(r.ok).toBe(false)
  })
})

describe('core robot IK', () => {
  it('reaches targets the arm can reach, from a neighbouring pose', () => {
    const kin = robotKinematics(ROBOT.geometry as never, ROBOT.behavior)!
    let seed = 11
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    let reached = 0
    for (let k = 0; k < 30; k++) {
      const goal = Object.fromEntries(kin.joints.map((j) => [j.name, j.min + (j.max - j.min) * (0.2 + 0.6 * rnd())]))
      const target = rigWorldPoses(kin.geometry, goal).get(kin.end)!.pos
      // start a little away from the goal, as a neighbouring waypoint would be
      const start = Object.fromEntries(kin.joints.map((j) => [j.name, goal[j.name]! + (rnd() - 0.5) * 0.6]))
      const r = solveRobotIk({ geometry: kin.geometry, joints: kin.joints.map((j) => j.name), end: kin.end, target, seed: start })
      if (r.miss < 0.002) reached++
    }
    expect(reached).toBeGreaterThanOrEqual(28)
  })
})

describe('import_robot', () => {
  const URDF = `<robot name="boxarm">
    <link name="base"><visual><geometry><box size="0.2 0.2 0.2"/></geometry></visual></link>
    <link name="arm"><visual><geometry><box size="0.5 0.05 0.05"/></geometry></visual></link>
    <link name="tool0"/>
    <joint name="yaw" type="revolute"><parent link="base"/><child link="arm"/><origin xyz="0 0 0.2"/><axis xyz="0 0 1"/><limit lower="-3" upper="3"/></joint>
    <joint name="flange" type="fixed"><parent link="arm"/><child link="tool0"/><origin xyz="0.5 0 0"/></joint>
  </robot>`
  const shell = (text: string) => ({
    readModel: async (path: string) => ({ name: path.split('/').pop()!, bytes: new TextEncoder().encode(text), files: [{ path: 'urdf/r.urdf', bytes: new TextEncoder().encode(text) }], root: 'urdf/r.urdf' }),
  })

  it('makes a robot part from a URDF read by the desktop shell, ready to place', async () => {
    const c = { ...ctx(), shell: shell(URDF) } as unknown as AgentToolContext
    const r = await ok(c, 'import_robot', { path: '/robots/boxarm/urdf/r.urdf' })
    expect(r).toMatchObject({ name: 'boxarm', links: 3, robot: { waypointColumns: ['yaw °'], gripPoint: 'gripper', tools: true } })
    const placed = await ok(c, 'add_part', { package: r.id, position: [0, 0, 0] })
    expect(placed.id).toBeTruthy()
  })

  it('expands xacro, naming a missing include, and refuses a robot without the desktop app', async () => {
    const c = { ...ctx(), shell: shell('<robot xmlns:xacro="x"><xacro:include filename="a.xacro"/></robot>') } as unknown as AgentToolContext
    const r = await callAgentTool(c, 'import_robot', { path: '/robots/r.urdf' })
    expect(r.ok ? '' : r.error).toMatch(/could not expand r\.urdf: the file urdf\/a\.xacro is not in the folder/)
    const none = await callAgentTool(ctx(), 'import_robot', { path: '/robots/r.urdf' })
    expect(none.ok ? '' : none.error).toMatch(/desktop app/)
  })

  it('asks for a xacro argument that names a model the package lacks, then imports the one given', async () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const XACRO =
      '<robot xmlns:xacro="x" name="kit"><xacro:arg name="model" default="none"/><xacro:arg name="tip" default="false"/>' +
      '<xacro:property name="d" value="${xacro.load_yaml(\'$(find kit)/config/$(arg model)/d.yaml\')}"/>' +
      '<link name="base"/><link name="arm"/><link name="tool0"/>' +
      '<joint name="yaw" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/></joint>' +
      '<joint name="flange" type="fixed"><parent link="arm"/><child link="tool0"/><origin xyz="${d.reach} 0 0"/></joint>' +
      '<xacro:if value="$(arg tip)"><link name="tip"/><joint name="tip_joint" type="fixed"><parent link="tool0"/><child link="tip"/></joint></xacro:if></robot>'
    const files = [
      { path: 'kit/package.xml', bytes: enc('<package><name>kit</name></package>') },
      { path: 'kit/urdf/kit.urdf.xacro', bytes: enc(XACRO) },
      { path: 'kit/config/k1/d.yaml', bytes: enc('reach: 0.3') },
      { path: 'kit/config/k2/d.yaml', bytes: enc('reach: 0.5') },
    ]
    const c = { ...ctx(), shell: { readModel: async () => ({ name: 'kit.urdf.xacro', bytes: files[1]!.bytes, files, root: 'kit/urdf/kit.urdf.xacro' }) } } as unknown as AgentToolContext
    const asked = await callAgentTool(c, 'import_robot', { path: '/ws/kit/urdf/kit.urdf.xacro' })
    expect(asked.ok ? '' : asked.error).toMatch(/model is 'none'.*args \{ "model": one of k1, k2 \}/)
    const r = await ok(c, 'import_robot', { path: '/ws/kit/urdf/kit.urdf.xacro', args: { model: 'k2' } })
    expect(r).toMatchObject({ name: 'kit (k2)', args: { model: 'k2', tip: 'false' }, switches: { tip: false }, robot: { waypointColumns: ['yaw °'] } })
    const tipped = await ok(c, 'import_robot', { path: '/ws/kit/urdf/kit.urdf.xacro', args: { model: 'k2', tip: 'true' } })
    expect(tipped).toMatchObject({ name: 'kit (k2, tip)', links: 4, switches: { tip: true } })
  })
})
