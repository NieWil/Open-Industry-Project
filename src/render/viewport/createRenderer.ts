import { WebGLRenderer } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { registerBundleGroupCtor, wantsBundleCameraPatch, wantsRenderBundles } from '../bundleGroups'
import { installGpuErrorWatch } from '../gpuErrorWatch'
import { setWebGPUOutlineFactory } from './outline'
import { installSchedulerYieldShim } from './schedulerYield'
import { setBeltNodeFactory, setScrollNodeFactory, setDeckNodeFactory, setMetalNodeFactory, setTickUniformBump } from '../parts/common'
import { setBeltBankNodeFactory } from '../parts/beltFabricBank'
import { setFloorNodeFactory } from '../parts/building'
import { setLampBankNodeFactory } from '../parts/lampBank'
import { setAnimClockSink } from '../parts/animClock'
import { setGizmoRingNodeFactory } from './gizmo'
import { setFilmNodeFactory } from './filmMaterial'
import { renderQuality, rendererPref } from '../quality'
import { immersiveVRSupported } from './xrSupport'

/**
 * Decide whether to use three.js' WebGPURenderer instead of the WebGLRenderer.
 *
 * - **Default on everywhere, handhelds and Electron included**. Support is never probed here: a
 *   browser with no WebGPU (or no usable GPU) is routed back to WebGL by createWebGPURenderer's
 *   adapter guard plus App.tsx's catch, before the three/webgpu chunk is fetched.
 *
 *   Handhelds were measured (iPhone, iOS 26, demo, editor/bench.ts): 16.7 ms/frame vs WebGL's 23.9,
 *   `cpuMs` 2.30 vs 5.65, GPU 77% vs saturated, and no thermal decay, where WebGL's CPU cost rose 52%
 *   inside a minute (Safari's WebGL2 goes through ANGLE onto Metal; WebGPU maps to Metal directly).
 *   The downside is first load: cover 3965 ms vs 2762, ~430 dropped frames in the first 30 s vs ~98, from
 *   pipeline compilation. That is one-time and mitigated by the staged pre-warm, while the gain is
 *   permanent on the tier with the least headroom.
 *
 * - **A headset declines it** (createWebGPURenderer's guard): WebXR presents through WebGL here
 *   (xr.ts), so a browser with an immersive-vr runtime boots onto WebGL or it has no VR at all.
 *
 * `?webgpu` forces it on anywhere, a headset included (losing its VR button). `?nowebgpu` turns it off
 * and overrides everything (e.g. to avoid a driver bug). The persistent setting is
 * Settings > Graphics > Renderer (quality.ts `rendererPref`), which the URL flags override.
 */
export function wantsWebGPU(): boolean {
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search)
    if (params.has('nowebgpu')) return false // kill-switch, overrides everything
    if (webgpuForced()) return true // explicit opt-in, any surface/tier
  }
  // Settings > Graphics > Renderer: the kill-switch for a surface with no address bar (the installed app)
  if (rendererPref() === 'webgl') return false
  // Default-on everywhere. The mobile render tier applies on this path in full
  // (renderSinglePass), so a handheld gets the same fill-rate savings as on WebGL plus
  // WebGPU's much cheaper submission. Devices without WebGPU fall back at the adapter
  // guard in createWebGPURenderer, before any chunk is fetched.
  return true
}

/** `?webgpu`: the user asked for WebGPU by name, which overrides the headset guard too */
function webgpuForced(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('webgpu')
}

/**
 * Build and initialise a WebGPURenderer. three/webgpu is a second, much larger copy
 * of three (core + node system + GPU backends), so it is dynamically imported here.
 * It is its own chunk, fetched lazily when the flag is set, and never adds to the
 * default WebGL path.
 *
 * The returned renderer is already `init()`-ed, so callers can render with it
 * synchronously. Rejects if WebGPU is unavailable or device acquisition fails; the
 * caller is expected to fall back to WebGL.
 *
 * At feature parity with WebGL. The WebGL-only pieces have WebGPU twins: TSL ports of the floor
 * markings, gizmo ring and conveyor metal (markingNodeMaterial.ts, gizmoRingNodeMaterial.ts,
 * parts/metalNodeMaterial.ts), the wall-shadow rig and selection outline as manual renders in
 * consolidatedOutlineNode.ts, and getStats() reading per-frame `drawCalls`.
 *
 * The mobile render tier (quality.ts) applies here in full: pixel ratio and shadow clamp are
 * renderer-agnostic, `msaaSamples` drives the antialias flag and outline samples, and `singlePass`
 * collapses the overlay sub-pass into the scene pass (consolidatedOutlineNode.renderSinglePass; gate
 * e2e/verify-webgpu-mobile-singlepass.mjs). So `?gfx=low`, the arm device measurements use, is truthful.
 */
