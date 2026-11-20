// Why does the loading-cover spinner freeze? Measures what the user sees.
//
// The spinner is a composited CSS transform animation, so a blocked main thread should not stop it.
// This separates the three ways it stalls anyway:
//   - presented frames (CDP Page.startScreencast) - ground truth: 'the pixels moved'
//   - rAF ticks        - main thread + vsync liveness
//   - long tasks       - main-thread blocking
// plus the WebGPU pre-warm ledger (__oipCompilePhases / __oipPipelineTimes), so a freeze can be
// attributed to a compile phase.
//
// Findings (dev server, msedge, real GPU, ?scene=demo):
//   * cold profile, WebGPU: a 1.4-2.2 s window with zero presented frames and zero rAF ticks,
//     inside phase 1's pipeline wait (8 pipelines submitted at once, each resolving ~1.7-1.9 s), while the main
//     thread is idle (no long task spans it). So this is the GPU process compiling shaders, not JS.
//     While it compiles, Chrome presents no frame at all, so a composited animation freezes too.
//   * control: a deliberate 1500 ms main-thread block on a bare spinner page drops no frame
//     (207 frames, largest gap 121 ms). Main-thread blocking is not the mechanism.
//   * phase 2 mints more pipelines (31) yet only stutters (gaps 230-380 ms): its submissions are
//     spread across 1.7 s of codegen, so the GPU keeps getting slots. The freeze comes from the burst.
//   * feeding phase 1 one pipeline at a time does not fix it (still 1.46 s): Dawn is refilled immediately.
//   * warm profile (--profile=<dir>, second launch, Dawn's on-disk cache primed): no freeze, largest
//     in-cover gap ~380 ms. This is a cold-cache cost: every first-time visitor, and every dev whose
//     render/shader edits invalidate the cache.
//   * WebGL (--webgl) freezes too (~1.5 s), coinciding with a 1547 ms long task: its program link
//     is synchronous, so it stalls main thread and GPU together.
//
// So the cover has no spinner. It names its stage in text instead ('Loading…' / 'Loading models…' /
// 'Compiling shaders…', LoadStage in src/render/renderReady.ts), because a label needs a frame only
// when it changes. A label painted before a stall stays on screen through it and correctly reads as
// "this step is taking a moment". RenderView announces the 'shaders' stage a painted frame ahead
// with the render loop parked. A live frame there is the building's first draw, which mints ~19
// pipelines on the on-draw path, so without the park the stall starts inside the wait and the new
// label never reaches the screen (measured: the last frame before the freeze still showed the old
// one). This script re-checks that: it prints which label was showing when presentation stopped,
// and whether it had painted first.
//
// Open: the WebGL stall has no announce point. It fires before whenBuildingReady, so there is no
// verified point to announce ahead of; it needs attribution first (e2e/probes/cover-profile.mjs).
//
// Usage: node e2e/probes/spinner-hitch.mjs [--webgl] [--slow] [--flags=serialcompile] [--profile=<dir>]
//        --slow delays /models/ + /textures/ so the model-download leg is not swallowed by a warm
//        disk cache; pass the same --profile twice to compare a cold vs warm Dawn pipeline cache.
/* global process, console, window, document, performance, requestAnimationFrame, PerformanceObserver, setTimeout */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const WEBGL = process.argv.includes('--webgl')
const PROFILE = (process.argv.find((a) => a.startsWith('--profile=')) || '').slice(10)
const SLOW = process.argv.includes('--slow')
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6)
const EXTRA = (process.argv.find((a) => a.startsWith('--flags=')) || '').slice(8)
const GAP_MS = Number(process.env.GAP_MS || 60)

const { port: PORT, vite } = await startServer()
const URL_ = `http://localhost:${PORT}/app/?scene=demo&${WEBGL ? 'nowebgpu' : 'webgpu'}${EXTRA ? '&' + EXTRA : ''}`

async function launchHeaded() {
  const args = ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu']
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return { browser: await chromium.launch({ headless: false, channel, args }), channel: channel ?? 'chromium' }
    } catch { /* next */ }
  }
  throw new Error('no headed Chromium-family browser')
}

