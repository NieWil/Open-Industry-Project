// An older multi-scene project folder, opened in the real desktop shell, splits into one project per scene
// (src/editor/project/projectSplit.ts, docs/projects.md "Splitting an older project"). From format 4 a project holds one
// scene; a format-3 folder listing three scenes still opens: the scene that was active stays the project, and
// each other scene becomes a project "<project> - <scene>" in a folder of its own beside the project's folder,
// after a single confirmation.
//
//   pass 1 (Yes)    the project on screen is the active scene's, under the project's name; two sibling folders
//                   hold the other scenes as valid format-4 projects, each with the tests that named it; the
//                   original folder is rewritten format-4 with its scenes/ files gone; the projects list and
//                   File > Open Recent know all three.
//   pass 2 (Cancel) on a fresh copy: the session is read-only, nothing in the folder changed (byte for byte), no
//                   sibling folder appeared, and a relaunch asks again.
//
// Opened the way a user does, File > Open Project Folder…, with only the native picker stubbed (unattended runs
// can't click one), the same approach verify-project-folder-electron.mjs uses. Throwaway --user-data-dir per pass.
//
//   node e2e/verify-project-split-electron.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

let failed = false
const check = (ok, msg) => {
  if (!ok) failed = true
  console.log(`${ok ? '  ok' : '  FAIL'}: ${msg}`)
}
const waitFor = async (probe, what, timeoutMs = 20000) => {
  const t0 = Date.now()
  for (;;) {
    if (await probe()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const PROJECT = 'Split Line'
const SPLIT_QUESTION = 'Make these folders now?' // the tail of projectSplit.ts folderSplitQuestion

// ── the older folder: format 3, three scenes, the second one active ─────────────────────────────────────
const group = (id) => ({ id, type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} })
const scene = (...ids) => JSON.stringify({ version: 4, parts: ids.map(group) }, null, 2) + '\n'
// Line A also places the library part, so the split has something to carry into Line A's project and to leave out
// of Line C's (core/project/project.ts usedLibraryOnly)
const libPart = { id: 'a-lib', type: 'part', packageId: 'split.part', position: [2, 0.2, 0], rotationY: 0, params: {} }
const sceneWithLib = (...ids) => JSON.stringify({ version: 4, parts: [...ids.map(group), libPart] }, null, 2) + '\n'
const test = (name, sceneId) =>
  JSON.stringify({ name, ...(sceneId ? { scene: sceneId } : {}), duration: 1, checks: [{ always: true, tag: 'Never', equals: false }] }, null, 2) + '\n'

function writeOldProject(parent) {
  const root = join(parent, PROJECT)
  const files = {
    'project.json':
      JSON.stringify(
        {
          version: 3,
          name: PROJECT,
          activeScene: 1,
          packages: ['parts/split.part'],
          scenes: [
            { id: 'line-a', name: 'Line A', scene: 'scenes/line-a.scene.json', stProgram: 'scenes/line-a.st' },
            { id: 'line-b', name: 'Line B', scene: 'scenes/line-b.scene.json', stProgram: 'scenes/line-b.st' },
            { id: 'line-c', name: 'Line C', scene: 'scenes/line-c.scene.json' },
          ],
          tests: ['tests/a.test.json', 'tests/b.test.json', 'tests/c.test.json', 'tests/any.test.json'],
        },
        null,
        2,
      ) + '\n',
    'scenes/line-a.scene.json': sceneWithLib('a-part'),
    'scenes/line-a.st': 'VAR_OUTPUT\n  LineA : BOOL;\nEND_VAR\n',
    'scenes/line-b.scene.json': scene('b-part', 'b-part-2'),
    'scenes/line-b.st': 'VAR_OUTPUT\n  LineB : BOOL;\nEND_VAR\n',
    'scenes/line-c.scene.json': scene('c-part'),
    'tests/a.test.json': test('a runs', 'line-a'),
    'tests/b.test.json': test('b runs', 'line-b'),
    'tests/c.test.json': test('c runs', 'line-c'),
    // names no scene: it was the active scene's
    'tests/any.test.json': test('any runs'),
    'parts/split.part/manifest.json':
      JSON.stringify(
        {
          id: 'split.part',
          name: 'Split Part',
          geometry: {
            kind: 'rig',
            links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }],
            joints: [],
            bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 },
          },
        },
        null,
        2,
      ) + '\n',
    'parts/split.part/behavior.js': "definePart({ params: { speed: { type: 'number', default: 0.5 } }, step() {} })",
  }
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, ...path.split('/'))
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

