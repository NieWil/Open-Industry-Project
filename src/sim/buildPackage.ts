// Build-time helper that packages an authored behavior script into a distributable PartPackage. It
// lives in the sim project because it runs the behavior once (via the embeddable runtime) to bake the
// exported-param schema so importers render the Inspector without executing code.
//
// These modules - core/parts/partApi (types) + core/parts/partPackage (format) + core/parts/partValidate + this helper - are the
// internal shape of the future `@oip/part-sdk` npm package an external author installs in their own IDE.
// The app also calls buildPackage from its import flow (drop a behavior.js + manifest → a part package).

import type { PackageManifest, PartPackage } from '../core/parts/partPackage'
import { manifestOfPackage } from '../core/parts/partPackage'
import { formatPartDiagnostics, validatePart } from './validatePart'

// The manifest type + the package→manifest projection are pure data and live in core/parts/partPackage.ts
// (the project-folder codec spills parts through them); re-exported here so authoring-tool importers
// keep their one entry point.
export type { PackageManifest }
export { manifestOfPackage }

/**
 * Build a distributable PartPackage from a manifest + the author's behavior script source. Bakes the
 * behavior's exported-param schema and validates the result. Throws if the behavior is invalid - the
 * throwing wrapper over validatePart(), which the import flow / IDE use for structured diagnostics.
 */
export function buildPackage(manifest: PackageManifest, behaviorSource: string): PartPackage {
  const result = validatePart(manifest, behaviorSource)
  if (!result.ok || !result.package) {
    throw new Error(`invalid package: ${formatPartDiagnostics(result.diagnostics)}`)
  }
  return result.package
}

/**
 * Inverse of buildPackage: serialize a registered package back into the on-disk workspace-folder format
 * (`manifest.json` + `behavior.js`), the format a part folder holds and Import part > A folder of parts… reads
 * (apps/desktop/partsWorkspace.cjs). Its tests pin that buildPackage reads back exactly what this writes.
 */
export function packageToWorkspaceFiles(pkg: PartPackage): { manifestJson: string; behaviorJs: string } {
  return { manifestJson: JSON.stringify(manifestOfPackage(pkg), null, 2), behaviorJs: pkg.behavior }
}
