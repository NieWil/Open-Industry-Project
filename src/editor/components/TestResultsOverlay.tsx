import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ProjectJSON } from '../../core/project/project'
import { runProjectTests } from '../project/projectTestsRun'
import type { ProjectTestRun } from '../project/projectTestsRun'
import type { TestFactsView } from '../project/testFacts'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('testResults', {
  couldNotRun: 'The tests could not run.',
  running: 'Running {n} of {total}…',
  allPassed: {
    one: 'All {count} test passed.',
    other: 'All {count} tests passed.',
  },
  someFailed: '{failed} of {count} tests failed.',
  title: 'Project tests',
  close: 'Close',
  factsTitle: 'What physically happened to the cargo during the run. Facts never fail a test.',
  flowFacts: 'Flow facts: {summary}',
  beforeFailureNone: 'Physical facts before the failure ({until}): none',
  beforeFailure: 'Physical facts before the failure ({until}): {count}',
  earlier: '... {count} earlier',
})

/**
 * The verdict surface for a project's own tests - what `npm run test-project` prints, in the app.
 *
 * It owns the run, not just the display, because the run is progressive: specs finish one at a time
 * and each should appear as it finishes rather than after the whole set. The project is handed in
 * already cloned (see App), so a mid-run edit can't change what is being graded.
 */
interface TestResultsOverlayProps {
  project: ProjectJSON
  onClose: () => void
}

export function TestResultsOverlay({ project, onClose }: TestResultsOverlayProps): ReactElement {
  const [runs, setRuns] = useState<ProjectTestRun[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const total = project.tests?.length ?? 0

  // Capture-phase Esc, like ShortcutsOverlay: the editor controller also listens for Escape, and the
  // dialog on top takes the key first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // One run per mount. The guard is a ref rather than a dep list because StrictMode double-invokes
  // effects in dev, and a second run here would step every scene's physics twice.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    let live = true
    runProjectTests(project, (run) => {
      if (live) setRuns((prev) => [...prev, run])
    })
      .then(() => live && setDone(true))
      .catch((e: unknown) => {
        if (!live) return
        setError(e instanceof Error ? e.message : String(e))
        setDone(true)
      })
    return () => {
      live = false
    }
  }, [project])

  const failed = runs.filter((r) => !r.ok).length
  const summary = error
    ? t(M.couldNotRun)
    : !done
      ? t(M.running, { n: runs.length + 1, total })
      : failed === 0
        ? t(M.allPassed, { count: runs.length })
        : t(M.someFailed, { failed, count: runs.length })

  return (
    <div className="author-backdrop" data-test-results-overlay onPointerDown={onClose}>
      <div className="author-dialog test-run-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p
          className="author-intro"
          data-test-run-summary
          data-state={!done ? 'running' : error !== null || failed > 0 ? 'fail' : 'pass'}
        >
          {summary}
        </p>
        {error !== null && <p className="test-run-error">{error}</p>}
        <div className="test-run-list">
          {runs.map((run, i) => (
            <section className="test-run-row" key={`${run.name}-${i}`} data-ok={run.ok}>
              <h3 className="test-run-name">
                <span className="test-run-mark" aria-hidden="true">
                  {run.ok ? '✓' : '✗'}
                </span>
                {run.name}
              </h3>
              {run.error !== undefined ? (
                <p className="test-run-error">{run.error}</p>
              ) : (
                <ul className="test-run-checks">
                  {run.result?.checks.map((c, ci) => (
                    <Fragment key={ci}>
                      <li className="test-run-check" data-ok={c.ok}>
                        <span className="test-run-mark" aria-hidden="true">
                          {c.ok ? '✓' : '✗'}
                        </span>
                        {c.detail}
                      </li>
                      {run.facts?.beforeFailure?.check === ci && <FactsBeforeFailure before={run.facts.beforeFailure} />}
                    </Fragment>
                  ))}
                </ul>
              )}
              {run.facts && (
                <p className="test-run-facts" data-test-run-facts={run.facts.total} title={t(M.factsTitle)}>
                  {t(M.flowFacts, { summary: run.facts.summary })}
                </p>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Under a failing test's earliest failing check: the flow facts up to it, as `npm run test-project` lists them. */
function FactsBeforeFailure({ before }: { before: NonNullable<TestFactsView['beforeFailure']> }): ReactElement {
  // i18n-ok: a time bound in the CLI's notation (t, s)
  const until = `t <= ${before.until.toFixed(3)} s`
  if (before.lines.length === 0) return <li className="test-run-facts-before">{t(M.beforeFailureNone, { until })}</li>
  return (
    <li className="test-run-facts-before">
      <details open>
        <summary>
          {t(M.beforeFailure, { until, count: before.lines.length + before.earlier })}
        </summary>
        {before.earlier > 0 && <div className="test-run-fact">{t(M.earlier, { count: before.earlier })}</div>}
        {before.lines.map((line, i) => (
          <div className="test-run-fact" key={i}>
            {line}
          </div>
        ))}
      </details>
    </li>
  )
}
