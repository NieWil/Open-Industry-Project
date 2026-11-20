// Structure-cut lifecycle gate for the stair↔platform connection (docs/part-snap-stairs.md):
//   1. SNAPPED (flight top on the edge): railing opens ±width/2, flight lifts flush, no deck hole
//   2. INTERIOR (stair over the deck, crossing the deck plane): the deck holes the stairwell (notch + strips)
//   3. MOVED AWAY: the hole closes and the railing heals live, through the entry-update path (no rebuild,
//      no restart). This is the regression gate for "the hole never closes": a WebGPU bundle keeps replaying
//      removed strip meshes unless rig.ts bumps structureVersion on child-count changes.
// Run: node e2e/verify-stair-platform-cut.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const waitForApp = (p) => p.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 30000 })
const waitBuilt = (page, ids) => page.waitForFunction((ids) => {
  const v = window.__oip.view
  return ids.every((id) => { let g = null; v.scene.traverse((o) => { if (!g && o.userData?.partId === id) g = o }); if (!g) return false; let n = 0; g.traverse((o) => { if (o.isMesh || o.isInstancedMesh) n++ }); return n >= 3 })
}, ids, { timeout: 30000 })

// load the pair with the stair at `stairPos` (stable ids, so re-loads exercise the live entry-update path)
const setScene = (page, stairPos) => page.evaluate((stairPos) => {
  const store = window.__oip.store, scene = store.getState().scene
  const platPkg = window.__oip.getPackage('oip.platform'), stairPkg = window.__oip.getPackage('oip.stairs')
  if (!platPkg || !stairPkg) return false
  const platform = { id: 'plat', type: 'part', packageId: 'oip.platform', position: [0, 2.4, 0], rotationY: 0, params: { length: 6, width: 5, height: 2.4, showRailings: true, showSupports: true, color: '#f2bd0f' } }
  const stair = { id: 'stair', type: 'part', packageId: 'oip.stairs', position: stairPos, rotationY: Math.PI, params: { numSteps: 13, width: 1.4, showHandrails: true, color: '#f2bd0f' } }
  const keep = (scene.packages ?? []).filter((p) => p.id !== platPkg.id && p.id !== stairPkg.id)
  store.loadScene({ ...scene, parts: [platform, stair], packages: [...keep, platPkg, stairPkg] })
  store.setState({ selectedIds: [] })
  return true
}, stairPos)

