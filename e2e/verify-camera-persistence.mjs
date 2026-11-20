// The viewport camera is per-project workspace state (editor/store/storePrefs viewport state), like the dock
// sizes: where you left a project is where it reopens. (A project holds one scene, so its slot is
// documentStore.sceneSlotKey(SCENE_SLOT): the document id + 'scene-1'.)
//
// The regression this guards: opening the demo and reloading it must not put the camera in two different
// places. `?scene=demo` frames the palletizing cell (DEMO_OPENING_VIEW), but the first persisting edit
// retires the demo session and the URL param, so the reload takes the ordinary autosave boot. Unless the
// camera is carried across, that boot frames world zero: the infeed tail, arm cropped at the edge.
//
// The hand-off has two endings that want opposite things, which is the second regression here
// (sections 7 + 8). Editing a demo peek forks it into a project of the user's own: the same document
// continues under a new identity, so the camera must not move. If the fork cleared demoSession in a
// setState of its own, the viewport would act on the transition one notification before the new slot
// existed, write the demo's framing over the scene it was leaving, then "restore" a slot nobody had
// framed, teleporting the editor to world zero. Switching away from a peek (the project menu's "Back to
// <project>") is the opposite: that demo is discarded, so the project coming back must be framed the way
// its owner left it, not keep the demo's camera.
//
// Run: node e2e/verify-camera-persistence.mjs [--headed]
/* global process, console, window, localStorage, document, location */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'

const { url: BASE, vite } = await startServer()
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const DEMO_OPENING_VIEW = { px: -9, py: 9, pz: 4.5, tx: 4, ty: 0.6, tz: -5 } // editor/demo/demoScenes.ts
const DEFAULT_POSE = { px: 9, py: 7, pz: 9, tx: 0, ty: 0, tz: 0 } // render/api.ts DEFAULT_CAMERA_POSE
const near = (a, b) => a && b && ['px', 'py', 'pz', 'tx', 'ty', 'tz'].every((k) => Math.abs(a[k] - b[k]) < 0.05)
const fmt = (p) => (p ? `${p.px.toFixed(1)},${p.py.toFixed(1)},${p.pz.toFixed(1)} -> ${p.tx.toFixed(1)},${p.ty.toFixed(1)},${p.tz.toFixed(1)}` : 'null')

const ready = async (page) => {
  await page.waitForFunction(() => !!window.__oip?.view && !!window.__oip?.controller, { timeout: 90_000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 120_000 }).catch(() => {})
}
const pose = (page) => page.evaluate(() => window.__oip.view.cameraPose())
/**
 * Move the camera and wait for the move to be recorded, like a real gesture that comes to rest.
 * Waits on the write itself (a positive signal) rather than on the settle delay: this fleet runs on
 * machines with no GPU, where a frame can take longer than the delay does.
 */
const moveCamera = async (page, p) => {
  await page.evaluate((target) => window.__oip.view.setCameraPose(target, { instant: true }), p)
  await page.waitForFunction(
    (target) => {
      try {
        const slots = JSON.parse(localStorage.getItem('oip-web/viewport-state') ?? '[]')
        return slots.some((s) => Math.abs(s.pose.px - target.px) < 0.05 && Math.abs(s.pose.tz - target.tz) < 0.05)
      } catch {
        return false
      }
    },
    p,
    { timeout: 15_000 },
  )
}

/** wait for an eased camera move (Reset View) to arrive, however slowly this machine paints */
const waitForPose = async (page, target) =>
  page
    .waitForFunction(
      (t) => {
        const p = window.__oip.view.cameraPose()
        return ['px', 'py', 'pz', 'tx', 'ty', 'tz'].every((k) => Math.abs(p[k] - t[k]) < 0.05)
      },
      target,
      { timeout: 15_000 },
    )
    .then(
      () => true,
      () => false,
    )

/** the viewport key the live scene is remembered under (editor/controller.viewportKey): the open document's id
 *  and the project's one scene slot (documentStore.sceneSlotKey(SCENE_SLOT)), bare only where there is no
 *  document library */
const sceneKey = (page) =>
  page.evaluate(() => {
    const doc = localStorage.getItem('oip-web/document-id')
    return doc ? `${doc}/scene-1` : 'scene-1'
  })

/** the project shelf, through the command palette (see verify-project-shelf.mjs for why the row is clicked) */
const openShelf = async (page) => {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => !!document.querySelector('.palette-input'), null, { polling: 100 })
  await page.fill('.palette-input', 'projects')
  await page.waitForFunction(
    () => [...document.querySelectorAll('.palette-item .palette-label')].some((e) => (e.textContent ?? '').startsWith('Projects')),
    null,
    { polling: 100 },
  )
  await page
    .locator('.palette-item', { has: page.locator('.palette-label', { hasText: /^Projects/ }) })
    .first()
    .click({ force: true })
  await page.waitForFunction(() => document.querySelectorAll('.projects-row').length > 0, null, { polling: 100 })
}
/** run something that reloads the app into another document, and wait for that one to be ready */
const reloadVia = async (page, action) => {
  await page.evaluate(() => ((window.__cameraMark = true), undefined))
  await action()
  await page.waitForFunction(() => window.__cameraMark === undefined && !!window.__oip?.controller, null, { timeout: 90_000, polling: 200 })
  await ready(page)
}
const savedPose = (page, key) =>
  page.evaluate((k) => {
    try {
      return (JSON.parse(localStorage.getItem('oip-web/viewport-state') ?? '[]').find((s) => s.key === k) ?? {}).pose ?? null
    } catch { return null }
  }, key)
