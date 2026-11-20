// Find and Replace over ladder, working on a routine through what the rungs say - the fields
// of every element, its word, the rung comments - and never through the text between them, so a search for `Belt1`
// cannot land on punctuation, and a replace cannot break a rung's grammar by accident.
//
// Part of the shared rung core (ladderEdit.ts): it reads a family's leaf only through `LeafText` - its word (an IEC
// function's name: found, never replaced) and its fields (an IEC contact's or coil's variable, a block's instance and pin values) - so every dialect's editor has the same Find/Replace.
//
// It works on the rungs as the view holds them (a family's `readLadder`), and a replace hands back edited rungs for
// its `writeLadder`: the same road every gesture takes, so it is one undo step and replicates in a room.

import { isBranch, type RungElementOf, type RungOf } from './ladderEdit'

/** How Find/Replace reads and writes one family's leaf. */
export interface LeafText<L> {
  /** the word the leaf is written with (an IEC function's name): found, never replaced; `''` for none */
  word(leaf: L): string
  /** its fields, in the order a view numbers them (`LdFound.field`) */
  fields(leaf: L): readonly string[]
  /** field `index` written `text`, in place */
  setField(leaf: L, index: number, text: string): void
}

export interface LdFindOptions {
  /** what to look for; matched without regard to case, as tag names are */
  query: string
  /** "match whole word": `Belt1` is not found in `Belt10` or `Belt1_Run`, and is in `Belt1.Run` and `Belts[Belt1]` */
  whole: boolean
}

/** Where a match is. `field` is the field's index; -1 is the element's word (found, never replaced: a word
 *  is retyped, since what stands in its place must be another element), and 'comment' the rung's comment,
 *  for which `trail` is empty. */
export interface LdFound {
  routine: number
  rung: number
  trail: number[]
  field: number | 'comment'
}

const WORD = /[A-Za-z0-9_]/

/** Every place `query` stands in `text`, as `[start, end)`. */
export function matchesIn(text: string, { query, whole }: LdFindOptions): [number, number][] {
  const out: [number, number][] = []
  if (query === '') return out
  const [hay, needle] = [text.toUpperCase(), query.toUpperCase()]
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const end = at + needle.length
    // a boundary is only asked of an end of the query that is a word character: `.Q` is whole in `T1.Q`
    const open = !WORD.test(needle[0]!) || at === 0 || !WORD.test(hay[at - 1]!)
    const close = !WORD.test(needle[needle.length - 1]!) || end === hay.length || !WORD.test(hay[end]!)
    if (!whole || (open && close)) out.push([at, end])
  }
  return out
}

/** `text` with every match replaced (matches do not overlap once replaced: the scan moves past each one). */
export function replaceIn(text: string, opts: LdFindOptions, replacement: string): string {
  let [out, from] = ['', 0]
  for (const [start, end] of matchesIn(text, opts)) {
    if (start < from) continue
    out += text.slice(from, start) + replacement
    from = end
  }
  return out + text.slice(from)
}

/**
 * Every match, in reading order: routine by routine, rung by rung, the comment first (it is drawn above the rung),
 * then the instructions left to right and down the branch levels, each one's mnemonic before its operands.
 * `scope` is one routine's index, or 'all'.
 */
export function findInLadder<L>(routines: readonly { rungs: readonly RungOf<L>[] }[], opts: LdFindOptions, scope: number | 'all', leaves: LeafText<L>): LdFound[] {
  const out: LdFound[] = []
  if (opts.query === '') return out
  const hit = (text: string): boolean => matchesIn(text, opts).length > 0
  routines.forEach((r, routine) => {
    if (scope !== 'all' && scope !== routine) return
    r.rungs.forEach((rung, i) => {
      if (hit(rung.comment)) out.push({ routine, rung: i, trail: [], field: 'comment' })
      const walk = (els: readonly RungElementOf<L>[], home: number[]): void => {
        els.forEach((el, k) => {
          const trail = [...home, k]
          if (isBranch(el)) el.paths.forEach((p, level) => walk(p, [...trail, level]))
          else {
            if (hit(leaves.word(el))) out.push({ routine, rung: i, trail, field: -1 })
            leaves.fields(el).forEach((text, field) => {
              if (hit(text)) out.push({ routine, rung: i, trail, field })
            })
          }
        })
      }
      walk(rung.elements, [])
    })
  })
  return out
}

