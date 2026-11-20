// First-party custom-part examples bundled with the app: the built-in parts, written on the public part SDK and
// shipped in the catalog by default (browser and desktop) so every author has a working, readable reference to
// copy. Unlike a user's desktop parts folder (packageSource.ts), these are baked in; unlike a portable third-party
// part, their meshes/textures are URL-referenced to the app's own public/ assets (no multi-MB embed in the bundle).
//
// Each part is a committed package folder (examples/parts/<dir>/{rig.json, behavior.ts}) loaded as data by
// bundledPackageData.ts, so adding a part is just dropping a folder. Here we order them (ORDER, below), build each
// → buildPackage (bakes params + validates) → register in the runtime registry → hand the list to the store for
// the catalog.

import { registerPackage, setBuiltInPackages } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import { buildPackage } from '../../sim/buildPackage'
import { bundledPartData } from './bundledPackageData'
import type { BundledPartData } from './bundledPackageData'
import type { PackageStatus } from './packageSource'
import type { EditorStore } from '../store/store'

// Re-exported so other modules (e.g. demoScenes) reach the committed-part data through this module, not
// by importing './bundledPackageData' directly. That keeps bundledPackageData's only importer the HMR
// boundary below: a direct importer with no `import.meta.hot.accept` is a dead-end path that forces Vite
// to full-reload every part edit instead of hot-swapping.
// eslint enforces this (no-restricted-imports in eslint.config.js).
export { bundledPartById } from './bundledPackageData'
export type { BundledPartData } from './bundledPackageData'

/**
 * The committed parts' manifests only: no buildPackage, no registration. For the boot-time
 * scene-asset prefetch (prefetchSceneAssets.ts), which needs nothing but each part's asset URLs
 * and runs before this module's packages are built. Routed through here for the reason above.
 */
export function bundledManifests(): BundledPartData['manifest'][] {
  return bundledPartData().map((item) => item.manifest)
}

/**
 * The bundled parts whose catalog card loads a committed `/thumbnails/pkg/*.webp`: every committed
 * folder except one carrying its own author-supplied `thumbnail` (a data URL, already in the bundle).
 * The boot warm takes this (main.tsx → render/prefetch.ts); `catalogThumbWarm.test.ts` pins it against
 * the files actually on disk, in both directions, so neither a cold card nor a 404 can ship quietly.
 * Manifests rather than built packages for the same reason as above - this runs before the build.
 */
export function bundledThumbnailIds(): string[] {
  return bundledPartData()
    .filter((item) => !item.manifest.thumbnail)
    .map((item) => item.manifest.id)
}

/**
 * The behavior source of every committed first-party part, by package id: the code this app ships. A room runs a
 * peer's copy of a part without asking only when its code is one of these (collab/codeTrust.ts). Read from the
 * data rather than built packages because the room boot needs it before loadBundledExamples runs, and a built
 * package's `behavior` is this source verbatim (validatePart keeps it; roomCodeTrust.test.ts pins that).
 */
export function bundledBehaviors(): Map<string, string> {
  return new Map(bundledPartData().map((item) => [item.manifest.id, item.behavior]))
}

// Curated catalog order (by package id). Any committed folder not listed here still loads, appended after these
// in bundledPartData's stable alphabetical order, so dropping a new part folder just works. Exported for the test.
export const ORDER: string[] = [
  'oip.six-axis-robot',
  'oip.diverter',
  'oip.blade-stop',
  'oip.safety-gate',
  'oip.stack-light',
  'oip.diffuse-sensor',
  'oip.color-sensor',
  'oip.laser-sensor',
  'oip.push-button',
  'oip.box-spawner',
  'oip.despawner',
  'oip.belt-conveyor',
  'oip.roller-conveyor',
  'oip.flex-conveyor',
  'oip.turntable-conveyor',
  'oip.curved-conveyor',
  'oip.curved-roller-conveyor',
  'oip.chain-transfer',
  'oip.spur-conveyor',
  'oip.spur-roller-conveyor',
  'oip.rack',
  'oip.guard-rail',
  'oip.platform',
  'oip.stairs',
  'oip.floor-marking',
  'oip.box',
  'oip.pallet',
  'oip.unit-load',
  'oip.pallet-spawner',
  'oip.pallet-dispenser',
  'oip.stretch-wrapper',
  'oip.fence',
  'oip.gantry',
  'oip.agv',
]

// The live store, remembered on first load so the dev HMR hook (bottom of file) can rebuild into it.
let hotStore: EditorStore | null = null

/**
 * Order the committed-folder parts for the catalog: those named in `order` first, in that order; any folder not
 * listed (a freshly-dropped part) appended after, keeping `data`'s stable order. Pure + exported for the test.
 */
export function mergeBundleOrder(data: BundledPartData[], order: string[]): BundledPartData[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const at = (d: BundledPartData): number => rank.get(d.manifest.id) ?? Number.MAX_SAFE_INTEGER
  return data.map((d, i) => ({ d, i })).sort((a, b) => at(a.d) - at(b.d) || a.i - b.i).map(({ d }) => d)
}

