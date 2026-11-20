// The project folder, kept in sync both ways: the desktop's store of record.
//
// Every edit is written back a moment after it is made, and anything else that changes the folder (an
// agent, an editor, a git checkout) is loaded in. The folder is what git, backups and agents see.
//
// Two hosts, one engine: the desktop (desktopProjectApi.ts) and, once linked or saved to a folder, the
// Chromium browser (projectFolderLink.ts adapts a File System Access handle to the same FolderApi).
//
// The decisions live in core/project/folderSync.ts and are made per file against a baseline (what the folder
// held, and what the app would have written, when the two last agreed):
//   changed only here          -> written to the folder
//   changed only in the folder -> loaded into the app
//   changed in both, differently -> a conflict: nothing moves until the user picks a side (the banner)
// Every write is guarded: the shell replaces a file only if it still holds what this module last read
// (apps/desktop/projectFolderIo.cjs applyFolderWrites), so an agent writing the same file at the same
// moment is never silently overwritten; the next round sees both changes and asks.
//
// The localStorage working copy is untouched and still written on every commit: it is the crash
// buffer, and the boot path still opens from it. This module writes the folder on a short trailing
// delay, and once more, synchronously, as the window goes away.
//
// Timing: the folder's fingerprint is checked once a second (cheap - sizes and dates, no contents);
// the project is serialized only when the fingerprint moved or the app saved something since.

import { AGENT_GUIDE, PROGRAM_DIR, PROGRAM_FILE, PROJECT_MANIFEST, folderFilesToProject, partFolderPaths, projectToFolderFiles, unreferencedProjectFiles } from '../../core/project/projectFolder'
import type { ProjectFolderFile } from '../../core/project/projectFolder'
import type { ProjectJSON } from '../../core/project/project'
import {
  advanceBaseline,
  agreedBaseline,
  diskAfter,
  layoutBaseline,
  planFolderSync,
  resolveConflicts,
  sceneUntouched,
  writeOpsFor,
} from '../../core/project/folderSync'
import type { FolderBaseline, FolderWriteOp, FolderWriteResult } from '../../core/project/folderSync'
import { bakePart } from '../parts/bakePart'
import { currentDocumentId } from './documentStore'
import { folderDisplayName, getOipProjectApi } from '../desktop/desktopProjectApi'
import type { FolderRead, FolderRecordPatch } from '../desktop/desktopProjectApi'
import type { SceneSwapGuard } from './projectFolderLink'
import type { EditorStore } from '../store/store'
import { onShippedAssetsWarmed } from '../parts/shippedAssetCache'
import { onSharedWriteBack, ownSharedProject, sharedProjectNow } from './sharedProject'
import { FOLDER_OPTIONS } from './folderOptions'

/**
 * What the engine needs from whatever holds the folder. The desktop shell (OipProjectApi) provides all of
 * it; a browser folder handle (projectFolderLink.ts) provides the async half - a page cannot write a file
 * synchronously as it unloads, so there the last few hundred ms of edits reach the folder on the next
 * visit instead (the working copy has them, and the next round sees them as the app's own changes).
 */
export interface FolderApi {
  readAt(root: string): Promise<FolderRead | null>
  signature(root: string): Promise<{ signature: string } | { error: string }>
  /** guarded writes: see core/project/folderSync.ts FolderWriteOp */
  write(root: string, ops: FolderWriteOp[]): Promise<FolderWriteResult>
  writeSync?(root: string, ops: FolderWriteOp[]): FolderWriteResult
  /** remember this document's folder state (baselines, fingerprint, name) across reloads */
  remember(docId: string, patch: FolderRecordPatch): Promise<void>
  rememberSync?(docId: string, patch: FolderRecordPatch): boolean
  /** the user unlinked the document from its folder */
  detach(docId: string): Promise<void>
  /** tell the host which folder the window is working in (the desktop's parts watcher) */
  attach?(root: string): void
}

