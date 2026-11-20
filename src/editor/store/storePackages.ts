// The project's part library (store.userPackages): every change to it - an edit, a new part, a delete, a rename, the
// app's version taken, a project's or a peer's library registered - kept in step with the live registry and saved
// with the project. EditorStore's library methods forward here; its state stays the single source of truth.
import { asCopyOfBuiltIn, builtInChangedSince, builtInFingerprint } from '../../core/builtInVersion'
import { partFingerprint, withOrigin } from '../../core/parts/partOrigin'
import type { PartPackage } from '../../core/parts/partPackage'
import { getPackage, registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { newPartIdProblem, partsNaming, renamePartInScene } from '../../core/parts/partRename'
import { upgradeStoredPackage } from '../../core/parts/partUpgrade'
import { validatePartPackage } from '../../core/parts/partValidate'
import { referenceShippedAssets } from '../../core/shippedAssets'
import type { PartInstance, SdkPart } from '../../core/types'
import { warmShippedAssets } from '../parts/shippedAssetCache'
import { hasStoredProject } from '../project/projectFile'
import type { EditorState, EditorStore } from './store'
import { documentSceneOf } from './storeDocument'
import { COALESCE_MS } from './storeHistory'
import type { UndoHistory } from './storeHistory'
import type { RoomSinks } from './storeRoom'

// The library as a pre-project browser stored it. Read only: restoreUserPackages and the project migration
// (projectFile.readLegacyUserPackages); persistUserPackages drops it once the project doc holds the library.
export const USERPKG_KEY = 'oip-web/user-packages'

/**
 * After a custom part's live version changes (a geometry/behavior edit, or its undo/redo), keep the project's
 * library and its stored copy in sync. A part already in the library updates in place. Any other part (a built-in
 * first-party one, or one that arrived embedded in a scene) is copy-on-write: editing it adds this project's
 * version to the library, so the edit is the project's and survives reload. The library copy shadows a built-in by
 * id (the catalog de-dupes by id, preferring the library), while the pristine built-in stays the template elsewhere.
 * On the desktop the library is written to the project folder's parts/ by the folder sync, so this is also how an
 * in-app edit reaches the part's files - there is no separate "save part". A copy of a built-in records which
 * version of it it was made from (libraryCopyOf), and keeps that record through every later edit.
 */
export function syncUserCatalog(store: EditorStore, pkg: PartPackage): void {
  const state = store.getState()
  const cur = state.userPackages.find((p) => p.id === pkg.id)
  if (cur) {
    // an edit is built from the registered package, which may not carry the records of where the copy came from (a
    // built-in, the shelf): the library's copy keeps them, so "edited here" stays tellable from "never related"
    const origin = { ...cur.origin, ...pkg.origin }
    const next = Object.keys(origin).length > 0 ? { ...pkg, origin } : pkg
    store.setState({ userPackages: state.userPackages.map((p) => (p.id === pkg.id ? next : p)) })
    persistUserPackages(store)
    return
  }
  store.setState({ userPackages: [...state.userPackages, libraryCopyOf(state, pkg)] }) // copy-on-write: this project's version now
  persistUserPackages(store)
}

/**
 * `pkg` as it goes into this project's parts: a part with a built-in's id is this project's version OF that
 * built-in, so it is stamped with the built-in's fingerprint (core/builtInVersion.ts). Every way a built-in becomes
 * a library part goes through here (an in-app edit, "Open in external editor").
 */
export function libraryCopyOf(state: Pick<EditorState, 'bundledPackages'>, pkg: PartPackage): PartPackage {
  const builtIn = state.bundledPackages.find((p) => p.id === pkg.id)
  return builtIn ? asCopyOfBuiltIn(pkg, builtIn) : pkg
}

/**
 * The library parts that are this project's versions of a built-in the app has changed since the copy was made: the
 * project still uses its own, and the person should get to choose (the catalog's "Updated" badge, the Inspector).
 */
export function builtInsUpdated(state: Pick<EditorState, 'bundledPackages' | 'userPackages'>): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const p of state.userPackages) {
    if (builtInChangedSince(p, state.bundledPackages.find((b) => b.id === p.id))) ids.add(p.id)
  }
  return ids
}

