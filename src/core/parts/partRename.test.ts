import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from './partPackage'
import type { PartPackage } from './partPackage'
import { freePartId, newPartIdProblem, partsNaming, renamePartInScene } from './partRename'
import { SCENE_VERSION } from '../types'
import type { PartInstance, SceneJSON } from '../types'

const part = (id: string, over: Partial<PartPackage> = {}): PartPackage =>
  ({ format: PACKAGE_FORMAT, id, name: id, params: {}, behavior: '', geometry: { kind: 'rig', links: [], joints: [] }, ...over }) as PartPackage
const placed = (id: string, packageId: string): PartInstance =>
  ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: {} }) as PartInstance

describe('a new part id', () => {
  const taken = (id: string): boolean => ['acme.transfer', 'acme.transfer-2'].includes(id)

  it('must be usable as a folder name and not taken', () => {
    expect(newPartIdProblem('acme.transfer-3', taken)).toBe('')
    expect(newPartIdProblem('acme.transfer', taken)).toMatch(/already exists/)
    for (const bad of ['', '.hidden', 'a/b', 'has space', '..']) expect(newPartIdProblem(bad, taken)).not.toBe('')
  })

  it('is suggested next to the old one, counting past any taken', () => {
    expect(freePartId('acme.transfer', taken)).toBe('acme.transfer-3')
    expect(freePartId('acme.transfer-2', taken)).toBe('acme.transfer-3')
    expect(freePartId('user.cell', () => false)).toBe('user.cell-2')
  })
})

describe('renaming a part in a scene', () => {
  it('moves every placed copy and any copy the scene carries, and leaves the rest alone', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [placed('cp_1', 'acme.transfer'), placed('cp_2', 'user.other'), placed('cp_3', 'acme.transfer')],
      packages: [part('acme.transfer'), part('user.other')],
    }
    const next = renamePartInScene(scene, 'acme.transfer', 'acme.mine')
    expect(next.parts.map((p) => ('packageId' in p ? p.packageId : ''))).toEqual(['acme.mine', 'user.other', 'acme.mine'])
    expect(next.packages?.map((p) => p.id)).toEqual(['acme.mine', 'user.other'])
    expect(next.parts[1]).toBe(scene.parts[1])
  })

  it('returns the scene itself when nothing names the part', () => {
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [placed('cp_1', 'user.other')] }
    expect(renamePartInScene(scene, 'acme.transfer', 'acme.mine')).toBe(scene)
  })
})

describe('parts whose definitions name a part', () => {
  it('finds held cargo, and never the part itself', () => {
    const holder = part('acme.holder', { holds: { part: 'acme.box' } } as unknown as Partial<PartPackage>)
    expect(partsNaming([holder, part('acme.box')], 'acme.box').map((p) => p.id)).toEqual(['acme.holder'])
    expect(partsNaming([holder], 'acme.holder')).toEqual([])
  })
})
