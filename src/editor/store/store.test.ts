import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOOR_SURFACE_Y, SCENE_VERSION } from '../../core/types'
import type { SdkPart, PartInstance, SceneJSON } from '../../core/types'
import { partFootprint } from '../../core/parts/partGeometry'
import { partDisplayName } from '../../core/parts/partDisplayName'
import { EditorStore, documentSceneOf, GRIDSNAP_KEY, SPACE_KEY, USERPKG_KEY, VSNAP_COLLISION_KEY, VSNAP_ORIGIN_KEY, editStack, editTarget, editTargetFocusId, rigNodeKey } from './store'
import { assembleProject, loadStoredProject, PROJECT_KEY } from '../project/projectFile'

/**
 * The scene a reload would restore: the project document's active scene. Not the legacy
 * `oip-web/autosave` key - that is a fallback for a pre-project browser or an unparseable project doc
 * (projectFile.readLegacyScene), and since it costs a full serialisation it is refreshed on a
 * throttle rather than on every commit (store.persist). The project doc is the primary and is exact.
 */
function reloadedScene(): SceneJSON {
  const doc = JSON.parse(localStorage.getItem(PROJECT_KEY) ?? '{}') as { scene?: SceneJSON }
  return doc.scene ?? ({ version: SCENE_VERSION, parts: [] } as SceneJSON)
}
import { getPackage, registerPackage, setBuiltInPackages, unregisterPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

function pkg(id: string, behavior: string): PartPackage {
  return { format: PACKAGE_FORMAT, id, name: id, params: {}, behavior, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }
}

// A generic movable leaf part used as an opaque scene fixture across the store tests - a `custom` part so it
// stays distinct from the Group containers the hierarchy tests wrap it in. The store treats params as a bag (commit + loadScene don't normalize against a
// package schema, and this test.belt packageId is intentionally unregistered so it yields no specs), so the
// `speed` param below is a stand-in "an editable numeric param" - its exact shape is irrelevant to what
// these tests exercise (subtree capture, id remap, undo). Cast through unknown because the bag isn't the package's baked schema.
function part(id: string, x = 0): PartInstance {
  return {
    id,
    type: 'part',
    packageId: 'test.belt',
    position: [x, 0.75, 0],
    rotationY: 0,
    params: { length: 3, width: 0.6, speed: 0.5, rollerClass: 'light', leftGuard: true, rightGuard: true },
  } as unknown as PartInstance
}

function scene(...parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** in-memory Storage for the persistence tests (the Node test env has no localStorage) */
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

// a Group container + two child parts, the canonical subtree
function groupNode(id: string, x = 0): PartInstance {
  return { id, type: 'group', position: [x, 0, 0], rotationY: 0, params: {} } as PartInstance
}
function child(id: string, parent: string, x: number): PartInstance {
  return { ...part(id, x), parent } as PartInstance
}

describe('EditorStore unparent (the top of the document being edited)', () => {
  const tree = (): EditorStore => {
    const store = new EditorStore()
    store.loadScene(scene(part('f'), child('a', 'f', 1), child('b', 'a', 2)))
    return store
  }
  const parentOf = (store: EditorStore, id: string) => store.getState().scene.parts.find((p) => p.id === id)!.parent

  it('lifts to the scene root at the base scene', () => {
    const store = tree()
    store.unparent(['b'])
    expect(parentOf(store, 'b')).toBeUndefined()
  })

  it('lifts to the focused part inside a part-scene, and leaves the focused part where it is', () => {
    const store = tree()
    store.enterPartFocus('f')
    store.unparent(['b', 'f'])
    expect(parentOf(store, 'b')).toBe('f')
    expect(parentOf(store, 'f')).toBeUndefined()
  })

  it('reads a drop before/after the focused part as a drop into it (its siblings are not in the dock)', () => {
    const store = tree()
    store.enterPartFocus('f')
    store.moveInTree(['b'], 'f', 'before')
    expect(parentOf(store, 'b')).toBe('f')
    store.reparent(['b'], 'a')
    store.moveInTree(['b'], 'f', 'after')
    expect(parentOf(store, 'b')).toBe('f')
  })

  it('Reparent to New Node wraps a cross-branch selection under the focused part, never the focused part itself', () => {
    const store = tree()
    store.enterPartFocus('f')
    const s0 = store.getState().scene
    store.commit('add', { ...s0, parts: [...s0.parts, child('c', 'f', 3)] })
    store.selectMany(['b', 'c']) // parents a and f: a cross-branch selection
    store.reparentToNewNode()
    const node = store.getState().scene.parts.find((p) => p.id === store.getState().selectedIds[0])!
    expect(node.type).toBe('group')
    expect(node.parent).toBe('f')

    const wrapped = store.getState().scene
    store.selectMany(['f'])
    store.reparentToNewNode()
    expect(store.getState().scene).toBe(wrapped)
  })
})

describe('EditorStore editTarget for part-focus', () => {
  afterEach(() => {
    unregisterPackage('x.deck')
  })

  it('derives a part-focus target for a focused custom part', () => {
    const store = new EditorStore()
    const deck = pkg('x.deck', 'definePart({ step() {} })')
    registerPackage(deck)
    const custom = { id: 'cp_1', type: 'part', packageId: 'x.deck', position: [0, 0, 0], rotationY: 0, params: {} } as PartInstance
    store.loadScene({ version: SCENE_VERSION, parts: [custom], packages: [deck] } as SceneJSON)
    store.enterPartFocus('cp_1')
    const t = editTarget(store.getState())
    expect(t).toEqual({ kind: 'part-focus', id: 'cp_1' })
    expect(editTargetFocusId(t!)).toBe('cp_1')
    expect(editStack(store.getState())).toHaveLength(1)
  })
})

describe('EditorStore package-edit session (edit a part package rig with no placement)', () => {
  afterEach(() => {
    unregisterPackage('pe.part')
  })

  function withPackage(): EditorStore {
    const store = new EditorStore()
    registerPackage(pkg('pe.part', 'definePart({ step() {} })'))
    store.loadScene(scene(part('rc_1', 0)))
    return store
  }

  it('stamps a throwaway custom instance at the origin and focuses it as a package-edit target', () => {
    const store = withPackage()
    const document = store.getState().scene
    expect(store.enterPackageEdit('pe.part')).toBe(true)
    const s = store.getState()
    expect(s.packageEdit?.packageId).toBe('pe.part')
    // the session's own scene holds only the throwaway; the document's scene is parked, untouched
    expect(s.scene.parts.map((p) => p.id)).toEqual([s.packageEdit!.partId])
    expect(s.packageEdit!.document).toBe(document)
    expect(documentSceneOf(s)).toBe(document)
    const draft = s.scene.parts.find((p) => p.id === s.packageEdit!.partId)!
    expect(draft.type).toBe('part')
    // at the origin in x/z, resting on the floor in y: the 0.1-thick deck's underside sits at y=0
    expect(draft.position[0]).toBe(0)
    expect(draft.position[2]).toBe(0)
    expect(draft.position[1] + partFootprint(draft).y0).toBeCloseTo(0, 9)
    expect(s.focusedPartId).toBe(draft.id)
    expect(editTarget(s)).toEqual({ kind: 'package-edit', packageId: 'pe.part', partId: draft.id })
    expect(editTargetFocusId(editTarget(s)!)).toBe(draft.id)
  })

  it('seats a conveyor-mounted rig on the floor, not through it (the Diverter in its own scene)', () => {
    // a rig whose origin is the belt surface: its housing hangs to bounds.floorY, so a raw y=0 stamp would bury
    // it 0.4 m under the floor. The throwaway must rest that true underside on the floor instead.
    const mounted = {
      format: PACKAGE_FORMAT,
      id: 'pe.mounted',
      name: 'pe.mounted',
      params: {},
      behavior: 'definePart({ step() {} })',
      geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 0.73, width: 2.36, top: 0.82, bottom: -0.3847 } },
    } as unknown as PartPackage
    registerPackage(mounted)
    try {
      const store = new EditorStore()
      store.loadScene(scene(part('rc_1', 0)))
      expect(store.enterPackageEdit('pe.mounted')).toBe(true)
      const s = store.getState()
      const draft = s.scene.parts.find((p) => p.id === s.packageEdit!.partId)!
      expect(draft.position[1]).toBeCloseTo(0.3847, 9)
      expect(draft.position[1] + partFootprint(draft).y0).toBeCloseTo(0, 9) // underside exactly on the floor
    } finally {
      unregisterPackage('pe.mounted')
    }
  })

  it('stands a legged deck on its legs (rest: surfaceBelow), not sunk to y=0', () => {
    const legged = {
      format: PACKAGE_FORMAT,
      id: 'pe.legged',
      name: 'pe.legged',
      params: { standHeight: { type: 'number', default: 0.75, rest: 'surfaceBelow' } },
      behavior: 'definePart({ step() {} })',
      geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.05, bottom: -0.1 } },
    } as unknown as PartPackage
    registerPackage(legged)
    try {
      const store = new EditorStore()
      store.loadScene(scene(part('rc_1', 0)))
      expect(store.enterPackageEdit('pe.legged')).toBe(true)
      const s = store.getState()
      const draft = s.scene.parts.find((p) => p.id === s.packageEdit!.partId)!
      expect(draft.position[1]).toBeCloseTo(FLOOR_SURFACE_Y + 0.75, 9) // deck up where its legs reach the floor
    } finally {
      unregisterPackage('pe.legged')
    }
  })

  it('keeps the throwaway out of the autosave (reload-safe)', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = withPackage()
    expect(store.enterPackageEdit('pe.part')).toBe(true)
    const partId = store.getState().packageEdit!.partId
    expect(store.getState().scene.parts.some((p) => p.id === partId)).toBe(true) // present in the live scene
    const saved = reloadedScene()
    expect(saved.parts.some((p) => p.id === partId)).toBe(false) // but stripped from the durable doc
  })

  it('Back (exitPartFocus) removes the throwaway, leaving the scene exactly as it was', () => {
    const store = withPackage()
    const beforeIds = store.getState().scene.parts.map((p) => p.id)
    store.enterPackageEdit('pe.part')
    store.exitPartFocus()
    const s = store.getState()
    expect(s.packageEdit).toBeNull()
    expect(s.focusedPartId).toBeNull()
    expect(s.scene.parts.map((p) => p.id)).toEqual(beforeIds)
    expect(editTarget(s)).toBeNull()
  })

  it('keeps package edits made during the session - they go to the registry, not the draft', () => {
    const store = withPackage()
    store.enterPackageEdit('pe.part')
    const edited = { ...getPackage('pe.part')!, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.05, bottom: -0.1 } } } as PartPackage
    store.commitPackage('Edit rig', edited)
    store.exitPartFocus()
    expect((getPackage('pe.part')!.geometry as { bounds: { length: number } }).bounds.length).toBe(2)
  })

  it('undo after Back never brings the throwaway back into the scene or the saved document', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = withPackage()
    const beforeIds = store.getState().scene.parts.map((p) => p.id)
    store.enterPackageEdit('pe.part')
    const draftId = store.getState().packageEdit!.partId
    // a scene step taken inside the session holds the throwaway in both its snapshots
    const s = store.getState().scene
    store.commit('Move', { ...s, parts: s.parts.map((p) => (p.id === draftId ? { ...p, position: [1, p.position[1], 0] as [number, number, number] } : p)) })
    store.exitPartFocus()
    // after every step, not just the last: guards against the first Ctrl+Z after Back restoring it
    const steps = [() => store.undo(), () => store.undo(), () => store.undo(), () => store.redo(), () => store.redo(), () => store.redo()]
    for (const step of steps) {
      step()
      expect(store.getState().scene.parts.map((p) => p.id)).toEqual(beforeIds)
      expect(reloadedScene().parts.some((p) => p.id === draftId)).toBe(false)
    }
  })

  it('the throwaway is the session’s, not the document’s: stamping, moving and removing it are no undo step', () => {
    const store = withPackage()
    const undoable = store.canUndo
    store.enterPackageEdit('pe.part')
    const draftId = store.getState().packageEdit!.partId
    const s = store.getState().scene
    store.commit('Move', { ...s, parts: s.parts.map((p) => (p.id === draftId ? { ...p, position: [1, p.position[1], 0] as [number, number, number] } : p)) })
    expect(store.canUndo).toBe(undoable) // nothing in the history holds it
    // an undo of a package edit inside the session leaves the throwaway where it is
    store.commitPackage('Edit behavior', { ...getPackage('pe.part')!, behavior: 'definePart({ step() { /* v2 */ } })' })
    store.undo()
    expect(getPackage('pe.part')!.behavior).toBe('definePart({ step() {} })')
    expect(store.getState().scene.parts.some((p) => p.id === draftId)).toBe(true)
    store.exitPartFocus()
    expect(store.canUndo).toBe(undoable)
  })

  it('renaming the part is an undo step, and the unnamed throwaway is labelled by it throughout', () => {
    const store = withPackage()
    store.enterPackageEdit('pe.part')
    const draftId = store.getState().packageEdit!.partId
    const label = () => partDisplayName(store.getState().scene.parts.find((p) => p.id === draftId)!, store.getState().scene.parts)
    expect(store.getState().scene.parts.find((p) => p.id === draftId)!.name).toBeUndefined()
    const before = getPackage('pe.part')!
    store.commitPackage('Rename part', { ...before, name: 'Lift Table', category: 'Devices' })
    expect(label()).toBe('Lift Table')
    store.undo() // a name/category-only change is a real step, not skipped as a no-op
    expect(getPackage('pe.part')!.name).toBe(before.name)
    expect(getPackage('pe.part')!.category).toBe(before.category)
    expect(label()).toBe(before.name)
  })

  it('an undo of an edit made outside the part leaves the session and undoes it in the document', () => {
    const store = withPackage()
    const s0 = store.getState().scene
    store.commit('Move', { ...s0, parts: s0.parts.map((p) => ({ ...p, position: [3, p.position[1], 0] as [number, number, number] })) })
    const moved = store.getState().scene
    store.enterPackageEdit('pe.part')
    store.commitPackage('Edit behavior', { ...getPackage('pe.part')!, behavior: 'definePart({ step() { /* v2 */ } })' })
    store.undo() // the package edit: still in the session
    expect(store.getState().packageEdit).not.toBeNull()
    expect(documentSceneOf(store.getState())).toBe(moved)
    store.undo() // the factory move: the session closes, and the document goes back
    const s = store.getState()
    expect(s.packageEdit).toBeNull()
    expect(s.scene.parts.map((p) => p.position[0])).toEqual(s0.parts.map((p) => p.position[0]))
  })

  it('loading a scene ends a session: the document it parked is the one being replaced', () => {
    const store = withPackage()
    store.enterPackageEdit('pe.part')
    store.loadScene(scene(part('other', 0)))
    const s = store.getState()
    expect(s.packageEdit).toBeNull()
    expect(s.focusedPartId).toBeNull()
    store.exitPartFocus() // nothing to put back
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['other'])
  })

  it('keeps the session’s package edits undoable after Back', () => {
    const store = withPackage()
    store.enterPackageEdit('pe.part')
    const edited = { ...getPackage('pe.part')!, name: 'renamed' }
    store.commitPackage('Edit rig', { ...edited, behavior: 'definePart({ step() { /* v2 */ } })' })
    store.exitPartFocus()
    store.undo()
    expect(getPackage('pe.part')!.behavior).toBe('definePart({ step() {} })')
    expect(store.getState().scene.parts.some((p) => p.type === 'part' && (p as SdkPart).packageId === 'pe.part')).toBe(false)
  })

  it('clears a stranded session without error (throwaway removed out from under it)', () => {
    const store = withPackage()
    store.enterPackageEdit('pe.part')
    const partId = store.getState().packageEdit!.partId
    // simulate an undo stranding the throwaway: drop it from the scene, then hit Back
    store.commit('strand', { ...store.getState().scene, parts: store.getState().scene.parts.filter((p) => p.id !== partId) })
    store.exitPartFocus()
    expect(store.getState().packageEdit).toBeNull()
  })

  it("opens in a collaborative room, where a peer's scene lands in the parked document", () => {
    const store = withPackage()
    store.setCollabMode(true)
    expect(store.enterPackageEdit('pe.part')).toBe(true)
    const session = store.getState().scene
    const peer = { ...store.getState().packageEdit!.document, parts: [] }
    store.applyRemote(peer)
    expect(store.getState().scene).toBe(session) // the session is undisturbed
    expect(store.getState().packageEdit?.document).toBe(peer)
    store.exitPartFocus()
    expect(store.getState().scene).toBe(peer)
  })
})

