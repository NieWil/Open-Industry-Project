// The scan engine every program runs on: the typed engine's code generator (docs/plc-typed-storage.md). Each
// definition's body becomes one JavaScript function, `(b, now) => void`, built once per definition (shared by every
// instance) and handed the instance's base address `b` in the program's arena (typed/arena.ts): a variable is a typed
// view's element at an offset decided when the program was laid out (typed/layout.ts), a global an absolute address.
// Everything outside the scan (watch, memory, setInput, ports, starting values) is the typed POU's (typed/pou.ts).
//
// It does what the walker (interpreter.ts buildPou's evalExpr / execStmt) does, node for node. The walker is the
// reference (plc/scanEngines.test.ts holds the two together, every variable after every scan) and the fallback. There
// is no per-node fallback: a construct this generator cannot write refuses the whole program (TypedUnsupported).
//
// What the speed rests on (measure with bench-sim; scanSpeed.test.ts gates the typed:walker ratio):
//   - Small functions. V8 will not optimise a very large function: a statement list past CHUNK characters is split
//     into sub-functions, and an EXIT / CONTINUE / RETURN that crosses one comes back as a code (1 return, 2 exit,
//     3 continue) the caller acts on in its own frame; inside one function they are native break / continue / return.
//   - Types. Where the checker's type proves a value is already in a place's form, the num() / bool() / store
//     coercion is left out (`canonical`, `within`): an arena slot holds only its type's values. Integer arithmetic is
//     a helper per type (`add_DINT`), wrap / NOT / NEG and a literal divisor are written out per type (`wrapCode`), a
//     FOR counter in range is stored as is, a narrowing store of a whole number is only a width check (`fit_SINT`).
//   - Constant addresses. A local is `I32[(b + 52) >> 2]`, a global `I32[1031]`, an element `b + 40 + ix(i, ...) * 4`
//     with the bounds check alone in a helper.
//   - No free globals (`Array`, `Math`) in the source: inside a Compartment each use is a scope lookup, enough to make a
//     scan ~2.5x slower. Bind what generated code needs in `helpersFor`.
//
// The code is evaluated inside an SES Compartment when the realm is locked down (it reaches only what it is handed),
// with the Function constructor otherwise (CLIs, unlocked tests); where neither is allowed the program runs on the
// walker. A collab room's program text becomes code here, so every name and literal enters the source through
// JSON.stringify, and a literal string is further escaped of `<`, `>` and `(`, the characters SES's source checks
// look for.

import { partSandboxActive } from '../core/parts/partSandbox'
import { builtinFor, evalBuiltin, isBuiltinFunc } from './builtins'
import { FAULT, StFault } from './faults'
import { type Env, identKey } from './program'
import { bool, calendarRangeError, FB_INPUTS, idiv, imod, isCalendar, isInt, isInt32, isReal, MAX_LOOP_ITERATIONS, num, roundEven, str, unboundMessage, wrap } from './runtime'
import type { Expr, MethodDef, ScalarType, SourcePos, Stmt, TagValue } from './types'
import { StError } from './types'
import { viewOf } from './typed/arena'
import { clearRanges, type PouLayout, type StructLayout, type TypeLayout, TypedUnsupported } from './typed/layout'

/** One generated body: run on the instance whose region starts at `b`, at controller clock `now`; a METHOD's with its
 *  frame (its own variables) at `m`. */
export type GenBody = (b: number, now: number, m?: number) => void

/** A method of one class, as generated code calls it (typed/pou.ts TypedMethod): a frame taken and started, the body run
 *  on an instance with it, the frame given back. */
export interface MethodRunner {
  readonly frame: PouLayout
  enter(b: number): number
  run(b: number, now: number, m: number): void
  leave(m: number): void
}

/** A definition's names: its own declarations first, then the program's globals, and where each one is. */
export interface GenScope {
  env: Env
  genv: Env | null
  typed: TypedScope
}

/** Where a definition's names live (docs/plc-typed-storage.md): the generated body is shared by every instance of it
 *  and handed the instance's base address `b`, so a local is `b + off`; a global is an absolute address, fixed for the
 *  program. */
export interface TypedScope {
  /** `ref`: the name is a whole array or struct VAR_IN_OUT, or a REF_TO (`nullable`: NULL until given a reference),
   *  whose slot holds the address of what it refers to. `iface`: an interface variable, whose slot holds the address
   *  of the instance it refers to. `frame`: a method's own variable, at an offset from its frame `m` */
  resolve(name: string): { layout: TypeLayout; global: boolean; off: number; ref?: TypeLayout; nullable?: true; iface?: string; frame?: true } | undefined
  /** the class whose instance a block's body or method runs on: THIS, at `b` */
  cls?: { name: string; layout: StructLayout }
  /** `impl` generated for instances of class `concrete` */
  method(concrete: string, impl: MethodDef): MethodRunner
  /** the body of class `base`, generated for instances of class `concrete` (SUPER^()) */
  baseBody(concrete: string, base: string): { run(b: number, now: number): void }
  /** for each class number, what an instance of that class runs for `key` (a call through an interface or a reference) */
  dispatch(key: string): (MethodRunner | undefined)[]
  /** the implementation class `cls` has for `key` */
  implOf(cls: string, key: string): MethodDef
  /** the frame of a method (or a signature): where a call stores its arguments and reads its outputs and result */
  frameOf(m: MethodDef): PouLayout
  /** a user function block's runner: its body, generated once for the definition, run on an instance's address */
  fb(name: string): { run(b: number, now: number): void }
  /** a user function's runner (typed/pou.ts TypedFn): which of its inputs take a whole array or struct (by address),
   *  the layout of its result when that is one, and where its inputs and result are */
  fn(name: string): {
    readonly aggregate: readonly boolean[]
    readonly result: TypeLayout | null
    readonly inputSlots: readonly { off: number; layout: TypeLayout }[]
    readonly resultSlot: { off: number; layout: TypeLayout }
    readonly direct: boolean
  }
  /** the region a call site of a function with a whole array or struct result copies it into (typed/calls.ts) */
  temp(call: Expr): number | undefined
}

const NL = String.fromCharCode(10)

/** A byte address being built: a run-time part (`b`, subscripts) and a constant part folded as it goes. */
interface Address {
  dyn: string
  off: number
  layout: TypeLayout
}
const addrCode = (a: Address): string => (a.dyn === '' ? String(a.off) : a.off === 0 ? a.dyn : `${a.dyn} + ${a.off}`)

/** The interpreter's own pieces a generated body needs: the store rules and loop signals the walker uses, so the
 *  engines agree. */
export interface GenInternals {
  eq(l: TagValue, r: TagValue): boolean
  fits(t: ScalarType, exact: number, kept: number, pos: SourcePos | undefined): number
  checkRange(target: Expr, v: TagValue, pos: SourcePos): TagValue
  coercerFor(type: ScalarType, maxLen: number | undefined, pos: SourcePos | undefined): (v: TagValue) => TagValue
  placeMaxLen(target: Expr): number | undefined
  EXIT: symbol
  CONTINUE: symbol
}

/** Largest statement list (in characters of generated source) kept in one function; measured: 4 KB beat 16 KB. */
const CHUNK = 4000

/** Each integer type's width (runtime.ts `wrap`, case for case), so a type's arithmetic helpers carry it built in. */
const WIDTH: Partial<Record<ScalarType, (x: number) => number>> = {
  SINT: (x) => (x << 24) >> 24,
  INT: (x) => (x << 16) >> 16,
  DINT: (x) => x | 0,
  USINT: (x) => x & 0xff,
  BYTE: (x) => x & 0xff,
  UINT: (x) => x & 0xffff,
  WORD: (x) => x & 0xffff,
  UDINT: (x) => x >>> 0,
  DWORD: (x) => x >>> 0,
}

/** Each integer type's range, the values its width keeps as they are. */
const RANGE: Partial<Record<ScalarType, readonly [number, number]>> = {
  SINT: [-128, 127],
  INT: [-32768, 32767],
  DINT: [-2147483648, 2147483647],
  USINT: [0, 255],
  BYTE: [0, 255],
  UINT: [0, 65535],
  WORD: [0, 65535],
  UDINT: [0, 4294967295],
  DWORD: [0, 4294967295],
}

