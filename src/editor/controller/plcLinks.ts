// The EditorController's (../controller.ts) links to PLCs outside the app: an external PLC
// over Modbus / S7 / OPC UA / EtherNet/IP / ADS, its tag browse, and the simulated PLC's OPC UA server.
// Besides the default controller's link there is one per named controller (`Cell2::%IX0.0`, core/io/controllerTag.ts),
// each on a link of its own in the desktop shell (links/linkHosts.ts), and each carrying only its own tags.
// The link's module, session, status, tag list and the server are this area's own state (PlcLinkState, held by
// the controller); the attached program's state (ProgramState) is passed where a link reads or hands back
// ownership, and the store, sim and the injected hosts come in as narrow dependencies (PlcLinkDeps).

import { partsForController } from '../../core/io/controllerTag'
import type { TagValue } from '../../plc'
import type { PartInstance } from '../../core/types'
import type { BoxFrame } from '../../core/frame'
import type { SimClient } from '../../sim/client'
import { controllerFor, controllerRuns, LocalPlcLink, runnableSource } from '../../plc'
// deep import: the wiring check is a checker, not part of the runtime PLC surface the barrel exposes
import { checkWiring } from '../../plc/wiring'
// the link's sessions are loaded on use (loadExternalPlc): only what the first frame shows is static
import { adsEndpoint, eipEndpoint, eipTarget, EXTERNAL_PLC_OFF, flattenFrameTags } from '../links/externalPlcStatus'
import type { ExternalPlcLink, ExternalPlcStatus, PlcTagList } from '../links/externalPlcStatus'
import { adsForLink, controllerLink, eipForLink, opcUaForLink, opcUaServerForLink, plcIoForLink } from '../links/linkHosts'
import { OPC_UA_SERVER_OFF, OpcUaServerSession, publishedVariables } from '../links/opcUaServer'
import type { OpcUaServerStatus, PublishedProgram } from '../links/opcUaServer'
import type { ExternalPlcSettings, PlcLinkSettings } from '../store/storePrefs'
import type { PlcSetup } from '../store/storePlcs'
import type { EditorStore } from '../store/store'
import { NO_PROGRAM, setDriven, setLinkDriven, setProgramStatus } from './program'
import type { ProgramState } from './program'
import type { EditorController } from '../controller'
import { overlayTable } from '../../core/watchTable'

export type ExternalPlcModule = typeof import('../links/externalPlc')

/** The links to PLCs outside the app: the external-PLC link's module and session, its tag browse, and the OPC UA server. */
export class PlcLinkState {
  // the external-PLC link's module, loaded on first use (loadExternalPlc) and warmed at startup when a link is on
  externalPlc: ExternalPlcModule | null = null
  externalPlcLoad: Promise<ExternalPlcModule> | null = null
  // the external-PLC link of the current run (editor/links/externalPlc.ts), and who watches its status
  externalSession: ExternalPlcLink | null = null
  externalStatus: ExternalPlcStatus = EXTERNAL_PLC_OFF
  // the named controllers' links of the current run, and each one's last status, kept after Stop
  readonly named: NamedSession[] = []
  readonly namedStatus = new Map<string, ExternalPlcStatus>()
  // every link's outputs as last written, together: one link's change is sent with the others' values, since the
  // worker holds what it is sent as the whole of what the links drive
  linkOut: Record<string, number | boolean> = {}
  readonly watchers = new Set<() => void>()
  // the PLC's tag names for the Inspector's tag picker: a run's last browse, kept after Stop, or a read while stopped
  plcTags: PlcTagList | null = null
  // the simulated PLC's OPC UA server (editor/links/opcUaServer.ts): up for as long as it is switched on, across runs
  uaServer: OpcUaServerSession | null = null
  uaServerSettings: ExternalPlcSettings | null = null
  // each simulated controller's own server, by controller name, with the settings it was opened on
  readonly namedUa = new Map<string, { session: OpcUaServerSession; key: string }>()
  /** the last value image built from the links (plcImage), and what it was built from: rebuilt only when one changes */
  image: { own: object | null; tags: object | undefined; out: object; value: Readonly<Record<string, TagValue>> } | null = null
  /** every named server stop still in flight: a server starts only once all are done, so a quick off and on again
   *  never asks for a port the old server still holds */
  namedUaStopped: Promise<void> = Promise.resolve()
}

