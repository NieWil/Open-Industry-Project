// The demo in two languages, through the buttons a visitor presses.
//
// The demo ships one program, each POU in the language that suits it (demoScenes.ts): Palletizer, the cell's program,
// in ladder, calling PalletTruck, the truck block, in Structured Text. The unit tests hold it to being the same machine
// as the demo all in ST and all in ladder (demoScenes.test.ts, demoScenesSim.test.ts); what only the app can show is
// the PLC panel treating a POU's language as the POU's own:
//   - the panel is open on some other program when the demo loads, and it comes up on the rungs of the program the
//     controller runs (openingFace), not on the text it was showing;
//   - there is no Text/Ladder switch, since no POU mixes the two, and no idle program;
//   - Play lights the rungs, and it is the ladder that drives the cell;
//   - the ST chip opens the text, the ladder chip brings the rungs back, and the ladder chip's "Show as text" shows the
//     rung text.
//
// Run: node e2e/verify-demo-ladder.mjs
/* global console, process, window, document, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'

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

  const code = page.locator('.cm-content').first()
  const sheet = page.locator('[data-testid="ladder-view"]')
  // a POU's row in the organizer beside the code
  const chip = (name) => page.locator(':is([data-testid="org-pou"], [data-testid="org-top"])').filter({ has: page.locator('.org-name', { hasText: new RegExp(`^${name}$`) }) })

  console.log('--- the panel is open on a program in text when the demo loads ---')
  await page.evaluate(() => window.__oip.store.revealPanel('st'))
  await code.waitFor({ state: 'visible', timeout: 30000 })
  expect(!(await sheet.isVisible()), 'the starting program is text')
  // Open Demo reloads into the demo (a project of its own), so the panel is revealed again on that page
  await clickDemo(page)
  await page.evaluate(() => window.__oip.store.revealPanel('st'))
  const main = await page.evaluate(() => window.__oip.store.getState().controller?.programs.map((p) => `${p.name}:${p.type}`).join(','))
  expect(main === 'Main:Palletizer', `the Controller runs Main : Palletizer (${main})`)

  console.log('--- ...and comes up on the rungs of the program Main runs ---')
  await sheet.waitFor({ state: 'visible', timeout: 20000 })
  expect(!(await code.isVisible()), 'the text is not what shows')
  const routines = await page.locator('[data-testid="ladder-routine"]').count()
  const rungs = await page.locator('[data-testid="ladder-rung"]').count()
  expect(routines === 1 && rungs > 50, `one ladder, Palletizer's (${routines} section(s), ${rungs} rungs)`)
  // the rows' language tags trail a load by a quarter second (StEditor LADDER_MARK_DELAY_MS)
  await page.waitForFunction(() => document.querySelector('[data-testid="org-pou"][data-lang="LD"]') !== null, null, { timeout: 5000 }).catch(() => {})
  const chips = await page.locator(':is([data-testid="org-pou"], [data-testid="org-top"])').evaluateAll((els) => els.map((e) => `${e.querySelector('.org-name')?.textContent}:${e.getAttribute('data-lang')}`))
  // Main, the top-level code (the code outside every POU, which declares the variables the scene is wired to), then the
  // program and its two function blocks (the truck, and the light curtains' muting sequence)
  expect(chips.join(',') === 'Top-level code:ST,Palletizer:LD,PalletTruck:ST,MutingSeq:ST', `the top-level code, a ladder program and two ST function blocks (${chips.join(', ')})`)
  expect((await page.locator('[data-testid="plc-view-text"], [data-testid="plc-view-ladder"]').count()) === 0, 'no Text/Ladder switch: no POU mixes the two')
  expect((await page.locator('[data-testid="org-pou"][data-unscheduled]').count()) === 0, 'no idle program')
  expect((await page.locator('[data-testid="ladder-idle"]').count()) === 0, 'and no notice about one')

  console.log('--- Play lights the rungs, and the ladder drives the cell ---')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => Object.keys(window.__oip.controller.plcWatch ?? {}).some((k) => k.startsWith('Main.LD_')), null, { timeout: 30000, polling: 250 }).catch(() => {})
  expect(await page.evaluate(() => Object.keys(window.__oip.controller.plcWatch ?? {}).some((k) => k.startsWith('Main.LD_'))), 'the attached program is the ladder (its rung temporaries are in the image)')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ladder-view"] .ld-wire.on').length > 0, null, { timeout: 30000, polling: 250 }).catch(() => {})
  const lit = await page.locator('[data-testid="ladder-view"] .ld-wire.on').count()
  expect(lit > 0, `the rungs light (${lit} wires carry power)`)
  // the program's own count of cases past the eye climbs; a drive read at one instant says nothing, since the line
  // stops feeding whenever a layer waits for the arm
  await page.waitForFunction(() => Number(window.__oip.controller.plcWatch?.['Cases'] ?? 0) > 0, null, { timeout: 90000, polling: 500 }).catch(() => {})
  const live = await page.evaluate(() => {
    const w = window.__oip.controller.plcWatch ?? {}
    return { cases: w['Cases'], pushed: w['Main.rowsPushed'], truck: w['Main.Truck.Step'] }
  })
  expect(Number(live.cases) > 0, `and it drives the cell: ${String(live.cases)} cases past the eye, ${String(live.pushed)} rows pushed`)
  await page.screenshot({ path: 'e2e/out/demo-ladder-live.png' })

  console.log('--- each row opens its POU in its own language ---')
  // stop first: the view re-lays its rungs on every poll of a running image, and a click can wait out its timeout
  await page.evaluate(() => window.__oip.controller.stop())
  await chip('PalletTruck').click({ timeout: 60000 })
  await code.waitFor({ state: 'visible', timeout: 10000 })
  expect(!(await sheet.isVisible()), 'the ST row opens the text')
  expect((await code.innerText()).includes('FUNCTION_BLOCK PalletTruck'), "at the truck block's code")
  await chip('Palletizer').click({ timeout: 60000 })
  await sheet.waitFor({ state: 'visible', timeout: 10000 })
  expect(!(await code.isVisible()), 'the ladder row brings the rungs back')

  console.log('--- "Show as text" on the ladder row ---')
  await chip('Palletizer').click({ button: 'right', timeout: 60000 })
  const showText = page.locator('[data-testid="org-show-text"]')
  expect(await showText.isVisible(), 'a ladder row offers its text')
  await showText.click()
  await code.waitFor({ state: 'visible', timeout: 10000 })
  // at the POU's head: CodeMirror renders only the lines in view, and its LADDER keyword comes after a long VAR block
  expect((await code.innerText()).includes('PROGRAM Palletizer'), "the rung text shows, at the program's own code")
  expect((await page.evaluate(() => window.__oip.store.getState().demoSession)) === true, 'looking is not an edit: the demo is still the demo')
  await chip('Palletizer').click({ timeout: 60000 })
  await sheet.waitFor({ state: 'visible', timeout: 10000 })
  expect(await sheet.isVisible(), 'and the row goes back to the rungs')

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
console.log('\nall demo-ladder checks passed')
