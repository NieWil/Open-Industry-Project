// Part libraries, as the editor sees them (docs/part-libraries.md): parts published outside the app, listed in a
// static index, for projects to copy from. The project's library stays the only place its parts come from; a library
// is never read live. core/parts/partLibrary.ts holds the index format and the statuses; this module fetches, checks and
// installs:
//
//   libraryUrls      the index URLs this app reads (partLibraryUrls.ts, kept apart so the Catalog's first frame
//                    asks which libraries exist without loading the rest)
//   readLibrary      fetch and validate one index
//   downloadVersion  fetch one listed .oippart, build it, and check it is the version the index lists
//   installFromLibrary  copy a downloaded part into the project's library, stamped with the version it came from
//
// `/app/` is cross-origin isolated, so a library on another origin must answer with CORS headers, or every fetch here
// fails (and its pictures load as CORS requests, components/CatalogPlaceButton.tsx).

import { checkLibrarySignature } from '../../core/librarySignature'
import type { LibrarySigningKey } from '../../core/librarySignature'
import { LIBRARY_SIGNING_KEYS } from '../../core/librarySigningKeys'
import { asLibraryCopy, checkLibraryDownload, FIRST_PARTY_LIBRARY_HOSTS, isFirstPartyLibrary, libraryUrl, validateLibraryIndex } from '../../core/parts/partLibrary'
import type { LibraryVersion, PartLibraryIndex } from '../../core/parts/partLibrary'
import type { PartCredit, PartPackage } from '../../core/parts/partPackage'
import { registerPackage } from '../../core/parts/partRegistry'
import { parsePartBytes } from './partFile'
import type { EditorStore } from '../store/store'

import { addedLibraryUrls, isLibraryIndexUrl, OFFICIAL_PART_LIBRARIES, setLibraryUrls } from './partLibraryUrls'

export { libraryUrls, setLibraryUrls } from './partLibraryUrls'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

// the hosts whose oip.* libraries are first-party; a dev build adds loopback, so e2e/verify-part-library.mjs can serve
// one locally (a production build never trusts a library on the user's own machine as the project's)
const FIRST_PARTY_HOSTS: readonly string[] = import.meta.env.DEV ? [...FIRST_PARTY_LIBRARY_HOSTS, '127.0.0.1'] : FIRST_PARTY_LIBRARY_HOSTS

// the keys whose signature makes an index the project's (core/librarySigningKeys.ts); a dev build also trusts the
// gates' test key (e2e/_library-test-key.mjs), whose private half is public, so a production build never does
const SIGNING_KEYS: readonly LibrarySigningKey[] = import.meta.env.DEV
  ? [...LIBRARY_SIGNING_KEYS, { id: '203383cd7bf784b2', publicKey: '2iOUqCAxDyE61UDm+sOlaG2W+GWQHWQSMKF79c09hEY=' }]
  : LIBRARY_SIGNING_KEYS

/** One library as read: its index, or why it could not be read. */
export interface LibraryListing {
  url: string
  index?: PartLibraryIndex
  error?: string
  /** a first-party library: copies of the app's built-ins read as made from it (core/parts/partLibrary.ts) */
  firstParty: boolean
  /** it carries the project's signature: the project published it (the listed library, or one of its own) */
  signed?: boolean
}

/** Fetch and validate one library index. Never throws. */
export async function readLibrary(url: string, fetchFn: Fetch = fetch): Promise<LibraryListing> {
  try {
    // the index changes when a version is published; the files it names never do
    const res = await fetchFn(url, { cache: 'no-cache' })
    if (!res.ok) return { url, error: `the library answered ${res.status}`, firstParty: false }
    const raw: unknown = await res.json()
    const checked = validateLibraryIndex(raw)
    if ('problems' in checked) return { url, error: checked.problems.slice(0, 3).join('; '), firstParty: false }
    const signature = await checkLibrarySignature(raw as Record<string, unknown>, SIGNING_KEYS)
    // a signature that does not verify is refused, not read as unsigned: the file changed after it was signed. One by a
    // key this build does not have reads as unsigned (core/librarySignature.ts 'unknownKey')
    if (signature === 'invalid') return { url, error: "its signature does not verify: the index is not the one its publisher signed", firstParty: false }
    const signed = signature === 'signed'
    return { url, index: checked.index, firstParty: isFirstPartyLibrary(checked.index, url, FIRST_PARTY_HOSTS, signed), signed }
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e), firstParty: false }
  }
}

/**
 * Add a library to the viewer's own list, after reading it, so a wrong address or a host without CORS is said at once
 * rather than as an empty library later. The reason it was refused, or null once it is added.
 */
export async function addLibrary(draft: string, fetchFn: Fetch = fetch): Promise<string | null> {
  const url = draft.trim()
  if (!isLibraryIndexUrl(url)) return 'Enter the address of a library index (https://.../index.json).'
  const added = addedLibraryUrls()
  if (added.includes(url) || OFFICIAL_PART_LIBRARIES.includes(url)) return 'That library is already in the list.'
  const read = await readLibrary(url, fetchFn)
  if (!read.index) return `That library could not be read: ${read.error ?? 'unknown error'}`
  setLibraryUrls([...addedLibraryUrls(), url])
  return null
}

// one download per listed file for the page's life: a file never changes, so its built part never does either
const downloads = new Map<string, Promise<{ pkg: PartPackage } | { error: string }>>()

/**
 * Fetch a listed version's .oippart, build it the way Import part does, and check it is the version the index lists
 * (core/parts/partLibrary.ts checkLibraryDownload). A failure is not kept, so the next ask tries again.
 */
export function downloadVersion(indexUrl: string, partId: string, version: LibraryVersion, fetchFn: Fetch = fetch): Promise<{ pkg: PartPackage } | { error: string }> {
  const key = `${version.sha256}:${partId}`
  const known = downloads.get(key)
  if (known) return known
  const job = (async (): Promise<{ pkg: PartPackage } | { error: string }> => {
    try {
      const res = await fetchFn(libraryUrl(indexUrl, version.file))
      if (!res.ok) return { error: `the library answered ${res.status}` }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const built = await parsePartBytes(bytes)
      if ('error' in built) return built
      const problem = checkLibraryDownload(version, partId, bytes, built.pkg)
      return problem === '' ? built : { error: problem }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })()
  downloads.set(key, job)
  // a failed download is not kept, so the next ask tries again
  void job
    .then((r) => {
      if ('error' in r) downloads.delete(key)
    })
    .catch(() => downloads.delete(key))
  return job
}

/**
 * Copy a downloaded library part into the project's library (installing it, or updating the project's copy): stamped
 * with the version it came from, registered as this project's own so every placed copy rebuilds on it. The caller
 * has asked first where that replaces edits made here ('changedInBoth').
 */
export function installFromLibrary(store: EditorStore, pkg: PartPackage, credit?: PartCredit): void {
  const copy = asLibraryCopy(pkg, credit)
  registerPackage(copy, true)
  store.addUserPackage(copy)
}
