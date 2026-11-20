// Tokenizer for the ST subset. Tracks line/column/offset on every token so the
// parser and type checker can emit positioned diagnostics (editor squiggles).

import { canonicalAddress } from '../core/io/iecAddress'
import type { ScalarType, SourcePos, Token } from './types'
import { parseCalendar } from './runtime'
import { CALENDAR_TYPE_NAMES, SCALAR_TYPES, StError } from './types'

/** Types that can prefix a typed literal (`INT#5`). BOOL is excluded - write TRUE/FALSE -
 *  and so is STRING, whose literal form is the quoted one (`'abc'`). */
const TYPED_LITERAL_TYPES = new Set<string>(SCALAR_TYPES.filter((t) => t !== 'BOOL' && t !== 'STRING' && !(t in CALENDAR_TYPE_NAMES)))

/** The calendar literal prefixes, long and short (`D#2024-02-28`, `TIME_OF_DAY#12:00:00`), and the type each makes. */
const CALENDAR_PREFIX: Readonly<Record<string, ScalarType>> = { ...CALENDAR_TYPE_NAMES, D: 'DATE' }

/** IEC's `$` escapes inside a single-quoted STRING literal. `$XX` (two hex digits) is
 *  handled separately. `$N` is "newline" and `$L` "line feed"; both are LF on every target. */
const STRING_ESCAPES: Record<string, string> = {
  $: '$', "'": "'", '"': '"',
  L: '\n', N: '\n', P: '\f', R: '\r', T: '\t',
}

/** Every reserved word. Exported so editor tooling (highlighting, autocomplete) reads the
 *  one list the lexer enforces. A hand-copy goes stale the next time the language gains a
 *  keyword, and the editor then shows valid syntax wrongly. */
export const KEYWORDS = new Set<string>([
  // the calendar types are left out: `dt` names a time step in programs that predate them (types.ts)
  ...SCALAR_TYPES.filter((t) => !(t in CALENDAR_TYPE_NAMES)),
  // NOTE: the builtin function-block names (TON, CTU, ...) are not here.
  // Reserving them would stop an author writing `FUNCTION_BLOCK SR`, and IEC does not
  // reserve them either - the checker resolves the name, so a user definition shadows the
  // builtin rather than colliding with a keyword.
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_TEMP', 'VAR_GLOBAL', 'VAR_IN_OUT', 'VAR_EXTERNAL', 'END_VAR', 'CONSTANT',
  // PROGRAM, CONFIGURATION, RESOURCE, TASK, WITH, ON and the task arguments are not here: IEC
  // reserves them, but `task` and `resource` are ordinary variable names in programs already
  // written for this engine, so the parser recognises them only where a declaration can stand
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE',
  'REPEAT', 'UNTIL', 'END_REPEAT',
  'EXIT', 'CONTINUE', 'RETURN',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'FUNCTION', 'END_FUNCTION',
  'ARRAY',
  'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT',
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE',
])

const TWO_CHAR = new Set([':=', '=>', '<>', '<=', '>=', '..', '**'])
// `|` is no ST operator: it draws a contact inside a LADDER section (`|Start|`, ladder.ts), and `?` is an operand a
// rung being built has not been given yet (`|?|`). The parser refuses both anywhere else
const ONE_CHAR = new Set(['+', '-', '*', '/', '(', ')', '[', ']', '<', '>', '=', ',', ';', ':', '.', '|', '?'])

/** The text each token array was lexed from, for a reader that needs an operand as written (a ladder rung
 *  copies its operands into the ST it lowers to, so a diagnostic can point back at them). */
export const lexedSource = new WeakMap<readonly Token[], string>()

// Characters are classed by code, not by a regular expression: these run once per character of the program, and
// under the page's lockdown a regular expression's test costs several times what it does outside it (the lexer was
// 0.9 s of a 25,000-line program's 2 s read). An empty string (past the end) is no class at all.
const isLetterCode = (k: number): boolean => (k >= 65 && k <= 90) || (k >= 97 && k <= 122)
const isDigitCode = (k: number): boolean => k >= 48 && k <= 57
function isDigit(c: string): boolean {
  return isDigitCode(c.charCodeAt(0))
}
/** a digit, or the underscore that may stand between digits */
function isDigitPart(c: string): boolean {
  const k = c.charCodeAt(0)
  return isDigitCode(k) || k === 95
}
function isIdentStart(c: string): boolean {
  const k = c.charCodeAt(0)
  return isLetterCode(k) || k === 95
}
function isIdentPart(c: string): boolean {
  const k = c.charCodeAt(0)
  return isLetterCode(k) || isDigitCode(k) || k === 95
}

