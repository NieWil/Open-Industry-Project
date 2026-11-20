// The data-driven load path for first-party parts. This reads the committed part-package files
// (examples/parts/<dir>/{rig.json, behavior.ts}) as data, the same shape a user/desktop/scene-embedded part
// loads through. rig.json is the thin manifest (head + geometry + materials + url-referenced assets);
// behavior.ts is the behavior source.
//
// Vite's import.meta.glob bundles these at build time (eager), so there's no runtime fs and no per-part import
// to maintain: adding a part is just dropping its folder.

import { buildPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import type { PartPackage } from '../../core/parts/partPackage'

// Eager glob: the JSON manifest as a parsed object, the behavior as raw text. Keys are module paths like
// '../../../examples/parts/diverter/rig.json'. Only folders with a rig.json are first-party packages.
const RIGS = import.meta.glob('../../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<string, PackageManifest>
const BEHAVIORS = import.meta.glob('../../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

const dirOf = (modulePath: string): string => modulePath.replace(/.*\/examples\/parts\/([^/]+)\/[^/]+$/, '$1')
// CRLF → LF: git may check the behavior out with CRLF on Windows. LF is the canonical form, so normalize for
// deterministic, OS-independent packages.
const lf = (s: string): string => s.replace(/\r\n/g, '\n')

export interface BundledPartData {
  dir: string
  manifest: PackageManifest
  behavior: string
}

/** The committed first-party part folders, paired (manifest + behavior), sorted by dir for a stable order. */
export function bundledPartData(): BundledPartData[] {
  const behaviorByDir = new Map<string, string>()
  for (const [path, src] of Object.entries(BEHAVIORS)) behaviorByDir.set(dirOf(path), lf(src))
  const out: BundledPartData[] = []
  for (const [path, manifest] of Object.entries(RIGS)) {
    const dir = dirOf(path)
    const behavior = behaviorByDir.get(dir)
    if (behavior === undefined) continue // a rig.json with no behavior.ts isn't a loadable part
    out.push({ dir, manifest, behavior })
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

/** Build every committed first-party part into a validated PartPackage (throws on an invalid one).
 *  `loadBundledExamples` registers these directly. */
export function bundledPackagesFromData(): PartPackage[] {
  return bundledPartData().map((d) => buildPackage(d.manifest, d.behavior))
}

/** The committed first-party part with this package id (manifest + behavior), or undefined. */
export function bundledPartById(id: string): BundledPartData | undefined {
  return bundledPartData().find((d) => d.manifest.id === id)
}
