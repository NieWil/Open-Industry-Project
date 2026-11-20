// Go to definition from the PLC panel's text view (F12, and the text's right-click menu), in the browser.
//
// tags.test.ts checks what a name resolves to (scope, members, formal arguments, types). Only a browser run checks
// that the key reaches the panel, that the caret lands on the declaration, and that a name with no declaration says so
// and leaves the caret where it was.
// Run: node e2e/verify-plc-go-to-definition.mjs [--headed]
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

// every declaration's line is unique, so the caret's line says which one it landed on
const PROGRAM = `VAR_GLOBAL
  Speed : REAL;
END_VAR

FUNCTION_BLOCK Axis
VAR
  Ticks : INT;
END_VAR
Ticks := Ticks + 1;
END_FUNCTION_BLOCK

PROGRAM Line
VAR
  Drive : Axis;
  Count : INT;
END_VAR
Drive();
Count := Drive.Ticks;
Speed := 1.5;
END_PROGRAM
`

/** Put the caret just inside the `nth` (0-based) occurrence of `text`, at `into` characters from its start. */
async function caretAt(page, text, into, nth = 0) {
  const offset = await page.evaluate(([t, k]) => {
    const src = window.__oip.store.getState().stProgram
    let at = -1
    for (let i = 0; i <= k; i++) at = src.indexOf(t, at + 1)
    return at
  }, [text, nth])
  if (offset < 0) throw new Error(`no ${text} in the program`)
  await page.evaluate((at) => window.__oip.store.revealStOffset(at), offset + into)
  await page.waitForTimeout(300)
}

const caretLine = (page) => page.locator('.cm-activeLine').first().innerText().then((s) => s.trim())

async function f12(page) {
  await page.locator('.cm-content').first().focus()
  await page.keyboard.press('F12')
  await page.waitForTimeout(500)
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

    await caretAt(page, 'Count := Drive', 2)
    await f12(page)
    check('F12 on a use of a local lands on its declaration', (await caretLine(page)) === 'Count : INT;', await caretLine(page))

    await caretAt(page, 'Drive.Ticks', 'Drive.Ti'.length)
    await f12(page)
    check("F12 on a member lands on the block's variable", (await caretLine(page)) === 'Ticks : INT;', await caretLine(page))

    await caretAt(page, 'Speed := 1.5', 1)
    await f12(page)
    check('F12 on a controller tag lands in VAR_GLOBAL', (await caretLine(page)) === 'Speed : REAL;', await caretLine(page))

    await caretAt(page, 'Drive : Axis', 'Drive : A'.length)
    await f12(page)
    check('F12 on a type name lands on the FUNCTION_BLOCK', (await caretLine(page)) === 'FUNCTION_BLOCK Axis', await caretLine(page))

    // the right-click menu names what it will jump to, and jumps
    await caretAt(page, 'Drive();', 1)
    await page.locator('.cm-activeLine').first().click({ button: 'right', position: { x: 8, y: 5 } })
    const item = page.locator('[data-testid="st-go-to-definition"]')
    await item.waitFor({ state: 'visible', timeout: 5000 })
    const label = await item.innerText()
    check('the text menu offers Go to definition of the clicked name', /Go to definition of Drive/.test(label), label.split('\n')[0])
    await item.click()
    await page.waitForTimeout(500)
    check('...and choosing it jumps there', (await caretLine(page)) === 'Drive : Axis;', await caretLine(page))

    // back and forward through the jumps: Count -> its declaration, then Drive.Ticks -> the block's variable
    const press = async (chord) => {
      await page.locator('.cm-content').first().focus()
      await page.keyboard.press(chord)
      await page.waitForTimeout(300)
    }
    await caretAt(page, 'Speed := 1.5', 1)
    await f12(page)
    await caretAt(page, 'Drive.Ticks', 'Drive.Ti'.length)
    await f12(page)
    check('(two jumps made)', (await caretLine(page)) === 'Ticks : INT;', await caretLine(page))
    await press('Alt+ArrowLeft')
    check('Alt+Left returns to where the last jump left from', (await caretLine(page)) === 'Count := Drive.Ticks;', await caretLine(page))
    await press('Alt+ArrowLeft')
    check('...and again to where the one before it left from', (await caretLine(page)) === 'Speed := 1.5;', await caretLine(page))
    await press('Alt+ArrowRight')
    check('Alt+Right goes forward again', (await caretLine(page)) === 'Count := Drive.Ticks;', await caretLine(page))
    await press('Alt+ArrowRight')
    check('...as far as the place Back was first pressed', (await caretLine(page)) === 'Ticks : INT;', await caretLine(page))
    // the menu's Go back does the same; Go forward is off with nothing ahead, and off again after a new jump
    const back = page.locator('[data-testid="st-go-back"]')
    const forward = page.locator('[data-testid="st-go-forward"]')
    const openMenu = async () => {
      await page.locator('.cm-activeLine').first().click({ button: 'right', position: { x: 8, y: 5 } })
      await back.waitFor({ state: 'visible', timeout: 5000 })
    }
    await openMenu()
    check('the text menu offers Go back, and Go forward only when there is somewhere ahead', (await back.isEnabled()) && (await forward.isDisabled()))
    await back.click()
    await page.waitForTimeout(500)
    check('...and Go back steps back', (await caretLine(page)) === 'Count := Drive.Ticks;', await caretLine(page))
    await openMenu()
    check('Go forward is on after going back', await forward.isEnabled())
    await page.keyboard.press('Escape')
    await caretAt(page, 'Speed := 1.5', 1)
    await f12(page)
    await openMenu()
    check('a new jump drops what lay ahead', await forward.isDisabled())
    await page.keyboard.press('Escape')

    // a keyword has no declaration: the panel says so and the caret stays
    await caretAt(page, 'END_PROGRAM', 3)
    await f12(page)
    const report = await page.locator('[data-testid="st-file-report"], .st-file-report').first().innerText().catch(() => '')
    check('F12 on a keyword says there is no definition', /No definition here/.test(report), report.split('\n')[0] ?? '(no report)')
    check('...and leaves the caret where it was', (await caretLine(page)) === 'END_PROGRAM', await caretLine(page))

    check('no page errors', errors.length === 0, errors[0] ?? '')
  } finally {
    console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

await main()
