// Give a project folder's wired PLC tags I/O addresses for a real PLC, or print its I/O list, headless:
//
//   npm run assign-io -- <project-folder> [--list <io-list.csv>] [--poll <inputBase>,<outputBase>]
//   npm run assign-io -- <project-folder> --export [<file.csv>]
//
//   (no option)     every tag a part is wired to by name gets an address, declared AT it in the program
//                   (`Eye AT %IX100.0 : BOOL`), and its parts are rewired to the address
//   --list <csv>    the addresses come from an I/O list (at least Tag and Address columns; --export's format)
//   --poll <i>,<o>  address for a PLC the simulator polls, packed from those first registers (the external PLC
//                   link's "the simulator polls the PLC" mode); default: the simulator serves the I/O
//   --export        print the I/O list as CSV (or write it to <file.csv>); changes nothing
//
// The same edit as the PLC panel's "Assign I/O" / "Import I/O list" and the agent door's assign_io
// (src/editor/program/ioAssign.ts).
//
// Exit 0 = done, 1 = the project does not load or has no program to assign, 2 = usage/IO error.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { openProgramProject } from './lib/projectProgramEdit.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const usage = (why) => {
  if (why) console.error(`✗ ${why}`)
  console.error('usage: npm run assign-io -- <project-folder> [--list <io-list.csv>] [--poll <inputBase>,<outputBase>]\n       npm run assign-io -- <project-folder> --export [<file.csv>]')
  process.exit(2)
}
const positional = []
const o = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--list') o.list = argv[++i] ?? usage('--list wants a CSV file')
  else if (a === '--poll') {
    const v = argv[++i] ?? usage('--poll wants <inputBase>,<outputBase>')
    const b = v.split(',').map(Number)
    if (b.length !== 2 || b.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) usage(`--poll wants two register numbers, 0-65535, not "${v}"`)
    o.poll = b
  } else if (a === '--export') {
    o.export = true
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o.exportTo = argv[++i]
  } else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else positional.push(a)
}
const [folder, ...extra] = positional
if (!folder || extra.length) usage()
if (o.export && o.list) usage('--export changes nothing; give it alone')

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
  const { assignIo, importIoList, ioListCsv, ioTargetFor, reportSummary } = await vite.ssrLoadModule('/src/editor/program/ioAssign.ts')
  const { DEFAULT_EXTERNAL_PLC } = await vite.ssrLoadModule('/src/editor/store/storePrefs.ts')
  const settings = { ...DEFAULT_EXTERNAL_PLC, ...(o.poll ? { mode: 'poll', inputBase: o.poll[0], outputBase: o.poll[1] } : {}) }
  if (o.export) {
    const csv = ioListCsv(p.scene, p.stProgram ?? '', p.name, settings)
    if (o.exportTo) {
      writeFileSync(o.exportTo, csv)
      console.log(`wrote ${o.exportTo}`)
    } else process.stdout.write(csv)
  } else {
    if (!p.stProgram) throw Object.assign(new Error(`${folder} has no PLC program to declare addresses in`), { exit: 1 })
    if (!isKnownDialect(p.stDialect)) throw Object.assign(new Error(`the program is in a dialect this version does not run ("${p.stDialect}")`), { exit: 1 })
    let text
    if (o.list) {
      try {
        text = readFileSync(o.list, 'utf8')
      } catch (e) {
        throw Object.assign(new Error(`cannot read ${o.list}: ${e.message}`), { exit: 2 })
      }
    }
    const target = ioTargetFor(settings)
    const edit = text === undefined ? assignIo(p.scene, p.stProgram, target) : importIoList(p.scene, p.stProgram, text, target)
    const written = proj.write({ ...p, stProgram: edit.source, ...(edit.scene ? { scene: edit.scene } : {}) })
    const r = edit.report
    console.log(reportSummary(r))
    for (const a of r.assigned) console.log(`  ${a.address.padEnd(12)} ${a.name}  (${a.parts} part${a.parts === 1 ? '' : 's'})`)
    for (const k of r.skipped) console.log(`  left: ${k.name ? `${k.name}: ` : ''}${k.reason}`)
    for (const w of written) console.log(`  wrote ${w}`)
    if (r.assigned.length) console.log(`\nnext: npm run assign-io -- ${folder} --export   then   npm run test-project -- ${folder}`)
  }
} catch (e) {
  console.error(`✗ ${e.message}`)
  exit = e.exit ?? 2
} finally {
  await vite.close()
}
process.exit(exit)
