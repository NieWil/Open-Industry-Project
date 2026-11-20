import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createPart, createSdkPart, nextId, serializeScene, setNextIdSuffix } from '../core/scene/scene'
import { isAncestor } from '../core/scene/hierarchy'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON, SdkPart, SimRate } from '../core/types'
import { applySceneDiff } from './diff'
import {
  claimRoomBuild,
  docToScene,
  LOCAL_ORIGIN,
  makePartMap,
  metaMap,
  partsMap,
  orderArray,
  packagesMap,
  readRoomBuild,
  readSimHz,
  readStDoc,
  sceneToDoc,
  SIM_HZ_META,
  ST_PROGRAM_TEXT,
  writeSimHz,
  writeStDoc,
} from './schema'
import { seedIfEmpty } from './provider'
import { authoredCargoView, CollabBridge, overrideScene, withRunLocalCargo } from './bridge'
import type { BridgeStore, DragPose, PresenceSource } from './bridge'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

/** a representative scene: a building (its `rules` wall-rule list param exercises the nested-list shape) plus
 *  a few generic movable Group bodies to carry position / name / parent / provenance through the room */
function richScene(): SceneJSON {
  const building = createPart('building', 'bld_1', [0, 0, 0]) // has `rules` wall-rule list param
  const belt = createPart('group', 'bc_1', [2, 0.75, 0]) // a movable body
  const marking = createPart('group', 'bx_1', [1, 0, 1])
  const device = createPart('group', 'bst_1', [3, 0.5, 0])
  device.parent = 'bc_1' // a soft-parent link to round-trip
  return { version: SCENE_VERSION, parts: [building, belt, marking, device] }
}

/** canonical comparison: both scenes through the spec-based serializer (key order + defaults) */
function sameScene(a: SceneJSON, b: SceneJSON): void {
  expect(serializeScene(a)).toBe(serializeScene(b))
}

function seededDoc(scene: SceneJSON): Y.Doc {
  const doc = new Y.Doc()
  sceneToDoc(scene, doc)
  return doc
}

/** an inert BridgeStore that only records the shared PLC program handed back to it */
function stubStore(doc: Y.Doc, onProgram: (source: string, scanMs?: number) => void): BridgeStore {
  return {
    getState: () => ({ scene: docToScene(doc), selectedIds: [], running: false }),
    subscribe: () => () => {},
    applyRemote: () => {},
    setTransient: () => {},
    selectMany: () => {},
    setUndoDelegate: () => {},
    applyRemotePackages: () => {},
    setPackageSink: () => {},
    setEditEventSink: () => {},
    applyRemoteEditFeed: () => {},
    setStProgramSink: () => {},
    setProgramTransaction: () => {},
    applyRemoteStProgram: onProgram,
    setSimHzSink: () => {},
    applyRemoteSimHz: () => {},
  }
}

afterEach(() => {
  setNextIdSuffix('') // don't leak the room suffix into other tests
})

describe('schema round-trip', () => {
  it('sceneToDoc -> docToScene preserves the scene (incl. nested params, parent, order)', () => {
    const scene = richScene()
    sameScene(docToScene(seededDoc(scene)), scene)
  })

  it('walks `order`, not Y.Map iteration, to preserve part order', () => {
    const scene = richScene()
    const doc = seededDoc(scene)
    const ids = orderArray(doc).toArray()
    expect(ids).toEqual(scene.parts.map((p) => p.id))
    expect(docToScene(doc).parts.map((p) => p.id)).toEqual(scene.parts.map((p) => p.id))
  })

  it('ignores the linked-assembly and tag-scope keys a room doc written before they were retired may still hold', () => {
    const inst: PartInstance = createPart('group', 'rc_1', [1, 0.75, 2], 0.5)
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [inst] }
    const doc = seededDoc(scene)
    const m = partsMap(doc).get('rc_1')!
    m.set('masterId', 'prefab_1')
    m.set('instanceId', 'inst_7')
    m.set('masterKey', 'rc_root')
    m.set('overrides', '{"speed":0.25}')
    m.set('tagScope', 'Cell3')
    const back = docToScene(doc).parts[0]!
    for (const k of ['masterId', 'instanceId', 'masterKey', 'overrides', 'tagScope']) expect(k in back).toBe(false)
    sameScene(docToScene(doc), scene)
  })
})

/**
 * SDK parts are the whole equipment catalog (every conveyor, sensor, robot) - `type: 'part'` plus a
 * `packageId`, with params driven by that package's schema rather than PART_DEFS. richScene() above
 * uses only the two non-package types, so these cover the path that carries a REAL scene.
 */
