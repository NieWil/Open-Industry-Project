// A strict stand-in for an S7-1200/1500's PUT/GET server, for unit tests only (plc/link/s7Client.test.ts,
// editor/links/s7Link.test.ts). Nothing in the app imports it.
//
// Written from the protocol, not from the client: it parses TPKT, COTP and S7 the long way, and it is stricter
// than the snap7 server scripts/s7-loop.mjs runs against, in exactly the places snap7 is lenient and a real CPU
// is not:
//   - the COTP connect must name its rack and slot, or it is refused with a disconnect request;
//   - every job and every answer must fit the PDU it agreed (a 1200's 240 by default), and carry at most 20 items;
//   - a bit write changes that bit only;
//   - with PUT/GET off, every read and write is refused with header error 0x8104;
//   - a data block that does not exist answers 0x0A, and one with optimized block access 0x05 (the codes snap7's users
//     report from real CPUs: plc/link/s7Client.ts itemError).
// (Which codes a real CPU answers the last two with is believed, not measured here: see src/plc/DEVICE-IO.md.)
// So the unit tests pin the behaviour a real CPU demands, and the loop proves the bytes against an implementation
// nobody here wrote.

type Area = 'I' | 'Q' | 'M'
const AREAS: Record<number, Area> = { 0x81: 'I', 0x82: 'Q', 0x83: 'M' }

export interface FakeCpuOptions {
  rack?: number
  slot?: number
  /** the largest PDU it agrees to */
  pdu?: number
  /** each area's size in bytes */
  size?: number
  putGet?: boolean
  maxItems?: number
  /** data blocks by number: their size in bytes, and whether they use optimized block access */
  dbs?: Record<number, { size: number; optimized?: boolean }>
}

export class FakeS7Cpu {
  readonly memory: Record<Area, Uint8Array>
  /** each data block's bytes, and whether it is optimized (no offsets PUT/GET can reach) */
  readonly dbs = new Map<number, { bytes: Uint8Array; optimized: boolean }>()
  readonly rack: number
  readonly slot: number
  readonly maxPdu: number
  readonly maxItems: number
  putGet: boolean
  /** the PDU agreed with the current connection, 0 before setup */
  agreed = 0
  /** every job it received, as [function, item count, job bytes] */
  readonly jobs: { fn: number; items: number; bytes: number }[] = []
  #pending = new Uint8Array(0)

  constructor(opts: FakeCpuOptions = {}) {
    const size = opts.size ?? 128
    this.memory = { I: new Uint8Array(size), Q: new Uint8Array(size), M: new Uint8Array(size) }
    for (const [n, db] of Object.entries(opts.dbs ?? {})) this.dbs.set(Number(n), { bytes: new Uint8Array(db.size), optimized: db.optimized === true })
    this.rack = opts.rack ?? 0
    this.slot = opts.slot ?? 1
    this.maxPdu = opts.pdu ?? 240
    this.maxItems = opts.maxItems ?? 20
    this.putGet = opts.putGet ?? true
  }

  /** A new TCP connection: nothing agreed yet. */
  reset(): void {
    this.agreed = 0
    this.#pending = new Uint8Array(0)
  }

