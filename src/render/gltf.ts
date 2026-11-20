import { ImageBitmapLoader, Texture } from 'three'
import type { Group, Material, Mesh } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { versionedAssetUrl } from '../core/assetVersions'
import { notifyBundleStructureChanged } from './bundleGroups'
import { computeColliderBVH } from './bvh'
import { dracoLoader } from './dracoDecoder'

const loader = new GLTFLoader()
// Decompress meshopt-packed geometry on a worker pool rather than the main
// thread, so decoding a heavy GLB (e.g. the ~3 MB AGV) doesn't stall input
// while it unpacks. Meshopt packing is applied by the prod optimize-assets
// step, so this mainly helps production. Guarded because the node test
// environment has no Web Workers.
if (typeof Worker !== 'undefined') MeshoptDecoder.useWorkers(2)
loader.setMeshoptDecoder(MeshoptDecoder)
// ...and Draco for the node-driven rigs, which can't take meshopt at all (see dracoDecoder.ts).
// Both compressions coexist: the optimizer picks one per model, the parser accepts either.
loader.setDRACOLoader(dracoLoader)
const cache = new Map<string, Promise<Group | null>>()

// Shared loader for loose image textures (building BaseColor, metal, ORM maps).
// createImageBitmap decodes off the main thread, unlike TextureLoader's
// HTMLImageElement path which decodes on it. Default orientation is no-flip,
// matching the glTF flipY=false convention every caller uses (and harmless for
// the world-sampled triplanar metal texture, where vertical flip is invisible).
const bitmapLoader = new ImageBitmapLoader()

/**
 * What a texture should sample as when its image never arrives. An image-less Texture is not "no
 * map": three binds its empty default and the surface samples black. Without a fallback, one dropped
 * request would turn the warehouse floor black under a lifted cover, since the gate settles on failure by design. A
 * neutral 2x2 degrades to "untextured but correctly lit".
 *
 * The neutral value is per channel: mid grey for albedo, black for emissive (or the fixture glows)
 * and flat +Z for normals.
 *
 * 2x2, not 1x1: three's WebGPU backend caches a texture's GPU view under a key of its size and mip count
 * (WebGPUBindingUtils.createBindGroup) and never clears that cache when the empty 1x1 default is replaced by
 * the real upload. A 1x1 single-mip fallback gets the default's key, binds the default's view, and samples black
 * for the session whenever the failure lands after the surface first drew (docs/three-coupling.md).
 *
 * Apply it only after the fetch has definitively failed. Never use it as a placeholder before the image
 * arrives: three's WebGPU backend sizes a GPUTexture from the first image uploaded, so a 1x1
 * placeholder would leave the surface permanently sampling 1x1 (gpuTextureAudit.ts audits this class).
 */
export type TextureFallback = 'albedo' | 'emissive' | 'normal'

const FALLBACK_HEX: Record<TextureFallback, string> = {
  // Mid grey, not identity white. White is the mathematically neutral multiplier, but every albedo
  // map here sits on a material whose own colour is white or near-white (applyDesktopMaterial sets
  // 0xffffff; the floor keeps a #e6e2db tint), so white renders the surface blown out: measured
  // at 175% of the textured frame's luminance, which looks as broken as black.
  // The building's own albedo maps average sRGB ~95-155, so a mid grey keeps the surface in that
  // range: plain untextured concrete/cladding rather than a white cut-out.
  albedo: '#808080',
  emissive: '#000000', // no glow, which is what an absent emissive map means
  normal: '#8080ff', // flat tangent-space normal (0,0,1)
}

const fallbackImages = new Map<TextureFallback, HTMLCanvasElement>()

/** a cached 2x2 canvas of the neutral colour; null where there is no DOM (node unit tests) */
function fallbackImage(kind: TextureFallback): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  let img = fallbackImages.get(kind)
  if (!img) {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = FALLBACK_HEX[kind]
    ctx.fillRect(0, 0, 2, 2)
    img = canvas
    fallbackImages.set(kind, img)
  }
  return img
}

