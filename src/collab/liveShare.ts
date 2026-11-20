// Live share (docs/live-share.md): anyone running in a room can be watched. A runner announces its run and sends frames
// only while someone follows it; a follower asks the server for one run and draws it. The frames are
// core/live/liveFrameWire.ts messages, base64 in a Hocuspocus stateless string that the collab server sends to that
// run's followers only (server/liveRelay.mjs) and never writes into the document.

import type { BoxFrame } from '../core/frame'
import { LiveFrameDecoder, LiveFrameEncoder, type LiveWatchValue } from '../core/live/liveFrameWire'

export const LIVE_PREFIX = 'live2|'
/** one frame every this many ms: 20 Hz, which a viewer smooths (core/live/livePlayback.ts) */
export const LIVE_FRAME_MS = 50
/**
 * Frames keep going this long after the last follower leaves, so someone who looks away and back starts at once from
 * the server's kept snapshot rather than asking for a new one.
 */
export const LIVE_GRACE_MS = 10_000
/**
 * A frame is skipped while more than this is still queued on the socket: on a slow upload the viewer gets fewer frames
 * instead of falling further behind. The next frame carries every change since the last one sent.
 */
export const LIVE_MAX_QUEUED_BYTES = 32 * 1024
const RESYNC_MS = 1000

/** a live message as the server sends it: `live2|<kind>|<stream>|<body>` */
export function parseLiveMessage(payload: string): { kind: string; stream: string; body: string } | null {
  if (!payload.startsWith(LIVE_PREFIX)) return null
  const parts = payload.slice(LIVE_PREFIX.length).split('|')
  if (parts.length !== 3) return null
  const [kind, stream, body] = parts as [string, string, string]
  return { kind, stream, body }
}

/** Sends one run. A new sender is a new stream: its followers start over from a snapshot. */
export class LiveShareSender {
  private readonly enc = new LiveFrameEncoder()
  readonly stream = `${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`
  private lastSent = -Infinity
  private watchers = 0
  /** sending until then, though nobody follows (LIVE_GRACE_MS) */
  private graceUntil = -Infinity
  private snapshotWanted = false
  /** bytes sent, for the share status line */
  sentBytes = 0

  constructor(
    private readonly send: (payload: string) => void,
    private readonly now: () => number = () => performance.now(),
    /** bytes still queued on the socket */
    private readonly queued: () => number = () => 0,
  ) {
    this.send(`${LIVE_PREFIX}a|${this.stream}|`)
  }

  /** how many follow this run, as the server last said */
  get followers(): number {
    return this.watchers
  }

  /** a message from the server about this run: how many follow it (w), or a snapshot is wanted (q) */
  accept(kind: string, stream: string, body: string): void {
    if (stream !== this.stream) return
    if (kind === 'q') this.snapshotWanted = true
    else if (kind === 'w') {
      const n = Number(body)
      if (!Number.isInteger(n) || n < 0) return
      if (n === 0 && this.watchers > 0) this.graceUntil = this.now() + LIVE_GRACE_MS
      this.watchers = n
    }
  }

  /** a frame of the run, with the PLC variables at that moment; most are skipped to keep LIVE_FRAME_MS between sends */
  push(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>> | null = null): void {
    const t = this.now()
    if (this.watchers === 0 && !this.snapshotWanted && t > this.graceUntil) return
    // a little slack, so frames arriving at 60 Hz with jitter still send every third one
    if (t - this.lastSent < LIVE_FRAME_MS - 8) return
    // a snapshot is never held back: whoever waits for it sees nothing until it comes
    if (!this.snapshotWanted && this.queued() > LIVE_MAX_QUEUED_BYTES) return
    this.lastSent = t
    // the frame first, for anyone already drawing the run; then the snapshot of the same moment, for whoever waits
    this.post('d', this.enc.encode(frame, watch))
    if (this.snapshotWanted) {
      this.snapshotWanted = false
      this.post('s', this.enc.snapshot())
    }
  }

  /** the run stopped */
  end(): void {
    this.send(`${LIVE_PREFIX}e|${this.stream}|`)
  }

  private post(kind: 's' | 'd', bytes: Uint8Array): void {
    const payload = `${LIVE_PREFIX}${kind}|${this.stream}|${toBase64(bytes)}`
    this.sentBytes += payload.length
    this.send(payload)
  }
}

export interface LiveShareEvents {
  /** a frame of the followed run, as the runner's worker built it (to the wire's precision), and its PLC variables */
  frame(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>>): void
  /** the followed run ended, or this client stopped following it */
  end(): void
}

/** Follows one run at a time. Feed it the server's s, d and e messages; others are ignored. */
export class LiveShareReceiver {
  private dec: LiveFrameDecoder | null = null
  private stream: string | null = null
  private lastResync = -Infinity

  constructor(
    private readonly send: (payload: string) => void,
    private readonly on: LiveShareEvents,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** the run being followed, or null */
  get following(): string | null {
    return this.stream
  }

  /** follow this run (a stream id from someone's presence), or none; the run shows once its snapshot arrives */
  follow(stream: string | null): void {
    if (stream === this.stream) return
    if (this.stream !== null) {
      this.send(`${LIVE_PREFIX}u|${this.stream}|`)
      if (this.dec) this.on.end()
    }
    this.stream = stream
    this.dec = null
    if (stream !== null) this.send(`${LIVE_PREFIX}f|${stream}|`)
  }

  /** ask again for the run followed now, as after a reconnect, when the server has forgotten this connection */
  refollow(): void {
    if (this.stream === null) return
    if (this.dec) this.on.end()
    this.dec = null
    this.send(`${LIVE_PREFIX}f|${this.stream}|`)
  }

  accept(kind: string, stream: string, body: string): void {
    if (stream !== this.stream) return
    if (kind === 'e') {
      // the run is over; the stream id stays, so the same one is not asked for again
      if (this.dec) this.on.end()
      this.dec = null
      return
    }
    if (kind !== 's' && kind !== 'd') return
    if (kind === 's') this.dec = new LiveFrameDecoder()
    const dec = this.dec
    if (!dec) return // a frame before the snapshot this follower waits for
    let result
    try {
      result = dec.apply(fromBase64(body))
    } catch {
      result = 'gap' as const
    }
    if (result === 'gap') {
      this.resync(stream)
      return
    }
    this.on.frame(dec.frame(), dec.watch())
  }

  private resync(stream: string): void {
    const t = this.now()
    if (t - this.lastResync < RESYNC_MS) return
    this.lastResync = t
    this.send(`${LIVE_PREFIX}r|${stream}|`)
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
