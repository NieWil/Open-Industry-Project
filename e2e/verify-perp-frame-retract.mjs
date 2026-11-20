// Verify the perpendicular (T-junction) frame fit in the running app: snap a roller conveyor's end onto
// another roller conveyor's side via the real snap engine, then confirm
// (a) the snap engine places the mover's end face on the host frame's outer wall plane (not on the bed
//     edge, a wall thickness inside the host's frame, with the rails retracted back out), and the mover
//     derives its snap extents + rail cuts there (guardExtents: the rails already end on the plane; the cut
//     steps their top flange back past the host's),
// (b) the rendered mover frame ends on the wall plane and nothing of it reaches the bed edge, and
// (c) the host's frame stays full-length (it never opens; only its guard opens).
// A scene saved with a T on the bed edge still retracts to the plane: guardExtents.test.ts covers that.
// Run: node e2e/verify-perp-frame-retract.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const OUT = join(import.meta.dirname, 'shots')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const approx = (a, b, eps = 0.005) => Math.abs(a - b) <= eps

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

/** any vertex of the part's visual within `eps` (XZ) of a world target, i.e. a mesh reaches it.
 *  Includes pool-hidden meshes: a static rig box opted into the scene-global instance pool keeps its
 *  in-group original hidden (userData.poolUnit) while the pool draws it with the same transform, so
 *  the hidden original's world-space vertices are exactly what the pool renders. */
