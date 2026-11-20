// What every link has in common where the simulator is the client of the PLC: the step loop and its pacing, the
// retries, the watchdog, the hand-over of the PLC's outputs to the scene, stop, and the half of the status that
// reads the same for every protocol. editor/links/externalPlc.ts holds the protocols' sessions; this is what they share.
//
// Two families sit on it:
//   NamedLink   tags by name through a desktop-shell client that speaks the protocol (OPC UA, EtherNet/IP, ADS):
//               open, find each tag once (bind), then cycle; per-tag problems as the PLC reports them
//   SocketLink  our own protocol code over the desktop shell's TCP socket (Modbus client, S7): connect, set the
//               connection up, then poll; requests matched to their answers by a key, each with a timeout
// A session says only what is particular to its protocol; everything a fix to retry or watchdog behaviour touches
// is here once.
//
// Not the Modbus server session (ExternalPlcSession): there the PLC polls the simulator, and none of this applies.

import type { TagValue } from '../../plc/types'
import type { ExternalPlcLink, ExternalPlcStatus, PlcIoHost } from './externalPlc'

/**
 * How long the link waits for an answer before it decides the PLC is gone.
 *
 * Why it de-energises rather than holding. A PLC that stops answering - its program stopped, its cable
 * pulled, the process killed - leaves its last outputs in the image, and holding them runs the line
 * forever on a value nobody is driving any more. The case that matters is the ordinary one: you stop the
 * PLC to edit its program, and a simulator that keeps the belt running teaches the opposite of what the
 * floor does. Real remote I/O faults to its safe state for the same reason, which is why OpenPLC's own
 * device configuration makes you choose (`error_handling: keep-last-value` or `set-to-zero`).
 *
 * 1 s is ~50 missed polls at the 20 ms cadence the loop measures: unambiguous, and far enough from a
 * scan's jitter that a busy master is never called dead. The scene keeps running - the line coasts to a
 * halt, which is what you would watch happen - and the dock says which state the link is in, because the
 * one thing worse than either policy is not knowing which one you are getting (comms that hold last
 * values on a failed read but zero a whole tag group on a connect error, invisibly).
 */
export const POLL_TIMEOUT_MS = 1000

/** The client's pace: one cycle (a write and a read) every 20 ms, the cadence the loops measure. */
export const CLIENT_POLL_MS = 20
/** How long a request may go unanswered before the cycle fails; well inside the watchdog's second. */
export const CLIENT_ANSWER_MS = 500
/** How long to wait before connecting again, after the PLC refused or dropped the connection. */
export const CLIENT_RETRY_MS = 1000

/** What the shell answers a call made when it holds no link for this window (apps/desktop/*Io.cjs). */
export const NOT_CONNECTED = 'not connected'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The life every client link shares. A subclass's `step` does one round of its protocol and says when to come back
 * (or null to stop for good); `latch`, `outputs` and `offOutputs` move values; `linkUp` says whether the PLC is there
 * at all, which is half of what the watchdog reads.
 */
