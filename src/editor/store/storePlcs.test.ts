import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import { serializeScene, validateScene } from '../../core/scene/scene'
import { MAX_SCENE_PLCS } from '../../core/scene/scenePlcs'
import type { ScenePlc } from '../../core/scene/scenePlcs'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'
import { commitControllerAssignment } from '../program/assignController'
import { EditorStore } from './store'
import { plcSetupOf } from './storePlcs'
import { DEFAULT_EXTERNAL_PLC } from './storePrefs'
import type { ExternalPlcSettings } from './storePrefs'

const SENSOR: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.sensor',
  name: 't.sensor',
  params: { tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}
const sensor = (id: string, tag: string) => ({ id, type: 'part', packageId: 't.sensor', position: [0, 0, 0], rotationY: 0, params: { tag } }) as unknown as PartInstance
const tagOf = (store: EditorStore, id: string) => (store.getState().scene.parts.find((p) => p.id === id)!.params as { tag: string }).tag

afterEach(() => clearPackages())

describe("the scene's controllers with this computer's addresses", () => {
  const prefs = (over: Partial<ExternalPlcSettings>): ExternalPlcSettings => ({ ...DEFAULT_EXTERNAL_PLC, ...over })

  it("derives a scene without a list from this computer's settings and its own tags, as before scenes had one", () => {
    registerPackage(SENSOR)
    const named = { ...DEFAULT_EXTERNAL_PLC, name: 'Cell2', mode: 's7' as const, enabled: false, s7Host: '10.0.0.2' }
    const other = { ...named, name: 'Elsewhere' }
    // a controller this computer has set up for another project is not this one's
    const setup = plcSetupOf({ parts: [sensor('a', 'Cell2::Eye')] }, prefs({ enabled: true, mode: 'poll', controllers: [named, other] }))
    expect(setup).toMatchObject({ mainName: 'PLC1', saved: false, enabled: true, mode: 'poll' })
    expect(setup.controllers).toEqual([expect.objectContaining({ name: 'Cell2', mode: 's7', enabled: false, s7Host: '10.0.0.2' })])
  })

  it("takes what runs each controller from the scene and where it is from this computer, a free port for one it has not seen", () => {
    const plcs: ScenePlc[] = [
      { name: 'Line', runsOn: 'app', protocol: 'serve', connect: true },
      { name: 'Cell2', runsOn: 'plc', protocol: 'serve', connect: true },
      { name: 'Cell3', runsOn: 'plc', protocol: 'opcua', connect: false },
    ]
    const kept = { ...DEFAULT_EXTERNAL_PLC, name: 'Cell3', port: 5021, opcUaEndpoint: 'opc.tcp://10.0.0.3:4840' }
    const setup = plcSetupOf({ plcs, parts: [] }, prefs({ enabled: true, port: 5020, controllers: [kept] }))
    expect(setup).toMatchObject({ mainName: 'Line', saved: true, enabled: false })
    expect(setup.controllers.map((c) => [c.name, c.mode, c.enabled, c.port])).toEqual([
      ['Cell2', 'serve', true, 5022],
      ['Cell3', 'opcua', false, 5021],
    ])
    expect(setup.controllers[1]!.opcUaEndpoint).toBe('opc.tcp://10.0.0.3:4840')
  })
})

describe("each simulated controller's own OPC UA server", () => {
  it('is off until switched on, on a port no other server uses, and keeps what this computer sets', () => {
    const store = new EditorStore()
    store.addNamedPlc('Cell2')
    store.addNamedPlc('Cell3')
    const ports = () => store.getState().externalPlc.controllers.map((c) => [c.uaServer, c.uaServerPort])
    const main = store.getState().externalPlc.uaServerPort
    expect(ports()).toEqual([
      [false, main + 1],
      [false, main + 2],
    ])
    store.setNamedPlc('Cell3', { uaServer: true, uaServerPort: 4900 })
    expect(ports()[1]).toEqual([true, 4900])
    // where it listens is this computer's: an undo of the scene leaves it
    expect(store.getState().plcPrefs.controllers.find((c) => c.name === 'Cell3')).toMatchObject({ uaServer: true, uaServerPort: 4900 })
  })
})

