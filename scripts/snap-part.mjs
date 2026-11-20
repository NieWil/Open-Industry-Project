// Where would the editor SNAP this part, headless - and, with --write, put it there:
//
//   node scripts/snap-part.mjs <part> --onto <built-in id | part-folder>
//          [--host-params k=v,...] [--host-at x,y,z] [--host-rot <deg>]
//          [--at x,y,z [--local]] [--rot <deg>] [--params k=v,...] [--json]
//   node scripts/snap-part.mjs <part | placed id> --project <folder> [--host <placed id>]
//          [--at x,y,z [--local]] [--rot <deg>] [--params k=v,...] [--write [--id <new id>]] [--json]
//
// <part> is a built-in id (examples/parts/*), a part folder, or, with --project, a package in that project's
// library or the id of a part already placed in its scene (which is then RE-seated).
//
// The HOST is either a fresh part (--onto) at --host-at (default the origin) with yaw --host-rot (default 0) and
// --host-params on top of its defaults, or, with --project, that project's placed part --host as it stands in the
// scene: its params, position and rotation. Leave --host out (with --at) to let the snap pick among every part in
// the scene, as the editor's drop does. Everything printed is in WORLD coordinates of that placement, plus the
// pose in the host's local frame (x along it, z across, y up from its origin).
//
// The mover is proposed at --at (default: the host's footprint centre, on its top surface; a placed part being
// re-seated, where it stands; `--local` reads --at in the host's frame) with yaw --rot (default 0; a re-seated part,
// its own yaw). --at is where the MOVER'S ORIGIN goes, not its centre: `npm run
// catalog -- <part>` prints where a part's origin sits ("origin: x -X end, z centre" for a belt conveyor, whose origin
// is its TAIL end), and a "no snap" says it too. Core's REAL snap engine answers: src/core/snap/snapFeatures.ts
// `findSnap`, which the editor's live snap (controller.ts applyLiveSnap) calls on every pointer-move.
// --params sets the mover's params before it snaps (a sensor's tag, a box size). Params are `k=v` pairs or a JSON
// object; `length` / `width` / `height` on a part with no such param are extents through its resize handle (a
// belt's `length=3` stretches its segments): core/parts/partParamArgs.ts.
//
// Printed: the connectors matched (`via`, e.g. `mounts[1] -> face`, docs/part-snap-connectors.md), the world
// pose, the params the snap FITS on the mover (paramOverrides) and host (targetParamOverrides), a soft-parent
// `attach`, and the junction - or "no snap" and why. Then "on commit": railing gaps, deck notches, an edge-mounted
// guest's lift, guard openings - the app's own resolvers, run on the snapped pose. Those are DERIVED from the scene
// whenever it resolves (core/scene/sceneResolve.ts), so nothing writes them: committing the pose, the fits and the
// parent is the whole edit.
//
// --write (needs --project) makes that edit in the project folder through core/snap/snapCommit.ts, the code the
// editor's drop and the agent door's snap_part commit with: the part is added to the scene (as --id, default
// `<stem>-<n>`; an --id already placed is re-seated) at the snapped pose with its fitted params and parent, and
// the host gets its fitted params. A part the project lacks is copied into it first, the way add-part
// does (scripts/lib/projectLibrary.mjs). Nothing is written when nothing snaps.
//
// NOT modelled (editor-only layers on top of findSnap): the sticky-target hysteresis between pointer-moves,
// the Alt / live-snap toggle, the floor/leg rest resolvers that run when NOTHING snaps, and the explicit
// pointer-ray modes (hold-B Face mode `faceMatePose`, surface align `surfaceAlignPose`/`surfaceRestPose`),
// which need a ray hit on a mesh this script does not have.
//
// Exit 0 = snapped (and written), 1 = no snap (or a part failed to bake), 2 = usage/IO error.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { bakeBundled, bakeFolder, isFolder, loadProject, projectLibrary } from './lib/projectLibrary.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const local = argv.includes('--local')
const write = argv.includes('--write')
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const valued = new Set(['--onto', '--at', '--rot', '--host-params', '--host-at', '--host-rot', '--params', '--project', '--host', '--id'])
const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
const moverArg = positional[0]
const ontoArg = flag('--onto')
const projectArg = flag('--project')
const hostIdArg = flag('--host')
const newIdArg = flag('--id')
const usage = (why) => {
  if (why) console.error(`✗ ${why}`)
  const out = why === null ? console.log : console.error
  out(
    'usage: node scripts/snap-part.mjs <part> --onto <built-in id | part-folder> [--host-params k=v,...] [--host-at x,y,z] [--host-rot <deg>] [--at x,y,z [--local]] [--rot <deg>] [--params k=v,...] [--json]\n' +
      '       node scripts/snap-part.mjs <part | placed id> --project <folder> [--host <placed id>] [--at x,y,z [--local]] [--rot <deg>] [--params k=v,...] [--write [--id <new id>]] [--json]\n' +
      "  --at x,y,z   where the MOVER'S ORIGIN is dropped, in world metres (--local: in the host's frame, x along it, z across,\n" +
      "               y up from its origin). The origin is not the centre: `npm run catalog -- <part>` prints where it sits\n" +
      "               (\"origin: x -X end\" = a belt conveyor's tail). Default: the host's top centre.\n" +
      "  --rot <deg>  the mover's yaw about +Y.   --params / --host-params k=v,...: params, checked against their declared types.",
  )
  process.exit(why === null ? 0 : 2)
}
if (argv.includes('--help') || argv.includes('-h')) usage(null)
const vec3 = (name) => {
  const a = flag(name)
  if (a === undefined) return undefined
  const v = a.split(',').map(Number)
  if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) usage(`${name} wants x,y,z`)
  return v
}
const degrees = (name) => {
  const a = flag(name)
  const d = a === undefined ? 0 : Number(a)
  if (!Number.isFinite(d)) usage(`${name} wants degrees`)
  return d
}
if (!moverArg || positional.length > 1) usage()
if (!ontoArg === !projectArg) usage('give the host as --onto <part> (a fresh one) or --project <folder> [--host <id>] (a placed one)')
if (ontoArg && (hostIdArg || write || newIdArg)) usage('--host, --write and --id need --project')
if (projectArg && (flag('--host-params') !== undefined || flag('--host-at') !== undefined || flag('--host-rot') !== undefined)) usage('a --project host is the placed part as it stands: --host-params/--host-at/--host-rot are for --onto')
const at = vec3('--at')
if (local && !at) usage('--local reads --at in the host frame: give --at')
if (local && projectArg && !hostIdArg) usage('--local needs a host (--host)')
const rotDeg = degrees('--rot')
const hostAt = vec3('--host-at') ?? [0, 0, 0]
const hostRotDeg = degrees('--host-rot')

