// Verify orbit snapping (render/viewport/orbitSnap.ts, viewCamera.applyOrbitSnap): with Alt held through a
// middle-drag orbit, the camera shows the nearest 45° view while the orbit is within 10° of it on both angles; a
// straight view turns the projection auto-orthographic and turning off it reverts that; an orbit released on a snap
// stays there through the damping tail. Controls: the same drag without Alt doesn't snap, and an Alt drag that only
// pans never snaps.
//
// Damping is switched off for the drag cases: headless draws ~3 fps and OrbitControls decays its damping per frame,
// so a damped drag takes tens of seconds to land. The release case keeps damping on, because that is what it tests.
// Run: node e2e/verify-orbit-snap.mjs [--headed]
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const DEG = Math.PI / 180

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

/** put the camera at azimuth theta / polar phi (degrees) about the origin, 12 m out, with nothing in flight */
async function poseAt(page, thetaDeg, phiDeg, damping) {
  await page.evaluate(
    ({ t, p, damping }) => {
      const v = window.__oip.view
      if (v.camera.orthographic) v.setProjection('perspective')
      v.controls.enableDamping = damping
      const r = 12
      const [x, y, z] = [r * Math.sin(p) * Math.sin(t), r * Math.cos(p), r * Math.sin(p) * Math.cos(t)]
      v.setCameraPose({ px: x, py: y, pz: z, tx: 0, ty: 0, tz: 0 }, { instant: true })
    },
    { t: thetaDeg * DEG, p: phiDeg * DEG, damping },
  )
}

/** the camera's azimuth / polar angle about the orbit target, in degrees, and its projection */
const angles = (page) =>
  page.evaluate(() => {
    const v = window.__oip.view
    const d = v.camera.position.clone().sub(v.controls.target)
    const r = d.length()
    return {
      theta: (Math.atan2(d.x, d.z) * 180) / Math.PI,
      phi: (Math.acos(Math.min(1, Math.max(-1, d.y / r))) * 180) / Math.PI,
      ortho: !!v.camera.orthographic,
      auto: v.projectionAuto(),
      maxPhi: (v.controls.maxPolarAngle * 180) / Math.PI,
      target: v.controls.target.length(),
    }
  })

/** a middle-button drag from the viewport centre by (dx, dy) px in a few steps. In the default navigation style a
 *  plain middle drag pans and Shift+middle orbits (core/navigation.ts), so `orbit` holds Shift. */
async function middleDrag(page, dx, dy, { alt = false, orbit = true, release = true } = {}) {
  const shift = orbit
  const box = await page.locator('.viewport canvas').first().boundingBox()
  const x0 = box.x + box.width / 2
  const y0 = box.y + box.height / 2
  if (alt) await page.keyboard.down('Alt')
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(x0, y0)
  await page.mouse.down({ button: 'middle' })
  const steps = 6
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps)
  await frames(page, 3)
  if (release) await page.mouse.up({ button: 'middle' })
  if (shift) await page.keyboard.up('Shift')
  if (alt && release) await page.keyboard.up('Alt')
  return { x0, y0 }
}

/** wait for `n` rendered frames: OrbitControls applies a drag's turn in the frame loop's update, so a drag has to
 *  stay down across frames for the turn to land while the drag is live */
const frames = (page, n) =>
  page.evaluate((n) => new Promise((done) => {
    const step = (k) => (k === 0 ? done() : requestAnimationFrame(() => step(k - 1)))
    step(n)
  }), n)

/** px of horizontal drag that turns the orbit by `deg` (OrbitControls: a full turn per viewport height) */
const pxFor = async (page, deg) => {
  const h = await page.evaluate(() => window.__oip.view.renderer.domElement.clientHeight)
  return Math.round(((deg * DEG) / (2 * Math.PI)) * h)
}

