// Verify that the scene tree's own view state (the filter, collapsed groups) starts fresh when another scene is
// loaded in place: opening a project or entering the demo replaces the scene without remounting the tree, and part
// ids repeat across scenes (bc_1 in both), so the next scene used to open filtered, or with a same-id group collapsed.
// The tree is keyed on store.sceneLoads now. Control: an edit (not a load) keeps the filter.
// Run: node e2e/verify-tree-fresh-per-scene.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })

/** a scene of belts, `group` holding the first two as soft-parented children */
const loadBelts = (page, names) =>
  page.evaluate((names) => {
    const { store, getPackage } = window.__oip
    const pkg = getPackage('oip.belt-conveyor')
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
    const parts = names.map((name, i) => ({
      id: `b${i}`,
      type: 'part',
      packageId: pkg.id,
      position: [i * 4, 0.5, 0],
      rotationY: 0,
      name,
      params,
      ...(i > 0 && i < 3 ? { parent: 'b0' } : {}),
    }))
    store.loadScene({ version: store.getState().scene.version, parts, packages: [pkg] })
  }, names)

const rowLabels = (page) => page.evaluate(() => [...document.querySelectorAll('.scene-tree .tree-row')].map((r) => r.textContent.trim()))

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.belt-conveyor'), null, { timeout: 60000 })

    await loadBelts(page, ['Alpha', 'Bravo', 'Charlie', 'Delta'])
    await page.waitForSelector('.scene-tree .tree-row')
    const filter = page.locator('.scene-tree-head .scene-filter, .scene-filter').first()
    await filter.fill('Delta')
    await page.waitForTimeout(200)
    const filtered = await rowLabels(page)
    check('setup: the filter narrows the first scene', filtered.length === 1 && filtered[0].includes('Delta'), filtered.join(' | '))

    // control: an edit is not a load, so the filter stays
    await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.commit('e2e rename', { ...s, parts: s.parts.map((p) => (p.id === 'b1' ? { ...p, name: 'Bravo 2' } : p)) })
    })
    await page.waitForTimeout(150)
    check('control: an edit keeps the filter', (await filter.inputValue()) === 'Delta')

    // another scene, same ids, different names: it must open unfiltered
    await loadBelts(page, ['Echo', 'Foxtrot', 'Golf', 'Hotel'])
    await page.waitForTimeout(300)
    const after = await rowLabels(page)
    const f2 = page.locator('.scene-filter').first()
    check('a loaded scene starts with an empty filter', (await f2.inputValue()) === '', JSON.stringify(await f2.inputValue()))
    check('and shows all its rows', after.some((l) => l.includes('Echo')) && after.some((l) => l.includes('Hotel')), after.join(' | '))
  } finally {
    await browser.close()
    vite?.kill?.()
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.log('FAIL  threw', e)
}
console.log(failures ? `${failures} failure(s)` : 'all checks passed')
process.exit(failures ? 1 : 0)
