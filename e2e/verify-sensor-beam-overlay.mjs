/* global console, process, window, Image, document */
// Sensor-beam draw-order gate (WebGPU render bundles).
//
// A beam is depthWrite:false (it must not occlude the cargo it stops at), so it relies on being
// drawn after whatever it should appear in front of. Inside the part's rig it would sit in
// partsGroup, a render-bundle root under WebGPU, and the backend executes every bundle at the end
// of the main pass, so the bundled conveyor hardware paints over it: a sensor mounted on a belt
// shows two green stubs at the holes in the side guards and nothing across the belt. WebGL and ?nobundle
// are unaffected. So the beams render from the overlay pass (sensorBeamOverlay.ts), like the flow arrows.
//
// That pass exists only for them, so they are also instanced: every sensor's beam is one instance
// of a single scene-level bank, with the hit length on instanceMatrix and the clear/blocked tint on
// instanceColor. This gate asserts that too; a per-beam Mesh + per-beam material would add a draw
// call and a pipeline per sensor.
//
// This gate asserts the beam is continuous along its whole length, not merely that green pixels
// exist somewhere: a plain pixel count scores two guard stubs the same as a healthy beam, which is
// how the regression got past an earlier manual check. It runs the arm the bug affects (WebGPU +
// bundles) plus the two arms it does not, so a future regression can be attributed.
//
// Needs a real WebGPU adapter -> launches headed, and skips the WebGPU arms if Dawn is absent.
// Run: node e2e/verify-sensor-beam-overlay.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function frame(page, target, eye) {
  await page.evaluate(([t, e]) => new Promise((res) => {
    const v = window.__oip.view
    let n = 0
    const step = () => {
      v.controls.target.set(t[0], t[1], t[2])
      v.camera.position.set(e[0], e[1], e[2])
      v.controls.update()
      if (n++ < 16) return requestAnimationFrame(step)
      res(null)
    }
    requestAnimationFrame(step)
  }), [target, eye])
  await page.waitForTimeout(500)
}

/**
 * Mount the sensor using the app's own snap solver (core/snap/snapFeatures findSnap), reached by a dev
 * dynamic import so the pose is the one a real guard drop produces, including the auto-fit range.
 *
 * Why not hand-place: the mount sits at guardY = ty + surfaceY (snapRails.ts), i.e. the conveying
 * surface, ~0.75 m up. A guessed height can put the sensor on the floor beside the belt, measuring a
 * beam crossing open air, which looks healthy and tests nothing. Scanning candidate origins until
 * findSnap engages removes the guess.
 */
async function mountSensorOnGuard(page, id = 's1', xs = [0]) {
  return page.evaluate(async ([sid, xCandidates]) => {
    const mod = await import('/src/core/snap/snapFeatures.ts')
    const st = window.__oip.store
    const belt = st.getState().scene.parts.find((p) => p.id === 'h1')
    const half = (belt.params?.width ?? 1.524) / 2
    const ps = window.__oip.getPackage('oip.diffuse-sensor')?.params ?? {}
    const sensorParams = {}
    for (const [k, v] of Object.entries(ps)) if (v && typeof v === 'object' && 'default' in v) sensorParams[k] = v.default
    // sweep plausible seat heights/offsets until the solver accepts one (it gates on distance to
    // the guard, so the scan just has to pass near it)
    for (const x of xCandidates) {
      for (let y = -0.20; y <= 1.30; y += 0.05) {
        for (const z of [half + 0.02, half + 0.06, half, half + 0.12]) {
          const moving = { id: sid, type: 'part', packageId: 'oip.diffuse-sensor', position: [x, y, z], rotationY: 0, params: sensorParams }
          const snap = mod.findSnap(moving, { position: [x, y, z], rotationY: 0 }, [belt])
          if (!snap || !snap.paramOverrides || typeof snap.paramOverrides.maxRange !== 'number') continue
          const s = st.getState().scene
          st.loadScene({
            ...s,
            parts: [...s.parts, { ...moving, position: snap.pose.position, rotationY: snap.pose.rotationY, params: { ...sensorParams, ...snap.paramOverrides, showBeam: true } }],
          })
          return { ok: true, pose: snap.pose.position, maxRange: snap.paramOverrides.maxRange }
        }
      }
    }
    return { ok: false }
  }, [id, xs])
}

