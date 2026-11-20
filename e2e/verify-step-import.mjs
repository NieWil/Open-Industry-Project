// A STEP file imports through the rig Inspector's "Import model...": the CAD kernel's worker turns it into a GLB
// that becomes the selected node's mesh (editor/stepImport.ts, core/stepToGlb.ts).
//
//   A) the kernel loads lazily: its wasm is not fetched until a STEP file is converted
//   B) picking a STEP file stops at its options (detail, skip small parts, merge by colour) before converting
//   C) converting runs off the page thread: frames keep coming while the kernel reads the file
//   D) the node becomes a mesh of an embedded GLB, with one mesh per colour, and the Inspector says what it did
//   E) Cancel on the options imports nothing
//
// The file is the CAx-IF test assembly the kernel's own npm package ships (18 solids, 5 colours). Point
// OIP_STEP_FILE at a bigger one to time a real assembly (the timeout follows the file size), and OIP_STEP_SHOT at
// a .png path to see the result.
//
//   node e2e/verify-step-import.mjs
/* global process, console, window, localStorage, requestAnimationFrame, performance, TextDecoder */
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const stepPath = process.env.OIP_STEP_FILE ?? require.resolve('occt-import-js/test/testfiles/cax-if/as1-oc-214.stp')
const stepMb = statSync(stepPath).size / 1e6
const { url: URL, vite } = await startServer()

let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
const wasmFetches = []
page.on('request', (r) => {
  if (/occt-import-js.*\.wasm/.test(r.url())) wasmFetches.push(r.url())
})
try {
  await page.goto(URL, { timeout: 120000 }) // a cold dev server transforms the whole graph on this first load
  await page.waitForSelector('.viewport canvas', { timeout: 25000 })
  await page.waitForFunction(() => !!window.__oip?.controller, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })

  // "New part": a blank single-box part with its 'body' node selected, so the node panel is up
  const pkgId = await page.evaluate(() => window.__oip.controller.createBlankPart())
  await page.waitForFunction(() => window.__oip.store.getState().selectedRigNode !== null, null, { timeout: 10000 })
  const shape = () => page.evaluate((id) => {
    const pkg = window.__oip.getPackage(id)
    const l = pkg.geometry.links.find((x) => x.name === 'body')
    const asset = l.shape.kind === 'mesh' ? pkg.assets?.find((a) => a.id === l.shape.asset) : undefined
    return { kind: l.shape.kind, mime: asset?.mime, b64: asset?.data?.length ?? 0, data: asset?.data?.slice(0, 64) }
  }, pkgId)
  check('A  the kernel wasm is not fetched before a STEP import', wasmFetches.length === 0, wasmFetches.join(', '))

  const input = page.getByTestId('model-file-input')
  // count() does not wait, and the node panel mounts a beat after the selection: wait for the input first
  await input.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})
  check('the model picker accepts STEP files', (await input.count()) === 1, `${await input.count()} input(s)`)

  // E first: pick, then Cancel, and nothing changes
  await input.setInputFiles(stepPath)
  const options = page.getByTestId('step-import-options')
  await options.waitFor({ timeout: 5000 })
  check('B  picking a STEP file shows its options before converting', await options.isVisible())
  // the up axis is preselected from the header's exporting program; this file names a converter, so nothing is known
  const guess = (await page.getByTestId('step-up-guess').textContent()) ?? ''
  const up = await page.getByTestId('step-up-axis').inputValue()
  if (!process.env.OIP_STEP_FILE) check('B  the up axis comes from the header (a converter: unknown, Z assumed)', up === 'z' && /Open CASCADE.*Z up is assumed/.test(guess), `${up}: ${guess}`)
  else console.log(`      up axis ${up}: ${guess}`)
  await options.getByRole('button', { name: 'Cancel' }).click()
  check('E  Cancel imports nothing', (await shape()).kind === 'box' && !(await options.isVisible()) && wasmFetches.length === 0)

  // now convert, counting frames on the page meanwhile
  await input.setInputFiles(stepPath)
  await options.waitFor({ timeout: 5000 })
  await page.evaluate(() => {
    window.__stepFrames = { n: 0, worst: 0, last: performance.now(), on: true }
    const tick = () => {
      const f = window.__stepFrames
      const now = performance.now()
      f.worst = Math.max(f.worst, now - f.last)
      f.last = now
      f.n++
      if (f.on) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const t0 = Date.now()
  await options.getByRole('button', { name: 'Convert and import' }).click()
  const hint = page.locator('.inspector-hint', { hasText: /Imported .*solids|Could not import|Nothing to import/ })
  await hint.waitFor({ timeout: 30000 + stepMb * 6000 })
  const seconds = (Date.now() - t0) / 1000
  const frames = await page.evaluate(() => {
    window.__stepFrames.on = false
    return window.__stepFrames
  })
  const text = (await hint.textContent()) ?? ''
  console.log(`      ${stepMb.toFixed(1)} MB in ${seconds.toFixed(1)} s: ${text}`)
  check('A  the kernel wasm is fetched once a STEP file is converted', wasmFetches.length >= 1)
  // the conversion is one blocking call in the worker; on the page the longest frame gap stays far below it
  check('C  the page keeps drawing while the kernel reads the file', frames.n > 10 && frames.worst < Math.max(1000, seconds * 500), `${frames.n} frames, worst gap ${Math.round(frames.worst)} ms over ${seconds.toFixed(1)} s`)
  check('D  the Inspector reports the import', /^Imported .*solids/.test(text), text)

  const s = await shape()
  check('D  the node is now a mesh of an embedded GLB', s.kind === 'mesh' && s.mime === 'model/gltf-binary' && s.b64 > 1000, JSON.stringify({ kind: s.kind, mime: s.mime, b64: s.b64 }))
  if (!process.env.OIP_STEP_FILE) {
    const nodes = await page.evaluate((id) => {
      const pkg = window.__oip.getPackage(id)
      const l = pkg.geometry.links.find((x) => x.name === 'body')
      const data = pkg.assets.find((a) => a.id === l.shape.asset).data
      const bytes = Uint8Array.from(window.atob(data), (c) => c.charCodeAt(0))
      const len = new DataView(bytes.buffer).getUint32(12, true)
      return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))).nodes.map((n) => n.name)
    }, pkgId)
    check('D  one mesh per colour (the test assembly paints 18 solids in 5)', nodes.length === 5, nodes.join(', '))
  }
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  if (process.env.OIP_STEP_SHOT) {
    await page.locator('.viewport canvas').first().hover()
    await page.keyboard.press('KeyF') // Focus selection
    await page.waitForTimeout(1500)
    await cleanShot(page, process.env.OIP_STEP_SHOT)
    console.log(`      shot: ${process.env.OIP_STEP_SHOT}`)
  }
} catch (e) {
  failures++
  console.log(`FAIL  harness: ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
