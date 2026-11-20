// Assign I/O and Import I/O list, through the menu a user opens: right-click Top-level code (the code outside every POU) in the PLC
// panel's organizer, since what they assign is addresses for its variables.
//
// The command turns a scene wired by name into one wired to a PLC's I/O points: every tag a part is wired
// to gets an address, the program declares it there (`Eye AT %IX0.0 : BOOL`), and the parts follow. What
// this gate holds that the unit tests cannot: the commands are where the organizer says they are, the edit
// reaches the store's scene and program, what it did is reported in the PLC panel's report card under the
// code it changed, and one Ctrl+Z takes back both halves (it is one undo step).
//
// Runs in a browser: assigning I/O is a program edit, not a network one, so it must work
// without the desktop app (which e2e/verify-external-plc-electron.mjs covers).

import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const PROGRAM = `VAR
  Eye : BOOL;
  Count : INT;
  Run : BOOL;
END_VAR
Run := NOT Eye;
IF Run THEN Count := Count + 1; END_IF;`

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })

  const loaded = await page.evaluate((program) => {
    const st = window.__oip.store
    const pkgs = st.getState().bundledPackages
    const need = ['oip.belt-conveyor', 'oip.diffuse-sensor'].map((id) => pkgs.find((p) => p.id === id))
    if (need.some((p) => !p)) return 'a bundled package is missing'
    st.loadScene({
      version: st.getState().scene.version,
      parts: [
        { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0,
          params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Run' } },
        { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0,
          params: { maxRange: 1.2, tag: 'Eye' } },
      ],
      packages: need,
    })
    st.setStProgram(program)
    st.setState({ selectedIds: [] })
    return true
  }, PROGRAM)
  expect(loaded === true, `a scene wired to the program's names loads (${loaded})`)

  console.log('--- Assign I/O ---')
  await showPlcEditor(page)
  const tags = page.locator('[data-testid="org-top"]')
  await tags.waitFor({ timeout: 20000 })
  /** A command from the Top-level code row's right-click menu. */
  const tagsMenu = async (testid) => {
    await tags.click({ button: 'right' })
    const item = page.locator(`[data-testid="${testid}"]`)
    await item.waitFor({ timeout: 5000 })
    return item
  }
  const assign = await tagsMenu('org-assign-io')
  expect(await assign.isEnabled(), 'Main offers Assign I/O in a browser tab, with no PLC in sight')
  await assign.click()
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('AT %'), null, { timeout: 15000, polling: 100 })

  const after = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    const by = Object.fromEntries(s.scene.parts.map((p) => [p.id, p.params]))
    return { run: by.belt?.runTag, eye: by.eye?.tag, program: s.stProgram }
  })
  expect(after.eye === '%IX0.0' && after.run === '%QX0.0', `both parts are wired to I/O points (${after.eye}, ${after.run})`)
  expect(/Eye AT %IX0\.0 : BOOL;/.test(after.program) && /Run AT %QX0\.0 : BOOL;/.test(after.program), 'the program declares each tag at its address')
  expect(/VAR\s+Count : INT;\s+END_VAR/.test(after.program), 'the variable that is not I/O stays an ordinary one')

  const report = await page.locator('[data-testid="st-file-report"]').innerText()
  expect(/2 tags at an I\/O address, 2 parts wired to them/.test(report), `the PLC panel reports what it did, under the code (${report.split('\n').slice(0, 2).join(' | ')})`)
  expect(/%IX0\.0\s+Eye/.test(report), 'and lists each point it assigned')

  // the points a PLC would poll are served by the desktop app, the only surface that can (verify-external-plc-electron.mjs);
  // here Controller Properties says so, and the assignment still happened
  await page.locator('[data-testid="org-controller"]').dblclick()
  await page.locator('[data-testid="controller-props"]').waitFor({ timeout: 10000 })
  expect((await page.locator('[data-testid="controller-desktop-only"]').count()) === 1, 'Controller Properties still says serving them needs the desktop app')
  await page.locator('[data-testid="controller-props-close"]').click()

  // an address says nothing about what it carries, so the Inspector shows the program's name for the point
  await page.evaluate(() => window.__oip.store.setState({ selectedIds: ['eye'] }))
  await page.waitForFunction(() => [...document.querySelectorAll('.field-badge')].some((b) => b.textContent?.includes('=')), null, { timeout: 15000, polling: 100 })
  const badges = await page.evaluate(() => [...document.querySelectorAll('.field-badge')].map((b) => b.textContent?.trim()))
  expect(badges.includes('= Eye'), `the Inspector names the point beside the address (${badges.join(' | ')})`)

  // the door outward, and the loop closed: what it writes is what the importer reads
  console.log('--- Export I/O list ---')
  const download = page.waitForEvent('download')
  await (await tagsMenu('org-export-io')).click()
  const file = await download
  const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString())
  expect(/^Tag,Address,Type,Direction,Modbus point,Device$/m.test(csv), 'the CSV has the columns a panel builder reads')
  expect(/^Eye,%IX0\.0,BOOL,PLC input,discrete input 0,/m.test(csv), `the sensor's point is listed (${csv.split('\n')[1]})`)
  expect(/^Run,%QX0\.0,BOOL,PLC output,coil 0,/m.test(csv), `the belt's point is listed (${csv.split('\n')[2]})`)
  expect(/\.csv$/.test(file.suggestedFilename()), `it downloads as a CSV (${file.suggestedFilename()})`)

  console.log('--- one undo step ---')
  await page.evaluate(() => window.__oip.store.undo())
  const undone = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    const by = Object.fromEntries(s.scene.parts.map((p) => [p.id, p.params]))
    return { run: by.belt?.runTag, eye: by.eye?.tag, program: s.stProgram }
  })
  expect(undone.eye === 'Eye' && undone.run === 'Run', `Ctrl+Z puts the wiring back (${undone.eye}, ${undone.run})`)
  expect(!undone.program.includes('AT %'), 'and the same step puts the program back: no half-assigned scene')

  console.log('--- Import I/O list ---')
  const chooser = page.waitForEvent('filechooser')
  await (await tagsMenu('org-import-io')).click()
  await (await chooser).setFiles({
    name: 'line-io.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Tag,Address,Description\nEye,%IX3.2,photo eye at the end\nRun,%QX4.0,belt motor\nPump_7,%QX9.0,not in this scene\n'),
  })
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('%IX3.2'), null, { timeout: 15000, polling: 100 })
  const imported = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    const by = Object.fromEntries(s.scene.parts.map((p) => [p.id, p.params]))
    return { run: by.belt?.runTag, eye: by.eye?.tag, program: s.stProgram }
  })
  expect(imported.eye === '%IX3.2' && imported.run === '%QX4.0', `the list's own addresses are taken (${imported.eye}, ${imported.run})`)
  const skipped = await page.locator('[data-testid="st-file-report"]').innerText()
  expect(/Pump_7/.test(skipped), `a row this scene does not model is reported, not declared (${skipped.split('\n').find((l) => /Pump_7/.test(l)) ?? skipped.slice(0, 80)})`)

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
console.log('\nall assign-io checks passed')
