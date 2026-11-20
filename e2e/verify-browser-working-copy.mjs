// The browser working copy is the open document's row in IndexedDB, with models stored by hash, and nothing else
// holds a second copy of it (docs/projects.md "The browser working copy").
//
// What it checks:
//   - a part with a 6 MB model is saved: the row names the model by hash, the banner is clear, and localStorage holds
//     no copy of the project
//   - a reload gives the part back with the model's exact bytes
//   - with the stored bytes deleted, a reload refuses the project rather than open a part without its model
//   - a .oip carrying the model imports into a browser that has never stored it
//   - a project past the old 5 MB localStorage limit, with no model, saves and reloads
//   - a page hidden with a row write in flight also leaves the text in localStorage under its document, and removes
//     it once the row lands
//   - the first boot moves a localStorage working copy from an earlier build into the row and removes the key: the key
//     when it is the latest, the row when a refused save left the row newer, and a row in the earlier object form
// Run: node e2e/verify-browser-working-copy.mjs
/* global process, console, window, localStorage, sessionStorage, indexedDB */
import { createHash } from 'node:crypto'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const APP = `http://localhost:${PORT}/app/`

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

/** timer-polled wait: a settled viewport stops painting, so the default rAF poller would never run again */
const waitFor = (page, fn, arg = null, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 })

async function waitForApp(page) {
  await waitFor(page, () => !!(window.__oip && window.__oip.store && window.__oip.savedProject), null, 60000)
  await waitFor(page, () => localStorage.getItem('oip-web/document-id') !== null)
}

const saved = (page) => page.evaluate(async () => (await window.__oip.savedProject()) ?? '')
const program = (page) => page.evaluate(() => window.__oip.store.getState().stProgram)
/** a copy of the project in localStorage: where earlier builds kept it, or a closing page's copy of the tab's document */
const localCopy = (page) =>
  page.evaluate(
    () => localStorage.getItem('oip-web/project') ?? localStorage.getItem(`oip-web/project-journal/${sessionStorage.getItem('oip-web/document-id')}`),
  )

// pseudo-random, so it does not compress: 6 MB of bytes is 8 MB of base64
const model = Buffer.alloc(6 * 1024 * 1024)
for (let i = 0; i < model.length; i++) model[i] = (i * 2654435761) >>> 24
const SHA = createHash('sha256').update(model).digest('hex')
const PKG = {
  format: 6,
  id: 'gate.heavy',
  name: 'Heavy',
  params: {},
  behavior: 'definePart({ step() {} })\n',
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.5, 0.5, 0.5] }, offset: [0, 0.25, 0] }], joints: [] },
  assets: [{ id: 'body', mime: 'model/gltf-binary', data: model.toString('base64') }],
}

/** the SHA-256 of the model's bytes as the page holds them, or null when the part has no model */
const modelHash = (page) =>
  page.evaluate(async (id) => {
    const data = window.__oip.store.getState().userPackages.find((p) => p.id === id)?.assets?.find((a) => a.id === 'body')?.data
    if (typeof data !== 'string') return null
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  }, PKG.id)

/** the hashes in the browser's asset store */
const storedAssets = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web-assets')
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('bytes')) return resolve([])
          const keys = db.transaction('bytes', 'readonly').objectStore('bytes').getAllKeys()
          keys.onsuccess = () => {
            db.close()
            resolve(keys.result)
          }
          keys.onerror = () => resolve([])
        }
      }),
  )

async function openApp(context) {
  const page = await context.newPage()
  page.on('dialog', (d) => void d.accept())
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  return page
}

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
}

