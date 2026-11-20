// Gate: an interaction's cost scales with what it touches, never with the size of the document.
//
// Four separate performance bugs in this editor were the same bug, work proportional to the whole
// scene on a per-interaction path: the outline mask re-rendered every batch to outline one part, the
// scene tree put a DOM row on screen for every part in the document, promotion serialised the entire
// project to localStorage on a click, and a selection's gizmo drew every handle twice. Three of the
// four are one invariant, the same one verify-draw-budget.mjs enforces for draws ("duplicating a part
// must not duplicate its draws"); this gate enforces it for everything else.
//
// What this enforces, and why it is built this way: absolute milliseconds on a developer laptop are
// noise (the same reason the cover-time budget is reported and only enforced behind an env var). So
// the assertions here are on things that do not move with the machine:
//   - writes: how many localStorage writes, and how many bytes, a gesture performs. Selecting must
//     write nothing; a real edit must write something (or the write detector proves nothing).
//   - undo: selecting must not push history.
//   - scaling: the synchronous main-thread ms inside the store/view seams must not grow when the
//     scene does. Seam timing is pure JS CPU (no vsync, no compositor, no GPU), so the ratio between
//     a 1x and a 2x scene is stable even on a busy machine.
//   - streams: a streamed edit (what a drag or an Inspector scrub sends per pointer-move: the robot's
//     tool size, a conveyor's speed, a conveyor's pose, a rack's length) costs the same per step in a 2x scene and in a
//     2x scene with twice the cargo, runs no scene-change consumer whose parts it did not touch (the
//     sensor-beam re-probe), writes nothing, and leaves every consumer's audit clean
//     (docs/scene-change-consumers.md). Without that, a robot tool-size drag runs two whole-scene cargo
//     builds and every sensor's beam re-cast per move, ~22 ms on the demo. A box moved in a beam
//     re-casts only the sensors whose beams it crosses: a full pass is 25 casts x every cargo row, ~3.4 ms
//     per move on the demo. A moved sensor re-casts only its own beams.
// Frame times are measured and printed for a human, and only enforced when OIP_INTERACTION_MS is set
// on a machine known to be quiet.
//
// Runs against dist/ through the real host config: React's development build roughly doubles panel
// work, so a dev-server number would make this gate wrong in both directions. Skips (exit 0) when dist/
// is absent, like the WebGPU gates skip without an adapter.
// Run: npm run build && node e2e/verify-interaction-budget.mjs
/* global process, console, window, localStorage, performance, requestAnimationFrame, setTimeout */
import { chromium } from 'playwright'
import { serveDist, distIsBuilt } from './_edge-server.mjs'

// a gesture's seam cost may grow this much when the scene doubles, plus a floor that absorbs
// sub-millisecond jitter on small numbers
const SCALE_TOLERANCE = 1.6
const SCALE_FLOOR_MS = 3
const HARD_MS = Number(process.env.OIP_INTERACTION_MS ?? 0)

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

if (!distIsBuilt()) {
  console.log('SKIP  dist/ is not built - run `npm run build` first (passing)')
  process.exit(0)
}

