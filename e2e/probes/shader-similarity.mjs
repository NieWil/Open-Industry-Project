/* global console, process, window, document, performance, localStorage */
// Diagnostic: which of the demo scene's distinct WGSL shaders are near-duplicates, i.e. which
// materials are close enough that we should combine them?
//
// `e2e/probes/pipeline-variants.mjs` answers the state question (one shader pair, N pipelines, split by
// side/vertex-layout/...). It stops at "103 distinct shader pairs vs WebGL's 50 linked programs" and
// attributes the remaining ~2x to "the node system emits more distinct shaders", without checking
// whether those shaders actually differ. This script checks that.
//
// Each distinct shader costs ~85 ms of Dawn pool work (isolated) at load, every load, so two shaders
// that differ only in a constant waste ~85 ms and could become one shader with a uniform.
//
// Method:
//   1. Arm `Nodes.getForRender` before the staged pre-warm (the `__oip.view` setter trick from
//      e2e/probes/codegen-cost.mjs) so every produced shader is tagged with its provenance: the material
//      type/name, the owning part, the geometry attributes, the render context. Without this a
//      cluster is a wall of WGSL you cannot act on.
//   2. After settle, read the live program caches (`_pipelines.programs.{vertex,fragment}`) and the
//      render-pipeline cache, so each distinct shader carries the pipeline count it is responsible
//      for: the cost of not combining it.
//   3. Collapse the codes under three progressively more forgiving canonicalizations and report the
//      delta at each step. The delta is the possible saving, attributed to a cause:
//        exact            -> what we compile today
//        ids normalized   -> differs only in three's generated node ids (a keying artifact)
//        numbers too      -> differs only in literal constants (move it to a uniform = one shader)
//   4. Whatever canonicalization does not catch, cluster by line-level Jaccard and print the actual
//      differing lines, so "close enough" is a judgement made on evidence rather than a similarity
//      score.
//
// Usage: node e2e/probes/shader-similarity.mjs [--sim 0.9] [--dump <clusterId>] ["&extraQuery"]
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const flagNum = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}
const flagStr = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const extraQuery = process.argv.slice(2).find((a) => a.startsWith('&')) ?? ''

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
  return null
}

/**
 * Init script: tag every built shader with where it came from. Armed via a `view` setter on the
 * `__oip` hook so the patch lands in the same synchronous task the RenderView is published in -
 * ahead of the staged pre-warm, which is where most shaders are built.
 */
