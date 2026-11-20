import { describe, expect, it } from 'vitest'
import { clientDrivenTags, modbusClientFromTags, registerImagePointFor, registerImagePointWhere } from '../../core/io/externalIo'
import type { ModbusClientIo } from '../../core/io/externalIo'
import { MAX_READ_REGISTERS, MAX_WRITE_REGISTERS, ModbusClientError, ModbusClientStream, ModbusPoller, readInputRegistersPdu, writeRegistersPdu } from './modbusClient'
import { describeStats, handlePdu, ModbusImage, ModbusStream } from './modbusServer'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

const table = (tags: Parameters<typeof modbusClientFromTags>[1]): ModbusClientIo => {
  const r = modbusClientFromTags({ host: '127.0.0.1', port: 5502 }, tags)
  if (r.problems.length > 0) throw new Error(r.problems.map((p) => p.message).join('; '))
  return r.io
}

/** A server to poll: this repo's own, answering from one image, so the client is checked against it. */
function loopback(): { image: ModbusImage; transact: (pdu: Uint8Array) => Promise<Uint8Array> } {
  const image = new ModbusImage()
  return { image, transact: async (pdu) => handlePdu(image, pdu) }
}

/** The float32 a pair of registers holds, low word first. */
function realAt(words: Uint16Array, at: number): number {
  const v = new DataView(new ArrayBuffer(4))
  v.setUint16(0, words[at]!, true)
  v.setUint16(2, words[at + 1]!, true)
  return v.getFloat32(0, true)
}

describe('registerImagePointFor (a server device exposing the process image byte-wise)', () => {
  it('puts the first input bit in bit 0 of holding register 0', () => {
    expect(registerImagePointFor('%IX0.0')).toEqual({ area: 'holdingRegister', register: 0, bit: 0, words: 1 })
  })

  it('puts an odd byte in the high half of its register, low byte first', () => {
    expect(registerImagePointFor('%IX1.0')).toEqual({ area: 'holdingRegister', register: 0, bit: 8, words: 1 })
    expect(registerImagePointFor('%IX1.7')).toEqual({ area: 'holdingRegister', register: 0, bit: 15, words: 1 })
    expect(registerImagePointFor('%IX2.3')).toEqual({ area: 'holdingRegister', register: 1, bit: 3, words: 1 })
  })

  it('reaches the addresses a scene uses with OpenPLC with no offset: %IX100.0 is register 50', () => {
    expect(registerImagePointFor('%IX100.0')).toEqual({ area: 'holdingRegister', register: 50, bit: 0, words: 1 })
    expect(registerImagePointFor('%QX100.0')).toEqual({ area: 'inputRegister', register: 50, bit: 0, words: 1 })
  })

  it('maps words at their index and double words at twice theirs, two registers wide', () => {
    expect(registerImagePointFor('%IW7')).toEqual({ area: 'holdingRegister', register: 7, words: 1 })
    expect(registerImagePointFor('%ID100')).toEqual({ area: 'holdingRegister', register: 200, words: 2 })
    expect(registerImagePointFor('%QD100')).toEqual({ area: 'inputRegister', register: 200, words: 2 })
    expect(registerImagePointFor('%QX0.0')).toEqual({ area: 'inputRegister', register: 0, bit: 0, words: 1 })
  })

  it('counts from where the device sits in the image, and refuses an address below it', () => {
    const base = { input: 4, output: 10 }
    expect(registerImagePointFor('%IX8.0', base)).toEqual({ area: 'holdingRegister', register: 0, bit: 0, words: 1 })
    expect(registerImagePointFor('%IW5', base)).toEqual({ area: 'holdingRegister', register: 1, words: 1 })
    expect(registerImagePointFor('%QD6', base)).toEqual({ area: 'inputRegister', register: 2, words: 2 })
    expect(registerImagePointFor('%IX7.7', base)).toHaveProperty('error', expect.stringContaining('below the server device\'s first register (%IW4)'))
    expect(registerImagePointFor('%QW9', base)).toHaveProperty('error', expect.stringContaining('(%QW10)'))
  })

  it('refuses memory, bytes, and anything past the last register', () => {
    expect(registerImagePointFor('%MX0.0')).toHaveProperty('error', expect.stringContaining('memory'))
    expect(registerImagePointFor('%IB3')).toHaveProperty('error', expect.stringContaining('byte'))
    expect(registerImagePointFor('%ID40000')).toHaveProperty('error', expect.stringContaining('65535'))
    expect(registerImagePointFor('Conveyor.Run')).toHaveProperty('error')
  })
})

