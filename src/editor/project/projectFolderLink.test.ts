// The browser's linked project folder, exercised without a picker. showDirectoryPicker cannot be driven
// from a test browser (it is a native OS dialog), so everything downstream of it (reading, the
// fingerprint, the guarded writes, linking, the reload restore) takes a structural handle and is
// reachable here. The sync rules (what is written, what is loaded, what is a conflict) belong to the
// engine and are pinned in projectFolderSync.test.ts. This file pins the browser host: that a directory
// handle carries them faithfully, plus the permission requests and remembered handle around it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginFolderLink,
  browserFolderApi,
  folderSignature,
  hasPausedFolder,
  hasProjectManifest,
  readProjectFolderFiles,
  reconnectProjectFolder,
  restoreFolderLink,
  saveProjectToFolderHandle,
  unlinkProjectFolder,
  writeProjectFolderFiles,
} from './projectFolderLink'
import type { DirLike, FileLike, PermissionedDir, WritableDirLike } from './projectFolderLink'
import { POLL_MS, resetFolderSyncForTests, resolveFolderConflict, syncFolderNow, syncedFolderPath } from './projectFolderSync'
import { AGENT_GUIDE, PROJECT_MANIFEST, projectToFolderFiles } from '../../core/project/projectFolder'
import type { ProjectFolderFile } from '../../core/project/projectFolder'
import { hashText } from '../../core/project/folderSync'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance } from '../../core/types'
import { EditorStore } from '../store/store'
import { PROJECT_KEY, loadStoredProject } from './projectFile'
import { CURRENT_DOC_KEY } from './documentStore'
import type { RememberedFolder } from './folderHandleStore'
import { saveProject } from './saveProject'

/** The remembered-handle store, in memory. Mocked rather than left to no-op on a Node env with no
 *  IndexedDB, because remember -> recall across a reload is the behaviour under test: with the real
 *  module here every recall would return null and every assertion below would pass vacuously. */
const handleMemory = vi.hoisted(() => new Map<string, RememberedFolder>())
vi.mock('./folderHandleStore', () => ({
  supportsHandleMemory: () => true,
  rememberFolderHandle: (id: string | null, handle: unknown, signature: string, sync: object = {}) => {
    if (id !== null && id !== '') handleMemory.set(id, { handle, signature, ...sync })
    return Promise.resolve()
  },
  recallFolderHandle: (id: string | null) => Promise.resolve(id === null ? null : (handleMemory.get(id) ?? null)),
  forgetFolderHandle: (id: string | null) => {
    if (id !== null) handleMemory.delete(id)
    return Promise.resolve()
  },
}))

/** in-memory Storage (the Node test env has no localStorage) - mirrors storeProject.test.ts */
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

const notFound = (what: string): Error => Object.assign(new Error(`${what} not found`), { name: 'NotFoundError' })

/**
 * A folder on disk, in memory, behind the same handle surface a real FileSystemDirectoryHandle offers:
 * nested directories, reads with size + mtime, writes through createWritable, removeEntry, and
 * NotFoundError for what is not there. Writes bump an mtime, so the fingerprint moves the way a real
 * one does. `put` is what an agent or an editor does: write the file directly.
 */
class MemoryFolder {
  readonly files = new Map<string, { text: string; mtime: number }>()
  readonly dirs = new Set<string>()
  private tick = 1
  constructor(
    readonly name: string,
    files: readonly ProjectFolderFile[] = [],
  ) {
    for (const f of files) this.put(f.path, f.contents as string)
  }
  put(path: string, text: string): void {
    this.files.set(path, { text, mtime: this.tick++ })
  }
  text(path: string): string | undefined {
    return this.files.get(path)?.text
  }
  hasDir(prefix: string): boolean {
    return this.dirs.has(prefix) || [...this.files.keys()].some((p) => p.startsWith(prefix))
  }
  handle(prefix = '', extra: Partial<PermissionedDir> = {}): WritableDirLike & PermissionedDir {
    return handleOf(this, prefix, extra)
  }
}

