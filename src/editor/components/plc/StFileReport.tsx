// The outcome of an ST file crossing the import/export door, drawn as a CHECKLIST.
//
// WHY THIS IS NOT A TOAST. The importers (plc/exchange/importText.ts, plc/exchange/importXml.ts) do the expensive
// part already: every construct the subset cannot hold is named IN THE USER'S TERMS, with the
// thing to do about it ("bind the variable to a part's PLC tag and delete the AT clause"). Joined
// with a space into one sentence-soup line, that work reads as "it broke" - a wall of prose in
// warning-yellow that a reader skims and dismisses. The notes are already a punch list; the panel
// just has to draw them as one. Each note gets a row, a tick box, and a running count, so the
// question changes from "did something go wrong" to "which of these five have I dealt with".
//
// THE ITEMS ARE THE IMPORTER'S WORDS, UNEDITED. This layer splits a leading `subject:` off for
// emphasis and nothing more - head + detail always recombine to the original note. Rewriting a
// note here would put the wording in two places and let them drift; the importer is where a note
// gets better.

import { useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('stFileReport', {
  toCheck: {
    one: '{count} thing to check before you trust the simulation:',
    other: '{count} things to check before you trust the simulation:',
  },
  allChecked: 'All {total} checked.',
  someChecked: '{done} of {total} checked:',
  dismissLabel: 'Dismiss this report',
  dismiss: 'Dismiss',
  nothingDropped: 'Nothing was left out. The whole program came through.',
})

export type StReportTone = 'ok' | 'warn' | 'error'

/** What a file transfer produced: one headline, and the list of things it could not carry. */
export interface StFileReportData {
  /** distinguishes one report from the next so the tick state resets (used as a React key) */
  id: number
  /** what happened, in one line: `Imported cell.st`, `Could not import line.xml` */
  headline: string
  /** a consequence the reader did not ask for but must know - the adopted scan time */
  detail?: string
  /** one entry per thing to look at. Empty on a clean transfer. */
  items: string[]
  tone: StReportTone
  /** import reports outlive an edit (the reader is fixing the very things listed); an export
   *  report is a receipt for a file already downloaded, so the first keystroke makes it stale */
  keepOnEdit: boolean
  /** draw the items as a CHECKLIST, with tick boxes and a count: an import's notes are work left
   *  to do. Defaults to every tone but 'error'. A receipt for something already done (the tags a
   *  controller rename moved, and the parts it rewired) is a plain list - tick boxes there would
   *  promise work nobody has left, and cost a short dock a line for the count */
  checklist?: boolean
  /** a transfer that carried the whole program, which says so when it has nothing to list. Absent on every other
   *  report: a notice, or one controller's file, which leaves the rest out on purpose */
  whole?: boolean
}

const TONE: Record<StReportTone, { color: string; mark: string }> = {
  ok: { color: 'light-dark(#377c4c, #6fbf87)', mark: '✓' },
  warn: { color: 'var(--warn)', mark: '⚠' },
  error: { color: 'var(--danger)', mark: '⚠' },
}

const card = (color: string): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 8px',
  borderRadius: 4,
  borderLeft: `3px solid ${color}`,
  background: 'light-dark(#eeeff1, #26282c)',
})

const headRow: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 6 }
const headText: CSSProperties = { flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const dismiss: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'light-dark(#787c81, #7d8186)',
  cursor: 'pointer',
  padding: '0 2px',
  lineHeight: 1,
  fontSize: 13,
}
const summary: CSSProperties = { color: 'light-dark(#52575d, #9aa0a6)', fontSize: 12 }
const list: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  margin: 0,
  padding: 0,
  listStyle: 'none',
  // a vendor file can produce a dozen notes and this panel is often docked and short: the ROWS
  // scroll, so the headline stays put and the code editor above keeps its height. Kept to about
  // two wrapped rows - the card must not squeeze the code it is asking you to go and fix
  maxHeight: 104,
  overflowY: 'auto',
  scrollbarWidth: 'thin',
}
const itemRow = (done: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  color: done ? 'light-dark(#8d9197, #7d8186)' : 'light-dark(#212428, #d7d9dc)',
  textDecoration: done ? 'line-through' : 'none',
  cursor: 'pointer',
  lineHeight: 1.35,
})
const box: CSSProperties = { margin: '2px 0 0 0', accentColor: 'var(--warn)', flexShrink: 0, cursor: 'pointer' }
const bullet: CSSProperties = { color: 'light-dark(#8d9197, #6b6f75)', flexShrink: 0, width: 12, textAlign: 'center' }
const subject: CSSProperties = { color: 'var(--warn)', fontWeight: 600 }

