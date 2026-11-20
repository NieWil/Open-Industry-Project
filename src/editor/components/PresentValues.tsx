// The PLC values a display lists beside the scene (SceneJSON.display; components/PresentOverlay.tsx). Whoever stands at
// the screen can move it out of the way and find what they need: fold it to its header, drag it to another corner,
// scroll a long list, and filter it by name. None of that is saved: it is this screen's view of the list.
//
// A locked display (a display link) is a screen others watch, so after half a minute nobody touched it the list comes
// back as it was: open, in its corner, unfiltered, at the top. While nobody touches it a list longer than fits moves on
// a page every few seconds, so every value is shown in turn. A value that just changed is marked for a moment.
//
// In one's own Present an editor chooses the list here, where it shows (program/displayValues.ts): Edit opens it, a
// cross takes a value off, a row dragged by its handle moves, and Add a value searches what the project can show. A
// display link never edits.

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { TagValue } from '../../plc'
import { resolveWatch } from '../program/plcWatchList'
import { formatPlcValue } from '../program/plcValueText'
import { defineMessages, t } from '../../core/i18n'
import { MAX_DISPLAY_VALUES } from '../../core/scene/sceneDisplay'

const M = defineMessages('presentValues', {
  title: { one: 'PLC value', other: 'PLC values · {count}' },
  titleNone: 'PLC values',
  collapse: 'Fold the list away',
  expand: 'Show the list',
  filter: 'Find a value',
  noMatch: 'No value matches',
  dragTitle: 'Drag to move the list to another corner',
  edit: 'Edit',
  editTitle: 'Choose the values every display of this project lists',
  done: 'Done',
  start: '＋ Add PLC values',
  startTitle: 'List live PLC values beside the scene on every display of this project',
  remove: 'Take {name} off the displays',
  moveTitle: 'Drag to change where {name} sits in the list',
  addLabel: 'Add a value',
  addPlaceholder: 'Search the project',
  addAll: { one: 'Add {count}', other: 'Add all {count}' },
  nothingToAdd: 'Nothing more to add',
  full: 'A display lists at most {count} values. Take one off to add another.',
  noValues: 'Values show here while the project runs.',
})

/** a value the project can show, offered by the editing panel's search */
export interface DisplayCandidate {
  name: string
  type?: string
  /** where it comes from: the part wired to it, the program, or the PLC's link */
  from: string
}

/** most search results listed at once */
const MAX_RESULTS = 40

type Corner = 'tr' | 'tl' | 'br' | 'bl'

/** a list this long gets a filter: below it, finding a name by eye is quicker than typing */
const FILTER_FROM = 9
/** a locked display untouched this long shows the list as it was (PresentOverlay's camera waits as long) */
const RESET_IDLE_MS = 30_000
/** untouched this long, a list longer than fits starts moving on a page at a time, every PAGE_MS */
const PAGE_IDLE_MS = 8_000
const PAGE_MS = 5_000
/** how long a value that just changed stays marked */
const FLASH_MS = 700

interface PresentValuesProps {
  names: readonly string[]
  image: Readonly<Record<string, TagValue>> | null
  typeOf: (name: string, key: string | null) => string | undefined
  /** a display link's: it resets itself, and pages through a long list on its own */
  locked: boolean
  /** an editor in their own Present: the list can be opened for editing */
  editable: boolean
  editing: boolean
  onEditing: (editing: boolean) => void
  /** what the search offers while editing */
  candidates: () => readonly DisplayCandidate[]
  onRemove: (name: string) => void
  onAdd: (names: readonly string[]) => void
  onMove: (from: number, to: number) => void
}

