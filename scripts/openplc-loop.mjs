#!/usr/bin/env node
// A real PLC in the loop: an ST program written for the simulator, built by OpenPLC's own editor code,
// uploaded to a real OpenPLC Runtime v4, and driving the simulated conveyor over Modbus TCP.
//
// What it proves: every other PLC check runs the program on our engine, and this one runs it elsewhere. A box
// rides towards a photo eye on %IX100.0, the PLC's scan decides, and %QX100.0 stops the belt. The box
// must rest where it does with the program attached in-process, which is the product claim itself.
//
// Analog too: a laser's distance goes in as a REAL and the belt's speed comes back as one (IEEE754, low
// word first, measured rather than assumed: core/io/externalIo.ts). The case is shared with
// scripts/s7-loop.mjs (scripts/lib/conveyor-loop.mjs), so the two controllers are judged alike.
//
// What runs where:
//   the simulator   headless (the project-test runner's SimWorld), stepped at wall-clock speed, because a
//                   real PLC scans on its own clock
//   the wiring      the parts' tags are the I/O addresses, the program's variables are located at them
//                   (docs/st-conformance.md, Located variables), and the Modbus map follows from the
//                   addresses alone (core/io/externalIo.ts, modbusServerFromTags): nothing is mapped by hand
//   the link        src/plc/link/modbusServer.ts behind a TCP socket: the simulator is the Modbus SERVER and
//                   the PLC polls it (core/io/externalIo.ts says why it is that way round)
//   the program     exported the way the editor's Export does, loaded by OpenPLC's editor as a project
//                   folder (the AT clauses become its own variable locations), transpiled and built with
//                   STruC++, and packed into program.zip by the editor's own bundle composer
//                   (scripts/lib/openplc-editor.mjs, the pin the ST oracle uses)
//   the PLC         OPENPLC_URL if set (CI: the runtime's container). Otherwise the per-user Windows
//                   install from the runtime's GitHub release, started for the run and stopped after it.
//
// Timing is measured, not exact: one poll and one scan of latency, allowed for and printed
// (scripts/lib/conveyor-loop.mjs).
//
// Usage:
//   npm run openplc-loop
//   npm run openplc-loop -- --offline        use only the cached editor sources
//   npm run openplc-loop -- --keep-running   leave a runtime this script started running afterwards
//
// Environment:
//   OPENPLC_URL              use this runtime instead of the local install (https://host:8443)
//   OPENPLC_USER / _PASSWORD its login; on a runtime with no accounts yet, created as its first (admin)
//                            account. Default openplc / openplc.
//   OIP_MODBUS_PORT          the port the simulator serves on (default 5020)
//   OIP_SIM_HOST_FOR_PLC     how the PLC reaches the simulator (default 127.0.0.1)
//
// Exit 0 = the loop closed and matched; 1 = it ran and did not match; 2 = it could not run.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { behaviourChecks, conveyorCase, describeRun, loadOurs, POLL_MS, report, runExternal, runLocal, runnable as loopRunnable, SCAN_MS, sceneTags, SECONDS } from './lib/conveyor-loop.mjs'
import { listenModbus } from './lib/modbus-tcp-listen.mjs'
import { buildProgramZip as buildZip, deployStopped, openRuntime, remoteDevice } from './lib/openplc-deploy.mjs'
import { EDITOR, ensureDeps, ensureEditorSources, HarnessError, loadEditor, setOffline, UPLOAD_ENTRIES, WORK } from './lib/openplc-editor.mjs'

const argv = process.argv.slice(2)
setOffline(argv.includes('--offline'))
const keepRunning = argv.includes('--keep-running')
const OUT = join(WORK, 'loop')

/** The case, wired from %IX100.0, %QX100.0, %ID100 and %QD100 up: the device file this script writes places each point
 *  explicitly, so any base works (OpenPLC's Editor numbers a new device from %IX0.0; guides/modbus/ follows that one). */
const CASE = conveyorCase({ eye: '%IX100.0', run: '%QX100.0', range: '%ID100', speed: '%QD100' })

/** Where the simulator serves Modbus. The points are not listed: they follow from the parts' addresses. */
const SERVER = { host: '127.0.0.1', port: Number(process.env.OIP_MODBUS_PORT ?? 5020) }

// ---- the program, as OpenPLC's editor builds it ----

