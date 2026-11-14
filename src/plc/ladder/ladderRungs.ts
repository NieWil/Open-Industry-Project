// Ladder as a view edits it: rungs read out of the program text as plain data, and printed back into it.
//
// The source string is the one truth (document.ts). A ladder view is a round trip over it: `readLadder` gives it
// rungs, a gesture changes them (ladderEdit.ts), `writeLadder` prints them back into the same string, which then
// saves, undoes and reaches a room like typing, because it is an edit to the text. Nothing here runs anything: the
// parser (parserLadder.ts `ladderSection`) and the lowering (ladder.ts) are what make a rung mean something.
//
// A rung's comment is the comment written above it in the text, so it survives every tool that reads the program as
// ST; operands are kept as the author's text, not as expressions.

import { lex } from '../lexer'
import type { LdCoilMode, LdContactMode, LdElement, LdSection } from './ladder'
import { builtinFbInfo, builtinFunctionInfo, printExit } from './ladder'
import { parse } from '../parser'
import { parseStructure } from '../structure'
import type { RungElementOf, RungOf } from './ladderEdit'
import type { Diagnostic } from '../types'

/** A contact, a coil or a box, as a view edits it: operands are the author's text; `?` is one not named yet. */
export type RungItem =
  | { type: 'contact'; mode: LdContactMode; operand: string; edge?: string }
  | { type: 'coil'; mode: LdCoilMode; operand: string }
  | {
      type: 'box'
      head: string
      func: boolean
      pins: RungPin[]
      /** lowering's (ladder.ts LdBox): `input` null for a function whose result starts the rung, whose value this scan
       *  is in the temporary `result` */
      resolved?: { type: string; input: string | null; output: string; inputs?: readonly string[]; outputs?: readonly string[] }
      result?: string
    }

/** A box's parameter: `value` null is a bare pin, the one on the rung. */
export interface RungPin {
  name: string
  value: string | null
  out: boolean
}

/** IEC's rungs: the shared rung core's (ladderEdit.ts), over IEC's leaf, a contact, a coil or a box. */
export type RungElement = RungElementOf<RungItem>
export type Rung = RungOf<RungItem>


/** One `LADDER ... END_LADDER` of a program, as a view shows it. */
export interface LadderRoutine {
  /** the POU it stands in: a PROGRAM, FUNCTION_BLOCK or FUNCTION's name; '' for the code outside every POU */
  pou: string
  /** it is its POU's whole body (the POU is a ladder diagram) */
  whole: boolean
  rungs: Rung[]
  /** `[start, end)` of the section in the source */
  start: number
  end: number
  /**
   * Text inside the section that does not read as a rung. `writeLadder` reprints the section from `rungs`, which
   * would drop that text, so a view must not edit while this is non-empty: the author fixes it as text first. (A rung
   * that reads but does not compile, a blank `?` in it say, is not here: it is in `rungs`, and in `rungProblems`.)
   */
  unreadable: Diagnostic[]
  /** the problems inside each rung; `rungProblems[i]` belongs to `rungs[i]` */
  rungProblems: Diagnostic[][]
  /** Which element each of those is about: `rungProblemTrails[i][k]` is the trail, inside rung `i`, of the element
   *  `rungProblems[i][k]` points into (null when none) - so the sheet marks, and a fault's "Show" selects, the element */
  rungProblemTrails: (number[] | null)[][]
}

/** The trail of the element that text offset `at` falls in: the last one, in reading order, that starts at or before
 *  it (an element's text runs up to the next one's, so that is the one holding the offset). */
function trailAt(els: readonly LdElement[], at: number): number[] | null {
  let found: { start: number; trail: number[] } | null = null
  const walk = (list: readonly LdElement[], home: number[]): void => {
    list.forEach((el, i) => {
      if (el.kind === 'branch') el.paths.forEach((p, k) => walk(p, [...home, i, k]))
      else if (el.pos.offset <= at && (!found || el.pos.offset >= found.start)) found = { start: el.pos.offset, trail: [...home, i] }
    })
  }
  walk(els, [])
  return (found as { start: number; trail: number[] } | null)?.trail ?? null
}

