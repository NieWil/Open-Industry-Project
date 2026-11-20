// LADDER ... END_LADDER sections for the ST parser: rungs, contacts, coils and boxes, read into ladder.ts's
// model and lowered to statements.

import type { Expr, Stmt, Token } from './types'
import { StError } from './types'
import type { LdBlockInfo, LdBlockPin, LdBox, LdCoilMode, LdContactMode, LdElement, LdExit, LdOperand, LdPin, LdRung } from './ladder/ladder'
import { builtinFbInfo, builtinFunctionInfo, commentText, lowerSection, mapBack, OPERATOR_FUNCTIONS } from './ladder/ladder'
import { isBuiltinFunc } from './builtins'
import { lex, lexedSource } from './lexer'
import { VAR_SECTIONS } from './parserBase'
import { StmtParser } from './parserStmt'

/** The name a place ends in: `T1` for `Line.T1`, `Timers` for `Timers[i]` (whose declaration gives the type). */
function lastName(e: Expr): string | null {
  if (e.node === 'var') return e.name
  if (e.node === 'member') return e.field
  if (e.node === 'index') return lastName(e.obj)
  return null
}

export class LadderParser extends StmtParser {
  /** `LADDER` opening a section, rather than a statement about a variable called `ladder`: that goes on with `:=`,
   *  `.`, `[` or `(` on the same line. A section goes on with a contact, a branch, an empty rung or END_LADDER, or
   *  with anything at all on a line of its own. */
  protected startsLadder(): boolean {
    if (!this.isWord('LADDER')) return false
    const a = this.peek(1)
    if (a.kind === 'eof') return false
    if (a.kind === 'op' && (a.value === '|' || a.value === ';')) return true
    if (a.kind === 'ident' && a.value.toUpperCase() === 'END_LADDER') return true
    // `[` opening a branch, not an index: a branch starts with a contact, another branch, or an empty path
    if (a.kind === 'op' && a.value === '[') {
      const b = this.peek(2)
      if (b.kind === 'op' && (b.value === '|' || b.value === '[' || b.value === ',')) return true
    }
    return a.pos.line > this.peek().pos.line
  }

  protected ladderSection(): Stmt[] {
    const open = this.next()
    const rungs: LdRung[] = []
    // a rung's comment is what is written between it and the rung before it (the section's head, for the first)
    const source = lexedSource.get(this.toks)
    let after = open.pos.offset + open.value.length
    while (!this.isWord('END_LADDER')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_LADDER', open.pos, open.value.length)
      const before = this.p
      try {
        const r = this.rung()
        const comment = source === undefined ? '' : commentText(source.slice(after, r.start))
        if (comment !== '') r.comment = comment
        after = r.end
        rungs.push(r)
      } catch (e) {
        this.note(e) // rethrows when this parse keeps no diagnostics
        if (this.p === before) this.next()
        // resume at the next rung
        while (this.peek().kind !== 'eof' && !this.isWord('END_LADDER')) if (this.next().value === ';') break
      }
    }
    const close = this.next()
    let end = close.pos.offset + close.value.length
    if (this.isOp(';')) end = this.next().pos.offset + 1
    const lowered = lowerSection(
      rungs,
      {
        temp: (stem) => this.freshName(stem),
        blockInfo: (box) => this.blockInfo(box),
        inFunction: this.inFunction,
      },
      (e) => this.note(e),
    )
    // The ST it lowers to, read back like any other statements, with every position mapped onto the rung it came
    // from: what a diagnostic points at is the operand the author wrote.
    let stmts: Stmt[] = []
    try {
      stmts = new LadderParser(lex(lowered.st)).stmtList()
    } catch (e) {
      this.note(e instanceof StError ? new StError(`this ladder did not lower to ST that reads back (${e.message})`, open.pos, open.value.length) : e)
    }
    mapBack(stmts, lowered, open.pos)
    for (const t of lowered.temps) this.ladderTemps.push({ name: t.name, type: t.type, init: null, section: 'VAR', pos: open.pos, hidden: true })
    this.ladder.push({ rungs, pos: open.pos, start: open.pos.offset, end, declEnd: this.declEnd, st: lowered.st, temps: lowered.temps, pou: '', whole: false })
    return stmts
  }

