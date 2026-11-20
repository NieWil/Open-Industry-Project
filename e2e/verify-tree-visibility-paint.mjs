// Verify scene-tree drag-toggle visibility: press an eye and drag
// across rows to set them all to the same visibility. Places two boxes, then paints
// both hidden in one gesture (pointerdown on one eye + pointer over the next row).
// Run: node e2e/verify-tree-visibility-paint.mjs
/* global process, console, window, document */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

let failed = false
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failed = true
}

// a card is a `div.catalog-card` wrapping `button.catalog-card-main` (plus per-card side
// buttons), not a flat `button.catalog-card`
const catalogCard = (page, label) =>
  page
    .locator('.catalog-card')
    .filter({ has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('button.catalog-card-main')

async function worldToScreen(page, x, y, z) {
  return page.evaluate(
    ([wx, wy, wz]) => {
      const v = window.__oip.view
      const cam = v.camera
      cam.updateMatrixWorld(true)
      const p = cam.position.clone().set(wx, wy, wz).project(cam)
      const rect = v.renderer.domElement.getBoundingClientRect()
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
    },
    [x, y, z],
  )
}

const partCount = (page) => page.evaluate(() => window.__oip.store.getState().scene.parts.length)

// Place a part by clicking its catalog card then clicking the viewport. Retries the
// viewport click until the part count grows - placement raycasts the building floor,
// which may still be loading right after boot (computePlacing returns null until then).
async function placeAt(page, label, wx, wz) {
  const before = await partCount(page)
  await catalogCard(page, label).click()
  for (let i = 0; i < 20; i++) {
    const s = await worldToScreen(page, wx, 0, wz)
    await page.mouse.move(s.x, s.y, { steps: 3 })
    await page.mouse.move(s.x, s.y + 1)
    await page.mouse.move(s.x, s.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(250)
    if ((await partCount(page)) > before) return true
  }
  return false
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(URL)
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })

  // building is already in the scene; one placed conveyor gives a 2nd hideable row
  ok(await placeAt(page, 'Belt Conveyor', 0, -3), 'placed a Belt Conveyor (2nd tree row)')

  const baseHidden = await page.evaluate(
    () => window.__oip.store.getState().scene.parts.filter((p) => p.visible === false).length,
  )
  ok(baseHidden === 0, `baseline: nothing hidden (got ${baseHidden})`)

  // drag-paint: pointerdown on the last row's eye, then drag the pointer over the
  // previous row (React derives onPointerEnter from pointerover), then release.
  const acted = await page.evaluate(() => {
    const eyes = [...document.querySelectorAll('.tree-row .tree-eye')]
    const rows = [...document.querySelectorAll('.tree-row')]
    if (eyes.length < 2 || rows.length < 2) return { ok: false, eyes: eyes.length, rows: rows.length }
    const eye = eyes[eyes.length - 1] // last placed box
    const prevRow = rows[rows.length - 2] // the box before it
    // buttons: 1 as a real drag reports it; a row entered with no button held ends the paint (a lost release)
    eye.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, buttons: 1 }))
    prevRow.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return { ok: true, eyes: eyes.length, rows: rows.length }
  })
  ok(acted.ok, `found ≥2 tree rows with eyes (eyes=${acted.eyes}, rows=${acted.rows})`)

  await page.waitForTimeout(150)
  const nowHidden = await page.evaluate(
    () => window.__oip.store.getState().scene.parts.filter((p) => p.visible === false).length,
  )
  ok(nowHidden - baseHidden === 2, `drag-paint hid 2 rows in one gesture (hidden ${baseHidden} → ${nowHidden})`)

  // a lost release (Alt-Tab mid-paint): the paint starts on the last eye, then the pointer reaches a row with no
  // button held. That ends the paint, so neither that row nor one entered after it changes.
  const lost = await page.evaluate(() => {
    const st = window.__oip.store
    const vis = () => st.getState().scene.parts.map((p) => p.visible !== false).join(',')
    const eyes = [...document.querySelectorAll('.tree-row .tree-eye')]
    const rows = [...document.querySelectorAll('.tree-row')]
    const eye = eyes[eyes.length - 1]
    const prevRow = rows[rows.length - 2]
    eye.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, buttons: 1 })) // shows the last row again
    const afterPress = vis()
    prevRow.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 0 }))
    prevRow.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, buttons: 0 }))
    prevRow.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 1 }))
    return { same: vis() === afterPress }
  })
  ok(lost.same, 'a row entered with no button held ends the paint: no row changes after it')
} finally {
  await browser.close()
  vite.kill()
}

console.log(failed ? '\nTREE VISIBILITY PAINT: FAIL' : '\nTREE VISIBILITY PAINT: OK')
process.exit(failed ? 1 : 0)
