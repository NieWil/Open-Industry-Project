// Calls, references and interfaces for the type checker: argument binding, method calls, access to PRIVATE and
// PROTECTED members, and what a REF_TO or an interface variable may be given.

import { checkAssignable, checkStore } from './checkAssign'
import { infer, inferType, throughFbOutput } from './checkExpr'
import { AlreadyReported, lookup, placeRoot, placeText, sameDataType, type Scope, typeName } from './checkScope'
import { containsFb, type FbDefMap, identKey, type InterfaceDefMap, isFb, isScalarType, methodDecls } from './program'
import type { DataType, Decl, Expr, FbArg, MethodDef, RefType, ScalarType, SourcePos } from './types'
import { DEFAULT_STRING_LEN, isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/** Check an output binding (`Q => place`): the destination must be a writable place that
 *  can hold the member's type. Same rules as an assignment, because that is what it is. A whole
 *  array or struct output is copied out, so it needs a place of exactly its type; the result says
 *  whether this binding is such a copy. */
export function checkOutBinding(place: Expr, memberType: DataType, what: string, scope: Scope): boolean {
  const root = placeRoot(place)
  if (!root) throw new StError(`'${what}' must be bound to a variable`, place.pos)
  const decl = lookup(scope, root)
  if (decl?.constant) throw new StError(`cannot bind ${what} into CONSTANT '${decl.name}'`, place.pos)
  const pt = inferType(place, scope)
  if (isFb(pt) || isUserFb(pt)) throw new StError(`cannot bind ${what} into a function-block instance`, place.pos)
  const owned = throughFbOutput(place)
  if (owned) throw new StError(`cannot bind ${what} into function-block output '${owned.field}'`, place.pos)
  if (isArray(memberType) || isStruct(memberType)) {
    if (!sameDataType(pt, memberType)) {
      throw new StError(`cannot bind ${what} (${typeName(memberType)}) into a place of type ${typeName(pt)}`, place.pos)
    }
    return true
  }
  if (isArray(pt) || isStruct(pt)) throw new StError(`cannot bind ${what} into an aggregate`, place.pos)
  // an enumeration output goes only into a place of that same enumeration, and nothing else does
  if (isEnum(memberType) || isEnum(pt)) {
    if (!(isEnum(memberType) && isEnum(pt) && identKey(memberType.enum) === identKey(pt.enum))) {
      throw new StError(`cannot bind ${what} (${typeName(memberType)}) into a place of type ${typeName(pt)}`, place.pos)
    }
    return false
  }
  if (isInterface(pt) || isRef(pt) || isInterface(memberType) || isRef(memberType)) throw new StError(`cannot bind ${what} into '${placeText(place)}': an interface is assigned an instance, and a REF_TO a reference (r := REF(place))`, place.pos)
  checkAssignable(memberType as ScalarType, pt, what, place.pos)
  return false
}

/** What a variable designates rather than holds: 'ref' for a REF_TO named by itself (not dereferenced), 'iface' for an
 *  interface variable, null for anything else (typed as a side effect, which resolves its spelling). */
export function pointerOf(e: Expr, scope: Scope): 'ref' | 'iface' | null {
  // an element of an array of interfaces
  if (e.node === 'index') {
    const at = inferType(e.obj, scope)
    if (!isArray(at) || !isInterface(at.elem)) return null
    inferType(e, scope)
    return 'iface'
  }
  if (e.node !== 'var' || e.qualifier !== undefined || e.ref) return null
  const d = lookup(scope, e.name)
  if (!d || (!isRef(d.type) && !isInterface(d.type))) return null
  inferType(e, scope)
  return isRef(d.type) ? 'ref' : 'iface'
}

/** `NULL`, the reference to nothing (where no variable of that name is declared). */
export function isNull(e: Expr, scope: Scope): boolean {
  return e.node === 'var' && !e.ref && e.qualifier === undefined && identKey(e.name) === 'NULL' && !lookup(scope, e.name)
}

/** Whether class `cls` is `base` or derives from it, through any number of EXTENDS. */
function derivesFrom(cls: string, base: string, fbs: FbDefMap): boolean {
  for (let at = fbs.get(identKey(cls)); at; at = at.extends ? fbs.get(identKey(at.extends.name)) : undefined) {
    if (identKey(at.name) === identKey(base)) return true
  }
  return false
}

/** Whether interface `sub` is `iface` or extends it, through any number of EXTENDS. */
export function ifaceExtends(sub: string, iface: string, ifaces: InterfaceDefMap, seen = new Set<string>()): boolean {
  const k = identKey(sub)
  if (k === identKey(iface)) return true
  if (seen.has(k)) return false
  seen.add(k)
  return (ifaces.get(k)?.extends ?? []).some((x) => ifaceExtends(x.name, iface, ifaces, seen))
}

/** Whether an instance of class `cls` is an `iface`: it, or a class it derives from, IMPLEMENTS that interface or one
 *  that extends it. */
function implementsIface(cls: string, iface: string, fbs: FbDefMap, ifaces: InterfaceDefMap): boolean {
  for (let at = fbs.get(identKey(cls)); at; at = at.extends ? fbs.get(identKey(at.extends.name)) : undefined) {
    if ((at.implements ?? []).some((i) => ifaceExtends(i.name, iface, ifaces))) return true
  }
  return false
}

/** May the code being checked call `m`? PRIVATE: only the class that declares it; PROTECTED: that class and the ones
 *  derived from it; PUBLIC and INTERNAL: anyone. */
function checkAccess(m: MethodDef, scope: Scope, pos: SourcePos): void {
  const what = `method '${m.name}'`
  if (m.access === 'PRIVATE' && (!scope.self || identKey(scope.self.cls.name) !== identKey(m.owner ?? ''))) {
    throw new StError(`${what} is PRIVATE to '${m.owner}': only its own body and methods may use it`, pos, m.name.length)
  }
  if (m.access === 'PROTECTED' && (!scope.self || !derivesFrom(scope.self.cls.name, m.owner ?? '', scope.fbs))) {
    throw new StError(`${what} is PROTECTED: only '${m.owner}' and the blocks derived from it may use it`, pos, m.name.length)
  }
}

/** Whether a place lives only as long as the call running now: a variable of the method or FUNCTION whose code this is. */
export function temporary(place: Expr, scope: Scope): boolean {
  const root = placeRoot(place)
  if (root === null) return false
  const k = identKey(root)
  if (scope.self?.method) return methodDecls(scope.self.method).some((d) => identKey(d.name) === k)
  return !!scope.inFunction && scope.env.has(k)
}

/**
 * What a REF_TO may be given a reference to (`r := REF(place)`, or `REF(place)` passed to a REF_TO input): a place - a
 * variable, a structure's field, an array's element, an instance - of exactly the type it refers to (an instance of a
 * class derived from it, for a block), that is not a CONSTANT, not a block's output, and outlives the reference.
 * `lasting`: the reference outlives the call running now (a block's input, any variable but a method's own), so a
 * temporary would leave it referring to nothing.
 */
function checkRefSource(src: Expr, ref: RefType, scope: Scope, what: string, lasting: boolean): void {
  const placeLike = src.node === 'var' || src.node === 'member' || src.node === 'index' || src.node === 'this'
  if (!placeLike || src.node === 'this' && src.super) throw new StError(`${what}: REF() takes a place - a variable, a field, an element - not a value`, src.pos)
  const st = inferType(src, scope)
  const root = placeRoot(src)
  const rootDecl = root ? lookup(scope, root) : undefined
  if (rootDecl?.constant) throw new StError(`${what} cannot refer to CONSTANT '${rootDecl.name}': it would write through to it`, src.pos)
  if (src.node === 'var' && !src.ref && rootDecl && isRef(rootDecl.type)) throw new StError(`${what}: '${src.name}' is a REF_TO, so REF(${src.name}) would be a reference to a reference: give its reference on as it is (${src.name}), or REF(${src.name}^) for what it refers to`, src.pos)
  const owned = throughFbOutput(src)
  if (owned) throw new StError(`${what} cannot refer to function-block output '${owned.field}', which only the block writes`, src.pos)
  if (lasting && temporary(src, scope) && !(src.node === 'var' && src.ref)) {
    throw new StError(`${what} cannot refer to '${placeText(src)}': it is a temporary of the ${scope.self?.method ? 'method' : 'function'} running, gone when it returns, while the reference stays`, src.pos)
  }
  const want = ref.ref
  if (isUserFb(want) && isUserFb(st)) {
    if (!derivesFrom(st.fb, want.fb, scope.fbs)) throw new StError(`${what} refers to ${want.fb}, and '${placeText(src)}' is a ${st.fb}, which is not derived from it`, src.pos)
    return
  }
  if (!sameDataType(st, want)) throw new StError(`${what} refers to ${typeName(want)}, and '${placeText(src)}' is ${typeName(st)}: a reference refers to a place of exactly its type`, src.pos)
  if (want === 'STRING' && (src.node === 'var' || src.node === 'member' || src.node === 'index') && (src.maxLen ?? DEFAULT_STRING_LEN) !== (ref.maxLen ?? DEFAULT_STRING_LEN)) {
    throw new StError(`${what} refers to STRING[${ref.maxLen ?? DEFAULT_STRING_LEN}], and '${placeText(src)}' holds ${src.maxLen ?? DEFAULT_STRING_LEN} characters: their capacities must match`, src.pos)
  }
}

/**
 * What a REF_TO is given (`r := ...;`, or a REF_TO input's argument): `REF(place)`, another REF_TO variable by its own
 * name (its reference copied, NULL included), or NULL. Answers the place (or the other REF_TO, `alias`), or null for NULL.
 */
export function refValue(v: Expr, ref: RefType, scope: Scope, what: string, lasting: boolean): { source: Expr | null; alias?: true } {
  if (isNull(v, scope)) return { source: null }
  if (v.node === 'call' && identKey(v.name) === 'REF' && !scope.funcs.has('REF')) {
    if (v.args.length !== 1 || v.names) throw new StError('REF takes one place: REF(x)', v.pos, v.name.length)
    const place = v.args[0]!
    checkRefSource(place, ref, scope, what, lasting)
    return { source: place }
  }
  if (v.node === 'var' && !v.ref && pointerOf(v, scope) === 'ref') {
    const from = lookup(scope, v.name)!.type as RefType
    const want = ref.ref
    const ok = isUserFb(want) && isUserFb(from.ref) ? derivesFrom(from.ref.fb, want.fb, scope.fbs) : sameDataType(from.ref, want) && (want !== 'STRING' || (from.maxLen ?? DEFAULT_STRING_LEN) === (ref.maxLen ?? DEFAULT_STRING_LEN))
    if (!ok) throw new StError(`${what} refers to ${typeName(want)}, and '${v.name}' is ${typeName(from)}: a reference is given one of exactly its type`, v.pos)
    return { source: v, alias: true }
  }
  if (v.node === 'num' && v.value === 0 && !v.real) throw new StError(`${what} is a REF_TO: give it NULL for no reference, not 0`, v.pos)
  throw new StError(`${what} is a REF_TO: give it a reference, REF(place), another REF_TO, or NULL`, v.pos)
}

/** What an interface may be pointed at: an instance (THIS included) of a class implementing it, another interface
 *  variable of it or of one extending it, or 0 (or NULL) - nothing. Returns false for nothing. */
export function checkIfaceSource(src: Expr, iface: string, scope: Scope, what: string): boolean {
  if (src.node === 'num' && src.value === 0 && !src.real && src.declared === undefined) return false
  if (isNull(src, scope)) return false
  if (src.node === 'this' && src.super) throw new StError(`${what}: SUPER^ is not an instance of its own; use THIS`, src.pos, 6)
  const placeLike = src.node === 'var' || src.node === 'member' || src.node === 'index' || src.node === 'this'
  if (!placeLike) throw new StError(`${what} refers to an instance: give it a function-block instance, or 0`, src.pos)
  const st = inferType(src, scope)
  if (isInterface(st)) {
    if (!ifaceExtends(st.iface, iface, scope.ifaces)) throw new StError(`${what} is a ${iface}, and '${placeText(src)}' is a ${st.iface}, which does not extend it`, src.pos)
    return true
  }
  if (!isUserFb(st)) throw new StError(`${what} refers to an instance of a block implementing ${iface}, and '${placeText(src)}' is ${typeName(st)}`, src.pos)
  if (!implementsIface(st.fb, iface, scope.fbs, scope.ifaces)) throw new StError(`'${placeText(src)}' is a ${st.fb}, which does not implement ${iface}`, src.pos)
  return true
}

/**
 * A call's arguments against the parameters it reaches - a function block's (its own and inherited) or a method's.
 * `what` names the callee in a message (`'Motor'`). An input takes a value (a REF_TO input a reference, an interface
 * input an instance), an output `=>` a place it is copied into, an in-out a place it reads and writes through.
 * `lasting`: the callee keeps what its inputs are given past the call (a block does; a method does not).
 */
export function checkCallArgs(args: FbArg[], decls: readonly Decl[], what: string, scope: Scope, lasting: boolean): void {
  const inputs = new Map(decls.filter((x) => x.section === 'VAR_INPUT').map((x) => [identKey(x.name), x]))
  const inouts = new Map(decls.filter((x) => x.section === 'VAR_IN_OUT').map((x) => [identKey(x.name), x]))
  const outputs = new Map(decls.filter((x) => x.section === 'VAR_OUTPUT').map((x) => [identKey(x.name), x]))
  for (const a of args) {
    // a VAR_IN_OUT parameter binds to a place the block reads and writes through
    const io = a.out ? undefined : inouts.get(identKey(a.name))
    if (io) {
      a.name = io.name
      a.inout = true
      if (!placeRoot(a.value)) throw new StError(`'${io.name}' is VAR_IN_OUT, so it needs a variable, not an expression`, a.pos)
      const root = lookup(scope, placeRoot(a.value)!)
      if (root?.constant) throw new StError(`cannot pass CONSTANT '${root.name}' as VAR_IN_OUT '${io.name}'`, a.pos)
      const at = inferType(a.value, scope)
      // a block's output is its own to write, so it is no place for another block to write through
      const owned = throughFbOutput(a.value)
      if (owned) throw new StError(`cannot pass function-block output '${owned.field}' as VAR_IN_OUT '${io.name}'`, a.pos)
      if (!isScalarType(io.type) && !isArray(io.type) && !isStruct(io.type) && !isEnum(io.type)) {
        throw new StError(`'${io.name}' cannot be VAR_IN_OUT (function-block instances are not passable)`, a.pos)
      }
      if (!sameDataType(at, io.type)) {
        throw new StError(`VAR_IN_OUT '${io.name}' needs exactly ${typeName(io.type)}, got ${typeName(at)}`, a.pos)
      }
      // the in-out stands for the caller's variable, so a STRING's capacity is part of its type here: a longer
      // parameter would write text the variable has no room for
      if (io.type === 'STRING') {
        const want = io.maxLen ?? DEFAULT_STRING_LEN
        const v = a.value
        const got = (v.node === 'var' || v.node === 'member' || v.node === 'index' ? v.maxLen : undefined) ?? DEFAULT_STRING_LEN
        if (want !== got) throw new StError(`VAR_IN_OUT '${io.name}' needs exactly STRING[${want}], got STRING[${got}]`, a.pos)
      }
      continue
    }
    if (a.out) {
      const out = outputs.get(identKey(a.name))
      if (!out || isFb(out.type) || isUserFb(out.type)) throw new StError(`${what} has no readable output '${a.name}'`, a.pos, a.name.length)
      a.name = out.name
      if (checkOutBinding(a.value, out.type, `${what} output '${out.name}'`, scope)) a.copy = true
      continue
    }
    const declared = inputs.get(identKey(a.name))
    if (!declared) throw new StError(`${what} has no input '${a.name}'`, a.pos, a.name.length)
    a.name = declared.name
    if (isRef(declared.type)) {
      if (a.bind === 'ref') continue // checked already (refValue rewrote the argument)
      const given = refValue(a.value, declared.type, scope, `${what} input '${declared.name}'`, lasting)
      a.bind = 'ref'
      if (given.source === null) a.value = { node: 'num', value: 0, real: false, pos: a.value.pos, t: 'UDINT' }
      else a.value = given.source
      if (given.alias) a.alias = true
      continue
    }
    if (isInterface(declared.type)) {
      a.bind = 'iface'
      checkIfaceSource(a.value, declared.type.iface, scope, `${what} input '${declared.name}'`)
      continue
    }
    // a whole array or struct input is passed by value, copied into the block's own storage,
    // so it needs exactly the declared type and cannot carry an instance along
    if (isArray(declared.type) || isStruct(declared.type)) {
      if (containsFb(declared.type, scope.structs)) {
        throw new StError(`${what} input '${declared.name}' holds function-block instances, which cannot be passed by value (declare it VAR_IN_OUT)`, a.pos)
      }
      const at = inferType(a.value, scope)
      if (!sameDataType(at, declared.type)) {
        throw new StError(`${what} input '${declared.name}' needs ${typeName(declared.type)}, got ${typeName(at)}`, a.pos)
      }
      a.copy = true
      continue
    }
    const at = infer(a.value, scope)
    if (isScalarType(declared.type)) checkStore(a.value, at, declared.type, `${what} input '${declared.name}'`, a.pos)
  }
}

/** The METHOD a call statement's target names, if it names one: `m.Reset`, `THIS.Run`, `itf.Move`, `SUPER^.Run`, or
 *  the block's own `Run` by its bare name (where no variable has that name). */
export function methodTarget(target: Expr, scope: Scope): { obj: Expr; name: string } | null {
  if (target.node === 'var') {
    if (!scope.self || lookup(scope, target.name)) return null
    return scope.self.cls.table?.has(identKey(target.name)) ? { obj: { node: 'this', pos: target.pos }, name: target.name } : null
  }
  if (target.node !== 'member') return null
  const ot = inferType(target.obj, scope)
  if (isInterface(ot)) return { obj: target.obj, name: target.field }
  const owner = isUserFb(ot) ? scope.fbs.get(identKey(ot.fb)) : undefined
  // an instance's member called: a method, or no method at all, which checkMcall says (a block's member is never a
  // block that could be called)
  if (owner) return { obj: target.obj, name: target.field }
  return null
}

/**
 * A METHOD call (or SUPER^()): which class's callables it reaches and how the implementation
 * is found (Expr `mcall`), its arguments, its result. `asStatement`: called for what it does, so it may return nothing.
 */
export function checkMcall(e: Extract<Expr, { node: 'mcall' }>, scope: Scope, asStatement: boolean): DataType {
  const ot = inferType(e.obj, scope)
  let table: Map<string, MethodDef> | undefined
  let where: string
  if (e.obj.node === 'this') {
    table = scope.fbs.get(identKey(e.obj.cls!))?.table
    where = e.obj.cls!
    e.dispatch = e.obj.super ? 'static' : 'self'
    e.cls = e.obj.cls!
  } else if (isUserFb(ot)) {
    const def = scope.fbs.get(identKey(ot.fb))
    // a type that names no block is its own error, reported where it is declared
    if (!def) throw new AlreadyReported(`'${ot.fb}' is not a declared function block`, e.obj.pos)
    table = def.table
    where = def.name
    // an instance declared of a class is of that class; one a REF_TO refers to (r^) may be of a derived one
    e.dispatch = e.obj.node === 'var' && e.obj.ref ? 'dynamic' : 'static'
    e.cls = def.name
  } else if (isInterface(ot)) {
    const def = scope.ifaces.get(identKey(ot.iface))
    if (!def) throw new AlreadyReported(`'${ot.iface}' is not a declared interface`, e.obj.pos)
    table = def.table
    where = def.name
    e.dispatch = 'dynamic'
    e.cls = def.name
  } else {
    if (isRef(ot)) throw new StError(`'${placeText(e.obj)}' is a REF_TO: dereference it to call a method of what it refers to, ${placeText(e.obj)}^.${e.method}(...)`, e.obj.pos)
    throw new StError(`'${placeText(e.obj)}' has no methods: only a function-block instance, an interface or THIS has`, e.obj.pos)
  }
  if (e.body) {
    // SUPER^(): the base class's own body, on this instance; its inputs are this instance's, already set
    if (e.args.length) throw new StError('SUPER^() runs the base class\'s body on this instance, whose inputs are already set: it takes no arguments', e.pos)
    return 'BOOL'
  }
  const key = identKey(e.method)
  const m = table?.get(key)
  if (!m) throw new StError(`'${where}' has no method '${e.method}'`, e.pos)
  if (e.dispatch === 'static' && m.bodyless) {
    throw new StError(`${e.obj.node === 'this' ? `SUPER^.${m.name}` : `'${m.name}'`}: the method is ABSTRACT in '${m.owner}', so there is nothing to run`, e.pos)
  }
  checkAccess(m, scope, e.pos)
  e.key = key
  e.sig = m
  e.method = m.name
  // a call that gives its arguments in order, as a block call may (`m.Start(5, TRUE)`): inputs and in-outs, declared order
  if (e.args.some((a) => a.positional)) {
    const order = m.decls.filter((x) => x.section === 'VAR_INPUT' || x.section === 'VAR_IN_OUT')
    if (e.args.length > order.length) throw new StError(`'${m.name}' takes ${order.length} argument(s), got ${e.args.length}`, e.args[order.length]!.pos)
    e.args.forEach((a, i) => {
      if (a.positional) a.name = order[i]!.name
    })
  }
  const seen = new Set<string>()
  for (const a of e.args) {
    if (seen.has(identKey(a.name))) throw new StError(`'${m.name}' parameter '${a.name}' is given twice`, a.pos, a.name.length)
    seen.add(identKey(a.name))
  }
  checkCallArgs(e.args, m.decls, `'${m.name}'`, scope, false)
  if (m.ret === null) {
    if (!asStatement) throw new StError(`'${m.name}' returns nothing, so it is called as a statement of its own: ${placeText(e.obj)}.${m.name}(...);`, e.pos)
    return 'BOOL'
  }
  if (isEnum(m.ret)) {
    e.t = 'INT'
    e.enum = m.ret.enum
  } else if (isScalarType(m.ret)) e.t = m.ret
  if (m.retMaxLen !== undefined) e.maxLen = m.retMaxLen
  return m.ret
}
