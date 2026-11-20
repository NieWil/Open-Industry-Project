// Every check CI runs on a pull request that needs no browser, in one command, so a contributor runs one thing
// before opening a PR instead of a list (CONTRIBUTING.md, "Before Opening a Pull Request").
//
//   npm run check              all of it, ending with the production build (which also checks the size budgets)
//   npm run check -- --quick   skip the production build and the collab server's tests (the slow, rarely-affected two)
//
// Every step runs even after one fails, and the summary at the end lists what failed, so one run shows everything
// to fix. The end-to-end gates are not here: they need a browser and a GPU (`npm run build && npm run gates`).
//
// The steps run at once, each printing its output as a block when it finishes. The unit tests take most of the time
// and keep most cores busy only for their first minute, so the rest finish in their shadow. The production build
// runs alone afterwards: its `tsc -b` writes the same .types/ cache as the typecheck step, and it is the heaviest.
/* global process, console */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const quick = process.argv.includes('--quick')

/** [label, command, working directory relative to the repo] */
const steps = [
  ['lint', 'npm run lint'],
  ['typecheck', 'npm run typecheck'],
  ['unit tests', 'npm test'],
  // downloads the listed library's parts from parts.openindustryproject.org, so it needs the network
  ['listed library parts still run', 'node scripts/library-corpus.mjs'],
  ['repo is self-contained', 'node e2e/verify-repo-self-contained.mjs'],
  ['ST capability list matches the engine', 'npm run capabilities -- --check'],
  ['part SDK matches src/core', 'npm run build-part-sdk -- --check'],
  ['built parts match their part.js sources', 'npm run build-parts -- --check'],
  ['baked wall lighting is current', 'npm run bake-walls -- --check'],
  ['example project tests', 'npm run test-project -- examples/projects/start-stop-motor'],
  // asks the npm registry, so it needs the network
  ['no high-severity advisories in shipped packages', 'node scripts/audit-deps.mjs'],
]
if (!quick) {
  // the collab server is its own package; install it once if this checkout never has
  const serverInstall = existsSync(join(root, 'server', 'node_modules')) ? '' : 'npm ci --no-audit --no-fund && '
  steps.push(['collab server tests', `${serverInstall}npm test`, 'server'])
}
/** run after every step above has finished, one at a time */
const lastSteps = quick ? [] : [['production build and size budgets', 'npm run build']]

// piped output is not a terminal, so keep the colours a terminal would have shown
const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: '1' } : process.env

/** Runs one step with its output captured, prints it as one block when the step ends, and resolves to its result. */
function run([label, command, cwd]) {
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(command, { cwd: join(root, cwd ?? ''), env, shell: true })
    const out = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => out.push(d))
    let finished = false
    // a spawn failure emits 'error' and may also emit 'close'; report the step once
    const finish = (ok) => {
      if (finished) return
      finished = true
      const s = ((Date.now() - started) / 1000).toFixed(0)
      console.log(`\n=== ${label}: ${command}${cwd ? ` (in ${cwd}/)` : ''}  (${ok ? 'ok' : 'FAIL'}, ${s} s)`)
      process.stdout.write(Buffer.concat(out))
      done({ label, ok, s })
    }
    child.on('error', (e) => {
      out.push(Buffer.from(`${e.message}\n`))
      finish(false)
    })
    child.on('close', (code) => finish(code === 0))
  })
}

console.log(`running ${steps.length} checks at once; each prints its output when it finishes`)
for (const [label] of steps) console.log(`  - ${label}`)
const results = await Promise.all(steps.map(run))
for (const step of lastSteps) results.push(await run(step))

console.log('\n=== summary')
for (const { label, ok, s } of results) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  (${s} s)`)
const failed = results.filter((r) => !r.ok)
if (quick) console.log('\n(--quick: skipped the collab server tests and the production build)')
console.log(failed.length ? `\n${failed.length} of ${results.length} failed` : '\nall passed')
process.exit(failed.length ? 1 : 0)
