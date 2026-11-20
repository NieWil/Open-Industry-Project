// Verifies the Problems dock (src/editor/components/ProblemsPanel.tsx + editor/problems.ts) against
// the real demo scene, in a browser.
//
// The unit suite checks the aggregation against hand-built inputs. Only a browser can check the rest:
// the checks run continuously on the open document rather than once when the run starts, and each row
// navigates to its cause. So this makes the two mistakes authors commonly make (a stray semicolon in the
// program, two parts pointed at one tag) and requires the panel to notice each without the sim ever
// being started, then to take you to the cause.
//
// It carries its own negative control, because the risk here is a vacuous pass: a panel showing
// nothing looks the same whether the document is clean or the checks never ran. The demo is clean,
// so every assertion below is bracketed by "clean -> broken -> clean again".
//
// Run: node e2e/verify-problems-panel.mjs
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { FLOATING_PLC_LAYOUT, showPlcEditor } from './_plc.mjs'
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

const head = (page) => page.locator('.problems-head').innerText()
const rows = (page) => page.locator('.problems-row').allInnerTexts()
const notes = (page) => page.locator('.problems-note').allInnerTexts()

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // The PLC editor floats here: this types into the code while reading the Problems dock, and the docked default puts
  // the two in one strip. Seeded only when nothing is stored, so it is in place before the app first reads the layout.
  await page.addInitScript((layout) => {
    try {
      if (!localStorage.getItem('oip-web/dock-layout')) localStorage.setItem('oip-web/dock-layout', layout)
    } catch {
      /* private mode */
    }
  }, FLOATING_PLC_LAYOUT)
  await page.goto(`http://localhost:${PORT}/app/?scene=demo`)
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 40000 })

  // The panel ships as a background tab in the bottom dock; the reveal command brings it forward.
  //
  // Requested from distraction-free mode, where it can fail: df hides every dock, so a reveal that only
  // brings a tab forward inside a hidden dock shows nothing, while the command palette stays available in
  // df and "Problems" appears to do nothing. Revealing a docked panel has to leave df, as revealDockPanel
  // already does with a maximized panel. The control checks that df really hid the docks first; without
  // it this would pass on an app where df never turned on.
  await page.evaluate(() => window.__oip.store.toggleDistractionFree())
  const dfHidDocks = await page
    .waitForFunction(() => document.querySelectorAll('.dock-slot').length === 0, null, { timeout: 15000 })
    .then(() => true, () => false)
  expect(dfHidDocks, 'control: distraction-free is on and no dock slot is rendered')
  await page.evaluate(() => window.__oip.store.revealPanel('problems'))
  const shownFromDf = await page
    .locator('.problems-panel')
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true, () => false)
  expect(shownFromDf, 'revealing a docked panel from distraction-free shows it')
  expect(!(await page.evaluate(() => window.__oip.store.getState().distractionFree)), 'by leaving distraction-free')
  if (!shownFromDf) {
    // leave the page usable so the checks below still report on their own
    if (await page.evaluate(() => window.__oip.store.getState().distractionFree)) {
      await page.evaluate(() => window.__oip.store.toggleDistractionFree())
    }
    await page.evaluate(() => window.__oip.store.revealPanel('problems'))
    await page.locator('.problems-panel').waitFor({ state: 'visible', timeout: 10000 })
  }

  // ── the check has something to examine (guards against a vacuous pass on an empty scene) ──
  const survey = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return {
      // a part is connected when one of its tag fields names a tag
      comms: s.scene.parts.filter((p) => {
        const specs = p?.params ? window.__oip.getPackage(p.packageId ?? '')?.params : null
        return !!specs && Object.entries(specs).some(([k, spec]) => spec?.type === 'tag' && typeof p.params[k] === 'string' && p.params[k].trim() !== '')
      }).length,
      program: s.stProgram.length,
    }
  })
  expect(survey.comms >= 4, `the demo wires ${survey.comms} parts to tags, so the wiring walk has real input`)
  expect(survey.program > 100, `the demo carries a ${survey.program}-char PLC program`)

  // ── clean baseline: the shipped demo has no errors and no coverage holes ──
  expect(/0 errors/.test(await head(page)), 'the demo scene reports 0 errors')
  expect((await notes(page)).length === 0, 'no coverage notes on the demo (nothing went unchecked)')

  // ── a PLC syntax error, typed, with the sim never started ──
  //
  // Typed rather than pushed through store.setStProgram, because those are different documents: the
  // store holds the program of record, but the mounted editor only re-syncs its buffer on a wholesale
  // load (StEditor's onStProgramLoad; echoing every keystroke would move the user's cursor). Injecting
  // through the store leaves CodeMirror holding the older text, so "go to the line" would be checked
  // against a buffer no user could have. This types at the keyboard, the way the mistake is made.
  const original = await page.evaluate(() => window.__oip.store.getState().stProgram)
  // the demo's controller runs a ladder, so the panel opened on its rungs: the text is where a person types
  await showPlcEditor(page)
  // focus(), not click(): CodeMirror's content box is the whole document, so once the program is long
  // enough its centre sits outside the scroller and Playwright's hit test hits `.cm-editor`, the
  // ancestor ("subtree intercepts pointer events"), retrying until the click times out. Focusing puts the
  // caret there with no hit test, which is all these two lines need (setDoc() does the same).
  await page.locator('.cm-content').first().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nMotorZZZ := ;')
  await page.waitForFunction(() => /1 error/.test(document.querySelector('.problems-head')?.innerText ?? ''), { timeout: 5000 })
  const broken = await rows(page)
  expect(broken.length === 1, `one row for one syntax error (got ${broken.length})`)
  expect(/Program/.test(broken[0] ?? ''), 'it is grouped as a Program problem')
  expect(/Line \d+/.test(broken[0] ?? ''), 'the row names the line')
  expect((await notes(page)).some((n) => /does not compile/.test(n)), 'and says the program-side checks could not run')

  // The regression: `undriven`/`unread` count the program as a writer/reader, so with no compiled
  // program they would fire on every tag it handles (one semicolon produced 36 warnings against a
  // scene that had not changed). They are suppressed while the program doesn't compile, in favour of
  // the note above.
  expect(/0 warnings/.test(await head(page)), 'one syntax error does not manufacture a warning per tag')

  // Clicking a program row must take you to the code. CodeMirror virtualizes its lines, so "the
  // offending line is among the rendered ones" is a real scroll assertion, not a text search, as
  // long as the negative control below (the same query before the click) holds.
  const showsBreak = () =>
    page.evaluate(() => [...document.querySelectorAll('.cm-line')].some((l) => (l.textContent ?? '').includes('MotorZZZ')))
  // scroll the editor away from the end so the reveal has to scroll back
  // focus(), not click(): CodeMirror's content box is the whole document, so once the program is long
  // enough its centre sits outside the scroller and Playwright's hit test hits `.cm-editor`, the
  // ancestor ("subtree intercepts pointer events"), retrying until the click times out. Focusing puts the
  // caret there with no hit test, which is all these two lines need (setDoc() does the same).
  await page.locator('.cm-content').first().focus()
  await page.keyboard.press('Control+Home')
  await page.waitForTimeout(200)
  expect((await showsBreak()) === false, 'control: the broken line is off-screen before the row is clicked')

  await page.locator('.problems-row').first().click()
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => !!document.querySelector('.cm-editor')), 'clicking it reveals the PLC editor')
  expect(await showsBreak(), 'and scrolls to the offending line')

  // ── back to clean: the panel must clear rows, not only add them ──
  // loadStProgram is the wholesale-replacement path (what a scene import or Undo-to-saved does), and
  // the one that also puts the editor's buffer back - see the note above.
  await page.evaluate((src) => window.__oip.store.loadStProgram(src), original)
  await page.waitForFunction(() => /0 errors/.test(document.querySelector('.problems-head')?.innerText ?? ''), { timeout: 5000 })
  expect((await notes(page)).length === 0, 'fixing the program clears the row and the note')

  // ── two parts driving one tag: an error that otherwise shows only when the run starts ──
  const collision = await page.evaluate(() => {
    const s = window.__oip.store
    const state = s.getState()
    // Parts that drive a tag. The direction matters: `contested` is about two writers, and many
    // readers on one tag is legal. Pointing two `dir: 'in'` params at one name is not a mistake and
    // must not be reported as one. The package schema is what declares the direction.
    const owners = []
    for (const p of state.scene.parts) {
      if (!p.params) continue
      const pkg = window.__oip.getPackage(p.packageId ?? '')
      if (!pkg || !pkg.params) continue
      for (const [k, spec] of Object.entries(pkg.params)) {
        if (!spec || spec.type !== 'tag' || spec.dir !== 'out') continue
        const v = p.params[k]
        if (typeof v === 'string' && v.trim()) owners.push({ id: p.id, key: k, value: v })
      }
    }
    // any two parts driving the same param: the first owner's param may be one only it has (the demo's first
    // wired part is not always a conveyor)
    let a = null
    let b = null
    for (const o of owners) {
      b = owners.find((x) => x.id !== o.id && x.key === o.key) ?? null
      if (b) {
        a = o
        break
      }
    }
    if (!a || !b) return null
    // through the same commit path the Inspector uses, so this is a real authoring edit
    s.commit('e2e collide tags', {
      ...state.scene,
      parts: state.scene.parts.map((p) => (p.id === b.id ? { ...p, params: { ...p.params, [b.key]: a.value } } : p)),
    })
    return { tag: a.value, ids: [a.id, b.id] }
  })
  expect(collision !== null, 'found two parts sharing a tag param to collide')
  if (collision) {
    await page.waitForFunction(() => !/0 errors/.test(document.querySelector('.problems-head')?.innerText ?? ''), { timeout: 5000 })
    const list = await rows(page)
    expect(list.some((r) => r.includes(collision.tag)), `a row names the contested tag ${collision.tag}`)
    expect(list.some((r) => /writers/.test(r)), 'and says what is wrong with it (two writers)')

    // clicking selects the parts the row names
    const contested = page.locator('.problems-row', { hasText: collision.tag }).first()
    await contested.click()
    await page.waitForTimeout(200)
    const selected = await page.evaluate(() => window.__oip.store.getState().selectedIds)
    expect(
      collision.ids.every((id) => selected.includes(id)),
      `clicking selected both offending parts (${JSON.stringify(selected)})`,
    )
  }

  // ── warnings are opt-in, and the count is never hidden ──
  const headText = await head(page)
  expect(/warning/.test(headText), 'the warning count stays on the toggle even while warnings are hidden')
  const beforeToggle = (await rows(page)).length
  await page.locator('.problems-toggle').click()
  await page.waitForTimeout(200)
  const afterToggle = (await rows(page)).length
  expect(afterToggle >= beforeToggle, `the toggle reveals warnings (${beforeToggle} -> ${afterToggle})`)

  // ── the PLC panel's "not connected" line opens this panel, with warnings shown ──
  // Unbound and unwired tags are warnings here, hidden by default, while the PLC panel knows about them as soon as a
  // program attaches. That panel keeps a one-line count and links to this dock for the list rather than keeping a
  // second copy, so the link has to open it with warnings on. Otherwise it opens onto "0 errors" and the tags it
  // counted are not shown.
  const toggle = page.locator('.problems-toggle')
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  const demoProgram = await page.evaluate(() => window.__oip.store.getState().stProgram)
  await page.evaluate(() => {
    // tags no part in the demo reads or writes
    window.__oip.store.loadStProgram('VAR_INPUT OrphanIn : BOOL; END_VAR\nVAR_OUTPUT OrphanOut : BOOL; END_VAR\nOrphanOut := OrphanIn;')
    window.__oip.controller.run()
  })
  const countLine = page.locator('[data-testid="st-unconnected"]')
  const counted = await countLine.waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false)
  expect(counted, 'a running program with tags no part uses gets a one-line count in the PLC panel')
  const countText = (await countLine.textContent().catch(() => '')) ?? ''
  expect(/\d+ tags? not connected/.test(countText) && !countText.includes('OrphanIn'), `the line is a count, not the list ("${countText.slice(0, 60)}")`)
  expect((await toggle.getAttribute('aria-pressed')) === 'false', 'control: warnings are hidden before the link is clicked')
  await page.locator('[data-testid="st-show-in-problems"]').click()
  await page.waitForTimeout(300)
  expect((await toggle.getAttribute('aria-pressed')) === 'true', '"Show in Problems" turns the warnings on')
  expect((await rows(page)).some((r) => r.includes('OrphanIn')), 'and a tag it counted is a row there')
  await page.evaluate((src) => {
    window.__oip.controller.stop()
    window.__oip.store.loadStProgram(src)
  }, demoProgram)
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures === 0 ? '\nPASS verify-problems-panel' : `\nFAIL verify-problems-panel (${failures})`)
process.exit(failures === 0 ? 0 : 1)
