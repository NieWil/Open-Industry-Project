// Verify the physics step rate is a real scene setting in the live app, which no unit test can check:
// the sim runs in a worker built from a message, so a rate that stops at the store, or a worker that
// ignores it, passes every headless test (src/sim/simRate.test.ts builds SimWorld directly).
//
// It is set in the Inspector with nothing selected (the scene's own properties), as a whole number
// from 60 to 1000 Hz; a value outside that clamps rather than sticking (60 is a measured correctness floor;
// see docs/sim-clock.md). On a scene of the user's own holding the demo cell, at 60, 144 and 500 Hz:
//   - the worker world steps at that rate: stepStats.steps / frame.simTime == hz. simTime is
//     stepCount / hz, so a worker stepping at one rate and reporting another cannot satisfy it
//   - it holds real time. The worker loop's catch-up cap scales with the rate (src/sim/catchUp.ts); a
//     flat cap drops time on every late tick at a fast rate, and the scene runs slow without any warning
//   - cargo still moves and nothing falls through the floor
// Then: a change made during a run applies on the next run and the Inspector says so, the rate belongs to the
// project's scene (a new project starts at the default, opening the first one again brings its rate back, a
// scene file carries it) and survives a reload, and the demo preview runs at its own rate and cannot change it.
//
// Run: node e2e/verify-sim-rate.mjs [--headed]
/* global process, console, window, document, performance, localStorage */
import { startServer } from './_server.mjs'
import { createProject, openProjectNamed } from './_projectMenu.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const BASE_URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const RATES = [60, 144, 500]
const WINDOW_MS = 8000
// Sim-seconds per real second a run must hold. Not 1.0: the loop is an 8 ms setInterval, and a window
// straddles its bursts. A flat catch-up cap at a fast rate reads well under this on any loaded machine.
const MIN_REALTIME = 0.8

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// NB: waitForFunction is (fn, arg, options). Passing {timeout} as the second argument makes it the
// page-function's arg and leaves the default 30 s in force without any warning.
async function waitForApp(page, minParts = 5) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.sim && window.__oip.sceneFileText),
    undefined,
    { timeout: 60000, polling: 500 },
  )
  await page.waitForFunction((n) => window.__oip.store.getState().scene.parts.length > n, minParts, { timeout: 30000, polling: 500 })
}

const RATE_FIELD = '[data-testid="scene-properties"] .spin-input'

/** Show the scene's own properties the way a user does: select nothing, and the Inspector shows the scene. */
async function openSceneProperties(page) {
  await page.evaluate(() => window.__oip.store.clearSelection())
  const field = page.locator(RATE_FIELD)
  await field.waitFor({ state: 'visible', timeout: 8000 })
  return field
}

const simHz = (page) => page.evaluate(() => window.__oip.store.getState().simHz)

/** type a rate into the field and commit it the way a user does (Enter blurs, blur commits) */
async function typeRate(page, field, value) {
  await field.fill(String(value))
  await field.press('Enter')
  // the field re-renders from the store's committed (clamped) value
  await page
    .waitForFunction(([sel, v]) => document.querySelector(sel)?.value === String(v), [RATE_FIELD, await simHz(page)], { timeout: 5000, polling: 100 })
    .catch(() => {})
}

/** Run the loaded scene at its rate for WINDOW_MS and report what the worker actually did. */
async function measureRun(page) {
  await page.evaluate(() => {
    const sim = window.__oip.sim
    const prior = sim.onFrame
    const r = { first: null, last: null, seen: new Map(), travel: 0, minY: Infinity }
    window.__rateProbe = r
    sim.onFrame = (f) => {
      prior?.(f)
      // stepStats is set from the same worker message just before onFrame, so this pair is consistent
      const sample = { steps: sim.stepStats?.steps ?? 0, simTime: f.simTime, real: performance.now() }
      if (r.first === null) r.first = sample
      r.last = sample
      for (let i = 0; i < f.count; i++) {
        const x = f.positions[i * 3]
        const y = f.positions[i * 3 + 1]
        const z = f.positions[i * 3 + 2]
        const start = r.seen.get(f.ids[i])
        if (start === undefined) r.seen.set(f.ids[i], [x, z])
        else r.travel = Math.max(r.travel, Math.hypot(x - start[0], z - start[1]))
        if (y < r.minY) r.minY = y
      }
    }
    window.__rateProbeRestore = () => {
      sim.onFrame = prior
    }
  })
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.store.getState().running === true, undefined, { timeout: 15000, polling: 250 })
  // open the timing window only once the world is stepping, so worker start-up is not counted as lag
  await page.waitForFunction(() => (window.__rateProbe.last?.simTime ?? 0) > 1, undefined, { timeout: 60000, polling: 250 })
  await page.evaluate(() => {
    window.__rateProbe.first = window.__rateProbe.last
  })
  await page.waitForTimeout(WINDOW_MS)
  return page.evaluate(() => {
    const r = window.__rateProbe
    return {
      runHz: window.__oip.sim.runHz,
      stepsPerSimSecond: r.last.steps / r.last.simTime,
      realtime: ((r.last.simTime - r.first.simTime) * 1000) / (r.last.real - r.first.real),
      travel: r.travel,
      minY: r.minY,
      bodies: r.seen.size,
    }
  })
}

