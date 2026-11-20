// Checks that stop resets run-driven poses: a comms-driven six-axis robot and a driven AGV must return to
// their authored state when the sim stops. The robot's rig links go back to the authored `pose` param
// (not frozen at the last sim joint angles), and the AGV's visual root back to the authored transform
// (not parked wherever it drove). Exercises view.resetRunPoses on the run→stop edge. A tiny ST program
// commands both devices to waypoint 1 on the first scan; the script waits until both visibly moved,
// stops, and asserts the post-stop link TRS + roots match the pre-run (authored idle) snapshot.
// Run: node e2e/verify-stop-pose-reset.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const HOME = [10, -30, 40, 0, 50, 20] // authored idle pose (deliberately not the zero rest pose)
const WP1 = [90, 20, -30, 40, -50, 60] // commanded run pose - every joint away from HOME

// no PROGRAM header - the ST engine takes bare VAR blocks + statements (see DEMO_PROGRAM)
const PROGRAM = `VAR_OUTPUT
  ArmCmd : INT;
  ArmExec : BOOL;
  AgvCmd : INT;
  AgvExec : BOOL;
END_VAR
ArmCmd := 1;
AgvCmd := 1;
ArmExec := TRUE;
AgvExec := TRUE;`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  // per-part TRS snapshot: the visual root's position/yaw + every named descendant's local position
  // + quaternion (path-keyed). The frame appliers write local TRS, so a stale matrixWorld can't skew it.
  const snap = (id) => page.evaluate((id) => {
    const e = window.__oip.view.entries?.get(id) // TS-private map, reachable at runtime
    if (!e) return null
    const root = e.visual.object
    const links = {}
    const walk = (o, path) => {
      o.children.forEach((c, i) => {
        const key = `${path}/${c.name || i}`
        links[key] = [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w]
        walk(c, key)
      })
    }
    walk(root, '')
    return { root: [root.position.x, root.position.y, root.position.z, root.rotation.y], links }
  }, id)

  // max abs TRS delta between two snapshots across common link keys (+ the root)
  const diff = (a, b) => {
    let max = 0, n = 0
    for (let i = 0; i < 4; i++) max = Math.max(max, Math.abs(a.root[i] - b.root[i]))
    for (const k of Object.keys(a.links)) {
      const l1 = a.links[k], l2 = b.links[k]
      if (!l2) continue
      n++
      for (let i = 0; i < 7; i++) max = Math.max(max, Math.abs(l1[i] - l2[i]))
    }
    return { max, n }
  }

  try {
    // warm-up visit: a cold vite may re-optimize deps and fully reload the page mid-script,
    // destroying evaluate contexts. Visit once, let it settle, then reload and run for real
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(3000)
    errors.length = 0 // drop warm-up noise (interrupted fetches from the re-optimize reload)
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    const ok = await page.evaluate(({ HOME, WP1 }) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkgs = st.getState().bundledPackages
      const robotPkg = pkgs.find((p) => p.id === 'oip.six-axis-robot')
      const agvPkg = pkgs.find((p) => p.id === 'oip.agv')
      if (!robotPkg || !agvPkg) return false
      const parts = [
        { id: 'robot_1', type: 'part', packageId: 'oip.six-axis-robot', position: [0, 0, 0], rotationY: 0, params: {
          commandTag: 'ArmCmd', executeTag: 'ArmExec',
          waypoints: [HOME, WP1], pose: [HOME],
        } },
        { id: 'agv_1', type: 'part', packageId: 'oip.agv', position: [0, 0, 3], rotationY: 0, params: {
          commandTag: 'AgvCmd', executeTag: 'AgvExec',
          waypoints: [[0, 3, 0, 0], [4, 3, 90, 0]], driveSpeed: 2,
        } },
      ]
      st.loadScene({ ...scene, parts, packages: [robotPkg, agvPkg] })
      st.setState({ selectedIds: [] })
      return true
    }, { HOME, WP1 })
    check('scene loaded (robot + AGV packages found)', ok)
    if (!ok) throw new Error('bundled packages missing')

    await page.waitForTimeout(3000) // GLB rig links stream in + the authored idle pose settles
    const robot0 = await snap('robot_1')
    const agv0 = await snap('agv_1')
    check('authored snapshots captured', !!robot0 && !!agv0,
      robot0 && agv0 ? `robot links=${Object.keys(robot0.links).length} agv links=${Object.keys(agv0.links).length}` : 'missing entry')

    // run: the program commands both devices to waypoint 1 on the first scan (rising execute edge)
    await page.evaluate((src) => {
      window.__oip.store.loadStProgram(src, { persist: false }) // live, not written to the document
      window.__oip.controller.run()
    }, PROGRAM)

    // wait until both visibly moved off the authored state (robot joints swing, AGV drives ~4 m)
    let robotMoved = 0, agvMoved = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 25000) {
      await page.waitForTimeout(400)
      const r = await snap('robot_1'), a = await snap('agv_1')
      robotMoved = Math.max(robotMoved, diff(robot0, r).max)
      agvMoved = Math.max(agvMoved, diff(agv0, a).max)
      if (robotMoved > 0.05 && agvMoved > 0.5) break
    }
    if (robotMoved <= 0.05 || agvMoved <= 0.5) {
      // nothing moved: dump the program status + last frame tags so the failure is diagnosable
      const dbg = await page.evaluate(() => {
        const c = window.__oip.controller
        return { status: c.programStatus, frame: !!c.lastFrame, tags: c.lastFrame?.tags ?? null }
      })
      console.log('DEBUG', JSON.stringify(dbg))
    }
    check('robot rig MOVED while running', robotMoved > 0.05, `max link delta=${robotMoved.toFixed(3)}`)
    check('AGV MOVED while running (root driven)', agvMoved > 0.5, `max delta=${agvMoved.toFixed(3)}`)

    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(600) // one frame for the reset + idle re-pose cascade

    const robot1 = await snap('robot_1')
    const agv1 = await snap('agv_1')
    const rd = diff(robot0, robot1)
    const ad = diff(agv0, agv1)
    const EPS = 1e-3
    check('sim stopped', await page.evaluate(() => !window.__oip.store.getState().running))
    check('robot rig RESET to the authored pose on stop', rd.max < EPS, `max delta=${rd.max.toExponential(2)} over ${rd.n} links`)
    check('AGV root + links RESET to the authored transform on stop', ad.max < EPS, `max delta=${ad.max.toExponential(2)} over ${ad.n} links`)
    // the authored data never moved, only the pixels did during the run (sanity: stop must not write the scene)
    const dataOk = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const r = parts.find((p) => p.id === 'robot_1'), a = parts.find((p) => p.id === 'agv_1')
      return !!r && !!a && r.position.join() === '0,0,0' && a.position.join() === '0,0,3'
    })
    check('authored part data untouched', dataOk)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
