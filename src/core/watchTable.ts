// A running program's value table without the table: the controller's memory as bytes, and where each value is in it.
//
// The typed PLC engine keeps a controller's memory in one buffer whose layout is fixed when the program is compiled
// (docs/plc-typed-storage.md). Building a name -> value object from it and cloning that across the thread boundary
// cost more than everything else a large program's watch did: 577,725 values took ~215 ms to build and ~100-250 ms
// to receive, on every send. The bytes themselves are 8.8 MB and copy in 0.4 ms.
//
// So the sim worker sends the layout once per program and a copy of the bytes per update, and the main thread reads
// a value from its address when someone asks for it. A reader still sees `Readonly<Record<string, value>>`: the table
// is a Proxy, so `table[key]` and `key in table` work as on the object it replaces. Listing its keys through the
// Proxy is slow at that size (the engine checks the list), so code that lists them uses the helpers here.
//
// A table that is a plain object (the walker engine's, a remote controller's, a followed run's) goes through the same
// helpers and is read as the object it is.

/** a value as a watch table holds it (plc `TagValue`, which this layer cannot import) */
export type WatchValue = number | boolean | string

/** How a value is stored at its address: the view it is read through (plc/typed/arena.ts `load`). */
export const WATCH_KIND = { BOOL: 0, I8: 1, U8: 2, I16: 3, U16: 4, I32: 5, U32: 6, F32: 7, F64: 8, STRING: 9 } as const

/** Where each watch value of one compiled program is: `keys[i]` is at byte `addrs[i]`, stored as `kinds[i]`. */
export interface WatchLayout {
  keys: string[]
  addrs: Uint32Array
  kinds: Uint8Array
  /** The arrays too long to list (plc/pou.ts WATCH_ARRAY_MAX). Their elements are not in `keys`: a table answers one
   *  by name, from the array's shape, when it is asked. */
  ranges?: WatchRange[]
}

/** What a place of an unlisted array holds: one value (its WATCH_KIND), a structure's fields, or an array. */
export type WatchShape =
  | { kind: number }
  | { fields: readonly { name: string; off: number; shape: WatchShape }[] }
  | { dims: readonly { lo: number; hi: number; stride: number }[]; elem: WatchShape }

/** One array left out of a layout's keys: the key its elements are written under (`Main.Big`), and where it starts. */
export interface WatchRange {
  key: string
  addr: number
  shape: WatchShape
}

/** What a table that is not a plain object reads from. */
interface WatchSource {
  readonly keys: readonly string[]
  has(key: string): boolean
  get(key: string): WatchValue | undefined
  forEach(fn: (key: string, value: WatchValue) => void): void
  /** set `key` in place, when the source can: a write shown before the frame that confirms it */
  put?(key: string, value: WatchValue): boolean
  /** the source's spelling of an element it answers without listing ({@link watchElementKey}) */
  elementKey?(name: string): string | null
}

// a layout's ranges by the upper-case key their elements are under, and by that key without its program instance
const rangeIndexes = new WeakMap<WatchLayout, { roots: Map<string, WatchRange>; tails: Map<string, WatchRange | null> }>()
function rangeIndexOf(layout: WatchLayout): { roots: Map<string, WatchRange>; tails: Map<string, WatchRange | null> } {
  let ix = rangeIndexes.get(layout)
  if (!ix) {
    ix = { roots: new Map(), tails: new Map() }
    for (const r of layout.ranges ?? []) {
      const key = r.key.toUpperCase()
      ix.roots.set(key, r)
      const dot = key.indexOf('.')
      if (dot > 0) {
        const tail = key.slice(dot + 1)
        ix.tails.set(tail, ix.tails.has(tail) ? null : r)
      }
    }
    rangeIndexes.set(layout, ix)
  }
  return ix
}

/** Where the unlisted element `name` is: its key as the table spells it, its address and its kind. Names compare
 *  without case, as the engine resolves them. `tails`: also a name written without its program instance, when one
 *  instance holds it. Null when `name` is no single value of a range. */
