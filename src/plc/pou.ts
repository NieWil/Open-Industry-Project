// What every scan engine's POU is to the rest of the engine, and what is built on top of it whichever engine it is: the
// Pou interface (a runnable program, function block or function instance, answering by name), the store rules a value
// obeys on its way into any place, and the two program shapes (`implicitProgram`, `configuredProgram`) that turn POUs
// into the CompiledProgram a host drives. The walker's POU keeps its variables in JS records (interpreter.ts); the
// typed engine's in one typed arena (typed/). Neither shape is visible from here: the builders ask a Pou, never its
// storage, which is what lets both engines share them (docs/plc-typed-storage.md).

import { canonicalAddress } from '../core/io/iecAddress'
import type { WatchRange } from '../core/watchTable'
import { controllerTags, identKey, isScalarType, passOrder, taskTable } from './program'
import { bool, isInt, isString, nsOf, num, roundEven, str, strLimit, wrap } from './runtime'
import type { Ast, CompiledProgram, DataType, Decl, Expr, ScalarType, SourcePos, Stmt, TagPort, TagValue, VarInfo, WatchPlan } from './types'
import { isEnum, StError } from './types'

/** A scalar value in the variable image, as opposed to an aggregate (array/struct record).
 *  Every surface that flattens the image - the watch table, `get`, `outputs` - filters on
 *  this, so STRING had to land here for string variables to be visible at all. */
/** a stored value as get answers it: a scalar, or undefined for an aggregate or nothing */
export const tagOf = (v: unknown): TagValue | undefined => (isTagValue(v) ? v : undefined)

export function isTagValue(v: unknown): v is TagValue {
  return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string'
}

/** Where one watch value is in a typed program's memory, and how it is stored (core/watchTable.ts WATCH_KIND). */
export interface WatchPlace {
  addr: number
  kind: number
}

/** CompiledProgram.watchPlan: the watch table as places in the program's memory, in the table's own order. A key
 *  listed twice keeps its first position and its last place, as an object assigned twice does. Null when a POU keeps
 *  its variables elsewhere (the walker). */
