// Verify the scene-tree dock's guards, in a real browser. Each phase guards a bug that shipped:
//   1. Picking a part in the viewport opens its collapsed parents, and collapsing one again sticks.
//      F2 on a part under a collapsed parent opens the path and renames it.
//      Otherwise a rename opens with no input to type into, and since every row handler is disabled
//      while a rename is open, the tree ignores clicks until a reload.
//   2. F2 on a part the dock can't show (filtered out) leaves the tree clickable.
//   3. Right-clicking an eye opens the row menu without hiding the part (pointerdown fires for every
//      button, so an eye that toggles on any of them hides it). And the filter finds an unnamed part by
//      the numbered label its row shows ("Box 2").
//   4. Filtering while scrolled deep in a long tree mounts the matches at once, rather than the window
//      starting past the shrunken list and the dock staying blank while the browser moves scrollTop
//      back one viewport per frame.
//   5. Inside an opened part scene ("Open Part Editor"), "Unparent" and a drop on the tree's empty space keep
//      the part in the session (under the opened part). Moving it to the scene root would make it vanish
//      from the dock, which shows only the opened part's subtree.
// The store-level logic is unit-tested (store.test.ts, treeNode.test.ts, sceneTreeWindow.test.ts);
// this checks the dock actually calls through it.
// Run: node e2e/verify-scene-tree-guards.mjs [--headed] [--only=1,5]
/* global process, console, window, document, HTMLInputElement, Event, performance, requestAnimationFrame */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
}

/** a fresh app (no view state carried between phases - a stuck rename would otherwise leak into the next) */
async function fresh(page) {
  await page.reload()
  await waitForApp(page)
  await page.waitForTimeout(500)
}

/** a Cell group holding one named box, two unnamed boxes at the root, and `fillers` named groups */
async function loadScene(page, fillers = 0) {
  const ok = await page.evaluate((n) => {
    const st = window.__oip.store
    const pkg = window.__oip.getPackage('oip.box')
    if (!pkg) return false
    const params = Object.fromEntries(Object.entries(pkg.params ?? {}).map(([k, s]) => [k, s.default]))
    const box = (id, extra) => ({ id, type: 'part', packageId: 'oip.box', position: [0, 0.2, 0], rotationY: 0, params, ...extra })
    const grp = (id, extra) => ({ id, type: 'group', position: [0, 0, 0], rotationY: 0, params: {}, ...extra })
    const parts = [grp('g_cell', { name: 'Cell' }), box('b_inner', { name: 'Inner', parent: 'g_cell' }), box('b_1', {}), box('b_2', {})]
    for (let i = 0; i < n; i++) parts.push(grp(`g_fill${i}`, { name: `Filler ${i}` }))
    st.loadScene({ version: st.getState().scene.version, parts }, { persist: false })
    return true
  }, fillers)
  check(`scene loaded (${fillers} fillers)`, ok)
  await page.waitForTimeout(400)
}

const state = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { selectedIds: s.selectedIds, parts: s.scene.parts.map((p) => ({ id: p.id, name: p.name, parent: p.parent, visible: p.visible })) }
  })
