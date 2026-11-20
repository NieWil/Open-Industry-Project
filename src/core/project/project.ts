// A *project* is one machine (a layout and the program that runs it) plus what belongs to it: its own part
// library and its tests (see docs/projects.md). The portable artifact stays one JSON
// document, so it keeps the share/collab/archive properties of a scene file: the web serializes it to a single
// `.oip` file; the native shell spills the same document into a folder (core/project/projectFolder.ts).
//
// Format 4 holds one scene. Formats 1-3 held several, each with its own program, that never ran or referred
// across each other; such a document still reads: its active scene becomes the project, and every other scene
// comes back as a project of its own in `splitOff`, for the host to file (docs/projects.md "Splitting an older
// project").
//
// This module is the pure data model + (de)serializer only. It reuses scene.ts's per-part and per-package
// validation wholesale, so it inherits every clamp/migration scene validation does.

import { savedParts, validateScene } from '../scene/scene'
import { sceneSettings } from '../scene/scenePlcs'
import { definitionsUsedBy } from '../parts/partPackage'
import { validatePartPackage } from '../parts/partValidate'
import { upgradeStoredPackage } from '../parts/partUpgrade'
import { originOf, partFingerprint, withOrigin } from '../parts/partOrigin'
import { builtInPackage, hasBuiltInPackages } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import { validateTestSpec } from './projectTest'
import type { TestSpec } from './projectTest'
import { validateController } from '../controller'
import type { Controller } from '../controller'
import { storedDialect, validateDialect } from '../dialect'
import { DEFAULT_SIM_HZ, MAX_SIM_HZ, MIN_SIM_HZ, SCENE_VERSION, toSimRate } from '../types'
import type { PartInstance, SceneJSON, SimRate } from '../types'

/** project format version - bump on breaking changes to the container shape */
// 7: the program is files in the folder, one per POU under `plc/`, listed in order by the manifest's `program`
// (core/project/projectFolder.ts, plc/programFiles.ts). The document in memory is unchanged; the bump is what makes an older
// build refuse such a folder by its version rather than load it with no program.
// 6: a part's embedded assets are files in its folder, `parts/<slug>/assets/<sha256>.<ext>`, named by
// the hash of their bytes (core/parts/partAssets.ts). The document in memory is unchanged; only the folder and the .oip
// differ, so the bump is what makes an older build refuse such a folder by its version ("saved by a newer version")
// rather than by a part with no bytes. Every build that knows format 6 reads the layout.
// 5: the library is complete: every part the project uses is its own copy, built-ins included, each
// stamped with where it came from (docs/part-sources.md). A format-4 document is completed on read.
// 4: one machine per project: the scene and its program sit on the project itself. 3
// held a list of scenes and kept each part definition once; 2 kept a copy of every placed part's package in each
// scene. All of them read (an older multi-scene document splits, see validateProject); only 7 is written.
export const PROJECT_VERSION = 7

/**
 * What a project runs: the layout and the program bound to it, with the settings each carries. In formats 1-3 this
 * was one entry of the project's scene list (with an id and a name of its own); in format 4 it is the project.
 */
export interface ProjectMachine {
  /**
   * The spatial layout. Its parts name their packages by id and it carries no copies of them: every one is the
   * project's own copy (ProjectJSON.packages; an older document's built-ins are copied in on read). The live
   * scene the editor opens gets its copies back from those (store applyProject), and a copy is made again only where
   * a scene leaves the project: a standalone scene file, a room. A format-2 document carried a copy of every placed
   * part here; reading it moves them out (keepDefinitionsOnce).
   */
  scene: SceneJSON
  /** the ST/PLC program; absent/empty means none */
  stProgram?: string
  /** that program's authored scan (cycle) time in ms; absent = the engine default. Part of the
   *  program, not a machine preference, so it travels with it through every format. */
  stScanMs?: number
  /**
   * The program's controller (core/controller.ts): the tasks it runs on and the PROGRAM instances each task runs.
   * Absent means one program on `stScanMs`, which is every document written before the field existed. Present only
   * with a program, like the scan time.
   */
  controller?: Controller
  /**
   * The language family the program's text is written in (core/dialect.ts). Absent means IEC 61131-3, the only one
   * this build runs. Any other value is kept exactly as written and the program is refused at run time rather than
   * read as IEC. Kept with or without a program.
   */
  stDialect?: string
  /**
   * The physics step rate in whole Hz, MIN_SIM_HZ..MAX_SIM_HZ; absent = DEFAULT_SIM_HZ. A property of the machine,
   * like its scan time: it decides how finely a sensor sees cargo and how soon a PLC output can follow an input.
   * Kept with or without a program. Written only when it is not the default.
   */
  simHz?: SimRate
}

