import { afterEach, describe, expect, it, vi } from 'vitest'
import { tellAboutLegacyParts } from './packageSource'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }
}

afterEach(() => vi.unstubAllGlobals())

describe('tellAboutLegacyParts', () => {
  it('says once where the parts in the old profile-wide folder went, naming them and the way back', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const notices: [string, string][] = []
    const store = { showSaveNotice: (t: string, m: string) => void notices.push([t, m]) }
    tellAboutLegacyParts(store, 'C:/p/custom-parts', ['Belt', 'Arm', 'Lift', 'Stop'])
    expect(notices).toHaveLength(1)
    expect(notices[0]![1]).toContain('4 parts in C:/p/custom-parts (Belt, Arm, Lift and 1 more) are no longer loaded')
    expect(notices[0]![1]).toContain('Import part in the Parts panel')
    expect(notices[0]![1]).not.toMatch(/\u2014/) // UI text uses hyphens, never an em dash
    tellAboutLegacyParts(store, 'C:/p/custom-parts', ['Belt'])
    expect(notices).toHaveLength(1) // once per profile
  })

  it('says nothing when the folder is empty, and never repeats without storage', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const notices: unknown[] = []
    const store = { showSaveNotice: () => void notices.push(1) }
    tellAboutLegacyParts(store, 'C:/p/custom-parts', [])
    expect(notices).toHaveLength(0)
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    tellAboutLegacyParts(store, 'C:/p/custom-parts', ['Belt'])
    expect(notices).toHaveLength(0)
  })
})