describe('modbusClientFromTags', () => {
  it('takes the address tags, typed by what each carries, in area and register order', () => {
    const r = modbusClientFromTags({ host: '127.0.0.1', port: 5502 }, [
      { name: '%QD100', type: 'REAL' },
      '%IX100.3',
      'Belt.Running',
      { name: '%ID101', type: 'INT' },
      '%IX100.0',
      '%IW4',
      '%IX100.0',
    ])
    expect(r.problems).toEqual([])
    expect(r.io).toEqual({
      protocol: 'modbus-tcp-client',
      host: '127.0.0.1',
      port: 5502,
      unitId: 1,
      base: { input: 0, output: 0 },
      points: [
        { tag: '%IW4', area: 'holdingRegister', register: 4, words: 1, type: 'INT' },
        { tag: '%IX100.0', area: 'holdingRegister', register: 50, bit: 0, words: 1 },
        { tag: '%IX100.3', area: 'holdingRegister', register: 50, bit: 3, words: 1 },
        { tag: '%ID101', area: 'holdingRegister', register: 202, words: 2, type: 'DINT' },
        { tag: '%QD100', area: 'inputRegister', register: 200, words: 2, type: 'REAL' },
      ],
    })
  })

  it('reports an address that cannot travel instead of dropping it silently', () => {
    const r = modbusClientFromTags({ host: 'plc', port: 502, unitId: 3 }, ['%MX0.0', '%QX0.1'])
    expect(r.io.unitId).toBe(3)
    expect(r.io.points.map((p) => p.tag)).toEqual(['%QX0.1'])
    expect(r.problems).toEqual([{ tag: '%MX0.0', message: expect.stringContaining('memory') }])
  })

  it('places points from the base it is given, and names the tags the PLC drives', () => {
    const r = modbusClientFromTags({ host: 'plc', port: 502, base: { input: 2, output: 0 } }, ['%IX4.1', '%IX0.0', '%QX0.0', { name: '%QD1', type: 'REAL' }])
    expect(r.io.base).toEqual({ input: 2, output: 0 })
    expect(r.io.points.map((p) => [p.tag, p.register, p.bit])).toEqual([
      ['%IX4.1', 0, 1],
      ['%QX0.0', 0, 0],
      ['%QD1', 2, undefined],
    ])
    expect(r.problems).toEqual([{ tag: '%IX0.0', message: expect.stringContaining('below') }])
    expect(clientDrivenTags(r.io)).toEqual(['%QX0.0', '%QD1'])
    expect(r.io.points.map((p) => registerImagePointWhere(p))).toEqual(['holding register 0 bit 1', 'input register 0 bit 0', 'input registers 2-3'])
  })
})

describe('Modbus client PDUs', () => {
  it('builds FC16 and FC4 requests big-endian on the wire', () => {
    expect(hex(writeRegistersPdu(50, [0x0109, 0xbeef]))).toBe('10 00 32 00 02 04 01 09 be ef')
    expect(hex(readInputRegistersPdu(200, 2))).toBe('04 00 c8 00 02')
  })
})

