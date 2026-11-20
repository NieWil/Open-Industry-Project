// Statements for the ST parser: statement lists with their error recovery, and the control statements.

import type { CaseLabel, Expr, Stmt } from './types'
import { StError } from './types'
import { ExprParser } from './parserExpr'

export abstract class StmtParser extends ExprParser {
  /** the ladder layer above (parserLadder.ts): whether a LADDER section starts here, and reading one */
  protected abstract startsLadder(): boolean
  protected abstract ladderSection(): Stmt[]

  /** statements until `atEnd` (a block terminator) or EOF; `;` separators are optional */
  protected stmtList(atEnd: () => boolean = () => false): Stmt[] {
    const out: Stmt[] = []
    for (;;) {
      const t = this.peek()
      if (t.kind === 'eof') break
      if (atEnd()) break
      if (this.isOp(';')) {
        this.next()
        continue
      }
      // a LADDER section stands where a statement does, and is as many statements as it lowers to (ladder.ts)
      const one = (): Stmt[] => {
        if (this.startsLadder()) return this.ladderSection()
        this.plain++
        return [this.stmt()]
      }
      if (!this.sink) {
        out.push(...one())
        continue
      }
      const before = this.p
      try {
        out.push(...one())
      } catch (e) {
        this.note(e)
        if (this.p === before) this.next() // a statement that consumed nothing would loop forever
        this.recover(atEnd)
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Ladder (ladder.ts): `LADDER <rung;>* END_LADDER`, each rung drawn in text: |contact| (coil) [branch] box(...)
  // -------------------------------------------------------------------------

  private stmt(): Stmt {
    this.rejectUnsupported()
    if (this.isKw('IF')) return this.ifStmt()
    if (this.isKw('CASE')) return this.caseStmt()
    if (this.isKw('FOR')) return this.forStmt()
    if (this.isKw('WHILE')) return this.whileStmt()
    if (this.isKw('REPEAT')) return this.repeatStmt()
    if (this.isKw('EXIT')) return this.exitStmt()
    if (this.isKw('CONTINUE')) return this.jumpStmt('CONTINUE', 'continue')
    if (this.isKw('RETURN')) return this.jumpStmt('RETURN', 'return')
    const head = this.peek()
    if (head.kind === 'ident') {
      this.next()
      // Every statement that is not a keyword starts with a place: name(.field | [i, j, ...])*.
      // What follows decides which statement it is: `(` calls the function-block instance that
      // lives there (`t(...)`, `line.gap(...)`, `zones[i](...)`), `:=` assigns to it.
      const place = this.accessChain({ node: 'var', name: head.value, pos: head.pos })
      if (this.isOp('(')) {
        // a block's instance called (`t(...)`, `zones[i](...)`), or - which only the checker can tell - a METHOD
        // (`m.Reset()`, `THIS.Run()`, `SUPER^()`), turned into an `invoke` there
        const args = this.blockArgs()
        this.eatOp(';')
        return { node: 'fbcall', target: place, args, pos: head.pos }
      }
      // `r REF= place;`, a non-IEC binding of a REFERENCE TO (written with no space between REF and =): refused by name
      const ref = this.peek()
      if (ref.kind === 'ident' && ref.value.toUpperCase() === 'REF' && this.peek(1).kind === 'op' && this.peek(1).value === '=' && this.peek(1).pos.offset === ref.pos.offset + 3) {
        throw new StError('REF= is not IEC 61131-3; declare the variable REF_TO and give it a reference with REF(): r := REF(place);', ref.pos, 4)
      }
      this.eatOp(':=')
      const value = this.expr()
      this.eatOp(';')
      return { node: 'assign', target: place, value, pos: head.pos }
    }
    throw new StError(`unsupported statement near '${head.value || head.kind}'`, head.pos)
  }

  private ifStmt(): Stmt {
    const pos = this.eatKw('IF').pos
    const atEnd = (): boolean => this.isKw('ELSIF') || this.isKw('ELSE') || this.isKw('END_IF')
    const branches: { cond: Expr; body: Stmt[] }[] = []
    let cond = this.expr()
    this.eatKw('THEN')
    branches.push({ cond, body: this.stmtList(atEnd) })
    while (this.isKw('ELSIF')) {
      this.next()
      cond = this.expr()
      this.eatKw('THEN')
      branches.push({ cond, body: this.stmtList(atEnd) })
    }
    let elseBody: Stmt[] | null = null
    if (this.isKw('ELSE')) {
      this.next()
      elseBody = this.stmtList(atEnd)
    }
    this.eatKw('END_IF')
    this.blockEnd()
    return { node: 'if', branches, elseBody, pos }
  }

  private caseStmt(): Stmt {
    const pos = this.eatKw('CASE').pos
    const selector = this.expr()
    this.eatKw('OF')
    const cases: { labels: CaseLabel[]; body: Stmt[] }[] = []
    while (!this.isKw('ELSE') && !this.isKw('END_CASE')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_CASE', this.peek().pos)
      const labels = this.caseLabels()
      this.eatOp(':')
      cases.push({ labels, body: this.stmtList(() => this.isCaseClauseEnd()) })
    }
    let elseBody: Stmt[] | null = null
    if (this.isKw('ELSE')) {
      this.next()
      elseBody = this.stmtList(() => this.isKw('END_CASE'))
    }
    this.eatKw('END_CASE')
    this.blockEnd()
    return { node: 'case', selector, cases, elseBody, pos }
  }

  /** A clause body ends at the next label or at ELSE/END_CASE. A label is an int literal
   *  (possibly signed) or an enumeration member - and an IDENT is only a label when a ':'
   *  or ',' follows it, which is exactly what tells it apart from `name := ...`. */
  private isCaseClauseEnd(): boolean {
    const t = this.peek()
    if (t.kind === 'num') return true
    if (t.kind === 'op' && t.value === '-') return true
    if (t.kind === 'ident') {
      const after = this.peek(1)
      if (after.kind === 'op' && (after.value === ':' || after.value === ',')) return true
      if (this.dottedLabel()) return true
    }
    return this.isKw('ELSE') || this.isKw('END_CASE')
  }

  /** `Mode.Idle` then `:` or `,`: a dotted enumeration member as a CASE label (a place never stands there). */
  private dottedLabel(): boolean {
    const dot = this.peek(1)
    const member = this.peek(2)
    const after = this.peek(3)
    return dot.kind === 'op' && dot.value === '.' && member.kind === 'ident' && after.kind === 'op' && (after.value === ':' || after.value === ',')
  }

  private caseLabels(): CaseLabel[] {
    const labels: CaseLabel[] = []
    for (;;) {
      // an enumeration member stands alone - ranges are numeric only
      if (this.peek().kind === 'ident' && this.dottedLabel()) {
        // `Mode.Idle:`, an input spelling of Mode#Idle (a label is a constant, so only a member)
        const q = this.next()
        this.next()
        const t = this.next()
        labels.push({ kind: 'name', name: t.value, pos: q.pos, qualifier: q.value })
      } else if (this.peek().kind === 'ident') {
        const t = this.next()
        labels.push({ kind: 'name', name: t.value, pos: t.pos, ...(t.qualifier !== undefined ? { qualifier: t.qualifier } : {}) })
      } else {
        const lo = this.caseInt()
        if (this.isOp('..')) {
          this.next()
          const hiPos = this.peek().pos
          const hi = this.caseInt()
          if (hi < lo) throw new StError('CASE range must be ascending (lo..hi)', hiPos)
          labels.push({ kind: 'range', lo, hi })
        } else {
          labels.push({ kind: 'single', value: lo })
        }
      }
      if (this.isOp(',')) {
        this.next()
        continue
      }
      break
    }
    return labels
  }

  private caseInt(): number {
    let neg = false
    if (this.isOp('-')) {
      this.next()
      neg = true
    }
    const t = this.peek()
    if (t.kind !== 'num' || t.real) throw new StError('expected an integer CASE label', t.pos)
    this.next()
    return neg ? -t.num : t.num
  }

  private forStmt(): Stmt {
    const pos = this.eatKw('FOR').pos
    const varTok = this.peek()
    if (varTok.kind !== 'ident') throw new StError('expected a loop variable', varTok.pos)
    this.next()
    this.eatOp(':=')
    const from = this.expr()
    this.eatKw('TO')
    const to = this.expr()
    let by: Expr | null = null
    if (this.isKw('BY')) {
      this.next()
      by = this.expr()
    }
    this.eatKw('DO')
    const body = this.stmtList(() => this.isKw('END_FOR'))
    this.eatKw('END_FOR')
    this.blockEnd()
    return { node: 'for', varName: varTok.value, from, to, by, body, pos }
  }

  private whileStmt(): Stmt {
    const pos = this.eatKw('WHILE').pos
    const cond = this.expr()
    this.eatKw('DO')
    const body = this.stmtList(() => this.isKw('END_WHILE'))
    this.eatKw('END_WHILE')
    this.blockEnd()
    return { node: 'while', cond, body, pos }
  }

  private repeatStmt(): Stmt {
    const pos = this.eatKw('REPEAT').pos
    const body = this.stmtList(() => this.isKw('UNTIL'))
    this.eatKw('UNTIL')
    const cond = this.expr()
    this.eatKw('END_REPEAT')
    this.blockEnd()
    return { node: 'repeat', body, cond, pos }
  }

  // Every simple statement ends in ';'. The block statements' terminators (END_IF, END_CASE, END_FOR, END_WHILE,
  // END_REPEAT) take one too in IEC, and MATIEC refuses a program without it - but code written elsewhere is full of
  // the bare form. So it is read either way here (our rule), and the exporters write it back (exportText.ts
  // `canonicalSyntax`): read the tolerated input form, write what every compiler accepts. Declaration blocks (END_VAR, END_TYPE, END_FUNCTION[_BLOCK])
  // are not statements and keep their optional trailing ';'.
  private blockEnd(): void {
    if (this.isOp(';')) this.next()
  }

  private exitStmt(): Stmt {
    const pos = this.eatKw('EXIT').pos
    this.eatOp(';')
    return { node: 'exit', pos }
  }

  /** CONTINUE / RETURN - bare keyword statements, no operand. */
  private jumpStmt(kw: string, node: 'continue' | 'return'): Stmt {
    const pos = this.eatKw(kw).pos
    this.eatOp(';')
    return { node, pos }
  }
}
