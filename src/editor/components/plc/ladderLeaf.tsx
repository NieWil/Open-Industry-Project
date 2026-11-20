// IEC 61131-3 ladder as the ladder sheet (LadderView.tsx) draws and edits it: contacts, coils and boxes read out of
// the program's text (plc/ladder/ladderRungs.ts), each drawn as one of three shapes (a contact, a coil or a box), the element
// bar's palette, the Insert Box catalogue, and the declaration pane above a POU's rungs.
//
// The sheet owns the layout and the gestures; what it needs to know about a leaf comes from here, as pure data and
// functions, so it can be tested without a view (ladderLeaf.test.ts).
//
// Power flow is recomputed from the variable image the running program publishes: each contact from its variable, an
// edge contact from the temporary that holds whether it passes this scan (the lowering names it), a box from its
// output. It is a display, not the engine's own answer.

import { useState, type ReactElement } from 'react'
import { elementAt, insertItem, type LadderSel } from '../../../plc/ladder/ladderEdit'
import { builtinFbInfo } from '../../../plc/ladder/ladder'
import { catalogSignature, insertCatalogEntry, ladderCatalog, type CatalogEntry } from '../../../plc/ladder/ladderCatalog'
import { rankByWanted } from '../../../plc/ladder/ladderComplete'
import { connectPin, fieldsOf, fieldWants, iecTypes, setField, typeAt, IEC_LEAVES, IEC_REFS } from '../../../plc/ladder/ladderLeaves'
import { declareInstance, newItem, operandProblem, parseRungText, printElements, printRung, readLadder, writeLadder, type LadderRoutine, type NewItem, type RungElement, type RungItem } from '../../../plc/ladder/ladderRungs'
import { listTags, sectionDeclarations, type TagRow, type TagScope } from '../../../plc/tags'
import type { Diagnostic, TagValue } from '../../../plc/types'
import { listUdts } from '../../../plc/udt'
import { LadderVariables } from './LadderVariables'
import { FoldIcon } from '../toolbarIcons'
import { defineMessages, t, type MessageId } from '../../../core/i18n'

const M = defineMessages('ladderLeaf', {
  blockTitle: '{type}: a block of its own on the rung, declared in this program as {type}_n',
  tabContacts: 'Contacts & coils',
  groupContacts: 'Contacts',
  contactNo: 'Contact: passes power while its variable is TRUE',
  contactNc: 'Normally closed contact: passes power while its variable is FALSE',
  contactP: 'Rising-edge contact: passes power for one scan after its variable goes TRUE',
  contactN: 'Falling-edge contact: passes power for one scan after its variable goes FALSE',
  groupCoils: 'Coils',
  coil: 'Coil: writes the rung to its variable, every scan',
  coilNegated: 'Negated coil: writes the inverse of the rung',
  coilSet: 'Set coil: sets its variable while the rung is on, and it stays set',
  coilReset: 'Reset coil: clears its variable while the rung is on',
  coilP: 'Rising-edge coil: its variable is TRUE for one scan after the rung goes on (not every PLC has one)',
  coilN: 'Falling-edge coil: its variable is TRUE for one scan after the rung goes off (not every PLC has one)',
  tabTimers: 'Timers & counters',
  groupTimers: 'Timers',
  groupCounters: 'Counters',
  groupEdges: 'Edges and bistables',
  tabMath: 'Math & compare',
  groupMath: 'Math',
  mathTitle: '{name}: runs while the rung is on (EN), its result goes where OUT points, and the rung carries on (ENO)',
  groupCompare: 'Comparisons',
  compareTitle: '{name}: starts the rung with IN1 {op} IN2, so it goes first on the rung, with contacts, blocks and coils after it',
  tipStarts: '{head}: its result starts the rung, so it stands at the left rail',
  tipFunction: '{head}: runs while the rung is on (EN), passes it on (ENO)',
  tipBlock: '{head}: a {type} on the rung',
  elementGone: 'That element is no longer there',
  sectionGone: 'That section is no longer there',
  inPou: 'in {pou}',
  inPouBesideSt: 'in {pou}, beside Structured Text',
  theProgram: 'the program',
  varsHint: 'The variables {pou} declares: read, add, retype and delete them here',
  variables: 'Variables',
  declare: 'Declare {name} : BOOL',
  declareHint: 'Declare {name} as a BOOL of this program (a VAR): a scene part wired to it by name then connects to it',
})

