// Headless LAYOUT check: does every part that seats onto something sit on something, and does any stand in a
// building column?
//
//   npm run check-layout -- <project-folder | project.json | scene.json> [--strict] [--json]
//
// The check itself is src/core/checkLayout.ts (its header says why it reports DISCONNECTION, not collision); this is
// its CLI. Errors fail the run (exit 1). Warnings are reported and do not, unless --strict: a conveyor end placed
// against a spur's side (a spur takes end joins only, so its guard stays closed there), and a box feed dropping onto
// a belt the program starts and stops without being held with that belt (boxes stack on the stopped belt). The feed
// check needs to know which tags are DRIVEN, so the project's ST program is compiled here the way
// check-wiring does; a program that does not compile leaves it unchecked, and says so. Exit 2 = usage/IO error.

import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { readProjectFolder } from './lib/projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const strict = argv.includes('--strict')
const target = argv.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('usage: npm run check-layout -- <project-folder | project.json | scene.json> [--strict] [--json]')
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
  const { checkLayout, exerciseProgram, formatLayoutFinding } = await vite.ssrLoadModule('/src/core/checkLayout.ts')
  const { checkWiring, wiredBindings } = await vite.ssrLoadModule('/src/plc/wiring.ts')
  const { LocalPlcLink } = await vite.ssrLoadModule('/src/plc/link/plcLink.ts')
  const { controllerFor, runnableSource } = await vite.ssrLoadModule('/src/plc/controller.ts')
  const { isKnownDialect } = await vite.ssrLoadModule('/src/core/dialect.ts')

  // The tags something drives (the program's outputs, a part's `out` tag), as check-wiring reads them: what the box
  // feed check needs to tell a belt the program stops from one that runs on its own. Null when it cannot be known.
  const drivenTagsOf = (entry) => {
    const parts = entry.scene.parts ?? []
    let link
    if (entry.stProgram) {
      if (entry.stDialect !== undefined && !isKnownDialect(entry.stDialect)) return { tags: null, note: 'program in an unknown dialect: box feeds not checked' }
      try {
        link = new LocalPlcLink(runnableSource(entry.stProgram, controllerFor(entry.stProgram, entry.controller, entry.stScanMs ?? 100)))
        link = link.withBindings(wiredBindings(parts, link))
      } catch {
        return { tags: null, note: 'ST program did not compile (run check-st): box feeds not checked' }
      }
    }
    const report = checkWiring(parts, link)
    return { tags: new Set(report.tags.filter((t) => t.programWrites || t.writers.length > 0).map((t) => t.name)), note: null, link }
  }

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
  if (stats.isDirectory()) {
    const result = folderFilesToProject(readProjectFolder(target), { bakePart })
    if (!result.ok) {
      console.error(`✗ ${target} does not load - run validate-project for the details`)
      process.exit(1)
    }
    project = result.project
    entries = [result.project, ...(result.splitOff ?? [])]
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
      project = { name: '(standalone scene)', scene: scene.scene, packages: [] }
      entries = [project]
    } else {
      const result = validateProject(data)
      if (!result.ok) {
        console.error(`✗ ${target} does not load - run validate-project for the details`)
        process.exit(1)
      }
      project = result.project
      entries = [result.project, ...(result.splitOff ?? [])]
    }
  }

  for (const p of project.packages ?? []) registerPackage(p, true)

  // per project (and, for a document from before a project held one scene, the projects its other scenes become):
  // register its own placement snapshots first - both the footprint and the snap
  // declaration are resolved through the registry, so an unregistered package measures as nothing
  // and its parts drop silently out of the check rather than being reported as unseated
  const scenes = []
  for (const entry of entries) {
    for (const p of entry.scene.packages ?? []) registerPackage(p)
    const parts = entry.scene.parts ?? []
    const driven = drivenTagsOf(entry)
    let feedRunsWithoutBelt
    if (driven.link) {
      let probe = null
      // only built if a feed asks: most projects have none
      feedRunsWithoutBelt = (a, b) => {
        try {
          probe ??= exerciseProgram(driven.link, (entry.stScanMs ?? 100) / 1000)
        } catch {
          return undefined
        }
        return probe(a, b)
      }
    }
    const findings = checkLayout(parts, driven.tags ? { drivenTags: driven.tags, feedRunsWithoutBelt } : {})
    scenes.push({ project: entry.name, parts: parts.length, findings, ...(driven.note ? { note: driven.note } : {}) })
  }

  const all = scenes.flatMap((s) => s.findings)
  const errors = all.filter((f) => f.severity === 'error').length
  const warnings = all.length - errors

  if (asJson) {
    console.log(JSON.stringify({ ok: errors === 0 && (!strict || warnings === 0), errors, warnings, projects: scenes }, null, 2))
  } else {
    for (const s of scenes) {
      console.log(`\nproject "${s.project}" - ${s.parts} part(s)`)
      if (s.note) console.log(`  note: ${s.note}`)
      for (const f of s.findings) console.log(`  ${f.severity === 'error' ? '✗' : '!'} ${formatLayoutFinding(f)}`)
      if (s.findings.length === 0) console.log('  ✓ every part that needs a host has one, none stands in a building column, and no box feed drops loose onto a belt the program stops')
    }
    // Printed because a pass here is easy to over-read: this check answers one question, and a scene
    // can still be wrong in ways nothing checks (see docs: geometry is barely graded).
    console.log(`\n${errors} error(s), ${warnings} warning(s). This checks SEATING, building COLUMNS, conveyor ends against a spur's side and box feeds onto driven belts only - it does not judge spacing, orientation or flow.`)
  }
  process.exitCode = errors > 0 || (strict && warnings > 0) ? 1 : 0
} finally {
  await vite.close()
}
