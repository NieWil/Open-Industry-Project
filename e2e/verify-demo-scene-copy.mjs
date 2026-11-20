// Verify what happens to the built-in demo across a deploy - in the real editor, with a returning
// user's project already in localStorage.
//
// `/app/?scene=demo` is rebuilt from source on every visit (createPlcDemoScene), so it is always the
// demo of the running build. What must not happen is the reverse: the demo silently taking over the
// user's saved project. If the demo boot returns before loadStoredProject, store.project stays null and
// the peek's first persisting edit hits persistProject's assemble branch, writing the demo over
// PROJECT_KEY: their layout, its bound ST program and the project name gone, with no prompt and no undo.
//
// The demo boot adopts the saved project for ownership only (loadProject adoptOnly), and the demo is an
// ephemeral view. The demo is the built-in example project (the projects list's Examples): the in-app
// Open Demo saves theirs and reloads into the entry URL (sceneFile.openDemoScene), so pressing it creates
// nothing and is repeatable; leaving it is opening another project; and editing it is what forks it, into
// a project of its own, filed beside theirs, which is left exactly as it was (store.stashDemoSession +
// demoFork.ts). A project holds one scene. Forking on write, rather than copying on open behind an
// `isPristineDemo` check (whose "does this already look like the demo?" input is invisible to the user
// and changes on every deploy), prevents the ladder: "Palletizing demo 2, 3, 4..." piling up in the
// projects list for anyone who presses the button twice.
//
// Run: node e2e/verify-demo-scene-copy.mjs [--headed]
/* global process, console, window, localStorage, document, indexedDB */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { openProjectMenu, openProjectNamed, openProjectsList, runProjectMenu } from './_projectMenu.mjs'
import { chromium } from 'playwright'

const { url: BASE, vite } = await startServer()
const HEADED = process.argv.includes('--headed')
const log = (...a) => console.log(...a)

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const DEMO_TAB = 'Palletizing demo' // demoScenes.DEMO_SCENE_NAME
const PROGRAM = 'VAR x : BOOL; END_VAR' // their bound program; must survive the demo peek
// a returning user's autosave: one scene with its PLC program (PROJECT_VERSION 4, SCENE_VERSION 4). `group`
// parts need no package, so this round-trips through validateProject as-is.
const SAVED_PROJECT = {
  version: 4,
  name: 'Plant',
  scene: { version: 4, parts: [{ id: 'a', type: 'group', position: [1, 0.2, 0], rotationY: 0, params: {} }] },
  stProgram: PROGRAM,
}
const ids = (scene) => JSON.stringify(scene?.parts?.map((p) => p.id))

// (the store is up before App mounts, and `savedProject` is one of the hooks App adds: wait for it too)
const hookReady = () => !!(window.__oip?.store && window.__oip.store.getState().scene.parts.length > 0 && typeof window.__oip.savedProject === 'function')
const isColdStartNoise = (t) => /Failed to fetch|custom-part mesh load failed|\[vite\]/.test(t)

const documentId = (page) => page.evaluate(() => localStorage.getItem('oip-web/document-id'))
const partCount = (page) => page.evaluate(() => window.__oip.store.getState().scene.parts.length)
const inDemoView = (page) => page.evaluate(() => window.__oip.store.getState().demoSession)
const savedProject = (page) => page.evaluate(async () => JSON.parse((await window.__oip.savedProject()) ?? 'null'))
const partIds = (page) => page.evaluate(() => window.__oip.store.getState().scene.parts.map((p) => p.id))
const forkNotice = (page) => page.evaluate(() => window.__oip.store.getState().demoForkNotice)
const projectName = (page) => page.evaluate(() => window.__oip.store.getState().projectName)
/** every project filed in this browser's library (documentStore: IndexedDB `oip-web`, store `docPayload`) */
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
            resolve(all.result.map((row) => row.project ?? JSON.parse(row.text)))
          }
          all.onerror = () => {
            db.close()
            resolve([])
          }
        }
      }),
  )
