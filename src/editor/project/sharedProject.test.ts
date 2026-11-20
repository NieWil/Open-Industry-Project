import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorStore } from '../store/store'
import { CURRENT_DOC_KEY } from './documentStore'
import { assembleProject, PROJECT_KEY, saveStoredProject } from './projectFile'
import { blankScene } from '../../core/scene/scene'
import type { ProjectJSON } from '../../core/project/project'
import { noteSharedProject, ownSharedProject, renameSharedProject, sharedProjectOf, startWriteBack } from './sharedProject'

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

const shared = { docId: 'doc-1', room: 'e-room', project: 'Mine', server: null }
const storedName = () => (JSON.parse(localStorage.getItem(PROJECT_KEY) ?? 'null') as { name?: string } | null)?.name

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('localStorage', fakeStorage())
  vi.stubGlobal('location', { href: 'http://app.test/app/?room=e-room' })
  localStorage.setItem(CURRENT_DOC_KEY, 'doc-1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a shared project', () => {
  it('is found by its room in the address bar, and by its document', () => {
    noteSharedProject(shared)
    expect(ownSharedProject()).toEqual(shared)
    expect(sharedProjectOf('doc-1')).toEqual(shared)
    expect(ownSharedProject('http://app.test/app/?room=e-theirs')).toBeNull()
  })

  it('is written back under its own name, whatever the room calls it', () => {
    noteSharedProject(shared)
    const store = new EditorStore()
    store.setCollabMode(true)
    startWriteBack(store, shared)
    expect(storedName()).toBe('Mine')
  })

  it("keeps what the room does not carry: a project's tests survive a tab opened straight into its room", () => {
    // the project as saved, with a test; the store below never loaded it, as when the app opens into the room
    const project = { ...assembleProject(blankScene(), '', [], 'Mine'), tests: [{ name: 'starts', duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }] }] } as ProjectJSON
    expect(saveStoredProject(project).ok).toBe(true)
    noteSharedProject(shared)
    const store = new EditorStore()
    store.setCollabMode(true)
    // the room's document arriving, as the room boot applies it (main.tsx bootRoom)
    store.applyRemote({ ...store.getState().scene, parts: [{ id: 'room_part', type: 'group', position: [0, 0, 0], rotationY: 0, params: {} }] as never })
    startWriteBack(store, shared)
    const saved = JSON.parse(localStorage.getItem(PROJECT_KEY)!) as { tests?: { name: string }[]; scene: { parts: { id: string }[] } }
    expect(saved.scene.parts.map((p) => p.id)).toContain('room_part') // the room was written back
    expect(saved.tests?.map((t) => t.name)).toEqual(['starts']) // and the tests it does not carry were kept
  })

  it("lets the owner keep tests in the room: they are the project's, and a change is written back", () => {
    const check = { name: 'starts', duration: 2, checks: [{ tag: 'Done', at: 1, equals: true }] }
    expect(saveStoredProject({ ...assembleProject(blankScene(), '', [], 'Mine'), tests: [check] } as ProjectJSON).ok).toBe(true)
    noteSharedProject(shared)
    const store = new EditorStore()
    store.setCollabMode(true)
    startWriteBack(store, shared)
    expect(store.projectTests().map((t) => t.name)).toEqual(['starts'])
    expect(store.getState().testCount).toBe(1) // Run Project Tests is on
    expect(store.saveProjectTest({ ...check, name: 'stops' })).toBe(true)
    vi.advanceTimersByTime(1000)
    const tests = () => (JSON.parse(localStorage.getItem(PROJECT_KEY)!) as { tests?: { name: string }[] }).tests?.map((t) => t.name)
    expect(tests()).toEqual(['starts', 'stops'])
    expect(store.deleteProjectTest('starts')).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(tests()).toEqual(['stops'])
  })

  it("does not keep tests in someone else's room, which has nowhere to keep them", () => {
    vi.stubGlobal('location', { href: 'http://app.test/app/?room=not-mine' })
    const store = new EditorStore()
    store.setCollabMode(true)
    expect(store.saveProjectTest({ name: 'x', duration: 1, checks: [] } as never)).toBe(false)
  })

  it('renamed while shared, keeps the new name: the write-back saves what the record names', async () => {
    noteSharedProject(shared)
    const store = new EditorStore()
    store.setCollabMode(true)
    startWriteBack(store, ownSharedProject()!)
    expect(renameSharedProject(store, 'doc-1', '  Packing line ')).toBe(true)
    expect(ownSharedProject()?.project).toBe('Packing line')
    expect(store.getState().projectName).toBe('Packing line')
    expect(storedName()).toBe('Packing line')
    // the next edit's write-back keeps it
    store.commit('Add part', { ...store.getState().scene, parts: [{ id: 'p', type: 'group', position: [0, 0, 0], rotationY: 0, params: {} }] as never })
    await vi.advanceTimersByTimeAsync(1100)
    expect(localStorage.getItem(PROJECT_KEY)).toContain('"id":"p"') // the edit was written back, so the name was too
    expect(storedName()).toBe('Packing line')
    expect(renameSharedProject(store, 'doc-other', 'X')).toBe(false)
  })
})