describe('editing the controllers', () => {
  it('adds and removes a controller as edits, kept in the scene and undone like one', () => {
    const store = new EditorStore()
    expect(store.addNamedPlc('Cell2')).toBe(true)
    expect(store.getState().scene.plcs?.map((c) => c.name)).toEqual(['PLC1', 'Cell2'])
    expect(store.addNamedPlc('cell2')).toBe(false)
    store.setNamedPlc('Cell2', null)
    expect(store.getState().externalPlc.controllers).toEqual([])
    store.undo()
    expect(store.getState().externalPlc.controllers.map((c) => c.name)).toEqual(['Cell2'])
    store.undo()
    expect(store.getState().externalPlc.controllers).toEqual([])
  })

  it('refuses a name another controller has in any case, allows a change of case, and stops at the limit', () => {
    const store = new EditorStore()
    store.addNamedPlc('Cell2')
    expect(store.addNamedPlc('plc1')).toBe(false)
    expect(store.renameNamedPlc('Cell2', 'CELL2')).toBe(true)
    for (let i = 0; i < 40; i++) store.addNamedPlc(`C${i}`)
    expect(store.getState().scene.plcs?.length).toBe(MAX_SCENE_PLCS)
  })

  it("splits a link change: what runs it and its protocol are an edit, where it is this computer's", () => {
    const store = new EditorStore()
    store.setExternalPlc({ enabled: true, mode: 'poll', plcHost: '10.0.0.9' })
    expect(store.getState().scene.plcs?.[0]).toMatchObject({ runsOn: 'plc', protocol: 'poll' })
    expect(store.getState().plcPrefs.plcHost).toBe('10.0.0.9')
    store.undo()
    // the document goes back; the address is a preference and stays
    expect(store.getState().externalPlc).toMatchObject({ enabled: false, mode: 'serve', plcHost: '10.0.0.9' })
  })

  it('makes Watch only an edit of the project, saved with it and read back, and undone like one', () => {
    const store = new EditorStore()
    store.setExternalPlc({ enabled: true, mode: 'opcua' })
    store.setExternalPlc({ watch: true })
    expect(store.getState().scene.plcs?.[0]).toMatchObject({ runsOn: 'plc', protocol: 'opcua', watch: true })
    expect(store.getState().externalPlc.watch).toBe(true)
    expect(store.getState().plcPrefs.watch).toBeUndefined()
    const saved = validateScene(JSON.parse(serializeScene(store.getState().scene)))
    expect(saved.ok && saved.scene.plcs?.[0]?.watch).toBe(true)
    store.undo()
    expect(store.getState().scene.plcs?.[0]).not.toHaveProperty('watch')
    expect(store.getState().externalPlc.watch).toBe(false)
  })

  it('renames a controller and every tag on it as one undo step, keeping its address under both names', () => {
    registerPackage(SENSOR)
    const store = new EditorStore()
    store.commit('parts', { version: SCENE_VERSION, parts: [sensor('a', 'Cell2::%IX0.0'), sensor('b', '%IX0.1')] } as SceneJSON)
    store.addNamedPlc('Cell2')
    store.setNamedPlc('Cell2', { plcHost: '10.0.0.2', mode: 'poll' })
    expect(store.renameNamedPlc('Cell2', 'Packing')).toBe(true)
    expect([tagOf(store, 'a'), tagOf(store, 'b')]).toEqual(['Packing::%IX0.0', '%IX0.1'])
    expect(store.getState().externalPlc.controllers[0]).toMatchObject({ name: 'Packing', mode: 'poll', plcHost: '10.0.0.2' })
    store.undo()
    expect(tagOf(store, 'a')).toBe('Cell2::%IX0.0')
    expect(store.getState().externalPlc.controllers[0]).toMatchObject({ name: 'Cell2', plcHost: '10.0.0.2' })
    // the default controller's tags carry no name, so its rename moves none
    expect(store.renameNamedPlc('PLC1', 'Line')).toBe(true)
    expect([store.getState().externalPlc.mainName, tagOf(store, 'b')]).toEqual(['Line', '%IX0.1'])
    expect(store.renameNamedPlc('Line', 'cell2')).toBe(false)
  })

  it("takes the controller's tasks and instances with it, in the same undo step", () => {
    registerPackage(SENSOR)
    const store = new EditorStore()
    store.commit('parts', { version: SCENE_VERSION, parts: [sensor('a', 'Cell2::%IX0.0')] } as SceneJSON)
    store.addNamedPlc('Cell2')
    store.commitProgram('table', {
      source: 'PROGRAM Line\nVAR\n  x : BOOL;\nEND_VAR\nEND_PROGRAM\n',
      controller: {
        tasks: [{ name: 'T1', intervalMs: 10, priority: 1 }, { name: 'T2', intervalMs: 10, priority: 1, plc: 'cell2' }],
        programs: [{ name: 'LineA', type: 'Line', task: 'T1' }, { name: 'LineB', type: 'Line', task: 'T2' }, { name: 'LineC', type: 'Line', plc: 'Cell2' }],
      },
    })
    expect(store.renameNamedPlc('Cell2', 'Packing')).toBe(true)
    const table = store.getState().controller!
    expect(table.tasks.map((t) => t.plc)).toEqual([undefined, 'Packing'])
    expect(table.programs.map((p) => p.plc)).toEqual([undefined, undefined, 'Packing'])
    expect(tagOf(store, 'a')).toBe('Packing::%IX0.0')
    store.undo()
    expect(store.getState().controller!.tasks[1]!.plc).toBe('cell2')
    expect(store.getState().externalPlc.controllers[0]!.name).toBe('Cell2')
  })

  it('assigns parts to a controller the scene does not list, adding it in the same undo step', () => {
    registerPackage(SENSOR)
    const store = new EditorStore()
    store.commit('parts', { version: SCENE_VERSION, parts: [sensor('a', '%IX0.0')] } as SceneJSON)
    commitControllerAssignment(store, ['a'], 'Cell9', 'Assign to Cell9')
    expect(tagOf(store, 'a')).toBe('Cell9::%IX0.0')
    expect(store.getState().externalPlc.controllers.map((c) => c.name)).toEqual(['Cell9'])
    store.undo()
    expect(tagOf(store, 'a')).toBe('%IX0.0')
    expect(store.getState().externalPlc.controllers).toEqual([])
  })
})

describe('a scene file keeps its controllers', () => {
  it('saves and reads them back, and repairs what it cannot read', () => {
    const plcs: ScenePlc[] = [
      { name: 'Line', runsOn: 'app', protocol: 'serve', connect: true },
      { name: 'Cell2', runsOn: 'plc', protocol: 's7', connect: false },
    ]
    const back = validateScene(JSON.parse(serializeScene({ version: SCENE_VERSION, parts: [], plcs })))
    expect(back.ok && back.scene.plcs).toEqual(plcs)
    const bad = validateScene({ version: SCENE_VERSION, parts: [], plcs: [{ name: 'A', runsOn: 'plc', protocol: 'serve' }, { name: 'B', runsOn: 'app', protocol: 'x' }, { name: 'a' }, { name: '9x' }] })
    expect(bad.ok && bad.scene.plcs).toEqual([
      { name: 'A', runsOn: 'plc', protocol: 'serve', connect: true },
      { name: 'B', runsOn: 'app', protocol: 'serve', connect: true },
    ])
    expect(bad.ok && bad.repairs?.length).toBe(3)
  })
})
