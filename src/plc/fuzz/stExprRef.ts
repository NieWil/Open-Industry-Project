// Random ST expressions with the value IEC arithmetic gives them, worked out here independently of both engines.
//
// The differential fuzzer (stFuzz.test.ts) holds the two engines to each other, so a rule both share (a helper in
// runtime.ts or builtins.ts that each calls) is wrong in both alike and unseen: a UDINT product losing its low bits,
// MUL() disagreeing with `*`, MUX with a negative selector. This is the other half: integers are computed exactly in
// BigInt and wrapped to their width, reals in binary64 rounded to binary32 for a REAL after every operation, and the
// program's variables after one scan must hold exactly those values.
//
// Where IEC 61131-3 leaves a result open, the expected value is this engine's documented rule, so the check pins it:
// integer overflow wraps modulo the width (a conversion too), MUX with a selector outside its inputs answers 0, a
// shift by the width or more gives 0, and a rotate counts modulo the width. Division and MOD by zero are not generated
// (they fault, which the differential fuzzer compares), nor is a real converted to an integer it does not fit.
//
// Test support, not app code: nothing outside the specs imports it.

import { Rng, type Ty } from './stFuzzGen'

type IntTy = 'SINT' | 'INT' | 'DINT' | 'USINT' | 'UINT' | 'UDINT' | 'BYTE' | 'WORD' | 'DWORD'
type Val = bigint | number | boolean

const SIGNED: readonly IntTy[] = ['SINT', 'INT', 'DINT']
const UNSIGNED: readonly IntTy[] = ['USINT', 'UINT', 'UDINT']
const NUMS: readonly IntTy[] = [...SIGNED, ...UNSIGNED]
const BITS: readonly IntTy[] = ['BYTE', 'WORD', 'DWORD']
const INTS: readonly IntTy[] = [...NUMS, ...BITS]
const REALS = ['REAL', 'LREAL'] as const

const width = (t: IntTy): number => (t === 'SINT' || t === 'USINT' || t === 'BYTE' ? 8 : t === 'INT' || t === 'UINT' || t === 'WORD' ? 16 : 32)
const isSigned = (t: Ty): boolean => (SIGNED as readonly Ty[]).includes(t)
const isInt = (t: Ty): t is IntTy => (INTS as readonly Ty[]).includes(t)
const isBits = (t: Ty): boolean => (BITS as readonly Ty[]).includes(t)
const isReal = (t: Ty): boolean => t === 'REAL' || t === 'LREAL'

/** `x` reduced to type `t`'s width: modulo 2^w, then into the signed range for a signed type. */
export function wrapB(t: IntTy, x: bigint): bigint {
  const w = BigInt(width(t))
  const m = 1n << w
  let u = ((x % m) + m) % m
  if (isSigned(t) && u >= m >> 1n) u -= m
  return u
}

const unsignedOf = (t: IntTy, x: bigint): bigint => {
  const m = 1n << BigInt(width(t))
  return ((x % m) + m) % m
}

/** Round half to even, IEC's rule for a real converted to an integer. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d < 0.5) return f
  if (d > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

const real = (t: Ty, x: number): number => (t === 'REAL' ? Math.fround(x) : x)

interface E {
  src: string
  t: Ty
  v: Val
}

export interface RefProgram {
  src: string
  /** the value each result variable must hold after one scan */
  expect: Record<string, Val>
}

export class ExprRefGen {
  private r: Rng
  private decls: string[] = []
  private n = 0

  constructor(seed: number) {
    this.r = new Rng(seed * 7919 + 17)
  }

  // ---- leaves: a variable holding a value, so nothing folds when compiled ----

  private intValue(t: IntTy): bigint {
    const r = this.r
    const w = BigInt(width(t))
    const lo = isSigned(t) ? -(1n << (w - 1n)) : 0n
    const hi = isSigned(t) ? (1n << (w - 1n)) - 1n : (1n << w) - 1n
    const p = r.next()
    if (p < 0.15) return lo
    if (p < 0.3) return hi
    if (p < 0.38) return 0n
    if (p < 0.46) return isSigned(t) ? -1n : 1n
    if (p < 0.54) return isSigned(t) ? lo + 1n : hi - 1n
    if (p < 0.6) return isSigned(t) ? 1n << (w - 2n) : 1n << (w - 1n)
    if (p < 0.8) return wrapB(t, BigInt(r.int(-40, 40)))
    return lo + BigInt(Math.floor(r.next() * Number(hi - lo + 1n)))
  }

