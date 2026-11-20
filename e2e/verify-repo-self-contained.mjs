// Does the repo contain what its tracked files reference? (static: no browser, no server)
//
// The working tree is not the repo: a file can be present on disk, referenced, and still absent
// from a clone because it is gitignored or was never `git add`ed. No other check sees that: tsc,
// eslint and vitest all read the working tree, so they pass on a tree that no clone can reproduce.
// This checks two kinds of reference, and both have been broken in this repo:
//
//   1. citations - a comment naming the probe that measured a constant.
//   2. imports   - a tracked module importing a source file that was never committed.
//
// (1) in detail:
//
// ~100 comments across src/, e2e/, scripts/ and examples/ justify a constant by naming the probe
// that measured it: "ARM_REACH_X is measured (e2e/probes/arm-envelope.mjs)", the draw-budget
// instruments AGENTS.md tells readers to run, the rack clearances verify-agv-rack-putaway.mjs
// depends on. Probes worth keeping live in e2e/probes/ and are tracked; `e2e/_dbg-*` is the
// gitignored scratch name for one-off probes that are deleted after use.
// A citation is broken if it names a scratch `_dbg-` file, which no clone has, or an e2e/probes/
// file that was never `git add`ed. Both have happened: three probes cited by src/core were never
// committed, so the numbers based on them can no longer be reproduced.
//
// A reader cannot verify a citation they cannot run. This gate makes that a build error: a probe
// cited from tracked code must be a tracked file under e2e/probes/.
//
// The check is transitive: an instrument may cite another for its own attribution, and that one
// has to be in the clone too.
//
// (2) in detail:
//
// A tracked module that imports an untracked file builds here and fails in a clone. At one point
// 16 such modules (src/plc/ladder/ladder.ts, src/core/io/opcUa.ts, src/collab/codeTrust.ts,
// src/editor/keyHint.ts, scripts/lib/conveyorComms.mjs and more) were reachable from 41 tracked
// importers while every other check passed, because in a long-lived dirty tree "on disk" and
// "in the repo" diverge without any warning. tsc cannot catch it: it resolves against the
// filesystem and ignores .gitignore.
//
// Only resolved-but-untracked is a failure. An import that resolves nowhere is tsc's job, and
// failing it here would mean reimplementing vite's resolver (aliases, `?raw`, conditional
// exports) reliably, which is not worth it for a gate.
//
// The failure judges the index, which is what the next commit holds: a staged importer whose
// target is not staged. An unstaged edit that imports a new, unstaged file is work in progress, so
// it is listed as a reminder and does not fail. Judging the working tree failed every local run
// during any change that adds a file. CI's tree is clean, so there the two are the same.
//
// Run: node e2e/verify-repo-self-contained.mjs
//      node e2e/verify-repo-self-contained.mjs --list    print the closure, one cited probe per line
/* global process, console */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const repo = fileURLToPath(new URL('..', import.meta.url))
const posix = (p) => p.split('\\').join('/')
const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 })

// Only text the repo actually writes prose/comments in. Anything else can't hold a citation.
const SCANNABLE = /\.(ts|tsx|js|jsx|mjs|cjs|md|json|html|css|yml|yaml)$/
// Files that can hold an import statement (check 2); prose formats cannot.
const SRC_IMPORTS = /\.(ts|tsx|mjs|cjs|js|jsx)$/
// A kept probe is cited by its path, e2e/probes/<name>.mjs. A scratch `_dbg-` name is matched with
// or without its `e2e/` prefix, so that citing one fails: it is gitignored, so no clone has it.
const CITE = /(?:e2e\/)?(_dbg-[A-Za-z0-9_.-]+\.mjs)|e2e\/(probes\/[A-Za-z0-9_.-]+\.mjs)/g
// Files whose mention of an instrument describes the rule rather than citing a measurement.
// Without this list, .gitignore seeded the closure and 14 uncited probes were kept alive only by
// their own exception lines.
const NEVER_A_CITER = new Set([
  // Its comments describe the scratch convention (`e2e/_dbg-*`); they are not citations.
  '.gitignore',
  // This file names probes to explain the rule; that is documentation about citations, not a
  // citation. (Without this entry the gate fails with exit 1, naming this file as the citer,
  // which also served as the negative test showing the gate is not vacuous.)
  'e2e/verify-repo-self-contained.mjs',
])

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// Tracked = what a `git clone` gets. The index counts too, so staging a fix clears the gate
// in the same commit that introduces the citation.
const tracked = new Set(git('ls-files').split('\n').filter(Boolean))

