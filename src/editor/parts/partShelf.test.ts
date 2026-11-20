import { afterEach, describe, expect, it, vi } from 'vitest'
import { PACKAGE_FORMAT, manifestOfPackage } from '../../core/parts/partPackage'
import { upgradeStoredPackage } from '../../core/parts/partUpgrade'
import type { PartPackage } from '../../core/parts/partPackage'
import { shelfFingerprint, shelfStatus } from '../../core/parts/partShelf'
import { buildPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import { copyFromShelf, putOnShelf, sameListing, shelfListingOf, statusInProject } from './partShelf'
import type { OipShelfApi } from './partShelf'
import { EditorStore } from '../store/store'

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

/** a part as the shelf would hold it: built from its folder files, like every shelf part */
function shelfPart(name = 'Transfer', length = 1, behavior = 'definePart({ step() {} })'): PartPackage {
  const raw: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 'acme.transfer',
    name,
    params: {},
    behavior,
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [length, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [] } as unknown as PartPackage['geometry'],
  }
  return buildPackage(manifestOfPackage(raw) as PackageManifest, raw.behavior)
}
const folderOf = (pkg: PartPackage, dir = `/shelf/${pkg.id}`) => ({
  dir,
  id: pkg.id,
  name: pkg.name,
  manifestJson: JSON.stringify(manifestOfPackage(pkg)),
  behaviorSource: pkg.behavior,
})

describe('reading the shelf', () => {
  it('builds each part folder, and reports a folder that does not build instead of dropping it', () => {
    const listing = shelfListingOf({
      root: '/shelf',
      parts: [folderOf(shelfPart()), { dir: '/shelf/broken', id: 'x.broken', name: 'Broken', manifestJson: '{nope', behaviorSource: '' }],
      problems: [{ dir: '/shelf/odd', message: 'missing behavior.js' }],
    })
    expect(listing.parts.map((p) => p.id)).toEqual(['acme.transfer'])
    expect(listing.problems.map((p) => p.dir).sort()).toEqual(['/shelf/broken', '/shelf/odd'])
  })
})

