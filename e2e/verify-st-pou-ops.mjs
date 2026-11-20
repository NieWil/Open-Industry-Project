// The PLC panel's organizer as the program's list, not just an index: New / Rename / Delete, from the tree beside the
// code (components/plc/PlcOrganizer.tsx).
//
// document.test.ts covers the text transforms: that a new block compiles, that a rename reaches every reference
// and no comment text, that the program body cannot be deleted. Only a browser run can check that the gestures reach
// them: that "+ New" adds a block and opens its name field, that a renamed row carries its references with it, that
// the program in the store (what a reload restores and a room replicates) changed with the tree, and that Ctrl-Z
// restores it, since a structural edit must be undoable.
//
// It also checks the tree's Devices section: the scene's parts that use tags, their dialog and their rewire, in the
// PLC panel's organizer.
//
// The tree groups blocks by kind (Programs, Function Blocks, ...), so it does not show the order the file holds
// them in, and there is no drag to reorder.
// Run: node e2e/verify-st-pou-ops.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

// two POUs and a body, so there is something to rename and something to reference
const PROGRAM = `FUNCTION_BLOCK Latch
VAR_INPUT S : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := Q OR S;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Other
VAR_OUTPUT Q : BOOL; END_VAR
Q := FALSE;
END_FUNCTION_BLOCK

VAR_INPUT Start : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
VAR seal : Latch; END_VAR
seal(S := Start, Q => Motor);`

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function setDoc(page, text) {
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

/** The program as the store holds it: the copy a reload restores and a room replicates. */
const stored = (page) => page.evaluate(() => window.__oip?.store?.getState?.().stProgram ?? '')

const ROWS = '[data-testid="org-pou"], [data-testid="org-top"]'
/** The tree's block rows, top to bottom: the top-level code, then the groups. */
const rowNames = async (page) => (await page.locator(`:is(${ROWS}) .org-name`).allTextContents()).join(',')
/** The row lit as the block the reader is in. */
const litRows = async (page) => (await page.locator(`:is(${ROWS})[aria-current="location"] .org-name`).allTextContents()).join(',')
const row = (page, name) => page.locator(`:is(${ROWS})`).filter({ has: page.locator('.org-name', { hasText: new RegExp(`^${name}$`) }) })

/** Right-click the row called `name` and click a menu item by its test id. */
async function rowMenu(page, name, testid) {
  await row(page, name).click({ button: 'right' })
  await page.locator(`[data-testid="${testid}"]`).click()
  await page.waitForTimeout(250)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await showPlcEditor(page)
    await page.locator('[data-testid="plc-organizer"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForTimeout(800)

    await setDoc(page, PROGRAM)
    await page.waitForTimeout(600)
    check('the tree lists the program it was given', (await rowNames(page)) === 'Top-level code,Latch,Other', await rowNames(page))

    // ---- New: "+ New" adds a block and asks what it is called ----
    await page.locator('[data-testid="org-new"]').click()
    await page.locator('[data-testid="org-new-functionBlock"]').click()
    const nameField = page.locator('[data-testid="org-rename"]')
    await nameField.waitFor({ state: 'visible', timeout: 4000 })
    check('a new block opens straight into its name field', (await nameField.inputValue()) === 'Block1', await nameField.inputValue())
    // the field must have keyboard focus, not just be on screen: it opens in the same commit that
    // closes the menu, and a field you have to click before typing does not count as "opens into"
    check('and the field has the keyboard', await nameField.evaluate((el) => el === document.activeElement))
    await page.keyboard.type('Debounce')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    check('the name typed is the name kept', (await rowNames(page)) === 'Top-level code,Latch,Other,Debounce', await rowNames(page))
    const afterAdd = await stored(page)
    check('the new POU lands ABOVE the program body, where the grammar needs it',
      afterAdd.indexOf('FUNCTION_BLOCK Debounce') < afterAdd.indexOf('seal(S := Start'),
      `fb@${afterAdd.indexOf('FUNCTION_BLOCK Debounce')} body@${afterAdd.indexOf('seal(S := Start')}`)
    check('it compiles as it lands - no lint errors on a brand new block',
      (await page.locator('.cm-lintRange-error').count()) === 0)

    // ---- Rename: the declaration and every reference to it ----
    await rowMenu(page, 'Latch', 'org-rename-item')
    await nameField.waitFor({ state: 'visible', timeout: 4000 })
    check('the menu opens the same focused field', await nameField.evaluate((el) => el === document.activeElement))
    await page.keyboard.type('Interlock')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const renamed = await stored(page)
    // the Enter that commits it must type nothing: the commit focuses the code while Enter is still down, and a newline
    // typed there would be an edit of its own, which the next Ctrl-Z would undo instead of the rename
    const pureRename = afterAdd.replace(/\bLatch\b/g, 'Interlock')
    check('renaming changes nothing but the name - the Enter types nothing into the code', renamed === pureRename, 'extra chars=' + (renamed.length - pureRename.length))
    check('renaming a POU carries its references', renamed.includes('FUNCTION_BLOCK Interlock') && renamed.includes('seal : Interlock;'),
      renamed.slice(0, 60).replace(/\n/g, ' '))
    check('and nothing still names the old one', !/\bLatch\b/.test(renamed))
    check('the renamed program still compiles', (await page.locator('.cm-lintRange-error').count()) === 0)

    // A name the program already uses is refused, with a reason, before anything is applied.
    // IEC is case-insensitive, so the variable `seal` rules out a POU called `Seal`. The rename
    // is a token rewrite (no scope resolution), so accepting this would merge two identifiers.
    // F2 on the focused row is the keymap's rename (keymap.ts edit.rename), the scene tree's key too.
    await row(page, 'Other').focus()
    await page.keyboard.press('F2')
    await nameField.waitFor({ state: 'visible', timeout: 4000 })
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Seal')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(250)
    const note = (await page.locator('[data-testid="org-note"]').first().textContent().catch(() => '')) ?? ''
    check('F2 renames too, and a colliding name is refused with a reason', /already used/.test(note), note.slice(0, 60))
    check('and the program is untouched by the refusal', (await stored(page)) === renamed)
    // refused on Enter, the field stays open holding the draft; Escape is the way out
    check('the field stays open on a refusal', await nameField.isVisible())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)

    // ---- the program body is not a POU among POUs ----
    await row(page, 'Top-level code').click({ button: 'right' })
    await page.locator('.ctx-menu').waitFor({ state: 'visible', timeout: 4000 })
    check('the top-level code offers no Delete', (await page.locator('[data-testid="org-delete-item"]').count()) === 0)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // ---- Delete, and Ctrl-Z ----
    await rowMenu(page, 'Debounce', 'org-delete-item')
    await page.waitForTimeout(300)
    check('deleting a block drops it from the tree', (await rowNames(page)) === 'Top-level code,Interlock,Other', await rowNames(page))
    check('and from the program', !(await stored(page)).includes('Debounce'))
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)
    check('Ctrl-Z puts a deleted block back - a structural edit is an ordinary edit',
      (await stored(page)).includes('FUNCTION_BLOCK Debounce'), await rowNames(page))

    // The Delete key on a focused row deletes the block and nothing else: the app's own keydown listens on the window,
    // where a Delete that propagated would delete the selected scene part as well.
    const partsBefore = await page.evaluate(() => {
      const s = window.__oip.store
      const scene = s.getState().scene
      s.commit('a part to keep', { ...scene, parts: [...scene.parts, { id: 'keep', type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} }] })
      s.select('keep')
      return s.getState().scene.parts.length
    })
    await page.waitForTimeout(500)
    await row(page, 'Debounce').focus()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(500)
    const partsAfter = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    check('the Delete key on a row deletes that block', !(await stored(page)).includes('Debounce'), await rowNames(page))
    check('...and not the part selected in the scene', partsAfter === partsBefore, `${partsBefore} -> ${partsAfter}`)

    // ---- New PROGRAM: the name first, then the PROGRAM and the task row that runs it, as one step ----
    // (controllerCommit.commitProgramAddition). Adding "Program1" and renaming it after would be two undo steps, the
    // second renaming an instance made a moment before.
    const beforeProgram = await stored(page)
    await page.locator('[data-testid="org-new"]').click()
    await page.locator('[data-testid="org-new-programPou"]').click()
    const programField = page.locator('[data-testid="org-new-program-name"]')
    await programField.waitFor({ state: 'visible', timeout: 4000 })
    await page.waitForTimeout(150)
    check('"+ New > Structured Text program" asks for a name, with the keyboard in the field', await programField.evaluate((el) => el === document.activeElement))
    const draftLang = await page.locator('[data-testid="org-new-program-lang"]').textContent().catch(() => null)
    check('...and the field says the program being named is Structured Text', draftLang === 'ST', draftLang)
    check('...and adds nothing until it has one', (await stored(page)) === beforeProgram)
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Seal')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(250)
    const programNote = (await page.locator('[data-testid="org-note"]').first().textContent().catch(() => '')) ?? ''
    check('a name the code already uses is refused, with a reason, and the field stays open',
      /already used/.test(programNote) && (await programField.isVisible()) && (await stored(page)) === beforeProgram, programNote.slice(0, 60))
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Sorter')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    const withProgram = await page.evaluate(() => {
      const s = window.__oip.store.getState()
      return { source: s.stProgram, programs: s.controller?.programs ?? null }
    })
    check('Enter adds the PROGRAM under that name', withProgram.source.includes('PROGRAM Sorter') && (await rowNames(page)).includes('Sorter'), await rowNames(page))
    check('...with a row running it on the task',
      JSON.stringify(withProgram.programs?.at(-1)) === JSON.stringify({ name: 'Sorter', type: 'Sorter', task: 'MainTask' }), JSON.stringify(withProgram.programs))
    check('...which the tree shows under that task',
      (await page.locator('[data-testid="org-task"][data-task="MainTask"] [data-testid="org-program"][data-program="Sorter"]').count()) === 1)
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)
    const undoneProgram = await page.evaluate(() => {
      const s = window.__oip.store.getState()
      return { source: s.stProgram, controller: s.controller }
    })
    check('ONE Ctrl-Z takes back the PROGRAM and its row together',
      undoneProgram.source === beforeProgram && undoneProgram.controller === null, 'controller=' + JSON.stringify(undoneProgram.controller))

    // ---- the row you are in is lit, and only that one ----
    // The lit row follows the cursor while it is on screen, else the top of the view.
    const filler = (tag) => Array.from({ length: 60 }, (_, k) => `(* ${tag} note ${k} *)`).join('\n')
    await setDoc(page, `FUNCTION_BLOCK Alpha\n${filler('alpha')}\nEND_FUNCTION_BLOCK\n\nFUNCTION_BLOCK Beta\n${filler('beta')}\nEND_FUNCTION_BLOCK\n\nVAR_INPUT X : BOOL; END_VAR\nX := X;`)
    await page.waitForTimeout(600)
    check('the row of the block the cursor is in is lit (typing ends in the body)', (await litRows(page)) === 'Top-level code', await litRows(page))
    await row(page, 'Alpha').click()
    await page.waitForTimeout(300)
    check('opening a row lights that row, and only that one', (await litRows(page)) === 'Alpha', await litRows(page))
    // scrolling takes the cursor off screen without moving it, so the top of the view decides
    await page.evaluate(() => {
      const sc = document.querySelector('.cm-content')?.closest('.cm-scroller')
      if (sc) sc.scrollTop = sc.scrollHeight * 0.6
    })
    await page.waitForTimeout(300)
    check('scrolling the cursor away lights the block at the top of the view', (await litRows(page)) === 'Beta', await litRows(page))
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+End')
    await page.waitForTimeout(300)
    check('moving the cursor lights its block again', (await litRows(page)) === 'Top-level code', await litRows(page))

    // ---- Devices: the scene's parts that use tags, in the organizer tree ----
    // The section is the tree's (components/plc/OrganizerTree.tsx): it is what the scene offers the program, so an
    // unwired part can be seen from the panel.
    await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
    await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      st.commit('Add devices', { ...scene, parts: [...scene.parts,
        { id: 'b1', type: 'part', name: 'Belt_1', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'B_R_1' } },
        { id: 's1', type: 'part', name: 'Sensor_1', packageId: 'oip.diffuse-sensor', position: [3, 0.75, 0], rotationY: 0, params: { maxRange: 1.2, tag: 'S_1' } },
      ] })
    })
    await page.waitForTimeout(500)
    const org = page.locator('[data-testid="plc-organizer"]')
    const kinds = await org.locator('[data-testid="org-device-kind"] .org-title').allTextContents()
    check('the IEC tree has a Devices section, grouped by kind', kinds.join(',') === 'Belt Conveyor,Photo Eye', kinds.join(','))
    check('a kind starts folded', (await org.locator('[data-testid="org-device"]').count()) === 0)
    for (const head of await org.locator('[data-testid="org-device-kind"] > .org-head').all()) await head.click()
    check('one belt and one sensor', (await org.locator('[data-testid="org-device"]').count()) === 2)
    await org.locator('[data-testid="org-device"]').first().click()
    check('clicking a device selects it in the scene', (await page.evaluate(() => window.__oip.store.getState().selectedIds)).join() === 'b1')
    await org.locator('[data-testid="org-device"]').first().locator('[data-testid="org-device-tags"]').click()
    const dlg = page.locator('[data-testid="device-tags-dialog"]')
    await dlg.waitFor({ state: 'visible', timeout: 30000 })
    check('its tags open over the tree', (await dlg.locator('[data-testid="device-tag-runTag"]').inputValue()) === 'B_R_1')
    await dlg.locator('[data-testid="device-tag-runningTag"]').fill('B_RN_1')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    check('typing a tag there rewires the part', (await page.evaluate(() => window.__oip.store.getState().scene.parts.find((x) => x.id === 'b1').params.runningTag)) === 'B_RN_1')
    // the dialog reads the current part, not the one captured when it opened: the row it just wrote comes back
    check('and the dialog shows what it wrote', (await dlg.locator('[data-testid="device-tag-runningTag"]').inputValue()) === 'B_RN_1')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    const pageErrs = errors.filter((e) => !/favicon|manifest/i.test(e))
    check('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
