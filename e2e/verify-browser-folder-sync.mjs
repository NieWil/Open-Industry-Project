// The browser's project folder, kept in sync both ways (src/editor/project/projectFolderLink.ts hosting the
// engine in src/editor/project/projectFolderSync.ts), in a real Chromium, against a real directory handle.
//
// The handle comes from the Origin Private File System (navigator.storage.getDirectory), because the
// picker for a real folder is a native dialog Playwright cannot drive. It is a genuine
// FileSystemDirectoryHandle - entries, getFileHandle, createWritable, removeEntry - so the guarded writes
// and reads here are the ones a user's folder gets. One constraint shapes this gate: an OPFS handle stored
// in IndexedDB crashes the browser on the next reload (see verify-folder-link-persist.mjs). The link does store
// its handle, so this gate never reloads; the reload half is that gate's job, with a stand-in.
//
// Rounds are driven explicitly (window.__oip.folderSync.now()) rather than waited out on the engine's
// timers. Headless Chromium renders this app at ~2 fps, so every task waits behind a ~0.8 s frame and one
// round over a real handle (a few dozen awaits) takes 8-20 s here, against well under a second at 60 fps.
// The timers' own behaviour - the write delay, the poll - is pinned on a fake clock in
// src/editor/project/projectFolderSync.test.ts; this gate proves what a round does to a real folder.
//
//   1. Save to Folder writes the project into the folder and keeps it in sync
//   2. an edit made in the app is written into the folder
//   3. an edit made in the folder (an agent) is loaded into the app
//   4. the same file changed in both places is held as a conflict until "Keep my version"
//   5. Ctrl+S writes and names the folder
//   6. Unlink stops the writes; Link opens the folder's project again, in sync
//
// Run: node e2e/verify-browser-folder-sync.mjs
/* global process, console, window, document, navigator, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

/** a slow-frame-safe wait: a round in headless is seconds long, and a click-driven one is several rounds */
async function waitFor(page, fn, arg = null, timeout = 120000) {
  const until = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(fn, arg)) return true
    if (Date.now() > until) return false
    await page.waitForTimeout(250)
  }
}

/** Install page helpers over the OPFS folder: read and write a file by its project-relative path. */
function installOpfs() {
  window.__folder = {
    async dir() {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle('oip-sync-gate', { create: true })
    },
    async read(path) {
      try {
        let d = await this.dir()
        const segments = path.split('/')
        for (const s of segments.slice(0, -1)) d = await d.getDirectoryHandle(s)
        return await (await (await d.getFileHandle(segments.at(-1))).getFile()).text()
      } catch {
        return null
      }
    },
    async write(path, text) {
      let d = await this.dir()
      const segments = path.split('/')
      for (const s of segments.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true })
      const w = await (await d.getFileHandle(segments.at(-1), { create: true })).createWritable()
      await w.write(text)
      await w.close()
    },
  }
}

