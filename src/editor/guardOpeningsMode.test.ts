import { beforeEach, describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance } from '../core/types'
import { registerPackage } from '../core/parts/partRegistry'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from './parts/bundledExamples'
import { EditorStore, guardOpeningsTarget } from './store/store'

// Guard-openings mode (G) is a session state with a target: one selected conveyor that authors guardOpenings.
// As a persisted global flag, a G pressed yesterday would silently swap every conveyor's size handles for
// opening dots today. These pin that it cannot outlive its target and that Delete there means the opening.

const behaviors = bundledBehaviors()
const real = bundledManifests()
  .filter((m) => m.id === 'oip.roller-conveyor')
  .map((m) => buildPackage(m, behaviors.get(m.id)!))

const roller = (id: string, x: number, guardOpenings: number[][] = []): PartInstance =>
  ({ id, type: 'part', packageId: 'oip.roller-conveyor', name: id, position: [x, 1, 0], rotationY: 0, params: { length: 4, width: 1, guardOpenings } }) as unknown as PartInstance
const plain = (id: string): PartInstance =>
  ({ id, type: 'part', packageId: 'oip.none', name: id, position: [9, 0, 0], rotationY: 0, params: {} }) as unknown as PartInstance

function storeWith(parts: PartInstance[]): EditorStore {
  const store = new EditorStore()
  store.loadScene({ version: SCENE_VERSION, parts })
  return store
}
const rowsOf = (store: EditorStore, id: string) =>
  (store.getState().scene.parts.find((p) => p.id === id)!.params as { guardOpenings: number[][] }).guardOpenings

beforeEach(() => real.forEach((p) => registerPackage(p)))

describe('guard-openings mode', () => {
  it('starts off, and refuses to turn on without one guarded conveyor selected', () => {
    const store = storeWith([roller('a', 0), roller('b', 6), plain('p')])
    expect(store.getState().sideGuardMode).toBe(false)
    expect(store.toggleSideGuardMode()).toBe(false) // nothing selected
    store.select('p')
    expect(store.toggleSideGuardMode()).toBe(false) // not a conveyor
    store.selectMany(['a', 'b'])
    expect(store.toggleSideGuardMode()).toBe(false) // two
    store.select('a')
    expect(guardOpeningsTarget(store.getState())?.id).toBe('a')
    expect(store.toggleSideGuardMode()).toBe(true)
  })

  it('ends by itself when the selection leaves the conveyor, and does not come back with it', () => {
    const store = storeWith([roller('a', 0), plain('p')])
    store.select('a')
    store.setSideGuardMode(true)
    store.select('p')
    expect(store.getState().sideGuardMode).toBe(false)
    store.select('a')
    expect(store.getState().sideGuardMode).toBe(false)
    store.setSideGuardMode(true)
    store.clearSelection()
    expect(store.getState().sideGuardMode).toBe(false)
  })

  it('stays on when the selection moves to another guarded conveyor, dropping the selected opening', () => {
    const store = storeWith([roller('a', 0, [[1, 2, 1]]), roller('b', 6)])
    store.select('a')
    store.setSideGuardMode(true)
    store.setSelectedGuardOpening({ index: 0, guard: 'right' })
    store.select('b')
    expect(store.getState().sideGuardMode).toBe(true)
    expect(store.getState().selectedGuardOpening).toBeNull()
  })

  it('a view-only client cannot enter it', () => {
    const store = storeWith([roller('a', 0)])
    store.select('a')
    store.setReadOnly(true)
    expect(store.setSideGuardMode(true)).toBe(false)
  })

  it('the selected opening lapses when the rows change under it, so Delete cannot hit the wrong one', () => {
    const store = storeWith([roller('a', 0, [[0.5, 1, 1]])])
    store.select('a')
    store.setSideGuardMode(true)
    // a second opening is added (as an Inspector edit would), and the user selects it
    const s = store.getState().scene
    store.commit('add', { ...s, parts: s.parts.map((p) => ({ ...p, params: { ...p.params, guardOpenings: [[0.5, 1, 1], [2, 3, 1]] } }) as PartInstance) })
    store.setSelectedGuardOpening({ index: 1, guard: 'right' })
    store.undo() // row 1 is gone again: index 1 now points at nothing
    expect(store.getState().selectedGuardOpening).toBeNull()
    expect(store.removeSelectedGuardOpening()).toBe(false)
    expect(rowsOf(store, 'a')).toEqual([[0.5, 1, 1]])
  })

  it('Delete removes the selected opening from its wall only, one undo step, and never the conveyor', () => {
    const store = storeWith([roller('a', 0, [[1, 2, 0]])])
    store.select('a')
    store.setSideGuardMode(true)
    store.setSelectedGuardOpening({ index: 0, guard: 'left' })
    expect(store.removeSelectedGuardOpening()).toBe(true)
    expect(rowsOf(store, 'a')).toEqual([[1, 2, 1]]) // the right wall keeps its cut
    expect(store.getState().selectedGuardOpening).toBeNull()
    expect(store.removeSelectedGuardOpening()).toBe(false) // nothing selected: the conveyor is untouched
    expect(store.getState().scene.parts).toHaveLength(1)
    store.undo()
    expect(rowsOf(store, 'a')).toEqual([[1, 2, 0]])
  })
})