/**
 * Fetch `url` as an ImageBitmap, retrying once after a short delay before giving up. This guards
 * against a transient failure (a dropped connection, a 5xx blip, a request the browser aborted).
 * Without the retry that texture stays missing for the whole session, since nothing re-requests it,
 * and only that one user sees a wrong scene. `onFail` runs only after the retry also
 * fails, so the gate/quiet accounting still settles exactly once, just ~RETRY_DELAY_MS later.
 */
const RETRY_DELAY_MS = 500
function fetchBitmap(url: string, onLoad: (bitmap: ImageBitmap) => void, onFail: () => void): void {
  const fail = (err: unknown): void => {
    console.warn(`[oip] texture failed to load after a retry: ${url} - rendering it neutral`, err)
    onFail()
  }
  const fetched = versionedAssetUrl(url)
  bitmapLoader.load(fetched, onLoad, undefined, () => {
    setTimeout(() => bitmapLoader.load(fetched, onLoad, undefined, fail), RETRY_DELAY_MS)
  })
}

/**
 * Load `url` into a Texture with its image decode done off the main thread.
 * Returns an empty Texture synchronously and fills it in once the bitmap
 * resolves - same eager-return contract as TextureLoader.load(), so callers can
 * set wrap/colorSpace/anisotropy on the result and assign it to a material
 * right away. `onSettle` fires once, on success OR failure (the building-first
 * gate relies on this). flipY is forced off to match the glTF UV convention;
 * an ImageBitmap source can't be flipped at GPU upload anyway.
 *
 * `fallback` picks what the texture samples as if the fetch fails for good - see TextureFallback;
 * pass the channel this texture feeds, since the default ('albedo') would make a failed emissive
 * or normal map worse than black.
 */
export function loadTextureBitmap(url: string, onSettle?: () => void, fallback: TextureFallback = 'albedo'): Texture {
  const tex = new Texture()
  tex.flipY = false
  // counts toward the assets-quiet signal unless this is a speculative warm (whose whole point is
  // to be yielded to the user's own assets), in which case it goes on the speculative ledger instead
  noteSpeculativeFetch(url)
  const speculative = warmDepth > 0
  const endAsset = speculative ? () => {} : beginAssetLoad()
  fetchBitmap(
    url,
    (bitmap) => {
      tex.image = bitmap
      tex.needsUpdate = true
      // A texture that decodes after its mesh was recorded into a WebGPU render bundle stays black
      // on replay. The recorded bind group still holds the empty default texture, and a needsUpdate
      // version bump alone never reaches a replayed draw (the "data changed, pixels didn't" class,
      // bundleGroups.ts). One structural notify re-records with the real texture. Under WebGL or
      // with bundles off it only bumps a counter.
      //
      // A speculative warm's texture has no drawn mesh to fix. This Texture belongs to the
      // throwaway visual the warm just built (the caller owns it; the shared-decode variant below is
      // the one with joiners), so re-recording the scene for it would be wasted work. The same
      // reasoning keeps these loads off the quiet signal above. See structureRev.ts.
      if (!speculative) notifyBundleStructureChanged()
      endAsset()
      onSettle?.()
    },
    () => {
      const img = fallbackImage(fallback)
      if (img) {
        tex.image = img
        tex.needsUpdate = true
        if (!speculative) notifyBundleStructureChanged() // same re-record reason as the success path
      }
      endAsset()
      onSettle?.()
    },
  )
  return tex
}

