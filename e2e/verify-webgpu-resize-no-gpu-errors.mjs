// WebGPU resource-lifetime guard: dragging a procedural part's resize handle must not raise a single
// uncaptured GPU error.
//
// A WebGPU validation error never throws: the device fires `uncapturederror`, three logs it, and
// the frame is silently wrong. Resizing a fence re-emits its geometry on every pointer-move
// (sdk/rigProcedural.ts realizeProceduralGeometry). Disposing the outgoing geometry would destroy GPUBuffers
// that a recorded render bundle still holds by handle. The replay then submits them (hundreds of
// "[Buffer (unlabeled)] used in submit while destroyed"), Dawn rejects the whole command buffer, and
// since the main pass is the only bundled one, everything except the (unbundled) wall + overlay passes
// goes black at a fraction of the normal draw count. No gate that ignores the device notices.
//
// src/render/gpuRetire.ts prevents it (retire, never dispose, until a re-record has happened);
// src/render/gpuErrorWatch.ts makes the failure visible. This asserts both: zero uncaptured
// errors, and a main pass that still draws what it did before the drag.
//
// SKIPs (does not fail) where WebGPU isn't available: the WebGL path has no bundles and no device
// to validate. Run: node e2e/verify-webgpu-resize-no-gpu-errors.mjs [--headed]
/* global process, console, window, localStorage, requestAnimationFrame */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
const STEPS = 14 // small steps, like a real drag: one geometry re-emit per move
const METRES = 4 // total extend distance

let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

const drawsOf = (page) => page.evaluate(() => {
  const info = window.__oip.view.renderer.info.render
  return info.drawCalls ?? info.calls
})

