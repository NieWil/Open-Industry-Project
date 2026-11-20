// Headless Structured-Text check - the CI / pre-commit / agent seam for ST written OUTSIDE the app
// (a VS Code or Claude Code edit of a .st file can be checked without launching the editor):
//
//   npm run check-st -- <path...> [--json]
//
// Each <path> is a .st or .ld FILE or a FOLDER to walk. A project folder works as-is: its program's files (plc/, one
// per POU; program.st in formats 4-6, scenes/<name>.st before format 4) are found by the walk and checked together, as
// the program they make. Dot-folders are skipped, so a repo-root run does not pick up the generated .oracle/
// corpus (which contains deliberately-INVALID programs - the `rejects` cases).
//
// Output is one `path:line:col: message` per diagnostic - the compiler convention every editor and
// agent already parses - followed by a summary. `--json` emits the same data as one object.
// Exit 0 = everything compiles, 1 = at least one diagnostic, 2 = usage/IO error. A scene program whose project.json
// marks it as another dialect (`stDialect`, core/dialect.ts) is refused with the reason rather than checked: this
// version reads IEC 61131-3 only. A warning is printed and never fails the run.
//
// Runs the real src/plc front door through vite's SSR module loader (the repo's programmatic-vite
// pattern, see validate-project.mjs), so there is no second checker to drift from the app:
//   • diagnostics() - the multi-error, recovering pass behind the editor's lint gutter. Note its
//     deliberate anti-cascade rule: if a program has SYNTAX errors, type checking is skipped, so a
//     clean-looking type surface after a syntax error just means it was never reached.
//   • compile() - fail-fast, and the thing the app actually calls to LOAD a program. Run only
//     when diagnostics() is clean, to catch anything that surfaces at build rather than at check.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const targets = argv.filter((a) => a !== '--json')
if (targets.length === 0) {
  console.error('usage: npm run check-st -- <file.st | folder> [...] [--json]')
  process.exit(2)
}

/** Every `.st` and `.ld` under a folder, recursively; dot-folders and node_modules are not walked. */
function walk(dir) {
  let out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      out = out.concat(walk(abs))
    } else if (entry.isFile() && /\.(st|ld)$/i.test(entry.name)) {
      out.push(abs)
    }
  }
  return out
}

// Resolve every target to a file list. An explicitly named file is always taken, even under a
// dot-folder - explicit beats the walk's skip rules.
const files = []
for (const target of targets) {
  let stats
  try {
    stats = statSync(target)
  } catch {
    console.error(`✗ no such file or folder: ${target}`)
    process.exit(2)
  }
  if (stats.isDirectory()) files.push(...walk(resolve(target)))
  else files.push(resolve(target))
}
const unique = [...new Set(files)]

// A file a project's manifest names is part of that project's PROGRAM: format 7 keeps one file per POU, listed in
// order by the manifest's `program`, and a POU may use a type or block another file declares, so the files are checked
// as the app runs them - joined in that order (core/project/projectFolder.ts joinProgramFiles) - and each diagnostic is
// reported at the file and line it was written at. A program may be written for a dialect this version does not
// have (`stDialect`, core/dialect.ts): it is refused with the reason, never checked as IEC. The NEAREST project.json
// above a file decides, and only when it names the file; a loose file, or one no manifest names, is checked alone as
// IEC text.
const manifests = new Map()
function manifestIn(dir) {
  if (!manifests.has(dir)) {
    let m = null
    try {
      m = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
    } catch {
      // absent or unreadable: not a project folder, so the walk goes on up
    }
    // a project manifest: one naming its scene (format 4 on), or one listing scenes (an older folder)
    manifests.set(dir, m && typeof m === 'object' && (typeof m.scene === 'string' || Array.isArray(m.scenes)) ? m : null)
  }
  return manifests.get(dir)
}
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
/** The program files a manifest entry names, in order: format 7's `program` list, or one `stProgram`. */
const programRefs = (entry) =>
  Array.isArray(entry.program) ? entry.program.filter((p) => typeof p === 'string') : typeof entry.stProgram === 'string' ? [entry.stProgram] : []
