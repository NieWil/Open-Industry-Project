// Code folding in the PLC panel's text view, in the browser.
//
// stFolding.test.ts checks which lines fold and where each fold ends. Only a browser run checks that the gutter shows
// the markers, that "Fold all declarations" hides the VAR sections and leaves the statements, and that a jump into a
// folded block (go to definition, the same reveal Problems and faults use) opens it.
// Run: node e2e/verify-plc-folding.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const PROGRAM = `PROGRAM Line
VAR
  Count : INT;
  Limit : INT := 10;
END_VAR
VAR_TEMP
  Scratch : INT;
END_VAR
IF Count < Limit THEN
  Count := Count + 1;
END_IF;
END_PROGRAM
`

/** Is a line with exactly this text drawn? A folded line is not in the DOM at all. */
const shown = (page, text) => page.evaluate((t) => [...document.querySelectorAll('.cm-line')].some((l) => l.textContent.trim() === t), text)

async function openTextMenu(page) {
  await page.locator('.cm-line', { hasText: 'END_PROGRAM' }).first().click({ button: 'right', position: { x: 4, y: 5 } })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, ...(process.env.OIP_BROWSER_CHANNEL ? { channel: process.env.OIP_BROWSER_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store), null, { timeout: 60000 })
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), PROGRAM)
    await showPlcEditor(page)
    await page.waitForTimeout(600)

    // CodeMirror sizes the gutter with a hidden spacer marker, so only the visible ones count
    const markers = await page.evaluate(() => [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].filter((e) => e.style.visibility !== 'hidden' && e.querySelector('span[title="Fold line"]')).length)
    check('the gutter marks each foldable block (PROGRAM, two VAR sections, IF)', markers === 4, `${markers}`)
    check('everything is unfolded to begin with', (await shown(page, 'Count : INT;')) && (await page.locator('.cm-foldPlaceholder').count()) === 0)

    await openTextMenu(page)
    await page.locator('[data-testid="st-fold-declarations"]').click()
    await page.waitForTimeout(400)
    check('Fold all declarations hides the VAR sections', !(await shown(page, 'Count : INT;')) && !(await shown(page, 'Scratch : INT;')))
    check('...keeps their END_VAR lines', (await page.locator('.cm-line', { hasText: 'END_VAR' }).count()) === 2)
    check('...and leaves the statements', await shown(page, 'Count := Count + 1;'))
    check('...with one placeholder per section', (await page.locator('.cm-foldPlaceholder').count()) === 2)

    // F12 on the use of Count lands inside the folded VAR section: the fold opens to show it
    await page.evaluate(() => {
      const src = window.__oip.store.getState().stProgram
      window.__oip.store.revealStOffset(src.indexOf('Count := Count') + 2)
    })
    await page.waitForTimeout(300)
    await page.locator('.cm-content').first().focus()
    await page.keyboard.press('F12')
    await page.waitForTimeout(500)
    const active = await page.locator('.cm-activeLine').first().innerText().then((s) => s.trim())
    check('go to definition into a folded block opens it and lands on the declaration', active === 'Count : INT;' && (await shown(page, 'Count : INT;')), active)
    check('...and the other section stays folded', !(await shown(page, 'Scratch : INT;')))

    await openTextMenu(page)
    await page.locator('[data-testid="st-unfold-all"]').click()
    await page.waitForTimeout(400)
    check('Unfold all opens everything', (await shown(page, 'Scratch : INT;')) && (await page.locator('.cm-foldPlaceholder').count()) === 0)

    // folding is the view's, never the document's
    check('folding never changed the program', (await page.evaluate(() => window.__oip.store.getState().stProgram)) === PROGRAM)

    check('no page errors', errors.length === 0, errors[0] ?? '')
  } finally {
    console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

await main()
