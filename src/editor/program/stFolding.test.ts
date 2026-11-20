import { describe, expect, it } from 'vitest'
import { stFolds } from './stFolding'

/** Each fold as `opening line → the text right after the fold`, the way a reader sees what stays visible. */
function folds(src: string): string[] {
  return stFolds(src).map((f) => {
    const opener = src.slice(src.lastIndexOf('\n', f.from - 1) + 1, f.from).trim()
    return `${f.kind}: ${opener} -> ${src.slice(f.to, f.to + 24).trim().split('\n')[0]}`
  })
}

describe('stFolds', () => {
  it('folds VAR sections, POUs and statement blocks, keeping the END_ line visible', () => {
    const src = `PROGRAM Main
VAR
  Count : INT;
END_VAR
IF Count > 3 THEN
  Count := 0;
END_IF;
END_PROGRAM
`
    expect(folds(src)).toEqual(['pou: PROGRAM Main -> END_PROGRAM', 'declaration: VAR -> END_VAR', 'statement: IF Count > 3 THEN -> END_IF;'])
    const f = stFolds(src)[1]!
    expect(src.slice(f.from, f.to)).toBe('\n  Count : INT;')
  })

  it('folds every VAR section kind, TYPE and STRUCT as declarations', () => {
    const src = `TYPE Pos :
STRUCT
  X : REAL;
END_STRUCT;
END_TYPE
FUNCTION_BLOCK Axis
VAR_INPUT
  Go : BOOL;
END_VAR
VAR_OUTPUT
  Done : BOOL;
END_VAR
END_FUNCTION_BLOCK
`
    expect(folds(src).map((s) => s.split(' -> ')[0])).toEqual(['declaration: TYPE Pos :', 'declaration: STRUCT', 'pou: FUNCTION_BLOCK Axis', 'declaration: VAR_INPUT', 'declaration: VAR_OUTPUT'])
  })

  it('ignores keywords in comments and strings, and a block on one line', () => {
    const src = `PROGRAM Main
(* IF this were code
END_IF *)
// CASE x OF
Msg := 'IF $' END_IF';
IF a THEN b := 1; END_IF;
END_PROGRAM
`
    expect(folds(src)).toEqual(['pou: PROGRAM Main -> END_PROGRAM'])
  })

  it('keeps the outer folds when an inner block is half typed', () => {
    const src = `PROGRAM Main
VAR x : INT; END_VAR
IF x > 1 THEN
  x := 2 #;
END_PROGRAM
PROGRAM Other
CASE x OF
  1: x := 2;
END_CASE
END_PROGRAM
`
    expect(folds(src)).toEqual(['pou: PROGRAM Main -> END_PROGRAM', 'pou: PROGRAM Other -> END_PROGRAM', 'statement: CASE x OF -> END_CASE'])
  })

  it("does not take a variable called program for a POU, or a CONFIGURATION's instance line for one", () => {
    const src = `CONFIGURATION Plant
  RESOURCE Cpu ON PLC
    TASK Fast (INTERVAL := T#10ms);
    PROGRAM Inst WITH Fast : Main;
  END_RESOURCE
END_CONFIGURATION
PROGRAM Main
VAR program : INT; END_VAR
program := program + 1;
END_PROGRAM
`
    expect(folds(src)).toEqual(['pou: CONFIGURATION Plant -> END_CONFIGURATION', 'pou: RESOURCE Cpu ON PLC -> END_RESOURCE', 'pou: PROGRAM Main -> END_PROGRAM'])
  })

  it('folds a LADDER section only when the word stands alone, and survives CRLF and an unterminated comment', () => {
    const crlf = 'PROGRAM Main\r\nLADDER\r\n|--( Q )--|\r\nEND_LADDER\r\nEND_PROGRAM\r\n'
    const f = stFolds(crlf)
    expect(f.map((x) => x.kind)).toEqual(['pou', 'statement'])
    expect(crlf.slice(f[1]!.from, f[1]!.to)).toBe('\r\n|--( Q )--|')
    expect(folds('PROGRAM Main\nladder := 1;\nEND_PROGRAM\n')).toEqual(['pou: PROGRAM Main -> END_PROGRAM'])
    expect(folds('PROGRAM Main\nVAR\n x : INT;\nEND_VAR\n(* open\nIF a THEN\n b := 1;\nEND_IF\n')).toEqual(['declaration: VAR -> END_VAR'])
  })
})
