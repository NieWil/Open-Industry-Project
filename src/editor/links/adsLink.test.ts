import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdsPoint } from '../../core/io/ads'
import { ExternalPlcAdsSession } from './adsLink'
import { adsLink, CLIENT_POLL_MS, CLIENT_RETRY_MS, statusLine } from './externalPlc'
import type { AdsHost } from './externalPlc'
import { DEFAULT_EXTERNAL_PLC } from '../store/storePrefs'

// The session the dock runs against a TwinCAT runtime, through a fake of the shell's ADS calls (apps/desktop/adsIo.cjs)
// with a PLC behind it: MAIN.Eye (BOOL) and MAIN.Run (BOOL), and the scan `Run := NOT Eye` on every write.

interface Symbol {
  adsType: number
  size: number
  typeName: string
  value: boolean | number
}

function runtime() {
  const symbols = new Map<string, Symbol>([
    ['main.eye', { adsType: 33, size: 0, typeName: 'BOOL', value: false }],
    ['main.run', { adsType: 33, size: 1, typeName: 'BOOL', value: true }],
    ['main.speed', { adsType: 4, size: 4, typeName: 'REAL', value: 0.5 }],
  ])
  /** `down`: every request answers this code (0 = up). `downloaded`: the next exchange answers 0x711 once. */
  const ctl = { down: 0, downloaded: false, opens: 0, binds: 0, closed: 0, openError: '' }
  const host: AdsHost = {
    open: async () => {
      ctl.opens++
      return ctl.openError ? { error: ctl.openError } : { error: '', localNetId: '10.0.0.5.1.1', target: '10.0.0.5.1.1:851' }
    },
    bind: async ({ tags }) => {
      ctl.binds++
      return {
        error: '',
        tags: tags.map((t) => {
          if (ctl.down) return { code: ctl.down }
          const s = symbols.get(t.name.toLowerCase())
          return s ? { code: 0, adsType: s.adsType, size: s.size, typeName: s.typeName } : { code: 0x710 }
        }),
      }
    },
    exchange: async ({ writes, reads }) => {
      if (ctl.down) return { error: '', writes: writes.map(() => ctl.down), reads: reads.map(() => ({ value: null, status: ctl.down })) }
      if (ctl.downloaded) {
        ctl.downloaded = false
        return { error: '', writes: writes.map(() => 0x711), reads: reads.map(() => ({ value: null, status: 0x711 })) }
      }
      for (const w of writes) symbols.get(w.name.toLowerCase())!.value = w.value
      symbols.get('main.run')!.value = !symbols.get('main.eye')!.value
      return { error: '', writes: writes.map(() => 0), reads: reads.map((r) => ({ value: symbols.get(r.toLowerCase())!.value, status: 0 })) }
    },
    close: async () => {
      ctl.closed++
    },
  }
  return { host, ctl, symbols }
}

const POINTS: AdsPoint[] = [
  { tag: 'MAIN.Eye', dir: 'toPlc', type: 'BOOL' },
  { tag: 'MAIN.Run', dir: 'fromPlc', type: 'BOOL' },
]