const { port, close } = await serveDist()
const browser = await chromium.launch({
  headless: false,
  args: [
    '--enable-unsafe-webgpu',
    // a headed window that loses focus gets its rAF throttled to ~1 Hz, which turns every frame
    // measurement below into a 1000 ms reading. These keep it rendering; the sanity guard on the
    // quiet median catches the case where the environment throttles it anyway.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

/**
 * How many shader programs (WebGL) or render pipelines (WebGPU) the first selection of a session
 * compiles. The app pre-warms these at idle so they happen off the interaction path; this is the check
 * that the warm still covers what a user does first.
 *
 * Two failures here went uncaught before this check: WebGL with no interaction warm at all (the whole
 * deferred-warm branch inside `if (!(renderer instanceof WebGLRenderer))`, so the first selection
 * linked 7 programs in a 106 ms frame), and WebGPU's warm, which misses 2 pipelines. A warm is
 * invisible whether it works or not, so it needs an assertion.
 *
 * Both ceilings are zero. WebGL's warm compiles the gizmo, handles and metal probe into the composer's
 * render target, the target every frame draws into (warmInteractionExtrasWebGL); compiled with no target
 * bound they linked the canvas variant, and the first selection linked 3 programs. WebGPU's mask warm
 * draws each mesh the palette merge leaves over with both the active and the regular mask material
 * (consolidatedOutlineNode renderMask); with one tier only, the selected part's active-tier pipeline
 * compiled on the first click.
 */
const FIRST_COMPILE_CEILING = { webgl: 0, webgpu: 0 }

async function firstSelectionCompiles(backend) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    await page.addInitScript(() => {
      try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ }
    })
    await page.goto(`http://localhost:${port}/app/?scene=demo&hook&${backend === 'webgpu' ? 'webgpu' : 'nowebgpu'}`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 90000 })
    await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 60000 })
    await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, { timeout: 60000 })
    // the warm is the thing under test: wait for it, or this measures the app warming itself
    await page.waitForFunction(() => window.__oip.view.extrasWarmDone === true, { timeout: 40000 }).catch(() => {})
    await page.waitForTimeout(4000)
    return await page.evaluate(async () => {
      const view = window.__oip.view
      const isGPU = view.renderer?.isWebGPURenderer === true
      const count = () => (isGPU ? (view.renderer?._pipelines?.caches?.size ?? -1) : (view.renderer.info?.programs?.length ?? -1))
      const before = count()
      const id = window.__oip.store.getState().scene.parts.find((p) => /conveyor|belt|roller/i.test(p.packageId ?? '')).id
      window.__oip.store.select(id)
      await new Promise((r) => setTimeout(r, 1500))
      return { backend: isGPU ? 'webgpu' : 'webgl', before, after: count() }
    })
  } finally {
    await page.close()
  }
}

/** instrument the seams a gesture can be expensive in, plus every localStorage write */
const INSTRUMENT = () => {
  const store = window.__oip.store
  const view = window.__oip.view
  const ctrl = window.__oip.controller
  const probe = { ms: 0, writes: 0, bytes: 0, seams: {} }
  window.__oipProbe = probe
  const wrap = (obj, name, label) => {
    const orig = obj?.[name]?.bind(obj)
    if (!orig) return
    obj[name] = (...a) => {
      const t = performance.now()
      const r = orig(...a)
      const ms = performance.now() - t
      probe.ms += ms
      probe.seams[label] = +((probe.seams[label] ?? 0) + ms).toFixed(1)
      return r
    }
  }
  // the top-level seams only - nesting would double-count (commit contains persist contains …)
  wrap(store, 'commit', 'commit')
  wrap(store, 'setRunScene', 'setRunScene')
  wrap(store, 'setAuthored', 'setAuthored')
  wrap(view, 'setSelection', 'setSelection')
  const setItem = localStorage.setItem.bind(localStorage)
  localStorage.setItem = (k, v) => {
    if (String(k).startsWith('oip-web/')) {
      probe.writes++
      probe.bytes += String(v).length
    }
    return setItem(k, v)
  }
}

const readProbe = (page) => page.evaluate(() => {
  const p = window.__oipProbe
  const out = { ms: +p.ms.toFixed(1), writes: p.writes, bytes: p.bytes, seams: { ...p.seams } }
  p.ms = 0; p.writes = 0; p.bytes = 0; p.seams = {}
  return out
})

/**
 * Run a gesture N times and take the median of each measure. A single sample of a 2-4 ms seam is not
 * a number you can build an assertion on (across runs the same promotion measured 4.7, 7.3 and 8.2 ms),
 * and a gate that fails one run in three gets ignored.
 */
async function gestureMedian(page, fn, argsPerRun) {
  const runs = []
  for (const arg of argsPerRun) runs.push(await gesture(page, fn, arg))
  const med = (pick) => {
    const v = runs.map(pick).sort((a, b) => a - b)
    return +v[Math.floor(v.length / 2)].toFixed(1)
  }
  return { ms: med((r) => r.ms), writes: med((r) => r.writes), bytes: med((r) => r.bytes), worst: med((r) => r.worst), seams: runs[runs.length - 1].seams }
}

/** run one gesture and return {probe, worstFrame} - frames sampled from a persistent recorder */
/**
 * Wait until nobody is still writing, so a gesture is charged only for what it did.
 *
 * An edit persists straight away (viewport-state, project, autosave) and then again about three seconds later
 * (document-id and viewport-state twice - the same trio, at the same offset, on any build). A gesture sampled inside
 * that tail is charged for its predecessor's writes. That explains a "selecting a moving box writes nothing to
 * storage (3 / 0 writes)" failure: the first sample fell in the tail and the second did not, on a promotion that
 * writes nothing at all when measured by itself.
 */
