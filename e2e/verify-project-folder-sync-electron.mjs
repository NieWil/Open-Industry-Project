// End-to-end check that on the desktop a project is stored in its folder, kept in sync both ways
// (src/editor/project/projectFolderSync.ts, docs/projects.md). Launches the real Electron shell (real preload,
// real IPC, real fs writes and the real guarded-write path) with a throwaway profile, and drives it:
//
//   1. an app-only project's first real edit gives it a folder in the default projects folder, which,
//      for a profile launched with its own --user-data-dir (every Electron gate), is inside that profile,
//      so no gate ever writes into the real Documents
//   2. an edit made in the app is written to that folder, and Save (Ctrl+S, and the toolbar's Save)
//      confirms only once the folder has it; it does not download a scene file
//   3. an edit made in the folder (an agent, an editor) is loaded into the app
//   4. the same file changed in both places is a conflict: nothing is written or loaded until "Keep my version"
//   5. File > Open Recent lists the folder, and the registry lives in the profile
//   6. close the app, change the folder while it is closed, relaunch: the change is there, still synced
//   7. the Projects shelf is the project manager: rows show their folders, New project makes a folder,
//      opening a row reads its folder, and removing a row leaves the folder on disk
//   8. Unlink stops the sync, and the next edit stays out of the folder
//
//   node e2e/verify-project-folder-sync-electron.mjs

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'
import { projectMenuItem } from './_projectMenu.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

const waitFor = async (probe, what, timeoutMs = 15000) => {
  const t0 = Date.now()
  for (;;) {
    if (await probe()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const { url, vite } = await startServer()
// long-form paths: the shell canonicalizes every folder it hands out (8.3 names like USER~1 expanded)
const profileDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'oip-sync-profile-')))
// not set through OIP_PROJECTS_DIR: the isolated-profile default is what keeps every other
// Electron gate out of the real Documents, so this gate checks it
const projectsDir = join(profileDir, 'Projects')
let app
let failed = false

/** Disable the blocking dialogs (again after every reload, since a reload drops the stubs). */
const stubDialogs = (page) =>
  page.evaluate(() => {
    window.confirm = () => true
    window.alert = (m) => {
      window.__lastAlert = String(m)
    }
  })

/** Run `action`, which reloads the window (a shelf switch), and wait for the editor to be back. */
async function awaitReload(page, action) {
  await page.evaluate(() => ((window.__syncMark = true), undefined))
  await action()
  await page.waitForFunction(() => window.__syncMark === undefined && !!window.__oip?.store && !!window.__oip?.folderSync, null, { timeout: 60000 })
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await stubDialogs(page)
}

const openShelf = async (page, app) => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.projects'))
  await page.waitForSelector('[data-projects-overlay] .projects-row', { timeout: 10000 })
}

async function launch() {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.OIP_PROJECTS_DIR
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  const launched = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await launched.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.folderSync, null, { timeout: 60000 })
  await stubDialogs(page)
  return { launched, page }
}

/** An undoable scene edit: one group part with a known id, the way the editor's own commits make them. */
const addGroup = (page, id) =>
  page.evaluate((partId) => {
    const store = window.__oip.store
    const scene = store.getState().scene
    store.commit('Add group', { ...scene, parts: [...scene.parts, { id: partId, type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} }] })
  }, id)

