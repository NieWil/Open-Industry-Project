// Render-pipeline pre-warm for the view: the first-load staged compile, the
// per-add (pumpWarm) and scene-load (compileSwap) warms, the bulk-reveal budget, the interaction extras.

import { Group, Vector3, WebGLRenderer } from 'three'
import type { Object3D } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { PartInstance } from '../../core/types'
import { notifyBundleStructureChanged } from '../bundleGroups'
import { setLoadStage, signalScenePainted, whenCoverHidden } from '../renderReady'
import { assetsBusy, runSpeculativeWarm, whenAssetsQuiet, whenBuildingReady } from '../gltf'
import { createPartVisual } from '../parts/registry'
import { metalWarmProbe } from '../metalEnvironment'
import type { RenderView } from './view'
import {
  REVEAL_BUDGET_POINTS,
  PREWARM_COVER_CAP_MS,
  DEFERRED_WARM_TIMEOUT_MS,
  wantsDeferredWarm,
  revealCostOf,
} from './viewWarmFlags'
import { markCompilePhase, recordLiveMint, cacheSizeOf, markCompileCount, markPipelineTimes } from './viewCompileLedger'

/**
 * The pipeline-warm machinery's own state: which parts are held hidden while their pipelines warm, the
 * queues that release them, per-kind warmth, and the load/compile flags. RenderView holds one (`view.warm`).
 */
export class ViewWarmState {
  stagedReveal = false // hold the last painted frame while a scene swap's pipelines compile
  // WebGPU incremental pipeline pre-warm (see pumpWarm). A part added after the initial load (duplicate,
  // catalog place, paste, undo) mints fresh meshes whose render pipelines three compiles cold on the next
  // draw - a synchronous ~250ms–1s+ stall on the draw path (worse for procedural parts: roller conveyor,
  // platform). compileStaged fixes this at load but only runs once; these keep a freshly-added part hidden,
  // compile its pipelines off the draw path (loop stays live), then reveal it warm.
  incrementalWarmReady = false // true once the initial load compile settled (don't fight compileStaged)
  extrasWarmed = false // re-entry guard: set when warmInteractionExtras starts
  // set when it finishes (or fails). Distinct from extrasWarmed - the gap between the two
  // is the window in which a first select/grab/measure can still hitch, so tests need to read
  // completion, not entry (e2e/probes/deferred-warm-timing.mjs).
  extrasWarmDone = false
  readonly warming = new Set<string>() // part ids held hidden while their pipelines warm
  readonly warmQueue = new Set<string>() // part ids awaiting a warm pass
  warmPumping = false // one drain loop at a time
  // Per-kind pipeline warmth (key = partKindKey). Render pipelines are program+state-keyed and
  // shared across every part of a kind (three names a uniform buffer per shader, not per object), so warmth
  // is a property of the kind, not the part entry: once a kind has compiled - at load
  // (compileStaged), on hover (warmPart's pipeline tier), or via a first add's pumpWarm - later
  // adds of that kind skip the hidden warm-hold entirely and reveal on the next frame. This is
  // what keeps a bulk Shift+drag duplicate from trickling into visibility one clone at a time.
  // A package edit / hot reload revokes its kind (refreshPackage): the rebuilt meshes may need
  // new pipelines. Kind-level warmth is a proxy - a param that swaps material variants can still
  // be cold under a warm kind - so being wrong costs one on-draw compile, never a stale visual.
  readonly kindWarm = new Set<string>()
  // Warm-kind parts added in bulk (Shift+drag / Ctrl+D duplicate of a big selection) whose reveal
  // exceeded the sync's REVEAL_BUDGET_POINTS: held hidden (via `warming`) and revealed a budget's
  // worth per frame by drainRevealQueue, so the per-object first-draw setup can't pile into one
  // 500ms+ frame. Order = scene order (insertion).
  readonly revealQueue = new Set<string>()
  // whenPartsRevealed callers, settled by the frame loop once `warming` empties (flushRevealWaiters)
  revealWaiters: (() => void)[] = []
  // A scene load's held parts, awaiting one whole-scene compile (compileSwap) instead of pumpWarm's
  // kind-at-a-time drain. Each id is also in `warming` until that compile releases it.
  readonly swapQueue = new Set<string>()
  swapCompiling = false
  // Serialises every WebGPU compileAsync: two overlapping calls corrupt each other (inCompileLane).
  compileLane: Promise<void> = Promise.resolve()
  // parts whose assets have already been hover-warmed this session (see warmPart) - one build per
  // (type, packageId) is enough since the durable caches it fills are content-addressed and permanent.
  readonly warmed = new Set<string>()
  // parts whose WebGPU render pipeline has been hover-warmed (a superset step over `warmed`, WebGPU-only).
  readonly pipelineWarmed = new Set<string>()
}

/** what the warm machinery reaches on the view beyond its own {@link ViewWarmState} */
export type WarmHost = Pick<
  RenderView,
  | 'boxes'
  | 'camera'
  | 'compileSwap'
  | 'disposed'
  | 'entries'
  | 'gizmo'
  | 'handles'
  | 'instancePool'
  | 'intendedVisible'
  | 'maskMerge'
  | 'outline'
  | 'outlineState'
  | 'overlays'
  | 'poolRebuild'
  | 'refreshOutline'
  | 'renderer'
  | 'scene'
  | 'showVertexMarkers'
  | 'shownOnceReleased'
  | 'tickSerial'
  | 'vsnap'
  | 'warm'
>

/**
 * Start the WebGPU pipeline pre-warm that holds the first-load cover (the view's constructor calls this,
 * WebGPU only).
 *
 * First-paint signal for the loading cover (renderReady.ts). WebGL compiles on first draw, so its
 * loop signals after frame one; WebGPU compiles pipelines lazily (frames render black meanwhile), so
 * they are pre-warmed before signalling. compileStaged does it building-first + parts-concurrent
 * (~2-3x sooner, see its doc); ?serialcompile forces the stock whole-scene compile (A-B baseline).
 *
 * The cover lifts when the whole staged compile settles, not after phase 1. Signalling after phase 1
 * would fade the cover onto a frozen building-with-no-parts frame, with parts snapping in ~0.5 s later
 * (474-577 ms on the demo). Waiting that half second is better than showing a half-built scene.
 */
