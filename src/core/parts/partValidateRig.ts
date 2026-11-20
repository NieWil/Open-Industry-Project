// Validation of a package's rig: links, their shapes, arrays and lamps, and the joints between them.

import type { Finish } from './partApi'
import { RETIRED_SHAPE_KINDS } from './partUpgrade'
import type { PackageProblem, Vec3Tuple, Vec4Tuple } from './partPackage'

export function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
export function isVec3(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNum)
}
function isVec4(v: unknown): v is Vec4Tuple {
  return Array.isArray(v) && v.length === 4 && v.every(isFiniteNum)
}

/** Validate a box's optional param-driven size overrides (C-paramgeo). */
export function validateSizeParams(sizeParams: unknown, at: string, add: (field: string, message: string) => void): void {
  if (sizeParams === undefined) return
  if (!Array.isArray(sizeParams)) {
    add(at, 'sizeParams must be an array')
    return
  }
  sizeParams.forEach((raw, i) => {
    const sp = raw as { axis?: unknown; param?: unknown; mulParam?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown; plus?: unknown }
    const where = `${at}[${i}]`
    if (sp?.axis !== 0 && sp?.axis !== 1 && sp?.axis !== 2) add(`${where}.axis`, 'axis must be 0, 1 or 2')
    if (typeof sp?.param !== 'string' || sp.param === '') add(`${where}.param`, 'param must be a non-empty string')
    if (sp?.mulParam !== undefined && (typeof sp.mulParam !== 'string' || sp.mulParam === '')) add(`${where}.mulParam`, 'mulParam must be a non-empty string')
    if (sp?.scale !== undefined && !isFiniteNum(sp.scale)) add(`${where}.scale`, 'scale must be a finite number')
    if (sp?.add !== undefined && !isFiniteNum(sp.add)) add(`${where}.add`, 'add must be a finite number')
    if (sp?.min !== undefined && !isFiniteNum(sp.min)) add(`${where}.min`, 'min must be a finite number')
    if (sp?.max !== undefined && !isFiniteNum(sp.max)) add(`${where}.max`, 'max must be a finite number')
    if (isFiniteNum(sp?.min) && isFiniteNum(sp?.max) && (sp.min as number) > (sp.max as number)) add(`${where}.min`, 'min must be <= max')
    if (sp?.plus !== undefined && typeof sp.plus !== 'boolean') add(`${where}.plus`, 'plus must be a boolean')
  })
}

/** Validate a mesh link's `tileUv` (see MeshUvTile): each entry must re-tile an axis the link actually stretches. */
function validateTileUv(tileUv: unknown, sizeParams: unknown, at: string, add: (field: string, message: string) => void): void {
  if (tileUv === undefined) return
  if (!Array.isArray(tileUv) || tileUv.length === 0) {
    add(at, 'tileUv must be a non-empty array of { axis, uv, materials }')
    return
  }
  const stretched = new Set(Array.isArray(sizeParams) ? sizeParams.map((sp) => (sp as { axis?: unknown })?.axis) : [])
  tileUv.forEach((raw, i) => {
    const t = raw as { axis?: unknown; uv?: unknown; materials?: unknown } | null
    const where = `${at}[${i}]`
    if (t?.axis !== 0 && t?.axis !== 1 && t?.axis !== 2) add(`${where}.axis`, 'axis must be 0, 1 or 2')
    // without a stretch on that axis the factor is always 1 and the entry silently does nothing
    else if (!stretched.has(t.axis)) add(`${where}.axis`, 'tileUv.axis must be an axis this mesh stretches (a sizeParams entry)')
    if (t?.uv !== 'u' && t?.uv !== 'v') add(`${where}.uv`, "uv must be 'u' or 'v'")
    if (!Array.isArray(t?.materials) || t.materials.length === 0 || t.materials.some((m) => typeof m !== 'string' || m === '')) {
      add(`${where}.materials`, 'materials must be a non-empty array of GLB material names')
    }
  })
}

/** Validate one axis of a grid array (see GridAxisSpec). */
function validateGridAxis(axis: unknown, at: string, add: (field: string, message: string) => void): void {
  const ax = axis as { sizeParam?: unknown; pitchParam?: unknown; marginParam?: unknown; size?: unknown; pitch?: unknown; margin?: unknown; maxSpacing?: unknown } | undefined
  if (typeof ax !== 'object' || ax === null) {
    add(at, 'grid axis must be an object { sizeParam, pitchParam | maxSpacing, marginParam? }')
    return
  }
  if (typeof ax.sizeParam !== 'string' || ax.sizeParam === '') add(`${at}.sizeParam`, 'sizeParam must be a non-empty param name')
  const hasPitch = typeof ax.pitchParam === 'string' && ax.pitchParam !== ''
  if (ax.maxSpacing !== undefined && (!isFiniteNum(ax.maxSpacing) || ax.maxSpacing <= 0)) add(`${at}.maxSpacing`, 'maxSpacing must be > 0')
  if (!hasPitch && ax.maxSpacing === undefined) add(`${at}.pitchParam`, 'pitchParam must be a non-empty param name (or set maxSpacing)')
  else if (ax.pitchParam !== undefined && !hasPitch) add(`${at}.pitchParam`, 'pitchParam must be a non-empty param name')
  if (ax.marginParam !== undefined && (typeof ax.marginParam !== 'string' || ax.marginParam === '')) add(`${at}.marginParam`, 'marginParam must be a non-empty param name')
  if (ax.size !== undefined && (!isFiniteNum(ax.size) || ax.size < 0)) add(`${at}.size`, 'size fallback must be a non-negative number')
  if (ax.pitch !== undefined && (!isFiniteNum(ax.pitch) || ax.pitch <= 0)) add(`${at}.pitch`, 'pitch fallback must be > 0')
  if (ax.margin !== undefined && (!isFiniteNum(ax.margin) || ax.margin < 0)) add(`${at}.margin`, 'margin fallback must be a non-negative number')
}

