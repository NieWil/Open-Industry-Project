// Gate for defaulting ?joltthreads on: the multithreaded Jolt build must produce a bit-identical
// simulation to the single-threaded build. Project tests and node goldens run single-threaded,
// while a threaded browser runs MT. Any divergence would let a scene pass validation on one engine
// and behave differently on the other.
//
// Runs in the browser, not vitest. Under node the MT build's Emscripten pthread bootstrap hangs at
// init (stock jolt-physics 1.1.0 does too, so it is upstream, not the fork). The dev server has
// COOP/COEP, so pthreads work there.
// Both worlds run in the page context (SimWorld imported through vite's module graph), stepped in
// lockstep with frames compared bitwise every 60 steps over 6 s of linear + arc conveyor carry
// with box-box contacts. Also checks MT run-to-run repeatability (scheduling must not leak).
// Run: node e2e/mt-determinism.mjs        (chromium, the default gate)
//      node e2e/mt-determinism.mjs --webkit   (same gate on the WebKit engine - Safari proxy)
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium, webkit } from 'playwright'

const { port: PORT, vite } = await startServer()

async function main() {
  const engine = process.argv.includes('--webkit') ? webkit : chromium
  const browser = await engine.launch({ headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ok */ } })
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).split('\n')[0]))
  try {
    await page.goto(`http://localhost:${PORT}/app/`)
    if (!(await page.evaluate(() => window.crossOriginIsolated))) {
      throw new Error('dev server is not sending COOP/COEP - restart it')
    }
    console.log('page isolated; importing modules...')

    await page.evaluate(async () => {
      const { SimWorld } = await import('/src/sim/world.ts')
      const { registerPackage } = await import('/src/core/parts/partRegistry.ts')
      const { SCENE_VERSION } = await import('/src/core/types/index.ts')
      window.__mt = { SimWorld, registerPackage, SCENE_VERSION }
    })
    console.log('app modules imported; initializing ST jolt...')
    await page.evaluate(async () => {
      window.__mt.JoltST = await (await import('/node_modules/jolt-physics/dist/jolt-physics.wasm.js')).default()
    })
    console.log('ST jolt ready; initializing MT jolt (pthread pool spawn)...')
    await page.evaluate(async () => {
      window.__mt.JoltMT = await (await import('/node_modules/jolt-physics/dist/jolt-physics.multithread.wasm.js')).default()
    })
    console.log('MT jolt ready; running determinism comparison...')

    const result = await page.evaluate(async () => {
      const { SimWorld, registerPackage, SCENE_VERSION, JoltST, JoltMT } = window.__mt

      // ---- fixtures (the inline-package pattern of sdkConveyorParity.test.ts) ----
      const beltParams = {
        segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
        width: { type: 'number', default: 0.6 },
        height: { type: 'number', default: 0.5 },
        speed: { type: 'number', default: 1.5 },
      }
      registerPackage({
        format: 3, id: 'test.mtbox', name: 'Box',
        params: {
          length: { type: 'number', default: 0.6 }, height: { type: 'number', default: 0.4 },
          width: { type: 'number', default: 0.4 }, mass: { type: 'number', default: 10 },
          color: { type: 'color', default: '#ffffff' },
        },
        behavior: 'definePart({ step(){} })',
        geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } },
      })
      registerPackage({
        format: 3, id: 'test.mtbelt', name: 'Belt', params: beltParams,
        behavior: `definePart({
          params: ${JSON.stringify(beltParams)},
          step(ctx) { var s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
        })`,
        geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
      })
      registerPackage({
        format: 3, id: 'test.mtcurve', name: 'Curve',
        params: {
          innerRadius: { type: 'number', default: 0.5 },
          width: { type: 'number', default: 1.524 },
          sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } },
          speed: { type: 'number', default: 2 },
        },
        behavior: `definePart({
          params: {
            innerRadius: { type: 'number', default: 0.5 }, width: { type: 'number', default: 1.524 },
            sweepDeg: { type: 'number', default: 90 }, speed: { type: 'number', default: 2 },
          },
          geometry(g) { return [{ desc: g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], [[0, 0, 0], [1, 0, 0]]), finish: 'belt' }] },
          step(ctx) {
            var rc = ctx.params.innerRadius + ctx.params.width / 2
            ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega: ctx.params.speed / rc })
          },
        })`,
        geometry: { kind: 'drawn', bounds: { length: 2.274, width: 2.274, top: 0.5 }, conveys: true },
      })

      const part = (id, packageId, pos, params) => ({ id, type: 'part', packageId, position: pos, rotationY: 0, params })
      const box = (id, pos) => part(id, 'test.mtbox', pos, { length: 0.6, height: 0.4, width: 0.4, mass: 10, color: '#e0a030' })
      const makeScene = () => {
        const parts = [
          part('belt', 'test.mtbelt', [0, 1, 0], { segments: [[4, 0]], width: 0.6, height: 0.5, speed: 1.5 }),
          part('curve', 'test.mtcurve', [6, 1, 0], { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 }),
        ]
        for (let i = 0; i < 4; i++) parts.push(box(`b${i}`, [-1.6 + i * 0.6, 1.35, 0]))
        for (let i = 0; i < 6; i++) parts.push(box(`c${i}`, [6 + 0.9 * Math.cos(i), 1.35, 0.9 * Math.sin(i)]))
        return { version: SCENE_VERSION, parts }
      }

      // ---- lockstep + bitwise compare ----
      const bits = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length)
      const compare = (wa, wb, label) => {
        const fa = wa.frame()
        const fb = wb.frame()
        if (fa.count !== fb.count) return `${label}: count ${fa.count} vs ${fb.count}`
        for (const key of ['positions', 'quats']) {
          const a = bits(fa[key])
          const b = bits(fb[key])
          for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return `${label}: ${key}[${i}] ${fa[key][i]} vs ${fb[key][i]}`
          }
        }
        return null
      }
      const run = (wa, wb, label) => {
        for (let s = 1; s <= 360; s++) {
          wa.step()
          wb.step()
          if (s % 60 === 0) {
            const err = compare(wa, wb, `${label} @step ${s}`)
            if (err) return err
          }
        }
        return null
      }
      // checkpoint recorder for sequential runs. Two concurrent MT worlds would need 2x15 job
      // threads, more than the build's 16-worker pthread pool, and the blocked main thread can't
      // spawn more mid-evaluate (deadlock). So the repeat check records one run, then compares.
      const record = (w) => {
        const snaps = []
        for (let s = 1; s <= 360; s++) {
          w.step()
          if (s % 60 === 0) {
            const f = w.frame()
            snaps.push({ count: f.count, positions: bits(f.positions).slice(), quats: bits(f.quats).slice() })
          }
        }
        return snaps
      }
      const compareSnaps = (sa, sb, label) => {
        for (let k = 0; k < sa.length; k++) {
          const a = sa[k]
          const b = sb[k]
          if (a.count !== b.count) return `${label} @checkpoint ${k}: count ${a.count} vs ${b.count}`
          for (const key of ['positions', 'quats']) {
            for (let i = 0; i < a[key].length; i++) {
              if (a[key][i] !== b[key][i]) return `${label} @checkpoint ${k}: ${key} bits[${i}] differ`
            }
          }
        }
        return null
      }

      const out = { stVsMt: null, mtRepeat: null, moved: 0, count: 0 }
      {
        // ST world has no job threads, so one MT world (15 threads) fits the 16-worker pool
        const wst = new SimWorld(JoltST, makeScene())
        const wmt = new SimWorld(JoltMT, makeScene())
        out.stVsMt = run(wst, wmt, 'ST vs MT')
        const f = wst.frame()
        out.count = f.count
        out.moved = Math.max(...f.positions.filter((_, i) => i % 3 === 0))
        wst.dispose()
        wmt.dispose()
      }
      {
        const wa = new SimWorld(JoltMT, makeScene())
        const snapsA = record(wa)
        wa.dispose()
        const wb = new SimWorld(JoltMT, makeScene())
        const snapsB = record(wb)
        wb.dispose()
        out.mtRepeat = compareSnaps(snapsA, snapsB, 'MT vs MT')
      }
      return out
    })

    console.log(`\ncargo bodies: ${result.count}, max carried x: ${result.moved.toFixed(2)} m (sanity: sim did real work)`)
    console.log(`ST vs MT (360 steps, checked every 60): ${result.stVsMt ?? 'BIT-IDENTICAL'}`)
    console.log(`MT vs MT repeatability:                 ${result.mtRepeat ?? 'BIT-IDENTICAL'}`)
    if (result.stVsMt || result.mtRepeat || result.count === 0 || result.moved < 0.5) {
      console.log('\nVERDICT: FAIL - threads-by-default is NOT safe')
      process.exitCode = 1
    } else {
      console.log('\nVERDICT: PASS - MT is deterministic and matches ST bit-for-bit on this workload')
    }
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
  process.exit(process.exitCode ?? 0)
}
main().catch((e) => { console.error('mt-determinism crashed:', e); process.exit(1) })
