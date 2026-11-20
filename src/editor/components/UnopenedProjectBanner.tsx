import type { UnopenedProject } from '../project/projectFile'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('unopenedProject', {
  quotedName: '“{name}”',
  yourProject: 'Your saved project',
  moreErrors: '{first} (+{count} more)',
  title: '⚠ Saved project not opened',
  body: '{which} could not be opened, so nothing is saved over it until you download or discard it.{why}',
  download: 'Download it',
  discard: 'Discard…',
})

/**
 * Sticky "your saved project could not be opened" banner (projectFile.unopenedProject).
 *
 * The same chrome as AutosaveBanner, and it takes that banner's place while it is up: saving is refused for
 * the whole session, so the generic "Not saving" warning would be true but point at the wrong way out (its
 * Export action exports what is on screen, which is the fallback, not the document that did not open).
 *
 * It offers the only two ways forward. Download hands over the stored document as it is, to fix by hand or
 * open in a newer build. Discard gives it up so saving can resume, and confirms first, because nothing else
 * in this browser holds that exact text.
 */
export function UnopenedProjectBanner({
  unopened,
  onDownload,
  onDiscard,
}: {
  unopened: UnopenedProject | null
  onDownload: () => void
  onDiscard: () => void
}) {
  if (!unopened) return null
  const which = unopened.name !== null ? t(M.quotedName, { name: unopened.name }) : t(M.yourProject)
  const [first, ...rest] = unopened.errors
  const why = first === undefined ? '' : ` ${rest.length > 0 ? t(M.moreErrors, { first, count: rest.length }) : first}`
  return (
    <div className="autosave-banner" role="alert" data-testid="unopened-project-banner">
      <span className="autosave-banner-title">{t(M.title)}</span>
      <span className="autosave-banner-body">{t(M.body, { which, why })}</span>
      <button type="button" className="autosave-banner-action" onClick={onDownload}>
        {t(M.download)}
      </button>
      <button type="button" className="autosave-banner-action" onClick={onDiscard}>
        {t(M.discard)}
      </button>
    </div>
  )
}
