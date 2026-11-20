import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCENE_VERSION } from '../../core/types'
import type { SceneJSON } from '../../core/types'
import { createPart, serializeScene } from '../../core/scene/scene'
import type { PartPackage } from '../../core/parts/partPackage'
import { PROJECT_VERSION, serializeProject, validateProject } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { buildPackage } from '../../sim/buildPackage'
import { projectToOipBytes } from '../../core/project/projectArchive'
import {
  PROJECT_KEY,
  SPLIT_OFF_KEY,
  SUPERSEDED_MESSAGE,
  adoptImportedProject,
  assembleProject,
  clearParkedSplitOff,
  discardUnopenedProject,
  importProjectData,
  importProjectText,
  loadStoredProject,
  noteWorkingCopyWrite,
  onWorkingCopySuperseded,
  parkSplitOff,
  readParkedSplitOff,
  saveStoredProject,
  unopenedProject,
  unparkSplitOff,
  workingCopyRefusal,
  workingCopySuperseded,
} from './projectFile'
import { EditorStore } from '../store/store'
import { markLocalAssetStoredForTest, resetLocalAssetsForTest } from './localAssets'
import { bytesToBase64 } from '../../core/parts/partAssets'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// A Map-backed localStorage stub (the vitest env is 'node', so there's none). projectFile + the
// stProgram reader it calls both go through globalThis.localStorage.
class LocalStorageStub {
  private m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
}

const LEGACY_SCENE_KEY = 'oip-web/autosave'
const LEGACY_USERPKG_KEY = 'oip-web/user-packages'
const ST_PROGRAM_KEY = 'oip-web/st-program'

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new LocalStorageStub()
})
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

function ls(): Storage {
  return globalThis.localStorage
}

/** What a browser throws when localStorage is full - a DOMException, which the node env doesn't have, so
 *  build the shape saveStoredProject sniffs (name + code 22). */
function quotaError(): Error {
  const e = new Error('exceeded the quota')
  e.name = 'QuotaExceededError'
  ;(e as Error & { code: number }).code = 22
  return e
}

function samplePackage(id = 'acme.widget'): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Widget',
    params: {},
    behavior: 'definePart(() => ({}))',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
}

function sampleScene(): SceneJSON {
  // a generic scene occupant (group = always-valid, package-free); id kept as rc_1 so the id-based
  // assertions below read unchanged
  return { version: SCENE_VERSION, parts: [createPart('group', 'rc_1', [0, 0, 0])] }
}

describe('assembleProject', () => {
  it('folds scene packages + userPackages into one deduped library, authored copy winning', () => {
    const scenePkg = { ...samplePackage(), name: 'Stale snapshot' } // the scene's embedded (older) copy
    const authored = { ...samplePackage(), name: 'Live authored' } // userPackages (latest) copy
    const scene: SceneJSON = { ...sampleScene(), packages: [scenePkg] }
    const project = assembleProject(scene, 'PROGRAM P\nEND_PROGRAM', [authored], 'Factory A')
    expect(project.version).toBe(PROJECT_VERSION)
    expect(project.name).toBe('Factory A')
    expect(project.packages).toHaveLength(1)
    expect(project.packages![0]!.name).toBe('Live authored') // authored wins the dedupe
    expect(project.scene.parts.map((p) => p.id)).toEqual(['rc_1'])
    expect(project.stProgram).toContain('PROGRAM P')
  })

  it('omits the library + program when there are none', () => {
    const project = assembleProject(sampleScene(), '', [])
    expect(project.packages).toBeUndefined()
    expect(project.stProgram).toBeUndefined()
  })
})

