import { describe, expect, it } from 'vitest'
import type { FrameDressing } from '../core/frame'
import { FrameWireDecoder, FrameWireEncoder, RecordDecoder, RecordEncoder } from './frameWire'

// The worker sends partIds / dressings only as far as they changed; the client must still hand every consumer
// the same complete frame the worker built. Each case runs the pair end to end through a structured clone, the
// way postMessage carries it, and checks the client's copy against the worker's own frame.

const dressing = (anchor: number, over: Partial<FrameDressing> = {}): FrameDressing => ({
  anchor,
  id: 'film',
  min: [-0.5, 0, -0.5],
  max: [0.5, 1.2, 0.5],
  color: [0.8, 0.85, 0.9],
  opacity: 0.4,
  ...over,
})
const web = (y1: number) => ({ from: [1, 2] as [number, number], to: [3, 4] as [number, number], y0: 0.1, y1 })

function link() {
  const enc = new FrameWireEncoder()
  const dec = new FrameWireDecoder()
  const send = (partIds: (string | null)[], dressings?: FrameDressing[]) => {
    const wire = structuredClone(enc.encode(partIds, dressings))
    dec.accept(wire)
    // the invariant every case rests on: the client now holds exactly what the worker had
    expect(dec.partIds).toEqual(partIds)
    expect(dec.dressings).toEqual(dressings === undefined ? undefined : structuredClone(dressings))
    return wire
  }
  return { enc, dec, send }
}

describe('frame wire: partIds + dressings cross the worker boundary only as far as they changed', () => {
  it('sends in full first, then nothing but a Kept flag and an empty patch while the content holds', () => {
    const { send } = link()
    const d = [dressing(7), dressing(8)]
    expect(send(['a', null, 'b'], d)).toEqual({ partIds: ['a', null, 'b'], dressings: d })
    // equal content in fresh objects: nothing to send
    expect(send(['a', null, 'b'], [dressing(7), dressing(8)])).toEqual({ partIdsKept: true, dressingsPatch: { length: 2, changed: [] } })
  })

  it('an owner change with the same box count is sent (content, not length, decides)', () => {
    const { send } = link()
    send(['a', 'b'])
    expect(send(['a', 'c'])).toEqual({ partIds: ['a', 'c'] })
  })

  it('the demo case: one of many dressings is being wrapped - only that entry crosses', () => {
    const { send } = link()
    const live = Array.from({ length: 50 }, (_, i) => dressing(i))
    send(['x'], live)
    for (const y1 of [0.5, 0.6, 0.7]) {
      live[31]!.web = web(y1) // the world mutates its live object in place (identity is unchanged)
      expect(send(['x'], live).dressingsPatch).toEqual({ length: 50, changed: [[31, live[31]]] })
    }
    delete live[31]!.web // the wrap finishes
    expect(send(['x'], live).dressingsPatch?.changed.map(([i]) => i)).toEqual([31])
  })

  it('entries inserted or removed mid-list stay exact (shifted indices re-send)', () => {
    const { send } = link()
    send(['x'], [dressing(1), dressing(2), dressing(3)])
    send(['x'], [dressing(1), dressing(9), dressing(2), dressing(3)]) // insert
    send(['x'], [dressing(1), dressing(3)]) // remove two
    send(['x'], [dressing(1), dressing(3)])
  })

  it('a patch never mutates the array a consumer already holds', () => {
    const { dec, send } = link()
    send(['x'], [dressing(1), dressing(2)])
    const held = dec.dressings!
    send(['x'], [dressing(1), dressing(2, { opacity: 0.9 })])
    expect(held[1]!.opacity).toBe(0.4)
    expect(dec.dressings).not.toBe(held)
  })

  it('dressings going away clears the client copy, and coming back is sent in full', () => {
    const { send } = link()
    send(['x'], [dressing(1)])
    expect(send(['x'])).toEqual({ partIdsKept: true })
    expect(send(['x'], [dressing(1)])).toEqual({ partIdsKept: true, dressings: [dressing(1)] })
  })

  it('a reset (new world) sends both in full again even when unchanged', () => {
    const { enc, send } = link()
    send(['a'], [dressing(1)])
    enc.reset()
    expect(send(['a'], [dressing(1)])).toEqual({ partIds: ['a'], dressings: [dressing(1)] })
  })

  it('an empty scene round-trips (no boxes, nothing dressed)', () => {
    const { send } = link()
    expect(send([])).toEqual({ partIds: [] })
    expect(send([])).toEqual({ partIdsKept: true })
  })
})

