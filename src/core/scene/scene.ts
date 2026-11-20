import { sanitizeParents } from './hierarchy'
import { reseatOlderStairs } from '../stairReseat'
import { canonicalAddress, looksLikeAddress } from '../io/iecAddress'
import { controllerTag, splitControllerTag } from '../io/controllerTag'
import { sceneSettings, validateScenePlcs } from './scenePlcs'
import { readSavedUnits } from './sceneUnits'
import { readDisplayList } from './sceneDisplay'
import { packageParamSpecs } from '../packageParams'
import { getPackage, isAuthoritativePackage } from '../parts/partRegistry'
import { validatePartPackage } from '../parts/partValidate'
import { upgradeStoredPackage } from '../parts/partUpgrade'
import type { PartPackage } from '../parts/partPackage'
import { conveyorCenterOffsetX } from '../parts/partGeometry'
import { DEFAULT_SIM_HZ, MAX_SIM_HZ, MIN_SIM_HZ, PART_DEFS, SCENE_VERSION, STAIRS_LANDING_DEPTH, WALL_RULE_NUMBERS, WALL_VARIANTS, toSimRate } from '../types'
import type {
  BuildingPart,
  BuildingWallRule,
  SdkPart,
  SdkPartParams,
  NumberListParamSpec,
  ParamSpec,
  ParamValue,
  PartInstance,
  PartType,
  SceneJSON,
  SceneUnits,
  SimRate,
  WallVariant,
} from '../types'
import { clamp, isHexColor, isHexColorA, normalizeHexColorList } from '../math'
import { validateController } from '../controller'
import type { Controller } from '../controller'
import { storedDialect, validateDialect } from '../dialect'

export type ValidationResult =
  // stProgram is present only when the file bundled a PLC program (top-level `stProgram`
  // string); absent leaves the editor's current program untouched on import. stScanMs is that
  // program's authored scan (cycle) time - part of the program, so it travels with it. Structural
  // only here (a finite number): the range clamp belongs to the one adoption point in the editor
  // (clampScanMs), so a hand-edited file can't put a runaway scan rate into a running engine.
  // `controller` is the program's task table (core/controller.ts), which rides with it the same way, and
  // `stDialect` marks a program in a dialect this build does not run (core/dialect.ts): present only when it is not IEC.
  // `simHz` is the scene's physics step rate (core/project/project.ts ProjectMachine.simHz), present only when the file names
  // one other than DEFAULT_SIM_HZ; it is the layout's, not the program's, so it is kept with or without a program.
  // `repairs` lists what loading changed to make the file valid (see paramRepair); absent when nothing was.
  | { ok: true; scene: SceneJSON; stProgram?: string; stScanMs?: number; controller?: Controller; stDialect?: string; simHz?: SimRate; repairs?: string[] }
  | { ok: false; errors: string[] }

const ID_PREFIXES: Record<PartType, string> = {
  building: 'bld',
  group: 'grp',
  part: 'pt',
  annotation: 'note',
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return isFiniteNumber(v) ? clamp(Math.round(v), min, max) : fallback
}

/** sanitize an untrusted building wall-rule list (empty is allowed) */
const ruleInt = (r: Record<string, unknown>, key: keyof typeof WALL_RULE_NUMBERS): number => {
  const { min, max, absent } = WALL_RULE_NUMBERS[key]
  return clampInt(r[key], min, max, absent)
}

function validateWallRules(v: unknown): BuildingWallRule[] {
  if (!Array.isArray(v)) return []
  const out: BuildingWallRule[] = []
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    out.push({
      wall: WALL_VARIANTS.includes(r.wall as WallVariant) ? (r.wall as WallVariant) : 'B',
      run: ruleInt(r, 'run'),
      gap: ruleInt(r, 'gap'),
      count: ruleInt(r, 'count'),
      start: ruleInt(r, 'start'),
      doorCount: ruleInt(r, 'doorCount'),
      trailer: typeof r.trailer === 'boolean' ? r.trailer : true,
    })
  }
  return out
}

/**
 * Sanitize a `numberList` value: an array of rows, each coerced to exactly `arity` finite numbers
 * (missing cells padded with 0, extras dropped, clamped to min/max when bounded). Non-array rows are
 * skipped; a non-array value (or one that yields no usable rows) falls back to a deep copy of the
 * default. Always returns a fresh array so instances never alias the spec or each other.
 */
function coerceNumberList(v: unknown, spec: NumberListParamSpec): number[][] {
  const arity = Math.max(1, Math.floor(spec.arity))
  const lo = typeof spec.min === 'number' ? spec.min : -Infinity
  const hi = typeof spec.max === 'number' ? spec.max : Infinity
  const cell = (n: unknown): number => (isFiniteNumber(n) ? clamp(n, lo, hi) : 0)
  if (Array.isArray(v)) {
    const rows: number[][] = []
    for (const raw of v) {
      if (!Array.isArray(raw)) continue
      const row: number[] = []
      for (let i = 0; i < arity; i++) row.push(cell(raw[i]))
      rows.push(row)
    }
    if (rows.length > 0) return rows
  }
  return spec.default.map((row) => row.slice(0, arity))
}

