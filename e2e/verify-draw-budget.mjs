/* global console, process, window */
// Draw-call budget gate: the check on every batching mechanism in src/render/.
//
// The pool, staticFold, the instanced banks and the render bundles all exist to keep the scene's
// per-object draw cost from tracking its part count. Without a gate, a regression there shows up
// only when someone runs a census. This is the same instrument as the asset budgets in
// scripts/optimize-assets.mjs: a committed number that someone has to raise deliberately, in the
// commit that grew it.
//
// What it counts, and why not renderer.info.drawCalls: under WebGPU render bundles that counter is
// replay-dependent. It collapses on replay frames and returns on re-record frames, so the same
// build reads 23 / 75 / 464 depending on which frame you sample. The scene-graph count is
// deterministic instead: every visible Mesh is one draw, every visible InstancedMesh/BatchedMesh is
// one draw however many instances it holds. That is the quantity the batching mechanisms move, so
// it is the thing to budget.
//
// Two checks, different in kind:
//  1. Demo budget - an absolute ceiling on the shipped reference scene. Catches "a new part ships
//     40 unmergeable meshes" and "someone broke pooling". Drifts with content, so it is a ceiling
//     with headroom, not a golden number.
//  2. The scaling invariant - duplicate a part 4x and the drawables must barely move, because
//     identical hardware merges. This is the check that protects the architecture: it is
//     content-independent, identical on both backends (0.00/1.00/2.00/2.00 per copy, measured), and
//     it fails as soon as cross-part merging stops working, whatever the scene holds.
//
// The absolute count is not quite backend-independent: headless WebGL reads 207 and headed WebGPU
// 215 on the same build (both stable across runs; the 8 are WebGPU-only building content - not
// chased down). The budget covers the higher one, so the CI arm has ~8 extra headroom. It is also
// camera-sensitive, which `pin()` controls - see there.
//
// Runs headless in CI (no adapter -> WebGL). Run: node e2e/verify-draw-budget.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

// ---- budgets -------------------------------------------------------------------------------
// Raise these deliberately, in the same commit as the thing that grew them, with the measurement.
// 390 against a reading of 346 (headless), ~12% headroom so the budget catches the next unmerged part.
// Notable contributors, by the per-owner draw census (e2e/probes/draw-census.mjs): the demo's trailer
// unloading flex (25: 16 hinged sections, each a moving link of its own, so they cannot pool; the stands
// are on every other hinge already), the pallet dispenser (19), the light curtains (21), the stretch wrapper
// (12) and the barcode scanner (8).
const BUDGET_DEMO_DRAWS = 390
// Marginal drawables allowed per extra copy of an already-present part. Not zero: a part keeps a
// few genuinely unmergeable meshes (lone geometries, transparent cues), and the pool needs >=2
// members before it merges at all. 3 leaves room for that without admitting per-part growth.
const BUDGET_MARGINAL_PER_COPY = 3
// Marginal drawables per extra copy that differs in one size param. Necessarily looser than the
// identical case (a size change is a genuine geometry change, so the size-dependent meshes
// legitimately can't merge), but it must still be bounded: everything about a part that isn't
// size-dependent (legs, bolts, railing posts, footings) has to keep merging across the variants.
// This axis exists because the identical-copies test above cannot see a whole class of regression:
// a deck-tiling bug merged 26 differently-sized decks onto one material and the marginal number went
// down, which looks like an improvement (see instancePool.ts renderIdentityKey). Measured: rack 0.00
// (its hardware is size-independent, so variants merge outright), platform 1.00 (the deck, which
// carries its own tiling), roller conveyor 2.00 (same as its identical-copy cost).
const BUDGET_MARGINAL_VARIED = 4
// Report (never fail) when the demo sits this far under its ceiling - a budget nobody tightens
// stops being a budget.
const SLACK_WARN = 60

const { port: PORT, vite } = await startServer()
const EXTRA_Q = process.env.OIP_EXTRA_Q ? `&${process.env.OIP_EXTRA_Q}` : ''
let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

/**
 * Boot and settle on positive signals only. A timed wait here measures the loading cover or a
 * half-populated scene and every budget passes vacuously, a failure this repo has shipped more
 * than once. Three gates, in order: the view exists, the staged warm finished, and the pool has
 * actually run (late-arriving rig children re-pool once the attach burst settles, so an early
 * count reads the unpooled scene and would bake a hugely inflated budget).
 */
