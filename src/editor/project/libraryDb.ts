// The library's IndexedDB database and the pointer to the open document, beneath both documentStore.ts (the projects
// list) and projectFile.ts (the open document's saves). Both write the same rows: the open document's row is its
// working copy (docs/projects.md "The browser working copy").
//
// A row's payload is the project as text, `{ id, text }`, compact and with stored models named by hash
// (localAssets.ts), as the save path already serialises it. Rows written before that hold the project as an object,
// `{ id, project }`, and are read as they are.

import { serializeProject } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { withLocalAssets } from './localAssets'

const DB_NAME = 'oip-web'
const DB_VERSION = 1
/** id -> {id, name, updatedAt}: read by the projects list, so a listing never deserializes a whole project */
export const INDEX_STORE = 'docIndex'
/** id -> { id, text } (or { id, project } from before): the payloads, read only when a document is actually opened */
export const PAYLOAD_STORE = 'docPayload'

/**
 * Which document is open. Web storage, not IndexedDB: the boot path wants it synchronously, and it is twenty bytes.
 * Each tab keeps its own in sessionStorage, which survives the reload a switch makes, so tabs on different projects
 * never move each other. localStorage keeps the one opened last, which a new tab starts on.
 */
export const CURRENT_DOC_KEY = 'oip-web/document-id'
/** In a tab's sessionStorage, the empty string means the tab has no document: it must not fall back to the browser's. */
const NO_DOCUMENT = ''

/** A document as the projects list shows it - never the payload. */
export interface DocumentMeta {
  id: string
  name: string
  /** ms since epoch of the last write of its row */
  updatedAt: number
}

/** IndexedDB is absent in a Node test env, in some private modes, and behind blocked storage. Every
 *  call below no-ops or returns empty rather than throwing, so a browser without it keeps the plain
 *  single-document behaviour. */
export function supportsDocumentLibrary(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  if (!supportsDocumentLibrary()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null) // blocked storage
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) db.createObjectStore(PAYLOAD_STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    // A failed open is not something the user can act on, and it must never break editing: the callers report a
    // failed write, and a failed read opens nothing.
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/** Run `body` in a transaction and resolve when it commits (oncomplete), not when a request succeeds. A
 *  resolve on onsuccess can return before the write is durable, and a switch-then-reload would then
 *  lose the snapshot it just took. */
export async function inTx<T>(mode: IDBTransactionMode, body: (index: IDBObjectStore, payload: IDBObjectStore) => Promise<T> | T): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<T | null>((resolve) => {
      let out: T | undefined
      let failed = false
      const tx = db.transaction([INDEX_STORE, PAYLOAD_STORE], mode)
      tx.oncomplete = () => resolve(failed ? null : (out as T))
      tx.onerror = () => resolve(null)
      tx.onabort = () => resolve(null)
      void Promise.resolve(body(tx.objectStore(INDEX_STORE), tx.objectStore(PAYLOAD_STORE))).then(
        (v) => (out = v),
        () => (failed = true),
      )
    })
  } catch {
    return null
  } finally {
    db.close()
  }
}

export function request<T>(req: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(undefined)
  })
}

/** A row's project text, whichever form it was written in; null when it holds neither. */
export function payloadText(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as { text?: unknown; project?: unknown }
  if (typeof r.text === 'string') return r.text
  return r.project === undefined ? null : JSON.stringify(r.project)
}

/** A project as a row stores it: compact, with its stored models by hash. */
export function rowText(project: ProjectJSON): string {
  return serializeProject(withLocalAssets(project), { pretty: false })
}

/** Write one row's text and listing. Resolves true once the transaction has committed. */
export async function writeRowText(id: string, name: string, text: string, at = Date.now()): Promise<boolean> {
  const meta: DocumentMeta = { id, name, updatedAt: at }
  const ok = await inTx('readwrite', (index, payload) => {
    index.put(meta)
    payload.put({ id, text })
    return true
  })
  return ok === true
}

/** One row's text and when it was written, or null when there is no such row (or no library). */
export async function readRowText(id: string): Promise<{ text: string; updatedAt: number } | null> {
  const got = await inTx('readonly', async (index, payload) => {
    const [meta, row] = await Promise.all([request(index.get(id) as IDBRequest<DocumentMeta | undefined>), request(payload.get(id) as IDBRequest<unknown>)])
    return { meta, row }
  })
  const text = payloadText(got?.row)
  return text === null ? null : { text, updatedAt: got?.meta?.updatedAt ?? 0 }
}

/** Every row's text, for the asset sweep (localAssets.sweepLocalAssets): only text rows can name a model by hash. */
export async function allRowTexts(): Promise<string[] | null> {
  const rows = await inTx('readonly', (_index, payload) => request(payload.getAll() as IDBRequest<unknown[]>))
  if (rows === null) return null
  return (rows ?? []).flatMap((r) => {
    const t = (r as { text?: unknown } | null)?.text
    return typeof t === 'string' ? [t] : []
  })
}

