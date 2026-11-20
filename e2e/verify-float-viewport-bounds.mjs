// Verify the floating PLC window stays inside the 3D view and never covers a dock.
//
// Kept inside only the browser window, it breaks: at 1366x768 the default window hangs 32 px onto the bottom dock,
// a header drag can park it almost entirely over the dock, and nothing re-checks it when the view changes size.
// The rule lives in fitStEditorGeometry (src/editor/program/stProgram.ts) and the area it fits into in StEditor's
// floatBounds: the view below its spatial toolbar, which draws above the window (a header parked under
// it cannot be grabbed, and fitting to the whole view does exactly that to the default window). This drives every
// path that can move the window against the real layout:
//   - a fresh load with the default rect (the reported overlap),
//   - a header drag and a grip resize aimed far past each edge (they stop at the edge, not short of it),
//   - a collapsed title bar parked at the bottom, then expanded (must not open onto the dock),
//   - the view shrinking under a parked window, once from a dock (the bottom dock rolling back open) and once from
//     the browser window.
// After every step the header must still be grabbable: the point at its centre hits the window, nothing on top.
//
// Run: node e2e/verify-float-viewport-bounds.mjs [--headed]      (OIP_SHOT_DIR=<dir> also saves a final shot)
/* global process, console, window, document, localStorage, requestAnimationFrame */
import { startServer } from './_server.mjs'
import { FLOATING_PLC_LAYOUT } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SHOT = process.env.OIP_SHOT_DIR ? `${process.env.OIP_SHOT_DIR}/float-viewport-bounds.png` : null

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const FLOAT = '[data-floating="st"]'
const HEADER = `${FLOAT} > div[title^="Drag to move"]`
const GRIP = `${FLOAT} div[title="Drag to resize"]`

/**
 * After two frames (a gesture's state and any ResizeObserver re-fit have both landed): the window `f`, the view `v`,
 * the area the window may use `a` (the view below its toolbar), how far the window reaches into any dock slot, and
 * whether the header's centre hits the window.
 */
async function settled(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return page.evaluate((sel) => {
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
    }
    const float = document.querySelector(sel)
    const view = document.querySelector('.viewport')
    if (!float || !view) return null
    const f = rect(float)
    const v = rect(view)
    const barEl = view.querySelector('.viewport-toolbar-wrap')
    const bar = barEl && rect(barEl)
    const top = bar && bar.h > 0 ? bar.b + (bar.y - v.y) : v.y
    const a = { x: v.x, y: top, r: v.r, b: v.b, w: v.w, h: v.b - top }
    let dockOverlap = 0
    for (const slot of document.querySelectorAll('.dock-slot')) {
      const d = rect(slot)
      const ox = Math.min(f.r, d.r) - Math.max(f.x, d.x)
      const oy = Math.min(f.b, d.b) - Math.max(f.y, d.y)
      if (ox > 0 && oy > 0) dockOverlap = Math.max(dockOverlap, Math.round(ox * oy))
    }
    const head = float.firstElementChild.getBoundingClientRect()
    const hit = document.elementFromPoint(head.left + head.width / 2, head.top + head.height / 2)
    return { f, v, a, dockOverlap, grabbable: !!hit && float.contains(hit), hitClass: hit?.className?.toString?.() ?? '' }
  }, FLOAT)
}

const inside = (m) => !!m && m.f.x >= m.a.x - 0.5 && m.f.y >= m.a.y - 0.5 && m.f.r <= m.a.r + 0.5 && m.f.b <= m.a.b + 0.5
const near = (p, q) => Math.abs(p - q) <= 1
const fmt = (m) => {
  if (!m) return 'no window'
  const n = Math.round
  return (
    `window ${n(m.f.x)},${n(m.f.y)} ${n(m.f.w)}x${n(m.f.h)}; area ${n(m.a.x)},${n(m.a.y)}..${n(m.a.r)},${n(m.a.b)}; ` +
    `dock overlap ${m.dockOverlap}px²${m.grabbable ? '' : `; header covered by .${m.hitClass}`}`
  )
}

