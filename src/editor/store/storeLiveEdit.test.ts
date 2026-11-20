import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'
import { EditorStore } from './store'

// A live edit (beginLiveEdit / endLiveEdit): an Inspector scrub's per-step commits go through the transient stream
// and end up as one undo step, with the React render and the pool re-bake deferred to the release.

function part(id: string, length = 3): PartInstance {
  return { id, type: 'part', packageId: 'test.belt', position: [0, 0.75, 0], rotationY: 0, params: { length } } as unknown as PartInstance
}

function withLength(store: EditorStore, id: string, length: number): SceneJSON {
  const s = store.getState().scene
  return { ...s, parts: s.parts.map((p) => (p.id === id ? ({ ...p, params: { length } } as unknown as PartInstance) : p)) }
}

function lengthOf(store: EditorStore, id: string): number {
  return (store.getState().scene.parts.find((p) => p.id === id)!.params as { length: number }).length
}

function scrub(store: EditorStore, id: string, lengths: number[]): void {
  for (const l of lengths) store.commit('Set length', withLength(store, id, l), { coalesceKey: `param:${id}:length` })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('EditorStore live edit', () => {
  it('streams steps to the view only, then renders React once at the release', () => {
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [part('a'), part('b')] })
    let react = 0
    let view = 0
    store.subscribe(() => react++)
    store.subscribeView(() => view++)

    store.beginLiveEdit()
    scrub(store, 'a', [4, 5, 6])
    expect(react).toBe(0)
    expect(view).toBe(3)
    expect(lengthOf(store, 'a')).toBe(6)
    expect(store.liveEditIds()).toEqual(['a'])
    expect(store.persistPending).toBe(true)

    store.endLiveEdit()
    expect(react).toBe(1)
    expect(store.liveEditIds()).toBeNull()
  })

  it('is one undo step however long the hand pauses mid-gesture', () => {
    vi.useFakeTimers()
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [part('a')] })
    store.beginLiveEdit()
    scrub(store, 'a', [4])
    vi.advanceTimersByTime(5000) // well past COALESCE_MS
    scrub(store, 'a', [5, 6])
    store.endLiveEdit()

    store.undo()
    expect(lengthOf(store, 'a')).toBe(3)
    expect(store.canUndo).toBe(false)
  })

  it('an undo inside the gesture is a boundary the later steps do not fold into', () => {
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [part('a')] })
    store.beginLiveEdit()
    scrub(store, 'a', [4, 5])
    store.undo()
    expect(lengthOf(store, 'a')).toBe(3)
    scrub(store, 'a', [7])
    store.endLiveEdit()
    expect(lengthOf(store, 'a')).toBe(7)
    store.undo()
    expect(lengthOf(store, 'a')).toBe(3)
  })

  it('a gesture that never wrote ends silently', () => {
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [part('a')] })
    let react = 0
    store.subscribe(() => react++)
    store.beginLiveEdit()
    store.endLiveEdit()
    expect(react).toBe(0)
    expect(store.persistPending).toBe(false)
  })

  it('outside a live edit a commit still renders React per step', () => {
    const store = new EditorStore()
    store.loadScene({ version: SCENE_VERSION, parts: [part('a')] })
    let react = 0
    store.subscribe(() => react++)
    scrub(store, 'a', [4, 5])
    expect(react).toBe(2)
    expect(store.liveEditIds()).toBeNull()
  })
})
