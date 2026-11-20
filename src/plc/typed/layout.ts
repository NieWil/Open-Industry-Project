// Where every value of a typed controller lives: the byte layout of each data type and each POU, computed once from the
// checked program (docs/plc-typed-storage.md, "Layout"). A layout is pure arithmetic over declarations - no arena, no
// values - so it can be validated on its own (layout.test.ts: every place inside its holder, no two overlapping),
// which is the guard against the one failure an arena has and records do not: a wrong offset silently writes a
// neighbour.

import { classIds, fbDecls, identKey } from '../program'
import { AXIS_KERNEL_OUTPUTS } from '../runtime'
import type { EnumDefMap, FbDefMap, StructDefMap } from '../program'
import type { ArrayDim, DataType, Decl, FbType, ScalarType, StructDef } from '../types'
import { DEFAULT_STRING_LEN, isArray, isEnum, isInterface, isRef, isStruct, isUserFb } from '../types'

/** A construct the typed engine cannot run yet: the program is refused by name, never run in part. */
export class TypedUnsupported extends Error {
  constructor(what: string) {
    super(`the typed engine does not run ${what} yet`)
    this.name = 'TypedUnsupported'
  }
}

/** The layout of a value of one data type. Sizes and offsets are bytes; every place is aligned to its own alignment,
 *  which is what lets a scalar at address `a` be read as `I32[a >> 2]`. */
export type TypeLayout = ScalarLayout | ArrayLayout | StructLayout

export interface ScalarLayout {
  kind: 'scalar'
  /** the type the slot holds: an enumeration is an INT at run time */
  scalar: ScalarType
  /** set for an enumeration: what the watch's types call it */
  enumerated?: true
  /** what the slot starts at when nothing initialises it, when that is not 0: an enumeration's first member (IEC) */
  zero?: number
  /** a STRING's capacity in characters */
  cap?: number
  /** an element of an array of interfaces: the address of the instance it refers to (0, none) */
  pointer?: 'iface'
  size: number
  align: number
}

export interface ArrayLayout {
  kind: 'array'
  dims: readonly ArrayDim[]
  elem: TypeLayout
  /** each dimension's stride in bytes: an index into dimension k moves `strides[k]` */
  strides: readonly number[]
  size: number
  align: number
}

export interface FieldLayout {
  /** the field's declared spelling */
  name: string
  off: number
  layout: TypeLayout
  /** a standard block's private state (a TON's start time): in the arena, but no member a program or the watch sees */
  hidden?: true
  /** a whole array or struct VAR_IN_OUT: this field is the address of the caller's (a UDINT), and `ref` is what is
   *  there. It starts at the instance's own zeroed copy (the hidden field after it), as the walker's starts at a zeroed
   *  value of its own, so an unbound one reads zeros rather than whatever address 0 holds. */
  ref?: TypeLayout
  /** a REF_TO: a `ref` that starts at 0, NULL, which faults when it is dereferenced (refAt) */
  nullable?: true
  /** an interface variable: the address of the instance it refers to (a UDINT; 0, none), whose class is the number
   *  at that address (CLASS_FIELD) */
  iface?: string
}

export interface StructLayout {
  kind: 'struct'
  /** set when this record is a standard function block's instance (typed/blocks.ts runs it) */
  block?: FbType
  /** set when this record is a user function block's instance: the definition's name (typed/pou.ts TypedFb runs it) */
  fb?: string
  /** set for the instance of a block that takes part in object orientation (program.ts classIds): its first field is
   *  its class's number, which a method called through an interface or a reference is dispatched on */
  classId?: number
  /** in declaration order */
  fields: readonly FieldLayout[]
  /** by identKey */
  byKey: ReadonlyMap<string, FieldLayout>
  size: number
  align: number
}

/** What the declarations of a POU (or the globals) lay out as: a struct of its variables. */
export interface PouLayout extends StructLayout {
  /** each field's declaration, by identKey */
  decls: ReadonlyMap<string, Decl>
}

const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a