const r4 = (n) => Math.round(n * 1e4) / 1e4
const r6 = (n) => Math.round(n * 1e6) / 1e6
// degrees in (-180, 180]
const deg = (rad) => {
  const d = r4((rad * 180) / Math.PI) % 360
  return r4(d > 180 ? d - 360 : d <= -180 ? d + 360 : d)
}
const fail = (message, exit) => Object.assign(new Error(message), { exit })

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

let code = 1
try {
  const { registerPackage, getPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
  const { partFootprint, isConveyorLike, toWorldXZ, toLocalXZ } = await vite.ssrLoadModule('/src/core/parts/partGeometry.ts')
  const { createSdkPart } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
  const { findSnap } = await vite.ssrLoadModule('/src/core/snap/snapFeatures.ts')
  const { commitSnap } = await vite.ssrLoadModule('/src/core/snap/snapCommit.ts')
  const { subtreeIds } = await vite.ssrLoadModule('/src/core/scene/hierarchy.ts')
  const { computeStructureConnections } = await vite.ssrLoadModule('/src/core/structureConnections.ts')
  const { deriveGuardOpenings } = await vite.ssrLoadModule('/src/core/guards/guardOpenings.ts')
  const { parseParamArgs, withParamArgs } = await vite.ssrLoadModule('/src/core/parts/partParamArgs.ts')
  const { originAlong } = await vite.ssrLoadModule('/src/core/parts/partCatalog.ts')

  const parseParams = (name) => {
    const text = flag(name)
    if (text === undefined) return null
    try {
      return parseParamArgs(text)
    } catch (e) {
      throw fail(`${name}: ${e.message}`, 2)
    }
  }
  const applyParams = (part, args, name) => {
    if (!args) return part
    try {
      const warnings = []
      const next = withParamArgs(part, args, warnings)
      for (const w of warnings) console.error(`⚠ ${name}: ${w}`)
      return next
    } catch (e) {
      throw fail(`${name}: ${e.message}`, 2)
    }
  }

  // ---- the scene the snap runs in: one fresh host, or the project's placed parts
  let sceneParts // PartInstance[] the snap sees (and onCommit resolves over)
  let host = null
  let units
  let bundled
  const bakeArg = async (arg) => {
    if (isFolder(arg)) {
      const r = await bakeFolder(vite, arg)
      if (r.error) throw fail(r.error, r.exit)
      return r.pkg
    }
    bundled ??= await bakeBundled(vite)
    const pkg = bundled.get(arg)
    if (!pkg) throw fail(`"${arg}" is neither a part folder nor a built-in id (npm run catalog lists them)`, 2)
    return pkg
  }

  let moverPkg
  let existing = null // a placed part being re-seated
  if (projectArg) {
    await declareBuiltIns(vite)
    const loaded = await loadProject(vite, projectArg)
    if (loaded.errors) throw fail(`${projectArg} does not load (npm run validate-project -- ${projectArg}):\n  ${loaded.errors.join('\n  ')}`, 2)
    sceneParts = loaded.project.scene.parts ?? []
    units = loaded.project.scene.units
    if (hostIdArg) {
      host = sceneParts.find((p) => p.id === hostIdArg) ?? null
      if (!host) throw fail(`no part "${hostIdArg}" in ${projectArg}'s scene (ids: ${sceneParts.map((p) => p.id).join(', ') || 'none'})`, 2)
    }
    const placedId = newIdArg ?? (!isFolder(moverArg) && sceneParts.some((p) => p.id === moverArg) ? moverArg : undefined)
    existing = placedId ? (sceneParts.find((p) => p.id === placedId) ?? null) : null
    if (existing) {
      if (existing.type !== 'part') throw fail(`"${existing.id}" is a ${existing.type}, not a part`, 2)
      moverPkg = getPackage(existing.packageId)
      if (!moverPkg) throw fail(`"${existing.id}"'s package ${existing.packageId} does not resolve`, 2)
      if (moverArg !== existing.id && !isFolder(moverArg) && moverArg !== existing.packageId) {
        throw fail(`--id ${existing.id} is already placed as ${existing.packageId}, not ${moverArg}: pick a new id, or name it to re-seat it`, 2)
      }
    } else {
      // the project's own copy when it has one, else the app's built-in (or the folder)
      moverPkg = !isFolder(moverArg) ? getPackage(moverArg) : undefined
      moverPkg ??= await bakeArg(moverArg)
      registerPackage(moverPkg)
    }
  } else {
    let hostPkg
    moverPkg = await bakeArg(moverArg)
    hostPkg = await bakeArg(ontoArg)
    // mover first, host second: when both are the same package they are one registration anyway
    registerPackage(moverPkg)
    if (hostPkg !== moverPkg) registerPackage(hostPkg)
    host = applyParams(createSdkPart(hostPkg, 'host', hostAt, (hostRotDeg * Math.PI) / 180), parseParams('--host-params'), '--host-params')
    sceneParts = [host]
  }

  // ---- the proposed drop
  const hostRot = host?.rotationY ?? 0
  const toWorld = (p) => {
    const w = toWorldXZ(host, p[0], p[2])
    return [w.x, host.position[1] + p[1], w.z]
  }
  if (!host && !at && !existing) throw fail('without --host, say where it is dropped with --at', 2)
  const hfp = host ? partFootprint(host) : null
  // a placed part being re-seated is proposed where it stands, at its own yaw, unless --at / --rot say otherwise: the
  // host's centre would move it to wherever the host's nearest feature is, far from where it was put
  const proposedPos = at ? (local ? toWorld(at) : at) : existing ? [...existing.position] : toWorld([hfp.cx ?? 0, hfp.y1, hfp.cz ?? 0])
  const rotationY = existing && flag('--rot') === undefined ? existing.rotationY : (rotDeg * Math.PI) / 180 + (local ? hostRot : 0)
  // a new part's id: --id, else the next free `<stem>-<n>` in the project (what add-part --place names it)
  const freeId = () => {
    const stem = moverPkg.id.split('.').pop()
    let n = 1
    while (sceneParts.some((p) => p.id === `${stem}-${n}`)) n++
    return `${stem}-${n}`
  }
  const moverId = existing?.id ?? newIdArg ?? (projectArg ? freeId() : 'mover')
  let mover = existing
    ? { ...existing, position: proposedPos, rotationY }
    : createSdkPart(moverPkg, moverId, proposedPos, rotationY, { placed: true, units })
  const moverParamArgs = parseParams('--params')
  mover = applyParams(mover, moverParamArgs, '--params')
  const own = new Set(existing ? subtreeIds(sceneParts, [existing.id]) : [])
  const candidates = host ? [host] : sceneParts.filter((p) => !own.has(p.id))
  const snapDecl = moverPkg.snap ?? {}
  const declared = Object.keys(snapDecl).filter((k) => snapDecl[k] !== undefined && snapDecl[k] !== false)
  const conveyor = isConveyorLike(mover)

  const c = findSnap(mover, { position: proposedPos, rotationY }, candidates)
  const target = c ? sceneParts.find((p) => p.id === c.targetId) : host

  // name the connectors that matched: the engine labels every candidate `<mover plug> -> <host socket>`
  // (core/snap/snapConnectors.ts), so this is read, not guessed. A few get a plain-words gloss.
  const GLOSS = {
    conveyor: 'conveyor ends (end-to-end, side merge, curve or spur: the conveyor engine)',
    'track -> rollerBed': 'track (roller-bed seat)',
    'tile -> tile': 'tile (edge-to-edge tiling)',
    'chain -> chain': 'chain (collinear extend or L-corner)',
    'flush -> face': 'flush (ambient face-flush)',
  }
  const feature = c ? (GLOSS[c.via] ?? c.via ?? 'unknown') : null

  const fitted = c?.paramOverrides ? Object.entries(c.paramOverrides).map(([key, value]) => ({ key, value: typeof value === 'number' ? r4(value) : value, default: mover.params[key] })) : []
  const hostFitted = c?.targetParamOverrides ? Object.entries(c.targetParamOverrides).map(([key, value]) => ({ key, value: typeof value === 'number' ? r4(value) : value, default: target.params[key] })) : []
  const hostName = host ? (projectArg ? host.id : host.packageId) : 'the scene'

  let reason = null
  if (!c) {
    if (!conveyor && declared.length === 0) reason = `${moverPkg.id} declares no snap feature (no \`snap\` block, not conveyor-like) - the editor places it by the floor/surface rest resolvers only; hold-B Face mode is the explicit way to seat it${host && isConveyorLike(host) ? '. To feed this conveyor, give it a position above the belt (add-part --scaffold puts a source over the infeed of a line)' : ''}`
    else if (conveyor && host && !isConveyorLike(host)) reason = `${moverPkg.id} is conveyor-like and snaps only to conveyors; ${hostName} is not one`
    else {
      reason = `${moverPkg.id} declares ${conveyor ? 'conveyor ends' : declared.map((k) => `snap.${k}`).join(', ')}, but nothing on ${hostName} engages from the proposed pose (wrong host kind, or outside the engage/height/facing gates)`
      // A facing gate is the common miss (an out-facing mount whose drop yaw points the wrong way): say which
      // quarter-turn WOULD engage from the same spot, so the caller's next try is not a guess.
      const yaws = [0, 90, 180, 270].filter((d) => Math.abs(((d - rotDeg) % 360 + 360) % 360) > 1e-6)
      const hit = yaws.find((d) => {
        const r = (d * Math.PI) / 180 + (local ? hostRot : 0)
        return findSnap({ ...mover, rotationY: r }, { position: proposedPos, rotationY: r }, candidates)
      })
      reason += hit !== undefined ? `; from the same spot it WOULD snap at --rot ${hit} (a facing gate)` : '; no quarter-turn yaw engages from this spot either - try --at nearer the feature'
      // an edge-mounted flight or ladder stands on the FLOOR, and a deck host's origin is often its deck top
      if (snapDecl.edgeMount?.fromFloor) reason += `. ${moverPkg.id} stands on the floor (edgeMount.fromFloor): propose it at FLOOR height, below the deck (a platform's origin is its deck top, so its floor is at -height)`
    }
    // --at is the mover's ORIGIN, not its centre: say where that sits on it, the usual cause of a near miss
    const mfp = partFootprint(mover)
    const [x0, x1, z0, z1] = [(mfp.cx ?? 0) - mfp.hx, (mfp.cx ?? 0) + mfp.hx, (mfp.cz ?? 0) - mfp.hz, (mfp.cz ?? 0) + mfp.hz]
    reason += `. (The proposed position is ${moverPkg.id}'s ORIGIN, which sits at its x ${originAlong(x0, x1, 'X')}, z ${originAlong(z0, z1, 'Z')}: its footprint spans x ${r4(x0)}..${r4(x1)}, z ${r4(z0)}..${r4(z1)} about it at yaw 0; npm run catalog -- ${moverPkg.id})`
  }

  // The committed scene: the snap through core/snap/snapCommit (what the editor's drop writes), rounded the way a
  // written file keeps it.
  let committed = null
  if (c) {
    const pose = { position: c.pose.position.map(r6), rotationY: r6(c.pose.rotationY) }
    const base = existing ? sceneParts.map((p) => (p.id === mover.id ? mover : p)) : [...sceneParts, mover]
    committed = commitSnap(base, mover.id, { ...c, pose })
  }

  // What the connection DOES once committed: the same cross-part resolvers the app runs over the scene, on the
  // mover at its snapped pose with its fitted params (and the host with any params the snap fits on it) - a
  // railing gap or deck notch in a deck host, the lift that raises an edge-mounted guest flush, a guard opening
  // where a conveyor meets another's side. Without this a snap that seats correctly but cuts nothing looked fine.
  let onCommit = null
  if (c) {
    const placed = committed.find((p) => p.id === mover.id)
    const hostC = committed.find((p) => p.id === c.targetId)
    const conn = computeStructureConnections([hostC, placed])
    const ranges = (rs) => rs.map(([a, b]) => [r4(a), r4(b)])
    const edgeGaps = (pc) => (pc ? Object.fromEntries(Object.entries(pc.openings).filter(([, rs]) => rs.length > 0).map(([e, rs]) => [e, ranges(rs)])) : {})
    const guards = (a, b) => {
      const g = deriveGuardOpenings(a, [b])
      return { ...(g.left.length ? { left: ranges(g.left) } : {}), ...(g.right.length ? { right: ranges(g.right) } : {}) }
    }
    onCommit = {
      hostOpens: edgeGaps(conn.platform.get(hostC.id)),
      hostNotches: conn.platform.get(hostC.id)?.notches.length ?? 0,
      moverOpens: edgeGaps(conn.platform.get(placed.id)),
      moverLift: conn.stairTopConnected.has(placed.id) ? r4(conn.stairTopConnected.get(placed.id)) : null,
      hostGuardOpenings: guards(hostC, placed),
      moverGuardOpenings: guards(placed, hostC),
    }
  }

  // ---- --write: the same edit, into the project's files
  let wrote = null
  if (c && write) {
    const lib = await projectLibrary(vite, projectArg, { create: false, log: asJson ? () => {} : console.log })
    const raw = lib.scene.parts
    let rawMover = raw.find((p) => p.id === mover.id)
    if (!rawMover) {
      if (!lib.project.packages.includes(`parts/${moverPkg.id}`)) {
        const added = await lib.addPart(isFolder(moverArg) ? moverArg : moverPkg.id)
        if (added.error) throw fail(added.error, added.exit)
      }
      rawMover = lib.place(moverPkg, mover.id)
      raw.push(rawMover)
    }
    // the params --params set (what changed on the full part), then the snap's commit over the file's own parts
    if (moverParamArgs) {
      const before = existing ?? createSdkPart(moverPkg, mover.id, proposedPos, rotationY, { placed: true, units })
      for (const [k, v] of Object.entries(mover.params)) if (JSON.stringify(v) !== JSON.stringify(before.params[k])) rawMover.params = { ...rawMover.params, [k]: v }
    }
    const round = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r6(v) : v])) : o)
    const pose = { position: c.pose.position.map(r6), rotationY: r6(c.pose.rotationY) }
    lib.scene.parts = [...commitSnap(raw, mover.id, { ...c, pose, paramOverrides: round(c.paramOverrides), targetParamOverrides: round(c.targetParamOverrides) })]
    lib.save()
    wrote = { project: projectArg, id: mover.id, added: !existing }
  }

  const fp = host ? partFootprint(host) : null
  const corners = fp
    ? [
        [(fp.cx ?? 0) - fp.hx, (fp.cz ?? 0) - fp.hz],
        [(fp.cx ?? 0) + fp.hx, (fp.cz ?? 0) - fp.hz],
        [(fp.cx ?? 0) - fp.hx, (fp.cz ?? 0) + fp.hz],
        [(fp.cx ?? 0) + fp.hx, (fp.cz ?? 0) + fp.hz],
      ].map(([x, z]) => toWorldXZ(host, x, z))
    : []
  const hostReport = host
    ? {
        id: projectArg ? host.id : host.packageId,
        packageId: host.packageId,
        position: host.position.map(r4),
        rotationYDeg: deg(hostRot),
        // world AABB of the footprint
        footprint: {
          x: [r4(Math.min(...corners.map((p) => p.x))), r4(Math.max(...corners.map((p) => p.x)))],
          y: [r4(host.position[1] + fp.y0), r4(host.position[1] + fp.y1)],
          z: [r4(Math.min(...corners.map((p) => p.z))), r4(Math.max(...corners.map((p) => p.z)))],
        },
      }
    : null
  const localPose = (pose, about) => {
    const l = toLocalXZ(about, pose.position[0], pose.position[2])
    return { position: [r4(l.x), r4(pose.position[1] - about.position[1]), r4(l.z)], rotationYDeg: deg(pose.rotationY - (about.rotationY ?? 0)) }
  }
  const report = {
    mover: moverPkg.id,
    ...(existing ? { reseats: existing.id } : {}),
    declares: conveyor ? ['(conveyor ends)', ...declared] : declared,
    host: hostReport,
    proposed: { position: proposedPos.map(r4), rotationYDeg: deg(rotationY) },
    snapped: !!c,
    ...(c
      ? {
          feature,
          onto: c.targetId === 'host' ? hostReport.id : c.targetId,
          via: c.via ?? null,
          join: c.join ?? null,
          pose: { position: c.pose.position.map(r4), rotationY: r4(c.pose.rotationY), rotationYDeg: deg(c.pose.rotationY) },
          poseInHost: localPose(c.pose, target),
          fits: fitted,
          hostFits: hostFitted,
          attach: c.attach ?? false,
          override: c.override ?? false,
          cost: r4(c.cost),
          junction: [r4(c.junction.x), r4(c.junction.y), r4(c.junction.z)],
          onCommit,
          ...(wrote ? { wrote } : {}),
        }
      : { reason }),
  }

  if (asJson) console.log(JSON.stringify(report, null, 2))
  else {
    if (hostReport) {
      const f = hostReport.footprint
      const params = projectArg ? 'its params in the project' : flag('--host-params') ? `params ${flag('--host-params')}` : 'default params'
      console.log(`host   ${hostReport.id} at (${hostReport.position.join(', ')}) yaw ${hostReport.rotationYDeg} deg, ${params} - world footprint x ${f.x.join('..')}, y ${f.y.join('..')}, z ${f.z.join('..')}`)
    } else console.log(`host   any part in ${projectArg}'s scene`)
    console.log(`mover  ${existing ? `${existing.id} (${moverPkg.id})` : moverPkg.id} (declares: ${report.declares.join(', ') || 'nothing'}) proposed at (${report.proposed.position.join(', ')}) yaw ${report.proposed.rotationYDeg} deg`)
    if (!c) console.log(`✗ no snap - ${reason}`)
    else {
      console.log(`✓ snapped: ${feature}${c.join ? `  [${c.join}]` : ''}${host ? '' : `  onto ${c.targetId}`}`)
      console.log(`  pose      position (${report.pose.position.join(', ')})  rotationY ${report.pose.rotationY} rad (${report.pose.rotationYDeg} deg)  [world]`)
      console.log(`  in host   position (${report.poseInHost.position.join(', ')})  yaw ${report.poseInHost.rotationYDeg} deg  [${report.onto}'s frame: x along, y up from its origin, z across]`)
      for (const p of fitted) console.log(`  fits      ${p.key} = ${p.value}  (was ${p.default})`)
      for (const p of hostFitted) console.log(`  host fits ${p.key} = ${p.value}  (was ${p.default})`)
      if (c.attach) console.log('  attach    soft-parents the mover under the host')
      console.log(`  junction  (${report.junction.join(', ')})  cost ${report.cost}${c.override ? '  [body-overlap override]' : ''}`)
      const o = onCommit
      const fmt = (m) => Object.entries(m).map(([k, rs]) => `${k} ${rs.map(([a, b]) => `${a}..${b}`).join(', ')}`).join('; ')
      const lines = [
        Object.keys(o.hostOpens).length ? `host deck edge opens: ${fmt(o.hostOpens)} (part-local)` : null,
        o.hostNotches ? `host deck notched: ${o.hostNotches} notch(es)` : null,
        Object.keys(o.moverOpens).length ? `mover deck edge opens: ${fmt(o.moverOpens)}` : null,
        o.moverLift !== null ? `mover lifted ${o.moverLift} m (flush onto the deck)` : null,
        Object.keys(o.hostGuardOpenings).length ? `host guard opens: ${fmt(o.hostGuardOpenings)} (along its bed, m)` : null,
        Object.keys(o.moverGuardOpenings).length ? `mover guard opens: ${fmt(o.moverGuardOpenings)}` : null,
      ].filter(Boolean)
      console.log(lines.length ? lines.map((l) => `  on commit ${l}`).join('\n') : '  on commit nothing is cut, opened or lifted')
      if (lines.length) console.log('            (derived from the scene each time it resolves: nothing to write for these)')
      if (wrote) console.log(`✓ wrote ${existing ? 're-seated' : 'placed'} ${wrote.id} into ${projectArg}${c.targetParamOverrides ? `, and the fits on ${c.targetId}` : ''}${c.attach ? `, parented to ${c.targetId}` : ''}`)
      else if (projectArg && !write) console.log('  (--write puts it there)')
    }
  }
  code = c ? 0 : 1
} catch (e) {
  if (e?.exit !== undefined) {
    console.error(`✗ ${e.message}`)
    code = e.exit
  } else {
    console.error(e)
    code = 2
  }
} finally {
  await vite.close()
}
process.exit(code)
