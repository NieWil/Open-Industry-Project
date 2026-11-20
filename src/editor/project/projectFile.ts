// Project-level persistence: the working copy, the autosave that folds the active scene, its bound ST program, and
// the authored part library into one document (a ProjectJSON - see src/core/project/project.ts). It is the open
// document's row in the library (libraryDb.ts), or localStorage `oip-web/project` in a browser without IndexedDB
// (docs/projects.md "The browser working copy"). The legacy single-scene keys ('oip-web/autosave',
// 'oip-web/st-program', 'oip-web/user-packages') are still written by the store/StEditor as a transitional fallback,
// and a browser that only has those is migrated into a project the first time it boots. Pure of any React/DOM-ref
// state, mirroring sceneFile.ts.

import { keepDefinitionsOnce, PROJECT_VERSION, projectToScene, serializeProject, trimForExport, unusedLibraryParts, validateProject } from '../../core/project/project'
import { warmShippedAssets } from '../parts/shippedAssetCache'
import { loadLocalAssets, localAssetReviver, storeLocalAssets, withLocalAssets } from './localAssets'
import {
  allRowTexts,
  announceCurrentDocument,
  currentDocumentId,
  forgetCurrentDocument,
  mintDocumentId,
  pinTabDocument,
  readRowText,
  setCurrentDocumentId,
  supportsDocumentLibrary,
  writeRowText,
} from './libraryDb'
import { clearEntryParams } from './entryParams'
import type { ExportLeaveOut, ProjectJSON } from '../../core/project/project'
import { serializeScene, validateScene } from '../../core/scene/scene'
import { sceneSettings } from '../../core/scene/scenePlcs'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../../core/types'
import type { SceneJSON, SimRate } from '../../core/types'
import type { PartPackage } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { upgradeStoredPackage } from '../../core/parts/partUpgrade'
import type { Controller } from '../../core/controller'
import { storedDialect } from '../../core/dialect'
// the committed first-party catalog (via bundledExamples' re-export - bundledPackageData must keep
// exactly one direct importer, the HMR accept boundary; see bundledExamples.ts)
import { isZipData, oipBytesToProject, projectToOipBytes } from '../../core/project/projectArchive'
import { bakePart } from '../parts/bakePart'
import { bundledPartById } from '../parts/bundledExamples'
import { noticeHeldCodeInExport } from './sceneFile'
// the legacy single-key program buffer, read only by the one-time migration below
import { readStProgram, readStScanMs } from '../program/stProgram'
import type { EditorStore } from '../store/store'
import { FOLDER_OPTIONS } from './folderOptions'

export const PROJECT_KEY = 'oip-web/project'

// Legacy single-scene autosave keys - kept in sync with store.ts AUTOSAVE_KEY / USERPKG_KEY (and
// stProgram.ts ST_PROGRAM_KEY via readStProgram). Read here only to migrate a pre-project browser
// into the unified project doc. Inlined rather than imported from store.ts to avoid an import cycle
// (store.ts imports this module's assemble/save for its own persistProject()).
const LEGACY_SCENE_KEY = 'oip-web/autosave'
const LEGACY_USERPKG_KEY = 'oip-web/user-packages'

const DEFAULT_PROJECT_NAME = 'Untitled Project'

/**
 * Assemble a project from the live editor pieces: the scene's parts, its ST program, and the project's part library
 * (`userPackages`). The live scene's package copies are given up (keepDefinitionsOnce): a built-in's copy is
 * dropped, not folded into the library. The library adopts as authoritative on the next boot, so folding a
 * merely-placed built-in in would freeze it at its placement-day state (the placed-part-freeze bug). Only a
 * copy of a part nothing else holds joins it.
 */
export function assembleProject(
  scene: SceneJSON,
  stProgram: string,
  userPackages: readonly PartPackage[],
  name = DEFAULT_PROJECT_NAME,
  stScanMs?: number,
  simHz: SimRate = DEFAULT_SIM_HZ,
  controller?: Controller | null,
  /** the program's dialect (core/dialect.ts); written only when it is not IEC, with or without a program */
  stDialect?: string | null,
): ProjectJSON {
  const library = [...userPackages]
  const dialect = storedDialect(stDialect)
  return keepDefinitionsOnce({
    version: PROJECT_VERSION,
    name,
    ...(library.length > 0 ? { packages: library } : {}),
    scene: {
      version: SCENE_VERSION,
      parts: scene.parts,
      ...(scene.packages && scene.packages.length > 0 ? { packages: scene.packages } : {}),
      ...sceneSettings(scene),
    },
    ...(stProgram !== ''
      ? {
          stProgram,
          ...(stScanMs !== undefined ? { stScanMs } : {}),
          ...(controller ? { controller } : {}),
        }
      : {}),
    ...(dialect !== undefined ? { stDialect: dialect } : {}),
    ...(simHz !== DEFAULT_SIM_HZ ? { simHz } : {}),
  })
}

/** The persisted project split into the pieces the boot path applies. */
export interface LoadedProject {
  project: ProjectJSON
  /**
   * The other scenes of an older multi-scene working copy, each a project of its own (core/project/project.ts
   * validateProject `splitOff`). The boot files them in the library before anything saves over the working copy.
   */
  splitOff?: ProjectJSON[]
  /** the scene, self-contained: its own snapshots with the authored library merged over them */
  scene: SceneJSON
  /** the ST program ('' when none) */
  stProgram: string
  /** that program's authored scan time in ms, when the document carried one */
  stScanMs?: number
  /** that program's controller table, when it runs several programs on tasks */
  controller?: Controller
  /** that program's dialect, when it is not IEC (core/dialect.ts) */
  stDialect?: string
  /** the physics step rate */
  simHz: SimRate
  /** the authored library only (userPackages), to seed the catalog - never placement snapshots */
  library: PartPackage[]
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // only blocked storage throws here, and then every write fails and is reported through SaveResult
    return null
  }
}