/** A named controller's link in a run: the controller's name, and the link with its tags under the scene's names. */
export interface NamedSession {
  name: string
  link: ExternalPlcLink
}

/** what the links read: the document's link settings (store), the worker (sim), the latest frame and program watch,
 *  which Play this is, the hosts the shell (or a test) hands in, and the speed control Play with an external PLC resets to 1x */
export type PlcLinkDeps = Pick<
  EditorController,
  'store' | 'sim' | 'lastFrame' | 'plcWatch' | 'runSerial' | 'plcIoHost' | 'opcUaHost' | 'eipHost' | 'adsHost' | 'opcUaServerHost' | 'setTimeScale'
>

/** Tell whoever watches the links (the toolbar's link status, Controller Properties) that something changed. */
export function notifyExternal(l: PlcLinkState): void {
  for (const cb of l.watchers) cb()
}

/** The external-PLC link's sessions (editor/links/externalPlc.ts), out of the first frame because only a desktop run
 *  with a link uses them. One load, kept; a failed one is forgotten so the next use tries again. */
export function loadExternalPlc(l: PlcLinkState): Promise<ExternalPlcModule> {
  l.externalPlcLoad ??= import('../links/externalPlc').then(
    (m) => (l.externalPlc = m),
    (e: unknown) => {
      l.externalPlcLoad = null
      throw e
    },
  )
  return l.externalPlcLoad
}

/** Whether Play opens any link: the default controller runs on an external PLC, or a named one connects to one. */
export function anyLinkOn(settings: PlcSetup): boolean {
  return settings.enabled || settings.controllers.some((c) => c.enabled && c.runsOn === 'plc')
}

/**
 * Attach this run's external PLCs, now if the link's module is loaded (it is warmed at startup), else once it is.
 * The world stays held until then, as for any attach: true means the release is the load's to make, which it makes
 * whatever happens, and only for the run that asked (Stop and Play again while it loads start a world of their own).
 */
export function startExternalPlc(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps): boolean {
  if (l.externalPlc) {
    attachExternalPlc(l, p, ec, l.externalPlc)
    return false
  }
  const serial = ec.runSerial
  const current = (): boolean => serial === ec.runSerial && ec.store.getState().running
  void loadExternalPlc(l)
    .then(
      (m) => {
        if (current()) attachExternalPlc(l, p, ec, m)
      },
      (e: unknown) => {
        // the program here runs whatever the links do, so only a main link that took its place reports here
        if (current() && ec.store.getState().externalPlc.enabled) setProgramStatus(p, { ...NO_PROGRAM, warnings: [`The external PLC link could not load: ${e instanceof Error ? e.message : String(e)}`] })
      },
    )
    .catch((e: unknown) => console.error('[oip] external PLC attach failed', e))
    .finally(() => {
      if (current()) ec.sim.beginStepping()
    })
  return true
}

