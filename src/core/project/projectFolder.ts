// The project folder codec: the on-disk, git/VS Code/agent-editable form of a ProjectJSON
// (docs/projects.md "The project folder"). One canonical layout (format 7):
//
//   project.json                  thin manifest: name + file refs + the program's small settings (no content)
//   scene.json                    the project's SceneJSON (its parts)
//   plc/<Name>.st | .ld           its PLC program as plain text, one file per POU, in the order the manifest's
//                                 `program` lists them (plc/programFiles.ts names them; `.ld` holds ladder)
//   parts/<id>/manifest.json      each authored library part, in the same two-file layout the desktop
//   parts/<id>/behavior.js        parts workspace reads (manifest sans baked fields + the raw script)
//   parts/<id>/assets/<sha256>.*  the part's embedded assets as files named by their hash (core/parts/partAssets.ts, project
//                                 format 6); joined back into base64 `data` before baking
//   AGENTS.md                     generated context for an AI agent editing this folder (core/agentGuide.ts).
//                                 Unreferenced by the manifest, so it is inert.
//   tests/<name>.test.json        each project test (docs/project-tests.md), one spec per file so they diff
//                                 individually; the path shape scripts/test-project.mjs globs
//
// A part folder is exactly the parts-workspace format (apps/desktop/partsWorkspace.cjs): a real behavior .js, and a
// manifest without the behavior-baked fields (`params`, `format`, `interactive`, `snap`;
// core/parts/partPackage.manifestOfPackage), so the script is the source of truth. Reassembly therefore needs baking
// (running the behavior), which core must not do, so hosts inject a {@link PartBaker} (sim/validatePart, which also
// surfaces script errors).
//
// Pure (files are data: {path, contents}) and shared by the Electron shell (apps/desktop/projectFolderIo.cjs does
// the fs I/O, and the CLIs read through it), the browser and tests. Reassembly funnels through validateProject, so an
// edited folder gets every clamp/migration a .oip does. Loading is manifest-driven: unreferenced files are ignored.
//
// A folder from formats 4-6 keeps the whole program in one `program.st` (the manifest's `stProgram`). It still reads,
// and the folder sync rewrites it in this layout on its first round (core/project/folderSync.ts `layoutBaseline`).
//
// A pre-format-4 folder lists scenes (scenes/<id>.scene.json + scenes/<id>.st). It still reads: validateProject
// splits it, the other scenes returned in `splitOff` for folders of their own (editor/folderSplit.ts); saving writes
// the format-4 layout and the folder sync removes the old scenes/ files. A folder from when projects kept saved
// assemblies (`assemblies/<id>.assembly.json`, retired) reads the same way: validateProject reports them left out,
// and the next save removes the files.

import { serializeProject, validateProject } from './project'
import type { ProjectJSON, ProjectValidationResult } from './project'
import { manifestOfPackage } from '../parts/partPackage'
import { agentGuideMarkdown } from '../agentGuide'
import type { GuideDoor, GuideScene, PartExtent } from '../agentGuide'
import type { Controller } from '../controller'
import { partFootprint } from '../parts/partGeometry'
import { builtInPackage } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import { isAssetFileInTree, joinAssetFiles, PART_ASSETS_DIR, splitAssetFiles } from '../parts/partAssets'
import type { SplitOptions } from '../parts/partAssets'

/** The manifest file marking a folder as a project (the folder-equivalent of a .oip document). */
export const PROJECT_MANIFEST = 'project.json'

/** The agent-facing context file written beside the manifest (core/agentGuide.ts). Unreferenced by
 *  project.json: the loader is manifest-driven, so this is inert to a round trip. */
export const AGENT_GUIDE = 'AGENTS.md'

/** The project's scene, and the one-file program a folder from formats 4-6 keeps (still read, never written). */
export const SCENE_FILE = 'scene.json'
export const PROGRAM_FILE = 'program.st'

/** The directory a project's program files sit in (format 7). */
export const PROGRAM_DIR = 'plc'

/**
 * Split a program into its files, in order (plc/programFiles.ts `programFiles`). Injected because core cannot import
 * the PLC engine that reads the program's blocks; without it the program is one file, which every reader also takes.
 */
export type ProgramSplitter = (source: string) => { name: string; text: string }[]

/** How a project is spilled: its assets' bytes (core/parts/partAssets.ts) and its program's splitter. */
export interface FolderOptions extends SplitOptions {
  splitProgram?: ProgramSplitter
  /** the AGENTS.md it writes is for an agent at the folder (the default) or one driving the app's tools (get_guide) */
  guideDoor?: GuideDoor
}

