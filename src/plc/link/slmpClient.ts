// The simulator as an SLMP client of a MELSEC CPU (Q/L/iQ-R/iQ-F), over the 3E binary frame (core/io/slmpIo.ts
// says what travels).
//
// SLMP (MELSEC Communication Protocol, SH-080956) is the protocol a CPU's Ethernet module answers. The frame,
// little-endian throughout, request first:
//
//   50 00 | network:1 | PC:1 | I/O module:2 | station:1 | length:2 | timer:2 | command:2 | subcommand:2 | device | points:2 | [payload]
//
// `length` counts the timer, the command and everything after it. The device spec this sends is the QnA form -
// a 24-bit device number then a one-byte device code - which every family accepts. (The iQ-R also answers the
// extended form: a 32-bit number, a two-byte code, subcommands 0002/0003. That variant is out of scope here.)
//
// The answer echoes the route, then `length:2 | end code:2 | data`. The frame is complete at 9 + length, which
// is what the receive loop waits for. SLMP carries no request id and answers in order, so the stream (SlmpStream)
// matches answers to requests by their order, one request in flight.
//
// Batch read is command 0401 (subcommand 0000 for word registers, 0001 for bit devices), batch write 1401.
// A request covers one device from a number for a point count; 960 word registers or 1024 bits fit one
// request, and a span beyond that goes out as several requests. A bit
// run is packed two points per byte, the even point in the high nibble (0x10 = ON), which is not LSB-first.
//
// Like the Modbus client and S7 this holds no socket: SlmpStream frames the bytes and SlmpPoller builds and
// reads the requests; the host owns the connection (editor/links/slmpLink.ts over the desktop shell's socket).
// So everything that can be wrong about the protocol is testable without a network.

import type { SlmpClientIo, SlmpDevice, SlmpPoint, SlmpType } from '../../core/io/slmpIo'
import { SLMP_DEVICES, slmpAddressName, slmpWords } from '../../core/io/slmpIo'
import type { TagValue } from '../types'

/** Why the CPU refused a request, or answered with something that is not an answer to it. */
export class SlmpError extends Error {
  constructor(
    message: string,
    /** the answer's end code (0xC050 and kin), when the CPU gave one */
    readonly code?: number,
  ) {
    super(message)
    this.name = 'SlmpError'
  }
}

const SUBHEADER_REQUEST = 0x50
const SUBHEADER_RESPONSE = 0xd0
const COMMAND_BATCH_READ = 0x0401
const COMMAND_BATCH_WRITE = 0x1401
const SUBCOMMAND_WORD = 0x0000
const SUBCOMMAND_BIT = 0x0001
/** The route every request carries: network 0, the CPU's own station (PC 0xFF), the module's I/O 0x03FF, station 0. */
const NETWORK = 0x00
const PC = 0xff
const IO_MODULE = 0x03ff
const STATION = 0x00
/** The monitoring timer, in 250 ms units: 0x0010 is 4 s, what this client sends. */
const MONITOR_TIMER = 0x0010

/** The device codes of the QnA form (one byte), and which devices count their numbers in hexadecimal. */
const DEVICES = SLMP_DEVICES

/** What one request covers: one device, from `number` for `points` points (bits, or single-word registers). */
export interface SlmpItem {
  device: SlmpDevice
  number: number
  /** bit points pack two per byte; word registers are LE16 */
  bits: boolean
  points: number
  /** write only: the payload bytes (packed bits, or LE words) */
  bytes?: Uint8Array
}

/** The most word registers one batch request carries; past this a span goes out as several requests. */
export const MAX_WORDS = 960
/** The most bit points one batch request carries. */
export const MAX_BITS = 1024

/** "D100-D109", "M10": where an item sits, in the CPU's own spelling. */
export function describeSlmpItem(it: SlmpItem): string {
  const name = (n: number): string => slmpAddressName({ device: it.device, number: n })
  return it.points === 1 ? name(it.number) : `${name(it.number)}-${name(it.number + it.points - 1)}`
}

// ---- building requests ----

function u16le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff)
}

/** The request's route and length, the monitoring timer and everything after it. */
function requestHead(dataLength: number): Uint8Array {
  return Uint8Array.of(
    SUBHEADER_REQUEST,
    0x00,
    NETWORK,
    PC,
    IO_MODULE & 0xff,
    IO_MODULE >> 8,
    STATION,
    ...u16le(dataLength),
    ...u16le(MONITOR_TIMER),
  )
}

/** The device spec of the QnA form: a 24-bit device number, then its one-byte code. */
function deviceSpec(item: SlmpItem): Uint8Array {
  return Uint8Array.of(item.number & 0xff, (item.number >> 8) & 0xff, (item.number >> 16) & 0xff, DEVICES[item.device].code)
}

