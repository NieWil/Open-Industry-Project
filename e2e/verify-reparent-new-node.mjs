// Verify "Reparent to New Node": a geometry-less Group container wraps the selection,
// carries its children when moved, stays out of the catalog, and doesn't break the
// running sim. Run: node e2e/verify-reparent-new-node.mjs [--headed]
/* global process, console, fetch, setTimeout, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps

const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.sim), { timeout: 20000 })
const sceneOf = (page) => page.evaluate(() => window.__oip.store.getState().scene)
const selIds = (page) => page.evaluate(() => window.__oip.store.getState().selectedIds)
const partById = (scene, id) => scene.parts.find((p) => p.id === id)

// The catalog card places an SDK part (`type:'part'` + packageId), and ids are allocated from the type
// ('pt_1', …). So identify conveyors by package, and never hard-code an id.
const ROLLER_PKG = 'oip.roller-conveyor'
const rollers = (scene) => scene.parts.filter((p) => p.type === 'part' && p.packageId === ROLLER_PKG)

// Tree rows render the part's display name, not its id (SceneTree.tsx `.tree-name`), so rows are
// addressed by name, exact match, since a substring would also match "Roller Conveyor 2".
const treeRow = (page, name) =>
  page
    .locator('.tree-row')
    .filter({ has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
    .first()

// Select by clicking the name, not the row. A row for a part with a script also carries a
// `.tree-open-scene` button (SceneTree.tsx "Open in the part editor"), and a click on the row's centre
// hits it: that opens the part's scene, the tree re-renders as that part's rig nodes
// (deck / roller / wallL …), and every later row lookup waits for a row that no longer exists.
const treeName = (page, name) => treeRow(page, name).locator('.tree-name')

async function worldToScreen(page, pos) {
  return page.evaluate((p) => {
    const v = window.__oip.view
    v.camera.updateMatrixWorld(true)
    const proj = v.camera.position.clone().set(p[0], p[1], p[2]).project(v.camera)
    const rect = v.renderer.domElement.getBoundingClientRect()
    return { x: rect.left + ((proj.x + 1) / 2) * rect.width, y: rect.top + ((1 - proj.y) / 2) * rect.height, inside: proj.z < 1 && Math.abs(proj.x) < 0.95 && Math.abs(proj.y) < 0.95 }
  }, pos)
}
async function ensureVisible(page, pos) {
  for (let i = 0; i < 6; i++) {
    const s = await worldToScreen(page, pos)
    if (s.inside) return s
    const c = await worldToScreen(page, [0, 0, 0])
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(150)
  }
  return worldToScreen(page, pos)
}
// The card is a `div.catalog-card` wrapping a `button.catalog-card-main` (plus per-card side
// buttons), so click the main button.
async function clickCatalogCard(page, label) {
  await page.locator('button.catalog-tab', { hasText: /^Equipment$/ }).click()
  await page
    .locator('.catalog-card')
    .filter({ has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('button.catalog-card-main')
    .first()
    .click()
}
async function clickWorld(page, pos, { alt = false } = {}) {
  const s = await ensureVisible(page, pos)
  await page.mouse.move(s.x, s.y, { steps: 4 })
  await page.waitForTimeout(80)
  if (alt) await page.keyboard.down('Alt')
  await page.mouse.down()
  await page.mouse.up()
  if (alt) await page.keyboard.up('Alt')
  await page.waitForTimeout(80)
}
async function findHandle(page, center, want) {
  return page.evaluate(([cx, cy, w]) => {
    const v = window.__oip.view
    for (let r = 12; r <= 240; r += 4) for (let a = 0; a < 360; a += 8) {
      const x = cx + r * Math.cos((a * Math.PI) / 180), y = cy + r * Math.sin((a * Math.PI) / 180)
      if (w.includes(v.pickGizmoHandle(x, y))) return { x, y }
    }
    return null
  }, [center.x, center.y, want])
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  // Keep the onboarding tour off. localStorage.clear() below re-enables it, and its `.tut-card`
  // sits over the viewport centre: pointermove still reaches the canvas (so a part stages and
  // the scene looks ready), but the pointerdown hits the card, so placement never commits.
  // An init script re-applies the flag on every navigation, so it survives the clear + reload.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      // ignore blocked storage
    }
  })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(2000)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      const sim = window.__oip.sim, orig = sim.onFrame
      window.__nan = false
      sim.onFrame = (f) => { for (let i = 0; i < f.count; i++) if (Number.isNaN(f.positions[i * 3])) window.__nan = true; window.__count = f.count; orig?.(f) }
    })

    // two conveyors
    await clickCatalogCard(page, 'Roller Conveyor')
    await page.waitForTimeout(120)
    await clickWorld(page, [0, 0, 0])
    await page.keyboard.press('Escape')
    await clickCatalogCard(page, 'Roller Conveyor')
    await page.waitForTimeout(120)
    await clickWorld(page, [3, 0, 2], { alt: true })
    await page.keyboard.press('Escape')
    let scene = await sceneOf(page)
    const convs = rollers(scene)
    check('two roller conveyors placed', convs.length === 2, `count=${convs.length}`)
    if (convs.length !== 2) throw new Error('setup: expected exactly two conveyors from the catalog')
    const [A, B] = convs

    // A placed part carries no explicit `name`; the tree shows a derived label
    // ("Roller Conveyor", "Roller Conveyor 2"; see core/parts/partDisplayName.ts), which depends on
    // sibling order. Name them so each row is addressable by an exact, stable string.
    await page.evaluate(([a, b]) => {
      window.__oip.store.rename(a, 'Conveyor A')
      window.__oip.store.rename(b, 'Conveyor B')
    }, [A.id, B.id])
    await page.waitForTimeout(120)

    // select both, then Reparent to New Node via the context menu
    await treeName(page, 'Conveyor A').click()
    await treeName(page, 'Conveyor B').click({ modifiers: ['Control'] })
    check('both conveyors selected', (await selIds(page)).length === 2)
    // right-clicking a row that's already selected keeps the multi-selection (SceneTree.tsx
    // re-selects only an unselected row), so no modifier is needed to hold both conveyors.
    await treeRow(page, 'Conveyor A').click({ button: 'right' })
    // the item renders its shortcut in a nested span, so its text is "Reparent to New NodeCtrl+J";
    // match the leading label, never an end-anchored exact string.
    await page.locator('.context-item').filter({ hasText: /^Reparent to New Node/ }).click()
    await page.waitForTimeout(120)

    scene = await sceneOf(page)
    const group = scene.parts.find((p) => p.type === 'group')
    check('a Group container node was created', !!group, `id=${group?.id}`)
    check('both conveyors are now children of the group', !!group && partById(scene, A.id).parent === group.id && partById(scene, B.id).parent === group.id)
    check('the new group node is selected', JSON.stringify(await selIds(page)) === JSON.stringify([group?.id]))
    const caret = await treeRow(page, group.name).locator('.tree-caret').count()
    check('group row renders as a parent (caret)', caret === 1)

    // the Group type must not appear in the catalog palette
    await page.locator('.catalog-search').fill('group')
    await page.waitForTimeout(120)
    const groupCards = await page.locator('.catalog-card-label', { hasText: /^Group$/ }).count()
    check('Group is hidden from the catalog (noCatalog)', groupCards === 0)
    await page.locator('.catalog-search').fill('')

    // moving the (mesh-less) group via its gizmo carries both children
    await treeName(page, group.name).click()
    await page.keyboard.press('w')
    const before = await sceneOf(page)
    const gCenter = await ensureVisible(page, group.position)
    const handle = await findHandle(page, gCenter, ['x', 'z', 'xz'])
    check('selected group shows a transform gizmo', !!handle)
    if (handle) {
      await page.mouse.move(handle.x, handle.y, { steps: 3 })
      await page.mouse.down()
      await page.mouse.move(handle.x + 120, handle.y - 36, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(120)
      const after = await sceneOf(page)
      const d1 = partById(after, A.id).position.map((v, i) => v - partById(before, A.id).position[i])
      const d2 = partById(after, B.id).position.map((v, i) => v - partById(before, B.id).position[i])
      check('moving the group carried both children by the same delta', Math.hypot(d1[0], d1[2]) > 0.1 && d1.every((v, i) => approx(v, d2[i])), `d1=${d1.map((n) => +n.toFixed(2))} d2=${d2.map((n) => +n.toFixed(2))}`)
    }

    // the geometry-less group must not break the running sim
    await page.locator('button.run-button.play').click()
    await page.waitForTimeout(1500)
    const running = await page.evaluate(() => window.__oip.store.getState().running)
    check('simulation runs with a Group node present (no crash)', running === true)
    check('no NaN in sim frames with a Group present', (await page.evaluate(() => window.__nan)) === false)
    await page.locator('button.run-button.stop').click()

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'reparent-new-node.png') })
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
