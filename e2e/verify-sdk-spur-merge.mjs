// Verify SDK spur merge parity in the running app, with a flange-gap check and a no-host control.
// The bundled oip.spur-conveyor (a custom part whose length face handle declares angleFrontParam/
// angleBackParam) must behave like a spur belt at a side merge: (a) it exposes angled snap ends,
// (b) the real snap engine side-merges it onto a roller host with the belt-spur flange gap,
// (c) snap extents derive for it, and (d) the rendered rail/guard meshes extend out to the host wall
// (the host folds the extents into the part's guardExtents param; geometry stays world-unaware).
// Run: node e2e/verify-sdk-spur-merge.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
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
const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

/** any rendered vertex of the part's visual within `eps` (XZ) of a world target, i.e. a mesh reaches it */
async function vertexNear(page, partId, target, eps = 0.02) {
  return page.evaluate(({ partId, target, eps }) => {
    let group = null
    window.__oip.view.scene.traverse?.((o) => { if (o.userData && o.userData.partId === partId) group = o })
    if (!group) return null
    let found = false
    group.traverse((o) => {
      if (found || !o.isMesh || !o.visible) return
      const attr = o.geometry?.attributes?.position
      if (!attr) return
      o.updateWorldMatrix(true, false)
      const m = o.matrixWorld.elements
      for (let i = 0; i < attr.count; i++) {
        const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i)
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
        if (Math.hypot(wx - target.x, wz - target.z) < eps) { found = true; return }
      }
    })
    return found
  }, { partId, target, eps })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(600)

    // Build a roller host + the SDK spur overlapping its bed (the override gate pulls an
    // overlapping conveyor out to butt), run the real snap engine, load the merged scene.
    const out = await page.evaluate(async () => {
      const ex = await import('/src/core/guards/guardExtents.ts')
      const sf = await import('/src/core/snap/snapFeatures.ts')
      const pg = await import('/src/core/parts/partGeometry.ts')

      const host = {
        id: 'rc_1', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0.75, 0], rotationY: 0,
        params: { length: 4, width: 1.524, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true },
      }
      const spur = {
        id: 'sdk_spur_1', type: 'part', packageId: 'oip.spur-conveyor',
        position: [1.5, 0.75, 1.5], rotationY: Math.PI / 2,
        params: { length: 2, width: 1.524, angleFrontDeg: 30, angleBackDeg: 0, speed: 0, standHeight: 0.75 },
      }

      // (a) the bundled part is recognized as a spur: its front end is the angled face normal
      const rawEnds = pg.conveyorEndsOf({ ...spur, rotationY: 0 })
      const rawFront = rawEnds.find((e) => e.end === 'front') ?? null

      // (b) real snap: the overlapping spur is pulled out to the host's +Z side
      const cand = sf.findSnap(spur, { position: spur.position, rotationY: spur.rotationY }, [host])
      if (!cand) return { snapped: false, rawFront }
      const snapped = { ...spur, position: cand.pose.position, rotationY: cand.pose.rotationY }
      const hostHw = host.params.width / 2
      const gap = Math.min(...pg.conveyorEndsOf(snapped).map((e) => Math.abs(pg.toLocalXZ(host, e.x, e.z).z))) - hostHw

      // (c) extents derive for the merged custom spur
      const extents = ex.computeSceneExtents([host, snapped])
      const e = extents.get('sdk_spur_1') || {}
      const wallZ = hostHw + 0.01 // FRAME_WALL_THICKNESS
      // probe the right (local +Z) rail's extended end corner: the nearest unextended geometry (the
      // rail's own splayed end, the strip caps) stays >4 cm away there, so the vertex probe can tell them apart.
      const target = e.rightFront !== undefined ? pg.toWorldXZ(snapped, e.rightFront, hostHw + 0.01) : null

      window.__oip.store.loadScene({
        version: window.__oip.store.getState().scene.version,
        parts: [host, snapped],
        packages: [window.__oip.getPackage('oip.roller-conveyor'), window.__oip.getPackage('oip.spur-conveyor')],
      })
      return {
        snapped: true, rawFront, pose: cand.pose, gap,
        hasExtents: extents.has('sdk_spur_1'), e, wallZ,
        target, targetZ: target ? target.z : null,
        snappedSpur: snapped, host,
      }
    })

    const fa = Math.PI / 6
    check('bundled oip.spur-conveyor exposes an ANGLED front end (spur marker recognized)',
      !!out.rawFront && approx(out.rawFront.outX, Math.cos(fa), 0.001) && approx(out.rawFront.outZ, -Math.sin(fa), 0.001),
      out.rawFront ? `out=(${out.rawFront.outX.toFixed(3)}, ${out.rawFront.outZ.toFixed(3)})` : 'no front end')
    check('snap engine side-merged the SDK spur', out.snapped, JSON.stringify(out.pose || {}))
    if (!out.snapped) throw new Error('no snap candidate - aborting')
    check('mated end keeps the belt-spur flange gap off the bed edge', approx(out.gap, 0.04, 0.005), `gap ${out.gap.toFixed(3)}m`)
    check('snap extents derived for the merged SDK spur', out.hasExtents, JSON.stringify(out.e))
    check('extended rail end lands on the host wall plane', out.target !== null && approx(Math.abs(out.targetZ), out.wallZ, 0.03),
      out.target ? `|z|=${Math.abs(out.targetZ).toFixed(3)} vs wall ${out.wallZ.toFixed(3)}` : 'no rightFront extent')

    // (d) the renderer applied the fold: a rail/guard vertex sits at the extended end corner. The face
    // mates parallel to the wall, so the whole extension is only the ~3 cm junction gap (flange gap +
    // wall); the eps must stay below it for the with/without comparison to tell them apart.
    await page.waitForTimeout(600)
    const grown = await vertexNear(page, 'sdk_spur_1', out.target, 0.008)
    check('rendered rail/guard mesh reaches the extended end (host wall)', grown === true,
      grown === null ? 'spur visual not found' : `vertex near (${out.target.x.toFixed(2)}, ${out.target.z.toFixed(2)}): ${grown}`)
    const skip = page.locator('button', { hasText: 'Skip tour' })
    if (await skip.count()) await skip.first().click()
    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'sdk-spur-merge.png') })

    // ...and without the host the same corner is bare (the growth is host-derived, not baked geometry)
    await page.evaluate((spur) => {
      window.__oip.store.loadScene({
        version: window.__oip.store.getState().scene.version,
        parts: [spur],
        packages: [window.__oip.getPackage('oip.spur-conveyor')],
      })
    }, out.snappedSpur)
    await page.waitForTimeout(600)
    const alone = await vertexNear(page, 'sdk_spur_1', out.target, 0.008)
    check('without the host the rail keeps its own splayed end (no vertex at the wall corner)', alone === false,
      `vertex near target when alone: ${alone}`)

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
