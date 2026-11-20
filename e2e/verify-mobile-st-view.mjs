// Verifies the PLC program is readable on a touch device, and editable only on a desktop one.
//
// The controller attaches the ST program on Play in every layout (controller.run), but the panel
// that shows it is desktop-only, so without the PLC tab a phone (for example, one opening a shared
// /app/ link) runs the logic with no way to see it. The PLC tab is the same StEditor, mounted in a
// bottom sheet with `viewOnly`.
//
// Asserts four things that can regress independently:
//   - phone: the tab exists, the sheet shows the demo's program, it is non-modal (no backdrop, the
//     canvas stays live behind it) and it fits above the tab bar
//   - read-only: typing into the sheet must not change store.stProgram, and none of the write
//     commands (the demo / Import / Export menu) are in it. Live values still arrive on Play, which
//     shows the sheet is bound to the running program rather than to a snapshot
//   - ladder: the panel opens on the language of its main POU (StEditor openingFace). The demo's
//     controller runs a ladder, so the sheet opens on rungs, and its Structured Text chip opens the
//     text. The rungs draw, and the element bar (~22 buttons that wrap to a third of the drawer) is
//     removed rather than disabled, as in the panel's own header. A one-POU ladder program opens on
//     its rungs with no Text | Ladder switch, since no POU mixes the two
//   - desktop: no mobile sheet, and the docked panel is still editable. `viewOnly` is a prop, not
//     store.readOnly (which also locks the scene), and this checks the two stay separate
// Run: node e2e/verify-mobile-st-view.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?scene=demo`
const HEADED = process.argv.includes('--headed')

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

async function openApp(browser, viewport) {
  const page = await browser.newPage({ viewport })
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage disabled */ }
  })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.controller), { timeout: 60000 })
  // the loading cover blocks taps, and the demo's parts load async. Wait for both, the second on
  // the assetsBusy signal rather than a timed wait
  await page.waitForSelector('.viewport-cover', { state: 'detached', timeout: 120000 }).catch(() => {})
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 60000 }).catch(() => {})
  return page
}

const program = (page) => page.evaluate(() => window.__oip.store.getState().stProgram)

/**
 * Click with the mouse at an element's box, not through the locator.
 *
 * The demo scene renders at about 1 fps in a headless browser (no GPU, software WebGL) at the
 * desktop viewport, and Playwright treats an element as actionable only after its box holds still
 * for a couple of animation frames. So locator.click() times out on a button that is on screen,
 * enabled and not moving. Measured here: the ⋯ menu times out at 15 s, while the mouse clicks the
 * same point in 85 ms. The phone viewport renders fast enough for locator.click().
 */
const tap = async (page, locator, offset) => {
  const b = await locator.boundingBox()
  if (!b) throw new Error('tap: the element has no box')
  await page.mouse.click(b.x + (offset?.x ?? b.width / 2), b.y + (offset?.y ?? b.height / 2))
}

