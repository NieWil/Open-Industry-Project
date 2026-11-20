// Verify that a static rig's GLB mesh links pool across parts (rig.ts tagPoolLeaves → instancePool
// poolUnit). If only unit-primitive links got the poolUnit tag, every GLB-dressed part in a scene would
// draw its housing once per copy, however many identical ones the layout has. No built-in is a static
// GLB rig any more, but a user part is one as soon as Import model (or the agent's import_model) puts a
// GLB on a link. So the gate builds its own: two user packages with an embedded GLB, registered through
// the store paths a user part takes, and a scene of N copies, A/B'd against ?noinstancepool.
//
// The test parts:
//   - dressing: four mesh links on nodes of one embedded GLB (a small app-served one, read from
//     public/part-assets/ and embedded base64 as Import model does), no joints, a behavior that moves
//     nothing. N copies in a row.
//   - mover: the same GLB on two links, and a behavior that moves its `cap` link with ctx.setSubPose.
//
// Checks (each fails the gate):
//   - setup: both packages register and every test part renders its GLB meshes. If not, nothing below
//     would test anything, so the gate exits non-zero with the reason.
//   - merge: the pooled arm tags leaves and hides them; draws < baseline
//   - geometry: the scene's triangle count is identical (a merge that drops geometry is a bug)
//   - picking: a grid of pickPart() probes is identical baseline↔pooled, and a probe aimed at each test
//     part picks that part in both arms (hidden sources still pick)
//   - drag eject: setPoolDragEject un-hides the dressing, clearing it re-pools
//   - subPose: a link the behavior moves with setSubPose must never be pooled. The pool bakes world
//     matrices, so a pooled cap would stay at rest while the real one moves. Asserts the cap's leaves
//     are not tagged, then applies a real subPose and asserts they moved and none is pool-hidden.
//   - load timing: a GLB link resolves after the part is added, so the tags appear after the load-time
//     poolRebuild. Counts the merge once the meshes are in and again after a scene sync; if only the
//     second pools, the async-attach rescan is missing.
//
// Headed real-GPU browser (asserts a WebGPU backend). Run: node e2e/verify-pool-glb-dressing.mjs
/* global process, console, window, document, performance, URL */
// page-side helpers that HELPERS installs on globalThis
/* global frames, dressingStats, partRoot, meshesIn */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const BASE = `http://localhost:${PORT}/app/`
const OUT = process.env.OUT_DIR || '.'
const COPIES = 8

// The baked EOAT suction gripper (22 KB, Draco, opaque, no textures, 7 named mesh nodes).
const GLB_PATH = new URL('../public/part-assets/929d5eae36c065f460ac5bb80c287977bcf7c7d5596680a56ab2946d483cdb32.glb', import.meta.url)
const GLB_B64 = readFileSync(GLB_PATH).toString('base64')
const ASSETS = [{ id: 'glb', mime: 'model/gltf-binary', data: GLB_B64 }]
const BOUNDS = { length: 0.5, width: 0.5, top: 0.4, bottom: 0 }
const meshLink = (name, node, y) => ({ name, shape: { kind: 'mesh', asset: 'glb', node }, offset: [0, y, 0] })

const DRESSING_ID = 'e2e.pool-dressing'
const MOVER_ID = 'e2e.pool-mover'
const MOVER_LINK = 'cap'
const PART_IDS = [...Array.from({ length: COPIES }, (_, i) => `dress_${i}`), 'mover_0']
// format 6 = PACKAGE_FORMAT (src/core/parts/partPackage.ts). commitPackage refuses any other, and the gate
// then fails at setup with the refusal.
const DRESSING = {
  format: 6,
  id: DRESSING_ID,
  name: 'Pool Dressing',
  category: 'Equipment',
  params: {},
  behavior: 'definePart({\n  step() {},\n})\n',
  geometry: {
    kind: 'rig',
    links: [meshLink('plate', 'Plane', 0.11), meshLink('attach', 'Attachment', 0.11), meshLink('cup', 'SuctionCup', 0.2), meshLink('rails', 'Rails_01', 0.25)],
    joints: [],
    bounds: BOUNDS,
  },
  assets: ASSETS,
}
const MOVER = {
  format: 6,
  id: MOVER_ID,
  name: 'Pool Mover',
  category: 'Equipment',
  params: {},
  behavior: `definePart({\n  step(ctx) {\n    ctx.setSubPose('${MOVER_LINK}', { position: [0, 0, -0.02] })\n  },\n})\n`,
  geometry: {
    kind: 'rig',
    links: [meshLink('housing', 'Attachment', 0.11), meshLink(MOVER_LINK, 'Cap_01', 0.2)],
    joints: [],
    bounds: BOUNDS,
  },
  assets: ASSETS,
}

