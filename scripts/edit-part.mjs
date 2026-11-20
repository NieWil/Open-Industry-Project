// Change a PLACED part in a project folder, headless:
//
//   npm run edit-part -- <project-folder> <partId> [--params k=v,...] [--at x,y,z] [--rot <deg>] [--name <text>] [--docks]
//
//   --params k=v,...  checked against each param's declared type and applied the way add-part applies them
//                     (core/parts/partParamArgs.ts): a param its `visibleWhen` switch hides is warned about, and
//                     `length` / `width` / `height` on a part with no param of that name resize it through its own
//                     resize path (a belt's length lives in its `segments`).
//                     On the building (core/building/buildingEdit.ts): its size, its wall rules as a JSON list
//                     (`rules=[{"wall":"dock_door","run":1,"gap":0,"count":3,"start":2,"doorCount":2,"trailer":true}]`)
//                     and `openDoors`, the dock doors that start open, by the keys --docks prints
//                     (`openDoors=18:0,18:1`; '' = all shut). Open doors the new rules no longer cut are dropped.
//   --docks           on the building: print which perimeter cells each wall holds (what a rule's `start` counts)
//                     and every dock door with its key, wall, position and whether it starts open. Alone, it writes
//                     nothing.
//   --at x,y,z        the part's new ORIGIN, world metres, y up (`npm run catalog -- <packageId>` says where it is)
//   --rot <deg>       its new yaw about +Y, in degrees
//   --name <text>     its scene-tree name ('' clears it, so the tree shows the id)
// A moved or turned part carries its soft-parented subtree, as the editor's gizmo does (core/parts/partEdit.ts).
// It prints each change, old -> new, and says when a new value is the param's default.
//
// Why this exists: without it the only way to change a part already in scene.json is a hand-written script over
// the JSON, which skips every check add-part makes (types, ranges, hidden params, the resize path).
//
// Exit 0 = written (or nothing to change), 1 = a value did not fit / the project does not load, 2 = usage, IO, or
// an unknown part id (the ids are listed).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { openProjectForEdit } from './lib/projectLibrary.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const usage = (why) => {
  if (why) console.error(`✗ ${why}`)
  console.error('usage: npm run edit-part -- <project-folder> <partId> [--params k=v,...] [--at x,y,z] [--rot <deg>] [--name <text>] [--docks]')
  process.exit(2)
}
const positional = []
const o = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--docks') o.docks = true
  else if (a === '--params' || a === '--at' || a === '--rot' || a === '--name') {
    const v = argv[++i]
    if (v === undefined) usage(`${a} wants a value`)
    if (a === '--params') o.params = v
    else if (a === '--name') o.name = v
    else if (a === '--at') {
      const xyz = v.split(',').map(Number)
      if (xyz.length !== 3 || xyz.some((n) => !Number.isFinite(n))) usage(`--at wants x,y,z in metres, not "${v}"`)
      o.at = xyz
    } else {
      const d = Number(v)
      if (v.trim() === '' || !Number.isFinite(d)) usage(`--rot wants degrees, not "${v}"`)
      o.rot = d
    }
  } else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else positional.push(a)
}
const [folder, partId, ...extra] = positional
if (!folder || !partId) usage()
if (extra.length) usage(`one part at a time (got ${[partId, ...extra].join(', ')})`)
const edits = o.params !== undefined || o.at !== undefined || o.rot !== undefined || o.name !== undefined
if (!edits && !o.docks) usage('nothing to change: give --params, --at, --rot or --name (or --docks to list a building\'s dock doors)')

