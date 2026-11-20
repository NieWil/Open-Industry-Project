// Find and Replace over ladder (ladderFind.ts), for the IEC dialect's leaf, through IEC_LEAVES - a contact's or coil's variable, a block's instance and pin values
// are fields; a function's name is its word, found and never replaced.

import { describe, expect, it } from 'vitest'
import { findInLadder, replaceable, replaceFound, stepFound } from './ladderFind'
import { printRung, readLadder } from './ladderRungs'
import { IEC_LEAVES } from './ladderLeaves'

const SRC = `VAR Start, Stop, Motor, Motor2, Late : BOOL; T1 : TON; n : INT; END_VAR
LADDER
  (* the seal-in: Motor runs *)
  [|Start|, |Motor|] |/Stop| (Motor);
  |Motor| T1(IN, PT := T#2s) (Late);
  EQ(IN1 := n, IN2 := 10, OUT) (Motor2);
END_LADDER
`
const routines = readLadder(SRC)

describe('ladder find, IEC', () => {
  it('finds a variable in reading order: the comment above a rung, then left to right and down the branch levels', () => {
    expect(findInLadder(routines, { query: 'Motor', whole: true }, 'all', IEC_LEAVES)).toEqual([
      { routine: 0, rung: 0, trail: [], field: 'comment' },
      { routine: 0, rung: 0, trail: [0, 1, 0], field: 0 },
      { routine: 0, rung: 0, trail: [2], field: 0 },
      { routine: 0, rung: 1, trail: [0], field: 0 },
    ])
    // not whole: Motor2 too
    expect(findInLadder(routines, { query: 'motor', whole: false }, 'all', IEC_LEAVES)).toHaveLength(5)
  })

  it("a block's instance and its pin values are fields; a function's name is its word, found and never replaced", () => {
    expect(findInLadder(routines, { query: 'T1', whole: true }, 'all', IEC_LEAVES)).toEqual([{ routine: 0, rung: 1, trail: [1], field: 0 }])
    expect(findInLadder(routines, { query: '10', whole: true }, 'all', IEC_LEAVES)).toEqual([{ routine: 0, rung: 2, trail: [0], field: 2 }])
    const eq = findInLadder(routines, { query: 'EQ', whole: true }, 'all', IEC_LEAVES)
    expect(eq).toEqual([{ routine: 0, rung: 2, trail: [0], field: -1 }])
    expect(replaceable(eq[0]!)).toBe(false)
    expect(replaceFound(routines, eq, { query: 'EQ', whole: true }, 'NE', IEC_LEAVES).get(0)?.map(printRung)[2] ?? 'untouched').toBe('untouched')
  })

  it('Replace All goes through the rungs, so the result is still ladder - comment, contacts, coils, instances, pins', () => {
    const opts = { query: 'Motor', whole: true }
    const replaced = replaceFound(routines, findInLadder(routines, opts, 'all', IEC_LEAVES), opts, 'Pump', IEC_LEAVES).get(0)!
    expect(replaced.map(printRung)).toEqual(['[|Start|, |Pump|] |/Stop| (Pump)', '|Pump| T1(IN, PT := T#2s) (Late)', 'EQ(IN1 := n, IN2 := 10, OUT) (Motor2)'])
    expect(replaced[0]!.comment).toBe('the seal-in: Pump runs')
    const renamed = replaceFound(routines, findInLadder(routines, { query: 'T1', whole: true }, 'all', IEC_LEAVES), { query: 'T1', whole: true }, 'Dwell', IEC_LEAVES).get(0)!
    expect(printRung(renamed[1]!)).toBe('|Motor| Dwell(IN, PT := T#2s) (Late)')
    const pin = replaceFound(routines, findInLadder(routines, { query: '10', whole: true }, 'all', IEC_LEAVES), { query: '10', whole: true }, '12', IEC_LEAVES).get(0)!
    expect(printRung(pin[2]!)).toBe('EQ(IN1 := n, IN2 := 12, OUT) (Motor2)')
    // the rungs the view holds are never edited in place
    expect(routines[0]!.rungs.map(printRung)[0]).toBe('[|Start|, |Motor|] |/Stop| (Motor)')
  })

  it('a field replaced to nothing is a blank to fill, not a rung that no longer reads', () => {
    const opts = { query: 'Late', whole: true }
    const blanked = replaceFound(routines, findInLadder(routines, opts, 'all', IEC_LEAVES), opts, '', IEC_LEAVES).get(0)!
    expect(printRung(blanked[1]!)).toBe('|Motor| T1(IN, PT := T#2s) (?)')
  })

  it('steps through the matches, wrapping only when asked', () => {
    const found = findInLadder(routines, { query: 'Motor', whole: true }, 'all', IEC_LEAVES)
    expect(stepFound(found, found[3]!, 1, false)).toBeNull()
    expect(stepFound(found, found[3]!, 1, true)).toEqual(found[0])
  })
})
