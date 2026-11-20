import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modbusClientFromTags } from '../../core/io/externalIo'
import type { PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import { ModbusImage, ModbusStream } from '../../plc/link/modbusServer'
import {
  CLIENT_ANSWER_MS,
  CLIENT_POLL_MS,
  CLIENT_RETRY_MS,
  deriveClientIo,
  deriveExternalIo,
  describePoint,
  EXTERNAL_PLC_OFF,
  ExternalPlcClientSession,
  ExternalPlcEipSession,
  ExternalPlcOpcUaSession,
  ExternalPlcSession,
  flattenFrameTags,
  plannedLink,
  watchedPoints,
  watchRefusal,
  deriveS7Io,
  plcTagListOf,
  POLL_TIMEOUT_MS,
  readOpcUaTagList,
  statusHint,
  statusLine,
} from './externalPlc'
import type { EipHost, ExternalPlcStatus, OpcUaHost, PlcIoHost } from './externalPlc'
import type { EipPoint } from '../../core/io/eip'
import type { OpcUaPoint } from '../../core/io/opcUa'
import { DEFAULT_EXTERNAL_PLC, sanitizeExternalPlc } from '../store/storePrefs'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

/** The desktop socket, in memory: a test plays the PLC's Modbus master by calling `connect` and `send`. */
function fakeHost(listenError = '') {
  const conn = new Set<(e: { id: number; remote: string; open: boolean }) => void>()
  const data = new Set<(e: { id: number; bytes: Uint8Array }) => void>()
  const log = { listened: [] as { host: string; port: number }[], written: [] as { id: number; bytes: number[] }[], dropped: [] as number[], closed: 0 }
  const host: PlcIoHost = {
    listen: async (opts) => {
      log.listened.push(opts)
      return { error: listenError }
    },
    connect: async () => ({ error: 'this host only listens', id: 0 }),
    close: async () => {
      log.closed++
    },
    onConnection: (cb) => {
      conn.add(cb)
      return () => conn.delete(cb)
    },
    onData: (cb) => {
      data.add(cb)
      return () => data.delete(cb)
    },
    write: (id, bytes) => log.written.push({ id, bytes: [...bytes] }),
    drop: (id) => log.dropped.push(id),
  }
  const connect = (id: number, open = true) => conn.forEach((cb) => cb({ id, remote: `10.0.0.${id}:5000${id}`, open }))
  const send = (id: number, bytes: number[]) => data.forEach((cb) => cb({ id, bytes: Uint8Array.from(bytes) }))
  return { host, log, connect, send, listeners: () => conn.size + data.size }
}

/** a Modbus TCP request frame */
const frame = (tid: number, body: number[]) => [tid >> 8, tid & 0xff, 0, 0, 0, body.length + 1, 1, ...body]

const IO = {
  protocol: 'modbus-tcp-server' as const,
  host: '127.0.0.1',
  port: 5020,
  points: [
    { tag: '%IX100.0', area: 'discreteInput' as const, address: 800 },
    { tag: '%QX100.0', area: 'coil' as const, address: 800 },
  ],
}

describe('an external PLC session', () => {
  it('listens where the table says, and answers a master from the scene\'s tags', async () => {
    const h = fakeHost()
    const session = new ExternalPlcSession(h.host, IO, [], () => {})
    await session.start({ '%IX100.0': true })
    expect(h.log.listened).toEqual([{ host: '127.0.0.1', port: 5020 }])
    expect(session.status()).toMatchObject({ state: 'listening', endpoint: '127.0.0.1:5020', driven: ['%QX100.0'] })
    h.connect(1)
    expect(session.status().masters).toEqual(['10.0.0.1:50001'])
    // FC2: read 1 discrete input at 800 -> the sensor, which was on before the first frame
    h.send(1, frame(7, [0x02, 0x03, 0x20, 0x00, 0x01]))
    expect(h.log.written).toEqual([{ id: 1, bytes: [0, 7, 0, 0, 0, 4, 1, 0x02, 0x01, 0x01] }])
  })

  // A PLC that stops answering leaves its last outputs in the image. Holding them runs the line forever on
  // a value nobody drives - the case being: you stop the PLC to edit its program. These pin the fail-safe.
  describe('the watchdog: when the PLC stops answering', () => {
    /** a session on a clock the test moves by hand, with the coil already written on */
    const running = async () => {
      const h = fakeHost()
      let clock = 1_000_000
      const session = new ExternalPlcSession(h.host, IO, [], () => {}, () => clock)
      await session.start({})
      h.connect(1)
      h.send(1, frame(1, [0x05, 0x03, 0x20, 0xff, 0x00])) // FC5: coil 800 ON
      expect(session.exchange({})).toEqual({ '%QX100.0': true })
      return { h, session, tick: (ms: number) => (clock += ms) }
    }

    it('holds the values while the polls keep coming', async () => {
      const { h, session, tick } = await running()
      for (let i = 0; i < 5; i++) {
        tick(POLL_TIMEOUT_MS - 1)
        h.send(1, frame(2, [0x02, 0x03, 0x20, 0x00, 0x01])) // a poll, which re-arms the watchdog
        expect(session.exchange({})).toBeNull() // nothing changed: the belt stays on
      }
      expect(session.status().stale).toBe(false)
    })

    it('drives the outputs off once the polls stop, and says so', async () => {
      const { session, tick } = await running()
      tick(POLL_TIMEOUT_MS + 1)
      expect(session.exchange({})).toEqual({ '%QX100.0': false })
      expect(session.status()).toMatchObject({ stale: true, sinceLastRequestMs: POLL_TIMEOUT_MS + 1 })
    })

    it('takes the PLC back the moment it polls again', async () => {
      const { h, session, tick } = await running()
      tick(POLL_TIMEOUT_MS + 1)
      expect(session.exchange({})).toEqual({ '%QX100.0': false })
      h.send(1, frame(3, [0x02, 0x03, 0x20, 0x00, 0x01]))
      expect(session.exchange({})).toEqual({ '%QX100.0': true }) // the image kept it: no rewrite needed
      expect(session.status().stale).toBe(false)
    })

    it('does not wait for the timeout when the connection drops', async () => {
      const { h, session } = await running()
      h.connect(1, false)
      expect(session.exchange({})).toEqual({ '%QX100.0': false })
      expect(session.status()).toMatchObject({ stale: true, masters: [] })
    })

    it('is not armed before the PLC has ever polled, which is not a fault', async () => {
      const h = fakeHost()
      let clock = 1_000_000
      const session = new ExternalPlcSession(h.host, IO, [], () => {}, () => clock)
      await session.start({})
      clock += POLL_TIMEOUT_MS * 10
      expect(session.exchange({})).toEqual({ '%QX100.0': false }) // off because nothing wrote it, not a fault
      expect(session.status()).toMatchObject({ stale: false, sinceLastRequestMs: null })
    })

    it('tells the dock the moment it trips, without waiting for a poll of the status', async () => {
      const h = fakeHost()
      let clock = 1_000_000
      let changes = 0
      const session = new ExternalPlcSession(h.host, IO, [], () => changes++, () => clock)
      await session.start({})
      h.connect(1)
      h.send(1, frame(1, [0x05, 0x03, 0x20, 0xff, 0x00]))
      session.exchange({})
      const before = changes
      clock += POLL_TIMEOUT_MS + 1
      session.exchange({})
      expect(changes).toBe(before + 1)
    })
  })

  it('hands the parts what the PLC wrote, only when it changed', async () => {
    const h = fakeHost()
    const session = new ExternalPlcSession(h.host, IO, [], () => {})
    await session.start({})
    h.connect(1)
    expect(session.exchange({ '%IX100.0': false })).toEqual({ '%QX100.0': false })
    expect(session.exchange({ '%IX100.0': false })).toBeNull() // nothing new: nothing posted
    h.send(1, frame(1, [0x05, 0x03, 0x20, 0xff, 0x00])) // FC5: coil 800 ON
    expect(session.exchange({ '%IX100.0': true })).toEqual({ '%QX100.0': true })
    expect(session.status().requests).toBe('FC5 x1')
  })

  it('closes a connection that is not Modbus, and says so', async () => {
    const h = fakeHost()
    const changes: string[] = []
    const session = new ExternalPlcSession(h.host, IO, [], () => changes.push(session.status().state))
    await session.start({})
    h.connect(3)
    h.send(3, [0, 1, 0, 0, 0x40, 0, 1]) // a length Modbus TCP cannot have
    expect(h.log.dropped).toEqual([3])
    expect(session.status().error).toMatch(/closed a connection from 10.0.0.3:50003: a frame declared 16384 bytes/)
    h.connect(3, false)
    expect(session.status().masters).toEqual([])
    expect(changes.length).toBeGreaterThan(0)
  })

  it('reports a port that would not open', async () => {
    const h = fakeHost('port 5020 is already in use on 127.0.0.1')
    const session = new ExternalPlcSession(h.host, IO, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'failed', error: 'port 5020 is already in use on 127.0.0.1' })
  })

  it('stops listening and lets go of the host', async () => {
    const h = fakeHost()
    const session = new ExternalPlcSession(h.host, IO, [], () => {})
    await session.start({})
    expect(h.listeners()).toBe(2)
    await session.stop()
    await session.stop() // twice is harmless
    expect(h.log.closed).toBe(1)
    expect(h.listeners()).toBe(0)
    expect(session.status().state).toBe('off')
  })
})