describe('moving parts between the project and the shelf', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('placing copies the shelf part into the library, recorded as that version, so it reads up to date', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const shelf = shelfPart()
    expect(statusInProject(store.getState(), shelf)).toBe('notInProject')
    copyFromShelf(store, shelf)
    const copy = store.getState().userPackages.find((p) => p.id === shelf.id)!
    expect(copy.origin?.shelf).toBe(shelfFingerprint(shelf))
    expect(statusInProject(store.getState(), shelf)).toBe('upToDate')
    // the shelf moves on: the project is told, and updating takes it
    const newer = shelfPart('Transfer', 2)
    expect(statusInProject(store.getState(), newer)).toBe('updateAvailable')
    copyFromShelf(store, newer)
    expect(statusInProject(store.getState(), newer)).toBe('upToDate')
    expect(store.getState().userPackages.filter((p) => p.id === shelf.id)).toHaveLength(1) // replaced, not added
  })

  // A copy is saved and reopened many times between two reads of the shelf. If any of those trips moved its
  // fingerprint, an untouched copy would read "Edited here", or "Changed in both" once the shelf moves on.
  it('a copy reopened from a project folder or the browser store still reads up to date', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    // params come from running the behavior, so they are part of what has to survive
    const shelf = shelfPart('Transfer', 1, `definePart({ params: { speed: { type: 'number', default: 0.5, min: 0, max: 2 } }, step() {} })`)
    copyFromShelf(store, shelf)
    const copy = store.getState().userPackages.find((p) => p.id === shelf.id)!
    // a project folder holds manifest.json and behavior.js, and opening it builds them again
    const fromFolder = buildPackage(JSON.parse(JSON.stringify(manifestOfPackage(copy))) as PackageManifest, copy.behavior)
    // the browser store keeps the package as JSON and upgrades it on read
    const fromStore = upgradeStoredPackage(JSON.parse(JSON.stringify(copy)) as PartPackage).pkg
    for (const reopened of [fromFolder, fromStore]) {
      expect(reopened.origin?.shelf).toBe(shelfFingerprint(shelf))
      expect(shelfFingerprint(reopened)).toBe(shelfFingerprint(copy))
      expect(shelfStatus(reopened, shelf)).toBe('upToDate')
    }
  })

  it('putting a part on the shelf writes it without the copy\'s record, and the copy then reads up to date', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    copyFromShelf(store, shelfPart())
    // edited here: a different part under the same record
    const edited = { ...store.getState().userPackages[0]!, name: 'Transfer (ours)' }
    store.addUserPackage(edited)
    const written: { id: string; manifest: Record<string, unknown>; behavior: string }[] = []
    const api: OipShelfApi = {
      list: async () => ({ root: '/shelf', parts: [], problems: [] }),
      signature: async () => '/shelf',
      write: async (id, manifestJson, behaviorSource) => {
        written.push({ id, manifest: JSON.parse(manifestJson) as Record<string, unknown>, behavior: behaviorSource })
        return ''
      },
      pickFolder: async () => null,
      reveal: async () => '',
    }
    expect(await putOnShelf(store, api, edited)).toBe('')
    expect(written).toHaveLength(1)
    expect(written[0]!.id).toBe('acme.transfer')
    expect(written[0]!.manifest.name).toBe('Transfer (ours)')
    expect((written[0]!.manifest.origin as { shelf?: string } | undefined)?.shelf).toBeUndefined()
    const onShelf = buildPackage(written[0]!.manifest as unknown as PackageManifest, written[0]!.behavior)
    expect(statusInProject(store.getState(), onShelf)).toBe('upToDate')
  })

  it("a team's version of a built-in is an update to a project's untouched copy, and changed in both to an edited one", () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const builtIn = shelfPart()
    const teams = shelfPart('Transfer', 2)
    store.setState({ bundledPackages: [builtIn], userPackages: [builtIn] })
    expect(statusInProject(store.getState(), teams)).toBe('updateAvailable')
    store.setState({ userPackages: [shelfPart('Transfer', 3)] })
    expect(statusInProject(store.getState(), teams)).toBe('changedInBoth')
    // not a built-in: two parts that share an id, for "Rename ours…" to tell apart
    store.setState({ bundledPackages: [] })
    expect(statusInProject(store.getState(), teams)).toBe('sameIdDifferentPart')
  })

  it('a folder read again unchanged keeps the part built from it, so an unchanged shelf is the same listing', () => {
    const pkg = shelfPart()
    const scan = { root: '/shelf', parts: [folderOf(pkg)], problems: [] }
    const first = shelfListingOf(scan)
    const again = shelfListingOf(scan)
    expect(again.parts[0]).toBe(first.parts[0])
    expect(sameListing(first, again)).toBe(true)
    const changed = shelfListingOf({ ...scan, parts: [folderOf(shelfPart('Transfer v2'))] })
    expect(changed.parts[0]).not.toBe(first.parts[0])
    expect(sameListing(first, changed)).toBe(false)
  })

  it('keeps a card image the shelf has beside a part, and only a PNG', () => {
    const pkg = shelfPart()
    const png = 'data:image/png;base64,iVBORw0K'
    expect(shelfListingOf({ root: '/shelf', parts: [{ ...folderOf(pkg), thumbnail: png }], problems: [] }).thumbnails.get(pkg.id)).toBe(png)
    expect(shelfListingOf({ root: '/shelf', parts: [{ ...folderOf(pkg), thumbnail: 'javascript:alert(1)' }], problems: [] }).thumbnails.size).toBe(0)
  })

  it('a failed write changes nothing in the project and says why', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    copyFromShelf(store, shelfPart())
    const before = store.getState().userPackages[0]!
    const api = { write: async () => 'The shelf folder is read-only.' } as unknown as OipShelfApi
    expect(await putOnShelf(store, api, { ...before, name: 'Changed' })).toBe('The shelf folder is read-only.')
    expect(store.getState().userPackages[0]).toBe(before)
  })
})
