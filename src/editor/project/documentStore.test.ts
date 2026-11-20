// What is provable without IndexedDB. In a Node test env that is everything here.
//
// This is the property most worth pinning: the document library is an enhancement. A browser that
// cannot give it one (private mode, blocked storage, Safari with site data off, this test runner) must
// keep the plain single-document behaviour, with no throw into a render and no broken autosave. Every
// entry point is therefore exercised here with no indexedDB at all.
//
// The IndexedDB path itself is real-browser behaviour and is gated by e2e/verify-project-shelf.mjs,
// which drives two documents through create / switch / delete and proves they stay isolated.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_DOC_KEY,
  adoptDocumentInPlace,
  createDocument,
  currentDocumentId,
  deleteDocument,
  fileOutgoingDocument,
  isOtherDocumentSlot,
  listDocuments,
  mintDocumentId,
  onCurrentDocumentChange,
  readDocument,
  renameDocument,
  requestDurableStorage,
  sceneSlotKey,
  slotDocumentId,
  supportsDocumentLibrary,
  syncCurrentDocument,
  writeDocument,
} from './documentStore'
import { PROJECT_KEY, SUPERSEDED_MESSAGE, assembleProject, loadStoredProject, saveStoredProject, unopenedProject } from './projectFile'
import { SCENE_VERSION } from '../../core/types'

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

const project = (name: string) => assembleProject({ version: SCENE_VERSION, parts: [] }, '', [], name)

describe('document library without IndexedDB', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reports itself absent rather than pretending', () => {
    expect(supportsDocumentLibrary()).toBe(false)
  })

  // Each of these is a call the app makes on a path the user is standing on - boot, an edit's trailing
  // sync, the shelf opening. A throw from any of them would be an app-level failure caused by a
  // feature the browser doesn't have.
  it('degrades to nothing on every entry point, and never throws', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    await expect(listDocuments()).resolves.toEqual([])
    await expect(readDocument('doc-1')).resolves.toBeNull()
    await expect(writeDocument('doc-1', project('P'))).resolves.toBe(false)
    await expect(deleteDocument('doc-1')).resolves.toBe(false)
    await expect(renameDocument('doc-1', 'Q')).resolves.toBe(false)
    await expect(syncCurrentDocument(project('P'))).resolves.toBeNull()
  })

  // The pointer is the one piece kept in localStorage, because the boot path wants it synchronously.
  // Without a library it must stay unset: minting an id for a document that was never filed would
  // leave a browser claiming to hold a record it cannot produce.
  it('does not mint a document id when there is nowhere to file one', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    await syncCurrentDocument(project('P'))
    expect(localStorage.getItem(CURRENT_DOC_KEY)).toBeNull()
    expect(currentDocumentId()).toBeNull()
  })

  it('survives blocked storage on the pointer read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('The operation is insecure.')
      },
    } as unknown as Storage)
    expect(currentDocumentId()).toBeNull()
  })
})

// The library holds every project the user has made, and IndexedDB without a durability grant is
// evictable under storage pressure - so the grant is worth asking for, once, at a moment that makes
// sense. Firefox puts a permission prompt behind this call, which is why the asking is rationed here
// rather than fired at boot (the shelf asks only when it holds more than one project).
describe('durable storage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const withStorage = (persisted: boolean, persist: () => Promise<boolean>) =>
    vi.stubGlobal('navigator', { storage: { persisted: () => Promise.resolve(persisted), persist } })

  it('is a no-op where the API does not exist', async () => {
    vi.stubGlobal('navigator', {})
    await expect(requestDurableStorage()).resolves.toBe(false)
  })

  it('never re-asks once the grant exists', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    let asked = 0
    withStorage(true, () => {
      asked++
      return Promise.resolve(true)
    })
    await expect(requestDurableStorage()).resolves.toBe(true)
    expect(asked).toBe(0)
  })

  // A refusal is remembered. Otherwise the permission prompt would come back every time the shelf opens.
  it('asks once, then remembers that it did', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    let asked = 0
    withStorage(false, () => {
      asked++
      return Promise.resolve(false)
    })
    await expect(requestDurableStorage()).resolves.toBe(false)
    expect(asked).toBe(1)
    await expect(requestDurableStorage()).resolves.toBe(false)
    expect(asked).toBe(1) // not asked a second time
  })

  it('reports a grant it just won', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    withStorage(false, () => Promise.resolve(true))
    await expect(requestDurableStorage()).resolves.toBe(true)
  })

  it('survives a browser that throws from the API', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    vi.stubGlobal('navigator', {
      storage: {
        persisted: () => Promise.reject(new Error('nope')),
        persist: () => Promise.resolve(true),
      },
    })
    await expect(requestDurableStorage()).resolves.toBe(false)
  })
})

describe('document ids', () => {
  // Identity is the id, never the name: two projects may legitimately be called "Untitled Project",
  // and renaming one must not re-home its record (documentStore.renameDocument writes the same key).
  it('are unique across a burst', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintDocumentId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^doc-[0-9a-z]+-[0-9a-z]+$/)
  })
})

