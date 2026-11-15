// Verify that a transform drag ends when its release never arrives. Alt-Tab (or any focus change) in the middle of
// a drag can swallow the pointerup, and the controller then kept the drag alive: the next plain mouse move, with no
// button held, went on moving the part. Two routes end it now, both as a cancel (the part goes back where the drag
// started, like Escape):
//   - a pointer move that reports no button held while a drag is open
//   - the window losing focus
// A control drag released normally first proves the setup moves the part at all. Also covered, as the other two
// ways a drag's modifiers or ending went wrong: Escape held to cancel a drag must not let its auto-repeats go on to
// clear the selection, and Cmd (Meta) must invert grid snap mid-drag the way Ctrl does. And the camera: a middle-drag
// pan whose release is lost must end too (OrbitControls let go of the pointer), on a no-button move or on blur.
// Run: node e2e/verify-drag-lost-release.mjs [--headed]
/* global process, console, window, localStorage, Event */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
const posX = (page) => page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'belt1')?.position[0])
const dragOpen = (page) => page.evaluate(() => window.__oip.controller.drag != null)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.belt-conveyor'), null, { timeout: 60000 })
    await page.waitForSelector('.viewport-cover.ready, .viewport-cover:not(*)', { timeout: 30000 }).catch(() => {})

    await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const belt = { id: 'belt1', type: 'part', packageId: pkg.id, position: [0, 0.5, 0], rotationY: 0, name: 'Belt', params }
      store.loadScene({ version: store.getState().scene.version, parts: [belt], packages: [pkg] })
      store.setSpace('global')
      store.setTool('move')
      store.select('belt1')
      // grid snap off, so a drag moves the part by what the pointer moved and not by whole steps
      store.setState({ gridSnap: { ...store.getState().gridSnap, enabled: false } })
    })
    await page.waitForTimeout(600)

    // the world +X translate handle, found by probing the gizmo along the projected +X axis
    const grab = await page.evaluate(() => {
      const { view } = window.__oip
      view.camera.updateMatrixWorld(true)
      const c0 = view.worldToScreen(0, 0.5, 0)
      const cx = view.worldToScreen(1, 0.5, 0)
      const len = Math.hypot(cx.x - c0.x, cx.y - c0.y) || 1
      const dir = { x: (cx.x - c0.x) / len, y: (cx.y - c0.y) / len }
      for (let r = 8; r <= 260; r += 4)
        for (const s of [1, -1])
          for (let perp = -18; perp <= 18; perp += 6) {
            const x = c0.x + dir.x * r * s - dir.y * perp
            const y = c0.y + dir.y * r * s + dir.x * perp
            if (view.pickGizmoHandle(x, y) === 'x') return { x, y, dir }
          }
      return null
    })
    check('found the +X translate handle', !!grab)
    if (!grab) return
    const at = (px) => ({ x: grab.x + grab.dir.x * px, y: grab.y + grab.dir.y * px })

    /** press on the handle and drag it `px` along +X, leaving the button down */
    async function beginDrag(px) {
      await page.mouse.move(grab.x, grab.y)
      await page.mouse.down()
      for (let i = 1; i <= 5; i++) {
        const p = at((px * i) / 5)
        await page.mouse.move(p.x, p.y)
        await page.waitForTimeout(20)
      }
    }

    // control: an ordinary drag moves the part and ends on release
    const x0 = await posX(page)
    await beginDrag(80)
    await page.mouse.up()
    await page.waitForTimeout(150)
    const x1 = await posX(page)
    check('control: a released drag moves the part', Math.abs(x1 - x0) > 0.05, `${x0.toFixed(3)} -> ${x1.toFixed(3)}`)
    check('control: and ends', !(await dragOpen(page)))

    // the release is lost: the next move arrives with no button held
    await beginDrag(80)
    const xDragging = await posX(page)
    check('setup: the second drag is open and has moved the part', (await dragOpen(page)) && Math.abs(xDragging - x1) > 0.05)
    const far = at(200)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: far.x, y: far.y, button: 'none', buttons: 0 })
    await page.waitForTimeout(150)
    check('a move with no button held ends the drag', !(await dragOpen(page)))
    const xAfter = await posX(page)
    check('and cancels it, putting the part back', Math.abs(xAfter - x1) < 1e-6, `${xAfter.toFixed(3)} vs start ${x1.toFixed(3)}`)
    await page.mouse.up() // Playwright still thinks the button is down

    // the window loses focus mid-drag
    await beginDrag(80)
    check('setup: the third drag is open', await dragOpen(page))
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(150)
    check('losing focus ends the drag', !(await dragOpen(page)))
    check('and cancels it', Math.abs((await posX(page)) - x1) < 1e-6)
    await page.mouse.up()

    // Escape held to cancel a drag: the first press cancels, and the key's auto-repeats must not walk on and clear
    // the selection (one press backs out one level)
    const selected = () => page.evaluate(() => window.__oip.store.getState().selectedIds.join(','))
    const escape = (autoRepeat) =>
      cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, autoRepeat })
    await beginDrag(80)
    await escape(false)
    await page.waitForTimeout(100)
    check('Escape cancels the drag', !(await dragOpen(page)) && Math.abs((await posX(page)) - x1) < 1e-6)
    for (let i = 0; i < 3; i++) await escape(true)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.waitForTimeout(100)
    check('held Escape keeps the selection after the cancel', (await selected()) === 'belt1', `selected: "${await selected()}"`)
    await page.mouse.up()
    // control: a fresh press still backs out of the selection
    await escape(false)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.waitForTimeout(100)
    check('control: a new Escape press clears the selection', (await selected()) === '')

    // Cmd inverts grid snap during a drag the way Ctrl does: the keymap reads "ctrl" as Ctrl or Cmd, and the drag
    // used to read Ctrl only, so on a Mac the modifier did nothing. Snap on, 1 m steps: a plain drag lands on a
    // whole metre, a drag holding the modifier does not.
    await page.evaluate(() => {
      const st = window.__oip.store
      st.select('belt1')
      st.setState({ gridSnap: { ...st.getState().gridSnap, enabled: true, translate: 1 } })
    })
    await page.waitForTimeout(200)
    const fractional = (x) => Math.abs(x - Math.round(x)) > 0.01
    async function snapDrag(modifier) {
      const start = await posX(page)
      if (modifier) await page.keyboard.down(modifier)
      await beginDrag(53)
      const x = await posX(page)
      await page.keyboard.press('Escape') // cancel, so each drag starts from the same place
      if (modifier) await page.keyboard.up(modifier)
      await page.mouse.up()
      await page.waitForTimeout(100)
      return x - start
    }
    const plain = await snapDrag(null)
    check('control: with snap on, a plain drag moves in whole metres', !fractional(plain) && Math.abs(plain) >= 1, plain.toFixed(3))
    const ctrl = await snapDrag('Control')
    check('control: Ctrl turns snapping off for the drag', fractional(ctrl), ctrl.toFixed(3))
    const meta = await snapDrag('Meta')
    check('Cmd (Meta) turns it off the same way', fractional(meta) && Math.abs(meta - ctrl) < 1e-6, `${meta.toFixed(3)} vs Ctrl ${ctrl.toFixed(3)}`)

    // A scene that arrives mid-drag from somewhere else (an agent's edit, a folder reload, a project load) ends the
    // drag and stays whole. Each move rebuilds the scene from the one the drag started on, so the drag used to write
    // that old scene back over the arrival on its next move and commit it on release.
    const sceneNow = () => page.evaluate(() => window.__oip.store.getState().scene.parts.map((p) => `${p.id}@${p.position[0].toFixed(2)}`).join(' '))
    const partIds = () => page.evaluate(() => window.__oip.store.getState().scene.parts.map((p) => p.id).join(' '))
    await page.evaluate(() => {
      const st = window.__oip.store
      st.setState({ gridSnap: { ...st.getState().gridSnap, enabled: false } })
    })
    const far2 = at(200)
    const xHere = await posX(page)
    await beginDrag(80)
    check('setup: a drag is open for the scene load', (await dragOpen(page)) && Math.abs((await posX(page)) - xHere) > 0.05)
    await page.evaluate((x) => {
      const { store } = window.__oip
      const sc = store.getState().scene
      const belt = { ...sc.parts[0], position: [x, 0.5, 0] }
      store.loadScene({ ...sc, parts: [belt, { ...belt, id: 'other1', name: 'Other', position: [x, 0.5, 4] }] })
      store.select('belt1')
    }, xHere)
    check('a scene load ends the drag', !(await dragOpen(page)))
    await page.mouse.move(far2.x, far2.y)
    await page.waitForTimeout(100)
    await page.mouse.up()
    await page.waitForTimeout(150)
    const loaded = `belt1@${xHere.toFixed(2)} other1@${xHere.toFixed(2)}`
    check('and the loaded scene stays as loaded', (await sceneNow()) === loaded, `${await sceneNow()} vs ${loaded}`)

    await page.waitForTimeout(300)
    await beginDrag(80)
    check('setup: a drag is open for the edit from elsewhere', (await dragOpen(page)) && Math.abs((await posX(page)) - xHere) > 0.05)
    await page.evaluate(() => {
      const { store } = window.__oip
      const sc = store.getState().scene
      store.commit('Add part', { ...sc, parts: [...sc.parts, { ...sc.parts[0], id: 'belt2', name: 'Belt 2', position: [0, 0.5, 8] }] })
    })
    check('an edit from elsewhere ends the drag', !(await dragOpen(page)))
    await page.mouse.move(far2.x, far2.y)
    await page.waitForTimeout(100)
    check('the next move leaves the added part in the scene', (await partIds()) === 'belt1 other1 belt2', await partIds())
    await page.mouse.up()
    await page.waitForTimeout(150)
    check('and so does the release', (await partIds()) === 'belt1 other1 belt2', await partIds())

    // Camera navigation loses its release the same way: OrbitControls kept the pointer, so after Alt-Tab the camera
    // went on panning as the mouse hovered. A plain middle drag pans (core/navigation.ts). The view hands
    // OrbitControls the missed release on a no-button move or on blur; the camera stays where the drag left it.
    const camPos = () => page.evaluate(() => window.__oip.view.camera.position.toArray().map((v) => +v.toFixed(4)).join(','))
    const navigating = () => page.evaluate(() => window.__oip.view.nav.navigating)
    // upper right of the 3D canvas, away from the belt and its gizmo at the centre
    const empty = await page.evaluate(() => {
      const r = window.__oip.view.renderer.domElement.getBoundingClientRect()
      return { x: r.left + r.width * 0.85, y: r.top + r.height * 0.25 }
    })
    async function beginPan() {
      await page.mouse.move(empty.x, empty.y)
      await page.mouse.down({ button: 'middle' })
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(empty.x - i * 12, empty.y + i * 6)
        await page.waitForTimeout(30)
      }
    }
    await page.evaluate(() => window.__oip.store.clearSelection())
    const p0 = await camPos()
    await beginPan()
    check('setup: a middle drag pans the camera', (await navigating()) && (await camPos()) !== p0)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: empty.x - 100, y: empty.y + 60, button: 'none', buttons: 0 })
    await page.waitForTimeout(150)
    check('a move with no button held ends the pan', !(await navigating()))
    // Whether OrbitControls has let go of the pointer, not whether the camera is still: headless draws a few frames a
    // second and the pan's damping tail keeps the camera drifting for seconds after even a normal release, so a
    // position check cannot tell drift from following. While it holds the pointer, hover moves pan the camera and the
    // next press is ignored (OrbitControls skips a pointer it already tracks).
    check('and OrbitControls lets go of the pointer', await page.evaluate(() => window.__oip.view.controls._pointers.length === 0))
    await page.mouse.up({ button: 'middle' })

    await beginPan()
    check('setup: a second pan is live', await navigating())
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(150)
    check('losing focus ends the pan', !(await navigating()))
    check('and lets go of the pointer', await page.evaluate(() => window.__oip.view.controls._pointers.length === 0))
    await page.mouse.up({ button: 'middle' })

    // The corner orbit gizmo: a drag on it runs on pointer capture until the pointer lock engages (and for good if the
    // browser refuses the lock). A lost release must end it, and Escape must cancel it without reaching the editor.
    const gizmoPressed = () => page.evaluate(() => window.__oip.view.orbitGizmo.pressed)
    const gizmoCentre = await page.evaluate(() => {
      const r = window.__oip.view.orbitGizmo.canvas.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    async function beginOrbit() {
      await page.mouse.move(gizmoCentre.x, gizmoCentre.y)
      await page.mouse.down()
      for (let i = 1; i <= 4; i++) {
        await page.mouse.move(gizmoCentre.x + i * 8, gizmoCentre.y + i * 3)
        await page.waitForTimeout(30)
      }
    }
    await beginOrbit()
    check('setup: a drag on the orbit gizmo is pressed', await gizmoPressed())
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gizmoCentre.x + 60, y: gizmoCentre.y + 20, button: 'none', buttons: 0 })
    await page.waitForTimeout(150)
    check('a move with no button held ends the gizmo orbit', !(await gizmoPressed()))
    await page.mouse.up()

    await page.evaluate(() => window.__oip.store.select('belt1'))
    await beginOrbit()
    check('setup: a second gizmo orbit is pressed, with a part selected', (await gizmoPressed()) && (await selected()) === 'belt1')
    await escape(false)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.waitForTimeout(150)
    check('Escape cancels the gizmo orbit', !(await gizmoPressed()))
    check('and leaves the selection alone', (await selected()) === 'belt1', `selected: "${await selected()}"`)
    await page.mouse.up()
  } finally {
    await browser.close()
    vite?.kill?.()
  }
}

try {
  await main()
} catch (e) {
  failures++
  console.log('FAIL  threw', e)
}
console.log(failures ? `${failures} failure(s)` : 'all checks passed')
process.exit(failures ? 1 : 0)
