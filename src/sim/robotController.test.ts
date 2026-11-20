import { describe, expect, it } from 'vitest'
import { parseUrdf } from '../core/urdf'
import { urdfToRig } from '../core/urdfRig'
import { robotBehavior } from '../core/robot/robotPart'
import { createRobot, ROBOT_OP } from '../core/robot/robotController'
import { FINGER_TRAVEL, ROBOT_TOOL_LAMP, ROBOT_TOOL_MATERIALS, TOOL_GRIP_Y } from '../core/robot/robotTools'
import { evalPartGeometry } from '../core/geometry/geometryEval'
import { resolvePartParams } from '../core/parts/partScript'
import { qApply } from '../core/rig/rigPose'
import { showParamShows } from '../core/rig/rigLinkBody'
import { robotKinematicsOf } from '../core/robot/robotIk'
import { rigJointsJson } from '../core/parts/partPackage'
import { create, destroy, stepDirect } from './embeddedBehavior'
import { validatePart } from './validatePart'

// A robot made by a URDF import runs the host's controller (core/robot/robotController.ts) through the behavior
// runtime: the import declares the robot and its params, and the PLC's job number and Execute move the arm.

const DT = 1 / 60

const URDF = `<robot name="mini">
  <link name="base"/><link name="arm"/><link name="tool0"/><link name="finger_a"/><link name="finger_b"/>
  <joint name="yaw" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-3" upper="3"/></joint>
  <joint name="reach" type="prismatic"><parent link="arm"/><child link="tool0"/><origin xyz="0.3 0 0"/><axis xyz="1 0 0"/><limit lower="0" upper="0.2"/></joint>
  <joint name="fa" type="prismatic"><parent link="tool0"/><child link="finger_a"/><axis xyz="0 1 0"/><limit lower="0" upper="0.03"/></joint>
  <joint name="fb" type="prismatic"><parent link="tool0"/><child link="finger_b"/><axis xyz="0 -1 0"/><limit lower="0" upper="0.03"/><mimic joint="fa"/></joint>
</robot>`

function robotPart() {
  const rig = urdfToRig(parseUrdf(URDF), { drawn: new Set() })
  const decl = rig.robot!
  const arm = decl.joints!.map((n) => rig.geometry.joints.find((j) => j.name === n)!)
  return { geometry: rig.geometry, decl, behavior: robotBehavior('mini', decl, arm, { tools: !rig.hand }) }
}

