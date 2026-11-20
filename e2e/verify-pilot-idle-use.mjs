// Verify pilot idle Use: while the sim is stopped, the pilot crosshair prompt on an interactive
// custom part reads "Use" (not "Press Play to use"), and the interact key actuates the device through
// its live stopped-scene session (pilotInteract → idleUsePart → controller.useSessions → view.applyIdlePose).
// The toggle must be two-way and must never start the sim.
//
// It must never be an edit: Use operates a device in every mode. On a device that declares its hand
// state (useParam, the blade stop's `active`) the character's press leaves the param, the undo stack and
// the saved document alone. The press latches, the same as the editor's C (one model), and persists after
// walk mode: the device stays as the character left it, the Inspector lists it as operated, and Reset puts
// it back to its param. (A commit here would make a walk through the demo view fork it; see verify-walk-session.mjs.)
// Run: node e2e/verify-pilot-idle-use.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function main() {
  mkdirSync('e2e/shots', { recursive: true })
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  const waitForApp = () => page.waitForFunction(
    () => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })

  // highest mesh world-Y of the blade stop's rig - rises when the blade actuates (same probe as
  // verify-bladestop-idle-preview.mjs)
  const measure = () => page.evaluate(() => {
    const v = window.__oip.view
    v.scene.updateMatrixWorld(true)
    const root = v.entries?.get('blade_shot')?.visual?.object ?? null // TS-private map, reachable at runtime
    if (!root) return null
    let max = -Infinity, n = 0
    root.traverse((o) => { if (o.isMesh) { const y = o.matrixWorld.elements[13]; if (y > max) max = y; n++ } })
    return { max, n }
  })

  const running = () => page.evaluate(() => window.__oip.store.getState().running)
  const prompt = () => page.evaluate(() => window.__oip.store.getState().pilotPrompt)
  const interact = () => page.evaluate(() => window.__oip.controller.pilotInteract())

  try {
    await page.goto(URL)
    await waitForApp()
    await page.waitForTimeout(1000)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp()
    await page.waitForTimeout(800)

    // a single lowered blade stop at walkable deck height; the sim is never started
    const havePkg = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.blade-stop')
      if (!pkg) return false
      const parts = [{ id: 'blade_shot', type: 'part', packageId: 'oip.blade-stop', position: [0, 0.9, 0], rotationY: 0, params: { width: 0.5, active: false, raiseHeight: 0.06, tag: '' } }]
      st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
      return true
    })
    check('oip.blade-stop package available', havePkg)
    await page.waitForTimeout(2500) // GLB nodes + idle preview settle

    const down = await measure()
    check('blade stop rendered (idle, lowered)', !!down && down.n >= 2, down ? `meshes=${down.n}` : 'no root')

    // enter pilot mode ~1.8 m from the part, then scan pitch until the crosshair lands on it
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(300)
    const aimed = await page.evaluate(async () => {
      const v = window.__oip.view
      v.pilot.pos.set(0, 0, 1.8) // yaw 0: forward = -Z, toward the part at the origin
      v.pilot.yaw = 0
      v.pilot.velY = 0
      const frame = () => new Promise((r) => requestAnimationFrame(r))
      for (let pitch = -0.1; pitch >= -1.1; pitch -= 0.05) {
        v.pilot.pitch = pitch
        await frame(); await frame() // crosshair cache + prompt refresh run per rendered frame
        if (v.pilotLookParts().includes('blade_shot')) return pitch
      }
      return null
    })
    check('pilot crosshair lands on the blade stop', aimed !== null, aimed !== null ? `pitch=${aimed.toFixed(2)}` : 'never seen in pitch scan')
    check('sim is stopped', (await running()) === false)

    await page.waitForTimeout(300) // a few more frames of updatePilotPrompt
    const p0 = await prompt()
    check('prompt reads "Use" while STOPPED (was "Press Play to use")', p0 === 'Use', `prompt=${JSON.stringify(p0)}`)
    await page.screenshot({ path: 'e2e/shots/pilot-idle-use-prompt.png' }) // raw: the HUD prompt is what this captures

    // what "not an edit" is measured against: the param, the undo stack, and the saved document
    const active = () => page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'blade_shot')?.params.active)
    const canUndo = () => page.evaluate(() => window.__oip.store.canUndo)
    const savedDoc = () => page.evaluate(async () => (await window.__oip.savedProject()))
    const doc0 = await savedDoc()
    check('the saved document holds the blade stop lowered (so an unchanged doc means something)',
      !!doc0 && doc0.includes('blade_shot'), doc0 ? `${doc0.length} chars` : 'no doc')

    // interact (E): the idle hand-cycle must raise the blade without starting the sim and without
    // committing the declared hand param (useParam:'active'); the press is a walk-session preview pulse.
    await interact()
    await page.waitForTimeout(1500) // the 0.15s use sweep can take longer under headless rAF throttling
    const up = await measure()
    const active1 = await active()
    check('sim STILL stopped after pilot Use', (await running()) === false)
    check('pilot Use RAISES the blade while stopped', !!up && !!down && up.max - down.max > 0.03, up && down ? `Δmax=${(up.max - down.max).toFixed(3)}m` : 'no measure')
    check('pilot Use does NOT commit the hand param (walk mode is a session)', active1 === false, `active=${active1}`)
    check('pilot Use leaves nothing to undo', (await canUndo()) === false)
    check('pilot Use leaves the saved document untouched', (await savedDoc()) === doc0)
    await page.screenshot({ path: 'e2e/shots/pilot-idle-use-raised.png' })

    // second press toggles back (parity with the running behavior and the C key)
    await interact()
    await page.waitForTimeout(1500)
    const back = await measure()
    check('second pilot Use TOGGLES the blade back down', !!back && !!up && up.max - back.max > 0.03, back && up ? `Δmax=${(up.max - back.max).toFixed(3)}m` : 'no measure')

    // raise it once more, then leave walk mode: Use is one model in and out of it, so the blade stays raised,
    // and the store lists it as operated (what the Inspector reads to say so and offer Reset)
    await interact()
    await page.waitForTimeout(1500)
    const up2 = await measure()
    check('third pilot Use raises it again', !!up2 && !!down && up2.max - down.max > 0.03, up2 && down ? `Δmax=${(up2.max - down.max).toFixed(3)}m` : 'no measure')
    await page.evaluate(() => window.__oip.store.exitPilot())
    await page.waitForTimeout(1000)
    const after = await measure()
    const usedAfter = await page.evaluate(() => window.__oip.store.getState().usedIds)
    check('leaving walk mode keeps the blade where the character left it (raised)',
      !!after && !!up2 && Math.abs(after.max - up2.max) < 0.01, after && up2 ? `Δ vs raised=${(after.max - up2.max).toFixed(3)}m` : 'no measure')
    check('...and lists it as operated, for the Inspector', usedAfter.includes('blade_shot'), JSON.stringify(usedAfter))

    // the editor's C continues the same session: one press lowers it back to its authored state, so the session ends
    await page.evaluate(() => { window.__oip.store.setState({ selectedIds: ['blade_shot'] }); window.__oip.controller.useSelection() })
    await page.waitForTimeout(3000) // the sweep, then the idle period a session waits before it ends
    const cLowered = await measure()
    const usedAfterC = await page.evaluate(() => window.__oip.store.getState().usedIds)
    check('the editor C continues the same session: it lowers the blade', !!cLowered && !!down && Math.abs(cLowered.max - down.max) < 0.01,
      cLowered && down ? `Δ vs authored=${(cLowered.max - down.max).toFixed(3)}m` : 'no measure')
    check('...back at its design, the session ends and nothing is listed as operated', !usedAfterC.includes('blade_shot'), JSON.stringify(usedAfterC))

    // raise it with C, then Reset (the Inspector's button): back to the param, still not an edit
    await page.evaluate(() => window.__oip.controller.useSelection())
    await page.waitForTimeout(1500)
    const cRaised = await measure()
    check('C raises it again, and it stays raised', !!cRaised && !!down && cRaised.max - down.max > 0.03, cRaised && down ? `Δmax=${(cRaised.max - down.max).toFixed(3)}m` : 'no measure')
    await page.evaluate(() => window.__oip.controller.resetUse('blade_shot'))
    await page.waitForTimeout(800)
    const reset = await measure()
    check('Reset puts it back to its param (lowered)', !!reset && !!down && Math.abs(reset.max - down.max) < 0.01,
      reset && down ? `Δ vs authored=${(reset.max - down.max).toFixed(3)}m` : 'no measure')
    check('and the param, the undo stack and the saved document are still untouched',
      (await active()) === false && (await canUndo()) === false && (await savedDoc()) === doc0)
    check('sim never started', (await running()) === false)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    console.log(`\nheights: down=${down?.max?.toFixed(3)} up=${up?.max?.toFixed(3)} back=${back?.max?.toFixed(3)} after-exit=${after?.max?.toFixed(3)}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
