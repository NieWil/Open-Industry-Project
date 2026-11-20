import { describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../types'
import type { PartInstance, SceneJSON } from '../types'
import { registerPackage } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import { PACKAGE_FORMAT } from '../parts/partPackage'
import { blankScene } from './scene'
import { partInUnits, sceneUnits, setSceneUnits } from './sceneUnits'

// The shape every first-party conveyor declares (examples/parts/_shared/conveyorUnits.js): a units switch, a speed each way,
// a speed tag each way commanding them, and a feedback scale each way whose labels differ only in the unit.
function conveyorPackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.units-conveyor',
    name: 'Units conveyor',
    params: {
      fpmUnits: { type: 'boolean', default: true, whenAbsent: false, imperialUnits: true, label: 'PLC speed in FPM' },
      speedFpm: { type: 'number', default: 394, min: -600, max: 600, step: 1, unit: 'FPM', label: 'Speed', visibleWhen: { param: 'fpmUnits', is: true } },
      speed: { type: 'number', default: 2, min: -3, max: 3, step: 0.1, unit: 'm/s', label: 'Speed', visibleWhen: { param: 'fpmUnits', is: false } },
      speedTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag (m/s)', visibleWhen: { param: 'fpmUnits', is: false } },
      speedFpmTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speedFpm', default: '', label: 'Speed tag (FPM)', visibleWhen: { param: 'fpmUnits', is: true } },
      speedAt30: { type: 'number', default: 2, min: 0.01, max: 10, step: 0.01, label: 'Speed that reads 30 (m/s)', visibleWhen: { param: 'fpmUnits', is: false } },
      speedAt30Fpm: { type: 'number', default: 394, min: 1, max: 2000, step: 1, label: 'Speed that reads 30 (FPM)', visibleWhen: { param: 'fpmUnits', is: true } },
      runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Run tag' },
    },
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 1, width: 1, height: 1 } },
  } as PartPackage
}
registerPackage(conveyorPackage())

const conveyor = (id: string, params: Record<string, unknown>): PartInstance =>
  ({ id, type: 'part', packageId: 'test.units-conveyor', position: [0, 0, 0], rotationY: 0, params }) as PartInstance

describe('sceneUnits', () => {
  it('metric is the default: for a scene saved before Units existed and for a new one', () => {
    expect(sceneUnits({})).toBe('metric')
    expect(sceneUnits(blankScene())).toBe('metric')
    expect(sceneUnits({ units: 'imperial' })).toBe('imperial')
  })
})

describe('partInUnits', () => {
  it('carries the speed, the feedback scale and the bound speed tag to their FPM twins', () => {
    const p = partInUnits(conveyor('c1', { speed: 2, speedAt30: 1.5, speedTag: 'Line1Speed', runTag: 'Run' }), 'imperial')
    expect(p.params).toMatchObject({ fpmUnits: true, speedFpm: 393.7007874, speedAt30Fpm: 295.2755906, speedFpmTag: 'Line1Speed', speedTag: '', runTag: 'Run' })
  })

  it('and back: FPM to m/s, the tag to the REAL field', () => {
    const p = partInUnits(conveyor('c1', { fpmUnits: true, speedFpm: 200, speedAt30Fpm: 394, speedFpmTag: 'Line1Speed' }), 'metric')
    expect(p.params).toMatchObject({ fpmUnits: false, speed: 1.016, speedTag: 'Line1Speed', speedFpmTag: '' })
    expect((p.params as Record<string, number>).speedAt30).toBeCloseTo(2.00152, 6)
  })

  it('round-trips exactly: FPM is not rounded to whole numbers on the way through', () => {
    const there = partInUnits(conveyor('c1', { speed: 2, speedAt30: 1.5 }), 'imperial')
    const back = partInUnits(there, 'metric')
    expect(back.params).toMatchObject({ fpmUnits: false, speed: 2, speedAt30: 1.5 })
  })

  it('reads an unset value as its default, and keeps a converted one inside the twin range', () => {
    // no speed saved = the m/s default 2 -> 393.70 FPM; 3 m/s is 590.55 FPM, inside the FPM range
    expect(partInUnits(conveyor('c1', {}), 'imperial').params).toMatchObject({ speedFpm: 393.7007874 })
    expect(partInUnits(conveyor('c1', { speed: 3 }), 'imperial').params).toMatchObject({ speedFpm: 590.5511811 })
    // 600 FPM is 3.048 m/s, past the m/s max of 3: clamped
    expect(partInUnits(conveyor('c1', { fpmUnits: true, speedFpm: 600 }), 'metric').params).toMatchObject({ speed: 3 })
  })

  it('leaves a part already in those units, and a part with no switch, untouched', () => {
    const metric = conveyor('c1', { speed: 2 }) // absent switch = whenAbsent = m/s
    expect(partInUnits(metric, 'metric')).toBe(metric)
    const box = { id: 'b', type: 'part', packageId: 'test.none', position: [0, 0, 0], rotationY: 0, params: {} } as unknown as PartInstance
    expect(partInUnits(box, 'imperial')).toBe(box)
  })
})

describe('setSceneUnits', () => {
  it('sets the Units, converts every conveyor, and names the speed tags whose unit changed', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [conveyor('c1', { speed: 2, speedTag: 'B' }), conveyor('c2', { speed: 1, speedTag: 'A' }), conveyor('c3', { speed: 1 })],
    }
    const change = setSceneUnits(scene, 'imperial')
    expect(change.scene.units).toBe('imperial')
    expect(change.switched).toBe(3)
    expect(change.tags).toEqual(['A', 'B'])
    expect(change.scene.parts.map((p) => (p.params as Record<string, unknown>).speedFpm)).toEqual([393.7007874, 196.8503937, 196.8503937])
  })

  it('a switch to the units a scene already has changes no part', () => {
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [conveyor('c1', { speed: 2 })] }
    const change = setSceneUnits(scene, 'metric')
    expect(change.switched).toBe(0)
    expect(change.scene.parts[0]).toBe(scene.parts[0])
  })
})

describe('setSceneUnits and the Length', () => {
  const scene = (extra: Partial<SceneJSON>): SceneJSON => ({ ...blankScene(), ...extra })

  it('carries a Length of the other system to the new Units, and says so', () => {
    const toImperial = setSceneUnits(scene({ units: 'metric', lengthUnit: 'mm' }), 'imperial')
    expect('lengthUnit' in toImperial.scene).toBe(false)
    expect(toImperial.length).toBe('in')
    const toMetric = setSceneUnits(scene({ units: 'imperial', lengthUnit: 'in' }), 'metric')
    expect('lengthUnit' in toMetric.scene).toBe(false)
    expect(toMetric.length).toBe('m')
  })

  it('reports the move for a scene with no Length saved too, since what it shows changes', () => {
    expect(setSceneUnits(scene({}), 'imperial').length).toBe('in')
  })

  it('keeps a Length already of the new system, and a switch to the same Units moves nothing', () => {
    const kept = setSceneUnits(scene({ units: 'imperial', lengthUnit: 'mm' }), 'metric')
    expect(kept.scene.lengthUnit).toBe('mm')
    expect(kept.length).toBeUndefined()
    expect(setSceneUnits(scene({ units: 'metric', lengthUnit: 'mm' }), 'metric').length).toBeUndefined()
  })
})