export abstract class PolledLink implements ExternalPlcLink {
  abstract readonly driven: string[]
  protected state: ExternalPlcStatus['state'] = 'starting'
  protected error: string | null = null
  protected closed = false
  /** when a cycle last completed, which is what the watchdog reads */
  protected lastAnswerAt: number | null = null
  protected stale = false
  /** not before this, the next connect or bind */
  protected retryAt = 0
  private lastOut = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    protected readonly onChange: () => void,
    protected readonly now: () => number,
  ) {}

  abstract start(initial: Readonly<Record<string, TagValue>>): Promise<void>
  abstract status(): ExternalPlcStatus
  /** One round of the protocol, begun at `started`: the ms until the next round, or null to stop for good. */
  protected abstract step(started: number): Promise<number | null>
  /** Keep what the parts report, for the next write. */
  protected abstract latch(simTags: Readonly<Record<string, TagValue>>): void
  /** What the PLC last wrote, as scene tags. */
  protected abstract outputs(): Record<string, number | boolean>
  /** Every tag the PLC drives, at the value it holds when nothing drives it. */
  protected abstract offOutputs(): Record<string, number | boolean>
  /** Whether the PLC is reachable at all: connected, set up, its tags found. */
  protected abstract linkUp(): boolean
  /** Let go of the host's resources, after the loop has stopped. */
  protected abstract shutdown(): Promise<void>

  /** Run one round, then schedule the next; the loop ends when `step` says so or the link stops. */
  protected async tick(): Promise<void> {
    this.timer = null
    if (this.closed) return
    const started = this.now()
    let ms: number | null
    try {
      ms = await this.step(started)
    } catch (e) {
      // a host call that threw instead of answering: say so, and try again as after any failure
      this.setError(message(e))
      ms = CLIENT_RETRY_MS
    }
    if (this.closed || ms === null) return
    this.timer = setTimeout(() => void this.tick(), Math.max(0, ms))
  }

  protected setError(error: string | null): void {
    if (error === this.error) return
    this.error = error
    this.onChange()
  }

  /** A cycle completed: what the watchdog measures from. */
  protected answered(): void {
    this.lastAnswerAt = this.now()
  }

  /**
   * One frame's exchange: latch what the parts reported, and return what the PLC's outputs last read when it differs
   * from what was handed over (null otherwise, so an idle link posts nothing).
   *
   * The watchdog: once the PLC has answered at least once, no completed cycle for {@link POLL_TIMEOUT_MS} - or the
   * link down - hands over the outputs' off state instead, so the line stops rather than running on a value nobody
   * drives. Not armed before the first answer: the outputs are off then anyway, and "waiting for the PLC" is what
   * the status already says.
   */
  exchange(simTags: Readonly<Record<string, TagValue>>): Record<string, number | boolean> | null {
    this.latch(simTags)
    const stale = this.lastAnswerAt !== null && (!this.linkUp() || this.now() - this.lastAnswerAt > POLL_TIMEOUT_MS)
    if (stale !== this.stale) {
      this.stale = stale
      this.onChange() // the dock says which state the link is in
    }
    const out = stale ? this.offOutputs() : this.outputs()
    const key = JSON.stringify(out)
    if (key === this.lastOut) return null
    this.lastOut = key
    return out
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    await this.shutdown()
  }

  /** The status fields every link fills the same way. */
  protected commonStatus(): Pick<ExternalPlcStatus, 'state' | 'stale' | 'sinceLastRequestMs' | 'error'> {
    return {
      state: this.closed ? 'off' : this.state,
      stale: this.stale,
      sinceLastRequestMs: this.lastAnswerAt === null ? null : Math.max(0, this.now() - this.lastAnswerAt),
      error: this.error,
    }
  }
}

/** A tag a by-name link carries. */
export interface NamedPoint {
  tag: string
  dir: 'toPlc' | 'fromPlc'
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
}

/**
 * Tags by name, through a desktop-shell client that speaks the protocol: open (once, or again after the shell lost the
 * link), find each tag on the PLC (bind: its node, its type, its handle), then one cycle every {@link CLIENT_POLL_MS} -
 * write what the parts publish, read what the PLC drives. A PLC that stops answering is bound anew a second later,
 * since a PLC that was downloaded again may hold different tags.
 */
export abstract class NamedLink<P extends NamedPoint, B extends P> extends PolledLink {
  readonly driven: string[]
  /** the points bound to the PLC's tags; null before the PLC has answered for them */
  protected bindings: B[] | null = null
  protected bindProblems: string[] = []
  /** a tag that answered a write or read badly, until it answers well again */
  private readonly itemProblems = new Map<string, string>()
  /** what the parts last reported, and what the PLC's tags last held, by tag */
  protected readonly sim: Record<string, TagValue> = {}
  protected readonly plc: Record<string, boolean | number> = {}
  protected cycles = 0

