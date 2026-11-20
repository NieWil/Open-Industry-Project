// The simulator as a Modbus TCP server: the protocol half of an external-PLC link (core/io/externalIo.ts).
//
// The PLC is the master. It polls the sensors it reads (discrete inputs, input registers) and writes the
// actuators it drives (coils, holding registers); this module answers those requests from a process
// image and maps the image to scene tags. It holds no socket. A host owns the transport (a Node `net`
// server today, the desktop shell's main process later) and hands each connection's bytes to a
// ModbusStream, so everything that can be wrong about the protocol is testable here, with no network.
//
// Why a server and not oip-comms. oip-comms (the sibling C++ repo) holds six fieldbus clients, for reaching
// real controllers. A soft PLC such as OpenPLC is itself the master, and
// Modbus gives a client no way to write the PLC's inputs, so for that topology the sim has to serve.
// Nothing here duplicates oip-comms: it has no server.
//
// Semantics (Modbus Application Protocol v1.1b3, and Modbus Messaging on TCP/IP v1.0b):
// - All four areas span the whole 16-bit address space and read as 0 until written. A poll that covers
//   addresses the table does not map succeeds, as it would on a device with spare I/O, rather than failing
//   the whole group; only a range running past 65535 is an illegal address.
// - The unit identifier is echoed and otherwise ignored, as a TCP-only server may.
// - Bits pack least significant first; words are big-endian on the wire, as the protocol says. A 32-bit
//   value spans two registers, and the protocol does not say in which order: each device declares its own.
//   This one puts the low word first, because OpenPLC's Modbus master reads them that way, measured against
//   the real runtime, not assumed (core/io/externalIo.ts, modbusPointFor).

import { ioDirection, isBitArea } from '../../core/io/externalIo'
import type { ExternalIo, ExternalIoPoint, RegisterType } from '../../core/io/externalIo'
import type { TagValue } from '../types'

const SPACE = 0x10000

/** The four data areas, whole. */
export class ModbusImage {
  readonly coils = new Uint8Array(SPACE)
  readonly discreteInputs = new Uint8Array(SPACE)
  readonly holdingRegisters = new Uint16Array(SPACE)
  readonly inputRegisters = new Uint16Array(SPACE)

  bits(area: 'coil' | 'discreteInput'): Uint8Array {
    return area === 'coil' ? this.coils : this.discreteInputs
  }

  words(area: 'holdingRegister' | 'inputRegister'): Uint16Array {
    return area === 'holdingRegister' ? this.holdingRegisters : this.inputRegisters
  }
}

/** Exception codes this server raises. */
export const ILLEGAL_FUNCTION = 0x01
export const ILLEGAL_DATA_ADDRESS = 0x02
export const ILLEGAL_DATA_VALUE = 0x03

/** What the master has asked, for a monitor view and for a test to prove the PLC really polled. */
export interface ModbusStats {
  /** requests per function code */
  requests: Record<number, number>
  exceptions: number
}

const u16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!

function exception(fc: number, code: number): Uint8Array {
  return Uint8Array.of(fc | 0x80, code)
}

/**
 * Answer one request PDU (function code + data) against the image. Always returns a response PDU,
 * an exception included; a request is never dropped here.
 */
export function handlePdu(image: ModbusImage, pdu: Uint8Array, stats?: ModbusStats): Uint8Array {
  const fc = pdu[0] ?? 0
  if (stats) stats.requests[fc] = (stats.requests[fc] ?? 0) + 1
  const res = answer(image, fc, pdu)
  if (stats && res[0]! & 0x80) stats.exceptions++
  return res
}

