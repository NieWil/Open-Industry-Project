// Smoke test for the browser custom-part authoring persistence. Boots the real app in headless
// Chromium with no window.oipParts (i.e. the browser, not the desktop shell), authors a blank part in
// app, edits its behavior, then reloads and verifies the whole durability chain survives:
//   createBlankPart → addUserPackage → the project doc's library, localStorage 'oip-web/project'  (catalog only: a new part is
//     not placed in the working scene; it goes there only when dragged from the catalog)
//   + commitPackage edit → syncUserCatalog re-persists the latest behavior
//   reload → bootSolo → loadProject → catalog card back + registry has the edited version,
//     and the working scene still holds no instance of the authored part.
//
// Run: node e2e/verify-browser-authoring-persistence.mjs
// Starts its own dev server (e2e/_server.mjs; unminified, so window.__oip + property names survive), or
// attaches to a shared one.

import { chromium } from 'playwright'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { startServer } from './_server.mjs'

const { url: URL, vite } = await startServer()
const OUT = path.join(os.tmpdir(), 'browser-authoring-verify')
mkdirSync(OUT, { recursive: true })
const log = (...a) => console.log(...a)

const EDIT_MARKER = 'BROWSER_AUTHORING_PERSISTS'
const EDITED_BEHAVIOR = `definePart({ params: {}, step(ctx) { /* ${EDIT_MARKER} */ } })`

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
// a fresh context = empty localStorage, so the run is deterministic (no leftover autosave/user-packages)
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('console', (m) => { if (m.type() === 'error') log('  [page error]', m.text()) })

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` - ${detail}` : ''}`) }

try {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.catalog-card', { timeout: 20000 }) // built-in cards = app booted
  await page.waitForFunction(() => !!(window.__oip && window.__oip.controller), { timeout: 10000 })
  // confirm this is the browser path (no desktop bridge), which is what this test covers
  const isBrowser = await page.evaluate(() => !window.oipParts)
  check('running the browser path (no window.oipParts)', isBrowser)
  await page.screenshot({ path: `${OUT}/01-loaded.png` })

  // ---- author a blank part in-app, then edit its behavior (both should persist) ----
  const authored = await page.evaluate(async (behavior) => {
    const c = window.__oip.controller
    const id = c.createBlankPart()
    const diags = c.editBehavior(id, behavior) // [] on success
    // Back out of the authoring sub-scene (like clicking the breadcrumb "Back"): a new part is added to the
    // catalog only, so once we leave there must be no instance of it in the working scene.
    c.store.exitPartFocus()
    const st = c.store.getState()
    return {
      id,
      diags,
      inUserPackages: st.userPackages.some((p) => p.id === id),
      inScene: st.scene.parts.some((p) => p.type === 'part' && p.packageId === id),
      embedded: (st.scene.packages || []).some((p) => p.id === id),
      lsRaw: (await window.__oip.savedProject()),
      lsLegacy: localStorage.getItem('oip-web/user-packages'),
    }
  }, EDITED_BEHAVIOR)
  log('  authored:', authored.id, 'editDiags=', JSON.stringify(authored.diags))
  check('blank part added to the catalog (userPackages)', authored.inUserPackages, authored.id)
  check('NOT placed in the working scene - catalog only (added only when dragged in)', !authored.inScene)
  check('package NOT embedded in the durable scene (no placement → no embed)', !authored.embedded)
  check('behavior edit committed without diagnostics', Array.isArray(authored.diags) && authored.diags.length === 0)
  const lsHasEdit = !!authored.lsRaw && authored.lsRaw.includes(EDIT_MARKER)
  check('localStorage holds the part with the EDITED behavior', lsHasEdit)
  check('no second copy of the library under the legacy key', authored.lsLegacy === null)
  await page.screenshot({ path: `${OUT}/02-authored.png` })

  // ---- reload: the real durability test (bootSolo → loadProject) ----
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.catalog-card', { timeout: 20000 })
  await page.waitForFunction(() => !!(window.__oip && window.__oip.controller), { timeout: 10000 })

  const after = await page.evaluate((id) => {
    const c = window.__oip.controller
    const st = c.store.getState()
    const up = st.userPackages.find((p) => p.id === id)
    return {
      restored: !!up,
      behaviorKept: !!up && up.behavior.includes('BROWSER_AUTHORING_PERSISTS'),
      // the durable scene must not carry an instance of the authored part - it is catalog-only
      sceneHasInstance: st.scene.parts.some((p) => p.type === 'part' && p.packageId === id),
    }
  }, authored.id)
  // the catalog card returning = it's registered + placeable again, not just in state
  const cardCount = await page.locator(`[data-package-id="${authored.id}"]`).count()
  await page.screenshot({ path: `${OUT}/03-after-reload.png` })

  check('authored part restored into the catalog after reload', after.restored, authored.id)
  check('its catalog card is rendered (placeable again)', cardCount > 0, `${cardCount} card(s)`)
  check('restored part carries the LATEST (edited) behavior', after.behaviorKept)
  check('the working scene still has NO instance of it after reload (catalog-only, never durably added)', !after.sceneHasInstance)

  const pass = results.every((r) => r.ok)
  log(`\n=== VERDICT: ${pass ? 'PASS' : 'FAIL'} ===   (${results.filter((r) => r.ok).length}/${results.length})`)
  log(`  screenshots in ${OUT}`)
  process.exitCode = pass ? 0 : 1
} catch (e) {
  log('ERROR:', e.message)
  await page.screenshot({ path: `${OUT}/error.png` }).catch(() => {})
  process.exitCode = 2
} finally {
  await browser.close()
  vite.kill()
}
