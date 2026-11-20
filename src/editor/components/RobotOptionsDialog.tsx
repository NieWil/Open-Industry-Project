import { useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { trapTab, useModalKeys } from './inspector/menu'
import { dialogHost } from '../dialogHost'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('robotOptions', {
  title: 'Import {file}',
  intro: "Its description can build the robot with or without these. Each starts as the description's default.",
  import: 'Import',
  close: 'Close',
})

/**
 * The on/off arguments of a xacro robot that change its links (core/xacro.ts xacroSwitches), such as an arm's own hand,
 * asked before it imports. Answers with the arguments the user changed, as xacro values.
 */
export function RobotOptionsDialog({
  file,
  switches,
  onImport,
  onClose,
}: {
  file: string
  switches: Readonly<Record<string, boolean>>
  onImport: (args: Record<string, string>) => void
  onClose: () => void
}): ReactElement {
  const [values, setValues] = useState<Record<string, boolean>>({ ...switches })
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const submit = (): void => {
    const changed: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) if (v !== switches[k]) changed[k] = v ? 'true' : 'false'
    onImport(changed)
  }
  useModalKeys(onClose, (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  const title = t(M.title, { file })
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div ref={dialogRef} className="author-dialog name-dialog" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{title}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{t(M.intro)}</p>
        <div className="robot-options">
          {Object.keys(switches).map((name) => (
            <label key={name} className="robot-option">
              <input
                type="checkbox"
                checked={values[name] ?? false}
                data-testid={`robot-option-${name}`}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.checked }))}
              />
              {/* the argument's name as the description spells it */}
              <code>{name}</code>
            </label>
          ))}
        </div>
        <div className="robot-options-foot">
          <button autoFocus data-testid="robot-options-import" onClick={submit}>
            {t(M.import)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
