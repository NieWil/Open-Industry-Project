import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { PACKAGE_FORMAT } from '../parts/partPackage'
import type { PartPackage } from '../parts/partPackage'
import {
  badControllerPrefix,
  controllersUsed,
  controllerSpelledAs,
  controllerTag,
  isControllerName,
  spelledAs,
  moveTagToController,
  partsForController,
  splitControllerTag,
  tagsForController,
} from './controllerTag'

const SENSOR: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.sensor',
  name: 't.sensor',
  params: { tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' }, label: { type: 'string', default: '' } },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}
const part = (id: string, params: Record<string, unknown>) => ({ id, type: 'part', packageId: 't.sensor', params })

afterEach(() => clearPackages())

describe('a tag that names its controller', () => {
  it('splits into the controller and the tag on it', () => {
    expect(splitControllerTag('Cell2::%IX0.0')).toEqual({ controller: 'Cell2', local: '%IX0.0' })
    expect(splitControllerTag('Cell2::MAIN.Eye')).toEqual({ controller: 'Cell2', local: 'MAIN.Eye' })
    expect(splitControllerTag('%IX0.0')).toEqual({ controller: null, local: '%IX0.0' })
  })

  it('leaves the spellings the links carry alone', () => {
    // a Logix module tag has single colons; none of these name a controller
    for (const tag of ['Local:1:I.Data.0', 'Program:MainProgram.Eye', 'DB10.DBW4', 'X1A', 'GVL.Run']) {
      expect(splitControllerTag(tag)).toEqual({ controller: null, local: tag })
      expect(badControllerPrefix(tag)).toBeNull()
    }
  })

  it('tells a prefix that is not a controller name from a tag of the default controller', () => {
    expect(splitControllerTag('1x::Eye').controller).toBeNull()
    expect(badControllerPrefix('1x::Eye')).toBe('1x')
    expect(badControllerPrefix('::Eye')).toBe('')
    expect(badControllerPrefix('Cell2::Eye')).toBeNull()
    expect(isControllerName('Cell_2')).toBe(true)
    expect(isControllerName('a'.repeat(33))).toBe(false)
  })

  it('moves a tag to another controller, or back to the main one', () => {
    expect(controllerTag('Cell2', '%IX0.0')).toBe('Cell2::%IX0.0')
    expect(controllerTag(null, '%IX0.0')).toBe('%IX0.0')
    expect(moveTagToController('Cell1::Eye', 'Cell2')).toBe('Cell2::Eye')
    expect(moveTagToController('Cell1::Eye', null)).toBe('Eye')
    expect(moveTagToController('Eye', 'Cell2')).toBe('Cell2::Eye')
    expect(moveTagToController('', 'Cell2')).toBe('')
  })

  it('writes a controller in the spelling it is known by, since IEC names ignore case', () => {
    expect(spelledAs('cell2', ['Packing', 'Cell2'])).toBe('Cell2')
    expect(spelledAs('Cell3', ['Cell2'])).toBe('Cell3')
    expect(controllerSpelledAs('CELL2::%IX0.0', ['Cell2'])).toBe('Cell2::%IX0.0')
    expect(controllerSpelledAs('%IX0.0', ['Cell2'])).toBe('%IX0.0')
  })
})

describe('the parts as one controller sees them', () => {
  it("keeps that controller's tags without the name, and empties the rest", () => {
    registerPackage(SENSOR)
    const parts = [part('a', { tag: '%IX0.0', label: 'Cell2::not a tag' }), part('b', { tag: 'Cell2::%IX0.0' }), part('c', { tag: 'Cell3::%IX0.0' })]
    expect(partsForController(parts, 'Cell2').map((p) => p.params.tag)).toEqual(['', '%IX0.0', ''])
    expect(partsForController(parts, null).map((p) => p.params.tag)).toEqual(['%IX0.0', '', ''])
    // only tag params are tags
    expect(partsForController(parts, 'Cell2')[0]!.params.label).toBe('Cell2::not a tag')
  })

  it('hands back a part untouched when it has nothing to change', () => {
    registerPackage(SENSOR)
    const parts = [part('a', { tag: '%IX0.0' }), part('b', { tag: '' })]
    const seen = partsForController(parts, null)
    expect(seen[0]).toBe(parts[0])
    expect(seen[1]).toBe(parts[1])
  })

  it('lists the controllers the tags name', () => {
    registerPackage(SENSOR)
    expect(controllersUsed([part('a', { tag: 'B::x' }), part('b', { tag: 'A::y' }), part('c', { tag: 'z' }), part('d', { tag: 'A::w' })])).toEqual(['A', 'B'])
  })

  it("reads a frame's tags for one controller", () => {
    expect(tagsForController({ '%IX0.0': true, 'Cell2::%IX0.0': false, 'Cell22::%IX0.0': true }, 'Cell2')).toEqual({ '%IX0.0': false })
  })

  it('keeps an empty tag empty on any controller, and reads past a space after the separator', () => {
    expect(controllerTag('Cell2', '')).toBe('')
    expect(controllerTag('Cell2', '  ')).toBe('  ')
    expect(splitControllerTag('Cell2:: %IX0.0')).toEqual({ controller: 'Cell2', local: '%IX0.0' })
  })
})
