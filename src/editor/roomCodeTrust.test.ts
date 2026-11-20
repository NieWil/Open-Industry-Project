import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createPart } from '../core/scene/scene'
import { clearPackages, getPackage, listPackages } from '../core/parts/partRegistry'
import { instantiatePartScript } from '../core/parts/partScript'
import type { PartPackage } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import type { SceneJSON, SdkPart } from '../core/types'
import { CollabBridge } from '../collab/bridge'
import { INERT_BEHAVIOR, PackageGate } from '../collab/codeTrust'
import type { FirstPartyCode } from '../collab/codeTrust'
import { docToScene, makePartMap, orderArray, packagesMap, partsMap, readPackages, sceneToDoc, writePackage } from '../collab/schema'
import { setRoomCodeGate } from '../collab/session'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledPartById } from './parts/bundledExamples'
import { createPlcDemoScene } from './demo/demoScenes'
import { downloadProject } from './project/projectFile'
import { oipBytesToProject } from '../core/project/projectArchive'
import { bakePart } from './parts/bakePart'
import type { ProjectJSON } from '../core/project/project'
import { EditorStore } from './store/store'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

// The room's code trust gate (collab/codeTrust.ts) from a joining client's side. The part registry is
// process-global, so the peer here is raw doc writes, not a second store: the store under test is the only
// client in this process, which is also the threat model (someone else's bytes arriving over the wire).
//
// @unlocked-realm: this file runs without lockdown (vite.config.ts `unit-unlocked`). It tests the gate as the last
// line of defence where the sandbox is absent - a CLI host, or a browser where lockdown() failed - and its payload
// proves code ran by escaping, which the sandbox (core/parts/partSandbox.test.ts) is there to stop.

/** a real escape from the part guards (SECURITY.md): reaches the host's globalThis from a part's top level */
const PAYLOAD = "(() => {}).constructor('return this')().__oipRoomPwned = true\ndefinePart({ step() {} })\n"
const pwned = (): boolean => (globalThis as { __oipRoomPwned?: boolean }).__oipRoomPwned === true

function peerPackage(id: string, behavior: string): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Peer Part',
    params: { length: { type: 'number', default: 2 } },
    behavior,
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }], joints: [] },
  }
}

/** what this app ships, exactly as the room boot builds it (main.tsx bootRoom) */
function shippedCode(): FirstPartyCode {
  const shipped = bundledBehaviors()
  const code = new Set(shipped.values())
  return { isFirstParty: (src) => code.has(src), sourceFor: (id) => shipped.get(id) }
}

/** join a room as the store under test: the boot's gated first paint, then the bridge */
function join(doc: Y.Doc, gate: PackageGate, readOnly = false): EditorStore {
  const store = new EditorStore()
  store.setCollabMode(true)
  if (readOnly) store.setReadOnly(true)
  store.applyRemotePackages(gate.review(readPackages(doc)))
  store.applyRemote(gate.admitScene(docToScene(doc)))
  new CollabBridge(store, doc, undefined, readOnly, () => 'Me', gate)
  return store
}

/** the peer adds a package and places one part of it, in one transaction, as a remote client would */
function peerPlaces(doc: Y.Doc, pkg: PartPackage, partId: string): void {
  const part = { ...createPart('group', partId, [1, 0, 0]), type: 'part', packageId: pkg.id, params: {} } as unknown as SdkPart
  doc.transact(() => {
    writePackage(packagesMap(doc), pkg)
    partsMap(doc).set(partId, makePartMap(part))
    orderArray(doc).push([partId])
  }, 'remote')
}

/** every package source the store can reach: the registry, the scene's embedded copies, the catalog */
function reachableCode(store: EditorStore): string[] {
  const s = store.getState()
  return [...listPackages(), ...(s.scene.packages ?? []), ...s.userPackages].map((p) => p.behavior)
}

afterEach(() => {
  clearPackages()
  setRoomCodeGate(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as { __oipRoomPwned?: boolean }).__oipRoomPwned
})

