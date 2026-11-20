#!/usr/bin/env node
// Two controllers in one scene, one of them a real OpenPLC: the program here runs one line while OpenPLC runs the
// other (src/plc/DEVICE-IO.md, "Several controllers").
//
// The scene is two copies of the conveyor case (scripts/lib/conveyor-loop.mjs). Line A's tags are plain I/O
// addresses (%IX100.0, %QX100.0, %ID100, %QD100), so the default controller runs it: the program attached in-process.
// Line B's are the same addresses on the controller named Cell2 (`Cell2::%IX100.0`, core/io/controllerTag.ts), and
// Cell2 is a named controller served over Modbus TCP to OpenPLC, which runs the same program. Same addresses, two
// PLCs, one scene.
//
// What it runs is the app's own Play path, not a copy of it: the link area (editor/controller/plcLinks.ts
// attachExternalPlc, exchangeLinks) opens Cell2's link from the settings, its table derived from the parts as Cell2
// sees them; the session is the app's (editor/links/externalPlc.ts) on its per-controller host (links/linkHosts.ts);
// the socket is the desktop shell's own plcIo.cjs on link 1 (scripts/lib/desktop-plcio.mjs); ownership goes through
// controller/program.ts; and the sim world holds the program's outputs and the link's in their two layers
// (sim/behaviorBus.ts). Only the React UI and Electron's IPC are left out.
//
// Both lines are judged against the single line run in-process, by the same checks as openplc-loop.
//
// Usage:
//   npm run openplc-loop:cells
//   npm run openplc-loop:cells -- --offline        use only the cached editor sources
//   npm run openplc-loop:cells -- --keep-running   leave a runtime this script started running afterwards
//
// Environment: as scripts/openplc-loop.mjs (OPENPLC_URL, OPENPLC_USER / _PASSWORD, OIP_MODBUS_PORT,
// OIP_SIM_HOST_FOR_PLC).
//
// Exit 0 = both lines behaved as in-process; 1 = it ran and did not; 2 = it could not run.
/* global process, performance */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { behaviourChecks, conveyorCase, describeRun, flattenTags, HZ, loadOurs, POLL_MS, report, runLocal, runnable as loopRunnable, SCAN_MS, SECONDS, sleep, Trace } from './lib/conveyor-loop.mjs'
import { desktopPlcIo } from './lib/desktop-plcio.mjs'
import { buildProgramZip as buildZip, deployStopped, openRuntime, remoteDevice } from './lib/openplc-deploy.mjs'
import { EDITOR, ensureDeps, ensureEditorSources, HarnessError, loadEditor, setOffline, UPLOAD_ENTRIES, WORK } from './lib/openplc-editor.mjs'

const argv = process.argv.slice(2)
setOffline(argv.includes('--offline'))
const keepRunning = argv.includes('--keep-running')
const OUT = join(WORK, 'cells-loop')

const CELL = 'Cell2'
const PORT = Number(process.env.OIP_MODBUS_PORT ?? 5020)
const POINTS = { eye: '%IX100.0', run: '%QX100.0', range: '%ID100', speed: '%QD100' }
/** line A, and the program both controllers run */
const CASE = conveyorCase(POINTS)
const onCell = (tag) => `${CELL}::${tag}`
/** line B: the same parts 2.5 m over, with every tag on Cell2 */
const LINE_B = CASE.parts.map((p) => ({
  ...p,
  id: `${p.id}B`,
  position: [p.position[0], p.position[1], p.position[2] + 2.5],
  params: Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('%') ? onCell(v) : v])),
}))
const PARTS = [...CASE.parts, ...LINE_B]
const POINTS_B = Object.fromEntries(Object.entries(POINTS).map(([k, v]) => [k, onCell(v)]))

/** FC2 x328, FC15 x328 -> { 2: 328, 15: 328 } */
function requestCounts(text) {
  const out = {}
  for (const m of String(text).matchAll(/FC(\d+) x(\d+)/g)) out[Number(m[1])] = Number(m[2])
  return out
}

