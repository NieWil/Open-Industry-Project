// Check one submitted part, for scripts/check-submission.mjs, which starts this file in a child process with a memory
// cap and a time limit. Everything that runs the part's code happens here, building it included (validatePart runs
// its top level and geometry), so a part that hangs or eats memory ends this child, never the check.
//
//   node --max-old-space-size=<mb> scripts/lib/submission-run.mjs <part-folder> <namespaces.json> <author> [<org,org>]
//
// Prints one JSON line: { problems: string[], settings: number }. The part's code runs in the SES sandbox, as in the
// app.
//
// The checks, in order: it bakes as the app bakes it; its folder is named by its id; the author may publish under its
// namespace; description.txt is there; it keeps the listing limits
// (core/parts/partSubmission.ts). Then it runs alone as the old-parts corpus runs a part (src/sim/partBehaviour.ts): at its
// defaults twice (the same result both times, or it is not deterministic), then each number param at its min and
// max, each boolean flipped and each choice of an enum, one at a time. Every run must report no problem.
/* global process, console */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './builtIns.mjs'
import { bakeFolder } from './projectLibrary.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const [folder, namespacesPath, author, orgList = ''] = process.argv.slice(2)
const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
const problems = []
let settingsRun = 0
try {
  // part code runs sandboxed here as it does in the app: the realm is locked down before any of it loads
  // (core/realmLockdown.ts, docs/part-sandbox.md), so submitted code on the CI runner reaches no more than in a tab
  const { lockdownRealm } = await vite.ssrLoadModule('/src/core/realmLockdown.ts')
  if (!lockdownRealm()) throw new Error('could not lock the realm down; refusing to run part code unsandboxed')
  const { namespaceProblem, submissionProblems } = await vite.ssrLoadModule('/src/core/parts/partSubmission.ts')
  const { partToOippartBytes } = await vite.ssrLoadModule('/src/core/parts/partArchive.ts')
  const baked = await bakeFolder(vite, folder)
  if ('error' in baked) problems.push(baked.error)
  else {
    const pkg = baked.pkg
    if (pkg.id !== basename(folder)) problems.push(`the folder must be named by the part's id: parts/${pkg.id}/`)
    const ns = namespaceProblem(pkg.id, author, orgList.split(',').filter(Boolean), JSON.parse(readFileSync(namespacesPath, 'utf8')))
    if (ns) problems.push(ns)
    const descPath = join(folder, 'description.txt')
    const description = existsSync(descPath) ? readFileSync(descPath, 'utf8').trim() : undefined
    if (!description) problems.push('description.txt is missing: a paragraph saying what the part is and what it is for')
    const bytes = await partToOippartBytes(pkg)
    for (const p of submissionProblems(pkg, { partFileBytes: bytes.length, description })) problems.push(p.message)

    if (problems.length === 0) {
      const { runPartAlone } = await vite.ssrLoadModule('/src/sim/partBehaviour.ts')
      const initJolt = (await vite.ssrLoadModule('jolt-physics')).default
      const Jolt = await initJolt()
      const { packages: others } = await declareBuiltIns(vite)
      const settings = [{ setting: 'its defaults', params: {} }]
      for (const [name, spec] of Object.entries(pkg.params ?? {})) {
        if (spec.type === 'number') {
          if (typeof spec.min === 'number') settings.push({ setting: `${name} = ${spec.min} (its min)`, params: { [name]: spec.min } })
          if (typeof spec.max === 'number') settings.push({ setting: `${name} = ${spec.max} (its max)`, params: { [name]: spec.max } })
        } else if (spec.type === 'boolean') {
          settings.push({ setting: `${name} = ${!spec.default}`, params: { [name]: !spec.default } })
        } else if (spec.type === 'enum') {
          for (const o of (spec.options ?? []).slice(0, 8)) if (o.value !== spec.default) settings.push({ setting: `${name} = ${o.value}`, params: { [name]: o.value } })
        }
      }
      let first = ''
      for (const s of settings) {
        const r = runPartAlone(Jolt, pkg, { others, params: s.params })
        if (!first) first = r.digest
        for (const p of r.problems) problems.push(`at ${s.setting}: ${p}`)
        settingsRun++
      }
      if (runPartAlone(Jolt, pkg, { others }).digest !== first) problems.push('it is not deterministic: two runs at its defaults did different things')
    }
  }
} catch (e) {
  problems.push(e instanceof Error ? e.message : String(e))
} finally {
  await vite.close()
}
console.log(JSON.stringify({ problems, settings: settingsRun }))
process.exit(0)