describe('the table a scene makes', () => {
  const SENSOR: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 't.sensor',
    name: 't.sensor', commsParam: 'enableComms',
    params: { enableComms: { type: 'boolean', default: false }, tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
    behavior: 'definePart({step(){}})',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
  const MOTOR: PartPackage = { ...SENSOR, id: 't.motor', name: 't.motor', params: { enableComms: { type: 'boolean', default: false }, runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' } } }
  const LASER: PartPackage = { ...SENSOR, id: 't.laser', name: 't.laser', params: { enableComms: { type: 'boolean', default: false }, distanceTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '' } } }
  const part = (id: string, packageId: string, params: Record<string, unknown>) =>
    ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: { enableComms: true, ...params } }) as unknown as PartInstance
  afterEach(() => clearPackages())

  it('serves every addressed tag, on this machine or the network', () => {
    registerPackage(SENSOR)
    registerPackage(MOTOR)
    const parts = [part('e', 't.sensor', { tag: '%IX100.0' }), part('m', 't.motor', { runTag: '%QX100.0' }), part('n', 't.sensor', { tag: 'Named' })]
    const local = deriveExternalIo(parts, { port: 5020, network: false })
    expect(local.io).toEqual({ ...IO, points: [IO.points[1], IO.points[0]] })
    expect(local.problems).toEqual([])
    expect(deriveExternalIo(parts, { port: 502, network: true }).io).toMatchObject({ host: '0.0.0.0', port: 502 })
  })

  it('carries an analog tag in a double word, and the dock says which registers', () => {
    registerPackage(SENSOR)
    registerPackage(LASER)
    const parts = [part('l', 't.laser', { distanceTag: '%ID100' }), part('e', 't.sensor', { tag: '%IX100.0' })]
    const { io, problems } = deriveExternalIo(parts, DEFAULT_EXTERNAL_PLC)
    expect(problems).toEqual([])
    expect(io.points).toContainEqual({ tag: '%ID100', area: 'inputRegister', address: 200, type: 'REAL' })
    expect(io.points.map(describePoint)).toContain('%ID100  input registers 200-201  REAL')
    expect(io.points.map(describePoint)).toContain('%IX100.0  discrete input 800')
  })

  it('names the wiring that cannot be served', () => {
    registerPackage(SENSOR)
    registerPackage(MOTOR)
    const { io, problems } = deriveExternalIo([part('e', 't.sensor', { tag: '%QX0.0' }), part('m', 't.motor', { runTag: '%QX0.0.0' })], DEFAULT_EXTERNAL_PLC)
    expect(io.points).toEqual([])
    expect(problems).toEqual([expect.stringMatching(/^e \(tag\): this part publishes the value, so it is the PLC's input/), expect.stringMatching(/^m \(runTag\): a bit address is byte\.bit/)])
  })
})

describe('supporting pieces', () => {
  it('flattens the frame the way the worker does', () => {
    expect(flattenFrameTags({ a: { x: 1 }, b: { y: true, x: 2 } })).toEqual({ x: 2, y: true })
    expect(flattenFrameTags(undefined)).toEqual({})
  })

  it('keeps only valid settings', () => {
    expect(sanitizeExternalPlc({ enabled: true, port: 502, network: 'yes' })).toEqual({ ...DEFAULT_EXTERNAL_PLC, enabled: true, port: 502 })
    expect(sanitizeExternalPlc({ port: 70000 })).toEqual(DEFAULT_EXTERNAL_PLC)
    expect(sanitizeExternalPlc('garbage')).toEqual(DEFAULT_EXTERNAL_PLC)
    expect(sanitizeExternalPlc({ mode: 'poll', plcHost: 'plc-7.local', plcPort: 1502, inputBase: 4, outputBase: 8 })).toEqual({
      ...DEFAULT_EXTERNAL_PLC,
      mode: 'poll',
      plcHost: 'plc-7.local',
      plcPort: 1502,
      inputBase: 4,
      outputBase: 8,
    })
    // a host that could be a URL, a mode nobody knows, and a base past the register space fall back
    expect(sanitizeExternalPlc({ mode: 'both', plcHost: 'http://x/', inputBase: -1, outputBase: 70000 })).toEqual(DEFAULT_EXTERNAL_PLC)
    expect(sanitizeExternalPlc({ mode: 'opcua', opcUaEndpoint: 'opc.tcp://10.0.0.5:4840/plc' })).toMatchObject({ mode: 'opcua', opcUaEndpoint: 'opc.tcp://10.0.0.5:4840/plc' })
    expect(sanitizeExternalPlc({ opcUaEndpoint: 'http://10.0.0.5:4840' }).opcUaEndpoint).toBe(DEFAULT_EXTERNAL_PLC.opcUaEndpoint)
  })
})

// The other topology: the PLC runs a Modbus server device and the simulator polls it. The fake
// PLC here is this repo's own server code answering from a register image, which is how such a device
// behaves: the client writes holding registers (the PLC's inputs) and reads input registers (its outputs).
describe('polling a PLC that serves (a Modbus server device)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A desktop socket whose connections reach a fake PLC server. `refuse` connects fail; `silent` stops it answering. */
  function plcServer() {
    const image = new ModbusImage()
    const conn = new Set<(e: { id: number; remote: string; open: boolean }) => void>()
    const data = new Set<(e: { id: number; bytes: Uint8Array }) => void>()
    const ctl = { refuse: 0, silent: false, connects: 0, closed: 0, nextId: 1 }
    let stream: ModbusStream | null = null
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
        stream = new ModbusStream(image)
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
        if (id !== current || !stream || ctl.silent) return
        for (const reply of stream.push(bytes)) data.forEach((cb) => cb({ id, bytes: reply }))
      },
      drop: () => {},
    }
    /** the PLC closes the connection */
    const hangUp = () => {
      const id = current
      current = 0
      conn.forEach((cb) => cb({ id, remote: 'plc', open: false }))
    }
    return { host, image, ctl, hangUp, listeners: () => conn.size + data.size }
  }

  const TABLE = modbusClientFromTags({ host: '127.0.0.1', port: 502 }, ['%IX0.0', '%QX0.0', { name: '%QD1', type: 'REAL' }]).io

  it("writes the scene's inputs and reads the PLC's outputs, every cycle", async () => {
    const plc = plcServer()
    const session = new ExternalPlcClientSession(plc.host, TABLE, [], () => {})
    await session.start({ '%IX0.0': true })
    // the first cycle carried the sensor as it stood: %IX0.0 is bit 0 of holding register 0
    expect(plc.image.holdingRegisters[0]).toBe(1)
    expect(session.status()).toMatchObject({ mode: 'poll', state: 'polling', endpoint: '127.0.0.1:502', masters: ['127.0.0.1:502'], driven: ['%QX0.0', '%QD1'] })
    // the PLC drives its outputs: Run in input register 0, a REAL speed in 2-3 (low word first)
    plc.image.inputRegisters[0] = 1
    const v = new DataView(new ArrayBuffer(4))
    v.setFloat32(0, 0.5, true)
    plc.image.inputRegisters[2] = v.getUint16(0, true)
    plc.image.inputRegisters[3] = v.getUint16(2, true)
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({ '%IX0.0': false })).toEqual({ '%QX0.0': true, '%QD1': 0.5 })
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(plc.image.holdingRegisters[0]).toBe(0)
    expect(session.status().requests).toMatch(/^FC4 x\d+, FC16 x\d+$/)
    expect(session.status().points).toEqual(['%IX0.0  holding register 0 bit 0', '%QX0.0  input register 0 bit 0', '%QD1  input registers 2-3  REAL'])
  })

  it('keeps trying a PLC that is not up yet, and says why it is waiting', async () => {
    const plc = plcServer()
    plc.ctl.refuse = 2
    const session = new ExternalPlcClientSession(plc.host, TABLE, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'starting', error: 'nothing is listening on 127.0.0.1:502', masters: [] })
    // not armed: the PLC has never answered, so its outputs are off, not a fault
    expect(session.exchange({})).toEqual({ '%QX0.0': false, '%QD1': 0 })
    expect(session.status().stale).toBe(false)
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS * 2 + CLIENT_POLL_MS)
    expect(plc.ctl.connects).toBe(3)
    expect(session.status()).toMatchObject({ state: 'polling', error: null })
  })

  it('drives the outputs off when the PLC stops answering, and takes them back when it answers again', async () => {
    const plc = plcServer()
    const session = new ExternalPlcClientSession(plc.host, TABLE, [], () => {})
    plc.image.inputRegisters[0] = 1
    await session.start({})
    expect(session.exchange({})).toMatchObject({ '%QX0.0': true })
    plc.ctl.silent = true // the connection stays open: a stopped program announces nothing
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + CLIENT_ANSWER_MS)
    expect(session.exchange({})).toEqual({ '%QX0.0': false, '%QD1': 0 })
    expect(session.status()).toMatchObject({ stale: true, error: expect.stringMatching(/no answer to FC16 within 500 ms/) })
    plc.ctl.silent = false
    await vi.advanceTimersByTimeAsync(CLIENT_ANSWER_MS + CLIENT_POLL_MS * 2)
    expect(session.exchange({})).toMatchObject({ '%QX0.0': true })
    expect(session.status()).toMatchObject({ stale: false, error: null })
  })

  it('does not wait for the timeout when the PLC closes the connection, and reconnects', async () => {
    const plc = plcServer()
    const session = new ExternalPlcClientSession(plc.host, TABLE, [], () => {})
    plc.image.inputRegisters[0] = 1
    await session.start({})
    expect(session.exchange({})).toMatchObject({ '%QX0.0': true })
    plc.hangUp()
    expect(session.exchange({})).toEqual({ '%QX0.0': false, '%QD1': 0 })
    expect(session.status()).toMatchObject({ stale: true, state: 'starting', masters: [], error: 'the PLC closed the connection (127.0.0.1:502)' })
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(plc.ctl.connects).toBe(2)
    expect(session.exchange({})).toMatchObject({ '%QX0.0': true })
  })

  it('stops polling and lets go of the host', async () => {
    const plc = plcServer()
    const session = new ExternalPlcClientSession(plc.host, TABLE, [], () => {})
    await session.start({})
    await session.stop()
    await session.stop()
    const cycles = session.poller.cycles
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS * 10)
    expect(session.poller.cycles).toBe(cycles)
    expect(plc.ctl.closed).toBe(1)
    expect(plc.listeners()).toBe(0)
    expect(session.status()).toMatchObject({ state: 'off', masters: [] })
  })
})

