// Regression check: the chain transfer's chains move (the whole loop, runs and bends alike) at the drive speed.
//
// The lane is ordinary SDK code: the part's geometry() draws every lane on the lift bank, the chain as one loop
// whose texture is laid out in link tiles, and MeshPart.scroll moves that texture at the speed the behavior
// reports (the chain drive a program commands), lift up or down. The failures this guards: chain end wraps
// that stay frozen while the run beside them moves, and chains that stop while the transfer is lowered.
//
// What this pins, in the running app:
//   A. the bank draws as three meshes (frame, sprockets, chain) whatever the chain count, riding the lift link
//   B. the chain's texture is its own scrolling copy (so no two transfers drag each other's links)
//   C. running + raised: the loop scrolls, toward +U (the top run carries toward the divert direction)
//   F. running + lowered: it still scrolls - the chains move with their drive, never because of the lift
//   S. stopped: it holds still
//   E. a lane-length edit re-draws the lanes and they keep scrolling
//
// The survey reads the chain texture off `material.map` (WebGL) or, under the default WebGPURenderer (node materials
// even on its WebGL2 backend), off the TextureNode in its colour graph - so this runs on either.
//
// Run: node e2e/verify-chain-bend-scroll.mjs [--headed]
/* global process, console, window, performance */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }
const wait = (page, ms) => page.waitForTimeout(ms)

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller && window.__oip.sim),
    { timeout: 20000 },
  )
}

const ID = 'chain_scroll'

// Author a lone chain transfer through loadScene with its package attached, then wait for its lanes to be drawn.
async function placeChainTransfer(page, chains) {
  const havePkg = await page.evaluate(([id, chains]) => {
    const st = window.__oip.store
    const scene = st.getState().scene
    const pkg = st.getState().bundledPackages.find((p) => p.id === 'oip.chain-transfer')
    if (!pkg) return false
    const parts = [{ id, type: 'part', packageId: 'oip.chain-transfer', position: [0, 0.9, 0], rotationY: 0, params: { chains, distance: 0.33, laneLength: 2, speed: 2, raised: true, speedTag: '', popupTag: '' } }]
    st.loadScene({ ...scene, parts, packages: [...(scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg] })
    st.setState({ selectedIds: [] })
    return true
  }, [ID, chains])
  check('oip.chain-transfer package available', havePkg)
  const drawn = await page.waitForFunction((id) => {
    let n = 0
    window.__oip.view.entries?.get(id)?.visual?.object?.traverse((o) => { if (o.isMesh && typeof o.userData.linkName !== 'string') n++ })
    return n >= 3
  }, ID, { timeout: 30000 }).then(() => true).catch(() => false)
  check('the lanes are drawn', drawn)
}

// Survey the part: its drawn (geometry()) meshes, the textured one's offset, and the lanes' height.
function survey(page, partId) {
  return page.evaluate((id) => {
    const obj = window.__oip.view.entries.get(id)?.visual.object
    if (!obj) return null
    const nodeTexture = (n, seen = new Set()) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return null
      seen.add(n)
      if (n.isTextureNode) return n.value
      for (const k of Object.keys(n)) {
        if (k === 'parents' || k === 'cache') continue
        const t = nodeTexture(n[k], seen)
        if (t) return t
      }
      return null
    }
    const out = { meshes: 0, textured: 0, offset: null, y: null, underBank: true, textureId: null }
    obj.traverse((o) => {
      // the drawn geometry() output only: plain BufferGeometry (the collision-only deck is a hidden rig box primitive)
      if (!o.isMesh || o.geometry?.type !== 'BufferGeometry' || typeof o.userData.linkName === 'string') return
      out.meshes++
      let rider = false
      for (let p = o.parent; p; p = p.parent) if (p.userData.linkName === 'chainBank') rider = true
      if (!rider) out.underBank = false
      const m = o.material
      const map = m.map ?? (m.isNodeMaterial ? nodeTexture(m.colorNode) : null)
      if (map) {
        out.textured++
        out.offset = map.offset.x
        out.textureId = map.uuid
        o.updateWorldMatrix(true, false)
        out.y = o.matrixWorld.elements[13]
      }
    })
    return out
  }, partId)
}

