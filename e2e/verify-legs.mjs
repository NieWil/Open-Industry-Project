// Correctness check for the instanced conveyor legs (common.ts writeLegs), driven by
// the SDK roller conveyor's rig kind:'leg' link. Confirms the leg InstancedMeshes
// exist with instances and that the leg feet land on the floor (world y ~ 0)
// directly under the conveyor (not at the origin or the bed). Saves a screenshot.
// Run: node e2e/verify-legs.mjs
/* global process, console, fetch, setTimeout, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

let failures = 0
const check = (name, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--disable-gpu-vsync'] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  // keep the onboarding tour off (it re-arms after localStorage.clear() and overlays the viewport)
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller), { timeout: 20000 })
    await page.waitForTimeout(1200)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view && window.__oip?.controller), { timeout: 20000 })
    await page.waitForTimeout(1000)
    // This is a regression check for the instanced-leg trestle renderer (common.ts createLegSet/writeLegs),
    // which the SDK roller conveyor drives through its rig kind:'leg' link (sdkPart.ts), so load a
    // minimal scene with the SDK oip.roller-conveyor (package embedded).
    // Surface top sits at the part origin's y (1.0 here); standHeight 1.0 drops the legs to the floor, and the
    // frame bottom (leg tops) lands ~0.5 m - the expectation the checks below assume.
    await page.evaluate(() => {
      window.__oip.store.loadScene({
        version: window.__oip.store.getState().scene.version,
        parts: [{
          id: 'rc_1', type: 'part', packageId: 'oip.roller-conveyor', name: 'Infeed', position: [0, 1.0, 0], rotationY: 0,
          params: { length: 4, width: 1.524, speed: 1, tiltDeg: 0, skew: 0, standHeight: 1.0, leftGuard: true, rightGuard: true },
        }],
        packages: [window.__oip.getPackage('oip.roller-conveyor')],
      }, { persist: false })
    })
    await page.waitForTimeout(1200)

    // Collect the leg InstancedMeshes for the infeed roller conveyor and read every
    // leg instance's world position (mesh.matrixWorld · instanceMatrix).
    const legInfo = await page.evaluate(() => {
      const THREE_Matrix4 = window.__oip.view.scene.constructor // not used; placeholder
      void THREE_Matrix4
      const part = window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.roller-conveyor')
      const obj = window.__oip.view.entries.get(part.id).visual.object
      obj.updateWorldMatrix(true, true)
      const out = { partX: part.position[0], meshes: [], minY: Infinity, maxY: -Infinity, footXs: [], totalInstances: 0 }
      obj.traverse((o) => {
        if (!o.isInstancedMesh || o.count === 0) return
        // skip the rollers/stubs (their geometry is the unit cylinder); legs use box + hex bolt.
        // Identify leg pools by having instances that reach the floor (min y near 0).
        const m = o.matrixWorld
        const tmp = new o.matrixWorld.constructor()
        let lo = Infinity
        let hi = -Infinity
        const xs = []
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, tmp)
          tmp.premultiply(m)
          const e = tmp.elements
          const y = e[13]
          if (y < lo) lo = y
          if (y > hi) hi = y
          xs.push(e[12])
        }
        out.meshes.push({ count: o.count, loY: +lo.toFixed(3), hiY: +hi.toFixed(3) })
        // a leg pool reaches the floor; track those
        if (lo < 0.15) {
          out.minY = Math.min(out.minY, lo)
          out.maxY = Math.max(out.maxY, hi)
          out.totalInstances += o.count
          for (const x of xs) out.footXs.push(x)
        }
      })
      const xMin = Math.min(...out.footXs)
      const xMax = Math.max(...out.footXs)
      return { ...out, xMin: +xMin.toFixed(2), xMax: +xMax.toFixed(2) }
    })
    console.log('  instanced meshes on infeed conveyor:', JSON.stringify(legInfo.meshes))

    check('conveyor has leg instances reaching the floor', legInfo.totalInstances > 0, `instances=${legInfo.totalInstances}`)
    check('leg feet rest on the floor (min world y ~ 0)', legInfo.minY >= -0.05 && legInfo.minY <= 0.12, `minY=${legInfo.minY.toFixed(3)}`)
    // legs span the floor up to the frame bottom (~0.55 here), which sits below the
    // deck/rollers (~0.96) - the frame structure fills the rest, so don't expect deck height
    check('legs rise to the frame bottom (below the deck)', legInfo.maxY > 0.4 && legInfo.maxY < 0.95, `maxY=${legInfo.maxY.toFixed(3)}`)
    check('legs sit under the conveyor in X (not at the origin)', Math.abs(((legInfo.xMin + legInfo.xMax) / 2) - legInfo.partX) < 1.5, `legX=[${legInfo.xMin},${legInfo.xMax}] partX=${legInfo.partX.toFixed(2)}`)

    // clean screenshot: deselect so the inspector closes and the conveyors are visible
    await page.evaluate(() => window.__oip.store.select(null))
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'legs.png') })

    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
