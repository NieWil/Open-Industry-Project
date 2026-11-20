import { describe, expect, it } from 'vitest'
import { validateExternalIo } from '../../core/io/externalIo'
import type { ExternalIo } from '../../core/io/externalIo'
import { describeStats, handlePdu, ModbusImage, ModbusServerIo, ModbusStream } from './modbusServer'

const pdu = (...bytes: number[]): Uint8Array => Uint8Array.of(...bytes)
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

/** a request frame: transaction id, protocol 0, length, unit id, then the PDU */
const frame = (tid: number, unit: number, body: number[]): Uint8Array =>
  Uint8Array.of(tid >> 8, tid & 0xff, 0, 0, (body.length + 1) >> 8, (body.length + 1) & 0xff, unit, ...body)

const table = (points: unknown[]): ExternalIo => {
  const r = validateExternalIo({ protocol: 'modbus-tcp-server', host: '127.0.0.1', port: 5020, points })
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.io
}

describe('Modbus PDU handling', () => {
  it('reads bits packed least significant first, padded to whole bytes', () => {
    const img = new ModbusImage()
    img.discreteInputs[10] = 1
    img.discreteInputs[12] = 1
    img.discreteInputs[19] = 1
    // FC2, address 10, 10 inputs -> 2 bytes: 0b00000101, 0b00000010
    expect(hex(handlePdu(img, pdu(0x02, 0, 10, 0, 10)))).toBe('02 02 05 02')
    img.coils[0] = 1
    expect(hex(handlePdu(img, pdu(0x01, 0, 0, 0, 1)))).toBe('01 01 01')
  })

  it('reads registers big-endian', () => {
    const img = new ModbusImage()
    img.inputRegisters[5] = 0x1234
    img.holdingRegisters[0] = 0xffff
    expect(hex(handlePdu(img, pdu(0x04, 0, 5, 0, 2)))).toBe('04 04 12 34 00 00')
    expect(hex(handlePdu(img, pdu(0x03, 0, 0, 0, 1)))).toBe('03 02 ff ff')
  })

  it('writes a single coil and a single register, echoing the request', () => {
    const img = new ModbusImage()
    expect(hex(handlePdu(img, pdu(0x05, 0, 7, 0xff, 0)))).toBe('05 00 07 ff 00')
    expect(img.coils[7]).toBe(1)
    handlePdu(img, pdu(0x05, 0, 7, 0, 0))
    expect(img.coils[7]).toBe(0)
    expect(hex(handlePdu(img, pdu(0x06, 0, 3, 0xab, 0xcd)))).toBe('06 00 03 ab cd')
    expect(img.holdingRegisters[3]).toBe(0xabcd)
  })

  it('writes multiple coils and registers, answering with address and quantity', () => {
    const img = new ModbusImage()
    // FC15, address 100, 10 coils, 2 bytes: 0b11001101, 0b00000001 (the spec's own example)
    expect(hex(handlePdu(img, pdu(0x0f, 0, 100, 0, 10, 2, 0xcd, 0x01)))).toBe('0f 00 64 00 0a')
    expect(Array.from(img.coils.subarray(100, 110))).toEqual([1, 0, 1, 1, 0, 0, 1, 1, 1, 0])
    expect(hex(handlePdu(img, pdu(0x10, 0, 1, 0, 2, 4, 0, 10, 1, 2)))).toBe('10 00 01 00 02')
    expect(Array.from(img.holdingRegisters.subarray(1, 3))).toEqual([10, 0x0102])
  })

  it('raises the exceptions the spec names, and counts them', () => {
    const img = new ModbusImage()
    const stats = { requests: {}, exceptions: 0 }
    expect(hex(handlePdu(img, pdu(0x2b, 0x0e, 1, 0), stats))).toBe('ab 01') // unsupported function
    expect(hex(handlePdu(img, pdu(0x01, 0xff, 0xff, 0, 2), stats))).toBe('81 02') // runs past 65535
    expect(hex(handlePdu(img, pdu(0x03, 0, 0, 0, 126), stats))).toBe('83 03') // too many registers
    expect(hex(handlePdu(img, pdu(0x05, 0, 0, 0x12, 0x34), stats))).toBe('85 03') // a coil value that is not ON/OFF
    expect(hex(handlePdu(img, pdu(0x0f, 0, 0, 0, 9, 1, 0xff), stats))).toBe('8f 03') // byte count does not cover 9 coils
    expect(stats).toEqual({ requests: { 0x2b: 1, 0x01: 1, 0x03: 1, 0x05: 1, 0x0f: 1 }, exceptions: 5 })
    expect(img.coils[0]).toBe(0) // a refused write changes nothing
  })

  it('the last address is legal, one past it is not', () => {
    const img = new ModbusImage()
    img.inputRegisters[65535] = 7
    expect(hex(handlePdu(img, pdu(0x04, 0xff, 0xff, 0, 1)))).toBe('04 02 00 07')
    expect(hex(handlePdu(img, pdu(0x04, 0xff, 0xff, 0, 2)))).toBe('84 02')
  })
})

