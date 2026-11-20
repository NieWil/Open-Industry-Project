// ST -> TypeScript source emitter. This is not the execution path (the interpreter
// is). It exists to *show* a learner the generated TypeScript, or to export a
// program for a build step. It reuses the same runtime helpers as the interpreter
// so the semantics can't drift between "shown" and "executed".
//
// `ref` is the object a POU's variables live on: `S` for the main program, `this`
// inside an emitted function-block class, `F` inside an emitted function.

import { BUILTIN_RUNTIME_HELPERS, emitBuiltin, isBuiltinFunc } from './builtins'
import { parseAndCheck } from './checker'
import { controllerTags, fbDecls, identKey, methodDecls, passOrder, taskTable } from './program'
import { isCalendar, isInt, isInt32, isReal, isString, isTime } from './runtime'
import { isArray, isEnum, isInterface, isRef, isStruct, isUserFb } from './types'
import type { ArrayDim, ArrayType, Ast, DataType, Decl, DeclType, EnumDef, Expr, FbDef, FuncDef, Initializer, MethodDef, ScalarType, StructDef, StructRef, Stmt } from './types'

// struct defs for the program being emitted, so zero() can build full init objects
let emitStructDefs: Map<string, StructDef> = new Map()
// enum defs, so zero() can start an enumeration at its first member
let emitEnumDefs: Map<string, EnumDef> = new Map()
// function block defs, so an instance's initializer knows the type of each member it names
let emitFbDefs: Map<string, FbDef> = new Map()
// how many inputs each FUNCTION takes, so a call that leaves some out can pass the rest in their places
let emitFuncInputs: Map<string, number> = new Map()
// what a RETURN inside the POU currently being emitted has to hand back ('' for a program
// or a function block, whose scan/call methods return nothing)
let emitReturnExpr = ''
// set when the code emitted so far calls a function block, which passes it the clock (`now`)
let emitCallsBlock = false
// inside an emitted METHOD: its own variables (by identKey), which live on its frame `F`; the instance's are on `this`
let emitFrame: Set<string> | null = null

/** Where a variable lives in the emitted module: a method's frame `F`, the globals `G`, or the POU's own `ref`. */
function home(e: Extract<Expr, { node: 'var' }>, ref: string): string {
  if (emitFrame?.has(identKey(e.name))) return 'F'
  return e.global ? 'G' : ref
}

/** A method's name in the emitted class: one spelling for every override of it (identifiers are case-insensitive, and
 *  JavaScript's are not). */
function methodJs(m: MethodDef): string {
  return `m_${identKey(m.name)}`
}

/** What a REF_TO is given, as the emitted module holds it: `REF(place)`'s cell (placeCell), another REF_TO's own
 *  (`alias`, NULL too), or 0 for NULL. */
function refJs(e: Expr, alias: boolean | undefined, ref: string): string {
  if (alias && e.node === 'var') return `${home(e, ref)}.${e.name}`
  return placeCell(e, ref)
}

/** What a REF_TO refers to, as the emitted module holds it (runtime.ts RefCellJs): the record (or array) and the key
 *  of the place; REF(r^) is what r refers to. */
function placeCell(e: Expr, ref: string): string {
  switch (e.node) {
    case 'var':
      return e.ref ? `${home(e, ref)}.${e.name}` : `{ o: ${home(e, ref)}, k: '${e.name}' }`
    case 'this':
      return '{ o: { self: this }, k: \'self\' }'
    case 'member':
      return `{ o: ${emitExpr(e.obj, ref)}, k: '${e.field}' }`
    case 'index': {
      const dims = e.dims ?? []
      let out = emitExpr(e.obj, ref)
      e.indices.slice(0, -1).forEach((ix, k) => {
        out = `elemAt(${out}, ${emitExpr(ix, ref)}, ${dims[k]!.lo}, ${dims[k]!.hi})`
      })
      const last = e.indices.length - 1
      return `refElem(${out}, ${emitExpr(e.indices[last]!, ref)}, ${dims[last]!.lo}, ${dims[last]!.hi})`
    }
    default:
      return '0'
  }
}

/** What an interface is given in the emitted module: the instance object, or 0. */
function instanceJs(e: Expr, ref: string): string {
  if (e.node === 'this') return 'this'
  if (e.node === 'num') return '0'
  if (e.node === 'var' && !e.ref && emitIfaces.has(identKey(e.name) + '@' + home(e, ref))) return `${home(e, ref)}.${e.name}`
  return emitExpr(e, ref)
}
// the interface variables of the POU being emitted, as `NAME@home`: what instanceJs reads without dereferencing
let emitIfaces = new Set<string>()

/**
 * A METHOD call (or SUPER^()) in the emitted module: the method of the instance's own class, as the
 * engines dispatch it - JavaScript's own method lookup, since a block is a class and EXTENDS is `extends` - given its
 * arguments as an object, as a block's `call` is, and answering its frame, whose outputs and result the caller reads.
 */
