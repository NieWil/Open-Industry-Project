// Live checks against a real MELSEC CPU or any SLMP server this machine can reach. The suite skips them:
// they need a PLC answering SLMP, so `OIP_SLMP_ENDPOINT` has to name one -
//   $env:OIP_SLMP_ENDPOINT='192.168.3.250:5000'; npx vitest run src/plc/link/slmpLive.test.ts
// (in the QnA form only: registers and bits round-trip, low word first, the
// nibble packing, X read-only, spans past one frame, and a device this CPU does not reach).

/// <reference types="node" />

import { createConnection } from 'node:net'
import { describe, expect, it } from 'vitest'
import { slmpClientFromTags } from '../../core/io/slmpIo'
import type { SlmpDevice } from '../../core/io/slmpIo'
import { buildBatchRead, buildBatchWrite, packBits, parseResponse, SlmpPoller, SlmpStream, unpackBits } from './slmpClient'
import type { SlmpItem } from './slmpClient'

// the layer's tsconfig carries no Node globals (src/plc/tsconfig.json `types: []`); the runner provides it
declare const process: { env: Record<string, string | undefined> }

const ENDPOINT = process.env.OIP_SLMP_ENDPOINT
const live = ENDPOINT ? describe : describe.skip
const [LIVE_HOST, LIVE_PORT] = (ENDPOINT ?? '').split(':')

/** A TCP connection to the PLC, answered through the client's own stream (plc/link/slmpClient.ts SlmpStream). */
function openPlc(): Promise<{
  transact: (pdu: Uint8Array) => Promise<Uint8Array>
  read: (item: SlmpItem) => Promise<{ endCode: number; data: Uint8Array }>
  write: (item: SlmpItem) => Promise<{ endCode: number; data: Uint8Array }>
  end: () => void
}> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: LIVE_HOST, port: Number(LIVE_PORT) })
    const stream = new SlmpStream()
    let key = 0
    let waiting: { resolve: (res: Uint8Array) => void; reject: (e: Error) => void } | null = null
    socket.on('error', (e: Error) => {
      waiting?.reject(e)
      waiting = null
      reject(e)
    })
    socket.on('data', (bytes: Uint8Array) => {
      for (const a of stream.push(new Uint8Array(bytes))) {
        waiting?.resolve(a.response)
        waiting = null
      }
      if (stream.error) {
        waiting?.reject(new Error(stream.error))
        waiting = null
      }
    })
    socket.on('connect', () => {
      const transact = (pdu: Uint8Array): Promise<Uint8Array> =>
        new Promise((res, rej) => {
          const timer = setTimeout(() => {
            waiting = null
            rej(new Error('no answer within 5 s'))
          }, 5000)
          waiting = {
            resolve: (r) => {
              clearTimeout(timer)
              res(r)
            },
            reject: (e) => {
              clearTimeout(timer)
              rej(e)
            },
          }
          socket.write(stream.frame(pdu, ++key))
        })
      resolve({
        transact,
        read: async (item) => parseResponse(await transact(buildBatchRead(item))),
        write: async (item) => parseResponse(await transact(buildBatchWrite(item))),
        end: () => socket.end(),
      })
    })
  })
}

/** One run's worth of a PLC connection. */
async function withPlc<T>(fn: (plc: Awaited<ReturnType<typeof openPlc>>) => Promise<T>): Promise<T> {
  const plc = await openPlc()
  try {
    return await fn(plc)
  } finally {
    plc.end()
  }
}

const word = (n: number): SlmpItem => ({ device: 'D', number: n, bits: false, points: 1 })
const reg = (device: SlmpDevice, n: number): SlmpItem => ({ device, number: n, bits: false, points: 1 })
const bits = (device: SlmpDevice, n: number, points: number): SlmpItem => ({ device, number: n, bits: true, points })

