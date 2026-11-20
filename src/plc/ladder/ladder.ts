// Ladder Diagram (IEC 61131-3 LD), as a front end on the Structured Text engine (docs/ladder.md).
//
// A ladder body is written as a `LADDER ... END_LADDER` section where statements can stand, one rung per `;`:
//
//     LADDER
//       [|Start|, |Motor|] |/Stop| (Motor);
//       |Eye| |P Button| (S Jam);
//       |Run| T1(IN, PT := T#2s) (Late);
//     END_LADDER
//
// IEC gives LD no text, so the spelling is ours, echoing the standard's symbols: `|x|` / `|/x|` / `|P x|` / `|N x|`
// contacts, `(x)` / `(/x)` / `(S x)` / `(R x)` / `(P x)` / `(N x)` coils, series by juxtaposition, a branch
// `[path, path]`, and a box written as an ST call whose bare parameter name marks the rung's pin. Semantics are the
// standard's (IEC 61131-3 ed. 3, 8.2.3-8.2.4); where it leaves a choice open the rule is ours, e.g. a branch's paths
// run contact/block paths first, then coil-only ones (`branchOrder`). docs/ladder.md has the full table and rules.
//
// There is no ladder runtime: a rung lowers to the ST that means it (`lowerSection`), then is parsed, checked, run,
// compiled and exported like any statements. A rung condition stays an expression until something on the rung is
// about to write a variable it reads, then is captured in a temporary (`beforeWrite`), so `|A| (A) (B)` gives B the A
// that was examined. Operands are copied into the ST as written and the parser maps positions back onto the rung
// (parserLadder.ts `ladderSection`), so errors underline the rung operand. Temporaries are `hidden` variables of the
// enclosing POU; an edge's memory must survive between scans, so a FUNCTION cannot hold one.

import { isBuiltinFunc, standardInputs } from '../builtins'
import { AXIS_KERNEL_OUTPUTS, FB_INPUT_TYPES, FB_POSITIONAL, fbMemberType } from '../runtime'
import type { Expr, FbType, SourcePos } from '../types'
import { FB_TYPES, StError } from '../types'

// ---------------------------------------------------------------------------
// Roles: what an element does with its operand, held beside the AST
// ---------------------------------------------------------------------------

/** What a ladder element does with its operand, for a diagnostic in ladder terms. */
export type LdRole = 'contact' | 'coil'

/**
 * The BOOL rule a role carries, in the ladder's own words.
 *
 * The checker owns what IEC permits; it does not own what a contact is. It asks for the role of the place it is
 * about to reject and words the diagnostic from this table, so the ladder's vocabulary stays here rather than in
 * branches in the checker.
 */
export const LD_ROLES: Record<LdRole, { side: 'read' | 'write'; says: (place: string, is: string) => string }> = {
  contact: { side: 'read', says: (place, is) => `a contact examines a BOOL, and '${place}' is ${is}` },
  coil: { side: 'write', says: (place, is) => `a coil writes a BOOL, and '${place}' is ${is}` },
}

/**
 * Which lowered places came from a ladder element, keyed by the AST node itself.
 *
 * A side table, not a field on `Expr`: the ST AST is shared by every front end and stays free of the ladder's
 * vocabulary. Weak, so an entry dies with the program it belongs to; identity is safe because nothing clones a
 * statement between `mapBack` (which fills this) and the checker (which reads it).
 */
const roles = new WeakMap<object, LdRole>()

/** Mark a lowered place as an element's operand. Called by `mapBack`, once per operand. */
export function setLadderRole(node: object, role: LdRole): void {
  roles.set(node, role)
}

/** The role of a lowered place, or undefined for ordinary ST. */
export function ladderRole(node: object): LdRole | undefined {
  return roles.get(node)
}

// ---------------------------------------------------------------------------
// The model. Built by the parser (parserLadder.ts `ladderSection`), which owns expressions.
// ---------------------------------------------------------------------------

export type LdContactMode = 'open' | 'closed' | 'rising' | 'falling'
export type LdCoilMode = 'normal' | 'negated' | 'set' | 'reset' | 'rising' | 'falling'

/** An operand as written. Its text is what the lowering copies, and `start`/`pos` where a diagnostic points. `expr` is
 *  null for a blank, written `?`: what an element just dropped on a rung holds until it is named. A rung with one reads
 *  (so a ladder view can show and edit it) and does not lower, which reports it. */
export interface LdOperand {
  expr: Expr | null
  text: string
  start: number
  pos: SourcePos
}

export interface LdContact {
  kind: 'contact'
  mode: LdContactMode
  operand: LdOperand
  pos: SourcePos
  /** set by lowering on a transition-sensing contact: the temporary holding whether it passes this scan, which a
   *  view reads to draw it live (its state is its memory's, not something its variable alone can say) */
  edge?: string
}

export interface LdCoil {
  kind: 'coil'
  mode: LdCoilMode
  operand: LdOperand
  pos: SourcePos
}

/** One parameter of a box as written: `PT := T#2s` (an input), `ET => Elapsed` (an output bound to a place), or a
 *  bare name (`value` null), which puts that pin on the rung. */
export interface LdPin {
  name: string
  pos: SourcePos
  value: LdOperand | null
  out: boolean
}

/** A block on the rung: a function-block instance (`T1(IN, PT := T#2s)`) or a function (`ADD(...)`). */
export interface LdBox {
  kind: 'box'
  /** the instance (a place: `T1`, `Line.Timers[2]`) or the function's name */
  head: LdOperand
  func: boolean
  pins: LdPin[]
  pos: SourcePos
  /** set by lowering: the block's type and the pins that sit on the rung, which the PLCopen writer draws. `input` is
   *  null for a function whose result starts the rung (`EQ(IN1 := Step, IN2 := 10, OUT)`): nothing feeds it. A
   *  function block's `inputs` and `outputs` are every pin its type declares, which a view draws whether written or not
   *  (and connects from there) */
  resolved?: { type: string; input: string | null; output: string; inputs?: readonly string[]; outputs?: readonly string[] }
  /** set by lowering on a function that starts the rung: the temporary holding its result this scan, which a view
   *  reads to draw it live (its operands may be expressions it cannot evaluate) */
  result?: string
}

export interface LdBranch {
  kind: 'branch'
  paths: LdElement[][]
  pos: SourcePos
}

export type LdElement = LdContact | LdCoil | LdBox | LdBranch

