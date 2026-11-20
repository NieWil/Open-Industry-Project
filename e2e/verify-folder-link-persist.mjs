// Verifies that a linked project folder is remembered across a reload (src/editor/project/folderHandleStore.ts
// + projectFolderLink.restoreFolderLink) - in a real browser, against real IndexedDB, over a real
// page reload. This covers what the unit tests cannot, because what they mock is the storage itself.
//
// Why there is no real directory handle here: the feature stores a FileSystemDirectoryHandle, and
// there are only two ways to obtain one: showDirectoryPicker, a native dialog Playwright cannot drive,
// and navigator.storage.getDirectory (OPFS), which needs no dialog. OPFS looks like the obvious route
// but does not work: storing an OPFS directory handle in IndexedDB and then reloading crashes the
// browser process - not the page, the whole browser (`disconnected`, with no pageerror and no crash
// event). That is not this app's doing. It reproduces on a blank same-origin page with no app code:
//   const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('p', { create: true })
//   put { id: 'x', handle: dir } into any object store, let the transaction commit, then reload
// (headless Chromium under Playwright). So this gate proves the half that is reachable (the
// row is written, keyed, survives the reload, is consumed at boot and is cleared on unlink) with a
// stand-in, and leaves what a handle does to projectFolderLink.test.ts.
//
// The stand-in is a plain cloneable object with a `name` and nothing else. That makes the boot path
// fail at the read, which is intended: a restored handle naming a folder that is gone is the normal
// failure of this feature, and it has to arrive as the sticky banner rather than an unhandled
// rejection. Reaching that banner at all proves the row was recalled and fed through resume.
//
// The two-way sync itself, over a real handle, is e2e/verify-browser-folder-sync.mjs (an OPFS handle,
// used live and never reloaded - the reload is what crashes).
//
// Run: node e2e/verify-folder-link-persist.mjs
/* global process, console, window, document, localStorage, indexedDB */
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

/** A project folder as the codec lays it out (format 4), an empty scene. */
const FILES = [
  { path: 'project.json', contents: JSON.stringify({ version: 4, name: 'Folder Line', scene: 'scene.json' }) },
  { path: 'scene.json', contents: JSON.stringify({ version: 4, parts: [] }) },
]

/** The DirLike a picker would hand over - methods and all, so structured clone refuses it. */
function installFakeFolder(files) {
  const byPath = new Map(files.map((f) => [f.path, f.contents]))
  const fileHandle = (name, path) => ({
    kind: 'file',
    name,
    getFile: async () => ({ lastModified: 1, size: byPath.get(path).length, text: async () => byPath.get(path) }),
  })
  const dirAt = (name, prefix) => ({
    name,
    entries: async function* () {
      const seen = new Set()
      for (const path of byPath.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) yield [rest, fileHandle(rest, path)]
        else if (!seen.has(rest.slice(0, slash))) {
          seen.add(rest.slice(0, slash))
          yield [rest.slice(0, slash), dirAt(rest.slice(0, slash), `${prefix}${rest.slice(0, slash)}/`)]
        }
      }
    },
  })
  window.__fakeFolder = { dir: dirAt('my-factory', '') }
}

/** Every row of the handle store, read straight out of IndexedDB. */
const handleRows = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web-folder')
        req.onerror = () => resolve([])
        req.onupgradeneeded = () => req.transaction.abort() // never create it from the test
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('handles')) return resolve([])
          const all = db.transaction(['handles'], 'readonly').objectStore('handles').getAll()
          all.onsuccess = () => resolve(all.result.map((r) => ({ id: r.id, name: r.handle?.name ?? null, signature: r.signature ?? null })))
          all.onerror = () => resolve([])
        }
      }),
  )

/** Plant a remembered folder for the open document, the way a previous session would have left one. */
const plantRow = (page, name) =>
  page.evaluate(
    (folderName) =>
      new Promise((resolve) => {
        const id = localStorage.getItem('oip-web/document-id')
        const req = indexedDB.open('oip-web-folder', 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'id' })
        }
        req.onerror = () => resolve(null)
        req.onsuccess = () => {
          const tx = req.result.transaction(['handles'], 'readwrite')
          tx.oncomplete = () => resolve(id)
          tx.onerror = () => resolve(null)
          // cloneable, so it really lands; no entries(), so the read it feeds will fail
          tx.objectStore('handles').put({ id, handle: { name: folderName }, signature: 'stale' })
        }
      }),
    name,
  )

