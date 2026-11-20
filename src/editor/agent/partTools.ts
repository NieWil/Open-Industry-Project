// Agent tools for part definitions (docs/agent-tools.md): read the Part SDK and any part's source, check a draft
// without keeping it, make a new part, change one, and give a rig link an imported model. They write through the
// same paths the editor's part authoring uses (controller/partAuthoring.ts): a new part joins the project's parts
// (store.addUserPackage), and a change is one package commit (store.commitPackage), so editing a built-in makes this
// project's own version of it, as an in-app edit does.

import { getPackage, hasPackage, registerPackage } from '../../core/parts/partRegistry'
import { manifestOfPackage, type PackageManifest, type PartPackage } from '../../core/parts/partPackage'
import { partFootprint } from '../../core/parts/partGeometry'
import { drawnElsewhere, emptyBox, growBox, meshLinkBox, parseGlb } from '../../core/glbBox'
import { qApply, rigWorldPoses, type RigParams } from '../../core/rig/rigPose'
import { createSdkPart } from '../../core/scene/scene'
import { checkManifestAgainst, type SchemaProblem } from '../../core/manifestSchemaCheck'
import { stepUpAxisGuess, type StepUpAxis } from '../../core/stepToGlb'
import { validatePart, type PartDiagnostic } from '../../sim/validatePart'
import { setLinkMesh } from '../controller/partAuthoring'
import { partSourceInFolder } from '../project/projectFolderSync'
import type { SdkPart } from '../../core/types'
import {
  AGENT_LABEL,
  AgentToolError,
  assertEditable,
  knownPackages,
  optNum,
  optObj,
  optStr,
  round,
  str,
  type AgentTool,
  type AgentToolContext,
} from './toolKit'

/** Manifest fields the app writes itself, which an agent never sets: the id is the part's identity, assets come in
 *  through import_model, and origin / sdk are the app's records of where a copy came from. */
const APP_OWNED = ['id', 'assets', 'origin', 'sdk'] as const

const BLANK_BEHAVIOR = ['definePart({', '  params: {},', '  step(ctx) {', '    // ctx.setJoint(name, value), ctx.params.*, ctx.tag(...): get_part_sdk lists the ctx surface', '  },', '})', ''].join('\n')

function packageOrRefuse(ctx: AgentToolContext, id: string): PartPackage {
  const pkg = knownPackages(ctx.store).find((p) => p.id === id) ?? getPackage(id)
  if (!pkg) throw new AgentToolError(`no part definition '${id}' (list_catalog lists them; get_scene shows which one a placed part uses)`)
  return pkg
}

/** A manifest as an agent reads it: embedded model bytes summarized, not inlined (one GLB can be megabytes). */
function readableManifest(pkg: PartPackage): Record<string, unknown> {
  const { assets, thumbnail: _thumbnail, ...rest } = manifestOfPackage(pkg)
  return { ...rest, ...(assets ? { assets: assets.map(({ data, ...a }) => ({ ...a, ...(data !== undefined ? { bytes: Math.round((data.length * 3) / 4) } : {}) })) } : {}) }
}

/** The extent of a part placed at its default params, in metres: what snapping, placement and the Inspector see. */
function footprintOf(pkg: PartPackage): Record<string, number> {
  const f = partFootprint(createSdkPart(pkg, '__footprint', [0, 0, 0], 0))
  return { length: round(f.hx * 2), width: round(f.hz * 2), bottom: round(f.y0), top: round(f.y1), ...(f.cx ? { centreX: round(f.cx) } : {}), ...(f.cz ? { centreZ: round(f.cz) } : {}) }
}

interface Checked {
  pkg: PartPackage | null
  schema: SchemaProblem[]
  diagnostics: PartDiagnostic[]
}

/** The schema check (fields the app would ignore) and the bake (the app's own validator) for one draft. */
async function checkDraft(manifest: PackageManifest, behavior: string): Promise<Checked> {
  const schema = (await import('../../../packages/part-sdk/manifest.schema.json')).default as Record<string, unknown>
  const problems = checkManifestAgainst(manifest, schema)
  const r = validatePart(manifest, behavior)
  return { pkg: r.ok && r.package ? r.package : null, schema: problems, diagnostics: r.diagnostics }
}

