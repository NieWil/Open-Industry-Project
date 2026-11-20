/**
 * Whole-app crash boundary.
 *
 * Without it, a thrown error anywhere in the React tree would unmount the editor to a blank page: no
 * message, no way to get the scene out, and nothing on screen to say the work still exists. It does
 * exist (the project autosave, or in a room IndexedDB + the server, holds the last committed state),
 * but a white page suggests otherwise, and the natural next move is to close the tab.
 *
 * So the boundary's job is not diagnostics but keeping the work safe: say what happened, get the document out
 * of the browser and onto disk before anything else, and only then offer the reload. Export leads
 * for that reason; it runs off `store.snapshotProject()`, which is plain data and survives a render
 * failure. Copy details hands over `crashReportText` so a report can arrive with a stack attached
 * rather than as "it went white".
 *
 * Scope: React boundaries catch render / lifecycle / effect throws only. An error in
 * an event handler, in a promise, or inside the three.js animation loop never reaches this - those
 * leave a half-broken app rather than a blank one, and are a different problem.
 */
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { crashReportText, crashSummary } from '../crashReport'
import { downloadProject } from '../project/projectFile'
import type { EditorStore } from '../store/store'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('crash', {
  exported: 'Project exported.',
  exportFailed: 'Export failed: {reason}',
  copied: 'Details copied.',
  copyFailed: 'Could not copy. Select the text below instead.',
  title: 'The editor stopped',
  body: 'Something went wrong and this view could not keep running. Your work is not lost: save it to a file first, then reload.',
  export: 'Export project…',
  copy: 'Copy details',
  reload: 'Reload',
})

interface CrashDialogProps {
  /** the live store, read only through `snapshotProject()` so a corrupt view layer can't block the export */
  readonly store: EditorStore
  readonly children: ReactNode
}

interface CrashDialogState {
  error: unknown
  componentStack: string | null
  /** what the last Export / Copy attempt did, shown inline: a crashed app has no toast host left */
  note: string | null
}

export class AppCrashBoundary extends Component<CrashDialogProps, CrashDialogState> {
  override state: CrashDialogState = { error: null, componentStack: null, note: null }

  static getDerivedStateFromError(error: unknown): Partial<CrashDialogState> {
    // a thrown `undefined` would otherwise read as "no error" and re-render the broken tree forever
    return { error: error ?? new Error('Unknown error') }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // keep the console the primary record: the dialog is a summary, devtools has the whole thing
    console.error('[oip] editor crashed', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? null })
  }

  private report(): string {
    return crashReportText(this.state.error, {
      build: __BUILD_ID__,
      url: location.href,
      userAgent: navigator.userAgent,
      componentStack: this.state.componentStack,
    })
  }

  private onExport = (): void => {
    this.setState({ note: null })
    // Failure here is the case that matters (a quota error, or a store too broken to snapshot), so it
    // is reported rather than swallowed: "the button did nothing" is the worst possible answer now.
    downloadProject(this.props.store).then(
      () => this.setState({ note: t(M.exported) }),
      (err: unknown) => this.setState({ note: t(M.exportFailed, { reason: crashSummary(err) }) }),
    )
  }

  private onCopy = (): void => {
    const text = this.report()
    navigator.clipboard?.writeText(text).then(
      () => this.setState({ note: t(M.copied) }),
      () => this.setState({ note: t(M.copyFailed) }),
    )
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <div className="crash-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="crash-title">
        <div className="crash-dialog">
          <h2 className="crash-title" id="crash-title">
            {t(M.title)}
          </h2>
          <p className="crash-body">{t(M.body)}</p>
          <div className="crash-actions">
            <button type="button" className="crash-action primary" onClick={this.onExport}>
              {t(M.export)}
            </button>
            <button type="button" className="crash-action" onClick={this.onCopy}>
              {t(M.copy)}
            </button>
            <button type="button" className="crash-action" onClick={() => location.reload()}>
              {t(M.reload)}
            </button>
          </div>
          {this.state.note && (
            <p className="crash-note" role="status">
              {this.state.note}
            </p>
          )}
          <pre className="crash-report">{this.report()}</pre>
        </div>
      </div>
    )
  }
}
