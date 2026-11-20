// The SLMP codec and poller, against the 3E frame layout of the SLMP reference (SH-080008's command
// formats) and a strict fake CPU (plc/link/slmpFakeCpu.ts).

import { describe, expect, it } from 'vitest'
import { slmpClientFromTags } from '../../core/io/slmpIo'
import type { SlmpTagSignal } from '../../core/io/slmpIo'
import { buildBatchRead, buildBatchWrite, decodeSlmpWords, describeSlmpItem, describeSlmpStats, encodeSlmpWords, packBits, parseResponse, readRuns, responseFrameSize, SlmpPoller, SlmpStream, unpackBits, writeRuns } from './slmpClient'
import type { SlmpItem } from './slmpClient'
import { FakeSlmpCpu } from './slmpFakeCpu'

const item = (over: Partial<SlmpItem>): SlmpItem => ({ device: 'D', number: 100, bits: false, points: 1, ...over })

describe('the bytes on the wire, per the 3E frame layout', () => {
  it('reads D100, 10 words', () => {
    expect(Array.from(buildBatchRead(item({ points: 10 })))).toEqual([0x50, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x0c, 0x00, 0x10, 0x00, 0x01, 0x04, 0x00, 0x00, 0x64, 0x00, 0x00, 0xa8, 0x0a, 0x00])
  })

  it('writes M10 = ON: one bit, packed in the high nibble', () => {
    expect(Array.from(buildBatchWrite({ device: 'M', number: 10, bits: true, points: 1, bytes: packBits([true]) }))).toEqual([0x50, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x0d, 0x00, 0x10, 0x00, 0x01, 0x14, 0x01, 0x00, 0x0a, 0x00, 0x00, 0x90, 0x01, 0x00, 0x10])
  })

  it('writes D100-D101 = 0x1234, 0x5678: LE words', () => {
    expect(Array.from(buildBatchWrite({ device: 'D', number: 100, bits: false, points: 2, bytes: Uint8Array.of(0x34, 0x12, 0x78, 0x56) }))).toEqual([0x50, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x10, 0x00, 0x10, 0x00, 0x01, 0x14, 0x00, 0x00, 0x64, 0x00, 0x00, 0xa8, 0x02, 0x00, 0x34, 0x12, 0x78, 0x56])
  })

  it('reads W1A, 4 link registers: code B4, and a hexadecimal device number', () => {
    expect(Array.from(buildBatchRead({ device: 'W', number: 0x1a, bits: false, points: 4 }))).toEqual([0x50, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x0c, 0x00, 0x10, 0x00, 0x01, 0x04, 0x00, 0x00, 0x1a, 0x00, 0x00, 0xb4, 0x04, 0x00])
  })

  it('writes TN5 = 100: a timer current value, code C2', () => {
    expect(Array.from(buildBatchWrite({ device: 'TN', number: 5, bits: false, points: 1, bytes: Uint8Array.of(0x64, 0x00) }))).toEqual([0x50, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x0e, 0x00, 0x10, 0x00, 0x01, 0x14, 0x00, 0x00, 0x05, 0x00, 0x00, 0xc2, 0x01, 0x00, 0x64, 0x00])
  })

  it('names an item as the CPU spells it', () => {
    expect(describeSlmpItem(item({ points: 10 }))).toBe('D100-D109')
    expect(describeSlmpItem({ device: 'X', number: 0x1a, bits: true, points: 1 })).toBe('X1A')
    expect(describeSlmpItem({ device: 'M', number: 10, bits: true, points: 1 })).toBe('M10')
  })
})

describe('bits and values', () => {
  it('packs two points per byte, the even one in the high nibble', () => {
    expect(Array.from(packBits([true, false, true, true]))).toEqual([0x10, 0x11])
    expect(Array.from(packBits([true, false]))).toEqual([0x10])
    expect(Array.from(packBits([false, true]))).toEqual([0x01])
    expect(Array.from(packBits([]))).toEqual([])
  })

  it('unpacks in the same order, and round-trips', () => {
    expect(unpackBits(Uint8Array.of(0x10, 0x11), 4)).toEqual([true, false, true, true])
    const values = [true, true, false, true, false, false, true]
    expect(unpackBits(packBits(values), values.length)).toEqual(values)
  })

  it('holds words LE, low word first for two-register types', () => {
    expect(encodeSlmpWords('INT', 300)).toEqual([0x012c])
    expect(encodeSlmpWords('INT', -1)).toEqual([0xffff])
    expect(encodeSlmpWords('DINT', 65536)).toEqual([0x0000, 0x0001])
    expect(encodeSlmpWords('REAL', 0.75)).toEqual([0x0000, 0x3f40])
    expect(decodeSlmpWords('INT', 0xffff, 0)).toBe(-1)
    expect(decodeSlmpWords('DINT', 0x0000, 0x0001)).toBe(65536)
    expect(decodeSlmpWords('REAL', 0x0000, 0x3f40)).toBe(0.75)
  })
})