/** A batch read (0401) of `item`. */
export function buildBatchRead(item: SlmpItem): Uint8Array {
  const body = Uint8Array.of(...u16le(COMMAND_BATCH_READ), ...u16le(item.bits ? SUBCOMMAND_BIT : SUBCOMMAND_WORD), ...deviceSpec(item), ...u16le(item.points))
  // the length field counts the monitoring timer (2) plus the request data
  return Uint8Array.of(...requestHead(2 + body.length), ...body)
}

/** A batch write (1401) of `item`, whose payload is `item.bytes`. */
export function buildBatchWrite(item: SlmpItem): Uint8Array {
  const payload = item.bytes ?? new Uint8Array(0)
  const body = Uint8Array.of(...u16le(COMMAND_BATCH_WRITE), ...u16le(item.bits ? SUBCOMMAND_BIT : SUBCOMMAND_WORD), ...deviceSpec(item), ...u16le(item.points), ...payload)
  return Uint8Array.of(...requestHead(2 + body.length), ...body)
}

// ---- reading answers ----

/** An answer's 9-byte head, then `length:2 | end code:2 | data`: the frame is complete at 9 + length. */
const RESPONSE_HEAD = 9

/** The size of the answer `buf` begins, once its 9-byte head is there; 0 when it is not a 3E answer. */
export function responseFrameSize(buf: Uint8Array): number {
  if (buf.length < 2) return RESPONSE_HEAD + 2
  if (buf[0] !== SUBHEADER_RESPONSE || buf[1] !== 0x00) return 0
  if (buf.length < RESPONSE_HEAD) return RESPONSE_HEAD + 2
  return RESPONSE_HEAD + ((buf[7]! << 0) | (buf[8]! << 8))
}

/** One answer, whole: its end code (0 = normal) and the data after it. */
export interface SlmpResponse {
  endCode: number
  data: Uint8Array
}

/** Parse one complete answer. Throws when it is not one. */
export function parseResponse(frame: Uint8Array): SlmpResponse {
  if (frame.length < RESPONSE_HEAD || frame[0] !== SUBHEADER_RESPONSE || frame[1] !== 0x00) throw new SlmpError('the CPU answered with something that is not a 3E response')
  const length = frame[7]! | (frame[8]! << 8)
  if (RESPONSE_HEAD + length > frame.length) throw new SlmpError("the CPU's answer ends early")
  if (length < 2) throw new SlmpError("the CPU's answer carries no end code")
  return { endCode: frame[9]! | (frame[10]! << 8), data: frame.slice(RESPONSE_HEAD + 2, RESPONSE_HEAD + length) }
}

/**
 * What the CPU's end codes say, in words. From the SLMP manual's table (SH-080956); which of these a given CPU
 * answers with in the field is not measured here, so the code always travels with the message.
 */
const END_CODES: Record<number, string> = {
  0xc050: 'the CPU does not accept this request: its command or contents are not one this CPU takes',
  0xc051: 'the request reads or writes more points than the CPU allows in one request',
  0xc056: 'the device number is past what this CPU reaches',
  0xc058: "the request's length does not match its contents",
  0xc059: 'the write data is not what the request describes',
  0xc05b: 'the CPU cannot execute it: the device cannot be written here, or the CPU is in a state that refuses it',
}