  constructor(
    readonly points: readonly P[],
    protected readonly problems: string[],
    onChange: () => void,
    now: () => number,
  ) {
    super(onChange, now)
    this.driven = points.filter((p) => p.dir === 'fromPlc').map((p) => p.tag)
  }

  /** Whether the shell holds an open link for this session. */
  protected abstract isOpen(): boolean
  /** Open the link: 'up', 'retry' (the error said, try again in a second), or 'failed' (retrying cannot help). */
  protected abstract open(): Promise<'up' | 'retry' | 'failed'>
  /** Find every point's tag on the PLC (calling {@link bound} when it has). False when it could not be read. */
  protected abstract bind(): Promise<boolean>
  /** One cycle's requests (calling {@link cycled} when the PLC answered). */
  protected abstract cycle(writing: B[], reading: B[]): Promise<void>

  async start(initial: Readonly<Record<string, TagValue>>): Promise<void> {
    Object.assign(this.sim, initial)
    this.attach()
    await this.tick()
  }

  /** Subscribe to the shell's events, before the first round. */
  protected attach(): void {}

  protected async step(started: number): Promise<number | null> {
    if ((!this.isOpen() || this.bindings === null) && started < this.retryAt) return this.retryAt - started
    if (!this.isOpen()) {
      const opened = await this.open()
      if (this.closed || opened === 'failed') return null
      if (opened === 'retry') return CLIENT_RETRY_MS
    }
    if (this.bindings === null) {
      const found = await this.bind()
      if (this.closed) return null
      if (!found) return CLIENT_RETRY_MS
    }
    const bindings = this.bindings ?? []
    const writing = bindings.filter((b) => b.dir === 'toPlc' && this.sim[b.tag] !== undefined)
    const reading = bindings.filter((b) => b.dir === 'fromPlc')
    if (writing.length > 0 || reading.length > 0) await this.cycle(writing, reading)
    if (this.closed) return null
    return CLIENT_POLL_MS - (this.now() - started)
  }

  /** The tags are found: poll them. */
  protected bound(bindings: B[], problems: string[]): void {
    this.bindings = bindings
    this.bindProblems = problems
    this.state = 'polling'
    this.error = null
    this.onChange()
  }

  /** Could not be read this time: say why, and bind again after a pause. */
  protected bindFailed(why: string): false {
    this.retryAt = this.now() + CLIENT_RETRY_MS
    this.setError(why)
    return false
  }

  /** The PLC went away: forget its tags, and find them again after a pause. */
  protected dropped(why: string): void {
    if (this.closed) return
    this.bindings = null
    this.retryAt = this.now() + CLIENT_RETRY_MS
    this.state = 'starting'
    this.error = why
    this.onChange()
  }

  /**
   * The PLC answered a cycle: each item's problem (null = answered well) and the values it read. Problems change the
   * dock only when they change; the error, if any, is cleared.
   */
  protected cycled(notes: readonly (readonly [string, string | null])[], values: readonly (readonly [string, boolean | number])[]): void {
    let changed = false
    for (const [tag, bad] of notes) {
      if ((this.itemProblems.get(tag) ?? null) === bad) continue
      if (bad) this.itemProblems.set(tag, bad)
      else this.itemProblems.delete(tag)
      changed = true
    }
    for (const [tag, v] of values) this.plc[tag] = v
    this.cycles++
    this.answered()
    if (this.error !== null) {
      this.error = null
      changed = true
    }
    if (changed) this.onChange()
  }

  protected latch(simTags: Readonly<Record<string, TagValue>>): void {
    Object.assign(this.sim, simTags)
  }

  protected linkUp(): boolean {
    return this.bindings !== null
  }

  /** A point's value when nothing drives it. */
  protected offValue(p: P): boolean | number {
    return p.type === 'BOOL' || p.type === null ? false : 0
  }

