// Several windows on the desktop, one project each (docs/desktop-shell.md "Several windows"), through the real shell.
//
// What it checks:
//   - a second launch naming a project folder opens it in a window of its own, and the first window keeps its project
//   - each window saves its own project into its own folder, and neither yields to the other
//   - naming a folder that a window already has open brings that window forward instead of opening it twice
//   - the projects list in one window marks the other window's project, and opening that row brings its window forward
//   - the agent door drives the focused window, lists the other window's project as open there, and open_project on
//     it moves the agent to that window instead of opening it twice
//   - closing a window hands the agent to the one left
//
//   node e2e/verify-desktop-windows-electron.mjs
/* global process, console, window, document, sessionStorage, setTimeout, URL, fetch */

import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { freePort } from './_port.mjs'
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
async function until(probe, what, timeoutMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

/** A minimal MCP client: one JSON-RPC request per POST. */
function mcpClient(url) {
  let id = 0
  async function request(method, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
    })
    const body = await res.json()
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result
  }
  return {
    request,
    async call(name, args = {}) {
      const r = await request('tools/call', { name, arguments: args })
      const text = r.content?.[0]?.text ?? ''
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* an error message */
      }
      return { ok: !r.isError, text, json }
    },
  }
}

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
// the long form: the shell canonicalises folders, and a Windows temp path can be a short name (ROBERT~1)
const projectsDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'oip-windows-')))
const jamDir = join(projectsDir, 'Jam')
const motorDir = join(projectsDir, 'Motor')
cpSync(join(here, '..', 'examples', 'projects', 'jam-detect'), jamDir, { recursive: true })
cpSync(join(here, '..', 'examples', 'projects', 'start-stop-motor'), motorDir, { recursive: true })
const port = await freePort()
const env = { ...process.env, DESKTOP_URL: url, OIP_MCP_PORT: String(port), OIP_PROJECTS_DIR: projectsDir }
delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
delete env.OIP_MCP

