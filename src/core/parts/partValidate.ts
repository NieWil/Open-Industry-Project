// Validation of a part package (partPackage.ts): what a stored or imported package must hold before the
// runtime loads it. Rig links and joints are checked in partValidateRig.ts.

import { isFiniteNum, isVec3, validateRig, validateSizeParams } from './partValidateRig'
import { RETIRED_SNAP_ADVICE, RETIRED_SNAP_KINDS, RETIRED_SWEEP_ADVICE, RETIRED_SWEEP_KIND } from './partUpgrade'
import { PACKAGE_FORMAT, parseCopyGripName, type PackageProblem, type PartCredit, type PartPackage } from './partPackage'

/** Structural validation of an untrusted, imported package. Returns [] when OK. */
export function validatePartPackage(pkg: unknown): PackageProblem[] {
  const problems: PackageProblem[] = []
  const p = pkg as Partial<PartPackage> | null | undefined
  const need = (cond: boolean, field: string, message: string): void => {
    if (!cond) problems.push({ field, message })
  }
  const format = (p as { format?: unknown } | null | undefined)?.format
  need(
    format === PACKAGE_FORMAT,
    'format',
    typeof format === 'number' && format > PACKAGE_FORMAT
      ? `saved by a newer version (package format ${format}; this build reads up to ${PACKAGE_FORMAT})`
      : `unsupported or missing package format (expected ${PACKAGE_FORMAT})`,
  )
  need(typeof p?.id === 'string' && p.id.length > 0, 'id', 'id must be a non-empty string')
  need(typeof p?.name === 'string' && p.name.length > 0, 'name', 'name must be a non-empty string')
  need(typeof p?.behavior === 'string' && p.behavior.length > 0, 'behavior', 'behavior source is required')
  need(!!p?.params && typeof p.params === 'object', 'params', 'params schema is required (may be empty)')
  const assetIds = validateAssets((p as { assets?: unknown } | undefined)?.assets, problems)
  const materialIds = validateMaterials((p as { materials?: unknown } | undefined)?.materials, problems, assetIds)
  const g = p?.geometry as { kind?: unknown; length?: unknown; width?: unknown } | undefined
  if (g?.kind === RETIRED_SWEEP_KIND) need(false, 'geometry.kind', `geometry.kind "${RETIRED_SWEEP_KIND}" (a swept bed) was retired: ${RETIRED_SWEEP_ADVICE}`)
  else if (g?.kind === 'function') need(false, 'geometry.kind', 'geometry.kind "function" was renamed "drawn" (package format 4)')
  else if (g?.kind === 'deck') need(false, 'geometry.kind', 'geometry.kind "deck" was retired (package format 4): a rig with one `conveys` box link is the same conveyor, and can resize')
  else need(!!g && (g.kind === 'rig' || g.kind === 'drawn' || g.kind === 'cargo'), 'geometry', 'geometry.kind must be "rig", "drawn" or "cargo"')
  if (g && g.kind === 'rig') {
    if ((g as { bounds?: unknown }).bounds !== undefined) validateBounds((g as { bounds?: unknown }).bounds, problems)
    validateRig(g as { links?: unknown; joints?: unknown }, problems, assetIds, materialIds)
  } else if (g && g.kind === 'drawn') {
    validateDrawnGeometry(g as { bounds?: unknown; material?: unknown; conveys?: unknown }, problems, materialIds)
  } else if (g && g.kind === 'cargo') {
    validateCargoGeometry(g as { cargoKind?: unknown; bounds?: unknown }, problems)
  }
  validateSnap((p as { snap?: unknown } | undefined)?.snap, problems)
  validateConveyor(p as Record<string, unknown> | undefined, problems)
  validateSetpoints(p?.params, problems)
  validateTagSignals(p?.params, problems)
  validateAttributes(p?.params, problems)
  validateUnit(p, problems)
  validateHolds(p, problems)
  validateCargoDecl(p as Record<string, unknown> | undefined, problems)
  const origin = (p as { origin?: unknown } | undefined)?.origin
  need(
    origin === undefined || (!!origin && typeof origin === 'object' && !Array.isArray(origin) && Object.values(origin).every((v) => typeof v === 'string' && v !== '')),
    'origin',
    'origin must map each source to a non-empty fingerprint string',
  )
  const credit = (p as { credit?: unknown } | undefined)?.credit
  need(credit === undefined || isPartCredit(credit), 'credit', 'credit must name a library, and may name who made the part and an https link')
  return problems
}

/** A holds declaration names a cargo package, its own gripper links (each with a grip zone), and a number param. */
/**
 * A part's `cargo` declaration ({@link CargoDecl}): only on a rig with no joints, and its named params of the right
 * type. Whether the rig has a colliding link centred on its origin is the author's check (sim/validatePart.ts), so a
 * stored part is never dropped for it.
 */
function validateCargoDecl(p: Record<string, unknown> | undefined, problems: PackageProblem[]): void {
  const c = p?.cargo
  if (c === undefined) return
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    problems.push({ field: 'cargo', message: 'cargo must be an object: { friction?, massParam?, colorParam?, forkPockets?, heavy?, loadBase?, separateContacts?, nestDepth? }' })
    return
  }
  const geo = p?.geometry as { kind?: unknown; joints?: unknown } | undefined
  if (geo?.kind !== 'rig') problems.push({ field: 'cargo', message: 'cargo is declared on a rig geometry: its links are the cargo body' })
  else if (Array.isArray(geo.joints) && geo.joints.length > 0) problems.push({ field: 'cargo', message: 'cargo moves as one rigid body, so its rig has no joints' })
  const d = c as { friction?: unknown; massParam?: unknown; colorParam?: unknown; nestDepth?: unknown } & Record<string, unknown>
  if (d.friction !== undefined && !(typeof d.friction === 'number' && Number.isFinite(d.friction) && d.friction >= 0)) {
    problems.push({ field: 'cargo.friction', message: 'cargo.friction must be a number >= 0' })
  }
  for (const flag of ['forkPockets', 'heavy', 'loadBase', 'separateContacts'] as const) {
    if (d[flag] !== undefined && typeof d[flag] !== 'boolean') problems.push({ field: `cargo.${flag}`, message: `cargo.${flag} must be true or false` })
  }
  if (d.nestDepth !== undefined && !(typeof d.nestDepth === 'number' && Number.isFinite(d.nestDepth) && d.nestDepth > 0)) {
    problems.push({ field: 'cargo.nestDepth', message: 'cargo.nestDepth must be a number > 0 (m)' })
  }
  const params = (p?.params ?? {}) as Record<string, { type?: unknown } | undefined>
  for (const [field, type, fallback] of [['massParam', 'number', 'mass'], ['colorParam', 'color', 'color']] as const) {
    const name = d[field]
    if (name !== undefined && (typeof name !== 'string' || name === '')) {
      problems.push({ field: `cargo.${field}`, message: `cargo.${field} must name a param` })
      continue
    }
    const key = typeof name === 'string' ? name : fallback
    const spec = params[key]
    if (spec !== undefined ? spec.type !== type : name !== undefined) {
      problems.push({ field: `cargo.${field}`, message: `cargo.${field} must name a \`${type}\` param of this part` })
    }
  }
}