// `installed: false` matters as much as the count: a watch that never attached would make every
// "no GPU errors" assertion below vacuously true, and the gate would check nothing
const gpuErrors = (page) => page.evaluate(() => {
  const r = globalThis.__oipGpuErrors
  if (!r) return { installed: false, count: 0, distinct: [] }
  return { installed: true, count: r.count, distinct: r.distinct.map((d) => `${d.message} (x${d.count})`) }
})

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(`http://localhost:${port}/app/?webgpu&scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) {
      console.log('SKIP: WebGPU renderer not active (fell back to WebGL)')
      return
    }
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {})
    // the staged pre-warm captures + restores overlay visibility; selecting mid-warm loses the handles
    await page.waitForFunction(() => window.__oip?.view?.incrementalWarmReady === true, { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(3000)

    // A fence: procedural geometry() that re-emits every post and wire for every length value, so a
    // drag guarantees a geometry swap per pointer-move, the maximum-churn case for this hazard.
    const target = await page.evaluate(() => {
      const st = window.__oip.store
      const f = st.getState().scene.parts
        .filter((p) => p.packageId === 'oip.fence')
        .sort((a, b) => b.params.length - a.params.length)[0]
      if (!f) return null
      st.select(f.id)
      return { id: f.id, length: f.params.length, rotationY: f.rotationY, position: f.position }
    })
    check('a fence is present in the demo scene', !!target)
    if (!target) return
    await page.waitForTimeout(1200)

    const drawsBefore = await drawsOf(page)
    const before = await gpuErrors(page)
    check('the uncaptured-error watch is installed on the device', before.installed,
      before.installed ? '' : 'globalThis.__oipGpuErrors missing - gpuErrorWatch never attached, so every check below would be vacuous')
    // Known open, reported not gated: an intermittent load-time race raises a couple of these
    // (~1 run in 3 here). Traced with e2e/probes/gpu-dispose-trace.mjs: a failing run's dispose call
    // sites are identical to a passing one's, so it is not one of our dispose seams but three's own
    // bind-group refcount destroying buffers under a recording, which the stale-recording guard's
    // `_bindings.has(ro)` check cannot see. Gating on it would make this gate permanently flaky and
    // hide the regression it is meant to catch, so the assertion below is on the drag's delta.
    if (before.count > 0) {
      console.log(`KNOWN-OPEN  ${before.count} load-time GPU error(s) - three-internal lifetime race, not a resize regression`)
      console.log(`            ${before.distinct.join('\n            ')}`)
    }

    // The transform gizmo keeps a constant screen size and is picked before the resize dots, so a press on a dot
    // that lands on one of its rings moves or rotates the part and the drag tests nothing. Where the dot falls
    // relative to the rings depends on the camera distance, so try a few side-on distances (the fence's
    // perpendicular, whatever its yaw) and take the first that leaves the dot clear.
    let from = null
    let picked = []
    for (const dist of [22, 14, 10, 30]) {
      const r = await page.evaluate(async ({ f, dist }) => {
        const view = window.__oip.view
        const nx = Math.sin(f.rotationY), nz = Math.cos(f.rotationY) // local +Z in world: the fence's side normal
        view.camera.position.set(f.position[0] + nx * dist, 10, f.position[2] + nz * dist)
        view.controls.target.set(f.position[0], 1, f.position[2])
        view.controls.update()
        view.camera.updateMatrixWorld(true)
        // the gizmo and the dots rescale to the new distance in the render loop
        for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res))
        const dot = view.handles.cubes.find((c) => c.group.visible && 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === 1)
        if (!dot) return { dist, why: 'no visible +X dot' }
        const p = dot.group.position
        const s = view.worldToScreen(p.x, p.y, p.z)
        const gizmo = view.pickGizmoHandle(s.x, s.y)
        if (gizmo) return { dist, why: `gizmo ${gizmo} picked first` }
        if (!view.pickResizeHandle(s.x, s.y)) return { dist, why: 'dot not picked' }
        return { dist, s }
      }, { f: target, dist })
      picked.push(r.s ? `${r.dist} m: ok` : `${r.dist} m: ${r.why}`)
      if (r.s) { from = r.s; break }
      await page.waitForTimeout(300)
    }
    check('the +X length dot is pickable', !!from, picked.join(', '))
    if (!from) return

    // where the dot starts: each step is measured from here, since the dot itself follows the drag
    const origin = await page.evaluate(() => {
      const dot = window.__oip.view.handles.cubes.find((c) => 'axis' in c.handle && c.handle.axis === 'x' && c.handle.sign === 1)
      return dot.group.position.toArray()
    })
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    check('pointer-down began a RESIZE (not a move)', await page.evaluate(() => window.__oip.controller?.drag?.kind === 'resize'))
    for (let i = 1; i <= STEPS; i++) {
      const to = await page.evaluate(({ q, yaw, d }) => {
        // walk along the part's local +X so the run extends whatever its yaw
        return window.__oip.view.worldToScreen(q[0] + Math.cos(yaw) * d, q[1], q[2] - Math.sin(yaw) * d)
      }, { q: origin, yaw: target.rotationY, d: (METRES / STEPS) * i })
      await page.mouse.move(to.x, to.y, { steps: 2 })
      await page.waitForTimeout(80)
    }
    await page.mouse.up()
    await page.waitForTimeout(1500)

    const grew = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((x) => x.id === id).params.length, target.id)
    check('the drag actually resized the fence', grew > target.length + 1, `${target.length} -> ${grew}`)

    // The main assertion: the drag itself must not raise a single new uncaptured error. Measured as a
    // delta over the load baseline above, so the open load-time race can't mask a real regression
    // here (and vice versa). Without the retire seam this drag produces them reliably.
    const after = await gpuErrors(page)
    const added = after.count - before.count
    check('the resize drag raised no new uncaptured GPU errors', added === 0,
      `+${added} during the drag: ${after.distinct.join(' | ')}`)

    // ...and the symptom it produces, in case a future failure mode blanks the pass without a
    // validation error: the main pass must still be drawing roughly what it drew before.
    const drawsAfter = await drawsOf(page)
    check('the main pass still draws (scene did not go black)', drawsAfter >= drawsBefore * 0.5,
      `draws ${drawsBefore} -> ${drawsAfter}`)

    // the merges must also still agree with their sources after all that churn
    const audit = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    check('merges coherent after the drag', audit.ok, audit.reason)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
