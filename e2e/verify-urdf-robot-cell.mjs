// An imported URDF arm runs a pick-and-place cell from end to end, the way an agent builds one (editor/agent/tools.ts):
//
//   A) Import part > A robot (unzipped folder)... makes a robot part that idles in its ready pose: the tool straight down, in front
//      of the base, the elbow up (core/robot/robotIk.ts robotReadyPose), and that pose is its Home waypoint
//   B) the cell goes together with the agent tools: a riser, an infeed belt stopped by a photo-eye, an outfeed belt to a
//      despawner, a box spawner held by the infeed's interlock
//   C) solve_robot_pose teaches the pick and place by position, starting from Home, and every pose is reached with the
//      tool down and the elbow still up (a solve from the URDF's zero pose came back with the forearm under the belt)
//   D) one job (move, grip, lift, swing, place, release, home) run by the PLC ships boxes: run_test proves three in 70 s
//      headlessly, and the live run in the page ships them too
//
// The arm is written here, first-party: six revolute joints with round-number links, drawn with URDF primitives, lying
// flat at zero as URDF arms are often drawn. It has no hand, so it carries the app's vacuum plate.
//
//   node e2e/verify-urdf-robot-cell.mjs
/* global process, console, window, localStorage */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

// ---- the arm ------------------------------------------------------------------------------------------------------

const PI = Math.PI.toFixed(7)
const cyl = (r, l, xyz = '0 0 0', rpy = '0 0 0', color = 'grey') =>
  `<visual><origin xyz="${xyz}" rpy="${rpy}"/><geometry><cylinder radius="${r}" length="${l}"/></geometry><material name="${color}"/></visual>`
const box = (size, xyz, color = 'blue') => `<visual><origin xyz="${xyz}" rpy="0 0 0"/><geometry><box size="${size}"/></geometry><material name="${color}"/></visual>`
const joint = (name, parent, child, xyz, axis, limit = 2 * Math.PI) =>
  `<joint name="${name}" type="revolute"><parent link="${parent}"/><child link="${child}"/><origin xyz="${xyz}" rpy="0 0 0"/>` +
  `<axis xyz="${axis}"/><limit lower="${-limit}" upper="${limit}" effort="100" velocity="3"/></joint>`

const URDF = `<?xml version="1.0"?>
<robot name="cell_arm">
  <material name="grey"><color rgba="0.55 0.57 0.6 1"/></material>
  <material name="blue"><color rgba="0.2 0.45 0.8 1"/></material>
  <link name="base_link">${cyl(0.08, 0.1, '0 0 0.05')}</link>
  <link name="shoulder">${cyl(0.06, 0.13, '0 0.065 0', `${PI / 2} 0 0`)}</link>
  <link name="upper_arm">${box('0.42 0.09 0.09', '0.21 0 0')}</link>
  <link name="forearm">${box('0.4 0.07 0.07', '0.2 0 0')}</link>
  <link name="wrist_1">${cyl(0.045, 0.1, '0 0.05 0', `${PI / 2} 0 0`)}</link>
  <link name="wrist_2">${cyl(0.045, 0.1, '0 0 -0.05')}</link>
  <link name="wrist_3">${cyl(0.04, 0.08, '0 0.04 0', `${PI / 2} 0 0`, 'blue')}</link>
  <link name="tool0"/>
  ${joint('j1', 'base_link', 'shoulder', '0 0 0.1', '0 0 1')}
  ${joint('j2', 'shoulder', 'upper_arm', '0 0.13 0', '0 1 0')}
  ${joint('j3', 'upper_arm', 'forearm', '0.42 -0.12 0', '0 1 0', Math.PI)}
  ${joint('j4', 'forearm', 'wrist_1', '0.4 0 0', '0 1 0')}
  ${joint('j5', 'wrist_1', 'wrist_2', '0 0.1 0', '0 0 1')}
  ${joint('j6', 'wrist_2', 'wrist_3', '0 0 -0.1', '0 1 0')}
  <joint name="flange" type="fixed"><parent link="wrist_3"/><child link="tool0"/><origin xyz="0 0.08 0" rpy="${-PI / 2} 0 0"/></joint>
</robot>`

