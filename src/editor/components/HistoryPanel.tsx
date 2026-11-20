import { useEffect, useRef } from 'react'
import type { EditorState, EditorStore } from '../store/store'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('history', {
  kindPart: 'part',
  emptyRoom: 'No edits yet. Changes anyone makes in this shared project appear here, newest last.',
  emptySolo: 'No edits yet. Changes you make appear here, newest last.',
  opened: 'Project opened',
  you: 'You',
  someone: 'Someone',
})

/**
 * The History dock: the edit feed (store.getEditHistory) as a list.
 *
 * Solo: rows up to the cursor are applied, rows past it have been undone and render greyed;
 * clicking a row jumps the scene to that point via repeated undo/redo - always equivalent to
 * what Ctrl+Z / Ctrl+Y would have done, just in one gesture.
 *
 * Room: the shared activity feed ("Alice moved a conveyor, 2 min ago") - attributed via each
 * event's actor, capped, and read-only. No jump (undo in a room is your own edits only, via
 * the Y.UndoManager) and no baseline row (old events fall off the rolling cap).
 */
export function HistoryPanel({ store, state }: { store: EditorStore; state: EditorState }) {
  const { events, cursor } = store.getEditHistory()
  const inRoom = state.collab
  const currentRef = useRef<HTMLButtonElement | null>(null)
  // keep the current/newest row visible as edits move it ('nearest' = no scroll when already visible)
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor, events.length])

  const fmt = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })

  // Row i = "the first i events are applied"; row 0 (solo only) is the state before the oldest
  // recorded edit, so clicking it undoes everything on the stack.
  const row = (i: number, label: string, time: number | null, kind: 'scene' | 'package' | 'program' | null, actor?: string) => {
    const current = i === cursor
    return (
      <button
        key={i}
        type="button"
        ref={current ? currentRef : undefined}
        className={`history-row${current ? ' current' : ''}${i > cursor ? ' undone' : ''}${inRoom ? ' static' : ''}`}
        onClick={() => {
          if (!inRoom && !current) store.jumpToHistory(i)
        }}
        title={time === null ? undefined : new Date(time).toLocaleString()}
      >
        {actor !== undefined && <span className="history-actor">{actor}</span>}
        <span className="history-label">{label}</span>
        {kind === 'package' && <span className="history-kind">{t(M.kindPart)}</span>}
        {/* i18n-ok: PLC is an acronym the app uses untranslated */}
        {kind === 'program' && <span className="history-kind">PLC</span>}
        {time !== null && <span className="history-time">{fmt(time)}</span>}
      </button>
    )
  }

  return (
    <div className="history-panel">
      {events.length === 0 ? (
        <div className="history-empty">
          {t(inRoom ? M.emptyRoom : M.emptySolo)}
        </div>
      ) : (
        <div className="history-list">
          {!inRoom && row(0, t(M.opened), null, null)}
          {events.map((e, idx) => row(idx + 1, e.label, e.time, e.kind, inRoom ? (e.mine ? t(M.you) : (e.actor ?? t(M.someone))) : undefined))}
        </div>
      )}
    </div>
  )
}
