// Part libraries in the app (docs/part-libraries.md): Get parts (components/GetPartsWindow.tsx) reads libraries on
// another origin, adds their parts to the project, and takes a newer version only when asked.
//
//   1. two libraries are packed (scripts/build-library.mjs): Containers from its sources (libraries/containers, --from)
//      and the Structure built-ins (--category). A second local server serves them with the R2 bucket's headers (CORS
//      only, no Cross-Origin-Resource-Policy), since /app/ is cross-origin isolated
//   2. Get parts, opened from the Parts dock, lists a library's parts with their pictures; a part shows its description
//      and what it is to the machines around it; Add to project copies it in (origin.library) and it then shows in its
//      category tab in the dock
//   3. a newer version is offered and taken only when asked: Update asks first in the change dialog, Update all takes
//      every part with one. The part's card in the Parts dock offers it too, and the updates notice counts it
//   4. the demo's copies of the Structure built-ins read as the first-party library's own, and a newer one as their
//      update; the same index from another host claims none of them (core/parts/partLibrary.ts isFirstPartyLibrary)
//   4b. signed with the project's key (core/librarySignature.ts; a dev build trusts the gates' key), the same index
//      is the project's from any host: the demo's built-ins read its newer stairs as their update. Changed after it
//      was signed, it is refused, not read as unsigned. A listed part names its publisher.
//   5. a library served without CORS cannot be read, and Get parts says so
//   6. with the official libraries switched off in Settings and no other, Get parts says how to add one and adds one itself, refusing one it cannot read; Settings
//      lists it, and it is kept
//
//   node e2e/verify-part-library.mjs [--headed]
/* global window, document, localStorage, console, process */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPrivateKey, sign } from 'node:crypto'
import { chromium } from 'playwright'
import { createServer as createVite } from 'vite'
import { TEST_LIBRARY_KEY } from './_library-test-key.mjs'
import { startServer } from './_server.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}
const waitFor = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ── 1. the libraries, built and served ───────────────────────────────────────────────────────────
const pack = (id, name, args) => {
  const dir = mkdtempSync(join(tmpdir(), `oip-${id}-`))
  const r = spawnSync(process.execPath, ['scripts/build-library.mjs', dir, '--id', id, '--name', name, ...args], { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr)
    process.exit(1)
  }
  return { dir, index: JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')), published: new Map() }
}
const libs = {
  containers: pack('oip.containers', 'Containers', ['--from', 'libraries/containers']),
  structure: pack('oip.structure', 'Structure', ['--category', 'Structure']),
}

// one host: /<ok|nocors|signed|tampered>/<library>/<path>. /ok/ answers as the R2 bucket does, /nocors/ without CORS,
// /signed/ with the index signed by the gates' key, /tampered/ with that signed index changed afterwards
const host = http.createServer((req, res) => {
  const [, mode, name, ...rest] = new URL(req.url, 'http://x').pathname.split('/')
  const lib = libs[name]
  const path = rest.join('/')
  const headers = mode === 'nocors' ? {} : { 'Access-Control-Allow-Origin': '*' }
  let body = null
  if (lib && path === 'index.json') {
    const index = mode === 'signed' || mode === 'tampered' ? signed(lib.index) : lib.index
    body = Buffer.from(JSON.stringify(mode === 'tampered' ? { ...index, name: `${index.name} (changed)` } : index))
  }
  else if (lib && lib.published.has(path)) body = lib.published.get(path)
  else if (lib) {
    const file = normalize(join(lib.dir, path))
    if (file.startsWith(lib.dir + sep) && existsSync(file)) body = readFileSync(file)
  }
  if (body === null) {
    res.writeHead(404, headers)
    res.end()
    return
  }
  const type = path.endsWith('.json') ? 'application/json' : path.endsWith('.webp') ? 'image/webp' : 'application/octet-stream'
  res.writeHead(200, { ...headers, 'Content-Type': type })
  res.end(body)
})
await new Promise((r) => host.listen(0, '127.0.0.1', r))
const libraryAt = (mode, name, hostName = '127.0.0.1') => `http://${hostName}:${host.address().port}/${mode}/${name}/index.json`

// the app's own code, to make a v2 of a part the way a release would
const vite = await createVite({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
const { oippartBytesToFolder, partToOippartBytes } = await vite.ssrLoadModule('/src/core/parts/partArchive.ts')
const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
const { partFingerprint } = await vite.ssrLoadModule('/src/core/parts/partOrigin.ts')
const { sha256HexOfBytes } = await vite.ssrLoadModule('/src/core/sha256.ts')
const { signedBytes } = await vite.ssrLoadModule('/src/core/librarySignature.ts')
/** The index as the project's release signs it (scripts/sign-library.mjs), with the gates' key. */
function signed(index) {
  const { signature: _drop, ...rest } = index
  const sig = sign(null, Buffer.from(signedBytes(rest)), createPrivateKey(TEST_LIBRARY_KEY.privateKeyPem)).toString('base64')
  return { ...rest, signature: { key: TEST_LIBRARY_KEY.id, sig } }
}

/** Publish a changed version of `id` in library `name`: its file served, listed after the current one. Its fingerprint. */
async function publishV2(name, id) {
  const lib = libs[name]
  const v1 = lib.index.parts.find((p) => p.id === id).versions.at(-1)
  const folder = await oippartBytesToFolder(new Uint8Array(lib.published.get(v1.file) ?? readFileSync(join(lib.dir, v1.file))))
  const pkg = buildPackage(JSON.parse(folder.manifestJson), `${folder.behaviorJs}\n// library v2\n`)
  const bytes = await partToOippartBytes(pkg)
  const sha256 = sha256HexOfBytes(bytes)
  const file = `${id}/${sha256}.oippart`
  lib.published.set(file, Buffer.from(bytes))
  const v2 = { ...v1, file, sha256, fingerprint: partFingerprint(pkg) }
  lib.index = { ...lib.index, parts: lib.index.parts.map((p) => (p.id === id ? { ...p, versions: [...p.versions, v2] } : p)) }
  return v2.fingerprint
}

const { port } = await startServer()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('dialog', (d) => void d.accept())

const open = async (query) => {
  await page.goto(`http://localhost:${port}/app/${query}`)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 120000 })
}
const win = page.locator('[data-testid="get-parts"]')
const openGetParts = async () => {
  if (await win.count()) return
  await page.locator('[data-testid="catalog-get-parts"]').click()
  await win.waitFor({ timeout: 15000 })
}
const closeGetParts = async () => {
  await page.keyboard.press('Escape')
  await win.waitFor({ state: 'detached', timeout: 10000 })
}
const chooseSource = async (libraryId) => {
  const src = win.locator(`[data-testid="get-parts-source"][data-library-id="${libraryId}"]`)
  await src.waitFor({ timeout: 15000 })
  await src.click()
}
const card = (id) => win.locator(`[data-testid="get-parts-card"][data-part-id="${id}"]`)
const statusOf = (id) => card(id).getAttribute('data-status', { timeout: 5000 }).catch(() => null)
const copyOf = (id) => page.evaluate((i) => window.__oip.store.getState().userPackages.find((p) => p.id === i) ?? null, id)
const select = async (id) => {
  await card(id).click()
  await win.locator(`[data-testid="get-parts-detail"][data-part-id="${id}"]`).waitFor({ timeout: 10000 })
}

try {
  // ── 2. Get parts lists a library, a part says what it is, Add to project copies it in ─────────────
  await open(`?library=${encodeURIComponent(libraryAt('ok', 'containers'))}`)
  await openGetParts()
  await chooseSource('oip.containers')
  await card('oip.drum').waitFor({ timeout: 15000 })
  check('Get parts lists the library', true)
  check('it lists every part in the index', (await win.locator('[data-testid="get-parts-card"]').count()) === libs.containers.index.parts.length)
  const cards = libs.containers.index.parts.length
  await waitFor(() => page.evaluate((n) => [...document.querySelectorAll('[data-testid="get-parts-card"] img')].filter((i) => i.complete && i.naturalWidth > 0).length === n, cards), 'the pictures to load', 15000).catch(() => {})
  const pictures = await page.evaluate(() => [...document.querySelectorAll('[data-testid="get-parts-card"] img')].filter((i) => i.complete && i.naturalWidth > 0).length)
  check("every card shows the library's picture, across origins", pictures === cards, `${pictures} of ${cards}`)

  await select('oip.ibc-tote')
  const detail = win.locator('[data-testid="get-parts-detail"]')
  const text = await detail.innerText()
  check('a part shows its description', text.includes('1000 litre'))
  check("a part of the project's own library is credited to the project", (await detail.locator('[data-testid="get-parts-publisher"]').innerText().catch(() => '')) === 'Open Industry Project')
  await waitFor(async () => (await detail.innerText()).includes('A forklift can pick it up'), 'the part to download', 15000).catch(() => {})
  check('...and what it is to the machines around it, read from the part', (await detail.innerText()).includes('A forklift can pick it up'))
  check('it is not in the project yet', (await statusOf('oip.ibc-tote')) === 'notInProject', await statusOf('oip.ibc-tote'))
  await win.locator('[data-testid="get-parts-add"]').click()
  await waitFor(async () => (await copyOf('oip.ibc-tote'))?.origin?.library !== undefined, 'the part to be added')
  const v1 = libs.containers.index.parts.find((p) => p.id === 'oip.ibc-tote').versions.at(-1)
  check("Add to project copies it in, recorded as the library's version, without placing it", (await copyOf('oip.ibc-tote')).origin.library === v1.fingerprint && !(await page.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.packageId === 'oip.ibc-tote'))))
  await waitFor(async () => (await statusOf('oip.ibc-tote')) === 'upToDate', 'the card to read In project', 10000).catch(() => {})
  check('its card then reads In project', (await statusOf('oip.ibc-tote')) === 'upToDate', await statusOf('oip.ibc-tote'))
  await closeGetParts()
  await page.locator('.catalog-tab', { hasText: 'Products' }).click()
  await page.locator('[data-package-id="oip.ibc-tote"]').first().waitFor({ timeout: 10000 }).catch(() => {})
  check('the added part shows in its category tab in the Parts dock', (await page.locator('[data-package-id="oip.ibc-tote"]').count()) > 0)
  // who made it goes with the copy (core/parts/partPackage.ts PartCredit), and shows where the part is used
  const credit = (await copyOf('oip.ibc-tote')).credit
  check('the copy credits who made it', credit?.by === 'Open Industry Project' && credit?.library === 'Containers', JSON.stringify(credit))
  await page.evaluate(() => {
    const { store } = window.__oip
    const s = store.getState()
    const pkg = s.userPackages.find((p) => p.id === 'oip.ibc-tote')
    store.commit('Place the tote', { ...s.scene, packages: [...(s.scene.packages ?? []), pkg], parts: [...s.scene.parts, { id: 'ibc_1', type: 'part', packageId: pkg.id, name: 'IBC', position: [0, 0.5, 0], rotationY: 0, params: {} }] })
    store.select('ibc_1')
  })
  const creditLine = page.locator('[data-testid="inspector-credit"]')
  await creditLine.waitFor({ timeout: 10000 }).catch(() => {})
  check('the Inspector names who made it', (await creditLine.innerText().catch(() => '')).includes('by Open Industry Project, from Containers'), await creditLine.innerText().catch(() => ''))
  check("the part's card says it too", ((await page.locator('[data-package-id="oip.ibc-tote"]').first().getAttribute('title')) ?? '').includes('by Open Industry Project, from Containers'))

  // ── 3. a newer version: Update asks first; Update all takes every part with one ─────────────────
  await openGetParts()
  await chooseSource('oip.containers')
  await select('oip.drum')
  await waitFor(() => win.locator('[data-testid="get-parts-add"]').isEnabled(), 'the drum to download')
  await win.locator('[data-testid="get-parts-add"]').click()
  await waitFor(async () => !!(await copyOf('oip.drum')), 'the drum to be added')
  // the IBC tote, added in 2, is the second part with a newer version
  const drumV2 = await publishV2('containers', 'oip.drum')
  const ibcV2 = await publishV2('containers', 'oip.ibc-tote')
  await closeGetParts()
  await openGetParts()
  await chooseSource('oip.containers')
  await waitFor(async () => (await statusOf('oip.drum')) === 'updateAvailable', 'the drum to read Update', 15000).catch(() => {})
  check('a part with a newer version reads Update', (await statusOf('oip.drum')) === 'updateAvailable', await statusOf('oip.drum'))
  check('nothing changes in the project until asked', !(await copyOf('oip.drum')).behavior.includes('library v2'))
  // the Parts dock says so too, on the card and in the updates notice, like an update from the app or the shelf
  await closeGetParts()
  await page.locator('.catalog-search').fill('drum')
  const dockBadge = page.locator('.catalog-card:has(.catalog-card-main[data-package-id="oip.drum"]) [data-testid="part-update"][data-source="library"]')
  await dockBadge.waitFor({ timeout: 15000 }).catch(() => {})
  check("the drum's card in the Parts dock offers the library's update", (await dockBadge.count()) === 1)
  const noticeText = await page.locator('[data-testid="part-updates-notice"]').innerText().catch(() => '')
  check('...and the updates notice counts both library parts', noticeText.includes('2 parts'), noticeText.split('\n')[0])
  await page.locator('.catalog-search').fill('')
  await openGetParts()
  await chooseSource('oip.containers')
  await select('oip.drum')
  const updateBtn = win.locator('[data-testid="get-parts-update"]')
  await waitFor(() => updateBtn.isEnabled(), 'the update to download')
  await updateBtn.click()
  const dialog = page.locator('[data-testid="part-change-dialog"]')
  await dialog.waitFor({ timeout: 10000 })
  check('Update asks first, listing what changes', (await dialog.innerText()).length > 0)
  await dialog.locator('[data-testid="part-change-confirm"]').click()
  await waitFor(async () => (await copyOf('oip.drum'))?.origin?.library === drumV2, 'the drum to update')
  check("the project's copy is the new version", (await copyOf('oip.drum')).behavior.includes('library v2'))
  const updateAll = win.locator('[data-testid="get-parts-update-all"]')
  await waitFor(async () => (await updateAll.innerText()).includes('(1)'), 'Update all to count the IBC tote', 15000).catch(() => {})
  check('Update all counts the parts left with a newer version', (await updateAll.innerText()).includes('(1)'), await updateAll.innerText())
  await updateAll.click()
  await waitFor(async () => (await copyOf('oip.ibc-tote'))?.origin?.library === ibcV2, 'the IBC tote to update')
  check('Update all takes them', (await copyOf('oip.ibc-tote')).behavior.includes('library v2'))
  await closeGetParts()

  // ── 4. the demo's copies of the built-ins read as the first-party library's; another host claims none ──
  await open(`?scene=demo&library=${encodeURIComponent(libraryAt('ok', 'structure'))}`)
  await openGetParts()
  await chooseSource('oip.structure')
  await card('oip.stairs').waitFor({ timeout: 15000 })
  const placed = await page.evaluate(
    (ids) => [...new Set(window.__oip.store.getState().scene.parts.flatMap((p) => (p.type === 'part' && ids.includes(p.packageId) ? [p.packageId] : [])))],
    libs.structure.index.parts.map((p) => p.id),
  )
  const statuses = await Promise.all(placed.map(async (id) => `${id}=${await statusOf(id)}`))
  check("the demo's copies of the app's built-ins read as the library's own", placed.length > 0 && statuses.every((s) => s.endsWith('=upToDate')), statuses.join(' '))
  await publishV2('structure', 'oip.stairs')
  await closeGetParts()
  await openGetParts()
  await chooseSource('oip.structure')
  await waitFor(async () => (await statusOf('oip.stairs')) === 'updateAvailable', 'the stairs to read Update', 15000).catch(() => {})
  check("the first-party library's newer stairs is an update to the demo's built-in", (await statusOf('oip.stairs')) === 'updateAvailable', await statusOf('oip.stairs'))
  await closeGetParts()
  await open(`?scene=demo&library=${encodeURIComponent(libraryAt('ok', 'structure', 'localhost'))}`)
  await openGetParts()
  await chooseSource('oip.structure')
  await card('oip.stairs').waitFor({ timeout: 15000 })
  check('an oip.* library from another host never offers updates to the built-ins', (await statusOf('oip.stairs')) === 'sameIdDifferentPart', await statusOf('oip.stairs'))
  await closeGetParts()

  // ── 4b. the project's signature makes it the project's from any host; a changed index is refused ──
  await open(`?scene=demo&library=${encodeURIComponent(libraryAt('signed', 'structure', 'localhost'))}`)
  await openGetParts()
  await chooseSource('oip.structure')
  await card('oip.stairs').waitFor({ timeout: 15000 })
  await waitFor(async () => (await statusOf('oip.stairs')) === 'updateAvailable', 'the signed stairs to read Update', 15000).catch(() => {})
  check("signed with the project's key, the same index from another host is the project's", (await statusOf('oip.stairs')) === 'updateAvailable', await statusOf('oip.stairs'))
  await select('oip.stairs')
  check('Get parts says the library is signed', (await win.locator('[data-testid="get-parts-detail"]').innerText()).includes('signed by Open Industry Project'))
  await closeGetParts()
  await open(`?library=${encodeURIComponent(libraryAt('tampered', 'structure', 'localhost'))}`)
  await openGetParts()
  const refused = win.locator('[data-testid="get-parts-source"]', { hasText: 'could not be read' })
  await refused.waitFor({ timeout: 15000 }).catch(() => {})
  check('an index changed after it was signed is refused, not read as unsigned', (await refused.count()) === 1 && (await refused.getAttribute('title'))?.includes('signature does not verify'), await refused.getAttribute('title').catch(() => ''))
  await closeGetParts()
  // a listed part names who publishes it
  libs.containers.index = { ...libs.containers.index, parts: libs.containers.index.parts.map((p) => (p.id === 'oip.drum' || p.id === 'oip.ibc-tote' ? { ...p, publisher: 'tester' } : p)) }
  await open(`?library=${encodeURIComponent(libraryAt('ok', 'containers'))}`)
  await openGetParts()
  await chooseSource('oip.containers')
  await card('oip.drum').waitFor({ timeout: 15000 })
  await select('oip.drum')
  check('a listed part names its publisher, linked to their GitHub account', (await win.locator('[data-testid="get-parts-publisher"] a').getAttribute('href')) === 'https://github.com/tester')
  const allCards = await win.locator('[data-testid="get-parts-card"]').count()
  const moreFrom = win.locator('[data-testid="get-parts-more-from"]')
  check("it offers the rest of that publisher's parts",(await moreFrom.innerText().catch(() => '')).includes('More from tester (2)'))
  await moreFrom.click()
  await waitFor(async () => (await win.locator('[data-testid="get-parts-card"]').count()) === 2, 'the publisher filter', 10000).catch(() => {})
  const shown = await win.locator('[data-testid="get-parts-card"]').evaluateAll((els) => els.map((e) => e.dataset.partId).sort())
  check('...which shows only theirs, with the filter named by the search', JSON.stringify(shown) === JSON.stringify(['oip.drum', 'oip.ibc-tote']) && (await win.locator('[data-testid="get-parts-publisher-filter"]').isVisible()), shown.join(' '))
  await win.locator('[data-testid="get-parts-publisher-filter"]').click()
  await waitFor(async () => (await win.locator('[data-testid="get-parts-card"]').count()) === allCards, 'every part again', 10000).catch(() => {})
  check('removing the filter shows every part again', (await win.locator('[data-testid="get-parts-card"]').count()) === allCards)
  await closeGetParts()

  // ── 5. a library without CORS cannot be read under cross-origin isolation, and Get parts says so ──
  await open(`?library=${encodeURIComponent(libraryAt('nocors', 'containers'))}`)
  await openGetParts()
  const unread = win.locator('[data-testid="get-parts-source"]', { hasText: 'could not be read' })
  await unread.waitFor({ timeout: 15000 }).catch(() => {})
  check('a library without CORS headers is reported, not shown empty', await unread.isVisible())
  await closeGetParts()

  // ── 6. no library: Get parts says how to add one and adds one itself; Settings lists it and keeps it ──
  // the official libraries are listed for everyone; switched off here, so this part reads nothing from the live bucket
  await open('')
  await page.keyboard.press('Shift+/')
  await page.locator('[data-shortcuts-overlay]').waitFor()
  await page.locator('button.settings-tab', { hasText: 'Preferences' }).click()
  const official = page.locator('[data-testid="setting-official-library"]')
  check('Settings lists the official libraries, on by default', (await official.count()) > 0 && (await official.first().isChecked()))
  for (let i = 0; i < (await official.count()); i++) await official.nth(i).uncheck()
  await page.keyboard.press('Escape')
  await openGetParts()
  check('with no library, Get parts says how to add one', (await win.innerText()).includes('No part library yet'))
  await win.locator('[data-testid="get-parts-add-library"]').click()
  const field = win.locator('[data-testid="get-parts-library-url"]')
  await field.fill(libraryAt('nocors', 'containers'))
  await win.locator('[data-testid="get-parts-add-library-confirm"]').click()
  await win.getByText('could not be read').waitFor({ timeout: 15000 }).catch(() => {})
  check('a library that cannot be read is refused in Get parts, with the reason', await win.getByText('could not be read').isVisible())
  await field.fill(libraryAt('ok', 'containers'))
  await field.press('Enter')
  await card('oip.drum').waitFor({ timeout: 15000 }).catch(() => {})
  check('a readable library is added in Get parts, and its parts shown at once, with no window over it', (await card('oip.drum').count()) === 1 && (await page.locator('[data-shortcuts-overlay]').count()) === 0)
  await closeGetParts()
  await page.keyboard.press('Shift+/')
  await page.locator('[data-shortcuts-overlay]').waitFor()
  await page.locator('button.settings-tab', { hasText: 'Preferences' }).click()
  const group = page.locator('[data-testid="settings-part-libraries"]')
  check('Settings lists the library added in Get parts', (await group.locator('[data-testid="setting-remove-library"]').count()) === 1)
  await group.locator('[data-testid="setting-library-url"]').fill(libraryAt('nocors', 'structure'))
  await group.locator('[data-testid="setting-add-library"]').click()
  await group.getByText('could not be read').waitFor({ timeout: 15000 }).catch(() => {})
  check('a library that cannot be read is refused in Settings, with the reason', await group.getByText('could not be read').isVisible())
  await page.keyboard.press('Escape')
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller, null, { timeout: 120000 })
  await openGetParts()
  await win.locator('[data-testid="get-parts-source"][data-library-id="oip.containers"]').waitFor({ timeout: 15000 }).catch(() => {})
  check('and keeps it for the next visit', (await win.locator('[data-testid="get-parts-source"][data-library-id="oip.containers"]').count()) === 1)
} catch (e) {
  failures++
  console.log(`FAIL  ${e instanceof Error ? e.message : e}`)
} finally {
  await browser.close()
  await vite.close()
  host.close()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
