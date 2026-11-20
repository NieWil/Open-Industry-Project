// Verify the wiring report built on the declared tag signals (ParamSpec dir + stType).
// Two comms-enabled diffuse sensors are pointed at the same tag, and both declare it `out`, so the
// scene has two drivers for one signal and whichever part runs last sets it. Neither a free-text
// tag box nor the ST panel's unbound/unwired warnings can see that: they only ask whether a name
// is mentioned somewhere, which it is. So it must show up twice:
//   1. in the Inspector, on the offending field: a direction+type chip and a "clash" chip;
//   2. in the ST panel, as a wiring warning on attach (controller.programStatus.warnings).
// A third part (a belt reading the program's Motor output) is the control: correctly wired, so it
// must stay silent. The check has to be quiet where the scene is right.
// Run: node e2e/verify-wiring-clash.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const PROGRAM = `VAR_INPUT
  PE : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
Motor := PE;
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })

    // scene: two sensors driving 'PE' (the clash), one belt reading the program's 'Motor' (the control)
    const built = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const sensor = getPackage('oip.diffuse-sensor')
      const belt = getPackage('oip.belt-conveyor')
      if (!sensor || !belt) return { ok: false, why: 'packages not registered' }
      store.loadScene({
        version: 4,
        packages: [sensor, belt],
        parts: [
          { id: 's1', type: 'part', packageId: 'oip.diffuse-sensor', position: [0, 0, 0], rotationY: 0, params: { tag: 'PE' } },
          { id: 's2', type: 'part', packageId: 'oip.diffuse-sensor', position: [2, 0, 0], rotationY: 0, params: { tag: 'PE' } },
          { id: 'b1', type: 'part', packageId: 'oip.belt-conveyor', position: [6, 0, 0], rotationY: 0, params: { runTag: 'Motor' } },
        ],
      })
      return { ok: true, parts: store.getState().scene.parts.length }
    })
    check('scene loaded with 3 comms parts', built.ok && built.parts === 3, built.why ?? `parts=${built.parts}`)

    // ---- 2. the ST panel half: attaching the program reports the clash
    const status = await page.evaluate((src) => {
      const { store, controller } = window.__oip
      store.setStProgram(src)
      controller.attachProgram()
      const s = controller.programStatus
      return { warnings: s.warnings, error: s.error, attached: s.attached }
    }, PROGRAM)
    check('program attached without a compile error', status.attached && !status.error, status.error ?? '')
    const wiringWarnings = (status.warnings ?? []).filter((w) => w.startsWith('Wiring'))
    check('a wiring warning names the contested tag', wiringWarnings.some((w) => w.includes('PE') && /2 writers/.test(w)), JSON.stringify(wiringWarnings))
    check('the correctly wired belt raises nothing', !wiringWarnings.some((w) => w.includes('Motor')), JSON.stringify(wiringWarnings))

    // ---- 1. the Inspector half: select a clashing sensor and read its tag field's chips
    await page.evaluate(() => window.__oip.store.select('s1'))
    await page.waitForTimeout(300)
    const chips = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('.field-label')]
      // the diffuse sensor's tag param is labelled 'Presence tag'
      const row = labels.find((l) => /^Presence tag/i.test((l.textContent ?? '').trim()))
      if (!row) return { found: false, labels: labels.map((l) => l.textContent) }
      return {
        found: true,
        text: row.textContent ?? '',
        warnChips: [...row.closest('label').querySelectorAll('[data-testid="tag-warn"][data-kinds~="clash"]')].map((b) => ({ title: b.getAttribute('title') })),
      }
    })
    check('the sensor tag field is in the Inspector', chips.found, JSON.stringify(chips.labels ?? '').slice(0, 200))
    check('it carries the direction + ST type chip', /write/i.test(chips.text ?? '') && /BOOL/.test(chips.text ?? ''), JSON.stringify(chips.text))
    check('its warning mark explains the contention', chips.warnChips?.length === 1 && /another part writes this tag/i.test(chips.warnChips[0].title ?? ''), JSON.stringify(chips.warnChips))

    // ---- the control: the belt's runTag is wired correctly, so no clash chip
    await page.evaluate(() => window.__oip.store.select('b1'))
    await page.waitForTimeout(300)
    const beltChips = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('.field-label')]
      const row = labels.find((l) => /^Run tag/i.test((l.textContent ?? '').trim()))
      if (!row) return { found: false }
      return { found: true, text: row.textContent ?? '', warn: row.closest('label').querySelectorAll('[data-testid="tag-warn"][data-kinds~="clash"]').length }
    })
    check('the belt run tag shows read + BOOL', beltChips.found && /read/i.test(beltChips.text) && /BOOL/.test(beltChips.text), JSON.stringify(beltChips))
    check('a correctly wired field shows NO clash warning', beltChips.warn === 0, JSON.stringify(beltChips))

    // raw shot on purpose: this shot is for the UI chrome (the PLC panel's warning + the chips),
    // which cleanShot() would hide
    await page.screenshot({ path: 'e2e/shots/wiring-clash.png' })
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