describe('EditorStore bundled-package copy-on-write', () => {
  afterEach(() => {
    unregisterPackage('oip.demo')
  })

  it('forks a bundled-example edit into the user library so it survives reload', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const bundled = pkg('oip.demo', 'definePart({ step() {} })')
    registerPackage(bundled)
    store.setBundledPackages([bundled])
    expect(store.getState().userPackages).toHaveLength(0) // not a user part yet

    // edit the bundled package's behavior via the real commit path
    store.commitPackage('edit bundled', { ...bundled, behavior: bundled.behavior + '\n// edited' })

    // copy-on-write: it's now in the user library AND persisted, in the project doc
    const forked = store.getState().userPackages.find((p) => p.id === 'oip.demo')
    expect(forked?.behavior).toContain('// edited')

    // a fresh session restores the edited copy, shadowing the pristine bundle by id
    const s2 = new EditorStore()
    s2.loadProject(loadStoredProject()!.project)
    expect(s2.getState().userPackages.find((p) => p.id === 'oip.demo')?.behavior).toContain('// edited')
  })
})

describe('EditorStore removeUserPackage (delete a custom part from the library)', () => {
  afterEach(() => {
    for (const id of ['user.gone', 'user.used', 'user.cell', 'user.room', 'user.editing', 'oip.revert']) unregisterPackage(id)
  })

  const customInstance = (id: string, packageId: string): PartInstance =>
    ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: {} }) as PartInstance

  it('deletes an unused authored part: catalog, registry and localStorage all drop it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const p = pkg('user.gone', 'definePart({ step() {} })')
    registerPackage(p, true)
    store.addUserPackage(p)
    expect(store.removeUserPackage('user.gone')).toBe(true)
    expect(store.getState().userPackages).toHaveLength(0)
    expect(getPackage('user.gone')).toBeUndefined()
    expect(localStorage.getItem(USERPKG_KEY)).toBeNull()
  })

  it('refuses while the active scene still places the part', () => {
    const store = new EditorStore()
    const p = pkg('user.used', 'definePart({ step() {} })')
    registerPackage(p, true)
    store.addUserPackage(p)
    store.loadScene({ version: SCENE_VERSION, parts: [customInstance('cp_1', 'user.used')], packages: [p] } as SceneJSON)
    expect(store.packageUsage('user.used')).toHaveLength(1)
    expect(store.packageUsage('user.used')[0]).toMatch(/scene/)
    expect(store.removeUserPackage('user.used')).toBe(false)
    expect(store.getState().userPackages).toHaveLength(1)
    expect(getPackage('user.used')).toBeDefined()
  })

  it('a bundled fork reverts to the pristine example, and its purged history can’t re-fork it', () => {
    const store = new EditorStore()
    const bundled = pkg('oip.revert', 'definePart({ step() {} })')
    registerPackage(bundled, true)
    store.setBundledPackages([bundled])
    store.commitPackage('edit bundled', { ...bundled, behavior: bundled.behavior + '\n// edited' })
    expect(store.getState().userPackages).toHaveLength(1) // copy-on-write forked
    expect(store.removeUserPackage('oip.revert')).toBe(true)
    expect(store.getState().userPackages).toHaveLength(0)
    expect(getPackage('oip.revert')?.behavior).not.toContain('// edited') // the pristine bundle is live again
    store.undo() // the fork's package-edit entries were purged with it
    expect(store.getState().userPackages).toHaveLength(0)
    expect(getPackage('oip.revert')?.behavior).not.toContain('// edited')
  })

  it('in a room, takes it out and tells the room', () => {
    const store = new EditorStore()
    const p = pkg('user.room', 'definePart({ step() {} })')
    registerPackage(p, true)
    store.addUserPackage(p)
    store.setCollabMode(true)
    const removed: [string, unknown][] = []
    store.setPackageSink(() => {}, (id, revertTo) => void removed.push([id, revertTo]))
    expect(store.removeUserPackage('user.room')).toBe(true)
    expect(store.getState().userPackages).toHaveLength(0)
    expect(removed).toEqual([['user.room', null]])
  })

  it('refuses while the part is open for editing (its throwaway lives in the scene)', () => {
    const store = new EditorStore()
    const p = pkg('user.editing', 'definePart({ step() {} })')
    registerPackage(p, true)
    store.addUserPackage(p)
    store.loadScene(scene())
    expect(store.enterPackageEdit('user.editing')).toBe(true)
    expect(store.removeUserPackage('user.editing')).toBe(false)
    expect(store.getState().userPackages).toHaveLength(1)
  })
})

