// Headless WIRING check - does a project's tag plumbing actually connect?
//
//   npm run check-wiring -- <project-folder | project.json | scene.json> [--strict] [--json]
//
// `validate-project` proves a document LOADS and `test-project` proves its logic BEHAVES. This sits
// between them: every part declares which way each tag flows and what it carries (ParamSpec
// `dir` + `stType`), so wiring mistakes that would otherwise show only as "the motor never started"
// are findable without running anything - two parts driving one tag, a tag nothing drives, a BOOL
// wired to a numeric program var. The check itself is src/plc/wiring.ts; this is its CLI.
//
// Errors fail the run (exit 1); warnings are reported and do not, because a tag the program hasn't
// declared yet is a legal forward reference. `--strict` fails on warnings too - the setting for a
// finished project in CI. Exit 2 = usage/IO error.
//
// The project's TESTS count as wiring (docs/project-tests.md): a tag a test checks is read, and one a test's input
// drives is written, so a feedback tag only a test reads, or a tag only a test drives, is no warning. The report
// says so per tag ("read by tests/sort.test.json"). Tests are found as test-project finds them, unlisted
// tests/*.test.json included (scripts/lib/projectTests.mjs).
//
// Packages come from the DOCUMENT, not from this repo's built-in catalog: a scene must embed a
// placement snapshot for every packageId it uses (validate-project rejects one that doesn't), which
// is what makes a project self-contained. So the project's shared authored library plus each scene's
// snapshots is the whole universe - and a packageId that still doesn't resolve is reported rather
// than skipped, since a part whose signals are unknown is a hole in the check, not a clean result.

import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { collectTests, listedTestPaths, readTestSpecs, testLabel } from './lib/projectTests.mjs'
import { readProjectFolder } from './lib/projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const strict = argv.includes('--strict')
const target = argv.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('usage: npm run check-wiring -- <project-folder | project.json | scene.json> [--strict] [--json]')
  process.exit(2)
}
let stats
try {
  stats = statSync(target)
} catch {
  console.error(`✗ no such file or folder: ${target}`)
  process.exit(2)
}

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

