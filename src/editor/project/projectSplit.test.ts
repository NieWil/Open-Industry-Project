import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import { parkSplitOff, readParkedSplitOff } from './projectFile'
import { fileSplitOff } from './projectSplit'
import type { EditorStore } from '../store/store'

// the library, faked: which projects were filed, and which write fails
const filed: string[] = []
let failOn: string | null = null
vi.mock('./documentStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./documentStore')>()),
  supportsDocumentLibrary: () => true,
  currentDocumentId: () => null,
  writeDocument: async (_id: string, project: ProjectJSON) => {
    if (project.name === failOn) return false
    filed.push(project.name)
    return true
  },
}))

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
  scene: { version: SCENE_VERSION, parts: [{ id: 'g', type: 'group', position: [0, 0, 0], rotationY: 0, params: {} }] },
})

function noticeStore(): { store: EditorStore; notices: string[] } {
  const notices: string[] = []
  const store = { showSaveNotice: (title: string) => void notices.push(title) } as unknown as EditorStore
  return { store, notices }
}

describe('filing the scenes an older project split into (fileSplitOff)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    filed.length = 0
    failOn = null
  })

  it('files each as a project and unparks them all', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    parkSplitOff([project('Plant - Line 2'), project('Plant - Line 3')])
    const { store, notices } = noticeStore()
    await fileSplitOff(store)
    expect(filed).toEqual(['Plant - Line 2', 'Plant - Line 3'])
    expect(readParkedSplitOff()).toEqual([])
    expect(notices).toEqual(['Split into projects'])
  })

  // A failure part way must not file the first one again on the retry: each is unparked as soon as it is filed.
  it('a failure part way keeps only what is still unfiled, so the retry makes no duplicate', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    parkSplitOff([project('Plant - Line 2'), project('Plant - Line 3')])
    failOn = 'Plant - Line 3'
    const { store, notices } = noticeStore()
    await fileSplitOff(store)
    expect(filed).toEqual(['Plant - Line 2'])
    expect(readParkedSplitOff().map((p) => p.name)).toEqual(['Plant - Line 3'])
    expect(notices).toEqual(['Some scenes are waiting'])

    failOn = null
    await fileSplitOff(store)
    expect(filed).toEqual(['Plant - Line 2', 'Plant - Line 3']) // Line 2 once, not twice
    expect(readParkedSplitOff()).toEqual([])
  })
})
