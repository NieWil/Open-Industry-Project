// End-to-end check of the demo's layer-forming palletizing cell - the physics half, which no unit test can
// reach. The program logic is covered deterministically by src/editor/demo/demoScenes.test.ts; what this proves is
// that the mechanisms actually do what the logic asks of them:
//
//   1. cases spawn onto the infeed and convey,
//   2. the held-out turning plow really pivots a case ~90° as it passes (the pattern depends on it),
//   3. cases pack nose-to-tail against the row stop at the pattern's own x offsets,
//   4. the chain transfer pushes a finished row aside and presses it square on the layer stop,
//   5. that pushed row plus the one formed after it make a 5-case layer on the lane, and
//   6. the palletizer lifts all five at once (C-multigrab) and lays them on the pallet.
//
// The sim runs in real time in the worker, so a full pallet is minutes; this samples cargo poses off the frame
// stream (worker messages are not throttled headless, unlike timers/rAF) and reports the furthest stage the cell
// reached, with the numbers behind each. Run: node e2e/verify-layer-palletizer.mjs [--headed] [--seconds=N]
/* global process, console, window, setTimeout */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SECONDS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1] || 180)

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.sim), { timeout: 20000 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('dialog', (d) => d.accept())

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1000)

    await clickDemo(page)
    await page.waitForTimeout(500)

    // The cell's geometry, read off the scene so the thresholds below track the authored layout rather than
    // hard-coded copies of it.
    const cell = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const byName = (n) => parts.find((p) => p.name === n)
      return {
        rowStop: byName('Row stop')?.position ?? null,
        // What squares a pushed row is the row former's own +z side guard, not a part of its own - so read the
        // bed and derive the face cargo actually touches (the rig seats a guard at width/2 + 0.0125, 0.005 thick).
        bedGuardUp: byName('Row former')?.params?.rightGuard ?? null,
        bedGuardFace: byName('Row former') ? byName('Row former').position[2] + byName('Row former').params.width / 2 + 0.01 : null,
        pallet: byName('Build pallet')?.position ?? null,
        arm: byName('Palletizer')?.position ?? null,
        armToolX: byName('Palletizer')?.params?.toolSizeX ?? null,
        armToolZ: byName('Palletizer')?.params?.toolSizeZ ?? null,
        armScale: byName('Palletizer')?.params?.scale ?? null,
        turner: byName('Turning plow')?.position ?? null,
        turnerReach: byName('Turning plow')?.params?.divertDistance ?? null,
      }
    })
    check('cell parts present (row stop, build pallet, palletizer, turning plow)',
      !!(cell.rowStop && cell.pallet && cell.arm && cell.turner), JSON.stringify(cell))
    // The layer stop is a guard on the row former, so what has to hold is that the rail is actually up and its
    // face sits where the layer's far face goes. Down, a pushed row runs off the bed instead of squaring.
    check('the layer squares on the row former\'s side guard', cell.bedGuardUp === true && Math.abs(cell.bedGuardFace - 0.85) < 1e-6,
      `guard up=${cell.bedGuardUp} face=${cell.bedGuardFace?.toFixed(4)}`)
    // The plate footprint is the pickup volume, so a layer-sized plate is what makes this a layer head. Tool size
    // is authored in the arm's own units, so the drawn (and picking) plate is that times the arm's scale.
    const plateX = cell.armToolX * cell.armScale
    const plateZ = cell.armToolZ * cell.armScale
    check('the palletizer is a LAYER head (plate sized to the layer)', plateX >= 1.15 && plateZ >= 0.95,
      `plate=${plateX.toFixed(2)}x${plateZ.toFixed(2)} (tool ${cell.armToolX?.toFixed(2)}x${cell.armToolZ?.toFixed(2)} at scale ${cell.armScale})`)

    // Sampler: rides sim.onFrame and classifies every cargo body each frame by where it is, tracking the
    // stages the cell passes through. Yaw comes off the body quaternion - a "turned" case is one sitting ~90°
    // to the line, which is what the bump turner does.
    await page.evaluate((PALLET) => {
      const sim = window.__oip.sim
      const prior = sim.onFrame
      const s = {
        frames: 0,
        spawned: 0,
        maxX: -Infinity,
        turnedSeen: 0, // cases observed at ~90° anywhere on the line
        packedAtStop: 0, // most cases seen packed in the row envelope at once
        onTable: 0, // most cases seen on the transfer table at once
        layerSeen: false, // 5 cases on the table together
        onPallet: 0, // most cases seen stacked over the pallet at once
        courseSeen: false, // 5 cases on the pallet together
        outfeedSeen: false, // the finished load conveyed out of the cell under its own power
        laneASeen: false, // ...and reached the straight-through staging lane
        laneBSeen: false, // ...or the one the turntable indexes across to
        liftedTogether: 0, // most cases seen airborne between the two stations at once
        watch: null,
        ids: new Set(),
      }
      window.__cell = s
      const yawOf = (x, y, z, w) => Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z))
      sim.onFrame = (f) => {
        prior(f)
        s.frames++
        let onLane = 0 // cases packed in the forming lane's row envelope
        let pushed = 0 // cases parked on the layer stop (the pushed row)
        let layer = 0 // the whole layer footprint
        let pallet = 0
        let air = 0
        for (let i = 0; i < f.count; i++) {
          const px = f.positions[i * 3]
          const py = f.positions[i * 3 + 1]
          const pz = f.positions[i * 3 + 2]
          const hy = f.halfExtents ? f.halfExtents[i * 3 + 1] : 0.2
          if (hy > 0.3) continue // skip pallets + the big staging unit loads; cases are 0.2 half-height
          // Only the line's own cases. The warehouse dressing holds 45 more in the racks, and counting those
          // swamps every number here - so a case is ours only if we first saw it up at the spawner end.
          const id = f.ids[i]
          if (!s.ids.has(id)) {
            if (px > 0.5 || px < -3) continue // first seen elsewhere → warehouse dressing, not something we released
            s.ids.add(id)
          }
          if (px > s.maxX) s.maxX = px
          const yaw = Math.abs(yawOf(f.quats[i * 4], f.quats[i * 4 + 1], f.quats[i * 4 + 2], f.quats[i * 4 + 3]) * 180 / Math.PI)
          const turnedish = Math.abs((yaw % 180) - 90) < 20
          const onBed = py > 0.9 && py < 1.7 && px > 3.1 && px < 4.5
          // the forming lane (where cases arrive and rows build): |z| < 0.35
          if (onBed && Math.abs(pz) < 0.35) onLane++
          // the pushed row's band, held on the layer stop out at +z: 0.3 .. 0.75
          if (onBed && pz > 0.28 && pz < 0.78) pushed++
          // the whole layer footprint: the two bands together, -0.35 .. 0.75
          if (onBed && pz > -0.35 && pz < 0.78) layer++
          if (turnedish && py > 0.9 && py < 1.7 && pz > -0.9 && pz < 0.9) s.turnedSeen++
          // The outfeed. The finished load leaves on the pallet line, so these say the deck actually moved
          // it: past the cell's south fence at all, then onto one of the two staging lanes beyond the turntable.
          if (py > 0.3 && py < 2.1 && pz < -6.6) s.outfeedSeen = true
          if (py > 0.3 && py < 2.1 && pz < -8.85 && px > 3.0 && px < 4.4) s.laneASeen = true
          if (py > 0.3 && py < 2.1 && px > 4.6 && pz > -8.75 && pz < -7.25) s.laneBSeen = true
          // stacked over the pallet
          // The stacking window tracks the authored pallet, and the load is built on a deck, so it starts at
          // the line's height rather than the floor. A hard-coded window silently halves the count when the
          // pallet moves 200 mm, reporting a third of a load as "most on pallet at once" while the cell is in
          // fact stacking fine.
          if (py > PALLET[1] && py < PALLET[1] + 1.5 && Math.abs(pz - PALLET[2]) < 0.55 && Math.abs(px - PALLET[0]) < 0.7) pallet++
          // In the air between the stations, i.e. riding the plate. The layer hangs 0.2 m under the tool and the
          // apex is ~0.7 m over the bed, so a carried case sits around 1.5 m - well clear of one standing on the
          // bed at 1.2 m, but nowhere near the 1.7 m a "shoulder height" guess would ask for.
          if (py > 1.4 && pz < 0.9 && pz > -3.2 && px > 2.8 && px < 4.8) air++
        }
        const table = layer
        const packed = Math.max(onLane, pushed)
        s.pushedSeen = Math.max(s.pushedSeen ?? 0, pushed)
        s.spawned = s.ids.size
        s.packedAtStop = Math.max(s.packedAtStop, packed)
        s.onTable = Math.max(s.onTable, table)
        s.onPallet = Math.max(s.onPallet, pallet)
        s.liftedTogether = Math.max(s.liftedTogether, air)
        if (table >= 5) s.layerSeen = true
        if (pallet >= 5) s.courseSeen = true
        // Snapshot every line case the first time the program calls a layer complete. A layer that comes up short
        // is the cell's main failure mode, and the aggregate counters cannot say where the missing case went -
        // still upstream, stuck on the plow, or pushed off the open side of the bed.
        // One snapshot per course, taken the moment the program calls that layer complete, because the course
        // that comes up short may be the second one, not the first.
        const wNow = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v]))
        const course = wNow?.layerIdx ?? 0
        s.layerSnapshots = s.layerSnapshots ?? {}
        if (wNow?.layerDone === true && !s.layerSnapshots[course]) {
          const snap = []
          for (let i = 0; i < f.count; i++) {
            const hy2 = f.halfExtents ? f.halfExtents[i * 3 + 1] : 0.2
            if (hy2 > 0.3 || !s.ids.has(f.ids[i])) continue
            const yaw2 = Math.abs(yawOf(f.quats[i * 4], f.quats[i * 4 + 1], f.quats[i * 4 + 2], f.quats[i * 4 + 3]) * 180 / Math.PI) % 180
            snap.push({ x: +f.positions[i * 3].toFixed(2), y: +f.positions[i * 3 + 1].toFixed(2), z: +f.positions[i * 3 + 2].toFixed(2), yaw: Math.round(yaw2) })
          }
          snap.sort((a, b) => a.z - b.z || a.x - b.x)
          s.layerSnapshots[course] = { rowsPushed: wNow.rowsPushed, rowSent: wNow.rowSent, rowPhase: wNow.rowPhase, cases: snap }
        }
        if (false) {
          s.layerSnapshot = []
          for (let i = 0; i < f.count; i++) {
            const hy2 = f.halfExtents ? f.halfExtents[i * 3 + 1] : 0.2
            if (hy2 > 0.3 || !s.ids.has(f.ids[i])) continue
            const yaw2 = Math.abs(yawOf(f.quats[i * 4], f.quats[i * 4 + 1], f.quats[i * 4 + 2], f.quats[i * 4 + 3]) * 180 / Math.PI) % 180
            s.layerSnapshot.push({
              x: +f.positions[i * 3].toFixed(2),
              y: +f.positions[i * 3 + 1].toFixed(2),
              z: +f.positions[i * 3 + 2].toFixed(2),
              yaw: Math.round(yaw2),
            })
          }
          s.layerSnapshot.sort((a, b) => a.z - b.z || a.x - b.x)
        }
        const w = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v]))
        if (w) {
          s.watch = { running: w.running, rowPhase: w.rowPhase, rowSent: w.rowSent, layerIdx: w.layerIdx, Step: w.Step, Turn: w.Turn, Shift: w.Shift, layerDone: w.layerDone }
          if (w.Turn === true) s.turnHeld = true
          if (w.Shift === true) s.shiftFired = true
          if ((w.rowPhase ?? 0) >= 1) s.rowPushed = true
          if (w.layerDone === true) s.layerFormed = true
          if ((w.layerIdx ?? 0) >= 1) s.coursePlaced = true
          s.watch.rowsPushed = w.rowsPushed
        }
      }
    }, cell.pallet)

    await page.locator('button.run-button.play').click()
    const running = await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 8000 }).then(() => true).catch(() => false)
    check('sim is running after Play', running)
    await page.waitForTimeout(3000)

    // Give the auto-attach time, then fall back to attaching the program explicitly, from the store (not the editor
    // DOM: CodeMirror virtualizes a long document, so `.cm-content` innerText comes back truncated).
    await page.waitForFunction(() => {
      const wi = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v]))
      return !!wi && 'Infeed' in wi
    }, { timeout: 15000 }).catch(() => {})
    let w = await page.evaluate(() => Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v])))
    if (!w || !('Infeed' in w)) {
      // attach through the program's controller table: the demo's program is two PROGRAMs, and the table picks one
      const ran = await page.evaluate(() => {
        if (!window.__oip.store.getState().stProgram) return false
        window.__oip.controller.attachProgram()
        return true
      })
      console.log(`NOTE  Play did not auto-attach headless; ran the stored program explicitly (${ran ? 'ok' : 'no source found'})`)
      await page.waitForTimeout(1500)
      w = await page.evaluate(() => Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v])))
    }
    // the infeed is transport and runs faster than the row-forming bed it feeds - see InfeedSpeed/RunSpeed in the
    // demo program. What this asserts is that a real speed setpoint is being commanded, not the exact number.
    check('program attached and the line auto-started', !!w && w.running === true && w.Infeed > 0,
      `running=${w?.running} Infeed=${w?.Infeed}`)

    // Let the cell run, printing a progress line every 10 s so a stalled stage is obvious in the log.
    const deadline = Date.now() + SECONDS * 1000
    let last = null
    while (Date.now() < deadline) {
      await page.waitForTimeout(10000)
      last = await page.evaluate(() => {
        const s = window.__cell
        return { frames: s.frames, spawned: s.spawned, maxX: s.maxX, turnedSeen: s.turnedSeen, packedAtStop: s.packedAtStop, pushedSeen: s.pushedSeen, onTable: s.onTable, onPallet: s.onPallet, layerSeen: s.layerSeen, courseSeen: s.courseSeen, outfeedSeen: s.outfeedSeen, laneASeen: s.laneASeen, laneBSeen: s.laneBSeen, liftedTogether: s.liftedTogether, turnHeld: !!s.turnHeld, shiftFired: !!s.shiftFired, rowPushed: !!s.rowPushed, layerFormed: !!s.layerFormed, coursePlaced: !!s.coursePlaced, watch: s.watch, layerSnapshots: s.layerSnapshots ?? null }
      })
      console.log(`  t+${Math.round((SECONDS * 1000 - (deadline - Date.now())) / 1000)}s  spawned=${last.spawned} maxX=${last.maxX?.toFixed(2)} turned=${last.turnedSeen} packed=${last.packedAtStop} pushed=${last.pushedSeen} layer=${last.onTable} pallet=${last.onPallet} air=${last.liftedTogether} | ${JSON.stringify(last.watch)}`)
      // run on past the first course: a cell that lays course 1 cleanly can still short-change course 2, which is
      // where the reset of the row counters actually gets exercised
      // Stop when the load has staged, not when the third course is placed. Breaking at layerIdx >= 3 ends the run
      // the moment the pallet is finished, before it has gone anywhere, so the outfeed checks below could only
      // read false. The pallet leaving is part of the cycle.
      if ((last.laneASeen || last.laneBSeen) && (last.watch?.layerIdx ?? 0) >= 3) break
    }

    const s = last ?? {}
    if (s.layerSnapshot) {
      console.log('\ncases on the line when the program first called the layer complete:')
      for (const c of s.layerSnapshot) console.log(`  x=${c.x} z=${c.z} y=${c.y} yaw=${c.yaw}`)
    }
    // Where the five cases actually came to rest, per course. Reaching the layer stage is not the same as forming
    // a layer the arm can pick: a case a few cm out of place still satisfies every count above, and it is the
    // thing that eventually drops a course off the stack. The pattern is fixed (LAYER_PATTERN) - 2 straight cases
    // 0.6 apart, 3 turned ones 0.4 apart, the two rows 0.5 apart and sharing an x centre - so this measures the
    // layer's own geometry and never where on the lane it happens to sit.
    const TOL = 0.08
    const courses = Object.entries(s.layerSnapshots ?? {})
    let raggedCourses = 0
    for (const [course, snap] of courses) {
      // the snapshot is every line case (so a missing one can be found); the layer is the ones
      // standing in the bed's own footprint, the same window the counters above use
      const all = snap.cases ?? []
      const cases = all.filter((c) => c.y > 0.9 && c.y < 1.7 && c.x > 3.1 && c.x < 4.5 && c.z > -0.35 && c.z < 0.78)
      const turned = cases.filter((c) => Math.abs(c.yaw - 90) < 30)
      const straight = cases.filter((c) => Math.abs(c.yaw - 90) >= 30)
      const spread = (row) => row.map((c) => c.x).sort((a, b) => a - b)
      const gaps = (xs) => xs.slice(1).map((x, i) => +(x - xs[i]).toFixed(3))
      const mid = (row) => row.length ? row.reduce((a, c) => a + c.x, 0) / row.length : NaN
      const zOf = (row) => row.length ? row.reduce((a, c) => a + c.z, 0) / row.length : NaN
      const sGaps = gaps(spread(straight))
      const tGaps = gaps(spread(turned))
      const rowGap = Math.abs(zOf(straight) - zOf(turned))
      const xOffset = Math.abs(mid(straight) - mid(turned))
      const zSlop = Math.max(...cases.map((c) => Math.abs(c.z - zOf(c.yaw > 60 && c.yaw < 120 ? turned : straight))))
      const ok = cases.length === 5 && straight.length === 2 && turned.length === 3 &&
        sGaps.every((g) => Math.abs(g - 0.6) < TOL) && tGaps.every((g) => Math.abs(g - 0.4) < TOL) &&
        Math.abs(rowGap - 0.5) < TOL && xOffset < TOL && zSlop < TOL
      if (!ok) raggedCourses++
      console.log(`\ncourse ${course}: ${cases.length} in the layer footprint (${all.length} line cases anywhere), ` +
        `${straight.length} straight + ${turned.length} turned` +
        `  straight gaps=[${sGaps}] (want 0.6)  turned gaps=[${tGaps}] (want 0.4)` +
        `  row gap=${rowGap.toFixed(3)} (want 0.5)  x centres differ by ${xOffset.toFixed(3)}  worst z slop=${zSlop.toFixed(3)}`)
      for (const c of cases) console.log(`    x=${String(c.x).padEnd(6)} z=${String(c.z).padEnd(6)} yaw=${c.yaw}`)
    }
    check('every completed layer matches the pattern the arm picks blind', courses.length > 0 && raggedCourses === 0,
      `courses measured=${courses.length} ragged=${raggedCourses} tol=${TOL}m`)

    check('cases spawn onto the infeed and convey down it', s.spawned > 0 && s.maxX > 2.0, `spawned=${s.spawned} maxX=${s.maxX?.toFixed(2)}`)
    check('the turning plow is driven out for the turned row (in-browser)', s.turnHeld === true, `turnHeld=${s.turnHeld}`)
    check('the plow actually TURNS a case ~90 degrees', s.turnedSeen > 0, `case-frames seen turned=${s.turnedSeen}`)
    check('cases pack into a row against the stop', s.packedAtStop >= 2, `most packed at once=${s.packedAtStop}`)
    check('the chain transfer pushes a row aside onto the layer stop', s.shiftFired === true && s.rowPushed === true && s.pushedSeen >= 2, `shift=${s.shiftFired} phase advanced=${s.rowPushed} parked on the stop=${s.pushedSeen}`)
    check('two rows make a 5-case layer on the lane', s.layerSeen === true && s.layerFormed === true, `most in the layer footprint=${s.onTable} layerDone=${s.layerFormed}`)
    check('the palletizer lifts the WHOLE layer in one grip (C-multigrab)', s.liftedTogether >= 5, `most airborne at once=${s.liftedTogether}`)
    check('a course lands on the pallet', s.courseSeen === true, `most on pallet at once=${s.onPallet}`)
    check('the finished load conveys itself out of the cell', s.outfeedSeen === true)
    check('...and stages on a lane past the turntable', s.laneASeen || s.laneBSeen,
      `laneA=${s.laneASeen} laneB=${s.laneBSeen}`)

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'layer-palletizer.png') })
    if (errors.length) console.log(`NOTE  ${errors.length} console error(s): ${errors.slice(0, 3).join(' | ')}`)
  } finally {
    await browser.close()
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

try {
  await main()
} finally {
  vite.kill()
}