/** The power on a link while the program runs; null when nothing runs. */
export type Power = boolean | null

/** A variable's live value, by the text a rung spells it with. */
export type ValueOf = (text: string) => TagValue | undefined

/** A contact or a coil: a variable above a symbol. Field 0 is the variable. */
export interface SymbolShape {
  kind: 'contact' | 'coil'
  /** what the element is, for the DOM (`data-mode`): the contact or coil mode */
  mode: string
  tag: string
  /** the letter in the symbol (`P`, `S`), '' for none */
  mark: string
  /** a normally closed contact's slash */
  slash: boolean
  /** drawn lit, while the program runs, when the variable `text` reads `when` */
  lit: { text: string; when: boolean }
  title?: string
}

/** A row of a box: a pin, with the field that holds its text. */
export interface BoxRow {
  /** stable within the box */
  key: string
  name: string
  /** the field this row edits; -1 for a row with no text of its own */
  field: number
  /** what is written there; null for a bare pin */
  text: string | null
  /** an output: the value goes out of the box */
  out: boolean
  /** the pin the rung enters or leaves the box by */
  rung: boolean
  /** what the row shows live: the variable whose value it prints, `pin` for the power on the box's left link, null for nothing */
  watch: string | 'pin' | null
  /** a pin nothing connects yet, which the sheet connects through `connectPin` */
  connect?: { pin: string; out: boolean }
}

/** A box: a block or a function. */
export interface BoxShape {
  kind: 'box'
  /** what the element is, for the DOM (`data-mode`) */
  mode?: string
  title: string
  /** the field the title is: a function's name (0); null for a block, whose title is its type */
  titleField: number | null
  /** a block's instance name, drawn above the title, field `field` */
  instance: { field: number; text: string } | null
  rows: BoxRow[]
  /** it starts the rung: nothing leads into it, and it is lit by what it returns (a comparison) */
  starts: boolean
  tip: string
}

export type LeafShape = SymbolShape | BoxShape

/** One entry of the element bar. */
export interface PaletteEntry {
  key: string
  /** the symbol or the instruction name, drawn as it is */
  label: string
  /** a message id, resolved with `titleParams` where the bar renders */
  title: MessageId
  titleParams?: Readonly<Record<string, string>>
}

/** One choice of the Insert Box picker (BoxPicker.tsx): a block or function that can go on a rung. */
export interface BoxChoice {
  /** what `insert` is handed back */
  key: string
  name: string
  /** the heading it is listed under */
  group: string
  summary: string
  /** its pins in one line: `(IN, PT) -> Q, ET` */
  signature: string
}

/** What an insertion from the element bar made: the whole program, what to select, and which field to open on it. */
export interface Inserted {
  source: string
  sel: LadderSel | null
  field: number | null
}

/** Suggestions for the field being typed (plc/ladder/ladderComplete.ts): names in the order the field wants them, and a
 *  name's members in that order. */
export interface TypeAhead {
  names: string[]
  membersOf: (base: string) => string[]
}

