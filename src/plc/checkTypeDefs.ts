// Type definitions for the type checker: resolving declared types, folding constant bounds and capacities, and
// building the variable environment of a POU.

import { collect, declTypeName, designates, rejectedTypes, sameDataType } from './checkScope'
import { type EnumDefMap, type Env, type FbDefMap, identKey, type InterfaceDefMap, isFb, isScalarType, type StructDefMap, type SubrangeDefMap } from './program'
import { isInt } from './runtime'
import type { AliasDef, Ast, DataType, Decl, Diagnostic, Expr, FbType, FuncDef, ProgramDef, SourcePos } from './types'
import { CALENDAR_TYPE_NAMES, DEFAULT_STRING_LEN, FB_TYPES, isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/** The named-type namespaces a type name can resolve against. */
export interface TypeDefs {
  structs: StructDefMap
  enums: EnumDefMap
  fbs: FbDefMap
  ifaces: InterfaceDefMap
  /** PROGRAM types, only so a variable declared as one gets a straight answer */
  programs: Map<string, ProgramDef>
  aliases: Map<string, AliasDef>
  /** the named types being resolved right now, so a cycle of names is caught rather than followed */
  resolving: Set<string>
  /** integer CONSTANT values an array bound may use: the global ones, plus the declaring POU's own */
  constants: Map<string, number>
  /** only the global ones, which is all a TYPE declaration or a struct field can see */
  globalConstants: Map<string, number>
}

/**
 * Fold an array bound written as a constant expression into its value: integer literals, named
 * integer CONSTANTs, `+ - * /`, `MOD` and a sign. Anything else is not something a declaration can
 * know the value of when it is read, and saying which part is the useful error.
 */
function foldBound(e: Expr, consts: Map<string, number>, what = 'an array bound'): number {
  switch (e.node) {
    case 'num':
      if (!e.real) return e.value
      break
    case 'var': {
      const v = e.qualifier === undefined ? consts.get(identKey(e.name)) : undefined
      if (v === undefined) throw new StError(`${what} must be a constant: '${e.name}' is not an integer CONSTANT declared before it`, e.pos, e.name.length)
      return v
    }
    case 'unary':
      if (e.op === 'NEG') return -foldBound(e.expr, consts, what)
      if (e.op === 'POS') return foldBound(e.expr, consts, what)
      break
    case 'binary': {
      const l = foldBound(e.left, consts, what)
      const r = foldBound(e.right, consts, what)
      if (e.op === '+') return l + r
      if (e.op === '-') return l - r
      if (e.op === '*') return l * r
      if ((e.op === '/' || e.op === 'MOD') && r === 0) throw new StError(`${what} divides by zero`, e.pos)
      if (e.op === '/') return Math.trunc(l / r)
      if (e.op === 'MOD') return l % r
      break
    }
    default:
      break
  }
  throw new StError(`${what} must be an integer, or a constant expression over integer CONSTANTs`, e.pos)
}

/**
 * `STRING(MAX_LEN)`: every STRING capacity written as a constant expression (parserDecl.ts `stringLen`), folded against the
 * global CONSTANTs and written where the parser left its placeholder - any `maxLen`, `retMaxLen` or `elemMaxLen` of
 * -(1 + k) in the tree. One walk of the AST, and only for a program that writes such a capacity. A capacity that does
 * not fold is reported where it is written, and the default capacity stands in, so a tolerant check carries on.
 */
export function foldCapacities(ast: Ast, consts: Map<string, number>, sink: Diagnostic[] | null): void {
  const exprs = ast.capacities
  if (!exprs?.length) return
  const values = exprs.map((e) => {
    let n = DEFAULT_STRING_LEN
    collect(sink, () => {
      const v = foldBound(e, consts, 'a STRING capacity')
      if (v <= 0) throw new StError('a STRING capacity must be a positive integer', e.pos)
      n = v
    })
    return n
  })
  ast.capacityValues = values
  const seen = new Set<object>()
  const walk = (o: unknown): void => {
    if (o === null || typeof o !== 'object' || seen.has(o)) return
    seen.add(o)
    if (Array.isArray(o)) {
      for (const x of o) walk(x)
      return
    }
    const rec = o as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      const v = rec[k]
      if ((k === 'maxLen' || k === 'retMaxLen' || k === 'elemMaxLen') && typeof v === 'number' && v < 0) rec[k] = values[-v - 1] ?? DEFAULT_STRING_LEN
      else if (k !== 'capacities') walk(v)
    }
  }
  walk(ast)
}

