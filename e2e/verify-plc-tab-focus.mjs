// Verify that a left-click on the PLC panel's dock tab puts the keyboard in the code (App.tsx clickTabWith,
// store.focusStCode, StEditor's subscriber): the click that brings the panel up is the one that starts typing.
// Checks the cases where it must not: the click that rolls the bottom dock up (or folds a side column to its rail), a
// click on another tab, a right-click and the ladder view (the sheet keeps its own keys). Repeats the focus case with
// the panel in a side dock, whose tabs take a different click path than the bottom dock's.
// Run: node e2e/verify-plc-tab-focus.mjs [--headed]
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

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

// whether the keyboard is in the ST text, waiting a few frames for a panel that mounts on the click
async function codeFocused(page, want) {
  try {
    await page.waitForFunction((w) => !!document.activeElement?.closest('.cm-editor') === w, want, { timeout: 2000 })
    return want
  } catch {
    return !want
  }
}

// take the keyboard out of the code without clicking any tab
const blur = (page) => page.evaluate(() => document.activeElement instanceof window.HTMLElement && document.activeElement.blur())

// a ladder-only program: the panel shows it as rungs, with no text view to type into
const LADDER_PROGRAM = `VAR
  Start, Motor : BOOL;
END_VAR
LADDER
  |Start| (Motor);
END_LADDER
`

const tab = (page, slot, label) => page.locator(`.dock-slot-${slot} .dock-slot-tab`, { hasText: label })

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
    await page.waitForSelector('.dock-slot-bottom .dock-slot-tab')

    // control: another tab's click leaves the keyboard alone
    await tab(page, 'bottom', 'Parts').click() // front tab: rolls the dock up
    await tab(page, 'bottom', 'Parts').click() // and open again
    check('control: a Parts tab click does not focus code', !(await codeFocused(page, true)))

    // a background PLC tab: the panel mounts on this click and still takes the keyboard
    await tab(page, 'bottom', 'PLC').click()
    await page.waitForSelector('.dock-slot-bottom .cm-editor')
    check('background PLC tab click focuses the code', await codeFocused(page, true))

    // the front PLC tab rolls the dock up: nothing to type into
    await blur(page)
    await tab(page, 'bottom', 'PLC').click()
    check('the click that rolls the dock up does not focus code', !(await codeFocused(page, true)))
    // and the click that opens it again does
    await tab(page, 'bottom', 'PLC').click()
    check('the click that re-opens the dock focuses the code', await codeFocused(page, true))

    // side dock: PLC behind the Inspector on the right
    await page.evaluate(() => {
      const l = JSON.parse(localStorage.getItem('oip-web/dock-layout') || 'null')
      if (!l) throw new Error('no saved dock layout')
      l.bottom = l.bottom.filter((p) => p !== 'st')
      if (l.active.bottom === 'st') l.active.bottom = l.bottom[0] ?? null
      l.rightTop = [...l.rightTop, 'st']
      l.active.rightTop = 'inspector'
      localStorage.setItem('oip-web/dock-layout', JSON.stringify(l))
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForSelector('.dock-slot-rightTop .dock-slot-tab')
    check('side dock: Inspector tab click does not focus code', (await tab(page, 'rightTop', 'Inspector').click(), !(await codeFocused(page, true))))
    await tab(page, 'rightTop', 'PLC').click()
    await page.waitForSelector('.dock-slot-rightTop .cm-editor')
    check('side dock: PLC tab click focuses the code', await codeFocused(page, true))
    // re-clicking the front side tab folds the column to a rail (dockLayout.ts clickSideDockTab), the side twin of
    // the bottom dock's roll-up: nothing to type into. A click on the tab on the rail opens it again, and focuses.
    await blur(page)
    await tab(page, 'rightTop', 'PLC').click()
    await page.waitForSelector('.dock-slot-rightTop.collapsed')
    check('side dock: re-clicking the front PLC tab folds the column without focusing code', !(await codeFocused(page, true)))
    await tab(page, 'rightTop', 'PLC').click()
    await page.waitForSelector('.dock-slot-rightTop:not(.collapsed) .cm-editor')
    check('side dock: clicking the PLC tab on the rail reopens it and focuses the code', await codeFocused(page, true))
    // the right-click move menu activates the tab but must not take the keyboard from its menu
    await blur(page)
    await tab(page, 'rightTop', 'Inspector').click()
    await tab(page, 'rightTop', 'PLC').click({ button: 'right' })
    check('side dock: right-click activates without focusing code', !(await codeFocused(page, true)))
    await page.keyboard.press('Escape')

    // ladder view: the sheet keeps its own keys, so a tab click leaves the keyboard alone
    await page.evaluate((program) => window.__oip.store.loadStProgram(program), LADDER_PROGRAM)
    await page.locator('.dock-slot-rightTop [data-testid="ladder-view"]').waitFor({ timeout: 20000 })
    await blur(page)
    await tab(page, 'rightTop', 'Inspector').click()
    await tab(page, 'rightTop', 'PLC').click()
    await page.locator('.dock-slot-rightTop [data-testid="ladder-view"]').waitFor({ timeout: 20000 })
    check('ladder view: a PLC tab click does not focus code', !(await codeFocused(page, true)))
  } finally {
    await browser.close()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
}

try {
  await main()
} finally {
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
