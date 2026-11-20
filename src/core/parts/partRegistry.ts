// Runtime registry of imported custom-part packages (PartPackage) keyed by package id. The scene schema
// is closed at compile time (PartType union, PART_DEFS), but custom parts are dynamic: loaded from disk
// or embedded in a scene. The single synthetic `custom` part type defers to this registry to resolve a
// part's packageId → its geometry/behavior/param-schema, so the catalog, inspector, sim builder and
// render factory all stay schema-driven against whatever packages are currently loaded.
//
// This is process-global module state (like a singleton): a scene's embedded packages are registered on
// load, and the desktop authoring loop re-registers a package on every file save (then re-applies it to
// live instances - see onPackagesChanged in src/editor/controller.ts). Subscribers are notified so the UI/sim
// can react.

import type { PartPackage } from './partPackage'

const packages = new Map<string, PartPackage>()
// Ids whose local copy is authoritative: bundled first-party parts and the user's own library. A scene
// embeds its packages so a shared scene is self-contained, but for these ids the locally-loaded copy is the
// live one and the embedded copy is a stale snapshot to ignore. So a regenerated built-in (or an edited user
// part) shows up on the next reload without clearing the saved scene from localStorage.
const authoritativeIds = new Set<string>()
// Monotonic per-id registration revision, bumped only when a register actually changed the package's
// content. The sim folds this into partSignature, so a hot-reloaded package rebuilds its placed parts
// through the ordinary scene reconcile, with no force-rebuild side-channel. A no-op re-register
// (an unchanged bundled part in the dev-HMR sweep, a scene's embedded snapshot) rebuilds nothing.
// The counter is process-global and never reset, so a rev can't repeat across clear/re-register.
let revCounter = 0
const revById = new Map<string, number>()
type Listener = (id: string, pkg: PartPackage | undefined) => void
const listeners = new Set<Listener>()

// Content equality with a per-field reference shortcut: replace-flows built by spreading the previous
// package (transient author-mode edits) keep most field references, so only the genuinely edited field
// is JSON-compared. A base64 asset list compares by reference, not by serializing megabytes. The record of where
// a project's copy came from (`origin`) is not the part: a project's untouched copy of a built-in is the built-in, and
// registering it over the app's must rebuild nothing.
export function packagesEqual(a: PartPackage, b: PartPackage): boolean {
  if (a === b) return true
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('origin')
  for (const k of keys) {
    const av = (a as unknown as Record<string, unknown>)[k]
    const bv = (b as unknown as Record<string, unknown>)[k]
    if (av === bv) continue
    if (JSON.stringify(av) !== JSON.stringify(bv)) return false
  }
  return true
}

/** Register (or replace) a package. `authoritative` marks the id's LOCAL copy as the live one, so a scene's
 *  embedded snapshot of it won't overwrite it on load (set it for bundled examples + the user's library;
 *  leave it off for foreign scene-embedded packages).
 *
 *  A replace whose content is identical to the registered package is a no-op (no rev bump, no notify, the
 *  existing object is kept) and returns false. The dev-HMR sweep rebuilds every bundled part on any one-file save;
 *  this keeps it from fanning out into a whole-catalog refresh + running-sim rebuild, since only the genuinely
 *  changed package notifies. Returns true when the package was added or changed. */
/** Whether `id` is a package this build ships and keeps authoritative: a scene's embedded copy of it is a snapshot
 *  of some earlier build's, and is never what runs ({@link registerScenePackages}). */
export function isAuthoritativePackage(id: string): boolean {
  return authoritativeIds.has(id)
}

export function registerPackage(pkg: PartPackage, authoritative = false): boolean {
  if (authoritative) authoritativeIds.add(pkg.id)
  const prev = packages.get(pkg.id)
  if (prev && packagesEqual(prev, pkg)) return false
  packages.set(pkg.id, pkg)
  revById.set(pkg.id, ++revCounter)
  for (const l of listeners) l(pkg.id, pkg)
  return true
}

/** The package's registration revision - bumped on every content-changing register, 0 if never registered.
 *  Folded into the sim's partSignature so a reloaded package rebuilds via the ordinary reconcile. */
export function packageRev(id: string): number {
  return revById.get(id) ?? 0
}