function validateHolds(p: Partial<PartPackage> | null | undefined, problems: PackageProblem[]): void {
  const h = (p as { holds?: unknown } | null | undefined)?.holds as { part?: unknown; positions?: unknown; limitParam?: unknown; params?: unknown } | undefined
  if (h === undefined) return
  if (!h || typeof h !== 'object') {
    problems.push({ field: 'holds', message: 'holds must be an object: { part, positions, limitParam? }' })
    return
  }
  if (typeof h.part !== 'string' || !h.part) problems.push({ field: 'holds.part', message: "holds.part must name the cargo part's package id" })
  const geo = p?.geometry as { kind?: unknown; links?: { name?: unknown; grip?: { zone?: unknown }; array?: { posable?: unknown } }[] } | undefined
  const links = geo?.kind === 'rig' ? (geo.links ?? []) : []
  const gripping = new Set(links.filter((l) => l.grip?.zone).map((l) => l.name))
  const gripRows = new Set(links.filter((l) => l.grip?.zone && l.array?.posable === true).map((l) => l.name))
  // a plain gripper link, or `link#i`: a copy of a posable gripper array
  const names = (n: string): boolean => gripping.has(n) || (!!parseCopyGripName(n) && gripRows.has(parseCopyGripName(n)!.link))
  if (!Array.isArray(h.positions) || h.positions.length === 0) problems.push({ field: 'holds.positions', message: 'holds.positions must list one or more gripper links, bottom first' })
  else
    h.positions.forEach((n: unknown, i: number) => {
      if (typeof n !== 'string' || !names(n)) problems.push({ field: `holds.positions[${i}]`, message: `must name a rig link with a grip.zone, or a copy of a posable one as link#i (got ${JSON.stringify(n)})` })
    })
  if (h.limitParam !== undefined) {
    const spec = typeof h.limitParam === 'string' ? (p?.params as Record<string, { type?: unknown } | undefined> | undefined)?.[h.limitParam] : undefined
    if (spec?.type !== 'number') problems.push({ field: 'holds.limitParam', message: 'holds.limitParam must name a `number` param of this part' })
  }
  if (h.params !== undefined) {
    const own = (p?.params ?? {}) as Record<string, unknown>
    if (!h.params || typeof h.params !== 'object' || Array.isArray(h.params)) problems.push({ field: 'holds.params', message: "holds.params must map an item param to one of this part's params, e.g. { size: 'palletSize' }" })
    else
      for (const [k, v] of Object.entries(h.params as Record<string, unknown>)) {
        if (typeof v !== 'string' || !Object.hasOwn(own, v)) problems.push({ field: `holds.params.${k}`, message: `must name a param of this part (got ${JSON.stringify(v)})` })
      }
  }
}

/** A unit-load declaration names its own params and materials; each must exist and be of the kind it is used as. */
function validateUnit(p: Partial<PartPackage> | null | undefined, problems: PackageProblem[]): void {
  const u = (p as { unit?: unknown } | null | undefined)?.unit as { joinWhen?: unknown; dress?: unknown; pieces?: unknown } | undefined
  if (u === undefined) return
  if (!u || typeof u !== 'object') {
    problems.push({ field: 'unit', message: 'unit must be an object' })
    return
  }
  const params = (p?.params ?? {}) as Record<string, { type?: unknown } | undefined>
  const need = (field: string, name: unknown, type: string): void => {
    if (name === undefined) return
    if (typeof name !== 'string' || params[name]?.type !== type) problems.push({ field, message: `must name a ${type} param (got ${JSON.stringify(name)})` })
  }
  need('unit.joinWhen', u.joinWhen, 'boolean')
  if (u.pieces !== undefined) {
    const pc = u.pieces as { pallet?: unknown; case?: unknown } | null
    if (!pc || typeof pc !== 'object' || typeof pc.pallet !== 'string' || pc.pallet === '' || typeof pc.case !== 'string' || pc.case === '') {
      problems.push({ field: 'unit.pieces', message: 'pieces names a pallet and a case part by package id' })
    }
  }
  if (u.dress === undefined) return
  if (!Array.isArray(u.dress)) {
    problems.push({ field: 'unit.dress', message: 'dress must be an array' })
    return
  }
  const mats = new Set((p?.materials ?? []).map((m) => m.id))
  u.dress.forEach((d: unknown, i: number) => {
    const at = `unit.dress[${i}]`
    const x = d as { id?: unknown; material?: unknown; when?: unknown; colorParam?: unknown; opacityParam?: unknown } | null
    if (!x || typeof x.id !== 'string' || !x.id) problems.push({ field: `${at}.id`, message: 'a dressing needs an id' })
    if (!x || typeof x.material !== 'string' || !mats.has(x.material)) problems.push({ field: `${at}.material`, message: "a dressing names one of this package's materials" })
    if (!x) return
    need(`${at}.when`, x.when, 'boolean')
    need(`${at}.colorParam`, x.colorParam, 'color')
    need(`${at}.opacityParam`, x.opacityParam, 'number')
  })
}