describe("each body's own shape (core/cargoBody.ts)", () => {
  const ref = (packageId: string, size: number) => ({ packageId, params: { size } })

  it('sends the shapes like partIds, and each shape ref once', () => {
    const enc = new FrameWireEncoder()
    const dec = new FrameWireDecoder()
    const send = (shapes: (string | null)[] | undefined, refs?: Record<string, ReturnType<typeof ref>>) => {
      const wire = structuredClone(enc.encode([], undefined, shapes, refs))
      dec.accept(wire)
      expect(dec.shapes).toEqual(shapes)
      return wire
    }
    const first = send(['a', null], { a: ref('acme.drum', 1) })
    expect(first.shapes).toEqual(['a', null])
    expect(first.shapeRefsNew).toEqual({ a: ref('acme.drum', 1) })
    // unchanged: neither the shapes nor the ref go again
    const second = send(['a', null], { a: ref('acme.drum', 1) })
    expect(second.shapesKept).toBe(true)
    expect(second.shapeRefsNew).toBeUndefined()
    // a new shape: only its ref goes, and the client holds both
    const third = send(['a', 'b'], { a: ref('acme.drum', 1), b: ref('acme.drum', 2) })
    expect(third.shapeRefsNew).toEqual({ b: ref('acme.drum', 2) })
    expect(dec.shapeRefs).toEqual({ a: ref('acme.drum', 1), b: ref('acme.drum', 2) })
    // no body with its own shape: none on the wire, and the client drops its shapes (its refs stay for the run)
    expect(send(undefined, { a: ref('acme.drum', 1), b: ref('acme.drum', 2) })).toEqual({ partIdsKept: true })
  })

  it('sends every ref again after a reset (a new world)', () => {
    const enc = new FrameWireEncoder()
    enc.encode([], undefined, ['a'], { a: ref('acme.drum', 1) })
    enc.reset()
    expect(enc.encode([], undefined, ['a'], { a: ref('acme.drum', 1) }).shapeRefsNew).toEqual({ a: ref('acme.drum', 1) })
  })
})