/** How a rung may END, after its elements: a jump to a labelled rung below (`>>Next`), or a RETURN from the POU.
 *  Either one acts while its left link is on (IEC 61131-3 ed. 3, 8.2.6: jump and return elements). */
export type LdExit = { kind: 'jump'; label: string; pos: SourcePos } | { kind: 'return'; pos: SourcePos }

export interface LdRung {
  elements: LdElement[]
  /** the rung's label (`Next: |A| (B);`), where a jump lands */
  label?: { name: string; pos: SourcePos }
  exit?: LdExit
  /** the comment written above the rung (after the rung before it), as plain lines; absent when there is none */
  comment?: string
  pos: SourcePos
  /** source range of the rung, its `;` included */
  start: number
  end: number
}

export interface LdTemp {
  name: string
  type: 'BOOL'
}

/** One `LADDER ... END_LADDER`, with everything a reader of it needs. */
export interface LdSection {
  rungs: LdRung[]
  pos: SourcePos
  /** source range of the whole section, `LADDER` through `END_LADDER` (and its `;`, if written) */
  start: number
  end: number
  /** where the enclosing POU's statements begin: the place a VAR block for `temps` can be written */
  declEnd: number
  /** the ST its rungs lower to: what runs, and what a text exporter writes in the section's place */
  st: string
  /** what the lowering declared in the enclosing POU, which that ST reads and writes */
  temps: LdTemp[]
  /** the POU it stands in: a PROGRAM, FUNCTION_BLOCK or FUNCTION's name, '' for the code outside every POU */
  pou: string
  /** it is its POU's whole body, so the POU is a ladder diagram: PLCopen writes it as an `<LD>` body */
  whole: boolean
}

// ---------------------------------------------------------------------------
// Blocks: which pin of a box sits on the rung, and the order a function takes its inputs in
// ---------------------------------------------------------------------------

export interface LdBlockPin {
  name: string
  bool: boolean
}

/** What a box's type says about its pins, found by the parser (it can see the whole file) and handed to lowering. */
export interface LdBlockInfo {
  /** the block's type name: `TON`, a user FUNCTION_BLOCK, `ADD`, a user FUNCTION */
  type: string
  kind: 'fb' | 'function'
  inputs: LdBlockPin[]
  outputs: LdBlockPin[]
  /** a standard function takes its inputs in order only (the checker refuses named arguments to one), an
   *  extensible one (ADD, MAX...) as many as are given */
  positional: boolean
  extensible: boolean
}

/** The standard function blocks' outputs, in their declaration order (runtime.ts keeps the inputs). */
const BUILTIN_FB_OUTPUTS: Record<FbType, readonly string[]> = {
  AXIS_KERNEL: Object.keys(AXIS_KERNEL_OUTPUTS),
  TON: ['Q', 'ET'],
  TOF: ['Q', 'ET'],
  TP: ['Q', 'ET'],
  R_TRIG: ['Q'],
  F_TRIG: ['Q'],
  CTU: ['Q', 'CV'],
  CTD: ['Q', 'CV'],
  CTUD: ['QU', 'QD', 'CV'],
  SR: ['Q1'],
  RS: ['Q1'],
}

/** A standard function block's pins, or null for a name that is not one. */
export function builtinFbInfo(type: string): LdBlockInfo | null {
  const t = type.toUpperCase() as FbType
  if (!(FB_TYPES as readonly string[]).includes(t)) return null
  return {
    type: t,
    kind: 'fb',
    inputs: FB_POSITIONAL[t].map((name) => ({ name, bool: FB_INPUT_TYPES[t][name] === 'BOOL' })),
    outputs: BUILTIN_FB_OUTPUTS[t].map((name) => ({ name, bool: fbMemberType(t, name) === 'BOOL' })),
    positional: false,
    extensible: false,
  }
}

/** The standard functions whose result is BOOL whatever their operands are, so it can carry a rung: the comparisons. */
const COMPARISON_FUNCTIONS = new Set(['GT', 'GE', 'EQ', 'LE', 'LT', 'NE'])

/**
 * The standard functions ST spells as operators (IEC 61131-3 ed. 3, Tables 28 and 29): AND, OR, XOR, NOT, MOD. Every LD
 * editor has them as boxes, and a box here can be one: it lowers to the operator (`(a AND b)`,
 * `(NOT a)`, `(a MOD b)`), so the ST it becomes is ST the checker, the interpreter and every text exporter already
 * know, and only the ladder and its PLCopen `<block>` name them as functions. Pins as IEC names them.
 */
export const OPERATOR_FUNCTIONS: Readonly<Record<string, { inputs: readonly string[]; extensible: boolean; unary?: true }>> = {
  AND: { inputs: ['IN1', 'IN2'], extensible: true },
  OR: { inputs: ['IN1', 'IN2'], extensible: true },
  XOR: { inputs: ['IN1', 'IN2'], extensible: true },
  NOT: { inputs: ['IN'], extensible: false, unary: true },
  MOD: { inputs: ['IN1', 'IN2'], extensible: false },
}