describe('ModbusPoller against this repo\'s own server', () => {
  it('packs bits that share a register into it, low byte first', async () => {
    const { image, transact } = loopback()
    const poller = new ModbusPoller(table(['%IX100.0', '%IX100.3', '%IX101.0']))
    poller.writeSimTags({ '%IX100.0': true, '%IX100.3': true, '%IX101.0': true })
    await poller.poll(transact)
    expect(image.holdingRegisters[50]).toBe(0x0109)

    // clearing one bit leaves its neighbours, and a tag the scene did not report keeps its value
    poller.writeSimTags({ '%IX100.3': false })
    await poller.poll(transact)
    expect(image.holdingRegisters[50]).toBe(0x0101)
  })

  it('reads the PLC\'s output bits out of the input registers', async () => {
    const { image, transact } = loopback()
    const poller = new ModbusPoller(table(['%QX100.0', '%QX101.2']))
    expect(poller.plcTags()).toEqual({ '%QX100.0': false, '%QX101.2': false })
    image.inputRegisters[50] = 0x0401
    await poller.poll(transact)
    expect(poller.plcTags()).toEqual({ '%QX100.0': true, '%QX101.2': true })
    image.inputRegisters[50] = 0x0400
    await poller.poll(transact)
    expect(poller.plcTags()).toEqual({ '%QX100.0': false, '%QX101.2': true })
  })

  it('carries a REAL each way as its IEEE754 pattern, low word first', async () => {
    const { image, transact } = loopback()
    const poller = new ModbusPoller(table([{ name: '%ID100', type: 'REAL' }, { name: '%QD100', type: 'REAL' }]))
    poller.writeSimTags({ '%ID100': 0.75 })
    const v = new DataView(new ArrayBuffer(4))
    v.setFloat32(0, -2.5, true)
    image.inputRegisters[200] = v.getUint16(0, true)
    image.inputRegisters[201] = v.getUint16(2, true)
    await poller.poll(transact)
    expect(realAt(image.holdingRegisters, 200)).toBe(0.75)
    expect(image.holdingRegisters[200]).toBe(0x0000) // 0.75 = 0x3F400000: the low word is the zero one
    expect(image.holdingRegisters[201]).toBe(0x3f40)
    expect(poller.plcTags()).toEqual({ '%QD100': -2.5 })
  })

  it('carries a signed word and a DINT', async () => {
    const { image, transact } = loopback()
    const poller = new ModbusPoller(table(['%IW3', { name: '%ID5', type: 'INT' }, '%QW3']))
    poller.writeSimTags({ '%IW3': -2, '%ID5': 70000 })
    image.inputRegisters[3] = 0xfffe
    await poller.poll(transact)
    expect(image.holdingRegisters[3]).toBe(0xfffe)
    expect(image.holdingRegisters[10]! + image.holdingRegisters[11]! * 0x10000).toBe(70000)
    expect(poller.plcTags()).toEqual({ '%QW3': -2 })
  })

  it('moves everything in one write and one read per cycle, over the span the points occupy', async () => {
    const { transact } = loopback()
    const poller = new ModbusPoller(table(['%IX100.0', { name: '%ID100', type: 'REAL' }, '%QX100.0', { name: '%QD100', type: 'REAL' }]))
    expect(poller.blocks).toEqual({ holding: { first: 50, count: 152 }, input: { first: 50, count: 152 } })
    await poller.poll(transact)
    // 152 registers: past one request's limit each way, so two of each
    expect(poller.stats.requests).toEqual({ 4: 2, 16: 2 })
    const lean = new ModbusPoller(table(['%IX100.0', '%IX100.1', '%QX100.0']))
    await lean.poll(transact)
    await lean.poll(transact)
    expect(lean.stats.requests).toEqual({ 4: 2, 16: 2 })
    expect(lean.cycles).toBe(2)
    expect(describeStats(lean.stats)).toBe('FC4 x2, FC16 x2')
  })

  it('splits a block wider than one request, in address order, and loses nothing at the seams', async () => {
    const { image, transact } = loopback()
    const tags = ['%IW0', `%IW${MAX_WRITE_REGISTERS - 1}`, `%IW${MAX_WRITE_REGISTERS}`, '%IW300', '%QW0', `%QW${MAX_READ_REGISTERS}`, '%QW400']
    const poller = new ModbusPoller(table(tags))
    poller.writeSimTags({ '%IW0': 1, [`%IW${MAX_WRITE_REGISTERS - 1}`]: 2, [`%IW${MAX_WRITE_REGISTERS}`]: 3, '%IW300': 4 })
    image.inputRegisters[0] = 5
    image.inputRegisters[MAX_READ_REGISTERS] = 6
    image.inputRegisters[400] = 7
    await poller.poll(transact)
    expect([image.holdingRegisters[0], image.holdingRegisters[MAX_WRITE_REGISTERS - 1], image.holdingRegisters[MAX_WRITE_REGISTERS], image.holdingRegisters[300]]).toEqual([1, 2, 3, 4])
    expect(poller.plcTags()).toEqual({ '%QW0': 5, [`%QW${MAX_READ_REGISTERS}`]: 6, '%QW400': 7 })
    expect(poller.stats.requests).toEqual({ 16: 3, 4: 4 }) // 301 registers written, 401 read
  })

  it('names the tags the PLC drives, and their resting values', () => {
    const poller = new ModbusPoller(table(['%IX100.0', '%QX100.0', { name: '%QD100', type: 'REAL' }]))
    expect(poller.drivenTags()).toEqual(['%QX100.0', '%QD100'])
    expect(poller.offTags()).toEqual({ '%QX100.0': false, '%QD100': 0 })
  })

  it('rejects on an exception, counts it, and keeps what it last read', async () => {
    const { image, transact } = loopback()
    const poller = new ModbusPoller(table(['%IX0.0', '%QX0.0']))
    image.inputRegisters[0] = 1
    await poller.poll(transact)
    const refusing = async (pdu: Uint8Array): Promise<Uint8Array> => Uint8Array.of(pdu[0]! | 0x80, 0x02)
    const e = await poller.poll(refusing).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ModbusClientError)
    expect((e as ModbusClientError).code).toBe(2)
    expect((e as Error).message).toContain('illegal data address')
    expect(poller.stats.exceptions).toBe(1)
    expect(poller.plcTags()).toEqual({ '%QX0.0': true })
    expect(poller.cycles).toBe(1)
  })

  it('rejects an answer that does not match its request', async () => {
    const poller = new ModbusPoller(table(['%IX0.0', '%QX0.0']))
    const wrongAck = async (pdu: Uint8Array): Promise<Uint8Array> => (pdu[0] === 0x10 ? Uint8Array.of(0x10, 0, 9, 0, 1) : Uint8Array.of(0x04, 2, 0, 0))
    await expect(poller.poll(wrongAck)).rejects.toThrow('wrong address or count')
    const shortRead = async (pdu: Uint8Array): Promise<Uint8Array> => (pdu[0] === 0x10 ? pdu.slice(0, 5) : Uint8Array.of(0x04, 0))
    await expect(poller.poll(shortRead)).rejects.toThrow('with 0 bytes')
    const other = async (): Promise<Uint8Array> => Uint8Array.of(0x03, 0)
    await expect(poller.poll(other)).rejects.toThrow('function code 3')
  })
})

