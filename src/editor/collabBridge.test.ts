import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createPart, serializeScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON } from '../core/types'
import { CollabBridge } from '../collab/bridge'
import {
  appendEditEvent,
  docToScene,
  editedPackageIds,
  EVENT_CAP,
  eventsArray,
  metaMap,
  packagesMap,
  partsMap,
  readEditFeed,
  readPackages,
  sceneToDoc,
  stProgramText,
  writePackage,
} from '../collab/schema'
import type { FeedEvent } from '../collab/schema'
import type { PartPackage } from '../core/parts/partPackage'
import { getPackage, registerPackage } from '../core/parts/partRegistry'
import { EditorStore } from './store/store'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

/** end-to-end: two stores joined by two relayed Y.Docs behave like two browser tabs in a room */
function richScene(): SceneJSON {
  const building = createPart('building', 'bld_1', [0, 0, 0])
  const belt = createPart('group', 'bc_1', [2, 0.75, 0])
  const marking = createPart('group', 'bx_1', [1, 0, 1])
  return { version: SCENE_VERSION, parts: [building, belt, marking] }
}

describe('CollabBridge end-to-end', () => {
  it('propagates a local commit on one store to the other and prunes stale selection', () => {
    const scene = richScene()
    const doc1 = new Y.Doc()
    sceneToDoc(scene, doc1)
    const store1 = new EditorStore()
    store1.setCollabMode(true)
    store1.applyRemote(docToScene(doc1))

    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    const store2 = new EditorStore()
    store2.setCollabMode(true)
    store2.applyRemote(docToScene(doc2))

    // relay updates both ways (re-applying known state is a no-op, so this terminates)
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(store1, doc1)
    new CollabBridge(store2, doc2)

    // store2 has the part store1 is about to delete selected
    store2.selectMany(['sl_1'])

    // store1 commits a belt move + a stack-light delete in one edit
    const moved: PartInstance = { ...store1.getState().scene.parts.find((p) => p.id === 'bc_1')!, position: [8, 0.75, 3] }
    store1.commit('Edit', {
      ...store1.getState().scene,
      parts: store1
        .getState()
        .scene.parts.filter((p) => p.id !== 'sl_1')
        .map((p) => (p.id === 'bc_1' ? moved : p)),
    })

    const s2 = store2.getState().scene
    expect(s2.parts.find((p) => p.id === 'bc_1')!.position).toEqual([8, 0.75, 3])
    expect(s2.parts.find((p) => p.id === 'sl_1')).toBeUndefined()
    expect(store2.getState().selectedIds).toEqual([]) // selection of the deleted part pruned
    expect(serializeScene(store1.getState().scene)).toBe(serializeScene(store2.getState().scene))
  })

  it('a view-only client receives remote edits but never writes to the shared doc', () => {
    const scene = richScene()
    const doc1 = new Y.Doc()
    sceneToDoc(scene, doc1)
    const editor = new EditorStore()
    editor.setCollabMode(true)
    editor.applyRemote(docToScene(doc1))

    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    const viewer = new EditorStore()
    viewer.setCollabMode(true)
    viewer.setReadOnly(true)
    viewer.applyRemote(docToScene(doc2))

    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(editor, doc1)
    new CollabBridge(viewer, doc2, undefined, true)

    // the viewer's own commit is dropped: neither its local scene nor the editor's changes
    const before = serializeScene(viewer.getState().scene)
    viewer.commit('Add', {
      ...viewer.getState().scene,
      parts: [...viewer.getState().scene.parts, createPart('group', 'rc_viewer', [6, 0.75, 0])],
    })
    expect(serializeScene(viewer.getState().scene)).toBe(before)
    expect(editor.getState().scene.parts.some((p) => p.id === 'rc_viewer')).toBe(false)
    expect(viewer.canUndo).toBe(false)

    // but an editor's commit still flows into the viewer (read-only is one-way, not disconnected)
    editor.commit('Add', {
      ...editor.getState().scene,
      parts: [...editor.getState().scene.parts, createPart('group', 'rc_editor', [4, 0.75, 0])],
    })
    expect(viewer.getState().scene.parts.some((p) => p.id === 'rc_editor')).toBe(true)
  })

  it('multiplayer undo reverts only this client edit and propagates to the peer', () => {
    const scene = richScene()
    const doc1 = new Y.Doc()
    sceneToDoc(scene, doc1)
    const store1 = new EditorStore()
    store1.setCollabMode(true)
    store1.applyRemote(docToScene(doc1))

    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    const store2 = new EditorStore()
    store2.setCollabMode(true)
    store2.applyRemote(docToScene(doc2))

    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(store1, doc1)
    new CollabBridge(store2, doc2)

    expect(store1.canUndo).toBe(false)
    // store1 adds a roller
    const add = createPart('group', 'rc_undo', [6, 0.75, 0])
    store1.commit('Add', { ...store1.getState().scene, parts: [...store1.getState().scene.parts, add] })
    expect(store2.getState().scene.parts.some((p) => p.id === 'rc_undo')).toBe(true)
    expect(store1.canUndo).toBe(true)

    // undo on store1 removes the roller everywhere
    store1.undo()
    expect(store1.getState().scene.parts.some((p) => p.id === 'rc_undo')).toBe(false)
    expect(store2.getState().scene.parts.some((p) => p.id === 'rc_undo')).toBe(false)
    expect(serializeScene(store1.getState().scene)).toBe(serializeScene(store2.getState().scene))
  })
})

