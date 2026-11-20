import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorStore } from './store'
import { createPlcDemoScene, DEMO_CONTROLLER, DEMO_PROGRAM, DEMO_SCENE_NAME } from '../demo/demoScenes'
import { leaveDemo, openDemoScene } from '../project/sceneFile'
import { PROJECT_KEY } from '../project/projectFile'
import { ST_PROGRAM_KEY } from '../program/stProgram'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { validateProject } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance } from '../../core/types'
import { getPackage, registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { buildPackage } from '../../sim/buildPackage'
import { builtInsUpdated } from './storePackages'

/** a stand-in built-in: one box link, nothing else */
const PROBE_ID = 'acme.demo-library-probe'
const probeManifest = {
  id: PROBE_ID,
  name: 'Probe',
  geometry: { kind: 'rig' as const, links: [{ name: 'body', shape: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] }, offset: [0, 0, 0] as [number, number, number] }], joints: [] },
}

/**
 * The demo as it opens: Open Demo reloads into `?scene=demo` (sceneFile.openDemoScene), and that boot adopts the
 * stored project for ownership and loads the demo over it (main.tsx bootSolo). This is that boot, minus the page.
 */
function bootDemo(store: EditorStore, project: ProjectJSON): void {
  store.loadProject(project, { adoptOnly: true })
  store.enterDemoSession(createPlcDemoScene(), DEMO_PROGRAM, { bank: false, controller: DEMO_CONTROLLER })
}

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

// a generic movable scene fixture (an opaque "some part"); a Group is always valid and needs no package, so it
// round-trips through validateProject/validateScene unchanged.
function box(id: string, x: number): PartInstance {
  return { id, type: 'group', position: [x, 0.2, 0], rotationY: 0, params: {} } as PartInstance
}

/** a project: box a@1 + a bound ST program */
function plantProject(): ProjectJSON {
  return {
    version: PROJECT_VERSION,
    name: 'Plant',
    scene: { version: SCENE_VERSION, parts: [box('a', 1)] },
    stProgram: 'VAR x : BOOL; END_VAR',
  }
}

/** a second, different project (no program) */
function otherProject(): ProjectJSON {
  return { version: PROJECT_VERSION, name: 'Other', scene: { version: SCENE_VERSION, parts: [box('o', 4)] } }
}

const ids = (store: EditorStore) => store.getState().scene.parts.map((p) => p.id)

function savedProject(): ProjectJSON | null {
  const raw = localStorage.getItem(PROJECT_KEY)
  if (raw === null) return null
  const result = validateProject(JSON.parse(raw))
  return result.ok ? result.project : null
}

describe('EditorStore project', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loadProject loads the scene and its program live and publishes the name', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(plantProject())
    expect(ids(store)).toEqual(['a'])
    expect(store.getState().stProgram).toBe('VAR x : BOOL; END_VAR')
    expect(store.getState().projectName).toBe('Plant')
  })

  it('persistProject captures live edits and writes a valid format-4 doc', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(plantProject())
    store.commit('add', { ...store.getState().scene, parts: [...store.getState().scene.parts, box('a2', 3)] })
    store.persistProject()
    const raw = JSON.parse(localStorage.getItem(PROJECT_KEY)!) as { version: number }
    expect(raw.version).toBe(PROJECT_VERSION)
    const saved = savedProject()!
    expect(saved.name).toBe('Plant')
    expect(saved.scene.parts.map((p) => p.id).sort()).toEqual(['a', 'a2'])
    expect(saved.stProgram).toBe('VAR x : BOOL; END_VAR')
  })

  it('does not write the outgoing scene into the next project when the ST-program listener re-enters persistProject mid-load', () => {
    // The StEditor subscribes to onStProgramLoad and calls persistProject from its handler. applyProject
    // broadcasts the program while loading, so that re-entrant capture must see the new project's scene.
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.onStProgramLoad(() => store.persistProject()) // mimic the live StEditor
    store.loadProject(plantProject())
    store.commit('edit', { ...store.getState().scene, parts: [box('a', 1), box('a2', 9)] })
    expect(savedProject()!.scene.parts.map((p) => p.id).sort()).toEqual(['a', 'a2'])
    store.loadProject(otherProject())
    expect(ids(store)).toEqual(['o'])
    const saved = savedProject()!
    expect(saved.name).toBe('Other')
    expect(saved.scene.parts.map((p) => p.id)).toEqual(['o']) // NOT clobbered by the re-entrant capture
    expect(saved.stProgram).toBeUndefined()
  })

  it('persists with no preloaded project (lazy one-scene init)', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [box('z', 0)] })
    store.persistProject()
    expect(savedProject()!.scene.parts.map((p) => p.id)).toEqual(['z'])
    expect(store.snapshotProject().scene.parts.map((p) => p.id)).toEqual(['z'])
  })
})

