// No spawner may emit while its own gate tag reads shut. This checks when the world starts stepping.
//
// `setDrivenTags` and `runProgram` are posted to the sim worker after `start`. If a world starts stepping
// as soon as it is built, it runs its first behavior tick with an empty driven set. Every wired part resolves its
// mode as `tagDriven(tag) ? readTag(tag) : <authored state>`, so for that one frame each part
// reads its authored state instead of the program's. For a conveyor that is one frame of motion nobody sees.
// For a spawner it is a body that stays in the scene. The demo's pallet magazine was gated on PalletFeed, so
// "not driven yet" read as "not held", and it dispensed a pallet into the finished load on the build deck on
// every run. That load then travelled the whole route and went onto a rack shelf with a pallet through its
// middle, one course up, in plain view. No gate failed: verify-agv-rack-putaway counted 17 bodies where a
// load has 16 and passed, because its check was `>= 16`. The fix is in the ordering (SimClient.start's
// `deferStepping` + `beginStepping`).
//
// This gate does not assert "nothing spawns on frame 1". The PLC's scans interleave with the physics steps
// in-worker, so a program that assigns its feed tag unconditionally (the demo's
// `SpawnRun := safe AND NOT layerDone AND ...`) can correctly open a gate before the first frame is
// published, and the case source does emit on frame 1 by design. The invariant is: a body may only be
// created while the tag gating its spawner is open. A spawned body is identifiable: the frame carries
// `partIds[i] === null` for a transient spawner body and a real scene part id for everything authored or
// promoted (core/frame.ts). On the frame it is created it is still at its spawner, so it can be attributed
// by position.
//
// The positive control matters as much as the assertion: a world that never steps spawns nothing and would
// pass, and deferring the step loop is the change that could leave a world never stepping.
//   node e2e/verify-no-spawn-before-attach.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

// long enough for the flex to back up and shut the case source's gate at least once. The case source fires in
// the first second
const WATCH_MS = 45000
// a newborn body is still at its spawner; the demo's two are ~5 m apart, so this cannot mis-attribute
const ATTRIBUTE_M = 1.5
/**
 * How far either side of a birth a tag may be observed open for that birth to count as gated.
 *
 * A body created exactly on the rising edge is the normal case: the spawner clamps its countdown at zero
 * while held (examples/parts/box-spawner/behavior.ts), so the first eligible tick after the gate reopens
 * emits immediately. The grace covers the delay between the body showing up and the tag's rise showing up.
 * Body positions are in every published frame (~17 ms), while the variable table is in one frame in ten
 * (sim/plcHost.ts WATCH_HZ = 10, and client.ts repeats the last one in between), so a rise can appear up to
 * 100 ms after the birth it allowed. Measured on the demo, every disagreement was this: births at
 * 7.98 / 15.78 / 22.65 / 33.38 s whose gate read open 0.017 / 0.067 / 0.10 / 0.10 s later
 * (e2e/probes/spawn-gate-series.mjs).
 *
 * A grace that only looks backward (0.15 s or any other width) can never accept any of those four, so it
 * looks forward too, and the verdict is computed after the run.
 * 0.25 s is 1/WATCH_HZ plus a couple of frames of margin; the bug's own delay is ~15 s.
 */
const EDGE_GRACE_S = 0.25

