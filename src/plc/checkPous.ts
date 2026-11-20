// Whole-program checks on the POUs: no recursion through functions or function blocks, no struct that contains
// itself, the class and interface hierarchy, and method signatures.

import { isBuiltinFunc } from './builtins'
import { ifaceExtends } from './checkCalls'
import { collect, designates, type PouScope, rejectedTypes, sameDataType, typeName } from './checkScope'
import { capacityOf, resolveDataType, type TypeDefs } from './checkTypeDefs'
import { containsFb, type Env, fbDecls, type FbDefMap, type FuncDefMap, identKey, type InterfaceDefMap, isFb, methodDecls, type StructDefMap, type SubrangeDefMap } from './program'
import type { Ast, Decl, DeclType, Diagnostic, Expr, FbDef, InterfaceDef, InterfaceRef, MethodDef, StructDef, Stmt, UserFbRef } from './types'
import { DEFAULT_STRING_LEN, isArray, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/** Names of functions called anywhere in a statement list (for recursion detection). */
function collectCalledFunctions(body: Stmt[]): Set<string> {
  const out = new Set<string>()
  const ve = (e: Expr): void => {
    switch (e.node) {
      case 'call': out.add(identKey(e.name)); e.args.forEach(ve); break
      case 'member': case 'bit': case 'isref': ve(e.obj); break
      case 'mcall': ve(e.obj); e.args.forEach((a) => ve(a.value)); break
      case 'index': ve(e.obj); e.indices.forEach(ve); break
      case 'unary': ve(e.expr); break
      case 'binary': ve(e.left); ve(e.right); break
      default: break // num / bool / var have no nested calls
    }
  }
  const vs = (s: Stmt): void => {
    switch (s.node) {
      case 'assign': ve(s.target); ve(s.value); break
      case 'fbcall': ve(s.target); s.args.forEach((a) => ve(a.value)); break
      case 'if': s.branches.forEach((b) => { ve(b.cond); b.body.forEach(vs) }); s.elseBody?.forEach(vs); break
      case 'case': ve(s.selector); s.cases.forEach((c) => c.body.forEach(vs)); s.elseBody?.forEach(vs); break
      case 'for': ve(s.from); ve(s.to); if (s.by) ve(s.by); s.body.forEach(vs); break
      case 'while': ve(s.cond); s.body.forEach(vs); break
      case 'repeat': ve(s.cond); s.body.forEach(vs); break
      case 'exit': break
      case 'invoke': ve(s.call); break
      case 'bind': ve(s.target); if (s.source) ve(s.source); break
    }
  }
  body.forEach(vs)
  return out
}

/** Reject (in)direct function recursion at compile time - the interpreter assumes a DAG. */
export function checkNoFunctionRecursion(funcDefs: FuncDefMap): void {
  const calls = new Map<string, Set<string>>()
  for (const [name, def] of funcDefs) calls.set(name, collectCalledFunctions(def.body))
  const state = new Map<string, 0 | 1 | 2>() // unvisited / on-stack / done
  const visit = (name: string): void => {
    const st = state.get(name) ?? 0
    if (st === 2) return
    if (st === 1) throw new StError(`recursive function '${funcDefs.get(name)!.name}'`, funcDefs.get(name)!.pos)
    state.set(name, 1)
    for (const callee of calls.get(name) ?? []) if (funcDefs.has(callee)) visit(callee)
    state.set(name, 2)
  }
  for (const name of funcDefs.keys()) visit(name)
}

/** The function blocks a type holds instances of: the type itself, an array's elements, a struct's fields at any
 *  depth. The same walk the interpreter's `zeroData` takes to build one. */
function heldFbs(t: DeclType, structs: StructDefMap, out: string[] = [], seen: Set<string> = new Set()): string[] {
  if (isUserFb(t)) out.push(identKey(t.fb))
  else if (isArray(t)) heldFbs(t.elem, structs, out, seen)
  else if (isStruct(t)) {
    const k = identKey(t.struct)
    if (seen.has(k)) return out // a recursive struct is its own error (checkStructDefs)
    seen.add(k)
    for (const f of structs.get(k)?.fields ?? []) heldFbs(f.type, structs, out, seen)
  }
  return out
}

/** Reject a function block that holds an instance of itself, directly or through another block, an array or a
 *  struct: the instance would never finish being built. The interpreter only finds one while building it, so
 *  without this check `compile()` refused a program the editor had passed as clean. Runs once every POU's
 *  declarations are resolved. */
export function checkNoFbRecursion(fbDefs: FbDefMap, structs: StructDefMap): void {
  const state = new Map<string, 0 | 1 | 2>() // unvisited / on-stack / done
  const visit = (name: string): void => {
    state.set(name, 1)
    const def = fbDefs.get(name)!
    for (const d of fbDecls(def)) {
      if (d.section === 'VAR_EXTERNAL') continue // owns no storage, so builds no instance (interpreter buildPou)
      for (const held of heldFbs(d.type, structs)) {
        const st = state.get(held) ?? 0
        if (st === 1) throw new StError(`recursive function block '${fbDefs.get(held)!.name}': '${d.name}' in '${def.name}' holds an instance of it`, d.pos, d.name.length)
        if (st === 0 && fbDefs.has(held)) visit(held)
      }
    }
    state.set(name, 2)
  }
  for (const name of fbDefs.keys()) if ((state.get(name) ?? 0) === 0) visit(name)
}

/** The structs a struct contains by value (directly or as array elements). */
function structDeps(def: StructDef): string[] {
  const deps: string[] = []
  for (const f of def.fields) {
    if (isStruct(f.type)) deps.push(f.type.struct)
    else if (isArray(f.type) && isStruct(f.type.elem)) deps.push(f.type.elem.struct)
  }
  return deps
}

/** Resolve struct field types, and reject by-value struct recursion (infinite size). Runs once the
 *  function blocks are known as well, because a field may be an instance of one. */
export function checkStructDefs(defs: TypeDefs): void {
  const structDefs = defs.structs
  for (const def of structDefs.values()) {
    for (const f of def.fields) {
      const cap = f.maxLen === undefined ? capacityOf(f.type, defs) : undefined
      f.type = resolveDataType(f.type, defs, f.pos)
      if (cap !== undefined) f.maxLen = cap
      if (designates(f.type)) {
        throw new StError(`field '${f.name}' of '${def.name}' is (or holds) a REF_TO or an interface, which a structure cannot hold here: a reference or an interface is a variable of a POU's own`, f.pos, f.name.length)
      }
    }
  }
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (name: string): void => {
    const st = state.get(name) ?? 0
    if (st === 2) return
    if (st === 1) throw new StError(`recursive struct '${structDefs.get(name)!.name}'`, structDefs.get(name)!.pos)
    state.set(name, 1)
    for (const dep of structDeps(structDefs.get(name)!)) if (structDefs.has(identKey(dep))) visit(identKey(dep))
    state.set(name, 2)
  }
  for (const name of structDefs.keys()) visit(name)
}

/**
 * Every EXTENDS and IMPLEMENTS names what it must - a block a block, an interface an interface - and no class or
 * interface derives from itself. Runs before any type is resolved, so what comes after may follow a chain to its root.
 * A link found wrong is dropped (after it is reported), so a tolerant check carries on without it.
 */
export function checkHierarchy(ast: Ast, fbs: FbDefMap, ifaces: InterfaceDefMap, sink: Diagnostic[] | null): void {
  for (const def of ast.fbDefs) {
    const ext = def.extends
    if (ext) {
      collect(sink, () => {
        const base = fbs.get(identKey(ext.name))
        if (!base) {
          delete def.extends
          throw new StError(ifaces.has(identKey(ext.name)) ? `'${ext.name}' is an INTERFACE: a block IMPLEMENTS an interface and EXTENDS a block` : `unknown function block '${ext.name}' to derive '${def.name}' from`, ext.pos, ext.name.length)
        }
        if (base.final) {
          delete def.extends
          throw new StError(`'${base.name}' is FINAL, so no block derives from it`, ext.pos, ext.name.length)
        }
        ext.name = base.name
      })
    }
    for (const i of def.implements ?? []) {
      collect(sink, () => {
        const iface = ifaces.get(identKey(i.name))
        if (!iface) {
          def.implements = def.implements!.filter((x) => x !== i)
          throw new StError(fbs.has(identKey(i.name)) ? `'${i.name}' is a FUNCTION_BLOCK: a block EXTENDS a block and IMPLEMENTS interfaces` : `unknown interface '${i.name}'`, i.pos, i.name.length)
        }
        i.name = iface.name
      })
    }
  }
  for (const def of ast.fbDefs) {
    const seen = new Set<string>()
    for (let at: FbDef | undefined = def; at?.extends; at = fbs.get(identKey(at.extends.name))) {
      if (seen.has(identKey(at.name))) {
        const ext = def.extends!
        delete def.extends
        collect(sink, () => {
          throw new StError(`'${def.name}' derives from itself (through EXTENDS ${ext.name})`, ext.pos, ext.name.length)
        })
        break
      }
      seen.add(identKey(at.name))
    }
  }
  for (const def of ast.interfaceDefs) {
    for (const x of def.extends) {
      collect(sink, () => {
        const parent = ifaces.get(identKey(x.name))
        if (!parent) {
          def.extends = def.extends.filter((y) => y !== x)
          throw new StError(fbs.has(identKey(x.name)) ? `'${x.name}' is a FUNCTION_BLOCK: an interface extends interfaces` : `unknown interface '${x.name}'`, x.pos, x.name.length)
        }
        x.name = parent.name
        if (ifaceExtends(parent.name, def.name, ifaces)) {
          def.extends = def.extends.filter((y) => y !== x)
          throw new StError(`interface '${def.name}' extends itself (through ${parent.name})`, x.pos, x.name.length)
        }
      })
    }
  }
}

/** The parameters a method's callers see - its inputs, outputs and in-outs, in order - and its result: what an override
 *  and an interface's implementation must repeat exactly. */
function sameSignature(a: MethodDef, b: MethodDef): boolean {
  const params = (m: MethodDef): Decl[] => m.decls.filter((d) => d.section === 'VAR_INPUT' || d.section === 'VAR_OUTPUT' || d.section === 'VAR_IN_OUT')
  if ((a.ret === null) !== (b.ret === null)) return false
  if (a.ret !== null && (!sameDataType(a.ret, b.ret!) || (a.retMaxLen ?? DEFAULT_STRING_LEN) !== (b.retMaxLen ?? DEFAULT_STRING_LEN))) return false
  const pa = params(a)
  const pb = params(b)
  return pa.length === pb.length && pa.every((d, i) => d.section === pb[i]!.section && identKey(d.name) === identKey(pb[i]!.name) && sameDataType(d.type, pb[i]!.type))
}

/** How a method is named in a message. */
function memberText(m: MethodDef): string {
  return `method '${m.name}'`
}

/** A block's or an interface's methods, as one list of callables. */
export function callablesOf(def: { methods?: MethodDef[] }): MethodDef[] {
  return def.methods ?? []
}

/**
 * A method's declarations resolved, its result type with them, and what it may declare checked: its
 * variables are temporary, so no function-block instance (it would start over on every call), and a result is a value
 * (not a whole array or structure, which no method here returns yet). Answers the scope its body is checked in.
 */
function prepareMethod(m: MethodDef, owner: string, pouScope: (decls: Decl[]) => PouScope, defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null): PouScope {
  m.owner = owner
  m.key = identKey(m.name)
  // this engine's rule: a method does not take a standard function's name. A target may read the name as the
  // function (ADD, MOVE), so such a name would not travel
  const k = identKey(m.name)
  if (isBuiltinFunc(k)) {
    collect(sink, () => {
      throw new StError(`'${m.name}' is the name of the standard function ${k}, and a method may not take that name: name it otherwise`, m.pos, m.name.length)
    })
  }
  if (m.ret !== null) {
    collect(sink, () => {
      const sr = isUserFb(m.ret!) ? subrangeDefs.get(identKey((m.ret as UserFbRef).fb)) : undefined
      if (sr) {
        m.ret = sr.base
        m.retRange = { lo: sr.lo, hi: sr.hi, name: sr.name }
        return
      }
      if (m.retMaxLen === undefined) m.retMaxLen = capacityOf(m.ret!, defs)
      m.ret = resolveDataType(m.ret!, defs, m.pos, m.name.length)
      // a whole array or structure, as a FUNCTION returns one: a type name, holding no block instance
      if (isArray(m.ret) && m.ret.named === undefined) throw new StError(`${memberText(m)}: a result must be a type name, and an ARRAY written out in place is not one (declare TYPE Name : ARRAY ... and return that)`, m.pos, m.name.length)
      if (designates(m.ret)) throw new StError(`${memberText(m)} returns interfaces, which refer to instances rather than hold values to hand back`, m.pos, m.name.length)
      if ((isArray(m.ret) || isStruct(m.ret)) && containsFb(m.ret, defs.structs)) throw new StError(`${memberText(m)} returns a value holding a function-block instance, which is state, not a value to hand back`, m.pos, m.name.length)
      if (isFb(m.ret) || isUserFb(m.ret) || isInterface(m.ret) || isRef(m.ret)) throw new StError(`${memberText(m)} returns ${typeName(m.ret)}, which is not a value: a method returns a number, a BOOL, a STRING, a TIME or an enumeration here`, m.pos, m.name.length)
    })
  }
  const scope = pouScope(methodDecls(m))
  for (const d of m.decls) {
    collect(sink, () => {
      if (rejectedTypes.has(d)) return
      if (containsFb(d.type, defs.structs)) throw new StError(`${memberText(m)} declares '${d.name}', which holds a function-block instance: a method's variables start over on every call, so declare it in the function block`, d.pos, d.name.length)
      if (d.section === 'VAR_EXTERNAL') return
      checkPointerDecl(d, 'method')
      if (d.location !== undefined) throw new StError(`'${d.name}' is located at ${d.location}, and a method cannot declare a located variable: locate it in the PROGRAM`, d.locationPos ?? d.pos, d.locationLength ?? d.name.length)
    })
  }
  return scope
}

/** Where a REF_TO or an interface variable may be declared: a POU's own VAR (or VAR_TEMP), a function block's or a
 *  method's VAR_INPUT (given by the call), and VAR_GLOBAL - never an output or an in-out, never in a FUNCTION, and never
 *  with an initial value (one is given a reference in the code, the other assigned an instance). */
export function checkPointerDecl(d: Decl, home: 'block' | 'method' | 'function' | 'program' | 'global'): void {
  if (!designates(d.type)) return
  const t = isArray(d.type) ? d.type.elem : d.type
  const kind = isArray(d.type) ? `an array of interface ${(t as InterfaceRef).iface}` : isRef(t) ? 'a REF_TO' : `an interface (${(t as InterfaceRef).iface})`
  // an array of them is bound element by element, so nothing passes one whole
  if (isArray(d.type) && d.section === 'VAR_INPUT') {
    throw new StError(`'${d.name}' is ${kind}, which is bound element by element: no call passes one whole, so declare it VAR`, d.pos, d.name.length)
  }
  const at = (msg: string): never => {
    throw new StError(`'${d.name}' is ${kind}, and ${msg}`, d.pos, d.name.length)
  }
  if (home === 'function') at('a FUNCTION cannot declare one here: it keeps nothing between calls, and its callers pass values (use a FUNCTION_BLOCK or a METHOD)')
  if (d.section === 'VAR_OUTPUT' || d.section === 'VAR_IN_OUT') at(`a ${d.section} cannot be one here: declare it VAR_INPUT (bound by the call) or VAR`)
  if (d.section === 'VAR_INPUT' && home !== 'block' && home !== 'method') at('only a function block or a method takes one as an input: nothing calls a PROGRAM to bind it')
  if (d.init || d.arrayInit || d.structInit) at(isRef(t) ? 'it has no initial value (it starts NULL): give it a reference in the code (r := REF(place);)' : 'it has no initial value: assign it an instance in the code (itf := instance;)')
  if (d.constant) at('it cannot be CONSTANT')
}

/**
 * Every class (function block) in an order where a base comes before what derives from it, and for each: what it
 * inherits, its methods' declarations resolved, and its table of callables - its own, then what it
 * inherits and does not override - checked against what IEC and every vendor require: an override repeats its base's
 * signature exactly and replaces nothing FINAL, a block that is not ABSTRACT implements everything (an ABSTRACT method
 * of a base, every method of every interface it IMPLEMENTS), and no member shares a name with a variable. Answers the
 * scope each method's body is checked in.
 */
export function prepareClasses(ast: Ast, fbs: FbDefMap, ifaces: InterfaceDefMap, fbScopes: Map<FbDef, PouScope>, instanceEnvs: Map<FbDef, Env>, pouScope: (decls: Decl[]) => PouScope, defs: TypeDefs, subrangeDefs: SubrangeDefMap, sink: Diagnostic[] | null): Map<MethodDef, PouScope> {
  const methodScopes = new Map<MethodDef, PouScope>()
  // the interfaces first: their signatures resolved, and each one's table (its own and its parents', parents first)
  const built = new Set<InterfaceDef>()
  const buildIface = (def: InterfaceDef): void => {
    if (built.has(def)) return
    built.add(def)
    const table = new Map<string, MethodDef>()
    for (const x of def.extends) {
      const parent = ifaces.get(identKey(x.name))
      if (!parent) continue
      buildIface(parent)
      for (const [k, m] of parent.table!) {
        const had = table.get(k)
        if (had && had !== m && !sameSignature(had, m)) {
          collect(sink, () => {
            throw new StError(`interface '${def.name}' inherits ${memberText(m)} twice, with two different signatures (from ${had.owner} and ${m.owner})`, x.pos, x.name.length)
          })
        }
        table.set(k, m)
      }
    }
    const own = new Map<string, MethodDef>()
    for (const m of callablesOf(def)) {
      methodScopes.set(m, prepareMethod(m, def.name, pouScope, defs, subrangeDefs, sink))
      collect(sink, () => {
        if (own.has(m.key!)) throw new StError(`interface '${def.name}' declares ${memberText(m)} twice`, m.pos, m.name.length)
        own.set(m.key!, m)
        const inherited = table.get(m.key!)
        if (inherited && !sameSignature(inherited, m)) throw new StError(`interface '${def.name}' redeclares ${memberText(m)} of '${inherited.owner}' with a different signature`, m.pos, m.name.length)
      })
      table.set(m.key!, m)
    }
    def.table = table
  }
  for (const def of ast.interfaceDefs) buildIface(def)

  // the classes, every base before what derives from it (checkHierarchy broke every cycle)
  const order: FbDef[] = []
  const placed = new Set<FbDef>()
  const place = (def: FbDef): void => {
    if (placed.has(def)) return
    placed.add(def)
    const base = def.extends ? fbs.get(identKey(def.extends.name)) : undefined
    if (base) place(base)
    order.push(def)
  }
  for (const def of ast.fbDefs) place(def)

  for (const def of order) {
    const base = def.extends ? fbs.get(identKey(def.extends.name)) : undefined
    const own = fbScopes.get(def)!
    def.inherited = base ? fbDecls(base) : []
    const env: Env = new Map(base ? instanceEnvs.get(base)! : [])
    for (const [k, d] of own.env) {
      const was = env.get(k)
      if (was) {
        collect(sink, () => {
          throw new StError(`'${d.name}' is already a variable of '${base!.name}', which '${def.name}' derives from`, d.pos, d.name.length)
        })
        continue
      }
      env.set(k, d)
    }
    instanceEnvs.set(def, env)
    const table = new Map<string, MethodDef>(base?.table ?? [])
    const mine = new Map<string, MethodDef>()
    for (const m of callablesOf(def)) {
      methodScopes.set(m, prepareMethod(m, def.name, pouScope, defs, subrangeDefs, sink))
      collect(sink, () => {
        if (env.has(identKey(m.name))) throw new StError(`'${m.name}' is a variable of '${def.name}', and a method cannot share its name`, m.pos, m.name.length)
        if (mine.has(m.key!)) throw new StError(`'${def.name}' declares ${memberText(m)} twice`, m.pos, m.name.length)
        mine.set(m.key!, m)
        if (m.abstract && !def.abstract) throw new StError(`${memberText(m)} is ABSTRACT, and only an ABSTRACT block may have one (FUNCTION_BLOCK ABSTRACT ${def.name})`, m.pos, m.name.length)
        const inherited = table.get(m.key!)
        if (inherited) {
          if (inherited.final) throw new StError(`${memberText(m)} is FINAL in '${inherited.owner}', so '${def.name}' cannot override it`, m.pos, m.name.length)
          if (!sameSignature(inherited, m)) throw new StError(`${memberText(m)} overrides the one of '${inherited.owner}', so it takes and returns exactly what that one does`, m.pos, m.name.length)
        } else if (m.override) {
          throw new StError(`${memberText(m)} is OVERRIDE, and '${def.name}' inherits no method of that name to override`, m.pos, m.name.length)
        }
      })
      table.set(m.key!, m)
    }
    def.table = table
    if (!def.abstract) {
      for (const m of table.values()) {
        if (!m.bodyless) continue
        collect(sink, () => {
          throw new StError(`'${def.name}' is not ABSTRACT, so it implements ${memberText(m)}, which is ABSTRACT in '${m.owner}' (or it is declared FUNCTION_BLOCK ABSTRACT itself)`, def.pos, 14)
        })
      }
    }
    for (const i of def.implements ?? []) {
      const iface = ifaces.get(identKey(i.name))
      for (const sig of iface?.table?.values() ?? []) {
        collect(sink, () => {
          const impl = table.get(sig.key!)
          if (!impl) {
            if (def.abstract) return
            throw new StError(`'${def.name}' IMPLEMENTS ${i.name}, and has no ${memberText(sig)} (declared by ${sig.owner})`, i.pos, i.name.length)
          }
          if (!sameSignature(impl, sig)) throw new StError(`${memberText(impl)} of '${def.name}' implements the one of interface ${sig.owner}, so it takes and returns exactly what that one does`, impl.pos, impl.name.length)
          if (impl.access === 'PRIVATE' || impl.access === 'PROTECTED') throw new StError(`${memberText(impl)} implements interface ${sig.owner}, so it is PUBLIC (it is ${impl.access})`, impl.pos, impl.name.length)
        })
      }
    }
  }
  return methodScopes
}
