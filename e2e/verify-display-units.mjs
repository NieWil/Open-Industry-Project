// Gate: the scene's Units are one choice that decides both how speeds are shown and what its conveyors' speed tags
// carry, and its Length a second, display-only one for lengths (core/scene/sceneUnits.ts). Scene Properties > Units
// converts every conveyor as one undoable edit, the Inspector shows and takes lengths and speeds in those units while
// the document keeps its own, and no conveyor offers a units switch of its own.
//
// The failure it guards is quiet: a field that doesn't convert back would store inches as metres, a conveyor
// with its own units switch would read the wrong tag, and every number on screen would still look plausible.
//
// Asserts:
//   A. old scene - a scene with no Units saved reads metric, like the m/s conveyors it holds.
//   B. switch - choosing Imperial converts every conveyor (speed to FPM, the bound speed tag moved to the FPM
//                   field, still a REAL), names the moved tag in a note, and is one undo step that undo restores exactly.
//   C. shown - under imperial a conveyor shows its speed in FPM and the Transform row in inches, and offers
//                   no per-part units switch.
//   D. typed - a value typed in the shown unit is stored in the stored unit (48 in of stand height is 1.2192 m).
//   E. back - Metric converts the conveyor back exactly (FPM is not rounded on the way) and reads m/s again.
//   F. mm - Length mm shows and takes lengths in millimetres, and leaves conveyors and their tags in m/s.
//   G. carried - Speed Imperial moves a Length of mm to inches in the same edit and says so (speeds in FPM, lengths
//                   in inches), and a scene saved with Units 'metric-mm' opens as Metric with Length mm.
// Run: node e2e/verify-display-units.mjs
/* global process, console, window, document, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { url, vite } = await startServer()

let failed = false
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${msg}`)
  if (!ok) failed = true
}

/** the rendered number field of one param row: its text and its unit suffix */
const readField = (page, key) =>
  page.evaluate((k) => {
    const row = document.querySelector(`.inspector .prop-row[data-param="${k}"]`)
    return row ? { text: row.querySelector('input.spin-input')?.value ?? null, unit: row.querySelector('.spin-unit')?.textContent ?? '' } : null
  }, key)
