// Attributes the demo scene's WebGPU render pipeline count to the fields that split it, so you can
// see which ones are combinable before doing any work.
//
// three keys a render pipeline (Pipelines.js `_getRenderCacheKey`) as
//   stageVertex.id , stageFragment.id , <WebGPUBackend.getRenderCacheKey(renderObject)>
// and that backend key is a fixed 29-element array `.join()`ed: 27 scalars, then the geometry
// attribute-layout key (itself comma-bearing), then the clipping key. The field order is known, so
// the live keys in `_pipelines.caches` can be parsed back apart and bucketed.
//
// Two numbers matter per field:
//   distinct - how many values the scene actually uses (1 = already uniform, nothing to gain)
//   collapse - pipelines that would remain if that one field were forced constant (the saving)
// Plus a greedy pass that collapses fields cumulatively, best-first, to show the combined ceiling.
//
// The program-id pair is reported separately: pipelines-minus-distinct-program-pairs is the number
// of pipelines that are pure state/format/layout variants of a shader that is already compiled,
// which merging can remove without touching a single shader.
//
// Usage: node e2e/probes/pipeline-census.mjs [--dev] [--q=<extra query flags>]
//   default - serves the existing dist/ (no rebuild); run `npm run build` first if dist/ is stale
//   --dev - runs against a dev server instead. Absolute counts differ from prod (dev geometry is
//               un-quantized, so the `geometry` axis has different buckets), but code-driven axes like
//               `colorSpace` read the same, and it lets you A/B a src change without a build.
//   --q=… - extra query flags, e.g. --q=nostaticfold
/* global process, console, window */
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'
import { startServer } from '../_server.mjs'

const log = (...a) => console.log(...a)

// WebGPUBackend.getRenderCacheKey field order (three 0.185), prefixed by the two program ids.
const SCALARS = [
  'vertexProgram',
  'fragmentProgram',
  'transparent',
  'blending',
  'premultipliedAlpha',
  'blendSrc',
  'blendDst',
  'blendEquation',
  'blendSrcAlpha',
  'blendDstAlpha',
  'blendEquationAlpha',
  'colorWrite',
  'depthWrite',
  'depthTest',
  'depthFunc',
  'stencilWrite',
  'stencilFunc',
  'stencilFail',
  'stencilZFail',
  'stencilZPass',
  'stencilFuncMask',
  'stencilWriteMask',
  'side',
  'frontFaceCW',
  'sampleCount',
  'colorSpace',
  'colorFormat',
  'depthStencilFormat',
  'primitiveTopology',
]

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

// one row per pipeline: the parsed fields, in SCALARS order plus geometry + clipping
function parse(key) {
  const t = key.split(',')
  if (t.length < SCALARS.length + 2) return null // compute pipeline / unknown shape
  const row = {}
  SCALARS.forEach((name, i) => (row[name] = t[i]))
  row.geometry = t.slice(SCALARS.length, t.length - 1).join(',')
  row.clipping = t[t.length - 1]
  return row
}

// how many buckets remain when `drop` fields are forced constant
const collapsedCount = (rows, drop) => {
  const keep = FIELDS.filter((f) => !drop.has(f))
  return new Set(rows.map((r) => keep.map((f) => r[f]).join('|'))).size
}

const FIELDS = [...SCALARS, 'geometry', 'clipping']

