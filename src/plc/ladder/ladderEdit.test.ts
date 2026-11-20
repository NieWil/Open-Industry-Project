// The gestures of the ladder editor (ladderEdit.ts), on IEC rungs. Nothing in them depends on what an element is, so
// they hold for contacts, coils and blocks alike.

import { describe, expect, it } from 'vitest'
import { addBranch, addPath, addRung, canAddPath, elementRange, insertElements, insertItem, insertRungs, moveElement, moveRung, moveRungTo, removeRange, removeSelected, resizeBranch, stepInstruction } from './ladderEdit'
import type { LadderEdit as LadderEditOf } from './ladderEdit'
import { newItem, printRung, readLadder } from './ladderRungs'
import { fieldsOf, setField } from './ladderLeaves'
import type { Rung, RungItem } from './ladderRungs'

type LadderEdit = LadderEditOf<RungItem>

const text = (e: LadderEdit | Rung[]): string[] => (Array.isArray(e) ? e : e.rungs).map(printRung)
const NO: RungItem = newItem({ kind: 'contact', mode: 'open' })
const NC: RungItem = newItem({ kind: 'contact', mode: 'closed' })
const COIL: RungItem = newItem({ kind: 'coil', mode: 'normal' })
const SET: RungItem = newItem({ kind: 'coil', mode: 'set' })

/** Build a rung the way a person does: each step acts on the selection the last one left. */
function build(): LadderEdit {
  let e: LadderEdit = addRung([], -1)
  e = insertItem(e.rungs, e.sel!, NO)
  return { rungs: setField(e.rungs, e.sel!, 0, 'Start'), sel: e.sel }
}

/** `|Start| |/Stop| (Motor)`, built left to right. */
function seriesRung(): Rung[] {
  let e = build()
  e = insertItem(e.rungs, e.sel!, NC)
  e = { rungs: setField(e.rungs, e.sel!, 0, 'Stop'), sel: e.sel }
  e = insertItem(e.rungs, e.sel!, COIL)
  return setField(e.rungs, e.sel!, 0, 'Motor')
}

