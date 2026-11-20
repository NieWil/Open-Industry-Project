// Find and Replace for the ladder view (LadderView.tsx).

import type { LadderRoutine } from '../../../plc/ladder/ladderRungs'
import { findInLadder, replaceable, replaceFound, stepFound, type LdFound } from '../../../plc/ladder/ladderFind'
import { LADDER } from './ladderLeaf'
import { defineMessages, t } from '../../../core/i18n'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { FRONT } from './ladderSel'
import type { Sel } from './ladderSel'

const M = defineMessages('ladder', {
  notFound: 'Not found',
  noMoreBelow: 'No more matches below (Wrap is off)',
  noMoreAbove: 'No more matches above (Wrap is off)',
  fixTextFirst: 'This section has text to fix in the Text view first',
  functionName: "A function's name is changed by retyping the element, not replaced",
  nothingToReplace: 'Nothing to replace',
  replaced: { one: 'Replaced {count} place', other: 'Replaced {count} places' },
  replacedSkipped: { one: 'Replaced {count} place ({skipped} skipped)', other: 'Replaced {count} places ({skipped} skipped)' },
  matchOf: '{n} of {total}',
})

/** What the search needs from the view: the rungs, the selection, and the edit path. */
export interface LadderFindDeps {
  routines: readonly LadderRoutine[]
  active: Sel | null
  source: string
  onEdit: (next: string) => void
  locked: (r: LadderRoutine | undefined) => boolean
  setSel: (s: Sel | null) => void
  setFocus: (f: { key: string; field: number } | null) => void
  selKey: (s: Sel) => string
  rootRef: RefObject<HTMLDivElement | null>
}

