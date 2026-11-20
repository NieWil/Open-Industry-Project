// Verifies Step (commands.ts sim.step): a paused run advances by exactly one fixed physics step per press, with
// the PLC scans due in it, and nothing else moves it.
//   - paused, the sim clock holds (the control: without it a "step" could just be the loop still running)
//   - Shift+Period advances simTime by one step: more than 0, at most 1/60 s (the slowest rate a project can choose)
//   - five clicks on the Watch dock's Step button advance it by five times that, and the program scans across them
//   - the frame after a Step carries a fresh variable table, so the Watch dock shows what the step did
//   - running, the Watch dock's Step button is greyed with the reason in its tooltip, and Shift+Period leaves the
//     run alone; stopped, the button is gone (there is no run to step)
// Uses the demo project, which runs a PLC program. Run: node e2e/verify-sim-step.mjs
/* global process, console, window, document, localStorage, HTMLElement */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { url: BASE, vite } = await startServer()

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      /* storage disabled: the tour just shows up */
    }
  })
  await page.goto(`${BASE}?scene=demo`)
  await page.waitForFunction(() => !!(window.__oip?.controller && window.__oip.sim && window.__oip.store.getState().scene.parts.length > 0), null, { timeout: 60000 })

  const read = () =>
    page.evaluate(() => {
      const { store, sim } = window.__oip
      const s = store.getState()
      return {
        running: s.running,
        paused: s.paused,
        simTime: window.__oip.view.lastFrameSimTime,
        scans: sim.plcState?.scansRun ?? null,
        step: (() => {
          const b = document.querySelector('[data-testid="plc-watch-step"]')
          return b ? { disabled: b.disabled, title: b.title } : null
        })(),
      }
    })
  const blur = () => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
  // a Step lands on the worker's next tick and its frame a moment later; wait for the frame, not a fixed time
  const settle = async (from) => {
    await page.waitForFunction((t) => window.__oip.view.lastFrameSimTime !== t, from, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(150)
    return read()
  }

  await page.evaluate(() => window.__oip.store.revealPanel('watch'))
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => (window.__oip.sim.plcState?.scansRun ?? 0) > 10 && window.__oip.view.lastFrameSimTime > 0.5, null, { timeout: 60000 })
  let s = await read()
  check('running: the Step button is shown greyed', s.running && !s.paused && s.step?.disabled === true)
  check('... and its tooltip says to pause', /Pause the simulation/.test(s.step?.title ?? ''), s.step?.title)

  await page.evaluate(() => window.__oip.controller.togglePause())
  await page.waitForTimeout(400)
  const p0 = await read()
  await page.waitForTimeout(600)
  const p1 = await read()
  check('paused: the sim clock holds', p0.paused && p1.simTime === p0.simTime, `${p0.simTime} -> ${p1.simTime}`)
  check('paused: the Step button is enabled', p1.step?.disabled === false, p1.step?.title)

  // one press of the key
  await blur()
  const watchBefore = await page.evaluate(() => {
    window.__stepWatch = window.__oip.sim.plcState?.watch ?? null
    return window.__stepWatch !== null
  })
  await page.keyboard.press('Shift+Period')
  const k1 = await settle(p1.simTime)
  const dt = k1.simTime - p1.simTime
  check('Shift+Period advances one step', dt > 0 && dt <= 1 / 60 + 1e-9, `dt=${dt.toFixed(6)} s`)
  check('... and stays paused', k1.running && k1.paused)
  const watchFresh = await page.evaluate(() => window.__oip.sim.plcState?.watch !== window.__stepWatch)
  check('the stepped frame carries a fresh variable table', watchBefore && watchFresh)

  // five clicks on the Watch dock's button
  const before5 = await read()
  for (let i = 0; i < 5; i++) {
    await page.locator('[data-testid="plc-watch-step"]').click()
    // wait for this click's frame (half a step past the previous one), so no two clicks share a worker tick
    await page.waitForFunction((t) => window.__oip.view.lastFrameSimTime > t, before5.simTime + (i + 0.5) * dt, { timeout: 5000 }).catch(() => {})
  }
  await page.waitForTimeout(300)
  const c5 = await read()
  const d5 = c5.simTime - before5.simTime
  check('five clicks advance exactly five steps', Math.abs(d5 - 5 * dt) < 1e-6, `${d5.toFixed(6)} s vs 5 x ${dt.toFixed(6)}`)
  check('the program scanned across them', c5.scans !== null && before5.scans !== null && c5.scans > before5.scans, `scans ${before5.scans} -> ${c5.scans}`)
  await page.waitForTimeout(500)
  check('nothing advances after the last step', (await read()).simTime === c5.simTime)

  // running again: the key does nothing to the run
  await page.evaluate(() => window.__oip.controller.togglePause())
  await page.waitForTimeout(300)
  await blur()
  await page.keyboard.press('Shift+Period')
  await page.waitForTimeout(300)
  s = await read()
  check('running: Shift+Period leaves the run running', s.running && !s.paused && s.simTime > c5.simTime)
  check('running: the Step button is greyed again', s.step?.disabled === true)

  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(300)
  s = await read()
  check('stopped: the Step button is gone', !s.running && s.step === null)
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
