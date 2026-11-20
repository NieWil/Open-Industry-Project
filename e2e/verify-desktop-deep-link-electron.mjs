// A browser link opens the desktop app in a room (apps/desktop/deepLink.cjs, src/editor/desktop/desktopLink.ts).
//
// The OS's half - the installer registering `openindustry://` - only an installed app can show, so this drives what
// the OS does with a click instead: it starts the app with the link on its command line, or, with the app already
// running, starts a second copy with it, which hands the link over and quits (main.cjs `second-instance`).
//   1. a launch with a room link opens the window in that room;
//   2. a second launch with another room's link moves the running window into that room, and quits itself;
//   3. a link to the room the window is already in leaves it be;
//   4. a link the app does not understand (a room Share never minted) changes nothing;
//   5. the browser's own button builds a link the shell accepts (desktopLink.test.ts holds the format; here, that
//      the Help row is there in a browser and fires it).
// The window's URL is read from main (webContents.getURL), not from Playwright's page: main navigates the window
// itself, and Playwright's record of a page that main navigated can lag or hang.
//
//   node e2e/verify-desktop-deep-link-electron.mjs
/* global process, console, document, URL, setTimeout, clearTimeout, HTMLAnchorElement */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, chromium } from 'playwright'
import { startServer } from './_server.mjs'

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

const ROOM_A = 'e-0f8fad5b-d9cb-469f-a165-70867728950e'
const ROOM_B = 'e-7c9e6679-7425-40de-944b-e07fc1f90ae7'
const link = (room) => `openindustry://open?room=${room}`

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
const env = { ...process.env, DESKTOP_URL: url }
delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
let app
let browser

/** A second copy of the app on the same profile, as the OS starts one for a click; resolves with its exit code. */
function secondLaunch(arg) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${profileDir}`, arg], { env, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, 30000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

try {
  console.log('--- 1. a launch with a room link opens in that room ---')
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`, link(ROOM_A)], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 90000 })
  const windowUrl = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())
  const roomNow = async () => new URL(await windowUrl()).searchParams.get('room')
  /** poll main for the window's room until `want` or a timeout; returns the last room seen */
  const waitRoom = async (want, ms = 30000) => {
    const end = Date.now() + ms
    let seen = await roomNow()
    while (seen !== want && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 250))
      seen = await roomNow()
    }
    return seen
  }
  expect((await roomNow()) === ROOM_A, `the window opened in the link's room (${await windowUrl()})`)
  const loads = () => app.evaluate(() => globalThis.__loads)
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__loads = 0
    BrowserWindow.getAllWindows()[0].webContents.on('did-start-navigation', (_e, _u, inPlace, isMain) => {
      if (isMain && !inPlace) globalThis.__loads++
    })
  })

  console.log('--- 2. a second launch moves the running window into its room ---')
  const exit = await secondLaunch(link(ROOM_B))
  expect(exit === 0, `the second copy handed the link over and quit (exit ${exit})`)
  expect((await waitRoom(ROOM_B)) === ROOM_B, `the running window moved to the new room (${await windowUrl()})`)
  expect((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1, 'still one window')

  console.log('--- 3. a link to the room it is already in leaves it be ---')
  const before = await loads()
  await secondLaunch(link(ROOM_B))
  await new Promise((r) => setTimeout(r, 1500))
  expect((await loads()) === before && (await roomNow()) === ROOM_B, `no reload (${(await loads()) - before} loads)`)

  console.log('--- 4. a link the app does not understand changes nothing ---')
  await secondLaunch('openindustry://open?room=legacy-room')
  await secondLaunch(`openindustry://folder?room=${ROOM_A}`)
  await new Promise((r) => setTimeout(r, 1500))
  expect((await loads()) === before && (await roomNow()) === ROOM_B, `still in the same room, not reloaded (${await windowUrl()})`)
} catch (err) {
  failures++
  console.error('  FAIL: threw', err)
} finally {
  await app?.close().catch(() => {})
}

try {
  console.log('--- 5. the browser offers the button, and it fires the link ---')
  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(new URL(`/app/?room=${ROOM_A}`, url).toString())
  await page.waitForSelector('.toolbar', { timeout: 90000 })
  // record the link the button hands the OS instead of letting the browser try to open it
  await page.evaluate(() => {
    globalThis.__fired = []
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.href.startsWith('openindustry:')) globalThis.__fired.push(this.href)
      else click.call(this)
    }
  })
  await page.click('.help-button')
  await page.click('[data-testid="help-open-desktop"]')
  const fired = await page.evaluate(() => globalThis.__fired)
  expect(fired.length === 1 && fired[0] === link(ROOM_A), `the button fired this room's link (${fired.join(', ')})`)
  // nothing took it (headless, no app), so after a moment the page says where to get one
  const notice = await page
    .waitForFunction(
      () => (document.querySelector('[data-testid="save-notice"]')?.textContent ?? '').includes('Desktop app did not open'),
      null,
      { timeout: 15000 },
    )
    .then(() => true, () => false)
  expect(notice, 'with no app to take it, the page says where to get one')
} catch (err) {
  failures++
  console.error('  FAIL: threw', err)
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nPASS')
process.exit(failures ? 1 : 0)
