// The .oip archive codec: a .oip file is the project folder, zipped (the .docx model). One layout,
// two presentations: unzipped for git/VS Code/agents (core/project/projectFolder.ts), zipped for handing to
// someone. Zipping the folder by hand and exporting from the app produce the same kind of artifact.
// A part's asset files (parts/<slug>/assets/<sha256>.glb, core/parts/partAssets.ts) are ordinary entries, read
// back as bytes; every other entry is utf-8 text.
//
// Import must keep accepting the legacy .oip form (the flat serializeProject JSON document), so the
// caller sniffs with {@link isZipData} and routes to this codec or the JSON path. Export always zips.
//
// fflate is loaded lazily (dynamic import) so the archive path adds nothing to the main bundle until an
// export/import actually happens. A fixed entry mtime makes encoding reproducible: the same project
// yields byte-identical archives (zip carries per-entry DOS timestamps; "now" would break that).

import type { Zippable } from 'fflate'
import type { ProjectJSON, ProjectValidationResult } from './project'
import { folderFilesToProject, projectToFolderFiles } from './projectFolder'
import { isAssetFileInTree } from '../parts/partAssets'
import type { FolderOptions, PartBaker, ProjectFolderFile } from './projectFolder'

/** Zip magic ('PK'). A JSON document can never start with it, so two bytes decide the format. */
export function isZipData(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

// The ZIP DOS timestamp floor is 1980; any fixed date at or above it keeps archives reproducible. Built from local
// fields, because a zip entry's time is local time: a fixed UTC instant wrote a different time in each timezone.
const ARCHIVE_MTIME = new Date(2000, 0, 1)

/** Encode a project as a .oip archive: the folder layout, zipped. Reproducible byte-for-byte. */
export async function projectToOipBytes(project: ProjectJSON, opts?: FolderOptions): Promise<Uint8Array> {
  const { strToU8, zipSync } = await import('fflate')
  const tree: Zippable = {}
  for (const f of projectToFolderFiles(project, opts)) {
    tree[f.path] = [typeof f.contents === 'string' ? strToU8(f.contents) : f.contents, { level: 6, mtime: ARCHIVE_MTIME }]
  }
  return zipSync(tree)
}

/**
 * Decode a .oip archive back into a validated project: unzip, then reassemble through the folder
 * codec, so an archive gets exactly the validation (and part re-baking via `opts.bakePart`) an
 * on-disk folder does. Returns codec-shaped errors for a corrupt archive.
 */
export async function oipBytesToProject(bytes: Uint8Array, opts?: { bakePart?: PartBaker }): Promise<ProjectValidationResult> {
  const { strFromU8, unzipSync } = await import('fflate')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    return { ok: false, errors: ['not a valid .oip archive (corrupt or not a zip)'] }
  }
  const files: ProjectFolderFile[] = []
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/')) continue // directory entries carry no content
    files.push({ path, contents: isAssetFileInTree(path) ? data : strFromU8(data) })
  }
  return folderFilesToProject(files, opts)
}
