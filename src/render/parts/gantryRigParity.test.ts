import { describe, expect, it } from 'vitest'
import { rigWorldPoses } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: GANTRY_RIG, materials: GANTRY_MATERIALS, assets: GANTRY_ASSETS, behavior: GANTRY_BEHAVIOR } = examplePart<RigGeo>('oip.gantry')

// The Gantry, authored as a custom part (examples/parts/gantry), is the 2nd converged manipulator and the
// first 3-axis linear one, assembled from the real Gantry.glb exactly like the built-in renderer
// (render/parts/gantry.ts): an X bridge → Y carriage → Z lift, each a prismatic joint, ending in a vacuum
// gripper. This pins the Cartesian FK - the gripper world position as a function of the (x, y, z) joint values
// - plus the joint axes, the GLB assembly (per-node mesh links node-scaled to the frame params), and the
// vacuum tool lamp.

const geo = GANTRY_RIG
// gripper = xCarriage[y = frameHeight + 0.15] + x → yCarriage[+0.095] + y(Z) → lift[frameHeight − 0.275] − z
//         → gripper[−frameHeight − 0.2], so gripper-local pose = [x, frameHeight − 0.23 − z, y] - the
//         built-in's gripper height.
const DROP = 0.23
const gripperAt = (x: number, y: number, z: number, frameHeight = 1) =>
  rigWorldPoses(geo, { x, y, z }, undefined, 1, { frameHeight }).get('gripper')!.pos

