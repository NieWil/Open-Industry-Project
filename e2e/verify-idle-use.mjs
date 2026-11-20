// Verify the stopped-scene Use (the editor's C, and the walking character's E - one model, pilot.ts idleUsePart):
// the press goes to a live session of the device's own behavior, so the device moves the way it would in a run and
// stays where the press leaves it, and none of it is ever an edit.
//
// It is not a "test stroke" that always comes home (C must be able to leave a gate open), nor a replay of a press
// count (a slow device like the E-stop doesn't survive that). The Inspector flags a latched device instead:
// it says the device is being operated, and Reset puts it back to its design.
//
//   1. Diverter (useParam: diverted, a slow 1.5 s stroke): C sweeps the pusher out through mid-stroke frames and it
//      stays out; the Inspector says it is operated. A second C brings it home, and back at its design the session
//      ends and the notice goes. The param, the undo stack and the saved document are untouched throughout.
//   2. Maintained push button (no joints - subPose cap + lamp): C presses it in and it stays in; C releases it.
//   3. Chain transfer (useParam: raised): C pops the lanes up and they stay; the Inspector's Reset drops them.
//   4. Play starts from the design: a device left operated is back at its param in the run, and the session is gone.
//   5. Control: the Inspector's path (a commit of the param) is an edit, and it ends a session on that part - so the
//      "nothing written" checks above can't pass on a store that simply never records anything.
// Run: node e2e/verify-idle-use.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function main() {
  // frame-timing test: disable the throttles that starve headless rAF (oip-web-e2e-headed-occlusion-flag)
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  const waitForApp = () => page.waitForFunction(
    () => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), undefined, { timeout: 30000 })

  /** load a scene holding just `part` (its package embedded), and wait for its rig meshes to stream in */
  const loadOne = async (part, minMeshes = 3) => {
    await page.evaluate((part) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkg = st.getState().bundledPackages.find((p) => p.id === part.packageId)
      st.loadScene({ ...scene, parts: [part], packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
      st.setState({ selectedIds: [] })
    }, part)
    const ok = await page.waitForFunction(([id, n]) => {
      let k = 0
      window.__oip.view.entries?.get(id)?.visual?.object?.traverse((o) => { if (o.isMesh) k++ })
      return k >= n
    }, [part.id, minMeshes], { timeout: 30000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(800) // idle preview settle after the meshes land
    return ok
  }

  /** every mesh's world coordinate on `axis` (1 = y, 2 = z), in stable traversal order */
  const coords = (id, axis) => page.evaluate(([id, axis]) => {
    const v = window.__oip.view
    v.scene.updateMatrixWorld(true)
    const out = []
    v.entries?.get(id)?.visual?.object?.traverse((o) => { if (o.isMesh) out.push(o.matrixWorld.elements[12 + axis]) })
    return out
  }, [id, axis])

  /**
   * Select `id`, press C, and record every mesh's coordinate on `axis` every rendered frame for `ms` - from inside the
   * page, since a whole sweep can fall between two Playwright round-trips.
   */
  const pressAndTrack = (id, axis, ms, settleMs = 0) => page.evaluate(async ([id, axis, ms, settleMs]) => {
    const { store, controller, view } = window.__oip
    const read = () => {
      view.scene.updateMatrixWorld(true)
      const out = []
      view.entries?.get(id)?.visual?.object?.traverse((o) => { if (o.isMesh) out.push(o.matrixWorld.elements[12 + axis]) })
      return out
    }
    store.setState({ selectedIds: [id] })
    controller.useSelection() // the editor C key
    const frames = []
    const t0 = performance.now()
    let lastChange = t0
    // With `settleMs`, carry on past `ms` while the device is still moving (until it has held still for settleMs,
    // capped at ms + 10 s). The session steps on wall time clamped to 0.1 s a frame (sim/idlePose.ts
    // IdleUseSession.advance: a stalled frame must not fast-forward the device), so a frame hitch - the GPU process
    // holding rAF back 1.4 s mid-sweep with the main thread idle, measured on this box under load - takes the time
    // out of the stroke rather than skipping it. A fixed window then catches the pusher short of its end
    // (0.62-0.69 m of 0.75) and calls a correct stroke incomplete. Waiting for it to stop, then judging where it
    // stopped, keeps every claim (full extension, mid-stroke frames, stays out) and drops the race.
    while (true) {
      await new Promise((r) => requestAnimationFrame(r))
      const now = performance.now()
      const f = read()
      const prev = frames[frames.length - 1]
      if (!prev || f.some((v, i) => Math.abs(v - prev[i]) > 1e-4)) lastChange = now
      frames.push(f)
      if (now - t0 < ms) continue
      if (!settleMs || now - lastChange >= settleMs || now - t0 >= ms + 10000) break
    }
    return frames
  }, [id, axis, ms, settleMs])

  const edits = () => page.evaluate(async () => ({ canUndo: window.__oip.store.canUndo, doc: (await window.__oip.savedProject()) }))
  const param = (id, key) => page.evaluate(([id, key]) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.params[key], [id, key])
  const operated = (id) => page.evaluate((id) => window.__oip.store.getState().usedIds.includes(id), id)
  const notice = () => page.evaluate(() => !!document.querySelector('[data-testid="inspector-used"]'))
  const running = () => page.evaluate(() => window.__oip.store.getState().running)
  // a session ends once the device has sat quietly at its design for 1.5 s
  const QUIET_MS = 2500

  try {
    await page.goto(URL)
    await waitForApp()
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await waitForApp()
    await page.waitForTimeout(800)

    // ── 1. diverter: no tag, a slow 1.5 s stroke so mid-sweep frames are unambiguous ──
    const divOk = await loadOne({ id: 'div_shot', type: 'part', packageId: 'oip.diverter', position: [0, 0.9, 0], rotationY: 0, params: { diverted: false, divertTime: 1.5, divertDistance: 0.75, tag: '' } })
    const divRest = await coords('div_shot', 2)
    check('diverter rig rendered at rest', divOk && divRest.length > 2, `meshes=${divRest.length}`)
    const e0 = await edits()
    check('the scene is saved and has nothing to undo (so "unchanged" below means something)', !!e0.doc && e0.doc.includes('div_shot') && !e0.canUndo)

    const restMin = Math.min(...divRest)
    const reachOf = (zs) => restMin - Math.min(...zs)
    const out = (await pressAndTrack('div_shot', 2, 3500, 500)).map(reachOf)
    const peak = Math.max(...out)
    check('C sweeps the pusher OUT to full extension (~divertDistance)', peak > 0.7 && peak < 0.8, `peak=${peak.toFixed(3)}m over ${out.length} frames`)
    check('...through mid-stroke frames, not a teleport', out.filter((r) => r > 0.1 && r < peak - 0.1).length >= 5)
    await page.waitForTimeout(1500)
    const held = reachOf(await coords('div_shot', 2))
    check('...and it STAYS out: a press leaves the device where a press leaves it', Math.abs(held - peak) < 0.02, `reach=${held.toFixed(3)}m`)
    check('the store lists it as operated', await operated('div_shot'))
    check('...and the Inspector says so', await notice())
    const e1 = await edits()
    check('the param is untouched (diverted=false), nothing to undo, the saved document unchanged',
      (await param('div_shot', 'diverted')) === false && !e1.canUndo && e1.doc === e0.doc)

    const back = (await pressAndTrack('div_shot', 2, 3500, 500)).map(reachOf)
    check('a second C brings it home, sweeping', Math.abs(back[back.length - 1]) < 0.02 && back.filter((r) => r > 0.1 && r < 0.65).length >= 5,
      `end=${back[back.length - 1].toFixed(3)}m`)
    await page.waitForTimeout(QUIET_MS)
    check('back at its design, the session ends: not operated, no notice', !(await operated('div_shot')) && !(await notice()))
    check('sim never started', (await running()) === false)

    // ── 2. maintained push button: no joints - the cap is a subPose, the light a lamp ──
    const btnOk = await loadOne({ id: 'btn_shot', type: 'part', packageId: 'oip.push-button', position: [0, 1.0, 0], rotationY: 0, params: { text: 'GO', momentary: false, normallyClosed: false, tag: '', lampTag: '' } }, 2)
    const btnRest = await coords('btn_shot', 2)
    const dropOf = (zs) => (zs.length === btnRest.length ? Math.max(...btnRest.map((z, i) => z - zs[i])) : NaN)
    await pressAndTrack('btn_shot', 2, 1500)
    const pressed = dropOf(await coords('btn_shot', 2))
    check('maintained push button rendered', btnOk && btnRest.length >= 2, `meshes=${btnRest.length}`)
    check('C presses the cap in, and it STAYS in (subPose, zero joints)', pressed > 0.0075 && pressed < 0.0125, `drop=${pressed.toFixed(3)}m`)
    await pressAndTrack('btn_shot', 2, 1500)
    const released = dropOf(await coords('btn_shot', 2))
    check('...and a second C releases it', Math.abs(released) < 0.003, `drop=${released.toFixed(4)}m`)

    // ── 3. chain transfer (useParam: raised): up, stays up, and the Inspector's Reset drops it ──
    const chainOk = await loadOne({ id: 'chain_shot', type: 'part', packageId: 'oip.chain-transfer', position: [0, 0.9, 0], rotationY: 0, params: { chains: 5, distance: 0.33, laneLength: 2, speed: 2, raised: false, speedTag: '', popupTag: '' } })
    const chainRest = Math.max(...(await coords('chain_shot', 1)))
    await pressAndTrack('chain_shot', 1, 1500)
    const lift = Math.max(...(await coords('chain_shot', 1))) - chainRest
    check('chain transfer lanes rendered', chainOk && Number.isFinite(chainRest))
    check('C pops the chains UP (~0.095 m) and they stay up', lift > 0.07 && lift < 0.12, `lift=${lift.toFixed(3)}m`)
    check('the Inspector says it is operated', await notice())
    await page.evaluate(() => document.querySelector('[data-testid="inspector-used-reset"]')?.click())
    await page.waitForTimeout(800)
    const afterReset = Math.max(...(await coords('chain_shot', 1))) - chainRest
    check('the Inspector\'s Reset puts it back to its design (down)', Math.abs(afterReset) < 0.02, `lift=${afterReset.toFixed(3)}m`)
    check('...the session is gone, and the param untouched, nothing to undo',
      !(await operated('chain_shot')) && !(await notice()) && (await param('chain_shot', 'raised')) === false && !(await edits()).canUndo)

    // ── 4. Play starts from the design, not from what a stopped Use left a device doing ──
    await pressAndTrack('chain_shot', 1, 1500)
    check('(raised again with C before Play)', await operated('chain_shot'))
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running, undefined, { timeout: 30000 })
    await page.waitForTimeout(2500)
    const runLift = Math.max(...(await coords('chain_shot', 1))) - chainRest
    check('in the run the chains are DOWN, as the design says (raised=false)', Math.abs(runLift) < 0.02, `lift=${runLift.toFixed(3)}m`)
    check('...and Play ended the session', !(await operated('chain_shot')))
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => !window.__oip.store.getState().running, undefined, { timeout: 30000 })
    await page.waitForTimeout(800)

    // ── 5. control: the Inspector's path is where the starting state is set - that is an edit, and it takes precedence ──
    await pressAndTrack('chain_shot', 1, 1500)
    check('(raised with C before the Inspector edit)', await operated('chain_shot'))
    const docBefore = (await edits()).doc
    await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      st.commit('Edit part', { ...scene, parts: scene.parts.map((p) => (p.id === 'chain_shot' ? { ...p, params: { ...p.params, raised: true } } : p)) })
    })
    await page.waitForTimeout(1000)
    const ctrlLift = Math.max(...(await coords('chain_shot', 1))) - chainRest
    const ec = await edits()
    check('CONTROL: an Inspector edit of `raised` is undoable and saved', ec.canUndo && ec.doc !== docBefore)
    check('CONTROL: and the chains stand raised on it', ctrlLift > 0.07, `lift=${ctrlLift.toFixed(3)}m`)
    check('CONTROL: the edit ended the session on that part (the design wins)', !(await operated('chain_shot')))

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