/** Validate a link's optional `array` spec (array-links): exactly one of `distribute`, `count`+`step`, or
 *  `grid`. (Switching a link off with a param is the link's `showParam`, arrayed or not.) */
function validateArray(array: unknown, at: string, add: (field: string, message: string) => void, link: Record<string, unknown> = {}): void {
  if (array === undefined) return
  const a = array as { distribute?: { axis?: unknown; spanParam?: unknown; spanAdd?: unknown; maxSpacing?: unknown; worldPhase?: unknown }; pitch?: { axis?: unknown; spanParam?: unknown; spanScale?: unknown; spanAdd?: unknown; spanTerms?: unknown; pitch?: unknown }; posable?: unknown; count?: unknown; step?: unknown; stepParams?: unknown; enabledParam?: unknown; omitFirstParam?: unknown; omitLastParam?: unknown; grid?: { x?: unknown; z?: unknown; enabledParam?: unknown } }
  if (a.enabledParam !== undefined) add(`${at}.enabledParam`, 'array.enabledParam was retired (package format 4): give the link `showParam` instead (it switches the whole link, arrayed or not)')
  for (const key of ['omitFirstParam', 'omitLastParam'] as const) {
    const v = (a as Record<string, unknown>)[key]
    if (v !== undefined && (typeof v !== 'string' || v === '')) add(`${at}.${key}`, `${key} must be a non-empty boolean-param name`)
  }
  const hasDistribute = a.distribute !== undefined
  const hasCount = a.count !== undefined
  const hasGrid = a.grid !== undefined
  const hasPitch = a.pitch !== undefined
  const forms = (hasDistribute ? 1 : 0) + (hasCount ? 1 : 0) + (hasGrid ? 1 : 0) + (hasPitch ? 1 : 0)
  if (forms === 0 && a.enabledParam !== undefined) return // reported above: the whole array was only a gate
  if (forms !== 1) {
    add(at, 'array needs exactly one of `distribute`, `pitch`, `count`+`step`, or `grid` (a link that only switches on and off needs no array: use `showParam`)')
    return
  }
  if (a.posable !== undefined && typeof a.posable !== 'boolean') add(`${at}.posable`, 'posable must be a boolean')
  else if (a.posable === true) {
    const kind = (link.shape as { kind?: unknown } | undefined)?.kind
    if (kind !== 'box' && kind !== 'cylinder' && kind !== 'cone' && kind !== 'frame') add(`${at}.posable`, 'a posable array is a box, cylinder, cone or frame link (for a model, attach its look from geometry() to a frame)')
    if (a.distribute?.worldPhase === true) add(`${at}.posable`, 'a posable array cannot use worldPhase: its count would depend on where the part stands')
    // a posable array may convey or grip (each copy a deck or a gripper of its own); a perimeter, a scale or a guard may not
    for (const key of ['onEdge', 'loadCell', 'sideGuard', 'sideRail', 'notchable'] as const) {
      if (link[key] !== undefined && link[key] !== false) add(`${at}.posable`, `a posable array cannot also be \`${key}\``)
    }
  }
  if (hasPitch) {
    const p = a.pitch!
    if (a.stepParams !== undefined) add(`${at}.stepParams`, 'stepParams applies to the `count`+`step` form only')
    if (p.axis !== 0 && p.axis !== 1 && p.axis !== 2) add(`${at}.pitch.axis`, 'axis must be 0, 1 or 2')
    if (typeof p.spanParam !== 'string' || p.spanParam === '') add(`${at}.pitch.spanParam`, 'spanParam must be a non-empty string')
    if (p.spanScale !== undefined && !isFiniteNum(p.spanScale)) add(`${at}.pitch.spanScale`, 'spanScale must be a number (the span param is multiplied by it)')
    if (p.spanAdd !== undefined && !isFiniteNum(p.spanAdd)) add(`${at}.pitch.spanAdd`, 'spanAdd must be a number (metres added to the span)')
    if (p.spanTerms !== undefined) {
      const terms = p.spanTerms
      if (!Array.isArray(terms)) add(`${at}.pitch.spanTerms`, 'spanTerms must be a list of { param, scale? }')
      else terms.forEach((t: { param?: unknown; scale?: unknown }, i) => {
        if (typeof t?.param !== 'string' || t.param === '') add(`${at}.pitch.spanTerms[${i}].param`, 'param must be a non-empty string')
        if (t?.scale !== undefined && !isFiniteNum(t.scale)) add(`${at}.pitch.spanTerms[${i}].scale`, 'scale must be a number (the param is multiplied by it)')
      })
    }
    if (!isFiniteNum(p.pitch) || p.pitch <= 0) add(`${at}.pitch.pitch`, 'pitch must be > 0 (metres between instances)')
    return
  }
  if (hasGrid) {
    const grid = a.grid!
    if (a.stepParams !== undefined) add(`${at}.stepParams`, 'stepParams applies to the `count`+`step` form only')
    if (a.omitFirstParam !== undefined || a.omitLastParam !== undefined) add(`${at}.omitFirstParam`, 'omitFirst/LastParam apply to the 1-D `distribute`/`count` forms, not `grid`')
    validateGridAxis(grid.x, `${at}.grid.x`, add)
    validateGridAxis(grid.z, `${at}.grid.z`, add)
    if (grid.enabledParam !== undefined) add(`${at}.grid.enabledParam`, 'array.grid.enabledParam was retired (package format 4): give the link `showParam` instead')
    return
  }
  if (hasDistribute) {
    const d = a.distribute!
    if (a.stepParams !== undefined) add(`${at}.stepParams`, 'stepParams applies to the `count`+`step` form only')
    if (d.axis !== 0 && d.axis !== 1 && d.axis !== 2) add(`${at}.distribute.axis`, 'axis must be 0, 1 or 2')
    if (typeof d.spanParam !== 'string' || d.spanParam === '') add(`${at}.distribute.spanParam`, 'spanParam must be a non-empty string')
    if (d.spanAdd !== undefined && !isFiniteNum(d.spanAdd)) add(`${at}.distribute.spanAdd`, 'spanAdd must be a number (metres added to the span)')
    if (!isFiniteNum(d.maxSpacing) || d.maxSpacing <= 0) add(`${at}.distribute.maxSpacing`, 'maxSpacing must be > 0')
    if (d.worldPhase !== undefined && typeof d.worldPhase !== 'boolean') add(`${at}.distribute.worldPhase`, 'worldPhase must be a boolean')
    else if (d.worldPhase === true && d.axis !== 0) add(`${at}.distribute.worldPhase`, 'worldPhase requires axis 0 (the flow axis)')
  } else {
    if (typeof a.count !== 'string' || a.count === '') add(`${at}.count`, 'count must be a non-empty param name')
    if (!isVec3(a.step)) add(`${at}.step`, 'step must be 3 finite numbers')
    validateSizeParams(a.stepParams, `${at}.stepParams`, add)
  }
}

