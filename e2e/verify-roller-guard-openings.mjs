// Verify authored side-guard openings on the roller conveyor, the rig-tier counterpart of the belt's, so the
// `guardOpenings` param means the same thing on both conveyor families (rows measured from the tail).
// Three things must hold:
//   1. render - an authored row splits the rig guard link into the kept spans (1 box → 2), and a full-length
//      row clears that wall entirely. The sim reads the same resolved openings (core/scene/sceneResolve.ts runs
//      computeSceneOpenings for both consumers), so the collider follows by construction.
//   2. frame - the rows are tail-relative on a centre-origin bed: a row at [0, 1] must cut the upstream end,
//      not the middle. A wrong shift would get this backwards without any error.
//   3. gizmo - G (guard-openings mode) works on a roller, not only a belt: a sweep along its guard writes a
//      tail-relative row on that wall and cuts it.
// Run: node e2e/verify-roller-guard-openings.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const PKG = 'oip.roller-conveyor'
const LENGTH = 4

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 60000 })
}

// Wait for a probe to reach an expected state instead of sleeping a fixed time: the guard rebuild is
// async (commit → view sync → rig refresh), and a flat timeout can let a gate pass vacuously.
async function until(page, probe, want, what) {
  const deadline = Date.now() + 8000
  let last
  for (;;) {
    last = await probe(page)
    if (last !== null && want(last)) return last
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`)
    await page.waitForTimeout(150)
  }
}

// live guard boxes per wall: the rig guard-split pool keeps one child per kept span, and collapses the
// last survivor to zero scale when a wall is fully open (render/parts/sdk/rigLayout.ts layoutGuardSplit).
const probeGuards = (page) =>
  page.evaluate(() => {
    if (!window.__oip?.view) return null // the page reloaded under us (see RELOADED below)
    const out = { guardL: 0, guardR: 0 }
    // walk the entry table's part subtrees (there is no view.partsRoot). Don't fall back to view.scene:
    // that widens the probe to the whole scene (building, gizmos, overlays) and it still returns
    // numbers, just the wrong ones.
    for (const entry of window.__oip.view.entries.values()) {
      entry.visual.object.traverse((o) => {
        const name = o.userData?.linkName
        if (name !== 'guardL' && name !== 'guardR') return
        let n = 0
        for (const c of o.children) if (c.isMesh && Math.abs(c.scale.x) > 1e-3) n++
        out[name] = n
      })
    }
    return out
  })

// the world-space X span each wall's boxes cover, in the part's local frame (rotationY 0 → world X ≡ local X)
const probeSpans = (page) =>
  page.evaluate(() => {
    if (!window.__oip?.view) return null
    const spans = { guardL: [], guardR: [] }
    // same walk as probeGuards above: the entry table is the part set
    for (const entry of window.__oip.view.entries.values()) {
      entry.visual.object.traverse((o) => {
        const name = o.userData?.linkName
        if (name !== 'guardL' && name !== 'guardR') return
        for (const c of o.children) {
          if (!c.isMesh || Math.abs(c.scale.x) <= 1e-3) continue
          c.updateWorldMatrix(true, false)
          const cx = c.matrixWorld.elements[12]
          spans[name].push([+(cx - c.scale.x / 2).toFixed(3), +(cx + c.scale.x / 2).toFixed(3)])
        }
        spans[name].sort((a, b) => a[0] - b[0])
      })
    }
    return spans
  })

const setOpenings = (page, rows) =>
  page.evaluate((rows) => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('e2e guard openings', {
      ...s,
      parts: s.parts.map((p) => (p.packageId === 'oip.roller-conveyor' ? { ...p, params: { ...p.params, guardOpenings: rows } } : p)),
    })
  }, rows)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.push(m.text()))
  const fails = []
  // A dev-server HMR reload mid-run wipes the scene and the test hook, which surfaces as a confusing
  // TypeError several steps later. Editing anything under src/render/ forces a full reload by design
  // (vite.config.ts), so if the tree is being edited while this runs, report that instead of a code failure.
  let reloads = 0
  page.on('load', () => { reloads++ })

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(300)

    // the param must exist on the shipped package, or everything below is vacuously green.
    // (poll: bundled packages register after the viewport effect runs)
    await page.waitForFunction((pkg) => !!window.__oip.getPackage?.(pkg), PKG, { timeout: 60000 })
    const declared = await page.evaluate((pkg) => window.__oip.getPackage(pkg)?.params?.guardOpenings?.type ?? null, PKG)
    console.log('package declares guardOpenings:', declared)
    if (declared !== 'numberList') fails.push('roller package does not declare a numberList guardOpenings param')

    // One roller, loaded explicitly. enterPackageEdit is flaky here: its scene load can finish after the
    // first commit and wipe the part mid-test (seen as every guard box vanishing).
    const placed = await page.evaluate(
      ([pkgId, len]) => {
        const st = window.__oip.store
        const pkg = window.__oip.getPackage(pkgId)
        st.loadScene({
          version: st.getState().scene.version,
          parts: [{ id: 'rc1', type: 'part', packageId: pkgId, position: [0, 2, 0], rotationY: 0, params: { length: len, width: 1.524, speed: 1, skew: 0, tiltDeg: 0, standHeight: 2, leftGuard: true, rightGuard: true, guardOpenings: [] } }],
          packages: [pkg],
        })
        st.select('rc1')
        return { id: 'rc1', pos: [0, 2, 0] }
      },
      [PKG, LENGTH],
    )
    console.log('roller part:', JSON.stringify(placed))
    const originX = placed.pos[0]

    // 1) baseline - one solid box per wall
    const base = await until(page, probeGuards, (g) => g.guardL === 1 && g.guardR === 1, 'the baseline 1 box per wall')
    console.log('baseline guard boxes:', JSON.stringify(base))

    // 2) a central opening on both walls (side 0) splits each into two spans
    await setOpenings(page, [[1.5, 2.5, 0]])
    const split = await until(page, probeGuards, (g) => g.guardL === 2 && g.guardR === 2, 'a central opening to split both walls into 2')
    console.log('after [[1.5, 2.5, 0]]:', JSON.stringify(split))

    // 3) tail-relative check: a row at [0, 1] on a length-4 centre-origin bed must remove the upstream metre,
    //    leaving one box spanning local X −1..+2. A missing shift would cut the middle and leave two boxes.
    await setOpenings(page, [[0, 1, -1]])
    const spans = await until(page, probeSpans, (s) => s.guardL.length === 1 && s.guardL[0][1] - s.guardL[0][0] < 3.5, 'the left wall to lose its upstream metre')
    console.log('after [[0, 1, -1]] spans:', JSON.stringify(spans))
    const [lo, hi] = [spans.guardL[0][0] - originX, spans.guardL[0][1] - originX]
    if (Math.abs(lo - -1) > 0.08 || Math.abs(hi - 2) > 0.08) fails.push(`left span should be local −1..+2 (tail-relative), got ${lo.toFixed(3)}..${hi.toFixed(3)}`)
    if (spans.guardR.length !== 1) fails.push(`side −1 must not touch the right wall, got ${JSON.stringify(spans.guardR)}`)

    // 4) a full-length row clears that wall entirely, and only that wall
    await setOpenings(page, [[0, LENGTH, 1]])
    const cleared = await until(page, probeGuards, (g) => g.guardR === 0, 'a full-length opening to clear the right wall')
    console.log('after [[0, 4, 1]]:', JSON.stringify(cleared))
    if (cleared.guardL !== 1) fails.push(`the other wall must stay whole, got ${cleared.guardL}`)

    // 5) the gizmo: G shows opening dots on a roller and a drag writes a row
    await setOpenings(page, [])
    await until(page, probeGuards, (g) => g.guardL === 1 && g.guardR === 1, 'the guards to come back')
    await page.evaluate(() => {
      const st = window.__oip.store
      const p = st.getState().scene.parts.find((q) => q.packageId === 'oip.roller-conveyor')
      st.select(p.id)
      window.__oip.view.setCameraPose({ px: p.position[0], py: p.position[1] + 8, pz: p.position[2] + 2.2, tx: p.position[0], ty: p.position[1], tz: p.position[2] })
    })
    await page.waitForTimeout(700)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true })))
    await page.waitForTimeout(400)
    const modeOn = await page.evaluate(() => window.__oip.store.getState().sideGuardMode)
    console.log('sideGuardMode after G:', modeOn)
    if (!modeOn) fails.push('G did not enter Side-Guards mode')

    // the right guard at tail-relative s: the bed is centre-origin, the wall line runs mid-guard just outside the bed
    const halfW = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.roller-conveyor')
      return (typeof p.params.width === 'number' ? p.params.width : 1.524) / 2
    })
    const onRightWall = (s) =>
      page.evaluate(
        ([s, len, z]) => {
          const p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.roller-conveyor')
          return window.__oip.view.worldToScreen(p.position[0] + s - len / 2, p.position[1] + 0.075, p.position[2] + z)
        },
        [s, LENGTH, halfW + 0.01],
      )
    // a sweep along the right guard from 2.5 m to the head end writes a tail-relative row on that wall
    const from = await onRightWall(2.5)
    const to = await onRightWall(LENGTH + 0.5) // past the end: clamps to the guard
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const rows = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.roller-conveyor').params.guardOpenings)
    console.log('guardOpenings after sweep:', JSON.stringify(rows))
    const ok = Array.isArray(rows) && rows.length === 1 && rows[0][2] === 1 && Math.abs(rows[0][0] - 2.5) < 0.05 && Math.abs(rows[0][1] - LENGTH) < 1e-6
    if (!ok) fails.push(`the sweep did not write [2.5, ${LENGTH}, 1]: ${JSON.stringify(rows)}`)
    // and the row must cut the guard it was swept along, at the head end
    const afterDrag = await until(page, probeGuards, (g) => g.guardR === 1, 'the swept opening to cut the right wall')
    console.log('guard boxes after sweep:', JSON.stringify(afterDrag))
    const cutSpans = await probeSpans(page)
    const keptR = cutSpans.guardR[0]
    if (!keptR || Math.abs(keptR[1] - (placed.pos[0] + 0.5)) > 0.08) fails.push(`the right wall should end at local +0.5 (s 2.5), got ${JSON.stringify(keptR)}`)
    if (afterDrag.guardL !== 1) fails.push(`the left wall must stay whole, got ${afterDrag.guardL}`)

    console.log(errors.length === 0 ? 'NO ERRORS' : `ERRORS:\n${errors.slice(0, 6).join('\n')}`)
    if (fails.length) {
      console.log(`RESULT FAIL\n - ${fails.join('\n - ')}`)
      process.exitCode = 1
    } else {
      console.log('RESULT PASS - authored guard openings cut the roller conveyor, tail-relative, gizmo included')
    }
  } catch (e) {
    // 2 loads are ours (goto + the localStorage reload); more means the dev server reloaded under the test
    if (reloads > 2) console.log(`RELOADED - the dev server hot-reloaded the page ${reloads - 2}x mid-run (src/ edited while running?); rerun on a quiet tree`)
    throw e
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
  vite.kill()
})
