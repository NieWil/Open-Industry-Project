import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../core/parts/partPackage'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { commsTags, type DeviceTags, devicesForTag, type TaggedPart, unhandledProgramTags } from './bindings'
import { LocalPlcLink } from './link/plcLink'

// The declarative binding table (PART_COMMS + InputBinding/OutputBinding) is gone with the built-in
// sensor/button/conveyor parts. What's left is the authoring-warning walk over the device-IO tag bridge:
// a comms-enabled custom part reads/writes program tags by name (ctx.readTag/writeTag), and these functions
// tell a UI which declared program tags no part handles (unbound) and which scene tags the program never
// declares (unwired).

const PROGRAM = `VAR_INPUT
  Start : BOOL;
  Stop  : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
Motor := (Start OR Motor) AND NOT Stop;`

describe('unhandledProgramTags (device-IO bridge authoring warnings)', () => {
  const link = new LocalPlcLink(PROGRAM)
  // the part's package, loaded: its `enableComms` param is the declared switch of its PLC link
  beforeAll(() =>
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'x',
      name: 'X',
      commsParam: 'enableComms',
      params: { enableComms: { type: 'boolean', default: false }, runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' } },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
    } as PartPackage),
  )
  afterAll(() => clearPackages())

  it('reports every program tag as unbound when no part wires it', () => {
    const parts: TaggedPart[] = [
      { id: 'bld1', type: 'building', params: {} },
      { id: 'g1', type: 'group', params: {} },
    ]
    const { unbound } = unhandledProgramTags(parts, link)
    expect(unbound).toEqual(expect.arrayContaining(['Start', 'Stop', 'Motor']))
  })

  it("treats a comms-enabled custom part's matching string param as handling that tag", () => {
    const parts: TaggedPart[] = [
      { id: 'cp1', type: 'part', packageId: 'x', params: { enableComms: true, runTag: 'Motor' } },
    ]
    const { unbound } = unhandledProgramTags(parts, link)
    expect(unbound).not.toContain('Motor') // wired over the bridge
    expect(unbound).toEqual(expect.arrayContaining(['Start', 'Stop'])) // still unwired
  })

  it('ignores a custom part with comms disabled', () => {
    const parts: TaggedPart[] = [
      { id: 'cp1', type: 'part', packageId: 'x', params: { enableComms: false, runTag: 'Motor' } },
    ]
    const { unbound } = unhandledProgramTags(parts, link)
    expect(unbound).toContain('Motor')
  })

  it('never treats a non-custom part as a tag source', () => {
    // a plain param that happens to equal a program tag on a non-custom part must not count as wiring
    const parts: TaggedPart[] = [{ id: 'b1', type: 'building', params: { name: 'Motor' } }]
    const { unbound } = unhandledProgramTags(parts, link)
    expect(unbound).toContain('Motor')
  })
})

describe('commsTags (ST-editor autocomplete over device-IO tag params)', () => {
  it('yields nothing when the custom part has no registered package to resolve its tag specs', () => {
    const parts: TaggedPart[] = [
      { id: 'cp1', type: 'part', packageId: 'not-registered', params: { enableComms: true, runTag: 'Motor' } },
    ]
    expect(commsTags(parts)).toEqual([])
  })

  it('yields nothing for non-custom parts', () => {
    expect(commsTags([{ id: 'b1', type: 'building', params: {} }])).toEqual([])
  })
})

describe('devicesForTag (Cross Reference: which part is wired to this tag)', () => {
  const belt = (id: string, run: string, enabled = true): DeviceTags => ({
    id,
    name: id,
    kind: 'Belt Conveyor',
    enabled,
    switchable: true,
    fields: [
      { key: 'runTag', label: 'Run tag', section: 'VAR_OUTPUT', type: 'BOOL', value: run },
      { key: 'jamTag', label: 'Jam tag', section: 'VAR_INPUT', type: 'BOOL', value: '' },
    ],
  })

  it('finds the field a device speaks the tag as, with the direction it speaks it in', () => {
    expect(devicesForTag([belt('Belt1', 'Motor')], 'Motor')).toEqual([
      { device: belt('Belt1', 'Motor'), field: 'Run tag', section: 'VAR_OUTPUT' },
    ])
  })

  it('matches the way the runtime binds: case-insensitively, ignoring surrounding space', () => {
    expect(devicesForTag([belt('Belt1', ' motor ')], 'MOTOR')).toHaveLength(1)
  })

  it('leaves out a part whose comms are off: its field still holds a name, but nothing binds it', () => {
    expect(devicesForTag([belt('Belt1', 'Motor', false)], 'Motor')).toEqual([])
  })

  it('lists every device wired to the same tag, not just the first', () => {
    const uses = devicesForTag([belt('Belt1', 'Motor'), belt('Belt2', 'Motor')], 'Motor')
    expect(uses.map((u) => u.device.name)).toEqual(['Belt1', 'Belt2'])
  })

  it('answers nothing for an unwired field, and for no tag at all', () => {
    expect(devicesForTag([belt('Belt1', 'Motor')], 'Jam')).toEqual([])
    expect(devicesForTag([belt('Belt1', '')], '')).toEqual([])
  })
})

// A part with modes names only the tags of the mode it is in: the others are not read, so they are no tags of the
// scene (the same rule the Inspector hides them by, core/packageParams visibleWhenHolds).
describe('a moded part names the tags of its mode only', () => {
  beforeAll(() =>
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'moded',
      name: 'Moded',
      commsParam: 'enableComms',
      params: {
        enableComms: { type: 'boolean', default: false },
        mode: { type: 'enum', default: 'waypoints', options: [{ value: 'waypoints', label: 'W' }, { value: 'position', label: 'P' }, { value: 'follow', label: 'F' }] },
        commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: '', visibleWhen: { param: 'mode', is: 'waypoints' } },
        targetTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '', visibleWhen: { param: 'mode', is: ['position', 'follow'] } },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
    } as PartPackage),
  )
  afterAll(() => clearPackages())
  const part = (mode?: string): TaggedPart => ({ id: 'g', type: 'part', packageId: 'moded', params: { enableComms: true, commandTag: 'Cmd', targetTag: 'Tgt', ...(mode ? { mode } : {}) } })

  it('waypoints (the default) names the command tag; position and follow name the target', () => {
    expect(commsTags([part()])).toEqual(['Cmd'])
    expect(commsTags([part('position')])).toEqual(['Tgt'])
    expect(commsTags([part('follow')])).toEqual(['Tgt'])
  })
})