function validateRigShape(shape: unknown, at: string, add: (field: string, message: string) => void, assetIds: Set<string>, materialIds: Set<string>): void {
  const s = shape as { kind?: unknown; size?: unknown; sizeParams?: unknown; tileUv?: unknown; radius?: unknown; height?: unknown; length?: unknown; width?: unknown; asset?: unknown; node?: unknown; scale?: unknown; fitHeight?: unknown; material?: unknown; materials?: unknown; lamp?: unknown; lamps?: unknown; hideNodes?: unknown; keepNode?: unknown; collision?: unknown; text?: unknown; textParam?: unknown; textFrom?: unknown; color?: unknown; spanParam?: unknown; widthParam?: unknown; standParam?: unknown; frameDepth?: unknown; frameDepthParam?: unknown; arc?: unknown; bed?: unknown }
  // (`s.sizeParams` is validated per-kind below)
  if (s?.kind === 'box') {
    if (!isVec3(s.size) || s.size.some((n) => n <= 0)) add(`${at}.size`, 'box size must be 3 positive numbers')
    validateSizeParams(s.sizeParams, `${at}.sizeParams`, add)
  } else if (s?.kind === 'cylinder') {
    if (!isFiniteNum(s.radius) || s.radius <= 0) add(`${at}.radius`, 'cylinder radius must be > 0')
    if (!isFiniteNum(s.height) || s.height <= 0) add(`${at}.height`, 'cylinder height must be > 0')
    validateSizeParams(s.sizeParams, `${at}.sizeParams`, add)
  } else if (s?.kind === 'cone') {
    if (!isFiniteNum(s.radius) || s.radius <= 0) add(`${at}.radius`, 'cone radius must be > 0')
    if (!isFiniteNum(s.height) || s.height <= 0) add(`${at}.height`, 'cone height must be > 0')
  } else if (s?.kind === 'deck') {
    add(`${at}.kind`, 'shape.kind "deck" was retired (package format 4): a box link with `conveys: true` is the same conveying slab')
  } else if (s?.kind === 'frame') {
    // transform-only: nothing else to validate
  } else if (s?.kind === 'mesh') {
    if (typeof s.asset !== 'string' || !assetIds.has(s.asset)) add(`${at}.asset`, 'mesh.asset must reference an embedded package asset id')
    if (s.node !== undefined && (typeof s.node !== 'string' || s.node === '')) add(`${at}.node`, 'mesh.node must be a non-empty string')
    if (s.scale !== undefined && (!isFiniteNum(s.scale) || s.scale <= 0)) add(`${at}.scale`, 'mesh.scale must be > 0')
    validateSizeParams(s.sizeParams, `${at}.sizeParams`, add)
    validateTileUv(s.tileUv, s.sizeParams, `${at}.tileUv`, add)
    if (s.fitHeight !== undefined && (!isFiniteNum(s.fitHeight) || s.fitHeight <= 0)) add(`${at}.fitHeight`, 'mesh.fitHeight must be > 0')
    if (s.fitHeight !== undefined && s.node !== undefined) add(`${at}.fitHeight`, 'mesh.fitHeight applies to a whole-scene ref only (drop `node`)')
    if (s.material !== undefined && (typeof s.material !== 'string' || !materialIds.has(s.material))) add(`${at}.material`, 'mesh.material must reference a package material id')
    if (s.materials !== undefined) {
      if (typeof s.materials !== 'object' || s.materials === null || Array.isArray(s.materials)) {
        add(`${at}.materials`, 'mesh.materials must be a map of GLB-material-name → package material id')
      } else {
        for (const [glbName, matId] of Object.entries(s.materials as Record<string, unknown>)) {
          if (typeof matId !== 'string' || !materialIds.has(matId)) add(`${at}.materials.${glbName}`, 'mesh.materials value must reference a package material id')
        }
      }
    }
    if (s.hideNodes !== undefined) {
      if (!Array.isArray(s.hideNodes) || s.hideNodes.some((n) => typeof n !== 'string' || n === '')) {
        add(`${at}.hideNodes`, 'mesh.hideNodes must be an array of non-empty GLB node names')
      } else if (s.node !== undefined) {
        add(`${at}.hideNodes`, 'mesh.hideNodes applies to a whole-scene ref only (drop `node`)')
      }
    }
    if (s.keepNode !== undefined) {
      if (typeof s.keepNode !== 'string' || s.keepNode === '') add(`${at}.keepNode`, 'mesh.keepNode must be a non-empty GLB node name')
      else if (s.node !== undefined) add(`${at}.keepNode`, 'mesh.keepNode applies to a whole-scene ref only (drop `node`)')
      else if (s.hideNodes !== undefined) add(`${at}.keepNode`, 'mesh.keepNode and mesh.hideNodes are mutually exclusive')
    }
    if (s.collision !== undefined) add(`${at}.collision`, "a mesh's collision box moved to its link: collision: { box: [x, y, z] } (package format 4)")
  } else if (s?.kind === 'label') {
    if (s.text !== undefined && typeof s.text !== 'string') add(`${at}.text`, 'label.text must be a string')
    if (s.textParam !== undefined && (typeof s.textParam !== 'string' || s.textParam === '')) add(`${at}.textParam`, 'label.textParam must be a non-empty param name')
    if (s.textFrom !== undefined && (typeof s.textFrom !== 'string' || s.textFrom === '')) add(`${at}.textFrom`, 'label.textFrom must be a non-empty display name (the name ctx.display() publishes)')
    if (s.size !== undefined && (!Array.isArray(s.size) || s.size.length !== 2 || !s.size.every((n) => isFiniteNum(n) && n > 0))) add(`${at}.size`, 'label.size must be 2 positive numbers [width, height]')
    if (s.color !== undefined && !isVec3(s.color)) add(`${at}.color`, 'label.color must be 3 finite numbers (r, g, b in 0..1)')
  } else if (s?.kind === 'leg') {
    if (typeof s.spanParam !== 'string' || s.spanParam === '') add(`${at}.spanParam`, 'leg.spanParam must be a non-empty param name')
    if (typeof s.widthParam !== 'string' || s.widthParam === '') add(`${at}.widthParam`, 'leg.widthParam must be a non-empty param name')
    if (typeof s.standParam !== 'string' || s.standParam === '') add(`${at}.standParam`, 'leg.standParam must be a non-empty param name')
    if (!isFiniteNum(s.frameDepth)) add(`${at}.frameDepth`, 'leg.frameDepth must be a finite number')
    const fdp = s.frameDepthParam as { param?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown } | undefined
    if (fdp !== undefined) {
      if (typeof fdp !== 'object' || fdp === null || typeof fdp.param !== 'string' || fdp.param === '') add(`${at}.frameDepthParam`, 'leg.frameDepthParam must be { param, scale?, add?, min?, max? } naming a number param')
      else for (const f of ['scale', 'add', 'min', 'max'] as const) if (fdp[f] !== undefined && !isFiniteNum(fdp[f])) add(`${at}.frameDepthParam.${f}`, `leg.frameDepthParam.${f} must be a finite number`)
    }
    const arc = s.arc as { radiusParam?: unknown; sweepDeg?: unknown } | undefined
    if (arc !== undefined) {
      if (typeof arc.radiusParam !== 'string' || arc.radiusParam === '') add(`${at}.arc.radiusParam`, 'leg.arc.radiusParam must be a non-empty param name')
      if (!isFiniteNum(arc.sweepDeg)) add(`${at}.arc.sweepDeg`, 'leg.arc.sweepDeg must be a finite number')
    }
  } else if (typeof s?.kind === 'string' && Object.hasOwn(RETIRED_SHAPE_KINDS, s.kind)) {
    add(`${at}.kind`, `shape.kind "${s.kind}" was retired: ${RETIRED_SHAPE_KINDS[s.kind]!.advice}`)
  } else {
    add(`${at}.kind`, 'shape.kind must be "box", "cylinder", "cone", "frame", "mesh", "label" or "leg"')
  }
}