/** Record an integer CONSTANT's value for later array bounds, when its initial value folds to one.
 *  Anything else is not available to a bound; its own initial value is still checked where
 *  every initial value is. */
export function registerConstant(d: Decl, constants: Map<string, number>): void {
  if (!d.constant || !d.init || !isScalarType(d.type) || !isInt(d.type)) return
  try {
    constants.set(identKey(d.name), foldBound(d.init, constants))
  } catch {
    // not foldable: the constant exists, it just cannot size an array
  }
}

/**
 * Resolve every named type inside a data type to what the name actually is, rewritten to the
 * definition's spelling (type names are case-insensitive like every identifier), and return it.
 *
 * The parser cannot tell `Pkg`, `Mode`, `Zone` and `TON` apart, since all four are identifiers to
 * it, so it records a name and this decides: a struct, an enumeration, a user FUNCTION_BLOCK, or a
 * standard one, which a user definition of the same name shadows. One resolver for every position
 * a type can appear in (a declaration, an array element, a struct field) is what lets a function
 * block sit in all three. An array's element is resolved in place, so a type shared by a
 * multi-name declaration is resolved once for all of its names.
 */
export function resolveDataType(t: DataType, defs: TypeDefs, pos: SourcePos, length = 1, referred = false): DataType {
  if (isArray(t)) {
    // bounds written as constants fold to their values, now that the constants are known
    for (const dim of t.dims) {
      if (dim.loExpr) dim.lo = foldBound(dim.loExpr, defs.constants)
      if (dim.hiExpr) dim.hi = foldBound(dim.hiExpr, defs.constants)
      if ((dim.loExpr || dim.hiExpr) && dim.hi < dim.lo) throw new StError(`array bounds must be ascending (${dim.lo}..${dim.hi})`, pos, length)
    }
    // an element named after a STRING type carries that type's capacity, which the resolved
    // element (plain STRING) no longer says, so it is read before the name is resolved away
    const cap = t.elemMaxLen === undefined ? capacityOf(t.elem, defs) : undefined
    t.elem = resolveDataType(t.elem, defs, pos, length)
    if (cap !== undefined) t.elemMaxLen = cap
    if (isRef(t.elem)) throw new StError('an ARRAY OF REF_TO is not implemented: keep the references as variables of their own, or an array of indices into the data', pos, length)
    return t
  }
  // REF_TO <type>: the type it refers to resolves like any other (an ABSTRACT block included: a reference to one
  // refers to an instance of a block derived from it)
  if (isRef(t)) {
    const cap = t.maxLen === undefined ? capacityOf(t.ref, defs) : undefined
    t.ref = resolveDataType(t.ref, defs, pos, length, true)
    if (cap !== undefined) t.maxLen = cap
    if (isRef(t.ref)) throw new StError('a REF_TO a REF_TO is not implemented', pos, length)
    if (isInterface(t.ref)) throw new StError(`a REF_TO an interface is not implemented: an interface variable already refers to an instance`, pos, length)
    if (designates(t.ref)) throw new StError('a REF_TO an array of interfaces is not implemented', pos, length)
    if (isFb(t.ref)) throw new StError(`a REF_TO ${t.ref} (a standard block) is not implemented`, pos, length)
    return t
  }
  if (isInterface(t)) return t
  const name = isStruct(t) ? t.struct : isEnum(t) ? t.enum : isUserFb(t) ? t.fb : null
  if (name === null) return t // a scalar, or a standard function block that is already resolved
  const k = identKey(name)
  const st = defs.structs.get(k)
  if (st) return { struct: st.name }
  const en = defs.enums.get(k)
  if (en) return { enum: en.name }
  const fb = defs.fbs.get(k)
  if (fb) {
    if (fb.abstract && !referred) throw new StError(`'${fb.name}' is ABSTRACT, so nothing is an instance of it: declare an instance of a block derived from it (or a REF_TO ${fb.name})`, pos, length)
    return { fb: fb.name }
  }
  const iface = defs.ifaces.get(k)
  if (iface) return { iface: iface.name }
  const alias = defs.aliases.get(k)
  if (alias) return resolveAlias(alias, defs)
  const program = defs.programs.get(k)
  if (program) {
    throw new StError(
      `'${program.name}' is a PROGRAM, and no variable can hold one: a CONFIGURATION runs an instance of it (PROGRAM <name> WITH <task> : ${program.name};)`,
      pos,
      length,
    )
  }
  if (BUILTIN_FB.has(k)) return k as FbType
  // DATE, TOD / TIME_OF_DAY, DT / DATE_AND_TIME: elementary types, but not reserved words (types.ts), so
  // they arrive here as names, after every user definition has had its chance to claim the name
  const calendar = CALENDAR_TYPE_NAMES[k]
  if (calendar !== undefined) return calendar
  throw new StError(unknownTypeMessage(name), pos, length)
}

