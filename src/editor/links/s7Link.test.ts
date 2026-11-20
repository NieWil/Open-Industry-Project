import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { s7ClientFromTags } from '../../core/io/s7Io'
import { FakeS7Cpu } from '../../plc/link/s7FakeCpu'
import { CLIENT_ANSWER_MS, CLIENT_POLL_MS, CLIENT_RETRY_MS, POLL_TIMEOUT_MS, s7Link, statusLine } from './externalPlc'
import type { PlcIoHost } from './externalPlc'
import { ExternalPlcS7Session } from './s7Link'
import { DEFAULT_EXTERNAL_PLC } from '../store/storePrefs'

// The session the dock runs against a CPU, through a desktop socket whose connections reach a strict fake CPU
// (plc/link/s7FakeCpu.ts): the same shape as the Modbus client's tests in externalPlc.test.ts.

/** A desktop socket in memory. `refuse` connects fail; `silent` stops the CPU answering; `hangUp` closes from its side. */
function cpuSocket(cpu: FakeS7Cpu) {
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
  return { host, ctl, hangUp, listeners: () => conn.size + data.size }
}

const TABLE = s7ClientFromTags({ host: '127.0.0.1' }, ['%IX80.4', '%QX80.0', { name: '%QD84', type: 'REAL' }]).io