const driveView = (page) => page.evaluate(() => window.__oip.view.tick(performance.now()))
// offsets are kept % 1 and move down as the pattern moves toward +U: the wrapped decrease is the advance
const advance = (a, b) => ((a - b) % 1 + 1) % 1

async function run(page, frames = 6) {
  const before = await survey(page, ID)
  for (let i = 0; i < frames; i++) { await driveView(page); await wait(page, 120) }
  return [before, await survey(page, ID)]
}
const setParam = (page, patch) => page.evaluate(([id, patch]) => {
  const st = window.__oip.store
  const s = st.getState().scene
  st.commit('edit', { ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, ...patch } } : p)) })
}, [ID, patch])

async function main() {
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  try {
    await page.goto(URL)
    await waitForApp(page)
    await wait(page, 1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await wait(page, 1000)

    await placeChainTransfer(page, 5)
    await wait(page, 600)

    // ---- A/B: three meshes on the lift bank; the chain is its own scrolling texture ------------------------
    const s0 = await survey(page, ID)
    check('A. the lane bank draws as three meshes, all riding the lift', s0?.meshes === 3 && s0.underBank, `meshes=${s0?.meshes} underBank=${s0?.underBank}`)
    check('B. exactly one of them carries the chain texture', s0?.textured === 1, `textured=${s0?.textured}`)

    // ---- C: running + raised → it scrolls toward +U ------------------------------------------------------
    await page.evaluate(() => window.__oip.controller.run())
    const gotFrames = await page
      .waitForFunction(() => window.__oip.view.lastFrameSimTime > 0, { timeout: 8000 })
      .then(() => true).catch(() => false)
    check('worker delivers frames after Play (sim clock advancing)', gotFrames)
    const [c0, c1] = await run(page)
    const dUp = advance(c0.offset, c1.offset)
    check('C. raised and running, the chain scrolls', dUp > 1e-6, `offset ${c0.offset.toFixed(5)} → ${c1.offset.toFixed(5)}`)

    // ---- F: lowered, it keeps running with its drive ---------------------------------------------------
    await setParam(page, { raised: false })
    for (let i = 0; i < 6; i++) { await driveView(page); await wait(page, 120) }
    const [f0, f1] = await run(page)
    check('F1. the lanes came down (the lift is back at rest)', f0.y < c1.y - 0.05, `lane y raised ${c1.y.toFixed(3)} → lowered ${f0.y.toFixed(3)}`)
    check('F2. LOWERED chains still scroll - the drive moves them, not the lift', advance(f0.offset, f1.offset) > 1e-6, `offset ${f0.offset.toFixed(5)} → ${f1.offset.toFixed(5)}`)

    // ---- E: a lane-length edit re-draws the lanes, which keep scrolling ---------------------------------
    await setParam(page, { laneLength: 3 })
    await wait(page, 800)
    const [e0, e1] = await run(page)
    check('E. after a lane-length edit: still three meshes, still scrolling', e1.meshes === 3 && advance(e0.offset, e1.offset) > 1e-6, `meshes=${e1.meshes} offset ${e0.offset.toFixed(5)} → ${e1.offset.toFixed(5)}`)

    // ---- S: stopped, it holds still ----------------------------------------------------------------------
    await page.evaluate(() => window.__oip.controller.stop())
    await wait(page, 500)
    const [t0, t1] = await run(page)
    check('S. stopped, the chain holds still', Math.abs(t1.offset - t0.offset) < 1e-9, `offset ${t0.offset.toFixed(5)} → ${t1.offset.toFixed(5)}`)

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'chain-bend-scroll.png') })
    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    if (vite.pid) spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
