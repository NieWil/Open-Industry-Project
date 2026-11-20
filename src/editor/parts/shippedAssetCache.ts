// The bytes of the part assets this app ships (public/part-assets/<sha256><ext>, core/shippedAssets.ts), held in
// memory once fetched, for the writers that put a project on disk: a project folder, a .oip, the shelf. They are
// synchronous (the folder sync writes as the window closes, and cannot await a fetch), so they ask this cache, and
// an asset whose bytes are not here yet is written as its reference and gets its file on the next write
// (core/parts/partAssets.ts `SplitOptions.assetBytes`). Each fetch is checked against the hash it is named by.

import type { PartPackage } from '../../core/parts/partPackage'
import { versionedAssetUrl } from '../../core/assetVersions'
import { PART_ASSETS_PATH } from '../../core/shippedAssets'

const bytesByHash = new Map<string, Uint8Array>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

/** The bytes of the shipped part asset `sha256`, if they have been fetched (the writers' `assetBytes`). */
export function shippedAssetBytes(sha256: string): Uint8Array | undefined {
  return bytesByHash.get(sha256)
}

/** Hear when more bytes arrive: a writer that wrote a reference for want of them can write the file now. */
export function onShippedAssetsWarmed(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function fetchOne(sha256: string, url: string): Promise<void> {
  try {
    // content-addressed, so the version is the name; still through versionedAssetUrl like every app-asset fetch
    const res = await fetch(versionedAssetUrl(url))
    if (!res.ok) return
    const buf = await res.arrayBuffer()
    // the name is the hash: bytes that do not hash to it are not the asset, and are never written as it
    if (hex(await crypto.subtle.digest('SHA-256', buf)) !== sha256) return
    bytesByHash.set(sha256, new Uint8Array(buf))
  } catch {
    // offline, or no fetch at all (a node test): the writers keep the reference, which is still a valid package
  } finally {
    inFlight.delete(sha256)
  }
}

/**
 * Fetch the bytes of every shipped part asset `pkgs` reference (a `url` under /part-assets/ with its `sha256`) that
 * this cache does not hold yet. Resolves once those fetches settle, after telling the listeners if any bytes came.
 */
export async function warmShippedAssets(pkgs: readonly PartPackage[]): Promise<void> {
  const before = bytesByHash.size
  const waits: Promise<void>[] = []
  for (const pkg of pkgs) {
    for (const a of pkg.assets ?? []) {
      if (a.sha256 === undefined || a.url === undefined || !a.url.startsWith(PART_ASSETS_PATH) || bytesByHash.has(a.sha256)) continue
      let p = inFlight.get(a.sha256)
      if (!p) {
        p = fetchOne(a.sha256, a.url)
        inFlight.set(a.sha256, p)
      }
      waits.push(p)
    }
  }
  if (waits.length === 0) return
  await Promise.all(waits)
  if (bytesByHash.size > before) for (const cb of listeners) cb()
}
