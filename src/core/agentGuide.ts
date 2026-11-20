// AGENTS.md - the context file a project folder carries for an AI agent editing it.
//
// The folder is the interface between an agent and this app: the agent writes files, the app follows the
// folder and grades the result. But a folder of scene JSON, ST text and test specs says nothing about the
// vocabulary behind it: which tags this scene wires, which way each one flows, what the ST subset allows,
// what a test spec looks like. Without it an agent guesses at every name it writes. This renders that
// vocabulary, derived from the document being saved, so it can never describe a different project.
//
// Derived, not transcribed, wherever it can be: the tag table, the part inventory and the placeable
// package list are read off the scenes' embedded packages, so they cannot drift from the document.
// The prose that remains (conventions, the ST pointer, the test schema) is the part a human must keep
// true, and it is kept short for that reason.
//
// Pure and core-safe: string building over plain data, no DOM/three/React/Jolt and no host imports,
// so the browser save, the Electron save and the .oip zip all emit the same file from one call site
// in projectFolder.ts.
//
// Written at the folder root, where the loader ignores it. Reassembly is manifest-driven
// (folderFilesToProject) and the live sweep reads only project.json plus the format's own subfolders
// (editor/project/projectFolderLink.ts), so this file has no effect on the app and cannot corrupt a round trip.

import type { ParamSchema, ParamSpec } from './parts/partApi'
import type { Controller } from './controller'
import { isKnownDialect } from './dialect'

/** The published ST capability manifest - probed from the engine, so it says what the engine actually accepts. */
export const ST_CAPABILITIES_URL = 'https://www.openindustryproject.org/st-capabilities.json'

/** Cap on rows in a generated table, so a 200-part scene still produces a readable file. */
const MAX_ROWS = 40

/** How many of the program's files the Layout lists by name before it counts the rest. */
const PROGRAM_FILES_LISTED = 12

/** What one program file is, by its name (plc/programFiles.ts names them). */
function programFileRole(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const ladder = file.endsWith('.ld')
  if (/^program(-\d+)?\.(st|ld)$/.test(file)) return ladder ? 'the code outside every POU, with ladder' : 'the code outside every POU (Structured Text)'
  if (/^type(-\d+)?\.st$/.test(file)) return 'data types'
  if (/^var_global(-\d+)?\.st$/.test(file)) return 'global variables'
  return ladder ? 'a POU in ladder (a LADDER section)' : 'a POU in Structured Text'
}

/**
 * The slice of a serialized project this renderer reads. Structural rather than the real ProjectJSON
 * so the caller can hand over already-parsed JSON without a second validation pass.
 */
export interface GuideDoc {
  name?: string
  /** the project's one scene and its program (a project holds one since format 4) */
  scene: GuideScene
  tests?: readonly { name?: string; duration?: number }[]
}

export interface GuideScene {
  id: string
  name?: string
  /** folder-relative path this scene's JSON was written to */
  scenePath: string
  /** folder-relative paths of its program's files, in order, when it has a program (core/project/projectFolder.ts) */
  programPaths?: string[]
  /** the program's controller table, when it runs several programs on tasks */
  controller?: Controller
  /** the program's dialect (core/dialect.ts), only when it is not IEC */
  stDialect?: string
  scene?: unknown
}

/**
 * A part's local extent, as {@link measureExtent} reports it: the part occupies `cx ± hx` along X,
 * `± hz` along Z and `y0..y1` vertically, all relative to its own `position`.
 *
 * The folder has no other source for this, and agents get it wrong most often. A part's parameters
 * are in the document; its physical size is not, and neither is where its origin sits inside that size. Placing a large volume as though it were a point produces a scene that loads,
 * passes its logic tests, and does not work.
 */
export interface PartExtent {
  hx: number
  hz: number
  y0: number
  y1: number
  cx?: number
  cz?: number
}

/**
 * Measures a placed part. Injected rather than imported because the underlying computation resolves
 * packages through the ambient part registry. Calling it directly from here would make the guide's
 * content depend on global state rather than on the document. Returning null for a part it cannot measure is expected, not an error.
 */
export type MeasureExtent = (part: unknown) => PartExtent | null

/** Who reads the guide: an agent editing the project's folder (its AGENTS.md), or one driving the app's MCP tools
 *  (get_guide), which says which tool does what instead of which file and CLI. */
export type GuideDoor = 'files' | 'tools'

/**
 * The package a part names, for a scene that carries no copy of it: a project scene names its parts' packages by id,
 * and they live in the project's parts (every one of them from project format 5) or, in an older document, are
 * the app's built-ins. Injected for the same reason as {@link MeasureExtent}: the built-ins are the app's, not the
 * document's.
 */
export type ResolvePackage = (packageId: string) => { name: string; params: ParamSchema } | undefined

/** A part entry as it appears in a scene's `parts` array. */
interface ScenePart {
  id?: unknown
  type?: unknown
  name?: unknown
  packageId?: unknown
  position?: unknown
  params?: unknown
}

