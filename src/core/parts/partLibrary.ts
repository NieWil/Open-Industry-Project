// Part libraries: parts published outside the app, for projects to copy from (docs/part-libraries.md).
//
// A library is a static index (JSON) beside the part files it lists, each a `.oippart` (core/parts/partArchive.ts) under a
// URL that never changes. A project's library stays the only place its parts come from: installing copies the part in,
// stamped with the fingerprint of the version it came from (`PartPackage.origin.library`), and updates are explicit.
// The statuses are core/parts/partOrigin.ts's, read here from the fingerprints the index lists, so a listing can say what
// each part is to the project before anything is downloaded.
//
// An index is untrusted input until validated: every file it names is a path relative to the index, so a library can
// only send the app to its own host, and a downloaded file is checked against the index's hash and fingerprint
// before it is used. An index the project publishes carries the project's signature (core/librarySignature.ts), which
// is what makes it the project's, wherever it is served from.

import type { LibrarySignature } from '../librarySignature'
import { matchesRecord, originOf, partFingerprint, withOrigin } from './partOrigin'
import type { SourceStatus } from './partOrigin'
import type { PartCredit, PartPackage } from './partPackage'
import { PART_SDK_LEVEL } from './partSdk'
import { sha256HexOfBytes } from '../sha256'

/** The index format this build reads. Raise it only for a change an older build must refuse. */
export const LIBRARY_INDEX_FORMAT = 1

/** A library's index: `index.json` at the library's URL. */
export interface PartLibraryIndex {
  format: number
  /** stable id of the library, e.g. "oip.structure" */
  id: string
  /** display name */
  name: string
  /** the licences every listed part is published under (docs/part-libraries.md, "Rules for listed parts") */
  licence: { code: string; assets: string }
  parts: LibraryPart[]
  /** the project's signature over the rest of the index; absent on a library the project did not publish */
  signature?: LibrarySignature
}

export interface LibraryPart {
  /** the package id, the same as the part file's */
  id: string
  name: string
  category?: string
  /** what it is and what it is for, a paragraph of plain text (shown in Get parts) */
  description?: string
  /** read from indexes written while publishers chose training use; no longer written (every listed part is under MIT
   *  and CC BY 4.0, which allow any use) */
  training?: boolean
  /** who publishes it, in the listed library: a GitHub account or organization (core/parts/partSubmission.ts publisherOf) */
  publisher?: string
  /** oldest first; a version is never removed or rewritten */
  versions: LibraryVersion[]
}

export interface LibraryVersion {
  /** the `.oippart`, relative to the index */
  file: string
  /** SHA-256 of the file's bytes, lowercase hex */
  sha256: string
  /** partFingerprint of the part the file builds into */
  fingerprint: string
  /** the Part SDK level the part was made under (core/parts/partSdk.ts) */
  sdk: number
  /** when this version was listed, YYYY-MM-DD */
  published: string
  /** a thumbnail image, relative to the index */
  thumbnail?: string
  /** what this version does when it runs alone (sim/partBehaviour.ts), recorded when it was listed: every later build
   *  must run it the same (src/sim/libraryCorpus.test.ts). A first-party version is in test-corpus/ instead. */
  behaviour?: string
}

const SHA256 = /^[0-9a-f]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
// a part or library id: dotted lowercase segments, the namespace first (acme.transfer)
const ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)+$/

