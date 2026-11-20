// The agent tools: what an AI agent may do to the open editor, as one list with one definition per tool
// (docs/agent-tools.md). The desktop shell serves this list over MCP (apps/desktop/mcpServer.cjs), so any MCP client
// the user already runs can look at the scene, author it, run it and
// test it. Nothing here knows about MCP or IPC: a tool is a name, a description, a JSON Schema for its input and a
// handler over the store and controller. A second door (a browser panel, a CLI) renders the same list. The scene,
// program and test tools are here; part definitions, the program by POU, and seeing the scene are in partTools.ts,
// programTools.ts and viewTools.ts.
//
// Three rules make an agent's edits the same kind of edit a person makes:
//   - every authoring tool writes through the store's own paths (commit, commitProgram, rename), so the edit gate
//     decides what is an edit, and each call is one undo step labelled "Agent: ..." in the History dock;
//   - operating (run, stop, write a tag) never writes the document, as for a person (docs/document-and-run.md);
//   - "done" is a passing test: run_test runs a project test spec on the in-app runner the Tests overlay uses.
//
// A lazy chunk: only desktopAgent.ts imports it, and only once the shell says an agent host exists.

import { subtreeIds } from '../../core/scene/hierarchy'
import { uniqueSiblingName } from '../../core/parts/partDisplayName'
import { partFootprint, toWorldXZ } from '../../core/parts/partGeometry'
import { findSnap } from '../../core/snap/snapFeatures'
import { commitSnap, snapAttaches } from '../../core/snap/snapCommit'
import { getPackage } from '../../core/parts/partRegistry'
import { createSdkPart, defaultBuilding, nextId } from '../../core/scene/scene'
import { dockDoors, editBuildingParams, perimeterSides } from '../../core/building/buildingEdit'
import { validateTestSpec, type TestSpec } from '../../core/project/projectTest'
import { AGENT_GUIDE, projectToFolderFiles } from '../../core/project/projectFolder'
import type { PartPackage } from '../../core/parts/partPackage'
import type { ParamSpec } from '../../core/parts/partApi'
import type { BuildingPart, PartInstance, SceneJSON, SdkPart } from '../../core/types'
import { controllerFor, runnableSource } from '../../plc/controller'
import { defaultController, setTaskTiming } from '../../plc'
import { isKnownDialect } from '../../core/dialect'
import { LocalPlcLink } from '../../plc/link/plcLink'
import { wiredBindings } from '../../plc/wiring'
import { commitControllerEdit } from '../program/controllerCommit'
import { planTagRename, testsNamingTag } from '../program/tagRename'
import { assignIo, importIoList, ioListCsv, ioTargetFor, reportSummary } from '../program/ioAssign'
import type { EditorStore } from '../store/store'
import type { ProjectTestRun } from '../project/projectTestsRun'
import { catalogFrame } from '../../core/parts/partCatalog'
import { FOLDER_OPTIONS } from '../project/folderOptions'
import {
  AGENT_LABEL,
  AgentImageResult,
  AgentToolError,
  agentResultText,
  assertEditable,
  catalogPackages,
  findPart,
  knownPackages,
  needController,
  optNum,
  optObj,
  optStr,
  optVec3,
  round,
  str,
  strList,
  problems,
  type AgentTool,
  type AgentToolContext,
  type JsonSchema,
} from './toolKit'
import { checkPart, createPart, editPartDefinition, getPartSdk, getPartSource, importModel } from './partTools'
import { getRobotPose, importRobot, solveRobotPose } from './robotAgentTools'
import { installLibraryPart, listLibraryParts } from './libraryTools'
import { installShelfPart, listShelfParts, putPartOnShelf } from './shelfTools'
import { checkProgram, getPou, listPous, setPou, traceTags } from './programTools'
import { CARGO_LIST_MAX, captureView, deleteTest, duplicatePartsTool, getCargo, undoTool } from './viewTools'
import { pauseTool, resumeTool, stepTool } from './simTools'
import { getContext, syncFolder } from './contextTools'
import { assignControllerTool, listControllers, runInstanceOnTool, setControllerTool } from './controllerTools'

export { AGENT_LABEL, AgentImageResult, AgentToolError, agentResultText }
export type { AgentController, AgentImage, AgentShell, AgentTool, AgentToolContext, JsonSchema } from './toolKit'

/** A param declaration as the agent needs it: type, default, range, and for a tag its direction and ST type. */
function describeParam(spec: ParamSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { type: spec.type }
  for (const k of ['label', 'desc', 'default', 'min', 'max', 'unit', 'dir', 'stType', 'rest'] as const) {
    const v = spec[k]
    if (v !== undefined) out[k] = v
  }
  if (spec.options) out.options = spec.options.map((o) => o.value)
  // what each number a tag publishes means (a colour sensor's 1 = red)
  if (Array.isArray(spec.values)) out.values = spec.values.map((v) => ({ value: v.value, label: v.label }))
  return out
}

function visibleParams(pkg: PartPackage): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, spec] of Object.entries(pkg.params ?? {})) if (!spec.hidden) out[key] = describeParam(spec)
  return out
}

/** The PLC tags a part is wired to: its `tag`-typed params that hold a name. */
function wiredTags(part: PartInstance, pkg: PartPackage | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!pkg || part.type !== 'part') return out
  for (const [key, spec] of Object.entries(pkg.params ?? {})) {
    const v = (part as SdkPart).params[key]
    if (spec.type === 'tag' && typeof v === 'string' && v !== '') out[key] = v
  }
  return out
}

/**
 * Check `patch` against the package's declared params and return it cleaned. An unknown key, a value of the wrong
 * type, or a number outside [min, max] is refused with the reason, rather than written and discovered at Play.
 */
