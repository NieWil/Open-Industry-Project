// Sizes the per-load JS codegen (TSL node-graph rebuild) at load time, splits it out of the
// `phase2Build` number, and reports what a structural nodeBuilder dedup could actually remove.
//
// Dawn's disk cache covers the compiled pipeline, not the JS that produces the WGSL: three rebuilds
// every NodeBuilderState on every load, warm cache included. `e2e/probes/compile-phases.mjs` reports
// phase 2 as ~1.0-1.8 s of main-thread "build" over ~485 items, but that is the whole compileAsync
// loop: scene walk + render-object resolve + bindings + per-item `_nodes.updateBefore` (which renders
// the shadow map inline) + codegen. Only the codegen slice is reachable by a `customCacheKey()` dedup,
// so this measures it separately.
//
// Method: patch `Nodes.getForRender` before the staged pre-warm runs (via a `view` setter armed on
// the `__oip` hook object in an init script) and time every call, tagging each cache miss with the
// shader it produced. The sum of the 2nd+ build of each structurally identical shader is what a
// dedup would save.
//
// Don't measure this by clearing `nodeBuilderCache` on a settled scene and re-running compileAsync:
// `Nodes` also memoises `nodeBuilderState` per render-object in its DataMap, so the clear rebuilds
// almost nothing (measured: 7 builds, not ~400) and gives a ~2% answer that is an artifact of the
// probe. That is why this script instruments the load instead.
//
// Arms:
//   (default)  stock Chromium - `scheduler.yield` present
//   --noyield  deletes `self.scheduler` before any page script, forcing three's
//              `requestAnimationFrame` fallback in `yieldToMain` (utils.js:356). Safari and Firefox
//              take that path, and NodeBuilder.js:3265 awaits it per build stage, so this arm
//              measures a shipping browser.
//   --noshim   with --noyield, also keeps the app's scheduler.yield shim (schedulerYield.ts) from
//              installing, which is Safari as it ships today.
//   --cpu N    CDP CPU throttle for the whole load (mobile-class JS).
//
// Usage: npm run build && node e2e/probes/codegen-cost.mjs [--noyield [--noshim]] [--cpu 4] [--headed]
/* global process, console, window, performance, self, document, requestAnimationFrame */
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

