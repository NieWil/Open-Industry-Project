// Insert Box, through the keys and buttons a person uses: the ladder view's picker over everything a box can be
// (plc/ladder/ladderCatalog.ts), the program's own FUNCTION_BLOCKs first and then the standard library.
//
// What this gate holds that ladderCatalog.test.ts cannot: the bar's "Block…" and Ctrl+B open the picker; typing finds a
// program's own block by name and Enter puts it on the rung with its instance declared and every pin to fill, the
// first one open for typing; the drawn box shows the block's outputs (read off its declaration, not a built-in table);
// a standard function found by name lands the same way; Escape backs out without touching the program; and a block's
// pin nothing connects is drawn on its box and connected there by a double-click, Escape taking it off again.
//
// Runs in a browser: nothing here needs the desktop app.

import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const PROGRAM = `FUNCTION_BLOCK Mover
VAR_INPUT Enable : BOOL; Speed : INT; END_VAR
VAR_OUTPUT Done : BOOL; Pos : INT; END_VAR
Pos := Pos + Speed;
Done := Enable AND Pos > 3;
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  Go : BOOL := TRUE;
  Q : BOOL;
  P : INT;
  Count : INT;
END_VAR
LADDER
  |Go| (Q);
END_LADDER
END_PROGRAM
`

let failures = 0
function expect(ok, what) {
  if (ok) console.log('  ok:', what)
  else {
    failures++
    console.error('  FAIL:', what)
  }
}

const program = (page) => page.evaluate(() => window.__oip.store.getState().stProgram)

