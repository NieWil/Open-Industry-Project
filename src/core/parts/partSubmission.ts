// Submitting a part to the listed library (docs/part-libraries.md, "Publishing"): the rules a submission is checked
// against before anything is sent, in the app's Publish dialog, and again in the parts repository's CI
// (scripts/check-submission.mjs). One copy of the rules, so the author sees the same answer CI gives.
//
// What a person still checks (provenance, confidentiality, fit) is the review checklist's, not this file's.

import { base64ToBytes } from './partAssets'
import type { PartPackage } from './partPackage'
import { parseGlb } from '../glbBox'

/** The parts repository: where submissions go as pull requests. */
export const PARTS_REPOSITORY = { owner: 'Open-Industry-Project', repo: 'parts', branch: 'main' } as const

/** Where in the parts repository a part's folder goes: `parts/<id>/`. */
export const SUBMISSION_DIR = 'parts'

/** The line a submission's pull request must carry ticked: the author has the rights to everything in the part. */
export const RIGHTS_LINE = 'I have the rights to publish everything in this part (its code, models and textures) under the listed licences.'


/** Limits a listed part stays within. A part over them still works as an unlisted part file. */
export const SUBMISSION_LIMITS = {
  /** the whole .oippart */
  partFileBytes: 20 * 1024 * 1024,
  /** the behavior source */
  behaviorBytes: 512 * 1024,
  /** triangles across all of its models */
  triangles: 300_000,
  /** a texture's longer side, in pixels */
  texturePixels: 4096,
  /** Get parts' description */
  descriptionChars: 2000,
} as const

/** The namespace file in the parts repository: which GitHub organization owns which namespace. */
export interface NamespaceFile {
  namespaces: Record<string, { org: string }>
}

/** Who a part's id says publishes it: the GitHub account a `u.<login>.*` id names, or the organization that owns its namespace. */
export function publisherOf(partId: string, namespaces: NamespaceFile): string | null {
  const segs = partId.split('.')
  if (segs[0] === 'u') return segs.length >= 3 ? segs[1]! : null
  return namespaces.namespaces[segs[0]!]?.org ?? null
}

/**
 * Whether `author` (a GitHub login) may publish `partId`. `orgs` are the organizations the author is a public member
 * of. Returns '' or the reason.
 *   - `oip.*` is the project's own and is published from oip-web, never by pull request
 *   - `u.<login>.<name>` is the account's own
 *   - `<namespace>.<name>` belongs to the organization the namespace file names
 */
export function namespaceProblem(partId: string, author: string, orgs: readonly string[], namespaces: NamespaceFile): string {
  const segs = partId.split('.')
  const ns = segs[0]!
  if (ns === 'oip') return 'ids starting "oip." are the project\'s own parts'
  if (ns === 'u') {
    if (segs.length < 3) return `a personal part's id is u.<your GitHub login>.<name>, e.g. u.${author.toLowerCase()}.${segs[1] ?? 'transfer'}`
    if (segs[1] !== author.toLowerCase()) return `"u.${segs[1]}" is another account's namespace: yours is u.${author.toLowerCase()}`
    return ''
  }
  const owner = namespaces.namespaces[ns]
  if (!owner) return `the namespace "${ns}" is not registered. Use u.${author.toLowerCase()}.${segs.slice(1).join('.')}, or ask for "${ns}" for your GitHub organization`
  if (!orgs.some((o) => o.toLowerCase() === owner.org.toLowerCase())) {
    return `"${ns}" belongs to the GitHub organization ${owner.org}; you are not a public member of it`
  }
  return ''
}

/** Triangles in a GLB's meshes (triangle lists; strips and fans counted by their vertices). */
export function glbTriangles(bytes: Uint8Array): number {
  const { json } = parseGlb(bytes)
  let n = 0
  for (const mesh of json?.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4
      if (mode < 4) continue // points and lines
      const acc = json.accessors?.[prim.indices ?? prim.attributes?.POSITION]
      const count = typeof acc?.count === 'number' ? acc.count : 0
      n += mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2)
    }
  }
  return n
}

