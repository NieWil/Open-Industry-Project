// The named controllers, in Controller Properties below where the program runs: PLCs outside the app that a part's
// tag reaches by naming them, `Cell2::%IX0.0` (core/io/controllerTag.ts). Each has a link of its own, set with the
// same fields as the default controller's (ExternalPlcSection.tsx PlcLinkFields), and Play connects every one that is
// on, beside the program here or the external PLC that runs instead of it (controller/plcLinks.ts).
//
// The list is the project's (SceneJSON.plcs): adding, renaming and removing a controller are edits with undo, and
// travel with the project. Where each PLC is belongs to this computer (store/storePlcs.ts). A controller the tags name
// that the project does not list is said here, with a button that adds it.

import { useMemo, useState } from 'react'
import { commitControllerRename } from '../../program/assignController'
import type { ReactElement } from 'react'
import type { EditorController } from '../../controller'
import type { EditorState, EditorStore } from '../../store/store'
import { controllersUsed, isControllerName, partsForController } from '../../../core/io/controllerTag'
import type { PlcSetupController } from '../../store/storePlcs'
import { MAX_NAMED_PLCS, servePortClash } from '../../store/storePrefs'
import { statusLine } from '../../links/externalPlcStatus'
import { plcOfProgram } from '../../../plc'
import { CommitField, ConnectionsButton, PlcLinkFields, useLinkStatus, WHY_NOT } from './ExternalPlcSection'
import { linkSource } from '../../program/plcConnections'
import { UaServerFields, UaServerHead, useServerStatus } from './OpcUaServerSection'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('namedPlcs', {
  section: 'Other controllers',
  uaServer: "{name}'s OPC UA server",
  note: "A part's PLC tag that starts with a controller's name and two colons, like Cell2::%IX0.0, is wired to that controller's PLC. A tag without a name belongs to the default controller above. Play connects each one that is on, beside it.",
  none: 'No other controllers. Add one to wire part of the scene to a second PLC.',
  connect: 'Connect on Play',
  run: 'Run on Play',
  runTitle: "On Play, run this controller's tasks and the program instances on them, here in the simulator",
  runsOn: 'Runs on',
  simulator: 'This simulator',
  simulatorTitle: "The simulator runs this controller: its tasks and the program instances on them (the organizer's Tasks), on memory and I/O of its own",
  externalPlc: 'An external PLC',
  externalPlcTitle: "A PLC outside the app runs this controller: Play hands it the tags that start with this controller's name",
  instances: { one: 'Runs {list}.', other: 'Runs {list}.' },
  noInstances: "Runs no program instance yet: put one on a task of this controller's (the organizer's Tasks, or the instance's Program Properties).",
  connectTitle: "On Play, connect this PLC and hand it the tags that start with this controller's name",
  connections: 'PLC connections…',
  connectionsTitle: "Wire the scene's machines to this PLC's variables by picking both",
  remove: 'Remove',
  removeTitle: 'Remove this controller from the project. The parts keep their tags.',
  name: 'Name',
  nameTitle: 'A letter or underscore, then letters, digits and underscores, at most 32 characters. Parts reach it as Name::tag.',
  add: 'Add controller',
  badName: '{name} is not a controller name: use a letter or underscore, then letters, digits and underscores.',
  taken: 'There is already a controller named {name}.',
  full: 'A project holds at most {count} other controllers.',
  missing: 'Tags name {name}, which the project has no controller for, so they stay unconnected.',
  missingTasks: 'Tasks run on {name}, which the project has no controller for, so nothing runs them.',
  setUp: 'Add {name}',
  rename: 'Rename',
  renameTitle: 'Rename this controller, and every tag in the project that names it (one undo step)',
  renameRefused: '{name} is taken or is not a controller name: a letter or underscore, then letters, digits and underscores.',
  portClash: "Port {port} is also {other}'s, and two links cannot listen on one port: give one of them another.",
  mainController: 'the external PLC above',
  settings: 'Settings',
  settingsTitle: 'How this PLC connects, and what Play hands it',
})

