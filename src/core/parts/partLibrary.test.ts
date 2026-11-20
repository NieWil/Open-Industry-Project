import { describe, expect, it } from 'vitest'
import { oippartBytesToFolder, partToOippartBytes } from './partArchive'
import { asLibraryCopy, checkLibraryAppend, checkLibraryDownload, isFirstPartyLibrary, libraryCredit, libraryStatus, libraryUrl, offeredVersion, validateLibraryIndex } from './partLibrary'
import type { LibraryPart, LibraryVersion, PartLibraryIndex } from './partLibrary'
import { partFingerprint } from './partOrigin'
import { PACKAGE_FORMAT, type PartPackage } from './partPackage'
import { validatePartPackage } from './partValidate'
import { sha256HexOfBytes } from '../sha256'

function pkg(id: string, behavior = 'definePart({step(){}})'): PartPackage {
  return { format: PACKAGE_FORMAT, id, name: id, params: {}, behavior, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [] } }
}

function version(part: PartPackage, over: Partial<LibraryVersion> = {}): LibraryVersion {
  return { file: `${part.id}/a.oippart`, sha256: 'a'.repeat(64), fingerprint: partFingerprint(part), sdk: 1, published: '2026-10-17', ...over }
}

function index(parts: unknown[] = []): Record<string, unknown> {
  return { format: 1, id: 'oip.structure', name: 'Structure', licence: { code: 'MIT', assets: 'CC-BY-4.0' }, parts }
}

const PLATFORM = pkg('oip.platform')

describe('validateLibraryIndex', () => {
  it('accepts a well-formed index', () => {
    const r = validateLibraryIndex(index([{ id: 'oip.platform', name: 'Platform', versions: [version(PLATFORM)] }]))
    expect('index' in r && r.index.parts[0]!.id).toBe('oip.platform')
  })

  it('refuses an index made for a newer app by name', () => {
    const r = validateLibraryIndex({ ...index(), format: 2 })
    expect('problems' in r && r.problems[0]).toMatch(/newer version of the app/)
  })

  it.each([
    ['an absolute URL', 'https://elsewhere.example/x.oippart'],
    ['a protocol-relative URL', '//elsewhere.example/x.oippart'],
    ['a rooted path', '/x.oippart'],
    ['a parent step', '../x.oippart'],
    ['a backslash', 'a\\x.oippart'],
    ['a query', 'x.oippart?y'],
    ['another kind of file', 'x.js'],
  ])('refuses a file named by %s, so a library only sends the app to its own host', (_what, file) => {
    const r = validateLibraryIndex(index([{ id: 'oip.platform', name: 'Platform', versions: [version(PLATFORM, { file })] }]))
    expect('problems' in r && r.problems.join(' ')).toMatch(/\.file must be a \.oippart path inside the library/)
  })

  it('takes a picture inside the library, and refuses any other kind of file or place', () => {
    const withThumb = (thumbnail: string) => validateLibraryIndex(index([{ id: 'oip.platform', name: 'Platform', versions: [version(PLATFORM, { thumbnail })] }]))
    expect('index' in withThumb('oip.platform/abc.webp')).toBe(true)
    for (const bad of ['https://elsewhere.example/x.webp', '../x.webp', 'oip.platform/x.svg', 'oip.platform/x.js']) {
      const r = withThumb(bad)
      expect('problems' in r && r.problems.join(' '), bad).toMatch(/thumbnail must be/)
    }
  })

  it('reports every problem, not only the first', () => {
    const r = validateLibraryIndex(
      index([
        { id: 'oip.platform', name: 'Platform', versions: [version(PLATFORM, { sha256: 'XYZ', sdk: 0 })] },
        { id: 'oip.platform', name: '', versions: [] },
      ]),
    )
    const all = 'problems' in r ? r.problems.join('\n') : ''
    expect(all).toMatch(/sha256/)
    expect(all).toMatch(/\.sdk/)
    expect(all).toMatch(/listed twice/)
  })
})

describe('offeredVersion', () => {
  const part = (...sdks: number[]): LibraryPart => ({ id: 'oip.platform', name: 'Platform', versions: sdks.map((sdk, i) => version(PLATFORM, { sdk, file: `v${i}.oippart` })) })

  it('offers the newest version this build can run', () => {
    expect(offeredVersion(part(1, 1, 2), 2).version?.file).toBe('v2.oippart')
    expect(offeredVersion(part(1, 1, 2), 2).newer).toBeUndefined()
  })

  it('falls back to an older version and names the newer one when this build is too old for it', () => {
    const r = offeredVersion(part(1, 2, 3), 1)
    expect(r.version?.file).toBe('v0.oippart')
    expect(r.newer?.file).toBe('v2.oippart')
  })

  it('offers nothing to install when every version needs a newer app', () => {
    const r = offeredVersion(part(3), 1)
    expect(r.version).toBeUndefined()
    expect(r.newer?.sdk).toBe(3)
  })
})

