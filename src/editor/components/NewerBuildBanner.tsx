import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('newerBuild', {
  title: '⚠ Newer version in this shared project',
  bodyDesktop:
    'Someone joined this shared project with a newer version of the app, so this window is view-only: its older version could overwrite what it cannot read. Update the desktop app to keep editing here.',
  bodyBrowser:
    'Someone joined this shared project with a newer version of the app, so this tab is view-only: its older version could overwrite what it cannot read. Reload to get the new version and keep editing.',
  getUpdate: 'Get the update',
  reload: 'Reload',
})

/**
 * Sticky "a newer version of the app has joined this room" banner (store.roomNewerBuild).
 *
 * Same chrome as OtherTabBanner, for the same kind of moment: this tab has stopped editing for good and is
 * view-only. Here the reason is the build. An older build cannot represent everything a newer one writes, and
 * each path it writes back by would lose what it could not read (collab/schema.ts ROOM_BUILD_META), so it
 * watches instead. In a browser, Reload is the way back to editing: it loads the newer build the room is on.
 *
 * The desktop app is the exception, because it carries its build: a reload there loads the same old version and
 * puts this banner straight back. So the desktop is told to update the app instead, and its button runs the
 * shell's update check (desktopMenuBridge.ts getDesktopUpdate, apps/desktop/updater.cjs).
 */
export function NewerBuildBanner({
  shown,
  desktop = false,
  onReload,
  onUpdate,
}: {
  shown: boolean
  /** the desktop app, where reloading cannot reach a newer build */
  desktop?: boolean
  onReload: () => void
  onUpdate?: () => void
}) {
  if (!shown) return null
  return (
    <div className="autosave-banner" role="alert" data-testid="newer-build-banner">
      <span className="autosave-banner-title">{t(M.title)}</span>
      {desktop ? (
        <span className="autosave-banner-body">{t(M.bodyDesktop)}</span>
      ) : (
        <span className="autosave-banner-body">{t(M.bodyBrowser)}</span>
      )}
      {desktop ? (
        <button type="button" className="autosave-banner-action" onClick={onUpdate}>
          {t(M.getUpdate)}
        </button>
      ) : (
        <button type="button" className="autosave-banner-action" onClick={onReload}>
          {t(M.reload)}
        </button>
      )}
    </div>
  )
}