describe('SDK parts in a room', () => {
  const DECK: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 'acme.deck',
    name: 'Acme Deck', conveyor: { surface: 'roller', speedParam: 'speed', reverseParam: 'reverse' },
    params: {
      speed: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.1, label: 'Belt speed' },
      reverse: { type: 'boolean', default: false },
      tag: { type: 'string', default: 'X1' },
      poses: { type: 'numberList', default: [[0, 0]], arity: 2, label: 'Poses' },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } },
  }

  /** an instance with every param moved OFF its default, so a dropped param can't pass as a default */
  function deckScene(): SceneJSON {
    const part = createSdkPart(DECK, 'cp_1', [2, 0.75, -1], 0.5)
    part.params.speed = 1.75
    part.params.reverse = true
    part.params.tag = 'B7'
    part.params.poses = [
      [1, 2],
      [3, 4],
    ]
    return { version: SCENE_VERSION, parts: [part], packages: [DECK] }
  }

  afterEach(() => clearPackages())

  it('carries packageId and the package-driven params through the doc', () => {
    // Without packageId every instance materializes as an unresolvable blank - for peers AND for the
    // writer, which re-reads its own doc via docToScene. Params are package-driven, so the built-in
    // PART_DEFS['part'].params walk (empty) would carry none of them.
    registerPackage(DECK)
    const scene = deckScene()
    const out = docToScene(seededDoc(scene))
    const part = out.parts[0] as SdkPart
    expect(part.packageId).toBe('acme.deck')
    expect(part.params).toEqual({ speed: 1.75, reverse: true, tag: 'B7', poses: [[1, 2], [3, 4]] })
    // compare the PARTS: the embedded packages round-trip too, but packageFromMap reassembles them
    // with `behavior` last, so their serialized key order legitimately differs
    const parts = (s: SceneJSON): SceneJSON => ({ version: s.version, parts: s.parts })
    sameScene(parts(out), parts(scene))
  })

  it('stores params independently of the registry (a part can arrive before its package)', () => {
    const scene = deckScene() // package not registered
    const doc = seededDoc(scene)
    const yp = partsMap(doc).get('cp_1')?.get('params') as Y.Map<unknown>
    expect(yp.get('speed')).toBe(1.75)
    expect(yp.get('poses')).toEqual([[1, 2], [3, 4]])
    // packageId survives the unregistered read, so the instance re-resolves in full once the
    // package lands (the bridge registers packages, then re-materializes the scene)
    expect((docToScene(doc).parts[0] as SdkPart).packageId).toBe('acme.deck')
    registerPackage(DECK)
    expect((docToScene(doc).parts[0] as SdkPart).params.speed).toBe(1.75)
  })

  it('syncs a changed param through applySceneDiff', () => {
    registerPackage(DECK)
    const prev = deckScene()
    const doc = seededDoc(prev)
    const edited = { ...(prev.parts[0] as SdkPart), params: { ...(prev.parts[0] as SdkPart).params, speed: 3.25 } }
    const next: SceneJSON = { ...prev, parts: [edited] }
    doc.transact(() => applySceneDiff(doc, prev, next), LOCAL_ORIGIN)
    expect((docToScene(doc).parts[0] as SdkPart).params.speed).toBe(3.25)
  })

  it('does not rewrite an unchanged numberList on every commit', () => {
    // SDK list params are stored as real arrays (not JSON-string atoms), and copied on the way in
    // and out - so an identity-only compare would re-set them on every unrelated edit, costing a doc
    // op and a full remote scene rebuild per drag frame.
    registerPackage(DECK)
    const prev = deckScene()
    const doc = seededDoc(prev)
    const yp = partsMap(doc).get('cp_1')?.get('params') as Y.Map<unknown>
    let paramWrites = 0
    yp.observe((e) => (paramWrites += e.changes.keys.size))

    const src = prev.parts[0] as SdkPart
    // a move: fresh part object, fresh params bag, equal-by-value list (what an immutable store hands us)
    const moved = { ...src, position: [4, 0.75, -1] as [number, number, number], params: { ...src.params, poses: (src.params.poses as number[][]).map((r) => [...r]) } }
    doc.transact(() => applySceneDiff(doc, prev, { ...prev, parts: [moved] }), LOCAL_ORIGIN)
    expect(paramWrites).toBe(0)

    const reposed = { ...moved, params: { ...moved.params, poses: [[9, 9]] } }
    doc.transact(() => applySceneDiff(doc, { ...prev, parts: [moved] }, { ...prev, parts: [reposed] }), LOCAL_ORIGIN)
    expect(paramWrites).toBe(1)
    expect((docToScene(doc).parts[0] as SdkPart).params.poses).toEqual([[9, 9]])
  })

  it('drops a part that has no package reference instead of materializing a blank', () => {
    registerPackage(DECK)
    const doc = seededDoc(deckScene())
    partsMap(doc).get('cp_1')?.delete('packageId') // the shape pre-fix clients wrote
    expect(docToScene(doc).parts).toEqual([])
  })
})

describe('applySceneDiff', () => {
  function diffInto(doc: Y.Doc, prev: SceneJSON, next: SceneJSON): SceneJSON {
    doc.transact(() => applySceneDiff(doc, prev, next), LOCAL_ORIGIN)
    return docToScene(doc)
  }

  it('adds a part', () => {
    const prev = richScene()
    const doc = seededDoc(prev)
    const next: SceneJSON = { ...prev, parts: [...prev.parts, createPart('group', 'rc_9', [9, 0.75, 0])] }
    sameScene(diffInto(doc, prev, next), next)
  })

  it('moves + renames a part (field-level change)', () => {
    const prev = richScene()
    const doc = seededDoc(prev)
    const moved: PartInstance = { ...prev.parts[1]!, position: [5, 0.75, 2], name: 'Main belt' }
    const next: SceneJSON = { ...prev, parts: prev.parts.map((p) => (p.id === 'bc_1' ? moved : p)) }
    sameScene(diffInto(doc, prev, next), next)
  })

  it('deletes a part', () => {
    const prev = richScene()
    const doc = seededDoc(prev)
    const next: SceneJSON = { ...prev, parts: prev.parts.filter((p) => p.id !== 'sl_1') }
    const out = diffInto(doc, prev, next)
    expect(out.parts.find((p) => p.id === 'sl_1')).toBeUndefined()
    sameScene(out, next)
  })

  it('reorders parts', () => {
    const prev = richScene()
    const doc = seededDoc(prev)
    const next: SceneJSON = { ...prev, parts: [...prev.parts].reverse() }
    expect(diffInto(doc, prev, next).parts.map((p) => p.id)).toEqual(next.parts.map((p) => p.id))
  })
})

