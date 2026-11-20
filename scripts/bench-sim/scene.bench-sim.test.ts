// The sim benchmark (npm run bench-sim; scripts/bench-sim.mjs starts this spec - it is not part of the unit suite).
//
// One saved project, run headless on the worker's own path - SimWorld stepping, PlcHost.interleave scanning between
// the steps, a frame built at the worker's ~60 Hz - LOCKED DOWN like the worker (frozen intrinsics change what JS
// costs), and reported in the stats overlay's own rows (editor/simLoad.ts): parts / plc / physics / upkeep.
//
// Run it before and after an engine change. The TIMINGS compare. The FINGERPRINT - every box pose (mm), the line's
// completions and every PLC value at the end - must come out identical, or the change altered what the line does:
// the run is deterministic (the controller runs on its own clock from a fixed start), so one differing fingerprint
// is a behaviour change, not noise.
//
// Settings arrive in the environment (the CLI sets them): BENCH_PROJECT, BENCH_LABEL, BENCH_SECONDS, BENCH_WARM,
// BENCH_REPS, BENCH_OUT, BENCH_JSON, optionally BENCH_ENGINE (the PLC scan engine), and BENCH_HZ / BENCH_SCAN_MS, which override the scene's step rate and
// EVERY task's interval (a what-if: the fingerprint is then a different run's, comparable only to runs with the same pair).

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type initJolt from 'jolt-physics'
import { it } from 'vitest'
import { dialectRefusal, isKnownDialect } from '../../src/core/dialect'
import { registerPackage, registerScenePackages, setBuiltInPackages } from '../../src/core/parts/partRegistry'
import type { ProjectJSON } from '../../src/core/project/project'
import { isZipData, oipBytesToProject } from '../../src/core/project/projectArchive'
import { folderFilesToProject } from '../../src/core/project/projectFolder'
import type { ProjectFolderFile } from '../../src/core/project/projectFolder'
import { bundledPackagesFromData } from '../../src/editor/parts/bundledPackageData'
import { controllerFor, runnableSource } from '../../src/plc/controller'
import { setScanEngine, type ScanEngine } from '../../src/plc/interpreter'
import { LocalPlcLink } from '../../src/plc/link/plcLink'
import { wiredBindings } from '../../src/plc/wiring'
import { PlcHost } from '../../src/sim/plcHost'
import { formatPartDiagnostics, validatePart } from '../../src/sim/validatePart'
import { SimWorld } from '../../src/sim/world'

const env = process.env
const PROJECT = env.BENCH_PROJECT ?? ''
const LABEL = env.BENCH_LABEL ?? 'run'
const SECONDS = Number(env.BENCH_SECONDS ?? 60)
const WARM = Number(env.BENCH_WARM ?? 10)
const REPS = Number(env.BENCH_REPS ?? 3)
const HZ = env.BENCH_HZ ? Number(env.BENCH_HZ) : null
const SCAN_MS = env.BENCH_SCAN_MS ? Number(env.BENCH_SCAN_MS) : null
// The Jolt build. `wasm` (SIMD, single thread) is what the sim worker loads (sim/worker.ts), so it is the default:
// the bare package entry is the compat build, without SIMD, which measured ~1.3x slower - a bench on it reported a
// physics cost the app does not pay. `mt` is the threaded build the worker loads under ?joltthreads.
const JOLT = env.BENCH_JOLT ?? 'wasm'
if (!['wasm', 'compat', 'mt'].includes(JOLT)) throw new Error(`BENCH_JOLT: no build '${JOLT}' (wasm | compat | mt)`)
const loadJolt = async (): ReturnType<typeof initJolt> =>
  (JOLT === 'mt' ? (await import('jolt-physics/wasm-multithread')).default : JOLT === 'compat' ? (await import('jolt-physics')).default : (await import('jolt-physics/wasm')).default)() as ReturnType<typeof initJolt>
const ENGINE = (env.BENCH_ENGINE ?? 'typed') as ScanEngine
if (!['typed', 'walker'].includes(ENGINE)) throw new Error(`BENCH_ENGINE: no engine '${ENGINE}'`)
setScanEngine(ENGINE)

/** a project folder's files, by the desktop shell's own walk (scripts/lib/projectFolderFiles.mjs) */
const folderFiles = (createRequire(import.meta.url)('../../apps/desktop/projectFolderIo.cjs') as { readProjectFolder: (root: string) => ProjectFolderFile[] }).readProjectFolder

