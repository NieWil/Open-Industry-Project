import { describe, expect, it } from 'vitest'
import type { BoxFrame } from '../core/frame'
import { LIVE_FRAME_MS, LIVE_GRACE_MS, LIVE_MAX_QUEUED_BYTES, LiveShareReceiver, LiveShareSender, parseLiveMessage } from './liveShare'

const frame = (simTime: number, xs: number[]): BoxFrame => ({
  count: xs.length,
  ids: new Uint32Array(xs.map((_, i) => i + 1)),
  positions: new Float32Array(xs.flatMap((x) => [x, 0, 0])),
  quats: new Float32Array(xs.flatMap(() => [0, 0, 0, 1])),
  halfExtents: new Float32Array(xs.flatMap(() => [0.1, 0.1, 0.1])),
  colors: new Float32Array(xs.flatMap(() => [1, 1, 1])),
  kinds: new Uint8Array(xs.length),
  partIds: xs.map(() => null),
  simTime,
})

const kindOf = (p: string): string => parseLiveMessage(p)!.kind
/** hand a server message to a sender or receiver */
const deliver = (to: { accept(kind: string, stream: string, body: string): void }, p: string): void => {
  const m = parseLiveMessage(p)!
  to.accept(m.kind, m.stream, m.body)
}

describe('live share sender', () => {
  it('announces its run, and sends nothing until someone follows', () => {
    let now = 0
    const sent: string[] = []
    const sender = new LiveShareSender((p) => sent.push(p), () => now)
    expect(sent).toEqual([`live2|a|${sender.stream}|`])
    for (let k = 0; k < 50; k++) {
      now += LIVE_FRAME_MS
      sender.push(frame(k, [k]))
    }
    expect(sent.length).toBe(1)
  })

  it('on a request, sends the frame and then a snapshot of the same moment; frames go on while followed', () => {
    let now = 0
    const sent: string[] = []
    const sender = new LiveShareSender((p) => sent.push(p), () => now)
    sent.length = 0
    sender.accept('q', sender.stream, '')
    sender.accept('w', sender.stream, '1')
    now += LIVE_FRAME_MS
    sender.push(frame(1, [1]))
    expect(sent.map(kindOf)).toEqual(['d', 's'])
    now += LIVE_FRAME_MS
    sender.push(frame(2, [2]))
    expect(sent.map(kindOf)).toEqual(['d', 's', 'd'])
    // a message about another run changes nothing
    sender.accept('w', 'other', '0')
    expect(sender.followers).toBe(1)
  })

  it('keeps sending a while after the last follower leaves, then stops', () => {
    let now = 0
    const sent: string[] = []
    const sender = new LiveShareSender((p) => sent.push(p), () => now)
    sender.accept('w', sender.stream, '1')
    sender.accept('w', sender.stream, '0')
    sent.length = 0
    for (let t = 0; t < LIVE_GRACE_MS * 2; t += LIVE_FRAME_MS) {
      now += LIVE_FRAME_MS
      sender.push(frame(now / 1000, [now]))
    }
    const n = sent.length
    expect(n).toBeGreaterThan(LIVE_GRACE_MS / LIVE_FRAME_MS - 5)
    expect(n).toBeLessThan(LIVE_GRACE_MS / LIVE_FRAME_MS + 5)
  })

  it('skips frames while its socket is backed up, but never a wanted snapshot', () => {
    let now = 0
    let queued = 0
    const sent: string[] = []
    const sender = new LiveShareSender((p) => sent.push(p), () => now, () => queued)
    sender.accept('w', sender.stream, '1')
    sent.length = 0
    queued = LIVE_MAX_QUEUED_BYTES + 1
    now += LIVE_FRAME_MS
    sender.push(frame(1, [1]))
    expect(sent).toEqual([])
    sender.accept('q', sender.stream, '')
    now += LIVE_FRAME_MS
    sender.push(frame(2, [2]))
    expect(sent.map(kindOf)).toEqual(['d', 's'])
  })
})

describe('live share receiver', () => {
  it('follows one run at a time, drawing it from its snapshot on', () => {
    let now = 0
    const out: string[] = []
    const sender = new LiveShareSender((p) => out.push(p), () => now)
    const asks: string[] = []
    const got: number[] = []
    let ended = 0
    const viewer = new LiveShareReceiver((p) => asks.push(p), { frame: (f) => got.push(f.positions[0]!), end: () => ended++ }, () => now)
    viewer.follow(sender.stream)
    expect(asks).toEqual([`live2|f|${sender.stream}|`])
    // the server asks the runner for a snapshot; frames before it are not drawn
    sender.accept('q', sender.stream, '')
    sender.accept('w', sender.stream, '1')
    out.length = 0
    for (let k = 1; k <= 40; k++) {
      now += LIVE_FRAME_MS
      sender.push(frame(k, [k]))
      for (const p of out.splice(0)) deliver(viewer, p)
    }
    expect(got[0]).toBe(1)
    expect(got[got.length - 1]).toBe(40)
    // following someone else stops this run and says so
    viewer.follow('another')
    expect(asks.slice(1)).toEqual([`live2|u|${sender.stream}|`, 'live2|f|another|'])
    expect(ended).toBe(1)
    // a frame of the run left behind is ignored
    now += LIVE_FRAME_MS
    sender.push(frame(41, [41]))
    for (const p of out.splice(0)) deliver(viewer, p)
    expect(got[got.length - 1]).toBe(40)
  })

  it('a missed delta asks to be caught up, once a second at most', () => {
    let now = 0
    const out: string[] = []
    const sender = new LiveShareSender((p) => out.push(p), () => now)
    const asks: string[] = []
    const viewer = new LiveShareReceiver((p) => asks.push(p), { frame: () => {}, end: () => {} }, () => now)
    viewer.follow(sender.stream)
    sender.accept('q', sender.stream, '')
    sender.accept('w', sender.stream, '1')
    out.length = 0
    for (let k = 0; k < 10; k++) {
      now += LIVE_FRAME_MS
      sender.push(frame(k, [k]))
    }
    const [, snap, ...deltas] = out
    deliver(viewer, snap!)
    deliver(viewer, deltas[0]!)
    deliver(viewer, deltas[2]!) // skipped one
    deliver(viewer, deltas[3]!)
    expect(asks.slice(1)).toEqual([`live2|r|${sender.stream}|`])
  })

  it('the end of the followed run stops drawing it', () => {
    let ended = 0
    const viewer = new LiveShareReceiver(() => {}, { frame: () => {}, end: () => ended++ })
    viewer.follow('a')
    viewer.accept('e', 'b', '')
    expect(ended).toBe(0)
    viewer.accept('e', 'a', '')
    // nothing was drawn yet, so nothing to stop; the stream is still the one asked for
    expect(ended).toBe(0)
    expect(viewer.following).toBe('a')
  })
})