export function startStagedPrewarm(view: WarmHost, gpu: WebGPURenderer): void {
  const forceSerial = typeof location !== 'undefined' && new URLSearchParams(location.search).has('serialcompile')
  const compile = forceSerial
    ? () => compileSerial(view, gpu) // ?serialcompile: stock whole-scene compileAsync (A-B baseline)
    : () => compileStaged(view, gpu)
  // The pre-warm is a pure optimisation over three's always-correct on-draw compile, so it must
  // never be able to strand the cover: if it wedges, lift anyway and let pipelines compile on
  // first draw. Armed only once the building is ready, since whenBuildingReady carries its own
  // (20 s) cap and this bounds the compile alone.
  let coverCap: ReturnType<typeof setTimeout> | undefined
  // arm incremental warm only after the initial compile settles, so pumpWarm's hide/reveal never
  // fights compileStaged's own staging of the load-time parts
  void whenBuildingReady()
    .then(() => {
      coverCap = setTimeout(() => {
        console.warn('[oip] pipeline pre-warm exceeded its cover cap; lifting onto a still-warming scene')
        signalScenePainted()
      }, PREWARM_COVER_CAP_MS)
    })
    .then(compile)
    .then(() => {
      // the staged load compile covered every kind in the scene - register them warm, so a
      // later add of an already-loaded kind (duplicate/paste/undo) skips the warm-hold
      for (const entry of view.entries.values()) view.warm.kindWarm.add(partKindKey(entry.part))
    })
    .catch((err) => {
      // degraded, not broken: pipelines compile on first draw instead. Log it: a silent
      // swallow here can hide a "parts stuck hidden" load race (see compileStaged).
      console.warn('[oip] staged pipeline pre-warm failed; falling back to on-draw compile', err)
    })
    .finally(() => {
      clearTimeout(coverCap)
      view.warm.incrementalWarmReady = true
      // one signal for every outcome - success, the nothing-to-warm early return, or a throw
      signalScenePainted()
      // The interaction extras (gizmo handles, drag-eject sources, resize sprites, ruler, vertex
      // markers, outline mask) are not needed to show the scene, so they don't gate the cover.
      // Warm them on idle, behind the live scene, once the cover has faded out. Waiting only for
      // signalScenePainted is not enough: the fade starts two rAF after that signal, so idle
      // falls inside it. requestIdleCallback where available, with a timeout so a permanently
      // busy main thread still warms them before the user can plausibly interact; a plain timeout
      // on Safari, which has no rIC.
      // (this whole chain is inside the WebGPU branch - the WebGL surface schedules its own
      // interaction warm from its first painted frame instead; see scheduleWebGLInteractionWarm)
      if (wantsDeferredWarm()) {
        const run = (): void => {
          void warmInteractionExtras(view, gpu).catch((err) => {
            // same contract as the staged warm: degraded, not broken - these compile on first use
            console.warn('[oip] deferred interaction pre-warm failed; falling back to on-draw compile', err)
          })
        }
        // …and only once the cover is gone, not merely once the scene is painted. Idle arrives
        // instantly here (the scene has settled), and signalScenePainted fires two rAF before
        // the fade starts. Scheduling off the paint would put this 170-195 ms of NodeBuilder codegen
        // inside the 0.4 s fade, freezing it at ~0.9 opacity and snapping it to 0
        // (e2e/probes/cover-fade.mjs). Capped in whenCoverHidden, so a surface without the cover
        // component still warms.
        void whenCoverHidden()
          .then(() => {
            if (view.disposed) return
            const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback
            if (ric) ric(run, { timeout: DEFERRED_WARM_TIMEOUT_MS })
            else setTimeout(run, 200)
          })
          .catch((e: unknown) => console.warn('[oip] deferred warm failed to start', e))
      }
    })
}

/**
 * WebGPU incremental pipeline pre-warm for parts added after load. Without it the next draw compiles
 * the part's pipelines cold on the draw path (~250 ms for a roller conveyor to ~1 s+ for a platform).
 * Same fix as compileStaged, incremental: the part is held hidden (syncScene skips `warming` ids),
 * compiled off the draw path, then revealed warm.
 *
 * First-of-kind only (kindWarm): pipelines are shared per kind, so a duplicate/paste/undo-add of a
 * warm kind reveals on the next frame. Within a drain, the first of a kind compiles and the rest reveal.
 *
 * The loop stays live during the compile. Safe because compileAsync restores every shared renderer
 * field (nodeFrame.renderId, render context, object functions) synchronously before awaiting Dawn, and
 * projects the scene (reading .visible) synchronously at call time, so hiding the part right after
 * the call can't un-schedule the compile, yet the live loop never draws it cold.
 *
 * Scoped: `compileAsync(partObject, camera, view.scene)` projects only that subtree while taking lights
 * + cache context from the real scene. A whole-scene compile re-runs synchronous codegen for every warm
 * part (a cheap GLB part goes from ~50 ms to ~330 ms).
 */
export async function pumpWarm(view: WarmHost): Promise<void> {
  if (view.warm.warmPumping || view.renderer instanceof WebGLRenderer) return
  const gpu = view.renderer
  view.warm.warmPumping = true
  try {
    for (const id of view.warm.warmQueue) {
      if (view.disposed) break
      view.warm.warmQueue.delete(id)
      const entry0 = view.entries.get(id)
      const obj = entry0?.visual.object
      // skip the compile when the kind is already warm - it became warm earlier in this drain
      // (a batch of same-kind parts queued together: the first compiles, the rest just reveal)
      // or via a hover warm that landed while this id was queued
      const kind = entry0 ? partKindKey(entry0.part) : null
      if (obj && kind !== null && !view.warm.kindWarm.has(kind)) {
        try {
          // in the compile lane: two overlapping compileAsync calls corrupt each other (inCompileLane)
          await inCompileLane(view, () => {
            obj.visible = true // reveal for compileAsync's synchronous projection…
            const warm = gpu.compileAsync(obj, view.camera, view.scene) // …captured synchronously (scoped to this part)…
            obj.visible = false // …then hidden before any live frame draws it cold
            return warm
          })
          view.warm.kindWarm.add(kind) // compiled clean → later adds of this kind skip the hold outright
        } catch { /* compile failed: fall through and reveal; the draw path recompiles */ }
      }
      // reveal at intended visibility (recomputed: it may have been hidden/removed mid-warm)
      view.warm.warming.delete(id)
      const entry = view.entries.get(id)
      if (entry) {
        entry.visual.object.visible = view.intendedVisible(entry)
        notifyBundleStructureChanged() // warm-hold reveal happens outside syncScene's visibility seam
      }
    }
  } finally {
    view.warm.warmPumping = false
    // The reveals above changed pool eligibility (warming parts are held root-invisible, so the
    // load/add-time rebuild saw nothing to pool). Re-pool now: the selection-path rebuild is
    // exempt-key-gated and would never catch this.
    view.poolRebuild()
    // held ids are excluded from the outline set (refreshOutline) while warming - re-derive it
    // now the reveals landed, so a selected freshly-warmed part gains its outline
    view.refreshOutline(true)
  }
}

