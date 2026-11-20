// Verify the editor-mode "In auto - PLC controlled" viewport hint (the C-press counterpart of the
// pilot crosshair prompt). Ownership is invisible state, so a press ignored by a script's auto
// gate must say so:
//   1. RUNNING, tag undriven: C on a selected comms-on blade stop hand-raises it, with no hint (the
//      press takes effect, nobody owns the tag).
//   2. A program declaring 'Raise' as VAR_OUTPUT attaches: C is dead (auto overwrites the press) and
//      the .viewport-hint badge flashes 'In auto - PLC controlled'.
//   3. The hint auto-dismisses (~2.2 s).
//   4. Multi-select: two owned blades under one C read '2 in auto - PLC controlled'.
//   5. Program detaches: C hand-cycles again, no hint.
// Run: node e2e/verify-use-in-auto-hint.mjs [--headed]
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  const waitForApp = () => page.waitForFunction(
    () => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })

  // highest blade-mesh world-Y - rises ~0.055 m when the blade actuates (same probe as verify-tag-driven-auto)
  const measure = (id) => page.evaluate((id) => {
    const v = window.__oip.view
    v.scene.updateMatrixWorld(true)
    const root = v.entries?.get(id)?.visual?.object ?? null
    if (!root) return null
    let max = -Infinity
    root.traverse((o) => { if (o.isMesh) { const y = o.matrixWorld.elements[13]; if (y > max) max = y } })
    return max
  }, id)
  const hintDom = () => page.evaluate(() => document.querySelector('.viewport-hint')?.textContent ?? null)
  const hintState = () => page.evaluate(() => window.__oip.store.getState().viewportHint?.text ?? null)
  const settle = (ms = 1500) => page.waitForTimeout(ms) // generous: sweeps stretch under headless rAF throttling
  const RAISE = 0.03 // pass threshold in metres (full stroke ≈ 0.055)

  try {
    await page.goto(URL)
    await waitForApp()
    await page.waitForTimeout(1000)
    // Warm-up (e2e gotcha): the first real ST compile pulls deps a cold vite hasn't optimized yet, which
    // triggers a mid-test full reload (see oip-web-e2e-vite-reoptimize-reload). Compile a throwaway program
    // now, wait out any reload, then start clean, so later runProgram calls stay on-page.
    await page.evaluate(() => {
      try { window.__oip.controller.runProgram('VAR_OUTPUT Warm : BOOL; END_VAR\nWarm := FALSE;') } catch { /* compile-path warm-up only */ }
      try { window.__oip.controller.stopProgram() } catch { /* ditto */ }
    })
    await page.waitForTimeout(1500)
    await waitForApp()
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp()
    await page.waitForTimeout(800)

    // two comms-enabled blade stops sharing command tag 'Raise' (the second exists only for the
    // multi-select count in step 4)
    const havePkg = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.blade-stop')
      if (!pkg) return false
      const params = { width: 0.5, active: false, raiseHeight: 0.06, tag: 'Raise' }
      const parts = [
        { id: 'blade_a', type: 'part', name: 'Blade A', packageId: 'oip.blade-stop', position: [0, 0.9, 0], rotationY: 0, params: { ...params } },
        { id: 'blade_b', type: 'part', name: 'Blade B', packageId: 'oip.blade-stop', position: [1.2, 0.9, 0], rotationY: 0, params: { ...params } },
      ]
      st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
      return true
    })
    check('oip.blade-stop package available', havePkg)
    await page.waitForTimeout(2500) // GLB + idle preview settle

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 8000 })
    await settle(1200) // first frames: behavior seeds at the manual latch (down)

    // ── 1. RUNNING, tag undriven: C hand-raises, no hint ──
    await page.evaluate(() => window.__oip.store.select('blade_a'))
    const runDown = await measure('blade_a')
    await page.keyboard.press('c')
    await settle()
    const runUp = await measure('blade_a')
    check('undriven: C hand-raises the blade', runUp - runDown > RAISE, `Δ=${(runUp - runDown).toFixed(3)}m`)
    // sampled after the settle: the raise above shows the press was processed (headless input lag can
    // defer the keydown by seconds), and a wrong flash would still be inside its 2.2 s dismiss window
    check('undriven: no hint on C (press lands)', (await hintDom()) === null && (await hintState()) === null, `dom=${JSON.stringify(await hintDom())}`)

    // ── 2. a program declaring Raise as an output attaches: C is dead, hint flashes ──
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Raise : BOOL; END_VAR\nRaise := FALSE;'))
    await settle(1000)
    const seized = await measure('blade_a')
    check('program attach SEIZES the blade (drops the hand-raised blade)', runUp - seized > RAISE, `Δ=${(runUp - seized).toFixed(3)}m`)
    await page.keyboard.press('c')
    const sawHint = await page.waitForFunction(
      () => document.querySelector('.viewport-hint')?.textContent === 'In auto - PLC controlled', { timeout: 1500 }).then(() => true, () => false)
    check('owned: C flashes "In auto - PLC controlled"', sawHint, `dom=${JSON.stringify(await hintDom())} state=${JSON.stringify(await hintState())}`)
    await settle()
    check('owned: C is ignored (blade stays down)', (await measure('blade_a')) - seized < 0.01, `Δ=${((await measure('blade_a')) - seized).toFixed(3)}m`)

    // ── 3. the hint auto-dismisses ──
    const dismissed = await page.waitForFunction(
      () => !document.querySelector('.viewport-hint'), { timeout: 4000 }).then(() => true, () => false)
    check('hint auto-dismisses', dismissed && (await hintState()) === null)

    // ── 4. multi-select: two owned blades under one C read a count ──
    await page.evaluate(() => window.__oip.store.selectMany(['blade_a', 'blade_b']))
    await page.keyboard.press('c')
    const sawCount = await page.waitForFunction(
      () => document.querySelector('.viewport-hint')?.textContent === '2 in auto - PLC controlled', { timeout: 1500 }).then(() => true, () => false)
    check('multi-select: hint reads "2 in auto - PLC controlled"', sawCount, `dom=${JSON.stringify(await hintDom())}`)

    // ── 5. detach: ownership releases, C hand-cycles again, no hint ──
    await page.evaluate(() => window.__oip.controller.stopProgram())
    await settle(800)
    await page.waitForFunction(() => !document.querySelector('.viewport-hint'), { timeout: 4000 }).catch(() => {})
    await page.evaluate(() => window.__oip.store.select('blade_a'))
    const released = await measure('blade_a')
    await page.keyboard.press('c')
    await settle()
    check('after detach: C hand-raises again', (await measure('blade_a')) - released > RAISE, `Δ=${((await measure('blade_a')) - released).toFixed(3)}m`)
    // after the settle, like step 1: the raise shows the press ran; a wrong flash would still be visible
    check('after detach: no hint on C', (await hintDom()) === null && (await hintState()) === null, `dom=${JSON.stringify(await hintDom())}`)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