  protected outputs(): Record<string, number | boolean> {
    const out: Record<string, number | boolean> = {}
    for (const p of this.points) if (p.dir === 'fromPlc') out[p.tag] = this.plc[p.tag] ?? this.offValue(p)
    return out
  }

  protected offOutputs(): Record<string, number | boolean> {
    const out: Record<string, number | boolean> = {}
    for (const p of this.points) if (p.dir === 'fromPlc') out[p.tag] = this.offValue(p)
    return out
  }

  /** The status, with what a by-name link reports the same way: cycles, and every problem it knows of. */
  protected namedStatus(fields: Pick<ExternalPlcStatus, 'mode' | 'endpoint' | 'masters' | 'points'>): ExternalPlcStatus {
    return {
      ...fields,
      ...this.commonStatus(),
      requests: this.cycles === 0 ? '' : `${this.cycles} read/write cycles`,
      driven: this.driven,
      problems: [...this.problems, ...this.bindProblems, ...this.itemProblems.values()],
    }
  }
}

/** The surface a protocol's poller offers (plc/link/modbusClient.ts ModbusPoller, plc/link/s7Client.ts S7Poller). */
export interface Poller {
  writeSimTags(tags: Readonly<Record<string, TagValue>>): void
  plcTags(): Record<string, TagValue>
  offTags(): Record<string, TagValue>
  poll(transact: (pdu: Uint8Array) => Promise<Uint8Array>): Promise<void>
}

/**
 * Our own protocol code over the desktop shell's TCP socket: connect, set the connection up (nothing for Modbus; the
 * COTP connect and the PDU negotiation for S7), then one poll every {@link CLIENT_POLL_MS}. A PLC that is not up yet is
 * retried every {@link CLIENT_RETRY_MS}; one that goes away is retried the same way.
 *
 * The subclass frames requests and reads the stream (`frame`, `receive`); this matches answers to requests by the key
 * framing gave them, and fails a request no answer reaches within {@link CLIENT_ANSWER_MS}.
 */
export abstract class SocketLink<P extends Poller> extends PolledLink {
  /** the connection being polled; `ready` once it is set up */
  protected connId: number | null = null
  protected ready = false
  /** connections the host reported closed before its connect call returned their id */
  private readonly closedEarly = new Set<number>()
  private readonly waiting = new Map<number, { resolve: (pdu: Uint8Array) => void; reject: (e: Error) => void }>()
  private readonly unsubscribe: (() => void)[] = []

  constructor(
    protected readonly host: PlcIoHost,
    readonly poller: P,
    private readonly target: { host: string; port: number },
    onChange: () => void,
    now: () => number,
  ) {
    super(onChange, now)
  }

  protected abstract get endpoint(): string
  /** A fresh connection's framing state. */
  protected abstract newStream(): void
  /** Wrap a request for the wire: the bytes, and the key its answer will carry. */
  protected abstract frame(pdu: Uint8Array): { key: number; bytes: Uint8Array }
  /** Bytes from the connection: the answers in them by key, and a reason to drop the connection (not this protocol, refused). */
  protected abstract receive(bytes: Uint8Array): { answers: { key: number; pdu: Uint8Array }[]; drop: string | null }
  /** Why the request timed out, in the protocol's words. */
  protected abstract timeoutMessage(pdu: Uint8Array): string
  /** What the dock says when the PLC closes the connection. */
  protected abstract closedMessage(): string

  /** Set a fresh connection up before the first poll; throws to drop it. */
  protected async setUp(_id: number): Promise<void> {}
  /** How long to wait after a poll that failed with `e`: the next cycle's pace unless the protocol says otherwise. */
  protected pauseAfter(_e: unknown): number {
    return CLIENT_POLL_MS
  }
  /** The connection is gone: anything the subclass holds for it goes too. */
  protected forget(_why: string): void {}

