// End-to-end proof that the desktop app opens project and part files from outside it (apps/desktop/fileOpen.cjs,
// src/editor/desktop/desktopFileOpen.ts): what a double-click on a .oip / .oippart does once the installer has registered
// them (apps/desktop/package.json build.fileAssociations). The OS hands the app the file's path on its command
// line, so the gate does the same, through the REAL dev shell on a throwaway profile:
//
//   1. launched with a .oip  -> the app asks, then opens it as a project of its own (the one open before is kept)
//   2. a second launch naming a .oippart while the app runs -> the running window takes it into the open project's
//      library, and the second process exits (one app per profile)
//
// Proving the OS registration itself needs an installed build; this proves everything from the path onward.
//
// Run: node e2e/verify-desktop-file-open-electron.mjs
/* global process, console, setTimeout */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const waitFor = async (probe, timeoutMs = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await probe()) return true
    } catch {
      /* the page is reloading */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const { url, vite } = await startServer()
const work = mkdtempSync(join(tmpdir(), 'oip-file-open-'))
const profileDir = join(work, 'profile')
const env = { ...process.env, DESKTOP_URL: url }
delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
// the renderer's blocking dialogs, answered yes and recorded, from the first script of every page (the launch file
// is taken at mount, before a gate could reach the page)
const dialogs = () => {
  window.__dialogs = []
  window.confirm = (m) => (window.__dialogs.push(`confirm: ${m}`), true)
  window.alert = (m) => void window.__dialogs.push(`alert: ${m}`)
}

let app
try {
  // ── 0. make the two files the way the app writes them (its own codecs, served by the dev server) ──────────────
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  let page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 120000 })
  const files = await page.evaluate(async () => {
    const { projectToOipBytes } = await import('/src/core/project/projectArchive.ts')
    const { partToOippartBytes } = await import('/src/core/parts/partArchive.ts')
    const project = { version: 6, name: 'Opened By File', scene: { version: 4, parts: [] }, stProgram: 'PROGRAM ByFile\nEND_PROGRAM\n' }
    const part = {
      format: 6,
      id: 'gate.by-file',
      name: 'By File',
      params: {},
      behavior: 'definePart({ step() {} })\n',
      geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.5, 0.5, 0.5] }, offset: [0, 0.25, 0] }], joints: [] },
    }
    return { oip: [...(await projectToOipBytes(project))], part: [...(await partToOippartBytes(part))] }
  })
  const oipPath = join(work, 'Opened By File.oip')
  const partPath = join(work, 'gate.by-file.oippart')
  writeFileSync(oipPath, Buffer.from(files.oip))
  writeFileSync(partPath, Buffer.from(files.part))
  await app.close()
  app = undefined

  // ── 1. launched with a .oip: asked, then opened as a project of its own ───────────────────────────────────────
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`, oipPath], env })
  await app.context().addInitScript(dialogs)
  page = await app.firstWindow()
  await page.evaluate(dialogs).catch(() => {})
  const opened = await waitFor(() =>
    app.windows()[0].evaluate(() => window.__oip?.store?.getState().projectName === 'Opened By File'),
  )
  page = app.windows()[0]
  check('launched with a .oip, the app opens it as the project', opened, await page.evaluate(() => window.__oip?.store?.getState().projectName).catch(() => '?'))
  check(
    'with its program',
    await page.evaluate(() => (window.__oip.store.getState().stProgram ?? '').includes('PROGRAM ByFile')).catch(() => false),
  )

  // ── 2. a second launch naming a .oippart: the running window takes it into this project's parts ──────────────
  await page.evaluate(dialogs)
  const second = spawn(electronPath, [desktopDir, `--user-data-dir=${profileDir}`, partPath], { env, stdio: 'ignore' })
  const secondExit = new Promise((r) => second.on('exit', (code) => r(code)))
  const imported = await waitFor(() =>
    page.evaluate(() => window.__oip.store.getState().userPackages.some((p) => p.id === 'gate.by-file')),
  )
  check('a .oippart opened while the app runs goes into the open project\'s library', imported)
  check('the open project is still the one it was', await page.evaluate(() => window.__oip.store.getState().projectName === 'Opened By File'))
  const exit = await Promise.race([secondExit, new Promise((r) => setTimeout(() => r('still running'), 20000))])
  check('and the second launch hands it over and exits (one app per profile)', exit !== 'still running', String(exit))
  const said = await page.evaluate(() => window.__dialogs ?? [])
  check('nothing went wrong on the way', !said.some((m) => m.startsWith('alert:')), JSON.stringify(said))
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS  verify-desktop-file-open-electron' : `\nFAIL  verify-desktop-file-open-electron (${failures})`)
process.exit(failures === 0 ? 0 : 1)
