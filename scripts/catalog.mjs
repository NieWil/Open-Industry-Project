// The part catalog as DATA: every part, every param, its PLC signals and where it sits:
//
//   npm run catalog                      # every part: frame, signals, params by group
//   npm run catalog -- --verbose         # the same with each param's doc line and hidden params
//   npm run catalog -- <partId...>       # those parts in full (oip.box-spawner, or just box-spawner)
//   npm run catalog -- --json [<id...>]  # machine-readable: every param with all its metadata
//   npm run catalog -- <partId...> --params length=6,width=0.8   # the frame facts at those params, not the defaults
//
// This is the read half of the authoring loop. `validate-project` says a document is well-formed and
// `test-project` says its logic behaves, but neither answers the question you have before writing
// either: what parts are there, what knobs does each carry, what does each knob mean, and which PLC
// signals does each expect? A param's `desc` is often the only place a rule is written ("runTag only
// takes effect when a program drives it"), so it is printed for a single part and with --verbose.
//
// The parts are the app's own built-ins, built and registered the way the editor does at boot
// (scripts/lib/builtIns.mjs), through vite's SSR module loader, so there is no second reading of a
// manifest or a behavior to drift from the app. The projection and the frame facts (footprint, origin,
// conveyor ends, zones, beams; at default params, or at `--params` read and applied as snap-part / add-part do,
// src/core/parts/partParamArgs.ts) are src/core/parts/partCatalog.ts.
// Exit 0 = catalog emitted, 1 = a part failed to build, 2 = usage/IO error.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: npm run catalog -- [<partId...>] [--params k=v,...] [--json] [--verbose]'
const rawArgv = process.argv.slice(2)
// `--params k=v,...` / `--params=k=v,...`: its value is not a part id
let paramsText = null
const argv = []
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i]
  if (a === '--params') {
    if (i + 1 >= rawArgv.length) {
      console.error(`${USAGE}  (--params needs a value)`)
      process.exit(2)
    }
    paramsText = rawArgv[++i]
  } else if (a.startsWith('--params=')) paramsText = a.slice('--params='.length)
  else argv.push(a)
}
const asJson = argv.includes('--json')
const verbose = argv.includes('--verbose') || argv.includes('-v')
const flags = argv.filter((a) => a.startsWith('-'))
const unknownFlags = flags.filter((a) => !['--json', '--verbose', '-v'].includes(a))
const wanted = argv.filter((a) => !a.startsWith('-'))
if (unknownFlags.length > 0) {
  console.error(`${USAGE}  (unexpected: ${unknownFlags.join(' ')})`)
  process.exit(2)
}
if (paramsText !== null && wanted.length === 0) {
  console.error(`${USAGE}  (--params needs the part(s) it applies to)`)
  process.exit(2)
}

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  // no HMR websocket: a CLI needs none, and a second one collides with a running dev server's port
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

try {
  const { packages, failures } = await declareBuiltIns(vite)
  const { catalogEntry, formatEntry } = await vite.ssrLoadModule('/src/core/parts/partCatalog.ts')
  const { UNLISTED_BUILT_INS } = await vite.ssrLoadModule('/src/core/builtInVersion.ts')
  let args
  if (paramsText !== null) {
    const { parseParamArgs } = await vite.ssrLoadModule('/src/core/parts/partParamArgs.ts')
    try {
      args = parseParamArgs(paramsText)
    } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
      process.exit(2)
    }
  }
  const byId = new Map(packages.map((p) => [p.id, p]))
  // `box-spawner` finds `oip.box-spawner`: the built-ins all carry the one prefix
  const resolveId = (w) => (byId.has(w) ? w : byId.has(`oip.${w}`) ? `oip.${w}` : null)
  const missing = wanted.filter((w) => !resolveId(w))
  if (missing.length > 0) {
    console.error(`✗ no part ${missing.join(', ')}. Parts: ${[...byId.keys()].sort().join(', ')}`)
    process.exitCode = 2
  } else {
    // every part leaves out the unlisted built-ins (a part replaced them); naming one still prints it
    const chosen = wanted.length > 0 ? wanted.map((w) => byId.get(resolveId(w))) : packages.filter((p) => !UNLISTED_BUILT_INS.has(p.id)).sort((a, b) => a.id.localeCompare(b.id))
    const parts = chosen.map((pkg) => catalogEntry(pkg, args))
    if (asJson) {
      console.log(JSON.stringify({ parts, failures }, null, 2))
    } else {
      const full = verbose || wanted.length > 0
      for (const p of parts) console.log(`\n${formatEntry(p, full).join('\n')}`)
      if (wanted.length === 0) {
        const withSignals = parts.filter((p) => p.signals.length > 0)
        const signalCount = withSignals.reduce((n, p) => n + p.signals.length, 0)
        const paramCount = parts.reduce((n, p) => n + p.params.length, 0)
        console.log(`\n${parts.length} part(s), ${paramCount} param(s), ${signalCount} PLC signal(s) across ${withSignals.length}`)
        console.log('Frame: metres, part-local at rotationY = 0, +Y up, a conveyor flows toward +X at positive speed (docs/technical-overview.md "Scene conventions").')
        if (!full) console.log('One part in full, with each param\'s doc line: npm run catalog -- <partId>')
      }
    }
    for (const p of parts) if (p.frameError && args) console.error(`✗ ${p.id}: ${p.frameError}`)
    if (parts.some((p) => p.frameError)) process.exitCode = 1
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`✗ ${f.id}: ${f.error}`)
    process.exitCode = 1
  }
} finally {
  await vite.close()
}
