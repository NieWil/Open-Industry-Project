/* global console, process, window, Image, document */
// WebGPU sensor-beam guard-hole gate (the WebGL twin is verify-sensor-guard-hole.mjs).
//
// A beam's hole through a side guard is geometry (core/guards/guardHoles.ts works it out from the scene; the rig
// roller's guard splitter draws a panel with the hole cut through, tagged userData.guardHolePanel), not a
// shader cutout. So this asserts structurally that the conveyor draws a holed panel in each guard the beam
// crosses (and none once the sensor is removed), as well as by pixels: a pixel-only check can't tell
// "no hole" from "camera framing drifted".
//
// Run: node e2e/verify-sensor-guard-hole-webgpu.mjs [--headed]
// Needs a real WebGPU adapter; headless Chromium usually has none, so the script
// launches headed by default (like the other WebGPU gates) and skips if Dawn is absent.
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { port: PORT, vite } = await startServer()

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function main() {
  const browser = await chromium.launch({
    headless: false, // a real adapter; headless Chromium reports none and the run would be void
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  try {
    await page.goto(`http://localhost:${PORT}/app/?webgpu`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
    await page.waitForTimeout(2500)

    const backend = await page.evaluate(() => {
      const r = window.__oip.view.renderer
      return r?.isWebGPURenderer ? (r.backend ? r.backend.constructor.name : 'unknown-webgpu') : 'WebGL'
    })
    if (backend !== 'WebGPUBackend') {
      console.log(`SKIP: no WebGPU adapter (backend=${backend}) - this gate needs Dawn`)
      return
    }
    console.log(`backend: ${backend}`)

    // Build the scene directly (no catalog clicking): a roller conveyor with the colour
    // sensor mounted on its +Z guard, beam aimed across the bed so it crosses both guards.
    const geom = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const defaults = (id) => {
        const pkg = getPackage(id)
        if (!pkg) return null
        const params = {}
        for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
        return { pkg, params }
      }
      const conv = defaults('oip.roller-conveyor')
      const sen = defaults('oip.color-sensor')
      if (!conv || !sen) return { error: 'packages missing' }
      const w = conv.params.width
      const cy = 1.0
      const parts = [
        { id: 'conv', type: 'part', packageId: 'oip.roller-conveyor', position: [0, cy, 0], rotationY: 0, name: 'Conv', params: conv.params },
        {
          id: 'sensor',
          type: 'part',
          packageId: 'oip.color-sensor',
          // the seat its conveyorGuard mount snaps to: lens 0.02 proud of the bed edge (origin 0.037 behind it),
          // 0.02 below the deck (yOffset). Typed higher, the beam would clear the 0.15 m guard and test nothing.
          position: [0, cy - 0.02, w / 2 + 0.02 + 0.037],
          rotationY: Math.PI,
          name: 'Sensor',
          // beam off: the green beam cylinder would itself change the sampled pixels
          params: { ...sen.params, maxRange: w + 0.04, showBeam: false },
        },
      ]
      store.loadScene({ version: store.getState().scene.version, parts, packages: [conv.pkg, sen.pkg] })
      // the beam crosses the guards at bed+0.08 (lens link 0.1 above the part origin, seated 0.02 below the deck)
      return { w, frame: [0, cy + 0.08, -(w / 2 + 0.04)] }
    })
    if (geom.error) throw new Error(geom.error)
    await page.waitForSelector('.viewport-cover.ready', { timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(2500)

    // ---- structural: the conveyor draws a holed panel in each guard the beam crosses ----
    const countPanels = () => page.evaluate(async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
      let n = 0
      for (let i = 0; i < 30; i++) {
        n = 0
        window.__oip.view.scene.traverse((o) => { if (o.userData?.guardHolePanel === true && o.parent) n++ })
        if (n > 0) break
        await raf()
      }
      return n
    })
    const panels = await countPanels()
    check('the beam cuts a hole in both guards it crosses (two holed panels)', panels === 2, `panels=${panels}`)

    // ---- pixels: the far guard must actually open where the beam crosses it ----
    // Hold the pose across several frames: the view's own camera logic overrides a
    // one-shot set on the next frame, and a clipped screenshot reads the presented
    // frame (gl.readPixels on the default framebuffer samples stale content here).
    const readCentre = async (tag) => {
      await page.evaluate(
        (f) =>
          new Promise((res) => {
            const v = window.__oip.view
            let n = 0
            const step = () => {
              v.controls.target.set(f[0], f[1], f[2])
              v.camera.position.set(f[0], f[1], f[2] - 0.85) // 0.85 m outside, looking +Z
              v.controls.update()
              if (n++ < 8) return requestAnimationFrame(step)
              res(null)
            }
            requestAnimationFrame(step)
          }),
        geom.frame,
      )
      const rect = await page.evaluate(() => {
        const r = window.__oip.view.renderer.domElement.getBoundingClientRect()
        return { x: r.left, y: r.top, w: r.width, h: r.height }
      })
      const S = 24
      const path = join(import.meta.dirname, 'shots', `sensor-guard-webgpu-${tag}.png`)
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

    const hole = await readCentre('hole')
    // human-readable record at the settled pose: the cut disc in the far guard
    const closeUp = await page.evaluate(() => {
      const r = window.__oip.view.renderer.domElement.getBoundingClientRect()
      return { x: r.left + r.width / 2 - 180, y: r.top + r.height / 2 - 120, width: 360, height: 240 }
    })
    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'sensor-guard-webgpu-closeup.png'), clip: closeUp })
    await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.loadScene({ ...s, parts: s.parts.filter((p) => p.id !== 'sensor') })
    })
    await page.waitForTimeout(700)
    const panelsAfter = await page.evaluate(() => {
      let n = 0
      window.__oip.view.scene.traverse((o) => { if (o.userData?.guardHolePanel === true && o.parent) n++ })
      return n
    })
    check('the holes close when the sensor goes (no holed panel left)', panelsAfter === 0, `panels=${panelsAfter}`)
    const solid = await readCentre('solid')

    // Per-pixel change count, not channel averages: the through-hole view (dark interior)
    // can average close to shadowed guard metal, but the pixels that do change, change strongly.
    let changed = 0
    const n = Math.min(hole.length, solid.length) / 4
    for (let i = 0; i < n; i++) {
      const d =
        Math.abs(hole[i * 4] - solid[i * 4]) +
        Math.abs(hole[i * 4 + 1] - solid[i * 4 + 1]) +
        Math.abs(hole[i * 4 + 2] - solid[i * 4 + 2])
      if (d > 60) changed++
    }
    check('guard opens where the sensor beam crosses it', changed > 15, `${changed}/${n} px changed strongly (need >15)`)
    check('no shader/runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    vite.kill('SIGTERM')
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('verify crashed:', err)
  process.exit(2)
})
