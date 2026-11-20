// A generator of random, well-typed Structured Text programs for the differential fuzzer (stFuzz.test.ts), which runs
// each on both scan engines through the oracle (scanEngineOracle.ts). Every expression is generated at a known type,
// so a program passes the checker: operands of a binary operator share one type, a store takes exactly the place's
// type, and a type changes only through an explicit X_TO_Y. Division, MOD and subscripts are guarded most of the time
// (SEL around a zero divisor, LIMIT around an index), and left raw now and then, so the faults are compared too.
//
// The same seed gives the same program (a small PRNG, never Math.random), so a failing seed replays.
//
// Test support, not app code: nothing outside the specs imports it.

/** mulberry32: small, fast and well mixed enough for picking program shapes. */
export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = (seed ^ 0x9e3779b9) >>> 0
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!
  }
}

export type Ty = 'BOOL' | 'SINT' | 'INT' | 'DINT' | 'USINT' | 'UINT' | 'UDINT' | 'BYTE' | 'WORD' | 'DWORD' | 'REAL' | 'LREAL' | 'TIME' | 'STRING'

const SIGNED: readonly Ty[] = ['SINT', 'INT', 'DINT']
const UNSIGNED: readonly Ty[] = ['USINT', 'UINT', 'UDINT']
const INTS: readonly Ty[] = [...SIGNED, ...UNSIGNED]
const BITS: readonly Ty[] = ['BYTE', 'WORD', 'DWORD']
const REALS: readonly Ty[] = ['REAL', 'LREAL']
const NUMERIC: readonly Ty[] = [...INTS, ...REALS]
const SCALARS: readonly Ty[] = ['BOOL', ...INTS, ...BITS, ...REALS, 'TIME', 'STRING']
const CONV_NUM: readonly Ty[] = ['REAL', 'LREAL', 'BOOL', 'TIME', ...INTS, ...BITS]

const isIntTy = (t: Ty): boolean => INTS.includes(t)
const isBitTy = (t: Ty): boolean => BITS.includes(t)
const isRealTy = (t: Ty): boolean => REALS.includes(t)
const widthOf = (t: Ty): number => (t === 'SINT' || t === 'USINT' || t === 'BYTE' ? 8 : t === 'INT' || t === 'UINT' || t === 'WORD' ? 16 : 32)
const RANGE: Partial<Record<Ty, [number, number]>> = {
  SINT: [-128, 127], INT: [-32768, 32767], DINT: [-2147483648, 2147483647],
  USINT: [0, 255], UINT: [0, 65535], UDINT: [0, 4294967295],
  BYTE: [0, 255], WORD: [0, 65535], DWORD: [0, 4294967295],
}

// ---- storage shapes and the places they hold ----

type Shape =
  | { k: 'scalar'; t: Ty }
  | { k: 'array'; dims: [number, number][]; elem: Shape }
  | { k: 'struct'; name: string; fields: { name: string; shape: Shape }[] }

interface Root {
  name: string
  shape: Shape
  /** read only: a VAR_INPUT, a loop counter, a function block's outputs read from outside */
  ro: boolean
}

type Step = { kind: 'name'; name: string } | { kind: 'field'; name: string } | { kind: 'index'; dims: [number, number][] }

interface Template {
  steps: Step[]
  leaf: Shape
  ro: boolean
}

const sig = (s: Shape): string =>
  s.k === 'scalar' ? s.t : s.k === 'array' ? `A[${s.dims.map((d) => d.join('..')).join(',')}]${sig(s.elem)}` : `S:${s.name}`

function templatesOf(roots: readonly Root[]): Template[] {
  const out: Template[] = []
  const walk = (steps: Step[], shape: Shape, ro: boolean): void => {
    out.push({ steps, leaf: shape, ro })
    if (shape.k === 'array') walk([...steps, { kind: 'index', dims: shape.dims }], shape.elem, ro)
    else if (shape.k === 'struct') for (const f of shape.fields) walk([...steps, { kind: 'field', name: f.name }], f.shape, ro)
  }
  for (const r of roots) walk([{ kind: 'name', name: r.name }], r.shape, r.ro)
  return out
}

interface FuncSig {
  name: string
  ret: Ty
  inputs: { name: string; t: Ty }[]
}

interface FbDef {
  type: string
  inputs: { name: string; t: Ty }[]
  outputs: { name: string; t: Ty }[]
  inouts: { name: string; t: Ty }[]
}

interface StdFb {
  name: string
  type: 'TON' | 'TOF' | 'TP' | 'CTU' | 'CTD' | 'CTUD' | 'R_TRIG' | 'F_TRIG' | 'SR' | 'RS'
}

interface Scope {
  roots: Root[]
  templates: Template[]
  funcs: FuncSig[]
  /** user function-block instances callable here: the instance's place template (a root, or an array of them) */
  fbs: { root: Root; def: FbDef }[]
  std: StdFb[]
  /** FOR control variables and WHILE / REPEAT counters, free at this depth of loop nesting */
  forVars: string[]
  whileVars: string[]
  loopDepth: number
  /** nesting of statement lists (IF, CASE, loops) */
  blockDepth: number
  canReturn: boolean
}

export interface GenOptions {
  /** statements in the main body */
  statements: number
  /** maximum expression depth */
  exprDepth: number
  /** maximum statement nesting */
  blockDepth: number
}

export interface Generated {
  src: string
  /** a long body, past the generator's chunk split */
  big: boolean
}

// ---- the generator ----

