// Newer versions, in the part libraries, of parts this project got from one (docs/part-libraries.md), so the Catalog
// can say so on their cards like any other update (editor/parts/partUpdates.ts).
//
// The app makes no request to a library unless someone asks: page loads, test runs and offline starts do not depend on
// reaching one. A project that holds a part from a library has asked, in a way: its libraries are read once, after the
// scene's first paint, and the newer version of each such part is downloaded and checked (partLibraries.ts
// downloadVersion), so taking it later needs nothing further. A library that cannot be reached says nothing.

import { useEffect, useSyncExternalStore } from 'react'
import { offeredVersion } from '../../core/parts/partLibrary'
import type { LibraryVersion } from '../../core/parts/partLibrary'
import { partFingerprint } from '../../core/parts/partOrigin'
import type { PartPackage } from '../../core/parts/partPackage'
import { whenScenePainted } from '../../render/renderReady'
import type { EditorState } from '../store/store'
import type { LibraryListing } from './partLibraries'
import { LIBRARIES_CHANGED, libraryUrls } from './partLibraryUrls'

export interface LibrarySnapshot {
  /** the libraries as read, or null until they have been (or when the project has no library part) */
  listings: readonly LibraryListing[] | null
  /** downloaded and checked versions, by `${sha256}:${partId}` */
  downloaded: ReadonlyMap<string, PartPackage>
}

let snapshot: LibrarySnapshot = { listings: null, downloaded: new Map() }
const listeners = new Set<() => void>()
let started = false
const updatesFailed = (e: unknown): void => console.warn('[oip] checking the part libraries for updates failed', e)

function publish(next: LibrarySnapshot): void {
  snapshot = next
  for (const l of listeners) l()
}

/** A part this project got from a library: recorded as such, or a copy of a built-in the app no longer ships (moved
 *  to a first-party library, which then reads as where it came from). */
export function fromLibrary(pkg: PartPackage, builtInIds: ReadonlySet<string>): boolean {
  return pkg.origin?.library !== undefined || (pkg.origin?.app !== undefined && !builtInIds.has(pkg.id))
}

/** The version a library offers of `id`, with the listing it is in: the first library, in reading order, that lists it. */
export function offerFor(listings: readonly LibraryListing[], id: string): { listing: LibraryListing; version: LibraryVersion } | undefined {
  for (const listing of listings) {
    const part = listing.index?.parts.find((p) => p.id === id)
    const version = part ? offeredVersion(part).version : undefined
    if (version) return { listing, version }
  }
  return undefined
}

export function downloadKey(version: LibraryVersion, id: string): string {
  return `${version.sha256}:${id}`
}

/** Download the offered version of each of these parts the project does not hold as it is. */
async function ensureDownloads(parts: readonly PartPackage[]): Promise<void> {
  const listings = snapshot.listings
  if (!listings) return
  const { downloadVersion } = await import('./partLibraries')
  const wanted = parts.flatMap((p) => {
    const offer = offerFor(listings, p.id)
    if (!offer || offer.version.fingerprint === partFingerprint(p)) return []
    return snapshot.downloaded.has(downloadKey(offer.version, p.id)) ? [] : [{ id: p.id, ...offer }]
  })
  for (const w of wanted) {
    const got = await downloadVersion(w.listing.url, w.id, w.version)
    if ('pkg' in got) publish({ ...snapshot, downloaded: new Map(snapshot.downloaded).set(downloadKey(w.version, w.id), got.pkg) })
  }
}

async function readLibraries(): Promise<void> {
  const { readLibrary } = await import('./partLibraries')
  const listings = await Promise.all(libraryUrls().map((url) => readLibrary(url)))
  publish({ ...snapshot, listings })
}

/**
 * The libraries as Get parts just read them (GetPartsWindow.tsx): the freshest listing there is, so the Catalog's
 * badges show what that window shows without a second request.
 */
export function noteLibraryListings(listings: readonly LibraryListing[]): void {
  publish({ ...snapshot, listings })
  if (projectParts.length > 0) void ensureDownloads(projectParts)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// this project's library parts as of its last render, for a read that finishes later
let projectParts: readonly PartPackage[] = []

/**
 * The libraries as read for this project's library parts. The first render while the project holds one starts the
 * read; a project with none makes no request.
 */
export function useLibrarySnapshot(state: Pick<EditorState, 'userPackages' | 'bundledPackages'>): LibrarySnapshot {
  const snap = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(() => {
    const builtInIds = new Set(state.bundledPackages.map((p) => p.id))
    projectParts = state.userPackages.filter((p) => fromLibrary(p, builtInIds))
    if (projectParts.length === 0) return
    if (!started) {
      started = true
      void whenScenePainted()
        .then(() => readLibraries())
        .then(() => ensureDownloads(projectParts))
        .catch(updatesFailed)
      // the viewer switched a library on or off, or added one: what it offers may differ
      window.addEventListener(LIBRARIES_CHANGED, () =>
        void readLibraries()
          .then(() => ensureDownloads(projectParts))
          .catch(updatesFailed),
      )
    } else {
      // a part edited, added or taken since: download what it now lacks (each version is fetched once)
      void ensureDownloads(projectParts)
    }
  }, [state.userPackages, state.bundledPackages])
  return snap
}
