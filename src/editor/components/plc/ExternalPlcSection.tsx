// Where the program runs: the body of the Controller Properties dialog (ControllerDialog.tsx), opened from the
// organizer's Controller node, the toolbar's link status and the "PLC Controllers…" command. Here in the simulator, or
// on a real PLC that Play hands the scene's I/O to instead (editor/links/externalPlc.ts).
//
// What it carries is not configured here. A part is wired to an I/O point by its PLC tag (`%IX100.0`), and
// the Modbus point follows from the address, so this only lists what the scene makes, before Play as well
// as during it, and says what cannot be carried. What runs the default controller and how Play reaches it are the
// project's (SceneJSON.plcs, an edit with undo); where the PLC is, the simulator's port for a PLC that polls it or the
// PLC's address for one that serves, is this computer's (store/storePlcs.ts). The same fields (PlcLinkFields) set
// each named controller's link in NamedPlcsSection.tsx. Assigning the scene's
// tags their addresses (Assign I/O, the I/O list) is the project's business, not this machine's, so it is a
// command on the organizer's Top-level code row rather than a button here.

import { canWatch } from '../../../core/scene/scenePlcs'
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { EditorController } from '../../controller'
import { plannedLink, statusHint, statusLine } from '../../links/externalPlc'
import type { ExternalPlcStatus } from '../../links/externalPlc'
import type { EditorState, EditorStore } from '../../store/store'
import { isAmsNetId } from '../../../core/io/ads'
import { parseOpcUaBrowseRoots } from '../../../core/io/opcUa'
import { partsForController } from '../../../core/io/controllerTag'
import type { PartInstance } from '../../../core/types'
import { isEipPath, isOpcUaEndpoint, isPlcHost, servePortClash } from '../../store/storePrefs'
import type { ExternalPlcSettings, PlcLinkSettings } from '../../store/storePrefs'
import { linkSource } from '../../program/plcConnections'
import type { MessageId } from '../../../core/i18n'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('externalPlc', {
  onPlay: "On Play, connect the scene's PLC tags to a real PLC over Modbus TCP, OPC UA, EtherNet/IP, S7, SLMP or ADS, instead of running the program here",
  here: 'Play runs the program in the PLC panel, here in the simulator',
  whyNot: 'Connecting to a PLC needs the desktop app: a browser tab cannot open a network connection.',
  guideServe: 'Step-by-step guide: connect a PLC over Modbus TCP',
  guidePoll: "Step-by-step guide: connect to a PLC's Modbus TCP server",
  guideOpcUa: "Step-by-step guide: connect to a PLC's OPC UA server",
  guideS7: 'Step-by-step guide: connect an S7-1200 or S7-1500 over PUT/GET',
  guideSlmp: 'Step-by-step guide: connect a MELSEC PLC over SLMP',
  guideAds: 'Step-by-step guide: connect a TwinCAT PLC over ADS',
  sceneScopeTitle: 'Saved with the project, for everyone who opens it',
  computerScopeTitle: 'Saved on this computer, not in the project: an address belongs to the bench it sits on',
  sceneScope: 'Saved with the project',
  computerScope: 'This computer only',
  section: 'Controllers',
  sectionNote: "Each controller's name, what runs it and how Play reaches it. Where each PLC is (its address, a port) is kept on this computer.",
  runsOn: 'Runs on',
  watch: 'Watch only',
  watchNote: '(read every tag, the sensors included, and write nothing to the PLC)',
  watchNoteModbus: "(not over Modbus: choose a protocol that can read the PLC's inputs)",
  watchTitle:
    'For a PLC that runs real equipment: Play reads what the real sensors and the program are doing and shows it here, and never writes to the PLC, so the simulator cannot overwrite a real input.',
  defaultTitle: 'The default controller: a tag with no controller name in front belongs to it',
  defaultNote: '(default: tags with no controller name)',
  connections: 'PLC connections…',
  connectionsTitle: "Wire the scene's machines to this PLC's variables by picking both",
  rename: 'Rename',
  renameTitle: 'Rename the default controller. Its tags carry no name, so none of them change.',
  renameRefused: '{name} is taken or is not a controller name: a letter or underscore, then letters, digits and underscores.',
  thisSimulator: 'This simulator',
  thisSimulatorNote: '(the program in the PLC panel)',
  externalPlc: 'An external PLC',
  externalPlcNote: "(Play hands it the scene's tags)",
  whichEndPolls: 'How the PLC connects',
  serveTitle: "The PLC's Modbus master reads and writes the simulator, which serves on a port of this machine",
  serve: 'The PLC polls the simulator',
  serveNote: '(the PLC is the Modbus master)',
  pollTitle: 'The PLC runs a Modbus TCP server device, and the simulator connects to it and reads and writes its registers',
  poll: 'The simulator polls the PLC',
  pollNote: '(the PLC is a Modbus server)',
  opcUaTitle: "The simulator connects to the PLC's OPC UA server and reads and writes its tags by name",
  opcUa: 'OPC UA, tags by name',
  opcUaNote: '(the PLC runs an OPC UA server)',
  eipTitle: 'The simulator connects to a Logix controller (ControlLogix, CompactLogix) or a Micro800 over EtherNet/IP and reads and writes its tags by name',
  eip: 'EtherNet/IP, tags by name',
  eipNote: '(a Logix or Micro800 controller)',
  eipFamilyTitle: 'Which kind of controller answers. A Micro800 is reached at its own address and takes no path, and only its global variables can be read and written.',
  eipFamily: 'Family',
  s7Title: 'The simulator connects to an S7-1200 or S7-1500 CPU and reads and writes its I, Q and M memory and its data blocks over PUT/GET',
  s7Note: '(an S7-1200 or S7-1500)',
  slmpTitle: 'The simulator connects to a MELSEC CPU (Q, L, iQ-R, iQ-F) and reads and writes its X, Y, M and D devices over SLMP',
  slmpNote: '(a MELSEC PLC)',
  adsTitle: "The simulator reads and writes a TwinCAT PLC's variables by name over ADS, through the TwinCAT router on this PC",
  ads: 'ADS, tags by name',
  adsNote: '(a TwinCAT PLC)',
  serverTitle: "The PLC's OPC UA server, like opc.tcp://192.168.0.10:4840",
  server: 'Server',
  browseFromTitle:
    "Where to look for the PLC's tags, when its server holds far more than the program (a CNC, drives): a path of browse names from Objects, like DeviceSet.PLC.Programs, or a NodeId. Separate several with commas. Empty: everything under Objects. A tag found under a path keeps its whole path, so a tag's name works the same either way.",
  browseFrom: 'Browse from',
  opcUaUnsecuredTitle: "No certificates and an anonymous login, so the PLC's OPC UA server has to allow the None security policy.",
  opcUaUnsecured: 'Unsecured (security policy None, anonymous login): use it on this machine or a test bench, not a plant network.',
  eipGatewayTitle: "The controller's IP address, or its Ethernet module's (an EN2T): host, or host:port when it is not 44818",
  eipGateway: 'Controller',
  eipPathTitle: "The route from that module to the controller: 1,0 is the backplane, then the controller's slot (0). Empty when the address is the controller's own port, as on a CompactLogix's front port.",
  eipPath: 'Path',
  adsNetIdTitle: "The PLC's AMS Net ID, like 192.168.1.20.1.1. Empty: the TwinCAT runtime on this PC",
  adsPortTitle: "The PLC's AMS port: 851 is the first PLC project, 852 the second",
  port: 'Port',
  adsRouter: 'Goes through the TwinCAT router on this PC, so TwinCAT must be installed here, and a PLC elsewhere needs the same route TwinCAT itself uses to reach it. Leave the AMS Net ID empty for the runtime on this PC.',
  s7HostTitle: "The CPU's IP address (192.168.0.1 is a new CPU's), or its host name",
  s7Host: 'CPU',
  s7PortTitle: '102, the port every S7 CPU answers on, unless something forwards it',
  s7RackTitle: 'The rack the CPU is in: 0 on an S7-1200 or S7-1500',
  s7Rack: 'Rack',
  s7SlotTitle: "The CPU's slot: 1 on an S7-1200 or S7-1500 (a 1200 also answers on 0)",
  s7Slot: 'Slot',
  s7PutGet:
    'The CPU must allow PUT/GET: turn on "Permit access with PUT/GET communication from remote partner" in its settings and download the hardware configuration. A part\'s address is the CPU\'s own: %IX80.4 is I80.4, %QW4 is QW4, %MD10 is MD10, and a data block address uses the S7 data-block spelling, without the %: DB10.DBW4. A data block must not use optimized block access.',
  slmpHostTitle: "The CPU's IP address, or its host name",
  slmpPortTitle: '5000, the port an SLMP server answers on, unless something forwards it (the GX Works3 simulator shows its own)',
  slmpUnsecuredTitle: 'SLMP has no authentication and no encryption.',
  slmpUnsecured: 'Unsecured (no authentication, no encryption): use it on this machine or a test bench, not a plant network.',
  slmpDevices: "A part's PLC tag is a device address: D100 (a data register), M10 (an internal relay), X1A (an input), Y0 (an output), B1A (a link relay), W10 (a link register), TN5 (a timer's current value) or CN3 (a counter's). X, Y, B, W, SB, SW, DX and DY count in hexadecimal, the rest in decimal. A bit device carries a BOOL; a register carries INT, DINT or REAL. On a CPU with input modules, wire a part that publishes to X addresses no module occupies: the CPU's input refresh overwrites them every scan.",
  plcHostTitle: "The PLC's IP address or host name",
  plcHost: 'PLC',
  plcPortTitle: 'The port its Modbus TCP server device listens on (502 unless it was changed)',
  inputBaseTitle: "Where the server device's I/O mapping puts Holding Registers[0]: %IW0 when it is the PLC's only I/O",
  inputBase: 'Holding register 0 is %IW',
  outputBaseTitle: "Where the server device's I/O mapping puts Input Registers[0]: %QW0 when it is the PLC's only I/O",
  outputBase: 'Input register 0 is %QW',
  networkTitle: 'Listen on every network interface, so a PLC on another machine can connect. Windows may ask to allow it through the firewall.',
  network: 'Reachable from the network',
  opcUaNames: "A part's PLC tag is the PLC's own name for it (like Main.Eye), found on the server on Play, so nothing needs an address.",
  adsNames: "A part's PLC tag is the PLC's own name for it (MAIN.Eye, or GVL.Run for a global), asked for on Play, so nothing needs an address.",
  eipNames: "A part's PLC tag is the controller's own tag name (Eye, or Program:MainProgram.Eye for a program tag), asked for on Play, so nothing needs an address.",
  noTagEip: "No part has a PLC tag yet. Give each part the PLC's name for its signal, like Eye (a sensor) or Run (a motor).",
  noTagByName: "No part has a PLC tag yet. Give each part the PLC's name for its signal, like MAIN.Eye (a sensor) or MAIN.Run (a motor).",
  noAddress:
    'No part is wired to an I/O address yet. Give a part a PLC tag like %IX0.0 (a sensor) or %QX0.0 (a motor), or run Assign I/O Addresses (right-click Top-level code in the organizer) to put every top-level variable on a point.',
  noAddressSlmp: 'No part is wired to a device address yet. Give a part a PLC tag like D100 (a register), M10 (a bit), X1A (an input) or Y0 (an output).',
  portClash: "Port {port} is also {other}'s, and two links cannot listen on one port: give one of them another.",
})