export class StFuzzGen {
  private r: Rng
  private o: GenOptions
  private sc!: Scope

  constructor(seed: number, opts: Partial<GenOptions> = {}) {
    this.r = new Rng(seed)
    this.o = { statements: 10, exprDepth: 3, blockDepth: 2, ...opts }
  }

  // ---- literals ----

  private intLit(t: Ty): string {
    const r = this.r
    const [lo, hi] = RANGE[t]!
    let v: number
    const p = r.next()
    if (p < 0.12) v = lo
    else if (p < 0.24) v = hi
    else if (p < 0.34) v = 0
    else if (p < 0.42) v = lo < 0 ? -1 : 1
    else if (p < 0.5) v = lo < 0 ? lo + 1 : hi - 1
    else if (p < 0.8) v = r.int(Math.max(lo, -20), Math.min(hi, 20))
    else v = r.int(lo, hi)
    if (isBitTy(t) || (t === 'UDINT' && r.chance(0.3))) return `${t}#16#${v.toString(16).toUpperCase()}`
    return `${t}#${v}`
  }

  private realLit(t: Ty): string {
    const r = this.r
    const fixed = ['0.0', '-0.0', '1.0', '-1.0', '0.1', '0.5', '2.5', '-2.5', '1.5', '-0.5', '1.0E10', '-1.0E10', '3.4E38', '1.0E-38',
      '16777217.0', '123.456', '65535.5', '2147483648.0', '-2147483649.5', '4294967296.0', '1.0E-45', '1.0E300', '127.5', '-128.5', '32767.5']
    const s = r.chance(0.6) ? r.pick(fixed) : (r.next() * 2000 - 1000).toFixed(r.int(0, 4)).replace(/^(-?\d+)$/, '$1.0')
    if (t === 'REAL' && s === '1.0E300') return 'REAL#1.0E30'
    return `${t}#${s}`
  }

  private timeLit(): string {
    return this.r.pick(['T#0ms', 'T#1ms', 'T#7ms', 'T#100ms', 'T#250ms', 'T#1s', 'T#2s500ms', 'T#-1s', 'T#-30ms', 'T#1h', 'T#24d', 'T#1m30s', 'T#49d17h', 'T#3s'])
  }

  private strLit(): string {
    return this.r.pick(["''", "'a'", "'abc'", "'Hello'", "'0123456789AB'", "'-12'", "'TRUE'", "'3.5'", "'x y'"])
  }

  private lit(t: Ty): string {
    if (t === 'BOOL') return this.r.chance(0.5) ? 'TRUE' : 'FALSE'
    if (t === 'TIME') return this.timeLit()
    if (t === 'STRING') return this.strLit()
    if (isRealTy(t)) return this.realLit(t)
    return this.intLit(t)
  }

  // ---- places ----

  private templatesFor(t: Ty | null, writable: boolean, shapeSig?: string): Template[] {
    return this.sc.templates.filter((tp) =>
      (!writable || !tp.ro) && (shapeSig !== undefined ? tp.leaf.k !== 'scalar' && sig(tp.leaf) === shapeSig : tp.leaf.k === 'scalar' && tp.leaf.t === t))
  }

  private index(lo: number, hi: number, d: number): string {
    const r = this.r
    const p = r.next()
    if (d <= 0 || p < 0.12) return String(r.int(lo, hi))
    // a subscript that is itself a place read (a variable, an element's field): generated code checks such a read in
    // place, repeating it, so a call inside it must still run once. The index places hold only 0 or 1.
    if (p < 0.4 && lo <= 0 && hi >= 1 && this.hasIx()) return this.ixPlace(d)
    // an unsigned LIMIT wraps a negative bound, so a range below zero is indexed at a signed type
    const t = r.pick(r.chance(0.6) ? (['DINT', 'INT'] as const) : lo < 0 ? SIGNED : INTS)
    const e = this.expr(t, Math.min(1, d - 1))
    if (p < 0.995) return `LIMIT(${lo}, ${e}, ${hi})`
    return e // raw: out of range faults, and both engines must fault alike
  }

  private hasIx(): boolean {
    return this.sc.roots.some((x) => x.name === 'gix')
  }

  /** One of the index places: `gix`, or `gixs[i].j`, whose own subscript often holds a call. */
  private ixPlace(d: number): string {
    const r = this.r
    if (r.chance(0.3)) return 'gix'
    const ints = this.sc.funcs.filter((f) => isIntTy(f.ret))
    const sub = d <= 0 || r.chance(0.3)
      ? String(r.int(0, 3))
      : `LIMIT(0, ${ints.length && r.chance(0.5) ? this.call(r.pick(ints), Math.max(0, d - 2)) : this.expr(r.pick(['INT', 'DINT'] as Ty[]), d - 1)}, 3)`
    return `gixs[${sub}].j`
  }

  private render(tp: Template, d: number): string {
    let s = ''
    for (const st of tp.steps) {
      if (st.kind === 'name') s += st.name
      else if (st.kind === 'field') s += `.${st.name}`
      else s += `[${st.dims.map(([lo, hi]) => this.index(lo, hi, d)).join(', ')}]`
    }
    return s
  }

  /** A place of scalar type `t`, or null when the scope holds none. */
  private place(t: Ty, writable: boolean, d: number): string | null {
    const tps = this.templatesFor(t, writable)
    if (tps.length === 0) return null
    return this.render(this.r.pick(tps), d)
  }

