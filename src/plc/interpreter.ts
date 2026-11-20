// The AST walker, and `compile`, which builds a checked program on the engine every program runs on.
//
// That engine is the typed one (typed/, scanCodegen.ts; docs/plc-typed-storage.md): the program's variables in one
// typed arena, its bodies turned once into JavaScript. The walker here is its reference and its fallback, permanently: plc/scanEngines.test.ts holds the two together, every variable after every scan, and a program the typed
// engine refuses (or a host that will not evaluate generated code) runs here, ~9x slower. The walker evaluates no code,
// so it runs under a strict CSP, and it keeps the variables as JS values, so that the comparison is
// between two independent implementations of storage, not one layout read twice.
//
// It runs what the checker (checker.ts) hands back, relying on each expression's resolved IEC type for width-correct
// integer wrapping, and re-checks nothing. A program is a set of POUs: user-defined FUNCTION_BLOCKs (stateful
// instances), stateless FUNCTIONs, and the main program. Aggregate data (arrays, structs) is stored as nested JS
// values; access expressions (`p.inner.arr[i]`) chain through `member` (struct field / FB output) and `index` (array
// element, 1+ dimensions).

import { evalBuiltin, isBuiltinFunc } from './builtins'
import { parseAndCheck } from './checker'
import { FAULT, StFault } from './faults'
import { containsFb, controllerTags, type EnumDefMap, type Env, fbDecls, type FbDefMap, funcDecls, type FuncDefMap, identKey, implementationOf, isFb, isScalarType, methodDecls, type StructDefMap } from './program'
import { checkRange, coerceScalar, coercerFor, configuredProgram, fits, implicitProgram, isTagValue, placeMaxLen, type Pou, type PouBuilder, tagOf, WATCH_ARRAY_MAX } from './pou'
import type { GenInternals } from './scanCodegen'
import { compileTyped } from './typed/compile'
import { TypedUnsupported } from './typed/layout'
import { bool, CALL_DEPTH_MESSAGE, calendarRangeError, copyData, type Fb, type FbArgs, fbMemberType, idiv, imod, isCalendar, isInt, isInt32, isReal, makeFb, MAX_CALL_DEPTH, MAX_LOOP_ITERATIONS, num, str, unboundMessage, wrap } from './runtime'
import type { ArrayDim, ArrayType, CompiledProgram, DataType, Decl, Expr, FbArg, FbDef, FbType, FuncDef, Initializer, MethodDef, ScalarType, SourcePos, Stmt, StructInit, StructRef, TagPort, TagValue, UserFbRef, VarInfo } from './types'
import { isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/** An ordinary store into a place (assignment, a tag write, an argument): every such store of the walker comes through here. */
function put(owner: Record<string | number, unknown>, key: string | number, v: unknown): void {
  owner[key] = v
}
/** A starting value into a place. */
function start(owner: Record<string | number, unknown>, key: string | number, v: unknown): void {
  owner[key] = v
}

/** A runtime value: a scalar, an array (possibly nested for N-D), a struct record, or a
 *  function-block instance - which is data like the rest, so it can sit inside the first two. */
type DataValue = TagValue | DataValue[] | { [field: string]: DataValue } | Fb

/** Is this runtime value a function-block instance, user-defined or standard? A struct record
 *  cannot pass for one: its fields hold data, never a `call` function. */
function isFbInstance(v: DataValue | undefined): v is Fb {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { call?: unknown }).call === 'function'
}

/** Thrown by EXIT, caught by the nearest enclosing loop's executor. */
const EXIT_SIGNAL = Symbol('EXIT')
/** Thrown by CONTINUE - also caught by the nearest loop, but resumes it instead of leaving. */
const CONTINUE_SIGNAL = Symbol('CONTINUE')
/** Thrown by RETURN. Loops do not catch it: it unwinds to the POU boundary,
 *  ending this scan of the program / function block / function. */
const RETURN_SIGNAL = Symbol('RETURN')
/** The one VAR_GLOBAL image a compiled program shares across every POU in it. */
interface GlobalStore {
  env: Env
  image: Image
  /** set for a method's store (instanceStore), whose names are the instance's over the globals: the program's own,
   *  which is all a FUNCTION it calls may see */
  base?: GlobalStore | null
}

// ---- compilation -> a runnable cyclic-scan program ----

/** What a REF_TO holds: the place it refers to, as the record (or array) holding it and the key there (0: NULL). */
class RefCell {
  constructor(
    readonly o: Record<string | number, unknown>,
    readonly k: string | number,
  ) {}
}

/** How deep method calls are nested right now (MAX_CALL_DEPTH) */
let callDepth = 0

/** A user FUNCTION_BLOCK instance: a POU that retains its variable image across calls. */
class UserFb implements Fb {
  /** its body over its variables; set once the instance exists, since that code may reach THIS */
  pou!: RecordPou
  /** each method (and base body, for SUPER^()) built on this instance, on first use; a call that is already running
   *  (a method calling itself) is built afresh, so the two keep their temporaries apart */
  readonly #methods = new Map<MethodDef | Stmt[], { pou: RecordPou; busy: boolean }>()
  constructor(
    /** its class: the definition it is an instance of, whose table a method called on it runs (dispatch) */
    readonly def: FbDef,
    private readonly build: (decls: Decl[], body: Stmt[], self: UserFb, image?: Image) => RecordPou,
  ) {}

  /** `m` (a method or an accessor of this instance's class or one it derives from) run on this instance, as a call
   *  binds its arguments with `enter` before; answers its POU, whose variables are what the caller reads back */
  method(m: MethodDef, enter: (pou: RecordPou) => void, now: number): RecordPou {
    let slot = this.#methods.get(m)
    let pou: RecordPou
    // the kept POU, unless this call is inside one already running it: that one gets a POU of its own (built started)
    const kept = !slot || !slot.busy
    if (!slot) this.#methods.set(m, (slot = { pou: (pou = this.build(methodDecls(m), m.body, this)), busy: false }))
    else if (slot.busy) pou = this.build(methodDecls(m), m.body, this)
    else {
      pou = slot.pou
      pou.reset()
    }
    enter(pou)
    if (callDepth >= MAX_CALL_DEPTH) throw new StError(CALL_DEPTH_MESSAGE, m.pos, m.name.length)
    callDepth++
    if (kept) slot.busy = true
    try {
      pou.scan(now)
    } finally {
      callDepth--
      if (kept) slot.busy = false
    }
    return pou
  }

  /** SUPER^(): the body of `base` (a class this one derives from) run on this instance's own variables */
  baseBody(base: FbDef, now: number): void {
    let slot = this.#methods.get(base.body)
    if (!slot) this.#methods.set(base.body, (slot = { pou: this.build(fbDecls(this.def), base.body, this, this.pou.image), busy: false }))
    slot.pou.scan(now)
  }

  /** an input that is a REF_TO or an interface, given by a call: the reference (a RefCell, 0 for NULL) or the instance */
  bind(name: string, v: RefCell | UserFb | 0): void {
    this.pou.image.home(name)![name] = v as unknown as DataValue
  }
  /** What this instance starts with, in place of what the block's declaration says (`Inst : Block := (P := 5)`). */
  start(member: string, make: (current: DataValue) => DataValue): void {
    const rec = this.pou.image.home(member)!
    start(rec, member, make(rec[member]!))
  }
  call(args: FbArgs, now: number): void {
    for (const k of Object.keys(args)) {
      const v = args[k]
      if (v !== undefined) this.pou.setArg(k, v)
    }
    this.pou.scan(now)
  }
  /** One input of a call, written ahead of {@link run}: call() taken apart, so generated code passes its arguments
   *  without building an object of them each call (scanCodegen.ts) */
  enter(name: string, v: TagValue): void {
    if (v !== undefined) this.pou.setArg(name, v)
  }
  /** the body, once its inputs are entered */
  run(now: number): void {
    this.pou.scan(now)
  }
  /** An output, by its declared name: a scalar, or a whole array or struct as a live reference,
   *  which a reader that keeps it copies (the checker refuses any write through it). */
  read(member: string): DataValue {
    const v = this.pou.image.home(member)?.[member]
    return v === undefined ? 0 : v
  }
  /** A whole array or struct VAR_INPUT arrives by value: copied into the block's own storage, so
   *  nothing the caller does to its variable afterwards reaches the block. */
  copyIn(name: string, v: DataValue): void {
    copyData(this.pou.image.home(name)![name]!, v)
  }
  /** VAR_IN_OUT plumbing: bind the caller's storage into the block's own image. An
   *  aggregate is bound by reference (the JS value is the same object, so the block's
   *  writes land in the caller's array/struct); a scalar is copied in and back out again,
   *  which is observationally the same thing for a value with no interior. */
  bindInOut(name: string, v: DataValue): void {
    put(this.pou.image.home(name)!, name, v)
  }
  readInOut(name: string): DataValue | undefined {
    return this.pou.image.home(name)?.[name]
  }
  outputs(): [string, TagValue][] {
    return this.pou.outputs()
  }
  /** a member's declared type (memoryTypes) */
  typeOf(member: string): DataType | undefined {
    return this.pou.typeOf(member)
  }
  /** every scalar this instance holds (deepMemory) */
  deepInto(out: Record<string, TagValue>, prefix: string): void {
    this.pou.deepInto(out, prefix)
  }
}

