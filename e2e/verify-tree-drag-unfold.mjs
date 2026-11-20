// A collapsed scene-tree row opens when a drag is held inside it, so the drop can go among its children.
//
// HTML5 drag and drop can't be driven by mouse.move in headless, so this dispatches DragEvents sharing one
// DataTransfer, as verify-dock-dnd.mjs does.
//  1. a short pass over a collapsed row leaves it collapsed (control)
//  2. holding the drag inside it opens it
//  3. the drop then lands among its children
// Run: node e2e/verify-tree-drag-unfold.mjs [--headed]
/* global process, console, window, document, localStorage, DataTransfer, DragEvent */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const ROLLER = 'oip.roller-conveyor'

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const rowShown = (page, id) => page.locator(`.tree-row[data-row-id="${id}"]`).count().then((n) => n > 0)

/** Fire one drag event on a tree row, at a fraction of its height (0.5 = the drop-inside band). */
const fire = (page, id, type, frac = 0.5) =>
  page.evaluate(([rowId, kind, f]) => {
    const el = document.querySelector(`.tree-row[data-row-id="${rowId}"]`)
    if (!el) return false
    window.__dt ??= new DataTransfer()
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new DragEvent(kind, { dataTransfer: window.__dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + r.height * f }))
    return true
  }, [id, type, frac])

/** Hold a drag over a row for `ms`, as the browser does: a dragover every 50 ms. */
async function hold(page, id, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    await fire(page, id, 'dragover')
    await page.waitForTimeout(50)
  }
}

const browser = await chromium.launch({ headless: !HEADED })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
try {
  await page.goto(URL)
  const ready = () => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), null, { timeout: 60000 })
  await ready()
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
  await page.reload()
  await ready()

  const loaded = await page.evaluate((pkgId) => {
    const { store, getPackage } = window.__oip
    const pkg = getPackage(pkgId)
    if (!pkg) return `no ${pkgId} package`
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
    const part = (id, x, parent) => ({ id, type: 'part', packageId: pkgId, position: [x, 0, 0], rotationY: 0, name: id, params: { ...params }, ...(parent ? { parent } : {}) })
    store.loadScene({ version: store.getState().scene.version, parts: [part('host', 0), part('child', 0, 'host'), part('loose', 6)], packages: [pkg] })
    return 'ok'
  }, ROLLER)
  check('scene loaded: a parent with one child, and a loose part', loaded === 'ok', loaded)
  await page.locator('.tree-row[data-row-id="host"]').first().waitFor({ timeout: 15000 })
  check('the child row shows while its parent is open', await rowShown(page, 'child'))

  await page.locator('.tree-row[data-row-id="host"] .tree-caret').first().click()
  await page.waitForTimeout(150)
  check('collapsing the parent hides the child row', !(await rowShown(page, 'child')))

  // 1. control: a pass shorter than the hold time, then on to empty tree space
  await fire(page, 'loose', 'dragstart')
  await hold(page, 'host', 150)
  await fire(page, 'loose', 'dragend')
  await page.waitForTimeout(800)
  check('a short pass over the collapsed row leaves it collapsed', !(await rowShown(page, 'child')))

  // 2. the hold opens it
  await fire(page, 'loose', 'dragstart')
  await hold(page, 'host', 900)
  check('holding the drag inside the collapsed row opens it', await rowShown(page, 'child'))

  // 3. the drop goes among the children: after the child, inside the same parent
  await fire(page, 'child', 'dragover', 0.9)
  await fire(page, 'child', 'drop', 0.9)
  await fire(page, 'loose', 'dragend')
  await page.waitForTimeout(200)
  const scene = await page.evaluate(() => window.__oip.store.getState().scene.parts.map((p) => ({ id: p.id, parent: p.parent ?? null })))
  const order = scene.map((p) => p.id).join(',')
  check('the dragged part lands after the child, under the same parent', scene.find((p) => p.id === 'loose')?.parent === 'host' && order.indexOf('child') < order.indexOf('loose'), JSON.stringify(scene))

  // a dragged row does not open itself
  await page.locator('.tree-row[data-row-id="host"] .tree-caret').first().click()
  await page.waitForTimeout(150)
  await page.evaluate(() => { window.__dt = undefined })
  await fire(page, 'host', 'dragstart')
  await hold(page, 'host', 900)
  await fire(page, 'host', 'dragend')
  check('a row held over itself stays collapsed', !(await rowShown(page, 'child')))

  check('no page errors', errors.length === 0, errors[0] ?? '')
} finally {
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
  await browser.close()
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