  /** Bytes from the client; returns the frames to send back. */
  push(chunk: Uint8Array): Uint8Array[] {
    const buf = new Uint8Array(this.#pending.length + chunk.length)
    buf.set(this.#pending)
    buf.set(chunk, this.#pending.length)
    const out: Uint8Array[] = []
    let at = 0
    while (buf.length - at >= 4) {
      if (buf[at] !== 3) throw new Error('not TPKT')
      const len = (buf[at + 2]! << 8) | buf[at + 3]!
      if (buf.length - at < len) break
      const cotp = buf.slice(at + 4, at + len)
      at += len
      const kind = cotp[1]!
      if (kind === 0xe0) out.push(this.#connect(cotp))
      else if (kind === 0xf0) {
        const reply = this.#job(cotp.slice(1 + cotp[0]!))
        if (reply) out.push(frame(Uint8Array.of(2, 0xf0, 0x80), reply))
      } else throw new Error(`unexpected COTP unit ${kind}`)
    }
    this.#pending = buf.slice(at)
    return out
  }

  #connect(cotp: Uint8Array): Uint8Array {
    // parameters from byte 7: code, length, value
    let called = -1
    for (let i = 7; i < cotp.length; ) {
      const code = cotp[i]!
      const n = cotp[i + 1]!
      if (code === 0xc2) called = (cotp[i + 2]! << 8) | cotp[i + 3]!
      i += 2 + n
    }
    const wanted = (this.rack << 5) | this.slot
    if (called < 0 || (called & 0xff) !== wanted) return frame(Uint8Array.of(6, 0x80, 0, 1, 0, 0, 0))
    return frame(Uint8Array.of(17, 0xd0, 0, 1, 0, 0, 0, 0xc0, 1, 0x0a, 0xc1, 2, 1, 0, 0xc2, 2, cotp[cotp.length - 2]!, cotp[cotp.length - 1]!))
  }

  #job(pdu: Uint8Array): Uint8Array | null {
    if (pdu[0] !== 0x32 || pdu[1] !== 1) throw new Error('not an S7 job')
    const ref = (pdu[4]! << 8) | pdu[5]!
    const pLen = (pdu[6]! << 8) | pdu[7]!
    const dLen = (pdu[8]! << 8) | pdu[9]!
    if (10 + pLen + dLen !== pdu.length) throw new Error('S7 lengths do not add up')
    const params = pdu.subarray(10, 10 + pLen)
    const data = pdu.subarray(10 + pLen)
    const fn = params[0]!
    this.jobs.push({ fn, items: params[1] ?? 0, bytes: pdu.length })
    if (fn === 0xf0) {
      const asked = (params[6]! << 8) | params[7]!
      this.agreed = Math.min(asked, this.maxPdu)
      return ack(ref, Uint8Array.of(0xf0, 0, 0, 1, 0, 1, this.agreed >> 8, this.agreed & 0xff), new Uint8Array(0))
    }
    if (this.agreed === 0) return ack(ref, Uint8Array.of(fn, 0), new Uint8Array(0), 0x8104)
    if (pdu.length > this.agreed) return ack(ref, Uint8Array.of(fn, 0), new Uint8Array(0), 0x8500)
    const n = params[1]!
    if (n > this.maxItems) return ack(ref, Uint8Array.of(fn, 0), new Uint8Array(0), 0x8500)
    if (!this.putGet) return ack(ref, Uint8Array.of(fn, 0), new Uint8Array(0), 0x8104)
    const specs = Array.from({ length: n }, (_, i) => {
      const s = params.subarray(2 + i * 12, 14 + i * 12)
      if (s[0] !== 0x12 || s[1] !== 0x0a || s[2] !== 0x10) throw new Error('not an S7-ANY address')
      const bits = (s[9]! << 16) | (s[10]! << 8) | s[11]!
      return { unit: s[3]!, count: (s[4]! << 8) | s[5]!, db: (s[6]! << 8) | s[7]!, code: s[8]!, area: AREAS[s[8]!], byte: bits >> 3, bit: bits & 7 }
    })
    /** an item's memory, or the return code that says why there is none */
    const memoryOf = (s: (typeof specs)[number]): Uint8Array | number => {
      if (s.code === 0x84) {
        const db = this.dbs.get(s.db)
        if (!db) return 0x0a
        return db.optimized ? 0x05 : db.bytes
      }
      return s.area ? this.memory[s.area] : 0x0a
    }
    if (fn === 0x04) {
      const items: number[] = []
      specs.forEach((s, i) => {
        const mem = memoryOf(s)
        if (typeof mem === 'number') return items.push(mem, 0, 0, 0)
        if (s.unit !== 0x02 || s.bit !== 0) return items.push(0x0a, 0, 0, 0)
        if (s.byte + s.count > mem.length) return items.push(0x05, 0, 0, 0)
        items.push(0xff, 0x04, (s.count * 8) >> 8, (s.count * 8) & 0xff, ...mem.subarray(s.byte, s.byte + s.count))
        if (i < specs.length - 1 && s.count % 2 === 1) items.push(0)
      })
      const answer = ack(ref, Uint8Array.of(0x04, n), Uint8Array.from(items))
      return answer.length > this.agreed ? ack(ref, Uint8Array.of(fn, 0), new Uint8Array(0), 0x8500) : answer
    }
    if (fn === 0x05) {
      const codes: number[] = []
      let at = 0
      specs.forEach((s, i) => {
        const ts = data[at + 1]!
        const bitLen = (data[at + 2]! << 8) | data[at + 3]!
        const bytes = ts === 0x03 ? 1 : bitLen / 8
        const value = data.subarray(at + 4, at + 4 + bytes)
        at += 4 + bytes + (i < specs.length - 1 && bytes % 2 === 1 ? 1 : 0)
        const mem = memoryOf(s)
        if (typeof mem === 'number') return codes.push(mem)
        if (s.unit === 0x01) {
          if (ts !== 0x03 || bitLen !== 1 || s.count !== 1) return codes.push(0x07)
          if (s.byte >= mem.length) return codes.push(0x05)
          mem[s.byte] = value[0]! & 1 ? mem[s.byte]! | (1 << s.bit) : mem[s.byte]! & ~(1 << s.bit)
          return codes.push(0xff)
        }
        if (ts !== 0x04 || bytes !== s.count || s.bit !== 0) return codes.push(0x07)
        if (s.byte + s.count > mem.length) return codes.push(0x05)
        mem.set(value, s.byte)
        codes.push(0xff)
      })
      if (at !== data.length) throw new Error('write data does not match its items')
      return ack(ref, Uint8Array.of(0x05, n), Uint8Array.from(codes))
    }
    return ack(ref, Uint8Array.of(fn, 0), new Uint8Array(0), 0x8104)
  }
}

function frame(cotp: Uint8Array, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const len = 4 + cotp.length + payload.length
  const out = new Uint8Array(len)
  out.set([3, 0, len >> 8, len & 0xff])
  out.set(cotp, 4)
  out.set(payload, 4 + cotp.length)
  return out
}

function ack(ref: number, params: Uint8Array, data: Uint8Array, error = 0): Uint8Array {
  const head = Uint8Array.of(0x32, 3, 0, 0, ref >> 8, ref & 0xff, params.length >> 8, params.length & 0xff, data.length >> 8, data.length & 0xff, error >> 8, error & 0xff)
  const out = new Uint8Array(head.length + params.length + data.length)
  out.set(head)
  out.set(params, head.length)
  out.set(data, head.length + params.length)
  return out
}
