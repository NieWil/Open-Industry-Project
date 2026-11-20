import { describe, expect, it } from 'vitest'
import { parseUrdf, resolveMeshPath, rpyToQuat, UrdfError, type UrdfRobot } from './urdf'
import { safeRigName, urdfToRig, URDF_ASSET, Z_UP_TO_Y_UP } from './urdfRig'
import { linkMeshesToGlb } from './urdfGlb'
import { parseGlb } from './glbBox'
import { qApply, qMul, rigWorldPoses, type Quat } from './rig/rigPose'
import { validatePartPackage } from './parts/partValidate'

const ARM = `<?xml version="1.0"?>
<robot name="test_arm">
  <material name="orange"><color rgba="1 0.5 0 1"/></material>
  <link name="base_link">
    <visual>
      <origin xyz="0 0 0.05" rpy="0 0 0"/>
      <geometry><cylinder radius="0.1" length="0.1"/></geometry>
      <material name="orange"/>
    </visual>
  </link>
  <link name="upper.arm">
    <visual><geometry><mesh filename="package://arm_description/meshes/upper.stl" scale="0.001 0.001 0.001"/></geometry></visual>
  </link>
  <link name="tool0"/>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/><child link="upper.arm"/>
    <origin xyz="0 0 0.1" rpy="0 0 1.5707963"/>
    <axis xyz="0 1 0"/>
    <limit lower="-2" upper="2" velocity="1"/>
  </joint>
  <joint name="slide" type="prismatic">
    <parent link="upper.arm"/><child link="tool0"/>
    <origin xyz="0.5 0 0" rpy="0.3 -0.2 0.1"/>
    <axis xyz="0 0 2"/>
    <limit lower="0" upper="0.2"/>
  </joint>
</robot>`

describe('parseUrdf', () => {
  it('reads links, visuals, named materials and joints', () => {
    const r = parseUrdf(ARM)
    expect(r.name).toBe('test_arm')
    expect(r.links.map((l) => l.name)).toEqual(['base_link', 'upper.arm', 'tool0'])
    expect(r.links[0]!.visuals[0]).toEqual({ origin: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] }, geometry: { kind: 'cylinder', radius: 0.1, length: 0.1 }, rgba: [1, 0.5, 0, 1] })
    expect(r.links[1]!.visuals[0]!.geometry).toEqual({ kind: 'mesh', filename: 'package://arm_description/meshes/upper.stl', scale: [0.001, 0.001, 0.001] })
    expect(r.joints[0]).toMatchObject({ name: 'shoulder', type: 'revolute', parent: 'base_link', child: 'upper.arm', axis: [0, 1, 0], limit: { lower: -2, upper: 2, velocity: 1 } })
  })

  it('defaults a missing axis to +X and a missing origin to identity', () => {
    const r = parseUrdf('<robot name="r"><link name="a"/><link name="b"/><joint name="j" type="continuous"><parent link="a"/><child link="b"/></joint></robot>')
    expect(r.joints[0]).toMatchObject({ axis: [1, 0, 0], origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] } })
  })

  it('refuses xacro, other XML and a robot without links', () => {
    const code = (text: string): string | undefined => {
      try {
        parseUrdf(text)
      } catch (e) {
        return (e as UrdfError).code
      }
      return undefined
    }
    expect(code('<robot xmlns:xacro="http://www.ros.org/wiki/xacro"><xacro:include filename="a.xacro"/></robot>')).toBe('xacro')
    expect(code('<robot name="r"><link name="${prefix}base"/></robot>')).toBe('xacro')
    expect(code('<project/>')).toBe('not-urdf')
    expect(code('<robot name="r"/>')).toBe('no-links')
  })
})

describe('rpyToQuat', () => {
  it('is Rz(yaw) Ry(pitch) Rx(roll)', () => {
    const axis = (a: [number, number, number], t: number): Quat => [a[0] * Math.sin(t / 2), a[1] * Math.sin(t / 2), a[2] * Math.sin(t / 2), Math.cos(t / 2)]
    const [r, p, y] = [0.3, -0.2, 0.1]
    const expected = qMul(qMul(axis([0, 0, 1], y), axis([0, 1, 0], p)), axis([1, 0, 0], r))
    rpyToQuat([r, p, y]).forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 12))
  })
})

