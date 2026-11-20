// Statement checking for the type checker (checker.ts), and the walk over one POU body.

import { checkStore } from './checkAssign'
import { checkCallArgs, checkIfaceSource, checkMcall, checkOutBinding, methodTarget, pointerOf, refValue, temporary } from './checkCalls'
import { elementRule, infer, inferType, namePositionalArgs, qualifiedMember, throughFbOutput } from './checkExpr'
import { checkDeclInit, impliedInit } from './checkInit'
import { become, collect, designates, exprEnum, lookup, placeRoot, placeText, rejectedTypes, sameDataType, type Scope, typeName } from './checkScope'
import { containsFb, fbDecls, identKey, isFb, isScalarType } from './program'
import { FB_INPUT_TYPES, FB_INPUTS, fbMemberType, isReal } from './runtime'
import type { ArrayType, Initializer, Decl, Diagnostic, Expr, InterfaceRef, RefType, Stmt } from './types'
import { isArray, isEnum, isInterface, isRef, isStruct, isUserFb, StError } from './types'

function checkStmt(s: Stmt, scope: Scope, inLoop = false, sink: Diagnostic[] | null = null): void {
  switch (s.node) {
    case 'assign': {
      // a REF_TO given a reference: `r := REF(place);`, `r := r2;`, `r := NULL;`
      if (s.target.node === 'var' && !s.target.ref && pointerOf(s.target, scope) === 'ref') {
        const d = lookup(scope, s.target.name)!
        const given = refValue(s.value, d.type as RefType, scope, `'${d.name}'`, !temporary(s.target, scope))
        become(s, { node: 'bind', target: s.target, source: given.source, pos: s.pos, kind: 'ref', ...(given.alias ? { alias: true as const } : {}) })
        break
      }
      // an interface pointed at an instance (or at nothing, `:= 0`)
      if ((s.target.node === 'var' || s.target.node === 'index') && pointerOf(s.target, scope) === 'iface') {
        const it = s.target.node === 'var' ? (lookup(scope, s.target.name)!.type as InterfaceRef) : ((inferType(s.target.obj, scope) as ArrayType).elem as InterfaceRef)
        const bound = checkIfaceSource(s.value, it.iface, scope, `'${placeText(s.target)}'`)
        become(s, { node: 'bind', target: s.target, source: bound ? s.value : null, pos: s.pos, kind: 'iface' })
        break
      }
      const t = s.target
      if (t.node === 'var') {
        const decl = lookup(scope, t.name)
        if (decl?.constant) throw new StError(`cannot assign to CONSTANT '${decl.name}'`, s.pos, t.name.length)
        if (scope.forVars.has(identKey(t.name))) {
          throw new StError(`cannot assign to FOR control variable '${t.name}' inside its own loop`, s.pos, t.name.length)
        }
      }
      // a constant aggregate is constant through every accessor, not just at the top
      const rootName = placeRoot(t)
      if (rootName && lookup(scope, rootName)?.constant) {
        throw new StError(`cannot assign into CONSTANT '${lookup(scope, rootName)!.name}'`, s.pos)
      }
      const tt = inferType(t, scope)
      // a place lowered from a graphical element that writes it (ladder.ts): a coil writes a BOOL
      if (tt !== 'BOOL') elementRule(t, 'write', tt, s.pos)
      // a whole function-block instance, wherever it lives (`t := ...`, `d[1] := d[2]`), or one of
      // its outputs, which only the block itself writes (`zone.gap.Q := TRUE`)
      if (isFb(tt) || isUserFb(tt)) {
        const text = placeText(t)
        throw new StError(`cannot assign to function block '${text}'`, s.pos, text.length)
      }
      const owned = throughFbOutput(t)
      if (owned) throw new StError(`cannot assign to function-block output '${owned.field}'`, s.pos)
      // A whole array or struct is copied, every element and field, into the target's own
      // storage. It takes exactly its own type (there is no widening between aggregates), and
      // never a value holding a function-block instance, which is state rather than data to copy.
      if (isArray(tt) || isStruct(tt)) {
        const target = `'${placeText(t)}'`
        if (containsFb(tt, scope.structs)) {
          throw new StError(`cannot assign to ${target}: it holds function-block instances, which are not values to copy`, s.pos)
        }
        if (designates(tt)) throw new StError(`cannot assign to ${target} whole: it holds interfaces, which are pointed at instances one element at a time`, s.pos)
        const at = inferType(s.value, scope)
        if (!sameDataType(at, tt)) {
          throw new StError(`cannot assign ${typeName(at)} to ${target} of type ${typeName(tt)}`, s.pos)
        }
        s.copy = isArray(tt) && tt.named === undefined ? 'anonymous-array' : 'named'
        break
      }
      const vt = infer(s.value, scope)
      const what = t.node === 'var' ? `'${t.name}'` : 'target'
      // An enumeration is its own type: only a value of the same enum goes in, and an enum
      // value does not silently become an integer somewhere else.
      if (isEnum(tt) || exprEnum(s.value)) {
        const want = isEnum(tt) ? tt.enum : null
        const got = exprEnum(s.value)
        if (want !== got) {
          throw new StError(
            `cannot assign ${got ? `enumeration ${got}` : vt} to ${what} of type ${want ? `enumeration ${want}` : vt}`,
            s.pos,
          )
        }
        break
      }
      if (isInterface(tt) || isRef(tt)) throw new StError(`cannot assign to ${what}: an interface is assigned an instance by its own name, and a REF_TO a reference (r := REF(place))`, s.pos)
      checkStore(s.value, vt, tt, what, s.pos)
      break
    }
    case 'fbcall': {
      // the instance is a place (`t`, `line.gap`, `zones[i]`), so it resolves like any other
      const target = s.target
      // SUPER^(): the base class's body, run on this instance
      if (target.node === 'this') {
        if (!target.super) throw new StError("THIS is not called: call one of its methods, THIS.Name(...), or the base class's body, SUPER^()", s.pos, 4)
        const call: Extract<Expr, { node: 'mcall' }> = { node: 'mcall', obj: target, method: '', args: s.args, pos: s.pos, body: true }
        checkMcall(call, scope, true)
        become(s, { node: 'invoke', call, pos: s.pos })
        break
      }
      // a METHOD: `m.Reset()`, `THIS.Run()`, `itf.Move(...)`, `SUPER^.Run()`, `r^.Run()`, or the block's own by its bare name
      const method = methodTarget(target, scope)
      if (method) {
        const call: Extract<Expr, { node: 'mcall' }> = { node: 'mcall', obj: method.obj, method: method.name, args: s.args, pos: s.pos }
        checkMcall(call, scope, true)
        become(s, { node: 'invoke', call, pos: s.pos })
        break
      }
      if (target.node === 'var' && !lookup(scope, target.name)) {
        throw new StError(`call to undeclared instance '${target.name}'`, s.pos, target.name.length)
      }
      const d = inferType(target, scope)
      if (isRef(d)) throw new StError(`'${placeText(target)}' is a REF_TO: dereference it to call the instance it refers to, ${placeText(target)}^(...)`, s.pos)
      if (!isFb(d) && !isUserFb(d)) {
        const text = placeText(target)
        throw new StError(`'${text}' is not a function block`, s.pos, text.length)
      }
      namePositionalArgs(s, d, scope)
      if (isFb(d)) {
        for (const a of s.args) {
          const an = identKey(a.name) // a builtin FB's members are spelled upper case
          if (a.out) {
            const mt = fbMemberType(d, an)
            if (!mt) throw new StError(`${d} has no output '${a.name}'`, a.pos, a.name.length)
            a.name = an
            checkOutBinding(a.value, mt, `${d} output '${an}'`, scope)
            continue
          }
          if (!FB_INPUTS[d].includes(an)) throw new StError(`${d} has no input '${a.name}'`, a.pos, a.name.length)
          a.name = an
          checkStore(a.value, infer(a.value, scope), FB_INPUT_TYPES[d][an]!, `${d} input '${an}'`, a.pos)
        }
      } else if (isUserFb(d)) {
        const def = scope.fbs.get(identKey(d.fb))
        checkCallArgs(s.args, def ? fbDecls(def) : [], `'${d.fb}'`, scope, true)
      }
      break
    }
    case 'bind':
      break // made by this checker of an assignment it has checked (a REF_TO given a reference, an interface an instance)
    case 'invoke':
      break // made by this checker, of a statement already checked
    case 'if': {
      for (const br of s.branches) {
        infer(br.cond, scope)
        for (const st of br.body) collect(sink, () => checkStmt(st, scope, inLoop, sink))
      }
      if (s.elseBody) for (const st of s.elseBody) collect(sink, () => checkStmt(st, scope, inLoop, sink))
      break
    }
    case 'case': {
      const st = infer(s.selector, scope)
      if (st === 'BOOL' || isReal(st)) throw new StError('CASE selector must be an integer', s.pos)
      // resolve enumeration-member labels against the selector's own enum, so a member of
      // some other enumeration is caught rather than quietly compared as a number
      const selEnum = exprEnum(s.selector)
      for (const clause of s.cases) {
        for (const l of clause.labels) {
          if (l.kind !== 'name') continue
          const m = l.qualifier !== undefined ? qualifiedMember(l.qualifier, l.name, scope.enums, l.pos) : scope.enumMembers.get(identKey(l.name))
          if (!m) throw new StError(`unknown CASE label '${l.name}'`, l.pos, l.name.length)
          if (selEnum && m.enum !== selEnum) {
            throw new StError(`'${m.name}' belongs to ${m.enum}, but this CASE selects on ${selEnum}`, l.pos, l.name.length)
          }
          l.name = m.name
          l.value = m.value
        }
      }
      for (const clause of s.cases) for (const stmt of clause.body) collect(sink, () => checkStmt(stmt, scope, inLoop, sink))
      if (s.elseBody) for (const stmt of s.elseBody) collect(sink, () => checkStmt(stmt, scope, inLoop, sink))
      break
    }
    case 'for': {
      const d = lookup(scope, s.varName)
      if (!d) throw new StError(`undeclared loop variable '${s.varName}'`, s.pos, s.varName.length)
      s.vGlobal = !scope.env.has(identKey(s.varName))
      s.varName = d.name
      if (d.constant) throw new StError(`cannot use CONSTANT '${d.name}' as a loop variable`, s.pos, s.varName.length)
      const vt = d.type
      if (!isScalarType(vt) || vt === 'BOOL' || isReal(vt)) throw new StError('FOR loop variable must be an integer', s.pos)
      s.vt = vt // the emitter needs the loop variable's width to mirror per-iteration coercion
      infer(s.from, scope)
      infer(s.to, scope)
      if (s.by) infer(s.by, scope)
      // the control variable is the loop's, not the body's, for the length of the body -
      // writing to it is rejected here rather than silently ignored at run time
      const key = identKey(s.varName)
      const shadowed = scope.forVars.has(key)
      scope.forVars.add(key)
      try {
        for (const stmt of s.body) collect(sink, () => checkStmt(stmt, scope, true, sink))
      } finally {
        if (!shadowed) scope.forVars.delete(key)
      }
      break
    }
    case 'while': {
      infer(s.cond, scope)
      for (const stmt of s.body) collect(sink, () => checkStmt(stmt, scope, true, sink))
      break
    }
    case 'repeat': {
      infer(s.cond, scope)
      for (const stmt of s.body) collect(sink, () => checkStmt(stmt, scope, true, sink))
      break
    }
    case 'exit': {
      if (!inLoop) throw new StError('EXIT is only valid inside a loop', s.pos)
      break
    }
    case 'continue': {
      if (!inLoop) throw new StError('CONTINUE is only valid inside a loop', s.pos)
      break
    }
    case 'return':
      break // valid in any POU: ends this scan of it
  }
}

