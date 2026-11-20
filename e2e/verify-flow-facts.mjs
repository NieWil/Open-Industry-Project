// Verifies that a run's flow facts (src/core/flow/flowFacts.ts) reach the main thread, end to end in a real browser: the sim
// worker collects them and the client's log keeps them (core/flow/flowFactLog.ts), which get_problems reads.
//   - a box running off the end of a conveyor with nothing to catch it is a 'dropped' fact naming the conveyor
//   - facts are not problems: the Problems dock lists no row for it, and its error and warning counts do not move
//   - the log outlasts Stop, and the next Run empties it
//
// Run: node e2e/verify-flow-facts.mjs
/* global process, console, window, document, localStorage, requestAnimationFrame */
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

// a running conveyor (no comms: it runs at its own speed) with a spawner over its tail and nothing past its head end, so
// every box rides off the end and falls to the floor. Low (bed at 0.45 m) so a box leaves the bed and lands within the
// tracker's half-second trail, which is how a drop names the conveyor it came off (core/flow/flowFacts.ts lastOn)
const SCENE = {
  version: 4,
  parts: [
    { id: 'belt', type: 'part', packageId: 'oip.roller-conveyor', name: 'Line', position: [0, 0.45, 0], rotationY: 0, params: { length: 4 } },
    { id: 'infeed', type: 'part', packageId: 'oip.box-spawner', name: 'Infeed', position: [-1.5, 1.0, 0], rotationY: 0, params: { boxesPerMinute: 30 } },
  ],
}

const counts = (page) => page.evaluate(() => `${document.querySelector('.problems-count')?.textContent ?? '?'} | ${document.querySelector('.problems-toggle')?.textContent ?? '?'}`)
const rowCount = (page) => page.evaluate(() => document.querySelectorAll('.problems-row').length)

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
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), null, { timeout: 120000 })
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.roller-conveyor') && !!window.__oip.getPackage?.('oip.box-spawner'), null, { timeout: 60000 })
    // the packages ride along: the spawner's part is not built (no box ever spawns) without its definition in the scene
    await page.evaluate((s) => window.__oip.store.loadScene({ ...s, packages: [window.__oip.getPackage('oip.roller-conveyor'), window.__oip.getPackage('oip.box-spawner')] }), SCENE)
    await page.evaluate(() => window.__oip.store.revealPanel('problems'))
    await page.waitForFunction(() => !!document.querySelector('.problems-panel'), null, { timeout: 8000 })
    const before = await counts(page)
    const rowsBefore = await rowCount(page)

    console.log('--- run: boxes ride off the end of the conveyor ---')
    await page.evaluate(() => window.__oip.controller.run())
    // the positive signal: the client's log holds a dropped fact (no fixed wait; a box needs a few seconds to fall)
    const dropped = await page
      .waitForFunction(() => window.__oip.controller.sim.flowFacts.all().some((f) => f.kind === 'dropped'), null, { timeout: 60000 })
      .then(() => true, () => false)
    expect(dropped, 'the run collected a dropped fact')
    const fact = await page.evaluate(() => window.__oip.controller.sim.flowFacts.all().find((f) => f.kind === 'dropped') ?? null)
    expect(fact?.part === 'belt', `it names the conveyor the box fell from (got ${JSON.stringify(fact?.part)}: ${fact?.message})`)
    expect(/fell to the floor/.test(fact?.message ?? ''), `its message is the fact as the tracker wrote it (${fact?.message})`)
    // let the dock render whatever it would for the fact before reading it
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect((await rowCount(page)) === rowsBefore, `the Problems dock lists no row for it (${rowsBefore} -> ${await rowCount(page)} rows)`)
    expect((await counts(page)) === before, `the error and warning counts did not move (${before} -> ${await counts(page)})`)

    console.log('--- stop ---')
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => !window.__oip.store.getState().running, null, { timeout: 8000 })
    const kept = await page.evaluate(() => window.__oip.controller.sim.flowFacts.size)
    expect(kept > 0, `the log keeps the facts after Stop (${kept})`)

    console.log('--- run again ---')
    const sizeAtRun = await page.evaluate(() => {
      window.__oip.controller.run()
      return window.__oip.controller.sim.flowFacts.size
    })
    expect(sizeAtRun === 0, `Run empties the log (it held ${sizeAtRun} facts after the call)`)
    await page.evaluate(() => window.__oip.controller.stop())
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    console.error('FAIL verify-flow-facts')
    process.exit(1)
  }
  console.log('\nPASS verify-flow-facts')
}

main().catch((e) => {
  console.error(e)
  console.error('FAIL verify-flow-facts')
  process.exit(1)
})
