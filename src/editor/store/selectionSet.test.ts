import { describe, expect, it } from 'vitest'
import { selectionSet } from './selectionSet'

describe('selectionSet', () => {
  it('answers membership for the ids given', () => {
    const set = selectionSet(['a', 'b'])
    expect(set.has('a') && set.has('b')).toBe(true)
    expect(set.has('c')).toBe(false)
  })

  it('builds one Set per selection array, so per-row callers share it', () => {
    const ids = ['a', 'b']
    expect(selectionSet(ids)).toBe(selectionSet(ids))
  })

  it('gives a new selection (a new array, as the store makes) its own Set', () => {
    const first = selectionSet(['a'])
    const next = selectionSet(['b'])
    expect(next).not.toBe(first)
    expect(next.has('a')).toBe(false)
  })
})