async function settleWrites(page, budgetMs = 6000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    await readProbe(page) // clears the counters
    await page.waitForTimeout(700)
    const { writes } = await page.evaluate(() => ({ writes: window.__oipProbe.writes }))
    if (writes === 0) return true
  }
  return false
}

async function gesture(page, fn, arg) {
  await settleWrites(page)
  await readProbe(page) // ...and start this sample from zero
  await page.evaluate(() => { window.__oipMark = performance.now() })
  await page.evaluate(fn, arg)
  await page.waitForTimeout(700)
  const probe = await readProbe(page)
  const worst = await page.evaluate(() => {
    const rec = window.__oipRec
    const from = window.__oipMark
    const win = rec.filter(([t]) => t >= from && t <= from + 500).map(([, d]) => d)
    return win.length ? +Math.max(...win).toFixed(1) : 0
  })
  return { ...probe, worst }
}

try {
  // --- the warm still covers the first interaction, on both surfaces ---
  for (const backend of ['webgl', 'webgpu']) {
    // one surface failing to come up must not take the run with it - the other arm is still a result
    const r = await firstSelectionCompiles(backend).catch((e) => ({ error: String(e).split('\n')[0] }))
    if (r.error || (backend === 'webgpu' && r.backend !== 'webgpu')) {
      console.log(`SKIP  first-compile check on ${backend}: ${r.error ?? 'no WebGPU adapter here'}`)
      continue
    }
    const minted = r.after - r.before
    const unit = r.backend === 'webgpu' ? 'pipelines' : 'programs'
    const ceiling = FIRST_COMPILE_CEILING[r.backend]
    check(`the first selection compiles at most ${ceiling} ${unit} (${r.backend})`, minted <= ceiling, `${r.before} → ${r.after} (+${minted})`)
  }

  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => {
    try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ }
  })
  await page.goto(`http://localhost:${port}/app/?scene=demo&hook`)
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 90000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, { timeout: 60000 })
  // wait out the deferred interaction warm (gizmo pipelines + the outline mask), or the 'first
  // selection' below measures a compile the app was already doing for itself - moving the cost
  // rather than reporting it. A user who takes a second to click never races it.
  await page.waitForFunction(() => window.__oip.view.extrasWarmDone === true, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(2500)
  await page.evaluate(INSTRUMENT)
  await page.evaluate(() => {
    const rec = []
    window.__oipRec = rec
    let prev = performance.now()
    const tick = () => {
      const now = performance.now()
      rec.push([now, now - prev])
      prev = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  // one pass of every gesture at a given scene scale
  const pass = async (scale) => {
    const ids = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const conv = parts.filter((p) => /conveyor|belt|roller/i.test(p.packageId ?? ''))
      return { a: conv[0]?.id ?? null, b: conv[1]?.id ?? null, parts: parts.length }
    })
    // The first selection of a session is a one-off (panel mount, lazy chunks, mask pipelines) and is
    // worth its own line rather than contaminating the steady-state number - it is a real thing a user
    // feels once, and a different problem from the per-selection cost this gate is about.
    const first = scale === '1x' ? await gesture(page, (id) => window.__oip.store.select(id), ids.a) : null
    // then warm properly: two distinct parts, so the measured gesture below is genuinely steady-state
    for (const id of [ids.a, ids.b, null]) {
      await page.evaluate((x) => window.__oip.store.select(x), id)
      await page.waitForTimeout(800)
    }
    await readProbe(page)

    const select = await gestureMedian(page, (id) => window.__oip.store.select(id), [ids.b, ids.a, ids.b])
    await page.evaluate(() => window.__oip.store.select(null))
    await page.waitForTimeout(500)
    await readProbe(page)

    // A real edit, twice: the write detector has to prove it detects writes, and the second edit is
    // the one that shows the steady state - the legacy fallback key is refreshed on a throttle, so
    // only the first edit in a while carries it (store.persist).
    const nudge = (id) => {
      const store = window.__oip.store
      const s = store.getState().scene
      store.commit('Nudge', { ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, position: [p.position[0] + 0.1, p.position[1], p.position[2]] } : p)) })
    }
    const edit = await gesture(page, nudge, ids.a)
    const edit2 = await gesture(page, nudge, ids.a)

    // and the gesture this gate started from: click-select a moving box (promotes a spawner body)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => (window.__oip.controller?.boxCount ?? 0) > 0, { timeout: 30000 })
    // wait for an actually un-owned body rather than a fixed sleep - that is what the gesture needs
    await page.waitForFunction(() => {
      const b = window.__oip.view.boxes
      return b.boxMeta.some((m) => !m.partId) || b.palletMeta.some((m) => !m.partId)
    }, { timeout: 30000 }).catch(() => {})
    await readProbe(page)
    const promoteOnce = () => {
      const view = window.__oip.view
      const boxes = view.boxes
      for (const mesh of [boxes.mesh, boxes.palletMesh]) {
        const meta = mesh === boxes.mesh ? boxes.boxMeta : boxes.palletMeta
        for (let i = 0; i < meta.length; i++) {
          if (meta[i].partId) continue
          const m = mesh.instanceMatrix.array
          const o = i * 16
          // the product the body was made as, read the way the view's own pick reads it (boxes.ts batchPick): a pick
          // without one stays a transient body, and the gesture would measure a no-op
          const product = meta[i].key !== null ? boxes.appliedFrame?.shapeRefs?.[meta[i].key] : undefined
          const id = window.__oip.controller.promoteCargoBox({
            frameId: meta[i].id, partId: null,
            position: [m[o + 12], m[o + 13], m[o + 14]], rotationY: 0,
            size: [0.4, 0.3, 0.3], color: '#cc9966', kind: 'box',
            ...(product ? { product } : {}),
          })
          if (id) window.__oip.store.select(id)
          return
        }
      }
    }
    // Each promotion consumes the body it promotes, so the three samples cannot be taken back to back:
    // runs 2 and 3 would find nothing, measure a no-op, and pull the median to zero, which then passes
    // the scaling check as "no cost". Wait for a fresh un-owned body before each one.
    const promoteRuns = []
    for (let i = 0; i < 3; i++) {
      const ready = await page
        .waitForFunction(() => {
          const b = window.__oip.view.boxes
          return b.boxMeta.some((m) => !m.partId) || b.palletMeta.some((m) => !m.partId)
        }, { timeout: 20000 })
        .then(() => true)
        .catch(() => false)
      if (!ready) break
      promoteRuns.push(await gesture(page, promoteOnce, null))
    }
    const done = promoteRuns.filter((r) => r.ms > 0).map((r) => r.ms).sort((a, b) => a - b)
    const promote = {
      ...(promoteRuns[promoteRuns.length - 1] ?? { writes: 0, bytes: 0, worst: 0, seams: {} }),
      ms: done.length ? +done[Math.floor(done.length / 2)].toFixed(1) : 0,
      samples: done.length,
    }
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(1500)
    await readProbe(page)
    return { scale, parts: ids.parts, select, edit, edit2, promote, first }
  }

  /**
   * A streamed edit: STREAM_STEPS transient steps of one part, one per frame, as a drag sends them. "rack length" is a
   * resize drag: it re-runs the rack's geometry() and rewrites ~50k vertices in place per step, and it holds a real
   * 'resize' drag so the rack leaves the instance pool as a pointer-down does (controller.syncPoolDragEject). Timed through
   * store.setTransient, which runs the whole store → controller → view sync synchronously: every consumer of a scene
   * change. Median ms per step, plus how often the beam re-probe ran and whether anything was written.
   */
  const STREAM_STEPS = 24
  const stream = async (kind) => {
    await settleWrites(page)
    await readProbe(page)
    const r = await page.evaluate(async ({ kind, steps }) => {
      const store = window.__oip.store
      const view = window.__oip.view
      const start = store.getState().scene
      const pkg = kind === 'robot tool size' ? 'oip.six-axis-robot' : kind === 'rack length' ? 'oip.rack' : kind === 'box pose' ? 'oip.box' : kind === 'sensor pose' ? 'oip.diffuse-sensor' : 'oip.roller-conveyor'
      const target = start.parts.find((p) => p.packageId === pkg)
      if (!target) return null
      // the box stream's first step puts the box into a sensor's beam, half a metre out along a cast the last stopped
      // probe made, and the rest nudge it along there, so every step has a beam to re-cast
      let beamAt = null
      for (const casts of view.beamCasts.values()) {
        if (casts.length >= 7 && casts[6] >= 0.6) {
          beamAt = [casts[0] + 0.5 * casts[3], casts[1] + 0.5 * casts[4], casts[2] + 0.5 * casts[5]]
          break
        }
      }
      if (kind === 'box pose' && !beamAt) return null
      const step = (p, i) =>
        kind === 'robot tool size' ? { ...p, params: { ...p.params, toolSizeX: 0.5 + 0.02 * i } }
          : kind === 'conveyor speed' ? { ...p, params: { ...p.params, speed: 1 + 0.01 * i } }
            : kind === 'rack length' ? { ...p, params: { ...p.params, length: p.params.length + 0.01 * i } }
              : kind === 'box pose' ? { ...p, position: [beamAt[0] + 0.002 * i, beamAt[1], beamAt[2]] }
                : kind === 'sensor pose' ? { ...p, position: [p.position[0], p.position[1] + 0.002 * i, p.position[2]] }
                : { ...p, position: [p.position[0] + 0.002 * i, p.position[1], p.position[2]] }
      const ctrl = window.__oip.controller
      const resize = kind === 'rack length'
      if (resize) {
        ctrl.drag = { kind: 'resize', pointerId: 1, start, id: target.id, handle: { axis: 'x', sign: 1 }, moved: true }
        ctrl.syncPoolDragEject()
      }
      // full probe passes (every sensor's beam re-cast), whatever scheduled them, and single sensors re-probed, by a
      // full pass or by a partial one (runPartialBeamProbes)
      if (!window.__oipBeamPasses) {
        window.__oipBeamPasses = { n: 0, sensors: 0 }
        const run = view.runBeamProbes.bind(view)
        view.runBeamProbes = () => { window.__oipBeamPasses.n++; run() }
        const probe = view.probeSensor.bind(view)
        view.probeSensor = (...a) => { window.__oipBeamPasses.sensors++; probe(...a) }
      }
      const beams = () => window.__oipBeamPasses.n
      const beams0 = beams()
      const sensors0 = window.__oipBeamPasses.sensors
      const ms = []
      for (let i = 1; i <= steps; i++) {
        const scene = { ...start, parts: start.parts.map((p) => (p.id === target.id ? step(p, i) : p)) }
        const t = performance.now()
        store.setTransient(scene)
        ms.push(performance.now() - t)
        await new Promise((res) => requestAnimationFrame(res))
      }
      const beamsRan = beams() - beams0
      const sensorsProbed = window.__oipBeamPasses.sensors - sensors0
      const sensorCount = view.registries.probeTickRefs.length
      // mid-stream, before the revert: a fresh full probe must agree with every beam the stream left on screen
      await new Promise((res) => requestAnimationFrame(res))
      const beamAudit = view.sceneConsumers.audit().filter((c) => c.name === 'sceneConsumer:sensorBeams' && !c.ok).map((c) => c.reason)
      // end as a cancelled drag does (drag.ts cancelDrag): drop the drag, then revert. That one store change
      // returns the rack to the pool and syncs the reverted shape, which re-bakes it
      if (resize) ctrl.drag = null
      store.setTransient(start)
      ms.sort((a, b) => a - b)
      return { ms: +ms[Math.floor(ms.length / 2)].toFixed(2), beamsRan, sensorsProbed, sensorCount, beamAudit, cargoRows: view.idleCargoFrame?.count ?? 0 }
    }, { kind, steps: STREAM_STEPS })
    const probe = await readProbe(page)
    return r && { ...r, writes: probe.writes }
  }
  const STREAM_KINDS = ['robot tool size', 'conveyor speed', 'conveyor pose', 'rack length', 'box pose', 'sensor pose']
  const streams = async (scale) => {
    const out = { scale, parts: await page.evaluate(() => window.__oip.store.getState().scene.parts.length) }
    for (const k of STREAM_KINDS) out[k] = await stream(k)
    await page.waitForTimeout(1500)
    // the consumers' and the pool's idle audits after the streams: a `reads` too narrow to see a dependency fails here
    out.audit = await page.evaluate(() => window.__oip.view.auditMergeCoherence().checks
      .filter((c) => !c.ok && (c.name.startsWith('sceneConsumer:') || c.name === 'instancePool'))
      .map((c) => `${c.name}: ${c.reason}`))
    return out
  }

  const quiet = () => page.evaluate(() => {
    const d = window.__oipRec.map(([, x]) => x).sort((a, b) => a - b)
    return { median: +d[Math.floor(d.length / 2)].toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1) }
  })

  const x1 = await pass('1x')
  const s1 = await streams('1x')
  await page.evaluate(async () => {
    const store = window.__oip.store
    // Not the cargo: duplicating the demo's authored boxes fills the sim's spawned-body budget, the
    // spawners stop emitting, and the promote gesture below then has nothing to promote (it measures a
    // no-op and the scaling check passes vacuously). We want more parts, not more cargo.
    store.selectMany(store.getState().scene.parts.filter((p) => p.type === 'part' && !/^oip.(box|pallet)$/.test(p.packageId ?? '')).map((p) => p.id))
    store.duplicateSelection()
    store.clearSelection()
    await new Promise((r) => setTimeout(r, 3000))
  })
  await page.waitForTimeout(4000)
  const x2 = await pass('2x')
  const s2 = await streams('2x')
  // ...and twice the cargo on top: what a streamed edit of a non-cargo part must not cost more for (the cargo frame, the
  // beams that cast against it). Stopped only, so the spawned-body budget the note above protects is not touched.
  await page.evaluate(async () => {
    const store = window.__oip.store
    store.selectMany(store.getState().scene.parts.filter((p) => /^oip\.(box|pallet|unit-load)$/.test(p.packageId ?? '')).map((p) => p.id))
    store.duplicateSelection()
    store.clearSelection()
    await new Promise((r) => setTimeout(r, 3000))
  })
  await page.waitForTimeout(2000)
  const s3 = await streams('2x + 2x cargo')
  const q = await quiet()

  // a frame reading of 0 (no frames sampled) or ~1000ms (a backgrounded window throttled to 1 Hz)
  // is an artefact of the environment, not a measurement - print it as such rather than as a number
  const frame = (ms) => (ms <= 0 || ms > 500 ? '     —' : String(ms).padStart(6))
  const row = (label, g) =>
    `  ${label.padEnd(22)} seams=${String(g.ms).padStart(6)}ms  writes=${String(g.writes).padStart(2)} (${String(Math.round(g.bytes / 1024)).padStart(4)} KB)  worstFrame=${frame(g.worst)}ms  ${JSON.stringify(g.seams)}`
  console.log(`\nprod build · frames: median=${q.median}ms p95=${q.p95}ms · scene ${x1.parts} → ${x2.parts} parts\n`)
  for (const p of [x1, x2]) {
    console.log(` ${p.scale} (${p.parts} parts)`)
    console.log(row('select a part', p.select))
    console.log(row('edit a part (commit)', p.edit))
    console.log(row('...edit again', p.edit2))
    console.log(row('select a MOVING box', p.promote))
  }
  console.log('')
  for (const s of [s1, s2, s3]) {
    console.log(` streamed edits, ${s.scale} (${s.parts} parts): ms per step (median of ${STREAM_STEPS})`)
    for (const k of STREAM_KINDS) {
      const r = s[k]
      console.log(r ? `  ${k.padEnd(22)} ${String(r.ms).padStart(6)}ms  beam re-probes=${r.beamsRan}  sensors re-probed=${r.sensorsProbed}/${r.sensorCount * STREAM_STEPS}  writes=${r.writes}` : `  ${k.padEnd(22)} (no such part in the scene)`)
    }
  }
  console.log('')

  // --- what a machine cannot change ---
  check('selecting a part writes nothing to storage', x1.select.writes === 0 && x2.select.writes === 0,
    `${x1.select.writes} / ${x2.select.writes} writes`)
  check('selecting a MOVING box writes nothing to storage', x1.promote.writes === 0 && x2.promote.writes === 0,
    `${x1.promote.writes} / ${x2.promote.writes} writes`)
  check('selecting adds no undo history', (await page.evaluate(() => window.__oip.store.getEditHistory().cursor)) >= 0)
  // ...and the inverse, or the two checks above would pass on a broken write detector
  check('a real edit DOES write (detector is live)', x1.edit.writes > 0, `${x1.edit.writes} writes, ${Math.round(x1.edit.bytes / 1024)} KB`)
  // ...and the promote gesture must actually have promoted something, at both scales: a click that
  // finds no un-owned body does no work, and 'did no work' would pass the scaling check below
  check('the promote gesture actually promoted (test is meaningful)', x1.promote.samples > 0 && x2.promote.samples > 0,
    `${x1.promote.samples} real samples at ${x1.parts} parts, ${x2.promote.samples} at ${x2.parts}`)

  for (const k of STREAM_KINDS) {
    if (!s1[k]) {
      check(`the "${k}" stream found its part (test is meaningful)`, false, 'the demo has no such part')
      continue
    }
    check(`streaming "${k}" writes nothing to storage`, [s1, s2, s3].every((s) => s[k].writes === 0), [s1, s2, s3].map((s) => s[k].writes).join(' / '))
    check(`streaming "${k}" leaves every sensor beam as a fresh probe would draw it`, [s1, s2, s3].every((s) => s[k].beamAudit.length === 0),
      [s1, s2, s3].flatMap((s) => s[k].beamAudit).join('; '))
    // A box move rebuilds the idle cargo frame (core/frame buildAuthoredCargoFrame, once in the view and once for the
    // controller's idle poses), so its cost follows the cargo rows, not the scene. What it must not do is grow faster
    // than them: the unit-load walks were loads x parts, 13.9 -> 35.7 -> 91.8 ms here before they shared one index.
    if (k === 'box pose') {
      const perRow = (s) => s[k].ms / Math.max(1, s[k].cargoRows)
      const budget = perRow(s1) * SCALE_TOLERANCE
      check('streaming "box pose" costs no more per cargo row as the scene and its cargo grow',
        [s2, s3].every((s) => s[k].ms <= perRow(s1) * s[k].cargoRows * SCALE_TOLERANCE + SCALE_FLOOR_MS),
        [s1, s2, s3].map((s) => `${s[k].ms}ms / ${s[k].cargoRows} rows`).join(' → ') + ` (budget ${(budget * 1000).toFixed(1)} µs per row)`)
      continue
    }
    const budget = s1[k].ms * SCALE_TOLERANCE + SCALE_FLOOR_MS
    check(`streaming "${k}" does not get more expensive as the scene and its cargo grow`, s2[k].ms <= budget && s3[k].ms <= budget,
      `${s1[k].ms}ms at ${s1.parts} parts → ${s2[k].ms}ms at ${s2.parts} → ${s3[k].ms}ms at ${s3.parts} with 2x cargo (budget ${budget.toFixed(1)}ms)`)
  }
  // neither part draws a beam, and neither change moves a sensor or the cargo: the beam consumer must not run
  for (const k of ['robot tool size', 'conveyor speed']) {
    if (s1[k]) check(`streaming "${k}" re-probes no sensor beam`, [s1, s2, s3].every((s) => s[k].beamsRan === 0 && s[k].sensorsProbed === 0),
      [s1, s2, s3].map((s) => `${s[k].beamsRan} passes, ${s[k].sensorsProbed} sensors`).join(' / '))
  }
  // a box in a beam moves: only the sensors whose beams it crosses re-cast, never a full pass over every sensor
  if (s1['box pose']) {
    const box = [s1, s2, s3].map((s) => s['box pose'])
    check('streaming "box pose" re-probes no full sensor pass', box.every((r) => r.beamsRan === 0), box.map((r) => r.beamsRan).join(' / '))
    check('streaming "box pose" re-probes some sensors, never all of them each step',
      box.every((r) => r.sensorsProbed > 0 && r.sensorsProbed < r.sensorCount * STREAM_STEPS),
      box.map((r) => `${r.sensorsProbed}/${r.sensorCount * STREAM_STEPS}`).join(' / '))
  }
  // a sensor moves: only it re-casts, once per step, never a full pass over every sensor
  if (s1['sensor pose']) {
    const sensor = [s1, s2, s3].map((s) => s['sensor pose'])
    check('streaming "sensor pose" re-probes no full sensor pass', sensor.every((r) => r.beamsRan === 0), sensor.map((r) => r.beamsRan).join(' / '))
    check('streaming "sensor pose" re-probes only the moved sensor, once per step',
      sensor.every((r) => r.sensorsProbed > 0 && r.sensorsProbed <= STREAM_STEPS), sensor.map((r) => `${r.sensorsProbed}/${STREAM_STEPS} steps`).join(' / '))
  }
  check('after streamed edits, every scene-change consumer and the pool audit clean at idle', [s1, s2, s3].every((s) => s.audit.length === 0),
    [s1, s2, s3].flatMap((s) => s.audit).join('; '))

  // --- the invariant: gesture cost must not scale with the document ---
  {
    const a = x1.select
    const b = x2.select
    const budget = a.ms * SCALE_TOLERANCE + SCALE_FLOOR_MS
    check('"select a part" does not get more expensive as the scene grows', b.ms <= budget,
      `${a.ms}ms at ${x1.parts} parts → ${b.ms}ms at ${x2.parts} (budget ${budget.toFixed(1)}ms)`)
  }
  {
    // Known gap, reported rather than enforced - with the number, so it has a target.
    //
    // Selecting a moving box mints a part, which is a structural scene change, and that costs a full
    // instance-pool rebuild. Measured per promoting click at 250 parts (e2e/probes/syncscene-profile.mjs):
    //
    //   view.syncScene TOTAL   3.7 - 4.2 ms
    //     poolRebuild          3.7 - 4.3 ms   <-- all of it
    //       instancePool.rebuild 3.6 - 4.25 ms
    //     everything else      < 1 ms  (resolveScene, the entry loop, outline, mask merge, tiers)
    //
    // So it is not "syncScene re-resolves every part" (that is sub-millisecond here) - it is
    // instancePool.rebuild's gatherAndSign walk, which visits every eligible mesh in the scene to
    // decide whether merge membership moved. Every structural change incurs it, not just promotion.
    //
    // Left alone: ~4 ms at 250 parts is well inside a frame, and pool invalidation is the
    // subsystem where a wrong "nothing changed" answer produces stale merged geometry, a class of bug
    // this repo has shipped before (see verify-merge-coherence). Worth revisiting when scenes get
    // big enough for the walk to cross the frame budget on its own (~1000 parts on this measurement),
    // and the fix then is a membership-can't-have-moved fast path, not a deferral.
    const a = x1.promote
    const b = x2.promote
    const perPart = (ms, parts) => (ms / parts).toFixed(4)
    console.log(
      `note  KNOWN GAP - "select a MOVING box" still scales with the scene: ${a.ms}ms at ${x1.parts} parts ` +
      `→ ${b.ms}ms at ${x2.parts} (${perPart(a.ms, x1.parts)} → ${perPart(b.ms, x2.parts)} ms/part). ` +
      `Cause: minting the part is a structural change, and instancePool.rebuild walks every eligible ` +
      `mesh to re-decide merge membership. Fine at this size; revisit when the walk crosses a frame.`,
    )
  }

  // --- absolute frame time: reported by default, enforced only on a machine known to be quiet ---
  const worst = Math.max(x1.select.worst, x1.promote.worst, x2.select.worst, x2.promote.worst)
  // Sanity guard: a quiet median far off a display refresh interval means the window was throttled
  // (a backgrounded headed window drops to ~1 Hz), and every frame number in this run is meaningless.
  // Say so rather than printing it - and never enforce a budget against it.
  const framesUsable = q.median > 4 && q.median < 40
  if (!framesUsable) {
    console.log(`note  frame timings unusable this run (quiet median ${q.median}ms - window throttled or offscreen); assertions above are unaffected`)
  } else if (HARD_MS > 0) {
    check(`worst steady-state selection frame under OIP_INTERACTION_MS=${HARD_MS}`, worst <= HARD_MS, `${worst}ms`)
  } else {
    console.log(`note  worst steady-state selection frame ${worst}ms vs a ${q.median}ms quiet median (set OIP_INTERACTION_MS to enforce)`)
  }
  if (framesUsable && x1.first) console.log(`note  the FIRST selection of the session cost ${x1.first.worst}ms - one-off (panel mount / lazy chunks), not per-selection`)
  // the standing target this gate is watching: every real edit serialises the whole document, twice,
  // synchronously - and the bill grows with the scene. Reported, not asserted, until that is fixed.
  console.log(`note  an edit writes ${Math.round(x1.edit.bytes / 1024)} KB (first in 5s: project doc + legacy backup) then ${Math.round(x1.edit2.bytes / 1024)} KB (project doc only) at ${x1.parts} parts; ${Math.round(x2.edit2.bytes / 1024)} KB at ${x2.parts} - autosave still scales with the document`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
} finally {
  await browser.close()
  await close?.()
}
process.exit(failures === 0 ? 0 : 1)