const dir = mkdtempSync(join(tmpdir(), 'oip-urdf-cell-'))
const pkg = join(dir, 'cell_arm_description')
mkdirSync(join(pkg, 'urdf'), { recursive: true })
writeFileSync(join(pkg, 'urdf', 'cell_arm.urdf'), URDF)

// ---- the cell -----------------------------------------------------------------------------------------------------

const BASE = 0.6 // the riser's deck, where the arm stands
const DECK = 0.5 // both belts' stand height
const PROGRAM = `VAR_INPUT
  Eye : BOOL;
  Done : BOOL;
  Shipped : INT;
END_VAR
VAR_OUTPUT
  InRun : BOOL;
  Cmd : INT;
  Exec : BOOL;
END_VAR
InRun := NOT Eye;
Cmd := 1;
Exec := Eye AND Done AND ARMED;
`

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${detail ? `  (${detail})` : ''}`)
}

const { url: URL, vite } = await startServer()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('dialog', (d) => void d.accept())

/** an agent tool call, as the MCP door makes it; a refusal fails the gate with its reason */
const call = async (name, args) => {
  const r = await page.evaluate(
    async ([n, a]) => {
      const m = await import('/src/editor/agent/tools.ts')
      return m.callAgentTool({ store: window.__oip.store, controller: window.__oip.controller }, n, a)
    },
    [name, args],
  )
  if (!r.ok) throw new Error(`${name}: ${r.error}`)
  return r.value
}

try {
  await page.goto(URL, { timeout: 120000 })
  await page.waitForFunction(() => !!window.__oip?.controller, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
  await page.evaluate(() => {
    const st = window.__oip.store
    window.__oip.loadSceneText(JSON.stringify({ version: st.getState().scene.version, parts: [] }))
    st.loadStProgram('')
  })

  // A) the import and its ready pose
  const before = await page.evaluate(() => window.__oip.store.getState().userPackages.length)
  await page.getByTestId('catalog-import-robot-input').setInputFiles(pkg)
  await page.waitForFunction((n) => window.__oip.store.getState().userPackages.length > n, before, { timeout: 120000 })
  const pkgId = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return s.userPackages[s.userPackages.length - 1].id
  })
  await page.evaluate(() => window.__oip.controller.closePartScene?.())
  await call('add_part', { package: 'oip.platform', position: [0, BASE, 0], name: 'Riser', params: { length: 0.5, width: 0.5, height: BASE, deckSurface: 'deck', showRailings: false } })
  const robot = await call('add_part', { package: pkgId, position: [0, BASE, 0], name: 'Arm', params: { commandTag: 'Cmd', executeTag: 'Exec', doneTag: 'Done' } })
  const idle = await call('get_robot_pose', { id: robot.id })
  const homeRow = await call('get_robot_pose', { id: robot.id, waypoint: 0 })
  check('A  the import idles with the tool straight down', idle.tiltFromDownDeg < 0.5, `tilt ${idle.tiltFromDownDeg}°, row ${idle.row.join(' ')}`)
  check('A  ... in front of the base, above its deck', idle.grip[0] > 0.3 && Math.abs(idle.grip[2]) < 0.01 && idle.grip[1] > BASE, `grip at ${idle.grip.join(', ')}`)
  // elbow up: J2 lifts the upper arm (0 lies flat along +X, -90 stands it up), J3 folds the forearm back down
  check('A  ... elbow up', idle.row[1] < -45 && idle.row[1] > -135 && idle.row[2] > 30, `J2 ${idle.row[1]}°, J3 ${idle.row[2]}°`)
  check('A  ... and that pose is Home', JSON.stringify(homeRow.row) === JSON.stringify(idle.row), `Home ${homeRow.row.join(' ')}`)

  // B) the cell
  const belt = { shapePreset: 'custom', width: 0.5, fpmUnits: false, speed: 0.4, standHeight: DECK }
  const infeed = await call('add_part', { package: 'oip.belt-conveyor', position: [-3.4, DECK, -0.56], name: 'Infeed', params: { ...belt, segments: [[3.2, 0]], runTag: 'InRun' } })
  await call('add_part', { package: 'oip.belt-conveyor', position: [0.2, DECK, 0.56], name: 'Outfeed', params: { ...belt, segments: [[3.2, 0]] } })
  await call('add_part', {
    package: 'oip.box-spawner', position: [-3.1, DECK + 0.6, -0.56], name: 'Feed',
    params: { boxesPerMinute: 5, length: 0.3, width: 0.3, height: 0.2, mass: 3, conveyorId: infeed.id },
  })
  await call('add_part', { package: 'oip.despawner', position: [3.1, DECK, 0.56], name: 'Shipping', params: { length: 0.6, width: 0.8, height: 0.6, countTag: 'Shipped' } })
  const eye = await call('add_part', { package: 'oip.diffuse-sensor', position: [-0.25, DECK + 0.5, -1], params: { tag: 'Eye' } })
  await call('snap_part', { id: eye.id, onto: infeed.id, near: [-0.25, DECK, -0.75] })
  await call('set_program', { source: PROGRAM.replace(' AND ARMED', ' AND FALSE') })
  const probe = await call('run_test', { spec: { duration: 20, checks: [{ eventually: true, within: 20, tag: 'Eye', equals: true }] }, cargo: [20] })
  const waiting = probe.ok ? probe.cargo[0].bodies.filter((b) => b.pos[2] < 0).reduce((a, b) => (b.pos[0] > a.pos[0] ? b : a)) : null
  check('B  with the robot idle, the first box stops at the eye', !!waiting, waiting ? `box at ${waiting.pos.map((v) => v.toFixed(3)).join(', ')}` : JSON.stringify(probe).slice(0, 300))
  if (!waiting) throw new Error('no box to pick')

  // C) teach by position from Home
  const top = waiting.pos[1] + 0.1
  const pick = [waiting.pos[0], top, waiting.pos[2]]
  const place = [0.5, top + 0.02, 0.56]
  const above = (p) => [p[0], p[1] + 0.15, p[2]]
  const rows = []
  for (const [label, target] of [['above pick', above(pick)], ['pick', pick], ['above place', above(place)], ['place', place]]) {
    const r = await call('solve_robot_pose', { id: robot.id, target, from: rows.length })
    check(`C  ${label} is reached, tool down, elbow up`, r.reached && r.tiltDeg < 1 && r.row[1] < -20 && r.row[1] > -160, `miss ${r.missMm} mm, tilt ${r.tiltDeg}°, row ${r.row.join(' ')}`)
    rows.push(r.row)
    await call('update_part', { id: robot.id, params: { waypoints: [idle.row, ...rows] } })
  }
  const S = (op, a, b = 0) => [0, op, a, b]
  await call('update_part', {
    id: robot.id,
    params: {
      waypointNames: 'Home\nAbove pick\nPick\nAbove place\nPlace',
      jobs: [S(1, 1), S(1, 2), S(2, 1), S(3, 0.3), S(1, 1, 1), S(1, 3, 1), S(1, 4), S(2, 0), S(3, 0.3), S(1, 3, 1), S(1, 0)],
      jobNames: 'Pick and place',
    },
  })
  await call('set_program', { source: PROGRAM.replace(' AND ARMED', '') })

  // D) the PLC runs it
  const proof = await call('run_test', { spec: { duration: 70, checks: [{ eventually: true, within: 70, tag: 'Shipped', equals: 3 }] } })
  check('D  run_test: the cell ships three boxes in 70 s', proof.ok, proof.ok ? '' : JSON.stringify(proof).slice(0, 400))
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => (window.__oip.controller.lastFrame?.simTime ?? 0) > 45, null, { timeout: 180000, polling: 500 })
  const live = await call('get_tags', { names: ['Shipped'] })
  check('D  the live run ships them too', live.tags.Shipped >= 2, `Shipped = ${live.tags.Shipped} at 45 s`)
  await page.evaluate(() => window.__oip.controller.stop())
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} catch (e) {
  failures++
  console.log(`FAIL  harness: ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