function checkedParams(pkg: PartPackage, patch: Record<string, unknown>): Record<string, unknown> {
  const specs = pkg.params ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const spec = specs[key]
    if (!spec) throw new AgentToolError(`'${pkg.id}' has no param '${key}' (it has: ${Object.keys(specs).join(', ') || 'none'})`)
    switch (spec.type) {
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new AgentToolError(`param '${key}' is a number`)
        if (spec.min !== undefined && value < spec.min) throw new AgentToolError(`param '${key}' must be >= ${spec.min}`)
        if (spec.max !== undefined && value > spec.max) throw new AgentToolError(`param '${key}' must be <= ${spec.max}`)
        break
      }
      case 'boolean':
        if (typeof value !== 'boolean') throw new AgentToolError(`param '${key}' is a boolean`)
        break
      case 'enum': {
        const allowed = (spec.options ?? []).map((o) => o.value)
        if (typeof value !== 'string' || !allowed.includes(value)) throw new AgentToolError(`param '${key}' must be one of: ${allowed.map((a) => JSON.stringify(a)).join(', ')}`)
        break
      }
      case 'numberList':
        if (!Array.isArray(value) || !value.every((row) => Array.isArray(row) && row.every((n) => typeof n === 'number'))) {
          throw new AgentToolError(`param '${key}' is a list of number rows, e.g. [[1, 0]]`)
        }
        break
      default:
        // string, tag, color, partRef
        if (typeof value !== 'string') throw new AgentToolError(`param '${key}' is a string`)
    }
    out[key] = value
  }
  return out
}

// ── the tools ───────────────────────────────────────────────────────────────────────────────────────

const getGuide: AgentTool = {
  name: 'get_guide',
  description:
    'Read the project guide: units and conventions, the tags this scene wires and which way each flows, the parts ' +
    'placed, what the ST dialect allows, the test spec format, and which tool does what. Derived from the open ' +
    "document, like the AGENTS.md a saved project folder carries, but written for these tools. Read it first.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: ({ store }) => {
    const guide = projectToFolderFiles(store.snapshotProject(), { ...FOLDER_OPTIONS, guideDoor: 'tools' }).find((f) => f.path === AGENT_GUIDE)
    return guide?.contents ?? ''
  },
}

/** get_scene lists at most this many parts: a large scene came to 79k characters, more than a client takes in one result */
const SCENE_LIST_MAX = 200

const getScene: AgentTool = {
  name: 'get_scene',
  description:
    'List the open scene: every part with its id, name, package, position [x,y,z] in metres (+Y up), rotationY in ' +
    'radians, parent, and the PLC tags it is wired to. Also whether the simulation is running. A large scene lists ' +
    `its first ${SCENE_LIST_MAX} parts, says how many it left out and counts every part by package: narrow it with ` +
    '`package` (a package id or type), `within` (a box { min:[x,y,z], max:[x,y,z] } the part\'s origin is inside) or ' +
    '`parent` (the children of one part).',
  inputSchema: {
    type: 'object',
    properties: {
      package: { type: 'string', description: 'only parts of this package id (or type, for a group or a building)' },
      within: { type: 'object', description: '{ min: [x,y,z], max: [x,y,z] } in metres' },
      parent: { type: 'string', description: 'only the children of this part id' },
    },
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    const s = store.getState()
    const pkgWanted = optStr(args, 'package')
    const parent = optStr(args, 'parent')
    const within = optObj(args, 'within')
    const min = within ? optVec3(within, 'min') : undefined
    const max = within ? optVec3(within, 'max') : undefined
    if (within && (!min || !max)) throw new AgentToolError("'within' needs min and max, each [x, y, z]")
    const kindOf = (p: PartInstance): string => (p.type === 'part' ? (p as SdkPart).packageId : p.type)
    const matched = s.scene.parts.filter(
      (p) =>
        (pkgWanted === undefined || kindOf(p) === pkgWanted) &&
        (parent === undefined || p.parent === parent) &&
        (!min || !max || p.position.every((v, k) => v >= min[k]! && v <= max[k]!)),
    )
    const shown = matched.slice(0, SCENE_LIST_MAX)
    const byPackage: Record<string, number> = {}
    if (shown.length < matched.length) for (const p of matched) byPackage[kindOf(p)] = (byPackage[kindOf(p)] ?? 0) + 1
    return {
      project: s.projectName,
      running: s.running,
      ...(matched.length < s.scene.parts.length ? { sceneParts: s.scene.parts.length } : {}),
      parts: shown.map((p) => {
        const pkg = p.type === 'part' ? getPackage((p as SdkPart).packageId) : undefined
        const tags = wiredTags(p, pkg)
        return {
          id: p.id,
          ...(p.name ? { name: p.name } : {}),
          ...(p.type === 'part' ? { package: (p as SdkPart).packageId } : { type: p.type }),
          position: p.position.map(round),
          rotationY: round(p.rotationY),
          ...(p.parent ? { parent: p.parent } : {}),
          ...(Object.keys(tags).length > 0 ? { tags } : {}),
        }
      }),
      ...(shown.length < matched.length ? { omitted: matched.length - shown.length, byPackage } : {}),
    }
  },
}

const getPart: AgentTool = {
  name: 'get_part',
  description:
    "Read one part in full: its pose, every param value, and its package's param declarations (type, default, range, tag direction). " +
    "For the building: which perimeter cells each wall holds (what a wall rule's `start` counts) and every dock door with the key `openDoors` names.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'part id, from get_scene' } },
    required: ['id'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    const part = findPart(store.getState().scene, str(args, 'id'))
    if (part.type === 'building') {
      const b = part as BuildingPart
      return { part, perimeter: perimeterSides(b.params.lengthSections, b.params.widthSections), dockDoors: dockDoors(b) }
    }
    const pkg = part.type === 'part' ? getPackage((part as SdkPart).packageId) : undefined
    return { part, ...(pkg ? { params: visibleParams(pkg) } : {}) }
  },
}

// The list stays short. Every param of every part is ~126k characters, more than a client takes in one result,
// and an agent then spends most of its run reading it back out of a spill file. So the list holds what picking a
// part needs, and get_package holds what using one needs.
const listCatalog: AgentTool = {
  name: 'list_catalog',
  description:
    'List the parts that can be placed: package id, name, category, and its PLC tag params (in = the PLC drives ' +
    'the part, out = the part reports to the PLC). Optional text filter. get_package has one part\'s full params.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'case-insensitive filter on id, name or category' } },
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    const q = optStr(args, 'query')?.toLowerCase()
    return catalogPackages(store)
      .filter((p) => !q || [p.id, p.name, p.category ?? ''].some((s) => s.toLowerCase().includes(q)))
      .map((p) => {
        const tags = Object.entries(p.params ?? {})
          .filter(([, spec]) => spec.type === 'tag' && !spec.hidden)
          .map(([key, spec]) => `${key} (${spec.dir ?? 'in'}${spec.stType ? ` ${spec.stType}` : ''})`)
        return { id: p.id, name: p.name, ...(p.category ? { category: p.category } : {}), ...(tags.length > 0 ? { tags } : {}) }
      })
  },
}

