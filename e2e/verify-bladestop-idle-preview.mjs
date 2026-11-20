// Verify the static idle actuation preview: while the sim is stopped, toggling a blade stop's `active`
// param must raise the blade on screen, so an author can see a device actuate to check placement without
// pressing Play. (verify-bladestop-sdk.mjs covers the running path with controller.run().) This script never runs
// the sim: it drives the param and measures the blade meshes' world height, asserting they rise on toggle
// and drop back off - all through the real store → controller.refreshIdlePoses → view.applyIdlePose path.
// Run: node e2e/verify-bladestop-idle-preview.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
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

  // load a scene with a single blade stop at the given `active`, without running the sim. Returns the
  // part's mesh world-height stats so a raise is measurable (the blade sections ride up on `active`).
  const setActive = (active) => page.evaluate((active) => {
    const st = window.__oip.store
    const scene = st.getState().scene
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.blade-stop')
    const parts = [{ id: 'blade_shot', type: 'part', packageId: 'oip.blade-stop', position: [0, 1.2, 0], rotationY: 0, params: { width: 0.5, active, raiseHeight: 0.06, tag: '' } }]
    st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
    st.setState({ selectedIds: [] })
    return !!pkg
  }, active)

  const measure = () => page.evaluate(() => {
    const v = window.__oip.view
    v.scene.updateMatrixWorld(true)
    const root = v.entries?.get('blade_shot')?.visual?.object ?? null // TS-private map, reachable at runtime
    if (!root) return null
    let max = -Infinity, n = 0
    root.traverse((o) => { if (o.isMesh) { const y = o.matrixWorld.elements[13]; if (y > max) max = y; n++ } })
    return { max, n }
  })

  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    // sanity: the sim must stay stopped the entire time (the feature is idle-only)
    const running = () => page.evaluate(() => window.__oip.store.getState().running)

    setActive(false)
    await page.waitForTimeout(2500) // let the GLB nodes load + the idle preview settle
    const down = await measure()
    // a root with meshes exists (full 8-node completeness is covered by verify-bladestop-sdk.mjs; the GLB may
    // still be streaming this early on a cold WebGL start - the raise deltas below are the real signal)
    check('blade stop rendered (idle, active off)', !!down && down.n >= 2, down ? `meshes=${down.n}` : 'no root')
    check('sim is stopped', (await running()) === false)
    await cleanShot(page, 'e2e/shots/bladestop-idle-down.png')

    setActive(true)
    await page.waitForTimeout(2500) // No run() - the idle preview alone must raise the blade
    const up = await measure()
    check('sim STILL stopped after toggling active', (await running()) === false)
    check('blade RISES while stopped when active is toggled on', !!up && !!down && up.max - down.max > 0.03, up && down ? `Δmax=${(up.max - down.max).toFixed(3)}m` : 'no measure')
    await cleanShot(page, 'e2e/shots/bladestop-idle-up.png')

    setActive(false)
    await page.waitForTimeout(2500)
    const back = await measure()
    check('blade DROPS back when active is toggled off (not a one-way latch)', !!back && !!up && up.max - back.max > 0.03, back && up ? `Δmax=${(up.max - back.max).toFixed(3)}m` : 'no measure')

    // ── C key ("Use") while stopped operates the blade's live session (controller.useSelection, the case 'c' handler) ──
    // the running sim's sim.usePart path is dead at idle, so the press goes to a live instance of the blade's own
    // behavior: it rises and stays up, as it would in a run, and a second press drops it. `active` stays as
    // authored throughout: Use operates a device, the starting state is the param above.
    const press = () => page.evaluate(() => {
      window.__oip.store.setState({ selectedIds: ['blade_shot'] })
      window.__oip.controller.useSelection()
    })
    const activeNow = () => page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'blade_shot')?.params.active)
    await press()
    await page.waitForTimeout(1500)
    const cUp = await measure()
    await page.waitForTimeout(1500)
    const cHeld = await measure()
    check('sim STILL stopped after Use (C)', (await running()) === false)
    check('C key RAISES the blade while stopped', !!back && !!cUp && cUp.max - back.max > 0.03, back && cUp ? `Δ=${(cUp.max - back.max).toFixed(3)}m` : 'no measure')
    check('...and it STAYS up: a press leaves the device where a press leaves it', !!cHeld && !!cUp && Math.abs(cHeld.max - cUp.max) < 0.005, cHeld && cUp ? `Δheld=${(cHeld.max - cUp.max).toFixed(4)}m` : 'no measure')
    check('...leaving `active` as authored (Use never writes it)', (await activeNow()) === false, `active=${await activeNow()}`)
    await press()
    await page.waitForTimeout(1500)
    const cDown = await measure()
    check('a second C brings it back DOWN', !!cDown && !!back && Math.abs(cDown.max - back.max) < 0.005, cDown && back ? `Δend=${(cDown.max - back.max).toFixed(4)}m` : 'no measure')

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    console.log(`\nheights: down.max=${down?.max?.toFixed(3)} up.max=${up?.max?.toFixed(3)} back.max=${back?.max?.toFixed(3)}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