/** runtime.ts `wrap(t, x)` written out for one known type, so no call switches on the type's name at run time */
function wrapCode(t: ScalarType, x: string): string {
  switch (t) {
    case 'SINT': return `(((${x}) << 24) >> 24)`
    case 'INT': return `(((${x}) << 16) >> 16)`
    case 'DINT': return `((${x}) | 0)`
    case 'USINT': case 'BYTE': return `((${x}) & 255)`
    case 'UINT': case 'WORD': return `((${x}) & 65535)`
    case 'UDINT': case 'DWORD': return `((${x}) >>> 0)`
    case 'REAL': return `fround(${x})`
    case 'LREAL': return `(${x})`
    default: return `wrap(${JSON.stringify(t)}, ${x})`
  }
}

const subscript = (i: number, lo: number, hi: number, pos: SourcePos): StFault => new StFault(FAULT.SUBSCRIPT, `array index ${i} out of bounds [${lo}..${hi}]`, pos)
const strOf = (l: TagValue, r: TagValue): boolean => typeof l === 'string' || typeof r === 'string'

/** The helpers a body calls, built once over the interpreter's internals. */
function helpersFor(x: GenInternals): Record<string, unknown> {
  const { eq, fits } = x
  return {
    num, bool, str, wrap, StFault, FAULT,
    // bound here, never named in the generated source: inside a Compartment a free global is looked up through the
    // compartment's scope on every use (measured: Array.isArray at each indexed store made a 133 KB program's scan 2.5x slower)
    fround: Math.fround,
    trunc: Math.trunc,
    checkRange: x.checkRange,
    MAX: MAX_LOOP_ITERATIONS,
    EXIT: x.EXIT,
    CONTINUE: x.CONTINUE,
    /** a subscript's offset into its dimension: the bounds check alone, the element read or written at the site */
    ix(i: number, lo: number, hi: number, pos: SourcePos): number {
      if (i < lo || i > hi) throw subscript(i, lo, hi, pos)
      return i - lo
    },
    /** a subscript outside its dimension, where the generated code checked it in place */
    ixFault(i: number, lo: number, hi: number, pos: SourcePos): never {
      throw subscript(i, lo, hi, pos)
    },
    not: (t: ScalarType, v: TagValue): TagValue => (typeof v === 'boolean' ? !v : wrap(t, ~num(v))),
    eqS: (l: TagValue, r: TagValue): boolean => (strOf(l, r) ? str(l) === str(r) : eq(l, r)),
    neS: (l: TagValue, r: TagValue): boolean => (strOf(l, r) ? str(l) !== str(r) : !eq(l, r)),
    ltS: (l: TagValue, r: TagValue): boolean => (strOf(l, r) ? str(l) < str(r) : num(l) < num(r)),
    gtS: (l: TagValue, r: TagValue): boolean => (strOf(l, r) ? str(l) > str(r) : num(l) > num(r)),
    leS: (l: TagValue, r: TagValue): boolean => (strOf(l, r) ? str(l) <= str(r) : num(l) <= num(r)),
    geS: (l: TagValue, r: TagValue): boolean => (strOf(l, r) ? str(l) >= str(r) : num(l) >= num(r)),
    and2: (a: boolean, b: boolean): boolean => a && b,
    or2: (a: boolean, b: boolean): boolean => a || b,
    addI: (t: ScalarType, l: number, r: number, pos: SourcePos): number => fits(t, l + r, wrap(t, l + r), pos),
    subI: (t: ScalarType, l: number, r: number, pos: SourcePos): number => fits(t, l - r, wrap(t, l - r), pos),
    mulI: (t: ScalarType, l: number, r: number, pos: SourcePos, imul: boolean): number => fits(t, l * r, imul ? wrap(t, Math.imul(l | 0, r | 0)) : wrap(t, l * r), pos),
    divI(t: ScalarType, l: number, r: number, pos: SourcePos): number {
      if (r === 0) throw new StError('division by zero', pos)
      return wrap(t, idiv(l, r))
    },
    modI(t: ScalarType, l: number, r: number, pos: SourcePos): number {
      if (r === 0) throw new StError('MOD by zero', pos)
      return wrap(t, imod(l, r))
    },
    cal(t: ScalarType, v: number, pos: SourcePos): number {
      const why = calendarRangeError(t, v)
      if (why !== null) throw new StError(why, pos)
      return v
    },
    callB(name: string, t: ScalarType, vals: TagValue[], pos: SourcePos): unknown {
      try {
        return evalBuiltin(name, t, vals)
      } catch (err) {
        if (err instanceof Error && !(err instanceof StError)) throw new StError(err.message, pos, name.length)
        throw err
      }
    },
    // a store's coercion (interpreter.ts coercerFor), one helper per kind so every call site is the same function
    coI(t: ScalarType, v: TagValue, _pos: SourcePos | undefined): number {
      const n = typeof v === 'number' ? v : num(v)
      return wrap(t, Number.isInteger(n) ? n : roundEven(n))
    },
    coR: (v: TagValue): number => Math.fround(typeof v === 'number' ? v : num(v)),
    coL: (v: TagValue): number => wrap('LREAL', num(v)),
    /** a REF_TO's address, faulting when it is NULL (the walker's refCell) */
    refAt(a: number, pos: SourcePos, len: number): number {
      if (a === 0) throw new StError(unboundMessage('ref'), pos, len)
      return a
    },
    /** an interface's instance, faulting when it refers to none (the walker's callMethod) */
    ifaceAt(a: number, pos: SourcePos): number {
      if (a === 0) throw new StError(unboundMessage('iface'), pos)
      return a
    },
    ...integerArithmetic(fits),
  }
}

/** `add_DINT`, `sub_DINT`, `mul_DINT`, ... one helper per integer type and operator, so every call site calls one small
 *  function V8 inlines. A result that did not fit goes to the same `fits` as the walker's, so the overflow rule stays
 *  written once. */
function integerArithmetic(fits: GenInternals['fits']): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [t, w] of Object.entries(WIDTH) as [ScalarType, (x: number) => number][]) {
    out[`add_${t}`] = (l: number, r: number, pos: SourcePos): number => {
      const x = l + r
      const k = w(x)
      return k === x ? k : fits(t, x, k, pos)
    }
    // a store of a whole number into a narrower place: what coI does once the value is known to be an integer
    out[`fit_${t}`] = (x: number, pos: SourcePos | undefined): number => {
      const k = w(x)
      return k === x ? k : fits(t, x, k, pos)
    }
    out[`sub_${t}`] = (l: number, r: number, pos: SourcePos): number => {
      const x = l - r
      const k = w(x)
      return k === x ? k : fits(t, x, k, pos)
    }
    // a 32-bit product through Math.imul (runtime.ts isInt32)
    const imul = isInt32(t)
    out[`mul_${t}`] = (l: number, r: number, pos: SourcePos): number => {
      const x = l * r
      const k = imul ? w(Math.imul(l | 0, r | 0)) : w(x)
      return k === x ? k : fits(t, x, k, pos)
    }
  }
  return out
}

/** The loops open in the scan function (EXIT / CONTINUE name the innermost). A sub-function a block is split into
 *  never opens a frame of its own: its jumps are SUB_JUMP codes. */
interface Frame {
  loops: number[]
}

/** Whether a place's read runs nothing but loads: a variable or THIS, a field of one, or an element whose subscripts
 *  are such reads or literals. Its code can then be repeated without running anything twice. */
function readsOnly(e: Expr): boolean {
  switch (e.node) {
    case 'var':
    case 'this':
    case 'num':
      return true
    case 'member':
      return readsOnly(e.obj)
    case 'index':
      return readsOnly(e.obj) && e.indices.every(readsOnly)
    default:
      return false
  }
}

type JumpKind = 'return' | 'exit' | 'continue'
/** A jump whose code waits for its frame: U+0001, the kind's initial, U+0001. JSON.stringify escapes every control
 *  character, so no name or literal in the source can contain the mark. */
const JUMP_MARK = '\u0001'
const JUMP_PLACEHOLDER = new RegExp(`${JUMP_MARK}([rec])${JUMP_MARK}`, 'g')
const JUMP_KINDS: Record<string, JumpKind> = { r: 'return', e: 'exit', c: 'continue' }
/** a jump out of a sub-function a statement list was split into: the code its caller acts on (`signals`) */
const SUB_JUMP: Record<JumpKind, string> = { return: 'return 1;', exit: 'return 2;', continue: 'return 3;' }

