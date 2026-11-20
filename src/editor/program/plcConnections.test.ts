import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { PlcSetup } from '../store/storePlcs'
import { connectableControllers, connectionMachines, connectionsOf, programVariableGroups, withConnection } from './plcConnections'

const DIVERTER: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.diverter',
  name: 'Diverter',
  params: {
    tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Extend tag' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag' },
  },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}
const diverter = (id: string, params: Record<string, unknown>) => ({ id, name: id, type: 'part', packageId: 't.diverter', position: [0, 0, 0], rotationY: 0, params }) as unknown as PartInstance
const scene = (...parts: PartInstance[]) => ({ version: 1, parts }) as unknown as SceneJSON

afterEach(() => clearPackages())

describe('the PLC connections window', () => {
  it('shows each field with its direction and what it is wired to on this controller', () => {
    registerPackage(DIVERTER)
    const s = scene(diverter('D1', { tag: 'MAIN.Extend', doneTag: 'Cell2::MAIN.Done' }))
    const [m] = connectionMachines(s.parts, null)
    expect(m!.fields).toEqual([
      { key: 'tag', label: 'Extend tag', dir: 'fromPlc', type: 'BOOL', variable: 'MAIN.Extend', elsewhere: undefined },
      { key: 'doneTag', label: 'Done tag', dir: 'toPlc', type: 'BOOL', variable: '', elsewhere: 'Cell2' },
    ])
    // the named controller sees the other one
    expect(connectionMachines(s.parts, 'Cell2')[0]!.fields.map((f) => [f.variable, f.elsewhere])).toEqual([
      ['', null],
      ['MAIN.Done', undefined],
    ])
  })

  it('counts a tag as a controller tag only in its exact spelling, as a run hands it over', () => {
    registerPackage(DIVERTER)
    const s = scene(diverter('D1', { tag: 'cell2::MAIN.Extend', doneTag: '' }))
    const [field] = connectionMachines(s.parts, 'Cell2')[0]!.fields
    expect([field!.variable, field!.elsewhere]).toEqual(['', 'cell2'])
    expect(connectionsOf(connectionMachines(s.parts, 'Cell2'))).toEqual([])
  })

  it('lists no connection on a part whose comms are off, since Play binds none of its fields', () => {
    registerPackage({ ...DIVERTER, id: 't.switched', params: { ...DIVERTER.params, comms: { type: 'boolean', default: true } }, commsParam: 'comms' })
    const part = (on: boolean) => ({ ...diverter('S1', { tag: 'MAIN.Extend', doneTag: '', comms: on }), packageId: 't.switched' }) as unknown as PartInstance
    const off = connectionMachines(scene(part(false)).parts, null)
    expect(off[0]!.enabled).toBe(false)
    expect(connectionsOf(off)).toEqual([])
    expect(connectionsOf(connectionMachines(scene(part(true)).parts, null))).toHaveLength(1)
  })

  it('lists the connections of one controller', () => {
    registerPackage(DIVERTER)
    const s = scene(diverter('D1', { tag: 'MAIN.Extend', doneTag: '' }), diverter('D2', { tag: '', doneTag: 'MAIN.Done' }))
    expect(connectionsOf(connectionMachines(s.parts, null)).map((c) => `${c.machine} ${c.field} ${c.dir} ${c.variable}`)).toEqual([
      'D1 Extend tag fromPlc MAIN.Extend',
      'D2 Done tag toPlc MAIN.Done',
    ])
  })

  it('connects a field as its tag, with a named controller in front, and disconnects it again', () => {
    registerPackage(DIVERTER)
    const s = scene(diverter('D1', { tag: '', doneTag: '' }))
    const on = withConnection(s, 'D1', 'tag', 'Cell2', 'MAIN.Extend')!
    expect(on.parts[0]!.params).toEqual({ tag: 'Cell2::MAIN.Extend', doneTag: '' })
    expect(withConnection(on, 'D1', 'tag', 'Cell2', '')!.parts[0]!.params).toEqual({ tag: '', doneTag: '' })
    expect(withConnection(s, 'nope', 'tag', null, 'MAIN.Extend')).toBeNull()
  })

  it('offers the simulated program and every PLC that lists its variables', () => {
    const setup = {
      enabled: true,
      mode: 'ads',
      mainName: 'PLC1',
      adsNetId: '5.170.233.29.1.1',
      adsPort: 851,
      controllers: [
        { name: 'Cell2', runsOn: 'plc', mode: 'ads', adsNetId: '', adsPort: 852 },
        { name: 'Cell3', runsOn: 'app', mode: 'ads', adsNetId: '', adsPort: 851 },
        { name: 'Cell4', runsOn: 'plc', mode: 'eip', eipGateway: '10.0.0.9', eipPath: '1,0', eipFamily: 'logix' },
        { name: 'Cell5', runsOn: 'plc', mode: 'opcua', opcUaEndpoint: 'opc.tcp://plc:4840', opcUaBrowseFrom: [] },
        { name: 'Cell6', runsOn: 'plc', mode: 's7' },
        { name: 'Cell7', runsOn: 'plc', mode: 'eip', eipGateway: '10.0.0.10', eipPath: '1,0', eipFamily: 'micro800' },
      ],
    } as unknown as PlcSetup
    expect(connectableControllers(setup)).toEqual([
      { name: null, label: 'PLC1', source: { kind: 'ads', netId: '5.170.233.29.1.1', port: 851 } },
      { name: 'Cell2', label: 'Cell2', source: { kind: 'ads', netId: '', port: 852 } },
      { name: 'Cell4', label: 'Cell4', source: { kind: 'eip', gateway: '10.0.0.9', path: '1,0', family: 'logix' } },
      { name: 'Cell5', label: 'Cell5', source: { kind: 'opcua', endpoint: 'opc.tcp://plc:4840', from: [] } },
      // a Micro800 takes no path, so one kept from a Logix setup is not sent
      { name: 'Cell7', label: 'Cell7', source: { kind: 'eip', gateway: '10.0.0.10', path: '', family: 'micro800' } },
    ])
    // the default controller run by the simulator lists the program's variables; one on a Modbus PLC lists none
    expect(connectableControllers({ ...setup, enabled: false, controllers: [] })).toEqual([{ name: null, label: 'PLC1', source: { kind: 'program' } }])
    expect(connectableControllers({ ...setup, mode: 'serve', controllers: [] })).toEqual([])
  })

  it("lists the program's bits and numbers by instance, with which way the program uses each", () => {
    const groups = programVariableGroups([
      { name: 'Run', type: 'BOOL', dir: 'out' },
      { name: 'Main.Eye', type: 'BOOL', dir: 'in' },
      { name: 'Main.Count', type: 'DINT' },
      { name: 'Main.Label', type: 'STRING' },
      { name: 'Main.T1', type: 'TON' },
    ])
    expect(groups).toEqual([
      { name: '', variables: [{ name: 'Run', short: 'Run', typeName: 'BOOL', kind: 'bool', dir: 'out' }] },
      {
        name: 'Main',
        variables: [
          { name: 'Main.Count', short: 'Count', typeName: 'DINT', kind: 'number' },
          { name: 'Main.Eye', short: 'Eye', typeName: 'BOOL', kind: 'bool', dir: 'in' },
        ],
      },
    ])
  })
})
