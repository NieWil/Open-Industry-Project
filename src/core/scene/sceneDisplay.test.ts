import { describe, expect, it } from 'vitest'
import { MAX_DISPLAY_VALUES, readDisplayList, withDisplayed } from './sceneDisplay'

describe("a scene's display list", () => {
  it('keeps names only, trimmed, each once, and says what it dropped', () => {
    const repairs: string[] = []
    expect(readDisplayList([' Speed ', 'Speed', 3, null, '', 'x'.repeat(200), '%IX100.0'], repairs)).toEqual(['Speed', '%IX100.0'])
    expect(repairs).toEqual([])
    expect(readDisplayList('Speed', repairs)).toBeUndefined()
    expect(repairs).toHaveLength(1)
    expect(readDisplayList([])).toBeUndefined()
    expect(readDisplayList(undefined)).toBeUndefined()
  })

  it('holds at most MAX_DISPLAY_VALUES, saying so', () => {
    const repairs: string[] = []
    const many = Array.from({ length: MAX_DISPLAY_VALUES + 5 }, (_, i) => `T${i}`)
    expect(readDisplayList(many, repairs)).toHaveLength(MAX_DISPLAY_VALUES)
    expect(repairs).toHaveLength(1)
  })

  it('shows or stops showing one name, and an emptied list is no list', () => {
    expect(withDisplayed(undefined, 'Speed', true)).toEqual(['Speed'])
    expect(withDisplayed(['Speed'], 'Count', true)).toEqual(['Speed', 'Count'])
    expect(withDisplayed(['Speed', 'Count'], 'Speed', false)).toEqual(['Count'])
    expect(withDisplayed(['Speed'], 'Speed', false)).toBeUndefined()
    expect(withDisplayed(undefined, 'Speed', false)).toBeUndefined()
  })
})
