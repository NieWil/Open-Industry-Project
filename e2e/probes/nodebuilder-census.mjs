// Measures what a structural `Node.customCacheKey()` override would save.
//
// three keys a NodeBuilderState by `renderObject.initialCacheKey`, which folds in every node's
// `customCacheKey()` - and Node's default is `return this.id`, the instance id. So two structurally
// identical materials each run their own `nodeBuilder.build()` (the TSL graph work: build / analyze /
// generate / getDataFromNode) and emit byte-identical WGSL.
//
// The GPU side already collapses: identical WGSL maps to one program in `_pipelines.programs`. That
// does not touch `_nodes.nodeBuilderCache`, so the redundant JS build still happens on every load -
// warm ones included, since Dawn's disk cache only covers the compiled pipeline.
//
// This counts, on the real demo scene: how many NodeBuilderStates were built vs how many distinct
// shaders they represent. The gap is what overriding customCacheKey() would eliminate.
//
// Usage: npm run build && node e2e/probes/nodebuilder-census.mjs
/* global process, console, window */
import { chromium } from 'playwright'
import { distIsBuilt, serveDist } from '../_edge-server.mjs'

const log = (...a) => console.log(...a)

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return { browser: await chromium.launch(opts), channel: opts.channel ?? 'chromium' }
    } catch {
      /* next */
    }
  }
  throw new Error('could not launch any Chromium')
}

async function main() {
  if (!distIsBuilt()) {
    console.error('dist/ is not a finished build - run `npm run build` first')
    process.exit(1)
  }
  const prod = await serveDist()
  const { browser } = await launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const q = '?scene=demo&hook'
    await page.goto(`${prod.url}/app/${q}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => document.querySelector('.viewport-cover')?.classList.contains('ready'),
      null,
      { timeout: 180000 },
    )
    await page.waitForTimeout(3000) // let the tail of the staged compile settle

    const r = await page.evaluate(() => {
      const renderer = window.__oip?.view?.renderer
      if (!renderer?.isWebGPURenderer) return { error: 'not on the WebGPU path' }
      const nodes = renderer._nodes
      const pipes = renderer._pipelines
      const cache = nodes?.nodeBuilderCache
      if (!cache || typeof cache.forEach !== 'function') return { error: 'nodeBuilderCache shape changed' }

      // three 0.186 and earlier named each instanced buffer `NodeBuffer_<id>`; normalised so "distinct"
      // means structurally distinct on either version
      const norm = (s) => (typeof s === 'string' ? s.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N') : '')
      const groups = new Map()
      let total = 0
      cache.forEach((state) => {
        total++
        const key = norm(state.vertexShader) + '\0' + norm(state.fragmentShader)
        const g = groups.get(key)
        if (g) g.n++
        else groups.set(key, { n: 1, vLen: (state.vertexShader ?? '').length, fLen: (state.fragmentShader ?? '').length })
      })
      const sizes = [...groups.values()].sort((a, b) => b.n - a.n)
      const mapSize = (m) => (m && typeof m.size === 'number' ? m.size : -1)

      // Decompose the redundancy by cause, because the two halves need different fixes:
      //   (a) distinct material instances that are structurally identical - Node.customCacheKey()
      //       defaults to `this.id`, so each mints its own NodeBuilderState. Overridable.
      //   (b) InstancedMesh - RenderObject.getMaterialCacheKey() appends `object.uuid` for every
      //       instanced object (RenderObject.js ~833, with an upstream TODO). That term is added
      //       outside any node, so customCacheKey() cannot reach it. Not overridable.
      // Approximate (b) as: instanced meshes minus their distinct (material, geometry-layout) groups.
      const layoutOf = (g) =>
        Object.keys(g.attributes)
          .sort()
          .map((n) => `${n}:${g.attributes[n].itemSize}`)
          .join(',')
      let instMeshes = 0
      const instGroups = new Set()
      window.__oip.view.scene.traverse((o) => {
        if (!o.isInstancedMesh || !o.visible) return
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          if (!m) continue
          instMeshes++
          instGroups.add(`${m.uuid}|${layoutOf(o.geometry)}`)
        }
      })

      return {
        total,
        distinct: groups.size,
        top: sizes.slice(0, 12).map((g) => ({ n: g.n, kb: Math.round((g.vLen + g.fLen) / 1024) })),
        dupes: sizes.filter((g) => g.n > 1).reduce((s, g) => s + (g.n - 1), 0),
        programsV: mapSize(pipes?.programs?.vertex),
        programsF: mapSize(pipes?.programs?.fragment),
        pipelines: mapSize(pipes?.caches),
        instMeshes,
        instDistinct: instGroups.size,
      }
    })

    if (r.error) {
      log(`could not census: ${r.error}`)
      process.exitCode = 1
      return
    }

    log(`demo scene, WebGPU\n`)
    log(`── NodeBuilderState cache (_nodes.nodeBuilderCache) - one entry = one nodeBuilder.build()`)
    log(`   built            ${r.total}`)
    log(`   structurally distinct ${r.distinct}`)
    log(`   REDUNDANT builds ${r.dupes}  (${Math.round((r.dupes / Math.max(r.total, 1)) * 100)}% of the JS TSL work is duplicate)`)
    log(`\n   biggest duplicate groups (count × shader size):`)
    for (const g of r.top) log(`     ${String(g.n).padStart(4)} ×  ${g.kb} KB`)
    log(`\n── GPU side, for contrast`)
    log(`   programs vertex  ${r.programsV}`)
    log(`   programs fragment ${r.programsF}`)
    log(`   render pipelines ${r.pipelines}`)
    const instRedundant = Math.max(0, r.instMeshes - r.instDistinct)
    log(`\n── how much of that redundancy customCacheKey() can actually REACH`)
    log(`   instanced meshes in scene   ${r.instMeshes}`)
    log(`   distinct (material, layout) ${r.instDistinct}`)
    log(`   → ~${instRedundant} redundant builds are forced by RenderObject's per-object \`object.uuid\``)
    log(`     term (RenderObject.js ~833). That is added OUTSIDE any node, so customCacheKey()`)
    log(`     CANNOT collapse them. On the program side three already shares their identical WGSL.`)
    const reachable = Math.max(0, r.dupes - instRedundant)
    log(
      `\n   reachable by customCacheKey(): ~${reachable} of ${r.dupes} redundant builds ` +
        `(${Math.round((reachable / Math.max(r.dupes, 1)) * 100)}%) - structurally identical MATERIAL INSTANCES.`,
    )
  } finally {
    await browser.close()
    prod.close()
  }
}
main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(1)
})