/** How often the folder's fingerprint is checked for changes made outside the app. */
export const POLL_MS = 1000
/** How long after an edit the folder is written: long enough that a burst of edits is one write. */
export const WRITE_DELAY_MS = 800
/** ...but never longer than this after the first unsaved edit, so a long drag still reaches the disk. */
export const WRITE_MAX_WAIT_MS = 4000

interface Link {
  api: FolderApi
  root: string
  name: string
  docId: string
  /** null until the first round: the working copy was just built from the folder, so the two start equal */
  baseline: FolderBaseline | null
  /**
   * The working copy is a stand-in for the folder, not built from it: the library's last copy, opened
   * because the folder could not be read. That copy can lag the folder by a few seconds of edits, so it
   * must never be written over it. The first round therefore counts everything on disk as changed and
   * nothing here as changed: the folder loads whole the moment it is readable, and nothing older goes back.
   */
  trustDisk: boolean
  /** the fingerprint `theirs` was read at ('' = never read) */
  signature: string
  /** the folder as last read (or as predicted after our own writes) */
  theirs: ProjectFolderFile[] | null
  /** project.json as the two sides last agreed on it - what a load compares the new manifest against */
  agreedManifest: string | undefined
  /** a fingerprint at which the folder did not load; not retried until the folder moves again */
  heldAt: string | null
  /** the app saved something the folder may not have yet */
  dirty: boolean
  /** what was last handed to the registry, so an unchanged baseline is not re-sent every second */
  remembered: string
}

let link: Link | null = null
let store: EditorStore | null = null
let controller: SceneSwapGuard = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null
let firstDirtyAt: number | null = null
let running: Promise<void> | null = null
let rerun: 'poll' | 'write' | null = null
/** bumped whenever the link ends or changes, so a round still in flight writes nothing */
let generation = 0
let stopListening: (() => void) | null = null
let stopArming: (() => void) | null = null
let unloadHooked = false
/** what the last round that loaded the folder took in, for sync_folder's answer (agent/contextTools.ts) */
let lastLoad: FolderSyncReport | null = null

const fileText = (files: readonly ProjectFolderFile[] | null, path: string): string | undefined => {
  const contents = files?.find((f) => f.path === path)?.contents
  return typeof contents === 'string' ? contents : undefined
}

/** Nothing is synced while the document is not this session's to write: someone else's room, a view-only link, a
 *  tab that yielded to another, a stored project this build could not open. A project of the user's own that they
 *  shared is still theirs, so its folder keeps following it (project/sharedProject.ts), from the room. */
function mayWrite(s: EditorStore): boolean {
  const state = s.getState()
  return (!state.collab || ownsSharedFolder()) && !state.readOnly && !state.unopenedProject
}

/** this tab is in the room of a shared project of the user's own, and the linked folder is that project's */
function ownsSharedFolder(): boolean {
  const shared = ownSharedProject()
  return shared !== null && link !== null && shared.docId === link.docId
}

/** The app's rendering of the project as folder files. (`_theirs` pinned which scene the manifest marked active
 *  while a project held several; kept so the call sites read the same.) */
function mineFiles(s: EditorStore, _theirs: readonly ProjectFolderFile[] | null): ProjectFolderFile[] {
  // a built-in copy's model (a url asset with a sha256) is written as its file once its bytes are at hand
  // in its room a shared project is the room plus what the room does not carry (its tests: deleting their files would
  // lose them), under the record's name (sharedProject.ts)
  const shared = s.getState().collab ? ownSharedProject() : null
  return projectToFolderFiles(shared ? sharedProjectNow(s, shared) : s.snapshotProject(), FOLDER_OPTIONS)
}

/** Everything but the generated agent guide, which is written after any real write. */
function withGuide(ops: FolderWriteOp[], mine: readonly ProjectFolderFile[]): FolderWriteOp[] {
  const guide = fileText(mine, AGENT_GUIDE)
  return guide === undefined ? ops : [...ops, { path: AGENT_GUIDE, contents: guide, expect: '*' }]
}