/** A param flagged `attribute` is a product fact (a mark), so it must be one of the kinds a mark can hold. */
function validateAttributes(params: unknown, problems: PackageProblem[]): void {
  if (!params || typeof params !== 'object') return
  for (const [key, spec] of Object.entries(params as Record<string, { type?: unknown; attribute?: unknown } | undefined>)) {
    if (!spec || spec.attribute === undefined) continue
    if (typeof spec.attribute !== 'boolean') problems.push({ field: `params.${key}.attribute`, message: 'attribute must be a boolean' })
    else if (spec.attribute && spec.type !== 'boolean' && spec.type !== 'number' && spec.type !== 'string') {
      problems.push({ field: `params.${key}.attribute`, message: 'only a boolean, number or string param can be a product attribute' })
    }
  }
}

/**
 * A `'tag'` param's `setpointFor` must name a declared `'number'` param - the value it replaces while bound.
 * The host trusts that link blindly (it swaps the live commanded value into that field), so a typo has to be
 * a build error rather than a silently dead readout. Same-units is a contract the validator can't check.
 */
function validateSetpoints(params: unknown, problems: PackageProblem[]): void {
  if (!params || typeof params !== 'object') return
  const schema = params as Record<string, { type?: unknown; setpointFor?: unknown } | undefined>
  for (const key of Object.keys(schema)) {
    const spec = schema[key]
    if (!spec || spec.setpointFor === undefined) continue
    if (spec.type !== 'tag') {
      problems.push({ field: `params.${key}.setpointFor`, message: 'setpointFor is only valid on a tag param' })
    } else if (typeof spec.setpointFor !== 'string' || schema[spec.setpointFor]?.type !== 'number') {
      problems.push({
        field: `params.${key}.setpointFor`,
        message: `must name a number param (got ${JSON.stringify(spec.setpointFor)})`,
      })
    }
  }
}

/**
 * A `'tag'` param's declared signal: `dir` (which way it flows, from the part's perspective) and `stType`
 * (what it carries). The pair is the part's machine-readable PLC interface, so a half-declared or misspelled
 * one has to fail rather than silently drop out of the catalog: a direction with no type can't be typed into ST,
 * and a type with no direction can't be wired. Neither is accepted here, though an authored part must declare
 * both (core/parts/partAuthoringChecks.ts): this validator also judges stored packages, and one saved before that rule
 * is not worth dropping a placed part over. The wiring check reports it as `undeclared` instead (plc/wiring.ts).
 */
function validateTagSignals(params: unknown, problems: PackageProblem[]): void {
  if (!params || typeof params !== 'object') return
  const schema = params as Record<string, { type?: unknown; dir?: unknown; stType?: unknown } | undefined>
  for (const key of Object.keys(schema)) {
    const spec = schema[key]
    if (!spec || (spec.dir === undefined && spec.stType === undefined)) continue
    if (spec.type !== 'tag') {
      problems.push({ field: `params.${key}`, message: 'dir/stType are only valid on a tag param' })
      continue
    }
    if (spec.dir !== 'in' && spec.dir !== 'out') {
      problems.push({ field: `params.${key}.dir`, message: `must be 'in' or 'out' (got ${JSON.stringify(spec.dir)})` })
    }
    if (spec.stType !== 'BOOL' && spec.stType !== 'INT' && spec.stType !== 'DINT' && spec.stType !== 'REAL') {
      problems.push({ field: `params.${key}.stType`, message: `must be 'BOOL', 'INT', 'DINT' or 'REAL' (got ${JSON.stringify(spec.stType)})` })
    }
  }
}

