import { useRef } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { DeviceTags } from '../../../plc'
import type { TagRow } from '../../../plc/tags'
import type { TagRef } from '../../../plc/crossRef'
import { trapTab, useModalKeys } from '../inspector/menu'
import { dialogHost } from '../../dialogHost'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('crossRef', {
  dialogLabel: 'Cross reference: {name}',
  title: 'Cross Reference',
  close: 'Close',
  declared: 'Declared {section} {type} in {scope}.',
  declaredWithDescription: 'Declared {section} {type} in {scope}: {description}.',
  theController: 'the controller',
  notDeclared: 'Not declared in this program.',
  deviceReads: '{device} reads it as its {field}',
  deviceWrites: '{device} writes it as its {field}',
  deviceUses: '{device} uses it as its {field}',
  doubleCoil: {
    one: 'Written every scan by {count} element. That is a duplicate destructive reference (a double coil): the last one to run decides the bit.',
    other: 'Written every scan by {count} elements. That is a duplicate destructive reference (a double coil): the last one to run decides the bit.',
  },
  noReferences: 'No references.',
  showRung: 'Show this rung',
  ladderN: 'Ladder {n}',
  rungWhere: '{routine} · rung {rung}',
  energizes: 'energizes',
  writes: 'writes',
  reads: 'reads',
  showLine: 'Show this line',
  lineN: 'line {line}',
  showDeclaration: 'Show declaration',
})

/**
 * Cross Reference (Ctrl+E on an operand in the ladder sheet: plc/crossRef.ts): every place a variable is used - each
 * rung and how the element touches it, each line of Structured Text, its declaration, the device wired to it.
 * A row is a door: click it and the panel shows that place.
 */
export function CrossRefDialog({
  name,
  refs,
  declaration,
  devices,
  onOpenRung,
  onOpenText,
  onClose,
}: {
  name: string
  refs: TagRef[]
  declaration: TagRow | null
  devices: { device: DeviceTags; field: string; section: string | null }[]
  onOpenRung: (routine: number, rung: number) => void
  onOpenText: (offset: number) => void
  onClose: () => void
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const dialogHostOnce = useRef(dialogHost())
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  const writes = refs.filter((r) => r.kind === 'ladder' && r.destructive).length
  return createPortal(
    // clicks stop here: through the portal they would reach the ladder view's own root, whose click deselects
    <div className="author-backdrop" onPointerDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div ref={dialogRef} className="author-dialog xref-dialog" role="dialog" aria-label={t(M.dialogLabel, { name })} data-testid="xref-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>
            {t(M.title)} <code className="xref-name">{name}</code>
          </h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">
          {declaration
            ? t(declaration.description ? M.declaredWithDescription : M.declared, {
                section: declaration.section,
                type: declaration.type,
                scope: declaration.scope.kind === 'controller' ? t(M.theController) : declaration.scope.name,
                description: declaration.description,
              })
            : t(M.notDeclared)}
          {devices.length > 0 && ` ${devices.map((d) => `${t(d.section === 'VAR_OUTPUT' ? M.deviceReads : d.section === 'VAR_INPUT' ? M.deviceWrites : M.deviceUses, { device: d.device.name, field: d.field })}`).join('; ')}.`}
          {writes > 1 && (
            <b className="xref-warn"> {t(M.doubleCoil, { count: writes })}</b>
          )}
        </p>
        <div className="xref-rows">
          {refs.length === 0 && <div className="plc-empty-note">{t(M.noReferences)}</div>}
          {refs.map((r, i) =>
            r.kind === 'ladder' ? (
              <button key={i} className={`xref-row${r.destructive ? ' destructive' : ''}`} data-testid="xref-rung" onClick={() => onOpenRung(r.routine, r.rung)} title={t(M.showRung)}>
                <span className="xref-where">{t(M.rungWhere, { routine: r.routineName || t(M.ladderN, { n: r.routine + 1 }), rung: r.rung })}</span>
                <span className={`xref-access ${r.access}`}>{r.mnemonic}</span>
                <span className="xref-what">{t(r.access === 'write' ? (r.destructive ? M.energizes : M.writes) : M.reads)}</span>
              </button>
            ) : (
              <button key={i} className="xref-row" data-testid="xref-text" onClick={() => onOpenText(r.offset)} title={t(M.showLine)}>
                <span className="xref-where">{t(M.lineN, { line: r.line })}</span>
                {/* i18n-ok: IEC language name */}
                <span className="xref-access text">ST</span>
                <span className="xref-what mono">{r.text}</span>
              </button>
            ),
          )}
        </div>
        <div className="device-tags-foot">
          {declaration && <button onClick={() => onOpenText(declaration.offset)}>{t(M.showDeclaration)}</button>}
          <button onClick={onClose}>{t(M.close)}</button>
        </div>
      </div>
    </div>,
    dialogHostOnce.current,
  )
}
