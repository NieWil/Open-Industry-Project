// Verifies the keymap seam (src/core/keymap.ts) end to end in a real browser:
//   - the editor tool/snap/view shortcuts fire through the resolver (action ids, not e.key compared
//     inline)
//   - spatial keys resolve by physical key: a synthesized AZERTY press (code KeyW, key 'z')
//     selects the Move tool, which an e.key comparison would miss
//   - Ctrl+Z stays logical (the printed Z), the way every desktop app binds undo
//   - free fly: boost + move together, and every keydown gets its keyup. Regression guard:
//     strict modifier matching makes W unresponsive while Shift boosts, and swallows the keyup
//     of a key released while Shift is still down, leaving the camera flying forever.
//   - the shortcuts reference opens on Shift+/ and lists the table
// Run: node e2e/verify-keymap.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

async function waitForApp(page) {
  await page.waitForFunction(
    () => {
      const h = window.__oip
      return !!(h && h.store && h.view && h.controller && h.sim)
    },
    { timeout: 20000 },
  )
}

const tool = (page) => page.evaluate(() => window.__oip.store.getState().tool)
const pose = (page) => page.evaluate(() => window.__oip.view.cameraPose())
const dist = (a, b) => Math.hypot(a.px - b.px, a.py - b.py, a.pz - b.pz)

/** press a key by physical code with an explicit legend - how a non-QWERTY layout reports it */
async function pressPhysical(client, { code, key }) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, text: key.length === 1 ? key : undefined })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key })
}

// the default scene is empty - place an SDK Box (verify-ortho-projection's proven flow) so the
// undo check asserts a real scene change
async function placeBox(page) {
  await page.locator('button.catalog-tab', { hasText: /^Products$/ }).click()
  await page.waitForTimeout(150)
  await page
    .locator('button.catalog-card-main')
    .filter({ has: page.locator('.catalog-card-label', { hasText: /^Box$/ }) })
    .click()
  const c = await page.evaluate(() => window.__oip.view.worldToScreen(0.5, 0, 0))
  await page.mouse.move(c.x, c.y, { steps: 4 })
  await page.mouse.move(c.x, c.y + 1)
  await page.mouse.move(c.x, c.y)
  await page.waitForTimeout(80)
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}

async function toolShortcuts(page) {
  console.log('--- editor shortcuts ---')
  for (const [key, want] of [
    ['w', 'move'],
    ['e', 'rotate'],
    ['q', 'transform'],
    ['m', 'ruler'],
    ['v', 'select'],
  ]) {
    await page.keyboard.press(key)
    await page.waitForTimeout(120)
    expect((await tool(page)) === want, `${key.toUpperCase()} selects the ${want} tool`)
  }

  // the toggles: read the store either side of the press
  const toggles = [
    ['y', 'gridSnap'],
    ['n', 'liveSnap'],
    ['t', 'space'],
    ['.', 'flowArrows'],
  ]
  for (const [key, field] of toggles) {
    const before = await page.evaluate((f) => window.__oip.store.getState()[f], field)
    await page.keyboard.press(key)
    await page.waitForTimeout(150)
    const after = await page.evaluate((f) => window.__oip.store.getState()[f], field)
    expect(before !== after, `${key} toggles ${field} (${JSON.stringify(before)} -> ${JSON.stringify(after)})`)
    await page.keyboard.press(key) // restore
    await page.waitForTimeout(120)
  }

  // G and Shift+G are different actions, because the table matches modifiers strictly. G edits the guard openings of
  // one selected guarded conveyor (it refuses with nothing to edit), so add one for the check (undone after).
  await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.roller-conveyor'), null, { timeout: 60000 })
  const guarded = await page.evaluate(() => {
    const st = window.__oip.store
    const s = st.getState().scene
    const roller = { id: 'keymap-roller', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 1, 0], rotationY: 0, params: { length: 3, width: 1, guardOpenings: [] } }
    st.commit('e2e roller', { ...s, parts: [...s.parts, roller] })
    st.select(roller.id)
    return st.getState().selectedIds[0] === roller.id
  })
  expect(guarded, 'the scene has a guarded conveyor to press G on')
  await page.keyboard.press('g')
  await page.waitForTimeout(150)
  expect((await page.evaluate(() => window.__oip.store.getState().sideGuardMode)) === true, 'G enters guard-openings mode on a selected conveyor')
  await page.keyboard.press('g')
  await page.waitForTimeout(150)
  expect((await page.evaluate(() => window.__oip.store.getState().sideGuardMode)) === false, 'G again leaves it')

  // H hides the selection, and H again shows it: the scene-tree menu's Hide / Show from the keyboard
  const visible = () => page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'keymap-roller')?.visible !== false)
  await page.keyboard.press('h')
  await page.waitForTimeout(150)
  expect((await visible()) === false, 'H hides the selected part')
  await page.keyboard.press('h')
  await page.waitForTimeout(150)
  expect((await visible()) === true, 'H again shows it')

  const gone = await page.evaluate(() => {
    const st = window.__oip.store
    st.clearSelection()
    st.undo() // show
    st.undo() // hide
    st.undo() // the roller added above
    return !st.getState().scene.parts.some((p) => p.id === 'keymap-roller')
  })
  expect(gone, 'cleanup: three undos remove the roller (show, hide, add)')
}