const r6 = (n) => Math.round(n * 1e6) / 1e6
const shown = (v) => (v === undefined ? '(unset)' : JSON.stringify(v))

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
  let lib
  try {
    lib = await openProjectForEdit(vite, folder)
  } catch (e) {
    console.error(`✗ ${e.message}`)
    exit = e.exit ?? 2
    throw e
  }
  const { scene } = lib
  const part = scene.parts.find((p) => p.id === partId)
  if (!part) {
    console.error(`✗ no part "${partId}" in ${lib.scenePath}. Its parts:`)
    for (const p of scene.parts) console.error(`    ${p.id.padEnd(24)} ${p.packageId ?? p.type}${p.name ? `  "${p.name}"` : ''}`)
    exit = 2
    throw new Error('unknown id')
  }
  const { editPartParams, editPartPose } = await vite.ssrLoadModule('/src/core/parts/partEdit.ts')
  const buildingEdit = await vite.ssrLoadModule('/src/core/building/buildingEdit.ts')
  if (o.docks && part.type !== 'building') {
    console.error(`✗ ${partId} is ${part.type === 'part' ? part.packageId : `a ${part.type}`}: --docks lists a building's dock doors`)
    exit = 2
    throw new Error('not a building')
  }
  const lines = []
  if (o.params !== undefined && part.type === 'building') {
    const { parseParamArgs } = await vite.ssrLoadModule('/src/core/parts/partParamArgs.ts')
    const notes = []
    let r
    try {
      const args = parseParamArgs(o.params)
      r = buildingEdit.editBuildingParams(part, args, notes)
      const same = Object.keys(args).filter((k) => !r.changes.some((c) => c.key === k))
      for (const c of r.changes) lines.push(`  ${c.key}: ${shown(c.from)} -> ${shown(c.to)}${c.isDefault ? '  (the default)' : ''}`)
      if (same.length) lines.push(`  unchanged (already that value): ${same.join(', ')}`)
    } catch (e) {
      console.error(`✗ ${partId} --params: ${e.message.replace(/^params: /, '')}`)
      exit = 1
      throw e
    }
    for (const n of notes) lines.push(`  note: ${n}`)
    part.params = r.params
  } else if (o.params !== undefined) {
    if (part.type !== 'part') {
      console.error(`✗ ${partId} is a ${part.type}, not a part with a package: --params edits a part's package params`)
      exit = 2
      throw new Error('not a part')
    }
    const warnings = []
    let r
    try {
      r = editPartParams(part, o.params, warnings)
    } catch (e) {
      console.error(`✗ ${partId} --params: ${e.message}`)
      exit = 1
      throw e
    }
    for (const w of warnings) console.error(`⚠ ${partId} --params: ${w}`)
    part.params = r.params
    for (const c of r.changes) lines.push(`  ${c.key}: ${shown(c.from)} -> ${shown(c.to)}${c.isDefault ? '  (the default)' : ''}`)
    // a declared param given at its current value is no change; say so, or the edit looks lost
    const { parseParamArgs } = await vite.ssrLoadModule('/src/core/parts/partParamArgs.ts')
    const { getPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
    const declared = getPackage(part.packageId)?.params ?? {}
    const same = Object.keys(parseParamArgs(o.params)).filter((k) => k in declared && !r.changes.some((c) => c.key === k))
    if (same.length) lines.push(`  unchanged (already that value): ${same.join(', ')}`)
    if (r.changes.length === 0 && !same.length) lines.push('  params: no change')
  }
  if (o.at || o.rot !== undefined) {
    const before = new Map(scene.parts.map((p) => [p.id, { position: p.position, rotationY: p.rotationY }]))
    const edit = { ...(o.at ? { at: o.at } : {}), ...(o.rot !== undefined ? { rotationY: r6((o.rot * Math.PI) / 180) } : {}) }
    const r = editPartPose(scene.parts, partId, edit)
    scene.parts = r.parts.map((p) => (r.moved.includes(p.id) ? { ...p, position: p.position.map(r6), rotationY: r6(p.rotationY) } : p))
    for (const id of r.moved) {
      const was = before.get(id)
      const now = scene.parts.find((p) => p.id === id)
      const deg = (rad) => r6((rad * 180) / Math.PI)
      const what = []
      if (JSON.stringify(was.position) !== JSON.stringify(now.position)) what.push(`position [${was.position.join(', ')}] -> [${now.position.join(', ')}]`)
      if (was.rotationY !== now.rotationY) what.push(`yaw ${deg(was.rotationY)} -> ${deg(now.rotationY)} deg`)
      lines.push(`  ${id === partId ? '' : `${id} (carried: in ${partId}'s subtree) `}${what.join(', ') || 'pose unchanged'}`)
    }
  }
  if (o.name !== undefined) {
    const target = scene.parts.find((p) => p.id === partId)
    const was = target.name
    if (o.name === '') delete target.name
    else target.name = o.name
    lines.push(`  name: ${shown(was)} -> ${o.name === '' ? '(unset: shows the id)' : shown(o.name)}`)
  }
  if (edits) {
    lib.save()
    console.log(`${partId} (${part.packageId ?? part.type}):`)
    for (const l of lines) console.log(l)
  }
  const building = scene.parts.find((p) => p.id === partId)
  if (building.type === 'building' && (o.docks || o.params !== undefined)) printDocks(building, buildingEdit)
  if (edits) {
    console.log(`
next: npm run check-layout -- ${folder}   then   npm run test-project -- ${folder}`)
  }
} catch (e) {
  if (exit === 0) {
    console.error(`✗ ${e.message}`)
    exit = 2
  }
} finally {
  await vite.close()
}
process.exit(exit)

/** the perimeter order a wall rule's `start` counts in, and every dock door the rules cut */
function printDocks(building, { perimeterSides, dockDoors }) {
  const { lengthSections: L, widthSections: W } = building.params
  console.log(`
${building.id}: ${L} x ${W} sections (10 m each), perimeter cells by wall (building-local):`)
  for (const s of perimeterSides(L, W)) console.log(`  ${s.side.padEnd(5)} (${s.facing})  cells ${s.first}-${s.last}`)
  const doors = dockDoors(building)
  if (doors.length === 0) {
    console.log('  no dock doors: a rule with "wall":"dock_door" cuts them')
    return
  }
  console.log(`dock doors (${doors.filter((d) => d.open).length} of ${doors.length} start open; openDoors names them by key):`)
  for (const d of doors) console.log(`  ${d.key.padEnd(6)} ${d.side.padEnd(5)}  at x ${d.x}, z ${d.z}  ${d.open ? 'open' : 'shut'}`)
}
