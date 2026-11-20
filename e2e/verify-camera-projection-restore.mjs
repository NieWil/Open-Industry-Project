/* global console, process, window, localStorage, sessionStorage */
// Guard for the per-project camera projection surviving a switch to another project and back.
//
// Each project remembers its camera pose and the projection it was framed at (editor/store/storePrefs viewport
// state, keyed documentStore.sceneSlotKey(SCENE_SLOT)). Two defects on that restore path are guarded here:
//
//   - the stale-snapshot bounce: if restoreCamera runs inside onStoreChange and the same pass's
//     projection echo compares the outgoing scene's store projection, it pushes that back at the view.
//     Every switch then keeps the previous scene's projection; a scene opened from an ortho one is ortho.
//   - the auto-ortho leak: if restoring goes through setProjection, a no-op when the mode already matches,
//     switching from an axis-snap auto-ortho scene into one saved orthographic leaves the auto flag and
//     axis reference armed. The incoming scene reverts to perspective on its first frame and saves that
//     over its own orthographic view.
//
// A project holds one scene, so switching is the projects list, which reloads; sections 1-6 hold
// the same contract across that switch, and section 7 across the built-in demo (Open Demo reloads into it too).
// In-session swaps that restore inside onStoreChange happen only in rooms.
//
// And the other half: an axis-snap ortho must come back as one (orbiting off it still reverts),
// not as the explicit kind. Every "switch" case has its control that the outgoing state was really set,
// because a projection that never changed passes every one of these vacuously.
// Run: node e2e/verify-camera-projection-restore.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { createProject, openProjectNamed } from './_projectMenu.mjs'

