// Test fixture loader for the committed first-party parts: the parity tests read the same committed source
// the app loads (examples/parts/<dir>/{rig.json, behavior.ts}), keyed by package id. This is the render-layer
// counterpart of editor/parts/bundledPackageData.ts (the app's loader): a separate small glob, because the enforced
// import boundary forbids render importing the editor layer.
// examples/ is not a source layer, so globbing it crosses nothing; core types only.

import type { SnapSpec } from '../../core/parts/partApi'
import type { ConveyorDecl, PartAsset, PartMaterial, PartPackageGeometry } from '../../core/parts/partPackage'

export type RigGeo = Extract<PartPackageGeometry, { kind: 'rig' }>
export type FuncGeo = Extract<PartPackageGeometry, { kind: 'drawn' }>
export type CargoGeo = Extract<PartPackageGeometry, { kind: 'cargo' }>

interface Manifest {
  id: string
  name: string
  category?: string
  geometry: PartPackageGeometry
  materials?: PartMaterial[]
  assets?: PartAsset[]
  conveyor?: ConveyorDecl
  commsParam?: string
  snap?: SnapSpec
}

const RIGS = import.meta.glob('../../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<string, Manifest>
const BEHAVIORS = import.meta.glob('../../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

const dirOf = (modulePath: string): string => modulePath.replace(/.*\/examples\/parts\/([^/]+)\/[^/]+$/, '$1')

const byId = new Map<string, { manifest: Manifest; behavior: string }>()
const behaviorByDir = new Map<string, string>()
for (const [path, src] of Object.entries(BEHAVIORS)) behaviorByDir.set(dirOf(path), src.replace(/\r\n/g, '\n'))
for (const [path, manifest] of Object.entries(RIGS)) {
  const behavior = behaviorByDir.get(dirOf(path))
  if (behavior !== undefined) byId.set(manifest.id, { manifest, behavior })
}

export interface ExamplePart<G extends PartPackageGeometry = PartPackageGeometry> {
  head: { id: string; name: string; category?: string; conveyor?: ConveyorDecl; commsParam?: string; snap?: SnapSpec }
  geometry: G
  materials: PartMaterial[]
  assets: PartAsset[]
  behavior: string
}

/** Every committed first-party package id, for catalog-wide invariants (a sweep can't go out of date the
 *  way a hand-listed set of ids does). Sorted, so a failure names the same part run to run. */
export function examplePartIds(): string[] {
  return [...byId.keys()].sort()
}

/**
 * The committed first-party part with this package id, as the fields the parity tests need. Pass the geometry
 * kind as the type arg (`examplePart<RigGeo>('oip.agv')`) when a test reads kind-specific fields (geo.joints,
 * geo.conveys, …); otherwise the default `PartPackageGeometry` is fine. Throws if the id has no committed folder.
 */
export function examplePart<G extends PartPackageGeometry = PartPackageGeometry>(id: string): ExamplePart<G> {
  const e = byId.get(id)
  if (!e) throw new Error(`no committed example part for id: ${id}`)
  const { manifest, behavior } = e
  return {
    // the manifest-level declarations a package needs besides its geometry: conveyor, comms switch, connectors
    head: { id: manifest.id, name: manifest.name, category: manifest.category, ...(manifest.conveyor ? { conveyor: manifest.conveyor } : {}), ...(manifest.commsParam ? { commsParam: manifest.commsParam } : {}), ...(manifest.snap ? { snap: manifest.snap } : {}) },
    geometry: manifest.geometry as G,
    materials: manifest.materials ?? [],
    assets: manifest.assets ?? [],
    behavior,
  }
}