/** a minimal but valid custom-part package - the sync path serializes it, it doesn't re-validate */
function simplePackage(id: string, behavior: string, withAsset = false): PartPackage {
  const pkg: PartPackage = {
    format: PACKAGE_FORMAT,
    id,
    name: 'Authored Part',
    params: {},
    behavior,
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }], joints: [] },
  }
  if (withAsset) pkg.assets = [{ id: 'm1', mime: 'model/gltf-binary', data: 'QUJDRA==' }]
  return pkg
}

describe('CollabBridge custom-part package sync', () => {
  it('propagates an authored part and a later behavior edit to the peer', () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const store1 = new EditorStore()
    store1.setCollabMode(true)
    const store2 = new EditorStore()
    store2.setCollabMode(true)
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(store1, doc1)
    new CollabBridge(store2, doc2)

    // store1 authors a part: it reaches the shared doc and surfaces in the peer's catalog
    const pkg = simplePackage('user.part-1', 'definePart({ step() {} })')
    store1.addUserPackage(pkg)
    expect(readPackages(doc2).find((p) => p.id === pkg.id)?.behavior).toBe(pkg.behavior)
    expect(store2.getState().userPackages.some((p) => p.id === pkg.id)).toBe(true)

    // store1 edits the behavior script: the new source propagates to the shared doc
    store1.commitPackage('Edit behavior', { ...pkg, behavior: 'definePart({ step(ctx) { ctx.rng() } })' })
    expect(readPackages(doc2).find((p) => p.id === pkg.id)?.behavior).toContain('rng')
  })

  it('a view-only client receives packages but never writes them', () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const editor = new EditorStore()
    editor.setCollabMode(true)
    const viewer = new EditorStore()
    viewer.setCollabMode(true)
    viewer.setReadOnly(true)
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(editor, doc1)
    new CollabBridge(viewer, doc2, undefined, true)

    // an editor's authored package flows to the viewer (read-only is one-way, not disconnected)
    editor.addUserPackage(simplePackage('user.part-2', 'definePart({ step() {} })'))
    expect(viewer.getState().userPackages.some((p) => p.id === 'user.part-2')).toBe(true)

    // the viewer's own authoring never reaches the shared doc (no package sink installed)
    viewer.addUserPackage(simplePackage('user.viewer', 'definePart({ step() {} })'))
    expect(readPackages(doc1).some((p) => p.id === 'user.viewer')).toBe(false)
  })

  it('multiplayer undo reverts a behavior-script edit and propagates to the peer', () => {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const store1 = new EditorStore()
    store1.setCollabMode(true)
    const store2 = new EditorStore()
    store2.setCollabMode(true)
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(store1, doc1)
    new CollabBridge(store2, doc2)

    const pkg = simplePackage('user.undo', 'definePart({ step() {} })')
    store1.addUserPackage(pkg)
    store1.commitPackage('Edit behavior', { ...pkg, behavior: 'definePart({ step(ctx) { ctx.rng() } })' })
    expect(readPackages(doc2).find((p) => p.id === pkg.id)?.behavior).toContain('rng')

    // Ctrl+Z reverts the behavior edit (the package itself stays) - everywhere
    store1.undo()
    expect(readPackages(doc1).find((p) => p.id === pkg.id)?.behavior).not.toContain('rng')
    expect(readPackages(doc2).find((p) => p.id === pkg.id)?.behavior).not.toContain('rng')
    expect(readPackages(doc2).some((p) => p.id === pkg.id)).toBe(true)
  })
})