  private realValue(t: Ty): number {
    const r = this.r
    const fixed = [0, -0, 1, -1, 0.1, 0.5, 1.5, 2.5, -2.5, 3.5, -0.5, 16777217, 1e10, -1e10, 3.4e38, 1e-38, 2147483647.5, 4294967295.4, 123.456, 65535.5, -32768.5, 127.5]
    const v = r.chance(0.6) ? r.pick(fixed) : Math.round((r.next() * 2000 - 1000) * 1000) / 1000
    return real(t, v)
  }

  private leaf(t: Ty): E {
    const name = `q${this.n++}`
    let v: Val
    let init: string
    if (t === 'BOOL') {
      v = this.r.chance(0.5)
      init = v ? 'TRUE' : 'FALSE'
    } else if (isInt(t)) {
      v = this.intValue(t)
      init = isBits(t) ? `16#${v.toString(16).toUpperCase()}` : v.toString()
    } else {
      v = this.realValue(t)
      // the shortest text that reads back as v at this precision (a REAL's text rounds to f32 when stored)
      init = Object.is(v, -0) ? '-0.0' : formatReal(v)
    }
    this.decls.push(`  ${name} : ${t} := ${init};`)
    return { src: name, t, v }
  }

  // ---- expressions ----

  expr(t: Ty, d: number): E {
    if (d <= 0 || this.r.chance(0.2)) return this.leaf(t)
    if (t === 'BOOL') return this.bool(d - 1)
    if (isReal(t)) return this.realExpr(t, d - 1)
    return this.intExpr(t as IntTy, d - 1)
  }

  private nonZero(t: IntTy, d: number): E {
    for (let i = 0; i < 6; i++) {
      const e = this.expr(t, d)
      if (e.v !== 0n) return e
    }
    const name = `q${this.n++}`
    this.decls.push(`  ${name} : ${t} := 3;`)
    return { src: name, t, v: 3n }
  }

  /** `SRC_TO_dst(e)` from a random source type, or null for a real that does not fit the integer it would become. */
  private convFrom(dst: Ty, d: number): E | null {
    const r = this.r
    const src = r.pick(['BOOL', ...INTS, ...REALS].filter((s) => s !== dst) as Ty[])
    const e = this.expr(src, d)
    const name = `${src}_TO_${dst}(${e.src})`
    let v: Val
    if (dst === 'BOOL') v = typeof e.v === 'boolean' ? e.v : typeof e.v === 'bigint' ? e.v !== 0n : e.v !== 0
    else if (isReal(dst)) v = real(dst, typeof e.v === 'boolean' ? (e.v ? 1 : 0) : Number(e.v))
    else {
      let x: bigint
      if (typeof e.v === 'boolean') x = e.v ? 1n : 0n
      else if (typeof e.v === 'bigint') x = e.v
      else {
        // a real converted only where it fits: IEC leaves the rest open
        if (!Number.isFinite(e.v)) return null
        const k = roundHalfEven(e.v)
        const w = BigInt(width(dst as IntTy))
        const lo = isSigned(dst) ? -(1n << (w - 1n)) : 0n
        const hi = isSigned(dst) ? (1n << (w - 1n)) - 1n : (1n << w) - 1n
        if (Math.abs(k) > 2 ** 53 || BigInt(k) < lo || BigInt(k) > hi) return null
        x = BigInt(k)
      }
      v = wrapB(dst as IntTy, x)
    }
    return { src: name, t: dst, v }
  }

