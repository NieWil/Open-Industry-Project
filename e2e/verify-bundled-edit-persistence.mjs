// Diagnostic: does a rig/package edit made via commitPackage survive a reload? Compares a bundled
// (first-party, read-only) package against a user-authored one. syncUserCatalog only persists
// userPackages, so a bundled edit survives only if it is forked into the user library.
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
const { url: URL, vite } = await startServer()
const log = (...a) => console.log(...a)
const MARK = '// e2e-persistence-marker'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  try {
    await page.goto(URL)
    await page.waitForSelector('.viewport canvas', { timeout: 25000 })
    // wait until the first bundled example is actually in the registry (registered on a post-mount tick)
    await page.waitForFunction(() => {
      const h = window.__oip
      const b = h?.store?.getState().bundledPackages?.[0]
      return !!(b && h.getPackage && h.getPackage(b.id))
    }, { timeout: 25000 })

    // edit both a bundled package and a user-authored package via the real commitPackage path (append a
    // marker to each behavior string - a genuine, non-no-op package edit), then read back live.
    const edited = await page.evaluate((MARK) => {
      const store = window.__oip.store
      const bundled = store.getState().bundledPackages[0]
      // a fresh user package: register it (commitPackage) AND add to the catalog (addUserPackage), mirroring
      // createBlankPart - addUserPackage alone only updates state, it doesn't register into the lookup.
      // format 5 = PACKAGE_FORMAT (src/core/parts/partPackage.ts); commitPackage refuses any other format
      const userPkg = { format: 6, id: 'e2e.userpart', name: 'User Part', params: {}, behavior: 'definePart({ step() {} })', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }
      store.commitPackage('seed user', userPkg)
      store.addUserPackage(userPkg)
      const editBehavior = (id) => {
        const p = window.__oip.getPackage(id)
        store.commitPackage('e2e edit', { ...p, behavior: (p.behavior || '') + '\n' + MARK })
      }
      editBehavior(bundled.id)
      editBehavior('e2e.userpart')
      return {
        bundledId: bundled.id,
        liveBundled: (window.__oip.getPackage(bundled.id).behavior || '').includes(MARK),
        liveUser: (window.__oip.getPackage('e2e.userpart').behavior || '').includes(MARK),
      }
    }, MARK)
    log('AFTER EDIT (same session):')
    log('  bundled', JSON.stringify(edited.bundledId), 'has marker live:', edited.liveBundled)
    log('  user part has marker live:', edited.liveUser)

    await page.reload()
    await page.waitForFunction(() => { const h = window.__oip; return !!(h && h.store && h.getPackage) }, { timeout: 25000 })
    await page.waitForTimeout(1200)

    const after = await page.evaluate(({ bundledId, MARK }) => ({
      bundled: (window.__oip.getPackage(bundledId)?.behavior || '').includes(MARK),
      user: (window.__oip.getPackage('e2e.userpart')?.behavior || '').includes(MARK),
    }), { bundledId: edited.bundledId, MARK })
    log('\nAFTER RELOAD:')
    log('  bundled edit survived:', after.bundled)
    log('  user edit survived:', after.user)

    log('\n=== VERDICT ===')
    log('bundled-package edit persists across reload:', after.bundled ? 'YES' : 'NO')
    log('user-package edit persists across reload:', after.user ? 'YES' : 'NO')
    // with copy-on-write (store.syncUserCatalog forks a bundled edit into the user library, and
    // loadBundledExamples doesn't overwrite the fork), both must survive a reload.
    const pass = edited.liveBundled && edited.liveUser && after.bundled === true && after.user === true
    log('\nOVERALL:', pass ? 'PASS' : 'FAIL')
    if (!pass) process.exitCode = 1
  } finally { await browser.close(); vite.kill() }
}
main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1) })