/** A project document: one machine (the {@link ProjectMachine} fields) and what belongs to it. */
export interface ProjectJSON extends ProjectMachine {
  version: typeof PROJECT_VERSION
  /** display name */
  name: string
  /**
   * The project's part library, complete since format 5 (docs/part-sources.md): every part definition the project
   * uses or has. That is parts it authored, imported or brought in with a scene, and its own copy of every built-in it
   * places (stamped `origin.app` with the version it was copied at, edited or not). The store's `userPackages`. They
   * adopt as authoritative on load, shadowing the app's built-in of the same id. The only place a project keeps a
   * definition (v1 stored unstamped placement snapshots here, which froze every placed built-in at a version nothing
   * could report as out of date; validateProject migrates such docs). Absent when there is nothing.
   */
  packages?: PartPackage[]
  /**
   * The project's own pass/fail criteria (docs/project-tests.md): declarative specs the runner executes against the
   * scene. Carried in the document, they state what "working" means for the project wherever it is opened.
   */
  tests?: TestSpec[]
}

export type ProjectValidationResult =
  | {
      ok: true
      project: ProjectJSON
      /**
       * The other scenes of an older multi-scene document (formats 1-3), each as a project of its own: named
       * "<project> - <scene>", carrying copies of the library parts its scene places, and the tests
       * that named that scene. `project` is the scene that was active. Absent for a format-4 document or a one-scene one.
       *
       * A host that reads a document from somewhere it will write back must file these (the editor: a library
       * document each, or a sibling folder each on the desktop), or saving `project` over its source loses them.
       * A read-only host (a CLI check) reports them instead.
       */
      splitOff?: ProjectJSON[]
      /**
       * Set when the document was a v1 project (library = authored ∪ placement snapshots, scenes
       * without own packages). The migration copies each scene's referenced packages into that
       * scene, but it cannot tell an authored fork from a placement snapshot inside the old
       * library. The editor boot path must filter first-party (bundled) ids out of `packages`
       * before adopting it, or every previously-placed bundled part stays frozen.
       */
      migratedFromV1?: true
      /** what loading changed to make the document valid, each located (scene.parts[3]...); absent when nothing
       *  was. The app applies these silently, so the validate-project CLI is where they are read */
      repairs?: string[]
    }
  | { ok: false; errors: string[] }

const DEFAULT_PROJECT_NAME = 'Untitled Project'

/** The name a split-off scene's project gets: what it was called inside the project it came from. */
export function splitOffName(project: string, scene: string): string {
  return `${project} - ${scene}`
}

/** Merge package lists by id for scene validation/serialization: `own` (the scene's snapshots)
 *  first, `library` (the live authored copies) overriding on an id collision. */
function mergePackages(own: readonly PartPackage[], library: readonly PartPackage[]): PartPackage[] {
  const byId = new Map<string, PartPackage>()
  for (const p of own) byId.set(p.id, p)
  for (const p of library) byId.set(p.id, p)
  return [...byId.values()]
}

/**
 * What a scene's parts resolve against: the scene's own copies (a format-2 document's), the library over them, and
 * the app's built-ins for any part neither names (partRegistry builtInPackage) - in that order of precedence.
 */
function resolvingPackages(parts: unknown, own: readonly PartPackage[], library: readonly PartPackage[]): PartPackage[] {
  const merged = mergePackages(own, library)
  const have = new Set(merged.map((p) => p.id))
  for (const id of partPackageIds(parts)) {
    if (have.has(id)) continue
    const builtIn = builtInPackage(id)
    if (builtIn) {
      merged.push(builtIn)
      have.add(id)
    }
  }
  return merged
}

