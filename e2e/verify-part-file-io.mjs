// Verifies part file export/import (docs/part-authoring-guide.md "Sharing"): every custom-part catalog
// card offers ⤓ Download (a self-contained <id>.oippart, core/parts/partArchive.ts), and the Parts dock's ⤒ Import
// loads a part file: the older single-JSON <id>.part.json here, the downloaded .oippart in the round trip. The
// imported part appears as a placeable catalog card and survives a reload (userPackages persistence).
// Run: node e2e/verify-part-file-io.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
}

// a minimal, valid part file in the canonical { ...manifest, behaviorSource } shape
const PART_FILE = {
  id: 'e2e.imported-deck',
  name: 'E2E Imported Deck',
  category: 'Equipment',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.05, bottom: -0.1 } },
  behaviorSource: `definePart({
  params: { speed: { type: 'number', default: 1.25, min: 0, max: 5, label: 'Speed (m/s)' } },
  step(ctx) { const s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
})`,
}

const dir = mkdtempSync(join(tmpdir(), 'oip-part-io-'))
const importPath = join(dir, 'e2e.imported-deck.part.json')
writeFileSync(importPath, JSON.stringify(PART_FILE, null, 2))

const browser = await chromium.launch({ headless: !HEADED })
const page = await browser.newPage()
try {
  await page.goto(URL)
  await waitForApp(page)

  // ---- import: feed the part file to the Parts dock's hidden file input
  const importBtn = page.locator('.catalog-dock button', { hasText: 'Import part' })
  await importBtn.waitFor({ timeout: 20000 })
  check('Import part button is in the Parts dock', true)
  await page.locator('.catalog-dock input[type="file"]').setInputFiles(importPath)
  const card = page.locator('.catalog-card-custom [data-package-id="e2e.imported-deck"]')
  await card.waitFor({ timeout: 10000 })
  check('imported part appears as a catalog card', true)

  // the imported package is registered with its baked param schema (re-baked from the behavior on import)
  const baked = await page.evaluate(() => {
    const pkg = window.__oip.store.getState().userPackages.find((p) => p.id === 'e2e.imported-deck')
    return pkg ? { name: pkg.name, hasSpeed: !!pkg.params?.speed } : null
  })
  check('imported package lands in userPackages with re-baked params', baked?.name === 'E2E Imported Deck' && baked?.hasSpeed === true, JSON.stringify(baked))

  // ---- persistence: the imported part survives a reload (userPackages → localStorage)
  await page.reload()
  await waitForApp(page)
  await page.locator('.catalog-card-custom [data-package-id="e2e.imported-deck"]').waitFor({ timeout: 20000 })
  check('imported part survives a page reload', true)

  // ---- export: the card's ⤓ downloads <id>.part.json, and the file round-trips through import
  const cardWrap = page.locator('.catalog-card-custom', { has: page.locator('[data-package-id="e2e.imported-deck"]') })
  await cardWrap.hover()
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), cardWrap.locator('.catalog-card-download').click()])
  check('⤓ downloads the part file', download.suggestedFilename() === 'e2e.imported-deck.oippart', download.suggestedFilename())
  const exportPath = join(dir, 'roundtrip.oippart')
  await download.saveAs(exportPath)
  const files = unzipSync(new Uint8Array(readFileSync(exportPath)))
  const manifest = files['manifest.json'] ? JSON.parse(strFromU8(files['manifest.json'])) : null
  const behavior = files['behavior.js'] ? strFromU8(files['behavior.js']) : null
  // the export must carry the rig back out, including the deck link, and the behavior verbatim
  check('exported archive carries the behavior + geometry', behavior?.includes('setSurfaceVelocity') === true && manifest?.geometry?.kind === 'rig' && manifest?.geometry?.links?.[0]?.name === 'deck' && manifest?.geometry?.links?.[0]?.conveys === true, `${Object.keys(files).join(', ')} | ${JSON.stringify(manifest?.geometry)?.slice(0, 200)}`)

  // import the export back under a fresh id - a clean file must re-import without touching the original
  manifest.id = 'e2e.roundtrip-deck'
  manifest.name = 'E2E Roundtrip Deck'
  const roundtripPath = join(dir, 'e2e.roundtrip-deck.oippart')
  writeFileSync(roundtripPath, zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) }))
  await page.locator('.catalog-dock input[type="file"]').setInputFiles(roundtripPath)
  await page.locator('.catalog-card-custom [data-package-id="e2e.roundtrip-deck"]').waitFor({ timeout: 10000 })
  check('a downloaded part file re-imports (round trip)', true)
} catch (e) {
  failures++
  console.log(`FAIL  ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
