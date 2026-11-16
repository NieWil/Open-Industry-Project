// The project shelf (several projects in one app), end to end in a real browser.
//
// No unit test can check any of this, because the library is IndexedDB (absent in the Node env, where
// documentStore.test.ts checks the other side: that a browser without it falls back to the
// single-document behaviour instead of throwing).
//
// What it checks, in the order a user encounters it:
//   - boot files the working copy as document #1 (the migration), so a returning user who opens the
//     shelf finds their work in it rather than an empty list
//   - a new project is a real second document: created, opened, and carrying none of the first one's
//     parts. A shared-store bug would show up here
//   - switching back restores the first document's parts and its name. The switch is write-then-reload
//     through the one tested boot path (documentStore.openDocument), so a part that survives it survives
//     everything
//   - the open document cannot be deleted (it is the working copy; the editor would be holding a
//     project the library no longer knows about), and any other can
//   - the library survives a reload
//   - an imported .oip is added beside the open project rather than replacing it. Adoption overwrites
//     the working copy, so the document pointer has to be detached, or the library files the import
//     into the outgoing project's row and destroys a document the user was not looking at
//   - the same for a linked folder, the one adoption that cannot reload (documentStore.adoptDocumentInPlace)
//   - a saved project this build cannot open is set aside rather than replaced: no save and no library
//     sync writes to it, leaving for another project is refused, the banner's Download hands it over,
//     and its Discard files what is on screen as a new document while the old record stays intact
//
// Every wait here polls on a timer. Once the scene settles the viewport renders on demand and the
// page stops painting, so Playwright's default rAF-scheduled poller never runs again: the node is
// there and waitForSelector still times out (verify-command-palette.mjs hit this first). Clicks are
// forced for the same reason: actionability re-checks can hang on a page that is not painting.
// Run: node e2e/verify-project-shelf.mjs
/* global process, console, window, document, localStorage, Buffer, indexedDB */
import { readFile } from 'node:fs/promises'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

const APP_TITLE = 'Open Industry Project'

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

/** timer-polled presence wait - see the header */
const waitFor = (page, fn, arg = null, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 })

async function waitForApp(page) {
  // `store` is set at boot (main.tsx), but the App-level part of the hook (including linkFolder) only once the
  // renderer exists (App.tsx), so a reload that waited on store alone could call linkFolder before it existed
  await waitFor(page, () => !!(window.__oip && window.__oip.store && typeof window.__oip.linkFolder === 'function'), null, 30000)
  // the boot sync files document #1 off a promise chain, not a paint: wait for the pointer it writes
  await waitFor(page, () => localStorage.getItem('oip-web/document-id') !== null)
}

/** Open the shelf the way a user with no menu bar has to: the command palette. The row is clicked
 *  rather than Enter pressed: the palette ranks parts and catalog cards alongside commands, so the
 *  top hit for `projects` depends on what the scene holds. */
async function openShelf(page) {
  await page.keyboard.press('Control+Shift+P')
  await waitFor(page, () => !!document.querySelector('.palette-input'))
  await page.fill('.palette-input', 'projects')
  await waitFor(page, () =>
    [...document.querySelectorAll('.palette-item .palette-label')].some((e) => (e.textContent ?? '').startsWith('Projects')),
  )
  await page
    .locator('.palette-item', { has: page.locator('.palette-label', { hasText: /^Projects/ }) })
    .first()
    .click({ force: true })
  await waitFor(page, () => document.querySelectorAll('.projects-row').length > 0)
}

const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.projects-row')].map((r) => ({
      name: r.querySelector('.projects-label')?.textContent?.trim() ?? '',
      current: r.getAttribute('data-current') === 'true',
      deletable: !r.querySelector('.projects-action[aria-label^="Delete"]')?.disabled,
    })),
  )

/** what tells the documents apart: the names of this gate's own parts (ids `shelf_*`) in the open project's scene.
 *  Whatever a new project starts with (the building) is not checked */
const tabs = async (page) =>
  (await page.evaluate(() => window.__oip.store.getState().scene.parts.filter((p) => p.id.startsWith('shelf_')).map((p) => p.name))).join()