/** the projects list's row for the project named exactly `name` ("Palletizing demo" must not match "... 2") */
const projectRow = (page, name) =>
  page.locator('.projects-name:not([data-testid="projects-example-demo"])').filter({ has: page.locator('.projects-label').getByText(name, { exact: true }) })

/** Pick Open Demo in the project menu: it reloads into the demo (the built-in example project), so this waits
 *  for that page to be ready. */
const pressDemo = async (page) => {
  await page.getByTestId('project-menu').waitFor({ state: 'visible', timeout: 15_000 })
  await clickDemo(page)
  await ready(page)
  await page.waitForTimeout(200)
}

/** A real, persisting edit through the seam every editor gesture funnels into - the demo's first
 *  non-building part, so this cannot nudge the shell and commit nothing. */
const nudgeFirstPart = (page) =>
  page.evaluate(() => {
    const st = window.__oip.store
    const scene = st.getState().scene
    const i = scene.parts.findIndex((p) => p.type !== 'building')
    const parts = scene.parts.slice()
    parts[i] = { ...parts[i], position: [parts[i].position[0] + 0.05, parts[i].position[1], parts[i].position[2]] }
    st.commit('Move part', { ...scene, parts })
  })

const browser = await chromium.launch({ headless: !HEADED })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
// the tour overlay eats clicks and is irrelevant here
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('oip-web/tutorial-done', '1')
  } catch { /* storage disabled */ }
})
const page = await ctx.newPage()

