#!/usr/bin/env node
// AN S7 SERVER IN THE LOOP: the conveyor case (scripts/lib/conveyor-loop.mjs) over S7 PUT/GET, the simulator a
// client of snap7's S7 server, which plays an S7-1200/1500's communication stack.
//
// What it proves: that the app's S7 link (src/editor/links/s7Link.ts over src/plc/link/s7Client.ts, on a real TCP socket)
// speaks S7 as an implementation nobody here wrote understands: snap7 (C, via python-snap7 2.x) accepts our COTP
// connect and PDU negotiation, multi-item writes land in the bytes the addresses name, BIT writes leave the rest
// of their byte alone, and REALs cross big-endian both ways. The box only rests where it does in-process if every
// byte made the trip.
//
// What it does not prove: snap7 is not a Siemens CPU: it enforces no PUT/GET setting, rack/slot, protection level
// or item limits, and runs no program, so the program is transcribed into Python over the server's memory
// (scripts/lib/s7-plc.py). Unit tests hold the client to a stricter fake CPU (src/plc/link/s7FakeCpu.ts); only a real
// CPU, or PLCSIM Advanced, proves those points. Until then the S7 link is "verified against snap7".
//
// What runs where:
//   the simulator   headless, stepped at wall-clock speed, its S7 session polling every CLIENT_POLL_MS
//   the PLC         python scripts/lib/s7-plc.py: snap7's server on 127.0.0.1:<port>, scanning every SCAN_MS
//
// The addresses are an S7 program's: the eye at I80.4 (as oip-comms' S7 driver notes suggest, clear of a real
// input card), the belt's run bit at Q80.0, the laser's distance at ID84 and the speed command at QD84.
//
// Usage:
//   npm run s7-loop
//   npm run s7-loop -- --db     the two REALs in a data block (DB10.DBD0 in, DB10.DBD4 out) instead of ID84 / QD84
//
// Environment:
//   OIP_PYTHON        the Python to run (default: python)
//   OIP_S7_SNAP7      a folder holding python-snap7 2.x (default: .s7-loop/snap7, if it exists). The loop needs
//                     2.x: 3.x is a pure-Python rewrite whose server writes only a job's first item and a bit as
//                     its whole byte. Install it there with
//                       python -m pip install --target .s7-loop/snap7 python-snap7==2.0.2
//   OIP_S7_PORT       the port the server listens on (default 1102; 102 is a CPU's, and may be taken)
//
// Exit 0 = the loop closed and matched; 1 = it ran and did not match; 2 = it could not run.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { behaviourChecks, conveyorCase, CREEP, CREEP_WITHIN_M, describeRun, FAST, HarnessError, loadOurs, report, ROOT, runExternal, runLocal, SCAN_MS, SECONDS, sleep } from './lib/conveyor-loop.mjs'
import { nodePlcIoHost } from './lib/plc-io-host.mjs'

const PORT = Number(process.env.OIP_S7_PORT ?? 1102)
const PYTHON = process.env.OIP_PYTHON ?? 'python'
const SNAP7 = process.env.OIP_S7_SNAP7 ?? (existsSync(join(ROOT, '.s7-loop', 'snap7')) ? join(ROOT, '.s7-loop', 'snap7') : null)

const DB = process.argv.includes('--db')
/** the scene in-process: the program's variables located at these I/O addresses */
const CASE = conveyorCase({ eye: '%IX80.4', run: '%QX80.0', range: '%ID84', speed: '%QD84' })
/**
 * the scene against the CPU: the same, or with the two REALs in DB10 (--db). A data block is not an IEC address, so
 * the program here cannot locate a variable in one: the in-process run keeps ID84 / QD84, one scene spelled two ways.
 */
const REMOTE = DB ? conveyorCase({ eye: '%IX80.4', run: '%QX80.0', range: 'DB10.DBD0', speed: 'DB10.DBD4' }) : CASE
const REAL_AT = DB ? { range: { area: 'DB', db: 10, byte: 0 }, speed: { area: 'DB', db: 10, byte: 4 } } : { range: { area: 'I', byte: 84 }, speed: { area: 'Q', byte: 84 } }

