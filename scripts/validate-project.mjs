// Headless project/scene validation - the CI / pre-commit / agent seam for externally edited
// documents (a VS Code or Claude Code edit of a project folder can be checked without launching
// the app):
//
//   npm run validate-project -- <path> [--strict] [--write]
//
// <path> is one of:
//   • a project FOLDER   (project.json + scene.json + plc/ + parts/ - the Electron "Save Project to Folder" layout)
//   • a project DOCUMENT (.oip / .json - the single-file form)
//   • a standalone scene.json
//
// A document that loads can still have been REPAIRED to load: an out-of-range number clamped, a param key
// that names nothing (a typo) dropped, a parent link to a missing part cut. The app applies those silently,
// so this is where they are read: each is printed as a warning, and --strict fails on them, for a pre-commit
// hook or an agent that wants "what the file says is what runs". --write (a project folder only) removes from the
// folder's scene file the param keys loading drops, such as one a part's newer version no longer declares, and no other
// value, in it or in any other file. It writes the file back in the app's own layout (two-space JSON): a file the app
// saved comes back unchanged but for those keys, and one laid out by hand is reformatted, which it says. Rewriting the
// whole scene as the app saves it would also write out every default, which pins the project to today's defaults.
//
// A scene whose program is written for a dialect this version does not have (core/dialect.ts) loads, since the app
// keeps it unchanged, but cannot run: it is listed with the reason and fails the check.
//
// Exit 0 = valid, 1 = invalid (or unrunnable, or repaired with --strict), 2 = usage/IO error. Runs the REAL src/core validators through vite's
// SSR module loader (the repo's programmatic-vite pattern, see build-embedded-plc.mjs), so there is
// no second validator implementation to drift from the app.

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { readProjectFolder } from './lib/projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const strict = args.includes('--strict')
const write = args.includes('--write')
const target = args.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('usage: npm run validate-project -- <project-folder | project.oip | scene.json> [--strict] [--write]')
  process.exit(2)
}

let stats
try {
  stats = statSync(target)
} catch {
  console.error(`✗ no such file or folder: ${target}`)
  process.exit(2)
}

// middlewareMode + appType 'custom': no HTTP server, no HTML handling - just the module runner.
const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  // core has no bare-import deps; without this, vite's scanner walks the whole app entry and
  // complains about plugin-provided virtual modules (the PWA register) our bare config doesn't have
  optimizeDeps: { noDiscovery: true },
})

