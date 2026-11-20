// A strict stand-in for a MELSEC CPU's SLMP server, for unit tests only (plc/link/slmpClient.test.ts,
// editor/links/slmpLink.test.ts). Nothing in the app imports it.
//
// Written from the protocol, not from the client: it parses the 3E frame the long way, and it is stricter in
// exactly the places a real CPU is not lenient:
//   - the request must carry the plain route (network 0, PC 0xFF, the module's I/O 0x03FF, station 0);
//   - one request covers one device kind, and its subcommand must match it (0000 words, 0001 bits);
//   - a request carries at most 960 word registers or 1024 bits, and stays inside the device's range;
//   - a write's payload must match its points (2 bytes a word, two points a byte), and a nibble is a point's
//     value 0 or 1 (which pins the packing: the even point in the high nibble).
// So the unit tests pin the byte layout and the limits a real CPU demands, against an implementation nobody
// here measured a vendor's software to write.

import type { SlmpDevice } from '../../core/io/slmpIo'
import { SLMP_DEVICES } from '../../core/io/slmpIo'

const CODE_DEVICE: Record<number, SlmpDevice> = Object.fromEntries(Object.entries(SLMP_DEVICES).map(([name, kind]) => [kind.code, name as SlmpDevice]))
const SUBHEADER_REQUEST = 0x50
const RESPONSE_HEAD = 9

export interface FakeSlmpOptions {
  /** points of every device: bits for bit devices, word registers for word devices */
  size?: number
  maxWords?: number
  maxBits?: number
}

export class FakeSlmpCpu {
  /** one byte per bit point (0 or 1) and two bytes per word register; the packing is the wire's */
  readonly memory: Record<SlmpDevice, Uint8Array>
  readonly maxWords: number
  readonly maxBits: number
  /** every request it received, as its command, device, first number and point count */
  readonly jobs: { command: number; device: SlmpDevice; number: number; points: number }[] = []
  #pending = new Uint8Array(0)

  constructor(opts: FakeSlmpOptions = {}) {
    const size = opts.size ?? 128
    this.memory = Object.fromEntries(Object.entries(SLMP_DEVICES).map(([name, kind]) => [name, new Uint8Array(size * (kind.kind === 'bit' ? 1 : 2))])) as Record<SlmpDevice, Uint8Array>
    this.maxWords = opts.maxWords ?? 960
    this.maxBits = opts.maxBits ?? 1024
  }

  /** A word register's two bytes, LE: D100's, or any word device's. */
  word(device: SlmpDevice, number: number): number {
    return this.memory[device][number * 2]! | (this.memory[device][number * 2 + 1]! << 8)
  }

  /** Set a word register. */
  setWord(device: SlmpDevice, number: number, value: number): void {
    this.memory[device][number * 2] = value & 0xff
    this.memory[device][number * 2 + 1] = (value >> 8) & 0xff
  }

  /** A new TCP connection: only bytes in flight are forgotten. */
  reset(): void {
    this.#pending = new Uint8Array(0)
  }

  /** Bytes from the client; returns the answers to send back. */
  push(chunk: Uint8Array): Uint8Array[] {
    const buf = new Uint8Array(this.#pending.length + chunk.length)
    buf.set(this.#pending)
    buf.set(chunk, this.#pending.length)
    const out: Uint8Array[] = []
    let at = 0
    while (buf.length - at >= RESPONSE_HEAD) {
      if (buf[at] !== SUBHEADER_REQUEST || buf[at + 1] !== 0x00) throw new Error('not a 3E request')
      const length = buf[at + 7]! | (buf[at + 8]! << 8)
      if (length < 8) throw new Error(`a request declared ${length} bytes, too short to carry a command`)
      if (buf.length - at < RESPONSE_HEAD + length) break
      out.push(this.#request(buf.slice(at, at + RESPONSE_HEAD + length)))
      at += RESPONSE_HEAD + length
    }
    this.#pending = buf.slice(at)
    return out
  }

  #request(frame: Uint8Array): Uint8Array {
    if (frame[2] !== 0x00 || frame[3] !== 0xff || frame[4] !== 0xff || frame[5] !== 0x03 || frame[6] !== 0x00) throw new Error('the request is not routed to a plain CPU (network 0, PC FF, I/O 03FF, station 0)')
    const command = frame[11]! | (frame[12]! << 8)
    const subcommand = frame[13]! | (frame[14]! << 8)
    const number = frame[15]! | (frame[16]! << 8) | (frame[17]! << 16)
    const device = CODE_DEVICE[frame[18]!]
    if (!device) throw new Error(`unknown device code ${frame[18]}`)
    const points = frame[19]! | (frame[20]! << 8)
    this.jobs.push({ command, device, number, points })
    const bits = SLMP_DEVICES[device].kind === 'bit'
    if (subcommand !== (bits ? 1 : 0)) return answer(frame, 0xc050)
    if (points === 0 || points > (bits ? this.maxBits : this.maxWords)) return answer(frame, 0xc051)
    const memory = this.memory[device]
    const end = number + points * (bits ? 1 : 2)
    if (end > memory.length / (bits ? 1 : 2)) return answer(frame, 0xc056)
    if (command === 0x0401) {
      const data = bits ? pack(memory.subarray(number, end)) : Uint8Array.from({ length: points * 2 }, (_, i) => memory[number * 2 + i]!)
      return answer(frame, 0, data)
    }
    if (command !== 0x1401) return answer(frame, 0xc050)
    const payload = frame.subarray(21)
    const want = bits ? Math.ceil(points / 2) : points * 2
    if (payload.length !== want) return answer(frame, 0xc059)
    if (bits) {
      for (let p = 0; p * 2 < points; p++) {
        const byte = payload[p]!
        const high = (byte >> 4) & 0x0f
        const low = byte & 0x0f
        if (high > 1 || low > 1) return answer(frame, 0xc059)
        memory[number + p * 2] = high
        if (p * 2 + 1 < points) memory[number + p * 2 + 1] = low
      }
    } else {
      memory.set(Array.from(payload), number * 2)
    }
    return answer(frame, 0)
  }
}

/** Bit points pack two per byte, the even point in the high nibble. */
function pack(values: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(values.length / 2))
  values.forEach((v, i) => {
    if (v) out[i >> 1]! |= (i & 1) === 0 ? 0x10 : 0x01
  })
  return out
}

/** The answer to a request: its route echoed, the length and end code, then data. */
function answer(request: Uint8Array, endCode: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(RESPONSE_HEAD + 2 + data.length)
  out.set([0xd0, 0x00, request[2]!, request[3]!, request[4]!, request[5]!, request[6]!])
  out[7] = (2 + data.length) & 0xff
  out[8] = (2 + data.length) >> 8
  out[9] = endCode & 0xff
  out[10] = endCode >> 8
  out.set(data, RESPONSE_HEAD + 2)
  return out
}