// OPC UA: the PLC's server holds its program's variables by name, and the simulator reads and writes them.
// The fake server here is a tree of variables with a scan (`Run := NOT Eye`), behind the same calls the
// desktop shell makes with node-opcua (apps/desktop/opcUaIo.cjs, which has its own smoke test).
describe('an OPC UA session', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  interface Node {
    path: string[]
    nodeId: string
    dataType: string
    access: number
    value: boolean | number
  }

  function uaServer() {
    const nodes: Node[] = [
      { path: ['DeviceSet', 'PLC', 'Programs', 'Main', 'Eye'], nodeId: 'ns=4;s=Main.Eye', dataType: 'ns=0;i=1', access: 3, value: false },
      { path: ['DeviceSet', 'PLC', 'Programs', 'Main', 'Run'], nodeId: 'ns=4;s=Main.Run', dataType: 'ns=0;i=1', access: 3, value: true },
      { path: ['DeviceSet', 'PLC', 'Programs', 'Main', 'Speed'], nodeId: 'ns=4;s=Main.Speed', dataType: 'ns=0;i=10', access: 3, value: 0.5 },
    ]
    const byId = (id: string) => nodes.find((n) => n.nodeId === id)
    const closed = new Set<(e: { why: string }) => void>()
    const ctl = { refuse: 0, connects: 0, closes: 0, browses: 0, up: false }
    const log = { writes: [] as { nodeId: string; builtin: number; value: boolean | number }[] }
    const host: OpcUaHost = {
      connect: async () => {
        ctl.connects++
        if (ctl.refuse > 0) {
          ctl.refuse--
          return { error: 'nothing answered at opc.tcp://127.0.0.1:4840' }
        }
        ctl.up = true
        return { error: '' }
      },
      browse: async () => {
        ctl.browses++
        return ctl.up ? { error: '', variables: nodes.map((n) => ({ path: n.path, nodeId: n.nodeId })) } : { error: 'not connected' }
      },
      describe: async ({ nodeIds }) => ({ error: '', nodes: nodeIds.map((id) => ({ dataType: byId(id)?.dataType ?? '', access: byId(id)?.access ?? 0 })) }),
      exchange: async ({ writes, reads }) => {
        if (!ctl.up) return { error: 'not connected' }
        const statuses = writes.map((w) => {
          log.writes.push(w)
          const n = byId(w.nodeId)
          if (!n || (n.access & 2) === 0) return 'BadNotWritable'
          n.value = w.value
          // the PLC's scan
          if (n.path.at(-1) === 'Eye') byId('ns=4;s=Main.Run')!.value = !w.value
          return 'Good'
        })
        return { error: '', writes: statuses, reads: reads.map((id) => ({ value: byId(id)?.value ?? null, status: byId(id) ? 'Good' : 'BadNodeIdUnknown' })) }
      },
      close: async () => {
        ctl.closes++
        ctl.up = false
      },
      onClosed: (cb) => {
        closed.add(cb)
        return () => closed.delete(cb)
      },
    }
    const goAway = () => {
      ctl.up = false
      closed.forEach((cb) => cb({ why: 'the connection to the PLC was lost' }))
    }
    return { host, nodes, byId, ctl, log, goAway, listeners: () => closed.size }
  }

  const POINTS: OpcUaPoint[] = [
    { tag: 'Eye', dir: 'toPlc', type: 'BOOL' },
    { tag: 'Main.Run', dir: 'fromPlc', type: 'BOOL' },
    { tag: 'Speed', dir: 'fromPlc', type: 'REAL' },
  ]

  it('finds each tag by name, writes what the parts publish and reads what the PLC drives', async () => {
    const ua = uaServer()
    const session = new ExternalPlcOpcUaSession(ua.host, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {})
    await session.start({ Eye: true })
    // the first cycle already carried the sensor, and the PLC's rung answered it
    expect(ua.log.writes[0]).toEqual({ nodeId: 'ns=4;s=Main.Eye', builtin: 1, value: true })
    expect(session.exchange({ Eye: true })).toEqual({ 'Main.Run': false, Speed: 0.5 })
    expect(session.status()).toMatchObject({
      mode: 'opcua',
      state: 'polling',
      masters: ['opc.tcp://127.0.0.1:4840'],
      driven: ['Main.Run', 'Speed'],
      points: ['Eye  DeviceSet.PLC.Programs.Main.Eye  Boolean', 'Main.Run  DeviceSet.PLC.Programs.Main.Run  Boolean', 'Speed  DeviceSet.PLC.Programs.Main.Speed  Float'],
      problems: [],
    })
    session.exchange({ Eye: false })
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({ Eye: false })).toEqual({ 'Main.Run': true, Speed: 0.5 })
    expect(session.status().requests).toMatch(/^\d+ read\/write cycles$/)
  })

  it('names a tag the PLC does not have, and one it will not let the simulator write, and runs the rest', async () => {
    const ua = uaServer()
    ua.byId('ns=4;s=Main.Eye')!.access = 1
    const points: OpcUaPoint[] = [...POINTS, { tag: 'Missing', dir: 'fromPlc', type: 'BOOL' }]
    const session = new ExternalPlcOpcUaSession(ua.host, 'opc.tcp://127.0.0.1:4840', points, [], () => {})
    await session.start({ Eye: true })
    const problems = session.status().problems
    expect(problems).toContainEqual('the PLC has no tag named Missing')
    expect(problems).toContainEqual(expect.stringMatching(/^Eye: the PLC does not let this client write .*Main\.Eye/))
    expect(session.exchange({})).toEqual({ 'Main.Run': true, Speed: 0.5, Missing: false })
  })

  it('keeps trying a PLC that is not up yet, and says why it waits', async () => {
    const ua = uaServer()
    ua.ctl.refuse = 2
    const session = new ExternalPlcOpcUaSession(ua.host, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'starting', error: 'nothing answered at opc.tcp://127.0.0.1:4840', masters: [] })
    expect(session.exchange({})).toEqual({ 'Main.Run': false, Speed: 0 })
    expect(session.status().stale).toBe(false)
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS * 2 + CLIENT_POLL_MS)
    expect(ua.ctl.connects).toBe(3)
    expect(session.status()).toMatchObject({ state: 'polling', error: null })
  })

  it('drives the outputs off when the PLC goes away, and finds the tags again when it is back', async () => {
    const ua = uaServer()
    const session = new ExternalPlcOpcUaSession(ua.host, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {})
    await session.start({ Eye: false })
    expect(session.exchange({})).toMatchObject({ 'Main.Run': true })
    ua.goAway()
    expect(session.exchange({})).toEqual({ 'Main.Run': false, Speed: 0 })
    expect(session.status()).toMatchObject({ stale: true, state: 'starting', masters: [], error: 'the connection to the PLC was lost' })
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(ua.ctl.browses).toBe(2) // a PLC that came back may have rebuilt its tree
    expect(session.exchange({})).toMatchObject({ 'Main.Run': true })
    expect(session.status().stale).toBe(false)
  })

  it('says so when the address is a discovery server, names what it lists, and stops trying', async () => {
    const ua = uaServer()
    let connects = 0
    const lds: OpcUaHost = {
      ...ua.host,
      connect: async () => {
        connects++
        return { error: 'a discovery server, not a PLC', discovery: [{ name: 'Example Soft PLC', urls: ['opc.tcp://plc:4841'] }] }
      },
    }
    const session = new ExternalPlcOpcUaSession(lds, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({
      state: 'failed',
      error: 'opc.tcp://127.0.0.1:4840 is an OPC UA discovery server, not a PLC: it only lists the OPC UA servers on its machine. It knows of Example Soft PLC at opc.tcp://plc:4841. Put that address in the Server field.',
    })
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS * 5)
    expect(connects).toBe(1) // a discovery server does not become a PLC by being asked again
    expect(session.status().problems).toEqual([]) // and the tags are not reported missing
  })

  it('stops, and lets go of the shell', async () => {
    const ua = uaServer()
    const session = new ExternalPlcOpcUaSession(ua.host, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {})
    await session.start({})
    await session.stop()
    await session.stop()
    const writes = ua.log.writes.length
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS * 10)
    expect(ua.log.writes.length).toBe(writes)
    expect(ua.ctl.closes).toBe(1)
    expect(ua.listeners()).toBe(0)
    expect(session.status()).toMatchObject({ state: 'off', masters: [] })
  })

  it('runs with what a browse found when a branch never answered, and names the branch', async () => {
    const ua = uaServer()
    const browse = ua.host.browse
    const host: OpcUaHost = { ...ua.host, browse: async (opts) => ({ ...(await browse(opts)), skipped: ['DeviceSet.Cnc'] }) }
    const session = new ExternalPlcOpcUaSession(host, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {})
    await session.start({ Eye: false })
    expect(session.status()).toMatchObject({ state: 'polling' })
    expect(session.status().problems).toEqual(["a branch of the PLC's tags did not answer in time (DeviceSet.Cnc); a tag under it reads as missing"])
    expect(session.browsed?.truncated).toBe(true) // the tag picker's list is incomplete
    expect(session.exchange({})).toMatchObject({ 'Main.Run': true })
  })

  it('browses from the start points the link names, and gives the tag picker the list with them', async () => {
    const ua = uaServer()
    const asked: unknown[] = []
    const browse = ua.host.browse
    const host: OpcUaHost = {
      ...ua.host,
      browse: async (opts) => {
        asked.push(opts?.roots)
        return browse(opts)
      },
    }
    const from = ['DeviceSet.PLC.Programs', 'ns=4;s=GVL']
    const session = new ExternalPlcOpcUaSession(host, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {}, from)
    await session.start({})
    expect(asked).toEqual([[{ path: ['DeviceSet', 'PLC', 'Programs'] }, { nodeId: 'ns=4;s=GVL' }]])
    expect(plcTagListOf(session.endpoint, session.from, session.browsed!)).toMatchObject({ from, state: 'ready' })
    await session.stop()
    asked.length = 0
    const list = await readOpcUaTagList(host, 'opc.tcp://127.0.0.1:4840', ['Programs'], () => true)
    expect(asked).toEqual([[{ path: ['Programs'] }]])
    expect(list).toMatchObject({ from: ['Programs'], state: 'ready' })
  })

  it('says how many tags it has found while a long browse runs, and stops saying it once bound', async () => {
    const ua = uaServer()
    const heard = new Set<(e: { found: number }) => void>()
    let finish = (): void => {}
    const browse = ua.host.browse
    const host: OpcUaHost = {
      ...ua.host,
      browse: async (opts) => {
        await new Promise<void>((resolve) => (finish = resolve))
        return browse(opts)
      },
      onProgress: (cb) => {
        heard.add(cb)
        return () => heard.delete(cb)
      },
    }
    const session = new ExternalPlcOpcUaSession(host, 'opc.tcp://127.0.0.1:4840', POINTS, [], () => {})
    const started = session.start({})
    await vi.advanceTimersByTimeAsync(0)
    heard.forEach((cb) => cb({ found: 1200 }))
    expect(session.status()).toMatchObject({ state: 'starting', reading: 1200 })
    expect(statusLine(session.status(), true, { ...DEFAULT_EXTERNAL_PLC, mode: 'opcua' })).toBe("Reading the PLC's tags at opc.tcp://127.0.0.1:4840: 1200 found so far...")
    finish()
    await started
    expect(session.status().state).toBe('polling')
    expect(session.status().reading).toBeUndefined()
    expect(heard.size).toBe(0)
  })

  it('does not read the tree when every tag is a NodeId', async () => {
    const ua = uaServer()
    const points: OpcUaPoint[] = [
      { tag: 'ns=4;s=Main.Eye', dir: 'toPlc', type: 'BOOL' },
      { tag: 'ns=4;s=Main.Run', dir: 'fromPlc', type: 'BOOL' },
    ]
    const session = new ExternalPlcOpcUaSession(ua.host, 'opc.tcp://127.0.0.1:4840', points, [], () => {})
    await session.start({ 'ns=4;s=Main.Eye': true })
    expect(ua.ctl.browses).toBe(0)
    expect(session.browsed).toBeNull()
    expect(session.status()).toMatchObject({ state: 'polling', problems: [] })
    expect(session.exchange({})).toEqual({ 'ns=4;s=Main.Run': false })
  })
})

