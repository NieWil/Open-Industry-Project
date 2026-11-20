// The light half of the external-PLC link: what the first frame needs to show a link (the toolbar's status chip,
// the controller's idle state) without loading the link itself. The sessions, the I/O derivations and the protocol
// stacks behind them live in editor/links/externalPlc.ts, which the controller loads on Play with a link enabled (and
// warms at startup when one is), so a browser tab, which can never run a link, never parses them. That module
// re-exports everything here, so a caller that already loads it imports from either.

import type { AdsSymbol } from '../../core/io/ads'
import type { EipListedTag } from '../../core/io/eip'
import { eipEndpoint, eipTarget } from '../../core/io/eipTarget'
import type { EipTarget } from '../../core/io/eipTarget'
import type { PlcVariableGroup } from '../../core/io/plcVariables'
import type { DiscoveredServer, OpcUaBrowseRoot, OpcUaNodeInfo, OpcUaVariable } from '../../core/io/opcUa'
import type { TagValue } from '../../plc/types'
import type { PlcLinkSettings } from '../store/storePrefs'

/**
 * Which of a window's links a call is for: the desktop shell keeps one per controller (apps/desktop/linkKeys.cjs),
 * 0 for the main one. A session never sets it; linkHosts.ts hands it a host that does.
 */
export interface LinkOpt {
  link?: number
}

/** What the host that owns the socket offers. The desktop shell's `window.oipPlcIo` is one. */
export interface PlcIoHost {
  /** start listening (a PLC that polls); resolves with '' once listening, or why it could not */
  listen(opts: { host: string; port: number } & LinkOpt): Promise<{ error: string }>
  /** connect to a PLC's Modbus server (a PLC that serves); resolves with the connection's id, or why not */
  connect(opts: { host: string; port: number } & LinkOpt): Promise<{ error: string; id: number }>
  close(opts?: LinkOpt): Promise<void>
  onConnection(cb: (e: { id: number; remote: string; open: boolean } & LinkOpt) => void): () => void
  onData(cb: (e: { id: number; bytes: Uint8Array } & LinkOpt) => void): () => void
  write(id: number, bytes: Uint8Array): void
  drop(id: number): void
}

/**
 * What the desktop shell offers for OPC UA (`window.oipOpcUa`, apps/desktop/opcUaIo.cjs): the service
 * calls, made by node-opcua there. Which tag is which node, and what a value means, is decided here.
 */
export interface OpcUaHost {
  /** `discovery`: the address is a discovery server, not a PLC, and these are the servers it lists */
  connect(opts: { endpoint: string } & LinkOpt): Promise<{ error: string; discovery?: DiscoveredServer[] }>
  /** under Objects, or under `roots`; `skipped`: the paths of nodes that never answered in time, left out of `variables` */
  browse(opts?: { roots?: OpcUaBrowseRoot[] } & LinkOpt): Promise<{ error: string; variables?: OpcUaVariable[]; truncated?: boolean; skipped?: string[] }>
  describe(opts: { nodeIds: string[] } & LinkOpt): Promise<{ error: string; nodes?: OpcUaNodeInfo[] }>
  exchange(opts: { writes: { nodeId: string; builtin: number; value: boolean | number }[]; reads: string[] } & LinkOpt): Promise<{ error: string; writes?: string[]; reads?: { value: unknown; status: string }[] }>
  close(opts?: LinkOpt): Promise<void>
  onClosed(cb: (e: { why: string } & LinkOpt) => void): () => void
  /** a browse under way, and how many variables it has found; absent on a host that does not say */
  onProgress?(cb: (e: { found: number } & LinkOpt) => void): () => void
}

/**
 * What the desktop shell offers for EtherNet/IP (`window.oipEip`, apps/desktop/eipIo.cjs): libplctag's calls, made
 * there. A status is 'ok' or libplctag's name for what went wrong (PLCTAG_ERR_NOT_FOUND); core/io/eip.ts reads them.
 */