const near = (a, b, tol = 0.05) => Math.abs(a - b) < tol

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  try {
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view?.controls), null, { timeout: 30000 })
    await page.evaluate(() => {
      const st = window.__oip.store
      st.loadScene({ version: st.getState().scene.version, parts: [] })
    })
    // the loading cover takes the pointer until it goes .ready
    await page.waitForFunction(() => {
      const c = document.querySelector('.viewport-cover')
      return !c || c.classList.contains('ready')
    }, null, { timeout: 90000 })

    // control: an orbit to about 44° / 50° without Alt stays where the drag put it
    // (the drag turns the azimuth the other way from the pointer: OrbitControls' rotateLeft)
    const turn = await pxFor(page, 14)
    await poseAt(page, 58, 50, false)
    await middleDrag(page, turn, 0)
    const free = await angles(page)
    check('control: without Alt the orbit turns and does not snap', near(free.theta, 44, 1) && !near(free.theta, 45, 0.3) && near(free.phi, 50, 0.5), `θ ${free.theta.toFixed(2)} φ ${free.phi.toFixed(2)}`)
    const dragTheta = free.theta

    // the same orbit with Alt: lands on the 45° / 45° stop, still perspective (a diagonal isn't an axis view)
    await poseAt(page, 58, 50, false)
    await middleDrag(page, turn, 0, { alt: true })
    const snapped = await angles(page)
    check('with Alt the orbit snaps to the 45° stop', near(snapped.theta, 45) && near(snapped.phi, 45), `θ ${snapped.theta.toFixed(3)} φ ${snapped.phi.toFixed(3)} (unsnapped θ ${dragTheta.toFixed(2)})`)
    check('a diagonal stop stays perspective', !snapped.ortho)

    // an Alt drag that only pans: the angles stay put
    await poseAt(page, 44, 50, false)
    await middleDrag(page, 120, 40, { alt: true, orbit: false })
    const panned = await angles(page)
    check('control: an Alt pan moves the view', panned.target > 0.5, `target ${panned.target.toFixed(2)} m from the origin`)
    check('control: an Alt pan never snaps', near(panned.theta, 44, 0.2) && near(panned.phi, 50, 0.2), `θ ${panned.theta.toFixed(2)} φ ${panned.phi.toFixed(2)}`)

    // a side view: near +X at the horizon clamp, a small Alt orbit snaps onto it and goes auto-orthographic
    await poseAt(page, 86, 84, false)
    const { x0, y0 } = await middleDrag(page, -(await pxFor(page, 1)), 0, { alt: true, release: false })
    await page.waitForFunction(() => window.__oip.view.camera.orthographic, null, { timeout: 5000 }).catch(() => {})
    const side = await angles(page)
    check('a straight side view snaps exactly', near(side.theta, 90) && near(side.phi, side.maxPhi), `θ ${side.theta.toFixed(3)} φ ${side.phi.toFixed(3)} (clamp ${side.maxPhi.toFixed(2)})`)
    check('a straight view turns auto-orthographic', side.ortho && side.auto, `ortho ${side.ortho}, auto ${side.auto}`)
    // keep turning, still holding Alt, well past the threshold: back to the orbit's own angles, and perspective
    const away = await pxFor(page, 30)
    for (let i = 1; i <= 6; i++) await page.mouse.move(x0 - (away * i) / 6, y0)
    await frames(page, 3)
    await page.mouse.up({ button: 'middle' })
    await page.keyboard.up('Alt')
    await page.waitForFunction(() => !window.__oip.view.camera.orthographic, null, { timeout: 5000 }).catch(() => {})
    const left = await angles(page)
    check('turning past the threshold leaves the snap', !near(left.theta, 90, 5), `θ ${left.theta.toFixed(2)}`)
    check('and reverts the auto-orthographic', !left.ortho)

    // released on a snap with damping on: the camera stays on the stop through the damping tail
    await poseAt(page, 46, 44, true)
    await middleDrag(page, -(await pxFor(page, 1.5)), 0, { alt: true })
    await page.waitForTimeout(2500) // ~8 headless frames of damping tail
    const held = await angles(page)
    check('released on a snap, the damping tail does not carry it off', near(held.theta, 45, 0.01) && near(held.phi, 45, 0.01), `θ ${held.theta.toFixed(4)} φ ${held.phi.toFixed(4)}`)
  } finally {
    await browser.close()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
}

try {
  await main()
} finally {
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
