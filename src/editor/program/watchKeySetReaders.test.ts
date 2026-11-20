import { describe, expect, it } from 'vitest'
import { markKeySet } from '../../core/watchKeys'
import type { TagValue } from '../../plc'
import { forceKeyOf } from './plcForces'
import { resolveWatch } from './plcWatchList'
import { keysByUpper } from './stLang'

// A running program's table is a new object on every send, with the same keys (core/watchKeys.ts). What these readers
// derive from the keys must be built once per key set: on a large program each listing of the keys is hundreds of
// milliseconds. A proxy counts the listings, so the test does not time anything.

type Table = Readonly<Record<string, TagValue>>

/** `values` as a table that counts how often its keys are listed, in key set `set`. */
function counted(values: Record<string, TagValue>, set: object, count: { listed: number }): Table {
  const table = new Proxy(values, {
    ownKeys(target) {
      count.listed++
      return Reflect.ownKeys(target)
    },
  })
  markKeySet(table, set)
  return table
}

const VALUES = { 'Line.Run': true, 'Line.Count': 3, 'Line.Bins[0]': 1, 'Line.Bins[1]': 2, Status: 8, Name: 'a' }

describe('readers of the value table list its keys once per key set', () => {
  it('forceKeyOf (the Inspector, the scene tree, the organizer)', () => {
    const set = {}
    const count = { listed: 0 }
    for (let send = 0; send < 5; send++) {
      const table = counted({ ...VALUES, 'Line.Count': send }, set, count)
      expect(forceKeyOf('line.run', table)).toBe('Line.Run')
      expect(forceKeyOf('Status.3', table)).toBe('Status.3')
      expect(forceKeyOf('Name', table)).toBeNull() // a STRING cannot be forced
      expect(forceKeyOf('Nope', table)).toBeNull()
    }
    expect(count.listed).toBe(1)
  })

  it('resolveWatch (the Watch dock): a value, a bit, a bare instance variable and a structure', () => {
    const set = {}
    const count = { listed: 0 }
    for (let send = 0; send < 5; send++) {
      const table = counted({ ...VALUES, 'Line.Count': send }, set, count)
      expect(resolveWatch('LINE.COUNT', table)).toMatchObject({ key: 'Line.Count', value: send })
      expect(resolveWatch('Status.3', table)).toMatchObject({ key: 'Status.3', value: true })
      expect(resolveWatch('Count', table)).toMatchObject({ key: 'Line.Count', value: send })
      expect(resolveWatch('Line.Bins', table)).toMatchObject({
        key: null,
        members: [
          { key: 'Line.Bins[0]', value: 1 },
          { key: 'Line.Bins[1]', value: 2 },
        ],
        more: 0,
      })
    }
    expect(count.listed).toBe(1)
  })

  it('resolveWatch reads the members of each new table, not of the first', () => {
    const set = {}
    const count = { listed: 0 }
    resolveWatch('Line.Bins', counted({ ...VALUES }, set, count))
    const later = resolveWatch('Line.Bins', counted({ ...VALUES, 'Line.Bins[1]': 9 }, set, count))
    expect(later.members[1]).toEqual({ key: 'Line.Bins[1]', value: 9 })
  })

  it('resolveWatch does not take a name two instances hold', () => {
    const table: Table = { 'A.Count': 1, 'B.Count': 2 }
    expect(resolveWatch('Count', table)).toMatchObject({ key: null, members: [] })
  })

  it("the text editor's key index, and another key set gets its own", () => {
    const set = {}
    const count = { listed: 0 }
    for (let send = 0; send < 5; send++) {
      const table = counted({ ...VALUES, 'Line.Count': send }, set, count)
      expect(keysByUpper(table).get('LINE.RUN')).toBe('Line.Run')
    }
    expect(count.listed).toBe(1)
    // a reloaded program: another key set, with a key the old index never had
    const reloaded = counted({ 'Line.Go': true }, {}, count)
    expect(keysByUpper(reloaded).get('LINE.GO')).toBe('Line.Go')
  })
})
