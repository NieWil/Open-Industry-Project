import { useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('updatePrompt', {
  available: 'A new version is available.',
  reload: 'Reload',
})

// A browser only re-checks the service worker for a new build at registration (page load),
// so a tab left open for hours never discovers a deploy. Poll on a timer and whenever the
// tab regains focus so a stale tab eventually surfaces the prompt. The interval is short
// because the toast is non-intrusive - it never reloads on its own (see UpdatePrompt).
const UPDATE_INTERVAL = 20 * 60 * 1000

/**
 * Shows a "new version available - Reload" toast once a fresh deploy is detected, and drives
 * service-worker registration + periodic update checks. In 'prompt' mode (see vite.config.ts)
 * the new worker waits until the user clicks Reload, so we never interrupt an in-progress edit
 * or shared collab session. Rendered unconditionally (all device sizes).
 */
export function UpdatePrompt() {
  const regRef = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      if (!reg) return
      regRef.current = reg
      const check = (): void => {
        // skip while offline: update() would just fail, and we'll re-check on next focus
        if (navigator.onLine) void reg.update()
      }
      setInterval(check, UPDATE_INTERVAL)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })

  // updateServiceWorker(true) alone reloads only on workbox's `controlling` event with isUpdate, and isUpdate is
  // fixed at page load, so a tab that loaded with no controller (first visit, or Ctrl+Shift+R) never reloaded.
  // The worker claims every tab when it activates (clientsClaim in vite.config.ts), so controllerchange fires here
  // either way. The listener is added on click, in this tab only: the new worker takes over every open tab, and
  // one listening from startup would reload a tab with work in progress. With no worker waiting (another tab
  // already activated it) there is nothing to message, so reload straight away.
  const reload = (): void => {
    if (!regRef.current?.waiting) {
      window.location.reload()
      return
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
    void updateServiceWorker(true)
  }

  if (!needRefresh) return null
  return (
    <div className="update-toast" role="status">
      <span>{t(M.available)}</span>
      <button onClick={reload}>{t(M.reload)}</button>
    </div>
  )
}
