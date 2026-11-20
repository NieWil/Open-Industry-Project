import { describe, expect, it } from 'vitest'
import { EditorStore } from '../store/store'
import { MAX_DISPLAY_VALUES } from '../../core/scene/sceneDisplay'
import { addDisplayed, moveDisplayed, setDisplayed } from './displayValues'

const listed = (store: EditorStore) => store.getState().scene.display ?? []

describe("the project's display list, edited from the editor", () => {
  it('shows and stops showing a value, each one undo step', () => {
    const store = new EditorStore()
    setDisplayed(store, 'Speed', true)
    setDisplayed(store, 'Count', true)
    expect(listed(store)).toEqual(['Speed', 'Count'])
    setDisplayed(store, 'Speed', false)
    expect(listed(store)).toEqual(['Count'])
    store.undo()
    expect(listed(store)).toEqual(['Speed', 'Count'])
    // an emptied list leaves the scene without one
    setDisplayed(store, 'Speed', false)
    setDisplayed(store, 'Count', false)
    expect('display' in store.getState().scene).toBe(false)
  })

  it('adds several after those shown, each once, up to the limit', () => {
    const store = new EditorStore()
    setDisplayed(store, 'Speed', true)
    addDisplayed(store, ['Count', 'Speed', 'Count', 'Fault'])
    expect(listed(store)).toEqual(['Speed', 'Count', 'Fault'])
    addDisplayed(store, Array.from({ length: MAX_DISPLAY_VALUES + 5 }, (_, i) => `T${i}`))
    expect(listed(store)).toHaveLength(MAX_DISPLAY_VALUES)
  })

  it('adds nothing to a full list, so no undo step changes nothing', () => {
    const store = new EditorStore()
    addDisplayed(store, Array.from({ length: MAX_DISPLAY_VALUES }, (_, i) => `T${i}`))
    const before = store.getState().scene
    setDisplayed(store, 'Speed', true)
    addDisplayed(store, ['Count'])
    expect(store.getState().scene).toBe(before)
    store.undo()
    expect(listed(store)).toEqual([])
  })

  it('moves a value in the order', () => {
    const store = new EditorStore()
    addDisplayed(store, ['A', 'B', 'C'])
    moveDisplayed(store, 2, 0)
    expect(listed(store)).toEqual(['C', 'A', 'B'])
    moveDisplayed(store, 0, 9) // out of range: nothing
    expect(listed(store)).toEqual(['C', 'A', 'B'])
  })

  it('changes nothing for a view-only link', () => {
    const store = new EditorStore()
    store.setReadOnly(true)
    setDisplayed(store, 'Speed', true)
    addDisplayed(store, ['Count'])
    expect(listed(store)).toEqual([])
  })
})