/** Why the switch is greyed out, said on the switch as well as under it: a disabled control with no reason
 *  reads as broken, which is the same rule a command's `disabledReason` follows (editor/commands.ts). A message id,
 *  resolved where it is shown. */
export const WHY_NOT = M.whyNot
/** The step-by-step guide for each way of connecting that has one (guides/<slug>/index.html). Absolute, so the desktop
 *  shell opens it in the OS browser instead of under oip://app/. */
const GUIDES: Partial<Record<ExternalPlcSettings['mode'], { href: string; label: MessageId }>> = {
  serve: { href: 'https://www.openindustryproject.org/guides/modbus/', label: M.guideServe },
  poll: { href: 'https://www.openindustryproject.org/guides/plc-server/#modbus', label: M.guidePoll },
  opcua: { href: 'https://www.openindustryproject.org/guides/plc-server/#opcua', label: M.guideOpcUa },
  s7: { href: 'https://www.openindustryproject.org/guides/s7/', label: M.guideS7 },
  slmp: { href: 'https://www.openindustryproject.org/guides/slmp/', label: M.guideSlmp },
  ads: { href: 'https://www.openindustryproject.org/guides/ads/', label: M.guideAds },
}

/** A Controller Properties section's heading, tagged with where what it sets is saved: the scene's document, or this
 *  computer's preferences. Said once per section, where it applies, instead of in one footnote about all of them. */