const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      // that channel is not installed here; try the next one
    }
  }
  return null
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => {
    try {
      // once per tab: switching projects reloads the page, and a clear on every load would wipe the slots under test
      if (!sessionStorage.getItem('cpr-cleared')) {
        localStorage.clear()
        sessionStorage.setItem('cpr-cleared', '1')
      }
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      // storage blocked: the viewport slots cannot persist, and the checks below will say so
    }
  })
  try {
    await page.goto(`${url}`, { timeout: 120000 })
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 40000 })
    // the boot sync files document #1 off a promise chain: the projects list needs it
    await page.waitForFunction(() => localStorage.getItem('oip-web/document-id') !== null, null, { timeout: 30000, polling: 100 })
    await page.waitForTimeout(1500)

    const wait = (ms) => page.waitForTimeout(ms)
    const cam = () => page.evaluate(() => {
      const { view, store } = window.__oip
      const s = store.getState()
      return { project: s.projectName, doc: localStorage.getItem('oip-web/document-id'), view: view.projectionMode(), store: s.projection, auto: view.projectionAuto() }
    })
    // slots are keyed by document + the project's one scene (documentStore.sceneSlotKey(SCENE_SLOT))
    const slotOf = (doc) => page.evaluate((doc) => {
      try {
        const slots = JSON.parse(localStorage.getItem('oip-web/viewport-state') || '[]')
        return slots.find((x) => x.key === `${doc}/scene-1`) ?? null
      } catch {
        return null
      }
    }, doc)
    // Switching projects reloads, and the camera on screen is filed on the way out (controller flushCamera, pagehide):
    // a bare toggle with no camera move, switched away from at once, must survive. That is the case this gate holds -
    // a projection change is not a camera settle after a move, so it breaks if only settles write the slot.
    const recorded = (mode, auto) => page.waitForFunction(([m, a]) => {
      try {
        const doc = localStorage.getItem('oip-web/document-id')
        const slot = JSON.parse(localStorage.getItem('oip-web/viewport-state') || '[]').find((x) => x.key === `${doc}/scene-1`)
        return !!slot && slot.projection === m && (a === null || slot.auto === a)
      } catch { return false }
    }, [mode, auto], { timeout: 15000, polling: 100 })
    const setProjection = async (mode) => {
      // no camera nudge and no wait for a slot: the switch that follows must carry the bare toggle on its own
      await page.evaluate((m) => window.__oip.store.setProjection(m), mode)
      await wait(100)
    }
    const axisSnap = async () => {
      await setProjection('perspective') // an explicit ortho stays explicit under a snap (view.snapToAxis)
      await page.evaluate(() => { const { view } = window.__oip; view.snapToAxis(view.camera.position.clone().set(0, 1, 0)) })
      await wait(1500) // snap animation + the settled frame that captures the axis reference
      await recorded("orthographic", true)
    }
    let n = 0
    const newProject = async () => { const name = `P${++n}`; await createProject(page, name); await wait(900); return cam() }
    const switchTo = async (name) => { await openProjectNamed(page, name); await wait(1500); return cam() }

    // --- 1. perspective project -> a project saved orthographic -----------------------
    const b1 = await newProject()
    await setProjection('orthographic')
    await newProject()
    await setProjection('perspective')
    check('control 1: the outgoing project is perspective', (await cam()).view === 'perspective')
    const r1 = await switchTo(b1.project)
    check('a project saved orthographic comes back orthographic', r1.view === 'orthographic' && r1.store === 'orthographic', JSON.stringify(r1))

    // --- 2. orthographic project -> a project saved perspective ------------------------
    const b2 = await newProject()
    await setProjection('perspective')
    const a2 = await newProject()
    await setProjection('orthographic')
    check('control 2: the outgoing project is orthographic', (await cam()).view === 'orthographic')
    const r2 = await switchTo(b2.project)
    check('a project saved perspective comes back perspective', r2.view === 'perspective' && r2.store === 'perspective', JSON.stringify(r2))

    // --- 3. orthographic project -> a brand-new project --------------------------------
    await switchTo(a2.project)
    check('control 3: back on the orthographic project', (await cam()).view === 'orthographic')
    const r3 = await newProject()
    check('a brand-new project opens perspective, not the previous project\'s ortho', r3.view === 'perspective', JSON.stringify(r3))

    // --- 4. axis-snap auto-ortho project -> a project saved orthographic ----------------
    const b4 = await newProject()
    await setProjection('orthographic')
    await newProject()
    await axisSnap()
    const a4 = await cam()
    check('control 4: the outgoing project is in axis-snap AUTO-ortho', a4.view === 'orthographic' && a4.auto === true, JSON.stringify(a4))
    const r4 = await switchTo(b4.project)
    check('the incoming project stays orthographic (no inherited auto revert)', r4.view === 'orthographic', JSON.stringify(r4))
    check('and is the explicit kind it was saved as', r4.auto === false)
    await switchTo(a4.project)
    const b4slot = await slotOf(b4.doc)
    check('its saved slot was not overwritten with perspective', b4slot?.projection === 'orthographic', JSON.stringify(b4slot))

    // --- 5. an axis-snap ortho round-trips as one -------------------
    const r5 = await cam() // back on a4, restored from its slot
    check('the axis-snap project comes back orthographic', r5.view === 'orthographic', JSON.stringify(r5))
    check('and still AUTO', r5.auto === true)
    // orbit off the axis: an auto-ortho reverts, which is the behaviour the flag exists to keep
    await page.evaluate(() => window.__oip.view.setCameraPose({ px: 9, py: 7, pz: 9, tx: 0, ty: 0, tz: 0 }, { instant: true }))
    await wait(800)
    check('orbiting off the axis still reverts it to perspective', (await cam()).view === 'perspective')

    // --- 6. control for 5: an explicit ortho round-trips explicit, and does not revert ---
    const e6 = await newProject()
    await setProjection('orthographic')
    await newProject()
    const r6 = await switchTo(e6.project)
    check('an O-key ortho comes back orthographic and explicit', r6.view === 'orthographic' && r6.auto === false, JSON.stringify(r6))
    await page.evaluate(() => window.__oip.view.setCameraPose({ px: -9, py: 5, pz: 4, tx: 0, ty: 0, tz: 0 }, { instant: true }))
    await wait(800)
    check('and moving the camera keeps it orthographic', (await cam()).view === 'orthographic')

    // --- 7. an ortho project -> the demo -> back to the project ------------
    // The demo is a project of its own (the built-in example): Open Demo reloads into it, and leaving it is
    // opening a project from the list. It is put in perspective here so the way back has something to undo, and
    // the project must come back with its own ortho, explicit - not the demo's mode.
    check('control 7: the outgoing project is orthographic', (await cam()).view === 'orthographic')
    const project7 = await page.evaluate(() => window.__oip.store.getState().projectName)
    await clickDemo(page)
    await wait(1500)
    await page.evaluate(() => window.__oip.store.setProjection('perspective'))
    await wait(600)
    const d7 = await cam()
    check('control 7b: the demo is in perspective', d7.view === 'perspective' && d7.store === 'perspective', JSON.stringify(d7))
    await openProjectNamed(page, project7)
    await wait(1500)
    const r7 = await cam()
    check('reopening the project after the demo restores its orthographic view, explicit', r7.view === 'orthographic' && r7.store === 'orthographic' && r7.auto === false, JSON.stringify(r7))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