describe('concurrent merge', () => {
  /** sync b up to a's state, then return both docs ready for divergent edits */
  function fork(scene: SceneJSON): [Y.Doc, Y.Doc] {
    const a = seededDoc(scene)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    return [a, b]
  }
  function merge(a: Y.Doc, b: Y.Doc): void {
    const ua = Y.encodeStateAsUpdate(a)
    const ub = Y.encodeStateAsUpdate(b)
    Y.applyUpdate(a, ub)
    Y.applyUpdate(b, ua)
  }

  it('edits to different parts both survive', () => {
    const scene = richScene()
    const [a, b] = fork(scene)
    // a moves the belt; b renames the box
    a.transact(() => {
      const m = partsMap(a).get('bc_1')!
      m.set('px', 7)
    }, LOCAL_ORIGIN)
    b.transact(() => {
      const m = partsMap(b).get('bx_1')!
      m.set('name', 'Picker')
    }, LOCAL_ORIGIN)
    merge(a, b)
    for (const doc of [a, b]) {
      const out = docToScene(doc)
      expect(out.parts.find((p) => p.id === 'bc_1')!.position[0]).toBe(7)
      expect(out.parts.find((p) => p.id === 'bx_1')!.name).toBe('Picker')
    }
    sameScene(docToScene(a), docToScene(b))
  })

  it('edits to different fields of the same part both survive', () => {
    const scene = richScene()
    const [a, b] = fork(scene)
    a.transact(() => partsMap(a).get('bc_1')!.set('px', 9), LOCAL_ORIGIN)
    b.transact(() => partsMap(b).get('bc_1')!.set('name', 'Belt A'), LOCAL_ORIGIN)
    merge(a, b)
    const out = docToScene(a)
    const belt = out.parts.find((p) => p.id === 'bc_1')!
    expect(belt.position[0]).toBe(9)
    expect(belt.name).toBe('Belt A')
    sameScene(docToScene(a), docToScene(b))
  })

  it('concurrent A<->B reparent converges to an acyclic tree', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [createPart('group', 'rc_1', [0, 0.75, 0]), createPart('group', 'rc_2', [2, 0.75, 0])],
    }
    const [a, b] = fork(scene)
    a.transact(() => partsMap(a).get('rc_1')!.set('parent', 'rc_2'), LOCAL_ORIGIN)
    b.transact(() => partsMap(b).get('rc_2')!.set('parent', 'rc_1'), LOCAL_ORIGIN)
    merge(a, b)
    const out = docToScene(a)
    // sanitizeParents broke the cycle deterministically: they can't both still be parented
    const r1 = out.parts.find((p) => p.id === 'rc_1')!
    const r2 = out.parts.find((p) => p.id === 'rc_2')!
    expect(r1.parent !== undefined && r2.parent !== undefined).toBe(false)
    expect(isAncestor(out.parts, 'rc_1', 'rc_2') && isAncestor(out.parts, 'rc_2', 'rc_1')).toBe(false)
    sameScene(docToScene(a), docToScene(b))
  })

  it('two clients placing into the same scene mint unique ids', () => {
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [] }
    // client A and B each compute the next part id from the same empty scene
    setNextIdSuffix('~a')
    const idA = nextId(scene, 'group')
    setNextIdSuffix('~b')
    const idB = nextId(scene, 'group')
    expect(idA).not.toBe(idB)
    expect(idA).toBe('grp_1~a')
    expect(idB).toBe('grp_1~b')
    // both land as distinct map keys after a merge
    const [a, b] = fork(scene)
    a.transact(() => {
      partsMap(a).set(idA, makePartMap(createPart('group', idA, [0, 0.75, 0])))
      orderArray(a).push([idA])
    }, LOCAL_ORIGIN)
    b.transact(() => {
      partsMap(b).set(idB, makePartMap(createPart('group', idB, [2, 0.75, 0])))
      orderArray(b).push([idB])
    }, LOCAL_ORIGIN)
    merge(a, b)
    expect(docToScene(a).parts.map((p) => p.id).sort()).toEqual([idA, idB].sort())
  })

  it('normalizes out-of-range / invalid params from a peer on rebuild', () => {
    const doc = seededDoc({
      version: SCENE_VERSION,
      parts: [createPart('building', 'bld_1', [0, 0, 0])],
    })
    // a peer (or buggy client) writes garbage straight into the part's params Y.Map
    doc.transact(() => {
      const yp = partsMap(doc).get('bld_1')!.get('params') as Y.Map<unknown>
      yp.set('brightness', 999) // spec range is [0, 3]
      yp.set('backgroundColor', 'bogus') // not a valid hex colour
      yp.set('heightSections', Number.NaN) // not finite
    })
    const params = docToScene(doc).parts.find((p) => p.id === 'bld_1')!.params as {
      brightness: number
      backgroundColor: string
      heightSections: number
    }
    expect(params.brightness).toBe(3) // clamped to max
    expect(params.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i) // reset to a valid colour
    expect(Number.isFinite(params.heightSections)).toBe(true) // NaN replaced by the default
  })

  it('reconciles to a single building when two are placed concurrently', () => {
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [createPart('building', 'bld_1', [0, 0, 0])] }
    const [a, b] = fork(scene)
    b.transact(() => {
      partsMap(b).set('bld_2', makePartMap(createPart('building', 'bld_2', [10, 0, 0])))
      orderArray(b).push(['bld_2'])
    }, LOCAL_ORIGIN)
    merge(a, b)
    expect(docToScene(a).parts.filter((p) => p.type === 'building')).toHaveLength(1)
  })

  it('concurrent reorders converge with no part lost or duplicated', () => {
    // applySceneDiff rewrites `order` wholesale (delete-all + insert), so two concurrent reorders
    // merge to an array holding BOTH inserts - every id twice. docToScene must read that as one
    // valid scene (first occurrence wins via `seen`), identically on both peers.
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [1, 2, 3, 4].map((n) => createPart('group', `rc_${n}`, [n, 0.75, 0])),
    }
    const [a, b] = fork(scene)
    // a reverses the tree; b moves rc_3 to the front - classic conflicting drag-reorders
    const reversed: SceneJSON = { ...scene, parts: [...scene.parts].reverse() }
    const promoted: SceneJSON = { ...scene, parts: [scene.parts[2]!, ...scene.parts.filter((p) => p.id !== 'rc_3')] }
    a.transact(() => applySceneDiff(a, scene, reversed), LOCAL_ORIGIN)
    b.transact(() => applySceneDiff(b, scene, promoted), LOCAL_ORIGIN)
    merge(a, b)
    const out = docToScene(a)
    // no loss, no duplicates, and both peers materialize the identical scene
    expect(out.parts.map((p) => p.id).sort()).toEqual(['rc_1', 'rc_2', 'rc_3', 'rc_4'])
    sameScene(out, docToScene(b))
    // the duplicate-laden order array self-heals: the next local diff sees the mismatch and compacts it
    a.transact(() => applySceneDiff(a, out, out), LOCAL_ORIGIN)
    expect(orderArray(a).toArray()).toEqual(out.parts.map((p) => p.id))
  })
})

