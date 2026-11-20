// A project's parts live in one place, its own copies, stored in its folder's parts/. Checked through the real desktop
// shell, across restarts and a second project. This guards against a second home for parts: when the shell kept part
// folders of its own (a profile-wide custom-parts folder and a watcher on the project's parts/), load order decided
// which copy of a part was used, so a part edited in one project appeared in another, and an in-app edit needed a
// separate "Save part" that could revert it. Checks:
//   - "Open in external editor" opens <project>/parts/<slug>/behavior.js, a built-in becoming this project's version;
//   - an edit saved there comes back through the project folder sync (no shell watcher);
//   - an in-app edit reaches the folder the same way (no Save part);
//   - another project shows the untouched built-in, before and after a restart, and the first gets its edit back;
//   - the old custom-parts folder is never loaded on its own: the app says so once, and File > Import Parts from
//     Folder… brings its parts into the open project's parts.
//
//   node e2e/verify-part-library-electron.mjs
/* global process, console, window, localStorage, setTimeout, URL */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > end) return false
    await sleep(250)
  }
}

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
const custom = join(profileDir, 'custom-parts')
const projects = join(profileDir, 'Projects')
// a stand-in for the user's editor: records the file it was asked to open (resolveEditor reads OIP_EDITOR)
const editorLog = join(profileDir, 'editor.log')
const editorCmd = join(profileDir, process.platform === 'win32' ? 'fake-editor.cmd' : 'fake-editor.sh')
if (process.platform === 'win32') writeFileSync(editorCmd, `@echo %~1>>"${editorLog}"\r\n`)
else writeFileSync(editorCmd, `#!/bin/sh\necho "$1" >> "${editorLog}"\n`, { mode: 0o755 })
const env = { ...process.env, DESKTOP_URL: url, OIP_EDITOR: editorCmd }
delete env.ELECTRON_RUN_AS_NODE
// an old install's leftover: a part in the profile-wide folder that belongs to no project
const ORPHAN = 'demo.motor'
cpSync(join(here, '..', 'examples', 'projects', 'start-stop-motor', 'parts', ORPHAN), join(custom, ORPHAN), { recursive: true })

const NOTICE = 'Parts now live in each project'
const MARK = '\n// edited outside the app, in the first project\n'
const MARK_C = '\n// edited in the app, in the first project\n'

async function launch(label, body) {
  console.log(`launch ${label}`)
  const app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 2, null, { timeout: 60000 })
  await page.evaluate(() => {
    window.confirm = () => true
  })
  const boot = await page.evaluate(() => ({ notice: window.__oip.store.getState().saveNotice?.title ?? null, told: localStorage.getItem('oip-web/legacy-parts-told') }))
  try {
    return await body(page, app, boot)
  } finally {
    await app.close().catch(() => {})
  }
}

/** one part, as the app holds it: registered behavior, whether it is the built-in, whether the library has it */
const partOf = (page, id) =>
  page.evaluate((pid) => {
    const s = window.__oip.store.getState()
    const live = window.__oip.getPackage(pid)
    const builtIn = s.bundledPackages.find((p) => p.id === pid)
    return { behavior: live?.behavior ?? null, isBuiltIn: !!live && !!builtIn && live.behavior === builtIn.behavior, inLibrary: s.userPackages.some((p) => p.id === pid) }
  }, id)
const project = (page) => page.evaluate(() => window.__oip.store.getState().projectName)
/** every project's parts/<slug>/behavior.js whose text ends with `mark`, as "<project>/<slug>" */
function onDisk(mark) {
  if (!existsSync(projects)) return []
  const hits = []
  for (const p of readdirSync(projects)) {
    const parts = join(projects, p, 'parts')
    if (!existsSync(parts)) continue
    for (const slug of readdirSync(parts)) {
      const f = join(parts, slug, 'behavior.js')
      if (existsSync(f) && readFileSync(f, 'utf8').endsWith(mark)) hits.push(`${p}/${slug}`)
    }
  }
  return hits
}