/** Build every bundled example (in catalog order), without registering or publishing anything. */
function buildBundle(getData: () => BundledPartData[]): { pkgs: PartPackage[]; statuses: PackageStatus[] } {
  const pkgs: PartPackage[] = []
  const statuses: PackageStatus[] = []
  // The source of truth is the committed part-package files (examples/parts/<dir>/{rig.json, behavior.ts}) via the data
  // loader; ORDER only sets catalog position. Editing a committed behavior.ts reaches the app without regenerating.
  for (const item of mergeBundleOrder(getData(), ORDER)) {
    try {
      const pkg = buildPackage(item.manifest, item.behavior)
      pkgs.push(pkg)
      statuses.push({ id: pkg.id, name: pkg.name, dir: item.dir, ok: true })
    } catch (e) {
      console.error('[oip] bundled example failed to load:', item.manifest.id, e)
      const name = item.manifest.name ?? item.manifest.id
      statuses.push({ id: item.manifest.id, name, dir: item.dir, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { pkgs, statuses }
}

// The build registerBundledPackages made at boot, kept for loadBundledExamples to publish rather than build again.
let bootBuild: ReturnType<typeof buildBundle> | null = null

/**
 * Register every bundled example as the live copy of its id, before the solo boot loads the saved document, and
 * nothing more: no catalog, no store. A saved scene embeds a snapshot of every part it places, built-in ones included,
 * and loading it registers each snapshot unless its id is already authoritative (registerScenePackages). Registered
 * any later, a snapshot saved by an older build draws first and fetches its assets, and the current part replaces
 * it a moment after. The user's own forks still take precedence: their library is
 * adopted after this, authoritatively, and loadBundledExamples then leaves those ids alone.
 */
export function registerBundledPackages(): void {
  bootBuild = buildBundle(bundledPartData)
  for (const pkg of bootBuild.pkgs) registerPackage(pkg, true)
  setBuiltInPackages(bootBuild.pkgs) // what a project names without a copy (core/project/project.ts, format 3)
}

/**
 * Build + register every bundled example and publish them to the store's catalog. Idempotent (registerPackage
 * + setBundledPackages both replace) and change-aware: registerPackage skips notify for content-identical
 * re-registers, so the HMR sweep below (which rebuilds the whole catalog on any one-file save) fans out to the
 * render/sim reload seam only for the part that actually changed. A broken example never blocks the others or
 * the app: it's logged, surfaced as a build-status toast/badge (same surface as the desktop watcher), and the
 * registry keeps its last-good version. The first call after {@link registerBundledPackages} publishes that build.
 */
export function loadBundledExamples(store: EditorStore, getData: () => BundledPartData[] = bundledPartData): PartPackage[] {
  // A user copy-on-write shadow (an edited bundled example forked into the library, see store.syncUserCatalog)
  // must win in the registry. restoreUserPackages already registered it, so don't re-register the pristine
  // bundle over it here (this effect runs after boot's restore). The pristine bundle is still published to the
  // catalog list as the authoring template; the catalog de-dupes by id with the user copy winning.
  const shadowed = new Set(store.getState().userPackages.map((p) => p.id))
  // the boot's build is used once; anything later (the HMR sweep, with its fresh data) builds anew
  const { pkgs, statuses } = getData === bundledPartData && bootBuild ? bootBuild : buildBundle(getData)
  bootBuild = null
  // authoritative: the freshly-built bundle is the live first-party part, and a scene's embedded snapshot of
  // this id must not overwrite it on load (so an edited part shows up without clearing storage).
  for (const pkg of pkgs) if (!shadowed.has(pkg.id)) registerPackage(pkg, true)
  setBuiltInPackages(pkgs)
  store.setBundledPackages(pkgs)
  // Same author signal as the desktop watcher (connectDesktopPackages): a part that fails to build raises a
  // toast + catalog badge instead of silently keeping its last-good version; a good rebuild clears the badge.
  store.applyPackageStatuses(statuses)
  hotStore = store // remember the live store so the HMR hook below can rebuild into it
  return pkgs
}

// ---- dev hot-reload -------------------------------------------
// Editing a committed part file (examples/parts/<dir>/{rig.json, behavior.ts}) updates the running app without a
// manual rebuild or a full page reload. The data loader globs those files, so a save invalidates bundledPackageData;
// we accept that change here (bundledExamples is editor-layer, so it isn't caught by the render full-reload plugin)
// and re-run loadBundledExamples → registerPackage(authoritative) → the registry's onPackagesChanged seam, which the
// controller wires to view.refreshPackage (render) and reloadSimPackage (a running sim). Same live-swap the desktop
// ejected-parts watcher drives, triggered by Vite HMR instead of an fs watch.
if (import.meta.hot) {
  // Feed the newly-evaluated bundledPackageData module into the reload. Vite does not rebind this module's
  // static `bundledPartData` import on an accepts-deps update. It keeps pointing at the pre-edit module,
  // which still closes over the old globbed files, so re-running loadBundledExamples() without `mod` would
  // silently re-register the stale part. Reading `mod.bundledPartData` (the fresh glob) is what makes the
  // edit actually reach the app.
  import.meta.hot.accept('./bundledPackageData', (mod) => {
    if (hotStore && mod) loadBundledExamples(hotStore, mod.bundledPartData)
  })
}
