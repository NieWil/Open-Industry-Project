// Verify the part-editing surfaces say what an edit will do, and never drop or misdirect one.
//
// Each case below guards a bug that lost work without a message or offered a control that could not work,
// and none of them threw:
//   A. The behavior editor asks before a backdrop click (or its ✕) closes it, and only when there are
//      changes since the last Apply.
//   B. No "Save part" in the browser's behavior editor or rig node panel: there it could only say it needs
//      the desktop app, and an applied edit to a library part is kept anyway.
//   C. A rig node edit changes the part definition, so every placed copy. The panel names how many placed
//      copies follow, from the same counter as the scene tree (treeNode.placedCopiesOf), which does not
//      count a definition session's own throwaway.
//   D. "Delete node" on a part's last node is disabled (the controller refuses to empty a rig).
//   E. A problem with a line number in the behavior editor's list jumps to that line.
//   F. The Catalog ✎ is disabled in a shared room, where opening a part's own scene is refused.
//   G. A joint's name can be changed, but only while the script never mentions it. A rename does not
//      rewrite the script (core/parts/partPackage.ts behaviorMentions says why), and a joint the script still
//      commands by its old name stops moving with no error.
//   N. In the Part Editor, the copy's Name and Category are the part's own (the copy's own name would be dropped on
//      Back). A blank name is refused with a reason, the change is an undo step, and a built-in's are read-only.
//   H. The in-app editor is "Edit behavior…" at every entry point, and the browser offers no
//      external-editor button.
//   S. The behavior editor has syntax highlighting. Monaco's monarch compiler assigns a 'constructor' key
//      onto a plain {}, which SES's frozen intrinsics reject (the override mistake), so without the fix the
//      tokenizer never compiles and the only trace is an SES_UNHANDLED_REJECTION in the console
//      (vite.config.ts monarchKeywordHash).
//
// The desktop side (a part's files are the project folder's parts/, in-app and outside edits both go there, no
// Save part at all) needs the real shell: verify-part-library-electron.mjs.
//
//   node e2e/verify-part-editing-ux.mjs [--headed]
/* global window, document, localStorage, console, process */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port, vite } = await startServer()
// the demo: it has placed custom parts, so the copy count and the part panel are exercised, never skipped
const URL = `http://localhost:${port}/app/?scene=demo`
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const sesErrors = []
page.on('console', (m) => { if (m.text().includes('SES_')) sesErrors.push(m.text().split('\n')[0]) })
const dialogs = []
let answer = false
page.on('dialog', (d) => {
  dialogs.push(d.message())
  void (answer ? d.accept() : d.dismiss())
})
let harness = null
try {
  await page.goto(URL)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 120000 })
  // a positive settle signal, not a timed wait (AGENTS.md): part GLBs load async
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })

  // ── C/D/H: the node panel in a definition session ───────────────────────────────────────────────
  // a bundled rig part with more than one node that the demo has placed
  const pick = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    const placed = (id) => s.scene.parts.filter((p) => p.type === 'part' && p.packageId === id).length
    const best = s.bundledPackages.find((p) => p.geometry.kind === 'rig' && p.geometry.links.length > 1 && placed(p.id) > 0)
    return best ? { id: best.id, placed: placed(best.id), first: best.geometry.links[0].name } : null
  })
  if (!pick) throw new Error('the demo has no placed multi-node rig part to edit (fixture moved?)')
  console.log('part:', pick)
  await page.evaluate(({ id, first }) => {
    window.__oip.controller.editPartPackage(id)
    const s = window.__oip.store.getState()
    window.__oip.store.selectRigNode(s.packageEdit.partId, first)
  }, pick)
  await page.waitForSelector('[data-testid="rig-node-panel"]', { timeout: 10000 })
  const hint = await page.locator('.inspector > .inspector-hint').first().innerText()
  const want = pick.placed === 1 ? 'its 1 placed copy in this scene follows' : `all ${pick.placed} placed copies in this scene follow`
  check('C  the node panel names how many placed copies the edit changes', hint.includes(want), hint)
  check('B  ...and mentions no Save in the browser', !hint.includes('Save part'))
  check('D  Delete node is enabled on a multi-node part', await page.locator('.inspector button', { hasText: 'Delete node' }).isEnabled())
  // the header's actions are icon buttons, named by aria-label
  const nodeButtons = await page.locator('.inspector button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') || b.textContent || ''))
  check('H  the node panel offers Edit behavior…', nodeButtons.some((t) => /edit behavior/i.test(t)))
  check('H  ...and no external-editor button in the browser', !nodeButtons.some((t) => /external editor/i.test(t)))
  check('B  ...and no Save part in the browser', !nodeButtons.some((t) => t.includes('Save part')))
  await page.evaluate(() => window.__oip.store.exitPartFocus())

  // ── D: a blank part has one node, and its Delete is disabled with a reason ──────────────────────
  await page.evaluate(() => window.__oip.controller.createBlankPart())
  await page.waitForFunction(() => window.__oip.store.getState().selectedRigNode !== null, null, { timeout: 10000 })
  const lastDel = page.locator('.inspector button', { hasText: 'Delete node' })
  check('D  Delete node is disabled on the last node', await lastDel.isDisabled())
  check('D  ...and says why', ((await lastDel.getAttribute('title')) ?? '').includes('at least one node'))

  // ── G: a joint's name is renamable while the script never mentions it, fixed once it does ───────
  await page.locator('.inspector button', { hasText: 'Add joint' }).click()
  const blankId = await page.evaluate(() => window.__oip.store.getState().packageEdit.packageId)
  const jointName = () => page.evaluate((id) => window.__oip.getPackage(id).geometry.joints[0]?.name ?? null, blankId)
  const nameInput = page.locator('.inspector label.field', { has: page.locator('.field-label', { hasText: /^Name$/ }) }).locator('input')
  check('G  a joint the script never mentions has an editable name', (await nameInput.count()) === 1, String(await jointName()))
  await nameInput.fill('lift')
  await nameInput.press('Enter')
  await page.waitForFunction((id) => window.__oip.getPackage(id).geometry.joints[0]?.name === 'lift', blankId, { timeout: 3000 }).catch(() => {})
  check('G  Enter renames the joint', (await jointName()) === 'lift', String(await jointName()))
  await nameInput.fill('   ')
  await nameInput.press('Enter')
  await page.waitForSelector('[data-testid="joint-name-msg"]', { timeout: 3000 }).catch(() => {})
  check('G  a blank name is refused', (await jointName()) === 'lift')
  check('G  ...says why, under the field', ((await page.locator('[data-testid="joint-name-msg"]').innerText().catch(() => '')) ?? '').includes('needs a name'))
  check('G  ...and the field shows the stored name again', (await nameInput.inputValue()) === 'lift', await nameInput.inputValue())
  const applied = await page.evaluate((id) => window.__oip.controller.editBehavior(id, "definePart({ params: {}, step(ctx) { ctx.setJoint('lift', 0) } })"), blankId)
  check('G  a script commanding the joint applies', applied.length === 0, JSON.stringify(applied))
  await page.waitForSelector('[data-testid="joint-name-fixed"]', { timeout: 3000 }).catch(() => {})
  check('G  once the script uses it, the name is no longer editable', (await nameInput.count()) === 0)
  check('G  ...and the panel says to rename it in the script', ((await page.locator('[data-testid="joint-name-fixed"]').innerText().catch(() => '')) ?? '').includes('in the script'))
  check('G  the controller refuses the rename too', (await page.evaluate((id) => window.__oip.controller.renameRigJoint(id, 'lift', 'other'), blankId)) === false)

  // ── N: the Part Editor's copy names the part itself (its own name would be dropped on Back) ─────
  await page.evaluate(() => { const s = window.__oip.store.getState(); window.__oip.store.select(s.packageEdit.partId) })
  await page.waitForSelector('[data-testid="part-category"]', { timeout: 5000 }).catch(() => {})
  const partName = page.locator('.inspector label.field', { has: page.locator('.field-label', { hasText: /^Name$/ }) }).locator('input')
  check('N  the session copy\'s Name field shows the part\'s name', (await partName.inputValue().catch(() => '')) === (await page.evaluate((id) => window.__oip.getPackage(id).name, blankId)))
  await partName.fill('Lift Table')
  await partName.press('Enter')
  // a standard name typed in another case is stored as the app spells it
  await page.locator('[data-testid="part-category"]').fill('devices')
  await page.locator('[data-testid="part-category"]').press('Enter')
  const info = await page.evaluate((id) => ({ name: window.__oip.getPackage(id).name, category: window.__oip.getPackage(id).category, lib: window.__oip.store.getState().userPackages.find((p) => p.id === id)?.name }), blankId)
  check('N  Name renames the part, in the registry and the library', info.name === 'Lift Table' && info.lib === 'Lift Table', JSON.stringify(info))
  check('N  Category moves it to another catalog tab', info.category === 'Devices', JSON.stringify(info))
  // any other name is a category of its own, with a tab of its own
  await page.locator('[data-testid="part-category"]').fill('Lift Tables')
  await page.locator('[data-testid="part-category"]').press('Enter')
  check('N  a new category name is kept as typed', (await page.evaluate((id) => window.__oip.getPackage(id).category, blankId)) === 'Lift Tables')
  await page.waitForSelector('.catalog-tab[data-category="Lift Tables"]', { timeout: 3000 }).catch(() => {})
  check('N  ...and gets a catalog tab of its own', (await page.locator('.catalog-tab[data-category="Lift Tables"]').count()) === 1)
  await page.evaluate(() => window.__oip.store.undo())
  check('N  the Scene dock header follows', ((await page.locator('.scene-tree-head').innerText().catch(() => '')) ?? '').includes('Lift Table'))
  await partName.fill('  ')
  await partName.press('Enter')
  await page.waitForSelector('[data-testid="part-info-problem"]', { timeout: 3000 }).catch(() => {})
  check('N  a blank name is refused, and says why', (await page.evaluate((id) => window.__oip.getPackage(id).name, blankId)) === 'Lift Table' && ((await page.locator('[data-testid="part-info-problem"]').innerText().catch(() => '')) ?? '').includes('needs a name'))
  check('N  ...and the field shows the stored name again', (await partName.inputValue()) === 'Lift Table', await partName.inputValue())
  await page.evaluate(() => window.__oip.store.undo())
  check('N  undo takes the category change back', (await page.evaluate((id) => window.__oip.getPackage(id).category, blankId)) !== 'Devices')
  await page.evaluate(() => window.__oip.store.exitPartFocus())
  // a built-in's copy keeps the built-in's name
  await page.evaluate((id) => { window.__oip.controller.editPartPackage(id); const s = window.__oip.store.getState(); window.__oip.store.select(s.packageEdit.partId) }, pick.id)
  await page.waitForSelector('[data-testid="part-category"]', { timeout: 5000 }).catch(() => {})
  check('N  a built-in\'s Name and Category are read-only', (await partName.isDisabled().catch(() => false)) && (await page.locator('[data-testid="part-category"]').isDisabled().catch(() => false)))
  await page.evaluate(() => window.__oip.store.exitPartFocus())

  // ── H: the part panel of a placed custom part ───────────────────────────────────────────────────
  const placedId = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.type === 'part' && p.packageId === id)?.id ?? null, pick.id)
  await page.evaluate((id) => window.__oip.store.select(id), placedId)
  await page.waitForSelector('.inspector-head-actions', { timeout: 10000 })
  const partButtons = await page.locator('.inspector-head-action').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') || b.textContent || ''))
  check('H  the part panel offers Edit behavior… exactly once', partButtons.filter((t) => /edit behavior/i.test(t)).length === 1, partButtons.join(' | '))
  check('H  ...and no external-editor button in the browser', !partButtons.some((t) => /external editor/i.test(t)))

  // ── A/B/E: the behavior editor ──────────────────────────────────────────────────────────────────
  await page.evaluate((id) => window.__oip.controller.openBehaviorEditor(id), pick.id)
  await page.waitForSelector('.behavior-monaco .view-lines', { timeout: 60000 })
  // without a tokenizer every span is the plain colour mtk1; a compiled one gives keywords, comments, strings
  // their own. Bracket-pair colouring works without a tokenizer, so its spans prove nothing and are skipped
  const tokenColours = () => page.evaluate(() => [...new Set([...document.querySelectorAll('.behavior-monaco .view-lines span[class^="mtk"]')]
    .filter((s) => !s.className.includes('bracket-highlighting'))
    .map((s) => s.className.split(' ')[0]))].length)
  await page.waitForFunction(() => document.querySelector('.behavior-monaco .view-lines span[class^="mtk"]:not(.mtk1)'), null, { timeout: 15000, polling: 250 }).catch(() => {})
  check('S  the behavior editor highlights its syntax', (await tokenColours()) > 1, `${await tokenColours()} token colours`)
  await page.click('.behavior-monaco .view-lines')
  await page.keyboard.press('Control+End')
  // only determinism problems carry a line (validatePart), so provoke one. Inserted in one go: typed key by
  // key, Monaco's suggestion widget consumes some keys and the text becomes a syntax error, which has no line
  await page.keyboard.insertText('\nMath.random();\n')
  await page.waitForSelector('.behavior-problem-link', { timeout: 5000 }).catch(() => {})
  const links = page.locator('.behavior-problem-link')
  check('E  a located problem is a clickable link', (await links.count()) > 0, await page.locator('.behavior-problems').innerText())
  answer = false
  dialogs.length = 0
  await page.click('.behavior-close')
  check('A  closing with unapplied changes asks first', dialogs.length === 1, dialogs.join(' / '))
  check('A  ...and dismissing keeps the editor open', (await page.locator('.behavior-dialog').count()) === 1)
  dialogs.length = 0
  await page.mouse.click(4, 500) // the backdrop, outside the dialog
  check('A  a backdrop click asks too', dialogs.length === 1)
  check('A  ...and stays open', (await page.locator('.behavior-dialog').count()) === 1)
  if ((await links.count()) > 0) {
    await page.locator('.behavior-foot').click() // focus out of the editor, so the link has to bring it back
    await links.first().click()
    check('E  clicking a problem focuses the editor at it', await page.evaluate(() => !!document.activeElement?.closest('.monaco-editor')))
  }
  answer = true
  await page.click('.behavior-close')
  check('A  accepting the prompt closes the editor (the edit is dropped)', (await page.locator('.behavior-dialog').count()) === 0)
  check('A  ...and nothing was applied', !(await page.evaluate((id) => window.__oip.getPackage(id).behavior.includes('Math.random();'), pick.id)))
  answer = false
  dialogs.length = 0
  await page.evaluate((id) => window.__oip.controller.openBehaviorEditor(id), pick.id)
  await page.waitForSelector('.behavior-monaco .view-lines', { timeout: 60000 })
  const editorButtons = await page.evaluate(() => [...document.querySelectorAll('.behavior-btn')].map((b) => b.textContent ?? ''))
  check('B  no Save part in the browser behavior editor', !editorButtons.some((t) => t.includes('Save')), editorButtons.join(' | '))
  await page.click('.behavior-close')
  check('A  an unchanged editor closes without a prompt', dialogs.length === 0 && (await page.locator('.behavior-dialog').count()) === 0)

  // ── I: a node field a param sets points at that param (it is set per placement, so it is not editable here) ──
  // a definition session: the copy on screen is a throwaway and its params are discarded, so the panel only says where
  await page.evaluate(() => {
    const { controller, store } = window.__oip
    controller.editPartPackage('oip.roller-conveyor')
    store.selectRigNode(store.getState().packageEdit.partId, 'wallL')
  })
  await page.waitForSelector('[data-testid="node-owned-offset"]', { timeout: 10000 }).catch(() => {})
  const placement = await page.locator('[data-testid="node-owner-placement"]').innerText().catch(() => '')
  check('I  in a definition session, an owned field says it is set on each placed part', placement.includes('Width') && placement.includes('not here'), placement)
  check('I  ...and offers no button to change a throwaway', (await page.locator('[data-testid="node-owner-buttons"]').count()) === 0)
  await page.evaluate(() => window.__oip.store.exitPartFocus())
  // a placed roller conveyor's own scene: "Change Width" selects the part and focuses its Width
  const placed = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.type === 'part' && p.packageId === 'oip.roller-conveyor')?.id ?? null)
  if (!placed) throw new Error('the demo has no placed roller conveyor (fixture moved?)')
  await page.evaluate((id) => {
    window.__oip.controller.openPartScene(id)
    window.__oip.store.selectRigNode(id, 'wallL')
  }, placed)
  const change = page.locator('[data-testid="node-owner-buttons"] button', { hasText: 'Width' })
  await change.first().waitFor({ timeout: 10000 }).catch(() => {})
  check('I  on a placed part, an owned field offers "Change Width"', (await change.count()) === 1)
  if ((await change.count()) === 1) {
    await change.click()
    await page.waitForFunction(() => document.activeElement?.closest('.prop-row')?.getAttribute('data-param') === 'width', null, { timeout: 5000 }).catch(() => {})
    const after = await page.evaluate(() => {
      const s = window.__oip.store.getState()
      return { sel: s.selectedIds, rig: s.selectedRigNode, focused: document.activeElement?.closest('.prop-row')?.getAttribute('data-param') ?? null }
    })
    check('I  ...which selects the part', after.sel.length === 1 && after.sel[0] === placed && after.rig === null, JSON.stringify(after))
    check('I  ...and puts the cursor in its Width field', after.focused === 'width', String(after.focused))
  }
  await page.evaluate(() => window.__oip.store.exitPartFocus())

  // ── F: Catalog ✎ in a room (what it does there with two people: verify-shared-part-editor.mjs) ──────────────────
  const editBtn = page.locator('.catalog-card-edit').first()
  check('F  the catalog is on screen with ✎ buttons', (await editBtn.count()) > 0)
  check('F  ✎ is enabled solo', await editBtn.isEnabled())
  await page.evaluate(() => window.__oip.store.setCollabMode(true))
  check('F  ✎ is enabled in a shared project too', await editBtn.isEnabled())
  const newBtn = page.locator('button.catalog-author', { hasText: 'New part' })
  check('F  + New part is enabled in a shared project', await newBtn.isEnabled())
  // last, because a tokenizer compiles lazily and its rejection can arrive well after the editor opened
  check('S  the whole run hit no SES error', !sesErrors.length, sesErrors[0])
  await page.evaluate(() => window.__oip.store.setCollabMode(false))
} catch (e) {
  // printed without a leading FAIL: the script broke on its own assumptions and asserted nothing, which the
  // gate runner reports as HARNESS (could not test), not FAILED (scripts/run-gates.mjs classify)
  harness = e
  console.error('harness error:', e instanceof Error ? e.message : e)
} finally {
  await browser.close()
  vite.kill()
}
if (harness) process.exit(2)
console.log(failures ? `FAIL  verify-part-editing-ux (${failures})` : 'PASS  verify-part-editing-ux')
process.exit(failures ? 1 : 0)
