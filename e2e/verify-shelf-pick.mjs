/* global console, process, window, localStorage */
// Can a truck take a load back off a shelf? This is the shipping-loop step no other gate checks.
//
// Putting a load away is covered (verify-agv-rack-putaway). Taking one back is not the same move in reverse:
// the load is already there, so the blade has to fit a pocket 1.62 m up rather than merely clear the beams,
// and then lift a load that has been sleeping (physics-wise) on the slab. Whether it comes out cleanly is a
// physics question, not an arithmetic one, and this script answers it.
//
// It drives the truck through the cell's own program rather than around it. Setting the device tags directly
// does not work: world.setBehaviorInputTags replaces the device-IO table wholesale, and the controller pushes
// the program's whole tag set every scan, so a tag injected from a test survives about one scan before it is
// wiped (the truck stayed at its charge bay through five commands).
//
// So this swaps the rack truck's pick rows (1..5, the five the PalletTruck block drives as "the pick") for a
// pick off a rack shelf, stands a load on the staging lane's eye so the program dispatches it, and lets the
// shipped sequence do the work, which makes it a rehearsal of the real retrieval move rather than a
// stand-in.
//
// This script stages the load. The demo has one rack truck, and the whole bottom shelf of the rack it works
// is its put-away bays, so the demo stocks nothing there (demoScenes.ts, "none on the NEAR rack's bottom
// shelf"). The racked stock it does carry is on other racks, or on levels this truck's mast cannot reach. So
// a copy of the demo's own racked stock (an oip.unit-load, exactly what a stocked shelf holds) is set into the
// truck's first put-away bay before Play, which is a bay its own route reaches into.
//
// Every height and position is read off the truck's own route: its first put-away (4 rows: lineup at the
// over-the-beams height, in, down onto the slab, back out through the pockets) says where it lines up, where it
// stands to reach the bay, how high the load clears the lip (OVER) and how high a blade threads the pocket of a
// load standing on that slab (the withdraw height, THREAD).
//
// Run: node e2e/verify-shelf-pick.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

/** the five rows the PalletTruck block drives as "the pick" - here, off a rack shelf */
const pickRows = ({ ax, az, sx, sz, deg, thread, over }) => [
  [ax, az, deg, 0], //        1 line up square with the bay, forks down
  [ax, az, deg, thread], //   2 raise to pocket height standing still, clear of the rack
  [sx, sz, deg, thread], //   3 straight in: the blades thread the pockets, over the lip beams
  [sx, sz, deg, over], //     4 take the weight standing still (the grip latches here)
  [ax, az, deg, over], //     5 straight back out through the pockets, load clear of the beams
]
/** a load's width along the beams (core PALLET_SIZE[0]) and an upright's section: two loads share a bay's beam span
 *  in three equal gaps (src/editor/demo/demoScenes.ts RACK_SPOTS) */