describe('an ADS session with a TwinCAT runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("asks for each symbol once, then writes the scene's inputs and reads the program's outputs", async () => {
    const plc = runtime()
    const session = new ExternalPlcAdsSession(plc.host, '', 851, POINTS, [], () => {})
    await session.start({ 'MAIN.Eye': false })
    expect(session.exchange({ 'MAIN.Eye': false })).toEqual({ 'MAIN.Run': true })
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({ 'MAIN.Eye': true })).toBeNull()
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS * 2)
    expect(session.exchange({ 'MAIN.Eye': true })).toEqual({ 'MAIN.Run': false })
    expect(plc.ctl.binds).toBe(1)
    expect(session.status()).toMatchObject({ mode: 'ads', state: 'polling', endpoint: "this PC's TwinCAT runtime, AMS port 851", error: null })
    expect(session.status().points).toEqual(['MAIN.Eye  written to the PLC  BOOL', 'MAIN.Run  read from the PLC  BOOL'])
  })

  it('names a missing symbol and a type the parts cannot carry, and carries the rest', async () => {
    const plc = runtime()
    const points: AdsPoint[] = [...POINTS, { tag: 'MAIN.Nope', dir: 'fromPlc', type: 'BOOL' }, { tag: 'MAIN.Speed', dir: 'fromPlc', type: 'BOOL' }]
    const session = new ExternalPlcAdsSession(plc.host, '', 851, points, [], () => {})
    await session.start({})
    expect(session.status().problems).toEqual(['the PLC has no symbol named MAIN.Nope (0x710)', 'MAIN.Speed: the parts carry a bit, and the PLC holds it as REAL'])
    expect(session.status().state).toBe('polling')
  })

  it('says what to do when the runtime cannot be reached, with this PC\'s Net ID where a route is the cure', async () => {
    const plc = runtime()
    plc.ctl.down = 0x7
    const session = new ExternalPlcAdsSession(plc.host, '192.168.1.20.1.1', 851, POINTS, [], () => {})
    await session.start({})
    expect(session.status()).toMatchObject({
      state: 'starting',
      error: "target machine not found: add a route to this PC on the PLC, or check its AMS Net ID (0x7). This PC's AMS Net ID is 10.0.0.5.1.1",
    })
    plc.ctl.down = 0
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS)
    expect(session.status()).toMatchObject({ state: 'polling', error: null })
  })

  it('drives the outputs off when the PLC goes away, and takes them back when it returns', async () => {
    const plc = runtime()
    const session = new ExternalPlcAdsSession(plc.host, '', 851, POINTS, [], () => {})
    await session.start({ 'MAIN.Eye': false })
    expect(session.exchange({})).toEqual({ 'MAIN.Run': true })
    plc.ctl.down = 0x12 // the runtime went to Config mode
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS)
    expect(session.exchange({})).toEqual({ 'MAIN.Run': false })
    expect(session.status()).toMatchObject({ stale: true, error: expect.stringMatching(/the PLC stopped answering: the port is disabled/) })
    plc.ctl.down = 0
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS + CLIENT_POLL_MS * 2)
    expect(session.exchange({})).toEqual({ 'MAIN.Run': true })
    expect(session.status().stale).toBe(false)
  })

  it('binds anew at once when the PLC was downloaded again, which is not a fault', async () => {
    const plc = runtime()
    const session = new ExternalPlcAdsSession(plc.host, '', 851, POINTS, [], () => {})
    await session.start({})
    plc.ctl.downloaded = true
    await vi.advanceTimersByTimeAsync(CLIENT_POLL_MS * 3)
    expect(plc.ctl.binds).toBe(2)
    expect(session.status()).toMatchObject({ state: 'polling', error: null, stale: false })
    expect(session.status().problems).toEqual([])
  })

  it('stops for good when there is no TwinCAT to open a port on', async () => {
    const plc = runtime()
    plc.ctl.openError = "ADS needs TwinCAT's router on this PC, and TwinCAT is not installed"
    const session = new ExternalPlcAdsSession(plc.host, '', 851, POINTS, [], () => {})
    await session.start({})
    await vi.advanceTimersByTimeAsync(CLIENT_RETRY_MS * 3)
    expect(plc.ctl.opens).toBe(1)
    expect(session.status()).toMatchObject({ state: 'failed', error: expect.stringMatching(/TwinCAT is not installed/) })
    expect(statusLine(session.status(), true, DEFAULT_EXTERNAL_PLC)).toMatch(/^Could not connect: ADS needs TwinCAT's router/)
  })

  it('loads on Play, knowing what the PLC drives before its code has loaded', async () => {
    const plc = runtime()
    const link = adsLink(plc.host, '', 851, POINTS, [], () => {})
    expect(link.driven).toEqual(['MAIN.Run'])
    expect(link.status()).toMatchObject({ mode: 'ads', state: 'starting', points: ['MAIN.Eye  written to the PLC  BOOL', 'MAIN.Run  read from the PLC  BOOL'] })
    await link.start({ 'MAIN.Eye': true })
    expect(link.exchange({})).toEqual({ 'MAIN.Run': false })
    await link.stop()
    expect(plc.ctl.closed).toBe(1)
    expect(link.status().state).toBe('off')
  })

  it('reads as a sentence in the dock before Play', () => {
    expect(statusLine({ ...adsLink(runtime().host, '', 851, POINTS, [], () => {}).status() }, false, { ...DEFAULT_EXTERNAL_PLC, mode: 'ads' })).toBe(
      "Press Play to connect to this PC's TwinCAT runtime, AMS port 851 over ADS; the program here is not run while the PLC is.",
    )
  })
})
