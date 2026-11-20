// The case every PLC-in-the-loop script runs (scripts/openplc-loop.mjs, scripts/s7-loop.mjs): one
// conveyor scene, one ST program, the in-process run it is judged against, and the behavioural verdict.
// Only the controller and the I/O addresses differ, so a program that passes on one and fails on the
// other points at the controller, not at the test.
//
// The case: a box rides a belt towards a photo eye wired to an input bit; the program drops an output bit
// to stop the belt while the eye sees it. A laser measures the box's distance into an input REAL and the
// program commands the belt's speed back through an output one, creeping once a box is within a metre. A
// wrong word order or a float read as an integer would not come back as either commandable speed, so the
// analog checks are behavioural, not a register comparison.
//
// The addresses are the target's (an OpenPLC remote device, an S7 process image or data block): each
// script picks its points and the scene's tags and AT clauses follow, as Assign I/O does for a project.
//
// A point the PLC has not polled yet reads ZERO, so a latch fed straight from an analog input fires on
// the first scan - only on a real PLC. Real logic guards for it, and this program does (`BoxRange > 0.0`).
//
// Timing is measured, not exact: a real PLC scans on wall-clock time, so the box stops one poll and one
// scan later than in-process. The verdict allows for that and prints what it measured (which is also
// why a project test never runs against an external controller).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { HarnessError } from './harness.mjs'

export { HarnessError }

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---- the case ----

/** The speeds the program commands, and how near the laser has to measure a box before it creeps. */
export const FAST = 0.5
export const CREEP = 0.3
export const CREEP_WITHIN_M = 1.0

export const SCAN_MS = 20
export const POLL_MS = 20
export const HZ = 60
/** wall-clock seconds the loop runs once the PLC is in RUN */
export const SECONDS = 10

// the verdict's allowances: what one Modbus poll plus one scan can cost, with room for a busy machine
export const MAX_REACTION_MS = 500
export const MAX_POSITION_DIFF_M = 0.15
export const AT_REST_M = 0.005

/** The program's variables, by name: what the parts are wired to when a link carries tags by NAME (OPC UA). */
export const BY_NAME = Object.freeze({ eye: 'BoxAtEye', run: 'ConveyorRun', range: 'BoxRange', speed: 'BeltSpeed' })

/**
 * The case wired to `points`: the eye and run bits, and the range and speed double words. Returns the
 * points, the program (the same text in the simulator and on the controller, its variables located at the
 * points) and the scene's parts.
 *
 * Given {@link BY_NAME} instead of addresses, the program's variables stay unlocated and the parts are wired
 * to their names, which is how a link that carries names (OPC UA) finds them on the controller.
 */
export function conveyorCase(points) {
  const { eye, run, range, speed } = points
  const byName = eye === BY_NAME.eye
  // by name, plain VARs: the program's own tags, bound to it because the parts are wired to them (plc/wiring.ts
  // wiredBindings), each in the direction its parts give it, exactly as the OPC UA link binds them on the controller
  const declarations = byName
    ? `VAR
  BoxAtEye : BOOL;
  ConveyorRun : BOOL;
  BoxRange : REAL;
  BeltSpeed : REAL;
  Creeping : BOOL;
END_VAR`
    : `VAR
  BoxAtEye AT ${eye} : BOOL;
  ConveyorRun AT ${run} : BOOL;
  BoxRange AT ${range} : REAL;
  BeltSpeed AT ${speed} : REAL;
END_VAR
(* a block of its own: MATIEC refuses one that mixes located and ordinary variables *)
VAR
  Creeping : BOOL;
END_VAR`
  const program = `(* Stop the belt while a box is at the eye, and creep from the moment the laser sees one coming. *)
${declarations}

ConveyorRun := NOT BoxAtEye;
(* > 0 because a point the PLC has not polled yet reads zero, and zero is not a measurement *)
IF BoxRange > 0.0 AND BoxRange < ${CREEP_WITHIN_M} THEN
  Creeping := TRUE;
END_IF;
IF NOT ConveyorRun THEN
  Creeping := FALSE;
END_IF;
IF Creeping THEN
  BeltSpeed := ${CREEP};
ELSE
  BeltSpeed := ${FAST};
END_IF;
`
  // a 5 m belt with its deck 0.8 m up, a box dropped near its tail, and an eye 3 m along aimed across it
  const parts = [
    { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: FAST, runTag: run, speedTag: speed } },
    { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
    { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: { maxRange: 1.2, tag: eye } },
    // a laser across the belt 0.8 m before the eye: its distance is the ANALOG the PLC decides on
    { id: 'laser', type: 'part', packageId: 'oip.laser-sensor', position: [2.2, 0.75, -0.6], rotationY: 0, params: { maxRange: 1.2, distanceTag: range } },
  ]
  return { points, program, parts }
}