/** Validate the optional declarative snap features ({@link SnapSpec}) - lenient: only present fields are checked. */
function validateSnap(snap: unknown, problems: PackageProblem[]): void {
  if (snap === undefined) return
  if (typeof snap !== 'object' || snap === null) {
    problems.push({ field: 'snap', message: 'snap must be an object' })
    return
  }
  const track = (snap as { track?: unknown }).track
  if (track !== undefined) {
    if (typeof track !== 'object' || track === null) {
      problems.push({ field: 'snap.track', message: 'snap.track must be an object' })
    } else {
      const fit = (track as { fitWidthParam?: unknown }).fitWidthParam
      if (fit !== undefined && (typeof fit !== 'string' || !fit)) {
        problems.push({ field: 'snap.track.fitWidthParam', message: 'track.fitWidthParam must be a non-empty param name' })
      }
      const fitScale = (track as { fitWidthScale?: unknown }).fitWidthScale
      if (fitScale !== undefined && (typeof fitScale !== 'number' || !Number.isFinite(fitScale) || fitScale <= 0)) {
        problems.push({ field: 'snap.track.fitWidthScale', message: 'track.fitWidthScale must be a positive finite number' })
      }
      const tly = (track as { targetLocalY?: unknown }).targetLocalY
      if (tly !== undefined && (typeof tly !== 'number' || !Number.isFinite(tly))) {
        problems.push({ field: 'snap.track.targetLocalY', message: 'track.targetLocalY must be a finite number' })
      }
      const lanes = (track as { lanes?: unknown }).lanes
      if (lanes !== undefined) {
        if (typeof lanes !== 'object' || lanes === null) {
          problems.push({ field: 'snap.track.lanes', message: 'track.lanes must be an object' })
        } else {
          const count = (lanes as { countParam?: unknown }).countParam
          if (typeof count !== 'string' || !count) {
            problems.push({ field: 'snap.track.lanes.countParam', message: 'track.lanes.countParam must be a non-empty param name' })
          }
          const pitch = (lanes as { pitchParam?: unknown }).pitchParam
          if (pitch !== undefined && (typeof pitch !== 'string' || !pitch)) {
            problems.push({ field: 'snap.track.lanes.pitchParam', message: 'track.lanes.pitchParam must be a non-empty param name' })
          }
        }
      }
    }
  }
  const surfaces = (snap as { surfaces?: unknown }).surfaces
  if (surfaces !== undefined) {
    if (!Array.isArray(surfaces)) {
      problems.push({ field: 'snap.surfaces', message: 'snap.surfaces must be an array' })
    } else {
      surfaces.forEach((s, i) => {
        for (const key of ['kind', 'lengthParam', 'widthParam'] as const) {
          const v = (s as Record<string, unknown>)?.[key]
          if (typeof v !== 'string' || !v) {
            problems.push({ field: `snap.surfaces[${i}].${key}`, message: `surface.${key} must be a non-empty string` })
          }
        }
        const hp = (s as { heightParam?: unknown })?.heightParam
        if (hp !== undefined && (typeof hp !== 'string' || !hp)) {
          problems.push({ field: `snap.surfaces[${i}].heightParam`, message: 'surface.heightParam must be a non-empty param name' })
        }
      })
    }
  }
  if ((snap as { edges?: unknown }).edges !== undefined) problems.push({ field: 'snap.edges', message: 'snap.edges was renamed snap.tile (package format 4)' })
  const tile = (snap as { tile?: unknown }).tile
  if (tile !== undefined) {
    if (typeof tile !== 'object' || tile === null) {
      problems.push({ field: 'snap.tile', message: 'snap.tile must be an object' })
    } else {
      for (const key of ['group', 'lengthParam', 'widthParam'] as const) {
        const v = (tile as Record<string, unknown>)[key]
        if (typeof v !== 'string' || !v) {
          problems.push({ field: `snap.tile.${key}`, message: `tile.${key} must be a non-empty string` })
        }
      }
      const cf = (tile as { cornerFlush?: unknown }).cornerFlush
      if (cf !== undefined && typeof cf !== 'boolean') {
        problems.push({ field: 'snap.tile.cornerFlush', message: 'tile.cornerFlush must be a boolean' })
      }
    }
  }
  const chain = (snap as { chain?: unknown }).chain
  if (chain !== undefined) {
    if (typeof chain !== 'object' || chain === null) {
      problems.push({ field: 'snap.chain', message: 'snap.chain must be an object' })
    } else {
      for (const key of ['group', 'lengthParam'] as const) {
        const v = (chain as Record<string, unknown>)[key]
        if (typeof v !== 'string' || !v) {
          problems.push({ field: `snap.chain.${key}`, message: `chain.${key} must be a non-empty string` })
        }
      }
      const reach = (chain as { reach?: unknown }).reach
      if (typeof reach !== 'number' || !Number.isFinite(reach) || reach <= 0) {
        problems.push({ field: 'snap.chain.reach', message: 'chain.reach must be a positive finite number' })
      }
      for (const key of ['omitStartParam', 'omitEndParam'] as const) {
        const v = (chain as Record<string, unknown>)[key]
        if (v !== undefined && (typeof v !== 'string' || !v)) {
          problems.push({ field: `snap.chain.${key}`, message: `chain.${key} must be a non-empty param name` })
        }
      }
    }
  }
  const edgeMount = (snap as { edgeMount?: unknown }).edgeMount
  if (edgeMount !== undefined) {
    if (typeof edgeMount !== 'object' || edgeMount === null) {
      problems.push({ field: 'snap.edgeMount', message: 'snap.edgeMount must be an object' })
    } else {
      for (const key of ['accepts', 'alongParam'] as const) {
        const v = (edgeMount as Record<string, unknown>)[key]
        if (typeof v !== 'string' || !v) {
          problems.push({ field: `snap.edgeMount.${key}`, message: `edgeMount.${key} must be a non-empty string` })
        }
      }
      const reach = (edgeMount as { reach?: unknown }).reach
      if (typeof reach !== 'number' || !Number.isFinite(reach) || reach <= 0) {
        problems.push({ field: 'snap.edgeMount.reach', message: 'edgeMount.reach must be a positive finite number' })
      }
      const oo = (edgeMount as { outwardOffset?: unknown }).outwardOffset
      if (oo !== undefined && (typeof oo !== 'number' || !Number.isFinite(oo))) {
        problems.push({ field: 'snap.edgeMount.outwardOffset', message: 'edgeMount.outwardOffset must be a finite number' })
      }
      validateEdgeMountReach(edgeMount as Record<string, unknown>, problems)
    }
  }
  if ((snap as { stairMount?: unknown }).stairMount !== undefined) {
    problems.push({
      field: 'snap.stairMount',
      message: "snap.stairMount was replaced (package format 3) by edgeMount { facing: 'into', at, atParams, fromFloor, opens, notch, lift }: see docs/part-snap-cuts.md",
    })
  }
  for (const key of RETIRED_SNAP_KINDS) {
    if ((snap as Record<string, unknown>)[key] !== undefined) {
      problems.push({ field: `snap.${key}`, message: `snap.${key} was retired before any part used it: remove it. ${RETIRED_SNAP_ADVICE}` })
    }
  }
  const mounts = (snap as { mounts?: unknown }).mounts
  if (mounts === undefined) return
  if (!Array.isArray(mounts)) {
    problems.push({ field: 'snap.mounts', message: 'snap.mounts must be an array' })
    return
  }
  mounts.forEach((m, i) => {
    const at = (m as { at?: unknown })?.at
    if (!Array.isArray(at) || at.length !== 3 || !at.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      problems.push({ field: `snap.mounts[${i}].at`, message: 'mount.at must be 3 finite numbers' })
    }
    if (typeof (m as { accepts?: unknown })?.accepts !== 'string' || !(m as { accepts: string }).accepts) {
      problems.push({ field: `snap.mounts[${i}].accepts`, message: 'mount.accepts must be a non-empty surface-kind string' })
    }
    // The rest of the mount surface. Each field degrades silently rather than failing: seatOnRail reads `face`
    // as `m.face !== 'out'`, so a misspelled 'outward' means inward (a diverter pushing the wrong way), and a
    // string offset propagates NaN into the pose.
    const face = (m as { face?: unknown }).face
    if (face !== undefined && face !== 'in' && face !== 'out') {
      problems.push({ field: `snap.mounts[${i}].face`, message: `mount.face must be 'in' or 'out' (got ${JSON.stringify(face)})` })
    }
    for (const key of ['outwardOffset', 'yOffset'] as const) {
      const v = (m as Record<string, unknown>)[key]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
        problems.push({ field: `snap.mounts[${i}].${key}`, message: `mount.${key} must be a finite number` })
      }
    }
    const frp = (m as { fitRangeParam?: unknown }).fitRangeParam
    if (frp !== undefined && (typeof frp !== 'string' || !frp)) {
      problems.push({ field: `snap.mounts[${i}].fitRangeParam`, message: 'mount.fitRangeParam must be a non-empty param name' })
    }
    const attach = (m as { attach?: unknown }).attach
    if (attach !== undefined && typeof attach !== 'boolean') {
      problems.push({ field: `snap.mounts[${i}].attach`, message: 'mount.attach must be a boolean' })
    }
    const opens = (m as { opens?: unknown }).opens
    if (opens !== undefined && typeof opens !== 'boolean') {
      problems.push({ field: `snap.mounts[${i}].opens`, message: 'mount.opens must be a boolean' })
    }
  })
}

