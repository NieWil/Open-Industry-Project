// The simulator as a Modbus TCP client: the other topology of an external-PLC link (core/io/externalIo.ts).
//
// modbusServer.ts is the topology where the PLC polls the simulator. Here the PLC serves and the
// simulator polls it, which is how a PLC is reached that exposes its process image as registers through a
// Modbus server of its own (src/plc/DEVICE-IO.md). So the simulator, not the PLC, sets the pace of the link.
//
// One poll cycle is two requests, whatever the scene holds:
//   1. FC16 writes the whole holding-register block: every PLC input the scene drives, bits and words
//      together, since bits share registers and a single-bit write (FC5) would reach a coil, which a
//      register-image server may alias onto the holding registers;
//   2. FC4 reads the whole input-register block: every PLC output.
// A block wider than one request allows (123 registers written, 125 read) is split, in address order.
//
// Like the server, this holds no socket. `poll` takes a `transact` function that sends one request PDU
// and resolves with its response PDU; the host owns the connection (the app's ExternalPlcClientSession over
// the desktop shell's socket, editor/links/externalPlc.ts) and ModbusClientStream frames the bytes for it. So everything that can be wrong about the
// protocol is testable here, against this repo's own server, with no network.

import type { ClientIoPoint, ModbusClientIo } from '../../core/io/externalIo'
import { readRegisterValue, truthy, writeRegisterValue } from './modbusServer'
import type { ModbusStats } from './modbusServer'
import type { TagValue } from '../types'

/** FC16 carries at most 123 registers, FC4 at most 125 (Modbus Application Protocol v1.1b3). */
export const MAX_WRITE_REGISTERS = 123
export const MAX_READ_REGISTERS = 125

/** A request the PLC answered with an exception, or with something that is not an answer to it. */
export class ModbusClientError extends Error {
  constructor(
    message: string,
    /** the exception code, when the server raised one */
    readonly code?: number,
  ) {
    super(message)
    this.name = 'ModbusClientError'
  }
}

const EXCEPTION_NAMES: Record<number, string> = {
  1: 'illegal function',
  2: 'illegal data address',
  3: 'illegal data value',
  4: 'server device failure',
  6: 'server device busy',
  10: 'gateway path unavailable',
  11: 'gateway target failed to respond',
}

/** An FC16 request: write `values` to the holding registers starting at `address`. */
export function writeRegistersPdu(address: number, values: ArrayLike<number>): Uint8Array {
  const n = values.length
  const pdu = new Uint8Array(6 + n * 2)
  pdu[0] = 0x10
  pdu[1] = address >> 8
  pdu[2] = address & 0xff
  pdu[3] = n >> 8
  pdu[4] = n & 0xff
  pdu[5] = n * 2
  for (let i = 0; i < n; i++) {
    pdu[6 + i * 2] = (values[i]! >> 8) & 0xff
    pdu[7 + i * 2] = values[i]! & 0xff
  }
  return pdu
}

/** An FC4 request: read `count` input registers starting at `address`. */
export function readInputRegistersPdu(address: number, count: number): Uint8Array {
  return Uint8Array.of(0x04, address >> 8, address & 0xff, count >> 8, count & 0xff)
}

/** Throw unless `res` is the normal response to request `fc`. */
function expectAnswer(fc: number, res: Uint8Array, what: string): void {
  if (res[0] === (fc | 0x80)) {
    const code = res[1] ?? 0
    throw new ModbusClientError(`the PLC refused ${what}: exception ${code} (${EXCEPTION_NAMES[code] ?? 'unknown'})`, code)
  }
  if (res[0] !== fc) throw new ModbusClientError(`the PLC answered ${what} with function code ${res[0] ?? 'none'}`)
}

/** The span of registers a set of points occupies: first register and count, or null when there are none. */
function span(points: readonly ClientIoPoint[]): { first: number; count: number } | null {
  if (points.length === 0) return null
  const first = Math.min(...points.map((p) => p.register))
  const end = Math.max(...points.map((p) => p.register + p.words))
  return { first, count: end - first }
}

