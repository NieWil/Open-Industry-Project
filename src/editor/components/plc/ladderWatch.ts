// A ladder sheet's live values: the variable image the running program publishes, read by the text a rung spells a
// variable with. A large program publishes thousands of values, polled eight times a second, so the lookup is indexed.
//
// Pure: the sheet (LadderView.tsx) keeps the index and polls the image; nothing here touches the DOM.

import type { TagValue } from '../../../plc/types'
import { watchElementKey, watchHas, watchKeysOf } from '../../../core/watchTable'

/** The names of a value table, indexed for lookup. This is the expensive part: a large program publishes thousands of
 *  values, and upper-casing every key eight times a second would take a tenth of a core on its own. The key set of a
 *  running program does not change, so the index is built when it does ({@link indexWatch}) and only read after that. */
export interface WatchIndex {
  /** every key by its upper-cased spelling */
  readonly exact: Map<string, string>
  /** a PROGRAM instance's variables by their bare names: null where two instances have the name */
  readonly tails: Map<string, string | null>
  /** operand text -> key, for the texts whose key cannot change (no index that is itself a variable) */
  resolved: Map<string, string | null>
}

// Each part of the index is made when a lookup first needs it. A large program's table holds half a million values
// and reading every key takes about a second, while a name spelled as the table spells it needs no index at all
// (`watchLookup` asks the table first), and most of what a sheet shows is spelled that way.
export function indexWatch(watch: Readonly<Record<string, TagValue>>): WatchIndex {
  let maps: { exact: Map<string, string>; tails: Map<string, string | null> } | null = null
  const build = (): { exact: Map<string, string>; tails: Map<string, string | null> } => {
    const exact = new Map<string, string>()
    const tails = new Map<string, string | null>()
    for (const k of watchKeysOf(watch)) {
      const key = k.toUpperCase()
      exact.set(key, k)
      // a PROGRAM instance's variables are published as `Instance.Name`: a bare name answers when one instance has it
      const dot = key.indexOf('.')
      if (dot > 0) {
        const tail = key.slice(dot + 1)
        tails.set(tail, tails.has(tail) ? null : k)
      }
    }
    return { exact, tails }
  }
  return {
    get exact() {
      return (maps ??= build()).exact
    },
    get tails() {
      return (maps ??= build()).tails
    },
    resolved: new Map(),
  }
}

export interface WatchLookup {
  /** a variable's value by the text a rung spells it with; undefined when the image has none */
  valueOf: (text: string) => TagValue | undefined
  /** the image's own key for that text (what a write into the running program goes by), or null */
  keyOf: (text: string) => string | null
}

const NOTHING: WatchLookup = { valueOf: () => undefined, keyOf: () => null }

export function watchLookup(watch: Readonly<Record<string, TagValue>> | null, index: WatchIndex | null): WatchLookup {
  if (!watch || !index) return NOTHING
  // (the index is read where it is needed, never up front: reading `exact` or `tails` is what builds them)
  const { resolved } = index
  // (an element of an array too long to be among the keys is asked of the table: core/watchTable.ts)
  const plain = (key: string): string | null => index.exact.get(key) ?? index.tails.get(key) ?? watchElementKey(watch, key)
  // as the image spells it: no spaces, and an index that is a variable (`A[i]`) as the number it holds now
  const spell = (text: string): string =>
    text
      .replace(/\s+/g, '')
      .toUpperCase()
      .replace(/\[([^\]]*)\]/g, (_, inner: string) => `[${inner.split(',').map((ix) => { const k = plain(ix); const v = k === null ? undefined : watch[k]; return typeof v === 'number' ? String(v) : ix }).join(',')}]`)
  const resolve = (text: string): string | null => {
    const typed = text.replace(/\s+/g, '')
    // a literal (`0`, `16#FF`, `T#5s`, `'text'`) is no variable: every key begins with a name, then `.`, `[` or its end
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:[.[]|$)/.test(typed)) return null
    // Spelled as the table spells it, which is what a name picked from a list is: the table answers and the index is
    // not needed. Names differ by more than case, so this is the key the index would give.
    if (watchHas(watch, typed)) return typed
    const typedBit = /^(.+)\.([0-9]+)$/.exec(typed)
    if (typedBit && watchHas(watch, typedBit[1]!) && typeof watch[typedBit[1]!] === 'number') return typed
    const key = spell(text)
    const found = plain(key)
    if (found !== null) return found
    // `Status.3`: one bit of a word. The image holds the word; the bit is named after it.
    const bit = /^(.+)\.([0-9]+)$/.exec(key)
    const word = bit ? plain(bit[1]!) : null
    return bit && word !== null && typeof watch[word] === 'number' ? `${word}.${bit[2]}` : null
  }
  const keyOf = (text: string): string | null => {
    // an index that names a variable (`A[i]`) moves with that variable's value; every other text's key never changes
    if (/\[[^\]]*[A-Za-z_]/.test(text)) return resolve(text)
    const had = resolved.get(text)
    if (had !== undefined) return had
    const key = resolve(text)
    resolved.set(text, key)
    return key
  }
  const valueOf = (text: string): TagValue | undefined => {
    const k = keyOf(text)
    if (k === null) return undefined
    if (k in watch) return watch[k]
    const bit = /^(.+)\.([0-9]+)$/.exec(k)
    const word = bit ? watch[bit[1]!] : undefined
    return bit && typeof word === 'number' ? ((word >>> Number(bit[2])) & 1) === 1 : undefined
  }
  return { keyOf, valueOf }
}

/** A value as a rung prints it: a BOOL as 1 / 0, a number to three places. */
export const fmt = (v: TagValue | undefined): string => (v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v)

/** Does `lookup` (a newer image) give every operand the value the last draw read for it? `shown` is that draw's
 *  record: operand text to the value it was handed. True means a redraw would paint the same sheet. */
export function shownUnchanged(shown: ReadonlyMap<string, TagValue | undefined>, lookup: WatchLookup): boolean {
  for (const [text, was] of shown) if (!Object.is(lookup.valueOf(text), was)) return false
  return true
}
