// End-to-end check: a remote peer's cursor is drawn on the point they are pointing at.
//
// Two live collaborators in one room. A rests its pointer over a known spot in its viewport;
// B must draw A's presence cursor at the projection of that same world point in B's own camera,
// i.e. B can raycast through the arrow's tip and get back the world point A resolved.
//
// The bug this guards: view.worldToScreen() returns client (window) coords, but the presence
// markers are positioned inside `.presence-overlay` (absolute, inset:0 in `.viewport`). Writing
// client coords into that container-relative space shifts every remote cursor / selection ring /
// pilot name tag down-right by the viewport's client origin: 226 x 48 px on this 1280x800 layout.
//
// Also checks the marker tracks B's own camera (the cursor is a world point, so when B orbits it
// must stay on the same spot in the scene) and A's camera (the world point is re-resolved after A
// orbits without moving the mouse; otherwise B sees a cursor stuck where A was pointing before).
//
// Run: node e2e/verify-presence-cursor-align.mjs [--headed]
/* global process, console, setTimeout, clearTimeout, URL, window, document */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { editSecret, markSeeder } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')
// the arrow SVG's tip is at (2,2) inside its 20x20 box, and the marker is CSS-shifted by (-2,-2):
// so the tip sits 2px in from the marker's own client rect on both axes
const TIP_INSET = 2
const TIP_TOL = 2.5

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port; the client picks it up via VITE_COLLAB_URL ---
const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-cursor-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
collab.stderr.on('data', (d) => process.stderr.write(`[collab] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

// isolated: a shared `npm run e2e:server` was booted without our VITE_COLLAB_URL, so attaching to
// it would point both clients at the production collab server and this gate would test nothing
const { url: APP_URL, vite } = await startServer({ isolated: true })
const ROOM = editSecret(`verify-cursor-align-${collabPort}`)

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 30000 })
const waitForPeers = (page, n) =>
  page.waitForFunction(
    (min) => {
      const el = document.querySelector('.collab-status.connected')
      // the avatars carry the count in their label (PresenceStack: "2 people here")
      const m = el && (el.querySelector('[data-testid=presence]')?.getAttribute('aria-label') ?? '').match(/(\d+)/)
      return !!m && Number(m[1]) >= min
    },
    n,
    { timeout: 30000 },
  )

/** where B currently draws A's cursor: the client coords of the arrow's tip */
const readMarker = (page, inset) =>
  page.evaluate((i) => {
    const el = document.querySelector('.presence-cursor')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { tip: { x: r.left + i, y: r.top + i } }
  }, inset)

/** wait until the camera has stopped moving (setCameraPose animates + the controls damp) */
const settleCamera = async (page) => {
  await page.waitForFunction(
    () => {
      const v = window.__oip.view
      const p = v.cameraPose()
      const sig = `${p.px.toFixed(4)},${p.py.toFixed(4)},${p.pz.toFixed(4)},${p.tx.toFixed(4)},${p.ty.toFixed(4)},${p.tz.toFixed(4)}`
      const w = window
      const stable = w.__camSig === sig ? (w.__camStable || 0) + 1 : 0
      w.__camSig = sig
      w.__camStable = stable
      return stable > 5
    },
    { timeout: 15000, polling: 'raf' },
  )
  await page.evaluate(() => { delete window.__camSig; delete window.__camStable })
  await page.waitForTimeout(250) // one more presence frame after the last camera frame
}

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  for (const [tag, p] of [['A', a], ['B', b]]) {
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))
    await p.addInitScript(() => {
      try { window.localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ }
    })
  }

  await markSeeder(a, ROOM)
  await a.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(a)
  await b.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(b)
  await waitForPeers(a, 2)
  await waitForPeers(b, 2)
  await a.waitForTimeout(1500)
  check('both clients in the room', true)

  // A points at a spot inside its viewport, off-centre so a container-origin bug can't cancel out
  const target = await a.evaluate(() => {
    const c = document.querySelector('.viewport canvas').getBoundingClientRect()
    return { x: Math.round(c.left + c.width * 0.62), y: Math.round(c.top + c.height * 0.58) }
  })
  await a.mouse.move(target.x, target.y)
  await a.waitForTimeout(600)

  // the world point A published (resolve it the same way the overlay does)
  const world = await a.evaluate((p) => {
    const view = window.__oip.view
    const hit = view.surfaceAt(p.x, p.y)
    if (hit) return hit.point
    const g = view.groundPoint(p.x, p.y)
    return g ? [g.x, 0, g.z] : null
  }, target)
  check('A resolved a world point under its pointer', !!world, world && world.map((n) => n.toFixed(2)).join(', '))

  // waitForFunction, not waitForSelector: the marker lives in a `pointer-events: none` overlay that
  // the presence rAF loop rewrites continuously, and Playwright's visibility poller does not settle
  // on it. Being in the DOM with a real box is the condition we need.
  await b.waitForFunction(() => {
    const el = document.querySelector('.presence-cursor')
    return !!el && el.getBoundingClientRect().width > 0
  }, { timeout: 15000 })
  check("B renders A's cursor", true)

  // the main assertion: B's marker tip sits where B's own camera projects that world point
  const expect1 = await b.evaluate((w) => window.__oip.view.worldToScreen(w[0], w[1], w[2]), world)
  const got1 = await readMarker(b, TIP_INSET)
  const d1 = Math.hypot(got1.tip.x - expect1.x, got1.tip.y - expect1.y)
  check(
    "B draws A's cursor on the projected world point",
    d1 <= TIP_TOL,
    `off by ${d1.toFixed(1)}px (tip ${got1.tip.x.toFixed(0)},${got1.tip.y.toFixed(0)} vs ${expect1.x.toFixed(0)},${expect1.y.toFixed(0)})`,
  )

  // and it is anchored in the scene: raycasting B's viewport through the tip returns A's point
  const backWorld = await b.evaluate((t) => {
    const view = window.__oip.view
    const hit = view.surfaceAt(t.x, t.y)
    if (hit) return hit.point
    const g = view.groundPoint(t.x, t.y)
    return g ? [g.x, 0, g.z] : null
  }, got1.tip)
  const worldErr = backWorld ? Math.hypot(backWorld[0] - world[0], backWorld[1] - world[1], backWorld[2] - world[2]) : Infinity
  check(
    'the marker points at the same place in the scene for B (world round-trip)',
    worldErr < 0.15,
    `${worldErr.toFixed(3)} m`,
  )

  // B orbits: the marker must follow the world point, not stay put on screen
  await b.evaluate(() => {
    const v = window.__oip.view
    const p = v.cameraPose()
    v.setCameraPose({ px: p.px + 6, py: p.py + 3, pz: p.pz - 5, tx: p.tx, ty: p.ty, tz: p.tz })
  })
  await settleCamera(b)
  const expect2 = await b.evaluate((w) => window.__oip.view.worldToScreen(w[0], w[1], w[2]), world)
  const got2 = await readMarker(b, TIP_INSET)
  const d2 = got2 ? Math.hypot(got2.tip.x - expect2.x, got2.tip.y - expect2.y) : Infinity
  check('the marker tracks B moving its own camera', d2 <= TIP_TOL, `off by ${d2.toFixed(1)}px`)

  // A orbits without moving the mouse: its pointer now aims elsewhere, so B's marker must move
  const worldBefore = world
  await a.evaluate(() => {
    const v = window.__oip.view
    const p = v.cameraPose()
    v.setCameraPose({ px: p.px + 9, py: p.py + 4, pz: p.pz + 7, tx: p.tx, ty: p.ty, tz: p.tz })
  })
  await settleCamera(a)
  await a.waitForTimeout(600) // let the re-resolved cursor travel to B over awareness
  const worldAfter = await a.evaluate((p) => {
    const view = window.__oip.view
    const hit = view.surfaceAt(p.x, p.y)
    if (hit) return hit.point
    const g = view.groundPoint(p.x, p.y)
    return g ? [g.x, 0, g.z] : null
  }, target)
  const aMoved = worldAfter
    ? Math.hypot(worldAfter[0] - worldBefore[0], worldAfter[1] - worldBefore[1], worldAfter[2] - worldBefore[2])
    : 0
  check("A's pointer now aims at a different world point (precondition)", aMoved > 0.5, `${aMoved.toFixed(2)} m`)
  const expect3 = await b.evaluate((w) => window.__oip.view.worldToScreen(w[0], w[1], w[2]), worldAfter)
  const got3 = await readMarker(b, TIP_INSET)
  const d3 = got3 ? Math.hypot(got3.tip.x - expect3.x, got3.tip.y - expect3.y) : Infinity
  check(
    "B's marker follows A's camera move (no stale world point)",
    d3 <= TIP_TOL,
    `off by ${d3.toFixed(1)}px`,
  )
} catch (e) {
  failures++
  console.log(`FAIL  unexpected error: ${e instanceof Error ? e.stack : e}`)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
  try {
    rmSync(dbPath, { force: true })
  } catch {
    /* ignore */
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