function split(project: ProjectJSON, splitOff?: ProjectJSON[]): LoadedProject {
  const { scene, stProgram, stScanMs, controller, stDialect, simHz } = projectToScene(project)
  return {
    project,
    ...(splitOff && splitOff.length > 0 ? { splitOff } : {}),
    scene,
    stProgram,
    ...(stScanMs !== undefined ? { stScanMs } : {}),
    ...(controller !== undefined ? { controller } : {}),
    ...(stDialect !== undefined ? { stDialect } : {}),
    simHz,
    library: project.packages ?? [],
  }
}

/** The legacy scene key's text: compact (nothing reads it by eye), with models by hash as the project doc has them. */
export function legacySceneText(scene: SceneJSON): string {
  return serializeScene(withLocalAssets(scene), undefined, undefined, { pretty: false })
}

/** Read + validate the legacy autosaved scene, or null if absent/corrupt. */
function readLegacyScene(): SceneJSON | null {
  const raw = safeGet(LEGACY_SCENE_KEY)
  if (!raw) return null
  try {
    const missing: string[] = []
    const result = validateScene(JSON.parse(raw, localAssetReviver(missing)))
    if (missing.length > 0) return null
    return result.ok ? result.scene : null
  } catch {
    return null
  }
}

/** Read + validate the legacy in-app authored parts (the pre-project user-packages catalog). */
function readLegacyUserPackages(): PartPackage[] {
  const raw = safeGet(LEGACY_USERPKG_KEY)
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((p: unknown) => upgradeStoredPackage(p).pkg).filter((p): p is PartPackage => validatePartPackage(p).length === 0)
  } catch {
    return []
  }
}

/**
 * A library that predates the v2 authored/placed split can't tell an authored fork of a bundled
 * part from a mere placement snapshot of one - and adopting a snapshot as authoritative freezes
 * that part forever (the placed-part-freeze bug). Drop every first-party (bundled) id: the
 * committed catalog re-registers those fresh at App mount, and each scene keeps its own snapshot
 * copy for self-containment. The one-time cost: a genuine pre-v2 in-app fork of a bundled part
 * reverts to the pristine bundle. Genuinely authored ids (not in the catalog) pass through.
 */
function dropBundledIds(library: readonly PartPackage[]): PartPackage[] {
  return library.filter((p) => bundledPartById(p.id) === undefined)
}

// ── where the working copy is ────────────────────────────────────────────────────────────────────────────
//
// With IndexedDB, the working copy is the open document's row in the library, and nothing else holds a second copy
// of it in the browser. Every save is synchronous for its caller: the text is kept here and its row write queued, one
// at a time with the latest winning. A failed write is reported to the autosave banner (onWorkingCopyWrite) and on
// every save after it until a write succeeds. Without IndexedDB (a Node test, some private modes) the working copy
// is localStorage PROJECT_KEY, written synchronously.

/** The open document's working copy while it is a library row: the text last read or written, and whose row. Null
 *  while the working copy is localStorage's. */
let inLibrary: { doc: string | null; text: string | null } | null = null

/** Is the working copy the open document's library row (rather than localStorage)? */
export function workingCopyInLibrary(): boolean {
  return inLibrary !== null
}

/** The working copy's text as stored, or null when there is none. */
function workingCopyText(): string | null {
  if (inLibrary === null) return safeGet(PROJECT_KEY)
  return inLibrary.doc !== null && inLibrary.doc === currentDocumentId() ? inLibrary.text : null
}

/** Is there a stored working copy at all (storePackages drops the pre-project library key once there is)? */
export function hasStoredProject(): boolean {
  return workingCopyText() !== null
}

/**
 * Set while the working copy was older than the project it belongs to: a save of it to localStorage was refused for
 * quota, and none had succeeded since. `since` is the first refusal. Builds that kept the working copy in localStorage
 * set it, and the library's trailing sync kept writing the live project to the row, so a row written after `since`
 * holds everything that working copy lacks. Read once, when the working copy moves into the library.
 */
const BEHIND_KEY = 'oip-web/project-behind'

function behindRow(): { doc: string; since: number } | null {
  const raw = safeGet(BEHIND_KEY)
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as { doc?: unknown; since?: unknown }
    return typeof v.doc === 'string' && typeof v.since === 'number' ? { doc: v.doc, since: v.since } : null
  } catch {
    return null
  }
}

/** Does `text` open as a project, with every model it names by hash read? */
function opens(text: string): boolean {
  try {
    const missing: string[] = []
    return validateProject(JSON.parse(text, localAssetReviver(missing))).ok && missing.length === 0
  } catch {
    return false
  }
}

/**
 * The localStorage working copy to move into the library, or null when it must stay where it is. Two cases take the
 * open document's row instead, as the boot of the build that wrote them did: a save refused for quota left the row
 * newer ({@link behindRow}), or the working copy names models whose bytes are gone and the row embeds them. A working
 * copy that does not open stays, and is refused as an unopened project, so its Download and Discard work on it.
 */
async function localCopyToMove(local: string, doc: string | null): Promise<string | null> {
  const row = doc === null ? null : await readRowText(doc)
  const behind = behindRow()
  if (row && behind !== null && behind.doc === doc && row.updatedAt > behind.since) return row.text
  if ((await loadLocalAssets([local])).length > 0) return row?.text ?? null
  return opens(local) ? local : null
}