/**
 * The pipeline warm for a scene load (a tab, the demo, Open), done like compileStaged phase 2.
 * pumpWarm is for one part added live. Taking a load's ~200 adds that way would make default scene -> Demo
 * assemble for ~6 s (e2e/probes/scene-swap-popin.mjs).
 *
 * Here: one whole-scene compile, held parts revealed only for its
 * synchronous projection, and the draw parked until it finishes. Measured (msedge, real WebGPU, three
 * rounds vs `?serialswap`): cover at 3.0-3.25 s vs 5.4-5.9 s. Open question: on another workstation
 * the serial arm read ~2.2 s, ~0.9 s faster than this path, for reasons not yet known.
 * Re-run `node e2e/probes/scene-swap-popin.mjs --rounds=3` on a real WebGPU adapter before acting.
 *
 * Why parking matters: the compile is main-thread codegen (~1.2 s over 508 items vs ~0.11 s of Dawn
 * await). With the loop drawing, three's per-item yield runs a frame in every gap, which
 * costs more than the compile itself. Item count matters too: one cargo copy per kind (below) cuts 862
 * items to 508.
 *
 * It runs in the compile lane because the deferred interaction warm (first idle after the cover) really
 * can overlap it.
 */
export async function compileSwap(view: WarmHost): Promise<void> {
  if (view.warm.swapCompiling || view.renderer instanceof WebGLRenderer) return
  const gpu = view.renderer
  view.warm.swapCompiling = true
  let ids: string[] = []
  try {
    // The swap cover goes up in a microtask after the sync that queued this. Let it paint before
    // feeding Dawn: a compile burst stalls presentation outright, and a cover that arrives after the
    // stall has hidden nothing (announce, paint, then work: LoadStage in renderReady.ts).
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    // Compile a complete scene, the same wait compileStaged makes between its phases: a rig's GLB
    // links attach asynchronously, and one not attached yet would mint its pipelines on the first
    // frame that draws it. Skipped when nothing is in flight (the quiet signal waits its own window).
    if (assetsBusy()) await whenAssetsQuiet()
    if (view.disposed) return
    // a second load during the waits above is folded into this batch; one after this line re-kicks
    ids = [...view.warm.swapQueue]
    view.warm.swapQueue.clear()
    let compiled = false
    await inCompileLane(view, async () => {
      // Park the draw for the compile, as compileStaged's phase 2 does. The compile is main-thread
      // codegen, not GPU work (measured on the demo swap: ~0.1 s of Dawn await against ~1.2 s of
      // build), and three yields to the main thread after every item, so a live loop draws a frame
      // in each gap: ~1230 live pipeline lookups competing with the codegen for a canvas the swap
      // cover is hiding anyway. The canvas keeps its last frame; flushRevealWaiters still runs.
      const parked = view.warm.stagedReveal
      view.warm.stagedReveal = true
      // Reveal the held parts for the projection. Every one that draws is compiled, so its per-object
      // codegen happens here rather than on the frame that reveals it. A part that never draws on its
      // own (cargo, which renders through the instanced batch; a user-hidden part) is compiled once
      // per kind, the dedup pumpWarm applies. That one copy registers the kind warm; without it every
      // later load of the scene still has a cold kind and pulls all of its warm parts into a full
      // batch. Compiling every copy would be codegen nothing ever draws.
      const shown: Object3D[] = []
      const hiddenKinds = new Set<string>()
      for (const id of ids) {
        const entry = view.entries.get(id)
        const obj = entry?.visual.object
        if (!entry || !obj || obj.visible) continue
        if (!view.shownOnceReleased(entry)) {
          const kind = partKindKey(entry.part)
          if (hiddenKinds.has(kind) || view.warm.kindWarm.has(kind)) continue
          hiddenKinds.add(kind)
        }
        obj.visible = true
        shown.push(obj)
      }
      // withCompileLedgerNow calls `fn` before its first await and compileAsync projects before
      // its first await, so the projection is captured by the time this returns...
      const warm = withCompileLedgerNow(view, gpu, () => gpu.compileAsync(view.scene, view.camera), 'swap')
      for (const obj of shown) obj.visible = false // ...and hiding them again cannot un-schedule it
      try {
        await warm
        compiled = true
      } catch (err) {
        // degraded, not broken: the release below reveals them and the draw path compiles them
        console.warn('[oip] scene-load pipeline warm failed; falling back to on-draw compile', err)
      } finally {
        view.warm.stagedReveal = parked // always resume the loop, even if the compile threw
      }
    })
    // compiled clean -> later adds of these kinds skip the warm-hold, as after pumpWarm
    if (compiled) {
      for (const id of ids) {
        const entry = view.entries.get(id)
        if (entry) view.warm.kindWarm.add(partKindKey(entry.part))
      }
    }
  } finally {
    view.warm.swapCompiling = false
    if (!view.disposed && ids.length > 0) {
      // release the whole batch at once, at intended visibility (it may have been hidden meanwhile)
      for (const id of ids) {
        view.warm.warming.delete(id)
        const entry = view.entries.get(id)
        if (entry) entry.visual.object.visible = view.intendedVisible(entry)
      }
      notifyBundleStructureChanged() // reveals happen outside syncScene's visibility seam
      // held parts were root-invisible when the load's own rebuild ran, so nothing of theirs is
      // pooled yet, and held ids sit outside the outline set: re-derive both (pumpWarm's `finally`)
      view.poolRebuild()
      view.refreshOutline(true)
    }
    if (!view.disposed && view.warm.swapQueue.size > 0) void view.compileSwap()
  }
}

