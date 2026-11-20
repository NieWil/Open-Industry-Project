// Visually verify the "Blade Stop" - the SDK part (oip.blade-stop), its procedural geometry() on a raise joint, and
// reshaped to a wider lane (the runs are built to cornerZ, the corner hardware slides to ±cornerZ).
// Captures three shots (default width 0.5 lowered, raised while the sim runs, SDK wide width 1.2).
// Run: node e2e/verify-bladestop-sdk.mjs [--headed]
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

async function frame(page, cx, cy, cz, dist, az, el) {
  await page.evaluate(([cx, cy, cz, dist, az, el]) => {
    const v = window.__oip.view
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180
    v.controls.target.set(cx, cy, cz)
    v.camera.position.set(cx + dist * Math.cos(e) * Math.sin(a), cy + dist * Math.sin(e), cz + dist * Math.cos(e) * Math.cos(a))
    v.camera.lookAt(cx, cy, cz)
    v.controls.update()
  }, [cx, cy, cz, dist, az, el])
  await page.waitForTimeout(250)
}

async function main() {
  mkdirSync('e2e/shots', { recursive: true })
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)

    // inject the blade stop directly (so neither the catalog UI nor the first-run tutorial overlay is in the way), embedding its
    // bundled package so the scene validates. The part sits at y = 1.2 (mid-air, like on a conveyor bed) so the
    // under-surface housing isn't hidden by the floor. setWidth lets the later shots reshape it via
    // node-scaling; active raises the blade (the tween settles in ~0.15 s).
    const PART_Y = 1.2
    const setWidth = async (width, { active = false } = {}) => page.evaluate(([width, active]) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.blade-stop')
      // raiseHeight 0.06 = the stroke the model was built for (a fixed stroke: the corner guide rods stay
      // sheathed in the static AirPressure cylinders)
      const parts = [{ id: 'blade_shot', type: 'part', packageId: 'oip.blade-stop', position: [0, 1.2, 0], rotationY: 0, params: { width, active, raiseHeight: 0.06, tag: '' } }]
      st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
      st.setState({ selectedIds: [] })
      return !!pkg
    }, [width, active])

    const ok = await setWidth(0.5)
    // dismiss the first-run tour so it can't intercept input; cleanShot hides any remaining chrome per shot
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(2500)
    const meshCount = await page.evaluate(() => {
      // The entry table is the supported way to reach a part's subtree. No fallback to view.scene:
      // that would silently widen the count to the whole scene, and the check would pass while
      // measuring something else.
      const root = window.__oip.view.entries.get('blade_shot')?.visual.object
      if (!root) return -1 // no entry: report it as a failure rather than silently counting the scene
      let n = 0; root.traverse((o) => { if (o.isMesh) n++ }); return n
    })
    check('Blade Stop injected (package bundled)', ok === true)
    // geometry() emits one mesh per (link, material): housing steel/plate/belt on the root, blade/steel/plate on bladeRoot
    check('all six geometry() submeshes render', meshCount >= 6, `meshes=${meshCount}`)

    // close-up three-quarter view, lowered (visuals span y≈[PART_Y−0.53, PART_Y−0.05])
    await frame(page, 0, PART_Y - 0.25, 0, 1.4, 215, 10)
    await cleanShot(page, 'e2e/shots/bladestop-sdk-default.png')
    console.log('screenshot → e2e/shots/bladestop-sdk-default.png (default width 0.5, lowered)')

    // raise the blade and re-shoot. The SDK behavior only ticks while the sim runs (SDK-wide idle
    // semantic), so Run the sim to drive the real path.
    await setWidth(0.5, { active: true })
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(1200) // a few sim ticks - the 0.15 s raise tween settles
    await frame(page, 0, PART_Y - 0.25, 0, 1.4, 215, 10)
    await cleanShot(page, 'e2e/shots/bladestop-sdk-raised.png')
    console.log('screenshot → e2e/shots/bladestop-sdk-raised.png (active/raised, sim running)')
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(400)

    // widen the lane to 1.2 m and re-shoot to see the node-scaling reshape
    await setWidth(1.2)
    await page.waitForTimeout(1500)
    await frame(page, 0, PART_Y - 0.2, 0, 2.0, 215, 14)
    await cleanShot(page, 'e2e/shots/bladestop-sdk-wide.png')
    console.log('screenshot → e2e/shots/bladestop-sdk-wide.png (width 1.2)')

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
