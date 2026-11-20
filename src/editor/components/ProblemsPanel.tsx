/**
 * The Problems dock: one list answering "is this twin correct", over every check the app runs
 * (see editor/problems.ts for the aggregation).
 *
 * Three decisions:
 *
 * 1. **Warnings are hidden by default.** `undriven`/`unread` are legal mid-authoring - a tag the
 *    program has not declared yet is a forward reference - and a panel that shows twenty of those
 *    while you are still placing parts is a panel people turn off. Errors are always shown; the
 *    warning count stays visible on the toggle so nothing is secretly suppressed.
 * 2. **A row is a navigation**, not a report. A wiring or part row selects the parts it names and
 *    frames them; a program row jumps the ST editor to the offending offset, revealing the PLC
 *    panel first (a docked panel behind another tab is unmounted and would swallow the request);
 *    a controller-table row, which has no line to jump to, opens the organizer's tasks it is fixed in.
 * 3. **Coverage notes sit at the bottom, always.** They say what could not be checked; without
 *    them an empty list would claim a clean bill of health it cannot give.
 *
 * Recomputed from the store snapshot + the runtime diagnostics revision, both of which are already
 * change-notified, so there is no polling. The one timer: the program text is read once typing pauses
 * (PROGRAM_CHECK_DELAY_MS), because every recompute compiles the whole program and re-walks the scene.
 * Measured on the demo, that was ~7 ms of main-thread work per keystroke and frames near 100 ms
 * (e2e/perf-input-latency.mjs).
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HeldPackage } from '../../collab/codeTrust'
import { getRoomCodeGate } from '../../collab/session'
import { allPartDiagnostics, partDiagnosticsOverflowed, partDiagnosticsRev, subscribePartDiagnostics } from '../../core/parts/partDiagnostics'
import type { EditorController } from '../controller'
import type { EditorState, EditorStore } from '../store/store'
import { collectProblems, factsAskOf, type Problem, type ProblemsInput, type ProblemsReport } from '../problems'
import { factsFor } from '../program/programWorkerClient'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('problems', {
  goToLine: 'Go to the line',
  showTasks: 'Show the tasks in the PLC organizer',
  selectInScene: 'Select in the scene',
  errors: { one: '{count} error', other: '{count} errors' },
  warnings: { one: '{count} warning', other: '{count} warnings' },
  hideWarnings: 'Hide warnings',
  showWarnings: 'Show warnings',
  none: 'No problems found.',
  warningsHidden: { one: 'No errors. {count} warning hidden.', other: 'No errors. {count} warnings hidden.' },
  repeated: { one: 'repeated {count} time', other: 'repeated {count} times' },
  checking: 'Checking the program...',
})

interface ProblemsPanelProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
}

/** `subscribePartDiagnostics` hands the event to its listener; useSyncExternalStore wants a bare callback. */
function subscribeDiagnostics(cb: () => void): () => void {
  return subscribePartDiagnostics(() => cb())
}

/** How long the program checks wait after the last change to the text: the editor's own lint delay (stLang.ts). */
const PROGRAM_CHECK_DELAY_MS = 250

/** `value` once it has held still for `ms`; the first value is taken at once. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (Object.is(value, settled)) return
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, settled, ms])
  return settled
}

const NONE_HELD: readonly HeldPackage[] = []
const noSubscribe = (): (() => void) => () => {}
const noneHeld = (): readonly HeldPackage[] => NONE_HELD

/** What clicking a row does, for its tooltip; null when it has nowhere to go. */
function rowAction(p: Problem): string | null {
  if (p.offset !== undefined) return t(M.goToLine)
  if (p.panel !== undefined) return t(M.showTasks)
  return p.parts.length > 0 ? t(M.selectInScene) : null
}