  /** A bit of an integer place: `x.3`. */
  private bitPlace(writable: boolean, d: number): string | null {
    const tps = this.sc.templates.filter((tp) => (!writable || !tp.ro) && tp.leaf.k === 'scalar' && (isIntTy(tp.leaf.t) || isBitTy(tp.leaf.t)))
    if (tps.length === 0) return null
    const tp = this.r.pick(tps)
    const t = (tp.leaf as { t: Ty }).t
    return `${this.render(tp, d)}.${this.r.int(0, widthOf(t) - 1)}`
  }

  // ---- expressions ----

  /** An expression of exactly type `t`. */
  expr(t: Ty, depth: number): string {
    const r = this.r
    if (depth <= 0 || r.chance(0.3)) {
      if (r.chance(0.55)) {
        const p = t === 'BOOL' && r.chance(0.2) ? this.bitPlace(false, depth) : this.place(t, false, depth)
        if (p) return p
      }
      return this.lit(t)
    }
    const d = depth - 1
    // a user function of this type, now and then (its side effect on a global is what evaluation-count bugs show)
    const fns = this.sc.funcs.filter((f) => f.ret === t)
    if (fns.length && r.chance(0.12)) return this.call(r.pick(fns), d)
    if (r.chance(0.08)) {
      const src = r.pick(SCALARS.filter((s) => s !== t && convertible(s, t)))
      if (src) return `${src}_TO_${t}(${this.expr(src, d)})`
    }
    if (t === 'BOOL') return this.boolExpr(d)
    if (t === 'TIME') return this.timeExpr(d)
    if (t === 'STRING') return this.stringExpr(d)
    if (isBitTy(t)) return this.bitExpr(t, d)
    if (isRealTy(t)) return this.realExpr(t, d)
    return this.intExpr(t, d)
  }

  private call(f: FuncSig, d: number): string {
    return `${f.name}(${f.inputs.map((i) => this.expr(i.t, d)).join(', ')})`
  }

  private zero(t: Ty): string {
    return t === 'TIME' ? 'T#0ms' : isRealTy(t) ? `${t}#0.0` : `${t}#0`
  }

  /** A divisor of type `t`: mostly never zero, sometimes anything (a zero faults the scan, on both engines alike). */
  private divisor(t: Ty, d: number): string {
    const r = this.r
    const p = r.next()
    if (p < 0.4) {
      const [lo, hi] = RANGE[t]!
      const v = r.pick([1, 2, 3, 7, -1, -2, -3, hi, lo].filter((x) => x >= lo && x <= hi && x !== 0))
      return `${t}#${v}`
    }
    const e = this.expr(t, d)
    if (p < 0.99) return `SEL(${e} = ${this.zero(t)}, ${e}, ${t}#7)`
    return e
  }

  private same(t: Ty, d: number, n: number): string {
    return Array.from({ length: n }, () => this.expr(t, d)).join(', ')
  }

  private untypedOr(t: Ty, d: number): string {
    // an untyped literal beside a typed operand takes that operand's type (checkAssign.ts retypeLiteralTree)
    if (this.r.chance(0.25)) {
      const [lo, hi] = RANGE[t] ?? [-1000, 1000]
      return String(this.r.int(Math.max(0, lo), Math.min(hi, 100)))
    }
    return this.expr(t, d)
  }

  private selector(d: number): string {
    const k = this.r.pick(INTS)
    const e = this.expr(k, d)
    return this.r.chance(0.7) ? `LIMIT(0, ${e}, 2)` : e
  }

  private common(t: Ty, d: number): string | null {
    const r = this.r
    switch (r.int(0, 5)) {
      case 0: return `${r.pick(['MIN', 'MAX'])}(${this.same(t, d, r.int(2, 3))})`
      case 1: return `LIMIT(${this.same(t, d, 3)})`
      case 2: return `SEL(${this.expr('BOOL', d)}, ${this.same(t, d, 2)})`
      case 3: return `MUX(${this.selector(d)}, ${this.same(t, d, 3)})`
      case 4: return `MOVE(${this.expr(t, d)})`
      default: return null
    }
  }

  private intExpr(t: Ty, d: number): string {
    const r = this.r
    if (r.chance(0.3)) {
      const c = this.common(t, d)
      if (c) return c
    }
    switch (r.int(0, 11)) {
      case 0: case 1: case 2: return `(${this.expr(t, d)} ${r.pick(['+', '-', '*'])} ${this.untypedOr(t, d)})`
      case 3: return `(${this.expr(t, d)} ${r.pick(['/', 'MOD'])} ${this.divisor(t, d)})`
      case 4: return `(-${this.expr(t, d)})`
      case 5: return `ABS(${this.expr(t, d)})`
      case 6: return `${r.pick(['ADD', 'MUL'])}(${this.same(t, d, r.int(2, 3))})`
      case 7: return `SUB(${this.same(t, d, 2)})`
      case 8: return `DIV(${this.expr(t, d)}, ${this.divisor(t, d)})`
      case 9:
      case 10: {
        if (t === 'DINT' && r.chance(0.5)) return `TRUNC(${this.expr(r.pick(REALS), d)})`
        const src = r.pick(CONV_NUM.filter((x) => x !== t))
        return `${src}_TO_${t}(${this.expr(src, d)})`
      }
      default: return `(${this.expr(t, d)} + ${this.expr(t, d)})`
    }
  }

