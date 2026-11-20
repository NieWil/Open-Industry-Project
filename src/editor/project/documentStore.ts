// The document library: the browser-local store that lets a browser hold more than one project, so
// recents and the project manager have something to list.
//
// Every project is one row in IndexedDB `oip-web` (libraryDb.ts), and the open project's row is its working copy:
// each commit is written there (projectFile.saveStoredProject), and nothing else holds a second copy of it in the
// browser. IndexedDB is sized to the disk, where localStorage holds a few MB.
//
// Switching moves the pointer to the chosen document and reloads, reusing the tested boot path
// (same as .oip import and desktop folder open). Swapping in place does not work: the outgoing library's
// registrations shadow the incoming document's snapshots (projectFile.adoptImportedProject).
//
// The seam is narrow (list / read / write / delete + a current-document pointer), so a folder-backed
// implementation can sit behind the same calls later. This one needs no picker and works in every browser.

import { clearEntryParams } from './entryParams'
import { validateProject } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { dropDocumentKeys, flushWorkingCopy, parkSplitOff, saveStoredProject, WORKING_COPY_UNSTORED, workingCopyRefusal } from './projectFile'
import { loadLocalAssets, localAssetReviver, storeLocalAssets } from './localAssets'
import type { SaveResult } from './projectFile'
import {
  announceCurrentDocument,
  currentDocumentId,
  inTx,
  mintDocumentId,
  payloadText,
  request,
  rowText,
  setCurrentDocumentId,
  supportsDocumentLibrary,
  writeRowText,
} from './libraryDb'
import type { DocumentMeta } from './libraryDb'

export { CURRENT_DOC_KEY, currentDocumentId, documentsOpenInTabs, mintDocumentId, onCurrentDocumentChange, supportsDocumentLibrary } from './libraryDb'
export type { DocumentMeta } from './libraryDb'

/**
 * The scene half of a {@link sceneSlotKey}. A project holds one scene since format 4, so it is a constant - the id
 * every project's first scene had, so the cameras and tutorial runs saved under `<doc>/scene-1` before then still
 * find their project.
 */
export const SCENE_SLOT = 'scene-1'

/**
 * The key for workspace state kept per scene of the open document (its remembered camera, a half-finished
 * tutorial run): the document id and the scene id together. Scene ids are only unique within a project and
 * every project has a `scene-1`. With a bare id, one project's camera would be restored in another's scene,
 * and a tutorial run (which writes a program) could resume in a project it was never started in. Bare when there is no
 * document id (no library: one document, nothing to confuse it with).
 */
export function sceneSlotKey(sceneId: string): string {
  const doc = currentDocumentId()
  return doc === null ? sceneId : `${doc}/${sceneId}`
}

/**
 * Is `slot` a {@link sceneSlotKey} of a different document than the open one? Then a scene it names is not
 * missing from this project - that project is not the one open (a switch in the projects list, a folder linked in
 * place), and state kept under it must be left for when it is. A bare slot, from before slots named their
 * document, is not another document's.
 */
export function isOtherDocumentSlot(slot: string): boolean {
  const doc = slotDocumentId(slot)
  return doc !== null && doc !== currentDocumentId()
}

/** The document a {@link sceneSlotKey} names, or null for a bare (pre-document) slot. Document ids are minted
 *  as `doc-…` with no slash (mintDocumentId), so the first slash ends one. */
export function slotDocumentId(slot: string): string | null {
  return /^(doc-[^/]+)\//.exec(slot)?.[1] ?? null
}

/** Whether this browser has already been asked to make the library durable. A refusal is remembered:
 *  Firefox prompts for `persist()`, and re-prompting every time the projects list opens would be a nag. */
const DURABLE_ASKED_KEY = 'oip-web/storage-asked'

/**
 * Ask the browser to keep the library durable (`navigator.storage.persist`).
 *
 * Without it IndexedDB is best-effort: a browser under storage pressure may evict a site's data, and
 * the library holds every project the user has made. With it, the data stays until they delete it.
 *
 * Called from the projects list once it holds more than one project, not at boot. Firefox shows a permission
 * prompt for this, and a first-ever visit should not open with a prompt. Asked while someone is looking
 * at their list of projects, the prompt is about what is on screen. Chromium decides from its own
 * engagement heuristics without prompting, so there the call shows nothing.
 */
export async function requestDurableStorage(): Promise<boolean> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
  if (!storage?.persist || !storage.persisted) return false
  try {
    if (await storage.persisted()) return true // already granted: never re-ask
    let asked = false
    try {
      asked = localStorage.getItem(DURABLE_ASKED_KEY) === '1'
      localStorage.setItem(DURABLE_ASKED_KEY, '1')
    } catch {
      /* blocked storage: ask anyway, we cannot remember that we did */
    }
    if (asked) return false
    return await storage.persist()
  } catch {
    return false // unsupported or blocked: the library stays best-effort, exactly as it was
  }
}