async function main() {
  console.log(`OpenPLC as a second controller - editor ${EDITOR.repo}@${EDITOR.sha.slice(0, 8)}`)
  mkdirSync(WORK, { recursive: true })
  await ensureEditorSources(UPLOAD_ENTRIES)
  const { strucppVersion } = await ensureDeps()
  const ours = await loadOurs({
    tags: '/src/core/io/controllerTag.ts',
    links: '/src/editor/controller/plcLinks.ts',
    program: '/src/editor/controller/program.ts',
    prefs: '/src/editor/store/storePrefs.ts',
    ext: '/src/editor/links/externalPlc.ts',
  })
  const editor = await loadEditor(UPLOAD_ENTRIES)
  const { tags, links, program, prefs, ext } = ours.more

  // this computer's settings: the program here is the default controller, and Cell2 a PLC that polls the simulator
  const settings = prefs.sanitizeExternalPlc({ enabled: false, controllers: [{ name: CELL, enabled: true, mode: 'serve', port: PORT, network: false }] })

  // what each controller is handed. Cell2's table is the single line's, under the names Cell2 knows them by
  const runnable = loopRunnable(ours, CASE)
  const declared = new ours.LocalPlcLink(runnable)
  const plcLink = declared.withBindings(ours.wiredBindings(PARTS, declared))
  const wiring = ours.checkWiring(PARTS, plcLink)
  const broken = wiring.problems.filter((p) => p.severity === 'error')
  if (broken.length > 0) throw new HarnessError(`the two-line scene's wiring is broken:\n  ${broken.map((p) => `${p.tag}: ${p.message}`).join('\n  ')}`)
  const cellView = ext.deriveExternalIo(tags.partsForController(PARTS, CELL), settings.controllers[0])
  if (cellView.problems.length > 0) throw new HarnessError(`Cell2's table has problems:\n  ${cellView.problems.join('\n  ')}`)
  const single = ext.deriveExternalIo(CASE.parts, settings.controllers[0]).io
  console.log(`  ${CELL}:       ${cellView.io.points.map((p) => `${p.tag} = ${p.area} ${p.address}`).join(', ')}`)

  const local = runLocal(ours, CASE).summary()
  console.log(describeRun('in-process', local))
  if (local.eye === null || local.runOff === null) throw new HarnessError('the scene itself is broken: with the program attached in-process the box never reached the eye')

  const exported = ours.exportProgram(runnable, 'iec-text', { scanMs: SCAN_MS, projectName: 'openplc-cells-loop' })
  if (exported.warnings.length > 0) throw new HarnessError(`our exporter reports losses on the loop program:\n  ${exported.warnings.join('\n  ')}`)
  const text = ours.renderIecText(runnable, { scanMs: SCAN_MS, banner: false })
  const device = remoteDevice(ours, cellView.io, process.env.OIP_SIM_HOST_FOR_PLC ?? '127.0.0.1', POLL_MS)
  const built = buildZip(ours, editor, { text, device, locations: cellView.io.points.map((p) => p.tag), outDir: OUT })
  console.log(`  program:     built by the editor with STruC++ ${strucppVersion}, ${built.files} files in program.zip (${OUT})`)

  const runtime = await openRuntime({ outDir: OUT, keepRunning })
  const shell = desktopPlcIo()
  const world = new ours.SimWorld(ours.Jolt, { version: ours.SCENE_VERSION, parts: PARTS }, { hz: HZ })
  const l = new links.PlcLinkState()
  try {
    const deployed = await deployStopped(runtime, built.zip)
    console.log(`  runtime:     OpenPLC ${deployed.version} at ${runtime.source}`)
    if (deployed.created) console.log(`               (it had no accounts: created "${deployed.user}" as its first, admin, account)`)
    console.log(`               uploaded and built in ${deployed.seconds.toFixed(1)} s`)

    // Play: the program attaches for the default controller, and the link area opens Cell2's link beside it
    const sim = { setDrivenTags: (t) => world.setBehaviorDrivenTags(t), beginStepping: () => {} }
    const p = new program.ProgramState()
    program.setDriven(p, sim, plcLink.outputs)
    const ctl = new ours.SimController(plcLink)
    const scheduler = new ours.TaskScheduler(ctl, { periodSec: SCAN_MS / 1000, maxCatchUp: ours.MAX_SCANS_PER_STEP })
    const ec = {
      store: { getState: () => ({ externalPlc: settings, scene: { parts: PARTS }, timeScale: 1, running: true }) },
      sim,
      lastFrame: world.frame(),
      plcWatch: null,
      runSerial: 1,
      plcIoHost: shell.host,
      opcUaHost: null,
      eipHost: null,
      adsHost: null,
      opcUaServerHost: null,
      setTimeScale: () => {},
    }
    links.attachExternalPlc(l, p, ec, ext)
    for (const until = performance.now() + 5000; links.namedStatus(l, CELL).state !== 'listening'; await sleep(20)) {
      if (performance.now() > until) throw new HarnessError(`${CELL}'s link did not open: ${links.namedStatus(l, CELL).error ?? links.namedStatus(l, CELL).state}`)
    }
    const listened = shell.calls.filter((c) => c.call === 'listen')
    console.log(`  simulator:   ${CELL} served on 127.0.0.1:${PORT} (shell link ${listened.map((c) => c.link).join(', ')}), the program here on line A, ${SECONDS} s of wall-clock time`)
    await runtime.client.start()
    await runtime.client.waitStatus('RUNNING')

    // the run, at wall-clock speed, as the app steps it: the program's scans, then every link's exchange, then a step
    const traceA = new Trace(CASE.points)
    const traceB = new Trace(POINTS_B, 'boxB')
    const total = SECONDS * HZ
    let worldTags = flattenTags(world.frame().tags)
    let plcOut = {}
    let steps = 0
    let worstLagMs = 0
    const t0 = performance.now()
    while (steps < total) {
      const now = performance.now()
      const due = Math.min(total, Math.floor(((now - t0) / 1000) * HZ))
      worstLagMs = Math.max(worstLagMs, now - t0 - (steps / HZ) * 1000)
      while (steps < due) {
        ctl.setExternalInputs(worldTags)
        if (scheduler.advance(1 / HZ).scans > 0) plcOut = { ...ctl.processImage.outputs }
        world.setBehaviorInputTags(plcOut)
        const out = links.exchangeLinks(l, worldTags)
        if (out) world.setBehaviorLinkTags(out)
        world.step()
        const frame = world.frame()
        worldTags = flattenTags(frame.tags)
        steps++
        traceA.add(steps / HZ, { ...worldTags, ...plcOut }, frame)
        traceB.add(steps / HZ, { ...worldTags, ...l.linkOut }, frame)
      }
      await sleep(2) // the socket is served in between
    }

    const cell = links.namedStatus(l, CELL)
    const status = (await runtime.client.status()).status
    const a = traceA.summary()
    const b = traceB.summary()
    console.log(describeRun('line A', a))
    console.log(describeRun(`line B`, b))
    console.log(`               ${CELL}'s master requests: ${cell.requests}; PLC status at the end: ${status}; worst step lag ${worstLagMs.toFixed(0)} ms`)
    const n = requestCounts(cell.requests)
    const driven = [...p.drivenKeys].sort()
    const want = [...plcLink.outputs, ...plcLink.outputs.map(onCell)].sort()

    const checks = [
      [`${CELL}'s link opened on its own link of the shell`, listened.length === 1 && listened[0].link === 1 && listened[0].port === PORT, JSON.stringify(listened)],
      [`${CELL} is handed the single line's table, under its own names`, JSON.stringify(cellView.io.points) === JSON.stringify(single.points), `${cellView.io.points.length} points`],
      ["the wiring check does not hold Cell2's tags against the program here", !wiring.problems.some((x) => x.tag.startsWith(`${CELL}::`) && (x.kind === 'undriven' || x.kind === 'unread')), `${wiring.problems.length} problem(s) in all`],
      ['OpenPLC polled the inputs and wrote the coils', (n[2] ?? 0) > 0 && (n[15] ?? 0) + (n[5] ?? 0) > 0, cell.requests],
      ['OpenPLC read the laser as a REAL and commanded a speed', (n[4] ?? 0) > 0 && (n[16] ?? 0) + (n[6] ?? 0) > 0, cell.requests],
      ['the program here and OpenPLC each own their own outputs', JSON.stringify(driven) === JSON.stringify(want), driven.join(', ')],
      ...behaviourChecks(local, a).map(([what, ok, detail]) => [`line A, the program here: ${what}`, ok, detail]),
      ...behaviourChecks(local, b).map(([what, ok, detail]) => [`line B, ${CELL} on OpenPLC: ${what}`, ok, detail]),
      [`${CELL}'s link was live at the end`, cell.state === 'listening' && !cell.stale, `${cell.state}${cell.stale ? ', stale' : ''}`],
      ['the PLC was still running at the end', String(status).includes('RUNNING'), String(status)],
    ]
    const failed = report(checks)
    console.log(failed === 0 ? '\nBoth lines behave as in-process: the program here on one, OpenPLC on the other.' : `\n${failed} check(s) failed. Runtime log: ${join(OUT, 'runtime.log')}`)
    return failed === 0 ? 0 : 1
  } finally {
    links.detachExternalPlc(l)
    shell.close()
    world.dispose()
    await runtime.client.stop().catch(() => {})
    runtime.stop()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof HarnessError ? `\nharness: ${e.message}` : e)
    process.exit(2)
  },
)
