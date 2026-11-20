// Two tabs, end to end in a real browser.
//
// Two tabs can have the same project open, and each save writes the whole project. Without the guard, the second tab to save erases the first one's work with no message: tab A adds
// a part, tab B makes an edit of its own, and A's part is gone. Unit tests cannot catch it (the storage event
// only fires between real browsing contexts), so this drives two pages in one browser context, which share
// storage exactly as two tabs do.
//
// What it checks:
//   - the tab that did not write gives way as soon as the other one does: view-only, not saving, with a banner
//   - its edits and its saves can no longer reach the working copy, so the other tab's work survives
//   - Reload recovers: the reloaded tab opens the latest copy and edits again, and the other tab gives way
//     in turn once it does
//   - a shelf switch in one tab cannot be undone by the other tab's library sync, and does not move that tab
//   - two tabs on two projects both save, and neither yields
//   - the projects list marks the other tab's project, and will not rename or delete it
//
// Waits poll on a timer: a settled viewport stops painting, and rAF-scheduled polling then never fires
// (verify-project-shelf.mjs explains).
// Run: node e2e/verify-project-cross-tab.mjs
/* global process, console, window, document, localStorage, sessionStorage, indexedDB */
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

const waitFor = (page, fn, arg = null, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 })

async function openTab(ctx) {
  const page = await ctx.newPage()
  page.on('dialog', (d) => void d.accept())
  await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitFor(page, () => !!(window.__oip && window.__oip.store), null, 60000)
  return page
}

/** The shelf, through the command palette (clicking the row: see verify-project-shelf.mjs). */
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

// Each check reads the project's parts, by name: an edit here is a part added or renamed (a project holds one
// scene, so there are no scene tabs to add or rename). Only this gate's own parts
// (ids `xtab_*`) are read, so whatever a new project starts with (the building) is not part of any claim.
const storedParts = async (page) => {
  // the test hook is installed when the app mounts, which a just-reloaded tab may not have done yet
  await waitFor(page, () => typeof window.__oip?.savedProject === 'function', null, 60000)
  return page.evaluate(async () =>
    (JSON.parse((await window.__oip.savedProject()) ?? 'null')?.scene?.parts ?? [])
      .filter((p) => p.id.startsWith('xtab_'))
      .map((p) => p.name)
      .join(),
  )
}
const liveParts = (page) =>
  page.evaluate(() =>
    window.__oip.store
      .getState()
      .scene.parts.filter((p) => p.id.startsWith('xtab_'))
      .map((p) => p.name)
      .join(),
  )
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
const yielded = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return s.supersededByOtherTab && s.readOnly && !!document.querySelector('[data-testid="other-tab-banner"]')
  })
