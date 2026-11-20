// The simulator as an S7 client of an S7-1200 / S7-1500 CPU, over PUT/GET (core/io/s7Io.ts says what travels).
//
// The protocol, outermost first, all big-endian:
//   TPKT (RFC 1006)  03 00 <length:2>                       frames the TCP byte stream
//   COTP (ISO 8073)  a connection request / confirm once, then 02 F0 80 before every data PDU
//   S7               32 <type> 00 00 <ref:2> <paramLen:2> <dataLen:2> [<errClass> <errCode>] params data
// A connection is: TCP to port 102, COTP connect (it names the CPU by rack and slot), S7 "setup communication"
// (the two sides agree the largest PDU, 240 to 960 bytes), then read-var / write-var jobs, one at a time.
//
// Ported from the oip-comms driver (S7Com.cpp, which talks to real 1200s and 1500s): the same
// handshake, the same areas, the same "read each area as one block" polling. Two things differ, both because a
// request has to fit the PDU the CPU agreed to, not the one asked for:
//   - writes go several points to a request (multi-item write-var), not a request per point, so a scene with
//     forty sensors is two or three round trips a cycle instead of forty;
//   - every request is sized against the negotiated PDU (an S7-1200 usually agrees 240), item count and all.
// A bit is written as a bit (transport size BIT), never as its byte, so the CPU's other bits in that byte are
// left alone - which matters on I, where the rest of the byte may be a real input card.
//
// Like the Modbus client this holds no socket: S7Stream frames the bytes and S7Poller builds and reads the
// jobs; the host owns the connection (editor/links/s7Link.ts over the desktop shell's socket, scripts/s7-loop.mjs over
// node:net). So everything that can be wrong about the protocol is testable without a network.

import { s7Bytes } from '../../core/io/s7Io'
import type { S7Area, S7ClientIo, S7Point } from '../../core/io/s7Io'
import type { TagValue } from '../types'

/** Why the CPU refused a job, or answered with something that is not an answer to it. */
export class S7Error extends Error {
  constructor(
    message: string,
    /** the S7 header's error class and code (0x8104), or an item's return code, when the CPU gave one */
    readonly code?: number,
  ) {
    super(message)
    this.name = 'S7Error'
  }
}

// ---- framing: TPKT + COTP ----

const TPKT_HEADER = 4
const COTP_CR = 0xe0
const COTP_CC = 0xd0
const COTP_DR = 0x80
const COTP_DT = 0xf0
/** the COTP data header: length 2, DT, last data unit */
const COTP_DATA = Uint8Array.of(0x02, COTP_DT, 0x80)

/** A TPKT frame around `payload`. */
function tpkt(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(TPKT_HEADER + payload.length)
  out[0] = 0x03
  out[2] = out.length >> 8
  out[3] = out.length & 0xff
  out.set(payload, TPKT_HEADER)
  return out
}

/** Our TSAP: a PG's (0x0100), as the snap7 client sends; the CPU does not check it. */
const LOCAL_TSAP = 0x0100
/** The connection type in the CPU's TSAP: 3, an "S7 basic" connection, as oip-comms connects (0x0301). */
const REMOTE_TSAP_TYPE = 0x03

/**
 * The COTP connection request: it names the CPU by rack and slot (its TSAP), and asks for 1024-byte TPDUs.
 * A CPU that is not at that rack and slot refuses the connection here.
 */
export function connectRequest(rack: number, slot: number): Uint8Array {
  const remote = (REMOTE_TSAP_TYPE << 8) | ((rack & 0x07) << 5) | (slot & 0x1f)
  // length 17, CR, dst ref 0, src ref 1, class 0, TPDU size 2^10, calling TSAP, called TSAP
  return tpkt(Uint8Array.of(17, COTP_CR, 0, 0, 0, 1, 0, 0xc0, 1, 0x0a, 0xc1, 2, LOCAL_TSAP >> 8, LOCAL_TSAP & 0xff, 0xc2, 2, remote >> 8, remote & 0xff))
}

/** What the stream carried: the connection confirmed or refused, or an S7 PDU. */
export type S7Frame = { kind: 'confirm' } | { kind: 'refused' } | { kind: 'pdu'; pdu: Uint8Array }

