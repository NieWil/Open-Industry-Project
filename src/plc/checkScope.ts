// What the type checker (checker.ts) resolves names against, and the small helpers every part of it shares:
// collecting errors per statement, comparing and naming types, and reading the root of a place.

import { type EnumDefMap, type Env, type FbDefMap, type FuncDefMap, identKey, type InterfaceDefMap, type StructDefMap } from './program'
import type { DataType, Decl, Diagnostic, Expr, FbDef, MethodDef } from './types'
import { DEFAULT_STRING_LEN, isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/** identKey(member) -> which enumeration it belongs to and what it is worth. Members resolve
 *  unqualified, by this engine's own rule for a bare member name. */
export type EnumMemberMap = Map<string, { name: string; enum: string; value: number }>
/** What names resolve against: local variables, then VAR_GLOBALs, plus the type / FB /
 *  function definitions (which share one namespace of their own). */
export interface Scope {
  env: Env
  /** this POU's VAR_EXTERNAL declarations. Not in `env`: a name they declare still resolves to the
   *  global, and they only narrow it (see `lookup`) */
  externals: Env
  globals: Env
  fbs: FbDefMap
  funcs: FuncDefMap
  structs: StructDefMap
  enums: EnumDefMap
  enumMembers: EnumMemberMap
  /** Control variables of the FOR loops currently open around the statement being checked.
   *  IEC forbids assigning to one from inside its own body, and a real compiler says so
   *  ("Assignment to FOR control variable is not allowed"). Mutated as the walk descends. */
  forVars: Set<string>
  /** the INTERFACEs, by identKey */
  ifaces: InterfaceDefMap
  /** The function block whose body or method is being checked: what THIS is, what a bare method name reaches, and
   *  who a PRIVATE or PROTECTED member is checked against. `method` is set inside a method, whose own variables are
   *  temporary (a lasting REF_TO may not be given a reference to one). Absent in a PROGRAM or a FUNCTION. */
  self?: { cls: FbDef; method?: MethodDef }
  /** set inside a FUNCTION: its variables are temporary too */
  inFunction?: boolean
}

/**
 * Declarations whose TYPE was refused (`x : LINT`, `x : Nope`). They stay in scope, so a later use
 * is not reported as "undeclared", but a use has nothing true to say about them either: it would be
 * checked against a type that never resolved, which reads as a function block, so one refused type
 * would add "cannot assign to function block 'x'" at every statement that named it.
 */
export const rejectedTypes = new WeakSet<Decl>()

/** Thrown by {@link lookup} for a name in {@link rejectedTypes}. The author already has the error
 *  that matters, so {@link collect} records nothing for the statement that reached it. */
export class AlreadyReported extends StError {}

/**
 * Run one unit of checking. With a `sink` (the editor path) a failure is recorded and the
 * caller carries on to the next statement or declaration, so an author sees every error at
 * once; without one (the execution path) the first error throws, which is what `compile()`
 * wants. The granularity is per-statement: finer would report the same mistake
 * several times, coarser would hide the rest of the POU behind one typo.
 */
export function collect(sink: Diagnostic[] | null, fn: () => void): void {
  if (!sink) {
    fn()
    return
  }
  try {
    fn()
  } catch (e) {
    if (e instanceof AlreadyReported) return
    if (!(e instanceof StError)) throw e
    sink.push({ message: e.message, pos: e.pos, length: e.length, ...(e.origin ? { origin: e.origin } : {}) })
  }
}

/** Resolve a variable: the POU's own declarations shadow VAR_GLOBALs of the same name. */
export function lookup(scope: Scope, name: string): Decl | undefined {
  const k = identKey(name)
  const own = scope.env.get(k)
  const found = own ?? scope.globals.get(k)
  if (found && rejectedTypes.has(found)) throw new AlreadyReported(`the type of '${found.name}' was refused`, found.pos, found.name.length)
  if (own) return own
  const g = scope.globals.get(k)
  // `VAR_EXTERNAL CONSTANT` promises this POU will not write the global, whatever the global allows
  if (g && !g.constant && scope.externals.get(k)?.constant) return { ...g, constant: true }
  return g
}

/** A POU's declarations, split the way checking needs them: its own variables and its VAR_EXTERNALs. */
export interface PouScope {
  own: Decl[]
  env: Env
  externals: Env
}

/**
 * Exact type identity, for a VAR_IN_OUT binding. Unlike an assignment there is no widening
 * here: the block writes through the argument, so a wider place would be handed values it
 * cannot represent, and a narrower one would silently truncate what came back.
 */
export function sameDataType(a: DataType, b: DataType): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (isEnum(a) && isEnum(b)) return identKey(a.enum) === identKey(b.enum)
  if (isStruct(a) && isStruct(b)) return identKey(a.struct) === identKey(b.struct)
  if (isUserFb(a) && isUserFb(b)) return identKey(a.fb) === identKey(b.fb)
  if (isInterface(a) && isInterface(b)) return identKey(a.iface) === identKey(b.iface)
  if (isRef(a) && isRef(b)) return sameDataType(a.ref, b.ref) && a.maxLen === b.maxLen
  if (isArray(a) && isArray(b)) {
    // A named array type is its own type: only the same name matches it, never an array spelled
    // out in place however alike, and never another name. That is how MATIEC types arrays
    // (measured); two arrays spelled out in place still match by shape below.
    if (a.named !== undefined || b.named !== undefined) {
      return a.named !== undefined && b.named !== undefined && identKey(a.named) === identKey(b.named)
    }
    return (
      a.dims.length === b.dims.length &&
      a.dims.every((d, i) => d.lo === b.dims[i]!.lo && d.hi === b.dims[i]!.hi) &&
      // STRING[10] and STRING[20] elements are different types: a copy or an alias between the
      // two would carry text one side has no room for
      a.elemMaxLen === b.elemMaxLen &&
      sameDataType(a.elem, b.elem)
    )
  }
  return false
}

