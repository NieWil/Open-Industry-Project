// Verify a sensor beam on a moving link follows the link when the rig is posed with the sim stopped. The idle preview
// and a stopped Use pose rigs through view.applyIdlePose; the stopped beam probe otherwise reruns only on a scene,
// cargo or registry change, so a beam on the posed link (the stretch wrapper's carriage eye) stayed drawn where the
// link had been. The view's own sensor-beam audit re-probes every beam and reports one that a fresh probe moves.
// Run: node e2e/verify-idle-pose-beam.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !benign(m.text())) errors.push(m.text())
  })
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    const loaded = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.stretch-wrapper')
      if (!pkg) return false
      const parts = [{ id: 'wrap', type: 'part', packageId: 'oip.stretch-wrapper', position: [0, 0, 0], rotationY: 0, params: { showBeam: true } }] // its beams are hidden by default
      st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
      st.setState({ selectedIds: [] })
      return true
    })
    check('stretch wrapper loaded', loaded)
    await page.waitForFunction(() => !window.__oip.assetsBusy(), { timeout: 30000 })
    await page.waitForTimeout(500) // the idle preview's first pose and probe pass

    // the beam audit, read in the same task as the pose so no later frame's probe pass can hide a stale beam
    const auditAfterPose = (lift) =>
      page.evaluate((lift) => {
        const v = window.__oip.view
        v.applyIdlePose('wrap', { joints: { lift } })
        return v.sceneConsumers.audit().filter((c) => c.name === 'sceneConsumer:sensorBeams' && !c.ok).map((c) => c.reason)
      }, lift)

    check('sim is stopped', (await page.evaluate(() => window.__oip.store.getState().running)) === false)
    const up = await auditAfterPose(1.2)
    check('carriage raised while stopped: no beam is left where the link was', up.length === 0, up.join('; '))
    const down = await auditAfterPose(0)
    check('carriage lowered again: the beams follow it back', down.length === 0, down.join('; '))
    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