async function physicalResolution(page, client) {
  console.log('--- physical vs logical resolution ---')
  await page.keyboard.press('v')
  await page.waitForTimeout(120)

  // AZERTY: the physical W position prints 'z'. The tool must follow the position.
  await pressPhysical(client, { code: 'KeyW', key: 'z' })
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'move', 'AZERTY (code KeyW / key z) selects the Move tool')

  // QWERTZ: the physical Y position prints 'z'; grid snap is bound to the position…
  const snapBefore = await page.evaluate(() => window.__oip.store.getState().gridSnap)
  await pressPhysical(client, { code: 'KeyY', key: 'z' })
  await page.waitForTimeout(150)
  expect((await page.evaluate(() => window.__oip.store.getState().gridSnap)) !== snapBefore, 'QWERTZ (code KeyY / key z) toggles grid snap')
  await pressPhysical(client, { code: 'KeyY', key: 'z' })
  await page.waitForTimeout(150)

  // …but undo follows the legend: Ctrl + the key printed Z, wherever it physically sits. Place a
  // real part so the assertion is "the scene lost it again", not "a handler ran".
  await placeBox(page)
  const placed = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
  expect(placed > 0, `setup: the scene has a part to undo (${placed})`)
  // QWERTZ Ctrl+Z: the key printed 'z' physically sits at KeyY. modifiers:2 = Ctrl.
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyY', key: 'z', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyY', key: 'z', modifiers: 2 })
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
  expect(after === placed - 1, `Ctrl + the PRINTED z undoes one placement (${placed} -> ${after})`)
}

async function freeFly(page) {
  console.log('--- free fly (boost + movement) ---')
  const p0 = await pose(page)
  await page.keyboard.press('Shift+f')
  await page.waitForTimeout(300)
  const flying = await page.evaluate(() => window.__oip.view.isNavigating())
  expect(flying, 'Shift+F starts a flight')

  // hold the boost first, then the movement key - the order strict modifier matching breaks
  await page.keyboard.down('Shift')
  await page.waitForTimeout(60)
  await page.keyboard.down('w')
  await page.waitForTimeout(600)
  const p1 = await pose(page)
  expect(dist(p0, p1) > 0.5, `W moves the camera while Shift boosts (moved ${dist(p0, p1).toFixed(2)}m)`)

  // release W while Shift is still down: the keyup must be seen, or the camera flies forever
  await page.keyboard.up('w')
  await page.waitForTimeout(250)
  const p2 = await pose(page)
  await page.waitForTimeout(600)
  const p3 = await pose(page)
  expect(dist(p2, p3) < 0.05, `releasing W under Shift stops the camera (drifted ${dist(p2, p3).toFixed(3)}m after release)`)

  await page.keyboard.up('Shift')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  expect(!(await page.evaluate(() => window.__oip.view.isNavigating())), 'Esc ends the flight')

  // and the editor keys still work afterwards (no state left held)
  await page.keyboard.press('e')
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'rotate', 'editor shortcuts still fire after a flight')
}

