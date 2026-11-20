// Forcing, in the browser: the Watch dock's Force holds a variable across scans against the program that writes it, a
// write to a forced variable changes the held value, the toolbar counts the forces and releases them, a force stays
// through Stop and holds from the next run's first scan, a reload drops one its program no longer has, and a scene load
// releases them all (EditorController.forcePlcValue, plc/link/plcLink.ts setForces, components/plc/ForcesStatus.tsx). Then the
// other two places a force shows or is set: the rungs mark a forced contact, and a device's tags (the PLC panel's
// Devices list) force and release the variable a field names.
//
// plc.test.ts covers the hold itself (a forced input against the scene, a forced output against the program) and
// tools.test.ts the agent's force_tag. Only a browser can check the path from the dock to the worker, where the scans
// run, and back, and that none of it is an edit of the project.
// Run: node e2e/verify-plc-force.mjs [--headed]
/* global process, console, window, document, localStorage, NodeFilter */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// the program writes both variables every scan, so only a force can hold either. Seen latches when a scan starts with
// Go TRUE, which an unforced run does from its second scan: it stays FALSE only if a force held Go from the first.
const PROGRAM = `VAR
  Go : BOOL;
  Count : INT;
  Seen : BOOL;
END_VAR
IF Go THEN Seen := TRUE; END_IF
Go := TRUE;
Count := Count + 1;
`

// PROGRAM without Go: a reload of it has to drop a force on Go
const PROGRAM_NO_GO = `VAR
  Count : INT;
END_VAR
Count := Count + 1;
`

// the rung reads Start, which the belt is wired to by its run tag through Lamp
// the second rung's contact has a name far wider than its symbol, so its label starts at the cell's left edge, right
// beside the rail: where a badge drawn half outside the cell could be clipped or covered
const LADDER_PROGRAM = `VAR
  Start : BOOL;
  Lamp : BOOL;
  InfeedPhotoEyeBlocked : BOOL;
  Rate : REAL := 1.0;
  Lamp2 : BOOL;
END_VAR
LADDER
  |Start| (Lamp);
  |InfeedPhotoEyeBlocked| (Lamp2);
END_LADDER
`

/** The middle of the first `text` on the code line that holds `lineHas`, in page coordinates. (Holds, not starts with:
 *  while the program runs the code shows each variable's live value beside it, inside the line's text.) */
const textPoint = (page, lineHas, text) =>
  page.evaluate(([has, word]) => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(has))
    if (!line) return null
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(word)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + word.length)
      const r = range.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    return null
  }, [lineHas, text])