async function stopRun(page) {
  await page.evaluate(() => {
    window.__rateProbeRestore?.()
    window.__oip.controller.stop()
  })
  await page.waitForFunction(() => window.__oip.store.getState().running === false, undefined, { timeout: 15000, polling: 250 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  // the tour captures the keyboard on a fresh profile and would consume the palette chord (see verify-keymap)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      /* private-mode storage */
    }
  })
  try {
    // A scene of the user's own holding the demo cell: the demo preview cannot change its settings
    // (it is an ephemeral view), so take its file and open it as an ordinary scene in a fresh project.
    await page.goto(`${BASE_URL}?scene=demo`, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    const demoFile = await page.evaluate(() => window.__oip.sceneFileText())
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k !== 'oip-web/tutorial-done') localStorage.removeItem(k)
    })
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page, 0)
    const loadErr = await page.evaluate((text) => window.__oip.loadSceneText(text), demoFile)
    check('the demo cell opens as a scene of the user\'s own', loadErr === null, String(loadErr))
    await waitForApp(page)
    check('a scene that names no rate steps at the default', (await simHz(page)) === 60)

    let field = await openSceneProperties(page)
    await typeRate(page, field, 30)
    check('a rate below the floor clamps up to it', (await simHz(page)) === 60 && (await field.inputValue()) === '60', `${await simHz(page)} / "${await field.inputValue()}"`)
    await typeRate(page, field, 5000)
    check('a rate above the ceiling clamps down to it', (await simHz(page)) === 1000 && (await field.inputValue()) === '1000', `${await simHz(page)} / "${await field.inputValue()}"`)

    let lastRealtime = 0
    for (const hz of RATES) {
      field = await openSceneProperties(page)
      await typeRate(page, field, hz)
      check(`[${hz} Hz] the Inspector sets the scene's rate`, (await simHz(page)) === hz)
      const m = await measureRun(page)
      check(`[${hz} Hz] the worker world was started at it`, m.runHz === hz, `runHz=${m.runHz}`)
      check(`[${hz} Hz] and steps at it (steps / simTime)`, Math.abs(m.stepsPerSimSecond - hz) < 0.5, m.stepsPerSimSecond.toFixed(2))
      check(`[${hz} Hz] it holds real time`, m.realtime >= MIN_REALTIME, `${m.realtime.toFixed(2)} sim-s per real s`)
      check(`[${hz} Hz] cargo moves`, m.travel > 0.5, `${m.travel.toFixed(2)} m across ${m.bodies} bodies`)
      check(`[${hz} Hz] nothing falls through the floor`, m.minY > -0.25, `min y ${m.minY.toFixed(3)}`)
      lastRealtime = m.realtime

      if (hz === RATES[RATES.length - 1]) {
        // still running: the field stays usable, and shows that the live world keeps its rate
        field = await openSceneProperties(page)
        check('the rate can be changed during a run', !(await field.isDisabled()))
        await typeRate(page, field, 120)
        const note = page.getByText('applies on the next run')
        await note.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
        check('a change during a run is flagged as applying on the next run', (await note.count()) > 0)
        check('...and the running world keeps the rate it was built at', (await page.evaluate(() => window.__oip.sim.runHz)) === hz)
        await typeRate(page, field, hz) // put the scene back
      }
      await stopRun(page)
    }
    console.log(`note  realtime at ${RATES[RATES.length - 1]} Hz: ${lastRealtime.toFixed(2)}`)
    const last = RATES[RATES.length - 1]

    // ── it belongs to the project's scene: kept in the project document (format 4: one scene, its rate beside it) and
    // in its scene file, per project, and across a reload ──
    const saved = await page.evaluate(async () => {
      const doc = JSON.parse((await window.__oip.savedProject()) ?? '{}')
      return { project: doc.simHz, file: JSON.parse(window.__oip.sceneFileText()).simHz }
    })
    check('the project autosave carries the rate', saved.project === last, JSON.stringify(saved))
    check('a scene file carries it', saved.file === last, JSON.stringify(saved))
    // another project, then back (switching projects reloads the page into the other document)
    const firstProject = await page.evaluate(() => window.__oip.store.getState().projectName)
    await createProject(page, 'Second line')
    await waitForApp(page, -1)
    check('a new project starts at the default rate', (await simHz(page)) === 60, String(await simHz(page)))
    await openProjectNamed(page, firstProject)
    await waitForApp(page, -1)
    check(`opening "${firstProject}" again brings its rate back`, (await simHz(page)) === last, String(await simHz(page)))
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page, -1)
    check('the rate survives a reload', (await simHz(page)) === last, String(await simHz(page)))

    // ── the demo preview runs at its own rate, not the scene it was entered from, and cannot change it ──
    await page.goto(`${BASE_URL}?scene=demo`, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    check('the demo preview runs at its own rate', (await simHz(page)) === 60, String(await simHz(page)))
    field = await openSceneProperties(page)
    check('and the rate field is locked there', await field.isDisabled())
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  vite.kill()
  process.exit(1)
})
