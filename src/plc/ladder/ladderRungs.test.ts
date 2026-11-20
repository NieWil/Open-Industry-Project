// Ladder as a view edits it (ladderRungs.ts): rungs out of the program text and back into it.

import { describe, expect, it } from 'vitest'
import { compile } from '../interpreter'
import { declareInstance, freshInstanceName, newItem, operandProblem, parseRungText, printRung, readLadder, writeLadder } from './ladderRungs'
import type { Diagnostic } from '../types'

const PROGRAM = `VAR Start, Stop, Motor : BOOL; END_VAR
LADDER
  (* the seal-in *)
  [|Start|, |Motor|] |/Stop| (Motor);
  |Motor| (?);
END_LADDER
`

describe('reading rungs out of the text', () => {
  it('gives each rung its elements as written and the comment above it', () => {
    const [r] = readLadder(PROGRAM)
    expect(r!.pou).toBe('')
    expect(r!.whole).toBe(true)
    expect(r!.rungs.map(printRung)).toEqual(['[|Start|, |Motor|] |/Stop| (Motor)', '|Motor| (?)'])
    expect(r!.rungs[0]!.comment).toBe('the seal-in')
    expect(r!.unreadable).toEqual([])
  })

  it('a rung with a blank reads, and reports what is missing on its own rung', () => {
    const [r] = readLadder(PROGRAM)
    expect(r!.rungProblems[0]).toEqual([])
    expect(r!.rungProblems[1]!.map((d) => d.message)).toEqual(['This coil has no variable yet: the ? on this rung'])
    // ...and on its element: the coil, second on the rung
    expect(r!.rungProblemTrails[1]).toEqual([[1]])
  })

  it('a problem points at the element it is in, inside a branch too (what a fault\'s "Show" selects)', () => {
    const src = 'VAR A, B, C : BOOL; END_VAR\nLADDER\n  [|A|, |B|] (C);\nEND_LADDER'
    const at = (needle: string): Diagnostic => ({ message: 'x', pos: { offset: src.indexOf(needle), line: 1, col: 1 }, length: 1 })
    const [r] = readLadder(src, [at('B|'), at('(C')])
    expect(r!.rungProblemTrails[0]).toEqual([[0, 1, 0], [1]])
  })

  it('text that does not read as a rung is set apart, which keeps the section from being rewritten over it', () => {
    const [r] = readLadder('LADDER\n  |A| (B);\n  |A (;\nEND_LADDER')
    expect(r!.rungs).toHaveLength(1)
    expect(r!.unreadable).toHaveLength(1)
  })

  it('names the POU a section stands in, and whether it is that POU\'s whole body', () => {
    const src = `FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR VAR_OUTPUT Q : BOOL; END_VAR
LADDER
  |S| (S Q);
END_LADDER
END_FUNCTION_BLOCK
VAR a : BOOL; END_VAR
a := TRUE;
LADDER
  |a| (a);
END_LADDER`
    expect(readLadder(src).map((r) => [r.pou, r.whole])).toEqual([
      ['Latch', true],
      ['', false],
    ])
  })
})

describe('writing rungs back', () => {
  it('reprints the section in place, comments as (* *), and leaves the rest of the text alone', () => {
    const [r] = readLadder(PROGRAM)
    const rungs = [...r!.rungs, { comment: 'stops it\ntoo', elements: [newItem({ kind: 'contact', mode: 'closed' })] }]
    const next = writeLadder(PROGRAM, 0, rungs)
    expect(next).toBe(`VAR Start, Stop, Motor : BOOL; END_VAR
LADDER
  (* the seal-in *)
  [|Start|, |Motor|] |/Stop| (Motor);
  |Motor| (?);
  (* stops it *)
  (* too *)
  |/?|;
END_LADDER
`)
    // and what it wrote reads back as what it was given
    expect(readLadder(next)[0]!.rungs.map((x) => x.comment)).toEqual(['the seal-in', '', 'stops it\ntoo'])
  })

  it('keeps the indentation of a section inside a POU', () => {
    const src = 'PROGRAM Main\n  VAR a : BOOL; END_VAR\n  LADDER\n    |a| (a);\n  END_LADDER\nEND_PROGRAM\n'
    const [r] = readLadder(src)
    expect(writeLadder(src, 0, r!.rungs)).toBe('PROGRAM Main\n  VAR a : BOOL; END_VAR\n  LADDER\n    |a| (a);\n  END_LADDER\nEND_PROGRAM\n')
  })
})