async function modelLeg(browser) {
  console.log('--- a 6 MB model ---')
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await openApp(context)
  await page.evaluate((pkg) => {
    const store = window.__oip.store
    store.addUserPackage(pkg)
    const part = { id: 'heavy_1', type: 'part', packageId: pkg.id, position: [2, 0, 2], rotationY: 0, params: {} }
    const scene = store.getState().scene
    store.commit('Add part', { ...scene, parts: [...scene.parts, part], packages: [...(scene.packages ?? []), pkg] })
  }, PKG)
  // the first save embeds the model, since its bytes are not stored yet; the save after they land names the hash
  let text = ''
  for (const end = Date.now() + 20000; Date.now() < end && !text.includes(SHA); await page.waitForTimeout(250)) text = await saved(page)
  expect(text.includes(SHA) && text.length < 1024 * 1024, `the row names the model by hash (${(text.length / 1024).toFixed(0)} KB)`)
  expect((await page.evaluate(() => window.__oip.store.getState().autosaveError)) === null, 'and the autosave banner is clear')
  expect((await storedAssets(page)).includes(SHA), 'the bytes are in the asset store')
  expect((await localCopy(page)) === null, 'localStorage holds no copy of the project')

  await reload(page)
  expect((await modelHash(page)) === SHA, "a reload gives the part back with the model's exact bytes")
  expect((await page.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'heavy_1'))) === true, 'and the part placed')
  expect((await page.evaluate(() => window.__oip.store.getState().unopenedProject)) === null, 'nothing is refused')

  const oip = await page.evaluate(() => {
    const doc = JSON.parse(JSON.stringify(window.__oip.store.snapshotProject()))
    doc.name = 'Imported Heavy'
    return JSON.stringify(doc)
  })
  await page.evaluate(
    (sha) =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web-assets')
        req.onsuccess = () => {
          const tx = req.result.transaction(['bytes', 'meta'], 'readwrite')
          tx.objectStore('bytes').delete(sha)
          tx.objectStore('meta').delete(sha)
          tx.oncomplete = () => {
            req.result.close()
            resolve(true)
          }
        }
      }),
    SHA,
  )
  await reload(page)
  const unopened = await page.evaluate(() => window.__oip.store.getState().unopenedProject)
  expect(/missing from this browser's storage/.test(unopened?.errors?.join(' ') ?? ''), `with the stored bytes gone, the project is refused (${unopened?.errors?.join(' ')})`)
  expect((await modelHash(page)) === null, 'and no part opens without its model')
  await context.close()

  // a browser that has never stored this model: the import stores it first (localAssets.storeLocalAssets)
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const other = await openApp(fresh)
  await other.evaluate(() => ((window.__reloadMark = true), undefined))
  await other.setInputFiles('[data-testid="project-import"]', { name: 'heavy.oip', mimeType: 'application/json', buffer: Buffer.from(oip, 'utf8') })
  await waitFor(other, () => window.__reloadMark === undefined, null, 60000)
  await waitForApp(other)
  expect((await other.evaluate(() => window.__oip.store.getState().projectName)) === 'Imported Heavy', 'a .oip with the model imports in a browser that never stored it')
  expect((await modelHash(other)) === SHA, 'with the exact bytes')
  const imported = (await saved(other)).length
  expect(imported > 0 && imported < 1024 * 1024, `and its row is small (${(imported / 1024).toFixed(0)} KB)`)
  await fresh.close()
}

async function largeLeg(browser) {
  console.log('--- a project past the old localStorage limit ---')
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await openApp(context)
  // 6 M characters, more than localStorage takes for a whole origin
  const big = `PROGRAM Big\nVAR\n  b : BOOL;\nEND_VAR\n(* ${'y'.repeat(6_000_000)} *)\nEND_PROGRAM\n`
  await page.evaluate((src) => window.__oip.store.loadStProgram(src), big)
  expect((await page.evaluate(() => window.__oip.store.getState().autosaveError)) === null, 'it saves with no banner')
  expect((await saved(page)).includes('PROGRAM Big'), 'the row holds it')
  await reload(page)
  expect((await program(page)).length === big.length, 'a reload opens it whole')

  console.log('--- a page hidden with a write in flight ---')
  const kept = await page.evaluate(() => {
    window.__oip.store.loadStProgram('PROGRAM Hidden\nVAR\n  h : BOOL;\nEND_VAR\nEND_PROGRAM\n')
    dispatchEvent(new Event('pagehide'))
    return localStorage.getItem(`oip-web/project-journal/${sessionStorage.getItem('oip-web/document-id')}`) ?? ''
  })
  expect(kept.includes('PROGRAM Hidden'), 'the latest text is also in localStorage while its row write is in flight')
  for (const end = Date.now() + 10000; Date.now() < end && (await localCopy(page)) !== null; ) await page.waitForTimeout(100)
  expect((await localCopy(page)) === null, 'and is removed once the row lands')
  expect((await saved(page)).includes('PROGRAM Hidden'), 'which holds the edit')
  await context.close()
}