describe('saveStoredProject / loadStoredProject round-trip', () => {
  it('persists to PROJECT_KEY and reads back the active scene + program + library', () => {
    const project = assembleProject({ ...sampleScene(), packages: [samplePackage()] }, 'PROGRAM X\nEND_PROGRAM', [
      samplePackage(),
    ])
    saveStoredProject(project)
    expect(ls().getItem(PROJECT_KEY)).not.toBeNull()
    const loaded = loadStoredProject()
    expect(loaded).not.toBeNull()
    expect(loaded!.scene.parts.map((p) => p.id)).toEqual(['rc_1'])
    expect(loaded!.scene.packages).toHaveLength(1) // library injected so custom parts resolve
    expect(loaded!.stProgram).toContain('PROGRAM X')
    expect(loaded!.library).toHaveLength(1)
  })

  it('returns null when nothing is persisted (first-ever visit)', () => {
    expect(loadStoredProject()).toBeNull()
  })

  it('reports ok on a successful write', () => {
    expect(saveStoredProject(assembleProject(sampleScene(), '', []))).toEqual({ ok: true })
  })

  // The bug this guards: a quota throw swallowed here leaves the author editing against a dead autosave,
  // losing everything on reload. A failure must be reported (and must still not throw).
  it('reports a quota failure instead of swallowing it', () => {
    const store = ls()
    store.setItem = () => {
      throw quotaError()
    }
    const result = saveStoredProject(assembleProject(sampleScene(), '', []))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.quota).toBe(true)
    expect(result.ok === false && result.message).toMatch(/local storage/i)
  })

  it('writes a stored model by its hash, and reads it back whole', () => {
    const data = bytesToBase64(Uint8Array.from({ length: 4000 }, (_, i) => (i * 7) & 255))
    const pkg = { ...samplePackage(), assets: [{ id: 'body', mime: 'model/gltf-binary', data }] }
    markLocalAssetStoredForTest(data)
    expect(saveStoredProject(assembleProject(sampleScene(), '', [pkg])).ok).toBe(true)
    const text = ls().getItem(PROJECT_KEY)!
    expect(text).not.toContain(data.slice(0, 200))
    expect(loadStoredProject()!.library[0]!.assets).toEqual(pkg.assets)
    resetLocalAssetsForTest()
  })

  it('refuses a working copy whose model is gone from storage', () => {
    const data = bytesToBase64(Uint8Array.from({ length: 4000 }, (_, i) => (i * 7) & 255))
    const pkg = { ...samplePackage(), assets: [{ id: 'body', mime: 'model/gltf-binary', data }] }
    markLocalAssetStoredForTest(data)
    saveStoredProject(assembleProject(sampleScene(), '', [pkg], 'Modelled'))
    resetLocalAssetsForTest()
    loadStoredProject()
    expect(unopenedProject()?.errors.join()).toMatch(/missing from this browser's storage/)
  })

  it('reports a non-quota write failure too, without throwing', () => {
    const store = ls()
    store.setItem = () => {
      throw new Error('serializer exploded')
    }
    const result = saveStoredProject(assembleProject(sampleScene(), '', []))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.quota).toBe(false)
    expect(result.ok === false && result.message).toContain('serializer exploded')
  })

  // Adoption is write-then-reload: reloading over a failed write boots the previous project, so the
  // import vanishes silently. importProjectText must surface the reason instead of reporting success.
  it('a project import whose write fails reports the failure rather than claiming success', async () => {
    const store = ls()
    store.setItem = () => {
      throw quotaError()
    }
    const doc = assembleProject(sampleScene(), '', [])
    const soloStore = { getState: () => ({ collab: false }) } as unknown as Parameters<typeof importProjectText>[0]
    expect(await importProjectText(soloStore, JSON.stringify(doc))).toMatch(/local storage/i)
  })
})

