// Verifies the PLC dock's one command, Reload, end to end in a real browser (StEditor.tsx, commands.ts
// `sim.reloadProgram`, editor/program/programReload.ts):
//   - the dock has no Run and no Stop: the toolbar's transport starts and stops the sim
//   - Ctrl/Cmd-Enter in the code starts a stopped sim (in a browser F5 is the page's, so it is the only run key)
//   - Reload is enabled only while the text on screen differs from what runs: disabled when stopped, disabled when
//     up to date, enabled after an edit, and the running program keeps the old code until it is pressed
//   - a reload that does not compile sends nothing, so the previous program keeps driving the line. The dock says so
//     (never "not attached" while the line is still under control), and Reload says why it is disabled
//   - Play with a program that does not compile runs nothing, and nothing claims a previous program
//   - a runtime fault detaches the program, which enables Reload; the fixed text reloads without a Stop
//   - a scan-time edit enables it where the default table baked the scan time into the program
//   - in a part scene it is refused, and neither the button nor Ctrl/Cmd-Enter attaches the factory program
//     there (both do without attachProgram's part-scene guard)
//
// Run: node e2e/verify-plc-reload.mjs
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
// A declared output keeps the late-program adoption out of the way (it re-attaches only a program that drives
// nothing), so every attach below is one this gate asked for. No trailing newline: the edit step types at the end.
const FIRST = 'VAR_OUTPUT Lamp : BOOL; END_VAR\nVAR Marker : INT; END_VAR\nLamp := TRUE;\nMarker := 1;'
// d starts at 0, so the first scan divides by zero
const FAULTS = 'VAR_OUTPUT Lamp : BOOL; END_VAR\nVAR d : INT; q : INT; END_VAR\nq := DIV(10, d);'
const FIXED = 'VAR_OUTPUT Lamp : BOOL; END_VAR\nVAR d : INT := 2; q : INT; END_VAR\nq := DIV(10, d);'
// a PROGRAM with no table of its own runs from the default one, whose task interval is the scan time
const WITH_PROGRAM = 'PROGRAM Main\nVAR_OUTPUT Lamp : BOOL; END_VAR\nLamp := TRUE;\nEND_PROGRAM\n'

const reload = (page) => page.locator('[data-testid="st-reload"]')
const reloadState = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('[data-testid="st-reload"]')
    return b ? { enabled: !b.disabled, title: b.getAttribute('title') ?? '' } : null
  })
const marker = (page) =>
  page.evaluate(() => {
    const w = window.__oip.controller.plcWatch ?? {}
    const key = Object.keys(w).find((k) => k.toLowerCase() === 'marker')
    return key === undefined ? null : w[key]
  })
const attached = (page) => page.evaluate(() => window.__oip.controller.programStatus.attached)
const waitReload = (page, enabled) =>
  page
    .waitForFunction((want) => document.querySelector('[data-testid="st-reload"]')?.disabled === !want, enabled, { timeout: 8000 })
    .catch(() => {})
