// Add parts to a project FOLDER, headless - the write half of `catalog`:
//
//   npm run add-part -- <project-folder> <part> [--params k=v,...] [--id <id>] [--at x,y,z] [--rot <deg>] ... [--place | --scaffold]
//
// Each <part> is either
//   • a BUILT-IN package id (`oip.roller-conveyor`, `oip.box` - `npm run catalog` lists them): copied to
//     `parts/<id>/` as this project's own copy at the app's current version, stamped `origin.app` with that
//     version's fingerprint, and listed in project.json `packages` (project format 5: every part a project uses is
//     its own, docs/part-sources.md). A project that already has its own copy keeps it.
//   • a PART FOLDER (manifest.json|rig.json + behavior.js|ts - your own part): baked to prove it loads, copied
//     to `parts/<id>/` as manifest.json + behavior.js, and listed in project.json `packages`, which is how a
//     project carries an authored part. A folder already in the project's `parts/` is not copied: it is listed, and
//     moved to `parts/<id>/` (with its part.js) when it has another name, so no unlisted duplicate is left.
//   • the ID of a part in the project's `parts/` (listed, or just authored there): placed, and listed if it was not.
//   • `building`: the warehouse shell, as the app's New makes it (core/scene/scene.ts defaultBuilding), id `bld_1`
//     unless --id says otherwise. A scene holds at most one. Its --params are checked by core/building/buildingEdit.ts:
//     `lengthSections`, `widthSections`, `heightSections`, `columnSpacing`, the wall `rules` as a JSON list, and
//     `openDoors` (`npm run edit-part -- <folder> bld_1 --docks` lists the door keys). It is not a library part, so
//     nothing is copied to `parts/`. --at x,z puts its centre there on the floor.
//
// A folder with no project.json becomes a new project with an empty scene, so a part can be tested
// from nothing: `npm run add-part -- my-test oip.roller-conveyor oip.box ./my-part --place`.
// `--place` also drops one instance of each part: at the origin, or where that part's own options say. A part given
// any of the options below is placed whether or not --place is there (they describe a placed part). The options
// after a part apply to that part only:
//   --params k=v,...  its params, each checked against the param's declared type (core/parts/partParamArgs.ts). A param
//                     that takes effect only under a switch setting turns the switch to it unless the switch is given
//                     too (`speedFpm=200` on a metric belt sets `fpmUnits=true`: said, never silent); with the switch
//                     given the other way it is warned about. A value the part has already is not stored (printed).
//                     A list is ONE comma-joined value: `--params 'boxColors=#e33,#3e3,width=1'`
//   --id <id>         its scene id (default `<stem>-<n>`); an id already in the scene, or given twice, is an error
//   --at x,z          its position on the floor, in metres: rested there by the editor's own rule (core floorRestPose:
//                     its underside on the floor, a legged deck at its stand height). A placed part with no --at
//                     rests on the floor at the origin.
//   --at x,y,z        its ORIGIN exactly (`npm run catalog -- <id>` prints where that is: a belt's is its tail end),
//                     in metres, y up
//   --rot <deg>       its yaw about +Y, in degrees
// (`npm run snap-part -- <part> --project <folder> --host <id> --id <id> --write` seats one where the editor would.)
// `--scaffold` places them AS A STRAIGHT LINE instead, wired, with a start/stop program and a starter test: what it
// lays out and how it names the tags is src/core/lineScaffold.ts. There a guard or frame device's `--at` x is the
// spot ALONG the line (which runs along +X from x = 0; the snap still seats it), so a diverter can sit just past its
// eye; a source, sink or other part goes exactly to its `--at` / `--rot`; conveyors are always laid end to end. A
// tag named in a part's --params (`--params runTag=MainRun`) is kept and used by the program and the test; the rest
// of what they use is named for them, and a tag nothing in them uses stays blank (unwired). Nothing else given in
// --params is written over either. The program is a Start/Stop latch that starts STOPPED; the starter test presses
// Start first (a button's tag, or a program input named Start). It never overwrites a program or a test that is
// there already (it prints the declarations to add).
//
// All or nothing: every part, every --params value and the scaffold's layout are checked before anything is written,
// so one error writes nothing (no project created, no other part added), and every error found is listed.
//
// The parts each one names (held cargo, a unit load's pallet and cases) come along as copies too.
//
// Why this exists: a part has to be baked and listed to be in a project, and without this CLI that needs the app
// (a built-in "cannot be written by hand"). In two agent trials without it, each lost ~10 minutes there and
// worked around it by copying example parts into parts/ under new ids.
//
// Exit 0 = written, 1 = a part failed to bake / an unknown id / a bad --params value, 2 = usage/IO error (nothing is
// written unless it exits 0).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { bakeBundled, bakeFolder, freshParams, isFolder, projectLibrary, writeJson } from './lib/projectLibrary.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const scaffold = argv.includes('--scaffold')
const place = scaffold || argv.includes('--place')
const usage = (why) => {
  if (why) console.error(`✗ ${why}`)
  console.error('usage: npm run add-part -- <project-folder> <built-in id | own part id | part-folder> [--params k=v,...] [--id <id>] [--at x,z | x,y,z] [--rot <deg>] ... [--place | --scaffold]')
  process.exit(2)
}
// the options after a part apply to that part: index into parts -> { params, id, at, rot }
const PER_PART = new Set(['--params', '--id', '--at', '--rot'])
const positional = []
const optsFor = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (PER_PART.has(a)) {
    const v = argv[i + 1]
    if (positional.length < 2) usage(`${a} follows the part it applies to`)
    if (v === undefined) usage(`${a} wants a value`)
    const o = optsFor.get(positional.length - 2) ?? {}
    if (a === '--params') o.params = v
    else if (a === '--id') {
      if (!/^[^\s,]+$/.test(v)) usage(`--id "${v}" is not an id`)
      o.id = v
    } else if (a === '--at') {
      const xyz = v.split(',').map(Number)
      if ((xyz.length !== 2 && xyz.length !== 3) || xyz.some((n) => !Number.isFinite(n))) usage(`--at wants x,z (on the floor) or x,y,z (the origin) in metres, not "${v}"`)
      o.at = xyz
    } else {
      const d = Number(v)
      if (v.trim() === '' || !Number.isFinite(d)) usage(`--rot wants degrees, not "${v}"`)
      o.rot = d
    }
    optsFor.set(positional.length - 2, o)
    i++
  } else if (!a.startsWith('--')) positional.push(a)
  else if (a !== '--place' && a !== '--scaffold') usage(`unknown option ${a}`)
}
const [folder, ...parts] = positional
if (!folder || parts.length === 0) usage()
{
  const ids = [...optsFor.values()].map((o) => o.id).filter(Boolean)
  const twice = ids.find((id, i) => ids.indexOf(id) !== i)
  if (twice) usage(`--id ${twice} is given to two parts`)
}