try {
  // the app's built-in parts: a format-3 project names them by id and keeps no copy (scripts/lib/builtIns.mjs)
  await declareBuiltIns(vite)
  const { folderFilesToProject, unreferencedProjectFiles } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
  const { isZipData, oipBytesToProject } = await vite.ssrLoadModule('/src/core/project/projectArchive.ts')
  const { validateProject } = await vite.ssrLoadModule('/src/core/project/project.ts')
  const { validateScene } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
  const { dialectRefusal, isKnownDialect } = await vite.ssrLoadModule('/src/core/dialect.ts')
  const { wrappedProgramWarning } = await vite.ssrLoadModule('/src/plc/sceneProgram.ts')
  const { builtInPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
  const { summarizeLibrary, describeLibraryEntry } = await vite.ssrLoadModule('/src/core/parts/partLibrarySummary.ts')
  // The part baker: rebuilds each parts/<id>/ folder by RUNNING its behavior.js (under the core
  // determinism sandbox) through the canonical validator - so an edited script's syntax/determinism/
  // param errors fail validation here instead of surfacing at sim time in the app.
  const { validatePart, formatPartDiagnostics } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
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

  let result // ProjectValidationResult, or a scene result adapted to the same shape
  let kind = 'project'
  // Files the manifest never names. Loading is manifest-driven, so these had no effect -
  // reported because the alternative is silence, and an ignored file looks exactly like an applied one.
  let ignored = []
  if (stats.isDirectory()) {
    const folderFiles = readProjectFolder(target)
    ignored = unreferencedProjectFiles(folderFiles)
    result = folderFilesToProject(folderFiles, { bakePart })
  } else if (isZipData(readFileSync(target).subarray(0, 2))) {
    // a current-format .oip: the project folder, zipped - same codec + part baking as a folder
    result = await oipBytesToProject(new Uint8Array(readFileSync(target)), { bakePart })
  } else {
    let data
    try {
      data = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      console.error(`✗ ${target} is not valid JSON`)
      process.exit(1)
    }
    // A scene document has `parts` and no `scene`/`scenes` - validate it as what it is instead of failing
    // it against the project shape.
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.parts) && !data.scenes && data.scene === undefined) {
      kind = 'scene'
      const scene = validateScene(data)
      result = scene.ok
        ? {
            ok: true,
            project: {
              name: '(standalone scene)',
              scene: scene.scene,
              ...(scene.stProgram ? { stProgram: scene.stProgram } : {}),
              ...(scene.stDialect !== undefined ? { stDialect: scene.stDialect } : {}),
              packages: [],
            },
            repairs: scene.repairs,
          }
        : { ok: false, errors: scene.errors }
    } else {
      result = validateProject(data)
    }
  }

  if (!result.ok) {
    console.error(`✗ invalid ${kind}: ${target}`)
    for (const err of result.errors) console.error(`  - ${err}`)
    process.exit(1)
  }
  const p = result.project
  // The project, and - for a document from before a project held one scene - the projects its other scenes become
  // when the app opens it (core/project/project.ts `splitOff`). Each is checked below as the project it will be.
  const machines = [p, ...(result.splitOff ?? [])]
  if (kind === 'scene') {
    console.log(`✓ valid scene - ${p.scene.parts.length} part(s)`)
  } else {
    const program = (m) => (!m.stProgram ? '' : m.stDialect !== undefined ? `, program in the "${m.stDialect}" dialect` : ', ST program')
    // the library holds a copy of every part the project uses, built-ins included (stamped `origin.app`,
    // docs/part-sources.md): those are named as copies with the version they were copied at, apart from authored parts
    const library = summarizeLibrary(p.packages ?? [], builtInPackage)
    const copies = library.filter((e) => e.kind === 'builtInCopy')
    const authored = library.filter((e) => e.kind === 'authored')
    console.log(`✓ valid project "${p.name}" - ${p.scene.parts.length} part(s)${program(p)}, ${copies.length} built-in part cop${copies.length === 1 ? 'y' : 'ies'}, ${authored.length} authored part(s)`)
    for (const [title, list] of [['built-in copies', copies], ['authored', authored]]) {
      if (list.length === 0) continue
      console.log(`  ${title}:`)
      for (const e of list) console.log(`    - ${describeLibraryEntry(e)}`)
    }
    if (result.splitOff) {
      console.log(`  note: this document holds ${machines.length} scenes, from before a project held one. Opening it in the app splits it:`)
      console.log(`    "${p.name}" keeps the scene that was active; these become projects of their own:`)
      for (const m of result.splitOff) console.log(`    - "${m.name}" (${m.scene.parts.length} parts${program(m)})`)
    }
    if (result.migratedFromV1) console.log('  note: v1 document - the app will migrate it on load')
    // Unlisted tests are the one half-truth here: the APP doesn't load them, but test-project globs tests/
    // when the manifest lists none (docs/project-tests.md), so "they do nothing" sent agents chasing a
    // contradiction. Say both.
    let listsTests = false
    try {
      listsTests = Array.isArray(JSON.parse(readFileSync(join(target, 'project.json'), 'utf8')).tests)
    } catch {
      // the codec already accepted the manifest; unreadable here just means "assume it lists none"
    }
    const unlistedTests = listsTests ? [] : ignored.filter((f) => f.startsWith('tests/'))
    const inert = ignored.filter((f) => !unlistedTests.includes(f))
    if (inert.length > 0) {
      console.log(`  note: ${inert.length} file(s) in the folder are not referenced by project.json, so they do nothing:`)
      for (const f of inert) console.log(`    - ${f}`)
      console.log('    reference it from project.json (its "program" list, or a part folder in "packages") for it to take effect')
    }
    if (unlistedTests.length > 0) {
      console.log(`  note: ${unlistedTests.length} test file(s) are not listed in project.json "tests":`)
      for (const f of unlistedTests) console.log(`    - ${f}`)
      console.log('    `npm run test-project` still runs them (it globs tests/ when the manifest lists none), but the')
      console.log('    project does not CARRY them: the app, a share link and an .oip leave them out. List them to fix that.')
    }
  }
  // A program written for a dialect this build does not have LOADS (the document is well formed, and the app keeps
  // it as written) but will not run: Play refuses it. So it is listed, per project, and fails the check, because a
  // document that validates here should be one whose logic this build can run.
  const foreign = machines.filter((m) => m.stDialect !== undefined && !isKnownDialect(m.stDialect))
  for (const m of foreign) console.error(`  ✗ "${m.name}": ${dialectRefusal(m.stDialect)}`)
  if (foreign.length > 0) {
    console.error(`✗ ${foreign.length} program(s) in a dialect this version cannot run`)
    process.exitCode = 1
  }
  // A program that loads and runs but drives nothing a part is wired to (plc/sceneProgram.ts) - the
  // costliest silent failure an author can write, so it is named here, where every edit gets checked.
  const programWarnings = machines
    .filter((m) => m.stProgram && (m.stDialect === undefined || isKnownDialect(m.stDialect)))
    .map((m) => wrappedProgramWarning(m.name, m.stProgram, (m.scene.parts ?? []).flatMap((part) => Object.values(part.params ?? {}).filter((v) => typeof v === 'string'))))
    .filter(Boolean)
  for (const w of programWarnings) console.log(`  warning: ${w}`)
  if (strict && programWarnings.length > 0) {
    console.error(`✗ --strict: ${programWarnings.length} program(s) bind no part tag`)
    process.exitCode = 1
  }
  const repairs = result.repairs ?? []
  if (repairs.length > 0) {
    console.log(`  warning: loading changed ${repairs.length} thing(s) the file says, so what runs is not what it says:`)
    for (const r of repairs) console.log(`    - ${r}`)
    // what loading still repairs after --write, read from the folder again rather than counted: a removed key and a
    // repair message are not one to one
    let remaining = repairs
    if (write && stats.isDirectory()) {
      const w = dropUnknownParams(p.scene.parts)
      if (w.error) {
        console.error(`  ✗ --write: ${w.error}`)
        process.exitCode = 1
      } else if (w.dropped > 0) {
        const again = folderFilesToProject(readProjectFolder(target), { bakePart })
        remaining = again.ok ? (again.repairs ?? []) : repairs
        console.log(`  --write: removed ${w.dropped} param key(s) from the scene file; ${remaining.length} repair(s) remain`)
      }
    }
    if (strict && remaining.length > 0) {
      console.error(`✗ --strict: ${remaining.length} repair(s) on load`)
      process.exitCode = 1
    }
  }
  if (write && !stats.isDirectory()) console.log('  note: --write saves a project folder only, so nothing was written')
} finally {
  await vite.close()
}

