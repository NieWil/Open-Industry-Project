// Headless project-test runner - the CI / regression seam for a factory's CONTROL LOGIC
// (docs/project-tests.md). Where validate-project proves a project LOADS, this proves it BEHAVES:
//
//   npm run test-project -- <project-folder> [--only <file-or-name>]
//
// Runs the tests project.json lists, plus any tests/*.test.json it does not (with a note: the app runs only the
// listed ones): loads the project, steps its scene's physics + ST program forward in simulated time, and checks
// tag values. Exit 0 = all checks pass, 1 = a check failed, 2 = usage/IO error, 3 = the project failed to load or
// a test could not run (an invalid spec, a fault the scene cannot apply); 3 outranks 1, so a script that counts
// exit 1 as "the program was caught" is never fooled by a broken copy. Uses the REAL core evaluator + editor runner via vite's SSR loader
// (same programmatic-vite shape as validate-project.mjs), so there's no second implementation.
// A test whose scene's program is in a dialect this version does not have (core/dialect.ts) fails
// with the reason, as Play refuses it: the runner never steps it as IEC.
// Every run also collects FLOW FACTS (src/core/flow/flowFacts.ts): what physically happened to the cargo - a box dropped
// or lost, tipped, a sensor flickering, a box sitting still on a running conveyor. They are printed as a one-line
// summary per test, listed before a failure's first failing check, and carried in --json. Facts never fail a test.

import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { collectTests, listedTestPaths, pickTests, readTestSpecs } from './lib/projectTests.mjs'
import { readProjectFolder } from './lib/projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const USAGE =
  'usage: npm run test-project -- <project-folder> [--only <file-or-name>] [--trace <tag,tag,...|all>] [--cargo <t,t,...>] [--context <seconds>] [--json]'
// the exit codes (docs/project-tests.md "The runner")
const EXIT_FAILED = 1
const EXIT_USAGE = 2
const EXIT_UNRUNNABLE = 3
// flags that take a value, and the one that does not
const valued = new Set(['--only', '--trace', '--context', '--cargo'])
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const only = flag('--only')
// --trace: tags to follow through the WHOLE run (every change, with the time), or `all` of them
const traceArg = flag('--trace')
const traceTags = traceArg === null ? null : traceArg === 'all' ? 'all' : traceArg.split(',').map((t) => t.trim()).filter(Boolean)
// --context: how many seconds before a failure to show every tag that changed in (0: none). A failed test is run a
// second time to record them: the run is deterministic, so it is the same run
const context = flag('--context') === null ? 3 : Number(flag('--context'))
const json = args.includes('--json')
// how many of the flow facts before a failure to list (the latest ones: the nearest to it)
const FACTS_SHOWN = 20
// --cargo: sim times at which to list every live cargo body (id, part, kind, colour, centre): where the boxes ARE
const cargoArg = flag('--cargo')
const cargoTimes = cargoArg === null ? null : cargoArg.split(',').map((t) => Number(t.trim())).sort((a, b) => a - b)
const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
if (
  !target ||
  !Number.isFinite(context) ||
  context < 0 ||
  (traceArg !== null && traceTags !== 'all' && traceTags.length === 0) ||
  (cargoTimes !== null && (cargoTimes.length === 0 || cargoTimes.some((t) => !Number.isFinite(t) || t < 0)))
) {
  console.error(USAGE)
  process.exit(EXIT_USAGE)
}

let stats
try {
  stats = statSync(target)
} catch {
  console.error(`✗ no such folder: ${target}`)
  process.exit(EXIT_USAGE)
}
if (!stats.isDirectory()) {
  console.error('✗ test-project takes a project FOLDER (tests live in its tests/ subfolder)')
  process.exit(EXIT_USAGE)
}

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

