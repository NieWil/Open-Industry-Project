// Build or extend a part library: an index.json beside one .oippart per part version (docs/part-libraries.md).
//
//   npm run build-library -- <out-dir> --id <library-id> --name <name> (--from <dir> | --category <c> | --part <id>...)
//                            [--listed --namespaces <file>] [--published YYYY-MM-DD] [--dry]
//
// The parts are a folder of part sources (`--from libraries/<library>`: one part folder each, manifest.json +
// behavior.js, the layout a project's parts/ uses; its picture beside it as thumbnail.webp, npm run thumbnails --
// --libraries), or the app's built-ins (scripts/lib/builtIns.mjs), chosen by catalog category or by id. Each part is
// packed as a .oippart with its models and textures inside it as files, read from public/part-assets/ by hash, and its
// catalog picture (public/thumbnails/pkg/) goes beside it as <id>/<sha256>.webp.
//
// Append-only, like the published library: an existing index.json in <out-dir> is read, a part whose newest listed
// version is the same part (same fingerprint) gets nothing new, and a changed part gets a new version beside the old
// ones. Files are named by their hash and never overwritten. The one change to a listed version is its picture: an
// unchanged part's newest version takes the current one.
//
// Every version written is read back the way the app installs it (unzip, build, checkLibraryDownload), so a file
// that would not install as the version the index lists fails here, not on a user's machine. A new version must also
// be in the old-parts corpus (test-corpus/parts/, scripts/part-corpus.mjs), which every build runs, so a published
// version is never one a later build is free to break.
//
// --listed packs the listed library from the parts repository (docs/part-libraries.md, "Publishing"): parts other
// people published, which are not in this repository's corpus. Each folder is named by its part id. The rules of
// core/parts/partSubmission.ts apply, the publisher is read from the id and the namespace file (--namespaces), and each new version's behaviour digest
// (sim/partBehaviour.ts) is recorded in the index: oip-web's CI runs every listed version against it
// (scripts/library-corpus.mjs), which makes it a version every later build keeps.
//
// The index it writes is unsigned (an earlier signature is dropped, since the index changed): signing is
// scripts/sign-library.mjs, a separate step that runs no part code, so the process that holds the project's key never
// runs a part.
//
// Exit 0 = written (or nothing new), 1 = a part failed to pack, read back or is not in the corpus, 2 = usage/IO error.
/* global process, console */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { bakeFolder } from './lib/projectLibrary.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const many = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []))
const valued = new Set(['--id', '--name', '--category', '--part', '--published', '--from', '--namespaces'])
const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))

const outDir = positional[0]
const libraryId = flag('--id')
const libraryName = flag('--name')
const category = flag('--category')
const partIds = many('--part')
const fromDir = flag('--from')
const published = flag('--published') ?? new Date().toISOString().slice(0, 10)
const dry = argv.includes('--dry')
const listed = argv.includes('--listed')
const namespacesPath = flag('--namespaces')
if (!outDir || !libraryId || !libraryName || (!fromDir && !category && partIds.length === 0) || (listed && (!fromDir || !namespacesPath))) {
  console.error('usage: npm run build-library -- <out-dir> --id <library-id> --name <name> (--from <dir> | --category <c> | --part <id>...) [--listed --namespaces <file>] [--published YYYY-MM-DD] [--dry]')
  process.exit(2)
}

// The shipped bytes of every first-party asset, by SHA-256 (public/part-assets/<sha256>.<ext>, scripts/bake-part-assets.mjs).
const assetsDir = join(repo, 'public', 'part-assets')
const assetFiles = new Map(
  (existsSync(assetsDir) ? readdirSync(assetsDir) : []).flatMap((f) => {
    const m = /^([0-9a-f]{64})\.[a-z0-9]+$/.exec(f)
    return m ? [[m[1], join(assetsDir, f)]] : []
  }),
)
const assetBytes = (sha256) => {
  const path = assetFiles.get(sha256)
  return path ? new Uint8Array(readFileSync(path)) : undefined
}

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

