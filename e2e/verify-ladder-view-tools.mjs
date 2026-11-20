// The ladder view's tools, through the rung core: Find and Replace
// (Ctrl+F / Ctrl+H, or the toolbar's Find: plc/ladder/ladderFind.ts, reading IEC's leaf through IEC_LEAVES) and Cross
// Reference (Ctrl+E, or the toolbar's Cross Ref: plc/crossRef.ts, through IEC_REFS); and, while the program runs,
// Toggle Bit (Ctrl+T, or the toolbar) and a value typed into the running program under a block's pin. And type-ahead
// in a field (plc/ladder/ladderComplete.ts): the proposed ending selected after the caret, BOOLs first for a contact.
//
// ladderFind.test.ts proves the search and the replace on rungs. What only a browser can prove: that the keys open the
// bar and do not reach the browser's own Find, that a match is selected and lit where it stands, that the stored
// program is what changed, that one Ctrl+Z takes a Replace All back, and that a function's name is found but never
// replaced.
// Run: node e2e/verify-ladder-view-tools.mjs
/* global process, console, window, document, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const PROGRAM = `VAR
  Go, Belt1, Belt10, Belt1_Run : BOOL;
  T1 : TON;
  N : INT := 3;
END_VAR
LADDER
  (* start Belt1 when asked *)
  |Go| [|Belt1|, |Belt10|] (Belt1_Run);
  |Belt1| T1(IN, PT := T#2s) (Belt10);
  EQ(IN1 := N, IN2 := 3, OUT) (Belt1);
END_LADDER
`

// Cross Reference's program: Belt1 read by two contacts and energized by two coils (a double coil)
const XREF_PROGRAM = `VAR
  Go, Belt1, Late : BOOL;
END_VAR
LADDER
  |Go| (Belt1);
  |Belt1| (Late);
  |Late| (Go);
  [|Belt1|, |Go|] (Belt1);
END_LADDER
`

// Type-ahead's program: Bench sorts before Belt1 but is an INT, so a contact is offered Belt1 first
const TYPEAHEAD_PROGRAM = `VAR
  Bench : INT;
  Belt1, Go : BOOL;
  T1 : TON;
END_VAR
LADDER
  |Go| (Belt1);
END_LADDER
`

// The running section's program: a contact to toggle, and an ADD whose input pin names a variable to write
const LIVE_PROGRAM = `VAR
  Go, Lamp, Done : BOOL;
  N, M : INT;
END_VAR
LADDER
  |Go| (Lamp);
  ADD(EN, IN1 := N, IN2 := 1, OUT => M) (Done);
END_LADDER
`

let failures = 0
function expect(ok, what) {
  if (ok) console.log('  ok:', what)
  else {
    failures++
    console.error('  FAIL:', what)
  }
}

const stored = (page) => page.evaluate(() => window.__oip?.store?.getState?.().stProgram ?? '')
const count = (page) => page.locator('[data-testid="ladder-find-count"]').innerText()
/** What is lit as the match in hand: the class of the lit piece, and its text. */
const lit = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="ladder-view"] .found')].map((e) => `${e.className.split(' ')[0]}:${e.textContent.trim()}`))

