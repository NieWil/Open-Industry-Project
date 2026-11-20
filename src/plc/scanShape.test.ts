// @unlocked-realm: the generated scan source is read where scanCodegen.ts evaluates it with the Function constructor.
// Locked down it goes to a Compartment instead, which a test cannot look inside.
//
// The shape of the code the typed engine generates, where its speed depends on that shape and a timing gate cannot
// tell (scanSpeed.test.ts measured both spreads overlapping): helper calls past V8's inlining budget in a long body
// stay real calls, so a subscript read from storage is checked in place, and a user FUNCTION call stores its arguments
// itself, with no argument array. scanEngines.test.ts proves these programs answer as the walker does.

import { describe, expect, it } from 'vitest'
import { compile } from './interpreter'

/** Every source the typed engine generated while compiling `src`. */
function generated(src: string): string {
  const seen: string[] = []
  const Real = globalThis.Function
  ;(globalThis as { Function: unknown }).Function = function (...args: string[]) {
    seen.push(args[args.length - 1]!)
    return Real(...args)
  }
  try {
    compile(src)
  } finally {
    ;(globalThis as { Function: unknown }).Function = Real
  }
  return seen.join('\n')
}

const FUNCS = `
FUNCTION Scale : REAL
VAR_INPUT x : REAL; k : REAL; END_VAR
Scale := x * k;
END_FUNCTION
`

describe('the shape of the generated scan code', () => {
  it('checks a subscript read from storage in place, and a computed one through ix()', () => {
    const src = generated('PROGRAM Main VAR a : ARRAY[1..5] OF DINT; i : INT; END_VAR a[i] := 1; a[i + 1] := 2; END_PROGRAM')
    expect(src).toContain('ixFault(')
    expect(src.match(/\bix\(/g)).toHaveLength(1)
  })

  it('stores a positional FUNCTION call\'s arguments at the call site, with no argument array', () => {
    const src = generated(`${FUNCS}PROGRAM Main VAR r : REAL; END_VAR r := Scale(r, 2.0); END_PROGRAM`)
    expect(src).toContain('.enter();')
    expect(src).not.toContain('.call([')
  })

  it('stores a block input its type already proves without coercing it', () => {
    const src = generated(`FUNCTION_BLOCK Zone VAR_INPUT On : BOOL; Target : DINT; END_VAR VAR_OUTPUT n : DINT; END_VAR
IF On THEN n := Target; END_IF; END_FUNCTION_BLOCK
PROGRAM Main VAR z : Zone; t : DINT; END_VAR z(On := TRUE, Target := t); END_PROGRAM`)
    expect(src).not.toMatch(/\b(bool|coI)\(/)
  })

  it('copies a STRING place into another in memory, and builds the text only where finding the place runs code', () => {
    const decls = 'VAR a : STRING[80]; b : STRING[5]; arr : ARRAY[0..3] OF STRING[7]; i : INT; END_VAR'
    const copied = generated(`PROGRAM Main ${decls} b := a; arr[i] := b; a := arr[2]; END_PROGRAM`)
    expect(copied.match(/\bstrCopy\(/g)).toHaveLength(3)
    expect(copied).not.toMatch(/\bstr(At|Put)\(/)
    // the capacity a store cuts to: the shorter place's own
    expect(copied).toMatch(/strCopy\([^,]+, 5, /)
    const called = generated(`FUNCTION Pick : INT VAR_INPUT i : INT; END_VAR Pick := i; END_FUNCTION
PROGRAM Main ${decls} arr[Pick(i)] := a; END_PROGRAM`)
    expect(called).not.toMatch(/\bstrCopy\(/)
  })
})