describe('rung text for a paste or a retyped rung', () => {
  it('reads a run of elements, whole rungs, and nothing else', () => {
    expect(parseRungText('|A| |/B|')).toMatchObject({ kind: 'elements', elements: [{ type: 'contact', mode: 'open', operand: 'A' }, { type: 'contact', mode: 'closed' }] })
    expect(parseRungText('|A| (B);\n(S C);')?.kind).toBe('rungs')
    expect(parseRungText('hello world')).toBeNull()
    expect(parseRungText('')).toBeNull()
  })

  it('refuses at the field what a rung could not read', () => {
    expect(operandProblem('Motor.Run[2]', true)).toBeNull()
    expect(operandProblem('a + b', true)).toMatch(/not a variable/)
    expect(operandProblem('T#2s', false)).toBeNull()
    expect(operandProblem('(', false)).toMatch(/does not read/)
  })
})

describe('new blocks', () => {
  it('declares a block drawn on a rung, in its POU, where the instance keeps its state', () => {
    const src = 'VAR\n  go : BOOL;\nEND_VAR\nLADDER\n  |go| ?(IN, PT := T#1s);\nEND_LADDER\n'
    const name = freshInstanceName(src, 'TON')
    expect(name).toBe('TON_1')
    const declared = declareInstance(src, 0, name, 'TON')
    expect(declared).toBe('VAR\n  go : BOOL;\n  TON_1 : TON;\nEND_VAR\nLADDER\n  |go| ?(IN, PT := T#1s);\nEND_LADDER\n')
    // one line of VAR takes it on that line; a VAR_INPUT block gets a VAR block of its own
    expect(declareInstance('VAR go : BOOL; END_VAR\nLADDER\n  ;\nEND_LADDER', 0, 'T1', 'TON')).toBe('VAR go : BOOL; T1 : TON; END_VAR\nLADDER\n  ;\nEND_LADDER')
    expect(declareInstance('VAR_INPUT go : BOOL; END_VAR\nLADDER\n  ;\nEND_LADDER', 0, 'T1', 'TON')).toBe('VAR_INPUT go : BOOL; END_VAR\nVAR\n  T1 : TON;\nEND_VAR\nLADDER\n  ;\nEND_LADDER')
  })

  it('a timer taken from the palette, named and declared, is a program that runs', () => {
    const src = 'VAR go, late : BOOL; END_VAR\nLADDER\n  |go| (late);\nEND_LADDER\n'
    const [r] = readLadder(src)
    const name = freshInstanceName(src, 'TON')
    const box = newItem({ kind: 'block', type: 'TON' }, name)
    const rung = { comment: '', elements: [r!.rungs[0]!.elements[0]!, { ...box, pins: box.type === 'box' ? box.pins.map((p) => (p.name === 'PT' ? { ...p, value: 'T#20ms' } : p)) : [] }, r!.rungs[0]!.elements[1]!] }
    const next = writeLadder(declareInstance(src, 0, name, 'TON'), 0, [rung])
    expect(next).toContain('|go| TON_1(IN, PT := T#20ms) (late);')
    const p = compile(next)
    p.setInput('go', true)
    for (let i = 0; i < 4; i++) p.scan(0.01)
    expect(p.get('late')).toBe(true)
  })
})
