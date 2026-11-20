// Checks output ownership (ctx.tagDriven) end-to-end on a blade stop wired to a tag, through the full
// hand/auto lifecycle a real panel would show:
//   1. STOPPED (program mode): pilot E hand-cycles the blade via the idle preview. A wired tag does not
//      pin it to a dead tag; the prompt reads "Use".
//   2. RUNNING, tag undriven (no program owns 'Raise'): E still hand-cycles. This is the middle case.
//   3. A program declaring `Raise` as VAR_OUTPUT attaches: it takes over the blade (drops to the commanded
//      false), the prompt changes to "In auto - PLC controlled", and E presses are ignored.
//   4. The program commands TRUE: the blade rises with no hand press.
//   5. The program detaches: ownership releases bumplessly (blade holds its pose), the prompt returns to
//      "Use", and E works again.
//   6. DISCRIMINATION (autoWhenDriven): one program drives both the blade's command tag and a push
//      button's lampTag. The button's lamp is a driven indicator (its press tag is a PLC input), so the
//      button must keep the plain "Use" prompt while the blade (flagged command tag) reads "In auto".
//      Guards against the demo Start button showing "In auto - PLC controlled" off its driven RunLamp.
//   7. The same handoff on the chain transfer pop-up, abbreviated. Guards against a truthiness gate on the
//      tag name (a typed tag name pins it, hand Use dead) and a missing autoWhenDriven (owned → dead "Use").
// Run: node e2e/verify-tag-driven-auto.mjs [--headed]
/* global process, console, window */
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

  // highest blade-mesh world-Y - rises ~0.055 m when the blade actuates (same probe as the idle-preview verify)
  const measure = () => page.evaluate(() => {
    const v = window.__oip.view
    v.scene.updateMatrixWorld(true)
    const root = v.entries?.get('blade_shot')?.visual?.object ?? null
    if (!root) return null
    let max = -Infinity
    root.traverse((o) => { if (o.isMesh) { const y = o.matrixWorld.elements[13]; if (y > max) max = y } })
    return max
  })
  const running = () => page.evaluate(() => window.__oip.store.getState().running)
  const prompt = () => page.evaluate(() => window.__oip.store.getState().pilotPrompt)
  const interact = () => page.evaluate(() => window.__oip.controller.pilotInteract())
  const settle = (ms = 1500) => page.waitForTimeout(ms) // generous: idle use sweeps stretch under headless rAF throttling
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

    // one blade stop wired to tag 'Raise' (the configuration a pin on the wired tag leaves dead to hand
    // presses), plus a push button off to the side for step 6's indicator-tag discrimination
    const havePkg = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.blade-stop')
      const btnPkg = st.getState().bundledPackages.find((p) => p.id === 'oip.push-button')
      if (!pkg || !btnPkg) return false
      const parts = [
        { id: 'blade_shot', type: 'part', packageId: 'oip.blade-stop', position: [0, 0.9, 0], rotationY: 0, params: { width: 0.5, active: false, raiseHeight: 0.06, tag: 'Raise' } },
        { id: 'btn_shot', type: 'part', packageId: 'oip.push-button', position: [1.5, 0.9, 0], rotationY: 0, params: { text: 'START', tag: 'Start', lampSource: 'tag', lampTag: 'RunLamp' } },
      ]
      st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id && p.id !== btnPkg.id), pkg, btnPkg] })
      return true
    })
    check('oip.blade-stop + oip.push-button packages available', havePkg)
    await page.waitForTimeout(2500) // GLB + idle preview settle

    // pilot in, aimed at a part: stand at (x, 0, 1.8) facing -Z and sweep pitch until the crosshair lands
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(300)
    const aimAt = (id, x) => page.evaluate(async ({ id, x }) => {
      const v = window.__oip.view
      v.pilot.pos.set(x, 0, 1.8)
      v.pilot.yaw = 0
      v.pilot.velY = 0
      const frame = () => new Promise((r) => requestAnimationFrame(r))
      for (let pitch = -0.1; pitch >= -1.1; pitch -= 0.025) {
        v.pilot.pitch = pitch
        await frame(); await frame()
        if (v.pilotLookParts().includes(id)) return pitch
      }
      return null
    }, { id, x })
    const aimed = await aimAt('blade_shot', 0)
    check('pilot crosshair lands on the blade stop', aimed !== null, aimed !== null ? `pitch=${aimed.toFixed(2)}` : 'never seen')

    // ── 1. STOPPED (program mode): tag wired, but nothing is driven → hand works, prompt says Use ──
    await settle(300)
    check('STOPPED prompt is "Use" despite a wired tag', (await prompt()) === 'Use', `prompt=${JSON.stringify(await prompt())}`)
    const idleDown = await measure()
    await interact()
    await settle()
    const idleUp = await measure()
    check('STOPPED: E hand-raises a wired blade (idle preview, was dead before tagDriven)', idleUp - idleDown > RAISE, `Δ=${(idleUp - idleDown).toFixed(3)}m`)
    await interact()
    await settle()
    check('STOPPED: second E lowers it back', idleUp - (await measure()) > RAISE)
    check('sim never started at idle', (await running()) === false)

    // ── 2. RUNNING, tag undriven: no attached program declares 'Raise' → still hand-operable ──
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 8000 })
    await settle(1200) // first frames: behavior seeds at the manual latch (down)
    const runDown = await measure()
    check('RUNNING undriven prompt is "Use"', (await prompt()) === 'Use', `prompt=${JSON.stringify(await prompt())}`)
    await interact()
    await settle()
    const runUp = await measure()
    check('RUNNING undriven: E hand-raises (the middle case - tag wired, nobody owns it)', runUp - runDown > RAISE, `Δ=${(runUp - runDown).toFixed(3)}m`)

    // ── 3. a program declaring Raise as an output attaches: auto takes over the blade ──
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Raise : BOOL; END_VAR\nRaise := FALSE;'))
    await settle(1000)
    const seized = await measure()
    check('program attach SEIZES the blade to its commanded FALSE (drops the hand-raised blade)', runUp - seized > RAISE, `Δ=${(runUp - seized).toFixed(3)}m`)
    check('prompt flips to "In auto - PLC controlled"', (await prompt()) === 'In auto - PLC controlled', `prompt=${JSON.stringify(await prompt())}`)
    await interact()
    await settle()
    check('E is ignored while owned (blade stays down)', (await measure()) - seized < 0.01, `Δ=${((await measure()) - seized).toFixed(3)}m`)

    // ── 4. the program commands TRUE: the blade rises with no hand press ──
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Raise : BOOL; END_VAR\nRaise := TRUE;'))
    await settle(1000)
    const autoUp = await measure()
    check('program TRUE raises the blade (auto command)', autoUp - seized > RAISE, `Δ=${(autoUp - seized).toFixed(3)}m`)

    // ── 5. detach: ownership releases bumplessly. The blade holds; prompt and hand control return ──
    await page.evaluate(() => window.__oip.controller.stopProgram())
    await settle(800)
    const released = await measure()
    check('detach releases BUMPLESSLY (blade holds its last commanded pose)', Math.abs(released - autoUp) < 0.01, `Δ=${(released - autoUp).toFixed(3)}m`)
    check('prompt returns to "Use" after detach', (await prompt()) === 'Use', `prompt=${JSON.stringify(await prompt())}`)
    await interact()
    await settle()
    check('E hand-lowers again after release', released - (await measure()) > RAISE, `Δ=${(released - (await measure())).toFixed(3)}m`)

    // ── 6. discrimination: a driven indicator tag must not flag the device as auto ──
    // One program owns both 'Raise' (the blade's autoWhenDriven command tag) and 'RunLamp' (the button's
    // lampTag, a lit indicator). The button's press tag 'Start' is a PLC input nobody drives, so the button
    // stays hand-pressable. Its prompt must read "Use", not "In auto" (the demo-scene regression).
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Raise : BOOL; RunLamp : BOOL; END_VAR\nRaise := FALSE;\nRunLamp := TRUE;'))
    await settle(1000)
    const aimedBtn = await aimAt('btn_shot', 1.5)
    check('pilot crosshair lands on the push button', aimedBtn !== null, aimedBtn !== null ? `pitch=${aimedBtn.toFixed(2)}` : 'never seen')
    await settle(300)
    check('driven lampTag does NOT flag the button: prompt stays "Use"', (await prompt()) === 'Use', `prompt=${JSON.stringify(await prompt())}`)
    const aimedBlade = await aimAt('blade_shot', 0)
    check('…while the same program owns the blade stop via its command tag', aimedBlade !== null && (await settle(300), await prompt()) === 'In auto - PLC controlled', `prompt=${JSON.stringify(await prompt())}`)
    await page.evaluate(() => window.__oip.controller.stopProgram())

    // ── 7. the same handoff on the chain transfer pop-up (tag 'Popup') ──
    // A gate of `popupTag` alone (the truthiness of the tag name) pins the transfer to a typed tag
    // for good, and E goes dead with no program attached. Without the autoWhenDriven flag an owned transfer
    // shows a dead "Use". Shorter than the blade stop's full lifecycle above, because the
    // behaviour-level gate is pinned deterministically in src/sim/chainTransferBehavior.test.ts.
    await page.evaluate(() => window.__oip.store.exitPilot())
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(500)
    await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.chain-transfer')
      const parts = [{ id: 'chain_shot', type: 'part', packageId: 'oip.chain-transfer', position: [0, 0.9, 0], rotationY: 0, params: { chains: 5, distance: 0.33, laneLength: 2, speed: 2, raised: false, speedTag: '', popupTag: 'Popup' } }]
      st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
    })
    await page.waitForFunction(() => {
      let n = 0
      window.__oip.view.entries?.get('chain_shot')?.visual?.object?.traverse((o) => { if (o.isMesh) n++ })
      return n > 2
    }, { timeout: 30000 })
    await page.waitForTimeout(1500)
    // highest chain-lane mesh Y - the bank rises the 0.095 m pop-up stroke when raised
    const chainY = () => page.evaluate(() => {
      const v = window.__oip.view
      v.scene.updateMatrixWorld(true)
      const root = v.entries?.get('chain_shot')?.visual?.object ?? null
      if (!root) return null
      let max = -Infinity
      root.traverse((o) => { if (o.isMesh) { const y = o.matrixWorld.elements[13]; if (y > max) max = y } })
      return max
    })
    const POP = 0.05 // pass threshold in metres (full stroke = 0.095)
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(300)
    const aimedChain = await aimAt('chain_shot', 0)
    check('pilot crosshair lands on the chain transfer', aimedChain !== null, aimedChain !== null ? `pitch=${aimedChain.toFixed(2)}` : 'never seen')
    await settle(300)
    check('CHAIN STOPPED prompt is "Use" despite a tag set', (await prompt()) === 'Use', `prompt=${JSON.stringify(await prompt())}`)
    const chainDown = await chainY()
    await interact()
    await settle()
    const chainUp = await chainY()
    check('CHAIN STOPPED: E hand-pops a wired transfer (was dead - pinned to an undriven tag)', chainUp - chainDown > POP, `Δ=${(chainUp - chainDown).toFixed(3)}m`)

    // a program declaring Popup as an output attaches: auto takes over the pop-up and the prompt changes
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 8000 })
    await settle(1200)
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Popup : BOOL; END_VAR\nPopup := FALSE;'))
    await settle(1000)
    const chainSeized = await chainY()
    check('CHAIN: program attach SEIZES the pop-up to its commanded FALSE', chainUp - chainSeized > POP, `Δ=${(chainUp - chainSeized).toFixed(3)}m`)
    check('CHAIN prompt flips to "In auto - PLC controlled" (autoWhenDriven on popupTag)', (await prompt()) === 'In auto - PLC controlled', `prompt=${JSON.stringify(await prompt())}`)
    await interact()
    await settle()
    check('CHAIN: E is ignored while owned (chains stay down)', (await chainY()) - chainSeized < 0.01, `Δ=${((await chainY()) - chainSeized).toFixed(3)}m`)
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Popup : BOOL; END_VAR\nPopup := TRUE;'))
    await settle(1000)
    check('CHAIN: program TRUE pops the chains up (auto command, no hand press)', (await chainY()) - chainSeized > POP, `Δ=${((await chainY()) - chainSeized).toFixed(3)}m`)
    await page.evaluate(() => window.__oip.controller.stopProgram())
    await settle(800)
    check('CHAIN prompt returns to "Use" after detach', (await prompt()) === 'Use', `prompt=${JSON.stringify(await prompt())}`)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
