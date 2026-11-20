// Check one part folder, headless - the inner loop of authoring a part:
//
//   npm run check-part -- <part-folder...> [--json]
//
// A part folder is manifest.json (or an example's rig.json) + behavior.js (or behavior.ts). A folder that also holds
// a part.js (a part written as one file, docs/part-authoring-guide.md "Writing a part as one `part.js`") is built in
// memory the way build-parts builds it (scripts/lib/buildPart.mjs). The checks below run on that build, and a
// manifest or behavior beside it that differs from the build is a `stale` problem: either part.js changed and was not
// built, or the file was edited (by the app's Part Editor or an agent tool) and the next build would undo it.
// Four checks, cheapest first, and then a readout of what the part is once baked:
//
//   1. schema - the manifest against @oip/part-sdk's manifest.schema.json. Catches what the app would
//                  silently IGNORE: an unknown key (`noColision`) validates, bakes, and does nothing.
//   2. bake - src/sim/validatePart.ts, the app's own validator: runs the behavior under the determinism
//                  sandbox, checks the rig, the params, the snap refs. Same code the app and the CLIs use.
//   3. footprint - the baked package placed at default params, measured by core's partFootprint (what
//                  snapping, placement and the Inspector see). For a rig that is the DECLARED `bounds`, so a
//                  rig is also MEASURED: rest-pose FK places every collider box and each mesh link's GLB box
//                  (scripts/lib/glb.mjs), and a model outside its bounds, or a collider well outside the model,
//                  is a warning with the fix (an off-centre import, stale bounds, a missing bounds.bottom).
//   4. host facts - a drawn part's host-fed params (src/core/parts/hostFacts.ts): one its own declarations say it
//                  needs and it leaves out is a warning, since that fact then never reaches it.
//   A category one or two letters off a standard one, or off one an earlier folder in the run names, is a warning
//   too: any name is a catalog tab of its own (src/core/parts/partCategory.ts).
//
// Before this existed a part could only be checked by building a whole project folder around it and running
// validate-project (in two agent trials, both routed through a project just to see a bake error).
// Proving the part BEHAVES is still test-project's job: docs/part-authoring-guide.md "Verify it headless".
//
// Exit 0 = every part checks, 1 = a part has problems, 2 = usage/IO error.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { buildPart, hasPartSource } from './lib/buildPart.mjs'
import { drawnElsewhere, emptyBox, growBox, isEmpty, meshLinkBox, parseGlb } from './lib/glb.mjs'
import { checkManifestSchema } from './lib/manifestSchema.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const targets = argv.filter((a) => !a.startsWith('--'))
if (targets.length === 0) {
  console.error('usage: npm run check-part -- <part-folder...> [--json]   (a folder holding manifest.json + behavior.js, or a part.js)')
  process.exit(2)
}

const pick = (dir, names) => names.map((n) => join(dir, n)).find((p) => existsSync(p))

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