// ---- loading our side ----

/**
 * This repo's modules, loaded through vite (they are TypeScript), with the bundled parts registered and Jolt up.
 * `more` names further modules by key; each comes back as its own namespace under `ours.more`, loaded in the same
 * module graph, so it sees the same registered parts.
 */
export async function loadOurs(more = {}) {
  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true } })
  try {
    const m = (p) => vite.ssrLoadModule(p)
    const ours = {
      ...(await m('/src/core/io/externalIo.ts')),
      ...(await m('/src/plc/wiring.ts')),
      ...(await m('/src/plc/link/modbusServer.ts')),
      ...(await m('/src/plc/link/modbusClient.ts')),
      ...(await m('/src/core/io/opcUa.ts')),
      ...(await m('/src/core/io/s7Io.ts')),
      ...(await m('/src/core/io/ads.ts')),
      ...(await m('/src/editor/links/externalPlc.ts')),
      ...(await m('/src/editor/links/s7Link.ts')),
      ...(await m('/src/editor/links/adsLink.ts')),
      ...(await m('/src/plc/exchange/exportText.ts')),
      ...(await m('/src/plc/exchange/export.ts')),
      ...(await m('/src/plc/checker.ts')),
      ...(await m('/src/plc/controller.ts')),
      ...(await m('/src/plc/link/plcLink.ts')),
      ...(await m('/src/plc/simController.ts')),
      ...(await m('/src/plc/scanEngine.ts')),
      ...(await m('/src/sim/plcHost.ts')),
      ...(await m('/src/sim/world.ts')),
      ...(await m('/src/core/parts/partRegistry.ts')),
      ...(await m('/src/editor/parts/bundledPackageData.ts')),
      ...(await m('/src/core/types/index.ts')),
    }
    ours.more = {}
    for (const [key, path] of Object.entries(more)) ours.more[key] = await m(path)
    const initJolt = (await m('jolt-physics')).default
    for (const pkg of ours.bundledPackagesFromData()) ours.registerPackage(pkg, true)
    ours.Jolt = await initJolt()
    return ours
  } finally {
    await vite.close()
  }
}

/** The program attached as Play attaches it: its declared I/O, plus its own tags the parts are wired to by name. */
function boundLink(ours, kase, source) {
  const declared = new ours.LocalPlcLink(source)
  return declared.withBindings(ours.wiredBindings(kase.parts, declared))
}

/** The scene's wiring, checked: the tags its parts declare, with the type each carries. */
export function sceneTags(ours, kase) {
  const wiring = ours.checkWiring(kase.parts, boundLink(ours, kase, kase.program))
  const broken = wiring.problems.filter((p) => p.severity === 'error')
  if (broken.length > 0) throw new HarnessError(`the scene's wiring is broken:\n  ${broken.map((p) => p.message).join('\n  ')}`)
  return wiring.tags.map((t) => ({ name: t.name, type: t.type }))
}

/** The program as the simulator runs it, and as the exporters take it. */
export function runnable(ours, kase) {
  return ours.runnableSource(kase.program, ours.controllerFor(kase.program, null, SCAN_MS))
}

// ---- the simulator side, shared by both runs ----

export function flattenTags(tags) {
  const out = {}
  for (const perPart of Object.values(tags ?? {})) Object.assign(out, perPart)
  return out
}

