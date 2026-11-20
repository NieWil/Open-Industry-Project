import { describe, expect, it } from 'vitest'
import { hasKeySet, keySetOf, markKeySet, withWatchValue } from './watchKeys'

describe('watch key sets', () => {
  it('a table nobody spoke for is its own key set', () => {
    const table = { A: 1 }
    expect(keySetOf(table)).toBe(table)
    expect(hasKeySet(table)).toBe(false)
  })

  it('two tables marked with one set share it', () => {
    const set = {}
    const first = { A: 1 }
    const second = { A: 2 }
    markKeySet(first, set)
    markKeySet(second, set)
    expect(keySetOf(first)).toBe(set)
    expect(keySetOf(second)).toBe(set)
    expect(hasKeySet(second)).toBe(true)
  })

  it('a written value keeps the key set, and a new key does not', () => {
    const set = {}
    const table = { A: 1 }
    markKeySet(table, set)
    const written = withWatchValue(table, 'A', 5)
    expect(written).toEqual({ A: 5 })
    expect(keySetOf(written)).toBe(set)
    const grown = withWatchValue(table, 'B', 1)
    expect(grown).toEqual({ A: 1, B: 1 })
    expect(keySetOf(grown)).toBe(grown)
  })
})