async function boot(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.goto(url) // cold vite can dep-re-optimize and full-reload mid-run; settle then re-goto
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForFunction(
    () => window.__oip.view.warming?.size === 0 && window.__oip.view.warmQueue?.size === 0,
    { timeout: 60000 },
  ).catch(() => {})
  // ...and every part GLB actually loaded. The warm signals above cover pipelines, not the
  // scene's own assets: parts whose visual arrives with its model (chain transfer, AGV,
  // diverter, roller conveyor) are absent from the count until then, so without this the
  // budget measures a half-populated scene (209 vs 330 drawables measured on the demo).
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 90000 }).catch(() => {})
  await pin(page)
  await settled(page)
}

/**
 * Pin the camera-dependent inputs to the count, or the budget is not a measurement. (The third is
 * the near-wall auto-hide, pinned by the `nowallhide` flag on the boot URL rather than here.)
 * `traverseVisible` skips hidden subtrees, and the building's roof auto-hides based on where the
 * camera is - so the same build reads differently at two window sizes (the headless 1280x800 run
 * and a headed 1500x950 one disagree by 45 without this). The mask gate pins the roof for the same
 * reason. Fixed camera too: per-object frustum culling would otherwise make the number depend on
 * framing.
 */
async function pin(page) {
  await page.evaluate(() => {
    const store = window.__oip.store
    const s = store.getState().scene
    if (s.parts.some((p) => p.type === 'building')) {
      store.loadScene({ ...s, parts: s.parts.map((p) => (p.type === 'building' ? { ...p, params: { ...p.params, roofVisible: false } } : p)) })
    }
    const v = window.__oip.view
    v.camera.position.set(18, 14, 18)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
  })
  await page.waitForTimeout(800)
}

/**
 * Poll until the count holds. The scene doesn't converge monotonically: it arrives as a staircase
 * (the rig attach burst, then the pool bake, then the late re-pool), and each step is a plateau
 * several seconds long. Accepting two consecutive equal samples fires on the first step and returns
 * a number from the middle of the climb: measured on the demo, three runs of one build read
 * 204 / 212 / 217 that way (curve in e2e/probes/draw-settle-curve.mjs). A budget sampled mid-climb
 * is not a measurement, and it drifts downward, which looks like an improvement, so require the
 * value to hold across HOLD consecutive samples.
 */
const HOLD = 6 // ~2.4s of stability at the 400ms cadence below
async function settled(page) {
  let last = -1
  let held = 0
  for (let i = 0; i < 120; i++) {
    const n = (await drawables(page)).total
    held = n === last ? held + 1 : 0
    if (held >= HOLD) return n
    last = n
    await page.waitForTimeout(400)
  }
  return last
}

/** every visible drawable in the scene = one draw each, split by kind for the report */
async function drawables(page) {
  return page.evaluate(() => {
    const v = window.__oip.view
    let plain = 0
    let batched = 0
    let lines = 0
    v.scene.traverseVisible((o) => {
      if (o.isInstancedMesh || o.isBatchedMesh) batched++
      else if (o.isMesh) plain++
      else if (o.isLine || o.isLineSegments || o.isPoints) lines++
    })
    return { plain, batched, lines, total: plain + batched + lines }
  })
}

/** load N copies of one package, spaced out; returns the settled drawable count. With `varyKey`,
 *  every copy gets a different value for that number param, so the copies are the same part kind
 *  at different sizes - the axis that separates correct merging from merging things that differ. */
async function loadCopies(page, packageId, n, varyKey = null) {
  await page.evaluate(([pkgId, count, vary]) => {
    const { store, getPackage } = window.__oip
    const pkg = getPackage(pkgId)
    const params = {}
    for (const [k, s] of Object.entries(pkg?.params ?? {})) if (s && typeof s === 'object' && 'default' in s) params[k] = s.default
    store.loadScene({
      version: 4,
      parts: Array.from({ length: count }, (_, i) => ({
        id: `c${i}`, type: 'part', packageId: pkgId,
        position: [(i % 6) * 7 - 16, 0, Math.floor(i / 6) * 7], rotationY: 0, name: `${pkgId} ${i}`,
        params: vary ? { ...params, [vary]: +(params[vary] * (1 + i * 0.35)).toFixed(3) } : { ...params },
      })),
      packages: [],
    })
  }, [packageId, n, varyKey])
  await page.waitForTimeout(1500)
  await pin(page)
  return settled(page)
}

