// Recreate the source of the vendored jolt-physics build: fetch upstream JoltPhysics.js at the pinned commit and apply
// this repo's patches (vendor/jolt-physics-src/*.patch) as commits on a branch `oip/<base>`.
//
//   node scripts/jolt-src.mjs <dir>
//
// <dir> must be new or empty, and should sit outside this repo (the clone is hundreds of MB once built). Building it is
// vendor/README.md "Rebuilding". To change the engine, commit in <dir> and export the series back over the patch folder
// with `git format-patch -o <repo>/vendor/jolt-physics-src <commit>..HEAD`.
//
// The pin is a commit, not a tag: upstream moved to Jolt 5.7.0 on main without tagging a release. A commit cannot
// move, so the build always starts from the same code.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM = 'https://github.com/jrouwe/JoltPhysics.js'
// Three commits after upstream's 1.1.1 tag: "Update to Jolt v5.7.0".
const BASE = '1.1.1-jolt-5.7.0'
const COMMIT = 'c43eabb4c90f4db4cb292f88a0d768efe896c3ca'

const patchDir = fileURLToPath(new URL('../vendor/jolt-physics-src/', import.meta.url))

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/jolt-src.mjs <dir>')
  process.exit(2)
}
const target = resolve(dir)
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`jolt-src: ${target} is not empty`)
  process.exit(2)
}

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()

git(['init', '--quiet', target])
git(['fetch', '--quiet', '--depth', '1', UPSTREAM, COMMIT], target)
git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'], target)
const head = git(['rev-parse', 'HEAD'], target)
if (head !== COMMIT) {
  console.error(`jolt-src: fetched ${head}, expected ${COMMIT}`)
  process.exit(1)
}

// git am records a committer, and a fresh CI machine may have no identity configured.
let identity = []
try { git(['config', 'user.email'], target) } catch { identity = ['-c', 'user.name=oip-web', '-c', 'user.email=oip-web@localhost'] }

const patches = readdirSync(patchDir).filter((f) => f.endsWith('.patch')).sort().map((f) => join(patchDir, f))
git(['checkout', '--quiet', '-b', `oip/${BASE}`], target)
git([...identity, 'am', '--quiet', '--whitespace=nowarn', '--committer-date-is-author-date', ...patches], target)

console.log(`jolt-src: ${target} is upstream ${COMMIT.slice(0, 7)} + ${patches.length} patches on branch oip/${BASE}`)
