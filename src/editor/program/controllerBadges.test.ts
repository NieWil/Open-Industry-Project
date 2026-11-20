import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import { controllerBadges } from './controllerBadges'

const BELT: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.belt',
  name: 't.belt',
  params: { runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' }, eyeTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}
const belt = (id: string, params: Record<string, unknown>, parent?: string) =>
  ({ id, type: 'part', packageId: 't.belt', position: [0, 0, 0], rotationY: 0, params, ...(parent ? { parent } : {}) }) as unknown as PartInstance
const group = (id: string, parent?: string) => ({ id, type: 'group', position: [0, 0, 0], rotationY: 0, ...(parent ? { parent } : {}) }) as unknown as PartInstance

afterEach(() => clearPackages())

describe('Scene tree controller badges', () => {
  it('names nothing on the default controller', () => {
    registerPackage(BELT)
    expect(controllerBadges([belt('a', { runTag: 'Run' }), belt('b', { runTag: '%QX0.0' })])).toEqual(new Map())
  })

  it("names a group once when every tagged part inside is on one controller, and a part that differs from its group", () => {
    registerPackage(BELT)
    const parts = [
      group('cell'),
      belt('a', { runTag: 'Cell2::Run' }, 'cell'),
      belt('b', { runTag: 'Cell2::%QX0.1', eyeTag: '' }, 'cell'),
      belt('c', { runTag: '' }, 'cell'),
      group('cell3'),
      belt('d', { runTag: 'Cell3::Run' }, 'cell3'),
      belt('e', { runTag: 'Cell2::Run' }, 'cell3'),
    ]
    expect(controllerBadges(parts)).toEqual(
      new Map([
        ['cell', 'Cell2'],
        ['d', 'Cell3'],
        ['e', 'Cell2'],
      ]),
    )
  })

  it('always names a part whose own tags are on two controllers', () => {
    registerPackage(BELT)
    expect(controllerBadges([belt('a', { runTag: 'Cell2::Run', eyeTag: 'Eye' })])).toEqual(new Map([['a', 'Cell2']]))
    expect(controllerBadges([belt('a', { runTag: 'Cell2::Run', eyeTag: 'Cell3::Eye' })])).toEqual(new Map([['a', 'Cell2 · Cell3']]))
  })

  it('names every part on a named controller in the flat, filtered view', () => {
    registerPackage(BELT)
    const parts = [group('cell'), belt('a', { runTag: 'Cell2::Run' }, 'cell'), belt('b', { runTag: 'Run' }, 'cell')]
    expect(controllerBadges(parts, true)).toEqual(new Map([['a', 'Cell2']]))
  })
})