function refuseUnlessClean(c: Checked, what: string): PartPackage {
  if (c.pkg && c.schema.length === 0) return c.pkg
  const lines = [
    ...c.schema.map((p) => `schema ${p.path}: ${p.message}`),
    ...c.diagnostics.map((d) => `${d.kind}${d.line !== undefined ? ` (line ${d.line}${d.column !== undefined ? `:${d.column}` : ''})` : ''}: ${d.message}`),
  ]
  throw new AgentToolError(`${what} was not kept:\n${lines.map((l) => `- ${l}`).join('\n')}`)
}

function manifestPatch(args: Record<string, unknown>): Partial<PackageManifest> {
  const patch = optObj(args, 'manifest') ?? {}
  const owned = APP_OWNED.filter((k) => k in patch)
  if (owned.length > 0) throw new AgentToolError(`the manifest's ${owned.map((k) => `'${k}'`).join(', ')} ${owned.length === 1 ? 'is' : 'are'} the app's to write (import_model adds a model)`)
  return patch as Partial<PackageManifest>
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'part'
}

// ── the SDK ─────────────────────────────────────────────────────────────────────────────────────────

/** `##` / `###` headings of a markdown text, with their line index and depth. */
function headings(lines: readonly string[]): { at: number; depth: number; title: string }[] {
  const out: { at: number; depth: number; title: string }[] = []
  let fenced = false
  lines.forEach((l, at) => {
    if (l.startsWith('```')) fenced = !fenced
    const m = !fenced && /^(#{2,3}) (.+)$/.exec(l)
    if (m) out.push({ at, depth: m[1]!.length, title: m[2]!.trim() })
  })
  return out
}

/** The declaration of `symbol` in a .d.ts text with its doc comment, or null. */
function declarationOf(text: string, symbol: string): string | null {
  const lines = text.split('\n')
  const head = new RegExp(`^\\s*(export\\s+)?(declare\\s+)?(interface|type|function|const|class|namespace)\\s+${symbol.replace(/[^A-Za-z0-9_$]/g, '')}\\b`)
  const start = lines.findIndex((l) => head.test(l))
  if (start < 0) return null
  let from = start
  if (lines[from - 1]?.trim().endsWith('*/')) while (from > 0 && !lines[from]!.trim().startsWith('/**')) from--
  let depth = 0
  let end = start
  for (; end < lines.length; end++) {
    for (const ch of lines[end]!) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    if (depth <= 0 && (lines[end]!.includes('}') || lines[end]!.trimEnd().endsWith(';') || !lines[end]!.includes('{'))) break
  }
  return lines.slice(from, end + 1).join('\n')
}

export const getPartSdk: AgentTool = {
  name: 'get_part_sdk',
  description:
    'Read the Part SDK, for writing or changing a part definition. No arguments: the authoring guide\'s table of ' +
    'contents. `section`: one section of the guide (a heading, or part of one: "Params", "Tier 1", "ctx members"). ' +
    '`symbol`: the TypeScript declaration of one SDK name (definePart, PartContext, RigLink, SnapSpec, ParamSpec...). ' +
    'For a worked example, get_part_source any built-in part.',
  inputSchema: {
    type: 'object',
    properties: { section: { type: 'string' }, symbol: { type: 'string' } },
    additionalProperties: false,
  },
  run: async (_ctx, args) => {
    const section = optStr(args, 'section')?.trim()
    const symbol = optStr(args, 'symbol')?.trim()
    if (symbol) {
      const [index, manifest, global] = await Promise.all([
        import('../../../packages/part-sdk/index.d.ts?raw'),
        import('../../../packages/part-sdk/manifest.d.ts?raw'),
        import('../../../packages/part-sdk/global.d.ts?raw'),
      ])
      for (const [file, text] of [['index.d.ts', index.default], ['manifest.d.ts', manifest.default], ['global.d.ts', global.default]] as const) {
        const decl = declarationOf(text, symbol)
        if (decl) return `// @oip/part-sdk ${file}\n${decl.length > 12000 ? `${decl.slice(0, 12000)}\n// ... (cut at 12000 characters)` : decl}`
      }
      throw new AgentToolError(`no declaration named '${symbol}' in the Part SDK (definePart, PartContext and the manifest types are the usual entry points)`)
    }
    const guide = (await import('../../../docs/part-authoring-guide.md?raw')).default
    const lines = guide.split('\n')
    const heads = headings(lines)
    if (!section) {
      return {
        guide: 'docs/part-authoring-guide.md',
        sections: heads.map((h) => `${h.depth === 3 ? '  ' : ''}${h.title}`),
        next: 'get_part_sdk({ section }) reads one; get_part_source shows any built-in part as an example.',
      }
    }
    const q = section.toLowerCase().replace(/^#+\s*/, '')
    const i = heads.findIndex((h) => h.title.toLowerCase() === q)
    const hit = i >= 0 ? i : heads.findIndex((h) => h.title.toLowerCase().includes(q))
    if (hit < 0) throw new AgentToolError(`no section matching '${section}'. The sections are:\n${heads.map((h) => h.title).join('\n')}`)
    const h = heads[hit]!
    const next = heads.slice(hit + 1).find((n) => n.depth <= h.depth)
    return lines.slice(h.at, next ? next.at : lines.length).join('\n')
  },
}

// ── reading and checking ───────────────────────────────────────────────────────────────────────────

export const getPartSource: AgentTool = {
  name: 'get_part_source',
  description:
    'Read a part definition the way its folder holds it: the manifest (geometry, snap, conveyor...; embedded models ' +
    'are summarized by size), the behavior script, the params the script declares, its footprint at default params, ' +
    'whether it is a built-in, this project\'s own, or this project\'s version of a built-in, and which placed parts use it. ' +
    "When the project folder builds the part from a part.js, `partJs` holds that source and the command that builds it: " +
    'the manifest and behavior are then its output.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'package id, from list_catalog or a placed part\'s package' } },
    required: ['id'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    const pkg = packageOrRefuse(ctx, str(args, 'id'))
    const s = ctx.store.getState()
    const builtIn = s.bundledPackages.some((p) => p.id === pkg.id)
    const inLibrary = s.userPackages.some((p) => p.id === pkg.id)
    return {
      id: pkg.id,
      name: pkg.name,
      kind: builtIn ? (inLibrary ? "this project's version of a built-in" : 'built-in (an edit makes this project\'s own version)') : inLibrary ? "this project's part" : 'embedded in the scene',
      manifest: readableManifest(pkg),
      behavior: pkg.behavior,
      params: pkg.params,
      footprint: footprintOf(pkg),
      placed: s.scene.parts.filter((p) => p.type === 'part' && (p as SdkPart).packageId === pkg.id).map((p) => p.id),
      ...partJsOf(pkg.id),
    }
  },
}