/** Read the default controller's PLC's tag names for the tag picker, over OPC UA, ADS or EtherNet/IP, while no run holds its link. */
export function readPlcTags(l: PlcLinkState, ec: PlcLinkDeps): void {
  const settings = ec.store.getState().externalPlc
  if (l.externalSession || l.plcTags?.state === 'reading') return
  const mayClose = (): boolean => l.externalSession === null
  const list = (protocol: PlcTagList['protocol'], endpoint: string, from: readonly string[] = []): PlcTagList => ({ protocol, endpoint, from, state: 'reading', names: [], groups: [], variables: [], truncated: false, error: null })
  const { adsHost: ads, eipHost: eip, opcUaHost: ua } = ec
  let reading: PlcTagList
  let read: (m: ExternalPlcModule) => Promise<PlcTagList>
  if (settings.mode === 'ads' && ads) {
    reading = list('ads', adsEndpoint(settings.adsNetId, settings.adsPort))
    read = (m) => m.readAdsTagList(ads, settings.adsNetId, settings.adsPort, mayClose)
  } else if (settings.mode === 'eip' && eip) {
    reading = list('eip', eipEndpoint(eipTarget(settings)))
    read = (m) => m.readEipTagList(eip, eipTarget(settings), mayClose)
  } else if (settings.mode === 'opcua' && ua) {
    reading = list('opcua', settings.opcUaEndpoint, settings.opcUaBrowseFrom)
    read = (m) => m.readOpcUaTagList(ua, settings.opcUaEndpoint, settings.opcUaBrowseFrom, mayClose)
  } else {
    return
  }
  l.plcTags = reading
  notifyExternal(l)
  void loadExternalPlc(l)
    .then(read)
    .then(
      (list) => {
        // a run that started meanwhile has taken the link over, and its browse is the one to keep
        if (l.plcTags === reading) l.plcTags = list
        notifyExternal(l)
      },
      (e: unknown) => {
        if (l.plcTags === reading) l.plcTags = { ...reading, state: 'failed', error: e instanceof Error ? e.message : String(e) }
        notifyExternal(l)
      },
    )
}

/** Keep what the run's OPC UA link browsed as the tag picker's list, once per browse. */
export function takeLinkBrowse(l: PlcLinkState): void {
  const s = l.externalSession
  // a run's session exists only once the module that made it has loaded
  const m = l.externalPlc
  if (!m || !(s instanceof m.ExternalPlcOpcUaSession) || !s.browsed) return
  if (l.plcTags?.state === 'ready' && l.plcTags.variables === s.browsed.variables) return
  l.plcTags = m.plcTagListOf(s.endpoint, s.from, s.browsed)
}

/**
 * Start, restart or stop the simulated PLC's OPC UA server to match its settings. Its own lifetime, not a
 * run's: a SCADA stays connected across Stop and Play, and sees the variables out of service in between.
 * Its status changes notify through {@link onExternalPlcStatus}, as the Controller Properties dialog reads both.
 */
export function syncOpcUaServer(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps): void {
  const settings = ec.store.getState().externalPlc
  const prev = l.uaServerSettings
  l.uaServerSettings = settings
  const host = ec.opcUaServerHost
  // only while the program runs here, as each other controller's server (syncNamedUaServers): a default controller on
  // an external PLC has no program in this app to publish, and Controller Properties hides the switch then
  const want = host !== null && settings.uaServer && !settings.enabled
  const same = prev !== null && prev.uaServer === settings.uaServer && prev.uaServerPort === settings.uaServerPort && prev.uaServerNetwork === settings.uaServerNetwork
  // each simulated controller's own server follows its own settings, whether or not the default one's changed
  syncNamedUaServers(l, p, ec)
  if (same && (l.uaServer !== null) === want) return notifyExternal(l)
  const old = l.uaServer
  l.uaServer = null
  const next = want
    ? new OpcUaServerSession(
        host,
        { port: settings.uaServerPort, network: settings.uaServerNetwork },
        (values) => {
          // a client's write reaches the program only while it runs here; the server refuses one otherwise
          if (p.plcAttached && ec.store.getState().running) ec.sim.writePlcVars(values)
        },
        () => notifyExternal(l),
      )
    : null
  l.uaServer = next
  // the old server lets go of the port before the new one asks for it
  void (old ? stopUaServer(old) : Promise.resolve()).then(() => {
    if (next === null || l.uaServer !== next) return notifyExternal(l)
    void next.start()
    if (p.uaProgram && p.plcAttached) publishToUaServer(l, ec.store, p.uaProgram)
    else publishDocumentProgram(l, ec.store)
    next.update(ec.plcWatch, p.plcAttached)
  }).catch((e: unknown) => console.warn('[opcua] starting the server failed:', e))
  notifyExternal(l)
}

/**
 * Stop a server, resolving even when the stop fails: a rejection kept in the stop chain would keep every later
 * server from starting.
 */
