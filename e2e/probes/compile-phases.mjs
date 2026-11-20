// Where does the WebGPU staged pre-warm actually spend the cover - phase 1 or phase 2?
//
// compileStaged runs two phases: (1) the building shell + env, (2) the parts, each through three's own
// compileAsync (up to 16 pipelines in flight since three 0.187). This reports the per-phase split
// (viewCompileLedger.ts publishes `__oipCompilePhases`, viewWarm.ts withCompileLedger fills it).
//
// Cold cache per run: Dawn's compiled pipelines are disk-cached per profile, so a
// second run on the same profile measures the cache, not the compile. Every run gets a fresh
// persistent profile dir and the arms alternate inside one process, so machine drift affects both.
//
// Usage: npm run build && node e2e/probes/compile-phases.mjs [runs=3] [--throttle] [--oneshot]
/* global process, console, window, document, performance, PerformanceObserver */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

const THROUGHPUT_KBPS = 550
const LATENCY_MS = 60
const THROTTLE = process.argv.includes('--throttle')
// By default only the shipped arm runs: the ledger's job is attributing time to a phase.
// --oneshot: is the two-phase split still worth it? ?serialcompile is three's stock whole-scene
// compileAsync in one pass.
const ARMS = process.argv.includes('--oneshot')
  ? [
      ['staged', ''],
      ['oneshot', '&serialcompile'],
    ]
  : [['shipped', '']]
const log = (...a) => console.log(...a)
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const ms = (x, w = 5) => String(Math.round(x)).padStart(w)