async function openShelf(page, app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.projects'))
  await page.waitForSelector('.projects-new', { timeout: 15000 })
}
async function settleProject(page, name) {
  await page.waitForFunction((n) => window.__oip?.store?.getState().projectName === n, name, { timeout: 30000 })
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 2, null, { timeout: 60000 })
  await sleep(4000) // the project's attach and its first folder read
}

let A
let C
let first
try {
  await launch('1: a fresh profile', async (page, _app, boot) => {
    expect(boot.notice === NOTICE && boot.told === '1', `the leftover in custom-parts is announced at the first launch (${JSON.stringify(boot.notice)})`)
    expect(!(await partOf(page, ORPHAN)).behavior, 'the leftover is not loaded')
    first = await project(page)
    // a placed copy of a built-in (the new project holds only the building), to open from the Inspector the way a
    // person would
    const placed = await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState()
      const a = 'oip.belt-conveyor'
      st.commit('Place conveyor', { ...s.scene, parts: [...s.scene.parts, { id: 'conv_lib', type: 'part', packageId: a, position: [2, 0, 2], rotationY: 0, name: 'Line 1', params: {} }] })
      return { partId: 'conv_lib', a, c: s.bundledPackages.find((p) => p.id !== a)?.id ?? null }
    })
    if (!placed.partId || !placed.c) throw new Error(`no placed built-in part in the starting scene: ${JSON.stringify(placed)}`)
    A = placed.a
    C = placed.c
    const builtInA = (await partOf(page, A)).behavior
    await page.evaluate((id) => window.__oip.store.select(id), placed.partId)
    const openBtn = page.getByRole('button', { name: 'Open in external editor' }).first()
    if (!(await openBtn.isVisible({ timeout: 10000 }).catch(() => false))) {
      const why = await page.evaluate(() => ({
        parts: window.__oip.store.getState().scene.parts.slice(0, 12).map((p) => `${p.id}:${p.type}:${p.packageId ?? ''}`),
        selected: window.__oip.store.getState().selectedIds ?? window.__oip.store.getState().selectedId ?? null,
        api: Object.keys(window.oipParts ?? {}),
        panel: !!document.querySelector('.inspector-head-actions'),
        buttons: [...document.querySelectorAll('.inspector-head-action')].map((b) => b.getAttribute('aria-label')),
      }))
      throw new Error(`no Open in external editor button: ${JSON.stringify(why)}`)
    }
    await openBtn.click()
    const opened = await waitFor(() => existsSync(editorLog) && readFileSync(editorLog, 'utf8').trim() !== '')
    const file = opened ? readFileSync(editorLog, 'utf8').trim().split(/\r?\n/).pop().trim() : ''
    // compared through realpath: the temp dir may come back in its 8.3 short form (a `~1` segment)
    const inParts = !!file && existsSync(file) && realpathSync.native(file).startsWith(realpathSync.native(join(projects, first, 'parts')))
    expect(inParts && file.endsWith('behavior.js'), `the editor was handed behavior.js in the project's own parts/ (${file || 'nothing'})`)
    expect(!!file && existsSync(file) && readFileSync(file, 'utf8') === builtInA, 'that file holds the built-in behavior, written before the editor opened')
    expect((await partOf(page, A)).inLibrary, "the built-in became this project's version (its own copy)")

    // the person edits it there and saves: the folder sync brings it back
    writeFileSync(file, builtInA + MARK)
    expect(await waitFor(async () => (await partOf(page, A)).behavior?.endsWith(MARK)), 'the outside edit reached the running app through the folder sync')

    // an in-app edit reaches the folder the same way, with nothing to save
    const originalC = (await partOf(page, C)).behavior
    expect((await page.evaluate(([id, s]) => window.__oip.controller.editBehavior(id, s), [C, originalC + MARK_C])).length === 0, 'built-in C takes an in-app edit')
    expect(await waitFor(() => onDisk(MARK_C).length === 1), `the in-app edit is in the project folder (${onDisk(MARK_C).join(', ') || 'nowhere'})`)
    const strays = readdirSync(custom).filter((d) => d !== ORPHAN)
    expect(strays.length === 0, `nothing was written to custom-parts (${strays.join(', ') || 'none'})`)
  })

  await launch('2: restart', async (page, _app, boot) => {
    expect(boot.notice !== NOTICE, 'the leftover notice is not shown again')
    await sleep(4000)
    expect((await partOf(page, A)).behavior?.endsWith(MARK), 'A is still the outside edit')
    expect((await partOf(page, C)).behavior?.endsWith(MARK_C), 'C is still the in-app edit')
    expect(!(await partOf(page, ORPHAN)).behavior, 'the leftover is still not loaded')
  })

  await launch('3: a new project', async (page, app) => {
    await sleep(3000)
    await openShelf(page, app)
    await page.click('.projects-new')
    await page.locator('.projects-create .projects-input').fill('Second Line')
    await page.click('.projects-confirm')
    await settleProject(page, 'Second Line')
    const pa = await partOf(page, A)
    expect(pa.isBuiltIn && !pa.inLibrary, 'the new project shows the untouched built-in A, with no copy of its own')
    expect((await partOf(page, C)).isBuiltIn, 'and the untouched built-in C')
  })

  await launch('4: restart into the new project', async (page) => {
    await sleep(4000)
    expect((await project(page)) === 'Second Line', 'the app reopened the new project')
    expect((await partOf(page, A)).isBuiltIn, 'still the untouched built-in A after a restart')
  })

  await launch('5: back to the first project, then import the old folder', async (page, app) => {
    await sleep(3000)
    await openShelf(page, app)
    await page.locator('.projects-name', { hasText: first }).click()
    await settleProject(page, first)
    expect((await partOf(page, A)).behavior?.endsWith(MARK), 'the first project has its outside edit back')
    expect((await partOf(page, C)).behavior?.endsWith(MARK_C), 'and its in-app edit')

    // Import part > A folder of parts… on the old folder, through the Parts panel
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
    }, custom)
    await page.locator('[data-testid="catalog-import"]').click()
    const folderItem = page.locator('.ctx-menu [data-testid="catalog-import-folder"]')
    expect((await folderItem.count()) === 1, 'Import part offers A folder of parts…')
    await folderItem.click()
    expect(await waitFor(async () => (await partOf(page, ORPHAN)).inLibrary), "the leftover is imported into this project's parts")
    const orphanFile = () => readdirSync(join(projects, first, 'parts')).some((slug) => existsSync(join(projects, first, 'parts', slug, 'manifest.json')) && readFileSync(join(projects, first, 'parts', slug, 'manifest.json'), 'utf8').includes(`"${ORPHAN}"`))
    expect(await waitFor(orphanFile), "and written to this project's folder")
  })

  // and on disk: each edit is in the first project's folder only
  expect(onDisk(MARK).length === 1 && onDisk(MARK)[0].startsWith(`${first}/`), `the outside edit is on disk in the first project only (${onDisk(MARK).join(', ')})`)
  expect(onDisk(MARK_C).length === 1 && onDisk(MARK_C)[0].startsWith(`${first}/`), `the in-app edit is on disk in the first project only (${onDisk(MARK_C).join(', ')})`)
} catch (e) {
  // printed without a leading FAIL: the gate runner reports a script that broke on its own assumptions as HARNESS
  console.error('harness error:', e instanceof Error ? e.message : e)
  vite.kill()
  process.exit(2)
} finally {
  vite.kill()
}

if (failures) {
  console.error(`FAIL: verify-part-library-electron (${failures})`)
  process.exit(1)
}
console.log('PASS: verify-part-library-electron')