// Shared-decode variant: each URL is fetched + decoded once and the ImageBitmap is shared across
// every returned Texture. Callers still own their Texture (per-part repeat/colorSpace, disposable;
// dispose frees only that GPU copy, the bitmap stays cached). Textures handed out while the decode
// is in flight are filled on arrival, with the same bundle re-record notify as loadTextureBitmap.
// Currently unused: each caller still holds its own Texture, i.e. its own GPU upload on WebGPU
// (~10.7 MB per deck), so decks share one Texture with tiling in a material uniform (common.ts
// deckSurfaceMaterial). Prefer that; use this only when callers need different sampler settings
// over one image.
//
// A failure resolves the entry to the neutral fallback. Entries are permanent, so an unresolved one
// would leave every later caller on a waiter list nothing drains.
interface SharedBitmap {
  image: ImageBitmap | HTMLCanvasElement | null
  waiters: Texture[]
  /**
   * did any non-speculative caller take this bitmap before it resolved? Only then can the decode
   * arrive for a mesh the view has already recorded, so only then is the re-record notify needed. The
   * flag is per entry, not per call, because a warm can open an entry a real part later joins. It is
   * read at resolve time, and one real joiner sets it (see structureRev.ts for the direction rule).
   */
  realWaiter: boolean
}
const sharedBitmaps = new Map<string, SharedBitmap>()
export function loadTextureBitmapShared(url: string, fallback: TextureFallback = 'albedo'): Texture {
  const tex = new Texture()
  tex.flipY = false
  let entry = sharedBitmaps.get(url)
  if (!entry) {
    const e: SharedBitmap = { image: null, waiters: [], realWaiter: false }
    entry = e
    sharedBitmaps.set(url, e)
    noteSpeculativeFetch(url)
    const endAsset = warmDepth > 0 ? () => {} : beginAssetLoad()
    const resolve = (image: ImageBitmap | HTMLCanvasElement | null): void => {
      e.image = image
      if (image) {
        for (const t of e.waiters) {
          t.image = image
          t.needsUpdate = true
        }
        if (e.realWaiter) notifyBundleStructureChanged()
      }
      e.waiters.length = 0
      endAsset()
    }
    fetchBitmap(url, resolve, () => resolve(fallbackImage(fallback)))
  }
  if (entry.image) {
    tex.image = entry.image
    tex.needsUpdate = true
  } else {
    // a caller that is not a speculative warm gives the entry its re-record notify: only its mesh
    // can already be recorded into a bundle when the decode finishes. A later real joiner sets this
    // even if a warm opened the entry. One that arrives after the resolve takes the image above,
    // synchronously, and needs no notify.
    if (warmDepth === 0) entry.realWaiter = true
    entry.waiters.push(tex)
  }
  return tex
}

/** the one place a shared app GLB's URL is spelled - the speculative log records the same string */
function modelUrl(name: string): string {
  return `/models/${name}.glb`
}

function fetchScene(name: string): Promise<Group | null> {
  return loader.loadAsync(versionedAssetUrl(modelUrl(name))).then(
    (gltf) => {
      // build a BVH on this template's dense geometry once; clones share it, so the
      // pilot (and the editor picker) raycast every placed copy in O(log tris)
      computeColliderBVH(gltf.scene)
      return gltf.scene
    },
    () => null,
  )
}

// In-flight GLB count, for the viewport "Loading models…" indicator. Parts render
// a procedural placeholder until their model streams in (and swaps over), so this
// is the signal that better geometry is still arriving.
let inFlight = 0
const progressListeners = new Set<(inFlight: number) => void>()
function emitProgress(): void {
  for (const cb of progressListeners) cb(inFlight)
}

/** subscribe to the count of in-flight model loads; fires immediately with the current count */
export function onModelLoadProgress(cb: (inFlight: number) => void): () => void {
  progressListeners.add(cb)
  cb(inFlight)
  return () => {
    progressListeners.delete(cb)
  }
}

// Speculative-warm depth. While > 0, loadPartModel treats fetches as background (untracked), so the
// hover/idle catalog warm (view.warmPart → createPartVisual) never lights the "Loading models…" pill -
// that pill is for geometry a placed part is still waiting on, not preloading. A counter (not a bool) so
// nested/concurrent warms compose. The warm build's loadPartModel calls run synchronously inside the fn,
// so they observe the flag; the async swap that follows is already cached and untracked.
let warmDepth = 0
/** true while a speculative catalog/hover warm is building - such loads stay off the quiet signal */
export function isSpeculativeWarm(): boolean {
  return warmDepth > 0
}