describe('resolveMeshPath', () => {
  const files = ['arm_description/urdf/arm.urdf', 'arm_description/meshes/upper.stl', 'arm_description/meshes/visual/base.dae', 'other/meshes/upper.stl']
  it('matches package:// by its longest tail', () => {
    expect(resolveMeshPath('package://arm_description/meshes/upper.stl', files[0]!, files)).toBe('arm_description/meshes/upper.stl')
    expect(resolveMeshPath('package://renamed_pkg/meshes/visual/base.dae', files[0]!, files)).toBe('arm_description/meshes/visual/base.dae')
  })
  it('resolves a relative path against the URDF file', () => {
    expect(resolveMeshPath('../meshes/upper.stl', files[0]!, files)).toBe('arm_description/meshes/upper.stl')
  })
  it('is null when no file matches', () => {
    expect(resolveMeshPath('package://x/meshes/missing.stl', files[0]!, files)).toBeNull()
  })
})

/** Forward kinematics the URDF way, written out independently of the rig: each joint is origin then motion. */
function urdfWorld(robot: UrdfRobot, values: Record<string, number>, link: string): { pos: [number, number, number]; quat: Quat } {
  const joint = robot.joints.find((j) => j.child === link)
  if (!joint) return { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
  const parent = urdfWorld(robot, values, joint.parent)
  const o = joint.origin
  let pos = add(parent.pos, qApply(parent.quat, o.xyz))
  let quat = qMul(parent.quat, rpyToQuat(o.rpy))
  const v = values[joint.name] ?? 0
  const len = Math.hypot(...joint.axis)
  const a: [number, number, number] = [joint.axis[0] / len, joint.axis[1] / len, joint.axis[2] / len]
  if (joint.type === 'revolute' || joint.type === 'continuous') quat = qMul(quat, [a[0] * Math.sin(v / 2), a[1] * Math.sin(v / 2), a[2] * Math.sin(v / 2), Math.cos(v / 2)])
  if (joint.type === 'prismatic') pos = add(pos, qApply(quat, [a[0] * v, a[1] * v, a[2] * v]))
  return { pos, quat }
}
const add = (a: readonly number[], b: readonly number[]): [number, number, number] => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!]

