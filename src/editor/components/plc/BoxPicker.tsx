// Insert Box: everything a ladder box can be - the program's own blocks and functions, then the standard library -
// found by typing and put on the rung with Enter. The element bar keeps the handful a rung is mostly made of; this is
// the door to the rest, so the bar never has to grow to be complete (ladderLeaf.tsx `LADDER.boxes`).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { BoxChoice } from './ladderLeaf'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('boxPicker', {
  shownOf: '{shown} of {total}',
  close: 'Close (Esc)',
  none: 'Nothing by that name.',
  groupSummary: '{group}: {summary}',
})

/** How well `c` matches `q` (upper case): lower is better, null is no match. A name that IS the query, then one that
 *  starts with it, then one that holds it, then a summary that does. */
function rank(c: BoxChoice, q: string): number | null {
  const name = c.name.toUpperCase()
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if (name.includes(q)) return 2
  if (c.summary.toUpperCase().includes(q) || c.group.toUpperCase().includes(q)) return 3
  return null
}

export function BoxPicker({ choices, prompt, onPick, onClose }: { choices: readonly BoxChoice[]; prompt: string; onPick: (key: string) => void; onClose: () => void }): ReactElement {
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => input.current?.focus(), [])

  // with nothing typed, the catalogue as it is grouped; typed, the best matches first (a stable sort keeps the groups'
  // order among equals, so the program's own still come before the library's)
  const shown = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (q === '') return choices
    const ranked = choices.flatMap((c) => {
      const r = rank(c, q)
      return r === null ? [] : [{ c, r }]
    })
    return ranked.sort((a, b) => a.r - b.r).map((x) => x.c)
  }, [choices, query])
  const current = shown[Math.min(at, shown.length - 1)]

  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [at, shown])

  const move = (by: number): void => setAt((i) => Math.max(0, Math.min(shown.length - 1, i + by)))

  return (
    <div
      className="ld-boxpick"
      data-testid="ladder-boxpick"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          move(e.key === 'ArrowDown' ? 1 : -1)
        } else if (e.key === 'PageDown' || e.key === 'PageUp') {
          e.preventDefault()
          move(e.key === 'PageDown' ? 10 : -10)
        } else if (e.key === 'Enter' && current) {
          e.preventDefault()
          onPick(current.key)
        }
      }}
    >
      <div className="ld-boxpick-head">
        <input
          ref={input}
          className="ld-find-input"
          data-testid="ladder-boxpick-query"
          placeholder={prompt}
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setAt(0)
          }}
        />
        <span className="ld-find-count">{query.trim() === '' ? `${choices.length}` : t(M.shownOf, { shown: shown.length, total: choices.length })}</span>
        <button className="ld-btn ld-find-close" data-testid="ladder-boxpick-close" title={t(M.close)} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="ld-boxpick-list" ref={list} role="listbox" aria-label={prompt}>
        {shown.length === 0 && <div className="ld-boxpick-none">{t(M.none)}</div>}
        {shown.map((c, i) => {
          const header = query.trim() === '' && (i === 0 || shown[i - 1]!.group !== c.group)
          return (
            <div key={c.key} style={{ display: 'contents' }}>
              {header && <div className="ld-boxpick-group">{c.group}</div>}
              <div
                role="option"
                aria-selected={c === current}
                className={`ld-boxpick-row${c === current ? ' on' : ''}`}
                data-testid={`ladder-boxpick-${c.name}`}
                title={`${c.summary}\n${c.name} ${c.signature}`}
                onMouseMove={() => i !== at && setAt(i)}
                onClick={() => onPick(c.key)}
              >
                <span className="ld-boxpick-name">{c.name}</span>
                <span className="ld-boxpick-sig">{c.signature}</span>
                <span className="ld-boxpick-sum">{query.trim() !== '' ? t(M.groupSummary, { group: c.group, summary: c.summary }) : c.summary}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