// the platform's live connection data + its rendered deck children (visible boxes at the deck plane)
const state = (page) => page.evaluate(() => {
  const v = window.__oip.view
  const conn = v.lastResolved?.get?.('plat')?.structConn?.platform?.get?.('plat')
  let g = null
  v.scene.traverse((o) => { if (!g && o.userData?.partId === 'plat') g = o })
  g?.updateMatrixWorld(true)
  let deckMeshes = 0
  // the deck link's own children (rigLayout.ts layoutDeckCut: one full slab, or the strips round a notch). Counted by
  // link, not by height: the platform's geometry() hardware hangs off the part root at the deck plane too.
  g?.traverse((o) => { if (o.isMesh && o.parent?.userData?.linkName === 'deck' && Math.abs(o.matrixWorld.elements[13] - 2.397) < 0.01 && o.scale.x > 0.1) deckMeshes++ })
  return {
    notches: conn?.notches?.length ?? 0,
    posX: conn?.openings?.posX ?? [],
    lift: v.lastResolved?.get?.('stair')?.structConn?.stairTopConnected?.get?.('stair') ?? null,
    deckMeshes,
  }
})

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await page.goto(URL); await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload(); await waitForApp(page); await page.waitForTimeout(1500)
    // the onboarding tour intercepts pointer events, so dismiss it before the real-drag stage
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(300)

    // 1. SNAPPED: flight top on the +X edge (x=3) → foot = 3 + 13·0.28 = 6.64 (the deck is its landing)
    check('scene injected', await setScene(page, [6.64, 0, 0]))
    await waitBuilt(page, ['plat', 'stair']); await page.waitForTimeout(600)
    const snapped = await state(page)
    check('snapped: railing opens ±0.7 on the +X edge', snapped.posX.length === 1 && Math.abs(snapped.posX[0][0] + 0.7) < 1e-3 && Math.abs(snapped.posX[0][1] - 0.7) < 1e-3, JSON.stringify(snapped.posX))
    check('snapped: flight lifts flush (lift = 2.4 − 13·0.178 + 1mm)', snapped.lift !== null && Math.abs(snapped.lift - 0.087) < 2e-3, `lift=${snapped.lift}`)
    check('snapped: NO deck hole (flight outside)', snapped.notches === 0 && snapped.deckMeshes === 1, `notches=${snapped.notches} deckMeshes=${snapped.deckMeshes}`)

    // 2. INTERIOR: stair over the deck, crossing the deck plane → stairwell hole
    await setScene(page, [2.2, 0, 0.5]); await page.waitForTimeout(600)
    const interior = await state(page)
    check('interior: deck holes the stairwell (notch + strips)', interior.notches === 1 && interior.deckMeshes > 1, `notches=${interior.notches} deckMeshes=${interior.deckMeshes}`)

    // 3. MOVED AWAY: the hole must close through the live entry-update path
    await setScene(page, [30, 0, 0.5]); await page.waitForTimeout(600)
    const away = await state(page)
    check('moved away: the hole closes live (one full deck, no notches)', away.notches === 0 && away.deckMeshes === 1, `notches=${away.notches} deckMeshes=${away.deckMeshes}`)

    // 4. REAL POINTER DRAG (the interactive flow): drag the stair to the platform. The snap must engage and
    //    the railing open live mid-drag. Then drag it away: the connection must clear live and heal on drop.
    const screenOf = (wx, wy, wz) => page.evaluate(([wx, wy, wz]) => {
      const v = window.__oip.view
      const p = new (v.camera.position.constructor)(wx, wy, wz).project(v.camera)
      const el = v.renderer.domElement.getBoundingClientRect()
      return { x: el.left + ((p.x + 1) / 2) * el.width, y: el.top + ((1 - p.y) / 2) * el.height }
    }, [wx, wy, wz])
    const liveConn = () => page.evaluate(() => {
      const conn = window.__oip.view.lastResolved?.get?.('plat')?.structConn
      return { open: (conn?.platform?.get?.('plat')?.openings?.posX?.length ?? 0) > 0, lift: conn?.stairTopConnected?.get?.('stair') ?? null }
    })
    await setScene(page, [10, 0, 0])
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      const v = window.__oip.view
      v.controls.target.set(4, 1, 0); v.camera.position.set(4, 14, 12); v.camera.lookAt(4, 1, 0); v.controls.update()
    })
    await page.evaluate(() => window.__oip.store.select('stair'))
    await page.waitForTimeout(300)
    // grab a tread and drag toward the platform's +X edge until the snap engages. A press on the selected flight's body
    // is the gizmo's free 'view' move, but only where no arrow or ring of the transform gizmo covers it, and the gizmo
    // stands mid-flight (the centre of the footprint, controller/gizmo.ts partGizmoCenter). So take the first tread
    // centre, foot to top, that the view says no gizmo handle covers. The flight runs toward -X from its foot at x = 10.
    let GRAB = null
    for (let k = 0; k < 13 && !GRAB; k++) {
      const at = [10 - (k + 0.5) * 0.28, (k + 1) * 0.178, 0]
      const sp = await screenOf(...at)
      if ((await page.evaluate(([x, y]) => window.__oip.view.pickGizmoHandle(x, y), [sp.x, sp.y])) === null) GRAB = at
    }
    check('drag-in: a tread the gizmo does not cover, to grab', GRAB !== null)
    GRAB ??= [8.5, 0.9, 0]
    const g1 = await screenOf(...GRAB)
    await page.mouse.move(g1.x, g1.y, { steps: 3 }); await page.mouse.down()
    let engagedMid = false
    for (let i = 1; i <= 14 && !engagedMid; i++) {
      const t = await screenOf(GRAB[0] - i * 0.35, GRAB[1], GRAB[2])
      await page.mouse.move(t.x, t.y, { steps: 3 }); await page.waitForTimeout(60)
      engagedMid = (await liveConn()).open
    }
    await page.mouse.up(); await page.waitForTimeout(500)
    check('drag-in: railing opens LIVE mid-drag (snap engaged under the pointer)', engagedMid)
    const dropped = await state(page)
    check('drag-in: connection holds after the drop', dropped.lift !== null && dropped.posX.length === 1, JSON.stringify(dropped.posX))
    // re-select (screenshots/other flows may deselect) and drag it away on a solid low tread
    await page.evaluate(() => window.__oip.store.select('stair'))
    await page.waitForTimeout(200)
    const sx = 5.94 // foot 6.64 − 0.7: a solid low tread (grabbing open air between rails starts no drag)
    const g2 = await screenOf(sx, 0.45, 0)
    await page.mouse.move(g2.x, g2.y, { steps: 3 }); await page.mouse.down()
    for (let i = 1; i <= 12; i++) {
      const t = await screenOf(sx + i * 0.6, 0.45, i * 0.15)
      await page.mouse.move(t.x, t.y, { steps: 3 }); await page.waitForTimeout(60)
    }
    await page.mouse.up(); await page.waitForTimeout(500)
    const healed = await state(page)
    check('drag-away: connection clears + railing/deck heal live', healed.lift === null && healed.posX.length === 0 && healed.notches === 0 && healed.deckMeshes === 1, JSON.stringify(healed))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