describe('a URDF robot', () => {
  it('drives the arm between the root and the tool, grips with the tool, and opens the finger with the grip', () => {
    const { decl, geometry } = robotPart()
    expect(geometry.tool).toBe('tool0')
    expect(decl).toEqual({ joints: ['yaw', 'reach'], gripper: 'tool0', gripJoint: { name: 'fa', open: 0.03, closed: 0 } })
    // its own hand grips: a zone at the tool frame, between the fingers, and no app tool
    expect(geometry.links.find((l) => l.name === 'tool0')!.grip?.zone?.size).toEqual([0.08, 0.08, 0.08])
    expect(decl.tool).toBeUndefined()
  })

  it('builds as a package', () => {
    const { geometry, behavior } = robotPart()
    const result = validatePart({ id: 'user.mini', name: 'mini', geometry }, behavior)
    expect(result.diagnostics).toEqual([])
    expect(result.package?.params.waypoints).toMatchObject({ type: 'numberList', columns: ['J1 °', 'J2 mm'], arity: 2 })
  })

  it('runs a job from the PLC: moves, grips, and reports Done', () => {
    const { geometry, behavior } = robotPart()
    const params = {
      commandTag: 'Cmd',
      executeTag: 'Exec',
      doneTag: 'Done',
      waypoints: [
        [0, 0],
        [90, 150],
      ],
      jobs: [
        [0, ROBOT_OP.move, 1, 0],
        [0, ROBOT_OP.grip, 1, 0],
      ],
    }
    const h = create(behavior, JSON.stringify(params), rigJointsJson(geometry))
    expect(h).toBeGreaterThan(0)
    const tick = (tags: Record<string, number | boolean>) => stepDirect(h, { simTime: 0, tags }, DT)!
    const idle = tick({ Cmd: 1, Exec: false })
    expect(idle.tags.Done).toBe(true)
    expect(idle.joints.fa).toBe(0.03) // open while the grip is off
    const started = tick({ Cmd: 1, Exec: true })
    expect(started.tags.Done).toBe(false)
    let out = started
    for (let i = 0; i < 60 * 10 && out.tags.Done !== true; i++) out = tick({ Cmd: 1, Exec: true })
    expect(out.tags.Done).toBe(true)
    expect(out.joints.yaw).toBeCloseTo(Math.PI / 2, 9)
    expect(out.joints.reach).toBeCloseTo(0.15, 9)
    expect(out.grips.tool0).toBe(true)
    // the finger closes over GRIP_SEC once the grip is on
    for (let i = 0; i < 30; i++) out = tick({ Cmd: 1, Exec: true })
    expect(out.joints.fa).toBe(0)
    destroy(h)
  })

  it('gives an arm without a hand the app tools: a mount along tool0 +Z, a vacuum plate or a clamp that opens with the grip', () => {
    const r = parseUrdf(URDF.replace(/<joint name="f[ab]"[\s\S]*?<\/joint>/g, ''))
    const rig = urdfToRig(r, { drawn: new Set() })
    const decl = rig.robot!
    expect(rig.hand).toBe(false)
    expect(decl).toEqual({ joints: ['yaw', 'reach'], gripper: 'gripper', lamp: ROBOT_TOOL_LAMP, tool: 'toolMount', gripJoint: { name: 'toolGrip', open: FINGER_TRAVEL, closed: -FINGER_TRAVEL } })
    // the mount turns tool0's +Z (outward) into the tool frame's -Y (the way the tool hangs)
    const mount = rig.geometry.links.find((l) => l.name === 'toolMount')!
    qApply(mount.quat!, [0, -1, 0]).forEach((v, i) => expect(v).toBeCloseTo([0, 0, 1][i]!, 12))
    const arm = decl.joints!.map((n) => rig.geometry.joints.find((j) => j.name === n)!)
    const behavior = robotBehavior('bare', decl, arm, { tools: true })
    const result = validatePart({ id: 'user.bare', name: 'bare', geometry: rig.geometry, materials: ROBOT_TOOL_MATERIALS }, behavior)
    expect(result.diagnostics).toEqual([])
    // the vacuum plate by default, the clamp's paddles on the finger links when picked
    const linksOf = (tool: string) => new Set((evalPartGeometry(behavior, resolvePartParams(result.package!.params, { tool })) ?? []).map((m) => m.link))
    expect(linksOf('vacuum')).toEqual(new Set(['toolMount']))
    expect(linksOf('gripper')).toEqual(new Set(['toolMount', 'fingerA', 'fingerB']))
    expect(evalPartGeometry(behavior, resolvePartParams(result.package!.params, { tool: 'none' }))).toBeNull()
    // the clamp opens while the grip is off and closes on the load when it comes on
    const h = create(behavior, JSON.stringify({ tool: 'gripper', gripperTag: 'G' }), rigJointsJson(rig.geometry))
    expect(stepDirect(h, { simTime: 0, tags: { G: false } }, DT)!.joints.toolGrip).toBe(FINGER_TRAVEL)
    let out = stepDirect(h, { simTime: 0, tags: { G: true } }, DT)!
    for (let i = 0; i < 30; i++) out = stepDirect(h, { simTime: 0, tags: { G: true } }, DT)!
    expect(out.joints.toolGrip).toBe(-FINGER_TRAVEL) // holding nothing, it closes fully
    expect(out.grips.gripper).toBe(true)
    destroy(h)
  })

  it('refuses a robot joint the rig does not have', () => {
    expect(() => createRobot({ joints: ['nope'] }, [])).toThrow(/not a joint of the rig/)
  })
})

