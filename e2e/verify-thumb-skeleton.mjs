// Verify the catalog shows a shimmer skeleton while a custom/SDK part thumbnail renders offscreen,
// then swaps it for the rendered image. Guards the loading affordance (App pendingThumbs → Catalog
// .catalog-card-skeleton). Run: node e2e/verify-thumb-skeleton.mjs
//
// Pristine bundled packages load a committed /thumbnails/pkg/*.webp and never render offscreen, so an
// unmodified session has no in-flight render to watch. The gate forces one through a real product
// path: it 404s the roller's static thumb, which the card reports (onPackageThumbnailMissing) and App
// answers by rendering that one package in-browser - the same pendingThumbs → skeleton → data URL
// flow a desktop-folder or in-app authored part takes.
/* global process, console, window, document, localStorage, MutationObserver */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const ROLLER = 'oip.roller-conveyor'
const ROLLER_CARD = `button.catalog-card-main[data-part-type="part"][data-package-id="${ROLLER}"]`

async function main() {
  const { url, vite } = await startServer()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* harmless */ }
  })
  // The Parts dock opens on Equipment, so the roller card misses its static thumb and renders during boot. Watch for
  // its skeleton from the first paint: polling only once the app reports ready can start after the render has landed.
  await page.addInitScript((sel) => {
    window.__sawRollerSkeleton = false
    new MutationObserver(() => {
      if (document.querySelector(`${sel} .catalog-card-skeleton`)) window.__sawRollerSkeleton = true
    }).observe(document, { childList: true, subtree: true })
  }, ROLLER_CARD)
  page.on('console', (m) => {
    // the forced 404 below logs its own "Failed to load resource", which is expected
    if (m.type() === 'error' && !m.location().url?.includes(`/thumbnails/pkg/${ROLLER}.webp`)) console.log('  console.error:', m.text().slice(0, 140))
  })
  let staticMisses = 0
  await page.route(`**/thumbnails/pkg/${ROLLER}.webp`, (route) => {
    staticMisses++
    return route.fulfill({ status: 404, body: '' })
  })
  let ok
  try {
    await page.goto(url)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), null, { timeout: 20000 })
    const eq = page.locator('button.catalog-tab', { hasText: /^Equipment$/ })
    await eq.waitFor({ state: 'visible', timeout: 15000 })
    await eq.click()

    // 1) the roller card must show the shimmer while its offscreen render is in flight. Scoped to that
    //    card, not any skeleton on the page, so the verdict is about the render this gate caused.
    const sawSkeleton = await page.waitForFunction(() => window.__sawRollerSkeleton === true, null, { timeout: 20000 }).then(
      () => true,
      () => false,
    )
    console.log(`staticMisses=${staticMisses} sawSkeleton=${sawSkeleton}`)
    if (staticMisses === 0) console.log('  the route never fired: the roller card no longer requests /thumbnails/pkg/*.webp, so this gate forces nothing')

    // 2) every skeleton must clear once its render settles (App clears pendingThumbs in .finally,
    //    so this holds whether the render produced an image or fell back to a glyph - no stuck spinner)
    await page.waitForFunction(() => !document.querySelector('.catalog-card-skeleton'), null, { timeout: 30000 })

    // 3) the roller card must have resolved to the in-browser render (a PNG data URL), not the glyph.
    //    The image content itself is asserted by verify-roller-thumb / verify-webgpu-thumb.
    const src = await page.locator(`${ROLLER_CARD} .catalog-card-thumb img`).first().getAttribute('src', { timeout: 5000 }).catch(() => null)
    const clearedToImage = !!src?.startsWith('data:image/png')
    console.log(`skeletonsCleared=true rollerImg=${clearedToImage}${clearedToImage ? '' : ` (src=${String(src).slice(0, 40)})`}`)

    ok = staticMisses > 0 && sawSkeleton && clearedToImage
    console.log(ok ? 'PASS: skeleton shown while rendering, then cleared to the rendered image' : 'FAIL')
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('crashed', e); process.exit(2) })
