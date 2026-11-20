// The session the dock runs against a MELSEC CPU, through a desktop socket whose connections reach a strict
// fake CPU (plc/link/slmpFakeCpu.ts): the same shape as the S7 session's tests in s7Link.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { slmpClientFromTags } from '../../core/io/slmpIo'
import { FakeSlmpCpu } from '../../plc/link/slmpFakeCpu'
import { CLIENT_POLL_MS, CLIENT_RETRY_MS, slmpLink, statusLine } from './externalPlc'
import type { PlcIoHost } from './externalPlc'
import { ExternalPlcSlmpSession } from './slmpLink'
import { DEFAULT_EXTERNAL_PLC } from '../store/storePrefs'

/** A desktop socket in memory. `refuse` connects fail; `silent` stops the CPU answering; `hangUp` closes from its side. */
function cpuSocket(cpu: FakeSlmpCpu) {
  const conn = new Set<(e: { id: number; remote: string; open: boolean }) => void>()
  const data = new Set<(e: { id: number; bytes: Uint8Array }) => void>()
  const ctl = { refuse: 0, silent: false, connects: 0, closed: 0, dropped: [] as number[], nextId: 1 }
  let current = 0
  const host: PlcIoHost = {
    listen: async () => ({ error: 'this host only connects' }),
    connect: async (opts) => {
      ctl.connects++
      if (ctl.refuse > 0) {
        ctl.refuse--
        return { error: `nothing is listening on ${opts.host}:${opts.port}`, id: 0 }
      }
      current = ctl.nextId++
      cpu.reset()
      return { error: '', id: current }
    },
    close: async () => {
      ctl.closed++
    },
    onConnection: (cb) => {
      conn.add(cb)
      return () => conn.delete(cb)
    },
    onData: (cb) => {
      data.add(cb)
      return () => data.delete(cb)
    },
    write: (id, bytes) => {
      if (id !== current || ctl.silent) return
      // answered on a later tick, as a socket would
      const replies = cpu.push(bytes)
      queueMicrotask(() => replies.forEach((r) => data.forEach((cb) => cb({ id, bytes: r }))))
    },
    drop: (id) => ctl.dropped.push(id),
  }
  const hangUp = () => {
    const id = current
    current = 0
    conn.forEach((cb) => cb({ id, remote: 'cpu', open: false }))
  }
  return { host, ctl, hangUp }
}

const TABLE = slmpClientFromTags({ host: '127.0.0.1', port: 5511 }, [{ name: 'M10', type: 'BOOL', writers: 1 }, 'Y0', { name: 'D100', type: 'REAL', writers: 1 }, { name: 'D200', type: 'INT' }]).io

/** Y0 and D200 come from the PLC, M10 and D100 travel to it. */
const POINTS = ['Y0  read from the PLC', 'M10  written to the PLC', 'D100  REAL  written to the PLC', 'D200  read from the PLC']

describe('a session with a MELSEC CPU over SLMP', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("connects, writes the scene's inputs and reads the program's outputs", async () => {
    const cpu = new FakeSlmpCpu({ size: 512 })
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcSlmpSession(sock.host, TABLE, [], () => {})
    await session.start({ M10: true, D100: 0.75 })
    expect(cpu.memory.M[10]).toBe(1) // the first cycle carried the sensor as it stood
    expect(cpu.word('D', 100)).toBe(0x0000) // REAL 0.75, low word first
    expect(cpu.word('D', 101)).toBe(0x3f40)
    expect(session.status()).toMatchObject({ mode: 'slmp', state: 'polling', endpoint: '127.0.0.1:5511', masters: ['127.0.0.1:5511'], driven: ['Y0', 'D200'] })
    cpu.memory.Y[0] = 1
    cpu.setWord('D', 200, 300)
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({ M10: false })).toEqual({ Y0: true, D200: 300 })
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(cpu.memory.M[10]).toBe(0)
    expect(session.status().requests).toMatch(/^\d+ read and \d+ write requests$/)
    expect(session.status().points).toEqual(POINTS)
  })

  it('keeps trying a PLC that is not up yet', async () => {
    const sock = cpuSocket(new FakeSlmpCpu({ size: 512 }))
    sock.ctl.refuse = 2
    const session = new ExternalPlcSlmpSession(sock.host, TABLE, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'starting', error: 'nothing is listening on 127.0.0.1:5511' })
    expect(session.exchange({})).toEqual({ Y0: false, D200: 0 })
    expect(session.status().stale).toBe(false) // never answered: off, not a fault
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS * 2 + CLIENT_POLL_MS)
    expect(session.status()).toMatchObject({ state: 'polling', error: null })
  })

  it('says why the CPU refused a request, keeps the connection, and asks once a second', async () => {
    // D200 is past what this CPU reaches: every cycle is refused, the connection stays up
    const cpu = new FakeSlmpCpu({ size: 128 })
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcSlmpSession(sock.host, TABLE, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'starting', error: expect.stringMatching(/refused a read of D200 .*end code 0xC056/) })
    const jobs = cpu.jobs.length
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS - CLIENT_POLL_MS)
    expect(cpu.jobs.length).toBe(jobs) // not fifty refusals a second
    expect(sock.ctl.connects).toBe(1)
  })

  it('drives the outputs off when the PLC goes quiet, and takes them back when it answers again', async () => {
    const cpu = new FakeSlmpCpu({ size: 512 })
    cpu.memory.Y[0] = 1
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcSlmpSession(sock.host, TABLE, [], () => {})
    await session.start({})
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({})).toEqual({ Y0: true, D200: 0 })
    sock.hangUp()
    expect(session.status()).toMatchObject({ state: 'starting', error: 'the PLC closed the connection (127.0.0.1:5511)' })
    expect(session.exchange({})).toEqual({ Y0: false, D200: 0 })
    expect(session.status().stale).toBe(true) // answered once, then went: held off
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS * 2)
    expect(session.exchange({})).toEqual({ Y0: true, D200: 0 })
    expect(session.status()).toMatchObject({ state: 'polling', stale: false })
  })

  it('says what Play will do while the code loads, and what it carries', () => {
    const sock = cpuSocket(new FakeSlmpCpu())
    const link = slmpLink(sock.host, TABLE, [], () => {})
    expect(link.status()).toMatchObject({ mode: 'slmp', state: 'starting', points: POINTS })
    const settings = { ...DEFAULT_EXTERNAL_PLC, mode: 'slmp' as const, slmpHost: '127.0.0.1', slmpPort: 5511 }
    expect(statusLine(link.status(), false, settings)).toBe('Press Play to connect to the MELSEC CPU at 127.0.0.1:5511 over SLMP; the program here is not run while the PLC is.')
    expect(statusLine(link.status(), false, { ...settings, slmpPort: 5000 })).toBe('Press Play to connect to the MELSEC CPU at 127.0.0.1 over SLMP; the program here is not run while the PLC is.')
  })
})