const r6 = (n) => Math.round(n * 1e6) / 1e6
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

try {
  // 1. EVERYTHING checked before anything is written: every part resolved, every --params value fitted, the scaffold
  // laid out. One bad part writes nothing (no project created, no other part added), and every error is listed.
  const errors = [] // { message, exit }
  const fail = (message, exit = 1) => errors.push({ message, exit })
  let lib = null // an existing project, opened without writing; a new one is created only in step 2
  let scene
  let bundled
  if (existsSync(join(folder, 'project.json'))) {
    try {
      lib = await projectLibrary(vite, folder, { create: false })
    } catch (e) {
      console.error(`✗ ${e.message}`)
      process.exit(e.exit ?? 2)
    }
    scene = lib.scene
    bundled = lib.bundled
  } else {
    const { emptyScene } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
    scene = emptyScene()
    bundled = await bakeBundled(vite)
  }
  const { registerPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
  const { createSdkPart } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
  const { parseParamArgs, withParamArgs } = await vite.ssrLoadModule('/src/core/parts/partParamArgs.ts')
  const { packageParamSpecs } = await vite.ssrLoadModule('/src/core/packageParams.ts')
  const { floorRestPose } = await vite.ssrLoadModule('/src/core/parts/partGeometry.ts')
  // a new project has no parts of its own yet: a built-in id or a folder
  const resolveNew = async (arg) => {
    if (!isFolder(arg)) {
      const pkg = bundled.get(arg)
      if (pkg) return { pkg }
      const near = [...bundled.keys()].filter((id) => id.includes(arg.replace(/^oip\./, '')))
      return { error: `"${arg}" is neither a folder nor a built-in part id${near.length ? ` - did you mean ${near.join(', ')}?` : ' (npm run catalog lists them)'}`, exit: 1 }
    }
    const baked = await bakeFolder(vite, arg)
    if (baked.error) return baked
    if (bundled.has(baked.pkg.id)) {
      return { error: `${arg}: id "${baked.pkg.id}" is a BUILT-IN id - an authored part under it would shadow the bundled part. Give your part its own id (e.g. "acme.${baked.pkg.id.replace(/^oip\./, '')}").`, exit: 1 }
    }
    return { pkg: baked.pkg }
  }

  const idsTaken = new Set(scene.parts.map((p) => p.id))
  for (const o of optsFor.values()) {
    if (o.id !== undefined && idsTaken.has(o.id)) fail(`--id ${o.id}: the scene already has a part "${o.id}" (pick another --id)`, 2)
    if (o.id !== undefined) idsTaken.add(o.id)
  }
  const plan = [] // in argument order: { arg, pkg, part?, given }
  const buildingEdit = await vite.ssrLoadModule('/src/core/building/buildingEdit.ts')
  const { defaultBuilding } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
  for (const [index, arg] of parts.entries()) {
    if (arg === 'building') {
      const has = scene.parts.find((p) => p.type === 'building') ?? plan.find((s) => s.building)?.part
      if (has) {
        fail(`building: the scene already has one (${has.id}); a scene holds at most one. Change it with npm run edit-part -- ${folder} ${has.id} --params ...`, 2)
        continue
      }
      const o = optsFor.get(index) ?? {}
      let id = o.id ?? 'bld_1'
      for (let n = 2; !o.id && idsTaken.has(id); n++) id = `bld_${n}`
      idsTaken.add(id)
      const part = defaultBuilding(id)
      if (o.at) part.position = o.at.length === 3 ? o.at : [o.at[0], 0, o.at[1]]
      if (o.rot !== undefined) part.rotationY = r6((o.rot * Math.PI) / 180)
      if (o.params !== undefined) {
        try {
          const notes = []
          part.params = buildingEdit.editBuildingParams(part, parseParamArgs(o.params), notes).params
          for (const n of notes) console.log(`  building --params: ${n}`)
        } catch (e) {
          fail(`building --params: ${e.message.replace(/^params: /, '')}`)
          continue
        }
      }
      plan.push({ arg, building: true, part, given: [] })
      continue
    }
    const resolved = lib ? await lib.resolvePart(arg) : await resolveNew(arg)
    if (resolved.error) {
      fail(resolved.error, resolved.exit)
      continue
    }
    const pkg = resolved.pkg
    registerPackage(pkg)
    const step = { arg, pkg, given: [] }
    plan.push(step)
    // a part's own options describe a placed part, so they place it even without --place
    if (!place && !optsFor.has(index)) continue
    const o = optsFor.get(index) ?? {}
    let id = o.id
    if (!id) {
      const stem = pkg.id.split('.').pop()
      let n = 1
      while (idsTaken.has(`${stem}-${n}`)) n++
      id = `${stem}-${n}`
      idsTaken.add(id)
    }
    const part = { id, type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params: freshParams(pkg, scene.units) }
    // the scaffold lays the line out itself and reads --at / --rot as it says (core/lineScaffold.ts)
    if (o.at?.length === 3 && !scaffold) part.position = o.at
    if (o.rot !== undefined && !scaffold) part.rotationY = r6((o.rot * Math.PI) / 180)
    if (o.params !== undefined) {
      // applied to the FULL part (an extent such as a belt's length resolves through its other params), and the
      // scene keeps what changed
      try {
        const full = createSdkPart(pkg, part.id, [0, 0, 0], 0, { placed: true, units: scene.units })
        const base = { ...full, params: { ...full.params, ...part.params } }
        const args = parseParamArgs(o.params)
        const warnings = []
        const notes = []
        // a given param that only takes effect under a switch setting turns the switch to it (unless the switch is
        // given too): `speedFpm=200` on a metric scene's belt means FPM, not "ignored"
        const next = withParamArgs(base, args, warnings, { followSwitches: true, notes })
        for (const n of notes) console.log(`  ${arg} --params: ${n}`)
        for (const w of warnings) console.error(`⚠ ${arg} --params: ${w}`)
        const defaults = new Map(packageParamSpecs(pkg).map((s) => [s.key, s.default]))
        for (const [k, v] of Object.entries(next.params)) if (!same(v, base.params[k])) part.params[k] = v
        // a value the part already has is not stored (the scene stays sparse): say so, so "dropped as the default"
        // is not mistaken for "ignored"
        for (const [k, v] of Object.entries(args)) {
          if (!(k in pkg.params) || !same(next.params[k], base.params[k])) continue
          console.log(`  ${arg} --params: ${k}=${JSON.stringify(v)} is ${same(next.params[k], defaults.get(k)) ? 'the default' : 'what a placed part has already'}, not stored`)
        }
        // what the user said, and the switches it set, the scaffold keeps as it is
        step.given = [...Object.keys(args), ...Object.keys(next.params).filter((k) => !(k in args) && !same(next.params[k], base.params[k]))]
      } catch (e) {
        fail(`${arg} --params: ${e.message.replace(/^params: /, '')}`)
        continue
      }
    }
    if (o.at?.length !== 3 && !scaffold) {
      // on the floor: rested by its full params (a legged deck's stand height, a rig's bounds.bottom) and its yaw
      try {
        const full = createSdkPart(pkg, part.id, [0, 0, 0], part.rotationY, { placed: true, units: scene.units })
        const [x, z] = o.at ?? [0, 0]
        part.position = floorRestPose({ ...full, params: { ...full.params, ...part.params } }, x, z).map(r6)
      } catch (e) {
        fail(`${arg}: could not rest it on the floor (${e.message}); give --at x,y,z`)
        continue
      }
    }
    step.part = part
    if (o.at) step.at = part.position
    if (o.rot !== undefined) step.rot = (o.rot * Math.PI) / 180
  }
  const placed = plan.filter((s) => s.part && !s.building)
  let scaffolded = null
  if (scaffold && errors.length === 0 && placed.length > 0) {
    try {
      scaffolded = scaffoldLayout({ scene, placed, createSdkPart }, await vite.ssrLoadModule('/src/core/lineScaffold.ts'))
    } catch (e) {
      fail(`--scaffold: ${e.message}`, 2)
    }
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e.message}`)
    console.error(`\nnothing written: ${errors.length} error(s) above${lib ? '' : ` (no project created at ${folder})`}`)
    process.exit(Math.max(...errors.map((e) => e.exit ?? 1)))
  }

  // 2. write: the project (created now if new), each part's library copy, the placed parts, the scaffold's files
  if (!lib) lib = await projectLibrary(vite, folder)
  for (const step of plan) {
    if (step.building) {
      lib.scene.parts.push(step.part)
      continue
    }
    const r = await lib.addPart(step.arg)
    if (r.error) {
      // checked in step 1; only a change on disk in between gets here
      console.error(`✗ ${r.error}`)
      process.exit(r.exit ?? 1)
    }
    if (step.part) lib.scene.parts.push(step.part)
  }
  if (scaffolded) writeScaffold(scaffolded, lib.project)
  lib.save()
  for (const s of plan.filter((s) => s.building)) {
    const { lengthSections: L, widthSections: W } = s.part.params
    const doors = buildingEdit.dockDoors(s.part)
    console.log(`+ building ${s.part.id}: ${L} x ${W} sections (${L * 10} x ${W * 10} m), centred at [${s.part.position.join(', ')}], ${doors.length} dock door(s), ${doors.filter((d) => d.open).length} open (npm run edit-part -- ${folder} ${s.part.id} --docks)`)
  }
  if (!scaffold) {
    for (const s of placed.filter((s) => s.at)) console.log(`+ placed ${s.part.id} at [${s.at.join(', ')}]${s.rot !== undefined ? ` yaw ${r6((s.rot * 180) / Math.PI)} deg` : ''}`)
    const atOrigin = placed.filter((s) => !s.at).map((s) => `${s.part.id} [${s.part.position.join(', ')}]`)
    if (atOrigin.length > 0) console.log(`+ placed on the floor at the origin: ${atOrigin.join(', ')} - give each --at x,z (and --rot <deg>) after it, or seat one with npm run snap-part -- <part> --project ${folder} --host <id> --id <id> --write`)
  }
  console.log(`
next: npm run validate-project -- ${folder}   then   npm run test-project -- ${folder}`)
} finally {
  await vite.close()
}
process.exit(0)

// --scaffold: a straight line that RUNS, from nothing - laid out, wired and programmed by core/lineScaffold.ts. Pure:
// it sets the placed parts' poses and params in memory and returns what writeScaffold puts in the folder.
function scaffoldLayout({ scene, placed, createSdkPart }, { scaffoldLine }) {
  const sceneParts = placed.map((s) => s.part)
  const ids = new Set(sceneParts.map((p) => p.id))
  // the scaffold works on FULL params (the geometry reads them); the scene keeps its sparse ones plus what changed
  const full = placed.map(({ part: p, pkg }) => {
    const base = createSdkPart(pkg, p.id, p.position, p.rotationY, { placed: true, units: scene.units })
    return { ...base, params: { ...base.params, ...p.params } }
  })
  // tag names the scene already uses: a new line must not drive (or read) an existing one's signals
  const takenTags = []
  for (const p of scene.parts) {
    if (ids.has(p.id)) continue
    for (const [k, v] of Object.entries(p.params ?? {})) if ((k === 'tag' || k.endsWith('Tag')) && typeof v === 'string' && v) takenTags.push(v)
  }
  const at = Object.fromEntries(placed.filter((s) => s.at).map((s) => [s.part.id, s.at]))
  const rotationY = Object.fromEntries(placed.filter((s) => s.rot !== undefined).map((s) => [s.part.id, s.rot]))
  const given = Object.fromEntries(placed.map((s) => [s.part.id, s.given]))
  const out = scaffoldLine(full, { takenTags, at, rotationY, given })
  const r4 = (n) => Math.round(n * 1e4) / 1e4
  out.parts.forEach((next, i) => {
    const p = sceneParts[i]
    const params = { ...p.params }
    for (const [k, v] of Object.entries(next.params)) if (k in p.params || !same(v, full[i].params[k])) params[k] = typeof v === 'number' ? r6(v) : v
    p.position = next.position.map(r4)
    p.rotationY = r6(next.rotationY)
    p.params = params
    if (next.parent) p.parent = next.parent
  })
  return { out, sceneParts }
}

// what scaffoldLayout returned, into the folder, without overwriting a program or a test that is there
function writeScaffold({ out, sceneParts }, project) {
  const folderOf = (rel) => join(folder, rel)
  const decl = (t) => `  ${t.name} : ${t.type};  (* ${t.owner} *)`
  if (out.program) {
    // the program's files: format 7 lists one per POU (`program`), formats 4-6 name one (`stProgram`)
    const programFiles = Array.isArray(project.program) ? project.program : project.stProgram ? [project.stProgram] : []
    if (programFiles.length === 0) {
      // one file; the app lays a program out one file per POU when it opens the folder (core/project/projectFolder.ts)
      const rel = 'plc/program.st'
      project.program = [rel]
      mkdirSync(dirname(folderOf(rel)), { recursive: true })
      writeFileSync(folderOf(rel), out.program)
      console.log(`+ program ${rel}: ${out.programInputs.length} input(s), ${out.tags.filter((t) => t.dir === 'output').length} output(s), a start/stop latch that starts STOPPED (Start runs it)`)
    } else {
      // never overwrite logic: say what the program has to declare for the new wiring to connect
      console.log(`  ${programFiles.join(', ')} ${programFiles.length === 1 ? 'is' : 'are'} kept as ${programFiles.length === 1 ? 'it is' : 'they are'}; declare the new tags in ${programFiles.length === 1 ? 'it' : 'the program'}:`)
      for (const t of out.tags) console.log(`    ${t.dir === 'input' ? 'VAR_INPUT ' : 'VAR_OUTPUT'} ${decl(t).trim()}`)
    }
  }
  if (out.test) {
    const rel = 'tests/starter.test.json'
    if (!existsSync(folderOf(rel))) {
      writeJson(folderOf(rel), out.test)
      // listing it switches test-project from globbing tests/ to the list, so carry any unlisted ones across
      if (!Array.isArray(project.tests)) {
        project.tests = readdirSync(folderOf('tests')).filter((f) => f.endsWith('.test.json')).map((f) => `tests/${f}`).sort()
      } else if (!project.tests.includes(rel)) project.tests.push(rel)
      console.log(`+ ${rel}: ${out.test.name}`)
    }
  }
  for (const n of out.notes) console.log(`  ${n}`)
  for (const p of sceneParts) {
    const tags = out.tags.filter((t) => t.owner.split(', ').some((o) => o.startsWith(`${p.id}.`))).map((t) => t.name)
    console.log(`  ${p.id.padEnd(22)} ${out.roles.get(p.id).padEnd(8)} at [${p.position.join(', ')}]${p.parent ? ` on ${p.parent}` : ''}${tags.length ? `  ${tags.join(', ')}` : ''}`)
  }
}