export interface EipHost {
  /** where the controller is; nothing is sent yet. An error here (no library, a refused address) will not go away by retrying */
  open(opts: EipTarget & LinkOpt): Promise<{ error: string }>
  /** a handle per tag, read once: the controller's CIP type for each */
  bind(opts: { tags: { name: string; bit: boolean }[] } & LinkOpt): Promise<{ error: string; tags?: { status: string; cip: number | null }[] }>
  exchange(opts: { writes: { name: string; value: boolean | number }[]; reads: string[] } & LinkOpt): Promise<{ error: string; writes?: string[]; reads?: { value: unknown; status: string }[] }>
  /** every tag the controller lists, for the tag picker; `status` is libplctag's for the listing. Absent on an older shell */
  tags?(opts?: LinkOpt): Promise<{ error: string; status?: string; tags?: EipListedTag[] }>
  close(opts?: LinkOpt): Promise<void>
}

/**
 * What the desktop shell offers for ADS (`window.oipAds`, apps/desktop/adsIo.cjs): TcAdsDll's calls through TwinCAT's
 * router on this PC, made there. A code is an ADS return code, 0 for done; core/io/ads.ts reads them.
 */
export interface AdsHost {
  /** an ADS port on the router, aimed at `netId` ('' = this PC's runtime). An error here (no TwinCAT, no router) will not go away by retrying */
  open(opts: { netId: string; port: number } & LinkOpt): Promise<{ error: string; localNetId?: string; target?: string }>
  /** each symbol's info and a handle */
  bind(opts: { tags: { name: string }[] } & LinkOpt): Promise<{ error: string; tags?: { code: number; adsType?: number; size?: number; typeName?: string }[] }>
  exchange(opts: { writes: { name: string; value: boolean | number }[]; reads: string[] } & LinkOpt): Promise<{ error: string; writes?: number[]; reads?: { value: unknown; status: number }[] }>
  /** the runtime's whole symbol table, for the tag picker; `code` is the ADS code when the runtime refused. Absent on an older shell */
  symbols?(opts?: LinkOpt): Promise<{ error: string; code?: number; symbols?: AdsSymbol[] }>
  close(opts?: LinkOpt): Promise<void>
}

declare global {
  interface Window {
    oipPlcIo?: PlcIoHost
    oipOpcUa?: OpcUaHost
    oipEip?: EipHost
    oipAds?: AdsHost
  }
}

/** The desktop shell's socket, or null in a browser tab. */
export function desktopPlcIoHost(): PlcIoHost | null {
  return typeof window !== 'undefined' && window.oipPlcIo ? window.oipPlcIo : null
}

/** The desktop shell's OPC UA client, or null in a browser tab. */
export function desktopOpcUaHost(): OpcUaHost | null {
  return typeof window !== 'undefined' && window.oipOpcUa ? window.oipOpcUa : null
}

/** The desktop shell's EtherNet/IP client, or null in a browser tab. */
export function desktopEipHost(): EipHost | null {
  return typeof window !== 'undefined' && window.oipEip ? window.oipEip : null
}

/** The desktop shell's ADS client, or null in a browser tab. */
export function desktopAdsHost(): AdsHost | null {
  return typeof window !== 'undefined' && window.oipAds ? window.oipAds : null
}

/** "this PC's TwinCAT runtime, AMS port 851" or "192.168.1.20.1.1, AMS port 851": where an ADS link goes. */
export function adsEndpoint(netId: string, port: number): string {
  return `${netId || "this PC's TwinCAT runtime"}, AMS port ${port}`
}

export { eipEndpoint, eipTarget } from '../../core/io/eipTarget'

