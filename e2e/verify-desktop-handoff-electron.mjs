// A browser's solo project, handed over to the desktop app (src/collab/handoff.ts, src/editor/desktop/desktopLink.ts,
// src/editor/desktop/desktopHandoff.ts), end to end against the real collab server.
//
//   1. a browser tab with a named project of its own presses Help > Open in Desktop App: it fires a
//      `openindustry://open?handoff=<secret>` link and uploads the project's .oip bytes to that private document;
//   2. the link reaches the running desktop app the way a click's would (a second copy started with it, which hands it
//      over and quits; apps/desktop/main.cjs), and the app asks, then imports the project as a new one;
//   3. the hand-over document is empty afterwards, so the project is not left on the server;
//   4. a browser whose link no app takes says so, and clears what it uploaded.
// The server is server/index.mjs on a free port with a temp db; the dev server is isolated so the app's
// VITE_COLLAB_URL points at it. The desktop's confirm() is answered from main (Playwright cannot see an Electron
// page's native dialogs), and the browser's link is caught rather than handed to this machine's OS.
//
//   node e2e/verify-desktop-handoff-electron.mjs
/* global process, console, window, document, URL, setTimeout, clearTimeout, HTMLAnchorElement, Event */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

// ── the collab server, and a dev server pointed at it ──
const collabPort = await freePort()
const tmp = mkdtempSync(join(tmpdir(), 'oip-handoff-'))
const collab = spawn(process.execPath, ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: join(tmp, 'db.sqlite') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => String(d).includes('listening') && (clearTimeout(t), resolve()))
})
const collabUrl = `ws://localhost:${collabPort}`
// read by the vite config, so the dev server must be this script's own (isolated), not a shared one
process.env.VITE_COLLAB_URL = collabUrl
const { url, vite } = await startServer({ isolated: true })

/** what a hand-over document holds right now, read with its secret */
async function handoffKeys(secret) {
  const document = new Y.Doc()
  const name = 'r-' + createHash('sha256').update(secret, 'utf8').digest('hex')
  const provider = new HocuspocusProvider({ url: collabUrl, name, token: secret, document })
  await new Promise((resolve) => provider.on('synced', resolve))
  const keys = [...document.getMap('handoff').keys()]
  provider.destroy()
  return keys
}

/** a browser tab with a project of its own, whose Open in Desktop App link is caught instead of opened */
async function browserTab(browser, projectName) {
  const page = await browser.newPage()
  await page.goto(new URL('/app/', url).toString())
  await page.waitForSelector('.toolbar', { timeout: 90000 })
  await page.evaluate((n) => window.__oip.store.renameProject(n), projectName)
  await page.evaluate(() => {
    window.__fired = []
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.href.startsWith('openindustry:')) window.__fired.push(this.href)
      else click.call(this)
    }
  })
  await page.click('.help-button')
  await page.click('[data-testid="help-open-desktop"]')
  const link = await page.evaluate(() => window.__fired[0] ?? null)
  return { page, link }
}
const noticeText = (page) => page.evaluate(() => document.querySelector('[data-testid="save-notice"]')?.textContent ?? '')
async function waitNotice(page, text, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if ((await noticeText(page)).includes(text)) return true
    await sleep(250)
  }
  return false
}

const env = { ...process.env, DESKTOP_URL: url }
delete env.ELECTRON_RUN_AS_NODE
const profileDir = join(tmp, 'profile')
let app
let browser
try {
  browser = await chromium.launch()

  console.log('--- 1. the browser sends its project ---')
  const sent = await browserTab(browser, 'Handoff Line 7')
  const secret = sent.link && new URL(sent.link).searchParams.get('handoff')
  expect(/^e-[0-9a-f-]{36}$/.test(secret ?? ''), `it fired a hand-over link (${sent.link})`)
  // an app taking the link takes the focus: that is the signal the page waits for
  await sent.page.evaluate(() => window.dispatchEvent(new Event('blur')))
  expect(await waitNotice(sent.page, 'Sent to the desktop app'), `the browser says it was sent ("${await noticeText(sent.page)}")`)
  expect((await handoffKeys(secret)).includes('oip'), 'the server holds the project bytes')

  console.log('--- 2. the running desktop app takes it ---')
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const win = await app.firstWindow()
  await win.waitForSelector('.toolbar', { timeout: 90000 })
  // answer the page's confirm() from main, on every load (the hand-over reloads the window twice)
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__asked = []
    const wc = BrowserWindow.getAllWindows()[0].webContents
    const stub = () =>
      wc.executeJavaScript(`window.confirm = (q) => { window.__asked = (window.__asked || []).concat(q); return true }; 0`).catch(() => {})
    wc.on('dom-ready', stub)
    stub()
  })
  const exit = await new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${profileDir}`, sent.link], { env, stdio: 'ignore' })
    child.on('exit', resolve)
  })
  expect(exit === 0, `the second copy handed the link over and quit (exit ${exit})`)
  const projectName = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.__oip?.store?.getState().projectName ?? null').catch(() => null),
    )
  let name = null
  for (let end = Date.now() + 90000; Date.now() < end && name !== 'Handoff Line 7'; await sleep(500)) name = await projectName()
  expect(name === 'Handoff Line 7', `the desktop opened the browser's project (${name})`)
  const finalUrl = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())
  expect(!finalUrl.includes('handoff='), `the window's address no longer names the hand-over (${finalUrl})`)

  console.log('--- 3. nothing is left on the server ---')
  expect((await handoffKeys(secret)).length === 0, 'the hand-over document is empty')

  console.log('--- 4. no app: the browser says so and takes its upload back down ---')
  const lonely = await browserTab(browser, 'Nobody Came')
  const lonelySecret = new URL(lonely.link).searchParams.get('handoff')
  expect(await waitNotice(lonely.page, 'Desktop app did not open', 15000), 'the page says the app did not open')
  let left = ['?']
  for (let end = Date.now() + 20000; Date.now() < end && left.length > 0; await sleep(500)) left = await handoffKeys(lonelySecret)
  expect(left.length === 0, `its upload was cleared (${left.join(', ') || 'empty'})`)
} catch (err) {
  failures++
  console.error('  FAIL: threw', err)
} finally {
  await app?.close().catch(() => {})
  await browser?.close().catch(() => {})
  vite.kill()
  collab.kill()
  await sleep(500)
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nPASS')
process.exit(failures ? 1 : 0)
