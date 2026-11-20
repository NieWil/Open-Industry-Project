import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { MAX_SCENE_PLCS } from '../../core/scene/scenePlcs'
import type { AdsHost, EipHost, OpcUaHost } from './externalPlcStatus'
import { BROWSE_LINK } from './linkHosts'
import { canList, readPlcVariables } from './plcVariables'

const shell = createRequire(import.meta.url)('../../../apps/desktop/linkKeys.cjs') as {
  MAX_LINKS: number
  BROWSE_LINK: number
  linkNo(opts: { link?: number }): number | null
  listingLinkNo(opts: { link?: number }): number | null
}

function ads(answer: Awaited<ReturnType<NonNullable<AdsHost['symbols']>>>, calls: string[], open: Awaited<ReturnType<AdsHost['open']>> = { error: '' }): AdsHost {
  return {
    open: async (o) => (calls.push(`open ${o.netId}:${o.port} link ${o.link}`), open),
    bind: async () => ({ error: '' }),
    exchange: async () => ({ error: '' }),
    symbols: async (o) => (calls.push(`symbols link ${o?.link}`), answer),
    close: async (o) => void calls.push(`close link ${o?.link}`),
  }
}

function eip(calls: string[]): EipHost {
  return {
    open: async (o) => (calls.push(`open ${o.gateway} link ${o.link}`), { error: '' }),
    bind: async () => ({ error: '' }),
    exchange: async () => ({ error: '' }),
    tags: async (o) => (calls.push(`tags link ${o?.link}`), { error: '', status: 'ok', tags: [{ name: 'Program:Main.Eye', type: 0xc1 }] }),
    close: async (o) => void calls.push(`close link ${o?.link}`),
  }
}

function opcUa(calls: string[]): OpcUaHost {
  return {
    connect: async (o: { endpoint: string; link?: number }) => (calls.push(`connect ${o.endpoint} link ${o.link}`), { error: '' }),
    browse: async (o: { link?: number }) => (calls.push(`browse link ${o.link}`), { error: '', variables: [{ path: ['PLC', 'Eye'], nodeId: 'ns=4;s=Eye' }] }),
    describe: async () => ({ error: '' }),
    exchange: async () => ({ error: '' }),
    close: async (o?: { link?: number }) => void calls.push(`close link ${o?.link}`),
    onClosed: () => () => {},
  } as unknown as OpcUaHost
}

const none = { adsHost: null, eipHost: null, opcUaHost: null }

describe('the link the PLC connections window reads on', () => {
  it('is past every controller, the same number in the shell, which takes it only for a protocol that lists variables', () => {
    expect(shell.MAX_LINKS).toBe(MAX_SCENE_PLCS)
    expect(shell.BROWSE_LINK).toBe(BROWSE_LINK)
    expect(shell.linkNo({ link: BROWSE_LINK })).toBeNull()
    expect(shell.listingLinkNo({ link: BROWSE_LINK })).toBe(BROWSE_LINK)
  })
})

describe("reading a PLC's variables for the PLC connections window", () => {
  it('reads a TwinCAT runtime on its own link, grouped, and closes it', async () => {
    const calls: string[] = []
    const list = await readPlcVariables({ ...none, adsHost: ads({ error: '', code: 0, symbols: [{ name: 'MAIN.Extend', adsType: 33, size: 1, typeName: 'BOOL' }] }, calls) }, { kind: 'ads', netId: '5.1.2.3.1.1', port: 851 })
    expect(list).toMatchObject({ state: 'ready', groups: [{ name: 'MAIN', variables: [{ name: 'MAIN.Extend', short: 'Extend', typeName: 'BOOL', kind: 'bool' }] }] })
    expect(calls).toEqual([`open 5.1.2.3.1.1:851 link ${BROWSE_LINK}`, `symbols link ${BROWSE_LINK}`, `close link ${BROWSE_LINK}`])
  })

  it('says why a TwinCAT runtime refused, naming this PC where a route is missing, and still closes', async () => {
    const calls: string[] = []
    const list = await readPlcVariables({ ...none, adsHost: ads({ error: '', code: 0x7 }, calls, { error: '', localNetId: '10.0.0.5.1.1' }) }, { kind: 'ads', netId: '5.1.2.3.1.1', port: 851 })
    expect(list.state).toBe('failed')
    expect(list.error).toMatch(/This PC's AMS Net ID is 10\.0\.0\.5\.1\.1$/)
    expect(calls.at(-1)).toBe(`close link ${BROWSE_LINK}`)
  })

  it('reads a Logix controller and an OPC UA server the same way', async () => {
    const calls: string[] = []
    const logix = await readPlcVariables({ ...none, eipHost: eip(calls) }, { kind: 'eip', gateway: '10.0.0.9', path: '1,0', family: 'logix' })
    expect(logix.groups.map((g) => g.name)).toEqual(['Program:Main'])
    const ua = await readPlcVariables({ ...none, opcUaHost: opcUa(calls) }, { kind: 'opcua', endpoint: 'opc.tcp://plc:4840', from: [] })
    expect(ua.groups).toEqual([{ name: 'PLC', variables: [{ name: 'Eye', short: 'Eye', typeName: '', kind: null }] }])
    expect(calls).toEqual([
      `open 10.0.0.9 link ${BROWSE_LINK}`,
      `tags link ${BROWSE_LINK}`,
      `close link ${BROWSE_LINK}`,
      `connect opc.tcp://plc:4840 link ${BROWSE_LINK}`,
      `browse link ${BROWSE_LINK}`,
      `close link ${BROWSE_LINK}`,
    ])
  })

  it('runs one read at a time, so a second read never shares the first one\'s link', async () => {
    const calls: string[] = []
    const host = { ...none, adsHost: ads({ error: '', code: 0, symbols: [] }, calls) }
    await Promise.all([readPlcVariables(host, { kind: 'ads', netId: 'a', port: 851 }), readPlcVariables(host, { kind: 'ads', netId: 'b', port: 852 })])
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['open', 'symbols', 'close', 'open', 'symbols', 'close'])
    expect(calls[0]).toMatch(/^open a:851/)
  })

  it('knows which sources this app can read: the program always, a PLC with its protocol\'s listing host', () => {
    expect(canList(none, { kind: 'program' })).toBe(true)
    expect(canList(none, { kind: 'ads', netId: '', port: 851 })).toBe(false)
    const old = ads({ error: '' }, [])
    delete old.symbols
    expect(canList({ ...none, adsHost: old }, { kind: 'ads', netId: '', port: 851 })).toBe(false)
    expect(canList({ ...none, eipHost: eip([]) }, { kind: 'eip', gateway: 'x', path: '', family: 'logix' })).toBe(true)
  })
})