// Clicked through the DOM, not locator.click(): a locator waits for its target to hold still across animation frames,
// which a software-rendered scene can stretch past any timeout (e2e/_plc.mjs showText says more).
const click = (page, selector) => page.evaluate((s) => document.querySelector(s)?.click(), selector)
const row = (name) => `[data-testid="plc-watch-row"][data-name="${name}"]`
const valueOf = (page, name) => page.evaluate((s) => document.querySelector(`${s} [data-testid="plc-watch-write"]`)?.textContent ?? null, row(name))
const forcedMark = (page, name) => page.evaluate((s) => !!document.querySelector(`${s} [data-testid="plc-watch-forced"]`), row(name))
const toolbarCount = (page) => page.evaluate(() => document.querySelector('[data-testid="plc-forces-status"]')?.textContent?.trim() ?? null)
const forces = (page) => page.evaluate(() => ({ ...window.__oip.controller.plcForces }))
const edits = (page) => page.evaluate(() => window.__oip.store.getEditHistory().events.length)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, ...(process.env.OIP_BROWSER_CHANNEL ? { channel: process.env.OIP_BROWSER_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    // the controller too: the store is up first, and on a cold server the viewport (and its controller) a while later
    await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 120000, polling: 200 })
    await page.evaluate((src) => {
      const st = window.__oip.store
      st.loadScene({
        version: st.getState().scene.version,
        parts: [{ id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[3, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Go' } }],
      })
      st.loadStProgram(src)
      st.revealPanel('watch')
    }, PROGRAM)
    await page.locator('[data-testid="plc-watch"]').waitFor({ state: 'visible', timeout: 30000 })
    const add = page.locator('[data-testid="plc-watch-add-name"]')
    await add.fill('Go, Count')
    await add.press('Enter')
    const editsBefore = await edits(page)

    await page.evaluate(() => window.__oip.controller.run())
    // a cold server can take a while to bring the program up; nothing below means anything until it counts
    const counting = await page
      .waitForFunction((s) => Number(document.querySelector(`${s} [data-testid="plc-watch-write"]`)?.textContent ?? 0) > 20, row('Count'), { timeout: 90000 })
      .then(() => true, () => false)
    check('the program runs and the dock shows its values', counting)
    if (!counting) return
    check('no forces yet, and no toolbar count', (await toolbarCount(page)) === null)

    // Force Go, then write the opposite: the program sets it TRUE every scan, and the force holds it FALSE
    await click(page, `${row('Go')} [data-testid="plc-watch-force"]`)
    await page.waitForTimeout(200)
    check('Force marks the row as forced', await forcedMark(page, 'Go'))
    check('...and the toolbar counts it', (await toolbarCount(page)) === '1 forced', await toolbarCount(page))
    const treeForced = (id) => page.evaluate((i) => !!document.querySelector(`[data-row-id="${i}"] [data-testid="tree-forced"]`), id)
    check("the Scene tree marks the part whose tag is forced (the belt's run tag is Go)", await treeForced('belt'))
    await click(page, `${row('Go')} [data-testid="plc-watch-write"]`)
    await page.waitForTimeout(800)
    check('a write to a forced BOOL changes the held value, and the program cannot write it back', (await valueOf(page, 'Go')) === 'FALSE', await valueOf(page, 'Go'))
    check('...the force is held at FALSE', JSON.stringify(await forces(page)) === '{"Go":false}', JSON.stringify(await forces(page)))

    // Force Count at its value: the program's increment no longer moves it
    await click(page, `${row('Count')} [data-testid="plc-watch-force"]`)
    await page.waitForTimeout(300)
    const held = await valueOf(page, 'Count')
    await page.waitForTimeout(800)
    check('a forced number stays where it was forced while the program counts', (await valueOf(page, 'Count')) === held, `${held} -> ${await valueOf(page, 'Count')}`)
    check('...and the toolbar counts two', (await toolbarCount(page)) === '2 forced', await toolbarCount(page))

    // Release All, from the toolbar
    await click(page, '[data-testid="plc-forces-status"]')
    await page.waitForTimeout(150)
    const listed = await page.evaluate(() => [...document.querySelectorAll('[data-testid="plc-forces-row"]')].map((r) => r.getAttribute('data-name')).join())
    check("the toolbar's list names the forced variables", listed === 'Go,Count', listed)
    const wired = await page.evaluate(() => document.querySelector('[data-testid="plc-forces-row"][data-name="Go"] .plc-forces-wired')?.textContent ?? '')
    check('...and says which part a forced variable reaches', /belt/.test(wired), wired)
    await click(page, '[data-testid="plc-forces-release-all"]')
    await page.waitForTimeout(800)
    check('Release All empties the forces and the count goes', JSON.stringify(await forces(page)) === '{}' && (await toolbarCount(page)) === null, JSON.stringify(await forces(page)))
    check('...the program writes Go again', (await valueOf(page, 'Go')) === 'TRUE', await valueOf(page, 'Go'))
    check('...and counts again', Number(await valueOf(page, 'Count')) > Number(held), `${held} -> ${await valueOf(page, 'Count')}`)
    check('...and no row is marked forced', !(await forcedMark(page, 'Go')) && !(await forcedMark(page, 'Count')))
    check('...nor the part in the Scene tree', !(await treeForced('belt')))

    // A force stays through Stop, and the next run holds it from its first scan
    await page.evaluate(() => window.__oip.controller.forcePlcValue('Go', 'false'))
    await page.waitForTimeout(200)
    check('forced again before Stop', (await toolbarCount(page)) === '1 forced', await toolbarCount(page))
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(400)
    check('Stop keeps the force, and the count stays', JSON.stringify(await forces(page)) === '{"Go":false}' && (await toolbarCount(page)) === '1 forced', `${JSON.stringify(await forces(page))} ${await toolbarCount(page)}`)
    check('none of it was an edit of the project', (await edits(page)) === editsBefore, `${editsBefore} -> ${await edits(page)}`)
    await page.evaluate(() => window.__oip.controller.run())
    const rerun = await page
      .waitForFunction(() => (window.__oip.controller.sim.plcState?.watch?.Count ?? 0) > 20, null, { timeout: 90000 })
      .then(() => page.evaluate(() => ({ ...window.__oip.controller.sim.plcState.watch })), () => null)
    check('the next run holds Go FALSE', rerun?.Go === false, JSON.stringify(rerun))
    check('...from its first scan: no scan started with Go TRUE', rerun?.Seen === false, JSON.stringify(rerun))
    check('...shown by the toolbar count, with no notice over the work', (await toolbarCount(page)) === '1 forced' && (await page.locator('[data-testid="save-notice"]').count()) === 0, await toolbarCount(page))

    // A reload whose program no longer has the variable drops its force, and says so
    await page.evaluate((src) => {
      window.__oip.store.loadStProgram(src)
      window.__oip.controller.reloadProgram()
    }, PROGRAM_NO_GO)
    await page.waitForTimeout(400)
    check('a reload drops a force its program no longer has', JSON.stringify(await forces(page)) === '{}' && (await toolbarCount(page)) === null, JSON.stringify(await forces(page)))
    const dropNotice = await page.evaluate(() => document.querySelector('[data-testid="save-notice"]')?.textContent ?? '')
    check('...and says which', /Forces released/.test(dropNotice) && /Go/.test(dropNotice), dropNotice)

    // Loading a scene releases every force: another project's program can reuse the name
    await page.evaluate(() => window.__oip.controller.forcePlcValue('Count', '5'))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__oip.controller.stop())
    check('forced before the scene load', JSON.stringify(await forces(page)) === '{"Count":5}', JSON.stringify(await forces(page)))
    await page.evaluate(() => {
      const st = window.__oip.store
      st.loadScene({ ...st.getState().scene })
    })
    await page.waitForTimeout(200)
    check('loading a scene releases every force, and the count goes', JSON.stringify(await forces(page)) === '{}' && (await toolbarCount(page)) === null, `${JSON.stringify(await forces(page))} ${await toolbarCount(page)}`)

    // ---- the rungs mark a forced contact
    await page.evaluate((src) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      st.commit('Wire the belt', { ...scene, parts: scene.parts.map((p) => (p.id === 'belt' ? { ...p, name: 'Belt_1', params: { ...p.params, runTag: 'Lamp', fpmUnits: false, speedTag: 'Rate' } } : p)) })
      st.loadStProgram(src)
    }, LADDER_PROGRAM)
    await showPlcEditor(page, { face: 'as-is' })
    await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.plcWatch?.Start === false, null, { timeout: 60000 }).catch(() => {})
    const element = (kind) => page.evaluate((k) => {
      const el = document.querySelector(`[data-testid="ld-element"][data-kind="${k}"]`)
      return el ? { on: el.getAttribute('data-on'), forced: el.getAttribute('data-forced') } : null
    }, kind)
    check('running, the contact is drawn unforced', (await element('contact'))?.forced === 'false', JSON.stringify(await element('contact')))
    const why = await page.evaluate(() => window.__oip.controller.forcePlcValue('Start', 'true'))
    await page.waitForTimeout(600)
    check('a forced contact is marked on the rung', (await element('contact'))?.forced === 'true', `${why ?? ''} ${JSON.stringify(await element('contact'))}`)
    check('...with a badge beside its name', (await page.locator('[data-testid="ld-element"][data-kind="contact"] .ld-forced-badge').count()) === 1)
    check('...and passes, so the coil it drives is on and not itself marked', (await element('coil'))?.on === 'true' && (await element('coil'))?.forced === 'false', JSON.stringify(await element('coil')))
    // the badge beside a long name sits against the rail: nothing may clip or cover it
    await page.evaluate(() => window.__oip.controller.forcePlcValue('InfeedPhotoEyeBlocked', 'true'))
    await page.waitForTimeout(600)
    const railBadge = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="ld-element"][data-kind="contact"]')].find((e) => e.textContent.includes('InfeedPhotoEyeBlocked'))
      const badge = el?.querySelector('.ld-forced-badge')
      if (!badge) return { found: false }
      const r = badge.getBoundingClientRect()
      // the points just inside each corner and the middle: each must hit the badge itself, so no edge is clipped or covered
      const pts = [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1], [r.left + r.width / 2, r.top + r.height / 2]]
      const hits = pts.map(([x, y]) => { const at = document.elementFromPoint(x, y); return at === badge || badge.contains(at) })
      return { found: true, width: Math.round(r.width), height: Math.round(r.height), hits }
    })
    check('a forced operand with a long name beside the rail gets its badge too', railBadge.found, JSON.stringify(railBadge))
    check('...drawn whole: every corner of it is on top, neither clipped nor covered', !!railBadge.hits && railBadge.hits.every(Boolean) && railBadge.width >= 6 && railBadge.height >= 8, JSON.stringify(railBadge))
    await page.evaluate(() => window.__oip.controller.releasePlcForces())
    await page.waitForTimeout(600)
    check('released, the mark goes', (await element('contact'))?.forced === 'false', JSON.stringify(await element('contact')))
    // the rung's own right-click menu forces the operand under the pointer, and releases it
    const ldMenu = async () => {
      const box = await page.locator('[data-testid="ld-element"][data-kind="contact"]').first().boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
      const item = page.locator('[data-testid="ladder-force"]')
      await item.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
      return item
    }
    let item = await ldMenu()
    check("the contact's menu offers to force it", /^Force /.test((await item.innerText().catch(() => '')) ?? ''), await item.innerText().catch(() => 'no item'))
    await item.click().catch(() => {})
    await page.waitForTimeout(500)
    check('...which holds it', 'Start' in (await forces(page)), JSON.stringify(await forces(page)))
    item = await ldMenu()
    check('...and then offers to release it', /^Release /.test((await item.innerText().catch(() => '')) ?? ''), await item.innerText().catch(() => 'no item'))
    await item.click().catch(() => {})
    await page.waitForTimeout(500)
    check('...which gives it back', JSON.stringify(await forces(page)) === '{}', JSON.stringify(await forces(page)))

    // ---- a device's tags force the variable a field names
    const org = page.locator('[data-testid="plc-organizer"]')
    await org.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    for (const head of await org.locator('[data-testid="org-device-kind"] > .org-head').all()) await head.click()
    await click(page, '[data-testid="plc-organizer"] [data-testid="org-device"] [data-testid="org-device-tags"]')
    const dlg = page.locator('[data-testid="device-tags-dialog"]')
    await dlg.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    const runForce = dlg.locator('[data-testid="device-force-runTag"]')
    const offered = (await runForce.count()) === 1 && (await runForce.innerText()) === 'Force'
    check("the belt's dialog offers to force its run tag while the program runs", offered, `devices=${await org.locator('[data-testid="org-device"]').count()} dialog=${await dlg.count()}`)
    if (!offered) return
    check('...and none for a field that names no tag', (await dlg.locator('[data-testid="device-force-runningTag"]').count()) === 0)
    await runForce.click()
    await page.waitForTimeout(400)
    // (held at the value it has: Lamp is on, since the release above left Start where the force had put it)
    check('Force there holds the variable the field names, at its value', JSON.stringify(await forces(page)) === '{"Lamp":true}', JSON.stringify(await forces(page)))
    check('...the button turns to Release, and the toolbar counts it', (await runForce.innerText()) === 'Release' && (await toolbarCount(page)) === '1 forced', `${await runForce.innerText()} ${await toolbarCount(page)}`)
    check('...the field is badged forced', (await dlg.locator('[data-testid="device-forced-runTag"]').count()) === 1)
    check('...and the Devices list marks the device', (await org.locator('[data-testid="org-device-forced"]').count()) === 1)
    await runForce.click()
    await page.waitForTimeout(400)
    check('Release there gives it back', JSON.stringify(await forces(page)) === '{}' && (await runForce.innerText()) === 'Force', JSON.stringify(await forces(page)))
    await page.keyboard.press('Escape')

    // ---- the Inspector forces a selected part's tag
    await page.evaluate(() => {
      window.__oip.store.setState({ selectedIds: ['belt'] })
      window.__oip.store.revealPanel('inspector')
    })
    const inspForce = page.locator('[data-testid="inspector-force-runTag"]')
    await inspForce.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    check("the Inspector offers to force the selected belt's run tag while running", (await inspForce.count()) === 1 && (await inspForce.innerText()) === 'Force', await inspForce.innerText().catch(() => 'none'))
    // the live value beside each tag field: what the program holds for the variable the field names
    const liveOf = (key) =>
      page.evaluate((key) => document.querySelector(`[data-param="${key}"] [data-testid="inspector-live-value"]`)?.textContent ?? null, key)
    const lampNow = await page.evaluate(() => window.__oip.controller.plcWatch?.Lamp)
    check('the run tag field shows the live value of its variable', (await liveOf('runTag')) === (lampNow ? 'TRUE' : 'FALSE'), `${await liveOf('runTag')} vs ${lampNow}`)
    check('...and the speed tag field its number', (await liveOf('speedTag')) === '1', String(await liveOf('speedTag')))
    await inspForce.click().catch(() => {})
    await page.waitForTimeout(400)
    check('...which holds the variable the field names', 'Lamp' in (await forces(page)), JSON.stringify(await forces(page)))
    check('...and badges the field', (await page.locator('[data-testid="inspector-forced"]').count()) === 1)
    check('...the badge takes the live value\'s place', (await liveOf('runTag')) === null, String(await liveOf('runTag')))
    // the badge changes the held value: a BOOL flips on a click
    const heldBefore = (await forces(page)).Lamp
    await page.locator('[data-testid="inspector-forced"]').click().catch(() => {})
    await page.waitForTimeout(400)
    check('clicking the forced BOOL badge holds the opposite value', (await forces(page)).Lamp === !heldBefore, `${heldBefore} -> ${JSON.stringify(await forces(page))}`)
    check('...and the badge says so', (await page.locator('[data-testid="inspector-forced"]').innerText().catch(() => '')).includes(heldBefore ? 'FALSE' : 'TRUE'), await page.locator('[data-testid="inspector-forced"]').innerText().catch(() => 'none'))
    await inspForce.click().catch(() => {})
    await page.waitForTimeout(400)
    check('...and Release there gives it back', JSON.stringify(await forces(page)) === '{}', JSON.stringify(await forces(page)))
    check('...and the live value is back', /^(TRUE|FALSE)$/.test((await liveOf('runTag')) ?? ''), String(await liveOf('runTag')))
    // ...and a number opens a field: Enter holds what was typed, Escape holds nothing new
    const speedForce = page.locator('[data-testid="inspector-force-speedTag"]')
    await speedForce.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    await speedForce.click().catch(() => {})
    await page.waitForTimeout(400)
    check('the REAL speed tag forces at its value', (await forces(page)).Rate === 1, JSON.stringify(await forces(page)))
    await page.locator('[data-testid="inspector-forced"]').click().catch(() => {})
    const heldField = page.locator('[data-testid="inspector-forced-input"]')
    await heldField.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await heldField.fill('0.4').catch(() => {})
    await heldField.press('Escape').catch(() => {})
    await page.waitForTimeout(300)
    check('Escape in the held-value field holds nothing new', (await forces(page)).Rate === 1, JSON.stringify(await forces(page)))
    await page.locator('[data-testid="inspector-forced"]').click().catch(() => {})
    await heldField.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await heldField.fill('0.4').catch(() => {})
    await heldField.press('Enter').catch(() => {})
    await page.waitForTimeout(400)
    check('Enter holds the typed number', Math.abs(((await forces(page)).Rate ?? 0) - 0.4) < 1e-6, JSON.stringify(await forces(page)))
    check('...and the field closes back to the badge', (await heldField.count()) === 0 && (await page.locator('[data-testid="inspector-forced"]').count()) === 1)
    await speedForce.click().catch(() => {})
    await page.waitForTimeout(400)
    check('...and Release gives the speed back', JSON.stringify(await forces(page)) === '{}', JSON.stringify(await forces(page)))
    const editsAtEnd = await edits(page)
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(300)
    check('stopped, the Inspector offers no force', (await page.locator('[data-testid="inspector-force-runTag"]').count()) === 0)
    check('forcing from the Inspector was no edit either', (await edits(page)) === editsAtEnd, `${editsAtEnd} -> ${await edits(page)}`)

    // ---- the code's right-click menu forces the variable under the pointer, and releases it
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), PROGRAM)
    await showPlcEditor(page)
    // the code on screen first: the panel swaps the rungs for the text a beat after the program changes
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-line')].some((l) => l.textContent.includes('+ 1')), null, { timeout: 30000 }).catch(() => {})
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => Number(window.__oip.controller.plcWatch?.Count ?? 0) > 20, null, { timeout: 90000 }).catch(() => {})
    const stMenu = async () => {
      const at = await textPoint(page, '+ 1', 'Count')
      if (!at) return null
      await page.mouse.click(at.x, at.y, { button: 'right' })
      const item = page.locator('[data-testid="st-force"]')
      await item.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
      return item
    }
    let stItem = await stMenu()
    check("the code's menu offers to force the variable under the pointer", !!stItem && /^Force /.test((await stItem.innerText().catch(() => '')) ?? ''), stItem ? await stItem.innerText().catch(() => 'no item') : 'no line')
    await stItem?.click().catch(() => {})
    await page.waitForTimeout(400)
    check('...which holds it', 'Count' in (await forces(page)), JSON.stringify(await forces(page)))
    stItem = await stMenu()
    check('...and then offers to release it', !!stItem && /^Release /.test((await stItem.innerText().catch(() => '')) ?? ''), stItem ? await stItem.innerText().catch(() => 'no item') : 'no line')
    await stItem?.click().catch(() => {})
    await page.waitForTimeout(400)
    check('...which gives it back', JSON.stringify(await forces(page)) === '{}', JSON.stringify(await forces(page)))
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(300)
    await page.mouse.click(5, 300)
    const stoppedMenu = await (async () => {
      const at = await textPoint(page, '+ 1', 'Count')
      if (!at) return -1
      await page.mouse.click(at.x, at.y, { button: 'right' })
      await page.locator('[data-testid="st-add-to-watch"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
      const n = await page.locator('[data-testid="st-force"]').count()
      await page.keyboard.press('Escape')
      return n
    })()
    check('stopped, the menu offers no force', stoppedMenu === 0, String(stoppedMenu))
    check('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
