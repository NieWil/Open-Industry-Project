// The type checker's assignment rules: which implicit widenings IEC allows, and how an untyped literal takes
// the type of the place it is stored into.

import { isCalendar, isInt, isReal, isString, isTime, wrap } from './runtime'
import type { Expr, ScalarType, SourcePos } from './types'
import { StError } from './types'

/** Implicit-widening chains. IEC permits a widening within a family and nothing else, so
 *  signed and bit-string types never cross implicitly and nothing ever narrows. */
// The three integer families. A value widens freely inside its family and never across one:
// SINT -> DINT is safe, SINT -> UDINT is not (a negative has no unsigned counterpart), and
// UINT -> WORD is a reinterpretation rather than a widening.
const SIGNED_WIDENING: ScalarType[] = ['SINT', 'INT', 'DINT']
const UNSIGNED_WIDENING: ScalarType[] = ['USINT', 'UINT', 'UDINT']
const BITSTRING_WIDENING: ScalarType[] = ['BYTE', 'WORD', 'DWORD']
const FAMILIES = [SIGNED_WIDENING, UNSIGNED_WIDENING, BITSTRING_WIDENING]

/**
 * Can a `vt` value be stored into a `tt` place with no explicit conversion?
 *
 * Only IEC's safe widenings: up a signed chain, up a bit-string chain, any integer into a
 * real, and REAL into LREAL. Everything else - narrowing, BOOL <-> number, TIME <-> number,
 * signed <-> bit-string - needs the author to write the conversion. Accepting more here would
 * be a portability defect: the program compiles in the simulator and then fails to build on
 * the target, or rounds differently there.
 */
function assignable(vt: ScalarType, tt: ScalarType): boolean {
  // STRING to STRING is compatible whatever the two capacities are - IEC assignment
  // ignores the bound and the store truncates. Nothing else crosses into or out of it.
  if (vt === tt) return true
  if (vt === 'BOOL' || tt === 'BOOL' || isTime(vt) || isTime(tt) || isCalendar(vt) || isCalendar(tt) || isString(vt) || isString(tt)) return false
  for (const family of FAMILIES) {
    const from = family.indexOf(vt)
    const to = family.indexOf(tt)
    if (from >= 0 && to >= 0) return to > from // widening within one family
    if (from >= 0 || to >= 0) {
      // one side is in this family and the other is not: only the int -> real widenings
      // below can still apply, so stop scanning families here
      break
    }
  }
  if (isInt(vt) && isReal(tt)) return true
  return vt === 'REAL' && tt === 'LREAL'
}

/** Reject a store/argument that IEC would require an explicit conversion for, naming it. */
export function checkAssignable(vt: ScalarType, tt: ScalarType, what: string, pos: SourcePos): void {
  if (assignable(vt, tt)) return
  // every `X_TO_STRING` / `STRING_TO_X` exists, so a string mismatch always has a named fix
  const stringy = isString(vt) || isString(tt)
  const awkward = vt === 'BOOL' || tt === 'BOOL' || isTime(vt) || isTime(tt) || isCalendar(vt) || isCalendar(tt)
  const fix = awkward && !stringy ? '' : ` (write ${vt}_TO_${tt}(...))`
  throw new StError(`cannot assign ${vt} to ${what} of type ${tt}${fix}`, pos)
}

/**
 * Is this expression made only of untyped numeric literals and operators over them?
 *
 * Such a subtree has no type of its own in IEC - it takes one from context. `si := 127`,
 * `w := NOT 0` and `rsi := si + 1` are all ordinary ST, and would be nonsense to reject as
 * narrowing just because the magnitude rule happened to call the literal an INT.
 */
export function isLiteralTree(e: Expr): boolean {
  switch (e.node) {
    case 'num': return !e.declared
    case 'unary': return isLiteralTree(e.expr)
    case 'binary': return isLiteralTree(e.left) && isLiteralTree(e.right)
    default: return false
  }
}