/** The options an edge mount adds for meeting a deck from the floor and cutting it (SnapEdgeMount). Structure only:
 *  that `fromFloor.param` drives an axis-1 `atParams` entry is checked here too, because the fit is solved from
 *  that entry and silently snaps nowhere without it. Param names are checked with the others (SNAP_PARAM_REFS). */
function validateEdgeMountReach(em: Record<string, unknown>, problems: PackageProblem[]): void {
  const add = (field: string, message: string): void => {
    problems.push({ field: `snap.edgeMount.${field}`, message })
  }
  const into = em.facing === 'into'
  if (em.facing !== undefined && em.facing !== 'along' && !into) add('facing', "edgeMount.facing must be 'along' or 'into'")
  if (em.at !== undefined && !isVec3(em.at)) add('at', 'edgeMount.at must be 3 finite numbers')
  const atParams = em.atParams
  if (atParams !== undefined) {
    if (!Array.isArray(atParams)) add('atParams', 'edgeMount.atParams must be an array')
    else {
      atParams.forEach((r: unknown, i: number) => {
        const ref = r as { axis?: unknown; param?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown } | null
        if (!ref || ![0, 1, 2].includes(ref.axis as number)) add(`atParams[${i}].axis`, 'atParams axis must be 0, 1 or 2')
        if (!ref || typeof ref.param !== 'string' || !ref.param) add(`atParams[${i}].param`, 'atParams param must be a non-empty param name')
        for (const k of ['scale', 'add', 'min', 'max'] as const) if (ref?.[k] !== undefined && !isFiniteNum(ref[k])) add(`atParams[${i}].${k}`, `atParams ${k} must be a finite number`)
      })
    }
  }
  const fromFloor = em.fromFloor as { param?: unknown } | undefined
  if (fromFloor !== undefined) {
    if (!into) add('fromFloor', "edgeMount.fromFloor needs facing: 'into' (a part standing on the floor climbs INTO the deck)")
    if (!fromFloor || typeof fromFloor.param !== 'string' || !fromFloor.param) add('fromFloor.param', 'edgeMount.fromFloor.param must be a non-empty param name')
    else {
      const rise = Array.isArray(atParams) && atParams.find((r: { axis?: unknown; param?: unknown; scale?: unknown }) => r?.axis === 1 && r.param === fromFloor.param)
      if (!rise || !isFiniteNum((rise as { scale?: unknown }).scale) || !((rise as { scale: number }).scale > 0)) {
        add('fromFloor.param', `edgeMount.fromFloor.param "${fromFloor.param}" must drive an axis-1 atParams entry with a positive scale (the rise per unit it is fitted by)`)
      }
    }
  }
  for (const k of ['opens', 'notch', 'lift'] as const) if (em[k] !== undefined && typeof em[k] !== 'boolean') add(k, `edgeMount.${k} must be a boolean`)
  if ((em.notch === true || em.lift === true) && !into) add(em.notch === true ? 'notch' : 'lift', "edgeMount notch and lift need facing: 'into' (they act on a part climbing from the floor)")
}

/** safe descent into an unknown blob - the file's house style, so the ref table below needs no `any` */
const sub = (v: unknown, key: string): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** every snap field that names a param, with the param type it must name - the table validateSnapParamRefs walks */
const SNAP_PARAM_REFS: { field: string; type: 'number' | 'boolean'; names: (snap: unknown) => unknown[] }[] = [
  { field: 'snap.track.fitWidthParam', type: 'number', names: (s) => [sub(sub(s, 'track'), 'fitWidthParam')] },
  { field: 'snap.track.lanes.countParam', type: 'number', names: (s) => [sub(sub(sub(s, 'track'), 'lanes'), 'countParam')] },
  { field: 'snap.track.lanes.pitchParam', type: 'number', names: (s) => [sub(sub(sub(s, 'track'), 'lanes'), 'pitchParam')] },
  { field: 'snap.surfaces[].lengthParam', type: 'number', names: (s) => list(sub(s, 'surfaces')).map((x) => sub(x, 'lengthParam')) },
  { field: 'snap.surfaces[].widthParam', type: 'number', names: (s) => list(sub(s, 'surfaces')).map((x) => sub(x, 'widthParam')) },
  { field: 'snap.surfaces[].heightParam', type: 'number', names: (s) => list(sub(s, 'surfaces')).map((x) => sub(x, 'heightParam')) },
  { field: 'snap.tile.lengthParam', type: 'number', names: (s) => [sub(sub(s, 'tile'), 'lengthParam')] },
  { field: 'snap.tile.widthParam', type: 'number', names: (s) => [sub(sub(s, 'tile'), 'widthParam')] },
  { field: 'snap.chain.lengthParam', type: 'number', names: (s) => [sub(sub(s, 'chain'), 'lengthParam')] },
  { field: 'snap.chain.omitStartParam', type: 'boolean', names: (s) => [sub(sub(s, 'chain'), 'omitStartParam')] },
  { field: 'snap.chain.omitEndParam', type: 'boolean', names: (s) => [sub(sub(s, 'chain'), 'omitEndParam')] },
  { field: 'snap.edgeMount.alongParam', type: 'number', names: (s) => [sub(sub(s, 'edgeMount'), 'alongParam')] },
  { field: 'snap.edgeMount.atParams[].param', type: 'number', names: (s) => list(sub(sub(s, 'edgeMount'), 'atParams')).map((r) => sub(r, 'param')) },
  { field: 'snap.edgeMount.fromFloor.param', type: 'number', names: (s) => [sub(sub(sub(s, 'edgeMount'), 'fromFloor'), 'param')] },
  { field: 'snap.mounts[].fitRangeParam', type: 'number', names: (s) => list(sub(s, 'mounts')).map((m) => sub(m, 'fitRangeParam')) },
]

