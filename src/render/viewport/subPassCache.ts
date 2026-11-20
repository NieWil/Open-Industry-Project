import type { Camera, Object3D, Scene } from 'three'
import type { StandardDrawingPipeline } from 'three/webgpu'
import { bundleStructureEpoch } from '../bundleGroups'
import { hasUrlFlag } from '../urlFlags'

/**
 * Cached projection for the consolidated outline's non-main sub-passes (WebGPU). Default on;
 * `?nopasscache` turns all of it off.
 *
 * These passes (consolidatedOutlineNode: the overlay pass and the selection-mask pass) render with
 * bundles inert, so three's projection walks the full scene graph once per pass per frame even
 * when the output is a handful of meshes (the bundle-children skip exists only on the active-bundle
 * replay path). That cost grows with part count while the output doesn't, and a selection adds two
 * more such passes per frame.
 *
 * The output is independent of camera pose: bundled meshes have frustumCulled=false forced
 * (bundleGroups.flushBundleInvalidation), overlay subtrees force it off at creation, the overlay
 * lights are fixed top-level Scene children (env.ts), and `renderList.push` captures the resolved
 * (object, geometry, material, group) tuple. So a projected list changes only when the draw list does
 * (bundleStructureEpoch; (un)hides must notify anyway or the main-pass bundles would be stale), plus the
 * per-pass churn the caller encodes in `sig` (overlay: visible subtree; mask: scene-activity serial).
 *
 * Mechanism: `_renderScene` calls `drawingPipeline.project(scene, ...)` once at the top level. Bracketed
 * by the caller's begin/end, the patched version either replays the captured `push`/`pushLight` calls
 * into the empty render list without traversing (hit), or runs the stock traversal while capturing them
 * (miss). The stock traversal pushes through `pushRenderItem`, which calls `renderList.push`, so the
 * capture sees every item. A stale sort-depth `z` only affects front-to-back sorting, not correctness;
 * draw-time state is read live, so replayed content still moves. Only list membership is frozen between
 * records.
 *
 * Wraps `project` on the renderer's drawing pipeline instance (three 0.187; the class is marked
 * experimental). If a bump moves it, the brackets no-op and the passes run the stock traversal again: a
 * perf regression, never a rendering bug, so no forced fallback (unlike bundleReplayRefresh).
 * Diagnostics on `globalThis.__oipSubPassCache` ({ records, replays }).
 */

type PushArgs = readonly unknown[]

interface RenderListLike {
  push(...args: unknown[]): void
  pushLight(light: unknown): void
}

interface Projector {
  project(object: Object3D, camera: Camera, groupOrder: number, renderList: RenderListLike, clippingContext: unknown): void
}

interface CacheEntry {
  epoch: number
  sig: string
  scene: Scene
  camera: Camera
  pushes: PushArgs[]
  lights: unknown[]
}

export interface SubPassCacheStats {
  records: number
  replays: number
}

export function wantsSubPassCache(): boolean {
  return !hasUrlFlag('nopasscache')
}

const caches = new Map<string, CacheEntry>()
let activeKey: string | null = null
let activeSig = ''
// One-shot latch: only the first top-level projection inside the bracket is the bracketed pass.
// A nested render can occur inside it (a re-armed frozen shadow map renders in
// ShadowNode.updateBefore), and its projection must run stock, not hit or overwrite the pass
// cache. Recursion during a record (`project` recurses through `this.project`, which is this
// wrapper) is covered by the same latch.
let armed = false
const patched = new WeakSet<object>()
const stats: SubPassCacheStats = { records: 0, replays: 0 }

function ensurePatched(renderer: unknown): boolean {
  const p = (renderer as { drawingPipeline?: StandardDrawingPipeline }).drawingPipeline as Partial<Projector> | undefined
  if (typeof p?.project !== 'function') return false // three moved it: brackets no-op (stock traversal)
  if (patched.has(p)) return true
  patched.add(p)
  const orig = p.project
  p.project = function (this: Projector, object, camera, groupOrder, renderList, clippingContext) {
    if (!armed) {
      orig.call(this, object, camera, groupOrder, renderList, clippingContext)
      return
    }
    armed = false
    const key = activeKey!
    const sig = activeSig
    const epoch = bundleStructureEpoch()
    const cached = caches.get(key)
    if (cached && cached.epoch === epoch && cached.sig === sig && cached.scene === object && cached.camera === camera) {
      for (const p of cached.pushes) renderList.push(...p)
      for (const l of cached.lights) renderList.pushLight(l)
      stats.replays++
      return
    }
    // record: capture this pass's list content while the stock traversal fills it. A nested
    // shadow render inside uses its own render list (keyed scene+shadow camera), so wrapping
    // this list's push/pushLight captures only the bracketed pass's content.
    const pushes: PushArgs[] = []
    const lights: unknown[] = []
    const origPush = renderList.push
    const origPushLight = renderList.pushLight
    renderList.push = function (...args: unknown[]) {
      pushes.push(args)
      origPush.apply(this, args)
    }
    renderList.pushLight = function (light: unknown) {
      lights.push(light)
      origPushLight.call(this, light)
    }
    try {
      orig.call(this, object, camera, groupOrder, renderList, clippingContext)
    } finally {
      renderList.push = origPush
      renderList.pushLight = origPushLight
    }
    caches.set(key, { epoch, sig, scene: object as Scene, camera, pushes, lights })
    stats.records++
  }
  ;(globalThis as Record<string, unknown>).__oipSubPassCache = stats
  return true
}

/**
 * Bracket one sub-pass render. No-ops (stock traversal) when the cache is off or three moved.
 * `sig` is the pass's extra validity key beyond bundleStructureEpoch: any per-frame churn the
 * structural notify seams don't see (empty when the epoch alone is enough).
 */
export function beginPassCapture(renderer: unknown, key: string, sig = ''): void {
  if (!wantsSubPassCache()) return
  if (!ensurePatched(renderer)) return
  activeKey = key
  activeSig = sig
  armed = true
}

export function endPassCapture(): void {
  activeKey = null
  activeSig = ''
  armed = false
}
