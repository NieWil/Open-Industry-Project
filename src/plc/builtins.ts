// IEC 61131-3 standard *functions* (the stateless library: ABS/MIN/MAX/LIMIT, the
// selectors SEL/MUX, the REAL math set, the bit shifts/rotates, and the full
// `<src>_TO_<dst>` conversion family). Function blocks (TON/CTUD/...) live in runtime.ts.
//
// Each builtin is wired into three surfaces, kept side by side here so they can't drift:
//   - the type checker  -> `builtinResultType` (validates args, returns the result type)
//   - the interpreter   -> `evalBuiltin`       (computes the value)
//   - the ST->TS emitter -> `emitBuiltin`      (the equivalent JS expression)
// The non-trivial semantics (width-correct shifts/rotates, rounding conversions) live as
// shared helpers in runtime.ts, so "shown" and "executed" call the exact same code.

import { bcdToInt, bool, calendarValue, conv, idiv, intToBcd, isBitString, isCalendar, isInt, isInt32, isReal, isString, isTime, num, rol, ror, shl, shr, str, strDelete, strFind, strInsert, strLeft, strMid, strReplace, strRight, widen, wrap } from './runtime'
import { SCALAR_TYPES, StError } from './types'
import type { ScalarType, SourcePos, TagValue } from './types'

/**
 * IEC's time and date functions: two operands of fixed types, one operator between them. The set is IEC
 * 61131-3's standard functions on durations and calendar values, 2nd edition, cross-checked against MATIEC (the
 * conformance oracle, which compiles each one); `MUL_TIME` and `DIV_TIME` are the 3rd edition's names for
 * `MULTIME` and `DIVTIME` (STruC++ accepts both spellings, MATIEC only the old one). `null` as the second
 * operand type means any number: a duration scales by an integer or a real.
 */
const TIME_FUNCTIONS: Readonly<Record<string, { args: [ScalarType, ScalarType | null]; ret: ScalarType; op: '+' | '-' | '*' | '/' }>> = {
  ADD_TIME: { args: ['TIME', 'TIME'], ret: 'TIME', op: '+' },
  SUB_TIME: { args: ['TIME', 'TIME'], ret: 'TIME', op: '-' },
  MULTIME: { args: ['TIME', null], ret: 'TIME', op: '*' },
  MUL_TIME: { args: ['TIME', null], ret: 'TIME', op: '*' },
  DIVTIME: { args: ['TIME', null], ret: 'TIME', op: '/' },
  DIV_TIME: { args: ['TIME', null], ret: 'TIME', op: '/' },
  ADD_TOD_TIME: { args: ['TOD', 'TIME'], ret: 'TOD', op: '+' },
  ADD_DT_TIME: { args: ['DT', 'TIME'], ret: 'DT', op: '+' },
  SUB_TOD_TIME: { args: ['TOD', 'TIME'], ret: 'TOD', op: '-' },
  SUB_DT_TIME: { args: ['DT', 'TIME'], ret: 'DT', op: '-' },
  SUB_DATE_DATE: { args: ['DATE', 'DATE'], ret: 'TIME', op: '-' },
  SUB_TOD_TOD: { args: ['TOD', 'TOD'], ret: 'TIME', op: '-' },
  SUB_DT_DT: { args: ['DT', 'DT'], ret: 'TIME', op: '-' },
  // a DATE and a TIME_OF_DAY are the two halves of a DATE_AND_TIME, so joining them is a sum
  CONCAT_DATE_TOD: { args: ['DATE', 'TOD'], ret: 'DT', op: '+' },
}

/** The fixed-name builtins (the conversion family `X_TO_Y` is recognised separately). */
const FN_NAMES = new Set<string>([
  'ABS', 'MIN', 'MAX', 'LIMIT', 'SEL', 'MUX',
  'SQRT', 'LN', 'LOG', 'EXP', 'EXPT', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
  'TRUNC', 'SHL', 'SHR', 'ROL', 'ROR',
  // functional forms of the operators. Rare to write by hand, but generated and imported
  // code is full of them, and without these such a program will not load.
  'ADD', 'SUB', 'MUL', 'DIV', 'MOVE',
  'GT', 'GE', 'EQ', 'LE', 'LT', 'NE',
  // the string library. Positions are 1-based (IEC), and the whole set is CONCAT-centric
  // because IEC has no string `+` - see runtime.ts for the clamping rules.
  'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND',
  // BCD is an encoding carried in a bit string, not a scalar type, so these two cannot be
  // spelled by the generic `<src>_TO_<dst>` rule below and have to be named here.
  'BCD_TO_INT', 'INT_TO_BCD',
  // the time and date library (IEC Table 30), each one an operator of the calendar table below
  ...Object.keys(TIME_FUNCTIONS),
])


/**
 * The calendar operators: IEC's table of time functions written as `+` and `-`, and nothing beyond it.
 * Measured against MATIEC: it builds every pair below and refuses every other, TIME on the LEFT
 * of a `+` and a DATE plus a TIME included ("Data type mismatch for '+' expression"). A TOD or DT result
 * is checked against its range by the backends (runtime.ts `calendarValue`).
 */