// Opening a document without a reload, as the linked folder does (projectFolderLink.beginFolderLink). A
// library that exists but cannot be written (an indexedDB whose open throws: supportsDocumentLibrary() is
// true, every transaction fails) reaches the pointer logic without a real IndexedDB. Successful filing
// is real-browser behaviour, gated by e2e/verify-project-shelf.mjs.
describe('opening a document in place', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const brokenLibrary = () =>
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage blocked')
      },
    })
  const working = () => JSON.parse(localStorage.getItem(PROJECT_KEY) ?? 'null')?.name

  it('without a library, replaces the working copy and applies it, as before', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    saveStoredProject(project('Open'))
    const apply = vi.fn()
    await expect(adoptDocumentInPlace(project('Folder'), project('Open'), apply)).resolves.toBeNull()
    expect(working()).toBe('Folder')
    expect(apply).toHaveBeenCalledOnce()
    expect(currentDocumentId()).toBeNull()
  })

  // guards against replacing the working copy when the outgoing project was never filed
  it('replaces nothing when the project on screen cannot be filed first', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    brokenLibrary()
    saveStoredProject(project('Open'))
    localStorage.setItem(CURRENT_DOC_KEY, 'doc-open')
    const apply = vi.fn()
    const message = await adoptDocumentInPlace(project('Folder'), project('Open'), apply)
    expect(message).toMatch(/could not be filed/)
    expect(working()).toBe('Open')
    expect(apply).not.toHaveBeenCalled()
    expect(currentDocumentId()).toBe('doc-open')
  })

  it('gives the incoming document its own id, and says so before applying it', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    brokenLibrary()
    localStorage.setItem(CURRENT_DOC_KEY, 'doc-open')
    const order: string[] = []
    const off = onCurrentDocumentChange((id) => order.push(`moved:${id}`))
    try {
      // nothing on screen to file (a demo preview with no project behind it)
      await adoptDocumentInPlace(project('Folder'), null, () => order.push('applied'))
    } finally {
      off()
    }
    const id = currentDocumentId()
    expect(id).toMatch(/^doc-/)
    expect(id).not.toBe('doc-open')
    expect(order).toEqual([`moved:${id}`, 'applied'])
    expect(working()).toBe('Folder')
  })

  it('refuses outright while the working copy holds a project this session could not open', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    brokenLibrary()
    localStorage.setItem(PROJECT_KEY, '{ not a project')
    loadStoredProject()
    const apply = vi.fn()
    expect(await adoptDocumentInPlace(project('Folder'), project('Fallback'), apply)).toMatch(/could not be opened/)
    expect(localStorage.getItem(PROJECT_KEY)).toBe('{ not a project')
    expect(apply).not.toHaveBeenCalled()
    // and no sync may mint a record for the fallback on screen under that document's name either
    await expect(syncCurrentDocument(project('Fallback'))).resolves.toBeNull()
    expect(currentDocumentId()).toBeNull()
    expect(unopenedProject()).not.toBeNull()
  })
})

// Every path that replaces the open project files it first, and stops if that fails (fileOutgoingDocument).
describe('filing the project being left', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a new project replaces nothing when the open one cannot be filed', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage blocked')
      },
    })
    saveStoredProject(project('Open'))
    expect(await createDocument(project('Blank'), project('Open'))).toMatch(/could not be filed/)
    expect(JSON.parse(localStorage.getItem(PROJECT_KEY)!).name).toBe('Open')
  })

  it('with no library there is nothing to file, and nothing to stop', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    await expect(fileOutgoingDocument(project('Open'))).resolves.toBeNull()
    await expect(fileOutgoingDocument(null)).resolves.toBeNull()
  })

  it('refuses once another tab has written the working copy', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    loadStoredProject()
    localStorage.setItem(PROJECT_KEY, 'the other tab')
    expect(saveStoredProject(project('Mine')).ok).toBe(false)
    await expect(fileOutgoingDocument(project('Mine'))).resolves.toBe(SUPERSEDED_MESSAGE)
    expect(await createDocument(project('Blank'), project('Mine'))).toBe(SUPERSEDED_MESSAGE)
    expect(localStorage.getItem(PROJECT_KEY)).toBe('the other tab')
  })
})

// Per-scene workspace state (a remembered camera, a tutorial run) is keyed by document and scene, because
// every project has a `scene-1`.
describe('scene slot keys', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('name the open document, and stay bare where there is none', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(sceneSlotKey('scene-1')).toBe('scene-1')
    localStorage.setItem(CURRENT_DOC_KEY, 'doc-a')
    expect(sceneSlotKey('scene-1')).toBe('doc-a/scene-1')
  })

  // the first id minted for the document on screen moves those keys, so it is announced like an in-place switch
  it('announce the first id minted for the document on screen', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage blocked')
      },
    })
    const heard: string[] = []
    const off = onCurrentDocumentChange((id) => heard.push(id))
    try {
      await syncCurrentDocument(project('P'))
      const minted = currentDocumentId()
      expect(minted).toMatch(/^doc-/)
      expect(heard).toEqual([minted])
      await syncCurrentDocument(project('P')) // already has one: nothing to announce
      expect(heard).toEqual([minted])
    } finally {
      off()
    }
  })
})

describe('whose scene slot', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the document out of a slot key, and nothing out of a bare one', () => {
    expect(slotDocumentId('doc-a1-b2/scene-1')).toBe('doc-a1-b2')
    expect(slotDocumentId('doc-a1-b2/lines/one')).toBe('doc-a1-b2') // a folder scene id may hold a slash
    expect(slotDocumentId('scene-1')).toBeNull()
    expect(slotDocumentId('lines/doc-x/scene-1')).toBeNull()
  })

  // another project's slot is not a scene missing from this one - its project is just not open
  it('tells another document’s slot from the open one’s and from a bare one', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    localStorage.setItem(CURRENT_DOC_KEY, 'doc-open')
    expect(isOtherDocumentSlot('doc-other/scene-1')).toBe(true)
    expect(isOtherDocumentSlot('doc-open/scene-1')).toBe(false)
    expect(isOtherDocumentSlot('scene-1')).toBe(false)
  })
})