describe('shared ST program', () => {
  it('seedIfEmpty seeds the program text into the doc (Share carries the PLC logic)', () => {
    const doc = new Y.Doc()
    const seeded = seedIfEmpty(doc, { version: SCENE_VERSION, parts: [] }, 'Motor := Start;')
    expect(seeded).toBe(true)
    expect(doc.getText(ST_PROGRAM_TEXT).toString()).toBe('Motor := Start;')
  })

  it('does not re-seed a non-empty room', () => {
    const doc = seededDoc(richScene())
    const seeded = seedIfEmpty(doc, { version: SCENE_VERSION, parts: [] }, 'X := 1;')
    expect(seeded).toBe(false)
    expect(doc.getText(ST_PROGRAM_TEXT).toString()).toBe('')
  })

  it('seeds the scan time alongside the program, so a room runs at the timing it was authored at', () => {
    const doc = new Y.Doc()
    seedIfEmpty(doc, { version: SCENE_VERSION, parts: [] }, 'Motor := Start;', 40)
    expect(readStDoc(doc)).toEqual({ source: 'Motor := Start;', scanMs: 40, controller: null })
  })

  it('reports no scan time for a room seeded without one (an older room), so a peer keeps its own', () => {
    const doc = new Y.Doc()
    seedIfEmpty(doc, { version: SCENE_VERSION, parts: [] }, 'Motor := Start;')
    expect(readStDoc(doc).scanMs).toBeUndefined()
  })

  it("seeds the project's physics step rate, program or not, so every peer steps the same world", () => {
    const doc = new Y.Doc()
    seedIfEmpty(doc, { version: SCENE_VERSION, parts: [] }, undefined, undefined, 240)
    expect(readSimHz(doc)).toBe(240)
  })

  it('a default-rate seed writes nothing, and a room without the key (an older room) runs at the default', () => {
    const doc = new Y.Doc()
    seedIfEmpty(doc, { version: SCENE_VERSION, parts: [] }, 'Motor := Start;', 40, DEFAULT_SIM_HZ)
    expect(metaMap(doc).has(SIM_HZ_META)).toBe(false)
    expect(readSimHz(doc)).toBe(DEFAULT_SIM_HZ)
  })

  it("flows the room's rate into the store at join and on a peer's change, and writes a local change back", () => {
    const doc = new Y.Doc()
    const seen: SimRate[] = []
    let sink: ((hz: SimRate) => void) | null = null
    const bridge = new CollabBridge(
      { ...stubStore(doc, () => {}), applyRemoteSimHz: (hz) => void seen.push(hz), setSimHzSink: (s) => void (sink = s) },
      doc,
    )
    expect(seen).toEqual([DEFAULT_SIM_HZ]) // joined a room that never set one
    const peer = new Y.Doc()
    writeSimHz(peer, 120)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    expect(seen.at(-1)).toBe(120)
    expect(sink).not.toBeNull()
    sink!(240)
    expect(readSimHz(doc)).toBe(240)
    bridge.destroy()
  })

  it('a view-only client still receives the rate (it steps its own private world)', () => {
    const doc = new Y.Doc()
    writeSimHz(doc, 240)
    const seen: SimRate[] = []
    const bridge = new CollabBridge({ ...stubStore(doc, () => {}), applyRemoteSimHz: (hz) => void seen.push(hz) }, doc, undefined, true)
    expect(seen).toEqual([240])
    bridge.destroy()
  })

  /**
   * The join race. `whenSynced` resolves on the IndexedDB cache plus a 4 s server timeout, so a
   * slow or unreachable Hocuspocus VM boots the editor against an empty doc. The bridge re-applies
   * the scene when the sync arrives. A program read once at the run edge would not follow, so a Play
   * pressed in that window would attach an empty program until a manual Stop/Play. The program is
   * store state, and the bridge mirrors the Y.Text into it on every change, arrival included.
   */
  it('flows a program that lands after join into the store', () => {
    const doc = new Y.Doc()
    const seen: Array<{ source: string; scanMs?: number }> = []
    const bridge = new CollabBridge(stubStore(doc, (source, scanMs) => seen.push({ source, scanMs })), doc)
    expect(seen).toEqual([{ source: '', scanMs: undefined }]) // joined an empty room
    // the server's state arrives late (a peer's doc, or our own cache filling in)
    const peer = new Y.Doc()
    writeStDoc(peer, 'Motor := Start;', 25)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    expect(seen.at(-1)).toEqual({ source: 'Motor := Start;', scanMs: 25 })
    bridge.destroy()
  })

  it('writes a program replacement back to the doc through the store sink', () => {
    const doc = new Y.Doc()
    let sink: ((doc: { source: string; scanMs: number; controller: ReturnType<typeof readStDoc>['controller'] }) => void) | null = null
    const bridge = new CollabBridge(
      { ...stubStore(doc, () => {}), setStProgramSink: (s) => void (sink = s) },
      doc,
    )
    expect(sink).not.toBeNull()
    sink!({ source: 'X := 1;', scanMs: 50, controller: null })
    expect(readStDoc(doc)).toEqual({ source: 'X := 1;', scanMs: 50, controller: null })
    bridge.destroy()
  })

  it("carries the program's controller table both ways, and reads a table it cannot validate as none", () => {
    const doc = new Y.Doc()
    const table = { tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }], programs: [{ name: 'A', type: 'P', task: 'Fast' }] }
    const seen: unknown[] = []
    let sink: ((doc: { source: string; scanMs: number; controller: ReturnType<typeof readStDoc>['controller'] }) => void) | null = null
    const bridge = new CollabBridge(
      { ...stubStore(doc, () => {}), applyRemoteStProgram: (_s, _m, c) => void seen.push(c), setStProgramSink: (s) => void (sink = s) },
      doc,
    )
    sink!({ source: 'X := 1;', scanMs: 50, controller: table })
    expect(readStDoc(doc).controller).toEqual(table)
    expect(seen.at(-1)).toEqual(table) // the doc observer hands it to the store, as it does the text
    // a peer's write this client cannot read is no table at all, never a half-read one...
    metaMap(doc).set('stController', '{"tasks": 5}')
    expect(seen.at(-1)).toBeNull()
    // ...and not this client's to replace. The store hands the none it adopted back on its next program commit (an
    // Assign I/O, a rename), which must not delete a newer build's table for everyone in the room
    sink!({ source: 'X := 2;', scanMs: 50, controller: null })
    expect(metaMap(doc).get('stController')).toBe('{"tasks": 5}')
    expect(readStDoc(doc).source).toBe('X := 2;') // the program itself still goes
    bridge.destroy()
  })

  it('writes the table and the scan time only when this client changed them', () => {
    const doc = new Y.Doc()
    const table = { tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }], programs: [{ name: 'A', type: 'P', task: 'Fast' }] }
    // a store that adopts the room's program the way EditorStore does: the scan time rounded, the table validated
    const state = { scanMs: 10, controller: null as unknown }
    let sink: ((doc: { source: string; scanMs: number; controller: ReturnType<typeof readStDoc>['controller'] }) => void) | null = null
    const bridge = new CollabBridge(
      {
        ...stubStore(doc, () => {}),
        getState: () => ({ scene: docToScene(doc), selectedIds: [], running: false, stScanMs: state.scanMs }),
        applyRemoteStProgram: (_s, m, c) => {
          if (m !== undefined) state.scanMs = Math.round(m)
          if (c !== undefined) state.controller = c
        },
        setStProgramSink: (s) => void (sink = s),
      },
      doc,
    )
    // a newer build wrote a table with a field this build drops, and a scan time it rounds
    const newer = JSON.stringify({ ...table, watchdogMs: 50 })
    doc.transact(() => {
      metaMap(doc).set('stController', newer)
      metaMap(doc).set('stScanMs', 2.5)
    })
    expect(state).toEqual({ scanMs: 3, controller: table })
    // an unrelated program commit hands both back as adopted: neither is written
    sink!({ source: 'X := 1;', scanMs: 3, controller: table })
    expect(metaMap(doc).get('stController')).toBe(newer)
    expect(metaMap(doc).get('stScanMs')).toBe(2.5)
    // a change this client made does go, and so does clearing a table it can read
    sink!({ source: 'X := 1;', scanMs: 20, controller: { ...table, programs: [] } })
    expect(readStDoc(doc)).toMatchObject({ scanMs: 20, controller: { ...table, programs: [] } })
    sink!({ source: 'X := 1;', scanMs: 20, controller: null })
    expect(metaMap(doc).has('stController')).toBe(false)
    bridge.destroy()
  })

  it('seeds the controller table with the program', () => {
    const doc = new Y.Doc()
    const table = { tasks: [], programs: [{ name: 'A', type: 'P' }] }
    seedIfEmpty(doc, { version: SCENE_VERSION, parts: [] }, 'PROGRAM P END_PROGRAM', 40, undefined, table)
    expect(readStDoc(doc).controller).toEqual(table)
  })

  it('a view-only client still receives the program (it runs its own private sim)', () => {
    const doc = new Y.Doc()
    writeStDoc(doc, 'Motor := Start;', 30)
    const seen: string[] = []
    const bridge = new CollabBridge(stubStore(doc, (s) => seen.push(s)), doc, undefined, true)
    expect(seen).toEqual(['Motor := Start;'])
    bridge.destroy()
  })

  it('concurrent program edits merge as text (CRDT), not last-writer-wins', () => {
    const a = new Y.Doc()
    a.getText(ST_PROGRAM_TEXT).insert(0, 'A;\n')
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    // a appends a line at the end; b prepends one at the start
    a.transact(() => a.getText(ST_PROGRAM_TEXT).insert(a.getText(ST_PROGRAM_TEXT).length, 'C;\n'))
    b.transact(() => b.getText(ST_PROGRAM_TEXT).insert(0, 'B;\n'))
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(a.getText(ST_PROGRAM_TEXT).toString()).toBe(b.getText(ST_PROGRAM_TEXT).toString())
    expect(a.getText(ST_PROGRAM_TEXT).toString()).toBe('B;\nA;\nC;\n')
  })
})

