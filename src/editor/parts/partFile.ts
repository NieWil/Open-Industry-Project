// Part file I/O - export/import a single custom part. Export writes a `.oippart` (the part folder zipped,
// core/parts/partArchive.ts); import also reads the older `.part.json` described here, the sibling of
// sceneFile.ts's whole-scene download. That file is the package manifest plus the behavior source
// (`behaviorSource`). Import always
// re-bakes through buildPackage (validate + re-derive the param schema from the behavior), so a
// hand-edited or drifted file can never register a package whose baked fields disagree with its script.

import type { PartPackage } from '../../core/parts/partPackage'
import { isZipData, oippartBytesToFolder, PART_ARCHIVE_EXTENSION, partToOippartBytes } from '../../core/parts/partArchive'
import type { SplitOptions } from '../../core/parts/partAssets'
import { buildPackage, manifestOfPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'

/**
 * Serialize a package to the portable part-file text: `{ ...manifest, behaviorSource }`. Baked fields
 * (params etc.) are omitted - the importer re-bakes them from the behavior (see manifestOfPackage).
 */
export function serializePart(pkg: PartPackage): string {
  return JSON.stringify({ ...manifestOfPackage(pkg), behaviorSource: pkg.behavior }, null, 2)
}

/**
 * Parse + validate a part file's text and build the package. Returns the built package, or a
 * human-readable error string. Accepts the canonical `{ ...manifest, behaviorSource }` shape and, for
 * convenience, a full serialized PartPackage (`behavior` instead of `behaviorSource` - e.g. one copied
 * out of a scene's embedded `packages`); both re-bake through buildPackage.
 */
export function parsePartText(text: string): { pkg: PartPackage } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'File is not valid JSON' }
  }
  if (typeof data !== 'object' || data === null) return { error: 'Not a part file' }
  const raw = data as Record<string, unknown>
  const behavior = typeof raw.behaviorSource === 'string' ? raw.behaviorSource : typeof raw.behavior === 'string' ? raw.behavior : null
  if (behavior === null) return { error: 'Not a part file (no behavior script found)' }
  // strip the non-manifest fields so a full-package file reduces to its manifest; buildPackage validates the rest
  const { behaviorSource: _b, behavior: _b2, format: _f, params: _p, ...manifest } = raw
  try {
    return { pkg: buildPackage(manifest as unknown as PackageManifest, behavior) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Read a part file of either kind: a `.oippart` (the part folder zipped, core/parts/partArchive.ts) or the older
 * `.part.json` text, told apart by their first bytes. Both re-bake through buildPackage.
 */
export async function parsePartBytes(bytes: Uint8Array): Promise<{ pkg: PartPackage } | { error: string }> {
  if (!isZipData(bytes)) return parsePartText(new TextDecoder().decode(bytes))
  const folder = await oippartBytesToFolder(bytes)
  if ('error' in folder) return folder
  try {
    return { pkg: buildPackage(JSON.parse(folder.manifestJson) as PackageManifest, folder.behaviorJs) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Download a part as `<id>.oippart`, its folder zipped (browser + Electron alike). */
export async function downloadPart(pkg: PartPackage, opts?: SplitOptions): Promise<void> {
  const bytes = await partToOippartBytes(pkg, opts)
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${pkg.id}${PART_ARCHIVE_EXTENSION}`
  a.click()
  URL.revokeObjectURL(url)
}
