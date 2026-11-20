// The working copy's model and texture bytes, kept in IndexedDB by SHA-256 (docs/projects.md "Model files in the
// browser").
//
// localStorage holds a few MB per origin, and an embedded asset is base64 in the project text, a third bigger than
// its bytes, so one imported model could fill it. The working copy and the legacy scene key therefore name each
// embedded asset by hash, `{ ..., localAsset: <sha256> }` in place of `data`, and its bytes live here. A room makes
// the same swap at its own boundary (collab/roomAssets.ts). In memory, in the library and in every file that leaves
// the browser, an asset is still `data`.
//
// Both directions are synchronous for the callers, which serialise and parse inside an edit or a boot:
//   - writing: an asset is written as its hash only once its bytes are known to be stored. Until then it stays
//     embedded and the bytes are queued. When they land, `onLocalAssetsStored` fires and the host saves again. A tab
//     that closes between the two leaves an embedded asset behind, never a hash with no bytes.
//   - reading: `loadLocalAssets` reads every hash the stored texts name before the boot parses them, and the reviver
//     puts the bytes back. A hash whose bytes are gone is reported, and the boot opens the library's copy instead.
//
// A database of its own, as folderHandleStore.ts has, so a version bump here never puts a migration in front of the
// library. Without IndexedDB (a Node test, some private modes) nothing is hashed and assets stay embedded.

import { base64ToBytes, bytesToBase64 } from '../../core/parts/partAssets'
import type { PartPackage } from '../../core/parts/partPackage'
import { sha256HexOfBytes } from '../../core/sha256'

const DB_NAME = 'oip-web-assets'
const DB_VERSION = 1
/** sha -> { sha, bytes } */
const BYTES = 'bytes'
/** sha -> { sha, at }: when the bytes were last written or found referenced. Kept apart so a sweep reads no bytes. */
const META = 'meta'

/** the field a stored asset names its bytes by */
export const LOCAL_ASSET_FIELD = 'localAsset'
const REF = /"localAsset":"([0-9a-f]{64})"/g

/**
 * An asset no stored text names is deleted only after this long untouched. Another tab may have stored bytes it has
 * not yet written a reference to, or may hold a part in its undo history whose bytes it believes are stored.
 */
const ORPHAN_GRACE_MS = 7 * 24 * 3600 * 1000

/** hashes whose bytes this session knows are in the database */
const stored = new Set<string>()
/** hashes being written, each settling when its write does */
const queued = new Map<string, Promise<void>>()
/** hashes the database refused this session: not offered again until a reload */
const refused = new Set<string>()
// the hash of each base64 text, so a package written on every edit hashes its model once
const SHA_CACHE_MAX = 128
const shaByData = new Map<string, string | null>()
// the base64 text of each hash this session has read or written, for the reviver
const dataBySha = new Map<string, string>()
const listeners = new Set<() => void>()

