// Cargo with its own body in the app (docs/cargo-bodies.md): the Drum (libraries/containers/drum, built here from its
// source as a project that added it from Containers holds it), a rig declaring `cargo`.
//
//   1. placed drums draw as their own visual through the instanced cargo batches (render/viewport/boxes.ts), not as
//      boxes, both stopped and running, and a lying drum and an upright one share no batch with the boxes
//   2. a Spawner set to the Drum spawns drums as their own shape (the frame names their shape, kind 'part')
//   3. 200 drums draw in the same few batches as 2: placing more drums adds no draws
//   4. a cargo part drawn by an embedded GLB with a hidden body box draws its model once the model loads, stopped
//      and running, and never draws the hidden box
//   5. an edit to a cargo part's look that keeps its colliders redraws the bodies the batch already draws
//
// The physics (a drum rolls where a box slides) is pinned headless in src/sim/cargoBodies.test.ts.
//
//   node e2e/verify-cargo-bodies.mjs [--headed] [--shot <dir>]
/* global window, localStorage, console, process, requestAnimationFrame */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createVite } from 'vite'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const shotDir = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createVite({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
const drumDir = resolve(repo, 'libraries/containers/drum')
const drumPkg = buildPackage(JSON.parse(readFileSync(resolve(drumDir, 'manifest.json'), 'utf8')), readFileSync(resolve(drumDir, 'behavior.js'), 'utf8'))
// A cargo part drawn only by an embedded GLB, with a hidden box as its body: how an imported product is made. The
// model is a shipped robot piece; any GLB serves. Embedded, it loads after the cargo batch is first built.
const GLB_CARGO_BODY = [0.4, 0.3, 0.5]
const glbCargoPkg = buildPackage(
  {
    id: 'test.glb-cargo',
    name: 'GLB Cargo',
    category: 'Products',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'look', shape: { kind: 'mesh', asset: 'glb' }, offset: [0, -0.15, 0], collision: 'none' },
        { name: 'body', shape: { kind: 'box', size: GLB_CARGO_BODY }, offset: [0, 0, 0], hidden: true },
      ],
      joints: [],
      bounds: { length: 0.4, width: 0.5, top: 0.15, bottom: -0.15 },
    },
    cargo: { friction: 0.5 },
    assets: [{ id: 'glb', mime: 'model/gltf-binary', data: readFileSync(resolve(repo, 'public/part-assets/929d5eae36c065f460ac5bb80c287977bcf7c7d5596680a56ab2946d483cdb32.glb')).toString('base64') }],
  },
  'definePart({ step() {} })',
)
await vite.close()

const { port } = await startServer()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

/** the cargo batches' state: rows per kind, and how many part shapes and batches exist */
const batches = () =>
  page.evaluate(() => {
    const boxes = window.__oip.view.boxes
    const shapes = [...boxes.partShapes.values()]
    return {
      boxRows: boxes.box.count,
      partShapes: shapes.length,
      partBatches: shapes.reduce((n, s) => n + s.batches.length, 0),
      // every row is written to each of its shape's batches: the first batch's count is the bodies drawn
      partRows: shapes.reduce((n, s) => n + (s.batches[0]?.count ?? 0), 0),
      tinted: shapes.flatMap((s) => s.batches.map((b) => b.tinted)),
    }
  })

/** draws on a quiet main pass (the shadow refresh held off, as verify-instanced-cargo does) */
const mainPassDraws = () =>
  page.evaluate(async () => {
    const view = window.__oip.view
    const env = view.env
    const refresh = env?.refreshKeyShadow
    if (env && refresh) env.refreshKeyShadow = () => {}
    try {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
      for (let i = 0; i < 4; i++) await frame()
      const samples = []
      for (let i = 0; i < 6; i++) {
        await frame()
        samples.push(view.getStats().drawCalls)
      }
      return Math.max(...samples)
    } finally {
      if (env && refresh) env.refreshKeyShadow = refresh
    }
  })