const citationsIn = (file) => {
  const abs = join(repo, file)
  if (!existsSync(abs)) return [] // staged-but-deleted; nothing to read
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    return []
  }
  return [...text.matchAll(CITE)].map((m) => m[1] ?? m[2])
}

// Seed from every tracked file that is not itself an instrument, then close over the instruments
// they pull in. Seeding from the working tree (not HEAD) is deliberate: a citation added in an
// uncommitted edit is the one about to be committed without its file.
const seedFiles = [...tracked].filter(
  // test-corpus/ holds frozen copies of every part version ever shipped, append-only and never
  // edited, so a comment in an old copy can name a probe by a path it no longer has.
  (f) => SCANNABLE.test(f) && !f.startsWith('e2e/probes/') && !f.startsWith('test-corpus/') && !NEVER_A_CITER.has(f),
)

/** @type {Map<string, string[]>} instrument -> files that cite it */
const citedBy = new Map()
const note = (instrument, citer) => {
  if (!citedBy.has(instrument)) citedBy.set(instrument, [])
  const list = citedBy.get(instrument)
  if (!list.includes(citer)) list.push(citer)
}

let frontier = new Set()
for (const f of seedFiles) for (const c of citationsIn(f)) { note(c, f); frontier.add(c) }

const seen = new Set()
let rounds = 0
while (frontier.size) {
  rounds++
  const next = new Set()
  for (const inst of frontier) {
    if (seen.has(inst)) continue
    seen.add(inst)
    const path = `e2e/${inst}`
    if (!tracked.has(path)) continue // unreachable; reported below, and we can't follow it
    for (const c of citationsIn(path)) {
      if (c === inst) continue
      note(c, path)
      if (!seen.has(c)) next.add(c)
    }
  }
  frontier = next
}

const missing = [...seen].filter((i) => !tracked.has(`e2e/${i}`)).sort()

if (process.argv.includes('--list')) {
  for (const i of [...seen].sort()) console.log(`e2e/${i}`)
  process.exit(0)
}

console.log(`scanned ${seedFiles.length} tracked files, closed over ${seen.size} cited instruments in ${rounds} rounds\n`)

check(
  'every cited probe is tracked under e2e/probes/ (survives a clone)',
  missing.length === 0,
  missing.length ? `${missing.length} unreachable` : `${seen.size} reachable`,
)

if (missing.length) {
  console.log('\nCited but not in the repo - a reader cannot run these:\n')
  for (const inst of missing) {
    const where = inst.startsWith('_dbg-')
      ? 'a gitignored scratch probe'
      : existsSync(join(repo, 'e2e', inst))
        ? 'on disk but not committed'
        : 'GONE from disk entirely'
    console.log(`  e2e/${inst}  - ${where}`)
    for (const citer of citedBy.get(inst) ?? []) console.log(`      cited by ${citer}`)
  }
  console.log(
    '\nFix: move the script to e2e/probes/<name>.mjs, commit it and cite that path, in the same\n' +
      'commit as the citation. If the script is gone for good, drop the citation - a comment\n' +
      'pointing at nothing is worse than no comment.\n',
  )
}