/** The host finishes a rig link may take ({@link RigLink.finish}). */
export const RIG_FINISHES: readonly Finish[] = ['frame', 'guard', 'leg', 'bolt', 'gapfill', 'roller', 'belt', 'tread', 'deck', 'mesh']

// Does the parent chain of any link loop back on itself? A cycle would make FK composition (render/sim)
// recurse forever, so it's rejected at import.
function hasParentCycle(parents: Map<string, string | undefined>): boolean {
  for (const start of parents.keys()) {
    const seen = new Set<string>()
    let cur: string | undefined = start
    while (cur !== undefined) {
      if (seen.has(cur)) return true
      seen.add(cur)
      cur = parents.get(cur)
    }
  }
  return false
}

/** A link's {@link RigLink.lamps} and {@link RigLink.squash}. Whether `squash.lamp` names a real lamp is a
 *  reference, checked with the others in core/parts/partAuthoringChecks. */
function validateLinkLamps(l: { name?: unknown; shape?: { kind?: unknown; materials?: unknown }; lamps?: unknown; squash?: unknown; color?: unknown }, at: string, add: (field: string, message: string) => void, lampNames: Set<string>): void {
  if (l.lamps !== undefined) {
    if (!Array.isArray(l.lamps) || l.lamps.length === 0) add(`${at}.lamps`, 'lamps must be a non-empty array of lamps')
    else {
      const mesh = l.shape?.kind === 'mesh'
      if (!mesh && l.lamps.length > 1) add(`${at}.lamps`, "a primitive link carries at most one lamp (its own material); several lamps need a mesh link's materials")
      if (!mesh && l.color !== undefined) add(`${at}.color`, "a lamp link's colours are its lamp's: the lit `emissive` and the dark `offColor` (package format 3 took the link's color for offColor)")
      const remap = (l.shape?.materials ?? {}) as Record<string, unknown>
      l.lamps.forEach((raw: unknown, i: number) => {
        const lamp = raw as { name?: unknown; emissive?: unknown; offColor?: unknown; material?: unknown; opacity?: unknown; param?: unknown } | null
        const la = `${at}.lamps[${i}]`
        const name = lamp?.name === undefined ? l.name : lamp.name
        if (typeof name !== 'string' || name === '') add(`${la}.name`, 'lamp name must be a non-empty string')
        else if (lampNames.has(name)) add(`${la}.name`, `duplicate lamp name "${name}": ctx.lamps has one entry per name (name the second lamp on a link)`)
        else lampNames.add(name)
        // without a lit colour the lamp is a silent no-op: it registers, the behavior toggles it, nothing changes
        if (!isVec3(lamp?.emissive)) add(`${la}.emissive`, 'lamp emissive must be 3 finite numbers (the lit colour, r/g/b in 0..1)')
        if (lamp?.offColor !== undefined && !isVec3(lamp.offColor)) add(`${la}.offColor`, 'lamp offColor must be 3 finite numbers (the dark colour, r/g/b in 0..1)')
        if (mesh) {
          // a lamp may only light a material this link remaps: an un-remapped GLB material is shared with every
          // other part using the model, so repainting it would light their lenses too
          if (typeof lamp?.material !== 'string' || lamp.material === '' || !(lamp.material in remap)) {
            add(`${la}.material`, 'a mesh lamp names the GLB material it lights, one this link remaps (a key of `materials`)')
          }
        } else if (lamp?.material !== undefined) add(`${la}.material`, "lamp material is for a mesh link; a primitive's lamp is its own material")
        if (lamp?.opacity !== undefined && (!isFiniteNum(lamp.opacity) || lamp.opacity <= 0 || lamp.opacity > 1)) add(`${la}.opacity`, 'lamp opacity must be in (0, 1]')
        if (lamp?.param !== undefined && (typeof lamp.param !== 'string' || lamp.param === '')) add(`${la}.param`, 'lamp param must be a non-empty string (a boolean param key)')
      })
    }
  }
  const squash = l.squash as { amount?: unknown; lamp?: unknown } | undefined
  if (squash !== undefined) {
    if (typeof squash !== 'object' || squash === null) add(`${at}.squash`, 'squash must be an object { amount, lamp? }')
    else {
      if (!isFiniteNum(squash.amount) || squash.amount <= 0 || squash.amount > 1) add(`${at}.squash.amount`, 'squash.amount must be a number in (0, 1]')
      if (squash.lamp !== undefined && (typeof squash.lamp !== 'string' || squash.lamp === '')) add(`${at}.squash.lamp`, 'squash.lamp must be a non-empty lamp name')
      if (l.shape?.kind !== 'mesh') add(`${at}.squash`, 'squash compresses a mesh link (a suction cup); this link is not one')
    }
  }
}

