import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { rigWorldPoses } from '../../core/rig/rigPose'
import { rayObb } from '../../core/beamCast'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { examplePart, type RigGeo } from './examplePart'
const { assets: COLOR_SENSOR_ASSETS, behavior: COLOR_SENSOR_BEHAVIOR, materials: COLOR_SENSOR_MATERIALS, geometry: COLOR_SENSOR_RIG } = examplePart<RigGeo>('oip.color-sensor')

// The Color Sensor (examples/parts/color-sensor) is a Diffuse-Sensor variant that exercises C-sensing's colour
// output: it classifies ctx.sense().color into an INT colour code. The classification + INT tag is proven
// end-to-end (real Jolt) in src/sim/sensorVariants.test.ts; here we pin the generated artifact's shape.

const geo = COLOR_SENSOR_RIG
const lens = geo.links.find((l) => l.name === 'lens')!

describe('Color Sensor custom-part rig - structure parity', () => {
  it('is a structurally valid package (rig + a dummy behavior declaring the LED lamp)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.color-sensor', name: 'Color Sensor', params: {}, behavior: "definePart({ lamps:['led'], step(){} })", geometry: geo, assets: COLOR_SENSOR_ASSETS, materials: COLOR_SENSOR_MATERIALS })).toEqual([])
  })

  // The housing is the Diffuse Sensor's (examples/parts/_shared/sensorPhotoeye.js), whose interface diffuseSensorRigParity pins;
  // here, that the colour sensor really is that housing - same beam point, snap and footprint - in its own colours.
  it('is the diffuse housing, drawn in code, in its own colours', () => {
    const diffuse = examplePart<RigGeo>('oip.diffuse-sensor')
    expect(COLOR_SENSOR_ASSETS).toEqual([])
    const shape = (src: string) => (evalPartGeometry(src, {}) ?? []).map((p) => ({ material: p.material, positions: p.desc.positions }))
    expect(shape(COLOR_SENSOR_BEHAVIOR)).toEqual(shape(diffuse.behavior))
    expect(geo.bounds).toEqual(diffuse.geometry.bounds)
    const pick = (g: RigGeo, n: string) => g.links.find((l) => l.name === n)!.offset
    for (const n of ['lens', 'led']) expect(pick(geo, n)).toEqual(pick(diffuse.geometry, n))
    const body = (ms: typeof COLOR_SENSOR_MATERIALS) => ms.find((m) => m.id === 'body')!.color
    expect(body(COLOR_SENSOR_MATERIALS)).not.toEqual(body(diffuse.materials))
    const matIds = new Set(COLOR_SENSOR_MATERIALS.map((m) => m.id))
    for (const p of evalPartGeometry(COLOR_SENSOR_BEHAVIOR, {}) ?? []) expect(matIds.has(p.material!)).toBe(true)
  })

  it('emits a beam from the lens, has an emissive LED, and the behavior classifies the colour to an INT tag', () => {
    expect(lens.beam?.range).toBeGreaterThan(0)
    expect(geo.links.find((l) => l.name === 'led')!.lamps?.[0]?.emissive).toBeTruthy()
    expect(COLOR_SENSOR_BEHAVIOR).toContain('ctx.sense(')
    expect(COLOR_SENSOR_BEHAVIOR).toContain('classify')
    expect(COLOR_SENSOR_BEHAVIOR).toContain('writeNumber')
  })

  it('the beam reaches a box ahead of the lens (the colour-read ray)', () => {
    const origin = rigWorldPoses(geo, {}).get('lens')!.pos
    expect(rayObb(origin, [0, 0, 1], [origin[0], origin[1], origin[2] + 1], [0, 0, 0, 1], [0.2, 0.2, 0.2])).not.toBeNull()
  })
})