let failures = 0
// tests that could not run at all (invalid spec, a refused fault): what exit 3 means, alongside a project that fails to load
let errored = 0
try {
  // the app's built-in parts: a format-3 project names them by id and keeps no copy (scripts/lib/builtIns.mjs)
  await declareBuiltIns(vite)
  const { folderFilesToProject } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
  const { validateTestSpec, TraceRecorder, formatTrace } = await vite.ssrLoadModule('/src/core/project/projectTest.ts')
  const { CargoSnapshots } = await vite.ssrLoadModule('/src/core/project/projectProbe.ts')
  const { runProjectTest } = await vite.ssrLoadModule('/src/editor/project/projectTestRunner.ts')
  const { formatFlowFact, summarizeFlowFacts } = await vite.ssrLoadModule('/src/core/flow/flowFacts.ts')
  const { validatePart, formatPartDiagnostics } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
  const initJolt = (await vite.ssrLoadModule('jolt-physics')).default

  const bakePart = (manifestJson, behaviorJs) => {
    let manifest
    try {
      manifest = JSON.parse(manifestJson)
    } catch {
      return { error: 'manifest.json is not valid JSON' }
    }
    const r = validatePart(manifest, behaviorJs)
    return r.ok && r.package ? { package: r.package } : { error: formatPartDiagnostics(r.diagnostics) }
  }

  const loaded = folderFilesToProject(readProjectFolder(target), { bakePart })
  if (!loaded.ok) {
    console.error(`✗ project failed to load:\n${loaded.errors.map((e) => `  - ${e}`).join('\n')}`)
    process.exit(EXIT_UNRUNNABLE)
  }

  // Where the specs come from. A project whose manifest CARRIES its tests is the source of truth -
  // validateProject already ran validateTestSpec over each, so they arrive validated. A folder that lists none
  // falls back to globbing tests/, which is how every project authored before tests joined the document keeps
  // working unchanged.
  //
  // A folder from before a project held one scene splits when it is read (core/project/project.ts `splitOff`): each of
  // its other scenes is the project it will be when the app opens it, carrying the tests that named it. Each test
  // runs against its own project, so a result here means what it meant before.
  const projects = [loaded.project, ...(loaded.splitOff ?? [])]
  if (loaded.splitOff) {
    console.log(`note: this folder holds ${projects.length} scenes, from before a project held one; each runs as the project it becomes:`)
    for (const p of projects) console.log(`  - "${p.name}"`)
  }
  // Each test is named by its FILE where it has one (sort.test.json), which is what `--only` matches first and what
  // a report leads with, so two tests whose display names share a word stay apart. A file in tests/ the manifest
  // does not list runs here too, with a note that the app will not run it until it is listed (scripts/lib/projectTests.mjs).
  const { all, bad } = collectTests(loaded, listedTestPaths(target), readTestSpecs(target), validateTestSpec)

  // --only: an exact file or display name wins; a substring only when nothing matches exactly
  const { specs, unreadable, ambiguous } = pickTests(all, bad, only)
  if (ambiguous.length > 0) {
    console.error(`note: no test is named exactly "${only}", and ${ambiguous.length} contain it; running all of them:`)
    for (const n of ambiguous) console.error(`  - ${n}`)
  }
  for (const b of unreadable) for (const line of b.lines) console.error(line)
  errored += unreadable.length

  if (specs.length === 0 && unreadable.length === 0) {
    if (only && all.length + bad.length > 0) {
      console.error(`✗ no test matches --only "${only}" (it matches a test's file name, with or without .test.json, or its "name"; failing an exact match, a part of either). The tests here:`)
      for (const s of all) console.error(`  - ${s.file ?? s.name}${s.spec.name && s.spec.name !== s.file ? ` - "${s.spec.name}"` : ''}`)
      for (const b of bad) console.error(`  - ${b.file} (cannot run)`)
      process.exit(EXIT_USAGE)
    }
    console.log(`no tests found in ${target} (add a tests/<name>.test.json, and list it in project.json's "tests")`)
    process.exit(0)
  }
  for (const s of specs) {
    if (s.unlisted) console.log(`note: tests/${s.file} is not listed in project.json's "tests", so the app will not run it; running it here anyway`)
  }

  const Jolt = await initJolt()
  const report = [] // what --json prints
  const indent = (lines) => lines.map((l) => `        ${l}`)
  for (const { name, spec, project } of specs) {
    let result
    const trace = traceTags !== null ? new TraceRecorder(traceTags) : null
    // --cargo: the live cargo at the first step reaching each asked-for time
    const snaps = cargoTimes ? new CargoSnapshots(cargoTimes) : null
    const onFrame = snaps?.onFrame
    try {
      result = runProjectTest(Jolt, project, spec, { ...(trace ? { trace } : {}), ...(onFrame ? { onFrame } : {}) })
    } catch (e) {
      // the test could not run (a fault the scene cannot apply, a jam that caught nothing): not a verdict on the program
      console.error(`✗ ${name}: ${e instanceof Error ? e.message : String(e)}`)
      report.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) })
      errored++
      continue
    }
    // Why each failed check failed is in the OTHER tags just before it: run the test again, recording every tag that
    // changes in the `context` seconds before each failure. Same project, same spec, same seed-free sim: same run.
    const failedChecks = result.checks.filter((c) => !c.ok && c.failedAt !== undefined)
    let lead = null
    if (context > 0 && failedChecks.length > 0) {
      lead = new TraceRecorder('all', failedChecks.map((c) => ({ from: Math.max(0, c.failedAt - context), to: c.failedAt })))
      try {
        runProjectTest(Jolt, project, spec, { trace: lead })
      } catch {
        lead = null // it ran once; a second run failing to is no reason to lose the verdict
      }
    }
    const leadOf = (c) => {
      const k = failedChecks.indexOf(c)
      if (!lead || k < 0) return null
      // what changed, and the checked tag itself whether it changed or not: it is what the check was about
      const all = lead.result(k)
      return all.filter((t) => t.changes.length > 0 || (c.check.tag !== undefined && t.tag === c.check.tag))
    }

    // a file-sourced spec shows both (start-stop.test.json - "Start/stop seal-in…"); a document-sourced
    // one IS its name, so the quoted repeat would just say it twice
    const title = spec.name ?? name
    const failed = result.checks.filter((c) => !c.ok).length
    const label = title === name ? name : `${name} - "${title}"`
    report.push({
      name,
      title,
      ok: result.ok,
      project: project.name,
      duration: spec.duration,
      checks: result.checks.map((c) => ({ ok: c.ok, detail: c.detail, ...(c.warning ? { warning: c.warning } : {}), ...(c.failedAt !== undefined ? { failedAt: c.failedAt } : {}), ...(leadOf(c) ? { leadUp: leadOf(c) } : {}) })),
      facts: result.facts,
      ...(result.factsOverflow > 0 ? { factsOverflow: result.factsOverflow } : {}),
      ...(trace ? { trace: trace.result() } : {}),
      ...(snaps ? { cargo: snaps.snapshots } : {}),
    })
    if (!result.ok) failures++
    if (json) continue
    console.log(`${result.ok ? '✓' : '✗'} ${label} (${projects.length > 1 ? `"${project.name}", ` : ''}${spec.duration}s)`)
    // the physical facts up to the FIRST failure in time (the earliest failing check): what the cargo did before the
    // program's checks went wrong
    const firstFail = result.checks.filter((c) => !c.ok).reduce((a, c) => (a === undefined || (c.failedAt ?? Infinity) < (a.failedAt ?? Infinity) ? c : a), undefined)
    const printFactsBefore = (c) => {
      const until = c.failedAt ?? spec.duration
      const before = result.facts.filter((f) => f.t <= until + 1e-9).sort((a, b) => a.t - b.t)
      if (before.length === 0) {
        console.log(`      physical facts before the failure (t <= ${until.toFixed(3)}s): none`)
        return
      }
      console.log(`      physical facts before the failure (t <= ${until.toFixed(3)}s):`)
      const shown = before.slice(-FACTS_SHOWN)
      if (before.length > shown.length) console.log(`        ... ${before.length - shown.length} earlier`)
      for (const f of shown) console.log(`        ${formatFlowFact(f)}`)
    }
    for (const c of result.checks) {
      console.log(`    ${c.ok ? '✓' : '✗'} ${c.detail}`)
      if (c.warning) console.log(`      ! ${c.warning}`)
      const up = leadOf(c)
      if (!up) {
        if (c === firstFail) printFactsBefore(c)
        continue
      }
      const from = Math.max(0, c.failedAt - context)
      const moved = up.filter((t) => t.changes.length > 0)
      console.log(`      ${moved.length === 0 ? 'nothing changed' : 'what changed'} in the ${(c.failedAt - from).toFixed(1)}s before (t=${from.toFixed(3)}s to ${c.failedAt.toFixed(3)}s): value then -> each change`)
      for (const line of indent(formatTrace(up))) console.log(line)
      if (c === firstFail) printFactsBefore(c)
    }
    if (!result.ok) console.log(`    ${failed} of ${result.checks.length} checks failed`)
    console.log(`    flow facts: ${summarizeFlowFacts(result.facts, result.factsOverflow)}`)
    if (trace) {
      const traced = trace.result()
      console.log(`    trace (${traced.length} tag${traced.length === 1 ? '' : 's'}, the whole run): value at the start -> each change`)
      for (const line of indent(formatTrace(traced, 40))) console.log(line)
      // a tag asked for by name that the run never published is a typo or a tag this scene does not have
      if (traceTags !== 'all') {
        const missing = traceTags.filter((t) => !traced.some((x) => x.tag === t))
        if (missing.length > 0) console.log(`      never published: ${missing.join(', ')}`)
      }
    }
    if (snaps) {
      for (const snap of snaps.snapshots) {
        console.log(`    cargo at t=${snap.t.toFixed(3)}s (${snap.bodies.length} bod${snap.bodies.length === 1 ? 'y' : 'ies'}): id  part  kind  colour  [x, y, z]  tilt  yaw  velocity m/s  touching`)
        for (const b of snap.bodies) {
          console.log(`        ${b.id}  ${b.part ?? '-'}  ${b.kind}  ${b.color}${b.colorName ? ` (${b.colorName})` : ''}  [${b.pos.join(', ')}]  ${b.tiltDeg}°  ${b.yawDeg}°  ${b.vel ? `[${b.vel.join(', ')}]` : '-'}  ${b.touching?.length ? b.touching.join(', ') : '-'}`)
        }
      }
      const missed = snaps.missed()
      if (missed.length > 0) console.log(`    cargo: the run ended (${spec.duration}s) before t=${missed.join(', ')}`)
    }
  }
  const exitCode = errored > 0 ? EXIT_UNRUNNABLE : failures > 0 ? EXIT_FAILED : 0
  if (json) console.log(JSON.stringify({ ok: exitCode === 0, exitCode, tests: report }, null, 2))

  // total counts the specs that never made it to a run too, so a folder with one broken JSON file
  // reports "1 of 3", not "1 of 2"
  const total = specs.length + unreadable.length
  if (!json) {
    if (exitCode === 0) console.log(`\n✓ all ${total} test(s) passed`)
    else {
      const parts = [...(failures > 0 ? [`${failures} failed`] : []), ...(errored > 0 ? [`${errored} could not run`] : [])]
      console.log(`\n✗ ${parts.join(', ')} - of ${total} test(s)`)
    }
  }
  process.exitCode = exitCode
} finally {
  await vite.close()
}
process.exit(process.exitCode ?? 0)
