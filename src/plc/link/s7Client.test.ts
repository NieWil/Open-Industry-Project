import { describe, expect, it } from 'vitest'
import { s7ClientFromTags } from '../../core/io/s7Io'
import type { S7TagSignal } from '../../core/io/s7Io'
import { FakeS7Cpu } from './s7FakeCpu'
import {
  connectRequest,
  decodeS7Value,
  encodeS7Value,
  MAX_ITEMS,
  maxReadBytes,
  readRequest,
  readRuns,
  S7Error,
  S7Poller,
  S7Stream,
  setupRequest,
  writeRequest,
} from './s7Client'

// ---- the bytes, against the oip-comms driver ----
//
// oip-comms S7Com.cpp builds its requests from fixed templates, patched per request, and those talk to real
// S7-1200s and S7-1500s. Rebuilding its frames with its own patching arithmetic and comparing them byte for byte
// pins that this client says the same thing on the wire. The templates are copied verbatim from S7Com.cpp.

const OIP_CONNECT = [0x03, 0x00, 0x00, 0x16, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x4b, 0x54, 0xc2, 0x02, 0x03, 0x01]
const OIP_NEGOTIATE = [0x03, 0x00, 0x00, 0x19, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x08, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0xc0]
const OIP_READ = [0x03, 0x00, 0x00, 0x1f, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x00, 0x09, 0x00, 0x0e, 0x00, 0x00, 0x04, 0x01, 0x12, 0x0a, 0x10, 0x02, 0x00, 128, 0x00, 0x00, 0x83, 0x00, 0x00, 0x00]
const OIP_WRITE = [0x03, 0x00, 0x00, 0x23, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x01, 0x6f, 0x00, 0x0e, 0x00, 0x05, 0x05, 0x01, 0x12, 0x0a, 0x10, 0x02, 0x00, 0x01, 0x00, 0x00, 0x82, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]
const AREA = { I: 0x81, Q: 0x82, M: 0x83 } as const

/** S7Com.cpp S7_read's patching: quantity, area, start in bits. */
function oipRead(area: keyof typeof AREA, start: number, quantity: number): number[] {
  const b = [...OIP_READ]
  b[23] = quantity >> 8
  b[24] = quantity & 0xff
  b[27] = AREA[area]
  b[28] = ((start * 8) >> 16) & 0xff
  b[29] = ((start * 8) >> 8) & 0xff
  b[30] = (start * 8) & 0xff
  return b
}

/** S7Com.cpp S7_sendTag's patching, for a byte-wide value or one bit. */
function oipWrite(area: keyof typeof AREA, byte: number, value: number[], bit?: number): number[] {
  const b = [...OIP_WRITE]
  b[3] = OIP_WRITE.length + value.length
  b[16] = b[16]! + value.length - 1
  b[27] = AREA[area]
  b[28] = ((byte * 8) >> 16) & 0xff
  b[29] = ((byte * 8) >> 8) & 0xff
  b[30] = (byte * 8) & 0xff
  if (bit !== undefined) {
    b[22] = 1
    b[30] = b[30]! | bit
    b[32] = 3
  } else {
    b[24] = value.length
    b[34] = value.length << 3
  }
  return [...b, ...value]
}

const wire = (pdu: Uint8Array) => [...new S7Stream().frame(pdu)]

describe('the bytes on the wire, against the oip-comms driver that talks to real CPUs', () => {
  it('connects to rack 0, slot 1 as it does (only our own TSAP differs, which the CPU does not check)', () => {
    const ours = [...connectRequest(0, 1)]
    expect(ours).toEqual([...OIP_CONNECT.slice(0, 16), 0x01, 0x00, ...OIP_CONNECT.slice(18)])
    // rack and slot land in the called TSAP's low byte: rack * 32 + slot
    expect([...connectRequest(1, 3)].slice(-2)).toEqual([0x03, 0x23])
  })

  it('asks for a 960-byte PDU as it does', () => {
    expect(wire(setupRequest(5))).toEqual(OIP_NEGOTIATE)
  })

  it('reads a run of bytes as it does', () => {
    expect(wire(readRequest(9, [{ area: 'M', byte: 0, length: 128 }]))).toEqual(OIP_READ)
    expect(wire(readRequest(9, [{ area: 'Q', byte: 84, length: 6 }]))).toEqual(oipRead('Q', 84, 6))
    expect(wire(readRequest(9, [{ area: 'I', byte: 1000, length: 2 }]))).toEqual(oipRead('I', 1000, 2))
  })

  it('writes a word, a double word and a bit as it does', () => {
    expect(wire(writeRequest(0x016f, [{ area: 'Q', byte: 4, length: 2, bytes: Uint8Array.of(0x12, 0x34) }]))).toEqual(oipWrite('Q', 4, [0x12, 0x34]))
    expect(wire(writeRequest(0x016f, [{ area: 'I', byte: 84, length: 4, bytes: Uint8Array.of(0x3f, 0x80, 0, 0) }]))).toEqual(oipWrite('I', 84, [0x3f, 0x80, 0, 0]))
    expect(wire(writeRequest(0x016f, [{ area: 'I', byte: 80, bit: 4, length: 1, bytes: Uint8Array.of(1) }]))).toEqual(oipWrite('I', 80, [1], 4))
  })
})