/** Instantiate a user FB by name, guarding against (in)direct recursion. */
function instantiate(name: string, fbDefs: FbDefMap, funcs: FuncDefMap, structDefs: StructDefMap, enumDefs: EnumDefMap, stack: string[], pos: SourcePos, globals: GlobalStore | null): UserFb {
  if (stack.includes(identKey(name))) throw new StError(`recursive function block '${name}'`, pos)
  const def = fbDefs.get(identKey(name))
  if (!def) throw new StError(`unknown function block '${name}'`, pos)
  const inner = [...stack, identKey(name)]
  // a method's variables over the instance's (instanceStore); a base class's body (SUPER^()) over the instance's own image
  const fb = new UserFb(def, (decls, body, self, image) =>
    image ? buildPou(decls, body, fbDefs, funcs, structDefs, enumDefs, inner, globals, image, self, true) : buildPou(decls, body, fbDefs, funcs, structDefs, enumDefs, inner, instanceStore(self, globals), undefined, self),
  )
  fb.pou = buildPou(fbDecls(def), def.body, fbDefs, funcs, structDefs, enumDefs, inner, globals, undefined, fb)
  return fb
}

/** What a method's code reaches beneath its own variables: the instance's (inherited ones too), then the globals. */
function instanceStore(fb: UserFb, globals: GlobalStore | null): GlobalStore {
  const own = new Map(fbDecls(fb.def).filter((d) => d.section !== 'VAR_EXTERNAL').map((d) => [identKey(d.name), d]))
  const img = fb.pou.image
  const outer = globals?.image
  return {
    base: globals,
    env: new Map([...(globals?.env ?? []), ...own]),
    image: {
      chunks: img.chunks,
      home: (n) => (own.has(identKey(n)) ? img.home(n) : outer?.home(n)),
      index: (n) => img.index(n),
    },
  }
}

/** One reusable POU per function definition - building a POU per call would re-allocate
 *  the whole closure set every invocation, in the middle of the scan hot path. Reuse is
 *  safe: recursion is rejected at compile time and arguments are fully evaluated before
 *  the call, so a function's single POU is never live twice; `reset()` restores the
 *  stateless-per-invocation semantics. Keyed by the FuncDef object, which is unique per
 *  compiled program (WeakMap, so it lives exactly as long as the program). */
const funcPous = new WeakMap<FuncDef, RecordPou>()

/**
 * Run a stateless function once with positional args, returning its result.
 *
 * A whole array or struct argument is copied into the function's own, freshly zeroed input. A
 * whole array or struct result comes back as the function's own record, which is safe to hand out
 * because reset() replaces that record on the next call rather than clearing it: a caller still
 * holding the previous result (`Total(MakePt(1), MakePt(2))` holds two) keeps it intact.
 */
/** A FUNCTION's inputs, in declaration order: the order a call's arguments are given in. */
const inputsOf = (def: FuncDef): Decl[] => def.decls.filter((d) => d.section === 'VAR_INPUT')

/** An argument slot a formal call left out: the input keeps its declared initial value. */
const OMITTED: DataValue = Object.freeze({}) as DataValue

function runFunction(def: FuncDef, args: DataValue[], fbDefs: FbDefMap, funcs: FuncDefMap, structDefs: StructDefMap, enumDefs: EnumDefMap, globals: GlobalStore | null): DataValue {
  let pou = funcPous.get(def)
  if (pou) {
    pou.reset()
  } else {
    pou = buildPou(funcDecls(def), def.body, fbDefs, funcs, structDefs, enumDefs, [], globals)
    funcPous.set(def, pou)
  }
  inputsOf(def).forEach((d, i) => {
    if (i >= args.length || args[i] === OMITTED) return
    if (isArray(d.type) || isStruct(d.type)) copyData(pou.image.home(d.name)![d.name]!, args[i])
    else pou.setArg(d.name, args[i] as TagValue)
  })
  pou.scan(0) // functions are stateless and FB-free, so no timer reads the clock
  const v = pou.image.home(def.name)?.[def.name]
  if (v !== undefined) return v
  return def.ret === 'BOOL' ? false : def.ret === 'STRING' ? '' : 0
}

/** Builds a fresh function-block instance of a type, wherever inside a value one is needed. */
type FbFactory = (t: FbType | UserFbRef) => Fb

/** For data that cannot hold an instance: resetVars() only ever re-zeroes such declarations. */
const NO_FB: FbFactory = () => {
  throw new Error('unreachable: plain data holds no function-block instance')
}

/**
 * A new variable record (a POU's image, or a struct value) with every field of `fields` already present, in that
 * order: a spread of one template per definition (`key`), so every record of a definition shares one V8 shape in
 * fast mode. Filled one keyed store at a time, a record past ~12 fields becomes a hash table and every instance of a
 * function block gets a shape of its own, so the one generated body they share reads them all polymorphically
 * (spread clones stay fast and shared to several hundred fields; past ~1000 nothing does, a V8 limit). The placeholders are replaced before anything reads the record, and they hold the
 * declared kind (false, '', 0) so a field's representation starts where it will stay.
 */
function shapedRecord(key: object, fields: readonly { name: string; type: DataType }[]): Record<string, DataValue> {
  let shape = recordShapes.get(key)
  if (!shape) {
    shape = {}
    for (const f of fields) shape[f.name] = f.type === 'BOOL' ? false : f.type === 'STRING' ? '' : isScalarType(f.type) || isEnum(f.type) ? 0 : (null as unknown as DataValue)
    recordShapes.set(key, shape)
  }
  return { ...shape }
}
const recordShapes = new WeakMap<object, Record<string, DataValue>>()

/** A POU's record fields in the order its record holds them: the declarations holding a function block first (built
 *  once, below), then the plain data resetVars initialises. A VAR_EXTERNAL owns no storage, so it has no field. */
function recordFields(declared: readonly Decl[], structDefs: StructDefMap): Decl[] {
  const decls = declared.filter((d) => d.section !== 'VAR_EXTERNAL')
  return [...decls.filter((d) => containsFb(d.type, structDefs)), ...decls.filter((d) => !containsFb(d.type, structDefs))]
}

/** Most fields one chunk of a variable record holds. Past ~1000 V8 keeps an object as a hash table however it was built
 *  (measured: a POU of 1,400 variables lost most of the record-generated engine's speed, ~11x the walker -> ~4x),
 *  and a large controller can hold thousands of controller-scope tags. 512 leaves room under that limit. */
const CHUNK_FIELDS = 512

/**
 * A POU's variables, or the program's globals: one fixed-shape record (shapedRecord), or for a POU past CHUNK_FIELDS
 * several, each a fixed-shape record of up to that many, split in declaration order. Every variable has one home chunk,
 * fixed for the definition, so generated code addresses it by index (`V2.Tag900`) and everything that goes by name
 * asks `home`. The chunks are never replaced, so a reference to one stays good for the image's life. A POU that fits one
 * chunk (nearly all) is exactly the record it always was.
 */
interface Image {
  readonly chunks: readonly Record<string, DataValue>[]
  /** the chunk holding `name`; undefined for a name it does not hold (a one-chunk image answers its record for any name) */
  home(name: string): Record<string, DataValue> | undefined
  /** the index of `name`'s chunk (0 for a one-chunk image, and for a name it does not hold) */
  index(name: string): number
}

/** How a definition's fields fall into chunks: computed once per definition, shared by its every instance. */
interface Layout {
  slices: { name: string; type: DataType }[][]
  at: Map<string, number>
}
const layouts = new WeakMap<object, Layout>()

/** A fresh image of `fields` (in order), keyed by its definition (`key`) so every instance shares the layout and shapes. */
function makeImage(key: object, fields: readonly { name: string; type: DataType }[]): Image {
  let lay = layouts.get(key)
  if (!lay) {
    const slices: { name: string; type: DataType }[][] = []
    for (let i = 0; i < fields.length; i += CHUNK_FIELDS) slices.push(fields.slice(i, i + CHUNK_FIELDS))
    if (slices.length === 0) slices.push([])
    const at = new Map<string, number>()
    slices.forEach((slice, i) => slice.forEach((f) => at.set(f.name, i)))
    layouts.set(key, (lay = { slices, at }))
  }
  // each slice is its own shape template (shapedRecord is keyed by the slice, fixed in the layout)
  const chunks = lay.slices.map((slice) => shapedRecord(slice, slice))
  if (chunks.length === 1) {
    const only = chunks[0]!
    return { chunks, home: () => only, index: () => 0 }
  }
  const at = lay.at
  return {
    chunks,
    home: (name) => {
      const i = at.get(name)
      return i === undefined ? undefined : chunks[i]
    },
    index: (name) => at.get(name) ?? 0,
  }
}

