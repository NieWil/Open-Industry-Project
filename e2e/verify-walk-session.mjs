// Walk mode is a session, not authoring: nothing the walking character does may edit the scene, so a walk
// through the demo view must never fork it into a scene of the user's own (store.stashDemoSession).
//
// Two presses in the demo are the risk: using the cell's safety gate while stopped (if it committed its
// `open` param) and a dock door (if it committed the building's `openDoors`, running or not). A commit from
// either would create a "Palletizing demo" tab, raise the "is now your scene" notice and retire ?scene=demo,
// so the visitor's next reload would open a copy frozen at that build instead of the current demo.
//
//   A) stopped, walking: Use the safety gate      -> the gate's live session (useSessions), param untouched, no fork
//   B) walking: Use a dock-door leaf               -> the leaf opens on screen, openDoors untouched, no fork
//   C) leave walk mode                              -> the door closes (walk state); the gate's session stays, no fork
//   C2) leave walk mode while a leaf is mid-rise    -> it still closes (guards against a settle cache freezing it)
//   D) the editor's C on the same gate               -> the same session takes the press (one Use model), no fork
//   E) control: an Inspector edit of the gate        -> a real edit, and it does fork (so A-D aren't vacuous)
//
// The crosshair is stubbed (view.pilotLookParts / pilotLookDockLeaf) rather than aimed: what is under test is
// what a press routes to, not the raycast (verify-pilot-idle-use.mjs and verify-pilot-dock-door.mjs aim).
// Run: node e2e/verify-walk-session.mjs [--headed]
/* global process, console, window, localStorage, location, performance, requestAnimationFrame, sessionStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), undefined, { timeout: 60000 })
// the dock bays stream in as their own GLBs: wait on the positive signal or the leaves aren't there yet
const waitForAssets = (page) =>
  page.waitForFunction(() => !!window.__oip.assetsBusy && !window.__oip.assetsBusy(), undefined, { timeout: 180000 })

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, args: ['--disable-features=CalculateNativeWinOcclusion'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))

  try {
    // a first-ever visitor on the landing page's "See it run" link
    await page.goto(URL)
    await waitForApp(page)
    // the tab's own open-project pointer is in sessionStorage (libraryDb.ts): clear it too, or the demo tab keeps the first visit's project
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.goto(`${URL}?scene=demo`)
    await waitForApp(page)
    await waitForAssets(page)
    await page.waitForTimeout(1500)

    /** everything that says whether the demo has been forked, or anything edited */
    const status = () => page.evaluate(async () => {
      const s = window.__oip.store.getState()
      return {
        demoSession: s.demoSession,
        notice: s.demoForkNotice !== null,
        canUndo: window.__oip.store.canUndo,
        doc: (await window.__oip.savedProject()),
        url: location.search,
      }
    })
    const s0 = await status()
    check('opens as the demo VIEW (nothing saved, nothing to undo)', s0.demoSession && !s0.notice && s0.doc === null && !s0.canUndo,
      JSON.stringify({ ...s0, doc: s0.doc?.length ?? null }))
    const unforked = (s) => s.demoSession && !s.notice && s.doc === null && !s.canUndo && s.url.includes('scene=demo')

    const ids = await page.evaluate(() => {
      const scene = window.__oip.store.getState().scene
      const gate = scene.parts.find((p) => p.type === 'part' && p.packageId === 'oip.safety-gate')
      const bld = scene.parts.find((p) => p.type === 'building')
      let leafKey = null
      // a leaf the demo keeps shut: its receiving door stands open (the trailer being unloaded), so the first leaf found
      // is not necessarily a closed one
      const authoredOpen = new Set(bld?.params.openDoors ?? [])
      window.__oip.view.scene.traverse((o) => { if (leafKey === null && typeof o.userData?.dockLeaf === 'string' && !authoredOpen.has(o.userData.dockLeaf)) leafKey = o.userData.dockLeaf })
      return { gateId: gate?.id ?? null, gateOpen: gate?.params.open ?? null, bldId: bld?.id ?? null, openDoors: bld?.params.openDoors ?? [], leafKey }
    })
    check('the demo has a safety gate, a building and a dock-door leaf', !!ids.gateId && !!ids.bldId && !!ids.leafKey, JSON.stringify(ids))
    if (!ids.gateId || !ids.bldId || !ids.leafKey) throw new Error('demo scene is missing the parts this gate drives')
    check('the leaf starts closed (authored)', !ids.openDoors.includes(ids.leafKey))

    /** world Y of the leaf's drawn panel; it rises DOOR_TRAVEL (3.1 m) when the leaf is open */
    const leafY = () => page.evaluate((key) => {
      let y = null
      window.__oip.view.scene.traverse((o) => {
        if (y !== null || o.userData?.dockLeaf !== key || !o.visible || o.isMesh) return // the slide group, not the hidden Use clone
        o.updateWorldMatrix(true, false)
        y = o.matrixWorld.elements[13]
      })
      return y
    }, ids.leafKey)
    const closedY = await leafY()
    /** poll the panel until `done(y)`: the ease is per rendered frame, and headless frames are slow, so a
     *  fixed wait samples it mid-travel (measured: 2.4 of 4.5 m after 2.5 s) */
    const waitLeaf = async (done, ms = 30000) => {
      let y = await leafY()
      for (let t = 0; t < ms && !(y !== null && done(y)); t += 250) {
        await page.waitForTimeout(250)
        y = await leafY()
      }
      return y
    }

    /** point the pilot crosshair at `part` (a part id) or `leaf` ({ partId, leafKey }) */
    const aimAt = (target) => page.evaluate((t) => {
      const v = window.__oip.view
      v.pilotLookParts = () => (t.part ? [t.part] : [])
      v.pilotLookDockLeaf = () => t.leaf ?? null
    }, target)
    const interact = () => page.evaluate(() => window.__oip.controller.pilotInteract())

    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(300)

    // ---- A) stopped: Use the safety gate -------------------------------------------------------------
    check('the sim is stopped (the case at risk of committing)', (await page.evaluate(() => window.__oip.store.getState().running)) === false)
    await aimAt({ part: ids.gateId })
    await interact()
    await page.waitForTimeout(1500)
    const a = await page.evaluate((id) => ({
      open: window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.params.open,
      session: window.__oip.controller.useSessions.has(id),
      used: window.__oip.store.getState().usedIds.includes(id),
    }), ids.gateId)
    check('A: the press goes to the gate\'s live stopped-scene session', a.session && a.used, JSON.stringify(a))
    check('A: the gate\'s authored `open` is untouched', a.open === ids.gateOpen, `open=${a.open}`)
    const sa = await status()
    check('A: the demo is NOT forked (no tab, no notice, nothing saved, nothing to undo)', unforked(sa),
      JSON.stringify({ ...sa, doc: sa.doc?.length ?? null }))

    // ---- B) Use a dock-door leaf ------------------------------------------------------------------------
    await aimAt({ leaf: { partId: ids.bldId, leafKey: ids.leafKey } })
    await interact()
    const openY = await waitLeaf((y) => y - closedY > 2.8) // DOOR_TRAVEL is 3.1 m
    const b = await page.evaluate((id) => {
      const s = window.__oip.store.getState()
      return { walkDoors: s.walkDoors?.[id] ?? null, openDoors: s.scene.parts.find((p) => p.id === id)?.params.openDoors ?? [] }
    }, ids.bldId)
    check('B: the leaf is in the walk session\'s door state', !!b.walkDoors?.includes(ids.leafKey), JSON.stringify(b.walkDoors))
    check('B: and it OPENS on screen (the panel rises)', closedY !== null && openY !== null && openY - closedY > 2.8,
      `y ${closedY?.toFixed(2)} -> ${openY?.toFixed(2)}`)
    check('B: the building\'s authored openDoors is untouched', !b.openDoors.includes(ids.leafKey), JSON.stringify(b.openDoors))
    const sb = await status()
    check('B: the demo is still NOT forked', unforked(sb), JSON.stringify({ ...sb, doc: sb.doc?.length ?? null }))

    // ---- C) leave walk mode: the session ends ---------------------------------------------------------------
    await page.evaluate(() => {
      const v = window.__oip.view
      delete v.pilotLookParts // drop the stubs: the prototype methods come back
      delete v.pilotLookDockLeaf
      window.__oip.store.exitPilot()
    })
    const c = await page.evaluate((id) => ({
      walkDoors: window.__oip.store.getState().walkDoors,
      session: window.__oip.controller.useSessions.has(id),
    }), ids.gateId)
    const shutY = await waitLeaf((y) => Math.abs(y - closedY) < 0.05) // the leaf eases shut
    check('C: the walk session\'s door state is dropped', c.walkDoors === null, JSON.stringify(c.walkDoors))
    check('C: and the door closes again on screen', shutY !== null && closedY !== null && Math.abs(shutY - closedY) < 0.05,
      `y=${shutY?.toFixed(2)} (closed ${closedY?.toFixed(2)})`)
    check('C: the gate stays as the character left it (Use is one model in and out of walk mode)', c.session, JSON.stringify(c))
    const sc = await status()
    check('C: the demo is still NOT forked', unforked(sc), JSON.stringify({ ...sc, doc: sc.doc?.length ?? null }))

    // ---- C2) leave walk mode mid-rise: the leaf still closes ------------------------------------------------
    // Leaving hands the building back the very openDoors array it last settled for, so a settle cache keyed on
    // that array would freeze a leaf that hadn't finished rising (C above only hits this under load, when slow
    // frames leave the leaf short of the top). Exit on an animation frame inside the rise, so it is always hit.
    await page.evaluate(() => window.__oip.store.enterPilot())
    await page.waitForTimeout(300)
    await aimAt({ leaf: { partId: ids.bldId, leafKey: ids.leafKey } })
    await interact()
    const midRise = await page.evaluate(([key, y0]) => new Promise((resolve) => {
      const v = window.__oip.view
      const rise = () => {
        let y = null
        v.scene.traverse((o) => {
          if (y !== null || o.userData?.dockLeaf !== key || !o.visible || o.isMesh) return
          o.updateWorldMatrix(true, false)
          y = o.matrixWorld.elements[13]
        })
        return y === null ? null : y - y0
      }
      const t0 = performance.now()
      const frame = () => {
        const r = rise()
        if ((r !== null && r > 0.2) || performance.now() - t0 > 30000) {
          delete v.pilotLookParts
          delete v.pilotLookDockLeaf
          window.__oip.store.exitPilot()
          resolve(r)
        } else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }), [ids.leafKey, closedY])
    const shut2Y = await waitLeaf((y) => Math.abs(y - closedY) < 0.05)
    check('C2: walk mode was left while the leaf was still rising', midRise !== null && midRise > 0.2 && midRise < 4.4, `rise=${midRise?.toFixed(2)}`)
    check('C2: and the leaf still closes on screen', shut2Y !== null && Math.abs(shut2Y - closedY) < 0.05,
      `y=${shut2Y?.toFixed(2)} (closed ${closedY?.toFixed(2)})`)

    // ---- D) the editor's C on the same gate: the same session takes it, not an edit ------------------------
    const dSession = await page.evaluate((id) => {
      window.__oip.store.select(id)
      window.__oip.controller.useSelection()
      return window.__oip.controller.useSessions.has(id)
    }, ids.gateId)
    await page.waitForTimeout(800)
    const d = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.params.open, ids.gateId)
    const sd = await status()
    check('D: an editor C goes to the same live session', dSession)
    check('D: and leaves its `open` as authored', d === ids.gateOpen, `open=${d}`)
    check('D: so the demo is still NOT forked', unforked(sd), JSON.stringify({ ...sd, doc: sd.doc?.length ?? null }))

    // ---- E) control: the Inspector's path is an edit, and forks ------------------------------------------
    await page.evaluate((id) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      st.commit('Edit part', { ...scene, parts: scene.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, open: !p.params.open } } : p)) })
    }, ids.gateId)
    await page.waitForTimeout(800)
    const e = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.params.open, ids.gateId)
    const se = await status()
    check('E: an Inspector edit sets the gate\'s `open`', e === !ids.gateOpen, `open=${e}`)
    check('E: and THAT forks the demo (so A-D above are not vacuous)', !se.demoSession && se.notice && se.doc !== null && se.canUndo,
      JSON.stringify({ ...se, doc: se.doc?.length ?? null }))

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