  async start(initial: Readonly<Record<string, TagValue>>): Promise<void> {
    this.poller.writeSimTags(initial)
    this.unsubscribe.push(
      this.host.onConnection((e) => {
        if (e.open) return
        if (e.id !== this.connId) {
          this.closedEarly.add(e.id)
          return
        }
        this.dropped(this.closedMessage())
      }),
      this.host.onData((e) => {
        if (e.id !== this.connId) return
        const { answers, drop } = this.receive(e.bytes)
        for (const a of answers) {
          const w = this.waiting.get(a.key)
          if (!w) continue // the answer to a request that already timed out
          this.waiting.delete(a.key)
          w.resolve(a.pdu)
        }
        if (drop) {
          this.host.drop(e.id)
          this.dropped(drop)
        }
      }),
    )
    await this.tick()
  }

  /** The connection is gone: fail what was waiting on it, and connect again after a pause. */
  protected dropped(why: string): void {
    if (this.closed) return
    this.connId = null
    this.ready = false
    for (const w of this.waiting.values()) w.reject(new Error(why))
    this.waiting.clear()
    this.forget(why)
    this.retryAt = this.now() + CLIENT_RETRY_MS
    this.state = 'starting'
    this.error = why
    this.onChange()
  }

  /** One request over the connection, answered or timed out: the shape a poller takes. */
  protected readonly transact = (pdu: Uint8Array): Promise<Uint8Array> => {
    const id = this.connId
    if (id === null) return Promise.reject(new Error(NOT_CONNECTED))
    const { key, bytes } = this.frame(pdu)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key)
        reject(new Error(this.timeoutMessage(pdu)))
      }, CLIENT_ANSWER_MS)
      this.waiting.set(key, {
        resolve: (res) => {
          clearTimeout(timer)
          resolve(res)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.host.write(id, bytes)
    })
  }

  protected async step(started: number): Promise<number | null> {
    if (this.connId === null) {
      if (started < this.retryAt) return this.retryAt - started
      const { error, id } = await this.host.connect(this.target)
      if (this.closed) return null
      if (error || this.closedEarly.has(id)) {
        this.retryAt = this.now() + CLIENT_RETRY_MS
        this.setError(error || this.closedMessage())
        return CLIENT_RETRY_MS
      }
      this.connId = id
      this.newStream()
      try {
        await this.setUp(id)
        if (this.closed) return null
      } catch (e) {
        if (this.closed) return null
        // a drop already said why and scheduled the retry; anything else leaves a connection to let go of
        if (this.connId !== null) {
          this.host.drop(id)
          this.dropped(message(e))
        }
        return this.retryAt - this.now()
      }
      this.ready = true
      this.state = 'polling'
      this.error = null
      this.onChange()
    }
    let pause = CLIENT_POLL_MS
    try {
      await this.poller.poll(this.transact)
      if (this.closed) return null
      this.answered()
      this.setError(null)
    } catch (e) {
      if (this.closed) return null
      this.setError(message(e))
      pause = this.pauseAfter(e)
    }
    return pause - (this.now() - started)
  }

  protected latch(simTags: Readonly<Record<string, TagValue>>): void {
    this.poller.writeSimTags(simTags)
  }

  protected outputs(): Record<string, number | boolean> {
    return this.poller.plcTags() as Record<string, number | boolean>
  }

  protected offOutputs(): Record<string, number | boolean> {
    return this.poller.offTags() as Record<string, number | boolean>
  }

  protected linkUp(): boolean {
    return this.ready
  }

  protected async shutdown(): Promise<void> {
    for (const u of this.unsubscribe.splice(0)) u()
    for (const w of this.waiting.values()) w.reject(new Error('the run stopped'))
    this.waiting.clear()
    this.forget('the run stopped')
    this.connId = null
    this.ready = false
    await this.host.close()
  }

  /** The PLC, while connected and set up: what a status's `masters` lists. */
  protected masters(): string[] {
    return this.ready && !this.closed ? [this.endpoint] : []
  }
}