const reports = []
try {
  const { validatePart } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
  const { registerPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
  const { partFootprint } = await vite.ssrLoadModule('/src/core/parts/partGeometry.ts')
  const { createSdkPart } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
  const { evalPartGeometry, resolvePartParams } = await vite.ssrLoadModule('/src/core/geometry/geometryEval.ts')
  const { linkHalfExtents, qApply, resolvedMeshScale, rigRestExtent, rigWorldPoses } = await vite.ssrLoadModule('/src/core/rig/rigPose.ts')
  const { instantiatePartScript } = await vite.ssrLoadModule('/src/core/parts/partScript.ts')
  const { compileRig } = await vite.ssrLoadModule('/src/core/rig/rigCompile.ts')
  const { hostFactWarnings } = await vite.ssrLoadModule('/src/core/parts/hostFacts.ts')
  const { PART_CATEGORIES, nearCategory } = await vite.ssrLoadModule('/src/core/parts/partCategory.ts')
  // the categories a part's could be a misspelling of: the standard four, and those the folders checked before it name
  const knownCategories = [...PART_CATEGORIES]

  for (const target of targets) {
    const report = { folder: target, ok: false, problems: [] }
    reports.push(report)
    const problem = (kind, message, where) => report.problems.push({ kind, message, ...(where ? { where } : {}) })
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      problem('io', 'not a folder')
      continue
    }
    let manifest
    let behaviorSource
    let behaviorLabel = 'behavior'
    if (hasPartSource(target)) {
      // A part written as one part.js: check what build-parts would write, and say when the files beside it are not that
      const built = buildPart(target, repo, { instantiatePartScript, compileRig })
      if (!built.files) {
        for (const p of built.problems) problem('build', p, 'part.js')
        continue
      }
      for (const f of built.files) {
        const current = existsSync(join(target, f.name)) ? readFileSync(join(target, f.name), 'utf8').replace(/\r\n/g, '\n') : null
        if (current === f.text) continue
        problem(
          'stale',
          current === null
            ? `${f.name} is missing: build it with \`npm run build-parts -- ${target}\``
            : `${f.name} differs from what part.js builds. If part.js changed, build again (\`npm run build-parts -- ${target}\`). If ${f.name} was edited (by hand, the Part Editor or an agent tool), move that change into part.js, or the next build undoes it`,
        )
      }
      manifest = JSON.parse(built.files[1].text)
      behaviorSource = built.files[0].text
      behaviorLabel = `built ${built.files[0].name}`
      report.source = 'part.js'
    } else {
      const manifestPath = pick(target, ['manifest.json', 'rig.json'])
      const behaviorPath = pick(target, ['behavior.js', 'behavior.ts'])
      if (!manifestPath) problem('io', 'no manifest.json (or rig.json) in the folder')
      if (!behaviorPath) problem('io', 'no behavior.js (or behavior.ts) in the folder')
      if (!manifestPath || !behaviorPath) continue
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch (e) {
        problem('io', `${manifestPath} is not valid JSON: ${e.message}`)
        continue
      }
      behaviorSource = readFileSync(behaviorPath, 'utf8')
    }
    for (const e of checkManifestSchema(manifest)) problem('schema', e.message, e.path)

    const result = validatePart(manifest, behaviorSource)
    for (const d of result.diagnostics) problem(d.kind, d.message, d.line ? `${behaviorLabel} line ${d.line}${d.column ? `:${d.column}` : ''}` : undefined)
    if (!result.ok || !result.package) continue
    const pkg = result.package

    // What the baked part is: the questions an author checks a model against.
    const geo = pkg.geometry
    const params = Object.entries(pkg.params ?? {}).map(([key, s]) => ({ key, type: s.type, default: s.default, ...(s.dir ? { dir: s.dir } : {}), ...(s.stType ? { stType: s.stType } : {}) }))
    const signals = params.filter((p) => p.type === 'tag').map((p) => ({ name: p.key, dir: p.dir ?? null, type: p.stType ?? null, tag: p.default }))
    const links = geo.kind === 'rig' ? geo.links : []
    report.summary = {
      id: pkg.id,
      name: pkg.name,
      geometry: geo.kind,
      // a declared conveyor bed's footprint is the bed itself (its length/width params), not `bounds`
      footprintFrom: pkg.conveyor?.bed ? `the ${pkg.conveyor.bed} conveyor bed (its length/width params; bounds only sets their defaults)` : geo.kind === 'rig' ? (geo.bounds ? 'the declared bounds' : rigRestExtent(geo, resolvePartParams(pkg.params, {})) ? 'its links at rest (no bounds declared)' : 'a default 1 m box (no bounds declared, and a model link core cannot measure: declare bounds)') : null,
      params,
      signals,
      joints: geo.kind === 'rig' ? geo.joints.map((j) => ({ name: j.name, type: j.type, link: j.link, range: [j.min, j.max], ...(j.servo ? { servo: j.servo } : {}) })) : [],
      beams: links.filter((l) => l.beam).map((l) => l.name),
      zones: links.filter((l) => l.zone).map((l) => l.name),
      loadCells: links.filter((l) => l.loadCell).map((l) => l.name),
      colliders: links.filter((l) => l.collision !== 'none' && ['box', 'cylinder'].includes(l.shape.kind)).map((l) => l.name).concat(links.filter((l) => ['mesh', 'frame'].includes(l.shape.kind) && l.collision?.box).map((l) => l.name)),
      conveys: links.filter((l) => l.conveys).map((l) => l.name).concat('conveys' in geo && geo.conveys ? ['(whole part)'] : []),
      snap: pkg.snap ? Object.keys(pkg.snap).filter((k) => pkg.snap[k] !== undefined) : [],
      ...(pkg.useParam ? { useParam: pkg.useParam } : {}),
      ...(pkg.interactive ? { interactive: true } : {}),
    }
    try {
      registerPackage(pkg)
      const fp = partFootprint(createSdkPart(pkg, 'check-part-probe', [0, 0, 0]))
      const cx = fp.cx ?? 0
      const cz = fp.cz ?? 0
      report.summary.footprint = {
        x: [round(cx - fp.hx), round(cx + fp.hx)],
        y: [round(fp.y0), round(fp.y1)],
        z: [round(cz - fp.hz), round(cz + fp.hz)],
      }
    } catch (e) {
      problem('footprint', `could not measure the default instance: ${e.message}`)
    }
    // MEASURE the rig, independently of `bounds`: for a rig the footprint above IS the declared `bounds`, so it
    // can't tell you the model sits somewhere else (an agent trial: "the footprint only echoes what I typed").
    // Rest-pose FK at default params places each collider box and everything DRAWN: each mesh link's GLB box
    // (scripts/lib/glb.mjs mirrors the host's node / fitHeight / hideNodes / keepNode handling), each visible box and
    // cylinder link, and what geometry() draws, on the link it rides (MeshPart.link; the root when it names none, as the
    // host does); the disagreements are the warnings. An arrayed link counts its first copy only.
    report.warnings = []
    // what geometry() draws at default params: measured below, and checked for solids a rig cannot have
    const drawn = geo.kind === 'rig' ? evalPartGeometry(pkg.behavior, resolvePartParams(pkg.params, {})) ?? [] : []
    if (geo.kind === 'rig' && report.summary.footprint) {
      try {
        const defaults = Object.fromEntries(Object.entries(pkg.params ?? {}).map(([k, s]) => [k, s.default]))
        const poses = rigWorldPoses(geo, {}, undefined, 1, defaults)
        const assets = new Map((pkg.assets ?? []).map((a) => [a.id, a]))
        const glbs = new Map()
        const glbOf = (id) => {
          if (!glbs.has(id)) {
            const a = assets.get(id)
            let bytes = null
            if (a?.data) bytes = Buffer.from(a.data, 'base64')
            else if (a?.url && existsSync(join(repo, 'public', a.url))) bytes = readFileSync(join(repo, 'public', a.url))
            glbs.set(id, bytes ? parseGlb(bytes).json : null)
          }
          return glbs.get(id)
        }
        const place = (box, pose, into) => {
          for (let i = 0; i < 8; i++) {
            const c = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]
            const r = qApply(pose.quat, c)
            growBox(into, [r[0] + pose.pos[0], r[1] + pose.pos[1], r[2] + pose.pos[2]])
          }
        }
        const model = emptyBox()
        const colliders = emptyBox()
        // a posable array's copies stand wherever the behavior puts them (round a sorter's chain), so their rest row
        // says nothing about the part's size: they and what geometry() hangs on them are left out of the measure
        const shown = (l) => (!l.showParam || defaults[l.showParam] !== false) && !l.array?.posable
        const posableRows = geo.links.some((l) => l.array?.posable)
        if (posableRows) report.summary.posableRows = geo.links.filter((l) => l.array?.posable).map((l) => l.name)
        for (const l of geo.links) {
          const pose = poses.get(l.name)
          if (!pose || !shown(l)) continue
          if (l.shape.kind === 'mesh') {
            const json = glbOf(l.shape.asset)
            const b = json && meshLinkBox(json, { ...l.shape, drawnElsewhere: drawnElsewhere(geo.links, l) })
            // NODE-SCALING stretches the mesh about the link origin, per axis (a leg grown to the stand height)
            const f = l.shape.sizeParams ? resolvedMeshScale(l.shape.sizeParams, defaults) : [1, 1, 1]
            if (b) place({ min: b.min.map((v, k) => v * f[k]), max: b.max.map((v, k) => v * f[k]) }, pose, model)
          }
          // a box or cylinder is drawn as well as solid, so it is model too, unless `hidden` (a collision-only barrier)
          const primitive = ['box', 'cylinder'].includes(l.shape.kind)
          if (primitive && !l.hidden) {
            const h = linkHalfExtents(l, defaults)
            place({ min: [-h[0], -h[1], -h[2]], max: h }, pose, model)
          }
          const collides = (primitive && l.collision !== 'none') || (['mesh', 'frame'].includes(l.shape.kind) && l.collision?.box)
          if (collides) {
            const h = linkHalfExtents(l, defaults)
            place({ min: [-h[0], -h[1], -h[2]], max: h }, pose, colliders)
          }
        }
        // geometry(): each submesh's box in its link's frame (an instanced bank: the template's box at every instance,
        // scaled, turned and moved), placed by that link's rest pose. A link a showParam hides hides what rides it.
        const ROOT = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
        const linkByName = new Map(geo.links.map((l) => [l.name, l]))
        for (const part of drawn) {
          const at = part.link !== undefined && linkByName.has(part.link) ? part.link : null
          if (at !== null && !shown(linkByName.get(at))) continue
          const pose = at === null ? ROOT : poses.get(at)
          if (!pose) continue
          const own = emptyBox()
          const pos = part.desc.positions
          for (let i = 0; i < pos.length; i += 3) growBox(own, [pos[i], pos[i + 1], pos[i + 2]])
          if (isEmpty(own)) continue
          if (part.instances === undefined) {
            place(own, pose, model)
            continue
          }
          const inLink = emptyBox()
          for (const inst of part.instances) {
            const sc = inst.scale ?? [1, 1, 1]
            const q = inst.quaternion ?? [0, 0, 0, 1]
            for (let i = 0; i < 8; i++) {
              const c = [i & 1 ? own.max[0] : own.min[0], i & 2 ? own.max[1] : own.min[1], i & 4 ? own.max[2] : own.min[2]]
              const r = qApply(q, [c[0] * sc[0], c[1] * sc[1], c[2] * sc[2]])
              growBox(inLink, [r[0] + inst.position[0], r[1] + inst.position[1], r[2] + inst.position[2]])
            }
          }
          if (!isEmpty(inLink)) place(inLink, pose, model)
        }
        const fp = report.summary.footprint
        const fpBox = { min: [fp.x[0], fp.y[0], fp.z[0]], max: [fp.x[1], fp.y[1], fp.z[1]] }
        const fmt = (b) => ({ x: [round(b.min[0]), round(b.max[0])], y: [round(b.min[1]), round(b.max[1])], z: [round(b.min[2]), round(b.max[2])] })
        const TOL = 0.02
        const AX = ['x', 'y', 'z']
        const outside = (inner, outer, what, of, tol = TOL) => {
          for (let k = 0; k < 3; k++) {
            if (inner.min[k] < outer.min[k] - tol) report.warnings.push(`${what} reaches ${AX[k]} = ${round(inner.min[k])}, past ${of} (${AX[k]} from ${round(outer.min[k])})`)
            if (inner.max[k] > outer.max[k] + tol) report.warnings.push(`${what} reaches ${AX[k]} = ${round(inner.max[k])}, past ${of} (${AX[k]} to ${round(outer.max[k])})`)
          }
        }
        if (!isEmpty(model)) report.summary.measured = { model: fmt(model) }
        // A declared conveyor bed's footprint is the bed (its length and width params), and bounds do not change it,
        // so advice to edit bounds could never clear. Hardware past the bed (a guard lip, an indicator head) is shown in
        // the measured line above and left to the author.
        if (!isEmpty(model) && !pkg.conveyor?.bed) {
          // X/Z: bounds are centred on the origin unless they declare centerX / centerZ, so an overflow is either an
          // off-centre model or bounds too small - say which, and both fixes: a mounted device's origin is a mount
          // point by design.
          for (const k of [0, 2]) {
            if (model.min[k] >= fpBox.min[k] - TOL && model.max[k] <= fpBox.max[k] + TOL) continue
            const size = model.max[k] - model.min[k]
            const span = fpBox.max[k] - fpBox.min[k]
            const c = (model.min[k] + model.max[k]) / 2
            const field = k === 0 ? 'length' : 'width'
            const centre = k === 0 ? 'centerX' : 'centerZ'
            report.warnings.push(
              `the model spans ${AX[k]} ${round(model.min[k])}..${round(model.max[k])} but the bounds ${AX[k]} ${round(fpBox.min[k])}..${round(fpBox.max[k])}: ` +
                (size <= span + TOL && Math.abs(c) > TOL
                  ? `centre the model (offset the top-level links by ${round(-c)} on ${AX[k]}, or use fitHeight), or - if the origin is a mount point on purpose - set bounds.${centre} to ${round(c)}`
                  : `set bounds.${field} to ${round(size)} and bounds.${centre} to ${round(c)}`),
            )
          }
          if (model.min[1] < fpBox.min[1] - TOL) report.warnings.push(`the model reaches down to y = ${round(model.min[1])}, below the bounds (from ${round(fpBox.min[1])}): set bounds.bottom to ${round(model.min[1])}`)
          if (model.max[1] > fpBox.max[1] + TOL) report.warnings.push(`the model reaches up to y = ${round(model.max[1])}, above the bounds (to ${round(fpBox.max[1])}): set bounds.top to ${round(model.max[1])}`)
        }
        if (!isEmpty(colliders)) {
          report.summary.measured = { ...report.summary.measured, colliders: fmt(colliders) }
          // a collider a little proud of the mesh is common and deliberate (a blade's contact face); 5 cm is a mistake
          // with posable rows left out the model is not the whole part, so a collider past it says nothing
          if (!isEmpty(model) && !posableRows) outside(colliders, model, 'a collider', 'the model', 0.05)
        }
      } catch (e) {
        report.warnings.push(`could not measure the rig: ${e.message}`)
      }
    }
    // On a RIG, geometry() only draws: its solids are its links, so a drawn submesh asking to be solid (or to be a
    // side guard) loads and then does nothing. Warned, not refused: the part is otherwise fine.
    if (geo.kind === 'rig') {
      const solid = drawn.filter((p) => p.collision !== undefined || p.sideGuard !== undefined).length
      if (solid > 0) report.warnings.push(`geometry() draws ${solid} submesh(es) with \`collision\` or \`sideGuard\`, but on a rig part drawn submeshes are render-only: cargo passes through them. Make each solid a link (a box link collides as itself; a guard wall is a box link with \`sideGuard: 'left' | 'right'\`)`)
    }
    // Link rotations and revolute joint limits are radians. A value past a full turn is almost always degrees, which
    // loads fine and leaves the link at a random-looking angle (a label edge-on, so it reads as missing).
    if (geo.kind === 'rig') {
      const TURN = 2 * Math.PI + 1e-6
      const asRad = (v) => round((v * Math.PI) / 180)
      for (const l of geo.links) {
        const r = l.rotation
        if (Array.isArray(r) && r.some((v) => Math.abs(v) > TURN)) report.warnings.push(`link "${l.name}": rotation [${r.join(', ')}] turns more than a full turn; rotation is in radians. If you meant degrees, that is [${r.map(asRad).join(', ')}]`)
      }
      for (const j of geo.joints) {
        if (j.type !== 'revolute') continue
        // a joint may turn more than once (a drum, a spool), so only a whole number past a turn reads as degrees
        const over = ['min', 'max'].filter((k) => typeof j[k] === 'number' && Math.abs(j[k]) > TURN && Number.isInteger(j[k]) && !j.servo?.modulo)
        if (over.length > 0) report.warnings.push(`joint "${j.name}": ${over.map((k) => `${k} ${j[k]}`).join(', ')} is more than a full turn; a revolute joint's limits are in radians. If you meant degrees, that is ${over.map((k) => `${k} ${asRad(j[k])}`).join(', ')}`)
      }
    }
    // A part with no collision body at all can't stop, carry or push anything - usually a mesh-only import.
    if (geo.kind === 'rig' && report.summary.colliders.length === 0 && report.summary.conveys.length === 0 && report.summary.zones.length === 0) {
      report.warnings.push('no link builds a collision body (mesh links are visual-only unless they declare `collision`): cargo will pass through this part')
    }
    // The facts the host hands a drawn part through fixed-name params (a guard opening, a beam hole, a merge's wall):
    // one the part leaves out never reaches it, with no error (src/core/parts/hostFacts.ts)
    try {
      for (const w of hostFactWarnings(pkg, createSdkPart(pkg, 'check-part-probe', [0, 0, 0]))) report.warnings.push(w)
    } catch (e) {
      report.warnings.push(`could not check the host-fed params: ${e.message}`)
    }
    // any category name is a catalog tab of its own, so one a letter or two off a known one ("Device") is probably a typo
    if (typeof pkg.category === 'string') {
      const near = nearCategory(pkg.category, knownCategories)
      if (near) report.warnings.push(`category "${pkg.category}" makes a catalog tab of its own, beside "${near}". If you meant "${near}", use that`)
      knownCategories.push(pkg.category)
    }
    report.ok = report.problems.length === 0
  }
} finally {
  await vite.close()
}