/** A project's own part folders, built the way scripts/test-project.mjs builds them (validatePart is the app's bake). */
function bakePart(manifestJson: string, behaviorJs: string): { package: NonNullable<ReturnType<typeof validatePart>['package']> } | { error: string } {
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestJson)
  } catch {
    return { error: 'manifest.json is not valid JSON' }
  }
  const r = validatePart(manifest, behaviorJs)
  return r.ok && r.package ? { package: r.package } : { error: formatPartDiagnostics(r.diagnostics) }
}

async function loadProject(target: string): Promise<ProjectJSON> {
  // the app's built-ins, declared before the project is read: format 3 names them by id and keeps no copy
  // (core/project/project.ts), and they are the live copy of their ids, as in the app (bundledExamples.ts)
  const builtIns = bundledPackagesFromData()
  for (const pkg of builtIns) registerPackage(pkg, true)
  setBuiltInPackages(builtIns)
  const result = statSync(target).isDirectory()
    ? folderFilesToProject(folderFiles(target), { bakePart })
    : isZipData(readFileSync(target))
      ? await oipBytesToProject(readFileSync(target))
      : folderFilesToProject([{ path: 'project.json', contents: readFileSync(target, 'utf8') }])
  if (!result.ok) throw new Error(`the project does not load: ${result.errors.join('; ')}`)
  return result.project
}

interface Rep {
  msPerStep: number
  parts: number
  plc: number
  physics: number
  upkeep: number
  realtime: number
  coreAtRate: number
  scansPerStep: number
  msPerScan: number
  plcIn: number
  plcScan: number
  plcImage: number
  boxesAvg: number
}

interface Run {
  rep: Rep
  fingerprint: string
  facts: string
}

function once(Jolt: Awaited<ReturnType<typeof initJolt>>, project: ProjectJSON): Run {
  // a project holds one scene and its program (format 4); an older multi-scene folder benches as its first scene
  const entry = project
  const scene = entry.scene
  // as the app runs them: the built-ins (declared in loadProject), the project's parts over them, and only then any
  // copy a scene still carries, which loses to both (partRegistry registerScenePackages)
  for (const pkg of project.packages ?? []) registerPackage(pkg, true)
  registerScenePackages(scene.packages)
  const hz = HZ ?? entry.simHz ?? 60
  const stProgram = entry.stProgram ?? ''
  const scanMs = SCAN_MS ?? entry.stScanMs ?? 10
  const controller = entry.controller && SCAN_MS !== null ? { ...entry.controller, tasks: entry.controller.tasks.map((k) => ({ ...k, intervalMs: SCAN_MS })) } : entry.controller
  const world = new SimWorld(Jolt, scene, { hz })
  const w = world as unknown as { phaseMs: Record<string, number>; boxes: { id: number; body: { GetPosition(): { GetX(): number; GetY(): number; GetZ(): number } } }[] }
  let host: PlcHost | null = null
  if (stProgram.trim()) {
    const source = runnableSource(stProgram, controllerFor(stProgram, controller, scanMs))
    const declared = new LocalPlcLink(source)
    const wired = wiredBindings(scene.parts, declared)
    world.setBehaviorDrivenTags(declared.withBindings(wired).outputs) // output ownership, as the editor sends it
    host = new PlcHost(source, scanMs / 1000, wired)
  }
  const dt = 1 / hz
  const framesEvery = Math.max(1, Math.round(hz / 60)) // the worker posts about one frame per 60 Hz tick, not per step
  const t = { step: 0, plc: 0, frame: 0 }
  const step = (i: number, timed: boolean): void => {
    const a = performance.now()
    host?.interleave(world, dt)
    const b = performance.now()
    world.step()
    const c = performance.now()
    if (i % framesEvery === 0) world.frame()
    const d = performance.now()
    if (timed) {
      t.plc += b - a
      t.step += c - b
      t.frame += d - c
    }
  }
  const warmSteps = Math.round(WARM * hz)
  for (let i = 0; i < warmSteps; i++) step(i, false)
  const n = Math.round(SECONDS * hz)
  const p0 = { ...w.phaseMs }
  const h0 = host ? { ...host.perf } : null
  let boxes = 0
  const wall0 = performance.now()
  for (let i = 0; i < n; i++) {
    step(warmSteps + i, true)
    boxes += w.boxes.length
  }
  const wall = performance.now() - wall0
  const phase = (k: string): number => (w.phaseMs[k]! - p0[k]!) / n
  // the overlay's rows (simLoad.ts StepSplit): parts = behaviors + rig drives, physics = Jolt's step, upkeep = the rest
  // of step() (cull, facets) plus the frame build
  const parts = phase('behaviors') + phase('drives')
  const physics = phase('solver')
  const upkeep = t.step / n - parts - physics + t.frame / n
  const plc = t.plc / n
  const hp = host?.perf
  const scans = hp && h0 ? hp.scans - h0.scans : 0
  const hash = createHash('sha256')
  for (const b of w.boxes) {
    const p = b.body.GetPosition()
    hash.update(`${b.id}:${Math.round(p.GetX() * 1000)},${Math.round(p.GetY() * 1000)},${Math.round(p.GetZ() * 1000)};`)
  }
  const done = world.measurements().completedTotal
  hash.update(`completed:${done};`)
  const watch = host ? (host.snapshot().watch as Record<string, unknown>) : {}
  hash.update(JSON.stringify(Object.keys(watch).sort().map((k) => [k, watch[k]])))
  const tasks = (controller?.tasks ?? []).map((k) => `${k.intervalMs} ms`).join(', ')
  const facts = `${hz} Hz, jolt ${JOLT}, ${scene.parts.length} parts, ${stProgram.trim() ? `program ${(stProgram.length / 1024).toFixed(0)} KB on ${tasks || `${scanMs} ms`} (${ENGINE}), ${Object.keys(watch).length} PLC values` : 'no program'}; at the end ${w.boxes.length} boxes, ${done} completed`
  world.dispose()
  const msPerStep = parts + plc + physics + upkeep
  return {
    fingerprint: hash.digest('hex').slice(0, 16),
    facts,
    rep: {
      msPerStep,
      parts,
      plc,
      physics,
      upkeep,
      realtime: SECONDS / (wall / 1000),
      coreAtRate: (msPerStep * hz) / 1000,
      scansPerStep: scans / n,
      msPerScan: scans && hp && h0 ? (hp.scanMs - h0.scanMs) / scans : 0,
      plcIn: hp && h0 ? (hp.inputsMs - h0.inputsMs) / n : 0,
      plcScan: hp && h0 ? (hp.scanMs - h0.scanMs) / n : 0,
      plcImage: hp && h0 ? (hp.imageMs - h0.imageMs) / n : 0,
      boxesAvg: boxes / n,
    },
  }
}