/**
 * Before the boot: read the open document's row into the working copy, and its models' bytes from the asset store.
 * The first boot with IndexedDB moves a localStorage working copy into the row and removes it from localStorage, once
 * the row has committed. Until then, or if the move cannot happen, the working copy stays in localStorage for this
 * session, as it was.
 */
export async function openWorkingCopy(): Promise<void> {
  inLibrary = null
  if (typeof localStorage === 'undefined' || !supportsDocumentLibrary()) return
  pinTabDocument()
  let doc = currentDocumentId()
  // A page closed with a row write pending kept its latest text (keepPendingWrite). It is newer than the row.
  const journal = doc === null ? null : safeGet(journalKey(doc))
  // One that does not open is left where it is rather than dropped: it is the only copy of those edits.
  if (doc !== null && journal !== null) {
    const text = await localCopyToMove(journal, doc)
    if (text !== null && (await writeRowText(doc, nameOf(parseOrNull(text)) ?? DEFAULT_PROJECT_NAME, text))) dropJournal(doc)
  }
  // the working copy where builds before the library kept it, moved into the open document's row once
  const local = safeGet(PROJECT_KEY)
  if (local !== null) {
    const text = await localCopyToMove(local, doc)
    if (text === null) return void (await loadLocalAssets([local, safeGet(LEGACY_SCENE_KEY)]))
    if (doc === null) {
      doc = mintDocumentId()
      setCurrentDocumentId(doc)
    }
    if (!(await writeRowText(doc, nameOf(parseOrNull(text)) ?? DEFAULT_PROJECT_NAME, text))) return void (await loadLocalAssets([local, safeGet(LEGACY_SCENE_KEY)]))
    try {
      localStorage.removeItem(PROJECT_KEY)
      localStorage.removeItem(BEHIND_KEY)
    } catch {
      // a key left behind would be moved over the row by the next boot, so it stays the working copy this session
      return
    }
  }
  const row = doc === null ? null : await readRowText(doc)
  await loadLocalAssets([row?.text ?? null, safeGet(LEGACY_SCENE_KEY)])
  inLibrary = { doc, text: row?.text ?? null }
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A stored project this session could not open (see {@link unopenedProject}). */
export interface UnopenedProject {
  /** the document's own name, when it parsed far enough to carry one */
  name: string | null
  /** why it was refused: the validator's errors, or the parse failure */
  errors: string[]
}

// The stored text this session refused, kept so the save guard can tell whether it is still what the working
// copy holds (anything that replaced it by other means lifts the guard - a test's fresh storage, another tab).
let unopened: (UnopenedProject & { raw: string }) | null = null

/**
 * The stored project this session could not open, while it is still in the working copy - or null.
 *
 * validateProject is all-or-nothing, so one bad scene, package or test refuses the whole document. The boot
 * path then falls back to the legacy scene key (or a default scene); saving that fallback would replace a
 * document this build cannot read before the user saw anything. So the refused document stays exactly where
 * it is: {@link saveStoredProject} will not write over it and the library will not file over its record,
 * until the user downloads or discards it (the banner, App.tsx).
 */
export function unopenedProject(): UnopenedProject | null {
  if (unopened !== null && workingCopyText() !== unopened.raw) unopened = null
  return unopened && { name: unopened.name, errors: unopened.errors }
}

// ── another tab ──────────────────────────────────────────────────────────────────────────────────────
//
// Two tabs can have the same document open, and each save writes the whole document. With no guard, the second one
// to save would silently replace everything the first had saved (parts added, programs, the name).
//
// So a session may only write over the working copy it last read or wrote. The tab that finds another tab's
// write there (by the storage event, or by comparing on its next save) stops saving for good and goes
// view-only. Reloading it rejoins, as the tab that holds the latest copy.
//
// IndexedDB has no storage event, so each library document is followed by a stamp of its own in localStorage: a few
// bytes, changed by every save that changes it. Tabs on different documents never see each other's stamps. A save
// of exactly what was there keeps the stamp, so a second tab opening the same project and saving it unchanged is no
// conflict.

const STAMP_PREFIX = 'oip-web/project-stamp/'
const stampKey = (doc: string): string => STAMP_PREFIX + doc
/**
 * The one stamp builds before per-document stamps watched. Every save also changes it, so a tab still on such a build
 * after a deploy yields to this one rather than write over the same document. Nothing here reads it. Remove it once
 * no open tab can still be running such a build.
 */
const OLD_BUILD_STAMP_KEY = 'oip-web/project-stamp'

/** Is a storage event for `key` another tab's write of this tab's working copy (main.tsx listens)? */
export function isWorkingCopyKey(key: string): boolean {
  if (inLibrary === null) return key === PROJECT_KEY
  const doc = currentDocumentId()
  return doc !== null && key === stampKey(doc)
}

/** What another tab's write changes: document `doc`'s stamp, or the localStorage working copy itself. */
function workingCopyToken(doc = currentDocumentId()): string | null {
  if (inLibrary === null) return safeGet(PROJECT_KEY)
  return doc === null ? null : safeGet(stampKey(doc))
}

/** Forget a deleted document's stamp and any page-close copy of it. */
export function dropDocumentKeys(doc: string): void {
  try {
    localStorage.removeItem(stampKey(doc))
  } catch {
    /* blocked storage: it was never written */
  }
  dropJournal(doc)
}

/**
 * The working copy as this session last read or wrote it, per document, and the Storage that was in. Per document
 * because a switch writes the incoming document before the pointer moves to it, and the outgoing one must not look
 * changed meanwhile. Keyed by the storage object so a fresh one (a test's stub) starts unguarded rather than
 * inheriting a stale expectation.
 */
let lastSeen: { storage: Storage; tokens: Map<string | null, string | null> } | null = null
/** The storage in which another tab's write was seen, if one was. Sticky for the session. */
let supersededIn: Storage | null = null
const supersededListeners = new Set<() => void>()

function currentStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function remember(token: string | null, doc = currentDocumentId()): void {
  const storage = currentStorage()
  if (storage === null) return void (lastSeen = null)
  if (lastSeen?.storage !== storage) lastSeen = { storage, tokens: new Map() }
  lastSeen.tokens.set(seenKey(doc), token)
}

/** The localStorage working copy is one copy whatever the pointer says, and it must not share a slot with a library
 *  document that has no id yet: a discard moves from the one to the other (discardUnopenedProject). */
const LOCAL_COPY = 'localStorage'
const seenKey = (doc: string | null): string | null => (inLibrary === null ? LOCAL_COPY : doc)

/** The stamp this session last saw for `doc`. A document it has not read or saved (one just minted) is expected to
 *  have none. */
function seenToken(seen: NonNullable<typeof lastSeen>, doc: string | null): string | null {
  return seen.tokens.get(seenKey(doc)) ?? null
}

function markSuperseded(storage: Storage): void {
  if (supersededIn === storage) return
  supersededIn = storage
  for (const cb of supersededListeners) cb()
}

/** Has another tab written the working copy since this session last read or wrote it? Stays true once it is. */
export function workingCopySuperseded(): boolean {
  const storage = currentStorage()
  return storage !== null && supersededIn === storage
}

/** Hear the moment this session loses the working copy to another tab (main.tsx makes the tab view-only). */
export function onWorkingCopySuperseded(cb: () => void): () => void {
  supersededListeners.add(cb)
  return () => supersededListeners.delete(cb)
}

/**
 * Report a write to the working copy made by another tab (the `storage` event, main.tsx). A write of exactly
 * what this session last saw is no conflict: that is another tab opening the same project and saving it
 * unchanged. Anything else means the two tabs have diverged, and this one stops. Returns whether it did.
 */
export function noteWorkingCopyWrite(newValue: string | null): boolean {
  const storage = currentStorage()
  if (storage === null || lastSeen === null || lastSeen.storage !== storage) return false
  if (newValue === seenToken(lastSeen, currentDocumentId())) return false
  markSuperseded(storage)
  return true
}

/** The same check, made at save time: the storage event is dispatched asynchronously, so a save can run
 *  after another tab's write is in storage but before its event arrives. */
function writtenElsewhere(): boolean {
  const storage = currentStorage()
  if (storage === null) return false
  if (supersededIn === storage) return true
  if (lastSeen === null || lastSeen.storage !== storage) return false
  const doc = currentDocumentId()
  if (workingCopyToken(doc) === seenToken(lastSeen, doc)) return false
  markSuperseded(storage)
  return true
}

export const SUPERSEDED_MESSAGE =
  'This project was changed in another tab, so this tab stopped saving rather than overwrite it. Reload to continue here.'

/**
 * Why this session may not write the working copy, or null when it may: a stored project it could not open
 * is there ({@link unopenedProject}), or another tab has written it ({@link workingCopySuperseded}). Every
 * path that replaces the working copy or files it in the library asks this first.
 */
export function workingCopyRefusal(): string | null {
  const held = unopenedProject()
  if (held) {
    const which = held.name !== null ? `“${held.name}”` : 'Your saved project'
    return `${which} could not be opened, so nothing is saved over it. Download or discard it to go on saving.`
  }
  return workingCopySuperseded() ? SUPERSEDED_MESSAGE : null
}

/** The name a refused document carries, if it parsed into an object with one. */
function nameOf(data: unknown): string | null {
  const name = typeof data === 'object' && data !== null ? (data as { name?: unknown }).name : undefined
  return typeof name === 'string' && name !== '' ? name : null
}

/**
 * Load the persisted project for the solo boot path. Prefers the working copy ({@link openWorkingCopy} has read it);
 * when there is none, migrates from the legacy single-scene keys (autosave scene + ST program + user-packages) so a
 * returning user's work upgrades in place. Returns null only when nothing usable is persisted (a first-ever visit, or a
 * refused doc with no legacy scene behind it) - the caller then falls back to a default scene.
 *
 * A project doc that is present but refused still falls through to the legacy keys, so the editor opens on
 * something, but it is recorded first ({@link unopenedProject}) and nothing may write over it.
 */
export function loadStoredProject(): LoadedProject | null {
  if (typeof localStorage === 'undefined') return null
  unopened = null
  // 1. the unified project doc, if present
  const raw = workingCopyText()
  remember(workingCopyToken())
  if (raw) {
    let data: unknown
    let parsed = true
    // its models and textures come back from the asset store, read before the boot (openWorkingCopy)
    const missing: string[] = []
    try {
      data = JSON.parse(raw, localAssetReviver(missing))
    } catch (e) {
      parsed = false
      unopened = { raw, name: null, errors: [`not valid JSON (${e instanceof Error ? e.message : String(e)})`] }
    }
    // some of its models are gone from this browser's storage: refused, so nothing saves over the text that names them
    if (parsed && missing.length > 0) {
      parsed = false
      unopened = {
        raw,
        name: nameOf(data),
        errors: [`${missing.length === 1 ? 'a model or texture it uses is' : `${missing.length} models or textures it uses are`} missing from this browser's storage`],
      }
    }
    if (parsed) {
      const result = validateProject(data)
      if (result.ok) {
        const project = result.project
        if (result.migratedFromV1) {
          // v1 library = authored ∪ placement snapshots; keep only what's provably not first-party
          for (const p of [project, ...(result.splitOff ?? [])]) {
            const authored = dropBundledIds(p.packages ?? [])
            if (authored.length > 0) p.packages = authored
            else delete p.packages
          }
        }
        return split(project, result.splitOff)
      }
      unopened = { raw, name: nameOf(data), errors: result.errors }
    }
  }
  // 2. migrate from the legacy single-scene keys. The legacy user-packages key was polluted the
  // same way a v1 library was (older builds seeded placement snapshots back into userPackages, and
  // any authoring action re-persisted them here), so it gets the same bundled-id filter.
  // Only this document's: every tab and window writes these keys, so another one's would open here under this id.
  const legacyScene = legacyKeyIsMine('scene') ? readLegacyScene() : null
  if (!legacyScene) return null // nothing persisted: first-ever visit
  const program = legacyKeyIsMine('program')
  return split(
    assembleProject(legacyScene, program ? readStProgram() : '', dropBundledIds(readLegacyUserPackages()), undefined, program ? readStScanMs() : undefined),
  )
}

// Which document last wrote each legacy key. Tabs and windows on different documents all write them, so the fallback
// above reads one only when it is the open document's.
const LEGACY_OWNER_KEYS = { scene: 'oip-web/autosave-doc', program: 'oip-web/st-program-doc' } as const

/** Record that the open document just wrote the legacy `which` key (store.persist, store.persistStProgram). */
export function noteLegacyWrite(which: keyof typeof LEGACY_OWNER_KEYS): void {
  const doc = currentDocumentId()
  try {
    if (doc === null) localStorage.removeItem(LEGACY_OWNER_KEYS[which])
    else localStorage.setItem(LEGACY_OWNER_KEYS[which], doc)
  } catch {
    /* blocked storage: the key was not written either */
  }
}

/**
 * May the open document read the legacy `which` key? Yes without a library (one document), and when no document
 * wrote it (a build from before the owners were recorded, migrating). Otherwise only when this document wrote it last.
 */
function legacyKeyIsMine(which: keyof typeof LEGACY_OWNER_KEYS): boolean {
  if (inLibrary === null) return true
  const owner = safeGet(LEGACY_OWNER_KEYS[which])
  return owner === null || owner === currentDocumentId()
}

/** Outcome of an autosave write. A failure is never thrown (editing must not break) but it must not be
 *  silent either: a failed write means everything since the last good one is gone on reload, so the
 *  caller has to be able to tell the author. See {@link saveStoredProject}. */
export type SaveResult = { ok: true } | { ok: false; quota: boolean; message: string }

/** Is this the browser's "you're out of localStorage" error? Chrome/Firefox throw a DOMException named
 *  `QuotaExceededError` (code 22); Firefox's legacy name/code is `NS_ERROR_DOM_QUOTA_REACHED` (1014).
 *  Older Safari in private mode throws the same QuotaExceededError with a zero quota. */
function isQuotaError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as DOMException).code
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014
}