function round(n) {
  return Math.round(n * 1000) / 1000
}

if (asJson) {
  console.log(JSON.stringify(reports, null, 2))
} else {
  for (const r of reports) {
    const s = r.summary
    console.log(`${r.ok ? '✓' : '✗'} ${r.folder}${s ? `  →  ${s.id} "${s.name}" (${s.geometry})` : ''}`)
    for (const p of r.problems) console.log(`    ✗ [${p.kind}] ${p.where ? `${p.where}: ` : ''}${p.message}`)
    for (const w of r.warnings ?? []) console.log(`    ! ${w}`)
    if (!s) continue
    const box = (b) => `x ${b.x.join('..')}  y ${b.y.join('..')}  z ${b.z.join('..')}`
    if (s.footprint) console.log(`    footprint at default params (m, part-local): ${box(s.footprint)}${s.footprintFrom ? `   ← ${s.footprintFrom}` : ''}`)
    if (s.measured?.model) console.log(`    measured model at rest:                     ${box(s.measured.model)}${s.posableRows ? `  (without the posable rows ${s.posableRows.join(', ')}, which stand where step() puts them)` : ''}`)
    if (s.measured?.colliders) console.log(`    measured colliders at rest:                 ${box(s.measured.colliders)}`)
    for (const g of s.signals) console.log(`    signal  ${(g.dir ?? '?').padEnd(3)} ${(g.type ?? '?').padEnd(4)} ${g.name}${g.fixed ? ' (fixed name)' : ` = "${g.tag}"`}`)
    for (const j of s.joints) console.log(`    joint   ${j.name} (${j.type} on ${j.link}, ${j.range.join('..')})${j.servo ? `  servo: ${j.servo.maxVelocity}/s, ${j.servo.maxAccel}/s²${j.servo.modulo ? `, wraps at ${j.servo.modulo}` : ''}` : ''}`)
    const list = (label, xs) => xs.length > 0 && console.log(`    ${label.padEnd(8)}${xs.join(', ')}`)
    list('collide', s.colliders)
    list('conveys', s.conveys)
    list('beams', s.beams)
    list('zones', s.zones)
    list('weighs', s.loadCells)
    list('snap', s.snap)
    console.log(`    params  ${s.params.map((p) => p.key).join(', ') || '(none)'}`)
  }
  if (reports.some((r) => r.ok)) console.log('\nnext: prove it behaves - docs/part-authoring-guide.md "Verify it headless" (npm run add-part + test-project)')
}
process.exit(reports.every((r) => r.ok) ? 0 : reports.some((r) => r.problems.some((p) => p.kind === 'io')) && reports.length === 1 ? 2 : 1)
