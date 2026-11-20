import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createPart } from '../core/scene/scene'
import type { PartPackage } from '../core/parts/partPackage'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import { claimRoomBuild, docToScene, orderArray, partsMap, readStDoc } from './schema'
import { seedIfEmpty } from './provider'
import { DEMO_SEED_META, demoFingerprint, isDemoRoom, roomFingerprint, syncDemoRoom } from './demoRoom'
import type { DemoSeed } from './demoRoom'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

function pkg(id: string): PartPackage {
  return { format: PACKAGE_FORMAT, id, name: id, params: {}, behavior: 'definePart({ step(){} })', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.05, bottom: -0.1 } } }
}

/** two versions of "the demo", as two builds would make it: different program, parts and packages */
function demo(version: 1 | 2): DemoSeed {
  const parts = [createPart('building', 'bld_1', [0, 0, 0]), createPart('group', 'grp_1', [1, 0, 0])]
  if (version === 2) parts.push(createPart('group', 'grp_2', [4, 0, 2]))
  return {
    scene: { version: SCENE_VERSION, parts, packages: version === 1 ? [pkg('b.one'), pkg('a.two')] : [pkg('b.one'), pkg('c.three')] },
    stProgram: `Motor := Start; (* demo v${version} *)`,
    stScanMs: 10,
    controller: null,
    simHz: DEFAULT_SIM_HZ,
  }
}

const synced = { minted: false, serverSynced: true, build: 100 }

/** a room the v1 demo was shared into */
function v1Room(): Y.Doc {
  const doc = new Y.Doc()
  expect(syncDemoRoom(doc, demo(1), { ...synced, minted: true })).toBe('seeded')
  return doc
}

/** a new client's copy of `room`, as the server hands it over */
function join(room: Y.Doc): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room))
  return doc
}

function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

function expectHolds(doc: Y.Doc, seed: DemoSeed): void {
  const scene = docToScene(doc)
  expect(scene.parts.map((p) => p.id)).toEqual(seed.scene.parts.map((p) => p.id))
  expect((scene.packages ?? []).map((p) => p.id).sort()).toEqual((seed.scene.packages ?? []).map((p) => p.id).sort())
  expect(readStDoc(doc).source).toBe(seed.stProgram)
  expect(orderArray(doc).length).toBe(seed.scene.parts.length)
  // and it knows it holds exactly that, untouched
  expect(doc.getMap('meta').get(DEMO_SEED_META)).toBe(demoFingerprint(seed))
  expect(roomFingerprint(doc)).toBe(demoFingerprint(seed))
}

describe('demo rooms', () => {
  it('a room minted from the demo holds the demo and says so', () => {
    const room = v1Room()
    expect(isDemoRoom(room)).toBe(true)
    expectHolds(room, demo(1))
  })

  it('leaves a room holding this build’s demo alone, and writes nothing', () => {
    const room = v1Room()
    const peer = join(room)
    let writes = 0
    peer.on('update', () => writes++)
    expect(syncDemoRoom(peer, demo(1), synced)).toBe('current')
    expect(writes).toBe(0)
  })

  it('brings an untouched room up to a newer build’s demo', () => {
    const peer = join(v1Room())
    expect(syncDemoRoom(peer, demo(2), synced)).toBe('refreshed')
    expectHolds(peer, demo(2))
    // and is current from then on, for it and for anyone after it
    expect(syncDemoRoom(peer, demo(2), synced)).toBe('current')
    expect(syncDemoRoom(join(peer), demo(2), synced)).toBe('current')
  })

  it('reaches a client already in the room as an ordinary update', () => {
    const room = v1Room()
    const inRoom = join(room)
    const newer = join(room)
    syncDemoRoom(newer, demo(2), synced)
    exchange(newer, inRoom)
    expectHolds(inRoom, demo(2))
  })

  it('never replaces a room someone has edited: it is theirs now', () => {
    const room = v1Room()
    const editor = join(room)
    partsMap(editor).get('grp_1')!.set('px', 7)
    exchange(editor, room)
    const newer = join(room)
    expect(syncDemoRoom(newer, demo(2), synced)).toBe('edited')
    expect(readStDoc(newer).source).toBe(demo(1).stProgram)
    expect(partsMap(newer).get('grp_1')!.get('px')).toBe(7)
  })

  it('counts a program edit as an edit too', () => {
    const room = join(v1Room())
    room.getText('stProgram').insert(0, '(* mine *) ')
    expect(syncDemoRoom(room, demo(2), synced)).toBe('edited')
  })

  it('two people refreshing the same stale room at once leave one demo, not two merged', () => {
    const room = v1Room()
    const a = join(room)
    const b = join(room)
    expect(syncDemoRoom(a, demo(2), synced)).toBe('refreshed')
    expect(syncDemoRoom(b, demo(2), synced)).toBe('refreshed')
    exchange(a, b)
    exchange(a, room)
    for (const doc of [a, b, room]) expectHolds(doc, demo(2))
  })

  it('a refresh that lands after one already did is recognised as the same write', () => {
    const room = v1Room()
    const a = join(room)
    const b = join(room)
    syncDemoRoom(a, demo(2), synced)
    exchange(a, room)
    // b refreshed from the stale base too, but only hears of a's write afterwards
    syncDemoRoom(b, demo(2), synced)
    exchange(b, room)
    expectHolds(room, demo(2))
  })

  it('keeps a newer build’s demo from an older build', () => {
    const room = join(v1Room())
    claimRoomBuild(room, 200)
    expect(syncDemoRoom(room, demo(2), { ...synced, build: 100 })).toBe('newer-build')
    expect(syncDemoRoom(room, demo(2), { ...synced, build: undefined })).toBe('newer-build')
    expect(syncDemoRoom(room, demo(2), { ...synced, build: 200 })).toBe('refreshed')
  })

  it('refreshes nothing from an offline cache, which may predate an edit', () => {
    const room = join(v1Room())
    expect(syncDemoRoom(room, demo(2), { ...synced, serverSynced: false })).toBe('offline')
    expect(readStDoc(room).source).toBe(demo(1).stProgram)
  })

  it('does not touch a room shared from a document', () => {
    const room = new Y.Doc()
    seedIfEmpty(room, demo(1).scene, 'Mine := TRUE;')
    expect(syncDemoRoom(room, demo(2), synced)).toBe('not-demo')
    // nor does a minting tab that finds the room already filled
    expect(syncDemoRoom(room, demo(2), { ...synced, minted: true })).toBe('not-demo')
    expect(readStDoc(room).source).toBe('Mine := TRUE;')
  })

  it('an edit undone back to the demo is untouched again', () => {
    const room = join(v1Room())
    partsMap(room).get('grp_1')!.set('px', 7)
    partsMap(room).get('grp_1')!.set('px', 1)
    expect(syncDemoRoom(room, demo(2), synced)).toBe('refreshed')
  })
})
