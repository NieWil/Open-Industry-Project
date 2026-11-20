// Verify vertex snapping in the web app: place two separated boxes,
// hold B over a corner of box A, drag onto a corner of box B, release, and confirm
// A translated so one of its collision corners lands exactly on a corner of B (the
// default "Snap to Collision Vertices" behaviour), while B stayed put.
// Run: node e2e/verify-vertex-snap.mjs [--headed]
/* global process, console, fetch, setTimeout, window, document */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
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

// Vite lazily optimizes deps as model loaders import, then sends an HMR full-reload.
// Wait until a quiet window passes with no navigation before driving the gesture.
async function waitStable(page, getNav) {
  for (let i = 0; i < 25; i++) {
    const n = getNav()
    await page.waitForTimeout(400)
    if (getNav() === n) return
  }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  // keep the onboarding tour off (it re-arms after localStorage.clear() and blocks canvas gestures)
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  let navigations = 0
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++ })
  try {
    await page.goto(URL)
    await page.waitForLoadState('networkidle')
    await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForLoadState('networkidle')
    await waitForApp(page)
    await waitStable(page, () => navigations) // outlast any vite dep-optimize full-reload

    const navBefore = navigations
    // Load two separated boxes, select A, and return the screen coords of one corner
    // of each (A's source + B's target) plus the pre-drag world corner sets.
    const setup = await page.evaluate(async () => {
      const cg = await import('/src/core/geometry/collisionGeometry.ts')
      const { store, view } = window.__oip

      // column-major mat4 (THREE .elements) applied to a point (w=1)
      const applyMat4 = (e, x, y, z) => ({
        x: e[0] * x + e[4] * y + e[8] * z + e[12],
        y: e[1] * x + e[5] * y + e[9] * z + e[13],
        z: e[2] * x + e[6] * y + e[10] * z + e[14],
      })

      const mk = (id, x) => ({
        id, type: 'part', packageId: 'oip.box', position: [x, 0.5, 0], rotationY: 0,
        params: { length: 1, height: 1, width: 1, mass: 1, color: '#cccccc' },
      })
      const scene = {
        version: store.getState().scene.version,
        parts: [mk('A', -2), mk('B', 2)],
        packages: [window.__oip.getPackage('oip.box')],
      }
      store.loadScene(scene)
      store.select('A')

      const cam = view.camera
      cam.updateMatrixWorld(true)
      const canvas = document.querySelector('canvas')
      const rect = canvas.getBoundingClientRect()

      const worldCorners = (id) => {
        const part = store.getState().scene.parts.find((p) => p.id === id)
        let obj = null
        view.scene.traverse((o) => { if (o.userData && o.userData.partId === id) obj = o })
        obj.updateWorldMatrix(true, true)
        const m = obj.matrixWorld.elements
        return cg.collisionVerticesLocal(part).map((p) => applyMat4(m, p.x, p.y, p.z))
      }
      const toScreen = (w) => {
        const vi = cam.matrixWorldInverse.elements
        const e = applyMat4(vi, w.x, w.y, w.z) // world -> eye
        const p = cam.projectionMatrix.elements
        const cw = p[3] * e.x + p[7] * e.y + p[11] * e.z + p[15]
        const ndcx = (p[0] * e.x + p[4] * e.y + p[8] * e.z + p[12]) / cw
        const ndcy = (p[1] * e.x + p[5] * e.y + p[9] * e.z + p[13]) / cw
        return { x: rect.left + ((ndcx + 1) / 2) * rect.width, y: rect.top + ((1 - ndcy) / 2) * rect.height }
      }
      // The collision proxy is a footprint hull, so corner order isn't fixed. Pick corners by
      // predicate instead of index: A's top (+x,+z) corner and B's top (-x,+z) corner (both top-front,
      // well separated, facing each other across the gap).
      const pickCorner = (corners, sx, sz) => {
        const maxY = Math.max(...corners.map((c) => c.y))
        const tops = corners.filter((c) => c.y > maxY - 0.01)
        return tops.reduce((best, c) => (sx * c.x + sz * c.z > sx * best.x + sz * best.z ? c : best), tops[0])
      }
      const ca = worldCorners('A')
      const cb = worldCorners('B')
      const src = pickCorner(ca, 1, 1)
      const tgt = pickCorner(cb, -1, 1)
      return {
        srcScreen: toScreen(src),
        tgtScreen: toScreen(tgt),
        srcWorld: src,
        tgtWorld: tgt,
        cornersA: ca,
        cornersB: cb,
        posA: store.getState().scene.parts.find((p) => p.id === 'A').position,
      }
    })

    const minCornerDist = (A, B) => {
      let m = Infinity
      for (const a of A) for (const b of B) m = Math.min(m, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
      return m
    }
    check('boxes start apart (no shared corner)', minCornerDist(setup.cornersA, setup.cornersB) > 0.5,
      `minCornerDist=${minCornerDist(setup.cornersA, setup.cornersB).toFixed(3)}`)

    // Drive the modal gesture: hold B over A's corner, drag onto B's corner, release.
    const { srcScreen, tgtScreen } = setup
    await page.mouse.move(srcScreen.x, srcScreen.y)
    await page.keyboard.down('b')
    await page.mouse.move(srcScreen.x, srcScreen.y) // re-pick the source under the cursor
    await page.waitForTimeout(60)
    await page.mouse.down()
    await page.mouse.move(tgtScreen.x, tgtScreen.y, { steps: 12 })
    await page.waitForTimeout(60)
    await page.mouse.up()
    await page.keyboard.up('b')
    await page.waitForTimeout(120)

    check('no page reload during the gesture', navigations === navBefore,
      `navigations ${navBefore} -> ${navigations}`)

    // Read back the committed scene and re-derive A's world corners.
    const after = await page.evaluate(async () => {
      const cg = await import('/src/core/geometry/collisionGeometry.ts')
      const { store, view } = window.__oip
      const applyMat4 = (e, x, y, z) => ({
        x: e[0] * x + e[4] * y + e[8] * z + e[12],
        y: e[1] * x + e[5] * y + e[9] * z + e[13],
        z: e[2] * x + e[6] * y + e[10] * z + e[14],
      })
      const worldCorners = (id) => {
        const part = store.getState().scene.parts.find((p) => p.id === id)
        let obj = null
        view.scene.traverse((o) => { if (o.userData && o.userData.partId === id) obj = o })
        obj.updateWorldMatrix(true, true)
        const m = obj.matrixWorld.elements
        return cg.collisionVerticesLocal(part).map((p) => applyMat4(m, p.x, p.y, p.z))
      }
      const lastLabel = store.canUndo ? 'undoable' : 'none'
      return {
        posA: store.getState().scene.parts.find((p) => p.id === 'A').position,
        posB: store.getState().scene.parts.find((p) => p.id === 'B').position,
        cornersA: worldCorners('A'),
        cornersB: worldCorners('B'),
        canUndo: store.canUndo,
        lastLabel,
      }
    })

    const movedA = Math.hypot(
      after.posA[0] - setup.posA[0], after.posA[1] - setup.posA[1], after.posA[2] - setup.posA[2])
    check('box A moved', movedA > 0.5, `|delta|=${movedA.toFixed(3)}m`)
    check('box B did not move', Math.hypot(after.posB[0] - 2, after.posB[1] - 0.5, after.posB[2]) < 1e-6,
      `B=${after.posB.map((n) => n.toFixed(3)).join(',')}`)

    const snappedDist = minCornerDist(after.cornersA, after.cornersB)
    check('an A corner now coincides with a B corner (vertex snapped)', snappedDist < 1e-3,
      `minCornerDist=${snappedDist.toFixed(5)}m`)

    // the move must have produced an undoable history entry
    check('the snap committed an undoable action', after.canUndo === true)

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'vertex-snap.png') })

    // --- Scenario 2: Origin mode (click a vertex; the selection's origin jumps onto it) ---
    const origin = await page.evaluate(async () => {
      const cg = await import('/src/core/geometry/collisionGeometry.ts')
      const { store, view } = window.__oip
      const applyMat4 = (e, x, y, z) => ({
        x: e[0] * x + e[4] * y + e[8] * z + e[12],
        y: e[1] * x + e[5] * y + e[9] * z + e[13],
        z: e[2] * x + e[6] * y + e[10] * z + e[14],
      })
      const mk = (id, x) => ({
        id, type: 'part', packageId: 'oip.box', position: [x, 0.5, 0], rotationY: 0,
        params: { length: 1, height: 1, width: 1, mass: 1, color: '#cccccc' },
      })
      store.loadScene({
        version: store.getState().scene.version,
        parts: [mk('A', -2), mk('B', 2)],
        packages: [window.__oip.getPackage('oip.box')],
      })
      store.setVertexSnapOriginMode(true)
      store.select('A')
      const cam = view.camera
      cam.updateMatrixWorld(true)
      const rect = document.querySelector('canvas').getBoundingClientRect()
      const part = store.getState().scene.parts.find((p) => p.id === 'B')
      let obj = null
      view.scene.traverse((o) => { if (o.userData && o.userData.partId === 'B') obj = o })
      obj.updateWorldMatrix(true, true)
      const m = obj.matrixWorld.elements
      // hull ordering isn't fixed - pick B's top (+x,+z) corner by predicate (see scenario 1)
      const corners = cg.collisionVerticesLocal(part).map((p) => applyMat4(m, p.x, p.y, p.z))
      const maxY = Math.max(...corners.map((c) => c.y))
      const tops = corners.filter((c) => c.y > maxY - 0.01)
      const corner = tops.reduce((best, c) => (c.x + c.z > best.x + best.z ? c : best), tops[0])
      const vi = cam.matrixWorldInverse.elements
      const e = applyMat4(vi, corner.x, corner.y, corner.z)
      const p = cam.projectionMatrix.elements
      const cw = p[3] * e.x + p[7] * e.y + p[11] * e.z + p[15]
      const ndcx = (p[0] * e.x + p[4] * e.y + p[8] * e.z + p[12]) / cw
      const ndcy = (p[1] * e.x + p[5] * e.y + p[9] * e.z + p[13]) / cw
      return {
        targetCorner: corner,
        screen: { x: rect.left + ((ndcx + 1) / 2) * rect.width, y: rect.top + ((1 - ndcy) / 2) * rect.height },
      }
    })

    // hold B, click on B's corner (no drag) - origin mode jumps A's origin there
    await page.mouse.move(origin.screen.x, origin.screen.y)
    await page.keyboard.down('b')
    await page.mouse.move(origin.screen.x, origin.screen.y)
    await page.waitForTimeout(60)
    await page.mouse.down()
    await page.mouse.up()
    await page.keyboard.up('b')
    await page.waitForTimeout(120)

    const originAfter = await page.evaluate(() => ({
      posA: window.__oip.store.getState().scene.parts.find((p) => p.id === 'A').position,
      canUndo: window.__oip.store.canUndo,
    }))
    const originErr = Math.hypot(
      originAfter.posA[0] - origin.targetCorner.x,
      originAfter.posA[1] - origin.targetCorner.y,
      originAfter.posA[2] - origin.targetCorner.z)
    check('origin mode jumps the selection origin onto the clicked vertex', originErr < 1e-3,
      `origin err=${originErr.toFixed(5)}m`)
    check('origin snap committed an undoable action', originAfter.canUndo === true)

    // --- Scenario 3: mesh-source path works (useCollision=false finds a vertex) ---
    const meshPath = await page.evaluate(() => {
      const { view } = window.__oip
      const rect = document.querySelector('canvas').getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      // a generous radius so the scan finds something regardless of exact corner position
      const collision = view.vertexSnapTarget(cx, cy, new Set(), 4000, true)
      const mesh = view.vertexSnapTarget(cx, cy, new Set(), 4000, false)
      return { collision: !!collision, mesh: !!mesh }
    })
    check('collision-source scan finds a vertex', meshPath.collision === true)
    check('mesh-source scan finds a vertex (Snap to Mesh Vertices path works)', meshPath.mesh === true)

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