/** Fold a literal tree to its constant value, or NaN when it isn't foldable without first
 *  knowing the width (NOT, and the bitwise/comparison operators, depend on it). */
function foldConst(e: Expr): number {
  switch (e.node) {
    case 'num': return e.value
    case 'unary': return e.op === 'NEG' ? -foldConst(e.expr) : e.op === 'POS' ? foldConst(e.expr) : NaN
    case 'binary': {
      const l = foldConst(e.left)
      const r = foldConst(e.right)
      switch (e.op) {
        case '+': return l + r
        case '-': return l - r
        case '*': return l * r
        default: return NaN
      }
    }
    default: return NaN
  }
}

/** Does every literal in the tree fit the type its context wants? A foldable tree is judged
 *  by its folded value (so `-32768` fits INT even though `32768` alone does not); otherwise
 *  each leaf is judged on its own. */
function literalTreeFits(e: Expr, tt: ScalarType): boolean {
  if (isReal(tt)) return true // any numeric literal is representable in a real
  const folded = foldConst(e)
  if (!Number.isNaN(folded)) return Number.isInteger(folded) && wrap(tt, folded) === folded
  const leafFits = (x: Expr): boolean => {
    if (x.node === 'num') return Number.isInteger(x.value) && wrap(tt, x.value) === x.value
    if (x.node === 'unary') return leafFits(x.expr)
    if (x.node === 'binary') return leafFits(x.left) && leafFits(x.right)
    return false
  }
  return leafFits(e)
}

/** Retype a literal tree to the type its context wants, if every literal in it fits. */
export function retypeLiteralTree(e: Expr, tt: ScalarType): boolean {
  if (tt === 'BOOL' || isTime(tt) || isCalendar(tt) || isString(tt) || !isLiteralTree(e) || !literalTreeFits(e, tt)) return false
  const stamp = (x: Expr): void => {
    x.t = tt
    if (x.node === 'num' && isReal(tt)) x.value = wrap(tt, x.value)
    if (x.node === 'unary') stamp(x.expr)
    if (x.node === 'binary') { stamp(x.left); stamp(x.right) }
  }
  stamp(e)
  return true
}

/**
 * `0` and `1` are Boolean literals in IEC 61131-3, alongside `FALSE` and `TRUE`. The standard's
 * own Annex F examples write `VAR_OUTPUT Q : BOOL := 0;` and then `Q := 1;`.
 *
 * Only a bare literal: `INT#1` is a typed integer and stays an error, so does a variable
 * of integer type, so does `2`, and an expression is never folded into a BOOL - `NOT 0` already
 * means a bit-string complement here, and reading one spelling two ways by context is how a
 * program comes to mean one thing in the simulator and another on the target.
 *
 * The node is rewritten to a `bool` literal rather than tagged, so both backends, the watch table
 * and both exporters see an ordinary Boolean with no special case anywhere. Export fidelity is
 * unaffected: initial values are sliced from the source text, so `:= 0` still exports as `:= 0`.
 */
function retypeBoolLiteral(e: Expr, tt: ScalarType): boolean {
  if (tt !== 'BOOL' || e.node !== 'num' || e.declared !== undefined || e.real) return false
  if (e.value !== 0 && e.value !== 1) return false
  const node = e as unknown as { node: 'bool'; value: boolean; t: ScalarType }
  node.value = e.value === 1
  node.node = 'bool'
  node.t = 'BOOL'
  return true
}

/** Check a store, letting an untyped literal tree adopt the destination's type first. */
export function checkStore(value: Expr, vt: ScalarType, tt: ScalarType, what: string, pos: SourcePos): void {
  // BOOL first: retypeLiteralTree refuses BOOL outright, and this rule is about a destination
  // that wants one - not about balancing the two sides of an expression, which is why it is here
  // rather than in retypeLiteralTree (`x AND 1` must stay a bit-string question).
  if (retypeBoolLiteral(value, tt)) return
  if (retypeLiteralTree(value, tt)) return
  checkAssignable(vt, tt, what, pos)
}