/**
 * Run `fn` once every earlier compile in the lane has settled (see compileLane). Every WebGPU
 * compileAsync goes through the lane: three 0.187 keeps a compile's state (`_precompilationState`, the
 * render context and target) on the renderer while it waits on a node build, so a second call started
 * then overwrites it and the first throws on resume ("Cannot destructure property 'useFrameBufferTarget'").
 */
export function inCompileLane<T>(view: WarmHost, fn: () => Promise<T>): Promise<T> {
  const run = view.warm.compileLane.then(fn, fn)
  view.warm.compileLane = run.then(
    () => {},
    () => {},
  )
  return run
}

/**
 * Frame-budgeted reveal of bulk-added warm-kind parts (the syncScene overflow of
 * REVEAL_BUDGET_POINTS). Called once per frame from the render loop: reveals a budget's worth of
 * held clones each frame so their per-object first-draw setup (node codegen/cacheKey, bind
 * groups, first uploads - ~2-3 ms per fresh mesh) spreads across a few ~70 ms frames instead of
 * piling into one 500 ms+ freeze. The stagger is visually silent for a duplicate: clones stage
 * stacked exactly on their originals, so the held frames render pixel-identical.
 *
 * A held id whose entry vanished mid-stagger (undo, Shift+drag cancel reverting the transient)
 * is dropped without spending budget. Pool re-bake + outline re-derivation run in the same JS
 * turn as every reveal batch. The revealed parts' instanced banks fold straight into the merged
 * pool banks (grouped with their originals' twins) before any frame can draw them individually,
 * so a bank-heavy clone's reveal doesn't repeat per-bank codegen ×3 passes.
 */
export function drainRevealQueue(view: WarmHost): void {
  if (view.warm.revealQueue.size === 0) return
  let budget = REVEAL_BUDGET_POINTS
  let revealed = false
  for (const id of view.warm.revealQueue) {
    if (budget <= 0) break
    view.warm.revealQueue.delete(id)
    view.warm.warming.delete(id)
    const entry = view.entries.get(id)
    if (!entry) continue // removed while held (undo / drag cancel)
    budget -= revealCostOf(entry.visual.object)
    const vis = view.intendedVisible(entry)
    if (entry.visual.object.visible !== vis) {
      entry.visual.object.visible = vis
      revealed = true
    }
  }
  if (revealed) {
    // reveals happen outside syncScene's visibility seam → the bundle draw list moved
    notifyBundleStructureChanged()
    view.poolRebuild()
    // a duplicate selects its clones, and held ids are excluded from the outline set - re-derive
    // it as they land (the sig-gated refresh won't re-fire: selection/structureRev didn't move)
    view.refreshOutline(true)
  }
}

/**
 * Settle whenPartsRevealed once nothing is held. Run from the frame loop rather than from each
 * release site: `warming` shrinks in pumpWarm's async drain, in drainRevealQueue, and when a held
 * part is removed mid-hold, and one per-frame check covers all three without having to find them.
 */
export function flushRevealWaiters(view: WarmHost): void {
  if (view.warm.revealWaiters.length === 0 || view.warm.warming.size > 0) return
  const waiters = view.warm.revealWaiters
  view.warm.revealWaiters = []
  for (const resolve of waiters) resolve()
}

/** warmth key: pipelines are shared per (type, packageId) - see kindWarm / warmed / pipelineWarmed */
export function partKindKey(part: PartInstance): string {
  return part.type === 'part' ? `part:${part.packageId}` : part.type
}

/**
 * Preload a catalog part on hover. Two tiers, both keyed by (type, packageId) so each fires once/session:
 *  - Assets (always): build the visual detached for its side effect, kicking off the same lazy
 *    GLB/texture/geometry loads a placement would (filling the module caches). No reference is kept:
 *    a never-drawn object holds no GPU resources, and detached it touches no partsGroup, pool or staging.
 *  - Pipeline (WebGPU, opts.pipeline): also compileAsync the detached visual, giving a heavy
 *    first-of-kind pipeline (the belt's ~400 ms fabric shader) the whole hover->drag window instead of
 *    pumpWarm holding the staged preview hidden. three's pipeline cache is program+state-keyed, not
 *    object-keyed, so it survives the throwaway visual; compileAsync captures its projection
 *    synchronously, so discarding the object can't un-schedule it.
 * Measured (e2e/probes/commit-shadow-hitch.mjs): the residual cold spots are ≤1 frame - GLB parts
 * compile only their placeholder at hover yet draw warm (standard-material pipelines are shared), and
 * the commit-time castShadow restore costs ~10 ms once (post-commit gap 34 -> 25 ms without it). Don't
 * add a swap-recompile or a shadow warm without re-measuring. runSpeculativeWarm keeps these fetches
 * off the "Loading models…" pill.
 */
export function warmPart(view: WarmHost, part: PartInstance, opts?: { pipeline?: boolean }): void {
  const key = partKindKey(part)
  const assetsFresh = !view.warm.warmed.has(key)
  // don't warm pipelines before the initial load compile settles (compileStaged owns the GPU then). WebGPU
  // only: WebGL shares one program across identical parts, so its first placement never cold-compiles a
  // fresh pipeline.
  const warmPipeline =
    opts?.pipeline === true &&
    !view.warm.pipelineWarmed.has(key) &&
    !(view.renderer instanceof WebGLRenderer) &&
    view.warm.incrementalWarmReady
  if (!assetsFresh && !warmPipeline) return // both tiers already done for this kind
  if (assetsFresh) view.warm.warmed.add(key)
  if (warmPipeline) view.warm.pipelineWarmed.add(key)
  try {
    runSpeculativeWarm(() => {
      const visual = createPartVisual(part)
      // on completion the kind's pipelines sit in the shared cache → register kind warmth, so a
      // subsequent ADD of this kind (the hovered part being placed, duplicates) skips the warm-hold
      if (warmPipeline) {
        // the projection happens when the lane reaches this call; the detached visual needs no reveal
        void inCompileLane(view, async () => {
          await view.renderer.compileAsync(visual.object, view.camera, view.scene)
        })
          .then(() => { view.warm.kindWarm.add(key) })
          .catch(() => {})
      }
    })
  } catch {
    // a build hiccup must never break hovering; let the real placement surface any genuine error
    if (assetsFresh) view.warm.warmed.delete(key)
    if (warmPipeline) view.warm.pipelineWarmed.delete(key)
  }
}

