// Pointer drags in the ladder view (LadderView.tsx): a branch end pulled over its neighbours, an element moved to
// another place, a rung moved by its number. Each lands as one edit through the view's `commit`.

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { elementAt, moveElement, moveRungTo, resizeBranch, isBranch, type DropSlot } from '../../../plc/ladder/ladderEdit'
import type { LadderRoutine, Rung } from '../../../plc/ladder/ladderRungs'
import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Sel } from './ladderSel'
import { isEl } from './useLadderSheet'

/** What the drags need from the view. */
export interface LadderDragDeps {
  routines: readonly LadderRoutine[]
  canEdit: boolean
  rootRef: RefObject<HTMLDivElement | null>
  setSel: (s: Sel | null) => void
  commit: (routine: number, rungs: readonly Rung[], next: Sel | null) => void
  /** connect an open block pin (a double-click on it) */
  connect: (at: Sel, pin: string, out: boolean) => void
  startEdit: (at: Sel, field: number) => void
  startLiveEdit: (at: Sel, field: number, text: string) => void
}

export function useLadderDrags({ routines, canEdit, rootRef, setSel, commit, connect, startEdit, startLiveEdit }: LadderDragDeps) {
  // a branch end being dragged over its neighbours, and how far it has been pulled
  const [stretch, setStretch] = useState<{ branch: Sel; side: 'left' | 'right'; dx: number; by: number } | null>(null)
  const stretchRef = useRef<{ branch: Sel; side: 'left' | 'right'; startX: number; moved: boolean } | null>(null)
  // an element being dragged to a new place, and the slot it would drop into (drawn as a marker there)
  const [dragDrop, setDragDrop] = useState<{ from: Sel; slot: (DropSlot & { routine: number }) | null } | null>(null)
  const elDrag = useRef<{ from: Sel; startX: number; startY: number; moved: boolean } | null>(null)
  // a rung being dragged by its number: the slot between rungs where it would land
  const [rungDrop, setRungDrop] = useState<{ routine: number; slot: number } | null>(null)
  const rungDrag = useRef<{ routine: number; from: number; startY: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  // ---- dragging a branch end (extend / shorten its span) ---------------------------------------------------------

  const elementRect = (routine: number, rung: number, trail: number[]): DOMRect | null =>
    rootRef.current?.querySelector(`[data-trail="${routine}/${rung}/${trail.join('.')}"]`)?.getBoundingClientRect() ?? null

  /** How many neighbours a branch end dragged to `x` takes in (> 0) or gives back (< 0). */
  const stretchBy = (branch: Sel, side: 'left' | 'right', x: number): number => {
    const r = routines[branch.routine]
    const el = r && elementAt(r.rungs, branch)
    if (!isBranch(el)) return 0
    const home = branch.trail.slice(0, -1)
    const i = branch.trail[branch.trail.length - 1]!
    const mid = (rect: DOMRect): number => rect.left + rect.width / 2
    let by = 0
    if (side === 'right') {
      for (let k = 1; ; k++) {
        const rect = elementRect(branch.routine, branch.rung, [...home, i + k])
        if (!rect || x < mid(rect)) break
        by = k
      }
      if (by > 0) return by
      for (let j = el.paths[0]!.length - 1; j >= 0; j--) {
        const rect = elementRect(branch.routine, branch.rung, [...branch.trail, 0, j])
        if (!rect || x > mid(rect)) break
        by--
      }
      return by
    }
    for (let k = 1; k <= i; k++) {
      const rect = elementRect(branch.routine, branch.rung, [...home, i - k])
      if (!rect || x > mid(rect)) break
      by = k
    }
    if (by > 0) return by
    for (let j = 0; j < el.paths[0]!.length; j++) {
      const rect = elementRect(branch.routine, branch.rung, [...branch.trail, 0, j])
      if (!rect || x < mid(rect)) break
      by--
    }
    return by
  }

  const onNodeDown = (e: ReactPointerEvent<HTMLElement>, branch: Sel, side: 'left' | 'right'): void => {
    if (!canEdit) return
    e.stopPropagation()
    e.preventDefault()
    stretchRef.current = { branch, side, startX: e.clientX, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
    setSel(branch)
  }
  const onNodeMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = stretchRef.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return
    d.moved = true
    setStretch({ branch: d.branch, side: d.side, dx: e.clientX - d.startX, by: stretchBy(d.branch, d.side, e.clientX) })
  }
  const onNodeUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = stretchRef.current
    stretchRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setStretch(null)
    if (!d?.moved) return
    const by = stretchBy(d.branch, d.side, e.clientX)
    if (by === 0) return
    const r = routines[d.branch.routine]!
    const out = resizeBranch(r.rungs, d.branch, d.side, by)
    commit(d.branch.routine, out.rungs, out.sel ? { ...out.sel, routine: d.branch.routine } : null)
  }

  // ---- dragging an element to another place ----------------------------------------------------------------------

  /** The drop slot under (x, y): the series row there, and the index in it the pointer is nearest. */
  const dropSlotAt = (x: number, y: number): (DropSlot & { routine: number }) | null => {
    const under = (rootRef.current?.ownerDocument ?? document).elementsFromPoint(x, y)
    const row = under.find((el) => isEl(el) && el.dataset.series !== undefined) as HTMLElement | undefined
    const rungRow = under.find((el) => isEl(el) && el.dataset.rungOf !== undefined && el.dataset.rungIndex !== undefined) as HTMLElement | undefined
    const series = row?.dataset.series ?? (rungRow ? `${rungRow.dataset.rungOf}/${rungRow.dataset.rungIndex}/` : null)
    if (series === null) return null
    const [routine, rung, homeText] = series.split('/')
    const home = homeText === '' ? [] : homeText!.split('.').map(Number)
    const prefix = `${routine}/${rung}/${homeText === '' ? '' : `${homeText}.`}`
    // a long rung wraps, so "before" is not just "to the left": everything on a row above the pointer comes before it
    const cells: DOMRect[] = []
    for (const el of rootRef.current?.querySelectorAll<HTMLElement>('[data-trail]') ?? []) {
      const trail = el.dataset.trail!
      if (!trail.startsWith(prefix) || trail.slice(prefix.length).includes('.')) continue
      cells.push(el.getBoundingClientRect())
    }
    const rowTops = [...new Set(cells.map((r) => Math.round(r.top)))].sort((a, b) => a - b)
    const rowOf = (top: number): number => rowTops.findIndex((t) => Math.abs(t - Math.round(top)) <= 2)
    let at = 0
    rowTops.forEach((t, k) => {
      if (y >= t) at = k
    })
    const index = cells.filter((r) => rowOf(r.top) < at || (rowOf(r.top) === at && x > r.left + r.width / 2)).length
    return { routine: Number(routine), rung: Number(rung), home, index }
  }
  const onCellDown = (e: ReactPointerEvent<HTMLElement>, at: Sel): void => {
    if (!canEdit || e.button !== 0 || (isEl(e.target) && e.target.closest('input, .ld-node'))) return
    elDrag.current = { from: at, startX: e.clientX, startY: e.clientY, moved: false }
    // captured from the press, so a drag that leaves the cell in its first move is still followed; clicks then target
    // the cell, which is why its double-click hit-tests what is under the pointer
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  /** Double-click on a cell: the field under the pointer (a box's name or one of its values; a contact's variable). */
  const onCellDoubleClick = (e: { clientX: number; clientY: number; stopPropagation: () => void }, at: Sel): void => {
    e.stopPropagation()
    const hit = (rootRef.current?.ownerDocument ?? document).elementFromPoint(e.clientX, e.clientY)
    if (!isEl(hit) || hit.closest('input')) return
    // on a block pin nothing connects: connect it (the row says which, and which way)
    const open = hit.closest<HTMLElement>('[data-open]')
    if (open?.dataset.pin) return connect(at, open.dataset.pin, open.dataset.out === 'true')
    const row = hit.closest<HTMLElement>('[data-field]')
    // on a pin's live number, while the program runs: a value for the running program, not an edit of the rung
    const liveNumber = hit.closest<HTMLElement>('[data-live-text]')
    if (liveNumber && row) return startLiveEdit(at, Number(row.dataset.field), liveNumber.dataset.liveText ?? '')
    startEdit(at, row ? Number(row.dataset.field) : 0)
  }
  const onCellMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = elDrag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return
    d.moved = true
    setDragDrop({ from: d.from, slot: dropSlotAt(e.clientX, e.clientY) })
  }
  const onCellUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = elDrag.current
    elDrag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragDrop(null)
    if (!d?.moved) return
    suppressClick.current = true
    window.setTimeout(() => (suppressClick.current = false), 0)
    const slot = dropSlotAt(e.clientX, e.clientY)
    if (!slot || slot.routine !== d.from.routine) return
    const out = moveElement(routines[d.from.routine]!.rungs, d.from, slot)
    commit(d.from.routine, out.rungs, out.sel ? { ...out.sel, routine: d.from.routine } : null)
  }
  const dropMarker = (routine: number, rung: number, home: number[], i: number): ReactNode => {
    const s = dragDrop?.slot
    if (!s || s.routine !== routine || s.rung !== rung || s.index !== i || s.home.length !== home.length || !s.home.every((n, k) => n === home[k])) return null
    return <i key={`drop${i}`} className="ld-drop" data-testid="ld-drop" />
  }

  // ---- dragging a rung by its number -----------------------------------------------------------------------------

  const rungSlotAt = (routine: number, y: number): number => {
    const rows = rootRef.current?.querySelectorAll(`[data-rung-of="${routine}"]`)
    let slot = 0
    rows?.forEach((el, k) => {
      const r = el.getBoundingClientRect()
      if (y > r.top + r.height / 2) slot = k + 1
    })
    return slot
  }
  const onNumDown = (e: ReactPointerEvent<HTMLElement>, routine: number, from: number): void => {
    if (!canEdit) return
    rungDrag.current = { routine, from, startY: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onNumMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = rungDrag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientY - d.startY) < 5) return
    d.moved = true
    setRungDrop({ routine: d.routine, slot: rungSlotAt(d.routine, e.clientY) })
  }
  const onNumUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = rungDrag.current
    rungDrag.current = null
    setRungDrop(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d?.moved) return
    suppressClick.current = true
    window.setTimeout(() => (suppressClick.current = false), 0)
    const slot = rungSlotAt(d.routine, e.clientY)
    const to = slot > d.from ? slot - 1 : slot
    if (to === d.from) return
    const out = moveRungTo(routines[d.routine]!.rungs, d.from, to)
    commit(d.routine, out.rungs, out.sel ? { ...out.sel, routine: d.routine } : null)
  }
  return { stretch, dragDrop, rungDrop, suppressClick, dropMarker, onCellDoubleClick, onCellDown, onCellMove, onCellUp, onNodeDown, onNodeMove, onNodeUp, onNumDown, onNumMove, onNumUp }
}
