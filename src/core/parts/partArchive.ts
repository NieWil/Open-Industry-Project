// The .oippart archive: one part's folder, zipped, as a .oip is a project's (core/project/projectArchive.ts). Unzipped it is
// exactly the folder a project's parts/<slug>/, the shelf and a folder import (Import part > A folder of parts…) hold:
//
//   manifest.json            the package manifest (baked fields dropped: the behavior re-derives them)
//   behavior.js              the behavior, verbatim
//   assets/<sha256>.<ext>    its embedded assets as files (core/parts/partAssets.ts)
//
// Its own extension, not .oip, so the file says what it is before it is opened: an Import dialog, a file manager and a
// file association can tell a part from a project, the way .dotx and .docx share a container but not an extension.
// The older single-part file, `.part.json` (manifest + behaviorSource in one JSON text, editor/parts/partFile.ts), still
// imports. The two are told apart by their first bytes.
//
// Pure, like the project codec: building a package from the folder runs the behavior, which core does not do, so
// reading stops at the folder's two texts (assets joined back into the manifest) and the host bakes them.

import type { Zippable } from 'fflate'
import { isZipData } from '../project/projectArchive'
import { isPartAssetPath, joinAssetFiles, splitAssetFiles } from './partAssets'
import type { SplitOptions } from './partAssets'
import { manifestOfPackage } from './partPackage'
import type { PartPackage } from './partPackage'

/** The extension of a part archive. */
export const PART_ARCHIVE_EXTENSION = '.oippart'

// fixed, as in projectArchive.ts, so the same part always zips to the same bytes. Built from local fields: a zip
// entry's time is local time, so a fixed UTC instant wrote a different time on each machine's timezone, and a
// library packed on a desktop hashed differently from the same part packed in CI.
const ARCHIVE_MTIME = new Date(2000, 0, 1)

export { isZipData }

/** A part's folder as files: manifest.json, behavior.js and assets/<sha256>.<ext>, paths relative to the folder. What
 *  a .oippart zips, and what a submission to the parts repository commits (editor/publish/). */
export function partFolderFiles(pkg: PartPackage, opts?: SplitOptions): { path: string; bytes: Uint8Array }[] {
  const split = splitAssetFiles(manifestOfPackage(pkg), opts)
  const enc = new TextEncoder()
  return [
    { path: 'manifest.json', bytes: enc.encode(JSON.stringify(split.manifest, null, 2) + '\n') },
    { path: 'behavior.js', bytes: enc.encode(pkg.behavior) },
    ...split.files,
  ]
}

/** Zip a part as a .oippart. Reproducible byte for byte. */
export async function partToOippartBytes(pkg: PartPackage, opts?: SplitOptions): Promise<Uint8Array> {
  const { zipSync } = await import('fflate')
  const tree: Zippable = {}
  for (const f of partFolderFiles(pkg, opts)) tree[f.path] = [f.bytes, { level: 6, mtime: ARCHIVE_MTIME }]
  return zipSync(tree)
}

/**
 * Unzip a .oippart into the two texts a host bakes a package from, its asset files joined back into the manifest. A
 * zip made by hand around the folder itself (`acme.transfer/manifest.json`, ...) reads the same. Errors name what is
 * wrong; nothing throws.
 */
export async function oippartBytesToFolder(bytes: Uint8Array): Promise<{ manifestJson: string; behaviorJs: string } | { error: string }> {
  const { strFromU8, unzipSync } = await import('fflate')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    return { error: 'not a valid part file (corrupt or not a zip)' }
  }
  const paths = Object.keys(entries).filter((p) => !p.endsWith('/'))
  // a folder zipped whole: every entry under one top directory, and no manifest at the root
  let prefix = ''
  if (!paths.includes('manifest.json')) {
    const tops = new Set(paths.map((p) => p.split('/')[0]))
    const only = tops.size === 1 ? [...tops][0]! : ''
    if (only !== '' && paths.includes(`${only}/manifest.json`)) prefix = `${only}/`
  }
  const at = (p: string): Uint8Array | undefined => entries[prefix + p]
  const manifest = at('manifest.json')
  if (manifest === undefined) return { error: 'not a part file (no manifest.json)' }
  const behavior = at('behavior.js')
  if (behavior === undefined) return { error: 'not a part file (no behavior.js)' }
  const joined = joinAssetFiles(strFromU8(manifest), (p) => (isPartAssetPath(p) ? at(p) : undefined))
  if (joined.error !== undefined) return { error: joined.error }
  return { manifestJson: joined.manifestJson, behaviorJs: strFromU8(behavior) }
}