function answer(image: ModbusImage, fc: number, pdu: Uint8Array): Uint8Array {
  switch (fc) {
    case 0x01:
    case 0x02: {
      if (pdu.length !== 5) return exception(fc, ILLEGAL_DATA_VALUE)
      const addr = u16(pdu, 1)
      const qty = u16(pdu, 3)
      if (qty < 1 || qty > 2000) return exception(fc, ILLEGAL_DATA_VALUE)
      if (addr + qty > SPACE) return exception(fc, ILLEGAL_DATA_ADDRESS)
      const src = image.bits(fc === 0x01 ? 'coil' : 'discreteInput')
      const n = Math.ceil(qty / 8)
      const out = new Uint8Array(2 + n)
      out[0] = fc
      out[1] = n
      for (let i = 0; i < qty; i++) if (src[addr + i]) out[2 + (i >> 3)]! |= 1 << (i & 7)
      return out
    }
    case 0x03:
    case 0x04: {
      if (pdu.length !== 5) return exception(fc, ILLEGAL_DATA_VALUE)
      const addr = u16(pdu, 1)
      const qty = u16(pdu, 3)
      if (qty < 1 || qty > 125) return exception(fc, ILLEGAL_DATA_VALUE)
      if (addr + qty > SPACE) return exception(fc, ILLEGAL_DATA_ADDRESS)
      const src = image.words(fc === 0x03 ? 'holdingRegister' : 'inputRegister')
      const out = new Uint8Array(2 + qty * 2)
      out[0] = fc
      out[1] = qty * 2
      for (let i = 0; i < qty; i++) {
        const v = src[addr + i]!
        out[2 + i * 2] = v >> 8
        out[3 + i * 2] = v & 0xff
      }
      return out
    }
    case 0x05: {
      if (pdu.length !== 5) return exception(fc, ILLEGAL_DATA_VALUE)
      const value = u16(pdu, 3)
      if (value !== 0xff00 && value !== 0x0000) return exception(fc, ILLEGAL_DATA_VALUE)
      image.coils[u16(pdu, 1)] = value === 0xff00 ? 1 : 0
      return pdu.slice()
    }
    case 0x06: {
      if (pdu.length !== 5) return exception(fc, ILLEGAL_DATA_VALUE)
      image.holdingRegisters[u16(pdu, 1)] = u16(pdu, 3)
      return pdu.slice()
    }
    case 0x0f: {
      if (pdu.length < 6) return exception(fc, ILLEGAL_DATA_VALUE)
      const addr = u16(pdu, 1)
      const qty = u16(pdu, 3)
      const n = pdu[5]!
      if (qty < 1 || qty > 1968 || n !== Math.ceil(qty / 8) || pdu.length !== 6 + n) return exception(fc, ILLEGAL_DATA_VALUE)
      if (addr + qty > SPACE) return exception(fc, ILLEGAL_DATA_ADDRESS)
      for (let i = 0; i < qty; i++) image.coils[addr + i] = (pdu[6 + (i >> 3)]! >> (i & 7)) & 1
      return pdu.slice(0, 5)
    }
    case 0x10: {
      if (pdu.length < 6) return exception(fc, ILLEGAL_DATA_VALUE)
      const addr = u16(pdu, 1)
      const qty = u16(pdu, 3)
      const n = pdu[5]!
      if (qty < 1 || qty > 123 || n !== qty * 2 || pdu.length !== 6 + n) return exception(fc, ILLEGAL_DATA_VALUE)
      if (addr + qty > SPACE) return exception(fc, ILLEGAL_DATA_ADDRESS)
      for (let i = 0; i < qty; i++) image.holdingRegisters[addr + i] = u16(pdu, 6 + i * 2)
      return pdu.slice(0, 5)
    }
    default:
      return exception(fc, ILLEGAL_FUNCTION)
  }
}

/** The MBAP header is 7 bytes: transaction id, protocol id (0), length (unit id + PDU), unit id. */
const MBAP = 7
/** the largest PDU is 253 bytes, so the length field never exceeds 254 */
const MAX_LENGTH = 254

/**
 * One TCP connection's byte stream. TCP delivers bytes, not frames: a request can arrive split across
 * reads or several can arrive in one, so this reassembles by the MBAP length field.
 */
export class ModbusStream {
  #pending = new Uint8Array(0)
  /** set once the stream carried something that is not Modbus TCP; the host should close the connection */
  error: string | null = null

  constructor(
    private readonly image: ModbusImage,
    private readonly stats?: ModbusStats,
  ) {}

