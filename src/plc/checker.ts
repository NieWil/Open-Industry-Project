// The IEC 61131-3 type checker. It resolves every name and type in a parsed program and annotates
// every expression with its IEC type, or reports why the program is not one this subset (and a
// real IEC compiler) would build. The interpreter, the emitter and both exporters consume the
// annotated AST it hands back; none of them re-derives a type.
//
// It is the strict IEC rule set, and it is separate from the runtime for that reason:
// what a checked program means lives in program.ts and interpreter.ts, what IEC permits lives
// here.

import { checkConfiguration, checkLocated } from './checkConfiguration'
import { checkFieldDefaults } from './checkInit'
import { callablesOf, checkHierarchy, checkNoFbRecursion, checkNoFunctionRecursion, checkPointerDecl, checkStructDefs, prepareClasses } from './checkPous'
import { collect, type EnumMemberMap, type PouScope, rejectedTypes, type Scope } from './checkScope'
import { checkBody } from './checkStmt'
import { buildEnv, buildExternals, definedType, duplicateName, foldCapacities, registerConstant, resolveAlias, resolveReturnType, type TypeDefs } from './checkTypeDefs'
import { lex } from './lexer'
import { parse } from './parser'
import { type CheckedProgram, containsFb, controllerTags, type EnumDefMap, type Env, type FbDefMap, funcDecls, type FuncDefMap, identKey, type InterfaceDefMap, type StructDefMap, type SubrangeDefMap } from './program'
import { isBitString, isInt, wrap } from './runtime'
import type { AliasDef, Ast, Decl, Diagnostic, FbDef, FuncDef, ProgramDef } from './types'
import { isArray, StError } from './types'

/** Cap on reported diagnostics: past this the list is noise, and one bad paste should not
 *  hand the editor thousands of markers to render. */
const MAX_DIAGNOSTICS = 100

/** Lex, parse, and type-check every POU. Returns the annotated AST + def maps. Throws StError. */
export function parseAndCheck(source: string): CheckedProgram {
  if (kept && kept.source === source) {
    const { program } = kept
    kept = null
    return program
  }
  return checkAst(parse(lex(source), null), null)
}

// A realm that both lists a program's problems and compiles it (the editor's program worker) reads the text once for
// the two: `diagnostics` keeps the program it checked when that found no error, and the next `parseAndCheck` of the
// same text takes it. With no error the two checks do the same work, and a warning is only something said beside it.
// The program is handed out once, because whoever gets a checked program may write to it. Off unless asked for: a
// kept program is the whole tree, held until it is taken.
let keeping = false
let kept: { source: string; program: CheckedProgram } | null = null
/** Whether `diagnostics` keeps the program it checked for the next `parseAndCheck` of the same text. */
export function keepCheckedPrograms(on: boolean): void {
  keeping = on
  kept = null
}

/** The checking core. With a `sink` it records what it can and keeps going; without one the
 *  first problem throws. Both paths run the same checks, so the editor never accepts
 *  something `compile()` would refuse. */
