// Verify the Inspector shows the live PLC-commanded conveyor speed, not the authored `speed` param.
//
// The bug: a conveyor's `speedTag` replaces its `speed` param in the behavior
// (`tag ? readNumber(tag) : params.speed`), so while a program commanded 0.5 m/s the Inspector
// went on reading 1, a number nothing in the running scene obeyed. The fix is the schema link
// `setpointFor: 'speed'` on the tag param + the host swapping the live value into that field.
//
// The lifecycle this walks, reading the actual DOM field (not just the model):
//   1. stopped: the authored value, editable, no badge - nothing is commanding it.
//   2. running with the setpoint bound but nothing driving it: the field reads 0, badged - the correct
//      readout of a conveyor that really is dead still (readNumber of an unset tag is 0). This is the
//      quiet half of the same bug: reading the param would show 1 m/s on a conveyor going nowhere.
//   3. A program drives the setpoint to 0.5: the field reads 0.5 and is read-only.
//   4. Re-commanded to 2.5: the field tracks it live, with no reselect.
//   5. Commanded to 0.25 then detached: the authored 1 comes back, editable and unbadged.
//   6. A conveyor with an empty speed tag is not connected, so the program never takes it over.
// Run: node e2e/verify-inspector-live-setpoint.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  const waitForApp = () => page.waitForFunction(
    () => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })

  // Read the Inspector's Speed row straight out of the DOM - what matters is what the user sees.
  const speedRow = () => page.evaluate(() => {
    const row = document.querySelector('.prop-row[data-param="speed"]')
    if (!row) return null
    const input = row.querySelector('.spin-input')
    return {
      text: input?.value ?? null,
      disabled: input?.disabled ?? null,
      plc: row.classList.contains('prop-row-plc'),
      badge: row.querySelector('.field-badge')?.textContent ?? null,
      tooltip: row.querySelector('.field-label')?.getAttribute('title') ?? '',
    }
  })
  // The Inspector polls the live tag table on a 120 ms interval, so the field trails a program swap by a
  // frame or two. Wait for the value rather than sleeping a guessed amount - otherwise a slow machine
  // reads the previous commanded value and the gate is wrong in both directions.
  const awaitSpeed = async (text) => {
    await page.waitForFunction(
      (want) => document.querySelector('.prop-row[data-param="speed"] .spin-input')?.value === want,
      text, { timeout: 8000 },
    ).catch(() => {})
    return speedRow()
  }

  try {
    await page.goto(URL)
    await waitForApp()
    await page.waitForTimeout(1000)
    // Warm-up: the first real ST compile pulls deps a cold vite hasn't optimized, which triggers a mid-test
    // full reload. Compile a throwaway now, wait out the reload, then start clean.
    await page.evaluate(() => {
      try { window.__oip.controller.runProgram('VAR_OUTPUT Warm : REAL; END_VAR\nWarm := 0.0;') } catch { /* warm-up only */ }
      try { window.__oip.controller.stopProgram() } catch { /* ditto */ }
    })
    await page.waitForTimeout(1500)
    await waitForApp()
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp()
    await page.waitForTimeout(800)

    // Two roller conveyors: one wired to tag 'Rate' (PLC-commanded), one with its speed tag empty (hand).
    // Authored speed 1 on both - the value a readout of the param alone shows no matter what the program commands.
    const havePkg = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.roller-conveyor')
      if (!pkg) return false
      const parts = [
        { id: 'conv_auto', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0, 0], rotationY: 0,
          params: { length: 4, speed: 1, standHeight: 1, speedTag: 'Rate' } },
        { id: 'conv_hand', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0, 3], rotationY: 0,
          params: { length: 4, speed: 1, standHeight: 1, speedTag: '' } },
      ]
      st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
      return true
    })
    check('oip.roller-conveyor package available', havePkg)
    await page.waitForTimeout(2000)

    // the schema link the host trusts, on the shipped part
    const declared = await page.evaluate(() => window.__oip.getPackage('oip.roller-conveyor')?.params?.speedTag?.setpointFor ?? null)
    check("roller conveyor declares speedTag setpointFor: 'speed'", declared === 'speed', `got ${JSON.stringify(declared)}`)

    // ── 1. stopped: the authored value, editable, unbadged ──
    await page.evaluate(() => window.__oip.store.select('conv_auto'))
    await page.waitForTimeout(500)
    let row = await speedRow()
    check('Inspector shows the Speed row', row !== null)
    check('STOPPED: shows the authored 1.0, editable, no plc badge',
      row?.text === '1.0' && row.disabled === false && row.plc === false, JSON.stringify(row))

    // ── 2. running with the setpoint bound but nothing driving it ──
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 10000 })
    await page.evaluate(() => window.__oip.controller.stopProgram()) // no program owns 'Rate'
    row = await awaitSpeed('0.0')
    check('RUNNING, setpoint bound but undriven: reads 0.0 - the conveyor really is stopped',
      row?.text === '0.0' && row.plc === true, JSON.stringify(row))

    // ── 3. a program drives the setpoint to 0.5 - the reported bug ──
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Rate : REAL; END_VAR\nRate := 0.5;'))
    row = await awaitSpeed('0.5')
    check('PLC commanding 0.5: the field reads 0.5, NOT the authored 1', row?.text === '0.5', JSON.stringify(row))
    check('PLC-commanded field is read-only (an edit would be silently ignored)', row?.disabled === true)
    check('PLC-commanded field is badged `plc`', row?.plc === true && (row?.badge ?? '').toLowerCase() === 'plc', JSON.stringify(row?.badge))
    check('tooltip names the driving tag and keeps the authored value visible',
      /Rate/.test(row?.tooltip ?? '') && /Authored: 1/.test(row?.tooltip ?? ''), JSON.stringify(row?.tooltip))

    // the unwired twin is untouched: it really is running on its authored speed
    await page.evaluate(() => window.__oip.store.select('conv_hand'))
    const handRow = await awaitSpeed('1.0')
    check('a conveyor with an empty speed tag keeps its authored 1.0, editable',
      handRow?.text === '1.0' && handRow.disabled === false && handRow.plc === false, JSON.stringify(handRow))
    await page.evaluate(() => window.__oip.store.select('conv_auto'))
    await page.waitForTimeout(600)

    // ── 4. the program re-commands: the field tracks it live, no reselect ──
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Rate : REAL; END_VAR\nRate := 2.5;'))
    row = await awaitSpeed('2.5')
    check('a new commanded value tracks live in the open Inspector', row?.text === '2.5', JSON.stringify(row))

    // ── 5. detach: ownership releases, the authored value comes back and is editable ──
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Rate : REAL; END_VAR\nRate := 0.25;'))
    row = await awaitSpeed('0.3') // 0.25 rendered at the param's 1-decimal step
    check('commanded 0.25 shows on the field', row?.text === '0.3', JSON.stringify(row))
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.store.getState().running === false, { timeout: 10000 })
    row = await awaitSpeed('1.0')
    check('after Stop the authored 1.0 returns, editable, unbadged',
      row?.text === '1.0' && row.disabled === false && row.plc === false, JSON.stringify(row))

    // the authored param was never mutated by any of this - it is still a design value
    const authored = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'conv_auto').params.speed)
    check('the authored param itself was never overwritten (the readout is a view, not an edit)', authored === 1, `speed=${authored}`)

    // ── 6b. ctx.report: the effective value, not the raw setpoint. The program commands 2.5 but holds
    // runTag FALSE, so the belt is stopped. Re-deriving from the tag alone can only see 2.5 and would report a
    // moving belt; the behavior reports what it actually drove.
    await page.evaluate(() => {
      const st = window.__oip.store
      const sc = st.getState().scene
      st.loadScene({ ...sc, parts: sc.parts.map((p) => (p.id === 'conv_auto' ? { ...p, params: { ...p.params, runTag: 'Go' } } : p)) })
    })
    await page.waitForTimeout(800)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 10000 })
    await page.evaluate(() => window.__oip.store.select('conv_auto'))
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Rate : REAL; Go : BOOL; END_VAR\nRate := 2.5;\nGo := FALSE;'))
    row = await awaitSpeed('0.0')
    check('runTag-stopped belt reads 0.0 while the setpoint tag says 2.5 (ctx.report, not the tag read)',
      row?.text === '0.0' && row.plc === true, JSON.stringify(row))
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Rate : REAL; Go : BOOL; END_VAR\nRate := 2.5;\nGo := TRUE;'))
    row = await awaitSpeed('2.5')
    check('releasing the run gate lets the same setpoint through', row?.text === '2.5', JSON.stringify(row))
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.store.getState().running === false, { timeout: 10000 })

    // ── 7. the boolean twin: a blade stop's `active` latch, commanded through its autoWhenDriven tag ──
    // Same bug in the other type: the checkbox showing the authored state while the program holds the blade
    // up. The schema link is useParam + autoWhenDriven, already declared, so no second declaration.
    const haveBlade = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.blade-stop')
      if (!pkg) return false
      st.loadScene({
        ...scene,
        parts: [{ id: 'blade', type: 'part', packageId: 'oip.blade-stop', position: [0, 0.9, 0], rotationY: 0,
          params: { width: 0.5, active: false, tag: 'Raise' } }],
        packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg],
      })
      return true
    })
    check('oip.blade-stop package available', haveBlade)
    await page.waitForTimeout(1500)
    const boolRow = () => page.evaluate(() => {
      const row = document.querySelector('.prop-row[data-param="active"]')
      if (!row) return null
      const input = row.querySelector('input[type="checkbox"]')
      return { checked: input?.checked ?? null, disabled: input?.disabled ?? null, plc: row.classList.contains('prop-row-plc') }
    })
    const awaitChecked = async (want) => {
      await page.waitForFunction(
        (w) => document.querySelector('.prop-row[data-param="active"] input[type="checkbox"]')?.checked === w,
        want, { timeout: 8000 },
      ).catch(() => {})
      return boolRow()
    }
    await page.evaluate(() => window.__oip.store.select('blade'))
    await page.waitForTimeout(500)
    let b = await boolRow()
    check('STOPPED: the blade stop\'s Active shows the authored false, editable', b?.checked === false && b.disabled === false, JSON.stringify(b))
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 10000 })
    await page.evaluate(() => window.__oip.controller.runProgram('VAR_OUTPUT Raise : BOOL; END_VAR\nRaise := TRUE;'))
    b = await awaitChecked(true)
    check('a program commanding the blade UP ticks the box (was showing the authored false)',
      b?.checked === true && b.disabled === true && b.plc === true, JSON.stringify(b))
    // ownership releases bumplessly (the device holds its pose), so the authored latch is accurate again
    await page.evaluate(() => window.__oip.controller.stopProgram())
    b = await awaitChecked(false)
    check('after detach the authored latch returns, editable, unbadged',
      b?.checked === false && b.disabled === false && b.plc === false, JSON.stringify(b))
    const bladeAuthored = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'blade').params.active)
    check('the blade stop\'s authored latch was never overwritten either', bladeAuthored === false, `active=${bladeAuthored}`)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
