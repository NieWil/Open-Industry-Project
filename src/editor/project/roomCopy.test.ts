// Make a Copy of a room (editor/project/roomCopy.ts), the part provable without IndexedDB: what the copy holds, the URL it
// boots at, and every refusal - each of which must leave this browser's own project exactly where it was. The
// library write and the boot into the copy are real-browser behaviour, gated by e2e/verify-collab-room-copy.mjs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyRoomToProjects, roomCopyProject, soloUrl } from './roomCopy'
import { PROJECT_KEY } from './projectFile'
import { EditorStore } from '../store/store'
import { setRoomCodeGate } from '../../collab/session'
import type { PackageGate } from '../../collab/codeTrust'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'

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

const project = (name: string): ProjectJSON => ({
  version: PROJECT_VERSION,
  name,
  scene: { version: SCENE_VERSION, parts: [] },
})

let storage: Storage

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('location', { href: 'https://x.test/app/?room=e-abc&view' })
})

afterEach(() => {
  setRoomCodeGate(null)
  vi.unstubAllGlobals()
})

/** a store standing in a room, holding the room's document */
const inRoom = (): EditorStore => {
  const store = new EditorStore()
  store.loadProject(project('Line'))
  store.setCollabMode(true)
  return store
}

describe('the copy', () => {
  it('is the room document under a copy name, detached from the store', () => {
    const store = inRoom()
    const copy = roomCopyProject(store)
    expect(copy.name).toBe('Copy of Line')
    copy.name = 'mine'
    copy.scene.parts.push({ id: 'g', type: 'group', position: [0, 0, 0], rotationY: 0, params: {} } as never)
    expect(store.snapshotProject().scene.parts).toEqual([])
    expect(store.snapshotProject().name).toBe('Line')
  })

  // A reload would rejoin the room, so the copy boots at the app without it - and without the demo entry either,
  // which would open the demo over it. Anything else on the URL (?hook, a hash) is the page's own and stays.
  it('boots at the app without the room', () => {
    expect(soloUrl('https://x.test/app/?room=e-abc&view')).toBe('/app/')
    expect(soloUrl('https://x.test/app/?hook&room=r-abc&scene=demo#x')).toBe('/app/?hook=#x')
  })
})

describe('refusals, which change nothing', () => {
  const solo = JSON.stringify(project('Mine'))

  it('refuses outside a room', async () => {
    const store = new EditorStore()
    store.loadProject(project('Line'))
    expect(await copyRoomToProjects(store)).toMatch(/shared project/)
  })

  // Guards against a held part's stand-in ending up in the copy as a part that silently does nothing.
  // the working copy is written after the room store is built: building it here goes through a solo load, which
  // autosaves, where the real room boot never writes the working copy at all
  it('refuses while the room holds part code back, naming it', async () => {
    const store = inRoom()
    storage.setItem(PROJECT_KEY, solo)
    setRoomCodeGate({ getHeld: () => [{ name: 'Widget' }] } as unknown as PackageGate)
    expect(await copyRoomToProjects(store)).toMatch(/“Widget”.*Allow its part code/)
    setRoomCodeGate({ getHeld: () => [{ name: 'A' }, { name: 'B' }] } as unknown as PackageGate)
    expect(await copyRoomToProjects(store)).toMatch(/^2 part types/)
    expect(storage.getItem(PROJECT_KEY)).toBe(solo)
  })

  it('points at the export where there is no library to put a copy in', async () => {
    const store = inRoom()
    storage.setItem(PROJECT_KEY, solo)
    expect(await copyRoomToProjects(store)).toMatch(/Export Project/)
    expect(storage.getItem(PROJECT_KEY)).toBe(solo)
  })
})