export function NamedPlcsSection({ store, state, controller, onConnections }: { store: EditorStore; state: EditorState; controller: EditorController; onConnections?: (name: string) => void }): ReactElement {
  const available = controller.externalPlcAvailable
  const locked = state.running || state.readOnly
  const controllers = state.externalPlc.controllers
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  // one controller's settings open at a time, so the list stays a list: the one just added, until another is opened
  const [openName, setOpenName] = useState<string | null>(null)
  // the controllers the parts' tags name, and those the task table gives tasks or instances to (the organizer's
  // "Set up" opens here for one of those)
  const tagged = useMemo(() => controllersUsed(state.scene.parts), [state.scene.parts])
  const used = useMemo(() => {
    const names = [...tagged]
    const table = state.controller
    for (const plc of [...(table?.tasks ?? []), ...(table?.programs ?? [])].map((x) => x.plc)) {
      if (plc !== undefined && !names.some((n) => n.toLowerCase() === plc.toLowerCase())) names.push(plc)
    }
    return names
  }, [tagged, state.controller])
  // a name set up in another case is not missing: the Problems dock asks for the tags to be spelled as it is
  // every controller the project lists, the default one first
  const listed = [state.externalPlc.mainName, ...controllers.map((c) => c.name)]
  const missing = used.filter((name) => !listed.some((c) => c.toLowerCase() === name.toLowerCase()))

  const add = (name: string): void => {
    if (!isControllerName(name)) return setError(t(M.badName, { name }))
    const taken = listed.find((c) => c.toLowerCase() === name.toLowerCase())
    if (taken) return setError(t(M.taken, { name: taken }))
    if (!store.addNamedPlc(name)) return setError(t(M.full, { count: MAX_NAMED_PLCS }))
    setOpenName(name)
    setDraft('')
    setError(null)
  }

  return (
    // part of the Controllers section above it, so no rule between them
    <section className="ctl-ext" data-testid="named-plcs" aria-label={t(M.section)}>
      <h4 className="ctl-subhead">{t(M.section)}</h4>
      <div className="ctl-dim ctl-sec-note">{t(M.note)}</div>
      {controllers.length === 0 && missing.length === 0 && <div className="ctl-dim">{t(M.none)}</div>}
      {missing.map((name) => (
        <div key={name} className="ctl-ext-row" data-testid="named-plc-missing" data-name={name}>
          <span className="ctl-problem">{t(tagged.some((n) => n.toLowerCase() === name.toLowerCase()) ? M.missing : M.missingTasks, { name })}</span>
          <button type="button" className="ctl-btn" disabled={locked} onClick={() => add(name)} data-testid="named-plc-set-up">
            {t(M.setUp, { name })}
          </button>
        </div>
      ))}
      {controllers.map((c) => (
        <NamedPlc
          key={c.name}
          store={store}
          state={state}
          controller={controller}
          link={c}
          locked={locked}
          available={available}
          open={openName === c.name}
          onToggle={() => setOpenName(openName === c.name ? null : c.name)}
          onRenamed={(to) => openName === c.name && setOpenName(to)}
          onConnections={onConnections ? () => onConnections(c.name) : undefined}
        />
      ))}
      <div className="ctl-ext-row">
        <label className="ctl-ext-field" title={t(M.nameTitle)}>
          {t(M.name)}
          <input
            type="text"
            className="ctl-ext-wide"
            value={draft}
            disabled={locked}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              add(draft.trim())
            }}
            data-testid="named-plc-name"
          />
        </label>
        <button type="button" className="ctl-btn" disabled={locked || draft.trim() === ''} onClick={() => add(draft.trim())} data-testid="named-plc-add">
          {t(M.add)}
        </button>
      </div>
      {error && (
        <div className="ctl-problem" role="alert" data-testid="named-plc-error">
          {error}
        </div>
      )}
    </section>
  )
}

interface NamedPlcProps {
  store: EditorStore
  state: EditorState
  controller: EditorController
  link: PlcSetupController
  locked: boolean
  available: boolean
  /** its connection settings are showing */
  open: boolean
  onToggle: () => void
  onRenamed: (to: string) => void
  /** open PLC Connections for this controller; offered while it is a PLC that lists its variables (ADS, EtherNet/IP, OPC UA) */
  onConnections?: () => void
}