describe('the answers', () => {
  const ok = Uint8Array.of(0xd0, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x06, 0x00, 0x00, 0x00, 0x34, 0x12, 0x78, 0x56)
  const bad = Uint8Array.of(0xd0, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x02, 0x00, 0x50, 0xc0)

  it('takes the frame size from the length field', () => {
    expect(responseFrameSize(ok)).toBe(ok.length)
    expect(responseFrameSize(bad)).toBe(bad.length)
    // a header that says 15 bytes, with only 10 here so far
    expect(responseFrameSize(ok.slice(0, 10))).toBe(ok.length)
    // not a 3E answer at all
    expect(responseFrameSize(Uint8Array.of(0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))).toBe(0)
  })

  it('reads the end code and the data after it', () => {
    const res = parseResponse(ok)
    expect(res.endCode).toBe(0)
    expect(Array.from(res.data)).toEqual([0x34, 0x12, 0x78, 0x56])
    expect(parseResponse(bad)).toMatchObject({ endCode: 0xc050, data: new Uint8Array(0) })
  })

  it('refuses a frame that ends early or is not an answer', () => {
    expect(() => parseResponse(ok.slice(0, 10))).toThrow(/ends early/)
    expect(() => parseResponse(Uint8Array.of(0x50, 0x00))).toThrow(/not a 3E response/)
  })
})

describe('the stream', () => {
  it('reassembles an answer TCP split in two, and matches answers to requests in order', () => {
    const s = new SlmpStream()
    const req = buildBatchRead(item({ points: 10 }))
    s.frame(req, 1)
    s.frame(req, 2)
    const answer = (data: number): Uint8Array => Uint8Array.of(0xd0, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x03, 0x00, 0x00, 0x00, data)
    expect(s.push(answer(1).slice(0, 5))).toEqual([])
    expect(s.push(answer(1).slice(5))).toEqual([{ key: 1, response: answer(1) }])
    expect(s.push(answer(2))).toEqual([{ key: 2, response: answer(2) }])
  })

  it('drops a late answer to a request that already timed out', () => {
    const s = new SlmpStream()
    const answer = Uint8Array.of(0xd0, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00)
    // nothing outstanding: the answer to a request this side forgot
    expect(s.push(answer)).toEqual([])
  })

  it('gives up on a stream that is not a 3E answer', () => {
    const s = new SlmpStream()
    expect(s.push(Uint8Array.of(0x47, 0x45, 0x54, 0x20))).toEqual([])
    expect(s.error).toMatch(/not a 3E response/)
  })
})

describe('the runs one poll reads and writes', () => {
  const point = (tag: string, device: SlmpItem['device'], number: number, type: 'BOOL' | 'INT' | 'DINT' = device === 'D' ? 'INT' : 'BOOL') => ({ tag, device, number, type, dir: 'fromPlc' as const })

  it('merges a device across small gaps and splits a span to the frame limits', () => {
    // 2001 words is the span the live checks read: 3 frames of 960, 960 and 81
    const many = Array.from({ length: 2001 }, (_, i) => point(`D${i}`, 'D', i))
    expect(readRuns(many)).toEqual([
      { device: 'D', number: 0, bits: false, points: 960 },
      { device: 'D', number: 960, bits: false, points: 960 },
      { device: 'D', number: 1920, bits: false, points: 81 },
    ])
    // 2001 bits: 2 frames
    const bits = Array.from({ length: 2001 }, (_, i) => point(`M${i}`, 'M', i))
    expect(readRuns(bits)).toEqual([
      { device: 'M', number: 0, bits: true, points: 1024 },
      { device: 'M', number: 1024, bits: true, points: 977 },
    ])
  })

  it('reads D words and M bits as their own requests', () => {
    const points = [point('D100', 'D', 100, 'DINT'), point('M10', 'M', 10), point('D200', 'D', 200)]
    expect(readRuns(points)).toEqual([
      { device: 'M', number: 10, bits: true, points: 1 },
      { device: 'D', number: 100, bits: false, points: 2 },
      { device: 'D', number: 200, bits: false, points: 1 },
    ])
  })

  it('writes runs of consecutive points as one request each', () => {
    const values = [
      { point: point('M10', 'M', 10), value: true },
      { point: point('M11', 'M', 11), value: false },
      { point: point('D100', 'D', 100), value: 0x1234 },
    ]
    expect(writeRuns(values)).toEqual([
      { device: 'M', number: 10, bits: true, points: 2, bytes: Uint8Array.of(0x10) },
      { device: 'D', number: 100, bits: false, points: 1, bytes: Uint8Array.of(0x34, 0x12) },
    ])
  })
})

/** A poller connected straight to a fake CPU: `transact` frames, the CPU answers, the stream unframes. */
function onCpu(cpu: FakeSlmpCpu, tags: readonly (string | SlmpTagSignal)[]) {
  const { io, problems } = slmpClientFromTags({ host: 'cpu' }, tags)
  expect(problems).toEqual([])
  const poller = new SlmpPoller(io)
  const stream = new SlmpStream()
  let key = 0
  const sizes: number[] = []
  const transact = async (pdu: Uint8Array): Promise<Uint8Array> => {
    sizes.push(pdu.length)
    for (const reply of cpu.push(stream.frame(pdu, ++key))) {
      for (const f of stream.push(reply)) return f.response
    }
    throw new Error('no answer')
  }
  return { io, poller, transact, sizes }
}

