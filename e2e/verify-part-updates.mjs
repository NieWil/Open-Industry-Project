// The part update prompt (components/PartUpdatesNotice.tsx, docs/part-sources.md): a project keeps its own copy of
// every part it uses, so when the app ships a newer version of one, the app says so when the project opens and
// changes nothing until someone chooses.
//
// A saved project is planted holding older copies of two built-ins, each stamped with the version it was copied at
// (`origin.app`): one untouched since (update available), one also changed in the project (changed in both). Then:
//   - the prompt counts both, and the project still runs its own copies;
//   - Review lists both, saying which one this project changed too; Keep on that one stops its question;
//   - Update all takes the app's version of the other: live, still the project's own copy, stamped anew;
//   - after a reload nothing is left to ask, so no prompt.
//
//   node e2e/verify-part-updates.mjs [--headed] [--shot <dir>]   (--shot: PNGs of the prompt and the review list)
/* global window, localStorage, console, process */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { startServer } from './_server.mjs'

const { port, vite } = await startServer()
const URL = `http://localhost:${port}/app/`
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('dialog', (d) => void d.accept())
let harness = null
const shotAt = process.argv.indexOf('--shot')
const shotDir = shotAt > 0 ? process.argv[shotAt + 1] : null
const shot = async (name) => {
  if (shotDir) await page.screenshot({ path: join(shotDir, `${name}.png`) }) // UI chrome on purpose, not a scene shot
}

const OLD = '\n// as an older build shipped it\n'
const MINE = '\n// and changed in this project\n'
const booted = () => page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 2, null, { timeout: 120000 })
const notice = page.locator('[data-testid="part-updates-notice"]')
/** what the project runs for a part, and what its copy says it was copied from */
const partOf = (id) =>
  page.evaluate((pid) => {
    const s = window.__oip.store.getState()
    const own = s.userPackages.find((p) => p.id === pid)
    return { live: window.__oip.getPackage(pid)?.behavior ?? '', own: own?.behavior ?? null, fromApp: own?.origin?.app ?? null, app: s.bundledPackages.find((p) => p.id === pid)?.behavior ?? '' }
  }, id)

