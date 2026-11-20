// A program's own tags bind by wiring, in the running app (plc/wiring.ts wiredBindings).
//
// The program below declares no direction on anything: `Eye` and `Run` are plain VARs, with no
// direction of their own. The parts give it: the eye publishes Eye, so Eye is the program's input; the
// belt only reads Run, so Run is its output, which it owns. If only VAR_INPUT / VAR_OUTPUT crossed the
// bus, this program would compile, attach, and never see the eye: the box would ride straight past it.
//
// Two phases, because they fail differently:
//   1. wired from the start: the box must stop at the eye, and the attach must report nothing unwired;
//   2. the eye wired during the run, as a user does from the Inspector: the running program must pick it up
//      then, the way a declared VAR_INPUT always has, not at the next Play (controller.rebindProgram).
//
// Timing is read off the sim's own clock (frame.simTime), not the wall: the box needs ~5.6 s of sim time to
// reach the eye at 0.5 m/s, however slowly a headless worker steps.

import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const PROGRAM = `VAR
  Eye : BOOL;
  Run : BOOL;
END_VAR
Run := NOT Eye;`

// the eye 3 m along a 5 m belt; a box dropped near the tail rides into its beam
const EYE_X = 3
const BOX_HALF = 0.2 // the box is 0.4 m long, so its leading face is 0.2 m ahead of its centre
const REST_WINDOW = [2.4, EYE_X] // where a box stopped by the eye comes to rest (its leading face at the beam)

let failures = 0
function expect(ok, what) {
  if (ok) console.log('  ok:', what)
  else {
    failures++
    console.error('  FAIL:', what)
  }
}

const { url, vite } = await startServer()
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.controller), null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })

  /** load the cell with the eye wired to `eyeTag` ('' = not wired yet), attach the program, press Play */
  const start = (eyeTag) =>
    page.evaluate(
      ({ program, eyeTag, eyeX }) => {
        const c = window.__oip.controller
        if (window.__oip.store.getState().running) c.stop()
        const st = window.__oip.store
        const pkgs = st.getState().bundledPackages
        const need = ['oip.belt-conveyor', 'oip.box', 'oip.diffuse-sensor'].map((id) => pkgs.find((p) => p.id === id))
        if (need.some((p) => !p)) return 'a bundled package is missing'
        st.loadScene({
          version: st.getState().scene.version,
          parts: [
            { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0,
              params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Run' } },
            { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
            { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [eyeX, 0.75, -0.6], rotationY: 0,
              params: { maxRange: 1.2, tag: eyeTag } },
          ],
          packages: need,
        })
        st.setStProgram(program)
        st.setState({ selectedIds: [] })
        c.run()
        return true
      },
      { program: PROGRAM, eyeTag, eyeX: EYE_X },
    )

  const simTime = () => page.evaluate(() => window.__oip.controller.lastFrame?.simTime ?? 0)
  const boxX = () => page.evaluate(() => window.__oip.controller.livePosition('box')?.[0] ?? Number.NaN)
  /** the box's x and the sim time of the same frame: a read arrives later than the time it waited for */
  const sample = () => page.evaluate(() => ({ t: window.__oip.controller.lastFrame?.simTime ?? 0, x: window.__oip.controller.livePosition('box')?.[0] ?? Number.NaN }))
  const untilSim = (t) =>
    page.waitForFunction((t) => (window.__oip.controller.lastFrame?.simTime ?? 0) >= t, t, { timeout: 120000, polling: 100 })

  /** the box rests at the eye: inside the window, and still over a second of sim time */
  async function stoppedAtEye(what) {
    await untilSim(9)
    const a = await boxX()
    const t0 = await simTime()
    await untilSim(t0 + 1)
    const b = await boxX()
    expect(a > REST_WINDOW[0] && a < REST_WINDOW[1], `${what}: the box stopped at the eye (x = ${a.toFixed(3)} m)`)
    expect(Math.abs(b - a) < 0.01, `${what}: and stays there (moved ${(b - a).toFixed(4)} m in 1 s of sim time)`)
  }

  console.log('--- 1: wired from the start ---')
  const loaded = await start('Eye')
  expect(loaded === true, `the cell loads and runs (${loaded})`)
  await untilSim(0.5)
  const status = await page.evaluate(() => window.__oip.controller.programStatus)
  expect(status.attached && status.error === null, `the program attached (${status.error ?? 'no error'})`)
  expect(status.unwired.length === 0 && status.unbound.length === 0, `nothing reported unwired or unbound (unwired: ${status.unwired.join(', ') || '-'}; unbound: ${status.unbound.join(', ') || '-'})`)
  expect(!status.warnings.some((w) => /drives no device/.test(w)), `the program is known to drive the belt (${status.warnings.join(' | ') || 'no warnings'})`)
  await stoppedAtEye('wired from the start')

  console.log('--- 2: the eye wired during the run ---')
  expect((await start('')) === true, 'the cell runs again with the eye not wired')
  await untilSim(0.8)
  const a = await sample()
  await untilSim(a.t + 0.5)
  const b = await sample()
  expect(b.x - a.x > 0.1, `the program runs the belt with no eye (the box moved ${(b.x - a.x).toFixed(3)} m in ${(b.t - a.t).toFixed(2)} s)`)
  // wire the eye the way an Inspector edit does: one committed scene change, while the box is still short of it
  const at = await page.evaluate(() => {
    const st = window.__oip.store
    const scene = st.getState().scene
    st.commit('wire the eye', { ...scene, parts: scene.parts.map((p) => (p.id === 'eye' ? { ...p, params: { ...p.params, tag: 'Eye' } } : p)) })
    const c = window.__oip.controller
    return { t: c.lastFrame?.simTime ?? 0, x: c.livePosition('box')?.[0] ?? Number.NaN }
  })
  const gap = EYE_X - (at.x + BOX_HALF)
  expect(gap > 0.1, `the eye was wired before the box reached its beam (t = ${at.t.toFixed(2)} s, ${gap.toFixed(3)} m short)`)
  await stoppedAtEye('wired mid-run')

  expect(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  await browser.close()
  vite.kill()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall wiring-binding checks passed')