/** One file of a spilled project: a folder-relative POSIX path ("parts/conveyor/manifest.json") + its contents: utf-8
 *  text, or bytes for a part's asset file (`parts/<slug>/assets/<sha256>.glb`, core/parts/partAssets.ts
 *  `isAssetFileInTree` says which). */
export interface ProjectFolderFile {
  path: string
  contents: string | Uint8Array
}

/**
 * Build a PartPackage from a part folder's two files, baking the behavior-derived fields by running
 * the script once (sim/validatePart is the canonical implementation, the same baker the parts
 * workspace and the import flow use). Returns `error` (never throws) when the manifest is malformed
 * or the script fails to load/validate.
 */
export type PartBaker = (manifestJson: string, behaviorJs: string) => { package?: unknown; error?: string }

/**
 * A placed part's local extent for the agent guide, or null when it cannot be measured: an
 * unregistered package (a cold registry), a part type with no footprint, or anything that throws.
 *
 * Never propagates a failure: a folder must still save when a part cannot be measured, and the guide
 * drops the column. Its own zero-extent answer is treated as unmeasurable too, since a `group`
 * and an unresolvable package are indistinguishable here and reporting `0..0` would read as a fact.
 */
function measurePartExtent(part: unknown): PartExtent | null {
  try {
    const fp = partFootprint(part as Parameters<typeof partFootprint>[0])
    if (!fp || (fp.hx === 0 && fp.hz === 0 && fp.y0 === 0 && fp.y1 === 0)) return null
    return { hx: fp.hx, hz: fp.hz, y0: fp.y0, y1: fp.y1, ...(fp.cx !== undefined ? { cx: fp.cx } : {}), ...(fp.cz !== undefined ? { cz: fp.cz } : {}) }
  } catch {
    return null
  }
}

/** A file name a splitter may give a program file: no directory, nothing a file system refuses. */
const PROGRAM_FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(st|ld)$/

/**
 * The program's files under {@link PROGRAM_DIR}. A program in a dialect this build cannot read stays one file holding
 * it byte for byte (core/dialect.ts: it is kept, never read), and so does any split whose names are unusable.
 */
function programFolderFiles(program: string, dialect: string | undefined, split: ProgramSplitter | undefined): ProjectFolderFile[] {
  const whole = [{ path: `${PROGRAM_DIR}/${PROGRAM_FILE}`, contents: program }]
  if (!split || dialect !== undefined) return whole
  const files = split(program)
  const names = new Set(files.map((f) => f.name.toLowerCase()))
  const usable = files.length > 0 && names.size === files.length && files.every((f) => PROGRAM_FILE_NAME.test(f.name))
  return usable ? files.map((f) => ({ path: `${PROGRAM_DIR}/${f.name}`, contents: f.text })) : whole
}

/**
 * The program a folder's program files hold, in the manifest's order. One file is the program exactly; several are
 * trimmed and joined by a blank line, the form plc/programFiles.ts writes them in, so folder -> project -> folder
 * is exact and a program round-trips to that form.
 */