describe('libraryStatus', () => {
  const v1 = pkg('oip.platform', 'definePart({step(){}})')
  const v2 = pkg('oip.platform', 'definePart({step(){ /* v2 */ }})')

  it('reads the four statuses from the listed fingerprint, without the part itself', () => {
    const copy = asLibraryCopy(v1)
    expect(libraryStatus(undefined, version(v1))).toBe('notInProject')
    expect(libraryStatus(copy, version(v1))).toBe('upToDate')
    expect(libraryStatus(copy, version(v2))).toBe('updateAvailable')
    const edited = { ...copy, behavior: 'definePart({step(){ /* ours */ }})' }
    expect(libraryStatus(edited, version(v1))).toBe('editedHere')
    expect(libraryStatus(edited, version(v2))).toBe('changedInBoth')
  })

  it('tells a different part of the same id from a copy it never recorded', () => {
    expect(libraryStatus(v1, version(v1))).toBe('upToDate')
    expect(libraryStatus(v1, version(v2))).toBe('sameIdDifferentPart')
  })

  it("reads a copy of the app's built-in as made from a first-party library, so a moved part's updates reach it", () => {
    const fromApp = { ...v1, origin: { app: partFingerprint(v1) } }
    expect(libraryStatus(fromApp, version(v2), true)).toBe('updateAvailable')
    expect(libraryStatus({ ...fromApp, behavior: 'definePart({step(){ /* ours */ }})' }, version(v2), true)).toBe('changedInBoth')
    // another publisher's library never claims the app's records
    expect(libraryStatus(fromApp, version(v2), false)).toBe('sameIdDifferentPart')
  })

  it('counts a library as first-party only when the project publishes it, not because its id says oip.*', () => {
    const official = 'https://parts.openindustryproject.org/oip.structure/index.json'
    expect(isFirstPartyLibrary({ id: 'oip.structure' }, official)).toBe(true)
    // anyone can name an index oip.* and share a link to it
    expect(isFirstPartyLibrary({ id: 'oip.structure' }, 'https://parts.example/oip.structure/index.json')).toBe(false)
    expect(isFirstPartyLibrary({ id: 'oip.structure' }, 'http://parts.openindustryproject.org/oip.structure/index.json')).toBe(false)
    expect(isFirstPartyLibrary({ id: 'acme.lines' }, official)).toBe(false)
    // loopback over http only where the host list names it (the editor's dev build)
    expect(isFirstPartyLibrary({ id: 'oip.structure' }, 'http://127.0.0.1:8080/oip.structure/index.json')).toBe(false)
    expect(isFirstPartyLibrary({ id: 'oip.structure' }, 'http://127.0.0.1:8080/oip.structure/index.json', ['127.0.0.1'])).toBe(true)
    expect(isFirstPartyLibrary({ id: 'oip.structure' }, 'not a url')).toBe(false)
  })

  it('keeps a record from another source when stamping a library copy', () => {
    const fromApp = { ...v1, origin: { app: 'v2:x' } }
    expect(asLibraryCopy(fromApp).origin).toEqual({ app: 'v2:x', library: partFingerprint(v1) })
  })
})

describe('checkLibraryDownload', () => {
  const bytes = new TextEncoder().encode('a part file')
  const listed = version(PLATFORM, { sha256: sha256HexOfBytes(bytes) })

  it('accepts the listed file and part', () => {
    expect(checkLibraryDownload(listed, 'oip.platform', bytes, PLATFORM)).toBe('')
  })

  it('refuses other bytes, another id or another version of the part', () => {
    expect(checkLibraryDownload(listed, 'oip.platform', new TextEncoder().encode('tampered'), PLATFORM)).toMatch(/hash differs/)
    expect(checkLibraryDownload(listed, 'oip.platform', bytes, pkg('oip.stairs'))).toMatch(/holds "oip.stairs"/)
    expect(checkLibraryDownload(listed, 'oip.platform', bytes, pkg('oip.platform', 'definePart({step(){ /* other */ }})'))).toMatch(/fingerprint differs/)
  })
})

describe('libraryUrl', () => {
  it('resolves a listed path against the index URL', () => {
    expect(libraryUrl('https://parts.openindustryproject.org/oip.structure/index.json', 'oip.platform/a.oippart')).toBe(
      'https://parts.openindustryproject.org/oip.structure/oip.platform/a.oippart',
    )
  })
})