function emitMethodCall(e: Extract<Expr, { node: 'mcall' }>, ref: string): { call: string; after: string[] } {
  emitCallsBlock = true
  // through an interface (a variable, an element): the instance it refers to, which must be one
  const iface = e.dispatch === 'dynamic' && !(e.obj.node === 'var' && e.obj.ref)
  const obj = e.obj.node === 'this' ? 'this' : iface ? `itfGet(${emitExpr(e.obj, ref)})` : emitExpr(e.obj, ref)
  if (e.body) return { call: `this.__body_${e.cls}(now)`, after: [] }
  const name = methodJs(e.sig!)
  const target = e.obj.node === 'this' && e.obj.super ? `super.${name}` : `${obj}.${name}`
  const args = e.args
    .filter((a) => !a.out)
    .map((a) => `${a.name}: ${a.bind === 'ref' ? refJs(a.value, a.alias, ref) : a.bind === 'iface' ? instanceJs(a.value, ref) : emitExpr(a.value, ref)}`)
  const after: string[] = []
  for (const a of e.args) {
    if (a.inout && a.value.t) after.push(emitStore(a.value, `__f.${a.name}`, ref))
    if (a.out) after.push(a.copy ? `copyData(${emitExpr(a.value, ref)}, __f.${a.name})` : emitStore(a.value, `__f.${a.name}`, ref))
  }
  return { call: `${target}({ ${args.join(', ')} }, now)`, after }
}

/** Inclusive value range of each integer type, for deciding if a widening preserves values. */
const INT_RANGE: Partial<Record<ScalarType, [number, number]>> = {
  SINT: [-128, 127], USINT: [0, 255], BYTE: [0, 255],
  INT: [-32768, 32767], UINT: [0, 65535], WORD: [0, 65535],
  DINT: [-2147483648, 2147483647], UDINT: [0, 4294967295], DWORD: [0, 4294967295],
}

/** True when assigning a `vt` value into a `tt` place can change the value - i.e. the
 *  interpreter's assignment coercion is not a no-op and the emitted code needs conv(). */
function needsConv(vt: ScalarType, tt: ScalarType): boolean {
  if (vt === tt) return false
  // a STRING never implicitly crosses to or from another kind - the checker rejects the
  // store long before this - so there is no conversion to emit
  if (isString(vt) || isString(tt)) return false
  if (tt === 'BOOL' || vt === 'BOOL') return true
  // REAL is f32, so only a value too wide for its 24-bit mantissa actually rounds;
  // everything <= 16 bits embeds exactly and stays bare for readability
  if (tt === 'REAL') return vt === 'DINT' || vt === 'DWORD' || vt === 'LREAL'
  if (tt === 'LREAL') return false // f64 holds every other type's values exactly
  if (isReal(vt)) return true // rounds ties-to-even
  const [vlo, vhi] = INT_RANGE[vt]!
  const [tlo, thi] = INT_RANGE[tt]!
  return vlo < tlo || vhi > thi
}

/** Emit an expression coerced into a scalar place, mirroring the interpreter's
 *  assignment semantics (implicit narrowing goes through the same conv() a learner
 *  would write explicitly; value-preserving widenings stay bare for readability). */
function emitCoerced(e: Expr, target: ScalarType | undefined, ref: string): string {
  const out = emitExpr(e, ref)
  return target && e.t && needsConv(e.t, target) ? `conv('${e.t}', '${target}', ${out})` : out
}

/** A declaration's scalar type, or undefined for aggregates / FB instances. */
function declScalar(t: DeclType): ScalarType | undefined {
  if (typeof t !== 'string') return undefined
  const s = t as ScalarType
  return s === 'BOOL' || isInt(s) || isReal(s) || isString(s) ? s : undefined
}

/** Apply a STRING place's declared capacity to the value being stored into it, mirroring
 *  the interpreter's truncating store. Non-STRING places pass straight through. */
function emitLimited(src: string, t: ScalarType | undefined, maxLen: number | undefined): string {
  return t === 'STRING' && maxLen !== undefined ? `strLimit(${src}, ${maxLen})` : src
}