function elementsOf(els: readonly LdElement[]): RungElement[] {
  return els.map((el): RungElement => {
    switch (el.kind) {
      case 'branch':
        return { type: 'branch', paths: el.paths.map(elementsOf) }
      case 'contact':
        return { type: 'contact', mode: el.mode, operand: el.operand.text, ...(el.edge ? { edge: el.edge } : {}) }
      case 'coil':
        return { type: 'coil', mode: el.mode, operand: el.operand.text }
      case 'box':
        return {
          type: 'box',
          head: el.head.text,
          func: el.func,
          pins: el.pins.map((p) => ({ name: p.name, value: p.value === null ? null : p.value.text, out: p.out })),
          ...(el.resolved ? { resolved: el.resolved } : {}),
          ...(el.result ? { result: el.result } : {}),
        }
    }
  })
}

function routine(s: LdSection, all: readonly Diagnostic[]): LadderRoutine {
  const problems = all.filter((d) => d.pos.offset >= s.start && d.pos.offset < s.end)
  const rungs = s.rungs.map((r) => {
    const rung: Rung = {
      comment: r.comment ?? '',
      elements: elementsOf(r.elements),
      ...(r.label ? { label: r.label.name } : {}),
      ...(r.exit ? { exit: r.exit.kind === 'jump' ? { kind: 'jump' as const, label: r.exit.label } : { kind: 'return' as const } } : {}),
    }
    return rung
  })
  const within = (d: Diagnostic, r: LdSection['rungs'][number]): boolean => d.pos.offset >= r.start && d.pos.offset < r.end
  // a problem outside every rung that was read is text that did not read as one
  const unreadable = problems.filter((d) => !s.rungs.some((r) => within(d, r)))
  const rungProblems = s.rungs.map((r) => problems.filter((d) => within(d, r)))
  const rungProblemTrails = s.rungs.map((r, i) => rungProblems[i]!.map((d) => trailAt(r.elements, d.pos.offset)))
  return { pou: s.pou, whole: s.whole, rungs, start: s.start, end: s.end, unreadable, rungProblems, rungProblemTrails }
}

/**
 * Every ladder section of a program, in source order. Never throws: a program that does not lex, or whose section
 * has no END_LADDER yet, has no routine to show. `checked` is what a caller already knows is wrong with the program
 * (checker.ts `diagnostics`), since type errors are found there, not in a parse, and a view wants them on their rung.
 */