  private intExpr(t: IntTy, d: number): E {
    const r = this.r
    const num = !isBits(t)
    const k = r.int(0, num ? 10 : 9)
    const x = (): E => this.expr(t, d)
    const W = (v: bigint): E['v'] => wrapB(t, v)
    switch (num ? k : [0, 1, 2, 3, 4, 10, 11, 12, 13, 9][k]!) {
      case 0: { // MIN / MAX
        const f = r.pick(['MIN', 'MAX'])
        const a = Array.from({ length: r.int(2, 3) }, x)
        const vs = a.map((e) => e.v as bigint)
        return { src: `${f}(${a.map((e) => e.src).join(', ')})`, t, v: vs.reduce((p, q) => (f === 'MIN' ? (q < p ? q : p) : q > p ? q : p)) }
      }
      case 1: { // LIMIT(mn, in, mx) = MIN(MAX(in, mn), mx)
        const [mn, v, mx] = [x(), x(), x()]
        const lo = (v.v as bigint) > (mn.v as bigint) ? (v.v as bigint) : (mn.v as bigint)
        return { src: `LIMIT(${mn.src}, ${v.src}, ${mx.src})`, t, v: lo < (mx.v as bigint) ? lo : (mx.v as bigint) }
      }
      case 2: { // SEL(g, in0, in1)
        const g = this.expr('BOOL', d)
        const [a, b] = [x(), x()]
        return { src: `SEL(${g.src}, ${a.src}, ${b.src})`, t, v: g.v ? b.v : a.v }
      }
      case 3: { // MUX(k, in0, ...): outside the inputs, 0
        const kt = r.pick(INTS.filter((s) => !isBits(s)))
        const sel = this.expr(kt, d)
        const ins = Array.from({ length: r.int(2, 4) }, x)
        const i = sel.v as bigint
        return { src: `MUX(${sel.src}, ${ins.map((e) => e.src).join(', ')})`, t, v: i >= 0n && i < BigInt(ins.length) ? ins[Number(i)]!.v : 0n }
      }
      case 4: { // MOVE
        const a = x()
        return { src: `MOVE(${a.src})`, t, v: a.v }
      }
      case 5: { // + - *
        const op = r.pick(['+', '-', '*'])
        const [a, b] = [x(), x()]
        const p = a.v as bigint
        const q = b.v as bigint
        return { src: `(${a.src} ${op} ${b.src})`, t, v: W(op === '+' ? p + q : op === '-' ? p - q : p * q) }
      }
      case 6: { // / MOD: truncation toward zero, MOD takes the dividend's sign
        const op = r.pick(['/', 'MOD'])
        const a = x()
        const b = this.nonZero(t, d)
        const p = a.v as bigint
        const q = b.v as bigint
        return { src: `(${a.src} ${op} ${b.src})`, t, v: W(op === '/' ? p / q : p % q) }
      }
      case 7: { // ADD / MUL, two to four inputs: four 16-bit factors pass 2^53, where binary64 stops being exact
        const f = r.pick(['ADD', 'MUL'])
        const a = Array.from({ length: r.int(2, 4) }, x)
        const vs = a.map((e) => e.v as bigint)
        return { src: `${f}(${a.map((e) => e.src).join(', ')})`, t, v: W(vs.reduce((p, q) => (f === 'ADD' ? p + q : p * q))) }
      }
      case 8: { // SUB, DIV
        const f = r.pick(['SUB', 'DIV'])
        const a = x()
        const b = f === 'DIV' ? this.nonZero(t, d) : x()
        const p = a.v as bigint
        const q = b.v as bigint
        return { src: `${f}(${a.src}, ${b.src})`, t, v: W(f === 'SUB' ? p - q : p / q) }
      }
      case 9: { // a conversion
        return this.convFrom(t, d) ?? this.leaf(t)
      }
      case 10: { // unary minus, ABS (numbers); NOT (bit strings)
        const a = x()
        const p = a.v as bigint
        if (!num) return { src: `(NOT ${a.src})`, t, v: unsignedOf(t, ~p) }
        return r.chance(0.5) ? { src: `(-${a.src})`, t, v: W(-p) } : { src: `ABS(${a.src})`, t, v: W(p < 0n ? -p : p) }
      }
      case 11: { // AND OR XOR (bit strings)
        if (num) return this.leaf(t)
        const op = r.pick(['AND', 'OR', 'XOR'])
        const [a, b] = [x(), x()]
        const p = a.v as bigint
        const q = b.v as bigint
        return { src: `(${a.src} ${op} ${b.src})`, t, v: op === 'AND' ? p & q : op === 'OR' ? p | q : p ^ q }
      }
      case 12: case 13: { // shifts and rotates (bit strings), by 0 .. past the width
        if (num) return this.leaf(t)
        const f = r.pick(['SHL', 'SHR', 'ROL', 'ROR'])
        const a = x()
        const w = width(t)
        const nt = r.pick(NUMS.filter((s) => !isSigned(s) || r.chance(0.5)))
        const n = r.chance(0.7) ? r.int(0, w + 2) : r.int(0, 40)
        const name = `q${this.n++}`
        this.decls.push(`  ${name} : ${nt} := ${n};`)
        const u = a.v as bigint
        const m = (1n << BigInt(w)) - 1n
        let v: bigint
        if (f === 'SHL') v = n >= w ? 0n : (u << BigInt(n)) & m
        else if (f === 'SHR') v = n >= w ? 0n : u >> BigInt(n)
        else {
          const s = n % w
          const left = f === 'ROL' ? s : (w - s) % w
          v = left === 0 ? u : ((u << BigInt(left)) | (u >> BigInt(w - left))) & m
        }
        return { src: `${f}(${a.src}, ${name})`, t, v }
      }
      default:
        return this.leaf(t)
    }
  }