let failed = 0
try {
  const { partToOippartBytes, oippartBytesToFolder } = await vite.ssrLoadModule('/src/core/parts/partArchive.ts')
  const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
  const { partFingerprint, storedPackageHash } = await vite.ssrLoadModule('/src/core/parts/partOrigin.ts')
  const { sha256HexOfBytes } = await vite.ssrLoadModule('/src/core/sha256.ts')
  const { LIBRARY_INDEX_FORMAT, checkLibraryDownload, validateLibraryIndex } = await vite.ssrLoadModule('/src/core/parts/partLibrary.ts')
  const { PART_SDK_LEVEL } = await vite.ssrLoadModule('/src/core/parts/partSdk.ts')
  const { packageThumbFile } = await vite.ssrLoadModule('/src/core/parts/partPackage.ts')
  const { publisherOf, submissionProblems } = await vite.ssrLoadModule('/src/core/parts/partSubmission.ts')
  const thumbsDir = join(repo, 'public', 'thumbnails', 'pkg')
  const namespaces = listed ? JSON.parse(readFileSync(namespacesPath, 'utf8')) : null
  // a listed version records what it does alone, measured as the old-parts corpus measures (sim/partBehaviour.ts)
  let behaviourOf = null
  if (listed) {
    // other people's code: it runs sandboxed, as in the app (core/realmLockdown.ts, docs/part-sandbox.md)
    const { lockdownRealm } = await vite.ssrLoadModule('/src/core/realmLockdown.ts')
    if (!lockdownRealm()) throw new Error('could not lock the realm down; refusing to run listed parts unsandboxed')
    const { runPartAlone } = await vite.ssrLoadModule('/src/sim/partBehaviour.ts')
    const initJolt = (await vite.ssrLoadModule('jolt-physics')).default
    const Jolt = await initJolt()
    const { packages: builtIns } = await declareBuiltIns(vite)
    behaviourOf = (pkg) => runPartAlone(Jolt, pkg, { others: builtIns })
  }

  // what to pack, each with where its picture is
  const chosen = []
  if (fromDir) {
    // a folder of part sources: every sub-folder that is a part
    for (const dir of readdirSync(fromDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const at = join(fromDir, dir.name)
      const r = await bakeFolder(vite, at)
      if ('error' in r) {
        console.error(`  ✗ ${at}: ${r.error}`)
        failed++
        continue
      }
      // a paragraph of plain text beside the source says what the part is (Get parts shows it)
      const descPath = join(at, 'description.txt')
      const description = existsSync(descPath) ? readFileSync(descPath, 'utf8').trim().replace(/\s+/g, ' ') : undefined
      const extra = {}
      if (listed) {
        // the parts repository's layout: the folder is the part's id
        if (dir.name !== r.pkg.id) {
          console.error(`  ✗ ${at}: the folder must be named by the part's id (${r.pkg.id})`)
          failed++
          continue
        }
        const publisher = publisherOf(r.pkg.id, namespaces)
        if (!publisher) {
          console.error(`  ✗ ${r.pkg.id}: its namespace is not in ${namespacesPath}`)
          failed++
          continue
        }
        extra.publisher = publisher
      }
      chosen.push({ pkg: r.pkg, thumb: join(at, 'thumbnail.webp'), ...(description ? { description } : {}), ...extra })
    }
    if (chosen.length === 0 && failed === 0) {
      console.error(`no part folders in ${fromDir}`)
      process.exit(2)
    }
  } else {
    const { packages, failures } = await declareBuiltIns(vite)
    for (const f of failures) console.error(`  built-in ${f.id} does not build: ${f.error}`)
    for (const p of packages) if ((category ? p.category === category : false) || partIds.includes(p.id)) chosen.push({ pkg: p, thumb: join(thumbsDir, `${packageThumbFile(p.id)}.webp`) })
    for (const id of partIds) if (!packages.some((p) => p.id === id)) {
      console.error(`  no built-in part "${id}"`)
      failed++
    }
    if (chosen.length === 0) {
      console.error(category ? `no built-in part has category "${category}"` : 'no parts chosen')
      process.exit(2)
    }
  }

  const indexPath = join(outDir, 'index.json')
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : { format: LIBRARY_INDEX_FORMAT, id: libraryId, name: libraryName, licence: { code: 'MIT', assets: 'CC-BY-4.0' }, parts: [] }
  if (index.id !== libraryId) {
    console.error(`${indexPath} is library "${index.id}", not "${libraryId}"`)
    process.exit(2)
  }
  index.name = libraryName

  const files = []
  for (const { pkg, thumb: thumbSource, description, publisher } of [...chosen].sort((a, b) => (a.pkg.id < b.pkg.id ? -1 : 1))) {
    const fingerprint = partFingerprint(pkg)
    // the part's catalog picture (scripts/gen-thumbnails.mjs), named by its hash like the part
    const thumbBytes = existsSync(thumbSource) ? new Uint8Array(readFileSync(thumbSource)) : null
    const thumbnail = thumbBytes ? `${pkg.id}/${sha256HexOfBytes(thumbBytes)}.webp` : undefined
    let entry = index.parts.find((p) => p.id === pkg.id)
    // the description is the listing's, not the part's: it follows the source whether or not the part changed
    if (entry && description !== undefined) entry.description = description
    const latest = entry?.versions.at(-1)
    if (latest && latest.fingerprint === fingerprint) {
      // the part is unchanged; its newest version may still gain or change its picture, which is the listing's
      // metadata, not the part (a new picture is a new file, so none is rewritten)
      if (thumbnail && latest.thumbnail !== thumbnail) {
        latest.thumbnail = thumbnail
        files.push({ path: join(outDir, thumbnail), bytes: thumbBytes })
        console.log(`  ~ ${pkg.id} (picture)`)
      } else console.log(`  = ${pkg.id} (unchanged)`)
      continue
    }
    const bytes = await partToOippartBytes(pkg, { assetBytes })
    const sha256 = sha256HexOfBytes(bytes)
    const version = { file: `${pkg.id}/${sha256}.oippart`, sha256, fingerprint, sdk: pkg.sdk?.level ?? PART_SDK_LEVEL, published }

    // read it back as the app installs it
    const folder = await oippartBytesToFolder(bytes)
    let problem = 'error' in folder ? folder.error : ''
    if (problem === '') {
      try {
        problem = checkLibraryDownload(version, pkg.id, bytes, buildPackage(JSON.parse(folder.manifestJson), folder.behaviorJs))
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e)
      }
    }
    if (problem !== '') {
      console.error(`  ✗ ${pkg.id}: ${problem}`)
      failed++
      continue
    }
    if (listed) {
      // the listing rules, the same the Publish dialog checks (core/parts/partSubmission.ts), then what it does alone
      const problems = submissionProblems(pkg, { partFileBytes: bytes.length, description })
      const run = problems.length === 0 ? behaviourOf(pkg) : null
      for (const p of [...problems.map((x) => x.message), ...(run?.problems ?? [])]) console.error(`  ✗ ${pkg.id}: ${p}`)
      if (problems.length > 0 || run.problems.length > 0) {
        failed++
        continue
      }
      version.behaviour = run.digest
    }
    // a published version is a promise every later build keeps (docs/part-libraries.md): a first-party one must be in
    // the old-parts corpus, which src/sim/partCorpus.test.ts runs on every build, before it may be listed
    const corpusFile = join(repo, 'test-corpus', 'parts', pkg.id, `${storedPackageHash(pkg).replace(':', '-')}.json`)
    if (!listed && !existsSync(corpusFile)) {
      console.error(`  ✗ ${pkg.id}: this version is not in the old-parts corpus (test-corpus/parts/). Run npm run parts:record and commit it, so every later build is tested against it`)
      failed++
      continue
    }
    const urlAssets = (pkg.assets ?? []).filter((a) => a.url !== undefined && (a.sha256 === undefined || !assetFiles.has(a.sha256)))
    if (urlAssets.length > 0) {
      console.error(`  ✗ ${pkg.id}: ${urlAssets.length} asset(s) with no shipped bytes in public/part-assets (run node scripts/bake-part-assets.mjs)`)
      failed++
      continue
    }

    if (!entry) {
      entry = {
        id: pkg.id,
        name: pkg.name,
        ...(pkg.category ? { category: pkg.category } : {}),
        ...(description ? { description } : {}),
        ...(publisher ? { publisher } : {}),
        versions: [],
      }
      index.parts.push(entry)
    }
    entry.name = pkg.name
    if (thumbnail) {
      version.thumbnail = thumbnail
      files.push({ path: join(outDir, thumbnail), bytes: thumbBytes })
    }
    entry.versions.push(version)
    files.push({ path: join(outDir, version.file), bytes })
    console.log(`  + ${pkg.id} ${sha256.slice(0, 12)} (${(bytes.length / 1024).toFixed(0)} KB)`)
  }

  if (fromDir) {
    // a library built from a folder of sources lists what the folder holds: a part whose source left it (a takedown in
    // the parts repository, a part a first-party library no longer offers) leaves the index. Only the listing changes:
    // its published files stay, so nothing that names them breaks, and projects that added it keep their copies. A
    // part that failed to build has stopped the run above, so it is never taken for a removed one.
    const present = new Set(chosen.map((c) => c.pkg.id))
    for (const p of index.parts.filter((x) => !present.has(x.id))) console.log(`  - ${p.id} (removed: its source is gone)`)
    index.parts = index.parts.filter((x) => present.has(x.id))
  }
  index.parts.sort((a, b) => (a.id < b.id ? -1 : 1))
  delete index.signature
  const checked = validateLibraryIndex(index)
  if ('problems' in checked) {
    console.error('  ✗ the index would not validate:')
    for (const p of checked.problems) console.error(`      ${p}`)
    process.exit(1)
  }
  if (failed > 0) process.exit(1)
  if (dry) {
    console.log(`(dry run) ${files.length} new file(s); nothing written`)
  } else {
    for (const f of files) {
      if (existsSync(f.path)) continue // named by hash: an existing file is these bytes
      mkdirSync(dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.bytes)
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
    console.log(`✓ ${indexPath}: ${index.parts.length} part(s), ${files.length} new file(s)`)
  }
} finally {
  await vite.close()
}
process.exit(failed > 0 ? 1 : 0)
