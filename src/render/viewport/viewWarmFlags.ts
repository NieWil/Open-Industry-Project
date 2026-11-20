// Pipeline pre-warm switches and budgets: the URL kill-switches / A-B levers for the WebGPU warm paths
// (compileSwap, the interaction warm, the staged compile) and the reveal-budget cost model.

import type { Mesh, InstancedMesh, Object3D } from 'three'
import { renderQuality } from '../quality'

/** A scene load compiles its held parts as one concurrent batch (compileSwap). On by default;
 *  `?serialswap` is the kill-switch: a load's cold kinds go through pumpWarm one kind at a time,
 *  for A/B measurement + a rollback hatch. */
export function wantsSwapCompile(): boolean {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('serialswap')) return false
  return true
}

/**
 * Per-frame reveal budget for freshly-added warm-kind parts, in first-draw cost points. Warm
 * pipelines make the reveal fairly cheap, but three still does per-object first-draw setup, and the
 * cost is very uneven (measured, e2e/probes/dup-tick-breakdown.mjs). A plain mesh sharing its
 * material with an on-screen twin hits three's nodeBuilderCache (nearly free, just bind groups). A
 * fresh InstancedMesh bank never hits it (r185 bakes object.uuid into the instanced cacheKey, since
 * the node graph references that mesh's instance buffer), so it repeats full TSL codegen for every
 * material pass it's drawn with (main + shadow + outline mask ≈ 3 builds, ~15-20 ms per bank).
 * A roller conveyor carries ~20 banks; revealing one all at once is most of the ~500 ms
 * bulk-duplicate freeze. Banks are weighted so bank-heavy clones stagger. Small adds (every
 * single-part duplicate/paste) still reveal in the same sync while the budget lasts, and clones
 * start stacked on their originals, so the stagger renders pixel-identical.
 */
export const REVEAL_BUDGET_POINTS = 24
const REVEAL_COST_INSTANCED = 25 // one fresh instanced bank ≈ 3 uncacheable codegen passes

/**
 * Hard cap on how long the WebGPU pipeline pre-warm may hold the first-load viewport cover, armed
 * once the building is ready. The pre-warm is an optimisation layered on three's always-correct
 * on-draw compile, so a wedged compile must degrade to a slower first frame - never to a viewport
 * that stays covered forever. Sized well clear of a real cold load (~5-6 s of compile on the demo
 * on a real GPU) so it only ever fires on a genuine stall.
 */
export const PREWARM_COVER_CAP_MS = 20000

/**
 * How long the deferred interaction pre-warm may wait for an idle slice before running anyway.
 * These pipelines exist to keep the first select / grab / measure hitch-free, so the deadline must
 * come before a user's first interaction, even at some cost: a busy main thread must not
 * push them past the point where the user has already clicked.
 */
export const DEFERRED_WARM_TIMEOUT_MS = 1500

/**
 * Whether to warm the interaction extras on idle after the reveal (true) or inside compileStaged's
 * loop-hold, behind the cover (false). `?deferwarm` forces the former on any tier.
 *
 * Deferring lifts the cover sooner, which is why it is the desktop default. It doesn't remove the
 * work: it moves it into the first second of a scene the user is already looking at, where
 * the extras mint their pipelines through the live draw path.
 *
 * On the mobile tier the tradeoff reverses, measured (e2e/probes/post-cover-hitches.mjs,
 * msedge + real WebGPU, mobile tier, demo scene):
 *
 *     deferred (desktop default)   cover 3208 ms   13 pipelines minted after the reveal, 462 ms of
 *                                                  compile stalls across 2 frames
 *     behind the cover             cover 3507 ms   0 minted, 0 stalls
 *
 * 300 ms more behind a loading cover removes 462 ms of stutter in a live scene, and a phone
 * compiles far slower than the desktop those numbers came from (an iPhone dropped ~430 frames in
 * the first 30 s of a WebGPU run, against ~98 on WebGL). Users expect to wait behind a cover, not
 * for a scene to stutter when they first touch it. So the mobile tier warms behind the cover.
 */
export function wantsDeferredWarm(): boolean {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('deferwarm')) return true
  return renderQuality.tier !== 'mobile'
}

/** first-draw cost proxy for the reveal budget (see REVEAL_BUDGET_POINTS) */
export function revealCostOf(object: Object3D): number {
  let n = 0
  object.traverse((o) => {
    if ((o as InstancedMesh).isInstancedMesh) n += REVEAL_COST_INSTANCED
    else if ((o as Mesh).isMesh) n++
  })
  return Math.max(1, n)
}