function remember(l: Link, extra: { touch?: boolean } = {}): void {
  const name = store?.getState().projectName
  const memo = JSON.stringify([l.baseline, l.signature, name])
  if (memo === l.remembered && !extra.touch) return
  l.remembered = memo
  void l.api.remember(l.docId, { baseline: l.baseline, signature: l.signature, ...(name ? { name } : {}), ...extra })
}

/**
 * The banner note for files a load ignored, or null. Loading is manifest-driven, so an added file that
 * project.json never references does nothing. That is correct but silent, and the downstream symptom points
 * at the wrong thing (an unreferenced ST program surfaces as `tag "X" never appeared`). So the banner says so.
 */
export function noteForUnreferenced(paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const shown = paths.slice(0, 4).join(', ')
  const rest = paths.length > 4 ? `, +${paths.length - 4} more` : ''
  // each kind of file joins the project through its own array, so the hint names only the ones that apply
  // (a part folder told to go in "program" would be listed in the wrong place)
  const hints: string[] = []
  if (paths.some((p) => p.startsWith('parts/'))) hints.push('a part folder (parts/<id>) in "packages"')
  if (paths.some((p) => p.startsWith(`${PROGRAM_DIR}/`) || p === PROGRAM_FILE)) hints.push('a program file in "program"')
  if (paths.some((p) => p.startsWith('tests/'))) hints.push('a test in "tests"')
  const head = `Ignored ${paths.length} file${paths.length === 1 ? '' : 's'} this project does not reference: ${shown}${rest}.`
  return hints.length > 0 ? `${head} To use one, list it in ${PROJECT_MANIFEST}: ${hints.join(', ')}.` : head
}

/** What the folder holds that the project never references, for the banner. */
const noteFor = (files: readonly ProjectFolderFile[]): string | null => noteForUnreferenced(unreferencedProjectFiles(files))

// ── one round ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Bring the app and the folder into step once. `write` rounds carry the app's edits; `poll` rounds only
 * look at the folder, so a pending write keeps its delay (a drag writes when it pauses, not mid-way).
 */