/**
 * Split a leading `subject:` off a note so the row has something to scan by.
 *
 * The importers write most notes as `<what>: <what happened, and what to do>` - the address,
 * the keyword, the POU. Bounded and colon-anchored: a note that does not open that
 * way ("3 PROGRAMs were declared. …") keeps its full sentence rather than being cut at some
 * arbitrary clause, and nothing is ever dropped either way.
 */
function splitNote(note: string): { head: string | null; rest: string } {
  const m = /^([^:]{1,60}): (.*)$/s.exec(note)
  return m ? { head: m[1]!, rest: m[2]! } : { head: null, rest: note }
}

/** The count line: what is left to do, not what happened. */
function progressLine(total: number, done: number): string {
  if (total === 0) return ''
  if (done === 0) return t(M.toCheck, { count: total })
  if (done === total) return t(M.allChecked, { total })
  return t(M.someChecked, { done, total })
}

export function StFileReport({ report, onDismiss }: { report: StFileReportData; onDismiss: () => void }): ReactElement {
  // Which rows the reader has dealt with. Local and ephemeral: it is a working list
  // for the person who just opened the file, not part of the document - the parent keys this
  // component by report id, so the next import starts from a clean slate.
  const [done, setDone] = useState<ReadonlySet<number>>(() => new Set())
  const tone = TONE[report.tone]
  // A refused file has no program to work through, so its rows are what happened and what to try:
  // read once, not ticked off. Tick boxes there would promise a punch list that isn't one - as they
  // would on a receipt for work already done, which opts out (`checklist: false`).
  const tickable = report.checklist ?? report.tone !== 'error'
  const toggle = (i: number): void =>
    setDone((prev) => {
      const next = new Set(prev)
      if (!next.delete(i)) next.add(i)
      return next
    })

  return (
    <div style={card(tone.color)} data-testid="st-file-report">
      <div style={headRow}>
        <span style={{ ...headText, color: tone.color }} data-testid="st-file-report-headline">
          {tone.mark} {report.headline}
          {report.detail ? ` - ${report.detail}` : ''}
        </span>
        <button style={dismiss} onClick={onDismiss} aria-label={t(M.dismissLabel)} title={t(M.dismiss)}>
          <CloseIcon />
        </button>
      </div>
      {report.items.length === 0 ? (
        report.whole === true && <div style={summary}>{t(M.nothingDropped)}</div>
      ) : (
        <>
          {tickable && (
            <div style={summary} data-testid="st-file-report-progress">
              {progressLine(report.items.length, done.size)}
            </div>
          )}
          <ul style={list}>
            {report.items.map((note, i) => {
              const { head, rest } = splitNote(note)
              const ticked = tickable && done.has(i)
              const text = (
                <span>
                  {head && <span style={ticked ? undefined : subject}>{head}</span>}
                  {head ? ' - ' : ''}
                  {rest}
                </span>
              )
              return (
                <li key={`${i}:${note}`} data-testid="st-file-report-item">
                  {tickable ? (
                    <label style={itemRow(ticked)}>
                      <input type="checkbox" style={box} checked={ticked} onChange={() => toggle(i)} />
                      {text}
                    </label>
                  ) : (
                    <div style={{ ...itemRow(false), cursor: 'default' }}>
                      <span style={bullet}>•</span>
                      {text}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