function handleOf(self: MemoryFolder, prefix: string, extra: Partial<PermissionedDir>): WritableDirLike & PermissionedDir {
  const fileAt = (path: string, create: boolean) => ({
    kind: 'file' as const,
    name: path.slice(path.lastIndexOf('/') + 1),
    getFile: async () => {
      const f = self.files.get(path)
      if (!f) throw notFound(path)
      return {
        lastModified: f.mtime,
        size: f.text.length,
        text: async () => f.text,
      }
    },
    createWritable: async () => {
      let buffer = ''
      return {
        write: async (d: string) => void (buffer = d),
        close: async () => self.put(path, buffer),
      }
    },
    create,
  })
  return {
    name: prefix === '' ? self.name : prefix.slice(0, -1).split('/').pop()!,
    entries: async function* () {
      const seen = new Set<string>()
      const children = [...self.files.keys(), ...[...self.dirs].map((d) => `${d}.`)]
      for (const path of children) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) {
          if (rest !== '.' && self.files.has(path)) yield [rest, fileAt(path, false)] as [string, FileLike]
          continue
        }
        const dir = rest.slice(0, slash)
        if (seen.has(dir)) continue
        seen.add(dir)
        yield [dir, self.handle(`${prefix}${dir}/`)] as [string, DirLike]
      }
    },
    getDirectoryHandle: async (child, opts) => {
      const at = `${prefix}${child}/`
      if (!self.hasDir(at)) {
        if (!opts?.create) throw notFound(at)
        self.dirs.add(at)
      }
      return self.handle(at)
    },
    getFileHandle: async (child, opts) => {
      const path = `${prefix}${child}`
      if (!self.files.has(path) && !opts?.create) throw notFound(path)
      return fileAt(path, !!opts?.create)
    },
    removeEntry: async (child) => {
      const path = `${prefix}${child}`
      if (self.files.delete(path)) return
      const at = `${path}/`
      if (!self.hasDir(at)) throw notFound(path)
      if ([...self.files.keys()].some((p) => p.startsWith(at)))
        throw Object.assign(new Error('not empty'), {
          name: 'InvalidModificationError',
        })
      self.dirs.delete(at)
    },
    ...extra,
  }
}

const sampleProject = (): ProjectJSON => ({
  version: PROJECT_VERSION,
  name: 'Linked',
  scene: { version: SCENE_VERSION, parts: [] },
  stProgram: 'VAR_OUTPUT\n  Run : BOOL;\nEND_VAR\n\nRun := TRUE;\n',
  tests: [
    {
      name: 'runs',
      duration: 1,
      checks: [{ tag: 'Run', at: 0.5, equals: true }],
    },
  ],
})

const folderOf = (project: ProjectJSON = sampleProject(), name = 'my-factory'): MemoryFolder => new MemoryFolder(name, projectToFolderFiles(project))
const group = (id: string): PartInstance =>
  ({
    id,
    type: 'group',
    position: [0, 0.2, 0],
    rotationY: 0,
    params: {},
  }) as PartInstance

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  })
  vi.stubGlobal('localStorage', fakeStorage())
})