export function SectionHead({ title, scope, note }: { title: string; scope: 'scene' | 'computer'; note?: string }): ReactElement {
  return (
    <div className="ctl-sec-head">
      <h3>{title}</h3>
      <span
        className="ctl-scope"
        data-scope={scope}
        title={t(scope === 'scene' ? M.sceneScopeTitle : M.computerScopeTitle)}
      >
        {t(scope === 'scene' ? M.sceneScope : M.computerScope)}
      </span>
      {note && <div className="ctl-dim ctl-sec-note">{note}</div>}
    </div>
  )
}

interface ExternalPlcSectionProps {
  store: EditorStore
  state: EditorState
  controller: EditorController
  /** the default controller's OPC UA server (OpcUaServerSection.tsx), shown under the choice to run it here, as each
   *  other controller's sits in its own row: a server publishes the program this simulator runs */
  server?: ReactNode
  /** open PLC Connections for this controller (components/plc/PlcConnectionsWindow.tsx); offered while the simulator runs
   *  the program, or it is a PLC that lists its variables (ADS, EtherNet/IP, OPC UA) */
  onConnections?: () => void
}

/** A text field that commits on Enter or blur, and snaps back to the stored value when `commit` refuses the text. */
export function CommitField({ value, commit, disabled, testId, wide, numeric, className, placeholder }: { value: string; commit: (text: string) => boolean; disabled: boolean; testId: string; wide?: boolean; numeric?: boolean; className?: string; placeholder?: string }): ReactElement {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const done = (): void => {
    if (!commit(text.trim())) setText(value)
  }
  return (
    <input
      type="text"
      className={className ?? (wide ? 'ctl-ext-wide' : undefined)}
      inputMode={numeric ? 'numeric' : undefined}
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          done()
        }
      }}
      data-testid={testId}
    />
  )
}