const isNumber = (t: string | undefined): boolean => t !== undefined && (isInt(t as ScalarType) || isReal(t as ScalarType))

class Generator {
  /** constants the source refers to as k0, k1, ...: positions, coercers, runners, clear ranges */
  readonly consts: unknown[] = []
  /** the sub-functions a large statement list was split into */
  readonly fns: string[] = []
  #ids = 0
  readonly #frame: Frame = { loops: [] }
  /** the open loops' count where the statement being generated starts (null: outside any block) */
  #base: number | null = null

  constructor(
    private readonly scope: GenScope,
    private readonly x: GenInternals,
  ) {}

  k(v: unknown): string {
    this.consts.push(v)
    return `k${this.consts.length - 1}`
  }
  id(): number {
    return this.#ids++
  }
  lit(v: unknown): string {
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? String(v) : this.k(v)
    if (typeof v === 'boolean') return String(v)
    if (typeof v === 'string') return JSON.stringify(v).replace(/[<>(]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    return this.k(v)
  }

  /** a store's coercion into a `t` place, as coercerFor does it; `e`, the value's expression when there is one, lets
   *  a value already in `t`'s form go in as it is */
  coerce(t: ScalarType, maxLen: number | undefined, pos: SourcePos | undefined, value: string, e?: Expr): string {
    if (e && this.canonical(e, t)) return value
    // a whole number already in its own integer type's form: one that type's range fits in goes in as it is (a
    // widening store), any other needs only the width check and its minor fault (`fit_SINT`), not coI's rounding
    if (e && WIDTH[t] && e.node !== 'call' && WIDTH[e.t as ScalarType] && this.canonical(e, e.t as ScalarType)) {
      return this.within(e, t) ? value : `fit_${t}(${value}, ${pos ? this.k(pos) : 'undefined'})`
    }
    if (t === 'BOOL') return `bool(${value})`
    if (isInt(t)) return `coI(${JSON.stringify(t)}, ${value}, ${pos ? this.k(pos) : 'undefined'})`
    // a number rounds to f32 directly; only a value that may not be a number needs coR's num()
    if (t === 'REAL') return e && isNumber(e.t) && e.node !== 'call' ? `fround(${value})` : `coR(${value})`
    if (t === 'LREAL') return `coL(${value})`
    return `${this.k(this.x.coercerFor(t, maxLen, pos))}(${value})`
  }
  /** Is `e`'s value already exactly what a store into a `t` place would make of it, so the coercion can be left out?
   *  True of a literal that `t` holds as written, and of an expression of type `t` whose code ends in `t`'s own wrap or
   *  that reads storage: storage holds each value in its declared type's form (every writer coerces on the way in:
   *  stores, setInput, the bit write), which is the invariant `num` and `cond` already rest on. A call is never: a
   *  builtin's result is computed, not stored. */
  canonical(e: Expr, t: ScalarType): boolean {
    if (e.node === 'num') {
      const v = e.value
      if (typeof v !== 'number' || Object.is(v, -0)) return false
      if (WIDTH[t]) return Number.isInteger(v) && WIDTH[t]!(v) === v
      if (t === 'REAL') return Math.fround(v) === v
      return t === 'LREAL'
    }
    if (e.node === 'bool') return t === 'BOOL' && typeof e.value === 'boolean'
    if (e.t !== t || !(t === 'BOOL' || WIDTH[t] || t === 'REAL' || t === 'LREAL')) return false
    switch (e.node) {
      case 'var':
        return e.constValue === undefined
      case 'member':
      case 'index':
        return true
      case 'unary':
        return e.op !== 'POS'
      case 'binary':
        // every binary of type t ends in t's wrap (or is a BOOL); a TOD / DT sum is not one of these types
        return true
      default:
        return false
    }
  }
  /** num(e), left out where the checker's type says the value is already a number: an arena slot of a numeric type
   *  holds nothing else. A call keeps num(): a builtin's result is computed, not stored. */
  num(e: Expr): string {
    if (e.node === 'num' && typeof e.value === 'number') return this.lit(e.value)
    const v = this.expr(e)
    return isNumber(e.t) && e.node !== 'call' ? v : `num(${v})`
  }
  /** a condition: bool(e), left out where the value is already a boolean: a BOOL read from storage (the same
   *  invariant as num), a comparison, a bit, a literal */
  cond(e: Expr): string {
    const v = this.expr(e)
    return e.t === 'BOOL' && e.node !== 'call' && (e.node !== 'unary' || e.op === 'NOT') ? v : `bool(${v})`
  }
  /** Is every value `e` can have a whole number inside integer type `t`'s range? A literal is checked; an expression
   *  of an integer type is its type's range (its code ends in that type's wrap, or reads storage, which holds it). */
  within(e: Expr, t: ScalarType): boolean {
    const range = RANGE[t]
    if (!range) return false
    if (e.node === 'num') return Number.isInteger(e.value) && e.value >= range[0] && e.value <= range[1]
    const own = e.node === 'call' ? undefined : RANGE[e.t as ScalarType]
    return own !== undefined && own[0] >= range[0] && own[1] <= range[1]
  }
  /** a literal subscript inside its dimension, as an offset into it (null: it is checked at run time) */
  constOffset(ix: Expr, d: { lo: number; hi: number }): number | null {
    return ix.node === 'num' && Number.isInteger(ix.value) && ix.value >= d.lo && ix.value <= d.hi ? ix.value - d.lo : null
  }

  expr(e: Expr): string {
    switch (e.node) {
      case 'num':
      case 'bool':
      case 'str':
        return this.lit(e.value)
      case 'var':
        if (e.constValue !== undefined) return this.lit(e.constValue) // an enumeration member
        return this.load(e)
      case 'member':
        return this.load(e) // a struct field, or a block's output (a field of its record)
      case 'bit':
        return `(((${this.num(e.obj)} >>> ${e.bit}) & 1) === 1)`
      case 'index':
        return this.load(e)
      case 'call': {
        // a user FUNCTION: its runner owns its region (and a whole array or struct argument goes by address)
        if (!isBuiltinFunc(e.name)) return this.typedFnCall(e)
        const args = e.args.map((a) => this.expr(a))
        // a builtin whose dispatch can be decided now is called directly; the rest resolve their name per call
        const fn = e.t ? builtinFor(e.name, e.t, args.length) : null
        if (fn) return `${this.k(fn)}(${args.join(', ')})`
        return `callB(${JSON.stringify(e.name)}, ${JSON.stringify(e.t)}, [${args.join(', ')}], ${this.k(e.pos)})`
      }
      case 'unary': {
        // a BOOL's NOT is a truth's negation (the walker's `typeof v === 'boolean' ? !v`: a BOOL is stored as one)
        if (e.op === 'NOT' && e.t === 'BOOL') return `(!${this.cond(e.expr)})`
        if (e.op === 'NOT' && e.t && (WIDTH[e.t] || isReal(e.t))) return wrapCode(e.t, `~(${this.num(e.expr)})`)
        if (e.op === 'NEG') return wrapCode(e.t!, `-(${this.num(e.expr)})`)
        const v = this.expr(e.expr)
        if (e.op === 'NOT') return `not(${JSON.stringify(e.t)}, ${v})`
        return `num(${v})`
      }
      case 'binary':
        return this.binary(e)
      case 'mcall':
        return this.methodCall(e)
      case 'isref': {
        // a REF_TO that is not NULL, an interface pointed at an instance: its slot holds an address
        return `(U32[(${addrCode(this.slot(e.obj))}) >> 2] !== 0)`
      }
      case 'this':
        return this.unsupported('THIS as a value')
    }
  }

  /** What a REF_TO is given, as an address: REF(place)'s place, another REF_TO's slot as it is (`alias`, NULL too), or
   *  0 for NULL (a literal 0, the checker's spelling of it). */
  refGiven(e: Expr, alias: boolean | undefined): string {
    if (alias) return `U32[(${addrCode(this.slot(e))}) >> 2]`
    if (e.node === 'num') return '0'
    if (e.node === 'this') return 'b'
    return addrCode(this.addr(e))
  }

  /** The slot of a REF_TO or an interface variable (the address it holds), not what it designates. */
  slot(e: Expr): Address {
    if (e.node === 'index') return this.element(e)
    if (e.node !== 'var') return this.unsupported('this reference')
    const r = this.scope.typed.resolve(e.name)
    if (!r) return this.unsupported(`the name '${e.name}' here`)
    return r.global ? { dyn: '', off: r.off, layout: r.layout } : { dyn: r.frame ? 'm' : 'b', off: r.off, layout: r.layout }
  }

  /** The address of the instance a method is called on, or an interface is pointed at: THIS (`b`), the instance an
   *  interface refers to (faulting when none), a place holding one, or what a REF_TO refers to (r^). */
  instanceAt(e: Expr, pos: SourcePos): string {
    if (e.node === 'this') return 'b'
    if (this.isIface(e)) return `ifaceAt(U32[(${addrCode(this.slot(e))}) >> 2], ${this.k(pos)})`
    return addrCode(this.addr(e))
  }

  /** Whether a place is an interface: a variable of one, or an element of an array of them. */
  isIface(e: Expr): boolean {
    if (e.node === 'var') return this.scope.typed.resolve(e.name)?.iface !== undefined
    if (e.node !== 'index') return false
    const { consts, fns } = { consts: this.consts.length, fns: this.fns.length }
    try {
      const l = this.element(e).layout
      return l.kind === 'scalar' && l.pointer === 'iface'
    } finally {
      // (asked, not generated: whatever the subscripts made is taken back)
      this.consts.length = consts
      this.fns.length = fns
    }
  }

  /** What an interface is given: the address of an instance, or 0 (an interface given one that refers to none). */
  instanceOf(e: Expr): string {
    if (e.node === 'this') return 'b'
    if (e.node === 'num') return '0'
    if (this.isIface(e)) return `U32[(${addrCode(this.slot(e))}) >> 2]`
    return addrCode(this.addr(e))
  }

  /**
   * A METHOD call (or an accessor, or SUPER^()), in the walker's order (interpreter.ts callMethod): the instance; which
   * implementation runs; the scalar inputs, in the call's order; each copied input, in-out and bound reference or
   * interface, in the call's order; a frame; the arguments stored in it; the body; each scalar in-out copied back, each
   * output stored; the result; the frame given back. Written as a function of its own, called where the value is used.
   */
  methodCall(e: Extract<Expr, { node: 'mcall' }>): string {
    const typed = this.scope.typed
    const name = `c${this.id()}`
    const pos = this.k(e.pos)
    const lines: string[] = [`const f = ${this.instanceAt(e.obj, e.pos)};`]
    if (e.body) {
      if (!typed.cls) return this.unsupported('SUPER^() outside a class')
      lines.push(`${this.k(typed.baseBody(typed.cls.name, e.cls!))}.run(f, now);`, 'return 0;')
      this.fns.push(`function ${name}(b, now, m) {
${lines.join(NL)}
}`)
      return `${name}(b, now, m)`
    }
    const sig = e.sig!
    if (e.dispatch === 'dynamic') {
      // the class number every object-oriented instance carries first; nothing behind it, no implementation, faults
      lines.push(`const R = ${this.k(typed.dispatch(e.key!))}[U32[f >> 2]];`, `if (R === undefined) ifaceAt(0, ${pos});`)
    } else {
      // THIS: the class being generated (an override in it wins, or SUPER^ names its base's); an instance declared of
      // a class: that class
      const concrete = e.obj.node === 'this' ? typed.cls?.name : e.cls!
      if (concrete === undefined) return this.unsupported('THIS outside a class')
      const from = e.dispatch === 'self' ? concrete : e.cls!
      lines.push(`const R = ${this.k(typed.method(concrete, typed.implOf(from, e.key!)))};`)
    }
    const frame = typed.frameOf(sig)
    const at = (arg: string): Address => {
      const m = frame.byKey.get(identKey(arg))
      if (!m || m.hidden) return this.unsupported(`the parameter '${arg}'`)
      return { dyn: 'fm', off: m.off, layout: m.layout }
    }
    const scalars: { arg: string; v: string; e: Expr }[] = []
    e.args.filter((a) => !a.out && !a.inout && !a.copy && !a.bind).forEach((a, i) => {
      lines.push(`const a${i} = ${this.expr(a.value)};`)
      scalars.push({ arg: a.name, v: `a${i}`, e: a.value })
    })
    const stores: string[] = []
    e.args.forEach((a, i) => {
      const v = `s${i}`
      const slot = (): Address => at(a.name)
      if (a.copy && !a.out) {
        const p = slot()
        lines.push(`const ${v} = ${addrCode(this.aggregateOf(a.value))};`)
        stores.push(`copyBytes(${addrCode(p)}, ${v}, ${p.layout.size});`)
      } else if (a.inout) {
        const m = frame.byKey.get(identKey(a.name))!
        const p = slot()
        if (m.ref) {
          lines.push(`const ${v} = ${addrCode(this.addr(a.value))};`) // bound by reference: its address
          stores.push(this.storeAt(p, v))
        } else {
          lines.push(`const ${v} = ${this.expr(a.value)};`) // a scalar: its value, in, and back out below
          stores.push(this.storeAt(p, v))
        }
      } else if (a.bind) {
        const p = slot()
        lines.push(`const ${v} = ${a.bind === 'ref' ? this.refGiven(a.value, a.alias) : this.instanceOf(a.value)};`)
        stores.push(`U32[(${addrCode(p)}) >> 2] = ${v};`)
      }
    })
    lines.push('const fm = R.enter(f);', ...stores)
    for (const { arg, v, e: given } of scalars) {
      const p = at(arg)
      if (p.layout.kind !== 'scalar') return this.unsupported(`the parameter '${arg}'`)
      const value = p.layout.enumerated ? wrapCode('INT', `num(${v})`) : this.coerce(p.layout.scalar, p.layout.cap, undefined, v, given)
      lines.push(this.storeAt(p, value))
    }
    lines.push('R.run(f, now, fm);')
    for (const a of e.args) {
      if (!a.inout || frame.byKey.get(identKey(a.name))!.ref) continue
      const r = `r${this.id()}`
      lines.push(this.strCopyTo(a.value, at(a.name)) ?? `{ const ${r} = ${this.loadAt(at(a.name))}; ${this.place(a.value, r)} }`)
    }
    for (const a of e.args) {
      if (!a.out) continue
      const p = at(a.name)
      if (a.copy) lines.push(`copyBytes(${addrCode(this.addr(a.value))}, ${addrCode(p)}, ${p.layout.size});`)
      else {
        const q = `q${this.id()}`
        lines.push(this.strCopyTo(a.value, p, this.x.placeMaxLen(a.value)) ?? `{ const ${q} = ${this.coerce(a.value.t as ScalarType, this.x.placeMaxLen(a.value), undefined, this.loadAt(p))}; ${this.place(a.value, q)} }`)
      }
    }
    if (sig.ret === null) lines.push('const r = 0;')
    else if (at(sig.name).layout.kind === 'scalar') lines.push(`const r = ${this.loadAt(at(sig.name))};`)
    else {
      // a whole array or struct: copied to the call site's own region before the frame is given back, and its address
      const dst = typed.temp(e)
      if (dst === undefined) return this.unsupported('this call of a method with a whole array or struct result')
      const res = at(sig.name)
      lines.push(`copyBytes(${dst}, ${addrCode(res)}, ${res.layout.size});`, `const r = ${dst};`)
    }
    lines.push('R.leave(fm);', 'return r;')
    this.fns.push(`function ${name}(b, now, m) {
${lines.join(NL)}
}`)
    return `${name}(b, now, m)`
  }

  binary(e: Extract<Expr, { node: 'binary' }>): string {
    const op = e.op
    const t = e.t!
    const tj = JSON.stringify(t)
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      // two numbers compare directly; anything that may be a STRING is decided at run time, as the walker does
      // (for numbers, the walker's eq is ===, so = and <> compare directly too)
      if (isNumber(e.left.t) && isNumber(e.right.t)) return `(${this.num(e.left)} ${op === '=' ? '===' : op === '<>' ? '!==' : op} ${this.num(e.right)})`
      const fn = { '=': 'eqS', '<>': 'neS', '<': 'ltS', '>': 'gtS', '<=': 'leS', '>=': 'geS' }[op]
      return `${fn}(${this.expr(e.left)}, ${this.expr(e.right)})`
    }
    if (op === 'AND' || op === 'OR' || op === 'XOR') {
      if (t === 'BOOL') {
        const L = this.cond(e.left)
        const R = this.cond(e.right)
        // AND / OR evaluate both sides: `&` / `|` on two truths evaluate both, in order, with no call and no branch
        return op === 'AND' ? `((${L} & ${R}) !== 0)` : op === 'OR' ? `((${L} | ${R}) !== 0)` : `(${L} !== ${R})`
      }
      return wrapCode(t, `${this.num(e.left)} ${op === 'AND' ? '&' : op === 'OR' ? '|' : '^'} ${this.num(e.right)}`)
    }
    const pos = this.k(e.pos)
    const L = this.num(e.left)
    const R = this.num(e.right)
    if (isCalendar(t)) return `cal(${tj}, ${L} ${op === '+' ? '+' : '-'} ${R}, ${pos})` // the walker's rule: + adds, anything else subtracts
    if (isReal(t) && (op === '+' || op === '-' || op === '*' || op === '/')) return wrapCode(t, `${L} ${op} ${R}`)
    // a divisor known not to be zero: nothing to fault, so the quotient (idiv) or remainder (imod) is written out
    const divisor = e.right.node === 'num' && typeof e.right.value === 'number' && Number.isInteger(e.right.value) && e.right.value !== 0 && WIDTH[t]
    switch (op) {
      case '+': return WIDTH[t] ? `add_${t}(${L}, ${R}, ${pos})` : `addI(${tj}, ${L}, ${R}, ${pos})`
      case '-': return WIDTH[t] ? `sub_${t}(${L}, ${R}, ${pos})` : `subI(${tj}, ${L}, ${R}, ${pos})`
      case '*': return WIDTH[t] ? `mul_${t}(${L}, ${R}, ${pos})` : `mulI(${tj}, ${L}, ${R}, ${pos}, ${isInt32(t)})`
      case '/': return divisor ? wrapCode(t, `trunc(${L} / (${R}))`) : `divI(${tj}, ${L}, ${R}, ${pos})`
      case 'MOD': return divisor ? wrapCode(t, `${L} % (${R})`) : `modI(${tj}, ${L}, ${R}, ${pos})`
    }
    return this.unsupported(`the operator ${op}`) // nothing the checker passes
  }

  /** a construct this generator cannot write: the whole program is refused, and runs on the walker */
  unsupported(what: string): never {
    throw new TypedUnsupported(what)
  }

  /** The byte address of a place (a variable, a struct field, an array element) in the arena: the object, then each
   *  subscript, evaluated in the walker's order and checked against its dimension (`ix`). */
  addr(e: Expr): Address {
    switch (e.node) {
      case 'var': {
        const r = this.scope.typed.resolve(e.name)
        if (!r) return this.unsupported(`the name '${e.name}' here`)
        if (r.iface !== undefined) return this.unsupported('an interface as a place')
        const at: Address = r.global ? { dyn: '', off: r.off, layout: r.layout } : { dyn: r.frame ? 'm' : 'b', off: r.off, layout: r.layout }
        return r.ref ? this.deref(at, r.ref, r.nullable ? e : undefined) : at
      }
      case 'this': {
        const cls = this.scope.typed.cls
        if (!cls) return this.unsupported('THIS outside a class')
        return { dyn: 'b', off: 0, layout: cls.layout }
      }
      case 'member': {
        const p = this.addr(e.obj)
        if (p.layout.kind !== 'struct') return this.unsupported('this member')
        // a struct's field, or a standard block's output: both a field of the record (a block's private state is not)
        const f = p.layout.byKey.get(identKey(e.field))
        if (!f || f.hidden) return this.unsupported(`the member '${e.field}'`)
        const at: Address = { dyn: p.dyn, off: p.off + f.off, layout: f.layout }
        return f.ref ? this.deref(at, f.ref) : at
      }
      case 'index':
        return this.element(e)
      default:
        return this.unsupported('this place')
    }
  }

  /** The address of an array's element: the object, then each subscript, checked against its dimension (`ix`). */
  element(e: Extract<Expr, { node: 'index' }>): Address {
    const p = this.addr(e.obj)
    const arr = p.layout
    if (arr.kind !== 'array') return this.unsupported('this subscript')
    const pos = this.k(e.pos)
    let { dyn, off } = p
    e.indices.forEach((ix, n) => {
      const d = arr.dims[n]!
      const stride = arr.strides[n]!
      const at = this.constOffset(ix, d)
      if (at !== null) off += at * stride
      else {
        const v = this.num(ix)
        // a subscript read straight from storage is checked in place: as an ix() call it can fall outside V8's
        // inlining budget in a long body (measured: struct arrays in a 20-pass loop, 1.34 -> 0.74 µs a scan).
        // The check repeats `v`, so it must be a read with no call in it: `a[s[Next()].j]` calls Next() once.
        const checked = (ix.node === 'var' || ix.node === 'member') && readsOnly(ix)
          ? `(${v} < ${d.lo} || ${v} > ${d.hi} ? ixFault(${v}, ${d.lo}, ${d.hi}, ${pos}) : ${v} - ${d.lo})`
          : `ix(${v}, ${d.lo}, ${d.hi}, ${pos})`
        const term = `${checked}${stride === 1 ? '' : ` * ${stride}`}`
        dyn = dyn === '' ? term : `${dyn} + ${term}`
      }
    })
    return { dyn, off, layout: arr.elem }
  }

  /** A standard block's call in the typed engine: the instance's place first, then its inputs in the call's order (the
   *  walker's argument object), then `blk_TYPE(instance, ...every accepted input, now)` with an input the call left out
   *  undefined, so the block keeps the value its record holds, as the walker's does; then each output binding read
   *  from the record, coerced, stored. */
  typedCall(s: Extract<Stmt, { node: 'fbcall' }>): string {
    const inst = this.addr(s.target)
    if (inst.layout.kind === 'struct' && inst.layout.fb) return this.userCall(s, inst, inst.layout.fb)
    const blk = inst.layout.kind === 'struct' ? inst.layout.block : undefined
    if (!blk) return this.unsupported('this function block call')
    if (s.args.some((a) => a.inout || a.copy)) return this.unsupported('this function block argument')
    const n = this.id()
    const f = `f${n}`
    const lines = [`{ const ${f} = ${addrCode(inst)};`]
    const given = new Map<string, string>()
    s.args.filter((a) => !a.out).forEach((a, i) => {
      const v = `a${n}_${i}`
      lines.push(`const ${v} = ${this.expr(a.value)};`)
      given.set(identKey(a.name), v)
    })
    const params = FB_INPUTS[blk].map((name) => given.get(identKey(name)) ?? 'undefined')
    lines.push(`blk_${blk}(${f}, ${params.join(', ')}, now);`)
    for (const a of s.args.filter((x) => x.out)) {
      const field = (inst.layout as Extract<TypeLayout, { kind: 'struct' }>).byKey.get(identKey(a.name))
      if (!field || field.hidden || field.layout.kind !== 'scalar') return this.unsupported(`the output '${a.name}'`)
      const read = this.loadAt({ dyn: f, off: field.off, layout: field.layout })
      const q = `q${this.id()}`
      lines.push(this.strCopyTo(a.value, { dyn: f, off: field.off, layout: field.layout }, this.x.placeMaxLen(a.value)) ?? `{ const ${q} = ${this.coerce(a.value.t as ScalarType, this.x.placeMaxLen(a.value), undefined, read)}; ${this.place(a.value, q)} }`)
    }
    lines.push('}')
    return lines.join(NL)
  }

  /** A user function's call in the typed engine: its given arguments in their own order (a scalar's value, a whole
   *  array or struct's address), handed to the definition's runner with where each one goes (a formal call's `slots`),
   *  which resets the function, stores them, runs it and answers its result (the walker's runFunction). */
  typedFnCall(e: Extract<Expr, { node: 'call' }>): string {
    const fn = this.scope.typed.fn(e.name)
    // every input given in order, each a value: stored by the call site itself, coerced only where its type needs it,
    // with no argument array (measured: 40 Zone blocks with 3 function calls each, 40 -> 26 µs a scan)
    if (fn.direct && !e.slots && e.args.length === fn.inputSlots.length) {
      const name = `c${this.id()}`
      const r = this.k(fn)
      // the arguments first, as the runner takes them: one may call this same function, whose region is shared
      const lines = e.args.map((a, i) => `const a${i} = ${this.expr(a)};`)
      lines.push(`${r}.enter();`)
      e.args.forEach((a, i) => {
        const { off, layout } = fn.inputSlots[i]!
        if (layout.kind !== 'scalar') return
        const value = layout.enumerated ? wrapCode('INT', `num(a${i})`) : this.coerce(layout.scalar, layout.cap, undefined, `a${i}`, a)
        lines.push(this.storeAt({ dyn: '', off, layout }, value))
      })
      lines.push(`${r}.exec();`, `return ${this.loadAt({ dyn: '', off: fn.resultSlot.off, layout: fn.resultSlot.layout })};`)
      this.fns.push(`function ${name}(b, now, m) {
${lines.join(NL)}
}`)
      return `${name}(b, now, m)`
    }
    const given = e.args.map((a, k) => {
      const at = e.slots ? e.slots[k]! : k
      return fn.aggregate[at] ? addrCode(this.aggregateOf(a)) : this.expr(a)
    })
    const list = `[${given.join(', ')}], ${e.slots ? this.k(e.slots) : 'undefined'}`
    if (!fn.result) return `${this.k(fn)}.call(${list})`
    const dst = this.scope.typed.temp(e)
    if (dst === undefined) return this.unsupported('this call of a function with a whole array or struct result')
    return `${this.k(fn)}.callAgg(${list}, ${dst})`
  }

  /** where a whole array or struct value is: a place's own address, or a function result's copy at its call site */
  aggregateOf(e: Expr): Address {
    if (e.node === 'var' || e.node === 'member' || e.node === 'index') return this.addr(e)
    if (e.node === 'call' && !isBuiltinFunc(e.name)) {
      const fn = this.scope.typed.fn(e.name)
      if (!fn.result) return this.unsupported('this whole-array or struct value')
      return { dyn: `(${this.typedFnCall(e)})`, off: 0, layout: fn.result }
    }
    // a method's whole array or struct result, at its call site's region
    if (e.node === 'mcall' && e.sig?.ret) {
      const res = this.scope.typed.frameOf(e.sig).byKey.get(identKey(e.sig.name))
      if (res && res.layout.kind !== 'scalar') return { dyn: `(${this.methodCall(e)})`, off: 0, layout: res.layout }
    }
    return this.unsupported('this whole-array or struct value')
  }

  /** what a reference VAR_IN_OUT's slot (at `slot`) points at: the address it holds, read at run time. A REF_TO
   *  (`checked`, the variable's node) may hold none (NULL), which faults where it is dereferenced. */
  deref(slot: Address, layout: TypeLayout, checked?: Extract<Expr, { node: 'var' }>): Address {
    const at = slot.dyn === '' ? String(slot.off >> 2) : `(${addrCode(slot)}) >> 2`
    if (checked) return { dyn: `refAt(U32[${at}], ${this.k(checked.pos)}, ${checked.name.length})`, off: 0, layout }
    return { dyn: `U32[${at}]`, off: 0, layout }
  }

  /** where the text `e` reads is, when `e` is a whole STRING place: the cases `expr` answers with a plain load */
  strSource(e: Expr): Address | null {
    if (e.t !== 'STRING') return null
    if (e.node === 'var' ? e.constValue !== undefined : e.node !== 'member' && e.node !== 'index') return null
    const a = this.addr(e)
    return a.layout.kind === 'scalar' && a.layout.scalar === 'STRING' ? a : null
  }
  /** a statement copying the STRING at `src` into the STRING at `dst`, cut as a store cuts it (`maxLen`, then the
   *  capacity): the code units moved in memory, where a load and a store would build the text and take it apart
   *  again (measured: a fifth of the scan of a large program whose blocks pass status strings around). Null when
   *  either end is not a STRING. `src` is worked out first, as the value is before its place. */
  strCopyAt(dst: Address, src: Address | null, maxLen?: number): string | null {
    if (!src || dst.layout.kind !== 'scalar' || dst.layout.scalar !== 'STRING') return null
    const cap = dst.layout.cap!
    const z = `z${this.id()}`
    return `{ const ${z} = ${addrCode(src)}; strCopy(${addrCode(dst)}, ${maxLen === undefined ? cap : Math.min(cap, maxLen)}, ${z}); }`
  }
  /** {@link strCopyAt} into the place `target`. Only where finding the place runs nothing but loads: the walker
   *  reads the value before it finds the place, and here the text is read after. */
  strCopyTo(target: Expr, src: Address | null, maxLen?: number): string | null {
    if (!src || target.t !== 'STRING' || !readsOnly(target)) return null
    if (target.node !== 'var' && target.node !== 'member' && target.node !== 'index') return null
    return this.strCopyAt(this.addr(target), src, maxLen)
  }

  /** a statement storing `v` (already in the slot's form) into the scalar at an address */
  storeAt(a: Address, v: string): string {
    if (a.layout.kind !== 'scalar') return this.unsupported('a whole array or struct here')
    const t = a.layout.scalar
    if (t === 'STRING') return `strPut(${addrCode(a)}, ${a.layout.cap}, ${v});`
    const { view, shift } = viewOf(t)
    const at = a.dyn === '' ? String(a.off >> shift) : shift === 0 ? addrCode(a) : `(${addrCode(a)}) >> ${shift}`
    return t === 'BOOL' ? `${view}[${at}] = ${v} ? 1 : 0;` : `${view}[${at}] = ${v};`
  }

  /** A user function block's call in the typed engine, in the walker's order (interpreter.ts execStmt `fbcall`): the
   *  instance's place; the scalar inputs, in the call's order; each whole-array or struct input copied in and each
   *  VAR_IN_OUT bound (a whole one by its address, a scalar by its value); the scalar inputs stored as the member's
   *  setter stores them; the body; each scalar VAR_IN_OUT copied back; each output read, coerced and stored. */
  userCall(s: Extract<Stmt, { node: 'fbcall' }>, inst: Address, name: string): string {
    const rec = inst.layout as Extract<TypeLayout, { kind: 'struct' }>
    const n = this.id()
    const f = `f${n}`
    const member = (arg: string): Address | null => {
      const m = rec.byKey.get(identKey(arg))
      return m && !m.hidden ? { dyn: f, off: m.off, layout: m.layout } : null
    }
    const lines = [`{ const ${f} = ${addrCode(inst)};`]
    const scalars: { arg: string; v: string; e: Expr }[] = []
    s.args.filter((a) => !a.out && !a.inout && !a.copy && !a.bind).forEach((a, i) => {
      const v = `a${n}_${i}`
      lines.push(`const ${v} = ${this.expr(a.value)};`)
      scalars.push({ arg: a.name, v, e: a.value })
    })
    for (const a of s.args) {
      if (a.bind) {
        // a REF_TO input given the reference, an interface input the instance
        const m = rec.byKey.get(identKey(a.name))
        if (!m) continue
        const v = a.bind === 'ref' ? this.refGiven(a.value, a.alias) : this.instanceOf(a.value)
        lines.push(`U32[(${addrCode({ dyn: f, off: m.off, layout: m.layout })}) >> 2] = ${v};`)
      } else if (a.copy && !a.out) {
        const m = rec.byKey.get(identKey(a.name))
        if (!m) continue
        const src = this.aggregateOf(a.value)
        lines.push(`copyBytes(${addrCode({ dyn: f, off: m.off, layout: m.layout })}, ${addrCode(src)}, ${m.layout.size});`)
      } else if (a.inout) {
        const m = rec.byKey.get(identKey(a.name))
        if (!m) continue
        const slot: Address = { dyn: f, off: m.off, layout: m.layout }
        if (m.ref) lines.push(this.storeAt(slot, addrCode(this.addr(a.value)))) // bound by reference: its address
        else lines.push(this.strCopyAt(slot, this.strSource(a.value)) ?? this.storeAt(slot, this.expr(a.value))) // a scalar: its value, in, and back out below
      }
    }
    for (const { arg, v, e: given } of scalars) {
      const m = member(arg)
      if (!m || m.layout.kind !== 'scalar') continue // a name the block does not have: its setter does nothing
      const value = m.layout.enumerated ? wrapCode('INT', `num(${v})`) : this.coerce(m.layout.scalar, m.layout.cap, undefined, v, given)
      lines.push(this.storeAt(m, value))
    }
    lines.push(`${this.k(this.scope.typed.fb(name))}.run(${f}, now);`)
    for (const a of s.args) {
      if (!a.inout) continue
      const m = rec.byKey.get(identKey(a.name))
      if (!m || m.ref) continue
      const r = `r${this.id()}`
      lines.push(this.strCopyTo(a.value, { dyn: f, off: m.off, layout: m.layout }) ?? `{ const ${r} = ${this.loadAt({ dyn: f, off: m.off, layout: m.layout })}; ${this.place(a.value, r)} }`)
    }
    for (const a of s.args) {
      if (!a.out) continue
      const m = member(a.name)
      if (!m) return this.unsupported(`the output '${a.name}'`)
      if (a.copy) {
        const dst = this.addr(a.value)
        lines.push(`copyBytes(${addrCode(dst)}, ${addrCode(m)}, ${m.layout.size});`)
      } else {
        const q = `q${this.id()}`
        lines.push(this.strCopyTo(a.value, m, this.x.placeMaxLen(a.value)) ?? `{ const ${q} = ${this.coerce(a.value.t as ScalarType, this.x.placeMaxLen(a.value), undefined, this.loadAt(m))}; ${this.place(a.value, q)} }`)
      }
    }
    lines.push('}')
    return lines.join(NL)
  }

  /** a scalar place's value, as the engines hold it: a BOOL a boolean, a STRING text */
  load(e: Expr): string {
    return this.loadAt(this.addr(e))
  }
  loadAt(a: Address): string {
    if (a.layout.kind !== 'scalar') return this.unsupported('a whole array or struct here')
    const t = a.layout.scalar
    if (t === 'STRING') return `strAt(${addrCode(a)})`
    const { view, shift } = viewOf(t)
    const at = a.dyn === '' ? String(a.off >> shift) : shift === 0 ? addrCode(a) : `(${addrCode(a)}) >> ${shift}`
    return t === 'BOOL' ? `(${view}[${at}] !== 0)` : `${view}[${at}]`
  }
  /** a statement storing `v` (already in the place's form) into a scalar place */
  storeTo(target: Expr, v: string): string {
    const a = this.addr(target)
    if (a.layout.kind !== 'scalar') return this.unsupported('a whole array or struct here')
    const t = a.layout.scalar
    if (t === 'STRING') return `strPut(${addrCode(a)}, ${a.layout.cap}, ${v});`
    const { view, shift } = viewOf(t)
    const at = a.dyn === '' ? String(a.off >> shift) : shift === 0 ? addrCode(a) : `(${addrCode(a)}) >> ${shift}`
    return t === 'BOOL' ? `${view}[${at}] = ${v} ? 1 : 0;` : `${view}[${at}] = ${v};`
  }

  /** a statement storing `v` (a local already holding the coerced value) into `target`, after the value, as assignPlace */
  place(target: Expr, v: string): string {
    if (target.node === 'var' || target.node === 'member' || target.node === 'index') return this.storeTo(target, v)
    if (target.node === 'bit') {
      // one bit of a word: the rest of the word kept, the result wrapped to the word's own type
      const w = `w${this.id()}`
      const mask = 2 ** target.bit
      return `{ const ${w} = num(${this.expr(target.obj)}); ${this.place(target.obj, `wrap(${JSON.stringify(target.obj.t)}, bool(${v}) ? (${w} | ${mask}) >>> 0 : (${w} & ~${mask}) >>> 0)`)} }`
    }
    return this.unsupported('this place')
  }

  /** A statement list: inline when it is short, else split into sub-functions. Each statement is generated once. A
   *  jump that leaves the statement it is in (RETURN, or EXIT / CONTINUE of a loop opened outside it) is written as a
   *  placeholder (`jump`), and this replaces it once it knows the frame the statement lands in. Generating a statement
   *  again for each frame cost 2^depth for nested lists (a 12 KB nested IF took 13 s to compile). */
  block(body: Stmt[]): string {
    const outerBase = this.#base
    const base = this.#frame.loops.length
    const parts = body.map((s) => {
      this.#base = base
      return this.stmt(s)
    })
    this.#base = outerBase
    // the size it has inline, every jump as written in this frame
    const size = body.length < 2 ? 0 : parts.reduce((n, p) => n + this.resolve(p, (kind) => this.frameJump(kind)).length, 0)
    if (size <= CHUNK) return parts.map((p) => this.resolve(p, (kind) => this.jump(kind))).join('\n')
    // too big for one function V8 will optimise: sub-functions, each statement in a frame of its own (no loop open,
    // not the root), so a jump out of it is a code its caller acts on
    const out: string[] = []
    let group: string[] = []
    let groupSize = 0
    const flush = (): void => {
      if (!group.length) return
      const name = `f${this.id()}`
      this.fns.push(`function ${name}(b, now, m) {\n${group.join('\n')}\nreturn 0;\n}`)
      out.push(`{ const r = ${name}(b, now, m); ${this.signals('r')} }`)
      group = []
      groupSize = 0
    }
    for (const p of parts) {
      const code = this.resolve(p, (kind) => SUB_JUMP[kind])
      if (groupSize + code.length > CHUNK) flush()
      group.push(code)
      groupSize += code.length
    }
    flush()
    return out.join('\n')
  }

  /** `code` with each jump placeholder replaced by what `as` writes for its kind */
  resolve(code: string, as: (kind: JumpKind) => string): string {
    return code.includes(JUMP_MARK) ? code.replace(JUMP_PLACEHOLDER, (_, k: string) => as(JUMP_KINDS[k]!)) : code
  }

  /** what a sub-function's return code means in the frame that called it */
  signals(r: string): string {
    return `if (${r} === 1) { ${this.jump('return')} } else if (${r} === 2) { ${this.jump('exit')} } else if (${r} === 3) { ${this.jump('continue')} }`
  }

  /** A jump as the code says it here. One that leaves the statement being generated depends on the frame that
   *  statement lands in, so it is a placeholder for the enclosing block() to replace. */
  jump(kind: JumpKind): string {
    const f = this.#frame
    const leaves = this.#base !== null && (kind === 'return' || f.loops.length <= this.#base)
    return leaves ? `${JUMP_MARK}${kind[0]}${JUMP_MARK}` : this.frameJump(kind)
  }

  /** a jump written in the current frame */
  frameJump(kind: JumpKind): string {
    const f = this.#frame
    if (kind === 'return') return 'return;'
    const top = f.loops[f.loops.length - 1]
    if (top !== undefined) return kind === 'exit' ? `break L${top};` : `break B${top};`
    // no loop open: the walker's signal
    return kind === 'exit' ? 'throw EXIT;' : 'throw CONTINUE;'
  }

  /** a loop body, with this loop the innermost open one */
  loop(n: number, body: Stmt[]): string {
    this.#frame.loops.push(n)
    const code = this.block(body)
    this.#frame.loops.pop()
    return code
  }

  stmt(s: Stmt): string {
    switch (s.node) {
      case 'assign': {
        // a whole array or struct, copied into the target's own storage (so an alias of it sees the copy): the value
        // first, then the place, as the walker evaluates them
        if (s.copy) {
          // `aggregate := 0`: all of it zeroed but the function block instances inside (runtime.ts clearData)
          if (s.value.node === 'num' && s.value.value === 0) {
            const dst = this.addr(s.target)
            return `clearAt(${addrCode(dst)}, ${this.k(clearRanges(dst.layout))});`
          }
          // the value (a place, or a function's result), then the target (the walker's order), then the bytes
          const src = this.aggregateOf(s.value)
          const dst = this.addr(s.target)
          return `copyBytes(${addrCode(dst)}, ${addrCode(src)}, ${dst.layout.size});`
        }
        const v = `v${this.id()}`
        const ranged = (s.target.node === 'var' || s.target.node === 'member' || s.target.node === 'index') && s.target.range !== undefined
        const copied = ranged ? null : this.strCopyTo(s.target, this.strSource(s.value), this.x.placeMaxLen(s.target))
        if (copied) return copied
        const coerced = this.coerce(s.target.t as ScalarType, this.x.placeMaxLen(s.target), s.pos, this.expr(s.value), s.value)
        const value = ranged ? `checkRange(${this.k(s.target)}, ${coerced}, ${this.k(s.pos)})` : coerced
        return `{ const ${v} = ${value}; ${this.place(s.target, v)} }`
      }
      case 'fbcall':
        return this.typedCall(s)
      case 'if':
        return s.branches.map((b, i) => `${i ? ' else ' : ''}if (${this.cond(b.cond)}) {\n${this.block(b.body)}\n}`).join('') + (s.elseBody ? ` else {\n${this.block(s.elseBody)}\n}` : '')
      case 'case': {
        const sel = `s${this.id()}`
        const test = (l: (typeof s.cases)[number]['labels'][number]): string => (l.kind === 'range' ? `(${sel} >= ${this.lit(l.lo)} && ${sel} <= ${this.lit(l.hi)})` : `${sel} === ${this.lit(l.value)}`)
        const arms = s.cases.map((cl, i) => `${i ? ' else ' : ''}if (${cl.labels.map(test).join(' || ') || 'false'}) {\n${this.block(cl.body)}\n}`).join('')
        return `{ const ${sel} = ${this.num(s.selector)};\n${arms || 'if (false) {}'}${s.elseBody ? ` else {\n${this.block(s.elseBody)}\n}` : ''} }`
      }
      case 'for': {
        const n = this.id()
        const vt = (this.scope.env.get(identKey(s.varName)) ?? this.scope.genv!.get(identKey(s.varName)))!.type as ScalarType
        const pos = this.k(s.pos)
        const i = `i${n}`
        // `to`, then `by`, then `from`: the order the walker evaluates them in
        const head = `const end${n} = ${this.num(s.to)}; const step${n} = ${s.by ? this.num(s.by) : '1'};
if (step${n} === 0) throw new StFault(FAULT.WATCHDOG, 'FOR loop step is zero: it would never end', ${pos});
let count${n} = 0;`
        // the counter only ever holds a whole number between `from` and `to` while the body runs, so when both ends are
        // integers its type holds (and so is every step) it is stored as it is, without the coercion
        const whole = (e: Expr | null | undefined): boolean => e == null || (e.node === 'num' ? Number.isInteger(e.value) : e.node !== 'call' && WIDTH[e.t as ScalarType] !== undefined)
        const bounded = whole(s.by) && this.within(s.from, vt) && this.within(s.to, vt)
        const write = this.place({ node: 'var', name: s.varName, pos: s.pos } as Expr, bounded ? i : this.coerce(vt, undefined, undefined, i))
        const body = this.loop(n, s.body)
        return `{ ${head}
L${n}: for (let ${i} = ${this.num(s.from)}; step${n} > 0 ? ${i} <= end${n} : ${i} >= end${n}; ${i} += step${n}) {
${write}
B${n}: {
${body}
}
if (++count${n} > MAX) throw new StFault(FAULT.WATCHDOG, 'FOR loop exceeded its iteration limit', ${pos});
} }`
      }
      case 'while':
      case 'repeat': {
        const n = this.id()
        const pos = this.k(s.pos)
        const body = this.loop(n, s.body)
        const limit = `if (++count${n} > MAX) throw new StFault(FAULT.WATCHDOG, '${s.node === 'while' ? 'WHILE' : 'REPEAT'} loop exceeded its iteration limit', ${pos});`
        if (s.node === 'while') return `{ let count${n} = 0;\nL${n}: while (${this.cond(s.cond)}) {\nB${n}: {\n${body}\n}\n${limit}\n} }`
        return `{ let count${n} = 0;\nL${n}: for (;;) {\nB${n}: {\n${body}\n}\nif (${this.cond(s.cond)}) break;\n${limit}\n} }`
      }
      case 'exit':
      case 'continue':
      case 'return':
        return this.jump(s.node)
      case 'invoke':
        return `${this.methodCall(s.call)};`
      case 'bind': {
        // `r := REF(place)`: the place's address (`r := r2` r2's, NULL 0); `itf := instance`: the instance's (0: none)
        const v = `v${this.id()}`
        const value = s.source === null ? '0' : s.kind === 'iface' ? this.instanceOf(s.source) : this.refGiven(s.source, s.alias)
        return `{ const ${v} = ${value}; U32[(${addrCode(this.slot(s.target))}) >> 2] = ${v}; }`
      }
      default:
        return this.unsupported('this statement') // anything added later: the walker is the reference
    }
  }
}

/** The helpers, per set of internals (built once over them) */
const helperSets = new WeakMap<GenInternals, Record<string, unknown>>()
function helpersOf(x: GenInternals): Record<string, unknown> {
  let h = helperSets.get(x)
  if (!h) helperSets.set(x, (h = helpersFor(x)))
  return h
}
let compartment: { evaluate(src: string): unknown } | null = null

/** Evaluate generated source: inside a Compartment when the realm is locked down, else with the Function constructor. */
function evaluate(src: string): unknown {
  if (partSandboxActive()) {
    compartment ??= new (globalThis as unknown as { Compartment: new () => { evaluate(src: string): unknown } }).Compartment()
    return compartment.evaluate(src)
  }
  return new Function(`return ${src}`)()
}

/** The source of one body (exported for tests that want to see what was generated). */
export function generateSource(body: Stmt[], scope: GenScope, internals: GenInternals, extra: Record<string, unknown> = {}): { src: string; consts: unknown[] } {
  const g = new Generator(scope, internals)
  const code = g.block(body)
  const names = Object.keys({ ...helpersOf(internals), ...extra })
  const consts = g.consts.map((_, i) => `k${i} = K[${i}]`).join(', ')
  const src = `(function (H, K) {
'use strict';
const { ${names.join(', ')} } = H;
${consts ? `const ${consts};` : ''}
${g.fns.join('\n')}
return function body(b, now, m) {
${code}
};
})`
  return { src, consts: g.consts }
}

/** Bodies that could not be generated, with why: a host that refuses to evaluate code lands here, and so would a
 *  generator bug - the program then runs on the walker, which is why the engine tests assert this stays empty. */
export const codegenFallbacks: string[] = []

/** One generated body, or null where it could not be built (the program is then refused, and runs on the walker). */
export function generateBody(body: Stmt[], scope: GenScope, internals: GenInternals, extra: Record<string, unknown> = {}): GenBody | null {
  try {
    const { src, consts } = generateSource(body, scope, internals, extra)
    const factory = evaluate(src) as (h: Record<string, unknown>, k: unknown[]) => GenBody
    return factory({ ...helpersOf(internals), ...extra }, consts)
  } catch (e) {
    // a construct this generator cannot write is the PROGRAM's refusal, not a failure to evaluate
    if (e instanceof TypedUnsupported) throw e
    const why = e instanceof Error ? e.message : String(e)
    // said once per realm: the program still runs, ~9x slower, and nothing else would show it
    if (codegenFallbacks.length === 0) console.warn(`PLC: scan code could not be generated, so the program runs on the much slower reference engine: ${why}`)
    if (codegenFallbacks.length < 16) codegenFallbacks.push(why)
    return null
  }
}

/** One expression of a typed POU as a function of its instance (`c.b`): what an initial value that is not a literal is
 *  evaluated by, so it follows the very operator rules the scan does (typed/pou.ts). */
export function generateValue(e: Expr, scope: GenScope, internals: GenInternals, extra: Record<string, unknown>): (b: number, m?: number) => unknown {
  const g = new Generator(scope, internals)
  const code = g.expr(e)
  const helpers = { ...helpersOf(internals), ...extra }
  const consts = g.consts.map((_, i) => `k${i} = K[${i}]`).join(', ')
  // (`m`: a method's frame, when the value is one of its variables' starting values)
  const src = `(function (H, K) {
'use strict';
const { ${Object.keys(helpers).join(', ')} } = H;
${consts ? `const ${consts};` : ''}
${g.fns.join('\n')}
return function value(b, m) {
const now = 0;
return ${code};
};
})`
  return (evaluate(src) as (h: Record<string, unknown>, k: unknown[]) => (b: number, m?: number) => unknown)(helpers, g.consts)
}