try {
  await page.goto(URL)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await booted()

  // ── plant: a project whose copies of two built-ins are older than this app's ─────────────────────
  const planted = await page.evaluate(
    async ([old, mine]) => {
      const { partFingerprint } = await import('/src/core/parts/partOrigin.ts')
      const { PROJECT_VERSION } = await import('/src/core/project/project.ts')
      const s = window.__oip.store.getState()
      const [a, b] = ['oip.belt-conveyor', 'oip.roller-conveyor'].map((id) => s.bundledPackages.find((p) => p.id === id))
      if (!a || !b) return null
      // an untouched copy of an older version: stamped with that version's own fingerprint. It had a signal the app's
      // version dropped, so Review has a breaking change to say
      const olderA = { ...a, behavior: a.behavior + old, params: { ...a.params, probeRetired: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'Probe_Retired', label: 'Retired probe signal' } } }
      const copyA = { ...olderA, origin: { app: partFingerprint(olderA) } }
      // an older version the project then changed: stamped with the version it was copied at, content moved on since
      const olderB = { ...b, behavior: b.behavior + old }
      const copyB = { ...olderB, behavior: olderB.behavior + mine, origin: { app: partFingerprint(olderB) } }
      const at = (id, packageId, x, params = {}) => ({ id, type: 'part', packageId, name: id, position: [x, 0, 0], rotationY: 0, params })
      // the placed belt is wired to the signal the update drops, on a tag the program uses: what Review must say
      const stProgram = 'PROGRAM Main\nVAR\n  Probe_Run : BOOL;\nEND_VAR\nProbe_Run := TRUE;\nEND_PROGRAM\n'
      const doc = {
        version: PROJECT_VERSION,
        name: 'Update probe',
        packages: [copyA, copyB],
        stProgram,
        scene: { version: 4, parts: [at('belt', a.id, 0, { probeRetired: 'Probe_Run' }), at('rollers', b.id, 4)] },
      }
      localStorage.setItem('oip-web/project', JSON.stringify(doc))
      return { a: a.id, b: b.id, aName: a.name, bName: b.name }
    },
    [OLD, MINE],
  )
  if (!planted) throw new Error('the app has no belt or roller conveyor to plant')
  await page.reload()
  await booted()

  // ── the prompt, and nothing changed yet ────────────────────────────────────────────────────────
  await notice.waitFor({ timeout: 30000 })
  await shot('1-prompt')
  check('the prompt counts both parts', (await notice.innerText()).includes('2 parts in this project have updates'), await notice.innerText())
  const a0 = await partOf(planted.a)
  const b0 = await partOf(planted.b)
  check('...and the project still runs its own copies', a0.live.endsWith(OLD) && b0.live.endsWith(MINE), JSON.stringify({ a: a0.live.slice(-40), b: b0.live.slice(-40) }))

  // ── Review: both listed, the edited one said so; Keep it ───────────────────────────────────────
  await page.locator('[data-testid="part-updates-review"]').click()
  const rows = page.locator('[data-testid="part-updates-row"]')
  await rows.first().waitFor({ timeout: 10000 })
  await shot('2-review')
  check('Review lists both', (await rows.count()) === 2, String(await rows.count()))
  const rowB = page.locator(`[data-testid="part-updates-row"][data-package-id="${planted.b}"]`)
  const rowA = page.locator(`[data-testid="part-updates-row"][data-package-id="${planted.a}"]`)
  check('...saying which one this project changed too', (await rowB.innerText()).includes('changed in this project too') && !(await rowA.innerText()).includes('changed in this project too'))
  // what each update changes (core/parts/partChanges.ts): the dropped signal first, as breaking, then the script
  const impacts = await rowA.locator('[data-testid="part-updates-changes"] [data-impact]').evaluateAll((els) => els.map((e) => e.getAttribute('data-impact')))
  const rowAText = await rowA.innerText()
  check('...and what the update changes, breaking first', impacts[0] === 'breaking' && impacts.includes('behavior') && rowAText.includes('Retired probe signal') && rowAText.includes('script changed'), JSON.stringify(impacts))
  // ...and what the breaking change breaks in this project (plc/updateImpact.ts): loaded when Review opens
  const here = rowA.locator('[data-testid="part-updates-impact"]')
  await here.first().waitFor({ timeout: 10000 }).catch(() => {})
  const hereText = (await here.count()) > 0 ? await here.first().innerText() : ''
  check('...naming the tag the placed copy is wired to and where the program uses it', hereText.includes('Probe_Run') && hereText.includes('the program uses it (line 3, line 5)'), hereText)
  await rowB.locator('[data-testid="part-updates-keep"]').click()
  await rowB.waitFor({ state: 'detached', timeout: 10000 })
  check("Keep: that part's question goes", (await rows.count()) === 1)
  check("...and the project's changed copy is untouched", (await partOf(planted.b)).live.endsWith(MINE))
  await page.keyboard.press('Escape')

  // ── Update all: the app's version of the other, as the project's own copy ──────────────────────
  await notice.waitFor({ timeout: 10000 })
  check('the prompt now counts one', (await notice.innerText()).includes('1 part in this project has an update'), await notice.innerText())
  await page.locator('[data-testid="part-updates-all"]').click()
  await notice.waitFor({ state: 'detached', timeout: 10000 })
  const a1 = await partOf(planted.a)
  check("Update all: the app's version is live", a1.live === a1.app && !a1.live.endsWith(OLD))
  check("...still the project's own copy, stamped as copied from the app's version", a1.own === a1.app && !!a1.fromApp && a1.fromApp !== a0.fromApp, JSON.stringify({ before: a0.fromApp, after: a1.fromApp }))

  // ── nothing left to ask after a reload ─────────────────────────────────────────────────────────
  await page.waitForTimeout(1500) // the library change's autosave
  await page.reload()
  await booted()
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
  check('after a reload there is no prompt', (await notice.count()) === 0)
  check('...and the kept copy is still the project\'s changed one', (await partOf(planted.b)).live.endsWith(MINE))
} catch (e) {
  // printed without a leading FAIL: the gate runner reports a script that broke on its own assumptions as HARNESS
  harness = e
  console.error('harness error:', e instanceof Error ? e.message : e)
} finally {
  await browser.close()
  vite.kill()
}
if (harness) process.exit(2)
console.log(failures ? `FAIL  verify-part-updates (${failures})` : 'PASS  verify-part-updates')
process.exit(failures ? 1 : 0)