async function buildProgramZip(ours, editor, io) {
  const runnable = loopRunnable(ours, CASE)
  const exported = ours.exportProgram(runnable, 'iec-text', { scanMs: SCAN_MS, projectName: 'openplc-loop' })
  if (exported.warnings.length > 0) throw new HarnessError(`our exporter reports losses on the loop program:\n  ${exported.warnings.join('\n  ')}`)
  const text = ours.renderIecText(runnable, { scanMs: SCAN_MS, banner: false })
  const device = remoteDevice(ours, io, process.env.OIP_SIM_HOST_FOR_PLC ?? '127.0.0.1', POLL_MS)
  // the AT clauses are the program's I/O: its reader must have taken each one as a variable's location
  return buildZip(ours, editor, { text, device, locations: io.points.map((p) => p.tag), outDir: OUT })
}

// ---- main ----

async function main() {
  console.log(`OpenPLC in the loop - editor ${EDITOR.repo}@${EDITOR.sha.slice(0, 8)}`)
  mkdirSync(WORK, { recursive: true })
  await ensureEditorSources(UPLOAD_ENTRIES)
  const { strucppVersion } = await ensureDeps()
  const [ours, editor] = [await loadOurs(), await loadEditor(UPLOAD_ENTRIES)]

  // the wiring the scene declares, and the Modbus table that follows from its addresses
  const derived = ours.modbusServerFromTags(SERVER, sceneTags(ours, CASE))
  if (derived.problems.length > 0) throw new HarnessError(`an address cannot travel over Modbus:\n  ${derived.problems.map((p) => `${p.tag}: ${p.message}`).join('\n  ')}`)
  const checked = ours.validateExternalIo(derived.io)
  if (!checked.ok) throw new HarnessError(`the derived I/O table is invalid:\n  ${checked.errors.join('\n  ')}`)
  console.log(`  wiring:      ${checked.io.points.map((p) => `${p.tag} = ${p.area} ${p.address}`).join(', ')}`)

  const local = runLocal(ours, CASE).summary()
  console.log(describeRun('in-process', local))
  if (local.eye === null || local.runOff === null) throw new HarnessError('the scene itself is broken: with the program attached in-process the box never reached the eye')

  const built = await buildProgramZip(ours, editor, checked.io)
  console.log(`  program:     built by the editor with STruC++ ${strucppVersion}, ${built.files} files in program.zip (${OUT})`)

  const runtime = await openRuntime({ outDir: OUT, keepRunning })
  let server = null
  const io = new ours.ModbusServerIo(checked.io)
  try {
    const deployed = await deployStopped(runtime, built.zip)
    console.log(`  runtime:     OpenPLC ${deployed.version} at ${runtime.source}`)
    if (deployed.created) console.log(`               (it had no accounts: created "${deployed.user}" as its first, admin, account)`)
    console.log(`               uploaded and built in ${deployed.seconds.toFixed(1)} s`)

    server = await listenModbus(io, checked.io)
    console.log(`  simulator:   Modbus TCP server on ${checked.io.host}:${checked.io.port}, running ${SECONDS} s of wall-clock time`)
    const ext = await runExternal(ours, CASE, io, {
      drivenTags: ours.externalDrivenTags(checked.io),
      startPlc: async () => {
        await runtime.client.start()
        await runtime.client.waitStatus('RUNNING')
      },
    })
    const status = (await runtime.client.status()).status
    const remote = ext.trace.summary()
    console.log(describeRun('OpenPLC', remote))
    console.log(`               master requests: ${ours.describeStats(io.stats)}; PLC status at the end: ${status}; worst step lag ${ext.worstLagMs.toFixed(0)} ms`)

    const checks = [
      // the link: the PLC is the master here, so what it asked for is what proves it polled
      ['the PLC polled the simulator\'s inputs', (io.stats.requests[2] ?? 0) > 0, `${io.stats.requests[2] ?? 0} FC2 reads`],
      ['the PLC wrote the simulator\'s coils', (io.stats.requests[15] ?? 0) + (io.stats.requests[5] ?? 0) > 0, `${(io.stats.requests[15] ?? 0) + (io.stats.requests[5] ?? 0)} coil writes`],
      [
        'the PLC read the laser as a REAL and commanded a speed',
        (io.stats.requests[4] ?? 0) > 0 && (io.stats.requests[16] ?? 0) + (io.stats.requests[6] ?? 0) > 0,
        `${io.stats.requests[4] ?? 0} FC4 reads, ${(io.stats.requests[16] ?? 0) + (io.stats.requests[6] ?? 0)} register writes`,
      ],
      ...behaviourChecks(local, remote),
      ['the PLC was still running at the end', String(status).includes('RUNNING'), String(status)],
    ]
    const failed = report(checks)
    console.log(failed === 0 ? '\nThe program behaves the same on OpenPLC as in the simulator.' : `\n${failed} check(s) failed. Runtime log: ${join(OUT, 'runtime.log')}`)
    return failed === 0 ? 0 : 1
  } finally {
    await runtime.client.stop().catch(() => {})
    await server?.close()
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