export interface ExternalPlcStatus {
  /** how the link runs: the PLC polls (`serve`), the simulator polls a Modbus server (`poll`), an OPC UA one (`opcua`), a Logix controller (`eip`), an S7 CPU (`s7`), a MELSEC CPU over SLMP (`slmp`) or a TwinCAT runtime (`ads`) */
  mode: 'serve' | 'poll' | 'opcua' | 'eip' | 's7' | 'slmp' | 'ads'
  /** serve: starting, then listening. poll: starting (connecting, retrying until the PLC answers), then polling */
  state: 'off' | 'starting' | 'listening' | 'polling' | 'failed'
  /** serve: where the simulator listens. poll: the PLC's server. `host:port` */
  endpoint: string
  /** serve: the masters connected now, by remote address. poll: the PLC, while connected */
  masters: string[]
  /** "FC2 x328, FC15 x328" */
  requests: string
  /** serve: how many of those requests wrote (FC5, FC6, FC15, FC16), and how many were answered with an exception */
  plcWrites?: number
  exceptions?: number
  /** true once the PLC has stopped answering: its outputs are held off until it answers again */
  stale: boolean
  /** how long since the PLC last answered (serve: last request; poll: last complete poll), once it ever has */
  sinceLastRequestMs: number | null
  /** the tags the PLC writes (it drives these devices) */
  driven: string[]
  /** the table the scene makes, one line per point */
  points: string[]
  error: string | null
  problems: string[]
  /** opcua: reading the PLC's tags, with how many variables it has found so far */
  reading?: number
}

export const EXTERNAL_PLC_OFF: ExternalPlcStatus = { mode: 'serve', state: 'off', endpoint: '', masters: [], requests: '', stale: false, sinceLastRequestMs: null, driven: [], points: [], error: null, problems: [] }


/** What the controller holds for a run with an external PLC, whichever end polls. */
export interface ExternalPlcLink {
  /** the tags the PLC drives */
  readonly driven: string[]
  /** open the link, with the scene's tags as they stand already in what the PLC first reads */
  start(initial: Readonly<Record<string, TagValue>>): Promise<void>
  /** one frame's exchange: the parts' tags in, what the PLC wrote out when it changed (null otherwise) */
  exchange(simTags: Readonly<Record<string, TagValue>>): Record<string, number | boolean> | null
  stop(): Promise<void>
  status(): ExternalPlcStatus
}

/** The links whose PLC can list its tags for the tag picker. */
export type PlcTagProtocol = 'opcua' | 'ads' | 'eip'

/**
 * The PLC's tag names, for the Inspector's tag picker. Over OPC UA: what a run's link last browsed (kept after Stop),
 * or what readOpcUaTagList read while stopped; `names` are the ones a pick may write (core/io/opcUa.ts
 * opcUaTagNames), and `variables` is the tree they came from, which says whether a typed name is on the PLC. Over ADS
 * and EtherNet/IP: the PLC's own list as readAdsTagList or readEipTagList read it while stopped (core/io/ads.ts
 * adsTagNames, core/io/eip.ts eipTagNames), with no tree. `groups` is the same list grouped by program or folder, with
 * types where the PLC gives them, for the PLC connections window.
 */
export interface PlcTagList {
  protocol: PlcTagProtocol
  /** which PLC: the OPC UA endpoint, or the target as adsEndpoint or eipEndpoint words it */
  endpoint: string
  /** the start points the browse began at (PlcLinkSettings.opcUaBrowseFrom); empty: Objects */
  from: readonly string[]
  state: 'reading' | 'ready' | 'failed'
  names: string[]
  groups: PlcVariableGroup[]
  variables: OpcUaVariable[]
  /** the browse stopped at its limit, so a name it did not reach may still be on the PLC */
  truncated: boolean
  error: string | null
}

/** Merge every part's tag map into one table, as the sim worker does for the in-process program. */
export function flattenFrameTags(tags: Readonly<Record<string, Readonly<Record<string, number | boolean>>>> | undefined): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {}
  for (const perPart of Object.values(tags ?? {})) Object.assign(out, perPart)
  return out
}