/** the distinct package ids the (untrusted) parts name */
function partPackageIds(parts: unknown): string[] {
  const ids = new Set<string>()
  for (const p of Array.isArray(parts) ? parts : []) {
    const id = (p as { packageId?: unknown } | null)?.packageId
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return [...ids]
}

/** the parts naming a package nothing resolves: a part that neither the project nor the app has */
function unresolvedPackageIds(parts: unknown, resolving: readonly PartPackage[]): { index: number; id: string }[] {
  const have = new Set(resolving.map((p) => p.id))
  const out: { index: number; id: string }[] = []
  ;(Array.isArray(parts) ? parts : []).forEach((p: unknown, index: number) => {
    const part = p as { type?: unknown; packageId?: unknown } | null
    if (part?.type === 'part' && typeof part.packageId === 'string' && !have.has(part.packageId)) out.push({ index, id: part.packageId })
  })
  return out
}

/**
 * What `library` lacks for every part in `partLists`, every product their params name (productRefsOf: a spawner set to
 * make totes), and every part those name (packageDependencies), to be its own:
 * the app's built-in of each missing id at its current version, stamped `origin.app` with that version's fingerprint
 * (docs/part-sources.md). A missing id the app does not have is skipped (validation reports a part nothing resolves).
 * Empty when nothing is missing, and when the host has declared no built-ins.
 */
export function missingLibraryCopies(library: readonly PartPackage[], partLists: readonly (readonly PartInstance[])[]): PartPackage[] {
  if (!hasBuiltInPackages()) return []
  const byId = new Map(library.map((p) => [p.id, p]))
  // the library's copy of `id`, else the app's built-in stamped as a copy of this version
  const resolve = (id: string): PartPackage | undefined => {
    const builtIn = byId.has(id) ? undefined : builtInPackage(id)
    return byId.get(id) ?? (builtIn && withOrigin(builtIn, 'app', partFingerprint(builtIn)))
  }
  return definitionsUsedBy(partLists.flat(), resolve).filter((p) => !byId.has(p.id))
}

/**
 * The project with every part definition kept once, among its own parts, and those complete: every part the scene
 * places, and every part those name (packageDependencies: held cargo, a unit load's pieces), is the
 * project's own copy (docs/part-sources.md). A built-in the library lacks is copied in at the app's current version,
 * stamped `origin.app` with that version's fingerprint, so the app can say when it later changes and never changes
 * the project by itself. The scene carries no copies afterwards.
 *
 * A copy the scene carries (a format-2 document, a scene file brought in) joins the library when the
 * library lacks its id, and the first copy of an id is kept. The exception is a copy of a built-in that is not a
 * project's own version (no `origin.app`): that is a placement snapshot of whatever build saved it, and the current
 * built-in takes its place. Library entries are never dropped, used or not.
 *
 * A built-in is recognised by the app's own declaration (builtInPackage), never by an `oip.` id. A host that has
 * declared none (a unit test, a CLI that forgot) cannot tell, so it changes nothing. Returns `project` itself when
 * nothing changes.
 */
export function keepDefinitionsOnce(project: ProjectJSON): ProjectJSON {
  if (!hasBuiltInPackages()) return project
  const library = [...(project.packages ?? [])]
  const byId = new Map(library.map((p) => [p.id, p]))
  let changed = false
  for (const pkg of project.scene.packages ?? []) {
    if (byId.has(pkg.id) || (builtInPackage(pkg.id) && originOf(pkg, 'app') === undefined)) continue
    library.push(pkg)
    byId.set(pkg.id, pkg)
    changed = true
  }
  // everything the document uses, and what that names, the project's own
  const missing = missingLibraryCopies(library, [project.scene.parts])
  if (missing.length > 0) {
    library.push(...missing)
    changed = true
  }
  let scene = project.scene
  if (scene.packages !== undefined) {
    const { packages: _copies, ...rest } = scene
    scene = rest
    changed = true
  }
  if (!changed) return project
  return { ...project, scene, ...(library.length > 0 ? { packages: library } : {}) }
}

/** Build a candidate SceneJSON for validation: the scene's parts + every package its parts can resolve. */
function sceneWithPackages(
  scene: SceneJSON,
  packages: readonly PartPackage[],
  stProgram?: string,
  stScanMs?: number,
): unknown {
  return {
    version: SCENE_VERSION,
    parts: scene.parts,
    ...(packages.length > 0 ? { packages } : {}),
    ...sceneSettings(scene),
    ...(typeof stProgram === 'string' && stProgram !== ''
      ? { stProgram, ...(typeof stScanMs === 'number' ? { stScanMs } : {}) }
      : {}),
  }
}

/**
 * Validate one machine from an untrusted record: a format-4 document's own top level, or one entry of a format-1-3
 * scene list. Pushes what is wrong onto `errors` (returning undefined) and what loading changed onto `repairs`, each
 * located by `at` ('scene' for a format-4 document, 'scenes[2] (Line B)' for an older one).
 */
function validateMachine(
  s: Record<string, unknown>,
  at: string,
  library: readonly PartPackage[],
  /** the rate a document from when it was project-wide named at its top; a machine naming none of its own takes it */
  legacyHz: SimRate,
  fromV1: boolean,
  errors: string[],
  repairs: string[],
): ProjectMachine | undefined {
  const stProgram = typeof s.stProgram === 'string' ? s.stProgram : undefined
  if (s.stProgram !== undefined && stProgram === undefined) repairs.push(`${at}.stProgram is not a string, so it is ignored`)
  const stScanMs = typeof s.stScanMs === 'number' && Number.isFinite(s.stScanMs) ? s.stScanMs : undefined
  // the controller table is checked, not skipped when malformed: a dropped task changes what runs
  let controller: Controller | undefined
  if (s.controller !== undefined) {
    const checked = validateController(s.controller, `${at}.controller`)
    if (!checked.ok) {
      errors.push(...checked.errors)
      return undefined
    }
    controller = checked.controller
  }
  // the program's dialect, checked the same way: malformed refuses, unknown is kept for the run edge to refuse
  const dialect = validateDialect(s.stDialect, `${at}.stDialect`)
  if (!dialect.ok) {
    errors.push(...dialect.errors)
    return undefined
  }
  const stDialect = dialect.dialect
  // Lenient like the scan time: a rate no world can run (a hand-edited 30) is clamped rather than rejecting the
  // document, which on the autosave path would fall back to the legacy keys
  const simHz = s.simHz !== undefined ? toSimRate(s.simHz) : legacyHz
  if (s.simHz !== undefined && s.simHz !== simHz) {
    repairs.push(`${at}.simHz ${JSON.stringify(s.simHz)} is not a whole number from ${MIN_SIM_HZ} to ${MAX_SIM_HZ}, so it steps at ${simHz} Hz`)
  }

  // The layout lives at `scene.parts` (the nested SceneJSON). Validate it through scene.ts with the
  // authored library merged over the scene's own snapshots for package resolution.
  const rawScene = typeof s.scene === 'object' && s.scene !== null ? (s.scene as Record<string, unknown>) : {}
  const rawOwn = Array.isArray(rawScene.packages) ? (rawScene.packages as PartPackage[]) : []
  const rawParts = Array.isArray(rawScene.parts) ? (rawScene.parts as SceneJSON['parts']) : []
  const resolving = resolvingPackages(rawParts, rawOwn, library)
  const unknown = unresolvedPackageIds(rawParts, resolving)
  if (unknown.length > 0) {
    errors.push(...unknown.map((u) => `${at}: parts[${u.index}].packageId "${u.id}" is neither in the project's part library nor a built-in part of this app`))
    return undefined
  }
  const candidate = sceneWithPackages(
    // the scene's settings as written: validateScene keeps what it can read and reports the rest
    { version: SCENE_VERSION, parts: rawParts, ...sceneSettings(rawScene as Pick<SceneJSON, 'units' | 'lengthUnit' | 'plcs' | 'display'>) },
    resolving,
    stProgram,
    stScanMs,
  )
  // the library's copies are what runs, whatever version of a built-in the app has now
  const validated = validateScene(candidate, new Set(library.map((p) => p.id)))
  if (!validated.ok) {
    errors.push(...validated.errors.map((e) => `${at}: ${e}`))
    return undefined
  }
  for (const r of validated.repairs ?? []) repairs.push(`${at}.${r}`)
  if (controller !== undefined && !validated.stProgram) repairs.push(`${at}.controller is ignored: there is no stProgram for it to run`)
  // A format-2 scene's own copies, in their validated form: keepDefinitionsOnce moves them out (a copy of a library
  // part or a built-in goes, anything else joins the library), so the scene itself keeps none. A v1 scene stored
  // none, and its library mixes authored parts with placement snapshots; it gets a copy of each library entry its
  // parts use, which keepDefinitionsOnce drops again wherever the host can tell (its built-ins declared), and which
  // keeps a host that cannot from losing the definition when the editor later filters the first-party ids out of a
  // v1 library (projectFile dropBundledIds).
  const validatedById = new Map((validated.scene.packages ?? []).map((p) => [p.id, p]))
  const ownIds = fromV1
    ? new Set(validated.scene.parts.map((p) => ('packageId' in p ? (p as { packageId?: string }).packageId : undefined)).filter((x): x is string => !!x))
    : new Set(rawOwn.map((p) => p?.id).filter((x): x is string => typeof x === 'string'))
  const scenePkgs = [...ownIds].map((pid) => validatedById.get(pid)).filter((p): p is PartPackage => !!p)
  return {
    scene: {
      version: SCENE_VERSION,
      parts: validated.scene.parts,
      ...(scenePkgs.length > 0 ? { packages: scenePkgs } : {}),
      ...sceneSettings(validated.scene),
    },
    ...(validated.stProgram !== undefined && validated.stProgram !== ''
      ? {
          stProgram: validated.stProgram,
          ...(validated.stScanMs !== undefined ? { stScanMs: validated.stScanMs } : {}),
          ...(controller !== undefined ? { controller } : {}),
        }
      : {}),
    ...(stDialect !== undefined ? { stDialect } : {}),
    ...(simHz !== DEFAULT_SIM_HZ ? { simHz } : {}),
  }
}

/** The ids of every definition `scene` uses (definitionsUsedBy), resolved through `packages` and the app's built-ins */
export function usedPackageIds(scene: SceneJSON, packages: readonly PartPackage[]): Set<string> {
  const byId = new Map(packages.map((p) => [p.id, p]))
  return new Set(definitionsUsedBy(scene.parts, (id) => byId.get(id) ?? builtInPackage(id)).map((p) => p.id))
}

/**
 * What an exported project may leave out (Export Project's choices, editor ExportProjectDialog). Each is a thing
 * nobody looking at the scene would know the file carries; all of it goes unless left out, so a backup is whole.
 */
export interface ExportLeaveOut {
  /** library parts the scene does not use */
  unusedParts?: boolean
  tests?: boolean
}

/** The library parts an export would carry that nothing in it uses: not placed in the scene, nor named by what is
 *  (a spawner's product). */
export function unusedLibraryParts(project: ProjectJSON): PartPackage[] {
  const used = usedPackageIds(project.scene, project.packages ?? [])
  return (project.packages ?? []).filter((p) => !used.has(p.id))
}

/** `project` as an export that leaves out what `leave` says; the project itself is untouched. */
export function trimForExport(project: ProjectJSON, leave: ExportLeaveOut): ProjectJSON {
  const unused = leave.unusedParts ? new Set(unusedLibraryParts(project).map((p) => p.id)) : new Set<string>()
  const { packages, tests, ...rest } = project
  const kept = (packages ?? []).filter((p) => !unused.has(p.id))
  return {
    ...rest,
    ...(kept.length > 0 ? { packages: kept } : {}),
    ...(!leave.tests && tests ? { tests } : {}),
  }
}

/**
 * A project split off an older multi-scene document, trimmed to what its own scene uses: the library parts it
 * places, and what those name (a spawner's product). All of it stays in the project it came from, the library's home;
 * copying it into every split-off project would put parts one scene never used into files that get shared and
 * exported on their own.
 */
function usedLibraryOnly(project: ProjectJSON): ProjectJSON {
  const used = usedPackageIds(project.scene, project.packages ?? [])
  const packages = (project.packages ?? []).filter((p) => used.has(p.id))
  const { packages: _library, ...rest } = project
  return { ...rest, ...(packages.length > 0 ? { packages } : {}) }
}

/**
 * Structural validation of an untrusted project document. Reuses {@link validateScene} for the scene (so every
 * per-part/per-package rule, clamp, and conveyor-origin migration still applies), with the authored library merged
 * over the scene's own packages for resolution. Returns a fresh, normalized format-4 project on success.
 *
 * Reads every format. A format-1 to 3 document held a list of scenes: its active scene becomes the project (keeping
 * the project's name), and each other scene comes back in `splitOff` as a project of its own (see
 * {@link ProjectValidationResult}). Each test goes with the scene it named (absent: the active one). The project keeps
 * the library whole (it is its home); a split-off project carries only the library parts its
 * own scene places ({@link usedLibraryOnly}).
 *
 * A document saved while projects kept saved assemblies (named groups of parts, inserted from the catalog as plain
 * copies) still reads: the assemblies are left out and the repairs say so. Copies already placed are ordinary parts
 * in the scene and stay. Why they were retired: docs/scene-composition.md.
 *
 * Accepts v1 documents (library = authored ∪ placement snapshots, scenes without own packages) and migrates them:
 * each scene gets the library packages its parts reference as `scene.packages`. The result carries `migratedFromV1`
 * so the boot path knows the returned `packages` still holds un-splittable placement snapshots.
 */
export function validateProject(data: unknown): ProjectValidationResult {
  const errors: string[] = []
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['project must be a JSON object'] }
  }
  const root = data as Record<string, unknown>
  const fromV1 = root.version === 1
  const listed = root.version === 1 || root.version === 2 || root.version === 3
  if (!listed && root.version !== 4 && root.version !== 5 && root.version !== 6 && root.version !== PROJECT_VERSION) {
    errors.push(
      typeof root.version === 'number' && root.version > PROJECT_VERSION
        ? `saved by a newer version of the app (project format ${root.version}; this build reads up to ${PROJECT_VERSION})`
        : `version must be ${PROJECT_VERSION}`,
    )
  }
  const name = typeof root.name === 'string' && root.name !== '' ? root.name : DEFAULT_PROJECT_NAME

  // The shared library: validate each package once and dedupe by id. The scene's validateScene call re-checks these
  // too, but validating here yields one clear error site and the canonical copy.
  const library: PartPackage[] = []
  const seenPkg = new Set<string>()
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
    if (seenPkg.has(pkg.id)) {
      errors.push(`packages[${i}].id "${pkg.id}" is a duplicate`)
      return
    }
    seenPkg.add(pkg.id)
    library.push(pkg)
  })

  // a document from when the step rate was project-wide names it at the top; a machine that names none of its own
  // takes it, and the next save writes it on the machine instead. Clamped once, here
  const legacyHz = toSimRate(root.simHz)
  if (root.simHz !== undefined && root.simHz !== legacyHz && listed) {
    repairs.push(`simHz ${JSON.stringify(root.simHz)} is not a whole number from ${MIN_SIM_HZ} to ${MAX_SIM_HZ}, so its scenes step at ${legacyHz} Hz`)
  }

  // The machines: a format-4 document's one (its top level), or a format-1-3 document's scene list.
  interface Listed {
    id: string
    name: string
    machine: ProjectMachine
  }
  const machines: Listed[] = []
  if (!listed) {
    // a format-4 document is its scene: one without it is not a project with nothing in it, it is not one at all
    if (typeof root.scene !== 'object' || root.scene === null || Array.isArray(root.scene)) errors.push('scene must be an object')
    else {
      const machine = validateMachine(root, 'scene', library, DEFAULT_SIM_HZ, false, errors, repairs)
      if (machine) machines.push({ id: '', name, machine })
    }
  } else {
    const rawScenes = root.scenes
    if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
      errors.push('scenes must be a non-empty array')
      return { ok: false, errors }
    }
    const seenSceneIds = new Set<string>()
    rawScenes.forEach((raw: unknown, i: number) => {
      const at = `scenes[${i}]`
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        errors.push(`${at} must be an object`)
        return
      }
      const s = raw as Record<string, unknown>
      const id = s.id
      if (typeof id !== 'string' || id === '') {
        errors.push(`${at}.id must be a non-empty string`)
      } else if (seenSceneIds.has(id)) {
        errors.push(`${at}.id "${id}" is a duplicate`)
      } else {
        seenSceneIds.add(id)
      }
      const sceneName = typeof s.name === 'string' && s.name !== '' ? s.name : `Scene ${i + 1}`
      const machine = validateMachine(s, `${at} (${sceneName})`, library, legacyHz, fromV1, errors, repairs)
      if (machine) machines.push({ id: typeof id === 'string' && id !== '' ? id : `scene-${i + 1}`, name: sceneName, machine })
    })
  }

  // saved assemblies are retired: read past them, never refuse a document over them
  if (Array.isArray(root.assemblies) && root.assemblies.length > 0) {
    const n = root.assemblies.length
    repairs.push(`${n === 1 ? '1 saved assembly was' : `${n} saved assemblies were`} left out: saved assemblies are retired (placed copies stay)`)
  }

  // Project tests: validated through the same validateTestSpec the CLI uses, so a spec embedded in a document and a
  // spec in a tests/*.test.json file cannot drift. An older document's spec could name a scene (`scene`); that is
  // what routes it to the right project when the document splits, and it names nothing in a format-4 document.
  const tests: { spec: TestSpec; scene?: string }[] = []
  if (root.tests !== undefined && !Array.isArray(root.tests)) {
    errors.push('tests must be an array')
  } else {
    const rawTests = Array.isArray(root.tests) ? root.tests : []
    const sceneIds = new Set(machines.map((m) => m.id))
    rawTests.forEach((raw: unknown, i: number) => {
      const v = validateTestSpec(raw)
      if (!v.ok) {
        errors.push(...v.errors.map((e) => `tests[${i}]: ${e}`))
        return
      }
      const named = typeof (raw as { scene?: unknown }).scene === 'string' ? ((raw as { scene: string }).scene) : undefined
      if (named !== undefined && listed && !sceneIds.has(named)) {
        errors.push(`tests[${i}].scene "${named}" is not a scene in this project`)
        return
      }
      if (named !== undefined && !listed) repairs.push(`tests[${i}].scene is ignored: a project has one scene`)
      tests.push({ spec: v.spec, ...(named !== undefined && listed ? { scene: named } : {}) })
    })
  }

  if (errors.length > 0 || machines.length === 0) return { ok: false, errors: errors.length > 0 ? errors : ['the project has no scene'] }

  // which listed scene is the project (the one that was active); the rest split off
  let active = 0
  if (listed) {
    const rawActive = root.activeScene
    active = typeof rawActive === 'number' && Number.isInteger(rawActive) && rawActive >= 0 && rawActive < machines.length ? rawActive : 0
    if (rawActive !== undefined && rawActive !== active) {
      repairs.push(`activeScene ${JSON.stringify(rawActive)} is not a scene index (0 to ${machines.length - 1}), so the first scene opens`)
    }
  }
  const projectOf = (m: Listed, projectName: string, isActive: boolean): ProjectJSON => {
    const own = tests.filter((t) => (t.scene === undefined ? isActive : t.scene === m.id)).map((t) => t.spec)
    return keepDefinitionsOnce({
      version: PROJECT_VERSION,
      name: projectName,
      ...m.machine,
      ...(library.length > 0 ? { packages: library.map((p) => p) } : {}),
      ...(own.length > 0 ? { tests: own } : {}),
    })
  }
  const kept = machines[active]!
  const splitOff = machines.filter((_, i) => i !== active).map((m) => usedLibraryOnly(projectOf(m, splitOffName(name, m.name), false)))
  if (splitOff.length > 0) {
    repairs.push(`the project held ${machines.length} scenes; "${kept.name}" is this project, and ${splitOff.map((p) => `"${p.name}"`).join(', ')} become projects of their own`)
  }
  return {
    ok: true,
    project: projectOf(kept, name, true),
    ...(splitOff.length > 0 ? { splitOff } : {}),
    ...(fromV1 ? { migratedFromV1: true as const } : {}),
    ...(repairs.length > 0 ? { repairs } : {}),
  }
}

