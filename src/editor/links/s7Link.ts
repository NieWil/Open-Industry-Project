// One run's link to an S7-1200 / S7-1500 CPU over PUT/GET: the session the dock runs for the `s7` mode.
//
// Loaded only when a run uses it (editor/links/externalPlc.ts DeferredLink), with the protocol it carries
// (plc/link/s7Client.ts), so nothing of S7 reaches the first frame.
//
// The same lifecycle as the Modbus client's session, both on clientLink.ts SocketLink: connect to the CPU, then one cycle
// every CLIENT_POLL_MS - write what the parts report, read what the program drives - for as long as the run lasts,
// with its retries and watchdog. Two steps come before the first cycle, both per connection: the COTP connect, which
// names the CPU by rack and slot, and S7's setup, which agrees the PDU size every job is then cut to. An answer is
// matched to its job by the S7 job reference.
//
// A refused job is not a lost connection. The CPU answers PUT/GET jobs with an error while PUT/GET is off (or its
// protection level forbids them); the connection stays up, so the link keeps it, says why in the dock, and asks
// again once a second rather than fifty times. Until a job goes through it reports itself as still waiting for the
// CPU (state 'starting'), since nothing reaches the program yet: guides/s7/ quotes that line.

import { describeS7Point, s7DrivenTags, s7Endpoint } from '../../core/io/s7Io'
import type { S7ClientIo } from '../../core/io/s7Io'
import { connectRequest, describeS7Stats, S7Error, S7Poller, S7Stream } from '../../plc/link/s7Client'
import { CLIENT_ANSWER_MS, CLIENT_POLL_MS, CLIENT_RETRY_MS, SocketLink } from './clientLink'
import type { ExternalPlcStatus, PlcIoHost } from './externalPlc'

export class ExternalPlcS7Session extends SocketLink<S7Poller> {
  readonly driven: string[]
  private stream: S7Stream | null = null
  /** the COTP connect waiting for the CPU's confirm */
  private confirm: { resolve: () => void; reject: (e: Error) => void } | null = null
  /** the last job came back refused (PUT/GET off): the dock says "Waiting for the PLC", not "Reading and writing" */
  private refusing = false

  constructor(
    host: PlcIoHost,
    readonly io: S7ClientIo,
    private readonly problems: string[],
    onChange: () => void,
    now: () => number = () => Date.now(),
  ) {
    super(host, new S7Poller(io), { host: io.host, port: io.port }, onChange, now)
    this.driven = s7DrivenTags(io)
  }

  protected get endpoint(): string {
    return s7Endpoint(this.io)
  }

  protected newStream(): void {
    this.stream = new S7Stream()
  }

  protected forget(why: string): void {
    this.refusing = false
    this.stream = null
    this.confirm?.reject(new Error(why))
    this.confirm = null
  }

  protected frame(pdu: Uint8Array): { key: number; bytes: Uint8Array } {
    return { key: (pdu[4]! << 8) | pdu[5]!, bytes: this.stream!.frame(pdu) }
  }

  protected receive(bytes: Uint8Array): { answers: { key: number; pdu: Uint8Array }[]; drop: string | null } {
    const stream = this.stream
    if (!stream) return { answers: [], drop: null }
    const answers: { key: number; pdu: Uint8Array }[] = []
    for (const f of stream.push(bytes)) {
      if (f.kind === 'confirm') {
        this.confirm?.resolve()
        this.confirm = null
      } else if (f.kind === 'refused') {
        return { answers, drop: `the CPU refused the connection to rack ${this.io.rack}, slot ${this.io.slot}: check them (rack 0, slot 1 for an S7-1200 or S7-1500)` }
      } else if (f.pdu.length >= 6) answers.push({ key: (f.pdu[4]! << 8) | f.pdu[5]!, pdu: f.pdu })
    }
    return { answers, drop: stream.error ? `the CPU sent something that is not ISO-on-TCP: ${stream.error}` : null }
  }

  protected timeoutMessage(): string {
    return `no answer from the CPU within ${CLIENT_ANSWER_MS} ms`
  }

  protected closedMessage(): string {
    return this.ready || this.connId === null
      ? `the CPU closed the connection (${this.endpoint})`
      : 'the CPU closed the connection before it was set up: check the rack and slot (rack 0, slot 1 for an S7-1200 or S7-1500)'
  }

  /** The COTP connect, then S7's setup: the PDU size every job is cut to. */
  protected async setUp(id: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.confirm = null
        reject(new Error(`the CPU did not confirm the connection within ${CLIENT_ANSWER_MS} ms`))
      }, CLIENT_ANSWER_MS)
      this.confirm = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      this.host.write(id, connectRequest(this.io.rack, this.io.slot))
    })
    if (this.closed) return
    await this.poller.handshake(this.transact)
  }

  /** The CPU refused a job: it will refuse the next one too until someone changes it, so ask once a second. */
  protected pauseAfter(e: unknown): number {
    this.refusing = e instanceof S7Error
    return this.refusing ? CLIENT_RETRY_MS : CLIENT_POLL_MS
  }

  protected answered(): void {
    this.refusing = false
    super.answered()
  }

  status(): ExternalPlcStatus {
    const common = this.commonStatus()
    return {
      mode: 's7',
      ...common,
      // connected, but nothing gets through: still waiting for the CPU, as the dock says it while nothing listens
      state: this.refusing && common.state === 'polling' ? 'starting' : common.state,
      endpoint: this.endpoint,
      masters: this.masters(),
      requests: describeS7Stats(this.poller.stats),
      driven: this.driven,
      points: this.io.points.map(describeS7Point),
      problems: this.problems,
    }
  }
}
