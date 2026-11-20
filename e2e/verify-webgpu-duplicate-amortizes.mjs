/* global console, process */
// WebGPU duplicate-hitch guard: duplicating a part that already exists in the scene must add ~zero new
// vertex-shader programs (i.e. reuse the warm pipelines). This amortises like WebGL and prevents the
// "big frame drop when duplicating a roller conveyor".
//
// Background: three 0.186 named each InstancedMesh's instance-matrix buffer struct `NodeBuffer_<node.id>`
// (unique per object), so structurally-identical banks emitted different vertex WGSL and each fresh instanced
// mesh cold-compiled; a patch normalised the name in three's program cache. Since 0.187 three names a uniform
// buffer by its index within one shader build, so identical banks emit identical WGSL and share one
// program+pipeline. The 2nd duplicate of a roller conveyor compiles ~0 new vertex programs (~14 on 0.186
// without the patch). This asserts three still shares them, end-to-end under real WebGPU.
// Run: node e2e/verify-webgpu-duplicate-amortizes.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const THRESHOLD = 4 // max new vertex programs the 2nd (fully-warm) duplicate may add; ~0-2 when three shares them, ~14 when not

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

const waitApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }
const vprogs = (page) => page.evaluate(() => window.__oip.view.renderer._pipelines?.programs?.vertex?.size ?? -1)

// select `id`, duplicate it, deselect the clone (so we measure the base-bank programs the dedup fixes,
// not the first-select outline mask which is a separate pass), settle, return the clone id
async function dup(page, id) {
  const clone = await page.evaluate((id) => {
    const s = window.__oip.store
    s.select(id)
    s.duplicateSelection()
    const c = s.getState().selectedIds[0]
    s.select(null)
    return c
  }, id)
  await settle(page, 1800) // let the (deduped) compile finish
  return clone
}

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const fail = (msg) => { console.error(`FAIL: ${msg}`); if (errors.length) console.error('errors:', errors.slice(0, 5)); process.exitCode = 1 }
  try {
    await page.goto(`${url}?webgpu&scene=demo`)
    await waitApp(page)
    const backend = await page.evaluate(() => {
      const r = window.__oip.view.renderer
      return r.isWebGPURenderer ? (r.backend ? r.backend.constructor.name : 'unknown') : 'WebGLRenderer'
    })
    // The dedup targets WGSL NodeBuffer naming, which only the real WebGPU (Dawn) backend emits. A headless
    // box that only offers the WebGL2 fallback backend (GLSL) has nothing to assert, so skip rather than fail.
    if (backend !== 'WebGPUBackend') { console.log(`SKIP: backend=${backend}, need WebGPUBackend (Dawn) for the WGSL dedup path`); return }
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length >= 10, { timeout: 30000 })
    await settle(page, 6000) // staged compile done → all demo banks exist warm

    const id0 = await page.evaluate(() =>
      window.__oip.store.getState().scene.parts.find((p) => /roller-conveyor/.test(p.packageId || ''))?.id ?? null)
    if (!id0) return fail('demo has no roller conveyor to duplicate')

    // dup #1 warms this type's clone-specific pipelines (first-ever select → outline mask, etc.)
    const id1 = await dup(page, id0)
    const beforeSecond = await vprogs(page)
    // dup #2 is the measured one: a fully-warm type → must add ~0 vertex programs (amortised)
    await dup(page, id1)
    const afterSecond = await vprogs(page)

    const added = afterSecond - beforeSecond
    const lit = await page.evaluate(() => new Promise((resolve) => {
      // a WebGPU canvas must present a frame before drawImage can read it, so double-rAF first
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const src = window.__oip.view.renderer.domElement
        const c = document.createElement('canvas'); c.width = src.width; c.height = src.height
        const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0)
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++
        resolve(n / (d.length / 4))
      }))
    }))

    if (beforeSecond < 0 || afterSecond < 0) return fail('could not read three vertex-program cache (three internals changed?)')
    if (added > THRESHOLD) return fail(`2nd duplicate added ${added} vertex programs (> ${THRESHOLD}) - pipeline dedup regressed; duplicates no longer amortise`)
    if (lit < 0.05) return fail(`canvas nearly blank after duplicates (lit=${(lit * 100).toFixed(1)}%)`)
    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)

    console.log(`PASS: 2nd roller-conveyor duplicate added ${added} vertex programs (≤ ${THRESHOLD}) - pipelines amortise; lit=${(lit * 100).toFixed(0)}%`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
