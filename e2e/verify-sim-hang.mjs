// A part whose code never returns, in a running simulation (docs/part-sandbox.md, "Hangs in the simulation"). The
// loop budget stops loops, not deep recursion; the sim client's watchdog (sim/client.ts) sees no frame for 10 s, reads
// which part the worker was in (core/parts/partScript.ts hang beacon), ends the worker and says so.
//
//   1. the part runs for a second, then its step() starts a recursion that would take hours
//   2. within the watchdog's window the run is stopped and the alert names the part
//   3. the editor stays usable, and the next Play starts a fresh worker that runs
//
//   node e2e/verify-sim-hang.mjs [--headed]
/* global window, localStorage, console, process */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

const HANG = `
let steps = 0
function grow(n) { return n <= 0 ? 0 : grow(n - 1) + grow(n - 1) }
definePart({ step(ctx) { if (++steps > 60) grow(48) } })
`

const { port } = await startServer()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const alerts = []
page.on('dialog', (d) => {
  alerts.push({ at: Date.now(), message: d.message() })
  void d.dismiss()
})

try {
  await page.goto(`http://localhost:${port}/app/`)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 120000 })

  // the part, made from a box's shape, in the project's library and placed
  await page.evaluate((behavior) => {
    const { store, registerPackage } = window.__oip
    const pkg = {
      id: 'u.tester.hang',
      name: 'Hang test',
      params: {},
      behavior,
      geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.4, 0.4, 0.4] }, offset: [0, 0.2, 0] }], joints: [] },
    }
    registerPackage(pkg)
    store.addUserPackage(pkg)
    const s = store.getState()
    store.commit('Place the hang test', { ...s.scene, packages: [...(s.scene.packages ?? []), pkg], parts: [...s.scene.parts, { id: 'hang_1', type: 'part', packageId: pkg.id, name: 'Hang test', position: [0, 0, 0], rotationY: 0, params: {} }] })
  }, HANG)

  // ── 1-2. run it: the watchdog stops the run and names the part ─────────────────────────────────
  const started = Date.now()
  await page.evaluate(() => window.__oip.controller.run())
  const deadline = Date.now() + 45000
  while (alerts.length === 0 && Date.now() < deadline) await page.waitForTimeout(250)
  const alert = alerts[0]
  check('the stuck run is stopped with an alert', alert !== undefined, alert ? `${((alert.at - started) / 1000).toFixed(1)} s after Run` : 'no alert in 45 s')
  check('...naming the part it was stuck in', alert?.message.includes('Hang test (u.tester.hang)') ?? false, alert?.message)
  const running = await page.evaluate(() => window.__oip.sim.running)
  check('the simulation reads as stopped', running === false)

  // ── 3. the editor goes on, and the next Play makes a fresh worker that runs ────────────────────
  await page.evaluate(() => {
    const { store } = window.__oip
    const s = store.getState()
    store.commit('Remove the hang test', { ...s.scene, parts: s.scene.parts.filter((p) => p.id !== 'hang_1') })
  })
  check('the editor still takes edits', await page.evaluate(() => !window.__oip.store.getState().scene.parts.some((p) => p.id === 'hang_1')))
  await page.evaluate(() => window.__oip.controller.run())
  const ran = await page
    .waitForFunction(() => (window.__oip.view.boxes.appliedFrame?.simTime ?? 0) > 1, null, { timeout: 60000 })
    .then(() => true)
    .catch(() => false)
  check('the next Play runs in a fresh worker', ran)
  await page.evaluate(() => window.__oip.controller.stop())
  check('no other alert', alerts.length === 1, alerts.slice(1).map((a) => a.message).join(' | '))
} catch (e) {
  failures++
  console.log(`FAIL  ${e instanceof Error ? e.message : e}`)
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