/** every drawn beam with its live tint and its screen span. The mixed-state assertions need all
 *  of them at once, because they share one draw and one material. */
async function allBeams(page) {
  return page.evaluate(async () => {
    const v = window.__oip.view
    const mod = await import('/src/render/sensorBeamOverlay.ts')
    v.camera.updateMatrixWorld(true)
    const r = v.renderer.domElement.getBoundingClientRect()
    const V = v.camera.position.constructor
    return mod.sensorBeamDebug().beams.filter((b) => b.visible).map((b) => ({
      length: +b.length.toFixed(4),
      color: b.color,
      mid: [0, 1, 2].map((i) => (b.origin[i] + b.end[i]) / 2),
      screen: [b.origin, b.end].map((p) => {
        const q = new V(p[0], p[1], p[2]).project(v.camera)
        return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height }
      }),
    }))
  })
}

// beam state + its world/screen endpoints, read off the instanced bank
async function beamGeom(page) {
  return page.evaluate(async () => {
    const v = window.__oip.view
    const st = window.__oip.store
    const part = st.getState().scene.parts.find((p) => p.packageId === 'oip.diffuse-sensor')
    if (!part) return { error: 'no sensor part' }
    // Every beam in the scene is one instance of a scene-level bank, so there is no per-beam
    // mesh to find: ask the bank itself (same module instance the app imports, since vite dev
    // serves one copy per URL).
    const mod = await import('/src/render/sensorBeamOverlay.ts')
    const dbg = mod.sensorBeamDebug()
    const beam = dbg.beams.find((b) => b.visible)
    if (!beam) return { error: 'no visible beam in the bank' }
    v.camera.updateMatrixWorld(true)
    const r = v.renderer.domElement.getBoundingClientRect()
    const V = v.camera.position.constructor
    const ends = [beam.origin, beam.end].map((p) => new V(p[0], p[1], p[2]))
    const screen = ends.map((p) => {
      const q = p.clone().project(v.camera)
      return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height }
    })
    // the purpose of the bank: however many sensors are shown, they take one draw
    let bankMeshes = 0
    let instanced = false
    v.scene.traverse((o) => {
      if (o.userData?.sensorBeam !== true) return
      bankMeshes++
      if (o.isInstancedMesh && o.visible) instanced = true
    })
    return {
      maxRange: part.params?.maxRange,
      drawn: dbg.count,
      bankMeshes,
      instanced,
      depthTest: dbg.depthTest,
      inOverlayGroup: mod.sensorBeamGroup.parent === v.scene,
      color: beam.color,
      scaleZ: +beam.length.toFixed(4),
      world: ends.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]),
      screen,
    }
  })
}

/**
 * Place an authored box in the beam's path so the sensor reads blocked while the scene is stopped
 * (the view casts core/beamCast against the idle authored-cargo frame). Returns the box's centre.
 *
 * The blocked state is the part of the beam that carries per-instance data: the hit distance is the
 * instance's own matrix scale and the red tint is its instanceColor slot. A bank whose colour path
 * failed to compile (three compiles that node only if `instanceColor` exists at first compile) would
 * draw a healthy-looking green beam here, which is why the pixel check below looks for red.
 */
async function blockBeam(page, world) {
  const mid = [(world[0][0] + world[1][0]) / 2, world[0][1], (world[0][2] + world[1][2]) / 2]
  await page.evaluate((c) => {
    const st = window.__oip.store
    const ps = window.__oip.getPackage('oip.box')?.params ?? {}
    const params = {}
    for (const [k, v] of Object.entries(ps)) if (v && typeof v === 'object' && 'default' in v) params[k] = v.default
    const s = st.getState().scene
    // seated so the box straddles the beam line (the beam runs ~0.1 m over the belt surface)
    st.loadScene({ ...s, parts: [...s.parts, { id: 'blocker', type: 'part', packageId: 'oip.box', position: [c[0], c[1] - 0.15, c[2]], rotationY: 0, params }] })
  }, mid)
  await page.waitForTimeout(1500)
  return mid
}

