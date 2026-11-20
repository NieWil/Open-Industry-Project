// Settings > Agent connections opens and shuts the agent door, and the choice is remembered - in the real desktop
// shell (apps/desktop/main.cjs setAgentDoor, agentDoorSetting.cjs).
//
// The door lets any program on this machine drive the editor, so an installed app starts with it shut and the
// user opens it on purpose. The launch rule is pinned by `node apps/desktop/agentDoorSetting.test.cjs`; this
// drives the flow a person uses, end to end:
//   1. launched with OIP_MCP_PORT, the door is open (how every gate that needs it gets it);
//   2. turning it off really shuts the port without a question, and remembers "off";
//   3. Help > Agent Connections..., clicked as Electron does, opens Settings at the Agent connections section; its
//      switch asks first (and Cancel opens nothing), then Allow opens the port again, the section shows the URL,
//      Copy puts it on the clipboard, and "on" is remembered.
// The native dialogs are stubbed in main with scripted answers; the questions asked are recorded and checked.
//
//   node e2e/verify-agent-door-electron.mjs
/* global process, console, window, document */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
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

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** does the door answer? true once tools/list returns the editor's tools */
async function doorAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const body = await res.json()
    return (body.result?.tools?.length ?? 0) > 0
  } catch {
    return false
  }
}

const port = await freePort()
const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
const settingFile = join(profileDir, 'agent-door.json')
const remembered = () => {
  try {
    return JSON.parse(readFileSync(settingFile, 'utf8')).enabled
  } catch {
    return undefined
  }
}
let app
try {
  const env = { ...process.env, DESKTOP_URL: url, OIP_MCP_PORT: String(port) }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })

  // every native dialog answers from a script, and records what it asked
  await app.evaluate(({ dialog }) => {
    globalThis.__answers = []
    globalThis.__asked = []
    dialog.showMessageBox = async (...args) => {
      const opts = args.length > 1 ? args[1] : args[0]
      globalThis.__asked.push({ message: opts.message, buttons: opts.buttons })
      return { response: globalThis.__answers.shift() ?? opts.cancelId ?? 0, checkboxChecked: false }
    }
  })
  const script = (answers) => app.evaluate((_e, a) => {
    globalThis.__answers = a
    globalThis.__asked = []
  }, answers)
  const asked = () => app.evaluate(() => globalThis.__asked)

  console.log('--- 1. launched with OIP_MCP_PORT: open ---')
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    up = await doorAnswers(port)
    if (!up) await page.waitForTimeout(250)
  }
  expect(up, `the door answers on :${port}`)

  console.log('--- 2. turning it off shuts it without asking, and remembers ---')
  await script([])
  const off = await page.evaluate(() => window.oipAgent.setDoor(false))
  expect((await asked()).length === 0, 'turning it off asks nothing')
  expect(off.enabled === false, 'it reports the door shut')
  expect(!(await doorAnswers(port)), 'nothing answers on the port any more')
  expect(remembered() === false, 'and "off" is remembered')

  console.log('--- 3. the menu item opens Settings at Agent connections ---')
  const clickMenu = () =>
    app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('help.agentConnections')
      if (!item) return false
      const w = BrowserWindow.getAllWindows()[0]
      item.click({}, w, w.webContents)
      return true
    })
  expect(await clickMenu(), 'Help > Agent Connections... is in the menu')
  const section = page.locator('[data-testid="settings-agent-connections"]')
  await section.waitFor({ timeout: 10000 })
  const view = await section.evaluate((el) => {
    const r = el.getBoundingClientRect()
    let scrolled = 0
    for (let p = el.parentElement; p; p = p.parentElement) scrolled += p.scrollTop
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: window.innerHeight, scrolled }
  })
  expect(view.top >= 0 && view.top < view.viewport, `the section is in view (${JSON.stringify(view)})`)
  const toggle = page.locator('[data-testid="setting-agent-door"]')
  expect(!(await toggle.isChecked()), 'the switch shows the door shut')

  console.log('--- ...its switch asks first; Cancel opens nothing ---')
  await script([1]) // the question: Allow | Cancel
  await toggle.click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="setting-agent-door"]')?.disabled)
  const q3 = await asked()
  expect(q3.length === 1 && /Allow AI agents to connect/.test(q3[0].message), `it asks before opening ("${q3[0]?.message}")`)
  expect(!(await toggle.isChecked()), 'Cancel leaves the switch off')
  expect(!(await doorAnswers(port)), 'Cancel leaves the door shut')

  console.log('--- ...Allow opens it, the URL shows, Copy copies it, "on" is remembered ---')
  await script([0]) // Allow
  await toggle.click()
  await page.locator('[data-testid="setting-agent-url"]').waitFor({ timeout: 10000 })
  let open = false
  for (let i = 0; i < 20 && !open; i++) {
    open = await doorAnswers(port)
    if (!open) await page.waitForTimeout(250)
  }
  expect(open, 'the door answers again')
  expect(await toggle.isChecked(), 'the switch shows the door open')
  const shown = await page.locator('[data-testid="setting-agent-url"]').textContent()
  expect(shown === `http://127.0.0.1:${port}/mcp`, `the section shows the door's URL (${shown})`)
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await page.locator('[data-testid="setting-agent-copy-url"]').click()
  let copied = ''
  for (let i = 0; i < 20 && !copied; i++) {
    copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    if (!copied) await page.waitForTimeout(100)
  }
  expect(copied === `http://127.0.0.1:${port}/mcp`, `Copy put the door's URL on the clipboard (${copied})`)
  expect(remembered() === true, 'and "on" is remembered')
} catch (e) {
  failures++
  console.error('  FAIL:', e instanceof Error ? e.message : String(e))
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed` : '\nPASS: the agent door opens and shuts on the user\'s say, and remembers it')
process.exit(failures ? 1 : 0)
