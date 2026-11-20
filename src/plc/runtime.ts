// Execution-time helpers shared by the interpreter and the ST->TS emitter, so the
// IEC semantics live in exactly one place. Every scalar type is kept faithful on top of
// JS numbers by pushing results through `wrap` after each operation: integers wrap to the
// declared bit width (two's complement), and REAL rounds to single precision.
//
// REAL is f32, not f64. IEC REAL is 32-bit and LREAL is 64-bit, and every target we care
// about implements it that way (MATIEC maps REAL to C `float`, IEEE 754 single precision).
// Treating REAL as a JS double would silently drift
// from the hardware on any accumulation or comparison - the exact class of divergence this
// engine's portability promise cannot afford. `wrap` is the one place that happens, so the
// interpreter and the emitter cannot disagree about it.

import type { FbType, ScalarType, TagValue } from './types'
import { MotionChannel, type MotionOutputs } from './motionChannel'

export function isInt(t: ScalarType): boolean {
  return (
    t === 'SINT' || t === 'INT' || t === 'DINT' ||
    t === 'USINT' || t === 'UINT' || t === 'UDINT' ||
    t === 'BYTE' || t === 'WORD' || t === 'DWORD'
  )
}

export function isReal(t: ScalarType): boolean {
  return t === 'REAL' || t === 'LREAL'
}

/** TIME - a duration in milliseconds. Not an integer and not a real: it has its own
 *  arithmetic (durations add, scale by a number, and compare, but never mix with plain
 *  numbers), which is the whole reason it is a distinct type. */
export function isTime(t: ScalarType): boolean {
  return t === 'TIME'
}

/**
 * bit-string (`BYTE`/`WORD`/`DWORD`) - IEC's `ANY_BIT` minus BOOL.
 *
 * This is a hard boundary, not a naming convention. IEC defines arithmetic (`+ - * / MOD`)
 * over `ANY_NUM` and bitwise/shift operations over `ANY_BIT`, and the two sets do not
 * overlap: `aByte + 1` and `NOT anInt` are both type errors on a real compiler. MATIEC
 * rejects them, and this engine once accepted both - programs that built in the
 * simulator and could not build on any target.
 */
export function isBitString(t: ScalarType): boolean {
  return t === 'BYTE' || t === 'WORD' || t === 'DWORD'
}

/** STRING - character data. Ordered (so it compares) but not arithmetic: `+` on two
 *  STRINGs is a type error here because IEC has no string `+`, only CONCAT. Accepting it
 *  would compile in the simulator and fail to build on every target. */
export function isString(t: ScalarType): boolean {
  return t === 'STRING'
}

/**
 * The calendar types: DATE, TIME_OF_DAY (TOD) and DATE_AND_TIME (DT). Like TIME they are milliseconds, and
 * like TIME they are not numbers: they compare with their own kind only, and the arithmetic IEC defines
 * on them is its own table (a TOD plus a TIME is a TOD, a DT minus a DT is a TIME, and nothing else).
 *   - DATE: midnight UTC of the day, in ms since 1970-01-01 (always a whole number of days)
 *   - TOD:  ms since midnight, 0 up to (not including) 24 h
 *   - DT:   ms since 1970-01-01 00:00:00
 * No conversion to or from a number exists here: the reference compilers disagree on the unit
 * (MATIEC counts every one of them in seconds; STruC++ counts a DATE in days and a TOD or DT in
 * milliseconds), as measured, see docs/st-conformance.md.
 */
export function isCalendar(t: ScalarType): boolean {
  return t === 'DATE' || t === 'TOD' || t === 'DT'
}

/** One day, in the unit every calendar type and TIME carry. */
export const MS_PER_DAY = 86_400_000
/** The last instant a DATE or DT holds: 2106-02-07-06:28:15, the end of a 32-bit unsigned count of seconds
 *  since 1970. This engine's documented range, and the narrowest a target gives them (MATIEC's is wider). */
export const CALENDAR_MAX_MS = 4_294_967_295_000

/** Why a calendar value is outside what its type holds, or null when it fits. */
export function calendarRangeError(t: ScalarType, ms: number): string | null {
  if (Number.isNaN(ms)) return `${t} result is not a number`
  if (t === 'TOD') return ms >= 0 && ms < MS_PER_DAY ? null : `TIME_OF_DAY ${ms < 0 ? 'before midnight' : 'past midnight'}: a TOD holds 00:00:00 up to 24:00:00`
  const name = t === 'DATE' ? 'DATE' : 'DATE_AND_TIME'
  if (ms < 0) return `${name} before 1970-01-01, which a target's ${t} cannot hold`
  if (ms > CALENDAR_MAX_MS) return `${name} past 2106-02-07-06:28:15, which a target's ${t} cannot hold`
  return null
}

/** The result of calendar arithmetic, which faults the scan when it leaves its type's range (a TOD past
 *  midnight, a DATE before 1970). No target wraps it and none checks it (docs/st-conformance.md), so the
 *  fault is this engine's choice, as with an array bound: this is where the mistake is cheapest to find. */
