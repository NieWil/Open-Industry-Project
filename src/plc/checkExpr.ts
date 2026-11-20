// Expression typing for the type checker (checker.ts): infers each expression's IEC type and writes it onto the
// node, including the operator rules for numbers, durations, dates and strings.

import { builtinResultType, calendarOperatorType, isBuiltinFunc, orderStandardArgs } from './builtins'
import { checkStore, isLiteralTree, retypeLiteralTree } from './checkAssign'
import { checkMcall, isNull, pointerOf } from './checkCalls'
import { become, declTypeName, exprEnum, lookup, placeText, sameDataType, type Scope, typeName } from './checkScope'
import { LD_ROLES, ladderRole } from './ladder/ladder'
import { type EnumDefMap, fbDecls, type FbDefMap, identKey, isFb, isScalarType } from './program'
import { FB_POSITIONAL, fbMemberType, isBitString, isCalendar, isInt, isReal, isString, isTime, widen, wrap } from './runtime'
import type { DataType, Decl, DeclType, Expr, FbArg, ScalarType, SourcePos, UserFbRef } from './types'
import { isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

/**
 * Reject a place that a graphical dialect's element requires to be BOOL, in that dialect's words.
 *
 * ST itself would allow the place - a condition reads any scalar, an assignment writes any type - so this rule
 * exists only because the statement was lowered from an element. What the element is, and how to say it, belongs to
 * the dialect (ladder.ts `LD_ROLES`); the checker asks whether this node has a role and whether that role stands on
 * the side being checked. `side` is which end of the statement we are at: a read (an operand, a condition) or the
 * target of an assignment. Nothing happens for ordinary ST, which has no role.
 */
export function elementRule(e: Expr, side: 'read' | 'write', t: DataType, pos: SourcePos): void {
  const role = ladderRole(e)
  if (role === undefined) return
  const rule = LD_ROLES[role]
  if (rule.side !== side) return
  const text = placeText(e)
  throw new StError(rule.says(text, typeName(t)), pos, text.length)
}

/** The function-block output a place reaches through, if any (`r.pkg.id` -> the `pkg` read). An
 *  output is the block's own to write, all the way down its fields, so nothing outside may write
 *  or alias a place that runs through one. Only meaningful once the checker has annotated it. */
export function throughFbOutput(e: Expr): Extract<Expr, { node: 'member' }> | null {
  if (e.node === 'member') return e.fbOutput ? e : throughFbOutput(e.obj)
  if (e.node === 'index' || e.node === 'bit') return throughFbOutput(e.obj)
  return null
}

/** A user FB's readable output (declared spelling, type, STRING capacity), or null if there is
 *  none. Any data reads out, a whole array, struct or enumeration included; an instance does not. */
function fbOutput(ref: UserFbRef, member: string, fbDefs: FbDefMap): { name: string; type: DataType; maxLen?: number } | null {
  const def = fbDefs.get(identKey(ref.fb))
  if (!def) return null
  const out = fbDecls(def).find((d) => identKey(d.name) === identKey(member) && d.section === 'VAR_OUTPUT')
  return out && !isFb(out.type) && !isUserFb(out.type) ? { name: out.name, type: out.type, maxLen: out.maxLen } : null
}

/**
 * Fill in the parameter names of a non-formal call - IEC's `CU_T(CU)` / `CTU_1(CU, R, PV)`,
 * where the arguments are given in the block's declaration order instead of being named.
 *
 * The parser cannot do this: it does not know the instance's TYPE, so it does not know what
 * the block's parameters are. Naming them here, before any of the checks below run, means
 * everything downstream - the type checks, the interpreter, the emitter, both exporters -
 * keeps seeing an ordinary named call and needs no case of its own.
 *
 * A short list is allowed, leaving the trailing parameters unwritten, because a formal call
 * may already omit a parameter the same way. A long one is an error: there is no parameter
 * for the extra argument to reach, so it would otherwise vanish silently.
 */
export function namePositionalArgs(s: { args: FbArg[]; pos: SourcePos }, d: DeclType, scope: Scope): void {
  if (!s.args.some((a) => a.positional)) return
  let order: readonly string[]
  let what: string
  if (isFb(d)) {
    order = FB_POSITIONAL[d]
    what = d
  } else if (isUserFb(d)) {
    // inputs and in-outs, in the order they were declared (a derived block's inherited ones first); outputs are not in
    // a call list
    const def = scope.fbs.get(identKey(d.fb))
    order = (def ? fbDecls(def) : [])
      .filter((x) => x.section === 'VAR_INPUT' || x.section === 'VAR_IN_OUT')
      .map((x) => x.name)
    what = `'${d.fb}'`
  } else {
    return // not a function block at all; the caller reports that with a better message
  }
  if (s.args.length > order.length) {
    const extra = s.args[order.length]!
    const takes = order.length === 0 ? 'takes no arguments' : `takes ${order.length} argument(s) (${order.join(', ')})`
    throw new StError(`${what} ${takes}, got ${s.args.length}`, extra.pos)
  }
  s.args.forEach((a, i) => {
    if (a.positional) a.name = order[i]!
  })
}

/** Resolve `Type#Member` to the enumeration member it names, or say exactly which half is wrong. */
export function qualifiedMember(qualifier: string, name: string, enums: EnumDefMap, pos: SourcePos): { name: string; enum: string; value: number } {
  const spelled = `${qualifier}#${name}`
  const def = enums.get(identKey(qualifier))
  if (!def) throw new StError(`'${qualifier}' is not an enumeration, so '${spelled}' names nothing`, pos, spelled.length)
  const m = def.members.find((x) => identKey(x.name) === identKey(name))
  if (!m) throw new StError(`'${name}' is not a member of enumeration ${def.name}`, pos, spelled.length)
  return { name: m.name, enum: def.name, value: m.value }
}

/**
 * Put a formal function call's arguments (`Scale(hi := 10, v := x, lo := 0)`) back into the
 * function's declaration order and drop the names, so every check below, both backends and the
 * exporters see the ordinary positional call they already handle. The mirror of namePositionalArgs,
 * which does the same for a function block's non-formal call.
 *
 * An input the call leaves out takes its declared initial value, as IEC has it; MATIEC builds and agrees
 * with it. STruC++, OpenPLC's compiler, builds it only when every input left out declares an
 * initial value (scripts/oracle-strucpp.mjs `omitted-input-no-initial`). The arguments given stay in
 * declaration order, and `slots` names the input each one is, so the backends leave the rest at their start.
 */
function orderFormalArgs(e: Extract<Expr, { node: 'call' }>, inputs: Decl[], fn: string): void {
  const given = new Map<string, Expr>()
  e.names!.forEach((n, i) => {
    const arg = e.args[i]!
    const d = inputs.find((x) => identKey(x.name) === identKey(n))
    if (!d) throw new StError(`'${fn}' has no input '${n}'`, arg.pos)
    if (given.has(identKey(d.name))) throw new StError(`'${fn}' input '${d.name}' is given twice`, arg.pos)
    given.set(identKey(d.name), arg)
  })
  const slots = inputs.flatMap((d, i) => (given.has(identKey(d.name)) ? [i] : []))
  e.args = slots.map((i) => given.get(identKey(inputs[i]!.name))!)
  if (slots.length < inputs.length) e.slots = slots
  delete e.names
}

// ---- type checking (annotates Expr.t in place) ----

/** Resolve the full data type of an expression (may be an aggregate for an intermediate place). */
export function inferType(e: Expr, scope: Scope): DataType {
  switch (e.node) {
    case 'num': {
      // A typed literal (`INT#5`) says what it is; the value must actually fit, or the
      // author wrote something the target would reject. Otherwise an untyped integer
      // literal takes the smallest standard type that holds it, so `40000 + 0` computes
      // at DINT width instead of wrapping at INT's 16 bits. (The lexer only produces
      // non-negative literals; `-` is a unary op on top.)
      if (e.declared) {
        if (isInt(e.declared) && (!Number.isInteger(e.value) || wrap(e.declared, e.value) !== e.value)) {
          throw new StError(`${e.value} does not fit in ${e.declared}`, e.pos)
        }
        e.t = e.declared
        e.value = wrap(e.declared, e.value) // a REAL literal is stored at f32
        return e.declared
      }
      // not rounded to the inferred type: literal typing here is by magnitude, not by
      // context, so pre-rounding an untyped `0.1` to REAL would silently throw away the
      // precision of `x : LREAL := 0.1`. The operation's result type does the rounding
      // instead, which gives the same f32 value in a REAL context and keeps f64 in an
      // LREAL one. Write `REAL#0.1` to pin a literal to single precision.
      const t: ScalarType = e.real ? 'REAL' : e.value <= 32767 ? 'INT' : e.value <= 2147483647 ? 'DINT' : 'DWORD'
      e.t = t
      return t
    }
    case 'bool':
      e.t = 'BOOL'
      return 'BOOL'
    case 'str':
      e.t = 'STRING'
      return 'STRING'
    case 'var': {
      // `Mode#Idle` always means the member, whatever else shares its name; a bare member name is
      // an enumeration constant too, unless a variable of that name shadows it
      const member =
        e.qualifier !== undefined
          ? qualifiedMember(e.qualifier, e.name, scope.enums, e.pos)
          : scope.env.has(identKey(e.name)) ? undefined : scope.enumMembers.get(identKey(e.name))
      if (member) {
        e.name = member.name
        e.enum = member.enum
        e.constValue = member.value
        e.t = 'INT'
        return { enum: member.enum }
      }
      const d = lookup(scope, e.name)
      if (!d) {
        const word = identKey(e.name)
        // IEC's spelling of the instance running: THIS, with no ^ (THIS.x, THIS.Method())
        if (word === 'THIS' && scope.self && !e.ref) return inferType(become(e, { node: 'this', pos: e.pos }), scope)
        if (word === 'THIS' && !e.ref) throw new StError("THIS is the instance a function block's body or method runs on, and there is none here", e.pos, e.name.length)
        if (word === 'SUPER' && scope.self) throw new StError("write SUPER^: SUPER is the base class's view of this instance, and is always dereferenced (SUPER^.Method(), SUPER^())", e.pos, e.name.length)
        if (word === 'NULL' && !e.ref) throw new StError('NULL is the reference to nothing: give it to a REF_TO (r := NULL;) or compare one with it (r <> NULL)', e.pos, e.name.length)
        if (scope.self?.cls.table?.has(word)) throw new StError(`'${e.name}' is a method: call it, ${e.name}(...)`, e.pos, e.name.length)
        throw new StError(`undeclared variable '${e.name}'`, e.pos, e.name.length)
      }
      e.global = !scope.env.has(identKey(e.name)) // resolved to a VAR_GLOBAL, not a local
      e.name = d.name // resolve to the declaration's spelling
      // a REF_TO dereferenced, `r^`, stands for the place it refers to, so it reads as that place's type. Named without
      // the ^ it is the reference itself, which only a REF_TO takes (an assignment, an input) and NULL is compared with
      if (isRef(d.type)) {
        if (!e.ref) return d.type
        const rt = d.type.ref
        if (isEnum(rt)) {
          e.t = 'INT'
          e.enum = rt.enum
        } else if (isScalarType(rt)) e.t = rt
        if (d.type.maxLen !== undefined) e.maxLen = d.type.maxLen
        return rt
      }
      if (e.ref) throw new StError(`'${d.name}' is ${declTypeName(d)}, not a REF_TO, so ^ cannot dereference it`, e.pos, e.name.length)
      // a function-block instance comes back as its type, like any other aggregate; infer() is
      // what refuses one where a value is required
      const dt = d.type
      if (isEnum(dt)) {
        // an enum value is an integer at runtime; the tag is what keeps it a distinct type
        e.t = 'INT'
        e.enum = dt.enum
        return dt
      }
      if (isScalarType(dt)) e.t = dt
      if (d.range) e.range = d.range // a subrange place enforces its bounds on every store
      if (d.maxLen !== undefined) e.maxLen = d.maxLen // a STRING place truncates to capacity
      return dt
    }
    case 'member': {
      // `Mode.Idle`: an input spelling of an enumeration's member (IEC writes Mode#Idle, which
      // is what it becomes, and what an export writes: exportText.ts `canonicalSyntax`). Only where no variable is
      // called `Mode`, which keeps the meaning a member of a variable always had.
      if (e.obj.node === 'var' && e.obj.qualifier === undefined && scope.enums.has(identKey(e.obj.name))) {
        const k = identKey(e.obj.name)
        if (!scope.env.has(k) && !scope.globals.has(k)) {
          return inferType(become(e, { node: 'var', name: e.field, qualifier: e.obj.name, pos: e.obj.pos }), scope)
        }
      }
      const ot = inferType(e.obj, scope)
      const owner = isUserFb(ot) ? scope.fbs.get(identKey(ot.fb)) : isInterface(ot) ? scope.ifaces.get(identKey(ot.iface)) : undefined
      const field = identKey(e.field)
      if (owner?.table?.has(field)) throw new StError(`'${e.field}' is a method: call it, ${placeText(e.obj)}.${e.field}(...)`, e.pos, e.field.length)
      if (isInterface(ot)) throw new StError(`interface '${ot.iface}' has no member '${e.field}': an interface is reached through its methods`, e.pos, e.field.length)
      if (isRef(ot)) throw new StError(`'${placeText(e.obj)}' is a REF_TO: dereference it to reach what it refers to, ${placeText(e.obj)}^.${e.field}`, e.obj.pos)
      // THIS.x: any variable of the block's own, inherited ones too, not only its outputs
      if (e.obj.node === 'this' && isUserFb(ot)) {
        const def = scope.fbs.get(identKey(ot.fb))!
        const d = fbDecls(def).find((x) => identKey(x.name) === field && x.section !== 'VAR_EXTERNAL')
        if (!d) throw new StError(`'${def.name}' has no variable '${e.field}'`, e.pos, e.field.length)
        if (isRef(d.type) || isInterface(d.type)) throw new StError(`'${placeText(e)}': reach a REF_TO or an interface variable by its own name, not through THIS`, e.pos, e.field.length)
        e.field = d.name
        if (isEnum(d.type)) {
          e.t = 'INT'
          e.enum = d.type.enum
        } else if (isScalarType(d.type)) e.t = d.type
        if (d.range) e.range = d.range
        if (d.maxLen !== undefined) e.maxLen = d.maxLen
        return d.type
      }
      // a function-block output, read through whatever place holds the instance: `t.Q`,
      // `zones[i].Run`, `line.gap.ET`
      if (isFb(ot)) {
        const field = identKey(e.field) // a builtin FB's members are spelled upper case
        const mt = fbMemberType(ot, field)
        if (!mt) throw new StError(`${ot} has no output '${e.field}'`, e.pos, e.field.length)
        e.field = field
        e.fbOutput = true
        e.t = mt
        return mt
      }
      if (isUserFb(ot)) {
        const out = fbOutput(ot, e.field, scope.fbs)
        if (!out) throw new StError(`'${ot.fb}' has no readable output '${e.field}'`, e.pos, e.field.length)
        e.field = out.name
        e.fbOutput = true
        if (isEnum(out.type)) {
          e.t = 'INT'
          e.enum = out.type.enum
        } else if (isScalarType(out.type)) e.t = out.type
        if (out.maxLen !== undefined) e.maxLen = out.maxLen
        return out.type
      }
      // IEC gives a STRING no members at all, so the program is told what it has instead
      if (ot === 'STRING') {
        throw new StError(`'.${e.field}': a STRING has no members in IEC 61131-3 - read its length with LEN() and its characters with MID()`, e.pos, e.field.length)
      }
      if (!isStruct(ot)) throw new StError(`'.${e.field}' on a value that is not a struct`, e.pos, e.field.length)
      const f = scope.structs.get(identKey(ot.struct))?.fields.find((x) => identKey(x.name) === identKey(e.field))
      if (!f) throw new StError(`'${ot.struct}' has no field '${e.field}'`, e.pos, e.field.length)
      e.field = f.name
      if (isEnum(f.type)) {
        e.t = 'INT'
        e.enum = f.type.enum
      } else if (isScalarType(f.type)) e.t = f.type
      if (f.maxLen !== undefined) e.maxLen = f.maxLen
      return f.type
    }
    case 'bit': {
      const ot = inferType(e.obj, scope)
      const text = placeText(e)
      if (!isScalarType(ot) || !isInt(ot) || exprEnum(e.obj)) {
        throw new StError(`'${text}' addresses a bit, and '${placeText(e.obj)}' is ${typeName(ot)}: only an integer (SINT, INT, DINT, BYTE, WORD, DWORD...) has bits`, e.pos, text.length)
      }
      const width = ot === 'SINT' || ot === 'USINT' || ot === 'BYTE' ? 8 : ot === 'INT' || ot === 'UINT' || ot === 'WORD' ? 16 : 32
      if (e.bit >= width) throw new StError(`'${text}': ${ot} has bits 0..${width - 1}`, e.pos, text.length)
      e.t = 'BOOL'
      return 'BOOL'
    }
    case 'index': {
      const ot = inferType(e.obj, scope)
      if (isRef(ot)) throw new StError(`'${placeText(e.obj)}' is a REF_TO: dereference it to reach what it refers to, ${placeText(e.obj)}^[...]`, e.obj.pos)
      if (!isArray(ot)) throw new StError('indexing a value that is not an array', e.pos)
      if (e.indices.length !== ot.dims.length) throw new StError(`array expects ${ot.dims.length} index(es), got ${e.indices.length}`, e.pos)
      for (const ix of e.indices) {
        const it = infer(ix, scope)
        if (it === 'BOOL' || isReal(it)) throw new StError('array index must be an integer', ix.pos)
      }
      e.dims = ot.dims
      if (isEnum(ot.elem)) {
        e.t = 'INT'
        e.enum = ot.elem.enum
      } else if (isScalarType(ot.elem)) e.t = ot.elem
      if (ot.elemMaxLen !== undefined) e.maxLen = ot.elemMaxLen
      return ot.elem
    }
    case 'this': {
      if (!scope.self) throw new StError(`${e.super ? 'SUPER^' : 'THIS'} is the instance a function block's body or method runs on, and there is none here`, e.pos, e.super ? 6 : 4)
      if (!e.super) {
        e.cls = scope.self.cls.name
        return { fb: scope.self.cls.name }
      }
      const base = scope.self.cls.extends
      if (!base) throw new StError(`SUPER^: '${scope.self.cls.name}' EXTENDS no block, so there is no base class to call`, e.pos, 6)
      e.cls = scope.fbs.get(identKey(base.name))?.name ?? base.name
      return { fb: e.cls }
    }
    case 'mcall':
      return checkMcall(e, scope, false)
    case 'isref': {
      const ot = pointerOf(e.obj, scope)
      if (!ot) throw new StError(`'${placeText(e.obj)}' is neither a REF_TO nor an interface, so it always designates itself`, e.obj.pos)
      e.t = 'BOOL'
      return 'BOOL'
    }
    case 'call': {
      const upper = identKey(e.name)
      // a non-IEC test of a REFERENCE TO, refused by name
      if (upper === '__ISVALIDREF') throw new StError('__ISVALIDREF is not IEC 61131-3; declare the reference REF_TO and compare it with NULL: r <> NULL', e.pos, e.name.length)
      // REF(x) is a reference, which only a REF_TO takes (refValue): anywhere else it is no value
      if (upper === 'REF' && !scope.funcs.has(upper)) throw new StError('REF(x) is a reference to x: give it to a REF_TO (r := REF(x);) or to a REF_TO input; dereference a REF_TO with ^ to read what it refers to', e.pos, e.name.length)
      // a METHOD of the block whose code this is, by its bare name: `Peek()` is THIS.Peek() (inside the method itself
      // too, where the bare name alone is its result: a variable is never called)
      if (scope.self?.cls.table?.has(upper)) {
        const args: FbArg[] = e.names
          ? e.args.map((value, i) => ({ name: e.names![i]!, value, pos: value.pos }))
          : e.args.map((value) => ({ name: '', value, positional: true, pos: value.pos }))
        return inferType(become(e, { node: 'mcall', obj: { node: 'this', pos: e.pos }, method: e.name, args, pos: e.pos }), scope)
      }
      if (isBuiltinFunc(upper)) {
        // a formal call is put in IEC's parameter order, so everything after sees a positional one
        if (e.names) {
          const order = orderStandardArgs(upper, e.names, e.pos)
          if (order.some((k, i) => k !== i)) e.reordered = true
          e.args = order.map((k) => e.args[k]!)
          delete e.names
        }
        const argTypes = e.args.map((a) => infer(a, scope))
        e.name = upper // the standard function library is spelled upper case
        e.t = builtinResultType(upper, argTypes, e.pos)
        return e.t
      }
      const def = scope.funcs.get(upper)
      if (!def) {
        for (const a of e.args) infer(a, scope) // an argument's own error is still reported first
        throw new StError(`unknown function '${e.name}'`, e.pos, e.name.length)
      }
      e.name = def.name
      const inputs = def.decls.filter((d) => d.section === 'VAR_INPUT')
      if (e.names) orderFormalArgs(e, inputs, def.name)
      if (e.slots) def.omittable = true
      // a positional call gives every input (MATIEC also takes one that stops short, which this engine does not)
      if (!e.slots && e.args.length !== inputs.length) throw new StError(`'${e.name}' expects ${inputs.length} argument(s), got ${e.args.length}`, e.pos)
      e.args.forEach((arg, k) => {
        const d = inputs[e.slots ? e.slots[k]! : k]!
        const what = `'${def.name}' parameter '${d.name}'`
        // a whole array or struct is passed by value, so it has to be exactly the declared type
        if (isArray(d.type) || isStruct(d.type)) {
          const at = inferType(arg, scope)
          if (!sameDataType(at, d.type)) throw new StError(`${what} needs ${typeName(d.type)}, got ${typeName(at)}`, arg.pos)
          return
        }
        const at = infer(arg, scope)
        if (isScalarType(d.type)) checkStore(arg, at, d.type, what, arg.pos)
      })
      if (isEnum(def.ret)) {
        e.t = 'INT'
        e.enum = def.ret.enum
      } else if (isScalarType(def.ret)) e.t = def.ret
      return def.ret
    }
    case 'unary': {
      const et = infer(e.expr, scope)
      if (e.op !== 'NOT' && et === 'BOOL') throw new StError(`unary ${e.op === 'NEG' ? '-' : '+'} on BOOL`, e.pos)
      if (isCalendar(et)) throw new StError(`${e.op === 'NOT' ? 'NOT' : `unary ${e.op === 'NEG' ? '-' : '+'}`} is not defined on ${et}`, e.pos)
      // NOT complements a BOOL or a bit string; it is not defined on a number
      if (e.op === 'NOT' && et !== 'BOOL') needBitString('NOT', et, e.expr)
      if (e.op !== 'NOT') needNumeric(e.op === 'NEG' ? 'unary -' : 'unary +', et, e.expr)
      e.t = et
      return et
    }
    case 'binary':
      e.t = inferBinary(e, scope)
      return e.t
  }
}

/** Resolve an expression that must be a scalar value (operands, conditions, indices, args). */
export function infer(e: Expr, scope: Scope): ScalarType {
  const t = inferType(e, scope)
  // a place lowered from a graphical element that reads it (ladder.ts): ST would read any scalar in a condition,
  // a contact examines a BOOL. The dialect words it; this only asks.
  if (t !== 'BOOL') elementRule(e, 'read', t, e.pos)
  if (isFb(t) || isUserFb(t)) {
    if (e.node === 'this') throw new StError(`${placeText(e)} is the instance itself, not a value: reach its variables (THIS.x) or call its methods`, e.pos, e.super ? 6 : 4)
    throw e.node === 'var'
      ? new StError(`'${e.name}' is a function block; read an output like ${e.name}.Q`, e.pos, e.name.length)
      : new StError(`'${placeText(e)}' is a function block; read one of its outputs`, e.pos)
  }
  if (isInterface(t)) throw new StError(`'${placeText(e)}' is an interface: call its methods or read its properties (compare it with 0 to ask whether it refers to an instance)`, e.pos)
  if (isRef(t)) throw new StError(`'${placeText(e)}' is a REF_TO: dereference it to read what it refers to (${placeText(e)}^), or compare it with NULL`, e.pos)
  if (isArray(t) || isStruct(t)) {
    const kind = isArray(t) ? 'an array' : 'a struct'
    if (e.node === 'var') throw new StError(`'${e.name}' is ${kind}; ${isArray(t) ? 'index it' : 'access a field'} to read a value`, e.pos)
    if (e.node === 'call') throw new StError(`'${e.name}' returns ${kind}; store it in a variable of that type first`, e.pos)
    throw new StError(isArray(t) ? 'an array must be indexed to read a value' : 'a struct field must be accessed to read a value', e.pos)
  }
  if (isEnum(t)) return 'INT' // the runtime type; identity is carried on the node's `enum` tag
  return t
}

/** TIME arithmetic: durations add and subtract, scale by a plain number, and compare with
 *  each other - but never mix with numbers in a way that would silently mean milliseconds. */
function inferTimeBinary(e: Extract<Expr, { node: 'binary' }>, lt: ScalarType, rt: ScalarType, isCompare: boolean): ScalarType {
  const op = e.op
  const bothTime = isTime(lt) && isTime(rt)
  if (isCompare) {
    if (!bothTime) throw new StError(`cannot compare ${lt} with ${rt}; both sides must be TIME`, e.pos)
    return 'BOOL'
  }
  if (op === '+' || op === '-') {
    if (!bothTime) throw new StError(`${op} on TIME needs both operands to be TIME (a duration plus a number is ambiguous)`, e.pos)
    return 'TIME'
  }
  // scaling: a duration times or divided by a plain number is a duration
  if (op === '*' && !bothTime) return 'TIME'
  if (op === '/' && isTime(lt) && !isTime(rt)) return 'TIME'
  throw new StError(`${op} is not defined on TIME operands`, e.pos)
}

/** A binary operator with a calendar type on either side: IEC's table (builtins.ts `calendarOperatorType`),
 *  and a comparison within one calendar type. */
function inferCalendarBinary(e: Extract<Expr, { node: 'binary' }>, lt: ScalarType, rt: ScalarType, isCompare: boolean): ScalarType {
  if (isCompare) {
    if (lt !== rt) throw new StError(`cannot compare ${lt} with ${rt}; both sides must be ${isCalendar(lt) ? lt : rt}`, e.pos)
    return 'BOOL'
  }
  const r = calendarOperatorType(e.op, lt, rt)
  if ('error' in r) throw new StError(r.error, e.pos)
  return r.t
}

/**
 * `ANY_BIT` and `ANY_NUM` do not overlap, and the operators respect that.
 *
 * An untyped literal is exempt on both sides: it has no type of its own in IEC and takes
 * one from context, so `w AND 255` and `nw := NOT 0` are ordinary ST (MATIEC accepts both).
 * Only an operand with a type of its own is judged here.
 */
function needBitString(op: string, t: ScalarType, side: Expr): void {
  if (isBitString(t) || isLiteralTree(side)) return
  throw new StError(
    `${op} is a bit-string operation; '${t}' is a number (convert it: ${t}_TO_WORD(...), or declare the variable BYTE/WORD/DWORD)`,
    side.pos,
  )
}

/** The mirror: arithmetic is `ANY_NUM`, so a bit string has to be converted to do sums. */
function needNumeric(op: string, t: ScalarType, side: Expr): void {
  if (!isBitString(t) || isLiteralTree(side)) return
  const asNum = t === 'BYTE' ? 'USINT' : t === 'WORD' ? 'UINT' : 'UDINT'
  throw new StError(
    `${op} is arithmetic; '${t}' is a bit string, which IEC does not do arithmetic on (convert it: ${t}_TO_${asNum}(...))`,
    side.pos,
  )
}

/** STRING is ordered but not arithmetic: the six comparisons work (lexicographic, by
 *  character code) and nothing else does. IEC has no string `+`, so accepting one would
 *  build here and fail on the target - the exact portability defect to refuse. */
function inferStringBinary(e: Extract<Expr, { node: 'binary' }>, lt: ScalarType, rt: ScalarType, isCompare: boolean): ScalarType {
  if (!(isString(lt) && isString(rt))) {
    throw new StError(`cannot ${isCompare ? 'compare' : 'combine'} ${lt} with ${rt}; both sides must be STRING`, e.pos)
  }
  if (isCompare) return 'BOOL'
  const fix = e.op === '+' ? '; use CONCAT(a, b) to join strings' : ''
  throw new StError(`${e.op} is not defined on STRING operands${fix}`, e.pos)
}

function inferBinary(e: Extract<Expr, { node: 'binary' }>, scope: Scope): ScalarType {
  // `r <> NULL` / `r = NULL`: whether a REF_TO refers to anything; `itf <> 0` (or NULL): whether an interface refers
  // to an instance. Rewritten to the one node both backends answer it with.
  if (e.op === '=' || e.op === '<>') {
    const zero = (x: Expr): boolean => x.node === 'num' && x.value === 0 && !x.real && x.declared === undefined
    const nul = (x: Expr): boolean => isNull(x, scope)
    const other = zero(e.right) || nul(e.right) ? e.left : zero(e.left) || nul(e.left) ? e.right : null
    const kind = other ? pointerOf(other, scope) : null
    if (other && kind && (kind === 'iface' || nul(e.left) || nul(e.right))) {
      const test: Expr = { node: 'isref', obj: other, pos: e.pos, t: 'BOOL', ...(nul(e.left) ? { nullFirst: true as const } : {}) }
      if (e.op === '<>') become(e, test)
      else become(e, { node: 'unary', op: 'NOT', expr: test, pos: e.pos, t: 'BOOL' })
      return 'BOOL'
    }
    if (kind === 'ref') throw new StError(`'${placeText(other!)}' is a REF_TO: compare it with NULL, not 0`, e.pos)
    if (nul(e.left) || nul(e.right)) throw new StError('NULL is compared only with a REF_TO (or an interface): r <> NULL', e.pos)
    if (pointerOf(e.left, scope) === 'ref' && pointerOf(e.right, scope) === 'ref') {
      throw new StError('comparing two REF_TO with each other is not implemented: compare each with NULL, or the places they refer to (a^ = b^)', e.pos)
    }
  }
  let lt = infer(e.left, scope)
  let rt = infer(e.right, scope)
  // An untyped literal on one side adopts the other side's type, so `si + 1` is SINT
  // arithmetic rather than a widening to INT that then cannot be stored back into si.
  if (isLiteralTree(e.left) && !isLiteralTree(e.right)) {
    if (retypeLiteralTree(e.left, rt)) lt = rt
  } else if (isLiteralTree(e.right) && !isLiteralTree(e.left)) {
    if (retypeLiteralTree(e.right, lt)) rt = lt
  }
  const op = e.op
  const isCompare = op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>='
  if (isCalendar(lt) || isCalendar(rt)) return inferCalendarBinary(e, lt, rt, isCompare)
  if (isTime(lt) || isTime(rt)) return inferTimeBinary(e, lt, rt, isCompare)
  if (isString(lt) || isString(rt)) return inferStringBinary(e, lt, rt, isCompare)
  if (isCompare) return 'BOOL'
  if (op === 'AND' || op === 'OR' || op === 'XOR') {
    if (lt === 'BOOL' && rt === 'BOOL') return 'BOOL'
    if (lt === 'BOOL' || rt === 'BOOL') throw new StError(`${op} mixes BOOL and non-BOOL operands`, e.pos)
    needBitString(op, lt, e.left)
    needBitString(op, rt, e.right)
    return widen(lt, rt)
  }
  // arithmetic
  if (lt === 'BOOL' || rt === 'BOOL') throw new StError(`arithmetic on BOOL operand`, e.pos)
  needNumeric(op, lt, e.left)
  needNumeric(op, rt, e.right)
  if (op === 'MOD' && (isReal(lt) || isReal(rt))) throw new StError(`MOD is defined for integers only; for reals use x - TRUNC(x / y) * y`, e.pos)
  return isReal(lt) || isReal(rt) ? widen(isReal(lt) ? lt : 'REAL', isReal(rt) ? rt : 'REAL') : widen(lt, rt)
}

// ---- object orientation: methods, properties, interfaces, references ----