/**
 * Queue {@link warmInteractionExtrasWebGL} for the next idle moment (a timeout on Safari, which has
 * no requestIdleCallback), with a deadline so a permanently busy main thread still warms before the
 * user can plausibly click. Mirrors the WebGPU deferral; the mobile tier opts out of both (wantsDeferredWarm).
 */
export function scheduleWebGLInteractionWarm(view: WarmHost): void {
  if (!wantsDeferredWarm()) return
  const run = (): void => {
    void warmInteractionExtrasWebGL(view).catch((err) => {
      console.warn('[oip] deferred interaction pre-warm failed; falling back to on-draw compile', err)
    })
  }
  // same rule as the WebGPU twin: wait for the cover to be gone, not just painted, so this never
  // competes with its fade (see whenCoverHidden)
  void whenCoverHidden()
    .then(() => {
      if (view.disposed) return
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback
      if (ric) ric(run, { timeout: DEFERRED_WARM_TIMEOUT_MS })
      else setTimeout(run, 200)
    })
    .catch((e: unknown) => console.warn('[oip] deferred warm failed to start', e))
}

/**
 * WebGPU first-paint: pre-warm the render pipelines before the loading cover lifts so the scene
 * never fades onto a black, still-compiling frame, in two phases that reach an interactive scene
 * ~2-3x sooner than one whole-scene compile:
 *
 *  1. Building first. three's drawingPipeline.project skips visible=false subtrees, so hide every non-
 *     building part and compileAsync only the building shell + env: heavy shared pipelines first.
 *  2. Parts. Reveal the parts and compile them. The loop is held (stagedReveal) until they're warm
 *     so no frame draws an un-compiled pipeline, which the render path would compile synchronously
 *     (a hitch).
 *
 * Both phases are three's own compileAsync, which keeps up to 16 pipelines in flight (three 0.187),
 * recorded in the compile ledger by withCompileLedger.
 *
 * Where the cover goes is measured by e2e/probes/compile-phases.mjs, and the phases have opposite
 * shapes: phase 1 is mostly waiting on Dawn for a few heavy building shaders (only fewer or cheaper
 * building materials move it); phase 2 is mostly main-thread codegen per item (only fewer items or
 * less NodeBuilderState work move it). Size codegen savings from e2e/probes/codegen-attribution.mjs,
 * not nodebuilder-census.mjs: most redundancy sits in object-level keys (`object.uuid`, `context.id`)
 * that three keys per object, and the per-instance rest is by design (rig.ts mints a material per
 * part; see renderIdentityKey in instancePool.ts). Codegen is paid on every visit, since Dawn's
 * disk cache holds pipelines, not the JS emitting WGSL (e2e/probes/codegen-warm.mjs).
 *
 * Pipeline cost has two regimes (markPipelineTimes): wall time per pipeline with many in flight sizes
 * how long a phase waits; isolated time under `?serialcompile` sizes total compile work. Most pipelines
 * are minted by live draws, not the pre-warm (recordLiveMint: the shadow pass's ShadowMaterial, building
 * materials attaching after projection), but all of them are pool load, so the floor is total pipeline
 * work / pool width: no scheduling change can move it, only fewer or cheaper distinct pipelines.
 * three's per-item `yieldToMain` is cheap with `scheduler.yield()`, a whole frame per item without it
 * (schedulerYield.ts).
 *
 * The cover lifts when both phases have settled (see startStagedPrewarm). A pure optimisation over
 * three's always-correct on-draw compile: if a phase throws, parts compile lazily on first draw - less
 * smooth, never broken. See e2e/webgpu-smoke.mjs (correctness), perf-webgpu-load.mjs +
 * e2e/probes/compile-phases.mjs (timing); ?serialcompile forces the stock one-shot compile.
 */