describe('ladder editing gestures', () => {
  it('with the rung selected an element lands at its start; the next one follows it', () => {
    let e = build()
    e = insertItem(e.rungs, { rung: 0, trail: [] }, COIL)
    expect(text(e)).toEqual(['(?) |Start|'])
    expect(e.sel).toEqual({ rung: 0, trail: [0] })
    e = insertItem(e.rungs, e.sel!, NC)
    expect(text(e)).toEqual(['(?) |/?| |Start|'])
  })

  it('drag and drop: an element moved to a slot in its own series, another series, or a branch level', () => {
    const rungs = seriesRung()
    expect(text(moveElement(rungs, { rung: 0, trail: [0] }, { rung: 0, home: [], index: 3 }))).toEqual(['|/Stop| (Motor) |Start|'])
    expect(text(moveElement(rungs, { rung: 0, trail: [2] }, { rung: 0, home: [], index: 0 }))).toEqual(['(Motor) |Start| |/Stop|'])
    // where it already stands: nothing moves
    expect(text(moveElement(rungs, { rung: 0, trail: [1] }, { rung: 0, home: [], index: 1 }))).toEqual(['|Start| |/Stop| (Motor)'])
    expect(text(moveElement(rungs, { rung: 0, trail: [1] }, { rung: 0, home: [], index: 2 }))).toEqual(['|Start| |/Stop| (Motor)'])
    // onto a branch level
    const branched = addBranch(rungs, { rung: 0, trail: [] }).rungs
    const onto = moveElement(branched, { rung: 0, trail: [2] }, { rung: 0, home: [0, 1], index: 0 })
    expect(text(onto)).toEqual(['[, |/Stop|] |Start| (Motor)'])
    expect(onto.sel).toEqual({ rung: 0, trail: [0, 1, 0] })
    // a branch cannot be dropped into itself
    expect(text(moveElement(branched, { rung: 0, trail: [0] }, { rung: 0, home: [0, 1], index: 0 }))).toEqual(['[, ] |Start| |/Stop| (Motor)'])
    // across rungs
    const two = addRung(rungs, 0).rungs
    expect(text(moveElement(two, { rung: 0, trail: [2] }, { rung: 1, home: [], index: 0 }))).toEqual(['|Start| |/Stop|', '(Motor)'])
  })

  it('an element picked with an element selected lands right after it', () => {
    let e = build()
    e = insertItem(e.rungs, { rung: 0, trail: [0] }, COIL)
    e = insertItem(e.rungs, { rung: 0, trail: [0] }, NC)
    expect(text(e)).toEqual(['|Start| |/?| (?)'])
    expect(e.sel).toEqual({ rung: 0, trail: [1] })
  })

  it('Branch inserts an empty branch: after the selected element, at the start of a selected rung', () => {
    const rungs = seriesRung()
    const after = addBranch(rungs, { rung: 0, trail: [0] })
    expect(text(after)).toEqual(['|Start| [, ] |/Stop| (Motor)'])
    expect(after.sel).toEqual({ rung: 0, trail: [1, 1] }) // its lower path, for the next element
    const start = addBranch(rungs, { rung: 0, trail: [] })
    expect(text(start)).toEqual(['[, ] |Start| |/Stop| (Motor)'])
    const nested = addBranch(start.rungs, { rung: 0, trail: [0, 1] })
    expect(text(nested)).toEqual(['[, [, ]] |Start| |/Stop| (Motor)'])
  })

  it('an empty branch, then a contact on its lower path, then its right end dragged over the start: a seal-in', () => {
    let e = addBranch(seriesRung(), { rung: 0, trail: [] })
    e = insertItem(e.rungs, e.sel!, NO)
    e = { rungs: setField(e.rungs, e.sel!, 0, 'Motor'), sel: e.sel }
    expect(text(e)).toEqual(['[, |Motor|] |Start| |/Stop| (Motor)'])
    e = resizeBranch(e.rungs, { rung: 0, trail: [0] }, 'right', 1)
    expect(text(e)).toEqual(['[|Start|, |Motor|] |/Stop| (Motor)'])
  })

  it('a branch end drags both ways, and back', () => {
    const e = addBranch(seriesRung(), { rung: 0, trail: [0] })
    const right2 = resizeBranch(e.rungs, { rung: 0, trail: [1] }, 'right', 2)
    expect(text(right2)).toEqual(['|Start| [|/Stop| (Motor), ]'])
    expect(text(resizeBranch(right2.rungs, { rung: 0, trail: [1] }, 'right', -1))).toEqual(['|Start| [|/Stop|, ] (Motor)'])
    const left = resizeBranch(e.rungs, { rung: 0, trail: [1] }, 'left', 1)
    expect(text(left)).toEqual(['[|Start|, ] |/Stop| (Motor)'])
    expect(left.sel).toEqual({ rung: 0, trail: [0] })
    expect(text(resizeBranch(left.rungs, left.sel!, 'left', -1))).toEqual(['|Start| [, ] |/Stop| (Motor)'])
    expect(text(resizeBranch(e.rungs, { rung: 0, trail: [1] }, 'right', 9))).toEqual(['|Start| [|/Stop| (Motor), ]'])
  })

  it('adds a level to the branch the selection is in, from the branch, a path, or an element on one', () => {
    const e = addBranch(build().rungs, { rung: 0, trail: [0] })
    expect(canAddPath(e.rungs, { rung: 0, trail: [] })).toBe(false)
    for (const trail of [[1], [1, 1], [1, 0]]) expect(text(addPath(e.rungs, { rung: 0, trail }))).toEqual(['|Start| [, , ]'])
  })

  it('a branch left with one path is not a branch: its elements rejoin the series', () => {
    let e = resizeBranch(addBranch(seriesRung(), { rung: 0, trail: [] }).rungs, { rung: 0, trail: [0] }, 'right', 1)
    e = removeSelected(e.rungs, { rung: 0, trail: [0, 1] })
    expect(text(e)).toEqual(['|Start| |/Stop| (Motor)'])
  })

  it('deletes an element inside a path, and a whole rung', () => {
    let e = resizeBranch(addBranch(build().rungs, { rung: 0, trail: [] }).rungs, { rung: 0, trail: [0] }, 'right', 1)
    expect(text(e)).toEqual(['[|Start|, ]'])
    e = removeSelected(e.rungs, { rung: 0, trail: [0, 0, 0] })
    expect(text(e)).toEqual(['[, ]'])
    expect(removeSelected(e.rungs, { rung: 0, trail: [] })).toEqual({ rungs: [], sel: null })
  })

  it('adds a rung below, and moves one - by a step, or to a place', () => {
    let e = addRung(build().rungs, 0)
    expect(e.sel).toEqual({ rung: 1, trail: [] })
    e = insertItem(e.rungs, e.sel!, SET)
    expect(text(moveRung(e.rungs, 1, -1))).toEqual(['(S ?)', '|Start|'])
    expect(text(moveRung(e.rungs, 0, -1))).toEqual(['|Start|', '(S ?)'])
    const three = insertItem(addRung(e.rungs, 1).rungs, { rung: 2, trail: [] }, COIL).rungs
    expect(text(moveRungTo(three, 0, 2))).toEqual(['(S ?)', '(?)', '|Start|'])
    expect(text(moveRungTo(three, 2, 0))).toEqual(['(?)', '|Start|', '(S ?)'])
  })

  it('never edits the rungs it was given', () => {
    const e = build()
    const before = JSON.stringify(e.rungs)
    insertItem(e.rungs, e.sel!, COIL)
    addBranch(e.rungs, e.sel!)
    removeSelected(e.rungs, e.sel!)
    expect(JSON.stringify(e.rungs)).toBe(before)
  })
})