try {
  let { launched, page } = await launch()
  app = launched

  // ── 1. first real edit -> a folder of its own ────────────────────────────────────────────────
  if ((await page.evaluate(() => window.__oip.store.getState().folderPath)) !== null) throw new Error('a fresh profile already has a folder')
  await addGroup(page, 'first-edit')
  await waitFor(() => page.evaluate(() => window.__oip.store.getState().folderPath !== null), 'the first edit to give the project a folder')
  const root = await page.evaluate(() => window.__oip.store.getState().folderPath)
  if (!root.startsWith(projectsDir)) throw new Error(`folder ${root} is not under the default projects folder ${projectsDir}`)
  const manifest = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
  // format 4 and later: the project's one scene sits at the folder's root, named by the manifest
  if (!(manifest.version >= 4) || manifest.scene !== 'scene.json' || manifest.scenes !== undefined) {
    throw new Error(`the folder is not in the one-scene layout: ${JSON.stringify({ version: manifest.version, scene: manifest.scene, scenes: manifest.scenes })}`)
  }
  const scenePath = join(root, manifest.scene)
  if (!readFileSync(scenePath, 'utf8').includes('first-edit')) throw new Error('the first edit is not in the scene file')
  if (!existsSync(join(root, 'AGENTS.md'))) throw new Error('no agent guide written')
  await page.waitForSelector('[data-testid="save-notice"]', { timeout: 5000 })
  console.log(`✓ the first real edit gave the project a folder: ${root}`)

  // ── 2. app -> folder ─────────────────────────────────────────────────────────────────────────
  await addGroup(page, 'second-edit')
  await waitFor(() => readFileSync(scenePath, 'utf8').includes('second-edit'), 'the app edit to reach the scene file', 8000)
  console.log('✓ an edit made in the app was written to the folder')

  // Save: a real Ctrl+S, which the app binds itself (App.tsx); the menu only displays the chord. It may
  // only say "Saved" once the edit is in the folder. (The unit test, on fake timers, checks that it
  // writes without waiting out the 800 ms delay.)
  await addGroup(page, 'saved-now')
  await page.evaluate(() => window.__oip.store.dismissSaveNotice())
  await page.keyboard.press('Control+s')
  await waitFor(
    () => page.evaluate(() => [...document.querySelectorAll('[data-testid="save-notice"] .part-build-toast-title')].some((e) => e.textContent === 'Saved')),
    'the Saved confirmation',
    5000,
  )
  if (!readFileSync(scenePath, 'utf8').includes('saved-now')) throw new Error('Save confirmed, but the edit is not in the folder')
  const saveItem = await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('file.save')
    return item ? { label: item.label, accelerator: item.accelerator ?? null, registered: item.registerAccelerator } : null
  })
  if (saveItem?.label !== 'Save' || saveItem.accelerator !== 'CmdOrCtrl+S') throw new Error(`File > Save does not show Ctrl+S (${JSON.stringify(saveItem)})`)
  if (saveItem.registered !== false) throw new Error('the menu registers Ctrl+S too - Save would fire twice')
  const exportAccel = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.exportProject')?.accelerator ?? null)
  if (exportAccel) throw new Error(`the export claims a chord (${exportAccel})`)
  const saveRow = await projectMenuItem(page, 'file.save')
  if (!((await saveRow.getAttribute('title')) ?? '').includes('folder')) throw new Error('the project menu Save is not the project Save on the desktop')
  await page.keyboard.press('Escape')
  console.log('✓ a real Ctrl+S saved and confirmed only once the folder had the edit; the menu shows the chord without registering it; the project menu Save is the same Save')

  // ── 3. folder -> app ─────────────────────────────────────────────────────────────────────────
  const onDisk = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
  onDisk.name = 'Renamed By Agent'
  writeFileSync(join(root, 'project.json'), JSON.stringify(onDisk, null, 2) + '\n')
  await waitFor(
    () => page.evaluate(() => window.__oip.store.getState().projectName === 'Renamed By Agent'),
    'the folder edit to load into the app',
    8000,
  )
  // the live scene was untouched by that edit, so its undo history must have survived
  if (!(await page.evaluate(() => window.__oip.store.canUndo))) throw new Error('a manifest-only change reloaded the scene on screen')
  console.log('✓ an edit made in the folder loaded into the app, leaving the scene on screen alone')

  // ── 4. both sides -> conflict ────────────────────────────────────────────────────────────────
  // a program first, so there is a .st file for both sides to change
  await page.evaluate(() => window.__oip.store.commitProgram('Program', { source: 'VAR_OUTPUT\n  Base : BOOL;\nEND_VAR\n' }))
  const stRef = await waitForManifestSt(root)
  const stPath = join(root, ...stRef.split('/'))
  await waitFor(() => existsSync(stPath) && readFileSync(stPath, 'utf8').includes('Base'), 'the program file to be written', 8000)
  // app edit, then the disk edit straight after: both happen before the next write round
  await page.evaluate(() => window.__oip.store.commitProgram('Mine', { source: 'VAR_OUTPUT\n  Mine : BOOL;\nEND_VAR\n' }))
  writeFileSync(stPath, 'VAR_OUTPUT\n  Theirs : BOOL;\nEND_VAR\n')
  await page.waitForSelector('[data-testid="folder-conflict"]', { timeout: 8000 })
  await pause(1500) // a conflict must hold: nothing written, nothing loaded
  if (!readFileSync(stPath, 'utf8').includes('Theirs')) throw new Error('the folder file was overwritten during a conflict')
  if (!(await page.evaluate(() => window.__oip.store.getState().stProgram.includes('Mine')))) throw new Error('the app program was replaced during a conflict')
  await page.getByRole('button', { name: 'Keep my version' }).click()
  await waitFor(() => readFileSync(stPath, 'utf8').includes('Mine'), '"Keep my version" to write the app version', 8000)
  if (await page.locator('[data-testid="folder-conflict"]').count()) throw new Error('the conflict banner stayed up after resolving')
  console.log('✓ a file changed in both places was held as a conflict, then settled by "Keep my version"')

  // ── 5. Open Recent + registry ────────────────────────────────────────────────────────────────
  const recent = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
    const item = file?.submenu?.items.find((i) => i.label === 'Open Recent')
    return item?.submenu?.items.map((i) => i.label) ?? null
  })
  if (!recent || !recent.some((label) => label.includes(root))) throw new Error(`Open Recent does not list the folder: ${JSON.stringify(recent)}`)
  const registryFile = join(profileDir, 'project-folders.json')
  if (!existsSync(registryFile)) throw new Error('the folder registry is not inside the isolated profile')
  console.log('✓ File > Open Recent lists the folder; the registry lives in the profile')

  // ── 6. restart, with the folder changed while the app was closed ─────────────────────────────
  await addGroup(page, 'before-close')
  await app.close() // the window's last write goes out synchronously on the way down
  app = null
  if (!readFileSync(scenePath, 'utf8').includes('before-close')) throw new Error('the edit made just before closing did not reach the folder')
  writeFileSync(stPath, 'VAR_OUTPUT\n  WhileClosed : BOOL;\nEND_VAR\n')
  ;({ launched, page } = await launch())
  app = launched
  await waitFor(
    () => page.evaluate(() => window.__oip.store.getState().stProgram.includes('WhileClosed')),
    'the change made while closed to load at launch',
    20000,
  )
  if ((await page.evaluate(() => window.__oip.store.getState().folderPath)) !== root) throw new Error('the relaunched app is not synced to the same folder')
  await addGroup(page, 'after-relaunch')
  await waitFor(() => readFileSync(scenePath, 'utf8').includes('after-relaunch'), 'an edit after relaunch to reach the folder', 8000)
  console.log('✓ after a restart the folder was picked up again, with the change made while the app was closed')

  // ── 7. the shelf, as the desktop's project manager ───────────────────────────────────────────
  await openShelf(page, app)
  const paths = await page.locator('.projects-path').allTextContents()
  if (!paths.includes(root)) throw new Error(`the shelf row does not show its folder (${JSON.stringify(paths)})`)
  await page.locator('.projects-new').click({ force: true })
  await page.fill('.projects-input', 'Second Line')
  await awaitReload(page, () => page.locator('.projects-confirm').click({ force: true }))
  await waitFor(() => page.evaluate(() => window.__oip.store.getState().projectName === 'Second Line'), 'the new project to open')
  await waitFor(() => page.evaluate(() => window.__oip.store.getState().folderPath !== null), 'the new project to live in a folder')
  const second = await page.evaluate(() => window.__oip.store.getState().folderPath)
  if (!second.startsWith(projectsDir) || second === root) throw new Error(`the new project's folder is wrong: ${second}`)
  if (JSON.parse(readFileSync(join(second, 'project.json'), 'utf8')).name !== 'Second Line') throw new Error('the new project was not written to its folder')
  // change the first project's folder while the second is open: opening its row must read the folder
  writeFileSync(stPath, 'VAR_OUTPUT\n  FromShelf : BOOL;\nEND_VAR\n')
  await openShelf(page, app)
  await awaitReload(page, () => page.locator('.projects-name', { hasText: 'Renamed By Agent' }).click({ force: true }))
  await waitFor(() => page.evaluate(() => window.__oip.store.getState().stProgram.includes('FromShelf')), 'the shelf to open the project from its folder')
  if ((await page.evaluate(() => window.__oip.store.getState().folderPath)) !== root) throw new Error('the reopened project is not in its folder')
  await openShelf(page, app)
  await page.locator('.projects-row', { hasText: 'Second Line' }).locator('button[aria-label^="Remove"]').click({ force: true })
  await waitFor(async () => (await page.locator('.projects-row', { hasText: 'Second Line' }).count()) === 0, 'the removed row to leave the list')
  if (!existsSync(join(second, 'project.json'))) throw new Error('removing a project from the list deleted its folder')
  await page.keyboard.press('Escape')
  console.log('✓ the shelf showed folders, made a folder for a new project, opened a row from its folder, and removed a row without touching its folder')

  // ── 8. unlink ────────────────────────────────────────────────────────────────────────────────
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.unlinkFolder'))
  await waitFor(() => page.evaluate(() => window.__oip.store.getState().folderPath === null), 'Unlink to detach the folder')
  await addGroup(page, 'after-unlink')
  await pause(2500)
  if (readFileSync(scenePath, 'utf8').includes('after-unlink')) throw new Error('an edit after Unlink was written to the folder')
  const row = JSON.parse(readFileSync(registryFile, 'utf8')).folders.find((r) => r.detached)
  if (!row) throw new Error('Unlink was not remembered as a deliberate detach')
  console.log('✓ Unlink stopped the sync, and was remembered')

  const alertText = await page.evaluate(() => window.__lastAlert ?? null)
  if (alertText) throw new Error(`unexpected alert: ${alertText}`)
  console.log('PASS verify-project-folder-sync-electron')
} catch (err) {
  failed = true
  console.error('FAIL verify-project-folder-sync-electron:', err)
} finally {
  try {
    if (app) await app.close()
  } catch {}
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

/** The project's program file, once the manifest names one (format 7 lists one per POU; this program is one block). */
async function waitForManifestSt(root) {
  let ref = null
  await waitFor(
    () => {
      try {
        const m = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
        ref = Array.isArray(m.program) && typeof m.program[0] === 'string' ? m.program[0] : null
      } catch {
        ref = null
      }
      return ref !== null
    },
    'the manifest to name the program file',
    8000,
  )
  return ref
}