describe('live drag streaming', () => {
  it('overrideScene swaps only the dragged parts to their live pose', () => {
    const base = richScene()
    const drags = new Map<string, DragPose>([['bc_1', { id: 'bc_1', position: [9, 0.75, 4], rotationY: 1.5 }]])
    const out = overrideScene(base, drags)
    const belt = out.parts.find((p) => p.id === 'bc_1')!
    expect(belt.position).toEqual([9, 0.75, 4])
    expect(belt.rotationY).toBe(1.5)
    // untouched parts keep their committed pose and object identity
    expect(out.parts.find((p) => p.id === 'bx_1')).toBe(base.parts.find((p) => p.id === 'bx_1'))
    expect(overrideScene(base, new Map())).toBe(base)
  })

  it('bridge shows a peer drag as a transient, then reverts to the committed scene on drag end', () => {
    const doc = seededDoc(richScene())
    let transient: SceneJSON | null = null
    let applied: SceneJSON | null = null
    const store: BridgeStore = {
      getState: () => ({ scene: docToScene(doc), selectedIds: [], running: false }),
      subscribe: () => () => {},
      applyRemote: (s) => {
        applied = s
      },
      setTransient: (s) => {
        transient = s
      },
      selectMany: () => {},
      setUndoDelegate: () => {},
      applyRemotePackages: () => {},
      setPackageSink: () => {},
      setEditEventSink: () => {},
      applyRemoteEditFeed: () => {},
      setStProgramSink: () => {},
      applyRemoteStProgram: () => {},
      setSimHzSink: () => {},
      applyRemoteSimHz: () => {},
      setProgramTransaction: () => {},
    }
    let drags = new Map<string, DragPose>()
    let cb = (): void => {}
    const presence: PresenceSource = {
      subscribe: (c) => {
        cb = c
        return () => {}
      },
      remoteDragPoses: () => drags,
      isLocalDragging: () => false,
    }
    new CollabBridge(store, doc, presence)

    // a peer starts dragging the belt to a new spot → rendered as a transient override
    drags = new Map([['bc_1', { id: 'bc_1', position: [12, 0.75, 0], rotationY: 0 }]])
    cb()
    expect(transient).not.toBeNull()
    expect(transient!.parts.find((p) => p.id === 'bc_1')!.position[0]).toBe(12)

    // peer ends the drag (no commit moved it) → revert to the authoritative committed scene
    drags = new Map()
    cb()
    expect(applied).not.toBeNull()
    expect(applied!.parts.find((p) => p.id === 'bc_1')!.position[0]).toBe(2)
  })
})

/** a minimal EditorStore stand-in: holds the scene + run flag and notifies the bridge the way setState does */
function fakeStore(initial: SceneJSON): {
  store: BridgeStore
  scene: () => SceneJSON
  setRunning: (r: boolean) => void
  commit: (next: SceneJSON) => void
} {
  let scene = initial
  let running = false
  let notify = (): void => {}
  return {
    store: {
      getState: () => ({ scene, selectedIds: [], running }),
      subscribe: (cb) => {
        notify = cb
        return () => {}
      },
      applyRemote: (s) => void (scene = s),
      setTransient: (s) => void (scene = s),
      selectMany: () => {},
      setUndoDelegate: () => {},
      applyRemotePackages: () => {},
      setPackageSink: () => {},
      setEditEventSink: () => {},
      applyRemoteEditFeed: () => {},
      setStProgramSink: () => {},
      applyRemoteStProgram: () => {},
      setSimHzSink: () => {},
      applyRemoteSimHz: () => {},
      setProgramTransaction: () => {},
    },
    scene: () => scene,
    setRunning: (r) => {
      running = r
      notify()
    },
    commit: (next) => {
      scene = next
      notify()
    },
  }
}