describe("a box's fields", () => {
  it('are its instance name, then the value of each pin that has one; a bare pin is not a field', () => {
    const [r] = readLadder('VAR a : BOOL; T1 : TON; END_VAR\nLADDER\n  |a| T1(IN, PT := T#2s, ET => ?) (?);\nEND_LADDER')
    const box = r!.rungs[0]!.elements[1] as RungItem
    expect(fieldsOf(box)).toEqual(['T1', 'T#2s', '?'])
    const renamed = setField(r!.rungs, { rung: 0, trail: [1] }, 0, 'Delay')
    expect(text(setField(renamed, { rung: 0, trail: [1] }, 2, 'Elapsed'))).toEqual(['|a| Delay(IN, PT := T#2s, ET => Elapsed) (?)'])
  })
})

describe('copy and paste', () => {
  it('a run of elements pastes after the selection, rungs below the selected rung', () => {
    const rungs = seriesRung()
    const run = elementRange(rungs, { rung: 0, trail: [0] }, 2)
    expect(text([{ comment: '', elements: run }])).toEqual(['|Start| |/Stop|'])
    const pasted = insertElements(rungs, { rung: 0, trail: [1] }, run)
    expect(text(pasted)).toEqual(['|Start| |/Stop| |Start| |/Stop| (Motor)'])
    expect(pasted.sel).toEqual({ rung: 0, trail: [3] })
    expect(text(removeRange(rungs, { rung: 0, trail: [0] }, 2))).toEqual(['(Motor)'])
    const below = insertRungs(rungs, 0, [{ comment: 'pasted', elements: [SET] }])
    expect(text(below)).toEqual(['|Start| |/Stop| (Motor)', '(S ?)'])
    expect(below.sel).toEqual({ rung: 1, trail: [] })
  })
})

describe('Left / Right walk a routine element by element', () => {
  it('along a rung, through a branch level by level, and off its end onto the rung above or below', () => {
    const [routine] = readLadder('LADDER\n  |A| [|B| |/C|, |D|] (Q);\n  ;\n  |E| (R);\nEND_LADDER')
    const rungs = routine!.rungs
    const walk = (from: { rung: number; trail: number[] }, by: -1 | 1): string[] => {
      const out: string[] = []
      for (let at: { rung: number; trail: number[] } | null = from; at; at = stepInstruction(rungs, at, by)) out.push(`${at.rung}:${at.trail.join('.')}`)
      return out
    }
    // rung 0: A, then the branch's first level (B, C), then its second (D), then (Q); the empty rung 1 is a stop of
    // its own, so the rung being built is never skipped; then rung 2
    const forward = ['0:0', '0:1.0.0', '0:1.0.1', '0:1.1.0', '0:2', '1:', '2:0', '2:1']
    expect(walk({ rung: 0, trail: [0] }, 1)).toEqual(forward)
    expect(walk({ rung: 2, trail: [1] }, -1)).toEqual([...forward].reverse())
    expect(stepInstruction(rungs, { rung: 0, trail: [0] }, -1)).toBeNull()
    expect(stepInstruction(rungs, { rung: 2, trail: [1] }, 1)).toBeNull()
  })

  it('from a rung, a branch or a level, the keys enter at the near edge', () => {
    const rungs = readLadder('LADDER\n  |Z| (Y);\n  |A| [|B|, |D|] (Q);\nEND_LADDER')[0]!.rungs
    expect(stepInstruction(rungs, { rung: 1, trail: [] }, 1)).toEqual({ rung: 1, trail: [0] })
    expect(stepInstruction(rungs, { rung: 1, trail: [] }, -1)).toEqual({ rung: 0, trail: [1] })
    expect(stepInstruction(rungs, { rung: 1, trail: [1] }, 1)).toEqual({ rung: 1, trail: [1, 0, 0] })
    expect(stepInstruction(rungs, { rung: 1, trail: [1, 1] }, 1)).toEqual({ rung: 1, trail: [1, 1, 0] })
    expect(stepInstruction(rungs, { rung: 1, trail: [1] }, -1)).toEqual({ rung: 1, trail: [0] })
  })
})
