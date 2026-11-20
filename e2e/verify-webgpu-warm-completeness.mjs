// Gate: under WebGPU the staged pre-warm must compile the scene's pipelines behind the cover, not
// merely finish before it lifts.
//
// Its sibling verify-webgpu-cover-holds asserts ordering (cover-lift >= warm-done) and cannot see
// the failure this one catches: shrink what the pre-warm covers and both signals move together, so
// the cover lifts sooner, the gate stays green, and the compiles happen on the user's first frames
// instead. Measured with an experiment that dropped phase 1's await: the cover moved 3613 -> 3067 ms
// and at the same time shrinks the pre-warm from 485 items / 80 pipelines to 101 / 45, because
// phase 1's 1.3 s wait is also the window in which the parts' async GLB attachments arrive.
// 35 pipelines then compile on-draw after the reveal, and cover-holds passes on both arms.
//
// The invariant is a floor on what the pre-warm covered at the moment the cover lifted: how many
// compilation items it walked, and how many pipelines were warm. Budget-style, like
// verify-draw-budget: a scene change may legitimately move these, and then you raise them
// deliberately in the same commit.
//
// An approach that does not work, noted so nobody rebuilds it: "pipelines created after the reveal
// must be explained by the extras' own count." That conflates deliberately-deferred work with missed
// work and fails on a healthy tree (35 after-reveal pipelines vs 6 rows), because warmInteractionExtras
// also creates pipelines through the live draw path (warmSelectionOutline renders a real off-screen mask
// pass), which never appears in the compileAsync rows. The remainder is still printed, as diagnosis only.
//
// Reads globalThis.__oipCompilePhases / __oipPipelineTimes (viewCompileLedger.ts, diagnostics-only marks).
// Runs headless (Edge -> real WebGPU). Run: node e2e/verify-webgpu-warm-completeness.mjs
/* global process, console, window, document, performance, requestAnimationFrame, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?webgpu&scene=demo${process.env.OIP_EXTRA_QUERY ?? ''}`
const RUNS = Number(process.env.RUNS || 2)
// Floors on what the pre-warm had covered when the cover lifted. Demo scene, measured.
//
// ITEMS is the one that matters: it is what drops sharply when the pre-warm walks a half-built scene
// (healthy 491, that experiment 262 on the dev server / 101 on dist). PIPELINES-at-reveal is a weaker
// signal and is kept only as a floor against a pre-warm that walks the scene but compiles nothing: it
// is sampled at one instant while async compiles continue, and the regression arm read higher than the
// healthy one on dev (97 vs 77). Do not make this gate rely more on that number.
//
// Wide margins so machine speed and load-order jitter cannot trip them. Raise deliberately if the
// demo scene grows, the same convention as verify-draw-budget.
const MIN_ITEMS = 350
const MIN_PIPELINES = 65
const SETTLE_MS = 3000

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' } }
    catch { /* next launcher */ }
  }
  throw new Error('could not launch any Chromium')
}

function probeInit() {
  const P = (window.__warmProbe = { coverLift: null, atLift: null, webgpu: null })
  const cacheSize = () => {
    const r = window.__oip?.view?.renderer
    return r?._pipelines?.caches?.size ?? 0
  }
  const poll = () => {
    try {
      const v = window.__oip?.view
      if (v && P.webgpu == null) P.webgpu = !!v.renderer?.isWebGPURenderer
      const cover = document.querySelector('.viewport-cover')
      if (P.coverLift == null && cover?.classList.contains('ready')) {
        P.coverLift = performance.now()
        // sample the cache the moment the cover lifts: this is the "warm at reveal" number
        P.atLift = cacheSize()
      }
    } catch { /* app not up yet */ }
    if (P.coverLift == null) requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

const fails = []
const { browser, channel } = await launch()
try {
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await page.addInitScript(() => {
        try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* harmless */ }
      })
      await page.addInitScript(probeInit)
      await page.goto(URL)
      await page.waitForFunction(() => window.__warmProbe?.coverLift != null, null, { timeout: 90000 }).catch(() => {})
      const lifted = await page.evaluate(() => window.__warmProbe.coverLift != null)
      if (!lifted) { fails.push(`run ${i + 1}: cover never lifted`); continue }
      // let the deferred extras run and the scene go quiet, then re-read the cache
      await page.waitForFunction(() => window.__oip?.view?.extrasWarmDone === true, null, { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(SETTLE_MS)
      const r = await page.evaluate(() => {
        const times = globalThis.__oipPipelineTimes ?? {}
        return {
          webgpu: window.__warmProbe.webgpu,
          atLift: window.__warmProbe.atLift,
          settled: window.__oip?.view?.renderer?._pipelines?.caches?.size ?? 0,
          items: globalThis.__oipCompilePhases?.phase2Items ?? 0,
          extras: (times.extras1?.length ?? 0) + (times.extras2?.length ?? 0),
        }
      })
      if (!r.webgpu) { console.log(`  run ${i + 1}: SKIP (not a WebGPURenderer - no WebGPU on this machine)`); continue }
      const ok = r.items >= MIN_ITEMS && r.atLift >= MIN_PIPELINES
      console.log(
        `  run ${i + 1}: at cover-lift the pre-warm had walked ${r.items} items (min ${MIN_ITEMS}) and warmed ` +
        `${r.atLift} pipelines (min ${MIN_PIPELINES})  ${ok ? 'ok' : 'PRE-WARM MISSED THE SCENE'}` +
        `   [settled=${r.settled}, so ${r.settled - r.atLift} minted after the reveal; ${r.extras} of those are ` +
        `extras compiles - diagnosis only, not asserted]`,
      )
      if (!ok) {
        fails.push(
          `run ${i + 1}: the pre-warm covered only ${r.items} items / ${r.atLift} pipelines at cover-lift - ` +
          `it walked an incomplete scene, so any cover-time win is work moved PAST the cover, not saved`,
        )
      }
    } finally {
      await page.close().catch(() => {})
    }
  }
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}

if (fails.length) {
  console.error(`FAIL [${channel}] the staged pre-warm does not cover the scene:`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exitCode = 1
} else {
  console.log(`PASS [${channel}] the pre-warm compiles the scene behind the cover`)
}
