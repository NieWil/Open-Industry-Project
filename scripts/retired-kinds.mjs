// When may a retired rig shape kind (RETIRED_SHAPE_KINDS in src/core/parts/partUpgrade.ts) be deleted for good?
//
// A retired kind keeps LOADING (its links are dropped) for a grace period, because saved scenes, project libraries
// and collab rooms embed a copy of every package they use. Deleting the entry turns such a save from "loads without
// those links" into "fails to load", so it needs two answers, and this script gives both:
//
//   1. Is the grace period over? It starts on the first commit on main after which no shipped manifest
//      (examples/parts/**/*.json) declares the kind, i.e. the day the replacement shipped, and lasts
//      RETIRED_KIND_GRACE_MONTHS. That date is READ FROM GIT, so nobody has to remember to write it down.
//   2. Does any collab room still hold it? A room outlives the build that wrote it (rooms idle for 90 days are
//      swept; a room opened now and then is not). Pass a copy of the collab database and every stored room AND
//      every room snapshot (a restore brings those back) is decoded and searched.
//
// Run: npm run retired-kinds                          grace periods only
//      npm run retired-kinds -- --db <collab.sqlite>  and scan a collab database (a backup; see server/DEPLOY.md)
//      npm run retired-kinds -- --ref main            judge against another ref (default origin/main, else main)
//
// A kind is REMOVABLE only when its grace period is over AND a database was scanned and holds none of it.
// Exit 0 on a report (whatever it says), 2 on bad input.
/* global process, console */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import * as Y from 'yjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const dbPath = opt('--db')
if (dbPath !== undefined && !existsSync(dbPath)) {
  console.error(`no such database: ${dbPath}`)
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const refExists = (ref) => {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
    return true
  } catch {
    return false
  }
}
const ref = opt('--ref') ?? (refExists('origin/main') ? 'origin/main' : 'main')
if (!refExists(ref)) {
  console.error(`no such git ref: ${ref}`)
  process.exit(2)
}

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
let RETIRED_SHAPE_KINDS, RETIRED_KIND_GRACE_MONTHS, packagesMap
try {
  ;({ RETIRED_SHAPE_KINDS, RETIRED_KIND_GRACE_MONTHS } = await vite.ssrLoadModule('/src/core/parts/partUpgrade.ts'))
  ;({ packagesMap } = await vite.ssrLoadModule('/src/collab/schema.ts'))
} finally {
  await vite.close()
}
const kinds = Object.keys(RETIRED_SHAPE_KINDS)

// ---- 1. grace periods, from git ----
// the kind as a manifest spells it, whatever the whitespace
const kindPattern = (kind) => `"kind"[[:space:]]*:[[:space:]]*"${kind}"`
function landing(kind) {
  let files = ''
  try {
    files = git('grep', '-l', '-E', kindPattern(kind), ref, '--', 'examples/parts')
  } catch {
    // git grep exits 1 when nothing matches: no shipped manifest declares it any more
  }
  if (files) return { pending: files.split('\n').map((f) => f.replace(`${ref}:`, '')) }
  // the newest commit that changed how many times the manifests declare it: the one that removed the last
  const line = git('log', ref, '-1', '--format=%cs %h', '--pickaxe-regex', '-S', kindPattern(kind).replaceAll('[[:space:]]', '\\s'), '--', 'examples/parts')
  if (!line) return { never: true }
  const [date, sha] = line.split(' ')
  return { date, sha }
}
const addMonths = (ymd, months) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}
const today = new Date().toISOString().slice(0, 10)

