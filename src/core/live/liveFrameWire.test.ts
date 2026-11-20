import { describe, expect, it } from 'vitest'
import type { BoxFrame, FrameDressing } from '../frame'
import { LiveFrameDecoder, LiveFrameEncoder } from './liveFrameWire'

interface Body {
  id: number
  pos: [number, number, number]
  quat?: [number, number, number, number]
  partId?: string | null
  shape?: string | null
  kind?: number
}

function frameOf(bodies: Body[], simTime: number, extra: Partial<BoxFrame> = {}): BoxFrame {
  const n = bodies.length
  const f: BoxFrame = {
    count: n,
    ids: new Uint32Array(bodies.map((b) => b.id)),
    positions: new Float32Array(bodies.flatMap((b) => b.pos)),
    quats: new Float32Array(bodies.flatMap((b) => b.quat ?? [0, 0, 0, 1])),
    halfExtents: new Float32Array(bodies.flatMap(() => [0.2, 0.15, 0.1])),
    colors: new Float32Array(bodies.flatMap((b) => [b.id / 100, 0.5, 1])),
    kinds: new Uint8Array(bodies.map((b) => b.kind ?? 0)),
    partIds: bodies.map((b) => b.partId ?? null),
    simTime,
    ...extra,
  }
  if (bodies.some((b) => b.shape)) f.shapes = bodies.map((b) => b.shape ?? null)
  return f
}

function bodiesOf(f: BoxFrame): Map<number, { pos: number[]; quat: number[]; partId: string | null; kind: number }> {
  const out = new Map<number, { pos: number[]; quat: number[]; partId: string | null; kind: number }>()
  for (let i = 0; i < f.count; i++) {
    out.set(f.ids[i]!, {
      pos: Array.from(f.positions.subarray(i * 3, i * 3 + 3)),
      quat: Array.from(f.quats.subarray(i * 4, i * 4 + 4)),
      partId: f.partIds[i] ?? null,
      kind: f.kinds[i]!,
    })
  }
  return out
}

/** every body in `got` is within the wire's precision of `want` (0.5 mm, and a rotation within ~0.02 degrees) */
function expectSameBodies(got: BoxFrame, want: BoxFrame): void {
  const a = bodiesOf(got)
  const b = bodiesOf(want)
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort())
  for (const [id, w] of b) {
    const g = a.get(id)!
    for (let k = 0; k < 3; k++) expect(Math.abs(g.pos[k]! - w.pos[k]!)).toBeLessThan(0.0006)
    const dot = Math.abs(g.quat.reduce((s, x, k) => s + x * w.quat[k]!, 0))
    expect(dot).toBeGreaterThan(0.99999)
    expect(g.partId).toBe(w.partId)
    expect(g.kind).toBe(w.kind)
  }
}