async function main() {
  const dev = process.argv.includes('--dev')
  if (!dev && !distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first, or pass --dev')
    process.exit(1)
  }
  const extra = (process.argv.find((a) => a.startsWith('--q=')) ?? '').slice(4)
  let baseUrl, close
  if (dev) {
    const { port, vite } = await startServer()
    baseUrl = `http://localhost:${port}`
    close = () => vite.kill()
  } else {
    const prod = await serveDist()
    baseUrl = prod.url
    close = () => prod.close()
  }
  const browser = await launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const q = `?scene=demo&hook${extra ? `&${extra}` : ''}`
    log(`${dev ? 'dev server' : 'dist/'}  ${q}\n`)
    await page.goto(`${baseUrl}/app/${q}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready'), null, {
      timeout: 180000,
    })
    await page.waitForTimeout(3000) // let the tail of the staged compile settle

    const raw = await page.evaluate(() => {
      const renderer = window.__oip?.view?.renderer
      if (!renderer?.isWebGPURenderer) return { error: 'not on the WebGPU path' }
      const pipes = renderer._pipelines
      if (!pipes?.caches?.forEach) return { error: '_pipelines.caches shape changed' }
      const keys = []
      let compute = 0
      pipes.caches.forEach((pipeline, key) => {
        if (pipeline?.isComputePipeline) compute++
        else keys.push({ key, used: pipeline?.usedTimes ?? 0 })
      })
      return {
        keys,
        compute,
        programsV: pipes.programs?.vertex?.size ?? -1,
        programsF: pipes.programs?.fragment?.size ?? -1,
      }
    })

    if (raw.error) {
      log(`could not census: ${raw.error}`)
      process.exitCode = 1
      return
    }

    const rows = []
    let unparsed = 0
    for (const { key, used } of raw.keys) {
      const r = parse(key)
      if (r) {
        r.__used = used
        rows.push(r)
      } else unparsed++
    }

    log(`demo scene, WebGPU\n`)
    log(`── totals`)
    log(`   render pipelines   ${rows.length}${unparsed ? `  (+${unparsed} unparsed)` : ''}`)
    log(`   compute pipelines  ${raw.compute}`)
    log(`   programs           ${raw.programsV} vertex / ${raw.programsF} fragment`)

    const pairs = new Set(rows.map((r) => `${r.vertexProgram}|${r.fragmentProgram}`)).size
    log(`   distinct shader pairs ${pairs}`)
    log(
      `   → ${rows.length - pairs} pipelines (${Math.round(((rows.length - pairs) / Math.max(rows.length, 1)) * 100)}%) ` +
        `are STATE/FORMAT/LAYOUT variants of an already-compiled shader`,
    )

    log(`\n── what each field costs (only fields that actually vary)`)
    log(`   ${'field'.padEnd(22)} ${'distinct'.padStart(8)} ${'collapse to'.padStart(11)}  saved`)
    const varying = []
    for (const f of FIELDS) {
      const distinct = new Set(rows.map((r) => r[f])).size
      if (distinct <= 1) continue
      const after = collapsedCount(rows, new Set([f]))
      varying.push({ f, distinct, after, saved: rows.length - after })
    }
    varying.sort((a, b) => b.saved - a.saved)
    for (const v of varying) {
      log(`   ${v.f.padEnd(22)} ${String(v.distinct).padStart(8)} ${String(v.after).padStart(11)}  -${v.saved}`)
    }
    if (varying.length === 0) log(`   (none - every pipeline differs only by shader pair)`)

    log(`\n── greedy cumulative collapse (best field first)`)
    const drop = new Set()
    let cur = rows.length
    for (;;) {
      let best = null
      for (const { f } of varying) {
        if (drop.has(f)) continue
        const after = collapsedCount(rows, new Set([...drop, f]))
        if (!best || after < best.after) best = { f, after }
      }
      if (!best || best.after >= cur) break
      drop.add(best.f)
      log(`   + unify ${best.f.padEnd(22)} ${cur} → ${best.after}`)
      cur = best.after
    }
    log(`   floor with every varying field unified: ${cur} (= distinct shader pairs in play)`)

    log(`\n── value breakdown for the top splitters`)
    for (const v of varying.slice(0, 5)) {
      const counts = new Map()
      for (const r of rows) counts.set(r[v.f], (counts.get(r[v.f]) ?? 0) + 1)
      const shown = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      log(`   ${v.f}:`)
      for (const [val, n] of shown) {
        const label = val.length > 78 ? val.slice(0, 78) + '…' : val || '(empty)'
        log(`     ${String(n).padStart(4)} × ${label}`)
      }
    }

    const unused = rows.filter((r) => r.__used === 0).length
    if (unused) log(`\n   note: ${unused} pipelines have usedTimes 0 (compiled but not drawn this frame)`)

    // Side twins: the same shader+state+layout compiled at more than one `material.side`. Two very
    // different causes, and only one is worth acting on:
    //   - a deliberate doubleSided variant (functionMesh/rig clone a shared role material so the
    //     shared one stays single-sided) - semantically real, leave it
    //   - a material that is DoubleSide for no reason on closed geometry - costs a pipeline AND
    //     backface fill
    // The geometry layout printed with each group is the clue to which content it is.
    const SIDE_NAME = { 0: 'Front', 1: 'Back', 2: 'Double' }
    const bySansSide = new Map()
    for (const r of rows) {
      const k = FIELDS.filter((f) => f !== 'side')
        .map((f) => r[f])
        .join('|')
      const g = bySansSide.get(k) ?? []
      g.push(r)
      bySansSide.set(k, g)
    }
    const sideTwins = [...bySansSide.values()].filter((g) => new Set(g.map((r) => r.side)).size > 1)
    log(`\n── side twins: ${sideTwins.length} shader+state+layout combos compiled at >1 side (${sideTwins.reduce((n, g) => n + g.length, 0)} pipelines)`)
    for (const g of sideTwins) {
      const sides = g.map((r) => `${SIDE_NAME[r.side] ?? r.side}${r.__used === 0 ? '(unused)' : ''}`).join(' + ')
      const geo = g[0].geometry.length > 62 ? g[0].geometry.slice(0, 62) + '…' : g[0].geometry
      log(`   ${sides.padEnd(26)} vp=${g[0].vertexProgram} fp=${g[0].fragmentProgram}  ${geo}`)
    }

    // Is the duplication a warm-vs-live target mismatch? If the pipelines compiled behind the cover
    // were minted against a different render destination than the live frame draws into, they show up
    // as never-used AND on the minority side of a format/colour-space field. Cross-tab to tell.
    log(`\n── used vs never-used, by render-destination field`)
    for (const f of ['colorSpace', 'colorFormat', 'depthStencilFormat', 'sampleCount']) {
      const cells = new Map()
      for (const r of rows) {
        const k = `${r[f] || '(empty)'}`
        const c = cells.get(k) ?? { used: 0, unused: 0 }
        r.__used === 0 ? c.unused++ : c.used++
        cells.set(k, c)
      }
      if (cells.size <= 1) continue
      log(`   ${f}:`)
      for (const [val, c] of cells) log(`     ${val.padEnd(24)} used ${String(c.used).padStart(4)}   never-used ${String(c.unused).padStart(4)}`)
    }

    // Of the shader+state combos that exist under both colour spaces, how do their used/unused split?
    const byShaderState = new Map()
    for (const r of rows) {
      const k = FIELDS.filter((f) => f !== 'colorSpace')
        .map((f) => r[f])
        .join('|')
      const g = byShaderState.get(k) ?? []
      g.push(r)
      byShaderState.set(k, g)
    }
    const dupGroups = [...byShaderState.values()].filter((g) => g.length > 1)
    const dupRows = dupGroups.flat()
    log(
      `\n   colour-space twins: ${dupGroups.length} shader+state combos exist under BOTH spaces ` +
        `(${dupRows.length} pipelines, ${dupRows.filter((r) => r.__used === 0).length} of them never used)`,
    )
  } finally {
    await browser.close()
    close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
