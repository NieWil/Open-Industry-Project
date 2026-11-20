import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectJSON } from '../../core/project/project'
import { downloadProject, exportChoicesFor } from '../project/projectFile'
import type { EditorStore } from '../store/store'
import { dialogHost } from '../dialogHost'
import { trapTab, useModalKeys } from './inspector/menu'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('exportProject', {
  title: 'Export Project',
  close: 'Close',
  intro:
    'The file always has the scene and its PLC program. It also carries these unless you untick them, which is how to send a job without the rest of this project.',
  quoted: '“{name}”',
  andMore: '{list} and {count} more',
  unusedParts: { one: '{count} part this project does not use', other: '{count} parts this project does not use' },
  tests: { one: '{count} project test', other: '{count} project tests' },
  cancel: 'Cancel',
  export: 'Export',
})

/**
 * Export Project's choices: what the file may leave out that nobody looking at the scene would know it carries
 * (parts nothing uses, built-in copies included since every part a project uses is its own, tests). Everything is ticked, so a backup is whole unless someone
 * unticks it; leaving things out is how a job goes to a customer or colleague without the rest of the library.
 * There is no separate "Export Scene": that name would make a scene look like a file of its own. Shown only when
 * there is something to choose (commands.ts file.exportProject).
 */
export function ExportProjectDialog({ store, project, onClose }: { store: EditorStore; project: ProjectJSON; onClose: () => void }) {
  const [parts, setParts] = useState(true)
  const [tests, setTests] = useState(true)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const choices = exportChoicesFor(project)
  const exportNow = (): void => {
    onClose()
    void downloadProject(store, { unusedParts: !parts, tests: !tests })
  }
  useModalKeys(onClose, (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      exportNow()
    } else if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  const n = choices.unusedParts.length
  const listed = choices.unusedParts
    .slice(0, 3)
    .map((x) => t(M.quoted, { name: x }))
    .join(', ')
  const named = n > 3 ? t(M.andMore, { list: listed, count: n - 3 }) : listed
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog export-dialog"
        role="dialog"
        aria-label={t(M.title)}
        data-testid="export-project-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{t(M.intro)}</p>
        <div className="export-dialog-choices">
          {n > 0 && (
            <label title={named}>
              <input type="checkbox" data-testid="export-unused-parts" checked={parts} onChange={(e) => setParts(e.target.checked)} />
              {t(M.unusedParts, { count: n })}
              <span className="export-dialog-names">{named}</span>
            </label>
          )}
          {choices.tests > 0 && (
            <label>
              <input type="checkbox" data-testid="export-tests" checked={tests} onChange={(e) => setTests(e.target.checked)} />
              {t(M.tests, { count: choices.tests })}
            </label>
          )}
        </div>
        <div className="export-dialog-actions">
          <button onClick={onClose}>{t(M.cancel)}</button>
          <button data-testid="export-project-confirm" autoFocus onClick={exportNow}>
            {t(M.export)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
