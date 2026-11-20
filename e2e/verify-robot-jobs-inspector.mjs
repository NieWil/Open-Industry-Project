// The six-axis robot's jobs, as the Inspector shows them (inspector/program.tsx, ParamSpec.program + rowNames):
//  1. the jobs table draws as job cards of readable steps ("Move  Pick  Stop"), named waypoints included
//  2. clicking a Move step poses the arm at that step's waypoint (controller.previewRigPose), and reveals the
//     step's own actions; an edit made there (a waypoint picked from the dropdown) is one undo step
//  3. deleting a waypoint a job moves to marks that step missing instead of re-pointing it at a neighbour
//  4. running, the step the robot is on is highlighted (the part's ctx.report), and the job shows "running"
// Screenshots land in e2e/shots/robot-jobs-*.png for a person to judge the look.
// Run: node e2e/verify-robot-jobs-inspector.mjs [--headed]
/* global process, console, window, localStorage */
import { mkdirSync } from 'node:fs'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const APP = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
mkdirSync('e2e/shots', { recursive: true })
const shot = (name) => `e2e/shots/robot-jobs-${name}.png`

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const MOVE = 1
const VACUUM = 2
const WAIT = 3
const WAIT_FOR = 4
const SET_OUT = 5
const WAYPOINTS = [
  [0, -45, 90, 25, 75, 0],
  [0, -15, 55, 0, 80, 0],
  [0, -5, 55, 0, 80, 0],
  [100, -15, 55, 0, 80, 0],
  [100, -5, 55, 0, 80, 0],
]
const JOBS = [
  [0, MOVE, 1, 1],
  [0, MOVE, 2, 0],
  [0, VACUUM, 1, 0],
  [0, WAIT, 0.4, 0],
  [0, MOVE, 1, 1],
  [0, SET_OUT, 0, 1],
  [1, WAIT_FOR, 0, 1],
  [1, MOVE, 3, 1],
  [1, MOVE, 4, 0],
  [1, VACUUM, 0, 0],
  [1, MOVE, 0, 0],
]
// a bare-VAR program (the ST engine takes one, see DEMO_PROGRAM) that runs job 1 a few scans in
const PROGRAM = `VAR_OUTPUT
  RobotCmd : INT;
  RobotExec : BOOL;
END_VAR
VAR
  n : INT;
END_VAR
n := n + 1;
RobotCmd := 1;
RobotExec := n > 5;`

