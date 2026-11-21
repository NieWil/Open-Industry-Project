#!/usr/bin/env node
// The simulator as a plant service: a scene stepped at wall-clock speed behind a Modbus TCP server, for a PLC
// outside this repo to commission it (a Quartz runtime on the same host, an OpenPLC runtime, any Modbus master).
//
//   npm run plant -- --demo [--port 5020] [--host 127.0.0.1] [--io-list <file.csv>] [--status <file.json>]
//   npm run plant -- <project-folder> [same options]
//
//   --demo          the palletizing cell (editor/demoScenes.ts), its wired tags given addresses the way the PLC
//                   panel's "Assign I/O" gives them (editor/ioAssign.ts)
//   <folder>        a project folder whose parts are already wired to addresses (npm run assign-io -- <folder>)
//   --io-list       write the I/O list as CSV (the format "Export I/O list" writes), for the PLC's own project
//   --status        rewrite a JSON status every second: sim time, lag, connections, the PLC's last request
//   --seconds <n>   stop after n seconds of sim time (default: run until SIGINT or SIGTERM)
//   --share <ws-url>  run in a shared project on that collab server (docs/live-share.md), so its view link shows
//                   this run read-only; the room's edit secret is kept in --room-file (made on first use)
//   --room-file <f> where the room's edit secret is kept (default .plant-room beside the working directory)
//   --app <url>     the editor's address, to print the view link with (default https://www.openindustryproject.org/app/)
//
// It is the loop of the openplc-loop harness (scripts/lib/conveyor-loop.mjs runExternal) without an end:
// the image is written with the scene's tags before the first poll, the parts stop driving what the PLC drives,
// and each step reads what the PLC last wrote. Nothing here is deterministic, since the PLC scans on its own
// clock; a project test runs the in-process program instead.
//
// Exit 0 = stopped cleanly, 1 = the scene or its wiring cannot be served, 2 = usage.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { listenModbus } from './lib/modbus-tcp-listen.mjs'
import { roomSecret, shareRun } from './lib/plant-share.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HZ = 60

function usage(why) {
  if (why) console.error(`✗ ${why}`)
  console.error('usage: npm run plant -- --demo | <project-folder> [--port 5020] [--host 127.0.0.1] [--io-list <file.csv>] [--status <file.json>] [--seconds <n>] [--share <ws-url> [--room-file <file>] [--app <url>]]')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { demo: false, folder: null, port: 5020, host: '127.0.0.1', ioList: null, status: null, seconds: null, share: null, roomFile: '.plant-room', app: 'https://www.openindustryproject.org/app/' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => argv[++i] ?? usage(`${a} needs a value`)
    if (a === '--demo') opts.demo = true
    else if (a === '--port') opts.port = Number(value())
    else if (a === '--host') opts.host = value()
    else if (a === '--io-list') opts.ioList = value()
    else if (a === '--status') opts.status = value()
    else if (a === '--seconds') opts.seconds = Number(value())
    else if (a === '--share') opts.share = value()
    else if (a === '--room-file') opts.roomFile = value()
    else if (a === '--app') opts.app = value()
    else if (a.startsWith('--')) usage(`unknown option ${a}`)
    else if (opts.folder === null) opts.folder = a
    else usage(`unexpected ${a}`)
  }
  if (opts.demo === (opts.folder !== null)) usage('give either --demo or a project folder')
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) usage('--port must be 1-65535')
  if (opts.seconds !== null && !(opts.seconds > 0)) usage('--seconds must be positive')
  if (opts.share !== null && !/^wss?:\/\//.test(opts.share)) usage('--share takes the collab server\'s ws:// or wss:// address')
  return opts
}

/** This repo's modules, loaded through vite (they are TypeScript), with the bundled parts registered and Jolt up. */
async function loadOurs() {
  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true } })
  try {
    const m = (p) => vite.ssrLoadModule(p)
    const ours = {
      ...(await m('/src/core/io/externalIo.ts')),
      ...(await m('/src/plc/link/modbusServer.ts')),
      ...(await m('/src/editor/links/externalPlc.ts')),
      ...(await m('/src/editor/program/ioAssign.ts')),
      ...(await m('/src/editor/demo/demoScenes.ts')),
      ...(await m('/src/sim/world.ts')),
      ...(await m('/src/core/parts/partRegistry.ts')),
      ...(await m('/src/editor/parts/bundledPackageData.ts')),
      ...(await m('/src/core/types/index.ts')),
      ...(await m('/src/collab/liveShare.ts')),
      ...(await m('/src/collab/schema.ts')),
    }
    const initJolt = (await m('jolt-physics')).default
    for (const pkg of ours.bundledPackagesFromData()) ours.registerPackage(pkg, true)
    ours.Jolt = await initJolt()
    return ours
  } finally {
    await vite.close()
  }
}