export function useLadderFind({ routines, active, source, onEdit, locked, setSel, setFocus, selKey, rootRef }: LadderFindDeps) {
  // ---- Find and Replace (Ctrl+F / Ctrl+H): the shared rung core's search (plc/ladder/ladderFind.ts), through what the rungs
  //      say - every field, a function's name, the rung comments - in the section in hand or in all of them, wrapping
  //      or not. The match is selected, which brings it into view; a replace is an ordinary edit, one undo step.
  const [finding, setFinding] = useState<{ replace: boolean } | null>(null)
  const [findQuery, setFindQuery] = useState('')
  const [findWith, setFindWith] = useState('')
  const [findWrap, setFindWrap] = useState(true)
  const [findWhole, setFindWhole] = useState(false)
  const [findScope, setFindScope] = useState<'routine' | 'all'>('routine')
  // the match in hand. It is a place, and outlives a change of option (whole word, scope): the search goes on from it
  // whether or not it still matches. Only a new query starts over.
  const [findAt, setFindAt] = useState<LdFound | null>(null)
  const [findNote, setFindNote] = useState('')
  const findInput = useRef<HTMLInputElement>(null)
  const findOpts = { query: findQuery, whole: findWhole }
  // "the section in hand": the one the selection is in, else the match's, else the first
  const findRoutine = active?.routine ?? findAt?.routine ?? FRONT
  const found = useMemo(
    () => (finding ? findInLadder(routines, { query: findQuery, whole: findWhole }, findScope === 'all' ? 'all' : findRoutine, LADDER.leaves) : []),
    [finding !== null, routines, findQuery, findWhole, findScope, findRoutine],
  )
  /** Is this the match in hand? It is lit where it stands (`.found`) - the field, the function's name or the comment
   *  that holds the text - because selecting its element says which one, and a block has several fields. */
  const isFound = (at: { routine: number; rung: number; trail: readonly number[] }, field: number | 'comment'): boolean =>
    !!finding && !!findAt && findAt.routine === at.routine && findAt.rung === at.rung && findAt.field === field && findAt.trail.join('.') === at.trail.join('.')
  const samePlace = (a: LdFound, b: LdFound): boolean => a.routine === b.routine && a.rung === b.rung && a.field === b.field && a.trail.join('.') === b.trail.join('.')
  const foundIndex = findAt ? found.findIndex((f) => samePlace(f, findAt)) : -1
  const showFound = (f: LdFound): void => {
    const at: Sel = { routine: f.routine, rung: f.rung, trail: f.trail }
    setSel(at)
    if (typeof f.field === 'number' && f.field >= 0) setFocus({ key: selKey(at), field: f.field })
    setFindAt(f)
    setFindNote('')
  }
  const findStep = (by: 1 | -1, list: readonly LdFound[] = found): void => {
    if (findQuery === '') return
    // from the match in hand; else from what is selected, so a search starts where the author is looking
    const from = findAt ?? (active ? { routine: active.routine, rung: active.rung, trail: active.trail, field: -1 } : null)
    const next = stepFound(list, from, by, findWrap)
    if (next) showFound(next)
    else setFindNote(t(list.length === 0 ? M.notFound : by === 1 ? M.noMoreBelow : M.noMoreAbove))
  }
  // each open asks for the cursor in the Find box, taken in the commit that mounts the bar: a deferred focus (such as a
  // setTimeout) sends the keys typed straight after Ctrl+F to the sheet instead
  const [findFocus, setFindFocus] = useState(0)
  useLayoutEffect(() => {
    if (findFocus === 0) return
    // the text already there is selected, as every Find box does
    findInput.current?.focus()
    findInput.current?.select()
  }, [findFocus])
  const openFind = (replace: boolean): void => {
    setFinding({ replace })
    setFindNote('')
    setFindFocus((n) => n + 1)
  }
  const closeFind = (): void => {
    setFinding(null)
    setFindAt(null)
    setFindNote('')
    rootRef.current?.focus()
  }
  /** Replace through `targets`, skipping what cannot be (a function's name; a section whose text must be fixed first). */
  const replaceThese = (targets: readonly LdFound[]): number => {
    const can = targets.filter((f) => replaceable(f) && !locked(routines[f.routine]))
    if (can.length === 0) return 0
    let next = source
    for (const [routine, rungs] of replaceFound(routines, can, findOpts, findWith, LADDER.leaves)) next = LADDER.write(next, routine, rungs)
    if (next !== source) onEdit(next) // One edit, whatever it touched: one Ctrl+Z takes a Replace All back
    return can.length
  }
  // after a Replace the rungs are read again: the search moves on from where the replaced match stood
  const moveOn = useRef(false)
  useEffect(() => {
    if (!moveOn.current) return
    moveOn.current = false
    findStep(1)
  }, [found])
  const replaceOne = (): void => {
    const here = foundIndex >= 0 ? found[foundIndex]! : null
    if (!here) return findStep(1) // nothing in hand yet: Replace finds first
    if (replaceThese([here]) === 0) {
      setFindNote(t(replaceable(here) ? M.fixTextFirst : M.functionName))
      return
    }
    moveOn.current = true
  }
  const replaceAll = (): void => {
    const n = replaceThese(found)
    setFindAt(null)
    setFindNote(n === 0 ? t(M.nothingToReplace) : n < found.length ? t(M.replacedSkipped, { count: n, skipped: found.length - n }) : t(M.replaced, { count: n }))
  }
  /** the Find bar's count: a note, nothing before a query, else where the match in hand stands among the matches */
  const findCount = findNote !== '' ? findNote : findQuery === '' ? '' : found.length === 0 ? t(M.notFound) : t(M.matchOf, { n: foundIndex >= 0 ? foundIndex + 1 : '-', total: found.length })
  return { finding, setFinding, findQuery, setFindQuery, findWith, setFindWith, findWrap, setFindWrap, findWhole, setFindWhole, findScope, setFindScope, findAt, setFindAt, setFindNote, findInput, found, isFound, findStep, openFind, closeFind, replaceOne, replaceAll, findCount }
}