const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.sim), { timeout: 60000 })
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

    // every comms-gated spawner in the scene, read off the scene rather than typed here
    const spawners = await page.evaluate(() => window.__oip.store.getState().scene.parts
      .filter((p) => (p.packageId === 'oip.box-spawner' || p.packageId === 'oip.pallet-spawner') && p.params?.runTag)
      .map((p) => ({ name: p.name ?? p.packageId, tag: p.params.runTag, x: p.position[0], y: p.position[1], z: p.position[2] })))
    console.log(`comms-gated spawners: ${spawners.map((s) => `${s.name}[${s.tag}]`).join(', ') || '(none)'}`)
    // Only one: the demo's pallets come from a dispenser fed by a supply truck, which releases authored stock
    // rather than spawning, so the case source (LoadFlex) is the demo's only comms-gated spawner. Its gate is
    // `safe AND NOT FlexFull`, so it shuts whenever the flex backs up. The "gate was observed SHUT" check below
    // is what makes one spawner enough.
    check('the demo has a comms-gated spawner to judge', spawners.length >= 1, `${spawners.length} found`)

    // hook before run(): the offending body is created during frame 1 itself
    await page.evaluate(({ spawners, ATTRIBUTE_M }) => {
      const sim = window.__oip.sim, prior = sim.onFrame
      const seen = new Set()
      // every simTime each gate was observed open. Kept as a list rather than a "last seen", because the
      // verdict has to look forward from a birth (see EDGE_GRACE_S), which isn't known yet.
      window.__openAt = Object.fromEntries(spawners.map((s) => [s.tag, []]))
      // ...and how many frames each read shut: a gate that never shuts makes "born while open" vacuous
      window.__shutFrames = Object.fromEntries(spawners.map((s) => [s.tag, 0]))
      window.__births = []

      window.__simTime = 0
      let first = true
      sim.onFrame = (f) => {
        prior(f)
        window.__simTime = f.simTime
        const w = Object.fromEntries(Object.entries(window.__oip.controller.plcWatch ?? {}).map(([k, v]) => [k.replace(/^Main\./, ''), v]))
        for (const s of spawners) {
          if (w[s.tag] === true) window.__openAt[s.tag].push(f.simTime)
          else if (w[s.tag] === false) window.__shutFrames[s.tag]++
        }
        for (let i = 0; i < f.count; i++) {
          if (f.partIds[i] !== null && f.partIds[i] !== undefined) continue // authored or promoted, not spawned
          const id = f.ids[i]
          if (seen.has(id)) continue
          seen.add(id)
          // a newborn is still at its spawner, so the nearest one is the one that made it
          const x = f.positions[i * 3], y = f.positions[i * 3 + 1], z = f.positions[i * 3 + 2]
          let owner = null, best = Infinity
          for (const s of spawners) {
            const d = Math.hypot(s.x - x, s.y - y, s.z - z)
            if (d < best) { best = d; owner = s }
          }
          const attributed = owner && best <= ATTRIBUTE_M ? owner : null
          window.__births.push({
            simTime: +f.simTime.toFixed(3), id, kind: f.kinds[i] === 1 ? 'pallet' : 'box',
            at: [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)],
            spawner: attributed ? attributed.name : '(unattributed)', tag: attributed ? attributed.tag : null,
            tagValue: attributed ? w[attributed.tag] ?? null : null, firstFrame: first,
          })
        }
        first = false
      }
    }, { spawners, ATTRIBUTE_M })

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(WATCH_MS)

    // the whole run is recorded, so a birth can be checked against its gate on both sides
    const { births: raw, openAt, shutFrames } = await page.evaluate(() => ({ births: window.__births, openAt: window.__openAt, shutFrames: window.__shutFrames }))
    const births = raw.map((b) => ({
      ...b,
      open: b.tag === null ? null : (openAt[b.tag] ?? []).some((t) => Math.abs(t - b.simTime) <= EDGE_GRACE_S),
    }))
    console.log(`\nbodies born in the first ${WATCH_MS / 1000}s: ${births.length}`)
    for (const b of births.slice(0, 12)) console.log(`  ${JSON.stringify(b)}`)
    if (births.length > 12) console.log(`  ...and ${births.length - 12} more`)

    const shut = births.filter((b) => b.open === false)
    check('every spawned body was born with its spawner\'s gate OPEN', shut.length === 0,
      shut.length ? `${shut.length} born on a shut gate, first: ${JSON.stringify(shut[0])}` : `${births.length} births, all gated`)
    const orphans = births.filter((b) => b.open === null)
    check('every spawned body came from a spawner this gate can see', orphans.length === 0,
      orphans.length ? `${orphans.length} unattributed, first: ${JSON.stringify(orphans[0])}` : '')

    // The check above can only fail if some gate read shut during the watch. A line whose gate never
    // closes passes it whatever the spawner does.
    const everShut = Object.entries(shutFrames).filter(([, n]) => n > 0)
    check('a spawner gate was observed SHUT during the run (so the check above can fail)', everShut.length > 0,
      Object.entries(shutFrames).map(([t, n]) => `${t}: ${n} shut frames`).join(', '))

    // Positive control: a world that never steps spawns nothing and passes everything above.
    check('the cell actually ran (bodies were spawned at all)', births.length > 0, `${births.length} births`)
    const simTime = await page.evaluate(() => window.__simTime)
    check('the world is still stepping', simTime > 1, `simTime ${simTime.toFixed(1)}s`)

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
