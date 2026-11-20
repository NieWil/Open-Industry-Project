// The ladder view's declaration pane, through the buttons a person presses (components/plc/LadderVariables.tsx).
//
// A ladder program has no VAR block on screen, so this pane is where its variables are read and changed without going
// to the text: the POU's declaration part, shown above its rungs. plc/declarations.test.ts proves the
// text edits; what only a browser run can prove is that the pane reaches them: that it opens on the section's POU and
// lists what that POU declares, that an add / retype / move / delete lands in the program text as one edit the Ladder
// view's Ctrl+Z takes back, that a refused name says why and changes nothing, that deleting a variable a rung still
// uses is shown on the rung (with the one-click Declare), that a name leads to its declaration in the text, and that a
// view-only link reads the rows without being able to change them.
// Run: node e2e/verify-ladder-variables.mjs

/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const PROGRAM = `VAR
  Always : BOOL := TRUE;
  Start, Stop, Motor, Idle, Hit : BOOL;
  N : INT := 3;
END_VAR
LADDER
  (* seal-in *)
  [|Start|, |Motor|] |/Stop| (Motor);
  |Always| (Idle);
  EQ(IN1 := N, IN2 := 3, OUT) (Hit);
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
  await page.locator('[data-testid="ladder-view"]').waitFor({ timeout: 20000 })

  const stored = () => page.evaluate(() => window.__oip.store.getState().stProgram)
  const pane = page.locator('[data-testid="ld-vars"]')
  const names = async () => (await pane.locator('[data-testid="ld-var"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))).join(',')
  const varRow = (name) => pane.locator(`[data-testid="ld-var"][data-name="${name}"]`)

  console.log('--- the pane opens on the section and lists what its POU declares ---')
  const toggle = page.locator('[data-testid="ld-vars-toggle"]').first()
  expect((await pane.count()) === 0, 'it starts closed: the rungs are what the sheet is for')
  expect(/Variables\s*7/.test((await toggle.textContent()) ?? ''), `its toggle says how many there are (${await toggle.textContent()})`)
  await toggle.click()
  await pane.waitFor({ timeout: 5000 })
  expect((await names()) === 'Always,Start,Stop,Motor,Idle,Hit,N', `every variable, in order, one row each even from a list (${await names()})`)
  expect((await varRow('N').locator('td').nth(3).textContent())?.trim() === '3', 'with its starting value')

  console.log('--- add ---')
  await page.locator('[data-testid="ld-var-new-name"]').fill('N')
  await page.locator('[data-testid="ld-var-add"]').click()
  const refused = (await page.locator('[data-testid="ld-var-error"]').textContent().catch(() => '')) ?? ''
  expect(/already declared/.test(refused) && (await stored()) === PROGRAM, `a name already declared is refused, with the reason, and nothing changes (${refused})`)
  await page.locator('[data-testid="ld-var-new-name"]').fill('Jam')
  await page.locator('[data-testid="ld-var-new-name"]').press('Enter')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('Jam : BOOL;'), null, { timeout: 5000 }).catch(() => {})
  const added = await stored()
  expect(/N : INT := 3;\s*\n\s*Jam : BOOL;\s*\nEND_VAR/.test(added), 'Enter declares it in the VAR block, on a line of its own')
  expect((await names()).endsWith(',Jam'), `and its row appears (${await names()})`)
  // the type box: Enter while typing takes the completion and stops there; the next Enter adds the row
  await page.locator('[data-testid="ld-var-new-name"]').fill('Cnt')
  const newType = page.locator('[data-testid="ld-var-new-type-box"]')
  await newType.fill('DI')
  await newType.press('Enter')
  await page.waitForTimeout(200)
  expect((await newType.inputValue()) === 'DINT' && !(await stored()).includes('Cnt'), `Enter in the type box takes the completion and adds nothing yet (${await newType.inputValue()})`)
  await newType.press('Enter')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('Cnt : DINT;'), null, { timeout: 5000 }).catch(() => {})
  expect((await stored()).includes('Cnt : DINT;') && (await names()).endsWith(',Jam,Cnt'), `the next Enter adds the row, with that type (${await names()})`)

  console.log('--- retype, and move to another section ---')
  const nType = varRow('N').locator('[data-testid="ld-var-type-box"]')
  await nType.fill('DINT')
  await nType.press('Enter')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('N : DINT := 3;'), null, { timeout: 5000 }).catch(() => {})
  expect((await stored()).includes('N : DINT := 3;'), 'a new type is written in place, keeping the starting value')
  await varRow('Jam').locator('[data-testid="ld-var-usage"]').selectOption('VAR_OUTPUT')
  await page.waitForFunction(() => /VAR_OUTPUT\s+Jam : BOOL;/.test(window.__oip.store.getState().stProgram), null, { timeout: 5000 }).catch(() => {})
  expect(/VAR_OUTPUT\s+Jam : BOOL;\s+END_VAR/.test(await stored()), 'a new usage moves it to a block of that section')

  console.log('--- delete, what a rung makes of it, and one Ctrl+Z ---')
  const beforeDelete = await stored()
  await varRow('Idle').locator('[data-testid="ld-var-delete"]').click()
  await page.waitForFunction(() => !/\bIdle\b\s*[,:]/.test(window.__oip.store.getState().stProgram), null, { timeout: 5000 }).catch(() => {})
  expect((await stored()).includes('Start, Stop, Motor, Hit : BOOL;'), 'deleting takes the name out of its list')
  const declare = await page.locator('[data-testid="ladder-declare"]').first().waitFor({ timeout: 8000 }).then(() => true, () => false)
  expect(declare, 'the rung that still writes it says so, and offers to declare it again')
  await page.locator('[data-testid="ladder-view"]').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction((b) => window.__oip.store.getState().stProgram === b, beforeDelete, { timeout: 5000 }).catch(() => {})
  expect((await stored()) === beforeDelete, "one Ctrl+Z in the view takes the delete back: the pane's edit is one step of the same history")

  console.log('--- rename ---')
  // a new name goes through the panel's rename (plcPanelParts.tsx renameDeclaration), which loads plc/tags.ts on
  // demand: it lands in the declaration and every rung that uses it, and a refused one says why and changes nothing
  const hitName = varRow('Hit').locator('[data-testid="ld-var-name"]')
  await hitName.fill('Struck')
  await hitName.press('Enter')
  await page.waitForFunction(() => /\bStruck\b/.test(window.__oip.store.getState().stProgram), null, { timeout: 5000 }).catch(() => {})
  const renamed = await stored()
  expect(/Motor, Idle, Struck : BOOL;/.test(renamed) && /\(Struck\);/.test(renamed) && !/\bHit\b/.test(renamed), 'a new name lands in the declaration and in the rung that writes it')
  const beforeRefusal = await stored()
  const struckName = varRow('Struck').locator('[data-testid="ld-var-name"]')
  await struckName.fill('Motor')
  await struckName.press('Enter')
  const why = await page.locator('[data-testid="ld-var-error"]').waitFor({ timeout: 5000 }).then(() => page.locator('[data-testid="ld-var-error"]').textContent(), () => '')
  expect(/already declared/.test(why ?? '') && (await stored()) === beforeRefusal, `a name already taken is refused, with the reason, and nothing changes (${why})`)

  console.log('--- a name leads to its declaration ---')
  // (a name that can be renamed is a field, so the way to the text is the arrow beside it)
  await varRow('N').locator('[data-testid="ld-var-show"]').click()
  await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(300)
  const line = (await page.locator('.cm-activeLine').first().textContent().catch(() => '')) ?? ''
  expect(/N : DINT := 3;/.test(line), `the text opens with the cursor on it (${line.trim()})`)

  console.log('--- view-only ---')
  await page.evaluate(() => window.__oip.store.setReadOnly(true))
  await page.locator('[data-testid="org-top"]').click()
  await page.locator('[data-testid="ladder-view"]').waitFor({ timeout: 10000 })
  if ((await pane.count()) === 0) await page.locator('[data-testid="ld-vars-toggle"]').first().click()
  await pane.waitFor({ timeout: 5000 })
  expect(await varRow('N').locator('[data-testid="ld-var-type"]').isDisabled(), 'the rows read, and cannot be changed')
  expect((await pane.locator('[data-testid="ld-var-new-name"], [data-testid="ld-var-delete"]').count()) === 0, 'and there is nothing to add or delete')
  await page.evaluate(() => window.__oip.store.setReadOnly(false))

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
console.log('\nall ladder-variables checks passed')
