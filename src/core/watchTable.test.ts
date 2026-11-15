import { describe, expect, it } from 'vitest'
import { keySetOf, markKeySet, withWatchValue } from './watchKeys'
import { forEachWatchValue, lazyTable, memoryTable, overlayTable, putWatchValue, WATCH_KIND, watchHas, watchIsEmpty, watchKeyCount, watchKeysOf, type WatchLayout } from './watchTable'

// A table read from a copy of a controller's memory must answer as the object it replaces, for every way a reader
// asks. (That it holds the same values as the engine's own table is the engine's test: plc/watchPlan.test.ts.)

function memory(): { layout: WatchLayout; bytes: ArrayBuffer } {
  const bytes = new ArrayBuffer(64)
  const u8 = new Uint8Array(bytes)
  const i16 = new Int16Array(bytes)
  const u16 = new Uint16Array(bytes)
  const i32 = new Int32Array(bytes)
  const f32 = new Float32Array(bytes)
  const f64 = new Float64Array(bytes)
  u8[8] = 1 // Run
  u8[9] = 200 // Byte
  i16[5] = -7 // Small, at 10
  i32[3] = -100000 // Count, at 12
  f32[4] = 1.5 // Speed, at 16
  f64[3] = 2.25 // Time, at 24
  u16[16] = 2 // Name, at 32: its length, then its text
  u16[17] = 'o'.charCodeAt(0)
  u16[18] = 'k'.charCodeAt(0)
  const keys = ['Run', 'Byte', 'Small', 'Count', 'Speed', 'Time', 'Name', 'Empty']
  const addrs = new Uint32Array([8, 9, 10, 12, 16, 24, 32, 40])
  const kinds = new Uint8Array([WATCH_KIND.BOOL, WATCH_KIND.U8, WATCH_KIND.I16, WATCH_KIND.I32, WATCH_KIND.F32, WATCH_KIND.F64, WATCH_KIND.STRING, WATCH_KIND.STRING])
  return { layout: { keys, addrs, kinds }, bytes }
}
const VALUES = { Run: true, Byte: 200, Small: -7, Count: -100000, Speed: 1.5, Time: 2.25, Name: 'ok', Empty: '' }

describe('a table read from a copy of memory', () => {
  it('answers every read an object answers', () => {
    const { layout, bytes } = memory()
    const table = memoryTable(layout, bytes)
    expect(table.Count).toBe(-100000)
    expect(table.Name).toBe('ok')
    expect(table.Nope).toBeUndefined()
    expect('Run' in table).toBe(true)
    expect('Nope' in table).toBe(false)
    expect(Object.hasOwn(table, 'Speed')).toBe(true)
    expect(Object.hasOwn(table, 'Nope')).toBe(false)
    expect(Object.keys(table)).toEqual(Object.keys(VALUES))
    expect(Object.entries(table)).toEqual(Object.entries(VALUES))
    expect({ ...table }).toEqual(VALUES)
    expect(JSON.parse(JSON.stringify(table))).toEqual(VALUES)
    const seen: string[] = []
    for (const k in table) seen.push(k)
    expect(seen).toEqual(Object.keys(VALUES))
  })

  it('holds no name an object inherits, and takes no write', () => {
    const { layout, bytes } = memory()
    const table = memoryTable(layout, bytes) as Record<string, unknown>
    expect(table.constructor).toBeUndefined()
    expect(table.toString).toBeUndefined()
    expect('hasOwnProperty' in table).toBe(false)
    expect(Reflect.set(table, 'Count', 1)).toBe(false)
    expect(Reflect.deleteProperty(table, 'Count')).toBe(false)
    expect(table.Count).toBe(-100000)
  })

  it('is read by the helpers as a plain object is', () => {
    const { layout, bytes } = memory()
    for (const table of [memoryTable(layout, bytes), { ...VALUES }]) {
      expect(watchKeysOf(table)).toEqual(Object.keys(VALUES))
      expect(watchKeyCount(table)).toBe(8)
      expect(watchHas(table, 'Byte')).toBe(true)
      expect(watchHas(table, 'toString')).toBe(false)
      expect(watchIsEmpty(table)).toBe(false)
      const seen: [string, unknown][] = []
      forEachWatchValue(table, (k, v) => seen.push([k, v]))
      expect(seen).toEqual(Object.entries(VALUES))
    }
    expect(watchIsEmpty({})).toBe(true)
    expect(watchIsEmpty(memoryTable({ keys: [], addrs: new Uint32Array(0), kinds: new Uint8Array(0) }, new ArrayBuffer(8)))).toBe(true)
  })

  it('shows a written value at once, as a new table of the same key set', () => {
    const { layout, bytes } = memory()
    const table = memoryTable(layout, bytes)
    const set = {}
    markKeySet(table, set)
    const next = withWatchValue(table, 'Run', false)
    expect(next).not.toBe(table)
    expect(next.Run).toBe(false)
    expect(keySetOf(next)).toBe(set)
    expect(withWatchValue(next, 'Count', 12).Count).toBe(12)
    expect(withWatchValue(next, 'Speed', 0.25).Speed).toBe(0.25)
    // text is not written in place, and neither is a key the table lacks
    expect(putWatchValue(table, 'Name', 'no')).toBeNull()
    expect(putWatchValue(table, 'Nope', 1)).toBeNull()
  })
})

describe('one table laid over another', () => {
  it('reads as the two spread into one object', () => {
    const { layout, bytes } = memory()
    const over = memoryTable(layout, bytes)
    const under = { 'Cell2::Go': true, Count: 5, Link: 3 }
    const table = overlayTable(under, over)
    const spread = { ...under, ...VALUES }
    expect({ ...table }).toEqual(spread)
    expect(Object.keys(table)).toEqual(Object.keys(spread))
    expect(table.Count).toBe(-100000) // the table on top wins
    expect(table.Link).toBe(3)
    expect('Cell2::Go' in table).toBe(true)
    expect(table.Nope).toBeUndefined()
    expect(watchKeyCount(table)).toBe(Object.keys(spread).length)
  })
})

describe('a table built when it is read', () => {
  it('is not built until something reads it, and then once', () => {
    let builds = 0
    const table = lazyTable(() => {
      builds++
      return { Run: true, Count: 7, 'Zone[1].Speed': 1.5 }
    })
    expect(builds).toBe(0)
    expect(table['Count']).toBe(7)
    expect(builds).toBe(1)
    expect('Run' in table).toBe(true)
    expect('Nothing' in table).toBe(false)
    expect(table['Nothing']).toBeUndefined()
    expect(watchKeysOf(table)).toEqual(['Run', 'Count', 'Zone[1].Speed'])
    expect(watchHas(table, 'Zone[1].Speed')).toBe(true)
    expect(watchKeyCount(table)).toBe(3)
    const seen: string[] = []
    forEachWatchValue(table, (k, v) => seen.push(`${k}=${String(v)}`))
    expect(seen).toEqual(['Run=true', 'Count=7', 'Zone[1].Speed=1.5'])
    expect(builds).toBe(1)
  })
})