const getPackageTool: AgentTool = {
  name: 'get_package',
  description:
    'Read one catalog part in full: every param with its type, default, range, unit and, for a tag, its direction, ' +
    "ST type and what each value means (`values`). `frame` gives the part's own frame at its defaults: footprint " +
    'extents, where the origin sits, conveying ends, detection zones and sensor beams, all part-local in metres.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'package id from list_catalog' } },
    required: ['id'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    const id = str(args, 'id')
    const pkg = knownPackages(store).find((p) => p.id === id) ?? getPackage(id)
    if (!pkg) throw new AgentToolError(`no package '${id}' (list_catalog lists them)`)
    let frame: Record<string, unknown>
    try {
      frame = { frame: catalogFrame(pkg) }
    } catch (e) {
      frame = { frameError: e instanceof Error ? e.message : String(e) }
    }
    return { id: pkg.id, name: pkg.name, ...(pkg.category ? { category: pkg.category } : {}), params: visibleParams(pkg), ...frame }
  },
}

const addPart: AgentTool = {
  name: 'add_part',
  description:
    'Place a part from the catalog. position is [x, y, z] in metres with +Y up; for a conveyor, y is its belt ' +
    'height and a legged stand is sized to reach the floor. rotationY is radians about +Y. params are checked ' +
    'against the package (list_catalog). One undo step. Returns the new part id. package "building" places the ' +
    'warehouse shell (at most one per scene; position is its floor centre); its params are lengthSections, ' +
    'widthSections, heightSections, columnSpacing, rules (wall rules) and openDoors (dock door keys, from get_part).',
  inputSchema: {
    type: 'object',
    properties: {
      package: { type: 'string', description: "package id from list_catalog, e.g. 'oip.belt-conveyor'" },
      position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      rotationY: { type: 'number', description: 'radians about +Y (default 0)' },
      name: { type: 'string' },
      parent: { type: 'string', description: 'id of a part to soft-parent under' },
      params: { type: 'object', description: 'param values to set, by key' },
    },
    required: ['package', 'position'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    assertEditable(store)
    const id = str(args, 'package')
    if (id === 'building') return addBuilding(store, args)
    const pkg = getPackage(id)
    if (!pkg) throw new AgentToolError(`no package '${id}' (list_catalog lists them)`)
    const position = optVec3(args, 'position')!
    const params = checkedParams(pkg, optObj(args, 'params') ?? {})
    const scene = store.getState().scene
    const parent = optStr(args, 'parent')
    if (parent !== undefined) findPart(scene, parent)
    const part = createSdkPart(pkg, nextId(scene, 'part'), position, optNum(args, 'rotationY') ?? 0, { placed: true, units: scene.units })
    // a `rest: 'surfaceBelow'` stand is resolved from the drop in the viewport; here the floor is below, so the
    // stand reaches it from the height the part was given (what add-part --scaffold does too), floored at the
    // 0.1 every other rest path keeps (controller/drag.ts, snapRest.ts)
    for (const [key, spec] of Object.entries(pkg.params ?? {})) {
      if (spec.rest === 'surfaceBelow' && !(key in params) && position[1] > 0) part.params[key] = Math.max(0.1, position[1])
    }
    Object.assign(part.params, params)
    const name = optStr(args, 'name')?.trim()
    const placed: SdkPart = { ...part, ...(name ? { name } : {}), ...(parent ? { parent } : {}) }
    // a scene carries the packages it places (self-contained save and share), as the viewport's drop does
    const packages = scene.packages ?? []
    const next: SceneJSON = {
      ...scene,
      parts: [...scene.parts, placed],
      ...(packages.some((p) => p.id === pkg.id) ? {} : { packages: [...packages, pkg] }),
    }
    store.commit(`${AGENT_LABEL}: place ${pkg.name}`, next)
    return { id: placed.id }
  },
}

const updatePart: AgentTool = {
  name: 'update_part',
  description:
    'Change a part: any of position, rotationY (radians), name, params (checked against its package; a tag param ' +
    'takes the PLC tag name to wire it to, "" unwires it). On the building, params are checked against its own ' +
    'params; openDoors takes the dock door keys get_part lists. One undo step.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      rotationY: { type: 'number' },
      name: { type: 'string' },
      params: { type: 'object' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    assertEditable(store)
    const scene = store.getState().scene
    const part = findPart(scene, str(args, 'id'))
    const position = optVec3(args, 'position')
    const rotationY = optNum(args, 'rotationY')
    const patch = optObj(args, 'params')
    let params: Record<string, unknown> | undefined
    const notes: string[] = []
    if (patch && part.type === 'building') {
      const r = buildingParams(part as BuildingPart, patch)
      // the building's whole params: an edit can drop openDoors
      params = { ...r.params }
      notes.push(...r.notes)
    } else if (patch) {
      if (part.type !== 'part') throw new AgentToolError(`'${part.id}' is a ${part.type}, which has no package params`)
      const pkg = getPackage((part as SdkPart).packageId)
      if (!pkg) throw new AgentToolError(`the package of '${part.id}' is not loaded`)
      params = checkedParams(pkg, patch)
    }
    // a name is made unique among siblings, as the scene tree's rename makes it (storeTree.ts), and "" clears it
    const typed = optStr(args, 'name')?.trim()
    const name = typed === undefined || typed === (part.name ?? '') ? undefined : typed === '' ? '' : uniqueSiblingName(scene.parts, part.parent, typed, part.id)
    if (position || rotationY !== undefined || params || name !== undefined) {
      const next = {
        ...part,
        ...(position ? { position } : {}),
        ...(rotationY !== undefined ? { rotationY } : {}),
        ...(params ? { params: part.type === 'building' ? params : { ...(part as SdkPart).params, ...params } } : {}),
        ...(name ? { name } : {}),
      } as PartInstance
      if (name === '') delete next.name
      // one call, one step: the rename rides the same commit, so the step is the agent's and undo takes it whole
      store.commit(`${AGENT_LABEL}: edit ${part.name ?? part.id}`, { ...scene, parts: scene.parts.map((p) => (p.id === part.id ? next : p)) })
    }
    return { id: part.id, name: store.getState().scene.parts.find((p) => p.id === part.id)?.name ?? null, ...(notes.length > 0 ? { notes } : {}) }
  },
}

/** a building's params with `patch` applied (core/building/buildingEdit.ts), and what it noted */
function buildingParams(part: BuildingPart, patch: Record<string, unknown>): { params: BuildingPart['params']; notes: string[] } {
  const notes: string[] = []
  try {
    return { params: editBuildingParams(part, patch, notes).params, notes }
  } catch (e) {
    throw new AgentToolError((e as Error).message.replace(/^params: /, ''))
  }
}

/** add_part for package 'building': the shell New makes, at most one per scene */
function addBuilding(store: EditorStore, args: Record<string, unknown>): { id: string; notes?: string[] } {
  const scene = store.getState().scene
  const has = scene.parts.find((p) => p.type === 'building')
  if (has) throw new AgentToolError(`the scene already has a building ('${has.id}'); change it with update_part`)
  if (optStr(args, 'parent') !== undefined) throw new AgentToolError('the building cannot be parented')
  const part = defaultBuilding(nextId(scene, 'building'))
  part.position = optVec3(args, 'position')!
  part.rotationY = optNum(args, 'rotationY') ?? 0
  const { params, notes } = buildingParams(part, optObj(args, 'params') ?? {})
  const name = optStr(args, 'name')?.trim()
  const placed = { ...part, params, ...(name ? { name } : {}) } as BuildingPart
  store.commit(`${AGENT_LABEL}: place the building`, { ...scene, parts: [placed, ...scene.parts] })
  return { id: placed.id, ...(notes.length > 0 ? { notes } : {}) }
}

/** The top of a part's footprint, over its centre, in world space: where a person drops a part onto it. */
function topCentre(part: PartInstance): [number, number, number] {
  const fp = partFootprint(part)
  const w = toWorldXZ(part, fp.cx ?? 0, fp.cz ?? 0)
  return [w.x, part.position[1] + fp.y1, w.z]
}

const snapPart: AgentTool = {
  name: 'snap_part',
  description:
    "Seat a part where the editor's snap engine puts it when a person drops it: a conveyor butted to another's end " +
    'or merged into its side, a sensor on a belt guard, a blade stop on a roller bed, a button on a cabinet face. ' +
    'Give `onto` (the host part id) and/or `near` ([x,y,z] where it is dropped; default: the host\'s top centre, or ' +
    'the part\'s own position). The pose, any params the snap fits (e.g. a sensor\'s range across the belt) and a ' +
    'mount\'s parenting are applied as ONE undo step. Use it after add_part instead of guessing a mounting pose.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the part to seat' },
      onto: { type: 'string', description: 'the host part id; default: any part in the scene' },
      near: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      rotationY: { type: 'number', description: 'radians; default the part\'s own. A mount that faces a side may need a quarter turn' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    assertEditable(store)
    const scene = store.getState().scene
    const part = findPart(scene, str(args, 'id'))
    const ontoId = optStr(args, 'onto')
    const host = ontoId !== undefined ? findPart(scene, ontoId) : null
    if (host?.id === part.id) throw new AgentToolError('a part cannot snap onto itself')
    const position = optVec3(args, 'near') ?? (host ? topCentre(host) : part.position)
    const rotationY = optNum(args, 'rotationY') ?? part.rotationY
    // everything but the part and what hangs under it: a part never seats on its own child
    const own = new Set(subtreeIds(scene.parts, [part.id]))
    const others = host ? [host] : scene.parts.filter((p) => !own.has(p.id))
    const moving = { ...part, position, rotationY } as PartInstance
    const c = findSnap(moving, { position, rotationY }, others)
    if (!c) {
      // usually a facing gate fails: say which quarter turn would seat it from the same spot (npm run snap-part)
      const turn = [1, 2, 3].map((k) => rotationY + (k * Math.PI) / 2).find((r) => findSnap({ ...moving, rotationY: r } as PartInstance, { position, rotationY: r }, others))
      const hint = turn !== undefined ? ` It would seat with rotationY ${round(turn)} (a quarter turn: the mount faces the other way).` : ' Try `near` closer to where it should mount, or another host.'
      throw new AgentToolError(`nothing ${host ? `on '${host.id}' ` : ''}engages '${part.id}' from [${position.map(round).join(', ')}].${hint}`)
    }
    // what the editor's drop writes: pose, fits, host fits, attach (core/snap/snapCommit)
    const parent = snapAttaches(scene.parts, part.id, c) ? c.targetId : undefined
    const parts = [...commitSnap(scene.parts, part.id, c)]
    const seated = parts.find((p) => p.id === part.id)!
    const target = scene.parts.find((p) => p.id === c.targetId)
    store.commit(`${AGENT_LABEL}: snap ${part.name ?? part.id} onto ${target?.name ?? c.targetId}`, { ...scene, parts })
    return {
      id: part.id,
      onto: c.targetId,
      ...(c.via ? { via: c.via } : {}),
      ...(c.join ? { join: c.join } : {}),
      position: seated.position.map(round),
      rotationY: round(seated.rotationY),
      ...(c.paramOverrides ? { fits: c.paramOverrides } : {}),
      ...(c.targetParamOverrides ? { hostFits: c.targetParamOverrides } : {}),
      ...(parent ? { parent } : {}),
    }
  },
}