describe('EditorStore renameUserPackage (a project part moves to a new id, docs/parts-shelf.md "Identity")', () => {
  const ids = ['acme.transfer', 'acme.transfer-2', 'acme.holder', 'oip.builtin', 'user.other']
  afterEach(() => {
    for (const id of ids) unregisterPackage(id)
    vi.unstubAllGlobals()
  })

  const placed = (id: string, packageId: string): PartInstance =>
    ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: {} }) as PartInstance

  function withPlaced(): EditorStore {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const p = pkg('acme.transfer', 'definePart({ step() {} })')
    registerPackage(p, true)
    store.addUserPackage(p)
    store.loadScene({ version: SCENE_VERSION, parts: [placed('cp_1', 'acme.transfer')], packages: [p] } as SceneJSON)
    return store
  }

  it('moves the library entry, the registry and every placed copy, and frees the old id', () => {
    const store = withPlaced()
    expect(store.renameUserPackage('acme.transfer', 'acme.transfer-2')).toBe('')
    const s = store.getState()
    expect(s.userPackages.map((p) => p.id)).toEqual(['acme.transfer-2'])
    expect(s.scene.parts.map((p) => (p as SdkPart).packageId)).toEqual(['acme.transfer-2'])
    expect(getPackage('acme.transfer-2')).toBeDefined()
    expect(getPackage('acme.transfer')).toBeUndefined()
    // the project doc is written with both, so a reload opens the renamed part placed
    const reopened = new EditorStore()
    reopened.loadProject(loadStoredProject()!.project)
    expect(reopened.getState().scene.parts.map((p) => (p as SdkPart).packageId)).toEqual(['acme.transfer-2'])
  })

  it('rewrites the undo history, so undoing an earlier step never brings back the old id', () => {
    const store = withPlaced()
    const s0 = store.getState().scene
    store.commit('Add second', { ...s0, parts: [...s0.parts, placed('cp_2', 'acme.transfer')] })
    expect(store.renameUserPackage('acme.transfer', 'acme.transfer-2')).toBe('')
    store.undo()
    expect(store.getState().scene.parts.map((p) => (p as SdkPart).packageId)).toEqual(['acme.transfer-2'])
    store.redo()
    expect(store.getState().scene.parts.map((p) => (p as SdkPart).packageId)).toEqual(['acme.transfer-2', 'acme.transfer-2'])
  })

  it('refuses a taken or malformed id, a built-in copy, a part another part names, and a running sim', () => {
    const store = withPlaced()
    const other = pkg('user.other', 'definePart({ step() {} })')
    registerPackage(other, true)
    store.addUserPackage(other)
    expect(store.renameUserPackage('acme.transfer', 'user.other')).toMatch(/already exists/)
    expect(store.renameUserPackage('acme.transfer', 'has space')).toMatch(/letters, digits/)

    const holder = { ...pkg('acme.holder', 'definePart({ step() {} })'), holds: { part: 'acme.transfer' } } as unknown as PartPackage
    store.addUserPackage(holder)
    expect(store.renameUserPackage('acme.transfer', 'acme.transfer-2')).toMatch(/names/)
    store.removeUserPackage('acme.holder')

    store.setRunning(true)
    expect(store.renameUserPackage('acme.transfer', 'acme.transfer-2')).toMatch(/Stop/)
    store.setRunning(false)

    const builtIn = pkg('oip.builtin', 'definePart({ step() {} })')
    registerPackage(builtIn, true)
    store.setBundledPackages([builtIn])
    store.addUserPackage(builtIn)
    expect(store.renameUserPackage('oip.builtin', 'acme.builtin')).toMatch(/built-in/)
    expect(store.getState().scene.parts.map((p) => (p as SdkPart).packageId)).toEqual(['acme.transfer'])
  })

  it('refuses in a room (the package sink has no removal channel)', () => {
    const store = withPlaced()
    store.setCollabMode(true)
    expect(store.renameUserPackage('acme.transfer', 'acme.transfer-2')).toMatch(/shared project/)
    expect(store.getState().userPackages.map((p) => p.id)).toEqual(['acme.transfer'])
  })
})

describe('EditorStore internal partRef rewiring on copy', () => {
  // a custom feeder with a conveyorId partRef param (a spawner's interlock wire), so the rewiring is
  // exercised through an SDK part's partRef param
  const SPAWNER_PKG = 'test.feeder'
  const feederPkg: PartPackage = {
    format: PACKAGE_FORMAT,
    id: SPAWNER_PKG,
    name: 'Test Feeder',
    params: { conveyorId: { type: 'partRef', default: '' } },
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
  beforeEach(() => registerPackage(feederPkg))
  afterEach(() => {
    unregisterPackage(SPAWNER_PKG)
  })

  // a custom feeder whose conveyorId partRef points at `conveyorId`; scenes must embed the package
  function spawner(id: string, conveyorId: string, x = 0, parent?: string): PartInstance {
    return {
      id,
      type: 'part',
      packageId: SPAWNER_PKG,
      position: [x, 0.5, 0],
      rotationY: 0,
      ...(parent ? { parent } : {}),
      params: { conveyorId },
    } as unknown as PartInstance
  }
  // scene builder that embeds the feeder package so loadScene keeps the custom part
  const sc = (...parts: PartInstance[]): SceneJSON => ({ version: SCENE_VERSION, parts, packages: [feederPkg] })
  it('duplicate rewires an internal spawner→conveyor ref onto the copy', () => {
    const store = new EditorStore()
    // two roots: a belt + a spawner wired to it
    store.loadScene(sc(part('rc_1', 0), spawner('sp_1', 'rc_1', 1)))
    store.selectMany(['rc_1', 'sp_1'])
    store.duplicateSelection()

    const stamped = store.getState().scene.parts.filter((p) => !['rc_1', 'sp_1'].includes(p.id))
    // both are `custom` parts now; the belt fixture (part()) carries the test.belt package, the spawner its own
    const newBelt = stamped.find((p) => (p as SdkPart).packageId === 'test.belt')!
    const newSpawner = stamped.find((p) => (p as SdkPart).packageId === SPAWNER_PKG)!
    // the copy's spawner points at the copy's belt, not the original rc_1
    expect((newSpawner.params as unknown as Record<string, string>).conveyorId).toBe(newBelt.id)
    expect((newSpawner.params as unknown as Record<string, string>).conveyorId).not.toBe('rc_1')
  })
})

describe('EditorStore setAuthored', () => {
  it('setAuthored updates the scene without adding an undo entry', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    expect(store.canUndo).toBe(false)
    store.setAuthored(scene(part('rc_1', 5)))
    expect(store.getState().scene.parts[0]!.position[0]).toBe(5)
    expect(store.canUndo).toBe(false) // no history entry
  })
})

// The edit gate (commit's documentChanged): only a change to the document is an edit. The parts the run owns
// (LiveCargoHost.runScopedIds: boxes promoted, dropped or copied mid-run) are sim state, not document, so a
// change confined to them gets no undo step and no autosave, and the history never holds them.
describe('EditorStore edit gate', () => {
  /** a store mid-run whose live-cargo host says the run owns `ids` */
  function midRun(s: SceneJSON, ids: string[]): { store: EditorStore; owned: Set<string> } {
    const store = new EditorStore()
    store.loadScene(s)
    const owned = new Set(ids)
    store.setLiveCargoHost({ pose: () => null, runScoped: (more) => more.forEach((id) => owned.add(id)), runScopedIds: () => owned })
    return { store, owned }
  }
  const movedTo = (s: SceneJSON, id: string, x: number): SceneJSON => ({
    ...s,
    parts: s.parts.map((p) => (p.id === id ? ({ ...p, position: [x, p.position[1], p.position[2]] } as PartInstance) : p)),
  })
  const without = (s: SceneJSON, id: string): SceneJSON => ({ ...s, parts: s.parts.filter((p) => p.id !== id) })

  it('moving or deleting only a run-owned box is no edit: shown, but no undo step and no autosave', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const { store } = midRun(scene(part('rc_1'), part('bx_run', 2)), ['bx_run'])
    const saved = localStorage.getItem(PROJECT_KEY)
    expect(saved).not.toBeNull() // loadScene wrote it, so "unchanged" below means something
    store.commit('Move part', movedTo(store.getState().scene, 'bx_run', 5))
    expect(store.getState().scene.parts.find((p) => p.id === 'bx_run')!.position[0]).toBe(5) // on screen
    store.commit('Delete part', without(store.getState().scene, 'bx_run'))
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1'])
    expect(store.canUndo).toBe(false)
    expect(localStorage.getItem(PROJECT_KEY)).toBe(saved)
    // ...while the same gesture on a part the run does not own is an edit, and is saved
    store.commit('Move part', movedTo(store.getState().scene, 'rc_1', 3))
    expect(store.canUndo).toBe(true)
    expect(localStorage.getItem(PROJECT_KEY)).not.toBe(saved)
  })

  it('a re-commit of the unchanged scene is no edit', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    store.commit('Nothing', store.getState().scene)
    expect(store.canUndo).toBe(false)
  })

  it('a mixed edit is an edit; undone mid-run it keeps the live box where the run has it', () => {
    const { store } = midRun(scene(part('rc_1'), part('bx_run', 2)), ['bx_run'])
    store.commit('Move parts', movedTo(movedTo(store.getState().scene, 'rc_1', 1), 'bx_run', 5))
    expect(store.canUndo).toBe(true)
    store.undo()
    const parts = store.getState().scene.parts
    expect(parts.find((p) => p.id === 'rc_1')!.position[0]).toBe(0) // the conveyor goes back...
    expect(parts.find((p) => p.id === 'bx_run')!.position[0]).toBe(5) // ...the body's box stays put
  })

  it('an undo or redo after Stop cannot bring back a box the run owned', () => {
    const { store, owned } = midRun(scene(part('rc_1'), part('bx_run', 2)), ['bx_run'])
    store.commit('Move parts', movedTo(movedTo(store.getState().scene, 'rc_1', 1), 'bx_run', 5))
    // Stop, as the controller does it: drop the run's parts, then forget them
    store.setAuthored(without(store.getState().scene, 'bx_run'))
    owned.clear()
    store.undo()
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1'])
    store.redo()
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1'])
  })

  it('a clicked, dragged and Stop-dropped box leaves the demo view unforked; a real edit forks it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.enterDemoSession(scene(part('rc_1')), '', { bank: false })
    const owned = new Set(['bx_run'])
    store.setLiveCargoHost({ pose: () => null, runScoped: () => {}, runScopedIds: () => owned })
    store.setRunScene({ ...store.getState().scene, parts: [...store.getState().scene.parts, part('bx_run', 2)] }) // clicked
    store.commit('Move part', movedTo(store.getState().scene, 'bx_run', 5)) // dragged mid-run
    store.setAuthored(without(store.getState().scene, 'bx_run')) // Stop
    expect(store.getState().demoSession).toBe(true)
    expect(localStorage.getItem(PROJECT_KEY)).toBeNull()
    store.commit('Move part', movedTo(store.getState().scene, 'rc_1', 3))
    expect(store.getState().demoSession).toBe(false)
    expect(localStorage.getItem(PROJECT_KEY)).not.toBeNull()
  })
})

