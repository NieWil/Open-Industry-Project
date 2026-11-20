import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { partChanges } from '../../core/parts/partChanges'
import type { EditorController } from '../controller'
import { dialogHost } from '../dialogHost'
import { documentSceneOf, type EditorState } from '../store/store'
import { takeUpdates, usePartUpdates, type PartUpdate } from '../parts/partUpdates'
import { updateAllQuestion, updatesAvailableText } from './builtInUpdate'
import { trapTab, useModalKeys } from './inspector/menu'
import { CloseIcon } from './toolbarIcons'
import { ChangeList, useSignalImpacts } from './PartChangeList'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('partUpdates', {
  inRoom: '{question} Everyone in this shared project gets the change.',
  barDetail: 'Newer versions are available where these parts came from. This project keeps using its own until you choose.',
  updateAll: 'Update all',
  review: 'Review',
  dismiss: 'Dismiss',
  title: 'Part updates',
  close: 'Close',
  intro:
    'Newer versions of these parts are available from the app, a part library or the parts shelf. This project uses its own copies until you take the new one, and every placed copy of a part changes when you do.',
  editedToo: 'changed in this project too',
  fromApp: 'from the app',
  fromLibrary: 'from {library}',
  fromShelf: 'from the parts shelf',
  useTitleEdited: "Take the newer version. This project's changes to it are discarded.",
  useTitle: 'Take the newer version.',
  useConfirm: "Use the newer {name}? This project's changes to it are discarded.",
  useNew: 'Use new version',
  keepTitle: "Keep this project's version. The app asks again only if it updates the part again.",
  keep: "Keep this project's",
})

function sourceText(u: PartUpdate): string {
  return u.source === 'app' ? t(M.fromApp) : u.source === 'library' ? t(M.fromLibrary, { library: u.from ?? '' }) : t(M.fromShelf)
}

/**
 * Said when a project is open and newer versions are available of parts it holds copies of, from the app, a part
 * library or the parts shelf (docs/part-sources.md): how many, with Update all and Review. Nothing changes until
 * someone chooses, so a line that is delivered or under acceptance testing keeps exactly what it was signed off with;
 * the cards' "Update" badges stay after a dismiss. A bar at the top of the Parts panel (Catalog.tsx), beside the badges
 * and the parts it is about, never floating over them: a sticky corner toast covered the first catalog cards and the
 * very badges it pointed at. It stays until answered or dismissed (an auto-closing toast would make the question easy
 * to miss), and a dismiss holds for this page, so for this opening of the project: opening another one reloads the
 * page. In a room an update goes to everyone there; hidden read-only, where the library cannot change.
 */
export function PartUpdatesNotice({ state, controller }: { state: EditorState; controller: EditorController | null }) {
  const [dismissed, setDismissed] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const updates = usePartUpdates(state)
  if (!controller || state.readOnly || updates.length === 0) return null
  // a part with newer versions from two sources is counted once, and Update all takes the one its card offers
  const firstPerPart = updates.filter((u, i) => updates.findIndex((v) => v.id === u.id) === i)
  const updateAll = (): void => {
    const question = updateAllQuestion(firstPerPart.map((u) => u.name), firstPerPart.filter((u) => u.edited).map((u) => u.name))
    if (window.confirm(state.collab ? t(M.inRoom, { question }) : question)) void takeUpdates(controller, firstPerPart)
  }
  return (
    <>
      {!dismissed && !reviewing && (
        <div className="part-updates-bar" role="status" data-testid="part-updates-notice">
          <span className="part-updates-bar-text">
            <strong>{updatesAvailableText(firstPerPart.length)}</strong>
            <span className="part-updates-bar-detail">{' '}{t(M.barDetail)}</span>
          </span>
          <button type="button" className="part-updates-bar-action" data-testid="part-updates-all" onClick={updateAll}>
            {t(M.updateAll)}
          </button>
          <button type="button" className="part-updates-bar-action" data-testid="part-updates-review" onClick={() => setReviewing(true)}>
            {t(M.review)}
          </button>
          <button className="part-updates-bar-close" title={t(M.dismiss)} aria-label={t(M.dismiss)} onClick={() => setDismissed(true)}>
            <CloseIcon />
          </button>
        </div>
      )}
      {reviewing && <PartUpdatesReview state={state} updates={updates} controller={controller} onUpdateAll={updateAll} onClose={() => setReviewing(false)} />}
    </>
  )
}

/** Each update, where it comes from, what it changes here, and the answers the card's badge gives. */
function PartUpdatesReview({
  state,
  updates,
  controller,
  onUpdateAll,
  onClose,
}: {
  state: EditorState
  updates: PartUpdate[]
  controller: EditorController
  onUpdateAll: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  // what each update changes is a deep compare of two packages: once per set of updates, not per render
  const rows = useMemo(() => updates.map((u) => ({ u, id: u.id, changes: partChanges(u.current, u.next) })), [updates])
  // what each breaking signal change breaks in this project, loaded when Review opens
  const impacts = useSignalImpacts(rows, documentSceneOf(state).parts, state.stProgram)
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog part-updates-dialog"
        role="dialog"
        aria-label={t(M.title)}
        data-testid="part-updates-review-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{t(M.intro)}</p>
        <ul className="part-updates-list">
          {rows.map(({ u, changes }) => (
            <li key={`${u.id}:${u.source}`} data-testid="part-updates-row" data-package-id={u.id} data-source={u.source}>
              <span className="part-updates-name">
                {u.name}
                <span className="part-updates-edited">
                  {sourceText(u)}
                  {u.edited && ` · ${t(M.editedToo)}`}
                </span>
                <ChangeList changes={changes} impacts={impacts?.get(u.id)} />
              </span>
              <button
                type="button"
                data-testid="part-updates-use"
                title={u.edited ? t(M.useTitleEdited) : t(M.useTitle)}
                onClick={() => {
                  if (!u.edited || window.confirm(t(M.useConfirm, { name: u.name }))) void takeUpdates(controller, [u])
                }}
              >
                {t(M.useNew)}
              </button>
              {u.source === 'app' && (
                <button type="button" data-testid="part-updates-keep" title={t(M.keepTitle)} onClick={() => controller.keepProjectVersion(u.id)}>
                  {t(M.keep)}
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="export-dialog-actions">
          <button onClick={onClose}>{t(M.close)}</button>
          <button data-testid="part-updates-review-all" onClick={onUpdateAll}>
            {t(M.updateAll)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