describe('ModbusClientStream', () => {
  it('frames a request with a fresh transaction id and the unit id', () => {
    const s = new ModbusClientStream(7)
    const a = s.frame(readInputRegistersPdu(0, 1))
    const b = s.frame(readInputRegistersPdu(0, 1))
    expect(hex(a.bytes)).toBe('00 01 00 00 00 06 07 04 00 00 00 01')
    expect(b.tid).toBe(2)
  })

  it('reassembles responses split across reads, and several in one', () => {
    const s = new ModbusClientStream()
    const one = Uint8Array.of(0, 1, 0, 0, 0, 5, 1, 0x04, 2, 0x12, 0x34)
    const two = Uint8Array.of(0, 2, 0, 0, 0, 6, 1, 0x10, 0, 0, 0, 1)
    expect(s.push(one.subarray(0, 4))).toEqual([])
    expect(s.push(one.subarray(4, 9))).toEqual([])
    const got = s.push(Uint8Array.of(...one.subarray(9), ...two))
    expect(got.map((r) => [r.tid, hex(r.pdu)])).toEqual([
      [1, '04 02 12 34'],
      [2, '10 00 00 00 01'],
    ])
  })

  it('skips another protocol\'s frame and stops on one that is not Modbus TCP', () => {
    const s = new ModbusClientStream()
    expect(s.push(Uint8Array.of(0, 1, 0, 9, 0, 3, 1, 0x04, 0))).toEqual([])
    expect(s.error).toBeNull()
    s.push(Uint8Array.of(0, 1, 0, 0, 0x10, 0, 1))
    expect(s.error).toContain('outside Modbus TCP')
    expect(s.push(Uint8Array.of(0, 1, 0, 0, 0, 3, 1, 0x04, 0))).toEqual([])
  })

  it('closes the loop against the server\'s own stream, byte for byte', async () => {
    const image = new ModbusImage()
    image.inputRegisters[50] = 1
    const server = new ModbusStream(image)
    const client = new ModbusClientStream()
    // the transport a host would provide: frame, send, match the answer by transaction id
    const transact = async (pdu: Uint8Array): Promise<Uint8Array> => {
      const { tid, bytes } = client.frame(pdu)
      const replies = server.push(bytes).flatMap((r) => client.push(r))
      const mine = replies.find((r) => r.tid === tid)
      if (!mine) throw new Error('no answer')
      return mine.pdu
    }
    const poller = new ModbusPoller(table(['%IX100.0', '%QX100.0']))
    poller.writeSimTags({ '%IX100.0': true })
    await poller.poll(transact)
    expect(image.holdingRegisters[50]).toBe(1)
    expect(poller.plcTags()).toEqual({ '%QX100.0': true })
  })
})
