import { describe, expect, it } from 'vitest'
import { LocalPlcLink } from '../../plc/link/plcLink'
import type { TagValue } from '../../plc/types'
import { builtinFor, fromClientValue, OpcUaServerSession, publishedVariables, serverStatusHint, serverStatusLine } from './opcUaServer'
import type { OpcUaServerHost, ServerNode } from './opcUaServer'

const PROGRAM = `PROGRAM Main
VAR
  Start : BOOL;
  Eye : BOOL;
  Speed : REAL := 1.5;
  Count : INT;
  Total : DINT;
  Label : STRING := 'idle';
  Hold : TIME := T#2s;
  Door AT %IX100.0 : BOOL;
  T1 : TON;
  C1 : CTU;
END_VAR
VAR CONSTANT
  Limit : INT := 10;
END_VAR
T1(IN := Start, PT := T#1s);
C1(CU := Eye, PV := Limit);
Count := Count + 1;
END_PROGRAM`

const byName = (nodes: ServerNode[]): Record<string, Omit<ServerNode, 'name'>> => Object.fromEntries(nodes.map(({ name, ...rest }) => [name, rest]))

describe('publishedVariables', () => {
  it("publishes every variable of the program as its declaration says, read-only where a client's write could not stick", () => {
    const nodes = byName(publishedVariables(new LocalPlcLink(PROGRAM), new Set(['EYE', '%IX100.0'])))
    expect(nodes.Start).toEqual({ builtin: 1, writable: true, value: false })
    // what a part writes (a photo eye), by name or by the address a located variable sits on, the next scan overwrites
    expect(nodes.Eye).toMatchObject({ builtin: 1, writable: false })
    expect(nodes.Door).toMatchObject({ builtin: 1, writable: false })
    expect(nodes.Speed).toEqual({ builtin: 10, writable: true, value: 1.5 })
    expect(nodes.Count).toMatchObject({ builtin: 4, writable: true })
    expect(nodes.Total).toMatchObject({ builtin: 6, writable: true })
    expect(nodes.Label).toEqual({ builtin: 12, writable: true, value: 'idle' })
    expect(nodes.Hold).toEqual({ builtin: 11, writable: true, value: 2000 })
    expect(nodes.Limit).toMatchObject({ builtin: 4, writable: false })
    // a function block's outputs, typed from what the standard blocks hold, and never written
    expect(nodes['T1.Q']).toMatchObject({ builtin: 1, writable: false })
    expect(nodes['T1.ET']).toMatchObject({ builtin: 11, writable: false })
    expect(nodes['C1.CV']).toMatchObject({ builtin: 4, writable: false })
  })

  it('keys a CONFIGURATION program instance by its name, which becomes a folder on the server', () => {
    const src = `PROGRAM Conveyor
VAR Run : BOOL; END_VAR
END_PROGRAM
CONFIGURATION Cell
  RESOURCE R ON PLC
    TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line1 WITH Fast : Conveyor;
  END_RESOURCE
END_CONFIGURATION`
    expect(byName(publishedVariables(new LocalPlcLink(src), new Set()))['Line1.Run']).toEqual({ builtin: 1, writable: true, value: false })
  })

  it("a client's write lands in the program's variable before its next scan", () => {
    const link = new LocalPlcLink(PROGRAM)
    link.write({ Start: true, Speed: 2.25, Label: 'running', Limit: 99 })
    link.step({}, 0.01)
    expect(link.watch).toMatchObject({ Start: true, Speed: 2.25, Label: 'running', Limit: 10 }) // a constant stays itself
  })

  it('types a value it has no declaration for from the value', () => {
    expect(builtinFor('X.Q', undefined, true)).toBe(1)
    expect(builtinFor('X.S', undefined, 'a')).toBe(12)
    expect(builtinFor('X.OUT', undefined, 3)).toBe(11)
    expect(fromClientValue(1, 1)).toBeNull()
    expect(fromClientValue(4, Number.NaN)).toBeNull()
    expect(fromClientValue(10, 2.5)).toBe(2.5)
  })
})

/** A shell that records what it is told, and lets a test play the client. */
function fakeHost(startError = '') {
  const calls: { defined: ServerNode[][]; updates: { values: Record<string, TagValue>; running: boolean }[]; stopped: number } = { defined: [], updates: [], stopped: 0 }
  let write: ((e: { name: string; value: unknown }) => void) | null = null
  let clients: ((e: { clients: string[] }) => void) | null = null
  const host: OpcUaServerHost = {
    start: async ({ port }) => (startError ? { error: startError, endpoint: '' } : { error: '', endpoint: `opc.tcp://127.0.0.1:${port}` }),
    define: async ({ nodes }) => {
      calls.defined.push(nodes)
      return { error: '' }
    },
    update: (u) => calls.updates.push(u),
    stop: async () => {
      calls.stopped++
    },
    onWrite: (cb) => {
      write = cb
      return () => (write = null)
    },
    onClients: (cb) => {
      clients = cb
      return () => (clients = null)
    },
  }
  return { host, calls, write: (name: string, value: unknown) => write?.({ name, value }), clients: (c: string[]) => clients?.({ clients: c }) }
}