try {
  // the app's built-in parts: a format-3 project names them by id and keeps no copy (scripts/lib/builtIns.mjs)
  await declareBuiltIns(vite)
  const { folderFilesToProject } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
  const { validateProject } = await vite.ssrLoadModule('/src/core/project/project.ts')
  const { validateScene } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
  const { validatePart, formatPartDiagnostics } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
  const { registerPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
  const { checkWiring, wiredBindings } = await vite.ssrLoadModule('/src/plc/wiring.ts')
  const { LocalPlcLink } = await vite.ssrLoadModule('/src/plc/link/plcLink.ts')
  const { controllerFor, runnableSource } = await vite.ssrLoadModule('/src/plc/controller.ts')
  const { wrappedProgramWarning } = await vite.ssrLoadModule('/src/plc/sceneProgram.ts')
  const { dialectRefusal, isKnownDialect } = await vite.ssrLoadModule('/src/core/dialect.ts')
  const { validateTestSpec } = await vite.ssrLoadModule('/src/core/project/projectTest.ts')
  const { coverByTests } = await vite.ssrLoadModule('/src/core/project/projectTestTags.ts')

  const bakePart = (manifestJson, behaviorJs) => {
    let manifest
    try {
      manifest = JSON.parse(manifestJson)
    } catch {
      return { error: 'manifest.json is not valid JSON' }
    }
    const result = validatePart(manifest, behaviorJs)
    return result.ok && result.package ? { package: result.package } : { error: formatPartDiagnostics(result.diagnostics) }
  }

  let project
  let entries = []
  // each project's tests, as { project, label, spec }: a folder's are found as test-project finds them, a single
  // document's are the ones it carries
  let tests = []
  if (stats.isDirectory()) {
    const result = folderFilesToProject(readProjectFolder(target), { bakePart })
    if (!result.ok) {
      console.error(`✗ ${target} does not load - run validate-project for the details`)
      process.exit(1)
    }
    project = result.project
    entries = [result.project, ...(result.splitOff ?? [])]
    tests = collectTests(result, listedTestPaths(target), readTestSpecs(target), validateTestSpec).all.map((t) => ({ project: t.project, label: testLabel(t), spec: t.spec }))
  } else {
    let data
    try {
      data = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      console.error(`✗ ${target} is not valid JSON`)
      process.exit(1)
    }
    if (data && typeof data === 'object' && Array.isArray(data.parts) && !data.scenes && data.scene === undefined) {
      const scene = validateScene(data)
      if (!scene.ok) {
        console.error(`✗ ${target} is not a valid scene - run validate-project for the details`)
        process.exit(1)
      }
      // the program is not read here, but its dialect is: a scene whose program cannot run is refused, not checked
      project = { name: '(standalone scene)', scene: scene.scene, ...(scene.stDialect !== undefined ? { stDialect: scene.stDialect } : {}), packages: [] }
      entries = [project]
    } else {
      const result = validateProject(data)
      if (!result.ok) {
        console.error(`✗ ${target} does not load - run validate-project for the details`)
        process.exit(1)
      }
      project = result.project
      entries = [result.project, ...(result.splitOff ?? [])]
      tests = entries.flatMap((p) => (p.tests ?? []).map((spec, i) => ({ project: p, label: `test "${spec.name ?? `test-${i + 1}`}"`, spec })))
    }
  }

  for (const p of project.packages ?? []) registerPackage(p, true)

  // per project - the one the document is, and (a document from before a project held one scene) the projects its
  // other scenes become when the app opens it: its own placement snapshots, then the walk
  const scenes = []
  for (const entry of entries) {
    // A program in a dialect this build does not have is refused, as Play refuses it: reading it as IEC would put
    // errors that are not in it into the report, and checking the parts without it would call every tag it drives
    // undriven. One error for the scene, so the run fails.
    if (entry.stDialect !== undefined && !isKnownDialect(entry.stDialect)) {
      scenes.push({ project: entry.name, refused: dialectRefusal(entry.stDialect), programNote: null, tags: [], problems: [], unresolvedPackages: [] })
      continue
    }
    for (const p of entry.scene.packages ?? []) registerPackage(p)
    let link
    let programNote = null
    if (entry.stProgram) {
      try {
        // with the table the scene runs from: a PROGRAM instance's tags are `Instance.Name`, while the code outside
        // every PROGRAM keeps its bare names
        // (a program in a dialect this build does not have was refused above)
        link = new LocalPlcLink(runnableSource(entry.stProgram, controllerFor(entry.stProgram, entry.controller, entry.stScanMs ?? 100)))
        // and with the scene's bindings by wiring, as Play attaches it: a program tag a part is wired to is connected
        link = link.withBindings(wiredBindings(entry.scene.parts ?? [], link))
      } catch (e) {
        programNote = `ST program did not compile (${e instanceof Error ? e.message : String(e)}) - run check-st; part-side checks only`
      }
    } else {
      programNote = 'no ST program in this project - part-side checks only'
    }
    const report = checkWiring(entry.scene.parts ?? [], link)
    // a program wholly inside two or more PROGRAMs has only `Main.X` tags (one PROGRAM answers to bare names too,
    // plc/link/plcLink.ts soleInstanceAliases), so every bare tag above reads as undriven-by-nothing-in-particular: say why
    const partTagRefs = (entry.scene.parts ?? []).flatMap((p) => Object.values(p.params ?? {}).filter((v) => typeof v === 'string'))
    const wrapped = entry.stProgram ? wrappedProgramWarning(entry.name, entry.stProgram, [...report.tags.map((t) => t.name), ...partTagRefs]) : null
    if (wrapped) report.problems.push({ severity: 'warning', kind: 'wrapped-program', tag: '', message: wrapped, parts: [] })
    // what the project's tests read and drive answers an `unread` / `undriven` warning
    const { problems, covered } = coverByTests(report.problems, tests.filter((t) => t.project === entry))
    const byTests = covered.map(({ problem, by }) => ({ tag: problem.tag, kind: problem.kind, by, message: problem.message }))
    scenes.push({ project: entry.name, programNote, ...report, problems, byTests })
  }

  const errors = scenes.reduce((n, s) => n + (s.refused ? 1 : 0) + s.problems.filter((p) => p.severity === 'error').length, 0)
  const warnings = scenes.reduce((n, s) => n + s.problems.filter((p) => p.severity === 'warning').length, 0)

  if (asJson) {
    console.log(JSON.stringify({ ok: errors === 0 && (!strict || warnings === 0), errors, warnings, projects: scenes }, null, 2))
  } else {
    for (const s of scenes) {
      if (s.refused) {
        console.log(`\nproject "${s.project}" - not checked`)
        console.log(`  ✗ ${s.refused}`)
        continue
      }
      console.log(`\nproject "${s.project}" - ${s.tags.length} wired tag(s)`)
      if (s.programNote) console.log(`  note: ${s.programNote}`)
      if (s.unresolvedPackages.length > 0) console.log(`  note: package(s) not in the document, signals unknown: ${s.unresolvedPackages.join(', ')}`)
      for (const p of s.problems) console.log(`  ${p.severity === 'error' ? '✗' : '!'} ${p.tag ? `${p.tag}: ` : ''}${p.message}`)
      for (const c of s.byTests) {
        const what = c.kind === 'unread' ? `nothing in the scene reads it; read by ${c.by.join(', ')}` : `nothing in the scene writes it; written by ${c.by.join(', ')}`
        console.log(`  ✓ ${c.tag}: ${what}`)
      }
      if (s.problems.length === 0) console.log('  ✓ no wiring problems')
    }
    console.log(`\n${errors} error(s), ${warnings} warning(s)`)
  }
  process.exitCode = errors > 0 || (strict && warnings > 0) ? 1 : 0
} finally {
  await vite.close()
}
