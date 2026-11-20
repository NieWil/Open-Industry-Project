// The desktop's two-way project folder (projectFolderSync.ts), driven against an in-memory stand-in for
// the Electron shell. The fake does what apps/desktop/projectFolderIo.cjs does (a fingerprint, reads,
// guarded writes) over a Map. So every rule the engine relies on (a write goes through only if the file
// still holds what was last read) is the real rule, not a mock that agrees with whatever it is asked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detachProjectFolder,
  flushFolderSyncNow,
  noteForUnreferenced,
  resetFolderSyncForTests,
  resolveFolderConflict,
  restoreFolderSync,
  saveIntoFolder,
  partSourceInFolder,
  saveToFolderNow,
  syncFolderAndReport,
  syncFolderNow,
} from './projectFolderSync'
import type { FolderRecord, FolderRecordPatch, OipProjectApi } from '../desktop/desktopProjectApi'
import { hashText } from '../../core/project/folderSync'
import { hashContents } from '../../core/hash'
import type { FolderWriteOp, FolderWriteResult } from '../../core/project/folderSync'
import { AGENT_GUIDE, PROJECT_MANIFEST, folderFilesToProject, projectToFolderFiles } from '../../core/project/projectFolder'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PartInstance } from '../../core/types'
import { EditorStore } from '../store/store'
import { CURRENT_DOC_KEY } from './documentStore'
import { startWriteBack } from './sharedProject'

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

const ROOT = 'C:\\Projects\\Line'
const DOC = 'doc-test'

/** The shell, in memory: one folder per root, a registry, and a log of every write that was applied. */
function fakeShell() {
  const disks = new Map<string, Map<string, { text: string | Uint8Array; rev: number }>>()
  const registry = new Map<string, FolderRecord>()
  const written: string[] = []
  let rev = 0
  let made = 0
  const disk = (root: string): Map<string, { text: string | Uint8Array; rev: number }> => {
    if (!disks.has(root)) disks.set(root, new Map())
    return disks.get(root)!
  }
  const apply = (root: string, ops: FolderWriteOp[]): FolderWriteResult => {
    const moved: string[] = []
    for (const op of ops) {
      const d = disk(root)
      const current = d.get(op.path)
      if (op.expect !== '*' && (current === undefined ? null : hashContents(current.text)) !== op.expect) {
        moved.push(op.path)
        continue
      }
      if (op.contents === undefined) d.delete(op.path)
      else d.set(op.path, { text: op.contents, rev: ++rev })
      written.push(op.path)
    }
    return { moved, failed: [], error: null }
  }
  const byPath = (root: string): FolderRecord | undefined => [...registry.values()].find((r) => r.path === root)
  const api: OipProjectApi = {
    pickOpenFolder: async () => null,
    pickSaveFolder: async () => null,
    readAt: async (root) =>
      disks.has(root)
        ? { root, files: [...disk(root)].map(([path, f]) => ({ path, contents: f.text })), docId: byPath(root)?.docId ?? null }
        : { root, files: [], docId: null, error: `ENOENT: ${root}` },
    signature: async (root) =>
      disks.has(root)
        ? { signature: [...disk(root)].filter(([p]) => p !== AGENT_GUIDE).map(([p, f]) => `${p}:${f.rev}`).sort().join('\n') }
        : { error: `ENOENT: ${root}` },
    write: async (root, ops) => apply(root, ops),
    writeSync: (root, ops) => apply(root, ops),
    createFolder: async (name) => {
      const root = `C:\\Documents\\Open Industry Project\\${name}${made++ ? ` (${made})` : ''}`
      disk(root)
      return { root }
    },
    attach: () => {},
    reveal: async () => '',
    recall: async (docId) => registry.get(docId) ?? null,
    folders: async () => [...registry.values()].filter((r) => r.path),
    remember: async (docId, patch: FolderRecordPatch) => void api.rememberSync(docId, patch),
    rememberSync: (docId, patch: FolderRecordPatch) => {
      const { touch: _touch, ...rest } = patch
      registry.set(docId, { ...(registry.get(docId) ?? { docId }), ...rest, docId })
      return true
    },
    detach: async (docId) => void registry.set(docId, { docId, detached: true }),
    forget: async (docId) => void registry.delete(docId),
    takePendingOpen: async () => null,
    onOpenPath: () => () => {},
  }
  return {
    api,
    registry,
    written,
    /** what an agent or an editor does: write a file directly */
    put: (root: string, path: string, text: string) => void disk(root).set(path, { text, rev: ++rev }),
    remove: (root: string, path: string) => void disk(root).delete(path),
    text: (root: string, path: string) => {
      const t = disk(root).get(path)?.text
      return typeof t === 'string' ? t : undefined
    },
    paths: (root: string) => [...disk(root).keys()].sort(),
    seed: (root: string, files: readonly { path: string; contents: string | Uint8Array }[]) => {
      for (const f of files) disk(root).set(f.path, { text: f.contents, rev: ++rev })
    },
  }
}