  /**
   * One rung: `[Label:] elements [>>Target | RETURN];`. A label names the rung a jump lands on; a jump or a RETURN
   * ends the rung and acts on what reaches it (ladder.ts `LdExit`). Neither stands inside a branch.
   */
  private rung(): LdRung {
    const first = this.peek()
    let label: LdRung['label']
    const colon = this.peek(1)
    if (first.kind === 'ident' && colon.kind === 'op' && colon.value === ':') {
      this.next()
      this.next()
      label = { name: first.value, pos: first.pos }
    }
    const exitAhead = (): boolean => (this.isOp('>') && this.peek(1).kind === 'op' && this.peek(1).value === '>') || this.isKw('RETURN')
    const elements = this.ladderSeries(() => this.isOp(';') || exitAhead())
    let exit: LdExit | undefined
    if (this.isKw('RETURN')) exit = { kind: 'return', pos: this.next().pos }
    else if (this.isOp('>')) {
      const at = this.next().pos
      if (this.next().pos.offset !== at.offset + 1) throw new StError('a jump is written >> with nothing between: >>Next', at, 2)
      const target = this.peek()
      if (target.kind !== 'ident') throw new StError('a jump names the label of the rung it goes to: >>Next', target.pos)
      this.next()
      exit = { kind: 'jump', label: target.value, pos: at }
    }
    if (exit && !this.isOp(';')) throw new StError(`a ${exit.kind === 'jump' ? 'jump' : 'RETURN'} ends the rung: nothing stands after it`, this.peek().pos)
    const semi = this.eatOp(';')
    return { elements, ...(label ? { label } : {}), ...(exit ? { exit } : {}), pos: first.pos, start: first.pos.offset, end: semi.pos.offset + 1 }
  }

  private ladderSeries(atEnd: () => boolean): LdElement[] {
    const out: LdElement[] = []
    while (!atEnd()) {
      if (this.peek().kind === 'eof' || this.isWord('END_LADDER')) throw new StError(`expected ';' to end the rung`, this.peek().pos)
      out.push(this.ladderElement())
    }
    return out
  }

  private ladderElement(): LdElement {
    const t = this.peek()
    if (this.isKw('RETURN') || (this.isOp('>') && this.peek(1).kind === 'op' && this.peek(1).value === '>')) {
      throw new StError('a jump or a RETURN ends a rung, after everything on it; it cannot stand inside a branch', t.pos, t.value.length)
    }
    if (this.isOp('[')) {
      this.next()
      const paths: LdElement[][] = []
      for (;;) {
        paths.push(this.ladderSeries(() => this.isOp(',') || this.isOp(']')))
        if (this.isOp(']')) break
        this.next()
      }
      this.next()
      if (paths.length < 2) throw new StError('a branch has two paths or more, separated by commas: [|A|, |B|]', t.pos)
      return { kind: 'branch', paths, pos: t.pos }
    }
    if (this.isOp('|')) {
      this.next()
      let mode: LdContactMode = 'open'
      if (this.isOp('/')) {
        this.next()
        mode = 'closed'
      } else if (this.modifier(['P', 'N'])) mode = this.next().value.toUpperCase() === 'P' ? 'rising' : 'falling'
      const operand = this.ladderPlace('a contact')
      this.eatOp('|')
      return { kind: 'contact', mode, operand, pos: t.pos }
    }
    if (this.isOp('(')) {
      this.next()
      let mode: LdCoilMode = 'normal'
      if (this.isOp('/')) {
        this.next()
        mode = 'negated'
      } else if (this.modifier(['S', 'R', 'P', 'N'])) {
        mode = ({ S: 'set', R: 'reset', P: 'rising', N: 'falling' } as const)[this.next().value.toUpperCase() as 'S' | 'R' | 'P' | 'N']
      }
      const operand = this.ladderPlace('a coil')
      this.eatOp(')')
      return { kind: 'coil', mode, operand, pos: t.pos }
    }
    // a block, named or still blank (`?(IN, PT := T#1s)`)
    if (t.kind === 'ident' || (this.isOp('?') && this.peek(1).kind === 'op' && this.peek(1).value === '(') || this.operatorBox()) return this.ladderBox()
    throw new StError(`expected a contact |x|, a coil (x), a branch [..., ...] or a block, found '${t.value || t.kind}'`, t.pos, Math.max(1, t.value.length))
  }

