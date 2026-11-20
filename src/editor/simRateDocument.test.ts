// The physics step rate is a setting of the machine (EditorState.simHz, core/project/project.ts ProjectMachine.simHz), set in
// the Inspector with nothing selected and kept wherever the scene is kept.
//
// These pin the seams a user goes through, each of which could quietly change or drop the rate and leave a
// scene stepping at a different speed from the one it was saved at - which is not an error anyone sees,
// just a line whose timing no longer matches its tests: the project autosave, a project load, a scene file, New, a collab room, a view-only link, and the demo preview.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorStore } from './store/store'
import { loadSceneText, newSimulation, sceneFileText } from './project/sceneFile'
import { assembleProject, PROJECT_KEY } from './project/projectFile'
import { validateProject } from '../core/project/project'
import type { ProjectJSON } from '../core/project/project'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON } from '../core/types'

/** in-memory Storage (the Node test env has no localStorage) */
function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

function scene(): SceneJSON {
  const part: PartInstance = { id: 'g1', type: 'group', position: [1, 0, 0], rotationY: 0, params: {} } as PartInstance
  return { version: SCENE_VERSION, parts: [part] }
}

/** the project autosave as the next boot would read it */
function storedProject(): ProjectJSON {
  const raw = localStorage.getItem(PROJECT_KEY)
  if (raw === null) throw new Error('nothing was autosaved')
  const result = validateProject(JSON.parse(raw))
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.project
}

describe('the physics step rate as a scene setting', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a rate change in the project autosave, on the scene, and leaves the default implicit', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    expect(store.getState().simHz).toBe(DEFAULT_SIM_HZ)
    store.setSimHz(240)
    expect(store.getState().simHz).toBe(240)
    expect(storedProject().simHz).toBe(240)
    store.setSimHz(60)
    expect(storedProject()).not.toHaveProperty('simHz')
  })

  it('takes any whole rate in range, and rounds or clamps the rest', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.setSimHz(97)
    expect(store.getState().simHz).toBe(97)
    store.setSimHz(144.4)
    expect(store.getState().simHz).toBe(144)
    store.setSimHz(5000)
    expect(store.getState().simHz).toBe(1000)
    store.setSimHz(30) // below the floor, where loaded pallets sink (docs/sim-clock.md)
    expect(store.getState().simHz).toBe(DEFAULT_SIM_HZ)
    expect(storedProject()).not.toHaveProperty('simHz')
  })

  it("is each project's own: loading another project brings its rate, the default when it names none", () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(assembleProject(scene(), '', [], 'Fast line', undefined, 240))
    expect(store.getState().simHz).toBe(240)
    store.setSimHz(500)
    expect(storedProject().simHz).toBe(500)
    store.loadProject(assembleProject(scene(), '', [], 'Plain line'))
    expect(store.getState().simHz).toBe(DEFAULT_SIM_HZ) // not the rate of the project it replaced
    store.persistProject()
    expect(storedProject().name).toBe('Plain line')
    expect(storedProject()).not.toHaveProperty('simHz')
  })

  it('comes from the scene a project load opens', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(assembleProject(scene(), '', [], 'Fast line', undefined, 144))
    expect(store.getState().simHz).toBe(144)
  })

  it('travels in a scene file, and opening one brings its rate, the default when it names none', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const source = new EditorStore(scene())
    source.setSimHz(120)
    const text = sceneFileText(source.getState())
    expect((JSON.parse(text) as { simHz?: number }).simHz).toBe(120)

    const target = new EditorStore()
    target.setSimHz(240)
    expect(loadSceneText(target, text)).toBeNull()
    expect(target.getState().simHz).toBe(120)
    expect(storedProject().simHz).toBe(120)

    // a 60 Hz scene writes no rate, and opening it must not keep the rate of the scene it replaces
    source.setSimHz(DEFAULT_SIM_HZ)
    const plain = sceneFileText(source.getState())
    expect(JSON.parse(plain) as object).not.toHaveProperty('simHz')
    expect(loadSceneText(target, plain)).toBeNull()
    expect(target.getState().simHz).toBe(DEFAULT_SIM_HZ)
  })

  it('New simulation puts it back to the default: a fresh scene is a fresh machine', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.setSimHz(240)
    newSimulation(store)
    expect(store.getState().simHz).toBe(DEFAULT_SIM_HZ)
    expect(storedProject()).not.toHaveProperty('simHz')
  })

  it('in a room, a change goes to the room and never to the solo autosave', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    const room: number[] = []
    store.setCollabMode(true)
    store.setSimHzSink((hz) => void room.push(hz))
    store.setSimHz(240)
    expect(room).toEqual([240])
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull()
  })

  it('a remote rate lands in state without echoing back to the room', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    const room: number[] = []
    store.setCollabMode(true)
    store.setSimHzSink((hz) => void room.push(hz))
    store.applyRemoteSimHz(120)
    expect(store.getState().simHz).toBe(120)
    expect(room).toEqual([]) // the doc already holds it; writing back would loop
  })

  it('a view-only client cannot change the rate, but still follows the room', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.setReadOnly(true)
    store.setSimHz(240)
    expect(store.getState().simHz).toBe(DEFAULT_SIM_HZ)
    store.applyRemoteSimHz(240)
    expect(store.getState().simHz).toBe(240)
  })

  it('the demo preview runs at its own rate, not the scene it was entered from, and cannot change it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.setSimHz(240) // the user's scene
    store.enterDemoSession(scene(), '')
    expect(store.getState().demoSession).toBe(true)
    expect(store.getState().simHz).toBe(DEFAULT_SIM_HZ)

    store.setSimHz(120) // inert in the preview
    expect(store.getState().simHz).toBe(DEFAULT_SIM_HZ)
    expect(store.getState().demoSession).toBe(true) // not forked
    expect(storedProject().simHz).toBe(240) // the project left behind keeps its own
  })
})