const deleteParts: AgentTool = {
  name: 'delete_parts',
  description: 'Delete parts by id. A part soft-parented under one goes with it. One undo step.',
  inputSchema: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
    required: ['ids'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    assertEditable(store)
    const scene = store.getState().scene
    const ids = strList(args, 'ids')
    for (const id of ids) findPart(scene, id)
    const remove = new Set(subtreeIds(scene.parts, ids))
    store.commit(`${AGENT_LABEL}: delete ${remove.size === 1 ? 'part' : `${remove.size} parts`}`, { ...scene, parts: scene.parts.filter((p) => !remove.has(p.id)) })
    const s = store.getState()
    if (s.selectedIds.some((id) => remove.has(id))) store.selectMany(s.selectedIds.filter((id) => !remove.has(id)))
    return { deleted: [...remove] }
  },
}

const getProgram: AgentTool = {
  name: 'get_program',
  description:
    "Read the scene's PLC program: its source, dialect ('iec': IEC 61131-3 Structured Text/ladder; any other value is a " +
    "dialect this version does not run, kept as it is), scan time in ms, `tasks` (the tasks it runs on, by the names " +
    'set_task takes) and its task table (`controller`, null when it has none). A scene program is bare VAR blocks and statements; its variable names ARE the tags parts wire to. ' +
    'A program that is ONE `PROGRAM X ... END_PROGRAM` and nothing else answers to both `Var` and `X.Var`; with two or ' +
    'more PROGRAMs only `X.Var` binds. The first scan runs after the parts have stepped once, so it reads what they ' +
    'publish (a normally-closed input is TRUE on scan 1).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: ({ store }) => {
    const s = store.getState()
    // the tasks the program runs on: its table's, or the one task a program with no table runs on (what set_task names)
    const tasks = (s.controller ?? defaultController(s.stProgram, s.stScanMs)).tasks
    return { source: s.stProgram, dialect: s.stDialect ?? 'iec', scanMs: s.stScanMs, tasks, controller: s.controller }
  },
}

