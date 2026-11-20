import { useEffect, useState } from 'react'
import { getOipMenuApi } from '../desktop/desktopMenuBridge'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('desktopUpdate', {
  ready: 'Version {version} is ready. It installs when you quit, or restart now.',
  restart: 'Restart',
})

/**
 * The desktop app's "update ready" notice: the shell downloaded a new version in the background
 * (apps/desktop/updater.cjs) and it installs on the next quit, or now, from Restart. The web's UpdatePrompt has
 * the same job for a deploy, and the same rule: nothing restarts on its own, under an edit in progress.
 *
 * A notice and not a dialog: a dialog that waits for an answer holds its window, and the app then
 * ignored being closed for two minutes (updater.cjs). Asks the shell on mount too, so a page reloaded after the
 * download still shows it.
 */
export function DesktopUpdateToast() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    const api = getOipMenuApi()
    if (!api?.onUpdateReady) return
    let live = true
    void api
      .updateState?.()
      .then((v) => {
        if (live && v) setVersion(v)
      })
      .catch((e: unknown) => console.warn('[oip] reading the update state failed', e))
    const off = api.onUpdateReady((v) => setVersion(v))
    return () => {
      live = false
      off()
    }
  }, [])

  if (!version) return null
  return (
    <div className="update-toast" role="status" data-testid="desktop-update-toast">
      <span>{t(M.ready, { version })}</span>
      <button onClick={() => void getOipMenuApi()?.installUpdate?.()}>{t(M.restart)}</button>
    </div>
  )
}