afterEach(() => {
  resetFolderSyncForTests()
  handleMemory.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('reading a linked folder', () => {
  it('reassembles exactly what the codec wrote', async () => {
    // AGENTS.md is written for the agent, not for the app: the read covers only project.json plus the
    // three known subdirectories. Excluded rather than asserted equal, because a guide that did come back
    // would mean the read had started walking the root.
    const written = projectToFolderFiles(sampleProject()).filter((f) => f.path !== AGENT_GUIDE)
    const read = await readProjectFolderFiles(folderOf().handle())
    expect(read.map((f) => f.path).sort()).toEqual(written.map((f) => f.path).sort())
    for (const w of written) expect(read.find((r) => r.path === w.path)?.contents).toBe(w.contents)
  })

  it('reads the tests the project carries', async () => {
    const read = await readProjectFolderFiles(folderOf().handle())
    expect(read.some((f) => f.path.startsWith('tests/'))).toBe(true)
  })

  // bounded to the manifest + the three known subdirectories, so pointing the picker at a big folder by
  // mistake costs a handful of stats, not a tree walk
  it('ignores files and directories the format does not define', async () => {
    const dir = folderOf()
    dir.put('README.md', '# notes')
    dir.put('node_modules/thing/index.js', 'huge')
    const read = await readProjectFolderFiles(dir.handle())
    expect(read.some((f) => f.path === 'README.md')).toBe(false)
    expect(read.some((f) => f.path.startsWith('node_modules/'))).toBe(false)
  })
})

describe('the change fingerprint', () => {
  it('is stable when nothing changed, and moves when a file does', async () => {
    const dir = folderOf()
    const before = await folderSignature(dir.handle())
    expect(await folderSignature(dir.handle())).toBe(before)
    dir.put('plc/program.st', 'changed')
    expect(await folderSignature(dir.handle())).not.toBe(before)
  })

  it('moves when a file is added', async () => {
    const dir = folderOf()
    const before = await folderSignature(dir.handle())
    dir.put('tests/second.test.json', '{}')
    expect(await folderSignature(dir.handle())).not.toBe(before)
  })
})

describe('writing a project into a folder', () => {
  it('writes exactly what the codec defines, creating subdirectories', async () => {
    const dir = new MemoryFolder('empty')
    const files = projectToFolderFiles(sampleProject())
    await writeProjectFolderFiles(dir.handle(), files)
    expect([...dir.files.keys()].sort()).toEqual(files.map((f) => f.path).sort())
    for (const f of files) expect(dir.text(f.path)).toBe(f.contents)
  })

  it('knows whether a folder already holds a project, so the caller can confirm', async () => {
    const dir = new MemoryFolder('empty')
    expect(await hasProjectManifest(dir.handle())).toBe(false)
    await writeProjectFolderFiles(dir.handle(), projectToFolderFiles(sampleProject()))
    expect(await hasProjectManifest(dir.handle())).toBe(true)
  })
})

// The browser twin of the Electron shell's applyFolderWrites: a write goes through only if the file still holds what was last read.
describe('guarded writes through a handle', () => {
  it('replaces a file that still holds what was last read, and reports one that moved', async () => {
    const dir = new MemoryFolder('f', [{ path: 'scenes/a.st', contents: 'A' }])
    const api = browserFolderApi(dir.handle())
    expect(await api.write('f', [{ path: 'scenes/a.st', contents: 'B', expect: hashText('A') }])).toEqual({ moved: [], failed: [], error: null })
    expect(dir.text('scenes/a.st')).toBe('B')
    expect((await api.write('f', [{ path: 'scenes/a.st', contents: 'C', expect: hashText('A') }])).moved).toEqual(['scenes/a.st'])
    expect(dir.text('scenes/a.st')).toBe('B')
  })

  it('creates a file that must not exist yet, into folders that do not exist yet', async () => {
    const dir = new MemoryFolder('f')
    const api = browserFolderApi(dir.handle())
    expect((await api.write('f', [{ path: 'parts/p/behavior.js', contents: 'x', expect: null }])).moved).toEqual([])
    expect(dir.text('parts/p/behavior.js')).toBe('x')
    expect((await api.write('f', [{ path: 'parts/p/behavior.js', contents: 'y', expect: null }])).moved).toEqual(['parts/p/behavior.js'])
  })

  it('deletes, and takes an emptied part folder with it - but never the format folder', async () => {
    const dir = new MemoryFolder('f', [
      { path: 'parts/p/manifest.json', contents: 'M' },
      { path: 'parts/p/behavior.js', contents: 'B' },
      { path: 'parts/q/behavior.js', contents: 'Q' },
    ])
    const api = browserFolderApi(dir.handle())
    const result = await api.write('f', [
      { path: 'parts/p/manifest.json', expect: hashText('M') },
      { path: 'parts/p/behavior.js', expect: hashText('B') },
    ])
    expect(result).toEqual({ moved: [], failed: [], error: null })
    expect([...dir.files.keys()]).toEqual(['parts/q/behavior.js'])
    expect(dir.dirs.has('parts/p/')).toBe(false)
  })

  it('refuses a path that could leave the folder, without holding back the rest', async () => {
    const dir = new MemoryFolder('f')
    const result = await browserFolderApi(dir.handle()).write('f', [
      { path: '../evil.st', contents: 'x', expect: '*' },
      { path: 'scenes/ok.st', contents: 'ok', expect: null },
    ])
    expect(result.failed).toEqual(['../evil.st'])
    expect(dir.text('scenes/ok.st')).toBe('ok')
  })

  it('says so, rather than throwing, for a folder opened for reading only', async () => {
    const read: DirLike = { name: 'ro', entries: folderOf().handle().entries }
    const result = await browserFolderApi(read).write('ro', [{ path: 'scenes/a.st', contents: 'x', expect: '*' }])
    expect(result.failed).toEqual(['scenes/a.st'])
    expect(result.error).toMatch(/reading only/)
  })
})

// Linking opens a document: the first load is a different project arriving, so it must not be saved over the
// one on screen (documentStore.adoptDocumentInPlace). The successful filing needs a real IndexedDB and is
// gated by e2e/verify-project-shelf.mjs; what is reachable here is every way it must replace nothing.
describe('linking a folder opens it as a document', () => {
  const onScreen = (): ProjectJSON => ({
    ...sampleProject(),
    name: 'On Screen',
    tests: undefined,
  })
  const working = () => JSON.parse(localStorage.getItem(PROJECT_KEY) ?? 'null')?.name
  const setUp = () => {
    const store = new EditorStore()
    store.loadProject(onScreen())
    expect(working()).toBe('On Screen')
    return store
  }

  it("opens the folder's project, tests and all, and keeps it in step", async () => {
    const store = setUp()
    const dir = folderOf()
    expect(await beginFolderLink(dir.handle(), store)).toBeNull()
    expect(store.getState().projectName).toBe('Linked')
    expect(store.getState().testCount).toBe(1)
    expect(store.getState().folderPath).toBe('my-factory')
    expect(store.getState().linkedFolder).toBe('my-factory')
  })

  it('asks first, and declining changes nothing', async () => {
    const store = setUp()
    const confirmOpen = vi.fn(() => false)
    expect(await beginFolderLink(folderOf().handle(), store, { confirmOpen })).toBeNull()
    expect(confirmOpen).toHaveBeenCalledWith('Linked')
    expect(store.getState().projectName).toBe('On Screen')
    expect(store.getState().linkedFolder).toBeNull()
    expect(working()).toBe('On Screen')
  })

  it('says which folder is wrong when there is no manifest, and links nothing', async () => {
    const store = setUp()
    const files = projectToFolderFiles(sampleProject()).filter((f) => f.path !== PROJECT_MANIFEST)
    expect(await beginFolderLink(new MemoryFolder('not-a-project', files).handle(), store)).toContain('not-a-project')
    expect(store.getState().linkedFolder).toBeNull()
  })

  // an agent's most likely mistake: it wrote something the document validator rejects
  it('reports a document the validator rejects rather than throwing', async () => {
    const store = setUp()
    const dir = folderOf()
    dir.put('scene.json', '{"version":4,"parts":[{"id":"x","type":"nope"}]}')
    expect(await beginFolderLink(dir.handle(), store)).toContain('scene: parts[0]')
  })

  it('replaces nothing when the project on screen cannot be filed first', async () => {
    const store = setUp()
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage blocked')
      },
    })
    localStorage.setItem(CURRENT_DOC_KEY, 'doc-on-screen')
    expect(await beginFolderLink(folderOf().handle(), store)).toMatch(/could not be filed/)
    expect(store.getState().projectName).toBe('On Screen')
    expect(store.getState().linkedFolder).toBeNull()
    expect(working()).toBe('On Screen')
    expect(localStorage.getItem(CURRENT_DOC_KEY)).toBe('doc-on-screen')
  })

  it('is refused while the working copy holds a project this session could not open', async () => {
    localStorage.setItem(PROJECT_KEY, '{ not a project')
    loadStoredProject()
    const store = new EditorStore()
    expect(await beginFolderLink(folderOf().handle(), store)).toMatch(/could not be opened/)
    expect(store.getState().linkedFolder).toBeNull()
    expect(localStorage.getItem(PROJECT_KEY)).toBe('{ not a project')
  })

  // Opening a second folder must not write the project it opens into the first folder.
  it('lets go of the folder it was in before opening another', async () => {
    const store = setUp()
    const first = folderOf(sampleProject(), 'first')
    expect(await beginFolderLink(first.handle(), store)).toBeNull()
    const firstManifest = first.text(PROJECT_MANIFEST)
    const other = folderOf({ ...sampleProject(), name: 'Other' }, 'second')
    expect(await beginFolderLink(other.handle(), store)).toBeNull()
    store.commit('Add group', {
      ...store.getState().scene,
      parts: [group('after-switch')],
    })
    await syncFolderNow()
    expect(first.text(PROJECT_MANIFEST)).toBe(firstManifest)
    expect(first.text('scene.json')).not.toContain('after-switch')
    expect(other.text('scene.json')).toContain('after-switch')
  })

  // The ordering that makes the above hold even for a sync round still in flight on the first folder:
  // by the time the new document reaches the store, the first folder must already be let go of, so a
  // round resuming after that sees it was cancelled instead of planning the new project against it.
  it('lets go of the old folder before the new document lands, not after', async () => {
    const store = setUp()
    expect(await beginFolderLink(folderOf(sampleProject(), 'first').handle(), store)).toBeNull()
    let followingWhenItLanded: string | null | undefined
    const stop = store.subscribe(() => {
      if (followingWhenItLanded === undefined && store.getState().projectName === 'Other') followingWhenItLanded = syncedFolderPath()
    })
    expect(await beginFolderLink(folderOf({ ...sampleProject(), name: 'Other' }, 'second').handle(), store)).toBeNull()
    stop()
    expect(followingWhenItLanded).toBeNull()
  })
})