describe('values, big-endian as an S7 holds them', () => {
  const point = (type: 'BOOL' | 'BYTE' | 'INT' | 'DINT' | 'REAL', bit?: number) => ({ tag: 't', area: 'I' as const, byte: 0, size: 'D' as const, type, dir: 'toPlc' as const, ...(bit !== undefined ? { bit } : {}) })
  it('a REAL is its IEEE 754 bits, high byte first', () => {
    expect([...encodeS7Value(point('REAL'), 1)]).toEqual([0x3f, 0x80, 0, 0])
    expect(decodeS7Value(point('REAL'), Uint8Array.of(0x3f, 0, 0, 0), 0)).toBe(0.5)
  })
  it('an INT and a DINT saturate rather than wrap, and read back signed', () => {
    expect([...encodeS7Value(point('INT'), 40000)]).toEqual([0x7f, 0xff])
    expect([...encodeS7Value(point('INT'), -2)]).toEqual([0xff, 0xfe])
    expect(decodeS7Value(point('INT'), Uint8Array.of(0xff, 0xfe), 0)).toBe(-2)
    expect(decodeS7Value(point('DINT'), Uint8Array.of(0xff, 0xff, 0xff, 0xfd), 0)).toBe(-3)
    expect([...encodeS7Value(point('BYTE'), 300)]).toEqual([255])
  })
  it('a bit is read from its own place in the byte', () => {
    expect(decodeS7Value(point('BOOL', 4), Uint8Array.of(0b0001_0000), 0)).toBe(true)
    expect(decodeS7Value(point('BOOL', 3), Uint8Array.of(0b0001_0000), 0)).toBe(false)
  })
})

describe('the framing', () => {
  it('reassembles frames that arrive a byte at a time, and a PDU split over data units', () => {
    const s = new S7Stream()
    const got: unknown[] = []
    // a CC, then one PDU [0x32, 3, ...] split in two COTP data units (the first without the last-unit flag)
    const bytes = [3, 0, 0, 11, 6, 0xd0, 0, 1, 0, 0, 0, 3, 0, 0, 9, 2, 0xf0, 0x00, 0x32, 0x03, 3, 0, 0, 9, 2, 0xf0, 0x80, 0x00, 0x00]
    for (const b of bytes) got.push(...s.push(Uint8Array.of(b)))
    expect(got).toEqual([{ kind: 'confirm' }, { kind: 'pdu', pdu: Uint8Array.of(0x32, 0x03, 0x00, 0x00) }])
    expect(s.error).toBeNull()
  })
  it('gives up on a stream that is not TPKT', () => {
    const s = new S7Stream()
    expect(s.push(Uint8Array.of(0x47, 0x45, 0x54, 0x20))).toEqual([])
    expect(s.error).toMatch(/not TPKT/)
  })
})

/** A poller connected straight to a fake CPU: `transact` frames, the CPU answers, the stream unframes. */
function onCpu(cpu: FakeS7Cpu, tags: readonly (string | S7TagSignal)[]) {
  const { io, problems } = s7ClientFromTags({ host: 'cpu' }, tags)
  expect(problems).toEqual([])
  const poller = new S7Poller(io)
  const stream = new S7Stream()
  const sizes: number[] = []
  const transact = async (pdu: Uint8Array): Promise<Uint8Array> => {
    sizes.push(pdu.length)
    for (const reply of cpu.push(stream.frame(pdu))) {
      for (const f of stream.push(reply)) if (f.kind === 'pdu') return f.pdu
    }
    throw new Error('no answer')
  }
  cpu.reset()
  cpu.push(connectRequest(0, 1))
  return { io, poller, transact, sizes }
}