live('SLMP against a live PLC', () => {
  it('writes and reads D registers as pymcprotocol does, low word first', async () => {
    await withPlc(async (plc) => {
      // what the pymcprotocol smoke writes: D10-D14 = 0, 10, 20, 30, 40
      const write = await plc.write({ ...word(10), points: 5, bytes: Uint8Array.from([0, 0, 10, 0, 20, 0, 30, 0, 40, 0]) })
      expect(write.endCode).toBe(0)
      const read = await plc.read({ ...word(10), points: 5 })
      expect(read.endCode).toBe(0)
      expect(Array.from(read.data)).toEqual([0, 0, 10, 0, 20, 0, 30, 0, 40, 0])

      // a DINT and a REAL, two registers each, low word first
      expect((await plc.write({ ...word(100), points: 2, bytes: Uint8Array.of(0x02, 0x00, 0x01, 0x00) })).endCode).toBe(0) // 65538 = 0x0001_0002
      expect(Array.from((await plc.read({ ...word(100), points: 2 })).data)).toEqual([0x02, 0x00, 0x01, 0x00])
      expect((await plc.write({ ...word(110), points: 2, bytes: Uint8Array.of(0x00, 0x00, 0x40, 0x3f) })).endCode).toBe(0) // 0.75
      expect(Array.from((await plc.read({ ...word(110), points: 2 })).data)).toEqual([0x00, 0x00, 0x40, 0x3f])
    })
  }, 30000)

  it('writes and reads bits, packed two per byte, the even one in the high nibble', async () => {
    await withPlc(async (plc) => {
      expect((await plc.write({ ...bits('M', 10, 4), bytes: packBits([true, false, true, true]) })).endCode).toBe(0)
      const read = await plc.read(bits('M', 10, 4))
      expect(read.endCode).toBe(0)
      expect(Array.from(read.data)).toEqual([0x10, 0x11]) // the packing is what a real CPU expects
      expect(unpackBits(read.data, 4)).toEqual([true, false, true, true])

      expect((await plc.write({ ...bits('Y', 0, 2), bytes: packBits([true, false]) })).endCode).toBe(0)
      expect(unpackBits((await plc.read(bits('Y', 0, 2))).data, 2)).toEqual([true, false])
    })
  }, 30000)

  it('reads X, and answers a write to it (a real CPU\'s input refresh may not)', async () => {
    await withPlc(async (plc) => {
      const read = await plc.read(bits('X', 0, 4))
      expect(read.endCode).toBe(0)
      expect(read.data.length).toBe(2)
      // a CPU's input refresh overwrites X writes every scan, or refuses them outright (0xC05B), so both
      // answers are fine here; what must hold is that the request is answered
      const write = await plc.write({ ...bits('X', 0, 1), bytes: packBits([true]) })
      expect([0, 0xc05b]).toContain(write.endCode)
    })
  }, 30000)

  it('carries spans past one frame as several requests', async () => {
    await withPlc(async (plc) => {
      // 2001 words: 3 frames of 960, 960 and 81
      const written = slmpClientFromTags({ host: LIVE_HOST! }, Array.from({ length: 2001 }, (_, i) => ({ name: `D${i}`, type: 'INT' as const, writers: 1 })))
      expect(written.problems).toEqual([])
      const writer = new SlmpPoller(written.io)
      writer.writeSimTags(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`D${i}`, (i * 7) % 32000])))
      await writer.poll(plc.transact)
      expect(writer.stats).toMatchObject({ writes: 3, refused: 0 })

      const read = slmpClientFromTags({ host: LIVE_HOST! }, Array.from({ length: 2001 }, (_, i) => ({ name: `D${i}`, type: 'INT' as const })))
      const reader = new SlmpPoller(read.io)
      await reader.poll(plc.transact)
      expect(reader.stats).toMatchObject({ reads: 3, refused: 0 })
      expect(reader.plcTags()).toMatchObject({ D0: 0, D960: (960 * 7) % 32000, D2000: (2000 * 7) % 32000 })

      // 2001 bits: 2 frames of 1024 and 977
      const bitTags = slmpClientFromTags({ host: LIVE_HOST! }, Array.from({ length: 2001 }, (_, i) => ({ name: `M${i}`, type: 'BOOL' as const, writers: 1 })))
      const bitWriter = new SlmpPoller(bitTags.io)
      bitWriter.writeSimTags(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`M${i}`, i % 3 === 0])))
      await bitWriter.poll(plc.transact)
      expect(bitWriter.stats).toMatchObject({ writes: 2, refused: 0 })
      const bitReader = new SlmpPoller(slmpClientFromTags({ host: LIVE_HOST! }, Array.from({ length: 2001 }, (_, i) => ({ name: `M${i}`, type: 'BOOL' as const }))).io)
      await bitReader.poll(plc.transact)
      expect(bitReader.stats).toMatchObject({ reads: 2, refused: 0 })
      expect(bitReader.plcTags()).toMatchObject({ M0: true, M1: false, M3: true, M2000: false })
    })
  }, 60000)

  it('refuses a device this CPU does not reach', async () => {
    await withPlc(async (plc) => {
      const read = await plc.read({ ...word(40000), points: 1 })
      expect(read.endCode).not.toBe(0)
    })
  }, 30000)

  it('round-trips the device families this CPU carries', async () => {
    await withPlc(async (plc) => {
      // bit devices, hex and decimal
      expect((await plc.write({ ...bits('B', 0x20, 4), bytes: packBits([true, false, true, true]) })).endCode).toBe(0)
      expect(unpackBits((await plc.read(bits('B', 0x20, 4))).data, 4)).toEqual([true, false, true, true])
      for (const device of ['L', 'F', 'V', 'TS', 'TC', 'CS', 'CC', 'SB', 'DX', 'DY'] as const) {
        const at = device === 'SB' || device === 'DX' || device === 'DY' ? 0x20 : 200
        expect((await plc.write({ ...bits(device, at, 2), bytes: packBits([true, false]) })).endCode).toBe(0)
        expect(unpackBits((await plc.read(bits(device, at, 2))).data, 2), device).toEqual([true, false])
      }
      // registers, two points each, low word first
      for (const device of ['W', 'SD', 'TN', 'CN', 'SW', 'Z'] as const) {
        const at = device === 'W' || device === 'SW' ? 0x20 : device === 'Z' ? 0 : 200
        expect((await plc.write({ device, number: at, bits: false, points: 2, bytes: Uint8Array.of(0x34, 0x12, 0x78, 0x56) })).endCode).toBe(0)
        expect(Array.from((await plc.read({ ...reg(device, at), points: 2 })).data), device).toEqual([0x34, 0x12, 0x78, 0x56])
      }
    })
  }, 60000)

  it('takes a device the CPU does not carry without hanging the connection', async () => {
    await withPlc(async (plc) => {
      // which devices a CPU answers for depends on its parameters (file registers need their setting): a
      // request for one it does not carry comes back answered - a value or an end code - and the connection
      // stays usable
      for (const [device, n] of [['S', 0], ['STS', 0], ['STC', 0], ['STN', 0], ['R', 0], ['ZR', 0]] as const) {
        await plc.write({ ...reg(device, n), points: 1, bytes: Uint8Array.of(1, 0) })
      }
      expect((await plc.write({ ...word(10), points: 1, bytes: Uint8Array.of(0x34, 0x12) })).endCode).toBe(0)
    })
  }, 30000)

  it('reads the CPU\'s own areas without writing them: SM and the index register', async () => {
    await withPlc(async (plc) => {
      expect((await plc.read(bits('SM', 0, 4))).endCode).toBe(0)
      expect((await plc.read(reg('Z', 0))).endCode).toBe(0)
    })
  }, 30000)

  it('round-trips through one connection, cycle after cycle', async () => {
    await withPlc(async (plc) => {
      const io = slmpClientFromTags({ host: LIVE_HOST! }, [{ name: 'M10', type: 'BOOL', writers: 1 }, { name: 'D120', type: 'INT', writers: 1 }]).io
      const poller = new SlmpPoller(io)
      poller.writeSimTags({ M10: true, D120: 1234 })
      await poller.poll(plc.transact)
      expect(poller.stats).toMatchObject({ writes: 2, refused: 0 })
      expect(Array.from((await plc.read(word(120))).data)).toEqual([0xd2, 0x04]) // 1234, LE
      // the connection is still the same one: another cycle goes through
      await poller.poll(plc.transact)
      expect(poller.stats).toMatchObject({ writes: 4, refused: 0 })
    })
  }, 30000)
})