/** replace the scene with these parts (built by createSdkPart in the page), one commit */
const placeDrums = (drums) =>
  page.evaluate((list) => {
    const { store } = window.__oip
    const s = store.getState()
    const pkg = window.__oip.getPackage('oip.drum')
    const parts = list.map((d, i) => ({ id: `drum_${i}`, type: 'part', packageId: pkg.id, name: `Drum ${i}`, position: d.pos, rotationY: 0, ...(d.lying ? { rotationX: Math.PI / 2 } : {}), params: {} }))
    // embedded, as placing a part embeds it: the worker only knows the packages the scene carries
    const packages = [...(s.scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg]
    store.commit('Place drums', { ...s.scene, packages, parts: [...s.scene.parts.filter((p) => !String(p.id).startsWith('drum_')), ...parts] })
  }, drums)

try {
  await page.goto(`http://localhost:${port}/app/`)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.registerPackage, null, { timeout: 120000 })
  await page.evaluate((pkg) => window.__oip.registerPackage(pkg), drumPkg)
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })

  // ── 1. placed drums draw as their own visual ──────────────────────────────────────────────────────
  await placeDrums([
    { pos: [0, 0.45, 0] },
    { pos: [2, 0.3, 0], lying: true },
  ])
  await page.waitForFunction(() => window.__oip.view.boxes.partShapes.size > 0, null, { timeout: 15000 }).catch(() => {})
  let b = await batches()
  check('stopped: the drums draw through their own shape batches', b.partShapes === 1 && b.partRows === 2, JSON.stringify(b))
  check('stopped: no drum is drawn as a box', b.boxRows === 0, `box rows ${b.boxRows}`)
  check("the drum's paint takes the body's colour, its bare rim does not", b.tinted.includes(true) && b.tinted.includes(false), JSON.stringify(b.tinted))
  if (shotDir) await cleanShot(page, `${shotDir}/drums-stopped.png`)

  await page.evaluate(() => window.__oip.controller.run())
  // a running frame has sim time; the stopped one is built at 0
  await page.waitForFunction(() => (window.__oip.view.boxes.appliedFrame?.simTime ?? 0) > 1.5, null, { timeout: 60000 })
  b = await batches()
  check('running: the drums still draw through their own shape batches', b.partRows === 2 && b.boxRows === 0, JSON.stringify(b))
  if (shotDir) await cleanShot(page, `${shotDir}/drums-running.png`)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(1500)

  // ── 2. a Spawner set to the Drum spawns drums as their own shape ─────────────────────────────────
  await page.evaluate(() => {
    const { store } = window.__oip
    const s = store.getState()
    const spawner = window.__oip.getPackage('oip.box-spawner')
    const drum = window.__oip.getPackage('oip.drum')
    const packages = [...(s.scene.packages ?? []).filter((p) => p.id !== spawner.id && p.id !== drum.id), spawner, drum]
    const part = { id: 'spawner_1', type: 'part', packageId: spawner.id, name: 'Spawner', position: [-4, 1.2, 0], rotationY: 0, params: { product: 'oip.drum', boxesPerMinute: 60 } }
    store.commit('Add a drum spawner', { ...s.scene, packages, parts: [...s.scene.parts, part] })
  })
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(
    () => {
      const f = window.__oip.view.boxes.appliedFrame
      if (!f || !f.shapes) return false
      for (let i = 0; i < f.count; i++) if (f.partIds[i] === null && f.kinds[i] === 3 && f.shapes[i]) return true
      return false
    },
    null,
    { timeout: 30000 },
  ).then(() => check('a Spawner set to the Drum spawns drums as their own shape', true), () => check('a Spawner set to the Drum spawns drums as their own shape', false, 'no spawned body with a shape'))
  b = await batches()
  check('spawned drums draw with the placed ones, not as boxes', b.partRows > 2 && b.boxRows === 0, JSON.stringify(b))
  if (shotDir) await cleanShot(page, shotDir + '/drums-spawned.png')
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const { store } = window.__oip
    const s = store.getState()
    store.commit('Remove the spawner', { ...s.scene, parts: s.scene.parts.filter((p) => p.id !== 'spawner_1') })
  })

  // ── 3. many drums, no more draws ──────────────────────────────────────────────────────────────────
  const few = await mainPassDraws()
  await placeDrums(Array.from({ length: 200 }, (_, i) => ({ pos: [(i % 20) * 0.7 - 7, 0.45, Math.floor(i / 20) * 0.7 + 3] })))
  await page.waitForTimeout(1500)
  const many = await mainPassDraws()
  b = await batches()
  check('200 drums draw', b.partRows === 200, `rows ${b.partRows}`)
  check('200 drums cost the draws of 2 (one instanced batch per material)', many - few <= 1, `${few} -> ${many} draws`)
  if (shotDir) await cleanShot(page, `${shotDir}/drums-200.png`)

  // ── 4. a cargo part drawn by a GLB draws its model once it loads, stopped and running ──────────────
  // Stopped, the scene's cargo frame is reused until the scene changes, so nothing but the model's arrival can
  // bring the batch up to date. The hidden body box must not be drawn over the model.
  await page.evaluate((pkg) => {
    window.__oip.registerPackage(pkg)
    const { store } = window.__oip
    const s = store.getState()
    const packages = [...(s.scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg]
    const part = { id: 'glb_cargo_1', type: 'part', packageId: pkg.id, name: 'GLB Cargo', position: [10, 0.15, 0], rotationY: 0, params: {} }
    store.commit('Place GLB cargo', { ...s.scene, packages, parts: [...s.scene.parts, part] })
  }, glbCargoPkg)
  const glbCargo = (body) =>
    page.evaluate((size) => {
      const boxes = window.__oip.view.boxes
      const refs = boxes.appliedFrame?.shapeRefs ?? {}
      const out = { boxRows: boxes.box.count, batches: 0, rows: 0, hiddenBoxDrawn: false }
      for (const [key, s] of boxes.partShapes) {
        if (refs[key]?.packageId !== 'test.glb-cargo') continue
        out.batches += s.batches.length
        out.rows += s.batches[0]?.count ?? 0
        for (const b of s.batches) {
          b.geometry.computeBoundingBox()
          const bb = b.geometry.boundingBox
          const d = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z]
          if (d.every((v, k) => Math.abs(v - size[k]) < 1e-3)) out.hiddenBoxDrawn = true
        }
      }
      return out
    }, body)
  const modelDrawn = () =>
    page.waitForFunction(
      () => {
        const boxes = window.__oip.view.boxes
        const refs = boxes.appliedFrame?.shapeRefs ?? {}
        for (const [key, s] of boxes.partShapes) if (refs[key]?.packageId === 'test.glb-cargo' && s.batches.length > 0 && boxes.box.count === 0) return true
        return false
      },
      null,
      { timeout: 15000 },
    ).catch(() => {})
  await modelDrawn()
  let g = await glbCargo(GLB_CARGO_BODY)
  check('stopped: the GLB cargo draws its model once it loads, not a box', g.batches > 0 && g.rows === 1 && g.boxRows === 0, JSON.stringify(g))
  check('stopped: its hidden body box is not drawn', !g.hiddenBoxDrawn, JSON.stringify(g))
  if (shotDir) await cleanShot(page, `${shotDir}/glb-cargo-stopped.png`)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => (window.__oip.view.boxes.appliedFrame?.simTime ?? 0) > 1.5, null, { timeout: 60000 })
  await modelDrawn()
  g = await glbCargo(GLB_CARGO_BODY)
  check('running: the GLB cargo draws its model, not a box', g.batches > 0 && g.rows === 1 && g.boxRows === 0, JSON.stringify(g))
  check('running: its hidden body box is not drawn', !g.hiddenBoxDrawn, JSON.stringify(g))
  await page.evaluate(() => window.__oip.controller.stop())

  // ── 5. an edit to a cargo part's look reaches the bodies the batch already draws ──────────────────
  // The batch draws each shape from visuals it keeps. An edit that leaves the colliders alone (a hot reload, a Part
  // Editor recolour) keeps the shape's key, and the kept visuals once went on drawing the part as it was.
  const bareColors = () =>
    page.evaluate(() => {
      const boxes = window.__oip.view.boxes
      const refs = boxes.appliedFrame?.shapeRefs ?? {}
      const out = []
      for (const [key, s] of boxes.partShapes) {
        if (refs[key]?.packageId !== 'oip.drum') continue
        for (const b of s.batches) if (!b.tinted) out.push(b.material.color.getHexString())
      }
      return out
    })
  const bareBefore = await bareColors()
  await page.evaluate(() => {
    const pkg = structuredClone(window.__oip.getPackage('oip.drum'))
    // the chimes carry no collider, so the drum's shape key stays what it was
    for (const l of pkg.geometry.links) if (l.name === 'chimeTop' || l.name === 'chimeBottom') l.color = [1, 0, 0]
    window.__oip.registerPackage(pkg)
  })
  await page
    .waitForFunction(
      () => {
        const boxes = window.__oip.view.boxes
        for (const s of boxes.partShapes.values()) for (const b of s.batches) if (!b.tinted && b.material.color.getHexString() === 'ff0000') return true
        return false
      },
      null,
      { timeout: 8000 },
    )
    .catch(() => {})
  const bareAfter = await bareColors()
  b = await batches()
  check("an edit to a cargo part's look redraws its bodies", bareBefore.length > 0 && !bareBefore.includes('ff0000') && bareAfter.includes('ff0000'), `${bareBefore.join(' ')} -> ${bareAfter.join(' ')}`)
  check('and every drum is still drawn, none as a box', b.partRows >= 200 && b.boxRows === 0, JSON.stringify({ partRows: b.partRows, boxRows: b.boxRows, partShapes: b.partShapes }))
} catch (e) {
  failures++
  console.log(`FAIL  ${e instanceof Error ? e.message : e}`)
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