async function round(reason: 'poll' | 'write'): Promise<void> {
  const l = link
  const s = store
  if (!l || !s || !mayWrite(s)) return
  const gen = generation
  const sig = await l.api.signature(l.root)
  if (gen !== generation) return
  if ('error' in sig) {
    // moved, deleted, unmounted: stop looking rather than fail once a second. The next edit looks again
    // (the folder may be back - a drive remounted), and Unlink is the way out.
    stopPolling()
    s.setFolderLink(l.name, `Lost access to the project folder: ${sig.error}`)
    return
  }
  ensurePolling()
  const moved = sig.signature !== l.signature || l.theirs === null
  if (!moved && !(reason === 'write' && l.dirty)) return
  if (moved) {
    const read = await l.api.readAt(l.root)
    if (gen !== generation) return
    if (!read || read.error !== undefined) {
      s.setFolderLink(l.name, `Couldn't read the project folder: ${read?.error ?? 'no answer from the app shell'}`)
      return
    }
    l.theirs = read.files
    l.signature = sig.signature
  }
  const theirs = l.theirs!
  l.dirty = false
  const mine = mineFiles(s, theirs)

  // First round after the working copy was built from this folder: the two are the same project, so
  // whatever differs between them is rendering, not an edit. Agree on it and move nothing - unless the folder names
  // other program or test files than the app writes, which is a layout to rewrite, not a rendering (core/project/folderSync.ts
  // layoutBaseline; checked every round, since an agent can write that layout at any time).
  if (l.baseline === null && l.trustDisk) {
    l.baseline = { disk: {}, mine: agreedBaseline(mine, mine).mine }
  } else if (l.baseline === null) {
    const agreed = agreedBaseline(mine, theirs)
    const relaid = layoutBaseline(agreed, mine, theirs)
    if (relaid === null) {
      l.baseline = agreed
      l.agreedManifest = fileText(theirs, PROJECT_MANIFEST)
      remember(l)
      s.setFolderLink(l.name, null, noteFor(theirs))
      return
    }
    l.baseline = relaid
    l.agreedManifest = fileText(theirs, PROJECT_MANIFEST)
  } else {
    l.baseline = layoutBaseline(l.baseline, mine, theirs) ?? l.baseline
  }

  const plan = planFolderSync(l.baseline, mine, theirs)
  // Shared, the folder follows the room, one way. A change made to the folder meanwhile is not loaded, because a load
  // replaces the project under the room rather than editing it: the sync waits, moving nothing, and when the project
  // stops being shared it takes the change, or asks about it, as it always does.
  if (s.getState().collab && (plan.take.length > 0 || plan.conflicts.length > 0)) {
    s.setFolderLink(l.name, 'The project folder changed while the project is shared. Those changes are not loaded while it is shared; the folder sync waits, and picks them up when you stop sharing.', null)
    return
  }
  if (plan.conflicts.length > 0) {
    s.setFolderConflict(plan.conflicts)
    return
  }
  s.setFolderConflict(null)

  // A load is checked before anything is written. A folder that does not reassemble is usually one an
  // agent is halfway through writing, so the round waits for it rather than interleaving our own writes
  // with its. The working copy holds every edit meanwhile, so waiting loses nothing.
  const after = diskAfter(theirs, plan)
  let loaded: ProjectJSON | null = null
  if (plan.take.length > 0) {
    if (l.heldAt === l.signature) return
    const result = folderFilesToProject(after, { bakePart })
    if (!result.ok) {
      l.heldAt = l.signature
      s.setFolderLink(l.name, result.errors.join('\n'), null)
      return
    }
    // The folder became an older multi-scene project under the app (a `git checkout` of an old commit, say). Taking
    // only the scene that was active would make the next write delete the others' files, so it is held instead, like
    // a folder halfway through being written: reopening it is what splits it (editor/folderSplit.ts).
    if (result.splitOff) {
      l.heldAt = l.signature
      s.setFolderLink(
        l.name,
        `The folder now holds ${result.splitOff.length + 1} scenes, in the format from before a project held one. Nothing was loaded or written; open it from Projects to split it into projects of their own.`,
        null,
      )
      return
    }
    l.heldAt = null
    loaded = result.project
  }

  const ops = writeOpsFor(plan, l.baseline)
  let outcome: FolderWriteResult = { moved: [], failed: [], error: null }
  if (ops.length > 0) {
    outcome = await l.api.write(l.root, withGuide(ops, mine))
    if (gen !== generation) return
  }
  const notLanded = [...outcome.moved, ...outcome.failed]

  if (loaded !== null) {
    const state = s.getState()
    const keep = !state.demoSession && sceneUntouched(plan.take, l.agreedManifest, fileText(after, PROJECT_MANIFEST))
    const wasRunning = state.running
    if (!keep && !state.demoSession) controller?.leaveForSceneSwap()
    s.refreshProject(loaded, { keepLiveScene: keep })
    lastLoad = { loaded: [...plan.take], stoppedRun: wasRunning && !s.getState().running }
  }

  // A parts/ folder that just appeared (the first authored part, from either side) has to become the
  // shell's live parts workspace, or its behavior.js stops hot-reloading. Re-attaching is idempotent.
  if ([...plan.take, ...plan.write.map((f) => f.path)].some((p) => p.startsWith('parts/'))) l.api.attach?.(l.root)

  const diskNow = diskAfter(theirs, plan, notLanded)
  const mineNow = loaded !== null ? mineFiles(s, diskNow) : mine
  l.baseline = advanceBaseline(l.baseline, mineNow, diskNow, notLanded)
  l.theirs = diskNow
  l.agreedManifest = fileText(diskNow, PROJECT_MANIFEST)
  // a write the guard turned away means someone else just wrote that file: look again straight away
  if (notLanded.length > 0) l.dirty = true
  if (l.trustDisk) {
    l.trustDisk = false
    void l.api.remember(l.docId, { trustDisk: false })
  }
  remember(l)
  const error = outcome.error !== null ? `Couldn't save to the project folder: ${outcome.error}` : null
  s.setFolderLink(l.name, error, loaded !== null || plan.take.length > 0 ? noteFor(diskNow) : s.getState().folderNote)
}