describe('a record that crosses only as far as it changed', () => {
  /** send `record` through a fresh wire copy, as postMessage would, and give the receiver's whole copy */
  const wire = (): { send: (record: Record<string, unknown> | undefined) => { got: Readonly<Record<string, unknown>> | undefined; how: string } } => {
    const encoder = new RecordEncoder()
    const decoder = new RecordDecoder<unknown>()
    return {
      send: (record) => {
        const sent = structuredClone(encoder.encode(record))
        const how = typeof sent === 'string' ? sent : 'patch' in sent ? 'patch' : 'whole'
        const got = decoder.accept(typeof sent !== 'string' && 'whole' in sent ? sent.whole : undefined, typeof sent !== 'string' && 'patch' in sent ? sent.patch : undefined, sent === 'kept')
        return { got, how }
      },
    }
  }

  it('goes whole first, then not at all while nothing changes, then as the entries that did', () => {
    const { send } = wire()
    const lamps = { eye1: { on: false }, eye2: { on: false }, eye3: { on: true } }
    expect(send(lamps)).toEqual({ got: lamps, how: 'whole' })
    expect(send(lamps)).toEqual({ got: lamps, how: 'kept' })
    lamps.eye2.on = true // the world changes its records in place
    expect(send(lamps)).toEqual({ got: lamps, how: 'patch' })
    expect(send(lamps).how).toBe('kept')
  })

  it("keeps the receiver's copy listing its keys as the sender's does", () => {
    const { send } = wire()
    let record: Record<string, number> = { a: 1, b: 2, c: 3 }
    send(record)
    record = { a: 1, c: 4 } // one dropped, one changed
    let r = send(record)
    expect(r.how).toBe('patch')
    expect(Object.entries(r.got!)).toEqual(Object.entries(record))
    record = { a: 1, b0: 9, c: 4 } // a new key, in the middle
    r = send(record)
    expect(r.how).toBe('whole')
    expect(Object.entries(r.got!)).toEqual(Object.entries(record))
    expect(send({}).got).toEqual({})
  })

  it('hands on a new object when the record changed, and the same entries where they did not', () => {
    const { send } = wire()
    const first = send({ a: { v: 1 }, b: { v: 2 } }).got!
    const same = send({ a: { v: 1 }, b: { v: 2 } }).got!
    expect(same).toBe(first)
    const next = send({ a: { v: 1 }, b: { v: 3 } }).got!
    expect(next).not.toBe(first)
    expect(next['a']).toBe(first['a'])
    expect(next['b']).toEqual({ v: 3 })
    expect(first['b']).toEqual({ v: 2 }) // the last frame's copy is not changed under whoever holds it
  })

  it('is no record again when the frame has none, and whole when it comes back', () => {
    const { send } = wire()
    send({ a: 1 })
    expect(send(undefined)).toEqual({ got: undefined, how: 'none' })
    expect(send({ a: 1 })).toEqual({ got: { a: 1 }, how: 'whole' })
  })

  it('gives the receiver every frame the sender had, over a long run of small changes', () => {
    const { send } = wire()
    const parts = Array.from({ length: 60 }, (_, i) => `part${i}`)
    const record: Record<string, Record<string, number | boolean>> = Object.fromEntries(parts.map((p, i) => [p, { speed: i, on: false }]))
    let seed = 7
    const random = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    for (let frame = 0; frame < 300; frame++) {
      const touched = random(4)
      for (let k = 0; k < touched; k++) {
        const p = parts[random(parts.length)]!
        if (random(10) === 0) delete record[p]
        else record[p] = { speed: random(50), on: random(2) === 0 }
      }
      const { got } = send(record)
      expect(JSON.stringify(got), `frame ${frame}`).toBe(JSON.stringify(record))
    }
  })
})

describe("a frame's records by part", () => {
  it('reach the client whole on every frame, sent as far as each changed', () => {
    const encoder = new FrameWireEncoder()
    const decoder = new FrameWireDecoder()
    const frame = {
      lamps: { eye1: { on: false }, eye2: { on: true } },
      tags: { belt1: { run: true, speed: 1.2 }, eye1: { seen: false } },
      conveyorSpeeds: { belt1: 1.2 },
    }
    const pass = (f: Parameters<FrameWireEncoder['encodeRecords']>[0]): ReturnType<FrameWireEncoder['encodeRecords']> => {
      const sent = structuredClone(encoder.encodeRecords(f))
      decoder.accept(sent)
      return sent
    }
    expect(pass(frame)).toEqual(frame)
    expect(decoder.records).toEqual(frame)
    // nothing changed: nothing but the names crosses
    expect(pass(frame)).toEqual({ recordsKept: ['lamps', 'tags', 'conveyorSpeeds'] })
    expect(decoder.records).toEqual(frame)
    // one sensor sees a box
    frame.tags.eye1.seen = true
    frame.lamps.eye1.on = true
    expect(pass(frame)).toEqual({ recordsKept: ['conveyorSpeeds'], recordPatches: { lamps: { set: { eye1: { on: true } } }, tags: { set: { eye1: { seen: true } } } } })
    expect(decoder.records).toEqual(frame)
    // a record the frame no longer has is gone from the client's too
    const { conveyorSpeeds: _gone, ...rest } = frame
    pass(rest)
    expect(decoder.records).toEqual(rest)
    // a new world starts whole
    encoder.reset()
    expect(pass(rest)).toEqual(rest)
  })
})
