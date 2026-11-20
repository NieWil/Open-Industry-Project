// Convert a STEP model to a GLB, headless: the conversion the Inspector's "Import model..." runs on a .step/.stp file,
// so an agent or a script can bring a CAD model into a part folder without the app.
//
//   npm run import-model -- <file.step|.stp> [--out <file.glb>] [--detail normal|coarse] [--min-part-mm <n>]
//                           [--no-merge] [--up z|y] [--json]
//
// Same kernel (occt-import-js) and same code (editor/stepConvert.ts -> core/stepToGlb.ts) as the app, with its
// defaults: normal detail, solids under 10 mm dropped, one mesh per colour, and the up axis guessed from the header's
// exporting program (core stepUpAxisGuess). The GLB sits on Y = 0, centred in X and Z. `npm run inspect-glb` reads it
// back; docs/part-authoring-guide.md "Bring your own model (GLB)" is the next step.
//
// Exit 0 = written, 1 = the file could not be converted, 2 = usage/IO error.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const USAGE = 'usage: npm run import-model -- <file.step|.stp> [--out <file.glb>] [--detail normal|coarse] [--min-part-mm <n>] [--no-merge] [--up z|y] [--json]'

function fail(msg, code = 2) {
  console.error(msg)
  process.exit(code)
}

const flags = new Map()
const files = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json' || a === '--no-merge') flags.set(a, true)
  else if (a === '--out' || a === '--detail' || a === '--min-part-mm' || a === '--up') {
    if (argv[i + 1] === undefined) fail(`${a} needs a value\n${USAGE}`)
    flags.set(a, argv[++i])
  } else if (a.startsWith('--')) fail(`unknown option ${a}\n${USAGE}`)
  else files.push(a)
}
if (files.length !== 1) fail(USAGE)

const input = resolve(files[0])
if (!existsSync(input)) fail(`no file ${input}`)
// The USD reader runs only in a browser (a Web Worker, image decoding), so USD imports through the app instead
if (/^\.(usd|usda|usdc|usdz)$/i.test(extname(input)))
  fail(`${basename(input)} is USD, which converts in the app: the Inspector's Import model... on a rig node, or the desktop app's agent tool import_model`)
if (!/^\.(step|stp)$/i.test(extname(input))) fail(`${basename(input)} is not a .step or .stp file (a GLB needs no conversion: npm run inspect-glb)`)
const detail = flags.get('--detail') ?? 'normal'
if (detail !== 'normal' && detail !== 'coarse') fail(`--detail is normal or coarse, not ${detail}`)
const minPartMm = flags.has('--min-part-mm') ? Number(flags.get('--min-part-mm')) : undefined
if (minPartMm !== undefined && !(Number.isFinite(minPartMm) && minPartMm >= 0)) fail('--min-part-mm is a number of millimetres, 0 or more')
const up = flags.get('--up')
if (up !== undefined && up !== 'z' && up !== 'y') fail(`--up is z or y, not ${up}`)
const out = resolve(flags.get('--out') ?? join(dirname(input), `${basename(input, extname(input))}.glb`))
const asJson = flags.has('--json')

const bytes = new Uint8Array(readFileSync(input))

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

let result
try {
  const { DEFAULT_STEP_OPTIONS, stepUpAxisGuess } = await vite.ssrLoadModule('/src/core/stepToGlb.ts')
  const { convertStep } = await vite.ssrLoadModule('/src/editor/stepConvert.ts')
  // the header is in the first few KB; the app reads 16 KB
  const guess = stepUpAxisGuess(new TextDecoder().decode(bytes.subarray(0, 16384)))
  const options = {
    ...DEFAULT_STEP_OPTIONS,
    detail,
    upAxis: up ?? guess.up,
    ...(minPartMm !== undefined ? { minPartMm } : {}),
    ...(flags.has('--no-merge') ? { mergeByColour: false } : {}),
  }
  const occt = await createRequire(import.meta.url)('occt-import-js')()
  try {
    const { glb, stats } = convertStep(occt, bytes, options)
    writeFileSync(out, glb)
    result = { ok: true, out, bytes: glb.byteLength, options, upAxis: { used: options.upAxis, given: up !== undefined, guess }, stats }
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
} finally {
  await vite.close()
}

if (asJson) console.log(JSON.stringify(result, null, 2))
else if (!result.ok) console.error(`could not convert ${basename(input)}: ${result.error}`)
else {
  const { stats, upAxis } = result
  const why = upAxis.given ? 'given' : upAxis.guess.known ? `guessed from ${upAxis.guess.system}` : `default; the header names ${upAxis.guess.system ?? 'no program'}, so check it`
  console.log(`wrote ${result.out} (${(result.bytes / 1e6).toFixed(2)} MB)`)
  console.log(`  ${stats.solids} solids, ${stats.skipped} dropped under ${result.options.minPartMm} mm, ${stats.meshes} meshes, ${stats.triangles} triangles`)
  console.log(`  size ${stats.size.map((n) => n.toFixed(3)).join(' x ')} m (x, y up, z)`)
  console.log(`  up axis ${upAxis.used} (${why})`)
}
process.exit(result.ok ? 0 : 1)