function emitExpr(e: Expr, ref: string): string {
  switch (e.node) {
    case 'num':
      return String(e.value)
    case 'bool':
      return String(e.value)
    case 'str':
      return JSON.stringify(e.value)
    case 'var':
      // an enumeration member is a compile-time constant, so it emits as its value
      if (e.constValue !== undefined) return `${e.constValue} /* ${e.name} */`
      // a REF_TO dereferenced, r^, reads the place it refers to
      if (e.ref) return `refGet(${home(e, ref)}.${e.name})`
      // a VAR_GLOBAL lives on the module-level G, not on this POU's own state object
      return `${home(e, ref)}.${e.name}`
    case 'this':
      return 'this'
    case 'isref':
      // the slot itself: a variable, or an element (of an array of them)
      if (e.obj.node === 'index') return `(${emitExpr(e.obj, ref)} !== 0)`
      return `(${home(e.obj as Extract<Expr, { node: 'var' }>, ref)}.${(e.obj as Extract<Expr, { node: 'var' }>).name} !== 0)`
    case 'mcall': {
      const { call, after } = emitMethodCall(e, ref)
      const result = e.sig!.ret === null ? '0' : `__f.${e.sig!.name}`
      // the frame it answers holds its result; outputs and in-outs are stored from it first
      if (after.length === 0) return e.sig!.ret === null ? `(${call}, 0)` : `${call}.${e.sig!.name}`
      return `(() => { const __f = ${call}; ${after.join('; ')}; return ${result}; })()`
    }
    case 'member':
      return `${emitExpr(e.obj, ref)}.${e.field}`
    case 'bit':
      return `(((${emitExpr(e.obj, ref)} >>> ${e.bit}) & 1) === 1)`
    case 'index': {
      // each dimension is offset by its lower bound (interpreter stores 0-based JS arrays), and
      // bounds-checked on the way: a raw `[i - lo]` reads undefined where the interpreter faults
      const dims = e.dims ?? []
      let out = emitExpr(e.obj, ref)
      e.indices.forEach((ix, k) => {
        const d = dims[k]
        out = d ? `elemAt(${out}, ${emitExpr(ix, ref)}, ${d.lo}, ${d.hi})` : `${out}[${emitExpr(ix, ref)} - 0]`
      })
      return out
    }
    case 'call': {
      const args = e.args.map((a) => emitExpr(a, ref))
      if (isBuiltinFunc(e.name)) return emitBuiltin(e.name, e.t as ScalarType, args)
      // an input a formal call left out is passed as `undefined`, which the function fills with its start value
      const slots = e.slots
      if (slots) {
        const n = emitFuncInputs.get(e.name.toUpperCase()) ?? 0
        return `${e.name}(${Array.from({ length: n }, (_, i) => (slots.includes(i) ? args[slots.indexOf(i)] : 'undefined')).join(', ')})`
      }
      return `${e.name}(${args.join(', ')})`
    }
    case 'unary': {
      const inner = emitExpr(e.expr, ref)
      if (e.op === 'NOT') return e.t === 'BOOL' ? `(!${inner})` : `wrap('${e.t}', ~${inner})`
      if (e.op === 'NEG') return `wrap('${e.t}', -${inner})`
      return inner
    }
    case 'binary':
      return emitBinary(e, ref)
  }
}

function emitBinary(e: Extract<Expr, { node: 'binary' }>, ref: string): string {
  const l = emitExpr(e.left, ref)
  const r = emitExpr(e.right, ref)
  const t = e.t as ScalarType
  const op = e.op
  const cmp: Partial<Record<string, string>> = { '=': '===', '<>': '!==', '<': '<', '>': '>', '<=': '<=', '>=': '>=' }
  const c = cmp[op]
  if (c) return `(${l} ${c} ${r})`
  if (op === 'AND' || op === 'OR' || op === 'XOR') {
    // not `&&` / `||`: those stop at a decided operand, which is a semantics this engine does not
    // have. A helper call evaluates both arguments first. XOR needs both sides, so it stays an operator.
    if (t === 'BOOL') return op === 'XOR' ? `(${l} !== ${r})` : `${op === 'AND' ? 'andB' : 'orB'}(${l}, ${r})`
    return `wrap('${t}', ${l} ${op === 'AND' ? '&' : op === 'OR' ? '|' : '^'} ${r})`
  }
  // a TOD or DT sum faults outside its type's range, as the interpreter's does
  if (isCalendar(t)) return `calendarValue('${t}', ${l} ${op} ${r})`
  // MOD never reaches here - integers only. REAL rounds to f32 per operation (LREAL is f64).
  if (isReal(t)) return t === 'REAL' ? `wrap('REAL', ${l} ${op} ${r})` : `(${l} ${op} ${r})`
  if (op === '/') return `wrap('${t}', idiv(${l}, ${r}))`
  if (op === 'MOD') return `wrap('${t}', imod(${l}, ${r}))`
  if (op === '*' && isInt32(t)) return `wrap('${t}', Math.imul(${l} | 0, ${r} | 0))`
  return `wrap('${t}', ${l} ${op} ${r})`
}

/**
 * A store into a place. An indexed place is not a plain JS lvalue: `a[i - lo] = v` grows the array
 * where the interpreter faults. So the last index goes through elemSet() and the ones before it
 * through at(), which is the order assignPlace walks them.
 */
function emitStore(target: Expr, valueJs: string, ref: string): string {
  // a REF_TO dereferenced, r^, writes the place it refers to
  if (target.node === 'var' && target.ref) return `refSet(${home(target, ref)}.${target.name}, ${valueJs})`
  if (target.node !== 'index') return `${emitExpr(target, ref)} = ${valueJs}`
  const dims = target.dims ?? []
  const last = target.indices.length - 1
  const lastDim = dims[last]
  if (!lastDim) return `${emitExpr(target, ref)} = ${valueJs}` // no bounds known: a plain store
  let container = emitExpr(target.obj, ref)
  for (let k = 0; k < last; k++) {
    const d = dims[k]
    container = d ? `elemAt(${container}, ${emitExpr(target.indices[k]!, ref)}, ${d.lo}, ${d.hi})` : `${container}[${emitExpr(target.indices[k]!, ref)} - 0]`
  }
  return `elemSet(${container}, ${emitExpr(target.indices[last]!, ref)}, ${lastDim.lo}, ${lastDim.hi}, ${valueJs})`
}

