// Linked project folder: the browser half of "a project lives in its folder".
//
// On the desktop every project lives in a folder the Electron shell reads and writes. The browser gets
// the same thing through the File System Access API. The user picks a folder once (Link, or Save to
// Folder), and the page keeps a handle to it. From then on the same engine the desktop runs
// (projectFolderSync.ts) keeps the project and the folder in sync both ways. Edits here are written there
// a moment after they are made, changes made there (an agent, an editor, git) load here, and the same
// file changed in both places is a conflict the user settles. There is no server and no upload: both
// sides read the same directory on the same disk.
//
// This module is the browser host for that engine: the pickers, the permission requests, remembering the
// handle per document (folderHandleStore.ts), and `browserFolderApi`, which adapts a directory handle to
// the engine's FolderApi. That covers reads, the change fingerprint, and guarded writes: a file is replaced
// only if it still holds what the engine last read, so an agent's write arriving at the same moment is
// reported, not overwritten. A read-only link that never wrote back would lose in-app edits on the next
// external change.
//
// Polling, not observing: FileSystemObserver is still unstandardized, so the engine checks a cheap
// fingerprint once a second (sizes and dates; contents only when it moved), bounded to project.json and
// the format's known subdirectories (PROJECT_SUBDIRS).
//
// Chromium only - Safari and Firefox have OPFS (a private sandbox the user never sees) but no picker for
// a real folder, so `supportsFolderLink()` is false there and the commands are greyed out. The desktop
// has its own host (desktopProjectApi.ts), so none of this runs there.

import { folderFilesToProject, PROJECT_MANIFEST, PROJECT_ROOT_FILES, PROJECT_SUBDIRS } from '../../core/project/projectFolder'
import type { ProjectFolderFile } from '../../core/project/projectFolder'
import type { ProjectJSON } from '../../core/project/project'
import { hashContents } from '../../core/hash'
import { isAssetFileInTree } from '../../core/parts/partAssets'
import type { FolderBaseline, FolderWriteOp, FolderWriteResult } from '../../core/project/folderSync'
import { bakePart } from '../parts/bakePart'
import { adoptDocumentInPlace, currentDocumentId, supportsDocumentLibrary } from './documentStore'
import { forgetFolderHandle, recallFolderHandle, rememberFolderHandle } from './folderHandleStore'
import type { RememberedFolder } from './folderHandleStore'
import { getOipProjectApi } from '../desktop/desktopProjectApi'
import { detachProjectFolder, followFolder, releaseFolder, saveIntoFolder, syncFolderNow, syncedFolderPath } from './projectFolderSync'
import type { FolderApi } from './projectFolderSync'
import type { EditorStore } from '../store/store'

/** The subdirectories a project folder holds (the codec's own list): reading exactly these (plus the root
 *  manifest) keeps the sweep bounded and predictable. */
const SUBDIRS = PROJECT_SUBDIRS
const ROOT_FILES = PROJECT_ROOT_FILES

/**
 * The slice of FileSystemDirectoryHandle this module uses. Structural rather than the DOM type so the
 * sweep + assembly can be unit-tested against a plain object - the picker itself is undrivable from a
 * test browser, so everything ELSE has to be reachable without it.
 */
export interface DirLike {
  name: string
  entries(): AsyncIterableIterator<[string, FileLike | DirLike]>
}

export interface FileLike {
  kind: 'file'
  name: string
  getFile(): Promise<{ lastModified: number; size: number; text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }>
}

/** A file's contents in the codec's form: an asset file's bytes (core/parts/partAssets.ts), every other file's text. */
async function contentsOf(path: string, file: { text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }): Promise<string | Uint8Array> {
  if (!isAssetFileInTree(path)) return file.text()
  if (typeof file.arrayBuffer !== 'function') throw new Error(`this folder handle cannot read ${path} as bytes`)
  return new Uint8Array(await file.arrayBuffer())
}

/** The extra slice needed to write a folder (the picker grants this with mode 'readwrite'). Separate
 *  from {@link DirLike} so the read path can never accidentally write. `getFile` and `removeEntry` are
 *  what the guarded writes of a two-way link add: read the file before replacing it, delete a file the
 *  project no longer has. */
export interface WritableDirLike extends DirLike {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<WritableDirLike>
  getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<{
    getFile?(): Promise<{ text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }>
    createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>
  }>
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>
}