/**
 * Keep this project's version of a built-in the app has updated: it stays exactly as it is, now recorded as made
 * from the current built-in, so the question isn't asked again until the app changes it once more. Not a part edit
 * (nothing about the part changes), so no undo step. False when there is nothing to keep.
 */
export function keepProjectVersion(store: EditorStore, packageId: string): boolean {
  const state = store.getState()
  const builtIn = state.bundledPackages.find((p) => p.id === packageId)
  const cur = state.userPackages.find((p) => p.id === packageId)
  if (!builtIn || !cur || state.readOnly) return false
  const next = withOrigin(cur, 'app', builtInFingerprint(builtIn))
  store.setState({ userPackages: state.userPackages.map((p) => (p.id === packageId ? next : p)) })
  // in a room the record moves for everyone, or the next peer to look would ask the question again
  store.sharePackageChange(next, `Kept this project's “${next.name}”`)
  persistUserPackages(store)
  return true
}

/**
 * Save a library change (solo only; in a room the shared doc owns packages). The library lives in the project doc,
 * so this is a project write. It does not also copy the library to {@link USERPKG_KEY}:
 * localStorage holds a few MB per origin, embedded models would take as much of it as the library itself, and the
 * reader ({@link restoreUserPackages}) only runs when there is no project doc. The copy a pre-project browser
 * left is dropped once the project doc holds the library.
 */
export function persistUserPackages(store: EditorStore): void {
  if (store.collab) return
  if (!store.persistProject().ok) return
  try {
    if (hasStoredProject()) localStorage.removeItem(USERPKG_KEY)
  } catch {
    // no storage, or it refused: the legacy copy stays where it was, unread while the project doc exists
  }
}

/**
 * Restore a pre-project browser's authored parts ({@link USERPKG_KEY}) at startup: validate each, register it (so
 * render + the Inspector resolve it and any placed instance picks up its latest version, overriding the
 * possibly-stale copy a loaded scene embedded), and surface it in the catalog so it stays placeable. Solo only. The
 * project-doc boot path uses {@link EditorStore.adoptProjectLibrary} instead, seeding from the loaded
 * project's shared library; this remains for the boot with no project doc, and nothing writes the key.
 */
export function restoreUserPackages(store: EditorStore): void {
  if (store.collab) return
  if (typeof localStorage === 'undefined') return
  let raw: string | null
  try {
    raw = localStorage.getItem(USERPKG_KEY)
  } catch {
    return
  }
  if (!raw) return
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return // corrupt store: ignore rather than throw at boot
  }
  if (!Array.isArray(arr)) return
  store.adoptProjectLibrary(arr.map((p: unknown) => upgradeStoredPackage(p).pkg).filter((p): p is PartPackage => validatePartPackage(p).length === 0))
}

// ---- the library operations behind EditorStore's methods of the same names ----------------------------------

/** The store's own areas a library change touches: the undo history (a part's edit steps) and the room's sinks. */
export interface LibraryAreas {
  history: UndoHistory
  room: RoomSinks
  /** whether the store is view only (EditorStore.setReadOnly) */
  readOnly: () => boolean
}

/**
 * Author mode: commit a custom-part package edit (geometry/joints/assets) to the same undo stack as scene
 * edits, and register it live. `before` defaults to the currently-registered package. Bumps packageRev so
 * React re-reads the registry (Inspector reflects the edit/undo). Coalesces rapid same-key edits (e.g.
 * dragging one inspector field). In a room this registers + broadcasts via the package sink (no local
 * snapshot undo - the shared doc is the source of truth, like a scene commit).
 */