const CALENDAR_OPERATORS: Readonly<Record<string, ScalarType>> = {
  'TOD + TIME': 'TOD',
  'DT + TIME': 'DT',
  'TOD - TIME': 'TOD',
  'DT - TIME': 'DT',
  'DATE - DATE': 'TIME',
  'TOD - TOD': 'TIME',
  'DT - DT': 'TIME',
}

/** The type of `lt op rt` where one side is a calendar type, or why it has none. */
export function calendarOperatorType(op: string, lt: ScalarType, rt: ScalarType): { t: ScalarType } | { error: string } {
  const t = CALENDAR_OPERATORS[`${lt} ${op} ${rt}`]
  if (t) return { t }
  if (op === '+' && lt === 'DATE' && rt === 'TIME') return { error: 'a DATE has no time of day to add a TIME to; make it a DT first: CONCAT_DATE_TOD(d, TOD#00:00:00) + t' }
  if (op === '+' && isTime(lt) && isCalendar(rt)) return { error: `write the ${rt} first: ${rt} + TIME` }
  if (op === '+' || op === '-') {
    return { error: `${lt} ${op} ${rt} is not defined; the calendar sums are a TOD or DT plus or minus a TIME, and the difference of two DATEs, TODs or DTs` }
  }
  return { error: `${op} is not defined on ${isCalendar(lt) ? lt : rt}` }
}

/** A conversion into or out of a calendar type exists only where IEC and both reference compilers agree on
 *  what it means: to and from STRING (the literal), and a DT taken apart. Why any other one does not. */
function calendarConversionError(src: ScalarType, dst: ScalarType): string | null {
  if (!isCalendar(src) && !isCalendar(dst)) return null
  if (src === dst || isString(src) || isString(dst)) return null
  if (src === 'DT' && (dst === 'DATE' || dst === 'TOD')) return null
  if (isTime(src) || isTime(dst)) return `${src}_TO_${dst} does not exist: a duration and a point in time are different things (tod - TOD#00:00:00 is a TOD's TIME since midnight)`
  if (dst === 'DT' && isCalendar(src)) return `${src}_TO_DT does not exist: join a DATE and a TOD with CONCAT_DATE_TOD`
  if (isCalendar(src) && isCalendar(dst)) return `${src}_TO_${dst} does not exist: a ${dst} is taken from a DT (DT_TO_${dst})`
  const cal = isCalendar(src) ? src : dst
  return `${src}_TO_${dst} is not portable: the reference compilers count a ${cal} in different units (${CALENDAR_UNITS[cal]}); ${CALENDAR_INSTEAD[cal]}`
}

// Measured (docs/st-conformance.md, "Dates and times of day"): MATIEC by its execute oracle,
// STruC++ 0.6.2 by building its output and running it. No number is portable, and neither is TIME_TO_DINT
// (MATIEC counts whole seconds), so each spelling keeps the value in its own type. Each was run on STruC++:
// its DATE difference is a count of days compared against a TIME, so a DATE is only compared.
const CALENDAR_UNITS: Record<string, string> = {
  DATE: 'MATIEC in seconds since 1970, STruC++ in days',
  TOD: 'MATIEC in seconds since midnight, STruC++ in milliseconds',
  DT: 'MATIEC in seconds since 1970, STruC++ in milliseconds',
}
const CALENDAR_INSTEAD: Record<string, string> = {
  DATE: 'keep it a DATE and compare it with a DATE literal: d >= D#2024-03-01',
  TOD: 'keep it a TOD and compare it with a TOD literal: t >= TOD#06:00:00',
  DT: 'keep it a DT, and for an interval subtract two and compare the TIME with a TIME literal: now - started >= T#5m',
}

/** Variadic arithmetic: `ADD(a, b, c)`. The operator's own type rules decide the result. */
const VARIADIC_ARITH: Record<string, '+' | '*'> = { ADD: '+', MUL: '*' }
/** Binary arithmetic: `SUB(a, b)`. */
const BINARY_ARITH: Record<string, '-' | '/'> = { SUB: '-', DIV: '/' }
/** Comparison chains: IEC's `GT(a, b, c)` means `a > b AND b > c`. */
const COMPARISONS: Record<string, string> = { GT: '>', GE: '>=', EQ: '===', LE: '<=', LT: '<', NE: '!==' }

/** Every builtin function name, for editor highlighting / autocomplete (conversions excluded - open-ended). */
export const BUILTIN_FUNCTIONS: readonly string[] = [...FN_NAMES].sort()

/** Parse a `<src>_TO_<dst>` conversion name into its scalar endpoints, or null if not one. Memoized: the
 *  interpreter asks on every call of a conversion, and the answer is a pure function of the name. */
const convCache = new Map<string, { src: ScalarType; dst: ScalarType } | null>()
function parseConv(name: string): { src: ScalarType; dst: ScalarType } | null {
  let r = convCache.get(name)
  if (r === undefined) {
    r = parseConvUncached(name)
    convCache.set(name, r)
  }
  return r
}
function parseConvUncached(name: string): { src: ScalarType; dst: ScalarType } | null {
  // the calendar types' long names spell the same conversions: DATE_AND_TIME_TO_TIME_OF_DAY is DT_TO_TOD
  const m = name.replace(/DATE_AND_TIME/g, 'DT').replace(/TIME_OF_DAY/g, 'TOD').match(/^([A-Z]+)_TO_([A-Z]+)$/)
  if (!m) return null
  const src = m[1] as ScalarType
  const dst = m[2] as ScalarType
  const scalars = SCALAR_TYPES as readonly string[]
  return scalars.includes(src) && scalars.includes(dst) ? { src, dst } : null
}

