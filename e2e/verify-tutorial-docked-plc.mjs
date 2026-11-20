// Verify the tutorial's "Write the program" step with the PLC panel docked behind another tab.
//
// The PLC editor is only mounted while it's the front tab of its dock slot (DockSlot renders one
// panel), and the tour's own placement steps leave the user on the Parts tab, which shares the
// bottom dock. If a program write were broadcast to whichever ST editor happens to be listening,
// with the panel docked behind Parts it would reach zero listeners and be lost: Play would then
// attach the previous program and the interlock would never fire.
//
// This drives the real step (the tour resumed at 'write-program', panel docked behind Parts) and
// asserts: the program becomes the program of record, the panel is surfaced, and the card that
// follows spotlights that panel so the user is actually shown where the program went.
// Run: node e2e/verify-tutorial-docked-plc.mjs [--headed]
/* global process, console, window, localStorage, sessionStorage, document */
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
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
}

const ST_KEY = 'oip-web/st-program'
const STALE = 'VAR_INPUT\n  Old : BOOL;\nEND_VAR\n' // what the panel held before the step ran

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    // Seed the configuration that can lose the write, then reload into it:
    //  - the PLC panel docked in the bottom dock with Parts at the front (where the tour leaves it)
    //  - a stale ST program, so "did the write land" can't pass vacuously
    //  - the tour resumed at the 'write-program' step
    await page.evaluate(([stKey, stale]) => {
      localStorage.clear()
      localStorage.setItem('oip-web/dock-layout', JSON.stringify({
        leftTop: ['tree', 'history'], leftBottom: [], leftTop2: [], leftBottom2: [],
        rightTop: ['inspector'], rightBottom: [], rightTop2: [], rightBottom2: [],
        bottom: ['catalog', 'st'], floating: [],
        active: { leftTop: 'tree', rightTop: 'inspector', bottom: 'catalog' },
        bottomCollapsed: false,
      }))
      localStorage.setItem(stKey, stale)
      // Saved progress is scene-bound (src/editor/tutorial/session.ts): a run records the scene slot
      // it is building in, and the tour refuses to drive any other one. 'scene-1' is the single
      // default slot a cleared profile boots into, which is where the line below is seeded.
      // Note: the step is a raw index into TUTORIAL_STEPS, so inserting a step upstream shifts it.
      // The title assertion below catches the drift, so keep them together.
      // The slot also names the document (documentStore.sceneSlotKey), so the document id is pinned here: a
      // cleared profile would otherwise create a fresh one at boot that this seed could not name.
      localStorage.setItem('oip-web/document-id', 'doc-tutorial-gate')
      sessionStorage.setItem('oip-web/document-id', 'doc-tutorial-gate') // the tab's own pointer outlives the reload (libraryDb.ts)
      localStorage.setItem('oip-web/tutorial-progress', JSON.stringify({ sceneId: 'doc-tutorial-gate/scene-1', step: 10 })) // 'write-program'
    }, [ST_KEY, STALE])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    // The step's action tags whatever diffuse sensor is in the scene, so give it one (plus the
    // conveyor the tour placed before it). An untagged sensor keeps the step's gate unsatisfied,
    // so the card is still up when we click its button.
    const setup = await page.evaluate(() => {
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
          { id: 'sens1', type: 'part', packageId: 'oip.diffuse-sensor', position: [1.8, 0.7, 0.6], rotationY: 0, params: defaults(sensor) },
        ],
        packages: [roller, sensor],
      })
      return { ok: true }
    })
    check('tutorial scene seeded', setup.ok, setup.reason || '')
    if (!setup.ok) return

    // the resumed card, and the dock in the state under test
    await page.waitForFunction(() => !!document.querySelector('.tut-card .tut-btn-primary'), { timeout: 15000 })
    const before = await page.evaluate(([stKey]) => ({
      title: document.querySelector('.tut-title')?.textContent ?? '',
      frontTab: document.querySelector('.dock-slot-bottom .dock-slot-tab.active')?.textContent ?? '',
      // the PLC editor is unmounted while Parts is front: no CodeMirror surface in the dock
      mountedEditors: document.querySelectorAll('.cm-content').length,
      stored: localStorage.getItem(stKey),
    }), [ST_KEY])
    check('resumed on the "Write the program" step', before.title === 'Write the program', `title="${before.title}"`)
    check('PLC panel docked BEHIND the Parts tab', before.frontTab === 'Parts', `front="${before.frontTab}"`)
    check('…so no ST editor is mounted to hear a broadcast', before.mountedEditors === 0, `mounted=${before.mountedEditors}`)
    check('a stale program is in place before the step', before.stored === STALE)

    // the step's own button: "Set up the sensor and program"
    await page.click('.tut-card .tut-btn-primary')
    // The panel comes forward at once, but its text editor is a lazy chunk (StEditor's StCodeEditor), which a busy dev
    // server takes 8-9 s to deliver (measured). Wait for the positive signal (the program in the docked editor) rather
    // than a fixed beat; a program that never arrives still fails below, after the timeout.
    await page
      .waitForFunction(() => (document.querySelector('.dock-slot-bottom .cm-content')?.textContent ?? '').includes('BoxAtEnd'), null, { timeout: 30000, polling: 250 })
      .catch(() => {})

    const after = await page.evaluate(([stKey]) => {
      const cm = document.querySelector('.dock-slot-bottom .cm-content')
      return {
        stored: localStorage.getItem(stKey),
        frontTab: document.querySelector('.dock-slot-bottom .dock-slot-tab.active')?.textContent ?? '',
        shownText: cm ? cm.textContent ?? '' : null,
        // what the controller would attach on Play (one source: store state)
        attachSource: window.__oip.store.getState().stProgram,
        sensorTag: window.__oip.store.getState().scene.parts.find((p) => p.id === 'sens1')?.params?.tag ?? null,
      }
    }, [ST_KEY])

    const wrote = typeof after.stored === 'string' && after.stored.includes('BoxAtEnd') && after.stored.includes('Conveyor :=')
    check('the interlock program became the program of record', wrote, `stored=${JSON.stringify((after.stored ?? '').slice(0, 40))}…`)
    check('it is what Play would attach', typeof after.attachSource === 'string' && after.attachSource.includes('BoxAtEnd'))
    check('the sensor was tagged', after.sensorTag === 'BoxAtEnd', `tag=${after.sensorTag}`)
    check('the PLC panel was surfaced', after.frontTab === 'PLC', `front="${after.frontTab}"`)
    check('and it shows the program', !!after.shownText && after.shownText.includes('BoxAtEnd'), `text=${JSON.stringify((after.shownText ?? '').slice(0, 40))}…`)

    // Bringing it forward is not showing it to the user: the step above does its reveal behind a full-screen dim and
    // advances on the same click. The next card has to point at the panel, or the user never
    // learns where their program lives. The spotlight follows its target a frame late, so poll.
    const shown = await page
      .waitForFunction(() => {
        const title = document.querySelector('.tut-title')?.textContent ?? ''
        const spot = document.querySelector('.tut-spotlight')?.getBoundingClientRect()
        const dock = document.querySelector('.dock-slot-bottom')?.getBoundingClientRect()
        const card = document.querySelector('.tut-card')?.getBoundingClientRect()
        if (title !== 'Your program' || !spot || !dock || !card) return null
        // the ring is drawn 6 px outside its target
        const ringsDock = Math.abs(spot.top + 6 - dock.top) < 2 && Math.abs(spot.height - 12 - dock.height) < 2
        const onScreen = card.top >= 0 && card.bottom <= window.innerHeight
        const clearOfDock = card.bottom <= dock.top
        return ringsDock && onScreen && clearOfDock ? { title } : null
      }, null, { timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    const next = await page.evaluate(() => ({
      title: document.querySelector('.tut-title')?.textContent ?? '',
      spot: document.querySelector('.tut-spotlight')?.getBoundingClientRect().toJSON() ?? null,
      dock: document.querySelector('.dock-slot-bottom')?.getBoundingClientRect().toJSON() ?? null,
      card: document.querySelector('.tut-card')?.getBoundingClientRect().toJSON() ?? null,
    }))
    check('the next card spotlights the docked PLC panel, and sits clear of it', shown, JSON.stringify(next))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main()
