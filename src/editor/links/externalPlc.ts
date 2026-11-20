// An external PLC driving the running scene: the editor side of the link.
//
// The scene is wired to I/O points (a part's tag is `%IX100.0`, core/io/iecAddress.ts), the Modbus table
// follows from those addresses (core/io/externalIo.ts) - or, over OPC UA / EtherNet/IP, the tag's name is the
// point - and one session carries it:
//
//   ExternalPlcSession        the simulator serves (plc/link/modbusServer.ts) and the PLC's master polls it
//   ExternalPlcClientSession  the simulator polls the PLC's Modbus server (plc/link/modbusClient.ts)
//   ExternalPlcOpcUaSession   tags read/written by name on the PLC's OPC UA server (core/io/opcUa.ts)
//   ExternalPlcEipSession     a Logix controller's tags over EtherNet/IP, by name (core/io/eip.ts; libplctag)
//   ExternalPlcS7Session      an S7-1200/1500 CPU's memory over PUT/GET, at the scene's addresses
//                             (core/io/s7Io.ts, plc/link/s7Client.ts; editor/links/s7Link.ts, loaded on Play as a DeferredLink)
//   ExternalPlcSlmpSession    a MELSEC CPU's devices over SLMP, at the scene's addresses
//                             (core/io/slmpIo.ts, plc/link/slmpClient.ts; editor/links/slmpLink.ts, loaded on Play as a DeferredLink)
//
// Each sim frame, the parts' tag writes become the PLC's inputs and what the PLC wrote goes to
// SimClient.setTags for the parts' next step.
//
// It runs on the main thread, not in the sim worker's step loop: a real PLC scans on its own clock, so its
// I/O is exchanged per frame like a fieldbus (src/plc/DEVICE-IO.md). None of it is deterministic, which is
// why a project test always runs the in-process program instead.
//
// The socket is the desktop shell's (apps/desktop/plcIo.cjs); in a browser tab the host is null and the
// mode is not offered. Tests pass their own host.

import { canWatch } from '../../core/scene/scenePlcs'
import { clientDrivenTags, externalDrivenTags, modbusClientFromTags, modbusServerFromTags, registerImagePointWhere, registerWords } from '../../core/io/externalIo'
import type { ClientIoPoint, ExternalIo, ExternalIoPoint, ModbusClientIo, TagSignal } from '../../core/io/externalIo'
import { bindEipPoint, cipTypeName, eipListingFailure, eipNothingAnswered, eipPointsFromTags, eipStatusMessage, eipTagNames, eipUnreachable, eipVariableGroups, fromEipValue, toEipValue } from '../../core/io/eip'
import type { EipBinding, EipPoint, EipTarget } from '../../core/io/eip'
import { bindOpcUaPoints, builtinName, discoveryServerMessage, fromOpcUaValue, isOpcUaNodeId, matchOpcUaTag, opcUaBrowseRoot, opcUaPointsFromTags, opcUaTagNames, opcUaVariableGroups, toOpcUaValue } from '../../core/io/opcUa'
import type { OpcUaBinding, OpcUaBrowseRoot, OpcUaPoint, OpcUaVariable } from '../../core/io/opcUa'
import { adsPointsFromTags, adsRouteText, adsSymbolGroups, adsTagNames } from '../../core/io/ads'
import type { AdsBinding, AdsPoint } from '../../core/io/ads'
import { describeS7Point, s7ClientFromTags, s7DrivenTags, s7Endpoint } from '../../core/io/s7Io'
import type { S7ClientIo } from '../../core/io/s7Io'
import { describeSlmpPoint, slmpClientFromTags, slmpDrivenTags, slmpEndpoint } from '../../core/io/slmpIo'
import type { SlmpClientIo } from '../../core/io/slmpIo'
import type { PartInstance } from '../../core/types'
import { ModbusClientStream, ModbusPoller } from '../../plc/link/modbusClient'
import { describeStats, ModbusServerIo } from '../../plc/link/modbusServer'
import type { ModbusStream } from '../../plc/link/modbusServer'
import type { TagValue } from '../../plc/types'
import { checkWiring } from '../../plc/wiring'
import type { ExternalPlcSettings, PlcLinkSettings } from '../store/storePrefs'
import { CLIENT_ANSWER_MS, CLIENT_POLL_MS, CLIENT_RETRY_MS, NamedLink, NOT_CONNECTED, POLL_TIMEOUT_MS, SocketLink } from './clientLink'

export { CLIENT_ANSWER_MS, CLIENT_POLL_MS, CLIENT_RETRY_MS, POLL_TIMEOUT_MS }
export * from './externalPlcStatus'
import { adsEndpoint, eipEndpoint, EXTERNAL_PLC_OFF } from './externalPlcStatus'
import type { AdsHost, EipHost, ExternalPlcLink, ExternalPlcStatus, OpcUaHost, PlcIoHost, PlcTagList } from './externalPlcStatus'

export type { ExternalPlcSettings } from '../store/storePrefs'

/** The tags a scene's parts carry, with their types, and the wiring check's address errors. */
function sceneSignals(parts: readonly PartInstance[]): { tags: TagSignal[]; problems: string[] } {
  const wiring = checkWiring(parts as Parameters<typeof checkWiring>[0])
  return {
    // the tag's type picks how a 32-bit point carries it: a whole number as DINT, anything else as REAL
    tags: wiring.tags.map((t) => ({ name: t.name, type: t.type })),
    problems: wiring.problems.filter((p) => p.kind === 'address').map((p) => p.message),
  }
}