try {
  // ── 1. a fresh peek opens on the cell, and so does a reload of it ──────────────────────────────
  await page.goto(`${BASE}?scene=demo`, { timeout: 60_000 })
  await ready(page)
  const first = await pose(page)
  check('?scene=demo opens on the cell', near(first, DEMO_OPENING_VIEW), fmt(first))

  // ── 2. the regression: an edit retires the demo session; the reload must not move the camera ───
  await page.evaluate(() => {
    const st = window.__oip.store
    const scene = st.getState().scene
    const i = scene.parts.findIndex((p) => p.type !== 'building')
    const parts = scene.parts.slice()
    parts[i] = { ...parts[i], position: [parts[i].position[0] + 0.05, parts[i].position[1], parts[i].position[2]] }
    st.commit('Move part', { ...scene, parts })
  })
  await page.waitForTimeout(400)
  const demoRetired = await page.evaluate(() => !window.__oip.store.demoSession && !location.search.includes('scene=demo'))
  check('the edit retires the demo session + URL param', demoRetired)

  await page.goto(BASE, { timeout: 60_000 })
  await ready(page)
  const afterEdit = await pose(page)
  check('reloading the edited demo keeps the cell framing', near(afterEdit, DEMO_OPENING_VIEW), fmt(afterEdit))
  check('...and is NOT the world-zero default', !near(afterEdit, DEFAULT_POSE), fmt(afterEdit))

  // ── 3. a camera the user moved survives a reload ───────────────────────────────────────────────
  const custom = { px: -14, py: 5, pz: 3, tx: -2, ty: 0.5, tz: 1 }
  await moveCamera(page, custom)
  await page.goto(BASE, { timeout: 60_000 })
  await ready(page)
  const restored = await pose(page)
  check('a moved camera comes back after a reload', near(restored, custom), fmt(restored))

  // ── 4. per project, not per browser: a second project keeps its own framing ─────────────────────
  // Every project's one scene is `scene-1`, so a slot keyed by the bare scene id would open a new project
  // from the shelf at the last project's camera; the slot key names the document too.
  const docA = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
  const nameA = await page.evaluate(() => window.__oip.store.getState().projectName)
  await openShelf(page)
  await page.locator('.projects-new').click({ force: true })
  await page.fill('.projects-input', 'Project B')
  await reloadVia(page, () => page.locator('.projects-confirm').click({ force: true }))
  const docB = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
  check('a new project is a different document', !!docA && !!docB && docA !== docB, `${docA} -> ${docB}`)
  const fresh = await pose(page)
  check('a brand-new project opens at the default, not the last project\'s camera', near(fresh, DEFAULT_POSE), fmt(fresh))

  const bPose = { px: 20, py: 12, pz: -8, tx: 3, ty: 1, tz: -3 }
  await moveCamera(page, bPose)
  await openShelf(page)
  await reloadVia(page, () => projectRow(page, nameA).click({ force: true }))
  const backToA = await pose(page)
  check(`switching back to "${nameA}" restores its camera`, near(backToA, custom), fmt(backToA))

  await openShelf(page)
  await reloadVia(page, () => projectRow(page, 'Project B').click({ force: true }))
  const backToB = await pose(page)
  check('switching to Project B restores B\'s camera', near(backToB, bPose), fmt(backToB))

  // ── 5. a part-focus close-up is not the scene's camera ─────────────────────────────────────────
  // back to project A: B was minted empty, and part focus needs a part
  await openShelf(page)
  await reloadVia(page, () => projectRow(page, nameA).click({ force: true }))
  const beforeFocus = await pose(page)
  // enterPartFocus is a no-op on anything but a custom part (store.enterPartFocus), and a focus that
  // silently did nothing would make the reload check below pass while proving nothing
  const focused0 = await page.evaluate(() => {
    const part = window.__oip.store.getState().scene.parts.find((p) => p.type === 'part')
    if (!part) return null
    window.__oip.store.enterPartFocus(part.id)
    return window.__oip.store.getState().focusedPartId
  })
  check('part focus engaged (a custom part exists to focus)', !!focused0, String(focused0))
  if (focused0) {
    await page.waitForTimeout(1500) // past the settle window: a focused camera must not be recorded
    const focused = await pose(page)
    check('entering part focus reframes the viewport', !near(focused, beforeFocus), fmt(focused))
    await page.evaluate(() => window.__oip.store.exitPartFocus())
    await waitForPose(page, beforeFocus)
    await page.goto(BASE, { timeout: 60_000 })
    await ready(page)
    const afterFocus = await pose(page)
    check('a reload after part focus reopens the SCENE camera, not the close-up', near(afterFocus, beforeFocus), fmt(afterFocus))
  }

  // ── 6. the way out: Reset View forgets it and reframes ─────────────────────────────────────────
  await page.evaluate(() => window.__oip.controller.resetCamera())
  const landed = await waitForPose(page, DEFAULT_POSE) // the reset eases - this one is watched
  const reset = await pose(page)
  check('Reset View returns to the opening view', landed && near(reset, DEFAULT_POSE), fmt(reset))

  await page.goto(BASE, { timeout: 60_000 })
  await ready(page)
  const afterReset = await pose(page)
  check('...and the reset sticks across a reload', near(afterReset, DEFAULT_POSE), fmt(afterReset))

  // ── 7. a demo peek forked by an edit keeps the camera it was framed with ───────────────────────
  // The fork makes the demo a project of its own (store.stashDemoSession), so its camera moves to the new
  // document's slot and the project it was opened from keeps its own under its document. Wider than the
  // sections above: a pose is aspect-independent, so nothing above this line is affected by the resize.
  await page.setViewportSize({ width: 1400, height: 900 })
  const home = { px: -7, py: 4, pz: -11, tx: 1, ty: 0.5, tz: -2 }
  await moveCamera(page, home)
  const homeSlot = await sceneKey(page) // the slot the peek is opened from; its camera must survive it
  await pressDemo(page)
  const peek = { px: 17, py: 9, pz: 14, tx: -3, ty: 1.5, tz: 2 }
  await moveCamera(page, peek)
  const homeProject = await page.evaluate(() => window.__oip.store.getState().projectName)
  await nudgeFirstPart(page)
  await page.waitForFunction(() => !window.__oip.store.getState().demoSession, undefined, { timeout: 20_000 })
  await page.waitForTimeout(400)
  const forked = await pose(page)
  check('editing a peek forks it WITHOUT moving the camera', near(forked, peek), fmt(forked))
  check('...and does not dump you at the world-zero default', !near(forked, DEFAULT_POSE), fmt(forked))
  check('...the fork slot remembers that framing', near(await savedPose(page, await sceneKey(page)), peek), fmt(await savedPose(page, await sceneKey(page))))
  check(`...and the scene it was opened from keeps its own (${homeSlot})`, near(await savedPose(page, homeSlot), home), fmt(await savedPose(page, homeSlot)))

  // back to the project the peek was opened from - it is filed in the projects list now - and its camera with it
  await openShelf(page)
  await reloadVia(page, () => projectRow(page, homeProject).click({ force: true }))
  check(`reopening "${homeProject}" from Projects brings back its own camera`, near(await pose(page), home), fmt(await pose(page)))

  // ── 8. a peek left for another project leaves its camera behind ────────────────────────────────
  // (a second peek on top of the forked one above: were the hand-off a one-shot flag, a later peek would fall
  // through to the leave branch and reframe from scratch). Leaving the demo is opening a project from the list.
  await pressDemo(page)
  const peek2 = { px: -21, py: 15, pz: 6, tx: 4, ty: 2, tz: -5 }
  await moveCamera(page, peek2)
  await openShelf(page)
  await reloadVia(page, () => projectRow(page, homeProject).click({ force: true }))
  await page.waitForTimeout(400)
  const backHome = await pose(page)
  check('leaving a peek for the project it came from does not carry the demo camera into it', near(backHome, home), fmt(backHome))
  check('...and nothing wrote the demo framing onto that slot', near(await savedPose(page, homeSlot), home), fmt(await savedPose(page, homeSlot)))
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures === 0 ? '\nAll camera-persistence checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
