// Verify the flex conveyor is pulled into shape, the two ways a real one is, from either end.
//   A) Editor: selecting one shows a dot on its infeed and on every control point of its path (the `flexPath` handle,
//      core/parts/partGeometry flexPathOf / flexPull). Dragging the end dot round to the side curves the bed to it; dragging
//      a middle dot the other way makes an S. Each drag writes the points and the bed length together, the infeed
//      holds, and a drag is one undo step. Dragging the infeed dot moves the part itself while every control point
//      holds in the world. A drag past full length stops at full length rather than being refused.
//   B) Walk mode: the character looks at the bed near its end, presses Use ("Pull"), and walks sideways: the end
//      follows the hands, at hauling pace: it has weight, so a flick of the view cannot whip it round, and the
//      character walks no faster while holding it. Hauled on past full length (staged near it, so the gate does not
//      walk 16 m), the whole unit is drawn after the hands like a chain, its infeed too.
//      That is walk-session state (store.walkFlex), not an edit: the authored scene is untouched, nothing goes on
//      the undo stack, and leaving walk mode puts the bed back.
//   C) Caster brakes: a braked end says "Brakes on" and cannot be taken hold of, and with the far end braked a pull
//      past full length stops there instead of drawing the unit along.
//   Run: node e2e/verify-flex-conveyor-drag.mjs [--headed]
/* global process, console, window, localStorage */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SHOTS = join(import.meta.dirname, 'shots')
mkdirSync(SHOTS, { recursive: true })
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const H = 0.8

/** one straight flex conveyor at the origin, selected, camera aimed from above (`over` sets params on it) */
function stageScene(page, over = {}) {
  return page.evaluate(([h, over]) => {
    const { store: st, view } = window.__oip
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.flex-conveyor')
    if (!pkg) return { error: 'no flex conveyor package' }
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params)) params[k] = spec.default
    params.standHeight = h
    Object.assign(params, over)
    const flex = { id: 'f1', type: 'part', packageId: pkg.id, position: [0, h, 0], rotationY: 0, params }
    st.loadScene({ parts: [flex], packages: [pkg] })
    st.select('f1')
    const cam = view.camera
    cam.position.set(4, 12, 6)
    view.controls.target.set(4, h, -1)
    view.controls.update()
    cam.updateMatrixWorld(true)
    return { points: params.points, length: params.length }
  }, [H, over])
}

/** walk mode, standing at x (1.5 m past a straight bed's end) and facing back along it, looking down at it */
const walkToEnd = (page, x = 9.5) => page.evaluate((x) => {
  const { store: st, view } = window.__oip
  st.setState({ selectedIds: [] })
  st.enterPilot()
  const p = view.pilot
  p.pos.set(x, 0, 0)
  p.yaw = Math.PI / 2
  p.pitch = -0.45
}, x)

/** the held flex's walk shape, its discharge end and the hands in the world, and the authored part's position */
const heldEnd = (page) => page.evaluate(() => {
  const { store, view } = window.__oip
  const st = store.getState()
  const auth = st.scene.parts.find((x) => x.id === 'f1')
  const w = st.walkFlex?.f1 ?? null
  const pose = w ?? { position: auth.position, rotationY: auth.rotationY, params: auth.params }
  const [x, z] = pose.params.points[pose.params.points.length - 1]
  const c = Math.cos(pose.rotationY), s = Math.sin(pose.rotationY)
  const hold = view.pilotHoldPoint()
  return {
    w,
    end: [pose.position[0] + x * c + z * s, pose.position[2] - x * s + z * c],
    hold: hold ? [hold.position[0], hold.position[2]] : [NaN, NaN],
    authored: auth.position,
  }
})

/** walk backwards (away from the bed, facing it) for `ms`, then stand while the end catches up with the hands;
 *  `late` = how far the character walked in the last two seconds of it */
async function haulBack(page, ms) {
  const pos = () => page.evaluate(() => window.__oip.view.pilot.pos.toArray())
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__oip.view.pilotSetMove(-1, 0))
  await page.waitForTimeout(ms - 2000)
  const a = await pos()
  await page.waitForTimeout(2000)
  const b = await pos()
  await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
  await page.waitForTimeout(2000)
  return { late: Math.hypot(b[0] - a[0], b[2] - a[2]) }
}