/**
 * The Modbus table a scene makes when the simulator serves: every part tag that is an input or output
 * address, at the point its address gives it. Problems are the wiring check's address errors plus any
 * address that cannot travel over Modbus yet; a named tag is not one (only the in-process program reads names).
 */
export function deriveExternalIo(parts: readonly PartInstance[], settings: Pick<ExternalPlcSettings, 'port' | 'network'>): { io: ExternalIo; problems: string[] } {
  const scene = sceneSignals(parts)
  const derived = modbusServerFromTags({ host: settings.network ? '0.0.0.0' : '127.0.0.1', port: settings.port }, scene.tags)
  return { io: derived.io, problems: [...scene.problems, ...derived.problems.map((p) => `${p.tag}: ${p.message}`)] }
}

/** The table a scene makes when the simulator polls a PLC's server device: each address in its register image. */
export function deriveClientIo(parts: readonly PartInstance[], settings: Pick<ExternalPlcSettings, 'plcHost' | 'plcPort' | 'inputBase' | 'outputBase'>): { io: ModbusClientIo; problems: string[] } {
  const scene = sceneSignals(parts)
  const derived = modbusClientFromTags({ host: settings.plcHost, port: settings.plcPort, base: { input: settings.inputBase, output: settings.outputBase } }, scene.tags)
  return { io: derived.io, problems: [...scene.problems, ...derived.problems.map((p) => `${p.tag}: ${p.message}`)] }
}

/**
 * The table a scene makes for an S7 CPU: every %I, %Q and %M address, and every data block address, at its own bytes (core/io/s7Io.ts). Each
 * tag carries how many parts write it, which is what decides an M tag's direction.
 */
export function deriveS7Io(parts: readonly PartInstance[], settings: Pick<ExternalPlcSettings, 's7Host' | 's7Port' | 's7Rack' | 's7Slot'>): { io: S7ClientIo; problems: string[] } {
  const wiring = checkWiring(parts as Parameters<typeof checkWiring>[0])
  const tags = wiring.tags.map((t) => ({ name: t.name, type: t.type, writers: t.writers.length }))
  const derived = s7ClientFromTags({ host: settings.s7Host, port: settings.s7Port, rack: settings.s7Rack, slot: settings.s7Slot }, tags)
  const problems = wiring.problems.filter((p) => p.kind === 'address').map((p) => p.message)
  return { io: derived.io, problems: [...problems, ...derived.problems.map((p) => `${p.tag}: ${p.message}`)] }
}

/**
 * The table a scene makes for a MELSEC CPU over SLMP: every X, Y, M and D tag at its device (core/io/slmpIo.ts).
 * Each tag carries how many parts write it, which is what decides a Y, M or D tag's direction.
 */
export function deriveSlmpIo(parts: readonly PartInstance[], settings: Pick<ExternalPlcSettings, 'slmpHost' | 'slmpPort'>): { io: SlmpClientIo; problems: string[] } {
  const wiring = checkWiring(parts as Parameters<typeof checkWiring>[0])
  const tags = wiring.tags.map((t) => ({ name: t.name, type: t.type, writers: t.writers.length }))
  const derived = slmpClientFromTags({ host: settings.slmpHost, port: settings.slmpPort }, tags)
  const problems = wiring.problems.filter((p) => p.kind === 'address').map((p) => p.message)
  return { io: derived.io, problems: [...problems, ...derived.problems.map((p) => `${p.tag}: ${p.message}`)] }
}

/** The tags a scene carries over OPC UA: every tag a part is wired to by name, written or read by the PLC. */
export function deriveOpcUaPoints(parts: readonly PartInstance[]): { points: OpcUaPoint[]; problems: string[] } {
  const wiring = checkWiring(parts as Parameters<typeof checkWiring>[0])
  return opcUaPointsFromTags(wiring.tags)
}

/** "Eye  written to the PLC  BOOL": an OPC UA point before its node is found. */
export function describeOpcUaPoint(p: OpcUaPoint): string {
  return `${p.tag}  ${p.dir === 'toPlc' ? 'written to the PLC' : 'read from the PLC'}${p.type ? `  ${p.type}` : ''}`
}

/** "Eye  Main.Eye  Boolean": an OPC UA point bound to the node it found. */
export function describeOpcUaBinding(b: OpcUaBinding): string {
  return `${b.tag}  ${b.path.join('.')}  ${builtinName(b.builtin)}`
}

/** The tags a scene carries over EtherNet/IP: every tag a part is wired to by name, written or read by the controller. */
export function deriveEipPoints(parts: readonly PartInstance[]): { points: EipPoint[]; problems: string[] } {
  const wiring = checkWiring(parts as Parameters<typeof checkWiring>[0])
  return eipPointsFromTags(wiring.tags)
}

/** "Eye  written to the PLC  BOOL": an EtherNet/IP point, with the controller's own type once it has answered. */
export function describeEipPoint(p: EipPoint | EipBinding): string {
  const type = 'cip' in p ? `${cipTypeName(p.cip)}${p.bit ? ' bit' : ''}` : p.type
  return `${p.tag}  ${p.dir === 'toPlc' ? 'written to the PLC' : 'read from the PLC'}${type ? `  ${type}` : ''}`
}