// ── the open document ──────────────────────────────────────────────────────────────────────────────────

/** The tab's own pointer as stored ('' for none), or null when the tab has not taken one (or has no sessionStorage). */
function tabPointer(): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(CURRENT_DOC_KEY)
  } catch {
    return null
  }
}

function setTabPointer(value: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(CURRENT_DOC_KEY, value)
  } catch {
    /* blocked storage: the tab follows the browser's pointer, as every tab did before tabs had their own */
  }
}

/** The open document's id, or null when this tab has none (a first-ever visit, a discard, or storage off). */
export function currentDocumentId(): string | null {
  const tab = tabPointer()
  if (tab !== null) return tab === NO_DOCUMENT ? null : tab
  try {
    return localStorage.getItem(CURRENT_DOC_KEY)
  } catch {
    return null
  }
}

/** The document a new desktop window was opened on (`?doc=`, apps/desktop/main.cjs openDocumentWindow), or null. */
function entryDocument(): string | null {
  if (typeof location === 'undefined') return null
  try {
    const id = new URL(location.href).searchParams.get('doc')
    return id !== null && /^doc-[a-z0-9-]+$/.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Give this tab its own pointer when it has none yet: the document its URL names, else the browser's. Called once
 * before the boot reads the working copy (projectFile.openWorkingCopy), so a later switch in another tab cannot move
 * this one. A reload keeps the tab's pointer, whatever the URL says.
 */
export function pinTabDocument(): void {
  if (tabPointer() === null) {
    const asked = entryDocument()
    if (asked !== null) setCurrentDocumentId(asked)
    else setTabPointer(currentDocumentId() ?? NO_DOCUMENT)
  }
  const id = currentDocumentId()
  if (id !== null) holdDocument(id)
}

export function setCurrentDocumentId(id: string): void {
  setTabPointer(id)
  try {
    localStorage.setItem(CURRENT_DOC_KEY, id)
  } catch {
    /* blocked storage: the library just cannot follow which document is open */
  }
  holdDocument(id)
}

/**
 * Cut the open document loose from its record, so the next save files what is on screen as a new one. An unopened
 * project's discard does this: its record is left exactly as it was.
 */
export function forgetCurrentDocument(): void {
  const id = currentDocumentId()
  setTabPointer(NO_DOCUMENT)
  try {
    if (localStorage.getItem(CURRENT_DOC_KEY) === id) localStorage.removeItem(CURRENT_DOC_KEY)
  } catch {
    /* blocked storage: there is no library to confuse in the first place */
  }
  holdDocument(null)
}

// ── which documents other tabs have open ────────────────────────────────────────────────────────────
//
// Each tab holds a shared Web Lock named for its document while it has one open. The browser releases it when the
// tab closes or crashes, so the projects list can ask which documents are open anywhere (navigator.locks.query)
// without any tab having to say goodbye. Shared, so two tabs on one document both hold it.

const LOCK_PREFIX = 'oip-web/open-document/'

let held: { id: string; release: () => void } | null = null

function holdDocument(id: string | null): void {
  if (held?.id === id) return
  held?.release()
  held = null
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (id === null || !locks) return
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  held = { id, release }
  locks.request(LOCK_PREFIX + id, { mode: 'shared' }, () => released).catch(() => {})
}

/**
 * The documents open in some tab of this browser, this one's included. Null where the browser cannot tell
 * (no Web Locks), and then a caller treats only its own document as open.
 */
export async function documentsOpenInTabs(): Promise<Set<string> | null> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return null
  try {
    const { held: all = [] } = await locks.query()
    return new Set(all.flatMap((l) => (l.name?.startsWith(LOCK_PREFIX) ? [l.name.slice(LOCK_PREFIX.length)] : [])))
  } catch {
    return null
  }
}

/** Ids are minted here rather than derived from the name, so renaming never re-homes a record and two
 *  documents may share a name - they are different work, and only the id is identity. */
export function mintDocumentId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const documentChangeListeners = new Set<(id: string) => void>()

/**
 * Hear when the open document gets a different id without a reload: an in-place adoption
 * (documentStore.adoptDocumentInPlace), a demo fork, or the first id minted for the document on screen. Anything
 * keyed by documentStore.sceneSlotKey has to move with it. Never fired by the switches that reload.
 */
export function onCurrentDocumentChange(cb: (id: string) => void): () => void {
  documentChangeListeners.add(cb)
  return () => documentChangeListeners.delete(cb)
}

export function announceCurrentDocument(id: string): void {
  setCurrentDocumentId(id)
  for (const cb of documentChangeListeners) cb(id)
}
