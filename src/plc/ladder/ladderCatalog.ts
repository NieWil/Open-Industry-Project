// What a rung can call: every block and function a ladder box can be, with its pins - the standard library and the
// program's own POUs - as one list. The ladder view's Insert Box picker reads it, and so does anything else that needs
// to know what a box may be; nothing keeps a second copy of the list.
//
// It is derived, not written: the standard functions are the engine's own (builtins.ts `BUILTIN_FUNCTIONS`, its
// generated `<src>_TO_<dst>` conversions, and `standardInputs` for their pins), the standard blocks are runtime.ts's,
// and the program's FUNCTION_BLOCKs and FUNCTIONs are read off its text. A function added to the engine appears here
// on its own. The one thing this module adds is a group and a one-line summary per standard name, which is what a
// person browsing needs and the engine has no use for; ladderCatalog.test.ts fails on a standard name without one, and
// inserts, compiles, runs and round-trips through PLCopen every entry, so the list cannot drift from what lowers.

import { BUILTIN_FUNCTIONS, conversionNames, SUPERSEDED_FUNCTIONS } from '../builtins'
import { builtinFbInfo, builtinFunctionInfo, OPERATOR_FUNCTIONS } from './ladder'
import { insertItem, type LadderSel } from './ladderEdit'
import { lex } from '../lexer'
import { declareInstance, freshInstanceName, newItem, readLadder, writeLadder, type RungItem } from './ladderRungs'
import { parse } from '../parser'
import { FB_INPUT_TYPES, fbMemberType } from '../runtime'
import { USER_FB_TYPES, isArray, type DataType, type Decl, type FbType } from '../types'

/** How a box stands on the rung: a function-block instance (state of its own, declared), a function that runs while
 *  the rung is on (EN / ENO), or a function whose BOOL result starts the rung (a condition, first on it). */
export type CatalogKind = 'block' | 'function' | 'condition'

export interface CatalogPin {
  name: string
  /** its declared type; '' for a standard function's, which the call decides (ADD of INTs is an INT) */
  type: string
  bool: boolean
}

export interface CatalogEntry {
  /** what the box is called: `TON`, `LIMIT`, `INT_TO_REAL`, a program's own `PalletTruck` */
  name: string
  kind: CatalogKind
  group: CatalogGroup
  /** declared in this program, rather than the standard library */
  own: boolean
  inputs: readonly CatalogPin[]
  /** a function's one output is `OUT` */
  outputs: readonly CatalogPin[]
  /** takes more inputs on the stem of its last (ADD: IN3, IN4...) */
  extensible: boolean
  summary: string
}

/** The groups, in the order a picker lists them: the program's own first (what an author reaches for most, and what
 *  nothing else offers), then the standard library as IEC's tables arrange it. */
export const CATALOG_GROUPS = [
  'Function blocks in this program',
  'Functions in this program',
  'Timers',
  'Counters',
  'Edges and bistables',
  'Comparisons',
  'Math',
  'Selection',
  'Bitwise',
  'String',
  'Time and date',
  'Conversion',
] as const
export type CatalogGroup = (typeof CATALOG_GROUPS)[number]

type Std = readonly [CatalogGroup, string]