const setProgram: AgentTool = {
  name: 'set_program',
  description:
    "Replace the scene's PLC program source (same dialect). One undo step. Returns the program problems it has, " +
    'so a compile error comes back at once; get_problems has the full list.',
  inputSchema: {
    type: 'object',
    properties: { source: { type: 'string' } },
    required: ['source'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    const source = args.source
    if (typeof source !== 'string') throw new AgentToolError("'source' must be a string")
    ctx.store.commitProgram(`${AGENT_LABEL}: edit program`, { source })
    const report = problems(ctx)
    return { problems: report.problems.filter((p) => p.group === 'Program') }
  },
}

const renameTagTool: AgentTool = {
  name: 'rename_tag',
  description:
    "Rename a PLC tag: every spelling of it in the program, and every part wired to it, as one undo step. Use this " +
    "rather than set_program, which changes the code but leaves parts wired to the old name. Kept tests are not " +
    'changed; it warns about any that still name the old tag. `pou` names the PROGRAM, ' +
    'FUNCTION_BLOCK or FUNCTION that declares the tag; leave it out for a top-level (controller) tag.',
  inputSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' }, pou: { type: 'string' } },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    const from = str(args, 'from')
    const to = str(args, 'to').trim()
    const s = ctx.store.getState()
    if (!isKnownDialect(s.stDialect)) throw new AgentToolError('this program is in a dialect this version does not run, so its tags cannot be renamed')
    const plan = planTagRename(s.scene, s.stProgram, s.controller ?? null, s.stScanMs, optStr(args, 'pou') ?? '', from, to)
    if (plan.error !== null) throw new AgentToolError(plan.error)
    ctx.store.commitProgram(`${AGENT_LABEL}: rename ${from} to ${to}`, { source: plan.source }, plan.scene ? { scene: plan.scene } : undefined)
    const stale = testsNamingTag(ctx.store.snapshotProject().tests ?? [], plan.oldNames)
    return {
      from,
      to,
      rewiredParts: plan.parts,
      ...(stale.length > 0 ? { warnings: [`these kept tests still name ${from} and will fail until updated (save_test them again): ${stale.join(', ')}`] } : {}),
    }
  },
}

const setTask: AgentTool = {
  name: 'set_task',
  description:
    "Retime or reprioritize one of the program's tasks, named as get_program's `tasks` lists them (a program with no " +
    'task table has one, at its scan time). `intervalMs` is a whole number of ms, 1 or more; `priority` a ' +
    'whole number, 0 the highest. One undo step.',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string' }, intervalMs: { type: 'number' }, priority: { type: 'number' } },
    required: ['task'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    const name = str(args, 'task')
    const intervalMs = optNum(args, 'intervalMs')
    const priority = optNum(args, 'priority')
    if (intervalMs === undefined && priority === undefined) throw new AgentToolError("give 'intervalMs', 'priority' or both")
    if (intervalMs !== undefined && intervalMs < 1) throw new AgentToolError("'intervalMs' must be 1 or more")
    if (priority !== undefined && priority < 0) throw new AgentToolError("'priority' must be 0 or more")
    const s = ctx.store.getState()
    const table = s.controller ?? defaultController(s.stProgram, s.stScanMs)
    const index = table.tasks.findIndex((t) => t.name.toUpperCase() === name.toUpperCase())
    if (index < 0) throw new AgentToolError(`no task '${name}' (the tasks are: ${table.tasks.map((t) => t.name).join(', ') || 'none'})`)
    commitControllerEdit(ctx.store, setTaskTiming(table, index, { intervalMs, priority }), [], `${AGENT_LABEL}: edit task ${table.tasks[index]!.name}`)
    const now = ctx.store.getState()
    return { scanMs: now.stScanMs, tasks: (now.controller ?? defaultController(now.stProgram, now.stScanMs)).tasks }
  },
}

const assignIoTool: AgentTool = {
  name: 'assign_io',
  description:
    'Give the PLC tags the parts are wired to by name an I/O address, for a real PLC: each is declared AT its address ' +
    'in the program (`Eye AT %IX100.0 : BOOL`) and its parts are rewired to the address, as one undo step. Without ' +
    "`list`, addresses are picked in order for the external PLC link's settings. With `list` (CSV text, the format " +
    'get_io_list writes; at least Tag and Address columns) the addresses come from it. Returns what was assigned and ' +
    'what was left as it was, with the reason.',
  inputSchema: {
    type: 'object',
    properties: { list: { type: 'string', description: 'an I/O list as CSV text' } },
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    const list = optStr(args, 'list')
    const s = ctx.store.getState()
    if (!isKnownDialect(s.stDialect)) throw new AgentToolError('this program is in a dialect this version does not run, so I/O cannot be assigned to it')
    const target = ioTargetFor(s.externalPlc)
    const edit = list === undefined ? assignIo(s.scene, s.stProgram, target) : importIoList(s.scene, s.stProgram, list, target)
    if (edit.source !== s.stProgram || edit.scene) {
      ctx.store.commitProgram(`${AGENT_LABEL}: ${list === undefined ? 'assign I/O' : 'import I/O list'}`, { source: edit.source }, edit.scene ? { scene: edit.scene } : undefined)
    }
    return { summary: reportSummary(edit.report), assigned: edit.report.assigned, skipped: edit.report.skipped }
  },
}

const getIoList: AgentTool = {
  name: 'get_io_list',
  description:
    "The scene's I/O list as CSV: one row per part wired to an I/O address (Tag, Address, Type, Direction, Modbus " +
    'point, Device). A part still wired by name has no row until assign_io gives it an address. assign_io reads this ' +
    'format back.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: ({ store }) => {
    const s = store.getState()
    return { csv: ioListCsv(s.scene, s.stProgram, s.projectName, s.externalPlc) }
  },
}

