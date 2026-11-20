// Verifies that a PLC runtime fault reaches the Problems dock and stays after the run, end to end in a real
// browser: the scan faults in the sim worker, the client relays it, the controller keeps it, the dock lists it.
//   - a DIV() by zero faults with the call's line (not as a plain Error with no line)
//   - the Problems dock lists it as a Program error at that line while the run is up
//   - it is still there after Stop (the PLC panel's status line clears on Stop; this entry stays)
//   - editing the program clears it (the line it names may have moved, and the edit may be the fix)
//
// Run: node e2e/verify-plc-fault-in-problems.mjs
/* global process, console, window, document, localStorage */
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

const SCENE = {
  version: 4,
  parts: [{ id: 'conv', type: 'part', packageId: 'oip.roller-conveyor', name: 'Line', position: [0, 1, 0], rotationY: 0, params: { length: 4 } }],
}
// d starts at 0, so the first scan divides by zero
const FAULTS = 'VAR d : INT; q : INT; END_VAR\nq := DIV(10, d);'
const FIXED = 'VAR d : INT := 2; q : INT; END_VAR\nq := DIV(10, d);'

const faultRows = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.problems-row')].map((r) => r.textContent ?? '').filter((t) => /scan faulted/.test(t)))

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (e) => {
      failures++
      console.error('  FAIL: page error:', e.message)
    })
    await page.addInitScript(() => {
      try {
        localStorage.clear()
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage: harmless here */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 60000 })
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.roller-conveyor'), { timeout: 60000 })
    await page.evaluate((s) => window.__oip.store.loadScene(s), SCENE)
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), FAULTS)
    await page.evaluate(() => window.__oip.store.revealPanel('problems'))
    await page.waitForFunction(() => !!document.querySelector('.problems-panel'), { timeout: 8000 })
    expect((await faultRows(page)).length === 0, 'control: no fault row before the program runs')

    console.log('--- run a program that divides by zero ---')
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => !!window.__oip.controller.plcFault, { timeout: 30000 }).catch(() => {})
    const fault = await page.evaluate(() => window.__oip.controller.plcFault)
    expect(fault?.message === 'division by zero', `the scan faulted (got ${JSON.stringify(fault?.message)})`)
    expect(fault?.line === 2 && fault?.col === 6, `at the DIV call, line 2 col 6 (got ${fault?.line}:${fault?.col})`)
    await page.waitForFunction(() => [...document.querySelectorAll('.problems-row')].some((r) => /scan faulted/.test(r.textContent ?? '')), { timeout: 8000 }).catch(() => {})
    const running = await faultRows(page)
    expect(running.length === 1 && /Line 2/.test(running[0]), `the dock lists it at line 2 (got ${JSON.stringify(running)})`)

    console.log('--- stop, then edit ---')
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(300)
    expect((await faultRows(page)).length === 1, 'it is still listed after Stop')
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), FIXED)
    // (the panel's report comes from the program worker: wait for the row to go, not for a fixed time)
    await page.waitForFunction(() => ![...document.querySelectorAll('.problems-row')].some((r) => /scan faulted/.test(r.textContent ?? '')), { timeout: 8000 }).catch(() => {})
    expect((await faultRows(page)).length === 0, 'editing the program retires it')
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    console.error('FAIL verify-plc-fault-in-problems')
    process.exit(1)
  }
  console.log('\nPASS verify-plc-fault-in-problems')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
