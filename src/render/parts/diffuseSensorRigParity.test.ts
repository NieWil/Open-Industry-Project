import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { rigWorldPoses } from '../../core/rig/rigPose'
import { rayObb } from '../../core/beamCast'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { SENSOR_EMIT_Y, SENSOR_EMIT_Z, SENSOR_HEIGHT } from '../../core/types'
import { examplePart, type RigGeo } from './examplePart'
const { assets: DIFFUSE_SENSOR_ASSETS, behavior: DIFFUSE_SENSOR_BEHAVIOR, materials: DIFFUSE_SENSOR_MATERIALS, geometry: DIFFUSE_SENSOR_RIG, head: DIFFUSE_SENSOR_HEAD } = examplePart<RigGeo>('oip.diffuse-sensor')

// The Diffuse Sensor as a custom part (examples/parts/diffuse-sensor) must emit its beam from the lens face along
// local +Z. It exercises C-sensing (the beam), C-emissive
// (the detection LED), and a PLC presence tag. This pins the beam geometry + a functional ray-cast against a box
// placed ahead of the lens.

const geo = DIFFUSE_SENSOR_RIG
const lens = geo.links.find((l) => l.name === 'lens')!
const parts = (): MeshPart[] => evalPartGeometry(DIFFUSE_SENSOR_BEHAVIOR, {}) ?? []
const range = (ps: MeshPart[], axis: 0 | 1 | 2): [number, number] => {
  const vs = ps.flatMap((p) => p.desc.positions.filter((_, i) => i % 3 === axis))
  return [Math.min(...vs), Math.max(...vs)]
}

describe('Diffuse Sensor custom-part rig - parity with the built-in', () => {
  it('is a structurally valid package (the real GLB housing + materials, a beam, a behavior declaring the LED lamp)', () => {
    expect(
      validatePartPackage({
        format: PACKAGE_FORMAT,
        id: 'oip.diffuse-sensor',
        name: 'Diffuse Sensor',
        params: {},
        behavior: "definePart({ lamps:['led'], step(){} })",
        geometry: geo,
        assets: DIFFUSE_SENSOR_ASSETS,
        materials: DIFFUSE_SENSOR_MATERIALS,
      }),
    ).toEqual([])
  })

  it('is drawn in code: no model file, every housing material declared', () => {
    expect(DIFFUSE_SENSOR_ASSETS).toEqual([])
    expect(geo.links.some((l) => l.shape.kind === 'mesh')).toBe(false)
    const matIds = new Set(DIFFUSE_SENSOR_MATERIALS.map((m) => m.id))
    const ps = parts()
    expect(ps.length).toBeGreaterThan(0)
    for (const p of ps) expect(matIds.has(p.material!)).toBe(true)
  })

  // The housing is a generic photoeye drawn in code. What it must keep is the interface the rest of the app is
  // placed against. Each number below is read by something else: the beam and its guard cut (the
  // SENSOR_EMIT_* constants), the guard snap (`at`), the footprint (`bounds`).
  it('keeps the interface: the height, the lens face, the beam inside the window, bounds that fit the housing', () => {
    const ps = parts()
    // the housing's, without its mounting bracket, whose leg runs on down a conveyor's frame wall
    // (examples/parts/_shared/sensorPhotoeye.js PHOTOEYE_BRACKET)
    const housing = ps.filter((p) => p.material !== 'steel')
    const [y0, y1] = range(housing, 1)
    expect(y0).toBeCloseTo(0, 4) // the plug stands on the floor
    expect(y1).toBeCloseTo(SENSOR_HEIGHT, 4)
    // the beam leaves the lens face, where the lens link, the snap point and SENSOR_EMIT_Z all sit
    const body = ps.find((p) => p.material === 'body')!
    expect(range([body], 2)[1]).toBeCloseTo(SENSOR_EMIT_Z, 4)
    expect(lens.offset).toEqual([0, SENSOR_EMIT_Y, SENSOR_EMIT_Z])
    expect(DIFFUSE_SENSOR_HEAD.snap?.mounts?.[0]?.at).toEqual([0, 0, SENSOR_EMIT_Z])
    // ... through the window, not the housing
    const [wy0, wy1] = range(ps.filter((p) => p.material === 'lens'), 1)
    expect(SENSOR_EMIT_Y).toBeGreaterThan(wy0)
    expect(SENSOR_EMIT_Y).toBeLessThan(wy1)
    // the declared footprint is the housing's, not the mounting bracket's, which stands off one flank onto
    // whatever the eye is bolted to (examples/parts/_shared/sensorPhotoeye.js PHOTOEYE_BRACKET)
    const [x0, x1] = range(housing, 0)
    const [bz0] = range([body], 2)
    expect(geo.bounds!.length).toBeCloseTo(x1 - x0, 3)
    expect(geo.bounds!.width).toBeCloseTo(SENSOR_EMIT_Z - bz0, 3)
    expect(geo.bounds!.top).toBeCloseTo(SENSOR_HEIGHT, 4)
    // the LED is set into the face, above the window
    const led = geo.links.find((l) => l.name === 'led')!
    expect(led.offset![2]).toBeLessThan(SENSOR_EMIT_Z)
    expect(led.offset![1]).toBeGreaterThan(wy1)
  })

  it('emits a beam from the lens (along local +Z) and has an emissive detection LED', () => {
    expect(lens.beam).toBeTruthy()
    expect(lens.beam!.range).toBeGreaterThan(0)
    expect(lens.beam!.axis ?? [0, 0, 1]).toEqual([0, 0, 1]) // default +Z
    expect(geo.links.find((l) => l.name === 'led')!.lamps?.[0]?.emissive).toBeTruthy()
  })

  it('the beam detects a box placed ahead of the lens, and misses one off to the side', () => {
    const pose = rigWorldPoses(geo, {}).get('lens')!
    const origin = pose.pos
    const dir: [number, number, number] = [0, 0, 1] // local +Z (part at identity)
    // a box 1 m ahead at the lens height → hit within range
    const ahead = rayObb(origin, dir, [origin[0], origin[1], origin[2] + 1], [0, 0, 0, 1], [0.2, 0.2, 0.2])
    expect(ahead).not.toBeNull()
    expect(ahead!).toBeLessThanOrEqual(lens.beam!.range)
    // a box off to the side (in X) → missed
    expect(rayObb(origin, dir, [origin[0] + 1, origin[1], origin[2] + 1], [0, 0, 0, 1], [0.2, 0.2, 0.2])).toBeNull()
  })
})