/** get_problems lists the newest flow facts, at most this many (the rest are counted). */
const AGENT_FLOW_FACTS = 50

const getProblems: AgentTool = {
  name: 'get_problems',
  description:
    'Check the scene the way the Problems panel does: program compile errors, wiring (tags nothing drives or reads, ' +
    'two writers, type clashes), part build and runtime errors. Also notes on what could not be checked. `flowFacts` ' +
    '(not shown in the panel) lists what physically happened in the current or last run (a box dropped, tipped, held still on a running ' +
    'conveyor, an eye flickering): facts, not errors, so judge them against what the line is meant to do. ' +
    '`folderError` (the project folder cannot be read or synced, so edits made there do not load) and `folderNote` ' +
    '(files in the folder that project.json does not list, so loading ignored them) are the folder banner\'s text.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (ctx) => {
    const r = problems(ctx)
    const facts = ctx.controller?.sim?.flowFacts.all() ?? []
    // the folder banner: an agent writing files into the folder has no other way to learn a write did nothing
    const { folderError, folderNote } = ctx.store.getState()
    return {
      ...(folderError ? { folderError } : {}),
      ...(folderNote ? { folderNote } : {}),
      ...(facts.length > 0
        ? {
            flowFacts: facts.slice(-AGENT_FLOW_FACTS).map((f) => ({ kind: f.kind, t: f.t, message: f.message, ...(f.part ? { part: f.part } : {}) })),
            ...(facts.length > AGENT_FLOW_FACTS ? { flowFactsOmitted: facts.length - AGENT_FLOW_FACTS } : {}),
          }
        : {}),
      errors: r.errors,
      warnings: r.warnings,
      problems: r.problems.map((p) => ({
        severity: p.severity,
        group: p.group,
        subject: p.subject,
        message: p.message,
        ...(p.parts.length > 0 ? { parts: p.parts } : {}),
        ...(p.line !== undefined ? { line: p.line } : {}),
      })),
      ...(r.notes.length > 0 ? { notes: r.notes } : {}),
    }
  },
}

const run: AgentTool = {
  name: 'run',
  description: 'Start the simulation (Play) with the PLC program attached. Operating never edits the document.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (ctx) => {
    needController(ctx).run()
    return { running: ctx.store.getState().running }
  },
}

const stop: AgentTool = {
  name: 'stop',
  description: 'Stop the simulation. The scene returns to how it was authored.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (ctx) => {
    needController(ctx).stop()
    return { running: ctx.store.getState().running }
  },
}

import { watchHas, watchKeysOf } from '../../core/watchTable'

/** the most variables get_tags returns when no names are asked for */
const MAX_UNNAMED_TAGS = 2000

const getTags: AgentTool = {
  name: 'get_tags',
  description:
    "Read the running PLC program's variables (a ~10 Hz mirror, so a pulse shorter than ~0.15 s can be missed). " +
    'Optional names filter: pass it for a large program, since without it at most ' + MAX_UNNAMED_TAGS + ' variables are returned ' +
    'and `tagsOmitted` counts the rest. Empty while stopped. Also returns `scanTimes`: per task, how long its scans take to execute ' +
    '(last, average, max in ms of real time) and its interval, and `forces`: the variables force_tag holds, if any.',
  inputSchema: {
    type: 'object',
    properties: { names: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const controller = needController(ctx)
    const watch = controller.plcWatch
    const names = args.names === undefined ? null : strList(args, 'names')
    if (!watch) return { running: ctx.store.getState().running, tags: {} }
    const tags: Record<string, unknown> = {}
    let tagsOmitted = 0
    if (names) {
      for (const k of names) if (watchHas(watch, k)) tags[k] = watch[k]
    } else {
      // a large program holds hundreds of thousands of values, which is no answer to read
      const keys = watchKeysOf(watch)
      for (const k of keys.slice(0, MAX_UNNAMED_TAGS)) tags[k] = watch[k]
      tagsOmitted = Math.max(0, keys.length - MAX_UNNAMED_TAGS)
    }
    const us = (ms: number): number => Math.round(ms * 1000) / 1000
    const scanTimes = (controller.plcScanTimes ?? []).map((s) => ({
      task: s.task,
      intervalMs: s.kind === 'continuous' ? null : us(s.periodSec * 1000),
      scans: s.scans,
      lastMs: us(s.lastMs),
      avgMs: us(s.avgMs),
      maxMs: us(s.maxMs),
    }))
    const forces = controller.plcForces ?? {}
    return {
      running: true,
      tags,
      ...(tagsOmitted > 0 ? { tagsOmitted } : {}),
      ...(names ? { missing: names.filter((n) => !watchHas(watch, n)) } : {}),
      ...(scanTimes.length > 0 ? { scanTimes } : {}),
      ...(Object.keys(forces).length > 0 ? { forces } : {}),
    }
  },
}

const setTag: AgentTool = {
  name: 'set_tag',
  description:
    'Write a value into the running PLC program (e.g. press a Start button: set it true, then false). Written once, ' +
    'between scans: a tag the program itself writes is overwritten by its next scan.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, value: { type: ['boolean', 'number'] } },
    required: ['name', 'value'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const name = str(args, 'name')
    const value = args.value
    if (typeof value !== 'boolean' && typeof value !== 'number') throw new AgentToolError("'value' must be a boolean or a number")
    const why = needController(ctx).writePlcValue(name, String(value))
    if (why) throw new AgentToolError(why)
    return { name, value }
  },
}

const forceTag: AgentTool = {
  name: 'force_tag',
  description:
    'Force a variable of the running PLC program: hold it at a value across scans until released, whatever the program ' +
    'writes or the parts feed (commissioning: run a conveyor by hand, block a sensor). Omit `value` to hold the value it ' +
    'has now. It stays until release_forces, through stop and into the next run from its first scan; opening another ' +
    'project releases it. Never written to the document.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, value: { type: ['boolean', 'number'] } },
    required: ['name'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const name = str(args, 'name')
    const value = args.value
    if (value !== undefined && typeof value !== 'boolean' && typeof value !== 'number') throw new AgentToolError("'value' must be a boolean or a number")
    const controller = needController(ctx)
    if (!controller.forcePlcValue) throw new AgentToolError('forcing is not available here')
    const why = controller.forcePlcValue(name, value === undefined ? undefined : String(value))
    if (why) throw new AgentToolError(why)
    return { forces: controller.plcForces ?? {} }
  },
}

const releaseForces: AgentTool = {
  name: 'release_forces',
  description: 'Release a forced variable (name), or every one (no name). The program writes it again from its next scan.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const controller = needController(ctx)
    controller.releasePlcForces?.(args.name === undefined ? undefined : str(args, 'name'))
    return { forces: controller.plcForces ?? {} }
  },
}

