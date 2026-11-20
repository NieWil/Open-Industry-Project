import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { EditorController } from '../../controller'
import { dialogHost } from '../../dialogHost'
import type { EditorState, EditorStore } from '../../store/store'
import { ExternalPlcSection, WHY_NOT as PLC_WHY_NOT } from './ExternalPlcSection'
import { NamedPlcsSection } from './NamedPlcsSection'
import { PlcConnectionsWindow } from './PlcConnectionsWindow'
import { OpcUaServerSection, WHY_NOT as SERVER_WHY_NOT } from './OpcUaServerSection'
import { trapTab, useModalKeys } from '../inspector/menu'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('controllerDialog', {
  bothNeedDesktop: 'Connecting to a PLC or serving OPC UA needs the desktop app: a browser tab cannot open a network connection or listen on a port.',
  assignStillWorks: '{why} Assign I/O Addresses and the I/O list still work (right-click Top-level code in the organizer): wire the scene here, then open it in the desktop app to connect it.',
  title: 'Controller Properties',
  close: 'Close',
  done: 'Done',
})

// Controller Properties: where the program runs. Opened from the organizer's Controller node (double-click, or its
// right-click Properties), from the toolbar's link status, and by the "PLC Controllers…" command, which is how a search
// for "PLC" or "Modbus" in the palette finds it. These are settings of the controller, so they
// live on its node.
//
// It replaced the Controller dock, which a tab of its own gave more room than two choices and a few fields need. The
// live link state that dock showed during Play is in the toolbar now, beside Play and Stop, where it is seen whatever
// tab is in front.
//
// Every setting applies as it is chosen. The controllers, what runs each and how Play reaches it are the project's, each
// change an edit with undo; a PLC's address belongs to the bench it sits on, so it is this computer's preference
// (store/storePlcs.ts).

/** What this surface cannot do, said once above the sections rather than under each: both reasons are the same one. */
function desktopOnly(controller: EditorController): string | null {
  const plc = controller.externalPlcAvailable
  const server = controller.opcUaServerAvailable
  if (plc && server) return null
  const why = t(!plc && !server ? M.bothNeedDesktop : !plc ? PLC_WHY_NOT : SERVER_WHY_NOT)
  return plc ? why : t(M.assignStillWorks, { why })
}

export function ControllerDialog({ store, state, controller, onClose }: { store: EditorStore; state: EditorState; controller: EditorController; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  // PLC Connections for one controller (null: the default one) in this dialog's place, from the button beside its name
  const [wiring, setWiring] = useState<{ plc: string | null } | null>(null)
  // opened where the user is: the popped-out PLC window, when that is where they asked for it
  const [host] = useState(dialogHost)
  // the modal owns every key at the window (capture), so a field never sees its own Enter: commit it from here by taking
  // the focus off it, since the connection fields commit on blur (ExternalPlcSection CommitField). Without this, Enter
  // did nothing and the next Escape dropped the typed address.
  // while PLC Connections shows in this dialog's place its own keys apply: both listen on the window, so this one
  // stands aside, or Escape would close this dialog with it
  useModalKeys(wiring ? () => {} : onClose, (e) => {
    if (wiring) return
    const t = e.target as HTMLInputElement | null
    // (tag name, not `instanceof`: in a popped-out window the input belongs to another realm)
    if (e.key === 'Enter' && t?.tagName === 'INPUT' && t.type === 'text') {
      e.preventDefault()
      t.blur()
    } else if (ref.current) trapTab(ref.current, e)
  })
  const notice = desktopOnly(controller)
  if (wiring) return <PlcConnectionsWindow store={store} state={state} controller={controller} plcName={wiring.plc} onClose={() => setWiring(null)} />
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div ref={ref} className="author-dialog controller-dialog" role="dialog" aria-label={t(M.title)} data-testid="controller-props" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="controller-dialog-body">
          {notice && (
            <div className="ctl-banner" role="note" data-testid="controller-desktop-only">
              {notice}
            </div>
          )}
          <ExternalPlcSection
            store={store}
            state={state}
            controller={controller}
            server={<OpcUaServerSection store={store} state={state} controller={controller} />}
            onConnections={() => setWiring({ plc: null })}
          />
          <NamedPlcsSection store={store} state={state} controller={controller} onConnections={(plc) => setWiring({ plc })} />
        </div>
        <div className="props-foot">
          <button className="props-ok" data-testid="controller-props-close" onClick={onClose} autoFocus>
            {t(M.done)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
