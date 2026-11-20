// Verify the tutorial only ever drives its own project.
//
// A half-finished run persists across reloads. If that progress were a bare step index, a resume
// would re-enter the tour at that step over whatever is on screen: start the tour, go back to
// your real line, reload, and 'tag-conveyor' runs its onEnter against your conveyor (selecting it
// before you have clicked anything), after which the next card's
// button writes the tutorial's ST program over yours. A fresh run gets a "Tutorial" project of its
// own to prevent exactly that, and an unbound resume would bypass it.
//
// Progress is bound to a slot (src/editor/tutorial/session.ts): the document id + the project's one scene
// (documentStore.sceneSlotKey(SCENE_SLOT)), and the overlay goes inert anywhere else. A project holds one
// scene (format 4), so "somewhere else" is another project, or the demo (the built-in
// example, a project of its own) opened from the tour's. This drives the real sequence and asserts all of it:
//   1. a run parked in another project does not touch the project the user is in (every project's scene
//      is `scene-1`, so the binding has to name the document), and is kept for the project it belongs to
//   2. the Tutorial command is the way back: it opens the tour's project, on the tour's own step; and with
//      the demo opened from that project the card goes inert ("Tutorial paused") and its button leaves
//      the demo for the tour, on its step
//   3. deleting the tour's project ends the run instead of stranding it, and does not retire the
//      tutorial, since someone who deleted that project may well want the tour again: the command starts
//      a fresh one
//   4. the landing page's /app/?tour=1, over work, opens a fresh run in a "Tutorial" project of its own
//      (theirs is filed untouched) and drops the param, so a reload does not make another one
// Run: node e2e/verify-tutorial-scene-binding.mjs [--headed]
/* global process, console, window, localStorage, document, location, URLSearchParams, indexedDB, sessionStorage */
import { startServer } from './_server.mjs'
import { afterReload, createProject, openProjectNamed, openProjectsList } from './_projectMenu.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

const PROGRESS_KEY = 'oip-web/tutorial-progress'
const DONE_KEY = 'oip-web/tutorial-done'
// Index into TUTORIAL_STEPS. Its onEnter (primeConveyorTagging) is what reaches into the scene, so
// it is the step worth parking on. A step inserted upstream shifts this; the title assertions
// catch that drift, so keep them together.
const TAG_CONVEYOR_STEP = 9
const TAG_CONVEYOR_TITLE = 'Tag the conveyor'

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller),
    undefined,
    { timeout: 60000, polling: 200 },
  )
}

/**
 * Wait for `pred` to hold across the page's own reloads: starting a run that needs a project of its own
 * creates one, which reloads the page (newProject.ts), so a single evaluate can fail with "execution context
 * destroyed" mid-wait. Polls, ignoring exactly that error.
 */
async function settleAcross(page, pred, arg, timeout = 60000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const ok = await page.evaluate(pred, arg).catch(() => false)
    if (ok) return true
    await page.waitForTimeout(300)
  }
  return false
}

/** every project filed in this browser's library (documentStore: IndexedDB `oip-web`, `docPayload`), with its id */
const libraryProjects = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web')
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('docPayload')) {
            db.close()
            resolve([])
            return
          }
          const all = db.transaction('docPayload').objectStore('docPayload').getAll()
          all.onsuccess = () => {
            db.close()
            // a row holds its project as text, or as an object when an earlier build wrote it
            resolve(all.result.map((r) => ({ ...r, project: r.project ?? JSON.parse(r.text) })))
          }
          all.onerror = () => {
            db.close()
            resolve([])
          }
        }
      }),
  )

