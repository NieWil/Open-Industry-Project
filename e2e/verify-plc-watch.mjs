// The Watch dock, in the browser: chosen variables with their live values, types and wired parts, writes from the
// value cells, the scan times measured in the sim worker, and Add to Watch from the PLC panel's right-click menus
// (components/plc/WatchPanel.tsx, sim/plcHost.ts ScanTime).
//
// plcWatchList.test.ts covers the lookups, plcValueText.test.ts the types and plcHost.test.ts the timing. Only a
// browser can check the path from the worker, where the scans run and are timed, to the dock: that the values move
// and a change is marked, that a write from a cell reaches the running program, that Reset starts the times over,
// that the list is remembered without being an edit, and that a right-click in the code or on a rung lands a
// variable in the dock and brings it forward.
// Run: node e2e/verify-plc-watch.mjs [--headed]
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

const PROGRAM = `VAR
  Go : BOOL := TRUE;
  Count : INT;
  Fill : TON;
  Bins : ARRAY[1..3] OF INT;
END_VAR
Count := Count + 1;
Fill(IN := Go, PT := T#50s);
Bins[1] := Count;
`

const LADDER_PROGRAM = `VAR
  Start : BOOL;
  Lamp : BOOL;
END_VAR
LADDER
  |Start| (Lamp);
END_LADDER
`

// Clicked through the DOM, not locator.click(): a locator waits for its target to hold still across animation frames,
// which a software-rendered scene can stretch past any timeout (e2e/_plc.mjs showText says more).
const click = (page, selector) => page.evaluate((s) => document.querySelector(s)?.click(), selector)
const row = (name) => `[data-testid="plc-watch-row"][data-name="${name}"]`
const cellText = (page, name, testid) => page.evaluate(([s, id]) => document.querySelector(`${s} [data-testid="${id}"]`)?.textContent ?? null, [row(name), testid])
const valueOf = (page, name) => cellText(page, name, 'plc-watch-value')
const scanLine = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="plc-watch-scan-line"]')
    return el ? { text: el.textContent, scans: Number(el.getAttribute('data-scans')), avg: Number(el.getAttribute('data-avg-ms')), max: Number(el.getAttribute('data-max-ms')) } : null
  })

/** The middle of the first `text` on the code line that starts with `lineStart`, in page coordinates. */
const textPoint = (page, lineStart, text) =>
  page.evaluate(([start, word]) => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.trimStart().startsWith(start))
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
  }, [lineStart, text])
