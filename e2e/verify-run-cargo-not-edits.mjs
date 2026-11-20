// What the run owns is not the document, so changing it is not an edit (the store's edit gate, AGENTS.md
// "Only authoring writes the document"). Driven through the real controller on the demo, where every edit
// forks the demo view into a scene of the user's own, so a wrongly-counted edit is easy to detect.
//
// Without the gate, each of these counted as an edit (confirmed with a probe):
//   A) Play, click (promote) a moving box, Stop  -> Stop's drop of the box saved, forking the demo
//   B) move a promoted box mid-run                 -> an undo step + a save, forking the demo
//   C) delete a promoted box mid-run               -> the same, through the delete path
//   D) a real edit mid-run that also moves a box   -> an edit (control: it does fork), and after Stop an
//      undo/redo brought the run's box back as authored content, saved
//
// A placed box's pose also belongs to physics mid-run (otherwise a nudge commits wherever the belt
// has carried it as the box's designed start):
//   E) move a placed box (one of the demo's pallet loads) mid-run -> no edit, and Stop puts it back
//   F) move the pallet-load group mid-run                          -> an edit that carries the box: Stop puts it
//      back on the moved group, from its designed pose
// Run: node e2e/verify-run-cargo-not-edits.mjs [--headed]
/* global process, console, window, localStorage, innerWidth, innerHeight, sessionStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, args: ['--disable-features=CalculateNativeWinOcclusion'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))

  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!window.__oip?.controller, undefined, { timeout: 60000 })
    // the tab's own open-project pointer is in sessionStorage (libraryDb.ts): clear it too, or the demo tab keeps the first visit's project
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.goto(`${URL}?scene=demo`)
    await page.waitForFunction(() => !!window.__oip?.controller, undefined, { timeout: 60000 })
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, undefined, { timeout: 180000 })
    await page.waitForTimeout(1000)

    const status = () => page.evaluate(async () => {
      const s = window.__oip.store.getState()
      return { demoSession: s.demoSession, notice: s.demoForkNotice !== null, canUndo: window.__oip.store.canUndo, doc: (await window.__oip.savedProject()) }
    })
    const brief = (s) => JSON.stringify({ ...s, doc: s.doc?.length ?? null })
    const unforked = (s) => s.demoSession && !s.notice && s.doc === null && !s.canUndo
    const play = () => page.evaluate(() => window.__oip.controller.run())
    const stop = () => page.evaluate(() => window.__oip.controller.stop())
    /** promote every box on screen the way a band select (or a click, or a walk-mode pick-up) does */
    const promote = () => page.evaluate(async () => {
      const { controller, view } = window.__oip
      for (let i = 0; i < 120; i++) {
        const picks = view.cargoBodiesInRect(0, 0, innerWidth, innerHeight)
        if (picks.length > 0) return controller.promoteCargoBoxes(picks)
        await new Promise((r) => setTimeout(r, 500))
      }
      return []
    })
    /** commit `ids` moved up by 1 m - what a gizmo drag's release commits (before = the drag's start) */
    const moveUp = (ids) => page.evaluate((ids) => {
      const st = window.__oip.store
      const before = st.getState().scene
      const set = new Set(ids)
      st.commit('Move parts', { ...before, parts: before.parts.map((p) => (set.has(p.id) ? { ...p, position: [p.position[0], p.position[1] + 1, p.position[2]] } : p)) }, { before })
    }, ids)
    const has = (id) => page.evaluate(async (id) => ({
      inScene: window.__oip.store.getState().scene.parts.some((p) => p.id === id),
      inDoc: ((await window.__oip.savedProject()) ?? '').includes(`"${id}"`),
    }), id)

    check('opens as the demo VIEW', unforked(await status()), brief(await status()))

    // ---- A) promote, then Stop ----------------------------------------------------------------------------
    const authoredCount = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    await play()
    const a = await promote()
    check('A: a moving box was promoted (clicked)', a.length > 0, `${a.length} box(es)`)
    check('A: the promoted box IS in the live scene (selectable)', (await has(a[0])).inScene)
    await stop()
    await page.waitForTimeout(500)
    const sa = await status()
    check('A: Stop drops it without forking the demo', unforked(sa), brief(sa))
    // Stop restores exactly what was authored: the run's boxes leave the scene, not just the document.
    const afterStop = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    check('A: Stop restored the authored part count', afterStop === authoredCount, `${afterStop} vs ${authoredCount}`)
    check('A: ...and the promoted box is gone from the scene', !(await has(a[0])).inScene)

    // ---- B + C) move, then delete, a promoted box mid-run ------------------------------------------------
    await play()
    const [bx1, bx2] = await promote()
    check('B: boxes promoted for the move/delete legs', !!bx1, `${bx1} ${bx2 ?? ''}`)
    await moveUp([bx1])
    const sb = await status()
    const moved = await page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.position[1], bx1)
    check('B: the live box moves on screen', typeof moved === 'number', `y=${moved}`)
    check('B: ...and it is no edit (no undo step, no save, no fork)', unforked(sb), brief(sb))
    await page.evaluate((id) => { window.__oip.store.select(id); window.__oip.store.deleteSelection() }, bx1)
    const sc = await status()
    check('C: deleting it is gone from the scene', !(await has(bx1)).inScene)
    check('C: ...and is no edit either', unforked(sc), brief(sc))

    // ---- E) a placed box moved on its own mid-run ------------------------------------------------------------
    const posOf = (id) => page.evaluate((id) => {
      const p = window.__oip.store.getState().scene.parts.find((x) => x.id === id)
      return p ? [...p.position] : null
    }, id)
    const near = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
    const placed = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const byId = new Map(parts.map((p) => [p.id, p]))
      const box = parts.find((p) => p.packageId === 'oip.box' && p.parent && byId.get(p.parent)?.type === 'group')
      return box ? { id: box.id, group: box.parent, pos: [...box.position] } : null
    })
    check('E: the demo has a placed box filed under a pallet-load group', !!placed, JSON.stringify(placed))
    if (!placed) throw new Error('no placed box in a group')
    await moveUp([placed.id])
    const se = await status()
    check('E: a placed box moved mid-run shows where it was put', near(await posOf(placed.id), [placed.pos[0], placed.pos[1] + 1, placed.pos[2]]))
    check('E: ...and is no edit', unforked(se), brief(se))
    await stop()
    await page.waitForTimeout(500)
    check('E: Stop puts it back where it was placed', near(await posOf(placed.id), placed.pos), JSON.stringify(await posOf(placed.id)))
    check('E: ...still no edit', unforked(await status()))

    // ---- D) a real edit that also carries a run box; then Stop, undo, redo ---------------------------------
    await play()
    const conveyor = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.type === 'part' && /conveyor/.test(p.packageId))?.id ?? null)
    const box = (await promote())[0]
    const convY = (id) => page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.position[1], id)
    const y0 = await convY(conveyor)
    await moveUp([conveyor, box])
    const sd = await status()
    check('D: CONTROL - moving a conveyor mid-run IS an edit, and forks the demo', !sd.demoSession && sd.notice && sd.doc !== null && sd.canUndo, brief(sd))
    check('D: the saved document never holds the run box', !(await has(box)).inDoc)
    await stop()
    await page.waitForTimeout(500)
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(300)
    const afterUndo = await has(box)
    check('D: undo after Stop does NOT bring the run box back', !afterUndo.inScene && !afterUndo.inDoc, JSON.stringify(afterUndo))
    await page.evaluate(() => window.__oip.store.redo())
    await page.waitForTimeout(300)
    const afterRedo = await has(box)
    check('D: nor does redo', !afterRedo.inScene && !afterRedo.inDoc, JSON.stringify(afterRedo))
    const yRedo = await convY(conveyor)
    check('D: while the conveyor edit itself redid (the history still works)', typeof y0 === 'number' && Math.abs(yRedo - (y0 + 1)) < 1e-6, `y ${y0} -> ${yRedo}`)

    // ---- F) the pallet-load group moved mid-run carries the box -----------------------------------------------
    await play()
    await moveUp([placed.id]) // operate the box first, so a carry taken from where the run has it would show
    const g0 = await posOf(placed.group)
    // what a group drag commits: the group and its whole subtree, moved together (+1 m in x)
    await page.evaluate((root) => {
      const st = window.__oip.store
      const before = st.getState().scene
      const byId = new Map(before.parts.map((p) => [p.id, p]))
      const under = (p) => { for (let q = p; q; q = byId.get(q.parent)) if (q.id === root) return true; return false }
      st.commit('Move part', { ...before, parts: before.parts.map((p) => (under(p) ? { ...p, position: [p.position[0] + 1, p.position[1], p.position[2]] } : p)) }, { before })
    }, placed.group)
    await stop()
    await page.waitForTimeout(500)
    const carried = [placed.pos[0] + 1, placed.pos[1], placed.pos[2]]
    check('F: the group moved (a layout edit)', near(await posOf(placed.group), [g0[0] + 1, g0[1], g0[2]]))
    check('F: Stop puts the box back ON the moved group, from its designed pose', near(await posOf(placed.id), carried),
      `${JSON.stringify(await posOf(placed.id))} vs ${JSON.stringify(carried)}`)
    const savedBox = await page.evaluate(async (id) => {
      const find = (v) => {
        if (Array.isArray(v)) { for (const x of v) { const r = find(x); if (r) return r } return null }
        if (v && typeof v === 'object') {
          if (v.id === id && Array.isArray(v.position)) return v.position
          for (const x of Object.values(v)) { const r = find(x); if (r) return r }
        }
        return null
      }
      return find(JSON.parse((await window.__oip.savedProject()) ?? 'null'))
    }, placed.id)
    check('F: ...and saved there', near(savedBox, carried), JSON.stringify(savedBox))

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