async function vertexNear(page, partId, target, eps = 0.005, maxY = Infinity) {
  return page.evaluate(({ partId, target, eps, maxY }) => {
    let group = null
    window.__oip.view.scene.traverse?.((o) => { if (o.userData && o.userData.partId === partId) group = o })
    if (!group) return null
    let found = false
    group.traverse((o) => {
      if (found || !o.isMesh) return
      const attr = o.geometry?.attributes?.position
      if (!attr) return
      o.updateWorldMatrix(true, false)
      const m = o.matrixWorld.elements
      for (let i = 0; i < attr.count; i++) {
        const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i)
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
        if (wy <= maxY && Math.hypot(wx - target.x, wz - target.z) < eps) { found = true; return }
      }
    })
    return found
  }, { partId, target, eps, maxY: Number.isFinite(maxY) ? maxY : 1e9 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(600)

    // Host roller (centre-origin, length 4, width 1.524 → bed edge z=0.762, outer wall plane z=0.772)
    // + a perpendicular roller mover (length 3) aimed at its +Z side near x=1; run the real snap engine.
    const out = await page.evaluate(async () => {
      const sf = await import('/src/core/snap/snapFeatures.ts')
      const ge = await import('/src/core/guards/guardExtents.ts')
      const pg = await import('/src/core/parts/partGeometry.ts')
      const host = {
        id: 'host', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0.75, 0], rotationY: 0,
        params: { length: 4, width: 1.524, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true },
      }
      const mover = {
        id: 'mover', type: 'part', packageId: 'oip.roller-conveyor', position: [1.0, 0.75, 2.2], rotationY: Math.PI / 2,
        params: { length: 3, width: 1.524, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true },
      }
      const cand = sf.findSnap(mover, { position: mover.position, rotationY: mover.rotationY }, [host])
      if (!cand) return { snapped: false }
      const snapped = { ...mover, position: cand.pose.position, rotationY: cand.pose.rotationY }
      window.__oip.store.loadScene({
        version: window.__oip.store.getState().scene.version,
        parts: [host, snapped],
        packages: [window.__oip.getPackage('oip.roller-conveyor')],
      })
      const extents = ge.computeSceneExtents([host, snapped])
      const e = extents.get('mover') ?? null
      // world XZ probe targets on the mover's rail lines (walls at local z = ±(hw..hw+0.01))
      const railZ = 1.524 / 2 + 0.01
      const probe = (lx, side) => pg.toWorldXZ(snapped, lx, side * railZ)
      return {
        snapped: true, pose: cand.pose, e, hostHasExtents: extents.has('host'),
        newEndL: probe(e?.leftFront ?? 0, -1), newEndR: probe(e?.rightFront ?? 0, 1),
        // where the rail line meets the host's bed edge: one wall thickness past the mover's face
        oldEndL: probe(1.51, -1), oldEndR: probe(1.51, 1),
      }
    })

    check('snap engine returned a perpendicular side-merge candidate', out.snapped, JSON.stringify(out.pose ?? {}))
    if (!out.snapped) throw new Error('no snap candidate')
    // the end face sits on the host's outer wall plane: mover (length 3, centre-origin) origin 1.5 off z = 0.772
    check('mover end seats on the host frame\'s outer wall plane', approx(out.pose.position[2], 0.772 + 1.5, 1e-4), `z ${out.pose.position[2].toFixed(4)}`)

    // extents: the leading ends stay at the face (local x = 1.5, already the plane), backs untouched, rail cuts there
    check('mover derives leading-end extents at its face', !!out.e && approx(out.e.leftFront ?? 0, 1.5, 1e-4) && approx(out.e.rightFront ?? 0, 1.5, 1e-4), JSON.stringify(out.e))
    check('mover derives rail cuts at those ends', out.e?.railCuts?.left?.length === 1 && out.e?.railCuts?.right?.length === 1)
    check('mover back ends untouched', out.e?.leftBack === undefined && out.e?.rightBack === undefined)
    check('host derives NO extents (its frame stays put)', out.hostHasExtents === false)
    // the retracted rail ends are on the host's outer wall plane (world z = 0.772)
    check('retracted ends land on the host wall plane', approx(out.newEndL.z, 0.772, 0.002) && approx(out.newEndR.z, 0.772, 0.002), `z L=${out.newEndL.z.toFixed(4)} R=${out.newEndR.z.toFixed(4)}`)

    await page.waitForTimeout(600)
    // rendered retraction: a mover rail vertex sits at the retracted end corner, none at the bed edge
    const atNewL = await vertexNear(page, 'mover', out.newEndL)
    const atNewR = await vertexNear(page, 'mover', out.newEndR)
    const atOldL = await vertexNear(page, 'mover', out.oldEndL, 0.004)
    const atOldR = await vertexNear(page, 'mover', out.oldEndR, 0.004)
    check('mover renders its rail end on the wall plane (left)', atNewL === true, `vertex near (${out.newEndL.x.toFixed(3)}, ${out.newEndL.z.toFixed(3)}): ${atNewL}`)
    check('mover renders its rail end on the wall plane (right)', atNewR === true, `vertex near (${out.newEndR.x.toFixed(3)}, ${out.newEndR.z.toFixed(3)}): ${atNewR}`)
    check('no mover rail reaches the host bed edge (left)', atOldL === false, `vertex near bed edge: ${atOldL}`)
    check('no mover rail reaches the host bed edge (right)', atOldR === false, `vertex near bed edge: ${atOldR}`)

    // host frame intact: no cut-face vertices at the junction mouth edges (a cut host frame would have
    // wall corners at x = 1 ± 0.797 on the wall band). Probed at frame height only (below the deck): the
    // host's guard is cut there on purpose, its top return mitred square-ended at exactly 1 ± 0.797
    // (core/guards/guardExtents.ts GuardMitre), which an XZ-only probe would mistake for a frame cut.
    const hostCutL = await vertexNear(page, 'host', { x: 1 - 0.797, z: 0.767 }, 0.015, 0.75)
    const hostCutR = await vertexNear(page, 'host', { x: 1 + 0.797, z: 0.767 }, 0.015, 0.75)
    check('host frame is NOT cut at the mouth', hostCutL === false && hostCutR === false, `L=${hostCutL} R=${hostCutR}`)

    // junction close-ups
    const jx = out.pose.position[0]
    const jz = 0.762
    await page.evaluate(({ jx, jz }) => {
      const view = window.__oip.view
      view.camera.position.set(jx + 1.9, 1.5, jz + 0.75)
      view.controls.target.set(jx + 0.55, 0.74, jz + 0.02)
      view.controls.update()
    }, { jx, jz })
    await page.waitForTimeout(400)
    console.log(await cleanShot(page, join(OUT, 'perp-retract-corner.png')))
    await page.evaluate(({ jx, jz }) => {
      const view = window.__oip.view
      view.camera.position.set(jx, 2.6, jz + 0.4)
      view.controls.target.set(jx, 0.75, jz + 0.05)
      view.controls.update()
    }, { jx, jz })
    await page.waitForTimeout(400)
    console.log(await cleanShot(page, join(OUT, 'perp-retract-top.png')))

    // ---- belt mover: the same flush side-merge with a belt conveyor as the stem. The belt applies the
    // extents via its guardExtents param fold (geometry-level, gated by beltConveyorRigParity.test.ts);
    // here we assert the derivation + fold are connected in the running app, and shoot the junction.
    const belt = await page.evaluate(async () => {
      const sf = await import('/src/core/snap/snapFeatures.ts')
      const ge = await import('/src/core/guards/guardExtents.ts')
      const pg = await import('/src/core/parts/partGeometry.ts')
      const host = {
        id: 'host', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0.75, 0], rotationY: 0,
        params: { length: 4, width: 1.524, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true },
      }
      const beltPkg = window.__oip.getPackage('oip.belt-conveyor')
      const defaults = Object.fromEntries(Object.entries(beltPkg.params).map(([k, s]) => [k, s.default]))
      const mover = {
        id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [1.0, 0.75, 0], rotationY: Math.PI / 2,
        params: { ...defaults, width: 1.524 },
      }
      // the drum-overhang front face's local x (it follows the belt's default length + height, so read, not assumed),
      // then drop the belt with that face 0.1 m off the host's +Z flank
      const faceX = pg.conveyorLocalEnds(mover).find((e) => e.end === 'front').x
      mover.position = [1.0, 0.75, 0.762 + faceX + 0.1]
      const cand = sf.findSnap(mover, { position: mover.position, rotationY: mover.rotationY }, [host])
      if (!cand) return { snapped: false, faceX }
      const snapped = { ...mover, position: cand.pose.position, rotationY: cand.pose.rotationY }
      window.__oip.store.loadScene({
        version: window.__oip.store.getState().scene.version,
        parts: [host, snapped],
        packages: [window.__oip.getPackage('oip.roller-conveyor'), beltPkg],
      })
      const e = ge.computeSceneExtents([host, snapped]).get('belt') ?? null
      const folded = ge.withSnapExtents(snapped, {}, e ?? undefined)
      return { snapped: true, pose: cand.pose, faceX, e, rows: folded.guardExtents ?? null }
    })
    const bf = belt.faceX ?? 0
    check('belt mover end seats on the host frame\'s outer wall plane', belt.snapped && approx(belt.pose.position[2], 0.772 + bf, 1e-4), JSON.stringify(belt.pose ?? {}))
    check('belt derives leading-end extents at its face', !!belt.e && approx(belt.e.leftFront ?? 0, bf, 1e-4) && approx(belt.e.rightFront ?? 0, bf, 1e-4), JSON.stringify(belt.e))
    check('belt derives rail cuts at those ends', belt.e?.railCuts?.left?.length === 1 && belt.e?.railCuts?.right?.length === 1)
    check('extents fold into the belt\'s guardExtents rows', Array.isArray(belt.rows) && belt.rows.length === 2 && approx(belt.rows[0][2], bf, 1e-4) && approx(belt.rows[1][2], bf, 1e-4), JSON.stringify(belt.rows))

    await page.waitForTimeout(800)
    await page.evaluate(({ jx, jz }) => {
      const view = window.__oip.view
      view.camera.position.set(jx + 1.9, 1.5, jz + 0.75)
      view.controls.target.set(jx + 0.55, 0.74, jz + 0.02)
      view.controls.update()
    }, { jx, jz })
    await page.waitForTimeout(400)
    console.log(await cleanShot(page, join(OUT, 'perp-retract-belt-corner.png')))

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