async function shortcutsPanel(page) {
  console.log('--- shortcuts reference ---')
  await page.keyboard.press('Shift+/')
  await page.waitForTimeout(300)
  const open = await page.locator('[data-shortcuts-overlay]').count()
  expect(open === 1, 'Shift+/ opens the keyboard reference')

  const rows = await page.locator('[data-shortcuts-overlay] .shortcut-row').count()
  expect(rows > 30, `the panel lists the whole table (${rows} rows)`)
  const kbds = await page.locator('[data-shortcuts-overlay] kbd').allInnerTexts()
  expect(kbds.includes('W') && kbds.includes('Ctrl+Z'), 'chords render readably (W, Ctrl+Z)')
  expect(!kbds.some((k) => k.includes('Key')), 'no raw code names leak into the UI')

  // the search box narrows the rows, finds a chord as printed, and says so when nothing matches.
  // Typing into it must not reach the editor: 'w' would otherwise switch the tool.
  const search = page.locator('[data-testid="shortcuts-search"]')
  const toolBefore = await tool(page)
  await search.fill('undo')
  await page.waitForTimeout(150)
  const undoRows = await page.locator('[data-shortcuts-overlay] .shortcut-label').allInnerTexts()
  expect(undoRows.length > 0 && undoRows.length < rows && undoRows.includes('Undo'), `"undo" narrows the list (${undoRows.join(', ')})`)
  await search.fill('ctrl+shift+z')
  await page.waitForTimeout(150)
  const chordRows = await page.locator('[data-shortcuts-overlay] .shortcut-label').allInnerTexts()
  expect(chordRows.includes('Redo'), `a printed chord finds its row (${chordRows.join(', ')})`)
  await search.fill('')
  await search.pressSequentially('w')
  await page.waitForTimeout(150)
  expect((await tool(page)) === toolBefore, 'typing in the search box does not drive editor shortcuts')
  await search.fill('zzqq')
  await page.waitForTimeout(150)
  expect((await page.locator('[data-shortcuts-overlay] .shortcut-row').count()) === 0, 'a query that matches nothing shows no rows')
  expect((await page.locator('[data-shortcuts-overlay] .shortcuts-empty').count()) === 1, 'and says nothing matches')
  await search.fill('')
  await page.waitForTimeout(150)
  expect((await page.locator('[data-shortcuts-overlay] .shortcut-row').count()) === rows, 'clearing the search brings every row back')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  expect((await page.locator('[data-shortcuts-overlay]').count()) === 0, 'Esc closes it')
}

/**
 * Rebinding. `resolveKeymap(overrides)` is the seam the shortcuts panel uses (like VS Code's
 * Keyboard Shortcuts). What only a browser can prove is that a rebind reaches the listeners: the
 * panel, the editor controller and the fly/pilot handlers live in three layers that cannot import
 * each other, and any of them could silently fall back to the built-in table.
 */