// The project name tells the user which document the app opened on (the tab title and the picker group header both
// read it). The two refusals below matter most: renaming has to persist to mean anything, and both a demo preview
// and a room would make that untrue in a way the user cannot see.
describe('EditorStore.renameProject', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renames the project and persists it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(plantProject())
    store.renameProject('  Line 4 Rebuild  ') // trimmed
    expect(store.getState().projectName).toBe('Line 4 Rebuild')
    expect(savedProject()!.name).toBe('Line 4 Rebuild')
    expect(ids(store)).toEqual(['a']) // a relabel: the scene is untouched
  })

  it('ignores an empty or unchanged name', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(plantProject())
    store.renameProject('   ')
    expect(store.getState().projectName).toBe('Plant')
  })

  // persistProject() opens with stashDemoSession(), so a rename that reached it while the demo preview was up
  // would fork the demo into a project of its own. A label minting a document is the one thing the copy-on-write
  // model promises never happens.
  it('is inert during the demo preview, and cannot fork it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const handed: ProjectJSON[] = []
    store.setDemoForkHost((outgoing) => {
      handed.push(outgoing)
      return DEMO_SCENE_NAME
    })
    bootDemo(store, plantProject())
    store.renameProject('Renamed while previewing')
    expect(store.getState().projectName).toBe('Plant')
    expect(store.demoSession).toBe(true)
    expect(handed).toHaveLength(0) // no project minted
  })

  // In a room the collab doc is the document and persistProject() is a no-op, so accepting the rename
  // would leave a label that silently died on the next reload.
  it('is inert in a room and on a view-only link', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(plantProject())
    store.setCollabMode(true)
    store.renameProject('Room rename')
    expect(store.getState().projectName).toBe('Plant')
    store.setCollabMode(false)
    store.setReadOnly(true)
    store.renameProject('View-only rename')
    expect(store.getState().projectName).toBe('Plant')
  })
})