export function runSpeculativeWarm<T>(fn: () => T): T {
  warmDepth++
  try {
    return fn()
  } finally {
    warmDepth--
  }
}

// ---- what the app itself considers speculation ----------------------------
//
// Every fetch started inside a speculative warm, in call order. The first-load gate
// (e2e/verify-first-load.mjs) reads this through the __oip hook to tell the user's own scene bytes
// apart from speculation. It is recorded where the app decides whether a load counts toward the quiet
// signal. A gate that guessed from a list of "parts not in the demo" would fail when the demo gains
// one, and pass vacuously when a canary becomes a scene part.
//
// Bounded by distinct urls, not by warm count: every call site sits behind a cache miss, so a
// repeated hover/sweep of the same part records nothing.
const speculativeFetchLog: { url: string; at: number }[] = []

/** record `url` if we are inside a speculative warm; a no-op otherwise, so callers needn't check */
export function noteSpeculativeFetch(url: string): void {
  if (warmDepth > 0) speculativeFetchLog.push({ url, at: Math.round(performance.now()) })
}

/** URLs a speculative warm (catalog sweep, hover preload, thumbnails) fetched, with start times */
export function speculativeFetches(): readonly { url: string; at: number }[] {
  return speculativeFetchLog
}

// ---- "the user's own assets are quiet" signal ------------------------------
//
// Unlike the `inFlight` pill (models only), this counts every non-speculative fetch, models and
// textures (parts/sdk/materials.ts included), for the idle catalog warm (controller.warmCatalog),
// which must not spend bandwidth on unseen parts while visible ones are still arriving.
//
// Not `modelsSettled()`: that snapshots the cache at call time, so it would resolve once the building
// settles, before the parts have requested anything, and the sweep would race them (throttled prod demo:
// ~9 s of visible pop-in after the cover lifted).
//
// "Quiet" = nothing in flight for a continuous QUIET_MS, so a gap between parts' fetches doesn't
// read as done. A new load re-arms it; the waiter's cap bounds a wedged fetch.
const QUIET_MS = 500
const QUIET_CAP_MS = 30000
let assetsInFlight = 0
let quietTimer: ReturnType<typeof setTimeout> | undefined
const quietWaiters = new Set<() => void>()

function scheduleQuiet(): void {
  if (quietTimer) clearTimeout(quietTimer)
  const t = setTimeout(() => {
    quietTimer = undefined
    if (assetsInFlight > 0) return // a load re-armed us; its settle will schedule the next window
    for (const w of [...quietWaiters]) w()
    quietWaiters.clear()
  }, QUIET_MS) as unknown as { unref?: () => void }
  ;(t as { unref?: () => void }).unref?.()
  quietTimer = t as unknown as ReturnType<typeof setTimeout>
}

/**
 * Mark one non-speculative asset fetch as in flight; call the returned fn when it settles
 * (idempotent). Speculative warms must not call this: the quiet signal exists to hold them back.
 */
export function beginAssetLoad(): () => void {
  assetsInFlight++
  if (quietTimer) {
    clearTimeout(quietTimer)
    quietTimer = undefined
  }
  let settled = false
  return () => {
    if (settled) return
    settled = true
    assetsInFlight--
    if (assetsInFlight === 0) scheduleQuiet()
  }
}

/** Resolves once no non-speculative asset has been in flight for QUIET_MS (or at a hard cap). */
export function whenAssetsQuiet(): Promise<void> {
  return new Promise((resolve) => {
    quietWaiters.add(resolve)
    if (assetsInFlight === 0 && !quietTimer) scheduleQuiet()
    const cap = setTimeout(() => {
      quietWaiters.delete(resolve)
      resolve()
    }, QUIET_CAP_MS) as unknown as { unref?: () => void }
    cap.unref?.()
  })
}

/** true while any non-speculative asset fetch is outstanding (the sweep yields on this) */
export function assetsBusy(): boolean {
  return assetsInFlight > 0
}

