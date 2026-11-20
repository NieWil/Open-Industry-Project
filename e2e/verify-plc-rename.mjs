// Renaming a declaration from the PLC panel's text view (F2), in the browser.
//
// tags.test.ts checks that the rename follows scope, and controllerCommit.test.ts checks that the scene's wiring
// changes in the same commit. Only a browser run checks the connection between them: that F2 on the identifier under
// the caret reaches the right scope, that the part in the scene is rewired by the same action, that both are undone
// together by one Ctrl+Z, and that a refusal says why and changes nothing.
//
// A ladder POU renames from its Variables pane. A pure-ST POU (most of an IEC program) has only this F2 rename;
// without it, every use would have to be edited by hand, with no guarantee the wiring follows.
// Run: node e2e/verify-plc-rename.mjs [--headed]
/* global process, console, window, localStorage */
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

// `Run` twice on purpose: the controller's tag, which the conveyor is wired to, and a local of the same name inside
// PROGRAM Line, which a rename of the first must not touch (tags.ts: a local hides the controller's there).
//
// The controller's is a VAR_GLOBAL because that is how a file that declares PROGRAMs declares one. A plain top-level
// VAR block beside a PROGRAM is refused by the model ("a PROGRAM is declared at the top level of a file, before any
// statement"), and a program that does not parse that far cannot be renamed at all, so the gate would test nothing.
const PROGRAM = `VAR_GLOBAL
  Run : BOOL;
END_VAR

PROGRAM Line
VAR
  Run : BOOL;
END_VAR
Run := TRUE;
END_PROGRAM

PROGRAM Other
Run := NOT Run;
END_PROGRAM
`

const stored = (page) => page.evaluate(() => window.__oip.store.getState().stProgram)
const wiring = (page) => page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'belt')?.params?.runTag ?? '(none)')

/** Put the caret on a name in the VAR_GLOBAL block: the controller's tag, not either program's local. */
async function caretOnGlobal(page, name) {
  const offset = await page.evaluate((n) => {
    const src = window.__oip.store.getState().stProgram
    const block = src.indexOf('VAR_GLOBAL')
    const at = block < 0 ? -1 : src.indexOf(n, block)
    return at
  }, name)
  if (offset < 0) throw new Error(`no ${name} in the VAR_GLOBAL block`)
  await page.evaluate((at) => window.__oip.store.revealStOffset(at), offset)
  await page.waitForTimeout(400)
}

async function renameTo(page, name) {
  await page.locator('.cm-content').first().focus()
  await page.keyboard.press('F2')
  const dialog = page.locator('.name-dialog')
  await dialog.waitFor({ state: 'visible', timeout: 15000 })
  const field = dialog.locator('input')
  await field.fill(name)
  await dialog.locator('button', { hasText: 'Rename' }).click()
  await page.waitForTimeout(600)
}

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
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store), null, { timeout: 60000 })

    // A scene with one part, wired to the controller's `Run`. The package goes in with it: a part is rewired through
    // the tag params its package declares (controllerRewire.ts `tagKeys`), so in a scene whose packages are missing
    // nothing is rewired and the gate would fail on its own setup.
    await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
    await page.evaluate(() => {
      const st = window.__oip.store
      const belt = st.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')
      if (!belt) throw new Error('the belt conveyor package is missing')
      st.loadScene({
        version: st.getState().scene.version,
        parts: [{ id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[4, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Run' } }],
        packages: [belt],
      })
    })
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), PROGRAM)
    await showPlcEditor(page)
    await page.waitForTimeout(600)
    check('the belt starts wired to Run', (await wiring(page)) === 'Run', await wiring(page))

    // ---- the rename ----
    await caretOnGlobal(page, 'Run')
    await renameTo(page, 'Motor')
    const after = await stored(page)
    check('the controller tag is renamed where it is declared', /VAR_GLOBAL\s*\n\s*Motor : BOOL;/.test(after), after.split('\n').slice(0, 3).join(' / '))
    check('...and in the PROGRAM that uses it', /PROGRAM Other\s*\nMotor := NOT Motor;/.test(after), /PROGRAM Other[\s\S]{0,40}/.exec(after)?.[0].replace(/\n/g, ' / ') ?? 'not found')
    check("...and the PROGRAM declaring its OWN Run keeps it (a local hides the controller's)", /PROGRAM Line\s*\nVAR\s*\n\s*Run : BOOL;/.test(after) && /^Run := TRUE;$/m.test(after), /PROGRAM Line[\s\S]{0,70}/.exec(after)?.[0].replace(/\n/g, ' / ') ?? '')
    check('the scene followed: the belt is wired to Motor', (await wiring(page)) === 'Motor', await wiring(page))

    // ---- one act, one undo ----
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(600)
    check('Ctrl+Z takes back the text AND the wiring together', (await stored(page)).includes('Run : BOOL') && !(await stored(page)).includes('Motor') && (await wiring(page)) === 'Run', `${await wiring(page)} / ${/\bMotor\b/.test(await stored(page)) ? 'Motor still in text' : 'text back'}`)
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(600)
    check('...and Ctrl+Y puts both back', /Motor := NOT Motor;/.test(await stored(page)) && (await wiring(page)) === 'Motor', await wiring(page))

    // ---- a refusal says why and changes nothing ----
    const before = await stored(page)
    await caretOnGlobal(page, 'Motor') // it is called Motor by now
    await renameTo(page, 'Line') // a POU's name
    check('renaming onto a program name is refused, and the program is untouched', (await stored(page)) === before)
    const report = await page.locator('[data-testid="st-file-report"], .st-file-report').first().innerText().catch(() => '')
    check('...and it says why', /already|program|block/i.test(report), report.split('\n')[0] ?? '(no report)')

    check('no page errors', errors.length === 0, errors[0] ?? '')
  } finally {
    console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

await main()
