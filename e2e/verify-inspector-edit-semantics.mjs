// Verify the Inspector only writes what the user actually asked it to write, and that its popups own the keys.
//
// Every bug this gates changed the document without the user editing anything, or wrote an edit somewhere
// it didn't belong, and none of them threw:
//   A. Clicking into a number field and out again committed the rounded display text (a position of
//      1.23456 became 1.235) plus an undo entry. A mixed text field went further: focus + blur wrote ''
//      into every selected part.
//   B. ArrowUp/Down in a focused field moved the stored value but not the text, so Enter wrote the old
//      text back and undid the steps. Stepping also stored float noise (1.2000000000000002).
//   C. Escape "cancelled" by committing the typed text (2*1.5 -> 3), and a plain number typed before it
//      had already been saved keystroke by keystroke, so there was nothing to go back to. Malformed text
//      ("2 3") was half-read as 2. Typing writes nothing until it is confirmed; a unit in the label is
//      the field's suffix and a typed length in feet converts.
//   D. Escape on the property context menu also reached the controller, which deselected the part. The
//      menu's state survived, so it came back on the next selection holding the old part's closures and
//      the old scene: its Revert rolled back every edit made in between.
//   E. Every SDK part is type 'part', so a conveyor + a sensor passed the "single type" check and the
//      sensor got the conveyor's params written into it.
//   F. A multi-selection whose tables differ showed the first part's table, and editing one cell wrote
//      that whole table into every selected part.
//   G. Paste Property wrote the raw clipboard: a speed of 3 into a height capped at 0.6, a colour into a
//      dropdown. A mixed field copied the first part's value.
//   H. A tag field committed (and persisted the whole project) on every keystroke, and a mixed one showed
//      the first part's tag.
//   I. Keys pressed with a popup open reached the controller: Delete removed the part behind the menu.
//      Right-clicking a colour preset also opened the property menu underneath it.
//   J. The header read "Part" with a generic slab for every SDK part.
//   K. A table showed two decimals whatever its values, and its row folds did nothing.
//   M. Joint limits could cross (min above max).
//   N. The browser part panel said the script needed the desktop app, though the in-app editor works.
//   O. A multi-selection had no Transform, so "move these 1200 mm east" meant one absolute edit per part. Its
//      fields are mixed where the parts differ; "+= 1200mm" offsets each part and "+= 90" in Y turns the group.
// Run: node e2e/verify-inspector-edit-semantics.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const POS_X = '.vector-field .axis-x .spin-input >> nth=0'
const SPEED = '.prop-row[data-param="speed"] .spin-input'
const label = (key) => `.prop-row[data-param="${key}"] .field-label`
const TEXT = '.prop-row[data-param="text"] input'
const TAG = '.prop-row[data-param="speedTag"] input'

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  // a missing field fails its check without stalling the gate on the 30 s default; the scene is heavy enough
  // (software WebGL, a jointed rig) that a busy machine needs more than a few seconds per action
  page.setDefaultTimeout(20000)
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  const waitForApp = () => page.waitForFunction(
    () => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), null, { timeout: 30000 })
  const settle = () => page.waitForTimeout(250)
  const part = (id) => page.evaluate((i) => window.__oip.store.getState().scene.parts.find((p) => p.id === i), id)
  const history = () => page.evaluate(() => window.__oip.store.getEditHistory().cursor)
  const selection = () => page.evaluate(() => window.__oip.store.getState().selectedIds.join(','))
  const select = async (...ids) => {
    await page.evaluate((x) => (x.length === 1 ? window.__oip.store.select(x[0]) : window.__oip.store.selectMany(x)), ids)
    await page.waitForTimeout(400)
  }
  const blur = async () => { await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur()); await settle() }
  const fieldText = (sel) => page.$eval(sel, (e) => /** @type {HTMLInputElement} */ (e).value)
  const exists = async (sel) => (await page.$(sel)) !== null
  const focusedText = () => page.evaluate(() => document.activeElement?.textContent ?? '')
  // a direct commit of one part's fields: stands in for any edit made outside the field under test
  const patch = (id, fields) => page.evaluate(({ id, fields }) => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('test setup', { ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, ...fields } : p)) })
  }, { id, fields })
  const setParams = async (id, params) => {
    const p = await part(id)
    await patch(id, { params: { ...p.params, ...params } })
    await settle()
  }
  const setSpeed = (id, speed) => setParams(id, { speed })
  const menuItem = async (text) => {
    for (const it of await page.$$('.ctx-menu .ctx-item')) if ((await it.textContent()) === text) return it
    return null
  }
  const menuClick = async (text) => {
    const it = await menuItem(text)
    if (!it || (await it.isDisabled())) return false
    await it.click()
    return true
  }
  const menuEnabled = async (text) => {
    const it = await menuItem(text)
    return it ? !(await it.isDisabled()) : null
  }
  const openMenu = async (key) => {
    await page.click(label(key), { button: 'right' })
    await settle()
  }
  const closeMenu = async () => {
    if (await exists('.ctx-menu')) { await page.keyboard.press('Escape'); await settle() }
  }
  // count store commits from here on (every commit persists the whole project)
  const countCommits = () => page.evaluate(() => {
    const st = window.__oip.store
    const w = /** @type {any} */ (window)
    w.__commits = 0
    if (!w.__commitWrapped) {
      const orig = st.commit.bind(st)
      st.commit = (...a) => { w.__commits++; return orig(...a) }
      w.__commitWrapped = true
    }
  })
  const commits = () => page.evaluate(() => /** @type {any} */ (window).__commits)

  try {
    await page.goto(URL)
    await waitForApp()
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp()
    await page.waitForTimeout(800)

    const loaded = await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState()
      const want = ['oip.belt-conveyor', 'oip.diffuse-sensor', 'oip.safety-gate']
      const pkgs = want.map((id) => s.bundledPackages.find((p) => p.id === id))
      if (pkgs.some((p) => !p)) return false
      // fpmUnits: false pins the conveyor to metres per second, which is what every speed expectation
      // below is written in. The belt defaults to FPM, and the m/s Speed + `speedTag` rows are
      // `visibleWhen fpmUnits is false`, so on the default the script would wait for a row the Inspector
      // rightly doesn't render, and time out mid-run without a verdict.
      const belt = (id, z, params) => ({ id, type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, z], rotationY: 0, params: { fpmUnits: false, ...params } })
      const note = (id, z, text) => ({ id, type: 'annotation', position: [4, 1.2, z], rotationY: 0, params: { text } })
      const parts = [
        { ...belt('b1', 0, { segments: [[4, 0]], speed: 1.25, beltColor: '#ff0000' }), position: [1.23456, 0, 0] },
        belt('b2', 3, { segments: [[2, 0], [3, 12], [2, -12]], speed: 1, speedTag: 'B' }),
        belt('b3', 6, { segments: [[4, 0]], speed: 1 }),
        // host-written precision: a guard opening measured to the millimetre
        belt('b4', 12, { segments: [[4, 0]], speed: 1, guardOpenings: [[0.125, 1.5, 1]] }),
        { id: 's1', type: 'part', packageId: 'oip.diffuse-sensor', position: [0, 1, 9], rotationY: 0, params: {} },
        { id: 'g1', type: 'part', packageId: 'oip.safety-gate', position: [6, 0, 9], rotationY: 0, params: {} },
        note('n1', 0, 'Alpha'),
        note('n2', 3, 'Beta'),
      ]
      st.loadScene({ ...s.scene, parts, packages: [...(s.scene.packages ?? []).filter((p) => !want.includes(p.id)), ...pkgs] })
      return true
    })
    check('belt + diffuse sensor + safety gate packages available', loaded)
    // a cold dev server takes a while to lift the loading cover; wait on the positive signal, not a guess
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 }).catch(() => {})
    await page.waitForTimeout(500)

    // ── A. an untouched field is never rewritten ──
    await select('b1')
    let h0 = await history()
    await page.click(POS_X, { timeout: 60000 }); await settle(); await blur() // the first click may still wait out the cover
    check('A1 focus + blur leaves Position X exactly as authored', (await part('b1')).position[0] === 1.23456, `x=${(await part('b1')).position[0]}`)
    check('A1 ... and takes no undo entry', (await history()) === h0, `history ${h0} -> ${await history()}`)
    h0 = await history()
    await page.click(SPEED); await settle(); await blur()
    check('A2 focus + blur leaves Speed 1.25 unrounded', (await part('b1')).params.speed === 1.25, `speed=${(await part('b1')).params.speed}`)
    check('A2 ... and takes no undo entry', (await history()) === h0, `history ${h0} -> ${await history()}`)
    await select('n1')
    h0 = await history()
    await page.click(TEXT); await settle(); await blur()
    check('A3 focus + blur on a text param takes no undo entry', (await history()) === h0, `history ${h0} -> ${await history()}`)
    await select('n1', 'n2')
    await page.click(TEXT); await settle(); await blur()
    const texts = [(await part('n1')).params.text, (await part('n2')).params.text]
    check('A4 focus + blur on a MIXED text field wipes nothing', texts[0] === 'Alpha' && texts[1] === 'Beta', JSON.stringify(texts))

    // ── B. arrow keys in a focused field stick, on the grid ──
    await setSpeed('b1', 1)
    await select('b1')
    await page.click(SPEED); await settle()
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await settle()
    check('B1 two ArrowUps store exactly 1.2 (no float noise)', (await part('b1')).params.speed === 1.2, `speed=${(await part('b1')).params.speed}`)
    check('B1 ... and the field shows it', (await fieldText(SPEED)) === '1.2', `text=${await fieldText(SPEED)}`)
    await page.keyboard.press('Enter'); await settle()
    check('B2 Enter keeps the stepped value', (await part('b1')).params.speed === 1.2, `speed=${(await part('b1')).params.speed}`)

    // ── C. Escape cancels; malformed text commits nothing ──
    await page.click(SPEED); await settle()
    await page.keyboard.press('Control+A'); await page.keyboard.type('2*1.5'); await page.keyboard.press('Escape'); await settle()
    check('C1 Escape after typing an expression commits nothing', (await part('b1')).params.speed === 1.2, `speed=${(await part('b1')).params.speed}`)
    check('C1 ... and restores the field text', (await fieldText(SPEED)) === '1.2', `text=${await fieldText(SPEED)}`)
    await page.click(SPEED); await settle()
    await page.keyboard.press('Control+A'); await page.keyboard.type('0.5'); await settle()
    // typing only edits the text: "12" must never build a 1 first, so nothing lands until Enter / Tab / blur
    check('C2 a typed number writes nothing until it is confirmed', (await part('b1')).params.speed === 1.2, `speed=${(await part('b1')).params.speed}`)
    await page.keyboard.press('Escape'); await settle()
    check('C2 Escape leaves the pre-edit value', (await part('b1')).params.speed === 1.2, `speed=${(await part('b1')).params.speed}`)
    check('C2 ... and the field shows it', (await fieldText(SPEED)) === '1.2', `text=${await fieldText(SPEED)}`)
    check('C3 Escape in a field keeps the selection', (await selection()) === 'b1', `selection=${await selection()}`)
    await page.click(SPEED); await settle()
    await page.keyboard.press('Control+A'); await page.keyboard.type('2 3'); await page.keyboard.press('Enter'); await settle()
    // confirming text that doesn't parse writes nothing
    check('C6 malformed text ("2 3") leaves the value as it was', (await part('b1')).params.speed === 1.2, `speed=${(await part('b1')).params.speed}`)
    check('C6 ... and the field shows it', (await fieldText(SPEED)) === '1.2', `text=${await fieldText(SPEED)}`)

    // mixed number field: nothing is written until the edit is confirmed, and Escape writes nothing at all
    await select('b1', 'b3') // speeds 1.2 vs 1
    await page.click(SPEED); await settle()
    await page.keyboard.type('0.3'); await settle()
    const midTyping = [(await part('b1')).params.speed, (await part('b3')).params.speed]
    check('C4 typing into a MIXED field does not write every part per keystroke', midTyping[0] === 1.2 && midTyping[1] === 1, JSON.stringify(midTyping))
    await page.keyboard.press('Escape'); await settle()
    const afterEsc = [(await part('b1')).params.speed, (await part('b3')).params.speed]
    check('C4 Escape leaves both mixed values alone', afterEsc[0] === 1.2 && afterEsc[1] === 1, JSON.stringify(afterEsc))
    await page.click(SPEED); await settle()
    await page.keyboard.type('0.8'); await page.keyboard.press('Enter'); await settle()
    const afterEnter = [(await part('b1')).params.speed, (await part('b3')).params.speed]
    check('C5 Enter writes the typed value to every selected part', afterEnter[0] === 0.8 && afterEnter[1] === 0.8, JSON.stringify(afterEnter))

    // a unit named in the label is the field's suffix, and a length typed in feet is stored in metres
    await select('b1')
    const WIDTH = '.prop-row[data-param="width"] .spin-input'
    const widthUnit = await page.$eval('.prop-row[data-param="width"] .spin-unit', (e) => e.textContent).catch(() => null)
    check('C7 Width shows its unit as a suffix', widthUnit === 'm', `suffix=${widthUnit}`)
    await page.click(WIDTH); await settle()
    await page.keyboard.press('Control+A'); await page.keyboard.type('4ft'); await page.keyboard.press('Enter'); await settle()
    check('C7 "4ft" typed into Width lands as 1.2192 m', Math.abs((await part('b1')).params.width - 1.2192) < 1e-9, `width=${(await part('b1')).params.width}`)
    await setParams('b1', { width: 1.524 }) // back to the fixture, for the checks below

    // ── D. the property context menu ──
    await setSpeed('b1', 1.2)
    await select('b1')
    await openMenu('speed')
    check('D1 right-click opens the property menu', await exists('.ctx-menu[role="menu"]'))
    await page.keyboard.press('Escape'); await settle()
    check('D1 Escape closes it', !(await exists('.ctx-menu')))
    check('D1 ... and keeps the selection', (await selection()) === 'b1', `selection=${await selection()}`)
    await openMenu('speed')
    await select('s1')
    check('D2 a menu never survives a selection change', !(await exists('.ctx-menu')))
    await select('b1')
    check('D2 ... not even back to the part it was opened on', !(await exists('.ctx-menu')))
    await openMenu('speed')
    await patch('s1', { position: [9, 1, 9] }) // an edit landing while the menu is open (a collab peer, say)
    await settle()
    check('D3 Revert to Default is offered', await menuClick('Revert to Default'))
    await settle()
    check('D3 the menu acts on the CURRENT scene: the edit made while it was open survives',
      JSON.stringify((await part('s1')).position) === '[9,1,9]', `s1=${JSON.stringify((await part('s1')).position)}`)
    check('D3 ... and the revert itself landed', (await part('b1')).params.speed === 2, `speed=${(await part('b1')).params.speed}`)
    await page.click('.prop-row[data-param="beltColor"] .field-color-btn'); await settle()
    check('D4 the colour picker opens as a dialog', await exists('.color-popup[role="dialog"]'))
    await page.keyboard.press('Escape'); await settle()
    check('D4 Escape closes the colour picker', !(await exists('.color-popup')))
    check('D4 ... and keeps the selection', (await selection()) === 'b1', `selection=${await selection()}`)

    // ── E. parts from different packages ──
    await select('b1', 's1')
    check('E1 a belt + a sensor show no shared fields', !(await exists(SPEED)))
    const hint = await page.$$eval('.inspector .inspector-hint', (els) => els.map((e) => e.textContent).join(' | '))
    check('E1 ... and say why', /single type/.test(hint), hint)
    check('E2 the sensor never received a speed', (await part('s1')).params.speed === undefined)

    // ── F. tables across a multi-selection ──
    await select('b1', 'b2')
    const segRow = '.prop-row[data-param="segments"]'
    check('F1 differing Segments show as mixed', await exists(`${segRow} .field-mixed-note`))
    check('F1 ... with no editable cell that would overwrite them', !(await exists(`${segRow} .spin-input`)))
    check('F1 the second belt kept its Z-frame', JSON.stringify((await part('b2')).params.segments) === '[[2,0],[3,12],[2,-12]]',
      JSON.stringify((await part('b2')).params.segments))
    await select('b1', 'b3') // identical tables: a shared edit is well defined
    check('F2 equal Segments stay editable', await exists(`${segRow} .spin-input`))
    await page.click(`${segRow} .spin-input`); await settle()
    await page.keyboard.press('Control+A'); await page.keyboard.type('5'); await page.keyboard.press('Enter'); await settle()
    const segs = [(await part('b1')).params.segments, (await part('b3')).params.segments].map((s) => JSON.stringify(s))
    check('F2 ... and a cell edit reaches both', segs[0] === '[[5,0]]' && segs[1] === '[[5,0]]', segs.join(' / '))

    // ── G. Paste Property goes through the field's own rules ──
    await setParams('b1', { speed: 3, height: 0.5 })
    await select('b1')
    await openMenu('speed')
    await menuClick('Copy Property'); await settle()
    await openMenu('height')
    check('G1 a number pastes into another number field', (await menuEnabled('Paste Property')) === true)
    await menuClick('Paste Property'); await settle()
    check('G1 ... clamped to that field\'s max (3 into a 0.6 height)', (await part('b1')).params.height === 0.6, `height=${(await part('b1')).params.height}`)
    await openMenu('beltColor')
    await menuClick('Copy Property'); await settle()
    await openMenu('shapePreset')
    check('G2 a colour cannot paste into a dropdown', (await menuEnabled('Paste Property')) === false)
    await closeMenu()
    await select('b1', 'b3') // speeds 3 vs 0.8
    await openMenu('speed')
    check('G3 a mixed field has nothing single to copy', (await menuEnabled('Copy Property')) === false)
    await closeMenu()

    // ── H. the tag field commits once ──
    await select('b1')
    await countCommits()
    await page.click(TAG); await settle()
    await page.keyboard.press('Control+A'); await page.keyboard.type('Motor1Speed'); await settle()
    check('H1 typing a tag commits nothing yet', (await commits()) === 0 && (await part('b1')).params.speedTag !== 'Motor1Speed',
      `commits=${await commits()}`)
    await page.keyboard.press('Enter'); await settle()
    check('H1 Enter commits it once', (await commits()) === 1 && (await part('b1')).params.speedTag === 'Motor1Speed',
      `commits=${await commits()} tag=${(await part('b1')).params.speedTag}`)
    await page.click(TAG); await settle()
    // typing opens the tag field's suggestions; one Escape cancels the edit as in any field, closing them with it (a
    // press that only closed them would leave the edit for the next click elsewhere to commit)
    await page.keyboard.press('Control+A'); await page.keyboard.type('Other'); await page.keyboard.press('Escape'); await settle()
    check('H2 one Escape in a tag field cancels the edit and closes its suggestions', (await part('b1')).params.speedTag === 'Motor1Speed' && (await fieldText(TAG)) === 'Motor1Speed' && (await page.locator('[data-testid="tag-suggest"]').count()) === 0,
      `tag=${(await part('b1')).params.speedTag} text=${await fieldText(TAG)} open=${await page.locator('[data-testid="tag-suggest"]').count()}`)
    // with nothing typed there is no edit: Escape only closes the list, and the field keeps its value and its focus
    await page.click(TAG); await settle()
    await page.keyboard.press('Escape'); await settle()
    check('H2 with nothing typed, Escape only closes the suggestions', (await page.locator('[data-testid="tag-suggest"]').count()) === 0 && (await fieldText(TAG)) === 'Motor1Speed' && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'tag-field',
      `open=${await page.locator('[data-testid="tag-suggest"]').count()} text=${await fieldText(TAG)}`)
    await blur()
    await select('b1', 'b2') // Motor1Speed vs B
    const mixedTag = await page.$eval(TAG, (e) => ({ value: /** @type {HTMLInputElement} */ (e).value, placeholder: /** @type {HTMLInputElement} */ (e).placeholder }))
    // (the placeholder is every mixed field's, `--`: the UI writes no em dash)
    check('H3 a mixed tag field shows blank, not the first part\'s tag', mixedTag.value === '' && mixedTag.placeholder === '--', JSON.stringify(mixedTag))

    // ── I. keys belong to an open popup ──
    await select('b1')
    await openMenu('speed')
    check('I1 the menu takes focus on its first item', (await focusedText()) === 'Copy Property', `focused=${await focusedText()}`)
    // the last enabled item is the whole part's Copy Properties (Paste Properties is off with nothing copied)
    await page.keyboard.press('End'); await settle()
    check('I1 End moves to the last item', (await focusedText()) === 'Copy Properties', `focused=${await focusedText()}`)
    await page.keyboard.press('ArrowUp'); await settle()
    check('I1 ArrowUp steps back over the separator', (await focusedText()) === 'Revert to Default', `focused=${await focusedText()}`)
    await page.keyboard.press('Delete'); await settle()
    check('I2 Delete with the menu open does not delete the part', (await part('b1')) !== undefined && (await exists('.ctx-menu')))
    await page.keyboard.press('Enter'); await settle()
    check('I3 Enter activates the focused item', (await part('b1')).params.speed === 2 && !(await exists('.ctx-menu')),
      `speed=${(await part('b1')).params.speed}`)
    await page.evaluate(() => localStorage.removeItem('oip-web/colorrecents'))
    await page.click('.prop-row[data-param="beltColor"] .field-color-btn'); await settle()
    await page.keyboard.press('Backspace'); await settle()
    check('I4 Backspace inside the colour picker does not delete the part', (await part('b1')) !== undefined)
    await page.keyboard.press('Escape'); await settle()
    check('I5 opening and closing the picker records no recent colour', (await page.evaluate(() => localStorage.getItem('oip-web/colorrecents'))) === null)
    await page.click('.prop-row[data-param="beltColor"] .field-color-btn'); await settle()
    await page.click('.color-preset-add'); await settle()
    await page.click('.color-swatches .color-recent', { button: 'right' }); await settle()
    check('I6 right-clicking a preset opens no property menu under the picker', !(await exists('.ctx-menu')) && (await exists('.color-popup')))
    await page.keyboard.press('Escape'); await settle()
    const unnamed = await page.$$eval('.inspector button', (bs) =>
      bs.filter((b) => !/[A-Za-z0-9]/.test(b.textContent ?? '') && !b.getAttribute('aria-label')).map((b) => b.className))
    check('I7 every glyph-only inspector button has an accessible name', unnamed.length === 0, unnamed.join(', '))

    // ── J. the header names the part ──
    await select('b1')
    const head = await page.$eval('.inspector-category', (e) => ({
      name: e.querySelector('.inspector-category-name')?.textContent,
      src: e.querySelector('img')?.getAttribute('src') ?? '',
    }))
    check('J1 the header names the package', head.name === 'Belt Conveyor', JSON.stringify(head))
    check('J1 ... with its own card image', /\/thumbnails\/pkg\/|^data:|^blob:/.test(head.src), head.src)
    await select('b1', 'b3')
    check('J2 a same-package multi-selection counts it', (await page.$eval('.inspector-category-name', (e) => e.textContent)) === 'Belt Conveyor (2)')

    // ── K. tables show what they hold ──
    await select('b4')
    const guardRow = '.prop-row[data-param="guardOpenings"]'
    const cells = await page.$$eval(`${guardRow} .spin-input`, (els) => els.map((e) => /** @type {HTMLInputElement} */ (e).value))
    check('K1 a host-written 0.125 m reads 0.125, not 0.13', cells[0] === '0.125', JSON.stringify(cells))
    await page.click(`${guardRow} .array-elem-toggle`); await settle()
    check('K2 a table row folds', !(await exists(`${guardRow} .array-elem-body`)))
    await page.click(`${guardRow} .array-elem-toggle`); await settle()
    check('K2 ... and unfolds', await exists(`${guardRow} .array-elem-body`))

    // ── M. joint limits never cross ──
    await page.evaluate(() => window.__oip.store.selectRigNode('g1', 'hinge'))
    await page.waitForTimeout(400)
    const minField = page.locator('.inspector .field', { has: page.locator('.field-label', { hasText: /^Min$/ }) }).locator('.spin-input')
    check('M1 the rig node panel shows the hinge', (await minField.count()) === 1)
    if ((await minField.count()) === 1) {
      check('M1 a joint limit shows a decimal (-180.5 deg, not -180)', (await minField.inputValue()) === '-180.5', await minField.inputValue())
      await minField.click(); await settle()
      await page.keyboard.press('Control+A'); await page.keyboard.type('200'); await page.keyboard.press('Enter'); await settle()
      const joint = await page.evaluate(() => {
        const g = window.__oip.getPackage('oip.safety-gate')?.geometry
        return g && g.kind === 'rig' ? g.joints.find((j) => j.link === 'hinge') : null
      })
      check('M2 a min typed above the max stops at the max', !!joint && joint.min === joint.max, JSON.stringify(joint))
    }

    // ── N. the browser part panel opens the in-app behavior editor ──
    await select('b1')
    const editBtn = page.locator('.inspector-head-action[aria-label^="Edit Behavior"]')
    check('N1 the browser part panel offers Edit behavior', (await editBtn.count()) === 1)
    if ((await editBtn.count()) === 1) {
      await editBtn.click(); await settle()
      check('N1 ... which opens the editor on this package',
        (await page.evaluate(() => window.__oip.store.getState().behaviorEditTarget)) === 'oip.belt-conveyor')
      await page.evaluate(() => window.__oip.store.closeBehaviorEditor())
    }

    // ── O. typed offsets on a selection ──
    await patch('b1', { position: [1.25, 0, 0], rotationY: 0 })
    await patch('b3', { position: [0, 0, 6], rotationY: 0 })
    await settle()
    await select('b1', 'b3')
    const posX = page.locator('.vector-field').nth(0).locator('.axis-x .spin-input')
    const rotY = page.locator('.vector-field').nth(1).locator('.axis-y .spin-input')
    check('O1 a multi-selection shows Position', (await posX.count()) === 1)
    check('O1 ... mixed where the parts differ', (await posX.inputValue()) === '' && (await posX.getAttribute('placeholder')) === '--')
    h0 = await history()
    await posX.click(); await settle()
    await page.keyboard.type('+= 1200mm'); await page.keyboard.press('Enter'); await settle()
    const xs = [(await part('b1')).position[0], (await part('b3')).position[0]]
    check('O2 "+= 1200mm" moves each part 1.2 m along X', Math.abs(xs[0] - 2.45) < 1e-9 && Math.abs(xs[1] - 1.2) < 1e-9, JSON.stringify(xs))
    check('O2 ... in one undo step', (await history()) === h0 + 1, `history ${h0} -> ${await history()}`)
    const gap = async () => { const a = await part('b1'); const b = await part('b3'); return Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) }
    const gap0 = await gap()
    await rotY.click(); await settle()
    await page.keyboard.type('+= 90'); await page.keyboard.press('Enter'); await settle()
    const yaws = [(await part('b1')).rotationY, (await part('b3')).rotationY]
    check('O3 "+= 90" in Rotation Y turns both parts', yaws.every((y) => Math.abs(y - Math.PI / 2) < 1e-9), JSON.stringify(yaws))
    check('O3 ... as one rigid group', Math.abs((await gap()) - gap0) < 1e-9, `gap ${gap0} -> ${await gap()}`)
    await select('b1')
    await posX.click(); await settle()
    await page.keyboard.press('Control+A'); await page.keyboard.type('-5'); await page.keyboard.press('Enter'); await settle()
    check('O4 a plain "-5" stays an absolute value', (await part('b1')).position[0] === -5, `x=${(await part('b1')).position[0]}`)
    await select('b1', 's1')
    check('O5 parts of different packages still share the Transform', (await posX.count()) === 1)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
