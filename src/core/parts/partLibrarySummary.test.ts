import { describe, expect, it } from 'vitest'
import { partFingerprint } from './partOrigin'
import type { PartPackage } from './partPackage'
import { describeLibraryEntry, summarizeLibrary } from './partLibrarySummary'

// only identity matters here: the fingerprint hashes whatever the package holds
const pkg = (id: string, extra: Partial<PartPackage> = {}): PartPackage => ({ id, name: id, ...extra }) as PartPackage

describe('summarizeLibrary', () => {
  const builtIn = pkg('oip.diverter', { description: 'v2' } as Partial<PartPackage>)
  const builtInOf = (id: string) => (id === builtIn.id ? builtIn : undefined)

  it('names a stamped copy of a built-in a built-in copy, with its version and status', () => {
    const copy = { ...builtIn, origin: { app: partFingerprint(builtIn) } }
    const [e] = summarizeLibrary([copy], builtInOf)
    expect(e).toEqual({ kind: 'builtInCopy', id: 'oip.diverter', version: partFingerprint(builtIn), status: 'upToDate' })
    expect(describeLibraryEntry(e!)).toBe(`oip.diverter (version ${partFingerprint(builtIn)}, same as this app ships)`)
  })

  it('says when the app ships a newer version than the copy was made from', () => {
    const old = pkg('oip.diverter', { description: 'v1' } as Partial<PartPackage>)
    const copy = { ...old, origin: { app: partFingerprint(old) } }
    expect(summarizeLibrary([copy], builtInOf)[0]).toMatchObject({ kind: 'builtInCopy', status: 'updateAvailable' })
  })

  it('keeps "authored" for a custom part, and calls a variant of a built-in authored, made from its base', () => {
    const custom = pkg('acme.sorter')
    const variant = pkg('acme.heavy-diverter', { origin: { app: partFingerprint(builtIn), appPart: 'oip.diverter' } })
    expect(summarizeLibrary([custom, variant], builtInOf)).toEqual([
      { kind: 'authored', id: 'acme.sorter' },
      { kind: 'authored', id: 'acme.heavy-diverter', madeFrom: 'oip.diverter' },
    ])
    expect(describeLibraryEntry({ kind: 'authored', id: 'acme.heavy-diverter', madeFrom: 'oip.diverter' })).toBe('acme.heavy-diverter (made from oip.diverter)')
  })

  it('counts a stamped copy this app does not ship, and an unstamped copy under a built-in id, as built-in copies', () => {
    const gone = pkg('oip.retired', { origin: { app: '1:abc' } })
    const unstamped = pkg('oip.diverter')
    const [a, b] = summarizeLibrary([gone, unstamped], builtInOf)
    expect(a).toEqual({ kind: 'builtInCopy', id: 'oip.retired', version: '1:abc', status: 'notInThisApp' })
    expect(b).toMatchObject({ kind: 'builtInCopy', id: 'oip.diverter', status: 'sameIdDifferentPart' })
    expect(describeLibraryEntry(b!)).toContain('version not recorded')
  })
})