const state = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { linked: s.linkedFolder, error: s.folderError, paused: s.pausedFolder, name: s.projectName }
  })

async function waitFor(page, fn, arg = null, timeout = 30000) {
  const until = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(fn, arg)) return true
    if (Date.now() > until) return false
    await page.waitForTimeout(100)
  }
}

/** Booted AND settled: reloading while part GLBs are still arriving tears a live WebGL context down
 *  mid-load, and headless does not always recover. assetsBusy is the repo's positive settle signal. */
async function booted(page) {
  if (!(await waitFor(page, () => !!(window.__oip && window.__oip.store)))) return false
  if (!(await waitFor(page, () => localStorage.getItem('oip-web/document-id') !== null))) return false
  // the App-installed half of the hook (assetsBusy, linkFolder, ...) arrives after the store's: a missing
  // assetsBusy means "not booted yet", not "not busy"; reading it as the latter races linkFolder
  return waitFor(page, () => typeof window.__oip.assetsBusy === 'function' && !window.__oip.assetsBusy(), null, 60000)
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', (e) => console.error('  page error:', e.message))
  let browserDied = false
  browser.on('disconnected', () => (browserDied = true))

  try {
    await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    expect(await booted(page), 'the app booted')

    console.log('--- a handle the browser cannot clone costs the memory, never the link ---')
    // the synthetic DirLike every other folder gate uses: real methods, so IndexedDB refuses it
    await page.evaluate(installFakeFolder, FILES)
    const linkError = await page.evaluate(() => window.__oip.linkFolder(window.__fakeFolder.dir))
    expect(linkError === null, `linking still succeeds (${linkError})`)
    expect((await state(page)).linked === 'my-factory', 'and the folder is followed')
    expect((await state(page)).name === 'Folder Line', "the folder's project is open")
    expect((await handleRows(page)).length === 0, `nothing was remembered, and nothing threw (${JSON.stringify(await handleRows(page))})`)
    await page.evaluate(() => window.__oip.unlinkFolder())

    console.log('--- a remembered folder survives a reload and is picked up at boot ---')
    const doc = await plantRow(page, 'ghost-folder')
    expect(doc !== null, `a row was written for the open document (${doc})`)
    let rows = await handleRows(page)
    expect(rows.length === 1 && rows[0].id === doc, `keyed by document id (${JSON.stringify(rows)})`)

    await page.reload({ waitUntil: 'domcontentloaded' })
    expect(await booted(page), 'the app booted again')
    expect(!browserDied, 'the browser survived the reload')
    // no picker, no click, no hook: restoreFolderLink runs in the boot path and consumes the row
    const consumed = await waitFor(page, () => window.__oip.store.getState().linkedFolder !== null)
    const after = await state(page)
    expect(consumed, `the remembered folder was picked up with no user action (${JSON.stringify(after)})`)
    expect(after.linked === 'ghost-folder', `and it is the folder that was remembered (${after.linked})`)

    console.log('--- a folder that is no longer readable says so, instead of failing silently ---')
    // the normal end of a remembered handle: the folder moved, was deleted, or the drive is gone
    expect(after.error !== null, `the sticky banner carries the reason (${after.error})`)
    expect(/ghost-folder/.test(after.error ?? ''), 'naming the folder it could not read')
    const banner = await page.locator('.autosave-banner').first().innerText()
    expect(/Folder not in sync/i.test(banner), `and it is on screen (${banner.replace(/\n/g, ' ').slice(0, 90)})`)

    console.log('--- unlinking forgets it, so the next boot does not resume ---')
    await page.evaluate(() => window.__oip.unlinkFolder())
    expect((await state(page)).linked === null, 'unlinked now')
    expect(await waitFor(page, () => true) && (await handleRows(page)).length === 0, `the row is gone (${JSON.stringify(await handleRows(page))})`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    expect(await booted(page), 'the app booted a third time')
    const control = await state(page)
    // the control for every assertion above: same storage, same boot path, no row - so nothing happens
    expect(control.linked === null && control.error === null, `nothing was restored (${JSON.stringify(control)})`)
  } finally {
    await browser.close()
    vite.kill()
  }

  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