/** One run's verdict as the agent reads it. */
function verdict(r: ProjectTestRun): Record<string, unknown> {
  if (r.error) return { name: r.name, ok: false, error: r.error }
  // what physically happened: a summary always, and for a failure the facts leading up to it (often the cause)
  const facts = r.facts && r.facts.total > 0 ? { flowFacts: r.facts.summary, ...(r.facts.beforeFailure ? { factsBeforeFailure: r.facts.beforeFailure.lines } : {}) } : {}
  return { name: r.name, ok: r.ok, checks: r.result?.checks.map((c) => ({ ok: c.ok, detail: c.detail, ...(c.warning ? { warning: c.warning } : {}), ...(c.failedAt !== undefined ? { failedAt: c.failedAt } : {}) })), ...facts }
}

/** One line an agent reads first: tests and checks passed of those run. */
function summary(runs: readonly ProjectTestRun[]): string {
  const checks = runs.flatMap((r) => r.result?.checks ?? [])
  const errors = runs.filter((r) => r.error).length
  const tests = `${runs.filter((r) => r.ok).length}/${runs.length} test${runs.length === 1 ? '' : 's'} pass`
  return `${tests}, ${checks.filter((c) => c.ok).length}/${checks.length} checks${errors > 0 ? `, ${errors} could not run` : ''}`
}

/** run_test's `trace`: a tag that changes more than this many times keeps its first and last halves (an encoder) */
const TRACE_MAX_CHANGES = 200

/** run_test's `cargo`: at most this many times, each snapshot capped like get_cargo */
const CARGO_TIMES_MAX = 20

function traceView(trace: ProjectTestRun['trace'], asked: readonly string[]): Record<string, unknown> {
  if (!trace) return {}
  const cut = (changes: { t: number; v: unknown }[]) =>
    changes.length <= TRACE_MAX_CHANGES ? changes : [...changes.slice(0, TRACE_MAX_CHANGES / 2), { omitted: changes.length - TRACE_MAX_CHANGES }, ...changes.slice(-TRACE_MAX_CHANGES / 2)]
  const missing = asked.filter((t) => !trace.some((x) => x.tag === t))
  return {
    trace: trace.map((t) => ({ tag: t.tag, start: t.start ?? null, changes: cut(t.changes.map((c) => ({ t: round(c.t), v: c.v }))) })),
    ...(missing.length > 0 ? { traceMissing: `never published in the run: ${missing.join(', ')}` } : {}),
  }
}

function checkedSpec(args: Record<string, unknown>): TestSpec {
  const v = validateTestSpec(optObj(args, 'spec'))
  if (!v.ok) throw new AgentToolError(`invalid test spec:\n${v.errors.map((e) => `- ${e}`).join('\n')}`)
  return v.spec
}

const runTest: AgentTool = {
  name: 'run_test',
  description:
    'Run a project test headless and deterministic: step the scene\'s physics and PLC program for `duration` ' +
    'simulated seconds, drive `inputs` at set times, fail devices, comms or cargo flow with `faults`, and evaluate `checks` on tags and world probes. The spec ' +
    'format is in get_guide. It runs the open scene as it is now, unsaved edits included. An input ' +
    'reaches the program only through its inputs (VAR_INPUT, or a variable a part is wired to). Without `spec` it ' +
    'runs every test the project keeps (save_test). This is how to prove a change works. The editor is busy while it runs. ' +
    "`summary` says how many tests and checks passed. `trace` records tags through the whole run (each one's value " +
    'at the start and every change with its time): how to read what a value was, or why a check failed. `cargo` ' +
    'lists every box, tote and pallet at chosen sim times: id, part, kind, colour, centre [x,y,z] in metres, ' +
    'tilt from upright in degrees, heading `yawDeg` about +Y in degrees, velocity `vel` [x,y,z] in m/s and what it is ' +
    '`touching` (part ids, `cargo <id>`, `floor`), so a box tipping, turning, falling or launched, and what pushed it, can be ' +
    'followed step by step through the same run. Every run of a spec is the same run, so this is how to inspect the ' +
    'cargo at a known time; the live sim (run, get_cargo) runs on wall-clock time.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: { type: 'object', description: 'a test spec: { name?, duration, inputs?, faults?, checks, scanMs? }' },
      trace: { type: 'array', items: { type: 'string' }, description: 'tag names to record through the run' },
      cargo: { type: 'array', items: { type: 'number' }, description: `sim times (s) at which to list the cargo, at most ${CARGO_TIMES_MAX}` },
    },
    additionalProperties: false,
  },
  run: async ({ store }, args) => {
    const project = store.snapshotProject()
    const trace = args.trace === undefined ? undefined : strList(args, 'trace')
    const cargo = cargoTimes(args)
    const opts = trace || cargo ? { ...(trace ? { trace } : {}), ...(cargo ? { cargo } : {}) } : undefined
    const { runProjectTests } = await import('../project/projectTestsRun')
    if (args.spec === undefined) {
      if ((project.tests ?? []).length === 0) throw new AgentToolError('the project keeps no tests yet: pass a `spec`, or keep one with save_test')
      const runs = await runProjectTests(project, undefined, opts)
      return { ok: runs.every((r) => r.ok), summary: summary(runs), tests: runs.map((r) => ({ ...verdict(r), ...traceView(r.trace, trace ?? []), ...cargoView(r) })) }
    }
    const spec = checkedSpec(args)
    const warnings = unreachableInputs(store, spec.inputs ?? [])
    const [r] = await runProjectTests({ ...project, tests: [spec] }, undefined, opts)
    if (!r) throw new AgentToolError('the test did not run')
    if (r.error) throw new AgentToolError(r.error)
    const { name: _name, ...v } = verdict(r)
    return { summary: summary([r]), ...v, ...(warnings.length > 0 ? { warnings } : {}), ...traceView(r.trace, trace ?? []), ...cargoView(r) }
  },
}

