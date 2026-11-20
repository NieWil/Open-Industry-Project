// Remembering the linked folder across reloads.
//
// Without this, any reload (shelf switch, HMR, reopening the tab) would end projectFolderLink.ts's link and
// the banner would vanish, so a user could keep editing while an agent's writes no longer arrived.
//
// A FileSystemDirectoryHandle is structured-cloneable, so IndexedDB holds the handle itself (the API exposes
// no path). Whether it still works is a permission question the caller asks on restore (queryPermission).
//
// It has its own database rather than a store in documentStore's: bumping that version for a convenience
// would put a migration in front of the user's projects. A failure in here may lose the link, never the library.
//
// Keyed by document id: the link belongs to a document, not the app. A handle whose document is deleted is
// left behind. It is a few bytes, ids are never reused, and a sweep would be more code than the leak is worth.
//
// The handle is stored opaquely (`unknown`) so there is no import cycle with projectFolderLink.
//
// The folder's signature is stored with it so a restore can ask "did this folder change while the tab was
// closed?". Without it every reload re-applies the whole project, rebuilding the scene and clearing undo
// and selection to arrive at what was already on screen. With it the common reload applies nothing.

import type { FolderBaseline } from '../../core/project/folderSync'

const DB_NAME = 'oip-web-folder'
const DB_VERSION = 1
/** docId -> { id, handle, signature }: one remembered directory handle per document. */
const STORE = 'handles'

/** A remembered folder: the handle, and what the two-way sync needs to pick up where it left off. */
export interface RememberedFolder {
  handle: unknown
  /** projectFolderLink.folderSignature() as of the last sync; '' when it could not be taken. */
  signature: string
  /**
   * The per-file baselines (core/project/folderSync.ts) as of the last sync. undefined on a row written before the
   * link was two-way. Such a row followed "the disk wins", so it resumes that way once (projectFolderLink).
   * null when the working copy was just built from the folder.
   */
  baseline?: FolderBaseline | null
  /** the working copy is only a stand-in for the folder: the folder wins whole once readable */
  trustDisk?: boolean
}

/** IndexedDB is absent in a Node test env, in some private modes, and behind blocked storage. Every
 *  call below no-ops or returns null rather than throwing, so a browser without it keeps a
 *  session-only link. */
export function supportsHandleMemory(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  if (!supportsHandleMemory()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null) // blocked storage
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    // A failed open is not actionable and must never break editing: the link just does not survive
    // this session's reloads.
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/** Run `body` in a transaction and resolve on commit, not on the request's success. documentStore
 *  does the same, for the same reason: a resolve on onsuccess can return before the write is
 *  durable, and a link remembered that way would not survive the reload it exists for. */
async function inTx<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => Promise<T> | T): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<T | null>((resolve) => {
      let out: T | undefined
      let failed = false
      let tx: IDBTransaction
      try {
        tx = db.transaction([STORE], mode)
      } catch {
        return resolve(null)
      }
      tx.oncomplete = () => resolve(failed ? null : (out as T))
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
      void Promise.resolve(body(tx.objectStore(STORE))).then(
        (v) => (out = v),
        () => (failed = true),
      )
    })
  } finally {
    db.close()
  }
}

function request<T>(req: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(undefined)
  })
}

/**
 * Remember `handle` as the folder document `docId` follows. A null id (a browser with no document
 * pointer at all) is a no-op: there is nothing to key it to, and guessing would attach the folder to
 * whatever document happened to open next.
 *
 * Structured-clone can still refuse - a stub in a test, a handle from a context that cannot be
 * cloned - so the put is wrapped: failing to remember a link must not break the link itself.
 */
export async function rememberFolderHandle(
  docId: string | null,
  handle: unknown,
  signature: string,
  sync: { baseline?: FolderBaseline | null; trustDisk?: boolean } = {},
): Promise<void> {
  if (docId === null || docId === '') return
  await inTx('readwrite', (store) => {
    try {
      store.put({ id: docId, handle, signature, ...sync })
    } catch {
      /* not cloneable: this session's link still works, it just will not survive a reload */
    }
  })
}

/** The folder remembered for `docId`, or null when there is none (or no storage to hold one). A row
 *  written before signatures were stored reads as an empty one, which means "assume changed". */
export async function recallFolderHandle(docId: string | null): Promise<RememberedFolder | null> {
  if (docId === null) return null
  const row = (await inTx('readonly', (store) => request(store.get(docId)))) as
    | { handle?: unknown; signature?: unknown; baseline?: FolderBaseline | null; trustDisk?: unknown }
    | null
    | undefined
  if (row?.handle === undefined || row.handle === null) return null
  return {
    handle: row.handle,
    signature: typeof row.signature === 'string' ? row.signature : '',
    ...(row.baseline !== undefined ? { baseline: row.baseline } : {}),
    ...(row.trustDisk === true ? { trustDisk: true } : {}),
  }
}

/** Forget `docId`'s folder - the user unlinked, or the handle turned out to be unusable. */
export async function forgetFolderHandle(docId: string | null): Promise<void> {
  if (docId === null) return
  await inTx('readwrite', (store) => void store.delete(docId))
}
