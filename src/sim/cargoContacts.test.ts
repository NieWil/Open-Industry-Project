/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { validateScene } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// What a test run's cargo snapshot says each body touches (cargoContacts.ts), in a real SimWorld: the part under it,
// the case stacked on it, the floor, and nothing for a case still in the air. The cases come to rest first, since
// a body at rest is the one Jolt's own contact record can forget (it keeps none for a sleeping body).

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', 'box', 'rig.json'), 'utf8')) as { id: string; name: string; geometry: PackageManifest['geometry'] }
const box = buildPackage({ id: rig.id, name: rig.name, geometry: rig.geometry }, readFileSync(join(repo, 'examples', 'parts', 'box', 'behavior.ts'), 'utf8'))
const deck = buildPackage(
  { id: 'acme.deck', name: 'Deck', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.1, 1.4] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 4, width: 1.4, top: 0.1 } } },
  'definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: 0 }) } })',
)

const at = (id: string, x: number, y: number): PartInstance => ({ id, type: 'part', packageId: 'oip.box', position: [x, y, 0], rotationY: 0, params: {} })

describe('cargo contacts', () => {
  it('names the part, the cargo and the floor each body rests on, and nothing for one in the air', () => {
    const res = validateScene({
      version: SCENE_VERSION,
      packages: [deck, box],
      parts: [{ id: 'deck', type: 'part', packageId: 'acme.deck', position: [0, 1, 0], rotationY: 0, params: {} }, at('low', 0, 1.3), at('high', 0, 1.9), at('ground', 6, 0.3), at('falling', -6, 120)],
    })
    if (!res.ok) throw new Error(res.errors.join('; '))
    const w = new SimWorld(Jolt, res.scene)
    w.setBehaviorInputTags({})
    for (let i = 0; i < 240; i++) w.step()
    const f = w.frame()
    const idOf = (part: string): number => f.ids[f.partIds.indexOf(part)]!
    const touching = w.cargoContacts()
    expect(touching.get(idOf('low'))).toEqual([`cargo ${idOf('high')}`, 'deck'])
    expect(touching.get(idOf('high'))).toEqual([`cargo ${idOf('low')}`])
    expect(touching.get(idOf('ground'))).toEqual(['floor'])
    expect(touching.get(idOf('falling'))).toEqual([])
    w.dispose()
  })
})