/** Records what the checks need: when the belt started and stopped, when the eye saw the box, where the box went. */
export class Trace {
  rows = []
  /** `box` is the part id of the box to follow */
  constructor(points, box = 'box') {
    this.points = points
    this.box = box
  }
  add(t, tags, frame) {
    const i = frame.partIds.indexOf(this.box)
    const { eye, run, range, speed } = this.points
    this.rows.push({
      t,
      eye: tags[eye] === true,
      run: tags[run] === true,
      x: i < 0 ? Number.NaN : frame.positions[i * 3],
      range: Number(tags[range] ?? 0),
      speed: Number(tags[speed] ?? 0),
    })
  }
  summary() {
    const first = (pred, from = 0) => this.rows.find((r) => r.t >= from && pred(r))?.t ?? null
    const runOn = first((r) => r.run)
    const eye = first((r) => r.eye)
    const runOff = eye === null ? null : first((r) => !r.run, eye)
    const last = this.rows.at(-1)
    const secondAgo = [...this.rows].reverse().find((r) => r.t <= last.t - 1) ?? this.rows[0]
    // the analog pair: when the commanded speed dropped to the creep, and what the laser measured then
    const creepRow = this.rows.find((r) => r.run && Math.abs(r.speed - CREEP) < 0.001)
    const commanded = [...new Set(this.rows.filter((r) => r.run).map((r) => r.speed.toFixed(3)))].map(Number)
    return {
      runOn,
      eye,
      runOff,
      finalX: last.x,
      driftLastSecond: Math.abs(last.x - secondAgo.x),
      creepAt: creepRow?.t ?? null,
      creepRange: creepRow?.range ?? null,
      nearest: Math.min(...this.rows.map((r) => r.range)),
      commanded,
    }
  }
}

function newWorld(ours, kase) {
  return new ours.SimWorld(ours.Jolt, { version: ours.SCENE_VERSION, parts: kase.parts }, { hz: HZ })
}