/** The link's state in a sentence: before Play, what Play will do; during it, what the link is doing. Shared with the
 *  toolbar's link status (components/plc/PlcLinkStatus.tsx) and Controller Properties (ExternalPlcSection.tsx). */
export function statusLine(s: ExternalPlcStatus, running: boolean, settings: PlcLinkSettings, beside = false): string {
  const mode = running ? s.mode : settings.mode
  // a named controller (`Cell2::...`) runs beside the program here, so only the main one says the program stops
  const end = beside ? '.' : '; the program here is not run while the PLC is.'
  // the client modes connect out, retry, and time out the same way
  const poll = mode === 'poll' || mode === 'opcua' || mode === 'eip' || mode === 's7' || mode === 'slmp' || mode === 'ads'
  if (!running) {
    if (mode === 'ads') return `Press Play to connect to ${adsEndpoint(settings.adsNetId, settings.adsPort)} over ADS${end}`
    if (mode === 's7') return `Press Play to connect to the S7 CPU at ${settings.s7Host}${settings.s7Port === 102 ? '' : `:${settings.s7Port}`} (rack ${settings.s7Rack}, slot ${settings.s7Slot}) over S7 PUT/GET${end}`
    if (mode === 'slmp') return `Press Play to connect to the MELSEC CPU at ${settings.slmpHost}${settings.slmpPort === 5000 ? '' : `:${settings.slmpPort}`} over SLMP${end}`
    if (mode === 'eip') return `Press Play to connect to the controller at ${eipEndpoint(eipTarget(settings))} over EtherNet/IP${end}`
    if (mode === 'opcua') return `Press Play to connect to the PLC's OPC UA server at ${settings.opcUaEndpoint}${end}`
    return poll
      ? `Press Play to poll the PLC at ${settings.plcHost}:${settings.plcPort}${end}`
      : `Press Play to serve these points${end}`
  }
  if (s.state === 'off') return 'Stopped.'
  if (s.state === 'failed') return `${poll ? 'Could not connect' : 'Could not serve'}: ${s.error ?? 'unknown error'}`
  // the watchdog first: a line running on outputs nobody drives is the one thing the link status must not hide
  if (s.stale) {
    const quiet = s.sinceLastRequestMs === null ? '' : ` for ${(s.sinceLastRequestMs / 1000).toFixed(1)} s`
    if (poll) {
      const why = s.masters.length === 0 ? `The PLC at ${s.endpoint} closed the connection` : `The PLC at ${s.endpoint} stopped answering${quiet}`
      return `${why}: its outputs are held off until it answers again.`
    }
    const why = s.masters.length === 0 ? 'The PLC disconnected' : `The PLC stopped polling${quiet}`
    return `${why}: its outputs are held off until it polls again.`
  }
  const traffic = s.requests && s.requests !== 'no requests' ? `, ${s.requests}` : ''
  if (poll) {
    if (s.state === 'starting' && s.reading !== undefined) return `Reading the PLC's tags at ${s.endpoint}: ${s.reading} found so far...`
    if (s.state === 'starting') return s.error ? `Waiting for the PLC at ${s.endpoint}: ${s.error}. Trying again every second.` : `Connecting to the PLC at ${s.endpoint}...`
    const doing =
      mode === 'opcua' || mode === 'eip' || mode === 'ads' ? `Reading and writing the PLC's tags at ${s.endpoint}` : mode === 's7' ? `Reading and writing the CPU's memory at ${s.endpoint}` : mode === 'slmp' ? `Reading and writing the CPU's devices at ${s.endpoint}` : `Polling the PLC at ${s.endpoint}`
    return `${doing}${traffic}${s.error ? `. ${s.error}` : ''}`
  }
  if (s.state === 'starting') return 'Opening the port…'
  const who = s.masters.length === 0 ? 'no PLC connected yet' : `${s.masters.length} connected (${s.masters.join(', ')})`
  return `Serving on ${s.endpoint}: ${who}${traffic}${s.error ? `. ${s.error}` : ''}`
}