const visibleDots = (page) => page.evaluate(() =>
  window.__oip.view.handles.cubes.filter((c) => c.group.visible).map((c) => ({ handle: c.handle, pos: c.group.position.toArray() })))

const flexParams = (page) => page.evaluate(() => {
  const p = window.__oip.store.getState().scene.parts.find((x) => x.id === 'f1')
  return { points: p.params.points, length: p.params.length, position: p.position, rotationY: p.rotationY }
})

/** point the camera from `pos` at `target` (a wider view for the drags that reach far off the bed) */
const aim = (page, pos, target) => page.evaluate(([a, b]) => {
  const { view } = window.__oip
  view.camera.position.set(a[0], a[1], a[2])
  view.controls.target.set(b[0], b[1], b[2])
  view.controls.update()
  view.camera.updateMatrixWorld(true)
}, [pos, target])

/** drag the visible dot for control point `i` to world `to` with the real pointer */
async function dragDot(page, i, to) {
  const dot = (await visibleDots(page)).find((d) => d.handle.flexPoint === i)
  if (!dot) return false
  const s = await page.evaluate(([a, b]) => {
    const view = window.__oip.view
    return { from: view.worldToScreen(a[0], a[1], a[2]), to: view.worldToScreen(b[0], b[1], b[2]) }
  }, [dot.pos, to])
  await page.mouse.move(s.from.x, s.from.y)
  await page.mouse.down()
  await page.mouse.move(s.to.x, s.to.y, { steps: 14 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  return true
}

/** planar distance from a [x, z] control point to a world [x, y, z] target (the part sits at the origin, unrotated) */
const endDist = (pt, target) => Math.hypot(pt[0] - target[0], pt[1] - target[2])

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|Failed to fetch/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })
  try {
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    // visit 1 warms vite's lazy deps (a dep re-optimize full-reloads the page); visit 2 is the real run
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
    await page.waitForTimeout(1000)
    await stageScene(page).catch(() => {})
    await page.waitForTimeout(8000)
    errors.length = 0
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
    // the viewport's loading cover lifts once shaders are compiled: before that nothing draws and a click lands on it
    await page.waitForSelector('.viewport-cover.ready', { timeout: 120000 }).catch(() => {})
    await page.waitForTimeout(800)

    const staged = await stageScene(page)
    check('scene + handle probe ran', !staged.error, staged.error || '')
    if (staged.error) return
    await page.waitForTimeout(400)

    // ---- A) the editor's path dots
    const dots = await visibleDots(page)
    const pts = staged.points
    check(`a dot on the infeed and each of the ${pts.length} control points, and nothing else`,
      dots.length === pts.length + 1 &&
        dots.some((d) => d.handle.flexPoint === 'infeed' && Math.abs(d.pos[0]) < 1e-3 && Math.abs(d.pos[2]) < 1e-3) &&
        pts.every((p, i) => dots.some((d) => d.handle.flexPoint === i && Math.abs(d.pos[0] - p[0]) < 1e-3 && Math.abs(d.pos[2] - p[1]) < 1e-3)),
      JSON.stringify(dots.map((d) => [d.handle, d.pos.map((v) => +v.toFixed(2))])))

    // a wider view: the drags below reach well past the straight bed
    await aim(page, [8, 24, 12], [8, H, -1])
    await page.waitForTimeout(300)

    // the short bed hauled hard round to the side: a scissor bed near fully collapsed has almost no bend in it (its
    // rollers would close up on the inside of the curve), so the end stops at that limit, short of the pointer
    const TIGHT_TO = [7.5, H, -2.5]
    await dragDot(page, pts.length - 1, TIGHT_TO)
    const tight = await flexParams(page)
    const tightEnd = tight.points[tight.points.length - 1]
    check('a short bed hauled round a tight corner stops short of it (the rollers\' limit)',
      endDist(tightEnd, TIGHT_TO) > 0.5 && Math.abs(tightEnd[1]) > 0.1, `end=${tightEnd.map((v) => v.toFixed(2))}`)
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(200)

    // the end out and round to the left (-z): stretched, the bed has the bend to curve to it
    const END_TO = [12.5, H, -3]
    await dragDot(page, pts.length - 1, END_TO)
    const bent = await flexParams(page)
    const endPt = bent.points[bent.points.length - 1]
    check('dragging the end dot moved the end under the pointer', endDist(endPt, END_TO) < 0.2, `end=${endPt.map((v) => v.toFixed(2))}`)
    check('...and re-derived the bed length', Math.abs(bent.length - staged.length) > 0.05, `length ${staged.length} -> ${bent.length.toFixed(2)}`)
    check('the infeed held (the part did not move)', bent.position.every((v, i) => Math.abs(v - [0, H, 0][i]) < 1e-9), JSON.stringify(bent.position))

    // the first control point the other way (+z): an S. Still from the wide camera, where this dot sits right on the
    // move gizmo's X arrow: the path dot must win the press (controller pickFlexDot), not the gizmo
    const MID_TO = [3, H, 1.2]
    const onArrow = await page.evaluate(() => {
      const { view } = window.__oip
      const c = view.handles.cubes.find((x) => x.group.visible && x.handle.flexPoint === 0)
      const p = view.worldToScreen(c.group.position.x, c.group.position.y, c.group.position.z)
      return !!view.pickGizmoHandle(p.x, p.y)
    })
    check('(the first control point\'s dot does sit on a gizmo handle from here)', onArrow)
    await dragDot(page, 0, MID_TO)
    const s = await flexParams(page)
    check('dragging a middle dot moved just that point (an S)', endDist(s.points[0], MID_TO) < 0.2 && endDist(s.points[s.points.length - 1], END_TO) < 0.2,
      JSON.stringify(s.points.map((p) => p.map((v) => +v.toFixed(2)))))
    await page.waitForTimeout(1500) // the stopped bed is posed by its behavior's idle preview, a frame or two behind the drag
    await page.screenshot({ path: join(SHOTS, 'flex-conveyor-drag.png') })

    // one drag, one undo step
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(200)
    const undo1 = await flexParams(page)
    check('one undo takes back only the S drag', JSON.stringify(undo1.points) === JSON.stringify(bent.points), JSON.stringify(undo1.points))
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(200)
    const undo2 = await flexParams(page)
    check('a second puts it back straight', JSON.stringify(undo2.points) === JSON.stringify(pts) && Math.abs(undo2.length - staged.length) < 1e-9, JSON.stringify(undo2))

    // the infeed dot back and a little to the side: the part moves there, and the path holds in the world
    await aim(page, [12, 40, 14], [12, H, 0])
    await page.waitForTimeout(300)
    const IN_TO = [-2, H, 0.6]
    await dragDot(page, 'infeed', IN_TO)
    const fed = await flexParams(page)
    const worldEnd = (f) => {
      const [x, z] = f.points[f.points.length - 1]
      const c = Math.cos(f.rotationY), s = Math.sin(f.rotationY)
      return [f.position[0] + x * c + z * s, f.position[2] - x * s + z * c]
    }
    check('dragging the infeed dot moved the part under the pointer', Math.hypot(fed.position[0] - IN_TO[0], fed.position[2] - IN_TO[2]) < 0.2,
      JSON.stringify(fed.position))
    const fedEnd = worldEnd(fed)
    check('...and the discharge end held in the world', Math.hypot(fedEnd[0] - pts[pts.length - 1][0], fedEnd[1] - pts[pts.length - 1][1]) < 1e-6,
      `end=${fedEnd.map((v) => v.toFixed(4))}`)
    check('...with the bed length re-derived', fed.length > staged.length + 1, `length ${staged.length} -> ${fed.length.toFixed(2)}`)
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(200)

    // the end dot dragged far past what the bed can reach: it stops at full length, not wherever the drag was refused
    const lengthMax = await page.evaluate(() => window.__oip.store.getState().bundledPackages.find((p) => p.id === 'oip.flex-conveyor').params.length.max)
    await dragDot(page, pts.length - 1, [lengthMax + 8, H, 0])
    const far = await flexParams(page)
    check('a drag past full length stops at full length', Math.abs(far.length - lengthMax) < 0.01 && far.position.every((v, i) => Math.abs(v - [0, H, 0][i]) < 1e-9),
      `length=${far.length.toFixed(3)} max=${lengthMax}`)
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(200)

    // ---- B) walk mode: grab the end and walk it round
    const walk = await page.evaluate((h) => {
      const { store: st, view } = window.__oip
      st.setState({ selectedIds: [] })
      const undoDepth = st.undoStack?.length ?? null
      st.enterPilot()
      const p = view.pilot
      // stand a metre and a half past the straight bed's end, facing back along it (-x), looking down at it
      p.pos.set(9.5, 0, 0)
      p.yaw = Math.PI / 2
      p.pitch = -0.45
      return { undoDepth, sceneBefore: st.getState().scene, h }
    }, H)
    await page.waitForTimeout(600)
    const prompt = await page.evaluate(() => window.__oip.store.getState().pilotPrompt)
    check('looking at the flex near its end offers "Pull"', prompt === 'Pull', `prompt=${prompt}`)
    await page.evaluate(() => window.__oip.view.pilot.interact())
    await page.waitForTimeout(300)
    const held = await page.evaluate(() => window.__oip.store.getState().pilotPrompt)
    check('...and a press takes hold ("Let go")', held === 'Let go', `prompt=${held}`)
    // strafe: facing -x, a positive strafe walks toward -z
    await page.evaluate(() => window.__oip.view.pilotSetMove(0, 1))
    await page.waitForTimeout(2500)
    await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
    await page.waitForTimeout(400)
    const pulled = await page.evaluate(() => {
      const st = window.__oip.store.getState()
      const auth = st.scene.parts.find((x) => x.id === 'f1')
      return { walkFlex: st.walkFlex?.f1 ?? null, authored: auth.params.points, pilot: window.__oip.view.pilot.pos.toArray() }
    })
    const wEnd = pulled.walkFlex?.params?.points?.[pulled.walkFlex.params.points.length - 1]
    check('walking sideways swung the end with the hands', !!wEnd && Math.abs(wEnd[1]) > 0.8,
      `end=${wEnd?.map((v) => v.toFixed(2))} pilot=${pulled.pilot.map((v) => v.toFixed(2))}`)
    check('...without editing the scene (authored points untouched)', JSON.stringify(pulled.authored) === JSON.stringify(pts), JSON.stringify(pulled.authored))
    await page.screenshot({ path: join(SHOTS, 'flex-conveyor-walk-pull.png') })

    // it has weight: a flick of the view does not whip the end round (it follows at hauling pace)...
    const before = await heldEnd(page)
    await page.evaluate(() => { window.__oip.view.pilot.yaw += Math.PI })
    await page.waitForTimeout(500)
    const flicked = await heldEnd(page)
    const moved = Math.hypot(flicked.end[0] - before.end[0], flicked.end[1] - before.end[1])
    check('a flick of the view does not whip the held end round', moved < 1.2,
      `end moved ${moved.toFixed(2)} m in 0.5 s while the hands swung ${Math.hypot(flicked.hold[0] - before.hold[0], flicked.hold[1] - before.hold[1]).toFixed(2)} m`)
    await page.evaluate(() => { window.__oip.view.pilot.yaw -= Math.PI })
    await page.waitForTimeout(1500)
    // ...and walking backwards opens it at a brisk walk: light work, the far end standing (towing is slower, below)
    const from = await page.evaluate(() => window.__oip.view.pilot.pos.toArray())
    await page.evaluate(() => window.__oip.view.pilotSetMove(-1, 0))
    await page.waitForTimeout(2000)
    await page.evaluate(() => window.__oip.view.pilotSetMove(0, 0))
    const to = await page.evaluate(() => window.__oip.view.pilot.pos.toArray())
    const walked = Math.hypot(to[0] - from[0], to[2] - from[2])
    check('opening it walking backwards goes at a brisk walk, not a jog', walked > 2.8 && walked < 4.6, `walked ${walked.toFixed(2)} m in 2 s`)
    await page.evaluate(() => window.__oip.view.pilot.interact()) // let go
    await page.evaluate(() => window.__oip.store.exitPilot())
    await page.waitForTimeout(300)
    const after = await page.evaluate((depth) => {
      const st = window.__oip.store
      return { walkFlex: st.getState().walkFlex, depth: st.undoStack?.length ?? null, same: depth }
    }, walk.undoDepth)
    check('leaving walk mode drops the pulled shape', after.walkFlex === null, JSON.stringify(after.walkFlex))
    check('...and nothing reached the undo stack', after.depth === walk.undoDepth, `${walk.undoDepth} -> ${after.depth}`)
    const freed = await page.evaluate(() => { const p = window.__oip.view.pilot; return p.speedLimit ?? null })
    check('...and the character walks freely again', freed === null, `speed limit ${freed}`)

    // ---- walk mode on a bed near full stretch: hauled on past it, the whole unit is drawn after the hands
    const STRETCHED = { points: [[8, 0], [16, 0], [23, 0]], length: 23 }
    const lengthMaxWalk = await page.evaluate(() => window.__oip.store.getState().bundledPackages.find((p) => p.id === 'oip.flex-conveyor').params.length.max)
    await stageScene(page, STRETCHED)
    await walkToEnd(page, 24.5)
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__oip.view.pilot.interact())
    const towed = await haulBack(page, 4000)
    check('towing the whole unit, the character slows to hauling pace', towed.late > 0.8 && towed.late < 2.6,
      `walked ${towed.late.toFixed(2)} m in the last 2 s`)
    const rolled = await heldEnd(page)
    check('hauled past full length, the bed is at full length', !!rolled.w && Math.abs(rolled.w.params.length - lengthMaxWalk) < 0.01,
      `length=${rolled.w?.params.length?.toFixed(3)}`)
    check('...the end is in the hands', Math.hypot(rolled.end[0] - rolled.hold[0], rolled.end[1] - rolled.hold[1]) < 0.15,
      `end=${rolled.end.map((v) => v.toFixed(2))} hold=${rolled.hold.map((v) => v.toFixed(2))}`)
    check('...and the infeed was drawn after them', !!rolled.w && rolled.w.position[0] > 1.5, `infeed=${rolled.w?.position.map((v) => v.toFixed(2))}`)
    check('...without moving the authored part', rolled.authored.every((v, i) => Math.abs(v - [0, H, 0][i]) < 1e-9), JSON.stringify(rolled.authored))
    await page.evaluate(() => window.__oip.view.pilot.interact())
    await page.evaluate(() => window.__oip.store.exitPilot())

    // ---- C) caster brakes: a braked end says so and cannot be taken hold of...
    await stageScene(page, { dischargeBrakes: true })
    await walkToEnd(page)
    await page.waitForTimeout(600)
    const brakedPrompt = await page.evaluate(() => window.__oip.store.getState().pilotPrompt)
    check('a braked end offers no Pull ("Brakes on")', brakedPrompt === 'Brakes on', `prompt=${brakedPrompt}`)
    await page.evaluate(() => window.__oip.view.pilot.interact())
    await page.waitForTimeout(300)
    const stillBraked = await page.evaluate(() => window.__oip.store.getState().pilotPrompt)
    check('...and a press does not take hold of it', stillBraked === 'Brakes on', `prompt=${stillBraked}`)
    await page.evaluate(() => window.__oip.store.exitPilot())

    // ...and a braked far end is never drawn along: hauled on past full length, the bed stops at full length
    await stageScene(page, { ...STRETCHED, infeedBrakes: true })
    await walkToEnd(page, 24.5)
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__oip.view.pilot.interact())
    await haulBack(page, 3000)
    const stopped = await page.evaluate(() => window.__oip.store.getState().walkFlex?.f1 ?? null)
    check('with the infeed braked, a pull past full length stops at full length',
      !!stopped && Math.abs(stopped.params.length - lengthMaxWalk) < 0.01 && stopped.position.every((v, i) => Math.abs(v - [0, H, 0][i]) < 1e-9),
      JSON.stringify(stopped && { length: stopped.params.length, position: stopped.position }))
    await page.evaluate(() => window.__oip.view.pilot.interact())
    await page.evaluate(() => window.__oip.store.exitPilot())

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `=== FAIL === (${failures})` : '=== ALL PASS ===')
  process.exit(failures ? 1 : 0)
}
main()
