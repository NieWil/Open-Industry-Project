// The demo's trucks put loads away on the rack; they don't drop them on the floor. That is a claim about
// physics, not about a waypoint table: the load has to come to rest on a shelf slab, centred in a free pallet position,
// with its stack still standing, and it has to stay there after the truck pulls its tines out.
//
// Watches the rack truck's first two deliveries off the staging lane: the load the scene opens with on the build
// deck, then the first one the cell builds. The truck fills a bay low then high, so they go into the same pallet position,
// one on the bottom shelf and one on the shelf above it - the second is the test of the first as well as of the
// upper level: a truck that sets a load down short, or swings its tines instead of backing straight out, takes the
// load below it down with it. (The demo's other truck keeps the pallet dispenser loaded.)
//   node e2e/verify-agv-rack-putaway.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()

// Which pallet position each delivery goes to is read off the running scene, never typed here. Typed stock
// bays and targets, as absolute x/z, do not move with the rack line. The rack line is spaced off the palletizer
// cell's east fence, so widening that aisle slides every one of them 1.24 m, and the gate would look for loads on
// bare floor (eight of fifteen checks failing, none of them about a truck). So the grid of pallet positions comes
// from the oip.rack parts in the scene (a bay every poleInterval, two pallets to a bay), and the stock from
// whatever is standing on a shelf before the trucks start. The gate asserts that a delivery ends up centred in a
// free position of a real rack, and that everything already up there is still there afterwards, wherever the
// racks stand.
/** a load's width along the beams (core PALLET_SIZE[0]) and an upright's section: two loads share a bay's beam span
 *  in three equal gaps (src/editor/demo/demoScenes.ts RACK_SPOTS) */
