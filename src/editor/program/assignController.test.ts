import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance, SceneJSON } from '../../core/types'
import { renameControllerInScene } from '../store/storePlcs'
import { assignToController, hasTags, tagControllers } from './assignController'

const BELT: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.belt',
  name: 't.belt',
  params: {
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
    eyeTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' },
    note: { type: 'string', default: '' },
  },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}
const belt = (id: string, params: Record<string, unknown>) => ({ id, type: 'part', packageId: 't.belt', position: [0, 0, 0], rotationY: 0, params }) as unknown as PartInstance
const scene = (...parts: PartInstance[]) => ({ version: 1, parts }) as unknown as SceneJSON
const tagsOf = (s: SceneJSON | null, id: string) => (s?.parts.find((p) => p.id === id)?.params as Record<string, unknown>)

afterEach(() => clearPackages())

describe('Assign to Controller', () => {
  it("rewrites the controller's name on every tag of the chosen parts, and nothing else", () => {
    registerPackage(BELT)
    const s = scene(belt('a', { runTag: '%QX0.0', eyeTag: 'Cell1::%IX0.0', note: 'Cell1::x' }), belt('b', { runTag: '%QX0.1', eyeTag: '' }))
    const r = assignToController(s, ['a'], 'Cell2')
    expect(r).toMatchObject({ tags: 2, parts: 1 })
    expect(tagsOf(r.scene, 'a')).toEqual({ runTag: 'Cell2::%QX0.0', eyeTag: 'Cell2::%IX0.0', note: 'Cell1::x' })
    expect(tagsOf(r.scene, 'b')).toEqual({ runTag: '%QX0.1', eyeTag: '' })
  })

  it('takes the name off to put the tags back on the default controller', () => {
    registerPackage(BELT)
    const r = assignToController(scene(belt('a', { runTag: 'Cell2::Run', eyeTag: 'Cell2::Eye' })), ['a'], null)
    expect(tagsOf(r.scene, 'a')).toEqual({ runTag: 'Run', eyeTag: 'Eye' })
  })

  it('changes nothing when the tags are there already, or there are none', () => {
    registerPackage(BELT)
    const s = scene(belt('a', { runTag: 'Cell2::Run', eyeTag: '' }), belt('b', { runTag: '', eyeTag: '' }))
    expect(assignToController(s, ['a', 'b'], 'Cell2')).toEqual({ scene: null, tags: 0, parts: 0 })
    expect(hasTags(s, ['b'])).toBe(false)
    expect(hasTags(s, ['a', 'b'])).toBe(true)
  })
})

describe("the parts' controllers", () => {
  it('lists each controller the tags are on once, the default one as null, and skips empty tags', () => {
    registerPackage(BELT)
    expect(tagControllers([belt('a', { runTag: 'Cell2::Run', eyeTag: '' })])).toEqual(['Cell2'])
    expect(tagControllers([belt('a', { runTag: 'Cell2::Run', eyeTag: 'Eye' }), belt('b', { runTag: 'Cell2::X' })])).toEqual(['Cell2', null])
    expect(tagControllers([belt('a', { runTag: '', eyeTag: '' })])).toEqual([])
  })
})

describe('renaming a controller', () => {
  it('moves every tag on it to the new name, and leaves every other tag alone', () => {
    registerPackage(BELT)
    const s = scene(belt('a', { runTag: 'Cell2::Run', eyeTag: 'Cell3::Eye' }), belt('b', { runTag: 'Run', eyeTag: 'Cell2::%IX0.0' }))
    const r = renameControllerInScene(s, 'Cell2', 'Packing')
    expect(r).toMatchObject({ tags: 2, parts: 2 })
    expect(tagsOf(r.scene, 'a')).toEqual({ runTag: 'Packing::Run', eyeTag: 'Cell3::Eye' })
    expect(tagsOf(r.scene, 'b')).toEqual({ runTag: 'Run', eyeTag: 'Packing::%IX0.0' })
    expect(renameControllerInScene(s, 'Nobody', 'X')).toEqual({ scene: null, tags: 0, parts: 0 })
  })

  it('moves a tag that spells the old name in another case too', () => {
    registerPackage(BELT)
    const s = scene(belt('a', { runTag: 'cell2::Run', eyeTag: 'Cell2::Eye' }))
    expect(tagsOf(renameControllerInScene(s, 'Cell2', 'Packing').scene, 'a')).toEqual({ runTag: 'Packing::Run', eyeTag: 'Packing::Eye' })
  })
})
