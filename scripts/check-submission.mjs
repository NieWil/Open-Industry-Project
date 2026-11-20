// Check parts submitted to the listed library (docs/part-libraries.md, "Publishing"): what the parts repository's CI
// runs on every pull request, and what an author can run on their own folder first.
//
//   npm run check-submission -- <parts-dir> --namespaces <file> --author <login> [--orgs <org,org>]
//                               [--part <id>...] [--pr-body <file>]
//
// <parts-dir> holds one folder per part, named by its id (the parts repository's parts/). --part limits the check to
// the parts a pull request changes; without it every folder is checked. --orgs are the GitHub organizations the
// author is a public member of, which the workflow reads from GitHub. --pr-body checks the pull request's text: the
// rights line (core/parts/partSubmission.ts RIGHTS_LINE) must be ticked.
//
// Each part is checked in a child process of its own (scripts/lib/submission-run.mjs, which lists the checks), capped
// at 1.5 GB of memory and 120 s. This process never runs part code, so a part that hangs or exhausts memory is
// reported here, never in a user's tab.
//
// Exit 0 = every part passes, 1 = a part fails (each problem printed), 2 = usage/IO error.
/* global process, console */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const many = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []))
const valued = new Set(['--namespaces', '--author', '--orgs', '--part', '--pr-body'])
const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
const partsDir = positional[0]
const namespacesPath = flag('--namespaces')
const author = flag('--author')
const orgs = flag('--orgs') ?? ''
const prBodyPath = flag('--pr-body')
if (!partsDir || !namespacesPath || !author) {
  console.error('usage: npm run check-submission -- <parts-dir> --namespaces <file> --author <login> [--orgs <org,org>] [--part <id>...] [--pr-body <file>]')
  process.exit(2)
}

/** The child's limits: a part that needs more is not one to list. */
const RUN_MEMORY_MB = 1536
const RUN_SECONDS = 120

// the rights line, read from the one copy of the rules (a TypeScript module, read as text: this process loads no app code)
const RIGHTS_LINE = /export const RIGHTS_LINE = '([^']+)'/.exec(readFileSync(join(repo, 'src', 'core', 'parts', 'partSubmission.ts'), 'utf8'))?.[1]

let failed = 0
const fail = (name, message) => {
  failed++
  console.log(`✗ ${name}: ${message}`)
}

if (prBodyPath) {
  const body = readFileSync(prBodyPath, 'utf8')
  // GitHub writes a ticked box as "- [x]"; the line must be the template's, ticked
  const ticked = RIGHTS_LINE !== undefined && body.split(/\r?\n/).some((l) => /^\s*[-*]\s*\[[xX]\]/.test(l) && l.includes(RIGHTS_LINE))
  if (!ticked) fail('pull request', `it does not confirm the rights: tick "${RIGHTS_LINE}"`)
}

const ids = many('--part')
const folders = ids.length > 0 ? ids : readdirSync(partsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
for (const name of folders) {
  const at = join(partsDir, name)
  // a pull request may remove a part's folder: that is a takedown, the reviewer's call, not a check
  if (!existsSync(at)) continue
  const child = spawnSync(process.execPath, [`--max-old-space-size=${RUN_MEMORY_MB}`, join(repo, 'scripts', 'lib', 'submission-run.mjs'), at, namespacesPath, author, orgs], {
    cwd: repo,
    encoding: 'utf8',
    timeout: RUN_SECONDS * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGKILL') {
    fail(name, `it did not finish in ${RUN_SECONDS} s: its code may never return (a hang), or it is far too slow to list`)
    continue
  }
  let result = null
  try {
    result = JSON.parse((child.stdout ?? '').trim().split('\n').at(-1) ?? '')
  } catch {
    const oom = /heap out of memory|allocation failed|Reached heap limit/i.test(child.stderr ?? '')
    fail(name, oom ? `it used more than ${RUN_MEMORY_MB} MB of memory` : `the check stopped: ${(child.stderr ?? '').trim().split('\n').slice(-3).join(' ') || `exit ${child.status}`}`)
    continue
  }
  if (result.problems.length === 0) console.log(`✓ ${name} (ran at ${result.settings} setting${result.settings === 1 ? '' : 's'})`)
  for (const p of result.problems) fail(name, p)
}
process.exit(failed > 0 ? 1 : 0)
