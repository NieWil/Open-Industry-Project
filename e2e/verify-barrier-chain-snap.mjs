// Ground truth: do the real Fence / Safety Gate / Guard Rail chain end-to-end in the running app? Drives the
// actual core snap engine (findSnap) against the registered bundled packages, the same registry the editor
// snaps against. Without a `snap.chain` declaration on the barrier packages, a fence doesn't join a fence, a
// gate doesn't join a fence line, and no corner post handshake fires. The other chain tests register synthetic
// packages, so they can't catch a shipped package missing the block; this app-level check covers the packages
// that actually ship. Companion to the deterministic bundledPackageData.test.ts.
//
// Asserts: the live packages carry snap.chain; a gate butts collinearly onto a fence end; a perpendicular drop
// forms an L-corner with the two-part omit-post handshake (the shared post draws once); the family split holds
// (fence + gate chain, a guard rail never joins them); and each family's engage reach is honoured.
// Run: node e2e/verify-barrier-chain-snap.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }
const near = (a, b, eps = 1e-3) => a != null && Math.abs(a - b) <= eps
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

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
      return !!(o?.store && o.getPackage && o.getPackage('oip.fence') && o.getPackage('oip.safety-gate') && o.getPackage('oip.guard-rail'))
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
      const mk = (id, pkgId, pos, rot = 0, over = {}) =>
        ({ id, type: 'part', packageId: pkgId, position: pos, rotationY: rot, params: { ...defOf(pkgId), ...over } })
      const pose = (x, y, z, rot = 0) => ({ position: [x, y, z], rotationY: rot })
      const chainOf = (id) => getPkg(id).snap?.chain ?? null

      // A 4 m fence centred at the origin, running along +X: ends at x = ±2.
      const FENCE_LEN = 4
      const GATE_LEN = 1
      const fence = mk('f', 'oip.fence', [0, 0, 0], 0, { length: FENCE_LEN })
      const gate = (id, pos, rot) => mk(id, 'oip.safety-gate', pos, rot, { length: GATE_LEN })

      // Collinear: a gate dropped just off the fence's +X end butts flush (half 2 + half 0.5 = 2.5), no shared post.
      const straight = findSnap(gate('g1', [2.6, 0, 0.08], 0.05), pose(2.6, 0, 0.08, 0.05), [fence])

      // L-corner: dropped perpendicular near the same end. The gate omits its mating post and the fence un-omits
      // the end they now share, so the corner post is drawn once (the two-part handshake).
      const corner = findSnap(gate('g2', [2.0, 0, 0.45], Math.PI / 2 - 0.1), pose(2.0, 0, 0.45, Math.PI / 2 - 0.1), [fence])

      // Fence-to-fence, the plain case the user hits first.
      const f2 = mk('f2', 'oip.fence', [4.3, 0, 0.1], 0.04, { length: FENCE_LEN })
      const fenceToFence = findSnap(f2, pose(4.3, 0, 0.1, 0.04), [fence])

      // Cross-group isolation: a guard rail must not join a fence line even well inside its looser 3 m reach.
      const rail = mk('r', 'oip.guard-rail', [4.1, 0, 0.05], 0, { length: 4 })
      const railToFence = findSnap(rail, pose(4.1, 0, 0.05, 0), [fence])
      // …but two guard rails chain to each other.
      const railHost = mk('rh', 'oip.guard-rail', [0, 0, 0], 0, { length: 4 })
      const railToRail = findSnap(mk('r2', 'oip.guard-rail', [4.3, 0, 0.1], 0.04, { length: 4 }), pose(4.3, 0, 0.1, 0.04), [railHost])

      // Reach: the fence family engages tight (1 m). A drop 1.5 m past the mate point must not grab; the same
      // offset on the guard rail's looser 3 m reach must.
      const fenceFar = findSnap(mk('f3', 'oip.fence', [5.5, 0, 0], 0, { length: FENCE_LEN }), pose(5.5, 0, 0, 0), [fence])
      const railFar = findSnap(mk('r3', 'oip.guard-rail', [5.5, 0, 0], 0, { length: 4 }), pose(5.5, 0, 0, 0), [railHost])

      return {
        chains: { fence: chainOf('oip.fence'), gate: chainOf('oip.safety-gate'), rail: chainOf('oip.guard-rail') },
        straight, corner, fenceToFence, railToFence, railToRail, fenceFar, railFar,
      }
    })

    const { chains: C } = result
    console.log('chain blocks:', JSON.stringify(C))
    console.log('COLLINEAR gate→fence:', JSON.stringify(result.straight))
    console.log('L-CORNER  gate→fence:', JSON.stringify(result.corner))
    console.log('fence→fence:', JSON.stringify(result.fenceToFence))

    check('the shipped Fence declares a chain snap', !!C.fence, JSON.stringify(C.fence))
    check('the shipped Safety Gate declares a chain snap', !!C.gate, JSON.stringify(C.gate))
    check('the shipped Guard Rail declares a chain snap', !!C.rail, JSON.stringify(C.rail))
    check('a gate shares the fence group (a gate is a door IN a fence line)', !!C.gate && C.gate.group === C.fence?.group, `${C.gate?.group} vs ${C.fence?.group}`)
    check('a guard rail is its own group', !!C.rail && C.rail.group !== C.fence?.group, `${C.rail?.group}`)
    check('all three name the omit-post params (the corner handshake)', [C.fence, C.gate, C.rail].every((c) => c?.omitStartParam === 'omitPostStart' && c?.omitEndParam === 'omitPostEnd'))

    check('a Safety Gate chains onto a Fence end', result.straight != null && result.straight.targetId === 'f')
    check('…butting flush at the shared end (x = fenceHalf + gateHalf = 2.5)', near(result.straight?.pose?.position?.[0], 2.5), `x=${result.straight?.pose?.position?.[0]}`)
    check('…and a straight run keeps BOTH posts', eq(result.straight?.paramOverrides, { omitPostStart: false, omitPostEnd: false }), JSON.stringify(result.straight?.paramOverrides))

    check('a perpendicular drop forms an L-corner', result.corner != null && near(result.corner?.pose?.rotationY, Math.PI / 2), `rotationY=${result.corner?.pose?.rotationY}`)
    check('…the gate omits its mating post', eq(result.corner?.paramOverrides, { omitPostStart: false, omitPostEnd: true }), JSON.stringify(result.corner?.paramOverrides))
    check('…and the fence un-omits the shared end, so the corner post draws ONCE', eq(result.corner?.targetParamOverrides, { omitPostEnd: false }), JSON.stringify(result.corner?.targetParamOverrides))

    check('a Fence chains onto another Fence', result.fenceToFence != null && result.fenceToFence.targetId === 'f')
    check('a Guard Rail does NOT join a fence line (cross-group isolation)', result.railToFence == null, JSON.stringify(result.railToFence))
    check('two Guard Rails chain to each other', result.railToRail != null && result.railToRail.targetId === 'rh')

    check('the fence family engages TIGHT - a 1.5 m-off drop is refused', result.fenceFar == null, JSON.stringify(result.fenceFar))
    check('the guard rail engages LOOSE - the same offset still grabs', result.railFar != null)
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}
main()
