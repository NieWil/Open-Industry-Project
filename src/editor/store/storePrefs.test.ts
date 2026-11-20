import { afterEach, describe, expect, it, vi } from 'vitest'
import { readShowStats, SHOWSTATS_KEY } from './storePrefs'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** minimal localStorage stand-in - only the getItem readShowStats uses */
function withPref(value: string | null) {
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === SHOWSTATS_KEY ? value : null) })
}

describe('readShowStats', () => {
  it('reads the persisted pref when no URL override is present', () => {
    vi.stubGlobal('location', { search: '' })
    withPref('true')
    expect(readShowStats()).toBe(true)
    withPref(null)
    expect(readShowStats()).toBe(false)
  })

  // The phone case: no ViewportToolbar means no toggle, so `?stats` is the only way to reach the
  // overlay - and its backend badge is the only in-app proof of WebGPU vs WebGL there.
  it('?stats forces the overlay on over a persisted off', () => {
    withPref(null)
    for (const search of ['?stats', '?stats=1', '?scene=demo&stats']) {
      vi.stubGlobal('location', { search })
      expect(readShowStats()).toBe(true)
    }
  })

  it('?stats=0|false|off forces it back off over a persisted on', () => {
    withPref('true')
    for (const search of ['?stats=0', '?stats=false', '?stats=off']) {
      vi.stubGlobal('location', { search })
      expect(readShowStats()).toBe(false)
    }
  })

  it('defaults off with neither location nor localStorage (non-DOM host)', () => {
    vi.stubGlobal('location', undefined)
    vi.stubGlobal('localStorage', undefined)
    expect(readShowStats()).toBe(false)
  })
})

describe('the named controllers', () => {
  it('keeps each valid one once, with every link field checked', async () => {
    const { sanitizeExternalPlc } = await import('./storePrefs')
    const s = sanitizeExternalPlc({
      controllers: [
        { name: 'Cell2', enabled: true, mode: 's7', s7Host: '10.0.0.7' },
        { name: 'Cell2', enabled: true, mode: 'poll' },
        { name: '2nd', enabled: true },
        { name: 'Cell3', port: 70000, uaServer: true },
        'garbage',
      ],
    })
    expect(s.controllers.map((c) => [c.name, c.enabled, c.mode])).toEqual([
      ['Cell2', true, 's7'],
      ['Cell3', false, 'serve'],
    ])
    expect(s.controllers[0]!.s7Host).toBe('10.0.0.7')
    expect(s.controllers[1]!.port).toBe(5020)
    // each controller's own OPC UA server, its port defaulting past the default controller's
    expect(s.controllers[1]).toMatchObject({ uaServer: true, uaServerPort: 4845, uaServerNetwork: false })
  })

  it('names a link that shares a serving port', async () => {
    const { DEFAULT_EXTERNAL_PLC, servePortClash, sanitizeExternalPlc } = await import('./storePrefs')
    const two = [
      { ...DEFAULT_EXTERNAL_PLC, name: 'A', enabled: true, port: 5021 },
      { ...DEFAULT_EXTERNAL_PLC, name: 'B', enabled: true, port: 5022 },
    ]
    const s = sanitizeExternalPlc({ enabled: true, mode: 'serve', port: 5022, controllers: two })
    expect(servePortClash(s, 'B')).toBe('')
    expect(servePortClash(s, null)).toBe('B')
    expect(servePortClash(s, 'A')).toBeNull()
    // a link that does not serve listens on no port
    expect(servePortClash({ ...s, mode: 'poll' }, 'B')).toBeNull()
  })
})


describe('OPC UA browse start points', () => {
  it('keeps the start points that read as a path or a NodeId, for each link on its own', async () => {
    const { sanitizeExternalPlc } = await import('./storePrefs')
    expect(sanitizeExternalPlc({}).opcUaBrowseFrom).toEqual([])
    const s = sanitizeExternalPlc({
      opcUaBrowseFrom: ['DeviceSet.PLC.Programs', 'Main..Eye', 7, 'ns=4;s=GVL'],
      controllers: [{ name: 'Cell2', opcUaBrowseFrom: ['Cnc'] }],
    })
    expect(s.opcUaBrowseFrom).toEqual(['DeviceSet.PLC.Programs', 'ns=4;s=GVL'])
    expect(s.controllers[0]!.opcUaBrowseFrom).toEqual(['Cnc'])
    expect(sanitizeExternalPlc({ opcUaBrowseFrom: 'Programs' }).opcUaBrowseFrom).toEqual([])
  })
})