describe('EditorStore demo-session URL retirement', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Stub window/history/localStorage for a `?scene=demo` boot; replaceState mutates href like a browser. */
  function stubDemoUrl(href: string): { replace: ReturnType<typeof vi.fn>; win: { location: { href: string } } } {
    const win = { location: { href } }
    const replace = vi.fn((_state: unknown, _title: string, url: string) => {
      win.location.href = new URL(url, win.location.href).href // mimic the browser's URL rewrite
    })
    vi.stubGlobal('window', win)
    vi.stubGlobal('history', { state: null, replaceState: replace })
    vi.stubGlobal('localStorage', fakeStorage())
    return { replace, win }
  }

  it('strips ?scene=demo on the first persisting edit, keeping other params', () => {
    const { replace, win } = stubDemoUrl('https://x.test/app/?scene=demo&webgpu=1')
    const store = new EditorStore()
    store.demoSession = true
    store.persistProject()
    expect(replace).toHaveBeenCalledTimes(1)
    expect(win.location.href).toBe('https://x.test/app/?webgpu=1') // scene dropped, webgpu kept
    expect(store.demoSession).toBe(false)
  })

  it('fires exactly once - a later persist does not rewrite the URL again', () => {
    const { replace } = stubDemoUrl('https://x.test/app/?scene=demo')
    const store = new EditorStore()
    store.demoSession = true
    store.persistProject()
    store.persistProject()
    expect(replace).toHaveBeenCalledTimes(1)
  })

  // Leaving the demo is a reload into the project it was opened from (sceneFile.leaveDemo): the entry param goes
  // first, or the reload would open the demo again.
  it('leaving the demo drops the param and reloads into the project', () => {
    const { replace, win } = stubDemoUrl('https://x.test/app/?scene=demo')
    const reload = vi.fn()
    vi.stubGlobal('location', { ...win.location, reload })
    leaveDemo()
    expect(replace).toHaveBeenCalledTimes(1)
    expect(win.location.href).toBe('https://x.test/app/')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a normal (non-demo) session never rewrites the URL', () => {
    const { replace } = stubDemoUrl('https://x.test/app/')
    const store = new EditorStore()
    store.persistProject()
    expect(replace).not.toHaveBeenCalled()
  })

  // The `?scene=demo` boot adopts the saved project without switching to it (main.tsx). With nowhere to file it
  // (no fork host: a browser keeping one project), the demo cannot become a project without replacing theirs, so
  // it stays a preview: nothing is written, and it says so once.
  it('with no fork host, a returning user\'s edit leaves the demo a preview and writes nothing', () => {
    stubDemoUrl('https://x.test/app/?scene=demo')
    const store = new EditorStore()
    store.loadProject(plantProject(), { adoptOnly: true })
    store.loadScene({ version: SCENE_VERSION, parts: [box('demo', 9)] }, { persist: false })
    store.demoSession = true
    expect(store.getState().demoForkNotice).toBeNull() // looking is not forking, and gets no notice
    store.commit('nudge', { ...store.getState().scene, parts: [box('demo', 9.5)] })
    expect(store.demoSession).toBe(true)
    expect(store.getState().projectName).toBe('Plant')
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull() // the demo's edit was not persisted
    expect(store.getState().demoForkNotice?.title).toBe('Your demo changes are not kept here')
    expect(store.getState().demoForkNotice?.message).toContain('“Plant”')
    store.dismissDemoForkNotice()
    // said once: a later edit is quiet, and still writes nothing
    store.commit('again', { ...store.getState().scene, parts: [box('demo', 9.7)] })
    expect(store.getState().demoForkNotice).toBeNull()
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull()
    // and the project underneath is whole, still the store's own: leaving (a reload) boots the working copy
    expect(store.outgoingProject()?.scene.parts.map((p) => p.id)).toEqual(['a'])
    expect(store.outgoingProject()?.stProgram).toBe('VAR x : BOOL; END_VAR')
  })

  it('a host that declines (no library to file into) also leaves the demo a preview', () => {
    stubDemoUrl('https://x.test/app/?scene=demo')
    const store = new EditorStore()
    store.setDemoForkHost(() => null)
    store.loadProject(plantProject(), { adoptOnly: true })
    store.loadScene({ version: SCENE_VERSION, parts: [box('demo', 9)] }, { persist: false })
    store.demoSession = true
    store.commit('nudge', { ...store.getState().scene, parts: [box('demo', 9.5)] })
    expect(store.getState().projectName).toBe('Plant')
    expect(store.demoSession).toBe(true)
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull()
    expect(store.getState().demoForkNotice?.title).toBe('Your demo changes are not kept here')
  })

  it('a demo peek edited by a first-time visitor becomes their project, named after the demo', () => {
    stubDemoUrl('https://x.test/app/?scene=demo')
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [box('demo', 9)] }, { persist: false })
    store.demoSession = true
    store.commit('nudge', { ...store.getState().scene, parts: [box('demo', 9.5)] })
    expect(store.demoSession).toBe(false)
    expect(store.getState().demoForkNotice?.title).toBe(`${DEMO_SCENE_NAME} is now your project`)
    expect(store.getState().demoForkNotice?.message).toContain('made it yours')
    // a first visit has no project to keep, so the demo is the project, and is named after the demo
    expect(store.getState().projectName).toBe(DEMO_SCENE_NAME)
    const saved = savedProject()!
    expect(saved.name).toBe(DEMO_SCENE_NAME)
    expect(saved.scene.parts.map((p) => p.id)).toEqual(['demo'])
    expect(saved.scene.parts[0]!.position[0]).toBe(9.5)
  })

  // The returning user's case with the host the app installs (demoFork.ts): the demo becomes a project of its
  // own, and theirs goes to the host to be filed, exactly as it was.
  it('a demo peek edited by a returning user becomes a new project, and theirs is handed over untouched', () => {
    stubDemoUrl('https://x.test/app/?scene=demo')
    const store = new EditorStore()
    const handed: ProjectJSON[] = []
    store.setDemoForkHost((outgoing) => {
      handed.push(JSON.parse(JSON.stringify(outgoing)) as ProjectJSON)
      return DEMO_SCENE_NAME
    })
    store.loadProject(plantProject(), { adoptOnly: true })
    store.loadScene({ version: SCENE_VERSION, parts: [box('demo', 9)] }, { persist: false })
    store.demoSession = true
    store.commit('nudge', { ...store.getState().scene, parts: [box('demo', 9.5)] })
    // theirs, as it was: its parts and the bound program, under its own name
    expect(handed).toHaveLength(1)
    expect(handed[0]!.name).toBe('Plant')
    expect(handed[0]!.scene.parts.map((p) => p.id)).toEqual(['a'])
    expect(handed[0]!.stProgram).toBe('VAR x : BOOL; END_VAR')
    // the screen is a project of its own now
    expect(store.demoSession).toBe(false)
    expect(store.getState().projectName).toBe(DEMO_SCENE_NAME)
    expect(ids(store)).toEqual(['demo'])
    // and the notice names the project left behind, and the way back to it
    const notice = store.getState().demoForkNotice
    expect(notice?.title).toBe(`${DEMO_SCENE_NAME} is now a project of your own`)
    expect(notice?.message).toContain('“Plant” is untouched')
    expect(notice?.action?.command).toBe('file.projects')
    // the working copy is the new project: the demo, alone
    const saved = savedProject()!
    expect(saved.name).toBe(DEMO_SCENE_NAME)
    expect(saved.scene.parts.map((p) => p.id)).toEqual(['demo'])
    // forking happens once: a later edit is an ordinary edit of the new project
    store.commit('again', { ...store.getState().scene, parts: [box('demo', 9.7)] })
    expect(handed).toHaveLength(1)
    expect(savedProject()!.scene.parts[0]!.position[0]).toBe(9.7)
  })

  // A project's library holds its own copy of every built-in it uses. Live under the demo, that copy drew the demo
  // with the project's older version and raised the "parts have updates" bar over a scene that uses none of them.
  it("the demo runs this build's parts, not the stored project's older copies, and the fork files those untouched", () => {
    stubDemoUrl('https://x.test/app/?scene=demo')
    const builtIn = buildPackage(probeManifest, 'definePart({ step() { /* this build */ } })')
    registerPackage(builtIn, true)
    try {
      const older = { ...builtIn, behavior: 'definePart({ step() { /* older build */ } })', origin: { app: 'older-fingerprint' } }
      const store = new EditorStore()
      store.setState({ bundledPackages: [builtIn] })
      const handed: ProjectJSON[] = []
      store.setDemoForkHost((outgoing) => {
        handed.push(JSON.parse(JSON.stringify(outgoing)) as ProjectJSON)
        return DEMO_SCENE_NAME
      })
      bootDemo(store, { ...plantProject(), packages: [older] })
      expect(getPackage(PROBE_ID)?.behavior).toContain('this build')
      expect(store.getState().userPackages).toEqual([])
      expect(builtInsUpdated(store.getState()).size).toBe(0)
      store.commit('nudge', { ...store.getState().scene, parts: [...store.getState().scene.parts, box('mine', 3)] })
      expect(handed[0]!.packages?.map((p) => p.behavior)).toEqual([older.behavior])
      expect(getPackage(PROBE_ID)?.behavior).toContain('this build')
    } finally {
      unregisterPackage(PROBE_ID)
    }
  })

  // Adding a part from a library or the shelf is the edit that forks the demo. The fork must not empty the library
  // after the add, or the part has to be added twice.
  it('a part added to the library during the demo forks it and stays in the new project', () => {
    stubDemoUrl('https://x.test/app/?scene=demo')
    const theirs = buildPackage({ ...probeManifest, id: 'acme.theirs-probe' }, 'definePart({ step() {} })')
    const added = buildPackage({ ...probeManifest, id: 'acme.added-probe' }, 'definePart({ step() {} })')
    try {
      const store = new EditorStore()
      const handed: ProjectJSON[] = []
      store.setDemoForkHost((outgoing) => {
        handed.push(JSON.parse(JSON.stringify(outgoing)) as ProjectJSON)
        return DEMO_SCENE_NAME
      })
      bootDemo(store, { ...plantProject(), packages: [theirs] })
      registerPackage(added, true)
      store.addUserPackage(added)
      expect(store.demoSession).toBe(false)
      expect(store.getState().userPackages.map((p) => p.id)).toEqual([added.id])
      expect(getPackage(added.id)).toBeDefined()
      expect(savedProject()!.packages?.map((p) => p.id)).toEqual([added.id])
      expect(handed[0]!.packages?.map((p) => p.id)).toEqual([theirs.id])
    } finally {
      unregisterPackage(added.id)
      unregisterPackage(theirs.id)
    }
  })

  // the in-page entry (bank: true) leaves a project whose library is already live: the demo drops it too
  it('entering the demo from an open project takes its library out of play, and keeps it in the document', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const builtIn = buildPackage(probeManifest, 'definePart({ step() { /* this build */ } })')
    registerPackage(builtIn, true)
    try {
      const older = { ...builtIn, behavior: 'definePart({ step() { /* older build */ } })', origin: { app: 'older-fingerprint' } }
      const store = new EditorStore()
      store.setState({ bundledPackages: [builtIn] })
      store.loadProject({ ...plantProject(), packages: [older] })
      expect(getPackage(PROBE_ID)?.behavior).toContain('older build')
      store.enterDemoSession({ version: SCENE_VERSION, parts: [] }, '')
      expect(getPackage(PROBE_ID)?.behavior).toContain('this build')
      expect(store.getState().userPackages).toEqual([])
      expect(savedProject()!.packages?.map((p) => p.behavior)).toEqual([older.behavior])
    } finally {
      unregisterPackage(PROBE_ID)
    }
  })

  // only the host can see the library's names, so it picks the name: a second fork is not a twin row
  it('takes the name the host gives it, in the project and its notice', () => {
    stubDemoUrl('https://x.test/app/?scene=demo')
    const store = new EditorStore()
    store.setDemoForkHost(() => `${DEMO_SCENE_NAME} 2`)
    store.loadProject(plantProject(), { adoptOnly: true })
    store.loadScene({ version: SCENE_VERSION, parts: [box('demo', 9)] }, { persist: false })
    store.demoSession = true
    store.commit('nudge', { ...store.getState().scene, parts: [box('demo', 9.5)] })
    expect(store.getState().projectName).toBe(`${DEMO_SCENE_NAME} 2`)
    expect(savedProject()!.name).toBe(`${DEMO_SCENE_NAME} 2`)
    expect(store.getState().demoForkNotice?.title).toBe(`${DEMO_SCENE_NAME} 2 is now a project of your own`)
  })
})