// A placed box's pose belongs to physics while the sim runs (core/frame CargoPose, docs/document-and-run.md):
// moving it then is operating, and Stop puts it back. Its settings and its existence stay authoring, and a move of
// an ancestor (a pallet-load group) carries its designed pose with it.
describe('EditorStore placed boxes mid-run', () => {
  const CARGO: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 'test.cargo',
    name: 'Box',
    params: { color: { type: 'string', default: '#aaaaaa' } }, // declared, or the save drops it
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.4, width: 0.3, height: 0.3 } },
  }
  const cargo = (id: string, x: number, parent?: string): PartInstance =>
    ({ id, type: 'part', packageId: 'test.cargo', position: [x, 1, 0], rotationY: 0, params: { color: '#aaaaaa' }, ...(parent ? { parent } : {}) }) as unknown as PartInstance
  const posed = (s: SceneJSON, id: string, position: [number, number, number], rotationY = 0): SceneJSON => ({
    ...s,
    parts: s.parts.map((p) => (p.id === id ? ({ ...p, position, rotationY } as PartInstance) : p)),
  })
  const at = (store: EditorStore, id: string): PartInstance => store.getState().scene.parts.find((p) => p.id === id)!
  /** the part `id` as the autosave holds it */
  const saved = (id: string): { position: number[]; params: Record<string, unknown> } | null => {
    const find = (v: unknown): { position: number[]; params: Record<string, unknown> } | null => {
      if (Array.isArray(v)) for (const x of v) { const r = find(x); if (r) return r }
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        if (o.id === id && Array.isArray(o.position)) return o as unknown as { position: number[]; params: Record<string, unknown> }
        for (const x of Object.values(o)) { const r = find(x); if (r) return r }
      }
      return null
    }
    const raw = localStorage.getItem(PROJECT_KEY)
    return raw ? find(JSON.parse(raw)) : null
  }
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage())
    registerPackage(CARGO)
  })
  afterEach(() => unregisterPackage('test.cargo'))

  it('moving a placed box mid-run is no edit, and Stop puts it back where it was placed', () => {
    const store = new EditorStore()
    store.loadScene(scene(cargo('bx_1', 1)))
    store.setRunning(true)
    store.commit('Move part', posed(store.getState().scene, 'bx_1', [5, 1, 0], 1))
    expect(at(store, 'bx_1').position[0]).toBe(5) // shown where the gesture left it
    expect(store.canUndo).toBe(false)
    store.setRunning(false)
    expect(at(store, 'bx_1').position).toEqual([1, 1, 0])
    expect(at(store, 'bx_1').rotationY).toBe(0)
    expect(saved('bx_1')!.position).toEqual([1, 1, 0])
  })

  it("editing a placed box's settings mid-run is an edit, saved with its designed pose and kept at Stop", () => {
    const store = new EditorStore()
    store.loadScene(scene(cargo('bx_1', 1)))
    store.setRunning(true)
    store.commit('Move part', posed(store.getState().scene, 'bx_1', [5, 1, 0]))
    const s = store.getState().scene
    store.commit('Color', { ...s, parts: s.parts.map((p) => (p.id === 'bx_1' ? ({ ...p, params: { ...p.params, color: '#ff0000' } } as PartInstance) : p)) })
    expect(store.canUndo).toBe(true)
    expect(saved('bx_1')).toMatchObject({ position: [1, 1, 0], params: { color: '#ff0000' } })
    store.setRunning(false)
    expect(at(store, 'bx_1').position).toEqual([1, 1, 0])
    expect((at(store, 'bx_1').params as Record<string, unknown>).color).toBe('#ff0000')
  })

  it('deleting a placed box mid-run is an edit (whether it exists is design)', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1'), cargo('bx_1', 1)))
    store.setRunning(true)
    const s = store.getState().scene
    store.commit('Delete part', { ...s, parts: s.parts.filter((p) => p.id !== 'bx_1') })
    expect(store.canUndo).toBe(true)
    expect(saved('bx_1')).toBeNull()
  })

  it('a box moved on its own in the same drag as a conveyor still goes back at Stop', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1'), cargo('bx_1', 1)))
    store.setRunning(true)
    store.commit('Move parts', posed(posed(store.getState().scene, 'rc_1', [3, 0.75, 0]), 'bx_1', [6, 1, 0]))
    expect(store.canUndo).toBe(true) // the conveyor moved: an edit...
    expect(saved('bx_1')!.position).toEqual([1, 1, 0]) // ...that doesn't take the box's start with it
    store.setRunning(false)
    expect(at(store, 'bx_1').position).toEqual([1, 1, 0])
    expect(at(store, 'rc_1').position[0]).toBe(3)
  })

  it('a group moved mid-run carries its box: Stop puts the box back on the moved group, from its designed pose', () => {
    const store = new EditorStore()
    store.loadScene(scene(groupNode('g_1'), cargo('bx_1', 1, 'g_1')))
    store.setRunning(true)
    store.commit('Move part', posed(store.getState().scene, 'bx_1', [4, 1, 0])) // operated: the run has it at x=4
    // move the group +2 in x and turn it 90°, carrying the box (from wherever the run had it)
    store.commit('Move part', posed(posed(store.getState().scene, 'g_1', [2, 0, 0], Math.PI / 2), 'bx_1', [2, 1, -4], Math.PI / 2))
    store.setRunning(false)
    // the designed pose (1, 1, 0) carried: a1 + R(90°)(x - a0) = (2, 0, 0) + (0, _, -1)
    const box = at(store, 'bx_1')
    expect(box.position[0]).toBeCloseTo(2, 9)
    expect(box.position[1]).toBeCloseTo(1, 9)
    expect(box.position[2]).toBeCloseTo(-1, 9)
    expect(box.rotationY).toBeCloseTo(Math.PI / 2, 9)
    expect(saved('bx_1')!.position[2]).toBeCloseTo(-1, 9)
  })

  it('undoing that carry mid-run takes the designed pose back too', () => {
    const store = new EditorStore()
    store.loadScene(scene(groupNode('g_1'), cargo('bx_1', 1, 'g_1')))
    store.setRunning(true)
    store.commit('Move part', posed(posed(store.getState().scene, 'g_1', [2, 0, 0]), 'bx_1', [3, 1, 0]))
    store.undo()
    store.setRunning(false)
    expect(at(store, 'bx_1').position).toEqual([1, 1, 0])
    expect(at(store, 'g_1').position[0]).toBe(0)
  })
})