const paramsOf = (page, id) => page.evaluate((i) => window.__oip.store.getState().scene.parts.find((p) => p.id === i)?.params ?? null, id)

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })

  // a scene saved before Units existed: no `units`, and conveyors with no switch saved (so m/s, the whenAbsent)
  const loaded = await page.evaluate(() => {
    const st = window.__oip.store
    const belt = st.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')
    if (!belt) return 'the belt conveyor package is missing'
    const params = (speed, tag) => ({ shapePreset: 'custom', segments: [[4, 0]], width: 0.8, standHeight: 0.8, speed, ...(tag ? { speedTag: tag } : {}) })
    st.loadScene({
      version: st.getState().scene.version,
      parts: [
        { id: 'b1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: params(2, 'Line1Speed') },
        { id: 'b2', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 3], rotationY: 0, params: params(1) },
      ],
      packages: [belt],
    })
    st.setState({ selectedIds: [] })
    return true
  })
  check(loaded === true, `an old-style scene with two m/s belts loads (${loaded})`)

  // --- A: an old scene reads metric ---
  const select = page.locator('[data-testid="scene-units"]')
  await select.waitFor({ timeout: 15000 })
  check((await select.inputValue()) === 'metric', 'a scene with no Units saved reads Metric')

  // --- B: the switch converts every conveyor, as one undo step ---
  const before = await page.evaluate(() => JSON.stringify(window.__oip.store.getState().scene))
  await select.selectOption('imperial')
  await page.waitForTimeout(200)
  const b1 = await paramsOf(page, 'b1')
  const b2 = await paramsOf(page, 'b2')
  check(b1?.fpmUnits === true && b2?.fpmUnits === true, 'both belts now run in FPM')
  const near = (v, want) => typeof v === 'number' && Math.abs(v - want) < 1e-6
  check(near(b1?.speedFpm, 393.7007874) && near(b2?.speedFpm, 196.8503937), `their speeds converted (got ${b1?.speedFpm}, ${b2?.speedFpm}; want 393.70, 196.85)`)
  check(b1?.speedFpmTag === 'Line1Speed' && b1?.speedTag === '', 'the bound speed tag moved to the FPM field')
  const tagType = await page.evaluate(() => window.__oip.store.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')?.params?.speedFpmTag?.stType)
  check(tagType === 'REAL', `the FPM speed tag is a REAL, like the m/s one (got ${tagType})`)
  const note = await page.locator('[data-testid="scene-units-note"]').textContent().catch(() => '')
  check(!!note && note.includes('2 conveyors') && note.includes('Line1Speed') && !note.includes('DINT'), `the note counts the conveyors and names the moved tag ("${note}")`)
  await page.evaluate(() => window.__oip.store.undo())
  await page.waitForTimeout(200)
  check((await page.evaluate(() => JSON.stringify(window.__oip.store.getState().scene))) === before, 'one undo puts the scene back byte for byte')
  await page.evaluate(() => window.__oip.store.redo())
  await page.waitForTimeout(200)
  check(near((await paramsOf(page, 'b1'))?.speedFpm, 393.7007874), 'redo converts it again')

  // --- C: shown in the scene's units, no per-part switch ---
  await page.evaluate(() => window.__oip.store.select('b1'))
  await page.waitForSelector('.inspector .prop-row[data-param="speedFpm"] input.spin-input', { timeout: 10000 })
  const speed = await readField(page, 'speedFpm')
  check(speed?.unit === 'FPM' && speed?.text === '394', `the speed field reads 394 FPM (got "${speed?.text}" "${speed?.unit}")`)
  const labels = await page.evaluate(() => [...document.querySelectorAll('.inspector .vector-field .field-label')].map((e) => e.textContent?.trim()))
  check(labels.includes('Position (in)'), `the Transform row names inches (got ${JSON.stringify(labels)})`)
  check((await page.locator('.inspector .prop-row[data-param="fpmUnits"]').count()) === 0, 'the conveyor offers no units switch of its own')

  // --- D: typed in inches, stored in metres ---
  const stand = page.locator('.inspector .prop-row[data-param="standHeight"] input.spin-input')
  const standShown = await readField(page, 'standHeight')
  check(standShown?.unit === 'in', `stand height shows inches (got "${standShown?.unit}")`)
  await stand.click()
  await stand.fill('48')
  await stand.press('Enter')
  await page.waitForTimeout(300)
  const h = (await paramsOf(page, 'b1'))?.standHeight
  check(typeof h === 'number' && Math.abs(h - 1.2192) < 1e-6, `48 typed into the inch field stores 1.2192 m (got ${h})`)

  // --- E: back to metric ---
  await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] }))
  await select.waitFor({ timeout: 10000 })
  await select.selectOption('metric')
  await page.waitForTimeout(200)
  const back = await paramsOf(page, 'b1')
  check(back?.fpmUnits === false && back?.speed === 2 && back?.speedTag === 'Line1Speed', `Metric converts it back exactly (speed ${back?.speed}, want 2; tag "${back?.speedTag}")`)
  await page.evaluate(() => window.__oip.store.select('b1'))
  await page.waitForSelector('.inspector .prop-row[data-param="speed"] input.spin-input', { timeout: 10000 })
  const m = await readField(page, 'speed')
  check(m?.unit === 'm/s', `the speed field reads m/s again (got "${m?.unit}")`)

  // --- F: Length mm shows lengths in millimetres and leaves conveyors as they are ---
  await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] }))
  const length = page.locator('[data-testid="scene-length"]')
  await length.waitFor({ timeout: 10000 })
  check((await length.inputValue()) === 'm', 'Length starts at meters')
  await length.selectOption('mm')
  await page.waitForTimeout(200)
  const mm = await paramsOf(page, 'b1')
  check(mm?.fpmUnits === false && mm?.speed === 2 && mm?.speedTag === 'Line1Speed', `Length mm leaves the conveyor in m/s (speed ${mm?.speed}, tag "${mm?.speedTag}")`)
  const saved = await page.evaluate(() => { const s = window.__oip.store.getState().scene; return [s.units, s.lengthUnit] })
  check(saved[0] === 'metric' && saved[1] === 'mm', `the scene saves Metric with Length mm (got ${JSON.stringify(saved)})`)
  await page.evaluate(() => window.__oip.store.select('b1'))
  await page.waitForSelector('.inspector .prop-row[data-param="standHeight"] input.spin-input', { timeout: 10000 })
  const standMm = await readField(page, 'standHeight')
  check(standMm?.unit === 'mm' && standMm?.text === '1219.2', `stand height reads 1219.2 mm (got "${standMm?.text}" "${standMm?.unit}")`)
  check((await readField(page, 'speed'))?.unit === 'm/s', 'the speed still reads m/s')
  const standMmInput = page.locator('.inspector .prop-row[data-param="standHeight"] input.spin-input')
  await standMmInput.click()
  await standMmInput.fill('800')
  await standMmInput.press('Enter')
  await page.waitForTimeout(300)
  const h2 = (await paramsOf(page, 'b1'))?.standHeight
  check(typeof h2 === 'number' && Math.abs(h2 - 0.8) < 1e-9, `800 typed into the mm field stores 0.8 m (got ${h2})`)

  // --- G: Imperial carries a Length of mm to inches, and a scene saved as 'metric-mm' opens in mm ---
  await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] }))
  await select.waitFor({ timeout: 10000 })
  await select.selectOption('imperial')
  await page.waitForTimeout(200)
  check((await length.inputValue()) === 'in', 'switching Speed to Imperial moves Length from mm to inches')
  const noteText = await page.locator('[data-testid="scene-units-note"]').textContent()
  check(/Lengths now show in Inches/.test(noteText ?? ''), `the note says lengths moved (got "${noteText}")`)
  await page.evaluate(() => window.__oip.store.select('b1'))
  await page.waitForSelector('.inspector .prop-row[data-param="speedFpm"] input.spin-input', { timeout: 10000 })
  check((await readField(page, 'speedFpm'))?.unit === 'FPM', 'the speed reads FPM')
  check((await readField(page, 'standHeight'))?.unit === 'in', 'and lengths read inches')
  const legacyErr = await page.evaluate(() =>
    window.__oip.loadSceneText(JSON.stringify({ version: window.__oip.store.getState().scene.version, parts: [], units: 'metric-mm' })),
  )
  await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] }))
  await select.waitFor({ timeout: 10000 })
  const legacy = [legacyErr, await select.inputValue(), await length.inputValue()]
  check(JSON.stringify(legacy) === '[null,"metric","mm"]', `a scene saved as 'metric-mm' opens as Metric with Length mm (got ${JSON.stringify(legacy)})`)
  check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (e) {
  console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`)
  failed = true
} finally {
  await browser.close()
  vite.kill()
}
console.log(failed ? 'FAILED' : 'PASS')
process.exit(failed ? 1 : 0)