/** a real document edit: one part added (a box spawner, nothing to bake) */
const addPart = (page, id, name) =>
  page.evaluate(
    ([id, name]) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const part = { id, type: 'part', packageId: 'oip.box-spawner', name, position: [scene.parts.length * 2, 0, 0], rotationY: 0, params: {} }
      st.commit('Add part', { ...scene, parts: [...scene.parts, part] })
    },
    [id, name],
  )
const closeShelf = async (page) => {
  await page.keyboard.press('Escape')
  await waitFor(page, () => !document.querySelector('[data-projects-overlay]'))
}

/** Click something that reloads the app, and wait for the next document to boot. Marks this window
 *  first: `__oip` is gone after the reload, so the mark's absence shows the swap happened. */
async function awaitReload(page, action) {
  await page.evaluate(() => ((window.__shelfMark = true), undefined))
  await action()
  await waitFor(page, () => window.__shelfMark === undefined, null, 30000)
  await waitForApp(page)
}

const clickAndReload = (page, locator) => awaitReload(page, () => locator.click({ force: true }))

/** Every library record, read straight out of IndexedDB: id, name, and the part names its payload's scene holds. */
const libraryDocs = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web')
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['docIndex', 'docPayload'], 'readonly')
          const index = tx.objectStore('docIndex').getAll()
          const payloads = tx.objectStore('docPayload').getAll()
          tx.oncomplete = () => {
            db.close()
            resolve(
              index.result.map((meta) => ({
                id: meta.id,
                name: meta.name,
                parts: (((r) => r && (r.project ?? JSON.parse(r.text)))(payloads.result.find((p) => p.id === meta.id))?.scene?.parts ?? [])
                  .filter((p) => p.id.startsWith('shelf_'))
                  .map((p) => p.name),
              })),
            )
          }
        }
      }),
  )

/** The library is written on a trailing debounce, so poll it (on a timer, like every wait here). */
async function waitForLibrary(page, ok, timeout = 15000) {
  const t0 = Date.now()
  for (;;) {
    const docs = await libraryDocs(page)
    if (ok(docs) || Date.now() - t0 > timeout) return docs
    await page.waitForTimeout(200)
  }
}

/** A project folder as the codec lays it out (format 4), an empty scene. */
const folderFiles = (name) => [
  { path: 'project.json', contents: JSON.stringify({ version: 4, name, scene: 'scene.json' }) },
  { path: 'scene.json', contents: JSON.stringify({ version: 4, parts: [] }) },
]