export function validateRig(g: { links?: unknown; joints?: unknown; posable?: unknown }, problems: PackageProblem[], assetIds: Set<string>, materialIds: Set<string>): void {
  const add = (field: string, message: string): void => {
    problems.push({ field, message })
  }
  if (g.posable !== undefined && typeof g.posable !== 'boolean') add('geometry.posable', 'posable must be a boolean')
  const links = g.links
  if (!Array.isArray(links) || links.length === 0) {
    add('geometry.links', 'rig must have a non-empty links array')
    return
  }
  const names = new Set<string>()
  const lampNames = new Set<string>() // ctx.lamps has one entry per name, across the whole rig
  const parents = new Map<string, string | undefined>()
  links.forEach((raw, i) => {
    const l = raw as { name?: unknown; parent?: unknown; offset?: unknown; rotation?: unknown; shape?: unknown }
    const at = `geometry.links[${i}]`
    if (typeof l?.name !== 'string' || l.name === '') {
      add(`${at}.name`, 'link name must be a non-empty string')
      return
    }
    if (names.has(l.name)) add(`${at}.name`, `duplicate link name "${l.name}"`)
    names.add(l.name)
    parents.set(l.name, typeof l.parent === 'string' ? l.parent : undefined)
    if (!isVec3(l.offset)) add(`${at}.offset`, 'offset must be 3 finite numbers')
    validateSizeParams((l as { offsetParams?: unknown }).offsetParams, `${at}.offsetParams`, add)
    const rotationParams = (l as { rotationParams?: unknown }).rotationParams
    validateSizeParams(rotationParams, `${at}.rotationParams`, add)
    if (rotationParams !== undefined && (l as { quat?: unknown }).quat !== undefined) add(`${at}.rotationParams`, 'rotationParams drive the Euler rotation, which a quat replaces: give the link a rotation instead of a quat')
    const color = (l as { color?: unknown }).color
    if (color !== undefined && !isVec3(color)) add(`${at}.color`, 'color must be 3 finite numbers (r, g, b in 0..1)')
    const colorParam = (l as { colorParam?: unknown }).colorParam
    if (colorParam !== undefined && (typeof colorParam !== 'string' || colorParam === '')) add(`${at}.colorParam`, 'colorParam must be a non-empty string (a color/string param key)')
    for (const k of ['metalness', 'roughness'] as const) {
      const v = (l as Record<string, unknown>)[k]
      if (v !== undefined && (!isFiniteNum(v) || v < 0 || v > 1)) add(`${at}.${k}`, `${k} must be a number in [0, 1]`)
    }
    const opacity = (l as { opacity?: unknown }).opacity
    if (opacity !== undefined && (!isFiniteNum(opacity) || opacity <= 0 || opacity > 1)) add(`${at}.opacity`, 'opacity must be a number in (0, 1]')
    const outline = (l as { outline?: unknown }).outline
    if (outline !== undefined && !isVec3(outline)) add(`${at}.outline`, 'outline must be 3 finite numbers (r, g, b in 0..1)')
    if ((l as { edges?: unknown }).edges !== undefined) add(`${at}.edges`, 'edges was renamed outline (package format 4)')
    if ((l as { noCollision?: unknown }).noCollision !== undefined) add(`${at}.noCollision`, "noCollision was replaced by collision: 'none' (package format 4)")
    const collision = (l as { collision?: unknown }).collision
    if (collision !== undefined && collision !== 'none') {
      const box = (collision as { box?: unknown } | null)?.box
      if (!isVec3(box) || box.some((n) => n <= 0)) add(`${at}.collision`, "collision must be 'none' or { box: [x, y, z] } (3 positive numbers)")
      else if (!['mesh', 'frame'].includes((l as { shape?: { kind?: unknown } }).shape?.kind as string)) add(`${at}.collision.box`, "collision.box is for a mesh or frame link (a primitive collides as its own shape; use 'none' to turn that off)")
    }
    const finish = (l as { finish?: unknown }).finish
    if (finish !== undefined && !RIG_FINISHES.includes(finish as Finish)) add(`${at}.finish`, `finish must be one of ${RIG_FINISHES.map((f) => `'${f}'`).join(',')}`)
    const finishParam = (l as { finishParam?: unknown }).finishParam
    if (finishParam !== undefined && (typeof finishParam !== 'string' || finishParam === '')) add(`${at}.finishParam`, 'finishParam must be the name of an enum param')
    if ((l as { role?: unknown }).role !== undefined) add(`${at}.role`, 'role was split (package format 4): the look is `finish`, and what it switched on is declared on its own (sideGuard, sideRail, bed, notchable)')
    for (const key of ['sideGuard', 'sideRail'] as const) {
      const side = (l as Record<string, unknown>)[key]
      if (side === undefined) continue
      if (side !== 'left' && side !== 'right') add(`${at}.${key}`, `${key} must be 'left' or 'right'`)
      else if ((l as { shape?: { kind?: unknown } }).shape?.kind !== 'box') add(`${at}.${key}`, `${key} is for a box link (the wall the host splits and retracts)`)
    }
    if ((l as { sideGuard?: unknown }).sideGuard !== undefined && (l as { sideRail?: unknown }).sideRail !== undefined) add(`${at}.sideRail`, 'a link is a sideGuard or a sideRail, not both')
    for (const key of ['bed', 'notchable'] as const) {
      const v = (l as Record<string, unknown>)[key]
      if (v !== undefined && typeof v !== 'boolean') add(`${at}.${key}`, `${key} must be a boolean`)
    }
    if ((l as { notchable?: unknown }).notchable === true && (l as { shape?: { kind?: unknown } }).shape?.kind !== 'box') add(`${at}.notchable`, 'notchable is for a box link (the deck slab the host carves)')
    const friction = (l as { friction?: unknown }).friction
    if (friction !== undefined) {
      if (!isFiniteNum(friction) || friction < 0 || friction > 2) add(`${at}.friction`, 'friction must be a number from 0 to 2 (the scale a conveyor frictionParam uses)')
      else if ((l as { sideGuard?: unknown }).sideGuard !== undefined) add(`${at}.friction`, 'a sideGuard has no friction (cargo slides along it); drop friction or the sideGuard')
      else if ((l as { conveys?: unknown }).conveys === true) add(`${at}.friction`, "a conveys deck's friction is the conveyor's frictionParam; drop friction here")
    }
    validateLinkLamps(l as { name?: unknown; shape?: { kind?: unknown; materials?: unknown }; lamps?: unknown; squash?: unknown }, at, add, lampNames)
    const beam = (l as { beam?: unknown }).beam as { range?: unknown; rangeParam?: unknown; showParam?: unknown; axis?: unknown; tint?: unknown } | undefined
    if (beam !== undefined) {
      if (!isFiniteNum(beam.range) || beam.range <= 0) add(`${at}.beam.range`, 'beam.range must be > 0')
      if (beam.axis !== undefined && (!isVec3(beam.axis) || beam.axis.every((n) => n === 0))) add(`${at}.beam.axis`, 'beam.axis must be 3 finite numbers, not all zero')
      if (beam.tint !== undefined && beam.tint !== 'hit') add(`${at}.beam.tint`, "beam.tint must be 'hit'")
      if (beam.rangeParam !== undefined && (typeof beam.rangeParam !== 'string' || beam.rangeParam === '')) add(`${at}.beam.rangeParam`, 'beam.rangeParam must be a non-empty param name')
      if (beam.showParam !== undefined && (typeof beam.showParam !== 'string' || beam.showParam === '')) add(`${at}.beam.showParam`, 'beam.showParam must be a non-empty param name')
    }
    const zone = (l as { zone?: unknown }).zone as { size?: unknown; sizeParams?: unknown } | undefined
    if (zone !== undefined) {
      if (!isVec3(zone.size) || zone.size.some((n) => n <= 0)) add(`${at}.zone.size`, 'zone.size must be 3 positive numbers')
      validateSizeParams(zone.sizeParams, `${at}.zone.sizeParams`, add)
    }
    const loadCell = (l as { loadCell?: unknown }).loadCell
    if (loadCell !== undefined) {
      if (typeof loadCell !== 'boolean') add(`${at}.loadCell`, 'loadCell must be a boolean')
      else if (loadCell) {
        // the host weighs what rests on the link's own body, so it needs one: a solid box, not an array of copies
        const lk = l as { shape?: { kind?: unknown }; collision?: unknown; array?: unknown }
        if (lk.shape?.kind !== 'box') add(`${at}.loadCell`, 'loadCell is for a box link (the platform the load rests on)')
        else if (lk.collision === 'none') add(`${at}.loadCell`, "a loadCell link must be solid: remove collision: 'none'")
        else if (lk.array !== undefined) add(`${at}.loadCell`, 'a loadCell link cannot be an array: give each platform its own link')
      }
    }
    for (const old of ['grabZone', 'grabRadius', 'grabParams'] as const) {
      if ((l as Record<string, unknown>)[old] !== undefined) add(`${at}.${old}`, `${old} moved into the link's \`grip\` block (package format 4): grip: { zone, radius, radiusParams }`)
    }
    const grip = (l as { grip?: unknown }).grip as { zone?: { size?: unknown; offset?: unknown; sizeParams?: unknown }; radius?: unknown; radiusParams?: unknown; forks?: unknown } | undefined
    if (grip !== undefined) {
      if (typeof grip !== 'object' || grip === null) add(`${at}.grip`, 'grip must be an object: { zone?, radius?, radiusParams? }')
      else {
        if (grip.radius !== undefined && (!isFiniteNum(grip.radius) || grip.radius <= 0)) add(`${at}.grip.radius`, 'grip.radius must be a positive number (metres)')
        validateSizeParams(grip.radiusParams, `${at}.grip.radiusParams`, add)
        const zone = grip.zone
        if (zone !== undefined) {
          if (!isVec3(zone.size) || zone.size.some((n) => n <= 0)) add(`${at}.grip.zone.size`, 'grip.zone.size must be 3 positive numbers')
          if (zone.offset !== undefined && !isVec3(zone.offset)) add(`${at}.grip.zone.offset`, 'grip.zone.offset must be 3 finite numbers (link-local metres)')
          validateSizeParams(zone.sizeParams, `${at}.grip.zone.sizeParams`, add)
        }
        const forks = grip.forks as { spread?: unknown; spreadParam?: unknown; bladeWidth?: unknown; bladeThickness?: unknown } | undefined
        if (forks !== undefined) {
          if (typeof forks !== 'object' || forks === null) add(`${at}.grip.forks`, 'grip.forks must be an object: { spread? | spreadParam?, bladeWidth, bladeThickness }')
          else {
            for (const k of ['bladeWidth', 'bladeThickness'] as const) {
              if (!isFiniteNum(forks[k]) || (forks[k] as number) <= 0) add(`${at}.grip.forks.${k}`, `grip.forks.${k} must be a positive number (metres)`)
            }
            if (forks.spread !== undefined && (!isFiniteNum(forks.spread) || (forks.spread as number) <= 0)) add(`${at}.grip.forks.spread`, 'grip.forks.spread must be a positive number (metres)')
            if (forks.spreadParam !== undefined && (typeof forks.spreadParam !== 'string' || forks.spreadParam === '')) add(`${at}.grip.forks.spreadParam`, 'grip.forks.spreadParam must name a number param')
            if (forks.spread === undefined && forks.spreadParam === undefined) add(`${at}.grip.forks`, 'grip.forks needs a spread or a spreadParam')
          }
        }
      }
    }
    const conveys = (l as { conveys?: unknown }).conveys
    if (conveys !== undefined && typeof conveys !== 'boolean') add(`${at}.conveys`, 'conveys must be a boolean')
    const hidden = (l as { hidden?: unknown }).hidden
    if (hidden !== undefined && typeof hidden !== 'boolean') add(`${at}.hidden`, 'hidden must be a boolean')
    const showParam = (l as { showParam?: unknown }).showParam
    if (showParam !== undefined && (typeof showParam !== 'string' || showParam === '')) add(`${at}.showParam`, 'showParam must be a non-empty string (a boolean param key)')
    const onEdge = (l as { onEdge?: unknown }).onEdge
    if (onEdge !== undefined && !['posX', 'negX', 'posZ', 'negZ'].includes(onEdge as string)) add(`${at}.onEdge`, "onEdge must be one of 'posX','negX','posZ','negZ' (the deck edge this link runs on)")
    const anchor = (l as { anchor?: unknown }).anchor
    if (anchor !== undefined && anchor !== 'floor') add(`${at}.anchor`, "anchor must be 'floor'")
    const dropWhenMounted = (l as { dropWhenMounted?: unknown }).dropWhenMounted
    if (dropWhenMounted !== undefined && typeof dropWhenMounted !== 'boolean') add(`${at}.dropWhenMounted`, 'dropWhenMounted must be a boolean')
    if ((l as { railing?: unknown }).railing !== undefined) add(`${at}.railing`, 'railing was renamed onEdge (package format 3)')
    if ((l as { stairFoot?: unknown }).stairFoot !== undefined) add(`${at}.stairFoot`, "stairFoot was renamed anchor: 'floor' (package format 3)")
    validateArray((l as { array?: unknown }).array, `${at}.array`, add, l as Record<string, unknown>)
    if (l.rotation !== undefined && !isVec3(l.rotation)) add(`${at}.rotation`, 'rotation must be 3 finite numbers')
    if ((l as { quat?: unknown }).quat !== undefined && !isVec4((l as { quat?: unknown }).quat)) add(`${at}.quat`, 'quat must be 4 finite numbers (x, y, z, w)')
    validateRigShape(l.shape, `${at}.shape`, add, assetIds, materialIds)
  })
  // parent references must resolve to a declared link
  links.forEach((raw, i) => {
    const l = raw as { parent?: unknown }
    if (l?.parent !== undefined && (typeof l.parent !== 'string' || !names.has(l.parent))) {
      add(`geometry.links[${i}].parent`, 'parent must reference an existing link')
    }
  })
  if (hasParentCycle(parents)) add('geometry.links', 'link parent hierarchy has a cycle')
  // a link under a posable array would ride the row's frame, not one instance: say so instead of drawing it once
  const posableNames = new Set(links.filter((raw) => (raw as { array?: { posable?: unknown } }).array?.posable === true).map((raw) => (raw as { name?: unknown }).name))
  links.forEach((raw, i) => {
    const parent = (raw as { parent?: unknown }).parent
    if (posableNames.has(parent)) add(`geometry.links[${i}].parent`, 'a link cannot hang under a posable array: it would follow the row, not an instance. Give it its own posable array with the same count and pose it with the same index')
  })
  // C-aim: a two-point look-at target must resolve to a declared link; up (if given) must be a valid axis
  links.forEach((raw, i) => {
    const aim = (raw as { aim?: unknown }).aim as { target?: unknown; up?: unknown } | undefined
    if (aim === undefined) return
    if (typeof aim.target !== 'string' || !names.has(aim.target)) add(`geometry.links[${i}].aim.target`, 'aim.target must reference an existing link')
    if (aim.up !== undefined && (!isVec3(aim.up) || aim.up.every((n) => n === 0))) add(`geometry.links[${i}].aim.up`, 'aim.up must be 3 finite numbers, not all zero')
  })

  const joints = g.joints
  if (!Array.isArray(joints)) {
    add('geometry.joints', 'rig must have a joints array (may be empty)')
    return
  }
  const jointNames = new Set<string>()
  joints.forEach((raw, i) => {
    const j = raw as { name?: unknown; link?: unknown; type?: unknown; axis?: unknown; min?: unknown; max?: unknown; cosmetic?: unknown; rest?: unknown }
    const at = `geometry.joints[${i}]`
    if (typeof j?.name !== 'string' || j.name === '') add(`${at}.name`, 'joint name must be a non-empty string')
    else {
      if (jointNames.has(j.name)) add(`${at}.name`, `duplicate joint name "${j.name}"`)
      jointNames.add(j.name)
    }
    if (typeof j?.link !== 'string' || !names.has(j.link)) add(`${at}.link`, 'joint.link must reference an existing link')
    if (j?.type !== 'revolute' && j?.type !== 'prismatic') add(`${at}.type`, 'joint.type must be "revolute" or "prismatic"')
    if (!isVec3(j?.axis) || j.axis.every((n) => n === 0)) add(`${at}.axis`, 'axis must be 3 finite numbers, not all zero')
    if (!isFiniteNum(j?.min) || !isFiniteNum(j?.max) || j.min > j.max) add(`${at}.limits`, 'min/max must be finite with min <= max')
    if (j?.cosmetic !== undefined && typeof j.cosmetic !== 'boolean') add(`${at}.cosmetic`, 'cosmetic must be a boolean')
    for (const key of ['minParam', 'maxParam'] as const) {
      const ref = (j as Record<string, unknown> | undefined)?.[key] as { param?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown } | undefined
      if (ref === undefined) continue
      if (typeof ref !== 'object' || ref === null || typeof ref.param !== 'string' || ref.param === '') add(`${at}.${key}`, `${key} must be { param, scale?, add?, min?, max? } naming a number param`)
      else for (const f of ['scale', 'add', 'min', 'max'] as const) if (ref[f] !== undefined && !isFiniteNum(ref[f])) add(`${at}.${key}.${f}`, `${key}.${f} must be a finite number`)
    }
    if (j?.rest !== undefined) {
      const rest = j.rest as { param?: unknown; scale?: unknown; add?: unknown }
      if (typeof rest?.param !== 'string' || rest.param === '') add(`${at}.rest.param`, 'joint rest.param must be a non-empty param name')
      if (rest?.scale !== undefined && !isFiniteNum(rest.scale)) add(`${at}.rest.scale`, 'joint rest.scale must be a finite number')
      if (rest?.add !== undefined && !isFiniteNum(rest.add)) add(`${at}.rest.add`, 'joint rest.add must be a finite number')
    }
    const servo = (j as { servo?: unknown } | undefined)?.servo
    if (servo !== undefined) {
      const s = servo as Record<string, unknown> | null
      const positive = (v: unknown) => isFiniteNum(v) && v > 0
      if (typeof s !== 'object' || s === null) add(`${at}.servo`, 'servo must be { maxVelocity, maxAccel, maxDecel?, modulo? }')
      else {
        if (!positive(s.maxVelocity)) add(`${at}.servo.maxVelocity`, 'servo.maxVelocity must be a positive number')
        if (!positive(s.maxAccel)) add(`${at}.servo.maxAccel`, 'servo.maxAccel must be a positive number')
        if (s.maxDecel !== undefined && !positive(s.maxDecel)) add(`${at}.servo.maxDecel`, 'servo.maxDecel must be a positive number')
        // `ramp` / `maxJerk` are not refused, so an older part that has them still loads; a stored package
        // loses them (dropServoRamps)
        if (s.modulo !== undefined) {
          if (!positive(s.modulo)) add(`${at}.servo.modulo`, 'servo.modulo must be a positive number')
          else if (j?.type !== 'revolute') add(`${at}.servo.modulo`, 'only a revolute joint can wrap (servo.modulo)')
          // the wrapped position falls in [0, modulo), and every pose is clamped to the joint's limits
          else if (isFiniteNum(j?.min) && isFiniteNum(j?.max) && (j.min > 0 || j.max < (s.modulo as number))) add(`${at}.servo.modulo`, 'a wrapping servo\'s joint min / max must cover 0 to modulo')
        }
      }
      if (j?.cosmetic === true) add(`${at}.servo`, 'a cosmetic joint cannot be a servo: a servo is commanded, cosmetic dressing is not')
      if ((j as { mimic?: unknown }).mimic !== undefined) add(`${at}.servo`, 'a mimic joint cannot be a servo: it follows its leader and takes no commands')
    }
  })
  // a follower names another joint of the rig, one that follows none (no chains, so the pose needs one lookup)
  const byName = new Map<string, { mimic?: unknown }>()
  for (const raw of joints) {
    const j = raw as { name?: unknown; mimic?: unknown }
    if (typeof j?.name === 'string') byName.set(j.name, j)
  }
  joints.forEach((raw, i) => {
    const j = raw as { name?: unknown; mimic?: unknown }
    if (j?.mimic === undefined) return
    const at = `geometry.joints[${i}].mimic`
    const m = j.mimic as { joint?: unknown; multiplier?: unknown; offset?: unknown } | null
    if (typeof m !== 'object' || m === null || typeof m.joint !== 'string' || m.joint === '') {
      add(at, 'mimic must be { joint, multiplier?, offset? } naming another joint')
      return
    }
    if (m.multiplier !== undefined && !isFiniteNum(m.multiplier)) add(`${at}.multiplier`, 'mimic.multiplier must be a finite number')
    if (m.offset !== undefined && !isFiniteNum(m.offset)) add(`${at}.offset`, 'mimic.offset must be a finite number')
    const leader = byName.get(m.joint)
    if (!leader || m.joint === j.name) add(`${at}.joint`, `mimic.joint must name another joint of this rig (got ${JSON.stringify(m.joint)})`)
    else if (leader.mimic !== undefined) add(`${at}.joint`, `mimic.joint names "${m.joint}", which follows a joint itself: name the joint it follows`)
  })
  const tool = (g as { tool?: unknown }).tool
  if (tool !== undefined && (typeof tool !== 'string' || !names.has(tool))) add('geometry.tool', `tool must name a link of this rig (got ${JSON.stringify(tool)})`)
}