export function commitPackage(store: EditorStore, areas: LibraryAreas, label: string, pkg: PartPackage, opts?: { coalesceKey?: string; before?: PartPackage }): void {
  if (areas.readOnly()) {
    const cur = getPackage(pkg.id)
    if (cur) registerPackage(cur) // revert any transient preview
    return
  }
  // Author-mode guard: a structurally invalid edit must never register (render + sim would build from it).
  // Block the commit, roll the registry back to the last-good version (the caller's `before` baseline when
  // given - e.g. a drag's pre-edit package - else whatever is currently registered), and surface the
  // diagnostics on the same ⚠ badge + toast the desktop build failures use (the Inspector echoes it inline).
  const problems = validatePartPackage(pkg)
  if (problems.length > 0) {
    const lastGood = opts?.before ?? getPackage(pkg.id)
    if (lastGood) registerPackage(lastGood)
    store.applyPackageStatuses([
      { id: pkg.id, name: pkg.name, dir: '', ok: false, error: problems.map((p) => `${p.field}: ${p.message}`).join('\n') },
    ])
    return
  }
  const before = opts?.before ?? getPackage(pkg.id)
  registerPackage(pkg)
  // a good commit clears any lingering failed-edit badge (mirrors a successful desktop rebuild)
  if (store.getState().packageBuildErrors[pkg.id]) {
    store.applyPackageStatuses([{ id: pkg.id, name: pkg.name, dir: '', ok: true }])
  }
  store.setState({ packageRev: store.getState().packageRev + 1 })
  // an authored part edited in-app: keep its catalog card + localStorage copy current (no-op otherwise)
  syncUserCatalog(store, pkg)
  // In a room, push the committed package to the shared doc instead of the local snapshot stack - this is
  // what makes an authored part / behavior-script edit reach peers. (The sink is only set in room mode.)
  if (store.collab) {
    areas.room.feed(() => ({ label, time: Date.now(), kind: 'package', coalesceKey: opts?.coalesceKey }))
    areas.room.sendPackage(pkg)
    return
  }
  if (!before) return // without a baseline there's nothing to diff into an undo entry
  // Skip a no-op edit: a number field fires onCommit twice (change + blur), so the same value is recorded as a
  // real entry {a→b} then a dead {b→b}. Without this the dead entry sits on top and the first Ctrl+Z does
  // nothing. Compare both geometry and the behavior script: a behavior-script edit leaves geometry
  // untouched, so a geometry-only check would wrongly treat it as a no-op and drop it from undo entirely -
  // the live package was already swapped, leaving a behavior change that Ctrl+Z couldn't reach. (Both are
  // cheap: geometry is small and behavior is a string; large assets ride along with a geometry change.) The name
  // and category are compared too, so renaming a part is an undo step (controller setPartInfo).
  if (
    JSON.stringify(before.geometry) === JSON.stringify(pkg.geometry) &&
    before.behavior === pkg.behavior &&
    before.name === pkg.name &&
    before.category === pkg.category
  )
    return
  const now = Date.now()
  const top = areas.history.coalescibleTop()
  if (
    opts?.coalesceKey !== undefined &&
    top?.kind === 'package' &&
    top.id === pkg.id &&
    top.coalesceKey === opts.coalesceKey &&
    now - top.time < COALESCE_MS
  ) {
    areas.history.replaceTop({ ...top, after: pkg, time: now })
  } else {
    areas.history.record({ kind: 'package', label, coalesceKey: opts?.coalesceKey, id: pkg.id, before, after: pkg, time: now })
  }
}

/** Add (or replace by id) an in-app authored package so it shows in the catalog (the "New part" flow). */
export function addUserPackage(store: EditorStore, areas: LibraryAreas, pkg: PartPackage): void {
  void warmShippedAssets([pkg])
  const rest = store.getState().userPackages.filter((p) => p.id !== pkg.id)
  store.setState({ userPackages: [...rest, pkg] })
  // a freshly-authored part is an authoritative package change too: broadcast it so peers can see/place it
  if (store.collab) {
    areas.room.feed(() => ({ label: `New part “${pkg.name}”`, time: Date.now(), kind: 'package' }))
    areas.room.sendPackage(pkg)
  }
  persistUserPackages(store)
}

/**
 * Everything that still references a custom part, as human-readable holders ("the scene"). Placed instances resolve their geometry/behavior through the registry, so a
 * non-empty result blocks {@link removeUserPackage} unless the id shadows a bundled/folder copy
 * (deleting a shadow reverts - the fallback keeps resolving). Scans the live scene for the active
 * slot (its project copy is stale until capture).
 */