describe('polling a CPU', () => {
  it('writes the sensors and reads the outputs', async () => {
    const cpu = new FakeSlmpCpu({ size: 512 })
    const { poller, transact } = onCpu(cpu, [{ name: 'M10', type: 'BOOL', writers: 1 }, { name: 'D100', type: 'REAL', writers: 1 }, 'Y0', { name: 'D200', type: 'INT' }])
    cpu.memory.Y[0] = 1
    cpu.setWord('D', 200, 300)
    poller.writeSimTags({ M10: true, D100: 0.75 })
    await poller.poll(transact)
    expect(cpu.memory.M[10]).toBe(1)
    expect(cpu.word('D', 100)).toBe(0x0000) // REAL 0.75: low word first
    expect(cpu.word('D', 101)).toBe(0x3f40)
    expect(poller.plcTags()).toEqual({ Y0: true, D200: 300 })
    expect(poller.stats).toEqual({ reads: 2, writes: 2, refused: 0 })
    expect(describeSlmpStats(poller.stats)).toBe('2 read and 2 write requests')
  })

  it('reads every output off before the first poll', () => {
    const cpu = new FakeSlmpCpu()
    const { poller } = onCpu(cpu, ['Y0', { name: 'D20', type: 'DINT' }])
    expect(poller.plcTags()).toEqual({ Y0: false, D20: 0 })
    expect(poller.offTags()).toEqual({ Y0: false, D20: 0 })
    expect(describeSlmpStats(poller.stats)).toBe('no requests')
  })

  it('writes a span past the frame limit as several requests, and reads it back', async () => {
    const cpu = new FakeSlmpCpu({ size: 4096 })
    const written = Array.from({ length: 2001 }, (_, i) => ({ name: `D${i}`, type: 'INT' as const, writers: 1 }))
    const { poller, transact, sizes } = onCpu(cpu, written)
    poller.writeSimTags(Object.fromEntries(written.map((t, i) => [t.name, i])))
    await poller.poll(transact)
    expect(cpu.word('D', 0)).toBe(0)
    expect(cpu.word('D', 960)).toBe(960)
    expect(cpu.word('D', 2000)).toBe(2000)
    expect(poller.stats).toEqual({ reads: 0, writes: 3, refused: 0 })
    expect(sizes.length).toBe(3)
    // the same span read back: 2001 words is 3 frames of 960, 960 and 81
    const read = onCpu(cpu, Array.from({ length: 2001 }, (_, i) => ({ name: `D${i}`, type: 'INT' as const })))
    await read.poller.poll(read.transact)
    expect(read.poller.stats).toEqual({ reads: 3, writes: 0, refused: 0 })
    expect(read.poller.plcTags()).toMatchObject({ D0: 0, D960: 960, D2000: 2000 })
  })

  it('reports a device this CPU does not reach, and counts the refusal', async () => {
    const cpu = new FakeSlmpCpu({ size: 64 })
    const { poller, transact } = onCpu(cpu, [{ name: 'D100', type: 'INT' }])
    const e = await poller.poll(transact).catch((x: unknown) => x)
    expect(String(e)).toMatch(/refused a read of D100/)
    expect(String(e)).toMatch(/past what this CPU reaches/)
    expect(poller.stats.refused).toBe(1)
  })

  it('writes X as any bit device: the simulator holds it, a real CPU\'s input modules may not', async () => {
    const cpu = new FakeSlmpCpu()
    const frame = buildBatchWrite({ device: 'X', number: 0, bits: true, points: 1, bytes: packBits([true]) })
    const res = parseResponse(cpu.push(frame)[0]!)
    expect(res.endCode).toBe(0)
    expect(cpu.memory.X[0]).toBe(1)
  })

  it('carries the other device families the same way', async () => {
    const cpu = new FakeSlmpCpu()
    const { poller, transact } = onCpu(cpu, [
      { name: 'B1A', type: 'BOOL', writers: 1 },
      { name: 'W10', type: 'INT', writers: 1 },
      { name: 'TN5', type: 'INT', writers: 1 },
      { name: 'CN2', type: 'INT' },
      { name: 'SD7', type: 'INT' },
    ])
    poller.writeSimTags({ B1A: true, W10: 0x1234, TN5: 100 })
    cpu.setWord('CN', 2, 42)
    await poller.poll(transact)
    expect(cpu.memory.B[0x1a]).toBe(1)
    expect(cpu.word('W', 0x10)).toBe(0x1234) // W10 is hexadecimal
    expect(cpu.word('TN', 5)).toBe(100)
    expect(poller.plcTags()).toEqual({ CN2: 42, SD7: 0 })
  })
})
