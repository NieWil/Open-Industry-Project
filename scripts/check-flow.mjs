// What physically happens on a project's line: run its scene and its own program headless and list the FLOW FACTS
// (src/core/flow/flowFacts.ts, docs/project-tests.md "Flow facts") - boxes dropped to the floor or lost off the world,
// boxes tipped, sensor beams flickering (with the tags that toggled), boxes sitting still on a running conveyor.
//
//   npm run check-flow -- <project-folder> [--seconds 30] [--input <tag>=<value>[@<t>]]... [--json]
//
// Facts, not verdicts: an accumulating line holds boxes still on purpose, and that is listed too, for the reader to
// weigh. `--input` sets a program input the way a test's `inputs` do (a Start press: `--input Start=true@0.5
// --input Start=false@1`); with none the program runs on what the scene's own parts tell it.
// Exit 0 = it ran (whatever the facts), 2 = usage, 3 = the project does not load or cannot run.

import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { readProjectFolder } from './lib/projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const USAGE = 'usage: npm run check-flow -- <project-folder> [--seconds 30] [--input <tag>=<value>[@<t>]]... [--json]'
const EXIT_USAGE = 2
const EXIT_UNRUNNABLE = 3
const valued = new Set(['--seconds', '--input'])
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const seconds = flag('--seconds') === null ? 30 : Number(flag('--seconds'))
const json = args.includes('--json')
const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))

// --input Tag=value[@t], repeatable: true/false, or a number; at t (s), default 0
const inputs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--input') continue
  const m = /^([^=@]+)=([^@]+)(?:@([0-9.]+))?$/.exec(args[i + 1] ?? '')
  const raw = m?.[2]?.trim()
  const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw)
  if (!m || (typeof value === 'number' && !Number.isFinite(value))) {
    console.error(`✗ --input ${args[i + 1] ?? ''}: expected <tag>=<true|false|number>[@<seconds>]`)
    process.exit(EXIT_USAGE)
  }
  inputs.push({ at: m[3] === undefined ? 0 : Number(m[3]), tag: m[1].trim(), value })
}
if (!target || !Number.isFinite(seconds) || seconds <= 0) {
  console.error(USAGE)
  process.exit(EXIT_USAGE)
}
try {
  if (!statSync(target).isDirectory()) throw new Error()
} catch {
  console.error(`✗ not a project folder: ${target}`)
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

try {
  await declareBuiltIns(vite)
  const { folderFilesToProject } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
  const { runProjectTest } = await vite.ssrLoadModule('/src/editor/project/projectTestRunner.ts')
  const { FLOW_FACT_KINDS, summarizeFlowFacts } = await vite.ssrLoadModule('/src/core/flow/flowFacts.ts')
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
  // a folder from before a project held one scene splits on read; this runs the project it opens as
  const project = loaded.project
  if (loaded.splitOff?.length) console.error(`note: this folder holds ${loaded.splitOff.length + 1} scenes, from before a project held one; running "${project.name}"`)

  const Jolt = await initJolt()
  let result
  try {
    // a run with no checks: the scene, its program, the given inputs, for `seconds` - the runner a test uses, so the
    // line runs exactly as `test-project` and Play run it
    result = runProjectTest(Jolt, project, { duration: seconds, inputs, checks: [] })
  } catch (e) {
    console.error(`✗ the project cannot run: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(EXIT_UNRUNNABLE)
  }
  const facts = [...result.facts].sort((a, b) => a.t - b.t || a.id - b.id)
  if (json) {
    console.log(JSON.stringify({ project: project.name, seconds, inputs, summary: summarizeFlowFacts(facts, result.factsOverflow), facts, ...(result.factsOverflow > 0 ? { overflow: result.factsOverflow } : {}) }, null, 2))
  } else {
    console.log(`${project.name}: ${seconds} s${inputs.length ? `, inputs ${inputs.map((i) => `${i.tag}=${i.value}@${i.at}`).join(' ')}` : ''}`)
    console.log(`flow facts: ${summarizeFlowFacts(facts, result.factsOverflow)}`)
    for (const kind of FLOW_FACT_KINDS) {
      const of = facts.filter((f) => f.kind === kind)
      if (of.length === 0) continue
      console.log(`\n${kind} (${of.length}):`)
      for (const f of of) console.log(`  t=${f.t.toFixed(3)}s  ${f.message}  [${f.at.join(', ')}]`)
    }
  }
} finally {
  await vite.close()
}
process.exit(0)
