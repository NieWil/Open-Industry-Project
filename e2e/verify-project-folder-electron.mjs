// End-to-end check of the desktop project-folder loop (docs/projects.md): launches the real Electron
// shell (apps/desktop/main.cjs: real preload, real IPC, real fs writes), stubs only the native
// folder-picker dialog (unattended runs can't click one), then drives the actual File-menu command
// channel:
//   1. 'file.saveProject'  → renderer serializes the live project → main writes it to a temp folder,
//      and from then on the project is stored there (src/editor/project/projectFolderSync.ts)
//   2. edit the folder on disk like a user in VS Code would (rename project, add an ST program,
//      author a new part as a parts/<id>/ workspace folder)
//   3. 'file.openProject' on that same folder → it is already the open project, so nothing reloads;
//      the sync reassembles + validates + bakes the part and loads the edits in place
//   4. edit the part's behavior.js on disk → the project folder sync reloads it live
// The rest of the two-way loop (app → folder, conflicts, restart, unlink) is
// e2e/verify-project-folder-sync-electron.mjs.
// A throwaway --user-data-dir keeps the run off any real profile's localStorage/autosave.
//
//   node e2e/verify-project-folder-electron.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
// require('electron') from Node returns the path to the electron executable
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

const waitFor = async (probe, what, timeoutMs = 15000) => {
  const t0 = Date.now()
  for (;;) {
    if (await probe()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

const { url, vite } = await startServer()
const projectDir = mkdtempSync(join(tmpdir(), 'oip-proj-smoke-'))
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
let app
let failed = false
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, `--user-data-dir=${profileDir}`],
    env,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  // disable the renderer's blocking dialogs; keep alerts inspectable
  await page.evaluate(() => {
    window.confirm = () => true
    window.alert = (m) => {
      window.__lastAlert = String(m)
    }
  })
  // stub only the native folder picker; everything downstream is the real code path
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, projectDir)

  // ── 1. Save Project to Folder… via the real menu command channel ────────────────────────────
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.saveProject')
  })
  await waitFor(() => existsSync(join(projectDir, 'project.json')), 'project.json to be spilled')
  const manifest = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
  // format 4: a project holds one scene, at the folder's root beside the manifest
  if (!(manifest.version >= 4)) throw new Error(`spilled manifest predates the one-scene layout of format 4 (version ${manifest.version})`)
  if (manifest.scenes !== undefined) throw new Error('spilled manifest still lists scenes')
  const sceneRef = manifest.scene
  if (sceneRef !== 'scene.json') throw new Error(`spilled manifest names its scene ${JSON.stringify(sceneRef)}, not scene.json`)
  if (!existsSync(join(projectDir, sceneRef))) throw new Error(`scene file ${sceneRef} not written`)
  if (existsSync(join(projectDir, 'scenes'))) throw new Error('a scenes/ directory was written')
  console.log(`✓ saveProject spilled the project (${sceneRef}) to ${projectDir}`)

  // ── 2. Edit the folder on disk the way VS Code / an agent would ─────────────────────────────
  manifest.name = 'Folder Smoke'
  // the program, one file per POU under plc/, in the order the manifest lists (format 7)
  manifest.program = ['plc/Smoke.st']
  mkdirSync(join(projectDir, 'plc'), { recursive: true })
  writeFileSync(join(projectDir, 'plc', 'Smoke.st'), 'PROGRAM Smoke\nEND_PROGRAM\n')
  // author a new part as a workspace-format folder and reference it as library
  const partDir = join(projectDir, 'parts', 'smoke.part')
  mkdirSync(partDir, { recursive: true })
  writeFileSync(join(partDir, 'manifest.json'), JSON.stringify({ id: 'smoke.part', name: 'Smoke Part', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }, null, 2))
  const behavior = (speed) => `definePart({ params: { speed: { type: 'number', default: ${speed} } }, step() {} })`
  writeFileSync(join(partDir, 'behavior.js'), behavior(0.5))
  manifest.packages = ['parts/smoke.part']
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(manifest, null, 2))

  // ── 3. Open Project Folder… on the project's own folder → the live sync loads the edits ───────
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.openProject')
  })
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await waitFor(
    () => page.evaluate(() => window.__oip?.store?.getState().projectName).then((n) => n === 'Folder Smoke'),
    'the edited project name after reload',
  )
  const program = await page.evaluate(() => localStorage.getItem('oip-web/st-program'))
  if (!program || !program.includes('PROGRAM Smoke')) throw new Error(`ST program not adopted: ${JSON.stringify(program)}`)
  const alertText = await page.evaluate(() => window.__lastAlert ?? null)
  if (alertText) throw new Error(`unexpected alert during the loop: ${alertText}`)
  // the on-disk part was baked (validatePart ran its script) and adopted into the authored library
  const library = await page.evaluate(() => window.__oip.store.getState().userPackages.map((p) => p.id))
  if (!library.includes('smoke.part')) throw new Error(`part folder not adopted into the library: ${JSON.stringify(library)}`)
  console.log('✓ the on-disk edits (name + ST program + baked part) loaded into the open project through the real IPC loop')

  // ── 4. Live edit: the project folder sync reads parts/ back like any other project file ─────
  // (no shell watcher: the folder sync's poll is the only way a disk edit reaches the project's parts)
  writeFileSync(join(partDir, 'behavior.js'), behavior(0.9))
  try {
    await waitFor(
      () => page.evaluate(() => window.__oip.getPackage('smoke.part')?.behavior ?? '').then((src) => src.includes('0.9')),
      'the behavior.js disk edit to reach the registry through the folder sync',
    )
  } catch (err) {
    console.error('diagnostics - packageBuildErrors:', JSON.stringify(await page.evaluate(() => window.__oip.store.getState().packageBuildErrors)))
    console.error('diagnostics - library copy:', JSON.stringify(await page.evaluate(() => window.__oip.store.getState().userPackages.find((p) => p.id === 'smoke.part')?.behavior ?? null)))
    throw err
  }
  console.log('✓ behavior.js edited on disk hot-reloaded into the running app (project folder sync)')
  console.log('PASS verify-project-folder-electron')
} catch (err) {
  failed = true
  console.error('FAIL verify-project-folder-electron:', err)
} finally {
  try {
    if (app) await app.close()
  } catch {}
  vite.kill()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(profileDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