async function launchHeaded() {
  const args = ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu']
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch({ headless: false, channel, args }) } catch { /* next */ }
  }
  throw new Error('no headed Chromium-family browser')
}

const GRID = []
for (let gx = 1; gx < 8; gx++) for (let gy = 1; gy < 8; gy++) GRID.push([gx / 8, gy / 8])

// Page-side helpers, injected as source so both arms share one definition. They hang off globalThis
// because `eval` keeps its own const/let bindings - a bare `const` here would not reach the caller.
const HELPERS = `
  globalThis.frames = (n) => new Promise((res) => { let f = 0; const t = () => (++f < n ? requestAnimationFrame(t) : res()); requestAnimationFrame(t) })
  // the pool tags GLB leaves, so count both the tagged set and the subset it actually hid (= merged away)
  globalThis.dressingStats = () => {
    const view = window.__oip.view
    let tagged = 0, hidden = 0, pools = 0, drawn = 0, tris = 0
    view.scene.traverse((o) => {
      if (o.userData?.instancePool === true) pools++
      if (o.userData?.poolUnit === true) tagged++
      if (o.userData?.poolHidden === true) hidden++
      // Renderable object count: the merge metric that still works under render bundles. r.info.drawCalls
      // counts bundle executions (bundles are on by default), so it reads the same whether the bundle
      // records 500 draws or 50; what the pool removes is recorded draws, i.e. visible objects.
      if (!(o.isMesh || o.isLine || o.isPoints)) return
      if (o.isInstancedMesh && o.count <= 0) return
      let vis = true, n = o
      while (n) { if (n.visible === false) { vis = false; break } n = n.parent }
      if (!vis) return
      drawn++
      // Triangles the scene submits, read off the objects. The renderer's info counts bundle executions
      // under render bundles (it reads 1 there), so it cannot tell a merge that dropped geometry.
      const g = o.geometry
      if (o.isMesh && g) tris += Math.floor((g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3) * (o.isInstancedMesh ? o.count : 1)
    })
    return { tagged, hidden, pools, drawn, tris }
  }
  globalThis.partRoot = (id) => {
    let found = null
    window.__oip.view.scene.traverse((o) => { if (!found && o.userData?.partId === id) found = o })
    return found
  }
  globalThis.meshesIn = (id) => {
    let n = 0
    partRoot(id)?.traverse((o) => { if (o.isMesh) n++ })
    return n
  }
`

// Register both test packages the way a new user part is (createBlankPart: registry + library), then
// load a scene of the building plus the test parts. Returns a reason string when setup fails.
const SETUP = async ({ pkgs, copies, helpers }) => {
  eval(helpers)
  const store = window.__oip.store, getPackage = window.__oip.getPackage
  for (const pkg of pkgs) {
    store.commitPackage('e2e: add test part', pkg)
    store.addUserPackage(pkg)
    const err = store.getState().packageBuildErrors?.[pkg.id]
    if (err) return { fail: `package ${pkg.id} was refused: ${typeof err === 'string' ? err : JSON.stringify(err)}` }
    if (!getPackage(pkg.id)) return { fail: `package ${pkg.id} did not register` }
    if (!store.getState().userPackages.some((p) => p.id === pkg.id)) return { fail: `package ${pkg.id} is not in the library` }
  }
  const [dressing, mover] = pkgs
  const scene = store.getState().scene
  const parts = scene.parts.filter((p) => p.type === 'building')
  for (let i = 0; i < copies; i++) {
    parts.push({ id: `dress_${i}`, name: `Pool Dressing ${i + 1}`, type: 'part', packageId: dressing.id, position: [(i % 4) * 1.5 - 2.25, 0, Math.floor(i / 4) * 1.5], rotationY: 0, params: {} })
  }
  parts.push({ id: 'mover_0', name: 'Pool Mover', type: 'part', packageId: mover.id, position: [-4, 0, 0], rotationY: 0, params: {} })
  store.loadScene({ ...scene, parts })
  // An embedded GLB decodes async and is not on assetsBusy (only fetched assets are), so wait for the
  // positive signal: every test part's root holds its GLB meshes.
  const ids = [...Array.from({ length: copies }, (_, i) => `dress_${i}`), 'mover_0']
  const deadline = performance.now() + 30000
  const missing = () => ids.filter((id) => meshesIn(id) === 0)
  while (missing().length > 0) {
    if (performance.now() > deadline) return { fail: `test parts rendered no GLB meshes within 30 s: ${missing().join(', ')}` }
    await frames(2)
  }
  // Frame the test parts so the pick grid lands on them. focusOn eases, so wait for it to finish.
  const view = window.__oip.view
  view.focusOn(ids)
  while (view.focusAnim != null) {
    if (performance.now() > deadline + 15000) return { fail: 'the camera never finished framing the test parts' }
    await frames(2)
  }
  return { meshes: Object.fromEntries(ids.map((id) => [id, meshesIn(id)])) }
}