/**
 * get_part_source's `partJs` for a part the project folder builds from a part.js: its text, and how to build it. The
 * manifest and behavior above are then that build's output.
 */
function partJsOf(id: string): { partJs?: { path: string; source: string; build: string; note: string } } {
  const src = partSourceInFolder(id)
  if (!src) return {}
  const dir = src.path.slice(0, -'/part.js'.length)
  return {
    partJs: {
      path: src.path,
      source: src.text,
      build: `npm run build-parts -- "${src.root.replace(/\\/g, '/')}/${dir}"`,
      note:
        'this part is built from part.js: the manifest and behavior are its output. To change it, edit part.js in the ' +
        'project folder, run the build on that folder (in an oip-web checkout), then sync_folder. edit_part_definition ' +
        'changes the output only, and the next build refuses to overwrite it until the change is also in part.js.',
    },
  }
}

export const checkPart: AgentTool = {
  name: 'check_part',
  description:
    'Check a part definition draft without keeping it: the manifest against the SDK schema (a misspelt field the ' +
    'app would silently IGNORE), then the app\'s own bake (the behavior runs once in the determinism sandbox; the ' +
    'rig, params and snap references are checked). Give `id` to start from an existing part and override its ' +
    '`behavior` and/or `manifest` fields; or give a whole new `manifest` and `behavior`. Returns the problems with ' +
    'line numbers, and on success the params the script declares.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'an existing part to start from' },
      manifest: { type: 'object', description: 'manifest fields: name, category, geometry, snap, conveyor, commsParam, holds, materials' },
      behavior: { type: 'string', description: 'the behavior script: a definePart({...}) call' },
    },
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const id = optStr(args, 'id')
    const base = id ? packageOrRefuse(ctx, id) : null
    const patch = optObj(args, 'manifest') ?? {}
    const behavior = optStr(args, 'behavior') ?? base?.behavior
    if (behavior === undefined) throw new AgentToolError("give 'behavior' (or an 'id' to start from)")
    const manifest = { id: 'user.draft', name: 'Draft', ...(base ? manifestOfPackage(base) : {}), ...patch } as PackageManifest
    if (!manifest.geometry) throw new AgentToolError("a new part's manifest needs 'geometry' (get_part_sdk 'Geometry, tier by tier')")
    const c = await checkDraft(manifest, behavior)
    return {
      ok: c.pkg !== null && c.schema.length === 0,
      ...(c.schema.length > 0 ? { schema: c.schema } : {}),
      ...(c.diagnostics.length > 0 ? { diagnostics: c.diagnostics } : {}),
      ...(c.pkg ? { params: c.pkg.params } : {}),
    }
  },
}