/** Why a switch, an import or a folder open stopped: the incoming project's row did not commit. */
export const WORKING_COPY_UNSTORED = 'This browser would not store the project, so nothing was replaced. Export the one you have open (.oip) to keep a copy.'

const UNSAVED: SaveResult = {
  ok: false,
  quota: false,
  message: 'This browser would not store this project, so it could not be autosaved. Export the project to a .oip file to keep your work.',
}

// the library working copy's writes: the latest waiting, the one in flight, and the last one's failure until one succeeds
let pendingRow: { doc: string; name: string; text: string } | null = null
let writingRow: Promise<void> | null = null
let rowFailure: SaveResult | null = null
const rowListeners = new Set<(result: SaveResult) => void>()

/** Hear when the library working copy's writes start or stop failing (main.tsx sets the autosave banner). */
export function onWorkingCopyWrite(cb: (result: SaveResult) => void): () => void {
  rowListeners.add(cb)
  return () => rowListeners.delete(cb)
}

async function drainRowWrites(): Promise<void> {
  while (pendingRow !== null) {
    const w = pendingRow
    pendingRow = null
    const failure = (await writeRowText(w.doc, w.name, w.text)) ? null : UNSAVED
    if (failure === rowFailure) continue
    rowFailure = failure
    for (const cb of rowListeners) cb(failure ?? { ok: true })
  }
  writingRow = null
  if (journaled !== null && rowFailure === null) {
    dropJournal(journaled)
    journaled = null
  }
}