/** A whole number in `min..max`, or null. */
export function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= min && n <= max ? n : null
}

export function ExternalPlcSection({ store, state, controller, server, onConnections }: ExternalPlcSectionProps): ReactElement {
  const settings = state.externalPlc
  const available = controller.externalPlcAvailable
  const status = useLinkStatus(controller, state.running, () => controller.externalPlcStatus)
  // the default controller carries the tags that name no controller (core/io/controllerTag.ts)
  const parts = useMemo(() => partsForController(state.scene.parts, null), [state.scene.parts])
  const locked = state.running || state.readOnly
  /** Play hands the scene to a PLC, so how it connects is asked */
  const external = settings.enabled && available
  // a named controller serving on the same port (NamedPlcsSection.tsx says the same from its side)
  const clash = servePortClash(settings, null)

  return (
    <section className="ctl-ext ctl-sec" data-testid="external-plc" aria-label={t(M.section)}>
      <SectionHead title={t(M.section)} scope="scene" note={t(M.sectionNote)} />
      <DefaultName store={store} name={settings.mainName} locked={locked} onConnections={!settings.enabled || linkSource(settings) !== null ? onConnections : undefined} />
      <div className="ctl-ext-mode" role="radiogroup" aria-label={t(M.runsOn)}>
        <label className="ctl-ext-field" title={t(M.here)}>
          <input type="radio" name="external-plc-runs-on" checked={!external} disabled={locked} onChange={() => store.setExternalPlc({ enabled: false })} data-testid="external-plc-here" />
          {t(M.thisSimulator)} <span className="ctl-dim">{t(M.thisSimulatorNote)}</span>
        </label>
        <label className="ctl-ext-field" title={t(available ? M.onPlay : WHY_NOT)}>
          <input
            type="radio"
            name="external-plc-runs-on"
            checked={external}
            disabled={!available || locked}
            onChange={() => store.setExternalPlc({ enabled: true })}
            data-testid="external-plc-enabled"
          />
          {t(M.externalPlc)} <span className="ctl-dim">{t(M.externalPlcNote)}</span>
        </label>
      </div>
      {!external && server}
      {/* How the external PLC connects, and where, under the choice that turns it on. Assign I/O reads the stored
          mode too (editor/program/ioAssign.ts ioTargetFor), but it only tells a PLC that serves Modbus registers from
          everything else, so the choice is not offered while the program runs here. */}
      {external && clash !== null && (
        <div className="ctl-problem" data-testid="external-plc-port-clash">
          {/* i18n-ok: a controller's name, as the tags spell it */}
          {t(M.portClash, { port: settings.port, other: clash })}
        </div>
      )}
      {external && <PlcLinkFields tid="external-plc" settings={settings} update={(patch) => store.setExternalPlc(patch)} status={status} parts={parts} running={state.running} locked={locked} />}
    </section>
  )
}