const log = (...a) => console.log(...a)
const flag = (n) => process.argv.includes(n)
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function launch(headed) {
  for (const opts of [
    { channel: 'msedge', headless: !headed, args: ['--enable-unsafe-webgpu'] },
    { headless: !headed, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

/**
 * Init script: arm a `view` setter on the `__oip` hook so `Nodes.getForRender` is wrapped the
 * instant the RenderView is published - which is the same synchronous task the view is built in,
 * before the staged compile's awaited work resumes.
 */
function initProbe({ killScheduler, blockShim }) {
  const probe = { builds: [], hits: 0, hitMs: 0, patchedAt: -1, armed: false, yields: 0 }
  probe.hadScheduler = typeof self.scheduler !== 'undefined' && typeof self.scheduler.yield === 'function'
  window.__codegenProbe = probe

  if (killScheduler && typeof self.scheduler !== 'undefined') {
    try {
      delete self.scheduler
    } catch {
      Object.defineProperty(self, 'scheduler', { configurable: true, get: () => undefined })
    }
  }
  // --noshim: pin `self.scheduler` to undefined and drop writes, so the app's installSchedulerYieldShim
  // (schedulerYield.ts) finds nothing to patch and its assignment has no effect
  if (killScheduler && blockShim) {
    Object.defineProperty(self, 'scheduler', { configurable: true, get: () => undefined, set: () => {} })
  }
  probe.usesScheduler = typeof self.scheduler !== 'undefined' && typeof self.scheduler.yield === 'function'

  // count the rAF fallback's yields so the arms are comparable
  const rafOrig = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => {
    probe.yields++
    return rafOrig(cb)
  }

  const norm = (s) => (typeof s === 'string' ? s.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N') : '')

  function patch(view) {
    if (probe.armed) return
    const nodes = view?.renderer?._nodes
    const cache = nodes?.nodeBuilderCache
    if (!nodes || !cache || typeof nodes.getForRender !== 'function') return
    probe.armed = true
    probe.patchedAt = performance.now()
    const orig = nodes.getForRender.bind(nodes)
    nodes.getForRender = (ro) => {
      const before = cache.size
      const t0 = performance.now()
      const state = orig(ro)
      const dt = performance.now() - t0
      if (cache.size > before) {
        probe.builds.push({ ms: dt, at: t0, key: norm(state?.vertexShader) + ' ' + norm(state?.fragmentShader) })
      } else {
        probe.hits++
        probe.hitMs += dt
      }
      return state
    }
  }

  function armHook(obj) {
    if (!obj || obj.__armed) return obj
    Object.defineProperty(obj, '__armed', { value: true, enumerable: false })
    let v
    Object.defineProperty(obj, 'view', {
      configurable: true,
      enumerable: true,
      get: () => v,
      set(val) {
        v = val
        try {
          patch(val)
        } catch {
          /* leave unarmed; reported below */
        }
      },
    })
    return obj
  }

  let hook
  Object.defineProperty(window, '__oip', {
    configurable: true,
    get: () => hook,
    set(val) {
      hook = armHook(val)
    },
  })
}

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const noYield = flag('--noyield')
  const cpuRate = arg('--cpu', 1)
  const prod = await serveDist()
  const browser = await launch(flag('--headed'))
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`))
    await page.addInitScript(initProbe, { killScheduler: noYield, blockShim: flag('--noshim') })

    const cdp = await ctx.newCDPSession(page)
    if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate })

    const t0 = Date.now()
    // --noshim + --noyield = "Safari as it ships today"; --noyield alone = Safari WITH our shim.
    await page.goto(`${prod.url}/app/?scene=demo&hook`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready'), null, {
      timeout: 300000,
    })
    const cover = Date.now() - t0
    await page.waitForTimeout(5000) // let phase 2 + deferred extras settle
    if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

    const r = await page.evaluate(() => {
      const p = window.__codegenProbe
      const phases = { ...(window.__oipCompilePhases ?? {}) }
      const byKey = new Map()
      let firstMs = 0
      let redundantMs = 0
      let redundant = 0
      for (const b of p.builds) {
        if (byKey.has(b.key)) {
          redundant++
          redundantMs += b.ms
        } else {
          byKey.set(b.key, 1)
          firstMs += b.ms
        }
      }
      // bucket builds into the staged phases using the ledger's absolute end marks
      const bucket = (end, prevEnd) => {
        const inB = p.builds.filter((b) => b.at > prevEnd && b.at <= end)
        return { n: inB.length, ms: inB.reduce((s, b) => s + b.ms, 0) }
      }
      return {
        armed: p.armed,
        patchedAt: p.patchedAt,
        usesScheduler: p.usesScheduler,
        hadScheduler: p.hadScheduler,
        yields: p.yields,
        builds: p.builds.length,
        distinct: byKey.size,
        redundant,
        redundantMs,
        firstMs,
        buildMsSum: firstMs + redundantMs,
        each: p.builds.map((b) => b.ms),
        hits: p.hits,
        hitMs: p.hitMs,
        phases,
        ph1: bucket(phases.phase1End ?? 0, 0),
        ph2: bucket(phases.phase2End ?? 0, phases.phase1End ?? 0),
        post: bucket(Number.MAX_SAFE_INTEGER, phases.phase2End ?? 0),
        pipelines: window.__oip.view.renderer._pipelines?.caches?.size ?? -1,
        shimActive: globalThis.scheduler?.__oipShim === true,
        yieldNow: typeof globalThis.scheduler?.yield === 'function',
      }
    })

    log(`\n=== ARM: ${noYield ? 'NO scheduler.yield (Safari/Firefox path)' : 'stock Chromium'}${cpuRate > 1 ? `  +  CPU throttle ${cpuRate}x` : ''} ===`)
    log(`   cover ${cover} ms · pipelines ${r.pipelines} · scheduler.yield at boot: ${r.usesScheduler} (present natively: ${r.hadScheduler})`)
    log(`   after app boot: scheduler.yield ${r.yieldNow ? 'available' : 'MISSING'}${r.shimActive ? ' (oip MessageChannel shim ACTIVE)' : ''}`)
    if (!r.armed) {
      log(`   PROBE NEVER ARMED - the __oip/view hook shape changed; numbers below are meaningless`)
      process.exitCode = 1
      return
    }
    log(`   probe armed at ${Math.round(r.patchedAt)} ms`)

    log(`\n── nodeBuilder.build() at LOAD TIME`)
    log(`   builds (cache misses)   ${r.builds}`)
    log(`   structurally distinct   ${r.distinct}`)
    log(`   redundant builds        ${r.redundant}  (${Math.round((r.redundant / Math.max(r.builds, 1)) * 100)}%)`)
    log(`   getForRender HITS       ${r.hits}  costing ${Math.round(r.hitMs)} ms total`)
    log(`   TOTAL codegen ms        ${Math.round(r.buildMsSum)} ms`)
    log(`     of which redundant    ${Math.round(r.redundantMs)} ms   <-- the dedup prize`)
    log(`   per build: median ${median(r.each).toFixed(2)} ms  max ${Math.max(0, ...r.each).toFixed(2)} ms`)

    const P = r.phases
    log(`\n── where that codegen sits vs the phase ledger`)
    log(`   phase          items   phaseBuild ms   codegen ms (builds)   codegen share`)
    const row = (name, items, build, b) =>
      log(
        `   ${name.padEnd(13)}${String(items ?? '-').padStart(5)}   ${String(Math.round(build ?? 0)).padStart(12)}   ${String(Math.round(b.ms)).padStart(10)} (${String(b.n).padStart(3)})   ${build ? Math.round((b.ms / build) * 100) + '%' : '-'}`,
      )
    row('phase1', P.phase1Items, P.phase1Build, r.ph1)
    row('phase2', P.phase2Items, P.phase2Build, r.ph2)
    row('post-cover', '-', P.extras, r.post)
    log(`\n   phase1 ${Math.round(P.phase1 ?? 0)} ms · phase2 ${Math.round(P.phase2 ?? 0)} ms`)
    log(`   yields (rAF fallback count) ${r.yields}`)

    const ph2b = P.phase2Build ?? 0
    if (ph2b) {
      log(`\n── VERDICT on the dedup prize`)
      log(`   phase2Build            ${Math.round(ph2b)} ms`)
      log(`   codegen inside it      ${Math.round(r.ph2.ms)} ms (${Math.round((r.ph2.ms / ph2b) * 100)}%)`)
      log(`   NOT codegen            ${Math.round(ph2b - r.ph2.ms)} ms (${Math.round(((ph2b - r.ph2.ms) / ph2b) * 100)}%) - walk/bindings/updateBefore`)
      log(`   removable by dedup     ~${Math.round(r.redundantMs)} ms across the whole load`)
    }
  } finally {
    await browser.close()
    prod.close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
