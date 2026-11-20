// What a part's submission to the listed library is made of (docs/part-libraries.md, "Publishing"): the folder the
// pull request adds to the parts repository, the pull request's text, and this browser's record of what was sent.
//
//   parts/<id>/manifest.json, behavior.js, assets/...   the part, as a .oippart holds it (core/parts/partArchive.ts)
//   parts/<id>/description.txt                          what Get parts shows
//   parts/<id>/thumbnail.webp                           the card picture, as the app rendered it

import { partFolderFiles } from '../../core/parts/partArchive'
import type { PartPackage } from '../../core/parts/partPackage'
import { partFingerprint } from '../../core/parts/partOrigin'
import { RIGHTS_LINE, SUBMISSION_DIR } from '../../core/parts/partSubmission'

/** The files a submission adds, at their paths in the parts repository. */
export function submissionFiles(pkg: PartPackage, opts: { description: string; thumbnailDataUrl?: string }): { path: string; bytes: Uint8Array }[] {
  const dir = `${SUBMISSION_DIR}/${pkg.id}`
  const enc = new TextEncoder()
  const files = [
    ...partFolderFiles(pkg).map((f) => ({ path: `${dir}/${f.path}`, bytes: f.bytes })),
    { path: `${dir}/description.txt`, bytes: enc.encode(opts.description.trim() + '\n') },
  ]
  const picture = opts.thumbnailDataUrl ? dataUrlBytes(opts.thumbnailDataUrl, 'image/webp') : null
  if (picture) files.push({ path: `${dir}/thumbnail.webp`, bytes: picture })
  return files
}

/** A data URL's bytes, when it is of `mime`. */
function dataUrlBytes(url: string, mime: string): Uint8Array | null {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(url)
  if (!m || m[1] !== mime) return null
  try {
    return Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** The pull request's title and text, with the template's rights line ticked. */
export function pullRequestText(pkg: PartPackage, opts: { description: string; update: boolean }): { title: string; body: string; message: string } {
  const verb = opts.update ? 'Update' : 'Add'
  return {
    title: `${verb} ${pkg.name} (${pkg.id})`,
    message: `${verb} ${pkg.id}`,
    body: [
      `${opts.update ? 'A new version of' : 'Submits'} **${pkg.name}** (\`${pkg.id}\`) for the listed part library.`,
      '',
      opts.description.trim(),
      '',
      `- [x] ${RIGHTS_LINE}`,
      '',
      'Sent from the Open Industry Project app.',
    ].join('\n'),
  }
}

/** What this browser sent for a part: its pull request, and which version of the part it carried. */
export interface SubmissionRecord {
  number: number
  url: string
  /** partFingerprint of the version submitted */
  fingerprint: string
  description: string
}

const RECORDS_KEY = 'oip-web/part-submissions'

function readRecords(): Record<string, SubmissionRecord> {
  try {
    const raw = localStorage.getItem(RECORDS_KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, SubmissionRecord>) : {}
  } catch {
    return {}
  }
}

/** The last submission of a part from this browser. */
export function submissionRecord(partId: string): SubmissionRecord | null {
  return readRecords()[partId] ?? null
}

export function saveSubmissionRecord(partId: string, record: SubmissionRecord): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify({ ...readRecords(), [partId]: record }))
  } catch {
    // storage blocked: the pull request still exists on GitHub
  }
}

/** Has the part changed since this record's version was sent? */
export function changedSince(pkg: PartPackage, record: SubmissionRecord): boolean {
  return partFingerprint(pkg) !== record.fingerprint
}
