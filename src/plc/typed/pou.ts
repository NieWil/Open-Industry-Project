// The typed engine's POU: a Pou (pou.ts) whose variables are a region of the program's arena, scanned by generated code
// that addresses them by offset (scanCodegen.ts, `scope.typed`). Everything that goes by name - setInput and its
// paths, ports, get, the watch, memory, initial values - is answered here from the layout, so the program builders
// cannot tell it from the walker's POU. A user function block's instance is a region inside its holder's, run by its
// definition's TypedFb. docs/plc-typed-storage.md.

import { classIds, type Env, fbDecls, funcDecls, identKey, isScalarType, methodDecls } from '../program'
import { coerceScalar, coercerFor, type Pou, type WatchPlace } from '../pou'
import { bool, CALL_DEPTH_MESSAGE, isInt, MAX_CALL_DEPTH, num, wrap } from '../runtime'
import { generateBody, generateValue, type GenBody, type GenInternals, type GenScope, type TypedScope } from '../scanCodegen'
import type { DataType, Decl, Expr, FbDef, FuncDef, Initializer, MethodDef, ScalarType, Stmt, StructInit, TagPort, TagValue, VarInfo } from '../types'
import { isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from '../types'
import type { WatchRange, WatchShape } from '../../core/watchTable'
import { Arena, watchKindOf } from './arena'
import { blocksOver } from './blocks'
import { CLASS_FIELD, type Layouts, OWN_COPY, type PouLayout, type ScalarLayout, type TypeLayout, TypedUnsupported } from './layout'

/** What every typed POU of one program shares: its layouts, its arena (made once every POU has its region), where the
 *  globals are, and a runner per function block definition. */
export interface TypedProgram {
  readonly layouts: Layouts
  readonly internals: GenInternals
  readonly fbDefs: ReadonlyMap<string, FbDef>
  /** the next free byte while POUs are being placed */
  next: number
  arena: Arena | null
  /** what generated code is handed of the arena (its views, string helpers and standard blocks), once it exists */
  extra: Record<string, unknown> | null
  globals: { env: Env; layout: PouLayout; base: number } | null
  /** every POU, in the order built: initialised in that order once the arena exists (the globals first) */
  readonly pous: TypedPou[]
  /** one generated body per definition (its statement list), shared by every instance */
  readonly bodies: WeakMap<Stmt[], GenBody>
  readonly fbs: Map<string, TypedFb>
  /** every user function, its region placed when the program is (typed/compile.ts); or, for one the typed engine
   *  cannot run, what it cannot run - refused only if something calls it */
  readonly fns: Map<string, TypedFn | string>
  /** each call site of a function whose result is a whole array or struct: the region its result is copied into */
  readonly temps: Map<Expr, number>
  /** one generated function per initial value that is not a literal (each belongs to one definition's scope) */
  readonly inits: WeakMap<Initializer, (b: number, m?: number) => unknown>
  /** every method runner made (TypedMethod), generated with the blocks in finish() */
  readonly methods: TypedMethod[]
  /** the method stack: frames go from `stackBase` up, `sp` is the next free byte, `depth` the frames open; both are put
   *  back at the start of every scan, since a fault leaves a scan where it stood (TypedPou.scan) */
  stackBase: number
  sp: number
  depth: number
}

/** A region of `bytes`, aligned for any scalar. */
export function allocate(tp: TypedProgram, bytes: number): number {
  const base = Math.ceil(tp.next / 8) * 8
  tp.next = base + bytes
  return base
}

/** The arena, once every region is known: made, handed to generated code, and every POU initialised and generated. */
export function finish(tp: TypedProgram): void {
  const arena = new Arena(tp.next)
  tp.arena = arena
  tp.extra = {
    I8: arena.I8, U8: arena.U8, I16: arena.I16, U16: arena.U16, I32: arena.I32, U32: arena.U32, F32: arena.F32, F64: arena.F64,
    strAt: (a: number) => arena.strAt(a),
    strPut: (a: number, cap: number, s: string) => arena.strPut(a, cap, s),
    copyBytes: (dst: number, src: number, n: number) => arena.copy(dst, src, n),
    clearAt: (dst: number, ranges: readonly number[]) => arena.clear(dst, ranges),
    ...blocksOver(arena),
  }
  for (const p of tp.pous) p.start()
  // every block body any of them can reach, generated now: a construct the typed engine cannot run refuses the program
  // here, whole, rather than faulting the scan that first calls the block (a body may name blocks not yet seen)
  // (and every function one of them calls, which may call more)
  const unready = (): (TypedFb | TypedFn | TypedMethod)[] => [...tp.fbs.values(), ...tp.methods, ...[...tp.fns.values()].filter((f): f is TypedFn => typeof f !== 'string' && f.called)].filter((f) => !f.ready)
  for (let pending = unready(); pending.length; pending = unready()) {
    for (const f of pending) f.prepare()
  }
}

/** The bytes of the method stack: room for MAX_CALL_DEPTH frames of the largest method any class has. */
export function stackBytes(tp: TypedProgram, fbDefs: Iterable<FbDef>): number {
  let largest = 0
  for (const def of fbDefs) {
    for (const m of def.methods ?? []) {
      if (m.bodyless) continue
      largest = Math.max(largest, Math.ceil(tp.layouts.pou(methodDecls(m), true).size / 8) * 8)
    }
  }
  return largest * MAX_CALL_DEPTH
}

/** The names a definition's code sees: its own variables, as offsets from the instance's address, then the globals,
 *  at their absolute addresses (locals shadow globals, as the checker's lookup does). A METHOD's code sees its frame's
 *  variables first (`frame`, offsets from the frame's address `m`), then the instance's. `cls`: the class whose
 *  instance the code runs on (THIS), for a block's body or method. */
function scopeOf(tp: TypedProgram, env: Env, layout: PouLayout, cls?: TypedFb, frame?: PouLayout): GenScope {
  type Resolved = NonNullable<ReturnType<TypedScope['resolve']>>
  const field = (f: PouLayout['fields'][number], at: { global: boolean; off: number; frame?: true }): Resolved => ({
    layout: f.layout,
    ...at,
    ...(f.ref ? { ref: f.ref } : {}),
    ...(f.nullable ? { nullable: true as const } : {}),
    ...(f.iface !== undefined ? { iface: f.iface } : {}),
  })
  const typed: TypedScope = {
    resolve(name) {
      const key = identKey(name)
      const mine = frame?.byKey.get(key)
      if (mine && !mine.hidden) return field(mine, { global: false, off: mine.off, frame: true })
      const own = layout.byKey.get(key)
      if (own && !own.hidden) return field(own, { global: false, off: own.off })
      const g = tp.globals
      const f = g?.env.has(key) ? g.layout.byKey.get(key) : undefined
      return f ? field(f, { global: true, off: g!.base + f.off }) : undefined
    },
    ...(cls ? { cls: { name: cls.def.name, layout: cls.layout } } : {}),
    method: (concrete, impl) => runnerOf(tp, concrete).method(impl),
    baseBody: (concrete, base) => runnerOf(tp, concrete).baseBody(base),
    dispatch: (key) => {
      // by class number: what an instance of each class that can be reached this way runs for `key`
      const table: (TypedMethod | undefined)[] = []
      for (const [k, id] of classIds(tp.fbDefs as Map<string, FbDef>)) {
        const def = tp.fbDefs.get(k)!
        const impl = def.table?.get(key)
        if (impl && !impl.bodyless && !def.abstract) table[id] = runnerOf(tp, def.name).method(impl)
      }
      return table
    },
    implOf: (from, key) => {
      const impl = tp.fbDefs.get(identKey(from))?.table?.get(key)
      if (!impl) throw new TypedUnsupported(`the method '${key}' of '${from}'`)
      return impl
    },
    frameOf: (m) => tp.layouts.pou(methodDecls(m), true),
    fb: (name) => runnerOf(tp, name),
    fn: (name) => {
      const fn = tp.fns.get(identKey(name))
      if (!fn) throw new TypedUnsupported(`the function '${name}'`)
      if (typeof fn === 'string') throw new TypedUnsupported(fn)
      fn.called = true
      return fn
    },
    temp: (e) => tp.temps.get(e),
  }
  return { env, genv: tp.globals?.env ?? null, typed }
}

/**
 * One method (or accessor) of one class: its body generated over that class's layout (`cls`, the class of the instance
 * it runs on - an inherited method is generated again for every class that inherits it, so THIS and what it calls
 * resolve against the instance's own class) and its frame, its own variables. A frame lives on the method stack for
 * one call, so a method that calls itself has a frame per call, as on a controller.
 */
export class TypedMethod {
  readonly frame: PouLayout
  readonly size: number
  readonly decls: readonly Decl[]
  readonly scope: GenScope
  #body: GenBody | null = null
  /** the frame's starting bytes, once known to be the same on every call (every initial value a literal) */
  #start: Uint8Array | null = null
  readonly #literal: boolean

  constructor(
    private readonly tp: TypedProgram,
    readonly cls: TypedFb,
    readonly impl: MethodDef,
  ) {
    this.decls = methodDecls(impl)
    this.frame = tp.layouts.pou(this.decls, true)
    this.size = Math.ceil(this.frame.size / 8) * 8
    const env: Env = new Map([...cls.env, ...this.decls.filter((d) => d.section !== 'VAR_EXTERNAL').map((d) => [identKey(d.name), d] as const)])
    this.scope = scopeOf(tp, env, cls.layout, cls, this.frame)
    this.#literal = this.decls.every(literalInits)
    tp.methods.push(this)
  }

  get ready(): boolean {
    return this.#body !== null
  }

  prepare(): void {
    if (this.#body) return
    const made = generateBody(this.impl.body, this.scope, this.tp.internals, this.tp.extra!)
    if (!made) throw new TypedUnsupported('a program on a host that will not evaluate generated code')
    this.#body = made
  }

  /** a frame for one call of it on the instance at `b`: taken off the stack and started (its variables to their
   *  starting values, as a FUNCTION's are on every call); answers its address */
  enter(b: number): number {
    const tp = this.tp
    // as deep as calls may nest (the walker counts the same calls), checked before the stack is: it has room for exactly that many
    if (tp.depth >= MAX_CALL_DEPTH) throw new StError(CALL_DEPTH_MESSAGE, this.impl.pos, this.impl.name.length)
    const m = tp.sp
    tp.sp += this.size
    const a = tp.arena!
    if (this.#start) a.U8.set(this.#start, m)
    else {
      zeroRegion(a, this.frame, m)
      initDecls(tp, this.decls, this.frame, this.scope, m, b)
      if (this.#literal) this.#start = a.U8.slice(m, m + this.frame.size)
    }
    return m
  }

  /** the body, on the instance at `b`, with its frame at `m` (its arguments already stored there) */
  run(b: number, now: number, m: number): void {
    const tp = this.tp
    tp.depth++
    try {
      if (!this.#body) this.prepare()
      this.#body!(b, now, m)
    } finally {
      tp.depth--
    }
  }

  /** the frame given back, once the caller has read its outputs and result */
  leave(m: number): void {
    this.tp.sp = m
  }
}

/** A user function block definition: its layout, its scope, and its body, generated on its first call and shared by
 *  every instance (an instance is only an address). */
export class TypedFb {
  readonly env: Env
  readonly layout: PouLayout
  readonly scope: GenScope
  #body: GenBody | null = null

  readonly #methods = new Map<MethodDef, TypedMethod>()
  readonly #bases = new Map<string, { run(b: number, now: number): void }>()

  constructor(
    private readonly tp: TypedProgram,
    readonly def: FbDef,
  ) {
    this.env = new Map(fbDecls(def).filter((d) => d.section !== 'VAR_EXTERNAL').map((d) => [identKey(d.name), d]))
    this.layout = tp.layouts.fb(def.name)
    this.scope = scopeOf(tp, this.env, this.layout, this)
  }

  /** `impl` (this class's, or one it inherits) generated for this class's instances */
  method(impl: MethodDef): TypedMethod {
    let r = this.#methods.get(impl)
    if (!r) this.#methods.set(impl, (r = new TypedMethod(this.tp, this, impl)))
    return r
  }

  /** SUPER^(): the body of `base` (a class this one derives from), generated for this class's instances */
  baseBody(base: string): { run(b: number, now: number): void } {
    let r = this.#bases.get(identKey(base))
    if (!r) {
      const def = this.tp.fbDefs.get(identKey(base))!
      let body: GenBody | null = null
      r = {
        run: (b, now) => {
          if (!body) {
            body = generateBody(def.body, this.scope, this.tp.internals, this.tp.extra!)
            if (!body) throw new TypedUnsupported('a program on a host that will not evaluate generated code')
          }
          body(b, now)
        },
      }
      this.#bases.set(identKey(base), r)
    }
    return r
  }

  get ready(): boolean {
    return this.#body !== null
  }

  /** the body generated (at compile time: finish() prepares every block a program can reach) */
  prepare(): GenBody {
    if (!this.#body) {
      const made = generateBody(this.def.body, this.scope, this.tp.internals, this.tp.extra!)
      if (!made) throw new TypedUnsupported('a program on a host that will not evaluate generated code')
      this.#body = made
    }
    return this.#body
  }

  run(b: number, now: number): void {
    ;(this.#body ?? this.prepare())(b, now)
  }

  /** an instance at `b` to its starting values, as building it does on the walker; an object-oriented one carries its
   *  class's number first */
  init(b: number): void {
    if (this.layout.classId !== undefined) this.tp.arena!.U32[(b + this.layout.byKey.get(identKey(CLASS_FIELD))!.off) >> 2] = this.layout.classId
    initDecls(this.tp, fbDecls(this.def), this.layout, this.scope, b)
  }
}

/**
 * A user function: one region, reused by every call (a function is never live twice: recursion is refused when the
 * program is compiled), and a body generated once. A call is the walker's runFunction over the arena: the region back
 * to its starting values, each given argument stored (a scalar by its input's setter, a whole array or struct copied
 * in from its address; an input a formal call left out keeps its starting value), the body, and the result.
 */
export class TypedFn {
  readonly layout: PouLayout
  readonly base: number
  readonly decls: readonly Decl[]
  readonly scope: GenScope
  /** for each input, in declaration order: whether it takes a whole array or struct */
  readonly aggregate: readonly boolean[]
  /** the layout of a whole array or struct result (null for a scalar one): copied out to the call site's own region */
  readonly result: TypeLayout | null
  /** each input's absolute address and layout, in declaration order, and the result's: where a generated call site
   *  stores its arguments and reads the answer (scanCodegen.ts typedFnCall) */
  readonly inputSlots: readonly { off: number; layout: TypeLayout }[]
  readonly resultSlot: { off: number; layout: TypeLayout }
  /** every input holds its value (no whole array or struct, no reference or interface) and so does the result */
  readonly direct: boolean
  /** set when any code calls it: only those are generated (an unused function refuses nothing) */
  called = false
  #inputs: ((v: unknown) => void)[] = []
  #result: (() => TagValue) | null = null
  #resultAt = 0
  /** the region's starting bytes, once known to be the same on every call (every initial value a literal) */
  #start: Uint8Array | null = null
  #body: GenBody | null = null

  constructor(
    private readonly tp: TypedProgram,
    readonly def: FuncDef,
  ) {
    this.decls = funcDecls(def)
    this.layout = tp.layouts.pou(this.decls)
    this.base = allocate(tp, this.layout.size)
    this.scope = scopeOf(tp, new Map(this.decls.filter((d) => d.section !== 'VAR_EXTERNAL').map((d) => [identKey(d.name), d])), this.layout)
    this.aggregate = def.decls.filter((d) => d.section === 'VAR_INPUT').map((d) => this.layout.byKey.get(identKey(d.name))!.layout.kind !== 'scalar')
    const ret = this.layout.byKey.get(identKey(def.name))!
    this.result = ret.layout.kind === 'scalar' ? null : ret.layout
    const inputs = def.decls.filter((d) => d.section === 'VAR_INPUT').map((d) => this.layout.byKey.get(identKey(d.name))!)
    this.inputSlots = inputs.map((f) => ({ off: this.base + f.off, layout: f.layout }))
    this.resultSlot = { off: this.base + ret.off, layout: ret.layout }
    const holds = (f: typeof ret): boolean => f.layout.kind === 'scalar' && !f.layout.pointer && !f.ref && f.iface === undefined
    this.direct = holds(ret) && inputs.every(holds)
  }

  get ready(): boolean {
    return this.#body !== null
  }

  prepare(): void {
    if (this.#body) return
    const made = generateBody(this.def.body, this.scope, this.tp.internals, this.tp.extra!)
    if (!made) throw new TypedUnsupported('a program on a host that will not evaluate generated code')
    this.#body = made
    const a = this.tp.arena!
    this.#inputs = this.def.decls.filter((d) => d.section === 'VAR_INPUT').map((d) => {
      const f = this.layout.byKey.get(identKey(d.name))!
      const addr = this.base + f.off
      const l = f.layout
      if (l.kind !== 'scalar') return (v: unknown) => a.copy(addr, v as number, l.size)
      if (isEnum(d.type)) return (v: unknown) => a.store(l, addr, wrap('INT', num(v as TagValue)))
      const coerce = coercerFor(d.type as ScalarType, d.maxLen, undefined)
      return (v: unknown) => a.store(l, addr, coerce(v as TagValue))
    })
    const ret = this.layout.byKey.get(identKey(this.def.name))!
    const at = this.base + ret.off
    if (ret.layout.kind === 'scalar') {
      const slot = ret.layout
      this.#result = () => a.load(slot, at)
    } else this.#resultAt = at
  }

  /** a call whose result is a whole array or struct: the result copied to `dst` (the call site's region), and `dst` */
  callAgg(given: unknown[], slots: readonly number[] | undefined, dst: number): number {
    this.#run(given, slots)
    this.tp.arena!.copy(dst, this.#resultAt, this.result!.size)
    return dst
  }

  call(given: unknown[], slots: readonly number[] | undefined): TagValue {
    this.#run(given, slots)
    return this.#result!()
  }

  #run(given: unknown[], slots: readonly number[] | undefined): void {
    this.enter()
    for (let i = 0; i < this.#inputs.length; i++) {
      const k = slots ? slots.indexOf(i) : i
      if (k < 0 || k >= given.length) continue
      this.#inputs[i]!(given[k])
    }
    this.exec()
  }

  /** the region back to its starting values, ready for a call's arguments */
  enter(): void {
    if (!this.#body) this.prepare()
    const a = this.tp.arena!
    // when every initial value is a literal they are the same on every call, so the region as the first reset left it
    // is kept and copied back (the walker caches literal initial values the same way)
    if (this.#start) a.U8.set(this.#start, this.base)
    else {
      zeroRegion(a, this.layout, this.base)
      initDecls(this.tp, this.decls, this.layout, this.scope, this.base)
      if (this.decls.every(literalInits)) this.#start = a.U8.slice(this.base, this.base + this.layout.size)
    }
  }

  /** the body, on the arguments stored since enter() */
  exec(): void {
    this.#body!(this.base, 0) // a function is stateless and block-free: no timer reads the clock
  }
}

/** Whether a declaration's starting value is made only of literals and enumeration members: the same on every reset
 *  (interpreter.ts isLiteralInit, and its arrays and structures). */
function literalInits(d: Decl): boolean {
  const lit = (e: Initializer): boolean => {
    switch (e.node) {
      case 'num':
      case 'bool':
      case 'str':
        return true
      case 'var':
        return e.constValue !== undefined
      case 'unary':
        return lit(e.expr)
      case 'binary':
        return lit(e.left) && lit(e.right)
      case 'structInit':
        return e.fields.every((f) => lit(f.value))
      case 'arrayInit':
        return e.items.every(lit)
      default:
        return false
    }
  }
  return (!d.init || lit(d.init)) && (!d.arrayInit || d.arrayInit.every(lit)) && (!d.structInit || lit(d.structInit))
}

function runnerOf(tp: TypedProgram, name: string): TypedFb {
  const key = identKey(name)
  let fb = tp.fbs.get(key)
  if (!fb) {
    const def = tp.fbDefs.get(key)
    if (!def) throw new TypedUnsupported(`the function block '${name}'`)
    tp.fbs.set(key, (fb = new TypedFb(tp, def)))
  }
  return fb
}

// ---- starting values (the walker's buildPou + resetVars, over the arena) ----

/** Whether a layout holds a function block instance anywhere inside it: state, built before the plain data. */
function holdsBlock(layout: TypeLayout): boolean {
  if (layout.kind === 'scalar') return false
  if (layout.kind === 'array') return holdsBlock(layout.elem)
  return !!layout.block || !!layout.fb || layout.fields.some((f) => holdsBlock(f.layout))
}

/** Every slot of a region at its zero: 0, false and '' are all-zero bytes; an enumeration starts at its first member. */
function zeroRegion(a: Arena, layout: TypeLayout, addr: number): void {
  a.U8.fill(0, addr, addr + layout.size)
  zeroEnums(a, layout, addr)
}
function zeroEnums(a: Arena, layout: TypeLayout, addr: number): void {
  if (layout.kind === 'scalar') {
    if (layout.zero !== undefined) a.store(layout, addr, layout.zero)
  } else if (layout.kind === 'struct') {
    for (const f of layout.fields) zeroEnums(a, f.layout, addr + f.off)
  } else if (needsZero(layout.elem)) {
    const stride = layout.strides[layout.strides.length - 1]!
    for (let i = 0; i < layout.size / stride; i++) zeroEnums(a, layout.elem, addr + i * stride)
  }
}
function needsZero(layout: TypeLayout): boolean {
  if (layout.kind === 'scalar') return layout.zero !== undefined
  if (layout.kind === 'struct') return layout.fields.some((f) => needsZero(f.layout))
  return needsZero(layout.elem)
}

/** Every user block instance inside a region to its definition's starting values (a standard block starts zeroed). */
function initInstances(tp: TypedProgram, layout: TypeLayout, addr: number): void {
  if (layout.kind === 'scalar') return
  if (layout.kind === 'array') {
    if (!holdsBlock(layout.elem)) return
    const stride = layout.strides[layout.strides.length - 1]!
    for (let i = 0; i < layout.size / stride; i++) initInstances(tp, layout.elem, addr + i * stride)
    return
  }
  if (layout.fb) return runnerOf(tp, layout.fb).init(addr)
  if (layout.block) return
  for (const f of layout.fields) initInstances(tp, f.layout, addr + f.off)
}

/**
 * A definition's declarations at `base` to their starting values, in the walker's order (interpreter.ts buildPou):
 * first each declaration holding a function block - its instances built (each running its own definition's), then an
 * initializer written over them - then the plain data, in declaration order. The region is already zeroed.
 */
function initDecls(tp: TypedProgram, declared: readonly Decl[], layout: PouLayout, scope: GenScope, base: number, inst?: number): void {
  const a = tp.arena!
  const decls = declared.filter((d) => d.section !== 'VAR_EXTERNAL')
  const fieldOf = (d: Decl): PouLayout['fields'][number] => layout.byKey.get(identKey(d.name))!
  const value = (e: Initializer): TagValue => {
    if (e.node === 'num' || e.node === 'bool' || e.node === 'str') return e.value
    if (e.node === 'structInit' || e.node === 'arrayInit') throw new TypedUnsupported('this initial value')
    let fn = tp.inits.get(e)
    if (!fn) tp.inits.set(e, (fn = generateValue(e, scope, tp.internals, tp.extra!)))
    // (a method's frame: its own variables at `base`, the instance's at `inst`)
    return (inst === undefined ? fn(base) : fn(inst, base)) as TagValue
  }
  const initScalar = (l: TypeLayout, addr: number, init: Initializer, type: DataType): void => {
    if (l.kind !== 'scalar') throw new TypedUnsupported('this initial value')
    const v = value(init)
    // an enumeration is an integer at run time; any other scalar takes its own store rule
    a.store(l, addr, isEnum(type) ? coerceScalar('INT', v) : coerceScalar(type as ScalarType, v, l.cap))
  }
  const initValue = (l: TypeLayout, addr: number, init: Initializer, type: DataType): void => {
    if (init.node === 'structInit') {
      if (isUserFb(type)) initFields(l, addr, init, (name) => runnerOf(tp, type.fb).env.get(identKey(name))?.type)
      else if (isStruct(type)) initFields(l, addr, init, (name) => tp.layouts.structDef(type.struct)?.fields.find((x) => identKey(x.name) === identKey(name))?.type)
      else throw new TypedUnsupported('this initial value')
    } else if (init.node === 'arrayInit') {
      if (!isArray(type) || l.kind !== 'array') throw new TypedUnsupported('this initial value')
      // items land in row-major order on the innermost elements (the walker's initArray)
      const stride = l.strides[l.strides.length - 1]!
      for (let i = 0; i < init.items.length && i < l.size / stride; i++) initValue(l.elem, addr + i * stride, init.items[i]!, type.elem)
    } else initScalar(l, addr, init, type)
  }
  // a struct's fields, or a user block instance's members (`Inst : Block := (P := 5)`, over what the block declares)
  const initFields = (l: TypeLayout, addr: number, init: StructInit, typeOf: (name: string) => DataType | undefined): void => {
    if (l.kind !== 'struct') throw new TypedUnsupported('this initial value')
    for (const f of init.fields) {
      const field = l.byKey.get(identKey(f.name))
      const t = typeOf(f.name)
      if (field && t !== undefined) initValue(field.layout, addr + field.off, f.value, t)
    }
  }

  for (const d of decls) {
    const f = fieldOf(d)
    if (!holdsBlock(f.layout)) continue
    initInstances(tp, f.layout, base + f.off)
    if (d.structInit && (isStruct(d.type) || isUserFb(d.type))) initValue(f.layout, base + f.off, d.structInit, d.type)
    if (d.arrayInit && isArray(d.type)) initValue(f.layout, base + f.off, { node: 'arrayInit', items: d.arrayInit, pos: d.pos }, d.type)
  }
  for (const d of decls) {
    const f = fieldOf(d)
    if (holdsBlock(f.layout)) continue
    if (f.nullable || f.iface !== undefined) continue // a REF_TO and an interface start at 0: NULL, nothing
    if (f.ref) {
      // a whole-array or struct VAR_IN_OUT starts bound to the instance's own zeroed copy
      const own = layout.byKey.get(identKey(`${d.name}${OWN_COPY}`))!
      a.U32[(base + f.off) >> 2] = base + own.off
      continue
    }
    if (d.init) initScalar(f.layout, base + f.off, d.init, d.type)
    if (d.arrayInit && isArray(d.type)) initValue(f.layout, base + f.off, { node: 'arrayInit', items: d.arrayInit, pos: d.pos }, d.type)
    if (d.structInit && isStruct(d.type)) initValue(f.layout, base + f.off, d.structInit, d.type)
  }
}

/** A scalar place of the arena: where it is and what it holds. */
interface Place {
  addr: number
  slot: ScalarLayout
}

/** One leaf the watch lists: its key and its place. */
interface Leaf extends Place {
  key: string
}

export class TypedPou implements Pou {
  readonly decls: readonly Decl[]
  readonly env: Env
  readonly layout: PouLayout
  readonly base: number
  readonly #scope: GenScope
  #body: GenBody | null = null
  readonly #plans = new Map<string, Leaf[]>()
  readonly #setters = new Map<string, (v: TagValue) => void>()

  constructor(
    declared: Decl[],
    private readonly body: Stmt[],
    private readonly tp: TypedProgram,
    /** the region, when it is already decided (the globals'); otherwise one is allocated */
    base?: number,
  ) {
    this.decls = declared.filter((d) => d.section !== 'VAR_EXTERNAL')
    this.env = new Map(this.decls.map((d) => [identKey(d.name), d]))
    this.layout = tp.layouts.pou(declared)
    this.base = base ?? allocate(tp, this.layout.size)
    this.#scope = scopeOf(tp, this.env, this.layout)
    tp.pous.push(this)
  }

  /** a declared name's absolute place, and its declaration */
  #place(name: string): { addr: number; layout: TypeLayout; decl: Decl } | undefined {
    const key = identKey(name)
    const own = this.layout.byKey.get(key)
    if (own) return { addr: this.base + own.off, layout: own.layout, decl: this.env.get(key)! }
    const g = this.tp.globals
    const f = g?.env.has(key) ? g.layout.byKey.get(key) : undefined
    return f ? { addr: g!.base + f.off, layout: f.layout, decl: g!.env.get(key)! } : undefined
  }

  get #arena(): Arena {
    return this.tp.arena!
  }

  /** Once the arena exists: the variables to their starting values, and the body generated (refused, if it cannot be). */
  start(): void {
    this.reset()
    if (this.body.length === 0) return
    let gen = this.tp.bodies.get(this.body)
    if (!gen) {
      const made = generateBody(this.body, this.#scope, this.tp.internals, this.tp.extra!)
      if (!made) throw new TypedUnsupported('a program on a host that will not evaluate generated code')
      this.tp.bodies.set(this.body, (gen = made))
    }
    this.#body = gen
  }

  scan(now: number): void {
    // the method stack empty, whatever a fault in an earlier scan left on it
    this.tp.sp = this.tp.stackBase
    this.tp.depth = 0
    this.#body?.(this.base, now)
  }

  /** Every variable back to its starting value: the region zeroed, then built as the walker builds a POU. */
  reset(): void {
    zeroRegion(this.#arena, this.layout, this.base)
    initDecls(this.tp, this.decls, this.layout, this.#scope, this.base)
  }

  // ---- by name ----

  setInput(name: string, value: TagValue): void {
    // `Motor1.Run`, `Line[1].Zones[0].Full`, `Drive.Status.5`: walked down the layout, as the walker walks its records
    const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(name)?.[0] ?? ''
    if (head !== '' && head.length < name.length) {
      const root = this.#place(head)
      if (!root || root.decl.constant) return
      let addr = root.addr
      let layout: TypeLayout = root.layout
      const steps = name.slice(head.length).match(/\.[A-Za-z_][A-Za-z0-9_]*|\.[0-9]+|\[[^\]]*\]/g) ?? []
      if (steps.join('') !== name.slice(head.length)) return
      for (let s = 0; s < steps.length; s++) {
        const step = steps[s]!
        if (/^\.[0-9]/.test(step)) {
          // a bit: only ever the last step, and only of an integer
          if (s !== steps.length - 1 || layout.kind !== 'scalar' || layout.enumerated || !isInt(layout.scalar)) return
          const cur = this.#arena.load(layout, addr) as number
          const mask = 2 ** Number(step.slice(1))
          this.#arena.store(layout, addr, wrap(layout.scalar, bool(value) ? (cur | mask) >>> 0 : (cur & ~mask) >>> 0))
          return
        }
        if (step.startsWith('[')) {
          if (layout.kind !== 'array') return
          const at = step.slice(1, -1).split(',').map((x) => Number(x.trim()))
          if (at.length !== layout.dims.length) return
          for (let k = 0; k < at.length; k++) {
            const d = layout.dims[k]!
            if (!Number.isInteger(at[k]) || at[k]! < d.lo || at[k]! > d.hi) return
            addr += (at[k]! - d.lo) * layout.strides[k]!
          }
          layout = layout.elem
          continue
        }
        // a struct's field; never a member of a function block (the walker's path does not write into an instance)
        if (layout.kind !== 'struct' || layout.block || layout.fb) return
        const field = layout.byKey.get(identKey(step.slice(1)))
        if (!field) return
        addr += field.off
        layout = field.layout
      }
      if (layout.kind !== 'scalar') return
      // typed by the place: a BOOL takes a truth, a number a number (at its own width), a STRING text
      const v = layout.scalar === 'BOOL' ? Boolean(value) : layout.scalar === 'STRING' ? String(value) : layout.enumerated ? num(value) : coerceScalar(layout.scalar, value)
      this.#arena.store(layout, addr, v)
      return
    }
    const at = this.#place(name)
    if (!at || at.decl.constant || at.layout.kind !== 'scalar' || isRef(at.decl.type) || isInterface(at.decl.type)) return
    const d = at.decl
    if (isScalarType(d.type)) this.#arena.store(at.layout, at.addr, coerceScalar(d.type, value, d.maxLen))
    // an enum variable is an integer at run time, so a scene tag can drive it
    else if (isEnum(d.type)) this.#arena.store(at.layout, at.addr, wrap('INT', num(value)))
  }

  /** `name`'s setter for setArg and port: the declaration, place and coercion decided once (the walker's setterFor). */
  #setterFor(name: string): (v: TagValue) => void {
    let set = this.#setters.get(name)
    if (set) return set
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    const at = plain ? this.#place(name) : undefined
    if (!at) set = plain ? () => {} : (v: TagValue) => this.setInput(name, v)
    else if (at.decl.constant || at.layout.kind !== 'scalar' || isRef(at.decl.type) || isInterface(at.decl.type)) set = () => {}
    else {
      const slot = at.layout
      const addr = at.addr
      const t = at.decl.type
      if (isScalarType(t)) {
        const coerce = coercerFor(t, at.decl.maxLen, undefined)
        set = (v: TagValue) => this.#arena.store(slot, addr, coerce(v))
      } else if (isEnum(t)) set = (v: TagValue) => this.#arena.store(slot, addr, wrap('INT', num(v)))
      else set = () => {}
    }
    this.#setters.set(name, set)
    return set
  }

  setArg(name: string, value: TagValue): void {
    this.#setterFor(name)(value)
  }

  port(name: string): TagPort {
    const set = this.#setterFor(name)
    const at = this.#place(name)
    if (at && at.layout.kind === 'scalar' && !isRef(at.decl.type) && !isInterface(at.decl.type)) {
      const slot = at.layout
      const addr = at.addr
      return { set, get: () => this.#arena.load(slot, addr) }
    }
    return { set, get: () => undefined }
  }

  get(name: string): TagValue | undefined {
    const at = this.#place(name)
    if (at && (isRef(at.decl.type) || isInterface(at.decl.type))) return undefined // it designates; it holds no value
    return at && at.layout.kind === 'scalar' ? this.#arena.load(at.layout, at.addr) : undefined
  }

  varInfo(name: string): VarInfo | undefined {
    const d = this.env.get(identKey(name)) ?? this.tp.globals?.env.get(identKey(name))
    if (!d || d.hidden) return undefined
    const type = isScalarType(d.type) ? d.type : isEnum(d.type) ? 'ENUM' : null
    if (type === null) return undefined
    return { type, constant: d.constant === true, ...(d.location ? { location: d.location } : {}) }
  }

  typeOf(name: string): DataType | undefined {
    return this.env.get(identKey(name))?.type
  }

  outputs(): [string, TagValue][] {
    const out: [string, TagValue][] = []
    for (const d of this.decls) {
      if (d.section !== 'VAR_OUTPUT' || !isScalarType(d.type)) continue
      const f = this.layout.byKey.get(identKey(d.name))!
      out.push([d.name, this.#arena.load(f.layout as ScalarLayout, this.base + f.off)])
    }
    return out
  }

  // ---- the watch ----

  /** Where every scalar of this POU is, keyed as the watch lists it (the walker's planValue, over the layout instead
   *  of records): `M1.Run`, `Counts[2]`, `Zones[1].Full`; an array longer than `maxArray` is left out. */
  #plan(prefix: string, maxArray: number): Leaf[] {
    const id = `${maxArray}|${prefix}`
    let leaves = this.#plans.get(id)
    if (!leaves) {
      leaves = []
      for (const f of this.layout.fields) if (!f.hidden && !f.ref && f.iface === undefined) planLeaves(leaves, `${prefix}${f.name}`, f.layout, this.base + f.off, maxArray)
      this.#plans.set(id, leaves)
    }
    return leaves
  }

  placesInto(out: Map<string, WatchPlace>, prefix: string, maxArray: number, blocks: boolean): ArrayBuffer {
    for (const { key, slot, addr } of blocks ? this.#blocks(prefix) : this.#plan(prefix, maxArray)) out.set(key, { addr, kind: watchKindOf(slot.scalar) })
    return this.#arena.buffer
  }

  rangesInto(out: WatchRange[], prefix: string, maxArray: number): void {
    for (const f of this.layout.fields) if (!f.hidden && !f.ref && f.iface === undefined) planRanges(out, `${prefix}${f.name}`, f.layout, this.base + f.off, maxArray)
  }

  watchInto(out: Record<string, TagValue>, prefix: string, maxArray: number): void {
    const a = this.#arena
    for (const leaf of this.#plan(prefix, maxArray)) out[leaf.key] = a.load(leaf.slot, leaf.addr)
  }

  /** Each function block instance among this POU's own variables: its outputs, `inst.Q` - a standard block's members,
   *  a user block's scalar VAR_OUTPUTs (the walker's watchBlocks, which lists a variable that is an instance, not one
   *  inside an array or struct). */
  blocksInto(out: Record<string, TagValue>, prefix: string): void {
    const a = this.#arena
    for (const { key, slot, addr } of this.#blocks(prefix)) out[key] = a.load(slot, addr)
  }

  typesInto(out: Record<string, string>, prefix: string): void {
    for (const leaf of this.#plan(prefix, Infinity)) out[leaf.key] = leaf.slot.enumerated ? 'ENUM' : leaf.slot.scalar
    for (const { key, slot } of this.#blocks(prefix)) out[key] = slot.scalar
  }

  deepInto(out: Record<string, TagValue>, prefix: string): void {
    for (const f of this.layout.fields) if (!f.hidden && !f.ref && f.iface === undefined) deepLayout(this.tp, this.#arena, out, `${prefix}${f.name}`, f.layout, this.base + f.off)
  }

  *#blocks(prefix: string): Generator<Leaf> {
    for (const f of this.layout.fields) {
      if (f.layout.kind !== 'struct') continue
      if (f.layout.block) {
        for (const m of f.layout.fields) if (!m.hidden) yield { key: `${prefix}${f.name}.${m.name}`, slot: m.layout as ScalarLayout, addr: this.base + f.off + m.off }
      } else if (f.layout.fb) {
        const fb = runnerOf(this.tp, f.layout.fb)
        for (const d of fbDecls(fb.def)) {
          if (d.section !== 'VAR_OUTPUT' || !isScalarType(d.type)) continue
          const m = fb.layout.byKey.get(identKey(d.name))!
          yield { key: `${prefix}${f.name}.${d.name}`, slot: m.layout as ScalarLayout, addr: this.base + f.off + m.off }
        }
      }
    }
  }
}

/** Every scalar under `key` (deepMemory), through function block instances: a standard block's outputs (its private
 *  state is hidden, as the walker's objects keep theirs), a user block's own variables. */
function deepLayout(tp: TypedProgram, a: Arena, out: Record<string, TagValue>, key: string, layout: TypeLayout, addr: number): void {
  if (layout.kind === 'scalar') {
    if (layout.pointer) return // it designates; it holds nothing
    out[key] = a.load(layout, addr)
  } else if (layout.kind === 'struct') {
    for (const f of layout.fields) if (!f.hidden && !f.ref && f.iface === undefined) deepLayout(tp, a, out, `${key}.${f.name}`, f.layout, addr + f.off)
  } else {
    const walk = (k: number, at: number[], x: number): void => {
      if (k === layout.dims.length) return deepLayout(tp, a, out, `${key}[${at.join(',')}]`, layout.elem, x)
      const d = layout.dims[k]!
      for (let i = d.lo; i <= d.hi; i++) walk(k + 1, [...at, i], x + (i - d.lo) * layout.strides[k]!)
    }
    walk(0, [], addr)
  }
}

function planLeaves(out: Leaf[], key: string, layout: TypeLayout, addr: number, max: number): void {
  if (layout.kind === 'scalar') {
    if (layout.pointer) return // it designates; it holds nothing
    out.push({ key, addr, slot: layout })
  } else if (layout.kind === 'struct') {
    if (layout.block || layout.fb) return // an instance's outputs are blocksInto's, and only for a variable that is one
    for (const f of layout.fields) if (!f.hidden && f.iface === undefined && !f.ref) planLeaves(out, `${key}.${f.name}`, f.layout, addr + f.off, max)
  } else {
    const count = layout.dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1)
    if (count > max) return
    const walk = (k: number, at: number[], a: number): void => {
      if (k === layout.dims.length) return planLeaves(out, `${key}[${at.join(',')}]`, layout.elem, a, max)
      const d = layout.dims[k]!
      for (let i = d.lo; i <= d.hi; i++) walk(k + 1, [...at, i], a + (i - d.lo) * layout.strides[k]!)
    }
    walk(0, [], addr)
  }
}

/** The arrays planLeaves leaves out (longer than `max`), each as its key, its address and its shape: the same walk,
 *  keeping what that one skips. */
function planRanges(out: WatchRange[], key: string, layout: TypeLayout, addr: number, max: number): void {
  if (layout.kind === 'scalar') return
  if (layout.kind === 'struct') {
    if (layout.block || layout.fb) return
    for (const f of layout.fields) if (!f.hidden && f.iface === undefined && !f.ref) planRanges(out, `${key}.${f.name}`, f.layout, addr + f.off, max)
    return
  }
  const count = layout.dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1)
  if (count > max) {
    const shape = shapeOf(layout)
    if (shape) out.push({ key, addr, shape })
    return
  }
  if (layout.elem.kind === 'scalar') return
  const walk = (k: number, at: number[], a: number): void => {
    if (k === layout.dims.length) return planRanges(out, `${key}[${at.join(',')}]`, layout.elem, a, max)
    const d = layout.dims[k]!
    for (let i = d.lo; i <= d.hi; i++) walk(k + 1, [...at, i], a + (i - d.lo) * layout.strides[k]!)
  }
  walk(0, [], addr)
}

// one shape per layout: a range per element of an array of structures shares it, on the wire too
const shapes = new WeakMap<TypeLayout, WatchShape | null>()
/** What planLeaves would list under a place, as a shape (core/watchTable.ts); null when it would list nothing. */
function shapeOf(layout: TypeLayout): WatchShape | null {
  let shape = shapes.get(layout)
  if (shape !== undefined) return shape
  if (layout.kind === 'scalar') shape = layout.pointer ? null : { kind: watchKindOf(layout.scalar) }
  else if (layout.kind === 'struct') {
    const fields: { name: string; off: number; shape: WatchShape }[] = []
    if (!layout.block && !layout.fb) {
      for (const f of layout.fields) {
        const s = !f.hidden && f.iface === undefined && !f.ref ? shapeOf(f.layout) : null
        if (s) fields.push({ name: f.name, off: f.off, shape: s })
      }
    }
    shape = fields.length > 0 ? { fields } : null
  } else {
    const elem = shapeOf(layout.elem)
    shape = elem ? { dims: layout.dims.map((d, k) => ({ lo: d.lo, hi: d.hi, stride: layout.strides[k]! })), elem } : null
  }
  shapes.set(layout, shape)
  return shape
}