/** The button beside a controller's name that opens PLC Connections for it. Not locked by a run: reading the variables and
 *  wiring them are as safe then as the Inspector's Comms fields are. */
export function ConnectionsButton({ title, label, onClick, testId }: { title: string; label: string; onClick: () => void; testId: string }): ReactElement {
  return (
    <button type="button" className="ctl-btn" title={title} onClick={onClick} data-testid={testId}>
      {label}
    </button>
  )
}

/** The default controller's name, renamed in place. */
function DefaultName({ store, name, locked, onConnections }: { store: EditorStore; name: string; locked: boolean; onConnections?: () => void }): ReactElement {
  const [renaming, setRenaming] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  return (
    <div className="ctl-ext-row" title={t(M.defaultTitle)} data-testid="plc-default">
      {renaming ? (
        <CommitField
          value={name}
          disabled={locked}
          testId="plc-default-rename-field"
          commit={(to) => {
            setRenaming(false)
            const done = to === name || store.renameNamedPlc(name, to)
            setRefused(done ? null : to)
            return done
          }}
        />
      ) : (
        // i18n-ok: the controller's name
        <strong data-testid="plc-default-name">{name}</strong>
      )}
      <span className="ctl-dim">{t(M.defaultNote)}</span>
      <button type="button" className="ctl-btn" title={t(M.renameTitle)} disabled={locked || renaming} onClick={() => setRenaming(true)} data-testid="plc-default-rename">
        {t(M.rename)}
      </button>
      {onConnections && <ConnectionsButton title={t(M.connectionsTitle)} label={t(M.connections)} onClick={onConnections} testId="plc-default-connections" />}
      {refused !== null && <span className="ctl-problem">{t(M.renameRefused, { name: refused })}</span>}
    </div>
  )
}

/**
 * A link's state, read again whenever the links report a change (a connect, a failure) and every half second while
 * running, since request counts move every poll.
 */
export function useLinkStatus(controller: EditorController, running: boolean, read: () => Readonly<ExternalPlcStatus>): ExternalPlcStatus {
  const [status, setStatus] = useState<ExternalPlcStatus>(() => ({ ...read() }))
  useEffect(() => {
    const take = (): void => setStatus({ ...read() })
    take()
    const off = controller.onExternalPlcStatus(take)
    const timer = running ? window.setInterval(take, 500) : undefined
    return () => {
      off()
      if (timer !== undefined) window.clearInterval(timer)
    }
    // `read` is a fresh closure each render; the controller and the run decide what it reads
  }, [controller, running])
  return status
}

export interface PlcLinkFieldsProps {
  /** the prefix of every test id, and of the radio group's name, so two links' fields never share one */
  tid: string
  settings: PlcLinkSettings
  update: (patch: Partial<PlcLinkSettings>) => void
  status: ExternalPlcStatus
  /** the parts as this link's controller sees them (core/io/controllerTag.ts partsForController) */
  parts: readonly PartInstance[]
  running: boolean
  locked: boolean
  /** a named controller's link, which runs beside the program here rather than in its place */
  beside?: boolean
}

