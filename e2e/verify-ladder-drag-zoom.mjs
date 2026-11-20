// The ladder view's pointer and zoom gestures, in a browser: the paths no other gate drives.
//
//   - Ctrl+wheel zooms the sheet and the zoom is remembered once the wheel settles; Ctrl+0 resets it, Ctrl+= zooms in
//     (useLadderSheet.ts useLadderZoom)
//   - a rung longer than the view wraps, and its rows are joined by the drawn wire (useLadderSheet.ts useWrapLinks)
//   - a rung dragged by its number lands where the pointer is released (useLadderDrags.tsx, rungSlotAt)
//   - a branch end dragged over its neighbour takes it into the branch (useLadderDrags.tsx, stretchBy)
//
// Each is checked in the stored program or the sheet's DOM, not in the view's state. Element drag and drop is
// verify-ladder-popout.mjs's; Find, Toggle Bit and live values are verify-ladder-view-tools.mjs's.
// Run: node e2e/verify-ladder-drag-zoom.mjs
/* global process, console, window, document, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const PROGRAM = `VAR
  A, B, C, D, E, F, G, H, Q, R, S : BOOL;
END_VAR
LADDER
  |A| (Q);
  |B| (R);
  [|C|, |D|] |E| (S);
  |A| |B| |C| |D| |E| |F| |G| |H| |A| |B| |C| |D| |E| |F| |G| |H| |A| |B| |C| |D| (R);
END_LADDER
`

let failures = 0
function expect(ok, what) {
  if (ok) console.log('  ok:', what)
  else {
    failures++
    console.error('  FAIL:', what)
  }
}
const stored = (page) => page.evaluate(() => window.__oip.store.getState().stProgram)
const ladderBody = (text) => text.split('LADDER')[1].split('END_LADDER')[0].trim().split('\n').map((l) => l.trim())
const zoomNow = (page) => page.evaluate(() => Number(document.querySelector('[data-testid="ladder-view"] [data-zoom]')?.getAttribute('data-zoom') ?? 1))

const { url } = await startServer()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.addInitScript(() => {
    localStorage.setItem('oip-web/tutorial-done', '1')
    localStorage.removeItem('oip.ladderZoom')
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate((program) => {
    const st = window.__oip.store
    st.loadScene({ version: st.getState().scene.version, parts: [] })
    st.setStProgram(program)
  }, PROGRAM)
  await showPlcEditor(page, { face: 'as-is' })
  const view = page.locator('[data-testid="ladder-view"]')
  await view.waitFor({ timeout: 20000 })
  await page.waitForTimeout(500)

  console.log('--- wrapped rows are joined ---')
  const links = await page.evaluate(() => document.querySelectorAll('[data-testid="ladder-view"] .ld-links i.ld-link').length)
  expect(links > 0, `the long rung's rows are linked (${links} link pieces)`)

  console.log('--- zoom: Ctrl+wheel, the keys, remembered ---')
  const box = await view.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await page.waitForTimeout(400)
  const z1 = await zoomNow(page)
  expect(z1 > 1, `Ctrl+wheel up zooms in (${z1})`)
  expect((await page.evaluate(() => localStorage.getItem('oip.ladderZoom'))) === String(z1), 'and the zoom is remembered once the wheel settles')
  await view.focus()
  await page.keyboard.press('Control+Digit0')
  await page.waitForTimeout(100)
  expect((await zoomNow(page)) === 1, 'Ctrl+0 resets it')
  await page.keyboard.press('Control+Equal')
  await page.waitForTimeout(100)
  expect((await zoomNow(page)) > 1, `Ctrl+= zooms in (${await zoomNow(page)})`)
  await page.keyboard.press('Control+Digit0')

  console.log('--- a rung dragged by its number ---')
  const nums = page.locator('[data-testid="ladder-rung-num"]')
  const n0 = await nums.nth(0).boundingBox()
  const n2 = await nums.nth(2).boundingBox()
  await page.mouse.move(n0.x + n0.width / 2, n0.y + n0.height / 2)
  await page.mouse.down()
  await page.mouse.move(n0.x + n0.width / 2, n2.y + n2.height - 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const after = ladderBody(await stored(page))
  // released below the middle of the third rung: by rungSlotAt the dragged rung lands after it
  expect(after.slice(0, 3).join(' / ') === '|B| (R); / [|C|, |D|] |E| (S); / |A| (Q);', `rung 0 moved down past rung 2 (${after.slice(0, 3).join(' / ')})`)

  console.log('--- a branch end dragged over its neighbour ---')
  // the branch rung is now rung 2 still (rung 0 moved to 1): select the branch, then pull its right end past E
  const branchRung = after.findIndex((l) => l.startsWith('[|C|'))
  const branch = page.locator(`[data-trail="0/${branchRung}/0"]`)
  await branch.click({ position: { x: 4, y: 4 } })
  const node = page.locator('.ld-node.right').first()
  await node.waitFor({ timeout: 5000 })
  const nb = await node.boundingBox()
  const e = await page.locator(`[data-trail="0/${branchRung}/1"]`).boundingBox()
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2)
  await page.mouse.down()
  await page.mouse.move(e.x + e.width - 2, nb.y + nb.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const stretched = ladderBody(await stored(page))[branchRung]
  expect(stretched !== '[|C|, |D|] |E| (S);' && stretched.includes('E'), `the branch took E in (${stretched})`)

  expect(errors.length === 0, `no page errors (${errors.join(' | ')})`)
} finally {
  await browser.close()
}
console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
