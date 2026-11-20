// Save in the browser (editor/project/saveProject.ts). The desktop half, where Save writes the project's folder,
// is pinned in projectFolderSync.test.ts; this is the web's: the work is already in this browser's
// storage, so Save says so and offers a copy, and never claims a save that did not happen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveProject } from './saveProject'
import { PROJECT_KEY } from './projectFile'
import { EditorStore } from '../store/store'
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

const project = (): ProjectJSON => ({
  version: PROJECT_VERSION,
  name: 'Line',
  scene: { version: SCENE_VERSION, parts: [] },
})

let storage: Storage

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => vi.unstubAllGlobals())

const opened = (): EditorStore => {
  const store = new EditorStore()
  store.loadProject(project())
  return store
}

describe('Save in the browser', () => {
  it('writes the working copy and says where the work is, with a copy one click away', async () => {
    const store = opened()
    store.renameProject('Line 2') // an edit the working copy has to carry
    await saveProject(store)
    expect(JSON.parse(storage.getItem(PROJECT_KEY)!).name).toBe('Line 2')
    const notice = store.getState().saveNotice
    expect(notice?.title).toBe('Saved in this browser')
    expect(notice?.action).toEqual({ label: 'Download a copy', command: 'file.exportProject' })
  })

  it('says so on the first Save only: the project autosaves, so a habitual Ctrl+S has nothing new to report', async () => {
    const store = opened()
    await saveProject(store)
    expect(store.getState().saveNotice?.title).toBe('Saved in this browser')
    store.dismissSaveNotice()
    store.renameProject('Line 3')
    await saveProject(store)
    expect(JSON.parse(storage.getItem(PROJECT_KEY)!).name).toBe('Line 3') // it still writes
    expect(store.getState().saveNotice).toBeNull()
  })

  it('claims nothing when the save failed - the autosave banner says why', async () => {
    const store = opened()
    storage.setItem = () => {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    }
    await saveProject(store)
    expect(store.getState().saveNotice).toBeNull()
    expect(store.getState().autosaveError).toMatch(/local storage/)
  })

  it('keeps a copy of the demo preview as a project of its own, and lets that fork speak for itself', async () => {
    const store = opened()
    store.setDemoForkHost(() => 'Demo copy')
    store.enterDemoSession({ version: SCENE_VERSION, parts: [] }, '')
    await saveProject(store)
    expect(store.getState().demoSession).toBe(false)
    expect(store.getState().projectName).toBe('Demo copy')
    expect(store.getState().demoForkNotice).not.toBeNull()
    expect(store.getState().saveNotice).toBeNull()
    expect(JSON.parse(storage.getItem(PROJECT_KEY)!).name).toBe('Demo copy')
  })

  it('with nowhere to file the open project, the demo stays a preview and its notice says so', async () => {
    const store = opened()
    store.enterDemoSession({ version: SCENE_VERSION, parts: [] }, '')
    const before = storage.getItem(PROJECT_KEY)
    await saveProject(store)
    expect(store.getState().demoSession).toBe(true)
    expect(store.getState().demoForkNotice?.title).toBe('Your demo changes are not kept here')
    expect(store.getState().saveNotice).toBeNull() // no claim of a save that did not happen
    expect(storage.getItem(PROJECT_KEY)).toBe(before) // the project left behind, untouched
  })

  it('does nothing on a view-only link', async () => {
    const store = opened()
    store.setReadOnly(true)
    await saveProject(store)
    expect(store.getState().saveNotice).toBeNull()
  })

  it('says a live room saves as you work, rather than touching this browser’s copy', async () => {
    const store = opened()
    store.setCollabMode(true)
    storage.removeItem(PROJECT_KEY)
    await saveProject(store)
    expect(store.getState().saveNotice?.title).toBe('Saved as you work')
    // the moment someone reaches for Save in a room is when a copy of their own is the thing they may want
    expect(store.getState().saveNotice?.action).toEqual({ label: 'Make a copy', command: 'file.copyRoom' })
    expect(storage.getItem(PROJECT_KEY)).toBeNull()
  })
})
