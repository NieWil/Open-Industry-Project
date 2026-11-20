// The ladder in a popped-out panel - another window, another document, another set of DOM classes. Also that the window
// opens on its button only, and that nothing else moves the panel: not a tab click, not a startup.
// Everything that hit-tests or listens must use the panel's own window: double-click to edit an operand, drag and drop,
// the Copy button's clipboard, the command palette's chord and a dialog opened from there.
// Run: node e2e/verify-ladder-popout.mjs [--headed]
/* global process, console, window, localStorage, navigator */
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

// one IEC ladder section and nothing around it, so the panel opens on its rungs (ladderMarks.ts openingFace)
const PROGRAM = `VAR_INPUT A, B : BOOL; END_VAR
VAR M : BOOL; END_VAR
LADDER
  |A| |B| (M);
END_LADDER
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
    await page.evaluate((src) => {
      const st = window.__oip.store
      st.loadScene({ version: st.getState().scene.version, parts: [] })
      st.loadStProgram(src)
    }, PROGRAM)
    await showPlcEditor(page, { face: 'as-is' })
    await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 30000 })
    check('the docked PLC panel offers Pop out, in its header', (await page.locator('[data-testid="plc-window"]').count()) === 1)
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('[data-testid="plc-window"]').click()])
    await popup.waitForLoadState()
    popup.on('pageerror', (e) => errors.push(`popup: ${e}`))
    await popup.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 10000 })
    check('the ladder is in the popped-out window', (await popup.locator('[data-testid="ld-element"]').count()) === 3 && (await page.locator('[data-testid="ladder-view"]').count()) === 0)
    const stored = () => page.evaluate(() => window.__oip.store.getState().stProgram)
    const rung = async () => (/\bLADDER\b([\s\S]*?)END_LADDER/.exec(await stored())?.[1] ?? '').trim()

    // ---- double-click on the variable edits the operand ----
    const contacts = popup.locator('[data-kind="contact"]')
    const tag = await contacts.nth(1).locator('.ld-tag').boundingBox()
    await popup.mouse.dblclick(tag.x + tag.width / 2, tag.y + tag.height / 2)
    const opField = popup.locator('[data-testid="ladder-field"]')
    await opField.waitFor({ state: 'visible', timeout: 30000 })
    check('double-click on the variable opens the operand field', (await opField.inputValue()) === 'B', await opField.inputValue())
    await opField.fill('M')
    await popup.keyboard.press('Enter')
    await popup.waitForTimeout(300)
    check('and the edit reaches the program', (await rung()) === '|A| |M| (M);', await rung())

    // ---- drag and drop ----
    const second = await contacts.nth(1).boundingBox()
    const first = await contacts.nth(0).boundingBox()
    await popup.mouse.move(second.x + second.width / 2, second.y + second.height / 2)
    await popup.mouse.down()
    await popup.mouse.move(first.x + 4, first.y + first.height / 2, { steps: 8 })
    await popup.waitForTimeout(150)
    check('dragging shows the drop marker in the popped-out window', (await popup.locator('[data-testid="ld-drop"]').count()) === 1)
    await popup.mouse.up()
    await popup.waitForTimeout(300)
    check('and the drop lands', (await rung()) === '|M| |A| (M);', await rung())

    // ---- window-agnostic: a browser API reached through a global means the main window, and breaks here ----
    // the async clipboard belongs to a document and refuses an unfocused one: `navigator.clipboard` is the main
    // window's, which does not have the focus while the user works in this one
    await popup.bringToFront()
    await popup.locator('[data-testid="ladder-rung-num"]').first().click()
    await popup.locator('[data-testid="ladder-more"]').click()
    await popup.locator('[data-testid="ladder-copy"]').click()
    await popup.waitForTimeout(300)
    const copied = await popup.evaluate(() => navigator.clipboard.readText()).catch((e) => `(unreadable: ${e})`)
    check('the Copy BUTTON works from the popped-out window', copied.trim() === '|M| |A| (M);', JSON.stringify(copied))

    // an app-wide chord is heard in this window too, and what it opens opens here
    await popup.locator('[data-testid="ladder-rung-num"]').first().click()
    await popup.keyboard.press('Control+Shift+P')
    await popup.locator('.palette-input').waitFor({ state: 'visible', timeout: 30000 })
    check('Ctrl+Shift+P pressed in the popped-out window opens the palette in it', (await page.locator('.palette-input').count()) === 0)
    // ---- a dialog opened from the popped-out window opens in it (dialogHost.ts), and takes its keys ----
    await popup.locator('.palette-input').fill('PLC Controllers')
    await popup.keyboard.press('Enter')
    await popup.locator('[data-testid="controller-props"]').waitFor({ state: 'visible', timeout: 30000 })
    check('and Controller Properties, run from there, opens in the popped-out window', (await page.locator('[data-testid="controller-props"]').count()) === 0)
    await popup.keyboard.press('Escape')
    await popup.waitForTimeout(200)
    check('its Escape is heard there', (await popup.locator('[data-testid="controller-props"]').count()) === 0)

    // ---- the window opens on the button and nothing else: closing it docks the panel, and no gesture reopens it ----
    // (a click on the PLC tab, or starting up with the tab in front, must not send the panel off to a window: a
    // window nobody asked for is a surprise, and a browser may refuse one - so each of those is checked here to
    // stay in the page.)
    await popup.close()
    const docked = await page.locator('[data-testid="plc-header"]').first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false)
    check('closing the window puts the panel back in its dock', docked)
    const opened = []
    context.on('page', (p) => opened.push(p))

    // the PLC tab is only a tab (it is already in front, so the click rolls the bottom dock up - the dock's own toggle)
    await page.locator('.dock-slot-tab', { hasText: 'PLC' }).first().click()
    await page.waitForTimeout(800)
    check('clicking the PLC tab opens no window', opened.length === 0, `windows: ${opened.length}`)

    // ...and starting up with it in front opens no window either
    await page.evaluate(() => window.__oip.store.revealPanel('st'))
    // the reload reads the stored layout, so wait for the front tab to be in it - a positive signal, not a timer
    await page.waitForFunction(
      () => Object.values(JSON.parse(localStorage.getItem('oip-web/dock-layout') ?? '{}').active ?? {}).includes('st'),
      null,
      { timeout: 15000, polling: 100 },
    )
    await page.reload()
    const inPage = await page.locator('[data-testid="plc-header"]').first().waitFor({ state: 'attached', timeout: 20000 }).then(() => true, () => false)
    await page.waitForTimeout(1500)
    check('opening a project with the PLC tab in front keeps the panel in the page', inPage && opened.length === 0, `windows: ${opened.length}`)

    // ---- and in the window, the same button puts the panel back ----
    const [own] = await Promise.all([context.waitForEvent('page'), page.locator('[data-testid="plc-window"]').click()])
    await own.waitForLoadState()
    await own.locator('[data-testid="plc-window"]').waitFor({ state: 'visible', timeout: 10000 })
    await own.locator('[data-testid="plc-window"]').click()
    const returned = await page.locator('[data-testid="plc-header"]').first().waitFor({ state: 'attached', timeout: 20000 }).then(() => true, () => false)
    check('the button in the window puts the panel back in the dock', returned)

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
