// Download every listed library version this build must keep running, then run them (docs/part-libraries.md, "How a
// deploy keeps working with published parts").
//
//   node scripts/library-corpus.mjs [--no-run]      fetch the official libraries' indexes (editor/parts/partLibraryUrls.ts
//                                                  OFFICIAL_PART_LIBRARIES), check their signatures, download every
//                                                  version that records a behaviour digest into .cache/library-corpus/
//                                                  (by hash, so each file is fetched once), then run
//                                                  src/sim/libraryCorpus.test.ts on them
//   node scripts/library-corpus.mjs --index <url>   the same for one index (a library under test)
//
// OIP_TRUST_TEST_KEY=1 also trusts the gates' key (e2e/_library-test-key.mjs), for an index signed with it.
//
// A first-party library's versions are in test-corpus/ already and carry no digest, so only versions from other
// publishers are fetched. Exit 0 = every listed version runs as recorded, 1 = one does not, or an index is unreadable
// or its signature does not verify, 2 = usage/IO error.
/* global process, console, fetch */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const only = argv.includes('--index') ? argv[argv.indexOf('--index') + 1] : undefined
const dir = join(repo, '.cache', 'library-corpus')
mkdirSync(dir, { recursive: true })

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
let failed = 0
const listed = []
try {
  const { validateLibraryIndex, libraryUrl } = await vite.ssrLoadModule('/src/core/parts/partLibrary.ts')
  const { checkLibrarySignature } = await vite.ssrLoadModule('/src/core/librarySignature.ts')
  const { sha256HexOfBytes } = await vite.ssrLoadModule('/src/core/sha256.ts')
  const { OFFICIAL_PART_LIBRARIES } = await vite.ssrLoadModule('/src/editor/parts/partLibraryUrls.ts')
  const { LIBRARY_SIGNING_KEYS } = await vite.ssrLoadModule('/src/core/librarySigningKeys.ts')
  const keys = [...LIBRARY_SIGNING_KEYS]
  if (process.env.OIP_TRUST_TEST_KEY === '1') keys.push((await import('../e2e/_library-test-key.mjs')).TEST_LIBRARY_KEY)
  for (const url of only ? [only] : OFFICIAL_PART_LIBRARIES) {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      console.error(`✗ ${url}: answered ${res.status}`)
      failed++
      continue
    }
    const raw = await res.json()
    const checked = validateLibraryIndex(raw)
    if ('problems' in checked) {
      console.error(`✗ ${url}: ${checked.problems.join('; ')}`)
      failed++
      continue
    }
    const signature = await checkLibrarySignature(raw, keys)
    if (signature === 'invalid' || signature === 'unknownKey') {
      // an unknown key here means this build lacks a key the project signs with (src/core/librarySigningKeys.ts)
      console.error(`✗ ${url}: ${signature === 'unknownKey' ? 'it is signed with a key this build does not have' : 'its signature does not verify against the keys this build trusts'}`)
      failed++
      continue
    }
    const index = checked.index
    for (const part of index.parts) {
      for (const version of part.versions) {
        if (version.behaviour === undefined) continue
        const file = `${version.sha256}.oippart`
        const path = join(dir, file)
        if (!existsSync(path)) {
          const got = await fetch(libraryUrl(url, version.file))
          const bytes = new Uint8Array(await got.arrayBuffer())
          if (!got.ok || sha256HexOfBytes(bytes) !== version.sha256) {
            console.error(`✗ ${index.id}/${part.id}: ${version.file} ${got.ok ? 'does not hash to its listed SHA-256' : `answered ${got.status}`}`)
            failed++
            continue
          }
          writeFileSync(path, bytes)
        }
        listed.push({ name: `${index.id}/${part.id}/${version.sha256.slice(0, 12)}`, partId: part.id, file, version })
      }
    }
    console.log(`  ${index.id}: ${index.parts.length} part(s)`)
  }
} finally {
  await vite.close()
}
writeFileSync(join(dir, 'listed.json'), JSON.stringify(listed, null, 2) + '\n')
console.log(`${listed.length} listed version(s) to run`)
if (failed > 0) process.exit(1)
if (!argv.includes('--no-run') && listed.length > 0) {
  try {
    execFileSync(process.execPath, [join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/sim/libraryCorpus.test.ts'], { cwd: repo, stdio: 'inherit' })
  } catch {
    process.exit(1)
  }
}