/** A subrange place's bounds, applied to the value on its way in - the interpreter's checkRange,
 *  at the one call site it has (after the coercion, before the store). */
function emitRanged(valueJs: string, target: Expr): string {
  const r = target.node === 'var' || target.node === 'member' || target.node === 'index' ? target.range : undefined
  return r ? `inRange(${valueJs}, '${r.name}', ${r.lo}, ${r.hi})` : valueJs
}

function emitStmt(s: Stmt, ind: string, ref: string): string {
  switch (s.node) {
    case 'assign': {
      // a whole array or struct is copied into the target's own storage, as the interpreter does
      if (s.copy) return `${ind}copyData(${emitExpr(s.target, ref)}, ${emitExpr(s.value, ref)});`
      // one bit of a word: rewrite the word, wrapped to its own type, as the interpreter does. The word is a
      // place like any other, so an array element's goes through emitStore (elemSet), never `elemAt(..) = v`
      if (s.target.node === 'bit') {
        const word = emitExpr(s.target.obj, ref)
        const mask = 2 ** s.target.bit
        return `${ind}${emitStore(s.target.obj, `wrap('${s.target.obj.t}', (${emitCoerced(s.value, 'BOOL', ref)}) ? (${word} | ${mask}) >>> 0 : (${word} & ~${mask}) >>> 0)`, ref)};`
      }
      // the target is a place expression - emitExpr produces a valid JS lvalue for it
      const maxLen = s.target.node === 'var' || s.target.node === 'member' || s.target.node === 'index' ? s.target.maxLen : undefined
      const stored = emitRanged(emitLimited(emitCoerced(s.value, s.target.t, ref), s.target.t, maxLen), s.target)
      return `${ind}${emitStore(s.target, stored, ref)};`
    }
    case 'fbcall': {
      // The instance is a place. A bare variable emits as itself; one reached through an index
      // or a field (`S.zones[S.i - 1]`) is evaluated once into a local first, the way the
      // interpreter evaluates it once, so every line of the call acts on the same instance.
      const direct = s.target.node === 'var'
      const inst = direct ? emitExpr(s.target, ref) : '__fb'
      const inner = direct ? ind : `${ind}  `
      // (a REF_TO input is given the reference, an interface input the instance)
      const args = s.args.filter((a) => !a.out && !a.inout).map((a) => `${a.name}: ${a.bind === 'ref' ? refJs(a.value, a.alias, ref) : a.bind === 'iface' ? instanceJs(a.value, ref) : emitExpr(a.value, ref)}`).join(', ')
      const lines: string[] = []
      // VAR_IN_OUT binds the caller's storage in before the call - an aggregate aliases,
      // a scalar is copied back afterwards, exactly as the interpreter does it
      for (const a of s.args) {
        if (a.inout) lines.push(`${inner}${inst}.${a.name} = ${emitExpr(a.value, ref)};`)
      }
      // the block is handed the controller's clock, not a step: a timer measures `now` against its start
      lines.push(`${inner}${inst}.call({ ${args} }, now);`)
      emitCallsBlock = true
      for (const a of s.args) {
        if (a.inout && a.value.t) lines.push(`${inner}${emitStore(a.value, `${inst}.${a.name}`, ref)};`)
      }
      // output bindings read the member back after the call, exactly like the interpreter
      for (const a of s.args) {
        if (!a.out) continue
        // a whole array or struct output is copied out rather than aliased
        lines.push(a.copy ? `${inner}copyData(${emitExpr(a.value, ref)}, ${inst}.${a.name});` : `${inner}${emitStore(a.value, `${inst}.${a.name}`, ref)};`)
      }
      if (direct) return lines.join('\n')
      return [`${ind}{`, `${inner}const __fb = ${emitExpr(s.target, ref)};`, ...lines, `${ind}}`].join('\n')
    }
    case 'if': {
      let out = ''
      s.branches.forEach((b, k) => {
        out += `${ind}${k ? '} else if' : 'if'} (${emitExpr(b.cond, ref)}) {\n`
        out += b.body.map((x) => emitStmt(x, ind + '  ', ref)).join('\n') + '\n'
      })
      if (s.elseBody) out += `${ind}} else {\n` + s.elseBody.map((x) => emitStmt(x, ind + '  ', ref)).join('\n') + '\n'
      return out + `${ind}}`
    }
    case 'case': {
      // an if/else chain (not a switch) so integer-range labels (`1..5`) map cleanly
      if (s.cases.length === 0) return s.elseBody ? s.elseBody.map((x) => emitStmt(x, ind, ref)).join('\n') : `${ind};`
      const sel = emitExpr(s.selector, ref)
      let out = ''
      s.cases.forEach((clause, k) => {
        const cond = clause.labels
          // an enumeration label was resolved to its value by the checker, so it compares
          // like any other single label - with the member name kept as a comment
          .map((l) =>
            l.kind === 'range'
              ? `(${sel} >= ${l.lo} && ${sel} <= ${l.hi})`
              : `${sel} === ${l.value}${l.kind === 'name' ? ` /* ${l.name} */` : ''}`,
          )
          .join(' || ')
        out += `${ind}${k ? '} else if' : 'if'} (${cond}) {\n`
        out += clause.body.map((x) => emitStmt(x, ind + '  ', ref)).join('\n') + '\n'
      })
      if (s.elseBody) out += `${ind}} else {\n` + s.elseBody.map((x) => emitStmt(x, ind + '  ', ref)).join('\n') + '\n'
      return out + `${ind}}`
    }
    case 'for': {
      // mirror the interpreter's IEC semantics exactly: TO/BY are evaluated once at
      // entry, an internal counter drives iteration (writes to the loop variable in the
      // body don't steer it), and the visible variable holds the width-coerced value
      const v = `${s.vGlobal ? 'G' : ref}.${s.varName}`
      const from = emitExpr(s.from, ref)
      const to = emitExpr(s.to, ref)
      const step = s.by ? emitExpr(s.by, ref) : '1'
      const body = s.body.map((x) => emitStmt(x, ind + '    ', ref)).join('\n')
      // forStep refuses a zero BY at entry and loopGuard counts the iterations, both the way the
      // interpreter does: without them this loop hangs where the interpreter faults the scan
      return (
        `${ind}{ const __to = ${to}, __by = forStep(${step});\n` +
        `${ind}  let __n = 0;\n` +
        `${ind}  for (let __i = ${from}; __by > 0 ? __i <= __to : __i >= __to; __i += __by) {\n` +
        `${ind}    loopGuard(++__n, 'FOR');\n` +
        `${ind}    ${v} = wrap('${s.vt ?? 'INT'}', __i);\n` +
        `${body}\n` +
        `${ind}  }\n` +
        `${ind}}`
      )
    }
    case 'while': {
      const body = s.body.map((x) => emitStmt(x, ind + '    ', ref)).join('\n')
      return `${ind}{ let __n = 0;\n${ind}  while (${emitExpr(s.cond, ref)}) {\n${ind}    loopGuard(++__n, 'WHILE');\n${body}\n${ind}  }\n${ind}}`
    }
    case 'repeat': {
      const body = s.body.map((x) => emitStmt(x, ind + '    ', ref)).join('\n')
      return `${ind}{ let __n = 0;\n${ind}  do {\n${ind}    loopGuard(++__n, 'REPEAT');\n${body}\n${ind}  } while (!(${emitExpr(s.cond, ref)}));\n${ind}}`
    }
    case 'exit':
      return `${ind}break;`
    case 'invoke': {
      const { call, after } = emitMethodCall(s.call, ref)
      if (after.length === 0) return `${ind}${call};`
      return [`${ind}{`, `${ind}  const __f = ${call};`, ...after.map((a) => `${ind}  ${a};`), `${ind}}`].join('\n')
    }
    case 'bind': {
      const value = s.source === null ? '0' : s.kind === 'iface' ? instanceJs(s.source, ref) : refJs(s.source, s.alias, ref)
      // an element's slot is stored as any element is (elemSet), never through what it designates
      if (s.target.node === 'index') return `${ind}${emitStore(s.target, value, ref)};`
      const t = s.target as Extract<Expr, { node: 'var' }>
      return `${ind}${home(t, ref)}.${t.name} = ${value};`
    }
    case 'continue':
      return `${ind}continue;`
    case 'return':
      // inside an emitted FUNCTION a bare `return` would discard the result variable, so
      // the enclosing POU's return expression (set per-POU below) is emitted with it
      return `${ind}return${emitReturnExpr ? ` ${emitReturnExpr}` : ''};`
  }
}

