// The parts shelf's listing, read once and shared (docs/parts-shelf.md): the Catalog's cards, the card images and the
// Part Editor's Put on shelf all read this one copy. The shelf can change under the app (a teammate, a git pull), so
// it is read again when the window regains focus and its files have changed, and after every shelf action.
//
// The first read waits for the scene's first paint: it builds every shelf part, which is no reason to delay the scene.

import { useSyncExternalStore } from 'react'
import { whenScenePainted } from '../../render/renderReady'
import { getShelfApi, readShelf, sameListing } from './partShelf'
import type { ShelfListing } from './partShelf'

export interface ShelfSnapshot {
  /** null until the first read lands */
  listing: ShelfListing | null
  /** why the last read failed, or null */
  error: string | null
}

let snapshot: ShelfSnapshot = { listing: null, error: null }
const listeners = new Set<() => void>()
let reading: Promise<void> | null = null
let readAgain = false
// a queued read that must read the shelf whole, whatever its files' signature says
let readWhole = false
// the shelf's files as of the last whole read (partsShelf.cjs shelfSignature)
let lastSignature: string | null = null
let started = false

function publish(next: ShelfSnapshot): void {
  snapshot = next
  for (const l of listeners) l()
}

/**
 * Read the shelf again. A call during a read queues one more read after it, since the first may have started
 * before the change the caller made. Resolves once the listing reflects the shelf as of the call. `ifChanged` (a
 * window focus) reads it whole only when its files' names, sizes or change times moved since the last read.
 */
export function refreshShelf(opts: { ifChanged?: boolean } = {}): Promise<void> {
  const api = getShelfApi()
  if (!api) return Promise.resolve()
  if (!opts.ifChanged) readWhole = true
  if (reading) {
    readAgain = true
    return reading
  }
  reading = (async () => {
    do {
      readAgain = false
      const whole = readWhole
      readWhole = false
      try {
        // taken before the read, so a change made during it moves the next one
        const signature = await api.signature()
        if (!whole && snapshot.listing !== null && snapshot.error === null && signature === lastSignature) continue
        const listing = await readShelf(api)
        lastSignature = signature
        // an unchanged shelf re-renders nothing
        const prev = snapshot.listing
        if (!(prev && snapshot.error === null && sameListing(prev, listing))) publish({ listing, error: null })
      } catch (e) {
        publish({ listing: snapshot.listing, error: e instanceof Error ? e.message : String(e) })
      }
    } while (readAgain)
    reading = null
  })()
  return reading
}

/** The listing as last read. */
export function shelfSnapshot(): ShelfSnapshot {
  return snapshot
}

function start(): void {
  if (started || !getShelfApi()) return
  started = true
  void whenScenePainted()
    .then(() => refreshShelf())
    .catch((e: unknown) => console.warn('[oip] reading the parts shelf failed', e))
  window.addEventListener('focus', () => void refreshShelf({ ifChanged: true }))
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The shelf as last read, or null where there is no shelf (the browser). */
export function useShelf(): ShelfSnapshot | null {
  const snap = useSyncExternalStore(subscribe, shelfSnapshot)
  return getShelfApi() ? snap : null
}