describe('polling a CPU', () => {
  it("agrees the CPU's PDU, writes the sensors and reads the outputs", async () => {
    const cpu = new FakeS7Cpu()
    const { poller, transact } = onCpu(cpu, ['%IX80.4', { name: '%ID84', type: 'REAL' }, '%QX80.0', { name: '%QD84', type: 'REAL' }])
    await poller.handshake(transact)
    expect(poller.pdu).toBe(240) // asked for 960; a 1200 agrees 240
    poller.writeSimTags({ '%IX80.4': true, '%ID84': 0.75 })
    cpu.memory.Q[80] = 0b1
    cpu.memory.Q.set([0x3e, 0x99, 0x99, 0x9a], 84) // 0.3
    await poller.poll(transact)
    expect(cpu.memory.I[80]).toBe(0b0001_0000)
    expect([...cpu.memory.I.subarray(84, 88)]).toEqual([0x3f, 0x40, 0, 0])
    expect(poller.plcTags()).toEqual({ '%QX80.0': true, '%QD84': expect.closeTo(0.3, 6) })
    expect(poller.stats).toEqual({ reads: 1, writes: 1, refused: 0 })
  })

  it("writes a bit without touching the byte's other bits, which may be a real input card's", async () => {
    const cpu = new FakeS7Cpu()
    cpu.memory.I[80] = 0b1110_1111
    const { poller, transact } = onCpu(cpu, ['%IX80.4'])
    await poller.handshake(transact)
    poller.writeSimTags({ '%IX80.4': true })
    await poller.poll(transact)
    expect(cpu.memory.I[80]).toBe(0xff)
    poller.writeSimTags({ '%IX80.4': false })
    await poller.poll(transact)
    expect(cpu.memory.I[80]).toBe(0b1110_1111)
  })

  it('carries an M tag the way the parts use it', async () => {
    const cpu = new FakeS7Cpu()
    const { io, poller, transact } = onCpu(cpu, [{ name: '%MX10.0', writers: 1 }, { name: '%MW12', writers: 0 }])
    expect(io.points.map((p) => [p.tag, p.dir])).toEqual([
      ['%MX10.0', 'toPlc'],
      ['%MW12', 'fromPlc'],
    ])
    await poller.handshake(transact)
    cpu.memory.M.set([0x01, 0x2c], 12) // 300
    poller.writeSimTags({ '%MX10.0': true })
    await poller.poll(transact)
    expect(cpu.memory.M[10]).toBe(1)
    expect(poller.plcTags()).toEqual({ '%MW12': 300 })
  })

  it("cuts a large scene into jobs that fit the CPU's PDU and item limit", async () => {
    const cpu = new FakeS7Cpu({ size: 1024 })
    // 60 sensor bits and 40 words written, and a read run longer than one answer can carry
    const tags = [
      ...Array.from({ length: 60 }, (_, i) => `%IX${Math.floor(i / 8)}.${i % 8}`),
      ...Array.from({ length: 40 }, (_, i) => `%IW${100 + i * 2}`),
      '%QX0.0',
      '%QW500',
    ]
    const { poller, transact, sizes } = onCpu(cpu, tags)
    await poller.handshake(transact)
    poller.writeSimTags(Object.fromEntries(tags.filter((t) => t.startsWith('%I')).map((t, i) => [t, t.includes('X') ? i % 2 === 0 : i])))
    await poller.poll(transact)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(240)
    expect(Math.max(...cpu.jobs.map((j) => j.items))).toBeLessThanOrEqual(MAX_ITEMS)
    expect(cpu.memory.I[0]).toBe(0b0101_0101)
    expect((cpu.memory.I[100 + 39 * 2]! << 8) | cpu.memory.I[101 + 39 * 2]!).toBe(99)
    // Q0.0 and QW500 are 499 bytes apart: two runs, not one run carrying the gap
    expect(readRuns(poller.io.points.filter((p) => p.dir === 'fromPlc'), 240)).toEqual([
      { area: 'Q', byte: 0, length: 1 },
      { area: 'Q', byte: 500, length: 2 },
    ])
  })

  it('splits one long run into items an answer can carry', () => {
    const bit = s7ClientFromTags({ host: 'cpu' }, ['%QX0.0']).io.points[0]!
    // thirty bits ten bytes apart merge into one run, Q0-Q290: longer than one answer carries, so two items
    const long = readRuns(Array.from({ length: 30 }, (_, i) => ({ ...bit, byte: i * 10 })), 240)
    expect(long).toEqual([
      { area: 'Q', byte: 0, length: maxReadBytes(240) },
      { area: 'Q', byte: maxReadBytes(240), length: 291 - maxReadBytes(240) },
    ])
  })

  it('says what to do when PUT/GET is off', async () => {
    const cpu = new FakeS7Cpu({ putGet: false })
    const { poller, transact } = onCpu(cpu, ['%IX0.0', '%QX0.0'])
    await poller.handshake(transact)
    poller.writeSimTags({ '%IX0.0': true })
    const e = await poller.poll(transact).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(S7Error)
    expect((e as S7Error).code).toBe(0x8104)
    expect((e as S7Error).message).toMatch(/refused a write of I0\.0 \(error 0x8104\).*PUT\/GET is off.*Permit access with PUT\/GET/)
    expect(poller.stats.refused).toBe(1)
  })

  it("names an address past the end of the CPU's memory", async () => {
    const cpu = new FakeS7Cpu({ size: 64 })
    const { poller, transact } = onCpu(cpu, ['%QW100'])
    await poller.handshake(transact)
    await expect(poller.poll(transact)).rejects.toThrow(/refused a read of QB100-101: the address is out of range/)
  })

  it('reads every output off before the first poll', () => {
    const { poller } = onCpu(new FakeS7Cpu(), ['%QX0.0', { name: '%QD4', type: 'REAL' }])
    expect(poller.plcTags()).toEqual({ '%QX0.0': false, '%QD4': 0 })
    expect(poller.offTags()).toEqual({ '%QX0.0': false, '%QD4': 0 })
  })
})

