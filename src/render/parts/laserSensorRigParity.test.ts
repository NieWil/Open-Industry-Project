import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { rigWorldPoses } from '../../core/rig/rigPose'
import { rayObb } from '../../core/beamCast'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { SENSOR_HEIGHT } from '../../core/types'
import { examplePart, type RigGeo } from './examplePart'
const { assets: LASER_SENSOR_ASSETS, behavior: LASER_SENSOR_BEHAVIOR, materials: LASER_SENSOR_MATERIALS, geometry: LASER_SENSOR_RIG, head: LASER_SENSOR_HEAD } = examplePart<RigGeo>('oip.laser-sensor')

// The Laser Sensor (examples/parts/laser-sensor) is a Diffuse-Sensor variant that exercises C-sensing's distance
// output: it reports ctx.sense().distance to a PLC REAL tag. The distance readout is tested end-to-end (real
// Jolt) in src/sim/sensorVariants.test.ts; here we check the generated artifact's shape.

const geo = LASER_SENSOR_RIG
const lens = geo.links.find((l) => l.name === 'lens')!
const parts = (): MeshPart[] => evalPartGeometry(LASER_SENSOR_BEHAVIOR, {}) ?? []
const range = (ps: MeshPart[], axis: 0 | 1 | 2): [number, number] => {
  const vs = ps.flatMap((p) => p.desc.positions.filter((_, i) => i % 3 === axis))
  return [Math.min(...vs), Math.max(...vs)]
}

describe('Laser Sensor custom-part rig - structure parity', () => {
  it('is a structurally valid package (rig + a dummy behavior declaring the LED lamp)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.laser-sensor', name: 'Laser Sensor', params: {}, behavior: "definePart({ lamps:['led'], step(){} })", geometry: geo, assets: LASER_SENSOR_ASSETS, materials: LASER_SENSOR_MATERIALS })).toEqual([])
  })

  it('is drawn in code: no model file, every housing material declared', () => {
    expect(LASER_SENSOR_ASSETS).toEqual([])
    expect(geo.links.some((l) => l.shape.kind === 'mesh')).toBe(false)
    const matIds = new Set(LASER_SENSOR_MATERIALS.map((m) => m.id))
    for (const p of parts()) expect(matIds.has(p.material!)).toBe(true)
  })

  // A generic housing with the same interface as the diffuse sensor. The beam origin must be on this housing's
  // window face: on the diffuse sensor's lens face it sits 3.7 cm inside this deeper housing, and every distance
  // reads 3.7 cm long. Here it is checked against the window's face as drawn.
  it('keeps the interface: the beam leaves the window face, the snap sits there, bounds fit the housing', () => {
    const ps = parts()
    const win = ps.filter((p) => p.material === 'lilac')
    const [, front] = range(ps, 2)
    expect(range(win, 2)[1]).toBeCloseTo(front, 6) // the window is the front face
    expect(lens.offset![2]).toBeCloseTo(front, 6)
    expect(LASER_SENSOR_HEAD.snap?.mounts?.[0]?.at).toEqual([0, 0, lens.offset![2]])
    const [wy0, wy1] = range(win, 1)
    expect(lens.offset![1]).toBeCloseTo((wy0 + wy1) / 2, 6) // through the window's centre
    // the declared footprint is the housing's
    const [x0, x1] = range(ps, 0)
    const [z0, z1] = range(ps, 2)
    expect(geo.bounds!.length).toBeCloseTo(x1 - x0, 3)
    expect(geo.bounds!.width).toBeCloseTo(z1 - z0, 3)
    // on the floor, and the LED sits on the housing (not floating over it) and tops out at the sensor height
    const [y0, y1] = range(ps, 1)
    expect(y0).toBeCloseTo(0, 4)
    const led = geo.links.find((l) => l.name === 'led')!
    const ledHalfY = (led.shape as { size: [number, number, number] }).size[1] / 2
    expect(led.offset![1] - ledHalfY).toBeCloseTo(range(ps.filter((p) => p.material === 'amber'), 1)[1], 4) // the housing's top
    expect(led.offset![1] + ledHalfY).toBeCloseTo(SENSOR_HEIGHT, 4)
    expect(geo.bounds!.top).toBeCloseTo(SENSOR_HEIGHT, 4)
    expect(y1).toBeLessThanOrEqual(SENSOR_HEIGHT)
  })

  it('emits a beam from the lens, has an emissive LED, and the behavior reports the distance to a REAL tag', () => {
    expect(lens.beam?.range).toBeGreaterThan(0)
    expect(geo.links.find((l) => l.name === 'led')!.lamps?.[0]?.emissive).toBeTruthy()
    expect(LASER_SENSOR_BEHAVIOR).toContain('ctx.sense(')
    expect(LASER_SENSOR_BEHAVIOR).toContain('.distance')
    expect(LASER_SENSOR_BEHAVIOR).toContain('writeNumber')
  })

  it('the beam reaches a box ahead of the lens (the measuring ray)', () => {
    const origin = rigWorldPoses(geo, {}).get('lens')!.pos
    expect(rayObb(origin, [0, 0, 1], [origin[0], origin[1], origin[2] + 1], [0, 0, 0, 1], [0.2, 0.2, 0.2])).not.toBeNull()
  })
})
