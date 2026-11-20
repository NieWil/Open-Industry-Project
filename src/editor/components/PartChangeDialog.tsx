import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PartChange } from '../../core/parts/partChanges'
import type { PartInstance } from '../../core/types'
import { dialogHost } from '../dialogHost'
import { registerPartChangeDialog, type PartChangeAnswer, type PartChangeRequest } from '../partChangeDialog'
import { trapTab, useModalKeys } from './inspector/menu'
import { ChangeList, useSignalImpacts } from './PartChangeList'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('partChange', {
  close: 'Close',
  cancel: 'Cancel',
})

/**
 * Asked before one version of a part replaces another (docs/part-sources.md): what taking it changes, most severe
 * first, so updating a part on a delivered line is a decision made with the list in front of you. `here` gives the
 * project's scene and program when the change lands in this project, so a breaking signal change says what it breaks
 * here. It is left out when the change lands on the shelf, where the projects it affects are not open.
 */
export function PartChangeDialog({
  title,
  intro,
  partId,
  changes,
  confirmLabel,
  alternative,
  here,
  onConfirm,
  onAlternative,
  onClose,
}: {
  title: string
  intro: string
  partId: string
  changes: PartChange[]
  confirmLabel: string
  alternative?: { label: string; title: string }
  here?: { parts: readonly PartInstance[]; program: string }
  onConfirm: () => void
  onAlternative?: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const [updates] = useState(() => [{ id: partId, changes }])
  const impacts = useSignalImpacts(here ? updates : [], here?.parts ?? [], here?.program ?? '')
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="author-dialog part-updates-dialog"
        role="dialog"
        aria-label={title}
        data-testid="part-change-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="author-head">
          <h2>{title}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{intro}</p>
        <ChangeList changes={changes} impacts={impacts?.get(partId)} />
        <div className="export-dialog-actions">
          <button onClick={onClose}>{t(M.cancel)}</button>
          {alternative && (
            <button
              data-testid="part-change-alternative"
              title={alternative.title}
              onClick={() => {
                onAlternative?.()
                onClose()
              }}
            >
              {alternative.label}
            </button>
          )}
          <button
            data-testid="part-change-confirm"
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}

/** The one mounted answer to askPartChange(): a dialog per request, each settled once (the first answer given). */
export function PartChangeDialogHost() {
  const [pending, setPending] = useState<{ request: PartChangeRequest; resolve: (answer: PartChangeAnswer) => void } | null>(null)
  const current = useRef(pending)
  current.current = pending
  useEffect(
    () =>
      registerPartChangeDialog((request, resolve) => {
        current.current?.resolve('cancel') // a newer request supersedes one still open
        let settled = false
        setPending({
          request,
          resolve: (answer) => {
            if (settled) return
            settled = true
            resolve(answer)
          },
        })
      }),
    [],
  )
  if (!pending) return null
  return (
    <PartChangeDialog
      key={`${pending.request.partId}\0${pending.request.title}`}
      {...pending.request}
      onConfirm={() => pending.resolve('confirm')}
      onAlternative={() => pending.resolve('alternative')}
      onClose={() => {
        pending.resolve('cancel')
        setPending(null)
      }}
    />
  )
}
