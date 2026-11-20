// The PLC panel's file button: the demo, import, and the two export targets behind one "File" (commands.ts owns what
// each does and whether it is allowed). It is about the program file.
//
// It is labelled "File", not "⋯": the ladder's element bar ends in a "⋯" of its own (the selection's menu), right under
// this one, and two identical buttons stacked in one corner that open different menus read as a mistake.

import { Fragment, useState, type ReactElement } from 'react'
import { commandDisabledReason, commandEnabled, getCommand, runCommand } from '../../commands'
import { ChevronIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('plcFileMenu', {
  hintOpenDemo: 'Open the built-in example. Edit it and it becomes a project of your own',
  hintImport:
    'Load an IEC 61131-3 .st file or a PLCopen XML project. Anything this engine cannot hold is listed rather than dropped silently',
  hintExportSt:
    'Download as IEC 61131-3 Structured Text (.st). The CONFIGURATION/RESOURCE/TASK wrapper is generated, so a real toolchain can build it.',
  hintExportXml: 'Download as PLCopen XML: the IEC interchange format many PLC toolchains import.',
  menuLabel: 'Program file commands',
  menuTitle: 'Open the demo, import a program, or export this one',
  file: 'File',
  stopForDemo: 'Stop the simulation to open the demo',
})

/** `hint` is a message id, resolved where the menu renders. */
const FILE_MENU: { id: string; hint: string; sepBefore?: boolean }[] = [
  { id: 'file.openDemo', hint: M.hintOpenDemo },
  { id: 'file.importPlc', hint: M.hintImport, sepBefore: true },
  { id: 'file.exportPlcSt', hint: M.hintExportSt },
  { id: 'file.exportPlcXml', hint: M.hintExportXml },
]
/** about the widest label's menu, for keeping it on screen */
const FILE_MENU_W = 250
const FILE_MENU_H = 140

export interface PlcFileMenuProps {
  /** the button's own style, the panel's (its header's buttons all share one) */
  style?: React.CSSProperties
  /** the program is read-only: the reason, for a refused item */
  readOnly: boolean
  readOnlyNote: string
}

/** The "File" button and the menu it opens, which closes on a click anywhere else. */
export function PlcFileMenu({ style, readOnly, readOnlyNote }: PlcFileMenuProps): ReactElement {
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  return (
    <>
      <button
        data-testid="st-file-menu"
        style={style}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={t(M.menuLabel)}
        title={t(M.menuTitle)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          // the panel's own window: popped out, it is not the one this code was loaded in
          const view = e.currentTarget.ownerDocument.defaultView ?? window
          const left = Math.max(8, Math.min(r.left, view.innerWidth - FILE_MENU_W - 8))
          // down from the button, as a menu at the top of a panel opens; up only when a short bottom dock leaves no room
          const down = r.bottom + 4 + FILE_MENU_H <= view.innerHeight
          setAt((m) => (m ? null : down ? { left, top: r.bottom + 4 } : { left, bottom: view.innerHeight - r.top + 4 }))
        }}
      >
        {t(M.file)} <ChevronIcon dir="down" />
      </button>
      {at && (
        <>
          <div className="context-backdrop" onClick={() => setAt(null)} onContextMenu={(e) => { e.preventDefault(); setAt(null) }} />
          <div className="context-menu" role="menu" data-testid="st-file-menu-items" style={{ left: at.left, top: at.top, bottom: at.bottom }}>
            {FILE_MENU.map(({ id, hint, sepBefore }) => {
              const enabled = commandEnabled(id)
              return (
                <Fragment key={id}>
                  {sepBefore && <div className="context-sep" />}
                  <button
                    className="context-item"
                    role="menuitem"
                    disabled={!enabled}
                    // only the demo is refused for a running sim; a view-only link refuses the demo and the import
                    title={enabled ? t(hint) : (commandDisabledReason(id) ?? (readOnly ? readOnlyNote : t(M.stopForDemo)))}
                    onClick={() => {
                      setAt(null)
                      runCommand(id)
                    }}
                  >
                    {getCommand(id)?.label ?? id}
                  </button>
                </Fragment>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}
