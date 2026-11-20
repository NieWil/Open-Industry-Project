// The default controller's OPC UA SERVER, in Controller Properties under its "This simulator" choice: the program
// here, published by name for a SCADA or HMI (editor/links/opcUaServer.ts). A switch, a port and whether the network
// may reach it; the settings are this computer's and apply at once, since the server lives for as long as it is on
// rather than for one run. Each other controller the simulator runs has a server of its own, set with the same fields
// in its row (NamedPlcsSection.tsx), as each PLC on a line has its own, so each sits under the controller it serves.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { EditorController } from '../../controller'
import { serverStatusHint, serverStatusLine } from '../../links/opcUaServer'
import type { OpcUaServerStatus } from '../../links/opcUaServer'
import type { EditorState, EditorStore } from '../../store/store'
import type { UaServerSettings } from '../../store/storePrefs'
import { CommitField, SectionHead, wholeIn } from './ExternalPlcSection'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('opcUaServer', {
  whyNot: 'The OPC UA server needs the desktop app: a browser tab cannot listen on a network port.',
  section: 'OPC UA server',
  publishTitle: "Publish the program's variables over OPC UA, for a SCADA or HMI to read and write",
  publish: "Publish the program's variables",
  publishNote: '(for a SCADA or HMI)',
  guide: 'Step-by-step guide: connect a SCADA or HMI over OPC UA',
  readOnlyTitle: "An input the scene feeds (a photo eye), a constant and a timer's outputs are read-only.",
  keepsRunning: 'The program keeps running here; a client reads its variables and writes the ones an operator would, like a Start button or a setpoint.',
  portTitle: "The TCP port the server listens on. 4840 is OPC UA's standard port, often taken by a discovery server.",
  port: 'Port',
  networkTitle: 'Listen on every network interface, so a SCADA on another machine can connect. Windows may ask to allow it through the firewall.',
  network: 'Reachable from the network',
  lastWrite: 'Last write from a client: {write}',
  nodeIdTitle: "Variables are under Objects / PLC, and each NodeId is the variable's name, like ns=1;s=Main.Start.",
  unsecured: "Unsecured (security policy None, anonymous login): allow None in the client's connection settings.",
})

/** Why the switch is greyed out: a message id, resolved where it is shown. */
export const WHY_NOT = M.whyNot
/** The step-by-step guide for this section (guides/opcua/index.html). Absolute, so the desktop shell opens it in the
 *  OS browser instead of under oip://app/. */
const OPCUA_GUIDE = 'https://www.openindustryproject.org/guides/opcua/'

/** A server's state, read again whenever the links report a change and every second, for the values going live. */
export function useServerStatus(controller: EditorController, read: () => Readonly<OpcUaServerStatus>): OpcUaServerStatus {
  const [status, setStatus] = useState<OpcUaServerStatus>(() => ({ ...read() }))
  useEffect(() => {
    const take = (): void => setStatus({ ...read() })
    take()
    const off = controller.onExternalPlcStatus(take)
    const timer = window.setInterval(take, 1000)
    return () => {
      off()
      window.clearInterval(timer)
    }
    // `read` names one server, which the caller keeps for as long as this is shown
  }, [controller])
  return status
}

export function OpcUaServerSection({ store, state, controller }: { store: EditorStore; state: EditorState; controller: EditorController }): ReactElement {
  const status = useServerStatus(controller, () => controller.opcUaServerStatus)
  return (
    <div className="ctl-ua" data-testid="opcua-server" role="group" aria-label={t(M.section)}>
      <UaServerHead />
      <UaServerFields tid="opcua-server" settings={state.externalPlc} update={(patch) => store.setExternalPlc(patch)} status={status} available={controller.opcUaServerAvailable} running={state.running} locked={state.readOnly} guide />
    </div>
  )
}

/** The heading every controller's server block has, so the default controller's and the others' read alike. */
export function UaServerHead(): ReactElement {
  return <SectionHead title={t(M.section)} scope="computer" />
}

/** One controller's OPC UA server: the switch, its port and network reach, and how it is doing. */
export function UaServerFields({
  tid,
  settings,
  update,
  status,
  available,
  running,
  locked,
  guide = false,
}: {
  /** the test ids' prefix */
  tid: string
  settings: UaServerSettings
  update: (patch: Partial<UaServerSettings>) => void
  status: OpcUaServerStatus
  available: boolean
  running: boolean
  locked: boolean
  /** show the step-by-step guide's link (the default controller's section has it; once is enough) */
  guide?: boolean
}): ReactElement {
  const on = settings.uaServer && available
  const hint = serverStatusHint(status)
  return (
    <>
      <label className="ctl-ext-field" title={t(available ? M.publishTitle : WHY_NOT)}>
        <input type="checkbox" checked={on} disabled={!available || locked} onChange={(e) => update({ uaServer: e.target.checked })} data-testid={`${tid}-enabled`} />
        {t(M.publish)} <span className="ctl-dim">{t(M.publishNote)}</span>
      </label>
      {guide && (
        <div className="ctl-dim ctl-ext-indent" data-testid={`${tid}-guide`}>
          <a href={OPCUA_GUIDE} target="_blank" rel="noopener noreferrer">
            {t(M.guide)}
          </a>
        </div>
      )}
      {available && (
        <>
          {guide && (
            <div className="ctl-dim ctl-ext-indent" title={t(M.readOnlyTitle)}>
              {t(M.keepsRunning)}
            </div>
          )}
          <div className="ctl-ext-row ctl-ext-indent">
            <label className="ctl-ext-field" title={t(M.portTitle)}>
              {t(M.port)}
              <CommitField
                value={String(settings.uaServerPort)}
                numeric
                disabled={locked}
                commit={(text) => {
                  const n = wholeIn(text, 1, 65535)
                  if (n === null) return false
                  update({ uaServerPort: n })
                  return true
                }}
                testId={`${tid}-port`}
              />
            </label>
            <label className="ctl-ext-field" title={t(M.networkTitle)}>
              <input type="checkbox" checked={settings.uaServerNetwork} disabled={locked} onChange={(e) => update({ uaServerNetwork: e.target.checked })} data-testid={`${tid}-network`} />
              {t(M.network)}
            </label>
          </div>
          {on && (
            <div className={`ctl-ext-indent ${status.state === 'failed' ? 'ctl-problem' : 'ctl-dim'}`} data-testid={`${tid}-status`} role="status">
              {serverStatusLine(status, running)}
              {status.lastWrite && <div data-testid={`${tid}-last-write`}>{t(M.lastWrite, { write: status.lastWrite })}</div>}
            </div>
          )}
          {on && hint && (
            <div className="ctl-dim ctl-ext-indent" data-testid={`${tid}-hint`}>
              {hint}
            </div>
          )}
          {(guide || on) && (
            <div className="ctl-warn ctl-ext-indent" data-testid={`${tid}-unsecured`} title={t(M.nodeIdTitle)}>
              {t(M.unsecured)}
            </div>
          )}
        </>
      )}
    </>
  )
}
