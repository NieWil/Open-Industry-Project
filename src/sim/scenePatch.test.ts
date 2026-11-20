import { describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON } from '../core/types'
import type { PartPackage } from '../core/parts/partPackage'
import { applyScenePatch, scenePatch } from './scenePatch'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

function part(id: string, x = 0): PartInstance {
  return { id, type: 'part', packageId: 'test.deck', position: [x, 0, 0], rotationY: 0, params: {} } as unknown as PartInstance
}

function pkg(id: string): PartPackage {
  return { format: PACKAGE_FORMAT, id, name: id, params: {}, behavior: '', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }
}

function scene(parts: PartInstance[], packages?: PartPackage[]): SceneJSON {
  return packages ? { version: SCENE_VERSION, parts, packages } : { version: SCENE_VERSION, parts }
}

describe('scenePatch', () => {
  it('carries only the parts whose object changed, and no packages when the set is the same objects', () => {
    const a = part('a')
    const b = part('b')
    const c = part('c')
    const p = pkg('test.deck')
    const prev = scene([a, b, c], [p])
    const moved = part('b', 2)
    // a fresh packages array holding the same package objects is what forSim mints on every push
    const next = scene([a, moved, c], [p])
    const patch = scenePatch(prev, next)!
    expect(patch.changes).toEqual([[1, moved]])
    expect(patch.packages).toBeUndefined()
    const rebuilt = applyScenePatch(prev, patch)
    expect(rebuilt.parts).toEqual([a, moved, c])
    expect(rebuilt.parts[0]).toBe(a) // untouched parts keep their identity: the worker's signature memo keys on it
    expect(rebuilt.packages).toEqual([p])
  })

  it('carries the packages when one of them is a different object', () => {
    const a = part('a')
    const prev = scene([a], [pkg('test.deck')])
    const fresh = pkg('test.deck')
    const patch = scenePatch(prev, scene([a], [fresh]))!
    expect(patch.changes).toEqual([])
    expect(patch.packages).toEqual([fresh])
    expect(applyScenePatch(prev, patch).packages![0]).toBe(fresh)
  })

  it('refuses an add, a delete or a reorder: those send the whole scene', () => {
    const a = part('a')
    const b = part('b')
    expect(scenePatch(scene([a]), scene([a, b]))).toBeNull()
    expect(scenePatch(scene([a, b]), scene([a]))).toBeNull()
    expect(scenePatch(scene([a, b]), scene([b, a]))).toBeNull()
  })

  it('treats an absent and an empty package list as the same', () => {
    const a = part('a')
    expect(scenePatch(scene([a]), scene([a], []))!.packages).toBeUndefined()
  })
})
