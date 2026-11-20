// Verifies sensors cut holes in conveyor side guards (core/guards/guardHoles.ts derives them from the scene;
// the guard draws a holed panel there). Places the SDK roller conveyor
// + SDK color sensor, mounts the sensor on the +Z guard so its beam crosses the
// bed, then asserts the guard opens there by pixels (no WebGL/console errors)
// and screenshots the hole. Run: node e2e/verify-sensor-guard-hole.mjs [--headed]
/* global process, console, fetch, setTimeout, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
}

async function worldToScreen(page, x, z) {
  return page.evaluate(
    ([wx, wz]) => {
      const v = window.__oip.view
      v.camera.updateMatrixWorld(true)
      const p = v.camera.position.clone().set(wx, 0, wz).project(v.camera)
      const rect = v.renderer.domElement.getBoundingClientRect()
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, inside: p.z < 1 && Math.abs(p.x) < 0.92 && Math.abs(p.y) < 0.92 }
    },
    [x, z],
  )
}

async function ensureVisible(page, x, z) {
  for (let i = 0; i < 8; i++) {
    const s = await worldToScreen(page, x, z)
    if (s.inside) return s
    const c = await worldToScreen(page, 0, 0)
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(120)
  }
  return worldToScreen(page, x, z)
}

async function placePart(page, label, category, [x, z]) {
  const s = await ensureVisible(page, x, z)
  await page.locator('button.catalog-tab', { hasText: new RegExp(`^${category}$`) }).click()
  // SDK package cards render as div.catalog-card > button.catalog-card-main (the clickable face)
  await page
    .locator('button.catalog-card-main')
    .filter({ has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${label}$`) }) })
    .click()
  await page.mouse.move(s.x, s.y, { steps: 3 })
  await page.waitForTimeout(60)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(60)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(40)
}

const sceneOf = (page) => page.evaluate(() => window.__oip.store.getState().scene)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  // keep the onboarding tour off (it re-arms after localStorage.clear() and blocks the catalog)
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  const errors = []
  // benign: headless offscreen thumbnail renderer can't decode the GLB-embedded textures
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !benign(m.text())) errors.push(m.text())
  })

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(2000)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)

    await placePart(page, 'Roller Conveyor', 'Equipment', [0, 0])
    await placePart(page, 'Color Sensor', 'Devices', [8, 0])

    let scene = await sceneOf(page)
    const conv = scene.parts.find((p) => p.packageId === 'oip.roller-conveyor')
    const sensor = scene.parts.find((p) => p.packageId === 'oip.color-sensor')
    check('conveyor placed', !!conv)
    check('sensor placed', !!sensor)
    if (!conv || !sensor) throw new Error('missing parts')

    // shader must already be compiled now that a guard is on screen
    check('no errors after conveyor guard renders', errors.length === 0, errors.slice(0, 3).join(' | '))

    // mount the sensor on the conveyor's +Z guard at the seat its conveyorGuard mount snaps to: lens 0.02 proud of
    // the bed edge (origin 0.037 behind it), 0.02 below the deck (yOffset), beam (local +Z) facing inward across
    // the bed so it crosses both side guards. Typed higher, the beam would clear the 0.15 m guard and test nothing.
    const w = conv.params.width
    const cx = conv.position[0]
    const cy = conv.position[1]
    const cz = conv.position[2]
    const seatZ = cz + w / 2 + 0.02 + 0.037
    // beam off so the A/B pair isolates the cut hole (no green cylinder clutter)
    const mounted = {
      ...sensor,
      position: [cx, cy - 0.02, seatZ],
      rotationY: Math.PI,
      params: { ...sensor.params, maxRange: w + 0.04, showBeam: false },
    }
    // Aim the camera straight at the beam-exit point of the far (-Z) guard from
    // outside it, so the hole projects to the centre of the framebuffer. The SDK
    // color sensor's beam emits from its lens rig link 0.1 above the part origin
    // (examples/parts/color-sensor/rig.json), so at the mounted height the beam
    // crosses the guards at bed + 0.08; the far guard sits a touch beyond -w/2.
    // Read back the centre pixels with the sensor present (hole) vs removed
    // (solid): through the hole the interior shows instead of teal guard metal,
    // so the centre pixels must differ.
    const holeY = cy + 0.08
    const farZ = cz - (w / 2 + 0.04)
    const frame = [cx, holeY, farZ]

    // Aim the camera at the beam-exit point (held for several frames, since the view's own
    // camera logic overrides a one-shot set on the next frame), then average a 24px
    // block at the canvas centre from a clipped screenshot. Screenshot + canvas decode
    // (as the flow-arrow gates do) reads the presented frame; gl.readPixels on the
    // default framebuffer does not: with preserveDrawingBuffer off it samples stale
    // content, and the gate fails while the hole is visibly rendering.
    const readCentre = async ([f], tag) => {
      await page.evaluate(
        ([ff]) =>
          new Promise((res) => {
            const v = window.__oip.view
            let n = 0
            const step = () => {
              v.controls.target.set(ff[0], ff[1], ff[2])
              v.camera.position.set(ff[0], ff[1], ff[2] - 0.85) // 0.85 m outside, looking +Z
              v.controls.update()
              if (n++ < 8) return requestAnimationFrame(step) // let pose + probe settle
              res(null)
            }
            requestAnimationFrame(step)
          }),
        [f],
      )
      const rect = await page.evaluate(() => {
        const r = window.__oip.view.renderer.domElement.getBoundingClientRect()
        return { x: r.left, y: r.top, w: r.width, h: r.height }
      })
      const S = 24
      const path = join(import.meta.dirname, 'shots', `sensor-guard-centre-${tag}.png`)
      await page.screenshot({ path, clip: { x: rect.x + rect.w / 2 - S / 2, y: rect.y + rect.h / 2 - S / 2, width: S, height: S } })
      const b64 = readFileSync(path).toString('base64')
      return page.evaluate(async (s) => {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        return Array.from(ctx.getImageData(0, 0, c.width, c.height).data)
      }, b64)
    }

    // A: sensor mounted -> guard cut, centre pixels see through the hole
    await page.evaluate(
      ([next]) => {
        const st = window.__oip.store
        const s = st.getState().scene
        st.loadScene({ ...s, parts: s.parts.map((p) => (p.id === next.id ? next : p)) })
      },
      [mounted],
    )
    await page.waitForTimeout(400)
    const colHole = await readCentre([frame], 'hole')
    scene = await sceneOf(page)
    const after = scene.parts.find((p) => p.id === sensor.id)
    check('sensor mounted on guard', Math.abs(after.position[2] - seatZ) < 1e-6)
    check('no shader/runtime errors with the sensor mounted', errors.length === 0, errors.slice(0, 5).join(' | '))
    const shotA = join(import.meta.dirname, 'shots', 'sensor-guard-hole.png')
    await page.screenshot({ path: shotA })

    // B: sensor removed -> same guard, solid metal at centre (control)
    await page.evaluate(
      ([sid]) => {
        const st = window.__oip.store
        const s = st.getState().scene
        st.loadScene({ ...s, parts: s.parts.filter((p) => p.id !== sid) })
      },
      [sensor.id],
    )
    await page.waitForTimeout(400)
    const colSolid = await readCentre([frame], 'solid')
    const shotB = join(import.meta.dirname, 'shots', 'sensor-guard-solid.png')
    await page.screenshot({ path: shotB })

    // Per-pixel change count, not channel averages: at the settled camera distance the
    // through-hole view (dark interior + the sensor lens) can average close to the
    // shadowed guard metal, but the pixels that do change (the hole disc / the sensor
    // silhouette seen through it) change strongly.
    let changed = 0
    const n = Math.min(colHole.length, colSolid.length) / 4
    for (let i = 0; i < n; i++) {
      const d =
        Math.abs(colHole[i * 4] - colSolid[i * 4]) +
        Math.abs(colHole[i * 4 + 1] - colSolid[i * 4 + 1]) +
        Math.abs(colHole[i * 4 + 2] - colSolid[i * 4 + 2])
      if (d > 60) changed++
    }
    check(
      'guard centre changes when the sensor cuts a hole',
      changed > 15,
      `${changed}/${n} px changed strongly (need >15)`,
    )
    console.log(`screenshots: ${shotA} (hole) | ${shotB} (solid)`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('verify crashed:', err)
  process.exit(2)
})