const rowNames = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="plc-watch-row"]')].map((r) => r.getAttribute('data-name')))

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, ...(process.env.OIP_BROWSER_CHANNEL ? { channel: process.env.OIP_BROWSER_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const showWatch = async () => {
    await page.evaluate(() => window.__oip.store.revealPanel('watch'))
    await page.locator('[data-testid="plc-watch"]').waitFor({ state: 'visible', timeout: 30000 })
  }
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
    // a belt whose run tag is wired to Go: the Wired to column's part
    await page.evaluate((src) => {
      const st = window.__oip.store
      st.loadScene({
        version: st.getState().scene.version,
        parts: [{ id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[3, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Go' } }],
      })
      st.loadStProgram(src)
    }, PROGRAM)
    await showWatch()
    const stopped = await page.locator('[data-testid="plc-watch-scan"]').innerText()
    check('Watch is a dock of its own; stopped, it says Play brings the values', /Play/.test(stopped), stopped)

    const editsBefore = await page.evaluate(() => window.__oip.store.getEditHistory().events.length)
    const add = page.locator('[data-testid="plc-watch-add-name"]')
    await add.fill('Count, Go Fill.ET')
    await add.press('Enter')
    await add.fill('Bins')
    await click(page, '[data-testid="plc-watch-add"]')
    check('the add box takes several names at once, and one more from its button', (await rowNames(page)).join() === 'Count,Go,Fill.ET,Bins', (await rowNames(page)).join())
    check('picking variables is not an edit of the project', (await page.evaluate(() => window.__oip.store.getEditHistory().events.length)) === editsBefore)
    await page.waitForTimeout(400) // (the types are read a pause after the program text lands)
    const types = `${await cellText(page, 'Count', 'plc-watch-type')} / ${await cellText(page, 'Fill.ET', 'plc-watch-type')}`
    check('the Type column reads the declarations, a timer member included', types === 'INT / TIME', types)
    const wired = await page.evaluate((s) => [...document.querySelectorAll(`${s} [data-testid="plc-watch-part"]`)].map((b) => b.getAttribute('data-part')), row('Go'))
    check('Wired to names the part wired to the variable', wired.join() === 'belt', wired.join())
    await click(page, `${row('Go')} [data-testid="plc-watch-part"]`)
    const selected = await page.evaluate(() => JSON.stringify(window.__oip.store.getState().selectedIds ?? window.__oip.store.getState().selection))
    check('...and a click selects it in the scene', /belt/.test(selected), selected)

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="plc-watch-scan-line"]')?.getAttribute('data-scans') ?? 0) > 50, null, { timeout: 30000 }).catch(() => {})
    const scan = await scanLine(page)
    check('running, the scan line counts the timed scans', (scan?.scans ?? 0) > 50, JSON.stringify(scan))
    check('...with an average and a maximum that make sense', !!scan && scan.avg > 0 && scan.max >= scan.avg && scan.max < 1000, JSON.stringify(scan))
    check('...and the interval it scans on', /every 10 ms/.test(scan?.text ?? ''), scan?.text)

    const c1 = Number(await valueOf(page, 'Count'))
    await page.waitForTimeout(600)
    const c2 = Number(await valueOf(page, 'Count'))
    check('a watched value follows the running program', c2 > c1 && c1 > 0, `${c1} -> ${c2}`)
    const flashes = await page.evaluate((s) => document.querySelector(`${s} [data-testid="plc-watch-value"]`)?.classList.contains('plc-watch-flash'), row('Count'))
    check('...and a value that keeps changing is marked as changed', flashes === true)
    check('a duration shows as a duration', /^T#/.test((await valueOf(page, 'Fill.ET')) ?? ''), await valueOf(page, 'Fill.ET'))
    check('an array shows how many values it holds', /3 values/.test((await valueOf(page, 'Bins')) ?? ''), await valueOf(page, 'Bins'))
    await click(page, `${row('Bins')} .plc-watch-caret`)
    const members = await page.evaluate(() => [...document.querySelectorAll('[data-testid="plc-watch-member"]')].map((r) => r.getAttribute('data-name')))
    check('...and lists them when opened', members.join() === 'Bins[1],Bins[2],Bins[3]', members.join())

    await click(page, `${row('Go')} [data-testid="plc-watch-write"]`)
    await page.waitForFunction(() => window.__oip.controller.plcWatch?.Go === false, null, { timeout: 5000 }).catch(() => {})
    check('clicking a BOOL value writes the opposite value into the program', (await page.evaluate(() => window.__oip.controller.plcWatch?.Go)) === false)
    await page.waitForTimeout(400)
    check('...and the cell shows it', (await valueOf(page, 'Go')) === 'FALSE', await valueOf(page, 'Go'))

    await click(page, `${row('Count')} [data-testid="plc-watch-write"]`)
    const set = page.locator(`${row('Count')} [data-testid="plc-watch-set"]`)
    await set.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    check('clicking a number opens a field on its value', /^[0-9]+$/.test(await set.inputValue().catch(() => '')), await set.inputValue().catch(() => 'no field'))
    await set.fill('20000')
    await set.press('Enter')
    await page.waitForFunction(() => (window.__oip.controller.plcWatch?.Count ?? 0) >= 20000, null, { timeout: 5000 }).catch(() => {})
    check('...and Enter writes what was typed into the program', (await page.evaluate(() => window.__oip.controller.plcWatch?.Count)) >= 20000)
    await click(page, `${row('Count')} [data-testid="plc-watch-write"]`)
    await set.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await set.fill('nope')
    await set.press('Enter')
    const why = await page.locator('[data-testid="plc-watch-error"]').innerText().catch(() => '')
    check('...one that is not a number is refused, saying why', /not a number/.test(why), why)
    await set.press('Escape')
    check('...and Escape closes the field, writing nothing, and clears the refusal', (await set.count()) === 0 && (await page.locator('[data-testid="plc-watch-error"]').count()) === 0)

    const before = (await scanLine(page))?.scans ?? 0
    await click(page, '[data-testid="plc-watch-reset"]')
    await page.waitForTimeout(400)
    const after = (await scanLine(page))?.scans ?? 0
    check('Reset starts the scan times over', after < before && after < 60, `${before} -> ${after}`)

    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(400)
    check('stopped again, the values go and the list stays', /Play/.test(await page.locator('[data-testid="plc-watch-scan"]').innerText()) && (await page.locator('[data-testid="plc-watch-row"]').count()) === 4)

    await page.reload()
    await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
    await showWatch()
    check('the list is remembered across a reload', (await rowNames(page)).join() === 'Count,Go,Fill.ET,Bins', (await rowNames(page)).join())

    // ---- right-click → Add to Watch, from the code: the PLC panel in front, the list emptied
    await click(page, '[data-testid="plc-watch-clear"]')
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), PROGRAM)
    await showPlcEditor(page)
    check('the PLC panel takes the bottom dock from Watch', (await page.locator('[data-testid="plc-watch"]').count()) === 0)
    const onCount = await textPoint(page, 'Count :=', 'Count')
    const onKeyword = await textPoint(page, 'END_VAR', 'END_VAR')
    const item = page.locator('[data-testid="st-add-to-watch"]')
    await page.mouse.click(onCount.x, onCount.y, { button: 'right' })
    await item.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    check('right-clicking a variable in the code offers to watch it', (await item.innerText().catch(() => '')) === 'Add Count to Watch', await item.innerText().catch(() => 'no menu'))
    const editing = await page.evaluate(() => ['st-cut', 'st-copy', 'st-paste', 'st-select-all'].every((id) => document.querySelector(`[data-testid="${id}"]`)))
    check("...beside the editing items the browser's menu had", editing)
    await page.keyboard.press('Escape')

    await page.mouse.click(onKeyword.x, onKeyword.y, { button: 'right' })
    await item.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    check('on a keyword the item is there but off', await item.isDisabled().catch(() => false))
    await click(page, '[data-testid="st-select-all"]')
    await page.waitForTimeout(200)
    // (the layer CodeMirror draws its selection on: the page's DOM selection says little, as it draws its own)
    const selectedAll = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.cm-line')].map((l) => l.getBoundingClientRect())
      const marks = [...document.querySelectorAll('.cm-selectionBackground')].map((m) => m.getBoundingClientRect())
      if (lines.length === 0 || marks.length === 0) return false
      return Math.min(...marks.map((r) => r.top)) <= lines[0].top + 2 && Math.max(...marks.map((r) => r.bottom)) >= lines[lines.length - 1].bottom - 2
    })
    check('Select All from the menu selects the program', selectedAll)
    // (a right-click inside a selection answers for the selection, the whole program here: click it away first)
    await page.mouse.click(onCount.x, onCount.y)

    await page.mouse.click(onCount.x, onCount.y, { button: 'right' })
    await item.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    await click(page, '[data-testid="st-add-to-watch"]')
    await page.locator('[data-testid="plc-watch"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    check('Add to Watch brings the Watch dock forward with the variable on it', (await rowNames(page)).join() === 'Count', (await rowNames(page)).join())

    // ---- and from the rungs
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), LADDER_PROGRAM)
    await showPlcEditor(page, { face: 'as-is' })
    await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForTimeout(600)
    const contact = await page.locator('[data-testid="ld-element"]').first().boundingBox()
    await page.mouse.click(contact.x + contact.width / 2, contact.y + contact.height / 2, { button: 'right' })
    const ldItem = page.locator('[data-testid="ladder-add-to-watch"]')
    await ldItem.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    check('right-clicking a contact offers to watch its variable', (await ldItem.innerText().catch(() => '')) === 'Add Start to Watch', await ldItem.innerText().catch(() => 'no menu'))
    await click(page, '[data-testid="ladder-add-to-watch"]')
    await page.locator('[data-testid="plc-watch"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
    check('...and puts it on the list, the dock forward again', (await rowNames(page)).join() === 'Count,Start', (await rowNames(page)).join())

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
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