/** Every file under `dir`, as { 'rel/path': Buffer }. */
function snapshot(dir) {
  const out = {}
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p)
    }
  }
  walk(dir)
  return out
}
function sameSnapshot(a, b) {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.join('\n') !== kb.join('\n')) return `files differ: [${ka.join(', ')}] vs [${kb.join(', ')}]`
  const changed = ka.filter((k) => !a[k].equals(b[k]))
  return changed.length === 0 ? null : `changed: ${changed.join(', ')}`
}

/**
 * A format-4 folder's own view: its manifest, scene part ids, program, tests (by name) and part folders. Throws
 * when the folder is not a valid one-scene project.
 */
function readFormat4(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
  if (!(manifest.version >= 4)) throw new Error(`${root}: project.json version ${manifest.version}, older than the one-scene format 4`)
  if (manifest.scenes !== undefined || manifest.activeScene !== undefined) throw new Error(`${root}: the manifest still lists scenes`)
  if (manifest.scene !== 'scene.json') throw new Error(`${root}: the manifest names its scene ${JSON.stringify(manifest.scene)}`)
  const parts = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8')).parts.map((p) => p.id)
  // the program's files, one per POU under plc/ (format 7)
  const program = Array.isArray(manifest.program) ? manifest.program.map((f) => readFileSync(join(root, f), 'utf8')).join('\n\n') : null
  const tests = (manifest.tests ?? []).map((t) => JSON.parse(readFileSync(join(root, t), 'utf8')).name)
  const packages = (manifest.packages ?? []).filter((dir) => existsSync(join(root, dir, 'manifest.json')) && existsSync(join(root, dir, 'behavior.js')))
  return { manifest, parts, program, tests, packages }
}

const sceneFilesLeft = (root) => (existsSync(join(root, 'scenes')) ? Object.keys(snapshot(join(root, 'scenes'))) : [])

// ── the shell ───────────────────────────────────────────────────────────────────────────────────────────
const { url, vite } = await startServer()
const temps = []
const tempDir = (prefix) => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(d)
  return d
}

/**
 * Launch the dev shell on `profileDir`, answering the split question with `answer` (every other confirm: yes).
 * The answer is installed three ways, because the question comes during boot: on the page already up, as an init
 * script for every load after it (opening a folder reloads the window), and as a dialog handler for a confirm
 * raised before either could be installed (a relaunch's very first load).
 */
async function launch(profileDir, answer) {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  delete env.OIP_PROJECTS_DIR
  const app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const asked = [] // split questions raised past the stubs, as native dialogs
  const stub = (a) => {
    window.__splitAsked = window.__splitAsked ?? []
    window.confirm = (m) => {
      const text = String(m)
      if (text.includes('Make these folders now?')) {
        window.__splitAsked.push(text)
        return a
      }
      return true
    }
    window.alert = (m) => {
      window.__lastAlert = String(m)
    }
  }
  await app.context().addInitScript(stub, answer)
  const page = await app.firstWindow()
  page.on('dialog', (d) => {
    if (d.message().includes(SPLIT_QUESTION)) {
      asked.push(d.message())
      void (answer ? d.accept() : d.dismiss())
    } else void d.accept()
  })
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.folderSync, null, { timeout: 60000 })
  await page.evaluate(stub, answer)
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  return { app, page, asked }
}

/** File > Open Project Folder… on `root` (only the native picker stubbed), waiting out the reload into it. */
async function openFolder(app, page, root) {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, root)
  await page.evaluate(() => ((window.__splitMark = true), undefined))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.openProject'))
  await page.waitForFunction(() => window.__splitMark === undefined && !!window.__oip?.store, null, { timeout: 60000 })
  await page.waitForSelector('.toolbar', { timeout: 60000 })
}

const state = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return {
      name: s.projectName,
      parts: s.scene.parts.map((p) => p.id),
      program: s.stProgram,
      readOnly: s.readOnly,
      folder: s.folderPath,
      notice: s.saveNotice?.title ?? null,
      asked: window.__splitAsked ?? [],
      alert: window.__lastAlert ?? null,
    }
  })