// EtherNet/IP: a Logix controller answers each tag by name with its value and CIP type. The fake controller here is a
// tag table with a scan (`Run := NOT Eye`), behind the same calls the desktop shell makes with libplctag
// (apps/desktop/eipIo.cjs, which has its own smoke test against libplctag's simulator).
describe('an EtherNet/IP session', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function logix() {
    const tags: Record<string, { cip: number; value: boolean | number; readOnly?: boolean; remoteErr?: boolean }> = {
      Eye: { cip: 0xc1, value: false },
      Run: { cip: 0xc1, value: true },
      Speed: { cip: 0xca, value: 0.5 },
      Count: { cip: 0xc4, value: 0 },
    }
    // wrongPath: the Ethernet module answers every request itself, "Link Address Not Valid" (CIP 0x01/0x0312), which
    // libplctag reports as BAD_PARAM - the status its simulator gives a missing tag
    const ctl = { up: true, opens: 0, binds: 0, closes: 0, openError: '', wrongPath: false }
    const log = { writes: [] as { name: string; value: boolean | number }[] }
    const down = (n: number) => Array.from({ length: n }, () => 'PLCTAG_ERR_TIMEOUT')
    const host: EipHost = {
      open: async () => {
        ctl.opens++
        return { error: ctl.openError }
      },
      bind: async ({ tags: list }) => {
        ctl.binds++
        if (!ctl.up) return { error: '', tags: list.map(() => ({ status: 'PLCTAG_ERR_TIMEOUT', cip: null })) }
        if (ctl.wrongPath) return { error: '', tags: list.map(() => ({ status: 'PLCTAG_ERR_BAD_PARAM', cip: null })) }
        return { error: '', tags: list.map((t) => (tags[t.name] ? { status: 'ok', cip: tags[t.name]!.cip } : { status: 'PLCTAG_ERR_NOT_FOUND', cip: null })) }
      },
      exchange: async ({ writes, reads }) => {
        if (!ctl.up) return { error: '', writes: down(writes.length), reads: down(reads.length).map((status) => ({ value: null, status })) }
        const statuses = writes.map((w) => {
          log.writes.push(w)
          const t = tags[w.name]
          if (!t) return 'PLCTAG_ERR_NOT_FOUND'
          if (t.readOnly) return 'PLCTAG_ERR_NOT_ALLOWED'
          t.value = w.value
          if (w.name === 'Eye') tags.Run!.value = !w.value // the controller's scan
          return 'ok'
        })
        const read = (n: string) =>
          !tags[n] ? { value: null, status: 'PLCTAG_ERR_NOT_FOUND' } : tags[n]!.remoteErr ? { value: null, status: 'PLCTAG_ERR_REMOTE_ERR' } : { value: tags[n]!.value, status: 'ok' }
        return { error: '', writes: statuses, reads: reads.map(read) }
      },
      close: async () => {
        ctl.closes++
      },
    }
    return { host, tags, ctl, log }
  }

  const POINTS: EipPoint[] = [
    { tag: 'Eye', dir: 'toPlc', type: 'BOOL', bit: false },
    { tag: 'Run', dir: 'fromPlc', type: 'BOOL', bit: false },
    { tag: 'Speed', dir: 'fromPlc', type: 'REAL', bit: false },
  ]

  it('asks for each tag by name, writes what the parts publish and reads what the controller drives', async () => {
    const plc = logix()
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, POINTS, [], () => {})
    await session.start({ Eye: true })
    expect(plc.log.writes[0]).toEqual({ name: 'Eye', value: true })
    expect(session.exchange({ Eye: true })).toEqual({ Run: false, Speed: 0.5 })
    expect(session.status()).toMatchObject({
      mode: 'eip',
      state: 'polling',
      endpoint: '10.0.0.5 (path 1,0)',
      masters: ['10.0.0.5 (path 1,0)'],
      driven: ['Run', 'Speed'],
      points: ['Eye  written to the PLC  BOOL', 'Run  read from the PLC  BOOL', 'Speed  read from the PLC  REAL'],
      problems: [],
    })
    session.exchange({ Eye: false })
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({ Eye: false })).toEqual({ Run: true, Speed: 0.5 })
    expect(session.status().requests).toMatch(/^\d+ read\/write cycles$/)
  })

  it('names a tag the controller lacks, one of the wrong type, and one it will not let the simulator write, and runs the rest', async () => {
    const plc = logix()
    plc.tags.Eye!.readOnly = true
    const points: EipPoint[] = [...POINTS, { tag: 'Missing', dir: 'fromPlc', type: 'BOOL', bit: false }, { tag: 'Count', dir: 'fromPlc', type: 'BOOL', bit: false }]
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, points, [], () => {})
    await session.start({ Eye: true })
    expect(session.status().problems).toEqual([
      'the controller has no tag named Missing',
      'Count: the parts carry a bit, and the controller holds it as DINT',
      expect.stringMatching(/^the controller does not let this client write Eye .*\(on write\)$/),
    ])
    expect(session.exchange({})).toEqual({ Run: true, Speed: 0.5, Missing: false, Count: false })
  })

  it('keeps trying a controller that does not answer, and says why it waits', async () => {
    const plc = logix()
    plc.ctl.up = false
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, POINTS, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'starting', error: expect.stringMatching(/^nothing answered \(PLCTAG_ERR_TIMEOUT\)/) })
    expect(session.exchange({})).toEqual({ Run: false, Speed: 0 })
    expect(session.status().stale).toBe(false) // nothing to de-energise before it ever answered
    plc.ctl.up = true
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(plc.ctl.opens).toBe(1) // where it is was said once; only the tags are asked for again
    expect(session.status()).toMatchObject({ state: 'polling', error: null })
  })

  it('drives the outputs off when the controller stops answering, and asks for the tags again when it is back', async () => {
    let t = 0
    const plc = logix()
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, POINTS, [], () => {}, () => t)
    await session.start({ Eye: false })
    expect(session.exchange({})).toMatchObject({ Run: true })
    plc.ctl.up = false
    t += CLIENT_POLL_MS
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({})).toEqual({ Run: false, Speed: 0 })
    expect(session.status()).toMatchObject({ stale: true, state: 'starting', error: 'the controller stopped answering (PLCTAG_ERR_TIMEOUT)' })
    expect(statusLine(session.status(), true, DEFAULT_EXTERNAL_PLC)).toMatch(/^The PLC at 10\.0\.0\.5 \(path 1,0\) stopped answering for 0\.0 s: its outputs are held off/)
    plc.ctl.up = true
    t += CLIENT_RETRY_MS
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(plc.ctl.binds).toBe(2)
    expect(session.exchange({})).toMatchObject({ Run: true })
    expect(session.status().stale).toBe(false)
  })

  it('says to check the path when the address answers for none of the tags, and binds once the route is right', async () => {
    const plc = logix()
    plc.ctl.wrongPath = true
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '1,3', family: 'logix' }, POINTS, [], () => {})
    await session.start({})
    const s = session.status()
    expect(s).toMatchObject({ state: 'starting', problems: [] }) // not "no tag named Eye", "... Run", "... Speed"
    expect(statusLine(s, true, DEFAULT_EXTERNAL_PLC)).toBe(
      "Waiting for the PLC at 10.0.0.5 (path 1,3): the address answered, but none of the tags did (Eye, Run, Speed; PLCTAG_ERR_BAD_PARAM). Check the path (1,3: the backplane, then the controller's slot) first: a route to the wrong slot makes every tag look missing, then check the tag names. Trying again every second.",
    )
    expect(session.exchange({})).toEqual({ Run: false, Speed: 0 })
    plc.ctl.wrongPath = false // say, the controller was in the middle of a download
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(session.status()).toMatchObject({ state: 'polling', error: null, problems: [] })
  })

  it('takes an error the controller answered with as that tag\'s, and keeps the link up', async () => {
    let t = 0
    const plc = logix()
    plc.tags.Run!.remoteErr = true
    const points: EipPoint[] = [{ tag: 'Run', dir: 'fromPlc', type: 'BOOL', bit: false }]
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, points, [], () => {}, () => t)
    await session.start({})
    for (let i = 0; i < 5; i++) {
      t += CLIENT_POLL_MS
      await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    }
    expect(plc.ctl.binds).toBe(1) // never taken for a dead controller and asked for again
    expect(session.status()).toMatchObject({ state: 'polling', stale: false, error: null })
    expect(session.status().problems).toEqual([expect.stringMatching(/^Run: the controller refused the request .*\(on read\)$/)])
  })

  it('stops for good when the shell cannot open the link at all', async () => {
    const plc = logix()
    plc.ctl.openError = 'EtherNet/IP needs libplctag, which this build of the app could not load (plctag.dll is missing)'
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, POINTS, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({ state: 'failed', error: plc.ctl.openError })
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS * 5)
    expect(plc.ctl.opens).toBe(1)
    expect(statusLine(session.status(), true, DEFAULT_EXTERNAL_PLC)).toBe(`Could not connect: ${plc.ctl.openError}`)
  })

  it('stops, and lets go of the shell', async () => {
    const plc = logix()
    const session = new ExternalPlcEipSession(plc.host, { gateway: '10.0.0.5', path: '', family: 'logix' }, POINTS, [], () => {})
    await session.start({})
    expect(session.status().endpoint).toBe('10.0.0.5')
    await session.stop()
    await session.stop()
    const writes = plc.log.writes.length
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS * 10)
    expect(plc.log.writes.length).toBe(writes)
    expect(plc.ctl.closes).toBe(1)
    expect(session.status()).toMatchObject({ state: 'off', masters: [] })
  })

  it('says what Play would do, before Play', () => {
    const settings = sanitizeExternalPlc({ mode: 'eip', eipGateway: '192.168.1.20', eipPath: '1,2' })
    expect(settings).toMatchObject({ mode: 'eip', eipGateway: '192.168.1.20', eipPath: '1,2' })
    expect(sanitizeExternalPlc({ mode: 'eip', eipPath: '1,0&debug=4' }).eipPath).toBe(DEFAULT_EXTERNAL_PLC.eipPath)
    expect(statusLine(EXTERNAL_PLC_OFF, false, settings)).toBe('Press Play to connect to the controller at 192.168.1.20 (path 1,2) over EtherNet/IP; the program here is not run while the PLC is.')
    // the family: Logix unless a known one is given; a Micro800 keeps the path field but is shown (and opened) without it
    expect(settings.eipFamily).toBe('logix')
    expect(sanitizeExternalPlc({ mode: 'eip', eipFamily: 'Micro800&debug=4' }).eipFamily).toBe('logix')
    const micro = sanitizeExternalPlc({ mode: 'eip', eipGateway: '192.168.1.21', eipPath: '1,2', eipFamily: 'micro800' })
    expect(micro).toMatchObject({ eipFamily: 'micro800', eipPath: '1,2' })
    expect(statusLine(EXTERNAL_PLC_OFF, false, micro)).toBe('Press Play to connect to the controller at 192.168.1.21 (Micro800) over EtherNet/IP; the program here is not run while the PLC is.')
  })
})

