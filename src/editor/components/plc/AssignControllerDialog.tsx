// Assign to Controller: which PLC the selected parts' tags go to (editor/program/assignController.ts). The choices
// are the default controller (the program here, or the external PLC that runs instead of it), every named controller
// this computer has set up or the scene's tags already name, and a new name. Opened by the "Assign to Controller…"
// command (editor/commands.ts).

import { useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { controllersUsed, isControllerName, spelledAs } from '../../../core/io/controllerTag'
import { dialogHost } from '../../dialogHost'
import { commitControllerAssignment } from '../../program/assignController'
import type { EditorState, EditorStore } from '../../store/store'
import { trapTab, useModalKeys } from '../inspector/menu'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('assignController', {
  title: 'Assign to Controller',
  close: 'Close',
  intro: { one: "Put every PLC tag of the selected part on one controller. The rest of each tag stays as it is.", other: 'Put every PLC tag of the {count} selected parts on one controller. The rest of each tag stays as it is.' },
  main: 'The program in this app',
  mainExternal: 'The external PLC',
  mainNote: '(tags with no controller name)',
  newName: 'A new controller',
  nameTitle: 'A letter or underscore, then letters, digits and underscores, at most 32 characters',
  badName: 'Give the new controller a name: a letter or underscore, then letters, digits and underscores.',
  nothing: 'Every tag of the selection is on that controller already.',
  setUpNote: 'A new controller is added to the project, and Controller Properties lists it for its address.',
  assign: 'Assign',
  cancel: 'Cancel',
  undoMain: 'Assign to the program',
  undoMainExternal: 'Assign to the external PLC',
  undoNamed: 'Assign to {name}',
})

/** The "a new controller" choice: not a controller name, so a controller really called `new` stays its own choice. */
const NEW = Symbol('new controller')

export function AssignControllerDialog({ store, state, onClose }: { store: EditorStore; state: EditorState; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const ids = state.selectedIds
  // every controller worth offering: the ones set up here, then any other the tags name
  const names = useMemo(() => {
    const set = state.externalPlc.controllers.map((c) => c.name)
    // the default controller is the first choice, under what runs it, so its name is not offered again
    const main = state.externalPlc.mainName.toLowerCase()
    return [...set, ...controllersUsed(state.scene.parts).filter((n) => !set.some((k) => k.toLowerCase() === n.toLowerCase()) && n.toLowerCase() !== main)]
  }, [state.externalPlc, state.scene.parts])
  // nothing is picked at first: Assign straight away must not move the parts off the PLC they are on
  const [choice, setChoice] = useState<string | null | typeof NEW | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const assign = (): void => {
    if (choice === undefined) return
    // a new name that is a known one in another case is that controller (IEC names ignore case)
    const typed = choice === NEW ? spelledAs(draft.trim(), names) : choice
    // the default controller's own name means the default controller, whose tags carry none
    const target = typed !== null && typed.toLowerCase() === state.externalPlc.mainName.toLowerCase() ? null : typed
    if (target !== null && !isControllerName(target)) return setError(t(M.badName))
    const external = state.externalPlc.enabled
    const label = target === null ? t(external ? M.undoMainExternal : M.undoMain) : t(M.undoNamed, { name: target })
    // a controller the project does not list yet is added in the same undo step, ready for its address
    if (commitControllerAssignment(store, ids, target, label).tags === 0) return setError(t(M.nothing))
    onClose()
  }

  useModalKeys(onClose, (e) => {
    // Enter on a button is that button (Cancel cancels); anywhere else it is Assign
    if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') {
      e.preventDefault()
      assign()
    } else if (ref.current) trapTab(ref.current, e)
  })

  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div ref={ref} className="author-dialog controller-dialog" role="dialog" aria-label={t(M.title)} data-testid="assign-controller" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="controller-dialog-body ctl-ext">
          <div className="ctl-dim">{t(M.intro, { count: ids.length })}</div>
          <div className="ctl-dim">{t(M.setUpNote)}</div>
          <div className="ctl-ext-mode" role="radiogroup" aria-label={t(M.title)}>
            <label className="ctl-ext-field">
              <input type="radio" name="assign-controller" checked={choice === null} onChange={() => setChoice(null)} data-testid="assign-controller-main" />
              {t(state.externalPlc.enabled ? M.mainExternal : M.main)} <span className="ctl-dim">{t(M.mainNote)}</span>
            </label>
            {names.map((name) => (
              <label key={name} className="ctl-ext-field">
                <input type="radio" name="assign-controller" checked={choice === name} onChange={() => setChoice(name)} data-testid="assign-controller-named" data-name={name} />
                {/* i18n-ok: the controller's name, as the parts' tags spell it */}
                {name}
              </label>
            ))}
            <label className="ctl-ext-field" title={t(M.nameTitle)}>
              <input type="radio" name="assign-controller" checked={choice === NEW} onChange={() => setChoice(NEW)} data-testid="assign-controller-new" />
              {t(M.newName)}
              <input
                type="text"
                className="ctl-ext-wide"
                value={draft}
                onFocus={() => setChoice(NEW)}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setError(null)
                }}
                data-testid="assign-controller-name"
              />
            </label>
          </div>
        </div>
        <div className="props-foot">
          <span className="props-error" role="alert" data-testid="assign-controller-error">
            {error ? `⚠ ${error}` : ''}
          </span>
          <button className="props-ok" data-testid="assign-controller-ok" disabled={choice === undefined} onClick={assign}>
            {t(M.assign)}
          </button>
          <button onClick={onClose}>{t(M.cancel)}</button>
        </div>
      </div>
    </div>,
    host,
  )
}
