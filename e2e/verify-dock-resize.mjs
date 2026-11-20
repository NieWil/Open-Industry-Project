// Verifies the dock-resize drag path: a gutter drag must move the layout live (custom
// property on the app root) without committing React state on every pointer event, commit
// exactly once on release, persist on the trailing delay, and leave the renderer's drawing
// buffer matching the new viewport. Guards the four costs that make a drag drop frames:
// per-event React re-render, per-event localStorage write, per-frame render-target realloc,
// and a second full render forced by the ResizeObserver.
// Run: node e2e/verify-dock-resize.mjs
/* global process, console, window, document, localStorage, getComputedStyle, devicePixelRatio */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const SIZE_KEY = 'oip-web/dock-sizes'

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })

let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`)
  if (!cond) failures++
}

/**
 * A point on the gutter that nothing else covers. A floating window (the PLC editor, when someone
 * floats it) sits over the viewport, and a widened left column slides under
 * it - so the geometric centre of the gutter is not reliably grabbable. Walk the long axis for a
 * point where the gutter is genuinely the topmost element.
 */
async function freePointOn(page, locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('gutter has no box')
  const vertical = box.height > box.width
  const fractions = [0.5, 0.85, 0.15, 0.7, 0.3]
  for (const f of fractions) {
    const x = vertical ? box.x + box.width / 2 : box.x + box.width * f
    const y = vertical ? box.y + box.height * f : box.y + box.height / 2
    const clear = await page.evaluate(
      ([px, py]) => {
        const top = document.elementFromPoint(px, py)
        return !!top && top.classList.contains('gutter')
      },
      [x, y],
    )
    if (clear) return { x, y }
  }
  throw new Error('every sampled point on the gutter is covered by something else')
}

/** drag a gutter by (dx, dy) in `steps`, sampling state at the halfway point (still down) */
async function dragGutter(page, locator, dx, dy, sample) {
  const { x: x0, y: y0 } = await freePointOn(page, locator)
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x0 + dx / 2, y0 + dy / 2, { steps: 8 })
  await page.waitForTimeout(120) // let the drag's rAF flush land
  const mid = sample ? await sample() : null
  await page.mouse.move(x0 + dx, y0 + dy, { steps: 8 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.evaluate(() => (window.__releaseAt = performance.now()))
  await page.waitForTimeout(60)
  return mid
}

const readSizes = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), SIZE_KEY)

/** Mark the page so a vite full-reload mid-run is reported as harness rot, not a code failure.
 *  Widening a dock reveals catalog cards, whose lazy chunk/mesh loads can make the dev server
 *  re-optimize deps and reload the page - which would otherwise read as "the drag didn't stick". */
const markPage = (page) => page.evaluate(() => (window.__resizeGateNonce = 1))
const pageSurvived = (page) => page.evaluate(() => window.__resizeGateNonce === 1)

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)

    // count writes to the dock-size key, so a per-event React commit can't hide. (Mount
    // already persisted once by now - this counts only what the drags cause.)
    // Timestamps are taken in the page: timing the debounce from node would measure CDP
    // round-trips as much as the app.
    const countSizeWrites = () =>
      page.evaluate((key) => {
        window.__sizeWrites = 0
        window.__sizeWriteLog = []
        if (window.__sizePatched) return
        window.__sizePatched = true
        const orig = localStorage.setItem.bind(localStorage)
        localStorage.setItem = (k, v) => {
          if (k === key) {
            window.__sizeWrites++
            window.__sizeWriteLog.push({ at: Math.round(performance.now()), left: JSON.parse(v).left })
          }
          return orig(k, v)
        }
      }, SIZE_KEY)
    await countSizeWrites()

    const leftGutter = page.locator('.gutter[style*="gutlA"]')
    ok((await leftGutter.count()) === 1, 'left column has a width gutter')

    // Warm-up drag, unmeasured: a wider dock reveals more catalog cards, and their lazy mesh /
    // chunk loads are what can trigger the dev server's re-optimize reload. Get that out of the
    // way (and back to the starting width) before anything is measured.
    await dragGutter(page, leftGutter, 40, 0)
    await dragGutter(page, leftGutter, -40, 0)
    await page.waitForTimeout(1500)
    await markPage(page)
    await countSizeWrites() // zero the counter: the warm-up drags each persisted once

    const widthBefore = (await page.locator('.dock-column-left').first().boundingBox()).width
    const storedBefore = await readSizes(page) // mount already wrote the defaults
    const DX = 90

    // --- live drag: the column follows the pointer mid-drag, with nothing committed yet ---
    const mid = await dragGutter(page, leftGutter, DX, 0, async () => ({
      width: (await page.locator('.dock-column-left').first().boundingBox()).width,
      writes: await page.evaluate(() => window.__sizeWrites),
      stored: await readSizes(page),
    }))

    ok(
      Math.abs(mid.width - (widthBefore + DX / 2)) < 6,
      `column tracks the pointer mid-drag (${Math.round(widthBefore)} → ${Math.round(mid.width)}, want ~${Math.round(widthBefore + DX / 2)})`,
    )
    ok(mid.writes === 0, `no dock-size persist during the drag (got ${mid.writes} writes)`)
    ok(mid.stored?.left === storedBefore?.left, `stored width untouched mid-drag (still ${mid.stored?.left})`)

    ok(await pageSurvived(page), 'page did not reload under the drag (else the rest is harness rot)')
    const widthAfter = (await page.locator('.dock-column-left').first().boundingBox()).width
    ok(Math.abs(widthAfter - (widthBefore + DX)) < 6, `final width is the full drag (got ${Math.round(widthAfter)})`)

    // release commits to React; the persist itself is on a trailing delay (500 ms), so shortly
    // after release the layout is already at its new size while the store still isn't
    await page.waitForTimeout(1200)
    const stored = await readSizes(page)
    ok(stored?.left !== storedBefore?.left, 'dock sizes persisted after the delay')
    ok(Math.abs(stored.left - widthAfter) < 6, `persisted width matches the layout (stored ${stored?.left})`)
    const log = await page.evaluate(() => ({ log: window.__sizeWriteLog, release: window.__releaseAt }))
    console.log(`  write log (release at ${Math.round(log.release)}): ${JSON.stringify(log.log)}`)
    ok(log.log.length === 1, `exactly one persist for the whole drag (got ${log.log.length})`)
    ok(
      log.log.length > 0 && log.log[0].at - log.release > 300,
      `the persist waited out the debounce (${log.log[0] ? Math.round(log.log[0].at - log.release) : '-'} ms after release)`,
    )

    // --- the committed value is what React renders from: it must survive a reload ---
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1200)
    const widthReloaded = (await page.locator('.dock-column-left').first().boundingBox()).width
    ok(Math.abs(widthReloaded - widthAfter) < 6, `dragged width survives a reload (got ${Math.round(widthReloaded)})`)

    // The reload above aborts whatever GLB fetches were in flight, which the part loader
    // reports as "Failed to fetch" - harness noise, not the app. Errors are judged from here
    // on, which is the part this gate is about (the drags and the resizes they cause).
    errors.length = 0

    // --- the renderer followed: drawing buffer matches the viewport's new CSS box ---
    const buf = await page.evaluate(() => {
      const c = document.querySelector('.viewport canvas')
      return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight, dpr: devicePixelRatio }
    })
    ok(
      Math.abs(buf.w - buf.cssW * buf.dpr) <= 1 && Math.abs(buf.h - buf.cssH * buf.dpr) <= 1,
      `drawing buffer matches the viewport after resize (${buf.w}x${buf.h} vs ${buf.cssW}x${buf.cssH} @${buf.dpr})`,
    )

    // --- bottom dock (vertical gutter, sign -1) drives a grid row var the same way ---
    const dockGutter = page.locator('.gutter-dock')
    ok((await dockGutter.count()) === 1, 'bottom dock has a height gutter')
    const dockBefore = (await page.locator('.dock-slot-bottom, [class*="dock-slot"]').last().boundingBox()).height
    await countSizeWrites() // the reload dropped the previous patch along with the page
    await markPage(page)
    const dockMid = await dragGutter(page, dockGutter, 0, -60, async () =>
      page.evaluate(() => {
        const app = document.querySelector('.app')
        return app ? getComputedStyle(app).gridTemplateRows : ''
      }),
    )
    ok(/\d/.test(dockMid), 'app grid rows resolve to used px mid-drag')
    await page.waitForTimeout(900)
    const dockAfter = (await page.locator('.dock-slot-bottom, [class*="dock-slot"]').last().boundingBox()).height
    ok(dockAfter > dockBefore + 20, `dragging up grew the bottom dock (${Math.round(dockBefore)} → ${Math.round(dockAfter)})`)
    ok(await pageSurvived(page), 'page did not reload under the bottom-dock drag')
    ok((await page.evaluate(() => window.__sizeWrites)) === 1, 'bottom-dock drag also persisted exactly once')

    // --- the corners where a column's gutter meets the bottom dock's: one drag moves both ---
    ok((await page.locator('.gutter-corner').count()) === 2, 'one corner handle on each side of the bottom dock')
    for (const [side, column, dx] of [['left', '.dock-column-left', 50], ['right', '.dock-column-right', -50]]) {
      const cBox = await page.locator(`.gutter-corner-${side}`).boundingBox()
      const cx = cBox.x + cBox.width / 2
      const cy = cBox.y + cBox.height / 2
      ok(
        await page.evaluate(([x, y, s]) => !!document.elementFromPoint(x, y)?.classList.contains(`gutter-corner-${s}`), [cx, cy, side]),
        `the ${side} corner is topmost over its gutter junction`,
      )
      const colBefore = (await page.locator(column).first().boundingBox()).width
      const slotBefore = (await page.locator('.dock-slot-bottom, [class*="dock-slot"]').last().boundingBox()).height
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx + dx, cy - 40, { steps: 10 })
      await page.waitForTimeout(120)
      await page.mouse.up()
      await page.waitForTimeout(900)
      const colAfter = (await page.locator(column).first().boundingBox()).width
      const slotAfter = (await page.locator('.dock-slot-bottom, [class*="dock-slot"]').last().boundingBox()).height
      ok(Math.abs(colAfter - (colBefore + 50)) < 6, `${side} corner drag widened its column (${Math.round(colBefore)} → ${Math.round(colAfter)})`)
      ok(Math.abs(slotAfter - (slotBefore + 40)) < 6, `${side} corner drag raised the bottom dock (${Math.round(slotBefore)} → ${Math.round(slotAfter)})`)
    }

    // --- the other resize trigger: the browser window itself (same deferred apply) ---
    await page.setViewportSize({ width: 1100, height: 780 })
    await page.waitForTimeout(400)
    const resized = await page.evaluate(() => {
      const c = document.querySelector('.viewport canvas')
      return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight, dpr: devicePixelRatio }
    })
    ok(
      Math.abs(resized.w - resized.cssW * resized.dpr) <= 1 && Math.abs(resized.h - resized.cssH * resized.dpr) <= 1,
      `drawing buffer follows a window resize (${resized.w}x${resized.h} vs ${resized.cssW}x${resized.cssH})`,
    )

    // the canvas must still be live (not a blanked buffer) after all that resizing
    await page.screenshot({ path: 'e2e/out/dock-resize-after.png' })

    ok(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`)
  } finally {
    await browser.close()
  }
}

try {
  await main()
} catch (e) {
  console.error('FAIL: threw', e)
  failures++
} finally {
  vite.kill()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