function checkAst(ast: Ast, sink: Diagnostic[] | null): CheckedProgram {
  const structDefs: StructDefMap = new Map()
  for (const def of ast.typeDefs) {
    const prev = structDefs.get(identKey(def.name))
    if (prev) throw duplicateName('type', def.name, prev.name, def.pos)
    const seen = new Map<string, string>()
    for (const f of def.fields) {
      const before = seen.get(identKey(f.name))
      if (before) {
        const why = before === f.name ? '' : ` ('${before}' is already declared; identifiers are case-insensitive)`
        throw new StError(`duplicate field '${f.name}' in '${def.name}'${why}`, f.pos, f.name.length)
      }
      seen.set(identKey(f.name), f.name)
    }
    structDefs.set(identKey(def.name), def)
  }
  const subrangeDefs: SubrangeDefMap = new Map()
  for (const def of ast.subrangeDefs) {
    const prev = definedType(structDefs, subrangeDefs, def.name)
    if (prev) throw duplicateName('type', def.name, prev, def.pos)
    if (!isInt(def.base)) throw new StError(`a subrange base must be an integer type, not ${def.base}`, def.pos, def.name.length)
    if (wrap(def.base, def.lo) !== def.lo || wrap(def.base, def.hi) !== def.hi) {
      throw new StError(`${def.lo}..${def.hi} does not fit in ${def.base}`, def.pos, def.name.length)
    }
    subrangeDefs.set(identKey(def.name), def)
  }

  const enumDefs: EnumDefMap = new Map()
  const enumMembers: EnumMemberMap = new Map()
  for (const def of ast.enumDefs) {
    const prev = structDefs.get(identKey(def.name)) ?? enumDefs.get(identKey(def.name))
    if (prev) throw duplicateName('type', def.name, prev.name, def.pos)
    enumDefs.set(identKey(def.name), def)
    if (def.base !== undefined) {
      const base = def.base
      if (!isInt(base) && !isBitString(base)) throw new StError(`an enumeration's base type is an integer type, not ${base}`, def.basePos ?? def.pos, base.length)
      // the members are held as INT whatever the base type says (types.ts EnumDef.base)
      const big = def.members.find((m) => wrap('INT', m.value) !== m.value)
      if (big) throw new StError(`enumeration value ${big.value} of '${big.name}' does not fit in INT, which is what an enumeration's values are held as here, whatever its base type`, big.pos, big.name.length)
    }
    for (const m of def.members) {
      // Members are visible unqualified, so two enumerations cannot share one. `Mode#Idle` is
      // accepted too, but the clash is still refused, so a bare member name is never ambiguous.
      const clash = enumMembers.get(identKey(m.name))
      if (clash) throw new StError(`enumeration member '${m.name}' is already a member of ${clash.enum}`, m.pos, m.name.length)
      enumMembers.set(identKey(m.name), { name: m.name, enum: def.name, value: m.value })
    }
  }
  const aliasDefs = new Map<string, AliasDef>()
  for (const def of ast.aliasDefs) {
    const k = identKey(def.name)
    const prev = (structDefs.get(k) ?? enumDefs.get(k) ?? subrangeDefs.get(k) ?? aliasDefs.get(k))?.name
    if (prev) throw duplicateName('type', def.name, prev, def.pos)
    // a named array is one type under that name, so the name travels with the array itself
    if (isArray(def.type) && def.type.named === undefined) def.type.named = def.name
    aliasDefs.set(k, def)
  }
  const fbDefs: FbDefMap = new Map()
  const ifaceDefs: InterfaceDefMap = new Map()
  const funcDefs: FuncDefMap = new Map()
  const programDefs = new Map<string, ProgramDef>()
  /** Struct / FB / INTERFACE / FUNCTION / PROGRAM names share one namespace, so a collision in any of them is a
   *  duplicate definition - including one that differs only in case. */
  const definedAs = (name: string): string | undefined =>
    (structDefs.get(identKey(name)) ?? enumDefs.get(identKey(name)) ?? subrangeDefs.get(identKey(name)) ?? aliasDefs.get(identKey(name)) ?? fbDefs.get(identKey(name)) ?? ifaceDefs.get(identKey(name)) ?? funcDefs.get(identKey(name)) ?? programDefs.get(identKey(name)))?.name

  for (const def of ast.fbDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    fbDefs.set(identKey(def.name), def)
  }
  for (const def of ast.interfaceDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    ifaceDefs.set(identKey(def.name), def)
  }
  for (const def of ast.funcDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    funcDefs.set(identKey(def.name), def)
  }
  for (const def of ast.programDefs) {
    const prev = definedAs(def.name)
    if (prev) throw duplicateName('definition', def.name, prev, def.pos)
    programDefs.set(identKey(def.name), def)
  }
  checkNoFunctionRecursion(funcDefs)
  checkHierarchy(ast, fbDefs, ifaceDefs, sink)
  // Beside a CONFIGURATION, the variables outside every POU are the top-level variables: one namespace
  // with the VAR_GLOBALs, seen by every POU. One is a VAR, VAR_INPUT or VAR_OUTPUT, and it cannot share
  // a name with a global.
  const globalDecls = [...ast.globals]
  for (const d of controllerTags(ast)) {
    const g = ast.globals.find((x) => identKey(x.name) === identKey(d.name))
    const why =
      d.section === 'VAR_IN_OUT' || d.section === 'VAR_TEMP'
        ? `'${d.name}' is outside every POU, which makes it a top-level variable, and a top-level variable is declared in VAR, VAR_INPUT or VAR_OUTPUT, not ${d.section}`
        : g
          ? `'${d.name}' is outside every POU, which makes it a top-level variable, and VAR_GLOBAL '${g.name}' already has that name`
          : null
    if (why === null) globalDecls.push(d)
    else collect(sink, () => {
      throw new StError(why, d.pos, d.name.length)
    })
  }
  // The program's global integer CONSTANTs are known before any type is resolved, so a struct
  // field, a named array type or any declaration can size an array with one.
  const constants = new Map<string, number>()
  for (const d of globalDecls) registerConstant(d, constants)
  const defs: TypeDefs = { structs: structDefs, enums: enumDefs, fbs: fbDefs, ifaces: ifaceDefs, programs: programDefs, aliases: aliasDefs, resolving: new Set(), constants, globalConstants: constants }
  foldCapacities(ast, constants, sink)
  checkStructDefs(defs)
  // every named type is resolved whether or not anything uses it, so a bad one is reported where
  // it is written rather than only at its first use
  for (const def of ast.aliasDefs) collect(sink, () => resolveAlias(def, defs))

  // VAR_GLOBALs are checked first, in a scope with no globals of their own, so a global's
  // initializer can only reference literals and earlier globals - never a POU local. A global
  // may hold a function-block instance like any other variable.
  const globalEnv = buildEnv(globalDecls, defs, subrangeDefs, sink)
  // Every POU's INTERFACE is resolved before any body is checked. A body reads other POUs'
  // declarations (a block's outputs, a function's inputs and result), and those must be resolved
  // types by then, in whatever order the POUs were written: an output declared `Pkg` is only a
  // name until its own POU's declarations have been through buildEnv.
  // A POU's VAR_EXTERNALs are checked against the globals, beside its own env rather than in it.
  const pouScope = (decls: Decl[]): PouScope => {
    const own = decls.filter((d) => d.section !== 'VAR_EXTERNAL')
    const env = buildEnv(own, defs, subrangeDefs, sink)
    const externals = buildExternals(decls.filter((d) => d.section === 'VAR_EXTERNAL'), env, globalEnv, defs, subrangeDefs, sink)
    return { own, env, externals }
  }
  const fbScopes = new Map(ast.fbDefs.map((def) => [def, pouScope(def.decls)] as const))
  // the classes: what each inherits, its methods' declarations, its table of callables (and the
  // interfaces', whose signatures they implement)
  const instanceEnvs = new Map<FbDef, Env>()
  const methodScopes = prepareClasses(ast, fbDefs, ifaceDefs, fbScopes, instanceEnvs, pouScope, defs, subrangeDefs, sink)
  collect(sink, () => checkNoFbRecursion(fbDefs, structDefs))
  // where a REF_TO and an interface variable may stand (checkPointerDecl)
  const pointerRule = (decls: readonly Decl[], home: Parameters<typeof checkPointerDecl>[1]): void => {
    for (const d of decls) if (!rejectedTypes.has(d)) collect(sink, () => checkPointerDecl(d, home))
  }
  pointerRule(globalDecls, 'global')
  for (const def of ast.fbDefs) pointerRule(def.decls, 'block')
  for (const def of ast.funcDefs) pointerRule(def.decls, 'function')
  for (const def of ast.programDefs) pointerRule(def.decls, 'program')
  pointerRule(ast.decls, 'program')
  const funcScopes = new Map<FuncDef, { decls: Decl[]; scope: PouScope }>()
  for (const def of ast.funcDefs) {
    collect(sink, () => resolveReturnType(def, defs, subrangeDefs))
    const decls = funcDecls(def)
    funcScopes.set(def, { decls, scope: pouScope(decls) })
  }
  const programScopes = new Map(ast.programDefs.map((def) => [def, pouScope(def.decls)] as const))
  // beside a CONFIGURATION the code outside every POU owns no variables (they are the tags above), only
  // the VAR_EXTERNALs it declares
  const main = pouScope(ast.configuration ? ast.decls.filter((d) => d.section === 'VAR_EXTERNAL') : ast.decls)

  // a fresh forVars per scope: the set tracks the FOR loops open around the statement being
  // checked, so it must not leak from one POU's body into the next
  const scopeFor = (p: PouScope): Scope => ({ env: p.env, externals: p.externals, globals: globalEnv, fbs: fbDefs, funcs: funcDefs, structs: structDefs, enums: enumDefs, enumMembers, forVars: new Set(), ifaces: ifaceDefs })
  // a struct field's default may read a global CONSTANT, and nothing else a POU declares
  checkFieldDefaults(structDefs, { env: new Map(), externals: new Map(), globals: globalEnv, fbs: fbDefs, funcs: funcDefs, structs: structDefs, enums: enumDefs, enumMembers, forVars: new Set(), ifaces: ifaceDefs }, sink)
  checkBody(globalDecls, [], { env: globalEnv, externals: new Map(), globals: new Map(), fbs: fbDefs, funcs: funcDefs, structs: structDefs, enums: enumDefs, enumMembers, forVars: new Set(), ifaces: ifaceDefs }, sink)

  for (const def of ast.fbDefs) {
    const p = fbScopes.get(def)!
    // a block's body sees every variable it holds, inherited ones too; THIS is the instance it runs on
    const instance = instanceEnvs.get(def) ?? p.env
    collect(sink, () => checkBody(p.own, def.body, { ...scopeFor(p), env: instance, self: { cls: def } }, sink))
    // each method: its own variables, over the instance's (a method's of the same name hides one)
    for (const m of callablesOf(def)) {
      if (m.bodyless) continue
      const ms = methodScopes.get(m)!
      const env: Env = new Map([...instance, ...ms.env])
      collect(sink, () => checkBody(ms.own, m.body, { ...scopeFor(ms), env, self: { cls: def, method: m } }, sink))
    }
  }
  for (const def of ast.funcDefs) {
    const { decls, scope: funcScope } = funcScopes.get(def)!
    if (containsFb(def.ret, structDefs)) {
      throw new StError(`a function cannot return a function-block instance: '${def.name}'`, def.pos, def.name.length)
    }
    // A result type has to be a type name, and an ARRAY spelled out in place is not one: both
    // external compilers refuse it there (MATIEC "invalid return type defined in function
    // declaration", STruC++ "Expected `Identifier`, found `ARRAY`"). A named array
    // type is a type name, so `FUNCTION Pair : Row` is fine.
    if (isArray(def.ret) && def.ret.named === undefined) {
      throw new StError(
        `a FUNCTION result must be a type name, and an ARRAY written out in place is not one: '${def.name}' (declare TYPE Name : ARRAY ... and return that)`,
        def.pos,
        def.name.length,
      )
    }
    for (const d of decls) {
      // however deep it sits: an array of timers, or a struct with one in a field, is state too
      if (containsFb(d.type, structDefs)) throw new StError(`a function cannot contain function-block instances (use a FUNCTION_BLOCK): '${d.name}'`, d.pos, d.name.length)
      // functions are called positionally in expressions, which gives no place to write
      // back through - so VAR_IN_OUT belongs to function blocks here
      if (d.section === 'VAR_IN_OUT') throw new StError(`a function cannot take VAR_IN_OUT (use a FUNCTION_BLOCK): '${d.name}'`, d.pos, d.name.length)
    }
    checkBody(funcScope.own, def.body, { ...scopeFor(funcScope), inFunction: true }, sink)
  }
  for (const def of ast.programDefs) {
    const p = programScopes.get(def)!
    collect(sink, () => {
      const io = def.decls.find((d) => d.section === 'VAR_IN_OUT')
      if (io) {
        throw new StError(
          `a PROGRAM cannot take VAR_IN_OUT here: only a CONFIGURATION's instance wiring could hand it a place, and that is not implemented ('${io.name}')`,
          io.pos,
          io.name.length,
        )
      }
    })
    collect(sink, () => checkBody(p.own, def.body, scopeFor(p), sink))
  }
  if (ast.configuration) {
    // Everything this check raises is about the CONFIGURATION, even where it points into the code (statements no instance
    // runs), so it is marked, collected or thrown: with a controller table, the table is what fixes it.
    const from = sink?.length ?? 0
    try {
      checkConfiguration(ast.configuration, programDefs, fbDefs, funcDefs, globalEnv, ast.body, sink)
    } catch (e) {
      if (e instanceof StError) e.origin = 'configuration'
      throw e
    }
    for (const d of sink?.slice(from) ?? []) d.origin = 'configuration'
  } else if (ast.programDefs.length > 1) {
    const second = ast.programDefs[1]!
    collect(sink, () => {
      throw new StError(
        `${ast.programDefs.length} PROGRAMs are declared, and no CONFIGURATION says which task runs each one; declare one: CONFIGURATION ... TASK ... PROGRAM <instance> WITH <task> : <type>; ... END_CONFIGURATION`,
        second.pos,
        7,
      )
    })
  }
  checkBody(main.own, ast.body, scopeFor(main), sink)
  // every declaration's type is resolved by now, which the size rule reads
  checkLocated(
    [
      { decls: ast.globals, home: 'global' },
      { decls: ast.decls, home: 'program' },
      ...ast.programDefs.map((def) => ({ decls: def.decls, home: 'program' as const })),
      ...ast.fbDefs.map((def) => ({ decls: def.decls, home: 'block' as const })),
      ...ast.funcDefs.map((def) => ({ decls: def.decls, home: 'function' as const })),
    ],
    ast.configuration,
    programDefs,
    sink,
  )

  // a lone PROGRAM with no CONFIGURATION is the implicit program, under its own name
  const implicit = !ast.configuration && ast.programDefs.length === 1 ? programScopes.get(ast.programDefs[0]!)! : main
  return { ast, env: implicit.env, fbDefs, funcDefs, structDefs, enumDefs, ifaceDefs }
}