describe('Modbus TCP stream', () => {
  it('answers each request with its own transaction id and unit id', () => {
    const img = new ModbusImage()
    img.discreteInputs[0] = 1
    const s = new ModbusStream(img)
    const [res] = s.push(frame(0x0102, 9, [0x02, 0, 0, 0, 1]))
    expect(hex(res!)).toBe('01 02 00 00 00 04 09 02 01 01')
  })

  it('reassembles a request split across reads, and splits requests that arrive together', () => {
    const s = new ModbusStream(new ModbusImage())
    const a = frame(1, 1, [0x01, 0, 0, 0, 1])
    const b = frame(2, 1, [0x03, 0, 0, 0, 1])
    expect(s.push(a.subarray(0, 3))).toEqual([])
    expect(s.push(a.subarray(3, 9))).toEqual([])
    const rest = a.subarray(9)
    const both = new Uint8Array(rest.length + b.length)
    both.set(rest)
    both.set(b, rest.length)
    const out = s.push(both)
    expect(out.map((r) => r[1])).toEqual([1, 2])
  })

  it('ignores a frame of another protocol and keeps going', () => {
    const s = new ModbusStream(new ModbusImage())
    const other = frame(5, 1, [0x01, 0, 0, 0, 1])
    other[3] = 1
    const out = s.push(Uint8Array.from([...other, ...frame(6, 1, [0x01, 0, 0, 0, 1])]))
    expect(out.map((r) => r[1])).toEqual([6])
  })

  it('gives up on a stream whose length field cannot be Modbus, so the host closes it', () => {
    const s = new ModbusStream(new ModbusImage())
    expect(s.push(Uint8Array.of(0, 1, 0, 0, 0x40, 0, 1))).toEqual([])
    expect(s.error).toMatch(/16384 bytes/)
    expect(s.push(frame(1, 1, [0x01, 0, 0, 0, 1]))).toEqual([]) // stays dead
  })
})

describe('the table applied to the image', () => {
  it('writes scene tags into the areas the PLC reads and reads back what it wrote', () => {
    const io = new ModbusServerIo(table([
      { tag: 'Eye', area: 'discreteInput', address: 0 },
      { tag: 'Count', area: 'inputRegister', address: 0 },
      { tag: 'Run', area: 'coil', address: 0 },
      { tag: 'Speed', area: 'holdingRegister', address: 4, type: 'UINT' },
      { tag: 'Offset', area: 'holdingRegister', address: 5 },
    ]))
    expect(io.plcTags()).toEqual({ Run: false, Speed: 0, Offset: 0 }) // nothing written yet: off
    io.writeSimTags({ Eye: true, Count: 12.6, Unmapped: 1 })
    expect(io.image.discreteInputs[0]).toBe(1)
    expect(io.image.inputRegisters[0]).toBe(13)
    const s = io.connection()
    s.push(frame(1, 1, [0x05, 0, 0, 0xff, 0]))
    s.push(frame(2, 1, [0x10, 0, 4, 0, 2, 4, 0xff, 0xfe, 0xff, 0xfe]))
    expect(io.plcTags()).toEqual({ Run: true, Speed: 65534, Offset: -2 })
    expect(describeStats(io.stats)).toBe('FC5 x1, FC16 x1')
  })

  it('a tag the scene stops reporting holds its last value', () => {
    const io = new ModbusServerIo(table([{ tag: 'Eye', area: 'discreteInput', address: 3 }]))
    io.writeSimTags({ Eye: true })
    io.writeSimTags({})
    expect(io.image.discreteInputs[3]).toBe(1)
    io.writeSimTags({ Eye: false })
    expect(io.image.discreteInputs[3]).toBe(0)
  })

  it('saturates a number outside the register instead of wrapping it', () => {
    const io = new ModbusServerIo(table([
      { tag: 'A', area: 'inputRegister', address: 0 },
      { tag: 'B', area: 'inputRegister', address: 1, type: 'UINT' },
      { tag: 'C', area: 'inputRegister', address: 2 },
    ]))
    io.writeSimTags({ A: 40000, B: -5, C: -40000 })
    expect(Array.from(io.image.inputRegisters.subarray(0, 3))).toEqual([32767, 0, 0x8000])
    io.writeSimTags({ A: Number.NaN, B: 70000, C: true })
    expect(Array.from(io.image.inputRegisters.subarray(0, 3))).toEqual([0, 65535, 1])
  })
})