const PALLET_W = 1.22
const UPRIGHT = 0.08
/** the bottom shelf's slab top: level 1 x the 1.6 shelf spacing + half the 0.04 slab */
const SLAB_TOP = 1.62

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) pass++; else fail++
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(180000)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
    await page.goto(`http://localhost:${port}/app/?scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view && window.__oip?.sim), { timeout: 60000 })
    await page.waitForSelector('.viewport-cover.ready', { timeout: 120000 }).catch(() => {})
    await page.waitForTimeout(1500)

    // Which shelf to pick off, and from where, all read off the rack truck's own route. Its first put-away
    // is the first run of four rows shaped [lineup, stand, stand, lineup] at one x: rows 0 and 3 are the lineup
    // (at the over-the-beams height, then at the withdraw height), rows 1 and 2 the spot it reaches into the bay
    // from. The route fills a bay low then high, so the first such run is the bottom shelf.
    const spot = await page.evaluate(([w, post]) => {
      const s = window.__oip.store.getState().scene
      const truck = s.parts.find((p) => p.packageId === 'oip.agv' && p.params?.commandTag === 'RackCmd')
      if (!truck) return { why: 'no oip.agv on RackCmd' }
      const wp = truck.params.waypoints
      const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
      let i = -1
      for (let k = 0; k + 3 < wp.length; k++) {
        const [r0, r1, r2, r3] = [wp[k], wp[k + 1], wp[k + 2], wp[k + 3]]
        if (same(r0, r3) && same(r1, r2) && !same(r0, r1) && Math.abs(r0[0] - r1[0]) < 1e-6 && r0[3] > 1 && r2[3] > 1) { i = k; break }
      }
      if (i < 0) return { why: 'no put-away rows in the route' }
      const [ax, az, deg, over] = wp[i], [sx, sz] = wp[i + 1], thread = wp[i + 3][3]
      // the rack it reaches into: the one whose line the stand row is nearest, with the row inside its length
      let rack = null, best = Infinity
      for (const r of s.parts.filter((p) => p.packageId === 'oip.rack')) {
        if (Math.abs(sx - r.position[0]) > (r.params.length ?? 7) / 2) continue
        const d = Math.abs(sz - r.position[2])
        if (d < best) { best = d; rack = r }
      }
      if (!rack) return { why: 'no rack in front of the put-away rows' }
      // the pallet position nearest the stand row's x: bays on a poleInterval pitch about the rack's centre, two
      // loads to a bay
      const pitch = rack.params.poleInterval
      const n = Math.round(rack.params.length / pitch)
      const off = (pitch - post - 2 * w) / 6 + w / 2
      const spots = Array.from({ length: n }, (_, k) => rack.position[0] + (k - (n - 1) / 2) * pitch).flatMap((c) => [c - off, c + off])
      const bayX = spots.reduce((p, c) => (Math.abs(c - sx) < Math.abs(p - sx) ? c : p))
      return { truck: truck.id, ax, az, sx, sz, deg, over, thread, bayX, rackZ: rack.position[2] }
    }, [PALLET_W, UPRIGHT])
    check('the rack truck\'s route has a bottom-shelf put-away to rehearse a pick from', !spot.why,
      spot.why ?? `bay ${spot.bayX.toFixed(2)}, ${spot.rackZ.toFixed(2)} - stand (${spot.sx.toFixed(2)}, ${spot.sz.toFixed(2)}), line up (${spot.ax.toFixed(2)}, ${spot.az.toFixed(2)}), thread ${spot.thread.toFixed(3)}, over ${spot.over.toFixed(3)}`)
    if (spot.why) throw new Error('no put-away bay')
    // the heights have to make sense against the shelf, or the rehearsal is testing something else
    check('...its heights thread the pocket and lift over the lip', spot.thread > 1.3 && spot.thread < 2 && spot.over > spot.thread,
      `thread ${spot.thread.toFixed(3)}, over ${spot.over.toFixed(3)}`)
    const PICK_ROWS = pickRows(spot)
    const BAY_X = spot.bayX, RACK_Z = spot.rackZ

    // Stock that bay: a copy of the demo's own racked stock (a bottom-shelf oip.unit-load on another rack), moved
    // into the bay at the same height above its slab, so it stands on the slab exactly as racked stock does
    const staged = await page.evaluate(([bx, rz, slab]) => {
      const store = window.__oip.store
      const s = store.getState().scene
      const proto = s.parts.find((p) => p.packageId === 'oip.unit-load' && p.position[1] > slab - 0.5 && p.position[1] < slab + 0.5)
      if (!proto) return null
      const load = { ...proto, id: 'probe_shelf_load', name: 'Probe shelf load', parent: undefined, position: [bx, proto.position[1], rz], rotationY: proto.rotationY ?? 0 }
      store.commit('Stock the shelf-pick bay', { ...s, parts: [...s.parts, load] })
      return { protoId: proto.id, y: proto.position[1] }
    }, [BAY_X, RACK_Z, SLAB_TOP])
    check('a copy of the demo\'s racked stock is set into that bay', !!staged, staged ? `copied ${staged.protoId}, y=${staged.y.toFixed(3)}` : 'no bottom-shelf oip.unit-load in the demo to copy')
    if (!staged) throw new Error('no stock to copy')

    // splice the shelf pick into the rack truck's route, while stopped so the sim builds with it
    const ids = await page.evaluate(([rows, truckId]) => {
      const store = window.__oip.store
      const s = store.getState().scene
      const truck = s.parts.find((p) => p.id === truckId)
      const start = s.parts.find((p) => p.packageId === 'oip.push-button' && p.params?.tag === 'Start')
      if (!truck) return null
      const wp = truck.params.waypoints.map((r) => [...r])
      for (let i = 0; i < rows.length; i++) wp[1 + i] = rows[i] // rows 1..5 are the pick; 0 is home, 6+ the bays
      const parts = s.parts.map((p) => p.id !== truck.id ? p : { ...p, params: { ...p.params, waypoints: wp } })
      store.commit('Shelf-pick probe route', { ...s, parts })
      return { truck: truck.id, start: start?.id ?? null, rows: wp.length }
    }, [PICK_ROWS, spot.truck])
    check('the rack truck\'s pick rows were swapped for a shelf pick', !!ids, ids ? `${ids.rows}-row route, truck ${ids.truck}` : 'the truck is gone')
    if (!ids) throw new Error('no truck')

    await page.evaluate(() => window.__oip.controller.run())
    await page.evaluate((a) => {
      const id = a.id
      const sim = window.__oip.sim, prior = sim.onFrame
      // Was the standing load pushed as the blades went in? Measured every frame rather than sampled: the
      // window between "arrived, threaded" and "lifted" is ~50 ms (the lift is 65 mm at 1.2 m/s), so a poll
      // that reads the program's step and then counts the bay runs after the lift as often as before it.
      // This watches the load's z while it is still resting on the slab, and keeps the worst drift it saw.
      window.__drift = { z0: null, max: 0 }
      // how many bodies make the whole load: set from the count before the truck is sent (a racked unit load is
      // one compound body; a loose load would be a pallet plus its cases), so "all of it" means all of that
      window.__loadN = 1
      sim.onFrame = (f) => {
        prior(f); window.__f = f
        let n = 0, sz = 0, lo = 9
        for (let i = 0; i < f.count; i++) {
          const px = f.positions[i * 3], py = f.positions[i * 3 + 1], pz = f.positions[i * 3 + 2]
          if (Math.abs(px - a.bx) > 0.8 || Math.abs(pz - a.bz) > 0.8 || py < 1.3 || py > 3.15) continue // centred on the bottom shelf only: level 2 slab is 3.22
          n++; sz += pz; lo = Math.min(lo, py - f.halfExtents[i * 3 + 1])
        }
        if (n >= window.__loadN && lo < 1.65) { // still standing on the slab, not yet picked up
          const z = sz / n
          if (window.__drift.z0 === null) window.__drift.z0 = z
          window.__drift.max = Math.max(window.__drift.max, Math.abs(z - window.__drift.z0))
        }
      }
      // what stands in a bay: every body over that shelf, and how tall the stack is
      window.__bay = (x, z) => {
        const f = window.__f
        if (!f) return { n: 0 }
        let n = 0, lo = 9, hi = -9
        for (let i = 0; i < f.count; i++) {
          const px = f.positions[i * 3], py = f.positions[i * 3 + 1], pz = f.positions[i * 3 + 2]
          if (Math.abs(px - x) > 0.8 || Math.abs(pz - z) > 0.8 || py < 1.3 || py > 3.15) continue // centred on the bottom shelf only: level 2 slab is 3.22
          n++
          lo = Math.min(lo, py - f.halfExtents[i * 3 + 1]); hi = Math.max(hi, py + f.halfExtents[i * 3 + 1])
        }
        return n ? { n, bottom: +lo.toFixed(3), top: +hi.toFixed(3), stack: +(hi - lo).toFixed(3) } : { n: 0 }
      }
      // ...and what rides on the truck's forks, measured in the truck's own frame so it follows it around
      window.__forks = () => {
        const f = window.__f, bp = f?.basePoses?.[id]
        if (!bp) return { n: 0 }
        const fx = Math.cos(bp.yaw), fz = -Math.sin(bp.yaw), lx = -fz, lz = fx
        let n = 0, lo = 9, hi = -9
        for (let i = 0; i < f.count; i++) {
          const dx = f.positions[i * 3] - bp.pos[0], y = f.positions[i * 3 + 1], dz = f.positions[i * 3 + 2] - bp.pos[2]
          const fwd = dx * fx + dz * fz, left = dx * lx + dz * lz
          if (fwd < 0.6 || fwd > 2.8 || Math.abs(left) > 1.1 || y < 1.2 || y > 3.15) continue
          n++
          lo = Math.min(lo, y - f.halfExtents[i * 3 + 1]); hi = Math.max(hi, y + f.halfExtents[i * 3 + 1])
        }
        return { n, bottom: n ? +lo.toFixed(3) : 0, stack: n ? +(hi - lo).toFixed(3) : 0 }
      }
      window.__pose = () => {
        const f = window.__f, bp = f?.basePoses?.[id]
        return bp ? { x: +bp.pos[0].toFixed(2), z: +bp.pos[2].toFixed(2), lift: +((f.joints?.[id]?.lift) || 0).toFixed(3) } : null
      }
      // How high the load was ever carried, watched every frame rather than sampled. "Clear of the shelf beams"
      // is only true for the couple of seconds between the withdrawal and the truck lowering the load to travel
      // height, and a poll that reads it afterwards catches a load at 1.46 m and calls it a failure to lift.
      window.__peak = { bottom: 0 }
      const priorFrame = sim.onFrame
      sim.onFrame = (f) => {
        priorFrame(f); window.__f = f
        const k = window.__forks()
        if (k.n >= window.__loadN && k.bottom > window.__peak.bottom) window.__peak = { bottom: k.bottom, n: k.n, stack: k.stack }
      }
    }, { id: ids.truck, bx: BAY_X, bz: RACK_Z })
    await page.waitForTimeout(1200)

    // start the line the way a person does: the cell's own Start button
    if (ids.start) await page.evaluate((id) => window.__oip.sim.usePart(id), ids.start)
    await page.waitForTimeout(1500)
    // `running` is a program-local variable the watch does not carry (verify-turntable-transfer says why), so
    // "the cell runs" is read as the program being attached and the sim running
    const running = await page.evaluate(() => window.__oip.controller.programStatus?.attached === true && window.__oip.store.getState().running === true)
    check('the cell is running', running, running ? 'program attached' : 'the program never attached')

    const before = await page.evaluate(([x, z]) => window.__bay(x, z), [BAY_X, RACK_Z])
    check('the bay starts with a whole load standing on the shelf', before.n >= 1 && Math.abs(before.bottom - SLAB_TOP) < 0.04 && before.stack > 1.0,
      `${before.n} bodies, stack ${before.stack} m, underside y=${before.bottom} (slab ${SLAB_TOP})`)
    await page.evaluate((n) => { window.__loadN = n }, Math.max(1, before.n))

    // stand a load on the staging lane's eye so the dispatcher sends this truck out at all: a copy of the demo's
    // racked stock again, set on the lane deck with its leading face just past the eye ('Lane staged')
    const laneLoad = await page.evaluate((slab) => {
      const store = window.__oip.store
      const s = store.getState().scene
      const lane = s.parts.find((p) => p.name === 'Staging lane')
      const eye = s.parts.find((p) => p.name === 'Lane staged')
      const proto = s.parts.find((p) => p.packageId === 'oip.unit-load' && Math.abs(p.position[1] - slab) < 0.5)
      if (!lane || !eye || !proto) return null
      const y = lane.position[1] + (proto.position[1] - slab)
      const load = { ...proto, id: 'probe_lane_load', name: 'Probe lane load', parent: undefined, position: [eye.position[0] - 0.3, y, lane.position[2]], rotationY: proto.rotationY ?? 0 }
      store.commit('Stage a load on the staging lane', { ...s, parts: [...s.parts, load] })
      return { x: load.position[0], y, z: load.position[2] }
    }, SLAB_TOP)
    check('a load is staged on the lane eye to dispatch the truck', !!laneLoad, laneLoad ? JSON.stringify(laneLoad) : "no 'Staging lane' / 'Lane staged' eye")

    // ...then watch the pick happen. Watch the load, not the program's step number: a step says a move has been
    // commanded, and what matters is when one has finished. Step numbers are unreliable here: step 21 is reached
    // while the truck still stands in the bay with the load 50 mm off the slab, and step numbers change meaning
    // whenever the route gains rows. The condition itself is stable: the bay is empty and the load is on the
    // blades. (Polled fast, because the shot below needs that moment, not the minute after it.)
    let step = 0, maxStep = 0, bay = before, forks = { n: 0 }
    for (let i = 0; i < 2400; i++) {
      const w = await page.evaluate(() => Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v])) || {})
      step = w.TruckStep ?? 0; maxStep = Math.max(maxStep, step)
      bay = await page.evaluate(([x, z]) => window.__bay(x, z), [BAY_X, RACK_Z])
      forks = await page.evaluate(() => window.__forks())
      if (forks.n >= before.n && bay.n === 0) break //  it has the load and the shelf is clear
      if (step === 0 && maxStep > 0) break //  ...or it went round a whole trip and home without the load in hand
      await page.waitForTimeout(150)
    }
    // Shoot first, before the remaining checks. The truck only holds this load for the few seconds between
    // reversing out of the bay and lowering it into the next one; a shot taken after the assertions finds it
    // empty-handed with the load already back on a shelf.
    await page.evaluate(() => {
      const p = window.__pose(), v = window.__oip.view
      v.controls.target.set(p.x + 0.4, 1.5, p.z + 1.1)
      v.camera.position.set(p.x - 7.5, 3.0, p.z + 2.2)
      v.camera.lookAt(v.controls.target); v.controls.update()
    })
    await cleanShot(page, 'e2e/shots/shelf-pick.png')

    const pose = await page.evaluate(() => window.__pose())
    // PalletTruck steps 12..20 send the pick rows, and 22 is set once the 5th (back out of the bay) is sent
    check('the program drove the truck through the shelf pick', step >= 22,
      `TruckStep=${step}, truck at ${pose ? `(${pose.x}, ${pose.z}) lift ${pose.lift}` : 'no pose'}`)
    const drift = await page.evaluate(() => window.__drift)
    check('...threading the blades without shoving the load it reached into', drift.z0 !== null && drift.max < 0.05,
      `worst drift ${(drift.max * 1000).toFixed(0)} mm while it still stood on the slab`)
    check('THE WHOLE LOAD CAME: every body that stood in the bay rides the forks', forks.n >= before.n, `${forks.n} bodies riding the forks (${before.n} stood in the bay)`)
    check('...and the stack is still a stack', Math.abs(forks.stack - before.stack) < 0.05, `${forks.stack} m tall (it stood at ${before.stack})`)
    // the highest it was ever held while carrying, not wherever it happens to be when the poll runs: the truck
    // lowers the load to travel height as soon as it is clear, which is correct and not what this checks
    const peak = await page.evaluate(() => window.__peak)
    // the lip beams stand 0.02 proud of the slab, so clearing them means the underside rose > 0.02 off where it stood
    check('...carried clear of the shelf beams', peak.bottom > before.bottom + 0.025,
      `held as high as y=${peak.bottom} (it stood at ${before.bottom}, lip 0.02 above the slab), now y=${forks.bottom}`)
    check('nothing was left standing in the bay', bay.n === 0, `${bay.n} bodies still on the shelf`)

    // The shot frames the truck's live pose from well back. A fixed camera aimed at the bay shows an empty
    // aisle: by the time the shot is taken the truck has taken its load and driven toward the drop. cleanShot
    // takes ~3 s and the truck does 1 m/s, so the view has to hold 3 m of travel.
    // Informational, not a check. The truck holds this load only between reversing out of one bay and
    // lowering it into the next, and cleanShot takes ~3 s on a software-WebGL runner, so whether the shot
    // catches it loaded depends on the machine, not the cell. The numbers above are the evidence; this
    // reports whether the picture agrees, rather than passing just because a file exists.
    const atShutter = await page.evaluate(() => window.__forks())
    console.log(`      e2e/shots/shelf-pick.png: ${atShutter.n >= before.n ? 'load still on the forks' : `MISSED - ${atShutter.n} bodies on the forks by then`}`)
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  console.log(`\n=== ${fail ? 'FAIL' : 'PASS'} === (${pass}/${pass + fail})`)
  if (fail) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exit(1) })