// A room holds a copy of every placed part's package, built-in ones too. For a built-in id that copy is a snapshot of
// whatever build placed it, and must lose to this client's own bundled part. Otherwise a room made before a built-in
// part changed shows the old part forever (the snapshot registers before the bundle, then counts as a fork).
// Only an entry the room marks as an edit is a fork, and takes precedence, as a fork does solo.
describe('CollabBridge built-in parts: a room snapshot loses, an edit wins', () => {
  /** a store that ships `bundled`, registered the way loadBundledExamples registers it (authoritative) */
  function shipping(bundled: PartPackage): EditorStore {
    const store = new EditorStore()
    store.setCollabMode(true)
    registerPackage(bundled, true)
    store.setBundledPackages([bundled])
    return store
  }

  it("ignores the room's snapshot of a built-in part: this client's own copy stands, and it is no fork", () => {
    const bundled = { ...simplePackage('test.builtin-snap', 'definePart({ step() {} })'), name: 'Current' }
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), { ...bundled, name: 'Placed by an older build', behavior: 'definePart({ step(ctx) { ctx.rng() } })' })
    const store = shipping(bundled)
    new CollabBridge(store, doc)
    expect(getPackage(bundled.id)?.name).toBe('Current')
    expect(store.getState().userPackages.some((p) => p.id === bundled.id)).toBe(false)
  })

  it('takes an entry the room marks as an edit: a fork of a built-in part wins, and joins the catalog as one', () => {
    const bundled = { ...simplePackage('test.builtin-fork', 'definePart({ step() {} })'), name: 'Current' }
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), { ...bundled, name: 'Forked in the room' }, { edited: true })
    const store = shipping(bundled)
    new CollabBridge(store, doc)
    expect(getPackage(bundled.id)?.name).toBe('Forked in the room')
    expect(store.getState().userPackages.some((p) => p.id === bundled.id)).toBe(true)
  })

  it('marks an edit of a built-in part made in the room, so every peer takes it', () => {
    const bundled = { ...simplePackage('test.builtin-live', 'definePart({ step() {} })'), name: 'Current' }
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    const alice = shipping(bundled)
    const bob = shipping(bundled)
    new CollabBridge(alice, doc1)
    new CollabBridge(bob, doc2)
    alice.commitPackage('Edit part', { ...bundled, name: 'Alice’s fork' })
    expect(editedPackageIds(doc2).has(bundled.id)).toBe(true)
    expect(getPackage(bundled.id)?.name).toBe('Alice’s fork')
    expect(bob.getState().userPackages.some((p) => p.id === bundled.id)).toBe(true)
  })

  it("seeds the creator's own library as edits and every other placed part as a snapshot", () => {
    const doc = new Y.Doc()
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [],
      packages: [simplePackage('oip.placed', 'definePart({ step() {} })'), simplePackage('oip.forked', 'definePart({ step() {} })')],
    }
    sceneToDoc(scene, doc, undefined, new Set(['oip.forked']))
    expect([...editedPackageIds(doc)]).toEqual(['oip.forked'])
  })
})