/** A group and a summary for each standard name. Conversions are not here: there are hundreds and their names say it. */
export const STANDARD_SUMMARIES: Readonly<Record<string, Std>> = {
  TON: ['Timers', 'On-delay: Q goes TRUE once IN has been TRUE for PT'],
  TOF: ['Timers', 'Off-delay: Q stays TRUE for PT after IN goes FALSE'],
  TP: ['Timers', 'Pulse: Q is TRUE for PT from a rising IN'],
  CTU: ['Counters', 'Counts up on each rising CU; Q once CV reaches PV'],
  CTD: ['Counters', 'Counts down on each rising CD; Q once CV reaches 0'],
  CTUD: ['Counters', 'Counts up on CU and down on CD; QU at PV, QD at 0'],
  R_TRIG: ['Edges and bistables', 'Q is TRUE for one scan when CLK rises'],
  F_TRIG: ['Edges and bistables', 'Q is TRUE for one scan when CLK falls'],
  SR: ['Edges and bistables', 'Set-dominant latch: S1 sets Q1, R resets it, set wins'],
  RS: ['Edges and bistables', 'Reset-dominant latch: S sets Q1, R1 resets it, reset wins'],

  GT: ['Comparisons', 'TRUE while IN1 > IN2'],
  GE: ['Comparisons', 'TRUE while IN1 >= IN2'],
  EQ: ['Comparisons', 'TRUE while IN1 = IN2'],
  NE: ['Comparisons', 'TRUE while IN1 <> IN2'],
  LE: ['Comparisons', 'TRUE while IN1 <= IN2'],
  LT: ['Comparisons', 'TRUE while IN1 < IN2'],

  MOVE: ['Math', 'Copies IN to OUT'],
  ADD: ['Math', 'IN1 + IN2 (+ more inputs)'],
  SUB: ['Math', 'IN1 - IN2'],
  MUL: ['Math', 'IN1 * IN2 (* more inputs)'],
  DIV: ['Math', 'IN1 / IN2'],
  EXPT: ['Math', 'IN1 to the power IN2'],
  ABS: ['Math', 'Absolute value'],
  SQRT: ['Math', 'Square root'],
  LN: ['Math', 'Natural logarithm'],
  LOG: ['Math', 'Base-10 logarithm'],
  EXP: ['Math', 'e to the power IN'],
  TRUNC: ['Math', 'A REAL cut to its integer part'],
  SIN: ['Math', 'Sine, IN in radians'],
  COS: ['Math', 'Cosine, IN in radians'],
  TAN: ['Math', 'Tangent, IN in radians'],
  ASIN: ['Math', 'Arc sine, in radians'],
  ACOS: ['Math', 'Arc cosine, in radians'],
  ATAN: ['Math', 'Arc tangent, in radians'],

  MIN: ['Selection', 'The smallest input'],
  MAX: ['Selection', 'The largest input'],
  LIMIT: ['Selection', 'IN held between MN and MX'],
  SEL: ['Selection', 'IN0 while G is FALSE, IN1 while it is TRUE'],
  MUX: ['Selection', 'The input K picks: IN0, IN1, ...'],

  MOD: ['Math', 'The remainder of IN1 / IN2'],

  AND: ['Bitwise', 'AND of the inputs: of BOOLs, or bit by bit of a WORD'],
  OR: ['Bitwise', 'OR of the inputs: of BOOLs, or bit by bit of a WORD'],
  XOR: ['Bitwise', 'Exclusive OR of the inputs, BOOLs or bit by bit'],
  NOT: ['Bitwise', 'The inverse of IN: a BOOL, or every bit of a WORD'],
  SHL: ['Bitwise', 'IN shifted left N bits'],
  SHR: ['Bitwise', 'IN shifted right N bits'],
  ROL: ['Bitwise', 'IN rotated left N bits'],
  ROR: ['Bitwise', 'IN rotated right N bits'],

  LEN: ['String', 'The length of a STRING'],
  LEFT: ['String', 'The first L characters of IN'],
  RIGHT: ['String', 'The last L characters of IN'],
  MID: ['String', 'L characters of IN from position P'],
  CONCAT: ['String', 'IN1 followed by IN2 (and more)'],
  INSERT: ['String', 'IN2 inserted into IN1 after position P'],
  DELETE: ['String', 'IN with L characters from position P removed'],
  REPLACE: ['String', 'IN1 with L characters from P replaced by IN2'],
  FIND: ['String', 'Where IN2 first occurs in IN1 (0: nowhere)'],

  ADD_TIME: ['Time and date', 'TIME + TIME'],
  SUB_TIME: ['Time and date', 'TIME - TIME'],
  MUL_TIME: ['Time and date', 'A TIME times a number'],
  DIV_TIME: ['Time and date', 'A TIME divided by a number'],
  ADD_TOD_TIME: ['Time and date', 'A time of day plus a TIME'],
  ADD_DT_TIME: ['Time and date', 'A date and time plus a TIME'],
  SUB_TOD_TIME: ['Time and date', 'A time of day minus a TIME'],
  SUB_DT_TIME: ['Time and date', 'A date and time minus a TIME'],
  SUB_DATE_DATE: ['Time and date', 'The TIME between two DATEs'],
  SUB_TOD_TOD: ['Time and date', 'The TIME between two times of day'],
  SUB_DT_DT: ['Time and date', 'The TIME between two dates and times'],
  CONCAT_DATE_TOD: ['Time and date', 'A DATE and a time of day joined into a DT'],

  BCD_TO_INT: ['Conversion', 'A packed-BCD bit string to an INT'],
  INT_TO_BCD: ['Conversion', 'An INT to a packed-BCD WORD'],
}