// A 32-bit value spans two registers and the protocol does not say in which order. These pin our order -
// low word first - which is the one OpenPLC's master reads, measured against the real runtime.
describe('32-bit points: a REAL or a DINT across two registers', () => {
  it('writes a REAL as its IEEE754 pattern, low word first', () => {
    const io = new ModbusServerIo(table([{ tag: 'Speed', area: 'inputRegister', address: 200, type: 'REAL' }]))
    io.writeSimTags({ Speed: 12.5 })
    const expected = new DataView(new ArrayBuffer(4))
    expected.setFloat32(0, 12.5, true)
    expect(io.image.inputRegisters[200]).toBe(expected.getUint16(0, true))
    expect(io.image.inputRegisters[201]).toBe(expected.getUint16(2, true))
  })

  it('reads back what the PLC wrote into a REAL, fraction and sign kept', () => {
    const io = new ModbusServerIo(table([{ tag: 'Setpoint', area: 'holdingRegister', address: 0, type: 'REAL' }]))
    for (const v of [0.25, -1.5, 1234.5, 0]) {
      const bits = new DataView(new ArrayBuffer(4))
      bits.setFloat32(0, v, true)
      const s = io.connection()
      s.push(frame(1, 1, [0x10, 0, 0, 0, 2, 4, bits.getUint8(1), bits.getUint8(0), bits.getUint8(3), bits.getUint8(2)]))
      expect(io.plcTags()).toEqual({ Setpoint: v })
    }
  })

  it('rounds a value to 32-bit precision, because that is what a REAL is', () => {
    const io = new ModbusServerIo(table([
      { tag: 'Out', area: 'inputRegister', address: 0, type: 'REAL' },
      { tag: 'Back', area: 'holdingRegister', address: 0, type: 'REAL' },
    ]))
    io.writeSimTags({ Out: 0.35 })
    io.image.holdingRegisters[0] = io.image.inputRegisters[0]!
    io.image.holdingRegisters[1] = io.image.inputRegisters[1]!
    // 0.35 has no exact float32, so it comes back as the nearest one - a PLC's REAL does the same
    expect(io.plcTags().Back).toBeCloseTo(0.35, 6)
    expect(io.plcTags().Back).not.toBe(0.35)
  })

  it('carries a DINT past what a single register holds', () => {
    const io = new ModbusServerIo(table([
      { tag: 'Count', area: 'inputRegister', address: 0, type: 'DINT' },
      { tag: 'Back', area: 'holdingRegister', address: 0, type: 'DINT' },
    ]))
    io.writeSimTags({ Count: 100000 })
    expect(io.image.inputRegisters[0]).toBe(100000 & 0xffff)
    expect(io.image.inputRegisters[1]).toBe(100000 >>> 16)
    io.image.holdingRegisters[0] = 0xffff
    io.image.holdingRegisters[1] = 0xffff
    expect(io.plcTags()).toEqual({ Back: -1 }) // two's complement across both registers
  })

  it('round trips a REAL through the image, which is what the link does every frame', () => {
    const io = new ModbusServerIo(table([
      { tag: 'Out', area: 'inputRegister', address: 10, type: 'REAL' },
      { tag: 'In', area: 'holdingRegister', address: 10, type: 'REAL' },
    ]))
    io.writeSimTags({ Out: 3.25 })
    io.image.holdingRegisters[10] = io.image.inputRegisters[10]!
    io.image.holdingRegisters[11] = io.image.inputRegisters[11]!
    expect(io.plcTags()).toEqual({ In: 3.25 })
  })
})