// A text's diagnostics do not change until the text does, and one edit has several callers: the ladder view, the
// text editor's linter, and the controller check, which checks both the program and the program with its table
// appended. Each parses and type-checks a whole program. Results are kept for the few texts in play; what comes back
// is a copy, so a caller may sort or filter it.
const remembered = new Map<string, Diagnostic[]>()
function once(kind: string, source: string, work: () => Diagnostic[]): Diagnostic[] {
  const key = `${kind}::${source}`
  let found = remembered.get(key)
  if (found) remembered.delete(key) // (re-inserted below: a Map keeps insertion order, so this is the LRU)
  else found = work()
  remembered.set(key, found)
  if (remembered.size > 8) remembered.delete(remembered.keys().next().value!)
  return found.map((d) => ({ ...d }))
}

/** Whether a program parses: its syntax errors alone, positioned, with no type-check. */
export function syntaxDiagnostics(source: string): Diagnostic[] {
  // Uses the full check when it is already known or about to be requested (the controller check requests both for
  // the same text). The full check type-checks only a program that parses, so for one that does not, its findings
  // are exactly the syntax errors, and for one that does, there are none. The text is parsed once, not twice.
  return once('syntax', source, () => {
    const all = diagnostics(source, MAX_DIAGNOSTICS)
    const clean = parsesClean.get(source)
    return all.length > 0 && clean === false ? all : clean === true ? [] : syntaxDiagnosticsOf(source)
  })
}
/** whether the last full check of a text found it to parse (`diagnosticsOf` says; a few texts, like `remembered`) */
const parsesClean = new Map<string, boolean>()
function syntaxDiagnosticsOf(source: string): Diagnostic[] {
  const out: Diagnostic[] = []
  try {
    parse(lex(source), out)
  } catch (e) {
    if (!(e instanceof StError)) throw e
    out.push({ message: e.message, pos: e.pos, length: e.length })
  }
  return out.sort((a, b) => a.pos.offset - b.pos.offset).slice(0, MAX_DIAGNOSTICS)
}