/** Zero value for a data type: 0/false for scalars, nested arrays, zeroed struct records, and a
 *  fresh instance from `mkFb` for every function block anywhere inside. */
function zeroData(t: DataType, structDefs: StructDefMap, enumDefs: EnumDefMap, mkFb: FbFactory): DataValue {
  if (isFb(t) || isUserFb(t)) return mkFb(t)
  // an enumeration starts at its first member, per IEC - not necessarily at 0
  if (isEnum(t)) return enumDefs.get(identKey(t.enum))?.members[0]?.value ?? 0
  if (isArray(t)) return makeArray(t.dims, 0, t.elem, structDefs, enumDefs, mkFb)
  if (isStruct(t)) {
    const def = structDefs.get(identKey(t.struct))
    const fields = def?.fields ?? []
    const rec: Record<string, DataValue> = def ? shapedRecord(def, fields) : {}
    for (const f of fields) rec[f.name] = zeroData(f.type, structDefs, enumDefs, mkFb)
    return rec
  }
  if (t === 'BOOL') return false
  return t === 'STRING' ? '' : 0
}

function makeArray(dims: ArrayDim[], k: number, elem: DataType, structDefs: StructDefMap, enumDefs: EnumDefMap, mkFb: FbFactory): DataValue[] {
  const d = dims[k]!
  const n = d.hi - d.lo + 1
  if (k === dims.length - 1) return Array.from({ length: n }, () => zeroData(elem, structDefs, enumDefs, mkFb))
  return Array.from({ length: n }, () => makeArray(dims, k + 1, elem, structDefs, enumDefs, mkFb))
}

// ---- the engines ----
//
// `compile` builds a program on the typed engine; `setScanEngine('walker')` builds the next ones on the walker instead
// (the differential test, benchmarks). The walker's own speed rests on two things that are worth keeping although
// nothing generated reads its records any more: every record of a definition on one V8 shape (shapedRecord), and an
// image of more than CHUNK_FIELDS variables split into chunks.

/** Each call site's user FUNCTION, resolved on its first call (null: no such function) - per compiled program, since
 *  the call nodes are its own. */
const calledFns = new WeakMap<Expr, FuncDef | null>()

/** Whether an initial value is made only of literals and enumeration members (through unary and binary operators):
 *  the same value every time it is evaluated, so a reset may keep it. */
function isLiteralInit(e: Expr): boolean {
  switch (e.node) {
    case 'num':
    case 'bool':
    case 'str':
      return true
    case 'var':
      return e.constValue !== undefined
    case 'unary':
      return isLiteralInit(e.expr)
    case 'binary':
      return isLiteralInit(e.left) && isLiteralInit(e.right)
    default:
      return false
  }
}

/** Which engine `compile` builds programs on from now on. Programs already built keep theirs. */
export type ScanEngine = 'typed' | 'walker'
let scanEngine: ScanEngine = 'typed'
/** Choose the engine programs compile to from now on (the differential test and benchmarks); returns the previous one. */
export function setScanEngine(engine: ScanEngine): ScanEngine {
  const was = scanEngine
  scanEngine = engine
  return was
}

/** What generated code is handed of this module: the walker's own store rules and loop signals, so the engines agree. */
let genInternals: GenInternals | null = null
function internals(): GenInternals {
  return (genInternals ??= { eq, fits, checkRange, coercerFor, placeMaxLen, EXIT: EXIT_SIGNAL, CONTINUE: CONTINUE_SIGNAL })
}

/** Why each program the typed engine refused runs on the walker instead (TypedUnsupported): said once per realm, kept
 *  for a test or a host to read. Empty for every program this repo compiles (the engine tests assert it). */
export const typedRefusals: string[] = []

/**
 * Build a runnable POU from its declarations + body, instantiating nested FBs.
 *
 * `image` is the record the variables live in, a fresh one by default. The program's VAR_GLOBALs
 * pass the shared store's own record, so that an instance built inside a global (a global user
 * block, whose body reads other globals) is handed the very store it is being built into.
 */
/** A POU over JS records (pou.ts Pou), and the image they are: what the walker builds. */
interface RecordPou extends Pou {
  /** its variables (Image: one fixed-shape record, or several for a POU past CHUNK_FIELDS) */
  readonly image: Image
}

/** `self`: the instance a function block's body or method runs on (THIS). `adopt`: `image` is already built and
 *  started, and this POU only runs code over it (a base class's body, for SUPER^()). */
