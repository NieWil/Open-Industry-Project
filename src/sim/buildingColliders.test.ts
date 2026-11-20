import initJolt from 'jolt-physics'
import type Jolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPackage } from '../core/parts/partRegistry'
import type { PackageManifest } from '../core/parts/partPackage'
import { createSdkPart, defaultBuilding } from '../core/scene/scene'
import { GROUND_SIZE, SCENE_VERSION } from '../core/types'
import type { PartInstance } from '../core/types'
import { buildPackage } from './buildPackage'
import { groundHalfExtent } from './buildingColliders'
import { SimWorld } from './world'

const J = await initJolt()

describe('groundHalfExtent', () => {
  it('keeps the default ground when every building fits on it', () => {
    const b = defaultBuilding('b') // 50 x 40 m
    expect(groundHalfExtent([b], GROUND_SIZE / 2)).toBe(GROUND_SIZE / 2)
    expect(groundHalfExtent([], GROUND_SIZE / 2)).toBe(GROUND_SIZE / 2)
  })

  it('grows to hold the floor of a building longer than the ground', () => {
    const b = defaultBuilding('b')
    b.params.lengthSections = 9 // 90 m along x
    b.params.widthSections = 5
    const half = groundHalfExtent([b], GROUND_SIZE / 2)
    expect(half).toBeGreaterThan(45)
    expect(half).toBeLessThan(47)
  })

  it('follows a building that is moved and turned', () => {
    const b = defaultBuilding('b')
    b.params.lengthSections = 6
    b.params.widthSections = 2
    b.position = [0, 0, 20]
    b.rotationY = Math.PI / 2 // the 60 m length now runs along z, from -10 to 50
    expect(groundHalfExtent([b], GROUND_SIZE / 2)).toBeGreaterThan(50)
  })
})

describe('the ground under a building in a running world', () => {
  const crateManifest: PackageManifest = {
    id: 'acme.ground-crate',
    name: 'Crate',
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.6, 0.4, 0.4] }, offset: [0, 0, 0] }], joints: [] },
    cargo: { friction: 0.5 },
  }
  const crate = buildPackage(crateManifest, 'definePart({ params: { mass: { type: "number", default: 10 } }, step() {} })')
  registerPackage(crate)
  const crateY = (w: SimWorld): number => {
    const box = (w as unknown as { boxes: { partId: string | null; body: Jolt.Body }[] }).boxes.find((b) => b.partId === 'crate')!
    return box.body.GetPosition().GetY()
  }
  const bigBuilding = (): PartInstance => {
    const b = defaultBuilding('bld')
    b.params.lengthSections = 9
    b.params.widthSections = 5
    b.params.rules = []
    return b
  }
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
  })

  it('holds a crate standing 40 m out on the floor of a 90 m building', () => {
    const parts = [bigBuilding(), createSdkPart(crate, 'crate', [40, 0.2, 0], 0)]
    world = new SimWorld(J, { version: SCENE_VERSION, parts, packages: [crate] }, { hz: 60 })
    for (let i = 0; i < 60; i++) world.step()
    expect(crateY(world)).toBeCloseTo(0.2, 2)
  })

  it('grows the floor when a building that reaches there is added while it runs', () => {
    const parts: PartInstance[] = [createSdkPart(crate, 'crate', [40, 0.2, 0], 0)]
    world = new SimWorld(J, { version: SCENE_VERSION, parts, packages: [crate] }, { hz: 60 })
    world.updateScene({ version: SCENE_VERSION, parts: [bigBuilding(), ...parts], packages: [crate] })
    for (let i = 0; i < 60; i++) world.step()
    expect(crateY(world)).toBeCloseTo(0.2, 2)
  })

  it('has no floor 40 m out without a building', () => {
    world = new SimWorld(J, { version: SCENE_VERSION, parts: [createSdkPart(crate, 'crate', [40, 0.2, 0], 0)], packages: [crate] }, { hz: 60 })
    for (let i = 0; i < 60; i++) world.step()
    expect(crateY(world)).toBeLessThan(-1)
  })
})