/** Milliseconds per duration unit: IEC 2nd edition's, the ones MATIEC (and so OpenPLC) reads. */
const DURATION_UNIT_MS: Readonly<Record<string, number>> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 }
/** IEC 3rd edition's finer units, for LTIME: refused, but read, so the error can offer the same value in ms. */
const LTIME_UNIT_MS: Readonly<Record<string, number>> = { us: 0.001, ns: 0.000_001 }
/** An IEC integer, underscores allowed between digits (`1_000`), with an optional fraction. */
const DURATION_NUMBER = /^\d(?:_?\d)*(?:\.\d(?:_?\d)*)?/

/**
 * Parse a duration literal body (after `T#`) into milliseconds, e.g. `1m30s` -> 90000, `-1s_500ms` -> -1500.
 * Milliseconds because that is TIME's representation everywhere it has to travel to.
 *
 * The whole body is read or the literal is refused, with the reason. Summing the pieces a regex
 * recognises and skipping the rest would count an unknown unit as nothing: `T#500us` would be 0 ms,
 * `T#1s500us` 1 s, `T#1d` 0 and `T#1_000ms` 0. A timer set that way fires at once, with no error.
 */
function parseDuration(body: string): number | { error: string } {
  let i = 0
  let sign = 1
  if (body[0] === '-' || body[0] === '+') {
    if (body[0] === '-') sign = -1
    i++
  }
  if (i >= body.length) return { error: 'a duration needs a value and a unit, such as T#500ms' }
  let total = 0
  let fine = false // written in us or ns
  while (i < body.length) {
    const num = DURATION_NUMBER.exec(body.slice(i))?.[0]
    if (num === undefined) return { error: `expected a number where "${body.slice(i)}" is` }
    i += num.length
    const unit = /^[A-Za-z]+/.exec(body.slice(i))?.[0]
    if (unit === undefined) return { error: `${num} needs a unit: d, h, m, s or ms` }
    i += unit.length
    const u = unit.toLowerCase()
    const scale = DURATION_UNIT_MS[u] ?? LTIME_UNIT_MS[u]
    if (scale === undefined) return { error: `${unit} is not a duration unit: use d, h, m, s or ms` }
    if (u in LTIME_UNIT_MS) fine = true
    total += Number(num.replace(/_/g, '')) * scale
    // an underscore may separate two parts (T#1s_500ms), but not end the literal
    if (body[i] === '_') {
      i++
      if (i >= body.length) return { error: 'a duration cannot end in "_"' }
    }
  }
  if (fine) {
    // us and ns are IEC 3rd edition, for LTIME. MATIEC and OpenPLC refuse them, and an exported literal is
    // written as it was typed, so taking them here would pass a program its PLC then rejects
    const ms = `${sign < 0 ? '-' : ''}${Number(total.toFixed(6))}ms`
    return { error: `microseconds (us) and nanoseconds (ns) are LTIME units, which TIME here does not take: write T#${ms} instead` }
  }
  return sign * total
}

/**
 * The tokens of `src`. A big text is lexed once and remembered for the few texts in play: an edit in the PLC panel
 * makes a dozen readers each ask something of the same new program (structure.ts), and the checker and the
 * compiler lex it again for themselves - 100 ms a time on a real 300 KB program. The array is shared, so it is
 * Frozen: nothing may reorder or splice it (the parser only ever reads it by index). Small texts - the snippets
 * ladder lowers through, a test's three lines - are not worth remembering, and would push the big one out.
 */
export function lex(src: string): Token[] {
  if (src.length < LEX_MEMO_MIN) return lexText(src)
  const at = lexed.findIndex((e) => e.src === src)
  if (at >= 0) {
    const hit = lexed[at]!
    if (at > 0) {
      lexed.splice(at, 1)
      lexed.unshift(hit)
    }
    return hit.toks
  }
  const toks = Object.freeze(lexText(src)) as Token[]
  lexed.unshift({ src, toks })
  if (lexed.length > 4) lexed.pop()
  return toks
}
const LEX_MEMO_MIN = 16384
const lexed: { src: string; toks: Token[] }[] = []