function buildPou(declared: Decl[], body: Stmt[], fbDefs: FbDefMap, funcs: FuncDefMap, structDefs: StructDefMap, enumDefs: EnumDefMap, stack: string[], globals: GlobalStore | null, image?: Image, self: UserFb | null = null, adopt = false): RecordPou {
  // a VAR_EXTERNAL owns no storage: leaving it out of the env is what sends its name to the global
  const decls = declared.filter((d) => d.section !== 'VAR_EXTERNAL')
  const env: Env = new Map()
  for (const d of decls) env.set(identKey(d.name), d)
  // every instance of this definition on one layout and one set of shapes (makeImage), keyed by its declaration list
  const img = image ?? makeImage(declared, recordFields(declared, structDefs))
  /** this POU's own chunk holding `name` (its first, for a name it does not hold: what a stray write always reached) */
  const own = (name: string): Record<string, DataValue> => img.home(name) ?? img.chunks[0]!
  /** Which record holds `name` - this POU's own image, or the program-wide VAR_GLOBALs.
   *  Locals shadow globals, matching the checker's `lookup`. */
  // Runs on every variable read and write, so the answer is memoized per spelling: both envs are complete
  // before the first call and never change after, so a name's record is fixed for the POU's life (and an image's
  // chunks are never replaced). (Profiled: the two identKey folds + lookups here were ~30% of the demo
  // program's scan.)
  const homes = new Map<string, Record<string, DataValue>>()
  const store = (name: string): Record<string, DataValue> => {
    let rec = homes.get(name)
    if (rec === undefined) {
      const key = identKey(name)
      const g = !!globals && !env.has(key) && globals.env.has(key)
      rec = (g ? globals!.image.home(name) : undefined) ?? own(name)
      homes.set(name, rec)
    }
    return rec
  }

  /** A user FUNCTION call, its arguments already evaluated (by the walker above, or by generated code). An input a
   *  formal call left out (`slots`) is not given at all, so it keeps the initial value runFunction's reset gave it. */
  function callFn(e: Expr, given: DataValue[]): DataValue {
    if (e.node !== 'call') return 0
    let def = calledFns.get(e)
    if (def === undefined) calledFns.set(e, (def = funcs.get(identKey(e.name)) ?? null))
    if (!def) return 0
    const args = e.slots ? inputsOf(def).map((_, i) => { const k = e.slots!.indexOf(i); return k < 0 ? OMITTED : given[k]! }) : given
    return runFunction(def, args, fbDefs, funcs, structDefs, enumDefs, globals?.base !== undefined ? globals.base : globals)
  }

  /** Evaluate where a scalar is required (operands, conditions, indices) - checker-guaranteed. */
  function evalScalar(e: Expr): TagValue {
    return evalExpr(e) as TagValue
  }

  /** Evaluate an expression; aggregate values are returned as live references (for mutation). */
  function evalExpr(e: Expr): DataValue {
    switch (e.node) {
      case 'num':
        return e.value
      case 'bool':
        return e.value
      case 'str':
        return e.value
      case 'var': {
        if (e.constValue !== undefined) return e.constValue // an enumeration member
        if (e.ref) {
          // a REF_TO dereferenced, r^: the place it refers to
          const cell = refCell(e)
          const v = cell.o[cell.k] as DataValue | undefined
          return v === undefined ? 0 : v
        }
        const v = store(e.name)[e.name]
        return v === undefined ? 0 : v
      }
      case 'this':
        return self as unknown as DataValue
      case 'mcall':
        return callMethod(e, nowOf())
      case 'isref': {
        const at = slotOf(e.obj)
        const v = at.o[at.k]
        return v instanceof RefCell || v instanceof UserFb
      }
      case 'member': {
        const obj = evalExpr(e.obj)
        // a user block's outputs live in its own image; a standard block's are plain properties,
        // read exactly like a struct field
        if (obj instanceof UserFb) return obj.read(e.field)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return (obj as Record<string, DataValue>)[e.field] ?? 0
        return 0
      }
      case 'bit':
        return ((num(evalScalar(e.obj)) >>> e.bit) & 1) === 1
      case 'index': {
        let cur = evalExpr(e.obj)
        const dims = e.dims ?? []
        for (let k = 0; k < e.indices.length; k++) {
          if (!Array.isArray(cur)) return 0
          const i = num(evalScalar(e.indices[k]!))
          const d = dims[k]!
          if (i < d.lo || i > d.hi) throw new StFault(FAULT.SUBSCRIPT, `array index ${i} out of bounds [${d.lo}..${d.hi}]`, e.pos)
          cur = cur[i - d.lo]!
        }
        return cur ?? 0
      }
      case 'call': {
        if (isBuiltinFunc(e.name)) {
          const args = e.args.map((a) => evalScalar(a))
          try {
            return evalBuiltin(e.name, e.t!, args)
          } catch (err) {
            // a built-in faults with a plain Error (runtime.ts idiv / imod: DIV or MOD by zero), which reached the
            // editor with no line at all; the `/` and MOD operators fault at their position, so the call does too
            if (err instanceof Error && !(err instanceof StError)) throw new StError(err.message, e.pos, e.name.length)
            throw err
          }
        }
        // a user function may take a whole array or struct, so its arguments are values of any kind
        return callFn(e, e.args.map((a) => evalExpr(a)))
      }
      case 'unary': {
        const v = evalScalar(e.expr)
        if (e.op === 'NOT') return typeof v === 'boolean' ? !v : wrap(e.t!, ~num(v))
        if (e.op === 'NEG') return wrap(e.t!, -num(v))
        return num(v)
      }
      case 'binary':
        return evalBinary(e)
    }
  }

  function evalBinary(e: Extract<Expr, { node: 'binary' }>): TagValue {
    const op = e.op
    const t = e.t!
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      const l = evalScalar(e.left)
      const r = evalScalar(e.right)
      // STRING compares lexicographically (by character code), which is what JS `<` on
      // strings already does and what the standard's comparison functions specify
      if (typeof l === 'string' || typeof r === 'string') {
        const [a, b] = [str(l), str(r)]
        switch (op) {
          case '=': return a === b
          case '<>': return a !== b
          case '<': return a < b
          case '>': return a > b
          case '<=': return a <= b
          case '>=': return a >= b
        }
      }
      switch (op) {
        case '=': return eq(l, r)
        case '<>': return !eq(l, r)
        case '<': return num(l) < num(r)
        case '>': return num(l) > num(r)
        case '<=': return num(l) <= num(r)
        case '>=': return num(l) >= num(r)
      }
    }
    if (op === 'AND' || op === 'OR' || op === 'XOR') {
      // both operands are evaluated, deliberately: `d <> 0 AND 100 / d > 1` faults here on d = 0
      // rather than being protected by its guard. IEC leaves operand evaluation open, so implementations
      // may differ: MATIEC compiles a BOOL AND to C `&&` and skips the divide. A program that depends on
      // the difference is non-portable either way, so this engine sides with faulting: a guard that
      // silently works here would take a line down on a target that evaluates both. The
      // emitted TypeScript combines through andB/orB for the same reason.
      const l = evalScalar(e.left)
      const r = evalScalar(e.right)
      if (t === 'BOOL') {
        const a = bool(l)
        const b = bool(r)
        return op === 'AND' ? a && b : op === 'OR' ? a || b : a !== b
      }
      const a = num(l)
      const b = num(r)
      return wrap(t, op === 'AND' ? a & b : op === 'OR' ? a | b : a ^ b)
    }
    // arithmetic
    const l = num(evalScalar(e.left))
    const r = num(evalScalar(e.right))
    // a TOD or DT sum (the checker admits only + and - here): a result outside its type's range faults,
    // as runtime.ts `calendarValue` does for the emitted program and the functions
    if (isCalendar(t)) {
      const x = op === '+' ? l + r : l - r
      const why = calendarRangeError(t, x)
      if (why !== null) throw new StError(why, e.pos)
      return x
    }
    if (isReal(t)) {
      // wrap() rounds a REAL result to f32 (LREAL passes through) - single precision has
      // to be applied per operation, not just on the final store, or an f64 intermediate
      // silently beats the hardware's accuracy
      switch (op) {
        case '+': return wrap(t, l + r)
        case '-': return wrap(t, l - r)
        case '*': return wrap(t, l * r)
        case '/': return wrap(t, l / r) // IEEE: /0 -> ±Infinity, like PLC float hardware (no fault)
        // MOD never reaches here - the checker restricts it to integers
      }
    }
    switch (op) {
      // (the exact result once, then what the type keeps of it: `fits` compares the two)
      case '+': {
        const exact = l + r
        return fits(t, exact, wrap(t, exact), e.pos)
      }
      case '-': {
        const exact = l - r
        return fits(t, exact, wrap(t, exact), e.pos)
      }
      case '*': {
        const exact = l * r
        return fits(t, exact, isInt32(t) ? wrap(t, Math.imul(l | 0, r | 0)) : wrap(t, exact), e.pos)
      }
      // by zero: the scan faults (runtime.ts `idiv` / `imod`, which the emitted program calls too - said here first
      // only because here there is a position to say it with)
      case '/':
        if (r === 0) throw new StError('division by zero', e.pos) // fault the scan, like a real PLC
        return wrap(t, idiv(l, r))
      case 'MOD':
        if (r === 0) throw new StError('MOD by zero', e.pos)
        return wrap(t, imod(l, r))
    }
    throw new StError(`unsupported operator '${op}'`, e.pos)
  }

  /** the controller clock of the scan running this POU's code: what a method called from an expression hands on */
  let currentNow = 0
  const nowOf = (): number => currentNow

  /** What a REF_TO variable refers to, or the fault for dereferencing one that is NULL. */
  function refCell(e: Extract<Expr, { node: 'var' }>): RefCell {
    const cell = store(e.name)[e.name]
    if (!(cell instanceof RefCell)) throw new StError(unboundMessage('ref'), e.pos, e.name.length)
    return cell
  }

  /** Where a REF_TO or an interface is kept (a variable, an element of an array of interfaces): the slot itself,
   *  not what it designates. */
  function slotOf(e: Expr): RefCell {
    if (e.node === 'var') return new RefCell(store(e.name), e.name)
    if (e.node !== 'index') throw new StError('unreachable: a reference that is neither a variable nor an element', e.pos)
    let cur = evalExpr(e.obj)
    const dims = e.dims ?? []
    for (let k = 0; k < e.indices.length; k++) {
      const i = num(evalScalar(e.indices[k]!))
      const d = dims[k]!
      if (i < d.lo || i > d.hi) throw new StFault(FAULT.SUBSCRIPT, `array index ${i} out of bounds [${d.lo}..${d.hi}]`, e.pos)
      if (k === e.indices.length - 1) return new RefCell(cur as unknown as Record<number, unknown>, i - d.lo)
      cur = (cur as DataValue[])[i - d.lo]!
    }
    throw new StError('unreachable: an element with no subscript', e.pos)
  }

  /** Where a place is, for a REF_TO to refer to it (REF(place)): the record (or array) holding it, and its key there.
   *  REF(r^) is what r refers to. */
  function placeOf(e: Expr): RefCell {
    switch (e.node) {
      case 'var':
        return e.ref ? refCell(e) : new RefCell(store(e.name), e.name)
      case 'this':
        return new RefCell({ self }, 'self')
      case 'member': {
        const obj = evalExpr(e.obj)
        if (obj instanceof UserFb) return new RefCell(obj.pou.image.home(e.field)!, e.field)
        return new RefCell(obj as unknown as Record<string, unknown>, e.field)
      }
      case 'index': {
        let cur = evalExpr(e.obj)
        const dims = e.dims ?? []
        for (let k = 0; k < e.indices.length; k++) {
          const i = num(evalScalar(e.indices[k]!))
          const d = dims[k]!
          if (i < d.lo || i > d.hi) throw new StFault(FAULT.SUBSCRIPT, `array index ${i} out of bounds [${d.lo}..${d.hi}]`, e.pos)
          if (k === e.indices.length - 1) return new RefCell(cur as unknown as Record<number, unknown>, i - d.lo)
          cur = (cur as DataValue[])[i - d.lo]!
        }
        throw new StError('unreachable: an element with no subscript', e.pos)
      }
      default:
        throw new StError('unreachable: a REF_TO referring to what is not a place (the checker refuses it)', e.pos)
    }
  }

  /** What a REF_TO is given: REF(place)'s place, another REF_TO's reference as it is (`alias`, NULL too), or NULL (a
   *  literal 0, the checker's spelling of it). */
  function refGiven(e: Expr, alias: boolean | undefined): RefCell | 0 {
    if (alias && e.node === 'var') {
      const c = store(e.name)[e.name]
      return c instanceof RefCell ? c : 0
    }
    if (e.node === 'num') return 0
    return placeOf(e)
  }

  /** The instance an interface is given: THIS, an instance's place, another interface's instance; 0 for none. */
  function instanceOf(e: Expr): UserFb | 0 {
    if (e.node === 'this') return self ?? 0
    const v = evalExpr(e)
    return v instanceof UserFb ? v : 0
  }

  /**
   * A METHOD (or an accessor, or SUPER^()) called, in a block call's order (execStmt `fbcall`): the instance first -
   * the one an interface or a reference designates, which faults when there is none - then its scalar inputs in the
   * call's order, then each whole-array or struct input copied in, each in-out bound and each reference or interface
   * input bound, in the call's order; then the body, each scalar in-out copied back, each output stored, and the result.
   */
  function callMethod(e: Extract<Expr, { node: 'mcall' }>, now: number): DataValue {
    let target: UserFb
    if (e.obj.node === 'this') target = self!
    else {
      const v = evalExpr(e.obj)
      if (!(v instanceof UserFb)) throw new StError(unboundMessage('iface'), e.pos)
      target = v
    }
    if (e.body) {
      target.baseBody(fbDefs.get(identKey(e.cls!))!, now)
      return 0
    }
    const impl = e.dispatch === 'static' ? implementationOf(fbDefs, e.cls!, e.key!)! : target.def.table!.get(e.key!)!
    const scalars: [string, TagValue][] = []
    for (const arg of e.args) if (!arg.out && !arg.inout && !arg.copy && !arg.bind) scalars.push([arg.name, evalScalar(arg.value)])
    const bound: [FbArg, DataValue | RefCell | UserFb | 0][] = []
    for (const arg of e.args) {
      if (arg.copy && !arg.out) bound.push([arg, evalExpr(arg.value)])
      else if (arg.inout) bound.push([arg, evalExpr(arg.value)])
      else if (arg.bind === 'ref') bound.push([arg, refGiven(arg.value, arg.alias)])
      else if (arg.bind === 'iface') bound.push([arg, instanceOf(arg.value)])
    }
    const pou = target.method(impl, (p) => {
      for (const [arg, v] of bound) {
        const home = p.image.home(arg.name)!
        if (arg.copy) copyData(home[arg.name]!, v as DataValue)
        else if (arg.inout) put(home, arg.name, v)
        else home[arg.name] = v as unknown as DataValue
      }
      for (const [name, v] of scalars) p.setArg(name, v)
    }, now)
    for (const arg of e.args) {
      if (!arg.inout) continue
      const v = pou.image.home(arg.name)?.[arg.name]
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') assignPlace(arg.value, v)
    }
    for (const arg of e.args) {
      if (!arg.out) continue
      const v = pou.image.home(arg.name)?.[arg.name] ?? 0
      if (arg.copy) copyData(evalExpr(arg.value), v)
      else assignPlace(arg.value, coerceScalar(arg.value.t!, v as TagValue, placeMaxLen(arg.value)))
    }
    if (impl.ret === null) return 0
    const r = pou.image.home(impl.name)?.[impl.name]
    return r === undefined ? 0 : r
  }

  /** Write a coerced scalar into a place (var, struct field, or array element). */
  function assignPlace(target: Expr, c: TagValue): void {
    if (target.node === 'bit') {
      // one bit of a word: the rest of the word is kept, and the result wraps to the word's own
      // type, so setting bit 31 of a DINT gives the negative number it is
      const word = num(evalScalar(target.obj))
      const mask = 2 ** target.bit
      assignPlace(target.obj, wrap(target.obj.t!, bool(c) ? (word | mask) >>> 0 : (word & ~mask) >>> 0))
      return
    }
    if (target.node === 'var') {
      if (target.ref) {
        const cell = refCell(target)
        put(cell.o, cell.k, c)
        return
      }
      put(store(target.name), target.name, c)
      return
    }
    if (target.node === 'member') {
      const obj = evalExpr(target.obj)
      // THIS.x := ...: a variable of the instance itself
      if (obj instanceof UserFb) put(obj.pou.image.home(target.field)!, target.field, c)
      else if (obj && typeof obj === 'object' && !Array.isArray(obj)) put(obj as Record<string, DataValue>, target.field, c)
      return
    }
    if (target.node === 'index') {
      let cur = evalExpr(target.obj)
      const dims = target.dims ?? []
      for (let k = 0; k < target.indices.length; k++) {
        if (!Array.isArray(cur)) return
        const i = num(evalScalar(target.indices[k]!))
        const d = dims[k]!
        if (i < d.lo || i > d.hi) throw new StFault(FAULT.SUBSCRIPT, `array index ${i} out of bounds [${d.lo}..${d.hi}]`, target.pos)
        if (k === target.indices.length - 1) put(cur as unknown as Record<number, unknown>, i - d.lo, c)
        else cur = cur[i - d.lo]!
      }
    }
  }

  function execStmt(s: Stmt, now: number): void {
    switch (s.node) {
      case 'assign': {
        if (s.copy) {
          // a whole array or struct, copied into the target's own storage rather than rebinding
          // it, so an alias of the target (a VAR_IN_OUT holding it) sees the copy too
          const value = evalExpr(s.value)
          copyData(evalExpr(s.target), value)
          break
        }
        // a subrange place faults on an out-of-bounds store, the same way an array index
        // does - the value is wrong, and a real controller must not carry on with it
        assignPlace(s.target, checkRange(s.target, coerceScalar(s.target.t!, evalScalar(s.value), placeMaxLen(s.target), s.pos), s.pos))
        break
      }
      case 'fbcall': {
        // the instance is found by evaluating its place once, before any argument, so an index
        // out of range faults here exactly as it would on a read
        const fb = evalExpr(s.target)
        if (!isFbInstance(fb)) break
        const a: Record<string, TagValue> = {}
        for (const arg of s.args) if (!arg.out && !arg.inout && !arg.copy && !arg.bind) a[arg.name] = evalScalar(arg.value)
        for (const arg of s.args) {
          if (!(fb instanceof UserFb)) break
          // a whole array or struct input is copied in by value; a VAR_IN_OUT hands the block the
          // caller's own storage instead; a REF_TO input is given the reference, an interface the instance
          if (arg.copy && !arg.out) fb.copyIn(arg.name, evalExpr(arg.value))
          else if (arg.inout) fb.bindInOut(arg.name, evalExpr(arg.value))
          else if (arg.bind) fb.bind(arg.name, arg.bind === 'ref' ? refGiven(arg.value, arg.alias) : instanceOf(arg.value))
        }
        fb.call(a, now)
        // ...and copy a scalar result back, since only aggregates alias on their own
        for (const arg of s.args) {
          if (!arg.inout || !(fb instanceof UserFb)) continue
          const v = fb.readInOut(arg.name)
          if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') assignPlace(arg.value, v)
        }
        // output bindings (`Q => done`) read the member back after the call - they are
        // assignments, so they go through the same place-writing path
        for (const arg of s.args) {
          if (!arg.out) continue
          const v = fb instanceof UserFb ? fb.read(arg.name) : ((fb as unknown as Record<string, TagValue>)[arg.name] ?? 0)
          if (arg.copy) copyData(evalExpr(arg.value), v) // a whole array or struct output, copied out
          else assignPlace(arg.value, coerceScalar(arg.value.t!, v as TagValue, placeMaxLen(arg.value)))
        }
        break
      }
      case 'if': {
        for (const br of s.branches) {
          if (bool(evalScalar(br.cond))) {
            for (const st of br.body) execStmt(st, now)
            return
          }
        }
        if (s.elseBody) for (const st of s.elseBody) execStmt(st, now)
        break
      }
      case 'case': {
        const sel = num(evalScalar(s.selector))
        for (const clause of s.cases) {
          const hit = clause.labels.some((l) =>
            l.kind === 'range' ? sel >= l.lo && sel <= l.hi : sel === l.value,
          )
          if (hit) {
            for (const st of clause.body) execStmt(st, now)
            return
          }
        }
        if (s.elseBody) for (const st of s.elseBody) execStmt(st, now)
        break
      }
      case 'for': {
        // bounds are evaluated once at entry (IEC semantics); the body may read the loop var
        const vt = (env.get(identKey(s.varName)) ?? globals!.env.get(identKey(s.varName)))!.type as ScalarType
        const to = num(evalScalar(s.to))
        const step = s.by ? num(evalScalar(s.by)) : 1
        if (step === 0) throw new StFault(FAULT.WATCHDOG, 'FOR loop step is zero: it would never end', s.pos)
        let count = 0
        for (let i = num(evalScalar(s.from)); step > 0 ? i <= to : i >= to; i += step) {
          store(s.varName)[s.varName] = coerceScalar(vt, i)
          try {
            for (const st of s.body) execStmt(st, now)
          } catch (e) {
            if (e === EXIT_SIGNAL) break
            if (e !== CONTINUE_SIGNAL) throw e // CONTINUE resumes at the next iteration
          }
          if (++count > MAX_LOOP_ITERATIONS) throw new StFault(FAULT.WATCHDOG, 'FOR loop exceeded its iteration limit', s.pos)
        }
        break
      }
      case 'while': {
        let count = 0
        while (bool(evalScalar(s.cond))) {
          try {
            for (const st of s.body) execStmt(st, now)
          } catch (e) {
            if (e === EXIT_SIGNAL) break
            if (e !== CONTINUE_SIGNAL) throw e // CONTINUE resumes at the next iteration
          }
          if (++count > MAX_LOOP_ITERATIONS) throw new StFault(FAULT.WATCHDOG, 'WHILE loop exceeded its iteration limit', s.pos)
        }
        break
      }
      case 'repeat': {
        let count = 0
        for (;;) {
          let exited = false
          try {
            for (const st of s.body) execStmt(st, now)
          } catch (e) {
            if (e === EXIT_SIGNAL) exited = true
            else if (e !== CONTINUE_SIGNAL) throw e // CONTINUE falls through to the UNTIL test
          }
          if (exited || bool(evalScalar(s.cond))) break
          if (++count > MAX_LOOP_ITERATIONS) throw new StFault(FAULT.WATCHDOG, 'REPEAT loop exceeded its iteration limit', s.pos)
        }
        break
      }
      case 'exit':
        throw EXIT_SIGNAL
      case 'invoke':
        callMethod(s.call, now)
        break
      case 'bind': {
        // the value first, then the slot (an element's subscript), as an assignment evaluates them
        const v = s.source === null ? 0 : s.kind === 'iface' ? instanceOf(s.source) : refGiven(s.source, s.alias)
        const at = slotOf(s.target)
        at.o[at.k] = v
        break
      }
      case 'continue':
        throw CONTINUE_SIGNAL
      case 'return':
        throw RETURN_SIGNAL
    }
  }

  // A declaration holding a function-block instance anywhere inside it (the instance itself, an
  // array of them, a struct with one in a field) carries state: it is built once, below, and
  // never touched by resetVars(), which only re-zeroes plain data.
  const stateful = new Set(decls.filter((d) => containsFb(d.type, structDefs)))
  const plainDecls = decls.filter((d) => !stateful.has(d))

  /** (Re-)initialise the variable image (declaration order; scalar inits are constant
   *  expressions). FB instances are untouched - their state persists across resets. */
  // An initial value built only from literals and enumeration members is the same every time, so it is evaluated once
  // and kept: a FUNCTION resets on every call, and re-evaluating its initialisers was much of what a call cost. One
  // that reads a variable (the checker allows it, and a global can change between resets) is evaluated every time.
  // A scalar with no initialiser starts at its type's zero, decided once too.
  const scalarInits = new Map<Decl, TagValue>()
  const scalarInit = (d: Decl): TagValue => {
    const cached = scalarInits.get(d)
    if (cached !== undefined) return cached
    const v = d.init ? coerceScalar(d.type as ScalarType, evalScalar(d.init), d.maxLen) : (zeroData(d.type, structDefs, enumDefs, NO_FB) as TagValue)
    if (!d.init || isLiteralInit(d.init)) scalarInits.set(d, v)
    return v
  }
  // which declarations are scalars, decided once rather than on every reset
  const scalarDecls = new Set(plainDecls.filter((d) => isScalarType(d.type)))
  function resetVars(): void {
    for (const d of plainDecls) {
      const rec = own(d.name)
      if (scalarDecls.has(d)) start(rec, d.name, scalarInit(d))
      // an enumeration is an integer at runtime, and its declared starting value is honoured like
      // any other (it once fell through to the zero value, the first member)
      else if (isEnum(d.type) && d.init) rec[d.name] = coerceScalar('INT', evalScalar(d.init))
      else rec[d.name] = zeroData(d.type, structDefs, enumDefs, NO_FB)
      // an ARRAY [...] or STRUCT (field := ...) initializer is written into the zeroed value, an
      // array's row-major; the checker has already proved every count and every type
      if (d.arrayInit && isArray(d.type)) initArray(rec[d.name] as DataValue[], d.arrayInit, d.type)
      if (d.structInit && isStruct(d.type)) initStruct(rec[d.name] as Record<string, DataValue>, d.structInit, d.type)
    }
  }

  /** The value an initial value gives a place of type `t`, which already holds its zero: a coerced
   *  scalar, or the struct or array itself, written into in place. */
  function initValue(current: DataValue, v: Initializer, t: DataType, maxLen: number | undefined): DataValue {
    if (v.node === 'structInit' && isUserFb(t)) return initFb(current, v, t)
    if (v.node === 'structInit') return initStruct(current as Record<string, DataValue>, v, t as StructRef)
    if (v.node === 'arrayInit') return initArray(current as DataValue[], v.items, t as ArrayType)
    if (isEnum(t)) return coerceScalar('INT', evalScalar(v)) // an enumeration is an integer at runtime
    return coerceScalar(t as ScalarType, evalScalar(v), maxLen)
  }

  function initStruct(rec: Record<string, DataValue>, init: StructInit, st: StructRef): Record<string, DataValue> {
    const fields = structDefs.get(identKey(st.struct))?.fields ?? []
    for (const f of init.fields) {
      const field = fields.find((x) => x.name === f.name)
      if (field) start(rec, f.name, initValue(rec[f.name]!, f.value, field.type, field.maxLen))
    }
    return rec
  }

  /** An instance's own starting values, written over what its block declares (the checker proved each name). */
  function initFb(inst: DataValue, init: StructInit, ref: UserFbRef): DataValue {
    const members = fbDefs.get(identKey(ref.fb))?.decls ?? []
    for (const f of init.fields) {
      const m = members.find((x) => x.name === f.name)
      if (m && inst instanceof UserFb) inst.start(m.name, (current) => initValue(current, f.value, m.type, m.maxLen))
    }
    return inst
  }

  /** Items land in row-major order: the innermost dimension's slots, walked outer to inner. */
  function initArray(arr: DataValue[], items: Initializer[], at: ArrayType): DataValue[] {
    const slots: [DataValue[], number][] = []
    const walk = (a: DataValue[], depth: number): void => {
      for (let k = 0; k < a.length; k++) {
        if (depth < at.dims.length - 1) walk(a[k] as DataValue[], depth + 1)
        else slots.push([a, k])
      }
    }
    walk(arr, 0)
    items.forEach((item, i) => {
      const slot = slots[i]
      if (slot) start(slot[0] as unknown as Record<number, unknown>, slot[1], initValue(slot[0][slot[1]]!, item, at.elem, at.elemMaxLen))
    })
    return arr
  }

  if (!adopt) for (const d of stateful) {
    const mkFb: FbFactory = (t) => (isFb(t) ? makeFb(t) : instantiate(t.fb, fbDefs, funcs, structDefs, enumDefs, stack, d.pos, globals))
    const rec = own(d.name)
    rec[d.name] = zeroData(d.type, structDefs, enumDefs, mkFb)
    // a struct holding an instance can still start its plain fields from an initializer
    if (d.structInit && isStruct(d.type)) initStruct(rec[d.name] as Record<string, DataValue>, d.structInit, d.type)
    if (d.structInit && isUserFb(d.type)) initFb(rec[d.name]!, d.structInit, d.type)
    if (d.arrayInit && isArray(d.type)) initArray(rec[d.name] as DataValue[], d.arrayInit, d.type)
  }
  if (!adopt) resetVars()

  /** what the watch walks this image's aggregates by: its own declarations' types */
  const ownTypes: WatchTypes = { typeOf: (n) => env.get(identKey(n))?.type, structs: structDefs }
  // setArg's setters, by argument spelling: resolved on a block's first call, kept for its life (the records they write
  // into, this POU's own and the globals', are never replaced)
  const argSetters = new Map<string, (v: TagValue) => void>()
  /** `name`'s setter for setArg and port: setInput's plain-name path, decided once - which declaration, which record,
   *  which coercion. A name that is not a plain identifier (a struct field, an element, a bit) keeps setInput's path. */
  const setterFor = (name: string, pou: Pou): ((v: TagValue) => void) => {
    let set = argSetters.get(name)
    if (set) return set
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    const d = plain ? (env.get(identKey(name)) ?? globals?.env.get(identKey(name))) : undefined
    if (!d) set = plain ? () => {} : (v: TagValue) => pou.setInput(name, v)
    else if (d.constant) set = () => {}
    else {
      const rec = store(d.name)
      const key = d.name
      const t = d.type
      if (isScalarType(t)) {
        // coercerFor is coerceScalar with the type's branch taken now (the same rounding, overflow fault, width)
        const coerce = coercerFor(t, d.maxLen, undefined)
        set = (v: TagValue) => put(rec, key, coerce(v))
      } else if (isEnum(t)) {
        set = (v: TagValue) => {
          rec[key] = wrap('INT', num(v))
        }
      } else set = () => {}
    }
    argSetters.set(name, set)
    return set
  }

  return {
    image: img,
    scan(now: number): void {
      currentNow = now
      try {
        for (const s of body) execStmt(s, now)
      } catch (e) {
        if (e !== RETURN_SIGNAL) throw e // RETURN ends this POU's scan, nothing more
      }
    },
    reset: resetVars,
    // the external tag surface resolves case-insensitively too, so a hand-typed binding
    // matches the declaration whatever case it was written in
    setInput(name: string, value: TagValue): void {
      // `Motor1.Run`: a field of a struct (UDT) tag, the way the watch table lists it and a rung's toggle names it
      // and an element, all the way down: `Line[1].Zones[0].Full`, or one bit of a word, `Drive.Status.5`
      const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(name)?.[0] ?? ''
      if (head !== '' && head.length < name.length) {
        const root = env.get(identKey(head)) ?? globals?.env.get(identKey(head))
        if (!root || root.constant) return
        // walked as (holder, key, type), so the last step can write where it stands
        let holder: Record<string, unknown> | unknown[] = store(root.name)
        let key: string | number = root.name
        let type: DataType | undefined = root.type
        const steps = name.slice(head.length).match(/\.[A-Za-z_][A-Za-z0-9_]*|\.[0-9]+|\[[^\]]*\]/g) ?? []
        if (steps.join('') !== name.slice(head.length)) return
        for (let s = 0; s < steps.length; s++) {
          const step = steps[s]!
          const cur: unknown = (holder as Record<string | number, unknown>)[key]
          if (/^\.[0-9]/.test(step)) {
            // a bit: only ever the last step, and only of an integer
            if (s !== steps.length - 1 || typeof cur !== 'number' || !type || !isScalarType(type) || !isInt(type)) return
            const mask = 2 ** Number(step.slice(1))
            ;(holder as Record<string | number, unknown>)[key] = wrap(type, bool(value) ? (cur | mask) >>> 0 : (cur & ~mask) >>> 0)
            return
          }
          if (step.startsWith('[')) {
            if (!type || !isArray(type)) return
            const at = step.slice(1, -1).split(',').map((x) => Number(x.trim()))
            if (at.length !== type.dims.length) return
            let arr: unknown = cur
            for (let k = 0; k < at.length; k++) {
              const d = type.dims[k]!
              if (!Array.isArray(arr) || !Number.isInteger(at[k]) || at[k]! < d.lo || at[k]! > d.hi) return
              holder = arr
              key = at[k]! - d.lo
              arr = arr[key]
            }
            type = type.elem
            continue
          }
          if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || isFbInstance(cur as DataValue)) return
          const field = Object.keys(cur).find((f) => identKey(f) === identKey(step.slice(1)))
          if (field === undefined) return
          const inType: DataType | undefined = type
          type = inType && isStruct(inType) ? structDefs.get(identKey(inType.struct))?.fields.find((f) => f.name === field)?.type : undefined
          holder = cur as Record<string, unknown>
          key = field
        }
        const cur = (holder as Record<string | number, unknown>)[key]
        // typed by what is there: a BOOL takes a truth, a number a number (at its own width), a STRING text
        put(holder as Record<string | number, unknown>, key, typeof cur === 'boolean' ? Boolean(value) : typeof cur === 'number' ? (type && isScalarType(type) ? coerceScalar(type, value) : num(value)) : typeof cur === 'string' ? String(value) : cur)
        return
      }
      const d = env.get(identKey(name)) ?? globals?.env.get(identKey(name))
      if (!d || d.constant) return
      if (isScalarType(d.type)) put(store(d.name), d.name, coerceScalar(d.type, value, d.maxLen))
      // an enum variable is an integer at runtime, so a scene tag can drive it
      else if (isEnum(d.type)) store(d.name)[d.name] = wrap('INT', num(value))
    },
    setArg(name: string, value: TagValue): void {
      setterFor(name, this)(value)
    },
    port(name: string): TagPort {
      const set = setterFor(name, this)
      const d = env.get(identKey(name)) ?? globals?.env.get(identKey(name))
      if (d) {
        // get's answer with the record and key decided now: a declared name never moves (its chunk is fixed)
        const rec = store(d.name)
        const key = d.name
        return { set, get: () => tagOf(rec[key]) }
      }
      return { set, get: () => tagOf(img.home(name)?.[name]) }
    },
    get(name: string): TagValue | undefined {
      const d = env.get(identKey(name)) ?? globals?.env.get(identKey(name))
      if (d && designates(d.type)) return undefined
      const v = d ? store(d.name)[d.name] : img.home(name)?.[name]
      return isTagValue(v) ? v : undefined
    },
    varInfo(name: string): VarInfo | undefined {
      const d = env.get(identKey(name)) ?? globals?.env.get(identKey(name))
      if (!d || d.hidden) return undefined
      const type = isScalarType(d.type) ? d.type : isEnum(d.type) ? 'ENUM' : null
      if (type === null) return undefined
      return { type, constant: d.constant === true, ...(d.location ? { location: d.location } : {}) }
    },
    typeOf(name: string): DataType | undefined {
      return env.get(identKey(name))?.type
    },
    outputs(): [string, TagValue][] {
      const out: [string, TagValue][] = []
      for (const d of decls) {
        if (d.section === 'VAR_OUTPUT' && isScalarType(d.type)) {
          const v = own(d.name)[d.name]
          out.push([d.name, isTagValue(v) ? v : d.type === 'STRING' ? '' : 0])
        }
      }
      return out
    },
    watchInto(out: Record<string, TagValue>, prefix: string, maxArray: number): void {
      for (const c of img.chunks) watchScalars(out, c, prefix, ownTypes, maxArray)
    },
    blocksInto(out: Record<string, TagValue>, prefix: string): void {
      for (const c of img.chunks) watchBlocks(out, c, prefix, ownTypes)
    },
    typesInto(out: Record<string, string>, prefix: string): void {
      for (const c of img.chunks) scalarTypes(out, c, prefix, ownTypes)
      for (const c of img.chunks) blockTypes(out, c, prefix, ownTypes)
    },
    deepInto(out: Record<string, TagValue>, prefix: string): void {
      for (const d of decls) {
        // a whole-array or struct VAR_IN_OUT holds the caller's storage: listed where the caller holds it
        if (d.section === 'VAR_IN_OUT' && !isScalarType(d.type) && !isEnum(d.type)) continue
        if (designates(d.type)) continue // so does a REF_TO, and an interface designates an instance held elsewhere
        deepValue(out, `${prefix}${d.name}`, own(d.name)[d.name], d.type, structDefs)
      }
    },
  }
}