  /** `AND(IN1 := a, IN2 := b, OUT => c)`: a box that is a function ST spells as an operator (ladder.ts
   *  `OPERATOR_FUNCTIONS`), its word a keyword, followed by its pins. Spelled out: `&` lexes as AND too, and is not one. */
  private operatorBox(): boolean {
    const t = this.peek()
    const next = this.peek(1)
    if (t.kind !== 'kw' || OPERATOR_FUNCTIONS[t.value] === undefined || next.kind !== 'op' || next.value !== '(') return false
    const source = lexedSource.get(this.toks)
    return source === undefined || source.slice(t.pos.offset, t.pos.offset + t.value.length).toUpperCase() === t.value
  }

  /** `P` in `|P Button|`: a modifier, when a place follows it (`|P|` alone examines a variable called P) */
  private modifier(letters: readonly string[]): boolean {
    const t = this.peek()
    return t.kind === 'ident' && letters.includes(t.value.toUpperCase()) && this.peek(1).kind === 'ident'
  }

  /** A place on the rung, with its text as written; `?` is one not named yet. */
  private ladderPlace(what: string): LdOperand {
    const first = this.peek()
    if (this.isOp('?')) {
      this.next()
      return { expr: null, text: '?', start: first.pos.offset, pos: first.pos }
    }
    if (first.kind !== 'ident') throw new StError(`${what} needs a variable, found '${first.value || first.kind}'`, first.pos, Math.max(1, first.value.length))
    this.next()
    const expr = this.accessChain({ node: 'var', name: first.value, pos: first.pos })
    return this.operandFrom(first, expr)
  }

  private operandFrom(first: Token, expr: Expr | null): LdOperand {
    const source = lexedSource.get(this.toks)
    const end = this.peek().pos.offset
    const text = source !== undefined ? source.slice(first.pos.offset, end).trimEnd() : this.toks.slice(this.toks.indexOf(first), this.p).map((k) => k.raw ?? k.value).join('')
    return { expr, text, start: first.pos.offset, pos: first.pos }
  }