export function PresentValues({ names, image, typeOf, locked, editable, editing, onEditing, candidates, onRemove, onAdd, onMove }: PresentValuesProps): ReactElement {
  const [search, setSearch] = useState('')
  // a row moved by its handle: where it was, and the row it would land on. Pointer events, not the browser's drag and
  // drop, which a touch screen does not start
  const [moving, setMoving] = useState<{ from: number; over: number } | null>(null)
  const [open, setOpen] = useState(true)
  const [corner, setCorner] = useState<Corner>('tr')
  const [filter, setFilter] = useState('')
  // where the panel is while it is dragged (px from the overlay's top left); null when it sits in its corner
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDListElement>(null)
  const touched = useRef(Date.now())
  const touch = (): void => {
    touched.current = Date.now()
  }

  // anyone using the screen counts as touching it, the scene included
  useEffect(() => {
    const evs = ['pointerdown', 'pointermove', 'wheel', 'touchstart', 'keydown'] as const
    for (const ev of evs) window.addEventListener(ev, touch, { passive: true })
    return () => {
      for (const ev of evs) window.removeEventListener(ev, touch)
    }
  }, [])

  // a locked display: back as it was after half a minute untouched, and a long list paged through meanwhile
  useEffect(() => {
    if (!locked) return
    let lastPage = 0
    const id = setInterval(() => {
      const idle = Date.now() - touched.current
      if (idle >= RESET_IDLE_MS) {
        setOpen(true)
        setCorner('tr')
        setFilter('')
      }
      const el = list.current
      if (!el || idle < PAGE_IDLE_MS || el.scrollHeight <= el.clientHeight + 1 || Date.now() - lastPage < PAGE_MS) return
      lastPage = Date.now()
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      el.scrollTo({ top: atEnd ? 0 : el.scrollTop + el.clientHeight - 24, behavior: 'smooth' })
    }, 1000)
    return () => clearInterval(id)
  }, [locked])

  // when each value last changed, for the mark a change leaves
  const seen = useRef(new Map<string, TagValue>())
  const changedAt = useRef(new Map<string, number>())
  const now = performance.now()

  // drag the header: the panel follows the pointer, and lands in the nearest corner
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as Element).closest('button, input')) return
    const el = panel.current
    const host = el?.offsetParent as HTMLElement | null
    if (!el || !host) return
    const box = el.getBoundingClientRect()
    const hostBox = host.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ x: box.left - hostBox.left, y: box.top - hostBox.top, dx: e.clientX - box.left, dy: e.clientY - box.top })
  }
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const host = panel.current?.offsetParent as HTMLElement | null
    if (!drag || !host) return
    const hostBox = host.getBoundingClientRect()
    setDrag({ ...drag, x: e.clientX - hostBox.left - drag.dx, y: e.clientY - hostBox.top - drag.dy })
  }
  const endDrag = (): void => {
    const el = panel.current
    const host = el?.offsetParent as HTMLElement | null
    if (!drag || !el || !host) return setDrag(null)
    const cx = drag.x + el.offsetWidth / 2
    const cy = drag.y + el.offsetHeight / 2
    setCorner(`${cy < host.clientHeight / 2 ? 't' : 'b'}${cx < host.clientWidth / 2 ? 'l' : 'r'}` as Corner)
    setDrag(null)
  }

  const needle = filter.trim().toUpperCase()
  // editing lists every value: a row's place is its place in the whole list
  const shown = needle === '' || editing ? names : names.filter((n) => n.toUpperCase().includes(needle))
  const noValues = names.length > 0 && !names.some((n) => image && resolveWatch(n, image)?.value !== undefined)
  const moveOver = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!moving) return
    const row = e.currentTarget.ownerDocument.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-at]')
    const over = row ? Number(row.dataset.at) : moving.over
    if (over !== moving.over) setMoving({ ...moving, over })
  }
  const endMove = (): void => {
    if (moving && moving.over !== moving.from) onMove(moving.from, moving.over)
    setMoving(null)
  }
  return (
    <div
      ref={panel}
      className={`present-values${drag ? ' dragging' : ` corner-${corner}`}${open ? '' : ' folded'}`}
      data-testid="present-values"
      data-corner={drag ? undefined : corner}
      style={drag ? { left: drag.x, top: drag.y } : undefined}
    >
      <div className="present-values-head" title={t(M.dragTitle)} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <span className="present-values-title">{names.length === 0 ? t(M.titleNone) : t(M.title, { count: names.length })}</span>
        {open && !editing && names.length >= FILTER_FROM && (
          <input
            className="present-values-filter"
            data-testid="present-values-filter"
            type="search"
            placeholder={t(M.filter)}
            aria-label={t(M.filter)}
            spellCheck={false}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears the filter, and goes no further: on the owner's own screen it would leave Present
              if (e.key === 'Escape') {
                e.stopPropagation()
                setFilter('')
              }
            }}
          />
        )}
        {editable && (names.length > 0 || editing) && (
          <button type="button" className="present-values-edit" data-testid="present-values-edit" title={t(M.editTitle)} onClick={() => onEditing(!editing)}>
            {t(editing ? M.done : M.edit)}
          </button>
        )}
        <button type="button" className="present-values-fold" data-testid="present-values-fold" aria-expanded={open} aria-label={t(open ? M.collapse : M.expand)} title={t(open ? M.collapse : M.expand)} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <dl ref={list} className="present-values-list">
          {shown.map((n, at) => {
            const row = image ? resolveWatch(n, image) : null
            const v = row?.value
            const type = typeOf(n, row?.key ?? null)
            if (v !== undefined) {
              const before = seen.current.get(n)
              if (before !== undefined && before !== v) changedAt.current.set(n, now)
              seen.current.set(n, v)
            }
            const flash = now - (changedAt.current.get(n) ?? -Infinity) < FLASH_MS
            return (
              <div
                key={n}
                className={`present-value${flash ? ' flash' : ''}${editing ? ' editing' : ''}${moving?.from === at ? ' moving' : ''}${moving && moving.over === at && moving.from !== at ? (moving.from < at ? ' drop-after' : ' drop-before') : ''}`}
                data-testid="present-value"
                data-name={n}
                data-at={editing ? at : undefined}
              >
                <dt>
                  {editing && (
                    <span
                      className="present-value-handle"
                      data-testid="present-value-handle"
                      aria-hidden="true"
                      title={t(M.moveTitle, { name: n })}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return
                        e.preventDefault()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        setMoving({ from: at, over: at })
                      }}
                      onPointerMove={moveOver}
                      onPointerUp={endMove}
                      onPointerCancel={() => setMoving(null)}
                    >
                      ⠿
                    </span>
                  )}
                  {n}
                  {type && <span className="present-type" data-testid="present-type">{type}</span>}
                </dt>
                <dd className={typeof v === 'boolean' ? (v ? 'on' : 'off') : undefined}>{v === undefined ? '–' : formatPlcValue(v, type, 24)}</dd>
                {editing && (
                  <button type="button" className="present-value-remove" data-testid="present-value-remove" aria-label={t(M.remove, { name: n })} title={t(M.remove, { name: n })} onClick={() => onRemove(n)}>
                    ✕
                  </button>
                )}
              </div>
            )
          })}
          {shown.length === 0 && names.length > 0 && <div className="present-values-none">{t(M.noMatch)}</div>}
          {noValues && (
            <div className="present-values-none" data-testid="present-values-waiting">
              {t(M.noValues)}
            </div>
          )}
        </dl>
      )}
      {open && editing && <AddValues names={names} search={search} setSearch={setSearch} candidates={candidates} onAdd={onAdd} />}
      {editable && !editing && names.length === 0 && (
        <button type="button" className="present-values-start" data-testid="present-values-start" title={t(M.startTitle)} onClick={() => onEditing(true)}>
          {t(M.start)}
        </button>
      )}
    </div>
  )
}

