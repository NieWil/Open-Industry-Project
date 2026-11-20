// The app's PartBaker (see core/project/projectFolder.ts): rebuild a part folder's two files
// (manifest.json + behavior.js) through the canonical validator, so an edited script's
// syntax/determinism/param problems surface at project open/import instead of loading an inert
// part. Its own module because both project-ingest surfaces need it - the desktop folder open
// (desktopProjectBridge) and the .oip import (projectFile) - and neither should depend on the other.

import type { PackageManifest } from '../../core/parts/partPackage'
import type { PartBaker } from '../../core/project/projectFolder'
import { formatPartDiagnostics, validatePart } from '../../sim/validatePart'

export const bakePart: PartBaker = (manifestJson, behaviorJs) => {
  let manifest: PackageManifest
  try {
    manifest = JSON.parse(manifestJson) as PackageManifest
  } catch {
    return { error: 'manifest.json is not valid JSON' }
  }
  const result = validatePart(manifest, behaviorJs)
  return result.ok && result.package ? { package: result.package } : { error: formatPartDiagnostics(result.diagnostics) }
}