async function measure(flag, shotName, pooled) {
  const browser = await launchHeaded()
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(BASE + flag)
    await page.waitForFunction(
      () => document.querySelector('.viewport-cover.ready') != null &&
            (window.__oip?.store?.getState().scene.parts.length ?? 0) > 0,
      null, { timeout: 90000 },
    )
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 90000 })

    const setup = await page.evaluate(SETUP, { pkgs: [DRESSING, MOVER], copies: COPIES, helpers: HELPERS })
    if (setup.fail) return { fail: setup.fail }

    // Measure the merge once the meshes are in, then again after a scene sync, to catch an attach
    // that happens after the load-time poolRebuild and is never re-scanned.
    const built = await page.evaluate(async ({ helpers }) => {
      eval(helpers)
      const store = window.__oip.store
      await frames(60)
      const atLoad = dressingStats()
      // a no-op scene sync (same parts, new object identity) → syncScene → poolRebuild
      store.loadScene({ ...store.getState().scene, parts: store.getState().scene.parts.map((p) => ({ ...p })) })
      await frames(30)
      const afterSync = dressingStats()
      return { atLoad, afterSync }
    }, { helpers: HELPERS })

    await cleanShot(page, `${OUT}/${shotName}.png`)

    const data = await page.evaluate(async ({ grid, helpers, ids }) => {
      eval(helpers)
      const view = window.__oip.view
      const r = view.renderer
      const backend = r?.isWebGPURenderer ? (r.backend?.constructor?.name ?? 'webgpu') : 'WebGLRenderer'
      await frames(3)
      const info = r.info?.render
      const canvas = r.domElement
      const rect = canvas.getBoundingClientRect()
      const picks = grid.map(([fx, fy]) => view.pickPart(rect.left + fx * rect.width, rect.top + fy * rect.height))
      // The parts are small, so the grid mostly lands on the floor. Probe each test part too, at the
      // screen point of a spot on its plate. Each must pick its own part in both arms.
      const partProbes = ids.map((id) => {
        const p = partRoot(id).localToWorld(view.camera.position.clone().set(0, 0.05, 0)).project(view.camera)
        const x = rect.left + ((p.x + 1) / 2) * rect.width, y = rect.top + ((1 - p.y) / 2) * rect.height
        return { id, x: Math.round(x), y: Math.round(y), picked: view.pickPart(x, y) }
      })
      return {
        partProbes,
        backend,
        draws: info?.drawCalls ?? info?.calls ?? -1,
        triangles: info?.triangles ?? -1,
        picks,
        ...dressingStats(),
      }
    }, { grid: GRID, helpers: HELPERS, ids: PART_IDS })

    // Pooled-arm-only behaviour checks.
    let eject = null, subPose = null
    if (pooled) {
      eject = await page.evaluate(async ({ helpers }) => {
        eval(helpers)
        const view = window.__oip.view
        const hiddenIn = (id) => {
          const root = partRoot(id)
          let n = 0
          root?.traverse((o) => { if (o.userData?.poolHidden === true) n++ })
          return n
        }
        const pooledAtStart = hiddenIn('dress_0')
        view.setPoolDragEject(['dress_0']); await frames(3)
        const dragging = hiddenIn('dress_0')
        view.setPoolDragEject(null); view.setSelection([]); await frames(3)
        const repooled = hiddenIn('dress_0')
        return { pooledAtStart, liveOnEject: dragging === 0, repooled }
      }, { helpers: HELPERS })

      subPose = await page.evaluate(async ({ helpers, link }) => {
        eval(helpers)
        const view = window.__oip.view
        const root = partRoot('mover_0')
        const linkGroup = (name) => { let g = null; root?.traverse((o) => { if (!g && o.userData?.linkName === name) g = o }); return g }
        const leaves = []
        linkGroup(link)?.traverse((o) => { if (o.isMesh) leaves.push(o) })
        const tagged = leaves.filter((m) => m.userData?.poolUnit === true).length
        const at = () => leaves.map((m) => { m.updateWorldMatrix(true, false); return [m.matrixWorld.elements[12], m.matrixWorld.elements[13], m.matrixWorld.elements[14]] })
        const before = at()
        // Drive the real applier the running frame uses (stopped-sim path). The stopped preview has already
        // posed the cap with the behavior's own subPose, so this one goes somewhere else.
        view.applyIdlePose('mover_0', { subPoses: { [link]: { position: [0, 0.1, -0.05] } } })
        await frames(3)
        const after = at()
        const moved = before.some((b, i) => b.some((v, k) => Math.abs(v - after[i][k]) > 1e-4))
        const hiddenAfter = leaves.filter((m) => m.userData?.poolHidden === true).length
        return { names: [link], leaves: leaves.length, taggedBefore: tagged, moved, hiddenAfter }
      }, { helpers: HELPERS, link: MOVER_LINK })
      await cleanShot(page, `${OUT}/${shotName}-subposed.png`)
    }

    return { ...data, ...built, meshes: setup.meshes, eject, subPose }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