const same = (a: LdFound, b: LdFound): boolean => a.routine === b.routine && a.rung === b.rung && a.field === b.field && a.trail.join('.') === b.trail.join('.')

/**
 * The match after (`by` = 1) or before (-1) `from` in `found`. `from` that is no longer a match (it was just
 * replaced) is stepped from by its place, so Replace moves on to the next one rather than back to the first.
 * Without `wrap` the search stops at the end it is heading for, and says so with null.
 */
export function stepFound(found: readonly LdFound[], from: LdFound | null, by: 1 | -1, wrap: boolean): LdFound | null {
  if (found.length === 0) return null
  if (!from) return by === 1 ? found[0]! : found[found.length - 1]!
  const at = found.findIndex((f) => same(f, from))
  let next: number
  if (at >= 0) next = at + by
  else {
    // where `from` would stand: the first match past it, in reading order
    const past = found.findIndex((f) => order(f, from) > 0)
    next = by === 1 ? (past < 0 ? found.length : past) : (past < 0 ? found.length : past) - 1
  }
  if (next < 0 || next >= found.length) return wrap ? found[(next + found.length) % found.length]! : null
  return found[next]!
}

/** Reading order of two places. */
function order(a: LdFound, b: LdFound): number {
  if (a.routine !== b.routine) return a.routine - b.routine
  if (a.rung !== b.rung) return a.rung - b.rung
  // the comment is above the rung
  if ((a.field === 'comment') !== (b.field === 'comment')) return a.field === 'comment' ? -1 : 1
  for (let k = 0; k < Math.max(a.trail.length, b.trail.length); k++) {
    const d = (a.trail[k] ?? -1) - (b.trail[k] ?? -1)
    if (d !== 0) return d
  }
  return (a.field === 'comment' ? 0 : a.field) - (b.field === 'comment' ? 0 : b.field)
}

/** Can this match be replaced? (A mnemonic cannot: see {@link LdFound}.) */
export const replaceable = (f: LdFound): boolean => f.field !== -1

/**
 * The rungs of each routine touched, with `targets` replaced - `replaceable` ones only. Keyed by routine index,
 * for `writeLadder`. Rungs are copied, never edited in place: the view's own are what undo compares against.
 */
export function replaceFound<L>(routines: readonly { rungs: readonly RungOf<L>[] }[], targets: readonly LdFound[], opts: LdFindOptions, replacement: string, leaves: LeafText<L>): Map<number, RungOf<L>[]> {
  const out = new Map<number, RungOf<L>[]>()
  for (const t of targets) {
    if (!replaceable(t)) continue
    const source = routines[t.routine]
    if (!source) continue
    let rungs = out.get(t.routine)
    if (!rungs) out.set(t.routine, (rungs = source.rungs.map((r) => structuredClone(r) as RungOf<L>)))
    const rung = rungs[t.rung]
    if (!rung) continue
    if (t.field === 'comment') {
      rung.comment = replaceIn(rung.comment, opts, replacement)
      continue
    }
    let els: RungElementOf<L>[] = rung.elements
    let el: RungElementOf<L> | undefined
    for (let k = 0; k < t.trail.length; k += 2) {
      el = els[t.trail[k]!]
      const level = t.trail[k + 1]
      if (isBranch(el) && level !== undefined) els = el.paths[level] ?? []
    }
    if (el === undefined || isBranch(el) || typeof t.field !== 'number') continue
    const text = leaves.fields(el)[t.field]
    if (text !== undefined) leaves.setField(el, t.field, replaceIn(text, opts, replacement))
  }
  return out
}