export async function compileStaged(view: WarmHost, gpu: WebGPURenderer): Promise<void> {
  // defer set = every currently-visible, non-building part (cargo/user-hidden are already invisible)
  const deferred: Object3D[] = []
  for (const entry of view.entries.values()) {
    if (entry.part.type === 'building') continue
    const obj = entry.visual.object
    if (!obj.visible) continue
    obj.visible = false
    deferred.push(obj)
  }
  // cargo (boxes/pallets) renders through the standalone instanced SimBoxes batch, not a part entry,
  // so defer it too - else it compiles + appears with the building in phase 1, floating before the
  // conveyors it rests on arrive in phase 2. (Its per-part visuals are already hidden; this is the
  // batch - hide its stable group, since a capacity grow can re-mint the meshes under it.)
  if (view.boxes.group.visible) { view.boxes.group.visible = false; deferred.push(view.boxes.group) }
  if (view.boxes.dressing.group.visible) { view.boxes.dressing.group.visible = false; deferred.push(view.boxes.dressing.group) } // dressings ride the cargo
  // the instance pool's merged static hardware (legs/frames/structural boxes) draws from its output group,
  // which lives directly in the scene at visible=true and is NOT a part entry - so without this it paints
  // with the building in phase 1, floating a phase before the part bodies it belongs to. Defer it with the
  // parts (revealed once in phase 2 and left visible, since the pool is what actually draws the hardware).
  const poolOutput = view.instancePool?.outputGroup()
  if (poolOutput?.visible) { poolOutput.visible = false; deferred.push(poolOutput) }
  notifyBundleStructureChanged() // phase-1 frames must record building-only, not a pre-hide list
  // Show the load stage the user is about to wait through, and make sure it paints first. The burst
  // below stalls presentation, not just the main thread: while the GPU process compiles, Chrome paints
  // no frame at all (1.4-2.2 s on a cold pipeline cache), which is why this cover has no spinner
  // (e2e/probes/spinner-hitch.mjs, and LoadStage in renderReady.ts).
  //
  // The loop is parked across the swap's two frames. A live frame here is the
  // building's first draw and mints ~19 pipelines on the on-draw path, so without the park the
  // stall begins inside the wait and the new label never reaches the screen (measured: the last
  // frame before the freeze still read "Loading models…"). Parking hides nothing visible, since the
  // cover is over the canvas either way, and phase 2 below holds the loop for ~2 s the same way. The
  // stage is not cleared afterwards: the compile is the last stage before the cover lifts, so
  // switching the label back would just flash.
  setLoadStage('shaders')
  view.warm.stagedReveal = true
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  view.warm.stagedReveal = false
  const tPhase1 = performance.now()
  // The loop is live through phase 1 (stagedReveal covers phase 2 only), so the building draws
  // itself while its pipelines pre-warm. Count the ticks to see how much of phase 1 is racing the
  // draw path rather than feeding it - see the ledger note in this method's doc.
  const tick1 = view.tickSerial
  try {
    // phase 1: building shell + env only. The staging is what prioritises the heavy shared building
    // pipelines.
    await withCompileLedger(view, gpu, () => gpu.compileAsync(view.scene, view.camera), 'phase1')
  } catch (err) {
    // A phase-1 failure must never strand the deferred parts hidden: the caller's .catch only
    // signals the loading cover, so without this the scene stays building-only until the next
    // syncScene visibility write. Re-reveal - they compile cold on first draw, the
    // always-correct fallback - and re-record the bundle draw list.
    for (const o of deferred) o.visible = true
    notifyBundleStructureChanged()
    throw err
  }
  markCompilePhase('phase1', performance.now() - tPhase1, gpu)
  markCompileCount('phase1Ticks', view.tickSerial - tick1)
  // Wait for the scene to finish arriving before compiling the parts. A rig's GLB mesh links attach
  // asynchronously, so a phase 2 that starts the moment phase 1 ends walks a half-built scene.
  // Whatever has not attached yet is not compiled here, and mints its pipelines on the first frame
  // that draws it, after the cover, in front of the user. Measured on the demo without this wait:
  // Gantry.glb attached +2.5 s and LaserSensor +2.2 s after the cover lifted, and 24-28 programs
  // minted behind them (e2e/probes/after-lift-attrib.mjs).
  //
  // Placed between the phases, not before them: phase 1 is the building, which is
  // already complete (whenBuildingReady gated this whole chain), so its ~1.5 s of compile overlaps
  // the tail of the part fetches instead of queueing behind them. whenAssetsQuiet carries its own
  // 30 s cap and ignores speculative catalog warms, so a wedged fetch degrades to compiling what is
  // here and the rest on draw, rather than leaving the cover up.
  await whenAssetsQuiet()
  // NOTE: the cover does not lift here. Phase 2 below holds the render loop
  // (stagedReveal), so lifting on phase 1 would fade the cover out over a frozen building-only
  // frame. The caller signals once the staged compile settles - see the constructor.
  if (deferred.length === 0) {
    markCompilePhase('phase2', 0, gpu)
    if (!wantsDeferredWarm()) await warmInteractionExtras(view, gpu)
    return // nothing new to warm
  }
  for (const o of deferred) o.visible = true
  view.warm.stagedReveal = true // hold the building frame until every part pipeline is warm
  const tPhase2 = performance.now()
  try {
    await compileParts(view, gpu) // phase 2: the parts
    // the mobile tier warms the interaction extras inline, inside the loop-hold; see wantsDeferredWarm
    if (!wantsDeferredWarm()) await warmInteractionExtras(view, gpu)
  } finally {
    markCompilePhase('phase2', performance.now() - tPhase2, gpu)
    view.warm.stagedReveal = false // always resume the loop, even if the concurrent compile threw
    // The reveal above changed pool eligibility: every deferred part was root-invisible when the
    // load-time rebuild ran, so it had nothing to pool (exactly the pumpWarm case, same fix - see
    // its `finally`). Nothing else re-pools afterwards: the staged reveal is a visibility flip, so
    // it moves no structureVersion, and poolRebuildOnStructureSettled only fires on an epoch move.
    // Without this call the scene stays unmerged (e2e/probes/pool-settle-check.mjs).
    view.poolRebuild()
    notifyBundleStructureChanged() // the phase-2 reveals + the fresh banks moved the draw list
  }
  await new Promise<void>((r) => requestAnimationFrame(() => r())) // paint the now-warm parts
}

/**
 * The WebGL half of {@link warmInteractionExtras}. Without it the demo's first selection compiles 7
 * shader programs inside a 106 ms frame (prod build), ten times any later one.
 *
 * Two tiers, same reasoning as the WebGPU twin:
 *  - the outline mask, which no compile() can reach (the pass substitutes materials at render time):
 *    outline.warmSelection stages a membership and renders one off-screen pass
 *  - the gizmo handles, hidden until a selection. compileAsync links on a worker thread where the
 *    driver supports KHR_parallel_shader_compile.
 *
 * Not covered (still compile on first use): the WebGPU twin's tier 2 (resize sprites, ruler, vertex
 * markers, drag-ejected pool sources); each wants its own before/after measurement first.
 */
export async function warmInteractionExtrasWebGL(view: WarmHost): Promise<void> {
  if (view.disposed || view.warm.extrasWarmed) return
  view.warm.extrasWarmed = true
  const t0 = performance.now()
  const renderer = view.renderer
  if (!(renderer instanceof WebGLRenderer)) return
  try {
    // What a first selection draws: the transform gizmo, the resize handles (their dots share one sprite
    // material, so the hidden constructor-built ones cover it) and the metal environment (metalWarmProbe;
    // WebGL builds its PMREM while preparing the program). Each is revealed, compiled and re-hidden in one
    // synchronous step, so no frame draws them.
    const roots: Object3D[] = [view.gizmo.root, view.handles.root, metalProbeIn(view)]
    const was = roots.map((r) => r.visible)
    // Compile into the target the frame draws into. Every frame goes through the outline's composer, and three
    // keys a WebGL program on the output colour space, so a compile with no target bound links the canvas
    // variant and the first selection links these again (verify-interaction-budget). compileAsync builds its
    // programs synchronously, so the target is restored before the await.
    const prevTarget = renderer.getRenderTarget()
    const pending: Promise<unknown>[] = []
    try {
      renderer.setRenderTarget(view.outline?.sceneTarget?.() ?? prevTarget)
      for (const root of roots) {
        root.visible = true
        pending.push(renderer.compileAsync(root, view.camera, view.scene))
      }
    } finally {
      renderer.setRenderTarget(prevTarget)
      roots.forEach((r, i) => (r.visible = was[i]!))
    }
    await Promise.all(pending)
    if (view.disposed) return
    warmSelectionOutline(view)
  } finally {
    markCompilePhase('extras', performance.now() - t0) // no gpu arg: the ledger's pipeline count is WebGPU-only
    view.warm.extrasWarmDone = true
  }
}