/** The tags a scene carries over ADS: every tag a part is wired to by name, written or read by the PLC. */
export function deriveAdsPoints(parts: readonly PartInstance[]): { points: AdsPoint[]; problems: string[] } {
  const wiring = checkWiring(parts as Parameters<typeof checkWiring>[0])
  return adsPointsFromTags(wiring.tags)
}

/** "MAIN.Eye  written to the PLC  BOOL": an ADS point, with the runtime's own type once it has answered. */
export function describeAdsPoint(p: AdsPoint | AdsBinding): string {
  const type = 'typeName' in p ? p.typeName : p.type
  return `${p.tag}  ${p.dir === 'toPlc' ? 'written to the PLC' : 'read from the PLC'}${type ? `  ${type}` : ''}`
}

/**
 * Watch only (ScenePlc.watch): every point read from the PLC, the ones parts write included, and none written. A
 * sensor's tag is then the PLC's, so a part that shows what drives its tag (ctx.tagDriven) shows the real one.
 */
export function watchedPoints<P extends { dir: 'toPlc' | 'fromPlc' }>(points: readonly P[]): P[] {
  return points.map((p) => (p.dir === 'fromPlc' ? p : { ...p, dir: 'fromPlc' }))
}

/** Why a link cannot watch, or null when it can: over Modbus the simulator cannot read what it would write. */
export function watchRefusal(settings: Pick<PlcLinkSettings, 'mode' | 'watch'>): string | null {
  if (!settings.watch || canWatch(settings.mode)) return null
  return "Watch only does not work over Modbus, where the simulator cannot read the PLC's inputs, so nothing is connected. Choose OPC UA, EtherNet/IP, S7, SLMP or ADS to watch this PLC."
}

/** What Play would carry with these settings, as the dock lists it before Play. */
export function plannedLink(parts: readonly PartInstance[], settings: PlcLinkSettings): { points: string[]; problems: string[] } {
  const refused = watchRefusal(settings)
  if (refused) return { points: [], problems: [refused] }
  const w = <P extends { dir: 'toPlc' | 'fromPlc' }>(points: P[]): P[] => (settings.watch ? watchedPoints(points) : points)
  if (settings.mode === 'ads') {
    const { points, problems } = deriveAdsPoints(parts)
    return { points: w(points).map(describeAdsPoint), problems }
  }
  if (settings.mode === 'eip') {
    const { points, problems } = deriveEipPoints(parts)
    return { points: w(points).map(describeEipPoint), problems }
  }
  if (settings.mode === 'opcua') {
    const { points, problems } = deriveOpcUaPoints(parts)
    return { points: w(points).map(describeOpcUaPoint), problems }
  }
  if (settings.mode === 's7') {
    const { io, problems } = deriveS7Io(parts, settings)
    return { points: w(io.points).map(describeS7Point), problems }
  }
  if (settings.mode === 'slmp') {
    const { io, problems } = deriveSlmpIo(parts, settings)
    return { points: w(io.points).map(describeSlmpPoint), problems }
  }
  if (settings.mode === 'poll') {
    const { io, problems } = deriveClientIo(parts, settings)
    return { points: io.points.map(describeClientPoint), problems }
  }
  const { io, problems } = deriveExternalIo(parts, settings)
  return { points: io.points.map(describePoint), problems }
}

/** The function codes a master writes with: single coil, single register, multiple coils, multiple registers. */
const MODBUS_WRITE_FCS = [0x05, 0x06, 0x0f, 0x10] as const

/** One run's link when the simulator serves: open while the sim runs with an external PLC, closed on Stop. */
export class ExternalPlcSession implements ExternalPlcLink {
  readonly io: ModbusServerIo
  readonly driven: string[]
  private readonly streams = new Map<number, ModbusStream>()
  private readonly masters = new Map<number, string>()
  private readonly unsubscribe: (() => void)[] = []
  private lastOut = ''
  private state: ExternalPlcStatus['state'] = 'starting'
  private error: string | null = null
  private closed = false
  /** when a request was last served, so a PLC that stops answering can be told from one that is idle */
  private lastRequestAt: number | null = null
  private stale = false

  constructor(
    private readonly host: PlcIoHost,
    io: ExternalIo,
    private readonly problems: string[],
    private readonly onChange: () => void,
    /** the clock the watchdog reads; wall-clock, because the PLC polls on its own */
    private readonly now: () => number = () => Date.now(),
  ) {
    this.io = new ModbusServerIo(io)
    this.driven = externalDrivenTags(io)
  }

  /** Listen, with the scene's tags as they stand already in the image, so the PLC's first poll reads the
   *  real sensors rather than zeros (a latching rung would otherwise latch off on its first scan). */
  async start(initial: Readonly<Record<string, TagValue>>): Promise<void> {
    this.io.writeSimTags(initial)
    this.unsubscribe.push(
      this.host.onConnection((e) => {
        if (e.open) {
          this.streams.set(e.id, this.io.connection())
          this.masters.set(e.id, e.remote)
        } else {
          this.streams.delete(e.id)
          this.masters.delete(e.id)
        }
        this.onChange()
      }),
      this.host.onData((e) => {
        const stream = this.streams.get(e.id)
        if (!stream) return
        const replies = stream.push(e.bytes)
        // a reply means a whole request was served: half a frame still in the stream's buffer is not a poll
        if (replies.length > 0) this.lastRequestAt = this.now()
        for (const reply of replies) this.host.write(e.id, reply)
        if (stream.error) {
          this.host.drop(e.id)
          this.error = `closed a connection from ${this.masters.get(e.id) ?? 'a master'}: ${stream.error}`
          this.onChange()
        }
      }),
    )
    const { error } = await this.host.listen({ host: this.io.io.host, port: this.io.io.port })
    if (this.closed) return
    this.state = error ? 'failed' : 'listening'
    this.error = error || null
    this.onChange()
  }