/** The first METHOD call (or property read, once typed) in an initial value, if any. */
function methodCallIn(v: Initializer): Extract<Expr, { node: 'mcall' }> | null {
  switch (v.node) {
    case 'mcall':
      return v
    case 'structInit':
      return v.fields.map((f) => methodCallIn(f.value)).find(Boolean) ?? null
    case 'arrayInit':
      return v.items.map(methodCallIn).find(Boolean) ?? null
    case 'unary':
      return methodCallIn(v.expr)
    case 'binary':
      return methodCallIn(v.left) ?? methodCallIn(v.right)
    case 'call':
      return v.args.map(methodCallIn).find(Boolean) ?? null
    case 'member':
    case 'bit':
      return methodCallIn(v.obj)
    case 'index':
      return methodCallIn(v.obj) ?? v.indices.map(methodCallIn).find(Boolean) ?? null
    default:
      return null
  }
}

export function checkBody(decls: Decl[], body: Stmt[], scope: Scope, sink: Diagnostic[] | null = null): void {
  for (const d of decls) {
    collect(sink, () => {
      if (!rejectedTypes.has(d)) {
        checkDeclInit(d, scope)
        impliedInit(d, scope)
      }
      // a starting value is the program's before it runs: no method (or property) of an instance has run to answer it
      const call = [d.init, ...(d.arrayInit ?? []), d.structInit].map((v) => (v ? methodCallIn(v) : null)).find(Boolean)
      if (call) throw new StError(`the initial value of '${d.name}' calls ${call.key?.includes(':') ? 'a property' : 'a method'}: a starting value is decided before anything runs, so set it in the code`, call.pos)
      if (d.constant && !d.init && !d.arrayInit && !d.structInit) throw new StError(`CONSTANT '${d.name}' needs an initial value`, d.pos, d.name.length)
    })
  }
  for (const s of body) collect(sink, () => checkStmt(s, scope, false, sink))
}