/** Where a page being closed keeps document `doc`'s latest text until its row write commits. */
const journalKey = (doc: string): string => `oip-web/project-journal/${doc}`

function dropJournal(doc: string): void {
  try {
    localStorage.removeItem(journalKey(doc))
  } catch {
    /* blocked storage: it was never written */
  }
}

// the document whose latest text also waits in localStorage for its row write (keepPendingWrite)
let journaled: string | null = null

/**
 * The page is being hidden or closed with a row write not yet committed. An unloading page's IndexedDB transaction
 * may be aborted, so the latest text also goes to localStorage, which is written at once, under the document's id so
 * a tab on another document never takes it. The next boot of that document moves it into the row (openWorkingCopy),
 * and a page that lives on removes it once the row commits.
 */
export function keepPendingWrite(): void {
  if (inLibrary === null || writingRow === null || inLibrary.text === null || inLibrary.doc === null || inLibrary.doc !== currentDocumentId()) return
  try {
    localStorage.setItem(journalKey(inLibrary.doc), inLibrary.text)
    journaled = inLibrary.doc
  } catch {
    /* too large or blocked: the row write is all there is */
  }
}

/** Resolves once every queued working-copy write has settled: true when the last one committed, or there was none to make. */
export async function flushWorkingCopy(): Promise<boolean> {
  while (writingRow !== null) await writingRow
  return rowFailure === null
}

