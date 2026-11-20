// The Containers library's parts (libraries/containers, docs/part-libraries.md), from their sources: each behaves as
// what it declares. The IBC tote stands on its pallet base and bears a load; the drum rolls on its side. A test bin
// (fixtures/nesting-bin) covers a rig that nests: two seated by the nesting rule stay seated, foot inside the rim below.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import type Jolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { CARGO_CAP_FORK_POCKETS, CARGO_CAP_HEAVY, CARGO_CAP_LOAD_BASE, CARGO_CAP_SEPARATE_CONTACTS, cargoSeatOn, cargoView } from '../core/frame'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PackageManifest, PartPackage } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const J = await initJolt()
const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = resolve(HERE, '..', '..', 'libraries', 'containers')

function load(dir: string, root = LIB): PartPackage {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')) as PackageManifest
  const pkg = buildPackage(manifest, readFileSync(join(root, dir, 'behavior.js'), 'utf8').replace(/\r\n/g, '\n'))
  registerPackage(pkg)
  return pkg
}

interface LiveBody {
  partId: string | null
  body: Jolt.Body
}
const pos = (w: SimWorld, id: string): [number, number, number] => {
  const p = (w as unknown as { boxes: LiveBody[] }).boxes.find((x) => x.partId === id)!.body.GetPosition()
  return [p.GetX(), p.GetY(), p.GetZ()]
}

describe('the Containers library', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('IBC tote: a pallet base, forks can take it, it bears a load', { timeout: 60000 }, () => {
    const ibc = load('ibc-tote')
    const v = cargoView(createSdkPart(ibc, 'i', [0, 1, 0], 0))!
    expect(v.caps).toBe(CARGO_CAP_FORK_POCKETS | CARGO_CAP_HEAVY | CARGO_CAP_LOAD_BASE)
    const H = v.halfExtents[1] * 2
    // a second tote on top of the first: the base's blocks stand on the lower tank's top
    const parts: PartInstance[] = [createSdkPart(ibc, 'low', [0, H / 2 + 0.005, 0], 0), createSdkPart(ibc, 'high', [0, H * 1.5 + 0.02, 0], 0)]
    world = new SimWorld(J, { version: SCENE_VERSION, parts, packages: [ibc] }, { hz: 60 })
    for (let i = 0; i < 60 * 3; i++) world.step()
    expect(pos(world, 'low')[1]).toBeCloseTo(H / 2, 2)
    // measured: both rest 0.1 mm below their nominal height, the upper on the lower's tank top, not sinking into it
    expect(Math.abs(pos(world, 'high')[1] - H * 1.5)).toBeLessThan(0.01)
  })

  it('a nesting rig bin: one seated on another by the nesting rule stays seated, foot in the rim', { timeout: 60000 }, () => {
    const bin = load('nesting-bin', join(HERE, 'fixtures'))
    const v = cargoView(createSdkPart(bin, 'b', [0, 1, 0], 0))!
    expect(v.caps).toBe(CARGO_CAP_SEPARATE_CONTACTS)
    expect(v.nestDepth).toBeGreaterThan(0)
    const H = v.halfExtents[1] * 2
    const low = createSdkPart(bin, 'low', [0, H / 2, 0], 0)
    const seat = cargoSeatOn(createSdkPart(bin, 'high', [0, 1, 0], 0), low)!
    expect(seat[1]).toBeCloseTo(H * 1.5 - v.nestDepth!, 5)
    world = new SimWorld(J, { version: SCENE_VERSION, parts: [low, createSdkPart(bin, 'high', seat, 0)], packages: [bin] }, { hz: 60 })
    for (let i = 0; i < 60 * 3; i++) world.step()
    // measured: seated to within 0.05 mm, centred
    const high = pos(world, 'high')
    expect(Math.abs(high[1] - seat[1])).toBeLessThan(0.005)
    expect(Math.hypot(high[0], high[2])).toBeLessThan(0.005)
  })

  it('drum: stands on its end, and rolls on its side', { timeout: 60000 }, () => {
    const drum = load('drum')
    const v = cargoView(createSdkPart(drum, 'd', [0, 1, 0], 0))!
    const R = v.halfExtents[0]
    const H = v.halfExtents[1] * 2
    const parts: PartInstance[] = [createSdkPart(drum, 'up', [0, H / 2 + 0.005, 0], 0), { ...createSdkPart(drum, 'side', [3, R + 0.005, 0], 0), rotationX: Math.PI / 2 } as PartInstance]
    world = new SimWorld(J, { version: SCENE_VERSION, parts, packages: [drum] }, { hz: 60 })
    for (let i = 0; i < 30; i++) world.step()
    expect(pos(world, 'up')[1]).toBeCloseTo(H / 2, 2)
    expect(pos(world, 'side')[1]).toBeCloseTo(R, 2)
  })
})
