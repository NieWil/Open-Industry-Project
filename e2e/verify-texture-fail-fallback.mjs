/* global console, process */
// Gate: a texture whose fetch fails must not paint its surface black.
//
// Guards against "the floor loads dark for some people": one dropped request for
// BuildingPart_Floor_A_BaseColor.webp, and the warehouse floor renders pitch black while the walls
// (whose fetches succeeded) look right. The risk is not floor-specific: the loader hands the material
// a Texture and fills its image in later. Without a fallback, a failure leaves `map` pointing at a
// Texture with no image, which is not "no map" but three's empty default, sampled as black. The
// building gate settles on failure by design (so a dead fetch can't strand the loading cover), so
// the reveal happens over it, and with nothing re-requesting the texture it stays black for the session.
//
// This aborts that one request and asserts:
//   1. the frame does not go dark (the floor falls through to its material colour instead),
//   2. the material's map ends up with an image (the neutral 2x2), not an empty texture,
//   3. the loader retried before giving up, because the failure this guards against is transient.
// Both backends, because the WebGPU path needs a bundle re-record for the swapped-in image to
// reach a replayed draw (the "data changed, pixels didn't" class).
//
// Twice per backend: failing at once, and failing late, after the viewport has drawn frames with the texture
// still empty. A failure that lands after the first draw is the one that, on WebGPU, binds three's cached view of
// the empty default when the fallback is 1x1 (gltf.ts TextureFallback). Failing at once only races that first
// draw; the late leg makes it certain.
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const FLOOR_TEX = '**/BuildingPart_Floor_A_BaseColor.webp'
// The failed-fetch frame has to stay in a band around the textured one, not merely "not black".
// An identity-white fallback measures 175% of baseline, which looks as broken as the 42% of an
// empty texture. Both ends fail here.
const LUM_MIN = 0.8
const LUM_MAX = 1.45

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

const meanRGB = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const src = window.__oip.view.renderer.domElement
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let r = 0, g = 0, b = 0
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
    const n = d.length / 4
    resolve([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
  }))
}))

const floorMaps = (page) => page.evaluate(() => {
  const out = []
  const seen = new Set()
  window.__oip.view.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
    for (const m of ms) {
      if (!/Floor_01/.test(m.name || '') || seen.has(m.uuid)) continue
      seen.add(m.uuid)
      // the WebGPU floor samples its tile in a colorNode and has no `map`; building.ts hands it over in userData
      const map = m.map ?? m.userData?.floorMap
      out.push({ hasMap: !!map, decoded: !!(map && (map.image ?? map.source?.data)) })
    }
  })
  return out
})

async function load(browser, url, query, { abortFloorTex = false, late = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  await page.addInitScript(() => {
    window.__coverAt = null
    const t = setInterval(() => {
      const el = document.querySelector('.viewport-cover')
      if (el && el.classList.contains('ready')) { window.__coverAt = performance.now(); clearInterval(t) }
    }, 16)
  })
  let attempts = 0
  if (abortFloorTex) {
    await page.route(FLOOR_TEX, async (route) => {
      attempts++
      // hold the first request until the viewport has drawn, so the failure lands on a texture already bound
      if (late && attempts === 1) {
        await page.waitForFunction(() => {
          const info = window.__oip?.view?.renderer?.info
          return !!info && (info.frame ?? info.render?.frame ?? 0) > 30
        }, null, { timeout: 120000 }).catch(() => {})
      }
      route.abort('failed')
    })
  }
  await page.goto(`${url}?${query}`)
  await page.waitForFunction(() => !!(window.__oip && window.__oip.view), null, { timeout: 60000 })
  const backend = await page.evaluate(() => (window.__oip.view.renderer.isWebGPURenderer ? 'webgpu' : 'webgl'))
  await page.waitForFunction(() => window.__coverAt != null, null, { timeout: 180000 })
  await page.waitForTimeout(4000) // let the retry settle and the fallback re-record land
  const rgb = await meanRGB(page)
  const maps = await floorMaps(page)
  await page.close().catch(() => {})
  return { backend, rgb, maps, attempts }
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium available'); return }
  const { url, vite } = await startServer()
  const fails = []
  try {
    for (const [label, query] of [['webgl', 'nowebgpu'], ['webgpu', 'webgpu']]) {
      const base = await load(browser, url, query)
      if (label === 'webgpu' && base.backend !== 'webgpu') {
        console.log('\nwebgpu: SKIP (renderer fell back to WebGL)')
        continue
      }
      for (const [when, late] of [['at once', false], ['late', true]]) {
        const broken = await load(browser, url, query, { abortFloorTex: true, late })
        const ratio = lum(broken.rgb) / lum(base.rgb)
        console.log(`\n${label} (${base.backend}), failing ${when}`)
        console.log(`  baseline            mean rgb ${base.rgb}  lum ${lum(base.rgb).toFixed(1)}`)
        console.log(`  floor texture dead  mean rgb ${broken.rgb}  lum ${lum(broken.rgb).toFixed(1)}  (${(ratio * 100).toFixed(0)}% of baseline)`)
        console.log(`  floor materials: ${JSON.stringify(broken.maps)}`)
        console.log(`  requests for the floor texture: ${broken.attempts} (1 = no retry)`)

        if (ratio < LUM_MIN) {
          fails.push(`${label} ${when}: the scene went DARK when the floor texture failed (${(ratio * 100).toFixed(0)}% of baseline luminance - the floor is sampling an empty texture)`)
        } else if (ratio > LUM_MAX) {
          fails.push(`${label} ${when}: the scene BLEW OUT when the floor texture failed (${(ratio * 100).toFixed(0)}% of baseline luminance - the fallback texel is too bright for the material colour under it)`)
        }
        const undecoded = broken.maps.filter((m) => m.hasMap && !m.decoded)
        if (undecoded.length > 0) {
          fails.push(`${label} ${when}: ${undecoded.length} floor material(s) still carry a map with no image - that samples BLACK`)
        }
        if (broken.attempts < 2) {
          fails.push(`${label} ${when}: the failed texture was requested ${broken.attempts}x - the transient-failure retry is gone`)
        }
      }
    }
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
  console.log('')
  if (fails.length > 0) {
    for (const f of fails) console.log(`FAIL: ${f}`)
    process.exitCode = 1
  } else {
    console.log('PASS: a dead texture fetch degrades to a neutral map, not a black surface')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