// --- 2. IMPORTS ------------------------------------------------------------------------------
// Relative specifiers only: a bare one is a package or a tsconfig alias, neither of which can be
// an untracked working-tree file.
const SPEC = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g
// vite query suffixes (`?raw`, `?url`, `?worker&inline`) are not part of the path on disk.
const stripQuery = (spec) => spec.replace(/[?#].*$/, '')
const CANDIDATES = [
  '', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.d.ts',
  '/index.ts', '/index.tsx', '/index.mjs', '/index.js', '/index.d.ts',
]

// `exists` says whether a path is a file in the tree being judged (the index, or the disk).
const resolveImport = (fromFile, spec, exists) => {
  const base = posix(join(dirname(fromFile), stripQuery(spec)))
  for (const ext of CANDIDATES) {
    if (exists(base + ext)) return base + ext
  }
  // `./x.js` in TS source means `./x.ts` (NodeNext-style specifiers).
  if (base.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx']) {
      if (exists(base.slice(0, -3) + ext)) return base.slice(0, -3) + ext
    }
  }
  return null // tsc's problem, not ours - see the header
}
const onDisk = (p) => existsSync(join(repo, p)) && !isDir(join(repo, p))
const inIndex = (p) => tracked.has(p)

const importers = [...tracked].filter((x) => SRC_IMPORTS.test(x))

// Staged contents of every importer, read in one `git cat-file --batch` call. A gitlink (submodule)
// answers "missing" and is skipped.
const indexText = new Map()
{
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repo,
    input: importers.map((f) => `:${f}`).join('\n') + '\n',
    maxBuffer: 1 << 30,
  })
  let at = 0
  for (const f of importers) {
    const eol = out.indexOf(10, at)
    const header = out.toString('utf8', at, eol)
    at = eol + 1
    if (header.endsWith(' missing')) continue
    const size = Number(header.split(' ')[2])
    indexText.set(f, out.toString('utf8', at, at + size))
    at += size + 1
  }
}

const diskText = (f) => {
  try {
    return readFileSync(join(repo, f), 'utf8')
  } catch {
    return null // deleted in the working tree
  }
}

/** Untracked targets the given texts import, as target -> importers. */
const untrackedImports = (textOf, exists, skip = new Map()) => {
  /** @type {Map<string, string[]>} */
  const found = new Map()
  for (const f of importers) {
    const text = textOf(f)
    if (text == null) continue
    for (const [, spec] of text.matchAll(SPEC)) {
      const target = resolveImport(f, spec, exists)
      if (!target || tracked.has(target)) continue
      if (skip.get(target)?.includes(f)) continue
      if (!found.has(target)) found.set(target, [])
      const list = found.get(target)
      if (!list.includes(f)) list.push(f)
    }
  }
  return found
}

// Staged importers resolve against staged files only, so a target that resolves only on disk is
// still caught. A target missing from both is unresolved and left to tsc (see the header).
const stagedHoles = untrackedImports(
  (f) => indexText.get(f),
  (p) => inIndex(p) || onDisk(p),
)
const pending = untrackedImports(diskText, onDisk, stagedHoles)

const printImports = (found) => {
  for (const [target, list] of [...found].sort()) {
    console.log(`  ${target}  - ${list.length} importer(s)`)
    for (const i of list.slice(0, 4)) console.log(`      imported by ${i}`)
    if (list.length > 4) console.log(`      …and ${list.length - 4} more`)
  }
}

check(
  'no staged file imports an untracked one (a clone builds)',
  stagedHoles.size === 0,
  stagedHoles.size ? `${stagedHoles.size} untracked module(s)` : 'all imports tracked',
)

if (stagedHoles.size) {
  console.log('\nImported by the index but not in it - a clone would fail to build:\n')
  printImports(stagedHoles)
  console.log('\nFix: `git add` them. If one is deliberately local, the import has to go too.\n')
}

if (pending.size) {
  console.log('\nNOTE  unstaged edits import new files; commit these with them:\n')
  printImports(pending)
  console.log('')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