function stopUaServer(server: OpcUaServerSession): Promise<void> {
  return server.stop().catch((e: unknown) => console.warn('[opcua] stopping the server failed:', e))
}

/**
 * Each simulated controller's own OPC UA server (Controller Properties, its row), as each PLC on a line has a server
 * of its own: on the shell's link number its PLC link would have (links/linkHosts.ts), and publishing its own program.
 * A server whose port or network setting changed is closed before the new one asks for the port.
 */
function syncNamedUaServers(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps): void {
  const host = ec.opcUaServerHost
  const want = new Map<string, { link: number; port: number; network: boolean; key: string }>()
  if (host) {
    ec.store.getState().externalPlc.controllers.forEach((c, i) => {
      // a controller Play does not run publishes nothing that moves, so its server is off with it
      if (c.runsOn === 'app' && c.enabled && c.uaServer) want.set(c.name, { link: i + 1, port: c.uaServerPort, network: c.uaServerNetwork, key: `${i + 1}:${c.uaServerPort}:${c.uaServerNetwork}` })
    })
  }
  const stopping: Promise<void>[] = []
  for (const [name, s] of [...l.namedUa]) {
    if (want.get(name)?.key === s.key) continue
    l.namedUa.delete(name)
    stopping.push(stopUaServer(s.session))
  }
  if (stopping.length > 0) l.namedUaStopped = Promise.all([l.namedUaStopped, ...stopping]).then(() => {})
  const stopped = l.namedUaStopped
  for (const [name, w] of want) {
    if (l.namedUa.has(name) || !host) continue
    const session = new OpcUaServerSession(
      opcUaServerForLink(host, w.link),
      { port: w.port, network: w.network },
      (values) => {
        // as the default controller's: a write reaches the program only while it runs here
        if (p.plcAttached && ec.store.getState().running) ec.sim.writePlcVars(values)
      },
      () => notifyExternal(l),
    )
    l.namedUa.set(name, { session, key: w.key })
    void stopped.then(() => {
      if (l.namedUa.get(name)?.session !== session) return
      void session.start()
      publishNamedUaServers(l, p, ec)
      session.update(ec.plcWatch, p.plcAttached)
    }).catch((e: unknown) => console.warn('[opcua] starting the server failed:', e))
  }
}

/**
 * What each simulated controller's server publishes: its running program while one is attached, else its share of the
 * document's program as it compiles, so a SCADA can browse it before Play. An input the scene feeds is read-only.
 */
export function publishNamedUaServers(l: PlcLinkState, p: ProgramState, ec: Pick<PlcLinkDeps, 'store'>): void {
  if (l.namedUa.size === 0) return
  const s = ec.store.getState()
  for (const [name, entry] of l.namedUa) {
    let program: PublishedProgram | null = (p.plcAttached ? p.runs.find((r) => r.controller === name)?.declared : undefined) ?? null
    if (!program) {
      const run = controllerRuns(s.stProgram, s.controller, s.stScanMs, { defaultName: s.externalPlc.mainName, simulated: [name] }).find((r) => r.controller === name)
      try {
        program = run ? new LocalPlcLink(runnableSource(run.source, run.table)) : null
      } catch {
        // a program that does not compile publishes nothing new; Play reports why
      }
    }
    if (!program) continue
    const feeds = new Set(checkWiring(partsForController(s.scene.parts, name)).tags.filter((t) => t.writers.length > 0).map((t) => t.name))
    entry.session.publish(publishedVariables(program, feeds))
  }
}

/** Hand every server the program's variables as they stand, and whether a program runs here (null, false: out of service). */
export function updateUaServers(l: PlcLinkState, watch: Readonly<Record<string, TagValue>> | null, live: boolean): void {
  l.uaServer?.update(watch, live)
  for (const { session } of l.namedUa.values()) session.update(watch, live)
}

/** A simulated controller's server's state, or off. */
export function namedUaServerStatus(l: PlcLinkState, name: string): OpcUaServerStatus {
  return l.namedUa.get(name)?.session.status() ?? OPC_UA_SERVER_OFF
}