/**
 * A `{...}` pragma: what IEC leaves to the implementation. Pragmas are not tokens - no grammar rule mentions them, so
 * they may stand anywhere a comment may - they ride beside the tokens ({@link pragmasOf}), and the engine itself
 * gives none of them a meaning.
 */
export interface Pragma {
  /** what stands between the braces, trimmed */
  text: string
  pos: SourcePos
}

const PRAGMAS = new WeakMap<readonly Token[], readonly Pragma[]>()

/** The pragmas of a token list `lex` made, in source order. */
export function pragmasOf(toks: readonly Token[]): readonly Pragma[] {
  return PRAGMAS.get(toks) ?? []
}

function lexText(src: string): Token[] {
  const toks: Token[] = []
  const pragmas: Pragma[] = []
  PRAGMAS.set(toks, pragmas)
  let i = 0
  let line = 1
  let col = 1

  const here = (): SourcePos => ({ line, col, offset: i })
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++
        col = 1
      } else {
        col++
      }
      i++
    }
  }

  /** The digits of a based literal, rejecting any that the base can't hold (`2#1012`). */
  const digitsFor = (base: number): string => {
    const ok = base === 16 ? /[0-9a-fA-F_]/ : base === 8 ? /[0-7_]/ : /[01_]/
    let out = ''
    while (i < src.length && isIdentPart(src[i]!)) {
      if (!ok.test(src[i]!)) throw new StError(`'${src[i]}' is not a base-${base} digit`, here())
      out += src[i]
      advance()
    }
    return out
  }

  /**
   * One numeric literal body: a based form (`16#FF`, `2#1010_1010`, `8#17`) or a decimal
   * with an optional fraction and exponent (`42`, `1.5`, `1.0E-3`). `_` is a separator
   * everywhere, per IEC. Returns the raw text (for diagnostics) alongside the value.
   */
  const readNumber = (): { raw: string; num: number; real: boolean } => {
    let raw = ''
    while (i < src.length && isDigitPart(src[i]!)) {
      raw += src[i]
      advance()
    }
    if (src[i] === '#') {
      const base = Number(raw.replace(/_/g, ''))
      if (base !== 2 && base !== 8 && base !== 16) {
        throw new StError(`unsupported literal base '${raw}' (IEC allows 2, 8 and 16)`, here())
      }
      advance()
      const body = digitsFor(base)
      if (!body) throw new StError(`empty base-${base} literal`, here())
      return { raw: `${base}#${body}`, num: parseInt(body.replace(/_/g, ''), base), real: false }
    }
    let real = false
    if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
      real = true
      raw += src[i]
      advance()
      while (i < src.length && isDigitPart(src[i]!)) {
        raw += src[i]
        advance()
      }
    }
    if ((src[i] === 'e' || src[i] === 'E') && /[0-9+-]/.test(src[i + 1] ?? '')) {
      real = true
      raw += src[i]
      advance()
      if (src[i] === '+' || src[i] === '-') {
        raw += src[i]
        advance()
      }
      while (i < src.length && isDigitPart(src[i]!)) {
        raw += src[i]
        advance()
      }
    }
    return { raw, num: Number(raw.replace(/_/g, '')), real }
  }

  while (i < src.length) {
    const c = src[i]!

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance()
      continue
    }
    // line comment
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance()
      continue
    }
    // block comment
    if (c === '(' && src[i + 1] === '*') {
      const start = here()
      advance(2)
      while (i < src.length && !(src[i] === '*' && src[i + 1] === ')')) advance()
      if (i >= src.length) throw new StError('unterminated comment', start)
      advance(2)
      continue
    }
    // pragma (see Pragma): kept beside the tokens, not among them
    if (c === '{') {
      const start = here()
      advance()
      const from = i
      while (i < src.length && src[i] !== '}') advance()
      if (i >= src.length) throw new StError("unterminated pragma: expected '}'", start)
      pragmas.push({ text: src.slice(from, i).trim(), pos: start })
      advance()
      continue
    }
    // STRING literal: single-quoted, with IEC's `$` escapes. A literal never spans a line
    // (no target allows it), so an unterminated one is reported at its opening quote
    // instead of swallowing the rest of the program.
    if (c === "'") {
      const pos = here()
      advance()
      let out = ''
      for (;;) {
        if (i >= src.length || src[i] === '\n') throw new StError('unterminated string literal', pos)
        const ch = src[i]!
        if (ch === "'") {
          advance()
          break
        }
        if (ch === '$') {
          advance()
          const esc = src[i]
          if (esc === undefined) throw new StError('unterminated string literal', pos)
          const hex = src.substr(i, 2)
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16))
            advance(2)
            continue
          }
          const mapped = STRING_ESCAPES[esc.toUpperCase()] ?? STRING_ESCAPES[esc]
          if (mapped === undefined) throw new StError(`unknown string escape '$${esc}'`, here())
          out += mapped
          advance()
          continue
        }
        out += ch
        advance()
      }
      toks.push({ kind: 'str', value: out, raw: src.slice(pos.offset, i), num: 0, real: false, pos })
      continue
    }
    // A double-quoted literal is IEC's WSTRING form. It lexes far enough to say so by
    // name, because "unexpected character" would send an author hunting the wrong bug.
    if (c === '"') {
      throw new StError('double-quoted literals are WSTRING, which is not implemented; use a single-quoted STRING', here())
    }
    // number. A '.' is only part of the literal when a digit follows it, so a
    // range dot (`1..5`) and member access stay separate tokens.
    if (isDigit(c)) {
      const pos = here()
      const lit = readNumber()
      toks.push({ kind: 'num', value: lit.raw, num: lit.num, real: lit.real, pos })
      continue
    }
    // identifier / keyword / literal prefix
    if (isIdentStart(c)) {
      const pos = here()
      let id = ''
      while (i < src.length && isIdentPart(src[i]!)) {
        id += src[i]
        advance()
      }
      const up = id.toUpperCase()
      // a '#' turns the identifier into a literal prefix: a duration (T#5s, TIME#1m30s)
      // or a typed literal (INT#5, REAL#1.5, WORD#16#FF)
      if (src[i] === '#') {
        advance()
        if (up === 'T' || up === 'TIME') {
          let body = ''
          // IEC allows a sign straight after the '#' (T#-5s)
          if (src[i] === '-' || src[i] === '+') {
            body += src[i]
            advance()
          }
          while (i < src.length && /[0-9a-zA-Z._]/.test(src[i]!)) {
            body += src[i]
            advance()
          }
          const ms = parseDuration(body)
          if (typeof ms !== 'number') throw new StError(`${id}#${body}: ${ms.error}`, pos, i - pos.offset)
          toks.push({ kind: 'num', value: `T#${body}`, num: ms, real: true, type: 'TIME', pos })
          continue
        }
        // a calendar literal: D#2024-02-28, TOD#23:59:59.5, DT#2024-02-28-12:00:00. The body is every
        // character a date or a time of day is written with; what it means is parseCalendar's to say
        const calendar = CALENDAR_PREFIX[up]
        if (calendar !== undefined) {
          // a trailing '-' is the subtraction that follows (`D#2024-01-02-D#2024-01-01`): no literal ends in one
          const body = (/^[0-9:.-]*/.exec(src.slice(i))?.[0] ?? '').replace(/-+$/, '')
          advance(body.length)
          const ms = parseCalendar(calendar, body)
          if (typeof ms !== 'number') throw new StError(`${id}#${body}: ${ms.error}`, pos, i - pos.offset)
          toks.push({ kind: 'num', value: `${id}#${body}`, num: ms, real: true, type: calendar, pos })
          continue
        }
        if (TYPED_LITERAL_TYPES.has(up)) {
          let sign = 1
          if (src[i] === '-' || src[i] === '+') {
            if (src[i] === '-') sign = -1
            advance()
          }
          const lit = readNumber()
          toks.push({ kind: 'num', value: `${up}#${lit.raw}`, num: sign * lit.num, real: lit.real, type: up as ScalarType, pos })
          continue
        }
        // `Mode#Idle`: an enumeration value spelled with its type, IEC's way of saying which
        // enumeration a member belongs to. It lexes as the member, carrying the type as its
        // qualifier; whether that type is an enumeration at all is the checker's to say.
        if (isIdentStart(src[i] ?? '')) {
          let member = ''
          while (i < src.length && isIdentPart(src[i]!)) {
            member += src[i]
            advance()
          }
          toks.push({ kind: 'ident', value: member, qualifier: id, num: 0, real: false, pos })
          continue
        }
        throw new StError(`unknown literal prefix '${id}#'`, pos)
      }
      toks.push({ kind: KEYWORDS.has(up) ? 'kw' : 'ident', value: KEYWORDS.has(up) ? up : id, num: 0, real: false, pos })
      continue
    }
    // operators
    const two = src.substr(i, 2)
    if (TWO_CHAR.has(two)) {
      const pos = here()
      advance(2)
      toks.push({ kind: 'op', value: two, num: 0, real: false, pos })
      continue
    }
    if (ONE_CHAR.has(c)) {
      const pos = here()
      advance()
      toks.push({ kind: 'op', value: c, num: 0, real: false, pos })
      continue
    }
    // `&` is IEC's alternative spelling for `AND` - both are in the standard's own operator
    // table, and the standard's Annex F examples use it. It becomes an `AND` keyword token here
    // rather than an operator of its own, so the parser, the AST and both backends never need to
    // know which spelling the author typed. Nothing is lost on the way out either: the exporters
    // emit block text verbatim, so a `&` stays a `&` in an exported file.
    if (c === '&') {
      const pos = here()
      advance()
      toks.push({ kind: 'kw', value: 'AND', num: 0, real: false, pos })
      continue
    }
    // `^` dereferences: a REF_TO (`r^`), and `SUPER^`, which the parser takes.
    if (c === '^') {
      const pos = here()
      advance()
      toks.push({ kind: 'op', value: '^', num: 0, real: false, pos })
      continue
    }
    // `%` opens a direct address (`AT %IX0.0`): how a PLC names a physical I/O point. The token
    // carries the canonical spelling (core/io/iecAddress.ts), so `%i0.0` and `%IX0.0` are one point to
    // everything downstream; whether its shape is one this engine binds is the checker's question,
    // where the answer can be a positioned diagnostic rather than a failure to read the file.
    if (c === '%') {
      const pos = here()
      let raw = '%'
      advance()
      while (i < src.length && /[A-Za-z]/.test(src[i]!)) {
        raw += src[i]
        advance()
      }
      while (i < src.length && /[0-9.*]/.test(src[i]!)) {
        // a `..` is a range operator, never part of an address
        if (src[i] === '.' && src[i + 1] === '.') break
        raw += src[i]
        advance()
      }
      // `Status.%X3`: IEC's spelling of one bit of an integer (partial access), which is what the
      // exporters write for the short form `Status.3`. It lexes as the bit number; the parser, standing
      // after a `.`, makes the same `bit` place of both spellings.
      if (/^%X\d+$/i.test(raw)) {
        toks.push({ kind: 'num', value: raw, num: Number(raw.slice(2)), real: false, pos })
        continue
      }
      if (!/^%[IQM][XBWDL]?(?:\d+(?:\.\d+)*|\*)$/i.test(raw)) {
        throw new StError(`'${raw}' is not a direct address; one reads like %IX0.0 (input bit), %QX0.0 (output bit) or %IW0 (input word)`, pos, raw.length)
      }
      const canonical = canonicalAddress(raw)
      toks.push({ kind: 'addr', value: canonical ?? raw.toUpperCase(), raw, num: 0, real: false, pos })
      continue
    }
    throw new StError(`unexpected character '${c}'`, here())
  }

  toks.push({ kind: 'eof', value: '', num: 0, real: false, pos: here() })
  lexedSource.set(toks, src)
  return toks
}

