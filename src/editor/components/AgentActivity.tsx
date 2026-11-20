import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { EditorController } from '../controller'
import { dialogHost } from '../dialogHost'
import type { EditorState, EditorStore } from '../store/store'
import type { AgentSession } from '../agent/agentSession'
import { changeCount, reviewChanges, type AgentChanges, type PartChangeRow } from '../agent/agentReview'
import { trapTab, useModalKeys } from './inspector/menu'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('agentActivity', {
  revertConfirm: { one: "Undo the agent's edit?", other: "Undo the agent's {count} edits?" },
  busy: 'Agent: {tool}',
  made: { one: 'The agent made {count} edit', other: 'The agent made {count} edits' },
  review: 'Review',
  keepTitle: "Keep the agent's edits. They stay in History.",
  keep: 'Keep',
  revertTitle: "Undo all of the agent's edits",
  revert: 'Revert',
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  partDefinitions: 'Part definitions',
  tests: 'Tests',
  title: 'Agent edits',
  close: 'Close',
  intro: 'What changed since the agent started, {changes} in {steps}.',
  changes: { one: '{count} change', other: '{count} changes' },
  steps: { one: '{count} step', other: '{count} steps' },
  parts: 'Parts',
  selectAll: 'Select all',
  show: 'Show',
  plcProgram: 'PLC program',
  line: 'Line {line}',
  lines: 'Lines {from} to {to}',
  lineCounts: '{before} lines before, {after} now',
  scanOrTasks: 'Scan time or tasks',
  testsNote: 'Revert leaves the tests as they are: a kept test is not an undo step.',
  history: 'Steps in History',
  revertAll: 'Revert all',
})

/**
 * An agent at work in this editor (docs/agent-tools.md, "Working beside a person"). While a call runs, a chip says
 * which tool. After the agent's first edit it says how many steps it has made, with Review, Keep and Revert: Review
 * lists what changed against the document from before, and each part in it can be selected and framed. Keep closes
 * the question and leaves the steps in History. Revert undoes the whole run, offered only while nothing of the
 * person's sits among those steps. Desktop only (App mounts it when an agent can connect).
 */
export function AgentActivity({ session, store, state, controller }: { session: AgentSession; store: EditorStore; state: EditorState; controller: EditorController | null }) {
  const activity = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [reviewing, setReviewing] = useState(false)
  // `state` is in the deps so the run is re-read after any edit or undo; the call is a slice of a memoised list
  const steps = useMemo(() => session.pending(), [session, activity, state])
  const blocker = session.revertBlocker()
  if (!activity.busy && steps.length === 0) return null
  // the run can hold the person's own steps too (they are why Revert is withheld); the chip counts the agent's
  const agentSteps = steps.length - session.userStepsInRun().length
  const revert = (): void => {
    if (window.confirm(t(M.revertConfirm, { count: agentSteps }))) {
      session.revert()
      setReviewing(false)
    }
  }
  return (
    <>
      <div className="agent-activity" role="status" data-testid="agent-activity">
        {activity.busy && (
          <span className="agent-activity-busy" data-testid="agent-activity-busy">
            <span className="agent-activity-dot" aria-hidden="true" />
            {t(M.busy, { tool: activity.busy.replace(/_/g, ' ') })}
          </span>
        )}
        {steps.length > 0 && (
          <>
            <span className="agent-activity-text" data-testid="agent-activity-steps">
              {t(M.made, { count: agentSteps })}
            </span>
            <button type="button" data-testid="agent-review" onClick={() => setReviewing(true)}>
              {t(M.review)}
            </button>
            <button type="button" data-testid="agent-keep" title={t(M.keepTitle)} onClick={() => session.keep()}>
              {t(M.keep)}
            </button>
            <button type="button" data-testid="agent-revert" disabled={blocker !== null} title={blocker ?? t(M.revertTitle)} onClick={revert}>
              {t(M.revert)}
            </button>
          </>
        )}
      </div>
      {reviewing && steps.length > 0 && (
        <AgentReview
          session={session}
          store={store}
          state={state}
          controller={controller}
          steps={steps.map((e) => e.label)}
          blocker={blocker}
          onRevert={revert}
          onClose={() => setReviewing(false)}
        />
      )}
    </>
  )
}

/** message ids, resolved where a row renders */
const CHANGE_WORD: Record<PartChangeRow['change'], string> = { added: M.added, removed: M.removed, changed: M.changed }

