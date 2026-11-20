// A ROOM's part assets, kept on the collab server by hash (server/assets.mjs; docs/part-sources.md "Rooms").
//
// An embedded asset is written to the room's Yjs document as its hash, `{ ..., room: <sha256> }` in place of
// `data`, and its bytes go to the server's asset store once; a peer fetches each hash once and caches it. As base64
// in the document, every peer would download it with the room, the document would keep it for good, and a script
// edit would re-send the model.
//
// Both directions stay SYNCHRONOUS for the schema (collab/schema.ts), because a package is written inside a scene
// transaction and read by docToScene:
//   - writing: the hash is computed here (cached by the base64 text) and the upload is queued, retried until it
//     lands. A peer that asks before it has landed gets a 404 and tries again.
//   - reading: an entry whose bytes are here becomes `data` again, exactly as it was written (a `sha256` field only
//     if the writer's asset had one), so a package reads back equal on every peer. One whose bytes are not here yet
//     is fetched, and the package is left out until they arrive ({@link onRoomAssetsArrived} says when): the bridge
//     already copes with a part whose package comes later.
//
// Unconfigured (no room, a test, a room opened offline), nothing changes: assets stay embedded both ways.

import { base64ToBytes, bytesToBase64 } from '../core/parts/partAssets'
import { sha256HexOfBytes } from '../core/sha256'

/** Where a room's assets live, and the proof this client may add to them (null for a viewer). */
export interface RoomAssetLink {
  /** http(s) origin of the collab server */
  base: string
  /** the room's document name, `r-<sha256(secret)>` */
  room: string
  /** the room's edit secret, or null on a view link */
  token: string | null
}

/** The http(s) origin of a collab server given its WebSocket URL. */
export function assetBaseFor(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '')
}

let link: RoomAssetLink | null = null
// Whether the server has an asset store. The web app deploys on every push and the collab server by hand, so a build
// can meet a server without one: until a probe says it is there, an editor keeps embedding (always readable), and
// nothing is written that a peer could never fetch.
let storeReady = false
let probe = 0
const bytesBySha = new Map<string, Uint8Array>()
// the hash of a base64 text this client wrote, so a package re-written every scene change hashes its model once
const SHA_CACHE_MAX = 128
const shaByData = new Map<string, string | null>()
// the base64 text of each hash this client holds, so reading a room back does not re-encode a model every time
const dataBySha = new Map<string, string>()
const fetching = new Set<string>()
const uploading = new Set<string>()
const listeners = new Set<() => void>()
// One notify per burst of arrivals: each listener re-reads every package and re-applies the scene, so joining a room
// with N models would otherwise rebuild N times. A timer, not a microtask, so arrivals that land while a rebuild runs
// join the next one.
let notifyTimer: ReturnType<typeof setTimeout> | null = null

function notifyArrived(): void {
  if (notifyTimer !== null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const cb of listeners) cb()
  }, 0)
}

/** Point the store at a room (or at nothing). Cached bytes survive, since they are named by content. */
export function configureRoomAssets(next: RoomAssetLink | null): void {
  link = next
  storeReady = false
  const mine = ++probe
  if (!next?.token) return // a viewer writes nothing, so it never needs to know
  // every answer from the store carries X-Oip-Asset-Store (exposed to a cross-origin page); a server without the
  // route answers without it, or without CORS at all (the fetch rejects), and the editor keeps embedding
  void fetch(`${next.base}/assets/${'0'.repeat(64)}`, { method: 'HEAD' })
    .then((res) => {
      if (mine === probe && res.headers.get('x-oip-asset-store') === '1') storeReady = true
    })
    .catch(() => {})
}