// The demo is a view, not a project: pressing Demo mints nothing, and editing what you are looking at is what forks
// it into a project of your own (store.stashDemoSession), where there is somewhere to file the one it was opened from.
describe('the demo, a project of its own (the built-in example)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // Open Demo is opening a project: the one on screen is saved and filed, then the page goes to the demo's boot.
  it('Open Demo saves the project and reloads into the demo, leaving a room behind', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const assign = vi.fn()
    vi.stubGlobal('location', { href: 'https://x.test/app/?room=e-abc&view=1', assign })
    const store = new EditorStore()
    store.loadProject(plantProject())
    store.commit('nudge', { version: SCENE_VERSION, parts: [box('a', 1), box('a2', 5)] })
    openDemoScene(store)
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    expect(assign.mock.calls[0]![0]).toBe('https://x.test/app/?scene=demo')
    // the edit made just before pressing it is in the working copy the next boot adopts
    expect(savedProject()!.scene.parts.map((p) => p.id)).toEqual(['a', 'a2'])
    expect(store.demoSession).toBe(false) // nothing swapped in place: the page is what changes
  })

  it('booted over the project, it shows the demo and leaves the project untouched', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    bootDemo(store, plantProject())
    expect(store.demoSession).toBe(true)
    expect(store.getState().stProgram).toBe(DEMO_PROGRAM) // the demo's program came with it
    expect(store.getState().controller).toEqual(DEMO_CONTROLLER) // ...and the table that runs it as Main, every 10 ms
    expect(store.getState().scene.parts.length).toBeGreaterThan(0)
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull() // looking writes nothing
    expect(store.outgoingProject()?.scene.parts.map((p) => p.id)).toEqual(['a'])
  })

  it('forks into a project of their own once they edit it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const handed: ProjectJSON[] = []
    store.setDemoForkHost((outgoing) => {
      handed.push(JSON.parse(JSON.stringify(outgoing)) as ProjectJSON)
      return DEMO_SCENE_NAME
    })
    bootDemo(store, plantProject())
    const scene = store.getState().scene
    const nudged = scene.parts.map((p, i) =>
      i === 0 ? ({ ...p, position: [p.position[0] + 1, p.position[1], p.position[2]] } as PartInstance) : p,
    )
    store.commit('nudge', { ...scene, parts: nudged })
    expect(store.demoSession).toBe(false)
    expect(store.getState().projectName).toBe(DEMO_SCENE_NAME)
    expect(handed.map((p) => p.scene.parts.map((x) => x.id))).toEqual([['a']]) // theirs, untouched
    expect(store.getState().scene.parts[0]!.position[0]).toBe(scene.parts[0]!.position[0] + 1) // their edit kept
  })

  // The host may name the fork before the library's names are read, and renumber it after (demoFork.ts): the
  // toast still up must name the project as it now is, not the name it replaced.
  it('a late renumbering renames the fork and the notice that announced it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.setDemoForkHost(() => DEMO_SCENE_NAME)
    bootDemo(store, plantProject())
    store.keepDemoCopy()
    const before = store.getState().demoForkNotice!
    store.renameDemoFork(`${DEMO_SCENE_NAME} 2`)
    expect(store.getState().projectName).toBe(`${DEMO_SCENE_NAME} 2`)
    const after = store.getState().demoForkNotice!
    expect(after.title).toBe(`${DEMO_SCENE_NAME} 2 is now a project of your own`)
    expect(after.message).toContain(`“${plantProject().name}” is untouched`)
    expect(after.key).toBe(before.key) // the same toast, its words changed
  })

  // keepDemoCopy is the same fork without an edit (Save on the demo calls it).
  it('keepDemoCopy forks it without an edit', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const handed: ProjectJSON[] = []
    store.setDemoForkHost((outgoing) => {
      handed.push(JSON.parse(JSON.stringify(outgoing)) as ProjectJSON)
      return DEMO_SCENE_NAME
    })
    bootDemo(store, plantProject())
    store.keepDemoCopy()
    expect(store.demoSession).toBe(false)
    const saved = savedProject()!
    expect(saved.name).toBe(DEMO_SCENE_NAME)
    expect(saved.scene.parts.length).toBeGreaterThan(0) // the demo, kept
    expect(saved.stProgram).toBe(DEMO_PROGRAM) // with its program
    expect(saved.controller).toEqual(DEMO_CONTROLLER) // and its controller: the scan rate the cell needs
    expect(handed).toHaveLength(1)
    expect(handed[0]!.scene.parts.map((p) => p.id)).toEqual(['a']) // their work, untouched
    store.keepDemoCopy() // no session left: a second press is a no-op, not a second copy
    expect(handed).toHaveLength(1)
  })

  // Pressing Open Demo while the demo is open opens it again: rebuilt from source, never a second copy.
  it('pressing it again during the demo reloads into the demo again, minting nothing', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const assign = vi.fn()
    vi.stubGlobal('location', { href: 'https://x.test/app/?scene=demo', assign })
    const store = new EditorStore()
    const handed: ProjectJSON[] = []
    store.setDemoForkHost((outgoing) => {
      handed.push(outgoing)
      return DEMO_SCENE_NAME
    })
    bootDemo(store, plantProject())
    openDemoScene(store)
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    expect(assign.mock.calls[0]![0]).toBe('https://x.test/app/?scene=demo')
    expect(handed).toHaveLength(0)
    expect(store.demoSession).toBe(true)
  })
})

