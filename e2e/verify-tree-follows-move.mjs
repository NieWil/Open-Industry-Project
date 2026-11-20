// Verify that the scene tree keeps the selected row on screen while Ctrl+Down (Move Down) walks it down the list.
// The tree scrolls by itself only when the selection changes, and a move keeps the selection, so the row used to
// walk out of the visible window (the list is windowed, so it then is not even mounted). The store now asks the tree
// to reveal the selection after each move (storeReveal.ts revealTreeSelection).
// Control: the row starts on screen at the bottom edge, so the moves are what take it off.
// Run: node e2e/verify-tree-follows-move.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const PARTS = 60
const MOVES = 8

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })

/** whether the selected row is mounted and fully inside the tree's visible window */
const selectedRowVisible = (page) =>
  page.evaluate(() => {
    const tree = document.querySelector('.scene-tree')
    const row = tree?.querySelector('.tree-row.selected')
    if (!tree || !row) return { visible: false, why: row ? 'no tree' : 'selected row not mounted' }
    const t = tree.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    return { visible: r.top >= t.top - 1 && r.bottom <= t.bottom + 1, why: `row ${r.top.toFixed(0)}-${r.bottom.toFixed(0)} in ${t.top.toFixed(0)}-${t.bottom.toFixed(0)}` }
  })

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

    await page.evaluate((n) => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const parts = Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        type: 'part',
        packageId: pkg.id,
        position: [(i % 10) * 4, 0.5, Math.floor(i / 10) * 3],
        rotationY: 0,
        name: `Belt ${String(i).padStart(2, '0')}`,
        params,
      }))
      store.loadScene({ version: store.getState().scene.version, parts, packages: [pkg] })
    }, PARTS)
    await page.waitForSelector('.scene-tree .tree-row')
    await page.evaluate(() => {
      document.querySelector('.scene-tree').scrollTop = 0
    })
    await page.waitForTimeout(200)

    // the last row fully on screen, so a few moves down take it off the bottom
    const startId = await page.evaluate(() => {
      const tree = document.querySelector('.scene-tree')
      const t = tree.getBoundingClientRect()
      const rows = [...tree.querySelectorAll('.tree-row')].filter((r) => r.getBoundingClientRect().bottom <= t.bottom)
      const label = rows.at(-1)?.textContent ?? ''
      const m = /Belt (\d\d)/.exec(label)
      return m ? `p${Number(m[1])}` : null
    })
    check('setup: found the last visible row', !!startId, String(startId))
    if (!startId) return
    const scrolled = await page.evaluate(() => document.querySelector('.scene-tree').scrollHeight > document.querySelector('.scene-tree').clientHeight)
    check('setup: the tree has more rows than fit', scrolled)
    await page.evaluate((id) => window.__oip.store.select(id), startId)
    await page.waitForTimeout(200)
    const before = await selectedRowVisible(page)
    check('control: the selected row starts on screen', before.visible, before.why)

    const indexOf = () => page.evaluate((id) => window.__oip.store.getState().scene.parts.findIndex((p) => p.id === id), startId)
    const i0 = await indexOf()
    await page.evaluate(() => document.activeElement instanceof window.HTMLElement && document.activeElement.blur())
    for (let i = 0; i < MOVES; i++) {
      await page.keyboard.press('Control+ArrowDown')
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(200)
    const i1 = await indexOf()
    check(`Ctrl+Down moved the part ${MOVES} slots`, i1 === i0 + MOVES, `${i0} -> ${i1}`)
    const after = await selectedRowVisible(page)
    check('the tree followed the row', after.visible, after.why)
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