const pinOfStd = (name: string): CatalogPin => ({ name, type: '', bool: false })

function standardFunction(name: string): CatalogEntry | null {
  const info = builtinFunctionInfo(name)
  if (!info) return null
  const conv = /^([A-Z]+)_TO_([A-Z]+)$/.exec(name)
  const std: Std | undefined = STANDARD_SUMMARIES[name] ?? (conv ? ['Conversion', `A ${conv[1]} converted to ${conv[2]}`] : undefined)
  if (!std) return null
  const [group, summary] = std
  return {
    name,
    kind: group === 'Comparisons' ? 'condition' : 'function',
    group,
    own: false,
    inputs: info.inputs.map((p) => pinOfStd(p.name)),
    outputs: [{ name: 'OUT', type: info.outputs[0]?.bool ? 'BOOL' : '', bool: info.outputs[0]?.bool ?? false }],
    extensible: info.extensible,
    summary,
  }
}

function standardBlock(type: FbType): CatalogEntry {
  const info = builtinFbInfo(type)!
  const [group, summary] = STANDARD_SUMMARIES[type] ?? ['Timers', type]
  const pin = (name: string, t: string | undefined): CatalogPin => ({ name, type: t ?? '', bool: t === 'BOOL' })
  return {
    name: type,
    kind: 'block',
    group,
    own: false,
    inputs: info.inputs.map((p) => pin(p.name, FB_INPUT_TYPES[type][p.name])),
    outputs: info.outputs.map((p) => pin(p.name, fbMemberType(type, p.name) ?? undefined)),
    extensible: false,
    summary,
  }
}

/** The standard library, the same for every program: built once. */
let standard: readonly CatalogEntry[] | null = null
function standardEntries(): readonly CatalogEntry[] {
  if (standard) return standard
  const fns = [...BUILTIN_FUNCTIONS, ...Object.keys(OPERATOR_FUNCTIONS), ...conversionNames()]
    // a superseded spelling is still read but offered once, under its current name
    .filter((n) => !SUPERSEDED_FUNCTIONS.has(n))
  const seen = new Set<string>()
  const out: CatalogEntry[] = USER_FB_TYPES.map(standardBlock)
  for (const n of fns) {
    if (seen.has(n)) continue
    seen.add(n)
    const e = standardFunction(n)
    if (e) out.push(e)
  }
  standard = out
  return out
}

/** Every standard name the catalogue leaves out because it has no group or summary: what the test holds at none. */
export function unsummarised(): string[] {
  return BUILTIN_FUNCTIONS.filter((n) => !SUPERSEDED_FUNCTIONS.has(n) && !STANDARD_SUMMARIES[n] && !/_TO_/.test(n))
}

function typeName(t: DataType): string {
  if (typeof t === 'string') return t
  if (isArray(t)) return `ARRAY OF ${typeName(t.elem)}`
  if ('ref' in t) return `REF_TO ${typeName(t.ref)}`
  return 'fb' in t ? t.fb : 'struct' in t ? t.struct : 'iface' in t ? t.iface : t.enum
}

const pinOf = (d: Decl): CatalogPin => ({ name: d.name, type: typeName(d.type), bool: d.type === 'BOOL' })

/** The program's own FUNCTION_BLOCKs and FUNCTIONs, read as the parser reads a box's pins (parserLadder.ts `userBlockInfo`):
 *  VAR_INPUT and VAR_OUTPUT, in declaration order. `except` is the POU being edited, which cannot call itself. */
function ownEntries(source: string, except: string): CatalogEntry[] {
  let ast
  try {
    ast = parse(lex(source), [])
  } catch {
    return [] // a program that does not read offers its standard library only
  }
  const skip = except.toUpperCase()
  const out: CatalogEntry[] = []
  for (const fb of ast.fbDefs) {
    if (fb.name.toUpperCase() === skip) continue
    out.push({
      name: fb.name,
      kind: 'block',
      group: 'Function blocks in this program',
      own: true,
      inputs: fb.decls.filter((d) => d.section === 'VAR_INPUT').map(pinOf),
      outputs: fb.decls.filter((d) => d.section === 'VAR_OUTPUT').map(pinOf),
      extensible: false,
      summary: `A ${fb.name} of its own on the rung, declared in this POU`,
    })
  }
  for (const fn of ast.funcDefs) {
    if (fn.name.toUpperCase() === skip) continue
    const ret = typeName(fn.ret)
    const bool = ret === 'BOOL'
    out.push({
      name: fn.name,
      kind: bool ? 'condition' : 'function',
      group: 'Functions in this program',
      own: true,
      inputs: fn.decls.filter((d) => d.section === 'VAR_INPUT').map(pinOf),
      outputs: [{ name: 'OUT', type: ret, bool }],
      extensible: false,
      summary: bool ? `Starts the rung with what ${fn.name} returns` : `Runs while the rung is on; its ${ret} result goes where OUT points`,
    })
  }
  return out
}