describe('Gantry custom-part rig - Cartesian FK + grip + vacuum lamp', () => {
  it('is a structurally valid package (rig + a dummy behavior declaring the axes/gripper/lamp)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.gantry', name: 'Gantry', params: {}, behavior: "definePart({ servos:['x','y','z'], grippers:['gripper'], lamps:['tool'], step(){} })", geometry: geo, assets: GANTRY_ASSETS, materials: GANTRY_MATERIALS })).toEqual([])
  })

  it('has 3 prismatic axes: x along +X, y along +Z (width), z down', () => {
    const byName = new Map(geo.joints.map((j) => [j.name, j]))
    expect(geo.joints.every((j) => j.type === 'prismatic')).toBe(true)
    expect(byName.get('x')!.axis).toEqual([1, 0, 0])
    expect(byName.get('y')!.axis).toEqual([0, 0, 1])
    expect(byName.get('z')!.axis).toEqual([0, -1, 0]) // lift travels downward
  })

  it.each([
    ['home', 0, 0, 0],
    ['pick', -1.4, 0.6, 0.7],
    ['place', 1.4, -0.6, 0.7],
  ])('the gripper tracks the (x, y, z) commands - %s', (_name, x, y, z) => {
    const g = gripperAt(x, y, z)
    expect(g[0]).toBeCloseTo(x, 6) // x along the length
    expect(g[2]).toBeCloseTo(y, 6) // y across the width (part Z)
    expect(g[1]).toBeCloseTo(1 - DROP - z, 6) // height − fixed drop − z (lowers as z grows)
  })

  it('a full-stroke lift lands the gripper at the floor, not below it (built-in maxZ parity)', () => {
    // z max = frameHeight − 0.225 → gripper at frameHeight − 0.23 − zMax = −0.005 (the built-in's floor kiss)
    expect(gripperAt(0, 0, 1 - 0.225)[1]).toBeCloseTo(-0.005, 6)
  })

  // GLB parity: every visual link renders a node of the real Gantry.glb (no primitive stand-ins), wearing the
  // built-in's Standard/Trim ORM materials; the stretching members (legs, rails, bridge beam, lift beam)
  // node-scale from the frame params at the 4 m GANTRY_STRETCH_REF (scale 1/4).
  it('assembles per-node mesh links of the real Gantry.glb with the Standard/Trim material remap', () => {
    const meshes = geo.links.filter((l) => l.shape.kind === 'mesh')
    expect(meshes.length).toBe(20)
    for (const l of meshes) {
      const shape = l.shape as Extract<typeof l.shape, { kind: 'mesh' }>
      expect(shape.asset).toBe('glb')
      expect(shape.node).toBeTruthy()
      expect(shape.materials).toBeTruthy()
    }
    // the four Leg_Main + Beam_Lift stretch with frameHeight; the two Beam_Main rails with frameLength;
    // Beam_Secondary with frameWidth - each at the 1/4 node-scale (GANTRY_STRETCH_REF 4)
    const stretched = meshes.filter((l) => (l.shape as { sizeParams?: unknown[] }).sizeParams)
    const byParam = (p: string, axis: number) =>
      stretched.filter((l) => {
        const sp = (l.shape as { sizeParams: { axis: number; param: string; scale?: number }[] }).sizeParams
        return sp.some((s) => s.param === p && s.axis === axis && s.scale === 0.25)
      })
    expect(byParam('frameHeight', 1).length).toBe(5) // 4 × Leg_Main + Beam_Lift
    expect(byParam('frameLength', 0).length).toBe(2) // the twin Beam_Main rails
    expect(byParam('frameWidth', 2).length).toBe(1) // Beam_Secondary
  })

  // A stretched member re-tiles its Trim strip instead of smearing it (mesh tileUv): the rail's bolt holes run
  // u 0..1 along the 4 m authored span, so at a 20 m frame a plain node-scale draws them five times too far apart.
  // Trim only, on each member's own stretch axis: Beam_Lift's Standard end caps sample one spot of the atlas.
  it('every stretched member re-tiles its Trim u along its own stretch axis, and nothing else re-tiles', () => {
    const stretched = geo.links.filter((l) => l.shape.kind === 'mesh' && (l.shape as { sizeParams?: unknown }).sizeParams)
    expect(stretched.length).toBe(8)
    for (const l of stretched) {
      const shape = l.shape as Extract<typeof l.shape, { kind: 'mesh' }>
      expect(shape.tileUv).toEqual([{ axis: shape.sizeParams![0]!.axis, uv: 'u', materials: ['Trim'] }])
    }
    expect(geo.links.filter((l) => (l.shape as { tileUv?: unknown }).tileUv).length).toBe(8)
  })

  it('validation refuses a tileUv that could only ever be a silent no-op', () => {
    const withTile = (tileUv: unknown): unknown[] => {
      const links = geo.links.map((l) => (l.name === 'beamF' ? { ...l, shape: { ...l.shape, tileUv } } : l))
      return validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.gantry', name: 'Gantry', params: {}, behavior: "definePart({ servos:['x','y','z'], grippers:['gripper'], lamps:['tool'], step(){} })", geometry: { ...geo, links } as typeof geo, assets: GANTRY_ASSETS, materials: GANTRY_MATERIALS })
    }
    const fields = (tileUv: unknown): string[] => withTile(tileUv).map((e) => (e as { field: string }).field)
    expect(fields([{ axis: 0, uv: 'u', materials: ['Trim'] }])).toEqual([])
    // beamF stretches along x only: re-tiling y would always multiply by 1
    expect(fields([{ axis: 1, uv: 'u', materials: ['Trim'] }]).some((f) => f.endsWith('tileUv[0].axis'))).toBe(true)
    expect(fields([{ axis: 0, uv: 'w', materials: ['Trim'] }]).some((f) => f.endsWith('tileUv[0].uv'))).toBe(true)
    expect(fields([{ axis: 0, uv: 'u', materials: [] }]).some((f) => f.endsWith('tileUv[0].materials'))).toBe(true)
    expect(fields([]).some((f) => f.endsWith('tileUv'))).toBe(true)
  })

  it('has no collision links - the frame straddles the line and never touches cargo (built-in parity)', () => {
    // mesh links without a `collision` box are visual-only; the one primitive (the vacuum LED) opts out of a body
    expect(geo.links.every((l) => l.shape.kind === 'mesh' || l.shape.kind === 'frame' || l.collision === 'none')).toBe(true)
    expect(geo.links.some((l) => l.shape.kind === 'mesh' && (l.shape as { collision?: unknown }).collision)).toBe(false)
  })

  it('the vacuum lamp is an LED box on the tool mesh, authored-lit by vacuumOn', () => {
    const tool = geo.links.find((l) => l.name === 'tool')!
    const shape = tool.shape as Extract<typeof tool.shape, { kind: 'mesh' }>
    expect(shape.node).toBe('Tool_01')
    expect(shape.materials).toEqual({ Standard: 'std', Trim: 'trim' }) // the tool shares the frame's materials
    expect(tool.lamps).toBeUndefined()
    const lamp = geo.links.find((l) => l.name === 'vacuumLamp')!
    expect(lamp.parent).toBe('tool')
    expect(lamp.shape.kind).toBe('box')
    expect(lamp.collision).toBe('none') // an indicator, not something cargo should catch on
    expect(lamp.lamps?.[0]?.emissive).toBeTruthy()
    expect(lamp.lamps?.[0]?.param).toBe('vacuumOn') // the built-in's authored vacuum glow at rest
    expect(geo.links.find((l) => l.name === 'gripper')!.shape.kind).toBe('frame') // grab point is a frame (no body)
  })

  // The frame is parametric: the behavior must declare frameLength/frameWidth/
  // frameHeight (the rig's sizeParams/offsetParams reference them; undeclared they silently fall back and
  // freeze the frame at 4×2×1) with their ranges. Axis travel inside the frame is the joints' own
  // minParam / maxParam, which the servos run inside (the behavior itself: src/sim/gantryServo.test.ts).
  it('declares the frame-size params (with ranges)', () => {
    expect(GANTRY_BEHAVIOR).toContain("frameLength: { type: 'number', default: 4, min: 0.5, max: 20")
    expect(GANTRY_BEHAVIOR).toContain("frameWidth: { type: 'number', default: 2, min: 0.3, max: 10")
    expect(GANTRY_BEHAVIOR).toContain("frameHeight: { type: 'number', default: 1, min: 0.5, max: 10")
    // the built-in's default motionSpeed
    expect(GANTRY_BEHAVIOR).toContain("speed: { type: 'number', default: 1,")
  })

  it('every axis is a servo the behavior declares, capped at the top of the speed and accel ranges', () => {
    expect(geo.joints.map((j) => [j.name, j.servo])).toEqual([
      ['x', { maxVelocity: 10, maxAccel: 50 }],
      ['y', { maxVelocity: 10, maxAccel: 50 }],
      ['z', { maxVelocity: 10, maxAccel: 50 }],
    ])
    expect(GANTRY_BEHAVIOR).toContain("servos: ['x', 'y', 'z']")
  })

  it('a taller frame lifts the gripper (the frame params drive the FK)', () => {
    expect(gripperAt(0, 0, 0, 2)[1]).toBeCloseTo(2 - DROP, 6)
  })

  it('declares the vacuum pickup volume on the grab point as a zone, with no dead radius beside it', () => {
    const gripper = geo.links.find((l) => l.name === 'gripper')!
    expect(gripper.grip?.zone).toBeTruthy()
    expect(gripper.grip?.radius).toBeUndefined()
  })
})