/** Stop every server, the window closing. */
export function stopUaServers(l: PlcLinkState): void {
  void l.uaServer?.stop()
  l.uaServer = null
  for (const { session } of l.namedUa.values()) void session.stop()
  l.namedUa.clear()
}

/** Publish a program's variables, with what the scene feeds read-only (editor/links/opcUaServer.ts publishedVariables). */
export function publishToUaServer(l: PlcLinkState, store: EditorStore, program: PublishedProgram): void {
  if (!l.uaServer) return
  const feeds = new Set(checkWiring(store.getState().scene.parts).tags.filter((t) => t.writers.length > 0).map((t) => t.name))
  l.uaServer.publish(publishedVariables(program, feeds))
}

/** While stopped, the server publishes the document's program as it compiles, so a SCADA can browse it before Play. */
export function publishDocumentProgram(l: PlcLinkState, store: EditorStore): void {
  const { stProgram, controller, stScanMs } = store.getState()
  try {
    publishToUaServer(l, store, new LocalPlcLink(runnableSource(stProgram, controllerFor(stProgram, controller, stScanMs))))
  } catch {
    // a program that does not compile publishes nothing new; Play reports why
  }
}

/**
 * Play with an external PLC: carry the scene's I/O addresses over Modbus instead of running the program
 * in-process - serving them to a PLC that polls, or polling a PLC that serves, as Controller Properties
 * says. The PLC drives what it writes (ctx.tagDriven, as an attached program's outputs do), and the program
 * here is not attached, which the PLC panel says. The PLC keeps wall-clock time, so Play starts at 1x; another
 * speed is allowed afterwards, and the toolbar's speed button warns that the PLC's timing no longer matches.
 */
/**
 * One controller's link, from its settings and the parts as that controller sees them (core/io/controllerTag.ts
 * partsForController), on the shell's link number `link`. Null when this surface has no host for the protocol.
 */
function openLink(
  m: ExternalPlcModule,
  ec: PlcLinkDeps,
  settings: PlcLinkSettings,
  parts: readonly PartInstance[],
  link: number,
  onChange: () => void,
): { session: ExternalPlcLink; points: number } | null {
  if (!ec.plcIoHost) return null
  // Watch only: nothing written to the PLC, every point read from it (externalPlc.ts watchedPoints); Modbus cannot
  if (m.watchRefusal(settings)) return null
  const w = <P extends { dir: 'toPlc' | 'fromPlc' }>(points: P[]): P[] => (settings.watch ? m.watchedPoints(points) : points)
  const host = plcIoForLink(ec.plcIoHost, link)
  if (settings.mode === 'ads') {
    if (!ec.adsHost) return null
    const { points, problems } = m.deriveAdsPoints(parts)
    return { session: m.adsLink(adsForLink(ec.adsHost, link), settings.adsNetId, settings.adsPort, w(points), problems, onChange), points: points.length }
  }
  if (settings.mode === 'eip') {
    if (!ec.eipHost) return null
    const { points, problems } = m.deriveEipPoints(parts)
    return { session: new m.ExternalPlcEipSession(eipForLink(ec.eipHost, link), eipTarget(settings), w(points), problems, onChange), points: points.length }
  }
  if (settings.mode === 'opcua') {
    if (!ec.opcUaHost) return null
    const { points, problems } = m.deriveOpcUaPoints(parts)
    return { session: new m.ExternalPlcOpcUaSession(opcUaForLink(ec.opcUaHost, link), settings.opcUaEndpoint, w(points), problems, onChange, settings.opcUaBrowseFrom), points: points.length }
  }
  if (settings.mode === 's7') {
    const { io, problems } = m.deriveS7Io(parts, settings)
    return { session: m.s7Link(host, { ...io, points: w(io.points) }, problems, onChange), points: io.points.length }
  }
  if (settings.mode === 'slmp') {
    const { io, problems } = m.deriveSlmpIo(parts, settings)
    return { session: m.slmpLink(host, { ...io, points: w(io.points) }, problems, onChange), points: io.points.length }
  }
  if (settings.mode === 'poll') {
    const { io, problems } = m.deriveClientIo(parts, settings)
    return { session: new m.ExternalPlcClientSession(host, io, problems, onChange), points: io.points.length }
  }
  const { io, problems } = m.deriveExternalIo(parts, settings)
  return { session: new m.ExternalPlcSession(host, io, problems, onChange), points: io.points.length }
}

