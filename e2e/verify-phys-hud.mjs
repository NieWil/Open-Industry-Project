// Verify the stats overlay's sim lines: while the sim runs, the summary shows `sim <n>%` (the worker's
// busy share of one core, editor/simLoad.ts) beside `<ms> / <budget> ms` (worker ms per step against the step
// budget at the run's rate) with plausible values, and under it the split of that time (one ms row per cost, adding up to its ms);
// both disappear on Stop. The render line carries its ms too.
// The Scene inspector's rate field states the run's cost on this machine while running. Also checks the
// StepStats.plcTotalMs counter accrues while an ST program is attached (the interleaved scan cost, kept
// separate from the Jolt-only step counters).
// Run: node e2e/verify-phys-hud.mjs [--headed]
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

// bare VAR block + statements (no PROGRAM header - see DEMO_PROGRAM); gives every scan real work
const PROGRAM = `VAR n : INT; END_VAR
n := n + 1;`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  const overlayText = () => page.evaluate(() => document.querySelector('.stats-overlay')?.textContent ?? '')

  try {
    // warm-up visit: a cold vite may re-optimize deps and fully reload the page mid-script,
    // destroying evaluate contexts. Visit once, let it settle, then reload and run for real
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(3000)
    errors.length = 0
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    // small scene (one belt conveyor if the bundled package is available - the checks don't
    // depend on it, an empty world steps too) + stats overlay on
    const loaded = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const belt = st.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')
      const parts = belt
        ? [{ id: 'belt_1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: {} }]
        : []
      st.loadScene({ ...scene, parts, packages: belt ? [belt] : [] })
      st.setState({ selectedIds: [] })
      st.setShowStats(true)
      return { belt: !!belt }
    })
    check('stats overlay enabled (scene loaded)', true, loaded.belt ? 'with belt conveyor' : 'empty world - belt package not found')

    const before = await overlayText()
    check('sim lines ABSENT while stopped', !/sim\s+\d+%|parts\s/.test(before), JSON.stringify(before))
    const rateText = () => page.evaluate(() => document.querySelector('[data-testid="scene-rate-cost"]')?.textContent ?? '')
    check('rate field invites a run while stopped', /Run the scene/.test(await rateText()), JSON.stringify(await rateText()))

    // run with a tiny ST program attached so the interleaved scan path executes
    await page.evaluate((src) => {
      window.__oip.store.loadStProgram(src, { persist: false })
      window.__oip.controller.run()
    }, PROGRAM)

    // let the worker accrue a real window of steps (bench waits the same way)
    await page.waitForFunction(() => (window.__oip.sim.stepStats?.steps ?? 0) > 120, { timeout: 30000 })
    await page.waitForFunction(
      () => /sim\s+\d+%\s+[\d.]+ \//.test(document.querySelector('.stats-overlay')?.textContent ?? ''),
      { timeout: 10000 },
    )
    const runningText = await overlayText()
    const load = Number(/sim\s+(\d+)%/.exec(runningText)?.[1])
    check('sim load line visible while running', Number.isFinite(load), JSON.stringify(runningText))
    check('sim load plausible (0..100%)', load >= 0 && load <= 100, `sim=${load}%`)
    // the worker is the whole sim (parts, PLC, physics and upkeep), so its line is `sim`; `physics` is one row under it
    check('the worker line is labelled sim, not physics', !/physics\s+\d+%/.test(runningText), JSON.stringify(runningText))
    const m = /sim\s+\d+%\s+([\d.]+) \/ ([\d.]+) ms/.exec(runningText)
    const phys = Number(m?.[1]), budget = Number(m?.[2])
    check('sim line carries ms per step and its budget', Number.isFinite(phys) && Number.isFinite(budget), JSON.stringify(runningText))
    check('ms per step plausible (0 < phys < budget = 1000/60)', phys > 0 && phys < budget && Math.abs(budget - 16.7) < 0.05, `phys=${phys} budget=${budget}`)
    // a frame's ms against the display's refresh interval
    check('render line carries its ms and its budget', /render\s+\d+%\s+[\d.]+ \/ [\d.]+ ms/.test(runningText), JSON.stringify(runningText))
    // the split under `sim` is shown at any load, as one row per cost in ms per step, adding up to the sim
    // line's ms; it names the PLC because a program is attached
    const splitRows = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="stats-sim-split"] > div')].map((d) => d.textContent ?? ''))
    // rows and the sim line read in one evaluate: a meter tick between two reads would compare two windows
    const { rows, shown } = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('[data-testid="stats-sim-split"] > div')].map((d) => d.textContent ?? ''),
      shown: document.querySelector('.stats-overlay')?.textContent ?? '',
    }))
    const labels = rows.map((r) => /^\s*([a-z]+)/.exec(r)?.[1])
    check('sim split rows are parts, plc, physics, upkeep while running',
      JSON.stringify(labels) === JSON.stringify(['parts', 'plc', 'physics', 'upkeep']) && rows.every((r) => /^\s+[a-z]+\s+(<0\.01|\d+\.\d\d) ms$/.test(r)),
      JSON.stringify(rows))
    const rowSum = rows.reduce((a, r) => a + (Number(/(\d+\.\d\d) ms/.exec(r)?.[1]) || 0), 0)
    const simMs = Number(/sim\s+\d+%\s+([\d.]+) \//.exec(shown)?.[1])
    check('sim split rows add up to the sim line ms', Math.abs(rowSum - simMs) <= 0.05, `rows=${rowSum.toFixed(2)} sim=${simMs}`)
    await page.waitForFunction(() => /CPU core/.test(document.querySelector('[data-testid="scene-rate-cost"]')?.textContent ?? ''), { timeout: 10000 }).catch(() => {})
    const cost = await rateText()
    check('rate field states the cost of the run', /At \d+ Hz and normal speed this scene uses .* of one CPU core/.test(cost), JSON.stringify(cost))

    const stats = await page.evaluate(() => ({ ...window.__oip.sim.stepStats }))
    check('stepStats carries plcTotalMs (number)', typeof stats.plcTotalMs === 'number', `stepStats=${JSON.stringify(stats)}`)
    check('plcTotalMs accrued while program attached', stats.plcTotalMs > 0, `plcTotalMs=${stats.plcTotalMs}`)
    check('step counters untouched by scan cost (totalMs excludes plcTotalMs)', stats.totalMs > 0 && stats.steps > 120,
      `totalMs=${stats.totalMs?.toFixed(2)} steps=${stats.steps}`)

    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(700) // a couple of overlay polls
    const after = await overlayText()
    check('sim line GONE after stop', !/sim\s+\d+%/.test(after), JSON.stringify(after))
    check('sim split rows GONE after stop', (await splitRows()).length === 0, JSON.stringify(await splitRows()))

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); vite.kill(); process.exit(1) })