export function packageUsage(store: EditorStore, packageId: string): string[] {
  const uses = (parts: readonly PartInstance[]): boolean =>
    parts.some((p) => p.type === 'part' && (p as SdkPart).packageId === packageId)
  const used: string[] = []
  if (uses(documentSceneOf(store.getState()).parts)) used.push('the scene')
  return used
}

/**
 * Delete an authored part from the user library (the catalog ✕ - a library edit like removePrefab, not
 * a scene edit, and not undoable). The project's copy of a built-in goes back to the app's current version
 * instead: still the project's own copy while anything places it (the library stays complete,
 * docs/part-sources.md), gone when nothing does, and placed instances rebuild against it through the ordinary
 * package-reload seam. Anything else unregisters entirely, so the delete is
 * refused while the scene still references it ({@link packageUsage} - surface those to the
 * user first), and while the part is open for editing. In a room it leaves everyone's library (the room's
 * remover, collab/bridge.ts, and {@link applyRemotePackages} on each peer). Returns whether the package was removed.
 */
export function removeUserPackage(store: EditorStore, areas: LibraryAreas, packageId: string): boolean {
  if (areas.readOnly()) return false
  if (!store.getState().userPackages.some((p) => p.id === packageId)) return false
  if (store.getState().packageEdit?.packageId === packageId) return false // its throwaway is live in the scene
  const fallback = store.getState().bundledPackages.find((p) => p.id === packageId)
  if (!fallback && packageUsage(store, packageId).length > 0) return false
  // a deleted part's edit history must not resurrect it (or re-fork a reverted bundle) via Ctrl+Z
  areas.history.dropPackages((id) => id === packageId)
  const reset = dropFromLibrary(store, packageId)
  areas.room.removePackage(packageId, reset ?? null)
  persistUserPackages(store)
  return true
}

/**
 * Take a part out of the library: a built-in's copy goes back to the app's version (returned) while anything still
 * places it, anything else unregisters. The half of a delete that a peer's delete repeats here (applyRemotePackages).
 */
function dropFromLibrary(store: EditorStore, packageId: string): PartPackage | undefined {
  if (store.getState().placingPackageId === packageId) store.cancelPlacing()
  const fallback = store.getState().bundledPackages.find((p) => p.id === packageId)
  const errors = { ...store.getState().packageBuildErrors }
  delete errors[packageId] // a stale ⚠ badge must not carry over to a reverted card
  // still placed: the app's version, as this project's own copy
  const reset = fallback && packageUsage(store, packageId).length > 0 ? withOrigin(fallback, 'app', partFingerprint(fallback)) : undefined
  store.setState({
    userPackages: reset
      ? store.getState().userPackages.map((p) => (p.id === packageId ? reset : p))
      : store.getState().userPackages.filter((p) => p.id !== packageId),
    packageRev: store.getState().packageRev + 1,
    packageBuildErrors: errors,
    // close the behavior editor if it's on the deleted part - a later save would just re-fork it
    behaviorEditTarget: store.getState().behaviorEditTarget === packageId ? null : store.getState().behaviorEditTarget,
  })
  if (fallback) registerPackage(fallback, true) // revert: rev-bump + notify reloads any placed instance
  else unregisterPackage(packageId)
  return reset
}

/**
 * Give a project's own part a new id, and move every placed copy to it (docs/parts-shelf.md, "Identity": the way out
 * when a different part on the shelf has the same id). A library change like Import part, not an undo step, and the
 * undo history is rewritten so no earlier step brings the old id back. Refused in a room (the package sink has no
 * removal channel), while running or editing the part, for a built-in's copy (Save as a New Part makes a variant),
 * and while another part's definition names it, since that part's script would have to change. Returns '' or why not.
 */
