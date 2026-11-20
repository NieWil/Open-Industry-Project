// Verifies the in-app project-test run (src/editor/project/projectTestsRun.ts + TestResultsOverlay) end to
// end in a real browser:
//   - the command is disabled while the project carries no tests, and reachable once it does
//   - running it loads jolt lazily, steps real physics + the ST scan in-tab, and shows a verdict
//     per spec with the individual check details
//   - a passing and a failing spec are told apart, and the failing one's passing checks still show
//     as passing (CSS scoping: a blanket rule would turn every mark in a failed row red)
//
// The project is program-only on purpose: a VAR_OUTPUT name is a global tag key (see
// projectTestRunner's "the program's own output names are the global keys"), so this needs no parts
// and no part baking, which keeps the gate about the run rather than about the catalog.
//
// Run: node e2e/verify-project-tests-ui.mjs
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

// the canonical seal-in, with no parts: Start latches Run, Stop breaks it
const ST_PROGRAM = `VAR_INPUT
  Start : BOOL;
  Stop : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR

Run := (Run OR Start) AND NOT Stop;
`

const PROJECT = {
  version: 4,
  name: 'Graded',
  scene: { version: 4, parts: [] },
  stProgram: ST_PROGRAM,
  tests: [
    {
      name: 'seal-in latches and unlatches',
      duration: 2,
      inputs: [
        { at: 0.5, tag: 'Start', value: true },
        { at: 0.6, tag: 'Start', value: false },
        { at: 1.5, tag: 'Stop', value: true },
      ],
      checks: [
        { at: 0.2, tag: 'Run', equals: false },
        { eventually: true, within: 1.0, tag: 'Run', equals: true },
        { at: 1.9, tag: 'Run', equals: false },
      ],
    },
    {
      // deliberately wrong: Run is latched at t=1, so asserting false must fail. Its first check is
      // true, which shows a failed row still renders its passing checks as passing.
      name: 'deliberately failing',
      duration: 2,
      inputs: [{ at: 0.5, tag: 'Start', value: true }],
      checks: [
        { at: 0.2, tag: 'Run', equals: false },
        { at: 1.0, tag: 'Run', equals: false },
      ],
    },
  ],
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 120000 })
}

// The palette re-renders on every store tick, so a Playwright element handle goes stale between
// polls (waitForSelector reports the node visible and still times out). Everything below therefore
// polls and types in-page, where there is no handle to go stale.
async function openPalette(page, query) {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => !!document.querySelector('.palette-input'), { timeout: 5000 })
  await page.evaluate((q) => {
    const input = document.querySelector('.palette-input')
    // React controls this input, so assigning .value directly is ignored; go through the native
    // setter and fire the event React actually listens to
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, q)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }, query)
  await page.waitForTimeout(200)
}

/** the "Run Project Tests" row's state in the open palette (found:false = not listed at all) */
async function paletteRow(page) {
  return page.evaluate(() => {
    const row = [...document.querySelectorAll('.palette-item')].find((b) =>
      b.textContent?.includes('Run Project Tests'),
    )
    return row ? { found: true, disabled: row.disabled } : { found: false, disabled: null }
  })
}

async function closePalette(page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (e) => {
      failures++
      console.error('  FAIL: page error:', e.message)
    })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage - the tour just shows up, harmless here */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`, { timeout: 180000 })
    await waitForApp(page)
    await page.waitForTimeout(2000)

    console.log('--- enablement ---')
    await openPalette(page, 'Run Project')
    const before = await paletteRow(page)
    await closePalette(page)
    expect(before.found && before.disabled === true, 'the command is greyed out before any test exists')
    expect(
      await page.evaluate(() => window.__oip.store.getState().testCount === 0),
      'testCount starts at 0',
    )

    console.log('--- load a graded project ---')
    await page.evaluate((project) => window.__oip.store.loadProject(project), PROJECT)
    await page.waitForTimeout(400)
    expect(
      await page.evaluate(() => window.__oip.store.getState().testCount === 2),
      'loadProject publishes the test count',
    )
    await openPalette(page, 'Run Project')
    const after = await paletteRow(page)
    expect(after.found && after.disabled === false, 'the command becomes available once the project carries tests')

    console.log('--- run them ---')
    await page.keyboard.press('Enter')

    await page.waitForSelector('[data-test-results-overlay]', { timeout: 10000 })
    expect(true, 'the verdict overlay opens')
    // jolt is a lazy import + a wasm init, then two 2 s sims: generous, but it must actually finish
    await page.waitForFunction(
      () => document.querySelectorAll('[data-test-results-overlay] .test-run-row').length === 2,
      { timeout: 60000 },
    )

    const verdicts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-test-results-overlay] .test-run-row')].map((row) => ({
        name: row.querySelector('.test-run-name')?.textContent?.replace(/^[✓✗]/, '').trim(),
        ok: row.getAttribute('data-ok'),
        checks: [...row.querySelectorAll('.test-run-check')].map((c) => c.getAttribute('data-ok')),
        error: row.querySelector('.test-run-error')?.textContent ?? null,
      })),
    )
    console.log(JSON.stringify(verdicts, null, 2))

    expect(verdicts[0]?.error === null, 'the first spec ran (no thrown error)')
    expect(verdicts[0]?.name === 'seal-in latches and unlatches', 'the first row is named from the spec')
    expect(verdicts[0]?.ok === 'true', 'the correct spec PASSES - real ST scan + physics, in-tab')
    expect(
      verdicts[0]?.checks.length === 3 && verdicts[0].checks.every((c) => c === 'true'),
      'all three of its checks are shown, and pass',
    )

    expect(verdicts[1]?.ok === 'false', 'the deliberately-wrong spec FAILS')
    expect(
      verdicts[1]?.checks[0] === 'true' && verdicts[1]?.checks[1] === 'false',
      'inside the failed row, the passing check still reads as passing',
    )

    const summary = await page.textContent('[data-test-run-summary]')
    expect(/1 of 2 tests failed/.test(summary ?? ''), `the summary counts the failure (got: ${summary})`)
    const state = await page.getAttribute('[data-test-run-summary]', 'data-state')
    expect(state === 'fail', 'the summary is marked as a failure for styling')

    // deliberately a raw screenshot, not cleanShot: this captures the UI chrome
    if (process.env.OIP_SHOT) await page.screenshot({ path: process.env.OIP_SHOT })

    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    expect(
      (await page.locator('[data-test-results-overlay]').count()) === 0,
      'Escape closes the overlay',
    )
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall project-test UI checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