/** an earlier build's browser, seeded from the landing page (same origin, no app boot) */
async function seedEarlierBuild(context, { local, row, rowForm, behindSince }) {
  const page = await context.newPage()
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.evaluate(
    ({ local, row, rowForm, behindSince }) =>
      new Promise((resolve) => {
        localStorage.setItem('oip-web/tutorial-done', '1')
        localStorage.setItem('oip-web/document-id', 'doc-earlier')
        if (local) localStorage.setItem('oip-web/project', JSON.stringify(local))
        if (behindSince !== undefined) localStorage.setItem('oip-web/project-behind', JSON.stringify({ doc: 'doc-earlier', since: behindSince }))
        if (!row) return resolve(true)
        const req = indexedDB.open('oip-web', 1)
        req.onupgradeneeded = () => {
          req.result.createObjectStore('docIndex', { keyPath: 'id' })
          req.result.createObjectStore('docPayload', { keyPath: 'id' })
        }
        req.onsuccess = () => {
          const tx = req.result.transaction(['docIndex', 'docPayload'], 'readwrite')
          tx.objectStore('docIndex').put({ id: 'doc-earlier', name: row.name, updatedAt: Date.now() })
          tx.objectStore('docPayload').put(rowForm === 'object' ? { id: 'doc-earlier', project: row } : { id: 'doc-earlier', text: JSON.stringify(row) })
          tx.oncomplete = () => {
            req.result.close()
            resolve(true)
          }
        }
      }),
    { local, row, rowForm, behindSince },
  )
  await page.close()
}

const projectOf = (name, program) => ({ version: 7, name, scene: { version: 4, parts: [] }, stProgram: program })

async function migrationLeg(browser) {
  console.log('--- moving in from an earlier build ---')
  {
    const context = await browser.newContext()
    await seedEarlierBuild(context, { local: projectOf('Kept', 'PROGRAM Local\nEND_PROGRAM\n'), row: projectOf('Kept', 'PROGRAM Older\nEND_PROGRAM\n'), rowForm: 'object' })
    const page = await openApp(context)
    expect((await program(page)).includes('PROGRAM Local'), 'the localStorage working copy opens')
    expect((await localCopy(page)) === null, 'and the key is removed')
    expect((await saved(page)).includes('PROGRAM Local'), 'its row holds it now')
    await reload(page)
    expect((await program(page)).includes('PROGRAM Local'), 'and a reload opens the row')
    await context.close()
  }
  {
    const context = await browser.newContext()
    await seedEarlierBuild(context, {
      local: projectOf('Kept', 'PROGRAM Stale\nEND_PROGRAM\n'),
      row: projectOf('Kept', 'PROGRAM Newer\nEND_PROGRAM\n'),
      rowForm: 'object',
      behindSince: Date.now() - 60_000,
    })
    const page = await openApp(context)
    expect((await program(page)).includes('PROGRAM Newer'), 'a refused save left the row newer: the row opens, in its earlier object form')
    expect((await localCopy(page)) === null && (await page.evaluate(() => localStorage.getItem('oip-web/project-behind'))) === null, 'and the key and the mark are removed')
    await context.close()
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    await modelLeg(browser)
    await largeLeg(browser)
    await migrationLeg(browser)
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall browser working copy checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