/** Everything a box in POU `pou` ('' for the code outside every POU) can be: the program's own blocks and functions,
 *  then the standard library, each group in its own order. */
export function ladderCatalog(source: string, pou = ''): CatalogEntry[] {
  const own = ownEntries(source, pou)
  return [...own, ...standardEntries()].sort((a, b) => CATALOG_GROUPS.indexOf(a.group) - CATALOG_GROUPS.indexOf(b.group))
}

/** One line of what an entry takes: `(IN, PT) -> Q, ET`. */
export function catalogSignature(e: CatalogEntry): string {
  const ins = e.inputs.map((p) => p.name).join(', ') + (e.extensible ? ', ...' : '')
  return `(${ins}) -> ${e.outputs.map((p) => p.name).join(', ')}`
}

/**
 * The box an entry puts on a rung, with `head` its instance (a block's) or ignored (a function's name is its head).
 *
 * A standard block is drawn as the element bar draws it (ladderRungs.ts `newItem`: a timer's PT, a counter's PV). A
 * program's own block is drawn with every pin, blank, because its pins are what nobody remembers and the box is where
 * they are learned: the rung enters by its first BOOL input and leaves by its first BOOL output (by EN / ENO when it has
 * not both), and the rest wait to be named or cleared (clearing a block's pin removes it: ladderLeaves.ts `setField`).
 */
export function catalogItem(e: CatalogEntry, head: string): RungItem {
  if (!e.own) {
    if (e.kind === 'block') return newItem({ kind: 'block', type: e.name }, head)
    return newItem({ kind: e.kind === 'condition' ? 'compare' : 'function', name: e.name })
  }
  const blank = (name: string, out: boolean): { name: string; value: string; out: boolean } => ({ name, value: '?', out })
  if (e.kind === 'block') {
    const boolIn = e.inputs.find((p) => p.bool)?.name
    const boolOut = e.outputs.find((p) => p.bool)?.name
    const onRung = boolIn !== undefined && boolOut !== undefined
    const input = onRung ? boolIn : 'EN'
    return {
      type: 'box',
      head,
      func: false,
      pins: [
        { name: input, value: null, out: false },
        ...e.inputs.filter((p) => p.name !== input).map((p) => blank(p.name, false)),
        ...e.outputs.filter((p) => !onRung || p.name !== boolOut).map((p) => blank(p.name, true)),
      ],
    }
  }
  const inputs = e.inputs.map((p) => blank(p.name, false))
  return {
    type: 'box',
    head: e.name,
    func: true,
    pins: e.kind === 'condition' ? [...inputs, { name: 'OUT', value: null, out: false }] : [...inputs, blank('OUT', true)],
  }
}

/**
 * Entry `e` onto the rung at `at` of ladder section `routine`: after the selected element, or at the start of the
 * selected rung or level - and a condition at the front of the rung, the one place it can stand. A block gets an
 * instance of its own, named after its type and declared in its POU in the same edit. `field` is the one to open next: the first that needs naming. Null when the section is gone.
 */
export function insertCatalogEntry(source: string, routine: number, at: LadderSel, e: CatalogEntry): { source: string; sel: LadderSel | null; field: number | null } | null {
  let base = source
  let head = e.name
  if (e.kind === 'block') {
    head = freshInstanceName(source, e.name)
    base = declareInstance(source, routine, head, e.name)
  }
  const r = readLadder(base)[routine]
  if (!r) return null
  const where = e.kind === 'condition' ? { ...at, trail: [] } : at
  const item = catalogItem(e, head)
  const made = insertItem(r.rungs, where, item)
  const blank = item.type === 'box' ? item.pins.filter((p) => p.value !== null).length : 0
  return { source: writeLadder(base, routine, made.rungs), sel: made.sel, field: made.sel && blank > 0 ? 1 : null }
}