export function renameUserPackage(store: EditorStore, areas: LibraryAreas, from: string, to: string): string {
  if (areas.readOnly()) return 'This project is view only.'
  if (store.collab) return 'A part cannot be renamed in a shared project.'
  if (store.getState().running) return 'Stop the simulation first.'
  if (store.getState().packageEdit) return 'Close the part you are editing first.'
  const pkg = store.getState().userPackages.find((p) => p.id === from)
  if (!pkg) return `This project has no part “${from}”.`
  if (store.getState().bundledPackages.some((p) => p.id === from)) return `“${pkg.name}” is this project's copy of a built-in part. Save it as a new part instead.`
  const problem = newPartIdProblem(to, (id) => getPackage(id) !== undefined || store.getState().userPackages.some((p) => p.id === id))
  if (problem !== '') return problem
  const naming = partsNaming(store.getState().userPackages, from)
  if (naming.length > 0) return `${naming.map((p) => `“${p.name}”`).join(', ')} names “${pkg.name}” in its definition, so it cannot be renamed.`
  const renamed: PartPackage = { ...pkg, id: to }
  const bad = validatePartPackage(renamed)
  if (bad.length > 0) return bad.map((p) => `${p.field}: ${p.message}`).join('; ')

  if (store.getState().placingPackageId === from) store.cancelPlacing()
  areas.history.renamePart(from, to)
  const errors = { ...store.getState().packageBuildErrors }
  if (errors[from] !== undefined) {
    errors[to] = errors[from]
    delete errors[from]
  }
  registerPackage(renamed, true)
  store.setState({
    userPackages: store.getState().userPackages.map((p) => (p.id === from ? renamed : p)),
    scene: renamePartInScene(store.getState().scene, from, to),
    packageRev: store.getState().packageRev + 1,
    packageBuildErrors: errors,
    behaviorEditTarget: store.getState().behaviorEditTarget === from ? to : store.getState().behaviorEditTarget,
  })
  // nothing resolves the old id any more, so the shelf's part of that id can come in
  unregisterPackage(from)
  // the project doc carries the scene and the library together, so this one write keeps them in step
  persistUserPackages(store)
  return ''
}

/**
 * Take the app's current version of these built-ins as this project's copies (the update prompt's Update all, and
 * "Use the app's new version"): each library copy is replaced by a fresh copy of the app's built-in, stamped with its
 * fingerprint, and placed instances rebuild through the ordinary package-reload seam. Only ever explicit: nothing
 * calls this on its own (docs/part-sources.md). A library change like Import part, so not an undo step, and the
 * part's edit history goes (Ctrl+Z must not bring back the version just replaced). In a room it is a library change
 * for everyone there: each new copy goes out over the room like any part edit, with a line in the room's feed saying
 * why the part changed. Refused read-only. Returns the ids it updated.
 */
export function updateFromApp(store: EditorStore, areas: LibraryAreas, packageIds: readonly string[]): string[] {
  if (areas.readOnly()) return []
  const want = new Set(packageIds.filter((id) => id !== store.getState().packageEdit?.packageId))
  const fresh = new Map<string, PartPackage>()
  for (const p of store.getState().userPackages) {
    const builtIn = want.has(p.id) ? store.getState().bundledPackages.find((b) => b.id === p.id) : undefined
    if (builtIn) fresh.set(p.id, withOrigin(builtIn, 'app', partFingerprint(builtIn)))
  }
  if (fresh.size === 0) return []
  areas.history.dropPackages((id) => fresh.has(id))
  const errors = { ...store.getState().packageBuildErrors }
  for (const id of fresh.keys()) delete errors[id]
  store.setState({
    userPackages: store.getState().userPackages.map((p) => fresh.get(p.id) ?? p),
    packageRev: store.getState().packageRev + 1,
    packageBuildErrors: errors,
  })
  for (const pkg of fresh.values()) registerPackage(pkg, true)
  void warmShippedAssets([...fresh.values()])
  for (const pkg of fresh.values()) store.sharePackageChange(pkg, `Updated “${pkg.name}” to the app's version`)
  persistUserPackages(store)
  return [...fresh.keys()]
}

/**
 * Register an authored-part library (a project's shared `packages`) into the registry + catalog, merging by
 * id over the current userPackages (the in-memory equivalent of {@link restoreUserPackages}, used by the
 * project-doc boot path). Solo only - a room's packages arrive over the doc.
 */
