// The ladder view, through the buttons a person presses (the PLC panel's ladder face).
//
// The view is a projection of the program text (plc/ladder/ladderRungs.ts): a gesture reprints the rungs into the one source
// string, through the text editor, as one ordinary edit. What this gate holds that the unit tests cannot: a ladder
// program opens on its rungs with no Text | Ladder switch (it is one language; its chip's "Show as text" is the way to
// its rung text, and the chip the way back), "+ > Ladder program" adds a PROGRAM that opens on the sheet, the rungs of
// a real program are drawn (contacts, coils, a block with its pins), a palette
// element goes onto the rung and asks for its operand, a timer from the palette comes with its instance declared, a
// comparison from the palette goes to the front of the rung (it starts one: nothing feeds it), one Ctrl+Z in the view
// takes an edit back (it is the text editor's history), and while the program runs the view lights what has power,
// a comparison by what it returned - the one thing only a running program can show.
//
// Runs in a browser: nothing here needs the desktop app.

import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor, showText } from './_plc.mjs'

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
  // before the app reads it: no onboarding tour over the panel
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

  console.log('--- the face the panel opens on is the program\'s own ---')
  // this program is a ladder (one section, no statements around it), so the panel opens on the rungs rather than on
  // `LADDER ... END_LADDER` source. The view follows the POU; nothing is remembered from a previous visit.
  await page.locator('[data-testid="ladder-view"]').waitFor({ timeout: 20000 })
  expect(!(await page.locator('.cm-content').first().isVisible()), 'a ladder program opens as rungs')
  expect((await page.locator('[data-testid="plc-view-ladder"], [data-testid="plc-view-text"]').count()) === 0, 'with no Text | Ladder switch: its one POU is one language')
  const rowFace = await page.locator('[data-testid="org-top"]').getAttribute('data-lang')
  expect(rowFace === 'LD', `its organizer row is marked a ladder POU (${rowFace})`)

  console.log('--- its rung text is behind its row, and the row goes back to the rungs ---')
  await showText(page)
  // the program lands in the editor only through the store; give the panel its text
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('LADDER'), null, { timeout: 15000 })
  expect(await page.locator('.cm-content').first().isVisible(), '"Show as text" shows the rung text')
  await page.locator('[data-testid="org-top"]').click()
  await page.locator('[data-testid="ladder-view"]').waitFor({ timeout: 20000 })

  console.log('--- the rungs drawn ---')
  const rungs = await page.locator('[data-testid="ladder-rung"]').count()
  expect(rungs === 3, `three rungs drawn (${rungs})`)
  const kinds = await page.locator('[data-testid="ld-element"]').evaluateAll((els) => els.map((e) => `${e.dataset.kind}:${e.dataset.mode}`))
  expect(JSON.stringify(kinds) === JSON.stringify(['contact:open', 'contact:open', 'contact:closed', 'coil:normal', 'contact:open', 'coil:normal', 'box:undefined', 'coil:normal']), `the seal-in's contacts and coils, then the comparison, in order (${kinds.join(' ')})`)
  const compare = page.locator('[data-testid="ladder-rung"]').nth(2).locator('[data-kind="box"]')
  expect((await compare.getAttribute('data-starts')) === 'true' && (await compare.locator('.ld-wire.none').count()) === 1, 'the comparison starts its rung: no wire leads into it')
  expect((await page.locator('[data-testid="ld-branch"]').count()) === 1, 'the seal-in branch is one branch')
  expect((await page.locator('[data-testid="ladder-comment"]').first().innerText()).includes('seal-in'), 'the comment above the rung is drawn over it')

  console.log('--- a palette element lands on the rung and asks for its variable ---')
  // select rung 1's contact, then drop a normally-closed contact after it
  await page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-testid="ld-element"]').first().click()
  await page.locator('[data-testid="ladder-insert-nc"]').click()
  const field = page.locator('[data-testid="ladder-field"]')
  await field.waitFor({ timeout: 5000 })
  await field.fill('Stop')
  await field.press('Enter')
  const afterInsert = await page.evaluate(() => window.__oip.store.getState().stProgram)
  expect(afterInsert.includes('|Always| |/Stop| (Idle);'), 'the contact is in the program text, named')

  console.log('--- Ctrl+Z in the view takes it back, a gesture at a time ---')
  // placing the contact and naming it were two gestures, so they are two steps of the text editor's history
  await page.locator('[data-testid="ladder-view"]').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('|Always| |/?| (Idle);'), null, { timeout: 5000 }).catch(() => {})
  const once = await page.evaluate(() => window.__oip.store.getState().stProgram)
  expect(once.includes('|Always| |/?| (Idle);'), `the first Ctrl+Z takes the name back (${/\|Always\|[^;]*;/.exec(once)?.[0]})`)
  await page.locator('[data-testid="ladder-view"]').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('|Always| (Idle);'), null, { timeout: 5000 }).catch(() => {})
  const twice = await page.evaluate(() => window.__oip.store.getState().stProgram)
  expect(twice.includes('|Always| (Idle);'), `the second takes the contact away (${/\|Always\|[^;]*;/.exec(twice)?.[0]})`)

  console.log('--- a timer from the palette comes declared ---')
  await page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-testid="ld-element"]').first().click()
  await page.locator('[data-testid="ladder-tab-Timers & counters"]').click()
  await page.locator('[data-testid="ladder-insert-TON"]').click()
  await field.waitFor({ timeout: 5000 })
  await field.fill('T#2s')
  await field.press('Enter')
  const withTimer = await page.evaluate(() => window.__oip.store.getState().stProgram)
  expect(/TON_1 : TON;/.test(withTimer), 'TON_1 is declared in the program')
  expect(withTimer.includes('|Always| TON_1(IN, PT := T#2s) (Idle);'), 'and sits on the rung, fed by the contact, with its preset')
  const box = page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-kind="box"]')
  expect((await box.count()) === 1 && (await box.innerText()).includes('TON'), 'drawn as a TON box')

  console.log('--- a comparison from the palette starts the rung, wherever the selection is ---')
  // select the rung's last element: a comparison cannot follow it, so it goes to the front
  await page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-kind="coil"]').click()
  await page.locator('[data-testid="ladder-tab-Math & compare"]').click()
  await page.locator('[data-testid="ladder-insert-GT"]').click()
  await field.waitFor({ timeout: 5000 })
  await field.fill('N')
  await field.press('Enter')
  // on to its next blank operand
  await field.waitFor({ timeout: 5000 })
  await field.fill('1')
  await field.press('Enter')
  const withCompare = await page.evaluate(() => window.__oip.store.getState().stProgram)
  const rung1 = withCompare.split('\n').find((l) => l.includes('(Idle);'))?.trim()
  expect(rung1 === 'GT(IN1 := N, IN2 := 1, OUT) |Always| TON_1(IN, PT := T#2s) (Idle);', `the GT starts the rung (${rung1})`)
  await page.screenshot({ path: 'e2e/out/ladder-view-edit.png' })

  console.log('--- live: what has power is lit ---')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => document.querySelector('[data-testid="ld-element"][data-on="true"]') !== null, null, { timeout: 30000, polling: 250 }).catch(() => {})
  // Start and Motor are FALSE, Stop is FALSE (so its normally-closed contact passes), Always is TRUE: only those two
  // contacts are drawn closed, and the seal-in's coil stays off
  const states = await page.locator('[data-testid="ladder-rung"] [data-testid="ld-element"]:not([data-kind="box"])').evaluateAll((els) => els.map((e) => e.dataset.on))
  expect(JSON.stringify(states.slice(0, 5)) === JSON.stringify(['false', 'false', 'true', 'false', 'true']), `Start, Motor, /Stop, (Motor), Always drawn off, off, on, off, on (${states.join(' ')})`)
  expect((await page.locator('[data-testid="ladder-rung"]').nth(1).locator('.ld-wire.on').count()) > 0, 'the powered rung has lit wires')
  const sealIn = page.locator('[data-testid="ladder-rung"]').nth(0)
  const reaches = await sealIn.locator('[data-kind="contact"]').first().locator('.ld-sym .ld-wire').first().getAttribute('class')
  const coilFed = await sealIn.locator('[data-kind="coil"] .ld-wire.on').count()
  expect(/\bon\b/.test(reaches ?? '') && coilFed === 0, 'the seal-in has power at its first contact and none at its coil')
  // N is 3: EQ(N, 3) and GT(N, 1) both returned TRUE, so both boxes are lit, and so is the coil EQ drives
  const lit = await page.locator('[data-testid="ladder-rung"] [data-starts="true"] .ld-box.on').count()
  expect(lit === 2, `both comparisons are lit by what they returned (${lit} of 2)`)
  const hit = await page.locator('[data-testid="ladder-rung"]').nth(2).locator('[data-kind="coil"]').getAttribute('data-on')
  expect(hit === 'true', `the coil the EQ drives is on (${hit})`)
  // a running timer shows that it runs: the power reaching IN, and ET counting though the rung never names ET (a TON
  // box drawing only IN, PT and Q would show nothing moving for the whole of PT)
  const tonPin = (name) => page.locator('[data-testid="ladder-rung"]').nth(1).locator(`[data-kind="box"]:not([data-starts]) [data-pin="${name}"] .ld-live`)
  let et = null
  for (let t = Date.now(); Date.now() - t < 15000 && !(Number(et) > 0); await page.waitForTimeout(200)) et = await tonPin('ET').textContent({ timeout: 2000 }).catch(() => null)
  const tonIn = await tonPin('IN').textContent({ timeout: 2000 }).catch(() => null)
  expect(Number(et) > 0 && tonIn === '1', `the running TON shows IN on and ET counting (IN ${tonIn}, ET ${et})`)
  await page.screenshot({ path: 'e2e/out/ladder-view-live.png' })
  await page.evaluate(() => window.__oip.controller.stop())

  console.log('--- as text: the same program ---')
  await showText(page)
  await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 5000 })
  const text = await page.locator('.cm-content').first().innerText()
  expect(text.includes('TON_1(IN, PT := T#2s)'), 'the text editor shows the rungs the view wrote')

  console.log('--- "+ New > Ladder program": a PROGRAM that opens on the sheet ---')
  await page.locator('[data-testid="org-new"]').click()
  await page.locator('[data-testid="org-new-ladderProgram"]').click()
  const nameField = page.locator('[data-testid="org-new-program-name"]')
  await nameField.waitFor({ timeout: 5000 })
  const draftLang = await page.locator('[data-testid="org-new-program-lang"]').textContent().catch(() => null)
  expect(draftLang === 'LD', `the name field says the program being named is ladder (${draftLang})`)
  await nameField.fill('Conveyor')
  await nameField.press('Enter')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('PROGRAM Conveyor'), null, { timeout: 5000 }).catch(() => {})
  const added = await page.evaluate(() => ({ source: window.__oip.store.getState().stProgram, rows: window.__oip.store.getState().controller?.programs.map((p) => p.type ?? '-') }))
  expect(/PROGRAM Conveyor[\s\S]*LADDER[\s\S]*\|In\| \(Out\);[\s\S]*END_LADDER\s*END_PROGRAM/.test(added.source), 'the program is written with a ladder for its body')
  expect(added.rows?.includes('Conveyor'), `and a task runs it (${added.rows?.join(', ')})`)
  await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 10000 })
  const routinesNow = await page.locator('[data-testid="ladder-routine"]').count()
  expect(routinesNow === 2, `the panel went to the sheet, where it is drawn beside the first ladder (${routinesNow} sections)`)
  // the rows' language tags trail an edit by a quarter second (StEditor LADDER_MARK_DELAY_MS)
  const conveyorRow = page.locator('[data-testid="org-pou"]').filter({ has: page.locator('.org-name', { hasText: /^Conveyor$/ }) })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="org-pou"]')].some((c) => c.querySelector('.org-name')?.textContent === 'Conveyor' && c.getAttribute('data-lang') === 'LD'), null, { timeout: 5000 }).catch(() => {})
  const conveyorFace = await conveyorRow.getAttribute('data-lang')
  expect(conveyorFace === 'LD', `its organizer row is marked a ladder POU (${conveyorFace})`)

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
console.log('\nall ladder-view checks passed')