const isFile = (h: FileLike | DirLike): h is FileLike => (h as FileLike).kind === 'file'

/** Does this browser let a page open a real folder? (Chromium yes; Safari/Firefox no.) */
export function supportsFolderLink(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/**
 * The permission slice of a real FileSystemDirectoryHandle, on top of the read slice above.
 *
 * Both are optional because a remembered handle is only as good as the permission behind it, and the
 * absence of the API is not the same question as the absence of access: a test stub has neither
 * method, and treating that as "allowed" is safe because the sync already handles access that turns
 * out to be gone (it stops and banners). Asked about `readwrite`: the link writes back.
 */
export interface PermissionedDir extends DirLike {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

/** `query` (no gesture needed, safe at boot) or `request` (needs transient user activation, so it
 *  must be reached from a click). A handle that throws is treated as denied: unusable either way. */
async function permissionOf(dir: PermissionedDir, ask: boolean): Promise<PermissionState> {
  const fn = ask ? dir.requestPermission : dir.queryPermission
  if (typeof fn !== 'function') return 'granted'
  try {
    return await fn.call(dir, { mode: 'readwrite' })
  } catch {
    return 'denied'
  }
}

/** Walk the root files + the known subdirectories into the codec's {path, contents} shape. */
export async function readProjectFolderFiles(dir: DirLike): Promise<ProjectFolderFile[]> {
  const files: ProjectFolderFile[] = []
  for await (const [name, handle] of dir.entries()) {
    if ((ROOT_FILES as readonly string[]).includes(name) && isFile(handle)) {
      files.push({ path: name, contents: await (await handle.getFile()).text() })
    }
  }
  for await (const [name, handle] of dir.entries()) {
    if (isFile(handle) || !(SUBDIRS as readonly string[]).includes(name)) continue
    await collect(handle, name, files, 0)
  }
  return files
}

async function collect(dir: DirLike, prefix: string, out: ProjectFolderFile[], depth: number): Promise<void> {
  if (depth > 2) return // parts/<id>/assets/<sha256>.glb is the deepest the format goes
  for await (const [name, handle] of dir.entries()) {
    const path = `${prefix}/${name}`
    if (isFile(handle)) out.push({ path, contents: await contentsOf(path, await handle.getFile()) })
    else await collect(handle, path, out, depth + 1)
  }
}

/**
 * Spill {@link ProjectFolderFile}s into a real folder, creating subdirectories as needed. The inverse
 * of {@link readProjectFolderFiles}: same `projectToFolderFiles` content, so a folder written here is
 * byte-identical to one written by the desktop or unzipped from a .oip. Only ever writes the paths the
 * codec produces, and never deletes.
 */
export async function writeProjectFolderFiles(dir: WritableDirLike, files: readonly ProjectFolderFile[]): Promise<void> {
  for (const f of files) await writeFileAt(dir, f.path.split('/'), f.contents)
}

async function writeFileAt(dir: WritableDirLike, segments: readonly string[], contents: string | Uint8Array): Promise<void> {
  let target = dir
  for (const segment of segments.slice(0, -1)) target = await target.getDirectoryHandle(segment, { create: true })
  const handle = await target.getFileHandle(segments[segments.length - 1]!, { create: true })
  // createWritable writes to a swap file and moves it into place on close(): a reader (an agent, git)
  // never sees half a file
  const writable = await handle.createWritable()
  await writable.write(contents)
  await writable.close()
}

/** The file's contents ({@link contentsOf}), or null when it (or a folder on its way) does not exist. */
async function readFileAt(dir: WritableDirLike, segments: readonly string[]): Promise<string | Uint8Array | null> {
  try {
    let target = dir
    for (const segment of segments.slice(0, -1)) target = await target.getDirectoryHandle(segment)
    const handle = await target.getFileHandle(segments[segments.length - 1]!)
    if (typeof handle.getFile !== 'function') throw new Error('this folder handle cannot read files back')
    return await contentsOf(segments.join('/'), await handle.getFile())
  } catch (e) {
    if (e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null
    throw e
  }
}

/** Delete a file, then any folder the delete emptied below the format's own (a part folder whose two
 *  files are both gone). */
async function removeFileAt(dir: WritableDirLike, segments: readonly string[]): Promise<void> {
  const parents: WritableDirLike[] = [dir]
  try {
    for (const segment of segments.slice(0, -1)) parents.push(await parents[parents.length - 1]!.getDirectoryHandle(segment))
  } catch (e) {
    if (e instanceof Error && e.name === 'NotFoundError') return // already gone
    throw e
  }
  const parent = parents[parents.length - 1]!
  if (typeof parent.removeEntry !== 'function') throw new Error('this folder handle cannot delete files')
  try {
    await parent.removeEntry(segments[segments.length - 1]!)
  } catch (e) {
    if (!(e instanceof Error && e.name === 'NotFoundError')) throw e
  }
  // prune upward, but never the format's own folders (depth 1: scenes/, parts/, tests/, and the retired assemblies/)
  for (let i = parents.length - 1; i >= 2; i--) {
    const child = parents[i]!
    let empty = true
    for await (const _entry of child.entries()) {
      empty = false
      break
    }
    if (!empty) return
    try {
      await parents[i - 1]!.removeEntry?.(segments[i - 1]!)
    } catch {
      return
    }
  }
}

/** Reject paths that could leave the folder (the renderer builds them, but a write is a write). */
function safeSegments(path: string): string[] | null {
  const segments = path.split('/')
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes('\\') && !s.includes(':')) ? segments : null
}

/**
 * Guarded writes over a directory handle - the browser twin of the Electron shell's applyFolderWrites
 * (apps/desktop/projectFolderIo.cjs): each op is applied only if the file still hashes to `expect`, a file
 * that moved is reported in `moved`, and one failure does not hold back the rest. The check and the
 * write are two steps here (the API has no compare-and-swap), so the guard narrows the window an agent's
 * write could fall into to milliseconds rather than closing it; the next round's read still sees both.
 */
async function applyWrites(dir: WritableDirLike, ops: readonly FolderWriteOp[]): Promise<FolderWriteResult> {
  const moved: string[] = []
  const failed: string[] = []
  let error: string | null = null
  for (const op of ops) {
    const segments = safeSegments(op.path)
    try {
      if (!segments) throw new Error('invalid path')
      if (op.expect !== '*') {
        const current = await readFileAt(dir, segments)
        if ((current === null ? null : hashContents(current)) !== op.expect) {
          moved.push(op.path)
          continue
        }
      }
      if (op.contents === undefined) await removeFileAt(dir, segments)
      else await writeFileAt(dir, segments, op.contents)
    } catch (e) {
      failed.push(op.path)
      error ??= `couldn't write ${op.path}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { moved, failed, error }
}

/** Does this folder already hold a project? Used to confirm before writing over one. */
export async function hasProjectManifest(dir: DirLike): Promise<boolean> {
  for await (const [name, handle] of dir.entries()) if (name === PROJECT_MANIFEST && isFile(handle)) return true
  return false
}

/**
 * A cheap fingerprint of the folder: every file's path, size and mtime, sorted. Compared between
 * checks to decide whether anything actually changed, so the common case (nothing happened) never
 * reads a single file's contents. Sorted because directory iteration order is not guaranteed stable
 * across platforms, and an order flip would otherwise read as an edit.
 */
export async function folderSignature(dir: DirLike): Promise<string> {
  const parts: string[] = []
  await sign(dir, '', parts, 0)
  return parts.sort().join('\n')
}

async function sign(dir: DirLike, prefix: string, out: string[], depth: number): Promise<void> {
  if (depth > 3) return
  for await (const [name, handle] of dir.entries()) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (isFile(handle)) {
      if (prefix === '' && !(ROOT_FILES as readonly string[]).includes(name)) continue // ignore stray root files
      const f = await handle.getFile()
      out.push(`${path}:${f.size}:${f.lastModified}`)
    } else if (prefix !== '' || (SUBDIRS as readonly string[]).includes(name)) {
      await sign(handle, path, out, depth + 1)
    }
  }
}

/** Read + reassemble + validate the folder: its project, or the error text a human should see. Reading
 *  can throw (a folder moved or deleted, a permission withdrawn), so it is caught here, not left to the
 *  caller's unawaited boundary to surface as an unhandled rejection. */
async function readFolderProject(dir: DirLike): Promise<{ project: ProjectJSON } | { error: string }> {
  let files: ProjectFolderFile[]
  try {
    files = await readProjectFolderFiles(dir)
  } catch (e) {
    return { error: `Couldn't read "${dir.name}": ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!files.some((f) => f.path === PROJECT_MANIFEST)) {
    return { error: `No ${PROJECT_MANIFEST} in "${dir.name}" - pick the folder that contains it.` }
  }
  const result = folderFilesToProject(files, { bakePart })
  if (!result.ok) return { error: result.errors.join('\n') }
  // An older multi-scene folder splits into a folder per scene (projectSplit.ts), and a browser can make no folder
  // beside this one: following it would move its other scenes out of the folder and into this browser's storage.
  // Refused, with nothing changed, rather than do that quietly.
  if (result.splitOff) {
    return {
      error: `"${dir.name}" holds ${result.splitOff.length + 1} scenes, in the format from before a project held one. Open it in the desktop app, which splits it into a folder per scene; a browser cannot make those folders.`,
    }
  }
  return { project: result.project }
}

/** Whatever can leave the scene on screen cleanly before it is replaced - a running sim stopped, a focus or
 *  master-edit session left (EditorController.leaveForSceneSwap). Structural, so a test can pass a stub. */
export type SceneSwapGuard = { leaveForSceneSwap(): void } | null

// ── the handle as the engine's host ──────────────────────────────────────────────────────────────────

/**
 * Adapt a directory handle to the sync engine's {@link FolderApi}. `root` is ignored - the handle is the
 * folder (the browser exposes no path). What the engine asks to remember is merged into the row kept for
 * the document, so a patch carrying only a fingerprint never drops the baselines beside it.
 */
export function browserFolderApi(dir: DirLike, remembered: Partial<RememberedFolder> = {}): FolderApi {
  const memo: { signature: string; baseline?: FolderBaseline | null; trustDisk?: boolean } = {
    signature: remembered.signature ?? '',
    ...(remembered.baseline !== undefined ? { baseline: remembered.baseline } : {}),
    ...(remembered.trustDisk ? { trustDisk: true } : {}),
  }
  const unreadable = (e: unknown): string => `Couldn't read "${dir.name}": ${e instanceof Error ? e.message : String(e)}`
  return {
    readAt: async (root) => {
      try {
        return { root, files: await readProjectFolderFiles(dir), docId: null }
      } catch (e) {
        return { root, files: [], docId: null, error: unreadable(e) }
      }
    },
    signature: async () => {
      try {
        return { signature: await folderSignature(dir) }
      } catch (e) {
        return { error: unreadable(e) }
      }
    },
    write: async (_root, ops) =>
      typeof (dir as WritableDirLike).getFileHandle === 'function'
        ? applyWrites(dir as WritableDirLike, ops)
        : { moved: [], failed: ops.map((op) => op.path), error: `"${dir.name}" was opened for reading only` },
    remember: async (docId, patch) => {
      if (patch.signature !== undefined) memo.signature = patch.signature
      if (patch.baseline !== undefined) memo.baseline = patch.baseline
      if (patch.trustDisk !== undefined) memo.trustDisk = patch.trustDisk
      const { signature, ...sync } = memo
      await rememberFolderHandle(docId, dir, signature, sync)
    },
    detach: (docId) => forgetFolderHandle(docId),
  }
}

// ── linking ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open a picked folder's project as its own document and keep it in sync with the folder. Returns an
 * error for the caller to show (nothing is linked then), or null.
 *
 * Linking opens a document, so it goes through documentStore.adoptDocumentInPlace: the project on screen
 * is filed and the folder's gets a library record of its own, rather than being saved over the one you
 * linked from. In place, not write-then-reload: `confirmOpen` asks first (the command passes it; the gate
 * hook does not). Declining, or an adoption that fails, leaves the app exactly as it was.
 *
 * A folder the app was already following is released first - after writing what it had pending - so the
 * document arriving can never be written into the folder of the one leaving.
 */
export async function beginFolderLink(
  dir: DirLike,
  store: EditorStore,
  opts?: { confirmOpen?: (projectName: string) => boolean; controller?: SceneSwapGuard },
): Promise<string | null> {
  const controller = opts?.controller ?? null
  const read = await readFolderProject(dir)
  if ('error' in read) return read.error
  const { project } = read
  if (opts?.confirmOpen && !opts.confirmOpen(project.name)) return null
  if (syncedFolderPath() !== null) await syncFolderNow()
  const refused = await adoptDocumentInPlace(project, store.outgoingProject(), () => {
    releaseFolder(store)
    pending = null
    store.setFolderPaused(null)
    // a different document replaces whatever is on screen, the demo preview included
    controller?.leaveForSceneSwap()
    store.dropDemoSession()
    store.loadProject(project)
  })
  if (refused !== null) return refused
  // baseline null: the store was just built from this folder, so the first round starts with the two equal.
  // The folder belongs to the document it just opened (adoption moved the id), not the one that was on screen before.
  await followFolder(store, controller, browserFolderApi(dir), currentDocumentId() ?? '', dir.name, null)
  return null
}

/**
 * File → Link Project Folder…: pick a folder, open its project, and keep the two in sync until unlinked.
 * A cancelled picker is not an error - it returns null like every other picker flow here.
 */
export async function linkProjectFolder(store: EditorStore, controller: SceneSwapGuard = null): Promise<string | null> {
  if (!supportsFolderLink()) return 'This browser cannot open a folder. Chrome or Edge is needed.'
  if (store.getState().collab) return 'A shared project keeps the folder it was shared from. Stop sharing it to use another folder, or make a copy.'
  let dir: DirLike
  try {
    dir = await (window as unknown as { showDirectoryPicker(o?: unknown): Promise<DirLike> }).showDirectoryPicker({
      id: 'oip-project',
      mode: 'readwrite',
    })
  } catch {
    return null // the user cancelled, or refused the edit permission
  }
  // Same wording split as the desktop folder open: with a library the folder opens beside the project on
  // screen; without one it replaces it, and the question has to say so.
  return beginFolderLink(dir, store, {
    controller,
    confirmOpen: (name) =>
      confirm(
        supportsDocumentLibrary()
          ? `Open "${name}" from this folder as a new project? The one you have open now is kept under Projects.`
          : `Open "${name}" from this folder? This replaces the current project (its autosave is overwritten).`,
      ),
  })
}

/**
 * Write the project on screen into `dir` and keep it there from now on - the picker-free half of Save
 * Project to Folder (the gates drive it directly: the picker is a native dialog). The same document, so
 * nothing is adopted. Returns an error, or null.
 */
export async function saveProjectToFolderHandle(dir: DirLike, store: EditorStore, controller: SceneSwapGuard = null): Promise<string | null> {
  const error = await saveIntoFolder(store, controller, dir.name, { replace: true }, browserFolderApi(dir))
  if (error !== null) return error
  pending = null
  store.setFolderPaused(null)
  store.showSaveNotice('Saved to folder', `This project now lives in the folder "${dir.name}". Changes save there as you work.`)
  return null
}

/**
 * File → Save Project to Folder… in the browser: write the live project into a picked folder and keep it
 * in sync from then on, on one picker grant.
 */
export async function saveAndLinkProjectFolder(store: EditorStore, controller: SceneSwapGuard = null): Promise<string | null> {
  if (!supportsFolderLink()) return 'This browser cannot open a folder. Chrome or Edge is needed.'
  if (store.getState().collab) return 'A shared project keeps the folder it was shared from. Stop sharing it to use another folder, or make a copy.'
  let dir: WritableDirLike
  try {
    dir = await (
      window as unknown as { showDirectoryPicker(o?: unknown): Promise<WritableDirLike> }
    ).showDirectoryPicker({ id: 'oip-project', mode: 'readwrite' })
  } catch {
    return null // the user cancelled
  }
  // The picker chooses an existing folder, so it can already hold someone else's project. We never
  // delete, but we do overwrite the paths we own, so replacing a project must be confirmed.
  if (await hasProjectManifest(dir)) {
    const ok = confirm(`"${dir.name}" already holds a project. Overwrite it with "${store.getState().projectName}"?`)
    if (!ok) return null
  }
  return saveProjectToFolderHandle(dir, store, controller)
}

// ── surviving a reload ───────────────────────────────────────────────────────────────────────────

/** A folder recalled at boot whose permission is `prompt`: usable, but only from a user gesture. Held
 *  here so {@link reconnectProjectFolder} can call requestPermission as its first await. An
 *  IndexedDB read in front of it would risk spending the transient activation that call requires. */
let pending: { handle: PermissionedDir; remembered: RememberedFolder } | null = null

/** Re-entrancy guard for {@link restoreFolderLink}: the restore is async, so React's dev StrictMode
 *  double-invoke can put two of them in flight before either has started following. */
let restoring = false

/**
 * Follow a folder that is already this document's: a restored link, or one the user just re-permitted.
 * Not {@link beginFolderLink}: that opens a document (files the outgoing project, mints a record), which
 * on every reload would be the same document filed against itself.
 *
 * A row written before the link was two-way carries no baselines. Such a row followed "the disk wins", so
 * it resumes that way once (trustDisk: the folder loads whole, nothing here is written over it).
 */
async function resume(store: EditorStore, controller: SceneSwapGuard, handle: PermissionedDir, remembered: RememberedFolder): Promise<void> {
  const fromReadOnlyDays = remembered.baseline === undefined
  await followFolder(
    store,
    controller,
    browserFolderApi(handle, remembered),
    currentDocumentId() ?? '',
    handle.name,
    remembered.baseline ?? null,
    fromReadOnlyDays || remembered.trustDisk === true,
  )
}

/**
 * Boot: pick the link back up if this document had one. Call once, after the project is loaded.
 *
 * Three outcomes, and the middle one is why this is not simply automatic. `granted` resumes silently:
 * the user granted it, and persistent permission is the browser's own answer.
 * `prompt` cannot be resolved here, because requestPermission needs a user gesture and a page load is
 * not one, so the folder is published as paused and the banner offers Reconnect. `denied` forgets the
 * handle rather than leaving a dead one to fail the same way on every future boot.
 *
 * Resuming needs no "did the folder move while the tab was closed?" guess: the sync's baselines answer it
 * file by file, so an unchanged folder applies nothing and a changed one loads just what changed.
 */
export async function restoreFolderLink(store: EditorStore, controller: SceneSwapGuard = null): Promise<void> {
  // The desktop keeps its projects in folders through its own host (projectFolderSync.restoreFolderSync).
  if (getOipProjectApi() !== null) return
  if (restoring || syncedFolderPath() !== null) return // already following one, or already picking one up
  if (store.getState().collab) return // a live room owns its document; a folder must not sync over it
  restoring = true
  try {
    const docId = currentDocumentId()
    const remembered = await recallFolderHandle(docId)
    if (remembered === null) return
    const handle = remembered.handle as PermissionedDir
    const permission = await permissionOf(handle, false)
    if (permission === 'denied') {
      void forgetFolderHandle(docId)
      return
    }
    if (permission === 'prompt') {
      pending = { handle, remembered }
      store.setFolderPaused(handle.name)
      return
    }
    pending = null
    await resume(store, controller, handle, remembered)
  } finally {
    restoring = false
  }
}

/**
 * The Reconnect action: ask for the permission a restore could not, then keep the folder in sync again.
 * Must be reached from a click - requestPermission needs transient user activation.
 *
 * A refusal is not an error to alert about (the user just said no); it forgets the handle so the
 * paused banner does not come back on every reload to ask again.
 */
export async function reconnectProjectFolder(store: EditorStore, controller: SceneSwapGuard = null): Promise<string | null> {
  const waiting = pending
  if (waiting === null) return null
  const permission = await permissionOf(waiting.handle, true)
  // the user unlinked (or another folder took over) while the prompt was open
  if (pending !== waiting) return null
  pending = null
  store.setFolderPaused(null)
  if (permission !== 'granted') {
    void forgetFolderHandle(currentDocumentId())
    return null
  }
  await resume(store, controller, waiting.handle, waiting.remembered)
  return null
}

/** Is a remembered folder waiting on permission? (Enablement for the Reconnect command.) */
export function hasPausedFolder(): boolean {
  return pending !== null
}

/**
 * Unlink: stop keeping the project in its folder, and forget the folder, including across reloads.
 * The project stays open, stored in the app; the folder is left as it is.
 * Synchronous on the store side, because the banner button and the command both call it inline, and a
 * link the user dismissed must disappear from the screen at once. Both surfaces come through here (on the desktop the
 * engine's detach also records the choice, so the project is not handed a new folder unasked).
 */
export function unlinkProjectFolder(store: EditorStore): void {
  detachProjectFolder(store)
  pending = null
  void forgetFolderHandle(currentDocumentId())
  store.setFolderLink(null, null)
  store.setFolderPaused(null)
}