/** count a load as in-flight until it settles (the gated wrapper includes the building-gate wait) */
function tracked<T>(p: Promise<T>): Promise<T> {
  inFlight++
  emitProgress()
  const endAsset = beginAssetLoad()
  const done = (): void => {
    inFlight--
    emitProgress()
    endAsset()
  }
  void p.then(done, done)
  return p
}

// Building-first ordering. building/* models and textures (gateBuildingLoad) are requested at
// module import; gating every other fetch behind them keeps parts from competing for bandwidth,
// so the environment loads first, fully textured. Parts show their procedural fallback meanwhile.
//
// Two signals share the "building assets settled" promise with different fallback timeouts:
//   - the gate (openGate / buildingGate) releases the other parts. It has a short 6 s fallback so a
//     building-less scene or stalled fetch never blocks them.
//   - the cover signal (settleCover / whenBuildingReady) lifts the loading cover. Lifting early
//     reveals untextured white walls (empty BaseColor until the webp decodes, parts/building.ts),
//     so it waits for the textures and falls back only after a long cap for a wedged fetch. A 6 s
//     cover timeout would flash white walls on a slow edge.
//
// A load can be cover-only: the cover waits for it, the gate does not. This is for non-shell scenery
// like the dock-door bay's maps (dockDoor.ts, ~0.5 MB), which must load before the reveal. Gating them
// into both signals would push gate-open from 4.4 s to 5.8 s and delay the whole scene.
const GATE_TIMEOUT_MS = 6000
const COVER_TIMEOUT_MS = 20000
const buildingLoads: Promise<unknown>[] = []
const coverOnlyLoads: Promise<unknown>[] = []
let openGate: () => void
const buildingGate = new Promise<void>((resolve) => {
  openGate = resolve
})
let settleCover: () => void
const coverReady = new Promise<void>((resolve) => {
  settleCover = resolve
})
let gateScheduled = false
let settleScheduled = false

// Resolve the gate + cover once the building loads registered so far have settled,
// debounced to a single microtask so a whole synchronous burst of building/* loads
// registers before we snapshot it. An empty set is skipped rather than
// settled: under the experimental ?webgpu path RenderView mounts asynchronously
// (App awaits createWebGPURenderer), so the building fetches register in a later tick
// than the cover's whenBuildingReady() call. Settling against the empty array would
// resolve Promise.allSettled([]) immediately and lift the cover before the building
// has even started loading. Leaving it unscheduled means the next registered building
// load re-arms it (registerBuildingLoad / scheduleGateOpen both call back in here).
function scheduleSettle(): void {
  if (settleScheduled) return
  settleScheduled = true
  queueMicrotask(() => {
    settleScheduled = false
    if (buildingLoads.length === 0 && coverOnlyLoads.length === 0) return
    // the gate waits for the shell only; the cover additionally waits for cover-only scenery. Neither chain can
    // reject: allSettled never does, and openGate / settleCover are promise resolvers.
    // eslint-disable-next-line oip/no-unhandled-then
    if (buildingLoads.length > 0) void Promise.allSettled(buildingLoads).then(() => openGate())
    // eslint-disable-next-line oip/no-unhandled-then
    void Promise.allSettled([...buildingLoads, ...coverOnlyLoads]).then(() => settleCover())
  })
}

function scheduleGateOpen(): void {
  scheduleSettle()
  if (gateScheduled) return
  gateScheduled = true
  // hard fallbacks: never strand other parts (short) or the cover (long) if the
  // building assets never resolve - including the building-less scene, where no load
  // ever registers and scheduleSettle() stays a no-op. unref so the timers don't keep
  // Node (tests) alive.
  const gateTimer = setTimeout(() => openGate(), GATE_TIMEOUT_MS) as unknown as { unref?: () => void }
  gateTimer.unref?.()
  const coverTimer = setTimeout(() => settleCover(), COVER_TIMEOUT_MS) as unknown as { unref?: () => void }
  coverTimer.unref?.()
}