function hex(n: number, digits: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(digits, '0')}`
}

/** Throw unless the answer says the request went through. */
function expectOk(res: SlmpResponse, what: string): void {
  if (res.endCode !== 0) throw new SlmpError(`the CPU refused ${what} (end code ${hex(res.endCode, 4)}): ${END_CODES[res.endCode] ?? 'an error this client does not know'}`, res.endCode)
}

// ---- bits and values ----

/** Bit points pack two per byte, the even point in the high nibble (0x10 = ON). Not LSB-first. */
export function packBits(values: readonly boolean[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(values.length / 2))
  values.forEach((v, i) => {
    if (!v) return
    out[i >> 1]! |= (i & 1) === 0 ? 0x10 : 0x01
  })
  return out
}

/** The points a packed payload holds, in order. */
export function unpackBits(bytes: Uint8Array, count: number): boolean[] {
  return Array.from({ length: count }, (_, i) => ((bytes[i >> 1] ?? 0) & ((i & 1) === 0 ? 0x10 : 0x01)) !== 0)
}

const scratch = new DataView(new ArrayBuffer(4))

function numberOf(v: TagValue): number {
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** A word point's registers as the CPU holds them: LE16 words, low word first for two-register types. */
export function encodeSlmpWords(type: SlmpType, v: TagValue): number[] {
  const n = numberOf(v)
  switch (type) {
    case 'INT':
      scratch.setInt16(0, Math.min(32767, Math.max(-32768, Math.round(n))), true)
      return [scratch.getUint16(0, true)]
    case 'DINT':
      scratch.setInt32(0, Math.min(2147483647, Math.max(-2147483648, Math.round(n))), true)
      return [scratch.getUint16(0, true), scratch.getUint16(2, true)]
    case 'REAL':
      scratch.setFloat32(0, n, true)
      return [scratch.getUint16(0, true), scratch.getUint16(2, true)]
    case 'BOOL':
      return [n !== 0 ? 0x0001 : 0x0000]
  }
}

/** The value a point's registers hold. */
export function decodeSlmpWords(type: SlmpType, lo: number, hi: number): boolean | number {
  switch (type) {
    case 'INT':
      return (lo << 16) >> 16
    case 'DINT':
      return (lo | (hi << 16)) | 0
    case 'REAL':
      scratch.setUint16(0, lo, true)
      scratch.setUint16(2, hi, true)
      return scratch.getFloat32(0, true)
    case 'BOOL':
      return lo !== 0
  }
}

// ---- packing runs into requests ----

/** Runs of an address further apart than this are read as two requests, rather than one carrying the gap. */
const MERGE_GAP = 16

/** The requests that read `points`, per device, merged across small gaps and split to the frame's limits. */
export function readRuns(points: readonly SlmpPoint[]): SlmpItem[] {
  const runs: SlmpItem[] = []
  for (const device of Object.keys(DEVICES) as SlmpDevice[]) {
    const bits = DEVICES[device].kind === 'bit'
    const max = bits ? MAX_BITS : MAX_WORDS
    const spans = points
      .filter((p) => p.device === device)
      .map((p) => [p.number, p.number + slmpWords(p)] as const)
      .sort((a, b) => a[0] - b[0])
    let cur: [number, number] | null = null
    const flush = (): void => {
      if (!cur) return
      for (let n = cur[0]; n < cur[1]; n += max) runs.push({ device, number: n, bits, points: Math.min(max, cur[1] - n) })
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

/** The requests that write one cycle: each run of consecutive write points, split to the frame's limits. */
export function writeRuns(points: readonly { point: SlmpPoint; value: TagValue }[]): SlmpItem[] {
  const runs: SlmpItem[] = []
  for (const device of Object.keys(DEVICES) as SlmpDevice[]) {
    const bits = DEVICES[device].kind === 'bit'
    const max = bits ? MAX_BITS : MAX_WORDS
    const entries = points
      .filter(({ point }) => point.device === device)
      .sort((a, b) => a.point.number - b.point.number)
    let cur: { number: number; values: (boolean | number)[] } | null = null
    const flush = (): void => {
      if (!cur) return
      for (let at = 0; at < cur.values.length; at += max) {
        const slice = cur.values.slice(at, at + max)
        const bytes = bits
          ? packBits(slice.map((v) => !!v))
          : Uint8Array.from(slice.flatMap((w) => [Number(w) & 0xff, (Number(w) >> 8) & 0xff]))
        runs.push({ device, number: cur.number + at, bits, points: slice.length, bytes })
      }
    }
    for (const { point, value } of entries) {
      const values: (boolean | number)[] = bits ? [numberOf(value) !== 0] : encodeSlmpWords(point.type, value)
      const at = point.number
      if (cur && at === cur.number + cur.values.length) cur.values.push(...values)
      else {
        flush()
        cur = { number: at, values: [...values] }
      }
    }
    flush()
  }
  return runs
}

// ---- the stream ----

/**
 * One connection's byte stream. `frame` passes a request through and remembers the order requests went out;
 * `push` takes received bytes and returns the whole answers in them (TCP delivers bytes, not frames). SLMP
 * carries no request id and answers in order, so an answer takes the oldest request still unanswered: a late
 * answer to a request that already timed out is dropped there instead of reaching the next one.
 */
export class SlmpStream {
  #pending = new Uint8Array(0)
  #outstanding: number[] = []
  /** set once the stream carried something that is not a 3E answer; the host should close the connection */
  error: string | null = null

  frame(request: Uint8Array, key: number): Uint8Array {
    this.#outstanding.push(key)
    return request
  }

  push(chunk: Uint8Array): { key: number; response: Uint8Array }[] {
    if (this.error) return []
    const buf = new Uint8Array(this.#pending.length + chunk.length)
    buf.set(this.#pending)
    buf.set(chunk, this.#pending.length)
    const out: { key: number; response: Uint8Array }[] = []
    let at = 0
    // two bytes are enough to know whether this is a 3E answer
    while (buf.length - at >= 2) {
      const left = buf.subarray(at)
      const size = responseFrameSize(left)
      if (size === 0) {
        this.error = `a frame began with ${hex(left[0] ?? 0, 2)}, not a 3E response's D0`
        break
      }
      if (left.length < size) break
      const key = this.#outstanding.shift()
      if (key !== undefined) out.push({ key, response: left.slice(0, size) })
      at += size
    }
    this.#pending = buf.slice(at)
    return out
  }
}