/** Write the working copy into document `target`'s row (the open one's when not given), stamping it for the other tabs. */
function saveToLibrary(library: { doc: string | null; text: string | null }, text: string, name: string, target?: string): SaveResult {
  let doc = target ?? currentDocumentId()
  // no pointer yet (a first-ever visit, an unopened project discarded): what is on screen gets a record of its own
  if (doc === null) {
    doc = mintDocumentId()
    announceCurrentDocument(doc)
  }
  // exactly what is stored: nothing to write, and the stamp stays, so another tab holding it is not superseded
  if (doc === library.doc && text === library.text && rowFailure === null) return { ok: true }
  try {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem(stampKey(doc), stamp)
    localStorage.setItem(OLD_BUILD_STAMP_KEY, `${doc}:${stamp}`)
    remember(stamp, doc)
  } catch {
    /* full or blocked: the other tabs are not told, and the row is written regardless */
  }
  inLibrary = { doc, text }
  pendingRow = { doc, name, text }
  writingRow ??= drainRowWrites()
  return rowFailure ?? { ok: true }
}

/**
 * Write the project as the working copy (solo autosave). Never throws - a failed autosave must not break editing -
 * but it reports, because the failure mode is silent data loss: a swallowed failure would leave the author working
 * against an autosave that had stopped, and the reload would take everything with it. Callers surface a failure
 * (store.persistProject → the autosave banner).
 *
 * `doc`: the document whose working copy this is, when it is not the open one - a switch or an import writes the
 * incoming project before the pointer moves to it. Used only by a library working copy.
 */