describe('CollabBridge shared edit feed (History dock activity list)', () => {
  /** two stores in one relayed room, with named actors (the standard two-tab fixture) */
  function room(): { alice: EditorStore; bob: EditorStore; doc1: Y.Doc; doc2: Y.Doc } {
    const scene = richScene()
    const doc1 = new Y.Doc()
    sceneToDoc(scene, doc1)
    const alice = new EditorStore()
    alice.setCollabMode(true)
    alice.applyRemote(docToScene(doc1))
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    const bob = new EditorStore()
    bob.setCollabMode(true)
    bob.applyRemote(docToScene(doc2))
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(alice, doc1, undefined, false, () => 'Alice')
    new CollabBridge(bob, doc2, undefined, false, () => 'Bob')
    return { alice, bob, doc1, doc2 }
  }

  it("a commit's label reaches both clients' feeds, attributed and marked mine/theirs", () => {
    const { alice, bob } = room()
    alice.commit('Move belt', {
      ...alice.getState().scene,
      parts: alice.getState().scene.parts.map((p) => (p.id === 'bc_1' ? { ...p, position: [9, 0.75, 1] as [number, number, number] } : p)),
    })

    const a = alice.getEditHistory()
    expect(a.events.map((e) => e.label)).toEqual(['Move belt'])
    expect(a.events[0]).toMatchObject({ actor: 'Alice', mine: true, kind: 'scene' })
    expect(a.cursor).toBe(1) // a feed has no redo tail: the cursor sits past the newest event

    const b = bob.getEditHistory()
    expect(b.events.map((e) => e.label)).toEqual(['Move belt'])
    expect(b.events[0]).toMatchObject({ actor: 'Alice', mine: false })
  })

  it('a rapid same-key edit run coalesces into one feed row; a peer edit is never eaten', () => {
    const { alice, bob } = room()
    const move = (store: EditorStore, x: number): void =>
      store.commit(
        'Move belt',
        {
          ...store.getState().scene,
          parts: store.getState().scene.parts.map((p) => (p.id === 'bc_1' ? { ...p, position: [x, 0.75, 0] as [number, number, number] } : p)),
        },
        { coalesceKey: 'move:bc_1' },
      )
    move(alice, 5)
    move(alice, 6) // same client + key, within the window → replaces the row
    expect(alice.getEditHistory().events).toHaveLength(1)

    move(bob, 7) // same key but a different client → its own row
    expect(alice.getEditHistory().events).toHaveLength(2)
    expect(alice.getEditHistory().events.map((e) => e.actor)).toEqual(['Alice', 'Bob'])
  })

  it('an authored part and a behavior edit land in the feed as package events', () => {
    const { alice, bob } = room()
    const pkg = simplePackage('user.feed', 'definePart({ step() {} })')
    alice.addUserPackage(pkg)
    alice.commitPackage('Edit behavior', { ...pkg, behavior: 'definePart({ step(ctx) { ctx.rng() } })' })

    const labels = bob.getEditHistory().events.map((e) => `${e.kind}:${e.label}`)
    expect(labels).toEqual(['package:New part “Authored Part”', 'package:Edit behavior'])
  })

  it('a view-only client sees the feed but its own actions never reach it', () => {
    const scene = richScene()
    const doc1 = new Y.Doc()
    sceneToDoc(scene, doc1)
    const editor = new EditorStore()
    editor.setCollabMode(true)
    editor.applyRemote(docToScene(doc1))
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    const viewer = new EditorStore()
    viewer.setCollabMode(true)
    viewer.setReadOnly(true)
    viewer.applyRemote(docToScene(doc2))
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(editor, doc1, undefined, false, () => 'Alice')
    new CollabBridge(viewer, doc2, undefined, true)

    viewer.commit('Add', {
      ...viewer.getState().scene,
      parts: [...viewer.getState().scene.parts, createPart('group', 'rc_viewer', [6, 0.75, 0])],
    })
    expect(readEditFeed(doc1)).toHaveLength(0) // dropped commit → no event anywhere

    editor.commit('Add', {
      ...editor.getState().scene,
      parts: [...editor.getState().scene.parts, createPart('group', 'rc_editor', [4, 0.75, 0])],
    })
    expect(viewer.getEditHistory().events.map((e) => ({ label: e.label, actor: e.actor }))).toEqual([
      { label: 'Add', actor: 'Alice' },
    ])
  })
})