/** A second launch of the app, as a double-click on a folder shortcut makes: it hands `folder` over and exits. */
function secondLaunch(folder) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${profileDir}`, folder], { env, stdio: 'ignore' })
    child.on('exit', resolve)
  })
}

const ready = (page) => page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 90000, polling: 200 })
const projectName = (page) => page.evaluate(() => window.__oip.store.getState().projectName)
const docOf = (page) => page.evaluate(() => sessionStorage.getItem('oip-web/document-id'))
const superseded = (page) => page.evaluate(() => window.__oip.store.getState().supersededByOtherTab === true)
const addPart = (page, id) =>
  page.evaluate((id) => {
    const st = window.__oip.store
    const scene = st.getState().scene
    st.commit('Add part', { ...scene, parts: [...scene.parts, { id, type: 'part', packageId: 'oip.box-spawner', name: id, position: [9, 0, 9], rotationY: 0, params: {} }] })
  }, id)
const folderHas = (dir, id) => {
  try {
    return readFileSync(join(dir, 'scene.json'), 'utf8').includes(id)
  } catch {
    return false
  }
}
/** The app windows (not a popped-out panel): pages whose URL is the app's. */
const appPages = (app) => app.windows().filter((p) => p.url().includes('/app/'))
// Which window the shell last brought forward. Read from its own focus() calls: a window of a process the test
// started may not take the OS focus on Windows, so getFocusedWindow() can stay null.
const watchFocus = (app) =>
  app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const wrap = (w) => {
      const focus = w.focus.bind(w)
      w.focus = () => {
        globalThis.__oipFocused = w.webContents.getURL()
        focus()
      }
    }
    BrowserWindow.getAllWindows().forEach(wrap)
    electronApp.on('browser-window-created', (_e, w) => wrap(w))
  })
const focusedUrl = (app) => app.evaluate(() => globalThis.__oipFocused ?? null)
const clearFocused = (app) => app.evaluate(() => void (globalThis.__oipFocused = null))

let app
try {
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const first = await app.firstWindow()
  await first.waitForSelector('.toolbar', { timeout: 90000 })
  await ready(first)
  await first.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await watchFocus(app)

  const mcp = mcpClient(`http://127.0.0.1:${port}/mcp`)
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-desktop-windows', version: '1' } })

  console.log('--- the first window opens Jam ---')
  // through the agent door, so no native dialog is involved: a folder in the projects folder opens unasked
  const opened = await mcp.call('open_project', { project: jamDir })
  expect(opened.ok, `open_project Jam (${opened.text.slice(0, 80)})`)
  await ready(first)
  expect((await projectName(first)) === 'Jam Detection', `the first window has Jam (${await projectName(first)})`)

  console.log('--- a second launch naming Motor opens a window of its own ---')
  const nextWindow = app.waitForEvent('window', { timeout: 90000 })
  await secondLaunch(motorDir)
  const second = await nextWindow
  await second.waitForSelector('.toolbar', { timeout: 90000 })
  await ready(second)
  await until(async () => (await projectName(second)) === 'Start/Stop Motor', 'the second window to open Motor')
  expect(appPages(app).length === 2, `two app windows (${appPages(app).length})`)
  expect((await projectName(first)) === 'Jam Detection', 'the first window kept Jam')
  const [docA, docB] = [await docOf(first), await docOf(second)]
  expect(docA !== null && docB !== null && docA !== docB, `each window has its own document (${docA}, ${docB})`)

  console.log('--- each window saves its own project into its own folder ---')
  await addPart(first, 'win_in_jam')
  await addPart(second, 'win_in_motor')
  await until(() => folderHas(jamDir, 'win_in_jam') && folderHas(motorDir, 'win_in_motor'), 'both folders to take their edits', 30000)
  expect(!folderHas(jamDir, 'win_in_motor') && !folderHas(motorDir, 'win_in_jam'), 'and neither took the other window’s edit')
  expect(!(await superseded(first)) && !(await superseded(second)), 'neither window yields to the other')

  console.log('--- naming an open folder brings its window forward ---')
  await clearFocused(app)
  await secondLaunch(jamDir)
  await until(async () => (await focusedUrl(app)) === first.url(), 'the Jam window to come forward', 15000)
  expect(appPages(app).length === 2, `no third window (${appPages(app).length})`)

  console.log("--- the projects list knows the other window's project ---")
  await first.keyboard.press('Control+Shift+P')
  await first.waitForSelector('.palette-input')
  await first.fill('.palette-input', 'projects')
  await first.locator('.palette-item', { has: first.locator('.palette-label', { hasText: /^Projects/ }) }).first().click({ force: true })
  await first.waitForSelector(`.projects-row[data-doc-id="${docB}"]`)
  const when = await first.evaluate((id) => document.querySelector(`.projects-row[data-doc-id="${id}"] .projects-when`)?.textContent ?? '', docB)
  expect(when === 'open in another window', `Motor's row says so (${when})`)
  await clearFocused(app)
  await first.locator(`.projects-row[data-doc-id="${docB}"] .projects-name`).click({ force: true })
  await until(async () => (await focusedUrl(app)) === second.url(), 'the Motor window to come forward', 15000)
  expect((await projectName(first)) === 'Jam Detection' && appPages(app).length === 2, 'and the first window kept Jam')

  console.log("--- the menu shows the focused window's state ---")
  const focusAs = (page) =>
    app.evaluate(({ app: electronApp, BrowserWindow }, u) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === u)
      electronApp.emit('browser-window-focus', {}, w) // as the OS reports a focus, which a test cannot make it do
    }, page.url())
  const deleteEnabled = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('edit.delete')?.enabled ?? null)
  await first.keyboard.press('Escape')
  await first.evaluate(() => window.__oip.store.select('win_in_jam'))
  await second.evaluate(() => window.__oip.store.select(null))
  await focusAs(first)
  await until(async () => (await deleteEnabled()) === true, 'Delete to be enabled for the window with a selection', 10000).catch(() => {})
  expect((await deleteEnabled()) === true, 'Delete is enabled while the window with a selection has the focus')
  await focusAs(second)
  await until(async () => (await deleteEnabled()) === false, 'Delete to be disabled for the window without one', 10000).catch(() => {})
  expect((await deleteEnabled()) === false, 'and disabled while the window without one has it')

  console.log('--- the agent drives the focused window ---')
  await focusAs(first)
  await until(async () => (await mcp.call('get_scene')).json?.project === 'Jam Detection', 'the agent to act on Jam', 15000)
  const listed = (await mcp.call('list_projects')).json?.projects ?? []
  const row = (dir) => listed.find((p) => p.path === dir)
  expect(row(jamDir)?.open === true, 'list_projects marks Jam open')
  expect(row(motorDir)?.openInAnotherWindow === true, 'and Motor open in another window')
  const moved = await mcp.call('open_project', { project: motorDir })
  expect(moved.ok && /another window/.test(moved.json?.note ?? ''), `open_project Motor moves the agent there (${moved.text.slice(0, 90)})`)
  expect((await mcp.call('get_scene')).json?.project === 'Start/Stop Motor', 'later calls act on Motor')
  expect((await projectName(first)) === 'Jam Detection' && appPages(app).length === 2, 'and nothing was opened twice')

  console.log('--- closing a window hands the agent to the one left ---')
  await second.close()
  await until(() => appPages(app).length === 1, 'the Motor window to close')
  const after = await mcp.call('get_scene')
  expect(after.json?.project === 'Jam Detection', `the agent now acts on Jam (${after.json?.project ?? after.text.slice(0, 80)})`)
} catch (e) {
  failures++
  console.error('  FAIL:', e instanceof Error ? e.message : e)
} finally {
  await app?.close().catch(() => {})
  vite.kill()
}
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall desktop-windows checks passed')