export function attachExternalPlc(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps, m: ExternalPlcModule): void {
  const s = ec.store.getState()
  if (!ec.plcIoHost) return
  if (s.timeScale !== 1) ec.setTimeScale(1)
  const onChange = (): void => {
    takeLinkBrowse(l)
    notifyExternal(l)
  }
  if (s.externalPlc.enabled) attachMainLink(l, p, ec, m, onChange)
  attachNamedLinks(l, p, ec, m, onChange)
  notifyExternal(l)
}

/**
 * The named controllers' links: each connected one carries the tags that name it, on link number 1, 2, ... in the
 * order Controller Properties lists them. What they drive joins what the default controller drives.
 */
function attachNamedLinks(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps, m: ExternalPlcModule, onChange: () => void): void {
  const s = ec.store.getState()
  const shipDriven = (): void => setLinkDriven(p, ec.sim, l.named.filter((n) => n.link.status().state !== 'failed').flatMap((n) => n.link.driven))
  s.externalPlc.controllers.forEach((c, i) => {
    // one the simulator runs has no link: its program runs in the worker (program.ts attachProgram)
    if (!c.enabled || c.runsOn === 'app') return
    const opened = openLink(m, ec, c, partsForController(s.scene.parts, c.name), i + 1, onChange)
    if (!opened) return
    const named: NamedSession = { name: c.name, link: controllerLink(opened.session, c.name) }
    l.named.push(named)
    void named.link.start(flattenFrameTags(ec.lastFrame?.tags)).then(() => {
      // a port that would not open leaves nothing driving its devices: hand them back
      if (l.named.includes(named) && named.link.status().state === 'failed') shipDriven()
      notifyExternal(l)
    }).catch((e: unknown) => console.error('[oip] external PLC attach failed', e))
  })
  shipDriven()
}

/** The default controller's link: the PLC that runs the tags with no controller name, in place of the program here. */
function attachMainLink(l: PlcLinkState, p: ProgramState, ec: PlcLinkDeps, m: ExternalPlcModule, onChange: () => void): void {
  const s = ec.store.getState()
  const refused = m.watchRefusal(s.externalPlc)
  if (refused) {
    if (!p.plcAttached) setProgramStatus(p, { ...NO_PROGRAM, warnings: [refused] })
    return
  }
  const opened = openLink(m, ec, s.externalPlc, partsForController(s.scene.parts, null), 0, onChange)
  if (!opened) return
  const { session, points } = opened
  l.externalSession = session
  setDriven(p, ec.sim, session.driven)
  // with other controllers running here the attach owns the status line, and already says this link runs the default
  // controller (program.ts DEFAULT_ON_PLC); replacing it would hide their program's status
  if (!p.plcAttached) setProgramStatus(p, {
    ...NO_PROGRAM,
    warnings: [
      points > 0
        ? `An external PLC runs this project (Controller Properties), so the program here is not attached.`
        : s.externalPlc.mode === 'opcua' || s.externalPlc.mode === 'eip' || s.externalPlc.mode === 'ads'
          ? `An external PLC runs this project over ${s.externalPlc.mode === 'eip' ? 'EtherNet/IP' : s.externalPlc.mode === 'ads' ? 'ADS' : 'OPC UA'}, but no part has a PLC tag (the PLC's name for it, like ${s.externalPlc.mode === 'eip' ? 'Eye' : 'MAIN.Eye'}), so it has nothing to read or drive.`
          : s.externalPlc.mode === 'slmp'
            ? 'An external PLC runs this project, but no part is wired to a device address (a PLC tag like D100, M10, X1A or Y0), so it has nothing to read or drive.'
            : 'An external PLC runs this project, but no part is wired to an I/O address (a PLC tag like %IX0.0), so it has nothing to read or drive.',
    ],
  })
  void session.start(flattenFrameTags(ec.lastFrame?.tags)).then(() => {
    // a port that would not open leaves nothing driving the devices: hand them back
    if (l.externalSession === session && session.status().state === 'failed') {
      setDriven(p, ec.sim, [])
    }
    notifyExternal(l)
  }).catch((e: unknown) => console.error('[oip] external PLC attach failed', e))
}