const { url, vite } = await startServer()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.addInitScript(() => {
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate((program) => {
    const st = window.__oip.store
    st.loadScene({ version: st.getState().scene.version, parts: [] })
    st.setStProgram(program)
  }, PROGRAM)
  await showPlcEditor(page, { face: 'as-is' })
  const view = page.locator('[data-testid="ladder-view"]')
  await view.waitFor({ timeout: 20000 })

  console.log('--- Ctrl+F opens the bar, over the rungs ---')
  await view.focus()
  await page.keyboard.press('Control+f')
  const what = page.locator('[data-testid="ladder-find-what"]')
  await what.waitFor({ state: 'visible', timeout: 10000 })
  expect(await what.evaluate((el) => el === document.activeElement), 'the Find field has the keyboard')
  await what.fill('Belt1')
  expect(/of 7$/.test(await count(page)), `any text: 7 places (${await count(page)})`)

  console.log('--- Enter steps through the matches, each one selected and lit ---')
  // (the search starts after what is selected - a rung's comment stands above the rung - so
  // where the first Enter lands depends on the selection the view opened with; the steps from there do not)
  await what.press('Enter')
  const first = await count(page)
  const k = Number(first.split(' ')[0])
  const litFirst = await lit(page)
  expect(k >= 1 && /of 7$/.test(first), `Enter lands on a match (${first})`)
  expect(litFirst.length === 1, `exactly one piece of it lit (${JSON.stringify(litFirst)})`)
  await what.press('Enter')
  expect((await count(page)) === `${k + 1} of 7`, `Enter again: the next one (${await count(page)})`)
  expect((await lit(page)).length === 1 && JSON.stringify(await lit(page)) !== JSON.stringify(litFirst), `lit where it stands (${JSON.stringify(await lit(page))})`)
  expect((await page.locator('[data-testid="ld-element"].sel').count()) === 1, 'and its element is the selection')
  await what.press('Shift+Enter')
  expect((await count(page)) === `${k} of 7` && JSON.stringify(await lit(page)) === JSON.stringify(litFirst), `Shift+Enter goes back (${await count(page)})`)
  // a word only the comment holds: the comment is what is lit
  await what.fill('asked')
  await what.press('Enter')
  expect(JSON.stringify(await lit(page)) === JSON.stringify(['ld-comment:start Belt1 when asked']), `a match in a rung's comment lights the comment (${JSON.stringify(await lit(page))})`)
  await what.fill('Belt1')

  console.log('--- Match whole word ---')
  await page.locator('[data-testid="ladder-find-whole"]').check()
  expect(/of 4$/.test(await count(page)), `Belt10 and Belt1_Run are not Belt1 (${await count(page)})`)

  console.log('--- Replace All: one edit to the stored program, one Ctrl+Z ---')
  await page.locator('[data-testid="ladder-find-show-replace"]').click()
  const withField = page.locator('[data-testid="ladder-find-with"]')
  await withField.waitFor({ state: 'visible', timeout: 5000 })
  // the same button closes the Replace row again, and keeps what was being searched for
  await page.locator('[data-testid="ladder-find-show-replace"]').click()
  expect((await withField.count()) === 0 && (await page.locator('[data-testid="ladder-replace-all"]').count()) === 0, 'the Replace button hides the replace row again')
  expect((await what.inputValue()) === 'Belt1' && /of 4$/.test(await count(page)), `and the search stands (${await count(page)})`)
  await page.locator('[data-testid="ladder-find-show-replace"]').click()
  await withField.waitFor({ state: 'visible', timeout: 5000 })
  await withField.fill('Conv1')
  await page.locator('[data-testid="ladder-replace-all"]').click()
  await page.waitForFunction(() => (window.__oip.store.getState().stProgram ?? '').includes('Conv1'), null, { timeout: 10000 }).catch(() => {})
  const after = await stored(page)
  expect(/\(\* start Conv1 when asked \*\)/.test(after), 'the comment')
  expect(/\|Go\| \[\|Conv1\|, \|Belt10\|\] \(Belt1_Run\);/.test(after), `the contact in the branch, and not Belt10 / Belt1_Run (${after.split('\n')[7]})`)
  expect(/\|Conv1\| T1\(IN, PT := T#2s\) \(Belt10\);/.test(after), 'the next rung\'s contact')
  expect(/EQ\(IN1 := N, IN2 := 3, OUT\) \(Conv1\);/.test(after), 'the coil')
  expect(/Replaced 4 places/.test(await count(page)), `and says how many (${await count(page)})`)
  await view.focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction((p) => window.__oip.store.getState().stProgram === p, PROGRAM, { timeout: 10000 }).catch(() => {})
  expect((await stored(page)) === PROGRAM, 'one Ctrl+Z takes the whole Replace All back')

  console.log("--- a function's name is found, and never replaced ---")
  await page.keyboard.press('Control+h')
  await what.waitFor({ state: 'visible', timeout: 10000 })
  await what.fill('EQ')
  await what.press('Enter')
  expect(JSON.stringify(await lit(page)) === JSON.stringify(['ld-box-title:EQ']), `found: the block's title (${JSON.stringify(await lit(page))})`)
  await withField.fill('NE')
  await page.locator('[data-testid="ladder-replace"]').click()
  expect(/retyping the element/.test(await count(page)), `Replace says why not (${await count(page)})`)
  expect((await stored(page)) === PROGRAM, 'and the program is untouched')

  console.log('--- Esc closes it; the toolbar opens it ---')
  await what.press('Escape')
  await page.locator('[data-testid="ladder-find"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  expect((await page.locator('[data-testid="ladder-find"]').count()) === 0, 'Esc closes the bar')
  expect((await page.locator('[data-testid="ladder-view"] .found').count()) === 0, 'and nothing is lit any more')
  await page.locator('[data-testid="ladder-more"]').click()
  await page.locator('[data-testid="ladder-find-open"]').click()
  await what.waitFor({ state: 'visible', timeout: 5000 })
  expect(true, 'the selection menu\'s Find opens it')

  console.log('--- Cross Reference: every rung the tag is on, how each touches it, and a double coil ---')
  await page.locator('[data-testid="ladder-find-close"]').click()
  // a wholesale load: the mounted panel follows it (store.onStProgramLoad), where setStProgram would not reach it
  await page.evaluate((program) => window.__oip.store.loadStProgram(program), XREF_PROGRAM)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ladder-rung"]').length === 4, null, { timeout: 15000 })
  // A part in the scene wired to the same tag: the dialog names the device as well as the rungs (plc
  // `devicesForTag`). If the sheet passes devices={[]}, that sentence never appears for either family.
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => {
    const st = window.__oip.store
    const scene = st.getState().scene
    st.commit('Wire a belt to Belt1', { ...scene, parts: [...scene.parts, { id: 'xrefbelt', type: 'part', name: 'Belt_X', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Belt1' } }] })
  })
  await page.waitForTimeout(400)
  // the second rung's contact: |Belt1|
  await page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-kind="contact"]').first().click()
  await view.focus()
  await page.keyboard.press('Control+e')
  const dlg = page.locator('[data-testid="xref-dialog"]')
  await dlg.waitFor({ state: 'visible', timeout: 10000 })
  const rows = await dlg.locator('[data-testid="xref-rung"]').allInnerTexts()
  expect(rows.length === 4, `four rungs touch Belt1 (${rows.join(' | ')})`)
  expect(rows.filter((t) => /reads/.test(t)).length === 2 && rows.filter((t) => /energizes/.test(t)).length === 2, `two contacts read it, two coils energize it (${rows.join(' | ')})`)
  expect(rows.some((t) => /\|\s?\|/.test(t)) && rows.some((t) => /\(\s?\)/.test(t)), `each row names its element: a contact, a coil (${rows.join(' | ')})`)
  const intro = await dlg.locator('.author-intro').innerText()
  expect(/Declared VAR BOOL/.test(intro), `it names the declaration (${intro})`)
  expect(/duplicate destructive/.test(intro) && /double coil/.test(intro), 'and warns: two coils write the bit every scan')
  expect(/Belt_X/.test(intro) && /Run tag/.test(intro), `and the part in the scene that is wired to it (${intro})`)
  // out again, so the rest of the run sees the scene it expects
  await page.evaluate(() => {
    const st = window.__oip.store
    const scene = st.getState().scene
    st.commit('Remove the wired belt', { ...scene, parts: scene.parts.filter((x) => x.id !== 'xrefbelt') })
  })
  await dlg.locator('[data-testid="xref-rung"]').nth(3).click()
  await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  expect((await page.locator('[data-testid="ladder-rung"].sel').getAttribute('data-rung-index')) === '3', 'a row opens its rung, selected')
  // the toolbar opens it too, for the tag under the selection
  await page.locator('[data-testid="ladder-rung"]').nth(2).locator('[data-kind="coil"]').first().click()
  // (a right-click on the coil: the selection's menu)
  await page.locator('[data-testid="ladder-rung"]').nth(2).locator('[data-kind="coil"]').first().click({ button: 'right' })
  await page.locator('[data-testid="ladder-xref"]').click()
  await dlg.waitFor({ state: 'visible', timeout: 10000 })
  expect(/Cross Reference\s*Go/.test(await dlg.locator('h2').innerText()), `the right-click menu's Cross Reference, on the selected coil's tag (${await dlg.locator('h2').innerText()})`)
  await page.keyboard.press('Escape')

  console.log('--- type-ahead: the rest of a name proposed, selected, in the order the field wants ---')
  await page.evaluate((program) => window.__oip.store.loadStProgram(program), TYPEAHEAD_PROGRAM)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ladder-rung"]').length === 1, null, { timeout: 15000 })
  const field = page.locator('[data-testid="ladder-field"]')
  const caret = () => field.evaluate((el) => [el.value, el.selectionStart, el.selectionEnd])
  // a contact after |Go|: it asks for its variable
  await page.locator('[data-testid="ladder-rung"]').nth(0).locator('[data-kind="contact"]').first().click()
  await page.locator('[data-testid="ladder-insert-no"]').click()
  await field.waitFor({ timeout: 5000 })
  await page.keyboard.type('Be')
  let c = await caret()
  expect(c[0] === 'Belt1' && c[1] === 2 && c[2] === 5, `"Be" proposes Belt1, its ending selected - a contact wants a BOOL, so not Bench (${JSON.stringify(c)})`)
  await page.keyboard.type('n')
  c = await caret()
  expect(c[0] === 'Bench' && c[1] === 3 && c[2] === 5, `typing on replaces the proposal: "Ben" proposes Bench, still offered (${JSON.stringify(c)})`)
  await page.keyboard.press('Backspace')
  c = await caret()
  expect(c[0] === 'Ben' && c[1] === 3 && c[2] === 3, `Backspace takes the proposal away and proposes nothing (${JSON.stringify(c)})`)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('l')
  expect((await caret())[0] === 'Belt1', 'and typing again proposes again')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('|Go| |Belt1| (Belt1);'), null, { timeout: 10000 }).catch(() => {})
  expect((await stored(page)).includes('|Go| |Belt1| (Belt1);'), 'Enter takes it: the contact is named Belt1 in the program')
  // after a dot: the members of what stands before it, the BOOLs first
  await page.locator('[data-testid="ladder-rung"]').nth(0).locator('[data-kind="contact"]').nth(1).click()
  await page.locator('[data-testid="ladder-insert-no"]').click()
  await field.waitFor({ timeout: 5000 })
  await page.keyboard.type('T1.')
  c = await caret()
  expect(c[0] === 'T1.IN' && c[1] === 3 && c[2] === 5, `"T1." proposes a TON's first BOOL pin (${JSON.stringify(c)})`)
  await page.keyboard.type('E')
  expect((await caret())[0] === 'T1.ET', 'and "T1.E" its elapsed time')
  await page.keyboard.press('Escape')

  console.log('--- running: Toggle Bit, and a value typed into the running program ---')
  await page.evaluate((program) => window.__oip.store.loadStProgram(program), LIVE_PROGRAM)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ladder-rung"]').length === 2, null, { timeout: 15000 })
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.store.getState().running && window.__oip.controller.plcWatch && 'N' in window.__oip.controller.plcWatch, null, { timeout: 60000, polling: 250 })
  const watch = (k) => page.evaluate((key) => window.__oip.controller.plcWatch?.[key], k)
  // the first rung's contact, |Go|
  await page.locator('[data-testid="ladder-rung"]').nth(0).locator('[data-kind="contact"]').first().click()
  const toggleBtn = page.locator('[data-testid="ladder-toggle-bit"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="ladder-toggle-bit"]')?.hasAttribute('disabled'), null, { timeout: 10000 }).catch(() => {})
  expect(!(await toggleBtn.isDisabled()), 'Toggle Bit is offered on a BOOL contact while the program runs')
  await toggleBtn.click()
  await page.waitForFunction(() => window.__oip.controller.plcWatch?.Lamp === true, null, { timeout: 15000, polling: 200 }).catch(() => {})
  expect((await watch('Go')) === true, `the toolbar's Toggle Bit set Go in the running program (${await watch('Go')})`)
  expect((await watch('Lamp')) === true, 'and the program scanned it: the coil it drives came on')
  await view.focus()
  await page.keyboard.press('Control+t')
  await page.waitForFunction(() => window.__oip.controller.plcWatch?.Go === false, null, { timeout: 15000, polling: 200 }).catch(() => {})
  expect((await watch('Go')) === false, `Ctrl+T toggles it back (${await watch('Go')})`)
  // the ADD's IN1 pin names N: its live number is editable and writes into the running program
  const in1 = page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-pin="IN1"] [data-testid="ld-live"]')
  await in1.dblclick()
  const liveInput = page.locator('[data-testid="ld-live-input"]')
  await liveInput.waitFor({ state: 'visible', timeout: 10000 })
  await liveInput.fill('7')
  await liveInput.press('Enter')
  await page.waitForFunction(() => window.__oip.controller.plcWatch?.M === 8, null, { timeout: 15000, polling: 200 }).catch(() => {})
  expect((await watch('N')) === 7, `the value typed under IN1 reached the running program (N = ${await watch('N')})`)
  expect((await watch('M')) === 8, `and the next scan computed with it (M = ${await watch('M')})`)
  expect(!(await stored(page)).includes('7'), 'a live write is not an edit: the program text is untouched')
  await page.evaluate(() => window.__oip.controller.stop())

  expect(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  await browser.close()
  vite.kill()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall ladder-view tools checks passed')