describe('data blocks', () => {
  it('puts the DB number in the item address, area 0x84, as an S7-ANY pointer does', () => {
    // DB10.DBW4: transport BYTE, 2 bytes, DB 10, area 0x84, byte 4 = bit offset 32
    expect([...readRequest(1, [{ area: 'DB', db: 10, byte: 4, length: 2 }])].slice(12)).toEqual([0x12, 0x0a, 0x10, 0x02, 0x00, 0x02, 0x00, 0x0a, 0x84, 0x00, 0x00, 0x20])
    // DB300.DBX1.5: transport BIT, 1, DB 300 (0x012C), byte 1 bit 5 = bit offset 13
    expect([...writeRequest(1, [{ area: 'DB', db: 300, byte: 1, bit: 5, length: 1, bytes: Uint8Array.of(1) }])].slice(12, 24)).toEqual([0x12, 0x0a, 0x10, 0x01, 0x00, 0x01, 0x01, 0x2c, 0x84, 0x00, 0x00, 0x0d])
  })

  it('writes and reads a block, each block its own memory', async () => {
    const cpu = new FakeS7Cpu({ dbs: { 10: { size: 32 }, 11: { size: 32 } } })
    const { poller, transact } = onCpu(cpu, [
      { name: 'DB10.DBD0', type: 'REAL', writers: 1 },
      { name: 'DB10.DBX8.2', type: 'BOOL', writers: 1 },
      { name: 'DB11.DBD0', type: 'REAL', writers: 0 },
      { name: 'DB10.DBW4', type: 'INT', writers: 0 },
    ])
    await poller.handshake(transact)
    cpu.dbs.get(11)!.bytes.set([0x3e, 0x99, 0x99, 0x9a], 0) // 0.3
    cpu.dbs.get(10)!.bytes.set([0xff, 0xfe], 4) // -2
    cpu.dbs.get(10)!.bytes[8] = 0b1111_1011
    poller.writeSimTags({ 'DB10.DBD0': 0.75, 'DB10.DBX8.2': true })
    await poller.poll(transact)
    expect([...cpu.dbs.get(10)!.bytes.subarray(0, 4)]).toEqual([0x3f, 0x40, 0, 0])
    expect(cpu.dbs.get(10)!.bytes[8]).toBe(0xff) // the bit, and only the bit
    expect(poller.plcTags()).toEqual({ 'DB10.DBW4': -2, 'DB11.DBD0': expect.closeTo(0.3, 6) })
  })

  it('says to untick optimized block access when the CPU refuses a block', async () => {
    const cpu = new FakeS7Cpu({ dbs: { 10: { size: 32, optimized: true } } })
    const { poller, transact } = onCpu(cpu, [{ name: 'DB10.DBW4', type: 'INT', writers: 0 }])
    await poller.handshake(transact)
    await expect(poller.poll(transact)).rejects.toThrow(/refused a read of DB10\.DBB4-5: DB10 has no byte 4\. .*must NOT use optimized block access: turn off 'Optimized block access' for DB10/)
  })

  it('names a block the CPU does not have', async () => {
    const cpu = new FakeS7Cpu()
    const { poller, transact } = onCpu(cpu, [{ name: 'DB99.DBX0.0', type: 'BOOL', writers: 1 }])
    await poller.handshake(transact)
    poller.writeSimTags({ 'DB99.DBX0.0': true })
    await expect(poller.poll(transact)).rejects.toThrow(/refused a write of DB99\.DBX0\.0: the CPU has no DB99 it lets a client reach/)
  })
})