const RUN = 'VAR_OUTPUT\n  Run : BOOL;\nEND_VAR\n'
const group = (id: string): PartInstance => ({ id, type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} }) as PartInstance
const lineProject = (): ProjectJSON => ({
  version: PROJECT_VERSION,
  name: 'Line',
  scene: { version: SCENE_VERSION, parts: [] },
  stProgram: RUN,
})

let shell: ReturnType<typeof fakeShell>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  vi.stubGlobal('localStorage', fakeStorage())
  localStorage.setItem(CURRENT_DOC_KEY, DOC)
  shell = fakeShell()
  vi.stubGlobal('window', { oipProject: shell.api })
})

afterEach(() => {
  resetFolderSyncForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A project that lives in ROOT, opened fresh from it (the registry row a folder open leaves behind). */
async function openedFromFolder(project = lineProject()) {
  shell.seed(ROOT, projectToFolderFiles(project))
  shell.registry.set(DOC, { docId: DOC, path: ROOT, baseline: null })
  const store = new EditorStore()
  store.loadProject(project)
  const guard = { leaveForSceneSwap: vi.fn() }
  await restoreFolderSync(store, guard)
  shell.written.length = 0
  return { store, guard }
}

describe('the note for files a load ignored', () => {
  it('names the array each kind of file joins through', () => {
    const part = noteForUnreferenced(['parts/oip.diverter/behavior.js', 'parts/oip.diverter/manifest.json'])!
    expect(part).toContain('"packages"')
    expect(part).not.toContain('"program"')
    const mixed = noteForUnreferenced(['plc/Latch.st', 'tests/smoke.test.json'])!
    expect(mixed).toContain('"program"')
    expect(mixed).toContain('"tests"')
    expect(mixed).not.toContain('"packages"')
  })

  it('offers no array for a stale scene, which is not meant to be listed', () => {
    expect(noteForUnreferenced(['scenes/old-line.scene.json'])).not.toMatch(/"(packages|program|tests)"/)
    expect(noteForUnreferenced([])).toBeNull()
  })
})

describe('opening a folder', () => {
  it('agrees with the folder and writes nothing', async () => {
    const { store } = await openedFromFolder()
    await syncFolderNow()
    expect(shell.written).toEqual([])
    expect(store.getState().folderPath).toBe(ROOT)
    expect(store.getState().linkedFolder).toBe('Line')
    expect(shell.registry.get(DOC)!.baseline).not.toBeNull()
  })

  // A folder in the one-file layout must not be agreed with as it stands: a later program edit would write only the
  // per-POU files, which its manifest does not name, and the next open would read the stale program.st.
  it('lays out a folder whose program is one program.st (formats 4-6) in plc/, and a later edit survives reopening', async () => {
    const program = `FUNCTION_BLOCK Latch\nVAR_INPUT\n  S : BOOL;\nEND_VAR\nEND_FUNCTION_BLOCK\n\n${RUN}`
    const project = { ...lineProject(), stProgram: program }
    const legacy = projectToFolderFiles(project).map((f) => {
      if (f.path === 'plc/program.st') return { path: 'program.st', contents: f.contents }
      if (f.path !== PROJECT_MANIFEST) return f
      const { program: _listed, ...manifest } = JSON.parse(f.contents as string) as Record<string, unknown>
      return { path: f.path, contents: JSON.stringify({ ...manifest, version: 6, stProgram: 'program.st' }, null, 2) + '\n' }
    })
    shell.seed(ROOT, legacy)
    shell.registry.set(DOC, { docId: DOC, path: ROOT, baseline: null })
    const sceneBefore = shell.text(ROOT, 'scene.json')
    const store = new EditorStore()
    store.loadProject(project)
    await restoreFolderSync(store, null)
    await syncFolderNow()
    expect(shell.paths(ROOT)).not.toContain('program.st')
    expect(JSON.parse(shell.text(ROOT, PROJECT_MANIFEST)!)).toMatchObject({ version: PROJECT_VERSION, program: ['plc/Latch.st', 'plc/program.st'] })
    expect(shell.text(ROOT, 'plc/program.st')).toBe(RUN)
    expect(shell.text(ROOT, 'scene.json')).toBe(sceneBefore)

    store.setStProgram(program.replace('S : BOOL', 'Set : BOOL'))
    await syncFolderNow()
    const reopened = folderFilesToProject((await shell.api.readAt(ROOT))!.files)
    expect(reopened.ok && reopened.project.stProgram).toContain('Set : BOOL')
  })

  // An agent's JSON is not the app's JSON. Opening its folder must not reformat every file it wrote.
  it('leaves files alone that the app would only have formatted differently', async () => {
    const files = projectToFolderFiles(lineProject()).map((f) =>
      f.path === PROJECT_MANIFEST ? { ...f, contents: JSON.stringify(JSON.parse(f.contents as string), null, 4) } : f,
    )
    shell.seed(ROOT, files)
    shell.registry.set(DOC, { docId: DOC, path: ROOT, baseline: null })
    const store = new EditorStore()
    store.loadProject(lineProject())
    await restoreFolderSync(store, null)
    await syncFolderNow()
    expect(shell.written).toEqual([])
  })
})

describe('an edit made in the app', () => {
  it('is written to the folder, and only the files it touched', async () => {
    const { store } = await openedFromFolder()
    store.commit('Add group', { ...store.getState().scene, parts: [group('made-here')] })
    await syncFolderNow()
    expect(shell.written.filter((p) => p !== AGENT_GUIDE)).toEqual(['scene.json'])
    expect(shell.text(ROOT, 'scene.json')).toContain('made-here')
    expect(shell.written).toContain(AGENT_GUIDE) // the guide follows any real write
  })

  it('waits for edits to pause before writing', async () => {
    const { store } = await openedFromFolder()
    store.commit('Add group', { ...store.getState().scene, parts: [group('a')] })
    await vi.advanceTimersByTimeAsync(300)
    expect(shell.written).toEqual([])
    await vi.advanceTimersByTimeAsync(700)
    expect(shell.text(ROOT, 'scene.json')).toContain('"a"')
  })

  it('goes out synchronously as the window closes', async () => {
    const { store } = await openedFromFolder()
    store.commit('Add group', { ...store.getState().scene, parts: [group('last-second')] })
    flushFolderSyncNow()
    expect(shell.text(ROOT, 'scene.json')).toContain('last-second')
    expect(shell.registry.get(DOC)!.baseline!.mine['scene.json']).toBe(hashText(shell.text(ROOT, 'scene.json')!))
  })
})

describe('an edit made in the folder', () => {
  it('is loaded, and not written back', async () => {
    const { store } = await openedFromFolder()
    shell.put(ROOT, 'plc/program.st', RUN.replace('Run', 'Ready'))
    await syncFolderNow()
    expect(store.getState().stProgram).toContain('Ready')
    expect(shell.written).toEqual([])
  })

  it('keeps the scene on screen - undo, selection and all - when only the name changed', async () => {
    const { store, guard } = await openedFromFolder()
    store.commit('Add group', { ...store.getState().scene, parts: [group('made-here')] })
    store.selectMany(['made-here'])
    await syncFolderNow()
    const manifest = JSON.parse(shell.text(ROOT, PROJECT_MANIFEST)!) as { name: string }
    shell.put(ROOT, PROJECT_MANIFEST, JSON.stringify({ ...manifest, name: 'Renamed outside' }, null, 2) + '\n')
    await syncFolderNow()
    expect(store.getState().projectName).toBe('Renamed outside')
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['made-here'])
    expect(store.canUndo).toBe(true)
    expect(store.getState().selectedIds).toEqual(['made-here'])
    expect(guard.leaveForSceneSwap).not.toHaveBeenCalled()
  })

  it('is reported to an agent that asks for a round: which files loaded, and that the load stopped the run', async () => {
    const { store, guard } = await openedFromFolder()
    guard.leaveForSceneSwap.mockImplementation(() => store.setRunning(false))
    store.setRunning(true)
    shell.put(ROOT, 'plc/program.st', RUN.replace('Run', 'Ready'))
    expect(await syncFolderAndReport()).toEqual({ loaded: ['plc/program.st'], stoppedRun: true })
    expect(await syncFolderAndReport()).toEqual({ loaded: [], stoppedRun: false })
  })

  it("names a library part's part.js, which it never loads, to the agent tools", async () => {
    const pkg = {
      format: PACKAGE_FORMAT,
      id: 'user.pusher',
      name: 'Pusher',
      params: {},
      behavior: 'definePart({ step() {} })',
      geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0.5, 0] }], joints: [] },
    } as unknown as PartPackage
    // the library drops a definition that does not validate, and a project keeps only the ones its placed parts use
    expect(validatePartPackage(pkg)).toEqual([])
    const placed = { id: 'p1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params: {} } as PartInstance
    await openedFromFolder({ ...lineProject(), scene: { version: SCENE_VERSION, parts: [placed] }, packages: [pkg] })
    expect(partSourceInFolder('user.pusher')).toBeNull()
    shell.put(ROOT, 'parts/user.pusher/part.js', 'definePart({ manifest: {} })\n')
    await syncFolderNow()
    expect(partSourceInFolder('user.pusher')).toEqual({ root: ROOT, path: 'parts/user.pusher/part.js', text: 'definePart({ manifest: {} })\n' })
    expect(partSourceInFolder('user.other')).toBeNull()
  })

  it('carries both directions in one round when they touch different files', async () => {
    const { store } = await openedFromFolder()
    store.commit('Add group', { ...store.getState().scene, parts: [group('made-here')] })
    shell.put(ROOT, 'plc/program.st', RUN.replace('Run', 'Ready'))
    await syncFolderNow()
    expect(shell.text(ROOT, 'scene.json')).toContain('made-here')
    expect(shell.text(ROOT, 'plc/program.st')).toContain('Ready')
    expect(store.getState().stProgram).toContain('Ready')
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['made-here'])
  })

  it('holds everything while the folder does not load, and catches up once it does', async () => {
    const { store } = await openedFromFolder()
    const manifest = shell.text(ROOT, PROJECT_MANIFEST)!
    shell.put(ROOT, PROJECT_MANIFEST, '{ "half-written": ')
    store.commit('Add group', { ...store.getState().scene, parts: [group('made-here')] })
    await syncFolderNow()
    expect(store.getState().folderError).toMatch(/project\.json/)
    expect(shell.written).toEqual([])
    shell.put(ROOT, PROJECT_MANIFEST, manifest)
    await syncFolderNow()
    expect(store.getState().folderError).toBeNull()
    expect(shell.text(ROOT, 'scene.json')).toContain('made-here')
  })

  // The folder became an older multi-scene project under the app (a `git checkout` of an old commit, say). Taking only
  // the scene that was active would make the next write delete the others' files, so the round holds instead.
  it('holds, loading and writing nothing, when the folder turns into a multi-scene project', async () => {
    const { store, guard } = await openedFromFolder()
    shell.put(ROOT, 'scenes/line.scene.json', JSON.stringify({ version: SCENE_VERSION, parts: [group('old-line')] }))
    shell.put(ROOT, 'scenes/pack.scene.json', JSON.stringify({ version: SCENE_VERSION, parts: [group('old-pack')] }))
    shell.put(
      ROOT,
      PROJECT_MANIFEST,
      JSON.stringify({
        version: 3,
        name: 'Line',
        activeScene: 0,
        scenes: [
          { id: 'line', name: 'Line', scene: 'scenes/line.scene.json' },
          { id: 'pack', name: 'Pack', scene: 'scenes/pack.scene.json' },
        ],
      }),
    )
    store.commit('Add group', { ...store.getState().scene, parts: [group('made-here')] })
    await syncFolderNow()
    expect(store.getState().folderError).toMatch(/holds 2 scenes/)
    expect(shell.written).toEqual([])
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['made-here']) // nothing loaded over it
    expect(store.getState().projectName).toBe('Line')
    expect(guard.leaveForSceneSwap).not.toHaveBeenCalled()
    // and it stays held while the folder stays that way
    await syncFolderNow()
    expect(shell.written).toEqual([])
    expect(shell.paths(ROOT)).toContain('scenes/pack.scene.json')
  })
})

