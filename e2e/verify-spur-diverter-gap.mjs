// Verify a diverter mounted on a spur opens the spur's guard in the running app. A spur takes end joins only, so only
// a device opens its guards, and a drawn part only gets that opening through its `guardGaps` param
// (core/guards/guardOpenings.ts withGuardGaps; core/parts/hostFacts.ts). Without it the diverter's arms run into
// solid guard. The real snap engine seats the bundled diverter on the bundled spur's +Z guard; the rendered guard
// must then end at both edges of the opening, and with the diverter gone the same points must be bare guard.
// Run: node e2e/verify-spur-diverter-gap.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

/** the scene has finished building: every part's visual is in */
async function settled(page) {
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000, polling: 100 })
}

/** does any rendered vertex of the part sit within `eps` (XZ) of each target? Its guard sheets are plain meshes (the
 *  instanced banks are the bed strips, rails and bolts, none of which ends on the guard's inner face) */
async function guardVertexAt(page, partId, targets, eps) {
  return page.evaluate(({ partId, targets, eps }) => {
    let group = null
    window.__oip.view.scene.traverse((o) => { if (o.userData && o.userData.partId === partId) group = o })
    if (!group) return null
    const hit = targets.map(() => false)
    group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.visible) return
      const attr = o.geometry?.attributes?.position
      if (!attr) return
      o.updateWorldMatrix(true, false)
      const m = o.matrixWorld.elements
      for (let i = 0; i < attr.count; i++) {
        const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i)
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
        targets.forEach((t, k) => { if (Math.hypot(wx - t.x, wz - t.z) < eps) hit[k] = true })
      }
    })
    return hit
  }, { partId, targets, eps })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await settled(page)

    const out = await page.evaluate(async () => {
      const sf = await import('/src/core/snap/snapFeatures.ts')
      const go = await import('/src/core/guards/guardOpenings.ts')
      const sc = await import('/src/core/scene/scene.ts')
      const spur = sc.createSdkPart(window.__oip.getPackage('oip.spur-conveyor'), 'spur_1', [0, 0.75, 0], 0)
      const dvRaw = sc.createSdkPart(window.__oip.getPackage('oip.diverter'), 'dv_1', [0, 0.55, 2], 0)
      const cand = sf.findSnap(dvRaw, { position: dvRaw.position, rotationY: 0 }, [spur])
      if (!cand) return { snapped: false }
      const dv = { ...dvRaw, position: cand.pose.position, rotationY: cand.pose.rotationY }
      const openings = go.computeSceneOpenings([spur, dv]).get('spur_1') ?? null
      window.__oip.store.loadScene({
        version: window.__oip.store.getState().scene.version,
        parts: [spur, dv],
        packages: [window.__oip.getPackage('oip.spur-conveyor'), window.__oip.getPackage('oip.diverter')],
      })
      return { snapped: true, spur, openings }
    })
    check('the snap engine seated the diverter on the spur', out.snapped)
    if (!out.snapped) throw new Error('no snap candidate - aborting')
    check('the host opens the spur\'s +Z guard for it', (out.openings?.right?.length ?? 0) === 1, JSON.stringify(out.openings))
    const [lo, hi] = out.openings.right[0]
    // the guard sheet's inner face: half the bed width plus the frame wall (the spur at the origin, unrotated)
    const zGuard = out.spur.params.width / 2 + 0.01
    const edges = [{ x: lo, z: zGuard }, { x: hi, z: zGuard }]

    await settled(page)
    const withDv = await guardVertexAt(page, 'spur_1', edges, 0.006)
    check('the drawn guard ends at both edges of the opening', withDv !== null && withDv.every(Boolean), `edges ${lo.toFixed(3)}..${hi.toFixed(3)}: ${JSON.stringify(withDv)}`)
    // a look at the opening, from outside the +Z guard
    await page.evaluate(() => {
      const { view } = window.__oip
      view.controls?.target?.set(0, 0.8, 0.8)
      view.camera.position.set(1.6, 2.2, 3.6)
      view.camera.lookAt(0, 0.8, 0.8)
      view.controls?.update?.()
    })
    await cleanShot(page, join(import.meta.dirname, 'shots', 'spur-diverter-gap.png'), { settleMs: 400 })

    // control: the spur alone keeps a whole guard, so nothing ends at those points
    await page.evaluate((spur) => {
      window.__oip.store.loadScene({ version: window.__oip.store.getState().scene.version, parts: [spur], packages: [window.__oip.getPackage('oip.spur-conveyor')] })
    }, out.spur)
    await settled(page)
    const alone = await guardVertexAt(page, 'spur_1', edges, 0.006)
    check('without the diverter the guard runs whole through those points', alone !== null && alone.every((h) => !h), JSON.stringify(alone))
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