/**
 * --write: delete from the folder's scene file each param key the loaded part does not have. Returns how many, or why
 * nothing was written: a folder from before a project held one scene names several scene files (`scenes`), which the
 * app converts on open, and this edits only the one-scene layout.
 */
function dropUnknownParams(loaded) {
  const manifest = JSON.parse(readFileSync(join(target, 'project.json'), 'utf8'))
  if (typeof manifest.scene !== 'string') return { dropped: 0, error: 'this folder lists several scenes (a project from before one scene per project). Open it in the app and save it, then run --write again' }
  const file = join(target, manifest.scene)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { dropped: 0, error: `could not read ${manifest.scene}` }
  }
  const byId = new Map(loaded.map((part) => [part.id, part]))
  let dropped = 0
  for (const part of Array.isArray(raw.parts) ? raw.parts : []) {
    const kept = byId.get(part?.id)?.params
    if (!kept || !part.params || typeof part.params !== 'object') continue
    for (const key of Object.keys(part.params)) {
      if (key in kept) continue
      delete part.params[key]
      dropped++
    }
  }
  if (dropped === 0) return { dropped }
  const text = readFileSync(file, 'utf8')
  const layoutKept = text === JSON.stringify(JSON.parse(text), null, 2) + '\n'
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
  if (!layoutKept) console.log(`  note: ${manifest.scene} was not in the app's layout, so --write reformatted it (two-space JSON) as well`)
  return { dropped }
}