describe('EditorStore', () => {
  it('roundtrips place through undo/redo', () => {
    const store = new EditorStore()
    const empty = store.getState().scene
    const placed = scene(part('rc_1'))

    store.commit('Place Roller Conveyor', placed)
    expect(store.getState().scene).toBe(placed)
    expect(store.canUndo).toBe(true)
    expect(store.canRedo).toBe(false)

    store.undo()
    expect(store.getState().scene).toBe(empty)
    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(true)

    store.redo()
    expect(store.getState().scene).toBe(placed)
    expect(store.canUndo).toBe(true)
    expect(store.canRedo).toBe(false)
  })

  it('surfaces custom-part build failures as a toast + badge, and clears them on a good rebuild', () => {
    const store = new EditorStore()

    // a failed build raises a toast and an error badge keyed by package id
    store.applyPackageStatuses([{ id: 'p1', name: 'Gripper', dir: '/p1', ok: false, error: 'line 3: bad' }])
    expect(store.getState().partBuildNotices).toHaveLength(1)
    expect(store.getState().partBuildNotices[0]).toMatchObject({ id: 'p1', name: 'Gripper', error: 'line 3: bad' })
    expect(store.getState().packageBuildErrors.p1).toBe('line 3: bad')

    // the same error on a rescan must not spam a second toast
    store.applyPackageStatuses([{ id: 'p1', name: 'Gripper', dir: '/p1', ok: false, error: 'line 3: bad' }])
    expect(store.getState().partBuildNotices).toHaveLength(1)

    // a successful rebuild clears the badge (the toast is dismissed separately, on its timer / ✕)
    store.applyPackageStatuses([{ id: 'p1', name: 'Gripper', dir: '/p1', ok: true }])
    expect(store.getState().packageBuildErrors.p1).toBeUndefined()

    // dismissing removes exactly that toast
    const notice = store.getState().partBuildNotices[0]
    expect(notice).toBeDefined()
    store.dismissPartBuildNotice(notice!.key)
    expect(store.getState().partBuildNotices).toHaveLength(0)
  })

  it('flashes a viewport hint with monotonic keys, and dismiss only clears the matching flash', () => {
    const store = new EditorStore()
    expect(store.getState().viewportHint).toBeNull()

    store.flashViewportHint('In auto - PLC controlled')
    const first = store.getState().viewportHint
    expect(first?.text).toBe('In auto - PLC controlled')

    // a re-flash (even identical text) gets a new key, so the badge's dismiss timer restarts
    store.flashViewportHint('In auto - PLC controlled')
    const second = store.getState().viewportHint
    expect(second?.key).not.toBe(first?.key)

    // a stale timer firing for the superseded flash must not clear the newer one
    store.dismissViewportHint(first!.key)
    expect(store.getState().viewportHint).toBe(second)
    store.dismissViewportHint(second!.key)
    expect(store.getState().viewportHint).toBeNull()
  })

  it('records a behavior-script edit on the undo stack (geometry unchanged)', () => {
    const store = new EditorStore()
    const id = 'test.behavior-undo'
    const v1 = pkg(id, 'definePart({ step() {} })')
    const v2 = { ...v1, behavior: 'definePart({ step(ctx) { ctx.setJoint("a", 1) } })' }
    try {
      // a behavior-only edit leaves geometry identical - it must still be undoable, not dropped as a no-op
      store.commitPackage('Edit behavior', v2, { before: v1 })
      expect(store.canUndo).toBe(true)
      expect(getPackage(id)?.behavior).toBe(v2.behavior)

      store.undo()
      expect(getPackage(id)?.behavior).toBe(v1.behavior)

      store.redo()
      expect(getPackage(id)?.behavior).toBe(v2.behavior)

      // a true no-op (identical geometry AND behavior) is still skipped
      store.commitPackage('Edit behavior', { ...v2 }, { before: v2 })
      expect(store.canRedo).toBe(false)
      expect(store.canUndo).toBe(true) // unchanged from the redo above - no new entry
    } finally {
      unregisterPackage(id)
    }
  })

  it('persists in-app authored parts and restores them into the catalog on reload', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const id = 'user.part-1'
    const v1 = pkg(id, 'definePart({ step() {} })')

    // session 1: author a part (addUserPackage), then edit its behavior - both must hit localStorage
    const s1 = new EditorStore()
    try {
      s1.addUserPackage(v1)
      expect(s1.getState().userPackages.map((p) => p.id)).toContain(id)
      const v2behavior = 'definePart({ step(ctx) { ctx.setJoint("a", 1) } })'
      s1.commitPackage('Edit behavior', { ...v1, behavior: v2behavior }, { before: v1 })

      // session 2: a fresh store starts with an empty catalog, then the project doc brings the latest version back
      const s2 = new EditorStore()
      expect(s2.getState().userPackages).toHaveLength(0)
      s2.loadProject(loadStoredProject()!.project)
      const restored = s2.getState().userPackages.find((p) => p.id === id)
      expect(restored?.behavior).toBe(v2behavior) // the edit survived, not the v1 snapshot
      expect(getPackage(id)?.behavior).toBe(v2behavior) // and it's registered for render/Inspector
    } finally {
      unregisterPackage(id)
    }
  })

  it('keeps no second copy of the library: a pre-project browser copy restores, then goes once the project doc holds it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const id = 'user.legacy-1'
    const v1 = pkg(id, 'definePart({ step() {} })')
    try {
      // a browser from before project docs: the library is only under the legacy key
      localStorage.setItem(USERPKG_KEY, JSON.stringify([v1]))
      const s1 = new EditorStore()
      s1.restoreUserPackages()
      expect(s1.getState().userPackages.map((p) => p.id)).toContain(id)
      expect(localStorage.getItem(USERPKG_KEY)).not.toBeNull() // reading it changes nothing

      // the next library change writes the project doc, and the legacy copy goes
      s1.commitPackage('Edit behavior', { ...v1, behavior: 'definePart({ step(ctx) { ctx.setJoint("a", 1) } })' }, { before: v1 })
      expect(localStorage.getItem(PROJECT_KEY)).not.toBeNull()
      expect(localStorage.getItem(USERPKG_KEY)).toBeNull()
      expect(loadStoredProject()!.project.packages?.map((p) => p.id)).toContain(id)
    } finally {
      unregisterPackage(id)
    }
  })

  it('emits a fresh state reference per change', () => {
    const store = new EditorStore()
    const before = store.getState()
    store.select('rc_1')
    const after = store.getState()
    expect(after).not.toBe(before)
    expect(after.selectedIds).toEqual(['rc_1'])
  })

  it('coalesces rapid commits with the same key into one undo step', () => {
    const now = vi.spyOn(Date, 'now')
    const store = new EditorStore(scene(part('rc_1', 0)))
    const base = store.getState().scene
    const s1 = scene(part('rc_1', 1))
    const s2 = scene(part('rc_1', 2))

    now.mockReturnValue(1000)
    store.commit('Edit Length', s1, { coalesceKey: 'param:rc_1:length' })
    now.mockReturnValue(1500)
    store.commit('Edit Length', s2, { coalesceKey: 'param:rc_1:length' })

    expect(store.getState().scene).toBe(s2)
    store.undo()
    expect(store.getState().scene).toBe(base)
    expect(store.canUndo).toBe(false)
    store.redo()
    expect(store.getState().scene).toBe(s2)
  })

  it("autosaves a gesture's first commit at once and trails the rest (deferPersist)", () => {
    // a scrub commits per pointer move and each autosave is a synchronous whole-project write: the first
    // commit of the gesture writes, the continuing ones are absorbed and land once on the trailing timer
    vi.useFakeTimers({ now: 1000 })
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene(part('rc_1', 0)))
    store.commit('Edit Length', scene(part('rc_1', 1)), { coalesceKey: 'param:rc_1:length' })
    expect(reloadedScene().parts[0]!.position[0]).toBe(1)
    vi.advanceTimersByTime(16)
    store.commit('Edit Length', scene(part('rc_1', 2)), { coalesceKey: 'param:rc_1:length' })
    vi.advanceTimersByTime(16)
    store.commit('Edit Length', scene(part('rc_1', 3)), { coalesceKey: 'param:rc_1:length' })
    expect(reloadedScene().parts[0]!.position[0]).toBe(1) // held
    expect(store.persistPending).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(reloadedScene().parts[0]!.position[0]).toBe(3) // the trailing write carries the latest
    expect(store.persistPending).toBe(false)
  })

  it('lands a held autosave on flushPersist, and on the next edit that writes', () => {
    vi.useFakeTimers({ now: 1000 })
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene(part('rc_1', 0), part('rc_2', 0)))
    store.commit('Edit Length', scene(part('rc_1', 1), part('rc_2', 0)), { coalesceKey: 'param:rc_1:length' })
    store.commit('Edit Length', scene(part('rc_1', 2), part('rc_2', 0)), { coalesceKey: 'param:rc_1:length' })
    store.flushPersist() // what pagehide / a hidden tab calls (main.tsx)
    expect(reloadedScene().parts[0]!.position[0]).toBe(2)
    expect(store.persistPending).toBe(false)
    store.commit('Edit Length', scene(part('rc_1', 3), part('rc_2', 0)), { coalesceKey: 'param:rc_1:length' })
    expect(reloadedScene().parts[0]!.position[0]).toBe(2) // held again
    // a different edit is not the same gesture: it writes at once, and the write carries the held one too
    store.commit('Edit Width', scene(part('rc_1', 3), part('rc_2', 5)), { coalesceKey: 'param:rc_2:width' })
    expect(reloadedScene().parts.map((p) => p.position[0])).toEqual([3, 5])
    expect(store.persistPending).toBe(false)
  })

  it("trails an ST keystroke's autosave the same way", () => {
    vi.useFakeTimers({ now: 1000 })
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene(part('rc_1', 0)))
    store.setStProgram('PROGRAM Main\nEND_PROGRAM\n')
    expect(localStorage.getItem(PROJECT_KEY) ?? '').not.toContain('PROGRAM Main')
    expect(store.persistPending).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(localStorage.getItem(PROJECT_KEY) ?? '').toContain('PROGRAM Main')
    expect(store.persistPending).toBe(false)
  })

  it('does not coalesce across different keys', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const store = new EditorStore(scene(part('rc_1', 0)))
    const s1 = scene(part('rc_1', 1))
    const s2 = scene(part('rc_1', 2))

    store.commit('Edit Length', s1, { coalesceKey: 'param:rc_1:length' })
    now.mockReturnValue(1100)
    store.commit('Edit Width', s2, { coalesceKey: 'param:rc_1:width' })

    store.undo()
    expect(store.getState().scene).toBe(s1)
    store.undo()
    expect(store.getState().scene.parts[0]?.position[0]).toBe(0)
  })

  it('does not coalesce after an 800 ms gap', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const store = new EditorStore(scene(part('rc_1', 0)))
    const s1 = scene(part('rc_1', 1))
    const s2 = scene(part('rc_1', 2))

    store.commit('Edit Length', s1, { coalesceKey: 'param:rc_1:length' })
    now.mockReturnValue(1800)
    store.commit('Edit Length', s2, { coalesceKey: 'param:rc_1:length' })

    store.undo()
    expect(store.getState().scene).toBe(s1)
    store.undo()
    expect(store.getState().scene.parts[0]?.position[0]).toBe(0)
  })

  it('does not coalesce across an undo boundary', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const store = new EditorStore(scene(part('rc_1', 0)))
    const s1 = scene(part('rc_1', 1))
    const s2 = scene(part('rc_1', 2))
    const s3 = scene(part('rc_1', 3))

    store.commit('Edit Length', s1, { coalesceKey: 'param:rc_1:length' })
    now.mockReturnValue(1200)
    store.commit('Edit Width', s2, { coalesceKey: 'param:rc_1:width' })
    now.mockReturnValue(1400)
    store.undo()
    expect(store.getState().scene).toBe(s1)
    now.mockReturnValue(1600)
    store.commit('Edit Length', s3, { coalesceKey: 'param:rc_1:length' })

    store.undo()
    expect(store.getState().scene).toBe(s1)
    store.undo()
    expect(store.getState().scene.parts[0]?.position[0]).toBe(0)
  })

  it('setTransient adds no history; commit with before makes the drag one step', () => {
    const start = scene(part('rc_1', 0))
    const store = new EditorStore(start)

    store.setTransient(scene(part('rc_1', 0.5)))
    store.setTransient(scene(part('rc_1', 1)))
    expect(store.canUndo).toBe(false)

    const final = scene(part('rc_1', 2))
    store.commit('Move part', final, { before: start })
    expect(store.getState().scene).toBe(final)

    store.undo()
    expect(store.getState().scene).toBe(start)
    expect(store.canUndo).toBe(false)
  })

  it('loadScene replaces the scene and clears history and selection', () => {
    const store = new EditorStore()
    store.commit('Place', scene(part('rc_1')))
    store.undo()
    store.select('rc_1')

    const loaded = scene(part('rc_9'))
    store.loadScene(loaded)
    expect(store.getState().scene).toBe(loaded)
    expect(store.getState().selectedIds).toEqual([])
    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(false)
  })

  it('clears redo on a new commit', () => {
    const store = new EditorStore()
    store.commit('Place', scene(part('rc_1')))
    store.undo()
    expect(store.canRedo).toBe(true)

    store.commit('Place', scene(part('rc_2')))
    expect(store.canRedo).toBe(false)
    expect(store.getState().scene.parts[0]?.id).toBe('rc_2')
  })

  it('selection ops: replace, toggle, clear, many', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.select('rc_1')
    expect(store.getState().selectedIds).toEqual(['rc_1'])
    store.toggleSelect('rc_2')
    expect(store.getState().selectedIds).toEqual(['rc_1', 'rc_2'])
    // toggling the active (last) part deselects it
    store.toggleSelect('rc_2')
    expect(store.getState().selectedIds).toEqual(['rc_1'])
    store.selectMany(['rc_1', 'rc_2'])
    expect(store.getState().selectedIds).toEqual(['rc_1', 'rc_2'])
    store.select('rc_2')
    expect(store.getState().selectedIds).toEqual(['rc_2'])
    store.clearSelection()
    expect(store.getState().selectedIds).toEqual([])
    store.select(null)
    expect(store.getState().selectedIds).toEqual([])
  })

  it('shift-click switches the active node: promote, then deselect', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.selectMany(['rc_1', 'rc_2', 'rc_3'])
    // rc_3 is the active node (last); shift-clicking rc_1 (selected, not active)
    // promotes it to the active node rather than deselecting it
    store.toggleSelect('rc_1')
    expect(store.getState().selectedIds).toEqual(['rc_2', 'rc_3', 'rc_1'])
    // shift-clicking the now-active rc_1 again deselects it
    store.toggleSelect('rc_1')
    expect(store.getState().selectedIds).toEqual(['rc_2', 'rc_3'])
    // shift-clicking an unselected part adds it as the new active node
    store.toggleSelect('rc_1')
    expect(store.getState().selectedIds).toEqual(['rc_2', 'rc_3', 'rc_1'])
  })

  it('tracks tool and live snap state', () => {
    const store = new EditorStore()
    expect(store.getState().tool).toBe('transform')
    store.setTool('rotate')
    expect(store.getState().tool).toBe('rotate')
    store.setLiveSnap(false)
    expect(store.getState().liveSnap).toBe(false)
    store.setLiveSnap(true)
    expect(store.getState().liveSnap).toBe(true)
    // the face-snap slice (Shift+N) toggles independently of the master live snap, default ON
    expect(store.getState().faceSnap).toBe(true)
    store.setFaceSnap(false)
    expect(store.getState().faceSnap).toBe(false)
    expect(store.getState().liveSnap).toBe(true)
    store.setFaceSnap(true)
    expect(store.getState().faceSnap).toBe(true)
  })

  it('duplicates the selection with fresh ids and selects the copies', () => {
    const store = new EditorStore(scene(part('pt_1'), part('pt_2', 2)))
    store.selectMany(['pt_1', 'pt_2'])
    store.duplicateSelection()
    const s = store.getState()
    expect(s.scene.parts.map((p) => p.id)).toEqual(['pt_1', 'pt_2', 'pt_3', 'pt_4'])
    expect(s.selectedIds).toEqual(['pt_3', 'pt_4'])
    expect(s.scene.parts[2]?.position).toEqual([0, 0.75, 0])
    expect(s.scene.parts[3]?.position).toEqual([2, 0.75, 0])
    store.undo()
    expect(store.getState().scene.parts).toHaveLength(2)
    expect(store.canUndo).toBe(false)
  })

  it('bumps a custom name on duplicate but leaves unnamed parts to their fresh id', () => {
    const named = { ...part('rc_1'), name: 'Main Conveyor' }
    const store = new EditorStore(scene(named, part('rc_2', 2)))
    store.selectMany(['rc_1', 'rc_2'])
    store.duplicateSelection()
    const parts = store.getState().scene.parts
    // the named clone gets "Main Conveyor 2"; the unnamed clone stays nameless (label = its fresh id)
    expect(parts[2]?.name).toBe('Main Conveyor 2')
    expect(parts[3]?.name).toBeUndefined()
    // duplicating again skips the taken "Main Conveyor 2" and lands on "Main Conveyor 3"
    store.select('rc_1')
    store.duplicateSelection()
    expect(store.getState().scene.parts.at(-1)?.name).toBe('Main Conveyor 3')
  })

  it('re-numbers an already-numbered name from its own suffix', () => {
    const store = new EditorStore(scene({ ...part('rc_1'), name: 'Belt 2' }))
    store.select('rc_1')
    store.duplicateSelection()
    expect(store.getState().scene.parts[1]?.name).toBe('Belt 3')
  })

  it('pastes with fresh ids and a nudge when the source position is occupied', () => {
    const store = new EditorStore(scene(part('pt_1')))
    store.select('pt_1')
    store.copySelection()
    store.paste()
    const s = store.getState()
    expect(s.scene.parts).toHaveLength(2)
    const pasted = s.scene.parts[1]!
    expect(pasted.id).toBe('pt_2')
    expect(pasted.position).toEqual([0.5, 0.75, 0.5])
    expect(s.selectedIds).toEqual(['pt_2'])
    store.undo()
    expect(store.getState().scene.parts).toHaveLength(1)
  })

  it('embeds the package of a pasted part the scene does not carry yet', () => {
    // the clipboard outlives the project it was copied from: the destination scene has never held this part
    registerPackage(pkg('paste.belt', 'definePart({ step() {} })'))
    try {
      const from = new EditorStore(scene({ ...part('pt_1'), packageId: 'paste.belt' } as PartInstance))
      from.select('pt_1')
      from.copySelection()
      const to = new EditorStore(scene())
      to.paste()
      expect(to.getState().scene.packages?.map((p) => p.id)).toEqual(['paste.belt'])
      to.paste() // a second paste embeds nothing twice
      expect(to.getState().scene.packages?.map((p) => p.id)).toEqual(['paste.belt'])
    } finally {
      unregisterPackage('paste.belt')
    }
  })

  describe('paste into another project', () => {
    // A part from project A's own library, naming a product of A's: copied in A, pasted after B is open. B's registry
    // never held either (adoptProjectLibrary replaces the library on a project switch).
    const spawner = (): PartPackage => ({
      ...pkg('a.spawner', 'definePart({ step() {} })'),
      params: { product: { type: 'string', default: 'a.crate', product: true } },
    } as unknown as PartPackage)
    const copyInA = (): void => {
      registerPackage(spawner())
      registerPackage(pkg('a.crate', 'definePart({ step() {} })'))
      const a = new EditorStore(scene({ ...part('sp_1'), packageId: 'a.spawner', params: {} } as PartInstance))
      a.select('sp_1')
      a.copySelection()
      unregisterPackage('a.spawner')
      unregisterPackage('a.crate')
    }
    afterEach(() => {
      unregisterPackage('a.spawner')
      unregisterPackage('a.crate')
      setBuiltInPackages([])
    })

    it('brings the part and what it names along, and saving keeps them in the library', () => {
      copyInA()
      const b = new EditorStore(scene())
      b.paste()
      expect(getPackage('a.spawner')).toBeDefined()
      expect(getPackage('a.crate')).toBeDefined()
      expect(b.getState().scene.packages?.map((p) => p.id).sort()).toEqual(['a.crate', 'a.spawner'])
      // a save moves a scene copy nothing else holds into the project's library (keepDefinitionsOnce needs a host
      // that has declared its built-ins)
      setBuiltInPackages([pkg('oip.stand-in', 'definePart({ step() {} })')])
      const project = assembleProject(b.getState().scene, '', [])
      expect(project.packages?.map((p) => p.id).sort()).toEqual(['a.crate', 'a.spawner'])
      expect(project.scene.packages).toBeUndefined()
    })

    it('survives the stored clipboard (checked as a scene file is)', () => {
      vi.stubGlobal('localStorage', fakeStorage())
      copyInA()
      const b = new EditorStore(scene())
      b.paste()
      expect(b.getState().scene.packages?.map((p) => p.id).sort()).toEqual(['a.crate', 'a.spawner'])
    })

    it('keeps the version of a part this project already has', () => {
      copyInA()
      const own = pkg('a.spawner', 'definePart({ step() { /* B */ } })')
      registerPackage(own)
      const b = new EditorStore(scene())
      b.paste()
      expect(getPackage('a.spawner')?.behavior).toBe(own.behavior)
    })

    it('a copy too big to store leaves no older stored copy to paste', () => {
      const storage = fakeStorage()
      vi.stubGlobal('localStorage', storage)
      const a = new EditorStore(scene(part('pt_1'), part('pt_9', 4)))
      a.select('pt_1')
      a.copySelection()
      storage.setItem = () => {
        throw new Error('QuotaExceededError')
      }
      a.select('pt_9')
      a.copySelection()
      const b = new EditorStore(scene())
      b.paste()
      expect(b.getState().scene.parts.map((p) => p.position[0])).toEqual([4])
    })
  })

  it('a save keeps the definitions the parts use, not the copies the scene happens to hold', () => {
    // a part whose definition is neither the library nor a built-in, added without its copy (a path that forgot to
    // embed it), keeps it; a copy no part uses any more is not carried
    registerPackage(pkg('save.widget', 'definePart({ step() {} })'))
    try {
      const store = new EditorStore()
      store.loadScene({ ...scene({ ...part('w_1'), packageId: 'save.widget' } as PartInstance), packages: [pkg('save.stale', 'definePart({ step() {} })')] })
      expect(store.snapshotProject().scene.packages?.map((p) => p.id)).toEqual(['save.widget'])
    } finally {
      unregisterPackage('save.widget')
      unregisterPackage('save.stale')
    }
  })

  it('pastes without a nudge when the source position is free', () => {
    const store = new EditorStore(scene(part('rc_1', 3)))
    store.select('rc_1')
    store.copySelection()
    store.deleteSelection()
    store.paste()
    const s = store.getState()
    expect(s.scene.parts).toHaveLength(1)
    expect(s.scene.parts[0]?.position).toEqual([3, 0.75, 0])
  })

  it('deletes the whole selection as one commit', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.selectMany(['rc_1', 'rc_3'])
    store.deleteSelection()
    const s = store.getState()
    expect(s.scene.parts.map((p) => p.id)).toEqual(['rc_2'])
    expect(s.selectedIds).toEqual([])
    store.undo()
    expect(store.getState().scene.parts).toHaveLength(3)
    expect(store.canUndo).toBe(false)
  })

  it('coalesces rapid renames of the same part into one undo step', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const store = new EditorStore(scene(part('rc_1')))
    store.rename('rc_1', 'Infeed')
    now.mockReturnValue(1200)
    store.rename('rc_1', 'Infeed line')
    expect(store.getState().scene.parts[0]?.name).toBe('Infeed line')
    store.undo()
    expect(store.getState().scene.parts[0]?.name).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

  it('drops the name when renamed to blank', () => {
    const store = new EditorStore(scene({ ...part('rc_1'), name: 'X' }))
    store.rename('rc_1', '   ')
    expect(store.getState().scene.parts[0]?.name).toBeUndefined()
  })

  it('auto-suffixes a rename that collides with a sibling (the unique-name rule)', () => {
    const store = new EditorStore(scene({ ...part('rc_1'), name: 'Motor' }, part('rc_2', 1)))
    // rc_2 is a sibling of rc_1 (both top-level) so it can't claim the same label - dedupes with an auto suffix
    store.rename('rc_2', 'Motor')
    expect(store.getState().scene.parts[1]?.name).toBe('Motor 2')
    // renaming a part to its own current name stays a no-op (no spurious "Motor 2" self-collision)
    store.rename('rc_1', 'Motor')
    expect(store.getState().scene.parts[0]?.name).toBe('Motor')
  })

  it('allows the same name under a different parent (per-branch - not global)', () => {
    const store = new EditorStore(
      scene(
        { ...part('rc_1'), name: 'Start', parent: 'cellA' },
        { ...part('rc_2', 1), parent: 'cellB' },
      ),
    )
    // rc_2 lives under a different parent, so "Start" is free there - no suffix
    store.rename('rc_2', 'Start')
    expect(store.getState().scene.parts[1]?.name).toBe('Start')
  })

  it('hides parts by setting visible:false and shows by dropping the flag', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.setVisible(['rc_1'], false)
    let s = store.getState()
    expect(s.scene.parts[0]?.visible).toBe(false)
    expect('visible' in (s.scene.parts[1] as object)).toBe(false)
    store.setVisible(['rc_1'], true)
    s = store.getState()
    expect('visible' in (s.scene.parts[0] as object)).toBe(false)
  })

  it('hides a multi-selection in one commit and undoes it together', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.setVisible(['rc_1', 'rc_3'], false)
    let s = store.getState()
    expect(s.scene.parts.map((p) => p.visible)).toEqual([false, undefined, false])
    store.undo()
    s = store.getState()
    expect(s.scene.parts.every((p) => p.visible === undefined)).toBe(true)
    expect(store.canUndo).toBe(false)
  })

  it('setVisible is a no-op (no undo entry) when nothing changes', () => {
    const store = new EditorStore(scene(part('rc_1')))
    store.setVisible(['rc_1'], true) // already visible
    expect(store.canUndo).toBe(false)
    store.setVisible([], false) // empty selection
    expect(store.canUndo).toBe(false)
  })

  it('locks parts by setting locked:true and unlocks by dropping the flag', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.setLocked(['rc_1'], true)
    let s = store.getState()
    expect(s.scene.parts[0]?.locked).toBe(true)
    expect('locked' in (s.scene.parts[1] as object)).toBe(false)
    store.setLocked(['rc_1'], false)
    s = store.getState()
    expect('locked' in (s.scene.parts[0] as object)).toBe(false)
  })

  it('locks a multi-selection in one commit and undoes it together', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.setLocked(['rc_1', 'rc_3'], true)
    let s = store.getState()
    expect(s.scene.parts.map((p) => p.locked)).toEqual([true, undefined, true])
    store.undo()
    s = store.getState()
    expect(s.scene.parts.every((p) => p.locked === undefined)).toBe(true)
    expect(store.canUndo).toBe(false)
  })

  it('setLocked is a no-op (no undo entry) when nothing changes', () => {
    const store = new EditorStore(scene(part('rc_1')))
    store.setLocked(['rc_1'], false) // already unlocked
    expect(store.canUndo).toBe(false)
    store.setLocked([], true) // empty selection
    expect(store.canUndo).toBe(false)
  })

  it('groups parts by setting grouped:true and ungroups by dropping the flag', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.setGrouped(['rc_1'], true)
    let s = store.getState()
    expect(s.scene.parts[0]?.grouped).toBe(true)
    expect('grouped' in (s.scene.parts[1] as object)).toBe(false)
    store.setGrouped(['rc_1'], false)
    s = store.getState()
    expect('grouped' in (s.scene.parts[0] as object)).toBe(false)
  })

  it('setGrouped is a no-op (no undo entry) when nothing changes', () => {
    const store = new EditorStore(scene(part('rc_1')))
    store.setGrouped(['rc_1'], false) // already ungrouped
    expect(store.canUndo).toBe(false)
    store.setGrouped([], true) // empty selection
    expect(store.canUndo).toBe(false)
  })

  it('reorders parts and undoes back to the original order', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.reorder(['rc_3', 'rc_1', 'rc_2'])
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_3', 'rc_1', 'rc_2'])
    store.undo()
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1', 'rc_2', 'rc_3'])
  })

  it('reorder ignores non-permutations and identity orders', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.reorder(['rc_1', 'rc_2']) // identity
    expect(store.canUndo).toBe(false)
    store.reorder(['rc_1', 'rc_9']) // unknown id
    expect(store.canUndo).toBe(false)
    store.reorder(['rc_1']) // wrong length
    expect(store.canUndo).toBe(false)
  })

  it('cuts the selection: copies it, deletes it in one undo step, and primes paste', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.select('rc_1')
    store.cutSelection()
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_2'])
    expect(store.getState().selectedIds).toEqual([])
    store.undo() // the delete is the single undo step; the clipboard write isn't undoable
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1', 'rc_2'])
    expect(store.canUndo).toBe(false)
    store.redo()
    store.paste() // the cut left the clipboard primed
    expect(store.getState().scene.parts).toHaveLength(2)
  })

  it('moves a single part up and down, undoing each move', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.select('rc_2')
    store.moveSelection(-1)
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_2', 'rc_1', 'rc_3'])
    store.undo()
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1', 'rc_2', 'rc_3'])
    store.moveSelection(1)
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1', 'rc_3', 'rc_2'])
  })

  it('moves a contiguous block as a unit, preserving inner order', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2), part('rc_4', 3)))
    store.selectMany(['rc_2', 'rc_3'])
    store.moveSelection(-1)
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_2', 'rc_3', 'rc_1', 'rc_4'])
  })

  it('moves a non-contiguous selection one slot each', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2), part('rc_4', 3)))
    store.selectMany(['rc_2', 'rc_4'])
    store.moveSelection(-1)
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_2', 'rc_1', 'rc_4', 'rc_3'])
  })

  it('blocks the whole move when any selected part sits at the destination edge', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.select('rc_1')
    store.moveSelection(-1) // already at the top
    expect(store.canUndo).toBe(false)
    store.select('rc_3')
    store.moveSelection(1) // already at the bottom
    expect(store.canUndo).toBe(false)
    // a multi-selection touching the top edge is fully pinned (nowhere to move)
    store.selectMany(['rc_1', 'rc_3'])
    store.moveSelection(-1)
    expect(store.canUndo).toBe(false)
  })

  // --- soft parenting -------------------------------------------------------

  const child = (id: string, parent: string, x = 0): PartInstance => ({ ...part(id, x), parent })

  it('reparents a part and unparents it back to root', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.reparent(['rc_2'], 'rc_1')
    expect(store.getState().scene.parts.find((p) => p.id === 'rc_2')?.parent).toBe('rc_1')
    store.reparent(['rc_2'], null)
    expect('parent' in (store.getState().scene.parts.find((p) => p.id === 'rc_2') as object)).toBe(false)
  })

  it('reparent refuses to create a cycle', () => {
    const store = new EditorStore(scene(part('rc_1'), child('rc_2', 'rc_1', 1)))
    store.reparent(['rc_1'], 'rc_2') // rc_1 under its own child: no-op
    expect(store.getState().scene.parts.find((p) => p.id === 'rc_1')?.parent).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

  it('deletes the whole subtree of a selected parent', () => {
    const store = new EditorStore(scene(part('rc_1'), child('rc_2', 'rc_1', 1), child('rc_3', 'rc_2', 2), part('rc_4', 3)))
    store.select('rc_1')
    store.deleteSelection()
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_4'])
  })

  it('duplicates a parent with its subtree, relinking the clones', () => {
    const store = new EditorStore(scene(part('pt_1'), child('pt_2', 'pt_1', 1)))
    store.select('pt_1')
    store.duplicateSelection()
    const parts = store.getState().scene.parts
    expect(parts.map((p) => p.id)).toEqual(['pt_1', 'pt_2', 'pt_3', 'pt_4'])
    expect(parts.find((p) => p.id === 'pt_3')?.parent).toBeUndefined() // clone of the root
    expect(parts.find((p) => p.id === 'pt_4')?.parent).toBe('pt_3') // child re-links to cloned parent
    expect(store.getState().selectedIds).toEqual(['pt_3'])
  })

  it('copies a parent subtree and pastes it relinked as a root', () => {
    const store = new EditorStore(scene(part('rc_1', 5), child('rc_2', 'rc_1', 6)))
    store.select('rc_1')
    store.copySelection()
    store.paste()
    const parts = store.getState().scene.parts
    expect(parts).toHaveLength(4)
    const [c1, c2] = [parts[2]!, parts[3]!]
    expect(c1.parent).toBeUndefined() // external parent dropped: pasted as root
    expect(c2.parent).toBe(c1.id) // internal link preserved
  })

  it('moveInTree drops a part inside a target as its child', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.moveInTree(['rc_3'], 'rc_1', 'inside')
    const parts = store.getState().scene.parts
    expect(parts.find((p) => p.id === 'rc_3')?.parent).toBe('rc_1')
    expect(parts.map((p) => p.id)).toEqual(['rc_1', 'rc_3', 'rc_2']) // inserted right after the target
  })

  it('moveInTree reorders as a sibling with before/after', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1), part('rc_3', 2)))
    store.moveInTree(['rc_3'], 'rc_1', 'before')
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_3', 'rc_1', 'rc_2'])
    expect(store.getState().scene.parts.find((p) => p.id === 'rc_3')?.parent).toBeUndefined()
  })

  it('moveInTree refuses to drop a parent into its own subtree', () => {
    const store = new EditorStore(scene(part('rc_1'), child('rc_2', 'rc_1', 1)))
    store.moveInTree(['rc_1'], 'rc_2', 'inside')
    expect(store.canUndo).toBe(false)
  })

  it('moveSelection reorders within a sibling group only', () => {
    const store = new EditorStore(scene(part('rc_1'), child('rc_2', 'rc_1', 1), child('rc_3', 'rc_1', 2), part('rc_4', 3)))
    store.select('rc_3')
    store.moveSelection(-1)
    expect(store.getState().scene.parts.map((p) => p.id)).toEqual(['rc_1', 'rc_3', 'rc_2', 'rc_4'])
  })

  it('moveSelection is a no-op for a selection spanning parents', () => {
    const store = new EditorStore(scene(part('rc_1'), child('rc_2', 'rc_1', 1), part('rc_3', 2)))
    store.selectMany(['rc_2', 'rc_3'])
    store.moveSelection(1)
    expect(store.canUndo).toBe(false)
  })

  it('reparentToNewNode wraps the selection in a new group at its centroid', () => {
    const store = new EditorStore(scene(part('rc_1', 0), part('rc_2', 4)))
    store.selectMany(['rc_1', 'rc_2'])
    store.reparentToNewNode()
    const parts = store.getState().scene.parts
    const group = parts.find((p) => p.type === 'group')!
    expect(group.id).toBe('grp_1')
    expect(group.position[0]).toBeCloseTo(2) // centroid of x=0 and x=4
    expect(group.grouped).toBe(true) // born grouped so viewport clicks select the container
    expect(group.name).toBe('Group 1') // readable default name, not the raw grp_1 id
    expect(parts.find((p) => p.id === 'rc_1')?.parent).toBe('grp_1')
    expect(parts.find((p) => p.id === 'rc_2')?.parent).toBe('grp_1')
    expect(store.getState().selectedIds).toEqual(['grp_1'])
    store.undo()
    expect(store.getState().scene.parts.some((p) => p.type === 'group')).toBe(false)
  })

  it('reparentToNewNode only re-roots the top-level members of the selection', () => {
    // rc_2 is a child of rc_1; the new group takes rc_1, and rc_2 rides along in its subtree
    const store = new EditorStore(scene(part('rc_1'), child('rc_2', 'rc_1', 1)))
    store.selectMany(['rc_1', 'rc_2'])
    store.reparentToNewNode()
    const parts = store.getState().scene.parts
    const group = parts.find((p) => p.type === 'group')!
    expect(parts.find((p) => p.id === 'rc_1')?.parent).toBe(group.id)
    expect(parts.find((p) => p.id === 'rc_2')?.parent).toBe('rc_1')
  })

  it('opens and closes the list-select picker without touching history', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    expect(store.getState().listSelect).toBeNull()
    store.openListSelect({
      x: 40,
      y: 60,
      append: false,
      items: [
        { id: 'rc_1', name: 'rc_1', type: 'part' },
        { id: 'rc_2', name: 'rc_2', type: 'part' },
      ],
    })
    expect(store.getState().listSelect?.items.map((i) => i.id)).toEqual(['rc_1', 'rc_2'])
    store.closeListSelect()
    expect(store.getState().listSelect).toBeNull()
    expect(store.canUndo).toBe(false) // a transient UI popup is not an edit
  })

  it('toggles transform space and rehydrates it from storage', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    expect(store.getState().space).toBe('local')
    store.toggleSpace()
    expect(store.getState().space).toBe('global')
    expect(localStorage.getItem(SPACE_KEY)).toBe('global')
    // a fresh store rehydrates the persisted space (Local Space persists across sessions)
    expect(new EditorStore().getState().space).toBe('global')
    expect(store.canUndo).toBe(false) // a view toggle is not an edit
  })

  it('edits grid-snap settings, ignores no-ops, and persists them', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    expect(store.getState().gridSnap).toEqual({ enabled: false, translate: 1, rotate: 15 })
    store.toggleGridSnap()
    expect(store.getState().gridSnap.enabled).toBe(true)
    store.setGridSnap({ translate: 0.5, rotate: 45 })
    expect(store.getState().gridSnap).toEqual({ enabled: true, translate: 0.5, rotate: 45 })
    const unchanged = store.getState()
    store.setGridSnap({ translate: 0.5 }) // already 0.5: no state churn
    expect(store.getState()).toBe(unchanged)
    expect(JSON.parse(localStorage.getItem(GRIDSNAP_KEY)!)).toEqual({ enabled: true, translate: 0.5, rotate: 45 })
    expect(new EditorStore().getState().gridSnap).toEqual({ enabled: true, translate: 0.5, rotate: 45 })
  })

  it('toggles vertex-snap modes (collision default), persists, and rehydrates them', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    // defaults: vertex (not origin), collision (not mesh) - the project's default preference
    expect(store.getState().vertexSnapOriginMode).toBe(false)
    expect(store.getState().vertexSnapCollision).toBe(true)

    store.setVertexSnapOriginMode(true)
    store.setVertexSnapCollision(false)
    expect(store.getState().vertexSnapOriginMode).toBe(true)
    expect(store.getState().vertexSnapCollision).toBe(false)
    expect(localStorage.getItem(VSNAP_ORIGIN_KEY)).toBe('true')
    expect(localStorage.getItem(VSNAP_COLLISION_KEY)).toBe('false')

    const unchanged = store.getState()
    store.setVertexSnapOriginMode(true) // no-op
    expect(store.getState()).toBe(unchanged)

    // a fresh store rehydrates both prefs
    const next = new EditorStore()
    expect(next.getState().vertexSnapOriginMode).toBe(true)
    expect(next.getState().vertexSnapCollision).toBe(false)
    expect(store.canUndo).toBe(false) // view toggles are not edits
  })
})

