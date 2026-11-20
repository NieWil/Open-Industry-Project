// Verify which keys a focused control keeps and which reach the 3D editor (dialogHost.ts keyBelongsToTarget).
//   - After clicking an Inspector checkbox the browser leaves focus on it. Ctrl+Z must still undo the toggle (every
//     editor shortcut used to be dead there), while Space still belongs to the checkbox and does not start the run.
//   - A button in the ST editor's find bar: Escape closes the bar and must NOT also clear the 3D selection. With the
//     panel maximized, Escape there closes the bar, not the maximize (App.tsx's capture listener).
//   - The ladder sheet: Escape closes its Find bar and must not clear the 3D selection either, and F2 on a find-bar
//     button must not open a part rename (SceneTree.tsx).
// Run: node e2e/verify-key-ownership.mjs [--headed]
/* global process, console, window, document, localStorage */
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
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
const selected = (page) => page.evaluate(() => window.__oip.store.getState().selectedIds.join(','))
const selectBelt = (page) => page.evaluate(() => window.__oip.store.select('belt1'))
const activeIs = (page, selector) => page.evaluate((s) => !!document.activeElement?.matches(s), selector)

const LADDER_PROGRAM = `VAR
  Start, Motor : BOOL;
END_VAR
LADDER
  |Start| (Motor);
END_LADDER
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.belt-conveyor'), null, { timeout: 60000 })
    await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      store.loadScene({ version: store.getState().scene.version, parts: [{ id: 'belt1', type: 'part', packageId: pkg.id, position: [0, 0.5, 0], rotationY: 0, name: 'Belt', params }], packages: [pkg] })
      store.select('belt1')
    })
    await page.waitForTimeout(500)

    // --- an Inspector checkbox ---
    const box = page.locator('.inspector input[type="checkbox"]:not([disabled])').first()
    const hasBox = (await box.count()) > 0
    check('setup: the Inspector shows a checkbox for the belt', hasBox)
    if (hasBox) {
      const scene = () => page.evaluate(() => JSON.stringify(window.__oip.store.getState().scene.parts))
      const before = await scene()
      await box.click()
      await page.waitForTimeout(150)
      const toggled = await scene()
      check('setup: clicking the checkbox changed the part', toggled !== before)
      check('setup: focus stayed on the checkbox', await activeIs(page, 'input[type="checkbox"]'))
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(200)
      check('Ctrl+Z on a focused checkbox undoes the toggle', (await scene()) === before)
      // Space is the checkbox's own key: it toggles it and does not reach play/pause
      await box.focus()
      await page.keyboard.press(' ')
      await page.waitForTimeout(200)
      check('Space on the checkbox toggles it', (await scene()) !== before)
      check('and does not start the run', !(await page.evaluate(() => window.__oip.store.getState().running)))
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(150)
      // free fly asks the same rule: Shift+F on the checkbox a click left focused starts the flight
      await box.focus()
      const flying = () => page.evaluate(() => window.__oip.view.freelook.active)
      await page.keyboard.press('Shift+F')
      await page.waitForTimeout(150)
      check('Shift+F on a focused checkbox starts free fly', await flying())
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      check('and Escape ends it, leaving the selection alone', !(await flying()) && (await selected(page)) === 'belt1')
    }

    // control: with nothing focused, F2 opens the selected part's rename in the scene tree
    await page.evaluate(() => document.activeElement instanceof window.HTMLElement && document.activeElement.blur())
    await page.keyboard.press('F2')
    const renameOpened = await page.waitForSelector('.tree-rename', { timeout: 2000 }).then(() => true, () => false)
    check('control: F2 with nothing focused opens the part rename', renameOpened)
    if (renameOpened) await page.keyboard.press('Escape')

    // --- the ST editor's find bar ---
    await page.locator('.dock-slot-bottom .dock-slot-tab', { hasText: 'PLC' }).click()
    await page.waitForSelector('.dock-slot-bottom .cm-editor')
    await page.waitForFunction(() => !!document.activeElement?.closest('.cm-editor'), null, { timeout: 3000 })
    await page.keyboard.press('Control+f')
    await page.waitForSelector('.cm-st-search', { timeout: 3000 })
    await selectBelt(page)
    const toggle = page.locator('.cm-st-search button[aria-pressed]').first()
    await toggle.click()
    check('setup: a find-bar button has the focus', await activeIs(page, '.cm-st-search button'))
    check('setup: a part is selected', (await selected(page)) === 'belt1')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Escape on a find-bar button closes the bar', (await page.locator('.cm-st-search').count()) === 0)
    check('and leaves the 3D selection alone', (await selected(page)) === 'belt1', `selected: "${await selected(page)}"`)

    // --- the same find bar with the PLC panel maximized: the restore listener runs first, in capture ---
    await page.locator('.dock-slot-bottom .dock-slot-max-btn').click()
    await page.waitForSelector('.dock-maximized .cm-editor')
    await page.locator('.dock-maximized .cm-content').click()
    await page.keyboard.press('Control+f')
    await page.waitForSelector('.dock-maximized .cm-st-search', { timeout: 3000 })
    await page.locator('.dock-maximized .cm-st-search button[aria-pressed]').first().click()
    check('setup: maximized, a find-bar button has the focus', await activeIs(page, '.cm-st-search button'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('maximized: Escape on a find-bar button closes the bar', (await page.locator('.cm-st-search').count()) === 0)
    check('and keeps the panel maximized', (await page.locator('.dock-maximized').count()) > 0)
    // with nothing left that uses it, Escape restores the layout
    await page.evaluate(() => document.activeElement instanceof window.HTMLElement && document.activeElement.blur())
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.dock-maximized'), null, { timeout: 3000 }).catch(() => {})
    check('a later Escape restores the layout', (await page.locator('.dock-maximized').count()) === 0)

    // --- the ladder sheet ---
    await page.evaluate((program) => window.__oip.store.loadStProgram(program), LADDER_PROGRAM)
    const sheet = page.locator('.dock-slot-bottom [data-testid="ladder-view"]')
    await sheet.waitFor({ timeout: 20000 })
    await sheet.focus()
    await page.keyboard.press('Control+f')
    await page.locator('[data-testid="ladder-find"]').waitFor({ timeout: 3000 })
    // F2 on a button of the ladder find bar: the scene tree's window listener used to open a part rename and take the
    // keyboard out of the panel
    await selectBelt(page)
    await page.locator('[data-testid="ladder-find-show-replace"]').focus()
    await page.keyboard.press('F2')
    await page.waitForTimeout(150)
    check('F2 on a ladder find-bar button opens no part rename', (await page.locator('.tree-rename').count()) === 0)
    check('and the keyboard stays in the find bar', await activeIs(page, '[data-testid="ladder-find"] *'))
    await sheet.focus()
    await selectBelt(page)
    check('setup: the ladder sheet has the focus with Find open', await activeIs(page, '[data-testid="ladder-view"]'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Escape on the ladder sheet closes Find', (await page.locator('[data-testid="ladder-find"]').count()) === 0)
    check('and leaves the 3D selection alone', (await selected(page)) === 'belt1', `selected: "${await selected(page)}"`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('a second Escape on the sheet still leaves the 3D selection alone', (await selected(page)) === 'belt1')
  } finally {
    await browser.close()
    vite?.kill?.()
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.log('FAIL  threw', e)
}
console.log(failures ? `${failures} failure(s)` : 'all checks passed')
process.exit(failures ? 1 : 0)