/**
 * Every value reference in the source - a variable, or a function-block member access
 * `inst.member` collapsed into one reference (`OnDelay.Q`) - with its name and exact
 * source range. For inline value overlays (live values drawn beside the code while it runs);
 * the range's `to` is where a value box is anchored. Comments and operators are skipped
 * (the lexer never emits them). Returns `[]` when the source can't be lexed (e.g. a
 * mid-edit syntax error), so an overlay shows nothing until it parses again.
 */
export function valueRefs(source: string): { name: string; from: number; to: number }[] {
  let toks: Token[]
  try {
    toks = lex(source)
  } catch {
    return []
  }
  const out: { name: string; from: number; to: number }[] = []
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]!
    if (tk.kind !== 'ident' || tk.qualifier !== undefined) continue // `Mode#Idle` is a constant, not a variable
    const dot = toks[i + 1]
    const member = toks[i + 2]
    if (dot && dot.kind === 'op' && dot.value === '.' && member && member.kind === 'ident') {
      // FB member access: one reference spanning inst..member (e.g. OnDelay.Q)
      out.push({ name: `${tk.value}.${member.value}`, from: tk.pos.offset, to: member.pos.offset + member.value.length })
      i += 2
    } else {
      out.push({ name: tk.value, from: tk.pos.offset, to: tk.pos.offset + tk.value.length })
    }
  }
  return out
}