/** The scene and program to serve: the demo cell with addresses assigned, or a project folder as saved. */
function loadMachine(ours, opts) {
  if (opts.demo) {
    const scene = ours.createPlcDemoScene()
    const edit = ours.assignIo(scene, ours.DEMO_PROGRAM)
    return { name: 'Palletizing cell (demo)', scene: edit.scene ?? scene, program: edit.source, report: edit.report }
  }
  const folder = resolve(opts.folder)
  const manifest = JSON.parse(readFileSync(join(folder, 'project.json'), 'utf8'))
  const scene = JSON.parse(readFileSync(join(folder, 'scene.json'), 'utf8'))
  return { name: manifest.name ?? folder, scene, program: null, report: null }
}

/** One frame's tags (grouped by part) as one record keyed by tag, the names the image's points carry. */
function flattenTags(tags) {
  const out = {}
  for (const perPart of Object.values(tags ?? {})) Object.assign(out, perPart)
  return out
}

/** Write a file whole or not at all: a reader never sees half a status. */
function writeAtomic(path, text) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ours = await loadOurs()
  const machine = loadMachine(ours, opts)
  if (machine.report) console.log(`  I/O:   ${machine.report.headline}`)

  const derived = ours.deriveExternalIo(machine.scene.parts, { port: opts.port, network: false })
  if (derived.problems.length > 0) {
    console.error(`✗ the scene's wiring cannot be served over Modbus:\n  ${derived.problems.join('\n  ')}`)
    process.exit(1)
  }
  const io = { ...derived.io, host: opts.host }
  const checked = ours.validateExternalIo(io)
  if (!checked.ok) {
    console.error(`✗ the derived I/O table is invalid:\n  ${checked.errors.join('\n  ')}`)
    process.exit(1)
  }
  if (opts.ioList && machine.program !== null) writeFileSync(opts.ioList, ours.ioListCsv(machine.scene, machine.program, machine.name))
  if (opts.ioList && machine.program === null) console.warn('  --io-list: a project folder\'s list is `npm run assign-io -- <folder> --export`')

  const server = new ours.ModbusServerIo(checked.io)
  const driven = ours.externalDrivenTags(checked.io)
  const world = new ours.SimWorld(ours.Jolt, { version: ours.SCENE_VERSION, parts: machine.scene.parts }, { hz: HZ })
  world.setBehaviorDrivenTags(driven)
  // the sensors' state is in the image before the PLC's first poll, so nothing latches on a stale input
  let worldTags = flattenTags(world.frame().tags)
  server.writeSimTags(worldTags)
  const listener = await listenModbus(server, { host: opts.host, port: opts.port })

  const points = checked.io.points
  console.log(`${machine.name}: ${points.length} I/O points served on ${opts.host}:${opts.port} (Modbus TCP), ${driven.length} driven by the PLC`)

  let share = null
  if (opts.share) {
    share = await shareRun(ours, { url: opts.share, secret: roomSecret(opts.roomFile), scene: machine.scene, name: machine.name })
    const link = new URL(opts.app)
    link.searchParams.set('room', share.docName)
    link.searchParams.set('server', opts.share)
    console.log(`  view:  ${link} (read-only; add &present=1 for a display)`)
  }

  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  const t0 = performance.now()
  let steps = 0
  let worstLagMs = 0
  let lastStatus = 0
  const limit = opts.seconds === null ? Infinity : Math.round(opts.seconds * HZ)
  try {
    while (!stopping && steps < limit) {
      const now = performance.now()
      const due = Math.min(limit, Math.floor(((now - t0) / 1000) * HZ))
      worstLagMs = Math.max(worstLagMs, now - t0 - (steps / HZ) * 1000)
      while (steps < due) {
        server.writeSimTags(worldTags)
        world.setBehaviorInputTags(server.plcTags())
        world.step()
        worldTags = flattenTags(world.frame().tags)
        steps++
      }
      // one frame for whoever follows the run (the sender keeps 20 Hz and sends nothing while nobody follows),
      // with the scene's tags as they are now: what the PLC reads and what it drives
      if (share) share.push(world.frame(), { ...worldTags, ...server.plcTags() })
      if (opts.status && now - lastStatus >= 1000) {
        lastStatus = now
        writeAtomic(opts.status, JSON.stringify({ machine: machine.name, simSeconds: steps / HZ, worstLagMs: Math.round(worstLagMs), connections: listener.connections, stats: server.stats ?? null, ...(share ? { followers: share.followers() } : {}) }))
      }
      await new Promise((r) => setTimeout(r, 2)) // the sockets are served in between
    }
  } finally {
    share?.close()
    world.dispose()
    await listener.close()
  }
  console.log(`stopped after ${(steps / HZ).toFixed(1)} s of sim time, worst lag ${worstLagMs.toFixed(0)} ms`)
}

main().catch((e) => {
  console.error(`✗ ${e?.stack ?? e}`)
  process.exit(1)
})