describe("a shared project's folder", () => {
  // the tab is in the room of a project of this browser's own (project/sharedProject.ts)
  const share = (store: EditorStore, room = 'e-room') => {
    localStorage.setItem('oip-web/shared-projects', JSON.stringify([{ docId: DOC, room, project: 'Line', server: null }]))
    vi.stubGlobal('location', { href: `http://app.test/app/?room=${room}` })
    store.setCollabMode(true)
  }

  it('follows the room: an edit made there reaches the folder, under the project name', async () => {
    const { store } = await openedFromFolder()
    share(store)
    startWriteBack(store, { docId: DOC, room: 'e-room', project: 'Line', server: null })
    store.commit('Add group', { ...store.getState().scene, parts: [group('made-in-the-room')] })
    await vi.advanceTimersByTimeAsync(1100) // the write-back trails an edit by a second
    await syncFolderNow()
    expect(shell.text(ROOT, 'scene.json')).toContain('made-in-the-room')
    expect(shell.text(ROOT, PROJECT_MANIFEST)).toContain('"Line"')
  })

  it('waits on a change made to the folder while shared, loading and writing nothing, and takes it once sharing stops', async () => {
    const { store } = await openedFromFolder()
    share(store)
    shell.put(ROOT, 'plc/program.st', RUN.replace('Run', 'Ready'))
    store.commit('Add group', { ...store.getState().scene, parts: [group('meanwhile')] })
    await syncFolderNow()
    expect(store.getState().stProgram).not.toContain('Ready')
    expect(shell.written).toEqual([])
    expect(store.getState().folderError).toMatch(/changed while the project is shared/)
    store.setCollabMode(false) // Stop sharing: the project is the user's alone again
    await syncFolderNow()
    expect(store.getState().stProgram).toContain('Ready')
  })

  it("writes nothing for someone else's room", async () => {
    const { store } = await openedFromFolder()
    vi.stubGlobal('location', { href: 'http://app.test/app/?room=e-theirs' })
    store.setCollabMode(true)
    store.commit('Add group', { ...store.getState().scene, parts: [group('not-mine')] })
    await syncFolderNow()
    expect(shell.text(ROOT, 'scene.json')).not.toContain('not-mine')
  })
})