  /**
   * One frame's exchange: latch what the parts reported into the image, and return what the PLC wrote
   * when it differs from what was last handed over (null otherwise, so an idle link posts nothing).
   *
   * A PLC that has stopped answering ({@link POLL_TIMEOUT_MS}) hands over its outputs' off state instead,
   * so the line stops rather than running on a value nobody is driving.
   */
  exchange(simTags: Readonly<Record<string, TagValue>>): Record<string, number | boolean> | null {
    this.io.writeSimTags(simTags)
    const stale = this.watchdogTripped()
    if (stale !== this.stale) {
      this.stale = stale
      this.onChange() // the dock says which state the link is in
    }
    const out = (stale ? this.io.offTags() : this.io.plcTags()) as Record<string, number | boolean>
    const key = JSON.stringify(out)
    if (key === this.lastOut) return null
    this.lastOut = key
    return out
  }

  /**
   * Whether the PLC has stopped answering: no request for {@link POLL_TIMEOUT_MS}, or no connection left.
   *
   * Only once it has polled at least once. Before that the image is zeros anyway, so there is nothing to
   * de-energise, and "waiting for a PLC" is what the status already says - calling that a fault would
   * put a red line on every run before anything had gone wrong.
   */
  private watchdogTripped(): boolean {
    if (this.lastRequestAt === null) return false
    return this.masters.size === 0 || this.now() - this.lastRequestAt > POLL_TIMEOUT_MS
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const u of this.unsubscribe.splice(0)) u()
    this.streams.clear()
    this.masters.clear()
    await this.host.close()
  }

  status(): ExternalPlcStatus {
    return {
      mode: 'serve',
      state: this.closed ? 'off' : this.state,
      endpoint: `${this.io.io.host}:${this.io.io.port}`,
      masters: [...this.masters.values()],
      requests: describeStats(this.io.stats),
      plcWrites: MODBUS_WRITE_FCS.reduce((n, fc) => n + (this.io.stats.requests[fc] ?? 0), 0),
      exceptions: this.io.stats.exceptions,
      stale: this.stale,
      sinceLastRequestMs: this.lastRequestAt === null ? null : Math.max(0, this.now() - this.lastRequestAt),
      driven: this.driven,
      points: this.io.io.points.map(describePoint),
      error: this.error,
      problems: this.problems,
    }
  }
}


/**
 * One run's link when the PLC serves and the simulator polls it: a Modbus TCP client on the desktop shell's socket
 * (clientLink.ts SocketLink has the connect, retry and watchdog rules). Its framing is plc/link/modbusClient.ts's; an
 * answer is matched to its request by the MBAP transaction id.
 */
export class ExternalPlcClientSession extends SocketLink<ModbusPoller> {
  readonly driven: string[]
  private stream: ModbusClientStream | null = null

  constructor(
    host: PlcIoHost,
    readonly io: ModbusClientIo,
    private readonly problems: string[],
    onChange: () => void,
    now: () => number = () => Date.now(),
  ) {
    super(host, new ModbusPoller(io), { host: io.host, port: io.port }, onChange, now)
    this.driven = clientDrivenTags(io)
  }

  protected get endpoint(): string {
    return `${this.io.host}:${this.io.port}`
  }

  protected newStream(): void {
    this.stream = new ModbusClientStream(this.io.unitId)
  }

  protected forget(): void {
    this.stream = null
  }

  protected frame(pdu: Uint8Array): { key: number; bytes: Uint8Array } {
    const { tid, bytes } = this.stream!.frame(pdu)
    return { key: tid, bytes }
  }

  protected receive(bytes: Uint8Array): { answers: { key: number; pdu: Uint8Array }[]; drop: string | null } {
    if (!this.stream) return { answers: [], drop: null }
    const answers = this.stream.push(bytes).map((r) => ({ key: r.tid, pdu: r.pdu }))
    return { answers, drop: this.stream.error ? `the PLC sent something that is not Modbus TCP: ${this.stream.error}` : null }
  }

  protected timeoutMessage(pdu: Uint8Array): string {
    return `no answer to FC${pdu[0]} within ${CLIENT_ANSWER_MS} ms`
  }

  protected closedMessage(): string {
    return `the PLC closed the connection (${this.endpoint})`
  }

  status(): ExternalPlcStatus {
    return {
      mode: 'poll',
      ...this.commonStatus(),
      endpoint: this.endpoint,
      masters: this.masters(),
      requests: describeStats(this.poller.stats),
      driven: this.driven,
      points: this.io.points.map(describeClientPoint),
      problems: this.problems,
    }
  }
}