describe('a session with an S7 CPU', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("connects, agrees the PDU, writes the scene's inputs and reads the program's outputs", async () => {
    const cpu = new FakeS7Cpu()
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcS7Session(sock.host, TABLE, [], () => {})
    await session.start({ '%IX80.4': true })
    expect(cpu.memory.I[80]).toBe(0b0001_0000) // the first cycle carried the sensor as it stood
    expect(session.poller.pdu).toBe(240)
    expect(session.status()).toMatchObject({ mode: 's7', state: 'polling', endpoint: '127.0.0.1 (rack 0, slot 1)', masters: ['127.0.0.1 (rack 0, slot 1)'], driven: ['%QX80.0', '%QD84'] })
    cpu.memory.Q[80] = 1
    cpu.memory.Q.set([0x3f, 0, 0, 0], 84)
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({ '%IX80.4': false })).toEqual({ '%QX80.0': true, '%QD84': 0.5 })
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(cpu.memory.I[80]).toBe(0)
    expect(session.status().requests).toMatch(/^\d+ read and \d+ write jobs$/)
    expect(session.status().points).toEqual(['%IX80.4  I80.4  written to the PLC', '%QX80.0  Q80.0  read from the PLC', '%QD84  QD84  REAL  read from the PLC'])
  })

  it('says to check the rack and slot when the CPU is not there, and keeps trying', async () => {
    const cpu = new FakeS7Cpu({ slot: 2 })
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcS7Session(sock.host, TABLE, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'starting', error: expect.stringMatching(/refused the connection to rack 0, slot 1: check them/) })
    expect(sock.ctl.dropped).toEqual([1])
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(sock.ctl.connects).toBe(2)
  })

  it('says what to do when PUT/GET is off, keeps the connection, and asks once a second', async () => {
    const cpu = new FakeS7Cpu({ putGet: false })
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcS7Session(sock.host, TABLE, [], () => {})
    await session.start({ '%IX80.4': true })
    // connected, but refused: the dock says it is still waiting for the CPU, and why
    expect(session.status()).toMatchObject({ state: 'starting', error: expect.stringMatching(/PUT\/GET is off/) })
    expect(statusLine(session.status(), true, { ...DEFAULT_EXTERNAL_PLC, mode: 's7' })).toMatch(
      /^Waiting for the PLC at 127\.0\.0\.1 \(rack 0, slot 1\): the CPU refused a write of I80\.4 \(error 0x8104\): the CPU does not allow it\. On an S7-1200\/1500 that means PUT\/GET is off: .*\. Trying again every second\.$/,
    )
    const jobs = cpu.jobs.length
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS - CLIENT_POLL_MS)
    expect(cpu.jobs.length).toBe(jobs) // not fifty refusals a second
    cpu.putGet = true // someone ticked the box and downloaded
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS * 2)
    expect(sock.ctl.connects).toBe(1)
    expect(session.status()).toMatchObject({ state: 'polling', error: null })
    expect(cpu.memory.I[80]).toBe(0b0001_0000)
  })

  it('keeps trying a CPU that is not up yet', async () => {
    const sock = cpuSocket(new FakeS7Cpu())
    sock.ctl.refuse = 2
    const session = new ExternalPlcS7Session(sock.host, TABLE, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'starting', error: 'nothing is listening on 127.0.0.1:102' })
    expect(session.exchange({})).toEqual({ '%QX80.0': false, '%QD84': 0 })
    expect(session.status().stale).toBe(false) // never answered: off, not a fault
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS * 2 + CLIENT_POLL_MS)
    expect(session.status()).toMatchObject({ state: 'polling', error: null })
  })

  it('drives the outputs off when the CPU goes quiet, and takes them back when it answers again', async () => {
    const cpu = new FakeS7Cpu()
    cpu.memory.Q[80] = 1
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcS7Session(sock.host, TABLE, [], () => {})
    await session.start({})
    expect(session.exchange({})).toMatchObject({ '%QX80.0': true })
    sock.ctl.silent = true
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + CLIENT_ANSWER_MS)
    expect(session.exchange({})).toEqual({ '%QX80.0': false, '%QD84': 0 })
    expect(session.status()).toMatchObject({ stale: true, error: expect.stringMatching(/no answer from the CPU within 500 ms/) })
    sock.ctl.silent = false
    await vi.advanceTimersByTimeAsync(CLIENT_ANSWER_MS + CLIENT_POLL_MS * 2)
    expect(session.exchange({})).toMatchObject({ '%QX80.0': true })
    expect(session.status().stale).toBe(false)
  })

  it('reconnects, and sets up again, when the CPU closes the connection', async () => {
    const cpu = new FakeS7Cpu()
    cpu.memory.Q[80] = 1
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcS7Session(sock.host, TABLE, [], () => {})
    await session.start({})
    sock.hangUp()
    expect(session.exchange({})).toEqual({ '%QX80.0': false, '%QD84': 0 })
    expect(session.status()).toMatchObject({ stale: true, state: 'starting', masters: [], error: 'the CPU closed the connection (127.0.0.1 (rack 0, slot 1))' })
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(sock.ctl.connects).toBe(2)
    expect(cpu.agreed).toBe(240) // the new connection was set up again before its first job
    expect(session.exchange({})).toMatchObject({ '%QX80.0': true })
  })

  it('stops polling and lets go of the host', async () => {
    const cpu = new FakeS7Cpu()
    const sock = cpuSocket(cpu)
    const session = new ExternalPlcS7Session(sock.host, TABLE, [], () => {})
    await session.start({})
    await session.stop()
    await session.stop()
    const jobs = cpu.jobs.length
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS * 10)
    expect(cpu.jobs.length).toBe(jobs)
    expect(sock.ctl.closed).toBe(1)
    expect(sock.listeners()).toBe(0)
    expect(session.status()).toMatchObject({ state: 'off', masters: [] })
  })

  it('loads on Play: the link knows what the PLC drives before its code has loaded', async () => {
    const cpu = new FakeS7Cpu()
    cpu.memory.Q[80] = 1
    const sock = cpuSocket(cpu)
    const link = s7Link(sock.host, TABLE, [], () => {})
    expect(link.driven).toEqual(['%QX80.0', '%QD84'])
    expect(link.status()).toMatchObject({ mode: 's7', state: 'starting', points: ['%IX80.4  I80.4  written to the PLC', '%QX80.0  Q80.0  read from the PLC', '%QD84  QD84  REAL  read from the PLC'] })
    expect(link.exchange({ '%IX80.4': true })).toBeNull() // nothing to hand over yet
    await link.start({})
    expect(cpu.memory.I[80]).toBe(0b0001_0000) // the tags kept while loading went out first
    expect(link.exchange({})).toMatchObject({ '%QX80.0': true })
    await link.stop()
    expect(link.status().state).toBe('off')
  })

  it('reads as a sentence in the dock', () => {
    const settings = { ...DEFAULT_EXTERNAL_PLC, mode: 's7' as const }
    expect(statusLine({ ...s7Link(cpuSocket(new FakeS7Cpu()).host, TABLE, [], () => {}).status() }, false, settings)).toBe(
      'Press Play to connect to the S7 CPU at 192.168.0.1 (rack 0, slot 1) over S7 PUT/GET; the program here is not run while the PLC is.',
    )
  })
})