/** One named controller: its name, whether Play connects it, its link's state in a line, and its settings when open. */
function NamedPlc({ store, state, controller, link, locked, available, open, onToggle, onRenamed, onConnections }: NamedPlcProps): ReactElement {
  // the simulator runs it: no link, and no network needed, so a browser tab runs it too
  const simulated = link.runsOn === 'app'
  const linked = !simulated && link.enabled && available
  const table = state.controller
  const instances = table ? table.programs.filter((p) => plcOfProgram(table, p)?.toLowerCase() === link.name.toLowerCase()).map((p) => p.name) : []
  const status = useLinkStatus(controller, state.running, () => controller.namedPlcStatus(link.name))
  const uaStatus = useServerStatus(controller, () => controller.namedUaServerStatus(link.name))
  const parts = useMemo(() => partsForController(state.scene.parts, link.name), [state.scene.parts, link.name])
  const [renaming, setRenaming] = useState(false)
  // a name the rename refused, said until the next try, as the default controller's rename does
  const [refused, setRefused] = useState<string | null>(null)
  const clash = servePortClash(state.externalPlc, link.name)
  const tid = `named-plc-${link.name}`
  return (
    <div className="ctl-ext ctl-named" data-testid="named-plc" data-name={link.name}>
      <div className="ctl-ext-row">
        {renaming ? (
          <CommitField
            value={link.name}
            disabled={locked}
            testId={`${tid}-rename-field`}
            commit={(to) => {
              setRenaming(false)
              if (to === link.name) return true
              const done = commitControllerRename(store, link.name, to)
              setRefused(done ? null : to)
              if (done) onRenamed(to)
              return done
            }}
          />
        ) : (
          // i18n-ok: the controller's name, as the parts' tags spell it
          <strong>{link.name}</strong>
        )}
        <label className="ctl-ext-field" title={simulated ? t(M.runTitle) : t(available ? M.connectTitle : WHY_NOT)}>
          <input type="checkbox" checked={link.enabled} disabled={(!available && !simulated) || locked} onChange={(e) => store.setNamedPlc(link.name, { enabled: e.target.checked })} data-testid={`${tid}-enabled`} />
          {t(simulated ? M.run : M.connect)}
        </label>
        {linked && (
          <button type="button" className="ctl-btn" title={t(M.settingsTitle)} aria-expanded={open} onClick={onToggle} data-testid={`${tid}-settings`}>
            {t(M.settings)} {open ? '▴' : '▾' /* i18n-ok: a disclosure arrow */}
          </button>
        )}
        <button type="button" className="ctl-btn" title={t(M.renameTitle)} disabled={locked || renaming} onClick={() => setRenaming(true)} data-testid={`${tid}-rename`}>
          {t(M.rename)}
        </button>
        <button type="button" className="ctl-btn" title={t(M.removeTitle)} disabled={locked} onClick={() => store.setNamedPlc(link.name, null)} data-testid={`${tid}-remove`}>
          {t(M.remove)}
        </button>
        {onConnections && !simulated && linkSource(link) !== null && available && (
          <ConnectionsButton title={t(M.connectionsTitle)} label={t(M.connections)} onClick={onConnections} testId={`${tid}-connections`} />
        )}
      </div>
      {refused !== null && (
        <div className="ctl-problem" data-testid={`${tid}-rename-refused`}>
          {t(M.renameRefused, { name: refused })}
        </div>
      )}
      <div className="ctl-ext-mode" role="radiogroup" aria-label={t(M.runsOn)}>
        <label className="ctl-ext-field" title={t(M.simulatorTitle)}>
          <input type="radio" name={`${tid}-runs-on`} checked={simulated} disabled={locked} onChange={() => store.setPlcRunsOn(link.name, 'app')} data-testid={`${tid}-simulator`} />
          {t(M.simulator)}
        </label>
        <label className="ctl-ext-field" title={t(available ? M.externalPlcTitle : WHY_NOT)}>
          <input type="radio" name={`${tid}-runs-on`} checked={!simulated} disabled={locked} onChange={() => store.setPlcRunsOn(link.name, 'plc')} data-testid={`${tid}-external`} />
          {t(M.externalPlc)}
        </label>
      </div>
      {simulated && (
        <div className={instances.length === 0 ? 'ctl-problem' : 'ctl-dim'} data-testid={`${tid}-instances`}>
          {instances.length === 0 ? t(M.noInstances) : t(M.instances, { count: instances.length, list: instances.join(', ') })}
        </div>
      )}
      {/* a simulated controller's own OPC UA server, as each PLC on a line has one, while Play runs it */}
      {simulated && link.enabled && (
        <div className="ctl-ua" role="group" aria-label={t(M.uaServer, { name: link.name })}>
          <UaServerHead />
          <UaServerFields
            tid={`${tid}-opcua`}
            settings={link}
            update={(patch) => store.setNamedPlc(link.name, patch)}
            status={uaStatus}
            available={controller.opcUaServerAvailable}
            running={state.running}
            locked={state.readOnly}
          />
        </div>
      )}
      {clash !== null && linked && (
        <div className="ctl-problem" data-testid={`${tid}-port-clash`}>
          {t(M.portClash, { port: link.port, other: clash === '' ? t(M.mainController) : clash })}
        </div>
      )}
      {linked && !open && (
        <div className={status.state === 'failed' || (state.running && status.stale) ? 'ctl-problem' : 'ctl-dim'} data-testid={`${tid}-summary`} role="status">
          {statusLine(status, state.running, link, true)}
        </div>
      )}
      {linked && open && (
        <PlcLinkFields tid={tid} settings={link} update={(patch) => store.setNamedPlc(link.name, patch)} status={status} parts={parts} running={state.running} locked={locked} beside />
      )}
    </div>
  )
}