const { url, vite } = await startServer()
const browser = await chromium.launch()
let page = null
try {
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.addInitScript(() => {
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate((src) => {
    const st = window.__oip.store
    st.loadScene({ version: st.getState().scene.version, parts: [] })
    st.loadStProgram(src)
  }, PROGRAM)
  await showPlcEditor(page, { face: 'as-is' })
  // loaded with no controller table, the program runs from the default one (MainTask running Main), so the panel opens
  // on Main's rungs, not on the FUNCTION_BLOCK written above it (Mover; ladderMarks.ts openingFace)
  const opened = await page.locator('[data-testid="ladder-view"]').waitFor({ timeout: 20000 }).then(() => true, () => false)
  expect(opened, 'the panel opens on the rungs of the program the controller runs, not on the block above it')
  if (!opened) throw new Error('no ladder view to drive')

  const picker = page.locator('[data-testid="ladder-boxpick"]')
  const query = page.locator('[data-testid="ladder-boxpick-query"]')
  const field = page.locator('[data-testid="ladder-field"]')

  console.log('--- "Block…" opens the whole catalogue, the program\'s own first ---')
  expect((await page.locator('[data-testid="ladder-insert-box"]').innerText()) === 'Block…', 'the IEC sheet calls it Block…')
  await page.locator('[data-testid="ladder-rung"]').first().locator('[data-testid="ld-element"]').first().click()
  await page.locator('[data-testid="ladder-insert-box"]').click()
  await picker.waitFor({ timeout: 5000 })
  const rows = await page.locator('.ld-boxpick-row').count()
  expect(rows > 250, `every block and function is offered (${rows})`)
  const firstGroup = await page.locator('.ld-boxpick-group').first().innerText()
  expect(firstGroup === 'Function blocks in this program', `the program's own come first (${firstGroup})`)
  expect(await query.evaluate((el) => el === document.activeElement), 'the search field has the focus')

  console.log('--- typed, its own block lands declared, with every pin to fill ---')
  await page.screenshot({ path: 'e2e/out/ladder-box-picker-all.png' })
  await query.fill('mover')
  const top = await page.locator('.ld-boxpick-row.on .ld-boxpick-name').innerText()
  expect(top === 'Mover', `the best match is picked out (${top})`)
  await query.press('Enter')
  await field.waitFor({ timeout: 5000 })
  expect(!(await picker.isVisible()), 'the picker closes')
  // every pin still blank, so the rung cannot run yet; the box is drawn as what it is all the same
  const fresh = page.locator('[data-testid="ladder-rung"]').first().locator('[data-kind="box"]')
  const freshText = await fresh.innerText()
  expect(/Mover/.test(freshText) && /Done/.test(freshText), `the new box is titled Mover and shows its Done output before a pin is named (${freshText.replace(/\s+/g, ' ')})`)
  await field.fill('2')
  await field.press('Enter')
  await field.waitFor({ timeout: 5000 })
  // `P`, which Main declares: type-ahead must not complete it to Mover's own `Pos`, which Main cannot see (it did)
  await field.fill('P')
  await field.press('Enter')
  const placed = await program(page)
  expect(/Mover_1 : Mover;/.test(placed), 'Mover_1 is declared in the program')
  expect(placed.includes('|Go| Mover_1(Enable, Speed := 2, Pos => P) (Q);'), `and sits on the rung by its BOOL pins, its others named (${/\|Go\|[^;]*;/.exec(placed)?.[0]})`)
  const box = page.locator('[data-testid="ladder-rung"]').first().locator('[data-kind="box"]')
  const pins = await box.locator('[data-pin]').evaluateAll((els) => els.map((e) => e.dataset.pin))
  expect(['Enable', 'Speed', 'Pos', 'Done'].every((p) => pins.includes(p)), `the box draws its own outputs, Done included (${pins.join(' ')})`)

  console.log('--- Ctrl+B opens it from the keyboard, and a standard function lands the same way ---')
  await box.click()
  await page.locator('[data-testid="ladder-view"]').focus()
  await page.keyboard.press('Control+b')
  await picker.waitFor({ timeout: 5000 })
  await query.fill('limit')
  await query.press('Enter')
  await field.waitFor({ timeout: 5000 })
  await field.press('Escape')
  const limited = await program(page)
  expect(limited.includes('Mover_1(Enable, Speed := 2, Pos => P) LIMIT(MN := ?, IN := ?, MX := ?, OUT => ?) (Q);'), `LIMIT follows the block, its pins blank (${/\|Go\|[^;]*;/.exec(limited)?.[0]})`)

  console.log('--- Escape backs out and changes nothing ---')
  await page.locator('[data-testid="ladder-view"]').focus()
  await page.keyboard.press('Control+b')
  await picker.waitFor({ timeout: 5000 })
  await query.fill('ton')
  await query.press('Escape')
  await picker.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  expect(!(await picker.isVisible()), 'the picker is gone')
  expect((await program(page)) === limited, 'and the program is as it was')

  console.log('--- a pin nothing connects is drawn, and connected from the box ---')
  // a CTU on a rung of its own: CU on the rung, PV named, and R and CV drawn though nothing connects them
  await page.locator('[data-testid="ladder-add-rung"]').click()
  await page.locator('[data-testid="ladder-view"]').focus()
  await page.keyboard.press('Control+b')
  await picker.waitFor({ timeout: 5000 })
  await query.fill('ctu')
  await query.press('Enter')
  await field.waitFor({ timeout: 5000 })
  await field.fill('3')
  await field.press('Enter')
  const ctu = page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-kind="box"]')
  const open = await ctu.locator('[data-open="true"]').evaluateAll((els) => els.map((e) => e.dataset.pin))
  expect(open.includes('R') && open.includes('CV'), `R and CV are drawn open (${open.join(' ')})`)
  await ctu.locator('[data-pin="CV"]').dblclick()
  await field.waitFor({ timeout: 5000 })
  await field.fill('Count')
  await field.press('Enter')
  const wired = await program(page)
  expect(wired.includes('CTU_1(CU, PV := 3, CV => Count);'), `double-clicking CV and naming it writes the pin (${/CTU_1\([^;]*;/.exec(wired)?.[0]})`)
  // backing out of a pin just connected leaves the box as it was
  await ctu.locator('[data-pin="R"]').dblclick()
  await field.waitFor({ timeout: 5000 })
  await field.press('Escape')
  await page.waitForFunction((w) => window.__oip.store.getState().stProgram === w, wired, { timeout: 5000 }).catch(() => {})
  expect((await program(page)) === wired, 'Escape on R takes it off again: the program is as it was')

  await page.screenshot({ path: 'e2e/out/ladder-box-picker.png' })

  expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (e) {
  failures++
  console.error('  FAIL (harness):', e?.message ?? e)
  await page?.screenshot({ path: 'e2e/out/ladder-box-picker-fail.png' }).catch(() => {})
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures === 0 ? 'PASS verify-ladder-box-picker' : `FAIL verify-ladder-box-picker (${failures})`)
process.exit(failures === 0 ? 0 : 1)