/** The extensible standard functions: any number of inputs, named `IN1`, `IN2`, ... (`MUX`'s are `IN0`, ...
 *  after its selector `K`). Every other one has the fixed parameters `STANDARD_PARAMS` lists, or just `IN`. */
const EXTENSIBLE = new Set(['ADD', 'MUL', 'MAX', 'MIN', 'CONCAT', 'GT', 'GE', 'EQ', 'LE', 'LT'])
const STANDARD_PARAMS: Readonly<Record<string, readonly string[]>> = {
  LIMIT: ['MN', 'IN', 'MX'],
  SEL: ['G', 'IN0', 'IN1'],
  SHL: ['IN', 'N'], SHR: ['IN', 'N'], ROL: ['IN', 'N'], ROR: ['IN', 'N'],
  LEFT: ['IN', 'L'], RIGHT: ['IN', 'L'],
  MID: ['IN', 'L', 'P'], DELETE: ['IN', 'L', 'P'],
  INSERT: ['IN1', 'IN2', 'P'],
  REPLACE: ['IN1', 'IN2', 'L', 'P'],
  FIND: ['IN1', 'IN2'],
  SUB: ['IN1', 'IN2'], DIV: ['IN1', 'IN2'], NE: ['IN1', 'IN2'], EXPT: ['IN1', 'IN2'],
  ...Object.fromEntries(Object.keys(TIME_FUNCTIONS).map((n) => [n, ['IN1', 'IN2']])),
}

/**
 * A standard function's formal inputs in order, as a call and a ladder box both name them: the one pin table (the
 * ladder's boxes, its catalogue and PLCopen read it from here). An extensible function lists its first two and takes
 * more on the same stem (ADD: IN1, IN2, IN3...; MUX: K, IN0, IN1, IN2...). Assumes `isBuiltinFunc(name)`.
 */
export function standardInputs(name: string): { inputs: readonly string[]; extensible: boolean } {
  if (name === 'MUX') return { inputs: ['K', 'IN0', 'IN1'], extensible: true }
  if (EXTENSIBLE.has(name)) return { inputs: ['IN1', 'IN2'], extensible: true }
  return { inputs: STANDARD_PARAMS[name] ?? ['IN'], extensible: false }
}

/** The 2nd-edition spellings the 3rd renamed (MULTIME is MUL_TIME): still read, never offered. */
export const SUPERSEDED_FUNCTIONS: ReadonlySet<string> = new Set(['MULTIME', 'DIVTIME'])

/** Every `<src>_TO_<dst>` conversion that exists: each pair of scalar types this engine converts between (a
 *  calendar type only where `calendarConversionError` allows it). Generated, so there is no list of them to keep. */
export function conversionNames(): string[] {
  const out: string[] = []
  for (const src of SCALAR_TYPES) {
    for (const dst of SCALAR_TYPES) if (src !== dst && calendarConversionError(src, dst) === null) out.push(`${src}_TO_${dst}`)
  }
  return out
}

/**
 * A formal call of a standard function (`LIMIT(MN := 0, IN := x, MX := 10)`), as the positions of the
 * arguments given: `order[k]` is the index, among the arguments as written, of the one that goes in place
 * `k`. The names are IEC 61131-3's standard input names, cross-checked against MATIEC (the conformance oracle). A standard
 * function has no initial values to fall back on, so every input is given; an extensible one takes
 * `IN1`..`INn` with none missing.
 */
export function orderStandardArgs(name: string, names: readonly string[], pos: SourcePos): number[] {
  const given = names.map((n) => n.toUpperCase())
  const fail = (why: string): never => {
    throw new StError(`'${name}' ${why}`, pos, name.length)
  }
  const twice = given.find((n, i) => given.indexOf(n) !== i)
  if (twice !== undefined) fail(`input '${twice}' is given twice`)
  let params: readonly string[]
  if (EXTENSIBLE.has(name) || name === 'MUX') {
    const first = name === 'MUX' ? 0 : 1
    // up to the highest one named, so a gap is reported as the input missing rather than as the one after it
    const top = Math.max(first - 1, ...given.flatMap((n) => (/^IN\d+$/.test(n) ? [Number(n.slice(2))] : [])))
    params = [...(name === 'MUX' ? ['K'] : []), ...Array.from({ length: top - first + 1 }, (_, i) => `IN${first + i}`)]
  } else {
    params = STANDARD_PARAMS[name] ?? ['IN']
  }
  const unknown = given.find((n) => !params.includes(n))
  if (unknown !== undefined) fail(`has no input '${unknown}' (its inputs are ${params.join(', ')}${EXTENSIBLE.has(name) || name === 'MUX' ? ', ...' : ''})`)
  const missing = params.find((p) => !given.includes(p))
  if (missing !== undefined) fail(`input '${missing}' is not given; a standard function takes every input`)
  return params.map((p) => given.indexOf(p))
}

/** True when `name` is a standard function (so the checker resolves it as a builtin, not a user FUNCTION). */
export function isBuiltinFunc(name: string): boolean {
  return FN_NAMES.has(name) || parseConv(name) !== null
}

// ---- numeric type rules (widening shared with the expression checker via runtime.widen) ----