// ── authoring ──────────────────────────────────────────────────────────────────────────────────────

export const createPart: AgentTool = {
  name: 'create_part',
  description:
    "Make a new part definition in this project, checked as check_part checks it (refused with the " +
    'problems otherwise). `manifest` holds geometry, snap, conveyor and the rest; without geometry the part is one ' +
    '0.6 m box link named "body". Without `behavior` it gets an empty definePart. The id defaults to user.<name>. ' +
    'Place it with add_part. Copy a built-in instead by passing its source from get_part_source with a new name.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      id: { type: 'string', description: "package id, e.g. 'user.lift-table'; must not exist yet" },
      category: { type: 'string' },
      manifest: { type: 'object' },
      behavior: { type: 'string' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    assertEditable(ctx.store)
    const name = str(args, 'name').trim()
    const patch = manifestPatch(args)
    let id = optStr(args, 'id')?.trim()
    if (id !== undefined) {
      if (hasPackage(id)) throw new AgentToolError(`'${id}' already exists: edit_part_definition changes it`)
    } else {
      const stem = `user.${slug(name)}`
      id = stem
      for (let n = 2; hasPackage(id); n++) id = `${stem}-${n}`
    }
    const category = optStr(args, 'category') ?? patch.category
    const manifest: PackageManifest = {
      geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.6, 0.6, 0.6] }, offset: [0, 0.3, 0] }], joints: [] },
      ...patch,
      id,
      name,
      ...(category !== undefined ? { category } : {}),
    }
    const pkg = refuseUnlessClean(await checkDraft(manifest, optStr(args, 'behavior') ?? BLANK_BEHAVIOR), `'${name}'`)
    registerPackage(pkg, true)
    ctx.store.addUserPackage(pkg)
    return { id: pkg.id, name: pkg.name, params: pkg.params, footprint: footprintOf(pkg) }
  },
}

export const editPartDefinition: AgentTool = {
  name: 'edit_part_definition',
  description:
    'Change a part definition: its `behavior` script and/or `manifest` fields (name, category, geometry, snap, ' +
    'conveyor, commsParam, holds, materials; a field given replaces that field whole). Checked as check_part checks ' +
    'it and refused with the problems otherwise. Every placed part of this definition follows. One undo step. ' +
    "Changing a built-in makes this project's own version of it; other projects keep the app's. A part built from a " +
    'part.js (get_part_source says) is edited in its part.js instead: this tool changes only the build output, and says so.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, behavior: { type: 'string' }, manifest: { type: 'object' } },
    required: ['id'],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    assertEditable(ctx.store)
    const pkg = packageOrRefuse(ctx, str(args, 'id'))
    const patch = manifestPatch(args)
    const behavior = optStr(args, 'behavior')
    if (behavior === undefined && Object.keys(patch).length === 0) throw new AgentToolError("give 'behavior', 'manifest' or both")
    const next = refuseUnlessClean(await checkDraft({ ...manifestOfPackage(pkg), ...patch }, behavior ?? pkg.behavior), `the change to '${pkg.name}'`)
    const wasLibrary = ctx.store.getState().userPackages.some((p) => p.id === pkg.id)
    ctx.store.commitPackage(`${AGENT_LABEL}: edit part ${next.name}`, next)
    const error = ctx.store.getState().packageBuildErrors[pkg.id]
    if (error) throw new AgentToolError(`the app refused the change: ${typeof error === 'string' ? error : JSON.stringify(error)}`)
    const source = partSourceInFolder(next.id)
    return {
      id: next.id,
      params: next.params,
      footprint: footprintOf(next),
      placed: ctx.store.getState().scene.parts.filter((p) => p.type === 'part' && (p as SdkPart).packageId === next.id).length,
      ...(wasLibrary ? {} : { note: "this project now has its own version of this part" }),
      ...(source
        ? {
            warning:
              `this part is built from ${source.path}, and this edit changed only its build output (manifest.json, ` +
              'behavior.js). Copy the change into part.js, or the next build-parts refuses to overwrite it (--force throws it away).',
          }
        : {}),
    }
  },
}

/**
 * Where the model a link now draws sits in the part's frame (its GLB box placed at the link's rest pose, as
 * check-part measures it), and a hint when the declared footprint, which placement and snapping use, is far from it:
 * the model sticks out of it, or a one-link part's footprint is much bigger than its model.
 */