/**
 * One run's link to a PLC's OPC UA server: connect, find each scene tag's node by name, then one cycle
 * every {@link CLIENT_POLL_MS} - write what the parts publish, read what the PLC drives - for as long as
 * the run lasts. Retries, the watchdog and the status read the same as the Modbus client's.
 *
 * Tags are found again after every reconnect: a PLC that was re-downloaded may have rebuilt its tree.
 *
 * What the watchdog cannot see here. A Modbus server device goes quiet when its application stops; an
 * OPC UA server is the runtime's, not the program's, and keeps answering with the last values. So a PLC
 * whose program is stopped looks alive over OPC UA; only a lost connection or a silent server trips it.
 */

export function plcTagListOf(endpoint: string, from: readonly string[], browsed: { variables: OpcUaVariable[]; truncated: boolean }): PlcTagList {
  return { protocol: 'opcua', endpoint, from, state: 'ready', names: opcUaTagNames(browsed.variables), groups: opcUaVariableGroups(browsed.variables), variables: browsed.variables, truncated: browsed.truncated, error: null }
}

/** Start points as typed (PlcLinkSettings.opcUaBrowseFrom), as the shell takes them; one that reads as neither is left out. */
export function browseRootsOf(from: readonly string[]): OpcUaBrowseRoot[] {
  return from.flatMap((text) => opcUaBrowseRoot(text) ?? [])
}

/**
 * Connect, browse once and let go: the tag picker's read while no run holds the link. The shell has one OPC UA
 * link per window, so a run that starts meanwhile takes it over (its connect supersedes this one); `mayClose` is
 * asked before closing, so this never closes the run's link.
 */
export async function readOpcUaTagList(host: OpcUaHost, endpoint: string, from: readonly string[], mayClose: () => boolean): Promise<PlcTagList> {
  const failed = (error: string): PlcTagList => ({ protocol: 'opcua', endpoint, from, state: 'failed', names: [], groups: [], variables: [], truncated: false, error })
  const { error, discovery } = await host.connect({ endpoint })
  if (discovery) return failed(discoveryServerMessage(endpoint, discovery))
  if (error) return failed(error)
  try {
    const tree = await host.browse({ roots: browseRootsOf(from) })
    if (tree.error || !tree.variables) return failed(`could not read the PLC's tags: ${tree.error || 'nothing came back'}`)
    // a branch that never answered leaves the list incomplete, as a cut-off browse does
    return plcTagListOf(endpoint, from, { variables: tree.variables, truncated: tree.truncated === true || (tree.skipped?.length ?? 0) > 0 })
  } finally {
    if (mayClose()) await host.close()
  }
}

/**
 * Open, list the runtime's symbol table once and let go: the tag picker's read of a TwinCAT PLC while no run holds the
 * link. It uses the default controller's own link, so a run that starts meanwhile replaces it (the shell closes the
 * old one on open); `mayClose` is asked before closing, so this never closes the run's link.
 */
export async function readAdsTagList(host: AdsHost, netId: string, port: number, mayClose: () => boolean): Promise<PlcTagList> {
  const endpoint = adsEndpoint(netId, port)
  const failed = (error: string): PlcTagList => ({ protocol: 'ads', endpoint, from: [], state: 'failed', names: [], groups: [], variables: [], truncated: false, error })
  if (!host.symbols) return failed("this version of the desktop app cannot list a PLC's tags")
  const opened = await host.open({ netId, port })
  if (opened.error) return failed(opened.error)
  try {
    const r = await host.symbols()
    if (r.error) return failed(r.error)
    if (r.code) return failed(adsRouteText(r.code, opened.localNetId ?? ''))
    return { protocol: 'ads', endpoint, from: [], state: 'ready', names: adsTagNames(r.symbols ?? []), groups: adsSymbolGroups(r.symbols ?? []), variables: [], truncated: false, error: null }
  } finally {
    if (mayClose()) await host.close()
  }
}

/** The same for a Logix controller over EtherNet/IP: its tags and each program's, as libplctag lists them. */
export async function readEipTagList(host: EipHost, target: EipTarget, mayClose: () => boolean): Promise<PlcTagList> {
  const endpoint = eipEndpoint(target)
  const failed = (error: string): PlcTagList => ({ protocol: 'eip', endpoint, from: [], state: 'failed', names: [], groups: [], variables: [], truncated: false, error })
  if (!host.tags) return failed("this version of the desktop app cannot list a PLC's tags")
  const opened = await host.open({ ...target })
  if (opened.error) return failed(opened.error)
  try {
    const r = await host.tags()
    if (r.error) return failed(r.error)
    if (r.status !== 'ok') return failed(eipListingFailure(r.status ?? 'no status', target.path))
    return { protocol: 'eip', endpoint, from: [], state: 'ready', names: eipTagNames(r.tags ?? []), groups: eipVariableGroups(r.tags ?? []), variables: [], truncated: false, error: null }
  } finally {
    if (mayClose()) await host.close()
  }
}


export class ExternalPlcOpcUaSession extends NamedLink<OpcUaPoint, OpcUaBinding> {
  private connected = false
  /** the PLC's tree as the last bind read it, for the tag picker (controller.plcTagList); null before */
  browsed: { variables: OpcUaVariable[]; truncated: boolean } | null = null
  private unsubscribe: (() => void) | null = null
  /** while a bind reads the tree, how many variables it has found; null otherwise */
  private reading: number | null = null

  constructor(
    private readonly host: OpcUaHost,
    readonly endpoint: string,
    points: readonly OpcUaPoint[],
    problems: string[],
    onChange: () => void,
    /** where the browse starts (PlcLinkSettings.opcUaBrowseFrom); empty: Objects */
    readonly from: readonly string[] = [],
    now: () => number = () => Date.now(),
  ) {
    super(points, problems, onChange, now)
  }