describe("joining a room holds other people's part code until the room is allowed", () => {
  it('the payload is a real escape (the teeth: if the guards stopped it, this suite would prove nothing)', () => {
    expect(instantiatePartScript(PAYLOAD).error).toBe('')
    expect(pwned()).toBe(true)
  })

  for (const readOnly of [false, true]) {
    it(`a peer's code never reaches anything that runs, and allowing the room runs it (${readOnly ? 'view-only' : 'editor'})`, () => {
      const doc = new Y.Doc()
      sceneToDoc({ version: SCENE_VERSION, parts: [createPart('building', 'bld_1', [0, 0, 0])] }, doc)
      const evil = peerPackage('peer.part', PAYLOAD)
      peerPlaces(doc, evil, 'pp_1') // in the room BEFORE we join
      const gate = new PackageGate(shippedCode())
      const store = join(doc, gate, readOnly)

      // held: the part resolves (params, rig) but every copy of its code the store holds is the inert stand-in
      expect(store.getState().scene.parts.some((p) => p.id === 'pp_1')).toBe(true)
      expect(getPackage('peer.part')!.behavior).toBe(INERT_BEHAVIOR)
      expect(getPackage('peer.part')!.params).toEqual(evil.params)
      expect(reachableCode(store)).not.toContain(PAYLOAD)
      expect(gate.getHeld()).toEqual([{ id: 'peer.part', name: 'Peer Part', runs: 'nothing' }])

      // a live edit arriving later is held the same way
      doc.transact(() => writePackage(packagesMap(doc), { ...evil, behavior: PAYLOAD + '// v2\n' }), 'remote')
      expect(reachableCode(store).some((src) => src.includes('__oipRoomPwned'))).toBe(false)

      // run everything the store holds through the real compile seam: nothing escapes
      for (const src of reachableCode(store)) instantiatePartScript(src)
      expect(pwned()).toBe(false)

      // the user allows the room: the real code goes into the registry and the scene's embedded copies
      gate.trustRoom()
      expect(getPackage('peer.part')!.behavior).toBe(PAYLOAD + '// v2\n')
      expect(store.getState().scene.packages!.find((p) => p.id === 'peer.part')!.behavior).toBe(PAYLOAD + '// v2\n')
      expect(gate.getHeld()).toEqual([])
      instantiatePartScript(getPackage('peer.part')!.behavior)
      expect(pwned()).toBe(true)
    })
  }

  it("a data edit made here to a held part never overwrites its author's code in the room", () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [] }, doc)
    peerPlaces(doc, peerPackage('peer.part', PAYLOAD), 'pp_1')
    const store = join(doc, new PackageGate(shippedCode()))

    store.commitPackage('Rename', { ...getPackage('peer.part')!, name: 'Renamed' })
    const inRoom = readPackages(doc).find((p) => p.id === 'peer.part')!
    expect(inRoom.name).toBe('Renamed') // the edit went out...
    expect(inRoom.behavior).toBe(PAYLOAD) // ...without the stand-in riding along
    expect(getPackage('peer.part')!.behavior).toBe(INERT_BEHAVIOR) // and still doesn't run here
  })

  it('a built-in whose code a peer changed runs the version this app ships', () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [] }, doc)
    const shipped = bundledBehaviors().get('oip.box')!
    peerPlaces(doc, { ...peerPackage('oip.box', 'definePart({ step() {} /* not ours */ })'), name: 'Box' }, 'bx_1')
    const gate = new PackageGate(shippedCode())
    join(doc, gate)
    expect(getPackage('oip.box')!.behavior).toBe(shipped)
    expect(gate.getHeld()).toEqual([{ id: 'oip.box', name: 'Box', runs: 'built-in' }])
  })

  it("code this client wrote into the room is its own: it isn't held when it comes back", () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [] }, doc)
    const gate = new PackageGate(shippedCode())
    const store = join(doc, gate)
    const mine = peerPackage('me.part', 'definePart({ step() {} /* mine */ })')
    store.addUserPackage(mine)
    expect(readPackages(doc).find((p) => p.id === 'me.part')!.behavior).toBe(mine.behavior)
    // an unrelated peer package change makes the bridge re-read every package, ours included
    doc.transact(() => writePackage(packagesMap(doc), peerPackage('peer.part', 'definePart({ step() {} })')), 'remote')
    expect(gate.isHeld('me.part')).toBe(false)
    expect(getPackage('me.part')!.behavior).toBe(mine.behavior)
  })

  it("only code this client authored counts as its own; a data edit to a peer's part does not", () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [] }, doc)
    peerPlaces(doc, peerPackage('peer.part', PAYLOAD), 'pp_1')
    const remembered: string[] = []
    const store = join(doc, new PackageGate(shippedCode(), true, (src) => remembered.push(src)))
    store.commitPackage('Rename', { ...getPackage('peer.part')!, name: 'Renamed' }) // the room is allowed: real code
    expect(remembered).toEqual([]) // the peer's script went back out, but it is still the peer's
    const mine = peerPackage('me.part', 'definePart({ step() {} /* mine */ })')
    store.addUserPackage(mine)
    store.commitPackage('Edit behavior', { ...getPackage('peer.part')!, behavior: 'definePart({ step() {} /* my rewrite */ })' })
    expect(remembered).toEqual([mine.behavior, 'definePart({ step() {} /* my rewrite */ })'])
  })

  it('a room already allowed in this browser holds nothing', () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [] }, doc)
    peerPlaces(doc, peerPackage('peer.part', PAYLOAD), 'pp_1')
    const gate = new PackageGate(shippedCode(), true)
    join(doc, gate)
    expect(getPackage('peer.part')!.behavior).toBe(PAYLOAD)
    expect(gate.getHeld()).toEqual([])
  })

  it('the bridge writes nothing for a held package when a part placed from it lost its package in the room', () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [] }, doc)
    peerPlaces(doc, peerPackage('peer.part', PAYLOAD), 'pp_1')
    const store = join(doc, new PackageGate(shippedCode()))
    // the peer deletes the package (an undo of its creation) while the part stays
    doc.transact(() => packagesMap(doc).delete('peer.part'), 'remote')
    // an unrelated local commit runs the safety net that re-writes packages the room is missing
    store.commit('Add', { ...store.getState().scene, parts: [...store.getState().scene.parts, createPart('group', 'g_1', [0, 0, 0])] })
    // the safety net restores the package, and with the author's code, never our stand-in
    expect(readPackages(doc).find((p) => p.id === 'peer.part')?.behavior).toBe(PAYLOAD)
    expect(getPackage('peer.part')!.behavior).toBe(INERT_BEHAVIOR)
  })
})