describe('the same file changed in both places', () => {
  const clash = async () => {
    const opened = await openedFromFolder()
    opened.store.commitProgram('Edit', { source: RUN.replace('Run', 'Mine') })
    shell.put(ROOT, 'plc/program.st', RUN.replace('Run', 'Theirs'))
    await syncFolderNow()
    return opened
  }

  it('is a conflict: nothing is written or loaded until the user picks', async () => {
    const { store } = await clash()
    expect(store.getState().folderConflict).toEqual(['plc/program.st'])
    expect(shell.text(ROOT, 'plc/program.st')).toContain('Theirs')
    expect(store.getState().stProgram).toContain('Mine')
  })

  it('"keep my version" writes it', async () => {
    const { store } = await clash()
    await resolveFolderConflict('mine')
    expect(store.getState().folderConflict).toBeNull()
    expect(shell.text(ROOT, 'plc/program.st')).toContain('Mine')
  })

  it('"use folder version" loads it', async () => {
    const { store } = await clash()
    await resolveFolderConflict('disk')
    expect(store.getState().folderConflict).toBeNull()
    expect(store.getState().stProgram).toContain('Theirs')
    expect(shell.text(ROOT, 'plc/program.st')).toContain('Theirs')
  })

  // The window the guard closes: the engine read the folder, then the agent wrote the same file before
  // the engine's write arrived. The write must be refused, not overwrite the agent's.
  it('never overwrites a file someone wrote after the app last read it', async () => {
    const { store } = await openedFromFolder()
    const write = shell.api.write
    shell.api.write = async (root, ops) => {
      shell.put(ROOT, 'plc/program.st', RUN.replace('Run', 'Agent'))
      shell.api.write = write
      return write(root, ops)
    }
    store.commitProgram('Edit', { source: RUN.replace('Run', 'Mine') })
    await syncFolderNow()
    expect(shell.text(ROOT, 'plc/program.st')).toContain('Agent')
    await syncFolderNow()
    expect(store.getState().folderConflict).toEqual(['plc/program.st'])
  })
})

