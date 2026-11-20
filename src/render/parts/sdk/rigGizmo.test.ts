import { Group, Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { PartPackage } from '../../../core/parts/partPackage'
import { buildRigGizmo } from './rigGizmo'

type RigGeo = Extract<PartPackage['geometry'], { kind: 'rig' }>

// a five-joint chain shaped like the six-axis robot's J1-J5: base yaw, shoulder + elbow pitch, wrist roll + pitch
const JOINTS = [
  { name: 'j1', link: 'basePivot', type: 'revolute', axis: [0, 1, 0], min: -3.1, max: 3.1 },
  { name: 'j2', link: 'upperArm', type: 'revolute', axis: [0, 0, 1], min: -2.3, max: 2.3 },
  { name: 'j3', link: 'forearm', type: 'revolute', axis: [0, 0, 1], min: -2.7, max: 2.7 },
  { name: 'j4', link: 'wristRot', type: 'revolute', axis: [1, 0, 0], min: -3.1, max: 3.1 },
  { name: 'j5', link: 'wristPitch', type: 'revolute', axis: [0, 0, 1], min: -2.0, max: 2.0 },
] as RigGeo['joints']

function arm(at: [number, number, number], scene?: Scene, baseAt: [number, number, number] = [0, 0.3, 0]) {
  const part = new Group()
  part.position.set(...at)
  scene?.add(part) // in the scene BEFORE the build = the rebuild case
  const links = new Map<string, Group>()
  const link = (name: string, parent: Object3D, offset: [number, number, number]): Group => {
    const g = new Group()
    g.position.set(...offset)
    parent.add(g)
    links.set(name, g)
    return g
  }
  const base = link('basePivot', part, baseAt)
  const upper = link('upperArm', base, [0.1, 0.3, 0])
  const fore = link('forearm', upper, [0, 0.7, 0])
  const wrist = link('wristRot', fore, [0.6, 0, 0])
  const tip = link('wristPitch', wrist, [0.1, 0, 0])
  const applied: Record<string, number>[] = []
  const applyJoints = (pose: Record<string, number>): void => {
    applied.push({ ...pose })
    for (const j of JOINTS) links.get(j.link)!.quaternion.setFromAxisAngle(new Vector3(...j.axis), pose[j.name] ?? 0)
  }
  const geo = { kind: 'rig', posable: true, links: [], joints: JOINTS } as unknown as RigGeo
  const gizmo = buildRigGizmo(geo, part, links, applyJoints, {})!
  return { gizmo, part, tip, applied }
}

describe('rig gizmo IK', () => {
  // the toTip projection once re-subtracted the pivot from an already-mutated vector, so the miss grew with
  // the part's distance from the world origin (161 mm at the origin, 624 mm at 10,0,10)
  it.each([
    [[0, 0, 0]],
    [[3, 0, 3]],
    [[10, 0, 10]],
    [[30, 0, -30]],
    [[0, 5, 0]],
  ] as [[number, number, number]][])('reaches a reachable target with the part at %j', (at) => {
    const { gizmo, part, tip } = arm(at)
    const target = new Vector3(0.5, 1.0, 0.3).add(part.position)
    gizmo.api.solveIK(target)
    part.updateWorldMatrix(true, true)
    expect(tip.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(0.01)
  })

  it('refreshes only its own part, not the scene it was rebuilt into', () => {
    const scene = new Scene()
    // a neighbour whose matrix is set by hand (the dock leveler's way): a scene-wide updateMatrix() resets it
    const neighbour = new Object3D()
    neighbour.matrixAutoUpdate = false
    const handSet = new Matrix4().makeTranslation(4, 0, 0)
    neighbour.matrix.copy(handSet)
    scene.add(neighbour)
    const { gizmo, part } = arm([2, 0, 2], scene)
    gizmo.api.solveIK(new Vector3(0.5, 1.0, 0.3).add(part.position))
    expect(neighbour.matrix.equals(handSet)).toBe(true)
  })
})

describe('rig gizmo idle pose', () => {
  it('keeps a dragged pose across re-applies of the same idle pose, and yields to a changed one', () => {
    const { gizmo, applied } = arm([0, 0, 0])
    gizmo.applyIdle({ j2: 0.5 })
    gizmo.api.setJointAngle!(0, 45)
    gizmo.applyIdle({ j2: 0.5 }) // an unrelated param change re-applies the same idle pose
    expect(applied.at(-1)!.j1).toBeCloseTo(Math.PI / 4)
    gizmo.applyIdle({ j2: 0.25 }) // the Inspector's pose row edited
    expect(applied.at(-1)).toEqual({ j2: 0.25 })
  })
})

describe('rig gizmo layout', () => {
  it('lifts a ring off the part origin, where the transform gizmo sits, to the next joint level', () => {
    // J1 pivots AT the part origin (a robot's base): its ring slides up its own axis to J2's height
    const atOrigin = arm([5, 0, 5], undefined, [0, 0, 0]).gizmo.api.layout()
    expect(atOrigin.joints[0]!.center.toArray().map((v) => +v.toFixed(6))).toEqual([5, 0.3, 5])
    // ...and a pivot off the origin keeps its ring on the pivot
    const raised = arm([5, 0, 5]).gizmo.api.layout()
    expect(raised.joints[0]!.center.toArray().map((v) => +v.toFixed(6))).toEqual([5, 0.3, 5])
    expect(raised.joints[1]!.center.distanceTo(new Vector3(5.1, 0.6, 5))).toBeLessThan(1e-6)
  })

  it('reports the held angle, with the handle turned that far from the zero direction', () => {
    const { gizmo } = arm([0, 0, 0])
    gizmo.api.setJointAngle!(1, 30)
    const j2 = gizmo.api.layout().joints[1]!
    expect(j2.label).toBe('J2')
    expect(j2.angle).toBeCloseTo(Math.PI / 6)
    expect(j2.revolute).toBe(true)
    expect([j2.min, j2.max]).toEqual([-2.3, 2.3])
    // signed about the axis: zero turned by +30 deg points at the handle
    expect(j2.zeroDir.clone().applyAxisAngle(j2.axis, Math.PI / 6).distanceTo(j2.handleDir)).toBeLessThan(1e-6)
    expect(Math.abs(j2.handleDir.dot(j2.axis))).toBeLessThan(1e-6)
  })

  it('puts the tool-size dots and the tool outline at the param values, on the posed link', () => {
    const part = new Group()
    part.position.set(1, 0, 0)
    const tool = new Group()
    tool.position.set(0, 2, 0)
    part.add(tool)
    const links = new Map<string, Group>([['tool', tool]])
    const geo = {
      kind: 'rig', posable: true, links: [],
      joints: [{ name: 'j1', link: 'tool', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
    } as unknown as RigGeo
    const specs = {
      toolX: { type: 'number', default: 0.5, handle: { kind: 'rigSize', link: 'tool', axis: 'x', frameY: -0.1 } },
      toolZ: { type: 'number', default: 0.5, handle: { kind: 'rigSize', link: 'tool', axis: 'z', frameY: -0.1 } },
    } as unknown as PartPackage['params']
    const gizmo = buildRigGizmo(geo, part, links, () => {}, specs)!
    gizmo.setSizes!({ toolX: 1.2, toolZ: 0.4 })
    const l = gizmo.api.layout()
    expect(l.sizes.map((s) => [s.handle, ...s.pos.toArray().map((v) => +v.toFixed(6))])).toEqual([
      ['size:toolX', 1.6, 1.9, 0],
      ['size:toolZ', 1, 1.9, 0.2],
    ])
    expect(l.toolOutlines).toHaveLength(1)
    expect(l.toolOutlines[0]!.map((c) => [+c.x.toFixed(6), +c.z.toFixed(6)])).toEqual([[0.4, -0.2], [1.6, -0.2], [1.6, 0.2], [0.4, 0.2]])
  })
})

describe('rig gizmo jog', () => {
  it('is jogged only while held off the saved idle pose, and Reset goes back to it', () => {
    const { gizmo, applied } = arm([0, 0, 0])
    gizmo.applyIdle({ j2: 0.5 })
    expect(gizmo.api.jogged!()).toBe(false)
    gizmo.api.setJointAngle!(0, 45)
    expect(gizmo.api.jogged!()).toBe(true)
    gizmo.api.resetJog!()
    expect(gizmo.api.jogged!()).toBe(false)
    expect(applied.at(-1)).toMatchObject({ j1: 0, j2: 0.5 })
    // a dragged pose the saved one then changes to (Capture Pose writes it) is no longer a jog
    gizmo.api.setJointAngle!(0, 45)
    gizmo.applyIdle({ j1: Math.PI / 4, j2: 0.5 })
    expect(gizmo.api.jogged!()).toBe(false)
  })
})

// six joints with a robot's wrist: J4 turns about the forearm, J5 pitches, J6 rolls the tool, all three axes through
// the J5 pivot (the wrist centre)
function arm6(at: [number, number, number]) {
  const part = new Group()
  part.position.set(...at)
  const links = new Map<string, Group>()
  const link = (name: string, parent: Object3D, offset: [number, number, number]): Group => {
    const g = new Group()
    g.position.set(...offset)
    parent.add(g)
    links.set(name, g)
    return g
  }
  const base = link('basePivot', part, [0, 0, 0])
  const upper = link('upperArm', base, [0.1, 0.3, 0])
  const fore = link('forearm', upper, [0, 0.7, 0])
  const wristRot = link('wristRot', fore, [0, 0.6, 0])
  const wristPitch = link('wristPitch', wristRot, [0, 0.3, 0])
  const tool = link('tool', wristPitch, [0, 0.2, 0])
  const joints = [
    { name: 'j1', link: 'basePivot', type: 'revolute', axis: [0, 1, 0], min: -3.1, max: 3.1 },
    { name: 'j2', link: 'upperArm', type: 'revolute', axis: [0, 0, 1], min: -2.3, max: 2.3 },
    { name: 'j3', link: 'forearm', type: 'revolute', axis: [0, 0, 1], min: -2.7, max: 2.7 },
    { name: 'j4', link: 'wristRot', type: 'revolute', axis: [0, 1, 0], min: -3.1, max: 3.1 },
    { name: 'j5', link: 'wristPitch', type: 'revolute', axis: [0, 0, 1], min: -2.0, max: 2.0 },
    { name: 'j6', link: 'tool', type: 'revolute', axis: [0, 1, 0], min: -6.2, max: 6.2 },
  ] as RigGeo['joints']
  const applyJoints = (pose: Record<string, number>): void => {
    for (const j of joints) links.get(j.link)!.quaternion.setFromAxisAngle(new Vector3(...j.axis), pose[j.name] ?? 0)
  }
  const geo = { kind: 'rig', posable: true, links: [], joints } as unknown as RigGeo
  const gizmo = buildRigGizmo(geo, part, links, applyJoints, {})!
  gizmo.applyIdle({ j2: 0.3, j3: 1.0, j5: 0.8 }) // bent, clear of the wrist's straight-line singularity
  return { gizmo, part, tool }
}

describe('rig gizmo IK keeping the tool orientation', () => {
  const toolState = (part: Group, tool: Group) => {
    part.updateWorldMatrix(true, true)
    return { pos: tool.getWorldPosition(new Vector3()), q: tool.getWorldQuaternion(new Quaternion()) }
  }

  it.each([[[0, 0, 0]], [[12, 0, -7]]] as [[number, number, number]][])('moves the tool and keeps its orientation, part at %j', (at) => {
    const { gizmo, part, tool } = arm6(at)
    const before = toolState(part, tool)
    gizmo.api.beginIK!()
    const target = before.pos.clone().add(new Vector3(0.15, -0.1, 0.1))
    gizmo.api.solveIK(target)
    const after = toolState(part, tool)
    expect(after.pos.distanceTo(target)).toBeLessThan(0.01)
    expect(after.q.angleTo(before.q)).toBeLessThan(0.01) // rad, under a degree
  })

  it('lets the orientation go when the drag is free', () => {
    const { gizmo, part, tool } = arm6([0, 0, 0])
    const before = toolState(part, tool)
    gizmo.api.beginIK!()
    const target = before.pos.clone().add(new Vector3(0.15, -0.1, 0.1))
    gizmo.api.solveIK(target, true)
    const after = toolState(part, tool)
    expect(after.pos.distanceTo(target)).toBeLessThan(0.01)
    expect(after.q.angleTo(before.q)).toBeGreaterThan(0.05)
  })

  it('gives J6 a ring of its own', () => {
    expect(arm6([0, 0, 0]).gizmo.api.layout().joints.map((j) => j.label)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6'])
  })
})

// An arm whose last three axes do not meet at one point (an offset wrist), seven joints long, with a finger branching
// off beside its tool frame: the shapes of imported robot arms. Dimensions are made up.
function offsetArm() {
  const part = new Group()
  const links = new Map<string, Group>()
  const link = (name: string, parent: Object3D, offset: [number, number, number]): Group => {
    const g = new Group()
    g.position.set(...offset)
    parent.add(g)
    links.set(name, g)
    return g
  }
  const l1 = link('l1', part, [0, 0.1, 0])
  const l2 = link('l2', l1, [0, 0.1, 0.12])
  const l3 = link('l3', l2, [0, 0.4, 0])
  const l4 = link('l4', l3, [0.35, 0, -0.1])
  const l5 = link('l5', l4, [0.08, 0, 0.06])
  const l6 = link('l6', l5, [0, -0.08, 0.05])
  const l7 = link('l7', l6, [0.06, 0, 0])
  link('tcp', l7, [0.1, 0, 0])
  link('finger', l7, [0.08, 0.02, 0])
  const joints = [
    { name: 'j1', link: 'l1', type: 'revolute', axis: [0, 1, 0], min: -3, max: 3 },
    { name: 'j2', link: 'l2', type: 'revolute', axis: [0, 0, 1], min: -2.5, max: 2.5 },
    { name: 'j3', link: 'l3', type: 'revolute', axis: [0, 0, 1], min: -2.5, max: 2.5 },
    { name: 'j4', link: 'l4', type: 'revolute', axis: [1, 0, 0], min: -3, max: 3 },
    { name: 'j5', link: 'l5', type: 'revolute', axis: [0, 0, 1], min: -3, max: 3 },
    { name: 'j6', link: 'l6', type: 'revolute', axis: [0, 1, 0], min: -3, max: 3 },
    { name: 'j7', link: 'l7', type: 'revolute', axis: [1, 0, 0], min: -3, max: 3 },
    { name: 'grip', link: 'finger', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.04 },
  ] as RigGeo['joints']
  const pose: Record<string, number> = {}
  const applyJoints = (p: Record<string, number>): void => {
    Object.assign(pose, p)
    for (const j of joints) {
      const g = links.get(j.link)!
      if (j.type === 'revolute') g.quaternion.setFromAxisAngle(new Vector3(...j.axis), p[j.name] ?? 0)
    }
  }
  const geo = { kind: 'rig', posable: true, tool: 'tcp', links: [], joints } as unknown as RigGeo
  const gizmo = buildRigGizmo(geo, part, links, applyJoints, {})!
  return { gizmo, part, tcp: links.get('tcp')!, pose }
}

describe('rig gizmo on an imported arm', () => {
  it('drags the named tool, moving only the joints above it, and rings every joint', () => {
    const { gizmo, part, tcp, pose } = offsetArm()
    expect(gizmo.api.layout().joints.map((j) => j.label)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8'])
    part.updateWorldMatrix(true, true)
    expect(gizmo.api.layout().ee.distanceTo(tcp.getWorldPosition(new Vector3()))).toBeLessThan(1e-9)
    gizmo.api.solveIK(tcp.getWorldPosition(new Vector3()).add(new Vector3(-0.1, -0.15, 0.1)), true)
    expect(pose.grip ?? 0).toBe(0)
  })

  it('holds the tool orientation through a drag on an offset wrist', () => {
    const { gizmo, part, tcp } = offsetArm()
    gizmo.api.setRigPose!({ j2: 0.4, j3: -0.9, j5: 0.6, j6: 0.3 })
    part.updateWorldMatrix(true, true)
    gizmo.api.beginIK!()
    const q0 = tcp.getWorldQuaternion(new Quaternion())
    const from = tcp.getWorldPosition(new Vector3())
    const target = from.clone().add(new Vector3(0.05, -0.08, 0.06))
    for (let s = 1; s <= 10; s++) gizmo.api.solveIK(from.clone().lerp(target, s / 10))
    part.updateWorldMatrix(true, true)
    expect(tcp.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(0.002)
    expect(q0.angleTo(tcp.getWorldQuaternion(new Quaternion()))).toBeLessThan(0.01)
  })
})
