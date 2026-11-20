// Wheel zoom goes toward what the cursor is over (src/render/viewport/wheelZoom.ts):
//   - the part under the cursor stays under the cursor while the camera closes on it
//   - one notch scales the distance to it by WHEEL_ZOOM.perNotch, and the view never rotates
//   - scrolling on reaches a part far inside a 1.5 m orbit clamp, although the orbit target
//     sits well behind the part, and stops just short of its surface
//   - zooming out stops at the orbit max distance
//   - OrbitControls' own wheel dolly is detached (no double step, no "moved" warning)
// Run: node e2e/verify-wheel-zoom.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

// the default scene is empty: place an SDK Box (verify-ortho-projection's flow) to point at
async function placeBox(page) {
  await page.locator('button.catalog-tab', { hasText: /^Products$/ }).click()
  await page.waitForTimeout(150)
  await page
    .locator('button.catalog-card-main')
    .filter({ has: page.locator('.catalog-card-label', { hasText: /^Box$/ }) })
    .click()
  const c = await page.evaluate(() => window.__oip.view.worldToScreen(0.5, 0, 0))
  await page.mouse.move(c.x, c.y, { steps: 4 })
  await page.mouse.move(c.x, c.y + 1)
  await page.mouse.move(c.x, c.y)
  await page.waitForTimeout(80)
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const id = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.box')?.id ?? null)
  if (!id) throw new Error('setup: failed to place the oip.box target')
  await page.evaluate(() => window.__oip.store.clearSelection?.())
  return id
}

/** camera pose, the box's screen point, the box under that point, the view direction */
const probe = (page, id) =>
  page.evaluate((id) => {
    const h = window.__oip
    const v = h.view
    const p = h.store.getState().scene.parts.find((q) => q.id === id)
    const aim = [p.position[0], p.position[1] + 0.1, p.position[2]]
    const s = v.worldToScreen(aim[0], aim[1], aim[2])
    const pose = v.cameraPose()
    const dir = [pose.tx - pose.px, pose.ty - pose.py, pose.tz - pose.pz]
    const len = Math.hypot(...dir)
    return {
      pose,
      screen: { x: s.x, y: s.y, visible: s.visible },
      camToBox: Math.hypot(pose.px - aim[0], pose.py - aim[1], pose.pz - aim[2]),
      camToTarget: len,
      dir: dir.map((d) => d / len),
      under: v.pickPart(s.x, s.y),
    }
  }, id)

/** wheel, then wait for the eased zoom to finish landing */
async function wheel(page, dy, times = 1) {
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, dy)
  await page.waitForFunction(() => window.__oip.view.zoomPending === 0, { timeout: 10000 })
  await page.waitForTimeout(100) // one more frame: OrbitControls folds the move in
}

const angle = (a, b) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=CalculateNativeWinOcclusion'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const warnings = []
    page.on('console', (m) => {
      if (m.text().includes('_onMouseWheel')) warnings.push(m.text())
    })
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
    await page.goto(`http://localhost:${PORT}/app/`)
    await page.waitForFunction(() => { const h = window.__oip; return !!(h && h.store && h.view && h.controller) }, { timeout: 30000 })
    await page.waitForFunction(() => !window.__oip.assetsBusy?.(), { timeout: 60000 })
    const id = await placeBox(page)

    // the orbit target 6 m behind the box, the box off-centre on screen
    await page.evaluate(() => window.__oip.view.setCameraPose({ px: -5, py: 5, pz: 8, tx: -2, ty: 0, tz: -5 }, { instant: true }))
    await page.waitForTimeout(400)
    const a = await probe(page, id)
    if (!a.screen.visible || a.under !== id) throw new Error(`setup: the box is not under its own screen point (${a.under})`)
    const centre = await page.evaluate(() => { const r = window.__oip.view.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
    expect(Math.hypot(a.screen.x - centre.x, a.screen.y - centre.y) > 80, `the box is off-centre (${Math.round(a.screen.x - centre.x)}, ${Math.round(a.screen.y - centre.y)} px)`)

    // one notch toward the box
    await page.mouse.move(a.screen.x, a.screen.y)
    const perNotch = 0.88
    await wheel(page, -100)
    const b = await probe(page, id)
    const ratio = b.camToBox / a.camToBox
    expect(Math.abs(ratio - perNotch) < 0.03, `one notch scales the distance to the box by ~${perNotch} (${ratio.toFixed(3)}; a double step would be ~${(perNotch * 0.95).toFixed(2)})`)
    expect(Math.hypot(b.screen.x - a.screen.x, b.screen.y - a.screen.y) < 2, `the box stays under the cursor (moved ${Math.hypot(b.screen.x - a.screen.x, b.screen.y - a.screen.y).toFixed(2)} px)`)
    expect(angle(a.dir, b.dir) < 1e-3, 'the view direction is unchanged')

    // keep scrolling: the camera reaches the box, far inside a 1.5 m clamp to a target behind it
    await wheel(page, -100, 40)
    const c = await probe(page, id)
    expect(c.camToBox < 1.0, `scrolling reaches the box (${c.camToBox.toFixed(2)} m from its aim point; the old clamp held 1.5 m from a target ${a.camToTarget.toFixed(1)} m away)`)
    expect(c.under === id, `the box is still what the cursor is over (${c.under})`)
    await wheel(page, -100, 10)
    const d = await probe(page, id)
    expect(Math.abs(d.camToBox - c.camToBox) < 0.05 && d.camToBox > 0.15, `zooming in stops just short of the surface (${c.camToBox.toFixed(3)} -> ${d.camToBox.toFixed(3)} m)`)

    // all the way out: capped at the orbit max distance
    await wheel(page, 300, 30)
    const e = await probe(page, id)
    expect(Math.abs(e.camToTarget - 500) < 0.5, `zooming out stops at the max distance (${e.camToTarget.toFixed(2)} m)`)

    expect(warnings.length === 0, `OrbitControls' wheel dolly detached (${warnings.length} warning(s))`)
    await page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall wheel-zoom checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