/** A path inside the library: relative, no scheme, no parent steps, no backslashes. */
function isLibraryPath(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 512) return false
  if (p.startsWith('/') || p.includes('\\') || p.includes('?') || p.includes('#') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max

/** Check an index read from the network. Returns the index, or every problem found. */
export function validateLibraryIndex(raw: unknown): { index: PartLibraryIndex } | { problems: string[] } {
  const problems: string[] = []
  const bad = (msg: string): void => {
    problems.push(msg)
  }
  if (!isObject(raw)) return { problems: ['not a library index'] }
  if (typeof raw.format !== 'number' || raw.format !== LIBRARY_INDEX_FORMAT) {
    return {
      problems: [
        typeof raw.format === 'number' && raw.format > LIBRARY_INDEX_FORMAT
          ? `made for a newer version of the app (index format ${raw.format}; this app reads ${LIBRARY_INDEX_FORMAT})`
          : `unsupported or missing index format (expected ${LIBRARY_INDEX_FORMAT})`,
      ],
    }
  }
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) bad('id must be a dotted lowercase id, e.g. "oip.structure"')
  if (!isText(raw.name)) bad('name must be a non-empty string')
  const lic = raw.licence
  if (!isObject(lic) || !isText(lic.code, 64) || !isText(lic.assets, 64)) bad('licence must name a code licence and an assets licence')
  if (!Array.isArray(raw.parts)) {
    bad('parts must be an array')
    return { problems }
  }
  const ids = new Set<string>()
  raw.parts.forEach((part: unknown, i) => {
    const at = `parts[${i}]`
    if (!isObject(part)) return bad(`${at} must be an object`)
    if (typeof part.id !== 'string' || !ID.test(part.id)) bad(`${at}.id must be a dotted lowercase id`)
    else if (ids.has(part.id)) bad(`${at}.id "${part.id}" is listed twice`)
    else ids.add(part.id)
    if (!isText(part.name)) bad(`${at}.name must be a non-empty string`)
    if (part.category !== undefined && !isText(part.category, 64)) bad(`${at}.category must be a non-empty string`)
    if (part.description !== undefined && !isText(part.description, 2000)) bad(`${at}.description must be text of at most 2000 characters`)
    if (part.training !== undefined && typeof part.training !== 'boolean') bad(`${at}.training must be true or false`)
    if (part.publisher !== undefined && (typeof part.publisher !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(part.publisher))) bad(`${at}.publisher must be a GitHub account or organization name`)
    if (!Array.isArray(part.versions) || part.versions.length === 0) return bad(`${at}.versions must list at least one version`)
    part.versions.forEach((v: unknown, j) => {
      const vat = `${at}.versions[${j}]`
      if (!isObject(v)) return bad(`${vat} must be an object`)
      if (!isLibraryPath(v.file) || !v.file.endsWith('.oippart')) bad(`${vat}.file must be a .oippart path inside the library`)
      if (typeof v.sha256 !== 'string' || !SHA256.test(v.sha256)) bad(`${vat}.sha256 must be 64 lowercase hex digits`)
      if (typeof v.fingerprint !== 'string' || !v.fingerprint.startsWith('v2:')) bad(`${vat}.fingerprint must be a part fingerprint`)
      if (typeof v.sdk !== 'number' || !Number.isInteger(v.sdk) || v.sdk < 1) bad(`${vat}.sdk must be a Part SDK level (a whole number from 1)`)
      if (typeof v.published !== 'string' || !DATE.test(v.published)) bad(`${vat}.published must be a date, YYYY-MM-DD`)
      if (v.thumbnail !== undefined && (!isLibraryPath(v.thumbnail) || !/\.(webp|png|jpe?g)$/.test(v.thumbnail))) {
        bad(`${vat}.thumbnail must be a .webp, .png or .jpg path inside the library`)
      }
      if (v.behaviour !== undefined && (typeof v.behaviour !== 'string' || !/^[0-9a-f]{16}$/.test(v.behaviour))) bad(`${vat}.behaviour must be a behaviour digest (16 hex digits)`)
    })
  })
  const sig = raw.signature
  if (sig !== undefined && (!isObject(sig) || typeof sig.key !== 'string' || typeof sig.sig !== 'string')) bad('signature must name a key and a signature')
  return problems.length > 0 ? { problems } : { index: raw as unknown as PartLibraryIndex }
}