function locate(layout: WatchLayout, name: string, tails: boolean): { key: string; addr: number; kind: number } | null {
  if (!layout.ranges || layout.ranges.length === 0) return null
  const ix = rangeIndexOf(layout)
  const upper = name.toUpperCase()
  for (let at = upper.indexOf('['); at > 0; at = upper.indexOf('[', at + 1)) {
    const head = upper.slice(0, at)
    const range = ix.roots.get(head) ?? (tails ? ix.tails.get(head) : undefined)
    if (range) return descend(range, name.slice(at))
  }
  return null
}

function descend(range: WatchRange, rest: string): { key: string; addr: number; kind: number } | null {
  let shape = range.shape
  let addr = range.addr
  let key = range.key
  let i = 0
  while (i < rest.length) {
    if ('dims' in shape) {
      const end = rest.indexOf(']', i)
      if (rest[i] !== '[' || end < 0) return null
      const at = rest.slice(i + 1, end).split(',')
      if (at.length !== shape.dims.length) return null
      for (let k = 0; k < at.length; k++) {
        const d = shape.dims[k]!
        const n = /^-?[0-9]+$/.test(at[k]!) ? Number(at[k]) : NaN
        if (!(n >= d.lo && n <= d.hi)) return null
        addr += (n - d.lo) * d.stride
      }
      key += `[${at.map(Number).join(',')}]`
      shape = shape.elem
      i = end + 1
    } else if ('fields' in shape) {
      if (rest[i] !== '.') return null
      let end = i + 1
      while (end < rest.length && rest[end] !== '.' && rest[end] !== '[') end++
      const want = rest.slice(i + 1, end).toUpperCase()
      const field = shape.fields.find((f) => f.name.toUpperCase() === want)
      if (!field) return null
      addr += field.off
      key += `.${field.name}`
      shape = field.shape
      i = end
    } else return null // text after a value: one bit of a word, which its reader takes from the word
  }
  return 'kind' in shape ? { key, addr, kind: shape.kind } : null
}

// the position of each key of a layout, built when a key is first looked up and kept for the program's life
const indexes = new WeakMap<WatchLayout, Map<string, number>>()
function indexOf(layout: WatchLayout): Map<string, number> {
  let ix = indexes.get(layout)
  if (!ix) {
    ix = new Map()
    const keys = layout.keys
    for (let i = 0; i < keys.length; i++) ix.set(keys[i]!, i)
    indexes.set(layout, ix)
  }
  return ix
}

/** One copy of a controller's memory, read through its layout. */
class MemorySource implements WatchSource {
  readonly #layout: WatchLayout
  readonly #u8: Uint8Array
  readonly #i8: Int8Array
  readonly #i16: Int16Array
  readonly #u16: Uint16Array
  readonly #i32: Int32Array
  readonly #u32: Uint32Array
  readonly #f32: Float32Array
  readonly #f64: Float64Array

  constructor(layout: WatchLayout, bytes: ArrayBuffer) {
    this.#layout = layout
    this.#u8 = new Uint8Array(bytes)
    this.#i8 = new Int8Array(bytes)
    this.#i16 = new Int16Array(bytes)
    this.#u16 = new Uint16Array(bytes)
    this.#i32 = new Int32Array(bytes)
    this.#u32 = new Uint32Array(bytes)
    this.#f32 = new Float32Array(bytes)
    this.#f64 = new Float64Array(bytes)
  }

  get keys(): readonly string[] {
    return this.#layout.keys
  }