/**
 * A snap declaration that names a param must name one that exists, with the right type.
 *
 * The failure this catches is silent by construction: the engine resolves every one of these through
 * `numParamOf` / `getPackage().params`, which yields null for a name that isn't there, and a null makes the
 * snap return null. So a misspelled `lengthParam` is a part that never snaps, with nothing logged and
 * nothing to see in the Inspector - the same shape as the missing-declaration bug, one layer down.
 *
 * Not folded into {@link validatePartPackage}. A package problem drops the package on load
 * (scene.ts and project.ts record an error and skip it), so making a typo fatal would turn "this part doesn't
 * snap" into "this part and every instance of it are gone from the scene" - strictly worse than the bug, and
 * it would hit projects saved before the check existed. This runs on the authoring path instead
 * (sim/validatePart), where the author is looking at the part and can fix it.
 */
export function validateSnapParamRefs(pkg: unknown): PackageProblem[] {
  const problems: PackageProblem[] = []
  const p = pkg as { snap?: unknown; params?: unknown } | undefined
  const snap = p?.snap
  if (!snap || typeof snap !== 'object') return problems
  const schema = (p?.params && typeof p.params === 'object' ? p.params : {}) as Record<string, { type?: unknown } | undefined>
  for (const ref of SNAP_PARAM_REFS) {
    for (const name of ref.names(snap)) {
      if (name === undefined || name === null) continue
      if (typeof name !== 'string' || !name) continue // shape is validateSnap's job; only resolve real names here
      const spec = schema[name]
      if (!spec) {
        problems.push({ field: ref.field, message: `names "${name}", which is not a declared param (the snap will silently never engage)` })
      } else if (spec.type !== ref.type) {
        problems.push({ field: ref.field, message: `names "${name}", a '${String(spec.type)}' param, but must name a '${ref.type}' one` })
      }
    }
  }
  return problems
}

/** Validate a `function` geometry (docs/procedural-geometry.md, Tier 2): the mesh comes from the behavior's
 *  `geometry()` callback at realize time, so there is no static sweep/links to check - only the baked
 *  `bounds` (the footprint shown without running code), the optional `conveys` flag, and a `material` ref.
 *  The geometry source's own correctness (determinism, vertex budget) is enforced where it runs
 *  (core/geometry/geometryEval + embeddedBehavior), not here - structural validation can't execute the script. */
function validateDrawnGeometry(g: { bounds?: unknown; material?: unknown; conveys?: unknown }, problems: PackageProblem[], materialIds: Set<string>): void {
  validateBounds(g.bounds, problems)
  if (g.conveys !== undefined && typeof g.conveys !== 'boolean') problems.push({ field: 'geometry.conveys', message: 'function conveys must be a boolean' })
  if (g.material !== undefined && (typeof g.material !== 'string' || !materialIds.has(g.material))) problems.push({ field: 'geometry.material', message: 'function material must reference a declared material id' })
}

/** Validate a `cargo` geometry (C-cargo): a box/pallet/tote cargo kind + the positive baked bounds the
 *  footprint/placement read without running code (a box's live size still tracks its instance params). */
function validateCargoGeometry(g: { cargoKind?: unknown; bounds?: unknown; size?: unknown }, problems: PackageProblem[]): void {
  if (g.cargoKind !== 'box' && g.cargoKind !== 'pallet' && g.cargoKind !== 'tote') problems.push({ field: 'geometry.cargoKind', message: 'cargo cargoKind must be "box", "pallet" or "tote"' })
  if (g.bounds !== undefined) problems.push({ field: 'geometry.bounds', message: "a cargo box's `bounds` is now its `size` { length, width, height } (package format 4)" })
  const b = g.size as { length?: unknown; width?: unknown; height?: unknown } | undefined
  const dim = (v: unknown): boolean => typeof v === 'number' && v > 0
  if (!b || !dim(b.length) || !dim(b.width) || !dim(b.height)) problems.push({ field: 'geometry.size', message: 'cargo geometry needs a positive numeric size {length, width, height}' })
}

/** A rig's or drawn part's footprint box ({@link PartBounds}). */
function validateBounds(bounds: unknown, problems: PackageProblem[]): void {
  const b = bounds as { length?: unknown; width?: unknown; top?: unknown; bottom?: unknown; height?: unknown; floorY?: unknown } | undefined
  if (!b || typeof b !== 'object') {
    problems.push({ field: 'geometry.bounds', message: 'geometry needs bounds { length, width, top, bottom? }' })
    return
  }
  if (b.height !== undefined) problems.push({ field: 'geometry.bounds.height', message: 'bounds.height is now bounds.top: the highest point, y in the part\'s frame (package format 4)' })
  if (b.floorY !== undefined) problems.push({ field: 'geometry.bounds.floorY', message: 'bounds.floorY is now bounds.bottom: the lowest point, y in the part\'s frame (package format 4)' })
  if (!isFiniteNum(b.length) || !isFiniteNum(b.width) || !isFiniteNum(b.top)) problems.push({ field: 'geometry.bounds', message: 'bounds needs numeric length, width and top' })
  if (b.bottom !== undefined && (!isFiniteNum(b.bottom) || (isFiniteNum(b.top) && b.bottom > b.top))) problems.push({ field: 'geometry.bounds.bottom', message: 'bounds.bottom must be a number no higher than top' })
  const c = bounds as { centerX?: unknown; centerZ?: unknown; params?: unknown }
  if (c.centerX !== undefined && !isFiniteNum(c.centerX)) problems.push({ field: 'geometry.bounds.centerX', message: 'bounds.centerX must be a number' })
  if (c.centerZ !== undefined && !isFiniteNum(c.centerZ)) problems.push({ field: 'geometry.bounds.centerZ', message: 'bounds.centerZ must be a number' })
  if (c.params === undefined) return
  if (!Array.isArray(c.params)) {
    problems.push({ field: 'geometry.bounds.params', message: 'bounds.params must be an array' })
    return
  }
  const FIELDS = ['length', 'width', 'top', 'bottom', 'centerX', 'centerZ']
  c.params.forEach((raw, i) => {
    const r = raw as { field?: unknown } | null
    const where = `geometry.bounds.params[${i}]`
    if (typeof r?.field !== 'string' || !FIELDS.includes(r.field)) problems.push({ field: `${where}.field`, message: `field must be one of ${FIELDS.join(', ')}` })
  })
  // the rest of each entry is a link sizeParams entry without its axis
  validateSizeParams(
    c.params.map((r) => ({ ...(r as object), axis: 0 })),
    'geometry.bounds.params',
    (field, message) => problems.push({ field, message }),
  )
}