/** The projects list's rows, most-recently-touched first. Empty when there is no library. */
export async function listDocuments(): Promise<DocumentMeta[]> {
  const rows = await inTx('readonly', (index) => request(index.getAll() as IDBRequest<DocumentMeta[]>))
  return (rows ?? [])
    .filter((r): r is DocumentMeta => !!r && typeof r.id === 'string' && typeof r.name === 'string')
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** One document's project, validated. null when absent, corrupt, or unreadable. */
export async function readDocument(id: string): Promise<ProjectJSON | null> {
  return (await readDocumentSplit(id))?.project ?? null
}

/** {@link readDocument}, with an older multi-scene document's other scenes (core/project/project.ts `splitOff`). */
async function readDocumentSplit(id: string): Promise<{ project: ProjectJSON; splitOff?: ProjectJSON[] } | null> {
  const row = await inTx('readonly', (_index, payload) => request(payload.get(id) as IDBRequest<unknown>))
  const text = payloadText(row)
  if (text === null) return null
  // its models named by hash come back from the asset store first; a row whose models are gone is not opened
  if ((await loadLocalAssets([text])).length > 0) return null
  try {
    const missing: string[] = []
    const result = validateProject(JSON.parse(text, localAssetReviver(missing)))
    return result.ok && missing.length === 0 ? result : null
  } catch {
    return null
  }
}

/** Upsert a document: its row's text (libraryDb.rowText) and its listing. */
export async function writeDocument(id: string, project: ProjectJSON, at = Date.now()): Promise<boolean> {
  return writeRowText(id, project.name, rowText(project), at)
}

export async function deleteDocument(id: string): Promise<boolean> {
  const ok = await inTx('readwrite', (index, payload) => {
    index.delete(id)
    payload.delete(id)
    return true
  })
  if (ok === true) dropDocumentKeys(id)
  return ok === true
}

/** Relabel a document without opening it. The open one is renamed through store.renameProject, whose
 *  next sync carries the new name here; this is for the other rows in the projects list. */
export async function renameDocument(id: string, name: string): Promise<boolean> {
  const trimmed = name.trim()
  if (trimmed === '') return false
  const project = await readDocument(id)
  if (!project) return false
  project.name = trimmed
  return writeDocument(id, project)
}

/**
 * Write `project` into the open document's record, minting the record on first use. Before a switch, and for the
 * project a demo fork leaves.
 */
export async function syncCurrentDocument(project: ProjectJSON): Promise<string | null> {
  if (!supportsDocumentLibrary()) return null
  // What is on screen is not the document the pointer names: the working copy holds one this session could
  // not open, or another tab has written it since. Filing the screen under that record would replace it.
  if (workingCopyRefusal() !== null) return null
  let id = currentDocumentId()
  // a minted id always names the document on screen (nothing else has one yet), so it is announced
  if (id === null) {
    id = mintDocumentId()
    announceCurrentDocument(id)
  }
  // the autosave writes the same row: its last write lands first, so it cannot land over this one
  await flushWorkingCopy()
  return (await writeDocument(id, project)) ? id : null
}

/**
 * Make what is on screen a new document, in place and at once: file `outgoing` (the project being left) under
 * the id it has, then announce a fresh id for the one on screen. Returns that id, or null where there is no
 * library to file into (or the working copy is not this session's to replace) - the caller then keeps the
 * document it has.
 *
 * Synchronous: its one caller is the demo fork (store.stashDemoSession), which runs inside the
 * first edit's persist, so nothing can wait. The filing itself is async, and it is safe to start it here and
 * not await it: syncCurrentDocument reads the outgoing document's id before its first await, so the announce
 * below cannot redirect it. It cannot promise the write completes, so the demo also files the
 * project it was opened from when it is opened (sceneFile.openDemoScene), seconds before any edit.
 * No reload, because none is needed: the scene on screen is already the new document's.
 */
export function forkCurrentDocument(outgoing: ProjectJSON): string | null {
  if (!supportsDocumentLibrary() || workingCopyRefusal() !== null) return null
  void syncCurrentDocument(outgoing)
  const id = mintDocumentId()
  announceCurrentDocument(id)
  return id
}

export { clearEntryParams }

/**
 * File the project being left before something replaces the working copy. Returns why that must not go
 * ahead, or null when it may: the working copy is not this session's to replace (projectFile.workingCopyRefusal),
 * or the library exists and would not take the outgoing project - in which case replacing the working copy
 * could lose what it holds, so the caller stops. With no library at all there is nothing to file and replacing is the
 * documented single-document behaviour.
 *
 * Every path that replaces the open project goes through this: the projects list's open and new, a linked folder,
 * a .oip import and the desktop folder open.
 */
export async function fileOutgoingDocument(outgoing: ProjectJSON | null): Promise<string | null> {
  const refused = workingCopyRefusal()
  if (refused !== null) return refused
  if (!outgoing || !supportsDocumentLibrary()) return null
  return (await syncCurrentDocument(outgoing)) === null
    ? 'The project you have open could not be filed in this browser, so nothing was replaced. Export it (.oip) to keep a copy.'
    : null
}

/**
 * Write `project` as document `id`'s working copy, then move the pointer to it and boot into it. Returns a message on
 * failure and does not reload: a failed write followed by a reload would boot the old document and the switch would
 * vanish with no explanation (the same failure adoptImportedProject documents).
 *
 * `project` null boots the row as it is stored. Nothing is written, so another tab with that document open is not
 * told it changed.
 */
async function bootInto(id: string, project: ProjectJSON | null, bootAt?: string): Promise<string | null> {
  if (project !== null) {
    // its models go to the asset store first, so the working copy can name them by hash (localAssets.ts)
    await storeLocalAssets(project)
    const saved: SaveResult = saveStoredProject(project, { doc: id })
    if (!saved.ok) return saved.message
  }
  // a reload must not overtake the write it boots from, or the outgoing document's last autosave
  if (!(await flushWorkingCopy())) return WORKING_COPY_UNSTORED
  setCurrentDocumentId(id)
  if (bootAt !== undefined) {
    if (typeof location !== 'undefined') location.assign(bootAt)
    return null
  }
  clearEntryParams()
  if (typeof location !== 'undefined') location.reload()
  return null
}

/** Make `id` the open document and boot into it: file the outgoing one, then {@link bootInto} it. */
export async function openDocument(id: string, outgoing: ProjectJSON | null): Promise<string | null> {
  const read = await readDocumentSplit(id)
  if (!read) return 'That project could not be read from this browser storage.'
  const project = read.project
  const refused = await fileOutgoingDocument(outgoing)
  if (refused !== null) return refused
  // An older multi-scene document: its other scenes are parked for the next boot to file as projects of their own,
  // and its record is rewritten as the one scene it keeps, so opening it again does not split it a second time.
  if (read.splitOff) {
    const parked = parkSplitOff(read.splitOff)
    if (!parked.ok) return parked.message
    await writeDocument(id, project)
  }
  // the row read above opens, so the boot reads it as it is
  return bootInto(id, null)
}

/**
 * Make `project` the open document in place: file the outgoing one, write the incoming one into the working
 * copy, give it a record of its own, then `apply` it to the store. Returns a message on failure, having
 * replaced nothing.
 *
 * For the one adoption that cannot reload: a linked folder (projectFolderLink), whose handle lives only in
 * this page. store.loadProject alone is not enough: it saves the folder's project over the working copy
 * while the pointer still names the project that was open, so the library's next sync files the folder
 * into that project's record, and the project you linked from is gone from both places.
 *
 * `apply` runs synchronously after the pointer moves, so no autosave can write the outgoing store state under the
 * incoming document's id in between.
 */
export async function adoptDocumentInPlace(project: ProjectJSON, outgoing: ProjectJSON | null, apply: () => void): Promise<string | null> {
  const refused = await fileOutgoingDocument(outgoing)
  if (refused !== null) return refused
  const id = supportsDocumentLibrary() ? mintDocumentId() : undefined
  await storeLocalAssets(project)
  // written ahead of apply (which saves again) so a failed write stops here, before the pointer moves
  const saved: SaveResult = saveStoredProject(project, id !== undefined ? { doc: id } : undefined)
  if (!saved.ok) return saved.message
  if (id !== undefined) {
    if (!(await flushWorkingCopy())) return WORKING_COPY_UNSTORED
    announceCurrentDocument(id)
  }
  apply()
  return null
}

/**
 * File the outgoing document, then boot into a brand new one. A new project is just a document whose
 * payload is `blank`. Same write-then-reload sequence as {@link openDocument}, for the same reason.
 *
 * `bootAt`: the URL to boot the new document at, when reloading this one would not reach it - a room's copy
 * (roomCopy.ts), where a reload would rejoin the room. A navigation, not a history rewrite, so Back still
 * leads to the page that was left.
 */
export async function createDocument(blank: ProjectJSON, outgoing: ProjectJSON | null, bootAt?: string): Promise<string | null> {
  const refused = await fileOutgoingDocument(outgoing)
  if (refused !== null) return refused
  const id = mintDocumentId()
  const filed = await writeDocument(id, blank)
  if (!filed && supportsDocumentLibrary()) return 'This browser would not store a new project.'
  return bootInto(id, blank, bootAt)
}
