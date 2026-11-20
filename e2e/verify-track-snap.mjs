// Ground truth: do the real Blade Stop + Chain Transfer parts snap onto the real Roller Conveyor, at the right
// angle and height? Drives the core snap engine (findSnap) against the registered bundled packages
// (oip.blade-stop / oip.chain-transfer / oip.roller-conveyor), the same registry the editor uses.
// Track-align snap: chain lanes sit in consecutive roller gaps with the part aligned to the roller flow
// (its through axis, local +X, along the main line, its lanes reaching across the bed), seating from an
// aligned drop with no rotation. An on-top drop still snaps (loose visible_threshold=2.0).
// Run: node e2e/verify-track-snap.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }
const near = (a, b, eps = 1e-3) => a != null && Math.abs(a - b) <= eps

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  try {
    await page.goto(URL)
    await page.waitForFunction(() => {
      const o = window.__oip
      return !!(o?.store && o.getPackage && o.getPackage('oip.blade-stop') && o.getPackage('oip.chain-transfer') && o.getPackage('oip.roller-conveyor'))
    }, { timeout: 30000 })

    const result = await page.evaluate(async () => {
      const { findSnap } = await import('/src/core/snap/snapFeatures.ts')
      const getPkg = window.__oip.getPackage
      const defOf = (id) => {
        const p = getPkg(id).params ?? {}
        const out = {}
        for (const k of Object.keys(p)) if (p[k] && typeof p[k].default !== 'undefined') out[k] = p[k].default
        return out
      }
      const rollerWidth = getPkg('oip.roller-conveyor').params?.width?.default ?? 1.524
      const chainFloorY = getPkg('oip.chain-transfer').geometry?.bounds?.bottom ?? 0
      // The transfer seats recessed, not flush: its `conveys` deck rides the pop-up lift joint, so a flush
      // seat would leave two powered surfaces coplanar on the host bed and whichever is idle would brake the
      // load. Read the depth from the declaration rather than hardcoding it, so this gate follows the part.
      const chainRecess = getPkg('oip.chain-transfer').snap?.track?.targetLocalY ?? 0

      const RY = 1 // roller conveyor origin (= roller-top surface) height
      const roller = { id: 'rc', type: 'part', packageId: 'oip.roller-conveyor', position: [0, RY, 0], rotationY: 0, params: defOf('oip.roller-conveyor') }
      const mk = (id, pkgId, pos, rot = 0) => ({ id, type: 'part', packageId: pkgId, position: pos, rotationY: rot, params: defOf(pkgId) })
      const pose = (x, y, z, rot = 0) => ({ position: [x, y, z], rotationY: rot })

      // Blade stop: anchors to a roller gap, auto-fits width
      const blade = mk('bs', 'oip.blade-stop', [0.42, RY, 0.08])
      const bladeSnap = findSnap(blade, pose(0.42, RY, 0.08, 0.05), [roller])

      // Chain transfer over the bed, dropped aligned with the host (rot 0). Correct snap = same yaw as the host
      // (native layout): the lane-spacing axis runs along the roller flow so lanes fall in the gaps, with no
      // rotation from the aligned drop (a transposed frame would turn it ±90° here).
      const chain = mk('ct', 'oip.chain-transfer', [-0.3, RY, 0.05])
      const chainSnap = findSnap(chain, pose(-0.3, RY, 0.05, 0), [roller])

      // Chain transfer dropped on top: its deep underside rests on the roller tops, so the origin sits |floorY|
      // above the seat. Must still snap (loose grab), pulling it down to seat level.
      const onTopY = RY + Math.abs(chainFloorY)
      const chainOnTop = mk('ct2', 'oip.chain-transfer', [0, onTopY, 0])
      const chainOnTopSnap = findSnap(chainOnTop, pose(0, onTopY, 0, 0), [roller])

      // Loose grab beside the bed
      const halfW = rollerWidth / 2
      const bladeBeside = mk('bs3', 'oip.blade-stop', [0.4, RY, halfW + 1.0])
      const bladeBesideSnap = findSnap(bladeBeside, pose(0.4, RY, halfW + 1.0, 0), [roller])

      // Sanity: far away must not snap
      const bladeFar = mk('bs2', 'oip.blade-stop', [0.4, RY, 6])
      const bladeFarSnap = findSnap(bladeFar, pose(0.4, RY, 6, 0), [roller])

      return { rollerWidth, chainFloorY, chainRecess, onTopY, hostYaw: 0, bladeSnap, chainSnap, chainOnTopSnap, bladeBesideSnap, bladeFarSnap }
    })

    console.log('roller width=%s | chain floorY=%s | on-top drop y=%s', result.rollerWidth, result.chainFloorY, result.onTopY)
    console.log('BLADE snap:', JSON.stringify(result.bladeSnap))
    console.log('CHAIN snap:', JSON.stringify(result.chainSnap))
    console.log('CHAIN-ON-TOP snap:', JSON.stringify(result.chainOnTopSnap))
    console.log('BLADE-BESIDE snap:', JSON.stringify(result.bladeBesideSnap))
    console.log('BLADE-FAR snap:', JSON.stringify(result.bladeFarSnap))

    const chainRot = result.chainSnap?.pose?.rotationY
    // aligned with host (host yaw 0) → rotationY ≈ 0 (no rotation from the aligned drop)
    const chainAligned = chainRot != null && near(Math.abs(chainRot), 0)

    check('Blade Stop snaps onto the roller conveyor', result.bladeSnap != null && result.bladeSnap.targetId === 'rc')
    check('Blade Stop snap adopts width (fitWidthParam)', !!(result.bladeSnap?.paramOverrides && 'width' in result.bladeSnap.paramOverrides), JSON.stringify(result.bladeSnap?.paramOverrides))
    check('Chain Transfer snaps onto the roller conveyor', result.chainSnap != null && result.chainSnap.targetId === 'rc')
    check('Chain Transfer snaps ALIGNED with the roller flow (yaw ≈ host, no rotation) - native layout', chainAligned, `rotationY=${chainRot}`)
    check('Chain Transfer adopts host pitch into distance', !!(result.chainSnap?.paramOverrides && 'distance' in result.chainSnap.paramOverrides), JSON.stringify(result.chainSnap?.paramOverrides))
    check('Chain Transfer dropped directly ON TOP of the rollers snaps', result.chainOnTopSnap != null && result.chainOnTopSnap.targetId === 'rc')
    // Not the bare bed surface: the seat is the roller top plus the declared recess (negative), 0.97 for the
    // shipped part. A hardcoded flush y=1 would fail a correct part.
    check('On-top snap seats the part at the bed surface plus its declared recess',
      near(result.chainOnTopSnap?.pose?.position?.[1], 1 + result.chainRecess, 1e-6),
      `y=${result.chainOnTopSnap?.pose?.position?.[1]} expected=${1 + result.chainRecess} (recess=${result.chainRecess})`)
    check('Blade Stop beside the bed (~1m off edge) snaps - loose grab', result.bladeBesideSnap != null && result.bladeBesideSnap.targetId === 'rc')
    check('Far blade stop (~5m off edge) does NOT snap (sanity)', result.bladeFarSnap == null)
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