/**
 * Resolves once the building's GLBs and textures have settled, or a long safety
 * timeout fires. This is the signal the first-load viewport cover waits on, so the
 * user never sees the flat procedural placeholder or the brief untextured-GLB
 * stage - only the finished, textured building. Not the part-release
 * gate (buildingGate): that opens after a short timeout to free the other parts,
 * which would lift the cover onto untextured walls. Scene parts are not gated by
 * this and keep streaming behind the "Loading models…" pill.
 */
export function whenBuildingReady(): Promise<void> {
  scheduleGateOpen() // arm the gate + cover (and their timeouts) even if nothing requested a load yet
  return coverReady
}

/**
 * Resolves when non-building fetches are released (the building's assets settled, or the short
 * fallback fired) - the same gate loadPartModel puts them behind. Exposed so the boot-time
 * scene-asset prefetch (editor/prefetchSceneAssets.ts) inherits the identical "building first"
 * ordering instead of racing it with raw fetches.
 */
export function whenBuildingGateOpen(): Promise<void> {
  scheduleGateOpen()
  return buildingGate
}

/**
 * Fetch /models/<name>.glb once and cache the scene as a shared template.
 * Resolves null on absence or parse failure (callers keep their procedural
 * fallback). Always clone before mutating - see clonePartModel.
 *
 * `background: true` warms the cache silently for an idle-time prefetch (see
 * render/prefetch.ts) - the load is cached and gated exactly like a normal one
 * but is not counted toward the "Loading models…" indicator, which is meant to
 * signal geometry a placed part is still waiting on, not speculative warming.
 * (runSpeculativeWarm applies the same silence to a whole build, used by the
 * hover/idle catalog warm which fetches via createPartVisual, not this flag.)
 */
export function loadPartModel(name: string, opts?: { background?: boolean }): Promise<Group | null> {
  let promise = cache.get(name)
  if (!promise) {
    scheduleGateOpen()
    const speculative = opts?.background === true || warmDepth > 0
    if (name.startsWith('building/')) {
      promise = tracked(fetchScene(name))
      buildingLoads.push(promise)
    } else {
      const fetched = buildingGate.then(() => fetchScene(name))
      // speculative warms (runSpeculativeWarm) and explicit background prefetches stay off the pill.
      // The ledger is written here, while the warm flag is set. The fetch itself starts later, once
      // the building gate opens, after the synchronous warm scope has unwound.
      noteSpeculativeFetch(modelUrl(name))
      promise = speculative ? fetched : tracked(fetched)
    }
    cache.set(name, promise)
  }
  return promise
}

/**
 * Register a non-GLB building asset (e.g. a building texture) with the
 * building-first gate: it counts toward the loading indicator, and the gate that
 * holds back other parts won't open until it settles. Lets the building land
 * fully textured before boxes/robots compete for bandwidth. See loadPartModel.
 *
 * `coverOnly` registers it for the cover only, leaving the release gate free: use it for
 * building scenery that must be textured before the reveal but that other parts should not
 * queue behind (the dock-door bay's maps - see the note above the gate).
 */
export function gateBuildingLoad<T>(p: Promise<T>, opts?: { coverOnly?: boolean }): Promise<T> {
  scheduleGateOpen()
  const tp = tracked(p)
  ;(opts?.coverOnly ? coverOnlyLoads : buildingLoads).push(tp)
  return tp
}

/** resolve once every model load requested so far has settled (for offscreen capture) */
export function modelsSettled(): Promise<void> {
  return Promise.allSettled([...cache.values()]).then(() => undefined)
}

/** deep clone with per-instance materials (for selection tint + dispose) */
export function clonePartModel(template: Group): { object: Group; materials: Material[] } {
  const object = template.clone(true)
  const materials: Material[] = []
  object.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = true
    const current = mesh.material
    if (Array.isArray(current)) {
      mesh.material = current.map((mat) => {
        const clone = mat.clone()
        materials.push(clone)
        return clone
      })
    } else {
      const clone = current.clone()
      materials.push(clone)
      mesh.material = clone
    }
  })
  return { object, materials }
}