// "is there <colour> here" at N points along the beam; a gap is the bug's signature
async function greenProfile(page, screen, want = 'green') {
  const shot = await page.locator('canvas').first().screenshot()
  return page.evaluate(async ([b64, ep, colour]) => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + b64 })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    // the beam's own colour, sampled off-screen: dominant channel, clear of the belt's greys
    const green = colour === 'green'
      ? (i) => d[i + 1] > 100 && d[i + 1] - d[i] > 45 && d[i + 1] - d[i + 2] > 45
      : (i) => d[i] > 100 && d[i] - d[i + 1] > 45 && d[i] - d[i + 2] > 45
    const N = 40
    let out = ''
    for (let k = 0; k < N; k++) {
      const t = k / (N - 1)
      const x = Math.round(ep[0].x + (ep[1].x - ep[0].x) * t)
      const y = Math.round(ep[0].y + (ep[1].y - ep[0].y) * t)
      let hit = false
      for (let dy = -9; dy <= 9 && !hit; dy++) {
        for (let dx = -3; dx <= 3 && !hit; dx++) {
          const px = x + dx, py = y + dy
          if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue
          if (green((py * c.width + px) * 4)) hit = true
        }
      }
      out += hit ? '#' : '.'
    }
    return out
  }, [shot.toString('base64'), ep2(screen), want])
}
const ep2 = (s) => [s[0], s[1]]