function probeInit() {
  const P = (window.__probe = { marks: {}, raf: [], longtasks: [], anim: [], status: [], timeOrigin: performance.timeOrigin })
  const mark = (k) => { if (P.marks[k] == null) P.marks[k] = performance.now() }
  document.addEventListener('DOMContentLoaded', () => mark('dcl'))
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push([e.startTime, e.duration]) })
      .observe({ entryTypes: ['longtask'] })
  } catch { /* no longtask support */ }
  const tick = () => {
    P.raf.push(performance.now())
    // sample the spinner animation's own clock: if this advances while frames don't present,
    // the animation is alive on the main thread but its pixels are not reaching the screen.
    const st = document.querySelector('.viewport-cover-status')
    if (st) {
      const label = (st.textContent || '').trim()
      const last = P.status[P.status.length - 1]
      if (!last || last[1] !== label) P.status.push([performance.now(), label])
    }
    const sp = document.querySelector('.viewport-cover .model-loading-spinner')
    if (sp && sp.getAnimations) {
      const a = sp.getAnimations()[0]
      if (a) P.anim.push([performance.now(), Number(a.currentTime) || 0])
    }
    const v = window.__oip && window.__oip.view
    if (v && P.marks.viewReady == null) mark('viewReady')
    const cover = document.querySelector('.viewport-cover')
    if (cover) mark('coverMount')
    if (cover && cover.classList.contains('ready')) mark('coverLift')
    if (P.marks.coverLift == null) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

let browser = null
let channel = 'persistent'
let ctx
if (PROFILE) {
  // same profile across runs => Dawn's on-disk pipeline cache is warm on the second launch
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, channel: 'msedge', viewport: { width: 1280, height: 800 },
    args: ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu'],
  })
} else {
  ;({ browser, channel } = await launchHeaded())
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
}
try {
  const page = ctx.pages()[0] || (await ctx.newPage())
  await page.addInitScript(probeInit)
  const cdp = await ctx.newCDPSession(page)
  // --slow delays the building's bytes only, not the whole origin: throttling a dev server also
  // throttles its hundreds of unbundled module requests, which times the load out long before the
  // scene appears. This isolates the leg we want to see - on a dev machine the GLBs come off a warm
  // disk cache in ~0 ms, which hides the "Loading models…" stage that a real first visit sits in.
  if (SLOW) {
    await page.route((u) => /\/(models|textures)\//.test(u.pathname), async (route) => {
      await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    })
  }
  const frames = []
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ ts: f.metadata.timestamp, bytes: f.data.length, data: f.data })
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 1, maxWidth: 800, maxHeight: 500 })
  const navStartWall = Date.now()
  await page.goto(URL_, { waitUntil: 'commit' })
  await page.waitForFunction(() => window.__probe && window.__probe.marks.coverLift != null, null, { timeout: 120000 })
  await page.waitForTimeout(300)
  await cdp.send('Page.stopScreencast')
  const P = await page.evaluate(() => window.__probe)
  const led = await page.evaluate(() => ({
    backend: (() => { const r = window.__oip?.view?.renderer; return r?.isWebGPURenderer ? (r.backend?.constructor?.name ?? 'webgpu?') : 'WebGLRenderer' })(),
    globals: Object.keys(globalThis).filter((k) => k.startsWith('__oip')),
    phases: globalThis.__oipCompilePhases || null,
    pipeTimes: globalThis.__oipPipelineTimes || null,
    mints: Object.fromEntries(Object.entries(globalThis.__oipLiveMints || {}).map(([k, v]) => [k, v.length])),
  }))

  // screencast metadata.timestamp is epoch seconds: timeOrigin maps it onto the page clock, so
  // presented frames, rAF, the compile ledger and the cover's status line share one axis
  const t0 = P.timeOrigin || navStartWall
  const fr = frames.map((f) => f.ts * 1000 - t0)
  console.log(`\nbrowser=${channel}  url=${URL_}`)
  console.log('marks:', JSON.stringify(P.marks))
  console.log(`frames presented: ${fr.length} over ${(fr[fr.length - 1] || 0).toFixed(0)}ms of screencast`)

  const gaps = []
  for (let i = 1; i < fr.length; i++) if (fr[i] - fr[i - 1] > GAP_MS) gaps.push([fr[i - 1], fr[i] - fr[i - 1]])
  console.log(`\nPRESENTED-FRAME gaps > ${GAP_MS}ms (screencast clock, 0 = first frame):`)
  for (const [at, d] of gaps.sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${d.toFixed(0).padStart(6)}ms  starting at ${at.toFixed(0)}ms`)

  const raf = P.raf
  const rgaps = []
  for (let i = 1; i < raf.length; i++) if (raf[i] - raf[i - 1] > GAP_MS) rgaps.push([raf[i - 1], raf[i] - raf[i - 1]])
  console.log(`\nrAF gaps > ${GAP_MS}ms (page clock; cover mounts ${P.marks.coverMount?.toFixed(0)}, lifts ${P.marks.coverLift?.toFixed(0)}):`)
  for (const [at, d] of rgaps.sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${d.toFixed(0).padStart(6)}ms  at ${at.toFixed(0)}ms`)

  console.log('backend:', led.backend, ' oip globals:', led.globals.join(','))
  if (led.phases) {
    const ph = led.phases
    const ends = Object.keys(ph).filter((k) => k.endsWith('End')).sort((a, b) => ph[a] - ph[b])
    console.log('compile phases (page clock; End = when the phase finished):')
    for (const k of ends) {
      const b = k.slice(0, -3)
      console.log('  ' + b.padEnd(20) + ' end ' + ph[k].toFixed(0).padStart(6) + 'ms  dur ' + String(Math.round(ph[b] ?? 0)).padStart(5) + 'ms  pipelines ' + (ph[b + 'Pipelines'] ?? '-'))
    }
    console.log('  live mints during phases:', JSON.stringify(led.mints))
    for (const [k, rows] of Object.entries(led.pipeTimes || {})) {
      const ms = rows.map((r) => Math.round(r.ms)).sort((a, b) => b - a)
      console.log('  ' + k + ' pipelines n=' + rows.length + '  each(ms, desc): ' + ms.join(' '))
    }
    const pipes = Object.entries(ph).filter(([k]) => /Pipe(Max|Med|Sum)$/.test(k))
    if (pipes.length) console.log('  per-pipeline:', pipes.map(([k, v]) => k + '=' + v).join(' '))
  }
  console.log('\nlong tasks > 100ms:')
  for (const [s, d] of P.longtasks.filter((t) => t[1] > 100).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${d.toFixed(0).padStart(6)}ms  at ${s.toFixed(0)}ms`)

  console.log('\ncover status line (page clock):')
  for (const [at, label] of P.status) console.log(`  ${at.toFixed(0).padStart(6)}ms  ${label}`)
  const worst = gaps.slice().sort((a, b) => b[1] - a[1])[0]
  if (worst) {
    const [gapAt, gapMs] = worst
    const swap = P.status.filter(([at]) => at <= gapAt).pop()
    console.log(`\nworst freeze: ${gapMs.toFixed(0)}ms, page ${gapAt.toFixed(0)} -> ${(gapAt + gapMs).toFixed(0)}`)
    if (swap) {
      const painted = fr.filter((t) => t >= swap[0] && t <= gapAt + 1).length
      console.log(`  label at the stall: "${swap[1]}" (set ${swap[0].toFixed(0)}ms, ${painted} frame(s) presented since)`)
      console.log(painted > 0 ? '  => that label PAINTED before the stall, so it is what the user sees through it' : '  => FAIL: the label never painted; the user is frozen on the previous one')
    } else console.log('  (no label recorded before the stall)')
    const idx = fr.findIndex((t) => t === gapAt)
    if (idx >= 0 && OUT) {
      // dump the last frames before the stall and the first one after it: the last one is what the
      // user stares at for the whole freeze, and the neighbours make a clock misalignment obvious
      for (const i of [idx - 2, idx - 1, idx, idx + 1]) {
        if (i < 0 || i >= frames.length) continue
        const tag = i === idx ? 'LAST-BEFORE' : i > idx ? 'first-after' : 'pre' + (idx - i)
        const f = OUT.replace(/.jpg$/, '') + '-' + tag + '-' + fr[i].toFixed(0) + 'ms.jpg'
        writeFileSync(f, Buffer.from(frames[i].data, 'base64'))
        console.log('  wrote ' + f)
      }
    }
  }

  const anim = P.anim
  if (anim.length > 1) {
    const jumps = []
    for (let i = 1; i < anim.length; i++) {
      const dt = anim[i][0] - anim[i - 1][0]
      const dc = anim[i][1] - anim[i - 1][1]
      if (dt > GAP_MS) jumps.push([anim[i - 1][0], dt, dc])
    }
    console.log('\nspinner animation clock across rAF gaps (wall dt vs animation dt - equal = it kept ticking):')
    for (const [at, dt, dc] of jumps.sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  at ${at.toFixed(0)}ms  wall ${dt.toFixed(0)}ms  anim ${dc.toFixed(0)}ms`)
    console.log(`  animation restarts (clock went backwards): ${anim.filter((a, i) => i && a[1] < anim[i - 1][1]).length}`)
  } else {
    console.log('\nno spinner animation samples (element or Web Animations API missing)')
  }
} finally {
  await ctx.close().catch(() => {})
  if (browser) await browser.close()
  vite.kill()
}
