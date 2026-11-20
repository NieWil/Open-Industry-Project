import { describe, expect, it } from 'vitest'
import type { DeviceTags } from '../../plc/bindings'
import { devicesWiredTo, forcedDeviceIds, forceKeyOf } from './plcForces'

// The one reading of which variable a part's tag forces and which parts a force reaches (plcForces.ts), shared by the
// Watch dock, the toolbar, the Scene tree, the Devices list, a device's tags and the Inspector.

const device = (id: string, tag: string, enabled = true): DeviceTags => ({
  id,
  name: id,
  kind: 'Belt Conveyor',
  enabled,
  switchable: !enabled,
  fields: [{ key: 'runTag', label: 'Run tag', section: 'VAR_OUTPUT', type: 'BOOL', value: tag }],
})

describe('plcForces', () => {
  it("maps a part's tag to the variable a force holds, as the link binds it; an address, a STRING or an empty field forces nothing", () => {
    const watch = { 'Line.Run': true, Speed: 1, 'Motor.Go': false, Status: 5, Note: 'hi' }
    // a bare name binds only through the link's own alias (one program instance), never by a suffix guess
    expect(forceKeyOf('Run', watch, new Map([['Run', 'Line.Run']]))).toBe('Line.Run')
    expect(forceKeyOf('run', watch, new Map([['Run', 'Line.Run']]))).toBe('Line.Run')
    expect(forceKeyOf('Run', watch)).toBeNull()
    expect(forceKeyOf('Go', watch)).toBeNull() // a struct field that happens to end in the name is not what the part reads
    expect(forceKeyOf('speed', watch)).toBe('Speed')
    expect(forceKeyOf('Status.2', watch)).toBe('Status.2')
    expect(forceKeyOf('Note', watch)).toBeNull()
    expect(forceKeyOf('%QX0.0', watch)).toBeNull()
    expect(forceKeyOf('', watch)).toBeNull()
    expect(forceKeyOf('Run', null)).toBeNull()
  })

  it('marks the devices a force reaches, but not one whose comms switch is off', () => {
    const devices = [device('a', 'Go'), device('b', 'Go', false), device('c', 'Other')]
    expect([...forcedDeviceIds(devices, { Go: true }, (t) => (t === '' ? null : t))]).toEqual(['a'])
    expect(forcedDeviceIds(devices, {}, (t) => t).size).toBe(0)
  })

  it("finds the parts wired to a value by name, by key, by the link's alias for it, and for a bit, by its word", () => {
    const devices = [device('belt', 'Status'), device('lane', 'Run')]
    expect(devicesWiredTo(devices, 'Status.3', 'Status.3').map((u) => u.device.id)).toEqual(['belt'])
    expect(devicesWiredTo(devices, 'Line.Run', 'Line.Run', new Map([['Run', 'Line.Run']])).map((u) => u.device.id)).toEqual(['lane'])
    // without the alias (two instances, or a struct field) the bare-named part is not wired to it
    expect(devicesWiredTo(devices, 'Line.Run', 'Line.Run')).toEqual([])
    expect(devicesWiredTo(devices, 'Nothing', 'Nothing')).toEqual([])
  })
})