function AgentReview({
  session,
  store,
  state,
  controller,
  steps,
  blocker,
  onRevert,
  onClose,
}: {
  session: AgentSession
  store: EditorStore
  state: EditorState
  controller: EditorController | null
  steps: string[]
  blocker: string | null
  onRevert: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const baseline = session.getSnapshot().baseline
  const changes = useMemo<AgentChanges | null>(
    () => (baseline ? reviewChanges(baseline, store) : null),
    [baseline, store, state.scene, state.stProgram, state.stScanMs, state.controller, state.userPackages, state.bundledPackages, state.testCount],
  )
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  if (!changes) return null
  const show = (ids: string[]): void => {
    store.selectMany(ids)
    controller?.view?.focusOn(ids)
  }
  const showLine = (line: number): void => {
    const text = store.getState().stProgram
    let offset = 0
    for (let i = 1; i < line && offset >= 0; i++) offset = text.indexOf('\n', offset) + 1
    store.revealPanel('st')
    store.revealStOffset(Math.max(0, offset))
  }
  const placed = changes.parts.filter((p) => p.change !== 'removed').map((p) => p.id)
  const lists: [string, AgentChanges['library']][] = [
    [M.partDefinitions, changes.library],
    [M.tests, changes.tests],
  ]
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog agent-review-dialog"
        role="dialog"
        aria-label={t(M.title)}
        data-testid="agent-review-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">
          {t(M.intro, { changes: t(M.changes, { count: changeCount(changes) }), steps: t(M.steps, { count: steps.length }) })}
        </p>
        {changes.parts.length > 0 && (
          <section>
            <h3 className="agent-review-heading">
              {t(M.parts)}
              {placed.length > 1 && (
                <button type="button" className="agent-review-show" data-testid="agent-review-show-all" onClick={() => show(placed)}>
                  {t(M.selectAll)}
                </button>
              )}
            </h3>
            <ul className="agent-review-list">
              {changes.parts.map((p) => (
                <li key={p.id} data-testid="agent-review-part" data-part-id={p.id} data-change={p.change}>
                  <span className={`agent-review-change agent-review-${p.change}`}>{t(CHANGE_WORD[p.change])}</span>
                  <span className="agent-review-name">
                    {p.label}
                    {p.fields && <span className="agent-review-fields">{p.fields.join(', ')}</span>}
                  </span>
                  {p.change !== 'removed' && (
                    <button type="button" className="agent-review-show" onClick={() => show([p.id])}>
                      {t(M.show)}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {(changes.program || changes.tasks) && (
          <section>
            <h3 className="agent-review-heading">{t(M.plcProgram)}</h3>
            <ul className="agent-review-list">
              {changes.program && (
                <li data-testid="agent-review-program">
                  <span className="agent-review-change agent-review-changed">{t(M.changed)}</span>
                  <span className="agent-review-name">
                    {changes.program.fromLine === changes.program.toLine
                      ? t(M.line, { line: changes.program.fromLine })
                      : t(M.lines, { from: changes.program.fromLine, to: changes.program.toLine })}
                    <span className="agent-review-fields">
                      {t(M.lineCounts, { before: changes.program.linesBefore, after: changes.program.linesAfter })}
                    </span>
                  </span>
                  <button type="button" className="agent-review-show" onClick={() => showLine(changes.program!.fromLine)}>
                    {t(M.show)}
                  </button>
                </li>
              )}
              {changes.tasks && (
                <li>
                  <span className="agent-review-change agent-review-changed">{t(M.changed)}</span>
                  <span className="agent-review-name">{t(M.scanOrTasks)}</span>
                </li>
              )}
            </ul>
          </section>
        )}
        {lists.map(([title, l]) =>
          l.added.length + l.removed.length + l.changed.length === 0 ? null : (
            <section key={title}>
              <h3 className="agent-review-heading">{t(title)}</h3>
              <ul className="agent-review-list">
                {(['added', 'changed', 'removed'] as const).flatMap((kind) =>
                  l[kind].map((name) => (
                    <li key={`${kind}:${name}`}>
                      <span className={`agent-review-change agent-review-${kind}`}>{t(CHANGE_WORD[kind])}</span>
                      <span className="agent-review-name">{name}</span>
                    </li>
                  )),
                )}
              </ul>
            </section>
          ),
        )}
        {changes.tests.added.length + changes.tests.removed.length + changes.tests.changed.length > 0 && (
          <p className="agent-review-note">{t(M.testsNote)}</p>
        )}
        <details className="agent-review-steps">
          <summary>{t(M.history)}</summary>
          <ol>
            {steps.map((label, i) => (
              <li key={i}>{label}</li>
            ))}
          </ol>
        </details>
        {blocker && <p className="agent-review-note">{blocker}</p>}
        <div className="export-dialog-actions">
          <button onClick={onClose}>{t(M.close)}</button>
          <button data-testid="agent-review-revert" disabled={blocker !== null} onClick={onRevert}>
            {t(M.revertAll)}
          </button>
          <button
            data-testid="agent-review-keep"
            onClick={() => {
              session.keep()
              onClose()
            }}
          >
            {t(M.keep)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