/** The editing panel's Add a value: a search over what the project can show, and what it finds, to add one or all. */
function AddValues(props: { names: readonly string[]; search: string; setSearch: (s: string) => void; candidates: () => readonly DisplayCandidate[]; onAdd: (names: readonly string[]) => void }): ReactElement {
  const { names, search, setSearch, candidates, onAdd } = props
  const needle = search.trim().toUpperCase()
  const room = MAX_DISPLAY_VALUES - names.length
  if (room <= 0) return <div className="present-values-add present-values-none" data-testid="present-values-add">{t(M.full, { count: MAX_DISPLAY_VALUES })}</div>
  const found = candidates().filter((c) => !names.includes(c.name) && (needle === '' || c.name.toUpperCase().includes(needle) || c.from.toUpperCase().includes(needle)))
  return (
    <div className="present-values-add" data-testid="present-values-add">
      <input
        className="present-values-search"
        data-testid="present-values-search"
        type="search"
        aria-label={t(M.addLabel)}
        placeholder={t(M.addPlaceholder)}
        spellCheck={false}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            setSearch('')
          }
        }}
      />
      <ul className="present-values-results">
        {found.slice(0, MAX_RESULTS).map((c) => (
          <li key={c.name}>
            <button type="button" className="present-values-result" data-testid="present-values-result" data-name={c.name} onClick={() => onAdd([c.name])}>
              <span className="present-values-result-name">{c.name}</span>
              {c.type && <span className="present-type">{c.type}</span>}
              {c.from !== c.name && <span className="present-values-result-from">{c.from}</span>}
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="present-values-none">{t(M.nothingToAdd)}</li>}
      </ul>
      {/* only when all of them fit: an Add all that adds some of them would say what it doesn't do */}
      {found.length > 1 && found.length <= room && (
        <button type="button" className="present-values-edit" data-testid="present-values-add-all" onClick={() => onAdd(found.map((c) => c.name))}>
          {t(M.addAll, { count: found.length })}
        </button>
      )}
    </div>
  )
}