/**
 * Serialize a project to a single `.oip` JSON document: name, the authored package library once, the scene's parts
 * and its program, then the tests. Stable, human-readable (2-space indent, trailing newline) so it
 * diffs and round-trips. The parts are written as a scene file writes them ({@link savedParts}).
 */
export function serializeProject(
  project: ProjectJSON,
  /** `pretty: false` for the browser autosave - see serializeScene's note. Exported files keep the
   *  indent so a project on disk stays readable and diffable. */
  opts?: { pretty?: boolean },
): string {
  // every definition once: a project handed over still holding copies gives them up here, whoever built it
  project = keepDefinitionsOnce(project)
  const library = project.packages ?? []
  // What keepDefinitionsOnce left on the scene: nothing, once the host has declared its built-ins; everything, in a
  // host that has not (it cannot tell a built-in's copy from a definition nothing else holds, so it keeps both).
  const own = project.scene.packages ?? []
  // each part's param specs resolve against own + library + built-ins; only `own` is written with the scene below
  const parts = savedParts(project.scene.parts, resolvingPackages(project.scene.parts, own, library))
  return (
    JSON.stringify(
      {
        version: PROJECT_VERSION,
        name: project.name,
        ...(library.length > 0 ? { packages: library } : {}),
        scene: { version: SCENE_VERSION, parts, ...(own.length > 0 ? { packages: own } : {}), ...sceneSettings(project.scene) },
        ...(typeof project.stProgram === 'string' && project.stProgram !== ''
          ? {
              stProgram: project.stProgram,
              ...(typeof project.stScanMs === 'number' && Number.isFinite(project.stScanMs) ? { stScanMs: project.stScanMs } : {}),
              ...(project.controller ? { controller: project.controller } : {}),
            }
          : {}),
        // never for IEC; with or without a program (core/dialect.ts)
        ...(storedDialect(project.stDialect) !== undefined ? { stDialect: project.stDialect } : {}),
        // only when not the default
        ...(toSimRate(project.simHz) !== DEFAULT_SIM_HZ ? { simHz: toSimRate(project.simHz) } : {}),
        // last, because a test refers to the scene above it - the document reads top-down
        ...(project.tests && project.tests.length > 0 ? { tests: project.tests } : {}),
      },
      null,
      opts?.pretty === false ? undefined : 2,
    ) + '\n'
  )
}