export function joinProgramFiles(texts: readonly string[]): string {
  if (texts.length === 1) return texts[0]!
  const blocks = texts.map((t) => t.trim()).filter((t) => t !== '')
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`
}

/**
 * Which of `texts` an offset into {@link joinProgramFiles}`(texts)` falls in, and where in that file: so a diagnostic
 * on the joined program names the file and line it was written at. An offset in the blank line between two files
 * goes to the start of the next.
 */
export function programFileOffset(texts: readonly string[], offset: number): { file: number; offset: number } {
  if (texts.length === 1) return { file: 0, offset }
  let at = 0
  let last = { file: 0, offset: 0 }
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!
    const body = text.trim()
    if (body === '') continue
    const lead = text.length - text.trimStart().length
    if (offset <= at + body.length) return { file: i, offset: lead + Math.max(0, offset - at) }
    last = { file: i, offset: lead + body.length }
    at += body.length + 2
  }
  return last
}

/** Folder-relative paths compare as POSIX regardless of which OS walked the folder. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Allocate a filesystem-safe, unique file basename for an id (ids may hold any character). */
function slugAllocator(): (id: string) => string {
  const used = new Set<string>()
  return (id: string): string => {
    const base = id.replace(/[^A-Za-z0-9._-]/g, '_') || 'item'
    let slug = base
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
    used.add(slug)
    return slug
  }
}

/**
 * Where each library part's folder goes inside a project folder (`parts/<slug>`, by id), allocated exactly as
 * {@link projectToFolderFiles} writes them (same slugging, same collision rule, same order), so "open this part's
 * folder" and the folder sync can never disagree about which folder is a part's.
 */
export function partFolderPaths(packages: readonly { id: string }[]): Map<string, string> {
  const slug = slugAllocator()
  return new Map(packages.map((p) => [p.id, `parts/${slug(p.id)}`]))
}

/**
 * Spill a project into its folder files. Serializes through {@link serializeProject} first so every
 * file carries the same normalized, stable-key-order content as the single-document form. The folder
 * is a split view of the .oip document, not a second format. The ST program is written byte-verbatim
 * (and omitted when empty), so folder → project → folder is exact.
 */
export function projectToFolderFiles(project: ProjectJSON, opts?: FolderOptions): ProjectFolderFile[] {
  const doc = JSON.parse(serializeProject(project)) as {
    version: number
    name: string
    packages?: PartPackage[]
    scene: unknown
    stProgram?: string
    stScanMs?: number
    controller?: Controller
    stDialect?: string
    simHz?: number
    tests?: { name?: string }[]
  }
  const files: ProjectFolderFile[] = []
  const testSlug = slugAllocator()

  files.push({ path: SCENE_FILE, contents: JSON.stringify(doc.scene, null, 2) + '\n' })
  const hasProgram = typeof doc.stProgram === 'string' && doc.stProgram !== ''
  const programFiles = hasProgram ? programFolderFiles(doc.stProgram!, doc.stDialect, opts?.splitProgram) : []
  files.push(...programFiles)
  const programPaths = programFiles.map((f) => f.path)

  // Each authored part = a workspace-format folder: manifest.json (baked fields dropped, since the
  // behavior re-derives them) + behavior.js verbatim + its embedded assets as hash-named files. Refs are the folder
  // paths.
  const partDirs = partFolderPaths(doc.packages ?? [])
  const packagePaths = (doc.packages ?? []).map((pkg) => {
    const dir = partDirs.get(pkg.id)!
    const split = splitAssetFiles(manifestOfPackage(pkg), opts)
    files.push({ path: `${dir}/manifest.json`, contents: JSON.stringify(split.manifest, null, 2) + '\n' })
    files.push({ path: `${dir}/behavior.js`, contents: pkg.behavior })
    for (const a of split.files) files.push({ path: `${dir}/${a.path}`, contents: a.bytes })
    return dir
  })

  // One file per test, named from the spec so a folder review reads as a list of intents rather than
  // test-1/test-2. `tests/` is the directory scripts/test-project.mjs globs, so that CLI finds them.
  // A folder authored before tests were part of the document has files the manifest doesn't reference,
  // which the loader ignores.
  const testPaths = (doc.tests ?? []).map((spec, i) => {
    const path = `tests/${testSlug(spec.name ?? `test-${i + 1}`)}.test.json`
    files.push({ path, contents: JSON.stringify(spec, null, 2) + '\n' })
    return path
  })

  // The scan time, the controller table, the dialect and the step rate are small structured data, so they sit in the
  // manifest beside the program's path rather than in files of their own (an agent or an organizer edits them
  // as data). serializeProject already left out the defaults, so a plain 60 Hz IEC folder never gains the keys.
  const manifest = {
    version: doc.version,
    name: doc.name,
    ...(packagePaths.length > 0 ? { packages: packagePaths } : {}),
    scene: SCENE_FILE,
    ...(hasProgram
      ? {
          program: programPaths,
          ...(typeof doc.stScanMs === 'number' ? { stScanMs: doc.stScanMs } : {}),
          ...(doc.controller ? { controller: doc.controller } : {}),
        }
      : {}),
    ...(doc.stDialect !== undefined ? { stDialect: doc.stDialect } : {}),
    ...(typeof doc.simHz === 'number' ? { simHz: doc.simHz } : {}),
    ...(testPaths.length > 0 ? { tests: testPaths } : {}),
  }
  const guideScene: GuideScene = {
    id: 'scene',
    name: doc.name,
    scenePath: SCENE_FILE,
    ...(hasProgram ? { programPaths } : {}),
    scene: doc.scene,
    ...(hasProgram && doc.controller ? { controller: doc.controller } : {}),
    ...(doc.stDialect !== undefined ? { stDialect: doc.stDialect } : {}),
  }

  // The agent-facing context file (core/agentGuide.ts). Emitted last so it can quote the paths the
  // scenes were actually written to. The manifest does not reference it, and reassembly is
  // manifest-driven, so it round-trips as a no-op rather than as a file the loader must know about.
  files.push({
    path: AGENT_GUIDE,
    contents: agentGuideMarkdown(
      {
        name: doc.name,
        scene: guideScene,
        tests: doc.tests,
      },
      // Measured here rather than inside the guide because partFootprint resolves packages through the
      // ambient registry: injecting it keeps agentGuide.ts a pure function of the document. Where the
      // registry is cold (a unit test, a headless codec call) every part measures null and the column
      // is omitted. A missing column misleads no one, but a wrong one would.
      {
        measure: (part) => measurePartExtent(part),
        // a project scene carries no copies of its parts' packages (core/project/project.ts): the library has the project's own,
        // and the app declares its built-ins (builtInPackage), the same split loading resolves against
        resolve: (id) => (doc.packages ?? []).find((p) => p.id === id) ?? builtInPackage(id),
        ...(opts?.guideDoor ? { door: opts.guideDoor } : {}),
      },
    ),
  })
  files.unshift({ path: PROJECT_MANIFEST, contents: JSON.stringify(manifest, null, 2) + '\n' })
  return files
}

/**
 * Is `path` (folder-relative) a part's build source rather than a file the app keeps? Under `parts/`, the app writes
 * and reads only a part folder's `manifest.json`, its `behavior.js` and its `assets/<sha256>.<ext>` files. Anything else
 * there is the author's: a `part.js` that `npm run build-parts` turns into those two files, a shared module in
 * `parts/_shared/`, notes. The folder sync never writes, takes or removes one (core/project/folderSync.ts), and the app never
 * runs a `part.js` (docs/part-authoring-guide.md "Writing a part as one `part.js`").
 */
export function isPartSourceFile(path: string): boolean {
  const p = normalizePath(path)
  if (!p.startsWith('parts/')) return false
  const segments = p.split('/')
  if (segments.length === 3 && (segments[2] === 'manifest.json' || segments[2] === 'behavior.js')) return false
  return !(segments.length === 4 && segments[2] === PART_ASSETS_DIR && isAssetFileInTree(p))
}

/**
 * Files sitting in the format's own subdirectories that `project.json` never references, as
 * folder-relative paths.
 *
 * Loading is manifest-driven (a scene orphaned by a rename must not load as a phantom), so an added file silently
 * does nothing. An agent writing into the folder hits this, and the symptom misleads (an unreferenced ST program
 * reports as `tag "X" never appeared`). This changes nothing about loading. It only lets a surface report what it
 * ignored.
 *
 * Root files (this guide, a README, notes) are excluded: they are inert by design.
 */
export function unreferencedProjectFiles(files: readonly ProjectFolderFile[]): string[] {
  const manifestText = files.find((f) => normalizePath(f.path) === PROJECT_MANIFEST)?.contents
  if (typeof manifestText !== 'string') return []
  let m: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(manifestText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
    m = parsed as Record<string, unknown>
  } catch {
    return [] // an unparseable manifest is already a hard error from folderFilesToProject
  }

  const referenced = new Set<string>([PROJECT_MANIFEST])
  const assetDirs: string[] = []
  const ref = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') referenced.add(normalizePath(v))
  }
  ref(m.scene)
  ref(m.stProgram)
  for (const p of Array.isArray(m.program) ? m.program : []) ref(p)
  // a folder from before format 4 lists its scenes
  for (const raw of Array.isArray(m.scenes) ? m.scenes : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const s = raw as Record<string, unknown>
    ref(s.scene)
    ref(s.stProgram)
  }
  for (const dir of Array.isArray(m.packages) ? m.packages : []) {
    if (typeof dir !== 'string' || dir === '') continue
    // a part is a folder reference; both of its files count as referenced, and its asset files (which its manifest
    // names, and joinAssetFiles checks)
    referenced.add(`${normalizePath(dir)}/manifest.json`)
    referenced.add(`${normalizePath(dir)}/behavior.js`)
    assetDirs.push(`${normalizePath(dir)}/${PART_ASSETS_DIR}/`)
  }
  for (const t of Array.isArray(m.tests) ? m.tests : []) ref(t)

  const out: string[] = []
  for (const f of files) {
    const path = normalizePath(f.path)
    if (referenced.has(path) || assetDirs.some((d) => path.startsWith(d)) || isPartSourceFile(path)) continue
    // only the format's own files: its subdirectories, and the scene and program it keeps at the root (a program.st
    // the manifest never names is the commonest edit here that silently does nothing). Any other root file (this
    // guide, a README, notes) is inert by design
    const ownRoot = (PROJECT_ROOT_FILES as readonly string[]).includes(path)
    if (!ownRoot && !SUBDIR_PREFIXES.some((p) => path.startsWith(p))) continue
    out.push(path)
  }
  return out.sort()
}

/**
 * The subdirectories the format defines. `scenes` is only for a folder written before format 4, which still has to
 * be read (its scenes split off; the next save removes them), and `assemblies` only for a folder written while
 * projects kept saved assemblies (retired; the next save removes the files). The browser reader
 * (editor/project/projectFolderLink.ts) imports this list; the desktop shell's walk (apps/desktop/projectFolderIo.cjs, which
 * every CLI reads through) keeps a copy, since plain Node cannot import it, and projectFolder.test.ts pins that copy:
 * a directory missing from it makes a manifest ref fail as "file not found".
 */
export const PROJECT_SUBDIRS = [PROGRAM_DIR, 'scenes', 'parts', 'tests', 'assemblies'] as const

/**
 * The files the format keeps at the folder's root: the manifest, and since format 4 the scene and its program. Shared
 * and pinned the same way as {@link PROJECT_SUBDIRS} (a root file missing from the shell's copy reads as "not found",
 * and from its fingerprint as an outside edit nobody sees).
 */
export const PROJECT_ROOT_FILES = [PROJECT_MANIFEST, SCENE_FILE, PROGRAM_FILE] as const
const SUBDIR_PREFIXES = PROJECT_SUBDIRS.map((d) => `${d}/`)

/**
 * Reassemble a project from folder files (the inverse of {@link projectToFolderFiles}). Resolves the
 * manifest's file refs, inlines them into a candidate document, and hands it to
 * {@link validateProject}, so an externally edited folder is validated exactly like an untrusted
 * .oip upload. Part folders are rebuilt through `opts.bakePart` (required when the project has any),
 * so an edited behavior.js is re-baked at load and its script errors reported. Structural
 * problems (missing manifest, dangling ref, unparseable file) are reported with the offending path;
 * unreferenced files are ignored.
 */
export function folderFilesToProject(
  files: readonly ProjectFolderFile[],
  opts?: { bakePart?: PartBaker },
): ProjectValidationResult {
  const byPath = new Map<string, string | Uint8Array>()
  for (const f of files) byPath.set(normalizePath(f.path), f.contents)

  const manifestText = byPath.get(PROJECT_MANIFEST)
  if (manifestText === undefined) {
    return { ok: false, errors: [`${PROJECT_MANIFEST} not found - not a project folder`] }
  }
  if (typeof manifestText !== 'string') return { ok: false, errors: [`${PROJECT_MANIFEST} is not a text file`] }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    return { ok: false, errors: [`${PROJECT_MANIFEST} is not valid JSON`] }
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { ok: false, errors: [`${PROJECT_MANIFEST} must be a JSON object`] }
  }
  const m = manifest as Record<string, unknown>
  const errors: string[] = []

  const readText = (ref: unknown, at: string): string | undefined => {
    if (typeof ref !== 'string' || ref === '') {
      errors.push(`${at} must be a file path`)
      return undefined
    }
    const text = byPath.get(normalizePath(ref))
    if (text === undefined) errors.push(`${at}: file "${ref}" not found in the folder`)
    else if (typeof text !== 'string') {
      errors.push(`${at}: file "${ref}" is not a text file`)
      return undefined
    }
    return text
  }
  const readJson = (ref: unknown, at: string): unknown => {
    const text = readText(ref, at)
    if (text === undefined) return undefined
    try {
      return JSON.parse(text)
    } catch {
      errors.push(`${at}: file "${String(ref)}" is not valid JSON`)
      return undefined
    }
  }

  // format 7: the program's files, in order; formats 4-6 name one file (`stProgram`)
  const readProgram = (refs: unknown[], at: string): string | undefined => {
    const texts = refs.map((ref, i) => readText(ref, `${at}[${i}]`))
    return texts.every((x) => x !== undefined) ? joinProgramFiles(texts as string[]) : undefined
  }

  // The machine: a format-4 folder's own scene + program, or an older folder's scene list (handed on as a list:
  // validateProject is what splits it).
  const listed = m.scene === undefined && Array.isArray(m.scenes)
  const readMachine = (s: Record<string, unknown>, at: string): Record<string, unknown> => {
    const scene = readJson(s.scene, `${at}scene`)
    const stProgram = Array.isArray(s.program) ? readProgram(s.program, `${at}program`) : s.stProgram !== undefined ? readText(s.stProgram, `${at}stProgram`) : undefined
    const stScanMs = typeof s.stScanMs === 'number' && Number.isFinite(s.stScanMs) ? s.stScanMs : undefined
    return {
      scene,
      ...(stProgram !== undefined ? { stProgram } : {}),
      ...(stScanMs !== undefined ? { stScanMs } : {}),
      // inline data, handed on as written: validateProject checks it and names what is wrong
      ...(s.controller !== undefined ? { controller: s.controller } : {}),
      ...(s.stDialect !== undefined ? { stDialect: s.stDialect } : {}),
      ...(s.simHz !== undefined ? { simHz: s.simHz } : {}),
    }
  }
  let machine: Record<string, unknown> = {}
  let scenes: unknown[] = []
  if (listed) {
    const rawScenes = m.scenes as unknown[]
    if (rawScenes.length === 0) errors.push('scenes must be a non-empty array of manifest entries')
    scenes = rawScenes.map((raw: unknown, i: number) => {
      const at = `scenes[${i}]`
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        errors.push(`${at} must be an object`)
        return undefined
      }
      const s = raw as Record<string, unknown>
      return { id: s.id, name: s.name, ...readMachine(s, `${at}.`) }
    })
  } else if (m.scene === undefined) {
    errors.push(`${PROJECT_MANIFEST} names no scene (a "scene" file)`)
  } else {
    machine = readMachine(m, '')
  }

  // Part refs are folder paths; each folder holds the workspace-format pair. Baking (running the
  // behavior to re-derive params etc.) is the injected host capability ({@link PartBaker}).
  const rawPackages = Array.isArray(m.packages) ? m.packages : []
  const packages = rawPackages.map((ref: unknown, i: number) => {
    const at = `packages[${i}]`
    if (typeof ref !== 'string' || ref === '') {
      errors.push(`${at} must be a part-folder path`)
      return undefined
    }
    const dir = normalizePath(ref)
    const manifestJson = readText(`${dir}/manifest.json`, at)
    const behaviorJs = readText(`${dir}/behavior.js`, at)
    if (manifestJson === undefined || behaviorJs === undefined) return undefined
    if (!opts?.bakePart) {
      errors.push(`${at} ("${dir}"): this host cannot build part folders (no part baker provided)`)
      return undefined
    }
    // asset files (parts/<slug>/assets/<sha256>.*) go back into the manifest as embedded data before baking
    const joined = joinAssetFiles(manifestJson, (path) => {
      const c = byPath.get(`${dir}/${path}`)
      return c instanceof Uint8Array ? c : undefined
    })
    if (joined.error !== undefined) {
      errors.push(`${at} ("${dir}"): ${joined.error}`)
      return undefined
    }
    const baked = opts.bakePart(joined.manifestJson, behaviorJs)
    if (baked.error !== undefined || baked.package === undefined) {
      errors.push(`${at} ("${dir}"): ${baked.error ?? 'part baker returned nothing'}`)
      return undefined
    }
    return baked.package
  })

  // Test refs are plain JSON files; validateProject applies validateTestSpec (and the "names a real
  // scene" rule) to each, so a hand-edited spec fails at load with the same message the CLI gives.
  const rawTests = Array.isArray(m.tests) ? m.tests : []
  const tests = rawTests.map((ref: unknown, i: number) => readJson(ref, `tests[${i}]`))

  // retired saved assemblies: only their refs go on, so validateProject can say they were left out; their files are
  // never read, so one that is missing or broken cannot refuse the folder
  const assemblies = Array.isArray(m.assemblies) ? m.assemblies : []

  if (errors.length > 0) return { ok: false, errors }
  return validateProject({
    version: m.version,
    name: m.name,
    ...(listed
      ? {
          activeScene: m.activeScene,
          // a folder from when the rate was project-wide names it here; passed through as written, and
          // validateProject (the one place that decides what a rate may be) hands it to every scene naming none
          ...(m.simHz !== undefined ? { simHz: m.simHz } : {}),
          scenes,
        }
      : machine),
    ...(packages.length > 0 ? { packages } : {}),
    ...(tests.length > 0 ? { tests } : {}),
    ...(assemblies.length > 0 ? { assemblies } : {}),
  })
}
