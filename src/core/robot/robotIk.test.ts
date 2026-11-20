// The ready pose an imported arm idles in (robotReadyPose): on a six-axis arm drawn lying flat, as a URDF often draws
// one, it puts the tool down in front of the base with the elbow up, and the part's Home and idle pose take it.
import { describe, expect, it } from 'vitest'
import { parseUrdf } from '../urdf'
import { urdfToRig } from '../urdfRig'
import { instantiatePartScript } from '../parts/partScript'
import { qApply, rigWorldPoses } from '../rig/rigPose'
import { rigPoseColumns, robotKinematicsOf, robotReadyPose } from './robotIk'
import { robotBehavior } from './robotPart'

// six revolute joints, every link reaching out along +X at zero: the arm lies flat
const FLAT_ARM = `<robot name="flat_arm">
  <link name="base_link"/><link name="l1"/><link name="l2"/><link name="l3"/><link name="l4"/><link name="l5"/><link name="l6"/><link name="tool0"/>
  <joint name="j1" type="revolute"><parent link="base_link"/><child link="l1"/><origin xyz="0 0 0.1"/><axis xyz="0 0 1"/><limit lower="-6.28" upper="6.28"/></joint>
  <joint name="j2" type="revolute"><parent link="l1"/><child link="l2"/><origin xyz="0 0.1 0"/><axis xyz="0 1 0"/><limit lower="-6.28" upper="6.28"/></joint>
  <joint name="j3" type="revolute"><parent link="l2"/><child link="l3"/><origin xyz="0.4 -0.08 0"/><axis xyz="0 1 0"/><limit lower="-3.14" upper="3.14"/></joint>
  <joint name="j4" type="revolute"><parent link="l3"/><child link="l4"/><origin xyz="0.35 0 0"/><axis xyz="0 1 0"/><limit lower="-6.28" upper="6.28"/></joint>
  <joint name="j5" type="revolute"><parent link="l4"/><child link="l5"/><origin xyz="0 0.08 0"/><axis xyz="0 0 1"/><limit lower="-6.28" upper="6.28"/></joint>
  <joint name="j6" type="revolute"><parent link="l5"/><child link="l6"/><origin xyz="0 0 -0.08"/><axis xyz="0 1 0"/><limit lower="-6.28" upper="6.28"/></joint>
  <joint name="flange" type="fixed"><parent link="l6"/><child link="tool0"/><origin xyz="0 0.08 0" rpy="-1.5707963 0 0"/></joint>
</robot>`

const flatArm = () => {
  const rig = urdfToRig(parseUrdf(FLAT_ARM), { drawn: new Set() })
  return { rig, kin: robotKinematicsOf(rig.geometry, rig.robot!)! }
}

describe('robotReadyPose', () => {
  it('puts the tool down in front of the base, elbow up', () => {
    const { kin } = flatArm()
    const ready = robotReadyPose(kin)!
    expect(ready).not.toBeNull()
    const at = rigWorldPoses(kin.geometry, ready)
    const grip = at.get(kin.end)!.pos
    const pivot = (name: string) => at.get(kin.joints.find((j) => j.name === name)!.link)!.pos
    // in front (+X) and on the base's centre line
    expect(grip[0]).toBeGreaterThan(0.2)
    expect(Math.abs(grip[2])).toBeLessThan(0.002)
    // the tool points straight down
    const down = qApply(at.get(kin.approach!.link)!.quat, kin.approach!.axis)
    expect(down[1]).toBeLessThan(-0.9998)
    // elbow up: the upper arm (0.4 m) stands nearly upright from the shoulder, where elbow down would hang below it
    expect(pivot('j3')[1]).toBeGreaterThan(pivot('j2')[1] + 0.35)
    // and the same answer every time
    expect(robotReadyPose(kin)).toEqual(ready)
  })

  it('is the Home waypoint and the idle pose of the part', () => {
    const { rig, kin } = flatArm()
    const ready = robotReadyPose(kin)!
    const def = instantiatePartScript(robotBehavior('flat', rig.robot!, kin.joints, { tools: true, ready })).def!
    const deg = kin.joints.map((j) => Math.round(((ready[j.name]! * 180) / Math.PI) * 10) / 10 + 0)
    const params = def.params as Record<string, { default: unknown }>
    expect(params.waypoints!.default).toEqual([deg])
    expect(params.pose!.default).toEqual([deg])
    // without one, Home stays every joint at 0
    const plain = instantiatePartScript(robotBehavior('flat', rig.robot!, kin.joints, { tools: true })).def!
    expect((plain.params as Record<string, { default: unknown }>).pose!.default).toEqual([kin.joints.map(() => 0)])
  })

  it('leaves an arm with a sliding joint at zero', () => {
    const { kin } = flatArm()
    const slid = { ...kin, joints: kin.joints.map((j, i) => (i === 0 ? { ...j, type: 'prismatic' as const } : j)) }
    expect(robotReadyPose(slid)).toBeNull()
  })
})

// One rule for a posed row's columns: Capture Pose writes a row with it and the stopped scene's idle pose reads the
// row back with it. Two copies of it once disagreed on a sliding joint's unit.
describe('rigPoseColumns', () => {
  const DEG = 180 / Math.PI

  it("lists a robot's controller joints, in the controller's units", () => {
    const { rig } = flatArm()
    const columns = rigPoseColumns(rig.geometry, rig.robot!)
    expect(columns.map((c) => c.joint.name)).toEqual(['j1', 'j2', 'j3', 'j4', 'j5', 'j6'])
    expect(columns.every((c) => c.unit === DEG)).toBe(true)
    // a robot's sliding joint is in millimetres
    const slid = { ...rig.geometry, joints: rig.geometry.joints.map((j) => (j.name === 'j1' ? { ...j, type: 'prismatic' as const } : j)) }
    expect(rigPoseColumns(slid, rig.robot!)[0]!.unit).toBe(1000)
  })

  it("lists any other rig's posable joints, turning ones in degrees and sliding ones in metres", () => {
    const { rig } = flatArm()
    const joints = rig.geometry.joints.slice(0, 4).map((j, i) => ({
      ...j,
      ...(i === 1 ? { type: 'prismatic' as const } : {}),
      ...(i === 2 ? { cosmetic: true } : {}),
      ...(i === 3 ? { mimic: { joint: 'j1' } } : {}),
    }))
    const columns = rigPoseColumns({ ...rig.geometry, joints }, null)
    expect(columns.map((c) => [c.joint.name, c.unit])).toEqual([['j1', DEG], ['j2', 1]])
  })
})
