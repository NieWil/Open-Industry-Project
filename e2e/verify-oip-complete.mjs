// A project's copies of built-in parts carry the very model bytes the app ships (docs/part-sources.md, "Assets").
//
// A first-party part names its model by the hash of its shipped bytes (public/part-assets/<sha256>.<ext>, baked by
// scripts/bake-part-assets.mjs), so:
//   - in dev the app draws those baked bytes, the same ones production serves (no raw-vs-optimized split): the
//     Gantry's model is fetched from /part-assets/ and never from /models/;
//   - an exported .oip holds them as files: parts/<slug>/assets/<sha256>.glb, byte-identical to the baked file, its
//     manifest naming the file and the hash and no URL, so the file is complete with no app to fetch from;
//   - that .oip reads back as the same part (the fingerprint is the asset's hash, however it is held).
//
//   node e2e/verify-oip-complete.mjs [--headed]
/* global window, localStorage, console, process */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port, vite } = await startServer()
const URL = `http://localhost:${port}/app/`
const ID = 'oip.gantry'
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const requested = []
page.on('request', (r) => requested.push(new globalThis.URL(r.url()).pathname))
let harness = null

try {
  await page.goto(URL)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 2, null, { timeout: 120000 })

  // ── a placed Gantry, drawn from its baked model ────────────────────────────────────────────────
  const asset = await page.evaluate((id) => {
    const st = window.__oip.store
    const s = st.getState()
    st.commit('Place gantry', { ...s.scene, parts: [...s.scene.parts, { id: 'gantry_1', type: 'part', packageId: id, name: 'Gantry', position: [0, 0, 0], rotationY: 0, params: {} }] })
    st.persistProject()
    const a = s.bundledPackages.find((p) => p.id === id)?.assets?.find((x) => x.mime === 'model/gltf-binary')
    return a ? { url: a.url, sha256: a.sha256 } : null
  }, ID)
  if (!asset) throw new Error('the built-in gantry names no model')
  check('the built-in names its model by the hash of the shipped bytes', !!asset.sha256 && asset.url === `/part-assets/${asset.sha256}.glb`, JSON.stringify(asset))
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
  check('...and the app draws it from /part-assets/, never the raw /models/ file', requested.includes(asset.url) && !requested.includes('/models/Gantry.glb'), JSON.stringify(requested.filter((u) => /Gantry|part-assets/.test(u))))
  const baked = readFileSync(join(process.cwd(), 'public', asset.url))
  check('the baked file is the bytes its name says', createHash('sha256').update(baked).digest('hex') === asset.sha256)

  // ── the exported .oip carries the bytes ────────────────────────────────────────────────────────
  const oip = await page.evaluate(async () => {
    // what Export Project does (projectFile.ts downloadProject), minus the download dialog
    const { projectToOipBytes } = await import('/src/core/project/projectArchive.ts')
    const { shippedAssetBytes, warmShippedAssets } = await import('/src/editor/parts/shippedAssetCache.ts')
    const project = window.__oip.store.snapshotProject()
    await warmShippedAssets(project.packages ?? [])
    return [...(await projectToOipBytes(project, { assetBytes: shippedAssetBytes }))]
  })
  const files = unzipSync(new Uint8Array(oip))
  const names = Object.keys(files)
  const glbPath = names.find((n) => n.endsWith(`/assets/${asset.sha256}.glb`))
  check('the .oip holds the model as a file named by its hash', !!glbPath, names.filter((n) => n.includes('assets/')).join(', ') || 'no assets/ files')
  check('...byte-identical to the shipped bytes', !!glbPath && Buffer.from(files[glbPath]).equals(baked))
  const manifestPath = names.find((n) => /^parts\/[^/]+\/manifest\.json$/.test(n) && strFromU8(files[n]).includes(`"${ID}"`))
  const entry = manifestPath ? JSON.parse(strFromU8(files[manifestPath])).assets?.find((x) => x.sha256 === asset.sha256) : null
  check('...and its manifest names the file and the hash, with no URL to fetch', !!entry && typeof entry.file === 'string' && entry.url === undefined && entry.data === undefined, JSON.stringify(entry))

  // ── and reads back as the same part ────────────────────────────────────────────────────────────
  const same = await page.evaluate(
    async ([bytes, id]) => {
      const { oipBytesToProject } = await import('/src/core/project/projectArchive.ts')
      const { partFingerprint } = await import('/src/core/parts/partOrigin.ts')
      const { bakePart } = await import('/src/editor/parts/bakePart.ts')
      const r = await oipBytesToProject(new Uint8Array(bytes), { bakePart })
      if (!r.ok) return { error: r.errors.join('; ') }
      const back = r.project.packages?.find((p) => p.id === id)
      const live = window.__oip.store.getState().userPackages.find((p) => p.id === id)
      return { hasBytes: !!back?.assets?.some((a) => typeof a.data === 'string' && a.data.length > 0), same: !!back && !!live && partFingerprint(back) === partFingerprint(live) }
    },
    [oip, ID],
  )
  check('the .oip reads back holding the bytes, as the same part (same fingerprint)', same.hasBytes && same.same, JSON.stringify(same))
} catch (e) {
  harness = e
  console.error('harness error:', e instanceof Error ? e.message : e)
} finally {
  await browser.close()
  vite.kill()
}
if (harness) process.exit(2)
console.log(failures ? `FAIL  verify-oip-complete (${failures})` : 'PASS  verify-oip-complete')
process.exit(failures ? 1 : 0)