/** press on an element's centre, move by (dx, dy) in steps, release - raw mouse, not locator actions */
async function dragBy(page, selector, dx, dy) {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`nothing to drag at ${selector}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 6 })
  await page.mouse.up()
}

/** a press with no movement: the header's collapse toggle */
async function tap(page, selector) {
  const box = await page.locator(selector).first().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** the checks every step makes: inside the area, off the docks, header reachable */
function checkPlaced(label, m) {
  check(`${label}: inside the view, below its toolbar`, inside(m), fmt(m))
  check(`${label}: covers no dock`, m?.dockOverlap === 0, fmt(m))
  check(`${label}: header still grabbable`, !!m?.grabbable, fmt(m))
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store), null, { timeout: 30000 })
    await page.evaluate((layout) => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
      localStorage.setItem('oip-web/dock-layout', layout)
    }, FLOATING_PLC_LAYOUT)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction((sel) => !!document.querySelector(`${sel} .cm-content`), FLOAT, { timeout: 30000 })
    // the loading cover lifts on its own schedule; a drag under it would be a test of the cover
    await page.waitForFunction(() => !document.querySelector('.viewport-cover:not(.ready)'), null, { timeout: 90000 }).catch(() => {})

    // ── the default rect, fresh load: the reported 32 px overlap ──────────────────────────
    check('a bottom dock is on screen (the thing the window must not cover)', (await page.locator('.dock-slot-bottom').count()) === 1)
    let m = await settled(page)
    checkPlaced('default window', m)

    // ── drag far past each corner: it stops at the edge ───────────────────────────────────
    await dragBy(page, HEADER, 900, 900)
    m = await settled(page)
    checkPlaced('dragged past the bottom-right', m)
    check('...flush with the bottom and right edges (stopped at the edge, not short of it)', !!m && near(m.f.b, m.a.b) && near(m.f.r, m.a.r), fmt(m))
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/st-editor-geometry') || 'null'))
    check('the drag saved the rect it ended at', !!stored && !!m && near(stored.x, m.f.x) && near(stored.y, m.f.y), JSON.stringify(stored))

    await dragBy(page, HEADER, -2000, -2000)
    m = await settled(page)
    checkPlaced('dragged past the top-left', m)
    check('...parked in the corner under the toolbar', !!m && near(m.f.x, m.a.x) && near(m.f.y, m.a.y), fmt(m))

    // ── resize past the bottom-right, then below the minimum ──────────────────────────────
    await dragBy(page, GRIP, 3000, 3000)
    m = await settled(page)
    checkPlaced('grip pulled past the bottom-right', m)
    check('...fills the area exactly (the grip stops at the edges)', !!m && Math.abs(m.f.w - m.a.w) <= 2 && Math.abs(m.f.h - m.a.h) <= 2, fmt(m))
    await dragBy(page, GRIP, -3000, -3000)
    m = await settled(page)
    check('shrinking stops at the minimum size', !!m && Math.round(m.f.w) === 280 && Math.round(m.f.h) === 220, fmt(m))

    // ── collapsed title bar parked at the bottom, then expanded ───────────────────────────
    await tap(page, HEADER)
    await page.waitForFunction((sel) => !document.querySelector(`${sel} div[title="Drag to resize"]`), FLOAT, { timeout: 8000 })
    await dragBy(page, HEADER, 0, 2000)
    m = await settled(page)
    checkPlaced('collapsed and dragged down', m)
    check('...its title bar sits at the very bottom of the view', !!m && near(m.f.b, m.a.b) && m.f.h < 60, fmt(m))
    await tap(page, HEADER)
    await page.waitForFunction((sel) => !!document.querySelector(`${sel} div[title="Drag to resize"]`), FLOAT, { timeout: 8000 })
    m = await settled(page)
    checkPlaced('expanded at the bottom', m)
    check('...it opened upward at full height', !!m && Math.round(m.f.h) === 220 && near(m.f.b, m.a.b), fmt(m))

    // ── the view shrinks under a parked window: a dock rolling open ───────────────────────
    // Roll the bottom dock up (click its front tab), park the window at the bottom of the now-taller view, roll the
    // dock back open: the view gets shorter and the window must follow it up.
    const frontTab = '.dock-slot-bottom .dock-slot-tab.active'
    await page.evaluate((sel) => document.querySelector(sel)?.click(), frontTab)
    await page.waitForFunction(() => !!document.querySelector('.dock-slot-bottom.collapsed'), null, { timeout: 8000 })
    await dragBy(page, HEADER, 0, 2000)
    const tall = await settled(page)
    check('with the dock rolled up the window parks lower', !!tall && near(tall.f.b, tall.a.b), fmt(tall))
    await page.evaluate((sel) => document.querySelector(sel)?.click(), frontTab)
    await page.waitForFunction(() => !document.querySelector('.dock-slot-bottom.collapsed'), null, { timeout: 8000 })
    m = await settled(page)
    check('the view got shorter when the dock reopened', !!tall && !!m && m.v.b < tall.v.b - 50, `view bottom ${tall && Math.round(tall.v.b)} -> ${m && Math.round(m.v.b)}`)
    checkPlaced('after the dock reopened under it', m)

    // ── the view shrinks under a parked window: the browser window ────────────────────────
    await page.setViewportSize({ width: 1100, height: 640 })
    m = await settled(page)
    checkPlaced('after the browser window shrank', m)

    if (SHOT) await page.screenshot({ path: SHOT })
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  vite.kill()
  process.exit(1)
})
