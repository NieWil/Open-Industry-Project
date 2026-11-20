// Verify the tutorial's "Change the program" step on the real controller (src/editor/tutorial/steps.ts, `edit-program`).
//
// Every step before it writes the program for the user, and an edit to a running program does nothing until Reload, from
// a panel with no Run button to suggest it. So the step waits for the whole loop, and this drives it:
//   - it brings the PLC tab forward (the dock is seeded on Parts) and rings it, with the card clear of the dock so the
//     Reload button is not under it
//   - the tour's own program running does not pass it (the gate is not vacuous)
//   - an edit that is typed but not reloaded does not pass it
//   - a Reload that does not compile does not pass it (the previous program keeps running)
//   - the edit reloaded does, the sim is never stopped, and the edited program is what drives the conveyor
//
// The program and the step's index come from the app's own module (vite serves /src), so they cannot drift from what
// the gate compares against. Seeding any other text would pass the gate before the edit and test nothing.
// Run: node e2e/verify-tutorial-edit-reload.mjs [--headed]
/* global process, console, window, localStorage, sessionStorage, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const STEPS = '/src/editor/tutorial/steps.ts'

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const title = (page) => page.evaluate(() => document.querySelector('.tut-title')?.textContent ?? '')
const waitTitle = (page, want, timeout = 15000) =>
  page
    .waitForFunction((w) => document.querySelector('.tut-title')?.textContent === w, want, { timeout })
    .then(() => true)
    .catch(() => false)
const waitReload = (page, enabled) =>
  page
    .waitForFunction((want) => document.querySelector('[data-testid="st-reload"]')?.disabled === !want, enabled, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)

/** replace the whole program at the keyboard, through CodeMirror (the path a user's edit takes: onChange → setStProgram) */
async function typeProgram(page, text) {
  // focus(), not click(): while monitoring, the inline value widgets remount every poll and click() waits on a stable box
  await page.locator('.dock-slot-bottom .cm-content').first().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

/** whether a click at the Reload button's centre reaches it, rather than the tour's card or ring */
const reloadReachable = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('[data-testid="st-reload"]')
    if (!b) return false
    const r = b.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === b || b.contains(hit))
  })

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('pageerror', (e) => {
    failures++
    console.error('FAIL  page error:', e.message)
  })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 60000 })

    // Resume the tour at the step, with the PLC panel docked behind Parts: the step's own entry has to bring it forward.
    // Progress is scene-bound (tutorial/session.ts), so the document id is pinned for the slot to name.
    const at = await page.evaluate(async (stepsUrl) => {
      const { TUTORIAL_STEPS } = await import(stepsUrl)
      const step = TUTORIAL_STEPS.findIndex((s) => s.id === 'edit-program')
      localStorage.clear()
      localStorage.setItem('oip-web/dock-layout', JSON.stringify({
        leftTop: ['tree', 'history'], leftBottom: [], leftTop2: [], leftBottom2: [],
        rightTop: ['inspector'], rightBottom: [], rightTop2: [], rightBottom2: [],
        bottom: ['catalog', 'st', 'problems'], floating: [],
        active: { leftTop: 'tree', rightTop: 'inspector', bottom: 'catalog' },
        bottomCollapsed: false,
      }))
      localStorage.setItem('oip-web/document-id', 'doc-tutorial-edit')
      sessionStorage.setItem('oip-web/document-id', 'doc-tutorial-edit') // the tab's own pointer outlives the reload (libraryDb.ts)
      localStorage.setItem('oip-web/tutorial-progress', JSON.stringify({ sceneId: 'doc-tutorial-edit/scene-1', step }))
      return step
    }, STEPS)
    check('the step exists', at > 0, `index=${at}`)
    if (at <= 0) return
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 60000 })
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.diffuse-sensor'), { timeout: 60000 })

    // the line the tour built: the conveyor on `Conveyor`, the sensor on `BoxAtEnd`, and the tour's program
    const seeded = await page.evaluate(async (stepsUrl) => {
      const { INTERLOCK_PROGRAM } = await import(stepsUrl)
      const { store, getPackage } = window.__oip
      const defaults = (pkg) => {
        const params = {}
        for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
        return params
      }
      const roller = getPackage('oip.roller-conveyor')
      const sensor = getPackage('oip.diffuse-sensor')
      if (!roller || !sensor) return { ok: false, reason: 'tutorial packages not registered' }
      store.loadScene({
        version: store.getState().scene.version,
        parts: [
          { id: 'conv1', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0.5, 0], rotationY: 0, params: { ...defaults(roller), runTag: 'Conveyor' } },
          { id: 'sens1', type: 'part', packageId: 'oip.diffuse-sensor', position: [1.8, 0.7, 0.6], rotationY: 0, params: { ...defaults(sensor), tag: 'BoxAtEnd' } },
        ],
        packages: [roller, sensor],
      })
      store.loadStProgram(INTERLOCK_PROGRAM)
      return { ok: store.getState().stProgram === INTERLOCK_PROGRAM }
    }, STEPS)
    check('the tour\'s line and program seeded', seeded.ok, seeded.reason || '')
    if (!seeded.ok) return

    const { program, stopLine } = await page.evaluate(async (stepsUrl) => {
      const m = await import(stepsUrl)
      return { program: m.INTERLOCK_PROGRAM, stopLine: m.STOP_LINE }
    }, STEPS)
    const EDITED = program.replace(stopLine, stopLine.replace('FALSE', 'TRUE'))
    const TYPO = program.replace(stopLine, stopLine.replace('FALSE', 'TRU'))

    // --- the card, and the panel it sends the user to
    check('resumed on "Change the program"', await waitTitle(page, 'Change the program', 20000), `title="${await title(page)}"`)
    const code = await page.evaluate(() => [...document.querySelectorAll('.tut-card .tut-code')].map((e) => e.textContent))
    check('the card shows the line to change, as code', code.length === 1 && code[0] === stopLine, JSON.stringify(code))
    await page.locator('.dock-slot-bottom .cm-content').first().waitFor({ state: 'visible', timeout: 30000 })
    const layout = await page.evaluate(() => {
      const spot = document.querySelector('.tut-spotlight')?.getBoundingClientRect()
      const dock = document.querySelector('.dock-slot-bottom')?.getBoundingClientRect()
      const card = document.querySelector('.tut-card')?.getBoundingClientRect()
      return {
        front: document.querySelector('.dock-slot-bottom .dock-slot-tab.active')?.textContent ?? '',
        text: document.querySelector('.dock-slot-bottom .cm-content')?.textContent ?? '',
        // the ring is drawn 6 px outside its target
        rings: !!spot && !!dock && Math.abs(spot.top + 6 - dock.top) < 2 && Math.abs(spot.height - 12 - dock.height) < 2,
        clear: !!card && !!dock && card.bottom <= dock.top && card.top >= 0,
      }
    })
    check('the step brought the PLC tab forward from behind Parts', layout.front === 'PLC', `front="${layout.front}"`)
    // The seed above arrives after the step mounted the panel, usually while its lazy CodeMirror chunk is still
    // loading (cold). Without StEditor's onReady catch-up, the editor would open on the text the panel mounted with
    // (empty, so the placeholder), and its first keystroke would write that back over the program. Timing-dependent:
    // a warm chunk can load first and pass this either way.
    check('...showing the line the card names', layout.text.includes(stopLine), JSON.stringify(layout.text.slice(0, 60)))
    check('the ring is on the panel, and the card sits clear of it', layout.rings && layout.clear, JSON.stringify(layout))

    // --- the tour's own program running is not an edit
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running && window.__oip.controller.programStatus.attached, null, { timeout: 30000 }).catch(() => {})
    check('the sim runs the tour\'s program', await page.evaluate(() => window.__oip.controller.programStatus.attached))
    await page.waitForTimeout(800)
    check('...which does not pass the step', (await title(page)) === 'Change the program', `title="${await title(page)}"`)

    // --- typed, not yet reloaded
    await typeProgram(page, EDITED)
    check('the keyboard edit reached the program of record', await page.evaluate((e) => window.__oip.store.getState().stProgram === e, EDITED))
    check('Reload lights for it', await waitReload(page, true))
    await page.waitForTimeout(800)
    check('an edit waiting for Reload does not pass the step', (await title(page)) === 'Change the program', `title="${await title(page)}"`)

    // --- a Reload that does not compile
    await typeProgram(page, TYPO)
    await waitReload(page, true)
    check('Reload is reachable through the tour (not under its card or ring)', await reloadReachable(page))
    await page.locator('[data-testid="st-reload"]').click()
    await page.waitForFunction(() => window.__oip.controller.programStatus.error !== null, null, { timeout: 15000 }).catch(() => {})
    check('the typo is reported', await page.evaluate(() => window.__oip.controller.programStatus.error !== null))
    await page.waitForTimeout(800)
    check('...and does not pass the step', (await title(page)) === 'Change the program', `title="${await title(page)}"`)

    // --- the edit, reloaded
    await typeProgram(page, EDITED)
    await waitReload(page, true)
    await page.locator('[data-testid="st-reload"]').click()
    check('the edit reloaded passes the step', await waitTitle(page, 'Done'), `title="${await title(page)}"`)
    const after = await page.evaluate(() => ({
      running: window.__oip.store.getState().running,
      error: window.__oip.controller.programStatus.error,
    }))
    check('...without stopping the sim, and with the typo cleared', after.running && after.error === null, JSON.stringify(after))
    const drives = await page
      .waitForFunction(() => (window.__oip.controller.plcWatch ?? {}).Conveyor === true, null, { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    check('the edited program is what drives the conveyor (Conveyor TRUE)', drives, JSON.stringify(await page.evaluate(() => window.__oip.controller.plcWatch ?? null)))
    await page.evaluate(() => window.__oip.controller.stop())
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} FAILURE(S)\nFAIL verify-tutorial-edit-reload` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