describe('an arm with a hand of its own on its flange', () => {
  // the hand is fixed to the flange, so it can come off: the app's tools mount on the flange in its place
  const HANDED = `<robot name="handed">
    <link name="base"/><link name="arm"/><link name="flange"/><link name="hand"/><link name="tcp"/><link name="finger_a"/><link name="finger_b"/>
    <joint name="yaw" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-3" upper="3"/></joint>
    <joint name="pitch" type="revolute"><parent link="arm"/><child link="flange"/><origin xyz="0.3 0 0"/><axis xyz="0 1 0"/><limit lower="-2" upper="2"/></joint>
    <joint name="hand_mount" type="fixed"><parent link="flange"/><child link="hand"/><origin xyz="0 0 0.05"/></joint>
    <joint name="hand_tcp" type="fixed"><parent link="hand"/><child link="tcp"/><origin xyz="0 0 0.1"/></joint>
    <joint name="fa" type="prismatic"><parent link="hand"/><child link="finger_a"/><axis xyz="0 1 0"/><limit lower="0" upper="0.03"/></joint>
    <joint name="fb" type="prismatic"><parent link="hand"/><child link="finger_b"/><axis xyz="0 -1 0"/><limit lower="0" upper="0.03"/><mimic joint="fa"/></joint>
  </robot>`
  const rig = urdfToRig(parseUrdf(HANDED), { drawn: new Set() })
  const decl = rig.robot!
  const arm = decl.joints!.map((n) => rig.geometry.joints.find((j) => j.name === n)!)
  const behavior = robotBehavior('handed', decl, arm, { tools: true, hand: true })
  const link = (name: string) => rig.geometry.links.find((l) => l.name === name)!

  it('keeps its hand, and takes the app tools on the flange, the hand there only while the tool is the hand', () => {
    expect(rig.hand).toBe(true)
    expect(decl).toEqual({
      joints: ['yaw', 'pitch'],
      gripper: 'gripper',
      lamp: ROBOT_TOOL_LAMP,
      tool: 'toolMount',
      gripJoint: { name: 'toolGrip', open: FINGER_TRAVEL, closed: -FINGER_TRAVEL },
      hand: { gripper: 'tcp', gripJoint: { name: 'fa', open: 0.03, closed: 0 } },
    })
    expect(link('toolMount').parent).toBe('flange')
    expect(['hand', 'tcp', 'finger_a', 'finger_b'].map((n) => link(n).showParam)).toEqual(Array(4).fill('tool=hand'))
    expect(['flange', 'toolMount', 'gripper'].map((n) => link(n).showParam)).toEqual([undefined, undefined, undefined])
    const result = validatePart({ id: 'user.handed', name: 'handed', geometry: rig.geometry, materials: ROBOT_TOOL_MATERIALS }, behavior)
    expect(result.diagnostics).toEqual([])
    const tool = result.package!.params.tool as { default: string; options: { value: string }[] }
    expect([tool.default, tool.options.map((o) => o.value)]).toEqual(['hand', ['hand', 'vacuum', 'gripper', 'none']])
    // its own hand draws no app tool; a picked one draws on the mount
    expect(evalPartGeometry(behavior, resolvePartParams(result.package!.params, {}))).toBeNull()
    expect(new Set((evalPartGeometry(behavior, resolvePartParams(result.package!.params, { tool: 'vacuum' })) ?? []).map((m) => m.link))).toEqual(new Set(['toolMount']))
  })

  it('takes its grip point from the tool it carries', () => {
    expect(robotKinematicsOf(rig.geometry, decl)).toMatchObject({ end: 'tcp', approach: { link: 'tcp', axis: [0, 0, 1] } })
    expect(robotKinematicsOf(rig.geometry, decl, { tool: 'vacuum' })).toMatchObject({ end: 'gripper', approach: { link: 'toolMount', axis: [0, -1, 0] } })
  })

  it('grips with the hand, or with the tool picked in its place while the hand stands open', () => {
    const run = (params: Record<string, unknown>) => {
      const h = create(behavior, JSON.stringify({ ...params, gripperTag: 'G' }), rigJointsJson(rig.geometry))
      let out = stepDirect(h, { simTime: 0, tags: { G: true } }, DT)!
      for (let i = 0; i < 30; i++) out = stepDirect(h, { simTime: 0, tags: { G: true } }, DT)!
      destroy(h)
      return { grips: out.grips, fa: out.joints.fa, toolGrip: out.joints.toolGrip, lamp: out.lamps[ROBOT_TOOL_LAMP] }
    }
    expect(run({})).toEqual({ grips: { gripper: false, tcp: true }, fa: 0, toolGrip: FINGER_TRAVEL, lamp: false })
    expect(run({ tool: 'gripper' })).toEqual({ grips: { gripper: true, tcp: false }, fa: 0.03, toolGrip: -FINGER_TRAVEL, lamp: true })
  })

  it('reads a link\'s showParam as a boolean switch or as an enum value', () => {
    expect([showParamShows(undefined, {}), showParamShows('guard', { guard: false }), showParamShows('guard', {})]).toEqual([true, false, true])
    expect([showParamShows('tool=hand', { tool: 'hand' }), showParamShows('tool=hand', { tool: 'vacuum' }), showParamShows('tool=hand', {})]).toEqual([true, false, true])
  })
})

