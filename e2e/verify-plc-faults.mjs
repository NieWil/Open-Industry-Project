// Controller faults, in the browser, on the IEC ladder sheet: a fault stops the scan, its message is left in the panel,
// it is drawn on the element it happened in, and "Show" selects that element. The panel owns the faults
// (src/editor/components/plc/plcFaults.ts). A corrected program loaded afterwards runs with no fault left over.
//
// faults.ts and its tests cover the engine. Only a browser can check the path from the sim worker, where the scan
// runs, to the rung on screen: that a fault stops the program and leaves its message, that it is marked on the right
// element of the right rung, and that a click on the fault's line selects it.
// Run: node e2e/verify-plc-faults.mjs [--headed]
/* global process, console, window, document, localStorage */
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

/** The selected element, as `MODE@rung` (its `data-trail` is routine/rung/trail). */
const selectedElement = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="ld-element"].sel')
  return el ? `${el.getAttribute('data-mode')}@${(el.getAttribute('data-trail') ?? '').split('/')[1]}` : 'nothing'
})

// a few scans in, the count pushes the contact's subscript past the end of its array, and the scan faults there
const PROGRAM = `VAR
  Always : BOOL := TRUE;
  Scans : INT;
  Bits : ARRAY[0..19] OF BOOL;
  Lamp : BOOL;
END_VAR
LADDER
  |Always| ADD(IN1 := Scans, IN2 := 1, OUT => Scans);
  |Bits[Scans]| (Lamp);
END_LADDER
`

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
    await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
    await page.evaluate((src) => {
      const st = window.__oip.store
      st.loadScene({ version: st.getState().scene.version, parts: [] })
      st.loadStProgram(src)
    }, PROGRAM)
    await showPlcEditor(page, { face: 'as-is' })
    await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForTimeout(600)
    check('the program is clean before it runs', (await page.locator('[data-testid="ladder-problem"], [data-testid="ladder-warning"]').count()) === 0)

    // (the PLC panel has no Run button; runs start from the toolbar's Play or Ctrl+Enter, so call run() directly)
    await page.evaluate(() => window.__oip.controller.run())
    // the fault ends the run by itself, a few scans in: wait for its message
    await page.locator('[data-testid="st-error"]').waitFor({ state: 'visible', timeout: 30000 })
    const faultText = await page.locator('[data-testid="st-error"]').innerText()
    check('the fault stopped the program', /runtime fault: .*out of bounds/.test(faultText), faultText)
    check('...and the program is no longer attached', await page.evaluate(() => window.__oip.controller?.programStatus?.attached === false))
    check('no minor fault log - an IEC fault always stops the scan', (await page.locator('[data-testid="st-minor-faults"]').count()) === 0)
    const rungs = page.locator('[data-testid="ladder-rung"]')
    check('the fault is an error on rung 1, and on no other', /runtime fault/.test(await rungs.nth(1).locator('[data-testid="ladder-problem"]').first().innerText().catch(() => '')) && (await rungs.nth(0).locator('[data-testid="ladder-problem"]').count()) === 0)
    await rungs.nth(0).locator('[data-testid="ld-element"]').first().click()
    await page.locator('[data-testid="st-fault-show"]').click()
    await page.waitForTimeout(300)
    const selected = await selectedElement(page)
    check('"Show where it faulted" selects the contact the subscript was on', selected === 'open@1', selected)

    // a new run of a corrected program: the subscript stays in range, and no fault is left over
    // (loaded wholesale: a wholesale load is the one store write every mounted editor re-syncs to)
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), PROGRAM.replace('|Bits[Scans]|', '|Bits[0]|'))
    await page.waitForTimeout(600)
    check('the fault was about the OLD program: a new one is drawn without it', (await page.locator('[data-testid="ladder-problem"], [data-testid="ladder-warning"]').count()) === 0)
    await page.evaluate(() => (window.__oip.store.getState().running ? window.__oip.controller.reloadProgram() : window.__oip.controller.run()))
    await page.waitForFunction(() => (window.__oip.controller?.plcScanStats?.scansRun ?? 0) > 30, null, { timeout: 30000 }).catch(() => {})
    check('the corrected program runs with nothing faulted', await page.evaluate(() => {
      const c = window.__oip.controller
      return c.programStatus.attached && c.programStatus.error === null && c.plcFaults.fault === null
    }), JSON.stringify(await page.evaluate(() => window.__oip.controller.programStatus)))
    check('and the panel shows no fault', (await page.locator('[data-testid="st-error"]').count()) === 0)

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