/** sanitize the per-leaf dock-door open-state list: unique non-empty string keys */
function validateDoorKeys(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  for (const k of v) if (typeof k === 'string' && k !== '') seen.add(k)
  return [...seen]
}

function validateParam(spec: ParamSpec, v: unknown): ParamValue {
  switch (spec.kind) {
    case 'number': {
      if (!isFiniteNumber(v)) return spec.default
      // integer-step params (e.g. chains) must stay on the step grid
      const snapped = Number.isInteger(spec.step) && spec.step >= 1 ? Math.round(v / spec.step) * spec.step : v
      // A `rest` param (host-resolved placement fact, e.g. a conveyor's standHeight) can legitimately exceed
      // its manual-slider max when the deck stands on a tall surface. Clamp only the floor so load never shrinks
      // it below the deck it pairs with - a shrunk standHeight floats the legs off the floor on reload.
      return spec.rest ? Math.max(spec.min, snapped) : clamp(snapped, spec.min, spec.max)
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : (spec.whenAbsent ?? spec.default) // (absent is not "new": ParamSpec.whenAbsent)
    case 'enum':
      return typeof v === 'string' && spec.options.some((o) => o.value === v) ? v : spec.default
    case 'color':
      if (spec.list) return normalizeHexColorList(v) ?? spec.default
      return (spec.alpha ? isHexColorA(v) : isHexColor(v)) ? (v as string).toLowerCase() : spec.default
    case 'text':
      return typeof v === 'string' ? v : spec.default
    case 'partRef':
      // a part id (or '' for unset); existence isn't checked here - a dangling ref is inert
      return typeof v === 'string' ? v : spec.default
    case 'tagRef':
      // a PLC tag name (or '' for unbound); a tag the program hasn't declared yet is inert, not invalid.
      // A direct address (%IX100.0) is stored in its one canonical spelling, since the tag table meets
      // the program's located variables by exact key; a malformed one is kept as typed, for the wiring
      // check to name. Behind a controller's name (`Cell2::%IX0.0`, core/io/controllerTag.ts) the address is the same.
      if (typeof v !== 'string') return spec.default
      {
        const { controller, local } = splitControllerTag(v)
        return looksLikeAddress(local) ? controllerTag(controller, canonicalAddress(local) ?? local) : v
      }
    case 'numberList':
      // structured table → each row coerced to `arity` finite numbers (clamped if bounded). A non-array
      // (e.g. legacy JSON string, or a malformed load) falls back to a deep copy of the default. A value
      // edited through the grid is always valid, so only a hand-edited or malformed file reaches the fallback.
      return coerceNumberList(v, spec)
    case 'wallRules':
      return validateWallRules(v)
  }
}

/**
 * What {@link validateParam} changed about a value the file did give, as a sentence, or null when it kept it.
 * Loading repairs rather than rejects, so a document stays openable; but a repair is silent in the app, and
 * the file's author (a hand edit, an agent) believes the value they wrote is what runs. An absent param
 * taking its default is not a repair, and neither is a spelling the loader only canonicalizes (a colour's
 * case, an address's spelling).
 */
function paramRepair(spec: ParamSpec, raw: unknown, out: ParamValue): string | null {
  if (raw === undefined) return null
  const shown = JSON.stringify(raw)
  switch (spec.kind) {
    case 'number': {
      if (!isFiniteNumber(raw)) return `${shown} is not a number, so it loads as the default ${String(out)}`
      if (raw === out) return null
      const outside = raw < spec.min || (!spec.rest && raw > spec.max)
      return outside ? `${raw} is outside ${spec.min} to ${spec.max}, so it loads as ${String(out)}` : `${raw} is not a whole step of ${spec.step}, so it loads as ${String(out)}`
    }
    case 'enum':
      return raw === out ? null : `${shown} is not one of ${spec.options.map((o) => o.value).join(', ')}, so it loads as ${JSON.stringify(out)}`
    case 'color':
      // a list's spacing and missing '#' are spellings, not repairs; a dropped entry is one
      if (spec.list) return typeof raw === 'string' && raw.split(',').filter((c) => c.trim()).length === (out === '' ? 0 : String(out).split(',').length) ? null : `${shown} holds entries that are not colours, so it loads as ${JSON.stringify(out)}`
      return typeof raw === 'string' && raw.toLowerCase() === out ? null : `${shown} is not a colour, so it loads as ${JSON.stringify(out)}`
    case 'tagRef':
      return typeof raw === 'string' ? null : `${shown} is not a tag name, so it loads unbound`
    case 'numberList':
      return JSON.stringify(raw) === JSON.stringify(out) ? null : `is not a list of ${spec.arity}-number rows in range, so it loads as ${JSON.stringify(out)}`
    case 'wallRules':
      return Array.isArray(raw) ? null : `${shown} is not a list of wall rules, so it loads empty`
    case 'boolean':
    case 'text':
    case 'partRef':
      return raw === out ? null : `${shown} is not a ${spec.kind === 'boolean' ? 'true/false' : 'string'}, so it loads as the default ${JSON.stringify(out)}`
  }
}

/** new part with default params for its type */
export function createPart(
  type: PartType,
  id: string,
  position: [number, number, number],
  rotationY = 0,
): PartInstance {
  const params: Record<string, ParamValue> = {}
  for (const spec of PART_DEFS[type].params) {
    // array defaults are deep-copied so instances don't share the spec's array
    if (spec.kind === 'wallRules') params[spec.key] = spec.default.map((r) => ({ ...r }))
    else if (spec.kind === 'numberList') params[spec.key] = spec.default.map((row) => [...row])
    else params[spec.key] = spec.default
  }
  return {
    id,
    type,
    position: [position[0], position[1], position[2]],
    rotationY,
    params,
  } as unknown as PartInstance
}

/**
 * The default building: a 5×4×1 shell over the default Wall_D, with
 * Wall_B accents front/back, Wall_A on the side corners, and a double dock door centred on the
 * front wall backed by container trailers + auto levelers. Lives in core (not editor/demo/demoScenes,
 * which re-exports it) so the render layer can build the same warehouse as a non-content
 * backdrop without importing the editor. Shared by New, the blank default scene, the PLC demo,
 * and the viewport backdrop, so all four open in the identical warehouse.
 */
export const DEFAULT_BUILDING_RULES: readonly BuildingWallRule[] = [
  { wall: 'B', run: 1, gap: 1, count: 2, start: 1, doorCount: 1, trailer: true },
  { wall: 'B', run: 1, gap: 1, count: 2, start: 24, doorCount: 1, trailer: true },
  { wall: 'A', run: 1, gap: 2, count: 2, start: 32, doorCount: 1, trailer: true },
  { wall: 'A', run: 1, gap: 2, count: 2, start: 28, doorCount: 1, trailer: true },
  { wall: 'dock_door', run: 1, gap: 1, count: 1, start: 2, doorCount: 2, trailer: true },
]

export function defaultBuilding(id = 'bld_1'): BuildingPart {
  const building = createPart('building', id, [0, 0, 0]) as BuildingPart
  building.name = 'Building'
  building.locked = true // structural backdrop - locked by default so it isn't selected/dragged by accident
  building.params.lengthSections = 5 // local X
  building.params.widthSections = 4 // local Z
  building.params.rules = DEFAULT_BUILDING_RULES.map((r) => ({ ...r }))
  return building
}

/**
 * new custom-part instance with default params baked from its package's schema.
 *
 * `placed`: a person is placing this part (the editor's catalog drop), so a switch with a `whenAbsent` takes its
 * `default`, the value meant for new parts. Every other caller (the demo scenes, a test, an adopted box) builds a
 * part in code and then sets the params it knows about, and code written before such a switch existed knows
 * nothing of it: a conveyor built here and given `speed: 1` must run at 1 m/s, not sit in feet per minute ignoring it.
 * So there the switch takes `whenAbsent`, exactly as a saved part without the key does.
 *
 * `units`: the Units of the scene it is placed into (SceneJSON.units; absent = metric, core/scene/sceneUnits.ts). A placed
 * part's units switch (ParamSpec.imperialUnits) takes it instead of its `default`, so the scene stays in one unit.
 */
export function createSdkPart(
  pkg: PartPackage,
  id: string,
  position: [number, number, number],
  rotationY = 0,
  opts: { placed?: boolean; units?: SceneUnits } = {},
): SdkPart {
  const params: SdkPartParams = {}
  for (const spec of packageParamSpecs(pkg)) {
    // package specs are only number/boolean/text, so the default is always a SdkPartParams value
    if (spec.kind === 'boolean' && opts.placed && spec.imperialUnits) params[spec.key] = opts.units === 'imperial'
    else params[spec.key] = (spec.kind === 'boolean' && !opts.placed ? (spec.whenAbsent ?? spec.default) : spec.default) as number | boolean | string
  }
  return {
    id,
    type: 'part',
    packageId: pkg.id,
    position: [position[0], position[1], position[2]],
    rotationY,
    params,
  }
}

/**
 * A per-client id suffix appended in collaborative (room) mode, e.g. `~a3f`. Two clients
 * minting from the same part-count would otherwise both compute `rc_1` and collide as one
 * Yjs map key; the suffix (derived from the Yjs clientID at boot) keeps every client's ids
 * distinct while preserving the readable `prefix_number` base. Empty in solo mode.
 */
let ID_SUFFIX = ''

/** set the room-unique id suffix (collab boot); '' restores solo behaviour */
export function setNextIdSuffix(suffix: string): void {
  ID_SUFFIX = suffix
}

/** the highest numeric id already minted for `prefix` in the scene */
function maxIdNum(scene: SceneJSON, prefix: string): number {
  let max = 0
  for (const part of scene.parts) {
    if (!part.id.startsWith(prefix)) continue
    // the numeric run may carry a `~suffix` (room ids); parse only the leading digits
    const n = Number(part.id.slice(prefix.length).split('~')[0])
    if (Number.isInteger(n) && n > max) max = n
  }
  return max
}

/** short readable unique id within scene, e.g. rc_1, bst_2 (rc_1~a3f in a room) */
export function nextId(scene: SceneJSON, type: PartType): string {
  const prefix = `${ID_PREFIXES[type]}_`
  return `${prefix}${maxIdNum(scene, prefix) + 1}${ID_SUFFIX}`
}

/**
 * Sequential id allocator over a scene snapshot: hands out exactly the ids repeated
 * `nextId` calls would (each new id becomes the running max), without the caller having
 * to append each clone to the scene between calls - O(parts) once per prefix instead of
 * O(parts) per id, for bulk clone/paste loops.
 */
export function idAllocator(scene: SceneJSON): (type: PartType) => string {
  const next = new Map<string, number>() // keyed by prefix: distinct types may share one
  return (type) => {
    const prefix = `${ID_PREFIXES[type]}_`
    const n = (next.get(prefix) ?? maxIdNum(scene, prefix)) + 1
    next.set(prefix, n)
    return `${prefix}${n}${ID_SUFFIX}`
  }
}

/**
 * "Use" (C key): apply a part's interactive
 * toggle. Returns the part with its action
 * applied, or null when the type has no use action, so callers can skip it
 * (the "does this part have a use action" check).
 */
export function usePart(part: PartInstance): PartInstance | null {
  // 'building' has no whole-part use: dock-door leaves are toggled individually in pilot mode
  // (store.toggleWalkDoorLeaf, walk-session state rather than an edit), a per-leaf use action.
  // C-interaction: a custom part whose package declares `interactive` is usable. The use is not a param change
  // (the behavior handles it in the sim via ctx.used()), so return the part unchanged as the "usable" marker;
  // the controller routes the click to the worker (sim.usePart), not a scene commit.
  if (part.type === 'part') return getPackage(part.packageId)?.interactive ? part : null
  return null
}

/**
 * Whether the pilot (first-person operator) can Use `part` from the crosshair.
 * The pilot models a person on the plant floor, so only hand-operable devices
 * qualify: a part opts in via its package's `interactive` flag - the author's
 * declaration that the part is meant to be used in person. (Indicators and
 * PLC-driven actuators don't set the flag: an operator can't hand-cycle
 * them, and a running PLC would overwrite the toggle within a scan anyway.)
 * Dock-door leaves have their own pilot path.
 */
export function pilotUsable(part: PartInstance): boolean {
  if (part.type !== 'part') return false
  return getPackage(part.packageId)?.interactive === true
}

/**
 * Per-part sanitization, factored out of {@link validateScene} for reuse on data that
 * skipped import validation - chiefly live collaborative (Yjs) edits, which never pass
 * through validateScene. Clamps every param to its ParamSpec (numbers to [min,max], enums
 * to a listed option, colours to a valid hex, lists to their element rules), coerces the
 * transform to finite numbers, and fills missing params with their defaults. Structure
 * (id/type/uniqueness/one-building) is the caller's job; this only sanitizes a single,
 * already-typed part's fields. Returns a fresh part.
 */
export function normalizePart(part: PartInstance): PartInstance {
  const src = part.params as unknown as Record<string, unknown>
  // Custom parts resolve their specs from the runtime package registry (no scene context here); an
  // unregistered package yields no specs, so params pass through empty rather than crashing.
  let specs = PART_DEFS[part.type].params
  let packageId: string | undefined
  if (part.type === 'part') {
    packageId = (part as SdkPart).packageId
    const pkg = getPackage(packageId)
    specs = pkg ? packageParamSpecs(pkg) : []
  }
  const params: Record<string, ParamValue> = {}
  for (const spec of specs) params[spec.key] = validateParam(spec, src[spec.key])
  // openDoors rides alongside the spec params (see validateScene)
  const openDoors = validateDoorKeys(src.openDoors)
  if (openDoors.length > 0) params.openDoors = openDoors

  const pos = part.position
  const position: [number, number, number] = [
    Array.isArray(pos) && isFiniteNumber(pos[0]) ? pos[0] : 0,
    Array.isArray(pos) && isFiniteNumber(pos[1]) ? pos[1] : 0,
    Array.isArray(pos) && isFiniteNumber(pos[2]) ? pos[2] : 0,
  ]
  const out: Record<string, unknown> = {
    id: part.id,
    type: part.type,
    ...(packageId !== undefined ? { packageId } : {}),
    position,
    rotationY: isFiniteNumber(part.rotationY) ? part.rotationY : 0,
    params,
  }
  if (typeof part.name === 'string' && part.name !== '') out.name = part.name
  if (part.visible === false) out.visible = false
  if (part.locked === true) out.locked = true
  if (part.grouped === true) out.grouped = true
  if (typeof part.parent === 'string' && part.parent !== '') out.parent = part.parent
  if (isFiniteNumber(part.rotationX) && part.rotationX !== 0) out.rotationX = part.rotationX
  if (isFiniteNumber(part.rotationZ) && part.rotationZ !== 0) out.rotationZ = part.rotationZ
  return out as unknown as PartInstance
}

/**
 * Structural validation of untrusted JSON: unique non-empty ids, known types,
 * finite numbers, params validated per ParamSpec kind (numbers clamped,
 * booleans strict, enums must be a listed option). v1 documents do not migrate:
 * their roller_conveyor/box_spawner types are not built-in types any more (they
 * are SDK parts), so their parts fail the known-type check.
 * Pre-v4 scenes migrate ('custom' -> 'part' rename, conveyor tail-origin shift);
 * version becomes the current SCENE_VERSION. At most one building per scene.
 * Unknown extra fields are dropped; the returned scene is a fresh deep copy.
 *
 * `runsAsEmbedded` names the packages whose embedded copy is the one that runs (a project's parts: the project's
 * own copy of a part, pinned at its version), so their parts' params are checked against that copy and never against
 * whatever the registry holds under the id.
 */
export function validateScene(data: unknown, runsAsEmbedded: ReadonlySet<string> = new Set()): ValidationResult {
  const errors: string[] = []
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['scene must be a JSON object'] }
  }
  const root = data as Record<string, unknown>
  // pre-v3 scenes store conveyor positions at the bed centre; v3 puts the origin at
  // the tail (tail-origin convention), so v1/v2 conveyor positions need shifting (see below).
  const needsOriginMigration = root.version === 1 || root.version === 2
  // v4 names the generic SDK-part discriminant 'part' (see SCENE_VERSION). A pre-v4 scene (v1/v2/v3) stores
  // `type:"custom"`, which is not a known type, so it is rewritten to 'part' below, before the known-type check,
  // and older saved/shared scenes still load.
  const needsPartRename = root.version === 1 || root.version === 2 || root.version === 3
  if (root.version !== 1 && root.version !== 2 && root.version !== 3 && root.version !== SCENE_VERSION) {
    errors.push(`version must be 1, 2, 3, or ${SCENE_VERSION}`)
  }
  const rawParts = root.parts
  if (!Array.isArray(rawParts)) {
    errors.push('parts must be an array')
    return { ok: false, errors }
  }
  // Embedded custom-part packages (optional): validate each and index its editable specs by id, so a
  // part's params can be clamped against its package schema just like a static type's PART_DEFS.
  const packages: PartPackage[] = []
  const packageSpecs = new Map<string, ParamSpec[]>()
  const rawPackages = Array.isArray(root.packages) ? root.packages : []
  const repairs: string[] = []
  rawPackages.forEach((stored: unknown, i: number) => {
    const { pkg: rawPkg, repairs: fixed } = upgradeStoredPackage(stored)
    for (const r of fixed) repairs.push(`packages[${i}]: ${r}`)
    const problems = validatePartPackage(rawPkg)
    if (problems.length > 0) {
      errors.push(`packages[${i}]: ${problems.map((p) => `${p.field} ${p.message}`).join('; ')}`)
      return
    }
    const pkg = rawPkg as PartPackage
    if (packageSpecs.has(pkg.id)) {
      errors.push(`packages[${i}].id "${pkg.id}" is a duplicate`)
      return
    }
    packages.push(pkg)
    // A built-in part is checked against the schema that will run it. The copy a scene embeds is a snapshot of
    // whatever build saved it, and it never runs (partRegistry `registerScenePackages`: the local copy of a
    // built-in is always used). Checking params against the embedded copy would drop every key a newer built-in
    // has gained, so a tag written into a scene file for a param added since the save would vanish on load. Where
    // there is no registry (a headless check), the embedded copy is all there is, and it is used. A project's own
    // copy (runsAsEmbedded) is what runs, even when the app has a newer version of the part.
    const live = !runsAsEmbedded.has(pkg.id) && isAuthoritativePackage(pkg.id) ? getPackage(pkg.id) : undefined
    packageSpecs.set(pkg.id, packageParamSpecs(live ?? pkg))
  })

  const seenIds = new Set<string>()
  const parts: PartInstance[] = []
  let buildingCount = 0
  rawParts.forEach((raw: unknown, i: number) => {
    const at = `parts[${i}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`${at} must be an object`)
      return
    }
    const part = raw as Record<string, unknown>
    let valid = true

    const id = part.id
    if (typeof id !== 'string' || id === '') {
      errors.push(`${at}.id must be a non-empty string`)
      valid = false
    } else if (seenIds.has(id)) {
      errors.push(`${at}.id "${id}" is a duplicate`)
      valid = false
    } else {
      seenIds.add(id)
    }

    const rawType = part.type
    // v4 migration: a pre-v4 scene's 'custom' part becomes 'part' (see needsPartRename) before the known-type
    // check, so older scenes load. A v4 scene already stores 'part'.
    const type = needsPartRename && rawType === 'custom' ? 'part' : rawType
    if (typeof type !== 'string' || !(type in PART_DEFS)) {
      errors.push(`${at}.type is not a known part type`)
      return
    }
    if (type === 'building' && ++buildingCount > 1) {
      errors.push(`${at}: only one building allowed`)
      return
    }
    const def = PART_DEFS[type as PartType]

    // SDK parts are package-driven: resolve the editable specs from the referenced package (which
    // must be embedded) rather than the empty static PART_DEFS['part'].params.
    let specs: ParamSpec[] = def.params
    let packageId: string | undefined
    if (type === 'part') {
      const pid = part.packageId
      if (typeof pid !== 'string' || !packageSpecs.has(pid)) {
        errors.push(`${at}.packageId ${typeof pid === 'string' ? `"${pid}" ` : ''}is not an embedded part package (a scene carries a copy of every package it places, in its "packages")`)
        return
      }
      packageId = pid
      specs = packageSpecs.get(pid)!
    }

    const name = typeof part.name === 'string' && part.name !== '' ? part.name : undefined
    const hidden = part.visible === false
    const locked = part.locked === true
    const grouped = part.grouped === true
    const parent = typeof part.parent === 'string' && part.parent !== '' ? part.parent : undefined
    // PLC tag scope (a cell-namespace prefix on a group's tags) is retired: a part's tags are the names
    // its tag params say, and a program binds them by wiring. A document that set one gets a repair report,
    // because without the prefix its copies of a cell share the same tags.
    if (typeof part.tagScope === 'string' && part.tagScope !== '') {
      repairs.push(`${at}${name !== undefined ? ` (${name})` : ''}.tagScope "${part.tagScope}" is retired, so the tags below it are no longer prefixed with it`)
    }

    // A document saved with linked assemblies carries masterId / instanceId / masterKey / overrides on the
    // parts of each placed copy. Linking is retired, and those fields are dropped here like any other unknown
    // field. Every placed copy is a full, world-space set of parts, so dropping the link changes nothing on
    // screen. See docs/scene-composition.md.

    const rawPos = part.position
    let position: [number, number, number] | null = null
    if (Array.isArray(rawPos) && rawPos.length === 3 && rawPos.every(isFiniteNumber)) {
      position = [rawPos[0]!, rawPos[1]!, rawPos[2]!]
    } else {
      errors.push(`${at}.position must be 3 finite numbers`)
      valid = false
    }

    const rotationY = part.rotationY
    if (!isFiniteNumber(rotationY)) {
      errors.push(`${at}.rotationY must be a finite number`)
      valid = false
    }
    // optional tilt (YXZ Euler); absent = flat. Validated only when present.
    const rotationX = part.rotationX
    const rotationZ = part.rotationZ
    if (rotationX !== undefined && !isFiniteNumber(rotationX)) {
      errors.push(`${at}.rotationX must be a finite number`)
      valid = false
    }
    if (rotationZ !== undefined && !isFiniteNumber(rotationZ)) {
      errors.push(`${at}.rotationZ must be a finite number`)
      valid = false
    }

    const rawParams =
      typeof part.params === 'object' && part.params !== null && !Array.isArray(part.params)
        ? (part.params as Record<string, unknown>)
        : {}
    const params: Record<string, ParamValue> = {}
    const who = `${at}${name !== undefined ? ` (${name})` : ''}.params`
    for (const spec of specs) {
      params[spec.key] = validateParam(spec, rawParams[spec.key])
      const repair = paramRepair(spec, rawParams[spec.key], params[spec.key]!)
      if (repair) repairs.push(`${who}.${spec.key}: ${repair}`)
    }
    // a key no spec names is dropped: most often a typo (`lenght`), which would otherwise leave the part at
    // its default while the file says otherwise
    const known = new Set(specs.map((s) => s.key))
    for (const key of Object.keys(rawParams)) {
      if (!known.has(key) && key !== 'openDoors') repairs.push(`${who}.${key} is not a parameter of ${packageId ?? type}, so it is dropped`)
    }
    // Per-leaf dock-door open state is runtime state toggled in pilot mode, not a
    // configured param (no PART_DEFS entry / inspector control), so the spec loop
    // above doesn't carry it. Preserve it explicitly so a reopened scene keeps its
    // open doors; only buildings ever set it, so this is a no-op elsewhere.
    const openDoors = validateDoorKeys(rawParams.openDoors)
    if (openDoors.length > 0) params.openDoors = openDoors

    if (valid && position !== null && typeof id === 'string' && isFiniteNumber(rotationY)) {
      parts.push({
        id,
        ...(name !== undefined ? { name } : {}),
        ...(hidden ? { visible: false } : {}),
        ...(locked ? { locked: true } : {}),
        ...(grouped ? { grouped: true } : {}),
        ...(parent !== undefined ? { parent } : {}),
        type: type as PartType,
        ...(packageId !== undefined ? { packageId } : {}),
        position,
        rotationY,
        ...(isFiniteNumber(rotationX) && rotationX !== 0 ? { rotationX } : {}),
        ...(isFiniteNumber(rotationZ) && rotationZ !== 0 ? { rotationZ } : {}),
        params,
      } as unknown as PartInstance)
    }
  })
  if (errors.length > 0) return { ok: false, errors }
  if (needsOriginMigration) migrateConveyorOriginsToTail(parts)
  // a bundled PLC program (optional): accepted only as a string; a malformed value is
  // ignored rather than rejected, matching the lenient drop-unknown-fields handling above
  const stProgram = typeof root.stProgram === 'string' ? root.stProgram : undefined
  if (root.stProgram !== undefined && stProgram === undefined) repairs.push('stProgram is not a string, so it is ignored')
  const stScanMs = typeof root.stScanMs === 'number' && Number.isFinite(root.stScanMs) ? root.stScanMs : undefined
  // the program's controller table rides with it too, but unlike the program it is checked, and a
  // malformed one refuses the file: dropping a task in silence would change what the program does
  let controller: Controller | undefined
  if (root.controller !== undefined) {
    const checked = validateController(root.controller)
    if (!checked.ok) return { ok: false, errors: checked.errors }
    controller = checked.controller
  }
  if (controller !== undefined && stProgram === undefined) repairs.push('controller is ignored: the file has no stProgram for it to run')
  // the program's dialect: a malformed one refuses the file like a malformed table, but one this build does not know
  // is not malformed, only unrunnable, and is kept as written so saving the file again cannot turn it into IEC
  const dialect = validateDialect(root.stDialect)
  if (!dialect.ok) return { ok: false, errors: dialect.errors }
  // (kept without a program too, like any other marker - core/dialect.ts)
  const stDialect = dialect.dialect
  // the scene's physics step rate: clamped rather than refused, like a project's (core/project/project.ts)
  const simHz = toSimRate(root.simHz)
  if (root.simHz !== undefined && root.simHz !== simHz) {
    repairs.push(`simHz ${JSON.stringify(root.simHz)} is not a whole number from ${MIN_SIM_HZ} to ${MAX_SIM_HZ}, so the scene steps at ${simHz} Hz`)
  }
  // the scene's Units and Length (SceneJSON.units, .lengthUnit): absent = metric, each field in its own unit
  // (core/scene/sceneUnits.ts); anything else is dropped, and said
  const { units, lengthUnit } = readSavedUnits(root.units, root.lengthUnit)
  if (root.units !== undefined && units === undefined) repairs.push(`units ${JSON.stringify(root.units)} is not "imperial" or "metric", so the scene is metric`)
  if (root.lengthUnit !== undefined && root.lengthUnit !== lengthUnit) repairs.push(`lengthUnit ${JSON.stringify(root.lengthUnit)} is not "m", "mm" or "in", so each length shows in its own unit`)
  // the scene's controllers (SceneJSON.plcs): an entry that cannot be read is dropped, and said
  const plcs = validateScenePlcs(root.plcs, repairs)
  // the values its displays show (SceneJSON.display): names only, each once
  const display = readDisplayList(root.display, repairs)
  // a stair an older app seated by its own top landing moves in onto the deck edge it met (core/stairReseat.ts)
  for (const i of reseatOlderStairs(parts, runsAsEmbedded)) {
    repairs.push(`parts[${i}]${parts[i]!.name ? ` (${parts[i]!.name})` : ''} stood by its own top landing, which the deck it reaches now replaces, so it moves ${STAIRS_LANDING_DEPTH} m onto the deck edge`)
  }
  // drop dangling/cyclic parent refs so a stale or hand-edited scene loads as a valid tree
  const sanitized = sanitizeParents(parts)
  sanitized.forEach((p, i) => {
    const was = parts[i]!.parent
    if (was !== undefined && p.parent === undefined) {
      repairs.push(`parts[${i}]${parts[i]!.name ? ` (${parts[i]!.name})` : ''}.parent "${was}" ${parts.some((q) => q.id === was) ? 'would make a cycle' : 'names no part'}, so it is dropped`)
    }
  })
  return {
    ok: true,
    scene: {
      version: SCENE_VERSION,
      parts: sanitized,
      ...(packages.length > 0 ? { packages } : {}),
      ...sceneSettings({ units, lengthUnit, plcs, display }),
    },
    ...(stProgram !== undefined ? { stProgram } : {}),
    ...(stScanMs !== undefined ? { stScanMs } : {}),
    ...(controller !== undefined && stProgram !== undefined ? { controller } : {}),
    ...(stDialect !== undefined ? { stDialect } : {}),
    ...(simHz !== DEFAULT_SIM_HZ ? { simHz } : {}),
    ...(repairs.length > 0 ? { repairs } : {}),
  }
}

/**
 * In-place v1/v2 -> v3 migration: pre-v3 stores a straight conveyor's position at the
 * bed centre; v3 anchors it at the tail (origin at the start of
 * segment 0). Shift each position back along the part's local +X by the tail->centre
 * distance so the geometry stays exactly where it was in the world. Curved/turntable
 * conveyors already used an arc-/plate-centre origin, so they're untouched.
 */
function migrateConveyorOriginsToTail(parts: PartInstance[]): void {
  for (const part of parts) {
    const shift = conveyorCenterOffsetX(part)
    if (shift === 0) continue
    // forwardXZ(yaw): local +X -> world (cos, -sin); new = old - shift * forwardXZ(yaw)
    const c = Math.cos(part.rotationY)
    const s = Math.sin(part.rotationY)
    part.position[0] -= shift * c
    part.position[2] += shift * s
  }
}

/**
 * The parts as a saved document writes them: stable key order (id, name?, visible?, locked?, grouped?, parent?, type,
 * packageId?, position, rotationY, rotationX?, rotationZ?, params), and every param its spec declares, filled from the
 * spec's default when the part leaves it out. SDK parts are package-driven: their params come from the referenced
 * package's schema, not the (empty) static PART_DEFS.part.params, so `packages` are indexed by id, falling back to the
 * runtime registry so a part still round-trips its params when its package is absent. Mirrors validateScene, which
 * resolves the same specs on the way back in. Shared by serializeScene and serializeProject, which stringify it.
 */
export function savedParts(parts: readonly PartInstance[], packages: readonly PartPackage[] | undefined): object[] {
  const pkgSpecs = new Map<string, ParamSpec[]>()
  for (const pkg of packages ?? []) pkgSpecs.set(pkg.id, packageParamSpecs(pkg))
  const specsFor = (part: PartInstance): ParamSpec[] => {
    if (part.type !== 'part') return PART_DEFS[part.type].params
    const pid = (part as SdkPart).packageId
    const embedded = pkgSpecs.get(pid)
    if (embedded) return embedded
    const pkg = getPackage(pid)
    return pkg ? packageParamSpecs(pkg) : []
  }
  return parts.map((part) => {
    const src = part.params as unknown as Record<string, ParamValue>
    const params: Record<string, ParamValue> = {}
    for (const spec of specsFor(part)) {
      params[spec.key] = src[spec.key] ?? (spec.kind === 'boolean' ? (spec.whenAbsent ?? spec.default) : spec.default)
    }
    // round-trip the per-leaf dock-door open state (see validateScene): not a
    // PART_DEFS param, so emit it alongside the spec params when present
    const openDoors = src.openDoors
    if (Array.isArray(openDoors) && openDoors.length > 0)
      params.openDoors = openDoors.filter((k): k is string => typeof k === 'string')
    return {
      id: part.id,
      ...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}),
      ...(part.visible === false ? { visible: false } : {}),
      ...(part.locked === true ? { locked: true } : {}),
      ...(part.grouped === true ? { grouped: true } : {}),
      ...(typeof part.parent === 'string' && part.parent !== '' ? { parent: part.parent } : {}),
      type: part.type,
      ...(part.type === 'part' ? { packageId: (part as SdkPart).packageId } : {}),
      position: part.position,
      rotationY: part.rotationY,
      ...(part.rotationX ? { rotationX: part.rotationX } : {}),
      ...(part.rotationZ ? { rotationZ: part.rotationZ } : {}),
      params,
    }
  })
}

/**
 * A scene file: its parts ({@link savedParts}), 2-space indent, trailing newline.
 *
 * A non-empty `stProgram` is appended as a top-level field so a shared/exported scene
 * carries its PLC control logic, not just the layout. Empty/undefined is omitted (no
 * program to bundle), and validateScene then leaves an importer's program untouched.
 * `stScanMs` (the program's authored cycle time) rides with it, and only with it - a scan
 * time without a program is meaningless, so it is omitted whenever the program is.
 */
export function serializeScene(
  scene: SceneJSON,
  stProgram?: string,
  stScanMs?: number,
  /** `pretty: false` drops the indentation. It is for the browser autosave, which no human reads and which
   *  handles every space twice (once building the string, once writing it). Indentation doubles this
   *  payload: 228 KB of demo scene becomes 461 KB of text. Files a user can open keep the indent. */
  opts?: { pretty?: boolean },
  /** the program's controller table (core/controller.ts): written with the program, and only with it */
  controller?: Controller | null,
  /** the program's dialect (core/dialect.ts): written only when it is not IEC, with or without a program */
  stDialect?: string | null,
  /** the scene's physics step rate: written only when it is not DEFAULT_SIM_HZ, with or without a program */
  simHz?: SimRate,
): string {
  const dialect = storedDialect(stDialect)
  const hz = toSimRate(simHz)
  const parts = savedParts(scene.parts, scene.packages)
  return (
    JSON.stringify(
      {
        version: scene.version,
        parts,
        // embed custom-part packages so the scene is self-contained: validateScene requires every custom
        // part's package to be present on the way back in (else the part - and the whole scene - is rejected).
        // the scene's Units and its controllers (SceneJSON.units, .plcs) are part of the document, like its parts
        ...sceneSettings(scene),
        ...(scene.packages && scene.packages.length > 0 ? { packages: scene.packages } : {}),
        ...(typeof stProgram === 'string' && stProgram !== ''
          ? {
              stProgram,
              ...(typeof stScanMs === 'number' && Number.isFinite(stScanMs) ? { stScanMs } : {}),
              ...(controller ? { controller } : {}),
            }
          : {}),
        ...(dialect !== undefined ? { stDialect: dialect } : {}),
        ...(hz !== DEFAULT_SIM_HZ ? { simHz: hz } : {}),
      },
      null,
      opts?.pretty === false ? undefined : 2,
    ) + '\n'
  )
}

export function cloneScene(scene: SceneJSON): SceneJSON {
  return {
    version: scene.version,
    parts: scene.parts.map(
      (p) =>
        ({
          ...p,
          position: [p.position[0], p.position[1], p.position[2]],
          params: { ...p.params },
        }) as PartInstance,
    ),
    // carry the embedded custom-part packages so a cloned scene stays self-contained (a clone that
    // dropped them would leave any custom part referencing an absent package)
    ...(scene.packages ? { packages: scene.packages } : {}),
  }
}

export function emptyScene(): SceneJSON {
  return { version: SCENE_VERSION, parts: [] }
}

/**
 * What a person starting from nothing gets: just the {@link defaultBuilding}, as a real node in the
 * scene tree. Every "blank" entry point opens this one (first boot, New, a new project, a new scene
 * tab), not {@link emptyScene}, where the viewport's non-content backdrop draws the same warehouse
 * with nothing in the tree to select, hide or resize.
 */
export function blankScene(): SceneJSON {
  return { version: SCENE_VERSION, parts: [defaultBuilding()] }
}