/** A standard function's pins (every one-argument function, the conversions among them, takes `IN`), or null. */
export function builtinFunctionInfo(name: string): LdBlockInfo | null {
  const up = name.toUpperCase()
  const op = OPERATOR_FUNCTIONS[up]
  if (op) return { type: up, kind: 'function', inputs: op.inputs.map((n) => ({ name: n, bool: false })), outputs: [{ name: 'OUT', bool: false }], positional: true, extensible: op.extensible }
  if (!isBuiltinFunc(up)) return null
  const pins = standardInputs(up)
  return {
    type: up,
    kind: 'function',
    inputs: pins.inputs.map((n) => ({ name: n, bool: false })),
    // a generic function (SEL, MOVE, LIMIT...) returns what it is given, so only these are BOOL before checking
    outputs: [{ name: 'OUT', bool: COMPARISON_FUNCTIONS.has(up) || up.endsWith('_TO_BOOL') }],
    positional: true,
    extensible: pins.extensible === true,
  }
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

/** A stretch of the generated ST that is an operand copied as written, for mapping positions back. */
export interface LdSegment {
  /** offset in the generated text */
  at: number
  length: number
  operand: LdOperand
  /** what the element does with it, for a diagnostic in ladder terms */
  role?: LdRole
}

/** The ST a section lowers to, with what maps it back onto the rungs. */
export interface LdLowered {
  st: string
  segments: LdSegment[]
  /** the element each generated line belongs to (index = line - 1), for a statement that is not an operand */
  lines: SourcePos[]
  temps: LdTemp[]
}

/** What lowering needs from whoever is parsing. */
export interface LdLowering {
  /** a fresh name nothing in the file spells */
  temp: (stem: string) => string
  /** what a box's type says about its pins, or null when it cannot be told (lowering then asks for them bare) */
  blockInfo: (box: LdBox) => LdBlockInfo | null
  /** the section stands in a FUNCTION, which keeps nothing between calls: no edge can remember */
  inFunction: boolean
}

/** An operand printed into a condition, with what its element does with it (for the checker's message). */
interface LdRef {
  operand: LdOperand
  role?: LdRole
}

type Cond =
  | { k: 'const'; value: boolean }
  /** an operand, a temporary or a block output: `parts` printed in order, `reads` the names it depends on */
  | { k: 'atom'; parts: readonly (string | LdRef)[]; reads: ReadonlySet<string>; temp?: boolean }
  | { k: 'not'; c: Cond }
  | { k: 'and' | 'or'; items: Cond[] }

const TRUE: Cond = { k: 'const', value: true }

function and(a: Cond, b: Cond): Cond {
  if (a.k === 'const') return a.value ? b : a
  if (b.k === 'const') return b.value ? a : b
  return { k: 'and', items: [...(a.k === 'and' ? a.items : [a]), ...(b.k === 'and' ? b.items : [b])] }
}

function or(all: Cond[]): Cond {
  if (all.some((c) => c.k === 'const' && c.value)) return TRUE
  const items = all.filter((c) => c.k !== 'const').flatMap((c) => (c.k === 'or' ? c.items : [c]))
  if (items.length === 0) return { k: 'const', value: false }
  return items.length === 1 ? items[0]! : { k: 'or', items }
}

function not(c: Cond): Cond {
  if (c.k === 'const') return { k: 'const', value: !c.value }
  if (c.k === 'not') return c.c
  return { k: 'not', c }
}

/** Every variable an expression mentions, folded (the case-insensitive key IEC names compare by). */
function namesIn(e: Expr, out: Set<string>): Set<string> {
  switch (e.node) {
    case 'var':
      out.add(e.name.toUpperCase())
      break
    case 'member':
      namesIn(e.obj, out)
      break
    case 'index':
      namesIn(e.obj, out)
      for (const i of e.indices) namesIn(i, out)
      break
    case 'unary':
      namesIn(e.expr, out)
      break
    case 'binary':
      namesIn(e.left, out)
      namesIn(e.right, out)
      break
    case 'call':
      for (const a of e.args) namesIn(a, out)
      break
    default:
      break
  }
  return out
}

/** The variable a place is rooted at: `line.zones[2].full` is rooted at `line`, which is what a write to it changes. */
function rootOf(e: Expr): string | null {
  if (e.node === 'var') return e.name.toUpperCase()
  if (e.node === 'member' || e.node === 'index') return rootOf(e.obj)
  return null
}

function readsOf(c: Cond, out: Set<string> = new Set()): Set<string> {
  if (c.k === 'atom') for (const r of c.reads) out.add(r)
  else if (c.k === 'not') readsOf(c.c, out)
  else if (c.k === 'and' || c.k === 'or') for (const i of c.items) readsOf(i, out)
  return out
}

/**
 * The order a branch's paths run in. IEC leaves it open (8.2.3: an element is evaluated once its left link is known,
 * and every path's is known at once), so this is the engine's own rule: the paths that hold a contact or a block run first, top to bottom, and then the paths that are nothing
 * but coils, top to bottom. So in
 * `|A| [(X), |X| (Y)]` the contact examines X as it was, while in `|A| [|A| (X), |X| (Y)]` it sees the new X.
 */
export function branchOrder(paths: readonly LdElement[][]): LdElement[][] {
  const coilsOnly = (p: readonly LdElement[]): boolean => p.length > 0 && p.every((e) => e.kind === 'coil')
  return [...paths.filter((p) => !coilsOnly(p)), ...paths.filter(coilsOnly)]
}

/** The first operand of `els` still blank (`?`), with what it belongs to, or null. */
function firstBlank(els: readonly LdElement[]): { what: string; of: string; pos: SourcePos } | null {
  for (const el of els) {
    if (el.kind === 'branch') {
      for (const p of el.paths) {
        const found = firstBlank(p)
        if (found) return found
      }
    } else if (el.kind === 'box') {
      if (el.head.expr === null) return { what: 'This block', of: el.func ? 'function' : 'instance name', pos: el.head.pos }
      const pin = el.pins.find((p) => p.value !== null && p.value.expr === null)
      if (pin) return { what: `${el.head.text}'s ${pin.name}`, of: pin.out ? 'place to write to' : 'value', pos: pin.value!.pos }
    } else if (el.operand.expr === null) {
      return { what: `This ${el.kind}`, of: 'variable', pos: el.operand.pos }
    }
  }
  return null
}

/** A rung condition that is still live: something later on the rung will use it, so a write it depends on must
 *  not happen before it is captured. `rail`: nothing stands between this link and the left rail yet (the rung's
 *  start, or the start of a path of a branch that stands there), which is the only place a function that starts a
 *  rung can go. */
class Held {
  constructor(
    public c: Cond,
    public rail = false,
  ) {}
}

class Lowerer {
  private text = ''
  private readonly segments: LdSegment[] = []
  private readonly lines: SourcePos[] = []
  private readonly temps: LdTemp[] = []
  private readonly live: Held[] = []
  private at: SourcePos

  constructor(private readonly ctx: LdLowering, pos: SourcePos) {
    this.at = pos
  }

  // ---- writing the ST ----

  private put(s: string): void {
    this.text += s
  }
  private operand(o: LdOperand, role?: LdRole): void {
    this.segments.push({ at: this.text.length, length: o.text.length, operand: o, ...(role ? { role } : {}) })
    this.text += o.text
  }
  /** end one generated line, which belongs to the element being lowered */
  private endLine(): void {
    this.text += '\n'
    this.lines.push(this.at)
  }
  private cond(c: Cond, inner = false): void {
    switch (c.k) {
      case 'const':
        this.put(c.value ? 'TRUE' : 'FALSE')
        return
      case 'atom':
        for (const p of c.parts) {
          if (typeof p === 'string') this.put(p)
          else this.operand(p.operand, p.role)
        }
        return
      case 'not':
        if (c.c.k === 'atom' || c.c.k === 'const') {
          this.put('NOT ')
          this.cond(c.c)
        } else {
          this.put('NOT (')
          this.cond(c.c)
          this.put(')')
        }
        return
      case 'and':
      case 'or': {
        // AND binds tighter than OR, so only an OR inside an AND needs its parentheses (and an operand of a NOT,
        // above); `inner` is for an operand of a comparison or a call argument, which never nest here
        if (inner) this.put('(')
        c.items.forEach((item, i) => {
          if (i > 0) this.put(c.k === 'and' ? ' AND ' : ' OR ')
          if (c.k === 'and' && item.k === 'or') {
            this.put('(')
            this.cond(item)
            this.put(')')
          } else this.cond(item)
        })
        if (inner) this.put(')')
        return
      }
    }
  }

  // ---- temporaries ----

  private temp(stem: string): string {
    const name = this.ctx.temp(stem)
    this.temps.push({ name, type: 'BOOL' })
    return name
  }
  private tempAtom(name: string): Cond {
    return { k: 'atom', parts: [name], reads: new Set([name.toUpperCase()]), temp: true }
  }
  /** `c` as something that can be read again after a write: itself when it already is, else a temporary */
  private capture(c: Cond): Cond {
    if (c.k === 'const' || (c.k === 'atom' && c.temp)) return c
    const name = this.temp('LD_C')
    this.put(`${name} := `)
    this.cond(c)
    this.put(';')
    this.endLine()
    return this.tempAtom(name)
  }
  /** About to write `roots`: capture every live condition that reads one of them, so it keeps what it examined. */
  private beforeWrite(roots: ReadonlySet<string>): void {
    if (roots.size === 0) return
    for (const h of this.live) {
      for (const r of readsOf(h.c)) {
        if (roots.has(r)) {
          h.c = this.capture(h.c)
          break
        }
      }
    }
  }

  // ---- the rung ----

  /**
   * A rung that cannot lower yet (it holds a blank) is still drawn, so each block on it is given its type and its
   * pins as `box` would give them: a block just inserted with every pin blank (ladderCatalog.ts) shows what it is and
   * what comes out of it, instead of a `?` with no outputs. Nothing is checked or written; the blank is what's reported.
   */
  private sketch(els: readonly LdElement[]): void {
    for (const el of els) {
      if (el.kind === 'branch') el.paths.forEach((p) => this.sketch(p))
      if (el.kind !== 'box' || el.func || el.resolved || !el.head.expr) continue
      const info = this.ctx.blockInfo(el)
      if (!info) continue
      const isOut = (name: string): boolean => name.toUpperCase() === 'ENO' || info.outputs.some((o) => o.name.toUpperCase() === name.toUpperCase())
      const bare = el.pins.filter((p) => p.value === null)
      const input = bare.find((p) => !isOut(p.name))?.name ?? info.inputs.find((p) => p.bool)?.name
      const output = bare.find((p) => isOut(p.name))?.name ?? (input?.toUpperCase() === 'EN' ? 'ENO' : info.outputs.find((p) => p.bool)?.name)
      if (input && output) el.resolved = { type: info.type, input, output, inputs: info.inputs.map((p) => p.name), outputs: info.outputs.map((p) => p.name) }
    }
  }

  /** `jumpFlag`: the flag the rung's jump sets (the section's, `lowerSection`), when it ends in one */
  rung(r: LdRung, jumpFlag?: string): void {
    const blank = firstBlank(r.elements)
    if (blank) {
      this.sketch(r.elements)
      throw new StError(`${blank.what} has no ${blank.of} yet: the ? on this rung`, blank.pos, 1)
    }
    // the left power rail; the right one reads nothing unless the rung ends in a jump or a RETURN, which acts on it
    const h = new Held(TRUE, true)
    this.series(r.elements, h, r.exit !== undefined)
    if (!r.exit) return
    this.at = r.exit.pos
    if (r.exit.kind === 'jump') {
      this.put(`${jumpFlag} := `)
      this.cond(h.c)
      this.put(';')
    } else if (h.c.k === 'const' && h.c.value) {
      this.put('RETURN;')
    } else {
      this.put('IF ')
      this.cond(h.c)
      this.put(' THEN RETURN; END_IF;')
    }
    this.endLine()
  }

  private unlive(h: Held): void {
    const i = this.live.indexOf(h)
    if (i >= 0) this.live.splice(i, 1)
  }

  /** `used`: whether anything reads the series' right link. When nothing does, its condition need not survive the
   *  last element's write, which is what keeps `[|Start|, |Motor|] |/Stop| (Motor)` a single assignment. */
  private series(els: readonly LdElement[], h: Held, used: boolean): void {
    this.live.push(h)
    els.forEach((el, i) => {
      const last = i === els.length - 1
      if (last && !used) this.unlive(h)
      this.element(el, h, !last || used)
      h.rail = false
    })
    this.unlive(h)
  }

  private element(el: LdElement, h: Held, used: boolean): void {
    this.at = el.pos
    switch (el.kind) {
      case 'contact':
        return this.contact(el, h)
      case 'coil':
        return this.coil(el, h)
      case 'branch':
        return this.branch(el, h, used)
      case 'box':
        return this.box(el, h)
    }
  }

  private operandAtom(o: LdOperand, role?: LdRole): Cond {
    return { k: 'atom', parts: [{ operand: o, ...(role ? { role } : {}) }], reads: namesIn(o.expr!, new Set()) }
  }

  private noMemoryInFunction(what: string, pos: SourcePos): void {
    if (this.ctx.inFunction) {
      throw new StError(`${what} remembers its previous state, and a FUNCTION keeps nothing between calls: use it in a PROGRAM or a FUNCTION_BLOCK`, pos, 1)
    }
  }

  private contact(el: LdContact, h: Held): void {
    const x = el.operand
    if (el.mode === 'open' || el.mode === 'closed') {
      const a = this.operandAtom(x, 'contact')
      h.c = and(h.c, el.mode === 'open' ? a : not(a))
      return
    }
    // a transition-sensing contact: on for one evaluation after its variable changed, whatever its left link did,
    // so its memory is updated every time the element is evaluated (8.2.3, Table 60)
    this.noMemoryInFunction(`A ${el.mode === 'rising' ? 'P' : 'N'} contact`, el.pos)
    const edge = this.temp('LD_E')
    const mem = this.temp('LD_M')
    el.edge = edge
    this.put(`${edge} := `)
    if (el.mode === 'rising') {
      this.operand(x, 'contact')
      this.put(` AND NOT ${mem};`)
    } else {
      this.put('NOT ')
      this.operand(x, 'contact')
      this.put(` AND ${mem};`)
    }
    this.endLine()
    this.put(`${mem} := `)
    this.operand(x)
    this.put(';')
    this.endLine()
    h.c = and(h.c, this.tempAtom(edge))
  }

  private coil(el: LdCoil, h: Held): void {
    const x = el.operand
    const root = rootOf(x.expr!)
    this.beforeWrite(new Set(root ? [root] : []))
    switch (el.mode) {
      case 'normal':
      case 'negated':
        this.operand(x, 'coil')
        this.put(' := ')
        this.cond(el.mode === 'normal' ? h.c : not(h.c))
        this.put(';')
        this.endLine()
        return
      case 'set':
      case 'reset':
        if (h.c.k === 'const' && !h.c.value) return
        if (h.c.k === 'const') {
          this.operand(x, 'coil')
          this.put(el.mode === 'set' ? ' := TRUE;' : ' := FALSE;')
        } else {
          this.put('IF ')
          this.cond(h.c)
          this.put(' THEN ')
          this.operand(x, 'coil')
          this.put(el.mode === 'set' ? ' := TRUE; END_IF;' : ' := FALSE; END_IF;')
        }
        this.endLine()
        return
      case 'rising':
      case 'falling': {
        // on for one evaluation after its left link changed; the left link passes on either way
        this.noMemoryInFunction(`A ${el.mode === 'rising' ? 'P' : 'N'} coil`, el.pos)
        const mem = this.temp('LD_M')
        h.c = this.capture(h.c)
        this.operand(x, 'coil')
        this.put(' := ')
        if (el.mode === 'rising') {
          this.cond(h.c)
          this.put(` AND NOT ${mem};`)
        } else {
          this.put('NOT ')
          this.cond(h.c)
          this.put(` AND ${mem};`)
        }
        this.endLine()
        this.put(`${mem} := `)
        this.cond(h.c)
        this.put(';')
        this.endLine()
        return
      }
    }
  }

  private branch(el: LdBranch, h: Held, used: boolean): void {
    // every path starts from the branch's left link as it was when the branch began: `h` stays live across the
    // paths (a later one still needs it), so a write in an earlier path to something it reads captures it first
    const wasLive = this.live.includes(h)
    if (!wasLive) this.live.push(h)
    const outs: Held[] = []
    branchOrder(el.paths).forEach((path, i) => {
      if (i === el.paths.length - 1) this.unlive(h)
      const p = new Held(h.c, h.rail)
      this.series(path, p, used)
      // a finished path's right link is live until the paths join, so a later path cannot change it either
      outs.push(p)
      if (used) this.live.push(p)
    })
    for (const p of outs) this.unlive(p)
    if (wasLive) this.live.push(h)
    this.at = el.pos
    h.c = or(outs.map((p) => p.c))
  }

  private box(el: LdBox, h: Held): void {
    const info = this.ctx.blockInfo(el)
    const head = el.head.text
    const bare = el.pins.filter((p) => p.value === null)
    const byName = (list: readonly LdBlockPin[] | undefined, name: string): LdBlockPin | undefined => list?.find((p) => p.name.toUpperCase() === name.toUpperCase())
    for (const p of el.pins) {
      if (p.value !== null && p.name.toUpperCase() === 'EN') throw new StError(`EN is the pin the rung feeds: write it bare, or leave it out`, p.pos, 2)
    }

    if (el.func) {
      if (!info) throw new StError(`'${head}' is not a function this engine knows`, el.head.pos, head.length)
      // a function sits on the rung by EN / ENO, and its result goes to the place `OUT =>` names; or OUT is bare, and
      // its result starts the rung
      const starts = bare.find((p) => p.name.toUpperCase() === 'OUT')
      for (const p of bare) {
        const name = p.name.toUpperCase()
        if (name !== 'EN' && name !== 'ENO' && name !== 'OUT') {
          throw new StError(`a function sits on the rung by EN and ENO, or starts it by OUT: '${p.name}' needs a value (${p.name} := ...)`, p.pos, p.name.length)
        }
        if (starts && name !== 'OUT') throw new StError(`${info.type} starts the rung by OUT, so nothing feeds it and it has no ${name}`, p.pos, p.name.length)
      }
      const outPin = el.pins.find((p) => p.out)
      for (const p of el.pins) {
        if (p.out && p.name.toUpperCase() !== 'OUT') throw new StError(`a function has one output, OUT: '${p.name}' is not it`, p.pos, p.name.length)
        if (!p.out && p.value !== null && !this.inputIndex(info, p.name)) {
          throw new StError(`${info.type} has no input '${p.name}' (${info.inputs.map((i) => i.name).join(', ')}${info.extensible ? '...' : ''})`, p.pos, p.name.length)
        }
      }
      if (starts) return this.starter(el, info, starts, outPin, h)
      el.resolved = { type: info.type, input: 'EN', output: 'ENO' }
      if (!outPin) return // a function whose result goes nowhere does nothing: IEC functions have no side effects
      const target = outPin.value!
      const root = rootOf(target.expr!)
      this.beforeWrite(new Set(root ? [root] : []))
      const call = (): void => {
        this.operand(target)
        this.put(' := ')
        this.callOf(info, el)
        this.put(';')
      }
      if (h.c.k === 'const' && !h.c.value) return
      if (h.c.k === 'const') call()
      else {
        this.put('IF ')
        this.cond(h.c)
        this.put(' THEN ')
        call()
        this.put(' END_IF;')
      }
      this.endLine()
      return
    }

    // a function-block instance: the rung feeds one BOOL input and takes one BOOL output on. Its type tells a bare
    // output from a bare input; a block whose type cannot be told names them in that order
    const isOut = (name: string): boolean => name.toUpperCase() === 'ENO' || byName(info?.outputs, name) !== undefined
    const inPins = info ? bare.filter((p) => !isOut(p.name)) : bare.slice(0, 1)
    const outPins = info ? bare.filter((p) => isOut(p.name)) : bare.slice(1)
    if (inPins.length > 1 || outPins.length > 1) {
      throw new StError(`a box sits on the rung by one input and one output: '${head}' names ${bare.map((p) => p.name).join(', ')}`, el.pos, head.length)
    }
    const inName = inPins[0]?.name
    const outName = outPins[0]?.name
    const input = inName ?? info?.inputs.find((p) => p.bool)?.name
    const enabled = input !== undefined && input.toUpperCase() === 'EN'
    const output = outName ?? (enabled ? 'ENO' : info?.outputs.find((p) => p.bool)?.name)
    if (input === undefined || output === undefined) {
      throw new StError(`cannot tell which pins of '${head}' sit on the rung: name them bare, as in ${head}(IN, ..., Q)`, el.head.pos, head.length)
    }
    el.resolved = { type: info?.type ?? '', input, output, ...(info ? { inputs: info.inputs.map((p) => p.name), outputs: info.outputs.map((p) => p.name) } : {}) }
    if (info) {
      if (!enabled && !byName(info.inputs, input)) throw new StError(`${info.type} has no input '${input}'`, el.pos, head.length)
      if (output.toUpperCase() !== 'ENO' && !byName(info.outputs, output)) throw new StError(`${info.type} has no output '${output}'`, el.pos, head.length)
    }
    const roots = new Set<string>()
    const hr = rootOf(el.head.expr!)
    if (hr) roots.add(hr)
    for (const p of el.pins) {
      if (p.out && p.value) {
        const r = rootOf(p.value.expr!)
        if (r) roots.add(r)
      }
    }
    this.beforeWrite(roots)
    const rest = el.pins.filter((p) => p.value !== null)
    const call = (feed: boolean): void => {
      this.operand(el.head)
      this.put('(')
      let first = true
      if (feed) {
        this.put(`${input} := `)
        this.cond(h.c, true)
        first = false
      }
      for (const p of rest) {
        if (!first) this.put(', ')
        first = false
        this.put(`${p.name} ${p.out ? '=>' : ':='} `)
        this.operand(p.value!)
      }
      this.put(');')
    }
    if (enabled) {
      // EN: the block runs only while the rung is on, and ENO passes the rung on
      if (h.c.k === 'const' && !h.c.value) return
      if (h.c.k === 'const') call(false)
      else {
        this.put('IF ')
        this.cond(h.c)
        this.put(' THEN ')
        call(false)
        this.put(' END_IF;')
      }
      this.endLine()
      if (output.toUpperCase() !== 'ENO') h.c = { k: 'atom', parts: [{ operand: el.head }, `.${output}`], reads: new Set(hr ? [hr] : []) }
      return
    }
    call(true)
    this.endLine()
    h.c = output.toUpperCase() === 'ENO' ? h.c : { k: 'atom', parts: [{ operand: el.head }, `.${output}`], reads: new Set(hr ? [hr] : []) }
  }

  /**
   * A function whose result starts the rung: `EQ(IN1 := Step, IN2 := 10, OUT) |/Moving| (Go)`. Nothing feeds it, so it
   * stands where the left rail does: first on the rung, or first on a path of a branch that is. Anywhere later its left
   * link would lead nowhere, which is also why it takes no EN. It runs every scan, when the rung reaches it, and what it
   * returns is the rung. On a branch it may not import elsewhere (`ladderExportCaveats`). The result is held in a temporary, as an edge is, so a view can draw it live
   * whatever its operands are.
   */
  private starter(el: LdBox, info: LdBlockInfo, out: LdPin, bound: LdPin | undefined, h: Held): void {
    if (bound) throw new StError(`${info.type}'s OUT carries the rung, so it cannot also be written to ${bound.value!.text}`, bound.pos, bound.name.length)
    if (!info.outputs[0]?.bool) {
      throw new StError(`${info.type}'s result is not a BOOL, so it cannot start a rung: run it behind EN and write its result somewhere (OUT => x)`, out.pos, out.name.length)
    }
    if (!h.rail) {
      throw new StError(`${info.type}(..., OUT) starts a rung: nothing feeds it, so it stands at the left rail, first on the rung or first on a path of a branch that is`, el.pos, el.head.text.length)
    }
    el.resolved = { type: info.type, input: null, output: 'OUT' }
    const name = this.temp('LD_R')
    el.result = name
    this.put(`${name} := `)
    this.callOf(info, el)
    this.put(';')
    this.endLine()
    h.c = and(h.c, this.tempAtom(name))
  }

  /** where a named input goes in a function's ordered argument list, 1-based; 0 when it has no such input */
  private inputIndex(info: LdBlockInfo, name: string): number {
    const up = name.toUpperCase()
    const i = info.inputs.findIndex((p) => p.name.toUpperCase() === up)
    if (i >= 0) return i + 1
    if (!info.extensible) return 0
    // IN3, IN4... past the declared ones, on the stem of the last
    const last = info.inputs[info.inputs.length - 1]!.name
    const stem = last.replace(/\d+$/, '')
    const base = Number(last.slice(stem.length))
    const m = up.match(/^([A-Z_]+)(\d+)$/)
    if (!m || m[1] !== stem.toUpperCase()) return 0
    const n = Number(m[2])
    return n > base ? info.inputs.length + (n - base) : 0
  }

  /** a function as the ST that calls it: `ADD(a, b)`, or a function ST spells as an operator (`OPERATOR_FUNCTIONS`) as
   *  that operator, parenthesised so it binds as the call would: `(a AND b AND c)`, `(NOT a)`, `(a MOD b)` */
  private callOf(info: LdBlockInfo, el: LdBox): void {
    const op = OPERATOR_FUNCTIONS[info.type]
    if (!op) {
      this.put(`${info.type}(`)
      this.args(info, el)
      this.put(')')
      return
    }
    this.put(op.unary ? `(${info.type} ` : '(')
    this.args(info, el, ` ${info.type} `)
    this.put(')')
  }

  /** a function's inputs, as its call takes them: in declaration order for a standard function, by name otherwise;
   *  `sep` between them (an operator's own word, for `callOf`) */
  private args(info: LdBlockInfo, el: LdBox, sep = ', '): void {
    const given = el.pins.filter((p) => !p.out && p.value !== null)
    if (!info.positional) {
      given.forEach((p, i) => {
        if (i > 0) this.put(', ')
        this.put(`${p.name} := `)
        this.operand(p.value!)
      })
      return
    }
    const slots: LdPin[] = []
    for (const p of given) {
      const i = this.inputIndex(info, p.name)
      if (slots[i - 1]) throw new StError(`'${p.name}' is given twice`, p.pos, p.name.length)
      slots[i - 1] = p
    }
    const count = Math.max(info.extensible ? slots.length : info.inputs.length, info.inputs.length)
    const last = info.inputs[info.inputs.length - 1]!.name
    const stem = last.replace(/\d+$/, '')
    for (let i = 0; i < count; i++) {
      const p = slots[i]
      const name = i < info.inputs.length ? info.inputs[i]!.name : `${stem}${Number(last.slice(stem.length)) + i - info.inputs.length + 1}`
      if (!p) throw new StError(`${info.type} needs ${name}`, el.pos, el.head.text.length)
      if (i > 0) this.put(sep)
      this.operand(p.value!)
    }
  }

  done(): LdLowered {
    return { st: this.text, segments: this.segments, lines: this.lines, temps: this.temps }
  }
}

/**
 * Lower rungs to ST. A rung that cannot be lowered (an operand missing, a box whose pins cannot be told) is reported
 * through `onError` and contributes nothing, so the rest of the section still runs and still shows.
 */
export function lowerSection(rungs: readonly LdRung[], ctx: LdLowering, onError: (e: unknown) => void): LdLowered {
  // Jumps. ST has no GOTO, so a jump is a flag: set by the jump rung to what reaches it, cleared at the top of the
  // section, and every rung from the jump down to its label runs only while no flag spanning it is set. A label ends
  // the jumps to it (its own rung runs). Only downward jumps: a jump back up is a loop, which a flag cannot run again.
  const key = (name: string): string => name.toUpperCase()
  const labelAt = new Map<string, number>()
  rungs.forEach((r, i) => {
    if (!r.label) return
    if (labelAt.has(key(r.label.name))) onError(new StError(`label '${r.label.name}' is already on rung ${labelAt.get(key(r.label.name))}, so a jump to it could mean either`, r.label.pos, r.label.name.length))
    else labelAt.set(key(r.label.name), i)
  })
  const flags = new Map<string, string>() // label (folded) -> its flag
  const jumpOf = (r: LdRung, i: number): string | null => {
    if (r.exit?.kind !== 'jump') return null
    const to = labelAt.get(key(r.exit.label))
    if (to === undefined) throw new StError(`there is no rung labelled '${r.exit.label}' in this LADDER section to jump to`, r.exit.pos, r.exit.label.length + 2)
    if (to <= i) throw new StError(`a jump back up to '${r.exit.label}' (rung ${to}) would run rungs again in one scan, a loop; this ladder jumps only down the section`, r.exit.pos, r.exit.label.length + 2)
    if (!flags.has(key(r.exit.label))) flags.set(key(r.exit.label), ctx.temp('LD_J'))
    return key(r.exit.label)
  }
  const parts: LdLowered[] = []
  const lowered: { at: number; part: LdLowered; jump: string | null }[] = []
  rungs.forEach((r, i) => {
    const one = new Lowerer(ctx, r.pos)
    try {
      const jump = jumpOf(r, i)
      one.rung(r, jump === null ? undefined : flags.get(jump))
      lowered.push({ at: i, part: one.done(), jump })
    } catch (e) {
      onError(e)
    }
  })
  const flagTemps: LdTemp[] = [...flags.values()].map((name) => ({ name, type: 'BOOL' }))
  // one generated line of section scaffolding, attributed to `pos`
  const scaffold = (text: string, pos: SourcePos): LdLowered => ({ st: `${text}\n`, segments: [], lines: [pos], temps: [] })
  if (flags.size > 0 && rungs[0]) parts.push({ ...scaffold([...flags.values()].map((f) => `${f} := FALSE;`).join(' '), rungs[0].pos), temps: flagTemps })
  let active: string[] = [] // labels whose jumps are live over the rung in hand
  rungs.forEach((rung, at) => {
    // a label ends the jumps to it, even on a rung that did not lower
    if (rung.label) active = active.filter((l) => l !== key(rung.label!.name))
    const done = lowered.find((x) => x.at === at)
    if (!done) return
    const { part, jump } = done
    if (active.length > 0 && part.st !== '') {
      parts.push(scaffold(`IF NOT (${active.map((l) => flags.get(l)!).join(' OR ')}) THEN`, rung.pos), part, scaffold('END_IF;', rung.pos))
    } else parts.push(part)
    if (jump !== null && !active.includes(jump)) active.push(jump)
  })
  // stitched together, the segment offsets moved along with the text
  let st = ''
  const segments: LdSegment[] = []
  const lines: SourcePos[] = []
  const temps: LdTemp[] = []
  for (const p of parts) {
    for (const s of p.segments) segments.push({ ...s, at: s.at + st.length })
    st += p.st
    lines.push(...p.lines)
    temps.push(...p.temps)
  }
  return { st, segments, lines, temps }
}

// ---------------------------------------------------------------------------
// The export caveats: valid IEC ladder that a target's importer may not accept
// ---------------------------------------------------------------------------

/** Whether `els` has a coil in it anywhere, its branches included. */
function holdsCoil(els: readonly LdElement[]): boolean {
  return els.some((e) => e.kind === 'coil' || (e.kind === 'branch' && e.paths.some(holdsCoil)))
}

/**
 * What a section does that a target's importer may not accept, one sentence per kind. Each is valid IEC and runs
 * here; the export warns. Coils standing in series at the END of a rung are not one: the
 * PLCopen writer draws them in parallel, which means the same (every coil passes its left link on unchanged).
 */
export function ladderExportCaveats(section: LdSection): string[] {
  const out = new Set<string>()
  const walk = (els: readonly LdElement[], inBranch: boolean): void => {
    els.forEach((el, i) => {
      if (el.kind === 'coil' && (el.mode === 'rising' || el.mode === 'falling')) {
        out.add(`A transition-sensing coil, (${el.mode === 'rising' ? 'P' : 'N'} ${el.operand.text}): some targets have no such coil. Put ${el.mode === 'rising' ? 'a P' : 'an N'} contact before a plain coil instead, which means the same.`)
      }
      if (el.kind === 'branch') el.paths.forEach((p) => walk(p, true))
      // a function that starts a path of a branch puts an operand on the branch line (a box a contact feeds is fine
      // there: its operands hang off its pins), which some editors do not draw
      if (inBranch && el.kind === 'box' && el.func && el.pins.some((p) => p.value === null && p.name.toUpperCase() === 'OUT')) {
        out.add(`A function starting a path of a branch, ${el.head.text}(..., OUT): some targets accept one only at the start of a rung, not on a branch. Give it a rung of its own that writes a BOOL, and examine that on the branch.`)
      }
      if (el.kind === 'box' && el.func && COMPARISON_FUNCTIONS.has(el.head.text.toUpperCase()) && el.pins.filter((p) => !p.out && p.value !== null).length > 2) {
        out.add(`A comparison of more than two values, ${el.head.text}(...): IEC chains them (GT(a, b, c) is a > b AND b > c), but some targets take exactly two. Compare two at a time.`)
      }
      const rest = els.slice(i + 1)
      const trailingCoils = el.kind === 'coil' && rest.every((e) => e.kind === 'coil')
      if (holdsCoil([el]) && rest.length > 0 && !trailingCoils) {
        out.add(`Something follows a coil on a rung (after ${el.kind === 'coil' ? `(${el.operand.text})` : 'a branch holding a coil'}): some targets accept coils only at the right end of a rung. End the rung at its coils and carry on in the next rung.`)
      }
    })
  }
  for (const r of section.rungs) walk(r.elements, false)
  return [...out]
}

// ---------------------------------------------------------------------------
// Printing rungs back as text (the ladder view writes through this, and so does the PLCopen reader)
// ---------------------------------------------------------------------------

const CONTACT_MARK: Record<LdContactMode, string> = { open: '', closed: '/', rising: 'P ', falling: 'N ' }
const COIL_MARK: Record<LdCoilMode, string> = { normal: '', negated: '/', set: 'S ', reset: 'R ', rising: 'P ', falling: 'N ' }

export function printElement(el: LdElement): string {
  switch (el.kind) {
    case 'contact':
      return `|${CONTACT_MARK[el.mode]}${el.operand.text}|`
    case 'coil':
      return `(${COIL_MARK[el.mode]}${el.operand.text})`
    case 'branch':
      return `[${el.paths.map(printSeries).join(', ')}]`
    case 'box':
      return `${el.head.text}(${el.pins.map((p) => (p.value === null ? p.name : `${p.name} ${p.out ? '=>' : ':='} ${p.value.text}`)).join(', ')})`
  }
}

export function printSeries(els: readonly LdElement[]): string {
  return els.map(printElement).join(' ')
}

export function printRung(r: LdRung): string {
  return `${[r.label ? `${r.label.name}:` : '', printSeries(r.elements), r.exit ? printExit(r.exit) : ''].filter(Boolean).join(' ')};`
}

/** The prose of the comments in `trivia` (the text between two rungs), markers removed, one line per line. */
export function commentText(trivia: string): string {
  const out: string[] = []
  const re = /\/\/([^\n]*)|\(\*([\s\S]*?)\*\)|\/\*([\s\S]*?)\*\//g
  for (let m = re.exec(trivia); m; m = re.exec(trivia)) {
    const body = m[1] ?? m[2] ?? m[3] ?? ''
    for (const line of body.split('\n')) out.push(line.trim())
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  while (out.length > 0 && out[0] === '') out.shift()
  return out.join('\n')
}

/** A rung's jump or RETURN as the text writes it. */
export function printExit(exit: { kind: 'jump'; label: string } | { kind: 'return' }): string {
  return exit.kind === 'jump' ? `>>${exit.label}` : 'RETURN'
}

// ---------------------------------------------------------------------------
// The text exporters' view: every section stood down to the ST it lowers to
// ---------------------------------------------------------------------------

/**
 * `source` with every LADDER section replaced by the ST it lowers to, and each POU that holds one given a VAR block
 * declaring the temporaries that ST uses. What the exporters then write is exactly what ran here, since it is the
 * same text the parser read. `sections` are the parse's (`Ast.ladder`), of this source.
 */
export function expandLadder(source: string, sections: readonly LdSection[]): string {
  if (sections.length === 0) return source
  const edits: { at: number; end: number; text: string }[] = []
  const byPou = new Map<number, LdTemp[]>()
  for (const s of sections) {
    edits.push({ at: s.start, end: s.end, text: s.st.trimEnd() })
    if (s.temps.length > 0) byPou.set(s.declEnd, [...(byPou.get(s.declEnd) ?? []), ...s.temps])
  }
  for (const [at, temps] of byPou) {
    edits.push({ at, end: at, text: `VAR\n${temps.map((t) => `  ${t.name} : ${t.type};`).join('\n')}\nEND_VAR\n` })
  }
  // back to front, so an offset still means what it meant; at one offset the section is replaced first, so the VAR
  // block inserted there afterwards lands in front of it
  edits.sort((a, b) => b.at - a.at || b.end - b.at - (a.end - a.at))
  let out = source
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end)
  return out
}

// ---------------------------------------------------------------------------
// Positions: the statements a section's ST reads back as, pointed at the rungs
// ---------------------------------------------------------------------------

/**
 * Re-point every position in `stmts` (read from `lowered.st`) at the rung it came from: inside a copied operand, at
 * the same character of the operand as written; elsewhere, at the element whose line it is. The first place read
 * at the start of an operand with a role is marked with it (`setLadderRole`), for the checker's message.
 */
export function mapBack(stmts: unknown[], lowered: LdLowered, fallback: SourcePos): void {
  const segs = lowered.segments
  const find = (offset: number): LdSegment | undefined => {
    let lo = 0
    let hi = segs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = segs[mid]!
      if (offset < s.at) hi = mid - 1
      else if (offset >= s.at + s.length) lo = mid + 1
      else return s
    }
    return undefined
  }
  const moved = new Map<SourcePos, SourcePos>()
  const claimed = new Set<LdSegment>()
  const move = (p: SourcePos): SourcePos => {
    let q = moved.get(p)
    if (!q) {
      const seg = find(p.offset)
      if (seg) {
        const d = p.offset - seg.at
        q = { line: seg.operand.pos.line, col: seg.operand.pos.col + d, offset: seg.operand.start + d }
      } else q = lowered.lines[p.line - 1] ?? fallback
      moved.set(p, q)
    }
    return q
  }
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    const p = o['pos'] as SourcePos | undefined
    if (p !== undefined && typeof p === 'object' && typeof p.offset === 'number') {
      if (o['node'] === 'var' || o['node'] === 'member' || o['node'] === 'index') {
        const seg = find(p.offset)
        if (seg?.role && p.offset === seg.at && !claimed.has(seg)) {
          claimed.add(seg)
          setLadderRole(o, seg.role)
        }
      }
      o['pos'] = move(p)
    }
    for (const [k, c] of Object.entries(o)) if (k !== 'pos' && c !== null && typeof c === 'object') visit(c)
  }
  visit(stmts)
}