export function ProblemsPanel({ store, state, controller }: ProblemsPanelProps) {
  // count bumps on a repeating diagnostic are silent by design (partDiagnostics.ts), so this
  // re-renders when a NEW unique problem appears - not 60x/s while one keeps throwing. The
  // revision doubles as the memo's dependency for the runtime half, which is a mutable module
  // store with no snapshot identity of its own.
  const diagnosticsRev = useSyncExternalStore(subscribeDiagnostics, partDiagnosticsRev)
  // in the store, so the PLC panel's "Show in Problems" can turn warnings on for a dock that is not mounted yet
  const showWarnings = state.problemsShowWarnings
  // the program as the checks see it: everything below reads this, not state.stProgram, so the rows,
  // their offsets and the fault match all describe one text
  const program = useSettled(state.stProgram, PROGRAM_CHECK_DELAY_MS)
  // a collab room's part code this browser has not allowed: runtime rows then describe a stand-in (collab/codeTrust.ts)
  const gate = getRoomCodeGate()
  const held = useSyncExternalStore(gate?.subscribe ?? noSubscribe, gate?.getHeld ?? noneHeld)
  // the program's last runtime fault, kept past Stop by the controller; shown only while the program still reads as it
  // did when it faulted, since an edit may have fixed it and would move the line it names
  const subscribeProgram = useCallback((cb: () => void) => controller?.onProgramStatus(cb) ?? (() => {}), [controller])
  const fault = useSyncExternalStore(subscribeProgram, () => controller?.plcFault ?? null)
  const plcFault = fault && fault.source === program ? fault : null
  // Play hands the logic to an external PLC only where one can be served (the desktop app), and only when it is on
  const externalPlc = (controller?.externalPlcAvailable ?? false) && state.externalPlc.enabled
  // the named controllers this computer connects, where it can connect any
  const namedPlcs = state.externalPlc.controllers
  // a tag only a kept test reads or drives is covered, as check-wiring counts it. A save or delete sets testCount, so
  // this render reads the new array
  const tests = store.projectTests()

  // Everything the checks read but the program's own table, which the worker hands back with the facts.
  const input = useMemo(
    () =>
      ({
        parts: state.scene.parts,
        stProgram: program,
        // a program written for a dialect this build does not have is one row, and none of the IEC checks
        stDialect: state.stDialect,
        runtime: allPartDiagnostics(),
        buildErrors: state.packageBuildErrors,
        packageNames: Object.fromEntries([...state.userPackages, ...state.bundledPackages].map((p) => [p.id, p.name])),
        stepHz: state.simHz,
        runtimeOverflowed: partDiagnosticsOverflowed(),
        heldCode: held.length,
        externalPlc,
        namedPlcs,
        mainPlcName: state.externalPlc.mainName,
        plcFault,
        tests,
      }) satisfies Omit<ProblemsInput, 'controller'>,
    [state.scene, program, state.stDialect, state.packageBuildErrors, state.userPackages, state.bundledPackages, state.simHz, diagnosticsRev, held, externalPlc, namedPlcs, state.externalPlc.mainName, plcFault, tests],
  )
  // What the program says is worked out in a worker (program/programWorkerClient.ts): checking and compiling it reads
  // all of it, and this runs at every pause in typing and every scene edit. The last report stays up until the next
  // one is ready, so the rows do not blink while someone types.
  const [report, setReport] = useState<ProblemsReport | null>(null)
  useEffect(() => {
    let live = true
    const ask = factsAskOf({ ...input, controller: state.controller, scanMs: state.stScanMs })
    void factsFor(ask).then(
      (known) => {
        // (an ask that went stale resolves empty: by then this effect has been replaced, and `live` says so)
        // the table the program runs from: its own, or the default one (plc/controller.ts)
        if (live) setReport(collectProblems({ ...input, controller: known.table }, known.facts))
      },
      (e: unknown) => console.warn('[oip] checking the program failed', e),
    )
    return () => {
      live = false
    }
  }, [input, state.controller, state.stScanMs])
  if (!report) {
    // (not yet `.problems-panel`: that is the panel with its counts and rows, which a reader may wait for)
    return (
      <div className="problems-notes" data-testid="problems-checking">
        <div className="problems-note">{t(M.checking)}</div>
      </div>
    )
  }

  const problemRows = showWarnings ? report.problems : report.problems.filter((p) => p.severity === 'error')

  const go = (p: Problem): void => {
    if (p.offset !== undefined) {
      // the PLC panel has to be MOUNTED before it can be told where to put the cursor
      store.revealPanel('st')
      store.revealStOffset(p.offset)
      return
    }
    if (p.panel !== undefined) {
      // the PLC panel has to be MOUNTED before its organizer can be told to show its tasks
      store.revealPanel('st')
      store.revealStOrganizer()
      return
    }
    if (p.parts.length === 0) return
    const live = new Set(state.scene.parts.map((x) => x.id))
    const ids = p.parts.filter((id) => live.has(id))
    if (ids.length === 0) return
    store.selectMany(ids)
    controller?.view.focusOn(ids)
  }

  return (
    <div className="problems-panel">
      <div className="problems-head">
        <span className={`problems-count${report.errors > 0 ? ' bad' : ''}`}>
          {t(M.errors, { count: report.errors })}
        </span>
        <button
          type="button"
          className={`problems-toggle${showWarnings ? ' on' : ''}`}
          aria-pressed={showWarnings}
          title={t(showWarnings ? M.hideWarnings : M.showWarnings)}
          onClick={() => store.setProblemsShowWarnings(!showWarnings)}
        >
          {t(M.warnings, { count: report.warnings })}
        </button>
      </div>

      <div className="problems-list" role="list">
        {problemRows.length === 0 && (
          <div className="problems-empty">
            {report.errors === 0 && report.warnings === 0
              ? t(M.none)
              : t(M.warningsHidden, { count: report.warnings })}
          </div>
        )}
        {problemRows.map((p) => (
          <ProblemRow key={p.key} p={p} onGo={go} />
        ))}
      </div>

      {report.notes.length > 0 && (
        <div className="problems-notes">
          {report.notes.map((n) => (
            <div className="problems-note" key={n}>
              {n}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ICONS: Record<Problem['severity'], string> = { error: '✖', warning: '⚠' }

/** One row: a button, because it navigates (see the header). */
function ProblemRow({ p, onGo }: { p: Problem; onGo: (p: Problem) => void }) {
  const action = rowAction(p)
  return (
    <button
      type="button"
      role="listitem"
      className={`problems-row ${p.severity}${action !== null ? '' : ' inert'}`}
      onClick={() => onGo(p)}
      title={action ?? undefined}
    >
      <span className="problems-icon" aria-hidden="true">
        {ICONS[p.severity]}
      </span>
      <span className="problems-group">{p.group}</span>
      <span className="problems-subject">{p.subject}</span>
      <span className="problems-message">{p.message}</span>
      {p.count !== undefined && (
        <span className="problems-repeat" title={t(M.repeated, { count: p.count })}>
          {p.count > 999 ? '999+' : p.count}
        </span>
      )}
    </button>
  )
}