const readFile = (page, path) => page.evaluate((p) => window.__folder.read(p), path)
const writeFile = (page, path, text) => page.evaluate(([p, t]) => window.__folder.write(p, t), [path, text])
const syncNow = (page) => page.evaluate(() => window.__oip.folderSync.now())
const addGroup = (page, id) =>
  page.evaluate((partId) => {
    const store = window.__oip.store
    const scene = store.getState().scene
    store.commit('Add group', { ...scene, parts: [...scene.parts, { id: partId, type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} }] })
  }, id)

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (e) => console.error('  page error:', e.message))
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`, { timeout: 180000 })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.saveFolder), null, { timeout: 60000 })
    await page.waitForFunction(() => localStorage.getItem('oip-web/document-id') !== null, null, { timeout: 60000 })
    await page.evaluate(installOpfs)
    await page.evaluate(() => window.__oip.store.renameProject('Browser Line'))

    console.log('--- Save to Folder ---')
    const saveError = await page.evaluate(async () => window.__oip.saveFolder(await window.__folder.dir()))
    expect(saveError === null, `it saved (${saveError})`)
    const manifest = JSON.parse((await readFile(page, 'project.json')) ?? '{}')
    expect(manifest.name === 'Browser Line', `the folder holds the project (${manifest.name})`)
    expect((await readFile(page, 'AGENTS.md')) !== null, 'with the agent guide beside it')
    expect((await page.evaluate(() => window.__oip.store.getState().folderPath)) === 'oip-sync-gate', 'and the project lives there now')
    // one scene, named by the manifest, at the folder root: the layout since format 4
    const scenePath = manifest.scene
    expect(manifest.version >= 4 && scenePath === 'scene.json' && manifest.scenes === undefined, `in the one-scene layout (format 4 on) (${JSON.stringify({ version: manifest.version, scene: manifest.scene })})`)

    console.log('--- app -> folder ---')
    await addGroup(page, 'made-in-browser')
    await syncNow(page)
    expect(((await readFile(page, scenePath)) ?? '').includes('made-in-browser'), 'an edit made here was written into the folder')

    console.log('--- folder -> app ---')
    const onDisk = JSON.parse(await readFile(page, 'project.json'))
    onDisk.name = 'Renamed In Folder'
    await writeFile(page, 'project.json', JSON.stringify(onDisk, null, 2) + '\n')
    await syncNow(page)
    expect((await page.evaluate(() => window.__oip.store.getState().projectName)) === 'Renamed In Folder', 'an edit made in the folder loaded into the app')
    expect(await page.evaluate(() => window.__oip.store.canUndo), 'and the scene on screen kept its undo history')

    console.log('--- both sides -> conflict ---')
    await page.evaluate(() => window.__oip.store.commitProgram('Program', { source: 'VAR_OUTPUT\n  Base : BOOL;\nEND_VAR\n' }))
    await syncNow(page)
    const stManifest = JSON.parse((await readFile(page, 'project.json')) ?? '{}')
    // one file per POU under plc/, listed by the manifest (format 7); this program is one block, so one file
    const stPath = Array.isArray(stManifest.program) && stManifest.program.length === 1 ? stManifest.program[0] : null
    expect(stPath === 'plc/program.st' && ((await readFile(page, stPath)) ?? '').includes('Base'), `the program was written, and the manifest names it (${stPath})`)
    await page.evaluate(() => window.__oip.store.commitProgram('Mine', { source: 'VAR_OUTPUT\n  Mine : BOOL;\nEND_VAR\n' }))
    await writeFile(page, stPath, 'VAR_OUTPUT\n  Theirs : BOOL;\nEND_VAR\n')
    await syncNow(page)
    expect(await page.evaluate(() => !!document.querySelector('[data-testid="folder-conflict"]')), 'the same file changed in both places raised the conflict banner')
    await syncNow(page) // a second round must not move anything either
    expect(((await readFile(page, stPath)) ?? '').includes('Theirs'), 'and nothing was written over the folder meanwhile')
    expect(await page.evaluate(() => window.__oip.store.getState().stProgram.includes('Mine')), 'nor loaded over the app')
    // a DOM click: locator.click waits for frames that headless hands out at ~2 fps
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="folder-conflict"] button')].find((b) => b.textContent === 'Keep my version').click())
    const kept = await waitFor(page, (p) => window.__folder.read(p).then((t) => (t ?? '').includes('Mine')), stPath)
    expect(kept, '"Keep my version" wrote the app version')

    console.log('--- Ctrl+S ---')
    await addGroup(page, 'saved-by-ctrl-s')
    await page.evaluate(() => window.__oip.store.dismissSaveNotice())
    await page.keyboard.press('Control+s')
    const saved = await waitFor(page, () => !!document.querySelector('[data-testid="save-notice"] .part-build-toast-error'))
    const notice = await page.evaluate(() => document.querySelector('[data-testid="save-notice"] .part-build-toast-error')?.textContent ?? '')
    expect(saved && notice === 'All changes are in the folder "oip-sync-gate".', `Save names the folder (${notice})`)
    expect(((await readFile(page, scenePath)) ?? '').includes('saved-by-ctrl-s'), 'and the folder already has the edit')

    console.log('--- unlink, then link ---')
    await page.evaluate(() => window.__oip.unlinkFolder())
    expect((await page.evaluate(() => window.__oip.store.getState().folderPath)) === null, 'unlinked')
    await addGroup(page, 'after-unlink')
    await syncNow(page) // a no-op with no folder - the proof is that nothing below changed
    await page.waitForTimeout(2000)
    expect(!((await readFile(page, scenePath)) ?? '').includes('after-unlink'), 'an edit after Unlink stays out of the folder')
    await page.evaluate(() => (window.confirm = () => true))
    const linkError = await page.evaluate(async () => window.__oip.linkFolder(await window.__folder.dir()))
    expect(linkError === null, `Link opened the folder (${linkError})`)
    const reopened = await page.evaluate(() => {
      const s = window.__oip.store.getState()
      return { name: s.projectName, path: s.folderPath }
    })
    expect(reopened.name === 'Renamed In Folder' && reopened.path === 'oip-sync-gate', `as its own project, in step again (${JSON.stringify(reopened)})`)
    await addGroup(page, 'after-link')
    await syncNow(page)
    expect(((await readFile(page, scenePath)) ?? '').includes('after-link'), 'and edits reach the folder again')

    // leave nothing behind: the remembered handle is an OPFS one (see the header)
    await page.evaluate(() => window.__oip.unlinkFolder())
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('oip-sync-gate', { recursive: true }))
    await page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nall browser-folder-sync checks passed' : `\nFAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