/**
 * One connection's byte stream. `frame` wraps an S7 PDU for sending; `push` takes received bytes and returns
 * the whole frames in them (TCP delivers bytes, not frames), reassembling an S7 PDU that came in several COTP
 * data units.
 */
export class S7Stream {
  #pending = new Uint8Array(0)
  #fragments: Uint8Array[] = []
  /** set once the stream carried something that is not ISO-on-TCP; the host should close the connection */
  error: string | null = null

  frame(pdu: Uint8Array): Uint8Array {
    const payload = new Uint8Array(COTP_DATA.length + pdu.length)
    payload.set(COTP_DATA)
    payload.set(pdu, COTP_DATA.length)
    return tpkt(payload)
  }

  push(chunk: Uint8Array): S7Frame[] {
    if (this.error) return []
    const buf = new Uint8Array(this.#pending.length + chunk.length)
    buf.set(this.#pending)
    buf.set(chunk, this.#pending.length)
    const out: S7Frame[] = []
    let at = 0
    while (buf.length - at >= TPKT_HEADER) {
      if (buf[at] !== 0x03) {
        this.error = `a frame began with ${buf[at]}, not TPKT's 3`
        return out
      }
      const length = (buf[at + 2]! << 8) | buf[at + 3]!
      if (length < TPKT_HEADER + 2) {
        this.error = `a TPKT frame declared ${length} bytes, too short to carry anything`
        return out
      }
      if (buf.length - at < length) break
      const cotp = buf.subarray(at + TPKT_HEADER, at + length)
      at += length
      const kind = cotp[1]! & 0xf0
      if (kind === COTP_CC) out.push({ kind: 'confirm' })
      else if (kind === COTP_DR) out.push({ kind: 'refused' })
      else if (kind === COTP_DT) {
        this.#fragments.push(cotp.slice(1 + cotp[0]!))
        if ((cotp[2]! & 0x80) === 0) continue // more data units of this PDU follow
        const size = this.#fragments.reduce((n, f) => n + f.length, 0)
        const pdu = new Uint8Array(size)
        let o = 0
        for (const f of this.#fragments) {
          pdu.set(f, o)
          o += f.length
        }
        this.#fragments = []
        out.push({ kind: 'pdu', pdu })
      }
      // other COTP units (an expedited data unit, an error unit) carry nothing for us
    }
    this.#pending = buf.slice(at)
    return out
  }
}

// ---- S7 PDUs ----

const PROTOCOL_ID = 0x32
const ROSCTR_JOB = 0x01
const ROSCTR_ACK_DATA = 0x03
const FN_SETUP = 0xf0
const FN_READ = 0x04
const FN_WRITE = 0x05

/** A job's header is 10 bytes; an answer's 12 (it adds the error class and code). */
const JOB_HEADER = 10
const ACK_HEADER = 12
/** One item's address in a request: 12 bytes. One item's header in data: 4 (return code, transport size, length). */
const ITEM_SPEC = 12
const ITEM_DATA_HEADER = 4
/**
 * The most items one job carries. The protocol's own count is a byte, but CPUs refuse well before that; 20 is
 * snap7's limit, met in the field, and within what any 1200/1500 accepts at a 240-byte PDU anyway.
 */
export const MAX_ITEMS = 20
/** What a client asks for; the CPU answers with what it allows (an S7-1200: 240; a 1500: 480 or 960). */
export const REQUESTED_PDU = 960
/** The smallest PDU the protocol allows, used if a CPU answers with less. */
const MIN_PDU = 240

const AREA_CODE: Record<S7Area, number> = { I: 0x81, Q: 0x82, M: 0x83, DB: 0x84 }
/** request transport sizes (the item's unit) */
const TS_BIT = 0x01
const TS_BYTE = 0x02
/** data transport sizes (how its length counts): BIT counts bits, BYTE/WORD/DWORD count bits too */
const DATA_BIT = 0x03
const DATA_BYTE = 0x04

/** A job's 10-byte header. */
function jobHeader(ref: number, paramLength: number, dataLength: number): Uint8Array {
  return Uint8Array.of(PROTOCOL_ID, ROSCTR_JOB, 0, 0, ref >> 8, ref & 0xff, paramLength >> 8, paramLength & 0xff, dataLength >> 8, dataLength & 0xff)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** "Setup communication": one job at a time each way, and the largest PDU we would like. */
export function setupRequest(ref: number, pdu = REQUESTED_PDU): Uint8Array {
  return concat([jobHeader(ref, 8, 0), Uint8Array.of(FN_SETUP, 0, 0, 1, 0, 1, pdu >> 8, pdu & 0xff)])
}

/** One item's 12-byte address: S7-ANY, the unit and count, the DB number (0 outside a DB), the area and the offset in bits. */
function itemSpec(it: S7Item, bit: number | undefined, count: number): Uint8Array {
  const bits = it.byte * 8 + (bit ?? 0)
  const unit = bit === undefined ? TS_BYTE : TS_BIT
  const db = it.area === 'DB' ? (it.db ?? 0) : 0
  return Uint8Array.of(0x12, 0x0a, 0x10, unit, count >> 8, count & 0xff, db >> 8, db & 0xff, AREA_CODE[it.area], (bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff)
}

/** A run of bytes to read, or a value to write: what one item carries. */
export interface S7Item {
  area: S7Area
  /** DB only: which data block */
  db?: number
  byte: number
  /** a single bit (write only): its value is bytes[0], 0 or 1 */
  bit?: number
  /** read: how many bytes; write: the bytes */
  length: number
  bytes?: Uint8Array
}

/** A read-var job for `items` (byte runs). */
export function readRequest(ref: number, items: readonly S7Item[]): Uint8Array {
  const params = concat([Uint8Array.of(FN_READ, items.length), ...items.map((it) => itemSpec(it, undefined, it.length))])
  return concat([jobHeader(ref, params.length, 0), params])
}

/** A write item's data: return code 0, its transport size, its length in bits, the bytes, and a fill byte to an even length unless last. */
function writeItemData(it: S7Item, last: boolean): Uint8Array {
  const bytes = it.bytes ?? new Uint8Array(it.length)
  const bitLength = it.bit === undefined ? bytes.length * 8 : 1
  const fill = !last && bytes.length % 2 === 1 ? 1 : 0
  const out = new Uint8Array(ITEM_DATA_HEADER + bytes.length + fill)
  out[1] = it.bit === undefined ? DATA_BYTE : DATA_BIT
  out[2] = bitLength >> 8
  out[3] = bitLength & 0xff
  out.set(bytes, ITEM_DATA_HEADER)
  return out
}

/** A write-var job for `items`. */
export function writeRequest(ref: number, items: readonly S7Item[]): Uint8Array {
  const params = concat([Uint8Array.of(FN_WRITE, items.length), ...items.map((it) => itemSpec(it, it.bit, it.bit === undefined ? it.length : 1))])
  const data = concat(items.map((it, i) => writeItemData(it, i === items.length - 1)))
  return concat([jobHeader(ref, params.length, data.length), params, data])
}

// ---- reading answers ----

/**
 * The header error classes and codes a CPU answers with, in words. 0x8104 is the one a person meets: it is how a
 * 1200/1500 answers every read and write while PUT/GET is off, which is a new CPU's default. That is what snap7's
 * users report from the field; it has not been measured from this client yet (no CPU on the bench, see
 * scripts/s7-loop.mjs), so if a real CPU answers otherwise, this table is what to correct.
 */
const HEADER_ERRORS: Record<number, string> = {
  0x8104: "the CPU does not allow it. On an S7-1200/1500 that means PUT/GET is off: turn on 'Permit access with PUT/GET communication from remote partner' in the CPU's settings and download the hardware configuration (Siemens' documentation shows where)",
  0x8500: 'the request was larger than the PDU the CPU agreed to',
}

/** The return codes of one item. */
const ITEM_ERRORS: Record<number, string> = {
  0x01: 'a hardware fault',
  0x03: "access is not allowed (the CPU's protection level refuses it)",
  0x05: "the address is out of range: the CPU's memory area is smaller than that",
  0x06: 'the CPU does not support that data type',
  0x07: 'the data type is inconsistent',
  0x0a: 'that object does not exist',
}

/**
 * Why the CPU refused one item, in words. A data block gets its own two: a DB address that does not exist is, nearly
 * always, a DB with "Optimized block access" ticked (TIA Portal's default for a new DB), whose variables have no byte
 * offsets for PUT/GET to address. As with 0x8104, which code an optimized DB answers with is what snap7's users report
 * (0x05, address out of range), not yet measured from this client; both codes name the cause, so either reads right.
 */
function itemError(it: S7Item, rc: number): string {
  if (it.area === 'DB' && (rc === 0x05 || rc === 0x0a)) {
    const where = rc === 0x0a ? `the CPU has no DB${it.db} it lets a client reach` : `DB${it.db} has no byte ${it.byte}`
    return `${where}. A data block read or written over PUT/GET must exist and must NOT use optimized block access: turn off 'Optimized block access' for DB${it.db}, compile and download (its variables then sit at the offsets the DB's table shows)`
  }
  return ITEM_ERRORS[rc] ?? `return code ${hex(rc, 2)}`
}

function hex(n: number, digits: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(digits, '0')}`
}

/** Throw unless `res` is the answer to a job with reference `ref` and function `fn`. */
function expectAck(res: Uint8Array, ref: number, fn: number, what: string): void {
  if (res.length < ACK_HEADER || res[0] !== PROTOCOL_ID) throw new S7Error(`the CPU answered ${what} with something that is not an S7 PDU`)
  if (res[1] !== ROSCTR_ACK_DATA) throw new S7Error(`the CPU answered ${what} with a PDU of type ${res[1]}, not an answer`)
  const code = (res[10]! << 8) | res[11]!
  if (code !== 0) throw new S7Error(`the CPU refused ${what} (error ${hex(code, 4)}): ${HEADER_ERRORS[code] ?? 'an error this client does not know'}`, code)
  if (((res[4]! << 8) | res[5]!) !== ref) throw new S7Error(`the CPU answered ${what} with another job's reference`)
  if (res[ACK_HEADER] !== fn) throw new S7Error(`the CPU answered ${what} with function ${hex(res[ACK_HEADER] ?? 0, 2)}`)
}

/** The PDU size the CPU agreed to, from its answer to {@link setupRequest}. */
export function readSetupAnswer(res: Uint8Array, ref: number): number {
  expectAck(res, ref, FN_SETUP, 'the setup of communication')
  if (res.length < ACK_HEADER + 8) throw new S7Error('the CPU answered the setup of communication without a PDU size')
  const pdu = (res[ACK_HEADER + 6]! << 8) | res[ACK_HEADER + 7]!
  return Math.max(MIN_PDU, Math.min(REQUESTED_PDU, pdu))
}

/** The bytes of each item in a read-var answer, in request order. Throws on the first item the CPU refused. */
export function readReadAnswer(res: Uint8Array, ref: number, items: readonly S7Item[], describe: (it: S7Item) => string): Uint8Array[] {
  expectAck(res, ref, FN_READ, `a read of ${items.map(describe).join(', ')}`)
  if (res[ACK_HEADER + 1] !== items.length) throw new S7Error(`the CPU answered a read of ${items.length} item(s) with ${res[ACK_HEADER + 1]}`)
  const out: Uint8Array[] = []
  let at = ACK_HEADER + 2
  items.forEach((it, i) => {
    if (at + ITEM_DATA_HEADER > res.length) throw new S7Error(`the CPU's answer to a read of ${describe(it)} ends early`)
    const rc = res[at]!
    if (rc !== 0xff) throw new S7Error(`the CPU refused a read of ${describe(it)}: ${itemError(it, rc)}`, rc)
    const ts = res[at + 1]!
    const declared = (res[at + 2]! << 8) | res[at + 3]!
    // transport sizes 3 (BIT), 4 (BYTE/WORD/DWORD) and 5 (INTEGER) count bits; the others (octet strings, REAL) bytes
    const length = ts === 3 || ts === 4 || ts === 5 ? Math.ceil(declared / 8) : declared
    if (length !== it.length) throw new S7Error(`the CPU answered a read of ${it.length} byte(s) at ${describe(it)} with ${length}`)
    at += ITEM_DATA_HEADER
    if (at + length > res.length) throw new S7Error(`the CPU's answer to a read of ${describe(it)} ends early`)
    out.push(res.slice(at, at + length))
    at += length + (i < items.length - 1 && length % 2 === 1 ? 1 : 0)
  })
  return out
}

/** Check a write-var answer: every item 0xFF. Throws on the first item the CPU refused. */
export function readWriteAnswer(res: Uint8Array, ref: number, items: readonly S7Item[], describe: (it: S7Item) => string): void {
  expectAck(res, ref, FN_WRITE, `a write of ${items.map(describe).join(', ')}`)
  if (res[ACK_HEADER + 1] !== items.length) throw new S7Error(`the CPU answered a write of ${items.length} item(s) with ${res[ACK_HEADER + 1]}`)
  items.forEach((it, i) => {
    const rc = res[ACK_HEADER + 2 + i]
    if (rc === undefined) throw new S7Error(`the CPU's answer to a write of ${describe(it)} ends early`)
    if (rc !== 0xff) throw new S7Error(`the CPU refused a write of ${describe(it)}: ${itemError(it, rc)}`, rc)
  })
}

// ---- packing items into jobs that fit the PDU ----

/** The bytes a read job, and its answer, take for `items`. */
function readSizes(items: readonly S7Item[]): { request: number; answer: number } {
  const data = items.reduce((n, it, i) => n + ITEM_DATA_HEADER + it.length + (i < items.length - 1 && it.length % 2 === 1 ? 1 : 0), 0)
  return { request: JOB_HEADER + 2 + ITEM_SPEC * items.length, answer: ACK_HEADER + 2 + data }
}

/** The bytes a write job, and its answer, take for `items`. */
function writeSizes(items: readonly S7Item[]): { request: number; answer: number } {
  const data = items.reduce((n, it, i) => n + ITEM_DATA_HEADER + it.length + (i < items.length - 1 && it.length % 2 === 1 ? 1 : 0), 0)
  return { request: JOB_HEADER + 2 + ITEM_SPEC * items.length + data, answer: ACK_HEADER + 2 + items.length }
}

/** Split `items` into jobs, in order, each within {@link MAX_ITEMS} and with request and answer within `pdu`. */
export function packJobs(items: readonly S7Item[], pdu: number, sizes: (items: readonly S7Item[]) => { request: number; answer: number }): S7Item[][] {
  const jobs: S7Item[][] = []
  let job: S7Item[] = []
  for (const it of items) {
    const next = [...job, it]
    const s = sizes(next)
    if (job.length > 0 && (next.length > MAX_ITEMS || s.request > pdu || s.answer > pdu)) {
      jobs.push(job)
      job = [it]
    } else job = next
  }
  if (job.length > 0) jobs.push(job)
  return jobs
}

/** The largest run of bytes one read item can carry at a PDU size: the answer's headers take 18 bytes. */
export function maxReadBytes(pdu: number): number {
  return pdu - ACK_HEADER - 2 - ITEM_DATA_HEADER
}

/** Runs of an area further apart than this are read as two items, rather than one item carrying the gap. */
const MERGE_GAP = 16

/**
 * The byte runs that cover `points`, by area (and by data block), merged across small gaps and split to fit `pdu`:
 * what a poll reads. oip-comms reads one run per area from the lowest byte to the highest; this does the same
 * unless the gap is wide, since I1000 and I0 in one run would read a kilobyte to carry two bits.
 */
export function readRuns(points: readonly S7Point[], pdu: number): S7Item[] {
  const runs: S7Item[] = []
  const max = maxReadBytes(pdu)
  const blocks = [...new Set(points.filter((p) => p.area === 'DB').map((p) => p.db!))].sort((a, b) => a - b)
  const groups: { area: S7Area; db?: number }[] = [{ area: 'I' }, { area: 'Q' }, { area: 'M' }, ...blocks.map((db) => ({ area: 'DB' as const, db }))]
  for (const { area, db } of groups) {
    const spans = points
      .filter((p) => p.area === area && (area !== 'DB' || p.db === db))
      .map((p) => [p.byte, p.byte + s7Bytes(p.size)] as const)
      .sort((a, b) => a[0] - b[0])
    let cur: [number, number] | null = null
    const flush = (): void => {
      if (!cur) return
      for (let b = cur[0]; b < cur[1]; b += max) runs.push({ area, ...(db !== undefined ? { db } : {}), byte: b, length: Math.min(max, cur[1] - b) })
    }
    for (const [from, to] of spans) {
      if (cur && from <= cur[1] + MERGE_GAP) cur[1] = Math.max(cur[1], to)
      else {
        flush()
        cur = [from, to]
      }
    }
    flush()
  }
  return runs
}

// ---- values ----

const scratch = new DataView(new ArrayBuffer(4))

function numberOf(v: TagValue): number {
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** A point's value as the CPU holds it: big-endian. Saturates rather than wraps, as the Modbus side does. */
export function encodeS7Value(p: S7Point, v: TagValue): Uint8Array {
  const n = numberOf(v)
  switch (p.type) {
    case 'BOOL':
      return Uint8Array.of(n !== 0 ? 1 : 0)
    case 'BYTE':
      return Uint8Array.of(Math.min(255, Math.max(0, Math.round(n))))
    case 'INT':
      scratch.setInt16(0, Math.min(32767, Math.max(-32768, Math.round(n))))
      return new Uint8Array(scratch.buffer.slice(0, 2))
    case 'DINT':
      scratch.setInt32(0, Math.min(2147483647, Math.max(-2147483648, Math.round(n))))
      return new Uint8Array(scratch.buffer.slice(0, 4))
    case 'REAL':
      scratch.setFloat32(0, n)
      return new Uint8Array(scratch.buffer.slice(0, 4))
  }
}

/** The value a point's bytes hold. */
export function decodeS7Value(p: S7Point, bytes: Uint8Array, at: number): boolean | number {
  switch (p.type) {
    case 'BOOL':
      return ((bytes[at]! >> (p.bit ?? 0)) & 1) === 1
    case 'BYTE':
      return bytes[at]!
    case 'INT':
      return (((bytes[at]! << 8) | bytes[at + 1]!) << 16) >> 16
    case 'DINT':
      return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) | 0
    case 'REAL':
      for (let i = 0; i < 4; i++) scratch.setUint8(i, bytes[at + i]!)
      return scratch.getFloat32(0)
  }
}

/** "I80.4", "QB80-83", "DB10.DBX0.0", "DB10.DBB4-7": where an item sits, in the S7 spelling. */
export function describeItem(it: S7Item): string {
  const area = it.area === 'DB' ? `DB${it.db}.DB` : it.area
  if (it.bit !== undefined) return it.area === 'DB' ? `${area}X${it.byte}.${it.bit}` : `${area}${it.byte}.${it.bit}`
  return it.length === 1 ? `${area}B${it.byte}` : `${area}B${it.byte}-${it.byte + it.length - 1}`
}

/** The key the read image keeps an area's bytes under: I, Q, M, or DB10. */
const imageKey = (p: { area: S7Area; db?: number }): string => (p.area === 'DB' ? `DB${p.db}` : p.area)

// ---- the poller ----

export interface S7Stats {
  reads: number
  writes: number
  /** jobs the CPU refused, or answered wrongly */
  refused: number
}

/** "12 read and 12 write jobs" for the dock. */
export function describeS7Stats(s: S7Stats): string {
  if (s.reads + s.writes === 0) return 'no requests'
  return `${s.reads} read and ${s.writes} write jobs${s.refused ? `, ${s.refused} refused` : ''}`
}

/**
 * The table applied to a CPU's memory: scene tags in, PLC-written tags out, with the same surface as the Modbus
 * client's ModbusPoller so a loop can drive either. `handshake` opens the S7 session on a fresh connection, and
 * `poll` moves one cycle.
 *
 * `transact` sends one S7 PDU and resolves with the answer that carries the same reference; the host owns the
 * connection and its framing (S7Stream).
 */
export class S7Poller {
  readonly stats: S7Stats = { reads: 0, writes: 0, refused: 0 }
  /** completed poll cycles */
  cycles = 0
  /** the PDU size the CPU agreed to; {@link MIN_PDU} until a handshake says otherwise */
  pdu = MIN_PDU
  readonly #toPlc: S7Point[]
  readonly #fromPlc: S7Point[]
  /** what the parts last reported, by tag */
  readonly #sim = new Map<string, TagValue>()
  /** the bytes the last read brought back, per area (each data block its own), indexed by byte address */
  readonly #image = new Map<string, Map<number, number>>()
  #ref = 0

  constructor(readonly io: S7ClientIo) {
    this.#toPlc = io.points.filter((p) => p.dir === 'toPlc')
    this.#fromPlc = io.points.filter((p) => p.dir === 'fromPlc')
  }

  /** The next job reference, never 0. */
  nextRef(): number {
    this.#ref = (this.#ref % 0xffff) + 1
    return this.#ref
  }

  /** The tags the PLC drives, for the scene to stop driving them itself. */
  drivenTags(): string[] {
    return this.#fromPlc.map((p) => p.tag)
  }

  /** Latch what the scene reports, to go out on the next poll. A tag missing from `tags` keeps its last value. */
  writeSimTags(tags: Readonly<Record<string, TagValue>>): void {
    for (const p of this.#toPlc) {
      const v = tags[p.tag]
      if (v !== undefined) this.#sim.set(p.tag, v)
    }
  }

  /** What the PLC last wrote, as scene tags. Before the first poll every point reads false / 0. */
  plcTags(): Record<string, TagValue> {
    const out: Record<string, TagValue> = {}
    for (const p of this.#fromPlc) {
      const area = this.#image.get(imageKey(p))
      const n = s7Bytes(p.size)
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = area?.get(p.byte + i) ?? 0
      out[p.tag] = decodeS7Value(p, bytes, 0)
    }
    return out
  }

  /** Every tag the PLC drives, at the value it holds when nothing drives it. */
  offTags(): Record<string, TagValue> {
    const out: Record<string, TagValue> = {}
    for (const p of this.#fromPlc) out[p.tag] = p.type === 'BOOL' ? false : 0
    return out
  }

  /** Open the S7 session on a connection the CPU has just confirmed: agree the PDU size. */
  async handshake(transact: (pdu: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    const ref = this.nextRef()
    this.pdu = readSetupAnswer(await transact(setupRequest(ref)), ref)
  }

  /** The write items one cycle sends: every point the parts have reported. */
  writeItems(): S7Item[] {
    const items: S7Item[] = []
    for (const p of this.#toPlc) {
      const v = this.#sim.get(p.tag)
      if (v === undefined) continue
      items.push({ area: p.area, ...(p.db !== undefined ? { db: p.db } : {}), byte: p.byte, ...(p.bit !== undefined ? { bit: p.bit } : {}), length: s7Bytes(p.size), bytes: encodeS7Value(p, v) })
    }
    return items
  }

  /**
   * One cycle: write what the parts report, then read what the PLC drives. Rejects with an S7Error when the CPU
   * refuses a job, and with whatever `transact` rejects with when the connection fails; what this side holds is
   * left as it was, so the next cycle tries again.
   */
  async poll(transact: (pdu: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    const job = async <T>(kind: 'reads' | 'writes', build: (ref: number) => Uint8Array, read: (res: Uint8Array, ref: number) => T): Promise<T> => {
      const ref = this.nextRef()
      this.stats[kind]++
      const res = await transact(build(ref))
      try {
        return read(res, ref)
      } catch (e) {
        this.stats.refused++
        throw e
      }
    }
    for (const items of packJobs(this.writeItems(), this.pdu, writeSizes)) {
      await job('writes', (ref) => writeRequest(ref, items), (res, ref) => readWriteAnswer(res, ref, items, describeItem))
    }
    for (const items of packJobs(readRuns(this.#fromPlc, this.pdu), this.pdu, readSizes)) {
      const got = await job('reads', (ref) => readRequest(ref, items), (res, ref) => readReadAnswer(res, ref, items, describeItem))
      items.forEach((it, i) => {
        let area = this.#image.get(imageKey(it))
        if (!area) this.#image.set(imageKey(it), (area = new Map()))
        got[i]!.forEach((b, k) => area!.set(it.byte + k, b))
      })
    }
    this.cycles++
  }
}
