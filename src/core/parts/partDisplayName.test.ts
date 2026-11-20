import { beforeEach, describe, expect, it } from 'vitest'
import { partDisplayName, partDisplayNames, partTypeName } from './partDisplayName'
import { clearPackages, registerPackage } from './partRegistry'
import type { PartPackage } from './partPackage'
import type { SdkPart, PartInstance } from '../types'
import { PACKAGE_FORMAT } from './partPackage'

const group = (id: string, name?: string): PartInstance =>
  ({ id, type: 'group', position: [0, 0, 0], rotationY: 0, params: {}, ...(name ? { name } : {}) }) as unknown as PartInstance

const custom = (id: string, packageId: string, name?: string): SdkPart =>
  ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: {}, ...(name ? { name } : {}) }) as SdkPart

const beltPkg: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'oip.belt',
  name: 'Belt Conveyor',
  params: {},
  behavior: 'definePart({ step(){} })',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } },
}

beforeEach(() => clearPackages())

describe('partTypeName', () => {
  it('uses PART_DEFS label for a built-in and the package name for a custom part', () => {
    registerPackage(beltPkg)
    expect(partTypeName(group('b1'))).toBe('Group')
    expect(partTypeName(custom('cp_1', 'oip.belt'))).toBe('Belt Conveyor')
  })

  it("falls back to 'Part' when a custom part's package isn't registered", () => {
    expect(partTypeName(custom('cp_1', 'ghost'))).toBe('Part')
  })
})

describe('partDisplayName', () => {
  it('prefers a non-blank user-given name over the type name', () => {
    const parts = [group('b1', 'Crate')]
    expect(partDisplayName(parts[0]!, parts)).toBe('Crate')
  })

  it('labels a lone unnamed part by its type, with no number', () => {
    registerPackage(beltPkg)
    const parts = [custom('cp_1', 'oip.belt')]
    expect(partDisplayName(parts[0]!, parts)).toBe('Belt Conveyor')
  })

  it('numbers unnamed same-type siblings in scene order (1 = no suffix)', () => {
    registerPackage(beltPkg)
    const a = custom('cp_1', 'oip.belt')
    const b = custom('cp_2', 'oip.belt')
    const c = custom('cp_3', 'oip.belt')
    const parts = [a, b, c]
    expect(partDisplayName(a, parts)).toBe('Belt Conveyor')
    expect(partDisplayName(b, parts)).toBe('Belt Conveyor 2')
    expect(partDisplayName(c, parts)).toBe('Belt Conveyor 3')
  })

  it('does not count named siblings toward the number - a renamed one frees the base label', () => {
    const named = group('b1', 'Infeed')
    const plain = group('b2')
    const parts = [named, plain]
    // only one unnamed Group remains, so it reads cleanly as "Group" (not "Group 2")
    expect(partDisplayName(plain, parts)).toBe('Group')
  })

  it('numbers each type independently', () => {
    registerPackage(beltPkg)
    const belt1 = custom('cp_1', 'oip.belt')
    const group1 = group('b1')
    const belt2 = custom('cp_2', 'oip.belt')
    const parts = [belt1, group1, belt2]
    expect(partDisplayName(belt1, parts)).toBe('Belt Conveyor')
    expect(partDisplayName(belt2, parts)).toBe('Belt Conveyor 2')
    expect(partDisplayName(group1, parts)).toBe('Group')
  })
})

describe('partDisplayNames', () => {
  it('labels every part exactly as partDisplayName does, in one pass', () => {
    registerPackage(beltPkg)
    const parts = [
      custom('cp_1', 'oip.belt'),
      group('b1', 'Infeed'),
      group('b2'),
      custom('cp_2', 'oip.belt', '  '), // a blank name reads as unnamed
      custom('cp_3', 'oip.belt', 'Takeaway'),
      group('b3'),
      custom('cp_4', 'ghost'),
      custom('cp_5', 'oip.belt'),
    ]
    const names = partDisplayNames(parts)
    expect(names.size).toBe(parts.length)
    for (const p of parts) expect(names.get(p.id)).toBe(partDisplayName(p, parts))
    expect(names.get('cp_5')).toBe('Belt Conveyor 3')
  })
})