describe('the credit a library copy keeps', () => {
  it('names the listed publisher, the project for its own libraries, or only the library', () => {
    expect(libraryCredit({ name: 'Community' }, { publisher: 'jdoe' }, false)).toEqual({ by: 'jdoe', library: 'Community', url: 'https://github.com/jdoe' })
    expect(libraryCredit({ name: 'Containers' }, {}, true)).toEqual({ by: 'Open Industry Project', library: 'Containers', url: 'https://www.openindustryproject.org' })
    expect(libraryCredit({ name: 'Team parts' }, {}, false)).toEqual({ library: 'Team parts' })
  })

  it('is not part of what the part is, so a credited copy is still the library version', () => {
    const credited = asLibraryCopy(PLATFORM, { by: 'jdoe', library: 'Community', url: 'https://github.com/jdoe' })
    expect(partFingerprint(credited)).toBe(partFingerprint(PLATFORM))
    expect(libraryStatus(credited, version(PLATFORM))).toBe('upToDate')
  })

  it('travels in the part file, and a malformed one is refused', async () => {
    const credited = asLibraryCopy(PLATFORM, { by: 'jdoe', library: 'Community' })
    const folder = await oippartBytesToFolder(await partToOippartBytes(credited))
    if ('error' in folder) throw new Error(folder.error)
    expect(JSON.parse(folder.manifestJson).credit).toEqual({ by: 'jdoe', library: 'Community' })
    expect(validatePartPackage(credited)).toEqual([])
    expect(validatePartPackage({ ...credited, credit: { by: 'jdoe' } } as unknown as PartPackage).map((p) => p.field)).toEqual(['credit'])
    expect(validatePartPackage({ ...credited, credit: { library: 'x', url: 'javascript:alert(1)' } } as unknown as PartPackage).map((p) => p.field)).toEqual(['credit'])
  })
})

describe('checkLibraryAppend', () => {
  const sha = (c: string): string => c.repeat(64)
  const v = (c: string, over: Partial<LibraryVersion> = {}): LibraryVersion => version(PLATFORM, { file: `oip.platform/${sha(c)}.oippart`, sha256: sha(c), ...over })
  const lib = (versions: LibraryVersion[], over: Partial<LibraryPart> = {}): PartLibraryIndex =>
    index([{ id: 'oip.platform', name: 'Platform', versions, ...over }]) as unknown as PartLibraryIndex

  it('accepts a new version and lists its file to check', () => {
    const r = checkLibraryAppend(lib([v('a')]), lib([v('a'), v('b')]))
    expect(r.problems).toEqual([])
    expect(r.newFiles).toEqual([{ path: `oip.platform/${sha('b')}.oippart`, sha256: sha('b') }])
  })

  it('accepts a renamed part, a new description and a new picture on the newest version', () => {
    const thumb = `oip.platform/${sha('c')}.webp`
    const r = checkLibraryAppend(lib([v('a')]), lib([v('a', { thumbnail: thumb })], { name: 'Deck', description: 'A deck.' }))
    expect(r.problems).toEqual([])
    expect(r.newFiles).toEqual([{ path: thumb, sha256: sha('c') }])
  })

  it('refuses a rewritten published version', () => {
    expect(checkLibraryAppend(lib([v('a')]), lib([v('a', { fingerprint: 'v2:other' })])).problems).toEqual(['oip.platform: published version 1 was rewritten'])
    expect(checkLibraryAppend(lib([v('a'), v('b')]), lib([v('b')])).problems).toEqual(['oip.platform: a published version was removed'])
  })

  it('refuses a changed publisher, licence or library id', () => {
    expect(checkLibraryAppend(lib([v('a')]), lib([v('a')], { publisher: 'someone' })).problems).toEqual(['oip.platform: its publisher changed'])
    expect(checkLibraryAppend(lib([v('a')]), { ...lib([v('a')]), licence: { code: 'MIT', assets: 'CC0' } }).problems).toEqual(['the licence changed'])
    expect(checkLibraryAppend(lib([v('a')]), { ...lib([v('a')]), id: 'oip.other' }).problems).toEqual(['the library id changed from "oip.structure" to "oip.other"'])
  })

  it('refuses a new file not named by its hash', () => {
    expect(checkLibraryAppend(lib([v('a')]), lib([v('a'), v('b', { file: 'oip.platform/b.oippart' })])).problems).toEqual(['oip.platform: oip.platform/b.oippart is not named oip.platform/<its sha256>.oippart'])
  })

  it('reports a removed part, and treats every entry as new on a first release', () => {
    expect(checkLibraryAppend(lib([v('a')]), index([]) as unknown as PartLibraryIndex).removed).toEqual(['oip.platform'])
    const first = checkLibraryAppend(null, lib([v('a')]))
    expect(first.problems).toEqual([])
    expect(first.newFiles.map((f) => f.sha256)).toEqual([sha('a')])
  })
})