it('bench-sim', async () => {
  if (!PROJECT) throw new Error('BENCH_PROJECT is not set (run it through npm run bench-sim -- <project>)')
  const project = await loadProject(PROJECT)
  const entry = project
  if (entry.stProgram?.trim() && !isKnownDialect(entry.stDialect)) throw new Error(dialectRefusal(entry.stDialect))
  const Jolt = await loadJolt()
  const runs = Array.from({ length: REPS }, () => once(Jolt, project))
  const median = (k: keyof Rep): number => runs.map((r) => r.rep[k]).sort((a, b) => a - b)[Math.floor(REPS / 2)]!
  const prints = [...new Set(runs.map((r) => r.fingerprint))]
  const f = (x: number, d = 3): string => x.toFixed(d)
  const lines = [
    `${LABEL}: ${basename(PROJECT)} - ${runs[0]!.facts}`,
    `  sim      ${f(median('msPerStep'))} ms/step   ${(median('coreAtRate') * 100).toFixed(0)}% of one core at its rate, ${f(median('realtime'), 2)}x realtime headless`,
    `    parts    ${f(median('parts'))}`,
    `    plc      ${f(median('plc'))}   in ${f(median('plcIn'))} + scans ${f(median('plcScan'))} + image ${f(median('plcImage'))}; ${f(median('scansPerStep'), 2)} scans/step at ${f(median('msPerScan'))} ms/scan`,
    `    physics  ${f(median('physics'))}`,
    `    upkeep   ${f(median('upkeep'))}`,
    `  ${median('boxesAvg').toFixed(0)} boxes on average; fingerprint ${prints.join(' / ')}${prints.length > 1 ? '   NOT DETERMINISTIC across the repetitions' : ''}`,
    `  median of ${REPS} x ${SECONDS} sim-s after ${WARM} s warm-up; ms/step spread ${f(Math.min(...runs.map((r) => r.rep.msPerStep)))}..${f(Math.max(...runs.map((r) => r.rep.msPerStep)))}`,
  ]
  const record = { label: LABEL, at: new Date().toISOString(), project: basename(PROJECT), seconds: SECONDS, warm: WARM, facts: runs[0]!.facts, fingerprint: prints, median: Object.fromEntries((Object.keys(runs[0]!.rep) as (keyof Rep)[]).map((k) => [k, median(k)])), reps: runs.map((r) => r.rep) }
  if (env.BENCH_OUT) {
    mkdirSync(dirname(env.BENCH_OUT), { recursive: true })
    appendFileSync(env.BENCH_OUT, JSON.stringify(record) + '\n')
  }
  console.log(env.BENCH_JSON ? JSON.stringify(record) : lines.join('\n'))
})