// ---- 2. collab rooms ----
async function scanRooms(file) {
  const sqlite3 = createRequire(resolve(repo, 'server/package.json'))('sqlite3')
  const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY)
  const all = (sql) => new Promise((ok, fail) => db.all(sql, (e, rows) => (e ? fail(e) : ok(rows))))
  const tables = new Set((await all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name))
  if (!tables.has('documents')) throw new Error(`${file} has no documents table: not a collab database`)
  const rows = [
    ...(await all('SELECT name, NULL AS ts, data FROM documents')).map((r) => ({ ...r, where: 'room' })),
    ...(tables.has('snapshots') ? await all('SELECT name, ts, data FROM snapshots') : []).map((r) => ({ ...r, where: 'snapshot' })),
  ]
  db.close()
  const hits = new Map(kinds.map((k) => [k, []]))
  let undecodable = 0
  for (const row of rows) {
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, new Uint8Array(row.data))
    } catch {
      undecodable++
      continue
    }
    packagesMap(doc).forEach((m, id) => {
      let def
      try {
        def = JSON.parse(m.get('def'))
      } catch {
        return // a malformed def never loads anyway
      }
      const links = def?.geometry?.kind === 'rig' && Array.isArray(def.geometry.links) ? def.geometry.links : []
      for (const k of kinds) {
        if (links.some((l) => l?.shape?.kind === k)) hits.get(k).push({ where: row.where, room: row.name, ts: row.ts, packageId: id })
      }
    })
    doc.destroy()
  }
  return { hits, rooms: rows.filter((r) => r.where === 'room').length, snapshots: rows.filter((r) => r.where === 'snapshot').length, undecodable }
}

let scan = null
if (dbPath !== undefined) {
  try {
    scan = await scanRooms(resolve(dbPath))
  } catch (e) {
    console.error(`could not scan ${dbPath}: ${e instanceof Error ? e.message : e}`)
    console.error('(the scan uses the collab server\'s sqlite3: run `npm --prefix server ci` once if it is missing)')
    process.exit(2)
  }
}

// ---- report ----
console.log(`retired rig shape kinds, judged against ${ref} on ${today} (grace period ${RETIRED_KIND_GRACE_MONTHS} months)`)
if (scan) console.log(`collab database ${dbPath}: ${scan.rooms} rooms, ${scan.snapshots} snapshots${scan.undecodable ? `, ${scan.undecodable} undecodable (IGNORED)` : ''}`)
else console.log('no collab database given (--db): no kind can be called removable')
for (const kind of kinds) {
  const { retired } = RETIRED_SHAPE_KINDS[kind]
  const land = landing(kind)
  console.log(`\n${kind}  (retired in the source ${retired})`)
  let graceOver = false
  if (land.pending) {
    console.log(`  shipped:   NOT YET - still declared on ${ref} by ${land.pending.join(', ')}`)
    console.log('  grace:     starts when the replacement reaches main')
  } else {
    const start = land.never ? retired : land.date
    const until = addMonths(start, RETIRED_KIND_GRACE_MONTHS)
    graceOver = today >= until
    console.log(land.never ? `  shipped:   no shipped manifest ever declared it; counting from ${retired}` : `  shipped:   ${land.date} (${land.sha}, the last manifest stopped declaring it)`)
    console.log(`  grace:     until ${until}${graceOver ? ' - OVER' : ''}`)
  }
  const hits = scan?.hits.get(kind) ?? null
  if (hits) {
    const inRooms = new Set(hits.filter((h) => h.where === 'room').map((h) => h.room))
    const inSnaps = new Set(hits.filter((h) => h.where === 'snapshot').map((h) => h.room))
    console.log(`  rooms:     ${inRooms.size} room(s) and snapshots of ${inSnaps.size} room(s) still declare it`)
    for (const h of hits.slice(0, 20)) console.log(`             ${h.where} ${h.room}${h.ts ? ` @ ${new Date(h.ts).toISOString()}` : ''}  package ${h.packageId}`)
    if (hits.length > 20) console.log(`             ... ${hits.length - 20} more`)
  }
  const clean = hits !== null && hits.length === 0 && !scan.undecodable
  const verdict = graceOver && clean ? 'REMOVABLE' : 'KEEP'
  const why = !graceOver ? 'grace period not over' : hits === null ? 'no collab database scanned' : !clean ? (hits.length ? 'stored rooms still declare it' : 'some rooms could not be decoded') : 'grace over, no room holds it'
  console.log(`  verdict:   ${verdict} (${why})`)
}
