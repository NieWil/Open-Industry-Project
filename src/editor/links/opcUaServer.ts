// The simulated PLC's OPC UA server: the running program's variables, published by name so a SCADA, an HMI panel
// or a test client connects to the simulator the way it connects to a real PLC's own server.
//
// The other way round from the OPC UA external-PLC link (editor/links/externalPlc.ts, core/io/opcUa.ts), where the
// simulator is a client of a real PLC. Here the program in the PLC panel keeps running in the sim worker, as
// it does without a server, and a client beside it watches what it does and writes what an operator writes:
// a Start button, a setpoint, a reset. What each variable is published as follows from its declaration:
//
//   - its OPC UA type from its IEC type (BOOL a Boolean, INT an Int16, REAL a Float, TIME a Double of ms)
//   - read-only when it is a constant, a function block's output (`T1.Q`), or an input the scene feeds (a
//     photo eye), which the next scan would overwrite anyway; writable otherwise
//   - its NodeId is its name, `ns=1;s=Main.Start`, so the same tag reaches it on every run and machine
//
// While the simulation is stopped, or no program runs here (an external PLC runs the scene, or the program
// faulted), every variable reads BadOutOfService and a write is refused: a SCADA must not show a motor
// running on a line that is not. The nodes stay, so a client's subscriptions survive Stop and Play.
//
// The server is the desktop shell's (apps/desktop/opcUaServer.cjs, node-opcua); a browser tab cannot
// listen on a port, so there the host is null and the option is not offered. src/plc/DEVICE-IO.md has the design.

import type { TagValue, VarInfo } from '../../plc/types'
import type { LinkOpt } from './externalPlcStatus'
import { forEachWatchValue } from '../../core/watchTable'

/** A variable as the shell publishes it. */
export interface ServerNode {
  /** the watch table's name for it: `Start`, `Main.Start`, `T1.Q` (each dot a folder) */
  name: string
  /** the OPC UA built-in type id (1 Boolean ... 11 Double, 12 String) */
  builtin: number
  writable: boolean
  value: boolean | number | string
}

/** What the desktop shell offers (`window.oipOpcUaServer`, apps/desktop/opcUaServer.cjs). */
/** The desktop shell's OPC UA servers, one per controller in a window: `link` is the controller's number, as its PLC
 *  link's (links/linkHosts.ts opcUaServerForLink), 0 for the default controller and when absent. */
export interface OpcUaServerHost {
  start(opts: { port: number; network: boolean } & LinkOpt): Promise<{ error: string; endpoint: string }>
  define(opts: { nodes: ServerNode[] } & LinkOpt): Promise<{ error: string }>
  update(opts: { values: Record<string, TagValue>; running: boolean } & LinkOpt): void
  stop(opts?: LinkOpt): Promise<void>
  onWrite(cb: (e: { name: string; value: unknown } & LinkOpt) => void): () => void
  onClients(cb: (e: { clients: string[] } & LinkOpt) => void): () => void
}

declare global {
  interface Window {
    oipOpcUaServer?: OpcUaServerHost
  }
}

/** The desktop shell's OPC UA server, or null in a browser tab. */
export function desktopOpcUaServerHost(): OpcUaServerHost | null {
  return typeof window !== 'undefined' && window.oipOpcUaServer ? window.oipOpcUaServer : null
}

const BUILTIN_OF: Record<VarInfo['type'], number> = {
  BOOL: 1,
  SINT: 2,
  USINT: 3,
  BYTE: 3,
  INT: 4,
  UINT: 5,
  WORD: 5,
  DINT: 6,
  UDINT: 7,
  DWORD: 7,
  REAL: 10,
  LREAL: 11,
  // a TIME is carried in milliseconds, which is what the watch table shows too
  TIME: 11,
  // and so are the calendar types: ms since 1970-01-01 UTC (DATE, DT) or since midnight (TOD). OPC UA's own
  // DateTime would suit DATE and DT better, but the value would then need converting both ways in the shell
  DATE: 11,
  TOD: 11,
  DT: 11,
  STRING: 12,
  // an enumeration is an integer at run time
  ENUM: 4,
}

/** A standard function block's number outputs: a counter's value is an INT, a timer's elapsed time a TIME. */
const FB_MEMBER: Record<string, number> = { CV: 4, PV: 4, ET: 11, PT: 11 }

/** The OPC UA type a variable is published as: from its declaration, else (a function block's member) from its value. */
export function builtinFor(name: string, info: VarInfo | undefined, value: TagValue): number {
  if (info) return BUILTIN_OF[info.type]
  if (typeof value === 'boolean') return 1
  if (typeof value === 'string') return 12
  return FB_MEMBER[name.slice(name.lastIndexOf('.') + 1).toUpperCase()] ?? 11
}