/**
 * A standalone scene file (or a scene brought in) as a project: its embedded `packages` are given up the way a
 * format-2 project's are (keepDefinitionsOnce: a built-in's copy goes, anything else joins the library), and its
 * bundled program becomes the project's program.
 */
export function sceneToProject(
  scene: SceneJSON,
  stProgram?: string,
  name = DEFAULT_PROJECT_NAME,
  stScanMs?: number,
  controller?: Controller | null,
  stDialect?: string | null,
  simHz?: SimRate,
): ProjectJSON {
  const dialect = storedDialect(stDialect)
  const hz = toSimRate(simHz)
  return keepDefinitionsOnce({
    version: PROJECT_VERSION,
    name,
    scene: {
      version: SCENE_VERSION,
      parts: scene.parts,
      ...(scene.packages && scene.packages.length > 0 ? { packages: scene.packages } : {}),
      ...sceneSettings(scene),
    },
    ...(typeof stProgram === 'string' && stProgram !== ''
      ? {
          stProgram,
          ...(typeof stScanMs === 'number' ? { stScanMs } : {}),
          ...(controller ? { controller } : {}),
        }
      : {}),
    ...(dialect !== undefined ? { stDialect: dialect } : {}),
    ...(hz !== DEFAULT_SIM_HZ ? { simHz: hz } : {}),
  })
}