describe('the clamp gripper in the sim', () => {
  it('closes its pads onto the load it holds, narrower than its tool size', async () => {
    const { default: initJolt } = await import('jolt-physics')
    const { readFileSync } = await import('node:fs')
    const { buildPackage } = await import('./buildPackage')
    const { SimWorld } = await import('./world')
    const { validateScene } = await import('../core/scene/scene')
    const { SCENE_VERSION } = await import('../core/types')
    const Jolt = await initJolt()
    // one yawing arm whose tool0 points straight down, its grip point 0.2 m up: inside a 0.4 m case on the floor
    const urdf = parseUrdf(`<robot name="clamp">
      <link name="base"/><link name="arm"/><link name="tool0"/>
      <joint name="yaw" type="revolute"><parent link="base"/><child link="arm"/><origin xyz="0 0 ${0.2 + TOOL_GRIP_Y}"/><axis xyz="0 0 1"/><limit lower="-3" upper="3"/></joint>
      <joint name="flange" type="fixed"><parent link="arm"/><child link="tool0"/><origin xyz="0.5 0 0" rpy="${Math.PI} 0 0"/></joint>
    </robot>`)
    const rig = urdfToRig(urdf, { drawn: new Set() })
    const arm = rig.robot!.joints!.map((n) => rig.geometry.joints.find((j) => j.name === n)!)
    const robot = buildPackage({ id: 'user.clamp', name: 'clamp', geometry: rig.geometry, materials: ROBOT_TOOL_MATERIALS }, robotBehavior('clamp', rig.robot!, arm, { tools: true }))
    const boxDir = new URL('../../examples/parts/box/', import.meta.url)
    const boxRig = JSON.parse(readFileSync(new URL('rig.json', boxDir), 'utf8')) as { id: string; name: string; geometry: never }
    const box = buildPackage({ id: boxRig.id, name: boxRig.name, geometry: boxRig.geometry }, readFileSync(new URL('behavior.ts', boxDir), 'utf8'))
    const scene = validateScene({
      version: SCENE_VERSION,
      packages: [robot, box],
      parts: [
        { id: 'r', type: 'part', packageId: robot.id, position: [0, 0, 0], rotationY: 0, params: { tool: 'gripper', toolSizeX: 0.5, gripperTag: 'G' } },
        { id: 'b', type: 'part', packageId: box.id, position: [0.5, 0.2, 0], rotationY: 0, params: { length: 0.42, width: 0.3, height: 0.4 } },
      ],
    } as never)
    if (!scene.ok) throw new Error(scene.errors.join('; '))
    const w = new SimWorld(Jolt as never, scene.scene)
    w.setBehaviorInputTags({ G: true })
    for (let i = 0; i < 60; i++) w.step()
    const joints = w.frame().joints?.r ?? {}
    w.dispose()
    // the pads stand toolSizeX apart at 0; the case reaches 0.21 either side, so each closes 0.04 in
    expect(joints.toolGrip).toBeCloseTo(0.21 - 0.25, 3)
  })
})