let app = null
try {
  // ═══ pass 1: Yes ═════════════════════════════════════════════════════════════════════════════════════
  console.log('--- pass 1: the split accepted ---')
  {
    const parent = tempDir('oip-split-yes-')
    const root = writeOldProject(parent)
    const profileDir = tempDir('oip-split-profile-')
    const launched = await launch(profileDir, true)
    app = launched.app
    const { page } = launched
    await openFolder(app, page, root)
    await waitFor(() => state(page).then((s) => s.notice === 'Split into projects'), 'the "Split into projects" notice')
    const s = await state(page)
    check(s.asked.length + launched.asked.length === 1, `the split was asked once (${s.asked.length} in page, ${launched.asked.length} native)`)
    const question = s.asked[0] ?? launched.asked[0] ?? ''
    check(
      question.includes(`${PROJECT} - Line A`) && question.includes(`${PROJECT} - Line C`) && !question.includes(`${PROJECT} - Line B`),
      'the question lists the two folders it will make, not the active scene',
    )
    check(s.name === PROJECT, `the project on screen keeps its name (${s.name})`)
    check(s.parts.includes('b-part') && s.parts.includes('b-part-2') && !s.parts.includes('a-part'), `it is the active scene, Line B (${s.parts.join(', ')})`)
    check((s.program ?? '').includes('LineB'), "with Line B's program")
    check(!s.readOnly, 'and is editable')
    // the folder sync starts once the filing that showed the notice has resolved (App.tsx splitFiling), a moment later
    await waitFor(() => state(page).then((st) => st.folder === root), 'the folder sync').catch(() => {})
    const folder = (await state(page)).folder
    check(folder === root, `it still lives in its folder (${folder})`)
    check(s.alert === null, `no alert (${s.alert})`)

    const siblings = readdirSync(parent).sort()
    check(
      JSON.stringify(siblings) === JSON.stringify([PROJECT, `${PROJECT} - Line A`, `${PROJECT} - Line C`]),
      `the other scenes got folders beside the project's (${siblings.join(' | ')})`,
    )
    const a = readFormat4(join(parent, `${PROJECT} - Line A`))
    check(a.manifest.name === `${PROJECT} - Line A`, `"${PROJECT} - Line A" is named for its scene (${a.manifest.name})`)
    check(JSON.stringify(a.parts) === '["a-part","a-lib"]', `and holds Line A (${a.parts.join(', ')})`)
    check((a.program ?? '').includes('LineA'), "with Line A's program in plc/")
    check(JSON.stringify(a.tests) === '["a runs"]', `and only the test that named it (${a.tests.join(', ')})`)
    check(a.packages.length === 1, `and a copy of the library part its scene places (${a.manifest.packages?.join(', ')})`)
    const c = readFormat4(join(parent, `${PROJECT} - Line C`))
    check(c.manifest.name === `${PROJECT} - Line C`, `"${PROJECT} - Line C" is named for its scene (${c.manifest.name})`)
    check(JSON.stringify(c.parts) === '["c-part"]', `and holds Line C (${c.parts.join(', ')})`)
    check(c.program === null && !existsSync(join(parent, `${PROJECT} - Line C`, 'plc')), 'with no program, as it had none')
    check(JSON.stringify(c.tests) === '["c runs"]', `and only the test that named it (${c.tests.join(', ')})`)
    check(c.packages.length === 0, `and no library part, since its scene places none (${c.manifest.packages?.join(', ') ?? 'none'})`)

    // the original folder: the format-4 layout, written by the split itself before the sync's first round
    await waitFor(
      () => {
        try {
          return readFormat4(root) && sceneFilesLeft(root).length === 0
        } catch {
          return false
        }
      },
      'the project folder to be rewritten in the one-scene layout',
    )
    const b = readFormat4(root)
    check(b.manifest.name === PROJECT, `the project's own folder is format 4 under its name (${b.manifest.name})`)
    check(b.parts.includes('b-part') && b.parts.includes('b-part-2') && b.parts.length === 2, `its scene.json is Line B (${b.parts.join(', ')})`)
    check(JSON.stringify(b.manifest.program) === '["plc/program.st"]' && (b.program ?? '').includes('LineB'), 'its program is plc/program.st, Line B')
    check(JSON.stringify([...b.tests].sort()) === '["any runs","b runs"]', `it kept its own tests and the unnamed one (${b.tests.join(', ')})`)
    check(b.packages.length === 1, 'and its part library')
    check(sceneFilesLeft(root).length === 0, `its scenes/ files are gone (${sceneFilesLeft(root).join(', ')})`)

    // the projects list and File > Open Recent know all three
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.projects'))
    await page.waitForSelector('[data-projects-overlay] .projects-row', { timeout: 10000 })
    const rows = await page.locator('[data-projects-overlay] .projects-label').allTextContents()
    check(
      [PROJECT, `${PROJECT} - Line A`, `${PROJECT} - Line C`].every((n) => rows.includes(n)),
      `the projects list shows all three (${rows.join(' | ')})`,
    )
    await page.keyboard.press('Escape')
    const recent = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
      return file?.submenu?.items.find((i) => i.label === 'Open Recent')?.submenu?.items.map((i) => i.label) ?? []
    })
    check(
      [`${PROJECT} - Line A`, `${PROJECT} - Line C`].every((n) => recent.some((label) => label.includes(join(parent, n)))),
      `File > Open Recent lists the new folders (${recent.join(' | ')})`,
    )
    // and the folder sync, started once the split was filed, leaves the split alone: nothing comes back
    await pause(2500)
    check(sceneFilesLeft(root).length === 0 && !existsSync(join(root, 'scenes', 'line-a.scene.json')), 'the folder sync wrote no scenes/ file back')
    await app.close()
    app = null
  }

  // ═══ pass 2: Cancel ══════════════════════════════════════════════════════════════════════════════════
  console.log('--- pass 2: the split declined ---')
  {
    const parent = tempDir('oip-split-no-')
    const root = writeOldProject(parent)
    const before = snapshot(root)
    const profileDir = tempDir('oip-split-profile-')
    let launched = await launch(profileDir, false)
    app = launched.app
    let page = launched.page
    await openFolder(app, page, root)
    await waitFor(() => state(page).then((s) => s.notice === 'Opened read-only'), 'the "Opened read-only" notice')
    let s = await state(page)
    check(s.asked.length + launched.asked.length === 1, 'the split was asked once')
    check(s.readOnly === true, 'Cancel leaves the session read-only')
    check(s.name === PROJECT && s.parts.includes('b-part'), `on the active scene, under the project's name (${s.name}: ${s.parts.join(', ')})`)
    await pause(3000) // anything that would wrongly write has had its chance (the sync starts once the question is answered)
    let diff = sameSnapshot(before, snapshot(root))
    check(diff === null, `nothing in the folder changed${diff ? ` (${diff})` : ''}`)
    check(JSON.stringify(readdirSync(parent)) === JSON.stringify([PROJECT]), `no sibling folder was made (${readdirSync(parent).join(' | ')})`)
    await app.close()
    app = null

    // relaunch: the same profile boots into the same project, and asks again
    launched = await launch(profileDir, false)
    app = launched.app
    page = launched.page
    await waitFor(() => state(page).then((st) => st.notice === 'Opened read-only'), 'the relaunch to ask again (and be told no)', 30000)
    s = await state(page)
    check(s.asked.length + launched.asked.length === 1, `the relaunch asked again (${s.asked.length} in page, ${launched.asked.length} native)`)
    check(s.readOnly === true && s.name === PROJECT, 'and is read-only on the same project')
    await pause(3000)
    diff = sameSnapshot(before, snapshot(root))
    check(diff === null, `still nothing in the folder changed${diff ? ` (${diff})` : ''}`)
    check(JSON.stringify(readdirSync(parent)) === JSON.stringify([PROJECT]), 'and still no sibling folder')
    await app.close()
    app = null
  }
} catch (e) {
  failed = true
  console.log('  FAIL: threw', e)
} finally {
  await app?.close().catch(() => {})
  vite.kill()
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* locked: left for the OS */
    }
  }
}
console.log(failed ? 'FAIL verify-project-split-electron' : 'PASS verify-project-split-electron')
process.exit(failed ? 1 : 0)