/** The slot of a scalar type: its view's element size. STRING[n] is its length then n UTF-16 code units. */
export function scalarLayout(t: ScalarType, cap?: number): ScalarLayout {
  switch (t) {
    case 'BOOL': case 'SINT': case 'USINT': case 'BYTE':
      return { kind: 'scalar', scalar: t, size: 1, align: 1 }
    case 'INT': case 'UINT': case 'WORD':
      return { kind: 'scalar', scalar: t, size: 2, align: 2 }
    case 'DINT': case 'UDINT': case 'DWORD': case 'REAL':
      return { kind: 'scalar', scalar: t, size: 4, align: 4 }
    case 'LREAL': case 'TIME': case 'DATE': case 'TOD': case 'DT':
      return { kind: 'scalar', scalar: t, size: 8, align: 8 }
    case 'STRING': {
      const n = cap ?? DEFAULT_STRING_LEN
      return { kind: 'scalar', scalar: t, cap: n, size: 2 + 2 * n, align: 2 }
    }
  }
}

/** Lays out data types for one checked program (its structs and enumerations), each struct once. */
export class Layouts {
  readonly #structs = new Map<string, StructLayout>()
  readonly #pous = new WeakMap<readonly Decl[], PouLayout>()
  readonly #fbs = new Map<string, PouLayout>()
  /** the function blocks being laid out, outermost first: a block holding itself is refused (the checker refuses it too) */
  readonly #laying: string[] = []

  constructor(
    private readonly structDefs: StructDefMap,
    private readonly enumDefs: EnumDefMap,
    private readonly fbDefs: FbDefMap = new Map(),
  ) {}

  of(t: DataType, cap?: number): TypeLayout {
    if (typeof t === 'string') {
      if (t in BLOCKS) return BLOCKS[t as FbType]
      return scalarLayout(t as ScalarType, cap)
    }
    if (isUserFb(t)) return this.fb(t.fb)
    // an element of an array of interfaces: an address (a POU's own interface variable is a field of its own: `pou`)
    if (isInterface(t)) return { ...scalarLayout('UDINT'), pointer: 'iface' }
    if (isEnum(t)) {
      const def = this.enumDefs.get(identKey(t.enum))
      if (!def) throw new TypedUnsupported(`the enumeration '${t.enum}'`)
      const first = def.members[0]?.value ?? 0
      return { ...scalarLayout('INT'), enumerated: true, ...(first !== 0 ? { zero: first } : {}) }
    }
    if (isStruct(t)) return this.struct(t.struct)
    if (isArray(t)) {
      const elem = this.of(t.elem, t.elemMaxLen)
      const stride = alignUp(elem.size, elem.align)
      const strides: number[] = new Array<number>(t.dims.length).fill(0)
      let run = stride
      for (let k = t.dims.length - 1; k >= 0; k--) {
        strides[k] = run
        run *= t.dims[k]!.hi - t.dims[k]!.lo + 1
      }
      return { kind: 'array', dims: t.dims, elem, strides, size: run, align: elem.align }
    }
    throw new TypedUnsupported('this data type')
  }

  /** a structure's definition, as declared */
  structDef(name: string): StructDef | undefined {
    return this.structDefs.get(identKey(name))
  }

  struct(name: string): StructLayout {
    const key = identKey(name)
    let done = this.#structs.get(key)
    if (!done) {
      const def = this.structDefs.get(key)
      if (!def) throw new TypedUnsupported(`the structure '${name}'`)
      done = record(def.fields.map((f) => ({ name: f.name, layout: this.of(f.type, f.maxLen) })))
      this.#structs.set(key, done)
    }
    return done
  }

