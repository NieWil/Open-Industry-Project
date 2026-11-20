// Initial values for the type checker: declared initializers, struct field defaults, and the initial value a
// declaration takes when it gives none.

import { isBuiltinFunc } from './builtins'
import { checkStore } from './checkAssign'
import { infer } from './checkExpr'
import { collect, exprEnum, type Scope } from './checkScope'
import { fbDecls, identKey, isFb, isScalarType, type StructDefMap } from './program'
import type { ArrayType, Initializer, StructInit, StructRef, DataType, Decl, Diagnostic, SourcePos, StructDef, UserFbRef } from './types'
import { isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/** Type-check a declaration's initial value: a single value, an array's element list, or a struct's
 *  field list, nested as deep as the type is. */
export function checkDeclInit(d: Decl, scope: Scope): void {
  if (isRef(d.type) || isInterface(d.type)) return // takes none, which checkPointerDecl says
  if (d.arrayInit) {
    if (!isArray(d.type)) throw new StError(`'${d.name}' is not an array, so it cannot take a [...] initializer`, d.pos, d.name.length)
    checkArrayInit(d.arrayInit, d.type, `'${d.name}'`, d.pos, scope, d.name.length)
    return
  }
  if (d.structInit) {
    if (isUserFb(d.type)) return checkFbInit(d.structInit, d.type, `'${d.name}'`, scope)
    if (!isStruct(d.type)) throw new StError(`'${d.name}' is not a struct, so it cannot take a (field := ...) initializer`, d.structInit.pos)
    checkStructInit(d.structInit, d.type, `'${d.name}'`, scope)
    return
  }
  if (!d.init) return
  // An instance has no single value to start from. Accepting one would drop the initialiser
  // silently, and the program would run without what its author wrote.
  if (isFb(d.type) || isUserFb(d.type)) {
    throw new StError(`'${d.name}' is a function-block instance, which cannot take an initial value`, d.init.pos)
  }
  // a whole array or struct has no single value to start from either; the value would be dropped
  if (isArray(d.type) || isStruct(d.type)) {
    throw new StError(`'${d.name}' is ${isArray(d.type) ? 'an array' : 'a struct'}, so it cannot take a single initial value`, d.init.pos)
  }
  const vt = infer(d.init, scope)
  // an enumeration starts at a member of its own enumeration: the same rule as a store into it
  if (isEnum(d.type) || exprEnum(d.init)) {
    const want = isEnum(d.type) ? d.type.enum : null
    const got = exprEnum(d.init)
    if (want !== got) {
      throw new StError(`cannot initialise '${d.name}' of type ${want ? `enumeration ${want}` : vt} with ${got ? `enumeration ${got}` : vt}`, d.init.pos)
    }
    return
  }
  if (isScalarType(d.type)) checkStore(d.init, vt, d.type, `'${d.name}'`, d.init.pos)
}

/** An array's `[...]` list: exactly one value per element, each checked against the element type. */
function checkArrayInit(items: Initializer[], at: ArrayType, what: string, pos: SourcePos, scope: Scope, length = 1): void {
  const want = at.dims.reduce((n, dim) => n * (dim.hi - dim.lo + 1), 1)
  if (items.length !== want) throw new StError(`${what} needs ${want} initial value(s), got ${items.length}`, pos, length)
  for (const item of items) checkInitValue(item, at.elem, `${what} element`, scope)
}

/** A struct's `(field := value, ...)` list: every name a field of the struct, each named once, each
 *  value right for its field. A field not named keeps its zero. */
function checkStructInit(init: StructInit, st: StructRef, what: string, scope: Scope): void {
  const def = scope.structs.get(identKey(st.struct))
  if (!def) return // an unknown struct is its own error, reported where the type is named
  const seen = new Set<string>()
  for (const f of init.fields) {
    const field = def.fields.find((x) => identKey(x.name) === identKey(f.name))
    if (!field) throw new StError(`'${def.name}' has no field '${f.name}'`, f.pos, f.name.length)
    if (seen.has(identKey(field.name))) throw new StError(`${what} gives field '${field.name}' twice`, f.pos, f.name.length)
    seen.add(identKey(field.name))
    f.name = field.name
    checkInitValue(f.value, field.type, `${what} field '${field.name}'`, scope)
  }
}

/**
 * A function block instance's `(name := value, ...)` list: what this one instance starts with, in place of what the
 * block's own declarations say (IEC 61131-3 allows it). Each name is one of the block's own variables -
 * an input, an output or a local; an InOut is a reference and holds nothing - named once, its value right for it.
 */
function checkFbInit(init: StructInit, ref: UserFbRef, what: string, scope: Scope): void {
  const def = scope.fbs.get(identKey(ref.fb))
  if (!def) return // an unknown block is its own error, reported where the type is named
  const seen = new Set<string>()
  for (const f of init.fields) {
    const decl = fbDecls(def).find((x) => identKey(x.name) === identKey(f.name) && (x.section === 'VAR_INPUT' || x.section === 'VAR_OUTPUT' || x.section === 'VAR'))
    if (!decl) throw new StError(`'${def.name}' has no input, output or local '${f.name}' for an instance to start with a value of`, f.pos, f.name.length)
    if (isRef(decl.type) || isInterface(decl.type)) throw new StError(`'${decl.name}' is ${isRef(decl.type) ? 'a REF_TO' : 'an interface'}, which takes no initial value`, f.pos, f.name.length)
    if (seen.has(identKey(decl.name))) throw new StError(`${what} gives '${decl.name}' twice`, f.pos, f.name.length)
    seen.add(identKey(decl.name))
    f.name = decl.name
    checkInitValue(f.value, decl.type, `${what} member '${decl.name}'`, scope)
  }
}

/** One initial value, against the type of the place it starts. */
function checkInitValue(v: Initializer, t: DataType, what: string, scope: Scope): void {
  if (isUserFb(t) && v.node === 'structInit') return checkFbInit(v, t, what, scope)
  if (isFb(t) || isUserFb(t)) throw new StError(`${what} is a function-block instance, which cannot take an initial value`, v.pos)
  if (isStruct(t)) {
    if (v.node !== 'structInit') throw new StError(`${what} is a struct, so its initial value is a (field := ...) list`, v.pos)
    checkStructInit(v, t, what, scope)
    return
  }
  if (isArray(t)) {
    if (v.node !== 'arrayInit') throw new StError(`${what} is an array, so its initial value is a [...] list`, v.pos)
    checkArrayInit(v.items, t, what, v.pos, scope)
    return
  }
  if (v.node === 'structInit' || v.node === 'arrayInit') {
    throw new StError(`${what} is a single value, so it cannot take a ${v.node === 'structInit' ? '(field := ...)' : '[...]'} list`, v.pos)
  }
  const vt = infer(v, scope)
  // an enumeration starts at a member of its own enumeration, the same rule as a store into it
  if (isEnum(t) || exprEnum(v)) {
    const want = isEnum(t) ? t.enum : null
    const got = exprEnum(v)
    if (want !== got) throw new StError(`cannot initialise ${what} of type ${want ? `enumeration ${want}` : vt} with ${got ? `enumeration ${got}` : vt}`, v.pos)
    return
  }
  if (isInterface(t) || isRef(t)) throw new StError(`${what} is ${isRef(t) ? 'a REF_TO' : 'an interface'}, which takes no initial value`, v.pos)
  checkStore(v, vt, t, what, v.pos)
}

/**
 * A STRUCT field's default (`Speed : REAL := 1.5;`) is checked once, where the type is declared: right for the field,
 * and a CONSTANT - literals, enumeration members, global CONSTANTs and standard functions of them - since it is the
 * starting value of every variable of the type, in every POU, before anything runs. A default found wrong is dropped
 * after it is reported, so a tolerant check carries on without it.
 */
export function checkFieldDefaults(structs: StructDefMap, scope: Scope, sink: Diagnostic[] | null): void {
  for (const def of structs.values()) {
    for (const f of def.fields) {
      const init = f.init
      if (!init) continue
      const what = `the default of field '${f.name}' of '${def.name}'`
      let ok = false
      collect(sink, () => {
        checkInitValue(init, f.type, what, scope)
        const bad = notConstant(init, scope)
        if (bad) throw new StError(`${what} must be a constant (a literal, an enumeration member or a global CONSTANT): it is every variable's starting value, decided before anything runs`, bad.pos)
        ok = true
      })
      if (!ok) delete f.init
    }
  }
}

/** The first part of an initial value that is not a constant, or null. */
function notConstant(v: Initializer, scope: Scope): Initializer | null {
  switch (v.node) {
    case 'structInit':
      return v.fields.map((f) => notConstant(f.value, scope)).find(Boolean) ?? null
    case 'arrayInit':
      return v.items.map((i) => notConstant(i, scope)).find(Boolean) ?? null
    case 'var': {
      if (v.qualifier !== undefined) return null
      const g = scope.globals.get(identKey(v.name))
      if (g) return g.constant ? null : v
      return scope.enumMembers.has(identKey(v.name)) ? null : v
    }
    case 'unary':
      return notConstant(v.expr, scope)
    case 'binary':
      return notConstant(v.left, scope) ?? notConstant(v.right, scope)
    case 'call':
      return isBuiltinFunc(v.name) ? (v.args.map((a) => notConstant(a, scope)).find(Boolean) ?? null) : v
    case 'member':
    case 'index':
    case 'bit':
    case 'mcall':
    case 'this':
    case 'isref':
      return v
    default:
      return null // a literal
  }
}

/** The names an initial value reads, as written (an enumeration member qualified with its type is not one). */
function namesIn(v: Initializer, out: string[] = []): string[] {
  switch (v.node) {
    case 'structInit':
      v.fields.forEach((f) => namesIn(f.value, out))
      break
    case 'arrayInit':
      v.items.forEach((i) => namesIn(i, out))
      break
    case 'var':
      if (v.qualifier === undefined) out.push(v.name)
      break
    case 'unary':
      namesIn(v.expr, out)
      break
    case 'binary':
      namesIn(v.left, out)
      namesIn(v.right, out)
      break
    case 'call':
      v.args.forEach((a) => namesIn(a, out))
      break
    default:
      break
  }
  return out
}

const holdsDefaults = new WeakMap<StructDef, boolean>()
/** Does a value of this struct start anywhere but zero: a field with a default, or a struct (or array of them) that does. */
function structHoldsDefaults(def: StructDef, structs: StructDefMap): boolean {
  const known = holdsDefaults.get(def)
  if (known !== undefined) return known
  holdsDefaults.set(def, false) // a recursive struct is refused elsewhere; this only keeps the walk finite
  const inner = (t: DataType): boolean => {
    const st = isStruct(t) ? t : isArray(t) && isStruct(t.elem) ? t.elem : null
    const d = st ? structs.get(identKey(st.struct)) : undefined
    return d !== undefined && structHoldsDefaults(d, structs)
  }
  const yes = def.fields.some((f) => f.init !== undefined || inner(f.type))
  holdsDefaults.set(def, yes)
  return yes
}

/**
 * Fold the STRUCT field defaults into a declaration's initializer, so every engine (the walker, the typed engine, the
 * emitted TypeScript) starts the variable where the type says without knowing field defaults exist: a field the
 * program's own initializer names keeps that value, every other one gets its default, nested as deep as the type is.
 * What is added is marked `implied` for the exporters, which leave it out: the type declaration carries it.
 *
 * A default is a constant, but a bare name in one (an enumeration member, a global CONSTANT) is read where the
 * variable is declared, so a POU declaring the same name would quietly change it; that is refused by name.
 */
export function impliedInit(d: Decl, scope: Scope): void {
  if (d.init || isRef(d.type) || isInterface(d.type)) return
  const unshadowed = (v: Initializer): Initializer => {
    const clash = namesIn(v).find((n) => scope.env.has(identKey(n)))
    if (clash) throw new StError(`'${d.name}' starts with a struct field default that reads '${clash}', which this POU declares too: rename one, or qualify the enumeration member`, d.pos, d.name.length)
    return v
  }
  // `under`: the default the enclosing struct gives this whole value, beneath what the value itself names
  const structValue = (init: StructInit | undefined, st: StructRef, under?: StructInit): StructInit | undefined => {
    const def = scope.structs.get(identKey(st.struct))
    if (!def || (!under && !structHoldsDefaults(def, scope.structs))) return init
    const out: StructInit = init ? { ...init, fields: [...init.fields] } : { node: 'structInit', fields: [], pos: d.pos, implied: true }
    for (const f of def.fields) {
      const at = out.fields.findIndex((x) => identKey(x.name) === identKey(f.name))
      const given = at >= 0 ? out.fields[at]!.value : undefined
      const fromUnder = under?.fields.find((x) => identKey(x.name) === identKey(f.name))?.value
      const own = f.init ? unshadowed(f.init) : undefined
      let value: Initializer | undefined
      if (isStruct(f.type)) {
        // what this value names, over what the enclosing default names, over the field's own default
        const layers = [given, fromUnder, own].filter((x): x is StructInit => x?.node === 'structInit')
        value = layers.reduceRight<StructInit | undefined>((below, layer) => structValue(layer, f.type as StructRef, below), undefined) ?? structValue(undefined, f.type)
      } else if (isArray(f.type)) {
        const list = [given, fromUnder, own].find((x) => x?.node === 'arrayInit') as { items: Initializer[] } | undefined
        const items = arrayValue(list?.items, f.type)
        value = items ? { node: 'arrayInit', items, pos: d.pos } : undefined
      } else {
        value = given ?? fromUnder ?? own
      }
      if (at >= 0) out.fields[at] = { ...out.fields[at]!, value: value! }
      else if (value) out.fields.push({ name: f.name, value, pos: d.pos, implied: true })
    }
    return out
  }
  const arrayValue = (items: Initializer[] | undefined, at: ArrayType): Initializer[] | undefined => {
    if (!isStruct(at.elem)) return items
    const elem = at.elem
    const def = scope.structs.get(identKey(elem.struct))
    if (!def || !structHoldsDefaults(def, scope.structs)) return items
    if (items) return items.map((i) => (i.node === 'structInit' ? structValue(i, elem)! : i))
    // every element the same value, so one object stands for all of them: nothing downstream writes an initializer
    const one = structValue(undefined, elem)!
    return new Array<Initializer>(at.dims.reduce((n, dim) => n * (dim.hi - dim.lo + 1), 1)).fill(one)
  }
  if (isStruct(d.type)) d.structInit = structValue(d.structInit, d.type)
  else if (isArray(d.type)) d.arrayInit = arrayValue(d.arrayInit, d.type)
}