const ctrlEnter = async (page) => {
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+Enter')
}

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
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), FIRST)
    await page.evaluate(() => window.__oip.store.revealPanel('st'))
    await reload(page).waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30000 })

    console.log('--- stopped ---')
    for (const name of ['Run', 'Stop']) {
      expect((await page.getByRole('button', { name, exact: true }).count()) === 0, `no "${name}" button anywhere (the transport is the toolbar's)`)
    }
    let r = await reloadState(page)
    expect(r && !r.enabled && /stopped/.test(r.title), `Reload is dim and says the sim is stopped (got ${JSON.stringify(r)})`)
    expect((await page.locator('[data-testid="st-external-plc"]').count()) === 0, 'no external-PLC note where Play cannot hand over (a browser)')

    console.log('--- Ctrl/Cmd-Enter starts the sim ---')
    await ctrlEnter(page)
    await page.waitForFunction(() => window.__oip.store.getState().running && window.__oip.controller.programStatus.attached, null, { timeout: 30000 }).catch(() => {})
    expect(await attached(page), 'the sim runs with the program attached')
    await page.waitForFunction(() => Object.keys(window.__oip.controller.plcWatch ?? {}).length > 0, null, { timeout: 15000 }).catch(() => {})
    // the first watch frame can predate the first scan (Marker still its declared 0); wait for the scan to reach the
    // 10 Hz mirror. Only FIRST is loaded, so this cannot mask a stale program - nothing else could write 1 or not-1
    for (let t = 0; t < 5000 && (await marker(page)) !== 1; t += 100) await page.waitForTimeout(100)
    expect((await marker(page)) === 1, `the running program is the one on screen (Marker = ${await marker(page)})`)
    r = await reloadState(page)
    expect(r && !r.enabled && /up to date/.test(r.title), `Reload is dim while the program is up to date (got ${JSON.stringify(r)})`)

    console.log('--- an edit while running ---')
    // focus(), not click(): while monitoring, the inline value widgets remount every poll and click() waits on a stable box
    await page.locator('.cm-content').first().focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('2;')
    await waitReload(page, true)
    r = await reloadState(page)
    expect(r?.enabled && /not running yet/.test(r.title), `Reload lights once the text is not what runs (got ${JSON.stringify(r)})`)
    await page.waitForTimeout(500)
    expect((await marker(page)) === 1, `...and the running program keeps the old code until it is pressed (Marker = ${await marker(page)})`)
    await reload(page).click()
    await page.waitForFunction(() => {
      const w = window.__oip.controller.plcWatch ?? {}
      const key = Object.keys(w).find((k) => k.toLowerCase() === 'marker')
      return key !== undefined && w[key] === 2
    }, null, { timeout: 15000 }).catch(() => {})
    expect((await marker(page)) === 2, `pressing it runs the edited program (Marker = ${await marker(page)})`)
    expect(await page.evaluate(() => window.__oip.store.getState().running), '...without stopping the sim')
    r = await reloadState(page)
    expect(r && !r.enabled, 'and Reload is dim again')

    console.log('--- a reload that does not compile ---')
    await page.locator('.cm-content').first().focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\nMarker := ;')
    await waitReload(page, true)
    await reload(page).click()
    await page.waitForFunction(() => window.__oip.controller.programStatus.error !== null, null, { timeout: 15000 }).catch(() => {})
    const failed = await page.evaluate(() => window.__oip.controller.programStatus)
    expect(failed.error !== null && failed.attached, `the error is reported, and the program stays attached (got ${JSON.stringify(failed)})`)
    expect(failed.warnings.some((w) => /still running the previous one/.test(w)), '...with a line saying the previous program is still running')
    await page.waitForTimeout(500)
    expect((await marker(page)) === 2, `the previous program keeps scanning (Marker = ${await marker(page)})`)
    expect(await page.evaluate(() => document.body.innerText.includes('still running the previous one')), 'the dock shows that line')
    r = await reloadState(page)
    expect(r && !r.enabled && /still running the previous one/.test(r.title), `Reload is dim and says why, not "up to date" (got ${JSON.stringify(r)})`)
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), FIRST.replace('Marker := 1;', 'Marker := 3;'))
    await waitReload(page, true)
    await reload(page).click()
    await page.waitForFunction(() => window.__oip.controller.programStatus.error === null, null, { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(500)
    const fixedStatus = await page.evaluate(() => window.__oip.controller.programStatus)
    expect((await marker(page)) === 3 && !fixedStatus.warnings.some((w) => /previous/.test(w)), `the fixed text reloads and the note goes (Marker = ${await marker(page)})`)

    console.log('--- a runtime fault, then the fix ---')
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), FAULTS)
    await waitReload(page, true)
    await reload(page).click()
    await page.waitForFunction(() => !!window.__oip.controller.plcFault, null, { timeout: 15000 }).catch(() => {})
    expect(!(await attached(page)), 'the fault dropped the program')
    await waitReload(page, true)
    r = await reloadState(page)
    expect(r?.enabled && /No program is running/.test(r.title), `a dropped program lights Reload (got ${JSON.stringify(r)})`)
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), FIXED)
    await reload(page).click()
    await page.waitForFunction(() => window.__oip.controller.programStatus.attached, null, { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(500)
    expect((await attached(page)) && (await page.evaluate(() => !window.__oip.controller.plcFault)), 'the fixed text reloads and keeps running, no Stop needed')

    console.log('--- a scan-time edit the program cannot take live ---')
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), WITH_PROGRAM)
    await waitReload(page, true)
    await reload(page).click()
    await waitReload(page, false)
    expect((await reloadState(page))?.enabled === false, 'control: up to date after the reload')
    await page.evaluate(() => window.__oip.store.setStScanMs(window.__oip.store.getState().stScanMs * 2))
    await waitReload(page, true)
    expect((await reloadState(page))?.enabled === true, 'a scan-time edit lights Reload where the default table baked the scan time in')

    console.log('--- stop ---')
    await page.locator('button.run-button.stop').click()
    await page.waitForFunction(() => !window.__oip.store.getState().running, null, { timeout: 15000 }).catch(() => {})
    r = await reloadState(page)
    expect(r && !r.enabled && /stopped/.test(r.title), `Reload is dim again once stopped (got ${JSON.stringify(r)})`)

    console.log('--- Play with a program that does not compile ---')
    await page.evaluate(() => window.__oip.store.loadStProgram('VAR_OUTPUT Lamp : BOOL; END_VAR\nLamp := ;'))
    await page.locator('button.run-button.play').click()
    await page
      .waitForFunction(() => window.__oip.store.getState().running && window.__oip.controller.programStatus.error !== null, null, { timeout: 30000 })
      .catch(() => {})
    const none = await page.evaluate(() => window.__oip.controller.programStatus)
    expect(!none.attached && none.error !== null && none.warnings.length === 0, `nothing attaches, and nothing claims a previous program (got ${JSON.stringify(none)})`)
    r = await reloadState(page)
    expect(r && !r.enabled && /running nothing/.test(r.title), `Reload says the PLC is running nothing (got ${JSON.stringify(r)})`)
    await page.locator('button.run-button.stop').click()
    await page.waitForFunction(() => !window.__oip.store.getState().running, null, { timeout: 15000 }).catch(() => {})

    console.log('--- a part scene ---')
    await page.evaluate((s) => window.__oip.store.loadStProgram(s), FIRST)
    await page.evaluate(() => window.__oip.store.enterPartFocus('conv'))
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running, null, { timeout: 30000 }).catch(() => {})
    const blocker = await page.evaluate(() => window.__oip.controller.programReloadBlocker)
    expect(blocker === 'partScene', `the controller refuses a reload there (got ${JSON.stringify(blocker)})`)
    expect(!(await attached(page)), 'control: Play attached no factory program in the part scene')
    if (await reload(page).isVisible()) {
      r = await reloadState(page)
      expect(r && !r.enabled && /Part Editor/.test(r.title), `Reload is dim and says why (got ${JSON.stringify(r)})`)
      if (await page.locator('.cm-content').first().isVisible()) {
        await ctrlEnter(page)
        await page.waitForTimeout(800)
        expect(!(await attached(page)), 'Ctrl/Cmd-Enter does not attach the factory program to the part scene')
      }
    } else console.log('  note: the PLC dock is not on screen in the part scene; checking the controller door only')
    await page.evaluate(() => window.__oip.controller.reloadProgram())
    await page.evaluate(() => window.__oip.controller.attachProgram())
    await page.waitForTimeout(500)
    expect(!(await attached(page)), 'neither reloadProgram() nor attachProgram() attaches it there')
    await page.evaluate(() => window.__oip.controller.stop())
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    console.error('FAIL verify-plc-reload')
    process.exit(1)
  }
  console.log('\nPASS verify-plc-reload')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