export function compile(source: string): CompiledProgram {
  const { ast, fbDefs, funcDefs, structDefs, enumDefs } = parseAndCheck(source)
  // the typed engine (docs/plc-typed-storage.md): the program in one arena - or refused whole (TypedUnsupported), and
  // then built on the walker below
  if (scanEngine === 'typed') {
    try {
      return compileTyped(ast, fbDefs, funcDefs, structDefs, enumDefs, internals())
    } catch (e) {
      if (!(e instanceof TypedUnsupported)) throw e
      if (typedRefusals.length === 0) console.warn(`PLC: ${e.message}, so the program runs on the much slower reference engine`)
      if (typedRefusals.length < 16) typedRefusals.push(e.message)
    }
  }

  // One VAR_GLOBAL image for the whole program, built before any POU so every POU - the
  // main body, function blocks, functions - reads and writes the same storage. Built as a
  // body-less POU so globals get the same initialiser handling as any other declaration, and
  // built into the store's own record with the store passed along: a global user block's body
  // reads other globals, so it must be handed the store it is itself being built into. Beside a
  // CONFIGURATION the controller's tags live in the same image: they are globals, with a direction.
  const shared = [...ast.globals, ...controllerTags(ast)]
  let globals: GlobalStore | null = null
  let globalPou: RecordPou | null = null
  if (shared.length) {
    globals = { env: new Map(shared.map((d) => [identKey(d.name), d])), image: makeImage(shared, recordFields(shared, structDefs)) }
    globalPou = buildPou(shared, [], fbDefs, funcDefs, structDefs, enumDefs, [], globals, globals.image)
  }
  const build: PouBuilder = (decls, body) => buildPou(decls, body, fbDefs, funcDefs, structDefs, enumDefs, [], globals)
  return ast.configuration
    ? configuredProgram(ast, build, globalPou)
    : // a lone PROGRAM with no CONFIGURATION is the implicit program, under its own name
      implicitProgram(ast.programDefs[0] ?? { decls: ast.decls, body: ast.body }, build, globalPou, ast.globals)
}

