// The native menu while a panel is popped out, in the real desktop shell.
//
// A popped-out panel is a portal target, not an app: its window is about:blank, and the React tree, the
// store and every IPC listener that draws it live in the window that opened it. The native menu
// dispatches to "the focused window", so if it were sent there while focus is in the popup, every menu
// command and every accelerator the menu owns (F5 Run, Save) would go to a page with no listeners and
// do nothing, with no error. Docked panels are unaffected, and no browser gate can catch this: a browser
// has no native menu, and the failure needs a second real OS window.
//
// main.cjs remembers which app window opened each popup (`popoutOwner`) and `appWindow` sends the
// command to that owner. This drives the shell, pops the PLC panel out by its own button, puts the
// focus in the popup, and fires a menu item the way Electron does (click() with the popup as the
// focused window), then asserts the app acted on it.
//
// The probe is Edit > Select All: menu-dispatched, observable in the store, and it changes nothing on
// disk. Confirmed to fail with the fix disabled (stub `appWindow` to `focused || fallback`).
//
// The second part checks the reverse direction: a dialog the menu opens while focus is in the
// popped-out panel must open there (dialogHost.ts), not in the main window behind it.
//
//   node e2e/verify-popout-menu-electron.mjs
/* global process, console, window, document, localStorage */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'
import { FLOATING_PLC_LAYOUT, showPlcEditor } from './_plc.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

/** fire a menu item as Electron does, naming which window is focused when it happens and how it was triggered */
const fireMenuItem = (app, id, focusPopup, viaChord = false) =>
  app.evaluate(({ BrowserWindow, Menu }, { id, focusPopup, viaChord }) => {
    const all = BrowserWindow.getAllWindows()
    const popup = all.find((w) => w.webContents.getURL().startsWith('about:'))
    const main = all.find((w) => !w.webContents.getURL().startsWith('about:'))
    const focused = focusPopup ? popup : main
    if (!focused) throw new Error(focusPopup ? 'no popup window' : 'no app window')
    focused.focus()
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    item?.click({ triggeredByAccelerator: viaChord }, focused, focused.webContents)
    return item?.accelerator ?? null
  }, { id, focusPopup, viaChord })

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
let app
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  // seed the layout only once the app is up: App writes its own layout on mount, overwriting one written too early
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate((layout) => {
    localStorage.setItem('oip-web/tutorial-done', '1')
    localStorage.setItem('oip-web/dock-layout', layout)
  }, FLOATING_PLC_LAYOUT)
  await page.reload()
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await showPlcEditor(page)

  console.log('--- the menu reaches the app while it is docked (the case that always worked) ---')
  await page.evaluate(() => window.__oip.store.selectMany([]))
  await fireMenuItem(app, 'edit.selectAll', false)
  await page.waitForTimeout(400)
  const docked = await page.evaluate(() => window.__oip.store.getState().selectedIds.length)
  expect(docked > 0, `docked: Select All selected ${docked} parts`)

  console.log('--- pop the PLC panel out into a window of its own ---')
  // a real gesture: `popout` is not restorable from storage (dockLayout.ts), because
  // opening a window needs a user action
  await page.click('[aria-label="Pop out to a window"]')
  await page.waitForTimeout(1500)
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
  )
  const popped = windows.filter((u) => u.startsWith('about:')).length === 1
  expect(popped, `a second OS window is open (${windows.length} windows: ${windows.map((u) => u.slice(0, 24)).join(', ')})`)
  if (!popped) throw new Error('the panel did not pop out - the rest of this gate would be vacuous')

  console.log('--- ...and the menu still reaches the app with the focus IN the popup ---')
  await page.evaluate(() => window.__oip.store.selectMany([]))
  const cleared = await page.evaluate(() => window.__oip.store.getState().selectedIds.length)
  expect(cleared === 0, 'selection cleared, so what follows cannot pass on a stale value')
  await fireMenuItem(app, 'edit.selectAll', true) // the popup is the focused window
  await page.waitForTimeout(600)
  const viaPopup = await page.evaluate(() => window.__oip.store.getState().selectedIds.length)
  expect(viaPopup > 0, `with the focus in the popup, Select All still selected ${viaPopup} parts (main.cjs appWindow)`)
  expect(viaPopup === docked, `and selected the same ${docked} parts it does docked`)

  console.log('--- a dialog the menu opens from the popped-out panel opens IN it ---')
  const popupPage = app.windows().find((w) => w.url().startsWith('about:'))
  expect(!!popupPage, 'the popped-out window is drivable as a page')
  // the panel marks itself (`data-plc-panel`) and dialogHost reads the active document, so this is the popup's own
  // focus, not this window's
  const inPanel = await popupPage?.evaluate(() => {
    const el = document.querySelector('[data-plc-panel] .cm-content, [data-plc-panel] [tabindex], [data-plc-panel] button, [data-plc-panel] input')
    el?.focus?.()
    return document.activeElement?.closest('[data-plc-panel]') != null
  })
  expect(inPanel === true, 'the popped-out PLC panel can take the keyboard focus (it marks itself data-plc-panel)')
  await fireMenuItem(app, 'sim.externalPlc', true)
  await popupPage?.locator('[data-testid="controller-props"]').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  expect((await popupPage?.locator('[data-testid="controller-props"]').count()) === 1, 'Simulation > PLC Controllers… opens Controller Properties IN the popup')
  expect((await page.locator('[data-testid="controller-props"]').count()) === 0, 'and not in the main window')

  expect(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`)
} catch (e) {
  failures++
  console.error('  FAIL:', e.message)
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