/** what the app is showing, and whether anything reached into the live scene */
const probe = (page) =>
  page.evaluate((key) => {
    const s = window.__oip.store.getState()
    const conv = s.scene.parts.find((p) => p.id === 'conv1')
    return {
      title: document.querySelector('.tut-title')?.textContent ?? '(no tour)',
      project: s.projectName,
      doc: localStorage.getItem('oip-web/document-id'),
      // what primeConveyorTagging does, unprompted, to whatever conveyor it finds
      conv: !!conv,
      selected: s.selectedIds.length,
      progress: localStorage.getItem(key),
    }
  }, PROGRESS_KEY)

/** run the Help menu's tutorial command (help.tutorial) the way a user with no menu bar does: the palette */
async function runTutorialCommand(page) {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => !!document.querySelector('.palette-input'), undefined, { polling: 100, timeout: 15000 })
  await page.fill('.palette-input', 'tutorial build')
  const row = page.locator('.palette-item', { has: page.locator('.palette-label', { hasText: /^Tutorial: Build Your First Line/ }) }).first()
  await row.waitFor({ state: 'attached', timeout: 15000 })
  await row.click({ force: true })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    // Suppress the first-run offer while the board is set up. It does not mask what is under test:
    // a saved run is checked before the done flag, which is the whole point of a resume.
    // the tab's own open-project pointer is in sessionStorage (libraryDb.ts): clear it too, so the reload boots fresh
    await page.evaluate((done) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem(done, '1')
    }, DONE_KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    // the boot sync files document #1 off a promise chain; the projects list needs it there
    await page.waitForFunction(() => localStorage.getItem('oip-web/document-id') !== null, undefined, { timeout: 30000, polling: 100 })

    // The user's real line, in a project of their own ("Plant"); then an empty "Tutorial" project beside it
    // (what a fresh run makes), then back to their line: the project they would be looking at when they reload.
    const setup = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const roller = getPackage('oip.roller-conveyor')
      if (!roller) return { ok: false, reason: 'roller package not registered' }
      const params = {}
      for (const [k, spec] of Object.entries(roller.params ?? {})) {
        if (spec && 'default' in spec) params[k] = spec.default
      }
      store.loadScene({
        version: store.getState().scene.version,
        parts: [
          {
            id: 'conv1',
            type: 'part',
            packageId: 'oip.roller-conveyor',
            position: [0, 0.5, 0],
            rotationY: 0,
            params,
          },
        ],
        packages: [roller],
      })
      store.renameProject('Plant')
      return { ok: true }
    })
    check('the user line is set up', setup.ok, setup.reason)
    if (!setup.ok) return
    await page.waitForTimeout(1500) // let the autosave land before the project is left
    const docPlant = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
    await createProject(page, 'Tutorial')
    await waitForApp(page)
    const docTour = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
    check('the Tutorial project is a document of its own', !!docTour && docTour !== docPlant, `${docPlant} / ${docTour}`)
    const tourSlot = `${docTour}/scene-1`
    await openProjectNamed(page, 'Plant')
    await waitForApp(page)

    // --- 1. a run parked in the Tutorial project must not drive the project the user is in
    await page.evaluate(
      ([key, step, sceneId]) => localStorage.setItem(key, JSON.stringify({ sceneId, step })),
      [PROGRESS_KEY, TAG_CONVEYOR_STEP, tourSlot],
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForTimeout(1200) // give any onEnter that would fire its frame
    const parked = await probe(page)
    check('the user is in their own project', parked.project === 'Plant' && parked.doc === docPlant, `${parked.project} ${parked.doc}`)
    check("another project's run is not resumed here", parked.title === '(no tour)', `title="${parked.title}"`)
    check('...and the tour did not select their conveyor out from under them', parked.conv && parked.selected === 0, `conveyor=${parked.conv} selected=${parked.selected}`)
    check('...but the run is kept for the project it belongs to', JSON.parse(parked.progress ?? '{}').sceneId === tourSlot, `progress=${parked.progress}`)

    // --- 2. the Tutorial command is the way back: into the tour's own project, on the tour's own step
    await afterReload(page, () => runTutorialCommand(page))
    await page.waitForFunction(() => !!document.querySelector('.tut-title'), undefined, { timeout: 20000, polling: 200 }).catch(() => {})
    const back = await probe(page)
    check('the Tutorial command opens the tour\'s project', back.doc === docTour && back.project === 'Tutorial', `${back.project} ${back.doc}`)
    check('...and it picks up on the step it was parked at', back.title === TAG_CONVEYOR_TITLE, `title="${back.title}"`)

    // with the demo opened from the tour's project, the tour goes inert: the demo is not its project. Open Demo
    // reloads into the demo, and the card's button reloads back.
    await clickDemo(page)
    await page.waitForTimeout(800)
    const overDemo = await probe(page)
    check('over the demo the tour is paused, not driving the demo', overDemo.title === 'Tutorial paused', `title="${overDemo.title}"`)
    check('...and selects nothing in it', overDemo.selected === 0, `selected=${overDemo.selected}`)
    await afterReload(page, () => page.click('.tut-card .tut-btn-primary'))
    await page.waitForFunction(() => !!document.querySelector('.tut-title'), undefined, { timeout: 20000, polling: 200 }).catch(() => {})
    await page.waitForTimeout(800)
    const resumed = await probe(page)
    check('"Back to the tutorial" leaves the demo for the tour\'s project', resumed.doc === docTour && !(await page.evaluate(() => window.__oip.store.getState().demoSession)))
    check('...on the step it was parked at', resumed.title === TAG_CONVEYOR_TITLE, `title="${resumed.title}"`)

    // --- 3. deleting the tour's project ends the run rather than stranding it
    await openProjectNamed(page, 'Plant')
    await waitForApp(page)
    await page.evaluate((done) => localStorage.removeItem(done), DONE_KEY) // so "did it retire the tour" is readable
    await openProjectsList(page)
    const onDialog = (d) => void d.accept()
    page.on('dialog', onDialog)
    await page.locator('.projects-row', { has: page.locator('.projects-label', { hasText: /^Tutorial$/ }) }).getByRole('button', { name: 'Delete Tutorial' }).click({ force: true })
    const gone = await settleAcross(
      page,
      () => ![...document.querySelectorAll('.projects-label')].some((e) => e.textContent === 'Tutorial'),
      undefined,
      15000,
    )
    page.off('dialog', onDialog)
    check('the tour\'s project is gone', gone)
    await page.keyboard.press('Escape')
    const stillParked = await probe(page)
    check('...its run is still parked (nothing has asked for it yet)', JSON.parse(stillParked.progress ?? '{}').sceneId === tourSlot, `progress=${stillParked.progress}`)
    // asking for it now cannot open the project, so the run is dropped and a fresh one starts in a new
    // Tutorial project, since this one has work in it (beginFreshRun), which reloads into it
    await runTutorialCommand(page)
    const fresh = await settleAcross(
      page,
      (was) => !!window.__oip?.controller && window.__oip.store.getState().projectName === 'Tutorial' && localStorage.getItem('oip-web/document-id') !== was && !!document.querySelector('.tut-title'),
      docPlant,
    )
    await waitForApp(page)
    const after = await page.evaluate(
      ([progress, done]) => ({
        title: document.querySelector('.tut-title')?.textContent ?? '(no tour)',
        progress: localStorage.getItem(progress),
        done: localStorage.getItem(done),
        doc: localStorage.getItem('oip-web/document-id'),
      }),
      [PROGRESS_KEY, DONE_KEY],
    )
    check('...so the command starts a fresh run, in a new Tutorial project', fresh && after.doc !== docTour && after.doc !== docPlant, JSON.stringify(after))
    check('...the dead run is forgotten', JSON.parse(after.progress ?? '{}').sceneId !== tourSlot, `progress=${after.progress}`)
    check('...without retiring the tutorial itself', after.done === null, `done=${after.done}`)

    // --- 4. the landing page's entry, /app/?tour=1, over a project that has work in it
    // It must start a fresh run in a "Tutorial" project of its own (creating it reloads into it) and
    // then drop the param. Left in the URL, a reload mid-run goes through beginFreshRun again, finds the
    // tour's own project full of its parts, and makes yet another Tutorial instead of resuming.
    await openProjectNamed(page, 'Plant')
    await waitForApp(page)
    await page.evaluate((key) => localStorage.removeItem(key), PROGRESS_KEY)
    const docBefore = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
    const nameBefore = await page.evaluate(() => window.__oip.store.getState().projectName)
    const tutorialsBefore = (await libraryProjects(page)).filter((row) => row.project.name === 'Tutorial').length
    await page.goto(`${URL}?tour=1`, { waitUntil: 'domcontentloaded' })
    const landed = await settleAcross(
      page,
      (was) => window.__oip?.controller && window.__oip.store.getState().projectName === 'Tutorial' && localStorage.getItem('oip-web/document-id') !== was && !!document.querySelector('.tut-title'),
      docBefore,
    )
    check('?tour=1 over work lands in a "Tutorial" project with the tour running', landed)
    await waitForApp(page)
    const entry = await page.evaluate(() => {
      const s = window.__oip.store.getState()
      return {
        title: document.querySelector('.tut-title')?.textContent ?? '(no tour)',
        name: s.projectName,
        doc: localStorage.getItem('oip-web/document-id'),
        parts: s.scene.parts.filter((p) => p.type !== 'building').length,
        search: location.search,
      }
    })
    check('...a NEW project, not over the work on screen', entry.doc !== docBefore && entry.parts === 0, JSON.stringify(entry))
    check('...and the param is consumed', !new URLSearchParams(entry.search).has('tour'), `search="${entry.search}"`)
    const left = (await libraryProjects(page)).find((row) => row.id === docBefore)
    check(
      `their project ("${nameBefore}") is filed, its line still in it`,
      !!left && left.project.name === nameBefore && left.project.scene.parts.some((p) => p.id === 'conv1'),
      left ? `${left.project.name}: ${left.project.scene.parts.length} parts` : 'not filed',
    )
    // The user builds: without a part in it the tour's project reads as blank, and a fresh run would
    // reuse it rather than make another, so the check below would pass whether or not the param is dropped.
    const built = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const roller = getPackage('oip.roller-conveyor')
      const params = {}
      for (const [k, spec] of Object.entries(roller.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const scene = store.getState().scene
      store.loadScene({
        ...scene,
        parts: [...scene.parts, { id: 'tourConv', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0.5, 0], rotationY: 0, params }],
        packages: [...(scene.packages ?? []).filter((p) => p.id !== roller.id), roller],
      })
      const s = store.getState()
      return { name: s.projectName, has: s.scene.parts.some((p) => p.id === 'tourConv') }
    })
    check('the tour project has work in it now', built.has && built.name === 'Tutorial', JSON.stringify(built))
    await page.waitForTimeout(1500) // let the autosave land before reloading
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForTimeout(800)
    const reloaded = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
    check('a reload after it stays in the same Tutorial project', reloaded === entry.doc, `${entry.doc} -> ${reloaded}`)
    // Control: the URL the reload would have hit had the param stayed. It must make another project, or
    // the check above is not testing anything.
    await page.goto(`${URL}?tour=1`, { waitUntil: 'domcontentloaded' })
    const moved = await settleAcross(page, (was) => localStorage.getItem('oip-web/document-id') !== was && !!window.__oip?.controller, reloaded, 30000)
    check('control: the param left in place WOULD have made another', moved)
    const tutorials = (await libraryProjects(page)).filter((row) => row.project.name === 'Tutorial')
    check('...which is filed beside the first, not over it', tutorials.length === tutorialsBefore + 2, `${tutorialsBefore} before, ${tutorials.length} Tutorial project(s) now`)
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