  /** Feed received bytes; returns the response frames to send, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.error) return []
    const buf = new Uint8Array(this.#pending.length + chunk.length)
    buf.set(this.#pending)
    buf.set(chunk, this.#pending.length)
    const out: Uint8Array[] = []
    let at = 0
    while (buf.length - at >= MBAP) {
      const length = u16(buf, at + 4)
      if (length < 2 || length > MAX_LENGTH) {
        this.error = `a frame declared ${length} bytes after its header, outside Modbus TCP's 2-${MAX_LENGTH}`
        return out
      }
      if (buf.length - at < 6 + length) break
      const frame = buf.subarray(at, at + 6 + length)
      at += 6 + length
      // protocol id 0 is Modbus; anything else on this port is another protocol's frame, which a
      // Modbus server ignores rather than answers
      if (u16(frame, 2) !== 0) continue
      const res = handlePdu(this.image, frame.subarray(MBAP), this.stats)
      const reply = new Uint8Array(MBAP + res.length)
      reply.set(frame.subarray(0, 4)) // transaction id + protocol id, echoed
      reply[4] = (res.length + 1) >> 8
      reply[5] = (res.length + 1) & 0xff
      reply[6] = frame[6]! // unit id, echoed
      reply.set(res, MBAP)
      out.push(reply)
    }
    this.#pending = buf.slice(at)
    return out
  }
}

const number = (v: TagValue): number => {
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : 0
}

/** One scratch word for the IEEE754 bit pattern of a REAL, so a float32 conversion allocates nothing. */
const scratch = new DataView(new ArrayBuffer(4))

/**
 * Put a tag's number into the registers starting at `at`. A 32-bit value takes two, low word first: the
 * order OpenPLC's master reads them in, measured against the real runtime (core/io/externalIo.ts), and the
 * order a little-endian PLC's process image already has, which is why the Modbus client (modbusClient.ts)
 * packs with this same function.
 */
export function writeRegisterValue(words: Uint16Array, at: number, type: RegisterType | undefined, v: TagValue): void {
  const n = number(v)
  if (type === 'REAL') {
    scratch.setFloat32(0, n, true)
    words[at] = scratch.getUint16(0, true)
    words[at + 1] = scratch.getUint16(2, true)
    return
  }
  if (type === 'DINT') {
    const d = Math.min(2147483647, Math.max(-2147483648, Math.round(n))) | 0
    words[at] = d & 0xffff
    words[at + 1] = (d >>> 16) & 0xffff
    return
  }
  // saturate rather than wrap: a count past the register's range reading as a small number is the
  // failure a person would not notice
  const r = Math.round(n)
  words[at] = type === 'UINT' ? Math.min(65535, Math.max(0, r)) : Math.min(32767, Math.max(-32768, r)) & 0xffff
}

/** The number the registers starting at `at` hold. */
export function readRegisterValue(words: Uint16Array, at: number, type: RegisterType | undefined): number {
  const lo = words[at]!
  if (type === 'REAL') {
    scratch.setUint16(0, lo, true)
    scratch.setUint16(2, words[at + 1]!, true)
    return scratch.getFloat32(0, true)
  }
  if (type === 'DINT') return (words[at + 1]! * 0x10000 + lo) | 0
  return type === 'UINT' ? lo : (lo << 16) >> 16
}

/**
 * The table applied to an image: scene tags in, PLC-written tags out. The link calls `writeSimTags`
 * with what the parts reported, and feeds `plcTags()` back to the parts as the values they read.
 */
export class ModbusServerIo {
  readonly image = new ModbusImage()
  readonly stats: ModbusStats = { requests: {}, exceptions: 0 }
  readonly #toPlc: ExternalIoPoint[]
  readonly #fromPlc: ExternalIoPoint[]

  constructor(readonly io: ExternalIo) {
    this.#toPlc = io.points.filter((p) => ioDirection(p.area) === 'toPlc')
    this.#fromPlc = io.points.filter((p) => ioDirection(p.area) === 'fromPlc')
  }

  /** A stream for one new connection, answering from this image. */
  connection(): ModbusStream {
    return new ModbusStream(this.image, this.stats)
  }

  /**
   * Latch what the scene reports into the areas the PLC reads. A tag missing from `tags` keeps its last
   * value, the way a sensor's input holds between updates; a present non-number reads as 0.
   */
  writeSimTags(tags: Readonly<Record<string, TagValue>>): void {
    for (const p of this.#toPlc) {
      const v = tags[p.tag]
      if (v === undefined) continue
      if (isBitArea(p.area)) this.image.bits(p.area as 'discreteInput')[p.address] = truthy(v) ? 1 : 0
      else writeRegisterValue(this.image.words(p.area as 'inputRegister'), p.address, p.type, v)
    }
  }

  /**
   * Every tag the PLC drives, at the value it holds when nothing drives it: a coil off, a register 0.
   *
   * This is what the link hands the scene when the PLC stops answering (editor/links/externalPlc.ts). The image
   * is left as it is, so the moment polling resumes the real values come back without the master having to
   * rewrite them - and so a monitor can still show what the PLC last said.
   */
  offTags(): Record<string, TagValue> {
    const out: Record<string, TagValue> = {}
    for (const p of this.#fromPlc) out[p.tag] = isBitArea(p.area) ? false : 0
    return out
  }

  /** What the PLC last wrote, as scene tags. Unwritten points read as false / 0. */
  plcTags(): Record<string, TagValue> {
    const out: Record<string, TagValue> = {}
    for (const p of this.#fromPlc) {
      out[p.tag] = isBitArea(p.area) ? this.image.bits(p.area as 'coil')[p.address] === 1 : readRegisterValue(this.image.words(p.area as 'holdingRegister'), p.address, p.type)
    }
    return out
  }
}

export const truthy = (v: TagValue): boolean => (typeof v === 'string' ? v !== '' : Boolean(v))

/** For a monitor line: "FC2 x40, FC15 x40". */
export function describeStats(stats: ModbusStats): string {
  const parts = Object.entries(stats.requests)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([fc, n]) => `FC${fc} x${n}`)
  return `${parts.join(', ') || 'no requests'}${stats.exceptions ? `, ${stats.exceptions} exception(s)` : ''}`
}
