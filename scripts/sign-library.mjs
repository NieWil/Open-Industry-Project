// Sign a part library's index with the project's key (docs/part-libraries.md, "Publisher identity").
//
//   PART_LIBRARY_SIGNING_KEY=<pkcs8 pem> npm run sign-library -- <index.json> [--published <index.json>]
//
// Writes the index back with its `signature`: Ed25519 over the index without it, in canonical JSON
// (core/librarySignature.ts). The signature is checked against the key's own public half before the file is written,
// and a key this build does not trust (src/core/librarySigningKeys.ts) is reported, since the app would refuse the
// index. This step loads no part: the job that holds the key (library.yml, the parts repository's publish job) runs
// it on an index another step built, and nothing a part's code does can reach the key.
//
// --published names the index the bucket serves now, fetched by the signing job itself (absent file = first release).
// The new index must then only append to it (core/parts/partLibrary.ts checkLibraryAppend), and every new file beside the
// index must hash to the name it is listed under. So a build step that ran part code can add entries, but cannot get
// a rewritten one signed.
//
// Exit 0 = signed, 1 = the signature did not verify or the index is not valid, 2 = usage/IO error.
/* global process, console, Buffer */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const publishedAt = args.indexOf('--published')
const publishedPath = publishedAt >= 0 ? args.splice(publishedAt, 2)[1] : undefined
const indexPath = args[0]
const pem = process.env.PART_LIBRARY_SIGNING_KEY
if (!indexPath || !pem || (publishedAt >= 0 && !publishedPath)) {
  console.error('usage: PART_LIBRARY_SIGNING_KEY=<pkcs8 pem> npm run sign-library -- <index.json> [--published <index.json>]')
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
let code = 0
try {
  const { signedBytes, checkLibrarySignature } = await vite.ssrLoadModule('/src/core/librarySignature.ts')
  const { LIBRARY_SIGNING_KEYS } = await vite.ssrLoadModule('/src/core/librarySigningKeys.ts')
  const { validateLibraryIndex, checkLibraryAppend } = await vite.ssrLoadModule('/src/core/parts/partLibrary.ts')
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  delete index.signature
  const refusals = publishedPath === undefined ? [] : appendProblems(index, checkLibraryAppend, validateLibraryIndex)
  if (refusals.length > 0) {
    for (const p of refusals) console.error(`✗ ${p}`)
    console.error('✗ not signed: the index does not only append to the published one')
    code = 1
  } else {
    const priv = createPrivateKey(pem)
    const raw = Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url')
    const key = { id: createHash('sha256').update(raw).digest('hex').slice(0, 16), publicKey: raw.toString('base64') }
    index.signature = { key: key.id, sig: sign(null, Buffer.from(signedBytes(index)), priv).toString('base64') }
    const checked = validateLibraryIndex(index)
    if ('problems' in checked) {
      console.error(`✗ the index is not valid: ${checked.problems.join('; ')}`)
      code = 1
    } else if ((await checkLibrarySignature(index, [key])) !== 'signed') {
      console.error('✗ the signature does not verify against its own key')
      code = 1
    } else {
      writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
      if (LIBRARY_SIGNING_KEYS.some((k) => k.id === key.id)) console.log(`✓ ${index.id} signed with key ${key.id}`)
      else console.error(`! ${index.id} signed with key ${key.id}, which this build does not trust (src/core/librarySigningKeys.ts): the app will refuse it`)
    }
  }
} finally {
  await vite.close()
}
process.exit(code)

/** What stops `index` from being signed as an append to the published index, after checking each new file's bytes. */
function appendProblems(index, checkLibraryAppend, validateLibraryIndex) {
  const next = validateLibraryIndex(index)
  if ('problems' in next) return next.problems.map((p) => `the index is not valid: ${p}`)
  let published = null
  if (existsSync(publishedPath)) {
    const was = validateLibraryIndex(JSON.parse(readFileSync(publishedPath, 'utf8')))
    if ('problems' in was) return was.problems.map((p) => `the published index is not valid: ${p}`)
    published = was.index
  }
  const { problems, removed, newFiles } = checkLibraryAppend(published, next.index)
  for (const id of removed) console.log(`  - ${id} (removed from the index)`)
  const dir = dirname(resolve(indexPath))
  for (const f of newFiles) {
    const at = resolve(dir, f.path)
    if (!existsSync(at)) problems.push(`${f.path} is listed but missing`)
    else if (createHash('sha256').update(readFileSync(at)).digest('hex') !== f.sha256) problems.push(`${f.path} does not hash to ${f.sha256}`)
  }
  if (problems.length === 0) console.log(`  ${newFiles.length} new file(s) match their hashes`)
  return problems
}