export function planWatch(steps: readonly { pou: Pou | null; prefix: string; blocks: boolean }[]): WatchPlan | null {
  const places = new Map<string, WatchPlace>()
  // The arrays over the cap, by key without case. Two POUs listed under one prefix (a program and its globals) may
  // declare the same name, and one name is one variable to a reader. An earlier POU's range goes when a later one
  // declares the name, so a local's index out of its bounds does not read the global. A range is not added when an
  // earlier POU declares the name, since that one's elements may be listed and the array would read as a mix of the two.
  const ranges = new Map<string, WatchRange>()
  const earlier: { pou: Pou; prefix: string }[] = []
  const variableOf = (key: string, prefix: string): string => key.slice(prefix.length).split(/[.[]/)[0]!
  let buffer: ArrayBuffer | null = null
  for (const s of steps) {
    if (!s.pou) continue
    if (!s.pou.placesInto) return null
    buffer = s.pou.placesInto(places, s.prefix, WATCH_ARRAY_MAX, s.blocks)
    if (s.blocks) continue
    const pou = s.pou
    const same = earlier.filter((e) => e.prefix === s.prefix)
    // (the names whose earlier variable was itself a range: nothing of it is listed, so the later one's is taken)
    const replaced = new Set<string>()
    if (same.length > 0) {
      for (const [k, r] of ranges) {
        const name = variableOf(r.key, s.prefix)
        if (!r.key.startsWith(s.prefix) || pou.typeOf(name) === undefined) continue
        ranges.delete(k)
        replaced.add(name.toUpperCase())
      }
    }
    const found: WatchRange[] = []
    pou.rangesInto?.(found, s.prefix, WATCH_ARRAY_MAX)
    for (const r of found) {
      const name = variableOf(r.key, s.prefix)
      if (replaced.has(name.toUpperCase()) || !same.some((e) => e.pou.typeOf(name) !== undefined)) ranges.set(r.key.toUpperCase(), r)
    }
    earlier.push({ pou, prefix: s.prefix })
  }
  if (!buffer) return null
  const keys = [...places.keys()]
  const addrs = new Uint32Array(keys.length)
  const kinds = new Uint8Array(keys.length)
  let i = 0
  for (const p of places.values()) {
    addrs[i] = p.addr
    kinds[i++] = p.kind
  }
  return { layout: { keys, addrs, kinds, ...(ranges.size > 0 ? { ranges: [...ranges.values()] } : {}) }, memory: buffer }
}

/** A runnable POU: its own variable image, function-block instances included, and a body to scan. */
export interface Pou {
  /** run the body once; `now` is the controller's clock (ns), which its timers read */
  scan(now: number): void
  setInput(name: string, value: TagValue): void
  /** setInput for a function-block call's argument: a plain declared name, so its setter is resolved once and kept */
  setArg(name: string, value: TagValue): void
  get(name: string): TagValue | undefined
  /** `name`'s setInput and get, resolved once (CompiledProgram.port) */
  port(name: string): TagPort
  /** what a variable of this POU (or a global it sees) is, by name */
  varInfo(name: string): VarInfo | undefined
  /** the declared type of one of its variables (its own, not a global), for the watch table */
  typeOf(name: string): DataType | undefined
  /** [name, value] for each scalar VAR_OUTPUT, for member reads / the watch table */
  outputs(): [string, TagValue][]
  /** re-initialise the variable image (FB instances keep their state) - lets a cached
   *  function POU start each invocation from declared/zero values */
  reset(): void
  /** its own scalars into a watch table under `prefix` (struct members, array elements up to `maxArray` long);
   *  function-block outputs are blocksInto's */
  watchInto(out: Record<string, TagValue>, prefix: string, maxArray: number): void
  /** its function-block instances' outputs, keyed `inst.member` under `prefix` */
  blocksInto(out: Record<string, TagValue>, prefix: string): void
  /** Where watchInto's and blocksInto's values are, when its memory is one buffer (the typed engine's): each key's
   *  address and kind into `out`, in the order the two list them, and the buffer. Absent on the walker. */
  placesInto?(out: Map<string, WatchPlace>, prefix: string, maxArray: number, blocks: boolean): ArrayBuffer
  /** The arrays placesInto leaves out for being longer than `maxArray`, each with its shape: a table read from a copy
   *  of the buffer answers their elements by name (core/watchTable.ts). */
  rangesInto?(out: WatchRange[], prefix: string, maxArray: number): void
  /** the declared scalar type of each key memory lists for it (CompiledProgram.memoryTypes) */
  typesInto(out: Record<string, string>, prefix: string): void
  /** Every scalar it holds (CompiledProgram.deepMemory): what memory lists, and inside every function block instance
   *  too - a user block's own variables, nested and in arrays (`T[2].Run.n`), a standard block's outputs. A whole-array
   *  or struct VAR_IN_OUT is the caller's storage, listed where the caller holds it, so not here. */
  deepInto(out: Record<string, TagValue>, prefix: string): void
}

// ---- the scalar store rules both scan engines share (they read nothing of a POU's own) ----

/** `kept` is what `exact` became on its way into a `t`: an integer that did not fit is cut to the width, as it always
 *  was. The one place both engines pass an integer result through (a hook for reporting an overflow; none is raised). */
export function fits(_t: ScalarType, _exact: number, kept: number, _pos: SourcePos | undefined): number {
  return kept
}

export function coerceScalar(type: ScalarType, v: TagValue, maxLen?: number, pos?: SourcePos): TagValue {
  if (type === 'BOOL') return bool(v)
  // a STRING store truncates to the place's declared capacity - silently, the way
  // MATIEC does it. Over-long text is lost, not faulted.
  if (isString(type)) return strLimit(str(v), maxLen)
  // a fractional value narrowing into an integer rounds ties-to-even, exactly like an
  // explicit REAL_TO_INT - the two spellings of the same conversion must agree
  if (isInt(type)) {
    const exact = roundEven(num(v))
    return fits(type, exact, wrap(type, exact), pos)
  }
  return wrap(type, num(v)) // REAL narrows to f32; LREAL passes through
}

/** The declared STRING capacity of a place, when it has one. */
export function placeMaxLen(target: Expr): number | undefined {
  return target.node === 'var' || target.node === 'member' || target.node === 'index' ? target.maxLen : undefined
}

/** Enforce a subrange place's declared bounds, or pass the value straight through. */
export function checkRange(target: Expr, v: TagValue, pos: SourcePos): TagValue {
  const r = target.node === 'var' || target.node === 'member' || target.node === 'index' ? target.range : undefined
  if (r && (num(v) < r.lo || num(v) > r.hi)) {
    throw new StError(`${num(v)} is outside ${r.name} (${r.lo}..${r.hi})`, pos)
  }
  return v
}

/** One integer type's width, decided once (runtime.ts `wrap`, case for case; the oracle holds the two together). */
export function widthOf(t: ScalarType): (x: number) => number {
  switch (t) {
    case 'SINT': return (x) => (x << 24) >> 24
    case 'INT': return (x) => (x << 16) >> 16
    case 'DINT': return (x) => x | 0
    case 'USINT': case 'BYTE': return (x) => x & 0xff
    case 'UINT': case 'WORD': return (x) => x & 0xffff
    case 'UDINT': case 'DWORD': return (x) => x >>> 0
    default: return (x) => x
  }
}

/** coerceScalar for one place, with the type's branch taken at compile time: a store is the hottest thing a scan does. */
export function coercerFor(type: ScalarType, maxLen: number | undefined, _pos: SourcePos | undefined): (v: TagValue) => TagValue {
  if (type === 'BOOL') return bool
  if (isString(type)) return (v) => strLimit(str(v), maxLen)
  if (isInt(type)) {
    const w = widthOf(type)
    return (v) => {
      const n = typeof v === 'number' ? v : num(v)
      return w(Number.isInteger(n) ? n : roundEven(n))
    }
  }
  if (type === 'REAL') return (v) => Math.fround(typeof v === 'number' ? v : num(v))
  return (v) => wrap(type, num(v))
}

/** An array bigger than this is left out of the watch table's keys: a table that travels as an object is built and
 *  cloned on every send, and every reader that indexes the keys pays for each one. A 2000-element array of UDTs
 *  would be tens of thousands of values. Its elements are read by name instead, where the table is a copy of the
 *  program's memory (planWatch's ranges). A table that travels as an object (the walker's, several controllers') does
 *  not hold them. */
export const WATCH_ARRAY_MAX = 512


export type PouBuilder = (decls: Decl[], body: Stmt[]) => Pou

/** A located variable on the tag surface: reached by its address, whichever POU holds it. */
interface LocatedBinding {
  address: string
  dir: 'input' | 'output'
  pou: Pou
  name: string
}

/**
 * The located I/O variables of a program, keyed by canonical address. The checker has already made each
 * address unique (checker.ts, checkLocated), so this only records where each one lives. A memory address
 * (%M) is storage the program keeps, not a point the scene or an external controller reaches, so it is
 * left out: it is read and written by name, like any variable.
 */
function locatedBindings(holders: { pou: Pou | null; decls: readonly Decl[] }[]): Map<string, LocatedBinding> {
  const out = new Map<string, LocatedBinding>()
  for (const { pou, decls } of holders) {
    if (!pou) continue
    for (const d of decls) {
      if (d.location === undefined || d.location.startsWith('%M')) continue
      out.set(d.location, { address: d.location, dir: d.location.startsWith('%Q') ? 'output' : 'input', pou, name: d.name })
    }
  }
  return out
}

/** The binding a tag key names, when the key is a direct address (in any spelling of it). */
function locatedFor(bindings: Map<string, LocatedBinding>, key: string): LocatedBinding | undefined {
  if (bindings.size === 0 || !key.startsWith('%')) return undefined
  return bindings.get(canonicalAddress(key) ?? key.toUpperCase())
}

const locatedKeys = (bindings: Map<string, LocatedBinding>, dir: LocatedBinding['dir']): string[] =>
  [...bindings.values()].filter((b) => b.dir === dir).map((b) => b.address)

/**
 * The bindable tag surface, which is narrower than "every I/O declaration". An enum counts (it is
 * an integer at runtime, so a scene tag drives it); a STRING does not - nothing in the scene
 * produces or consumes text, so listing one here would only make the device-IO check report it as
 * an unbound tag no part could ever wire. A STRING VAR_INPUT/VAR_OUTPUT is still an ordinary
 * variable, visible in the watch table.
 */
function tagged(d: Decl): boolean {
  return (isScalarType(d.type) && d.type !== 'STRING') || isEnum(d.type)
}

/**
 * A variable a scene part may bind by wiring rather than by declaration: an ordinary VAR (or a global)
 * holding one bit or number. A constant cannot be written, and a located variable is bound by its
 * address instead, so neither is one.
 */
function wireable(d: Decl): boolean {
  return (d.section === 'VAR' || d.section === 'VAR_GLOBAL') && !d.constant && !d.location && !d.hidden && tagged(d)
}

/** A program with no CONFIGURATION: one program, no tasks, its variables under their bare names, and its
 *  located variables under their addresses. */
export function implicitProgram(main: { decls: Decl[]; body: Stmt[] }, build: PouBuilder, globalPou: Pou | null, globalDecls: readonly Decl[]): CompiledProgram {
  const pou = build(main.decls, main.body)
  const located = locatedBindings([
    { pou: globalPou, decls: globalDecls },
    { pou, decls: main.decls },
  ])
  /** the controller's clock (ns): every scan moves it on by its dt, whatever the scan calls */
  let clock = 0
  let implicitPlan: { plan: WatchPlan | null } | null = null
  return {
    tasks: [],
    inputs: [...main.decls.filter((d) => d.section === 'VAR_INPUT' && tagged(d)).map((d) => d.name), ...locatedKeys(located, 'input')],
    outputs: [...main.decls.filter((d) => d.section === 'VAR_OUTPUT' && tagged(d)).map((d) => d.name), ...locatedKeys(located, 'output')],
    // the POU's own first: setInput and get find a local before a global of the same name
    bindable: [...new Set([...main.decls, ...globalDecls].filter(wireable).map((d) => d.name))],
    get watch() {
      const out: Record<string, TagValue> = {}
      // globals first, so a POU-local of the same name shadows it in the table too
      globalPou?.watchInto(out, '', WATCH_ARRAY_MAX)
      pou.watchInto(out, '', WATCH_ARRAY_MAX)
      globalPou?.blocksInto(out, '')
      pou.blocksInto(out, '')
      return out
    },
    // the same four steps as `watch`, as places
    watchPlan: () =>
      (implicitPlan ??= {
        plan: planWatch([
          { pou: globalPou, prefix: '', blocks: false },
          { pou, prefix: '', blocks: false },
          { pou: globalPou, prefix: '', blocks: true },
          { pou, prefix: '', blocks: true },
        ]),
      }).plan,
    get memory() {
      const out: Record<string, TagValue> = {}
      globalPou?.watchInto(out, '', Infinity)
      pou.watchInto(out, '', Infinity)
      globalPou?.blocksInto(out, '')
      pou.blocksInto(out, '')
      return out
    },
    get memoryTypes() {
      const out: Record<string, string> = {}
      globalPou?.typesInto(out, '')
      pou.typesInto(out, '')
      return out
    },
    get deepMemory() {
      const out: Record<string, TagValue> = {}
      globalPou?.deepInto(out, '')
      pou.deepInto(out, '')
      return out
    },
    setInput(name: string, value: TagValue): void {
      const at = locatedFor(located, name)
      if (at) at.pou.setInput(at.name, value)
      else pou.setInput(name, value)
    },
    get(name: string): TagValue | undefined {
      const at = locatedFor(located, name)
      return at ? at.pou.get(at.name) : pou.get(name)
    },
    port(name: string): TagPort {
      const at = locatedFor(located, name)
      return at ? at.pou.port(at.name) : pou.port(name)
    },
    varInfo(name: string): VarInfo | undefined {
      const at = locatedFor(located, name)
      return at ? at.pou.varInfo(at.name) : pou.varInfo(name)
    },
    scan(dt: number): void {
      clock += nsOf(dt)
      pou.scan(clock)
    },
    scanTask(): void {
      throw new Error('a program with no CONFIGURATION has no tasks; scan() runs it')
    },
  }
}

/**
 * A CONFIGURATION: program instances, each its own POU over the one global store, grouped into the
 * tasks that run them. An instance's variables are addressed `Instance.Name`, on every surface a
 * host reads (inputs, outputs, watch, get, setInput); the globals and the controller's tags keep their
 * bare names, and a tag's VAR_INPUT / VAR_OUTPUT puts it on the inputs or outputs like any variable.
 */
export function configuredProgram(ast: Ast, build: PouBuilder, globalPou: Pou | null): CompiledProgram {
  const config = ast.configuration!
  const tags = controllerTags(ast)
  const types = new Map(ast.programDefs.map((d) => [identKey(d.name), d]))
  const instances = config.programs.map((p) => {
    // the instance with no type runs the code outside every POU, which owns no variables of its own
    if (p.type === null) return { name: p.name, decls: [] as Decl[], pou: build([], ast.body) }
    const def = types.get(identKey(p.type))!
    return { name: p.name, decls: def.decls, pou: build(def.decls, def.body) }
  })
  const byName = new Map(instances.map((i) => [identKey(i.name), i]))

  const tasks = taskTable(config)
  // The clock as each task reads it (ns). A task's scans come due in release order and each moves
  // its reading on by its dt, so a periodic task reads its scan's release time and the continuous
  // one the end of the step: one controller clock, read at each scan. Kept per task because only
  // the scheduler knows when a scan was released; the readings part only if one task sheds scans.
  const clocks = tasks.map(() => 0)
  let configuredPlan: { plan: WatchPlan | null } | null = null
  const runTask = (index: number, dt: number): void => {
    clocks[index]! += nsOf(dt)
    for (const name of tasks[index]!.programs) byName.get(identKey(name))!.pou.scan(clocks[index]!)
  }
  const pass = passOrder(tasks)

  /** `Instance.Name` split into the instance and the rest; null for a name no instance starts */
  const split = (name: string): { inst: (typeof instances)[number]; rest: string } | null => {
    const dot = name.indexOf('.')
    const inst = dot < 0 ? undefined : byName.get(identKey(name.slice(0, dot)))
    return inst ? { inst, rest: name.slice(dot + 1) } : null
  }
  const qualified = (section: Decl['section']): string[] => [
    ...tags.filter((d) => d.section === section && tagged(d)).map((d) => d.name),
    ...instances.flatMap((i) => i.decls.filter((d) => d.section === section && tagged(d)).map((d) => `${i.name}.${d.name}`)),
  ]
  // an address is one I/O point whichever instance holds it, so it is not qualified by the instance
  // (the checker lets a PROGRAM that locates variables run as one instance only)
  const located = locatedBindings([
    { pou: globalPou, decls: [...ast.globals, ...tags] },
    ...instances.map((i) => ({ pou: i.pou, decls: i.decls })),
  ])

  return {
    tasks,
    inputs: [...qualified('VAR_INPUT'), ...locatedKeys(located, 'input')],
    outputs: [...qualified('VAR_OUTPUT'), ...locatedKeys(located, 'output')],
    // the controller's tags and the globals by their bare names, an instance's own variables qualified
    bindable: [...[...tags, ...ast.globals].filter(wireable).map((d) => d.name), ...instances.flatMap((i) => i.decls.filter(wireable).map((d) => `${i.name}.${d.name}`))],
    get watch() {
      const out: Record<string, TagValue> = {}
      globalPou?.watchInto(out, '', WATCH_ARRAY_MAX)
      for (const i of instances) i.pou.watchInto(out, `${i.name}.`, WATCH_ARRAY_MAX)
      globalPou?.blocksInto(out, '')
      for (const i of instances) i.pou.blocksInto(out, `${i.name}.`)
      return out
    },
    // `watch`'s first and third steps alone: what the instances do not own
    sharedWatchKeys(): string[] {
      const out: Record<string, TagValue> = {}
      globalPou?.watchInto(out, '', WATCH_ARRAY_MAX)
      globalPou?.blocksInto(out, '')
      return Object.keys(out)
    },
    instanceDeclares(name: string): boolean {
      const s = split(name)
      if (!s) return false
      // (the variable is what stands before the first member or index)
      const end = s.rest.search(/[.[]/)
      return s.inst.pou.typeOf(end < 0 ? s.rest : s.rest.slice(0, end)) !== undefined
    },
    // the same steps as `watch`, as places
    watchPlan: () =>
      (configuredPlan ??= {
        plan: planWatch([
          { pou: globalPou, prefix: '', blocks: false },
          ...instances.map((i) => ({ pou: i.pou, prefix: `${i.name}.`, blocks: false })),
          { pou: globalPou, prefix: '', blocks: true },
          ...instances.map((i) => ({ pou: i.pou, prefix: `${i.name}.`, blocks: true })),
        ]),
      }).plan,
    get memory() {
      const out: Record<string, TagValue> = {}
      globalPou?.watchInto(out, '', Infinity)
      for (const i of instances) i.pou.watchInto(out, `${i.name}.`, Infinity)
      globalPou?.blocksInto(out, '')
      for (const i of instances) i.pou.blocksInto(out, `${i.name}.`)
      return out
    },
    get memoryTypes() {
      const out: Record<string, string> = {}
      globalPou?.typesInto(out, '')
      for (const i of instances) i.pou.typesInto(out, `${i.name}.`)
      return out
    },
    get deepMemory() {
      const out: Record<string, TagValue> = {}
      globalPou?.deepInto(out, '')
      for (const i of instances) i.pou.deepInto(out, `${i.name}.`)
      return out
    },
    setInput(name: string, value: TagValue): void {
      const at = locatedFor(located, name)
      if (at) return at.pou.setInput(at.name, value)
      const s = split(name)
      if (s) s.inst.pou.setInput(s.rest, value)
      else globalPou?.setInput(name, value) // a controller tag, or a global, as the implicit program allows
    },
    port(name: string): TagPort {
      const at = locatedFor(located, name)
      if (at) return at.pou.port(at.name)
      const s = split(name)
      if (s) return s.inst.pou.port(s.rest)
      // a controller tag, or a global: setInput writes it through the global POU, and get reads the global store,
      // which is that POU's own image, so one port answers both
      return globalPou ? globalPou.port(name) : { set: () => {}, get: () => undefined }
    },
    get(name: string): TagValue | undefined {
      const at = locatedFor(located, name)
      if (at) return at.pou.get(at.name)
      const s = split(name)
      if (s) return s.inst.pou.get(s.rest)
      // a controller tag, or a global: the global POU's own image is the store
      return globalPou?.get(name)
    },
    varInfo(name: string): VarInfo | undefined {
      const at = locatedFor(located, name)
      if (at) return at.pou.varInfo(at.name)
      const s = split(name)
      return s ? s.inst.pou.varInfo(s.rest) : globalPou?.varInfo(name)
    },
    scan(dt: number): void {
      for (const i of pass) runTask(i, dt)
    },
    scanTask(index: number, dt: number): void {
      if (!tasks[index]) throw new Error(`no task ${index}: this controller has ${tasks.length}`)
      runTask(index, dt)
    },
  }
}