// The shelf opens a folder project's stored copy when its folder cannot be read. That copy can lag the
// folder by a few seconds of edits, so it must never be written over the folder: the folder wins, whole,
// as soon as it is readable.
describe('a stand-in opened because the folder could not be read', () => {
  const standIn = async (disk: ProjectJSON, stale: ProjectJSON) => {
    shell.seed(ROOT, projectToFolderFiles(disk))
    shell.registry.set(DOC, { docId: DOC, path: ROOT, baseline: null, trustDisk: true })
    const store = new EditorStore()
    store.loadProject(stale)
    await restoreFolderSync(store, null)
    return { store }
  }

  it('loads the folder whole, and writes none of the older copy back', async () => {
    const newer = lineProject()
    newer.stProgram = RUN.replace('Run', 'Newer')
    const { store } = await standIn(newer, lineProject())
    expect(store.getState().stProgram).toContain('Newer')
    expect(shell.written).toEqual([])
    expect(shell.registry.get(DOC)!.trustDisk).toBe(false)
  })

  it('holds while the folder still does not load, then takes it', async () => {
    const newer = lineProject()
    newer.stProgram = RUN.replace('Run', 'Newer')
    const files = projectToFolderFiles(newer)
    const manifest = files.find((f) => f.path === PROJECT_MANIFEST)!.contents as string
    shell.seed(ROOT, files.map((f) => (f.path === PROJECT_MANIFEST ? { ...f, contents: '{ broken' } : f)))
    shell.registry.set(DOC, { docId: DOC, path: ROOT, baseline: null, trustDisk: true })
    const store = new EditorStore()
    store.loadProject(lineProject())
    await restoreFolderSync(store, null)
    expect(store.getState().folderError).toMatch(/project\.json/)
    expect(shell.written).toEqual([])
    shell.put(ROOT, PROJECT_MANIFEST, manifest)
    await syncFolderNow()
    expect(store.getState().stProgram).toContain('Newer')
    expect(shell.written).toEqual([])
  })
})

