// Build parts from their part.js sources, or check that the files beside each one match it.
//
//   npm run build-parts                     build every examples/parts/<dir>/ that has a part.js
//   npm run build-parts -- box turntable    build the named ones (a bare name is an examples/parts/ folder)
//   npm run build-parts -- <path>...        build the part folder at <path> (any folder holding a part.js: a
//                                           project's parts/<slug>/, a library's source folder)
//   npm run build-parts -- --check [...]    write nothing; exit 1 if a built file differs from what its part.js
//                                           produces (the CI drift guard)
//   npm run build-parts -- <path> --force   overwrite a part folder's files even when they changed after its sources
//
// A part's source is <folder>/part.js. Its definePart() holds everything: `manifest` (the manifest minus its geometry,
// or with a static geometry), `rig(params)` (links, joints and bounds computed from the params), the params,
// geometry() and step(). It may import other modules by relative path (examples/parts/_shared/ here, a project's
// parts/_shared/). From it this writes (scripts/lib/buildPart.mjs):
//   behavior.js   part.js with its imports joined in and `manifest` / `rig()` left out (scripts/lib/bundlePart.mjs),
//                 the script the app ships
//   manifest.json the manifest, its rig compiled from rig() (src/core/rig/rigCompile.ts)
// In this repo's examples/parts/<dir>/ the same two files are named behavior.ts and rig.json, as the built-ins have
// always been. Both are OUTPUT: in a folder with a part.js, edit the part.js, and --check fails on an edit made to
// either file. A folder with no part.js is hand-authored: its manifest and behavior are the source.
//
// Why the check exists: the output is the file anyone, most often an agent, opens first, and a change made there is
// silently reverted by the next build. With the check, that drift fails CI and says which source to edit.
//
// In a part folder outside examples/parts/, the app also writes those two files: the Part Editor and the agent tools
// edit a project's part through its manifest.json and behavior.js, and never read or change its part.js. A build there
// would undo such an edit, so a build refuses to overwrite a file that differs from the build and is newer than every
// source file it is built from, and says to move the change into part.js first (or pass --force).

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { buildPart, hasPartSource, isExamplePart } from './lib/buildPart.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const partsDir = join(repo, 'examples', 'parts')
const args = process.argv.slice(2)
const check = args.includes('--check')
const force = args.includes('--force')
const wanted = args.filter((a) => !a.startsWith('--'))
// npm runs a script from the repo root; a relative path is the caller's
const cwd = process.env.INIT_CWD || process.cwd()

const sourced = readdirSync(partsDir)
  .filter((d) => hasPartSource(join(partsDir, d)))
  .sort()
// a bare name is an examples/parts/ folder; anything with a slash (or `.`) is a path
const isPath = (a) => /[\\/]/.test(a) || a === '.' || a === '..'
const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const unknown = []
const builds = [] // { dir, label, example }
for (const w of wanted.length ? wanted : sourced) {
  if (!isPath(w)) {
    if (sourced.includes(w)) builds.push({ dir: join(partsDir, w), label: w, example: true })
    else unknown.push(`${w} (no examples/parts/${w}/part.js)`)
    continue
  }
  const dir = resolve(cwd, w)
  if (!isDir(dir) || !hasPartSource(dir)) {
    unknown.push(`${w} (no part.js there)`)
    continue
  }
  const example = isExamplePart(dir, repo)
  builds.push({ dir, label: example ? basename(dir) : w.replace(/\\/g, '/').replace(/\/$/, ''), example })
}
if (unknown.length) {
  console.error(`unknown part: ${unknown.join(', ')}\nexamples with a part.js: ${sourced.join(' ')}`)
  process.exit(2)
}

// core is TypeScript, so it loads through vite
const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
const broken = []
const stale = [] // { label, path }
const edited = [] // { label, path }: changed after the sources, so a build would undo that change
try {
  const { instantiatePartScript } = await vite.ssrLoadModule('/src/core/parts/partScript.ts')
  const { compileRig } = await vite.ssrLoadModule('/src/core/rig/rigCompile.ts')
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const read = (path) => {
    try {
      return norm(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }
  for (const b of builds) {
    const built = buildPart(b.dir, repo, { instantiatePartScript, compileRig })
    if (!built.files) {
      broken.push(...built.problems.map((p) => `${b.label}: ${p}`))
      continue
    }
    const shown = (file) => (b.example ? `examples/parts/${b.label}/${file}` : `${b.label}/${file}`)
    const differ = built.files.filter((f) => read(join(b.dir, f.name)) !== f.text)
    if (check) {
      for (const f of differ) stale.push({ label: b.label, path: shown(f.name) })
      continue
    }
    if (!b.example && !force) {
      const sourcesAt = Math.max(...built.modules.map((m) => statSync(m).mtimeMs))
      const newer = differ.filter((f) => read(join(b.dir, f.name)) !== null && statSync(join(b.dir, f.name)).mtimeMs > sourcesAt)
      if (newer.length) {
        for (const f of newer) edited.push({ label: b.label, path: shown(f.name) })
        continue
      }
    }
    for (const f of differ) {
      const path = join(b.dir, f.name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, f.text)
    }
    console.log(`✓ ${b.example ? `examples/parts/${b.label}` : b.label}`)
  }
} finally {
  await vite.close()
}

if (broken.length) {
  console.error(`✗ a part didn't build:\n${broken.map((b) => `  ${b}`).join('\n')}`)
  process.exit(1)
}
if (edited.length) {
  console.error('✗ these files changed after the part.js they are built from, so a build would undo that change:\n')
  for (const e of edited) console.error(`  ${e.path}`)
  console.error(
    '\nThe app (the Part Editor, an agent tool) edits a part through these files and never changes its part.js.\n' +
      'Move the change into the part.js (or the shared module it imports) and build again, or discard it:\n' +
      `  npm run build-parts -- ${[...new Set(edited.map((e) => e.label))].join(' ')} --force\n`,
  )
  process.exit(1)
}
if (!check) {
  console.log(`\n${builds.length} part${builds.length === 1 ? '' : 's'} built`)
  process.exit(0)
}
if (stale.length) {
  console.error('✗ built part files differ from what their part.js produces:\n')
  for (const s of stale) console.error(`  ${s.path}`)
  console.error(
    '\nThese files are OUTPUT. Put the change in the part.js (or the shared module it imports) and build again:\n' +
      `  npm run build-parts -- ${[...new Set(stale.map((s) => s.label))].join(' ')}\n` +
      'A change the app made to a part folder (the Part Editor, an agent tool) belongs in its part.js too, or the build undoes it.\n',
  )
  process.exit(1)
}
console.log(builds.length === 1 ? '✓ the built part matches its source' : `✓ ${builds.length} built parts match their sources`)
