import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addedLibraryUrls, libraryUrls, OFFICIAL_PART_LIBRARIES, setLibraryUrls, setOfficialLibraryOn } from './partLibraryUrls'

const STRUCTURE = 'https://parts.openindustryproject.org/oip.structure/index.json'
const MOTION = 'https://parts.openindustryproject.org/oip.motion/index.json'
const TEAM = 'https://parts.acme.example/acme.lines/index.json'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('libraryUrls', () => {
  it('reads a ?library= link alone, for the session', () => {
    expect(libraryUrls(`?library=${encodeURIComponent(TEAM)}&library=javascript:alert(1)`, [STRUCTURE])).toEqual([TEAM])
  })

  it("reads the official libraries left on, then the viewer's own", () => {
    setLibraryUrls([TEAM, TEAM])
    expect(addedLibraryUrls()).toEqual([TEAM])
    expect(libraryUrls('', [STRUCTURE, MOTION])).toEqual([STRUCTURE, MOTION, TEAM])
    setOfficialLibraryOn(MOTION, false)
    expect(libraryUrls('', [STRUCTURE, MOTION])).toEqual([STRUCTURE, TEAM])
    setOfficialLibraryOn(MOTION, true)
    expect(libraryUrls('', [STRUCTURE, MOTION])).toEqual([STRUCTURE, MOTION, TEAM])
  })

  it('is empty with nothing configured, so the Catalog shows no Libraries tab', () => {
    expect(libraryUrls('', [])).toEqual([])
  })

  it('names only https libraries as official (the build carries them; nothing is fetched for the list)', () => {
    expect(OFFICIAL_PART_LIBRARIES.every((u) => u.startsWith('https://'))).toBe(true)
  })
})