describe('a project with no folder yet', () => {
  const appOnly = async (row?: FolderRecord) => {
    if (row) shell.registry.set(DOC, row)
    const store = new EditorStore()
    store.loadProject(lineProject())
    await restoreFolderSync(store, null)
    return store
  }

  it('gets one on its first real edit, and says where', async () => {
    const store = await appOnly()
    store.commit('Add group', { ...store.getState().scene, parts: [group('first')] })
    await vi.waitFor(() => expect(store.getState().folderPath).not.toBeNull())
    const root = store.getState().folderPath!
    expect(root).toMatch(/Open Industry Project\\Line$/)
    expect(shell.text(root, 'scene.json')).toContain('first')
    expect(shell.registry.get(DOC)!.path).toBe(root)
    expect(store.getState().saveNotice?.message).toContain(root)
  })

  it('does not get one for the saves the app makes on its own', async () => {
    const store = await appOnly()
    store.persistProject()
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.getState().folderPath).toBeNull()
  })

  it('does not get one after the user unlinked it on purpose', async () => {
    const store = await appOnly({ docId: DOC, detached: true })
    store.commit('Add group', { ...store.getState().scene, parts: [group('first')] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.getState().folderPath).toBeNull()
  })
})

describe('saving into a folder and unlinking', () => {
  it('Save to Folder writes everything and keeps it in step from then on', async () => {
    const store = new EditorStore()
    store.loadProject(lineProject())
    const target = 'D:\\Elsewhere'
    shell.put(target, PROJECT_MANIFEST, '{"old":true}')
    expect(await saveIntoFolder(store, null, target, { replace: true })).toBeNull()
    expect(JSON.parse(shell.text(target, PROJECT_MANIFEST)!).name).toBe('Line')
    shell.written.length = 0
    store.commit('Add group', { ...store.getState().scene, parts: [group('later')] })
    await syncFolderNow()
    expect(shell.text(target, 'scene.json')).toContain('later')
  })

  it('Unlink stops syncing and is remembered', async () => {
    const { store } = await openedFromFolder()
    detachProjectFolder(store)
    expect(store.getState().folderPath).toBeNull()
    await vi.waitFor(() => expect(shell.registry.get(DOC)?.detached).toBe(true))
    store.commit('Add group', { ...store.getState().scene, parts: [group('after')] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(shell.written).toEqual([])
  })

  it('says so, and stops looking, when the folder is gone', async () => {
    const { store } = await openedFromFolder()
    shell.api.signature = async () => ({ error: 'ENOENT: no such directory' })
    await syncFolderNow()
    expect(store.getState().folderError).toMatch(/Lost access/)
  })
})

// Ctrl+S on the desktop (file.save, via editor/project/saveProject.ts). The folder is already written as you work, so Save means
// the folder has everything at this moment. It must only say "saved" when that is true.
describe('saving on purpose', () => {
  it('writes what is pending at once, without waiting for the edits to pause', async () => {
    const { store } = await openedFromFolder()
    store.commit('Add group', { ...store.getState().scene, parts: [group('pressed-save')] })
    expect(await saveToFolderNow(store)).toBe('saved')
    expect(shell.text(ROOT, 'scene.json')).toContain('pressed-save')
  })

  it('reports a conflict rather than claiming it saved', async () => {
    const { store } = await openedFromFolder()
    store.commitProgram('Edit', { source: RUN.replace('Run', 'Mine') })
    shell.put(ROOT, 'plc/program.st', RUN.replace('Run', 'Theirs'))
    expect(await saveToFolderNow(store)).toBe('conflict')
    expect(shell.text(ROOT, 'plc/program.st')).toContain('Theirs')
  })

  it('reports a folder that is gone rather than claiming it saved', async () => {
    const { store } = await openedFromFolder()
    shell.api.signature = async () => ({ error: 'ENOENT' })
    expect(await saveToFolderNow(store)).toBe('failed')
  })

  it('gives a project with no folder its default one, without asking', async () => {
    const store = new EditorStore()
    store.loadProject(lineProject())
    await restoreFolderSync(store, null)
    expect(await saveToFolderNow(store)).toBe('created')
    expect(store.getState().folderPath).toMatch(/Open Industry Project\\Line$/)
  })

  it('asks where for a project the user unlinked on purpose', async () => {
    shell.registry.set(DOC, { docId: DOC, detached: true })
    const store = new EditorStore()
    store.loadProject(lineProject())
    await restoreFolderSync(store, null)
    expect(await saveToFolderNow(store)).toBe('needsFolder')
    expect(store.getState().folderPath).toBeNull()
  })
})