describe('rig-node lock (author-mode, editor-only)', () => {
  it('sets and clears a per-(part,link) lock without touching the other key', () => {
    const store = new EditorStore()
    expect(store.isRigNodeLocked('cp_1', 'arm')).toBe(false)
    store.setRigNodeLocked('cp_1', 'arm', true)
    expect(store.isRigNodeLocked('cp_1', 'arm')).toBe(true)
    expect(store.isRigNodeLocked('cp_1', 'base')).toBe(false) // a different link is unaffected
    expect(store.getState().lockedRigNodes.has(rigNodeKey('cp_1', 'arm'))).toBe(true)
    store.setRigNodeLocked('cp_1', 'arm', false)
    expect(store.isRigNodeLocked('cp_1', 'arm')).toBe(false)
  })

  it('a no-op toggle keeps the same set reference (no spurious re-render)', () => {
    const store = new EditorStore()
    const before = store.getState().lockedRigNodes
    store.setRigNodeLocked('cp_1', 'arm', false) // already unlocked
    expect(store.getState().lockedRigNodes).toBe(before)
  })

  it('the lock is not serialized into the scene (editor-only)', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    store.setRigNodeLocked('cp_1', 'arm', true)
    expect(JSON.stringify(store.getState().scene)).not.toContain('lockedRigNodes')
  })
})

