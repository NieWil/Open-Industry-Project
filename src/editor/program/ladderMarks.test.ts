import { describe, expect, it } from 'vitest'
import { parseDocument } from '../../plc'
import { ladderMarks, ladderRoutineOf, mixesLanguages, NO_LADDER, openingFace, sameLadderMarks } from './ladderMarks'

/** The marks of `src`, by POU name, which is how the strip's reader thinks of them. */
function marksByName(src: string): { has: string[]; whole: string[] } {
  const blocks = parseDocument(src).blocks
  const m = ladderMarks(src, blocks)
  const name = (i: number): string => blocks[i]!.name || `<${blocks[i]!.kind}>`
  return { has: [...m.has].map(name).sort(), whole: [...m.whole].map(name).sort() }
}

describe('ladderMarks', () => {
  it('skips the parse for a program with no ladder in it', () => {
    // the shared empty object: identity is the assertion that nothing was parsed
    expect(ladderMarks('VAR x : BOOL; END_VAR\nx := TRUE;\n', [])).toBe(NO_LADDER)
  })

  it('marks a POU whose whole body is a section as a ladder POU', () => {
    const src = `PROGRAM Seal
VAR Start, Stop, Motor : BOOL; END_VAR
LADDER
  [|Start|, |Motor|] |/Stop| (Motor);
END_LADDER
END_PROGRAM
`
    expect(marksByName(src)).toEqual({ has: ['Seal'], whole: ['Seal'] })
  })

  it('marks a POU with a section among statements as holding one, but not as one', () => {
    // the distinction the panel acts on: opening this as rungs would take the statement off screen
    const src = `PROGRAM Mixed
VAR Go, Motor : BOOL; N : INT; END_VAR
N := N + 1;
LADDER
  |Go| (Motor);
END_LADDER
END_PROGRAM
`
    expect(marksByName(src)).toEqual({ has: ['Mixed'], whole: [] })
  })

  it('tells two POUs apart, and leaves the ST one unmarked', () => {
    const src = `PROGRAM Rungs
VAR Go, Motor : BOOL; END_VAR
LADDER
  |Go| (Motor);
END_LADDER
END_PROGRAM

PROGRAM Text
VAR N : INT; END_VAR
N := N + 1;
END_PROGRAM
`
    expect(marksByName(src)).toEqual({ has: ['Rungs'], whole: ['Rungs'] })
  })

  it('does not mark a variable that happens to be called ladder', () => {
    // LADDER is not a reserved word, so the substring shortcut can only say "parse to find out"
    const src = `VAR ladder : INT; END_VAR
ladder := 3;
`
    const m = ladderMarks(src, parseDocument(src).blocks)
    expect(m.has.size).toBe(0)
    expect(m.whole.size).toBe(0)
  })

  it('marks top-level code that is one section', () => {
    const src = `VAR Go, Motor : BOOL; END_VAR
LADDER
  |Go| (Motor);
END_LADDER
`
    const m = ladderMarks(src, parseDocument(src).blocks)
    expect(m.has.size).toBe(1)
    expect([...m.whole]).toEqual([...m.has])
  })

  it('holds no mark for a section that does not close yet', () => {
    // mid-typing: readLadder has no routine to show, so the strip says nothing rather than guessing
    const src = `PROGRAM Half
VAR Go, Motor : BOOL; END_VAR
LADDER
  |Go| (Motor);
END_PROGRAM
`
    expect(ladderMarks(src, parseDocument(src).blocks).has.size).toBe(0)
  })

  describe('which face the panel shows', () => {
    // two ladder POUs and an ST one, the ST one in the middle so an index off by one lands on the wrong language
    const src = `PROGRAM First
VAR Go, Motor : BOOL; END_VAR
LADDER
  |Go| (Motor);
END_LADDER
END_PROGRAM

PROGRAM Text
VAR N : INT; END_VAR
N := N + 1;
END_PROGRAM

PROGRAM Second
VAR Go, Lamp : BOOL; END_VAR
LADDER
  |Go| (Lamp);
END_LADDER
END_PROGRAM
`
    const blocks = parseDocument(src).blocks
    const table = (type: string) => ({ tasks: [{ name: 'T', intervalMs: 10, priority: 1 }], programs: [{ name: 'Main', type, task: 'T' }] })

    it('needs no switch unless a POU mixes the two', () => {
      expect(mixesLanguages(ladderMarks(src, blocks))).toBe(false)
      const mixed = `PROGRAM Mixed
VAR Go, Motor : BOOL; N : INT; END_VAR
N := N + 1;
LADDER
  |Go| (Motor);
END_LADDER
END_PROGRAM
`
      expect(mixesLanguages(ladderMarks(mixed, parseDocument(mixed).blocks))).toBe(true)
      expect(mixesLanguages(NO_LADDER)).toBe(false)
    })

    it('finds the section a ladder POU is, and none for an ST one', () => {
      expect(ladderRoutineOf(src, blocks, 0)).toBe(0)
      expect(ladderRoutineOf(src, blocks, 1)).toBe(null)
      expect(ladderRoutineOf(src, blocks, 2)).toBe(1)
      expect(ladderRoutineOf(src, blocks, 3)).toBe(null) // past the last block
    })

    it('opens on the program the controller runs, in its own language', () => {
      expect(openingFace(src, blocks, table('Second'))).toEqual({ ladder: true, routine: 1 })
      expect(openingFace(src, blocks, table('text'))).toEqual({ ladder: false, routine: null }) // names are case-blind
    })

    it('without a table, opens on the program the default table runs, not on a block written above it', () => {
      const lib = `FUNCTION_BLOCK Mover
VAR_INPUT Enable : BOOL; END_VAR
VAR_OUTPUT Done : BOOL; END_VAR
Done := Enable;
END_FUNCTION_BLOCK

${src}`
      expect(openingFace(lib, parseDocument(lib).blocks, null)).toEqual({ ladder: true, routine: 0 })
      // a CONFIGURATION in the text is the table, though none is stored
      const configured = `${lib}
CONFIGURATION Cell
  RESOURCE R ON PLC
    TASK T (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM P WITH T : Second;
  END_RESOURCE
END_CONFIGURATION
`
      expect(openingFace(configured, parseDocument(configured).blocks, null)).toEqual({ ladder: true, routine: 1 })
    })

    it('opens on the first block without a table, or when the table names nothing here', () => {
      expect(openingFace(src, blocks, null)).toEqual({ ladder: true, routine: 0 })
      expect(openingFace(src, blocks, table('Elsewhere'))).toEqual({ ladder: true, routine: 0 })
    })
  })

  describe('sameLadderMarks', () => {
    it('is true for equal sets and false when one block differs', () => {
      const a = { has: new Set([1, 2]), whole: new Set([1]) }
      expect(sameLadderMarks(a, { has: new Set([2, 1]), whole: new Set([1]) })).toBe(true)
      expect(sameLadderMarks(a, { has: new Set([1, 2]), whole: new Set([1, 2]) })).toBe(false)
      expect(sameLadderMarks(a, { has: new Set([1]), whole: new Set([1]) })).toBe(false)
    })
  })
})
