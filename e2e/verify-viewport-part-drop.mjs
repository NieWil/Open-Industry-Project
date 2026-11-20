// Verify that a part file dropped on the viewport is imported and placed where it was dropped (App.tsx's viewport
// onDrop -> parts/importPartFiles -> controller.dropPartFile -> catalogPlace.placePackageAt), the way a catalog card
// dragged to that point and released would be. Also checks what a drop must not do: several files are imported but not
// placed (one point can't hold them), a drop with no part file changes nothing and doesn't navigate away, and the
// Parts dock's drop still imports without placing.
// Run: node e2e/verify-viewport-part-drop.mjs [--headed]
/* global process, console, window, document, File, DataTransfer, DragEvent */
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

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
}

// a minimal, valid part file in the canonical { ...manifest, behaviorSource } shape
function partFile(id, name) {
  return {
    id,
    name,
    category: 'Equipment',
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.8, 0.4, 0.8] }, offset: [0, 0.2, 0] }], joints: [] },
    behaviorSource: 'definePart({ params: {}, step() {} })',
  }
}

/** dispatch an OS-style file drop on the element under (x, y): dragenter, dragover, drop, sharing one DataTransfer */
async function dropFiles(page, selector, files, at) {
  return page.evaluate(
    ({ selector, files, at }) => {
      const el = document.querySelector(selector)
      const r = el.getBoundingClientRect()
      const x = at ? at.x : r.left + r.width / 2
      const y = at ? at.y : r.top + r.height / 2
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(new File([f.text], f.name, { type: f.type ?? '' }))
      const fire = (type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
      fire('dragenter')
      const accepted = !fire('dragover') // a cancelled dragover is what lets the drop through
      const handled = !fire('drop')
      return { x, y, accepted, handled }
    },
    { selector, files, at },
  )
}

const asFile = (pf, name = `${pf.id}.part.json`) => ({ name, text: JSON.stringify(pf), type: 'application/json' })

/** the parts placed from `packageId`, each with its origin projected to client pixels */
async function placed(page, packageId) {
  return page.evaluate((packageId) => {
    const { store, view } = window.__oip
    const cam = view.camera
    cam.updateMatrixWorld()
    const r = document.querySelector('.viewport').getBoundingClientRect()
    const toScreen = ([x, y, z]) => {
      const v = cam.matrixWorldInverse.elements
      const p = cam.projectionMatrix.elements
      const e = [x, y, z, 1]
      const mul = (m, a) => [0, 1, 2, 3].map((row) => m[row] * a[0] + m[row + 4] * a[1] + m[row + 8] * a[2] + m[row + 12] * a[3])
      const c = mul(p, mul(v, e))
      return { x: r.left + ((c[0] / c[3] + 1) / 2) * r.width, y: r.top + ((1 - c[1] / c[3]) / 2) * r.height }
    }
    return store
      .getState()
      .scene.parts.filter((p) => p.packageId === packageId)
      .map((p) => ({ id: p.id, position: p.position, screen: toScreen(p.position) }))
  }, packageId)
}

const hasPackage = (page, id) => page.evaluate((id) => window.__oip.store.getState().userPackages.some((p) => p.id === id), id)
const partCount = (page) => page.evaluate(() => window.__oip.store.getState().scene.parts.length)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  page.on('dialog', (d) => void d.accept())
  try {
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => {
      const st = window.__oip.store
      st.loadScene({ version: st.getState().scene.version, parts: [] })
    })
    const vp = await page.evaluate(() => {
      const r = document.querySelector('.viewport').getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    })

    // one part file, dropped left of centre: imported, and one copy placed under the drop point
    const a = partFile('e2e.drop-a', 'E2E Drop A')
    const atA = { x: vp.left + vp.width * 0.4, y: vp.top + vp.height * 0.6 }
    const dropA = await dropFiles(page, '.viewport', [asFile(a)], atA)
    check('the viewport accepts a file drag', dropA.accepted && dropA.handled)
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.some((p) => p.packageId === 'e2e.drop-a'), null, { timeout: 10000 })
    check('the dropped part is imported into the project', await hasPackage(page, 'e2e.drop-a'))
    const placedA = await placed(page, 'e2e.drop-a')
    check('one copy is placed', placedA.length === 1, String(placedA.length))
    const dA = placedA[0] ? Math.hypot(placedA[0].screen.x - atA.x, placedA[0].screen.y - atA.y) : Infinity
    check('it lands under the drop point', dA < 30, `${dA.toFixed(1)} px off`)

    // the same file dropped somewhere else: the replace is confirmed, and a second copy lands at the new point
    const atB = { x: vp.left + vp.width * 0.65, y: vp.top + vp.height * 0.45 }
    await dropFiles(page, '.viewport', [asFile(a)], atB)
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.filter((p) => p.packageId === 'e2e.drop-a').length === 2, null, { timeout: 10000 })
    const second = (await placed(page, 'e2e.drop-a')).find((p) => p.id !== placedA[0].id)
    const dB = second ? Math.hypot(second.screen.x - atB.x, second.screen.y - atB.y) : Infinity
    check('a second drop places a second copy at its own point', dB < 30, `${dB.toFixed(1)} px off`)

    // several files: imported, none placed
    const before = await partCount(page)
    const b = partFile('e2e.drop-b', 'E2E Drop B')
    const c = partFile('e2e.drop-c', 'E2E Drop C')
    await dropFiles(page, '.viewport', [asFile(b), asFile(c)], atA)
    await page.waitForFunction(() => ['e2e.drop-b', 'e2e.drop-c'].every((id) => window.__oip.store.getState().userPackages.some((p) => p.id === id)), null, { timeout: 10000 })
    check('several files are all imported', true)
    check('several files place nothing', (await partCount(page)) === before, `${before} -> ${await partCount(page)}`)

    // a drop with no part file: nothing changes, and the browser doesn't open the file in place of the app
    const notPart = await dropFiles(page, '.viewport', [{ name: 'notes.txt', text: 'hello', type: 'text/plain' }], atA)
    await page.waitForTimeout(300)
    check('a drop with no part file is still taken from the browser', notPart.handled)
    check('a drop with no part file changes nothing', (await partCount(page)) === before && !!(await page.evaluate(() => window.__oip?.store)))

    // control: the Parts dock's drop imports without placing
    const d = partFile('e2e.drop-d', 'E2E Drop D')
    await dropFiles(page, '.catalog-dock', [asFile(d)])
    await page.waitForFunction(() => window.__oip.store.getState().userPackages.some((p) => p.id === 'e2e.drop-d'), null, { timeout: 10000 })
    check('control: a Parts dock drop imports', true)
    check('control: a Parts dock drop places nothing', (await placed(page, 'e2e.drop-d')).length === 0)
  } finally {
    await browser.close()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
}

try {
  await main()
} finally {
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