/**
 * What a named type names. Its own type is resolved in place and kept, so every use of the name
 * shares one resolved type, which is also what makes a named array one type: every use holds the
 * same ArrayType, marked with the name. A chain of names is followed to its end, and a cycle of
 * them names nothing.
 */
export function resolveAlias(def: AliasDef, defs: TypeDefs): DataType {
  const k = identKey(def.name)
  if (defs.resolving.has(k)) throw new StError(`recursive type '${def.name}'`, def.pos, def.name.length)
  defs.resolving.add(k)
  // a TYPE declaration sees only the global constants, whichever POU happens to resolve it first
  const typeDefs: TypeDefs = { ...defs, constants: defs.globalConstants }
  try {
    // a name for a STRING type keeps its capacity through a chain of names (`TYPE Tag : Label;`)
    if (def.maxLen === undefined) def.maxLen = capacityOf(def.type, typeDefs)
    def.type = resolveDataType(def.type, typeDefs, def.pos, def.name.length)
  } finally {
    defs.resolving.delete(k)
  }
  return def.type
}

/** The STRING capacity a type name carries when it names `TYPE Label : STRING[20]` (directly or
 *  through a chain of names), or undefined when the name is not one of those. */
export function capacityOf(t: DataType, defs: TypeDefs): number | undefined {
  if (isRef(t)) return capacityOf(t.ref, defs)
  const name = isStruct(t) ? t.struct : isEnum(t) ? t.enum : isUserFb(t) ? t.fb : null
  const alias = name === null ? undefined : defs.aliases.get(identKey(name))
  if (!alias) return undefined
  resolveAlias(alias, defs)
  return alias.maxLen
}

/** Resolve a FUNCTION's return type in place, the way a declaration's type is resolved: a subrange
 *  becomes its base type, with the bounds kept for the result variable to enforce. */
export function resolveReturnType(def: FuncDef, defs: TypeDefs, subrangeDefs: SubrangeDefMap): void {
  const sr = isUserFb(def.ret) ? subrangeDefs.get(identKey(def.ret.fb)) : undefined
  if (sr) {
    def.ret = sr.base
    def.retRange = { lo: sr.lo, hi: sr.hi, name: sr.name }
    return
  }
  if (def.retMaxLen === undefined) def.retMaxLen = capacityOf(def.ret, defs)
  def.ret = resolveDataType(def.ret, defs, def.pos, def.name.length)
}

/** The declared name of a struct or subrange already using this name, if any. */
export function definedType(structs: StructDefMap, subranges: SubrangeDefMap, name: string): string | undefined {
  return (structs.get(identKey(name)) ?? subranges.get(identKey(name)))?.name
}

/** Builtin function-block type names, folded for lookup. These are not reserved words: a
 *  user `FUNCTION_BLOCK TON` legitimately shadows the builtin, which is why the name is
 *  resolved here rather than being claimed by the lexer. */
const BUILTIN_FB = new Set<string>(FB_TYPES)

/**
 * IEC types this engine does not implement. Saying so beats "unknown type":
 * the author has written valid ST, and the answer is that the subset stops here -
 * with the reason, so they can judge whether it matters for their program.
 */
const UNSUPPORTED_TYPES: Record<string, string> = {
  LINT: '64-bit integers need exact arithmetic a JS number cannot provide; use DINT, or LREAL if the range matters more than the last digits',
  ULINT: '64-bit integers need exact arithmetic a JS number cannot provide; use UDINT, or LREAL if the range matters more than the last digits',
  LWORD: '64-bit bit strings need exact arithmetic a JS number cannot provide; use DWORD, or two of them',
  WSTRING: 'wide (UTF-16) strings are not implemented; STRING is',
  LDATE: 'the 64-bit calendar types are IEC 3rd edition and not implemented; DATE is',
  LTOD: 'the 64-bit calendar types are IEC 3rd edition and not implemented; TOD is',
  LDT: 'the 64-bit calendar types are IEC 3rd edition and not implemented; DT is',
}