describe('edit-feed doc primitives', () => {
  const evt = (n: number, over: Partial<FeedEvent> = {}): FeedEvent => ({
    label: `edit ${n}`,
    time: n,
    kind: 'scene',
    actor: 'Alice',
    client: 1,
    ...over,
  })

  it('trims the front past the cap', () => {
    const doc = new Y.Doc()
    const arr = eventsArray(doc)
    doc.transact(() => {
      for (let i = 0; i < EVENT_CAP + 10; i++) appendEditEvent(arr, evt(i))
    })
    const feed = readEditFeed(doc)
    expect(feed).toHaveLength(EVENT_CAP)
    expect(feed[0]!.label).toBe('edit 10') // the 10 oldest fell off
  })

  it('coalesces only same-client same-key events inside the window', () => {
    const doc = new Y.Doc()
    const arr = eventsArray(doc)
    doc.transact(() => {
      appendEditEvent(arr, evt(0, { ck: 'k' }))
      appendEditEvent(arr, evt(100, { ck: 'k' })) // replaces (same client+key, fresh)
      appendEditEvent(arr, evt(200, { ck: 'k', client: 2, actor: 'Bob' })) // other client → own row
      appendEditEvent(arr, evt(5000, { ck: 'k' })) // stale (past the window) → own row
      appendEditEvent(arr, evt(5100)) // no key → never coalesces
    })
    expect(readEditFeed(doc).map((e) => e.time)).toEqual([100, 200, 5000, 5100])
  })

  it('readEditFeed drops malformed entries instead of crashing the panel', () => {
    const doc = new Y.Doc()
    const arr = eventsArray(doc)
    doc.transact(() => {
      arr.push([{ junk: true } as unknown as FeedEvent, evt(1)])
    })
    expect(readEditFeed(doc).map((e) => e.label)).toEqual(['edit 1'])
  })
})

describe('package doc serialization', () => {
  it('round-trips a package through the doc', () => {
    const doc = new Y.Doc()
    const pkg = simplePackage('user.rt', 'definePart({ step() {} })', true)
    writePackage(packagesMap(doc), pkg)
    expect(readPackages(doc)).toEqual([pkg])
  })

  it('a behavior-only edit does not rewrite the heavy asset blob', () => {
    const doc = new Y.Doc()
    const map = packagesMap(doc)
    const pkg = simplePackage('user.blob', 'definePart({ step() {} })', true)
    writePackage(map, pkg)
    const m = map.get(pkg.id)!
    const blobBefore = m.get('blob')
    expect(typeof blobBefore).toBe('string')
    expect(blobBefore).not.toBe('')

    writePackage(map, { ...pkg, behavior: 'definePart({ step(ctx) { ctx.rng() } })' })
    expect(m.get('behavior')).toContain('rng')
    expect(m.get('blob')).toBe(blobBefore) // unchanged - the embedded GLB isn't re-sent on a script edit
  })
})

describe('CollabBridge rebuild filter: what actually re-applies the scene', () => {
  // The room's ST program is co-edited text, so its binding writes one transaction per keystroke. Rebuilding
  // the whole scene on every client for each one (docToScene + applyRemote) costs ~9 ms on the demo scene.
  // The scene is decoded from parts/order/packages alone, so only those keys may trigger a rebuild.
  it("a peer's program keystrokes and meta writes don't rebuild the scene; a part change does", () => {
    const doc1 = new Y.Doc()
    sceneToDoc(richScene(), doc1)
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    const store = new EditorStore()
    store.setCollabMode(true)
    store.applyRemote(docToScene(doc2))
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    new CollabBridge(store, doc2)

    let rebuilds = 0
    const applyRemote = store.applyRemote.bind(store)
    store.applyRemote = (scene: SceneJSON): void => {
      rebuilds++
      applyRemote(scene)
    }

    // the peer types, one transaction per character (what y-codemirror produces)
    for (const ch of 'PROGRAM') doc1.transact(() => stProgramText(doc1).insert(stProgramText(doc1).length, ch), 'cm')
    expect(store.getState().stProgram).toBe('PROGRAM') // the text still arrives...
    expect(rebuilds).toBe(0) // ...without decoding the scene once per keystroke

    // nor is a `meta` key the scene (the scan time, the step rate, the room's build claim)
    doc1.transact(() => metaMap(doc1).set('stScanMs', 7), 'remote')
    expect(store.getState().stScanMs).toBe(7)
    expect(rebuilds).toBe(0)

    // the control: a part change does rebuild, or this test would pass vacuously
    doc1.transact(() => (partsMap(doc1).get('bc_1') as Y.Map<unknown>).set('px', 9), 'remote')
    expect(rebuilds).toBe(1)
    expect(store.getState().scene.parts.find((p) => p.id === 'bc_1')!.position[0]).toBe(9)
  })
})