  protected attach(): void {
    this.unsubscribe = this.host.onClosed((e) => this.dropped(e.why))
  }

  /** The connection is gone: forget the tree, and connect again after a pause. */
  protected dropped(why: string): void {
    if (this.closed || !this.connected) return
    this.connected = false
    super.dropped(why)
  }

  protected isOpen(): boolean {
    return this.connected
  }

  protected async open(): Promise<'up' | 'retry' | 'failed'> {
    const { error, discovery } = await this.host.connect({ endpoint: this.endpoint })
    if (this.closed) return 'failed'
    if (discovery) {
      // a discovery server will not turn into a PLC: say where to look instead, and stop trying
      this.state = 'failed'
      this.error = discoveryServerMessage(this.endpoint, discovery)
      this.onChange()
      return 'failed'
    }
    if (error) {
      this.retryAt = this.now() + CLIENT_RETRY_MS
      this.setError(error)
      return 'retry'
    }
    this.connected = true
    this.onChange()
    return 'up'
  }

  /**
   * Read the tree and bind each point to its node. Tags are found again after every reconnect: a PLC that was
   * re-downloaded may have rebuilt its tree. When every tag is a NodeId there is nothing to find by name, so the
   * tree is not read, and the tag picker gets no list from this run.
   */
  protected async bind(): Promise<boolean> {
    // with no points the browse still runs: it is the tag picker's list while nothing is wired yet
    const byNodeId = this.points.length > 0 && this.points.every((p) => isOpcUaNodeId(p.tag))
    const tree = byNodeId ? { error: '', variables: [] } : await this.readTree()
    if (this.closed) return false
    if (tree.error || !tree.variables) {
      if (tree.error === NOT_CONNECTED) {
        this.dropped('the connection to the PLC was lost')
        return false
      }
      return this.bindFailed(`could not read the PLC's tags: ${tree.error}`)
    }
    const variables = tree.variables
    const skipped = 'skipped' in tree ? (tree.skipped ?? []) : []
    const truncated = 'truncated' in tree && tree.truncated === true
    if (!byNodeId) this.browsed = { variables, truncated: truncated || skipped.length > 0 }
    const nodeIds = [...new Set(this.points.map((p) => matchOpcUaTag(p.tag, variables)).flatMap((m) => ('variable' in m ? [m.variable.nodeId] : [])))]
    const described = await this.host.describe({ nodeIds })
    if (this.closed) return false
    if (described.error || !described.nodes) {
      if (described.error === NOT_CONNECTED) {
        this.dropped('the connection to the PLC was lost')
        return false
      }
      return this.bindFailed(`could not read the PLC's tag types: ${described.error}`)
    }
    const info = new Map(nodeIds.map((id, i) => [id, described.nodes![i]!]))
    const found = bindOpcUaPoints(this.points, variables, (id) => info.get(id))
    const problems = [...found.problems]
    if (truncated) problems.push('the PLC holds more tags than the link reads; a tag it did not reach reads as missing')
    if (skipped.length > 0) {
      const shown = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? ', ...' : '')
      problems.push(`${skipped.length === 1 ? 'a branch' : `${skipped.length} branches`} of the PLC's tags did not answer in time (${shown}); a tag under ${skipped.length === 1 ? 'it' : 'them'} reads as missing`)
    }
    this.bound(found.bindings, problems)
    return true
  }

  /** The browse, with how far it has got in the status: a PLC with a large tree can take minutes to list. */
  private async readTree(): ReturnType<OpcUaHost['browse']> {
    this.reading = 0
    this.onChange()
    const off = this.host.onProgress?.((e) => {
      this.reading = e.found
      this.onChange()
    })
    try {
      return await this.host.browse({ roots: browseRootsOf(this.from) })
    } finally {
      off?.()
      this.reading = null
    }
  }

  protected async cycle(writing: OpcUaBinding[], reading: OpcUaBinding[]): Promise<void> {
    const r = await this.host.exchange({
      writes: writing.map((b) => ({ nodeId: b.nodeId, builtin: b.builtin, value: toOpcUaValue(b.builtin, this.sim[b.tag]) })),
      reads: reading.map((b) => b.nodeId),
    })
    if (this.closed) return
    if (r.error) {
      // the shell has no link any more: the PLC went away between its event and this call
      if (r.error === NOT_CONNECTED) this.dropped('the connection to the PLC was lost')
      else this.setError(r.error)
      return
    }
    const bad = (tag: string, status: string | undefined, what: string): string | null => (status !== undefined && status !== 'Good' ? `${tag}: the PLC answered the ${what} with ${status}` : null)
    this.cycled(
      [...writing.map((b, i) => [b.tag, bad(b.tag, r.writes?.[i], 'write')] as const), ...reading.map((b, i) => [b.tag, bad(b.tag, r.reads?.[i]?.status, 'read')] as const)],
      reading.flatMap((b, i) => {
        const got = r.reads?.[i]
        return got && got.status === 'Good' ? [[b.tag, fromOpcUaValue(b.builtin, got.value)] as const] : []
      }),
    )
  }

  protected async shutdown(): Promise<void> {
    this.unsubscribe?.()
    this.connected = false
    await this.host.close()
  }

  status(): ExternalPlcStatus {
    const bound = this.bindings
    const status = this.namedStatus({
      mode: 'opcua',
      endpoint: this.endpoint,
      masters: this.connected && !this.closed ? [this.endpoint] : [],
      points: bound ? [...bound.map(describeOpcUaBinding), ...this.points.filter((p) => !bound.some((b) => b.tag === p.tag)).map(describeOpcUaPoint)] : this.points.map(describeOpcUaPoint),
    })
    return this.reading === null || this.closed ? status : { ...status, reading: this.reading }
  }
}