/** A declaration's initial value: an array's element list, its (coerced) init expression,
 *  or the type's zero. An array list is emitted nested to match the interpreter's layout. */
function declInit(d: Decl, ref: string): string {
  if (d.arrayInit && isArray(d.type)) return arrayInitLiteral(d.arrayInit, d.type, ref)
  if (d.structInit && (isStruct(d.type) || isUserFb(d.type))) return initLiteral(d.structInit, d.type, undefined, ref)
  const t = declScalar(d.type)
  return d.init ? emitLimited(emitCoerced(d.init, t, ref), t, d.maxLen) : zero(d.type)
}

/** One initial value as a JS literal: a coerced scalar, or a whole struct object (a field not named
 *  gets its zero) or array, laid out the way the interpreter lays them out. */
function initLiteral(v: Initializer, t: DataType, maxLen: number | undefined, ref: string): string {
  if (v.node === 'structInit' && isUserFb(t)) {
    // an instance's own starting values, written over what its class sets (`Inst : Block := (P := 5)`)
    const members = emitFbDefs.get(t.fb.toUpperCase())?.decls ?? []
    const given = v.fields.flatMap((f) => {
      const m = members.find((x) => x.name === f.name)
      return m ? [`${m.name}: ${initLiteral(f.value, m.type, m.maxLen, ref)}`] : []
    })
    return `Object.assign(new ${t.fb}(), { ${given.join(', ')} })`
  }
  if (v.node === 'structInit') {
    const fields = (emitStructDefs.get((t as StructRef).struct)?.fields ?? []).map((f) => {
      const given = v.fields.find((x) => x.name === f.name)
      return `${f.name}: ${given ? initLiteral(given.value, f.type, f.maxLen, ref) : zero(f.type)}`
    })
    return `{ ${fields.join(', ')} }`
  }
  if (v.node === 'arrayInit') return arrayInitLiteral(v.items, t as ArrayType, ref)
  const s = declScalar(t)
  return emitLimited(emitCoerced(v, s, ref), s, maxLen)
}