const waitYielded = (page) =>
  waitFor(page, () => {
    const s = window.__oip.store.getState()
    return s.supersededByOtherTab && !!document.querySelector('[data-testid="other-tab-banner"]')
  })

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage - the tour just shows up, harmless here */
      }
    })
    const a = await openTab(ctx)
    const b = await openTab(ctx)
    // both booted on the same working copy; the second boot's save wrote what the first already had
    expect(!(await yielded(a)) && !(await yielded(b)), 'opening a second tab on the same project yields neither')

    console.log('--- tab A saves; tab B yields ---')
    const oldBuildStamp = () => a.evaluate(() => localStorage.getItem('oip-web/project-stamp'))
    const oldBefore = await oldBuildStamp()
    await addPart(a, 'xtab_a', 'From tab A')
    // a tab still on a build from before per-document stamps watches only this key
    expect((await oldBuildStamp()) !== oldBefore, 'the save also changes the stamp older builds watch')
    await waitYielded(b)
    expect(await yielded(b), 'B is view-only, not saving, and says so')
    expect(!(await yielded(a)), 'A, the tab that saved, carries on')
    const bannerText = await b.evaluate(() => document.querySelector('[data-testid="other-tab-banner"]')?.textContent ?? '')
    expect(/another tab/.test(bannerText) && /Reload/.test(bannerText), `the banner says why and what to do (${bannerText.slice(0, 60)}...)`)

    console.log('--- B cannot write over it ---')
    // the regression: B's edit must not save B's project (without A's part) over A's
    await addPart(b, 'xtab_b', 'Only in stale B')
    const saved = await b.evaluate(() => window.__oip.store.persistProject())
    expect(saved.ok === false, `a save forced from B is refused (${saved.message ?? ''})`)
    expect((await storedParts(a)) === 'From tab A', `A's part is still in the working copy (${await storedParts(a)})`)
    await a.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(a, () => !!(window.__oip && window.__oip.store), null, 60000)
    expect((await liveParts(a)) === 'From tab A', `and A comes back with it (${await liveParts(a)})`)

    console.log('--- Reload is the way back, and the other tab then yields in turn ---')
    await b.evaluate(() => ((window.__crossTabMark = true), undefined))
    await b.locator('[data-testid="other-tab-banner"] button', { hasText: 'Reload' }).click({ force: true })
    await waitFor(b, () => window.__crossTabMark === undefined && !!(window.__oip && window.__oip.store), null, 60000)
    expect(!(await yielded(b)), 'the reloaded tab is editable again')
    expect((await liveParts(b)) === 'From tab A', `and holds the latest copy (${await liveParts(b)})`)
    await b.evaluate(() => window.__oip.store.rename('xtab_a', 'Renamed in B'))
    await waitYielded(a)
    expect(await yielded(a), 'A yields once B saves')
    expect((await storedParts(b)) === 'Renamed in B', `B's rename is what was kept (${await storedParts(b)})`)

    console.log('--- a shelf switch in one tab is not undone by the other ---')
    // A reloads to take the document back, then B (now the stale one) must not write its project over
    // the record A leaves behind when it switches to a new project.
    await a.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(a, () => !!(window.__oip && window.__oip.store), null, 60000)
    await addPart(a, 'xtab_a2', 'Only in A')
    await waitYielded(b)
    const docId = await a.evaluate(() => localStorage.getItem('oip-web/document-id'))
    await openShelf(a)
    await a.locator('.projects-new').click({ force: true })
    await a.fill('.projects-input', 'Second Project')
    await a.evaluate(() => ((window.__crossTabMark = true), undefined))
    await a.locator('.projects-confirm').click({ force: true })
    await waitFor(a, () => window.__crossTabMark === undefined && !!(window.__oip && window.__oip.store), null, 60000)
    expect((await a.title()).startsWith('Second Project'), `A switched to the new project (${await a.title()})`)
    await b.waitForTimeout(2600) // past the library's trailing sync in B, had it still been running
    const record = await a.evaluate(
      (id) =>
        new Promise((resolve) => {
          const req = indexedDB.open('oip-web')
          req.onsuccess = () => {
            const get = req.result.transaction('docPayload', 'readonly').objectStore('docPayload').get(id)
            get.onsuccess = () =>
              resolve(
                (((r) => r && (r.project ?? JSON.parse(r.text)))(get.result)?.scene?.parts ?? [])
                  .filter((p) => p.id.startsWith('xtab_'))
                  .map((p) => p.name)
                  .join(),
              )
          }
          req.onerror = () => resolve(null)
        }),
      docId,
    )
    expect(record === 'Renamed in B,Only in A', `the record A left still holds A's last save (${record})`)
    const bDoc = await b.evaluate(() => sessionStorage.getItem('oip-web/document-id'))
    expect(bDoc === docId, `B stays on its own project rather than following A's switch (${bDoc})`)

    console.log('--- two tabs on two projects both save ---')
    await b.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(b, () => !!(window.__oip && window.__oip.store), null, 60000)
    expect((await liveParts(b)) === 'Renamed in B,Only in A', `B reopens its own project (${await liveParts(b)})`)
    await addPart(a, 'xtab_second', 'In Second')
    await addPart(b, 'xtab_first', 'In First')
    await addPart(a, 'xtab_second2', 'In Second again')
    await b.waitForTimeout(1500) // a storage event from the other tab arrives well inside this
    expect(!(await yielded(a)) && !(await yielded(b)), 'neither tab yields to the other')
    expect((await storedParts(a)) === 'In Second,In Second again', `A's project holds A's edits (${await storedParts(a)})`)
    expect((await storedParts(b)) === 'Renamed in B,Only in A,In First', `B's project holds B's edits (${await storedParts(b)})`)

    console.log("--- the projects list knows the other tab's project ---")
    await openShelf(a)
    const row = await a.evaluate((id) => {
      const r = document.querySelector(`.projects-row[data-doc-id="${id}"]`)
      return r && { when: r.querySelector('.projects-when')?.textContent ?? '', disabled: [...r.querySelectorAll('.projects-action')].filter((x) => x.disabled).length }
    }, docId)
    expect(row?.when === 'open in another tab', `its row says it is open in another tab (${row?.when})`)
    expect(row?.disabled === 2, `and cannot be renamed or deleted from here (${row?.disabled} disabled)`)
    await a.keyboard.press('Escape')

    console.log("--- a tab whose record is gone does not open the other tab's backup ---")
    // A's project is the last one in the legacy scene key (the fallback a boot reads when the record is missing).
    // Planted as B's next page starts, after B's own unload has written its backup and before B's boot reads it.
    const planted = await a.evaluate(() => {
      return { text: window.__oip.sceneFileText(), owner: sessionStorage.getItem('oip-web/document-id') }
    })
    await b.addInitScript((p) => {
      if (sessionStorage.getItem('xtab-planted')) return
      sessionStorage.setItem('xtab-planted', '1')
      localStorage.setItem('oip-web/autosave', p.text)
      localStorage.setItem('oip-web/autosave-doc', p.owner)
    }, planted)
    await b.evaluate(
      (id) =>
        new Promise((resolve) => {
          const req = indexedDB.open('oip-web')
          req.onsuccess = () => {
            const tx = req.result.transaction(['docIndex', 'docPayload'], 'readwrite')
            tx.objectStore('docIndex').delete(id)
            tx.objectStore('docPayload').delete(id)
            tx.oncomplete = () => resolve(true)
          }
        }),
      docId,
    )
    await b.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(b, () => !!(window.__oip && window.__oip.store), null, 60000)
    const fallback = await liveParts(b)
    expect(!fallback.includes('In Second'), `B did not open A's project under its own id (${fallback || 'empty'})`)
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall project-cross-tab checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