describe('legacy migration', () => {
  it('migrates the three legacy keys into a project when no project doc exists', () => {
    // a returning pre-project user: scene autosave + ST program + authored part, no project doc
    const scene: SceneJSON = { ...sampleScene(), packages: [samplePackage()] }
    ls().setItem(LEGACY_SCENE_KEY, serializeScene(scene, 'PROGRAM Legacy\nEND_PROGRAM'))
    ls().setItem(LEGACY_USERPKG_KEY, JSON.stringify([samplePackage('acme.authored')]))
    ls().setItem(ST_PROGRAM_KEY, 'PROGRAM Legacy\nEND_PROGRAM')

    const loaded = loadStoredProject()
    expect(loaded).not.toBeNull()
    expect(loaded!.scene.parts.map((p) => p.id)).toEqual(['rc_1'])
    expect(loaded!.stProgram).toContain('PROGRAM Legacy')
    // only the authored part becomes library; the scene-embedded snapshot stays on the scene
    expect(loaded!.library.map((p) => p.id)).toEqual(['acme.authored'])
    expect(loaded!.project.scene.packages?.map((p) => p.id)).toEqual(['acme.widget'])
    // the projected active scene is still self-contained (snapshot + authored merged)
    expect(loaded!.scene.packages?.map((p) => p.id).sort()).toEqual(['acme.authored', 'acme.widget'])
  })

  it('drops bundled ids from a polluted legacy user-packages key (placed-part freeze)', () => {
    // older builds' boot seeded placement snapshots into userPackages, which authoring re-persisted
    // to the legacy key: a first-party id in there is a frozen snapshot, not an authored part
    ls().setItem(LEGACY_SCENE_KEY, serializeScene(sampleScene()))
    ls().setItem(
      LEGACY_USERPKG_KEY,
      JSON.stringify([samplePackage('oip.roller-conveyor'), samplePackage('acme.authored')]),
    )
    const loaded = loadStoredProject()
    expect(loaded!.library.map((p) => p.id)).toEqual(['acme.authored'])
  })

  it('prefers the project doc over the legacy keys when both exist', () => {
    ls().setItem(LEGACY_SCENE_KEY, JSON.stringify({ version: SCENE_VERSION, parts: [] }))
    saveStoredProject(assembleProject(sampleScene(), 'PROGRAM Fresh\nEND_PROGRAM', []))
    const loaded = loadStoredProject()
    expect(loaded!.scene.parts.map((p) => p.id)).toEqual(['rc_1']) // from the project doc, not the empty legacy scene
    expect(loaded!.stProgram).toContain('PROGRAM Fresh')
  })

  it('falls back to legacy migration when the project doc is corrupt', () => {
    ls().setItem(PROJECT_KEY, '{ not valid json')
    ls().setItem(LEGACY_SCENE_KEY, JSON.stringify({ version: SCENE_VERSION, parts: [createPart('group', 'bst_1', [0, 0, 0])] }))
    const loaded = loadStoredProject()
    expect(loaded).not.toBeNull()
    expect(loaded!.scene.parts.map((p) => p.id)).toEqual(['bst_1'])
    // ...but the corrupt doc is held, not left for the fallback's first save to replace
    expect(unopenedProject()?.errors[0]).toMatch(/^not valid JSON/)
  })

  it('migrates a v1 project doc: bundled snapshots leave the library but stay on their scene', () => {
    // the placed-part-freeze shape: a v1 library holding a placement snapshot of a first-party part
    // (frozen at placement day) beside a genuinely authored part
    const placedSnapshot = { ...samplePackage('oip.roller-conveyor'), name: 'STALE SNAPSHOT' }
    const v1 = {
      version: 1,
      name: 'Old Factory',
      activeScene: 0,
      packages: [placedSnapshot, samplePackage('acme.authored')],
      scenes: [
        {
          id: 'scene-1',
          name: 'Scene 1',
          scene: {
            version: SCENE_VERSION,
            parts: [{ id: 'cp_1', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0, 0], rotationY: 0 }],
          },
        },
      ],
    }
    ls().setItem(PROJECT_KEY, JSON.stringify(v1))
    const loaded = loadStoredProject()
    expect(loaded).not.toBeNull()
    // the snapshot does not adopt as an authored (authoritative) part, so the fresh bundle can take precedence
    expect(loaded!.library.map((p) => p.id)).toEqual(['acme.authored'])
    expect(loaded!.project.packages?.map((p) => p.id)).toEqual(['acme.authored'])
    // but the scene keeps it, so the doc stays self-contained until the bundled catalog registers
    expect(loaded!.project.scene.packages?.map((p) => p.id)).toEqual(['oip.roller-conveyor'])
    expect(loaded!.scene.packages?.map((p) => p.id).sort()).toEqual(['acme.authored', 'oip.roller-conveyor'])
  })

  it('a v1 doc whose library is only placement snapshots migrates to no library at all', () => {
    const v1 = {
      version: 1,
      name: 'P',
      activeScene: 0,
      packages: [samplePackage('oip.roller-conveyor')],
      scenes: [
        {
          id: 'scene-1',
          name: 'Scene 1',
          scene: {
            version: SCENE_VERSION,
            parts: [{ id: 'cp_1', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0, 0], rotationY: 0 }],
          },
        },
      ],
    }
    ls().setItem(PROJECT_KEY, JSON.stringify(v1))
    const loaded = loadStoredProject()
    expect(loaded!.library).toEqual([])
    expect(loaded!.project.packages).toBeUndefined()
    expect(loaded!.project.scene.packages?.map((p) => p.id)).toEqual(['oip.roller-conveyor'])
  })
})

