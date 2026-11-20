// Verify the side-dock fold: clicking the front tab of a side column folds the column to a rail of
// vertical tabs (viewport reclaims the width, width gutter gone, no ▾ / ⛶ on the rail), right-click on
// a rail tab opens the move menu without opening the column, and clicking a rail tab opens the column
// at its old width with that tab in front.
// Run: node e2e/verify-side-dock-fold.mjs [--headed]
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

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

async function metrics(page) {
  return page.evaluate(() => {
    const col = document.querySelector('.dock-column-left')
    const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0)
    const tab = col?.querySelector('.dock-slot-tab')
    return {
      colW: w(col),
      canvasW: w(document.querySelector('canvas')),
      folded: !!col?.classList.contains('collapsed'),
      hasContent: !!col?.querySelector('.dock-slot-content'),
      // the left column's width gutter is the first gutter after it in the grid
      gutters: document.querySelectorAll('.gutter:not(.gutter-split):not(.gutter-dock):not(.gutter-corner)').length,
      tabMode: tab ? getComputedStyle(tab).writingMode : null,
      railButtons: [...(col?.querySelectorAll('.dock-slot-menu-btn, .dock-slot-max-btn') ?? [])].filter(
        (b) => b.getBoundingClientRect().width > 0,
      ).length,
      stored: JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}').collapsedColumns ?? null,
      activeLeft: window.__oip ? JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}').active?.leftTop : null,
    }
  })
}

const tab = (page, label) => page.locator('.dock-column-left .dock-slot-tab', { hasText: label })

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
    await page.waitForSelector('.dock-column-left .dock-slot-tab')

    const open = await metrics(page)
    check('starts open', !open.folded && open.hasContent && open.colW > 150, `column ${open.colW}px`)

    // --- click the front tab (Scene) -> fold ---
    await tab(page, 'Scene').click()
    await page.waitForTimeout(150)
    const shut = await metrics(page)
    check('folded: rail class, no content', shut.folded && !shut.hasContent)
    check('folded: the rail is narrow', shut.colW > 10 && shut.colW < 48, `${open.colW} -> ${shut.colW}px`)
    check('folded: viewport reclaims the width', shut.canvasW > open.canvasW + 100, `canvas ${open.canvasW} -> ${shut.canvasW}`)
    check('folded: width gutter dropped', shut.gutters === open.gutters - 1, `${open.gutters} -> ${shut.gutters}`)
    check('folded: tabs stand on end', shut.tabMode === 'vertical-rl', String(shut.tabMode))
    check('folded: no ▾ or ⛶ on the rail', shut.railButtons === 0, String(shut.railButtons))
    check('folded: persisted', JSON.stringify(shut.stored) === '["left"]', JSON.stringify(shut.stored))
    await page.screenshot({ path: 'e2e/out/side-dock-folded.png' })

    // --- right-click a rail tab: move menu, column stays folded ---
    await tab(page, 'History').click({ button: 'right' })
    await page.waitForTimeout(120)
    check('right-click opens the move menu', (await page.locator('.dock-move-menu').count()) === 1)
    check('right-click does not open the column', (await metrics(page)).folded)
    await page.locator('.dock-menu-backdrop').click()
    await page.waitForTimeout(120)

    // --- click a rail tab -> open with it in front, at the old width ---
    await tab(page, 'History').click()
    await page.waitForTimeout(150)
    const again = await metrics(page)
    check('opens on a rail click', !again.folded && again.hasContent)
    check('opens with the clicked tab in front', again.activeLeft === 'history', String(again.activeLeft))
    check('opens at the same width', again.colW === open.colW, `${open.colW} -> ${again.colW}`)
    check('viewport back to its width', again.canvasW === open.canvasW, `${open.canvasW} -> ${again.canvasW}`)
    check('persisted flag cleared', JSON.stringify(again.stored) === '[]', JSON.stringify(again.stored))

    // --- the right column folds the same way, and reads its labels toward the viewport ---
    await page.locator('.dock-column-right .dock-slot-tab', { hasText: 'Inspector' }).click()
    await page.waitForTimeout(150)
    const right = await page.evaluate(() => {
      const col = document.querySelector('.dock-column-right')
      return { folded: !!col?.classList.contains('collapsed'), w: Math.round(col?.getBoundingClientRect().width ?? 0) }
    })
    check('right column folds too', right.folded && right.w < 48, `${right.w}px`)
    await page.screenshot({ path: 'e2e/out/side-dock-both-folded.png' })

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