function modelFit(pkg: PartPackage, linkName: string, glb: Uint8Array): { model: Record<string, number[]>; hint?: string } | null {
  if (pkg.geometry.kind !== 'rig') return null
  const link = pkg.geometry.links.find((l) => l.name === linkName)
  if (!link || link.shape.kind !== 'mesh') return null
  let local: ReturnType<typeof meshLinkBox>
  try {
    local = meshLinkBox(parseGlb(glb).json, { ...link.shape, drawnElsewhere: drawnElsewhere(pkg.geometry.links, link) })
  } catch {
    return null
  }
  const defaults = Object.fromEntries(Object.entries(pkg.params ?? {}).map(([k, spec]) => [k, spec.default])) as RigParams
  const pose = rigWorldPoses(pkg.geometry, {}, undefined, 1, defaults).get(linkName)
  if (!local || !pose) return null
  const placed = emptyBox()
  for (let i = 0; i < 8; i++) {
    const c = qApply(pose.quat, [i & 1 ? local.max[0]! : local.min[0]!, i & 2 ? local.max[1]! : local.min[1]!, i & 4 ? local.max[2]! : local.min[2]!])
    growBox(placed, [c[0] + pose.pos[0], c[1] + pose.pos[1], c[2] + pose.pos[2]])
  }
  const f = partFootprint(createSdkPart(pkg, '__footprint', [0, 0, 0], 0))
  const fp = { min: [(f.cx ?? 0) - f.hx, f.y0, (f.cz ?? 0) - f.hz], max: [(f.cx ?? 0) + f.hx, f.y1, (f.cz ?? 0) + f.hz] }
  const model = { min: placed.min.map(round), max: placed.max.map(round) }
  const size = (b: { min: number[]; max: number[] }): number[] => [0, 1, 2].map((k) => round(b.max[k]! - b.min[k]!))
  const tol = 0.02
  const outside = [0, 1, 2].some((k) => placed.min[k]! < fp.min[k]! - tol || placed.max[k]! > fp.max[k]! + tol)
  const loose = pkg.geometry.links.length === 1 && [0, 1, 2].some((k) => size(fp)[k]! - size(placed)[k]! > Math.max(0.05, 0.25 * size(placed)[k]!))
  if (!outside && !loose) return { model }
  const span = (b: { min: number[]; max: number[] }): string => `x ${round(b.min[0]!)}..${round(b.max[0]!)}, y ${round(b.min[1]!)}..${round(b.max[1]!)}, z ${round(b.min[2]!)}..${round(b.max[2]!)}`
  return {
    model,
    hint:
      `the model spans ${span(placed)} m in the part's frame but the footprint is ${span(fp)} m` +
      `${outside ? ' (the model sticks out of it)' : ' (much bigger than the model)'}. Placement and snapping use the footprint: ` +
      'set geometry.bounds { length, width, top, bottom, centerX, centerZ } with edit_part_definition (get_part_sdk symbol PartBounds)' +
      `${placed.min[1]! > tol ? `, and the link's offset if the model should stand on the floor (its underside is at y ${round(placed.min[1]!)})` : ''}`,
  }
}