describe('importProjectText (.oip import)', () => {
  // importProjectText only reads state.collab off the store; a stub keeps the test store-free
  const soloStore = { getState: () => ({ collab: false }) } as unknown as Parameters<typeof importProjectText>[0]
  const roomStore = { getState: () => ({ collab: true }) } as unknown as Parameters<typeof importProjectText>[0]

  it('rejects non-JSON and invalid documents without touching the stored project', async () => {
    ls().setItem(PROJECT_KEY, 'sentinel')
    expect(await importProjectText(soloStore, '{nope')).toContain('not valid JSON')
    expect(await importProjectText(soloStore, JSON.stringify({ version: 99 }))).toContain('Invalid project')
    expect(ls().getItem(PROJECT_KEY)).toBe('sentinel')
  })

  it("names a project folder's project.json for what it is instead of failing it path by path", async () => {
    const manifest = { version: 3, name: 'Servo Shuttle', activeScene: 0, scenes: [{ id: 'main', name: 'Main', scene: 'scenes/main.scene.json', stProgram: 'scenes/main.st' }], tests: ['tests/shuttle.test.json'] }
    const msg = await importProjectText(soloStore, JSON.stringify(manifest))
    expect(msg).toContain('project folder')
    expect(msg).toContain('.oip')
    expect(msg).not.toContain('tests[0]')
  })

  it('imports from a shared project too: as the stored project, never into the shared document', async () => {
    const doc = assembleProject(sampleScene(), '', [], 'From a room')
    expect(await importProjectText(roomStore, JSON.stringify(doc))).toBeNull()
    expect(JSON.parse(ls().getItem(PROJECT_KEY)!).name).toBe('From a room')
  })

  it('adopts a valid v2 document as the stored project', async () => {
    const doc = assembleProject(sampleScene(), 'PROGRAM P\nEND_PROGRAM', [samplePackage('acme.authored')], 'Imported')
    expect(await importProjectText(soloStore, JSON.stringify(doc))).toBeNull()
    const stored = JSON.parse(ls().getItem(PROJECT_KEY)!)
    expect(stored.name).toBe('Imported')
    expect(stored.packages.map((p: { id: string }) => p.id)).toEqual(['acme.authored'])
  })

  // Guards against an import destroying another project. Adoption overwrites the working copy and reloads.
  // With a library of several projects (editor/project/documentStore.ts), leaving the document pointer in place
  // would make the library's first sync after that reload write the imported project into the outgoing
  // document's row, silently destroying a project you were not even looking at.
  // Dropping the pointer makes the import an addition: the next boot mints a row of its own for it, and
  // the document being left keeps its own (main.tsx captures its id at boot for the last flush).
  it('cuts the working copy loose from its document, so an import cannot overwrite the one it replaced', async () => {
    ls().setItem('oip-web/document-id', 'doc-outgoing')
    const doc = assembleProject(sampleScene(), '', [], 'Imported Line')
    expect(await importProjectText(soloStore, JSON.stringify(doc))).toBeNull()
    expect(JSON.parse(ls().getItem(PROJECT_KEY)!).name).toBe('Imported Line')
    expect(ls().getItem('oip-web/document-id')).toBeNull()
  })

  // A refused import must not disturb the pointer either - the document you are in is still the one
  // you are in, and its row has to keep receiving that session's syncs.
  it('leaves the pointer alone when the import is rejected', async () => {
    ls().setItem('oip-web/document-id', 'doc-outgoing')
    expect(await importProjectText(soloStore, '{nope')).toContain('not valid JSON')
    expect(ls().getItem('oip-web/document-id')).toBe('doc-outgoing')
  })

  it('imports a zipped-folder .oip: parts re-baked through the REAL validator', async () => {
    const pkg = buildPackage(
      { id: 'acme.zipped', name: 'Zipped', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.05, bottom: -0.1 } } },
      `definePart({ params: { speed: { type: 'number', default: 0.7 } }, step() {} })`,
    )
    const doc = assembleProject(sampleScene(), 'PROGRAM Z\nEND_PROGRAM', [pkg], 'Zip Import')
    const bytes = await projectToOipBytes(doc)
    expect(await importProjectData(soloStore, bytes)).toBeNull()
    const stored = JSON.parse(ls().getItem(PROJECT_KEY)!)
    expect(stored.name).toBe('Zip Import')
    expect(stored.packages[0].id).toBe('acme.zipped')
    expect(stored.packages[0].params).toEqual({ speed: { type: 'number', default: 0.7 } }) // re-baked from behavior.js
  })

  it('imports a legacy flat-JSON .oip through the same entry (content-sniffed)', async () => {
    const doc = assembleProject(sampleScene(), '', [], 'Legacy JSON')
    const bytes = new TextEncoder().encode(JSON.stringify(doc))
    expect(await importProjectData(soloStore, bytes)).toBeNull()
    expect(JSON.parse(ls().getItem(PROJECT_KEY)!).name).toBe('Legacy JSON')
  })

  it('a zip with a broken part script fails the import with the diagnostic', async () => {
    const pkg = buildPackage(
      { id: 'acme.breaks', name: 'Breaks', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } },
      `definePart({ step() {} })`,
    )
    const doc = assembleProject(sampleScene(), '', [pkg], 'Broken')
    const bytes = await projectToOipBytes(doc)
    // sabotage behavior.js inside the archive: unzip, break, re-zip
    const { strFromU8, strToU8, unzipSync, zipSync } = await import('fflate')
    const entries = unzipSync(bytes)
    const tree = Object.fromEntries(
      Object.entries(entries).map(([p, d]) => [p, p.endsWith('behavior.js') ? strToU8('definePart({ step() {') : strToU8(strFromU8(d))]),
    )
    const err = await importProjectData(soloStore, zipSync(tree))
    expect(err).toContain('parts/acme.breaks')
  })

  it('filters bundled ids from an imported v1 library (the boot-path migration, applied at import)', async () => {
    // Without this, the import would persist the migrated doc as v2 and the boot path would adopt the
    // placed bundled part's snapshot as an authored (authoritative) part - the placed-part-freeze bug.
    const v1 = {
      version: 1,
      name: 'Old Export',
      activeScene: 0,
      packages: [samplePackage('oip.roller-conveyor'), samplePackage('acme.authored')],
      scenes: [
        {
          id: 'scene-1',
          name: 'Scene 1',
          scene: {
            version: SCENE_VERSION,
            parts: [{ id: 'cp_1', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0, 0], rotationY: 0 }],
          },
        },
      ],
    }
    expect(await importProjectText(soloStore, JSON.stringify(v1))).toBeNull()
    const stored = JSON.parse(ls().getItem(PROJECT_KEY)!)
    expect(stored.packages.map((p: { id: string }) => p.id)).toEqual(['acme.authored'])
    // the scene keeps its snapshot for self-containment
    expect(stored.scene.packages.map((p: { id: string }) => p.id)).toEqual(['oip.roller-conveyor'])
  })
})