/** A variable's value as its node holds it. */
export function toServerValue(builtin: number, v: TagValue | undefined): boolean | number | string {
  if (builtin === 1) return v === true || (typeof v === 'number' && v !== 0)
  if (builtin === 12) return typeof v === 'string' ? v : String(v ?? '')
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** What a client wrote, as the program takes it: a Boolean node's value as a bit, a String's as text, any other as a number. Null when it is none of those. */
export function fromClientValue(builtin: number, v: unknown): TagValue | null {
  if (builtin === 1) return typeof v === 'boolean' ? v : null
  if (builtin === 12) return typeof v === 'string' ? v : null
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The program as the server reads it: a compiled link's variables and what each one is (LocalPlcLink). */
export interface PublishedProgram {
  readonly watch: Readonly<Record<string, TagValue>>
  varInfo(name: string): VarInfo | undefined
  /** bare scene tag -> the variable it names (plc/link/plcLink.ts soleInstanceAliases): a part feeding `Go` feeds `Line.Go` */
  readonly aliases?: ReadonlyMap<string, string>
}

/**
 * Every variable of the program as the server publishes it, sorted by name. `sceneFeeds` names what parts
 * write (a photo eye's tag, an address it reports on): a variable fed from one of those is read-only, since
 * the next scan takes the scene's value again. Names are compared as IEC compares them, ignoring case.
 */
export function publishedVariables(program: PublishedProgram, sceneFeeds: ReadonlySet<string>): ServerNode[] {
  const fed = new Set([...sceneFeeds].map((n) => (program.aliases?.get(n) ?? n).toLowerCase()))
  const out: ServerNode[] = []
  for (const [name, value] of Object.entries(program.watch)) {
    const info = program.varInfo(name)
    const builtin = builtinFor(name, info, value)
    const fromScene = fed.has(name.toLowerCase()) || (info?.location !== undefined && fed.has(info.location.toLowerCase()))
    out.push({ name, builtin, writable: info !== undefined && !info.constant && !fromScene, value: toServerValue(builtin, value) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export interface OpcUaServerStatus {
  state: 'off' | 'starting' | 'serving' | 'failed'
  /** `opc.tcp://127.0.0.1:4843`, once listening */
  endpoint: string
  /** the clients with a session open, by name and address */
  clients: string[]
  /** how many variables are published, and how many of them a client may write */
  variables: number
  writable: number
  /** whether the published values are live: the simulation runs a program here */
  live: boolean
  /** "Start := TRUE", the last write a client made */
  lastWrite: string | null
  error: string | null
}

export const OPC_UA_SERVER_OFF: OpcUaServerStatus = { state: 'off', endpoint: '', clients: [], variables: 0, writable: 0, live: false, lastWrite: null, error: null }

/** A value as the program's text would write it: TRUE, 12.5, 'idle'. */
function literal(v: TagValue): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'string') return `'${v}'`
  return String(v)
}

/**
 * One server, for as long as it is switched on (not for one run: a SCADA stays connected across Stop and Play).
 * The controller tells it what to publish ({@link publish}) and hands it the variables each frame
 * ({@link update}); a client's write comes back through `onWrite`, for the controller to hand the running program.
 */
export class OpcUaServerSession {
  private state: OpcUaServerStatus['state'] = 'starting'
  private endpoint = ''
  private clients: string[] = []
  private error: string | null = null
  private closed = false
  private started: Promise<void> | null = null
  /** what is published, by name */
  private nodes = new Map<string, ServerNode>()
  /** what the shell was last told: each value, and whether the values were live */
  private readonly sent = new Map<string, TagValue>()
  private sentLive: boolean | null = null
  private live = false
  /** the watch object last read, so a frame that carries the same one is not diffed again */
  private lastWatch: object | null = null
  private lastWrite: string | null = null
  private pending: ServerNode[] | null = null
  private readonly unsubscribe: (() => void)[] = []

  constructor(
    private readonly host: OpcUaServerHost,
    readonly settings: { port: number; network: boolean },
    /** a client wrote these variables: hand them to the running program */
    private readonly onWrite: (values: Record<string, TagValue>) => void,
    private readonly onChange: () => void,
  ) {}

  start(): Promise<void> {
    this.started ??= this.open()
    return this.started
  }

  private async open(): Promise<void> {
    this.unsubscribe.push(
      this.host.onWrite((e) => this.written(e.name, e.value)),
      this.host.onClients((e) => {
        this.clients = e.clients
        this.onChange()
      }),
    )
    const { error, endpoint } = await this.host.start(this.settings)
    if (this.closed) return
    if (error) {
      this.state = 'failed'
      this.error = error
      this.onChange()
      return
    }
    this.state = 'serving'
    this.endpoint = endpoint
    this.onChange()
    const nodes = this.pending
    this.pending = null
    if (nodes) await this.define(nodes)
  }

  /** Publish exactly these variables (a node kept by name and type keeps its subscriptions). */
  publish(nodes: ServerNode[]): void {
    if (this.state !== 'serving') {
      this.pending = nodes
      return
    }
    void this.define(nodes)
  }

  private async define(nodes: ServerNode[]): Promise<void> {
    this.nodes = new Map(nodes.map((n) => [n.name, n]))
    this.sent.clear()
    for (const n of nodes) this.sent.set(n.name, n.value)
    this.lastWatch = null
    const { error } = await this.host.define({ nodes })
    if (this.closed) return
    this.error = error ? `could not publish the program's variables: ${error}` : null
    this.onChange()
  }

  /**
   * One frame: the program's variables as they stand, and whether they are live (the simulation runs a
   * program here). Only what changed crosses to the shell, and nothing when the frame carries the same watch.
   */
  update(watch: Readonly<Record<string, TagValue>> | null, live: boolean): void {
    if (this.state !== 'serving') return
    const liveChanged = live !== this.sentLive
    if (live !== this.live) {
      this.live = live
      this.onChange()
    }
    const values: Record<string, TagValue> = {}
    if (watch && watch !== this.lastWatch) {
      this.lastWatch = watch
      forEachWatchValue(watch, (name, v) => {
        const node = this.nodes.get(name)
        if (!node) return
        const value = toServerValue(node.builtin, v)
        if (this.sent.get(name) === value) return
        this.sent.set(name, value)
        values[name] = value
      })
    }
    if (!liveChanged && Object.keys(values).length === 0) return
    this.sentLive = live
    this.host.update({ values, running: live })
  }

  private written(name: string, raw: unknown): void {
    const node = this.nodes.get(name)
    if (!node || !node.writable || !this.live) return
    const value = fromClientValue(node.builtin, raw)
    if (value === null) return
    this.sent.set(name, value) // the node holds it already; the frame that confirms it need not send it back
    this.lastWrite = `${name} := ${literal(value)}`
    this.onWrite({ [name]: value })
    this.onChange()
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const u of this.unsubscribe.splice(0)) u()
    await this.host.stop()
  }

  status(): OpcUaServerStatus {
    const nodes = [...this.nodes.values()]
    return {
      state: this.closed ? 'off' : this.state,
      endpoint: this.endpoint,
      clients: this.closed ? [] : this.clients,
      variables: nodes.length,
      writable: nodes.filter((n) => n.writable).length,
      live: this.live,
      lastWrite: this.lastWrite,
      error: this.error,
    }
  }
}

/** The server's state in a sentence, for Controller Properties. */
export function serverStatusLine(s: OpcUaServerStatus, running: boolean): string {
  if (s.state === 'off') return 'Off.'
  if (s.state === 'starting') return 'Opening the port…'
  if (s.state === 'failed') return `Could not start the server: ${s.error ?? 'unknown error'}`
  const who = s.clients.length === 0 ? 'no client connected' : `${s.clients.length} connected (${s.clients.join(', ')})`
  const what = s.variables === 0 ? 'no variables yet (they are published when the program compiles)' : `${s.variables} variables, ${s.writable} writable`
  const when = s.live ? '' : running ? '. The program here is not running, so they read as out of service' : '. Stopped: they read as out of service until Play'
  return `Serving ${s.endpoint}: ${who}, ${what}${when}.${s.error ? ` ${s.error}` : ''}`
}

/**
 * What to try next when no client gets in: a second line under serverStatusLine, null when there is nothing to add.
 * The client connects IN, so the advice is about this computer: the network switch, the address, the firewall.
 */
export function serverStatusHint(s: OpcUaServerStatus): string | null {
  if (s.state === 'failed') {
    return /already in use/.test(s.error ?? '')
      ? 'Another program on this computer holds that port (often an OPC UA discovery server, or a PLC runtime\'s own server): choose another port here.'
      : null
  }
  if (s.state !== 'serving' || s.clients.length > 0) return null
  if (/^opc\.tcp:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s.endpoint))
    return 'Only a client on this computer can connect. For a SCADA or HMI elsewhere on the network, tick Reachable from the network.'
  const port = /:(\d+)/.exec(s.endpoint.slice('opc.tcp://'.length))?.[1]
  return `In the client, connect to ${s.endpoint} with security policy None and an anonymous login, and allow ${port ? `port ${port}` : 'its port'} inbound in this computer's firewall.`
}