async function open(dir) {
  for (const channel of ['msedge', undefined]) {
    try {
      return await chromium.launchPersistentContext(dir, {
        channel,
        headless: !process.env.OIP_HEADED,
        args: ['--enable-unsafe-webgpu'],
        viewport: { width: 1400, height: 850 },
        serviceWorkers: 'block',
      })
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

async function runOnce(url, query) {
  const dir = mkdtempSync(join(tmpdir(), 'oip-phases-')) // fresh profile => cold Dawn disk cache
  const ctx = await open(dir)
  try {
    const page = await ctx.newPage()
    if (THROTTLE) {
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: LATENCY_MS,
        downloadThroughput: THROUGHPUT_KBPS * 1024,
        uploadThroughput: 256 * 1024,
      })
    }
    await page.addInitScript(() => {
      window.__dbg = { cover: null, atLift: 0, long: [] }
      const t = setInterval(() => {
        const el = document.querySelector('.viewport-cover')
        if (el && el.classList.contains('ready')) {
          window.__dbg.cover = performance.now()
          // pipelines warm at the reveal - sampled here because it is the only arm-agnostic
          // completeness signal: ?serialcompile writes no ledger marks at all
          window.__dbg.atLift = window.__oip?.view?.renderer?._pipelines?.caches?.size ?? 0
          clearInterval(t)
        }
      }, 16)
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__dbg.long.push({ s: e.startTime, d: e.duration })
        }).observe({ entryTypes: ['longtask'] })
      } catch {
        /* none */
      }
    })
    await page.goto(`${url}/app/?scene=demo&hook${query}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__dbg.cover != null, null, { timeout: 180000 })
    // the interaction extras warm on idle after the cover lifts - give them a chance to finish, but
    // don't fail the run if they don't (they are not part of the cover under the shipped default)
    await page
      .waitForFunction(() => globalThis.__oipCompilePhases?.extras != null, null, { timeout: 15000 })
      .catch(() => {})
    const out = await page.evaluate(() => {
      const before = window.__dbg.long.filter((x) => x.s < window.__dbg.cover)
      const cov = performance
        .getEntriesByType('resource')
        .filter((e) => /\/models\/(building|dockDoor)\//.test(e.name))
      return {
        cover: window.__dbg.cover,
        atLift: window.__dbg.atLift,
        // when the async attach burst last changed the scene's structure - the earliest a pre-warm
        // could have walked a complete scene (view.lastStructBumpAt)
        structDoneAt: window.__oip?.view?.lastStructBumpAt ?? 0,
        backend: window.__oip?.view?.renderer?.isWebGPURenderer ? 'WebGPU' : 'WebGL',
        blocked: before.reduce((s, x) => s + x.d, 0),
        worst: Math.max(0, ...before.map((x) => x.d)),
        bytesDone: Math.max(0, ...cov.map((e) => e.responseEnd)),
        phases: { ...globalThis.__oipCompilePhases },
        // three's compile loop yields to the main thread once per compilation item (utils.js
        // yieldToMain): scheduler.yield() where it exists, else a whole requestAnimationFrame -
        // i.e. a frame per item on a browser without it. Report which one this run got.
        yieldApi: globalThis.scheduler?.yield ? 'scheduler.yield' : 'requestAnimationFrame',
        pipes: JSON.parse(JSON.stringify(globalThis.__oipPipelineTimes ?? {})),
        liveMints: JSON.parse(JSON.stringify(globalThis.__oipLiveMints ?? {})),
      }
    })
    // What does the per-item yield alone cost? three awaits yieldToMain() once per compilation item,
    // so N items carry N task hops before any codegen. Replay that many yields on the now-idle main
    // thread: a lower bound on the yield's share of the per-item cost (during the real compile the
    // queue is busier), which is what separates "our codegen is expensive" from "the loop is".
    const items = out.phases.phase2Items ?? 0
    out.yieldFloor = items
      ? await page.evaluate(async (n) => {
          const y = globalThis.scheduler?.yield
            ? () => globalThis.scheduler.yield()
            : () => new Promise((r) => requestAnimationFrame(r))
          const t = performance.now()
          for (let i = 0; i < n; i++) await y()
          return performance.now() - t
        }, items)
      : 0
    // let the scene go quiet, then re-read: pipelines minted after the reveal compile during the
    // user's first frames. The absolute number includes the deferred extras (see
    // verify-webgpu-warm-completeness), but those are constant across arms, so the difference
    // between arms is a fair completeness comparison.
    await page.waitForTimeout(2500)
    Object.assign(
      out,
      await page.evaluate(() => ({
        settled: window.__oip?.view?.renderer?._pipelines?.caches?.size ?? 0,
        structDoneAt: window.__oip?.view?.lastStructBumpAt ?? 0,
      })),
    )
    return out
  } finally {
    await ctx.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* profile dir may still be locked on Windows */
    }
  }
}

function summarise(name, rs) {
  const pick = (f) => rs.map(f)
  const row = (label, f, unit = 'ms') =>
    log(`   ${label.padEnd(24)} median ${ms(median(pick(f)), 6)} ${unit}   [${pick(f).map((x) => Math.round(x)).join(', ')}]`)
  log(`\n── ${name}  (backend: ${rs[0]?.backend}, yield: ${rs[0]?.yieldApi})`)
  row('cover', (r) => r.cover)
  // everything before compileStaged is even armed: eager JS, renderer init, scene load, and the
  // building GLB's geometry+textures decoding (whenBuildingReady gates the compile)
  row('  boot -> phase 1', (r) => (r.phases.phase1End ?? 0) - (r.phases.phase1 ?? 0))
  row('  phase 1 (building)', (r) => r.phases.phase1 ?? 0)
  row('  phase 2 (parts)', (r) => r.phases.phase2 ?? 0)
  row('extras 1 (select-path)', (r) => r.phases.extras1Build ?? 0)
  row('extras 2 (drag/measure)', (r) => r.phases.extras2Build ?? 0)
  // completeness: what was warm when the cover lifted, and what still had to compile afterwards
  row('warm at reveal', (r) => r.atLift ?? 0, '  ')
  row('settled total', (r) => r.settled ?? 0, '  ')
  row('minted AFTER reveal', (r) => (r.settled ?? 0) - (r.atLift ?? 0), '  ')
  row('structure done at', (r) => r.structDoneAt ?? 0)
  row('blocked (main thread)', (r) => r.blocked)
  row('CPU tail after bytes', (r) => r.cover - r.bytesDone)
  row('items ph1', (r) => r.phases.phase1Items ?? 0, '  ')
  row('items ph2', (r) => r.phases.phase2Items ?? 0, '  ')
  // the loop is live during phase 1: frames drawn, and pipelines the draw path resolved while the
  // pre-warm ran. If most of phase 1's pipelines arrive this way, the pre-warm is racing the draw.
  row('ph1 ticks (loop live)', (r) => r.phases.phase1Ticks ?? 0, '  ')
  row('ph1 live getForRender', (r) => r.phases.phase1LiveGets ?? 0, '  ')
  row('ph1 pipelines +', (r) => (r.phases.phase1Pipelines ?? 0) - (r.phases.phase1PipesStart ?? 0), '  ')
  row('  of which pre-warmed', (r) => (r.pipes?.phase1 ?? []).length, '  ')
  row('yield floor for ph2', (r) => r.yieldFloor ?? 0)
  row('pipelines after ph1', (r) => r.phases.phase1Pipelines ?? 0, '  ')
  row('pipelines after ph2', (r) => r.phases.phase2Pipelines ?? 0, '  ')
  // main-thread cost per compilation item: three's sequential per-item loop (codegen + yields)
  for (const p of ['phase1', 'phase2']) {
    const build = median(pick((r) => r.phases[`${p}Build`] ?? 0))
    const items = median(pick((r) => r.phases[`${p}Items`] ?? 0))
    if (items > 0) log(`   ${p}: ${Math.round(build)} ms of main-thread loop over ${items} items = ${(build / items).toFixed(1)} ms/item`)
  }
  // Who mints phase 1's pipelines? The pre-warm compiles only a handful; the rest are minted by the
  // live draws that run unheld through the phase. Bucketed by pass/context/layers/material, this
  // says whether they are reachable by a deliberate warm or only by rendering.
  for (const p of ['phase1', 'phase2']) {
    const mints = rs.map((r) => r.liveMints?.[p] ?? []).find((m) => m.length > 0)
    if (!mints) continue
    const byKey = new Map()
    for (const m of mints) byKey.set(m, (byKey.get(m) ?? 0) + 1)
    const cost = median(rs.map((r) => r.phases[`${p}LiveMint`] ?? 0))
    log(`   ${p}: ${mints.length} pipelines minted by LIVE DRAWS during the phase (${Math.round(cost)} ms synchronous), by owner:`)
    for (const [k, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      log(`      ${String(n).padStart(3)}x  ${k}`)
    }
  }
  // One slow shader or uniform cost? Compare max with the median, not with the phase wall time.
  // max >> median: everything else finishes behind one heavy shader, and there is a specific
  // material to fix. max ~= median: every pipeline costs about the same, so the phase's floor is
  // one pipeline's latency however well they overlap, and only cheaper shaders (or hiding the
  // compile behind other work) can lower it. `sum / wall` says how much overlap was achieved.
  for (const p of ['phase1', 'phase2']) {
    const st = rs0(rs, p)
    if (!st) continue
    const verdict = st.max > st.med * 2 ? 'LONG POLE (one outlier)' : 'UNIFORM (all cost the same)'
    log(
      `   ${p}: ${st.n} timed pipelines · slowest ${ms(st.max, 1)} ms · median ${ms(st.med, 1)} ms · ` +
        `sum ${ms(st.sum, 1)} ms over ${ms(st.wall, 1)} ms of phase compile  -> ${verdict}`,
    )
    log(`      slowest few: ${st.top.map((x) => `${Math.round(x.ms)} ms (started +${Math.round(x.at)} ms)`).join(', ')}`)
  }
}

/** median-run pipeline stats for a phase, or null if the run carries none */
function rs0(rs, phase) {
  const withPipes = rs.filter((r) => (r.pipes?.[phase] ?? []).length > 0)
  if (withPipes.length === 0) return null
  // pick the run whose phase compile time is the median, so the distribution matches the reported wall time
  const byWall = [...withPipes].sort((a, b) => (a.phases[`${phase}Build`] ?? 0) - (b.phases[`${phase}Build`] ?? 0))
  const r = byWall[Math.floor(byWall.length / 2)]
  const rows = r.pipes[phase]
  const sorted = [...rows].sort((a, b) => a.ms - b.ms)
  return {
    n: rows.length,
    max: sorted[sorted.length - 1].ms,
    med: sorted[Math.floor(sorted.length / 2)].ms,
    sum: rows.reduce((s, x) => s + x.ms, 0),
    wall: r.phases[`${phase}Build`] ?? 0,
    top: sorted.slice(-4).reverse(),
  }
}

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const runs = Number(process.argv[2]) || 3
  const prod = await serveDist()
  const arms = Object.fromEntries(ARMS.map(([n]) => [n, []]))
  try {
    log(`${THROTTLE ? `${THROUGHPUT_KBPS} KB/s + ${LATENCY_MS} ms RTT` : 'unthrottled'}, fresh profile per run (cold pipeline cache)\n`)
    for (let i = 0; i < runs; i++) {
      for (const [name, q] of ARMS) {
        const r = await runOnce(prod.url, q)
        arms[name].push(r)
        log(
          `run ${i + 1} ${name.padEnd(10)} cover ${ms(r.cover, 6)} ms   ` +
            `phase1 ${ms(r.phases.phase1 ?? 0)} ms   phase2 ${ms(r.phases.phase2 ?? 0)} ms   ` +
            `extras ${ms(r.phases.extras ?? 0)} ms   [${r.backend}]`,
        )
        if (r.backend !== 'WebGPU') log(`   !! ${name} ran on ${r.backend} - this A/B only means anything on WebGPU`)
      }
    }
    for (const [name, rs] of Object.entries(arms)) summarise(name, rs)
    if (ARMS.length === 2) {
      const [a, b] = ARMS.map(([n]) => median(arms[n].map((r) => r.cover)))
      log(`\n   ${ARMS[0][0]} vs ${ARMS[1][0]}: ${Math.round(a - b)} ms on the cover (negative = ${ARMS[0][0]} wins)`)
    }
    log('\n   Spreads overlap on a busy machine - re-run and lean on agreement between rounds, not one round.')
  } finally {
    await prod.close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