// A stored project that validateProject refuses. validateProject is all-or-nothing. If boot fell back to
// the legacy scene key and saved that fallback at once, the library's first sync would file it over the
// same document's record, replacing both copies of a document the build could not read before anyone saw
// a thing. The refused document stays where it is until the user downloads or discards it.
describe('a stored project this build cannot open', () => {
  // an older (format-3) multi-scene entry: the only kind of document a test can name a missing scene in
  const scene = (id: string, name: string) => ({ id, name, scene: { version: SCENE_VERSION, parts: [] } })
  const check = [{ tag: 'Run', at: 0.5, equals: true }]
  /** two scenes, and a test naming a third that is gone: what deleting a scene in an older build left behind */
  const refusedDoc = () => ({
    version: 3,
    name: 'Plant',
    activeScene: 0,
    scenes: [scene('scene-1', 'Line A'), scene('scene-3', 'Line C')],
    tests: [{ name: 'line b', scene: 'scene-2', duration: 1, checks: check }],
  })
  const storeRefused = (): string => {
    const raw = JSON.stringify(refusedDoc())
    ls().setItem(PROJECT_KEY, raw)
    ls().setItem(LEGACY_SCENE_KEY, serializeScene(sampleScene()))
    return raw
  }
  // bootSolo's non-demo branch
  const boot = (): EditorStore => {
    const loaded = loadStoredProject()
    const store = new EditorStore()
    store.setUnopenedProject(unopenedProject())
    if (loaded) store.loadProject(loaded.project)
    store.persistProject()
    return store
  }

  it('still opens the editor on the fallback, and says what it refused', () => {
    storeRefused()
    const loaded = loadStoredProject()
    expect(loaded!.scene.parts.map((p) => p.id)).toEqual(['rc_1'])
    expect(unopenedProject()).toEqual({
      name: 'Plant',
      errors: ['tests[0].scene "scene-2" is not a scene in this project'],
    })
  })

  it('refuses every save over it, the boot save included', async () => {
    const raw = storeRefused()
    ls().setItem('oip-web/document-id', 'doc-plant')
    const store = boot()
    expect(store.getState().unopenedProject?.name).toBe('Plant')
    expect(store.getState().autosaveError).toContain('“Plant” could not be opened')
    const later = store.persistProject()
    expect(later.ok).toBe(false)
    expect(saveStoredProject(assembleProject(sampleScene(), '', [])).ok).toBe(false)
    // an import is a write of the working copy too: refused, and the pointer is left alone
    expect(await importProjectText(store, JSON.stringify({ ...refusedDoc(), tests: [] }))).toContain('could not be opened')
    expect(ls().getItem(PROJECT_KEY)).toBe(raw)
    expect(ls().getItem('oip-web/document-id')).toBe('doc-plant')
  })

  it('discarding it removes it, cuts the pointer loose, and saves what is on screen', () => {
    storeRefused()
    ls().setItem('oip-web/document-id', 'doc-plant')
    const store = boot()
    discardUnopenedProject(store)
    expect(unopenedProject()).toBeNull()
    expect(store.getState().unopenedProject).toBeNull()
    expect(store.getState().autosaveError).toBeNull()
    // the next library sync files the fallback as a new document; the refused one keeps its record
    expect(ls().getItem('oip-web/document-id')).toBeNull()
    const saved = JSON.parse(ls().getItem(PROJECT_KEY)!)
    expect(saved.version).toBe(PROJECT_VERSION)
    expect((saved.scene as SceneJSON).parts.map((p) => p.id)).toEqual(['rc_1'])
  })

  it('lifts once the working copy no longer holds that document - and a replacement from elsewhere is another tab', () => {
    storeRefused()
    loadStoredProject()
    ls().setItem(PROJECT_KEY, 'replaced by something else')
    expect(unopenedProject()).toBeNull()
    const saved = saveStoredProject(assembleProject(sampleScene(), '', []))
    expect(saved.ok ? '' : saved.message).toBe(SUPERSEDED_MESSAGE)
  })
})