/**
 * The project's scene as the standalone SceneJSON the store/render layer consumes: its parts with copies of every
 * package they use (its own, the library's, the built-ins'), so the live scene is self-contained, plus the program
 * (with its scan time, controller and dialect) and the physics step rate. The seam the store loads through.
 */
export function projectToScene(project: ProjectJSON): {
  scene: SceneJSON
  stProgram: string
  stScanMs?: number
  controller?: Controller
  stDialect?: string
  simHz: SimRate
} {
  // a standalone scene leaves the project, so it carries copies again: its own, the library's, and the built-ins it uses
  const packages = resolvingPackages(project.scene.parts, project.scene.packages ?? [], project.packages ?? [])
  return {
    scene: {
      version: SCENE_VERSION,
      parts: project.scene.parts,
      ...(packages.length > 0 ? { packages } : {}),
      ...sceneSettings(project.scene),
    },
    stProgram: project.stProgram ?? '',
    ...(project.stScanMs !== undefined ? { stScanMs: project.stScanMs } : {}),
    ...(project.controller !== undefined ? { controller: project.controller } : {}),
    ...(project.stDialect !== undefined ? { stDialect: project.stDialect } : {}),
    simHz: toSimRate(project.simHz),
  }
}

/** A fresh empty project. */
export function emptyProject(name = DEFAULT_PROJECT_NAME): ProjectJSON {
  return { version: PROJECT_VERSION, name, scene: { version: SCENE_VERSION, parts: [] } }
}