/** One sim frame's I/O on every link of the run: the parts' tags out, and what the PLCs drive back into the sim. */
export function exchangeFrame(l: PlcLinkState, sim: Pick<SimClient, 'setTags'>, tags: BoxFrame['tags']): void {
  if (!l.externalSession && l.named.length === 0) return
  const out = exchangeLinks(l, flattenFrameTags(tags))
  if (out) sim.setTags(out)
}

/**
 * One frame's exchange on every link of the run: the parts' tags in, and when any PLC wrote something new, what every
 * link drives, as last written (null when nothing changed).
 */
export function exchangeLinks(l: PlcLinkState, simTags: Readonly<Record<string, number | boolean>>): Record<string, number | boolean> | null {
  let changed = false
  const main = l.externalSession ? l.externalSession.exchange(simTags) : null
  if (main) {
    l.linkOut = { ...l.linkOut, ...main }
    changed = true
  }
  for (const n of l.named) {
    const wrote = n.link.exchange(simTags)
    if (!wrote) continue
    l.linkOut = { ...l.linkOut, ...wrote }
    changed = true
  }
  return changed ? l.linkOut : null
}

/** A named controller's link state: its run's, or its last one, kept after Stop. */
export function namedStatus(l: PlcLinkState, name: string): ExternalPlcStatus {
  const live = l.named.find((n) => n.name === name)
  return live ? live.link.status() : (l.namedStatus.get(name) ?? EXTERNAL_PLC_OFF)
}

/**
 * The PLC values to watch: the program here's own image, joined by what the links to PLCs outside the app carry, under
 * the scene's tag names. A link carries what the parts send (the frame's tags) and what its PLC drives back (linkOut),
 * so a project run by an external PLC has values for Watch, a note's counter and anyone following the run, as one run
 * by the program here does. Null when there is neither. Rebuilt only when the image, the frame's tags or the links'
 * outputs change, since it is read every frame.
 */
export function plcImage(l: PlcLinkState, own: Readonly<Record<string, TagValue>> | null, frame: BoxFrame | null): Readonly<Record<string, TagValue>> | null {
  if (!l.externalSession && l.named.length === 0) return own
  const tags = frame?.tags
  const c = l.image
  if (c && c.own === own && c.tags === tags && c.out === l.linkOut) return c.value
  // the program's own table is laid over the links' values without copying it: it can be half a million values
  const beside: Record<string, TagValue> = { ...flattenFrameTags(tags), ...l.linkOut }
  const value = own ? overlayTable(beside, own) : beside
  l.image = { own, tags, out: l.linkOut, value }
  return value
}

/** Close the external-PLC links of this run, keeping their last status for the dock to show. */
export function detachExternalPlc(l: PlcLinkState): void {
  l.linkOut = {}
  const stops: Promise<void>[] = []
  for (const n of l.named.splice(0)) {
    l.namedStatus.set(n.name, { ...n.link.status(), state: 'off', masters: [] })
    stops.push(n.link.stop())
  }
  const session = l.externalSession
  if (session) {
    l.externalSession = null
    l.externalStatus = { ...session.status(), state: 'off', masters: [] }
    stops.push(session.stop())
  }
  if (stops.length > 0) {
    void Promise.all(stops)
      .then(() => notifyExternal(l))
      .catch((e: unknown) => console.warn('[oip] stopping the external PLC links failed', e))
  }
}