/** What the watch needs to know to walk an aggregate: each variable's declared type, and the structs. */
interface WatchTypes {
  typeOf: (name: string) => DataType | undefined
  structs: StructDefMap
}

/** An image's scalars, into a watch table under `prefix`: plain tags, a UDT tag's members
 *  (`M1.Run`), an array's elements (`Counts[2]`, `Zones[1].Full`). Instances are watchBlocks'. */
function watchScalars(out: Record<string, TagValue>, image: Record<string, DataValue>, prefix: string, types?: WatchTypes, max = WATCH_ARRAY_MAX): void {
  for (const leaf of watchPlan(image, prefix, types, max)) {
    let v: unknown = image
    for (const step of leaf.path) v = (v as Record<string | number, unknown> | undefined)?.[step]
    if (isTagValue(v as DataValue)) out[leaf.key] = v as TagValue
  }
}

/** Where every scalar of an image is (see watchScalars), planned once per image, prefix and array cap. */
function watchPlan(image: Record<string, DataValue>, prefix: string, types: WatchTypes | undefined, max: number): readonly WatchLeaf[] {
  // The shape of an image never changes once a program is compiled (which names it holds, how long its arrays are,
  // what its structures are made of); only the values do. So the walk that finds every scalar (`planValue`: an array
  // element, a UDT member, a member of an element...) is done once, into a list of where each one is, and a table
  // after that is one read per value. Walking it afresh each time costs more than the scan itself on a large program:
  // ~5,000 values took 2.9 ms to list, against 0.56 ms to scan. The host reads it after every scan, two hundred times
  // a second, which measured at two thirds of the step budget with nothing else running (phys 2.8 ms of 4.17, of
  // which physics was 0.1).
  let plans = watchPlans.get(image)
  if (!plans) watchPlans.set(image, (plans = new Map()))
  let plan = plans.get(max)
  const names = Object.keys(image)
  if (!plan || plan.prefix !== prefix || plan.names !== names.length) {
    const leaves: WatchLeaf[] = []
    for (const k of names) planValue(leaves, `${prefix}${k}`, [k], image[k]!, types?.typeOf(k), types?.structs, max)
    plans.set(max, (plan = { prefix, names: names.length, leaves }))
  }
  return plan.leaves
}

