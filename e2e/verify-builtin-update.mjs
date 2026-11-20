// A project's own version of a built-in part, and an app that later ships a changed built-in (core/builtInVersion.ts).
//
// A project keeps its own copy of every part it uses (docs/part-sources.md), and editing a built-in changes that copy
// under the same id. The copy records which built-in version it was made from, so when a later app ships a changed
// built-in the app asks instead of changing the project: the catalog card shows "Updated", and both it and the
// Inspector offer the same two answers (components/builtInUpdate.ts).
//
// The app update is simulated in the page: the store's built-in list is replaced by a changed copy of the same part,
// which is what a new build hands a returning project.
//
//   node e2e/verify-builtin-update.mjs [--headed]
/* global window, localStorage, console, process */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port, vite } = await startServer()
const URL = `http://localhost:${port}/app/?scene=demo`
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('dialog', (d) => void d.accept())
let harness = null

/** the store's view of the part: whose version is live, and whether the app flags it */
const state = (id) =>
  page.evaluate((pid) => {
    const s = window.__oip.store.getState()
    return {
      behavior: window.__oip.getPackage(pid)?.behavior ?? '',
      inLibrary: s.userPackages.some((p) => p.id === pid),
      fromApp: s.userPackages.find((p) => p.id === pid)?.origin?.app ?? null,
    }
  }, id)
/** what a new app build hands a returning project: the same built-in, changed */
const shipUpdate = (id, mark) =>
  page.evaluate(
    ([pid, m]) => {
      const st = window.__oip.store
      const s = st.getState()
      st.setState({ bundledPackages: s.bundledPackages.map((p) => (p.id === pid ? { ...p, behavior: `${p.behavior}\n// ${m}\n` } : p)) })
    },
    [id, mark],
  )

try {
  await page.goto(URL)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 120000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })

  // a built-in the demo has placed (not the building), to edit and to select
  const pick = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    const builtIn = new Map(s.bundledPackages.map((p) => [p.id, p]))
    const placed = s.scene.parts.find((p) => p.type === 'part' && builtIn.has(p.packageId))
    return placed ? { partId: placed.id, id: placed.packageId, name: builtIn.get(placed.packageId).name } : null
  })
  if (!pick) throw new Error('the demo has no placed built-in part')
  const card = page.locator(`.catalog-card:has([data-package-id="${pick.id}"])`)
  const badge = card.locator('[data-testid="part-update"][data-source="app"]')
  await page.locator('.catalog-search').fill(pick.name)

  // ── an in-app edit makes this project's version, recording where it came from ─────────────────────
  const errs = await page.evaluate((pid) => {
    const pkg = window.__oip.getPackage(pid)
    return window.__oip.controller.editBehavior(pid, `${pkg.behavior}\n// this project's change\n`)
  }, pick.id)
  check('an in-app edit of a built-in applies', errs.length === 0, JSON.stringify(errs))
  const mine = await state(pick.id)
  check("it becomes this project's version, recording which built-in it was made from", mine.inLibrary && !!mine.fromApp, JSON.stringify(mine.fromApp))
  check('no Update badge while the built-in is unchanged', (await badge.count()) === 0)

  // ── the app ships a changed built-in: the catalog says so, and Keep stops the question ───────────
  await shipUpdate(pick.id, 'app v2')
  await badge.waitFor({ timeout: 10000 })
  check('the catalog card offers the update', await badge.isVisible())
  check("...and this project still uses its own version", (await state(pick.id)).behavior.includes("this project's change"))
  await page.evaluate((id) => window.__oip.store.select(id), pick.partId)
  const inspector = page.locator('[data-testid="inspector-builtin-updated"]')
  await inspector.waitFor({ timeout: 10000 })
  check('the Inspector asks the same question on a placed copy', (await inspector.innerText()).includes('has been updated'))
  await badge.click()
  // the card's badge asks in the change dialog, with the app's second answer beside Update
  await page.locator('[data-testid="part-change-dialog"] [data-testid="part-change-alternative"]').click()
  await badge.waitFor({ state: 'detached', timeout: 10000 })
  check('Keep: the badge goes', (await badge.count()) === 0)
  check('...the Inspector stops asking', (await inspector.count()) === 0)
  check("...and the project's version is untouched", (await state(pick.id)).behavior.includes("this project's change"))

  // ── it changes again: this time take the app's ────────────────────────────────────────────────────
  await shipUpdate(pick.id, 'app v3')
  await inspector.waitFor({ timeout: 10000 })
  check('a further app change asks again', await badge.isVisible())
  await inspector.locator('[data-testid="builtin-update-use"]').click()
  await badge.waitFor({ state: 'detached', timeout: 10000 })
  const after = await state(pick.id)
  check("Use the app's new version: the updated built-in is live", after.behavior.includes('app v3') && !after.behavior.includes("this project's change"))
  // the part is still placed, so the library keeps a copy (every part a project uses is its own,
  // docs/part-sources.md): the app's new version, recorded as such
  check("...and the project's copy is now the app's version, recorded as copied from it", after.inLibrary && !!after.fromApp && after.fromApp !== mine.fromApp, JSON.stringify({ before: mine.fromApp, after: after.fromApp }))
} catch (e) {
  // printed without a leading FAIL: the gate runner reports a script that broke on its own assumptions as HARNESS
  harness = e
  console.error('harness error:', e instanceof Error ? e.message : e)
} finally {
  await browser.close()
  vite.kill()
}
if (harness) process.exit(2)
console.log(failures ? `FAIL  verify-builtin-update (${failures})` : 'PASS  verify-builtin-update')
process.exit(failures ? 1 : 0)