/**
 * "Shared design, personal run" (docs/collab.md): the sim is a private per-client preview, so its
 * runtime must not reach the shared doc. Handling a live box (pilot pick-up, click/band-select of a
 * spawner box, a gizmo drag, a mid-run drop or duplicate) goes through `store.commit` like real
 * authoring, so without the cargo mask it reaches every peer's scene as an authored edit.
 */
describe('cargo while the local sim runs stays out of the shared doc', () => {
  const BOX: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 'oip.box',
    name: 'Box',
    params: {
      length: { type: 'number', default: 0.4 },
      height: { type: 'number', default: 0.3 },
      width: { type: 'number', default: 0.3 },
      mass: { type: 'number', default: 10 },
      color: { type: 'string', default: '#c8a05a' },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.4, width: 0.3, height: 0.3 } },
  }

  /** an authored line: one conveyor plus one authored box parked at its head */
  function lineScene(): SceneJSON {
    return { version: SCENE_VERSION, parts: [createPart('group', 'bc_1', [2, 0.75, 0]), box('bx_1', [0, 1, 0])], packages: [BOX] }
  }

  const box = (id: string, at: [number, number, number]): PartInstance => createSdkPart(BOX, id, at, 0)

  const docIds = (doc: Y.Doc): string[] => docToScene(doc).parts.map((p) => p.id)
  const docPart = (doc: Y.Doc, id: string): PartInstance => docToScene(doc).parts.find((p) => p.id === id)!

  afterEach(() => clearPackages())

  it('authoredCargoView drops run-local cargo and pins doc cargo to the doc', () => {
    registerPackage(BOX)
    const doc = lineScene()
    const belt = doc.parts[0]!
    const local: SceneJSON = {
      ...doc,
      // the authored box has been carried down the belt by OUR physics; a spawner box was promoted
      parts: [belt, box('bx_1', [5, 1, 0]), box('bx_9', [3, 1, 0])],
    }
    const out = authoredCargoView(local, doc)
    expect(out.parts.map((p) => p.id)).toEqual(['bc_1', 'bx_1'])
    expect(out.parts[1]!.position).toEqual([0, 1, 0]) // the DOC's pose, not the belt-carried one
    expect(out.parts[0]).toBe(belt) // non-cargo passes through by identity
  })

  // physics owns a box's POSE mid-run, not the box: its settings are authoring and still reach peers
  it('authoredCargoView lets a running box’s settings through and pins only its pose', () => {
    registerPackage(BOX)
    const doc = lineScene()
    const mine = { ...doc.parts[1]!, position: [5, 1, 0], params: { ...doc.parts[1]!.params, color: '#ff0000' } } as PartInstance
    const out = authoredCargoView({ ...doc, parts: [doc.parts[0]!, mine] }, doc)
    expect(out.parts[1]!.position).toEqual([0, 1, 0]) // the doc's pose...
    expect((out.parts[1]!.params as Record<string, unknown>).color).toBe('#ff0000') // ...our setting
  })

  // moving a pallet-load GROUP mid-run is layout authoring, and the loads inside it go with it
  it('authoredCargoView carries a box with the group this change moved, from the doc pose', () => {
    registerPackage(BOX)
    const group = createPart('group', 'g_1', [0, 0, 0])
    const inGroup = { ...box('bx_1', [1, 1, 0]), parent: 'g_1' } as PartInstance
    const doc: SceneJSON = { version: SCENE_VERSION, parts: [group, inGroup], packages: [BOX] }
    // our run had carried the box to x=4; then the group moved +2 in x, taking the box to x=6
    const prev: SceneJSON = { ...doc, parts: [group, { ...inGroup, position: [4, 1, 0] } as PartInstance] }
    const local: SceneJSON = { ...doc, parts: [{ ...group, position: [2, 0, 0] } as PartInstance, { ...inGroup, position: [6, 1, 0] } as PartInstance] }
    expect(authoredCargoView(local, doc, prev).parts[1]!.position).toEqual([3, 1, 0]) // the DOC pose carried +2, not x=6
    expect(authoredCargoView(local, doc).parts[1]!.position).toEqual([1, 1, 0]) // no previous scene: nothing carried
  })

  it('withRunLocalCargo puts this run’s own boxes back on top of the doc', () => {
    registerPackage(BOX)
    const doc = lineScene()
    const local: SceneJSON = { ...doc, parts: [...doc.parts, box('bx_9', [3, 1, 0])] }
    expect(withRunLocalCargo(doc, local).parts.map((p) => p.id)).toEqual(['bc_1', 'bx_1', 'bx_9'])
    expect(withRunLocalCargo(doc, doc)).toBe(doc) // nothing run-local: same object, no churn
  })

  it('a box promoted mid-run never reaches peers, but a real edit in the same run still does', () => {
    registerPackage(BOX)
    const scene = lineScene()
    const doc = seededDoc(scene)
    const fake = fakeStore(scene)
    const bridge = new CollabBridge(fake.store, doc)
    fake.setRunning(true)

    // pilot grabs a spawner box → promoteCargoBoxes commits a brand-new cargo part
    fake.commit({ ...scene, parts: [...scene.parts, box('bx_9', [3, 1, 0])] })
    expect(docIds(doc)).toEqual(['bc_1', 'bx_1'])

    // …and dragging the authored box down the line commits the pose physics gave it
    fake.commit({ ...fake.scene(), parts: fake.scene().parts.map((p) => (p.id === 'bx_1' ? box('bx_1', [5, 1, 0]) : p)) })
    expect(docPart(doc, 'bx_1').position).toEqual([0, 1, 0])

    // moving a conveyor mid-run is authoring, not sim runtime - that still propagates live
    fake.commit({ ...fake.scene(), parts: fake.scene().parts.map((p) => (p.id === 'bc_1' ? { ...p, position: [9, 0.75, 0] } : p)) })
    expect(docPart(doc, 'bc_1').position).toEqual([9, 0.75, 0])
    expect(docIds(doc)).toEqual(['bc_1', 'bx_1']) // still no phantom box
    bridge.destroy()
  })

  it('a peer edit landing mid-run keeps this run’s own boxes alive', () => {
    // without the merge, rebuilding from the doc deletes the boxes our physics is still stepping and
    // leaves their bodies dangling (the sim frame reports part ids the scene no longer has)
    registerPackage(BOX)
    const scene = lineScene()
    const doc = seededDoc(scene)
    const fake = fakeStore(scene)
    const bridge = new CollabBridge(fake.store, doc)
    fake.setRunning(true)
    fake.commit({ ...scene, parts: [...scene.parts, box('bx_9', [3, 1, 0])] })

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    peer.transact(() => partsMap(peer).get('bc_1')!.set('px', 7))
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))

    expect(fake.scene().parts.find((p) => p.id === 'bc_1')!.position[0]).toBe(7) // the peer's edit landed
    expect(fake.scene().parts.map((p) => p.id)).toContain('bx_9') // our run's box survived it
    bridge.destroy()
  })

  it('Stop re-asserts the doc’s cargo instead of leaking the run into the next commit', () => {
    registerPackage(BOX)
    const scene = lineScene()
    const doc = seededDoc(scene)
    const fake = fakeStore(scene)
    const bridge = new CollabBridge(fake.store, doc)
    fake.setRunning(true)
    fake.commit({
      ...scene,
      parts: [scene.parts[0]!, box('bx_1', [5, 1, 0]), box('bx_9', [3, 1, 0])],
    })

    fake.setRunning(false)
    // the run's own box is gone and the authored one is back where it was designed - locally AND in
    // the doc. Before this, both rode out on the next unrelated commit as a delayed peer teleport.
    expect(fake.scene().parts.map((p) => p.id)).toEqual(['bc_1', 'bx_1'])
    expect(fake.scene().parts[1]!.position).toEqual([0, 1, 0])

    fake.commit({ ...fake.scene(), parts: fake.scene().parts.map((p) => (p.id === 'bc_1' ? { ...p, position: [9, 0.75, 0] } : p)) })
    expect(docIds(doc)).toEqual(['bc_1', 'bx_1'])
    expect(docPart(doc, 'bx_1').position).toEqual([0, 1, 0])
    bridge.destroy()
  })

  it('a stopped client still shares cargo edits normally', () => {
    registerPackage(BOX)
    const scene = lineScene()
    const doc = seededDoc(scene)
    const fake = fakeStore(scene)
    const bridge = new CollabBridge(fake.store, doc)
    // designing the line: placing and moving cargo while STOPPED is authoring like anything else
    fake.commit({ ...scene, parts: [...scene.parts, box('bx_2', [3, 1, 0])] })
    expect(docIds(doc)).toEqual(['bc_1', 'bx_1', 'bx_2'])
    fake.commit({ ...fake.scene(), parts: fake.scene().parts.map((p) => (p.id === 'bx_1' ? box('bx_1', [1, 1, 0]) : p)) })
    expect(docPart(doc, 'bx_1').position).toEqual([1, 1, 0])
    bridge.destroy()
  })
})