/** Installed in the page: the DirLike a folder picker would have handed over (verify-project-folder-link.mjs
 *  drives the sweep; here only the first load matters). */
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
  window.__fakeFolder = { dir: dirAt('folder-line', '') }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    // Deleting asks first (window.confirm). Playwright dismisses dialogs unless something handles
    // them, so without this the delete does nothing, which also shows the prompt is really there.
    // ...and each dialog's text is printed: an import that fails says why in an alert, which this would otherwise
    // accept unread, leaving the run to time out waiting for a reload that never happens
    page.on('dialog', (d) => {
      console.log(`  dialog (${d.type()}): ${d.message().slice(0, 300)}`)
      void d.accept()
    })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage - the tour just shows up, harmless here */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(page)

    console.log('--- boot files the working copy as document #1 ---')
    await openShelf(page)
    let list = await rows(page)
    expect(list.length === 1, `a fresh browser lists exactly its own document (${JSON.stringify(list)})`)
    expect(list[0]?.current === true, 'and it is marked as the open one')
    expect(list[0]?.name === 'Untitled Project', `under the name it already carried (${list[0]?.name})`)
    expect(list[0]?.deletable === false, 'the open document cannot be deleted - it IS the working copy')

    // Where projects are stored. A user can lose a project stored in a browser to a cleared cache
    // without ever being told where it was, so the shelf says so once, next to the option to move it
    // to disk. That option is offered only where the browser supports it (Chromium has the directory
    // picker; Safari and Firefox do not), and this asserts that rather than assuming it.
    const where = await page.evaluate(() => document.querySelector('.projects-where')?.textContent ?? '')
    expect(/stored in this browser/i.test(where), `the shelf says where the projects live (${where.slice(0, 48)}...)`)
    const canFolder = await page.evaluate(() => typeof window.showDirectoryPicker === 'function')
    const offered = (await page.locator('.projects-tofolder').count()) === 1
    expect(offered === canFolder, `the way onto disk is offered exactly where it works (picker: ${canFolder}, offered: ${offered})`)

    console.log('--- renaming the open row moves the document itself ---')
    await page.locator('.projects-action[aria-label="Rename Untitled Project"]').click({ force: true })
    await page.fill('.projects-input', 'Line A')
    await page.keyboard.press('Enter')
    await waitFor(page, () => document.title.startsWith('Line A'))
    expect((await page.title()) === `Line A - ${APP_TITLE}`, `the window title followed it (${await page.title()})`)
    await closeShelf(page)

    // a part of its own, so "the second project is empty" is a meaningful check
    await addPart(page, 'shelf_sorter', 'Sorter')
    await waitFor(page, () => window.__oip.store.getState().scene.parts.some((p) => p.id === 'shelf_sorter'))
    expect((await tabs(page)) === 'Sorter', `Line A holds a part (${await tabs(page)})`)

    console.log('--- a new project is a real second document ---')
    await openShelf(page)
    await page.locator('.projects-new').click({ force: true })
    await page.fill('.projects-input', 'Line B')
    await clickAndReload(page, page.locator('.projects-confirm'))
    expect((await page.title()) === `Line B - ${APP_TITLE}`, `it opened into the new document (${await page.title()})`)
    expect((await tabs(page)) === '', `and it carries NONE of Line A's parts (${await tabs(page)})`)

    console.log('--- switching back restores the first document whole ---')
    await openShelf(page)
    list = await rows(page)
    expect(list.length === 2, `both documents are listed (${list.map((r) => r.name).join(', ')})`)
    expect(list.find((r) => r.name === 'Line B')?.current === true, 'Line B is the open one')
    await clickAndReload(page, page.locator('.projects-name', { hasText: 'Line A' }))
    expect((await page.title()) === `Line A - ${APP_TITLE}`, `back in Line A (${await page.title()})`)
    expect((await tabs(page)) === 'Sorter', `with its part intact (${await tabs(page)})`)

    console.log('--- the project menu lists the other projects, one click from open ---')
    // read from the library when the menu opens, so the rows arrive after the menu does
    const recentRows = async () => {
      await page.getByTestId('project-menu').click({ force: true })
      await waitFor(page, () => document.querySelectorAll('[role="menu"] [data-recent-project]').length > 0)
      return page.evaluate(() => [...document.querySelectorAll('[role="menu"] > *')].map((e) => 
        e.hasAttribute('data-recent-project')
          ? `recent:${e.textContent}`
          : (e.getAttribute('data-command') ?? (e.getAttribute('role') === 'separator' ? '|' : e.textContent)),
      ))
    }
    let menu = await recentRows()
    expect(
      menu.filter((r) => r.startsWith('recent:')).join() === 'recent:Line B',
      `Line A's menu lists Line B and not itself (${menu.filter((r) => r.startsWith('recent:'))})`,
    )
    const at = menu.indexOf('recent:Line B')
    expect(
      menu.slice(at - 2, at + 2).join() === '|,Recent projects,recent:Line B,|',
      `as a block of its own under a heading (${menu.slice(at - 2, at + 2)})`,
    )
    await clickAndReload(page, page.locator('[data-recent-project]'))
    expect((await page.title()) === `Line B - ${APP_TITLE}`, `the row opened Line B (${await page.title()})`)
    expect((await tabs(page)) === '', 'with its own (empty) scene')
    menu = await recentRows()
    expect(menu.filter((r) => r.startsWith('recent:')).join() === 'recent:Line A', 'from there the menu lists Line A')
    await clickAndReload(page, page.locator('[data-recent-project]'))
    expect((await page.title()) === `Line A - ${APP_TITLE}`, `and its row leads back (${await page.title()})`)
    expect((await tabs(page)) === 'Sorter', `to Line A with its part (${await tabs(page)})`)

    console.log('--- delete, and survive a reload ---')
    await openShelf(page)
    await page.locator('.projects-action[aria-label="Delete Line B"]').click({ force: true })
    await waitFor(page, () => document.querySelectorAll('.projects-row').length === 1)
    list = await rows(page)
    expect(list.length === 1 && list[0]?.name === 'Line A', `Line B is gone, Line A is not (${JSON.stringify(list)})`)
    await closeShelf(page)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    expect((await page.title()) === `Line A - ${APP_TITLE}`, 'a reload comes back to the same document')
    expect((await tabs(page)) === 'Sorter', 'with its part')
    await openShelf(page)
    list = await rows(page)
    expect(list.length === 1 && list[0]?.current === true, `the library survived the reload (${JSON.stringify(list)})`)

    console.log('--- the demo preview mints nothing, and switching out of it lands in the document ---')
    await page.goto(`http://localhost:${PORT}/app/?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitFor(page, () => !!(window.__oip && window.__oip.store), null, 30000)
    await waitFor(page, () => window.__oip.store.getState().demoSession === true, null, 30000)
    await openShelf(page)
    list = await rows(page)
    expect(list.length === 1 && list[0]?.name === 'Line A', `a demo PREVIEW files nothing in the library (${JSON.stringify(list)})`)
    // The entry param is what puts the app into the preview at boot, so a switch that left
    // it in the URL would write the document into the working copy and then reload back into the demo.
    await clickAndReload(page, page.locator('.projects-name', { hasText: 'Line A' }))
    expect(!page.url().includes('scene=demo'), `the demo entry param was retired on the way out (${page.url()})`)
    expect((await page.title()) === `Line A - ${APP_TITLE}`, `it landed in the document, not back in the demo (${await page.title()})`)
    expect((await tabs(page)) === 'Sorter', 'with its part')

    console.log('--- an imported .oip lands BESIDE the open project, not on top of it ---')
    // The regression this section guards: adoption overwrites the working copy and reloads. If the
    // document pointer survives that, the library's first sync afterwards writes the imported project
    // into the outgoing document's row, so importing a file destroys a project the user was not looking
    // at. Built from the live document so the file is valid by construction, then emptied of parts so
    // the two can be told apart by what they hold.
    const oip = await page.evaluate(() => {
      const doc = JSON.parse(JSON.stringify(window.__oip.store.snapshotProject()))
      doc.name = 'Imported Line'
      doc.scene.parts = []
      return JSON.stringify(doc)
    })
    await awaitReload(page, () =>
      // by test id: an `accept*=".oip"` match also takes the parts catalog's input (it accepts `.oippart`), which sits
      // earlier in the page and reads the project as a part file
      page.setInputFiles('[data-testid="project-import"]', {
        name: 'imported.oip',
        mimeType: 'application/json',
        buffer: Buffer.from(oip, 'utf8'),
      }),
    )
    expect((await page.title()) === `Imported Line - ${APP_TITLE}`, `it opened into the import (${await page.title()})`)
    expect((await tabs(page)) === '', `carrying its own (empty) scene (${await tabs(page)})`)

    await openShelf(page)
    list = await rows(page)
    expect(list.length === 2, `the import was ADDED, not swapped in (${list.map((r) => r.name).join(', ')})`)
    expect(list.find((r) => r.name === 'Imported Line')?.current === true, 'and it is the one now open')
    expect(list.some((r) => r.name === 'Line A'), `the project it was imported next to still exists (${JSON.stringify(list)})`)
    await clickAndReload(page, page.locator('.projects-name', { hasText: 'Line A' }))
    expect((await tabs(page)) === 'Sorter', `and still holds its own part, untouched (${await tabs(page)})`)

    console.log('--- linking a folder opens it BESIDE the open project, not on top of it ---')
    // The same regression as the import, through the one adoption that cannot reload: if the link loads
    // the folder's project in place while the pointer still names Line A, it saves over the working copy
    // and the library's next sync files the folder into Line A's row.
    const lineAId = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
    await page.evaluate(installFakeFolder, folderFiles('Folder Line'))
    const linkError = await page.evaluate(() => window.__oip.linkFolder(window.__fakeFolder.dir))
    expect(linkError === null, `linking succeeds (${linkError})`)
    expect((await page.title()) === `Folder Line - ${APP_TITLE}`, `the folder's project is open (${await page.title()})`)
    const folderId = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
    expect(folderId !== null && folderId !== lineAId, `and it has a document id of its own (${lineAId} -> ${folderId})`)
    let docs = await waitForLibrary(page, (d) => d.some((r) => r.id === folderId && r.name === 'Folder Line'))
    const lineARow = docs.find((r) => r.id === lineAId)
    expect(lineARow?.name === 'Line A', `Line A's record still says Line A (${JSON.stringify(lineARow)})`)
    expect(lineARow?.parts.join() === 'Sorter', `and still holds Line A's part (${lineARow?.parts})`)
    await openShelf(page)
    await clickAndReload(page, page.locator('.projects-name', { hasText: 'Line A' }))
    expect((await tabs(page)) === 'Sorter', `switching back finds Line A whole (${await tabs(page)})`)

    console.log('--- a saved project this build cannot open is set aside, not replaced ---')
    // validateProject refuses a whole document for one bad piece. This one is a project test with no time to
    // run in (a bad hand edit). Boot must not fall back to the legacy scene key, save that at once, and let the
    // library file it over the same record.
    const refused = await page.evaluate(async () => {
      const doc = JSON.parse((await window.__oip.savedProject()))
      doc.tests = [{ name: 'gone', duration: 0, checks: [{ tag: 'Run', at: 0.5, equals: true }] }]
      const raw = JSON.stringify(doc)
      localStorage.setItem('oip-web/project', raw)
      return raw
    })
    await awaitReload(page, () => page.reload({ waitUntil: 'domcontentloaded' }))
    const banner = () => page.evaluate(() => document.querySelector('[data-testid="unopened-project-banner"]')?.textContent ?? null)
    await waitFor(page, () => !!document.querySelector('[data-testid="unopened-project-banner"]'))
    const text = (await banner()) ?? ''
    expect(/Line A/.test(text) && /duration must be a positive/.test(text), `the banner names the project and why (${text.slice(0, 90)}...)`)
    const stored = () => page.evaluate(async () => (await window.__oip.savedProject()))
    expect((await stored()) === refused, 'booting did not save over it')
    await addPart(page, 'shelf_edited', 'Edited')
    expect((await stored()) === refused, 'nor did an edit')
    await page.waitForTimeout(2600) // past the library's trailing sync
    docs = await libraryDocs(page)
    expect(
      docs.find((r) => r.id === lineAId)?.parts.join() === 'Sorter',
      `the library did not file the fallback over Line A's record (${JSON.stringify(docs.find((r) => r.id === lineAId))})`,
    )

    // leaving for another project is a write of the working copy too, so it is refused and says why
    await openShelf(page)
    await page.locator('.projects-name', { hasText: 'Imported Line' }).click({ force: true })
    await waitFor(page, () => /could not be opened/.test(document.querySelector('.projects-error')?.textContent ?? ''))
    expect(true, 'opening another project is refused until this one is dealt with')
    expect((await stored()) === refused, 'and the refused switch replaced nothing')
    await closeShelf(page)

    const download = page.waitForEvent('download')
    await page.locator('[data-testid="unopened-project-banner"] button', { hasText: 'Download it' }).click({ force: true })
    const file = await download
    const downloaded = await readFile(await file.path(), 'utf8')
    expect(file.suggestedFilename() === 'Line-A-unopened.json', `Download hands it over by name (${file.suggestedFilename()})`)
    expect(JSON.stringify(JSON.parse(downloaded)) === refused, 'as exactly the stored document')

    await page.locator('[data-testid="unopened-project-banner"] button', { hasText: 'Discard' }).click({ force: true })
    await waitFor(page, () => !document.querySelector('[data-testid="unopened-project-banner"]'))
    expect((await stored()) !== refused, 'Discard removes it and saves what is on screen')
    docs = await waitForLibrary(page, (d) => d.length === 4)
    expect(docs.length === 4, `what was on screen is filed as a NEW project (${docs.map((r) => r.name).join(', ')})`)
    expect(docs.find((r) => r.id === lineAId)?.parts.join() === 'Sorter', "and Line A's record is still whole")
    await openShelf(page)
    await clickAndReload(page, page.locator('.projects-name', { hasText: 'Line A' }))
    expect((await page.title()) === `Line A - ${APP_TITLE}`, `Line A opens again from its record (${await page.title()})`)
    expect((await tabs(page)) === 'Sorter', `with its part (${await tabs(page)})`)

    await page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall project-shelf checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