function kick(reason: 'poll' | 'write'): Promise<void> {
  if (running) {
    if (rerun !== 'write') rerun = reason
    return running
  }
  const current = round(reason)
    .catch((e: unknown) => {
      // never an unhandled rejection from a timer: the banner is where a sync failure is read
      if (link && store) store.setFolderLink(link.name, `The project folder sync failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    .finally(() => {
      running = null
      const again = rerun
      rerun = null
      if (again !== null) void kick(again)
    })
  running = current
  return current
}

/** An edit was saved: write it to the folder once the edits pause (WRITE_DELAY_MS, capped at WRITE_MAX_WAIT_MS). */
function onPersist(): void {
  if (!link) return
  link.dirty = true
  const now = Date.now()
  firstDirtyAt ??= now
  if (writeTimer !== null) clearTimeout(writeTimer)
  const wait = Math.max(0, Math.min(WRITE_DELAY_MS, firstDirtyAt + WRITE_MAX_WAIT_MS - now))
  writeTimer = setTimeout(() => {
    writeTimer = null
    firstDirtyAt = null
    void kick('write')
  }, wait)
}

/**
 * The window is going away (closed, reloaded, switched to another project): write what is pending at once,
 * synchronously, from the last read. Only writes, since loading anything into a page that is leaving is
 * pointless. A path the folder changed is left for the next launch to reconcile, not taken as seen.
 */
export function flushFolderSyncNow(): void {
  const l = link
  const s = store
  if (!l || !s || !l.dirty || l.baseline === null || l.theirs === null || !mayWrite(s) || s.getState().folderConflict) return
  // a host that cannot write synchronously (a browser folder handle) gets the async round instead, from
  // visibilitychange: a page going to the background is usually still alive long enough to finish it
  if (!l.api.writeSync) return
  if (writeTimer !== null) clearTimeout(writeTimer)
  writeTimer = null
  const mine = mineFiles(s, l.theirs)
  const plan = planFolderSync(l.baseline, mine, l.theirs)
  if (plan.conflicts.length > 0 || (plan.write.length === 0 && plan.remove.length === 0)) return
  const outcome = l.api.writeSync(l.root, withGuide(writeOpsFor(plan, l.baseline), mine))
  const kept = [...outcome.moved, ...outcome.failed, ...plan.take]
  l.baseline = advanceBaseline(l.baseline, mine, diskAfter(l.theirs, plan, kept), kept)
  l.dirty = false
  if (l.api.rememberSync) l.api.rememberSync(l.docId, { baseline: l.baseline, signature: l.signature })
  else void l.api.remember(l.docId, { baseline: l.baseline, signature: l.signature })
}

/** The page is being hidden (a tab switch, a minimized window, often the step before closing): write what
 *  is pending now, asynchronously, rather than waiting out the delay. */
function onHidden(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && link?.dirty) void kick('write')
}

// ── the link's lifetime ──────────────────────────────────────────────────────────────────────────────

function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
}

function ensurePolling(): void {
  if (pollTimer === null && link !== null) pollTimer = setInterval(() => void kick('poll'), POLL_MS)
}

function stopTimers(): void {
  stopPolling()
  if (writeTimer !== null) clearTimeout(writeTimer)
  writeTimer = null
  firstDirtyAt = null
}

function stop(): void {
  stopTimers()
  stopListening?.()
  stopListening = null
  stopArming?.()
  stopArming = null
  generation++
  link = null
}

async function begin(api: FolderApi, docId: string, root: string, baseline: FolderBaseline | null, trustDisk = false): Promise<void> {
  stop()
  const s = store!
  link = {
    api,
    root,
    name: folderDisplayName(root),
    docId,
    baseline: trustDisk ? null : baseline,
    trustDisk,
    signature: '',
    theirs: null,
    agreedManifest: undefined,
    heldAt: null,
    dirty: true,
    remembered: '',
  }
  api.attach?.(root)
  s.setFolderPath(root)
  s.setFolderLink(link.name, null, null)
  s.setFolderConflict(null)
  const stopPersist = s.onProjectPersisted(onPersist)
  // a round that ran before a built-in's model bytes arrived wrote its url form; when they arrive, write the files
  const stopWarmed = onShippedAssetsWarmed(onPersist)
  // shared, the project is saved by its write-back from the room, not by the autosave (project/sharedProject.ts)
  const stopShared = onSharedWriteBack(onPersist)
  stopListening = () => {
    stopPersist()
    stopWarmed()
    stopShared()
  }
  ensurePolling()
  if (!unloadHooked && typeof addEventListener === 'function') {
    unloadHooked = true
    addEventListener('pagehide', flushFolderSyncNow)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden)
  }
  await kick('write')
}

/**
 * Keep the project in `root` in sync from now on, as the document `docId` (the browser's link and its
 * restore - projectFolderLink.ts; the desktop reaches `begin` through restoreFolderSync). `baseline` null
 * means the working copy was just built from the folder; `trustDisk` means it is only a stand-in and the
 * folder wins whole once readable.
 */
export async function followFolder(
  s: EditorStore,
  ctrl: SceneSwapGuard,
  api: FolderApi,
  docId: string,
  root: string,
  baseline: FolderBaseline | null,
  trustDisk = false,
): Promise<void> {
  store = s
  controller = ctrl
  await begin(api, docId, root, baseline, trustDisk)
}

/** Stop following the folder at once, without a last write: a different document is about to replace the
 *  one on screen (a browser link opening another folder), and it must not be written into this folder.
 *  The caller writes what was pending first (syncFolderNow). */
export function releaseFolder(s: EditorStore): void {
  stop()
  s.setFolderPath(null)
  s.setFolderLink(null, null)
  s.setFolderConflict(null)
}

/** Is this the desktop app, where a project lives in a folder? */
export function supportsFolderSync(): boolean {
  return getOipProjectApi() !== null
}

/** The folder the open project lives in, or null. */
export function syncedFolderPath(): string | null {
  return link?.root ?? null
}

/**
 * Boot: pick the open document's folder back up. Call once, after the project is loaded.
 *
 * A document with no folder yet (a first launch, a project from before folders, an .oip import) gets
 * one on its first real edit - in the default projects folder, without asking - unless the user
 * unlinked it from a folder on purpose, which the shell remembers.
 */
export async function restoreFolderSync(s: EditorStore, ctrl: SceneSwapGuard = null): Promise<void> {
  const api = getOipProjectApi()
  if (api === null) return
  store = s
  controller = ctrl
  const docId = currentDocumentId()
  if (docId === null) return
  // in a room only a shared project of the user's own keeps its folder: someone else's room is not theirs to write
  if (s.getState().collab && ownSharedProject()?.docId !== docId) return
  const row = await api.recall(docId)
  // another document took the screen while the shell answered (the demo forking into a project of its own): its
  // own call decides its folder, and this one must not attach the old document's to it
  if (currentDocumentId() !== docId) return
  if (row?.path) {
    await begin(api, docId, row.path, row.baseline ?? null, row.trustDisk === true)
    if (link) remember(link, { touch: true })
    return
  }
  if (!row?.detached) armFirstEdit(s)
}

/**
 * Write the whole project into `root` and keep it in sync from now on: Save Project to Folder, a new
 * project's first folder, and an app-only project's first edit. `replace` overwrites a project already
 * there (the caller asked first); otherwise the folder must not hold these files yet. Returns the error
 * to show, or null.
 */
export async function saveIntoFolder(
  s: EditorStore,
  ctrl: SceneSwapGuard,
  root: string,
  opts: { replace: boolean },
  /** the host: the desktop shell by default, a browser folder handle from projectFolderLink.ts */
  api: FolderApi | null = getOipProjectApi(),
): Promise<string | null> {
  if (api === null) return 'Saving a project as a folder needs the desktop app.'
  if (s.getState().collab) return 'A shared project keeps the folder it was shared from. Stop sharing it to use another folder, or make a copy.'
  // '' when this browser keeps no document library: the folder is followed, it just cannot be remembered
  const docId = currentDocumentId() ?? ''
  store = s
  controller = ctrl
  stopArming?.()
  stopArming = null
  const mine = mineFiles(s, null)
  const outcome = await api.write(
    root,
    mine.map((f) => ({ path: f.path, contents: f.contents, expect: opts.replace || f.path === AGENT_GUIDE ? '*' : null })),
  )
  if (outcome.error !== null) return outcome.error
  if (outcome.moved.length > 0) return `The folder already holds ${outcome.moved.join(', ')}.`
  const baseline = agreedBaseline(mine, mine)
  await api.remember(docId, { path: root, name: s.getState().projectName, baseline, signature: '', touch: true })
  await begin(api, docId, root, baseline)
  return null
}

/**
 * Give an app-only project its folder on its first real edit. Not on boot, and not on the first save:
 * the app saves on its own at boot and whenever a part snapshot refreshes, and a folder appearing in
 * Documents because the app was merely launched would be a surprise. An undoable edit is someone's work.
 */
function armFirstEdit(s: EditorStore): void {
  stopArming?.()
  const check = (): void => {
    const state = s.getState()
    if (!s.canUndo || state.demoSession || !mayWrite(s) || link !== null) return
    stopArming?.()
    stopArming = null
    void giveFolder(s)
  }
  stopArming = s.subscribe(check)
}

async function giveFolder(s: EditorStore): Promise<boolean> {
  const api = getOipProjectApi()
  if (api === null) return false
  const made = await api.createFolder(s.getState().projectName)
  if ('error' in made) {
    s.setFolderLink(null, `Couldn't give this project a folder: ${made.error}`)
    return false
  }
  const error = await saveIntoFolder(s, controller, made.root, { replace: false })
  if (error !== null) {
    s.setFolderLink(null, `Couldn't save this project to ${made.root}: ${error}`)
    return false
  }
  s.showSaveNotice('Saved as a folder', `This project now lives in ${made.root}. Changes save there as you work.`)
  return true
}

/**
 * Give the project its folder now if it is about to get one anyway, because something is about to write a
 * part file. A part's files go to the active parts workspace, which is the project folder's parts/ once the
 * project has a folder (the shell's project:attach). Without a folder, the shell's only place is the
 * profile-wide custom-parts, where a part would belong to no project and load into every project without
 * parts of its own (the cross-project leak). So a "Save part" or an eject on an app-only project makes the
 * folder first, exactly as its first edit would have. True when the project has a folder now; false where it
 * won't get one unasked (the browser, a room, a deliberate unlink), and the caller writes where it always did.
 */
export async function ensureProjectFolder(s: EditorStore): Promise<boolean> {
  if (link !== null) return true
  if (!mayWrite(s) || getOipProjectApi() === null || stopArming === null) return false
  store = s
  stopArming()
  stopArming = null
  return giveFolder(s)
}

/**
 * What an explicit Save (Ctrl+S) did. `saved`: everything is in the folder now. `created`: the project had
 * no folder and was given its default one (which says so itself). `needsFolder`: no folder, and not one to
 * make unasked - the user unlinked it on purpose - so the caller asks where. `conflict` / `failed`: the
 * banner already says why, and the caller must not claim anything was saved.
 */
export type SaveNowOutcome = 'saved' | 'created' | 'needsFolder' | 'conflict' | 'failed'

/**
 * Save now, on request. The project already saves itself as you work, so this is the answer to a
 * reflexive Ctrl+S: write anything still pending, and report whether the folder has it all.
 */
export async function saveToFolderNow(s: EditorStore): Promise<SaveNowOutcome> {
  if (!mayWrite(s)) return 'failed' // a room, a view link, a yielded tab, an unopened project: their banners say why
  store = s
  if (link === null) {
    // No folder yet. Only the desktop hands one out unasked; a browser has no folder it may write
    // without a picker, so there (and after a deliberate unlink) the caller asks where.
    if (getOipProjectApi() === null || stopArming === null) return 'needsFolder'
    stopArming()
    stopArming = null
    return (await giveFolder(s)) ? 'created' : 'failed'
  }
  await syncFolderNow()
  const state = s.getState()
  if (state.folderConflict) return 'conflict'
  if (state.folderError) return 'failed'
  return 'saved'
}

/** Run a round now and wait for it (a command's "save now", and the gates). */
export async function syncFolderNow(): Promise<void> {
  if (running) await running
  if (!link) return
  link.dirty = true
  await kick('write')
}

/**
 * A library part's build source in the followed folder, `parts/<slug>/part.js`, as the sync last read it, or null.
 * The app never reads a part.js (core/project/projectFolder.ts isPartSourceFile); the agent tools name it, so an
 * agent editing such a part knows its manifest.json and behavior.js are build output.
 */
export function partSourceInFolder(packageId: string): { root: string; path: string; text: string } | null {
  const l = link
  const s = store
  if (!l || !s || !l.theirs) return null
  const dir = partFolderPaths(s.snapshotProject().packages ?? []).get(packageId)
  const text = dir === undefined ? undefined : fileText(l.theirs, `${dir}/part.js`)
  return text === undefined ? null : { root: l.root, path: `${dir}/part.js`, text }
}

/** What one {@link syncFolderAndReport} round did. */
export interface FolderSyncReport {
  /** the folder's files the round loaded into the app (empty: nothing had changed there) */
  loaded: string[]
  /** loading them stopped the run: a change to the scene, the program or a part rebuilds the scene */
  stoppedRun: boolean
}

/**
 * Run a round now and say what it loaded: an agent that wrote files in the folder learns when they are in the
 * app, rather than guessing at the once-a-second poll. Null when no folder is followed.
 */
export async function syncFolderAndReport(): Promise<FolderSyncReport | null> {
  if (running) await running
  if (!link) return null
  lastLoad = null
  await syncFolderNow()
  return lastLoad ?? { loaded: [], stoppedRun: false }
}

/**
 * Settle a conflict: 'disk' keeps the folder's version of every conflicted file (the app loads it),
 * 'mine' keeps the app's (it is written, guarded against the folder version the user was shown). The
 * folder is read again first, so "keep mine" replaces what is there at that moment and nothing newer.
 */
export async function resolveFolderConflict(side: 'disk' | 'mine'): Promise<void> {
  if (running) await running
  const l = link
  const s = store
  if (!l || !s || l.baseline === null) return
  const paths = s.getState().folderConflict
  if (!paths || paths.length === 0) return
  const sig = await l.api.signature(l.root)
  const read = await l.api.readAt(l.root)
  if ('error' in sig || !read || read.error !== undefined || link !== l) return
  l.theirs = read.files
  l.signature = sig.signature
  l.baseline = resolveConflicts(l.baseline, paths, side, mineFiles(s, l.theirs), l.theirs)
  s.setFolderConflict(null)
  l.dirty = true
  await kick('write')
}

/**
 * Stop keeping the project in its folder, on purpose (Unlink). The project stays open as an app-only
 * document; the folder is left exactly as it is; and the shell remembers the choice, so the next edit
 * does not quietly give the project a new folder.
 */
export function detachProjectFolder(s: EditorStore): void {
  const l = link
  stop()
  // with no folder yet (the first-edit folder could not be made), this is how the user says "stop trying"
  const docId = l?.docId ?? currentDocumentId()
  const api = l?.api ?? getOipProjectApi()
  if (api !== null && docId !== null) void api.detach(docId)
  s.setFolderPath(null)
  s.setFolderLink(null, null)
  s.setFolderConflict(null)
}

/** Test seam: forget everything, as a fresh page would. */
export function resetFolderSyncForTests(): void {
  stop()
  store = null
  controller = null
  running = null
  rerun = null
  unloadHooked = false
  lastLoad = null
}