describe('EditorStore.loadStProgram (program of record)', () => {
  // Guards against a broadcast-only load, which takes effect only if an ST editor is mounted to hear it.
  // The PLC panel is mounted only while it's the front tab of its dock slot (DockSlot renders one
  // panel), so with it docked behind the Parts tab (where the tutorial leaves it) the tutorial's
  // program, an imported scene's program and a project load would write nowhere, and the
  // controller would attach the previous program on Play.
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('persists with no ST editor mounted', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadStProgram('Motor := Start;')
    expect(localStorage.getItem(ST_PROGRAM_KEY)).toBe('Motor := Start;')
  })

  it('still broadcasts to a mounted editor', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const seen: string[] = []
    store.onStProgramLoad((src) => seen.push(src))
    store.loadStProgram('demo program', { persist: false })
    store.loadStProgram('Motor := Start;')
    expect(seen).toEqual(['demo program', 'Motor := Start;'])
  })

  // The demo's paired program must reach a demo session's export and its room seed, not only the
  // attach path. persist:false makes it fully live (state, attach, export, seed) without writing it
  // to the user's saved document.
  it('a persist:false program is live in state but never written', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadStProgram('DEMO;', { persist: false })
    expect(store.getState().stProgram).toBe('DEMO;')
    expect(localStorage.getItem(ST_PROGRAM_KEY)).toBeNull()
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull()
  })

  it('carries a loaded project’s program across with no editor mounted', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(plantProject())
    expect(localStorage.getItem(ST_PROGRAM_KEY)).toBe('VAR x : BOOL; END_VAR')
    store.loadProject(otherProject())
    expect(localStorage.getItem(ST_PROGRAM_KEY)).toBe('') // Other has no program
  })

  it('folds a program-only change into the project autosave', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(plantProject())
    store.loadStProgram('Motor := Start;') // no scene commit to ride along with
    expect(savedProject()!.stProgram).toBe('Motor := Start;')
  })
})

