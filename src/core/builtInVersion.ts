// Which version of a built-in a project's own copy was made from.
//
// Editing a built-in part (an `oip.*` package the app ships) gives the project its own version under the same id
// (editor storePackages.syncUserCatalog), because placed parts, rooms and saved scenes all name a part by id: a
// new id would mean rewriting every reference to it. Keeping the id means the project's copy hides the built-in,
// so when a later app ships a better built-in, a project that ever touched it would quietly keep the old one.
// So the copy records a fingerprint of the built-in it came from (`PartPackage.origin.app`), and the app can
// tell - and say - when the built-in has changed since. The app is one source among others (core/parts/partOrigin.ts).

import { matchesRecord, originOf, partFingerprint, sourceStatus, withOrigin } from './parts/partOrigin'
import type { PartPackage } from './parts/partPackage'

/** A fingerprint of a built-in package's content: equal for the same part, different once the app ships a change. */
export function builtInFingerprint(pkg: PartPackage): string {
  return partFingerprint(pkg)
}

/** `pkg` as a project's own version of `builtIn`: stamped with the built-in's fingerprint unless it already is. */
export function asCopyOfBuiltIn(pkg: PartPackage, builtIn: PartPackage): PartPackage {
  return originOf(pkg, 'app') !== undefined ? pkg : withOrigin(pkg, 'app', partFingerprint(builtIn))
}

/**
 * Has the app's built-in changed since the project made `copy` from it, to something other than the copy? False when
 * there is no built-in of that id, or the copy predates fingerprints (no record: what it was made from is unknown,
 * so nothing can be said).
 */
export function builtInChangedSince(copy: PartPackage, builtIn: PartPackage | undefined): boolean {
  if (builtIn === undefined) return false
  const status = sourceStatus(copy, builtIn, 'app')
  return status === 'updateAvailable' || status === 'changedInBoth'
}

/** Is `copy` the app's built-in exactly as it ships now: a project's untouched copy of the current version? */
export function sameAsBuiltIn(copy: PartPackage, builtIn: PartPackage | undefined): boolean {
  return builtIn !== undefined && partFingerprint(copy) === partFingerprint(builtIn)
}

/**
 * Has the project changed its copy of a built-in since it made it: the edits that taking the app's version would
 * replace? A copy with no record (made before records existed) only ever came from an edit, so it counts as changed.
 */
export function editedSinceCopied(copy: PartPackage): boolean {
  const record = originOf(copy, 'app')
  return record === undefined || !matchesRecord(copy, record)
}

/**
 * A new part made from `src` ("Save as a New Part"): its own id and name, so it sits beside the original instead of
 * replacing it - a heavy-duty conveyor next to the standard one (docs/part-sources.md, "Variants"). When `base` is
 * the built-in it was made from (directly, or through the project's copy of it), the new part records that built-in's
 * id and the version it came from (`origin.appPart`, `origin.app`), so the app can say when the base changes later.
 * A part with another id is never an "update" of it, so nothing else about the built-in follows it. A record from the
 * shelf does not carry over: the new part is not the shelf's.
 */
export function asNewPartFrom(src: PartPackage, id: string, name: string, base: PartPackage | undefined): PartPackage {
  const { origin: _from, ...part } = src
  if (!base) return { ...part, id, name }
  return { ...part, id, name, origin: { app: originOf(src, 'app') ?? partFingerprint(base), appPart: base.id } }
}

/** The built-in a variant was made from, and whether the app has changed it since; undefined for any other part. */
export function variantBase(pkg: PartPackage, builtIns: readonly PartPackage[]): { base: PartPackage; changedSince: boolean } | undefined {
  const baseId = pkg.origin?.appPart
  const base = baseId !== undefined && baseId !== pkg.id ? builtIns.find((b) => b.id === baseId) : undefined
  if (!base) return undefined
  return { base, changedSince: !matchesRecord(base, originOf(pkg, 'app') ?? '') }
}

/**
 * Built-ins the catalogs do not offer: still registered, so a project that has one loads, runs and updates it, and a
 * named lookup still finds it, but a new placement uses what replaced it. The Pallet Spawner became the Spawner with
 * Product: Pallet and Release: On each enable. The editor's catalog, the agent's part listing and `npm run catalog`
 * all leave these out; a project's own changed version of one is its own part and still shows.
 */
export const UNLISTED_BUILT_INS: ReadonlySet<string> = new Set(['oip.pallet-spawner'])
