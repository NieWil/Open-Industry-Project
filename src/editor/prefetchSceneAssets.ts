import { versionedAssetUrl } from '../core/assetVersions'
import { pinShippedAsset } from '../core/shippedAssets'
import type { SceneJSON } from '../core/types'
import { dracoLoader } from '../render/dracoDecoder'
import { beginAssetLoad, whenBuildingGateOpen } from '../render/gltf'
import { CARGO_BOX_TEXTURES } from '../render/parts/cargoBox'
import { PALLET_TEXTURES } from '../render/parts/pallet'
import { bundledManifests } from './parts/bundledExamples'

/**
 * Start downloading the loaded scene's part assets as soon as the scene is known, instead of
 * waiting for each part's visual to be built.
 *
 * Asset requests are otherwise emitted by createPartVisual, which cannot run before the renderer
 * exists, and under WebGPU the renderer is built asynchronously (dynamic three.webgpu import +
 * device request), so the scene's geometry and textures would queue behind a GPU handshake they do
 * not need (seconds of idle link on a throttled prod build, ?webgpu&scene=demo). The pill, the cover
 * and the visuals are unchanged; this only moves the byte transfer earlier.
 *
 * A plain `fetch` that warms the HTTP cache, not the typed loaders. meshCache and
 * texCache (parts/sdk/materials.ts) are keyed by URL and the consumer owns the flags. A texture's
 * colorSpace depends on whether the material samples it as BaseColor or as a packed ORM map, which
 * a manifest-level prefetch cannot know. Seeding those caches with guessed flags would cause a
 * wrong-gamma bug. On a slow link bandwidth is the bottleneck, so warming the HTTP cache gives
 * nearly all of the speed-up. The decode still happens once, later, in the consumer with
 * the right flags.
 *
 * Counts through beginAssetLoad, so these are "the user's own assets" for the assets-quiet signal:
 * the speculative catalog sweep yields to them (controller.warmCatalog).
 */
const requested = new Set<string>()

export function prefetchSceneAssets(scene: SceneJSON): void {
  if (typeof fetch === 'undefined') return
  const ids = new Set<string>()
  for (const part of scene.parts ?? []) {
    const id = (part as { packageId?: string }).packageId
    if (id) ids.add(id)
  }
  if (ids.size === 0) return

  // Manifests, not registered packages: the registry is populated by loadBundledExamples in App's
  // viewport effect, which is exactly the mount we are trying to get ahead of. The manifests are
  // static bundled data (no network, no package build), so they are readable at boot.
  // A manifest names its source files (/models/AGV.glb), but a project's copy of a built-in loads the baked bytes
  // under /part-assets/<sha256> (pinShippedAsset, the same mapping sim/buildPackage.ts applies), so warm that url.
  // Warming the source path instead downloads ~1 MB that nothing reads, counted as the scene's own. That holds the
  // assets-quiet signal open until its cap on a slow host and lets the catalog warm start underneath it.
  const urls: string[] = []
  for (const manifest of bundledManifests()) {
    if (!ids.has(manifest.id)) continue
    for (const asset of manifest.assets ?? []) {
      const url = pinShippedAsset(asset).url
      if (!url || requested.has(url)) continue
      requested.add(url)
      urls.push(url)
    }
  }

  // The cargo textures are not manifest assets, so the loop above does not see them. Boxes and
  // pallets render through the standalone instanced batch, which loads them directly
  // (render/parts/cargoBox.ts, render/parts/pallet.ts), and sdk/cargo.ts does the same for the
  // per-part visual. Without this, nothing requests them until that batch builds itself, and on the demo
  // the box's model is still downloading 466 ms after the cover lifts (e2e/probes/after-lift-attrib.mjs).
  // The cover waits for the scene to stop arriving, so that is cover time. Same URLs the loaders fetch,
  // so the real load is a cache hit rather than a second fetch.
  const CARGO_ASSETS: Record<string, readonly string[]> = {
    'oip.box': Object.values(CARGO_BOX_TEXTURES),
    'oip.pallet': Object.values(PALLET_TEXTURES),
  }
  for (const [id, cargoUrls] of Object.entries(CARGO_ASSETS)) {
    if (!ids.has(id)) continue
    for (const url of cargoUrls) {
      if (requested.has(url)) continue
      requested.add(url)
      urls.push(url)
    }
  }

  if (urls.length === 0) return

  // The Draco decoder is another serial hop: in prod every rig GLB is Draco-compressed, and the
  // decoder (~190 KB wasm + wrapper) is fetched only on the first compressed parse - measured at
  // 13.0 -> 15.9 s on a throttled load, i.e. entirely after the cover, delaying the robot/AGV
  // geometry it gates. Kick it here so it overlaps the asset downloads instead of following them.
  // Cheap no-op in dev (nothing is compressed, so it just warms a localhost fetch).
  if (urls.some((u) => u.endsWith('.glb'))) void dracoLoader.preload()

  // Behind the same building-first gate the real loads use, so the environment still loads first.
  void whenBuildingGateOpen()
    .then(() => runPool(urls, PREFETCH_CONCURRENCY))
    .catch((e: unknown) => console.warn('[oip] prefetching scene assets failed', e))
}

// At most this many prefetches in flight. A browser allows ~6 connections per origin over HTTP/1.1,
// so firing all ~20 at once queues the app's own critical requests (the dynamic chunks
// createWebGPURenderer awaits) behind prefetch responses that nothing is waiting for. Measured:
// unthrottled concurrency pushes the renderer's chunk round from 4.4 s to 7.5 s and the cover from
// ~9 s to ~20 s. `priority:'low'` does not help here, since a priority hint cannot preempt a
// response already occupying a socket. Two keeps four free.
const PREFETCH_CONCURRENCY = 2

/** fetch `urls` at most `limit` at a time, warming the HTTP cache and nothing else */
function runPool(urls: readonly string[], limit: number): void {
  let next = 0
  const pump = (): void => {
    if (next >= urls.length) return
    const url = urls[next++]!
    const settled = beginAssetLoad()
    const done = (): void => {
      settled()
      pump()
    }
    // priority:'low' on top of the cap, so within our two slots the browser still ranks real
    // requests first. Unknown-key options are ignored where unsupported.
    // drain the body so the cache entry completes; the buffer is dropped immediately
    void fetch(versionedAssetUrl(url), { credentials: 'same-origin', priority: 'low' } as RequestInit)
      .then((res) => res.arrayBuffer())
      .then(done, done)
  }
  for (let i = 0; i < limit; i++) pump()
}
