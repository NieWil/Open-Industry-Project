import type { PackageManifest } from '../core/parts/partPackage'
/// <reference types="vite/client" />
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPartDiagnostics, partDiagnosticsFor } from '../core/parts/partDiagnostics'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartMaterial, PartPackageGeometry } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import type { SdkPart, SceneJSON } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// The committed light curtain (examples/parts/light-curtain) through the real world: real beams cast against real
// cargo and the real pilot capsule. It is the plain device a safety program reads: its OSSD drops for anything in a
// beam, a load or a person. Muting a load through is the program's job (demoScenes.ts MutingSeq, and the muting
// sensors are photo-eye parts of their own), so nothing here mutes; the program only lights the muting lamp.

const Jolt = await initJolt()

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

function registerCurtain(): string {
  const m = RIGS['../../examples/parts/light-curtain/rig.json']!
  registerPackage(buildPackage(
    { id: m.id, name: m.name, geometry: m.geometry, ...(m.materials ? { materials: m.materials } : {}), ...((m as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (m as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) },
    BEHAVIORS['../../examples/parts/light-curtain/behavior.ts']!.replace(/\r\n/g, '\n'),
  ))
  return m.id
}

// a 1.4 m opening, beams at 0.3 .. 1.2 m, spanning local X; travel through it is along Z
const FIELD = { width: 1.4, fieldBottom: 0.3, fieldHeight: 0.9, tag: 'ossd', mutingLampTag: 'lamp' }

describe('light curtain', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  const make = (params: Record<string, unknown> = {}): SimWorld => {
    const packageId = registerCurtain()
    const curtain = { id: 'lc', type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: { ...FIELD, ...params } } as unknown as SdkPart
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [curtain] }
    return new SimWorld(Jolt, scene)
  }
  const ossd = (w: SimWorld): unknown => {
    w.step()
    return w.frame().tags?.lc?.ossd
  }

  it('holds its output on while the field is clear', () => {
    world = make()
    expect(ossd(world)).toBe(true)
  })

  it('drops its output for a load in the beams: it does not mute, the program does', () => {
    world = make()
    world.spawnBoxAt(0, 0.5, 0, 0.3, 0.2, 0.2) // a case standing in the field, beams 1 and 2 through it
    expect(ossd(world)).toBe(false)
  })

  it('drops its output for a person in the opening', () => {
    world = make()
    world.setPilotBody([0, 0, 0])
    expect(ossd(world)).toBe(false)
  })

  it('ignores what is beyond the receiver: a beam only guards the gap between the columns', () => {
    world = make()
    world.setPilotBody([1.4, 0, 0]) // centre past the receiver column (+0.7), capsule reaching back to +1.1
    expect(ossd(world)).toBe(true)
  })

  it('lights its muting lamp from the program\'s tag, and stays dark with no lamp tag named', () => {
    world = make()
    world.setBehaviorInputTags({ lamp: true })
    world.step()
    world.step()
    expect(world.frame().lamps?.lc?.muting).toBe(true)
    world.setBehaviorInputTags({ lamp: false })
    world.step()
    world.step()
    expect(world.frame().lamps?.lc?.muting).toBe(false)
    world.dispose()
    clearPackages()
    world = make({ mutingLampTag: '' })
    world.setBehaviorInputTags({ lamp: true })
    world.step()
    world.step()
    expect(world.frame().lamps?.lc?.muting).toBe(false)
  })

  it('counts the lamps its geometry() draws as real lamps: no unknown-name diagnostic for ossd / stop / muting', () => {
    clearPartDiagnostics()
    world = make()
    ossd(world)
    expect(partDiagnosticsFor('lc').filter((d) => d.source === 'unknown-name')).toEqual([])
  })
})