describe('live frame wire', () => {
  it('round-trips bodies as they spawn, move, change owner and leave', () => {
    const enc = new LiveFrameEncoder()
    const dec = new LiveFrameDecoder()
    const s = Math.SQRT1_2
    const frames = [
      frameOf([{ id: 1, pos: [0, 0.5, 0] }, { id: 2, pos: [-3.25, 1, 12.5], quat: [0, s, 0, s] }], 0.05),
      frameOf([{ id: 1, pos: [0.025, 0.5, 0] }, { id: 2, pos: [-3.25, 1, 12.5], quat: [0, s, 0, s] }, { id: 7, pos: [5, 0.2, -1], partId: 'case-1' }], 0.1),
      frameOf([{ id: 1, pos: [0.05, 0.5, 0], partId: 'pallet-3' }, { id: 7, pos: [5, 0.2, -0.95], quat: [0, 0, -s, s], partId: 'case-1' }], 0.15),
    ]
    for (const f of frames) {
      const msg = enc.encode(f)
      expect(dec.apply(msg)).toBe('applied')
      expectSameBodies(dec.frame(), f)
      expect(dec.frame().simTime).toBe(f.simTime)
    }
  })

  it('sends nothing for a body that did not move', () => {
    const enc = new LiveFrameEncoder()
    const still = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, pos: [i * 0.7, 0.4, -2] as [number, number, number] }))
    const first = enc.encode(frameOf(still, 0.05)).length
    const rest = enc.encode(frameOf(still, 0.1)).length
    expect(first).toBeGreaterThan(500 * 30)
    expect(rest).toBeLessThan(20)
  })

  it('carries per-part records as changes, including a part that drops out', () => {
    const enc = new LiveFrameEncoder()
    const dec = new LiveFrameDecoder()
    const f1 = frameOf([], 0.05, {
      joints: { arm: { j1: 0.123456, j2: -1 } },
      lamps: { eye: { led: true } },
      tags: { eye: { Eye1: true }, motor: { Speed: 1.5 } },
      conveyorSpeeds: { belt: 0.5 },
      copySpeeds: { spur: {} },
      basePoses: { agv: { pos: [1, 0, 2], yaw: 0.5 } },
    })
    dec.apply(enc.encode(f1))
    expect(dec.frame().joints).toEqual({ arm: { j1: 0.1235, j2: -1 } })
    expect(dec.frame().copySpeeds).toEqual({ spur: {} })
    expect(dec.frame().tags).toEqual({ eye: { Eye1: true }, motor: { Speed: 1.5 } })
    const f2 = frameOf([], 0.1, {
      joints: { arm: { j1: 0.2 } },
      tags: { eye: { Eye1: false }, motor: { Speed: 1.5 } },
      conveyorSpeeds: { belt: 0.5 },
      basePoses: { agv: { pos: [1.5, 0, 2], yaw: 0.5 } },
    })
    const msg = enc.encode(f2)
    dec.apply(msg)
    const got = dec.frame()
    expect(got.joints).toEqual({ arm: { j1: 0.2 } })
    expect(got.lamps).toBeUndefined()
    expect(got.copySpeeds).toBeUndefined()
    expect(got.tags).toEqual({ eye: { Eye1: false }, motor: { Speed: 1.5 } })
    expect(got.conveyorSpeeds).toEqual({ belt: 0.5 })
    expect(got.basePoses).toEqual({ agv: { pos: [1.5, 0, 2], yaw: 0.5 } })
    // only what changed is on the wire: the motor's tag and the belt's speed are not
    const text = new TextDecoder().decode(msg)
    expect(text).not.toContain('"Speed"')
    expect(text).not.toContain('"belt"')
  })

  it("carries the sharer's PLC variables as changes, and whole in a snapshot", () => {
    const enc = new LiveFrameEncoder()
    const dec = new LiveFrameDecoder()
    dec.apply(enc.encode(frameOf([], 0.05), { Cases: 3, Running: true, Mode: 'auto' }))
    expect(dec.watch()).toEqual({ Cases: 3, Running: true, Mode: 'auto' })
    const msg = enc.encode(frameOf([], 0.1), { Cases: 4, Running: true })
    expect(new TextDecoder().decode(msg)).not.toContain('Running')
    dec.apply(msg)
    expect(dec.watch()).toEqual({ Cases: 4, Running: true })
    const late = new LiveFrameDecoder()
    late.apply(enc.snapshot())
    expect(late.watch()).toEqual({ Cases: 4, Running: true })
    dec.apply(enc.encode(frameOf([], 0.15)))
    expect(dec.watch()).toEqual({})
  })

  it('patches dressings and sends each shape ref once', () => {
    const enc = new LiveFrameEncoder()
    const dec = new LiveFrameDecoder()
    const film = (y1: number): FrameDressing => ({ anchor: 1, id: 'film', min: [0, 0, 0], max: [1, y1, 1], color: [1, 1, 1], opacity: 0.4 })
    const ref = { packageId: 'oip.box', params: { width: 0.4 } }
    const bodies = [{ id: 1, pos: [0, 0, 0] as [number, number, number], shape: 'box:a' }]
    dec.apply(enc.encode(frameOf(bodies, 0.05, { dressings: [film(0.5)], shapeRefs: { 'box:a': ref } })))
    expect(dec.frame().dressings).toEqual([film(0.5)])
    expect(dec.frame().shapes).toEqual(['box:a'])
    expect(dec.frame().shapeRefs).toEqual({ 'box:a': ref })
    const msg = enc.encode(frameOf(bodies, 0.1, { dressings: [film(0.6)], shapeRefs: { 'box:a': ref } }))
    expect(new TextDecoder().decode(msg)).not.toContain('oip.box')
    dec.apply(msg)
    expect(dec.frame().dressings).toEqual([film(0.6)])
    dec.apply(enc.encode(frameOf(bodies, 0.15, { shapeRefs: { 'box:a': ref } })))
    expect(dec.frame().dressings).toBeUndefined()
  })

  it('refuses a delta that skips one, and starts over from a snapshot', () => {
    const enc = new LiveFrameEncoder()
    const dec = new LiveFrameDecoder()
    expect(dec.apply(enc.encode(frameOf([{ id: 1, pos: [0, 0, 0] }], 0.05)))).toBe('applied')
    const lost = enc.encode(frameOf([{ id: 1, pos: [1, 0, 0] }], 0.1))
    expect(lost.length).toBeGreaterThan(0)
    const next = frameOf([{ id: 1, pos: [2, 0, 0] }, { id: 2, pos: [0, 1, 0] }], 0.15)
    const delta = enc.encode(next)
    expect(dec.apply(delta)).toBe('gap')
    dec.apply(enc.snapshot())
    expect(dec.lastSeq).toBe(enc.lastSeq)
    expectSameBodies(dec.frame(), next)
    expect(dec.apply(delta)).toBe('gap') // older than the snapshot it already holds
  })

  it('a viewer joining from a snapshot sees what a viewer there from the start sees', () => {
    const enc = new LiveFrameEncoder()
    const early = new LiveFrameDecoder()
    early.apply(enc.snapshot())
    let late: LiveFrameDecoder | null = null
    for (let t = 1; t <= 120; t++) {
      const bodies: Body[] = []
      for (let id = 1; id <= 40; id++) {
        if (id % 7 === t % 7 && t > 60) continue // some leave and come back
        bodies.push({ id, pos: [id * 0.5 + (id % 3 === 0 ? t * 0.025 : 0), 0.3, Math.sin(t / 10 + id)], partId: id % 5 === 0 ? `p${id}` : null })
      }
      const f = frameOf(bodies, t / 20, { lamps: { stack: { green: t % 20 < 10 } }, joints: { arm: { j1: t / 100 } } })
      const msg = enc.encode(f)
      expect(early.apply(msg)).toBe('applied')
      if (t === 50) {
        late = new LiveFrameDecoder()
        late.apply(enc.snapshot())
      } else if (late) expect(late.apply(msg)).toBe('applied')
      expectSameBodies(early.frame(), f)
    }
    expectSameBodies(late!.frame(), early.frame())
    expect(late!.frame().lamps).toEqual(early.frame().lamps)
    expect(late!.frame().joints).toEqual(early.frame().joints)
  })
})
