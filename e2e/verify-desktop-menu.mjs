// The native menu is rendered from the renderer's command registry (src/editor/commands.ts), not
// authored in main.cjs. This gate reads the menu Electron actually built and checks the three things
// that go wrong when a menu holds its own copy of the app:
//
//   1. it shows what the registry says (labels, and the chord hints for keys the app binds),
//   2. it still carries the items main owns outright (parts workspace, help links, quit),
//   3. its enablement tracks editor state. A menu that can't see the selection leaves Edit → Cut
//      permanently clickable, silently doing nothing.
//
//   node e2e/verify-desktop-menu.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

let failed = false
const check = (label, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
}

const readMenu = (app) =>
  app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    if (!menu) return []
    return menu.items.map((section) => ({
      label: section.label,
      items: (section.submenu?.items ?? []).map((i) => ({
        id: i.id ?? null,
        label: i.label,
        type: i.type,
        accelerator: i.accelerator ?? null,
        enabled: i.enabled,
      })),
    }))
  })

const { url, vite } = await startServer()
let app
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'oip-menu-'))}`],
    env,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })

  // main boots with a shell-only bootstrap menu and swaps in the real one when the model lands, so
  // wait for a command item rather than asserting against whichever menu happens to be up
  let menu = []
  for (let i = 0; i < 60 && !menu.some((s) => s.items.some((it) => it.id === 'file.openDemo')); i++) {
    menu = await readMenu(app)
    if (!menu.some((s) => s.items.some((it) => it.id === 'file.openDemo'))) await page.waitForTimeout(250)
  }
  const section = (label) => menu.find((s) => s.label === label)
  const item = (sectionLabel, id) => section(sectionLabel)?.items.find((i) => i.id === id)
  const labels = (sectionLabel) => (section(sectionLabel)?.items ?? []).map((i) => i.label)

  // ── 1. built from the registry ──────────────────────────────────────────────────────────────────
  check("the menu has the app sections", ['File', 'Edit', 'Simulation', 'View', 'Help'].every((l) => !!section(l)), menu.map((s) => s.label).join(' · '))
  check("File carries the registry file commands", ['New Project…', 'Import Project…', 'Open Demo', 'Save', 'Export Project (.oip)…'].every((l) => labels('File').includes(l)), labels('File').join(' · '))
  // a project holds one scene: the registry has no scene-list add / rename / delete, so neither must the
  // menu main renders from it
  const sceneItems = menu.flatMap((s) => s.items).filter((i) => typeof i.id === 'string' && i.id.startsWith('scene.'))
  check('no scene-list commands are left in the menu', sceneItems.length === 0, sceneItems.map((i) => `${i.id} (${i.label})`).join(' · '))
  check('View carries the palette', labels('View').includes('Command Palette…'), labels('View').join(' · '))

  // Two kinds of accelerator, and the difference matters: the menu registers F5 (nothing else binds
  // it), while Ctrl+Z is only displayed - the app's own keydown owns it, and registering it here
  // would run undo twice per press.
  check('menu-owned chord reaches the menu', item('Simulation', 'sim.run')?.accelerator === 'F5', String(item('Simulation', 'sim.run')?.accelerator))
  check('app-owned chord is shown as a hint', item('Edit', 'edit.undo')?.accelerator === 'CmdOrCtrl+Z', String(item('Edit', 'edit.undo')?.accelerator))

  // ── 2. main's own items survived the handover ───────────────────────────────────────────────────
  // importing a folder of parts is the Parts panel's Import part, one way in, not a second item here
  check('the File menu has no separate parts import', !labels('File').some((l) => /Import Parts/.test(l)), labels('File').join(' · '))
  check('the Help links are still there', labels('Help').includes('Documentation') && labels('Help').includes('View on GitHub'), labels('Help').join(' · '))

  // ── 3. enablement tracks the editor ─────────────────────────────────────────────────────────────
  // main alone cannot see a selection, so a menu built once there would leave Cut clickable forever.
  await page.evaluate(() => window.__oip.store.clearSelection?.() ?? window.__oip.store.selectMany([]))
  await page.waitForTimeout(400)
  menu = await readMenu(app)
  check('Cut is greyed with nothing selected', item('Edit', 'edit.cut')?.enabled === false, `enabled=${item('Edit', 'edit.cut')?.enabled}`)

  await page.evaluate(() => {
    const s = window.__oip.store
    s.selectMany(s.getState().scene.parts.map((p) => p.id))
  })
  await page.waitForTimeout(400)
  menu = await readMenu(app)
  check('Cut enables once something is selected', item('Edit', 'edit.cut')?.enabled === true, `enabled=${item('Edit', 'edit.cut')?.enabled}`)

  // playback: Run available while idle, Stop only while running
  check('Stop is greyed while idle', item('Simulation', 'sim.stop')?.enabled === false)
  await page.locator('.toolbar-run .run-button.play').click()
  await page.waitForFunction(() => window.__oip.store.getState().running === true, null, { timeout: 20000, polling: 200 })
  await page.waitForTimeout(400)
  menu = await readMenu(app)
  check('Run/Stop swap once the sim starts', item('Simulation', 'sim.run')?.enabled === false && item('Simulation', 'sim.stop')?.enabled === true, `run=${item('Simulation', 'sim.run')?.enabled} stop=${item('Simulation', 'sim.stop')?.enabled}`)
  await page.locator('.toolbar-run .run-button.stop').click()

  // A displayed-but-unregistered accelerator is invisible in MenuItem, so prove it by behaviour:
  // if the menu had also registered Ctrl+Z, one press would undo twice.
  await page.evaluate(() => {
    const s = window.__oip.store
    s.selectMany([s.getState().scene.parts[0].id])
    s.duplicateSelection()
    s.duplicateSelection()
  })
  const grew = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
  await page.keyboard.press("Control+z")
  await page.waitForTimeout(600)
  const afterUndo = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
  check('Ctrl+Z undoes exactly once (no double-fire from the menu)', afterUndo === grew - 1, `${grew} parts, then ${afterUndo}`)

  // ── 4. the menu still does things: dispatch by id reaches the command ────────────────────────────
  // Probed on demoSession: the demo is the built-in example, which becomes a project of its own only once it is
  // edited, so the session flag is the one thing that says the command ran. Open Demo reloads into it, so the probe
  // tolerates the hook being briefly absent.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.openDemo'))
  const ran = await page
    .waitForFunction(() => window.__oip?.store?.getState().demoSession === true, null, { timeout: 90000, polling: 200 })
    .then(() => true)
    .catch(() => false)
  check('a menu command id runs its command', ran)
} catch (err) {
  failed = true
  console.log('FAIL', err?.message || err)
} finally {
  if (app) await app.close().catch(() => {})
  vite.kill()
}

console.log(failed ? '\nFAIL' : '\nPASS')
process.exit(failed ? 1 : 0)