const NODES: ServerNode[] = [
  { name: 'Start', builtin: 1, writable: true, value: false },
  { name: 'Eye', builtin: 1, writable: false, value: false },
  { name: 'Speed', builtin: 10, writable: true, value: 1.5 },
]

describe('OpcUaServerSession', () => {
  it('publishes what it was given before the port opened, once it has', async () => {
    const h = fakeHost()
    const s = new OpcUaServerSession(h.host, { port: 4843, network: false }, () => {}, () => {})
    s.publish(NODES)
    await s.start()
    expect(h.calls.defined).toEqual([NODES])
    expect(s.status()).toMatchObject({ state: 'serving', endpoint: 'opc.tcp://127.0.0.1:4843', variables: 3, writable: 2, live: false })
  })

  it('sends only what changed, and the moment the values go live or out of service', async () => {
    const h = fakeHost()
    const s = new OpcUaServerSession(h.host, { port: 4843, network: false }, () => {}, () => {})
    await s.start()
    s.publish(NODES)
    await Promise.resolve()
    s.update({ Start: false, Eye: true, Speed: 1.5, Other: 1 }, true)
    expect(h.calls.updates).toEqual([{ values: { Eye: true }, running: true }])
    const same = { Start: false, Eye: true, Speed: 1.5 }
    s.update(same, true)
    s.update(same, true)
    expect(h.calls.updates).toHaveLength(1) // nothing new, then the same watch object: neither crosses to the shell
    s.update(null, false)
    expect(h.calls.updates.at(-1)).toEqual({ values: {}, running: false })
  })

  it("hands a client's write to the program only while live, and only to a writable variable of the right kind", async () => {
    const h = fakeHost()
    const written: Record<string, TagValue>[] = []
    const s = new OpcUaServerSession(h.host, { port: 4843, network: false }, (v) => written.push(v), () => {})
    await s.start()
    s.publish(NODES)
    await Promise.resolve()
    h.write('Start', true)
    expect(written).toEqual([]) // stopped: the shell refuses it too
    s.update({}, true)
    h.write('Start', true)
    h.write('Eye', true) // read-only
    h.write('Speed', 'fast') // not a number
    h.write('Nope', 1)
    h.write('Speed', 3)
    expect(written).toEqual([{ Start: true }, { Speed: 3 }])
    expect(s.status().lastWrite).toBe('Speed := 3')
    // the program confirming the write sends nothing back
    s.update({ Start: true, Eye: false, Speed: 3 }, true)
    expect(h.calls.updates.at(-1)).toEqual({ values: {}, running: true })
  })

  it('names its clients, says why it could not start, and lets go of the port on stop', async () => {
    const h = fakeHost()
    const s = new OpcUaServerSession(h.host, { port: 4843, network: false }, () => {}, () => {})
    await s.start()
    h.clients(['SCADA Client (127.0.0.1)'])
    expect(serverStatusLine(s.status(), false)).toBe(
      'Serving opc.tcp://127.0.0.1:4843: 1 connected (SCADA Client (127.0.0.1)), no variables yet (they are published when the program compiles). Stopped: they read as out of service until Play.',
    )
    await s.stop()
    expect(h.calls.stopped).toBe(1)
    expect(s.status().state).toBe('off')

    const taken = fakeHost('port 4843 is already in use on this machine')
    const f = new OpcUaServerSession(taken.host, { port: 4843, network: false }, () => {}, () => {})
    await f.start()
    expect(serverStatusLine(f.status(), false)).toBe('Could not start the server: port 4843 is already in use on this machine')
  })

  it('says what to try next while no client has connected, and nothing once one has', async () => {
    const local = fakeHost()
    const s = new OpcUaServerSession(local.host, { port: 4843, network: false }, () => {}, () => {})
    await s.start()
    expect(serverStatusHint(s.status())).toBe('Only a client on this computer can connect. For a SCADA or HMI elsewhere on the network, tick Reachable from the network.')
    local.clients(['SCADA Client (127.0.0.1)'])
    expect(serverStatusHint(s.status())).toBeNull()

    const status = { ...s.status(), clients: [], endpoint: 'opc.tcp://BENCH-PC:4843' }
    expect(serverStatusHint(status)).toBe(
      "In the client, connect to opc.tcp://BENCH-PC:4843 with security policy None and an anonymous login, and allow port 4843 inbound in this computer's firewall.",
    )

    const taken = new OpcUaServerSession(fakeHost('port 4843 is already in use on this machine').host, { port: 4843, network: false }, () => {}, () => {})
    await taken.start()
    expect(serverStatusHint(taken.status())).toMatch(/^Another program on this computer holds that port/)
  })
})