/** The first port named in `text` (`host:port`, or an `opc.tcp://host:port/path` URL); null when it names none. */
function portIn(text: string): number | null {
  const m = /:(\d+)/.exec(text)
  return m ? Number(m[1]) : null
}

/**
 * What to try next, when the link is stuck where people get stuck: nothing connected, nothing answering, or a PLC
 * that connected and does nothing. Null when the status line already says all there is (running fine, the watchdog,
 * an error that names its own cure, like ADS's router or a controller path). A second line under statusLine in
 * Controller Properties and the toolbar's link popover.
 *
 * The advice is per side: serving, the PLC connects in, so it is this computer's address, port and firewall; polling,
 * it is the PLC's. And per protocol, for the port to name. It reads the errors the shell writes (apps/desktop
 * plcIo.cjs, opcUaIo.cjs), so a rewording there drops the hint rather than giving the wrong one.
 */
export function statusHint(s: ExternalPlcStatus, running: boolean): string | null {
  if (!running || s.state === 'off' || s.stale) return null
  if (s.mode === 'serve') {
    const port = portIn(s.endpoint)
    if (s.state === 'failed') {
      return /already in use/.test(s.error ?? '')
        ? 'Another program on this computer holds that port (another simulator window, or a PLC runtime\'s own Modbus server): close it, or choose another port here and point the PLC at that one.'
        : null
    }
    if (s.state !== 'listening') return null
    if (s.masters.length === 0) {
      return s.endpoint.startsWith('127.0.0.1:')
        ? 'Only a PLC running on this computer can connect. For a PLC elsewhere on the network, Stop and tick Reachable from the network.'
        : `In the PLC, point its Modbus TCP client at this computer's IP address, port ${port}, and allow port ${port} inbound in this computer's firewall.`
    }
    if (s.exceptions)
      return `The PLC asked for something this table does not serve ${s.exceptions === 1 ? 'once' : `${s.exceptions} times`} (an address outside it, or a function it does not answer): compare the PLC's Modbus mapping with the points below.`
    if (s.driven.length > 0 && s.sinceLastRequestMs !== null && s.plcWrites === 0)
      return `The PLC is polling but ${s.driven.length === 1 ? 'has not written the output' : `has written none of the ${s.driven.length} outputs`} it drives yet. If something should be running, check that its program writes the points below.`
    return null
  }
  // the client modes: only while still trying to reach the PLC
  if (s.state !== 'starting' || !s.error) return null
  // the shell's errors name the address they tried (S7's endpoint leaves the standard port out)
  const n = portIn(s.error) ?? portIn(s.endpoint)
  const port = n === null ? 'its port' : `port ${n}`
  const standard = s.mode === 's7' ? ' (S7 uses 102)' : s.mode === 'slmp' ? " (SLMP's standard port is 5000)" : s.mode === 'opcua' ? " (OPC UA's standard is 4840)" : s.mode === 'poll' ? " (Modbus TCP's standard is 502)" : ''
  if (/^nothing is listening on /.test(s.error)) {
    const server = s.mode === 's7' ? "and that the address is the CPU's own" : s.mode === 'slmp' ? 'and that the CPU answers SLMP on that port (its Ethernet module\'s SLMP connection, or the simulator\'s SLMP setting)' : "and that the PLC's Modbus TCP server is switched on"
    return `The PLC's address answered, but refused ${port}: check the port${standard} ${server}.`
  }
  if (/^no answer from .* within \d+ s$/.test(s.error) || /^nothing answered at /.test(s.error)) {
    const server = s.mode === 'opcua' ? ", that the PLC's OPC UA server is enabled," : ''
    return `Check the PLC's IP address and port${standard}, that it is on and on the same network as this computer${server} and that no firewall between them blocks ${port}.`
  }
  if (/^no host named /.test(s.error)) return "Check the spelling of the PLC's address, or enter its IP address instead."
  return null
}