/** The declared scalar type of each of an image's `memory` keys, as `memoryTypes` reports it (an enumeration is 'ENUM'). */
function scalarTypes(out: Record<string, string>, image: Record<string, DataValue>, prefix: string, types: WatchTypes): void {
  for (const leaf of watchPlan(image, prefix, types, Infinity)) {
    const t = leaf.type
    if (t !== undefined && isScalarType(t)) out[leaf.key] = t
    else if (t !== undefined && isEnum(t)) out[leaf.key] = 'ENUM'
  }
}

/** watchBlocks' keys, typed: a standard block's outputs by its type, a user block's by its declarations. */
function blockTypes(out: Record<string, string>, image: Record<string, DataValue>, prefix: string, types: WatchTypes): void {
  for (const [inst, fb] of Object.entries(image)) {
    if (designates(types.typeOf(inst))) continue
    if (fb instanceof UserFb) {
      for (const [m] of fb.outputs()) {
        const t = fb.typeOf(m)
        if (t !== undefined && isScalarType(t)) out[`${prefix}${inst}.${m}`] = t
      }
    } else if (isFbInstance(fb)) {
      const t = types.typeOf(inst)
      if (t === undefined || !isFb(t)) continue
      for (const member of Object.keys(fb as unknown as Record<string, unknown>)) {
        const mt = fbMemberType(t, member)
        if (mt) out[`${prefix}${inst}.${member}`] = mt
      }
    }
  }
}