function arrayInitLiteral(items: Initializer[], at: ArrayType, ref: string): string {
  return nestArray(at.dims, 0, items.map((x) => initLiteral(x, at.elem, at.elemMaxLen, ref)), { i: 0 })
}

/** Shape a flat, row-major initialiser list into the nested JS array literal the
 *  interpreter builds, so a multi-dimensional array initialises identically in both. */
function nestArray(dims: ArrayDim[], k: number, flat: string[], cursor: { i: number }): string {
  const n = dims[k]!.hi - dims[k]!.lo + 1
  const items: string[] = []
  for (let j = 0; j < n; j++) items.push(k === dims.length - 1 ? (flat[cursor.i++] ?? '0') : nestArray(dims, k + 1, flat, cursor))
  return `[${items.join(', ')}]`
}

function arrayZero(dims: ArrayDim[], k: number, elem: DataType): string {
  const d = dims[k]!
  const n = d.hi - d.lo + 1
  const inner = k === dims.length - 1 ? zero(elem) : arrayZero(dims, k + 1, elem)
  return `Array.from({ length: ${n} }, () => (${inner}))`
}

function zero(t: DeclType): string {
  if (isEnum(t)) return String(emitEnumDefs.get(t.enum)?.members[0]?.value ?? 0)
  if (isArray(t)) return arrayZero(t.dims, 0, t.elem)
  if (isStruct(t)) {
    const fields = (emitStructDefs.get(t.struct)?.fields ?? []).map((f) => `${f.name}: ${zero(f.type)}`).join(', ')
    return `{ ${fields} }`
  }
  if (isUserFb(t)) return `new ${t.fb}()`
  if (isRef(t) || isInterface(t)) return '0' // bound to nothing, referring to no instance
  if (t === 'BOOL') return 'false'
  if (t === 'STRING') return `''` // an empty string, whatever the declared capacity
  if (isInt(t as ScalarType) || isReal(t as ScalarType) || isTime(t as ScalarType) || isCalendar(t as ScalarType)) return '0'
  return `makeFb('${t}')`
}

/** Emit a user FUNCTION_BLOCK as a class with a `call(I, now)` cyclic method, `now` being the
 *  controller's clock, which it passes on to the blocks inside it. A derived block `extends` its base's class (its
 *  constructor builds the inherited variables), a block derived from has its body as `__body_<Name>` too (SUPER^()),
 *  and each METHOD and accessor is a method of the class (methodJs). */
function emitFbDef(def: FbDef, extended = false): string {
  emitReturnExpr = '' // a function block's call() hands nothing back
  emitFrame = null
  // a VAR_EXTERNAL is no field: the checker resolved every use of it to G
  const decls = def.decls.filter((d) => d.section !== 'VAR_EXTERNAL')
  emitIfaces = new Set(fbDecls(def).filter((d) => isInterface(d.type)).map((d) => `${identKey(d.name)}@this`))
  const fields = [...(def.extends ? ['    super();'] : []), ...decls.map((d) => `    this.${d.name} = ${declInit(d, 'this')};`)].join('\n')
  const setInputs = fbDecls(def)
    .filter((d) => d.section === 'VAR_INPUT')
    // a whole array or struct input is copied into the block's own storage, never aliased
    .map((d) =>
      isArray(d.type) || isStruct(d.type)
        ? `    if (I.${d.name} !== undefined) copyData(this.${d.name}, I.${d.name});`
        : `    if (I.${d.name} !== undefined) this.${d.name} = I.${d.name};`,
    )
    .join('\n')
  const body = def.body.map((s) => emitStmt(s, '    ', 'this')).join('\n')
  const ownBody = extended ? [`  __body_${def.name}(now) {`, body, `  }`] : []
  const methods = (def.methods ?? []).filter((m) => !m.bodyless).map(emitMethod)
  emitFrame = null
  return [`class ${def.name}${def.extends ? ` extends ${def.extends.name}` : ''} {`, `  constructor() {`, fields, `  }`, `  call(I, now) {`, setInputs, body, `  }`, ...ownBody, ...methods, `}`]
    .filter((line) => line !== '')
    .join('\n')
}

/** A METHOD as a method of its block's class: a frame `F` of its own variables, started on every call
 *  (inputs not given at their start values), its body over `F` and `this`, and `F` handed back for the caller to read
 *  its result, outputs and in-outs from. */