const PALLET_W = 1.22
const UPRIGHT = 0.08
const SHELF_SPACING = 1.6 // oip.rack's default shelfSpacing
/** shelf `level`'s slab top (1 = the bottom shelf): level x spacing + half the 0.04 slab */
const slabTop = (level) => +(level * SHELF_SPACING + 0.02).toFixed(3)
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.sim), { timeout: 30000 })
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]))
  page.on('dialog', (d) => d.accept())
  try {
    await page.goto(`http://localhost:${PORT}/app/`); await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    await page.waitForTimeout(1000)
    const tut = page.locator('.tut-close')
    if (await tut.count()) await tut.first().click()
    await clickDemo(page)
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.__oip.controller.run())

    // every pallet position of every rack in the scene: the grid a delivery has to land on one of
    const BAYS = await page.evaluate(([w, post]) => window.__oip.store.getState().scene.parts
      .filter((p) => p.packageId === 'oip.rack')
      .flatMap((r) => {
        const pitch = r.params.poleInterval
        const n = Math.round(r.params.length / pitch) //   3 bays in an 8.4 m run
        const off = (pitch - post - 2 * w) / 6 + w / 2 //  half a gap and half a load off the bay centre
        return Array.from({ length: n }, (_, i) => r.position[0] + (i - (n - 1) / 2) * pitch)
          .flatMap((c) => [c - off, c + off].map((x) => ({ x: +x.toFixed(3), z: r.position[2] })))
      }), [PALLET_W, UPRIGHT])
    console.log(`rack pallet positions: ${BAYS.length} across ${new Set(BAYS.map((b) => b.z)).size} racks`)

    // census of one shelf of a bay: every body standing on it, and how low the lowest one sits
    await page.evaluate(() => {
      const sim = window.__oip.sim, prior = sim.onFrame
      window.__bay = (t) => {
        const f = window.__lastFrame
        if (!f) return null
        let n = 0, sx = 0, sz = 0, lo = 9, hi = -9
        for (let i = 0; i < f.count; i++) {
          const x = f.positions[i * 3], y = f.positions[i * 3 + 1], z = f.positions[i * 3 + 2]
          // ±0.6 in x is half a pallet position: wide enough for every body of a 1.22 m load, tight enough that the
          // neighbouring position's stock (1.31 m over, the other half of the bay) can't enter the count and
          // shift the centroid. ±0.8 in z is half the frame and the overhang with room to spare
          // and only bodies centred on this shelf: from its slab up to just under the next one. A full load is 1.34 m
          // tall, so the top course of the load below centres ~0.45 m under this slab and the next shelf's loads
          // centre above it - neither is counted
          const base = t.level * 1.6
          if (Math.abs(x - t.x) > 0.6 || Math.abs(z - t.z) > 0.8 || y < base || y > base + 1.5) continue
          n++; sx += x; sz += z
          lo = Math.min(lo, y - f.halfExtents[i * 3 + 1])
          hi = Math.max(hi, y + f.halfExtents[i * 3 + 1])
        }
        return n ? { n, x: +(sx / n).toFixed(3), z: +(sz / n).toFixed(3), bottom: +lo.toFixed(3), top: +hi.toFixed(3) } : { n: 0 }
      }
      sim.onFrame = (f) => { prior(f); window.__lastFrame = f }
    })
    await page.waitForTimeout(1500) // one frame of bodies, so the shelves can be read before anything moves
    // ...and which of them the dressing stock is already standing in - the loads a truck must not clip
    // (the bottom two shelves: the ones the truck works)
    const census = async () => {
      const out = []
      for (const b of BAYS) for (const level of [1, 2]) {
        const s = { ...b, level }
        out.push({ ...s, ...(await page.evaluate((bb) => window.__bay(bb), s)) })
      }
      return out
    }
    const before = await census()
    const STOCK = before.filter((b) => b.n >= 1)
    console.log(`stock on the shelves at start: ${STOCK.map((s) => `${s.x},${s.z}@${s.level}`).join(' | ')}`)
    check('the demo starts with racked stock for a truck to miss', STOCK.length >= 3, `${STOCK.length} loads`)

    const tags = () => page.evaluate(() => {
      const w = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v])) || {}
      return { step: w.TruckStep, slot: w.TruckSlot }
    })
    // delivery n is done when the dispatcher has been round n times (its slot advanced past n - 1). A load leaves
    // the cell every ~78 s of sim time, so the second delivery lands ~4.5 minutes in.
    const delivered = { 1: false, 2: false }
    const DEADLINE = Date.now() + 360000
    let last = ''
    while (Date.now() < DEADLINE && !(delivered[1] && delivered[2])) {
      await page.waitForTimeout(2000)
      const t = await tags()
      if (t.slot >= 1) delivered[1] = true
      if (t.slot >= 2) delivered[2] = true
      const line = JSON.stringify(t)
      if (line !== last) { console.log(`  ${line}`); last = line }
    }
    console.log(`deliveries: 1st=${delivered[1]} 2nd=${delivered[2]}`)
    await page.waitForTimeout(4000) // let anything that was going to topple, topple

    // ...and which bay each delivery was sent to, off the truck's own route. The row it stands on to reach into a
    // bay is the closest any of its waypoints gets to a bay centre (one carry length; its lineup is a standoff
    // further back and its lane rows are nowhere near a rack). The bays those rows reach, in route order, are the
    // order it fills them in. So the targets come from the waypoints without this script having to know the
    // route table's shape or how far ahead the truck carries a load.
    const nearestBay = (x, z) => BAYS
      .map((b) => ({ b, d: Math.hypot(b.x - x, b.z - z) }))
      .reduce((best, c) => (c.d < best.d ? c : best), { b: null, d: Infinity })
    const wp = await page.evaluate(() => window.__oip.store.getState().scene.parts
      .find((p) => p.packageId === 'oip.agv' && p.params.commandTag === 'RackCmd')?.params.waypoints ?? [])
    // Which shelf is the row's fork height: the tines stand within a few cm of the slab they set a load on.
    const reach = Math.min(...wp.map((w) => nearestBay(w[0], w[1]).d))
    const hits = wp.filter((w) => nearestBay(w[0], w[1]).d < reach + 0.05)
      .map((w) => ({ ...nearestBay(w[0], w[1]).b, level: Math.round(w[3] / SHELF_SPACING) }))
    const order = hits.filter((b, i) => hits.findIndex((c) => c.x === b.x && c.z === b.z && c.level === b.level) === i)
    const TARGET = { 1: order[0] ? { ...order[0], tag: '1st' } : null, 2: order[1] ? { ...order[1], tag: '2nd' } : null }
    for (const n of [1, 2]) console.log(`delivery ${n} is put away into bay ${TARGET[n] ? `${TARGET[n].x},${TARGET[n].z} level ${TARGET[n].level}` : '(none found)'}`)

    for (const n of [1, 2]) {
      const t = TARGET[n]
      if (!t) { check(`delivery ${n}: the route names a rack pallet position`, false, 'no waypoint reaches into a bay'); continue }
      check(`${t.tag} delivery: it was sent to a FREE bay`, !STOCK.some((s) => s.x === t.x && s.z === t.z && s.level === t.level),
        `bay ${t.x}, ${t.z} level ${t.level}`)
      if (!delivered[n]) { check(`${t.tag} delivery: the truck completed the put-away`, false, 'never finished within the window'); continue }
      const bay = await page.evaluate((tt) => window.__bay(tt), t)
      check(`${t.tag} delivery: the whole load is in the bay (pallet + 15 cases)`, bay.n >= 16, `${bay.n} bodies`)
      check(`${t.tag} delivery: it is standing ON the level ${t.level} slab, not fallen through or dropped short`,
        Math.abs(bay.bottom - slabTop(t.level)) < 0.04, `underside y=${bay.bottom} vs slab ${slabTop(t.level)}`)
      // Two clearances, one per axis. X: a 2.8 m bay holds two 1.22 m loads with ~0.09 m between each and its
      // neighbour or upright. The bound is 0.04 because what is measured is the centroid of pallet + cases, and the
      // case pattern's centroid sits 13 mm off the pallet centre (which way round depends on how the load was laid),
      // well inside the gap either way. Z: the 1.02 m load overhangs the 0.9 m frame by 60 mm front and back; 0.15
      // keeps it on both beams.
      // X is tighter than Z because nothing resists a load set into an upright (the poles between bays are
      // decorative; only the four corner posts collide). A 1.5 deg heading dead-band times the ~1.25 m from the
      // truck's pivot out to the load puts a delivery ~50 mm off centre and 2.3 deg skewed, 30 mm inside an
      // upright. With ANG_TOL at 0.25 deg (examples/parts/agv/part.js) a delivery ends up within 14 mm, unyawed,
      // 45 mm clear of the pole.
      // e2e/probes/rack-delivered-reach.mjs re-measures the lot, rotation-corrected.
      check(`${t.tag} delivery: centred in its pallet position`,
        Math.abs(bay.x - t.x) < 0.04 && Math.abs(bay.z - t.z) < 0.15, `at ${bay.x}, ${bay.z} vs bay ${t.x}, ${t.z}`)
      check(`${t.tag} delivery: the stack is still stacked`, bay.top - bay.bottom > 1.2, `load height ${(bay.top - bay.bottom).toFixed(2)} m`)

      await page.evaluate((tt) => {
        const v = window.__oip.view
        const y = tt.level * 1.6 + 0.6
        v.controls.target.set(tt.x, y, tt.z)
        v.camera.position.set(tt.x - 3.2, y + 2, tt.z + (tt.z < -10 ? 6.5 : -6.5))
        v.camera.lookAt(v.controls.target); v.controls.update()
      }, t)
      await page.waitForTimeout(200)
      await cleanShot(page, `e2e/shots/agv-rack-putaway-${t.tag}.png`)
    }
    // every load that was already on a shelf when the run started is still on it (and the first delivery survived
    // the second, which the loop above has already checked, since it looked at both bays after both deliveries)
    for (const s of STOCK) {
      const bay = await page.evaluate((tt) => window.__bay(tt), s)
      check(`the racked stock at ${s.x}, ${s.z} level ${s.level} is untouched`,
        bay.n === s.n && Math.abs(bay.bottom - s.bottom) < 0.04, `${bay.n} bodies (was ${s.n}), underside y=${bay.bottom} (was ${s.bottom})`)
    }

    // one wide shot of the aisle the trucks work, for the eye - framed on the rack line's own centre, so it
    // stays pointed at the racks wherever they stand
    const rackMidX = (Math.min(...BAYS.map((b) => b.x)) + Math.max(...BAYS.map((b) => b.x))) / 2
    await page.evaluate((mid) => {
      const v = window.__oip.view
      v.controls.target.set(mid, 1.6, -10.7)
      v.camera.position.set(mid - 10, 7.0, -10.7)
      v.camera.lookAt(v.controls.target); v.controls.update()
    }, rackMidX)
    await page.waitForTimeout(200)
    await cleanShot(page, 'e2e/shots/agv-rack-putaway-aisle.png')
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

    const pass = results.every((r) => r.ok)
    console.log(`\n=== ${pass ? 'PASS' : 'FAIL'} === (${results.filter((r) => r.ok).length}/${results.length})`)
    process.exitCode = pass ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