// One POU on purpose: with nothing to navigate the block strip hides itself, and the sheet has no commands, so the
// header row is empty. The sheet must still open on the rungs, the program's only view.
const LADDER_PROGRAM = `VAR
  Start, Stop, Motor, Idle : BOOL;
END_VAR
LADDER
  [|Start|, |Motor|] |/Stop| (Motor);
  |/Motor| (Idle);
END_LADDER
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const errors = []
  try {
    // ---- phone tier ----
    const phone = await openApp(browser, { width: 390, height: 844 })
    phone.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
    expect(await phone.locator('.app.phone').count() === 1, 'phone tier active at 390x844')

    const tab = phone.locator('.mobile-tab', { hasText: 'PLC' })
    expect(await tab.count() === 1, 'the tab bar offers PLC')
    expect(await phone.locator('.mobile-drawer.st').count() === 0, 'the sheet is closed until tapped')

    await tab.click()
    const sheet = phone.locator('.mobile-drawer.st')
    await sheet.waitFor({ state: 'visible', timeout: 10000 })
    // the demo's controller runs Palletizer, a ladder, so the sheet opens on rungs
    const rungsFirst = await sheet.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false)
    expect(rungsFirst, 'the sheet opens on the rungs of the program the controller runs')
    // ...and the Structured Text POU opens the text, read-only sheet or not: navigating is not editing. A phone is too
    // narrow for the organizer beside the code, so it starts closed, opens over the code, and a pick closes it again
    expect(await sheet.locator('[data-testid="plc-organizer"]').count() === 0, 'the organizer starts closed on a phone')
    const stChip = sheet.locator('[data-testid="org-pou"]').filter({ has: phone.locator('.org-name', { hasText: /^PalletTruck$/ }) })
    /** Open the organizer over the code (a pick closed it the last time) and pick the truck block's row. */
    const openTruckBlock = async () => {
      if ((await sheet.locator('[data-testid="plc-organizer"]').count()) === 0) await sheet.locator('[data-testid="plc-organizer-toggle"]').click()
      await stChip.click()
    }
    await openTruckBlock()
    const code = sheet.locator('.cm-content')
    await code.waitFor({ state: 'visible', timeout: 20000 })
    expect(await sheet.locator('[data-testid="plc-organizer"]').count() === 0, 'a pick closes the organizer drawn over the code')

    const shown = await code.innerText()
    const stored = await program(phone)
    expect(stored.length > 0, 'the demo carries a program to show')
    // one declaration is enough of a probe: CodeMirror only renders the lines in view
    expect(shown.includes('FUNCTION_BLOCK PalletTruck'), 'the sheet shows the scene own program, at the POU it was sent to')

    // non-modal: the scene stays visible behind the sheet (watch the code and the machine together)
    expect(await phone.locator('.mobile-backdrop').count() === 0, 'no backdrop - the sheet is not modal')
    const canvasBox = await phone.locator('canvas').first().boundingBox()
    const box = await sheet.boundingBox()
    expect(box.y > 0 && canvasBox && canvasBox.y < box.y, 'the viewport is still visible above the sheet')
    expect(box.y + box.height <= 844 - 54 + 1, 'the sheet sits above the tab bar')
    expect(box.x >= 0 && box.x + box.width <= 390, 'the sheet fits the viewport width')

    // read-only: CodeMirror rejects input and the program does not change
    expect(await code.getAttribute('contenteditable') === 'false', 'the editor is not editable')
    await code.click({ position: { x: 40, y: 20 } })
    // insertText, not type(): a read-only .cm-content is not a text field, so keystrokes go to
    // the app's own shortcuts ("CORRUPT" contains P, which enters Pilot mode, and the rest of this
    // gate would run in a first-person walk). insertText puts the characters at the focused node
    // with no key events, which is what is being asserted.
    await phone.keyboard.insertText('CORRUPT')
    await phone.waitForTimeout(300)
    expect(await program(phone) === stored, 'typing into the sheet leaves the program untouched')

    // the demo / import / export commands sit behind the controls row's ⋯, which the sheet drops with Reload
    expect(await sheet.locator('[data-testid="st-file-menu"]').count() === 0, 'no file-command menu in the sheet')
    expect(await sheet.locator('[data-testid="st-reload"]').count() === 0, 'no Reload button in the sheet')

    // ---- the ladder view: drawn, with no edit controls ----
    // loadStProgram, not setStProgram: the second is the "typed at the keyboard" path and does not
    // broadcast, so a mounted editor would keep the demo's text (store.ts says which is which)
    const storedController = await phone.evaluate(() => window.__oip.store.getState().controller)
    // a saved zoom, set before the ladder view mounts again (LadderView reads it once, and the text is showing
    // now). The zoom readout is the one control the read-only bar keeps, because it is not an edit
    await phone.evaluate(() => { try { localStorage.setItem('oip.ladderZoom', '0.8') } catch { /* storage disabled */ } })
    await phone.evaluate((src) => window.__oip.store.loadStProgram(src), LADDER_PROGRAM)
    await sheet.locator('[data-testid="ladder-view"]').waitFor({ timeout: 20000 })
    expect(await sheet.locator('[data-testid="plc-organizer"]').count() === 0, 'the organizer stays closed until asked')
    expect(await sheet.locator('[data-testid="plc-view-ladder"], [data-testid="plc-view-text"]').count() === 0, 'and no Text | Ladder switch: the program is ONE language, and the sheet opened on it')
    expect(await sheet.locator('[data-testid="ladder-rung"]').count() === 2, 'the rungs are drawn')
    expect(await sheet.locator('[data-testid="ladder-elements"]').count() === 0, 'the element bar is dropped, not disabled')
    // the individual controls, in case the bar is ever rebuilt around a different wrapper
    for (const id of ['ladder-add-rung', 'ladder-branch', 'ladder-path', 'ladder-path-btn', 'ladder-insert-no', 'ladder-insert-coil', 'ladder-comment-btn', 'ladder-delete', 'ladder-cut', 'ladder-paste', 'ladder-tab-Contacts & coils']) {
      expect(await sheet.locator(`[data-testid="${id}"]`).count() === 0, `no "${id}" button in the sheet`)
    }
    // the zoom readout, and resetting it
    const zoomBtn = sheet.locator('[data-testid="ladder-elements-view"] [data-testid="ladder-zoom"]')
    expect(await zoomBtn.count() === 1, 'the scale readout survives, since it is not an edit')
    await zoomBtn.click()
    await sheet.locator('[data-testid="ladder-elements-view"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    expect(await sheet.locator('[data-testid="ladder-elements-view"]').count() === 0, 'back at 100%, the row goes too')
    // and the rungs accept no edit: on a desktop panel this double-click retypes the cell's operand
    const beforeLadder = await program(phone)
    await sheet.locator('[data-testid="ld-element"]').first().dblclick()
    await phone.waitForTimeout(300)
    expect(await sheet.locator('[data-testid="ladder-field"]').count() === 0, 'a rung cell cannot be retyped from the sheet')
    expect(await program(phone) === beforeLadder, 'the ladder gesture left the program untouched')
    // restore the demo's own program and task table for the live checks below; the sheet shows its rungs again
    await phone.evaluate(([src, controller]) => window.__oip.store.loadStProgram(src, { controller }), [stored, storedController])
    await phone.waitForFunction((src) => window.__oip.store.getState().stProgram === src, stored, { timeout: 15000 })
    await sheet.locator('[data-testid="ladder-rung"]').nth(10).waitFor({ timeout: 20000 })

    // the program shows live state while the sim runs, started from the phone's own Play button. Rungs first...
    await phone.locator('.run-button.play').click()
    const litRungs = await phone.waitForFunction(() => document.querySelectorAll('.mobile-drawer.st .ld-wire.on').length > 0, null, { timeout: 30000, polling: 250 }).then(() => true, () => false)
    expect(litRungs, 'the rungs light once the sim is running')
    // ...then the text's inline values, from the ST chip. Scroll the sheet to the code: CodeMirror only renders the
    // lines on screen, and the tags that carry values are at the end of the document.
    await openTruckBlock()
    await code.waitFor({ state: 'visible', timeout: 20000 })
    await phone.waitForTimeout(500)
    await sheet.locator('.cm-scroller').first().evaluate((el) => { el.scrollTop = el.scrollHeight }).catch(() => {})
    await phone.waitForTimeout(500)
    const lit = await sheet.locator('.cm-st-value').first()
      .waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
    expect(lit, 'live values appear inline once the sim is running')

    // and the tab closes it again (one tap toggles, like every other mobile panel)
    await tab.click()
    await sheet.waitFor({ state: 'detached', timeout: 5000 })
    expect(await phone.locator('.mobile-drawer.st').count() === 0, 'a second tap closes the sheet')
    await phone.close()

    // ---- desktop: the docked panel is unchanged, and the sheet must not exist ----
    const desk = await openApp(browser, { width: 1400, height: 900 })
    desk.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
    expect(await desk.locator('.mobile-tabbar').isVisible().catch(() => false) === false, 'no mobile tab bar on desktop')
    expect(await desk.locator('.mobile-drawer.st').count() === 0, 'no PLC sheet on desktop')
    const deskCode = desk.locator('.cm-content').first()
    await showPlcEditor(desk, { timeout: 20000 })
    expect(await deskCode.getAttribute('contenteditable') === 'true', 'the docked panel is still editable')
    await tap(desk, desk.locator('[data-testid="st-file-menu"]'))
    expect(await desk.getByRole('menuitem', { name: 'Import PLC Program…', exact: true }).isEnabled(), 'its write commands are still enabled')
    await tap(desk, desk.locator('.context-backdrop'), { x: 5, y: 5 })
    const before = await program(desk)
    await tap(desk, deskCode)
    await desk.keyboard.type('(* typed *)')
    await desk.waitForTimeout(300)
    expect(await program(desk) !== before, 'typing on desktop still edits the program')
    await desk.close()

    expect(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