const rowNames = (page) => page.$$eval('.scene-tree .tree-row .tree-name', (els) => els.map((e) => e.textContent))
/** the viewport centre of the first element matching `selector`, or null */
const centreOf = (page, selector) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }, selector)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => {
      window.localStorage.clear()
      window.localStorage.setItem('oip-web/tutorial-done', '1')
    })

    // each phase starts from a fresh app and fails on its own: a throw is that phase's FAIL, not the run's
    const phase = async (n, title, body) => {
      if (ONLY && !ONLY.includes(String(n))) return
      console.log(`--- ${n}. ${title}`)
      try {
        await fresh(page)
        await body()
      } catch (e) {
        check(`phase ${n} ran to completion`, false, String(e).split('\n')[0])
      }
    }

    await phase(1, 'F2 under a collapsed parent', async () => {
      await loadScene(page)
      await page.click('.tree-row[data-row-id="g_cell"] .tree-caret')
      await page.waitForTimeout(150)
      check('collapsing the Cell hides its child row', (await page.locator('.tree-row[data-row-id="b_inner"]').count()) === 0)
      await page.evaluate(() => window.__oip.store.select('b_inner')) // a viewport pick
      await page.waitForTimeout(150)
      check('a viewport pick opens its collapsed parent', (await page.locator('.tree-row[data-row-id="b_inner"]').count()) === 1)
      // collapsing the parent of the current selection must stick (the expansion runs once per pick)
      await page.click('.tree-row[data-row-id="g_cell"] .tree-caret')
      await page.waitForTimeout(150)
      check('...and a later collapse with it still selected stays collapsed', (await page.locator('.tree-row[data-row-id="b_inner"]').count()) === 0)
      await page.evaluate(() => document.activeElement?.blur())
      await page.keyboard.press('F2')
      await page.waitForTimeout(250)
      check('F2 reveals the row and opens its rename input', (await page.locator('.tree-row[data-row-id="b_inner"] .tree-rename').count()) === 1)
      await page.keyboard.press('Control+A')
      await page.keyboard.type('Renamed')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(200)
      let s = await state(page)
      check('the rename lands', s.parts.find((p) => p.id === 'b_inner')?.name === 'Renamed', JSON.stringify(s.parts.find((p) => p.id === 'b_inner')))
      await page.click('.tree-row[data-row-id="b_1"] .tree-name')
      await page.waitForTimeout(150)
      s = await state(page)
      check('the tree still takes clicks afterwards', JSON.stringify(s.selectedIds) === '["b_1"]', JSON.stringify(s.selectedIds))
    })

    await phase(2, 'F2 on a filtered-out part', async () => {
      await loadScene(page)
      await page.fill('.scene-filter', 'inner')
      await page.waitForTimeout(150)
      await page.evaluate(() => window.__oip.store.select('b_1')) // not in the filtered list
      await page.evaluate(() => document.activeElement?.blur())
      await page.keyboard.press('F2')
      await page.waitForTimeout(250)
      check('F2 on a hidden row opens no input', (await page.locator('.tree-rename').count()) === 0)
      await page.click('.tree-row[data-row-id="b_inner"] .tree-name')
      await page.waitForTimeout(150)
      const s = await state(page)
      check('...and leaves the tree clickable', JSON.stringify(s.selectedIds) === '["b_inner"]', JSON.stringify(s.selectedIds))
    })

    await phase(3, 'eye right-click, and the filter by numbered label', async () => {
      await loadScene(page)
      await page.click('.tree-row[data-row-id="b_2"] .tree-eye', { button: 'right' })
      await page.waitForTimeout(200)
      let s = await state(page)
      check('right-clicking an eye leaves the part visible', s.parts.find((p) => p.id === 'b_2')?.visible !== false)
      check('...and opens the row menu', (await page.locator('.context-menu').count()) === 1)
      await page.keyboard.press('Escape')
      // the primary button still toggles it (the guard must not have disabled the eye)
      await page.click('.tree-row[data-row-id="b_2"] .tree-eye')
      await page.waitForTimeout(150)
      s = await state(page)
      check('a left-click on the eye still hides it', s.parts.find((p) => p.id === 'b_2')?.visible === false)

      // the filter, by the numbered label the row shows
      const labels = await rowNames(page)
      check('unnamed boxes read "Box" and "Box 2"', labels.includes('Box') && labels.includes('Box 2'), JSON.stringify(labels))
      await page.fill('.scene-filter', 'box 2')
      await page.waitForTimeout(200)
      const filtered = await rowNames(page)
      check('filtering "box 2" finds that row', JSON.stringify(filtered) === '["Box 2"]', JSON.stringify(filtered))
    })

    await phase(4, 'filter while scrolled deep', async () => {
      await loadScene(page, 600)
      await page.evaluate(() => {
        const el = document.querySelector('.scene-tree')
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(300)
      const deep = await page.evaluate(() => document.querySelector('.scene-tree').scrollTop)
      check('scrolled deep before filtering', deep > 5000, `scrollTop=${deep}`)
      const frames = await page.evaluate(async () => {
        const input = document.querySelector('.scene-filter')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'inner')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const el = document.querySelector('.scene-tree')
        const out = []
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => requestAnimationFrame(r))
          const row = el.querySelector('.tree-row')
          const box = row?.getBoundingClientRect()
          const view = el.getBoundingClientRect()
          out.push({ rows: el.querySelectorAll('.tree-row').length, onScreen: !!box && box.bottom > view.top && box.top < view.bottom, t: Math.round(performance.now()) })
        }
        return out
      })
      check('the match is mounted on the first frame after filtering', frames[0].rows === 1, JSON.stringify(frames))
      check('...and on screen by the second', frames.slice(1).every((f) => f.rows === 1 && f.onScreen), JSON.stringify(frames))
    })

    await phase(5, 'open part scene: Unparent + empty-space drop stay inside the session', async () => {
      const setup = await page.evaluate(() => {
        const st = window.__oip.store
        const pkg = window.__oip.getPackage('oip.box')
        const params = Object.fromEntries(Object.entries(pkg.params ?? {}).map(([k, s]) => [k, s.default]))
        const box = (id, name, x, parent) => ({ id, type: 'part', packageId: 'oip.box', name, parent, position: [x, 0.2, 0], rotationY: 0, params })
        st.loadScene(
          { version: st.getState().scene.version, parts: [box('b_host', 'Host', 0), box('b_a', 'Alpha', 1, 'b_host'), box('b_b', 'Beta', 2, 'b_a')], packages: [pkg] },
          { persist: false },
        )
        window.__oip.controller.openPartScene('b_host')
        if (st.getState().focusedPartId !== 'b_host') return null
        return { root: 'b_host', alpha: 'b_a', beta: 'b_b' }
      })
      check('part scene opened', !!setup, JSON.stringify(setup))
      if (!setup) return
      await page.waitForTimeout(400)
      const session = () =>
        page.evaluate(({ beta }) => {
          const s = window.__oip.store.getState()
          return {
            betaParent: s.scene.parts.find((p) => p.id === beta)?.parent,
            betaRow: !!document.querySelector(`.tree-row[data-row-id="${beta}"]`),
          }
        }, setup)
      const betaRow = `.tree-row[data-row-id="${setup.beta}"] .tree-name`

      // Real pointer input at coordinates: a session renders at well under 1 fps headless, and locator
      // actions wait on animation frames to scroll their target into view, so they time out.
      const at = await centreOf(page, betaRow)
      await page.mouse.click(at.x, at.y, { button: 'right' })
      await page.waitForSelector('.context-menu')
      const unparent = await page.evaluate(() => {
        const item = [...document.querySelectorAll('.context-menu .context-item')].find((b) => b.firstChild?.textContent === 'Unparent')
        if (!item || item.disabled) return null
        const r = item.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      check('the menu offers an enabled Unparent', !!unparent)
      if (unparent) await page.mouse.click(unparent.x, unparent.y)
      await page.waitForTimeout(250)
      let m = await session()
      check('menu Unparent lifts to the opened part', m.betaParent === setup.root, JSON.stringify(m))
      check('...and keeps the row in the dock', m.betaRow)

      // nest it again, then drag it onto the tree's empty space
      await page.evaluate(({ alpha, beta }) => window.__oip.store.reparent([beta], alpha), setup)
      await page.waitForTimeout(400)
      m = await session()
      check('re-nested under Alpha before the drag (so the drop has something to prove)', m.betaParent === setup.alpha, JSON.stringify(m))
      const from = await centreOf(page, betaRow)
      const drop = await page.evaluate(() => {
        const r = document.querySelector('.scene-tree').getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.bottom - 12 }
      })
      const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, drop)
      check('the drop point is the tree itself (empty space)', under === 'scene-tree', String(under))
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 })
      await page.mouse.move(drop.x, drop.y, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      m = await session()
      check('an empty-space drop lifts to the opened part', m.betaParent === setup.root, JSON.stringify(m))
      check('...and keeps the row in the dock', m.betaRow)
    })

    check('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
}

await main()
process.exit(failed ? 1 : 0)
