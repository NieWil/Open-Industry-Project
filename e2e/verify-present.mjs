// Verify Present (components/PresentOverlay.tsx, docs/live-share.md "Presenting"): only the scene, for a projector or
// a display. It asserts:
//   - presenting hides the toolbar, the docks, the viewport toolbar and the orbit gizmo, and the viewport fills the window
//   - the bar to leave fades after a few seconds and comes back when the mouse moves
//   - Escape, and the bar's Exit, bring the editor back as it was
//   - a display's values list folds, moves to a corner, scrolls and filters, and an untended display puts it back
//   - Share's Preview and edit chooses the list in one's own Present: search, add, reorder, remove, undo, Done
//   - a link with `&present=1` (Share > Can view > For a display) opens straight into it, locked: no bar, no key
//     (Escape, the palette's) reaches the editor, a click on the scene or a note selects nothing, the wheel still moves
//     the camera, and the cursor hides while the mouse is still
//
// Run: node e2e/verify-present.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { url: APP_URL } = await startServer()
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), undefined, { timeout: 120000, polling: 500 })

/** what of the editor is on screen, and how much of the window the viewport takes */
const chrome = (page) =>
  page.evaluate(() => {
    const shown = (sel) => [...document.querySelectorAll(sel)].some((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
    const vp = document.querySelector('.viewport').getBoundingClientRect()
    return {
      toolbar: shown('.toolbar'),
      docks: shown('.dock-column'),
      viewportToolbar: shown('.viewport-toolbar'),
      gizmo: shown('.orbit-gizmo'),
      stats: shown('.stats-overlay'),
      fills: Math.abs(vp.width - window.innerWidth) < 2 && Math.abs(vp.height - window.innerHeight) < 2,
    }
  })

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  await page.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 20, undefined, { timeout: 60000 })
  const before = await chrome(page)
  check('the editor shows its toolbar, docks, viewport toolbar and orbit gizmo', before.toolbar && before.docks && before.viewportToolbar && before.gizmo && !before.fills, JSON.stringify(before))

  // ── Present, with the stats panel switched on: a diagnostic of the editor, not part of the scene ──
  await page.evaluate(() => window.__oip.store.setState({ showStats: true }))
  await page.waitForSelector('.stats-overlay', { timeout: 10000 }).catch(() => {})
  check('the stats panel shows in the editor when switched on', (await chrome(page)).stats)
  await page.evaluate(() => window.__oip.store.setState({ presenting: true }))
  await page.waitForTimeout(500)
  const presenting = await chrome(page)
  check('presenting hides the toolbar, docks, viewport toolbar, orbit gizmo and stats panel', !presenting.toolbar && !presenting.docks && !presenting.viewportToolbar && !presenting.gizmo && !presenting.stats, JSON.stringify(presenting))
  check('...and the viewport fills the window', presenting.fills)
  check('the bar to leave shows at first', await page.locator('.present-overlay.shown').count() === 1)
  await page.waitForTimeout(3800)
  check('...and fades when the mouse is still', await page.locator('.present-overlay.shown').count() === 0)
  await page.mouse.move(700, 400)
  await page.mouse.move(720, 410)
  await page.waitForTimeout(200)
  check('...and comes back when the mouse moves', await page.locator('.present-overlay.shown').count() === 1)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const after = await chrome(page)
  check('Escape leaves Present, and the editor is back as it was', !(await page.evaluate(() => window.__oip.store.getState().presenting)) && after.toolbar && after.docks && after.viewportToolbar && after.gizmo, JSON.stringify(after))

  await page.evaluate(() => window.__oip.store.setState({ presenting: true }))
  await page.mouse.move(700, 300)
  await page.locator('[data-testid=present-exit]').click()
  await page.waitForTimeout(300)
  check("the bar's Exit leaves Present", !(await page.evaluate(() => window.__oip.store.getState().presenting)) && (await chrome(page)).toolbar)

  // ── choosing what displays list, in one's own Present (PresentValues.tsx editing, program/displayValues.ts) ──
  await page.locator('button.share-button').click()
  await page.locator('[data-testid=share-display-edit]').click()
  await page.waitForSelector('[data-testid=present-values-add]', { timeout: 5000 }).catch(() => {})
  check("Share's Preview and edit opens one's own Present with the list open for editing", (await page.evaluate(() => window.__oip.store.getState().presenting && window.__oip.store.getState().presentEditing)) && (await page.locator('[data-testid=present-values-add]').count()) === 1)
  const offered = await page.locator('[data-testid=present-values-result]').evaluateAll((rs) => rs.slice(0, 3).map((r) => r.getAttribute('data-name')))
  check('the search offers what the project can show', offered.length === 3, JSON.stringify(offered))
  for (const n of offered.slice(0, 2)) await page.locator(`[data-testid=present-values-result][data-name="${n}"]`).click()
  const listed = () => page.evaluate(() => window.__oip.store.getState().scene.display ?? [])
  check('picking a result puts it on the displays, in order', JSON.stringify(await listed()) === JSON.stringify(offered.slice(0, 2)), JSON.stringify(await listed()))
  const notice = page.locator('.part-build-toasts')
  // the edit forked the demo, whose notice is up but waits while presenting
  check("the editor's notices wait while presenting", (await page.evaluate(() => !!window.__oip.store.getState().demoForkNotice)) && !(await notice.first().isVisible().catch(() => false)))
  check('before a run, the list says when its values show', (await page.locator('[data-testid=present-values-waiting]').count()) === 1)
  // pointer events, as a finger drags it: the second row's handle onto the first row
  const handle = await page.locator('[data-testid=present-value-handle]').nth(1).boundingBox()
  const first = await page.locator('[data-testid=present-value]').nth(0).boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  check('a row dragged by its handle moves', JSON.stringify(await listed()) === JSON.stringify([offered[1], offered[0]]), JSON.stringify(await listed()))
  await page.locator('[data-testid=present-value-remove]').first().click()
  check('a cross takes a value off', JSON.stringify(await listed()) === JSON.stringify([offered[0]]), JSON.stringify(await listed()))
  await page.evaluate(() => window.__oip.store.undo())
  check('each change is one undo step', JSON.stringify(await listed()) === JSON.stringify([offered[1], offered[0]]), JSON.stringify(await listed()))
  check('Preview and edit fills the screen, as a display does', await page.evaluate(() => document.fullscreenElement !== null))
  await page.locator('[data-testid=present-values-edit]').click()
  check('Done closes the editing, and the list shows as a display shows it', (await page.locator('[data-testid=present-values-add]').count()) === 0 && (await page.locator('[data-testid=present-value-remove]').count()) === 0)
  await page.locator('[data-testid=present-values-edit]').click()
  check('Edit opens it again', await page.evaluate(() => window.__oip.store.getState().presentEditing))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('one Escape while editing leaves Present, and ends the editing', await page.evaluate(() => !window.__oip.store.getState().presenting && !window.__oip.store.getState().presentEditing))
  check('...keeping the list as it was made', JSON.stringify(await listed()) === JSON.stringify([offered[1], offered[0]]), JSON.stringify(await listed()))
  // leaving full screen any other way (the browser's own Escape, F11) leaves too
  await page.locator('button.share-button').click()
  await page.locator('[data-testid=share-display-edit]').click()
  await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 5000 }).catch(() => {})
  await page.evaluate(() => document.exitFullscreen())
  await page.waitForTimeout(300)
  check('leaving full screen while editing leaves Present', await page.evaluate(() => !window.__oip.store.getState().presenting && !window.__oip.store.getState().presentEditing))
  await page.evaluate(() => {
    const st = window.__oip.store
    const { display: _, ...rest } = st.getState().scene
    st.commit('clear', rest)
  })

  // ── a link for a display opens straight into it ──
  // a screen bigger than the window, as a real one is: headless otherwise reports the window as the screen
  const dctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, screen: { width: 1920, height: 1080 } })
  await dctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const display = await dctx.newPage()
  await display.goto(`${APP_URL}?scene=demo&present=1`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(display)
  await display.waitForTimeout(800)
  const opened = await chrome(display)
  check('a link with &present=1 opens with only the scene', (await display.evaluate(() => window.__oip.store.getState().presenting)) && !opened.toolbar && !opened.docks && opened.fills, JSON.stringify(opened))
  await display.mouse.move(600, 300)
  await display.mouse.move(640, 320)
  await display.waitForTimeout(300)
  check('...locked: the mouse brings up no way to leave', (await display.locator('[data-testid=present-exit]').count()) === 0)
  await display.keyboard.press('Escape')
  await display.keyboard.press('Control+Shift+P')
  await display.waitForTimeout(500)
  check('...and no key reaches the editor: Escape leaves nothing, the palette does not open', (await display.evaluate(() => window.__oip.store.getState().presenting)) && (await display.locator('.palette').count()) === 0 && !(await chrome(display)).toolbar)
  await display.mouse.click(700, 450)
  const chip = display.locator('.note-chip').first()
  if (await chip.count()) await chip.click({ force: true })
  await display.waitForTimeout(400)
  check('...a click on the scene or a note selects nothing', (await display.evaluate(() => window.__oip.store.getState().selectedIds.length)) === 0)
  const cam0 = await display.evaluate(() => window.__oip.view.cameraPose())
  await display.mouse.move(700, 450)
  await display.mouse.wheel(0, -600)
  await display.waitForTimeout(800)
  const cam1 = await display.evaluate(() => window.__oip.view.cameraPose())
  check('...while the camera still moves (the wheel zooms)', Math.hypot(cam1.px - cam0.px, cam1.py - cam0.py, cam1.pz - cam0.pz) > 0.05)
  await display.waitForTimeout(3600)
  check('...and the cursor hides while the mouse is still', await display.evaluate(() => document.body.classList.contains('present-idle')))
  // Full screen: offered while the window does not fill the screen, since a link cannot ask for it without a click
  await display.mouse.move(500, 300)
  await display.waitForTimeout(300)
  check('a display not filling the screen offers Full screen', (await display.locator('[data-testid=present-fullscreen]').count()) === 1)
  await display.locator('[data-testid=present-fullscreen]').click()
  await display.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 5000 }).catch(() => {})
  await display.waitForTimeout(300)
  check('...which fills the screen, and is offered no more', (await display.evaluate(() => document.fullscreenElement !== null)) && (await display.locator('[data-testid=present-fullscreen]').count()) === 0)
  // the values list (PresentValues.tsx): whoever is at the screen can fold it, move it, scroll it and filter it, and
  // an untended display puts it back as it was
  await display.evaluate(() => {
    const st = window.__oip.store
    st.setState({ scene: { ...st.getState().scene, display: Array.from({ length: 32 }, (_, i) => `Value${i + 1}`) } })
  })
  await display.waitForSelector('[data-testid=present-values]', { timeout: 5000 })
  const panelBox = await display.evaluate(() => {
    const p = document.querySelector('[data-testid=present-values]')
    const l = p.querySelector('.present-values-list')
    return { height: p.getBoundingClientRect().height, screen: window.innerHeight, scrolls: l.scrollHeight > l.clientHeight }
  })
  check('32 values take at most half the screen, and the list scrolls', panelBox.height <= panelBox.screen * 0.52 && panelBox.scrolls, JSON.stringify(panelBox))
  const scrolled = await display.evaluate(() => {
    const l = document.querySelector('.present-values-list')
    l.scrollTop = 200
    return l.scrollTop > 0
  })
  check('...which the person at the screen can scroll', scrolled)
  await display.locator('[data-testid=present-values-filter]').fill('Value3')
  await display.waitForTimeout(300)
  const found = await display.locator('[data-testid=present-value]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name')))
  check('a long list can be filtered by name, typed on a locked display', JSON.stringify(found) === JSON.stringify(['Value3', 'Value30', 'Value31', 'Value32']), JSON.stringify(found))
  await display.locator('[data-testid=present-values-fold]').click()
  check('it folds to its header', (await display.locator('[data-testid=present-value]').count()) === 0)
  // dragged by its header, it lands in the nearest corner
  const head = await display.locator('.present-values-head').boundingBox()
  await display.mouse.move(head.x + 20, head.y + head.height / 2)
  await display.mouse.down()
  await display.mouse.move(80, 700, { steps: 8 })
  await display.mouse.up()
  await display.waitForTimeout(300)
  check('dragged, it lands in the nearest corner', (await display.locator('[data-testid=present-values]').getAttribute('data-corner')) === 'bl')
  // left alone, it comes back as it was: open, in its corner, unfiltered
  await display.waitForTimeout(32_000)
  const back = await display.evaluate(() => ({
    corner: document.querySelector('[data-testid=present-values]')?.getAttribute('data-corner'),
    rows: document.querySelectorAll('[data-testid=present-value]').length,
  }))
  check('half a minute untouched, a display puts the list back as it was', back.corner === 'tr' && back.rows === 32, JSON.stringify(back))
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack ?? err}`)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