describe('the table a scene makes for a PLC that serves', () => {
  const SENSOR: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 't.sensor',
    name: 't.sensor', commsParam: 'enableComms',
    params: { enableComms: { type: 'boolean', default: false }, tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
    behavior: 'definePart({step(){}})',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
  afterEach(() => clearPackages())

  it("finds each address in the device's register image, from where the device sits", () => {
    registerPackage(SENSOR)
    const parts = [
      { id: 'e', type: 'part', packageId: 't.sensor', position: [0, 0, 0], rotationY: 0, params: { enableComms: true, tag: '%IX8.1' } },
      { id: 'f', type: 'part', packageId: 't.sensor', position: [0, 0, 0], rotationY: 0, params: { enableComms: true, tag: '%IX0.0' } },
    ] as unknown as PartInstance[]
    const settings = { ...DEFAULT_EXTERNAL_PLC, mode: 'poll' as const, plcHost: '10.0.0.5', inputBase: 4 }
    const { io, problems } = deriveClientIo(parts, settings)
    expect(io).toMatchObject({ protocol: 'modbus-tcp-client', host: '10.0.0.5', port: 502, base: { input: 4, output: 0 } })
    expect(io.points).toEqual([{ tag: '%IX8.1', area: 'holdingRegister', register: 0, bit: 1, words: 1 }])
    expect(problems).toEqual([expect.stringMatching(/%IX0.0 is below the server device's first register \(%IW4\)/)])
    expect(plannedLink(parts, settings).points).toEqual(['%IX8.1  holding register 0 bit 1'])
    expect(plannedLink(parts, DEFAULT_EXTERNAL_PLC).points).toEqual(['%IX0.0  discrete input 0', '%IX8.1  discrete input 65'])
  })
})

describe('Watch only', () => {
  const EYE: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 't.eye',
    name: 't.eye',
    params: { tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' }, run: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' } },
    behavior: 'definePart({step(){}})',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
  afterEach(() => clearPackages())
  const parts = (tag: string, run: string) => [{ id: 'e', type: 'part', packageId: 't.eye', position: [0, 0, 0], rotationY: 0, params: { tag, run } }] as unknown as PartInstance[]

  it('reads every tag from the PLC, the ones parts write included, and writes none', () => {
    registerPackage(EYE)
    const opcua = { ...DEFAULT_EXTERNAL_PLC, mode: 'opcua' as const }
    expect(plannedLink(parts('MAIN.Eye', 'MAIN.Run'), opcua).points).toEqual(['MAIN.Eye  written to the PLC  BOOL', 'MAIN.Run  read from the PLC  BOOL'])
    expect(plannedLink(parts('MAIN.Eye', 'MAIN.Run'), { ...opcua, watch: true }).points).toEqual(['MAIN.Eye  read from the PLC  BOOL', 'MAIN.Run  read from the PLC  BOOL'])
    const s7 = { ...DEFAULT_EXTERNAL_PLC, mode: 's7' as const, watch: true }
    const { io } = deriveS7Io(parts('%IX0.0', '%QX0.0'), s7)
    expect(io.points.map((p) => p.dir)).toEqual(['toPlc', 'fromPlc'])
    expect(watchedPoints(io.points).map((p) => [p.tag, p.dir])).toEqual([
      ['%IX0.0', 'fromPlc'],
      ['%QX0.0', 'fromPlc'],
    ])
  })

  it('is refused over Modbus, which cannot read what the simulator would write, and says so', () => {
    registerPackage(EYE)
    for (const mode of ['serve', 'poll'] as const) {
      const planned = plannedLink(parts('%IX0.0', '%QX0.0'), { ...DEFAULT_EXTERNAL_PLC, mode, watch: true })
      expect(planned.points).toEqual([])
      expect(planned.problems).toEqual([expect.stringMatching(/Watch only does not work over Modbus/)])
    }
    expect(watchRefusal({ mode: 'serve', watch: false })).toBeNull()
  })
})

describe('what the link says to try next', () => {
  const failing = (mode: ExternalPlcStatus['mode'], endpoint: string, error: string): ExternalPlcStatus => ({ ...EXTERNAL_PLC_OFF, mode, state: 'starting', endpoint, error })

  it('says nothing before Play, once the link works, or while the watchdog line already explains', async () => {
    expect(statusHint(EXTERNAL_PLC_OFF, false)).toBeNull()
    const h = fakeHost()
    const session = new ExternalPlcSession(h.host, IO, [], () => {})
    await session.start({})
    h.connect(1)
    h.send(1, frame(1, [0x05, 0x03, 0x20, 0xff, 0x00])) // FC5: coil 800 ON
    expect(statusHint(session.status(), true)).toBeNull()
    expect(statusHint({ ...session.status(), stale: true, masters: [] }, true)).toBeNull()
  })

  describe('serving: the PLC connects in, so the advice is about this computer', () => {
    it('names the network switch when it listens on this computer only', async () => {
      const session = new ExternalPlcSession(fakeHost().host, IO, [], () => {})
      await session.start({})
      expect(statusHint(session.status(), true)).toBe('Only a PLC running on this computer can connect. For a PLC elsewhere on the network, Stop and tick Reachable from the network.')
    })

    it("names this computer's address, the port and the firewall when it listens on the network", async () => {
      const session = new ExternalPlcSession(fakeHost().host, { ...IO, host: '0.0.0.0', port: 502 }, [], () => {})
      await session.start({})
      expect(statusHint(session.status(), true)).toBe(
        "In the PLC, point its Modbus TCP client at this computer's IP address, port 502, and allow port 502 inbound in this computer's firewall.",
      )
    })

    it('says what holds a port that is taken, and nothing for another failure', async () => {
      const taken = new ExternalPlcSession(fakeHost('port 5020 is already in use on 127.0.0.1').host, IO, [], () => {})
      await taken.start({})
      expect(statusHint(taken.status(), true)).toMatch(/^Another program on this computer holds that port/)
      const other = new ExternalPlcSession(fakeHost('listening on 0.0.0.0:5020 was not allowed').host, IO, [], () => {})
      await other.start({})
      expect(statusHint(other.status(), true)).toBeNull()
    })

    it('says so when a PLC polls but has written none of what it drives, until it writes', async () => {
      const h = fakeHost()
      const session = new ExternalPlcSession(h.host, IO, [], () => {})
      await session.start({})
      h.connect(1)
      expect(statusHint(session.status(), true)).toBeNull() // connected, not polled yet: too early to say
      h.send(1, frame(1, [0x02, 0x03, 0x20, 0x00, 0x01])) // FC2: read discrete input 800
      expect(session.status()).toMatchObject({ plcWrites: 0, exceptions: 0 })
      expect(statusHint(session.status(), true)).toBe(
        'The PLC is polling but has not written the output it drives yet. If something should be running, check that its program writes the points below.',
      )
      h.send(1, frame(2, [0x0f, 0x03, 0x20, 0x00, 0x01, 0x01, 0x00])) // FC15: coil 800 OFF still counts as writing it
      expect(session.status().plcWrites).toBe(1)
      expect(statusHint(session.status(), true)).toBeNull()
    })

    it('says the mapping disagrees when the PLC asks for something the table does not serve', async () => {
      const h = fakeHost()
      const session = new ExternalPlcSession(h.host, IO, [], () => {})
      await session.start({})
      h.connect(1)
      h.send(1, frame(1, [0x2b, 0x0e, 0x01, 0x00])) // FC43: not a function this server answers
      expect(session.status().exceptions).toBe(1)
      expect(statusHint(session.status(), true)).toBe(
        "The PLC asked for something this table does not serve once (an address outside it, or a function it does not answer): compare the PLC's Modbus mapping with the points below.",
      )
    })
  })

  describe("polling: the simulator connects out, so the advice is about the PLC's address", () => {
    it('reads a refused port as the right host and the wrong port or a server switched off', () => {
      expect(statusHint(failing('poll', '10.0.0.5:502', 'nothing is listening on 10.0.0.5:502'), true)).toBe(
        "The PLC's address answered, but refused port 502: check the port (Modbus TCP's standard is 502) and that the PLC's Modbus TCP server is switched on.",
      )
      // S7's endpoint leaves the standard port out: the error names it
      expect(statusHint(failing('s7', '10.0.0.5 (rack 0, slot 1)', 'nothing is listening on 10.0.0.5:102'), true)).toBe(
        "The PLC's address answered, but refused port 102: check the port (S7 uses 102) and that the address is the CPU's own.",
      )
    })

    it('reads no answer at all as the address, the network or a firewall', () => {
      expect(statusHint(failing('poll', '10.0.0.5:502', 'no answer from 10.0.0.5:502 within 3 s'), true)).toBe(
        "Check the PLC's IP address and port (Modbus TCP's standard is 502), that it is on and on the same network as this computer and that no firewall between them blocks port 502.",
      )
      expect(statusHint(failing('opcua', 'opc.tcp://10.0.0.5:4840', 'nothing answered at opc.tcp://10.0.0.5:4840'), true)).toBe(
        "Check the PLC's IP address and port (OPC UA's standard is 4840), that it is on and on the same network as this computer, that the PLC's OPC UA server is enabled, and that no firewall between them blocks port 4840.",
      )
    })

    it('reads an unknown name as a spelling, and leaves alone an error that already names its cure', () => {
      expect(statusHint(failing('poll', 'plc-1:502', 'no host named plc-1'), true)).toBe("Check the spelling of the PLC's address, or enter its IP address instead.")
      expect(statusHint(failing('eip', '10.0.0.5', 'nothing answered (-7): check the address, the path, the controller family, and that the controller is on'), true)).toBeNull()
      expect(statusHint({ ...failing('ads', '', "TwinCAT's router has no address for this PC (0x6): is the TwinCAT system service running?"), state: 'failed' }, true)).toBeNull()
    })

    it("still matches the desktop shell's wording, which is what it reads", () => {
      // reworded there, a hint would silently stop showing: this is the tripwire
      const plcIo = readFileSync(new URL('../../../apps/desktop/plcIo.cjs', import.meta.url), 'utf8')
      expect(plcIo).toContain('`nothing is listening on ${host}:${port}`')
      expect(plcIo).toContain('`no answer from ${host}:${port} within 3 s`')
      expect(plcIo).toContain('`no host named ${host}`')
      expect(plcIo).toContain('`port ${port} is already in use on ${host}`')
      const opcUaIo = readFileSync(new URL('../../../apps/desktop/opcUaIo.cjs', import.meta.url), 'utf8')
      expect(opcUaIo).toContain('`nothing answered at ${')
    })
  })
})