  private bitExpr(t: Ty, d: number): string {
    const r = this.r
    if (r.chance(0.25)) {
      const c = this.common(t, d)
      if (c) return c
    }
    switch (r.int(0, 6)) {
      case 0: case 1: return `(${this.expr(t, d)} ${r.pick(['AND', 'OR', 'XOR'])} ${this.untypedOr(t, d)})`
      case 2: return `(NOT ${this.expr(t, d)})`
      case 3: case 4: {
        let n: string
        if (r.chance(0.6)) {
          const k = r.pick(INTS)
          const v = SIGNED.includes(k) && r.chance(0.1) ? -1 : r.int(0, 3) === 0 ? r.int(0, 40) : r.int(0, widthOf(t))
          n = `${k}#${v}`
        } else n = this.expr(r.pick(INTS), d)
        return `${r.pick(['SHL', 'SHR', 'ROL', 'ROR'])}(${this.expr(t, d)}, ${n})`
      }
      default: {
        const src = r.pick([...INTS, ...BITS, 'BOOL'].filter((s) => s !== t)) as Ty
        return `${src}_TO_${t}(${this.expr(src, d)})`
      }
    }
  }

  private realExpr(t: Ty, d: number): string {
    const r = this.r
    if (r.chance(0.25)) {
      const c = this.common(t, d)
      if (c) return c
    }
    switch (r.int(0, 9)) {
      case 0: case 1: case 2: return `(${this.expr(t, d)} ${r.pick(['+', '-', '*', '/'])} ${this.expr(t, d)})`
      case 3: return `(-${this.expr(t, d)})`
      case 4: return `ABS(${this.expr(t, d)})`
      case 5: {
        const f = `${r.pick(['SQRT', 'SIN', 'COS', 'TAN', 'EXP', 'LN', 'LOG', 'ATAN', 'ASIN', 'ACOS'])}(${this.expr(r.pick(REALS), d)})`
        return t === 'REAL' ? f : `REAL_TO_LREAL(${f})`
      }
      case 6: {
        const f = `EXPT(${this.expr(r.pick(REALS), d)}, ${this.expr(r.pick([...REALS, 'DINT', 'INT'] as Ty[]), d)})`
        return t === 'REAL' ? f : `REAL_TO_LREAL(${f})`
      }
      case 7: return `${r.pick(['ADD', 'MUL', 'SUB', 'DIV'])}(${this.same(t, d, 2)})`
      default: {
        const src = r.pick([...INTS, ...REALS, 'TIME', 'BOOL', ...BITS].filter((s) => s !== t)) as Ty
        return `${src}_TO_${t}(${this.expr(src, d)})`
      }
    }
  }

