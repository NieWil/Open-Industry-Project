import { useEffect, useRef } from 'react'
import type { PartBuildNotice } from '../store/store'
import { CloseIcon } from './toolbarIcons'
import { ToastCopyButton } from './ToastCopy'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('partBuild', {
  failed: '⚠ “{name}” failed to build',
  dismiss: 'Dismiss',
})

// How long a build-failure toast lingers before auto-dismissing. Build errors matter more than the
// "new version" prompt, so they sit a touch longer; the author can also dismiss early with ✕.
const DISMISS_MS = 9000

/**
 * Bottom-corner toasts for custom parts that failed to build (a desktop file-save or load that didn't
 * compile). The PackageLibrary already produces these errors; this just makes them visible so an author
 * isn't left wondering why their edit "did nothing". Each toast auto-dismisses on a timer and the catalog
 * card keeps a ⚠ badge until the next good rebuild. Renders nothing (and runs no timers) when clean.
 */
export function PartBuildToast({ notices, onDismiss }: { notices: PartBuildNotice[]; onDismiss: (key: number) => void }) {
  // one timer per notice, armed when its key first shows. The caller passes a fresh onDismiss each render, so
  // keying the timers on it (or re-arming them on every notices change) would push a dismissal back on every edit.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const armed = timers.current
    const shown = new Set(notices.map((n) => n.key))
    for (const [key, timer] of armed) {
      if (shown.has(key)) continue
      clearTimeout(timer)
      armed.delete(key)
    }
    for (const key of shown) {
      if (armed.has(key)) continue
      armed.set(
        key,
        setTimeout(() => {
          armed.delete(key)
          dismissRef.current(key)
        }, DISMISS_MS),
      )
    }
  }, [notices])
  useEffect(() => {
    const armed = timers.current
    return () => {
      armed.forEach(clearTimeout)
      armed.clear()
    }
  }, [])

  if (notices.length === 0) return null
  return (
    <div className="part-build-toasts">
      {notices.map((n) => (
        <div key={n.key} className="part-build-toast" role="alert">
          <div className="part-build-toast-body">
            <span className="part-build-toast-title">{t(M.failed, { name: n.name })}</span>
            <span className="part-build-toast-error">{n.error}</span>
          </div>
          <ToastCopyButton text={`${t(M.failed, { name: n.name })}\n${n.error}`} />
          <button className="part-build-toast-close" title={t(M.dismiss)} onClick={() => onDismiss(n.key)}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  )
}