  private realExpr(t: Ty, d: number): E {
    const r = this.r
    const x = (): E => this.expr(t, d)
    switch (r.int(0, 7)) {
      case 0: case 1: {
        const op = r.pick(['+', '-', '*', '/'])
        const [a, b] = [x(), x()]
        const p = a.v as number
        const q = b.v as number
        return { src: `(${a.src} ${op} ${b.src})`, t, v: real(t, op === '+' ? p + q : op === '-' ? p - q : op === '*' ? p * q : p / q) }
      }
      case 2: {
        const f = r.pick(['ADD', 'MUL'])
        // two or three inputs: each step is the operator's, so each rounds to the result type, as `a + b + c` does
        const a = Array.from({ length: r.int(2, 3) }, x)
        return { src: `${f}(${a.map((e) => e.src).join(', ')})`, t, v: a.map((e) => e.v as number).reduce((p, q) => real(t, f === 'ADD' ? p + q : p * q)) }
      }
      case 3: {
        const a = x()
        return r.chance(0.5) ? { src: `(-${a.src})`, t, v: -(a.v as number) } : { src: `ABS(${a.src})`, t, v: Math.abs(a.v as number) }
      }
      case 4: {
        const f = r.pick(['MIN', 'MAX'])
        const a = [x(), x()]
        const vs = a.map((e) => e.v as number)
        return { src: `${f}(${a.map((e) => e.src).join(', ')})`, t, v: f === 'MIN' ? Math.min(...vs) : Math.max(...vs) }
      }
      case 5: {
        const g = this.expr('BOOL', d)
        const [a, b] = [x(), x()]
        return { src: `SEL(${g.src}, ${a.src}, ${b.src})`, t, v: g.v ? b.v : a.v }
      }
      default:
        return this.convFrom(t, d) ?? this.leaf(t)
    }
  }

  private bool(d: number): E {
    const r = this.r
    switch (r.int(0, 4)) {
      case 0: case 1: {
        const ct = r.pick([...INTS, ...REALS] as Ty[])
        const op = r.pick(['=', '<>', '<', '>', '<=', '>='])
        const [a, b] = [this.expr(ct, d), this.expr(ct, d)]
        const p = a.v as number | bigint
        const q = b.v as number | bigint
        const v = op === '=' ? p === q : op === '<>' ? p !== q : op === '<' ? p < q : op === '>' ? p > q : op === '<=' ? p <= q : p >= q
        return { src: `(${a.src} ${op} ${b.src})`, t: 'BOOL', v }
      }
      case 2: {
        const op = r.pick(['AND', 'OR', 'XOR'])
        const [a, b] = [this.expr('BOOL', d), this.expr('BOOL', d)]
        const p = a.v as boolean
        const q = b.v as boolean
        return { src: `(${a.src} ${op} ${b.src})`, t: 'BOOL', v: op === 'AND' ? p && q : op === 'OR' ? p || q : p !== q }
      }
      case 3: {
        const a = this.expr('BOOL', d)
        return { src: `(NOT ${a.src})`, t: 'BOOL', v: !a.v }
      }
      default:
        return this.convFrom('BOOL', d) ?? this.leaf('BOOL')
    }
  }

  /** A program assigning `count` random expressions to result variables. */
  program(count: number): RefProgram {
    const r = this.r
    const results: string[] = []
    const body: string[] = []
    const expect: Record<string, Val> = {}
    for (let i = 0; i < count; i++) {
      const t = r.pick(['BOOL', ...INTS, ...INTS, ...REALS] as Ty[])
      const e = this.expr(t, r.int(1, 4))
      results.push(`  r${i} : ${t};`)
      body.push(`r${i} := ${e.src};`)
      expect[`r${i}`] = typeof e.v === 'bigint' ? Number(e.v) : e.v
    }
    return { src: `PROGRAM Main\nVAR\n${[...this.decls, ...results].join('\n')}\nEND_VAR\n${body.join('\n')}\nEND_PROGRAM`, expect }
  }
}

/** A real's literal text that reads back as exactly `v` (binary64). */
function formatReal(v: number): string {
  const s = String(v)
  if (/e/i.test(s)) return s.replace(/^(-?\d+)(e)/i, '$1.0$2').toUpperCase()
  return s.includes('.') ? s : `${s}.0`
}

export function generateRefProgram(seed: number, count = 16): RefProgram {
  return new ExprRefGen(seed).program(count)
}