// ---- the poller ----

export interface SlmpStats {
  reads: number
  writes: number
  /** requests the CPU refused, or answered wrongly */
  refused: number
}

/** "12 read and 12 write requests" for the dock. */
export function describeSlmpStats(s: SlmpStats): string {
  if (s.reads + s.writes === 0) return 'no requests'
  return `${s.reads} read and ${s.writes} write requests${s.refused ? `, ${s.refused} refused` : ''}`
}

/**
 * The table applied to a CPU's devices: scene tags in, PLC-written tags out, with the same surface as the
 * Modbus client's and S7's pollers so a loop can drive any of them. `poll` moves one cycle: write what the
 * parts report, then read what the PLC drives, each as batch requests covering runs of devices.
 *
 * `transact` sends one request and resolves with the answer to it; the host owns the connection and its
 * framing (SlmpStream). SLMP has no session to set up.
 */
export class SlmpPoller {
  readonly stats: SlmpStats = { reads: 0, writes: 0, refused: 0 }
  /** completed poll cycles */
  cycles = 0
  readonly #toPlc: SlmpPoint[]
  readonly #fromPlc: SlmpPoint[]
  /** what the parts last reported, by tag */
  readonly #sim = new Map<string, TagValue>()
  /** what the last reads brought back: word registers by device and number, bit points likewise */
  readonly #words = new Map<SlmpDevice, Map<number, number>>()
  readonly #bits = new Map<SlmpDevice, Map<number, boolean>>()

  constructor(readonly io: SlmpClientIo) {
    this.#toPlc = io.points.filter((p) => p.dir === 'toPlc')
    this.#fromPlc = io.points.filter((p) => p.dir === 'fromPlc')
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
    for (const p of this.#fromPlc) out[p.tag] = this.#decode(p)
    return out
  }

  /** Every tag the PLC drives, at the value it holds when nothing drives it. */
  offTags(): Record<string, TagValue> {
    const out: Record<string, TagValue> = {}
    for (const p of this.#fromPlc) out[p.tag] = p.type === 'BOOL' ? false : 0
    return out
  }

  #decode(p: SlmpPoint): TagValue {
    if (p.type === 'BOOL') return this.#bits.get(p.device)?.get(p.number) ?? false
    const words = this.#words.get(p.device)
    return decodeSlmpWords(p.type, words?.get(p.number) ?? 0, words?.get(p.number + 1) ?? 0)
  }

  /** The write requests one cycle sends: every point the parts have reported, as runs of consecutive devices. */
  writeItems(): SlmpItem[] {
    const values: { point: SlmpPoint; value: TagValue }[] = []
    for (const p of this.#toPlc) {
      const v = this.#sim.get(p.tag)
      if (v !== undefined) values.push({ point: p, value: v })
    }
    return writeRuns(values)
  }

  /**
   * One cycle: write what the parts report, then read what the PLC drives. Rejects with a SlmpError when the
   * CPU refuses a request, and with whatever `transact` rejects with when the connection fails; what this side
   * holds is left as it was, so the next cycle tries again.
   */
  async poll(transact: (pdu: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    const job = async (kind: 'reads' | 'writes', item: SlmpItem): Promise<Uint8Array> => {
      this.stats[kind]++
      const build = kind === 'reads' ? buildBatchRead : buildBatchWrite
      const what = `${kind === 'reads' ? 'a read of' : 'a write of'} ${describeSlmpItem(item)}`
      let res: SlmpResponse
      try {
        res = parseResponse(await transact(build(item)))
      } catch (e) {
        this.stats.refused++
        throw e
      }
      try {
        expectOk(res, what)
      } catch (e) {
        this.stats.refused++
        throw e
      }
      return res.data
    }
    for (const item of this.writeItems()) await job('writes', item)
    for (const item of readRuns(this.#fromPlc)) {
      const data = await job('reads', item)
      if (item.bits) {
        let device = this.#bits.get(item.device)
        if (!device) this.#bits.set(item.device, (device = new Map()))
        unpackBits(data, item.points).forEach((v, i) => device!.set(item.number + i, v))
      } else {
        let device = this.#words.get(item.device)
        if (!device) this.#words.set(item.device, (device = new Map()))
        for (let i = 0; i < item.points; i++) device.set(item.number + i, (data[i * 2] ?? 0) | ((data[i * 2 + 1] ?? 0) << 8))
      }
    }
    this.cycles++
  }
}