async function arm(label, query, expectWebGPU) {
  const browser = await chromium.launch({
    headless: false, // a real WebGPU adapter; headless Chromium reports none
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  const errors = []
  const known = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  // Known and unrelated to the beams: a null texture reaches the WebGPU backend during bundle
  // replay (bundleReplayRefresh's _bindings.updateForRender), thrown from the building's GLB
  // materials. Counted and printed rather than
  // swallowed, but it must not fail the beam assertions.
  const knownUnrelated = (s) => /Cannot read properties of null \(reading 'minFilter'\)/.test(s)
  page.on('pageerror', (e) => {
    const s = String(e)
    if (benign(s)) return
    ;(knownUnrelated(s) ? known : errors).push(s)
  })
  try {
    await page.goto(`http://localhost:${PORT}/app/${query}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 25000 })
    await page.waitForTimeout(2500)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 25000 })
    await page.waitForTimeout(3000)

    const backend = await page.evaluate(() => window.__oip.view.renderer.backend?.constructor?.name ?? 'WebGL')
    console.log(`\n--- ${label}  [${backend}] ---`)
    if (expectWebGPU && backend !== 'WebGPUBackend') {
      console.log('SKIP: no WebGPU adapter for this arm')
      return
    }

    await page.evaluate(() => {
      // Resolve the package's declared defaults: an empty params bag leaves the host with no width,
      // so its guard geometry, and the whole snap, can't resolve. (A belt's origin is its
      // conveying surface; its housing/legs hang below y=0, so a guard mount lands at y≈0.)
      const ps = window.__oip.getPackage('oip.belt-conveyor')?.params ?? {}
      const params = {}
      for (const [k, v] of Object.entries(ps)) if (v && typeof v === 'object' && 'default' in v) params[k] = v.default
      window.__oip.store.loadScene({
        version: 4,
        parts: [{ id: 'h1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params }],
        packages: [],
      })
    })
    await page.waitForTimeout(1800)
    // frame the belt so the guard is comfortably under the cursor sweep
    await frame(page, [0, 0.8, 0], [1.4, 1.75, 1.7])

    const mounted = await mountSensorOnGuard(page)
    check(`${label}: sensor snapped onto the conveyor guard`, mounted.ok, mounted.ok ? `pose=${JSON.stringify(mounted.pose)}` : 'findSnap never engaged')
    if (!mounted.ok) return
    await page.waitForTimeout(1200)

    let g = await beamGeom(page)
    if (g.error) { check(`${label}: beam mesh present`, false, g.error); return }
    // the auto-fit range is the mount's signature: the declared default is 2, a guard mount rewrites
    // it to span the belt (width + 2×outwardOffset), so it must differ from the default
    check(`${label}: mount auto-fit the beam range (proves a real guard mount)`, g.maxRange !== 2 && g.maxRange > 0.2, `maxRange=${g.maxRange}`)
    check(`${label}: beam stays depth-TESTED (overlay pass must not make it always-on-top)`, g.depthTest === true)
    // the purpose of the bank: N sensors take one instanced draw in a pass that runs only for them
    check(`${label}: beams draw from a single instanced bank`, g.instanced === true && g.bankMeshes === 1, `${g.bankMeshes} bank mesh(es), instanced=${g.instanced}`)
    check(`${label}: the bank hangs off the scene, not the part`, g.inOverlayGroup === true)

    // look down at the bed so the beam's whole span is over the belt, as in the bug report
    const mid = [(g.world[0][0] + g.world[1][0]) / 2, (g.world[0][1] + g.world[1][1]) / 2, (g.world[0][2] + g.world[1][2]) / 2]
    // far enough back that the whole ~1.5 m span is on screen, looking down at the bed
    await frame(page, mid, [mid[0] + 0.9, mid[1] + 1.7, mid[2] + 0.9])
    g = await beamGeom(page)
    if (g.error) { check(`${label}: beam mesh present after reframe`, false, g.error); return }

    const prof = await greenProfile(page, g.screen)
    console.log(`  beam ${JSON.stringify(g.world)} scaleZ=${g.scaleZ}`)
    console.log(`  green along beam: ${prof}`)
    // The first ~quarter is correctly hidden: the beam starts inside the sensor housing and passes
    // through the near guard, which occludes it except at the discarded hole. That is correct
    // depth-tested behaviour, so the span assertions start past it. The bug's signature is the
    // opposite: the far/middle stretch over the belt missing while the guard stubs remain.
    const span = prof.slice(12)
    const spanHits = (span.match(/#/g) ?? []).length
    const middle = prof.slice(15, 35)
    const midHits = (middle.match(/#/g) ?? []).length
    check(`${label}: beam is continuous across the belt`, spanHits >= span.length - 2, `${spanHits}/${span.length} samples past the housing`)
    check(`${label}: beam crosses the belt (not overdrawn to stubs)`, midHits >= 19, `${midHits}/20 middle samples`)
    await page.screenshot({ path: `e2e/shots/sensor-beam-overlay-${label}.png` })

    // --- blocked: the two per-instance channels (hit length, red tint) ---
    // Drawing every beam from one instanced bank means "blocked" cannot be a per-beam material
    // write. The length is in the instance matrix and the tint in instanceColor, and three compiles
    // the instance-colour node only if that attribute exists at first compile. A bank that missed it
    // draws a healthy-looking green beam at full length, so both are asserted in pixels, not just
    // read off the buffers.
    const clearLen = g.scaleZ
    await blockBeam(page, g.world)
    const blocked = await beamGeom(page)
    if (blocked.error) { check(`${label}: beam present while blocked`, false, blocked.error) } else {
      const [r, gr, b] = blocked.color ?? [0, 0, 0]
      check(`${label}: blocked beam stops at the cargo`, blocked.scaleZ < clearLen - 0.1, `${blocked.scaleZ} < ${clearLen}`)
      check(`${label}: blocked beam turns red (per-instance tint)`, r > gr && r > b, `rgb=${[r, gr, b].map((c) => +c.toFixed(3)).join(',')}`)
      const redProf = await greenProfile(page, blocked.screen, 'red')
      console.log(`  blocked beam scaleZ=${blocked.scaleZ}`)
      console.log(`  red along beam:   ${redProf}`)
      const redHits = (redProf.match(/#/g) ?? []).length
      check(`${label}: the RED beam reaches the screen (instanceColor path compiled)`, redHits >= 12, `${redHits}/40 samples red`)
      await page.screenshot({ path: `e2e/shots/sensor-beam-blocked-${label}.png` })
    }

    // --- mixed states in one draw ---
    // The strongest test of the per-instance model: a second sensor further along the same guard
    // stays clear while the first is blocked. One draw, one material, so if the tint were on the
    // material, both beams would take the last write and this check would catch it.
    const second = await mountSensorOnGuard(page, 's2', [1.5, -1.5])
    check(`${label}: second sensor snapped further along the guard`, second.ok, second.ok ? `pose=${JSON.stringify(second.pose)}` : 'findSnap never engaged')
    if (second.ok) {
      await page.waitForTimeout(1500)
      const beams = await allBeams(page)
      const reds = beams.filter((b) => b.color[0] > b.color[1])
      const greens = beams.filter((b) => b.color[1] > b.color[0])
      console.log(`  beams: ${beams.map((b) => `${b.color[0] > b.color[1] ? 'red' : 'green'}@${b.length}`).join(' ')}`)
      check(`${label}: both beams draw`, beams.length === 2, `${beams.length} drawn`)
      check(`${label}: one blocked (red, short) + one clear (green, full) at the same time`, reds.length === 1 && greens.length === 1 && reds[0].length < greens[0].length - 0.1)
      if (greens.length === 1 && reds.length === 1) {
        // Pixel-check each beam in its own framing: the two sit 1.5 m apart, and a single frame
        // wide enough to hold both puts one of them behind the PLC dock. Both exist in the same
        // draw throughout, which is what the assertion is about, not what is on screen at once.
        const isRed = (b) => b.color[0] > b.color[1]
        for (const [want, floor] of [['green', 20], ['red', 16]]) {
          const pick = (list) => list.find((b) => (want === 'red' ? isRed(b) : !isRed(b)))
          const m = pick(await allBeams(page)).mid
          await frame(page, m, [m[0] + 0.9, m[1] + 1.7, m[2] + 0.9])
          const b = pick(await allBeams(page)) // screen span is camera-dependent; re-read after the move
          const prof = await greenProfile(page, b.screen, want)
          console.log(`  ${want} along the ${want === 'red' ? 'BLOCKED' : 'CLEAR'} beam: ${prof}`)
          const hits = (prof.slice(12).match(/#/g) ?? []).length
          check(`${label}: the ${want === 'red' ? 'blocked beam is RED' : 'clear beam is still GREEN'} on screen while its neighbour is the other colour`, hits >= floor, `${hits}/28 samples past the housing`)
          await page.screenshot({ path: `e2e/shots/sensor-beam-mixed-${want}-${label}.png` })
        }
      }
    }

    // back to one clear beam for the visibility semantics below (they act on every sensor part)
    await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.loadScene({ ...s, parts: s.parts.filter((p) => p.id !== 'blocker' && p.id !== 's2') })
    })
    await page.waitForTimeout(1500)

    // --- the two visibility semantics the overlay has to handle ---
    // A beam is not a descendant of its part, so neither of these is implicit: showBeam is a flag
    // probeTick sets, and part visibility is mirrored per-frame. The hide/reveal case is the fragile
    // one: a probe that runs while the part is hidden can leave the beam off for good, because the
    // reveal does not trigger a probe.
    const beamDrawn = () => page.evaluate(async () => (await import('/src/render/sensorBeamOverlay.ts')).sensorBeamDebug().count)
    const setParam = (k, v) => page.evaluate(([key, val]) => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.loadScene({ ...s, parts: s.parts.map((p) => (p.packageId === 'oip.diffuse-sensor' ? { ...p, params: { ...p.params, [key]: val } } : p)) })
    }, [k, v])

    check(`${label}: beam draws while shown`, (await beamDrawn()) === 1)

    await setParam('showBeam', false)
    await page.waitForTimeout(900)
    check(`${label}: showBeam:false hides the beam`, (await beamDrawn()) === 0)
    await setParam('showBeam', true)
    await page.waitForTimeout(900)
    check(`${label}: showBeam:true brings it back`, (await beamDrawn()) === 1)

    const setVisible = (vis) => page.evaluate((v2) => {
      const st = window.__oip.store
      const id = st.getState().scene.parts.find((p) => p.packageId === 'oip.diffuse-sensor').id
      st.setVisible([id], v2)
    }, vis)
    await setVisible(false)
    await page.waitForTimeout(900)
    check(`${label}: hiding the part hides its beam`, (await beamDrawn()) === 0)
    await setVisible(true)
    await page.waitForTimeout(1200)
    check(`${label}: revealing the part restores its beam (reveal is not a probe seam)`, (await beamDrawn()) === 1)

    check(`${label}: no runtime errors`, errors.length === 0, errors.slice(0, 2).join(' | '))
    if (known.length) console.log(`  NOTE ${known.length}× known-unrelated null-sampler TypeError (building materials, pre-existing)`)
  } finally {
    await browser.close()
  }
}

async function main() {
  try {
    await arm('webgpu-bundles', '', true) // the arm the bug affects
    await arm('webgpu-nobundle', '?nobundle', true)
    await arm('webgl', '?nowebgpu', false)
  } finally {
    vite.kill('SIGTERM')
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(2) })