/** the library's copy of the project named `name`, once its (async) filing has landed */
async function filed(page, name, count = 1) {
  for (let i = 0; i < 50; i++) {
    const found = (await libraryProjects(page)).filter((p) => p?.name === name)
    if (found.length >= count) return found
    await page.waitForTimeout(100)
  }
  return (await libraryProjects(page)).filter((p) => p?.name === name)
}
/**
 * The fork toast as the user sees it: the store field alone would pass even if nothing rendered.
 * Read it at the fork and assert afterwards - it self-dismisses in 8s (NoticeToast), and a check on this
 * fleet can cost seconds against software WebGL, so a read a few checks later races that timer.
 */
const forkToastText = (page) => page.locator('[data-testid="demo-fork-notice"]').textContent().catch(() => null)

/** A real, persisting edit through the seam every editor gesture funnels into: nudge the first part. */
const nudgeFirstPart = (page) =>
  page.evaluate(() => {
    const store = window.__oip.store
    const scene = store.getState().scene
    const [first, ...rest] = scene.parts
    const moved = { ...first, position: [first.position[0] + 0.25, first.position[1], first.position[2]] }
    store.commit('Move part', { ...scene, parts: [moved, ...rest] })
  })

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' && !isColdStartNoise(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
  // Seed the returning user's project + silence the onboarding tour (its overlay eats toolbar clicks).
  // Seed once: this runs on every navigation, so writing again would restore the pristine 2-scene project on the
  // reload below and fake the very regression this script checks for. The first boot moves the key into the library.
  await page.addInitScript((project) => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
      if (!localStorage.getItem('e2e/seeded')) {
        localStorage.setItem('oip-web/project', JSON.stringify(project))
        localStorage.setItem('e2e/seeded', '1')
      }
    } catch { /* storage disabled */ }
  }, SAVED_PROJECT)

  try {
    log('[goto]', `${BASE}?scene=demo`)
    await page.goto(`${BASE}?scene=demo`, { timeout: 60000 })
    await page.waitForFunction(hookReady, { timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})

    // ── the peek itself: the demo is live, their project is untouched on disk ──
    const demoParts = await partCount(page)
    check('?scene=demo opens the demo, not the saved project', demoParts > 50, `${demoParts} parts`)
    check('...as an ephemeral view', await inDemoView(page))
    const beforeEdit = await savedProject(page)
    check('the peek writes nothing: PROJECT_KEY still holds their project', beforeEdit?.name === 'Plant' && ids(beforeEdit?.scene) === '["a"]' && beforeEdit?.stProgram === PROGRAM)
    // ...and says nothing: there is no warning before the fork, because the fork takes nothing away
    check('looking at the demo raises no notice', (await page.locator('[data-testid="demo-fork-notice"]').count()) === 0)

    // ── the first persisting edit: the demo becomes a project of its own; theirs is filed, untouched ──
    await nudgeFirstPart(page)
    const toast = await forkToastText(page) // captured here; asserted below (see forkToastText)
    check(`the demo becomes a project named "${DEMO_TAB}"`, (await projectName(page)) === DEMO_TAB, String(await projectName(page)))
    check('...no longer an ephemeral view', !(await inDemoView(page)))
    check('?scene=demo is retired from the URL', !page.url().includes('scene=demo'), page.url())

    // the fork moved the whole document on its own and none of it is undoable, so it is stated once, after
    // the fact (store.projectForkNotice), naming the project left behind and the way back to it
    check('the fork says so, once, after the edit', !!toast && toast.includes(`${DEMO_TAB} is now a project of your own`), String(toast))
    check('...and names their project as untouched', !!toast && toast.includes('“Plant” is untouched'), String(toast))

    const after = await savedProject(page)
    check('the working copy is the new project', after?.name === DEMO_TAB, String(after?.name))
    check('...holding the demo', (after?.scene?.parts?.length ?? 0) > 50, `${after?.scene?.parts?.length} parts`)
    const [plant] = await filed(page, 'Plant')
    check('their project is filed in the library', !!plant)
    check('...its layout intact', ids(plant?.scene) === '["a"]', ids(plant?.scene))
    check('...and its bound ST program', plant?.stProgram === PROGRAM)

    // ── the reload a deploy prompts: the demo project comes back, not a fresh demo ──
    log('[reload] onto the retired URL')
    await page.reload({ timeout: 60000 })
    await page.waitForFunction(hookReady, { timeout: 60000 })
    check('the notice is transient: a reload does not bring it back', (await forkNotice(page)) === null)
    check('reload reopens the demo project they were editing', (await projectName(page)) === DEMO_TAB && !(await inDemoView(page)))

    // ── and their project opens again from the projects list, exactly as it was ──
    await runProjectMenu(page, 'file.projects')
    await page.locator('[data-projects-overlay] .projects-name', { hasText: 'Plant' }).click()
    await page.waitForFunction(() => window.__oip?.store?.getState().projectName === 'Plant' && window.__oip.store.getState().scene.parts.length > 0, undefined, { timeout: 60000 })
    check('Projects reopens their project', JSON.stringify(await partIds(page)) === JSON.stringify(['a']), JSON.stringify(await partIds(page)))
    check('...with its program', (await page.evaluate(() => window.__oip.store.getState().stProgram)) === PROGRAM)
    const plantDoc = await documentId(page)

    // ── the project menu's Open Demo: the current build's demo, opened like a project, adding nothing ──
    await page.getByTestId('project-menu').waitFor({ state: 'visible', timeout: 15000 })
    await clickDemo(page)
    check('Open Demo shows the demo without making a project', (await documentId(page)) === plantDoc && (await filed(page, DEMO_TAB)).length === 1, `${await documentId(page)}, ${(await filed(page, DEMO_TAB)).length} "${DEMO_TAB}"`)
    check('...as an ephemeral view', await inDemoView(page))
    check('...on the demo boot (the page reloaded into ?scene=demo)', page.url().includes('scene=demo'), page.url())
    check('...built from source (same size as the ?scene=demo boot)', (await partCount(page)) === demoParts, `${await partCount(page)} vs ${demoParts}`)
    const prog = await page.evaluate(() => window.__oip.store.getState().stProgram)
    check('...with the demo program bound to it', prog.includes('VAR_INPUT'), `${prog.length} chars`)

    // the project menu has to say it: this is the built-in example, not their project
    const tag = (await page.getByTestId('project-tag').textContent()) ?? ''
    const label = (await page.getByTestId('project-menu').textContent()) ?? ''
    check(`the menu names the example "${DEMO_TAB}" with an Example badge`, label.includes(DEMO_TAB) && tag === 'Example', `${label} / ${tag}`)
    check('...and not their project', !label.includes('Plant'), label)
    await openProjectMenu(page)
    check('...with no "Back to" row: leaving is opening another project', (await page.locator('[role="menu"] [data-testid="demo-back"]').count()) === 0)
    await page.keyboard.press('Escape')

    // the projects list carries it as the built-in example, open now
    await openProjectsList(page)
    const example = page.getByTestId('projects-example-demo')
    check('the projects list lists the demo under Examples', (await example.count()) === 1)
    check('...marked open now', ((await example.textContent()) ?? '').includes('open now'), (await example.textContent()) ?? '')
    await page.keyboard.press('Escape')

    // ── the ladder: press it repeatedly, mint nothing ──
    await clickDemo(page)
    await clickDemo(page)
    check('pressing Demo three times still makes no project', (await documentId(page)) === plantDoc && (await filed(page, DEMO_TAB)).length === 1, `${await documentId(page)}, ${(await filed(page, DEMO_TAB)).length} "${DEMO_TAB}"`)
    check('...and it is still the whole demo', (await partCount(page)) === demoParts, `${await partCount(page)} vs ${demoParts}`)

    // ── leaving is opening their project from the list; it is intact ──
    await openProjectNamed(page, 'Plant')
    check('opening their project leaves the demo', !(await inDemoView(page)))
    check('...onto their layout, untouched', JSON.stringify(await partIds(page)) === JSON.stringify(['a']), JSON.stringify(await partIds(page)))
    check('...still their project', (await projectName(page)) === 'Plant' && (await documentId(page)) === plantDoc)
    const afterView = await savedProject(page)
    check('...and intact on disk too', ids(afterView?.scene) === '["a"]', ids(afterView?.scene))

    // ── the fork itself, from the in-app button ── the peek above forks from a cold ?scene=demo visit; this
    // is the other door into the same state, and it has to end the same way. There is no
    // "keep a copy" control: editing is the fork, and someone who wants an untouched copy nudges a part
    // and presses undo (by then the fork has happened, and undo is scene-local so it cannot take it back).
    await clickDemo(page)
    await nudgeFirstPart(page)
    await page.waitForFunction(() => !window.__oip.store.getState().demoSession, { timeout: 20000 })
    const second = await forkNotice(page)
    // numbered past the first fork, still in the projects list: a second "Palletizing demo" would be a twin row.
    // Waited for: an edit this soon after the reload can beat the library's names, and the fork renumbers once
    // they land (demoFork.ts)
    await page.waitForFunction((n) => window.__oip.store.getState().projectName === n, `${DEMO_TAB} 2`, { timeout: 10000 }).catch(() => {})
    check('editing a button-opened demo forks it into a project of its own too, uniquely named', (await projectName(page)) === `${DEMO_TAB} 2`, String(await projectName(page)))
    check('...no longer an ephemeral view', !(await inDemoView(page)))
    check('...and it holds the whole demo', (await partCount(page)) === demoParts, `${await partCount(page)} vs ${demoParts}`)
    check('...the Example tag is gone with the view', (await page.getByTestId('project-tag').count()) === 0)
    // key 0 is correct here, not a stale notice: the reload above reset the page, and the check after it
    // proved the field came back null - this is the first notice this page instance has raised.
    check('...and this fork says so too, in its own notice', !!second && second.title.includes(DEMO_TAB) && second.message.includes('“Plant” is untouched'), JSON.stringify(second))

    // their project, filed again on the way out, is still exactly what it was after every one of those presses
    const plants = await filed(page, 'Plant')
    check('their project is filed once, not copied', plants.length === 1, `${plants.length} copies`)
    check('...its layout survived every one of those presses, nothing of the demo in it', ids(plants[0]?.scene) === '["a"]', ids(plants[0]?.scene))
    check('...and keeps its bound ST program', plants[0]?.stProgram === PROGRAM)

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))

    // ── the same thing on a 320px phone, which is where the landing page's demo link lands ──
    // The demo state changes the project menu's label rather than adding a control to the bar, precisely so
    // this toolbar does not have to find room it hasn't got: an earlier build put a "keep a copy" button
    // here and, measured, it either overhung the run controls or crushed the picker to a ~15px sliver. What
    // has to hold is that the menu's button stays legible and clear of the run controls, and that editing
    // still forks - which is the phone's only route to keeping the demo, and needs no chrome at all.
    await page.close() // one software-WebGL context at a time: two 60s boots in parallel is what times out
    const phone = await browser.newPage({ viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true })
    try {
      await phone.addInitScript(() => {
        try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage disabled */ }
      })
      await phone.goto(`${BASE}?scene=demo`, { timeout: 90000 })
      await phone.waitForFunction(hookReady, { timeout: 90000 })
      check('phone: the demo opens as a view here too', await inDemoView(phone))
      const fits = await phone.evaluate(() => {
        const sw = document.querySelector('.project-button')
        const play = document.querySelector('.toolbar-run button, .run-button, .toolbar button[title*="Play" i]')
        if (!sw || !play) return { ok: false, why: 'probe missed the toolbar' }
        const a = sw.getBoundingClientRect(); const b = play.getBoundingClientRect()
        return { ok: a.width > 40 && a.right <= b.left + 1, why: `menu ${Math.round(a.width)}px ending ${Math.round(a.right)}, run starts ${Math.round(b.left)}` }
      })
      check('...the project menu stays readable, clear of the run controls', fits.ok, fits.why)
      await nudgeFirstPart(phone)
      await phone.waitForFunction(() => !window.__oip.store.getState().demoSession, { timeout: 20000 })
      const phoneToast = await forkToastText(phone)
      check('...and editing makes it their project, named for the demo', (await projectName(phone)) === DEMO_TAB, String(await projectName(phone)))
      check('...which holds the whole demo', (await partCount(phone)) === demoParts, `${await partCount(phone)} vs ${demoParts}`)
      // a first-ever visitor has no other project, so the returning user's wording would be a lie here
      check('...and says so in the first-visit wording', !!phoneToast && phoneToast.includes('made it yours'), String(phoneToast))
    } finally {
      await phone.close()
    }
  } finally {
    await browser.close()
  }
}

try {
  await main()
} catch (e) {
  console.error('FAIL  script threw:', e)
  failures++
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
