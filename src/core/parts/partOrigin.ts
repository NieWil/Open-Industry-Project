// Where a project's part came from (docs/part-sources.md).
//
// A project holds its own copy of each part it uses. The copy records, per source it came from, the fingerprint of
// the version that source had then (`PartPackage.origin`): `app` for one of the app's built-ins, `shelf` for the
// parts shelf. Comparing that record with the project's copy and the source's current version says, without any
// history, which side changed:
//
//   project copy vs record | source vs record | status
//   same                   | same             | upToDate
//   same                   | changed          | updateAvailable   (the source has a newer version)
//   changed                | same             | editedHere        (this project changed it)
//   changed                | changed          | changedInBoth     (updating replaces this project's edits: ask)
//
// Keyed by source because one copy can have two: a project's version of a built-in that is also on the shelf was
// made from a built-in and copied from the shelf, and each says something different. A later source (a part library)
// is a new key, not a new field.

import { hashText } from '../hash'
import type { PartPackage } from './partPackage'

/** A place a project's part can come from. */
export type PartSource = 'app' | 'shelf' | 'library'

/** What a source's part is to the open project. */
export type SourceStatus =
  /** the project has no part of this id */
  | 'notInProject'
  | 'upToDate'
  | 'updateAvailable'
  | 'editedHere'
  | 'changedInBoth'
  /**
   * The project has a part of this id with no record from this source, and it is not the same part: two different
   * parts sharing an id, or a copy made before records existed. Neither may replace the other silently.
   */
  | 'sameIdDifferentPart'

// Fields that are not the part: the stored format (an upgrade is not a new version of the part), the record of where
// a copy came from, the SDK level stamp (it records the fingerprint, so it cannot be in it), and the thumbnail
// (regenerated images would read as updates). `basedOn` and `fromShelf` are the record's spellings before package
// format 6; a package built from an old manifest may still pass them through.
const NOT_THE_PART = new Set(['format', 'origin', 'credit', 'sdk', 'basedOn', 'fromShelf', 'thumbnail'])

// Fields the SDK works out by running the behavior (sim/validatePart.ts), not fields the author wrote. The behavior
// source is in the fingerprint already, so leaving them out loses nothing. Keeping them in would turn a build that
// derives them differently into an "update" or an "edit" of every part. `snap` stays in: it lives in the manifest
// and authors edit it, so a change to canonicalSnap's normalisation still moves fingerprints.
const DERIVED = new Set(['params', 'interactive', 'useParam', 'unit'])

/** What every fingerprint written now starts with. A record without it was made by {@link storedPackageHash}. */
const FINGERPRINT_SCHEME = 'v2:'

/** An asset reduced to what identifies it. An asset with a sha256 is compared by that hash, however it holds or names
 *  its bytes (`data`, a project folder's file, a `url`), so a copy that went to disk and back is the same part. One
 *  without a hash is compared as written. */
function assetIdentity(a: unknown): unknown {
  const x = a as { id?: unknown; mime?: unknown; sha256?: unknown } | null
  return x && typeof x.sha256 === 'string' ? { id: x.id, mime: x.mime, sha256: x.sha256 } : a
}

/** JSON with keys in sorted order, so the same part fingerprints the same whatever order a build wrote it in. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function contentHash(pkg: PartPackage, leaveOut: (key: string) => boolean): string {
  const part: Record<string, unknown> = Object.fromEntries(Object.entries(pkg).filter(([k]) => !leaveOut(k)))
  if (Array.isArray(part.assets)) part.assets = part.assets.map(assetIdentity)
  return hashText(stableJson(part))
}

const fingerprints = new WeakMap<PartPackage, string>()
const storedHashes = new WeakMap<PartPackage, string>()

/**
 * A fingerprint of what the part's author wrote: equal for the same part, different once the author changes any of
 * it. This is what a copy's `origin` records.
 */
export function partFingerprint(pkg: PartPackage): string {
  const known = fingerprints.get(pkg)
  if (known !== undefined) return known
  const fp = FINGERPRINT_SCHEME + contentHash(pkg, (k) => NOT_THE_PART.has(k) || DERIVED.has(k))
  fingerprints.set(pkg, fp)
  return fp
}

/**
 * A hash of the stored package, derived fields included: two packages a project could hold differently hash
 * differently. The old-parts corpus names its files by it (scripts/part-corpus.mjs), and `origin` records made before
 * {@link partFingerprint} were made by it.
 */
export function storedPackageHash(pkg: PartPackage): string {
  const known = storedHashes.get(pkg)
  if (known !== undefined) return known
  const h = contentHash(pkg, (k) => NOT_THE_PART.has(k))
  storedHashes.set(pkg, h)
  return h
}

/** Is `pkg` the version `record` was made from? A record is read with the hash that made it. */
export function matchesRecord(pkg: PartPackage, record: string): boolean {
  return (record.startsWith(FINGERPRINT_SCHEME) ? partFingerprint(pkg) : storedPackageHash(pkg)) === record
}

/** The fingerprint `pkg` recorded from `source`, if it came from there. */
export function originOf(pkg: PartPackage, source: PartSource): string | undefined {
  return pkg.origin?.[source]
}

/** `pkg` recorded as made from `fingerprint` of `source`; its records from other sources stay. */
export function withOrigin(pkg: PartPackage, source: PartSource, fingerprint: string): PartPackage {
  return { ...pkg, origin: { ...pkg.origin, [source]: fingerprint } }
}

/** `pkg` without its record from `source` (the field goes when no record is left). */
export function withoutOrigin(pkg: PartPackage, source: PartSource): PartPackage {
  if (pkg.origin?.[source] === undefined) return pkg
  const { [source]: _gone, ...rest } = pkg.origin
  const { origin: _origin, ...part } = pkg
  return Object.keys(rest).length > 0 ? { ...part, origin: rest } : part
}

/** What `sourcePart` is to the project, whose library holds `projectCopy` of that id (or nothing). */
export function sourceStatus(projectCopy: PartPackage | undefined, sourcePart: PartPackage, source: PartSource): SourceStatus {
  if (projectCopy === undefined) return 'notInProject'
  const project = partFingerprint(projectCopy)
  const current = partFingerprint(sourcePart)
  const record = originOf(projectCopy, source)
  if (record === undefined) {
    // not recorded as from here, but the very same part (imported from a part file, say): nothing to tell apart
    return project === current ? 'upToDate' : 'sameIdDifferentPart'
  }
  const editedHere = !matchesRecord(projectCopy, record)
  const sourceChanged = !matchesRecord(sourcePart, record)
  if (!editedHere && !sourceChanged) return 'upToDate'
  // both moved, but to the same content (the same fix made in both places): nothing to choose between
  if (project === current) return 'upToDate'
  if (editedHere && sourceChanged) return 'changedInBoth'
  return editedHere ? 'editedHere' : 'updateAvailable'
}