function emitMethod(m: MethodDef): string {
  const decls = methodDecls(m).filter((d) => d.section !== 'VAR_EXTERNAL')
  emitFrame = new Set(decls.map((d) => identKey(d.name)))
  const ifaces = new Set(emitIfaces)
  for (const d of decls) if (isInterface(d.type)) emitIfaces.add(`${identKey(d.name)}@F`)
  emitReturnExpr = 'F'
  const init = decls.map((d) => `    F.${d.name} = ${declInit(d, 'this')};`)
  const given = decls
    .filter((d) => d.section === 'VAR_INPUT' || d.section === 'VAR_IN_OUT')
    .map((d) => (d.section === 'VAR_INPUT' && (isArray(d.type) || isStruct(d.type)) ? `    if (A.${d.name} !== undefined) copyData(F.${d.name}, A.${d.name});` : `    if (A.${d.name} !== undefined) F.${d.name} = A.${d.name};`))
  const body = m.body.map((s) => emitStmt(s, '    ', 'this')).join('\n')
  emitIfaces = ifaces
  return [`  ${methodJs(m)}(A, now) {`, '    const F = {};', ...init, ...given, body, '    return F;', '  }'].filter((line) => line !== '').join('\n')
}

/** Emit a stateless FUNCTION as a JS function: positional params, one return value. */
function emitFuncDef(def: FuncDef): string {
  emitReturnExpr = `F.${def.name}` // a RETURN inside a FUNCTION still yields its result
  const inputs = def.decls.filter((d) => d.section === 'VAR_INPUT')
  const params = inputs.map((d) => d.name).join(', ')
  // a whole array or struct argument is copied into the function's own zeroed input, so the body
  // can write to it without reaching the caller's variable, exactly as in the interpreter
  const aggregate = (d: Decl): boolean => isArray(d.type) || isStruct(d.type)
  const gather = inputs.length ? `  const F = { ${inputs.map((d) => (aggregate(d) ? `${d.name}: ${zero(d.type)}` : d.name)).join(', ')} };` : `  const F = {};`
  const copies = inputs
    .filter(aggregate)
    .map((d) => (def.omittable ? `  if (${d.name} !== undefined) copyData(F.${d.name}, ${d.name});` : `  copyData(F.${d.name}, ${d.name});`))
    .join('\n')
  const locals = def.decls
    .filter((d) => d.section !== 'VAR_INPUT' && d.section !== 'VAR_EXTERNAL')
    .map((d) => `  F.${d.name} = ${declInit(d, 'F')};`)
    .join('\n')
  const retInit = `  F.${def.name} = ${zero(def.ret)};`
  // an input a formal call left out arrives as `undefined` and starts where its declaration says; after the
  // locals, so a start value may name one of the function's constants
  const omitted = (def.omittable ? inputs : [])
    .map((d) => (aggregate(d) ? `  if (${d.name} === undefined) F.${d.name} = ${declInit(d, 'F')};` : `  if (F.${d.name} === undefined) F.${d.name} = ${declInit(d, 'F')};`))
    .join('\n')
  const body = def.body.map((s) => emitStmt(s, '  ', 'F')).join('\n')
  // a function keeps no clock: a method it calls reads 0, as in the interpreter
  const clock = /\bnow\)/.test(body) ? '  const now = 0;' : ''
  return [`function ${def.name}(${params}) {`, clock, gather, copies, retInit, locals, omitted, body, `  return F.${def.name};`, `}`]
    .filter((line) => line !== '')
    .join('\n')
}

/** `base`, or `base1`, `base2`, ...: a class name no POU, type or function of the program takes. */
function unusedClassName(ast: Ast, base: string): string {
  const taken = new Set(
    [...ast.fbDefs, ...ast.funcDefs, ...ast.programDefs, ...ast.typeDefs, ...ast.enumDefs, ...ast.aliasDefs, ...ast.subrangeDefs].map((d) => d.name.toUpperCase()),
  )
  let name = base
  for (let n = 1; taken.has(name.toUpperCase()); n++) name = `${base}${n}`
  return name
}