export function supportsLocalAssets(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  if (!supportsLocalAssets()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null) // blocked storage
    }
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of [BYTES, META]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'sha' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/** Run `body` in a transaction and resolve on commit (documentStore.ts says why not on a request's success). */
async function inTx<T>(mode: IDBTransactionMode, body: (bytes: IDBObjectStore, meta: IDBObjectStore) => T): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction([BYTES, META], mode)
      const out = body(tx.objectStore(BYTES), tx.objectStore(META))
      tx.oncomplete = () => resolve(out)
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Hear when queued bytes are stored, so the working copy can be saved again with their hashes. */
export function onLocalAssetsStored(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function queue(sha: string, bytes: Uint8Array): void {
  if (stored.has(sha) || queued.has(sha) || refused.has(sha) || !supportsLocalAssets()) return
  const write = inTx('readwrite', (b, m) => {
    b.put({ sha, bytes })
    m.put({ sha, at: Date.now() })
    return true
  }).then((ok) => {
    queued.delete(sha)
    if (ok === null) {
      refused.add(sha) // quota or blocked storage: the asset stays embedded
      return
    }
    stored.add(sha)
    for (const cb of listeners) cb()
  })
  queued.set(sha, write)
}

function shaOf(data: string): string | null {
  let sha = shaByData.get(data)
  if (sha !== undefined) return sha
  const bytes = base64ToBytes(data)
  // only canonical base64, so the asset reads back as exactly this text (its package's fingerprint depends on it)
  sha = bytes !== null && bytesToBase64(bytes) === data ? sha256HexOfBytes(bytes) : null
  if (sha !== null) {
    dataBySha.set(sha, data)
    queue(sha, bytes!)
  }
  if (shaByData.size >= SHA_CACHE_MAX) shaByData.delete(shaByData.keys().next().value!)
  shaByData.set(data, sha)
  return sha
}

/** An asset as the working copy holds it: by hash once its bytes are stored, else unchanged (its bytes are queued
 *  when it is first hashed). */
function storedEntry<A>(asset: A): A {
  const a = asset as { data?: unknown } & Record<string, unknown>
  if (typeof a?.data !== 'string' || a.data === '') return asset
  const sha = shaOf(a.data)
  if (sha === null || !stored.has(sha)) return asset
  const { data: _data, ...rest } = a
  return { ...rest, [LOCAL_ASSET_FIELD]: sha } as A
}

function storedPackage(pkg: PartPackage): PartPackage {
  if (!pkg.assets || pkg.assets.length === 0) return pkg
  const assets = pkg.assets.map(storedEntry)
  return assets.every((a, i) => a === pkg.assets![i]) ? pkg : { ...pkg, assets }
}

/** A project or scene with its embedded assets named by hash, for the working copy (a shallow copy where it differs). */
export function withLocalAssets<T extends { packages?: PartPackage[]; scene?: { packages?: PartPackage[] } }>(doc: T): T {
  if (!supportsLocalAssets() && stored.size === 0) return doc
  const out = { ...doc }
  if (doc.packages) out.packages = doc.packages.map(storedPackage)
  if (doc.scene?.packages) out.scene = { ...doc.scene, packages: doc.scene.packages.map(storedPackage) }
  return out
}

/**
 * Store a project's embedded assets before it is written into the working copy, so that write already names them by
 * hash. For the paths that replace the open project and reload (a switch, an import, a folder): a project whose models
 * would not fit embedded could not be opened otherwise. Resolves when every write has settled, stored or not.
 */
export async function storeLocalAssets(doc: { packages?: PartPackage[]; scene?: { packages?: PartPackage[] } }): Promise<void> {
  if (!supportsLocalAssets()) return
  withLocalAssets(doc)
  await Promise.all(queued.values())
}

/**
 * A JSON.parse reviver that puts each hashed asset's bytes back as `data`. A hash whose bytes this session has not
 * read is left as it is and added to `missing`, so the caller can refuse the text rather than open a part without
 * its model.
 */
export function localAssetReviver(missing: string[]): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (value === null || typeof value !== 'object') return value
    const sha = (value as Record<string, unknown>)[LOCAL_ASSET_FIELD]
    if (typeof sha !== 'string') return value
    const data = dataBySha.get(sha)
    if (data === undefined) {
      missing.push(sha)
      return value
    }
    const { [LOCAL_ASSET_FIELD]: _sha, ...rest } = value as Record<string, unknown>
    return { ...rest, data }
  }
}

/** The hashes a stored text names. */
export function localAssetRefs(text: string | null): string[] {
  if (text === null || !text.includes(LOCAL_ASSET_FIELD)) return []
  return [...new Set([...text.matchAll(REF)].map((m) => m[1]!))]
}

/**
 * Read the bytes of every asset the stored texts name, so they parse synchronously afterwards. Returns the hashes
 * whose bytes are not in the database.
 */
export async function loadLocalAssets(texts: readonly (string | null)[]): Promise<string[]> {
  const refs = [...new Set(texts.flatMap(localAssetRefs))].filter((sha) => !dataBySha.has(sha))
  if (refs.length === 0) return []
  const now = Date.now()
  const rows = await inTx('readwrite', (b, m) => {
    const found: { sha: string; bytes: Uint8Array }[] = []
    for (const sha of refs) {
      const get = b.get(sha)
      get.onsuccess = () => {
        const row = get.result as { sha: string; bytes: Uint8Array } | undefined
        if (!row) return
        found.push(row)
        m.put({ sha, at: now })
      }
    }
    return found
  })
  for (const row of rows ?? []) {
    const data = bytesToBase64(row.bytes)
    dataBySha.set(row.sha, data)
    shaByData.set(data, row.sha)
    stored.add(row.sha)
  }
  return refs.filter((sha) => !dataBySha.has(sha))
}

/**
 * Delete the assets no stored text names and nothing has touched for {@link ORPHAN_GRACE_MS}: a model whose part was
 * deleted, or that belonged to a project since closed (the library keeps its own embedded copy). Run after the boot.
 */
export async function sweepLocalAssets(texts: readonly (string | null)[]): Promise<void> {
  const refs = new Set(texts.flatMap(localAssetRefs))
  const now = Date.now()
  await inTx('readwrite', (b, m) => {
    const cursor = m.openCursor()
    cursor.onsuccess = () => {
      const c = cursor.result
      if (!c) return
      const { sha, at } = c.value as { sha: string; at: number }
      if (!refs.has(sha) && !stored.has(sha) && !queued.has(sha) && now - at > ORPHAN_GRACE_MS) {
        b.delete(sha)
        c.delete()
      }
      c.continue()
    }
    return true
  })
}

/** For tests: forget every cached hash and byte. */
export function resetLocalAssetsForTest(): void {
  stored.clear()
  queued.clear()
  refused.clear()
  shaByData.clear()
  dataBySha.clear()
  listeners.clear()
}

/** For tests: record base64 bytes as stored, as a load or a completed write would. */
export function markLocalAssetStoredForTest(data: string): string {
  const sha = shaOf(data)!
  stored.add(sha)
  return sha
}