// Two tabs share one working copy and each save writes the whole document, so the second tab to save could
// erase the first one's work without a word. A session may only write over what it last read or wrote.
describe('another tab writing the working copy', () => {
  const project = (name: string) => assembleProject(sampleScene(), '', [], name)

  it('refuses a save over another tab’s write, says why, and stays refused', () => {
    saveStoredProject(project('Mine'))
    loadStoredProject()
    const heard: string[] = []
    const off = onWorkingCopySuperseded(() => heard.push('yield'))
    try {
      ls().setItem(PROJECT_KEY, serializeProject(project('Theirs'), { pretty: false })) // the other tab
      const saved = saveStoredProject(project('Mine, edited'))
      expect(saved.ok ? '' : saved.message).toBe(SUPERSEDED_MESSAGE)
      expect(JSON.parse(ls().getItem(PROJECT_KEY)!).name).toBe('Theirs')
      expect(workingCopySuperseded()).toBe(true)
      expect(workingCopyRefusal()).toBe(SUPERSEDED_MESSAGE)
      // sticky: the other tab holds the document now, even if what it wrote happens to match ours later
      ls().setItem(PROJECT_KEY, serializeProject(project('Mine, edited'), { pretty: false }))
      expect(saveStoredProject(project('Mine, edited again')).ok).toBe(false)
      expect(heard).toEqual(['yield'])
    } finally {
      off()
    }
  })

  it('moves what it expects with each of its own saves', () => {
    loadStoredProject()
    expect(saveStoredProject(project('One')).ok).toBe(true)
    expect(saveStoredProject(project('Two')).ok).toBe(true)
    expect(workingCopySuperseded()).toBe(false)
  })

  it('yields on another tab’s storage event, unless that tab wrote exactly what this one has', () => {
    saveStoredProject(project('Same'))
    loadStoredProject()
    const same = ls().getItem(PROJECT_KEY)
    // another tab opening this very project and saving it unchanged is no conflict
    expect(noteWorkingCopyWrite(same)).toBe(false)
    expect(workingCopySuperseded()).toBe(false)
    expect(noteWorkingCopyWrite(serializeProject(project('Changed'), { pretty: false }))).toBe(true)
    expect(workingCopySuperseded()).toBe(true)
    // the event fires before this tab touches storage again, so its next save is refused outright
    expect(saveStoredProject(project('Same')).ok).toBe(false)
  })

  it('guards nothing for a session that never read the working copy', () => {
    ls().setItem(PROJECT_KEY, 'written before this session looked')
    expect(noteWorkingCopyWrite('anything')).toBe(false)
    expect(saveStoredProject(project('Headless')).ok).toBe(true)
  })

  it('an import is refused too, and only after the file has validated does it try to file the project being left', async () => {
    loadStoredProject()
    const store = { getState: () => ({ collab: false }) } as unknown as Parameters<typeof importProjectData>[0]
    const bytes = (text: string) => new TextEncoder().encode(text)
    let asked = 0
    const beforeAdopt = async () => (asked++, 'nope, not filed')
    expect(await importProjectData(store, bytes('{ broken'), { beforeAdopt })).toBe('File is not valid JSON')
    expect(asked).toBe(0)
    const valid = serializeProject(project('Imported'))
    expect(await importProjectData(store, bytes(valid), { beforeAdopt })).toBe('nope, not filed')
    expect(asked).toBe(1)
    expect(ls().getItem(PROJECT_KEY)).toBeNull()
    ls().setItem(PROJECT_KEY, 'the other tab')
    expect(await importProjectText(store, valid)).toBe(SUPERSEDED_MESSAGE)
    expect(ls().getItem(PROJECT_KEY)).toBe('the other tab')
  })
})