/** Emit a readable TypeScript scan function for an ST program (display/export only). */
export function toTypeScript(source: string): string {
  const { ast } = parseAndCheck(source)
  emitStructDefs = new Map(ast.typeDefs.map((d) => [d.name, d]))
  emitEnumDefs = new Map(ast.enumDefs.map((d) => [d.name, d]))
  emitFbDefs = new Map(ast.fbDefs.map((d) => [d.name.toUpperCase(), d]))
  emitFuncInputs = new Map(ast.funcDefs.map((d) => [d.name.toUpperCase(), d.decls.filter((x) => x.section === 'VAR_INPUT').length]))
  // VAR_GLOBALs become one module-level object every POU closes over, mirroring the
  // interpreter's single shared image. It is filled below the classes rather than written as a
  // literal above them, because a global may be an instance of one, and `G.line = new Line()`
  // cannot run before `class Line` exists.
  // A CONFIGURATION's controller tags (the variables outside every POU) are globals too.
  const globals = [...ast.globals, ...controllerTags(ast)].map((d) => `G.${d.name} = ${declInit(d, 'G')};`).join('\n')
  emitIfaces = new Set(ast.globals.filter((d) => isInterface(d.type)).map((d) => `${identKey(d.name)}@G`))
  const funcs = ast.funcDefs.map(emitFuncDef).join('\n\n')
  const config = ast.configuration
  // A PROGRAM type emits exactly like a function block: a class whose call() is one scan. A
  // CONFIGURATION's instances are then fields of S, and its tasks a table the host schedules from. The
  // instance with no type runs the code outside every POU, as a class with no fields: every variable
  // that code uses is a tag in G.
  const runner = config?.programs.find((p) => p.type === null)
  const bodyClass: FbDef | null = runner ? { name: unusedClassName(ast, `${runner.name}Body`), decls: [], body: ast.body, pos: runner.pos } : null
  // every base class before what extends it (JavaScript's `extends` needs the class it names to exist)
  const ordered: FbDef[] = []
  const place = (d: FbDef): void => {
    if (ordered.includes(d)) return
    const base = d.extends ? ast.fbDefs.find((x) => x.name === d.extends!.name) : undefined
    if (base) place(base)
    ordered.push(d)
  }
  ast.fbDefs.forEach(place)
  const extended = new Set(ast.fbDefs.flatMap((d) => (d.extends ? [d.extends.name] : [])))
  const classes = [...ordered.map((d) => emitFbDef(d, extended.has(d.name))), ...[...(config ? ast.programDefs : []), ...(bodyClass ? [bodyClass] : [])].map((d) => emitFbDef(d))].join('\n\n')
  emitReturnExpr = '' // the program body's scan() hands nothing back
  // a lone PROGRAM with no CONFIGURATION is the implicit program, under its own name
  const main = config ? null : (ast.programDefs[0] ?? { decls: ast.decls, body: ast.body })
  emitIfaces = new Set([...ast.globals, ...controllerTags(ast)].filter((d) => isInterface(d.type)).map((d) => `${identKey(d.name)}@G`))
  for (const d of main?.decls ?? []) if (isInterface(d.type)) emitIfaces.add(`${identKey(d.name)}@S`)
  const init = main
    ? main.decls.filter((d) => d.section !== 'VAR_EXTERNAL').map((d) => `  S.${d.name} = ${declInit(d, 'S')};`).join('\n')
    : config!.programs.map((p) => `  S.${p.name} = new ${p.type ?? bodyClass!.name}();`).join('\n')
  emitCallsBlock = false // only the body's own calls decide whether its scan reads the clock
  const body = main ? main.body.map((s) => emitStmt(s, '  ', 'S')).join('\n') : ''
  // The controller's clock (ns) lives on S beside the variables, under a name IEC's identifiers
  // cannot take, and each scan moves it on by its dt. A CONFIGURATION keeps one reading per task,
  // as the interpreter does; a program that calls no block has no use for one.
  const tasks = config ? taskTable(config) : []
  const clockNote = ' // the controller\'s clock, in ns: each scan moves it on by its dt, and the timers read it'
  const clockInit = config ? `  S.__now = [${tasks.map(() => 0).join(', ')}];${clockNote}` : emitCallsBlock ? `  S.__now = 0;${clockNote}` : ''
  const clockStep = config ? '  const now = (S.__now[i] += nsOf(dt));' : emitCallsBlock ? '  const now = (S.__now += nsOf(dt));' : ''
  const initBody = [clockInit, init].filter(Boolean).join('\n')
  const scanBody = [clockStep, body].filter(Boolean).join('\n')
  // import only the standard-library helpers (and the clock step) the program actually references
  const code = [globals, funcs, classes, initBody, scanBody].join('\n')
  const extras = [...BUILTIN_RUNTIME_HELPERS, 'nsOf', 'andB', 'orB', 'elemAt', 'elemSet', 'loopGuard', 'forStep', 'inRange', 'refGet', 'refSet', 'refElem', 'itfGet'].filter((h) => new RegExp(`\\b${h}\\(`).test(code))
  const head =
    `import { ${['wrap', 'idiv', 'imod', 'makeFb', ...extras].join(', ')} } from './runtime'\n\n` +
    (globals ? `const G = {}\n\n` : '') +
    (funcs ? funcs + '\n\n' : '') +
    (classes ? classes + '\n\n' : '') +
    (globals ? globals + '\n\n' : '')
  if (main) return head + `export function init(S) {\n${initBody}\n}\n\n` + `export function scan(S, dt) {\n${scanBody}\n}\n`

  const table = tasks
    .map((t) => `  { name: ${JSON.stringify(t.name)}, kind: '${t.kind}', periodSec: ${t.periodSec}, priority: ${t.priority}, programs: [${t.programs.map((p) => JSON.stringify(p)).join(', ')}] },`)
    .join('\n')
  const cases = tasks
    .map((t, i) => [`    case ${i}:`, ...t.programs.map((p) => `      S.${p}.call({}, now);`), `      break;`].join('\n'))
    .join('\n')
  const pass = passOrder(tasks).map((i) => `  scanTask(S, ${i}, dt);`).join('\n')
  return (
    head +
    `export const tasks = [\n${table}\n]\n\n` +
    `export function init(S) {\n${initBody}\n}\n\n` +
    `export function scanTask(S, i, dt) {\n${clockStep}\n  switch (i) {\n${cases}\n  }\n}\n\n` +
    `export function scan(S, dt) {\n${pass}\n}\n`
  )
}