export const importModel: AgentTool = {
  name: 'import_model',
  description:
    "Make one link of a part's rig a mesh of a model file on this computer: a .glb, a STEP file (.step / .stp) " +
    'from CAD, or a USD model (.usdz, or a .usd / .usda / .usdc root layer, read with the layers and images under ' +
    'its folder), converted as the Inspector converts it. The model is embedded in the part. One undo step. A rig\'s ' +
    '`bounds` are declared, not measured from the model: compare the footprint with capture_view and set ' +
    'geometry.bounds with edit_part_definition when they disagree.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the part definition (package id)' },
      link: { type: 'string', description: 'the rig link to give the mesh' },
      path: { type: 'string', description: 'absolute path of the .glb / .step / .stp / .usd / .usda / .usdc / .usdz file' },
      upAxis: { type: 'string', enum: ['z', 'y'], description: "STEP only: the model's up axis; default guessed from the file's header" },
      minPartMm: { type: 'number', description: 'STEP only: skip solids smaller than this (default 10)' },
      detail: { type: 'string', enum: ['full', 'reduced'], description: 'USD only: reduced simplifies each mesh to about a quarter of its triangles (default full)' },
      maxTextureSize: { type: 'number', enum: [512, 1024, 2048], description: 'USD only: the longest side of an imported texture in pixels (default 1024)' },
    },
    required: ['id', 'link', 'path'],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    assertEditable(ctx.store)
    const readModel = ctx.shell?.readModel
    if (!readModel) throw new AgentToolError('importing a model file needs the desktop app')
    const pkg = packageOrRefuse(ctx, str(args, 'id'))
    const link = str(args, 'link')
    if (pkg.geometry.kind !== 'rig') throw new AgentToolError(`'${pkg.id}' builds its geometry in code (geometry()), so it has no links to give a model`)
    if (!pkg.geometry.links.some((l) => l.name === link)) throw new AgentToolError(`'${pkg.id}' has no link '${link}' (it has: ${pkg.geometry.links.map((l) => l.name).join(', ')})`)
    if (/\.(urdf|xacro)$/i.test(str(args, 'path'))) throw new AgentToolError('a URDF is a whole robot, not one link\'s model: import it with import_robot')
    const file = await readModel(str(args, 'path'))
    if ('error' in file) throw new AgentToolError(file.error)
    const { DEFAULT_STEP_OPTIONS, importStep, isStepFile } = await import('../stepImport')
    let glb = file.bytes
    let stats: Record<string, unknown> | undefined
    if (isStepFile(file.name)) {
      const up = (optStr(args, 'upAxis') as StepUpAxis | undefined) ?? stepUpAxisGuess(new TextDecoder().decode(file.bytes.subarray(0, 8192))).up
      const minPartMm = optNum(args, 'minPartMm') ?? DEFAULT_STEP_OPTIONS.minPartMm
      const r = await importStep(file.bytes, { ...DEFAULT_STEP_OPTIONS, detail: 'normal', upAxis: up, minPartMm })
      if (r.stats.meshes === 0) throw new AgentToolError(`nothing to import: all ${r.stats.solids} solids in ${file.name} are smaller than ${minPartMm} mm`)
      glb = r.glb
      stats = { solids: r.stats.solids, meshes: r.stats.meshes, triangles: r.stats.triangles, size: r.stats.size.map(round), upAxis: up }
    }
    let usd: Record<string, unknown> | undefined
    const { DEFAULT_USD_OPTIONS, importUsd, isUsdFile } = await import('../usdImport')
    if (isUsdFile(file.name)) {
      const files = new Map<string, Blob>((file.files ?? [{ path: file.name, bytes: file.bytes }]).map((f) => [f.path, new Blob([f.bytes as Uint8Array<ArrayBuffer>])]))
      const detail = optStr(args, 'detail') === 'reduced' ? 'reduced' : DEFAULT_USD_OPTIONS.detail
      const maxTextureSize = optNum(args, 'maxTextureSize') ?? DEFAULT_USD_OPTIONS.maxTextureSize
      const r = await importUsd(files, file.root ?? file.name, { detail, maxTextureSize })
      if (r.stats.meshes === 0) throw new AgentToolError(`nothing to import: ${file.name} has no meshes this importer can read`)
      glb = r.glb
      usd = {
        parts: r.stats.parts,
        meshes: r.stats.meshes,
        triangles: r.stats.triangles,
        ...(r.stats.triangles < r.stats.sourceTriangles ? { sourceTriangles: r.stats.sourceTriangles } : {}),
        size: r.stats.size.map(round),
        images: r.stats.images,
        ...(r.stats.warnings.length ? { warnings: r.stats.warnings.slice(0, 5).map((w) => w.message) } : {}),
      }
    }
    const { warning, fitted, unreadable } = setLinkMesh({ store: ctx.store }, pkg.id, link, glb, `${AGENT_LABEL}: import model into ${pkg.name}`)
    if (unreadable) throw new AgentToolError(`${file.name} is not a model this importer can read: export it as a .glb (glTF Binary), a STEP file or a USD file`)
    const now = getPackage(pkg.id)
    const footprint = now ? footprintOf(now) : null
    const fit = now ? modelFit(now, link, glb) : null
    return {
      id: pkg.id,
      link,
      bytes: glb.length,
      ...(stats ? { step: stats } : {}),
      ...(usd ? { usd } : {}),
      // a part that is just this model was stood on the origin, given a collider and bounds of its size
      ...(fitted ? { fitted } : {}),
      ...(footprint ? { footprint } : {}),
      ...(fit ? { model: fit.model } : {}),
      ...(fit?.hint ? { boundsHint: fit.hint } : {}),
      ...(warning ? { warning } : {}),
    }
  },
}