function arity(name: string, got: number, min: number, max: number, pos: SourcePos): void {
  if (got >= min && got <= max) return
  const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}..${max}`
  throw new StError(`'${name}' expects ${want} argument(s), got ${got}`, pos, name.length)
}
/** ABS and the arithmetic forms: a number or a duration, never a BOOL, a STRING or a date. */
function needNum(name: string, t: ScalarType, pos: SourcePos): ScalarType {
  if (t === 'BOOL' || isString(t) || isCalendar(t)) throw new StError(`'${name}' needs a numeric argument`, pos, name.length)
  return t
}

/**
 * ADD, SUB, MUL and DIV over durations and dates: exactly the operators' rules (checkExpr.ts
 * `inferTimeBinary`, and `calendarOperatorType` above), so `ADD(tod, t)` and `tod + t` cannot disagree.
 * ADD chains left to right; a duration scales by a plain number, and nothing else mixes with one.
 */
function timeArithType(name: string, op: '+' | '-' | '*' | '/', types: ScalarType[], pos: SourcePos): ScalarType {
  const fail = (why: string): never => {
    throw new StError(`'${name}': ${why}`, pos, name.length)
  }
  if (op === '+' || op === '-') {
    arity(name, types.length, 2, op === '-' ? 2 : Infinity, pos)
    return types.reduce((acc, t) => {
      if (isCalendar(acc) || isCalendar(t)) {
        const r = calendarOperatorType(op, acc, t)
        return 'error' in r ? fail(r.error) : r.t
      }
      return isTime(acc) && isTime(t) ? 'TIME' : fail(`${op} on TIME needs both operands to be TIME (a duration plus a number is ambiguous)`)
    })
  }
  if (types.some(isCalendar)) fail(`${op} is not defined on ${types.find(isCalendar)}`)
  const durations = types.filter(isTime).length
  const numbers = types.filter((t) => (isInt(t) || isReal(t)) && !isBitString(t)).length
  const scales = op === '*' ? durations === 1 && numbers === types.length - 1 : types.length === 2 && isTime(types[0]!) && numbers === 1
  if (!scales) fail(op === '*' ? 'a duration is multiplied by plain numbers only, one duration at a time' : 'a duration is divided by a plain number only')
  return 'TIME'
}

/** Durations and dates are ordered, but each only against its own kind: `MAX(tod, t)` means nothing, and
 *  widening would silently pick one of the two. */
function sameTimeKind(name: string, types: ScalarType[], pos: SourcePos): void {
  const timed = types.find((t) => isTime(t) || isCalendar(t))
  if (timed !== undefined && types.some((t) => t !== timed)) {
    throw new StError(`'${name}' mixes ${timed} with ${types.find((t) => t !== timed)}; every argument must be ${timed}`, pos, name.length)
  }
}
/** MIN / MAX / LIMIT are generic over ordered values in IEC (ANY_ELEMENTARY), so a
 *  duration and a string are both fine - only BOOL, which has no useful order, is not. */
function needOrdered(name: string, t: ScalarType, pos: SourcePos): ScalarType {
  if (t === 'BOOL') throw new StError(`'${name}' needs ordered (numeric, TIME or STRING) arguments`, pos, name.length)
  return t
}
/** The string library takes STRING where it says STRING - no silent stringification. */
function needString(name: string, t: ScalarType, pos: SourcePos): ScalarType {
  if (!isString(t)) throw new StError(`'${name}' needs a STRING argument (write ${t}_TO_STRING(...))`, pos, name.length)
  return t
}
/** A set of operand types is usable together only if STRING is all-or-nothing. */
function uniformStrings(name: string, types: ScalarType[], pos: SourcePos): boolean {
  const strings = types.filter(isString).length
  if (strings === 0) return false
  if (strings !== types.length) throw new StError(`'${name}' mixes STRING and non-STRING arguments`, pos, name.length)
  return true
}
/** The REAL math set is defined on numbers only - a duration has no square root. */
function needArith(name: string, t: ScalarType, pos: SourcePos): ScalarType {
  if (t === 'BOOL' || isTime(t) || isCalendar(t)) throw new StError(`'${name}' needs a numeric argument`, pos, name.length)
  return t
}
function needInt(name: string, t: ScalarType, pos: SourcePos): ScalarType {
  if (!isInt(t)) throw new StError(`'${name}' needs an integer argument`, pos, name.length)
  return t
}
/** The shifts and rotates take a bit string to operate on (IEC's ANY_BIT), not a number. */
function needBits(name: string, t: ScalarType, pos: SourcePos): ScalarType {
  if (!isBitString(t)) {
    throw new StError(`'${name}' shifts a bit string; '${t}' is a number (convert it: ${t}_TO_WORD(...))`, pos, name.length)
  }
  return t
}
/** SEL/MUX result: all-BOOL stays BOOL, all-STRING stays STRING, all-numeric widens;
 *  mixing the kinds is an error (widen() would otherwise pick one and lose the other). */
function combineSelectands(name: string, types: ScalarType[], pos: SourcePos): ScalarType {
  if (types.every((t) => t === 'BOOL')) return 'BOOL'
  if (types.some((t) => t === 'BOOL')) throw new StError(`'${name}' branches must be the same kind`, pos, name.length)
  if (uniformStrings(name, types, pos)) return 'STRING'
  sameTimeKind(name, types, pos)
  return types.reduce(widen)
}

/** Validate a builtin call's arguments and return its result type. Assumes `isBuiltinFunc(name)`. */
export function builtinResultType(name: string, argTypes: ScalarType[], pos: SourcePos): ScalarType {
  const cv = parseConv(name)
  if (cv) {
    arity(name, argTypes.length, 1, 1, pos)
    const why = calendarConversionError(cv.src, cv.dst)
    if (why !== null) throw new StError(why, pos, name.length)
    return cv.dst
  }
  const n = argTypes.length
  const tf = TIME_FUNCTIONS[name]
  if (tf) {
    arity(name, n, 2, 2, pos)
    tf.args.forEach((want, i) => {
      const got = argTypes[i]!
      const ok = want === null ? (isInt(got) || isReal(got)) && !isBitString(got) : got === want
      if (!ok) throw new StError(`'${name}' ${i === 0 ? 'IN1' : 'IN2'} needs ${want ?? 'a number'}, got ${got}`, pos, name.length)
    })
    return tf.ret
  }
  // an operator's functional form over durations and dates takes the operator's own rules
  if ((VARIADIC_ARITH[name] || BINARY_ARITH[name]) && argTypes.some((t) => isTime(t) || isCalendar(t))) {
    return timeArithType(name, VARIADIC_ARITH[name] ?? BINARY_ARITH[name]!, argTypes, pos)
  }
  switch (name) {
    case 'ABS':
      arity(name, n, 1, 1, pos)
      return needNum(name, argTypes[0]!, pos)
    case 'MIN':
    case 'MAX':
    case 'LIMIT':
      arity(name, n, name === 'LIMIT' ? 3 : 2, name === 'LIMIT' ? 3 : Infinity, pos)
      argTypes.forEach((t) => needOrdered(name, t, pos))
      if (uniformStrings(name, argTypes, pos)) return 'STRING'
      sameTimeKind(name, argTypes, pos)
      return argTypes.reduce(widen)
    case 'SEL':
      arity(name, n, 3, 3, pos)
      if (argTypes[0] !== 'BOOL') throw new StError(`'SEL' selector (1st arg) must be BOOL`, pos, name.length)
      return combineSelectands(name, [argTypes[1]!, argTypes[2]!], pos)
    case 'MUX':
      arity(name, n, 2, Infinity, pos)
      needInt(name, argTypes[0]!, pos)
      return combineSelectands(name, argTypes.slice(1), pos)
    case 'SQRT': case 'LN': case 'LOG': case 'EXP':
    case 'SIN': case 'COS': case 'TAN': case 'ASIN': case 'ACOS': case 'ATAN':
      arity(name, n, 1, 1, pos)
      needArith(name, argTypes[0]!, pos)
      return 'REAL'
    case 'EXPT':
      arity(name, n, 2, 2, pos)
      argTypes.forEach((t) => needArith(name, t, pos))
      return 'REAL'
    case 'TRUNC':
      arity(name, n, 1, 1, pos)
      needArith(name, argTypes[0]!, pos)
      return 'DINT'
    case 'SHL': case 'SHR': case 'ROL': case 'ROR':
      // IEC: IN is ANY_BIT, N is ANY_INT. Shifting a signed integer is not defined -
      // there is no arithmetic-vs-logical question to answer, because the operand is a bit
      // string or it is not an operand at all. MATIEC refuses `SHR(anInt, 1)`.
      arity(name, n, 2, 2, pos)
      needBits(name, argTypes[0]!, pos)
      needInt(name, argTypes[1]!, pos)
      return argTypes[0]!
    // IEC's BCD pair. `BCD_TO_INT` reads a bit string (that is where packed BCD lives) and
    // `INT_TO_BCD` produces one; WORD is the result width because INT is 16 bits, which is
    // the pairing Annex F's `weigh` and `gravel` examples both assume.
    case 'BCD_TO_INT':
      arity(name, n, 1, 1, pos)
      needBits(name, argTypes[0]!, pos)
      return 'INT'
    case 'INT_TO_BCD':
      arity(name, n, 1, 1, pos)
      needInt(name, argTypes[0]!, pos)
      return 'WORD'
    case 'MOVE':
      arity(name, n, 1, 1, pos)
      return argTypes[0]! // MOVE is the assignment operator as a function: type in, type out
    // ---- string library (IEC Table 26). Lengths/positions are ordinary integers. ----
    case 'LEN':
      arity(name, n, 1, 1, pos)
      needString(name, argTypes[0]!, pos)
      return 'INT'
    case 'FIND':
      arity(name, n, 2, 2, pos)
      argTypes.forEach((t) => needString(name, t, pos))
      return 'INT'
    case 'LEFT':
    case 'RIGHT':
      arity(name, n, 2, 2, pos)
      needString(name, argTypes[0]!, pos)
      needInt(name, argTypes[1]!, pos)
      return 'STRING'
    case 'MID':
    case 'DELETE':
      arity(name, n, 3, 3, pos)
      needString(name, argTypes[0]!, pos)
      needInt(name, argTypes[1]!, pos)
      needInt(name, argTypes[2]!, pos)
      return 'STRING'
    case 'INSERT':
      arity(name, n, 3, 3, pos)
      needString(name, argTypes[0]!, pos)
      needString(name, argTypes[1]!, pos)
      needInt(name, argTypes[2]!, pos)
      return 'STRING'
    case 'REPLACE':
      arity(name, n, 4, 4, pos)
      needString(name, argTypes[0]!, pos)
      needString(name, argTypes[1]!, pos)
      needInt(name, argTypes[2]!, pos)
      needInt(name, argTypes[3]!, pos)
      return 'STRING'
    case 'CONCAT':
      arity(name, n, 2, Infinity, pos)
      argTypes.forEach((t) => needString(name, t, pos))
      return 'STRING'
  }
  if (VARIADIC_ARITH[name]) {
    arity(name, n, 2, Infinity, pos)
    argTypes.forEach((t) => needNum(name, t, pos))
    return argTypes.reduce(widen)
  }
  if (BINARY_ARITH[name]) {
    arity(name, n, 2, 2, pos)
    argTypes.forEach((t) => needNum(name, t, pos))
    return argTypes.reduce(widen)
  }
  if (COMPARISONS[name]) {
    arity(name, n, 2, Infinity, pos)
    sameTimeKind(name, argTypes, pos)
    return 'BOOL'
  }
  throw new StError(`unknown function '${name}'`, pos, name.length) // unreachable behind isBuiltinFunc
}

// ---- interpretation ----

/** Coerce a computed number to its result type - integers wrap, REAL rounds to f32. */
function coerceNum(rt: ScalarType, x: number): number {
  return wrap(rt, x)
}

/**
 * A builtin's dispatch decided once, for a call site whose name, result type and argument count are fixed: a function
 * of exactly those positional arguments that computes what {@link evalBuiltin} computes, or null where none is
 * specialised (the caller keeps evalBuiltin). Only cases that cannot throw are specialised - numeric conversions, ABS,
 * two-argument MIN / MAX, LIMIT - so a call site needs no positioned-fault wrapper. evalBuiltin resolves the name on
 * every call (a conversion parse, a time-function lookup, a string switch) and MIN / MAX spread a fresh array; the
 * generated scan engine (scanCodegen.ts) calls these instead. builtins.test.ts holds every case to evalBuiltin.
 */
export function builtinFor(name: string, rt: ScalarType, arity: number): ((a: TagValue, b: TagValue, c: TagValue) => TagValue) | null {
  const cv = parseConv(name)
  if (cv) {
    const { src, dst } = cv
    // a STRING or calendar conversion parses or formats, and may fault: it keeps evalBuiltin's positioned path
    if (arity !== 1 || isString(src) || isString(dst) || isCalendar(src) || isCalendar(dst)) return null
    return (a) => conv(src, dst, a)
  }
  if (rt === 'STRING' || TIME_FUNCTIONS[name]) return null
  switch (name) {
    case 'ABS': return arity === 1 ? (a) => coerceNum(rt, Math.abs(num(a))) : null
    case 'MIN': return arity === 2 ? (a, b) => coerceNum(rt, Math.min(num(a), num(b))) : null
    case 'MAX': return arity === 2 ? (a, b) => coerceNum(rt, Math.max(num(a), num(b))) : null
    case 'LIMIT': return arity === 3 ? (a, b, c) => coerceNum(rt, Math.min(Math.max(num(b), num(a)), num(c))) : null
  }
  return null
}

/** Evaluate a builtin call given its result type and already-evaluated scalar args. */
export function evalBuiltin(name: string, rt: ScalarType, args: TagValue[]): TagValue {
  const cv = parseConv(name)
  if (cv) return conv(cv.src, cv.dst, args[0]!)
  const tf = TIME_FUNCTIONS[name]
  if (tf) return timeResult(rt, tf.op, num(args[0]!), num(args[1]!))
  switch (name) {
    case 'ABS': return coerceNum(rt, Math.abs(num(args[0]!)))
    // MIN/MAX/LIMIT are generic over ordered values: on STRING they order lexicographically
    // (by character code, the same order the comparison operators use)
    case 'MIN':
      if (rt === 'STRING') return args.map(str).reduce((a, b) => (b < a ? b : a))
      return coerceNum(rt, Math.min(...args.map(num)))
    case 'MAX':
      if (rt === 'STRING') return args.map(str).reduce((a, b) => (b > a ? b : a))
      return coerceNum(rt, Math.max(...args.map(num)))
    case 'LIMIT': {
      if (rt === 'STRING') {
        const [lo, v, hi] = [str(args[0]!), str(args[1]!), str(args[2]!)]
        return v < lo ? lo : v > hi ? hi : v
      }
      return coerceNum(rt, Math.min(Math.max(num(args[1]!), num(args[0]!)), num(args[2]!)))
    }
    case 'LEN': return wrap('INT', str(args[0]!).length)
    case 'FIND': return wrap('INT', strFind(str(args[0]!), str(args[1]!)))
    case 'LEFT': return strLeft(str(args[0]!), num(args[1]!))
    case 'RIGHT': return strRight(str(args[0]!), num(args[1]!))
    case 'MID': return strMid(str(args[0]!), num(args[1]!), num(args[2]!))
    case 'INSERT': return strInsert(str(args[0]!), str(args[1]!), num(args[2]!))
    case 'DELETE': return strDelete(str(args[0]!), num(args[1]!), num(args[2]!))
    case 'REPLACE': return strReplace(str(args[0]!), str(args[1]!), num(args[2]!), num(args[3]!))
    case 'CONCAT': return args.map(str).join('')
    case 'SEL': return bool(args[0]!) ? args[2]! : args[1]!
    case 'MUX': {
      // a selector past the inputs, either way, answers 0
      const k = num(args[0]!)
      return k >= 0 && k < args.length - 1 ? args[1 + k]! : 0
    }
    // the REAL math set: computed in f64 then rounded to the REAL result type's f32,
    // which is what a single-precision FPU produces
    case 'SQRT': return coerceNum(rt, Math.sqrt(num(args[0]!)))
    case 'LN': return coerceNum(rt, Math.log(num(args[0]!)))
    case 'LOG': return coerceNum(rt, Math.log10(num(args[0]!)))
    case 'EXP': return coerceNum(rt, Math.exp(num(args[0]!)))
    case 'SIN': return coerceNum(rt, Math.sin(num(args[0]!)))
    case 'COS': return coerceNum(rt, Math.cos(num(args[0]!)))
    case 'TAN': return coerceNum(rt, Math.tan(num(args[0]!)))
    case 'ASIN': return coerceNum(rt, Math.asin(num(args[0]!)))
    case 'ACOS': return coerceNum(rt, Math.acos(num(args[0]!)))
    case 'ATAN': return coerceNum(rt, Math.atan(num(args[0]!)))
    case 'EXPT': return coerceNum(rt, Math.pow(num(args[0]!), num(args[1]!)))
    case 'TRUNC': return wrap('DINT', Math.trunc(num(args[0]!)))
    case 'SHL': return shl(rt, num(args[0]!), num(args[1]!))
    case 'SHR': return shr(rt, num(args[0]!), num(args[1]!))
    case 'ROL': return rol(rt, num(args[0]!), num(args[1]!))
    case 'ROR': return ror(rt, num(args[0]!), num(args[1]!))
    case 'BCD_TO_INT': return wrap('INT', bcdToInt(num(args[0]!)))
    case 'INT_TO_BCD': return intToBcd('WORD', num(args[0]!))
    case 'MOVE': return args[0]!
  }
  const va = VARIADIC_ARITH[name]
  if (va) {
    const vals = args.map(num)
    // step by step, as `a + b + c` is: an integer wraps and a REAL rounds to f32 after each step, and a 32-bit
    // product goes through Math.imul, as the `*` operator takes it (runtime.ts isInt32)
    const step = isCalendar(rt) ? (x: number): number => x : (x: number): number => wrap(rt, x)
    const x = va === '+' ? vals.reduce((a, b) => step(a + b)) : isInt32(rt) ? vals.reduce((a, b) => Math.imul(a | 0, b | 0)) : vals.reduce((a, b) => step(a * b))
    return isCalendar(rt) ? calendarValue(rt, x) : coerceNum(rt, x)
  }
  if (BINARY_ARITH[name]) {
    const [a, b] = [num(args[0]!), num(args[1]!)]
    if (name === 'SUB') return isCalendar(rt) ? calendarValue(rt, a - b) : coerceNum(rt, a - b)
    // DIV mirrors the `/` operator exactly: integers and durations truncate toward zero and
    // fault on a zero divisor; reals stay IEEE
    return isInt(rt) || isTime(rt) ? coerceNum(rt, idiv(a, b)) : coerceNum(rt, a / b)
  }
  const cmp = COMPARISONS[name]
  if (cmp) {
    // IEC comparison functions are chains: GT(a, b, c) is `a > b AND b > c`
    for (let i = 0; i + 1 < args.length; i++) {
      if (!compareOnce(cmp, args[i]!, args[i + 1]!)) return false
    }
    return true
  }
  throw new Error(`unknown builtin '${name}'`)
}

/** A time function's result: its operator, exactly as the `+ - * /` operators compute it on a duration or
 *  a date (a duration divides as an integer does, truncating), and a date checked against its range. */
function timeResult(rt: ScalarType, op: '+' | '-' | '*' | '/', a: number, b: number): number {
  const x = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : idiv(a, b)
  return isCalendar(rt) ? calendarValue(rt, x) : x
}

/** One link of a comparison chain, with the same BOOL/number/STRING handling as the operators. */
function compareOnce(op: string, l: TagValue, r: TagValue): boolean {
  if (op === '===' || op === '!==') {
    const same = typeof l === 'boolean' || typeof r === 'boolean' ? bool(l) === bool(r) : l === r
    return op === '===' ? same : !same
  }
  if (typeof l === 'string' || typeof r === 'string') {
    const [a, b] = [str(l), str(r)]
    return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b
  }
  const a = num(l)
  const b = num(r)
  return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b
}

// ---- emission (ST -> TS) ----

/** Emit a builtin call as a JS expression. `a` are the already-emitted argument sources. */
export function emitBuiltin(name: string, rt: ScalarType, a: string[]): string {
  const cv = parseConv(name)
  if (cv) return `conv('${cv.src}', '${cv.dst}', ${a[0]})`
  // a date result is range-checked, as the operators' are (emit.ts); a duration divides as an integer does
  const dated = (expr: string): string => (isCalendar(rt) ? `calendarValue('${rt}', ${expr})` : `(${expr})`)
  const tf = TIME_FUNCTIONS[name]
  if (tf) return tf.op === '/' ? `idiv(${a[0]}, ${a[1]})` : dated(`${a[0]} ${tf.op} ${a[1]}`)
  // integers wrap to their width and REAL rounds to f32 - both go through the same runtime
  // helper the interpreter calls, so "shown" and "executed" cannot drift
  const w = (expr: string): string => (isInt(rt) || rt === 'REAL' ? `wrap('${rt}', ${expr})` : `(${expr})`)
  switch (name) {
    case 'ABS': return w(`Math.abs(${a[0]})`)
    case 'MIN':
      if (rt === 'STRING') return `[${a.join(', ')}].reduce((x, y) => (y < x ? y : x))`
      return w(`Math.min(${a.join(', ')})`)
    case 'MAX':
      if (rt === 'STRING') return `[${a.join(', ')}].reduce((x, y) => (y > x ? y : x))`
      return w(`Math.max(${a.join(', ')})`)
    case 'LIMIT':
      if (rt === 'STRING') return `((v, lo, hi) => (v < lo ? lo : v > hi ? hi : v))(${a[1]}, ${a[0]}, ${a[2]})`
      return w(`Math.min(Math.max(${a[1]}, ${a[0]}), ${a[2]})`)
    case 'LEN': return `wrap('INT', (${a[0]}).length)`
    case 'FIND': return `wrap('INT', strFind(${a[0]}, ${a[1]}))`
    case 'LEFT': return `strLeft(${a[0]}, ${a[1]})`
    case 'RIGHT': return `strRight(${a[0]}, ${a[1]})`
    case 'MID': return `strMid(${a[0]}, ${a[1]}, ${a[2]})`
    case 'INSERT': return `strInsert(${a[0]}, ${a[1]}, ${a[2]})`
    case 'DELETE': return `strDelete(${a[0]}, ${a[1]}, ${a[2]})`
    case 'REPLACE': return `strReplace(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`
    case 'CONCAT': return `(${a.join(' + ')})`
    case 'SEL': return `(${a[0]} ? ${a[2]} : ${a[1]})`
    case 'MUX': return `([${a.slice(1).join(', ')}][${a[0]}] ?? 0)`
    case 'SQRT': return w(`Math.sqrt(${a[0]})`)
    case 'LN': return w(`Math.log(${a[0]})`)
    case 'LOG': return w(`Math.log10(${a[0]})`)
    case 'EXP': return w(`Math.exp(${a[0]})`)
    case 'SIN': return w(`Math.sin(${a[0]})`)
    case 'COS': return w(`Math.cos(${a[0]})`)
    case 'TAN': return w(`Math.tan(${a[0]})`)
    case 'ASIN': return w(`Math.asin(${a[0]})`)
    case 'ACOS': return w(`Math.acos(${a[0]})`)
    case 'ATAN': return w(`Math.atan(${a[0]})`)
    case 'EXPT': return w(`Math.pow(${a[0]}, ${a[1]})`)
    case 'TRUNC': return `wrap('DINT', Math.trunc(${a[0]}))`
    case 'SHL': return `shl('${rt}', ${a[0]}, ${a[1]})`
    case 'SHR': return `shr('${rt}', ${a[0]}, ${a[1]})`
    case 'ROL': return `rol('${rt}', ${a[0]}, ${a[1]})`
    case 'ROR': return `ror('${rt}', ${a[0]}, ${a[1]})`
    case 'BCD_TO_INT': return `wrap('INT', bcdToInt(${a[0]}))`
    case 'INT_TO_BCD': return `intToBcd('WORD', ${a[0]})`
    case 'MOVE': return `(${a[0]})`
  }
  const va = VARIADIC_ARITH[name]
  if (va === '*' && isInt32(rt)) return w(a.reduce((x, y) => `Math.imul(${x} | 0, ${y} | 0)`))
  // an integer wraps and a REAL rounds after each step, as `a + b + c` does (evalBuiltin)
  if (va) return isCalendar(rt) ? dated(a.join(` ${va} `)) : a.reduce((x, y) => w(`${x} ${va} ${y}`))
  if (BINARY_ARITH[name]) {
    if (name === 'SUB') return isCalendar(rt) ? dated(`${a[0]} - ${a[1]}`) : w(`${a[0]} - ${a[1]}`)
    if (isTime(rt)) return `idiv(${a[0]}, ${a[1]})`
    return isInt(rt) ? `wrap('${rt}', idiv(${a[0]}, ${a[1]}))` : w(`${a[0]} / ${a[1]}`)
  }
  const cmp = COMPARISONS[name]
  if (cmp) return `(${a.slice(0, -1).map((x, i) => `${x} ${cmp} ${a[i + 1]}`).join(' && ')})`
  throw new Error(`unknown builtin '${name}'`)
}

/** Runtime helper names emitted code may call beyond the four it always imports: the ones a
 *  builtin emits, plus `copyData` for a whole array or struct (so the emitter can import only
 *  what's used). */
export const BUILTIN_RUNTIME_HELPERS = [
  'shl', 'shr', 'rol', 'ror', 'conv', 'bcdToInt', 'intToBcd',
  'strLeft', 'strRight', 'strMid', 'strInsert', 'strDelete', 'strReplace', 'strFind', 'strLimit',
  'copyData', 'calendarValue',
] as const