  has(key: string): boolean {
    return indexOf(this.#layout).has(key) || locate(this.#layout, key, false) !== null
  }

  get(key: string): WatchValue | undefined {
    const i = indexOf(this.#layout).get(key)
    if (i !== undefined) return this.#read(this.#layout.addrs[i]!, this.#layout.kinds[i]!)
    // an element of an array too long to list: read where its shape puts it
    const at = locate(this.#layout, key, false)
    return at ? this.#read(at.addr, at.kind) : undefined
  }

  forEach(fn: (key: string, value: WatchValue) => void): void {
    const { keys, addrs, kinds } = this.#layout
    for (let i = 0; i < keys.length; i++) fn(keys[i]!, this.#read(addrs[i]!, kinds[i]!))
  }

  elementKey(name: string): string | null {
    return locate(this.#layout, name, true)?.key ?? null
  }

  put(key: string, value: WatchValue): boolean {
    const i = indexOf(this.#layout).get(key)
    const at = i === undefined ? locate(this.#layout, key, false) : null
    if (i === undefined && !at) return false
    const addr = at ? at.addr : this.#layout.addrs[i!]!
    const kind = at ? at.kind : this.#layout.kinds[i!]!
    if (kind === WATCH_KIND.STRING || typeof value === 'string') return false
    const n = typeof value === 'boolean' ? (value ? 1 : 0) : value
    switch (kind) {
      case WATCH_KIND.BOOL: this.#u8[addr] = value ? 1 : 0; break
      case WATCH_KIND.I8: this.#i8[addr] = n; break
      case WATCH_KIND.U8: this.#u8[addr] = n; break
      case WATCH_KIND.I16: this.#i16[addr >> 1] = n; break
      case WATCH_KIND.U16: this.#u16[addr >> 1] = n; break
      case WATCH_KIND.I32: this.#i32[addr >> 2] = n; break
      case WATCH_KIND.U32: this.#u32[addr >> 2] = n; break
      case WATCH_KIND.F32: this.#f32[addr >> 2] = n; break
      default: this.#f64[addr >> 3] = n
    }
    return true
  }

  #read(addr: number, kind: number): WatchValue {
    switch (kind) {
      case WATCH_KIND.BOOL: return this.#u8[addr] !== 0
      case WATCH_KIND.I8: return this.#i8[addr]!
      case WATCH_KIND.U8: return this.#u8[addr]!
      case WATCH_KIND.I16: return this.#i16[addr >> 1]!
      case WATCH_KIND.U16: return this.#u16[addr >> 1]!
      case WATCH_KIND.I32: return this.#i32[addr >> 2]!
      case WATCH_KIND.U32: return this.#u32[addr >> 2]!
      case WATCH_KIND.F32: return this.#f32[addr >> 2]!
      case WATCH_KIND.F64: return this.#f64[addr >> 3]!
      default: {
        // a STRING: its length, then that many UTF-16 code units
        const at = addr >> 1
        const n = this.#u16[at]!
        let s = ''
        for (let k = 1; k <= n; k++) s += String.fromCharCode(this.#u16[at + k]!)
        return s
      }
    }
  }
}

/** A table over another: `over`'s values win, and `under`'s keys come first (the order `{ ...under, ...over }` gives). */
class OverlaySource implements WatchSource {
  #keys: string[] | null = null

  constructor(
    private readonly under: Readonly<Record<string, WatchValue>>,
    private readonly over: Readonly<Record<string, WatchValue>>,
  ) {}

  get keys(): readonly string[] {
    if (!this.#keys) {
      const keys = Object.keys(this.under)
      const mine = new Set(keys)
      for (const k of watchKeysOf(this.over)) if (!mine.has(k)) keys.push(k)
      this.#keys = keys
    }
    return this.#keys
  }

  has(key: string): boolean {
    return watchHas(this.over, key) || Object.hasOwn(this.under, key)
  }

  get(key: string): WatchValue | undefined {
    if (watchHas(this.over, key)) return this.over[key]
    return Object.hasOwn(this.under, key) ? this.under[key] : undefined
  }

  forEach(fn: (key: string, value: WatchValue) => void): void {
    for (const k of this.keys) fn(k, this.get(k)!)
  }

  elementKey(name: string): string | null {
    return watchElementKey(this.over, name)
  }
}

const SOURCE = Symbol('watch source')
type Target = { [SOURCE]: WatchSource }
const sources = new WeakMap<object, WatchSource>()

const handler: ProxyHandler<Target> = {
  get: (t, p) => (typeof p === 'string' ? t[SOURCE].get(p) : undefined),
  has: (t, p) => typeof p === 'string' && t[SOURCE].has(p),
  ownKeys: (t) => t[SOURCE].keys as string[],
  getOwnPropertyDescriptor: (t, p) => {
    if (typeof p !== 'string') return undefined
    const value = t[SOURCE].get(p)
    return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true }
  },
  // a table is read; a value shown early goes through withWatchValue (core/watchKeys.ts)
  set: () => false,
  defineProperty: () => false,
  deleteProperty: () => false,
}

function tableOf(source: WatchSource): Readonly<Record<string, WatchValue>> {
  const table = new Proxy<Target>({ [SOURCE]: source }, handler) as unknown as Readonly<Record<string, WatchValue>>
  sources.set(table, source)
  return table
}

/** The watch table of a program whose values are at `layout` in this copy of its memory. */
export function memoryTable(layout: WatchLayout, bytes: ArrayBuffer): Readonly<Record<string, WatchValue>> {
  return tableOf(new MemorySource(layout, bytes))
}

/** `{ ...under, ...over }` without copying `over`: a large table with a few values of another kind beside it. */
export function overlayTable(under: Readonly<Record<string, WatchValue>>, over: Readonly<Record<string, WatchValue>>): Readonly<Record<string, WatchValue>> {
  return tableOf(new OverlaySource(under, over))
}

/** The table's keys, in its order. The array is the table's own: do not change it. */
export function watchKeysOf(table: Readonly<Record<string, WatchValue>>): readonly string[] {
  return sources.get(table)?.keys ?? Object.keys(table)
}

/** How many values the table holds. */
export function watchKeyCount(table: Readonly<Record<string, WatchValue>>): number {
  return watchKeysOf(table).length
}

/** Does the table hold nothing? Without listing the keys of a plain object. */
export function watchIsEmpty(table: Readonly<Record<string, WatchValue>>): boolean {
  const source = sources.get(table)
  if (source) return source.keys.length === 0
  for (const k in table) if (Object.hasOwn(table, k)) return false
  return true
}

/** Each value of the table, in its order. */
export function forEachWatchValue<V extends WatchValue>(table: Readonly<Record<string, V>>, fn: (key: string, value: V) => void): void {
  const source = sources.get(table)
  if (source) return source.forEach(fn as (key: string, value: WatchValue) => void)
  for (const k of Object.keys(table)) fn(k, table[k]!)
}

/** Does the table hold `key` itself (not through a prototype)? */
export function watchHas(table: Readonly<Record<string, WatchValue>>, key: string): boolean {
  const source = sources.get(table)
  return source ? source.has(key) : Object.hasOwn(table, key)
}

/** The table's key for `name` when `name` is a value the table answers but does not list: an element of an array too
 *  long to list (`Big[700]`, `Recs[900].Ok`). The name may be in any case, and without the program instance its
 *  variable is under when one instance holds it. Null for anything else, a listed key included: a reader looks a name
 *  up in its own index of the keys first, and asks here when that misses. */
export function watchElementKey(table: Readonly<Record<string, WatchValue>>, name: string): string | null {
  return sources.get(table)?.elementKey?.(name) ?? null
}

/** `table` with `key` already in it set to `value`, as a new table: written in place when the table is a copy of
 *  memory (the copy is this thread's own), else null and the caller copies the object. */
export function putWatchValue<V extends WatchValue>(table: Readonly<Record<string, V>>, key: string, value: V): Readonly<Record<string, V>> | null {
  const source = sources.get(table)
  if (!source?.put?.(key, value)) return null
  return tableOf(source) as Readonly<Record<string, V>>
}