  /** `T1(IN, PT := T#2s)`, `Line.Timers[2](IN)`, `ADD(IN1 := A, IN2 := 1, OUT => A)` */
  private ladderBox(): LdBox {
    const first = this.next()
    const operator = first.kind === 'kw'
    const expr = first.kind === 'op' ? null : operator ? ({ node: 'var', name: first.value, pos: first.pos } as const) : this.accessChain({ node: 'var', name: first.value, pos: first.pos })
    const head = this.operandFrom(first, expr)
    // a function when its name is one (a plain name, which an instance is not always), else a block instance
    const func = operator || (expr?.node === 'var' && (isBuiltinFunc(first.value.toUpperCase()) || this.declaresFunction(first.value)))
    this.eatOp('(')
    const pins: LdPin[] = []
    while (!this.isOp(')')) {
      const n = this.peek()
      if (n.kind !== 'ident') throw new StError(`expected a parameter name, found '${n.value || n.kind}'`, n.pos, Math.max(1, n.value.length))
      this.next()
      if (this.isOp(':=')) {
        this.next()
        const v = this.peek()
        const blank = this.isOp('?')
        if (blank) this.next()
        pins.push({ name: n.value, pos: n.pos, value: this.operandFrom(v, blank ? null : this.expr()), out: false })
      } else if (this.isOp('=>')) {
        this.next()
        pins.push({ name: n.value, pos: n.pos, value: this.ladderPlace(`${n.value} =>`), out: true })
      } else pins.push({ name: n.value, pos: n.pos, value: null, out: false })
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(')')
    return { kind: 'box', head, func, pins, pos: first.pos }
  }

  /** A name for a temporary that nothing in the file spells. */
  private freshName(stem: string): string {
    if (!this.spelled) this.spelled = new Set(this.toks.filter((t) => t.kind === 'ident').map((t) => t.value.toUpperCase()))
    for (let n = 1; ; n++) {
      const name = `${stem}${n}`
      if (this.spelled.has(name)) continue
      this.spelled.add(name)
      return name
    }
  }

  // What a box's type says about its pins. Lowering happens as the rung is read, before anything is resolved, and a
  // declaration may be anywhere in the file, so these read the tokens; the checker still checks everything after.

  private blockInfo(box: LdBox): LdBlockInfo | null {
    if (box.func) return builtinFunctionInfo(box.head.text) ?? this.userFunctionInfo(box.head.text)
    const type = box.head.expr ? this.declaredType(lastName(box.head.expr)) : null
    return type ? (builtinFbInfo(type) ?? this.userBlockInfo(type)) : null
  }

  private declaresFunction(name: string): boolean {
    return this.toks.some((t, i) => t.kind === 'kw' && t.value === 'FUNCTION' && this.toks[i + 1]?.kind === 'ident' && this.toks[i + 1]!.value.toUpperCase() === name.toUpperCase())
  }

  /** `name : TYPE`, `a, name : TYPE` or `name : ARRAY[...] OF TYPE`: the type a variable is declared as */
  private declaredType(name: string | null): string | null {
    if (name === null) return null
    const key = name.toUpperCase()
    for (let i = 0; i < this.toks.length; i++) {
      const t = this.toks[i]!
      if (t.kind !== 'ident' || t.value.toUpperCase() !== key) continue
      let k = i + 1
      while (this.toks[k]?.value === ',' && this.toks[k + 1]?.kind === 'ident') k += 2
      if (this.toks[k]?.value !== ':' || this.toks[k]?.kind !== 'op') continue
      k++
      if (this.toks[k]?.value === 'ARRAY') {
        while (k < this.toks.length && this.toks[k]!.value !== 'OF') k++
        k++
      }
      const type = this.toks[k]
      if (type && (type.kind === 'ident' || type.kind === 'kw')) return type.value
    }
    return null
  }

  /** a user FUNCTION_BLOCK's inputs and outputs, in declaration order, read off its VAR_INPUT / VAR_OUTPUT */
  private userBlockInfo(type: string): LdBlockInfo | null {
    const at = this.toks.findIndex((t, i) => t.kind === 'kw' && t.value === 'FUNCTION_BLOCK' && this.toks[i + 1]?.value.toUpperCase() === type.toUpperCase())
    if (at < 0) return null
    const { inputs, outputs } = this.pinsFrom(at + 2, 'END_FUNCTION_BLOCK')
    return { type: this.toks[at + 1]!.value, kind: 'fb', inputs, outputs, positional: false, extensible: false }
  }

  private userFunctionInfo(name: string): LdBlockInfo | null {
    const at = this.toks.findIndex((t, i) => t.kind === 'kw' && t.value === 'FUNCTION' && this.toks[i + 1]?.value.toUpperCase() === name.toUpperCase())
    if (at < 0) return null
    const { inputs } = this.pinsFrom(at + 2, 'END_FUNCTION')
    // `FUNCTION InRange : BOOL`: a BOOL result can start a rung
    const bool = this.toks[at + 2]?.value === ':' && this.toks[at + 3]?.value.toUpperCase() === 'BOOL'
    return { type: this.toks[at + 1]!.value, kind: 'function', inputs, outputs: [{ name: 'OUT', bool }], positional: false, extensible: false }
  }

  private pinsFrom(from: number, end: string): { inputs: LdBlockPin[]; outputs: LdBlockPin[] } {
    const inputs: LdBlockPin[] = []
    const outputs: LdBlockPin[] = []
    let into: LdBlockPin[] | null = null
    let names: string[] = []
    for (let k = from; k < this.toks.length; k++) {
      const t = this.toks[k]!
      if (t.kind === 'kw' && t.value === end) break
      if (t.kind === 'kw' && (t.value === 'VAR_INPUT' || t.value === 'VAR_OUTPUT')) {
        into = t.value === 'VAR_INPUT' ? inputs : outputs
        names = []
      } else if (t.kind === 'kw' && (t.value === 'END_VAR' || VAR_SECTIONS.has(t.value))) into = null
      else if (into && t.kind === 'ident' && (this.toks[k + 1]?.value === ',' || this.toks[k + 1]?.value === ':')) {
        names.push(t.value)
        if (this.toks[k + 1]!.value === ':') {
          const type = this.toks[k + 2]?.value
          for (const n of names) into.push({ name: n, bool: type === 'BOOL' })
          names = []
        }
      }
    }
    return { inputs, outputs }
  }
}