/** The program `abs` belongs to: its files in order and its dialect, keyed by the manifest entry; a loose file alone. */
function programOf(abs) {
  for (let dir = dirname(abs); ; ) {
    const m = manifestIn(dir)
    if (m) {
      const entries = Array.isArray(m.scenes) ? m.scenes : [m]
      for (const [i, entry] of entries.entries()) {
        if (!entry || typeof entry !== 'object') continue
        const refs = programRefs(entry).map((p) => resolve(dir, p))
        if (refs.some((p) => samePath(p, abs))) {
          return { key: `${dir}#${i}`, files: refs, dialect: typeof entry.stDialect === 'string' ? entry.stDialect : undefined }
        }
      }
      break
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return { key: abs, files: [abs], dialect: undefined }
}
if (unique.length === 0) {
  console.error(`✗ no .st or .ld files found in: ${targets.join(', ')}`)
  process.exit(2)
}
const programs = new Map()
for (const abs of unique) {
  const program = programOf(abs)
  if (!programs.has(program.key)) programs.set(program.key, program)
}

// middlewareMode + appType 'custom': no HTTP server, no HTML handling - just the module runner.
const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  // src/plc has no bare-import deps; without this, vite's scanner walks the whole app entry and
  // complains about plugin-provided virtual modules (the PWA register) our bare config doesn't have
  optimizeDeps: { noDiscovery: true },
})

try {
  const { compile, diagnostics } = await vite.ssrLoadModule('/src/plc/index.ts')
  const { StError } = await vite.ssrLoadModule('/src/plc/types.ts')
  const { dialectRefusal, isKnownDialect } = await vite.ssrLoadModule('/src/core/dialect.ts')
  const { joinProgramFiles, programFileOffset } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')

  // repo-relative where possible (clickable in an editor); absolute for anything outside it, since a "../../../.."
  // chain is worse than the real path
  const shown = (abs) => {
    const rel = relative(repo, abs).split('\\').join('/')
    return rel.startsWith('..') ? abs.split('\\').join('/') : rel
  }
  /** 1-based line and column of `offset` in `text`. */
  const lineCol = (text, offset) => {
    const before = text.slice(0, offset)
    const line = before.split('\n').length
    return { line, col: offset - before.lastIndexOf('\n') }
  }

  const results = []
  for (const program of programs.values()) {
    const at = program.files.map((abs) => ({ abs, path: shown(abs), diagnostics: [] }))
    if (program.dialect !== undefined && !isKnownDialect(program.dialect)) {
      for (const f of at) results.push({ path: f.path, ok: false, diagnostics: [{ line: 1, col: 1, offset: 0, length: 0, message: dialectRefusal(program.dialect) }] })
      continue
    }
    const texts = []
    for (const f of at) {
      try {
        texts.push(readFileSync(f.abs, 'utf8'))
      } catch {
        f.diagnostics.push({ line: 1, col: 1, offset: 0, length: 0, message: 'unreadable file' })
        texts.push('')
      }
    }
    const source = joinProgramFiles(texts)
    /** a diagnostic at `offset` in the joined program, filed under the file it falls in */
    const report = (offset, d) => {
      const place = programFileOffset(texts, offset)
      const { line, col } = lineCol(texts[place.file], place.offset)
      at[place.file].diagnostics.push({ ...d, line, col, offset: place.offset })
    }
    const found = diagnostics(source)
    for (const d of found) report(d.pos.offset, { length: d.length, message: d.message, ...(d.severity ? { severity: d.severity } : {}) })
    // Clean under the recovering pass - now prove it LOADS. compile() is fail-fast, so this adds at
    // most one diagnostic, and only for errors raised past the checker.
    if (found.every((d) => d.severity === 'warning')) {
      try {
        compile(source)
      } catch (e) {
        if (e instanceof StError) {
          report(e.pos.offset, { length: e.length, message: e.message })
        } else {
          // Not a source-level error: a bug in the toolchain, not in the program. Surface it as
          // itself rather than blaming the file, and still fail.
          at[0].diagnostics.push({ line: 1, col: 1, offset: 0, length: 0, message: `internal error: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
    }
    for (const f of at) results.push({ path: f.path, ok: f.diagnostics.every((d) => d.severity === 'warning'), diagnostics: f.diagnostics })
  }

  const bad = results.filter((r) => !r.ok)
  const total = bad.reduce((n, r) => n + r.diagnostics.filter((d) => d.severity !== 'warning').length, 0)

  if (asJson) {
    console.log(JSON.stringify({ ok: bad.length === 0, files: results.length, errors: total, results }, null, 2))
  } else {
    for (const r of results) {
      for (const d of r.diagnostics) if (!r.ok || d.severity === 'warning') console.error(`${r.path}:${d.line}:${d.col}: ${d.severity === 'warning' ? 'warning: ' : ''}${d.message}`)
    }
    if (bad.length === 0) {
      console.log(`✓ ${results.length} program file(s) compile`)
    } else {
      console.error(`✗ ${total} error(s) in ${bad.length} of ${results.length} file(s)`)
    }
  }
  process.exitCode = bad.length === 0 ? 0 : 1
} finally {
  await vite.close()
}