// the part selection (selectedIds) and the rig-link selection (selectedRigNode) are one axis with two
// shapes - the exclusivity is enforced at the store's single write path (setState), not per call site
describe('selection exclusivity (parts XOR rig link)', () => {
  it('selecting a rig link clears the part selection', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.selectMany(['rc_1', 'rc_2'])
    store.selectRigNode('cp_1', 'arm')
    expect(store.getState().selectedIds).toEqual([])
    expect(store.getState().selectedRigNode).toEqual({ partId: 'cp_1', linkName: 'arm' })
  })

  it('selecting parts clears a rig-link selection - single, toggle, and range select', () => {
    const store = new EditorStore(scene(part('rc_1'), part('rc_2', 1)))
    store.selectRigNode('cp_1', 'arm')
    store.select('rc_1')
    expect(store.getState().selectedRigNode).toBeNull()
    store.selectRigNode('cp_1', 'arm')
    store.toggleSelect('rc_2')
    expect(store.getState().selectedRigNode).toBeNull()
    store.selectRigNode('cp_1', 'arm')
    store.selectMany(['rc_1', 'rc_2'])
    expect(store.getState().selectedRigNode).toBeNull()
  })

  it('clearSelection clears both axes', () => {
    const store = new EditorStore(scene(part('rc_1')))
    store.selectRigNode('cp_1', 'arm')
    store.clearSelection()
    expect(store.getState().selectedIds).toEqual([])
    expect(store.getState().selectedRigNode).toBeNull()
  })
})