/** A one-click fix offered under a rung's problem: declare the variable a contact or coil names. */
export interface QuickFix {
  label: string
  title: string
  testid: string
  /** the program with the fix made */
  apply: (source: string) => string
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CONTACT_MARK = { open: '', closed: '', rising: 'P', falling: 'N' } as const
const COIL_MARK = { normal: '', negated: '/', set: 'S', reset: 'R', rising: 'P', falling: 'N' } as const

// ---- the element bar ---------------------------------------------------------------------------------------------

/** A palette entry, and what it puts on the rung. */
interface Entry extends PaletteEntry {
  item: NewItem
}

/** A block from the standard library, on a rung of its own. */
const blockEntry = (type: 'TON' | 'TOF' | 'TP' | 'CTU' | 'CTD' | 'CTUD' | 'R_TRIG' | 'F_TRIG' | 'SR' | 'RS'): Entry => ({
  key: type,
  label: type,
  title: M.blockTitle,
  titleParams: { type },
  item: { kind: 'block', type },
})

/** The element bar's tabs: what a rung is mostly made of first, then the blocks and the functions. Each tab is a
 *  handful of named groups rather than one run of chips, because the difference between them is the thing an author
 *  needs to see without hovering: a contact reads a variable and a coil writes one; a function runs on the rung's
 *  power and a comparison starts the rung. Drawn one boxed group per kind (.ld-pal-group). */
/** `tab` is the tab's stable key (its test id); `label`s and entry titles are message ids, resolved where the bar
 *  renders. */
const PALETTE: readonly { tab: string; label: MessageId; groups: readonly { label: MessageId; items: readonly Entry[] }[] }[] = [
  {
    tab: 'Contacts & coils', // i18n-ok: stable key, in e2e test ids
    label: M.tabContacts,
    groups: [
      {
        label: M.groupContacts,
        items: [
          { key: 'no', label: '| |', title: M.contactNo, item: { kind: 'contact', mode: 'open' } },
          { key: 'nc', label: '|/|', title: M.contactNc, item: { kind: 'contact', mode: 'closed' } },
          { key: 'p', label: '|P|', title: M.contactP, item: { kind: 'contact', mode: 'rising' } },
          { key: 'n', label: '|N|', title: M.contactN, item: { kind: 'contact', mode: 'falling' } },
        ],
      },
      {
        label: M.groupCoils,
        items: [
          { key: 'coil', label: '( )', title: M.coil, item: { kind: 'coil', mode: 'normal' } },
          { key: 'ncoil', label: '(/)', title: M.coilNegated, item: { kind: 'coil', mode: 'negated' } },
          { key: 's', label: '(S)', title: M.coilSet, item: { kind: 'coil', mode: 'set' } },
          { key: 'r', label: '(R)', title: M.coilReset, item: { kind: 'coil', mode: 'reset' } },
          { key: 'pc', label: '(P)', title: M.coilP, item: { kind: 'coil', mode: 'rising' } },
          { key: 'nco', label: '(N)', title: M.coilN, item: { kind: 'coil', mode: 'falling' } },
        ],
      },
    ],
  },
  {
    tab: 'Timers & counters', // i18n-ok: stable key, in e2e test ids
    label: M.tabTimers,
    groups: [
      { label: M.groupTimers, items: (['TON', 'TOF', 'TP'] as const).map(blockEntry) },
      { label: M.groupCounters, items: (['CTU', 'CTD', 'CTUD'] as const).map(blockEntry) },
      { label: M.groupEdges, items: (['R_TRIG', 'F_TRIG', 'SR', 'RS'] as const).map(blockEntry) },
    ],
  },
  {
    tab: 'Math & compare', // i18n-ok: stable key, in e2e test ids
    label: M.tabMath,
    groups: [
      {
        label: M.groupMath,
        items: (['MOVE', 'ADD', 'SUB', 'MUL', 'DIV'] as const).map((f) => ({
          key: f,
          label: f,
          title: M.mathTitle,
          titleParams: { name: f },
          item: { kind: 'function', name: f } as const,
        })),
      },
      {
        label: M.groupCompare,
        items: ([['GT', '>'], ['GE', '>='], ['EQ', '='], ['NE', '<>'], ['LE', '<='], ['LT', '<']] as const).map(([f, op]) => ({
          key: f,
          label: f,
          title: M.compareTitle,
          titleParams: { name: f, op },
          item: { kind: 'compare', name: f } as const,
        })),
      },
    ],
  },
]
const ENTRIES = new Map(PALETTE.flatMap((tab) => tab.groups.flatMap((g) => g.items.map((e) => [e.key, e] as const))))

// ---- the leaf ----------------------------------------------------------------------------------------------------

type Box = Extract<RungItem, { type: 'box' }>

/** The rows a box is drawn with: each pin as written, the pin the rung leaves by when it is left implicit (Q), and a
 *  standard block's other outputs whether written or not - IEC draws every pin, and a TON's ET or a counter's CV is
 *  the one thing that moves while it runs. A bare pin (`rung`) is the one the rung enters or leaves by; it is the
 *  one it leaves by when lowering says so (`C1(R, CU := x, Q)`, a comparison's `OUT`). The pin the rung leaves by
 *  may be written as well (`Clear => caseClear` on a muting block the rung leaves by Clear): that is one pin, drawn
 *  once, with its variable and as the rung's exit. A block's pins nothing connects are drawn too, its inputs after the
 *  inputs written and its outputs last, marked `open`: a view connects one from there (`connectPin`). */
type PinRow = { name: string; value: string | null; out: boolean; field: number; rung: boolean; open?: true }
function boxRows(el: Box): PinRow[] {
  let field = 0
  const leaves = (name: string): boolean => name.toUpperCase() === el.resolved?.output.toUpperCase()
  const bare = el.pins.some((p) => p.value === null && leaves(p.name))
  const rows: PinRow[] = el.pins.map((p) => ({
    name: p.name,
    value: p.value,
    out: p.out || (p.value === null && leaves(p.name)),
    field: p.value === null ? -1 : ++field,
    rung: p.value === null || (!bare && p.out && leaves(p.name)),
  }))
  const out = el.resolved?.output
  if (out && !rows.some((r) => r.rung && r.out && leaves(r.name))) rows.push({ name: out, value: null, out: true, field: -1, rung: true })
  if (el.func || !el.resolved) return rows
  // every pin the block's type declares (lowering lists them, a program's own block's too), whether written or not
  const fb = builtinFbInfo(el.resolved.type)
  const inputs = el.resolved.inputs ?? fb?.inputs.map((p) => p.name) ?? []
  const outputs = el.resolved.outputs ?? fb?.outputs.map((p) => p.name) ?? []
  const has = (name: string): boolean => el.pins.some((p) => p.name.toUpperCase() === name.toUpperCase()) || rows.some((r) => r.name.toUpperCase() === name.toUpperCase())
  const openIns = inputs.filter((n) => !has(n)).map((name) => ({ name, value: null, out: false, field: -1, rung: false, open: true as const }))
  let lastIn = -1
  rows.forEach((r, i) => {
    if (!r.out) lastIn = i
  })
  rows.splice(lastIn + 1, 0, ...openIns)
  for (const name of outputs) if (!has(name)) rows.push({ name, value: null, out: true, field: -1, rung: false, open: true })
  return rows
}

/** A function whose result starts the rung (a comparison): nothing feeds it, and what it returned lights it. */
const starts = (el: Box): boolean => el.func && el.resolved?.input === null

function shape(el: RungItem): LeafShape {
  if (el.type === 'box') {
    const title = el.func ? el.head : (el.resolved?.type ?? '?')
    const first = starts(el)
    const rows: BoxRow[] = boxRows(el).map((r) => ({
      key: `${r.name}${r.out ? '>' : '<'}`,
      name: r.name,
      field: r.field,
      text: r.value,
      out: r.out,
      rung: r.rung,
      ...(r.open ? { connect: { pin: r.name, out: r.out } } : {}),
      // the pin the rung feeds a block by carries the power that reaches it: a block's image holds no inputs
      watch: r.value !== null ? r.value : first && r.out ? (el.result ?? '') : el.func || (r.open && !r.out) ? null : r.rung && !r.out ? 'pin' : `${el.head}.${r.name}`,
    }))
    return {
      kind: 'box',
      title,
      titleField: el.func ? 0 : null,
      instance: el.func ? null : { field: 0, text: el.head },
      rows,
      starts: first,
      tip: first ? t(M.tipStarts, { head: el.head }) : el.func ? t(M.tipFunction, { head: el.head }) : t(M.tipBlock, { head: el.head, type: title }),
    }
  }
  if (el.type === 'contact') {
    const edge = el.mode === 'rising' || el.mode === 'falling'
    // drawn TRUE the way an IEC editor draws it online: a contact that is closed; an edge contact by whether it passes
    return { kind: 'contact', mode: el.mode, tag: el.operand, mark: CONTACT_MARK[el.mode], slash: el.mode === 'closed', lit: edge ? { text: el.edge ?? '', when: true } : { text: el.operand, when: el.mode !== 'closed' } }
  }
  // a coil whose variable is set
  return { kind: 'coil', mode: el.mode, tag: el.operand, mark: COIL_MARK[el.mode], slash: false, lit: { text: el.operand, when: true } }
}

function powerOut(el: RungItem, pin: Power, valueOf: ValueOf): Power {
  if (pin === null) return null
  switch (el.type) {
    case 'coil':
      return pin
    case 'contact': {
      if (el.mode === 'rising' || el.mode === 'falling') return pin && valueOf(el.edge ?? '') === true
      const v = valueOf(el.operand)
      return typeof v === 'boolean' ? pin && (el.mode === 'closed' ? !v : v) : false
    }
    case 'box': {
      // a function that starts the rung: what it returned this scan, which lowering keeps in a temporary
      if (starts(el)) return valueOf(el.result ?? '') === true
      const out = el.resolved?.output
      if (el.func || !out || out.toUpperCase() === 'ENO') return pin
      return valueOf(`${el.head}.${out}`) === true
    }
  }
}

function watchTexts(el: RungItem): string[] {
  if (el.type !== 'box') return el.type === 'contact' && el.edge ? [el.operand, el.edge] : [el.operand] // an edge contact passes on a temporary
  const out: string[] = []
  if (el.result) out.push(el.result) // a function that starts the rung is lit by what it returned
  const pin = el.resolved?.output
  if (pin) out.push(`${el.head}.${pin}`) // the pin the rung leaves a block by
  for (const row of boxRows(el)) out.push(row.value ?? `${el.head}.${row.name}`)
  return out
}

/** Whether field `field` of `el` names a place (a contact's or coil's variable, a block instance, an output's target)
 *  rather than taking a value. */
function isPlace(el: RungItem, field: number): boolean {
  if (el.type !== 'box') return true
  if (field === 0) return true
  return el.pins.filter((p) => p.value !== null)[field - 1]?.out ?? false
}

function writeField(source: string, routine: number, at: LadderSel, field: number, text: string): { source: string } | { error: string } {
  const r = readLadder(source)[routine]
  const el = r && elementAt(r.rungs, at)
  if (!r || !el || el.type === 'branch') return { error: t(M.elementGone) }
  const problem = operandProblem(text, isPlace(el, field))
  if (problem) return { error: problem }
  const was = fieldsOf(el)[field] ?? ''
  let next = source
  // a block renamed: its declaration follows, when the new name is free and the old one was declared
  if (el.type === 'box' && !el.func && field === 0 && IDENT.test(was) && IDENT.test(text) && !new RegExp(`\\b${text}\\s*:`, 'i').test(source)) {
    next = source.replace(new RegExp(`\\b${was}(\\s*):`, 'i'), `${text}$1:`)
  }
  const rr = readLadder(next)[routine]
  if (!rr) return { error: t(M.sectionGone) }
  return { source: writeLadder(next, routine, setField(rr.rungs, at, field, text)) }
}

/** What a box in routine `routine` can be (plc/ladder/ladderCatalog.ts): its POU's own blocks and functions, then the library. */
function catalogFor(source: string, routine: number): CatalogEntry[] {
  return ladderCatalog(source, readLadder(source)[routine]?.pou ?? '')
}

/** A palette element, or a picker's box (`box:<name>`), onto the rung. Every box goes through the catalogue
 *  (ladderCatalog.ts `insertCatalogEntry`): a block gets an instance of its own, named and declared in its POU in the
 *  same edit, and a condition goes to the front of the rung. */
function insert(source: string, routine: number, at: LadderSel, key: string): Inserted | null {
  const entry = ENTRIES.get(key)
  if (entry && (entry.item.kind === 'contact' || entry.item.kind === 'coil')) {
    const r = readLadder(source)[routine]
    if (!r) return null
    const e = insertItem(r.rungs, at, newItem(entry.item))
    // straight on to what it needs named: its variable
    return { source: writeLadder(source, routine, e.rungs), sel: e.sel, field: e.sel ? 0 : null }
  }
  const name = key.startsWith('box:') ? key.slice(4) : entry?.item.kind === 'block' ? entry.item.type : entry && 'name' in entry.item ? entry.item.name : null
  const box = name === null ? undefined : catalogFor(source, routine).find((c) => c.name === name)
  return box ? insertCatalogEntry(source, routine, at, box) : null
}

function boxes(source: string, routine: number): BoxChoice[] {
  return catalogFor(source, routine).map((c) => ({ key: `box:${c.name}`, name: c.name, group: c.group, summary: c.summary, signature: catalogSignature(c) }))
}

/** The variable a rung's contact or coil names that nothing declares: the one-click fix under its problem. */
function undeclaredOn(r: LadderRoutine, i: number): string | null {
  for (const d of r.rungProblems[i] ?? []) {
    const m = /^undeclared variable '([A-Za-z_][A-Za-z0-9_]*)'$/.exec(d.message)
    if (!m) continue
    const name = m[1]!
    const bits = (els: readonly RungElement[]): boolean => els.some((el) => (el.type === 'branch' ? el.paths.some(bits) : el.type !== 'box' && el.operand.toUpperCase() === name.toUpperCase()))
    if (bits(r.rungs[i]!.elements)) return name
  }
  return null
}

// ---- above a routine: where it stands, and the POU's declarations -------------------------------------------------

// each section's POU and its variables (index-aligned with the routines: both are the parse's `ladder` list), worked
// out once per text for every head that asks
let varsFor: { source: string; vars: ReturnType<typeof sectionDeclarations> } | null = null
const sectionVars = (source: string): ReturnType<typeof sectionDeclarations> => {
  if (varsFor?.source !== source) varsFor = { source, vars: sectionDeclarations(source) }
  return varsFor.vars
}

/** "LADDER in Main", and the declaration pane over it. Closed to start: the rungs are what the sheet
 *  is for. */
/** What the sheet draws above a section's rungs. */
export interface RoutineHeadProps {
  routine: LadderRoutine
  index: number
  source: string
  readOnly: boolean
  onEdit: (next: string) => void
  onShowText?: (offset: number) => void
  /** Rename a declaration of `scope`, and move the scene's wiring with it in the same commit (plc/tags.ts
   *  `tagRenamesForScene`). Not an `onEdit`: that hands back a new source, and a rename is a commit the store has to
   *  make, so only an owner with the store can offer it. The refusal, or null when it was done. */
  onRenameTag?: (scope: TagScope, from: string, to: string) => Promise<string | null>
}

export function RoutineHead({ routine: r, index: ri, source, readOnly, onEdit, onShowText, onRenameTag }: RoutineHeadProps): ReactElement {
  // Open for a POU, not at a position: the sheet keys its sections by position, so this head is handed whichever
  // section is now there. Keyed by position, a section added above would leave the pane open over another POU's
  // variables.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const open = openFor !== null && openFor.toUpperCase() === r.pou.toUpperCase()
  const vars = sectionVars(source)[ri]
  const pou = r.pou === '' ? t(M.theProgram) : r.pou
  return (
    <>
      <header className="ld-routine-head">
        {/* i18n-ok: the section's keyword in the program text */}
        LADDER <span className="ld-dim">{t(r.whole ? M.inPou : M.inPouBesideSt, { pou })}</span>
        {vars && (
          <button
            type="button"
            className="ld-vars-toggle"
            data-testid="ld-vars-toggle"
            aria-expanded={open}
            title={t(M.varsHint, { pou })}
            onClick={() => setOpenFor(open ? null : r.pou)}
          >
            <FoldIcon closed={!open} /> {t(M.variables)} <span className="ld-dim">{vars.rows.length}</span>
          </button>
        )}
      </header>
      {vars && open && <LadderVariables source={source} pou={r.pou} kind={vars.kind} rows={vars.rows} readOnly={readOnly} onEdit={onEdit} onShowText={onShowText} onRenameTag={onRenameTag} />}
    </>
  )
}

/** The rules the sheet reads, draws and edits IEC ladder by. */
export const LADDER = {
  read: (source: string, diagnostics: readonly Diagnostic[]): LadderRoutine[] => readLadder(source, diagnostics),
  /** the whole program, with section `index` printed from `rungs` */
  write: writeLadder,
  /** rung text (a clipboard, a rung retyped): whole rungs, or a run of elements */
  parseText: parseRungText,
  printElements,
  printRung,
  /** the names a program declares, offered while a field is typed (the scene's tags are added to them) */
  declaredNames: (source: string): string[] => (source.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*\s*)*:/g) ?? []).flatMap((m) => m.replace(/:$/, '').split(',').map((s) => s.trim())),
  shape,
  /** the power on the element's right link */
  powerOut,
  /** an output: where the rung's output section begins, packed against the right rail */
  isOutput: (el: RungItem): boolean => el.type === 'coil',
  /** every text `shape` and `powerOut` read a value by: a rung is drawn again when one of their values changes */
  watchTexts,
  /** the element's fields, in order (what the sheet edits); a blank one reads `?` */
  fields: fieldsOf,
  writeField,
  leaves: IEC_LEAVES,
  refs: IEC_REFS,
  typeAhead: (source: string, r: LadderRoutine, el: RungItem, field: number, names: readonly string[]): TypeAhead => {
    const rows = listTags(source)
    const types = iecTypes(rows, listUdts(source), r.pou)
    const wants = fieldWants(el, field, types)
    const memberTypes = (type: string): string[] => types.members(type).map((m) => m.type)
    // only what this POU can SEE: its own variables and the controller's. A name declared only inside another POU (a
    // block's own `Pos`) is not one, and offering it let Enter complete `P` to a variable the rung cannot reach. A name
    // nothing declares (a scene's tag) stays offered, for the rung to name and the quick fix to declare.
    const hidden = new Set(rows.filter((row) => types.typeOf(row.name) === undefined).map((row) => row.name.toUpperCase()))
    const visible = names.filter((n) => !hidden.has(n.toUpperCase()))
    return {
      names: rankByWanted(visible, wants, types.typeOf, memberTypes),
      membersOf: (base) => {
        const type = typeAt(base, types)
        const members = type === undefined ? [] : types.members(type)
        return rankByWanted(members.map((m) => m.name), wants, (n) => members.find((m) => m.name === n)?.type, memberTypes)
      },
    }
  },
  palette: PALETTE,
  /** entry `key` inserted at `at` in section `routine`: after the selected element, or at the start of the selected
   *  rung or level; null when it cannot go there */
  insert,
  /** Insert Box (BoxPicker.tsx): everything a box in section `routine` can be, where the bar holds a handful. A choice
   *  goes on the rung through `insert`, with its `key`. */
  boxes,
  /** pin `pin` of the box at `at` connected, blank, with the field to name it in (a BoxRow's `connect`); null when it
   *  cannot be */
  connectPin: (source: string, routine: number, at: LadderSel, pin: string, out: boolean): Inserted | null => {
    const r = readLadder(source)[routine]
    const made = r && connectPin(r.rungs, at, pin, out)
    return made ? { source: writeLadder(source, routine, made.rungs), sel: at, field: made.field } : null
  },
  /** the one-click fix under rung `i` of section `r`, which is section number `ri` */
  quickFix: (r: LadderRoutine, ri: number, i: number): QuickFix | null => {
    const name = undeclaredOn(r, i)
    return name === null
      ? null
      : {
          label: t(M.declare, { name }),
          title: t(M.declareHint, { name }),
          testid: 'ladder-declare',
          apply: (source) => declareInstance(source, ri, name, 'BOOL'),
        }
  },
  /** Cross Reference's "declared as" line: the declaration of `name`, when there is one */
  declaration: (source: string, name: string): TagRow | null => listTags(source).find((row) => row.name.toUpperCase() === name.toUpperCase()) ?? null,
}