/** load N roller beds, each with a diffuse eye seated on its +Z guard (where its conveyorGuard mount snaps: lens
 *  0.02 proud of the bed edge, origin 0.037 behind it, 0.02 below the deck) and ranged to cross the bed, so its
 *  beam cuts both guards; returns the settled drawable count and how many guard holes the scene derived. */
async function loadEyedCopies(page, n) {
  const holes = await page.evaluate(async (count) => {
    const { store, getPackage } = window.__oip
    const defaults = (id) => {
      const params = {}
      for (const [k, s] of Object.entries(getPackage(id)?.params ?? {})) if (s && typeof s === 'object' && 'default' in s) params[k] = s.default
      return params
    }
    const bed = defaults('oip.roller-conveyor'), eye = defaults('oip.diffuse-sensor')
    const hw = bed.width / 2
    const parts = []
    for (let i = 0; i < count; i++) {
      const x = (i % 6) * 7 - 16, z = Math.floor(i / 6) * 7
      parts.push({ id: `b${i}`, type: 'part', packageId: 'oip.roller-conveyor', position: [x, 0, z], rotationY: 0, name: `bed ${i}`, params: { ...bed } })
      parts.push({ id: `e${i}`, type: 'part', packageId: 'oip.diffuse-sensor', position: [x, -0.02, z + hw + 0.057], rotationY: Math.PI, name: `eye ${i}`, params: { ...eye, maxRange: bed.width + 0.04 } })
    }
    store.loadScene({ version: 4, parts, packages: [] })
    const gh = await import('/src/core/guards/guardHoles.ts')
    let h = 0
    for (const v of gh.computeSceneGuardHoles(store.getState().scene.parts).values()) h += v.left.length + v.right.length
    return h
  }, n)
  await page.waitForTimeout(1500)
  await pin(page)
  return { draws: await settled(page), holes }
}