describe('EditorStore commitPackage validation guard', () => {
  afterEach(() => unregisterPackage('vg.part'))

  const goodPkg = (): PartPackage =>
    ({
      format: PACKAGE_FORMAT,
      id: 'vg.part',
      name: 'Guarded Part',
      params: {},
      behavior: 'definePart({ step() {} })',
      geometry: {
        kind: 'rig',
        links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0.5, 0] }],
        joints: [],
      },
    }) as PartPackage

  it('blocks a structurally invalid edit: last-good stays registered, diagnostics surface, no undo entry', () => {
    const store = new EditorStore()
    const good = goodPkg()
    registerPackage(good)
    // an edit that orphans a joint (its link does not exist) - the kind of slip a rig editor could produce
    const bad = {
      ...good,
      geometry: {
        ...good.geometry,
        joints: [{ name: 'j', link: 'ghost', type: 'revolute', axis: [0, 1, 0], min: 0, max: 1 }],
      },
    } as PartPackage
    store.commitPackage('Edit joint', bad)

    // the invalid package never registered - render/sim keep building from the last-good version
    expect(getPackage('vg.part')).toBe(good)
    // the failure surfaces on the same badge + toast the desktop build failures use
    expect(store.getState().packageBuildErrors['vg.part']).toMatch(/joint\.link/)
    expect(store.getState().partBuildNotices).toHaveLength(1)
    expect(store.getState().partBuildNotices[0]?.id).toBe('vg.part')
    // and nothing was pushed onto the undo stack (undo would otherwise "restore" the bad edit)
    store.undo()
    expect(getPackage('vg.part')).toBe(good)
  })

  it('a subsequent valid edit clears the failed-edit badge', () => {
    const store = new EditorStore()
    const good = goodPkg()
    registerPackage(good)
    store.commitPackage('Edit joint', {
      ...good,
      geometry: { ...good.geometry, joints: [{ name: 'j', link: 'ghost', type: 'revolute', axis: [0, 1, 0], min: 0, max: 1 }] },
    } as PartPackage)
    expect(store.getState().packageBuildErrors['vg.part']).toBeTruthy()

    const fixed = {
      ...good,
      geometry: { ...good.geometry, joints: [{ name: 'j', link: 'body', type: 'revolute', axis: [0, 1, 0], min: 0, max: 1 }] },
    } as PartPackage
    store.commitPackage('Edit joint', fixed)
    expect(getPackage('vg.part')).toBe(fixed)
    expect(store.getState().packageBuildErrors['vg.part']).toBeUndefined()
  })

  it('rolls a transient preview back to the pre-drag baseline when the release commit is invalid', () => {
    const store = new EditorStore()
    const good = goodPkg()
    registerPackage(good)
    // mid-drag preview registers freely (no validation on the transient pump)...
    const preview = { ...good, name: 'preview' } as PartPackage
    store.setTransientPackage(preview)
    expect(getPackage('vg.part')).toBe(preview)
    // ...but an invalid release commit rolls the registry back to the caller's `before` baseline
    store.commitPackage(
      'Edit joint',
      {
        ...preview,
        geometry: { ...preview.geometry, joints: [{ name: 'j', link: 'ghost', type: 'revolute', axis: [0, 1, 0], min: 0, max: 1 }] },
      } as PartPackage,
      { before: good },
    )
    expect(getPackage('vg.part')).toBe(good)
    expect(store.getState().packageBuildErrors['vg.part']).toBeTruthy()
  })
})

// Parts entering the store are deep-frozen in dev (setState): derived scene caches (core/memoParts.ts)
// key on part reference identity, so an in-place mutation would serve stale derivations. The freeze
// turns that silent corruption into a throw at the offending line. (vitest runs with DEV=true.)
describe('dev part-immutability freeze', () => {
  it('freezes scene parts (deep) once they enter the store', () => {
    const store = new EditorStore(scene(part('rc_1')))
    const p = store.getState().scene.parts[0]! as unknown as { position: number[]; params: Record<string, unknown> }
    expect(Object.isFrozen(p)).toBe(true)
    expect(() => {
      p.params.length = 99
    }).toThrow(TypeError)
    expect(() => {
      p.position[0] = 99
    }).toThrow(TypeError)
    expect(p.params.length).toBe(3) // the mutation really didn't land
  })

  it('immutable-update flows (commit a moved clone) still work against frozen originals', () => {
    const store = new EditorStore(scene(part('rc_1')))
    const before = store.getState().scene
    const moved = { ...before.parts[0]!, position: [9, 0.75, 0] } as PartInstance
    store.commit('Move part', { ...before, parts: [moved] })
    expect(store.getState().scene.parts[0]!.position[0]).toBe(9)
    store.undo()
    expect(store.getState().scene.parts[0]!.position[0]).toBe(0)
  })
})

describe('autosave failure reporting', () => {
  // Guards against a quota throw being swallowed twice (projectFile's catch, then persistProject's), which
  // leaves the author editing against a dead autosave and losing the session on reload. It must reach
  // state.autosaveError.
  function fullStorage(): Storage {
    const s = fakeStorage()
    return {
      ...s,
      getItem: (k: string) => s.getItem(k),
      setItem: () => {
        const e = new Error('exceeded the quota')
        e.name = 'QuotaExceededError'
        throw e
      },
    } as Storage
  }

  it('raises a sticky autosaveError when the write fails', () => {
    vi.stubGlobal('localStorage', fullStorage())
    const store = new EditorStore(scene(part('rc_1')))
    expect(store.getState().autosaveError).toBeNull() // construction alone doesn't persist
    store.commit('Move part', scene(part('rc_1', 5)))
    expect(store.getState().autosaveError).toMatch(/local storage/i)
  })

  it('editing still works while the autosave is failing', () => {
    vi.stubGlobal('localStorage', fullStorage())
    const store = new EditorStore(scene(part('rc_1')))
    store.commit('Move part', scene(part('rc_1', 5)))
    expect(store.getState().scene.parts[0]!.position[0]).toBe(5) // reported, not thrown
    store.undo()
    expect(store.getState().scene.parts[0]!.position[0]).toBe(0)
  })

  it('clears the warning once a write succeeds again', () => {
    vi.stubGlobal('localStorage', fullStorage())
    const store = new EditorStore(scene(part('rc_1')))
    store.commit('Move part', scene(part('rc_1', 5)))
    expect(store.getState().autosaveError).not.toBeNull()
    vi.stubGlobal('localStorage', fakeStorage()) // space freed / smaller doc
    store.commit('Move part', scene(part('rc_1', 6)))
    expect(store.getState().autosaveError).toBeNull()
  })
})

// The store exists before App mounts and subscribes, so a panel reveal in that gap is held for App.
describe('revealPanel', () => {
  it('a request made before App subscribes reaches it once, without repeats', () => {
    const store = new EditorStore()
    store.revealPanel('st')
    store.revealPanel('st')
    const got: string[] = []
    const off = store.onRevealPanel((p) => got.push(p))
    expect(got).toEqual(['st'])
    off()
    store.onRevealPanel((p) => got.push(p))
    store.revealPanel('problems')
    expect(got).toEqual(['st', 'problems'])
  })
})

// A reveal pairs with revealPanel('st'), which mounts a PLC panel that was a background tab on the next render: the
// request is made before that panel can subscribe, so the store holds it for the panel that mounts.
describe('revealStOffset', () => {
  afterEach(() => vi.useRealTimers())

  it('a request no ST editor could take reaches the next one to subscribe, once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const store = new EditorStore()
    store.revealStOffset(42)
    vi.setSystemTime(10_500)
    const got: number[] = []
    const off = store.onRevealStOffset((o) => got.push(o))
    expect(got).toEqual([42])
    off()
    store.onRevealStOffset((o) => got.push(o))
    expect(got).toEqual([42])
  })

  it('a mounted editor takes a request at once, and a request nobody took for seconds is dropped', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const store = new EditorStore()
    const got: number[] = []
    const off = store.onRevealStOffset((o) => got.push(o))
    store.revealStOffset(7)
    expect(got).toEqual([7])
    off()
    store.revealStOffset(99)
    vi.setSystemTime(20_000)
    store.onRevealStOffset((o) => got.push(o))
    expect(got).toEqual([7])
  })
})
