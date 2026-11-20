import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorStore } from './store/store'
import { importSceneText, isSceneFileText, sceneFileText, sceneNameFromFile } from './project/sceneFile'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance } from '../core/types'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PartPackage } from '../core/parts/partPackage'
import { validateProject } from '../core/project/project'
import type { ProjectJSON } from '../core/project/project'

// Import Project, handed a scene file, opens it as a new project (a project holds one scene since format 4), filed beside
// the open one, which is kept. Creating a project reloads into it, so newProject's two hooks are stubbed: whether a
// project can be created here, and the project handed over to be filed.
const creatable = vi.fn(() => true)
const created: ProjectJSON[] = []
vi.mock('./project/newProject', () => ({
  canCreateProject: () => creatable(),
  createProjectFrom: (_store: unknown, project: ProjectJSON) => {
    created.push(project)
    return Promise.resolve(null)
  },
}))

const SENSOR: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.sensor',
  name: 't.sensor',
  params: {},
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}

function box(id: string, x: number): PartInstance {
  return { id, type: 'group', position: [x, 0.2, 0], rotationY: 0, params: {} } as PartInstance
}

const ids = (store: EditorStore) => store.getState().scene.parts.map((p) => p.id)

/** a store showing box `a` and a program of its own */
function lineA(): EditorStore {
  const store = new EditorStore()
  store.loadScene({ version: SCENE_VERSION, parts: [box('a', 1)] })
  store.loadStProgram('VAR a : BOOL; END_VAR')
  return store
}

/** the open project, untouched by an open that files a new one */
function expectUntouched(store: EditorStore): void {
  expect(ids(store)).toEqual(['a'])
  expect(store.getState().stProgram).toBe('VAR a : BOOL; END_VAR')
}

describe('telling a scene file from a project (Import Project takes both)', () => {
  it('a scene file holds its parts at the top', () => {
    expect(isSceneFileText(JSON.stringify({ version: SCENE_VERSION, parts: [] }))).toBe(true)
    // a broken one is still a scene file, so it hears what is wrong with it as a scene
    expect(isSceneFileText(JSON.stringify({ version: SCENE_VERSION, parts: [{ nonsense: true }] }))).toBe(true)
  })
  it('a project holds a scene, or before format 4 lists scenes; a zip is an .oip', () => {
    expect(isSceneFileText(JSON.stringify({ version: 4, name: 'P', scene: { version: SCENE_VERSION, parts: [] } }))).toBe(false)
    expect(isSceneFileText(JSON.stringify({ version: 3, name: 'P', scenes: [] }))).toBe(false)
    expect(isSceneFileText('PK' + String.fromCharCode(3, 4) + 'rest')).toBe(false)
    expect(isSceneFileText('not json')).toBe(false)
  })
})

