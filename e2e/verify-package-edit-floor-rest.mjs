// Verify that "edit a definition as its own scene" (the Parts dock ✎ → controller.editPartPackage →
// store.enterPackageEdit) rests the throwaway origin instance on the floor instead of placing it at a raw
// y=0. A conveyor-mounted rig (Diverter, Blade Stop, Chain Transfer) has its origin at the belt surface, so a
// raw y=0 buries its housing below the floor. A legged deck (rest:'surfaceBelow', e.g. the belt conveyor)
// must instead stand its deck standHeight above the floor so its legs reach it.
// Run: node e2e/verify-package-edit-floor-rest.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

const browser = await chromium.launch({ headless: !HEADED })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  await page.goto(URL)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
  await page.waitForTimeout(1500)

  // Open each definition as its own scene and read back the throwaway's pose + its footprint underside.
  // underside = position.y + footprint.y0. It must be on the floor (0) for a footprint-resting part; a
  // rest:'surfaceBelow' deck reaches the floor through its legs (its footprint y0 is its own deck box).
  const probe = async (packageId) =>
    page.evaluate(async (id) => {
      const { store, controller } = window.__oip
      if (store.getState().packageEdit) store.exitPartFocus()
      const opened = controller.editPartPackage(id)
      const st = store.getState()
      const pe = st.packageEdit
      const part = pe ? st.scene.parts.find((p) => p.id === pe.partId) : null
      if (!part) return { opened, part: null }
      const g = await import('/src/core/parts/partGeometry.ts')
      const fp = g.partFootprint(part)
      const rested = g.restOnSurface(part, [part.position[0], 0, part.position[2]], [0, 1, 0])
      const pkg = window.__oip.getPackage(id)
      const standName = Object.keys(pkg.params).find((n) => pkg.params[n]?.rest === 'surfaceBelow')
      return {
        opened,
        y: part.position[1],
        y0: fp.y0,
        y1: fp.y1,
        underside: part.position[1] + fp.y0,
        restedY: rested[1],
        standName: standName ?? null,
        standHeight: standName ? part.params[standName] : null,
      }
    }, packageId)

  // 1. the reported symptom: the Diverter's own scene
  const div = await probe('oip.diverter')
  console.log('diverter', JSON.stringify(div))
  check('diverter package-edit opens', div.opened === true)
  check('diverter footprint declares its true underside (bounds.floorY)', div.y0 < -0.3, `y0=${div.y0}`)
  check('diverter sits ON the floor in its own scene', Math.abs(div.underside) < 1e-6, `underside=${div.underside}`)
  await cleanShot(page, 'e2e/out/package-edit-diverter.png')

  // 2. the same kind of mounted rig: blade stop + chain transfer declare floorY, so a raw y=0
  //    buries them too, and the same fix must rest them on the floor.
  for (const [id, label] of [
    ['oip.blade-stop', 'blade stop'],
    ['oip.chain-transfer', 'chain transfer'],
  ]) {
    const r = await probe(id)
    console.log(label, JSON.stringify(r))
    check(`${label} sits ON the floor in its own scene`, Math.abs(r.underside) < 1e-6, `underside=${r.underside}`)
  }

  // 3. a legged deck must stand on its legs, not sink its deck to y=0: deck at FLOOR_SURFACE_Y (0) +
  //    standHeight, the same height a catalog drop onto bare floor gives
  const belt = await probe('oip.belt-conveyor')
  console.log('belt', JSON.stringify(belt))
  check(
    'belt conveyor stands on its legs in its own scene',
    belt.standName !== null && Math.abs(belt.y - belt.standHeight) < 1e-6,
    `y=${belt.y} stand=${belt.standHeight}`,
  )
  await cleanShot(page, 'e2e/out/package-edit-belt.png')

  // 4. a plain floor-standing part is unaffected (no spurious lift)
  const rack = await probe('oip.rack')
  console.log('rack', JSON.stringify(rack))
  check('floor-standing rig stays at y=0', Math.abs(rack.underside) < 1e-6 && Math.abs(rack.y) < 1e-6, `y=${rack.y}`)

  console.log(failed ? '\nFAILED' : '\nALL PASS')
} finally {
  await browser.close()
  vite.kill()
}
process.exit(failed ? 1 : 0)
