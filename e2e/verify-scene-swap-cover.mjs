// Gate: a scene swap after the first load is covered while the incoming scene assembles itself, and
// only then.
//
// Under WebGPU a swap is not instant: every part of a kind the outgoing scene never drew is held hidden
// while its render pipeline compiles. Compiled one kind at a time, default scene -> Demo assembles in
// front of the user over ~6-7 s (203 of 204 parts hidden at the click; e2e/probes/scene-swap-popin.mjs).
// So the first-load cover is shown again for such a swap (editor/sceneSwapCover.ts), and a load compiles
// as one batch with the draw parked (view.compileSwap), which takes that swap to ~3 s. `FLAGS=&serialswap`
// runs the kind-at-a-time path, the A/B arm for the cover times printed below.
//
// The swap is a wholesale store.loadScene in a live session: what a room's arrival, a part-edit session or a
// gate fixture (window.__oip.loadSceneText) does. Open Demo cannot drive it: the demo is a project of
// its own and Open Demo reloads into it (a first load, covered by the boot cover), so the gate loads the demo
// scene through the store directly. Three swaps, one session:
//
//   cold   default scene -> Demo. Anything held or downloading at the load must be covered in the same
//          task (before a frame can paint it), the cover must appear at full opacity (no fade-in that
//          shows parts appearing through it), no frame may show a held part or a pending fetch uncovered,
//          and the cover must not lift before the last part is revealed.
//   warm   Demo -> the default scene again (the building only, a kind already drawn). Must raise no cover: a
//          cover on a swap that draws at once is a flash of the logo.
//   again  project -> Demo a second time (kinds now compiled). Whatever the view holds back, the same
//          invariant: never a held part on screen uncovered. Its cover time is reported.
//
// Vacuity guard: on the real WebGPU backend the cold swap must hold parts at the click; if it does not,
// this gate is no longer testing what it says, and fails. Where only WebGL is available (bundled
// Chromium, no GPU) nothing is held and a dev-server fetch is instant, so the cold case can legitimately
// show no cover: the invariants still run, and the result says it could not exercise the cover.
//
// Run: node e2e/verify-scene-swap-cover.mjs
/* global process, console, window, document, performance, requestAnimationFrame, queueMicrotask, localStorage, sessionStorage, getComputedStyle */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
// the swap cover's own budget, plus room for a slow machine to present the lift
const LIFT_LIMIT_MS = 25000
// extra URL flags for an A/B arm (e.g. FLAGS=&serialswap)
const FLAGS = process.env.FLAGS || ''

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

/**
 * Ready both scenes in the page, so swapAndWatch can load either synchronously: the demo, built by the app's own
 * module (vite serves it at its source path), and the default scene on screen now.
 */
async function readyScenes(page) {
  await page.evaluate(async () => {
    const demo = await import('/src/editor/demo/demoScenes.ts')
    window.__swapDemo = () => demo.createPlcDemoScene()
    window.__swapHome = window.__oip.store.getState().scene
  })
}

/**
 * in-page: run `trigger` (a swap), then sample every frame until the cover has been down and the scene
 * unchanged for `quietMs`. Returns the state right after the trigger returned, plus every frame.
 */
function swapAndWatch({ how, quietMs, limitMs }) {
  return new Promise((resolve, reject) => {
    const hook = window.__oip
    const v = hook.view
    const cover = () => document.querySelector('.viewport-cover')
    const read = () => {
      const el = cover()
      return {
        held: v.heldParts(),
        busy: hook.assetsBusy(),
        covered: !!el && !el.classList.contains('ready'),
        opacity: el ? Number(getComputedStyle(el).opacity) : 0,
      }
    }
    // loaded here, in the same task as the sampling starts, so the cover's first frame is seen
    if (how === 'demo') hook.store.loadScene(window.__swapDemo(), { persist: false })
    else if (how === 'back') hook.store.loadScene(window.__swapHome, { persist: false })
    // The store -> view sync is synchronous; React commits the cover in a microtask it queued during
    // the swap. Reading in a microtask queued after it is the latest point still guaranteed to precede
    // the next frame, so this is exactly what that frame paints.
    let atTrigger = null
    const t0 = performance.now()
    const frames = []
    let lastKey = ''
    let lastChange = t0
    const tick = () => {
      const now = performance.now()
      const s = read()
      frames.push({ t: Math.round(now - t0), ...s })
      const key = `${s.held}|${s.busy}|${s.covered}`
      if (key !== lastKey) { lastKey = key; lastChange = now }
      const down = !s.covered && s.held === 0 && !s.busy
      if ((down && now - lastChange > quietMs) || now - t0 > limitMs) {
        resolve({ atTrigger, frames })
        return
      }
      requestAnimationFrame(tick)
    }
    queueMicrotask(() => {
      atTrigger = read()
      requestAnimationFrame(tick)
    })
  })
}

