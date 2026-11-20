// Rename a PLC tag in a project folder, headless, and move every part wired to it to the new name:
//
//   npm run rename-tag -- <project-folder> <from> <to> [--pou <name>]
//
//   --pou <name>   the PROGRAM, FUNCTION_BLOCK or FUNCTION that declares the tag; leave it out for a top-level
//                  (controller) tag
//
// The same rename as the PLC panel's F2 and the agent door's rename_tag (src/editor/program/tagRename.ts): every spelling of
// the tag in the program and nothing else, refused with the reason when a name would collide. Editing the .st file by
// hand changes the code and leaves parts wired to the old name. Tests are not changed: it warns about each test that
// still names the old tag.
//
// Exit 0 = renamed, 1 = the rename was refused or the project does not load, 2 = usage/IO error.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { openProgramProject } from './lib/projectProgramEdit.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const usage = (why) => {
  if (why) console.error(`✗ ${why}`)
  console.error('usage: npm run rename-tag -- <project-folder> <from> <to> [--pou <name>]')
  process.exit(2)
}
const positional = []
let pou = ''
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--pou') {
    pou = argv[++i] ?? usage('--pou wants a name')
  } else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else positional.push(a)
}
const [folder, from, to, ...extra] = positional
if (!folder || !from || !to || extra.length) usage()

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

let exit = 0
try {
  const proj = await openProgramProject(vite, folder)
  const p = proj.project
  const { isKnownDialect } = await vite.ssrLoadModule('/src/core/dialect.ts')
  const { planTagRename, testsNamingTag } = await vite.ssrLoadModule('/src/editor/program/tagRename.ts')
  const { DEFAULT_SCAN_MS } = await vite.ssrLoadModule('/src/editor/program/stProgram.ts')
  if (!p.stProgram) throw Object.assign(new Error(`${folder} has no PLC program`), { exit: 1 })
  if (!isKnownDialect(p.stDialect)) throw Object.assign(new Error(`the program is in a dialect this version does not run ("${p.stDialect}"), so its tags cannot be renamed`), { exit: 1 })
  const plan = planTagRename(p.scene, p.stProgram, p.controller ?? null, p.stScanMs ?? DEFAULT_SCAN_MS, pou, from, to)
  if (plan.error !== null) throw Object.assign(new Error(plan.error), { exit: 1 })
  const written = proj.write({ ...p, stProgram: plan.source, ...(plan.scene ? { scene: plan.scene } : {}) })
  console.log(`${from} is now ${to.trim()}${pou ? ` in ${pou}` : ''}`)
  console.log(plan.parts.length ? `  rewired: ${plan.parts.join(', ')}` : '  no part was wired to it')
  for (const w of written) console.log(`  wrote ${w}`)
  const stale = testsNamingTag(p.tests ?? [], plan.oldNames)
  if (stale.length) console.error(`⚠ these tests still name ${from} and will fail until you update them: ${stale.join(', ')}`)
  console.log(`\nnext: npm run check-wiring -- ${folder}   then   npm run test-project -- ${folder}`)
} catch (e) {
  console.error(`✗ ${e.message}`)
  exit = e.exit ?? 2
} finally {
  await vite.close()
}
process.exit(exit)