export function calendarValue(t: ScalarType, ms: number): number {
  const why = calendarRangeError(t, ms)
  if (why !== null) throw new Error(why)
  return ms
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Seconds as a literal writes them: whole ones padded to two digits, a fraction in milliseconds after. */
function secondsText(msOfMinute: number): string {
  const whole = Math.floor(msOfMinute / 1000)
  const frac = msOfMinute - whole * 1000
  if (frac === 0) return pad2(whole)
  // three digits of milliseconds, and the digits below a millisecond only when there are some
  const digits = String(Number((frac / 1000).toFixed(9))).slice(2)
  return `${pad2(whole)}.${digits.padEnd(3, '0')}`
}

/** `D#2024-02-28`, `TOD#23:59:59.500`, `DT#2024-02-28-12:00:00`: the literal a calendar value is written
 *  as. Whole seconds are spelled as IEC 61131-3's literal forms (which MATIEC, the oracle, prints the same way); a
 *  fraction is in milliseconds, three places (MATIEC prints six). */
export function calendarToString(t: ScalarType, ms: number): string {
  if (t === 'TOD') {
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    return `TOD#${pad2(h)}:${pad2(m)}:${secondsText(ms % 60_000)}`
  }
  const day = Math.floor(ms / MS_PER_DAY)
  const d = new Date(day * MS_PER_DAY) // (a Date as a calendar only: the day came from the program)
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  if (t === 'DATE') return `D#${date}`
  return `DT#${date}-${calendarToString('TOD', ms - day * MS_PER_DAY).slice('TOD#'.length)}`
}

const DATE_SHAPE = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/
const TOD_SHAPE = /^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/
const DT_SHAPE = /^(\d{1,4})-(\d{1,2})-(\d{1,2})-(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/

/**
 * Read a calendar literal's body (what follows `D#`, `TOD#` or `DT#`) into milliseconds, or say why it is
 * not one: `2024-02-28`, `23:59:59.5`, `2024-02-28-12:00:00`. The date must exist (no 30 February), the
 * hour is 0-23, and the value must be one a target holds.
 */
export function parseCalendar(t: ScalarType, body: string): number | { error: string } {
  const m = (t === 'DATE' ? DATE_SHAPE : t === 'TOD' ? TOD_SHAPE : DT_SHAPE).exec(body)
  if (!m) {
    const example = t === 'DATE' ? 'a date such as D#2024-02-28' : t === 'TOD' ? 'a time of day such as TOD#23:59:59.5' : 'a date and time such as DT#2024-02-28-12:00:00'
    return { error: `expected ${example}` }
  }
  let ms = 0
  let at = 1
  if (t !== 'TOD') {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    at = 4
    const day = Date.UTC(y, mo - 1, d)
    const back = new Date(day)
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return { error: `${m[1]}-${m[2]}-${m[3]} is not a date` }
    ms = day
  }
  if (t !== 'DATE') {
    const [h, mi, sec] = [Number(m[at]), Number(m[at + 1]), Number(m[at + 2])]
    if (h > 23) return { error: `hour ${h} is not 0 to 23` }
    if (mi > 59) return { error: `minute ${mi} is not 0 to 59` }
    if (sec >= 60) return { error: `second ${m[at + 2]} is not below 60` }
    ms += h * 3_600_000 + mi * 60_000 + Math.round(sec * 1_000_000) / 1000
  }
  const why = calendarRangeError(t, ms)
  return why === null ? ms : { error: why }
}

/** STRING_TO_DATE / _TOD / _DT: the literal, with or without its prefix (`'D#2024-02-28'` or `'2024-02-28'`).
 *  Text that is not one is 0 (1970-01-01, midnight), the way STRING_TO_INT of text that is no number is 0. */
export function stringToCalendar(t: ScalarType, s: string): number {
  const body = s.trim().replace(/^(?:D|DATE|TOD|TIME_OF_DAY|DT|DATE_AND_TIME)#/i, '')
  const ms = parseCalendar(t, body)
  return typeof ms === 'number' ? ms : 0
}

/** The 32-bit integer types. Their product goes through Math.imul: a double product past 2^53 has lost the low bits
 *  the wrap keeps (16#FFFFFFFF * 16#FFFFFFFF is 1 as a UDINT, 0 as a wrapped double). */
export function isInt32(t: ScalarType): boolean {
  return t === 'DINT' || t === 'UDINT' || t === 'DWORD'
}

/** Coerce a number into its IEC type: integers wrap to their bit width (two's complement),
 *  REAL rounds to single precision. LREAL / BOOL pass through. */
export function wrap(t: ScalarType, x: number): number {
  switch (t) {
    case 'SINT': return (x << 24) >> 24 // i8
    case 'INT': return (x << 16) >> 16 // i16
    case 'DINT': return x | 0 // i32
    case 'USINT': case 'BYTE': return x & 0xff // u8
    case 'UINT': case 'WORD': return x & 0xffff // u16
    case 'UDINT': case 'DWORD': return x >>> 0 // u32
    case 'REAL': return Math.fround(x) // f32 - IEC REAL is single precision
    default: return x // LREAL (f64) / BOOL
  }
}

/** Widening rank for mixed-type expressions. The unsigned/bit-string types sit a half
 *  step above their signed same-width partner so a signed/unsigned mix resolves the same
 *  way regardless of operand order - to the unsigned type, keeping mask arithmetic like
 *  `w AND 255` in bit-string semantics. (IEC doesn't define the mix; this is our rule.) */
const RANK: Record<ScalarType, number> = {
  BOOL: 0,
  SINT: 1, USINT: 1.25, BYTE: 1.5,
  INT: 2, UINT: 2.25, WORD: 2.5,
  DINT: 3, UDINT: 3.25, DWORD: 3.5,
  REAL: 4, LREAL: 5,
  // TIME, the calendar types and STRING never participate in a widening mix - the checker
  // rejects those operand pairs before widen() is reached. Present only so the table stays total.
  TIME: 6,
  DATE: 6.25, TOD: 6.5, DT: 6.75,
  STRING: 7,
}

/** The wider of two scalar types - the result type of a mixed binary expression. */
export function widen(a: ScalarType, b: ScalarType): ScalarType {
  return RANK[a] >= RANK[b] ? a : b
}

/** IEC integer division truncates toward zero (-7 / 2 = -3). Integer division by zero
 *  faults the scan. Controllers disagree here (some log a fault and run on, S7-1500's
 *  MOD returns 0), so stopping is this engine's choice: docs/st-conformance.md, divergence 4.
 *  (REAL division stays IEEE - ±Infinity and carry on - matching PLC float hardware, which
 *  flags but does not fault.) */
export function idiv(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero') // this engine's choice is to fault the scan
  return Math.trunc(a / b)
}

/** IEC MOD: result takes the sign of the dividend. MOD by zero faults like division. */
export function imod(a: number, b: number): number {
  if (b === 0) throw new Error('MOD by zero')
  return a % b
}

/** Width in bits of an integer/bit-string type (shifts and rotates work on this window). */
function bitWidth(t: ScalarType): number {
  if (t === 'SINT' || t === 'USINT' || t === 'BYTE') return 8
  if (t === 'INT' || t === 'UINT' || t === 'WORD') return 16
  return 32
}

/** The unsigned value of `x`'s low `width(t)` bits - the bit string a shift/rotate sees. */
function uval(t: ScalarType, x: number): number {
  switch (t) {
    case 'SINT': case 'USINT': case 'BYTE': return x & 0xff
    case 'INT': case 'UINT': case 'WORD': return x & 0xffff
    default: return x >>> 0 // DINT / UDINT / DWORD (32-bit)
  }
}

/** Round to the nearest integer, ties to even - the IEC rule for REAL->integer conversion. */
export function roundEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d < 0.5) return f
  if (d > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

/** SHL - logical left shift of `x` by `n` bits within its type's width (zero-filled). */
export function shl(t: ScalarType, x: number, n: number): number {
  n = Math.trunc(n)
  if (n <= 0) return wrap(t, x)
  const w = bitWidth(t)
  if (n >= w) return wrap(t, 0)
  return wrap(t, uval(t, x) << n)
}

/** SHR - logical right shift of `x` by `n` bits within its type's width (zero-filled). */
export function shr(t: ScalarType, x: number, n: number): number {
  n = Math.trunc(n)
  if (n <= 0) return wrap(t, x)
  const w = bitWidth(t)
  if (n >= w) return wrap(t, 0)
  return wrap(t, uval(t, x) >>> n)
}

/** ROL - rotate `x` left by `n` bits within its type's width (bits wrap around). */
export function rol(t: ScalarType, x: number, n: number): number {
  const w = bitWidth(t)
  n = ((Math.trunc(n) % w) + w) % w
  if (n === 0) return wrap(t, x)
  const u = uval(t, x)
  const rotated = w === 32 ? ((u << n) | (u >>> (w - n))) >>> 0 : ((u << n) | (u >>> (w - n))) & ((1 << w) - 1)
  return wrap(t, rotated)
}

/** ROR - rotate `x` right by `n` bits within its type's width (bits wrap around). */
export function ror(t: ScalarType, x: number, n: number): number {
  const w = bitWidth(t)
  n = ((Math.trunc(n) % w) + w) % w
  return n === 0 ? wrap(t, x) : rol(t, x, w - n)
}

// ---- BCD ----
//
// Binary-coded decimal: each 4-bit nibble holds one decimal digit, so 0x1234 reads as 1234.
// BCD is an encoding, not an IEC data type - it travels in a BYTE/WORD/DWORD, which is why
// `BCD_TO_INT` cannot go through the generic `<src>_TO_<dst>` machinery (there is no `BCD`
// scalar to name). Thumbwheel switches, older weigh heads and most vendor "digital input,
// BCD" cards still present data this way, which is why Annex F's own examples use it.

/** Decode packed BCD into its decimal value. A nibble above 9 is not BCD at all; real
 *  controllers differ (some fault, some carry on), so this takes the lenient reading and
 *  treats the digit as its raw value, which keeps a mis-wired input from killing the scan. */
export function bcdToInt(x: number): number {
  let out = 0
  let scale = 1
  let u = x >>> 0
  while (u > 0) {
    out += (u & 0xf) * scale
    scale *= 10
    u >>>= 4
  }
  return out
}

/** Encode a decimal value as packed BCD, wrapped to `t`'s width. A negative input has no
 *  BCD representation (there is no sign nibble in the standard's form), so it encodes 0. */
export function intToBcd(t: ScalarType, x: number): number {
  let v = Math.trunc(x)
  if (v <= 0) return wrap(t, 0)
  let out = 0
  let shift = 0
  while (v > 0 && shift < 32) {
    out |= (v % 10) << shift
    v = Math.floor(v / 10)
    shift += 4
  }
  return wrap(t, out >>> 0)
}

// ---- STRING ----
//
// A STRING is a JS string. The declared capacity is enforced by truncation at the store
// (`strLimit`), not by the type - see types.ts. Positions are 1-based, as everywhere in
// IEC's string library, and an out-of-range length/position clamps rather than faulting:
// the standard calls it an error, but this engine clamps, since a controller that faulted
// its scan over a short string would not survive contact with a plant floor. Recorded as a
// divergence in docs/st-conformance.md.

/** Cut a string to a declared `STRING[n]` capacity. Every target truncates silently. */
export function strLimit(s: string, maxLen: number | undefined): string {
  return maxLen !== undefined && s.length > maxLen ? s.slice(0, maxLen) : s
}

/** Clamp a 1-based position argument into `[0, len]` and return a 0-based offset. */
function at(p: number, len: number): number {
  return Math.max(0, Math.min(len, Math.trunc(p) - 1))
}
/** Clamp a length argument into `[0, len]`. */
function span(l: number, len: number): number {
  return Math.max(0, Math.min(len, Math.trunc(l)))
}

export function strLeft(s: string, l: number): string {
  return s.slice(0, span(l, s.length))
}
export function strRight(s: string, l: number): string {
  const n = span(l, s.length)
  return n === 0 ? '' : s.slice(s.length - n)
}
/** MID(IN, L, P): L characters starting at 1-based position P. */
export function strMid(s: string, l: number, p: number): string {
  const from = at(p, s.length)
  return s.slice(from, from + span(l, s.length))
}
/** INSERT(IN1, IN2, P): IN2 inserted into IN1 after 1-based position P (P=0 prepends). */
export function strInsert(a: string, b: string, p: number): string {
  const cut = Math.max(0, Math.min(a.length, Math.trunc(p)))
  return a.slice(0, cut) + b + a.slice(cut)
}
/** DELETE(IN, L, P): remove L characters starting at 1-based position P. */
export function strDelete(s: string, l: number, p: number): string {
  const from = at(p, s.length)
  return s.slice(0, from) + s.slice(from + span(l, s.length))
}
/** REPLACE(IN1, IN2, L, P): replace L characters of IN1 at 1-based P with all of IN2. */
export function strReplace(a: string, b: string, l: number, p: number): string {
  const from = at(p, a.length)
  return a.slice(0, from) + b + a.slice(from + span(l, a.length))
}
/** FIND(IN1, IN2): 1-based position of the first IN2 inside IN1, or 0 when absent. */
export function strFind(a: string, b: string): number {
  return a.indexOf(b) + 1
}

/** Format a duration (ms) as an IEC duration literal - `T#1s500ms`. */
export function timeToString(ms: number): string {
  if (!Number.isFinite(ms)) return 'T#0ms'
  const sign = ms < 0 ? '-' : ''
  let rest = Math.abs(ms)
  const parts: string[] = []
  const units: [number, string][] = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm'], [1000, 's']]
  for (const [size, suffix] of units) {
    const n = Math.floor(rest / size)
    if (n > 0) {
      parts.push(`${n}${suffix}`)
      rest -= n * size
    }
  }
  // a sub-millisecond remainder survives as a fractional ms component rather than
  // vanishing, because this engine's ET is not floored to whole ms (a known divergence)
  if (rest > 0 || parts.length === 0) parts.push(`${Number(rest.toFixed(6))}ms`)
  return `T#${sign}${parts.join('')}`
}

/** Parse an IEC duration literal (`T#1m30s`, `T#-500ms`, or a bare `1s`) to milliseconds. */
export function stringToTime(s: string): number {
  const text = s.trim()
  const neg = /^-/.test(text) || /#\s*-/.test(text)
  let total = 0
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s|d)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const v = Number(m[1] ?? 0)
    switch ((m[2] ?? '').toLowerCase()) {
      case 'ms': total += v; break
      case 's': total += v * 1000; break
      case 'm': total += v * 60_000; break
      case 'h': total += v * 3_600_000; break
      case 'd': total += v * 86_400_000; break
    }
  }
  return neg ? -total : total
}

/** Format a number for `<num>_TO_STRING`. Integers print bare; a REAL prints its shortest
 *  round-trip form. IEC leaves float formatting implementation-defined, so this is a
 *  documented divergence rather than a portable guarantee. */
function numToString(src: ScalarType, n: number): string {
  if (isTime(src)) return timeToString(n)
  if (Number.isNaN(n)) return 'nan'
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf'
  return String(n)
}

/** Parse the leading numeric prefix of a string, C `strtod`-style.
 *  Nothing parseable yields 0 rather than a fault. */
function stringToNum(dst: ScalarType, s: string): number {
  if (isTime(dst)) return stringToTime(s)
  const text = s.trim()
  const based = text.match(/^([+-]?)(\d+)#([0-9a-fA-F_]+)$/)
  if (based) {
    const base = Number(based[2])
    if (base === 2 || base === 8 || base === 16) {
      const v = parseInt((based[3] ?? '').replace(/_/g, ''), base)
      if (Number.isNaN(v)) return 0
      return based[1] === '-' ? -v : v
    }
  }
  const m = text.replace(/_/g, '').match(/^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/)
  if (!m) return 0
  const v = Number(m[0])
  return Number.isNaN(v) ? 0 : v
}

/** IEC type conversion `<src>_TO_<dst>`: REAL->int rounds (ties to even); int->int reinterprets
 *  the low bits (two's-complement wrap); anything ->BOOL is `<> 0`. STRING converts by
 *  formatting and parsing (`INT_TO_STRING(42)` = '42', `STRING_TO_INT('42x')` = 42). */
export function conv(src: ScalarType, dst: ScalarType, v: TagValue): TagValue {
  if (dst === 'STRING') {
    if (typeof v === 'string') return v
    if (src === 'BOOL' || typeof v === 'boolean') return bool(v) ? 'TRUE' : 'FALSE'
    if (isCalendar(src)) return calendarToString(src, v)
    return numToString(src, v)
  }
  // the calendar conversions, which are the only ones the checker admits into a calendar type: a
  // STRING read as its literal, and a DT taken apart into its DATE and its TIME_OF_DAY
  if (isCalendar(dst)) {
    if (typeof v === 'string') return stringToCalendar(dst, v)
    const n = num(v)
    if (src === 'DT' && dst === 'DATE') return Math.floor(n / MS_PER_DAY) * MS_PER_DAY
    if (src === 'DT' && dst === 'TOD') return n - Math.floor(n / MS_PER_DAY) * MS_PER_DAY
    return n
  }
  if (typeof v === 'string') {
    // STRING_TO_BOOL goes by name, not by "non-empty": 'FALSE' is false, like every target
    if (dst === 'BOOL') return v.trim().toUpperCase() === 'TRUE' || stringToNum('DINT', v) !== 0
    const parsed = stringToNum(dst, v)
    return isReal(dst) || isTime(dst) ? wrap(dst, parsed) : wrap(dst, roundEven(parsed))
  }
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : v
  if (dst === 'BOOL') return n !== 0
  if (isReal(dst)) return wrap(dst, n) // REAL narrows to f32 here, LREAL passes through
  return wrap(dst, isReal(src) ? roundEven(n) : n)
}

/** The numeric view of a value. A STRING never reaches here in a checked program - the
 *  checker rejects string operands everywhere arithmetic is possible - so the 0 is a
 *  total-function fallback, and no program should rely on it as a coercion. */
export function num(v: TagValue): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? 0 : v ? 1 : 0
}

/** A store into a subrange place, checked the way the interpreter checks it (checkRange, applied
 *  after the width coercion, which is the only call site there is). MATIEC does not
 *  check a subrange, so this is a deliberate fault, not conformance - see docs/st-conformance.md. */
export function inRange(v: number, name: string, lo: number, hi: number): number {
  if (v < lo || v > hi) throw new Error(`${v} is outside ${name} (${lo}..${hi})`)
  return v
}

/** Safety cap: a runaway WHILE/REPEAT or huge FOR throws instead of freezing the tab. Lives here,
 *  not in the interpreter, because the emitted module has to count to the same number - a JS
 *  `while` with no guard does not fault where the interpreter does, it hangs. */
export const MAX_LOOP_ITERATIONS = 1_000_000

/**
 * How deep METHOD calls may nest: a method may call itself (directly, or through an interface), and one that never
 * stops faults the scan here, as it overflows a real controller's stack. Every engine counts to this same number, and
 * the typed one sizes its method stack by it. 64 frames is deeper than any non-runaway use found in vendor libraries.
 */
export const MAX_CALL_DEPTH = 64
export const CALL_DEPTH_MESSAGE = `method calls nested deeper than ${MAX_CALL_DEPTH}: a method that calls itself without end?`

/** The fault for dereferencing a REF_TO that is NULL, or calling through an interface that refers to no instance: the
 *  scan stops, as a controller stops on an access through nothing. Word for word the same in every engine. */
export function unboundMessage(kind: 'ref' | 'iface'): string {
  return kind === 'ref' ? 'a REF_TO that is NULL was dereferenced (give it a reference with REF() first)' : 'a method was called through an interface that refers to no instance (assign it one first)'
}

/** What a REF_TO holds in the emitted module: the record (or array) holding the place it refers to, and the key there
 *  - the interpreter's RefCell. 0 is NULL. */
export interface RefCellJs {
  o: Record<string | number, unknown>
  k: string | number
}
/** The emitted module's read through a REF_TO, r^. */
export function refGet(c: RefCellJs | 0): unknown {
  if (c === 0) throw new Error(unboundMessage('ref'))
  return c.o[c.k]
}
/** The emitted module's write through a REF_TO, r^ := v. */
export function refSet(c: RefCellJs | 0, v: unknown): void {
  if (c === 0) throw new Error(unboundMessage('ref'))
  c.o[c.k] = v
}
/** An array element as a place a REF_TO refers to, REF(a[i]), its subscript checked as a read's is. */
export function refElem(arr: unknown[], i: number, lo: number, hi: number): RefCellJs {
  if (i < lo || i > hi) throw new Error(`array index ${i} out of bounds [${lo}..${hi}]`)
  return { o: arr as unknown as Record<number, unknown>, k: i - lo }
}
/** The instance an interface refers to, for a method called through it in the emitted module. */
export function itfGet<T>(x: T | 0): T {
  if (x === 0) throw new Error(unboundMessage('iface'))
  return x
}

/** One iteration of a loop in the emitted module. `kind` is FOR / WHILE / REPEAT, so the message
 *  matches the interpreter's word for word. */
export function loopGuard(n: number, kind: string): void {
  if (n > MAX_LOOP_ITERATIONS) throw new Error(`${kind} loop exceeded its iteration limit`)
}

/** A FOR loop's BY, checked at entry the way the interpreter checks it: a zero step never advances,
 *  so the emitted loop would spin forever on `from >= to` and silently skip otherwise. */
export function forStep(by: number): number {
  if (by === 0) throw new Error('FOR loop step is zero')
  return by
}

/** Read one array element, bounds-checked. The emitted module cannot write `a[i - lo]` directly:
 *  JS would hand back `undefined` for an index the interpreter faults on, which is a silent
 *  disagreement between the two backends. Mirrors interpreter.ts evalExpr 'index', including its
 *  guard for a container that is not an array (a checked program never has one). */
export function elemAt(arr: unknown, i: number, lo: number, hi: number): unknown {
  if (!Array.isArray(arr)) return 0
  if (i < lo || i > hi) throw new Error(`array index ${i} out of bounds [${lo}..${hi}]`)
  return arr[i - lo] ?? 0
}

/** Write one array element, bounds-checked - the store half of at(). JS would grow the array on an
 *  out-of-range index; the interpreter faults (assignPlace), so this does too. */
export function elemSet(arr: unknown, i: number, lo: number, hi: number, v: unknown): void {
  if (!Array.isArray(arr)) return
  if (i < lo || i > hi) throw new Error(`array index ${i} out of bounds [${lo}..${hi}]`)
  arr[i - lo] = v
}

/** BOOL AND / OR for the emitted module. These are calls, not operators, so both operands are
 *  evaluated before they combine - JS `&&` / `||` would stop at a decided operand, and the
 *  interpreter does not (see docs/st-conformance.md). XOR needs both sides anyway,
 *  so the emitter still writes it as an operator. */
export function andB(l: boolean, r: boolean): boolean {
  return l && r
}

export function orB(l: boolean, r: boolean): boolean {
  return l || r
}

export function bool(v: TagValue): boolean {
  return typeof v === 'boolean' ? v : typeof v === 'string' ? v.length > 0 : v !== 0
}

/** The string view of a value, for the string library's arguments (checker-guaranteed). */
export function str(v: TagValue): string {
  return typeof v === 'string' ? v : String(v)
}

// ---- standard function blocks (the stateful pieces that make it feel like a PLC) ----

// A user FUNCTION_BLOCK can take a STRING input, so this is TagValue-wide. The builtin
// blocks below read their inputs through num()/bool(), which are total over TagValue.
export type FbArgs = Record<string, TagValue | undefined>

/** A stateful block. `now` is the controller's clock, in whole nanoseconds, at the scan making
 *  the call: the timers read it, and a user block passes it on to the blocks inside it. */
export interface Fb {
  call(args: FbArgs, now: number): void
}

/**
 * How far one scan of `dt` seconds moves the controller's clock, in whole nanoseconds. The
 * clock is kept in integers so a timer's elapsed time is an exact difference, however long the
 * controller has run: `now - start` in floating-point seconds would lose the low digits to the
 * size of `now`, and a timer could miss PT by a rounding error. Nanoseconds are MATIEC's own
 * `__CURRENT_TIME` resolution, and its oracle harness steps that clock with this same rounding
 * (oracleShape.ts `advance`). A zero or negative dt leaves the clock where it is.
 */
export function nsOf(dt: number): number {
  return dt > 0 ? Math.round(dt * 1e9) : 0
}

// Every standard block keeps its inputs between calls, as a user block's VAR_INPUT does: an input a call leaves out
// has the value the last call gave it, and FALSE, 0 or T#0s before any call gave one. A block that already keeps an
// input as an edge's previous value (a trigger's CLK, a counter's CU) uses that. typed/blocks.ts does the same.

// A timer reads the clock. PT and ET are TIME, in milliseconds; each timer notes the
// controller's clock on the call that starts it and measures `now - start` on every call
// after. So a timer that is not called on some scans (inside an IF, behind EN on a rung)
// still measures the time that passed, which is what IEC's own function-block bodies do
// with `CURRENT_TIME`. These blocks once
// added each call's `dt` instead, so such a timer measured only the scans that reached it.
//
// ET is not truncated to whole milliseconds. The clock counts nanoseconds of
// simulation time and a sim step is rarely a whole millisecond (60 Hz is 16.67 ms), so ET
// reports the time as it passed rather than rounded to a millisecond clock's tick. Recorded in
// docs/st-conformance.md as a divergence from TIME's integral resolution on real hardware.

/** Milliseconds from clock reading `start` to `now`. Never negative: one instance called from
 *  two tasks reads two clocks, and a task that has shed scans runs behind the other. */
function sinceMs(now: number, start: number): number {
  return Math.max(0, now - start) / 1e6
}

/**
 * TON - on-delay timer. Q goes true once IN has been true for PT milliseconds.
 *
 * The scan that sees the edge elapses nothing. IEC's own function-block body records
 * `START_TIME` on the scan where `IN` is first sampled true and measures
 * `CURRENT_TIME - START_TIME` only from the next scan on, which is all a sampled runtime
 * can know. Crediting that scan's whole `dt` would make every timer reach PT one scan
 * early; the MATIEC oracle (`npm run st-oracle`) checks it.
 */
class Ton implements Fb {
  Q = false
  ET = 0
  /** the rising edge has been seen, at clock reading `#start` */
  #running = false
  #start = 0
  #in = false
  #pt = 0
  call(a: FbArgs, now: number): void {
    if (a.IN !== undefined) this.#in = bool(a.IN)
    if (a.PT !== undefined) this.#pt = num(a.PT)
    const pt = this.#pt
    if (!this.#in) {
      this.ET = 0
      this.Q = false
      this.#running = false
      return
    }
    if (!this.#running) {
      this.#running = true // the clock starts here, with nothing elapsed yet
      this.#start = now
      this.ET = 0
      this.Q = false
      return
    }
    this.ET = Math.min(pt, sinceMs(now, this.#start))
    this.Q = this.ET >= pt
  }
}

/** TOF - off-delay timer. Q goes true with IN, stays true for PT after IN falls.
 *  Q stays false from cold start until IN has actually been true (no spurious
 *  startup pulse), so the off-delay only times out a latch IN set. */
class Tof implements Fb {
  Q = false
  ET = 0
  /** the falling edge has been seen, at clock reading `#start`; like TON, that scan elapses nothing */
  #timing = false
  #start = 0
  #in = false
  #pt = 0
  call(a: FbArgs, now: number): void {
    if (a.IN !== undefined) this.#in = bool(a.IN)
    if (a.PT !== undefined) this.#pt = num(a.PT)
    const pt = this.#pt
    if (this.#in) {
      this.Q = true
      this.ET = 0
      this.#timing = false
      return
    }
    if (!this.Q) return // IN was never true, or the off-delay has already expired
    if (!this.#timing) {
      this.#timing = true // the falling edge: hold Q and start from zero
      this.#start = now
      this.ET = 0
      return
    }
    this.ET = Math.min(pt, sinceMs(now, this.#start))
    this.Q = this.ET < pt
  }
}

/** TP - pulse timer. A rising edge on IN starts a fixed pulse: Q is true for PT milliseconds
 *  (ET ramps 0->PT), and IN changes during the pulse are ignored until it completes. */
class Tp implements Fb {
  Q = false
  ET = 0
  /** IN as the last call left it, which is also the input a call that leaves IN out keeps */
  #prev = false
  #timing = false
  #start = 0
  #pt = 0
  call(a: FbArgs, now: number): void {
    if (a.PT !== undefined) this.#pt = num(a.PT)
    const pt = this.#pt
    const inn = a.IN === undefined ? this.#prev : bool(a.IN)
    const rising = inn && !this.#prev
    this.#prev = inn
    if (!this.#timing && rising) {
      // the pulse starts on the edge scan: Q goes high with nothing elapsed yet, the same
      // place IEC's body sets START_TIME
      this.#timing = true
      this.#start = now
      this.ET = 0
      this.Q = true
      return
    }
    if (this.#timing) {
      this.ET = Math.min(pt, sinceMs(now, this.#start))
      // and Q falls on the scan the pulse completes, where IEC sets Q := FALSE and ET := PT
      // together, not the scan after. Start and end must move together: a pulse one scan
      // late at both ends has the right width and passes the oracle for the wrong reason.
      this.Q = this.ET < pt
      if (this.ET >= pt) this.#timing = false
      return
    }
    this.Q = false
    if (!inn) this.ET = 0 // pulse finished and input released: clear elapsed
  }
}

/** R_TRIG - rising-edge one-shot. Q is true for the single scan after CLK 0->1. */
class RTrig implements Fb {
  Q = false
  #prev = false
  call(a: FbArgs): void {
    const clk = a.CLK === undefined ? this.#prev : bool(a.CLK) // left out, CLK keeps its last value
    this.Q = clk && !this.#prev
    this.#prev = clk
  }
}

/** F_TRIG - falling-edge one-shot. `prev` starts false (not true, as a literal reading
 *  of the IEC body would have it) so a CLK that is false at cold start doesn't fire a
 *  spurious pulse on the first scan. */
class FTrig implements Fb {
  Q = false
  #prev = false
  call(a: FbArgs): void {
    const clk = a.CLK === undefined ? this.#prev : bool(a.CLK) // left out, CLK keeps its last value
    this.Q = !clk && this.#prev
    this.#prev = clk
  }
}

/** CTU - count up on rising CU (clamped at the INT max, like CTUD); Q when CV >= PV;
 *  R (alias RESET) zeroes CV. CV and PV are INTs, so PV is read at INT width. */
class Ctu implements Fb {
  CV = 0
  Q = false
  /** CU as the last call left it, which is also the input a call that leaves CU out keeps */
  #prev = false
  #r = false
  #pv = 0
  call(a: FbArgs): void {
    const cu = a.CU === undefined ? this.#prev : bool(a.CU)
    const r = a.RESET ?? a.R
    if (r !== undefined) this.#r = bool(r)
    if (a.PV !== undefined) this.#pv = wrap('INT', num(a.PV))
    if (this.#r) this.CV = 0
    else if (cu && !this.#prev && this.CV < 32767) this.CV++
    this.#prev = cu
    this.Q = this.CV >= this.#pv
  }
}

/** CTD - load PV on LD, count down on rising CD (not below 0); Q when CV <= 0.
 *  CV and PV are INTs, so PV is read at INT width. */
class Ctd implements Fb {
  CV = 0
  Q = false
  /** CD as the last call left it, which is also the input a call that leaves CD out keeps */
  #prev = false
  #ld = false
  #pv = 0
  call(a: FbArgs): void {
    const cd = a.CD === undefined ? this.#prev : bool(a.CD)
    if (a.LD !== undefined) this.#ld = bool(a.LD)
    if (a.PV !== undefined) this.#pv = wrap('INT', num(a.PV))
    if (this.#ld) this.CV = this.#pv
    else if (cd && !this.#prev && this.CV > 0) this.CV--
    this.#prev = cd
    this.Q = this.CV <= 0
  }
}

/** CTUD - up/down counter. Rising CU counts up, rising CD counts down (clamped to the INT
 *  range); R (alias RESET) zeroes CV, LD loads PV. QU = CV >= PV, QD = CV <= 0. */
class Ctud implements Fb {
  CV = 0
  QU = false
  QD = false
  /** CU and CD as the last call left them, which are also the inputs a call that leaves them out keeps */
  #pcu = false
  #pcd = false
  #r = false
  #ld = false
  #pv = 0
  call(a: FbArgs): void {
    const cu = a.CU === undefined ? this.#pcu : bool(a.CU)
    const cd = a.CD === undefined ? this.#pcd : bool(a.CD)
    const r = a.RESET ?? a.R
    if (r !== undefined) this.#r = bool(r)
    if (a.LD !== undefined) this.#ld = bool(a.LD)
    if (a.PV !== undefined) this.#pv = wrap('INT', num(a.PV))
    const pv = this.#pv
    if (this.#r) this.CV = 0
    else if (this.#ld) this.CV = pv
    else {
      if (cu && !this.#pcu && this.CV < 32767) this.CV++
      if (cd && !this.#pcd && this.CV > -32768) this.CV--
    }
    this.#pcu = cu
    this.#pcd = cd
    this.QU = this.CV >= pv
    this.QD = this.CV <= 0
  }
}

/** The motion kernel's inputs, in declaration (= positional) order: the command, its numbers, and the axis's
 *  software limits, read on every call (motionChannel.ts). */
const AXIS_KERNEL_INPUTS = ['CMD', 'P', 'V', 'A', 'D', 'BUF', 'LIMITS', 'LIMITPOS', 'LIMITNEG', 'LIMITDEC'] as const
/** Its outputs and their types, in the order the walker's object lists them (= the typed record's: layout.ts). */
export const AXIS_KERNEL_OUTPUTS: Readonly<Record<string, ScalarType>> = {
  CMDID: 'DINT', CURCMD: 'DINT', DONECMD: 'DINT', QLO: 'DINT', QHI: 'DINT', STATE: 'INT', X: 'LREAL', VEL: 'LREAL', ERR: 'INT', POWERED: 'BOOL', HOMED: 'BOOL',
}

/** Call-site input names each builtin FB accepts, so the checker can reject typos
 *  (`INN := ...` would otherwise be silently ignored at runtime). `R` is the IEC
 *  spelling of the counter reset; `RESET` is kept as an alias. */
export const FB_INPUTS: Record<FbType, readonly string[]> = {
  AXIS_KERNEL: AXIS_KERNEL_INPUTS,
  TON: ['IN', 'PT'],
  TOF: ['IN', 'PT'],
  TP: ['IN', 'PT'],
  R_TRIG: ['CLK'],
  F_TRIG: ['CLK'],
  CTU: ['CU', 'R', 'RESET', 'PV'],
  CTD: ['CD', 'LD', 'PV'],
  CTUD: ['CU', 'CD', 'R', 'RESET', 'LD', 'PV'],
  // SR takes S1/R and RS takes S/R1 - IEC's own spellings (Table 34), and the ones the
  // standard's Annex F examples use, so a file written against the standard loads. The
  // longer SET1/RESET/SET/RESET1 spellings this engine invented stay as aliases, the same
  // way `RESET` is kept beside the counters' `R`: renaming them outright would break any
  // program already written here, which is the same "will not load" failure pointed inward.
  SR: ['S1', 'R', 'SET1', 'RESET'],
  RS: ['S', 'R1', 'SET', 'RESET1'],
}

/** Builtin FB parameters in declaration order, which is the order a non-formal call
 *  (`CTU_1(CU, R, PV)`) fills them in. Separate from {@link FB_INPUTS}: that one
 *  is the set of names accepted, aliases included, so it cannot double as an order - a
 *  positional argument must never land on `RESET` just because `R` has an alias. */
export const FB_POSITIONAL: Record<FbType, readonly string[]> = {
  AXIS_KERNEL: AXIS_KERNEL_INPUTS,
  TON: ['IN', 'PT'],
  TOF: ['IN', 'PT'],
  TP: ['IN', 'PT'],
  R_TRIG: ['CLK'],
  F_TRIG: ['CLK'],
  CTU: ['CU', 'R', 'PV'],
  CTD: ['CD', 'LD', 'PV'],
  CTUD: ['CU', 'CD', 'R', 'LD', 'PV'],
  SR: ['S1', 'R'],
  RS: ['S', 'R1'],
}

/** The declared TYPE of each builtin FB input. Without this a call site could pass
 *  anything - `PT := 5` would quietly mean 5 milliseconds where the author meant seconds,
 *  and on a real compiler it would not build at all. */
export const FB_INPUT_TYPES: Record<FbType, Readonly<Record<string, ScalarType>>> = {
  AXIS_KERNEL: { CMD: 'INT', P: 'LREAL', V: 'LREAL', A: 'LREAL', D: 'LREAL', BUF: 'BOOL', LIMITS: 'BOOL', LIMITPOS: 'LREAL', LIMITNEG: 'LREAL', LIMITDEC: 'LREAL' },
  TON: { IN: 'BOOL', PT: 'TIME' },
  TOF: { IN: 'BOOL', PT: 'TIME' },
  TP: { IN: 'BOOL', PT: 'TIME' },
  R_TRIG: { CLK: 'BOOL' },
  F_TRIG: { CLK: 'BOOL' },
  CTU: { CU: 'BOOL', R: 'BOOL', RESET: 'BOOL', PV: 'INT' },
  CTD: { CD: 'BOOL', LD: 'BOOL', PV: 'INT' },
  CTUD: { CU: 'BOOL', CD: 'BOOL', R: 'BOOL', RESET: 'BOOL', LD: 'BOOL', PV: 'INT' },
  SR: { S1: 'BOOL', R: 'BOOL', SET1: 'BOOL', RESET: 'BOOL' },
  RS: { S: 'BOOL', R1: 'BOOL', SET: 'BOOL', RESET1: 'BOOL' },
}

/** AXIS_KERNEL: one servo axis (plc/motionChannel.ts). Its plan lives in the channel, as a timer's start reading lives
 *  in a private field; the outputs are the axis's state after this call. */
class AxisKernel implements Fb {
  CMDID = 0
  CURCMD = 0
  DONECMD = 0
  QLO = 0
  QHI = 0
  STATE = 0
  X = 0
  VEL = 0
  ERR = 0
  POWERED = false
  HOMED = false
  #channel = new MotionChannel()
  #out: MotionOutputs = { cmdId: 0, curCmd: 0, doneCmd: 0, state: 0, x: 0, v: 0, error: 0, qLo: 0, qHi: -1, powered: false, homed: false }
  call(a: FbArgs, now: number): void {
    const o = this.#out
    this.#channel.call(
      { cmd: num(a.CMD ?? 0), p: num(a.P ?? 0), v: num(a.V ?? 0), a: num(a.A ?? 0), d: num(a.D ?? 0), buffered: bool(a.BUF ?? false), limits: bool(a.LIMITS ?? false), limitPos: num(a.LIMITPOS ?? 0), limitNeg: num(a.LIMITNEG ?? 0), limitDecel: num(a.LIMITDEC ?? 0) },
      now,
      o,
    )
    this.CMDID = o.cmdId
    this.CURCMD = o.curCmd
    this.DONECMD = o.doneCmd
    this.QLO = o.qLo
    this.QHI = o.qHi
    this.STATE = o.state
    this.X = o.x
    this.VEL = o.v
    this.ERR = o.error
    this.POWERED = o.powered
    this.HOMED = o.homed
  }
}

/** SR - set-dominant bistable latch. With S1 and R both true, S1 wins.
 *  `SET1`/`RESET` are accepted as aliases of `S1`/`R` (see FB_INPUTS). */
class Sr implements Fb {
  Q1 = false
  #s1 = false
  #r = false
  call(a: FbArgs): void {
    const r = a.R ?? a.RESET
    const s1 = a.S1 ?? a.SET1
    if (r !== undefined) this.#r = bool(r)
    if (s1 !== undefined) this.#s1 = bool(s1)
    if (this.#r) this.Q1 = false
    if (this.#s1) this.Q1 = true // set is dominant, so it is applied last
  }
}

/** RS - reset-dominant bistable latch. With S and R1 both true, R1 wins.
 *  `SET`/`RESET1` are accepted as aliases of `S`/`R1` (see FB_INPUTS). */
class Rs implements Fb {
  Q1 = false
  #s = false
  #r1 = false
  call(a: FbArgs): void {
    const s = a.S ?? a.SET
    const r1 = a.R1 ?? a.RESET1
    if (s !== undefined) this.#s = bool(s)
    if (r1 !== undefined) this.#r1 = bool(r1)
    if (this.#s) this.Q1 = true
    if (this.#r1) this.Q1 = false // reset is dominant, so it is applied last
  }
}

export function makeFb(type: FbType): Fb {
  switch (type) {
    case 'AXIS_KERNEL': return new AxisKernel()
    case 'SR': return new Sr()
    case 'RS': return new Rs()
    case 'TON': return new Ton()
    case 'TOF': return new Tof()
    case 'TP': return new Tp()
    case 'R_TRIG': return new RTrig()
    case 'F_TRIG': return new FTrig()
    case 'CTU': return new Ctu()
    case 'CTD': return new Ctd()
    case 'CTUD': return new Ctud()
  }
}

/** Type of a function-block output member, or null if the FB has no such output. */
export function fbMemberType(fb: FbType, member: string): ScalarType | null {
  if (fb === 'AXIS_KERNEL') return AXIS_KERNEL_OUTPUTS[member] ?? null
  if (member === 'Q1' && (fb === 'SR' || fb === 'RS')) return 'BOOL'
  if (member === 'Q' && fb !== 'CTUD' && fb !== 'SR' && fb !== 'RS') return 'BOOL'
  if (member === 'ET' && (fb === 'TON' || fb === 'TOF' || fb === 'TP')) return 'TIME'
  if (member === 'CV' && (fb === 'CTU' || fb === 'CTD' || fb === 'CTUD')) return 'INT'
  if ((member === 'QU' || member === 'QD') && fb === 'CTUD') return 'BOOL'
  return null
}

// ---- whole arrays and structs ----

/**
 * Copy a whole array or struct into an existing one of the same type, element by element and
 * field by field, recursively.
 *
 * In place: the destination may be aliased (a VAR_IN_OUT binds the caller's own
 * array), and swapping in a fresh object would silently cut the alias, so the caller would never
 * see the copy. Nothing is coerced: the checker only lets a copy through between exactly equal
 * types, and never one holding a function-block instance, so every leaf already fits its slot.
 * Shared by the interpreter and the emitted TypeScript, so the two cannot copy differently.
 */
export function copyData(dst: unknown, src: unknown): void {
  if (Array.isArray(dst) && Array.isArray(src)) {
    for (let i = 0; i < dst.length; i++) {
      const s: unknown = src[i]
      if (typeof s === 'object' && s !== null) copyData(dst[i], s)
      else dst[i] = s
    }
    return
  }
  if (typeof dst !== 'object' || dst === null || typeof src !== 'object' || src === null) return
  const d = dst as Record<string, unknown>
  const s = src as Record<string, unknown>
  for (const k of Object.keys(d)) {
    const v = s[k]
    if (typeof v === 'object' && v !== null) copyData(d[k], v)
    else d[k] = v
  }
}