describe('the room build check', () => {
  // a store that records the writers the bridge installs, and whether it was told a newer build joined
  function buildStore(doc: Y.Doc): { store: BridgeStore; seen: { yielded: number; programSink: unknown; undo: unknown } } {
    const seen = { yielded: 0, programSink: null as unknown, undo: null as unknown }
    const store: BridgeStore = {
      ...stubStore(doc, () => {}),
      setStProgramSink: (s) => void (seen.programSink = s),
      setUndoDelegate: (d) => void (seen.undo = d),
      yieldToNewerBuild: () => void seen.yielded++,
    }
    return { store, seen }
  }
  const OLD = 1_700_000_000
  const NEW = 1_800_000_000
  const editor = (store: BridgeStore, doc: Y.Doc, build: number) => new CollabBridge(store, doc, undefined, false, undefined, undefined, build)

  it('an editor claims an unclaimed room for its build; a viewer never does', () => {
    const doc = new Y.Doc()
    editor(buildStore(doc).store, doc, OLD).destroy()
    expect(readRoomBuild(doc)).toBe(OLD)
    const viewed = new Y.Doc()
    new CollabBridge(buildStore(viewed).store, viewed, undefined, true, undefined, undefined, NEW).destroy()
    expect(readRoomBuild(viewed)).toBeUndefined()
  })

  it('an older build joining a room a newer one has claimed starts view-only, and writes nothing', () => {
    const doc = new Y.Doc()
    claimRoomBuild(doc, NEW)
    const { store, seen } = buildStore(doc)
    const bridge = editor(store, doc, OLD)
    expect(seen.yielded).toBe(1)
    expect(seen.programSink).toBeNull() // never installed
    expect(seen.undo).toBeNull()
    expect(readRoomBuild(doc)).toBe(NEW) // and it did not claim the room back down
    bridge.destroy()
  })

  it('a newer build joining later stops an older editor that is already open, live', () => {
    const doc = new Y.Doc()
    const { store, seen } = buildStore(doc)
    const bridge = editor(store, doc, OLD)
    expect(typeof seen.programSink).toBe('function')
    expect(seen.undo).not.toBeNull()
    // the newer tab's claim arrives as a peer's update
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    claimRoomBuild(peer, NEW)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    expect(seen.yielded).toBe(1)
    expect(seen.programSink).toBeNull()
    expect(seen.undo).toBeNull()
    bridge.destroy()
  })

  it('two claims made at once settle on the newer build, whichever the map kept first', () => {
    // concurrent sets of one map key resolve by client id, so run it both ways round
    for (const [newerId, olderId] of [[1, 2], [2, 1]]) {
      const newer = new Y.Doc()
      newer.clientID = newerId!
      const older = new Y.Doc()
      older.clientID = olderId!
      const n = buildStore(newer)
      const o = buildStore(older)
      const nb = editor(n.store, newer, NEW)
      const ob = editor(o.store, older, OLD)
      for (let i = 0; i < 3; i++) {
        Y.applyUpdate(older, Y.encodeStateAsUpdate(newer))
        Y.applyUpdate(newer, Y.encodeStateAsUpdate(older))
      }
      expect(readRoomBuild(newer)).toBe(NEW)
      expect(readRoomBuild(older)).toBe(NEW)
      expect(o.seen.yielded).toBe(1)
      expect(n.seen.yielded).toBe(0)
      nb.destroy()
      ob.destroy()
    }
  })

  it('checks nothing without a build stamp (tests, a build without git)', () => {
    const doc = new Y.Doc()
    claimRoomBuild(doc, NEW)
    const { store, seen } = buildStore(doc)
    const bridge = new CollabBridge(store, doc)
    expect(seen.yielded).toBe(0)
    expect(typeof seen.programSink).toBe('function')
    bridge.destroy()
  })
})