describe('Import Project with a scene file', () => {
  beforeEach(() => {
    creatable.mockReturnValue(true)
    created.length = 0
  })
  afterEach(() => vi.restoreAllMocks())

  it('files the scene as a new project named after the file, carrying its program and step rate, and leaves the open one as it was', async () => {
    const store = lineA()
    const leave = vi.fn()
    const file = JSON.stringify({ version: SCENE_VERSION, parts: [box('b', 2)], stProgram: 'VAR b : BOOL; END_VAR', stScanMs: 20, simHz: 120 })
    expect(await importSceneText(store, file, 'Infeed.json', { leaveForSceneSwap: leave } as never)).toBeNull()
    expect(leave).toHaveBeenCalledOnce()
    expect(created).toHaveLength(1)
    const p = created[0]!
    expect(p.name).toBe('Infeed')
    expect(p.scene.parts.map((x) => x.id)).toEqual(['b'])
    expect(p.stProgram).toBe('VAR b : BOOL; END_VAR')
    expect(p.stScanMs).toBe(20)
    expect(p.simHz).toBe(120)
    expectUntouched(store)
  })

  it('a file with no program is a project with no program, not a copy of the open one', async () => {
    const store = lineA()
    expect(await importSceneText(store, JSON.stringify({ version: SCENE_VERSION, parts: [box('c', 3)] }), 'layout.json')).toBeNull()
    expect(created[0]!.scene.parts.map((x) => x.id)).toEqual(['c'])
    expect(created[0]!.stProgram).toBeUndefined()
    expectUntouched(store)
  })

  it('refuses a project and a broken file without filing anything', async () => {
    const store = lineA()
    const project = { version: 3, name: 'P', activeScene: 0, scenes: [{ id: 'main', name: 'Main', scene: 'scenes/main.scene.json' }] }
    expect(await importSceneText(store, JSON.stringify(project), 'project.json')).toContain('Import Project')
    const v4 = { version: 4, name: 'P', scene: { version: SCENE_VERSION, parts: [] } }
    expect(await importSceneText(store, JSON.stringify(v4), 'project.json')).toContain('Import Project')
    expect(await importSceneText(store, 'not json', 'x.json')).toBe('File is not valid JSON')
    expect(created).toHaveLength(0)
    expectUntouched(store)
  })

  it('refuses where no second project can be kept, rather than replacing the open one', async () => {
    creatable.mockReturnValue(false)
    const store = lineA()
    const leave = vi.fn()
    const msg = await importSceneText(store, JSON.stringify({ version: SCENE_VERSION, parts: [box('b', 2)] }), 'b.json', { leaveForSceneSwap: leave } as never)
    expect(msg).toMatch(/project of its own/)
    expect(leave).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
    expectUntouched(store)
  })

  it('keeps a custom part the file carries in the new project', async () => {
    const store = lineA()
    const file = JSON.stringify({ version: SCENE_VERSION, parts: [{ id: 's', type: 'part', packageId: 't.sensor', position: [0, 0, 0], rotationY: 0, params: {} }], packages: [SENSOR] })
    expect(await importSceneText(store, file, 'cell.json')).toBeNull()
    const p = created[0]!
    expect([...(p.packages ?? []), ...(p.scene.packages ?? [])].map((x) => x.id)).toEqual(['t.sensor'])
    expect(validateProject(JSON.parse(JSON.stringify(p))).ok).toBe(true)
  })

  it('names the project after the file', () => {
    expect(sceneNameFromFile('Infeed.json')).toBe('Infeed')
    expect(sceneNameFromFile('C:\\lines\\main.scene.json')).toBe('main')
    expect(sceneNameFromFile('.json')).toBe('Imported project')
  })
})

// A scene file is the scene, not the project's parts: only
// the definitions its parts place go in the file, whatever the live scene happens to still hold.
describe('a scene file carries only the custom parts its scene places', () => {
  it('leaves out a definition no part places', () => {
    const unused: PartPackage = { ...SENSOR, id: 't.unused', name: 't.unused' }
    const placed = { id: 's1', type: 'part', packageId: SENSOR.id, position: [0, 0.2, 0], rotationY: 0, params: {} } as unknown as PartInstance
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [placed], packages: [SENSOR, unused] })
    const written = JSON.parse(sceneFileText(store.getState())) as { packages?: { id: string }[] }
    expect(written.packages?.map((p) => p.id)).toEqual([SENSOR.id])
  })

  it('carries what its parts use even when the live scene holds no copy, products included', () => {
    const crate: PartPackage = { ...SENSOR, id: 't.crate', name: 't.crate' }
    const spawner = { ...SENSOR, id: 't.spawner', name: 't.spawner', params: { product: { type: 'string', default: crate.id, product: true } } } as unknown as PartPackage
    const placed = { id: 'sp1', type: 'part', packageId: spawner.id, position: [0, 0.2, 0], rotationY: 0, params: {} } as unknown as PartInstance
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [], packages: [spawner, crate] }) // registers both
    store.loadScene({ version: SCENE_VERSION, parts: [placed] }) // a scene that names the spawner, with no copies
    const written = JSON.parse(sceneFileText(store.getState())) as { packages?: { id: string }[] }
    expect(written.packages?.map((p) => p.id)).toEqual([spawner.id, crate.id])
  })
})