function cargoTimes(args: Record<string, unknown>): number[] | undefined {
  const v = args.cargo
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length === 0 || !v.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)) {
    throw new AgentToolError("'cargo' must be a non-empty array of sim times in seconds, each 0 or more")
  }
  if (v.length > CARGO_TIMES_MAX) throw new AgentToolError(`'cargo' takes at most ${CARGO_TIMES_MAX} times; run the test again for more`)
  return v as number[]
}

function cargoView(r: ProjectTestRun): Record<string, unknown> {
  if (!r.cargo) return {}
  return {
    cargo: r.cargo.map((s) => ({
      at: s.at,
      t: round(s.t),
      count: s.bodies.length,
      bodies: s.bodies.slice(0, CARGO_LIST_MAX),
      ...(s.bodies.length > CARGO_LIST_MAX ? { omitted: s.bodies.length - CARGO_LIST_MAX } : {}),
    })),
    ...(r.cargoMissed && r.cargoMissed.length > 0 ? { cargoMissed: `the run ended before t=${r.cargoMissed.join(', ')}` } : {}),
  }
}

const saveTest: AgentTool = {
  name: 'save_test',
  description:
    'Keep a test in the project, so it states what "working" means for this line and travels with it (saved ' +
    'folders, the Tests overlay, npm run test-project in CI). It needs a `name`; one of the same name is replaced. ' +
    'run_test it first: this keeps it, it does not check it passes.',
  inputSchema: {
    type: 'object',
    properties: { spec: { type: 'object', description: 'a test spec with a name: { name, duration, inputs?, faults?, checks }' } },
    required: ['spec'],
    additionalProperties: false,
  },
  run: ({ store }, args) => {
    assertEditable(store)
    const spec = checkedSpec(args)
    if (!spec.name) throw new AgentToolError('a kept test needs a `name` (the Tests overlay and the CLI list it by name)')
    if (!store.saveProjectTest(spec)) throw new AgentToolError('this editor cannot keep tests (it is view-only, or in a shared project of someone else\'s, which keeps none)')
    return { name: spec.name, tests: (store.snapshotProject().tests ?? []).map((t) => t.name ?? '(unnamed)') }
  },
}

const listTests: AgentTool = {
  name: 'list_tests',
  description: 'List the tests the project keeps, each spec in full.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: ({ store }) => store.snapshotProject().tests ?? [],
}

/**
 * A spec input a test cannot deliver: it names a variable of the program that is not one of its inputs. The runner
 * feeds a spec's inputs to the program's inputs (VAR_INPUT, or a variable a part's tag is wired to) and to the parts;
 * a plain VAR belongs to the program's own scan, so the value is dropped without a word and the test fails for a
 * reason it never names. (A live set_tag does reach it, which makes the difference all the harder to see.)
 */
function unreachableInputs(store: EditorStore, inputs: readonly { tag: string }[]): string[] {
  const s = store.getState()
  if (inputs.length === 0 || s.stProgram === '' || !isKnownDialect(s.stDialect)) return []
  let plc: LocalPlcLink
  try {
    const declared = new LocalPlcLink(runnableSource(s.stProgram, controllerFor(s.stProgram, s.controller, s.stScanMs)), undefined)
    plc = declared.withBindings(wiredBindings(s.scene.parts, declared))
  } catch {
    return [] // a program that does not compile: get_problems says why
  }
  const reachable = new Set(plc.inputs)
  const vars = plc.watch
  return [...new Set(inputs.map((i) => i.tag))]
    .filter((tag) => tag in vars && !reachable.has(tag))
    .map((tag) => `'${tag}' is a variable of the program but not one of its inputs, so this test's input to it is dropped. Declare it in VAR_INPUT, or wire a part's tag param to it.`)
}

/** Every tool, in the order a client lists them. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  getGuide,
  getContext,
  syncFolder,
  getScene,
  getPart,
  listCatalog,
  getPackageTool,
  addPart,
  snapPart,
  updatePart,
  deleteParts,
  duplicatePartsTool,
  getPartSdk,
  getPartSource,
  checkPart,
  createPart,
  editPartDefinition,
  importModel,
  importRobot,
  solveRobotPose,
  getRobotPose,
  listLibraryParts,
  installLibraryPart,
  listShelfParts,
  installShelfPart,
  putPartOnShelf,
  getProgram,
  setProgram,
  listPous,
  getPou,
  setPou,
  checkProgram,
  renameTagTool,
  setTask,
  assignIoTool,
  getIoList,
  listControllers,
  assignControllerTool,
  setControllerTool,
  runInstanceOnTool,
  getProblems,
  captureView,
  run,
  stop,
  pauseTool,
  resumeTool,
  stepTool,
  getTags,
  setTag,
  forceTag,
  releaseForces,
  traceTags,
  getCargo,
  runTest,
  saveTest,
  listTests,
  deleteTest,
  undoTool,
]

/** The result of one call: the value to report, or the error the agent should read. */
export type AgentCallResult = { ok: true; value: unknown } | { ok: false; error: string }

/** Run tool `name` with `args`. Never throws: a refusal or a crash comes back as `{ ok: false, error }`. */
export async function callAgentTool(ctx: AgentToolContext, name: string, args: unknown): Promise<AgentCallResult> {
  const tool = AGENT_TOOLS.find((t) => t.name === name)
  if (!tool) return { ok: false, error: `no tool '${name}'` }
  const a = args === undefined || args === null ? {} : args
  if (typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'arguments must be an object' }
  let failed = false
  try {
    // A definition session (the Catalog ✎) puts a scene of its own on screen and parks the document's. Every tool
    // reads and authors the document, so the session closes first, stopping a run as any scene swap does.
    if (ctx.store.getState().packageEdit) {
      if (ctx.store.getState().running) ctx.controller?.stop()
      ctx.store.exitPartFocus()
    }
    ctx.session?.beginCall(name)
    return { ok: true, value: await tool.run(ctx, a as Record<string, unknown>) }
  } catch (e) {
    failed = true
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    ctx.session?.endCall(name, !failed)
  }
}

/** The list as a client sees it: name, description, input schema. */
export function agentToolDefinitions(): { name: string; description: string; inputSchema: JsonSchema }[] {
  return AGENT_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}