/** Where one scalar of an image is: the key the table lists it under, and the steps down to it from the image. */
interface WatchLeaf {
  key: string
  path: (string | number)[]
  /** the declared type of the place (undefined when the walk could not tell): what `memoryTypes` reports */
  type: DataType | undefined
}
/** (per image, and per how large an array may be and still be listed: the watch table's cap, or none - `memory`) */
const watchPlans = new WeakMap<object, Map<number, { prefix: string; names: number; leaves: WatchLeaf[] }>>()

/** Where the scalars under `key` are: a scalar as itself, a struct's scalar fields as `key.field` (nested structs
 *  too), an array's elements keyed the way they are written - `A[3]`, `M[1,2]`, which takes the declared bounds - so
 *  a UDT tag's members and an array's elements show in the watch table and light a rung the way plain tags do.
 *  Function blocks are watchBlocks' business. (A place holding no value yet is kept as a leaf - it may hold one
 *  later - and lists nothing until it does.) */
function planValue(leaves: WatchLeaf[], key: string, path: (string | number)[], v: DataValue, t: DataType | undefined, structs: StructDefMap | undefined, max: number): void {
  if (designates(t)) return // a REF_TO or an interface holds no value of its own
  if (isTagValue(v) || v === undefined || v === null) leaves.push({ key, path, type: t })
  else if (Array.isArray(v)) {
    if (!t || !isArray(t) || t.dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1) > max) return
    const walk = (cur: DataValue, k: number, at: number[], steps: (string | number)[]): void => {
      if (k === t.dims.length) return planValue(leaves, `${key}[${at.join(',')}]`, steps, cur, t.elem, structs, max)
      if (Array.isArray(cur)) cur.forEach((x, i) => walk(x, k + 1, [...at, i + t.dims[k]!.lo], [...steps, i]))
    }
    walk(v, 0, [], path)
  } else if (typeof v === 'object' && !isFbInstance(v)) {
    const fields = t && isStruct(t) ? structs?.get(identKey(t.struct))?.fields : undefined
    for (const [f, fv] of Object.entries(v)) planValue(leaves, `${key}.${f}`, [...path, f], fv, fields?.find((x) => x.name === f)?.type, structs, max)
  }
}

/** Every scalar under `key` (deepMemory): planValue's keys, and through function block instances too. */
function deepValue(out: Record<string, TagValue>, key: string, v: DataValue | undefined, t: DataType | undefined, structs: StructDefMap): void {
  if (designates(t)) return // a REF_TO or an interface (an element of an array of them too) designates; it holds nothing
  if (isTagValue(v)) out[key] = v
  else if (v instanceof UserFb) v.deepInto(out, `${key}.`)
  else if (isFbInstance(v)) {
    const rec = v as unknown as Record<string, unknown>
    for (const m of Object.keys(rec)) if (isTagValue(rec[m])) out[`${key}.${m}`] = rec[m] as TagValue
  } else if (Array.isArray(v)) {
    if (!t || !isArray(t)) return
    const walk = (cur: DataValue, k: number, at: number[]): void => {
      if (k === t.dims.length) return deepValue(out, `${key}[${at.join(',')}]`, cur, t.elem, structs)
      if (Array.isArray(cur)) cur.forEach((x, i) => walk(x, k + 1, [...at, i + t.dims[k]!.lo]))
    }
    walk(v, 0, [])
  } else if (v && typeof v === 'object') {
    const fields = t && isStruct(t) ? structs.get(identKey(t.struct))?.fields : undefined
    for (const [f, fv] of Object.entries(v)) deepValue(out, `${key}.${f}`, fv, fields?.find((x) => x.name === f)?.type, structs)
  }
}

/** Each function block's outputs in an image, keyed `inst.member` under `prefix`. Builtin FBs expose
 *  Q/ET/CV as enumerable props; user FBs their scalar VAR_OUTPUTs. */
function watchBlocks(out: Record<string, TagValue>, image: Record<string, DataValue>, prefix: string, types?: WatchTypes): void {
  for (const [inst, fb] of Object.entries(image)) {
    if (designates(types?.typeOf(inst))) continue // an interface designates an instance; it is not one
    if (fb instanceof UserFb) {
      for (const [m, v] of fb.outputs()) out[`${prefix}${inst}.${m}`] = v
    } else if (isFbInstance(fb)) {
      const rec = fb as unknown as Record<string, unknown>
      for (const member of Object.keys(rec)) {
        const v = rec[member]
        if (isTagValue(v)) out[`${prefix}${inst}.${member}`] = v
      }
    }
  }
}

/** A REF_TO or an interface: a variable that designates a place or an instance rather than holding a value. */
function designates(t: DataType | undefined): boolean {
  return t !== undefined && (isRef(t) || isInterface(t))
}

function eq(l: TagValue, r: TagValue): boolean {
  return typeof l === 'boolean' || typeof r === 'boolean' ? bool(l) === bool(r) : l === r
}