/** An image's width and height from its header (PNG, JPEG, WebP), or null when it cannot be read. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (i: number): number => bytes[i] ?? 0
  if (bytes.length >= 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) }
  }
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null
      const marker = at(i + 1)
      const len = dv.getUint16(i + 2)
      // a start-of-frame segment holds the size (C0-CF, except the DHT, JPG and DAC markers)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) }
      }
      i += 2 + len
    }
    return null
  }
  if (bytes.length >= 30 && String.fromCharCode(at(0), at(1), at(2), at(3)) === 'RIFF' && String.fromCharCode(at(8), at(9), at(10), at(11)) === 'WEBP') {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15))
    if (chunk === 'VP8X') return { width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) }
    if (chunk === 'VP8L') {
      const b = dv.getUint32(21, true)
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }
    }
    if (chunk === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
  }
  return null
}

/** A problem with a submission, in words for its author. */
export interface SubmissionProblem {
  /** what it is about: 'id', 'assets', 'behavior', 'size', 'description' */
  about: string
  message: string
}

/**
 * Check a part against the listing rules that need no network: its id, its assets (embedded, models and textures in
 * the limits) and its size. `partFileBytes` is the size of its .oippart. The namespace is checked separately
 * ({@link namespaceProblem}), since it needs the author's GitHub account.
 */
export function submissionProblems(pkg: PartPackage, opts: { partFileBytes: number; description?: string }): SubmissionProblem[] {
  const out: SubmissionProblem[] = []
  const bad = (about: string, message: string): void => {
    out.push({ about, message })
  }
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)+$/.test(pkg.id)) bad('id', 'the id must be dotted lowercase words, e.g. u.yourlogin.lift-table')
  if (new TextEncoder().encode(pkg.behavior).length > SUBMISSION_LIMITS.behaviorBytes) bad('behavior', `the behavior is over ${SUBMISSION_LIMITS.behaviorBytes / 1024} KB`)
  if (opts.partFileBytes > SUBMISSION_LIMITS.partFileBytes) bad('size', `the part file is ${(opts.partFileBytes / 1048576).toFixed(1)} MB; a listed part is at most ${SUBMISSION_LIMITS.partFileBytes / 1048576} MB`)
  if (opts.description !== undefined && opts.description.length > SUBMISSION_LIMITS.descriptionChars) bad('description', `the description is over ${SUBMISSION_LIMITS.descriptionChars} characters`)
  let triangles = 0
  for (const a of pkg.assets ?? []) {
    if (a.data === undefined) {
      bad('assets', `the asset "${a.id}" is not inside the part (it names ${a.url ?? 'nothing'}); a listed part carries every model and texture it uses`)
      continue
    }
    const bytes = base64ToBytes(a.data)
    if (!bytes) {
      bad('assets', `the asset "${a.id}" cannot be read`)
      continue
    }
    if (a.mime === 'model/gltf-binary') {
      try {
        triangles += glbTriangles(bytes)
      } catch {
        bad('assets', `the model "${a.id}" is not a valid GLB`)
      }
    } else if (a.mime.startsWith('image/')) {
      const size = imageSize(bytes)
      if (!size) bad('assets', `the texture "${a.id}" is not a PNG, JPEG or WebP image`)
      else if (Math.max(size.width, size.height) > SUBMISSION_LIMITS.texturePixels) {
        bad('assets', `the texture "${a.id}" is ${size.width} x ${size.height}; at most ${SUBMISSION_LIMITS.texturePixels} pixels a side`)
      }
    }
  }
  if (triangles > SUBMISSION_LIMITS.triangles) bad('assets', `the models have ${triangles.toLocaleString('en-US')} triangles; at most ${SUBMISSION_LIMITS.triangles.toLocaleString('en-US')}`)
  return out
}