/** Hear when fetched bytes arrive, so packages left out for want of them can be read again. */
export function onRoomAssetsArrived(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function upload(sha: string, bytes: Uint8Array): Promise<void> {
  if (uploading.has(sha)) return
  uploading.add(sha)
  try {
    // keep trying while this client is still in a room it may edit: a peer is waiting on these bytes
    for (let attempt = 0; link?.token; attempt++) {
      const { base, room, token } = link
      try {
        const head = await fetch(`${base}/assets/${sha}`, { method: 'HEAD' })
        if (head.ok) return
        const res = await fetch(`${base}/assets/${sha}`, {
          method: 'PUT',
          body: bytes as Uint8Array<ArrayBuffer>,
          headers: { authorization: `Bearer ${token}`, 'x-oip-room': room, 'content-type': 'application/octet-stream' },
        })
        if (res.ok) return
        // refused for good (not an editor, too large, not these bytes): retrying cannot help
        if (res.status === 400 || res.status === 403 || res.status === 413) {
          console.warn(`[room assets] the server refused ${sha.slice(0, 12)}: ${res.status} ${await res.text()}`)
          return
        }
      } catch {
        /* offline or the server restarting: try again */
      }
      await pause(Math.min(30_000, 1000 * 2 ** attempt))
    }
  } finally {
    uploading.delete(sha)
  }
}

async function fetchAsset(sha: string): Promise<void> {
  if (fetching.has(sha) || bytesBySha.has(sha) || !link) return
  fetching.add(sha)
  try {
    // an upload may still be on its way from the peer that wrote the hash: a 404 is retried for a while
    for (let attempt = 0; attempt < 12 && link; attempt++) {
      try {
        const res = await fetch(`${link.base}/assets/${sha}`)
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer())
          if (sha256HexOfBytes(bytes) !== sha) {
            console.warn(`[room assets] ${sha.slice(0, 12)}: the server sent other bytes`)
            return
          }
          bytesBySha.set(sha, bytes)
          notifyArrived()
          return
        }
      } catch {
        /* offline: try again */
      }
      await pause(Math.min(15_000, 500 * 2 ** attempt))
    }
  } finally {
    fetching.delete(sha)
  }
}

function shaOf(data: string): string | null {
  let sha = shaByData.get(data)
  if (sha !== undefined) return sha
  const bytes = base64ToBytes(data)
  // only canonical base64, so the entry reads back as exactly this text
  sha = bytes !== null && bytesToBase64(bytes) === data ? sha256HexOfBytes(bytes) : null
  if (sha !== null && bytes !== null) {
    bytesBySha.set(sha, bytes)
    dataBySha.set(sha, data)
  }
  if (shaByData.size >= SHA_CACHE_MAX) shaByData.delete(shaByData.keys().next().value!)
  shaByData.set(data, sha)
  return sha
}

/**
 * An asset as the room document holds it: an embedded one as its hash (its bytes queued for the store) when this
 * client is an editor of a configured room; anything else unchanged.
 */
export function toRoomEntry<A>(asset: A): A {
  const a = asset as { data?: unknown } & Record<string, unknown>
  if (!link?.token || !storeReady || typeof a?.data !== 'string' || a.data === '') return asset
  const sha = shaOf(a.data)
  if (sha === null) return asset
  void upload(sha, bytesBySha.get(sha)!)
  const { data: _data, ...rest } = a
  return { ...rest, room: sha } as A
}

/**
 * An asset as the app holds it, from its room entry: a hashed one with its bytes back in `data` when they are here,
 * or undefined when they are not yet (they are being fetched; {@link onRoomAssetsArrived} fires when they land). Any
 * other entry is returned unchanged.
 */
export function fromRoomEntry<A>(entry: A): A | undefined {
  const e = entry as { room?: unknown } & Record<string, unknown>
  if (typeof e?.room !== 'string') return entry
  const bytes = bytesBySha.get(e.room)
  if (bytes === undefined) {
    if (/^[0-9a-f]{64}$/.test(e.room)) void fetchAsset(e.room)
    return undefined
  }
  let data = dataBySha.get(e.room)
  if (data === undefined) {
    data = bytesToBase64(bytes)
    dataBySha.set(e.room, data)
  }
  const { room: _room, ...rest } = e
  return { ...rest, data } as A
}

/** For tests: forget every cached byte, hash and in-flight request. */
export function resetRoomAssetsForTest(): void {
  link = null
  storeReady = false
  probe++
  bytesBySha.clear()
  shaByData.clear()
  dataBySha.clear()
  fetching.clear()
  uploading.clear()
  listeners.clear()
  if (notifyTimer !== null) clearTimeout(notifyTimer)
  notifyTimer = null
}