/**
 * One run's link to a Logix controller over EtherNet/IP: say where it is, ask it for each scene tag once (which is
 * how it says what type it holds), then one cycle every {@link CLIENT_POLL_MS} - write what the parts publish, read
 * what the PLC drives - for as long as the run lasts. Retries, the watchdog and the status read as the other clients'.
 *
 * There is no connection to lose as such: libplctag opens the session, and reopens it, on its own. A controller that
 * stops answering shows as every request of a cycle timing out, which the link takes as the connection being gone:
 * the watchdog trips, and the tags are asked for anew a second later, since a controller that was re-downloaded may
 * hold different ones. Like OPC UA's, this watchdog cannot see a controller in Program mode: its tags still answer,
 * with whatever the program left in them.
 */
export class ExternalPlcEipSession extends NamedLink<EipPoint, EipBinding> {
  private opened = false

  constructor(
    private readonly host: EipHost,
    readonly target: EipTarget,
    points: readonly EipPoint[],
    problems: string[],
    onChange: () => void,
    now: () => number = () => Date.now(),
  ) {
    super(points, problems, onChange, now)
  }

  private get endpoint(): string {
    return eipEndpoint(this.target)
  }

  protected isOpen(): boolean {
    return this.opened
  }

  protected async open(): Promise<'up' | 'retry' | 'failed'> {
    const { error } = await this.host.open({ ...this.target })
    if (this.closed) return 'failed'
    if (error) {
      // no library, an address the shell refused, a connection the user did not allow: retrying changes none of them
      this.state = 'failed'
      this.error = error
      this.onChange()
      return 'failed'
    }
    this.opened = true
    return 'up'
  }

  /** Ask the controller for every tag once. False when it could not be reached (the link then retries). */
  protected async bind(): Promise<boolean> {
    const r = this.points.length === 0 ? { error: '', tags: [] } : await this.host.bind({ tags: this.points.map((p) => ({ name: p.tag, bit: p.bit })) })
    if (this.closed) return false
    if (r.error || !r.tags) {
      // the shell holds no link for this window any more: say where the controller is again
      if (r.error === NOT_CONNECTED) this.opened = false
      return this.bindFailed(r.error || 'the desktop shell did not answer')
    }
    if (r.tags.length > 0 && r.tags.every((t) => eipUnreachable(t.status))) {
      return this.bindFailed(`nothing answered (${r.tags[0]!.status}): check the address, the path, the controller family, and that the controller is on`)
    }
    // every tag refused the way a wrong path also refuses: one sentence about the path, not a missing tag per line.
    // Retried like silence, since a controller being downloaded answers so too
    const none = eipNothingAnswered(this.points.map((p) => p.tag), r.tags.map((t) => t.status), this.target.path)
    if (none) return this.bindFailed(none)
    const bindings: EipBinding[] = []
    const problems: string[] = []
    this.points.forEach((p, i) => {
      const t = r.tags![i]
      if (!t || t.status !== 'ok' || t.cip === null) {
        problems.push(eipStatusMessage(p.tag, t?.status ?? 'no answer'))
        return
      }
      const b = bindEipPoint(p, t.cip)
      if ('error' in b) problems.push(b.error)
      else bindings.push(b.binding)
    })
    this.bound(bindings, problems)
    return true
  }

  protected async cycle(writing: EipBinding[], reading: EipBinding[]): Promise<void> {
    const r = await this.host.exchange({
      writes: writing.map((b) => ({ name: b.tag, value: toEipValue(b, this.sim[b.tag]) })),
      reads: reading.map((b) => b.tag),
    })
    if (this.closed) return
    if (r.error) {
      if (r.error === NOT_CONNECTED) {
        this.opened = false
        this.dropped('the connection to the PLC was lost')
      } else this.setError(r.error)
      return
    }
    const statuses = [...(r.writes ?? []), ...(r.reads ?? []).map((x) => x.status)]
    if (statuses.length > 0 && statuses.every(eipUnreachable)) {
      this.dropped(`the controller stopped answering (${statuses[0]})`)
      return
    }
    const bad = (tag: string, status: string | undefined, what: string): string | null => (status !== undefined && status !== 'ok' ? `${eipStatusMessage(tag, status)} (on ${what})` : null)
    this.cycled(
      [...writing.map((b, i) => [b.tag, bad(b.tag, r.writes?.[i], 'write')] as const), ...reading.map((b, i) => [b.tag, bad(b.tag, r.reads?.[i]?.status, 'read')] as const)],
      reading.flatMap((b, i) => {
        const got = r.reads?.[i]
        return got && got.status === 'ok' ? [[b.tag, fromEipValue(b, got.value)] as const] : []
      }),
    )
  }

  /** A bit member is off as false, whatever its integer's type. */
  protected offValue(p: EipPoint): boolean | number {
    return p.type === 'BOOL' || p.type === null || p.bit ? false : 0
  }

  protected async shutdown(): Promise<void> {
    await this.host.close()
  }