export function adoptProjectLibrary(store: EditorStore, pkgs: readonly PartPackage[]): void {
  if (store.collab) return
  // an asset whose bytes this app ships is held by reference (core/shippedAssets.ts): a folder's assets/ file reads
  // back as bytes, and the same part as a reference keeps memory and the browser autosave light
  const valid = pkgs
    .map((p) => upgradeStoredPackage(p).pkg)
    .filter((p) => validatePartPackage(p).length === 0)
    .map(referenceShippedAssets)
  void warmShippedAssets(valid)
  // Replace, not merge: this is the project's library (a folder-sync read of an outside edit, a reload, a project
  // swap in place). Merging would keep a part the folder no longer has, and keep the last project's parts registered.
  const kept = new Set(valid.map((p) => p.id))
  for (const old of store.getState().userPackages) {
    if (kept.has(old.id)) continue
    // gone from the library: back to what the app has without it - the built-in, else this scene's own snapshot
    const without = store.getState().bundledPackages.find((p) => p.id === old.id) ?? store.getState().scene.packages?.find((p) => p.id === old.id)
    if (without) registerPackage(without, store.getState().bundledPackages.some((p) => p.id === old.id))
    else unregisterPackage(old.id)
  }
  // authoritative: the user's own library is the live copy of these ids - a scene's embedded snapshot must
  // not overwrite an edited part on load (you see your edits without clearing storage).
  for (const pkg of valid) registerPackage(pkg, true)
  if (valid.length === 0 && store.getState().userPackages.length === 0) return
  store.setState({ userPackages: valid, packageRev: store.getState().packageRev + 1 })
}

/**
 * Apply custom-part packages received from a peer (the collab bridge): register each so render + the
 * Inspector resolve it, surface non-bundled ones in the catalog, and bump packageRev so React re-reads.
 * Does not touch the sink (no echo) and is allowed in view-only mode (a viewer must still render peers'
 * custom parts). The bridge only calls this for packages whose content actually changed.
 *
 * A room holds a copy of every placed part's package, built-in ones included, and for a built-in part that copy is
 * only a snapshot of whatever build placed it. It is ignored, so this client's own bundled part stands, exactly as
 * a solo scene's embedded snapshot loses to it (registerScenePackages). Only an entry the room marks as an edit
 * (`edited`, schema.editedPackageIds) of a built-in id is a fork, and wins, and joins the catalog as one (so the
 * bundled loader treats it as shadowing, as it does a solo fork). Without this, a room made before a built-in part
 * changed would show the old part to every client for good: the snapshot would register before the bundle loaded
 * and then be filed as a fork. The bundle must therefore be registered before this runs (main.tsx bootRoom).
 */
export function applyRemotePackages(
  store: EditorStore,
  pkgs: PartPackage[],
  edited: ReadonlySet<string> = new Set(),
  removed: readonly string[] = [],
  room?: RoomSinks,
): void {
  for (const id of removed) applyRemoteRemoval(store, id, room)
  const bundled = new Set(store.getState().bundledPackages.map((p) => p.id))
  const incoming = pkgs.filter((p) => !bundled.has(p.id) || edited.has(p.id))
  if (incoming.length === 0) return
  for (const pkg of incoming) registerPackage(pkg)
  // show authored/edited parts in every peer's catalog too (a built-in id reaches here only as a fork)
  const byId = new Map(store.getState().userPackages.map((p) => [p.id, p]))
  for (const p of incoming) byId.set(p.id, p)
  store.setState({ userPackages: [...byId.values()], packageRev: store.getState().packageRev + 1 })
}

/**
 * A part someone in the room deleted (its room entry went, or stopped being an edit): taken out here as their delete
 * took it out there. A part this client places is kept and sent back instead, since it was placed here as it was
 * deleted there, and the room must hold every placed part's definition. A Part Editor open on it closes first.
 */
function applyRemoteRemoval(store: EditorStore, id: string, room: RoomSinks | undefined): void {
  const own = store.getState().userPackages.find((p) => p.id === id)
  if (!own) return
  const bundled = store.getState().bundledPackages.some((p) => p.id === id)
  if (!bundled && packageUsage(store, id).length > 0) return void room?.sendPackage(own)
  if (store.getState().packageEdit?.packageId === id) store.exitPartFocus()
  dropFromLibrary(store, id)
}
