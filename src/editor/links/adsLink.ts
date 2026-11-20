// One run's link to a TwinCAT runtime over ADS: the session the dock runs for the `ads` mode.
//
// Loaded only when a run uses it (editor/links/externalPlc.ts adsLink, a DeferredLink). A by-name link on clientLink.ts
// NamedLink, like OPC UA and EtherNet/IP: open an ADS port on TwinCAT's router, ask the runtime for each scene tag's
// symbol once (its type, size and a handle), then one cycle every CLIENT_POLL_MS - write what the parts publish, read
// what the PLC drives - for as long as the run lasts, with the shared retries and watchdog.
//
// The runtime refuses a request in two ways, handled differently (core/io/ads.ts):
//   - unreachable (no route, TwinCAT stopped or in Config mode, no answer in time): every request fails at once, the
//     outputs go off, and the symbols are asked for again a second later;
//   - stale handles (the PLC was downloaded again: symbol version changed, symbol not active): not a fault, the link
//     binds anew at once, rather than leaving the user to clear tag groups by hand.
// Like EtherNet/IP and OPC UA, a PLC that is merely stopped still answers with its last values, so the watchdog cannot
// see it.

import { adsRouteText, adsStale, adsSymbolMessage, adsUnreachable, bindAdsPoint, fromAdsValue, toAdsValue } from '../../core/io/ads'
import type { AdsBinding, AdsPoint } from '../../core/io/ads'
import { NamedLink, NOT_CONNECTED } from './clientLink'
import { adsEndpoint, describeAdsPoint } from './externalPlc'
import type { AdsHost, ExternalPlcStatus } from './externalPlc'

export class ExternalPlcAdsSession extends NamedLink<AdsPoint, AdsBinding> {
  private opened = false
  /** this PC's AMS Net ID, as the router reported it: what a PLC's route has to name */
  private localNetId = ''

  constructor(
    private readonly host: AdsHost,
    readonly netId: string,
    readonly port: number,
    points: readonly AdsPoint[],
    problems: string[],
    onChange: () => void,
    now: () => number = () => Date.now(),
  ) {
    super(points, problems, onChange, now)
  }

  private get endpoint(): string {
    return adsEndpoint(this.netId, this.port)
  }

  /** "target machine not found: add a route ... (0x7). This PC's AMS Net ID is ...": a code, with this PC's Net ID where a route is the cure. */
  private codeText(code: number): string {
    return adsRouteText(code, this.localNetId)
  }

  protected isOpen(): boolean {
    return this.opened
  }

  protected async open(): Promise<'up' | 'retry' | 'failed'> {
    const r = await this.host.open({ netId: this.netId, port: this.port })
    if (this.closed) return 'failed'
    if (r.error) {
      // no TwinCAT, no router, a target refused: retrying changes none of them
      this.state = 'failed'
      this.error = r.error
      this.onChange()
      return 'failed'
    }
    this.opened = true
    this.localNetId = r.localNetId ?? ''
    return 'up'
  }

  /** Ask the runtime for every symbol once. False when it could not be reached (the link then retries). */
  protected async bind(): Promise<boolean> {
    const r = this.points.length === 0 ? { error: '', tags: [] } : await this.host.bind({ tags: this.points.map((p) => ({ name: p.tag })) })
    if (this.closed) return false
    if (r.error || !r.tags) {
      // the shell holds no link for this window any more: open it again
      if (r.error === NOT_CONNECTED) this.opened = false
      return this.bindFailed(r.error || 'the desktop shell did not answer')
    }
    const codes = r.tags.map((t) => t.code)
    if (codes.length > 0 && codes.every(adsUnreachable)) return this.bindFailed(this.codeText(codes[0]!))
    const bindings: AdsBinding[] = []
    const problems: string[] = []
    this.points.forEach((p, i) => {
      const t = r.tags![i]
      if (!t || t.code !== 0 || t.adsType === undefined) {
        problems.push(adsSymbolMessage(p.tag, t?.code ?? 0x745))
        return
      }
      const b = bindAdsPoint(p, t.adsType, t.size ?? 0, t.typeName ?? '')
      if ('error' in b) problems.push(b.error)
      else bindings.push(b.binding)
    })
    this.bound(bindings, problems)
    return true
  }

  protected async cycle(writing: AdsBinding[], reading: AdsBinding[]): Promise<void> {
    const r = await this.host.exchange({
      writes: writing.map((b) => ({ name: b.tag, value: toAdsValue(b.adsType, this.sim[b.tag]) })),
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
    const codes = [...(r.writes ?? []), ...(r.reads ?? []).map((x) => x.status)]
    if (codes.length > 0 && codes.every(adsUnreachable)) {
      this.dropped(`the PLC stopped answering: ${this.codeText(codes[0]!)}`)
      return
    }
    if (codes.some(adsStale)) {
      // the PLC was downloaded again under the link: its handles are gone, so bind anew without waiting
      this.bindings = null
      return
    }
    const bad = (tag: string, code: number | undefined, what: string): string | null => (code !== undefined && code !== 0 ? `${adsSymbolMessage(tag, code)} (on ${what})` : null)
    this.cycled(
      [...writing.map((b, i) => [b.tag, bad(b.tag, r.writes?.[i], 'write')] as const), ...reading.map((b, i) => [b.tag, bad(b.tag, r.reads?.[i]?.status, 'read')] as const)],
      reading.flatMap((b, i) => {
        const got = r.reads?.[i]
        return got && got.status === 0 ? [[b.tag, fromAdsValue(b.adsType, got.value)] as const] : []
      }),
    )
  }

  protected async shutdown(): Promise<void> {
    await this.host.close()
  }

  status(): ExternalPlcStatus {
    const bound = this.bindings
    return this.namedStatus({
      mode: 'ads',
      endpoint: this.endpoint,
      masters: this.opened && !this.closed && bound !== null ? [this.endpoint] : [],
      points: this.points.map((p) => describeAdsPoint(bound?.find((b) => b.tag === p.tag) ?? p)),
    })
  }
}
