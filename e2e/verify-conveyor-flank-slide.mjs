// Verify the live conveyor snap while a spur is dragged along a roller's flank (src/core/snap/snapConveyor.ts
// snapConveyor, src/editor/controller/liveSnap.ts): real pointer drags on the move gizmo, the controller's held
// candidate sampled at every step.
//
//  1. slide along the flank (world X): the preview holds one join the whole way (the spur's angled front face on
//     the host's +Z flank), tracking the pointer and staying flush. Choosing "end or side" from the spur's
//     body axis would send it to the host's end at this angle.
//  2. pull straight away (world Z): the held join survives past the engage distance (0.3 m) and lets go by the
//     release distance (0.6 m), never trading itself for an end join on the way out.
//  3. control: the same Z drag away from any host tracks the pointer (a dead drag would pass 1-2 vacuously).
//
// Run: node e2e/verify-conveyor-flank-slide.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
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
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
}

// the spur's flush pose on the host's +Z flank at yaw 60° (30° splay): its front-face centre sits OFF = (0.5, -0.906)
// from its origin, i.e. contact x = origin x + 0.5, and the origin is 0.906 + the flange gap off the flank
const YAW = Math.PI / 3

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    const setup = await page.evaluate((yaw) => {
      const { store, getPackage } = window.__oip
      const defaults = (pkg) => Object.fromEntries(Object.entries(pkg.params ?? {}).filter(([, s]) => s && 'default' in s).map(([k, s]) => [k, s.default]))
      const roller = getPackage('oip.roller-conveyor')
      const spur = getPackage('oip.spur-conveyor')
      if (!roller || !spur) return { ok: false, reason: 'roller/spur package not registered' }
      const rp = { ...defaults(roller), length: 6 }
      const hw = rp.width / 2
      // held 0.1 m off flush: the first pointer-move engages it (0.1 < the 0.3 m engage distance)
      const z0 = hw + 0.906 + 0.1 + 0.05
      const parts = [
        { id: 'host', type: 'part', packageId: roller.id, position: [0, 0, 0], rotationY: 0, name: 'host', params: rp },
        { id: 'spur', type: 'part', packageId: spur.id, position: [-1, 0, z0], rotationY: yaw, name: 'spur', params: defaults(spur) },
      ]
      store.loadScene({ version: store.getState().scene.version, parts, packages: [roller, spur] })
      store.setSpace('global')
      store.setTool('move')
      store.select('spur')
      return { ok: store.getState().scene.parts.length === 2, hw, z0 }
    }, YAW)
    check('host roller + spur loaded', setup.ok, setup.reason || '')
    if (!setup.ok) return
    await page.waitForTimeout(600)

    // a world-axis translate handle of the spur's gizmo, the screen direction of +axis, and px per metre
    async function handle(axis) {
      return page.evaluate((axis) => {
        const { view, store } = window.__oip
        const p = store.getState().scene.parts.find((q) => q.id === 'spur').position
        view.camera.updateMatrixWorld(true)
        const c0 = view.worldToScreen(p[0], p[1], p[2])
        const c1 = view.worldToScreen(p[0] + (axis === 'x' ? 1 : 0), p[1], p[2] + (axis === 'z' ? 1 : 0))
        const dir = { x: c1.x - c0.x, y: c1.y - c0.y }
        const pxPerM = Math.hypot(dir.x, dir.y) || 1
        dir.x /= pxPerM
        dir.y /= pxPerM
        for (let r = 8; r <= 300; r += 4) {
          for (const s of [1, -1]) {
            for (let perp = -18; perp <= 18; perp += 6) {
              const x = c0.x + dir.x * r * s - dir.y * perp
              const y = c0.y + dir.y * r * s + dir.x * perp
              if (view.pickGizmoHandle(x, y) === axis) return { x, y, dir, pxPerM }
            }
          }
        }
        return null
      }, axis)
    }

    // drag `metres` along the handle's axis in `steps`, sampling the spur's pose and the held candidate each step
    async function drag(h, metres, steps) {
      const out = []
      await page.mouse.move(h.x, h.y)
      await page.mouse.down()
      for (let i = 1; i <= steps; i++) {
        const m = (metres * i) / steps
        await page.mouse.move(h.x + h.dir.x * m * h.pxPerM, h.y + h.dir.y * m * h.pxPerM)
        await page.waitForTimeout(25)
        out.push({
          m,
          ...(await page.evaluate(() => {
            const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'spur')
            const c = window.__oip.controller.snap.candidate
            return { pos: [...p.position], yaw: p.rotationY, join: c ? `${c.targetId}|${c.via}|${c.join ?? ''}` : null }
          })),
        })
      }
      await page.mouse.up()
      await page.waitForTimeout(250)
      return out
    }
    const restore = async () => {
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(200)
      await page.evaluate(() => window.__oip.store.select('spur'))
      await page.waitForTimeout(300)
    }

    // --- 1. slide along the flank --------------------------------------------------------------------------
    const hx = await handle('x')
    check('found the world X translate handle', !!hx)
    if (!hx) return
    const slide = await drag(hx, 2.0, 40)
    const joins = new Set(slide.map((s) => s.join))
    const FLANK = 'host|conveyor|front -> flank:right'
    check('the slide holds ONE join the whole way', joins.size === 1 && joins.has(FLANK), [...joins].join(' / '))
    const zs = slide.map((s) => s.pos[2])
    check('it stays flush on the flank (z pinned)', Math.max(...zs) - Math.min(...zs) < 1e-6, `z ${Math.min(...zs).toFixed(4)}..${Math.max(...zs).toFixed(4)}`)
    check('seated at the merge angle', slide.every((s) => Math.abs(s.yaw - YAW) < 1e-6))
    const xs = slide.map((s) => s.pos[0])
    // follows the pointer smoothly: forward every step, never a jump (perspective makes px -> m non-linear, so
    // the exact distance is not the claim)
    const steps = xs.slice(1).map((x, i) => x - xs[i])
    const tracks = steps.every((d) => d > 0 && d < 0.1) && xs[xs.length - 1] - xs[0] > 1.5
    check('the spur tracks the pointer along the flank', tracks && new Set(xs.map((x) => x.toFixed(3))).size >= 35, `x ${xs[0].toFixed(2)} -> ${xs[xs.length - 1].toFixed(2)}, max step ${Math.max(...steps).toFixed(3)}`)
    await restore()

    // --- 2. pull away from the flank ---------------------------------------------------------------------
    const hz = await handle('z')
    check('found the world Z translate handle', !!hz)
    if (!hz) return
    // 1.0 m in 40 steps: the mating face starts 0.1 m off, so it reaches the 0.3 engage distance at 0.2 m of
    // pointer travel and the 0.6 release distance at 0.5 m
    const away = await drag(hz, 1.0, 40)
    const heldPast = away.filter((s) => s.m > 0.25 && s.m < 0.45)
    check('held past the engage distance (pointer 0.25-0.45 m out)', heldPast.length > 0 && heldPast.every((s) => s.join === FLANK), `${heldPast.filter((s) => s.join === FLANK).length}/${heldPast.length}`)
    const gone = away.filter((s) => s.m > 0.55)
    check('let go by the release distance (pointer > 0.55 m out)', gone.length > 0 && gone.every((s) => s.join === null), `${gone.filter((s) => s.join === null).length}/${gone.length}`)
    const transitions = away.filter((s, i) => i > 0 && s.join !== away[i - 1].join).length
    check('one clean release, never an end join on the way out', transitions === 1 && away.every((s) => s.join === null || s.join === FLANK), `transitions=${transitions}`)
    await restore()

    // --- 3. control: the same Z drag away from everything tracks the pointer -----------------------------------
    await page.evaluate(() => {
      const { store } = window.__oip
      store.loadScene({ ...store.getState().scene, parts: store.getState().scene.parts.filter((p) => p.id === 'spur') })
      store.select('spur')
    })
    await page.waitForTimeout(400)
    const hz2 = await handle('z')
    const free = hz2 ? await drag(hz2, 1.0, 20) : []
    const freeZ = new Set(free.map((s) => s.pos[2].toFixed(3))).size
    check('control: an unsnapped Z drag tracks the pointer', freeZ >= 18 && free.every((s) => s.join === null), `distinct z=${freeZ}/20`)
  } finally {
    await browser.close()
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.log(`FAIL  harness: ${e?.stack ?? e}`)
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