describe('urdfToRig', () => {
  const robot = parseUrdf(ARM)

  it('makes a link per URDF link and a joint per moving joint, names made safe', () => {
    const { geometry, linkNames } = urdfToRig(robot, { drawn: new Set(['base_link', 'upper.arm']) })
    expect(linkNames.get('upper.arm')).toBe('upper_arm')
    // the URDF's links first; an arm without a hand then carries the app's tool links
    expect(geometry.links.slice(3).map((l) => l.name)).toEqual(['toolMount', 'gripper', 'fingerA', 'fingerB'])
    expect(geometry.links.slice(0, 3).map((l) => [l.name, l.parent, l.shape])).toEqual([
      ['base_link', undefined, { kind: 'mesh', asset: URDF_ASSET, node: 'base_link' }],
      ['upper_arm', 'base_link', { kind: 'mesh', asset: URDF_ASSET, node: 'upper_arm' }],
      ['tool0', 'upper_arm', { kind: 'frame' }],
    ])
    expect(geometry.joints.slice(0, 2)).toEqual([
      { name: 'shoulder', link: 'upper_arm', type: 'revolute', axis: [0, 1, 0], min: -2, max: 2 },
      { name: 'slide', link: 'tool0', type: 'prismatic', axis: [0, 0, 1], min: 0, max: 0.2 },
    ])
    expect(geometry.posable).toBe(true)
    // the teach gizmo drags the tool frame ROS-Industrial names tool0
    expect(geometry.tool).toBe('tool0')
  })

  it('takes a TCP frame as the tool over a flange, and names none when no link says so', () => {
    const r = (names: string[]) => parseUrdf(`<robot name="t">${names.map((n) => `<link name="${n}"/>`).join('')}</robot>`)
    expect(urdfToRig(r(['base', 'hand_flange', 'hand_tcp']), { drawn: new Set() }).geometry.tool).toBe('hand_tcp')
    expect(urdfToRig(r(['base', 'link_6']), { drawn: new Set() }).geometry.tool).toBeUndefined()
  })

  it('poses every link where URDF puts it, turned Z-up to Y-up', () => {
    const { geometry, linkNames } = urdfToRig(robot, { drawn: new Set() })
    const poses: Record<string, number>[] = [{}, { shoulder: 0.7, slide: 0.15 }, { shoulder: -1.9, slide: 0.05 }]
    for (const values of poses) {
      const world = rigWorldPoses(geometry, values)
      for (const l of robot.links) {
        const want = urdfWorld(robot, values, l.name)
        const got = world.get(linkNames.get(l.name)!)!
        // the app's frame is the URDF frame turned by Z_UP_TO_Y_UP
        const wantPos = qApply(Z_UP_TO_Y_UP, want.pos)
        const wantQuat = qMul(Z_UP_TO_Y_UP, want.quat)
        got.pos.forEach((v, i) => expect(v).toBeCloseTo(wantPos[i]!, 9))
        const sign = Math.sign(got.quat[3] * wantQuat[3] + got.quat[0] * wantQuat[0] + got.quat[1] * wantQuat[1] + got.quat[2] * wantQuat[2]) || 1
        got.quat.forEach((v, i) => expect(v).toBeCloseTo(sign * wantQuat[i]!, 9))
      }
    }
  })

  it('stands URDF +Z up as +Y, and bounds the rest pose', () => {
    // a 0.1 m cube centred 0.05 m above the base: it sits on the floor
    const { geometry } = urdfToRig(robot, { drawn: new Set(['base_link']), boxes: new Map([['base_link', { min: [-0.05, -0.05, 0], max: [0.05, 0.05, 0.1] }]]) })
    expect(geometry.bounds).toEqual({ length: 0.1, width: 0.1, top: 0.1, bottom: 0 })
  })

  it('notes what it could not import as written', () => {
    const r = parseUrdf(`<robot name="r">
      <link name="a"/><link name="b"/><link name="c"/><link name="d"/>
      <joint name="free" type="floating"><parent link="a"/><child link="b"/></joint>
      <joint name="nolimit" type="revolute"><parent link="a"/><child link="c"/></joint>
      <joint name="follow" type="revolute"><parent link="a"/><child link="d"/><limit lower="-1" upper="1"/><mimic joint="again"/></joint>
      <joint name="again" type="fixed"><parent link="b"/><child link="c"/></joint>
      <joint name="ghost" type="fixed"><parent link="a"/><child link="zz"/></joint>
    </robot>`)
    const { geometry, notes } = urdfToRig(r, { drawn: new Set() })
    expect(notes).toEqual([
      { code: 'second-parent', subject: 'c' },
      { code: 'unknown-link', subject: 'ghost' },
      { code: 'fixed-in-place', subject: 'free' },
      { code: 'no-limit', subject: 'nolimit' },
      { code: 'mimic', subject: 'follow' },
    ])
    expect(geometry.joints.find((j) => j.name === 'nolimit')).toMatchObject({ min: -Math.PI, max: Math.PI })
  })

  it('makes a mimic joint follow its leader, in the pose and past its own command', () => {
    const r = parseUrdf(`<robot name="g">
      <link name="hand"/><link name="left"/><link name="right"/>
      <joint name="f1" type="prismatic"><parent link="hand"/><child link="left"/><axis xyz="0 1 0"/><limit lower="0" upper="0.04"/></joint>
      <joint name="f2" type="prismatic"><parent link="hand"/><child link="right"/><axis xyz="0 -1 0"/><limit lower="0" upper="0.04"/>
        <mimic joint="f1" multiplier="0.5" offset="0.01"/></joint>
    </robot>`)
    const { geometry, notes } = urdfToRig(r, { drawn: new Set() })
    expect(notes).toEqual([])
    expect(geometry.joints[1]).toEqual({ name: 'f2', link: 'right', type: 'prismatic', axis: [0, -1, 0], min: 0, max: 0.04, mimic: { joint: 'f1', multiplier: 0.5, offset: 0.01 } })
    // f1 at 0.03 puts f2 at 0.025, whatever f2 itself is told; f1 past its limit is held to it first
    const right = (values: Record<string, number>) => rigWorldPoses(geometry, values).get('right')!.pos
    const free = { ...geometry, joints: geometry.joints.map(({ mimic: _, ...j }) => j) }
    const at = (v: number) => rigWorldPoses(free, { f2: v }).get('right')!.pos
    right({ f1: 0.03, f2: 0 }).forEach((v, i) => expect(v).toBeCloseTo(at(0.025)[i]!, 12))
    right({ f1: 1 }).forEach((v, i) => expect(v).toBeCloseTo(at(0.03)[i]!, 12))
  })

  it('validates a mimic joint: another joint of the rig, one that follows none', () => {
    const pkg = (mimics: Record<string, unknown>) =>
      validatePartPackage({
        format: 6,
        id: 'user.m',
        name: 'm',
        params: {},
        behavior: 'definePart({ params: {}, step(ctx) {} })',
        geometry: {
          kind: 'rig',
          links: ['a', 'b', 'c'].map((name) => ({ name, shape: { kind: 'frame' }, offset: [0, 0, 0] })),
          joints: ['a', 'b', 'c'].map((link) => ({ name: `j${link}`, link, type: 'revolute', axis: [0, 0, 1], min: -1, max: 1, ...(mimics[link] ? { mimic: mimics[link] } : {}) })),
        },
      }).map((p) => p.message)
    expect(pkg({ b: { joint: 'ja', multiplier: -1 } })).toEqual([])
    expect(pkg({ b: { joint: 'nope' } })).toEqual([expect.stringMatching(/must name another joint/)])
    expect(pkg({ b: { joint: 'jb' } })).toEqual([expect.stringMatching(/must name another joint/)])
    expect(pkg({ b: { joint: 'ja' }, c: { joint: 'jb' } })).toEqual([expect.stringMatching(/follows a joint itself/)])
  })

  it('takes a hand for a hand when no link is named as the tool frame', () => {
    // the last moving joint is a finger: the tool is the hand it hangs from, not the finger
    const r = parseUrdf(`<robot name="h">
      <link name="base"/><link name="upper"/><link name="hand"/><link name="left"/><link name="right"/>
      <joint name="j1" type="revolute"><parent link="base"/><child link="upper"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/></joint>
      <joint name="j2" type="revolute"><parent link="upper"/><child link="hand"/><origin xyz="0.4 0 0"/><axis xyz="0 1 0"/><limit lower="-1" upper="1"/></joint>
      <joint name="f1" type="prismatic"><parent link="hand"/><child link="left"/><axis xyz="0 1 0"/><limit lower="0" upper="0.04"/></joint>
      <joint name="f2" type="prismatic"><parent link="hand"/><child link="right"/><axis xyz="0 -1 0"/><limit lower="0" upper="0.04"/><mimic joint="f1"/></joint>
    </robot>`)
    const rig = urdfToRig(r, { drawn: new Set() })
    expect(rig.hand).toBe(true)
    expect(rig.robot).toMatchObject({ joints: ['j1', 'j2'], gripper: 'hand', gripJoint: { name: 'f1', open: 0.04, closed: 0 } })
  })

  it('makes each collision element a hidden collider under its link', () => {
    const r = parseUrdf(`<robot name="c">
      <link name="base">
        <collision><origin xyz="0 0 0.1"/><geometry><box size="0.2 0.3 0.2"/></geometry></collision>
        <collision><origin xyz="0 0 0.5" rpy="0 0 0"/><geometry><cylinder radius="0.05" length="0.6"/></geometry></collision>
        <collision><origin xyz="1 0 0" rpy="0 0 1.5707963267948966"/><geometry><mesh filename="m.stl"/></geometry></collision>
        <collision><geometry><mesh filename="gone.stl"/></geometry></collision>
      </link>
    </robot>`)
    const base = r.links[0]!
    const { geometry } = urdfToRig(r, { drawn: new Set(), collisionBoxes: new Map([[base.collisions[2]!, { min: [0, 0, 0], max: [0.4, 0.2, 0.1] }]]) })
    const colliders = geometry.links.filter((l) => l.parent === 'base')
    expect(colliders.map((l) => [l.name, l.hidden, l.shape])).toEqual([
      ['base_collision', true, { kind: 'box', size: [0.2, 0.3, 0.2] }],
      ['base_collision_2', true, { kind: 'cylinder', radius: 0.05, height: 0.6 }],
      ['base_collision_3', true, { kind: 'box', size: [0.4, 0.2, 0.1] }],
    ])
    // the cylinder stands along the link's +Z, as URDF's does
    qApply(colliders[1]!.quat!, [0, 1, 0]).forEach((v, i) => expect(v).toBeCloseTo([0, 0, 1][i]!, 12))
    // the mesh's box sits at its centre, turned by the collision origin: (0.2, 0.1) turned 90° is (-0.1, 0.2)
    colliders[2]!.offset.forEach((v, i) => expect(v).toBeCloseTo([0.9, 0.2, 0.05][i]!, 9))
  })

  it('keeps a mesh name clear of the mesh-node suffix', () => {
    expect(safeRigName('arm_visual')).toBe('arm_visual_')
    expect(safeRigName('a b/c')).toBe('a_b_c')
  })

  it('builds a package the validator accepts', () => {
    const { geometry } = urdfToRig(robot, { drawn: new Set(['base_link']) })
    const tri = { color: [1, 0, 0, 1] as [number, number, number, number], pos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), nrm: null, idx: new Uint32Array([0, 1, 2]) }
    const { glb } = linkMeshesToGlb([{ name: 'base_link', pieces: [tri] }])
    const problems = validatePartPackage({
      format: 6,
      id: 'user.urdf',
      name: 'arm',
      params: {},
      behavior: 'definePart({ params: {}, step(ctx) {} })',
      geometry,
      assets: [{ id: URDF_ASSET, mime: 'model/gltf-binary', data: Buffer.from(glb).toString('base64') }],
    })
    expect(problems).toEqual([])
  })
})