/**
 * Warm the pipelines nothing on screen needs yet: everything that only appears once the user
 * interacts. On desktop this runs on idle after the loading cover has lifted, over the live scene; the
 * mobile tier runs it inside compileStaged's loop-hold instead (wantsDeferredWarm).
 *
 * Why defer: these are one-time hitches on the first select / grab / measure, but the cover is
 * compile-bound (~88-92% CPU), so warming them there makes the user wait for things they may never
 * touch. After the reveal the user doesn't notice it, as long as idle comes before the first
 * interaction (it does).
 *
 * Safe with the loop live by pumpWarm's race-free toggle (see its doc): reveal -> compileAsync ->
 * re-hide in one synchronous burst. Compiled scoped (`compileAsync(root, camera, scene)`), since the
 * whole-scene form cost ~330 ms of main-thread codegen, a visible stutter on a live scene.
 */
/** how many pooled sources one compile takes: few enough that the page answers between batches */
const POOL_WARM_BATCH = 256

/**
 * A root that stands for `objects` in one `compileAsync`, wherever each of them is in the scene. The objects are
 * borrowed, not moved: they keep their parents, so nothing about the scene changes. Hidden itself, and revealing it
 * reveals them for the length of the projection (`burst` reveals a root and hides it again in one synchronous step).
 *
 * Relies on three's projection reading only `visible`, `children` and each object's own world matrix
 * (docs/three-coupling.md, "A compile scoped to a root still walks the whole target scene"): the holder must not
 * update its children's matrices, which are their real parents' to set.
 */
function borrowed(objects: readonly Object3D[]): Object3D {
  const holder = new Group()
  holder.matrixWorldAutoUpdate = false
  holder.matrixAutoUpdate = false
  holder.children = [...objects]
  let shown = false
  const was = objects.map((o) => o.visible)
  Object.defineProperty(holder, 'visible', {
    get: () => shown,
    set: (on: boolean) => {
      shown = on
      objects.forEach((o, i) => {
        o.visible = on ? true : was[i]!
      })
    },
  })
  return holder
}

export async function warmInteractionExtras(view: WarmHost, gpu: WebGPURenderer): Promise<void> {
  if (view.disposed || view.warm.extrasWarmed) return
  view.warm.extrasWarmed = true
  const tExtras = performance.now()
  // The transform gizmo sits at visible=false until a selection, so no scene compile reaches its ~13
  // handle pipelines; revealing the root reaches all main handles. The handle dot pools share one
  // sprite material, so the constructor-built box handles cover later dots too.
  //
  // Tiered, because the deferral only helps until the user acts, and select comes first. The whole
  // set takes ~240-400 ms from lift, so select-critical pipelines go in tier 1 and drag/measure/snap
  // gear (unreachable without selecting) follows in tier 2.
  const poolSources = (view.instancePool?.hiddenSourceMeshes() ?? []).filter((m) => m.visible === false)
  const burst = (roots: Object3D[], label: string): Promise<void> =>
    withCompileLedger(view, gpu, async () => {
      // One root at a time: two overlapping compileAsync calls corrupt each other (inCompileLane).
      // Each reveal is undone before control returns to the event loop, so no frame can draw an
      // overlay at the origin (or a pooled source doubling its merged copy)
      for (const root of roots) {
        const was = root.visible
        root.visible = true
        const p = gpu.compileAsync(root, view.camera, view.scene) // projection captured synchronously…
        root.visible = was // …so re-hiding now cannot un-schedule it
        await p
      }
    }, label)
  try {
    // tier 1 - everything a first select touches: the gizmo handles, and the outline mask pass.
    // The mask substitutes its materials at renderObject time, which no compileAsync can reach -
    // without it they'd codegen + compile on the first selection (measured on the demo: ~180 ms
    // main-thread longtask + a ~550 ms GPU-stalled frame). It stages its own membership and
    // renders one off-screen mask pass synchronously, so it needs no loop hold; the parts it reads
    // are on screen by now.
    await burst([view.gizmo.root], 'extras1')
    if (view.disposed) return
    warmSelectionOutline(view)
    // tier 2 - resize-handle sprites (~90 ms cold on the first select of a resizable part), the
    // ruler's line/bracket/end-dot pipelines (first M-measure; the bracket is a hidden child so it
    // needs its own reveal), the pooled drag-eject sources (a drag un-hides pooled hardware that
    // the pool keeps invisible at load, so it would compile cold on the first grab), and the
    // vertex-snap markers, which are created lazily on first use - mint them here so their first
    // real show can't hitch mid-drag.
    //
    // Minting them means showing them, so hide them again in the same synchronous step and let
    // `burst` own the reveal. Left lit across the tier-2 await (loop live, after the cover), they would draw
    // a near-white dot over the parts at the world origin for ~750 ms (`depthTest: false`,
    // renderOrder 999). Two calls with no await between, so no frame draws either state.
    const markerWarmPos = new Vector3()
    view.showVertexMarkers(markerWarmPos, markerWarmPos)
    view.showVertexMarkers(null, null)
    const tier2: Object3D[] = [view.handles.root, view.overlays.rulerGroup, view.overlays.rulerBracket]
    tier2.push(metalProbeIn(view)) // the first metal's environment (metalWarmProbe)
    if (view.vsnap.sourceMarker) tier2.push(view.vsnap.sourceMarker)
    if (view.vsnap.targetMarker) tier2.push(view.vsnap.targetMarker)
    // The pooled sources go in batches, not one compile each. A compile scoped to a root still walks the whole
    // live scene for its lights, so one call per source costs sources x scene: on a 420-part line that is 6,297
    // calls over 7,196 visible objects, an 11 s freeze on the first seconds after the cover lifts.
    for (let i = 0; i < poolSources.length; i += POOL_WARM_BATCH) tier2.push(borrowed(poolSources.slice(i, i + POOL_WARM_BATCH)))
    try {
      await burst(tier2, 'extras2')
    } finally {
      view.showVertexMarkers(null, null)
      notifyBundleStructureChanged() // the marker meshes joined the scene → re-record the draw list
    }
    // re-run with the pooled sources minted, so the drag-eject mask path is warm too (the first
    // pass above could not see them - they were still hidden when it staged its membership)
    if (!view.disposed && poolSources.length > 0) warmSelectionOutline(view)
  } finally {
    // on the mobile tier this runs inside phase 2's bracket, so the ledger's phase2 includes it
    markCompilePhase('extras', performance.now() - tExtras, gpu)
    view.warm.extrasWarmDone = true
  }
}