function initProbe() {
  const probe = { armed: false, byCode: {} }
  window.__shaderProv = probe
  const norm = (s) => (typeof s === 'string' ? s.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N') : '')

  const provOf = (ro) => {
    const mat = ro?.material
    const obj = ro?.object
    // parts tag their root with userData.partId; the drawable is usually a descendant, so walk up
    let partId = ''
    let partType = ''
    let node = obj
    for (let i = 0; i < 8 && node && !partId; i++) {
      partId = node.userData?.partId ?? ''
      partType = node.userData?.partType ?? node.userData?.kind ?? partType
      node = node.parent
    }
    const attrs = Object.keys(ro?.geometry?.attributes ?? {}).sort().join('+')
    return [
      mat?.type ?? '?',
      mat?.name || '(unnamed)',
      obj?.isInstancedMesh ? 'Instanced' : (obj?.type ?? '?'),
      obj?.name || '',
      partType || '',
      partId || '',
      attrs,
      `ctx${ro?.context?.id ?? -1}`,
    ].join(' | ')
  }

  function patch(view) {
    if (probe.armed) return
    const nodes = view?.renderer?._nodes
    if (!nodes || typeof nodes.getForRender !== 'function') return
    probe.armed = true
    const orig = nodes.getForRender.bind(nodes)
    nodes.getForRender = (ro) => {
      const state = orig(ro)
      try {
        const p = provOf(ro)
        for (const code of [norm(state?.vertexShader), norm(state?.fragmentShader)]) {
          if (!code) continue
          const bucket = (probe.byCode[code] ??= {})
          bucket[p] = (bucket[p] ?? 0) + 1
        }
      } catch {
        /* provenance is best-effort; never break the render path */
      }
      return state
    }
  }

  let hook
  Object.defineProperty(window, '__oip', {
    configurable: true,
    get: () => hook,
    set(val) {
      if (val && !val.__armed) {
        Object.defineProperty(val, '__armed', { value: true, enumerable: false })
        let v
        Object.defineProperty(val, 'view', {
          configurable: true,
          enumerable: true,
          get: () => v,
          set(nv) {
            v = nv
            try {
              patch(nv)
            } catch {
              /* leave unarmed; reported below */
            }
          },
        })
      }
      hook = val
    },
  })
}

/**
 * Runs in the page. Canonicalizes + clusters the live shader caches and returns summaries only -
 * the raw WGSL is megabytes and never crosses the bridge unless --dump asks for one cluster.
 */
function analyse(simThreshold) {
  const r = window.__oip.view.renderer
  const P = r._pipelines
  const prov = window.__shaderProv

  // --- pipelines per shader id, from the render-pipeline cache keys (`vId,fId,<state...>`) ---
  const pipesByProgram = new Map()
  for (const key of P.caches.keys()) {
    const [v, f] = String(key).split(',')
    for (const id of [v, f]) pipesByProgram.set(id, (pipesByProgram.get(id) ?? 0) + 1)
  }

  const ws = (s) => s.replace(/\s+/g, ' ').trim()
  const canon = {
    // three mints a fresh id per node instance, so a generated struct/var name differing is a
    // keying artifact, not a different shader (NodeBuffer_<id> is three 0.186 and earlier).
    ids: (s) => s.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N').replace(/\bnodeUniform(?:s)?_?\d+\b/g, 'nodeUniform_N'),
    // ...and then: two shaders identical except for literal constants are one shader plus a uniform.
    nums: (s) => s.replace(/\b\d+\.\d+(?:e[-+]?\d+)?\b/gi, '#f').replace(/\b\d+u?\b/g, '#i'),
    // ...and then the DoubleSide normal flip. three's node system does not express `side` as pure
    // pipeline state: a DoubleSide material takes `front_facing` as a fragment input and negates the
    // geometric normal with it, so it emits a different shader from the FrontSide twin. That is
    // separate from the `side` pipeline-state axis (closed as a dead end): this one costs a
    // distinct compile, not just a distinct pipeline. Neutralising it measures the saving from
    // "make the closed-geometry materials FrontSide".
    side: (s) =>
      ws(s)
        .replace(/\( normalViewGeometry \* vec3<f32>\( \( \( f32\( isFront \) \* 2\.0 \) - 1\.0 \) \) \)/g, 'normalViewGeometry')
        .replace(/@builtin\( front_facing \) isFront : bool/g, '')
        .replace(/,\s*,/g, ',')
        .replace(/\(\s*,/g, '(')
        .replace(/,\s*\)/g, ')'),
  }

  const lineSet = (code) => {
    const m = new Map()
    for (const raw of code.split('\n')) {
      const l = raw.trim().replace(/\s+/g, ' ')
      if (!l || l === '{' || l === '}') continue
      m.set(l, (m.get(l) ?? 0) + 1)
    }
    return m
  }
  const jaccard = (a, b) => {
    let inter = 0
    let union = 0
    for (const [l, n] of a) {
      const o = b.get(l) ?? 0
      inter += Math.min(n, o)
      union += Math.max(n, o)
    }
    for (const [l, n] of b) if (!a.has(l)) union += n
    return union === 0 ? 1 : inter / union
  }

  const out = { armed: !!prov?.armed, stages: {}, totals: {}, remap: {} }
  for (const stage of ['vertex', 'fragment']) {
    const map = P.programs?.[stage]
    if (!map) continue
    const progs = []
    for (const [code, st] of map.entries()) {
      progs.push({
        id: String(st.id),
        stage,
        len: code.length,
        lines: code.split('\n').length,
        pipelines: pipesByProgram.get(String(st.id)) ?? 0,
        usedTimes: st.usedTimes ?? 0,
        provs: Object.entries(prov?.byCode?.[code] ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${n}x ${k}`),
        code,
      })
    }

    // --- collapse under each canonicalization; the delta is the saving, attributed ---
    const collapse = (fn) => {
      const g = new Map()
      for (const p of progs) {
        const k = fn(p.code)
        if (!g.has(k)) g.set(k, [])
        g.get(k).push(p)
      }
      return g
    }
    // canon.side must run before canon.nums. The flip it rewrites contains the literals 2.0 and 1.0,
    // which canon.nums would already have turned into `#f`, so running it second matches nothing and
    // the side row reads identical to the constants row.
    const gIds = collapse((s) => canon.ids(s))
    const gNums = collapse((s) => canon.nums(canon.ids(s)))
    const gSide = collapse((s) => canon.nums(canon.side(canon.ids(s))))

    // --- everything canonicalization did not catch: greedy line-similarity clusters ---
    const reps = [...gNums.values()].map((v) => v.sort((a, b) => b.pipelines - a.pipelines)[0])
    const sets = new Map(reps.map((p) => [p.id, lineSet(p.code)]))
    const taken = new Set()
    const simClusters = []
    for (const a of [...reps].sort((x, y) => y.len - x.len)) {
      if (taken.has(a.id)) continue
      const members = [a]
      taken.add(a.id)
      for (const b of reps) {
        if (taken.has(b.id)) continue
        const s = jaccard(sets.get(a.id), sets.get(b.id))
        if (s >= simThreshold) {
          taken.add(b.id)
          members.push({ ...b, sim: s })
        }
      }
      if (members.length > 1) simClusters.push(members)
    }

    const diffOf = (ca, cb) => {
      const a = lineSet(ca)
      const b = lineSet(cb)
      const onlyA = []
      const onlyB = []
      for (const [l, n] of a) if ((b.get(l) ?? 0) < n) onlyA.push(l)
      for (const [l, n] of b) if ((a.get(l) ?? 0) < n) onlyB.push(l)
      return { onlyA: onlyA.slice(0, 6), onlyB: onlyB.slice(0, 6), nA: onlyA.length, nB: onlyB.length }
    }
    const describe = (groups, limit) =>
      [...groups.values()]
        .filter((v) => v.length > 1)
        .sort((a, b) => b.length - a.length)
        .slice(0, limit)
        .map((v) => ({
          n: v.length,
          pipelines: v.reduce((s, p) => s + p.pipelines, 0),
          ids: v.map((p) => p.id),
          lines: v[0].lines,
          provs: [...new Set(v.flatMap((p) => p.provs))].slice(0, 8),
          // a "these differ only in X" group is only useful if it shows which X; without this the
          // reader has to dump two shaders and diff them by hand
          diff: diffOf(v[0].code, v[1].code),
        }))

    // for each sim cluster, the differing lines between its two biggest members. Provenance is
    // reported per member, never unioned: the useful answer is which of the two materials is the odd
    // one out, and a merged owner list hides it.
    const diffs = simClusters.slice(0, 10).map((m) => {
      const a = lineSet(m[0].code)
      const b = lineSet(m[1].code)
      const onlyA = []
      const onlyB = []
      for (const [l, n] of a) if ((b.get(l) ?? 0) < n) onlyA.push(l)
      for (const [l, n] of b) if ((a.get(l) ?? 0) < n) onlyB.push(l)
      return {
        n: m.length,
        sim: Number((m[1].sim ?? 1).toFixed(3)),
        pipelines: m.reduce((s, p) => s + p.pipelines, 0),
        members: m.map((p) => ({ id: p.id, pipelines: p.pipelines, provs: p.provs.slice(0, 5) })),
        onlyA: onlyA.slice(0, 12),
        onlyB: onlyB.slice(0, 12),
        nA: onlyA.length,
        nB: onlyB.length,
      }
    })

    // --- the instance-capacity ladder and what each candidate saves ---
    // three declares the instanceMatrix uniform as `array<mat4x4<f32>, CAP>` inside the WGSL, so two
    // structurally identical banks at different capacities are two different shaders and two cold
    // compiles. No cache key may merge CAP away (a shader may never be bound a buffer
    // smaller than it declares), so the only sound fix is to allocate fewer distinct capacities. This
    // simulates candidate ladders so the saving is known before the work.
    const CAP_RE = /array<\s*mat4x4<f32>,\s*(\d+)\s*>/g
    const capsOf = (code) => [...code.matchAll(CAP_RE)].map((m) => Number(m[1]))
    const capHist = new Map()
    for (const p of progs) for (const c of capsOf(p.code)) capHist.set(c, (capHist.get(c) ?? 0) + 1)
    const ladderTest = (name, fn) => {
      const g = new Set()
      for (const p of progs) g.add(canon.ids(p.code).replace(CAP_RE, (_, n) => `array<mat4x4<f32>, ${fn(Number(n))}>`))
      return { name, distinct: g.size }
    }
    const upTo = (steps) => (n) => steps.find((s) => s >= n) ?? steps[steps.length - 1]
    // Candidate ladders. The trade-off is shader sharing vs the memory of over-allocated instanceMatrix
    // (64 B per unused slot) - see the bank inventory this script also prints. 1024 mat4 = 65536 B is
    // the `maxUniformBufferBindingSize` floor, so no ladder may exceed it.
    const CANDIDATES = [
      ['today', (n) => n],
      ['16/64/256/1024', upTo([16, 64, 256, 1024])],
      ['64/256/1024', upTo([64, 256, 1024])],
      ['128/1024', upTo([128, 1024])],
      ['one bucket (256)', () => 256],
    ]
    const ladders = CANDIDATES.map(([name, fn]) => ladderTest(name, fn))
    // program id -> the id it would share under each candidate ladder, so the pipeline-level saving
    // (~85 ms of Dawn pool work per pipeline) can be computed across both stages below
    for (const [name, fn] of CANDIDATES) {
      const rep = new Map()
      for (const p of progs) {
        const k = canon.ids(p.code).replace(CAP_RE, (_, n) => `array<mat4x4<f32>, ${fn(Number(n))}>`)
        if (!rep.has(k)) rep.set(k, p.id)
        ;(out.remap[name] ??= {})[p.id] = rep.get(k)
      }
    }

    out.stages[stage] = {
      capHist: [...capHist.entries()].sort((a, b) => a[0] - b[0]),
      ladders,
      distinct: progs.length,
      pipelines: progs.reduce((s, p) => s + p.pipelines, 0),
      neverUsed: progs.filter((p) => p.usedTimes === 0).length,
      afterIds: gIds.size,
      afterNums: gNums.size,
      afterSide: gSide.size,
      afterSim: gNums.size - simClusters.reduce((s, m) => s + m.length - 1, 0),
      idGroups: describe(gIds, 6),
      numGroups: describe(gNums, 8),
      sideGroups: describe(gSide, 8),
      simClusters: diffs,
      // biggest single shaders, to size "cheaper" as an alternative to "fewer"
      biggest: progs
        .sort((a, b) => b.len - a.len)
        .slice(0, 6)
        .map((p) => ({ id: p.id, kb: Math.round(p.len / 102.4) / 10, lines: p.lines, pipelines: p.pipelines, prov: p.provs[0] ?? '?' })),
    }
  }
  // --- scene-side audit: which live materials carry the properties the clusters blamed ---
  // A shader-level finding is only actionable if you can name the material to change. FrontSide=0,
  // BackSide=1, DoubleSide=2.
  const owners = (obj) => {
    let n = obj
    for (let i = 0; i < 8 && n; i++) {
      if (n.userData?.partId) return n.userData.partId
      n = n.parent
    }
    return '(no part)'
  }
  const matRows = new Map()
  const scene = window.__oip.view.scene
  // instance-bank inventory: bucketing capacities trades memory for shader sharing, and the trade is
  // only defensible against the real bank count (a 256-slot floor is 16 KB of uniform per bank).
  const banks = { n: 0, capacity: 0, live: 0, caps: {} }
  if (scene?.traverse) {
    scene.traverse((o) => {
      if (o.isInstancedMesh) {
        const cap = o.instanceMatrix?.count ?? 0
        banks.n++
        banks.capacity += cap
        banks.live += o.count ?? 0
        banks.caps[cap] = (banks.caps[cap] ?? 0) + 1
      }
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      for (const m of mats) {
        const k = `${m.type}|${m.name || '(unnamed)'}|side${m.side}|vc${m.vertexColors ? 1 : 0}|transp${m.transparent ? 1 : 0}`
        const row = matRows.get(k) ?? { key: k, type: m.type, name: m.name || '(unnamed)', side: m.side, vc: !!m.vertexColors, n: 0, parts: new Set() }
        row.n++
        row.parts.add(owners(o))
        matRows.set(k, row)
      }
    })
  }
  const allMats = [...matRows.values()].map((r) => ({ ...r, parts: [...r.parts].slice(0, 6), nParts: r.parts.size }))
  out.banks = banks
  out.materials = {
    total: allMats.reduce((s, r) => s + r.n, 0),
    distinct: allMats.length,
    nonFront: allMats.filter((r) => r.side !== 0).sort((a, b) => b.n - a.n),
    vertexColors: allMats.filter((r) => r.vc).sort((a, b) => b.n - a.n),
  }
  // --- pipeline-level saving: re-key the live render-pipeline cache with the merged program ids ---
  // Each pipeline costs ~85 ms of Dawn pool work, so the pipeline count, not the shader count, is
  // what converts to seconds of cover.
  const keys = [...P.caches.keys()].map(String)
  const rekey = (which) => {
    const m = out.remap[which] ?? {}
    return new Set(
      keys.map((k) => {
        const p = k.split(',')
        return [m[p[0]] ?? p[0], m[p[1]] ?? p[1], ...p.slice(2)].join(',')
      }),
    ).size
  }
  out.totals = {
    pipelines: P.caches.size,
    byLadder: Object.fromEntries(Object.keys(out.remap).map((k) => [k, rekey(k)])),
    parts: window.__oip.store.getState().scene.parts.length,
  }
  return out
}

async function main() {
  const simThreshold = flagNum('--sim', 0.9)
  const dumpId = flagStr('--dump')
  const browser = await launch()
  if (!browser) {
    console.log('SKIP: no chromium')
    return
  }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await page.addInitScript(initProbe)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* harmless */
      }
    })
    await page.goto(`${url}?webgpu&scene=demo${extraQuery}`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store), { timeout: 60000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) {
      console.log('SKIP: not webgpu')
      return
    }
    await page
      .waitForFunction(() => document.querySelector('.viewport-cover')?.classList.contains('ready'), { timeout: 90000 })
      .catch(() => {})
    await page.waitForFunction(() => window.__oip?.view?.extrasWarmDone === true, { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(3000)
    // exercise the paths that mint late (mask pass, gizmo) so the census covers a used app
    await page.evaluate(() => window.__oip.store.select(window.__oip.store.getState().scene.parts[0].id)).catch(() => {})
    await page.waitForTimeout(2500)

    const r = await page.evaluate(analyse, simThreshold)
    if (!r.armed) console.log('WARNING: provenance probe never armed - clusters will have no owners\n')

    console.log(`\n=== demo scene, ${r.totals.parts} parts, WebGPU - ${r.totals.pipelines} render pipelines ===`)
    const P0 = r.totals.pipelines
    console.log(`\n   RENDER PIPELINES per candidate capacity ladder (~85 ms of Dawn pool work each):`)
    for (const [name, n] of Object.entries(r.totals.byLadder))
      console.log(`     ${name.padEnd(20)}${String(n).padStart(5)}   ${n < P0 ? `-${P0 - n}   ~${(((P0 - n) * 85) / 1000).toFixed(1)} s of pool work` : ''}`)
    for (const stage of ['vertex', 'fragment']) {
      const s = r.stages[stage]
      if (!s) continue
      console.log(`\n######## ${stage.toUpperCase()} - ${s.distinct} distinct shaders (${s.neverUsed} never drawn) ########`)
      const row = (label, n, note) =>
        console.log(
          `   ${label.padEnd(34)}${String(n).padStart(4)}   ${n < s.distinct ? `-${s.distinct - n}`.padStart(5) : ''.padStart(5)}   ${note}`,
        )
      console.log(`   collapse level                    count   delta   what it means`)
      row('exact (what we compile today)', s.distinct, '')
      row('ignoring generated node ids', s.afterIds, 'keying artifact - free to merge')
      row('...and literal constants', s.afterNums, 'ONE shader + a uniform')
      row('...and the DoubleSide normal flip', s.afterSide, 'make closed geometry FrontSide')
      row(`...and >=${simThreshold} line similarity`, s.afterSim, 'needs a real code change')

      if (s.capHist?.length) {
        console.log(`\n   --- declared instance capacities (array<mat4x4<f32>, N>) ---`)
        console.log(`     ${s.capHist.map(([c, n]) => `${c}:${n}`).join('  ')}   (${s.capHist.length} distinct capacities)`)
        console.log(`     capacity ladder            distinct shaders`)
        for (const l of s.ladders) console.log(`       ${l.name.padEnd(24)}${String(l.distinct).padStart(6)}   ${l.distinct < s.distinct ? `(-${s.distinct - l.distinct})` : ''}`)
      }
      if (s.idGroups.length) {
        console.log(`\n   --- differ ONLY in generated node ids (${s.idGroups.length} groups) ---`)
        for (const g of s.idGroups) {
          console.log(`     ${g.n} shaders / ${g.pipelines} pipelines, ${g.lines} lines`)
          for (const p of g.provs.slice(0, 4)) console.log(`        ${p}`)
        }
      }
      const showDiff = (d) => {
        for (const l of d.onlyA) console.log(`          - ${l.slice(0, 140)}`)
        for (const l of d.onlyB) console.log(`          + ${l.slice(0, 140)}`)
        if (d.nA > d.onlyA.length || d.nB > d.onlyB.length) console.log(`          ... (${d.nA}/${d.nB} differing lines)`)
      }
      if (s.numGroups.length) {
        console.log(`\n   --- differ ONLY in literal constants (${s.numGroups.length} groups) ---`)
        for (const g of s.numGroups) {
          console.log(`     ${g.n} shaders / ${g.pipelines} pipelines, ${g.lines} lines   ids ${g.ids.join(',')}`)
          for (const p of g.provs.slice(0, 3)) console.log(`        ${p}`)
          showDiff(g.diff)
        }
      }
      if (s.sideGroups.length) {
        console.log(`\n   --- differ ONLY in the DoubleSide normal flip (${s.sideGroups.length} groups) ---`)
        for (const g of s.sideGroups) {
          console.log(`     ${g.n} shaders / ${g.pipelines} pipelines, ${g.lines} lines   ids ${g.ids.join(',')}`)
          for (const p of g.provs.slice(0, 3)) console.log(`        ${p}`)
        }
      }
      if (s.simClusters.length) {
        console.log(`\n   --- near-duplicates (line similarity >= ${simThreshold}), with the actual diff ---`)
        for (const c of s.simClusters) {
          console.log(`\n     ${c.n} shaders / ${c.pipelines} pipelines   sim ${c.sim}`)
          c.members.forEach((m, i) => {
            console.log(`       ${i === 0 ? 'A' : i === 1 ? 'B' : ' '} id ${m.id} (${m.pipelines} pipelines)`)
            for (const p of m.provs) console.log(`           ${p}`)
          })
          console.log(`        only in A (${c.nA} lines):`)
          for (const l of c.onlyA) console.log(`          - ${l.slice(0, 150)}`)
          console.log(`        only in B (${c.nB} lines):`)
          for (const l of c.onlyB) console.log(`          + ${l.slice(0, 150)}`)
        }
      }
      console.log(`\n   --- biggest shaders (the "cheaper" lever, vs "fewer") ---`)
      for (const b of s.biggest) console.log(`     ${String(b.kb).padStart(6)} KB  ${String(b.lines).padStart(5)} lines  ${b.pipelines} pipelines  ${b.prov}`)
    }

    const B = r.banks
    if (B?.n) {
      const kb = (slots) => `${Math.round((slots * 64) / 1024)} KB`
      console.log(`\n######## INSTANCE BANKS - ${B.n} meshes, ${B.live} live instances in ${B.capacity} allocated slots (${kb(B.capacity)}) ########`)
      console.log(`   allocated capacities: ${Object.entries(B.caps).sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}:${n}`).join('  ')}`)
      for (const floor of [64, 256, 512]) {
        let slots = 0
        for (const [c, n] of Object.entries(B.caps)) slots += Math.max(Number(c), floor) * n
        console.log(`   if every bank were >= ${String(floor).padStart(3)}:  ${String(slots).padStart(6)} slots  ${kb(slots).padStart(8)}   (+${kb(slots - B.capacity)})`)
      }
    }

    const M = r.materials
    if (M) {
      console.log(`\n######## LIVE MATERIALS - ${M.total} slots, ${M.distinct} distinct signatures ########`)
      console.log(`\n   --- side !== FrontSide (each one emits its own DoubleSide shader) ---`)
      for (const m of M.nonFront)
        console.log(`     ${String(m.n).padStart(4)}x  side=${m.side === 2 ? 'Double' : 'Back'}  ${m.type} "${m.name}"  in ${m.nParts} owners: ${m.parts.join(', ')}`)
      if (!M.nonFront.length) console.log(`     (none)`)
      console.log(`\n   --- vertexColors: true ---`)
      for (const m of M.vertexColors) console.log(`     ${String(m.n).padStart(4)}x  ${m.type} "${m.name}"  in ${m.nParts} owners: ${m.parts.join(', ')}`)
      if (!M.vertexColors.length) console.log(`     (none)`)
    }

    if (dumpId) {
      const code = await page.evaluate((id) => {
        const P = window.__oip.view.renderer._pipelines
        for (const stage of ['vertex', 'fragment']) {
          for (const [c, st] of P.programs[stage].entries()) if (String(st.id) === String(id)) return c
        }
        return null
      }, dumpId)
      console.log(`\n=== WGSL dump for program ${dumpId} ===\n${code ?? '(not found)'}`)
    }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
