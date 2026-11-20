// One run's link to a MELSEC CPU over SLMP: the session the dock runs for the `slmp` mode.
//
// Loaded only when a run uses it (editor/links/externalPlc.ts DeferredLink), with the protocol it carries
// (plc/link/slmpClient.ts), so nothing of SLMP reaches the first frame.
//
// The same lifecycle as the S7 session's, both on clientLink.ts SocketLink: connect to the CPU, then one cycle
// every CLIENT_POLL_MS - write what the parts report, read what the PLC drives - for as long as the run lasts,
// with its retries and watchdog. SLMP has no session to set up: the first request goes out on a fresh
// connection. An answer is matched to its request by their order (the protocol carries no id), which
// plc/link/slmpClient.ts SlmpStream holds.
//
// A refused request is not a lost connection: the CPU answers with an end code, the connection stays up, so
// the link keeps it, says why in the dock, and asks again once a second rather than fifty times.

import { describeSlmpPoint, slmpDrivenTags, slmpEndpoint } from '../../core/io/slmpIo'
import type { SlmpClientIo } from '../../core/io/slmpIo'
import { describeSlmpStats, SlmpError, SlmpPoller, SlmpStream } from '../../plc/link/slmpClient'
import { CLIENT_ANSWER_MS, CLIENT_POLL_MS, CLIENT_RETRY_MS, SocketLink } from './clientLink'
import type { ExternalPlcStatus, PlcIoHost } from './externalPlc'

export class ExternalPlcSlmpSession extends SocketLink<SlmpPoller> {
  readonly driven: string[]
  private stream: SlmpStream | null = null
  /** requests this connection sent: SLMP answers in order, and the stream matches them by this key */
  private key = 0
  /** the last request came back refused: the dock says "Waiting for the PLC", not "Reading and writing" */
  private refusing = false

  constructor(
    host: PlcIoHost,
    readonly io: SlmpClientIo,
    private readonly problems: string[],
    onChange: () => void,
    now: () => number = () => Date.now(),
  ) {
    super(host, new SlmpPoller(io), { host: io.host, port: io.port }, onChange, now)
    this.driven = slmpDrivenTags(io)
  }

  protected get endpoint(): string {
    return slmpEndpoint(this.io)
  }

  protected newStream(): void {
    this.stream = new SlmpStream()
  }

  protected forget(_why: string): void {
    this.refusing = false
    this.stream = null
  }

  protected frame(pdu: Uint8Array): { key: number; bytes: Uint8Array } {
    const key = ++this.key
    return { key, bytes: this.stream!.frame(pdu, key) }
  }

  protected receive(bytes: Uint8Array): { answers: { key: number; pdu: Uint8Array }[]; drop: string | null } {
    const stream = this.stream
    if (!stream) return { answers: [], drop: null }
    return {
      answers: stream.push(bytes).map(({ key, response }) => ({ key, pdu: response })),
      drop: stream.error ? `the PLC sent something that is not a 3E response: ${stream.error}` : null,
    }
  }

  protected timeoutMessage(): string {
    return `no answer from the PLC within ${CLIENT_ANSWER_MS} ms`
  }

  protected closedMessage(): string {
    return `the PLC closed the connection (${this.endpoint})`
  }

  /** The CPU refused a request: it will refuse the next one too until someone changes it, so ask once a second. */
  protected pauseAfter(e: unknown): number {
    this.refusing = e instanceof SlmpError
    return this.refusing ? CLIENT_RETRY_MS : CLIENT_POLL_MS
  }

  protected answered(): void {
    this.refusing = false
    super.answered()
  }

  status(): ExternalPlcStatus {
    const common = this.commonStatus()
    return {
      mode: 'slmp',
      ...common,
      // connected, but nothing gets through: still waiting for the PLC, as the dock says it while nothing listens
      state: this.refusing && common.state === 'polling' ? 'starting' : common.state,
      endpoint: this.endpoint,
      masters: this.masters(),
      requests: describeSlmpStats(this.poller.stats),
      driven: this.driven,
      points: this.io.points.map(describeSlmpPoint),
      problems: this.problems,
    }
  }
}