/** Process-global registry revision: moves on any content mutation (content-changing register,
 *  unregister, non-empty clear). Derived-scene caches keyed on part references (core/memoParts.ts)
 *  fold this in so a package edit under identical part refs still invalidates them. */
export function registryRevision(): number {
  return revCounter
}

export function getPackage(id: string): PartPackage | undefined {
  return packages.get(id)
}

export function hasPackage(id: string): boolean {
  return packages.has(id)
}

export function listPackages(): PartPackage[] {
  return [...packages.values()]
}

/** Remove a package. Notifies subscribers with `undefined` so they can drop dependent instances.
 *  Also clears the id's authoritative status: with no local copy left there's nothing for it to protect,
 *  and keeping it would make {@link registerScenePackages} skip a scene's embedded snapshot of the id -
 *  stranding that scene's placed instances instead of letting the snapshot keep them self-contained. */
export function unregisterPackage(id: string): boolean {
  const had = packages.delete(id)
  revById.delete(id)
  authoritativeIds.delete(id)
  if (had) {
    revCounter++ // a removal changes derived views too (see registryRevision)
    for (const l of listeners) l(id, undefined)
  }
  return had
}

/** Drop all packages (e.g. when switching scenes). Silent - no per-id notifications. */
export function clearPackages(): void {
  if (packages.size > 0) revCounter++ // see registryRevision
  packages.clear()
  authoritativeIds.clear()
  revById.clear() // revCounter keeps counting - a re-registered id gets a fresh, never-repeated rev
}

/** Subscribe to register/replace/unregister events. Returns an unsubscribe fn. */
export function onPackagesChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Register every package a scene embeds (idempotent replace). Call on scene load. Skips ids whose local copy
 *  is {@link registerPackage|authoritative} (bundled / user library) so a regenerated or edited part isn't
 *  overwritten by the scene's stale embedded snapshot - you see your changes on reload without clearing storage.
 *  A genuinely foreign embedded package (an id you don't have locally) still registers, so a shared scene with
 *  third-party parts stays self-contained. */
export function registerScenePackages(pkgs: PartPackage[] | undefined): void {
  if (!pkgs) return
  for (const pkg of pkgs) if (!authoritativeIds.has(pkg.id)) registerPackage(pkg)
}

/** Register only a scene's embedded packages whose id is not already known: an id introduced after this
 *  registry was populated, e.g. a part dragged into a running sim whose worker started before that package
 *  existed. Unlike {@link registerScenePackages} it never replaces an already-registered package, so an
 *  ordinary live-edit stream (which carries stale embedded snapshots per drag frame) can't regress a package
 *  hot-reloaded earlier this run. Without it, the sim's addSdkPart can't resolve the new package and silently
 *  skips the body. A dragged-in cargo box then never builds and renders invisible (its scene stub is hidden,
 *  the instanced batch is its only draw). */
export function registerNewScenePackages(pkgs: PartPackage[] | undefined): void {
  if (!pkgs) return
  for (const pkg of pkgs) if (!packages.has(pkg.id)) registerPackage(pkg)
}

// The app's own built-in parts, by id: what a project names without keeping a copy (project format 3 keeps each
// definition once: the project holds its own parts, and a built-in is the app's). Kept apart from the
// registry's authoritative set, which also holds the open project's parts: a project is read against the app it
// is opened in, so "is this a built-in?" must not depend on which project was open before. Filled by the host that
// ships the parts - the editor's bundle (bundledExamples.ts), a CLI from examples/parts (scripts/lib/builtIns.mjs).
const builtIns = new Map<string, PartPackage>()

/** Declare this app's built-in parts (replacing the last set). Registers nothing: that stays the host's to do. */
export function setBuiltInPackages(pkgs: readonly PartPackage[]): void {
  builtIns.clear()
  for (const pkg of pkgs) builtIns.set(pkg.id, pkg)
}

/** Has this host declared its built-in parts at all? Until it has, nothing can be called a built-in or not. */
export function hasBuiltInPackages(): boolean {
  return builtIns.size > 0
}

/** The app's built-in part of this id, or undefined (not a built-in, or no built-ins declared by this host). */
export function builtInPackage(id: string): PartPackage | undefined {
  return builtIns.get(id)
}