export function saveStoredProject(project: ProjectJSON, opts?: { doc?: string }): SaveResult {
  if (typeof localStorage === 'undefined') return { ok: true }
  // Every write of the working copy comes through here - the autosave, an import, a shelf switch, a linked
  // folder - so these guards are what keep a document this build could not open, or one another tab has
  // just saved, from being replaced.
  const refused = workingCopyRefusal() ?? (writtenElsewhere() ? SUPERSEDED_MESSAGE : null)
  if (refused !== null) return { ok: false, quota: false, message: refused }
  try {
    // compact: this is the browser autosave, not a file a user opens. The 2-space indent doubles it
    // (228 KB of demo project becomes 461 KB of text), and every edit would spend that twice, once
    // building the string and once writing it. Exported .oip files keep the readable form.
    // Models and textures are written as their hashes once their bytes are in IndexedDB (localAssets.ts).
    // After keepDefinitionsOnce, which can add a built-in's full copy.
    const text = serializeProject(withLocalAssets(keepDefinitionsOnce(project)), { pretty: false })
    if (inLibrary !== null) return saveToLibrary(inLibrary, text, project.name, opts?.doc)
    localStorage.setItem(PROJECT_KEY, text)
    remember(text)
    return { ok: true }
  } catch (e) {
    const quota = isQuotaError(e)
    return {
      ok: false,
      quota,
      message: quota
        ? 'The browser ran out of local storage, so this project could not be autosaved. Large imported models are the usual cause - export the project to a .oip file to keep your work.'
        : `This project could not be autosaved: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * The working copy as stored, once its queued writes have settled: the open document's row, or localStorage's. For
 * the e2e gates (App.tsx's test hook), which check what a reload would open.
 */
export async function savedWorkingCopyText(): Promise<string | null> {
  if (inLibrary === null) return safeGet(PROJECT_KEY)
  await flushWorkingCopy()
  const doc = currentDocumentId()
  return doc === null ? null : ((await readRowText(doc))?.text ?? null)
}

/**
 * Every stored text that may name a model by hash, for the asset sweep (localAssets.sweepLocalAssets): every library
 * row, the working copy and the legacy scene key. Null when the library could not be read, so nothing is swept.
 */
export async function storedAssetTexts(): Promise<(string | null)[] | null> {
  const rows = supportsDocumentLibrary() ? await allRowTexts() : []
  return rows === null ? null : [...rows, workingCopyText(), safeGet(LEGACY_SCENE_KEY)]
}


// ───────────────────────── an older project's other scenes, waiting to be filed ─────────────────────────
//
// An older multi-scene document splits when it is read (core/project/project.ts validateProject): the scene that was active
// is the project, every other one a project of its own. Filing those is the library's job (documentStore), which
// is async and lives above this module - so a split found by a path that then reloads (an import, a folder opened)
// parks them here, and the next boot files them (main.tsx). A browser with no library keeps them parked: they are
// not lost, and the notice says how to get them out (file.exportSplitOff).

export const SPLIT_OFF_KEY = 'oip-web/split-off'

// Every rewrite keeps the entries this build cannot read. Dropping them would erase a parked scene for good the first
// time a stricter validateProject meets it; kept, a later build that reads it still files it.

/** The parked list as stored, unvalidated; [] when there is none or the blob is damaged. */
function readParkedRaw(): unknown[] {
  const raw = safeGet(SPLIT_OFF_KEY)
  if (!raw) return []
  try {
    const list: unknown = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch {
    // the blob is our own JSON, so a parse failure means it was damaged and cannot be recovered
    return []
  }
}

/** Replace the parked list; an empty list removes the key. Throws when storage refuses the write. */
function writeParkedRaw(list: readonly unknown[]): void {
  if (list.length === 0) localStorage.removeItem(SPLIT_OFF_KEY)
  else localStorage.setItem(SPLIT_OFF_KEY, JSON.stringify(list))
}

const parkedReadable = (d: unknown): boolean => validateProject(d).ok

/** Park `projects` for the next boot to file, beside any already parked. */
export function parkSplitOff(projects: readonly ProjectJSON[]): SaveResult {
  if (typeof localStorage === 'undefined' || projects.length === 0) return { ok: true }
  try {
    writeParkedRaw([...readParkedRaw(), ...projects.map((p) => JSON.parse(serializeProject(p, { pretty: false })) as unknown)])
    return { ok: true }
  } catch (e) {
    return { ok: false, quota: isQuotaError(e), message: `The project's other scenes could not be kept for filing: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The parked projects this build can read, validated (an unreadable entry is skipped here and kept in storage). */
export function readParkedSplitOff(): ProjectJSON[] {
  return readParkedRaw().flatMap((d) => {
    const r = validateProject(d)
    return r.ok ? [r.project] : []
  })
}

/**
 * Unpark the first `count` readable parked projects (the ones just filed), keeping the rest for the next try. Filing
 * goes one project at a time, so a failure part way leaves only what is still unfiled parked, and a retry cannot file
 * the same project twice.
 */
export function unparkSplitOff(count: number): void {
  let filed = 0
  const rest = readParkedRaw().filter((d) => {
    if (filed >= count || !parkedReadable(d)) return true
    filed++
    return false
  })
  try {
    writeParkedRaw(rest)
  } catch {
    /* blocked storage: nothing was parked */
  }
}

/** Forget the parked projects, once they are filed: every readable one. An entry this build cannot read stays. */
export function clearParkedSplitOff(): void {
  try {
    writeParkedRaw(readParkedRaw().filter((d) => !parkedReadable(d)))
  } catch {
    /* blocked storage: nothing was parked */
  }
}

// ───────────────────────── .oip export / import ─────────────────────────

/**
 * Download the full project (the scene, its program, the authored library and tests) as one `.oip`
 * file: the project folder layout, zipped (core/project/projectArchive.ts; the .docx model). Unzip it and
 * you have the git/VS Code-editable folder; zip a folder by hand and it imports the same way.
 */
export async function downloadProject(store: EditorStore, leaveOut: ExportLeaveOut = {}): Promise<void> {
  // what Export Project's choices leave out (ExportProjectDialog); nothing by default, so a backup is whole
  const project = trimForExport(store.snapshotProject(), leaveOut)
  // a .oip is complete by construction: the bytes of every shipped model its parts name go in as files, fetched
  // first if this session has not needed them yet (shippedAssetCache.ts)
  await warmShippedAssets(project.packages ?? [])
  const bytes = await projectToOipBytes(project, FOLDER_OPTIONS)
  saveBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${fileStem(project.name)}.oip`)
  // the library travels in the .oip too, so a room's held code is left out of this one the same way
  noticeHeldCodeInExport(store)
}

/**
 * What Export Project could leave out of the open project, counted, for its choices (ExportProjectDialog). All zero
 * means there is nothing to choose, and the command downloads at once.
 */
export function exportChoicesFor(project: ProjectJSON): { unusedParts: string[]; tests: number } {
  return {
    unusedParts: unusedLibraryParts(project).map((p) => p.name),
    tests: project.tests?.length ?? 0,
  }
}

/** Download one project (not the open one) as its own `.oip` file: an older project's scene waiting to be filed. */
export async function downloadProjectDocument(project: ProjectJSON): Promise<void> {
  await warmShippedAssets(project.packages ?? [])
  const bytes = await projectToOipBytes(project, FOLDER_OPTIONS)
  saveBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${fileStem(project.name)}.oip`)
}

function fileStem(name: string | null): string {
  return (name ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Hand the unopened project over as a file, exactly as stored (indented when it parses, so it can be fixed by
 * hand). It is the flat-JSON document form, which Import project reads once it validates.
 */
export function downloadUnopenedProject(): void {
  const held = unopenedProject()
  if (!held || unopened === null) return
  let text = unopened.raw
  try {
    text = JSON.stringify(JSON.parse(text), null, 2) + '\n'
  } catch {
    // not JSON at all: hand it over byte for byte
  }
  saveBlob(new Blob([text], { type: 'application/json' }), `${fileStem(held.name)}-unopened.json`)
}

/**
 * Give up on the unopened project: remove it from the working copy and save what is on screen instead.
 *
 * The document pointer is cut loose on the way (as an import does), so what is on screen is filed as a new
 * library document and the unopened one's record - possibly an older version that still opens - is left
 * exactly as it was. The caller confirms first.
 */
export function discardUnopenedProject(store: EditorStore): void {
  if (!unopenedProject()) return
  // a library working copy is its record, which is kept: cutting the pointer below is what lets go of it
  if (inLibrary === null) {
    try {
      localStorage.removeItem(PROJECT_KEY)
    } catch {
      /* blocked storage: nothing was being saved anyway */
    }
    // the refused text kept the working copy in localStorage (openWorkingCopy); with it gone, the save below files
    // what is on screen as a library row of its own, as the next boot would
    if (supportsDocumentLibrary()) inLibrary = { doc: null, text: null }
  }
  remember(workingCopyToken())
  unopened = null
  forgetCurrentDocument()
  store.setUnopenedProject(null)
  store.persistProject()
}

/** A v1 library mixes authored parts with placement snapshots: keep only what is provably not first-party. */
export function dropV1Snapshots(result: { project: ProjectJSON; splitOff?: ProjectJSON[]; migratedFromV1?: true }): void {
  if (!result.migratedFromV1) return
  for (const p of [result.project, ...(result.splitOff ?? [])]) {
    const authored = dropBundledIds(p.packages ?? [])
    if (authored.length > 0) p.packages = authored
    else delete p.packages
  }
}

/**
 * Adopt a freshly validated imported project as the stored project and reboot into it. Shared by the
 * web `.oip` import and the desktop folder open (desktopProjectBridge). Adoption is a write of the working copy +
 * reload rather than store.loadProject(): swapping projects in place would have to orchestrate the
 * full boot surface by hand - retire the old library's (authoritative) registrations without orphaning
 * placed parts, replace userPackages, refresh the catalog, and reload the scene/sim - and any missed
 * step leaves the previous project's parts shadowing the imported one's snapshots (the
 * placed-part-freeze family). The reload reuses the one tested boot path (loadStoredProject) instead.
 * A v1 document's library gets the same bundled-id filter that path applies (see dropBundledIds).
 * Without it, saving the migrated doc as v2 would freeze placed parts for imports.
 */
export async function adoptImportedProject(
  result: { project: ProjectJSON; splitOff?: ProjectJSON[]; migratedFromV1?: true },
  /**
   * `docId`: the library document the project is, when it is already known - a desktop project folder,
   * whose document the shell remembers by path, or one given an id before the reload so its folder can be
   * recorded against it. Otherwise a library working copy gets a record of its own, and a localStorage one cuts the
   * pointer loose, so the import is an addition: the outgoing document keeps its record.
   */
  opts?: { docId?: string },
): Promise<SaveResult> {
  const project = result.project
  dropV1Snapshots(result)
  // an older multi-scene document's other scenes ride across the reload, and the next boot files them
  if (result.splitOff && result.splitOff.length > 0) {
    const parked = parkSplitOff(result.splitOff)
    if (!parked.ok) return parked
  }
  // Adoption is "write, then reload into it", so a failed write must not reload: the reload would boot the
  // previous project and the import would vanish with no explanation. Report instead and stay put. (That
  // includes an unopened project in the working copy, which saveStoredProject refuses to write over.)
  const doc = opts?.docId ?? (workingCopyInLibrary() ? mintDocumentId() : undefined)
  const saved = saveStoredProject(project, doc !== undefined ? { doc } : undefined)
  if (!saved.ok) return saved
  if (!(await flushWorkingCopy())) return { ok: false, quota: false, message: WORKING_COPY_UNSTORED }
  if (doc !== undefined) setCurrentDocumentId(doc)
  else forgetCurrentDocument()
  clearEntryParams() // the reload opens the import, not the demo or a shared project the tab was in
  if (typeof location !== 'undefined') location.reload()
  return saved
}

/**
 * Parse + validate a legacy `.oip` JSON document and adopt it (replacing the current project).
 * Returns a human-readable error message, or null on success - on success the page reloads into the
 * import. The caller confirms the replacement first. In a shared project too: the reload leaves it for the import
 * (entryParams.ts), and the shared document is never written.
 */
export async function importProjectText(_store: EditorStore, text: string): Promise<string | null> {
  const result = parseProjectText(text)
  if (!result.ok) return result.message
  const adopted = await adoptImportedProject(result)
  return adopted.ok ? null : adopted.message
}

const FOLDER_MANIFEST_PICKED =
  "This is the project.json of a project folder: it only lists the folder's scene and test files, so it can't be loaded on its own. In the browser, load the project as a .oip file. In the desktop app, use Open Project Folder."

/** A project folder's index (core/project/projectFolder.ts) names its scene and tests by file path, where a one-file
 *  document holds them inline. Picked on its own it would fail validation path by path ("tests[0]: test must be a
 *  JSON object"), which says nothing about what went wrong. */
function isFolderManifest(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const d = data as { scene?: unknown; scenes?: unknown; tests?: unknown }
  const sceneByPath =
    typeof d.scene === 'string' ||
    (Array.isArray(d.scenes) && d.scenes.some((s) => typeof s === 'object' && s !== null && typeof (s as { scene?: unknown }).scene === 'string'))
  const testByPath = Array.isArray(d.tests) && d.tests.some((t) => typeof t === 'string')
  return sceneByPath || testByPath
}

function parseProjectText(text: string): { ok: true; project: ProjectJSON; splitOff?: ProjectJSON[]; migratedFromV1?: true } | { ok: false; message: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, message: 'File is not valid JSON' }
  }
  if (isFolderManifest(data)) return { ok: false, message: FOLDER_MANIFEST_PICKED }
  const result = validateProject(data)
  return result.ok ? result : { ok: false, message: `Invalid project:\n${result.errors.join('\n')}` }
}

/**
 * Import a `.oip` file of either format: the current zipped-folder archive (sniffed by the zip
 * magic; part folders re-baked through the canonical validator, so script errors fail the import
 * with diagnostics) or the legacy flat JSON document. Same contract as {@link importProjectText}.
 *
 * `beforeAdopt` runs once the file has validated and before it replaces anything - the caller files the
 * project being left in the library there (documentStore.fileOutgoingDocument), and a message it returns
 * cancels the import. Filing after validation means a broken file changes nothing. Filing here at all makes
 * "the one you have open now is kept under Projects" true without depending on the page's unload flush.
 */
export async function importProjectData(
  store: EditorStore,
  bytes: Uint8Array,
  opts?: { beforeAdopt?: () => Promise<string | null> },
): Promise<string | null> {
  const result = isZipData(bytes)
    ? await oipBytesToProject(bytes, { bakePart })
    : parseProjectText(new TextDecoder().decode(bytes))
  if (!result.ok) return 'message' in result ? result.message : `Invalid project:\n${result.errors.join('\n')}`
  const refused = (await opts?.beforeAdopt?.()) ?? null
  if (refused !== null) return refused
  // its models go to the asset store first, so the working copy can name them by hash (localAssets.ts)
  await storeLocalAssets(result.project)
  const adopted = await adoptImportedProject(result)
  return adopted.ok ? null : adopted.message
}
