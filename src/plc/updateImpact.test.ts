import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { partChanges } from '../core/parts/partChanges'
import { PACKAGE_FORMAT, type PartPackage } from '../core/parts/partPackage'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { TaggedPart } from './bindings'
import { impactText, updateImpact } from './updateImpact'

// the project's copy: a belt with a run input and a jam output
const belt: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'test.belt',
  name: 'Belt',
  params: {
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Run tag' },
    jamTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Jam tag' },
  },
  behavior: 'definePart({ step(){} })',
  geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
} as PartPackage

// another device, wired to the same tag as the belt's jam output
const light: PartPackage = {
  ...belt,
  id: 'test.light',
  name: 'Light',
  params: { onTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'On tag' } },
} as PartPackage

// the app's newer version dropped both signals
const newer: PartPackage = { ...belt, params: {} }

const PROGRAM = `PROGRAM Main
VAR_INPUT
  Belt1_Jam : BOOL;
END_VAR
VAR_OUTPUT
  Belt1_Run : BOOL;
END_VAR
Belt1_Run := NOT Belt1_Jam;
END_PROGRAM`

describe('updateImpact (what a part update breaks in this project)', () => {
  beforeAll(() => {
    registerPackage(belt)
    registerPackage(light)
  })
  afterAll(() => clearPackages())

  const changes = partChanges(belt, newer)

  it('names the placed copy, its tag and where the program uses it', () => {
    const parts: TaggedPart[] = [{ id: 'b1', name: 'Belt 1', type: 'part', packageId: 'test.belt', params: { runTag: 'Belt1_Run', jamTag: '' } }]
    const impact = updateImpact('test.belt', changes, parts, PROGRAM)
    const run = impact.get('runTag')!
    expect(run).toHaveLength(1)
    expect(run[0]).toMatchObject({ partId: 'b1', partName: 'Belt 1', tag: 'Belt1_Run', devices: [] })
    expect(run[0]!.program.map((r) => (r.kind === 'text' ? r.line : -1))).toEqual([6, 8])
    expect(impactText(run)).toBe('Wired to Belt1_Run: the program uses it (line 6, line 8).')
    // an unwired field is not a use
    expect(impact.get('jamTag')).toEqual([])
    expect(impactText(impact.get('jamTag'))).toBe('Not wired on any placed copy in this project.')
  })

  it('names the other devices on the same tag, case-insensitively as the runtime binds it', () => {
    const parts: TaggedPart[] = [
      { id: 'b1', name: 'Belt 1', type: 'part', packageId: 'test.belt', params: { runTag: '', jamTag: 'Spare_Jam' } },
      { id: 'l1', name: 'Jam light', type: 'part', packageId: 'test.light', params: { onTag: 'SPARE_JAM' } },
    ]
    const jam = updateImpact('test.belt', changes, parts, '').get('jamTag')!
    expect(jam[0]!.devices).toEqual(['Jam light (On tag)'])
    expect(impactText(jam)).toBe('Wired to Spare_Jam: also wired to Jam light (On tag).')
  })

  it('a wired tag nothing else uses says so', () => {
    const parts: TaggedPart[] = [{ id: 'b1', name: 'Belt 1', type: 'part', packageId: 'test.belt', params: { runTag: 'Lonely', jamTag: '' } }]
    expect(impactText(updateImpact('test.belt', changes, parts, PROGRAM).get('runTag'))).toBe('Wired to Lonely, which nothing else in this project uses.')
  })

  it('looks only at breaking signal changes', () => {
    const renamed = { ...belt, name: 'Belt 2' }
    expect(updateImpact('test.belt', partChanges(belt, renamed), [], PROGRAM).size).toBe(0)
  })
})
