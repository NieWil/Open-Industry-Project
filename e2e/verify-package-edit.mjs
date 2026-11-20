// Verify the package-edit ✎ flow through the real browser editor: clicking the Catalog ✎ on a custom
// part that is not placed opens its rig at the origin in a throwaway session, the throwaway is excluded
// from the saved document (reload-safe), and Back removes it with no trace.
/* global process, console, window, localStorage, document */
import os from 'node:os'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
const { url: URL, vite } = await startServer()
const SHOTDIR = os.tmpdir()
const log = (...a) => console.log(...a)

const snap = (page) => page.evaluate(() => {
  const s = window.__oip.controller.store.getState()
  return {
    parts: s.scene.parts.length,
    customIds: s.scene.parts.filter((p) => p.type === 'part').map((p) => ({ id: p.id, pkg: p.packageId, x: +p.position[0].toFixed(2), z: +p.position[2].toFixed(2) })),
    packageEdit: s.packageEdit ? { packageId: s.packageEdit.packageId, partId: s.packageEdit.partId } : null,
    // the document's scene, set aside by a definition session while its own scene (just the throwaway) is on screen
    documentParts: (s.packageEdit?.document ?? s.scene).parts.length,
    focusedPartId: s.focusedPartId,
    selectedRigNode: s.selectedRigNode ?? null,
    // a package-edit session renders the definition-scope header (badge + ◂ Scene + name); part-focus
    // renders the plain breadcrumb - accept either as "the header that names the edited thing"
    breadcrumb: (() => { const b = document.querySelector('.scene-def-scope') ?? document.querySelector('.scene-breadcrumb'); return b ? b.textContent.replace(/\s+/g, ' ').trim() : null })(),
  }
})

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const results = {}
  try {
    await page.goto(URL)
    await page.waitForFunction(() => { const h = window.__oip; return !!(h && h.controller && h.controller.store && h.view) }, { timeout: 25000 })
    await page.waitForSelector('.viewport canvas', { timeout: 25000 })
    await page.waitForTimeout(1200)

    // Setup: a clean scene with one plain Group container and no custom ('part') instance, so every SDK
    // package, including the test package, is unplaced. Use the first bundled custom package (always
    // present) to drive its catalog card.
    const setup = await page.evaluate(() => {
      const store = window.__oip.controller.store
      store.loadScene({ version: store.getState().scene.version, parts: [
        { id: 'grp_1', type: 'group', position: [0, 0, 0], rotationY: 0, params: {} },
      ] })
      const pkg = store.getState().bundledPackages[0]
      return { pkgId: pkg?.id, pkgName: pkg?.name, parts: store.getState().scene.parts.length }
    })
    log('SETUP: unplaced custom package =', JSON.stringify(setup.pkgName), '| id', setup.pkgId, '| scene parts', setup.parts)
    if (!setup.pkgId) throw new Error('no bundled custom package found to test')

    // surface the custom card via the catalog search box, then locate its ✎ (scoped to custom cards)
    await page.fill('.catalog-search', setup.pkgName)
    await page.waitForTimeout(400)
    const card = page.locator('.catalog-card-custom').first()
    await card.waitFor({ state: 'visible', timeout: 8000 })
    const editBtn = card.locator('.catalog-card-edit')
    // the ✎ must be enabled for an unplaced part
    results.enabled = (await editBtn.getAttribute('disabled')) === null
    log('✎ enabled for unplaced part:', results.enabled)

    const before = await snap(page)

    // === click the ✎ ===
    await card.hover()
    await editBtn.click()
    await page.waitForTimeout(500)
    const inEdit = await snap(page)
    await page.screenshot({ path: `${SHOTDIR}/package-edit-session.png` })
    log('\nAFTER ✎ (enter package-edit):')
    log('  packageEdit session:', JSON.stringify(inEdit.packageEdit))
    log('  focusedPartId:', inEdit.focusedPartId, '| selectedRigNode:', JSON.stringify(inEdit.selectedRigNode))
    log('  breadcrumb:', JSON.stringify(inEdit.breadcrumb))
    log('  scene parts:', inEdit.parts, '(was', before.parts, ') | custom parts:', JSON.stringify(inEdit.customIds))
    const draft = inEdit.customIds.find((c) => c.id === inEdit.packageEdit?.partId)
    results.enter = !!inEdit.packageEdit && inEdit.packageEdit.packageId === setup.pkgId &&
      // the session's own scene is just the throwaway, and the set-aside document scene has nothing added to it
      inEdit.focusedPartId === inEdit.packageEdit.partId && inEdit.parts === 1 && inEdit.documentParts === before.parts &&
      !!draft && draft.pkg === setup.pkgId && Math.abs(draft.x) < 0.01 && Math.abs(draft.z) < 0.01 &&
      !!inEdit.breadcrumb

    // === edit the package via the real commit path (the channel every rig-node editor uses), confirm no throw ===
    const edited = await page.evaluate((pkgId) => {
      const store = window.__oip.controller.store
      const s = store.getState()
      const pkg = [...s.bundledPackages, ...(s.userPackages || [])].find((p) => p.id === pkgId)
      if (!pkg) return { ok: false, why: 'no package object' }
      const rev0 = store.getState().packageRev
      try {
        store.commitPackage('e2e marker', { ...pkg })
        return { ok: store.getState().packageRev > rev0 }
      } catch (e) { return { ok: false, why: String(e) } }
    }, setup.pkgId)
    log('\nrig-edit via commitPackage:', JSON.stringify(edited))
    results.edit = edited.ok

    // === Play is enabled inside a part scene; it runs the part in isolation (see verify-isolated-run.mjs).
    // Just assert the button is enabled here; don't actually start the sim (it would disrupt the steps below).
    const play = await page.evaluate(() => {
      const btn = document.querySelector('.run-button.play')
      return { disabled: !!btn?.disabled }
    })
    log('\nPLAY (in session): Play button enabled =', !play.disabled)
    results.play = play.disabled === false

    // === switching: ✎ on a different package while a session is open switches scenes (one throwaway) ===
    const sw = await page.evaluate(() => {
      const store = window.__oip.controller.store
      // inject a second custom package via commitPackage (registers it), then switch to it via the real entry point
      // format 6 = PACKAGE_FORMAT (src/core/parts/partPackage.ts); commitPackage refuses any other format
      store.commitPackage('add Part B', { format: 6, id: 'e2e.partB', name: 'Part B', params: {}, behavior: 'definePart({ step() {} })', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } })
      const ok = window.__oip.controller.editPartPackage('e2e.partB')
      const s = store.getState()
      const customs = s.scene.parts.filter((p) => p.type === 'part')
      // exactly one throwaway, and it's the new package's (the old session's throwaway was dropped). id is
      // reused (nextId re-mints cp_1 after the old one is removed), so assert by packageId, not id.
      return { ok, switchedTo: s.packageEdit?.packageId, customCount: customs.length, remainingPkg: customs[0]?.packageId, focusIsNew: s.focusedPartId === s.packageEdit?.partId }
    })
    log('\nSWITCH (✎ on a different package mid-session):', JSON.stringify(sw))
    results.switch = sw.ok && sw.switchedTo === 'e2e.partB' && sw.customCount === 1 && sw.remainingPkg === 'e2e.partB' && sw.focusIsNew

    // === Back (the def-scope header's ◂ Scene button) removes the throwaway, no trace ===
    await page.locator('.scene-def-scope-back').click()
    await page.waitForTimeout(400)
    const afterBack = await snap(page)
    log('\nAFTER Back:')
    log('  packageEdit:', afterBack.packageEdit, '| focusedPartId:', afterBack.focusedPartId)
    log('  scene parts:', afterBack.parts, '| custom parts:', JSON.stringify(afterBack.customIds))
    results.back = afterBack.packageEdit === null && afterBack.focusedPartId === null &&
      afterBack.parts === before.parts && afterBack.customIds.length === 0

    // === reload mid-session must not leave the throwaway in the scene ===
    await page.locator('.catalog-card-custom').first().hover()
    await page.locator('.catalog-card-custom .catalog-card-edit').first().click()
    await page.waitForTimeout(400)
    const reSnap = await snap(page)
    log('\nre-entered for reload test: session =', !!reSnap.packageEdit, '| parts =', reSnap.parts)
    await page.reload()
    await page.waitForFunction(() => { const h = window.__oip; return !!(h && h.controller && h.controller.store) }, { timeout: 25000 })
    await page.waitForTimeout(1200)
    const afterReload = await snap(page)
    log('AFTER reload:')
    log('  packageEdit:', afterReload.packageEdit, '| scene parts:', afterReload.parts, '| custom parts:', JSON.stringify(afterReload.customIds))
    results.reload = afterReload.packageEdit === null && afterReload.customIds.length === 0

    const realErrors = errors.filter((e) => !/GLTFLoader|Couldn't load texture|texture/i.test(e))
    log('\n=== SUMMARY ===')
    log('1. ✎ enabled for an UNPLACED custom part:', results.enabled)
    log('2. ✎ opens a package-edit session: its own scene of just the throwaway at origin, focused, breadcrumb, document untouched:', results.enter)
    log('3. rig edit via commitPackage succeeds mid-session:', results.edit)
    log('4. Play is ENABLED inside a part scene (runs the part in isolation):', results.play)
    log('5. ✎ on another package mid-session SWITCHES scenes (one throwaway, old gone, focus moved):', results.switch)
    log('6. Back removes the throwaway - no custom part, session cleared, original part count:', results.back)
    log('7. reload mid-session leaves NO stranded throwaway (durable doc excluded it):', results.reload)
    log('console errors (excl. texture noise):', realErrors.length ? JSON.stringify(realErrors.slice(0, 8)) : 'NONE')
    const pass = results.enabled && results.enter && results.edit && results.play && results.switch && results.back && results.reload && realErrors.length === 0
    log('\nOVERALL:', pass ? 'PASS' : 'FAIL')
    if (!pass) process.exitCode = 1
  } finally { await browser.close(); vite.kill() }
}
main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1) })
