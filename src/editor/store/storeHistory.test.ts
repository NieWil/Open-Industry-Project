import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'
import { EditorStore } from './store'
import { getPackage, registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// The edit-history feed behind the History dock (getEditHistory / jumpToHistory): a
// label+time projection of the snapshot undo stacks - see EditEvent in storeHistory.ts.

function pkg(id: string, behavior: string): PartPackage {
  return { format: PACKAGE_FORMAT, id, name: id, params: {}, behavior, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }
}

function part(id: string, x = 0): PartInstance {
  return {
    id,
    type: 'part',
    packageId: 'test.belt',
    position: [x, 0.75, 0],
    rotationY: 0,
    params: { length: 3 },
  } as unknown as PartInstance
}

function scene(...parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts }
}

/** the current scene with one part moved to x (the canonical "an edit" fixture) */
function moved(store: EditorStore, id: string, x: number): SceneJSON {
  const s = store.getState().scene
  return {
    ...s,
    parts: s.parts.map((p) => (p.id === id ? { ...p, position: [x, 0.75, 0] as [number, number, number] } : p)),
  }
}

function partX(store: EditorStore, id: string): number {
  return store.getState().scene.parts.find((p) => p.id === id)!.position[0]
}

afterEach(() => {
  vi.useRealTimers()
})

describe('EditorStore edit-history feed (History dock)', () => {
  it('projects commits oldest → newest with the cursor tracking undo/redo', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    store.commit('Move part', moved(store, 'rc_1', 1))
    store.commit('Move part again', moved(store, 'rc_1', 2))

    let h = store.getEditHistory()
    expect(h.events.map((e) => e.label)).toEqual(['Move part', 'Move part again'])
    expect(h.cursor).toBe(2)

    store.undo()
    h = store.getEditHistory()
    expect(h.events).toHaveLength(2) // an undone event stays listed (greyed) - it's redoable
    expect(h.cursor).toBe(1)

    store.redo()
    expect(store.getEditHistory().cursor).toBe(2)
  })

  it('a coalesced drag stays one event, updated in place', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    store.commit('Move part', moved(store, 'rc_1', 1), { coalesceKey: 'move:rc_1' })
    vi.setSystemTime(1_100)
    store.commit('Move part', moved(store, 'rc_1', 2), { coalesceKey: 'move:rc_1' })

    const h = store.getEditHistory()
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.time).toBe(1_100) // the row reflects the latest coalesced edit
  })

  it('returns a referentially stable snapshot until a stack actually changes', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    store.commit('Move part', moved(store, 'rc_1', 1))
    const a = store.getEditHistory()
    store.select('rc_1') // unrelated state change must not produce a new snapshot
    expect(store.getEditHistory()).toBe(a)
    store.commit('Move part again', moved(store, 'rc_1', 2))
    expect(store.getEditHistory()).not.toBe(a)
  })

  it('jumpToHistory walks undo/redo to the clicked position', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1', 0)))
    store.commit('Move 1', moved(store, 'rc_1', 1))
    store.commit('Move 2', moved(store, 'rc_1', 2))
    store.commit('Move 3', moved(store, 'rc_1', 3))

    store.jumpToHistory(1)
    expect(partX(store, 'rc_1')).toBe(1)
    expect(store.getEditHistory().cursor).toBe(1)

    store.jumpToHistory(3)
    expect(partX(store, 'rc_1')).toBe(3)

    store.jumpToHistory(0) // the "Project opened" row: undo everything
    expect(partX(store, 'rc_1')).toBe(0)
    expect(store.getEditHistory().events).toHaveLength(3) // all three still redoable
  })

  it('mixes package (part-definition) edits into the same feed and jump path', () => {
    registerPackage(pkg('test.pkg', 'A'))
    try {
      const store = new EditorStore()
      store.loadScene(scene(part('rc_1')))
      store.commit('Move part', moved(store, 'rc_1', 1))
      store.commitPackage('Edit part', pkg('test.pkg', 'B'))

      const h = store.getEditHistory()
      expect(h.events.map((e) => e.kind)).toEqual(['scene', 'package'])
      expect(getPackage('test.pkg')!.behavior).toBe('B')

      store.jumpToHistory(0) // replays both kinds through the normal undo path
      expect(partX(store, 'rc_1')).toBe(0)
      expect(getPackage('test.pkg')!.behavior).toBe('A')
    } finally {
      unregisterPackage('test.pkg')
    }
  })

  it('is empty (and jump is a no-op) in a shared room until the bridge syncs a feed', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    store.commit('Move part', moved(store, 'rc_1', 1))
    store.setCollabMode(true)
    const h = store.getEditHistory()
    expect(h.events).toHaveLength(0)
    expect(h.cursor).toBe(0)
    store.jumpToHistory(0) // must not throw or walk anything
    expect(store.getEditHistory()).toBe(h) // stable shared empty snapshot
  })

  it('serves the room feed in collab mode and drops it on leaving', () => {
    const store = new EditorStore()
    store.loadScene(scene(part('rc_1')))
    store.commit('Solo edit', moved(store, 'rc_1', 1))
    store.setCollabMode(true)

    let notified = 0
    store.subscribe(() => notified++)
    store.applyRemoteEditFeed([{ label: 'Move belt', time: 5, kind: 'scene', actor: 'Alice', mine: false }])
    expect(notified).toBe(1) // the panel re-renders on a feed change
    const h = store.getEditHistory()
    expect(h.events.map((e) => e.actor)).toEqual(['Alice'])
    expect(h.cursor).toBe(1) // past the newest event - a feed has no redo tail

    store.setCollabMode(false)
    expect(store.getEditHistory().events).toHaveLength(0) // the room feed doesn't leak into solo

    // and the solo projection is back: the pre-room stacks were cleared on entering, so empty is correct
    expect(store.getEditHistory().cursor).toBe(0)
  })
})