/** Validate the PBR materials; returns the set of valid material ids for mesh-shape refs. */
function validateMaterials(materials: unknown, problems: PackageProblem[], assetIds: Set<string>): Set<string> {
  const ids = new Set<string>()
  if (materials === undefined) return ids
  if (!Array.isArray(materials)) {
    problems.push({ field: 'materials', message: 'materials must be an array' })
    return ids
  }
  materials.forEach((raw, i) => {
    const m = raw as { id?: unknown; albedo?: unknown; orm?: unknown; normal?: unknown; color?: unknown; metalness?: unknown; roughness?: unknown; triplanar?: unknown; pattern?: unknown }
    const at = `materials[${i}]`
    if (typeof m?.id !== 'string' || m.id === '') problems.push({ field: `${at}.id`, message: 'material id must be a non-empty string' })
    else if (ids.has(m.id)) problems.push({ field: `${at}.id`, message: `duplicate material id "${m.id}"` })
    else ids.add(m.id)
    for (const tex of ['albedo', 'orm', 'normal'] as const) {
      const ref = m?.[tex]
      if (ref !== undefined && (typeof ref !== 'string' || !assetIds.has(ref))) {
        problems.push({ field: `${at}.${tex}`, message: `material.${tex} must reference an embedded package asset id` })
      }
    }
    if (m?.color !== undefined && !isVec3(m.color)) problems.push({ field: `${at}.color`, message: 'color must be 3 finite numbers' })
    if (m?.metalness !== undefined && !isFiniteNum(m.metalness)) problems.push({ field: `${at}.metalness`, message: 'metalness must be a finite number' })
    if (m?.roughness !== undefined && !isFiniteNum(m.roughness)) problems.push({ field: `${at}.roughness`, message: 'roughness must be a finite number' })
    if (m?.triplanar !== undefined) {
      const t = m.triplanar as { space?: unknown; scale?: unknown; boost?: unknown }
      if (typeof t !== 'object' || t === null || Array.isArray(t)) {
        problems.push({ field: `${at}.triplanar`, message: 'triplanar must be an object' })
      } else {
        if (t.space !== 'object' && t.space !== 'world') problems.push({ field: `${at}.triplanar.space`, message: "triplanar.space must be 'object' or 'world'" })
        if (!isFiniteNum(t.scale) || t.scale <= 0) problems.push({ field: `${at}.triplanar.scale`, message: 'triplanar.scale must be a positive number (tiles per metre)' })
        if (t.boost !== undefined && !isFiniteNum(t.boost)) problems.push({ field: `${at}.triplanar.boost`, message: 'triplanar.boost must be a finite number' })
        if (m.albedo === undefined && m.pattern === undefined) problems.push({ field: `${at}.triplanar`, message: 'triplanar needs an albedo texture or a pattern to sample' })
      }
    }
    if (m?.pattern !== undefined) validatePattern(m.pattern, `${at}.pattern`, m.albedo !== undefined, problems)
  })
  return ids
}

const PATTERN_ANGLES = [0, 45, 90, 135]

function validatePattern(raw: unknown, at: string, hasAlbedo: boolean, problems: PackageProblem[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push({ field: at, message: 'pattern must be an object' })
    return
  }
  const p = raw as { kind?: unknown; colors?: unknown; ratio?: unknown; angle?: unknown }
  if (hasAlbedo) problems.push({ field: at, message: 'a material takes an albedo texture or a pattern, not both' })
  if (p.kind !== 'stripes' && p.kind !== 'checker') problems.push({ field: `${at}.kind`, message: "pattern.kind must be 'stripes' or 'checker'" })
  if (!Array.isArray(p.colors) || p.colors.length !== 2 || !p.colors.every(isVec3)) {
    problems.push({ field: `${at}.colors`, message: 'pattern.colors must be two [r, g, b] colours' })
  }
  if (p.ratio !== undefined && !(isFiniteNum(p.ratio) && p.ratio > 0 && p.ratio < 1)) {
    problems.push({ field: `${at}.ratio`, message: 'pattern.ratio must be a number between 0 and 1' })
  }
  if (p.angle !== undefined && !PATTERN_ANGLES.includes(p.angle as number)) {
    problems.push({ field: `${at}.angle`, message: 'pattern.angle must be 0, 45, 90 or 135' })
  }
}

/** Validate the embedded asset blobs; returns the set of valid asset ids for mesh-shape refs. */
function validateAssets(assets: unknown, problems: PackageProblem[]): Set<string> {
  const ids = new Set<string>()
  if (assets === undefined) return ids
  if (!Array.isArray(assets)) {
    problems.push({ field: 'assets', message: 'assets must be an array' })
    return ids
  }
  assets.forEach((raw, i) => {
    const a = raw as { id?: unknown; mime?: unknown; data?: unknown; url?: unknown }
    const at = `assets[${i}]`
    if (typeof a?.id !== 'string' || a.id === '') problems.push({ field: `${at}.id`, message: 'asset id must be a non-empty string' })
    else if (ids.has(a.id)) problems.push({ field: `${at}.id`, message: `duplicate asset id "${a.id}"` })
    else ids.add(a.id)
    if (typeof a?.mime !== 'string' || a.mime === '') problems.push({ field: `${at}.mime`, message: 'asset mime must be a non-empty string' })
    // exactly one of data / url
    const hasData = typeof a?.data === 'string' && a.data !== ''
    const hasUrl = typeof a?.url === 'string' && a.url !== ''
    if (hasData === hasUrl) problems.push({ field: `${at}.data`, message: 'asset needs exactly one of data (base64) or url' })
    const sha = (raw as { sha256?: unknown } | null)?.sha256
    if (sha !== undefined && (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha))) problems.push({ field: `${at}.sha256`, message: 'asset sha256 must be 64 lowercase hex characters' })
  })
  return ids
}