async function main() {
  const baseFlag = '?webgpu&scene=demo&noinstancepool'
  const poolFlag = '?webgpu&scene=demo'
  console.log(`measuring baseline (${baseFlag}) ...`)
  const base = await measure(baseFlag, 'pool-glb-baseline', false)
  if (base.fail) { console.log(`VOID (setup failed, baseline): ${base.fail}`); process.exitCode = 1; return }
  console.log(`measuring pooled   (${poolFlag}) ...`)
  const pool = await measure(poolFlag, 'pool-glb-pooled', true)
  if (pool.fail) { console.log(`VOID (setup failed, pooled): ${pool.fail}`); process.exitCode = 1; return }

  if (base.backend !== 'WebGPUBackend' || pool.backend !== 'WebGPUBackend') {
    console.log(`VOID: expected WebGPUBackend but got ${base.backend} / ${pool.backend}.`)
    process.exitCode = 1
    return
  }

  const pickMismatch = base.picks.reduce((n, id, i) => n + (id === pool.picks[i] ? 0 : 1), 0)
  // every probe aimed at a test part picks that part in both arms; a miss in both would make the
  // comparison vacuous
  const partPickMiss = [...base.partProbes, ...pool.partProbes].filter((p) => p.picked !== p.id)
  const pickProbes = base.picks.length + base.partProbes.length
  // The geometry check reads the scene's own triangle count (the renderer's reads 1 under render bundles).
  // It is exact: the building's ~1M triangles would hide the test parts' few thousand inside any slack.
  const triDelta = Math.abs(pool.tris - base.tris)
  const triOk = base.tris > 0 && triDelta === 0

  console.log(`\ndressing part: ${DRESSING_ID} × ${COPIES}   subPose'd part: ${MOVER_ID}`)
  console.log(`GLB meshes per part (pooled arm): ${JSON.stringify(pool.meshes)}`)
  console.log('                     BASELINE     POOLED     Δ')
  console.log(`drawn objects       ${String(base.drawn).padStart(8)}  ${String(pool.drawn).padStart(8)}  ${pool.drawn - base.drawn}`)
  console.log(`draw calls (bundled)${String(base.draws).padStart(8)}  ${String(pool.draws).padStart(8)}  ${pool.draws - base.draws}   ← bundle executions, not per-mesh draws`)
  console.log(`triangles (scene)   ${String(base.tris).padStart(8)}  ${String(pool.tris).padStart(8)}  ${pool.tris - base.tris}`)
  console.log(`triangles (info)    ${String(base.triangles).padStart(8)}  ${String(pool.triangles).padStart(8)}  ${pool.triangles - base.triangles}   ← bundled, like the draw calls`)
  console.log(`poolUnit tagged     ${String(base.tagged).padStart(8)}  ${String(pool.tagged).padStart(8)}`)
  console.log(`pool-hidden (merged)${String(base.hidden).padStart(8)}  ${String(pool.hidden).padStart(8)}`)
  console.log(`pool meshes         ${String(base.pools).padStart(8)}  ${String(pool.pools).padStart(8)}`)
  console.log(`\nload timing (pooled): at-load hidden=${pool.atLoad.hidden} tagged=${pool.atLoad.tagged}  →  after-sync hidden=${pool.afterSync.hidden} tagged=${pool.afterSync.tagged}`)
  console.log(`pick probes: ${base.picks.length} grid + ${base.partProbes.length} per part; grid mismatches = ${pickMismatch}, part probes that missed their part = ${partPickMiss.length}`)
  if (partPickMiss.length > 0) console.log(`  missed: ${JSON.stringify(partPickMiss)}`)
  console.log(`drag eject: pooledAtStart=${pool.eject?.pooledAtStart} liveOnEject=${pool.eject?.liveOnEject} repooled=${pool.eject?.repooled}`)
  const sp = pool.subPose
  console.log(`subPose hazard: links=[${sp?.names}] leaves=${sp?.leaves} taggedBeforeMove=${sp?.taggedBefore} movedOnSubPose=${sp?.moved} poolHiddenAfter=${sp?.hiddenAfter}`)

  // --- verdict ---
  const mergedOk = pool.hidden > base.hidden && pool.tagged > 0
  const drawsOk = pool.drawn < base.drawn
  const ejectOk = pool.eject?.pooledAtStart > 0 && pool.eject?.liveOnEject === true && pool.eject?.repooled > 0
  // the subPose'd link must have leaves, be neither tagged nor pool-hidden, and actually move
  const subPoseOk = sp?.leaves > 0 && sp.taggedBefore === 0 && sp.hiddenAfter === 0 && sp.moved === true
  // the async-attach question: pooling must not depend on a later scene sync
  const loadTimingOk = pool.atLoad.hidden > 0 && pool.atLoad.hidden === pool.afterSync.hidden

  console.log('\n=== VERDICT ===')
  console.log(`  merge:    ${mergedOk ? `ok - ${pool.hidden - base.hidden} GLB leaves merged away` : 'FAIL - GLB dressing did NOT pool'}`)
  console.log(`  draws:    ${drawsOk ? `ok - ↓${base.drawn - pool.drawn} drawn objects` : 'FAIL - not reduced'}`)
  console.log(`  geometry: ${triOk ? 'ok - triangles preserved' : `FAIL - CHANGED (${triDelta})`}`)
  const pickOk = pickMismatch === 0 && partPickMiss.length === 0
  console.log(`  picking:  ${pickOk ? `ok - ${pickProbes} probes identical, every part probe picks its part` : `FAIL - ${pickMismatch} grid mismatches, ${partPickMiss.length} part probes missed`}`)
  console.log(`  eject:    ${ejectOk ? 'ok - pooled → live on drag → re-pooled' : 'FAIL - eject round-trip broken'}`)
  console.log(`  subPose:  ${subPoseOk ? 'ok - mover excluded from the pool and moves' : sp?.leaves > 0 ? 'FAIL - a subPose-driven link was POOLED or did not move (it will render stuck)' : 'FAIL - the mover link has no meshes'}`)
  console.log(`  timing:   ${loadTimingOk ? 'ok - pooled at load, no scene sync needed' : `FAIL - not pooled at load (${pool.atLoad.hidden} → ${pool.afterSync.hidden}) - async attach needs a re-scan`}`)
  console.log(`  shots:    ${OUT}/pool-glb-baseline.png vs ${OUT}/pool-glb-pooled.png`)

  if (!(mergedOk && drawsOk && triOk && pickOk && ejectOk && subPoseOk && loadTimingOk)) process.exitCode = 1
}

main()
  .catch((e) => { console.error('verify-pool-glb-dressing crashed:', e); process.exitCode = 2 })
  .finally(() => {
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  })