describe('a linked folder is kept in step both ways', () => {
  const linked = async () => {
    const store = new EditorStore()
    const dir = folderOf()
    expect(await beginFolderLink(dir.handle(), store)).toBeNull()
    return { store, dir }
  }

  it('writes an edit made here into the folder', async () => {
    const { store, dir } = await linked()
    store.commit('Add group', {
      ...store.getState().scene,
      parts: [group('made-here')],
    })
    await syncFolderNow()
    expect(dir.text('scene.json')).toContain('made-here')
  })

  it('loads an edit made in the folder, keeping the scene on screen when it was not that one', async () => {
    const { store, dir } = await linked()
    store.commit('Add group', {
      ...store.getState().scene,
      parts: [group('made-here')],
    })
    await syncFolderNow()
    const manifest = JSON.parse(dir.text(PROJECT_MANIFEST)!)
    manifest.name = 'Renamed By Agent'
    dir.put(PROJECT_MANIFEST, JSON.stringify(manifest, null, 2))
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await syncFolderNow()
    expect(store.getState().projectName).toBe('Renamed By Agent')
    expect(store.canUndo).toBe(true)
  })

  it('holds a file changed in both places until the user picks, then writes the pick', async () => {
    const { store, dir } = await linked()
    store.commitProgram('Mine', {
      source: 'VAR_OUTPUT\n  Mine : BOOL;\nEND_VAR\n',
    })
    dir.put('plc/program.st', 'VAR_OUTPUT\n  Theirs : BOOL;\nEND_VAR\n')
    await syncFolderNow()
    expect(store.getState().folderConflict).toEqual(['plc/program.st'])
    expect(dir.text('plc/program.st')).toContain('Theirs')
    await resolveFolderConflict('mine')
    expect(dir.text('plc/program.st')).toContain('Mine')
    expect(store.getState().folderConflict).toBeNull()
  })

  it('names the files the manifest ignores, as a note that does not stop the sync', async () => {
    const dir = folderOf()
    dir.put('tests/smoke.test.json', '{}')
    const store = new EditorStore()
    expect(await beginFolderLink(dir.handle(), store)).toBeNull()
    expect(store.getState().folderNote).toContain('tests/smoke.test.json')
    expect(store.getState().folderError).toBeNull()
  })

  it('Save to Folder writes the project on screen and keeps it in step, without opening anything', async () => {
    const store = new EditorStore()
    store.loadProject({ ...sampleProject(), name: 'On Screen' })
    const dir = new MemoryFolder('fresh')
    expect(await saveProjectToFolderHandle(dir.handle(), store)).toBeNull()
    expect(JSON.parse(dir.text(PROJECT_MANIFEST)!).name).toBe('On Screen')
    expect(store.getState().saveNotice?.title).toBe('Saved to folder')
    store.commit('Add group', {
      ...store.getState().scene,
      parts: [group('later')],
    })
    await syncFolderNow()
    expect(dir.text('scene.json')).toContain('later')
  })

  // Save (Ctrl+S) in the browser with a linked folder: the folder is where the work is, so that is what
  // Save writes and names - not "Saved in this browser", and not a desktop-only picker.
  it('Save writes into the linked folder at once and says so', async () => {
    const { store, dir } = await linked()
    store.commit('Add group', { ...store.getState().scene, parts: [group('pressed-save')] })
    await saveProject(store)
    expect(dir.text('scene.json')).toContain('pressed-save')
    expect(store.getState().saveNotice?.title).toBe('Saved')
    expect(store.getState().saveNotice?.message).toBe('All changes are in the folder "my-factory".')
  })

  it('stops writing once unlinked', async () => {
    const { store, dir } = await linked()
    unlinkProjectFolder(store)
    expect(store.getState().folderPath).toBeNull()
    expect(store.getState().linkedFolder).toBeNull()
    store.commit('Add group', {
      ...store.getState().scene,
      parts: [group('after-unlink')],
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(dir.text('scene.json')).not.toContain('after-unlink')
  })
})

// ── surviving a reload ───────────────────────────────────────────────────────────────────────────
//
// A reload cannot be staged in-process (the module state is what a reload clears), so these drive the
// two halves the boot path actually calls - remember on link, recall on restore - against a handle
// that answers the permission questions a real one would.
describe('surviving a reload', () => {
  const DOC = 'doc-linked'
  const permissioned = (dir: MemoryFolder, query: PermissionState, request: PermissionState = query) => {
    const queryPermission = vi.fn(() => Promise.resolve(query))
    const requestPermission = vi.fn(() => Promise.resolve(request))
    return {
      handle: dir.handle('', { queryPermission, requestPermission }),
      queryPermission,
      requestPermission,
    }
  }
  const setUp = (): EditorStore => {
    localStorage.setItem(CURRENT_DOC_KEY, DOC)
    const store = new EditorStore()
    store.loadProject({ ...sampleProject(), name: 'On Screen' })
    return store
  }

  it('resumes a remembered folder when the browser still holds permission to edit it', async () => {
    const store = setUp()
    const dir = folderOf()
    const p = permissioned(dir, 'granted')
    handleMemory.set(DOC, { handle: p.handle, signature: '', baseline: null })
    await restoreFolderLink(store, null)
    expect(p.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(store.getState().folderPath).toBe('my-factory')
    expect(store.getState().pausedFolder).toBeNull()
    // resumed means in sync: an edit reaches the folder
    store.commit('Add group', {
      ...store.getState().scene,
      parts: [group('after-reload')],
    })
    await syncFolderNow()
    expect(dir.text('scene.json')).toContain('after-reload')
  })

  // The restore must not adopt: adoption files the outgoing project and mints a library record, which
  // on a reload would be the same document filed against itself once per refresh.
  it('does not re-file the document it is already on', async () => {
    const store = setUp()
    handleMemory.set(DOC, {
      handle: permissioned(folderOf(), 'granted').handle,
      signature: '',
      baseline: null,
    })
    await restoreFolderLink(store, null)
    expect(localStorage.getItem(CURRENT_DOC_KEY)).toBe(DOC)
  })

  // The baselines answer "did the folder move while the tab was closed?" file by file. When it did not,
  // re-applying would tear down and rebuild the scene the page has just built, once per reload.
  /** linked, synced once, then "reloaded": the engine forgets everything, the remembered row stays */
  const linkedThenReloaded = async (dir: MemoryFolder) => {
    const store = setUp()
    expect(await beginFolderLink(dir.handle(), store)).toBeNull()
    const remembered = handleMemory.get(DOC)
    expect(remembered?.baseline, 'the first round remembered its baselines').toBeTruthy()
    resetFolderSyncForTests()
    handleMemory.set(DOC, {
      ...remembered!,
      handle: permissioned(dir, 'granted').handle,
    })
    return store
  }

  it('applies nothing when neither side moved while the tab was closed', async () => {
    const dir = folderOf()
    const store = await linkedThenReloaded(dir)
    const refresh = vi.spyOn(store, 'refreshProject')
    await restoreFolderLink(store, null)
    expect(refresh).not.toHaveBeenCalled()
    expect(store.getState().folderPath).toBe('my-factory')
  })

  it('loads what changed in the folder while the tab was closed', async () => {
    const dir = folderOf()
    const store = await linkedThenReloaded(dir)
    dir.put('plc/program.st', 'VAR_OUTPUT\n  WhileClosed : BOOL;\nEND_VAR\n')
    await restoreFolderLink(store, null)
    expect(store.getState().stProgram).toContain('WhileClosed')
  })

  // A link remembered before the sync was two-way carries no baselines. Such a link followed "the disk wins",
  // so it resumes that way once: the folder loads, and nothing on screen is written over it.
  it('resumes a link from the read-only days with the folder winning', async () => {
    const store = setUp()
    const dir = folderOf()
    handleMemory.set(DOC, {
      handle: permissioned(dir, 'granted').handle,
      signature: 'old',
    })
    const before = new Map(dir.files)
    await restoreFolderLink(store, null)
    expect(store.getState().projectName).toBe('Linked')
    for (const [path, f] of before) expect(dir.text(path)).toBe(f.text)
  })

  it('offers Reconnect instead of resuming when permission needs a gesture', async () => {
    const store = setUp()
    const p = permissioned(folderOf(), 'prompt', 'granted')
    handleMemory.set(DOC, { handle: p.handle, signature: '', baseline: null })
    await restoreFolderLink(store, null)
    // paused is not in sync: nothing is written or loaded until the user says so
    expect(store.getState().pausedFolder).toBe('my-factory')
    expect(store.getState().folderPath).toBeNull()
    expect(store.getState().projectName).toBe('On Screen')
    expect(p.requestPermission).not.toHaveBeenCalled() // a page load is not a user gesture
    expect(hasPausedFolder()).toBe(true)
  })

  it('reconnects on a gesture and keeps the folder in step again', async () => {
    const store = setUp()
    const p = permissioned(folderOf(), 'prompt', 'granted')
    handleMemory.set(DOC, { handle: p.handle, signature: '', baseline: null })
    await restoreFolderLink(store, null)
    expect(await reconnectProjectFolder(store, null)).toBeNull()
    expect(p.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(store.getState().folderPath).toBe('my-factory')
    expect(store.getState().pausedFolder).toBeNull()
  })

  it('forgets the folder when the user refuses the prompt, rather than asking again every boot', async () => {
    const store = setUp()
    handleMemory.set(DOC, {
      handle: permissioned(folderOf(), 'prompt', 'denied').handle,
      signature: '',
    })
    await restoreFolderLink(store, null)
    expect(await reconnectProjectFolder(store, null)).toBeNull()
    expect(store.getState().pausedFolder).toBeNull()
    expect(store.getState().folderPath).toBeNull()
    expect(handleMemory.has(DOC)).toBe(false)
  })

  it('forgets a handle the browser has already denied', async () => {
    const store = setUp()
    handleMemory.set(DOC, {
      handle: permissioned(folderOf(), 'denied').handle,
      signature: '',
    })
    await restoreFolderLink(store, null)
    expect(store.getState().folderPath).toBeNull()
    expect(store.getState().pausedFolder).toBeNull()
    expect(handleMemory.has(DOC)).toBe(false)
  })

  it('does nothing when this document never linked a folder', async () => {
    const store = setUp()
    await restoreFolderLink(store, null)
    expect(store.getState().folderPath).toBeNull()
    expect(store.getState().pausedFolder).toBeNull()
    expect(store.getState().projectName).toBe('On Screen')
  })

  // The handle belongs to a document, so a folder linked under one project must not be picked up by
  // another. That is why the memory is keyed by document rather than a single "last folder".
  it('does not hand one document the folder another one linked', async () => {
    const store = setUp()
    handleMemory.set('some-other-doc', {
      handle: permissioned(folderOf(), 'granted').handle,
      signature: '',
      baseline: null,
    })
    await restoreFolderLink(store, null)
    expect(store.getState().folderPath).toBeNull()
    expect(store.getState().projectName).toBe('On Screen')
  })

  it('remembers the folder against the document the link opened, with its baselines', async () => {
    const store = setUp()
    const dir = folderOf()
    await beginFolderLink(dir.handle(), store)
    // adoption moves the current document id when there is a library, and the folder must follow it
    // there; without one (this Node env) the id stays - either way it is the id after the link
    const openedDoc = localStorage.getItem(CURRENT_DOC_KEY)!
    expect((handleMemory.get(openedDoc)?.handle as DirLike | undefined)?.name).toBe('my-factory')
    expect(handleMemory.get(openedDoc)?.baseline).toBeTruthy()
  })

  it('forgets it on unlink, so the next boot does not offer it again', async () => {
    const store = setUp()
    handleMemory.set(DOC, {
      handle: permissioned(folderOf(), 'granted').handle,
      signature: '',
      baseline: null,
    })
    await restoreFolderLink(store, null)
    expect(store.getState().folderPath).toBe('my-factory')
    unlinkProjectFolder(store)
    expect(handleMemory.has(DOC)).toBe(false)
    expect(store.getState().folderPath).toBeNull()
    expect(store.getState().pausedFolder).toBeNull()
  })

  // React's dev StrictMode double-invokes effects, and the restore is async: without its own guard
  // two of them are in flight before either has started following.
  it('is safe to call twice at once', async () => {
    const store = setUp()
    const p = permissioned(folderOf(), 'granted')
    handleMemory.set(DOC, { handle: p.handle, signature: '', baseline: null })
    await Promise.all([restoreFolderLink(store, null), restoreFolderLink(store, null)])
    expect(p.queryPermission).toHaveBeenCalledTimes(1)
    expect(store.getState().folderPath).toBe('my-factory')
  })
})