const browser = await chromium.launch({ headless: !HEADED })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
try {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  const ready = () => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
  await ready()
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ready()

  const loaded = await page.evaluate(({ WAYPOINTS, JOBS }) => {
    const { store, getPackage } = window.__oip
    const pkg = getPackage('oip.six-axis-robot')
    if (!pkg) return 'no oip.six-axis-robot package'
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
    Object.assign(params, {
      waypoints: WAYPOINTS,
      waypointNames: 'Home\nAbove pick\nPick\nAbove place\nPlace',
      jobs: JOBS,
      jobNames: 'Pick part\nPlace part',
      commandTag: 'RobotCmd',
      executeTag: 'RobotExec',
      doneTag: 'RobotDone',
      in1Tag: 'PlaceClear',
      out1Tag: 'PartTaken',
    })
    const robot = { id: 'robot_1', type: 'part', packageId: 'oip.six-axis-robot', position: [0, 0, 0], rotationY: 0, name: 'Robot', params }
    store.loadScene({ version: store.getState().scene.version, parts: [robot], packages: [pkg] })
    store.select('robot_1')
    return store.getState().scene.parts.some((p) => p.id === 'robot_1') ? 'ok' : 'robot did not load'
  }, { WAYPOINTS, JOBS })
  check('robot with jobs loaded and selected', loaded === 'ok', loaded)
  if (loaded !== 'ok') throw new Error(loaded)

  // the rig gizmo builds as the meshes stream in; wait until one instance survives a few polls
  await page.waitForFunction(() => {
    const w = window.__oip
    const gz = w.view.entries.get('robot_1')?.visual.object.userData.robotGizmo
    if (!gz) return false
    if (w.__gzSeen === gz) w.__gzStable = (w.__gzStable ?? 0) + 1
    else { w.__gzSeen = gz; w.__gzStable = 0 }
    return w.__gzStable >= 3
  }, null, { timeout: 45000, polling: 400 })

  // ---- 1. the editor reads as jobs of steps
  const field = page.locator('.prog-field')
  await field.waitFor({ timeout: 10000 })
  await field.scrollIntoViewIfNeeded()
  const jobs = await page.locator('.prog-job').count()
  // jobs start folded (their steps are most of the robot's Inspector, and mounting them all stalls selection)
  check('jobs start folded, heads only', (await page.locator('.prog-step').count()) === 0 && (await page.locator('.prog-job-count').count()) === jobs)
  for (const caret of await page.locator('.prog-job-caret').all()) await caret.click()
  const firstJob = await page.locator('.prog-job').first().evaluate((el) => ({
    name: el.querySelector('.prog-job-name')?.value,
    steps: [...el.querySelectorAll('.prog-step')].map((s) =>
      [s.querySelector('.prog-op')?.selectedOptions[0]?.textContent, ...[...s.querySelectorAll('select.prog-arg')].map((a) => a.selectedOptions[0]?.textContent)].join(' ')),
  }))
  check('two job cards, named', jobs === 2 && firstJob.name === 'Pick part', `${jobs} jobs, first "${firstJob.name}"`)
  check('steps read as what they do, waypoints by name', firstJob.steps[0] === 'Move Above pick Blend' && firstJob.steps[1] === 'Move Pick Stop', JSON.stringify(firstJob.steps.slice(0, 3)))
  const tagged = await page.locator('.prog-job').nth(1).locator('.prog-step').first().locator('select.prog-arg').first().evaluate((s) => s.selectedOptions[0]?.textContent)
  check('a Wait for names the tag its input is wired to', tagged === 'Input 1 · PlaceClear', tagged)
  const waypointNames = await page.locator('[data-param="waypoints"] .array-elem-name').evaluateAll((els) => els.map((e) => e.value))
  check('waypoint rows carry their names', waypointNames.join('|') === 'Home|Above pick|Pick|Above place|Place', waypointNames.join('|'))
  await field.screenshot({ path: shot('stopped') })

  // ---- 2. clicking a Move step poses the arm there and shows the step's actions
  await page.locator('.prog-job').first().locator('.prog-step-num').nth(1).click()
  const posed = await page.evaluate(() => window.__oip.controller.captureRigPose('robot_1'))
  check('clicking "Move Pick" poses the arm at Pick', Array.isArray(posed) && posed.every((v, i) => Math.abs(v - [0, -5, 55, 0, 80, 0][i]) < 0.05), JSON.stringify(posed))
  check('the selected step shows its actions', (await page.locator('.prog-step-toolbar').count()) === 1)
  await field.screenshot({ path: shot('selected') })

  const undoDepth = () => page.evaluate(() => window.__oip.store.getState().undoStack?.length ?? window.__oip.store.history?.undo?.length ?? null)
  const before = await undoDepth()
  await page.locator('.prog-job').first().locator('.prog-step').nth(1).locator('select.prog-arg-row').selectOption({ label: 'Place' })
  const after = await page.evaluate(() => window.__oip.store.getState().scene.parts[0].params.jobs[1])
  check('picking a waypoint writes the step', after[2] === 4, JSON.stringify(after))
  await page.evaluate(() => window.__oip.store.undo())
  const undone = await page.evaluate(() => window.__oip.store.getState().scene.parts[0].params.jobs[1])
  check('...as one undo step', undone[2] === 2, `${JSON.stringify(undone)} (undo depth ${before})`)

  // ---- 3. removing a waypoint a job moves to marks the step missing, and renumbers the rest
  await page.evaluate(() => {
    const { store } = window.__oip
    store.setState?.({}) // no-op poke so the Inspector is current
  })
  const removeBtn = page.locator('[data-param="waypoints"] .array-elem').nth(2).locator('button[aria-label^="Remove element"]')
  await removeBtn.click()
  const remapped = await page.evaluate(() => {
    const p = window.__oip.store.getState().scene.parts[0].params
    return { jobs: p.jobs, names: p.waypointNames }
  })
  check('the removed waypoint\'s steps are marked missing (-1)', remapped.jobs[1][2] === -1, JSON.stringify(remapped.jobs[1]))
  check('later waypoints renumber (Above place 3 -> 2)', remapped.jobs[7][2] === 2 && remapped.names === 'Home\nAbove pick\nAbove place\nPlace', `${JSON.stringify(remapped.jobs[7])} ${JSON.stringify(remapped.names)}`)
  check('the missing step says so', (await page.locator('.prog-missing').count()) === 1)
  await field.screenshot({ path: shot('missing') })
  await page.evaluate(() => window.__oip.store.undo())

  // ---- 3b. moving a waypoint up keeps its name with it, and every step still moves to the same waypoint
  const tableBefore = await page.evaluate(() => {
    const p = window.__oip.store.getState().scene.parts[0].params
    return { waypoints: p.waypoints, names: p.waypointNames, jobs: p.jobs }
  })
  const wpRow = (i) => page.locator('[data-param="waypoints"] .array-elem').nth(i)
  check('the first waypoint cannot move up, the last cannot move down',
    (await wpRow(0).locator('button[aria-label$=" up"]').isDisabled()) && (await wpRow(4).locator('button[aria-label$=" down"]').isDisabled()))
  await wpRow(2).locator('button[aria-label$=" up"]').click()
  const moved = await page.evaluate(() => {
    const p = window.__oip.store.getState().scene.parts[0].params
    return { waypoints: p.waypoints, names: p.waypointNames, jobs: p.jobs }
  })
  check('Pick moves above Above pick, values and name together',
    moved.names === 'Home\nPick\nAbove pick\nAbove place\nPlace' && JSON.stringify(moved.waypoints[1]) === JSON.stringify(tableBefore.waypoints[2]) && JSON.stringify(moved.waypoints[2]) === JSON.stringify(tableBefore.waypoints[1]),
    JSON.stringify(moved.names))
  check('the steps follow their waypoints (Above pick 1 -> 2, Pick 2 -> 1)', moved.jobs[0][2] === 2 && moved.jobs[1][2] === 1, `${JSON.stringify(moved.jobs[0])} ${JSON.stringify(moved.jobs[1])}`)
  const stepsAfterMove = await page.locator('.prog-job').first().locator('.prog-step').evaluateAll((els) => els.slice(0, 2).map((s) => s.querySelector('select.prog-arg-row')?.selectedOptions[0]?.textContent))
  check('...so each step still reads the same waypoint', stepsAfterMove.join('|') === 'Above pick|Pick', stepsAfterMove.join('|'))
  await page.evaluate(() => window.__oip.store.undo())
  const restored = await page.evaluate(() => window.__oip.store.getState().scene.parts[0].params.waypointNames)
  check('...as one undo step', restored === tableBefore.names, JSON.stringify(restored))

  // ---- 4. running: the step being run is highlighted
  await page.evaluate((src) => {
    window.__oip.store.loadStProgram(src, { persist: false })
    window.__oip.controller.run()
  }, PROGRAM)
  await page.locator('.prog-step-active').first().waitFor({ timeout: 30000 })
  const seen = new Set()
  const t0 = Date.now()
  let running = false
  while (Date.now() - t0 < 12000 && seen.size < 3) {
    const row = await page.locator('.prog-step-active').first().getAttribute('data-row').catch(() => null)
    if (row !== null) seen.add(row)
    running ||= (await page.locator('.prog-job-running .prog-job-live').count()) > 0
    await page.waitForTimeout(100)
  }
  check('the highlight follows the job through its steps', seen.size >= 2, `rows ${[...seen].join(', ')}`)
  check('the running job says so', running)
  await field.screenshot({ path: shot('running') })
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(500)
  check('stopped, nothing is highlighted', (await page.locator('.prog-step-active').count()) === 0)

  // the Inspector at its real width, for the look
  await page.locator('.prog-field').scrollIntoViewIfNeeded()
  await page.screenshot({ path: shot('panel') })
} catch (e) {
  failures++
  console.log(`FAIL  ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