async function main() {
  // headless is the CI arm (no adapter -> WebGL). `--headed` runs the shipping WebGPU config for
  // a local A/B; the count is scene-graph, so the two agree once the camera/roof are pinned.
  const headed = process.argv.includes('--headed')
  const browser = await chromium.launch({ headless: !headed, args: headed ? ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] : [] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  try {
    // ---- 1. the shipped reference scene ----
    // OIP_EXTRA_Q appends app query flags (e.g. OIP_EXTRA_Q=nostaticfold) so a render kill-switch
    // can be A/B'd on one tree, instead of editing source between runs and hoping nothing else moved
    // `nowallhide` pins the shell's perimeter walls on. The near-wall auto-hide drops the runs the
    // camera is behind (wallAutoHide.ts) and pin()'s camera sits 8 m outside the demo shell's +Z
    // wall, so without this the budget would quietly measure a scene with a wall run missing and
    // stop guarding whatever that run costs.
    await boot(page, `http://localhost:${PORT}/app/?scene=demo&nowallhide${EXTRA_Q}`)
    const demo = await drawables(page)
    const parts = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    const backend = await page.evaluate(() => window.__oip.view.renderer.backend?.constructor?.name ?? 'WebGL')
    console.log(`backend: ${backend}`)
    console.log(`\ndemo scene: ${demo.total} drawables  (${demo.plain} mesh + ${demo.batched} instanced + ${demo.lines} line)  over ${parts} parts`)
    check(`demo scene within its draw budget`, demo.total <= BUDGET_DEMO_DRAWS, `${demo.total} / ${BUDGET_DEMO_DRAWS}`)
    if (demo.total <= BUDGET_DEMO_DRAWS - SLACK_WARN) {
      console.log(`  NOTE  ${BUDGET_DEMO_DRAWS - demo.total} under budget - tighten BUDGET_DEMO_DRAWS in this file`)
    }

    // ---- 2. the scaling invariant, per part kind ----
    // A rack/platform is repeated structure (should merge to ~nothing extra); a roller conveyor is
    // the instanced-bank case; a push-button is the GLB-dressing case. All three must be flat.
    console.log('\nmarginal drawables per extra copy (identical parts must merge):')
    for (const pkgId of ['oip.rack', 'oip.platform', 'oip.roller-conveyor', 'oip.push-button']) {
      const has = await page.evaluate((id) => !!window.__oip.getPackage(id), pkgId)
      if (!has) { console.log(`  SKIP ${pkgId} - not registered`); continue }
      const base = await loadCopies(page, pkgId, 2)
      const many = await loadCopies(page, pkgId, 6)
      const marginal = (many - base) / 4
      console.log(`  ${pkgId.padEnd(24)} 2 copies=${String(base).padStart(4)}   6 copies=${String(many).padStart(4)}   marginal=${marginal.toFixed(2)}/copy`)
      check(`${pkgId}: duplicating it stays flat`, marginal <= BUDGET_MARGINAL_PER_COPY, `${marginal.toFixed(2)} drawables per extra copy, budget ${BUDGET_MARGINAL_PER_COPY}`)
    }

    // ---- 3. the variety axis ----
    // Same parts, one size param different on every copy. The invariant is not flatness - a size
    // change is a real geometry change - but that a part's size-independent hardware keeps merging
    // across the variants, so the cost stays bounded instead of scaling with everything the part
    // draws. Only parts with a numeric size param take part; a push-button has none.
    console.log('\nmarginal drawables per extra copy at a DIFFERENT size (only size-dependent meshes may split):')
    for (const [pkgId, varyKey] of [['oip.rack', 'length'], ['oip.platform', 'length'], ['oip.roller-conveyor', 'length']]) {
      const has = await page.evaluate((id) => !!window.__oip.getPackage(id), pkgId)
      if (!has) { console.log(`  SKIP ${pkgId} - not registered`); continue }
      const base = await loadCopies(page, pkgId, 2, varyKey)
      const many = await loadCopies(page, pkgId, 6, varyKey)
      const marginal = (many - base) / 4
      console.log(`  ${pkgId.padEnd(24)} 2 copies=${String(base).padStart(4)}   6 copies=${String(many).padStart(4)}   marginal=${marginal.toFixed(2)}/copy  (varying ${varyKey})`)
      check(`${pkgId}: varying ${varyKey} stays bounded`, marginal <= BUDGET_MARGINAL_VARIED, `${marginal.toFixed(2)} drawables per extra varied copy, budget ${BUDGET_MARGINAL_VARIED}`)
    }

    // ---- 4. a conveyor with an eye on it ----
    // A sensor's beam cuts a hole in each guard it crosses (core/guards/guardHoles.ts): the guard splits around it and a
    // holed panel fills the gap. Sections 2-3 duplicate bare conveyors, so they cannot see what a hole costs; on
    // the roller rig, unpooled split pieces and panels cost 2 draws per hole.
    // Holes must add no draws per copy: a bed-plus-eye pair may cost no more than a bed and an eye apart.
    console.log('\nmarginal drawables per extra roller bed WITH an eye cutting both its guards (holes must be free):')
    {
      const bed = (await loadCopies(page, 'oip.roller-conveyor', 6)) - (await loadCopies(page, 'oip.roller-conveyor', 2))
      const eye = (await loadCopies(page, 'oip.diffuse-sensor', 6)) - (await loadCopies(page, 'oip.diffuse-sensor', 2))
      const base = await loadEyedCopies(page, 2)
      const many = await loadEyedCopies(page, 6)
      const apart = (bed + eye) / 4
      const marginal = (many.draws - base.draws) / 4
      console.log(`  bed+eye                  2 pairs=${String(base.draws).padStart(4)}   6 pairs=${String(many.draws).padStart(4)}   marginal=${marginal.toFixed(2)}/pair  (bed + eye apart: ${apart.toFixed(2)})  holes ${many.holes}`)
      check('the eyes cut their holes (2 per pair; else this check proves nothing)', many.holes === 12, `${many.holes} holes for 6 pairs`)
      check('a hole costs no draw per copy', marginal <= apart, `${marginal.toFixed(2)} per pair vs ${apart.toFixed(2)} for a bed and an eye apart`)
    }
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(2) })