const CONVEYOR_BEDS: readonly string[] = ['straight', 'spur', 'path', 'arc', 'turntable']

/** A conveyor declaration's rules ({@link ConveyorDecl}): each bed has the declaration that gives its geometry. */
function validateConveyor(p: Record<string, unknown> | undefined, problems: PackageProblem[]): void {
  const comms = p?.commsParam
  if (comms !== undefined) {
    const spec = typeof comms === 'string' ? (p?.params as Record<string, { type?: unknown } | undefined> | undefined)?.[comms] : undefined
    if (spec?.type !== 'boolean') problems.push({ field: 'commsParam', message: 'commsParam must name a `boolean` param of this part (the switch that connects its tags to the PLC)' })
  }
  const c = p?.conveyor as { bed?: unknown; surface?: unknown } | undefined
  if (c === undefined) return
  if (typeof c !== 'object' || c === null) {
    problems.push({ field: 'conveyor', message: 'conveyor must be an object: { bed?, surface }' })
    return
  }
  if (c.surface !== 'belt' && c.surface !== 'roller') problems.push({ field: 'conveyor.surface', message: "conveyor.surface must be 'belt' or 'roller' (what cargo rides on, which sets its grip)" })
  const named = (field: string, key: unknown, type: string): void => {
    if (key === undefined) return
    const spec = typeof key === 'string' ? (p?.params as Record<string, { type?: unknown } | undefined> | undefined)?.[key] : undefined
    if (spec?.type !== type) problems.push({ field: `conveyor.${field}`, message: `conveyor.${field} must name a \`${type}\` param of this part` })
  }
  named('speedParam', (c as { speedParam?: unknown }).speedParam, 'number')
  named('reverseParam', (c as { reverseParam?: unknown }).reverseParam, 'boolean')
  named('frictionParam', (c as { frictionParam?: unknown }).frictionParam, 'number')
  if (c.bed === undefined) return
  if (!CONVEYOR_BEDS.includes(c.bed as string)) {
    problems.push({ field: 'conveyor.bed', message: `conveyor.bed must be one of ${CONVEYOR_BEDS.map((b) => `'${b}'`).join(', ')}` })
    return
  }
  const params = (p?.params ?? {}) as Record<string, { type?: unknown; handle?: Record<string, unknown> } | undefined>
  const handleOf = (test: (h: Record<string, unknown>) => boolean): [string, Record<string, unknown>] | undefined => {
    for (const [key, spec] of Object.entries(params)) if (spec?.handle && typeof spec.handle === 'object' && test(spec.handle)) return [key, spec.handle]
    return undefined
  }
  const need = (ok: boolean, message: string): void => {
    if (!ok) problems.push({ field: 'conveyor.bed', message })
  }
  const geo = (p?.geometry ?? {}) as { kind?: unknown; conveys?: unknown; links?: unknown; joints?: unknown }
  const links = Array.isArray(geo.links) ? (geo.links as { name?: unknown; conveys?: unknown; shape?: { kind?: unknown } }[]) : []
  const conveys = geo.kind === 'drawn' ? geo.conveys === true : geo.kind === 'rig' && links.some((l) => l?.conveys === true)
  switch (c.bed) {
    case 'straight':
    case 'spur': {
      const x = handleOf((h) => h.kind === 'face' && h.axis === 'x')
      need(conveys, `a '${c.bed}' bed conveys: give the geometry a conveying surface (a rig's \`conveys\` link, or \`conveys: true\` on drawn geometry)`)
      need(!!x && !!handleOf((h) => h.kind === 'face' && h.axis === 'z'), `a '${c.bed}' bed is sized by its length and width: put a \`face\` handle on the length param (axis 'x') and one on the width param (axis 'z')`)
      if (c.bed === 'spur') need(!!x && (x[1].angleFrontParam !== undefined || x[1].angleBackParam !== undefined), "a 'spur' bed's ends splay: the length param's face handle names angleFrontParam and/or angleBackParam")
      return
    }
    case 'path':
      need(!!handleOf((h) => h.kind === 'path'), "a 'path' bed is edited by a `path` handle on its segments param")
      return
    case 'arc':
      need(conveys, "an 'arc' bed conveys: give the geometry a conveying surface")
      need(!!handleOf((h) => h.kind === 'arc'), "an 'arc' bed is swept by an `arc` handle on its sweep param")
      return
    case 'turntable': {
      const joint = Array.isArray(geo.joints) ? (geo.joints as { type?: unknown; link?: unknown }[]).find((j) => j?.type === 'revolute') : undefined
      const deck = joint ? links.find((l) => l?.name === joint.link) : undefined
      need(geo.kind === 'rig' && deck?.shape?.kind === 'cylinder', "a 'turntable' bed turns: a rig with a revolute joint whose link is a cylinder (the deck; its rim is where neighbours butt)")
      return
    }
  }
}

/** Is `v` a {@link PartCredit}: short texts, and an https link if any. */
export function isPartCredit(v: unknown): v is PartCredit {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const c = v as Record<string, unknown>
  const text = (x: unknown, max: number): boolean => typeof x === 'string' && x.trim() !== '' && x.length <= max
  if (!text(c.library, 100)) return false
  if (c.by !== undefined && !text(c.by, 100)) return false
  if (c.url !== undefined && !(text(c.url, 300) && /^https:\/\/[^\s]+$/.test(c.url as string))) return false
  return Object.keys(c).every((k) => k === 'by' || k === 'library' || k === 'url')
}