  private timeExpr(d: number): string {
    const r = this.r
    if (r.chance(0.25)) {
      const c = this.common('TIME', d)
      if (c) return c
    }
    switch (r.int(0, 6)) {
      case 0: case 1: return `(${this.expr('TIME', d)} ${r.pick(['+', '-'])} ${this.expr('TIME', d)})`
      case 2: return `(${this.expr('TIME', d)} * ${this.expr(r.pick(['DINT', 'INT', 'REAL', 'SINT'] as Ty[]), d)})`
      case 3: {
        const k = r.pick(['DINT', 'INT', 'REAL'] as Ty[])
        return `(${this.expr('TIME', d)} / ${k === 'REAL' ? `SEL(${this.expr(k, d)} = REAL#0.0, ${this.expr(k, d)}, REAL#2.5)` : this.divisor(k, d)})`
      }
      case 4: {
        const src = r.pick(['DINT', 'UDINT', 'LREAL', 'INT'] as Ty[])
        return `${src}_TO_TIME(${this.expr(src, d)})`
      }
      default: return this.lit('TIME')
    }
  }

  private stringExpr(d: number): string {
    const r = this.r
    const n = (): string => (r.chance(0.8) ? `LIMIT(0, ${this.expr('INT', d)}, 14)` : this.expr('INT', d))
    switch (r.int(0, 6)) {
      case 0: return `CONCAT(${this.same('STRING', d, r.int(2, 3))})`
      case 1: return `LEFT(${this.expr('STRING', d)}, ${n()})`
      case 2: return `RIGHT(${this.expr('STRING', d)}, ${n()})`
      case 3: return `MID(${this.expr('STRING', d)}, ${n()}, ${n()})`
      case 4: {
        const src = r.pick(['DINT', 'INT', 'BOOL', 'UDINT', 'SINT', 'WORD', 'REAL', 'TIME'] as Ty[])
        return `${src}_TO_STRING(${this.expr(src, d)})`
      }
      case 5: return `SEL(${this.expr('BOOL', d)}, ${this.same('STRING', d, 2)})`
      default: return this.lit('STRING')
    }
  }

  private boolExpr(d: number): string {
    const r = this.r
    switch (r.int(0, 11)) {
      case 0: case 1: case 2: {
        const ct = r.pick(SCALARS.filter((s) => s !== 'STRING' || r.chance(0.3)))
        const op = ct === 'BOOL' ? r.pick(['=', '<>']) : r.pick(['=', '<>', '<', '>', '<=', '>='])
        return `(${this.expr(ct, d)} ${op} ${isIntTy(ct) || isBitTy(ct) ? this.untypedOr(ct, d) : this.expr(ct, d)})`
      }
      case 3: case 4: return `(${this.expr('BOOL', d)} ${r.pick(['AND', 'OR', 'XOR'])} ${this.expr('BOOL', d)})`
      case 5: return `(NOT ${this.expr('BOOL', d)})`
      case 6: {
        const ct = r.pick([...NUMERIC, 'TIME'] as Ty[])
        return `${r.pick(['GT', 'GE', 'EQ', 'LE', 'LT', 'NE'])}(${this.same(ct, d, 2)})`
      }
      case 7: {
        const ct = r.pick([...NUMERIC] as Ty[])
        return `${r.pick(['GT', 'GE', 'EQ', 'LE', 'LT'])}(${this.same(ct, d, 3)})`
      }
      case 8: {
        const b = this.bitPlace(false, d)
        if (b) return b
        return this.lit('BOOL')
      }
      case 9: {
        const c = this.common('BOOL', d)
        if (c && !c.startsWith('MIN') && !c.startsWith('MAX') && !c.startsWith('LIMIT')) return c
        return `(${this.expr('BOOL', d)} AND ${this.expr('BOOL', d)})`
      }
      default: {
        const src = r.pick([...INTS, ...BITS, ...REALS] as Ty[])
        return `${src}_TO_BOOL(${this.expr(src, d)})`
      }
    }
  }

  // ---- statements ----

  private stmts(n: number, indent: string): string {
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(this.stmt(indent))
    return out.join('\n')
  }

  private assign(indent: string): string {
    const r = this.r
    // a whole struct or array, now and then
    if (r.chance(0.06)) {
      const aggs = this.sc.templates.filter((tp) => !tp.ro && tp.leaf.k !== 'scalar')
      if (aggs.length) {
        const dst = r.pick(aggs)
        const srcs = this.templatesFor(null, false, sig(dst.leaf))
        if (srcs.length) return `${indent}${this.render(dst, 2)} := ${this.render(r.pick(srcs), 2)};`
      }
    }
    if (r.chance(0.08)) {
      const b = this.bitPlace(true, 2)
      if (b) return `${indent}${b} := ${this.expr('BOOL', this.o.exprDepth)};`
    }
    const tps = this.sc.templates.filter((tp) => !tp.ro && tp.leaf.k === 'scalar')
    const tp = r.pick(tps)
    const t = (tp.leaf as { t: Ty }).t
    // the place first: a subscript's side effects happen in source order
    const place = this.render(tp, 2)
    return `${indent}${place} := ${this.expr(t, this.o.exprDepth)};`
  }

  private stmt(indent: string): string {
    const r = this.r
    const sc = this.sc
    const nested = sc.blockDepth < this.o.blockDepth
    const p = r.next()
    if (sc.loopDepth > 0 && p < 0.06) return `${indent}IF ${this.expr('BOOL', 2)} THEN ${r.pick(['EXIT', 'CONTINUE'])}; END_IF;`
    if (sc.canReturn && p < 0.075) return `${indent}IF ${this.expr('BOOL', 2)} THEN RETURN; END_IF;`
    if (p > 0.95 && this.hasIx()) return `${indent}${this.ixPlace(2)} := LIMIT(0, ${this.expr('INT', 2)}, 1);`
    if (!nested || p < 0.55) {
      if (sc.fbs.length && r.chance(0.12)) return this.fbCall(indent)
      if (sc.std.length && r.chance(0.08)) return this.stdCall(indent)
      return this.assign(indent)
    }
    const inner = indent + '  '
    const body = (n: number): string => {
      sc.blockDepth++
      const s = this.stmts(n, inner)
      sc.blockDepth--
      return s
    }
    const q = r.next()
    if (q < 0.35) {
      let s = `${indent}IF ${this.expr('BOOL', this.o.exprDepth)} THEN\n${body(r.int(1, 3))}`
      const elsifs = r.int(0, 2)
      for (let i = 0; i < elsifs; i++) s += `\n${indent}ELSIF ${this.expr('BOOL', this.o.exprDepth)} THEN\n${body(r.int(1, 2))}`
      if (r.chance(0.5)) s += `\n${indent}ELSE\n${body(r.int(1, 2))}`
      return `${s}\n${indent}END_IF;`
    }
    if (q < 0.55) return this.caseStmt(indent, body)
    if (sc.loopDepth >= 2) return this.assign(indent)
    const loop = (make: (v: string) => string, pool: 'forVars' | 'whileVars'): string => {
      const v = sc[pool].shift()
      if (v === undefined) return this.assign(indent)
      sc.loopDepth++
      const s = make(v)
      sc.loopDepth--
      sc[pool].unshift(v)
      return s
    }
    if (q < 0.75) {
      return loop((v) => {
        const by = r.pick(['', '', '', ' BY 2', ' BY -1', ' BY 3', ' BY -2'])
        const from = r.chance(0.5) ? String(r.int(-3, 4)) : `LIMIT(-3, ${this.expr('DINT', 2)}, 4)`
        const to = r.chance(0.5) ? String(r.int(-3, 6)) : `LIMIT(-3, ${this.expr('DINT', 2)}, 6)`
        return `${indent}FOR ${v} := ${from} TO ${to}${by} DO\n${body(r.int(1, 3))}\n${indent}END_FOR;`
      }, 'forVars')
    }
    if (q < 0.88) {
      return loop((v) => {
        const cap = r.int(1, 6)
        return `${indent}${v} := 0;\n${indent}WHILE ${v} < ${cap} AND ${this.expr('BOOL', 2)} DO\n${inner}${v} := ${v} + 1;\n${body(r.int(1, 3))}\n${indent}END_WHILE;`
      }, 'whileVars')
    }
    return loop((v) => {
      const cap = r.int(1, 6)
      return `${indent}${v} := 0;\n${indent}REPEAT\n${inner}${v} := ${v} + 1;\n${body(r.int(1, 3))}\n${indent}UNTIL ${v} >= ${cap} OR ${this.expr('BOOL', 2)}\n${indent}END_REPEAT;`
    }, 'whileVars')
  }

  private caseStmt(indent: string, body: (n: number) => string): string {
    const r = this.r
    const t = r.pick(INTS)
    const signed = SIGNED.includes(t)
    const used = new Set<number>()
    const arms: string[] = []
    const nArms = r.int(1, 4)
    for (let i = 0; i < nArms; i++) {
      const labels: string[] = []
      for (let j = r.int(1, 2); j > 0; j--) {
        const lo = r.int(signed ? -4 : 0, 8)
        if (r.chance(0.3)) {
          const hi = lo + r.int(1, 3)
          let free = true
          for (let x = lo; x <= hi; x++) if (used.has(x)) free = false
          if (!free) continue
          for (let x = lo; x <= hi; x++) used.add(x)
          labels.push(`${lo}..${hi}`)
        } else if (!used.has(lo)) {
          used.add(lo)
          labels.push(String(lo))
        }
      }
      if (labels.length) arms.push(`${indent}  ${labels.join(', ')}:\n${body(r.int(1, 2)).replace(/^/gm, '  ')}`)
    }
    if (arms.length === 0) arms.push(`${indent}  0:\n${body(1).replace(/^/gm, '  ')}`)
    const sel = r.chance(0.7) ? `LIMIT(${signed ? -5 : 0}, ${this.expr(t, 2)}, 9)` : this.expr(t, 2)
    const els = r.chance(0.5) ? `\n${indent}ELSE\n${body(r.int(1, 2))}` : ''
    return `${indent}CASE ${sel} OF\n${arms.join('\n')}${els}\n${indent}END_CASE;`
  }

  private fbCall(indent: string): string {
    const r = this.r
    const { root, def } = r.pick(this.sc.fbs)
    let inst = root.name
    if (root.shape.k === 'array') inst += `[${root.shape.dims.map(([lo, hi]) => this.index(lo, hi, 2)).join(', ')}]`
    const args: string[] = []
    for (const i of def.inputs) if (r.chance(0.8)) args.push(`${i.name} := ${this.expr(i.t, 2)}`)
    for (const io of def.inouts) {
      const p = this.place(io.t, true, 2)
      if (!p) return this.assign(indent)
      args.push(`${io.name} := ${p}`)
    }
    for (const o of def.outputs) {
      if (r.chance(0.3)) {
        const p = this.place(o.t, true, 2)
        if (p) args.push(`${o.name} => ${p}`)
      }
    }
    return `${indent}${inst}(${args.join(', ')});`
  }

  /** A standard block's call. Each input is left out now and then, so the block runs on the value the last call gave
   *  it (runtime.ts: a block keeps its inputs). */
  private stdCall(indent: string): string {
    const r = this.r
    const f = r.pick(this.sc.std)
    const b = (): string => this.expr('BOOL', 2)
    const pt = (): string => (r.chance(0.7) ? r.pick(['T#50ms', 'T#100ms', 'T#200ms', 'T#0ms']) : this.expr('TIME', 2))
    const pv = (): string => this.expr('INT', 2)
    const inputs: [string, () => string][] = (() => {
      switch (f.type) {
        case 'TON': case 'TOF': case 'TP': return [['IN', b], ['PT', pt]]
        case 'CTU': return [['CU', b], [r.chance(0.2) ? 'RESET' : 'R', b], ['PV', pv]]
        case 'CTD': return [['CD', b], ['LD', b], ['PV', pv]]
        case 'CTUD': return [['CU', b], ['CD', b], [r.chance(0.2) ? 'RESET' : 'R', b], ['LD', b], ['PV', pv]]
        case 'R_TRIG': case 'F_TRIG': return [['CLK', b]]
        case 'SR': return [['S1', b], ['R', b]]
        case 'RS': return [['S', b], ['R1', b]]
      }
    })()
    const args = inputs.filter(() => r.chance(0.75)).map(([name, v]) => `${name} := ${v()}`)
    return `${indent}${f.name}(${args.join(', ')});`
  }

  // ---- declarations ----

  private scalarType(): Ty {
    const r = this.r
    return r.chance(0.3) ? r.pick(['DINT', 'INT', 'BOOL'] as Ty[]) : r.pick(SCALARS.filter((t) => t !== 'STRING' || r.chance(0.4)))
  }

  private decl(name: string, s: Shape): string {
    return `${name} : ${typeText(s)};`
  }

  private arrayShape(elem: Shape): Shape {
    const r = this.r
    const lo = r.pick([0, 1, -2, 0, -1, 3])
    const dims: [number, number][] = [[lo, Math.max(lo + r.int(1, 5), lo < 1 ? 1 : 0)]]
    if (r.chance(0.2)) {
      const lo2 = r.pick([0, 1, -1])
      dims.push([lo2, lo2 + r.int(1, 3)])
    }
    return { k: 'array', dims, elem }
  }

  /** Make a scope from roots. */
  private scope(roots: Root[], extra: Partial<Scope>): Scope {
    return {
      roots, templates: templatesOf(roots), funcs: [], fbs: [], std: [], forVars: [], whileVars: [],
      loopDepth: 0, blockDepth: 0, canReturn: false, ...extra,
    }
  }

  /** One whole program. */
  program(): Generated {
    const r = this.r
    const parts: string[] = []

    // a struct type
    const fieldTypes = Array.from({ length: r.int(2, 4) }, () => this.scalarType())
    const st: Shape = {
      k: 'struct', name: 'Pt', fields: [
        ...fieldTypes.map((t, i) => ({ name: `f${i}`, shape: { k: 'scalar', t } as Shape })),
        ...(r.chance(0.6) ? [{ name: 'fa', shape: this.arrayShape({ k: 'scalar', t: r.pick(['DINT', 'INT', 'BOOL', 'UDINT', 'REAL'] as Ty[]) }) }] : []),
      ],
    }
    parts.push('TYPE IxT : STRUCT\n  j : INT;\nEND_STRUCT;\nEND_TYPE')
    parts.push(`TYPE Pt : STRUCT\n${st.fields.map((f) => `  ${this.decl(f.name, f.shape)}`).join('\n')}\nEND_STRUCT;\nEND_TYPE`)

    // globals, the counter a function's side effect bumps among them
    const globals: Root[] = [{ name: 'gcnt', shape: { k: 'scalar', t: 'DINT' }, ro: false }]
    // the index places (ixPlace): read anywhere, written only by their own statement, so they hold 0 or 1
    globals.push({ name: 'gix', shape: { k: 'scalar', t: 'INT' }, ro: true })
    globals.push({ name: 'gixs', shape: { k: 'array', dims: [[0, 3]], elem: { k: 'struct', name: 'IxT', fields: [{ name: 'j', shape: { k: 'scalar', t: 'INT' } }] } }, ro: true })
    for (let i = 0; i < r.int(0, 2); i++) globals.push({ name: `g${i}`, shape: { k: 'scalar', t: this.scalarType() }, ro: false })
    if (r.chance(0.4)) globals.push({ name: 'garr', shape: this.arrayShape({ k: 'scalar', t: r.pick(['DINT', 'INT', 'BOOL'] as Ty[]) }), ro: false })
    parts.push(`VAR_GLOBAL\n${globals.map((g) => `  ${this.decl(g.name, g.shape)}`).join('\n')}\nEND_VAR`)
    const ext = (gs: Root[]): string => `VAR_EXTERNAL\n${gs.map((g) => `  ${this.decl(g.name, g.shape)}`).join('\n')}\nEND_VAR`

    // user functions: each bumps gcnt; the second may call the first
    const funcs: FuncSig[] = []
    for (let k = 0; k < r.int(1, 2); k++) {
      const ret = r.pick(['DINT', 'INT', 'UDINT', 'BOOL', 'REAL', 'WORD', 'SINT', 'LREAL'] as Ty[])
      const inputs = Array.from({ length: r.int(1, 3) }, (_, i) => ({ name: `a${i}`, t: r.chance(0.5) ? r.pick(['DINT', 'INT'] as Ty[]) : this.scalarType() }))
      const locals: Root[] = [{ name: 'tmp', shape: { k: 'scalar', t: ret }, ro: false }]
      if (r.chance(0.4)) locals.push({ name: 'la', shape: this.arrayShape({ k: 'scalar', t: 'DINT' }), ro: false })
      const name = `F${k}`
      this.sc = this.scope(
        [...inputs.map((i) => ({ name: i.name, shape: { k: 'scalar', t: i.t } as Shape, ro: true })), ...locals, ...globals,
          { name, shape: { k: 'scalar', t: ret }, ro: false }],
        { funcs: [...funcs], blockDepth: 1, canReturn: true },
      )
      const body = `  gcnt := gcnt + 1;\n${this.stmts(r.int(0, 3), '  ')}\n  ${name} := ${this.expr(ret, 2)};`
      parts.push(`FUNCTION ${name} : ${ret}\nVAR_INPUT\n${inputs.map((i) => `  ${i.name} : ${i.t};`).join('\n')}\nEND_VAR\n${ext(globals)}\nVAR\n${locals.map((l) => `  ${this.decl(l.name, l.shape)}`).join('\n')}\nEND_VAR\n${body}\nEND_FUNCTION`)
      funcs.push({ name, ret, inputs })
    }

    // a user function block with inputs, outputs and an in-out
    const fb: FbDef = {
      type: 'Blk',
      inputs: Array.from({ length: r.int(1, 3) }, (_, i) => ({ name: `i${i}`, t: this.scalarType() })),
      outputs: Array.from({ length: r.int(1, 2) }, (_, i) => ({ name: `o${i}`, t: this.scalarType() })),
      inouts: r.chance(0.7) ? [{ name: 'io', t: r.pick(['DINT', 'INT', 'BOOL', 'REAL', 'UDINT'] as Ty[]) }] : [],
    }
    {
      const locals: Root[] = [{ name: 'st', shape: { k: 'scalar', t: this.scalarType() }, ro: false }]
      if (r.chance(0.5)) locals.push({ name: 'arr', shape: this.arrayShape({ k: 'scalar', t: this.scalarType() }), ro: false })
      const ctr = ['bk0', 'bk1']
      const wctr = ['bw0']
      this.sc = this.scope(
        [
          ...fb.inputs.map((i) => ({ name: i.name, shape: { k: 'scalar', t: i.t } as Shape, ro: true })),
          ...fb.outputs.map((i) => ({ name: i.name, shape: { k: 'scalar', t: i.t } as Shape, ro: false })),
          ...fb.inouts.map((i) => ({ name: i.name, shape: { k: 'scalar', t: i.t } as Shape, ro: false })),
          ...locals, ...globals,
          ...[...ctr, ...wctr].map((c) => ({ name: c, shape: { k: 'scalar', t: 'DINT' } as Shape, ro: true })),
        ],
        { funcs: [...funcs], forVars: [...ctr], whileVars: [...wctr], blockDepth: 1, canReturn: true },
      )
      const body = this.stmts(r.int(2, 5), '  ')
      const sect = (kw: string, xs: { name: string; t: Ty }[]): string => (xs.length ? `${kw}\n${xs.map((x) => `  ${x.name} : ${x.t};`).join('\n')}\nEND_VAR\n` : '')
      parts.push(`FUNCTION_BLOCK ${fb.type}\n${sect('VAR_INPUT', fb.inputs)}${sect('VAR_OUTPUT', fb.outputs)}${sect('VAR_IN_OUT', fb.inouts)}${ext(globals)}\nVAR\n${[...locals.map((l) => `  ${this.decl(l.name, l.shape)}`), ...[...ctr, ...wctr].map((c) => `  ${c} : DINT;`)].join('\n')}\nEND_VAR\n${body}\nEND_FUNCTION_BLOCK`)
    }

    // the program
    const big = r.chance(0.08)
    const vars: Root[] = []
    for (let i = 0; i < r.int(5, 10); i++) vars.push({ name: `v${i}`, shape: { k: 'scalar', t: this.scalarType() }, ro: false })
    for (const t of ['DINT', 'BOOL'] as Ty[]) vars.push({ name: `x${t.toLowerCase()}`, shape: { k: 'scalar', t }, ro: false })
    for (let i = 0; i < r.int(1, 3); i++) vars.push({ name: `arr${i}`, shape: this.arrayShape({ k: 'scalar', t: this.scalarType() }), ro: false })
    if (r.chance(0.3)) vars.push({ name: 'twin', shape: vars.find((v) => v.name === 'arr0')!.shape, ro: false })
    vars.push({ name: 'p0', shape: st, ro: false })
    if (r.chance(0.6)) vars.push({ name: 'pa', shape: this.arrayShape(st), ro: false })
    const outShape: Shape = { k: 'struct', name: 'Blk', fields: fb.outputs.map((o) => ({ name: o.name, shape: { k: 'scalar', t: o.t } as Shape })) }
    const fbRoots: Root[] = [{ name: 'blk', shape: outShape, ro: true }]
    if (r.chance(0.4)) fbRoots.push({ name: 'blks', shape: { k: 'array', dims: [[0, 1]], elem: outShape }, ro: true })
    const std: StdFb[] = Array.from({ length: r.int(0, 3) }, (_, i) => ({ name: `sb${i}`, type: r.pick(['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG', 'SR', 'RS'] as const) }))
    const stdRoots: Root[] = std.map((s) => ({ name: s.name, ro: true, shape: { k: 'struct', name: s.type, fields: stdOutputs(s.type).map(([n, t]) => ({ name: n, shape: { k: 'scalar', t } as Shape })) } }))
    const ctr = ['k0', 'k1']
    const wctr = ['w0', 'w1']
    this.sc = this.scope(
      [...vars, ...globals, ...fbRoots, ...stdRoots, ...[...ctr, ...wctr].map((c) => ({ name: c, shape: { k: 'scalar', t: 'DINT' } as Shape, ro: true }))],
      { funcs: [...funcs], fbs: fbRoots.map((root) => ({ root, def: fb })), std, forVars: [...ctr], whileVars: [...wctr], canReturn: true },
    )
    const saved = this.o
    if (big) this.o = { ...this.o, statements: this.o.statements * 3, blockDepth: this.o.blockDepth + 2 }
    const body = this.stmts(this.o.statements, '')
    this.o = saved
    const decls = [
      ...vars.map((v) => `  ${this.decl(v.name, v.shape)}`),
      `  blk : ${fb.type};`,
      ...(fbRoots.length > 1 ? [`  blks : ARRAY[0..1] OF ${fb.type};`] : []),
      ...std.map((s) => `  ${s.name} : ${s.type};`),
      ...[...ctr, ...wctr].map((c) => `  ${c} : DINT;`),
    ]
    parts.push(`PROGRAM Main\n${ext(globals)}\nVAR\n${decls.join('\n')}\nEND_VAR\n${body}\nEND_PROGRAM`)
    return { src: parts.join('\n\n'), big }
  }
}

function stdOutputs(t: StdFb['type']): [string, Ty][] {
  switch (t) {
    case 'TON': case 'TOF': case 'TP': return [['Q', 'BOOL'], ['ET', 'TIME']]
    case 'CTU': case 'CTD': return [['Q', 'BOOL'], ['CV', 'INT']]
    case 'CTUD': return [['QU', 'BOOL'], ['QD', 'BOOL'], ['CV', 'INT']]
    case 'R_TRIG': case 'F_TRIG': return [['Q', 'BOOL']]
    case 'SR': case 'RS': return [['Q1', 'BOOL']]
  }
}

function typeText(s: Shape): string {
  if (s.k === 'scalar') return s.t === 'STRING' ? 'STRING[10]' : s.t
  if (s.k === 'struct') return s.name
  return `ARRAY[${s.dims.map(([lo, hi]) => `${lo}..${hi}`).join(', ')}] OF ${typeText(s.elem)}`
}

/** Whether `src_TO_dst` is a conversion the language has. */
function convertible(src: Ty, dst: Ty): boolean {
  if (src === dst) return false
  if (src === 'STRING' || dst === 'STRING') return src !== 'TIME' || dst === 'STRING'
  return true
}

/** One generated program for a seed. */
export function generateProgram(seed: number, opts: Partial<GenOptions> = {}): Generated {
  return new StFuzzGen(seed, opts).program()
}