describe('project tests in the store', () => {
  const graded = (): ProjectJSON => ({
    ...plantProject(),
    tests: [{ name: 'motor latches', duration: 1, checks: [{ tag: 'Motor', at: 0.5, equals: true }] }],
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('publishes the test count so a command can gate on it without a snapshot', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    expect(store.getState().testCount).toBe(0)
    store.loadProject(graded())
    expect(store.getState().testCount).toBe(1)
  })

  // the peek path takes ownership of the document without touching the live scene; its tests are still
  // the ones the command would run, so the count has to be published before the early return
  it('publishes the count on an adoptOnly load too', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(graded(), { adoptOnly: true })
    expect(store.getState().testCount).toBe(1)
  })

  it('carries the tests through an autosave round-trip', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(graded())
    store.loadStProgram('Motor := Start;') // any edit, to force the persist
    expect(savedProject()!.tests).toHaveLength(1)
  })

  it('keeps them on the snapshot the run reads', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(graded())
    expect(store.snapshotProject().tests?.[0]!.name).toBe('motor latches')
  })

  it('saveProjectTest keeps a test, replacing one of the same name, and persists it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadProject(graded())
    expect(store.saveProjectTest({ name: 'motor latches', duration: 2, checks: [{ tag: 'Motor', at: 1, equals: true }] })).toBe(true)
    expect(store.saveProjectTest({ name: 'second', duration: 1, checks: [{ tag: 'Motor', at: 0.5, equals: false }] })).toBe(true)
    expect(store.getState().testCount).toBe(2)
    const saved = savedProject()!
    expect(saved.tests?.map((t) => [t.name, t.duration])).toEqual([
      ['motor latches', 2],
      ['second', 1],
    ])
  })
})