  status(): ExternalPlcStatus {
    const bound = this.bindings
    return this.namedStatus({
      mode: 'eip',
      endpoint: this.endpoint,
      // libplctag holds the session open itself, so a controller that goes quiet "stopped answering" rather than closed anything
      masters: this.opened && !this.closed ? [this.endpoint] : [],
      points: this.points.map((p) => describeEipPoint(bound?.find((b) => b.tag === p.tag) ?? p)),
    })
  }
}

/**
 * A link whose code loads on Play rather than with the app: the S7 session (editor/links/s7Link.ts) and the protocol under
 * it are a lazy chunk, since most people never connect to an S7 CPU. What the controller needs at once - the
 * tags the PLC drives, and a status to show - is known from the table without it. Until the code has loaded,
 * the parts' tags are kept for the session's first write and the PLC drives nothing.
 */
export class DeferredLink implements ExternalPlcLink {
  private inner: ExternalPlcLink | null = null
  private closed = false
  private failed: string | null = null
  private readonly latest: Record<string, TagValue> = {}

  constructor(
    readonly driven: string[],
    private readonly load: () => Promise<ExternalPlcLink>,
    /** the status to show while the code loads */
    private readonly before: ExternalPlcStatus,
  ) {}

  async start(initial: Readonly<Record<string, TagValue>>): Promise<void> {
    Object.assign(this.latest, initial)
    let link: ExternalPlcLink
    try {
      link = await this.load()
    } catch (e) {
      this.failed = `could not load the link: ${e instanceof Error ? e.message : String(e)}`
      return
    }
    if (this.closed) return
    this.inner = link
    await link.start(this.latest)
  }

  exchange(simTags: Readonly<Record<string, TagValue>>): Record<string, number | boolean> | null {
    if (this.inner) return this.inner.exchange(simTags)
    Object.assign(this.latest, simTags)
    return null
  }

  async stop(): Promise<void> {
    this.closed = true
    await this.inner?.stop()
  }

  status(): ExternalPlcStatus {
    if (this.inner) return this.inner.status()
    if (this.failed) return { ...this.before, state: 'failed', error: this.failed }
    return { ...this.before, state: this.closed ? 'off' : 'starting' }
  }
}

/** One run's link to an S7 CPU: the S7 session, loaded when the run starts (editor/links/s7Link.ts). */
export function s7Link(host: PlcIoHost, io: S7ClientIo, problems: string[], onChange: () => void): DeferredLink {
  const driven = s7DrivenTags(io)
  return new DeferredLink(driven, async () => new (await import('./s7Link')).ExternalPlcS7Session(host, io, problems, onChange), {
    ...EXTERNAL_PLC_OFF,
    mode: 's7',
    state: 'starting',
    endpoint: s7Endpoint(io),
    driven,
    points: io.points.map(describeS7Point),
    problems,
  })
}

/** One run's link to a MELSEC CPU: the SLMP session, loaded when the run starts (editor/links/slmpLink.ts). */
export function slmpLink(host: PlcIoHost, io: SlmpClientIo, problems: string[], onChange: () => void): DeferredLink {
  const driven = slmpDrivenTags(io)
  return new DeferredLink(driven, async () => new (await import('./slmpLink')).ExternalPlcSlmpSession(host, io, problems, onChange), {
    ...EXTERNAL_PLC_OFF,
    mode: 'slmp',
    state: 'starting',
    endpoint: slmpEndpoint(io),
    driven,
    points: io.points.map(describeSlmpPoint),
    problems,
  })
}

/** One run's link to a TwinCAT runtime: the ADS session, loaded when the run starts (editor/links/adsLink.ts). */
export function adsLink(host: AdsHost, netId: string, port: number, points: readonly AdsPoint[], problems: string[], onChange: () => void): DeferredLink {
  const driven = points.filter((p) => p.dir === 'fromPlc').map((p) => p.tag)
  return new DeferredLink(driven, async () => new (await import('./adsLink')).ExternalPlcAdsSession(host, netId, port, points, problems, onChange), {
    ...EXTERNAL_PLC_OFF,
    mode: 'ads',
    state: 'starting',
    endpoint: adsEndpoint(netId, port),
    driven,
    points: points.map(describeAdsPoint),
    problems,
  })
}

const AREA_WORD = { coil: 'coil', discreteInput: 'discrete input', holdingRegister: 'holding register', inputRegister: 'input register' } as const

/** "discrete input 800", "input registers 200-201": where a point sits, in the protocol's own words. */
export function pointWhere(p: ExternalIoPoint): string {
  return registerWords(p.type) === 2 ? `${AREA_WORD[p.area]}s ${p.address}-${p.address + 1}` : `${AREA_WORD[p.area]} ${p.address}`
}

/** "%IX100.0  discrete input 800", or "%ID100  input registers 200-201  REAL": a point as the dock lists it. */
export function describePoint(p: ExternalIoPoint): string {
  return `${p.tag}  ${pointWhere(p)}${registerWords(p.type) === 2 ? `  ${p.type}` : ''}`
}

/** "%IX0.0  holding register 0 bit 0", or "%ID1  holding registers 2-3  REAL": a client point as the dock lists it. */
export function describeClientPoint(p: ClientIoPoint): string {
  return `${p.tag}  ${registerImagePointWhere(p)}${p.words === 2 ? `  ${p.type}` : ''}`
}