/**
 * One-time warm of the selection-outline mask pipelines (WebGPU consolidated outline only -
 * elsewhere warmSelection is absent and this is a no-op). Stages a synthetic everything-selected
 * membership (last part on the active tier so both tier materials mint, not just one), renders
 * one off-screen mask pass (outline.warmSelection), then restores the outline state from the
 * real selection.
 *
 * Runs with the render loop live (frames draw between warmInteractionExtras' two calls), so nothing
 * here may free a GPU resource synchronously: the stage and restore each rebake the merged mask
 * geometry through retireGeometry (outlineMaskMerge.rebake). The restore stays synchronous, so no
 * frame shows the synthetic membership.
 *
 * The pool + cargo aSel mask materials need no tier staging: the warm render bypasses the
 * batchHasSelection gate (consolidatedOutlineNode.warmingMask), since with nothing selected a gated
 * warm would mint none of them.
 */
export function warmSelectionOutline(view: WarmHost): void {
  if (!view.outline?.warmSelection) return
  const objects: Object3D[] = []
  for (const entry of view.entries.values()) {
    if (entry.part.type === 'building') continue
    if (entry.visual.object.visible) objects.push(entry.visual.object)
  }
  if (objects.length === 0) return
  const active = [objects.pop()!]
  try {
    view.outline.select(objects, active)
    view.maskMerge?.setMembership(objects, active)
    view.maskMerge?.tick() // bake the merged mask geometry so the merge pipeline actually draws
    view.outline.warmSelection()
  } catch (err) {
    console.warn('[oip] selection-outline pipeline warm failed; first select compiles on-draw', err)
  } finally {
    // re-derive outline + merge membership + tiers from the real selection (normally empty at
    // load). The sig cache was bypassed above, so null it to force the refresh through.
    view.outlineState.sig = null
    view.refreshOutline()
  }
}

/**
 * The ?serialcompile baseline: stock whole-scene compileAsync. (three 0.185.1 sizes each InstancedMesh's
 * instance-matrix uniform to its buffer capacity, so spawned/grown cargo + hardware stay visible under
 * WebGPU with no capacity "warm" around the compile - see SimBoxes' instanceColor pre-alloc for the one
 * remaining piece, the per-instance colour path.)
 */
export async function compileSerial(view: WarmHost, gpu: WebGPURenderer): Promise<void> {
  await inCompileLane(view, () => gpu.compileAsync(view.scene, view.camera)) // caller's .finally lifts the cover either way
}

/** phase 2 of compileStaged: compile the parts, recorded in the compile ledger as `phase2` */
export async function compileParts(view: WarmHost, gpu: WebGPURenderer): Promise<void> {
  await withCompileLedger(view, gpu, () => gpu.compileAsync(view.scene, view.camera), 'phase2')
}

/**
 * Run `fn` (a compileAsync) in the compile lane, recording what it compiled in the `__oipCompilePhases`
 * ledger under `label`: `<label>Build` (the whole compile), `<label>Items` (compilation items walked),
 * `<label>LiveGets` / `<label>LiveMint` (draws that resolved or minted a pipeline on the live path
 * meanwhile) and per-pipeline compile times (markPipelineTimes). Diagnostics only: every pipeline
 * promise goes back to three, whose compileAsync awaits them itself (up to 16 in flight since three
 * 0.187), so this changes nothing about what compiles or when. e2e/verify-webgpu-warm-completeness.mjs
 * reads `phase2Items`.
 *
 * Coupling: wraps three's internal `_pipelines.getForRender(renderObject, promises)` while `fn` runs.
 * If a three bump moves it, `fn` runs unwrapped and the ledger keys are missing.
 */
export function withCompileLedger(view: WarmHost, gpu: WebGPURenderer, fn: () => Promise<unknown>, label?: string): Promise<void> {
  return inCompileLane(view, () => withCompileLedgerNow(view, gpu, fn, label))
}

export async function withCompileLedgerNow(view: WarmHost, gpu: WebGPURenderer, fn: () => Promise<unknown>, label?: string): Promise<void> {
  const pipelines = (gpu as unknown as { _pipelines?: { getForRender?: (ro: unknown, out: unknown[] | null) => unknown } })._pipelines
  if (!label || !pipelines || typeof pipelines.getForRender !== 'function') {
    await fn() // nothing to record, or three moved it
    return
  }
  const original = pipelines.getForRender.bind(pipelines)
  const rows: { at: number; ms: number }[] = []
  let items = 0
  let liveGets = 0 // draws that resolved a pipeline through the live path while this phase ran
  let liveMintMs = 0 // ...of which the ones that actually minted, and what that cost synchronously
  markCompileCount(`${label}PipesStart`, cacheSizeOf(gpu))
  pipelines.getForRender = (ro, out) => {
    if (out == null) {
      liveGets++
      // note which live draws mint a pipeline (cache grew) - see recordLiveMint. The size read is a
      // Map.size; the descriptor is built only on a real mint.
      const before = cacheSizeOf(gpu)
      const t = performance.now()
      const res = original(ro, null)
      if (cacheSizeOf(gpu) > before) {
        liveMintMs += performance.now() - t // sync createRenderPipeline: main-thread cost, if any
        recordLiveMint(label, ro)
      }
      return res
    }
    items++
    const before = out.length
    const result = original(ro, out)
    for (let i = before; i < out.length; i++) {
      // timing only: settled-or-rejected both record, and the chain never itself rejects
      const at = performance.now() - tBuild
      const t0 = performance.now()
      const done = (): void => void rows.push({ at, ms: performance.now() - t0 })
      void (out[i] as Promise<unknown>).then(done, done)
    }
    return result
  }
  const tBuild = performance.now()
  try {
    await fn()
    markCompilePhase(`${label}Build`, performance.now() - tBuild)
    markCompileCount(`${label}Items`, items)
    markCompileCount(`${label}LiveGets`, liveGets)
    markCompilePhase(`${label}LiveMint`, liveMintMs)
    markPipelineTimes(label, rows)
  } finally {
    pipelines.getForRender = original
  }
}

/** the metal warm probe, added to the scene once (hidden: never drawn, only compiled) */
function metalProbeIn(view: WarmHost): Object3D {
  const probe = metalWarmProbe()
  if (!probe.parent) view.scene.add(probe)
  return probe
}