export async function createWebGPURenderer(): Promise<WebGPURenderer> {
  // Refuse a software/fallback WebGPU device before doing any real work. On a machine with no
  // usable GPU, Chromium can still return a SwiftShader adapter that "succeeds" but is
  // slower than WebGL, so init() wouldn't fail and App.tsx's catch would never fire. Detect it
  // up front and throw, which routes the caller back to WebGL and skips the large three/webgpu
  // chunk load. Electron defaults to this path too (wantsWebGPU), so a weak or headless machine
  // must degrade to WebGL, not to a slow software renderer.
  // Before any three/webgpu code runs: give `yieldToMain` a real yield on browsers without
  // `scheduler.yield` (Safari). Without it the staged pre-warm waits a frame per node build,
  // measured at +7.4 s of pure frame-waiting on an otherwise identical load. See schedulerYield.ts.
  installSchedulerYieldShim()

  const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined
  if (!gpu) throw new Error('[oip] WebGPU unavailable (no navigator.gpu) - falling back to WebGL')
  // A headset needs WebGL: WebXR presents through it (xr.ts), and three's WebGPU XR path needs an
  // XRGPUBinding and an XR-compatible device requested at init, and headset browsers can't be relied on
  // for either. Asked alongside the adapter so it adds no wall time on a machine that answers inside
  // the probe budget (xrSupport.ts). When headsets ship that binding, this is the line to revisit.
  const [adapter, headset] = await Promise.all([
    gpu.requestAdapter(),
    webgpuForced() ? Promise.resolve(false) : immersiveVRSupported(),
  ])
  if (headset) throw new Error('[oip] immersive VR runtime present: WebXR needs the WebGL renderer, preferring it (?webgpu overrides)')
  if (!adapter) throw new Error('[oip] WebGPU unavailable (no adapter) - falling back to WebGL')
  if (adapter.info?.isFallbackAdapter) {
    throw new Error('[oip] WebGPU only via a software fallback adapter - preferring WebGL')
  }

  // ---- one parallel round of chunk loads, not thirteen serial ones ---------------------------
  // Don't `await import()` these in sequence. Each request would wait on the previous response: ~5 s
  // of pure round-trip latency for ~15 KB of code on a throttled link, with the view mount (and the
  // loading cover behind it) waiting the whole time (rendererBootParallel.test.ts). They are independent
  // modules. Only their install order matters, and that is preserved below. They stay dynamic imports
  // so none of this reaches the WebGL bundle.
  //
  // Loaded before the device exists, so a chunk failure here throws with no renderer to leak. If
  // renderer.init() later fails, ~15 KB of factories the WebGL fallback won't use were downloaded,
  // which is small next to 5 s of serialised latency.
  const wantsBundleCam = wantsRenderBundles() && wantsBundleCameraPatch()
  const [
    { WebGPURenderer, BundleGroup },
    { installProjectionStats },
    bundleRefreshMod,
    { createWebGPUConsolidatedOutline },
    { bumpTickUniformGroup },
    { createMetalNodeMaterial },
    { createBeltNodeMaterial },
    { createDeckNodeMaterial },
    { createBeltBankNodeMaterial },
    { createLampBankNodeMaterial },
    { setAnimClockNode },
    { createScrollNodeMaterial },
    { createGizmoRingNodeMaterial },
    { createFilmNodeMaterial },
    { createFloorNodeMaterial },
  ] = await Promise.all([
    import('three/webgpu'),
    import('./projectionStats'),
    wantsBundleCam ? import('./bundleReplayRefresh') : Promise.resolve(null),
    import('./consolidatedOutlineNode'),
    import('../parts/tickUniformGroup'),
    import('../parts/metalNodeMaterial'),
    import('../parts/beltNodeMaterial'),
    import('../parts/deckNodeMaterial'),
    import('../parts/beltFabricBankNodeMaterial'),
    import('../parts/lampBankNodeMaterial'),
    import('../parts/animClockNode'),
    import('../parts/scrollNodeMaterial'),
    import('../gizmoRingNodeMaterial'),
    import('./filmNodeMaterial'),
    import('../parts/floorNodeMaterial'),
  ])
  // render bundles (bundleGroups.ts, default on; `?nobundle` turns them off): hand the module three's
  // BundleGroup so the scene containers built by RenderView/InstancePoolManager (both
  // constructed after this resolves) become bundle-capable. Never registered on the WebGL
  // path, so the gate stays inert there.
  if (wantsRenderBundles()) registerBundleGroupCtor(BundleGroup)
  // trackTimestamp arms per-pass GPU timestamp queries (the device requests the feature when
  // available) so the stats HUD can show real GPU frame time next to cpu (view.getStats().gpuMs).
  // Writing two timestamps per pass costs almost nothing; the resolve happens off-frame in view.tick.
  // antialias from the tier, like the WebGL path: the mobile preset turns MSAA off, and a phone
  // measured 4x at -17% frame time for antialiasing at 1.5 DPR (see quality.ts msaaSamples).
  const renderer = new WebGPURenderer({ antialias: renderQuality.msaaSamples > 0, trackTimestamp: true })
  await renderer.init()
  // An adapter is not a device. When requestDevice fails (a driver refusing it; Playwright's headless shell, which
  // ships no dxil.dll), init() does not throw: three quietly runs this renderer on its WebGL2 backend. Nothing here
  // is built for that pairing. The view keys its WebGL handling on `instanceof WebGLRenderer`, so it runs the
  // staged pre-warm and deferred warms written for Dawn, whose compiles finish in the background. On this backend
  // every one of them links synchronously: the demo froze 7.1 s after load and ~2 s mid-run. Prefer
  // the real WebGL renderer, as for a software adapter above.
  if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
    renderer.dispose()
    throw new Error('[oip] WebGPU device unavailable (three fell back to its WebGL2 backend) - preferring the WebGL renderer')
  }
  // A GPU validation error never throws. The device fires `uncapturederror`, three logs it,
  // and the frame is silently wrong (a render bundle replaying a freed buffer blanks the whole main
  // pass). Watching the device makes that failure reportable: one deduped `[oip]` error, plus a
  // tally the e2e gates assert is empty. See gpuErrorWatch.ts.
  installGpuErrorWatch((renderer.backend as { device?: unknown } | undefined)?.device)
  // Per-pass projection visit counters on globalThis.__oipProjStats: shows which render pass
  // incurs the scene-graph traversal cost (sub-passes run with bundles inert, so they walk the
  // full graph). About one counter increment per visited node.
  installProjectionStats(renderer)
  // Bundle camera handling (default-on with bundles): camera moves refresh the replayed render
  // bundles' shared uniform groups instead of re-recording, so orbiting doesn't push draw calls
  // back onto the encode path. See bundleReplayRefresh.ts for the mechanism. `?nobundlecam`
  // re-records on camera moves instead. Inert under `?nobundle`.
  if (bundleRefreshMod) bundleRefreshMod.installBundleReplayRefresh(renderer)
  try {
    // the selection outline needs the node-based post-processing variant under WebGPU (its
    // EffectComposer is WebGL-only). Registered now, before RenderView builds it. Its chunk is part
    // of the parallel load above, so it stays out of the default WebGL bundle.
    setWebGPUOutlineFactory(createWebGPUConsolidatedOutline)
    // the shared TICK uniform group's version bump (tickUniformGroup.ts): the belt/chain/spin
    // tick seams call markTickUniformsAdvanced when they wrote a ticking uniform, keeping the
    // stock shared-group version gate open on non-replay paths. No-op on the WebGL path.
    setTickUniformBump(bumpTickUniformGroup)
    setMetalNodeFactory(createMetalNodeMaterial)
    setBeltNodeFactory(createBeltNodeMaterial)
    setDeckNodeFactory(createDeckNodeMaterial)
    setFloorNodeFactory(createFloorNodeMaterial)
    setBeltBankNodeFactory(createBeltBankNodeMaterial)
    setLampBankNodeFactory(createLampBankNodeMaterial)
    // The shared sim-animation clock every shader-integrated animation reads (animClock.ts: belt
    // scroll, roller spin). On WebGL it is a plain shader uniform owned by that module. On WebGPU it
    // must be in the TICK uniform group, so the value is pushed through this sink. The sink also
    // bumps the group, since a stock (non-replay) path only uploads a shared group when its version
    // changed. WebGL has no uniform groups, so no bump there.
    setAnimClockSink((v) => {
      setAnimClockNode(v)
      bumpTickUniformGroup()
    })
    setScrollNodeFactory(createScrollNodeMaterial)
    setGizmoRingNodeFactory(createGizmoRingNodeMaterial)
    setFilmNodeFactory(createFilmNodeMaterial)
  } catch (err) {
    // a factory registration threw after device init: release the GPU device before the caller
    // falls back to WebGL, or the initialised renderer would leak. Any factories already
    // registered stay inert, since webgpuNodeFactory gates them on the render-mode flag, which only a
    // successfully-mounted WebGPU RenderView sets. Chunk-load failures can't reach this catch,
    // because they reject before the device is created.
    renderer.dispose()
    throw err
  }
  return renderer
}

/** convenience: a plain WebGLRenderer with the editor's standard options */
export function createWebGLRenderer(): WebGLRenderer {
  return new WebGLRenderer({ antialias: true })
}
