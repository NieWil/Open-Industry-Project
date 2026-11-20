// Gate: the scene tree's DOM is bounded by the viewport, not by the scene.
//
// The panel counterpart of verify-draw-budget.mjs, with the same two parts: a ceiling on what the tree
// renders, plus the scaling invariant that duplicating the scene must not grow it. Without windowing,
// a 200-part demo puts 3,897 nodes / 200 rows in the DOM with 177 rows scrolled out of sight, and the
// browser's layout+paint of that DOM makes the frame where the selection changes take ~35 ms in a prod
// build, against a 16.6 ms quiet frame.
//
// The budget alone is a vacuous test, since rendering no rows would pass it. The behaviour checks
// cover that: the selected row must be in the DOM and on screen even when it is far down the list,
// and scrolling to the bottom must render the last row.
// Run: node e2e/verify-panel-dom-budget.mjs
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

// generous: ~23 rows fit the demo dock at this viewport, plus 2x6 overscan, plus the renaming row
const ROW_CEILING = 60
const NODE_CEILING = 1200

const { port: PORT, vite } = await startServer()
let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const treeShape = (page) =>
  page.evaluate(() => {
    const tree = document.querySelector('.scene-tree')
    if (!tree) return null
    const rows = [...tree.querySelectorAll('.tree-row')]
    const box = tree.getBoundingClientRect()
    return {
      rows: rows.length,
      nodes: tree.querySelectorAll('*').length,
      scrollH: Math.round(tree.scrollHeight),
      clientH: Math.round(tree.clientHeight),
      ids: rows.map((r) => r.getAttribute('data-row-id')),
      onScreen: rows.filter((r) => {
        const b = r.getBoundingClientRect()
        return b.bottom > box.top && b.top < box.bottom
      }).length,
      parts: window.__oip.store.getState().scene.parts.length,
    }
  })

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
    await page.addInitScript(() => {
      try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ }
    })
    await page.goto(`http://localhost:${PORT}/app/?scene=demo`)
    await page.waitForFunction(() => (window.__oip?.store?.getState().scene.parts.length ?? 0) > 0, { timeout: 60000 })
    await page.waitForTimeout(2000)

    const base = await treeShape(page)
    check('tree renders a bounded number of rows', base.rows <= ROW_CEILING, `${base.rows} rows for ${base.parts} parts (ceiling ${ROW_CEILING})`)
    check('tree DOM stays under the node budget', base.nodes <= NODE_CEILING, `${base.nodes} nodes (ceiling ${NODE_CEILING})`)
    // the scrollbar must still cover the whole list, or the user cannot reach the rest
    check('scroll extent covers every row', base.scrollH > base.clientH * 3, `scrollHeight=${base.scrollH} clientHeight=${base.clientH}`)

    // --- behaviour: selecting a part far down the list brings its row into the DOM and on screen ---
    // the tree's last row, which is not the scene's last part: rows are a pre-order walk of the
    // hierarchy (core/scene/hierarchy.ts orderedTree - roots in array order, each followed by its subtree),
    // so a child part listed last in `scene.parts` draws inside its parent, mid-list. Last root, then
    // its last child, down to a leaf (a fresh localStorage collapses nothing).
    const lastId = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const present = new Set(parts.map((p) => p.id))
      const kids = (id) => parts.filter((p) => p.parent === id)
      const roots = parts.filter((p) => p.parent === undefined || !present.has(p.parent))
      let row = roots[roots.length - 1]
      const seen = new Set()
      for (let c = kids(row.id); c.length && !seen.has(row.id); c = kids(row.id)) { seen.add(row.id); row = c[c.length - 1] }
      return row.id
    })
    await page.evaluate((id) => window.__oip.store.select(id), lastId)
    await page.waitForTimeout(600)
    const afterSelect = await treeShape(page)
    const rowBox = await page.evaluate((id) => {
      const row = document.querySelector(`[data-row-id="${id}"]`)
      const tree = document.querySelector('.scene-tree')
      if (!row || !tree) return null
      const b = row.getBoundingClientRect()
      const t = tree.getBoundingClientRect()
      return { inDom: true, onScreen: b.bottom > t.top && b.top < t.bottom, selected: row.className.includes('selected') }
    }, lastId)
    check('selecting the LAST part renders its row', rowBox?.inDom === true, rowBox ? '' : 'row not in the DOM')
    check('...and scrolls it on screen', rowBox?.onScreen === true)
    check('...and it reads as selected', rowBox?.selected === true)
    check('...without blowing the row budget', afterSelect.rows <= ROW_CEILING, `${afterSelect.rows} rows`)

    // --- behaviour: scrolling to the bottom renders the tail of the list ---
    await page.evaluate(() => { document.querySelector('.scene-tree').scrollTop = 1e6 })
    await page.waitForTimeout(400)
    const atBottom = await treeShape(page)
    check('scrolled to the bottom, rows still render', atBottom.rows > 0 && atBottom.onScreen > 0, `${atBottom.rows} rows, ${atBottom.onScreen} on screen`)
    check('bottom of the list holds the LAST part', atBottom.ids.includes(lastId), `last id ${lastId}`)
    await page.evaluate(() => { document.querySelector('.scene-tree').scrollTop = 0 })
    await page.waitForTimeout(300)

    // --- the invariant: duplicating the scene must not grow the panel's DOM ---
    const grown = await page.evaluate(async () => {
      const store = window.__oip.store
      const before = store.getState().scene.parts.length
      store.selectMany(store.getState().scene.parts.filter((p) => p.type === 'part').map((p) => p.id))
      store.duplicateSelection()
      store.clearSelection()
      await new Promise((r) => setTimeout(r, 2500))
      return { before, after: store.getState().scene.parts.length }
    })
    await page.waitForTimeout(2500)
    const dup = await treeShape(page)
    check('duplicate grew the scene', grown.after > grown.before * 1.5, `${grown.before} → ${grown.after} parts`)
    check(
      'duplicating the scene did NOT grow the tree DOM',
      dup.rows <= base.rows + 2 && dup.nodes <= base.nodes * 1.15,
      `rows ${base.rows} → ${dup.rows}, nodes ${base.nodes} → ${dup.nodes}`,
    )
    check('scroll extent grew with the scene', dup.scrollH > base.scrollH * 1.5, `${base.scrollH} → ${dup.scrollH}`)

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  return failures === 0 ? 0 : 1
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2) })