describe('the scene unit system in a room (UNITS_META)', () => {
  it('seeds, reads back, and follows a local edit', () => {
    const ydoc = new Y.Doc()
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [], units: 'metric' }
    sceneToDoc(scene, ydoc)
    expect(docToScene(ydoc).units).toBe('metric')
    ydoc.transact(() => applySceneDiff(ydoc, scene, { ...scene, units: 'imperial' }), LOCAL_ORIGIN)
    expect(docToScene(ydoc).units).toBe('imperial')
    ydoc.transact(() => applySceneDiff(ydoc, { ...scene, units: 'imperial' }, { version: SCENE_VERSION, parts: [] }), LOCAL_ORIGIN)
    expect('units' in docToScene(ydoc)).toBe(false)
  })

  it('carries the Length beside it', () => {
    const ydoc = new Y.Doc()
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [], units: 'imperial', lengthUnit: 'mm' }
    sceneToDoc(scene, ydoc)
    expect(docToScene(ydoc)).toMatchObject({ units: 'imperial', lengthUnit: 'mm' })
    ydoc.transact(() => applySceneDiff(ydoc, scene, { ...scene, lengthUnit: 'in' }), LOCAL_ORIGIN)
    expect(docToScene(ydoc).lengthUnit).toBe('in')
    ydoc.transact(() => applySceneDiff(ydoc, { ...scene, lengthUnit: 'in' }, { ...scene, lengthUnit: undefined }), LOCAL_ORIGIN)
    expect('lengthUnit' in docToScene(ydoc)).toBe(false)
  })

  it("reads a room holding 'metric-mm' as metric in mm, and a Length cleared there stays cleared", () => {
    const ydoc = new Y.Doc()
    metaMap(ydoc).set('units', 'metric-mm')
    const read = docToScene(ydoc)
    expect(read).toMatchObject({ units: 'metric', lengthUnit: 'mm' })
    const cleared: SceneJSON = { ...read, lengthUnit: undefined }
    ydoc.transact(() => applySceneDiff(ydoc, read, cleared), LOCAL_ORIGIN)
    expect(docToScene(ydoc).units).toBe('metric')
    expect('lengthUnit' in docToScene(ydoc)).toBe(false)
  })
})

describe("the scene's controllers in a room (PLCS_META)", () => {
  it('seeds, reads back, follows a local edit, and refuses what is not a controller list', () => {
    const ydoc = new Y.Doc()
    const plcs = [
      { name: 'PLC1', runsOn: 'app' as const, protocol: 'serve' as const, connect: true },
      { name: 'Cell2', runsOn: 'plc' as const, protocol: 's7' as const, connect: true },
    ]
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [], plcs }
    sceneToDoc(scene, ydoc)
    expect(docToScene(ydoc).plcs).toEqual(plcs)
    const renamed = [plcs[0]!, { ...plcs[1]!, name: 'Packing' }]
    ydoc.transact(() => applySceneDiff(ydoc, scene, { ...scene, plcs: renamed }), LOCAL_ORIGIN)
    expect(docToScene(ydoc).plcs?.map((p) => p.name)).toEqual(['PLC1', 'Packing'])
    // a peer's malformed value reads as no list, never as code or a half list
    ydoc.getMap('meta').set('plcs', '{not json')
    expect('plcs' in docToScene(ydoc)).toBe(false)
  })
})

describe("the scene's display list in a room (DISPLAY_META)", () => {
  it('seeds, reads back, follows a local edit, and refuses what is not a list of names', () => {
    const ydoc = new Y.Doc()
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [], display: ['%IX100.0', 'Speed'] }
    sceneToDoc(scene, ydoc)
    expect(docToScene(ydoc).display).toEqual(['%IX100.0', 'Speed'])
    ydoc.transact(() => applySceneDiff(ydoc, scene, { ...scene, display: ['Speed'] }), LOCAL_ORIGIN)
    expect(docToScene(ydoc).display).toEqual(['Speed'])
    // emptied, the key goes: a display then shows the scene alone
    ydoc.transact(() => applySceneDiff(ydoc, { ...scene, display: ['Speed'] }, { version: SCENE_VERSION, parts: [] }), LOCAL_ORIGIN)
    expect(ydoc.getMap('meta').has('display')).toBe(false)
    ydoc.getMap('meta').set('display', '{not json')
    expect('display' in docToScene(ydoc)).toBe(false)
  })
})

describe('the room gets every definition the scene uses', () => {
  afterEach(() => clearPackages())

  it('a spawner product nothing places still reaches the room', () => {
    // the safety net for parts this client brought (bridge.syncReferencedPackages): a product named only in a
    // spawner's params is needed by whoever presses Play, so it travels like the spawner
    const pkgOf = (id: string, params: PartPackage['params'] = {}): PartPackage => ({
      format: PACKAGE_FORMAT,
      id,
      name: id,
      params,
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'rig', links: [{ name: 'base', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, 0, 0] }], joints: [], bounds: { length: 1, width: 1, top: 0.1, bottom: 0 } },
    }) as PartPackage
    const spawner = pkgOf('room.spawner', { product: { type: 'string', default: 'room.crate', product: true } } as unknown as PartPackage['params'])
    registerPackage(spawner)
    registerPackage(pkgOf('room.crate'))
    const empty: SceneJSON = { version: SCENE_VERSION, parts: [] }
    const doc = seededDoc(empty)
    const fake = fakeStore(empty)
    const bridge = new CollabBridge(fake.store, doc)
    fake.commit({ version: SCENE_VERSION, parts: [createSdkPart(spawner, 'sp_1', [0, 0, 0], 0)] })
    expect([...packagesMap(doc).keys()].sort()).toEqual(['room.crate', 'room.spawner'])
    bridge.destroy()
  })
})