const fails = []
const { browser, channel } = await launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('gate-seeded')) {
        localStorage.clear()
        localStorage.setItem('oip-web/tutorial-done', '1')
        sessionStorage.setItem('gate-seeded', '1')
      }
    } catch { /* pre-origin */ }
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/app/?webgpu${FLAGS}`, { waitUntil: 'commit' })
  await page.waitForFunction(() => document.querySelector('.viewport-cover.ready') && window.__oip?.view, null, { timeout: 180000, polling: 250 })
  await page.waitForTimeout(800)
  const backend = await page.evaluate(() => {
    const r = window.__oip.view.renderer
    return r && r.isWebGPURenderer ? `WebGPU/${r.backend?.constructor?.name}` : 'WebGL'
  })
  const realWebGPU = backend === 'WebGPU/WebGPUBackend'
  console.log(`[${channel}] backend ${backend}`)

  const judge = (label, run, { expectCover }) => {
    const { atTrigger, frames } = run
    const arriving = atTrigger.held > 0 || atTrigger.busy
    const firstCovered = frames.findIndex((f) => f.covered)
    const liftIdx = firstCovered < 0 ? -1 : frames.findIndex((f, i) => i > firstCovered && !f.covered)
    const liftAt = liftIdx < 0 ? null : frames[liftIdx].t
    const heldBare = frames.filter((f) => f.held > 0 && !f.covered)
    const busyBare = frames.filter((f) => f.busy && !f.covered)
    const maxHeld = Math.max(atTrigger.held, ...frames.map((f) => f.held))
    // the longest the screen went without a new frame: a swap with no cover still takes some time,
    // and this is where it shows (the first gap is the swap's own first frame)
    const worstGap = Math.max(...frames.map((f, i) => f.t - (i ? frames[i - 1].t : 0)))
    console.log(
      `  ${label}: at trigger held ${atTrigger.held} busy ${atTrigger.busy} covered ${atTrigger.covered}` +
      `   max held ${maxHeld}   cover ${firstCovered < 0 ? 'never shown' : `lifted at ${liftAt ?? 'NEVER'} ms`}` +
      `   frames ${frames.length}   worst gap ${worstGap} ms`,
    )
    if (arriving && !atTrigger.covered) fails.push(`${label}: the scene was arriving at the click (held ${atTrigger.held}, busy ${atTrigger.busy}) but the cover was not up in the same task`)
    if (heldBare.length) fails.push(`${label}: ${heldBare.length} frame(s) drew with parts still held and no cover (first at ${heldBare[0].t} ms, held ${heldBare[0].held})`)
    if (busyBare.length) fails.push(`${label}: ${busyBare.length} frame(s) drew with a fetch in flight and no cover (first at ${busyBare[0].t} ms)`)
    if (firstCovered >= 0) {
      const first = frames[firstCovered]
      if (first.opacity < 0.99) fails.push(`${label}: the cover's first frame was at opacity ${first.opacity.toFixed(2)} (a fade-in shows the pop-in through it)`)
      if (liftAt == null) fails.push(`${label}: the cover never lifted within ${LIFT_LIMIT_MS} ms`)
    }
    if (expectCover === false && (atTrigger.covered || firstCovered >= 0)) fails.push(`${label}: a swap that draws at once raised the cover (held ${atTrigger.held}, busy ${atTrigger.busy})`)
    return { arriving, liftAt }
  }

  const opts = { quietMs: 1500, limitMs: LIFT_LIMIT_MS }
  await readyScenes(page)
  const cold = judge('cold  default -> Demo', await page.evaluate(swapAndWatch, { how: 'demo', ...opts }), {})
  if (realWebGPU && !cold.arriving) fails.push('cold: on the real WebGPU backend the Demo swap held nothing at the click; the gate no longer exercises the cover (vacuous)')
  if (!cold.arriving) console.log('  note: the cold swap had nothing arriving on this backend, so the cover path itself went unexercised')

  judge('warm  Demo -> default', await page.evaluate(swapAndWatch, { how: 'back', ...opts }), { expectCover: false })
  judge('again default -> Demo', await page.evaluate(swapAndWatch, { how: 'demo', ...opts }), {})

  if (errors.length) fails.push(`page errors: ${errors.slice(0, 3).join(' | ')}`)
  await page.close()
} finally {
  await browser.close()
  vite.kill()
}

if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`)
  process.exit(1)
}
console.log('PASS scene swaps are covered while they arrive, and only then')