/**
 * The table applied to a pair of register blocks: scene tags in, PLC-written tags out, with the same
 * surface as the server's ModbusServerIo so a loop can drive either. `poll` moves the blocks.
 */
export class ModbusPoller {
  readonly stats: ModbusStats = { requests: {}, exceptions: 0 }
  /** completed poll cycles */
  cycles = 0
  readonly #toPlc: ClientIoPoint[]
  readonly #fromPlc: ClientIoPoint[]
  readonly #write: { first: number; count: number } | null
  readonly #read: { first: number; count: number } | null
  /** the holding registers as this client last set them, indexed from the block's first register */
  readonly #holding: Uint16Array
  /** the input registers as last read, indexed from the block's first register */
  readonly #input: Uint16Array

  constructor(readonly io: ModbusClientIo) {
    this.#toPlc = io.points.filter((p) => p.area === 'holdingRegister')
    this.#fromPlc = io.points.filter((p) => p.area === 'inputRegister')
    this.#write = span(this.#toPlc)
    this.#read = span(this.#fromPlc)
    this.#holding = new Uint16Array(this.#write?.count ?? 0)
    this.#input = new Uint16Array(this.#read?.count ?? 0)
  }

  /** The register blocks one cycle moves: what a server device's areas must be large enough to hold. */
  get blocks(): { holding: { first: number; count: number } | null; input: { first: number; count: number } | null } {
    return { holding: this.#write, input: this.#read }
  }

  /** The tags the PLC drives, for the scene to stop driving them itself. */
  drivenTags(): string[] {
    return [...new Set(this.#fromPlc.map((p) => p.tag))]
  }

  /**
   * Latch what the scene reports into the holding block, to go out on the next poll. A tag missing from
   * `tags` keeps its last value, as on the server side; a bit changes only its own bit of the register.
   */
  writeSimTags(tags: Readonly<Record<string, TagValue>>): void {
    const base = this.#write?.first ?? 0
    for (const p of this.#toPlc) {
      const v = tags[p.tag]
      if (v === undefined) continue
      const at = p.register - base
      if (p.bit !== undefined) {
        const mask = 1 << p.bit
        this.#holding[at] = truthy(v) ? this.#holding[at]! | mask : this.#holding[at]! & ~mask
      } else {
        writeRegisterValue(this.#holding, at, p.type, v)
      }
    }
  }

  /** What the PLC last wrote, as scene tags. Before the first poll every point reads false / 0. */
  plcTags(): Record<string, TagValue> {
    const base = this.#read?.first ?? 0
    const out: Record<string, TagValue> = {}
    for (const p of this.#fromPlc) {
      const at = p.register - base
      out[p.tag] = p.bit !== undefined ? ((this.#input[at]! >> p.bit) & 1) === 1 : readRegisterValue(this.#input, at, p.type)
    }
    return out
  }

  /** Every tag the PLC drives, at the value it holds when nothing drives it, as the server's offTags. */
  offTags(): Record<string, TagValue> {
    const out: Record<string, TagValue> = {}
    for (const p of this.#fromPlc) out[p.tag] = p.bit !== undefined ? false : 0
    return out
  }

  /**
   * One cycle: write the holding block, then read the input block. Rejects with a ModbusClientError when
   * the PLC refuses a request, and with whatever `transact` rejects with when the connection fails; the
   * blocks this side holds are left as they were, so the next cycle tries again.
   */
  async poll(transact: (pdu: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    const request = async (pdu: Uint8Array, what: string): Promise<Uint8Array> => {
      const fc = pdu[0]!
      this.stats.requests[fc] = (this.stats.requests[fc] ?? 0) + 1
      const res = await transact(pdu)
      try {
        expectAnswer(fc, res, what)
      } catch (e) {
        this.stats.exceptions++
        throw e
      }
      return res
    }

    if (this.#write) {
      for (let off = 0; off < this.#write.count; off += MAX_WRITE_REGISTERS) {
        const n = Math.min(MAX_WRITE_REGISTERS, this.#write.count - off)
        const address = this.#write.first + off
        const res = await request(writeRegistersPdu(address, this.#holding.subarray(off, off + n)), `a write of holding registers ${address}-${address + n - 1}`)
        if (res.length !== 5 || ((res[1]! << 8) | res[2]!) !== address || ((res[3]! << 8) | res[4]!) !== n) {
          this.stats.exceptions++
          throw new ModbusClientError(`the PLC acknowledged a write of holding registers ${address}-${address + n - 1} with the wrong address or count`)
        }
      }
    }
    if (this.#read) {
      for (let off = 0; off < this.#read.count; off += MAX_READ_REGISTERS) {
        const n = Math.min(MAX_READ_REGISTERS, this.#read.count - off)
        const address = this.#read.first + off
        const res = await request(readInputRegistersPdu(address, n), `a read of input registers ${address}-${address + n - 1}`)
        if (res[1] !== n * 2 || res.length !== 2 + n * 2) {
          this.stats.exceptions++
          throw new ModbusClientError(`the PLC answered a read of ${n} input registers with ${res[1] ?? 0} bytes`)
        }
        for (let i = 0; i < n; i++) this.#input[off + i] = (res[2 + i * 2]! << 8) | res[3 + i * 2]!
      }
    }
    this.cycles++
  }
}

/** The MBAP header: transaction id, protocol id (0), length (unit id + PDU), unit id. */
const MBAP = 7
const MAX_LENGTH = 254

/**
 * One client connection's framing. `frame` wraps a request PDU with a fresh transaction id; `push` takes
 * received bytes, reassembles whole frames by the MBAP length field (TCP delivers bytes, not frames) and
 * returns the responses in them with the transaction id each answers, so the host can match them up.
 */
export class ModbusClientStream {
  #tid = 0
  #pending = new Uint8Array(0)
  /** set once the stream carried something that is not Modbus TCP; the host should close the connection */
  error: string | null = null

  constructor(readonly unitId = 1) {}

  frame(pdu: Uint8Array): { tid: number; bytes: Uint8Array } {
    const tid = (this.#tid = (this.#tid + 1) & 0xffff)
    const bytes = new Uint8Array(MBAP + pdu.length)
    bytes[0] = tid >> 8
    bytes[1] = tid & 0xff
    bytes[4] = (pdu.length + 1) >> 8
    bytes[5] = (pdu.length + 1) & 0xff
    bytes[6] = this.unitId
    bytes.set(pdu, MBAP)
    return { tid, bytes }
  }

  push(chunk: Uint8Array): { tid: number; pdu: Uint8Array }[] {
    if (this.error) return []
    const buf = new Uint8Array(this.#pending.length + chunk.length)
    buf.set(this.#pending)
    buf.set(chunk, this.#pending.length)
    const out: { tid: number; pdu: Uint8Array }[] = []
    let at = 0
    while (buf.length - at >= MBAP) {
      const length = (buf[at + 4]! << 8) | buf[at + 5]!
      if (length < 2 || length > MAX_LENGTH) {
        this.error = `a frame declared ${length} bytes after its header, outside Modbus TCP's 2-${MAX_LENGTH}`
        return out
      }
      if (buf.length - at < 6 + length) break
      const frame = buf.subarray(at, at + 6 + length)
      at += 6 + length
      if (((frame[2]! << 8) | frame[3]!) !== 0) continue // another protocol's frame: not an answer
      out.push({ tid: (frame[0]! << 8) | frame[1]!, pdu: frame.slice(MBAP) })
    }
    this.#pending = buf.slice(at)
    return out
  }
}