/** The program attached the normal way: in-process, simulated time, the project-test runner's interleave. */
export function runLocal(ours, kase) {
  const world = newWorld(ours, kase)
  const plc = boundLink(ours, kase, runnable(ours, kase))
  world.setBehaviorDrivenTags(plc.outputs)
  const ctl = new ours.SimController(plc)
  const scheduler = new ours.TaskScheduler(ctl, { periodSec: SCAN_MS / 1000, maxCatchUp: ours.MAX_SCANS_PER_STEP })
  const trace = new Trace(kase.points)
  let worldTags = flattenTags(world.frame().tags)
  let plcOut = {}
  try {
    for (let i = 0; i < SECONDS * HZ; i++) {
      ctl.setExternalInputs(worldTags)
      if (scheduler.advance(1 / HZ).scans > 0) plcOut = { ...ctl.processImage.outputs }
      world.setBehaviorInputTags(plcOut)
      world.step()
      const frame = world.frame()
      worldTags = flattenTags(frame.tags)
      trace.add((i + 1) / HZ, { ...worldTags, ...plcOut }, frame)
    }
  } finally {
    world.dispose()
  }
  return trace
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The same scene with the PLC outside, stepped at wall-clock speed. `io` is either side of the Modbus
 * link - the server's ModbusServerIo or the client's ModbusPoller - since both take the scene's tags with
 * writeSimTags and give the PLC's back with plcTags; the bytes move in between, while this yields.
 * `drivenTags` are the tags the PLC drives, which the scene's parts must stop driving themselves.
 */
export async function runExternal(ours, kase, io, { drivenTags, startPlc }) {
  const world = newWorld(ours, kase)
  world.setBehaviorDrivenTags(drivenTags)
  // the sensors' state is in the image BEFORE the PLC's first scan, so nothing latches on a stale input
  io.writeSimTags(flattenTags(world.frame().tags))
  await startPlc()
  const trace = new Trace(kase.points)
  const total = SECONDS * HZ
  let worldTags = flattenTags(world.frame().tags)
  let steps = 0
  let worstLagMs = 0
  const t0 = performance.now()
  try {
    while (steps < total) {
      const now = performance.now()
      const due = Math.min(total, Math.floor(((now - t0) / 1000) * HZ))
      worstLagMs = Math.max(worstLagMs, now - t0 - (steps / HZ) * 1000)
      while (steps < due) {
        io.writeSimTags(worldTags)
        const plcOut = io.plcTags()
        world.setBehaviorInputTags(plcOut)
        world.step()
        const frame = world.frame()
        worldTags = flattenTags(frame.tags)
        steps++
        trace.add(steps / HZ, { ...worldTags, ...plcOut }, frame)
      }
      await sleep(2) // the socket is served in between
    }
  } finally {
    world.dispose()
  }
  return { trace, worstLagMs }
}

// ---- the verdict ----

export const fmt = (t) => (t === null ? 'never' : `${t.toFixed(2)} s`)

/** The two lines a run prints about itself. */
export function describeRun(label, s) {
  const pad = `${label}:`.padEnd(13)
  return [
    `  ${pad}belt on ${fmt(s.runOn)}, eye ${fmt(s.eye)}, belt off ${fmt(s.runOff)}, box at x = ${s.finalX.toFixed(3)} m`,
    `               analog: laser read down to ${s.nearest.toFixed(3)} m, crept at ${fmt(s.creepAt)} measuring ${s.creepRange === null ? '-' : `${s.creepRange.toFixed(3)} m`}, speeds commanded ${s.commanded.join(', ')} m/s`,
  ].join('\n')
}

/**
 * What the program did on the controller, judged against what it did in-process: [what, ok, detail]
 * rows. These are the product claim; each script adds the checks particular to its link.
 */
export function behaviourChecks(local, remote) {
  const reaction = remote.eye !== null && remote.runOff !== null ? (remote.runOff - remote.eye) * 1000 : null
  return [
    ['the PLC started the belt', remote.runOn !== null, `at ${fmt(remote.runOn)}`],
    ['the box reached the eye', remote.eye !== null, `at ${fmt(remote.eye)}`],
    [`the PLC stopped the belt within ${MAX_REACTION_MS} ms of the eye`, reaction !== null && reaction <= MAX_REACTION_MS, reaction === null ? 'it did not' : `${reaction.toFixed(0)} ms (in-process: ${((local.runOff - local.eye) * 1000).toFixed(0)} ms)`],
    [`the box came to rest within ${MAX_POSITION_DIFF_M} m of where it does in-process`, Math.abs(remote.finalX - local.finalX) <= MAX_POSITION_DIFF_M && remote.driftLastSecond <= AT_REST_M, `${(remote.finalX - local.finalX >= 0 ? '+' : '')}${((remote.finalX - local.finalX) * 1000).toFixed(0)} mm, moved ${(remote.driftLastSecond * 1000).toFixed(1)} mm in the last second`],
    // the analog pair. A word order or a float the other end read differently would not come back as
    // the two speeds the program can command, and the belt would not change pace where the laser says
    [
      'the speeds it commanded arrived as REALs, not as mangled words',
      remote.commanded.length > 0 && remote.commanded.every((v) => Math.abs(v - FAST) < 0.001 || Math.abs(v - CREEP) < 0.001),
      `commanded ${remote.commanded.join(' then ') || 'nothing'} m/s (the program writes ${FAST} and ${CREEP})`,
    ],
    [
      `the belt crept once the laser measured a box within ${CREEP_WITHIN_M} m`,
      remote.creepAt !== null && remote.creepRange < CREEP_WITHIN_M,
      remote.creepAt === null ? 'it never crept' : `at ${fmt(remote.creepAt)}, laser reading ${remote.creepRange.toFixed(3)} m (in-process: ${local.creepAt === null ? 'never' : `${fmt(local.creepAt)} at ${local.creepRange.toFixed(3)} m`})`,
    ],
  ]
}

/** Print the rows; returns how many failed. */
export function report(checks) {
  console.log('')
  for (const [what, ok, detail] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what} - ${detail}`)
  return checks.filter(([, ok]) => !ok).length
}