interface TagUse {
  tag: string
  /** 'in' = the part reads it, so the program writes it. 'out' = the part writes it. */
  dir: 'in' | 'out'
  stType: string
  partLabel: string
  packageId: string
  key: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Escape the pipe + newline that would otherwise break a markdown table row. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function truncate(rows: string[], what: string, door: GuideDoor): string[] {
  if (rows.length <= MAX_ROWS) return rows
  return [...rows.slice(0, MAX_ROWS), `\n_(+${rows.length - MAX_ROWS} more ${what} not listed. ${door === 'tools' ? '`get_scene` lists them all' : 'Read the scene file for the full set'}.)_`]
}

/** The packages a scene's parts use, as packageId → its param schema: what the scene embeds, then (a project scene
 *  embeds none) what `resolve` finds for each id its parts name. Absent ⇒ an empty map, not a throw. */
function sceneParamSpecs(scene: unknown, resolve?: ResolvePackage): Map<string, { name: string; params: ParamSchema }> {
  const out = new Map<string, { name: string; params: ParamSchema }>()
  if (isRecord(scene) && Array.isArray(scene.packages)) {
    for (const pkg of scene.packages) {
      if (!isRecord(pkg) || typeof pkg.id !== 'string') continue
      const params = isRecord(pkg.params) ? (pkg.params as ParamSchema) : ({} as ParamSchema)
      out.set(pkg.id, { name: typeof pkg.name === 'string' ? pkg.name : pkg.id, params })
    }
  }
  if (resolve) {
    for (const part of sceneParts(scene)) {
      if (typeof part.packageId !== 'string' || out.has(part.packageId)) continue
      const found = resolve(part.packageId)
      if (found) out.set(part.packageId, found)
    }
  }
  return out
}

function sceneParts(scene: unknown): ScenePart[] {
  if (!isRecord(scene) || !Array.isArray(scene.parts)) return []
  return scene.parts.filter(isRecord) as ScenePart[]
}

/** A stable label for a part in a table: its author-given name, else its id. */
function partLabel(part: ScenePart): string {
  if (typeof part.name === 'string' && part.name !== '') return part.name
  return typeof part.id === 'string' ? part.id : '(unnamed)'
}

/**
 * Every PLC tag this scene actually wires, read off the parts' `'tag'` params. This is the table an
 * ST author needs and cannot get anywhere else: the names are chosen by whoever placed the parts, so
 * no catalog, manifest or type definition knows them - only the document does.
 */
function collectTagUses(scene: unknown, resolve?: ResolvePackage): TagUse[] {
  const specs = sceneParamSpecs(scene, resolve)
  const uses: TagUse[] = []
  for (const part of sceneParts(scene)) {
    const pid = typeof part.packageId === 'string' ? part.packageId : undefined
    if (pid === undefined) continue
    const pkg = specs.get(pid)
    if (pkg === undefined) continue
    const params = isRecord(part.params) ? part.params : {}
    for (const [key, spec] of Object.entries(pkg.params)) {
      const s = spec as ParamSpec
      if (s.type !== 'tag') continue
      const value = params[key]
      if (typeof value !== 'string' || value === '') continue
      uses.push({
        tag: value,
        dir: s.dir === 'out' ? 'out' : 'in',
        stType: s.stType ?? 'BOOL',
        partLabel: partLabel(part),
        packageId: pid,
        key,
      })
    }
  }
  return uses.sort((a, b) => a.tag.localeCompare(b.tag) || a.partLabel.localeCompare(b.partLabel))
}

function tagTable(uses: readonly TagUse[], door: GuideDoor): string {
  if (uses.length === 0) {
    return 'This scene wires no PLC tags yet. Set a part\'s tag parameter (any param of type `tag`) to a name, then drive that name from the ST program.\n'
  }
  const rows = uses.map(
    (u) =>
      `| \`${cell(u.tag)}\` | ${u.dir === 'in' ? 'program writes' : 'program reads'} | ${u.stType} | ${cell(u.partLabel)} (\`${cell(u.packageId)}\`) | \`${cell(u.key)}\` |`,
  )
  return [
    '| Tag | Direction | ST type | Part | Parameter |',
    '|---|---|---|---|---|',
    ...truncate(rows, 'tags', door),
    '',
    'A tag the **program writes** is an output of your ST program: assign it. That is how you command a',
    'device. A tag the **program reads** is produced by the part (a sensor, a counter, a running flag): read',
    'it, never assign it. Either can be an ordinary `VAR` of the program, whose direction the wiring gives',
    '(as a variable on a real PLC has none of its own); declaring it `VAR_OUTPUT` / `VAR_INPUT` states',
    `the direction in the program too, and then the wiring check (${door === 'tools' ? '`get_problems`' : '`npm run check-wiring`'}) catches a tag wired`,
    'the wrong way round. That is the most common mistake here, and nothing at the ST level catches it.',
    '',
  ].join('\n')
}

/**
 * How a part is resized, derived from the drag handles its params declare. Sizing is per-package,
 * not a universal `length`. A belt conveyor has no `length` param at all; it is shaped by `segments`,
 * a list of [run, tilt] rows. An agent that edits a `length` param changes nothing and sees no error.
 */
function sizedBy(params: ParamSchema): string {
  const out: string[] = []
  for (const [key, spec] of Object.entries(params)) {
    const handle = (spec as ParamSpec).handle
    if (!handle) continue
    if (handle.kind === 'path') {
      const len = handle.lengthCol ?? 0
      const tilt = handle.tiltCol ?? 1
      out.push(`\`${cell(key)}\` (rows of [${len === 0 ? 'run' : `col${len}=run`}, ${tilt === 1 ? 'tilt' : `col${tilt}=tilt`}])`)
    } else if (handle.kind === 'arc') {
      out.push(`\`${cell(key)}\` (arc)`)
    } else if (handle.kind === 'flexPath') {
      out.push(`\`${cell(key)}\` (path points, dragged) + \`${cell(handle.lengthParam)}\` (length, derived)`)
    } else if (handle.kind === 'face') {
      const along = handle.axis === 'x' ? 'length' : handle.axis === 'z' ? 'width' : 'height'
      out.push(`\`${cell(key)}\` (${along})`)
    }
  }
  return out.length === 0 ? '—' : out.join(', ')
}

/** Round to millimetres - the extents come from float geometry and long decimals read as false precision. */
function mm(n: number): string {
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

/**
 * A part's span about its own `position`, e.g. `x -0.25..4.25, y 0..0.5, z -0.762..0.762`.
 *
 * Expressed as a span rather than a size, because the span answers both questions an
 * agent has to get right at once: how big the part is, and where its origin sits inside it. A span
 * starting at 0 is a tail-origin part; one symmetric about 0 is centre-origin. No prose needed.
 */
function extentSpan(e: PartExtent): string {
  const cx = e.cx ?? 0
  const cz = e.cz ?? 0
  return `x ${mm(cx - e.hx)}..${mm(cx + e.hx)}, y ${mm(e.y0)}..${mm(e.y1)}, z ${mm(cz - e.hz)}..${mm(cz + e.hz)}`
}

/** What is placeable in this project: the packages its scene's parts already use, with their editable params. */
function packageTable(scene: unknown, door: GuideDoor, measure?: MeasureExtent, resolve?: ResolvePackage): string {
  const specs = sceneParamSpecs(scene, resolve)
  if (specs.size === 0) return '_This scene uses no part packages yet._\n'
  // Measured from the first placed instance of each package, so the numbers describe parts that exist
  // in this scene at their real parameters rather than a hypothetical default.
  const sample = new Map<string, ScenePart>()
  if (measure) {
    for (const part of sceneParts(scene)) {
      const pid = typeof part.packageId === 'string' ? part.packageId : undefined
      if (pid !== undefined && !sample.has(pid)) sample.set(pid, part)
    }
  }
  const extents = new Map<string, PartExtent>()
  for (const [pid, part] of sample) {
    let e: PartExtent | null
    try {
      e = measure!(part)
    } catch {
      e = null // an unmeasurable part is a missing cell, never a broken guide
    }
    if (e) extents.set(pid, e)
  }
  const anyExtent = extents.size > 0

  const rows: string[] = []
  for (const [id, pkg] of [...specs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const editable = Object.entries(pkg.params)
      .filter(([, s]) => (s as ParamSpec).hidden !== true)
      .map(([key]) => key)
    const extentCell = anyExtent ? ` ${extents.has(id) ? cell(extentSpan(extents.get(id)!)) : '—'} |` : ''
    rows.push(
      `| \`${cell(id)}\` | ${cell(pkg.name)} |${extentCell} ${cell(sizedBy(pkg.params))} | ${editable.length === 0 ? '—' : editable.map((k) => `\`${cell(k)}\``).join(', ')} |`,
    )
  }
  return [
    anyExtent
      ? '| Package | Name | Extent about its position (m) | Shape handles | Parameters you may set |'
      : '| Package | Name | Shape handles | Parameters you may set |',
    anyExtent ? '|---|---|---|---|---|' : '|---|---|---|---|',
    ...truncate(rows, 'packages', door),
    '',
    ...(anyExtent
      ? [
          '**Read the extent column before you place anything.** It is measured from the first instance of that',
          'package already in this scene, and it is where most placement mistakes come from: a part is a VOLUME,',
          'not a point, and its origin is not always in the middle of it. A span like `x -3..3` is centred on its',
          '`position`; a span like `x 0..4` starts at it and runs +X. A part whose span is much larger than you',
          'assumed will overlap its neighbours, and nothing will tell you.',
          '',
          'The numbers move with the parameters, so treat them as true of THAT instance, not of the package.',
          '',
        ]
      : []),
    '"Shape handles" are the params the editor resizes by DRAGGING, which is the reliable way to tell which',
    'param changes a part\'s extent. A dash means the part declares none. Other params may still affect its',
    'size (a chain transfer sets its own lane count and length), so read the parameter list too.',
    '',
  ].join('\n')
}

function partInventory(scene: unknown, door: GuideDoor): string {
  const parts = sceneParts(scene)
  if (parts.length === 0) return '_This scene is empty._\n'
  const counts = new Map<string, number>()
  for (const p of parts) {
    const key = typeof p.packageId === 'string' ? p.packageId : typeof p.type === 'string' ? p.type : '(unknown)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, n]) => `| \`${cell(id)}\` | ${n} |`)
  return [`${parts.length} part${parts.length === 1 ? '' : 's'}:`, '', '| Package / type | Count |', '|---|---|', ...truncate(rows, 'kinds', door), ''].join('\n')
}

/**
 * Render the guide for one saved project.
 *
 * `doc` is the already-serialized document plus the folder paths each scene was written to, so the
 * file can point at real paths rather than describing a layout in the abstract.
 */
export function agentGuideMarkdown(doc: GuideDoc, opts?: { measure?: MeasureExtent; resolve?: ResolvePackage; door?: GuideDoor }): string {
  const name = doc.name !== undefined && doc.name !== '' ? doc.name : 'Untitled project'
  const s = doc.scene
  const testCount = doc.tests?.length ?? 0
  // the agent reads this through the app's MCP tools (get_guide), not as a file beside the project's own
  const door = opts?.door ?? 'files'
  const tools = door === 'tools'

  const out: string[] = []
  const w = (...lines: string[]): void => void out.push(...lines)

  if (tools) {
    w(
      `# ${name} - agent guide`,
      '',
      'This project is an industrial simulation: a 3D scene of conveyors and machines, driven by an IEC 61131-3',
      '**Structured Text** program. You are driving the editor the user has open, through its MCP tools. Every edit',
      'is an ordinary edit: one undo step labelled `Agent: ...` that the user sees and can take back, saved to the',
      "project's folder like theirs. Everything below is derived from the open project.",
      '',
      '## What you can do with the tools',
      '',
      '| Task | Tools |',
      '|---|---|',
      '| Write or edit the ST program | `set_program` (the whole text), or `list_pous` / `get_pou` / `set_pou` one POU at a time; `check_program` without keeping it |',
      '| Write, keep and run tests | `run_test` (a spec, or every kept test), `save_test`, `list_tests` |',
      '| Place, move and retune parts | `list_catalog`, `get_package`, `add_part`, `snap_part`, `update_part`, `duplicate_parts`, `delete_parts` |',
      '| Wire parts to the program | a part\'s tag params (`update_part`), `rename_tag`, `assign_io` |',
      '| A part type the catalog lacks | `get_part_sdk`, `check_part`, `create_part`, `edit_part_definition` |',
      '| Bring in and teach a robot | `import_robot` (a .urdf or .xacro file), `solve_robot_pose` (the joint row that puts its grip point at a point, tool down), `get_robot_pose`; then `update_part` on its `waypoints`, `waypointNames`, `jobs` and `tool` |',
      '| See and operate the line | `capture_view`, `run` / `stop`, `get_tags`, `set_tag`, `trace_tags`, `get_cargo` |',
      '| Stop the live sim on a moment, look, step on | `pause`, `step` (`steps`, `seconds`, or `until` a sim time), `resume`; paused, `get_cargo` adds velocity and what each box touches |',
      '| See the cargo at a known sim time | `run_test` with `cargo` (position, tilt, velocity, what each box touches) and `trace`: the same run every time |',
      '| Another project | `list_projects`, `open_project`, `new_project` |',
      '',
      '## The project folder',
      '',
      'On the desktop the project lives in a folder, kept in sync with the editor both ways: your tool edits are',
      'written to it a moment after, and a file written there loads into the editor. Both are the project, so use',
      'whichever suits the edit. If you also write files there, call `sync_folder` after writing and before the next',
      'tool: it loads them at once and says what loaded. Loading a change to the scene, the program or a part',
      'rebuilds the scene and stops a running sim (`stoppedRun`), so `run` again after it. Editing the same file both ways',
      'between syncs is a conflict that waits for the person.',
      '',
      'The live sim (`run`, `get_cargo`, `trace_tags`) runs on wall-clock time, so where it has got to depends on',
      'when you look. To look closely at something you saw, `pause` it and `step` on. To see what happens at a known',
      'time the same on every run, write a spec and use `run_test` with `cargo` and `trace`.',
      '',
      '## The program',
      '',
      'The program is one text, in POUs: every `TYPE`, `VAR_GLOBAL` and POU comes before the code outside every POU,',
      '`program` in `list_pous`, which comes last (only a `CONFIGURATION` may follow it). Without a task table the',
      "`PROGRAM`s run in that order on one task every scan. `set_pou` keeps the order; `set_task` retimes a task.",
      '',
    )
    if (s.controller) {
      const [p, t] = [s.controller.programs.length, s.controller.tasks.length]
      w(`This project runs ${p} program${p === 1 ? '' : 's'} on ${t} task${t === 1 ? '' : 's'} (\`get_program\` lists them).`, '')
    }
    w(
      'The code outside every `PROGRAM` holds the controller\'s tags: every `PROGRAM` can use them, and they keep their',
      'bare names. A `PROGRAM` instance\'s own variables are addressed as `Instance.Name`, on part tags too: a part wires',
      'to `Merge1.Motor`, not `Motor`. One exception: when the controller runs exactly ONE program instance, its',
      'variables also answer to their bare names, so a program that is just one `PROGRAM Main ... END_PROGRAM` drives',
      'parts wired to `Motor`. Wire each variable by one name only.',
      '',
      'A tag the program reads from outside the scene (an operator panel, a SCADA) is a `VAR_INPUT`: that is what a',
      "test's `inputs` and `set_tag` reach. `get_problems` warns that nothing in the scene drives it, which is expected.",
      '',
    )
    if (s.stDialect !== undefined && !isKnownDialect(s.stDialect)) {
      w(`The program is marked as the "${s.stDialect}" dialect, which this version cannot run: leave it as it is.`, '')
    }
  } else {
    w(
      `# ${name} - agent guide`,
      '',
      '<!-- GENERATED by Open Industry Project when this project was saved. Rewritten on every save,',
      '     so hand edits are lost. Everything below is derived from THIS project. -->',
      '',
      'This folder is an industrial simulation: a 3D scene of conveyors and machines, driven by an',
      'IEC 61131-3 **Structured Text** program. Edit these files with ordinary file edits. While the',
      'project is open in the app, the app loads a changed file within about a second.',
      '',
      '**The app keeps this folder in sync both ways.** What you write here loads into the app, and what the user',
      'changes in the app is written back here a moment later. A file changed in both places, differently, is a',
      'conflict: nothing moves until the user picks a version. So read a file again before you rewrite it.',
      'Loading a change to the scene, the program or a part rebuilds the scene in the app and',
      'stops a running sim. Through the app\'s MCP tools, `sync_folder` loads your file edits at once and says what loaded.',
      '',
      '## What you can and cannot do from these files',
      '',
      '| Task | Status |',
      '|---|---|',
      '| Write or edit the ST control program | **Supported.** This is the strongest path: text, with a published grammar and a real test loop. |',
      '| Write or edit tests | **Supported.** Tests are declarative JSON and the user can run them in the app. |',
      '| Retune an existing part (parameters, tag names) | **Supported.** Edit `params` on the part in the scene file. |',
      '| Move or add a part of a type already in the scene | **Possible, but unverified.** Nothing checks geometry. See *Placement* below. |',
      '| Add a part type this project does not already contain | **Not possible from files alone.** See *Placement*. |',
      '',
    )

    w('## Layout', '', '```')
    w('project.json                 the manifest: name, file references, and the program\'s settings')
    w(`${s.scenePath.padEnd(28)} the scene: its parts (their packages: parts/)`)
    const programPaths = s.programPaths ?? []
    if (programPaths.length > 0 && s.stDialect !== undefined && !isKnownDialect(s.stDialect)) {
      // a program this build cannot read: say so rather than describe it as Structured Text an agent may edit
      for (const path of programPaths) {
        w(`${path.padEnd(28)} its program, in the "${s.stDialect}" dialect, which this version of the app cannot run: leave it as it is`)
      }
    } else if (programPaths.length > 0) {
      const shown = programPaths.length > PROGRAM_FILES_LISTED ? programPaths.slice(0, PROGRAM_FILES_LISTED - 1) : programPaths
      for (const path of shown) w(`${path.padEnd(28)} ${programFileRole(path)}`)
      if (shown.length < programPaths.length) w(`${''.padEnd(28)} ... and ${programPaths.length - shown.length} more: the manifest's "program" lists them all`)
    } else if (s.stDialect !== undefined && !isKnownDialect(s.stDialect)) {
      // no program, but a dialect this build does not run: a program written here would not run either
      w(`${''.padEnd(28)} no program yet; it is marked as the "${s.stDialect}" dialect, which this version of the app cannot run`)
    }
    if (s.controller) {
      const [p, t] = [s.controller.programs.length, s.controller.tasks.length]
      w(`${''.padEnd(28)} runs ${p} program${p === 1 ? '' : 's'} on ${t} task${t === 1 ? '' : 's'}: its "controller" in project.json`)
    }
    if (testCount > 0) w('tests/*.test.json            one declarative test per file')
    w('```', '')
    w(
      'Files this manifest does not reference are ignored, so this guide is inert to the app.',
      '',
      '### Adding a file',
      '',
      '**Creating a file is not enough: `project.json` must reference it, or the app never loads it.** This is',
      'the most common way an edit here silently does nothing, and the failure does not name its own cause: a',
      'program that was never loaded reports as *"tag ... never appeared"*, which reads like a typo in a tag name.',
      '',
      'The PLC program is one file per block under `plc/`, and the manifest\'s `program` lists them IN ORDER. The app joins',
      'them in that order into one program, so the order is the program\'s: list every `TYPE`, `VAR_GLOBAL` and POU file',
      'before `plc/program.st` (the code outside every POU, which comes last; only a `CONFIGURATION` may follow it), and',
      'without a `controller` the `PROGRAM`s run in the order listed. A file holds ONE block (a `FUNCTION_BLOCK`,',
      '`FUNCTION`, `PROGRAM`, `INTERFACE`, `CONFIGURATION`, `TYPE` or `VAR_GLOBAL` block), named for what it declares',
      '(`plc/Merge.st`), or for its keyword when it declares no name (`plc/type.st`, `plc/var_global.st`). A `.st` file is',
      'Structured Text; a `.ld` file holds a `LADDER` section (below). Whenever the app has the folder open it lays the',
      'program out by these rules, so files you write in another shape are rewritten into them: that is expected.',
      'To add a function block, write `plc/Latch.st` and list it before `plc/program.st`:',
      '',
      '```json',
      '{ "version": 7, "name": "Line", "scene": "scene.json", "program": ["plc/Latch.st", "plc/program.st"] }',
      '```',
      '',
      'The project can also run several programs, each on its own task. Write each one as a `PROGRAM Name ... END_PROGRAM`',
      'in a file of its own, with no `CONFIGURATION`, and list the tasks and program instances in the manifest\'s `controller`:',
      '',
      '```json',
      '{ "version": 7, "name": "Line", "scene": "scene.json", "program": ["plc/Merge.st", "plc/program.st"],',
      '  "controller": {',
      '    "tasks": [{ "name": "Fast", "intervalMs": 10, "priority": 1 }, { "name": "Slow", "intervalMs": 100, "priority": 5 }],',
      '    "programs": [{ "name": "Main", "task": "Slow" }, { "name": "Merge1", "type": "Merge", "task": "Fast" }]',
      '  } }',
      '```',
      '',
      'Each task runs its programs every `intervalMs` of simulated time, and tasks due together run by `priority`, 0 first. A',
      'program with no `task` runs every physics step, after the periodic ones. The program with no `type` runs the code',
      'outside every `PROGRAM`: that code\'s variables are the controller\'s tags, every `PROGRAM` can use them, and they keep',
      'their bare names. A `PROGRAM` instance\'s own variables are addressed as `Instance.Name`, on part tags too: a part wires',
      'to `Merge1.Motor`, not `Motor`. Without a `controller` it runs all of the file on one task every `stScanMs`:',
      'the top-level code, and each `PROGRAM` as an instance named after it. One exception: when the controller runs',
      'exactly ONE program instance, its variables also answer to their bare names (`Motor` and `Main.Motor` are the same',
      'variable), so a file that is just one `PROGRAM Main ... END_PROGRAM` drives parts wired to `Motor`. Wire each',
      'variable by one name only.',
      '',
      'The manifest may also carry `"stDialect"`, the language family the program is written in. Absent means IEC 61131-3,',
      'the only one this version runs. Leave it as you find it: never add or change it (that relabels code, it does not',
      'convert it). A program in any other dialect is kept unchanged and refused at Play.',
      '',
      'The manifest may also carry `"simHz"`, a whole number from 60 to 1000: the physics step rate, and so how soon a PLC',
      'output can follow an input (one step). Absent means 60. A test runs at that rate, like the app.',
      '',
      'The scene may carry `"units"`, `"imperial"` or `"metric"` (the default when absent): how the app shows every',
      'speed, and every conveyor\'s units switch (`fpmUnits`: its speed and REAL speed tag in feet per minute, or in m/s).',
      'It may also carry `"lengthUnit"`, `"m"`, `"mm"` or `"in"`: the unit the app shows every length in, display only.',
      'One scene, one convention: give every `fpmUnits` in the scene the value its `units` says.',
      'To change the scene\'s units, do it in',
      'the app (with nothing selected, the Inspector shows the scene\'s Speed, and changing it',
      'converts every conveyor and moves its speed tag), or by hand: convert each speed, move each speed tag binding',
      'with it, and then change the speed values the program writes.',
      '',
      'To add a test, write `tests/<name>.test.json` and list it in the manifest\'s top-level `tests` array:',
      '',
      '```json',
      '{',
      '  "version": 7,',
      '  "name": "My Project",',
      '  "scene": "scene.json",',
      '  "program": ["plc/program.st"],',
      '  "tests": ["tests/my-test.test.json"]',
      '}',
      '```',
      '',
      'One asymmetry to know about: the `test-project` CLI also runs a `tests/` file the manifest does not list',
      '(with a note), so an unreferenced test still runs there. The app does not. Register it, or it passes for',
      'you and does not exist for the person you are writing it for.',
      '',
    )
  }

  const activeSceneJson = s.scene
  w('## PLC tags in this scene', '')
  w(
    'These are the names this scene actually wires. They are chosen by whoever placed the parts, so no',
    'catalog or type definition knows them. This table is the only place they are written down.',
    '',
    'A tag may name the controller it belongs to: `Cell2::%IX0.0` is %IX0.0 on the PLC called Cell2, and `Cell2::Eye` is',
    "Cell2's tag Eye. A tag with no name belongs to the default controller. Each controller runs in the simulator or on a",
    'PLC outside this app. A simulated one runs its own tasks (`plc` on a task) and the program instances on them, on',
    "memory of its own, and reads and drives only its own tags. The default controller's program never sees another's",
    "tags. Keep a cell's parts on one controller, and put the name on every one of",
    'their tags. A tag left without it goes to the default controller, and the program then reports it as wired but never',
    'declared.',
    ...(door === 'tools' ? ['`list_controllers` lists them; `assign_controller` moves a set of parts onto one, after `duplicate_parts` for instance; `set_controller` runs one in the simulator; `run_instance_on` gives it a program instance.'] : []),
    '',
  )
  w(tagTable(collectTagUses(activeSceneJson, opts?.resolve), door))

  w('## Part packages available in this scene', '')
  if (tools) {
    w(
      "Every package the scene uses is this project's own copy. `list_catalog` lists what can be placed and",
      '`get_package` one in full: each param, what a tag\'s values mean, and its frame (footprint, where the origin',
      'sits, conveying ends, sensor zones and beams). To seat a device on a placed part (an eye on a guard, a lane',
      'on a belt\'s side), use `snap_part`: it runs the editor\'s own snap and fits the params, so you never compute',
      'guard offsets or beam ranges by hand. A part type the catalog lacks is `create_part` (`get_part_sdk` first).',
      '',
    )
  } else {
    w(
      'A part names its package by `packageId`, and every package the scene uses is this project\'s own copy, kept',
      'once in `parts/<slug>/` (`manifest.json` + `behavior.js`): the app\'s **built-in** parts too (`npm run catalog`',
      'in an oip-web checkout lists their ids), each recording in `origin.app` which version of the built-in it is, so',
      'the app can say when it updates one and never changes this project by itself. Don\'t edit `origin`. A part',
      'naming a package that is neither in `parts/` nor a built-in is rejected at load. So you can freely place more',
      'of anything listed here (copy an existing entry in the scene file and change its `id` and `position`), and any',
      'built-in by its id: the app copies it into `parts/` on its next save. But a package of your own is',
      'not something to write by hand: from an oip-web checkout, `npm run add-part -- <this folder> <part folder>`',
      "adds a custom part to the project. Without a checkout, ask the user to place one in the app and save.",
      'To seat a device on a placed conveyor (an eye on its guard, a button on its frame), use `npm run snap-part --',
      '<part> --project <this folder> --host <placed id> --write`: it runs the editor\'s own snap and writes the pose',
      'and fitted params, so you never compute guard offsets or beam ranges by hand.',
      '',
    )
  }
  w(packageTable(activeSceneJson, door, opts?.measure, opts?.resolve))

  w('## What is in the scene now', '')
  w(partInventory(activeSceneJson, door))

  w(
    '## Writing the Structured Text program',
    '',
    'The engine implements a deliberate **subset** of IEC 61131-3. The authoritative, machine-readable',
    `list of accepted types, operators, functions and function blocks is published at:`,
    '',
    `    ${ST_CAPABILITIES_URL}`,
    '',
    'It is generated by probing the engine itself, so it is what the compiler actually accepts rather',
    'than a description of it. Read it before using anything beyond the common core.',
    '',
    '**Prefer what has been externally verified.** That manifest carries an `oracleCoverage` section',
    'grading the accepted surface: features a real IEC compiler has compiled AND RUN, features only',
    'compiled (a 2nd-edition compiler refuses them by design, so nothing ever executed them), and',
    'features only this engine has ever seen. Unverified does not mean broken. It means unwitnessed, and',
    'the difference matters because the whole point of writing ST here is that it moves to real hardware.',
    'Where a program can be written either way, write it with the EXECUTED list. Where it cannot, say so',
    'in your summary rather than leaving the user to discover it on a controller.',
    '',
    'Shape of a program (declaration blocks, then the body, which runs top to bottom every scan):',
    '',
    '```',
    'VAR_INPUT',
    '  Sensor : BOOL;      (* a tag the parts produce *)',
    'END_VAR',
    'VAR_OUTPUT',
    '  Motor : BOOL;       (* a tag the parts consume *)',
    'END_VAR',
    'VAR',
    '  DelayOff : TON;     (* standard function blocks are available *)',
    'END_VAR',
    '',
    'Motor := Sensor;',
    '```',
    '',
    '**Durations and dates are types, not numbers.** `TIME` (`T#1s500ms`), `DATE` (`D#2024-02-29`),',
    '`TOD` (`TOD#07:30:00`) and `DT` (`DT#2024-02-29-07:30:00`) each compare only with their own kind. The',
    'arithmetic is IEC\'s table and nothing more: a `TOD` or `DT` plus or minus a `TIME`, and the difference of',
    'two `DATE`s, `TOD`s or `DT`s, which is a `TIME` (so `tod + T#1h` works, and `DATE + TIME` and',
    '`TIME + TOD` do not). The same as functions: `ADD_TIME`, `SUB_TOD_TOD`, `CONCAT_DATE_TOD`, `MULTIME`,',
    '`DIVTIME`, and the rest of IEC\'s set. A `TOD` pushed past midnight, or a date before 1970, FAULTS the',
    'scan. Never convert a date or time to a number (`DATE_TO_DINT` is refused: targets count it in different',
    'units, and `TIME_TO_DINT` is whole seconds on MATIEC). Keep it in its own type: compare a `DATE` or `TOD`',
    'with a literal (`t >= TOD#06:00:00`), and subtract two `DT`s for a `TIME` to compare (`now - started >= T#5m`).',
    'Nothing reads today\'s date: IEC has no such function.',
    '',
    '**Calls.** A user `FUNCTION` called formally may leave an input out, and it takes its declared initial',
    'value: `Scale(v := 5)`. Give an input that declares no initial value anyway, since OpenPLC\'s compiler',
    'refuses leaving it out. A standard function may be called formally by IEC\'s names (`LIMIT(MN := 0,',
    'IN := x, MX := 10)`, `MID(IN := s, L := 3, P := 2)`), but **write them in the standard order**:',
    'OpenPLC\'s compiler binds a standard function\'s arguments by position and ignores the names, so',
    '`LIMIT(MX := 9, IN := x, MN := 0)` silently swaps the limits there. Export warns about it.',
    '',
    '**Names the targets reserve.** A variable named `S` or `R`, after an IL operator (`ADD`, `LT`,',
    '...), an SFC keyword (`STEP`, `ACTION`, ...) or a date type (`DT`, `TOD`, `DATE`) builds here and not',
    'on every target. `dt` for a time step is the common one: call it `stepTime`.',
    '',
    'Logic can also be a ladder diagram, written where statements stand as a `LADDER ... END_LADDER` section,',
    'one rung per `;`. The text draws the IEC symbols: `|x|` a contact, `|/x|` a normally closed one, `|P x|`',
    '/ `|N x|` an edge; `(x)` a coil, `(/x)`, `(S x)`, `(R x)`; series is juxtaposition, a branch `[path, path]`;',
    'a block sits on the rung by the pin named bare (`T1(IN, PT := T#2s)`), a function by EN',
    '(`ADD(IN1 := n, IN2 := 1, OUT => n)`). A function with a BOOL result STARTS a rung when its `OUT` is bare',
    '(`EQ(IN1 := Step, IN2 := 10, OUT)`): nothing feeds it, so it stands at the left rail, which is how a rung',
    'tests a number. A POU whose whole body is one section exports as a PLCopen `<LD>`',
    'body. For a program bound for another tool, end each rung at its coils (nothing after a coil), use no',
    '`(P x)` / `(N x)` coils, keep a comparison off a branch and to two operands: some importers do not take',
    'those, and the export says so.',
    '',
    '```',
    'LADDER',
    '  [|Start|, |Motor|] |/Stop| (Motor);',
    '  EQ(IN1 := Step, IN2 := 10, OUT) |/Moving| MOVE(IN := 20, OUT => Step);',
    'END_LADDER',
    '```',
    '',
    'A rung may carry a label and may END in a jump or a RETURN, each acting on what reaches it. While',
    '`|Manual| >>Done;` has power, the rungs down to the one labelled `Done:` are not evaluated at all, so',
    'their coils HOLD what they last wrote; `|Fault| RETURN;` skips the rest of the POU for that scan. Jumps go',
    'DOWN a section only (a jump back up is a loop, and is refused), to a label in the same section, and a',
    'jump or RETURN never stands inside a branch. A `(* comment *)` above a rung is that rung\'s comment and',
    'travels with it into the PLCopen export.',
    '',
    '```',
    'LADDER',
    '  (* hand mode steps over the automatic rungs *)',
    '  |Manual| >>Done;',
    '  |Eye| (Stop);',
    '  |/Eye| (Run);',
    '  Done: |Estop| RETURN;',
    'END_LADDER',
    '```',
    '',
    'A state machine written as rungs tests the step ONCE, from a copy taken before the state rungs',
    '(`MOVE(IN := Step, OUT => stepNow)`), or a rung that moves the step on lets a later rung run in the same',
    'scan, which is not what a `CASE` does.',
    '',
    '**A caution worth taking seriously.** A program compiling here does not prove it runs on a physical',
    'controller. The subset is close to the standard on purpose, but it is a subset, and vendor toolchains',
    'differ. Treat "it simulates correctly" as the claim, and validate on the target before trusting it on',
    'real hardware.',
    '',
  )

  w(
    '## Writing tests',
    '',
    ...(tools
      ? [
          'A test is a JSON spec. `run_test` runs it against the open scene, unsaved edits included; `save_test` keeps it',
          'in the project, where the user runs it too (Run Project Tests). It runs the scene for `duration` simulated',
          'seconds against real physics and the real ST scan, pokes any `inputs`, and asserts every `checks` entry.',
        ]
      : [
          'A test is one JSON file in `tests/`, **referenced from `project.json`** (see *Adding a file* above:',
          'an unreferenced test is invisible to the app, which is what runs it for the user). It runs the scene for',
          '`duration` simulated seconds against real physics and the real ST scan, pokes any `inputs`, and asserts',
          'every `checks` entry.',
        ]),
    '',
    '```json',
    '{',
    '  "name": "motor starts and keeps running",',
    '  "duration": 5,',
    '  "inputs": [{ "at": 0.5, "tag": "Start", "value": true }],',
    '  "checks": [',
    '    { "tag": "Motor", "at": 1, "equals": true },',
    '    { "tag": "Motor", "always": true, "equals": true },',
    '    { "probe": { "count": {} }, "eventually": true, "min": 3 }',
    '  ]',
    '}',
    '```',
    '',
    'Each check names exactly one **source**, one **timing** and one **predicate**:',
    '',
    '- source: `tag` (a PLC tag by name) or `probe` (`{"count":{…}}` for cargo counts, `{"passed":{"zone":{…}}}` for how many boxes have gone through a place so far, `{"square":{"zone":{…},"heading":30}}` for how far the worst box in a zone is turned off square to a heading in degrees (0 to 45; a spur\'s rotationY in degrees, checked with `always` + `max`), `{"pose":{"part":"<id>","axis":"x|y|z|yaw"}}` for a part\'s position, `{"joint":{"part":"<id>","joint":"<name>"}}` for the last value a part\'s behavior commanded on one of its rig joints (radians or metres), `{"lamp":{"part":"<id>","lamp":"<name>"}}` for whether a part\'s lamp is lit, checked with `equals: true` or `false`); `count`, `passed` and `square` take `"color": "red"|"green"|"blue"|"#rrggbb"`',
    '- timing: `at` (sample once at time *t*), `always` (must hold), or `eventually` (must hold at some point); `always` and `eventually` take a window, `from` / `until` (default: the whole run)',
    '- predicate: `equals`, `notEquals`, `min`, `max`, or `near` (with an optional `tolerance`), each against a value or another tag or probe: `"equals": {"tag": "Lane1Out"}`',
    '',
    'Prefer counts that do not depend on WHEN boxes arrive: `passed` with a colour ("no red box ever passed lane 2":',
    '`always` + `max: 0`), one tag against another ("Sorted1 equals Lane1Out"), a window round the state you mean.',
    'An exact count at an exact time breaks the moment an unrelated change moves the boxes by a tenth of a second.',
    tools
      ? '`run_test` with `cargo: [5, 10]` lists where every box is at those sim times, and how far it is tilted, the same on every run: use it to follow a box that tips or falls. `get_cargo` during a live `run` shows the boxes now, at wall-clock pace. A `passed` gate counts only from the moment some box enters it, so "nothing ever gets here" is `count` + `always` + `max: 0` instead.'
      : '`npm run test-project -- <folder> --cargo 5,10` lists where every box is at those times, and how far it is tilted.',
    '',
    'Optional: `scanMs` (the PLC scan period).',
    '',
    '### Failing a device on purpose',
    '',
    'A test can also make a device FAIL partway through, to prove the program notices and reacts safely. `faults`',
    'sits beside `inputs`; each entry names a part by id and fails it from `at` until `until` (or the end):',
    '',
    '```json',
    '"faults": [',
    '  { "at": 1, "until": 2.5, "part": "m1", "kind": "actuatorDead" },',
    '  { "at": 4, "part": "pe1", "kind": "sensorStuck", "value": false },',
    '  { "at": 6, "until": 7, "kind": "commsLoss", "statusTag": "IoFault" },',
    '  { "at": 8, "until": 12, "kind": "jam", "zone": { "min": [2.4, 0.8, -0.7], "max": [2.8, 1.4, 0.7] } }',
    ']',
    '```',
    '',
    '- `actuatorDead`: the device stops receiving the program\'s commands (a tripped motor): what it reads off its',
    '  `dir: "in"` tag params is false / 0. The program still believes it commanded the device, so assert on what',
    '  the program does about the missing feedback (a fault bit, the command dropped), not on the command itself.',
    '- `sensorStuck`: the device\'s BOOL `dir: "out"` tags read `value` to the program whatever it senses (a',
    '  failed photo eye, a broken wire). A check on that tag reads the stuck value, as the program does.',
    '- `commsLoss`: the I/O connection drops, for one device (`part`) or all of them (no `part`). `outputs` is',
    '  what the devices receive and `inputs` what the program reads: `"off"` (the default) or `"hold"` (the last',
    '  value). `statusTag` names a program input that reads true while the link is down: the connection-fault',
    '  bit to handle it with. Lost inputs that HOLD look exactly like a quiet line, so that bit is the only tell.',
    '- `jam`: the first loose box whose CENTRE enters `zone` (world metres) stops dead there, and the line backs',
    '  up behind it for real; at `until` it is let go where it stands. It touches no tag, so the program can only',
    '  notice through its sensors (an eye blocked too long while the belt runs). A jam that catches nothing fails',
    '  the run, so put the zone on the boxes\' path, sized to where their centres pass.',
    '',
    'A fault only finds a device\'s tags through its declared tag params, so a part that names its tags any other',
    'way cannot be faulted and the run says so. Pair every fault with a check that the line RECOVERS once it',
    'clears (or that it deliberately stays stopped until a reset): handling that latches forever passes every',
    '"it stops" check.',
    '',
    '**Write tests as you go.** They are the only verdict the user can get without reading your work line by',
    'line, and the only part of your output that keeps its value after this session. A change without a test',
    'asserting the behaviour it was meant to produce is unfinished work here.',
    '',
    '### What to assert (the part that is easy to get wrong)',
    '',
    'Every other check in this project is structural: the document loads, the parts are seated, the tags connect,',
    'the program compiles. Those can all pass on control logic that is badly wrong, so the behavioural test is',
    'the only thing standing between a plausible program and a broken line. Writing one that agrees with your own',
    'mistake is the failure mode to guard against, and it is easy, because you write both.',
    '',
    '**Assert that things START again, not only that they stop.** An interlock that never releases satisfies every',
    'test of the form "it stops when X". A worked example: holding a conveyor while two sensors are blocked reads',
    'as correct, and deadlocks. The conveyor is what CLEARS those sensors, so once both block they stay blocked',
    'and the line never restarts. A test asserting "the conveyor stops" passes. A test asserting "the conveyor is',
    'still running later" is what catches it.',
    '',
    'So pair them: the first says it stops (safety), the second says it recovers (liveness). Both are needed.',
    'The first alone is satisfied by a line that stopped for good:',
    '',
    '```json',
    '"checks": [',
    '  { "tag": "Feed", "eventually": true, "equals": false },',
    '  { "tag": "Feed", "at": 18, "min": 0.1 }',
    ']',
    '```',
    '',
    '**A check that would pass without your change proves nothing about it.** Before trusting a green run on a',
    'project that already worked, ask whether the same assertion passed BEFORE you touched it. If it did, it is',
    'not testing your change. It is testing the parts that already worked.',
    '',
    '**Prefer asserting the OUTCOME over the mechanism.** `{"probe": {"count": {}}}` (cargo actually moved,',
    'arrived, accumulated) is far harder to satisfy accidentally than a tag holding the value you just wrote to',
    'it. A tag check can confirm your program did what your program says; a probe confirms the line did something.',
    '',
    ...(tools
      ? [
          '**When a test fails, read what happened before changing anything.** The run is deterministic, so run it',
          'again with `trace: ["A", "B"]`: each tag\'s value at the start and every change with its time, through the',
          'whole run. That is also how to read a value without writing a check for it. A failed test lists the flow',
          'facts before its failure (a box tipped, an eye flickered). Decide from them whether the PROGRAM or the TEST',
          'is wrong before editing either.',
        ]
      : [
          '**When a test fails, read what happened before changing anything.** The run is deterministic, and',
          '`npm run test-project -- <folder>` prints, under each failed check, every tag that changed in the 3 s',
          'before it failed: its value then, and each change with its time (`Stop  FALSE -> 1.517s TRUE`). That is',
          'usually the cause. `--context <s>` widens or narrows the window; `--trace A,B,C` (or `--trace all`) follows',
          'tags through the whole run; `--json` gives all of it as data. Decide from it whether the PROGRAM or the',
          'TEST is wrong before editing either.',
        ]),
    '',
  )

  w(
    '## Placement, units and conventions',
    '',
    '- Distances are **metres**. `position` is `[x, y, z]` with **+Y up**. `rotationY` is in **radians** about +Y,',
    '  positive turning counter-clockwise seen from above: at π/2 a part\'s local +X (downstream) points at world -Z.',
    '  The files always hold these units: in a scene whose `units` is imperial the app SHOWS inches and feet per',
    '  minute, but that is display only, so never convert a length or position you write because of it.',
    '- **Resize a part through a parameter it actually declares, not one you expect it',
    '  to have.** Sizing is per-package: a roller conveyor takes `length`, while a belt conveyor has no `length`',
    '  at all and is shaped by `segments`, a list of [run, tilt] rows. A parameter the package does not declare',
    ...(tools
      ? ['  is refused by `add_part` and `update_part`, with the params the package does have: read `get_package` first.']
      : [
          '  is dropped on load with no error in the app, so a wrong guess reads as "the edit did nothing". Run',
          '  `npm run validate-project -- <folder>` after editing: it lists every value loading dropped or clamped',
          '  (an unknown parameter, a number outside its range), and `--strict` fails on them.',
        ]),
    '- **Part origins differ by family, and this is the error that looks like a small gap rather than a bug.**',
    '  A roller/straight conveyor is **centre**-origin: a 4 m one spans -2 to +2 about its `position`. A belt',
    '  conveyor is **tail**-origin: its path starts at `position` and grows +X, so a 4 m run spans 0 to 4.',
    '  Placing a belt as though it were centred offsets it by half its length.',
    '- A belt also **overhangs its nominal run by about 0.085 m at each end** (the end pulley, half the belt',
    '  height), so a 4 m run occupies roughly 4.17 m. Two belts placed exactly one run apart already touch.',
    '- Coordinates in an existing scene are usually the output of interactive **snapping**, which is why they',
    '  carry long decimals. Copying a neighbouring part and adjusting from there is more reliable than',
    '  computing a position from scratch, and it inherits whatever origin convention that part follows.',
    '',
    '**Almost nothing checks geometry.** The one check that does is a seating check: a part whose package says it',
    'mounts onto a host, or seats into a conveyor bed, is reported when nothing is within reach of it. Everything',
    'else is unjudged. There is no verdict for a part left floating in',
    'the air, sunk into the floor, or overlapping its neighbour: the project will load, the tests may pass, and',
    'the scene will still be wrong. Treat layout edits as unverified until a human looks at them, prefer small',
    'relative adjustments over absolute placement, and say plainly in your summary which parts you moved.',
    '',
  )

  if (tools) {
    w(
      '## How your work gets checked',
      '',
      '1. `run_test` with no spec runs every kept test, as **Simulation > Run Project Tests** does for the user;',
      '   its `summary` says how many passed.',
      '2. `get_problems` reports what the Problems panel does: compile errors, wiring, parts, and the flow facts',
      '   of the last run.',
      '3. `capture_view` shows the line (by default every part but the building). Geometry is judged by eye, so look.',
      '',
      'The user reviews your steps in the app and can keep or revert them. Write tests accordingly.',
      '',
    )
  } else {
    w(
      '## How your work gets checked',
      '',
      '1. The user opens this project in the app (or it is already following this folder) and runs **Simulation > Run Project Tests**.',
      '2. Every spec in `tests/` runs against real physics, and reports pass or fail per check.',
      '',
      'That is the whole verification loop available from the files alone: the ST compiles or it does not, the tests',
      'pass or they do not, and geometry is judged by eye. Write tests accordingly.',
      '',
    )
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
