// --- shared inspector helpers (formatting, numeric entry, the multi-part update seam) ---

import type { PartInstance } from '../../../core/types'
import { unitTable } from '../../../core/units'

/** Title Case each word (capitalises every property word). A trailing bracket is kept as written: it holds a unit or
 *  an explanation, and capitalising one turns "(m/s)" into "(M/S)" and "(s)" into "(S)", which are other units. */
export function titleCase(s: string): string {
  const m = /^(.*?)(\s*\([^()]*\))$/.exec(s)
  const head = m ? m[1]! : s
  return head.replace(/\b\w/g, (c) => c.toUpperCase()) + (m ? m[2]! : '')
}

/** how many decimals `n` needs to print exactly, up to `cap` */
function decimalsNeeded(n: number, cap: number): number {
  for (let d = 0; d < cap; d++) {
    const scaled = n * 10 ** d
    // relative tolerance: absorbs float noise (0.3 * 10 = 3.0000000000000004) without calling a tiny step whole
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9 * Math.max(1, Math.abs(scaled))) return d
  }
  return cap
}

/** inspector display precision from a spec's step, matching the range step (0.005 -> 3 dp, 1e-7 -> 7 dp) */
export function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || Number.isInteger(step)) return 0
  return decimalsNeeded(step, 12)
}

/**
 * Snap to the step grid without float noise: `Math.round(v / 0.1) * 0.1` alone stores 1.2000000000000002, which
 * then rides into the document and every diff of it.
 */
export function snapToStep(v: number, step: number): number {
  const snapped = Math.round(v / step) * step
  const d = decimalsForStep(step)
  return d > 0 ? Number(snapped.toFixed(d)) : snapped
}

/**
 * Display precision for a number table: the step's own, raised to show every value as authored (host-written
 * rows like guard openings carry more than a typed step) and capped so noise can't widen the columns. One value
 * for the whole table, so its columns line up.
 */
export function gridDecimals(rows: readonly (readonly number[])[], step: number | undefined): number {
  let d = step !== undefined ? decimalsForStep(step) : 0
  for (const row of rows) for (const n of row) if (Number.isFinite(n)) d = Math.max(d, decimalsNeeded(n, 4))
  return d
}

// Units typed into a field convert when the field's own unit is in the same table (core/units.ts, the one table the
// display units use too). Keys are lower case; the field unit is looked up lower-cased too ('FPM').
// one term: a number and its unit ("5ft", "6 in", "5'", "394 fpm"), sticky so the terms must tile the whole text
const UNIT_TERM = /\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(ft\/min|m\/s|[a-z]+|["'])\s*/iy

/** Text made only of number-and-unit terms in the field's dimension, summed and converted into the field's unit
 *  ("5' 6\"" in a metre field = 1.6764); null when the field has no convertible unit or the text isn't that. */
function convertUnits(s: string, unit: string): number | null {
  const table = unitTable(unit)
  if (!table) return null
  UNIT_TERM.lastIndex = 0
  let total = 0
  let terms = 0
  while (UNIT_TERM.lastIndex < s.length) {
    const m = UNIT_TERM.exec(s)
    const f = m ? table[m[2]!.toLowerCase()] : undefined
    if (!m || f === undefined) return null
    total += Number.parseFloat(m[1]!) * f
    terms++
  }
  return terms > 0 ? total / table[unit.toLowerCase()]! : null
}

// a comma a thousands number could hold: one to three digits before it, exactly three after
const THOUSANDS_GROUP = /(?:^|[^\d,])(\d{1,3}),\d{3}(?!\d)/g

/** Could a comma in `s` be a thousands separator? Not after a lone 0 ("0,125") or a fourth digit ("1234,567"). */
function couldBeThousands(s: string): boolean {
  for (const m of s.matchAll(THOUSANDS_GROUP)) if (m[1] !== '0') return true
  return false
}

/**
 * A comma between digits read as the decimal point ("1,5" -> "1.5"), as in most of Europe. parseFloat stopped at
 * the comma and stored 1. Null when the comma could also be a thousands separator ("1,500", or with a point as well,
 * "1,500.5"), or when a comma stands anywhere else: the field then keeps its value rather than guess.
 */
function decimalComma(s: string): string | null {
  if (!s.includes(',')) return s
  if (s.includes('.') || couldBeThousands(s)) return null
  const out = s.replace(/(\d),(\d)/g, '$1.$2')
  return out.includes(',') ? null : out
}

/**
 * Parse a number field's committed text: a length or speed typed in another unit converts into the field's
 * ("5ft" or "5' 6\"" into metres, "394 fpm" into m/s), the field's own unit suffix is stripped ("1.5 m" -> 1.5),
 * and simple math expressions evaluate ("2*0.75" -> 1.5). Returns null when nothing numeric is present.
 */
export function evalNumeric(text: string, unit: string): number | null {
  const raw = decimalComma(text)
  if (raw === null) return null
  // before the suffix strip, which would read "600mm" in a metre field as "600m"
  const converted = unit ? convertUnits(raw.trim(), unit) : null
  if (converted !== null) return Number.isFinite(converted) ? converted : null
  let s = raw.trim()
  if (unit && s.toLowerCase().endsWith(unit.toLowerCase())) s = s.slice(0, -unit.length).trim()
  if (s === '') return null
  // Arithmetic-only strings are safe to evaluate (no identifiers can appear), and they are only evaluated: a
  // malformed one ("2 3", "5%", "1/0") is rejected rather than half-read by parseFloat as 2, 5 or 1.
  if (/^[-+*/%.()eE0-9\s]+$/.test(s)) {
    try {
      const v = Function(`"use strict"; return (${s})`)() as unknown
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch {
      return null
    }
  }
  // anything else is a number followed by a unit-like suffix the field doesn't know ("1.5 m/s")
  const plain = Number.parseFloat(s)
  return Number.isFinite(plain) ? plain : null
}

/**
 * A relative entry: "+= 1.2" or "-= 600mm" is an offset from the value the field holds, the rest read as
 * evalNumeric reads a value. undefined when the text isn't one (a plain "-5" stays an absolute value), null when
 * it is one whose amount doesn't parse.
 */
export function parseOffset(raw: string, unit: string): number | null | undefined {
  const m = /^\s*([+-])=(.*)$/s.exec(raw)
  if (!m) return undefined
  const v = evalNumeric(m[2]!, unit)
  return v === null ? null : m[1] === '-' ? -v : v
}

export type Update =(label: string, key: string, mutate: (p: PartInstance) => PartInstance) => void

/** the fold map after row `removed` is deleted: its own entry gone, every later entry one index down */
export function shiftFoldsAfterRemove(folds: Readonly<Record<number, boolean>>, removed: number): Record<number, boolean> {
  const out: Record<number, boolean> = {}
  for (const [k, v] of Object.entries(folds)) {
    const i = Number(k)
    if (i < removed) out[i] = v
    else if (i > removed) out[i - 1] = v
  }
  return out
}