// A format-1 to 3 document held several scenes; reading one splits it (core/project/project.ts validateProject): the
// active scene is the project, every other one a project of its own, which the host must file before anything saves
// over the source. These are the browser's pieces of that: the boot read, and the parking that carries a split
// across a reload until the library files it.
describe('an older multi-scene document', () => {
  const formatThree = () => ({
    version: 3,
    name: 'Plant',
    activeScene: 1,
    scenes: [
      { id: 'scene-1', name: 'Line A', scene: { version: SCENE_VERSION, parts: [createPart('group', 'ga', [0, 0, 0])] } },
      { id: 'scene-2', name: 'Line B', scene: { version: SCENE_VERSION, parts: [createPart('group', 'gb', [1, 0, 0])] }, stProgram: 'PROGRAM B\nEND_PROGRAM' },
      { id: 'scene-3', name: 'Line C', scene: { version: SCENE_VERSION, parts: [createPart('group', 'gc', [2, 0, 0])] } },
    ],
  })
  const one = (name: string): ProjectJSON => assembleProject(sampleScene(), '', [], name)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parkSplitOff / readParkedSplitOff / clearParkedSplitOff round-trip, appending to what is parked', () => {
    expect(readParkedSplitOff()).toEqual([])
    expect(parkSplitOff([one('First')])).toEqual({ ok: true })
    expect(parkSplitOff([one('Second'), one('Third')])).toEqual({ ok: true })
    const parked = readParkedSplitOff()
    expect(parked.map((p) => p.name)).toEqual(['First', 'Second', 'Third'])
    expect(parked[0]!.scene.parts.map((p) => p.id)).toEqual(['rc_1'])
    expect(parkSplitOff([])).toEqual({ ok: true }) // nothing to park writes nothing
    expect(readParkedSplitOff()).toHaveLength(3)
    clearParkedSplitOff()
    expect(ls().getItem(SPLIT_OFF_KEY)).toBeNull()
    expect(readParkedSplitOff()).toEqual([])
  })

  it('readParkedSplitOff skips a damaged entry and survives a damaged key', () => {
    ls().setItem(SPLIT_OFF_KEY, JSON.stringify([{ version: 99 }, JSON.parse(serializeProject(one('Good')))]))
    expect(readParkedSplitOff().map((p) => p.name)).toEqual(['Good'])
    ls().setItem(SPLIT_OFF_KEY, '{ broken')
    expect(readParkedSplitOff()).toEqual([])
  })

  it('an entry this build cannot read survives parking, unparking and clearing', () => {
    // A stricter validateProject in a later build must not erase a parked scene the first time the list is rewritten.
    const unreadable = { version: 99, name: 'From elsewhere' }
    ls().setItem(SPLIT_OFF_KEY, JSON.stringify([unreadable, JSON.parse(serializeProject(one('A')))]))
    parkSplitOff([one('B')])
    expect(readParkedSplitOff().map((p) => p.name)).toEqual(['A', 'B'])
    unparkSplitOff(1)
    expect(readParkedSplitOff().map((p) => p.name)).toEqual(['B'])
    clearParkedSplitOff()
    expect(readParkedSplitOff()).toEqual([])
    expect(JSON.parse(ls().getItem(SPLIT_OFF_KEY)!)).toEqual([unreadable])
  })

  it('loadStoredProject on a stored format-3 working copy opens the active scene and returns the rest as splitOff', () => {
    ls().setItem(PROJECT_KEY, JSON.stringify(formatThree()))
    const loaded = loadStoredProject()
    expect(loaded).not.toBeNull()
    expect(unopenedProject()).toBeNull()
    expect(loaded!.project.name).toBe('Plant')
    expect(loaded!.scene.parts.map((p) => p.id)).toEqual(['gb']) // the scene that was active
    expect(loaded!.stProgram).toContain('PROGRAM B')
    expect(loaded!.splitOff?.map((p) => p.name)).toEqual(['Plant - Line A', 'Plant - Line C'])
    expect(loaded!.splitOff?.map((p) => p.scene.parts.map((x) => x.id))).toEqual([['ga'], ['gc']])
  })

  it('a format-4 working copy has no splitOff', () => {
    saveStoredProject(one('Single'))
    expect(loadStoredProject()!.splitOff).toBeUndefined()
  })

  it('adoptImportedProject parks the split-off projects, writes the kept one, and reloads', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const result = validateProject(formatThree())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await adoptImportedProject(result)).toEqual({ ok: true })
    expect(reload).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(ls().getItem(PROJECT_KEY)!)
    expect(stored.version).toBe(PROJECT_VERSION)
    expect(stored.scene.parts.map((p: { id: string }) => p.id)).toEqual(['gb'])
    expect(readParkedSplitOff().map((p) => p.name)).toEqual(['Plant - Line A', 'Plant - Line C'])
  })

  it('importProjectText of a format-3 document parks its other scenes too', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const soloStore = { getState: () => ({ collab: false }) } as unknown as Parameters<typeof importProjectText>[0]
    expect(await importProjectText(soloStore, JSON.stringify(formatThree()))).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(readParkedSplitOff()).toHaveLength(2)
  })

  it('a one-project import parks nothing', async () => {
    vi.stubGlobal('location', { reload: vi.fn() })
    const soloStore = { getState: () => ({ collab: false }) } as unknown as Parameters<typeof importProjectText>[0]
    expect(await importProjectText(soloStore, serializeProject(one('Solo')))).toBeNull()
    expect(ls().getItem(SPLIT_OFF_KEY)).toBeNull()
  })
})
