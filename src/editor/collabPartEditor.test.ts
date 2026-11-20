import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createPart, createSdkPart, serializeScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON } from '../core/types'
import { CollabBridge } from '../collab/bridge'
import { docToScene, editedPackageIds, packagesMap, sceneToDoc } from '../collab/schema'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PartPackage } from '../core/parts/partPackage'
import { getPackage, registerPackage } from '../core/parts/partRegistry'
import { EditorStore } from './store/store'

/** the Part Editor and deleting parts in a shared project: two stores joined by two relayed Y.Docs, as two tabs */

function line(): SceneJSON {
  return { version: SCENE_VERSION, parts: [createPart('building', 'bld_1', [0, 0, 0]), createPart('group', 'bc_1', [2, 0.75, 0])] }
}

function part(id: string, behavior = 'definePart({ step() {} })'): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Lifter',
    params: {},
    behavior,
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }], joints: [] },
  }
}

function room(): { a: EditorStore; b: EditorStore; docA: Y.Doc; docB: Y.Doc } {
  const docA = new Y.Doc()
  sceneToDoc(line(), docA)
  const docB = new Y.Doc()
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
  const join = (doc: Y.Doc): EditorStore => {
    const s = new EditorStore()
    s.setCollabMode(true)
    s.applyRemote(docToScene(doc))
    return s
  }
  const a = join(docA)
  const b = join(docB)
  docA.on('update', (u: Uint8Array) => Y.applyUpdate(docB, u, 'remote'))
  docB.on('update', (u: Uint8Array) => Y.applyUpdate(docA, u, 'remote'))
  new CollabBridge(a, docA)
  new CollabBridge(b, docB)
  return { a, b, docA, docB }
}

const ids = (scene: SceneJSON): string[] => scene.parts.map((p) => p.id).sort()
const move = (s: EditorStore, id: string, x: number): void => {
  const scene = s.getState().scene
  s.commit('Move', { ...scene, parts: scene.parts.map((p): PartInstance => (p.id === id ? { ...p, position: [x, 0.75, 0] } : p)) })
}

describe('the Part Editor in a shared project', () => {
  it("opens without touching the room's line, and a part edit made in it reaches everyone", () => {
    const { a, b, docA } = room()
    a.addUserPackage(part('user.lifter'))
    expect(a.enterPackageEdit('user.lifter')).toBe(true)
    expect(a.getState().scene.parts).toHaveLength(1) // the editor shows the part alone
    expect(ids(docToScene(docA))).toEqual(['bc_1', 'bld_1']) // the room still holds the line
    expect(ids(b.getState().scene)).toEqual(['bc_1', 'bld_1'])
    a.commitPackage('Edit behavior', { ...part('user.lifter'), behavior: 'definePart({ step() { /* v2 */ } })' })
    expect(getPackage('user.lifter')?.behavior).toContain('v2')
    expect(packagesMap(docA).get('user.lifter')?.get('behavior')).toContain('v2')
  })

  it("puts a collaborator's edit made meanwhile into the parked line, and keeps it on Back", () => {
    const { a, b } = room()
    a.addUserPackage(part('user.lifter'))
    a.enterPackageEdit('user.lifter')
    move(b, 'bc_1', 9)
    expect(a.getState().scene.parts).toHaveLength(1) // still editing the part
    expect(a.getState().packageEdit?.document.parts.find((p) => p.id === 'bc_1')?.position[0]).toBe(9)
    a.exitPartFocus()
    expect(a.getState().scene.parts.find((p) => p.id === 'bc_1')?.position[0]).toBe(9)
    const poses = (st: EditorStore) => serializeScene({ ...st.getState().scene, packages: [] })
    expect(poses(a)).toBe(poses(b))
  })

  it("writes nothing to the room's line on Back: the throwaway never reaches it", () => {
    const { a, b, docA } = room()
    a.addUserPackage(part('user.lifter'))
    a.enterPackageEdit('user.lifter')
    a.exitPartFocus()
    expect(ids(docToScene(docA))).toEqual(['bc_1', 'bld_1'])
    expect(ids(b.getState().scene)).toEqual(['bc_1', 'bld_1'])
    move(a, 'bc_1', 4) // and the line edits normally afterwards
    expect(b.getState().scene.parts.find((p) => p.id === 'bc_1')?.position[0]).toBe(4)
  })
})

describe('deleting a part in a shared project', () => {
  it("takes it out of everyone's parts", () => {
    const { a, b, docA } = room()
    a.addUserPackage(part('user.lifter'))
    expect(b.getState().userPackages.some((p) => p.id === 'user.lifter')).toBe(true)
    expect(a.removeUserPackage('user.lifter')).toBe(true)
    expect(packagesMap(docA).has('user.lifter')).toBe(false)
    expect(b.getState().userPackages.some((p) => p.id === 'user.lifter')).toBe(false)
    expect(getPackage('user.lifter')).toBeUndefined()
  })

  it('is refused while the line places it, as solo', () => {
    const { a } = room()
    a.addUserPackage(part('user.placed'))
    const scene = a.getState().scene
    a.commit('Place', { ...scene, parts: [...scene.parts, createSdkPart(part('user.placed'), 'pt_9', [0, 0, 0])] })
    expect(a.removeUserPackage('user.placed')).toBe(false)
  })

  it('keeps a part someone placed as it was deleted, and puts it back in the room', () => {
    const { a, b, docA, docB } = room()
    a.addUserPackage(part('user.raced'))
    const scene = b.getState().scene
    b.commit('Place', { ...scene, parts: [...scene.parts, createSdkPart(part('user.raced'), 'pt_9', [0, 0, 0])] })
    // a delete that crossed with the placement: the room's entry goes, though the line now places the part
    docA.transact(() => packagesMap(docA).delete('user.raced'), 'remote')
    expect(b.getState().userPackages.some((p) => p.id === 'user.raced')).toBe(true)
    expect(packagesMap(docB).has('user.raced')).toBe(true) // sent back
    expect(editedPackageIds(docA).has('user.raced')).toBe(true)
    expect(a.getState().userPackages.some((p) => p.id === 'user.raced')).toBe(true)
  })

  it("puts a built-in's edited copy back to the app's version for everyone", () => {
    const { a, b, docA } = room()
    const builtIn = { ...part('oip.lifter'), name: 'Lifter (app)' }
    registerPackage(builtIn, true)
    a.setBundledPackages([builtIn])
    b.setBundledPackages([builtIn])
    a.commitPackage('Edit', { ...builtIn, behavior: 'definePart({ step() { /* fork */ } })' })
    expect(b.getState().userPackages.some((p) => p.id === 'oip.lifter')).toBe(true)
    expect(a.removeUserPackage('oip.lifter')).toBe(true)
    expect(editedPackageIds(docA).has('oip.lifter')).toBe(false)
    expect(b.getState().userPackages.some((p) => p.id === 'oip.lifter')).toBe(false)
    expect(getPackage('oip.lifter')?.behavior).not.toContain('fork')
  })
})