describe("what this app ships is recognised as its own (else every room would hold the built-ins)", () => {
  it("bundledBehaviors is each built package's behavior, byte for byte", () => {
    for (const [id, src] of bundledBehaviors()) {
      const data = bundledPartById(id)!
      expect(buildPackage(data.manifest, data.behavior).behavior, id).toBe(src)
    }
  })

  it('the demo scene, shared into a room, holds nothing', () => {
    const scene: SceneJSON = createPlcDemoScene()
    const gate = new PackageGate(shippedCode())
    const pkgs = scene.packages ?? []
    expect(pkgs.length).toBeGreaterThan(5)
    gate.review(pkgs)
    expect(gate.getHeld()).toEqual([])
  })
})

describe('a file exported while the room is holding code back says so', () => {
  /** Export Project (.oip) through the real browser seam, read back: the export a room offers (there is no separate
   *  scene export since format 4) */
  async function exported(store: EditorStore): Promise<{ text: string; project: ProjectJSON }> {
    let captured: Uint8Array = new Uint8Array()
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts: Uint8Array[]) {
          captured = parts[0]!
        }
      },
    )
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    vi.stubGlobal('document', { createElement: () => ({ click: () => {}, href: '', download: '' }) })
    await downloadProject(store)
    const read = await oipBytesToProject(captured, { bakePart })
    if (!read.ok) throw new Error(read.errors.join('; '))
    return { text: JSON.stringify(read.project), project: read.project }
  }

  it("carries the stand-in, which explains itself, and tells the person exporting", async () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [createPart('building', 'bld_1', [0, 0, 0])] }, doc)
    peerPlaces(doc, peerPackage('peer.part', PAYLOAD), 'pp_1')
    const gate = new PackageGate(shippedCode())
    const store = join(doc, gate)
    setRoomCodeGate(gate) // the room boot publishes it; the export path reads it back

    const { text, project } = await exported(store)
    const saved = project.packages!.find((p) => p.id === 'peer.part')!
    expect(text).not.toContain('__oipRoomPwned') // the author's code never reaches the file...
    expect(saved.behavior).toBe(INERT_BEHAVIOR)
    expect(saved.behavior).toContain('not included here') // ...and the file is not silent about why
    expect(store.getState().saveNotice).toMatchObject({ title: 'Saved without some part code' })
    expect(store.getState().saveNotice!.message).toContain('Peer Part')
  })

  it('says nothing once the room is allowed, and then the file carries the real code', async () => {
    const doc = new Y.Doc()
    sceneToDoc({ version: SCENE_VERSION, parts: [createPart('building', 'bld_1', [0, 0, 0])] }, doc)
    peerPlaces(doc, peerPackage('peer.part', PAYLOAD), 'pp_1')
    const gate = new PackageGate(shippedCode())
    const store = join(doc, gate)
    setRoomCodeGate(gate)
    gate.trustRoom()

    const { project } = await exported(store)
    expect(project.packages!.find((p) => p.id === 'peer.part')!.behavior).toBe(PAYLOAD)
    expect(store.getState().saveNotice).toBeNull() // nothing was left out, so nothing to say
  })
})