/** Start the PLC side and wait for it to listen. Resolves with what the loop needs to end it and read its report. */
async function startPlc() {
  const args = JSON.stringify({ port: PORT, scanMs: SCAN_MS, eye: [80, 4], run: [80, 0], range: REAL_AT.range, speed: REAL_AT.speed, fast: FAST, creep: CREEP, creepWithin: CREEP_WITHIN_M })
  const env = { ...process.env, PYTHONUTF8: '1', ...(SNAP7 ? { PYTHONPATH: [SNAP7, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') } : {}) }
  const child = spawn(PYTHON, [join(ROOT, 'scripts', 'lib', 's7-plc.py'), args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const messages = []
  const waiters = []
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    messages.push(msg)
    waiters.splice(0).forEach((w) => w())
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  const next = async (pred, seconds, what) => {
    const deadline = performance.now() + seconds * 1000
    for (;;) {
      const found = messages.find(pred)
      if (found) return found
      const failed = messages.find((m) => m.error)
      if (failed) throw new HarnessError(failed.error)
      if (child.exitCode !== null || performance.now() > deadline) {
        const hint = /No module named 'snap7'/.test(stderr) ? '\n  python-snap7 is not installed: python -m pip install --target .s7-loop/snap7 python-snap7==2.0.2' : ''
        throw new HarnessError(`the S7 server did not ${what}${stderr ? `:\n${stderr.trim()}` : ''}${hint}`)
      }
      await Promise.race([new Promise((r) => waiters.push(r)), exited, sleep(200)])
    }
  }
  child.on('error', () => {})
  await next((m) => m.ready, 15, 'start')
  return {
    async end() {
      child.stdin.end()
      return next((m) => m.end, 15, 'report')
    },
    kill: () => child.kill(),
  }
}

/** The app's S7 session over a real socket, with runExternal's two calls on its one. */
function s7Session(ours) {
  // each tag with how many parts write it, as the dock derives it (editor/links/externalPlc.ts deriveS7Io)
  const wiring = ours.checkWiring(REMOTE.parts)
  const tags = wiring.tags.map((t) => ({ name: t.name, type: t.type, writers: t.writers.length }))
  const { io, problems } = ours.s7ClientFromTags({ host: '127.0.0.1', port: PORT, rack: 0, slot: 1 }, tags)
  if (problems.length > 0) throw new HarnessError(`an address cannot travel over S7:\n  ${problems.map((p) => `${p.tag}: ${p.message}`).join('\n  ')}`)
  const session = new ours.ExternalPlcS7Session(nodePlcIoHost(), io, [], () => {})
  let pending = {}
  let last = {}
  let started = false
  return {
    io,
    session,
    wiring: io.points.map(ours.describeS7Point).join(', '),
    drivenTags: ours.s7DrivenTags(io),
    link: {
      writeSimTags(t) {
        if (!started) {
          pending = { ...pending, ...t }
          return
        }
        const out = session.exchange(t)
        if (out) last = out
      },
      plcTags: () => last,
    },
    async start() {
      await session.start(pending)
      started = true
      const until = performance.now() + 5000
      while (session.status().state !== 'polling' && performance.now() < until) await sleep(50)
      const st = session.status()
      if (st.state !== 'polling') throw new HarnessError(`the simulator could not set up a connection with the S7 server: ${st.error ?? st.state}`)
      console.log(`               connected to ${st.endpoint}, PDU ${session.poller.pdu} bytes`)
    },
  }
}

async function main() {
  console.log(`An S7 server in the loop (snap7), over S7 PUT/GET${DB ? ', the REALs in DB10' : ''}`)
  const ours = await loadOurs()
  const s7 = s7Session(ours)
  console.log(`  wiring:      ${s7.wiring}`)

  const local = runLocal(ours, CASE).summary()
  console.log(describeRun('in-process', local))
  if (local.eye === null || local.runOff === null) throw new HarnessError('the scene itself is broken: with the program attached in-process the box never reached the eye')

  const plc = await startPlc()
  try {
    console.log(`  plc:         snap7's S7 server on 127.0.0.1:${PORT}${SNAP7 ? ` (python-snap7 from ${SNAP7})` : ''}, the program scanning every ${SCAN_MS} ms`)
    console.log(`  simulator:   the app's S7 session (src/editor/links/s7Link.ts), running ${SECONDS} s of wall-clock time`)
    const ext = await runExternal(ours, REMOTE, s7.link, { drivenTags: s7.drivenTags, startPlc: () => s7.start() })
    const st = s7.session.status()
    await s7.session.stop()
    const end = await plc.end()

    const remote = ext.trace.summary()
    console.log(describeRun('S7 (snap7)', remote))
    console.log(`               client: ${st.requests} over ${s7.session.poller.cycles} cycles; server: ${end.scans} scans, ${end.reads} read and ${end.writes} write events; worst step lag ${ext.worstLagMs.toFixed(0)} ms`)

    const checks = [
      ['the server agreed a PDU and answered every cycle to the end', st.error === null && !st.stale && s7.session.poller.stats.refused === 0, `${st.requests}${st.error ? `, ${st.error}` : ''}`],
      ['the jobs reached the server as reads and writes of its memory', end.reads > 0 && end.writes > 0, `${end.reads} read and ${end.writes} write events`],
      [
        "the eye's BIT writes left the rest of its byte alone",
        end.neighbours === end.expectedNeighbours,
        `I80's other bits ${end.neighbours.toString(2).padStart(8, '0')} (planted ${end.expectedNeighbours.toString(2).padStart(8, '0')})`,
      ],
      ...behaviourChecks(local, remote),
    ]
    const failed = report(checks)
    console.log(failed === 0 ? '\nThe program behaves the same over S7 as in the simulator.' : `\n${failed} check(s) failed.`)
    return failed === 0 ? 0 : 1
  } finally {
    await s7.session.stop()
    plc.kill()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof HarnessError ? `\nharness: ${e.message}` : e)
    process.exit(2)
  },
)
