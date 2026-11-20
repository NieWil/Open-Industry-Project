import { useEffect, useRef } from 'react'
import type { Notice } from '../store/store'
import { CloseIcon } from './toolbarIcons'
import { ToastCopyButton } from './ToastCopy'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('notice', {
  dismiss: 'Dismiss',
})

// long enough to read a two-line reason, short enough not to linger over the next edit
const DISMISS_MS = 8000

/**
 * A transient, self-dismissing statement about something the app just did or declined to do, not a question:
 * every notice on this surface reports a state the user cannot take back from the toast (an undo that dropped a
 * step, the demo forking into a project of their own), so it explains and gets out of the way.
 *
 * Same corner and look as the part build toasts; `tone` picks the accent, because an amber toast on this surface
 * reads as "something went wrong" and an informational notice must not. The timer is keyed on the notice itself,
 * so an unrelated re-render does not keep pushing its dismissal back.
 */
export function NoticeToast({
  notice,
  onDismiss,
  onAction,
  testId,
  tone = 'warn',
}: {
  notice: Notice | null
  onDismiss: () => void
  /** runs a notice's `action` (a command id) - passed in so this stays a plain view with no registry import */
  onAction?: (command: string) => void
  testId: string
  tone?: 'warn' | 'info'
}) {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const key = notice?.key
  useEffect(() => {
    if (key === undefined) return
    const timer = setTimeout(() => dismissRef.current(), DISMISS_MS)
    return () => clearTimeout(timer)
  }, [key])

  if (!notice) return null
  return (
    <div className="part-build-toasts">
      <div className={`part-build-toast${tone === 'info' ? ' info' : ''}`} role="status" data-testid={testId}>
        <div className="part-build-toast-body">
          <span className="part-build-toast-title">{notice.title}</span>
          <span className="part-build-toast-error">{notice.message}</span>
          {notice.action && onAction && (
            <button
              type="button"
              className="part-build-toast-action"
              onClick={() => {
                onAction(notice.action!.command)
                onDismiss()
              }}
            >
              {notice.action.label}
            </button>
          )}
        </div>
        <ToastCopyButton text={`${notice.title}\n${notice.message}`} />
        <button className="part-build-toast-close" title={t(M.dismiss)} onClick={onDismiss}>
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
