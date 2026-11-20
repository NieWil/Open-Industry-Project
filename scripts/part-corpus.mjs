// The OLD-PARTS CORPUS: every first-party part as this app has ever shipped it, kept so every later build is held to
// running them (docs/part-sources.md, "Keeping old copies running"). A project keeps its own copy of each part it
// uses, so a part the app shipped once lives on in projects for good; if a later build stopped loading or running it,
// that project would need the old app again, which is exactly what copies exist to avoid.
//
//   node scripts/part-corpus.mjs           add this build's version of every first-party part that is not in it yet,
//                                          then record what each new version does (test-corpus/behaviour.json)
//   node scripts/part-corpus.mjs --check   fail if one is missing (src/sim/partCorpus.test.ts asserts the same)
//
// Append-only: test-corpus/parts/<id>/<fingerprint>.json, each a stored package exactly as a project holds it
// (its package format included, so a later format bump runs the corpus through upgradeStoredPackage). The fingerprint
// is core/parts/partOrigin.ts storedPackageHash, which covers the whole stored package; its ':' becomes '-' in the file name.
// A version never leaves: delete a file only if no build ever shipped it.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const CORPUS = join(repo, 'test-corpus', 'parts')

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
let missing = 0
let added = 0
try {
  const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
  const { storedPackageHash } = await vite.ssrLoadModule('/src/core/parts/partOrigin.ts')
  // the built-ins (examples/parts/<dir>/{rig.json, behavior.ts}) and the first-party library parts
  // (libraries/<library>/<dir>/{manifest.json, behavior.js}, docs/part-libraries.md): every version either ships is one
  // a later build has to keep running
  const sources = []
  const parts = join(repo, 'examples', 'parts')
  for (const dir of readdirSync(parts, { withFileTypes: true }).filter((e) => e.isDirectory())) sources.push({ name: dir.name, rig: join(parts, dir.name, 'rig.json'), beh: join(parts, dir.name, 'behavior.ts') })
  const libs = join(repo, 'libraries')
  for (const lib of existsSync(libs) ? readdirSync(libs, { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
    for (const dir of readdirSync(join(libs, lib.name), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      sources.push({ name: `${lib.name}/${dir.name}`, rig: join(libs, lib.name, dir.name, 'manifest.json'), beh: join(libs, lib.name, dir.name, 'behavior.js') })
    }
  }
  for (const { name, rig, beh } of sources) {
    const dir = { name }
    if (!existsSync(rig) || !existsSync(beh)) continue
    // baked the way the app bakes its bundle (editor/parts/bundledPackageData.ts): the manifest as written, LF behavior
    const pkg = buildPackage(JSON.parse(readFileSync(rig, 'utf8')), readFileSync(beh, 'utf8').replace(/\r\n/g, '\n'))
    const file = join(CORPUS, pkg.id, `${storedPackageHash(pkg).replace(/:/g, '-')}.json`)
    if (existsSync(file)) continue
    missing++
    if (check) {
      console.error(`missing: ${pkg.id} (${dir.name}) as this build ships it`)
      continue
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
    added++
    console.log(`+ ${pkg.id}  ${file.slice(repo.length + 1)}`)
  }
} finally {
  await vite.close()
}
if (check && missing > 0) {
  console.error(`FAIL  ${missing} first-party part version(s) not in the corpus. Run: node scripts/part-corpus.mjs`)
  process.exit(1)
}
if (!check) {
  console.log(`${added} version(s) added to test-corpus/parts; recording what any version new to the corpus does…`)
  // the corpus test in recording mode: it ADDS the behaviour digest of every version without one, never rewrites one
  execFileSync(process.execPath, [join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/sim/partCorpus.test.ts'], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, OIP_RECORD_CORPUS: '1' },
  })
}
console.log(check ? 'ok: every first-party part as this build ships it is in the corpus' : 'done: test-corpus/parts and test-corpus/behaviour.json')