/**
 * Non-throwing front-end for editor squiggles: lex / parse / type-check and return
 * any error as a positioned `Diagnostic` (empty array when the program is valid). The
 * parser and checker stop at the first `StError`, so this reports the first error only;
 * collecting the full set at once would need parser error recovery (a later refactor).
 */
/** `limit`: an editor wants the first hundred; an importer marking every rung it could not build wants them all. */
export function diagnostics(source: string, limit = MAX_DIAGNOSTICS): Diagnostic[] {
  return once(`check:${limit}`, source, () => diagnosticsOf(source, limit))
}
function diagnosticsOf(source: string, limit: number): Diagnostic[] {
  const out: Diagnostic[] = []
  try {
    const ast = parse(lex(source), out)
    parsesClean.set(source, out.length === 0)
    if (parsesClean.size > 8) parsesClean.delete(parsesClean.keys().next().value!)
    // Type-check only once the program parses. Checking a partial AST reports cascades of
    // consequences - "undeclared variable" for everything after a broken VAR block - that
    // bury the one real mistake, so syntax errors are reported on their own.
    if (out.length === 0) {
      const program = checkAst(ast, out)
      if (keeping && out.every((d) => d.severity === 'warning')) kept = { source, program }
    }
  } catch (e) {
    // something the recovery could not absorb: a bad character, an unterminated block
    if (!(e instanceof StError)) throw e // not a source-level error (a bug) - don't swallow it
    out.push({ message: e.message, pos: e.pos, length: e.length, ...(e.origin ? { origin: e.origin } : {}) })
  }
  const seen = new Set<string>()
  return out
    .filter((d) => {
      const k = `${d.pos.offset}:${d.message}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.pos.offset - b.pos.offset)
    .slice(0, limit)
}