describe('linkMeshesToGlb', () => {
  it('writes a node per link, merging pieces of one colour into one primitive', () => {
    const tri = (color: [number, number, number, number]) => ({ color, pos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), nrm: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), idx: new Uint32Array([0, 1, 2]) })
    const { glb, triangles } = linkMeshesToGlb([
      { name: 'base', pieces: [tri([1, 0, 0, 1]), tri([1, 0, 0, 1]), tri([0, 0, 1, 1])] },
      { name: 'empty', pieces: [] },
      { name: 'arm', pieces: [tri([1, 0, 0, 1])] },
    ])
    expect(triangles).toBe(4)
    const { json } = parseGlb(glb) as { json: { nodes: { name: string; mesh: number }[]; meshes: { name: string; primitives: { material: number }[] }[]; materials: unknown[] } }
    expect(json.nodes.map((n) => n.name)).toEqual(['base', 'arm'])
    expect(json.meshes.map((m) => [m.name, m.primitives.map((p) => p.material)])).toEqual([
      ['base_visual', [0, 1]],
      ['arm_visual', [0]],
    ])
    expect(json.materials).toHaveLength(2)
  })

  it('paints a textured piece with its image: texture coordinates, one image however many pieces use it', () => {
    const tri = (image?: number) => ({
      color: [1, 1, 1, 1] as [number, number, number, number],
      pos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      nrm: null,
      idx: new Uint32Array([0, 1, 2]),
      ...(image !== undefined ? { uv: new Float32Array([0, 1, 1, 1, 0, 0]), image } : {}),
    })
    const images = [{ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/webp' }]
    const { glb } = linkMeshesToGlb([{ name: 'a', pieces: [tri(0), tri()] }, { name: 'b', pieces: [tri(0)] }], images)
    type Json = {
      meshes: { primitives: { attributes: Record<string, number>; material: number }[] }[]
      materials: { pbrMetallicRoughness: { baseColorTexture?: { index: number } } }[]
      textures: { extensions: { EXT_texture_webp: { source: number } } }[]
      images: { mimeType: string }[]
      extensionsRequired: string[]
    }
    const { json } = parseGlb(glb) as { json: Json }
    expect(json.images).toEqual([expect.objectContaining({ mimeType: 'image/webp' })])
    expect(json.textures).toEqual([{ extensions: { EXT_texture_webp: { source: 0 } } }])
    expect(json.extensionsRequired).toEqual(['EXT_texture_webp'])
    const [textured, plain] = json.meshes[0]!.primitives
    expect(json.materials[textured!.material]!.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 })
    expect('TEXCOORD_0' in textured!.attributes).toBe(true)
    expect(json.materials[plain!.material]!.pbrMetallicRoughness.baseColorTexture).toBeUndefined()
    expect('TEXCOORD_0' in plain!.attributes).toBe(false)
    expect(json.meshes[1]!.primitives[0]!.material).toBe(textured!.material)
  })
})
