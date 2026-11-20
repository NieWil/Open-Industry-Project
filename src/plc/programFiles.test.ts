import { describe, expect, it } from 'vitest'
import { joinProgramFiles } from '../core/project/projectFolder'
import { flattenDocument, parseDocument } from './document'
import { holdsLadder, programFiles } from './programFiles'

const PROGRAM = [
  'TYPE',
  '  Mode : (Idle, Run);',
  'END_TYPE',
  '',
  'VAR_GLOBAL',
  '  Count : INT;',
  'END_VAR',
  '',
  'INTERFACE IStep',
  'END_INTERFACE',
  '',
  '(* a note over a block documents that block *)',
  'FUNCTION_BLOCK Latch',
  'VAR_INPUT',
  '  S : BOOL;',
  'END_VAR',
  'END_FUNCTION_BLOCK',
  '',
  'FUNCTION Twice : INT',
  'VAR_INPUT',
  '  N : INT;',
  'END_VAR',
  'Twice := N * 2;',
  'END_FUNCTION',
  '',
  'PROGRAM Cell',
  'VAR',
  '  Start, Motor : BOOL;',
  'END_VAR',
  'LADDER',
  '  |Start| (Motor);',
  'END_LADDER',
  'END_PROGRAM',
  '',
  'PROGRAM Aux',
  'Count := Twice(N := Count);',
  'END_PROGRAM',
  '',
].join('\n')

const names = (source: string): string[] => programFiles(source).map((f) => f.name)
const roundTrip = (source: string): string => joinProgramFiles(programFiles(source).map((f) => f.text))

describe('a program as files', () => {
  it('is one file per block, in the order written, each named for what it declares', () => {
    expect(names(PROGRAM)).toEqual(['type.st', 'var_global.st', 'IStep.st', 'Latch.st', 'Twice.st', 'Cell.ld', 'Aux.st'])
  })

  it('keeps the comment written above a block in that block', () => {
    expect(programFiles(PROGRAM).find((f) => f.name === 'Latch.st')!.text).toMatch(/^\(\* a note over a block/)
  })

  it('names the code outside every POU program.st, after the POUs, and a trailing CONFIGURATION for itself', () => {
    const source = `FUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n\nVAR\n  Run : BOOL;\nEND_VAR\nRun := TRUE;\n\nCONFIGURATION Plant\n  RESOURCE R ON PLC\n    TASK T (INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM Main WITH T : Main;\n  END_RESOURCE\nEND_CONFIGURATION\n`
    expect(names(source)).toEqual(['Latch.st', 'program.st', 'Plant.st'])
  })

  it('gives .ld only to a block holding a LADDER section, not to one that says the word', () => {
    expect(holdsLadder('(* END_LADDER *)\nladder := 3;')).toBe(false)
    expect(holdsLadder("Msg := 'END_LADDER';")).toBe(false)
    expect(holdsLadder('LADDER\n  |A| (B);\nEND_LADDER')).toBe(true)
  })

  it('reads back as the same program, in the document model normal form with a closing newline', () => {
    const back = roundTrip(PROGRAM)
    expect(back).toBe(`${flattenDocument(parseDocument(PROGRAM))}\n`)
    expect(parseDocument(back).blocks).toEqual(parseDocument(PROGRAM).blocks)
    // and splitting what was read back writes the same files
    expect(programFiles(back)).toEqual(programFiles(PROGRAM))
  })

  it('is one file, exactly as written, for a single block or source the block split cannot read', () => {
    const single = 'VAR_OUTPUT\n  Run : BOOL;\nEND_VAR\n\n\nRun := TRUE;   \n'
    expect(programFiles(single)).toEqual([{ name: 'program.st', text: single }])
    expect(roundTrip(single)).toBe(single)
    // a POU half typed: no END_ yet, so there are no blocks to split
    const halfTyped = 'FUNCTION_BLOCK Latch\nVAR_INPUT\n  S : BOOL;\nEND_VAR\n\nPROGRAM Cell\nLADDER\n  |S| (Q);\nEND_LADDER\nEND_PROGRAM\n'
    expect(programFiles(halfTyped)).toEqual([{ name: 'program.ld', text: halfTyped }])
    expect(roundTrip(halfTyped)).toBe(halfTyped)
  })

  it('takes a -2 suffix for a name that differs from another only in case, as some file systems do not tell them apart', () => {
    const source = 'FUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n\nFUNCTION_BLOCK LATCH\nEND_FUNCTION_BLOCK\n\nTYPE\n  A : INT;\nEND_TYPE\n\nTYPE\n  B : INT;\nEND_TYPE\n'
    expect(names(source)).toEqual(['Latch.st', 'LATCH-2.st', 'type.st', 'type-2.st'])
  })

  it('is no files for an empty program', () => {
    expect(programFiles('')).toEqual([])
    expect(programFiles('  \n')).toEqual([])
  })
})