/** A readable name for a data type, for error messages. */
export function typeName(t: DataType): string {
  if (typeof t === 'string') return t
  if (isEnum(t)) return t.enum
  if (isStruct(t)) return t.struct
  if (isUserFb(t)) return t.fb
  if (isInterface(t)) return t.iface
  if (isRef(t)) return `REF_TO ${typeName(t.ref)}${t.ref === 'STRING' && t.maxLen !== undefined ? `[${t.maxLen}]` : ''}`
  if (t.named !== undefined) return t.named
  const cap = t.elem === 'STRING' && t.elemMaxLen !== undefined ? `[${t.elemMaxLen}]` : ''
  return `ARRAY[${t.dims.map((d) => `${d.lo}..${d.hi}`).join(', ')}] OF ${typeName(t.elem)}${cap}`
}

/** Which enumeration an expression's value belongs to, or null when it is a plain number. */
export function exprEnum(e: Expr): string | null {
  return (e.node === 'var' || e.node === 'member' || e.node === 'index' || e.node === 'call' || e.node === 'mcall') && e.enum ? e.enum : null
}

/** The base variable a place expression writes into (`p.inner.arr[i]` -> `p`). */
export function placeRoot(e: Expr): string | null {
  if (e.node === 'var') return e.name
  if (e.node === 'member' || e.node === 'index' || e.node === 'bit') return placeRoot(e.obj)
  return null
}

/** The source spelling of a place, for a message about it (`zones[i].gap`). */
export function placeText(e: Expr): string {
  if (e.node === 'var') return e.ref ? `${e.name}^` : e.name
  if (e.node === 'this') return e.super ? 'SUPER^' : 'THIS'
  if (e.node === 'member') return `${placeText(e.obj)}.${e.field}`
  if (e.node === 'index') return `${placeText(e.obj)}[${e.indices.map(placeText).join(', ')}]`
  if (e.node === 'bit') return `${placeText(e.obj)}.${e.bit}`
  if (e.node === 'num') return String(e.value)
  if (e.node === 'mcall') return `${placeText(e.obj)}.${e.method}(...)`
  return '...'
}

/** Rewrite a node in place into another (the checker turns `Peek()` into a method call on THIS, and so on): the node is
 *  referenced from its parent, so it is its contents that change. */
export function become<T extends object>(node: object, next: T): T {
  for (const k of Object.keys(node)) delete (node as Record<string, unknown>)[k]
  return Object.assign(node, next)
}

/** Whether a type is a REF_TO, an interface or an array of interfaces: something that designates rather than
 *  holds, which is never copied whole (a copy would duplicate what it refers to, not a value), nor kept in a structure. */
export function designates(t: DataType): boolean {
  return isRef(t) || isInterface(t) || (isArray(t) && isInterface(t.elem))
}

/** A declaration's type as an author wrote it, for a message: the subrange or STRING capacity included. */
export function declTypeName(d: Decl): string {
  if (d.range) return d.range.name
  if (d.type === 'STRING') return `STRING[${d.maxLen ?? DEFAULT_STRING_LEN}]`
  return typeName(d.type)
}