/** "unknown type 'X'", or a straight answer when X is a standard type we chose not to have. */
function unknownTypeMessage(name: string): string {
  const why = UNSUPPORTED_TYPES[identKey(name)]
  return why ? `${identKey(name)} is not supported: ${why}` : `unknown type '${name}'`
}

/** Reject a name that collides with an earlier one, saying so explicitly when the two
 *  differ only in case - otherwise "duplicate declaration 'motor'" reads like a lie. */
export function duplicateName(kind: string, declared: string, prev: string, pos: SourcePos): StError {
  const why = prev === declared ? '' : ` ('${prev}' is already declared; identifiers are case-insensitive)`
  return new StError(`duplicate ${kind} '${declared}'${why}`, pos, declared.length)
}

/** Build a POU's variable env, resolving identifier types and rejecting unknowns. */
export function buildEnv(decls: Decl[], defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null = null): Env {
  const env: Env = new Map()
  // this POU's own integer CONSTANTs join the global ones as they are declared, so a later array
  // bound can use them (`VAR CONSTANT ZONES : INT := 4; END_VAR VAR eyes : ARRAY [1..ZONES] ...`)
  const scoped: TypeDefs = { ...defs, constants: new Map(defs.constants) }
  for (const d of decls) {
    const k = identKey(d.name)
    const prev = env.get(k)
    let resolved = false
    collect(sink, () => {
      if (prev) throw duplicateName('declaration', d.name, prev.name, d.pos)
      // A subrange is the one named type only a declaration takes: it resolves to its base type
      // plus the bounds, which every store enforces. No user struct, enumeration or block can
      // share its name (they are one namespace), but a standard block can, and the subrange wins.
      const sr = isUserFb(d.type) ? subrangeDefs.get(identKey(d.type.fb)) : undefined
      if (sr) {
        d.type = sr.base
        d.range = { lo: sr.lo, hi: sr.hi, name: sr.name }
      } else {
        const cap = d.maxLen === undefined ? capacityOf(d.type, scoped) : undefined
        d.type = resolveDataType(d.type, scoped, d.pos, d.name.length)
        if (cap !== undefined) d.maxLen = cap // `tag : Label` truncates to Label's capacity
      }
      resolved = true
    })
    registerConstant(d, scoped.constants)
    // Register the name even when its TYPE was rejected: the author already has one error
    // about it, and leaving it out of scope would add an "undeclared" for every later use.
    // Marking it keeps each of those uses from adding a consequence instead (rejectedTypes).
    if (!prev) {
      env.set(k, d)
      if (!resolved) rejectedTypes.add(d)
    }
  }
  return env
}

/**
 * A POU's VAR_EXTERNAL declarations, checked against the VAR_GLOBALs they name.
 *
 * They get no storage and no place in the POU's own env, so every reference still resolves to the
 * global, exactly as it did before this POU declared anything. What a declaration adds is the proof
 * that the global exists with this type, which is what a strict target checks, and, when it says
 * CONSTANT, a read-only view of the global for this POU.
 */
export function buildExternals(decls: Decl[], own: Env, globals: Env, defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null): Env {
  const externals = buildEnv(decls, defs, subrangeDefs, sink)
  for (const d of externals.values()) {
    collect(sink, () => {
      const k = identKey(d.name)
      const clash = own.get(k)
      if (clash) throw duplicateName('declaration', d.name, clash.name, d.pos)
      const g = globals.get(k)
      if (!g) throw new StError(`VAR_EXTERNAL '${d.name}' names no VAR_GLOBAL`, d.pos, d.name.length)
      if (!sameDataType(d.type, g.type) || declTypeName(d).toUpperCase() !== declTypeName(g).toUpperCase()) {
        throw new StError(`VAR_EXTERNAL '${d.name}' is declared ${declTypeName(d)}, but the VAR_GLOBAL is ${declTypeName(g)}`, d.pos, d.name.length)
      }
      if (g.constant && !d.constant) {
        throw new StError(`VAR_EXTERNAL '${d.name}' must be declared CONSTANT, because the VAR_GLOBAL it names is`, d.pos, d.name.length)
      }
      d.name = g.name // the global's spelling, like every other reference to it
    })
  }
  return externals
}