export function readLadder(source: string, checked: readonly Diagnostic[] = []): LadderRoutine[] {
  try {
    // (the parse is shared with every other reader of this text - structure.ts - so its notes are copied before the
    // checker's are added to them)
    const structure = parseStructure(source)
    if (!structure.ast) return []
    const sink: Diagnostic[] = [...structure.notes]
    const sections = structure.ast.ladder
    const seen = new Set(sink.map((d) => `${d.pos.offset}:${d.message}`))
    for (const d of checked) if (!seen.has(`${d.pos.offset}:${d.message}`)) sink.push(d)
    return sections.map((s) => routine(s, sink))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const CONTACT_MARK: Record<LdContactMode, string> = { open: '', closed: '/', rising: 'P ', falling: 'N ' }
const COIL_MARK: Record<LdCoilMode, string> = { normal: '', negated: '/', set: 'S ', reset: 'R ', rising: 'P ', falling: 'N ' }

/** Elements as rung text, series by juxtaposition: what a copy of a run of elements is. */
export function printElements(els: readonly RungElement[]): string {
  return els
    .map((el) => {
      switch (el.type) {
        case 'branch':
          return `[${el.paths.map(printElements).join(', ')}]`
        case 'contact':
          return `|${CONTACT_MARK[el.mode]}${el.operand.trim() || '?'}|`
        case 'coil':
          return `(${COIL_MARK[el.mode]}${el.operand.trim() || '?'})`
        case 'box':
          return `${el.head.trim() || '?'}(${el.pins.map((p) => (p.value === null ? p.name : `${p.name} ${p.out ? '=>' : ':='} ${p.value.trim() || '?'}`)).join(', ')})`
      }
    })
    .join(' ')
}

export function printRung(rung: Rung): string {
  return [rung.label ? `${rung.label}:` : '', printElements(rung.elements), rung.exit ? printExit(rung.exit) : ''].filter(Boolean).join(' ')
}

/** A whole `LADDER ... END_LADDER` section, its rungs indented under it. */
export function printLadder(rungs: readonly Rung[], indent = ''): string {
  const lines: string[] = [`${indent}LADDER`]
  for (const r of rungs) {
    for (const line of r.comment === '' ? [] : r.comment.split('\n')) lines.push(`${indent}  (* ${line.replace(/\*\)/g, '* )')} *)`)
    lines.push(`${indent}  ${printRung(r)};`)
  }
  lines.push(`${indent}END_LADDER`)
  return lines.join('\n')
}

/** `source` with ladder section `index` reprinted from `rungs`. Unchanged when there is no such section, like every
 *  other structural edit (document.ts). */
export function writeLadder(source: string, index: number, rungs: readonly Rung[]): string {
  const target = readLadder(source)[index]
  if (!target) return source
  const lineStart = source.lastIndexOf('\n', target.start - 1) + 1
  const lead = source.slice(lineStart, target.start)
  const indent = /^\s*$/.test(lead) ? lead : ''
  // the first line is already indented by what precedes the section
  return source.slice(0, target.start) + printLadder(rungs, indent).slice(indent.length) + source.slice(target.end)
}

/**
 * Rung text as a paste or a retyped rung holds it: whole rungs (text with `;`) or a run of elements. Null when it does
 * not read as ladder. Blanks (`?`) read, as they do in a section.
 */
export function parseRungText(text: string): { kind: 'rungs'; rungs: Rung[] } | { kind: 'elements'; elements: RungElement[] } | null {
  let t = text.trim()
  if (t === '') return null
  const asRungs = t.includes(';')
  if (!asRungs) t += ';'
  const [r] = readLadder(`LADDER\n${t}\nEND_LADDER`)
  if (!r || r.unreadable.length > 0 || r.rungs.length === 0) return null
  if (asRungs) return { kind: 'rungs', rungs: r.rungs }
  if (r.rungs.length !== 1) return null
  // a label or a jump / RETURN is the rung's, not a run of elements: such text is one whole rung
  const [one] = r.rungs
  return one!.label !== undefined || one!.exit !== undefined ? { kind: 'rungs', rungs: r.rungs } : { kind: 'elements', elements: one!.elements }
}

/** Why `text` cannot be an operand (a variable, a pin's value), in a sentence, or null when it can. The field refuses
 *  it rather than writing text the rung cannot read, which would make the whole section uneditable. */
export function operandProblem(text: string, place: boolean): string | null {
  const t = text.trim()
  if (t === '' || t === '?') return null
  const probe = place ? `|${t}|;` : `?(X := ${t});`
  const r = readLadder(`LADDER\n${probe}\nEND_LADDER`)[0]
  if (!r || r.unreadable.length > 0 || r.rungs.length !== 1) {
    return place ? `'${t}' is not a variable a rung can name (a name, a field, an array element)` : `'${t}' does not read as a value`
  }
  return null
}

// ---------------------------------------------------------------------------
// New elements, as a palette makes them
// ---------------------------------------------------------------------------

/** What a palette button puts on a rung. A block gets an instance of its own, declared (see `declareInstance`). */
export type NewItem =
  | { kind: 'contact'; mode: LdContactMode }
  | { kind: 'coil'; mode: LdCoilMode }
  | { kind: 'block'; type: string }
  | { kind: 'function'; name: string }
  /** a comparison that starts the rung with its result (`EQ(IN1 := ?, IN2 := ?, OUT)`) */
  | { kind: 'compare'; name: string }

/** The inputs a new block is drawn with: every one but the pin on the rung, blank; a timer's PT and a counter's PV
 *  are what the author has to give, and the reset pins are left off (they default FALSE). */
const NEW_BLOCK_PINS: Record<string, string[]> = { TON: ['PT'], TOF: ['PT'], TP: ['PT'], CTU: ['PV'], CTD: ['PV'], CTUD: ['CD', 'PV'] }

/** The element a palette button makes, with `head` as a block's instance name. */
export function newItem(item: NewItem, head = '?'): RungItem {
  switch (item.kind) {
    case 'contact':
      return { type: 'contact', mode: item.mode, operand: '?' }
    case 'coil':
      return { type: 'coil', mode: item.mode, operand: '?' }
    case 'block': {
      const info = builtinFbInfo(item.type)
      const input = info?.inputs.find((p) => p.bool)?.name ?? 'IN'
      return { type: 'box', head, func: false, pins: [{ name: input, value: null, out: false }, ...(NEW_BLOCK_PINS[item.type.toUpperCase()] ?? []).map((name) => ({ name, value: '?', out: false }))] }
    }
    case 'function': {
      const info = builtinFunctionInfo(item.name)
      const inputs = info?.inputs.map((p) => p.name) ?? ['IN']
      return { type: 'box', head: item.name.toUpperCase(), func: true, pins: [...inputs.map((name) => ({ name, value: '?', out: false })), { name: 'OUT', value: '?', out: true }] }
    }
    case 'compare': {
      const inputs = builtinFunctionInfo(item.name)?.inputs.map((p) => p.name) ?? ['IN1', 'IN2']
      return { type: 'box', head: item.name.toUpperCase(), func: true, pins: [...inputs.map((name) => ({ name, value: '?', out: false })), { name: 'OUT', value: null, out: false }] }
    }
  }
}

/** A name for a new instance of `type` (`TON_1`, `PalletTruck_1`, spelled as the type is) that nothing in `source`
 *  spells, in any case. */
export function freshInstanceName(source: string, type: string): string {
  const spelled = new Set((source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((w) => w.toUpperCase()))
  for (let n = 1; ; n++) {
    const name = `${type}_${n}`
    if (!spelled.has(name.toUpperCase())) return name
  }
}

/**
 * `source` with `name : type;` declared in the POU ladder section `index` stands in: in the last plain VAR block before
 * its statements, or in a new one there. That is where a block drawn on a rung keeps its state: an instance
 * declared like any other variable of the POU.
 */
export function declareInstance(source: string, index: number, name: string, type: string): string {
  const s = parse(lex(source), []).ladder[index]
  if (!s) return source
  const at = s.declEnd
  const before = source.slice(0, at)
  const end = before.search(/END_VAR\s*;?\s*$/i)
  if (end >= 0) {
    // the block that END_VAR closes: a plain VAR takes the line, anything else (VAR_INPUT...) gets a VAR block of its own
    const open = [...before.slice(0, end).matchAll(/\b(VAR(?:_[A-Z_]+)?)\b/gi)].pop()
    if (open && open[1]!.toUpperCase() === 'VAR' && !/CONSTANT/i.test(before.slice(open.index!, end).split('\n')[0]!)) {
      const lineStart = before.lastIndexOf('\n', end - 1) + 1
      // `VAR a : BOOL; END_VAR` on one line takes it on that line; a block laid out a line each, on a line of its own
      if (before.slice(lineStart, end).trim() !== '') return `${source.slice(0, end)}${name} : ${type}; ${source.slice(end)}`
      return `${source.slice(0, lineStart)}  ${name} : ${type};\n${source.slice(lineStart)}`
    }
  }
  const lineStart = source.lastIndexOf('\n', at - 1) + 1
  const indent = /^\s*$/.test(source.slice(lineStart, at)) ? source.slice(lineStart, at) : ''
  return `${source.slice(0, at)}VAR\n${indent}  ${name} : ${type};\n${indent}END_VAR\n${indent}${source.slice(at)}`
}