async function rebinding(page) {
  console.log('--- rebinding ---')
  const openPanel = async () => {
    await page.keyboard.press('Shift+/')
    await page.waitForFunction(() => !!document.querySelector('[data-shortcuts-overlay]'), null, { timeout: 5000, polling: 100 })
  }
  const closePanel = async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-shortcuts-overlay]'), null, { timeout: 5000, polling: 100 })
  }
  // The row for one action, matched on its label element exactly. A `hasText` over the whole row is
  // wrong here and quietly so: hints are part of the row's text, so 'Move' also matches Transform
  // ("combined move + rotate gizmo") and 'Rotate' does too - every assertion below then reads the
  // Transform row and the failures look like the feature is broken.
  const row = (label) =>
    page.locator('.shortcut-row').filter({ has: page.locator('.shortcut-label', { hasText: new RegExp(`^${label}$`) }) }).first()
  /** click a row's chord and wait until it is actually recording (the listener mounts on the next render) */
  const startRecording = async (label) => {
    await row(label).locator('.shortcut-edit').click({ force: true })
    await page.waitForFunction(
      (l) =>
        [...document.querySelectorAll('.shortcut-row')].some(
          (r) => r.querySelector('.shortcut-label')?.textContent === l && r.querySelector('.shortcut-recording'),
        ),
      label,
      { timeout: 5000, polling: 50 },
    )
  }

  await openPanel()

  // Escape is documented but must never be editable: the handlers pre-empt it in a modal branch, so
  // rebinding it would strand someone inside a drag with no way out.
  const cancelRow = row('Cancel / deselect')
  expect((await cancelRow.locator('.shortcut-fixed').count()) === 1, 'the fixed Escape binding renders')
  expect((await cancelRow.locator('.shortcut-edit').count()) === 0, 'and offers no way to rebind it')

  // ── record a new chord for Move ─────────────────────────────────────────────────────────────────
  await startRecording('Move')
  expect((await row('Move').locator('.shortcut-recording').count()) === 1, 'clicking a chord starts recording')
  await page.keyboard.press('Shift')
  expect((await row('Move').locator('.shortcut-recording').count()) === 1, 'a bare modifier is not a chord; it keeps waiting')
  await page.keyboard.press('j')
  await page.waitForTimeout(200)
  expect((await row('Move').locator('kbd').innerText()) === 'J', `the panel shows the new chord (${await row('Move').locator('kbd').innerText()})`)

  // ── refusal: a chord already taken in the same mode ─────────────────────────────────────────────
  await startRecording('Move')
  await page.keyboard.press('e')
  await page.waitForTimeout(200)
  const refusal = await row('Move').locator('.shortcut-refused').innerText().catch(() => '')
  expect(/already/i.test(refusal) && /rotate/i.test(refusal), `a taken chord is refused by name (${JSON.stringify(refusal)})`)
  expect((await row('Move').locator('kbd').innerText()) === 'J', 'and the binding it would have clobbered is untouched')

  // ── the rebind reaches the listener, in a different layer ───────────────────────────────────────
  await closePanel()
  await page.keyboard.press('v')
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'select', 'baseline: V still selects the Select tool')
  await page.keyboard.press('w')
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'select', 'the OLD chord no longer fires')
  await page.keyboard.press('j')
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'move', 'the NEW chord drives the editor controller')

  // ── it survives a reload ────────────────────────────────────────────────────────────────────────
  await page.reload()
  await waitForApp(page)
  await page.waitForTimeout(1500)
  await page.keyboard.press('v')
  await page.waitForTimeout(150)
  await page.keyboard.press('j')
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'move', 'and it is still bound after a reload')

  // ── revert one, then all ────────────────────────────────────────────────────────────────────────
  await openPanel()
  expect((await row('Move').locator('.shortcut-revert').count()) === 1, 'a changed row offers a revert')
  await row('Move').locator('.shortcut-revert').click({ force: true })
  await page.waitForTimeout(200)
  expect((await row('Move').locator('kbd').innerText()) === 'W', 'reverting restores the default chord')
  await closePanel()
  await page.keyboard.press('v')
  await page.waitForTimeout(150)
  await page.keyboard.press('w')
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'move', 'and W drives the Move tool again')

  // Restore-all appears only while something is overridden, so rebind once more to reach it
  await openPanel()
  await startRecording('Rotate')
  await page.keyboard.press('k')
  await page.waitForTimeout(200)
  expect((await page.locator('.shortcuts-reset-all').count()) === 1, 'Restore all defaults appears once something is changed')
  await page.locator('.shortcuts-reset-all').click({ force: true })
  await page.waitForTimeout(200)
  expect((await page.locator('.shortcuts-reset-all').count()) === 0, 'and disappears once nothing is')
  expect((await row('Rotate').locator('kbd').innerText()) === 'E', 'every binding is back on its default')
  await closePanel()
  await page.keyboard.press('e')
  await page.waitForTimeout(150)
  expect((await tool(page)) === 'rotate', 'and the defaults drive the app again')
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage - the tour just shows up, harmless here */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`)
    await waitForApp(page)
    await page.waitForTimeout(2500)
    const client = await page.context().newCDPSession(page)

    await toolShortcuts(page)
    // fly first: it is the regression this gate exists for, so it runs on the cleanest state -
    // before anything places parts or leaves a tool mid-gesture
    await freeFly(page)
    await physicalResolution(page, client)
    await shortcutsPanel(page)
    await rebinding(page)
    await page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall keymap checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
