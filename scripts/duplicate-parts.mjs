// Copy a group of placed parts by an offset, headless - a second station from the first in one step:
//
//   npm run duplicate-parts -- <project-folder> <partId...> --offset dx,dy,dz
//                              [--rename Old=New,...] [--tag-suffix S] [--id-suffix S] [--strict]
//
//   --offset dx,dy,dz  world metres added to every copy's position (rotations are kept)
//   --rename Old=New   tags renamed in the copies (a name that matches no copied tag is warned about)
//   --tag-suffix S     appended to every OTHER tag of the copies (never to a direct address such as %IX0.0)
//   --id-suffix S      each copy's id is <id>S (an id that is taken is an error); default <id>-2, or the next free
//   --strict           a clash (below) fails the run, and nothing is written
//
// What follows the copies and what does not (core/parts/partDuplicate.ts): a part's soft-parented subtree comes along;
// `parent` links and `partRef` params (a spawner's conveyorId) that point INSIDE the group are moved onto the
// copies, and ones pointing outside are kept. A copied tag the part WRITES that another part already writes is a
// CLASH (two drivers: last one wins), warned about; a copied INPUT tag left unchanged (a lane's run tag shared with
// the main belt) is listed, since that is often meant. Guard openings, spur extents and the other seam-derived
// geometry are not stored on parts (core/scene/sceneResolve.ts recomputes them from the scene), so the copies get their
// own from where they land.
//
// Why this exists: adding a second identical station took six hand-coordinated add/snap calls with shifted
// coordinates and hand-renamed tags.
//
// Exit 0 = written, 1 = a clash under --strict / the project does not load, 2 = usage, IO, or an unknown part id
// (the ids are listed).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { openProjectForEdit } from './lib/projectLibrary.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const usage = (why) => {
  if (why) console.error(`✗ ${why}`)
  console.error('usage: npm run duplicate-parts -- <project-folder> <partId...> --offset dx,dy,dz [--rename Old=New,...] [--tag-suffix S] [--id-suffix S] [--strict]')
  process.exit(2)
}
const positional = []
const o = { strict: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--strict') o.strict = true
  else if (a === '--offset' || a === '--rename' || a === '--tag-suffix' || a === '--id-suffix') {
    const v = argv[++i]
    if (v === undefined) usage(`${a} wants a value`)
    if (a === '--offset') {
      const xyz = v.split(',').map(Number)
      if (xyz.length !== 3 || xyz.some((n) => !Number.isFinite(n))) usage(`--offset wants dx,dy,dz in metres, not "${v}"`)
      o.offset = xyz
    } else if (a === '--rename') o.rename = o.rename ? `${o.rename},${v}` : v
    else if (a === '--tag-suffix') {
      if (!/^[A-Za-z0-9_]+$/.test(v)) usage(`--tag-suffix "${v}": a tag is an ST identifier, so letters, digits and _ only`)
      o.tagSuffix = v
    } else {
      if (!/^[^\s,]+$/.test(v)) usage(`--id-suffix "${v}" would not make an id`)
      o.idSuffix = v
    }
  } else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else positional.push(a)
}
const [folder, ...ids] = positional
if (!folder || ids.length === 0) usage()
if (!o.offset) usage('--offset dx,dy,dz is required (a copy on top of its original is never what is meant)')
if (o.offset.every((n) => n === 0)) usage('--offset 0,0,0 would put each copy on top of its original')

const r6 = (n) => Math.round(n * 1e6) / 1e6

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
    exit = e.exit ?? 2
    throw e
  }
  const { scene } = lib
  const { duplicateParts, parseRenameMap } = await vite.ssrLoadModule('/src/core/parts/partDuplicate.ts')
  let rename
  try {
    rename = o.rename ? parseRenameMap(o.rename) : undefined
  } catch (e) {
    exit = 2
    throw e
  }
  let r
  try {
    r = duplicateParts(scene.parts, ids, { offset: o.offset, rename, tagSuffix: o.tagSuffix, idSuffix: o.idSuffix })
  } catch (e) {
    exit = 2
    if (e.unknownIds) {
      console.error(`✗ ${e.message}. Its parts:`)
      for (const p of scene.parts) console.error(`    ${p.id.padEnd(24)} ${p.packageId ?? p.type}${p.name ? `  "${p.name}"` : ''}`)
      throw Object.assign(new Error(''), { reported: true })
    }
    throw e
  }
  for (const c of r.copies) c.position = c.position.map(r6)

  const label = (u) => `${u.partId}.${u.key}`
  for (const w of r.warnings) console.error(`⚠ ${w}`)
  if (r.addedChildren.length) console.log(`  + ${r.addedChildren.join(', ')}: in the subtree of a part you named, copied with it`)
  console.log(`copies, offset [${o.offset.join(', ')}] m:`)
  for (const c of r.copies) {
    const from = [...r.idMap].find(([, to]) => to === c.id)[0]
    const tags = r.tags.filter((t) => t.partId === c.id).map((t) => (t.tag === t.from ? `${t.key}=${t.tag}` : `${t.key}=${t.tag} (was ${t.from})`))
    const refs = []
    if (c.parent) refs.push(`parent ${c.parent}`)
    console.log(`  ${from.padEnd(18)} -> ${c.id.padEnd(20)} at [${c.position.join(', ')}]${refs.length ? `  ${refs.join(', ')}` : ''}${tags.length ? `  ${tags.join(', ')}` : ''}`)
  }
  // partRefs: say which were moved onto copies and which still point outside the group
  const { partParamSpecs } = await vite.ssrLoadModule('/src/core/packageParams.ts')
  for (const c of r.copies) {
    for (const spec of partParamSpecs(c)) {
      if (spec.kind !== 'partRef' || !c.params[spec.key]) continue
      const v = c.params[spec.key]
      const inside = [...r.idMap.values()].includes(v)
      console.log(`  ${c.id}.${spec.key} -> ${v} (${inside ? 'the copy' : 'outside the group, kept'})`)
    }
  }
  if (r.shared.length) {
    console.log(`shared inputs (the copy follows the same tag as its original; --rename one to split it):`)
    for (const s of r.shared) console.log(`  ${label(s)} = ${s.tag}`)
  }
  for (const c of r.clashes) {
    console.error(`${o.strict ? '✗' : '⚠'} ${label(c.copy)} writes ${c.copy.tag}, which ${c.writers.map(label).join(', ')} already write${c.writers.length === 1 ? 's' : ''}: two drivers, last one wins. --rename ${c.copy.tag}=<new> or --tag-suffix <S>`)
  }
  if (o.offset[1] !== 0) console.log(`  note: the copies moved ${o.offset[1]} m vertically; a seated part's stand height is copied as is (re-seat with npm run snap-part)`)
  if (o.strict && r.clashes.length) {
    exit = 1
    throw Object.assign(new Error(`${r.clashes.length} tag clash(es) under --strict: nothing written`), { reported: false })
  }
  scene.parts.push(...r.copies)
  lib.save()
  const newTags = [...new Set(r.tags.filter((t) => t.tag !== t.from).map((t) => t.tag))]
  console.log(`+ ${r.copies.length} part(s) written: ${r.copies.map((c) => c.id).join(', ')}`)
  if (newTags.length) console.log(`  new tags (declare them in the program to use them): ${newTags.join(', ')}`)
  console.log(`
next: npm run check-layout -- ${folder}   then   npm run check-wiring -- ${folder}`)
} catch (e) {
  if (!e.reported && e.message) console.error(`✗ ${e.message}`)
  if (exit === 0) exit = 2
} finally {
  await vite.close()
}
process.exit(exit)
