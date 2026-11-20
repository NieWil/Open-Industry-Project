// Fails when a package that ships has a known high or critical advisory, in each folder with its own lockfile:
// the app, the desktop shell and the collab server. Dev-only packages are left out (--omit=dev): they never reach a
// visitor, and an advisory in a test tool would block every PR for nothing a user runs.
//
//   node scripts/audit-deps.mjs
//
// npm audit reads the lockfile, so no folder needs its node_modules installed. It asks the npm registry, so it needs
// the network. When an advisory has no fixed release yet, pin a fixed transitive version through `overrides` with a
// note on when to drop it (see "//overrides-dompurify" in package.json), rather than lowering the level here.
/* global process, console */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const folders = ['.', 'apps/desktop', 'server']

let failed = 0
for (const folder of folders) {
  const r = spawnSync('npm audit --omit=dev --audit-level=high', { cwd: join(root, folder), shell: true, encoding: 'utf8' })
  const ok = r.status === 0
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${folder === '.' ? 'app' : folder}`)
  if (!ok) process.stdout.write(`${r.stdout}${r.stderr}\n`)
}
process.exit(failed ? 1 : 0)