  /** A user function block's instance: its declarations laid out as a POU's, marked with the definition's name. */
  fb(name: string): PouLayout {
    const key = identKey(name)
    let done = this.#fbs.get(key)
    if (!done) {
      const def = this.fbDefs.get(key)
      if (!def) throw new TypedUnsupported(`the function block '${name}'`)
      if (this.#laying.includes(key)) throw new TypedUnsupported(`the recursive function block '${name}'`)
      this.#laying.push(key)
      try {
        // what it inherits first, so a derived instance is its base's with more after it; and its class's number
        // before all of it, in every class of a hierarchy alike
        const id = classIds(this.fbDefs).get(key)
        done = { ...this.pou(fbDecls(def), true, id !== undefined), fb: def.name, ...(id !== undefined ? { classId: id } : {}) }
      } finally {
        this.#laying.pop()
      }
      this.#fbs.set(key, done)
    }
    return done
  }

  /** A POU's variables (a VAR_EXTERNAL owns no storage, so it has no place), in declaration order. Only a function
   *  block's may be VAR_IN_OUT (`inOut`): a scalar one is a plain slot (copied in and back out by the call, as the
   *  walker does), a whole array or struct a reference to the caller's (FieldLayout.ref) with a zeroed copy of its own. */
  pou(declared: readonly Decl[], inOut = false, classed = false): PouLayout {
    let done = this.#pous.get(declared)
    if (!done) {
      const decls = declared.filter((d) => d.section !== 'VAR_EXTERNAL')
      const fields: RecordField[] = classed ? [{ name: CLASS_FIELD, layout: scalarLayout('UDINT'), hidden: true }] : []
      for (const d of decls) {
        // a REF_TO holds the address of what it refers to (0: NULL); an interface the instance's
        if (isRef(d.type)) {
          fields.push({ name: d.name, layout: scalarLayout('UDINT'), ref: this.of(d.type.ref, d.type.maxLen), nullable: true })
          continue
        }
        if (isInterface(d.type)) {
          fields.push({ name: d.name, layout: scalarLayout('UDINT'), iface: d.type.iface })
          continue
        }
        const layout = this.of(d.type, d.maxLen)
        if (d.section !== 'VAR_IN_OUT' || layout.kind === 'scalar') {
          if (d.section === 'VAR_IN_OUT' && !inOut) throw new TypedUnsupported('VAR_IN_OUT outside a function block')
          fields.push({ name: d.name, layout })
          continue
        }
        if (!inOut) throw new TypedUnsupported('VAR_IN_OUT outside a function block')
        if ((layout.kind === 'struct' && (layout.block || layout.fb))) throw new TypedUnsupported('a function block passed as VAR_IN_OUT')
        fields.push({ name: d.name, layout: scalarLayout('UDINT'), ref: layout })
        fields.push({ name: `${d.name}${OWN_COPY}`, layout, hidden: true })
      }
      const rec = record(fields)
      done = { ...rec, decls: new Map(decls.map((d) => [identKey(d.name), d])) }
      this.#pous.set(declared, done)
    }
    return done
  }
}

/** A standard block's record: its outputs first, in the order the walker's objects list them (runtime.ts: a TON's
 *  `Q` then `ET`), then its private state, hidden, then the inputs it keeps for a call that leaves them out, hidden
 *  too. An input the block already keeps as an edge's previous value (a trigger's CLK, a counter's CU) has no field of
 *  its own. Placed by `record` like any struct, so the validator covers it. */
function block(type: FbType, fields: [string, ScalarType, boolean?][]): StructLayout {
  const rec = record(fields.map(([name, t]) => ({ name, layout: scalarLayout(t) })))
  const hidden = new Set(fields.filter((f) => f[2]).map((f) => f[0]))
  const placed = rec.fields.map((f) => (hidden.has(f.name) ? { ...f, hidden: true as const } : f))
  return { ...rec, fields: placed, byKey: new Map(placed.map((f) => [identKey(f.name), f])), block: type }
}
const TIMER: [string, ScalarType, boolean?][] = [['Q', 'BOOL'], ['ET', 'TIME'], ['running', 'BOOL', true], ['start', 'LREAL', true], ['IN', 'BOOL', true], ['PT', 'TIME', true]]
export const BLOCKS: Record<FbType, StructLayout> = {
  // the motion kernel: its outputs only; its plan is the host's (typed/blocks.ts keeps a channel per instance)
  AXIS_KERNEL: block('AXIS_KERNEL', Object.entries(AXIS_KERNEL_OUTPUTS)),
  TON: block('TON', TIMER),
  TOF: block('TOF', TIMER),
  TP: block('TP', [['Q', 'BOOL'], ['ET', 'TIME'], ['prev', 'BOOL', true], ['running', 'BOOL', true], ['start', 'LREAL', true], ['PT', 'TIME', true]]),
  R_TRIG: block('R_TRIG', [['Q', 'BOOL'], ['prev', 'BOOL', true]]),
  F_TRIG: block('F_TRIG', [['Q', 'BOOL'], ['prev', 'BOOL', true]]),
  CTU: block('CTU', [['CV', 'INT'], ['Q', 'BOOL'], ['prev', 'BOOL', true], ['R', 'BOOL', true], ['PV', 'INT', true]]),
  CTD: block('CTD', [['CV', 'INT'], ['Q', 'BOOL'], ['prev', 'BOOL', true], ['LD', 'BOOL', true], ['PV', 'INT', true]]),
  CTUD: block('CTUD', [['CV', 'INT'], ['QU', 'BOOL'], ['QD', 'BOOL'], ['prevU', 'BOOL', true], ['prevD', 'BOOL', true], ['R', 'BOOL', true], ['LD', 'BOOL', true], ['PV', 'INT', true]]),
  SR: block('SR', [['Q1', 'BOOL'], ['S1', 'BOOL', true], ['R', 'BOOL', true]]),
  RS: block('RS', [['Q1', 'BOOL'], ['S', 'BOOL', true], ['R1', 'BOOL', true]]),
}

/** The name of the hidden field holding a reference VAR_IN_OUT's own copy (a character no identifier has). */
export const OWN_COPY = '#own'
/** The name of the hidden first field of an object-oriented block's instance: its class's number. */
export const CLASS_FIELD = '#class'

interface RecordField {
  name: string
  layout: TypeLayout
  hidden?: true
  ref?: TypeLayout
  nullable?: true
  iface?: string
}

/** Fields placed in order, each at the next offset its alignment allows; the record's size rounds up to its alignment. */
function record(fields: RecordField[]): StructLayout {
  let off = 0
  let align = 1
  const placed: FieldLayout[] = []
  for (const f of fields) {
    off = alignUp(off, f.layout.align)
    placed.push({ name: f.name, off, layout: f.layout, ...(f.hidden ? { hidden: true as const } : {}), ...(f.ref ? { ref: f.ref } : {}), ...(f.nullable ? { nullable: true as const } : {}), ...(f.iface !== undefined ? { iface: f.iface } : {}) })
    off += f.layout.size
    align = Math.max(align, f.layout.align)
  }
  return { kind: 'struct', fields: placed, byKey: new Map(placed.map((f) => [identKey(f.name), f])), size: alignUp(off, align), align }
}

/** What `aggregate := 0` zeroes of a layout, as [offset, bytes] pairs: everything but the function block instances
 *  inside it, which are state, not data, and keep it (runtime.ts clearData). Adjacent runs are merged. */
export function clearRanges(layout: TypeLayout): readonly number[] {
  let done = clears.get(layout)
  if (!done) {
    const runs: number[] = []
    const walk = (l: TypeLayout, at: number): void => {
      if (l.kind === 'struct' && (l.block || l.fb)) return
      if (l.kind === 'scalar' || !holdsInstance(l)) {
        const n = runs.length
        if (n && runs[n - 2]! + runs[n - 1]! === at) runs[n - 1] = runs[n - 1]! + l.size
        else runs.push(at, l.size)
        return
      }
      if (l.kind === 'struct') for (const f of l.fields) walk(f.layout, at + f.off)
      else {
        const stride = l.strides[l.strides.length - 1]!
        for (let i = 0; i < l.size / stride; i++) walk(l.elem, at + i * stride)
      }
    }
    walk(layout, 0)
    clears.set(layout, (done = runs))
  }
  return done
}
const clears = new WeakMap<TypeLayout, readonly number[]>()
function holdsInstance(l: TypeLayout): boolean {
  if (l.kind === 'scalar') return false
  if (l.kind === 'array') return holdsInstance(l.elem)
  return !!l.block || !!l.fb || l.fields.some((f) => holdsInstance(f.layout))
}

/** Every scalar place under a layout at `base`, depth first in declaration order: what the validator and the watch walk. */
export function* places(layout: TypeLayout, base: number): Generator<{ addr: number; layout: ScalarLayout }> {
  if (layout.kind === 'scalar') {
    yield { addr: base, layout }
    return
  }
  if (layout.kind === 'struct') {
    for (const f of layout.fields) yield* places(f.layout, base + f.off)
    return
  }
  const count = layout.dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1)
  const stride = layout.strides[layout.strides.length - 1]!
  for (let i = 0; i < count; i++) yield* places(layout.elem, base + i * stride)
}