/** How one link connects and where, what it would carry, and how it is doing: the default controller's or a named one's. */
export function PlcLinkFields({ tid, settings, update, status, parts, running, locked, beside = false }: PlcLinkFieldsProps): ReactElement {
  // what Play would carry, from the scene as it stands
  const planned = useMemo(() => plannedLink(parts, settings), [parts, settings])
  const live = running && status.state !== 'off'
  const points = live ? status.points : planned.points
  const problems = live ? status.problems : planned.problems
  const hint = statusHint(status, running)
  const poll = settings.mode === 'poll'
  const opcua = settings.mode === 'opcua'
  const eip = settings.mode === 'eip'
  const s7 = settings.mode === 's7'
  const slmp = settings.mode === 'slmp'
  const ads = settings.mode === 'ads'
  /** a part's PLC tag is the PLC's own name for the signal, so nothing is addressed */
  const byName = opcua || eip || ads
  const guide = GUIDES[settings.mode]

  /** a numeric setting, refused outside its range (the field then snaps back) */
  const whole = (key: 'port' | 'plcPort' | 'inputBase' | 'outputBase' | 's7Port' | 's7Rack' | 's7Slot' | 'slmpPort' | 'adsPort', min: number, max: number) => (text: string): boolean => {
    const n = wholeIn(text, min, max)
    if (n === null) return false
    update({ [key]: n })
    return true
  }

  return (
    <div className="ctl-ext ctl-ext-indent" data-testid={`${tid}-settings`}>
      <div className="ctl-ext-mode" role="radiogroup" aria-label={t(M.whichEndPolls)}>
        <label className="ctl-ext-field" title={t(M.serveTitle)}>
          <input type="radio" name={`${tid}-mode`} checked={settings.mode === 'serve'} disabled={locked} onChange={() => update({ mode: 'serve' })} data-testid={`${tid}-mode-serve`} />
          {t(M.serve)} <span className="ctl-dim">{t(M.serveNote)}</span>
        </label>
        <label className="ctl-ext-field" title={t(M.pollTitle)}>
          <input type="radio" name={`${tid}-mode`} checked={poll} disabled={locked} onChange={() => update({ mode: 'poll' })} data-testid={`${tid}-mode-poll`} />
          {t(M.poll)} <span className="ctl-dim">{t(M.pollNote)}</span>
        </label>
        <label className="ctl-ext-field" title={t(M.opcUaTitle)}>
          <input type="radio" name={`${tid}-mode`} checked={opcua} disabled={locked} onChange={() => update({ mode: 'opcua' })} data-testid={`${tid}-mode-opcua`} />
          {t(M.opcUa)} <span className="ctl-dim">{t(M.opcUaNote)}</span>
        </label>
        <label className="ctl-ext-field" title={t(M.eipTitle)}>
          <input type="radio" name={`${tid}-mode`} checked={eip} disabled={locked} onChange={() => update({ mode: 'eip' })} data-testid={`${tid}-mode-eip`} />
          {t(M.eip)} <span className="ctl-dim">{t(M.eipNote)}</span>
        </label>
        <label className="ctl-ext-field" title={t(M.s7Title)}>
          <input type="radio" name={`${tid}-mode`} checked={s7} disabled={locked} onChange={() => update({ mode: 's7' })} data-testid={`${tid}-mode-s7`} />
          {/* i18n-ok: protocol name */}
          S7 PUT/GET <span className="ctl-dim">{t(M.s7Note)}</span>
        </label>
        <label className="ctl-ext-field" title={t(M.slmpTitle)}>
          <input type="radio" name={`${tid}-mode`} checked={slmp} disabled={locked} onChange={() => update({ mode: 'slmp' })} data-testid={`${tid}-mode-slmp`} />
          {/* i18n-ok: protocol name */}
          SLMP <span className="ctl-dim">{t(M.slmpNote)}</span>
        </label>
        <label className="ctl-ext-field" title={t(M.adsTitle)}>
          <input type="radio" name={`${tid}-mode`} checked={ads} disabled={locked} onChange={() => update({ mode: 'ads' })} data-testid={`${tid}-mode-ads`} />
          {t(M.ads)} <span className="ctl-dim">{t(M.adsNote)}</span>
        </label>
      </div>
      <label className="ctl-ext-field" title={t(M.watchTitle)}>
        <input
          type="checkbox"
          checked={settings.watch === true}
          disabled={locked}
          onChange={(e) => update({ watch: e.target.checked })}
          data-testid={`${tid}-watch`}
        />
        {t(M.watch)} <span className="ctl-dim">{t(canWatch(settings.mode) ? M.watchNote : M.watchNoteModbus)}</span>
      </label>
      {guide && (
        <div className="ctl-dim" data-testid={`${tid}-guide`}>
          <a href={guide.href} target="_blank" rel="noopener noreferrer">
            {t(guide.label)}
          </a>
        </div>
      )}
      {opcua && (
        <div className="ctl-dim" data-testid={`${tid}-opcua-names`}>
          {t(M.opcUaNames)}
        </div>
      )}
      {ads && (
        <div className="ctl-dim" data-testid={`${tid}-ads-names`}>
          {t(M.adsNames)}
        </div>
      )}
      {eip && (
        <div className="ctl-dim" data-testid={`${tid}-eip-names`}>
          {t(M.eipNames)}
        </div>
      )}
      {opcua && (
        <>
          <div className="ctl-ext-row">
            <label className="ctl-ext-field" title={t(M.serverTitle)}>
              {t(M.server)}
              <CommitField
                value={settings.opcUaEndpoint}
                className="ctl-ext-endpoint"
                disabled={locked}
                commit={(text) => {
                  if (!isOpcUaEndpoint(text)) return false
                  update({ opcUaEndpoint: text })
                  return true
                }}
                testId={`${tid}-opcua-endpoint`}
              />
            </label>
          </div>
          <div className="ctl-ext-row">
            <label className="ctl-ext-field" title={t(M.browseFromTitle)}>
              {t(M.browseFrom)}
              <CommitField
                value={settings.opcUaBrowseFrom.join(', ')}
                className="ctl-ext-endpoint"
                // i18n-ok: the OPC UA Objects folder's name
                placeholder="Objects"
                disabled={locked}
                commit={(text) => {
                  const roots = parseOpcUaBrowseRoots(text)
                  if (roots === null) return false
                  update({ opcUaBrowseFrom: roots })
                  return true
                }}
                testId={`${tid}-opcua-browse-from`}
              />
            </label>
          </div>
          <div className="ctl-warn" data-testid={`${tid}-opcua-unsecured`} title={t(M.opcUaUnsecuredTitle)}>
            {t(M.opcUaUnsecured)}
          </div>
        </>
      )}
      {eip && (
        <div className="ctl-ext-row">
          <label className="ctl-ext-field" title={t(M.eipFamilyTitle)}>
            {t(M.eipFamily)}
            <select value={settings.eipFamily} disabled={locked} onChange={(e) => update({ eipFamily: e.target.value === 'micro800' ? 'micro800' : 'logix' })} data-testid={`${tid}-eip-family`}>
              {/* i18n-ok: product family names */}
              <option value="logix">ControlLogix / CompactLogix</option>
              {/* i18n-ok: a product family's name */}
              <option value="micro800">Micro800</option>
            </select>
          </label>
          <label className="ctl-ext-field" title={t(M.eipGatewayTitle)}>
            {t(M.eipGateway)}
            <CommitField
              value={settings.eipGateway}
              wide
              disabled={locked}
              commit={(text) => {
                if (!isPlcHost(text)) return false
                update({ eipGateway: text })
                return true
              }}
              testId={`${tid}-eip-gateway`}
            />
          </label>
          {settings.eipFamily !== 'micro800' && (
            <label className="ctl-ext-field" title={t(M.eipPathTitle)}>
              {t(M.eipPath)}
              <CommitField
                value={settings.eipPath}
                disabled={locked}
                commit={(text) => {
                  if (!isEipPath(text)) return false
                  update({ eipPath: text })
                  return true
                }}
                testId={`${tid}-eip-path`}
              />
            </label>
          )}
        </div>
      )}
      {ads && (
        <>
          <div className="ctl-ext-row">
            <label className="ctl-ext-field" title={t(M.adsNetIdTitle)}>
              {/* i18n-ok: the ADS protocol's name for the field */}
              AMS Net ID
              <CommitField
                value={settings.adsNetId}
                wide
                disabled={locked}
                commit={(text) => {
                  if (!isAmsNetId(text)) return false
                  update({ adsNetId: text })
                  return true
                }}
                testId={`${tid}-ads-netid`}
              />
            </label>
            <label className="ctl-ext-field" title={t(M.adsPortTitle)}>
              {t(M.port)}
              <CommitField value={String(settings.adsPort)} numeric disabled={locked} commit={whole('adsPort', 1, 65535)} testId={`${tid}-ads-port`} />
            </label>
          </div>
          <div className="ctl-dim" data-testid={`${tid}-ads-router`}>
            {t(M.adsRouter)}
          </div>
        </>
      )}
      {s7 && (
        <>
          <div className="ctl-ext-row">
            <label className="ctl-ext-field" title={t(M.s7HostTitle)}>
              {t(M.s7Host)}
              <CommitField
                value={settings.s7Host}
                wide
                disabled={locked}
                commit={(text) => {
                  if (!isPlcHost(text)) return false
                  update({ s7Host: text })
                  return true
                }}
                testId={`${tid}-s7-host`}
              />
            </label>
            <label className="ctl-ext-field" title={t(M.s7PortTitle)}>
              {t(M.port)}
              <CommitField value={String(settings.s7Port)} numeric disabled={locked} commit={whole('s7Port', 1, 65535)} testId={`${tid}-s7-port`} />
            </label>
          </div>
          <div className="ctl-ext-row">
            <label className="ctl-ext-field" title={t(M.s7RackTitle)}>
              {t(M.s7Rack)}
              <CommitField value={String(settings.s7Rack)} numeric disabled={locked} commit={whole('s7Rack', 0, 7)} testId={`${tid}-s7-rack`} />
            </label>
            <label className="ctl-ext-field" title={t(M.s7SlotTitle)}>
              {t(M.s7Slot)}
              <CommitField value={String(settings.s7Slot)} numeric disabled={locked} commit={whole('s7Slot', 0, 31)} testId={`${tid}-s7-slot`} />
            </label>
          </div>
          <div className="ctl-dim" data-testid={`${tid}-s7-putget`}>
            {t(M.s7PutGet)}
          </div>
        </>
      )}
      {slmp && (
        <>
          <div className="ctl-ext-row">
            <label className="ctl-ext-field" title={t(M.slmpHostTitle)}>
              {t(M.plcHost)}
              <CommitField
                value={settings.slmpHost}
                wide
                disabled={locked}
                commit={(text) => {
                  if (!isPlcHost(text)) return false
                  update({ slmpHost: text })
                  return true
                }}
                testId={`${tid}-slmp-host`}
              />
            </label>
            <label className="ctl-ext-field" title={t(M.slmpPortTitle)}>
              {t(M.port)}
              <CommitField value={String(settings.slmpPort)} numeric disabled={locked} commit={whole('slmpPort', 1, 65535)} testId={`${tid}-slmp-port`} />
            </label>
          </div>
          <div className="ctl-warn" data-testid={`${tid}-slmp-unsecured`} title={t(M.slmpUnsecuredTitle)}>
            {t(M.slmpUnsecured)}
          </div>
          <div className="ctl-dim" data-testid={`${tid}-slmp-devices`}>
            {t(M.slmpDevices)}
          </div>
        </>
      )}
      {!byName &&
        !s7 &&
        !slmp &&
        (poll ? (
          <>
            <div className="ctl-ext-row">
              <label className="ctl-ext-field" title={t(M.plcHostTitle)}>
                {t(M.plcHost)}
                <CommitField
                  value={settings.plcHost}
                  wide
                  disabled={locked}
                  commit={(text) => {
                    if (!isPlcHost(text)) return false
                    update({ plcHost: text })
                    return true
                  }}
                  testId={`${tid}-host`}
                />
              </label>
              <label className="ctl-ext-field" title={t(M.plcPortTitle)}>
                {t(M.port)}
                <CommitField value={String(settings.plcPort)} numeric disabled={locked} commit={whole('plcPort', 1, 65535)} testId={`${tid}-plc-port`} />
              </label>
            </div>
            <div className="ctl-ext-row">
              <label className="ctl-ext-field" title={t(M.inputBaseTitle)}>
                {t(M.inputBase)}
                <CommitField value={String(settings.inputBase)} numeric disabled={locked} commit={whole('inputBase', 0, 65535)} testId={`${tid}-input-base`} />
              </label>
              <label className="ctl-ext-field" title={t(M.outputBaseTitle)}>
                {t(M.outputBase)}
                <CommitField value={String(settings.outputBase)} numeric disabled={locked} commit={whole('outputBase', 0, 65535)} testId={`${tid}-output-base`} />
              </label>
            </div>
          </>
        ) : (
          <div className="ctl-ext-row">
            <label className="ctl-ext-field">
              {t(M.port)}
              <CommitField value={String(settings.port)} numeric disabled={locked} commit={whole('port', 1, 65535)} testId={`${tid}-port`} />
            </label>
            <label className="ctl-ext-field" title={t(M.networkTitle)}>
              <input type="checkbox" checked={settings.network} disabled={locked} onChange={(e) => update({ network: e.target.checked })} data-testid={`${tid}-network`} />
              {t(M.network)}
            </label>
          </div>
        ))}
      <div className={status.state === 'failed' || (running && status.stale) ? 'ctl-problem' : 'ctl-dim'} data-testid={`${tid}-status`} role="status">
        {statusLine(status, running, settings, beside)}
      </div>
      {hint && (
        <div className="ctl-dim" data-testid={`${tid}-hint`}>
          {hint}
        </div>
      )}
      <div className="ctl-ext-points" data-testid={`${tid}-points`}>
        {points.length === 0 ? (
          <span className="ctl-dim">
            {t(byName ? (eip ? M.noTagEip : M.noTagByName) : slmp ? M.noAddressSlmp : M.noAddress)}
          </span>
        ) : (
          points.map((line) => (
            <div key={line} className="ctl-ext-point">
              {line}
            </div>
          ))
        )}
      </div>
      {problems.map((p) => (
        <div key={p} className="ctl-problem" data-testid={`${tid}-problem`}>
          {p}
        </div>
      ))}
    </div>
  )
}