/** A file a new index entry names, with the SHA-256 its bytes must have (the hash in its name, or the version's). */
export interface LibraryNewFile {
  path: string
  sha256: string
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Check that `next` only appends to `published`, the index the bucket serves now, the way build-library changes it.
 * The signer runs this so a build job that ran part code cannot get a rewritten entry signed. Allowed: the library's
 * name, a part's name and description, the newest published version's thumbnail, new versions, new parts, and (in
 * the listed library) a part's removal by takedown. Every new file must be named by its hash; the caller checks the
 * bytes against `newFiles`. `published` is null before a library's first release.
 */
export function checkLibraryAppend(published: PartLibraryIndex | null, next: PartLibraryIndex): { problems: string[]; removed: string[]; newFiles: LibraryNewFile[] } {
  const problems: string[] = []
  const removed: string[] = []
  const newFiles: LibraryNewFile[] = []
  const thumbOf = (path: string): void => {
    const m = /\/([0-9a-f]{64})\.(webp|png|jpe?g)$/.exec(path)
    if (!m) problems.push(`thumbnail ${path} is not named by its hash`)
    else newFiles.push({ path, sha256: m[1]! })
  }
  const newVersion = (partId: string, v: LibraryVersion): void => {
    if (v.file !== `${partId}/${v.sha256}.oippart`) problems.push(`${partId}: ${v.file} is not named ${partId}/<its sha256>.oippart`)
    else newFiles.push({ path: v.file, sha256: v.sha256 })
    if (v.thumbnail !== undefined) thumbOf(v.thumbnail)
  }
  if (published) {
    if (next.id !== published.id) problems.push(`the library id changed from "${published.id}" to "${next.id}"`)
    if (next.format !== published.format) problems.push(`the index format changed from ${published.format} to ${next.format}`)
    if (!sameJson(next.licence, published.licence)) problems.push('the licence changed')
  }
  const before = new Map((published?.parts ?? []).map((p) => [p.id, p]))
  for (const old of before.values()) if (!next.parts.some((p) => p.id === old.id)) removed.push(old.id)
  for (const part of next.parts) {
    const old = before.get(part.id)
    if (!old) {
      for (const v of part.versions) newVersion(part.id, v)
      continue
    }
    if (part.publisher !== old.publisher) problems.push(`${part.id}: its publisher changed`)
    if (part.category !== old.category) problems.push(`${part.id}: its category changed`)
    if (part.versions.length < old.versions.length) {
      problems.push(`${part.id}: a published version was removed`)
      continue
    }
    old.versions.forEach((was, i) => {
      const now = part.versions[i]!
      const { thumbnail: wasThumb, ...wasRest } = was
      const { thumbnail: nowThumb, ...nowRest } = now
      if (!sameJson(wasRest, nowRest)) problems.push(`${part.id}: published version ${i + 1} was rewritten`)
      if (nowThumb === wasThumb) return
      if (i !== old.versions.length - 1 || nowThumb === undefined) problems.push(`${part.id}: the thumbnail of published version ${i + 1} changed`)
      else thumbOf(nowThumb)
    })
    for (const v of part.versions.slice(old.versions.length)) newVersion(part.id, v)
  }
  return { problems, removed, newFiles }
}

/**
 * The version of `part` to offer: the newest one this build can run (made under a Part SDK level it has). `newer` is
 * the newest version overall when this build is too old for it, so the listing can say an update needs a newer app.
 */
export function offeredVersion(part: LibraryPart, level: number = PART_SDK_LEVEL): { version?: LibraryVersion; newer?: LibraryVersion } {
  const latest = part.versions[part.versions.length - 1]
  const usable = [...part.versions].reverse().find((v) => v.sdk <= level)
  return latest !== undefined && latest.sdk > level ? { version: usable, newer: latest } : { version: usable }
}

/** The absolute URL of a path the index names, resolved against the index's own URL. */
export function libraryUrl(indexUrl: string, path: string): string {
  return new URL(path, indexUrl).href
}

/** Where the project's own libraries are published. */
export const FIRST_PARTY_LIBRARY_HOSTS: readonly string[] = ['parts.openindustryproject.org']

/**
 * Is this a first-party library, whose parts are the app's own built-ins moved out of the app? Its parts read as
 * updates to the built-ins of the same id, so the id alone is not enough: anyone can host an index named `oip.*`
 * and share a link to it. It must also carry the project's signature (`signed`, checked by the caller with
 * core/librarySignature.ts), which holds wherever it is served from, or be served over https from a host the project
 * publishes on, for an index published before signing.
 */
export function isFirstPartyLibrary(index: Pick<PartLibraryIndex, 'id'>, indexUrl: string, hosts: readonly string[] = FIRST_PARTY_LIBRARY_HOSTS, signed = false): boolean {
  if (!index.id.startsWith('oip.')) return false
  if (signed) return true
  try {
    const u = new URL(indexUrl)
    // loopback is accepted over http, for a host list that names it (the editor's dev build, to test locally)
    return hosts.includes(u.hostname) && (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

/**
 * What `version` is to the project, whose library holds `projectCopy` of that id (or nothing). The same reading as
 * core/parts/partOrigin.ts sourceStatus, from the fingerprint the index lists instead of the part itself.
 *
 * In a first-party library, a copy made from the app's built-in (`origin.app`, before the part moved to a library) is
 * read as made from the library, so a project that used the built-in sees the library's versions as updates.
 */
export function libraryStatus(projectCopy: PartPackage | undefined, version: LibraryVersion, firstParty = false): SourceStatus {
  if (projectCopy === undefined) return 'notInProject'
  const project = partFingerprint(projectCopy)
  const current = version.fingerprint
  const record = originOf(projectCopy, 'library') ?? (firstParty ? originOf(projectCopy, 'app') : undefined)
  if (record === undefined) return project === current ? 'upToDate' : 'sameIdDifferentPart'
  const editedHere = !matchesRecord(projectCopy, record)
  // a record made by the older stored hash (an app record from before fingerprints) cannot be compared with a listed
  // fingerprint, so the library is taken to have changed since
  const sourceChanged = record !== current
  if (!editedHere && !sourceChanged) return 'upToDate'
  if (project === current) return 'upToDate'
  if (editedHere && sourceChanged) return 'changedInBoth'
  return editedHere ? 'editedHere' : 'updateAvailable'
}

/**
 * Check a downloaded part file against the version that listed it: the bytes must hash to `sha256`, and the part they
 * build into (`pkg`, built by the caller) must be that version's part. Returns '' or the problem.
 */
export function checkLibraryDownload(version: LibraryVersion, partId: string, bytes: Uint8Array, pkg: PartPackage): string {
  if (sha256HexOfBytes(bytes) !== version.sha256) return 'the downloaded file is not the one the library lists (its hash differs)'
  if (pkg.id !== partId) return `the downloaded file holds "${pkg.id}", not "${partId}"`
  if (partFingerprint(pkg) !== version.fingerprint) return 'the downloaded part is not the version the library lists (its fingerprint differs)'
  return ''
}

/** The site the project's own libraries credit. */
export const PROJECT_CREDIT_URL = 'https://www.openindustryproject.org'

/**
 * Who made a library's part, as its project copy credits them (core/parts/partPackage.ts PartCredit): the listed publisher
 * and their GitHub page, the Open Industry Project for a first-party library, or only the library's name for one that
 * names no publisher.
 */
export function libraryCredit(index: Pick<PartLibraryIndex, 'name'>, part: Pick<LibraryPart, 'publisher'> | undefined, firstParty: boolean): PartCredit {
  if (part?.publisher) return { by: part.publisher, library: index.name, url: `https://github.com/${part.publisher}` }
  if (firstParty) return { by: 'Open Industry Project', library: index.name, url: PROJECT_CREDIT_URL }
  return { library: index.name }
}

/**
 * A library part as it goes into a project's library: stamped with the fingerprint of the version it came from, and
 * with who made it. A record from another source stays, as a shelf copy keeps its record from the app.
 */
export function asLibraryCopy(pkg: PartPackage, credit?: PartCredit): PartPackage {
  const copy = withOrigin(pkg, 'library', partFingerprint(pkg))
  return credit ? { ...copy, credit } : copy
}
