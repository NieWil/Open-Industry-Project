// Writing parts INTO a project folder, shared by the CLIs that do it (scripts/add-part.mjs, scripts/snap-part.mjs
// --write): open or create the project, bake the built-in catalog, copy a built-in or an authored part into the
// project's library (`parts/<id>/`, listed in project.json "packages", project format 5: docs/part-sources.md), and
// a freshly placed part's params.
//
//   const lib = await projectLibrary(vite, folder, { create: true, log })
//   lib.resolvePart(arg)        // built-in id, the project's own part id, or part folder -> { pkg } or { error, exit }
//   lib.addPart(arg)            // the same, then copied into or listed in the library
//   lib.place(packageId, id?)   // a fresh scene part at the origin (not yet pushed)
//   lib.save()                  // scene.json + project.json, in the current format

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPart, hasPartSource } from './buildPart.mjs'
import { readProjectFolder } from './projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
export const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
}
const pick = (dir, names) => names.map((n) => join(dir, n)).find((p) => existsSync(p))

/** The built-in catalog, baked the way catalog.mjs and the app's bundledPackageData bake it: id -> package. */
export async function bakeBundled(vite) {
  const { validatePart } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
  const { joinAssetFiles, isPartAssetPath } = await vite.ssrLoadModule('/src/core/parts/partAssets.ts')
  const bundled = new Map()
  const partsRoot = join(repo, 'examples', 'parts')
  for (const dir of readdirSync(partsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const at = join(partsRoot, dir.name)
    const m = pick(at, ['rig.json', 'manifest.json'])
    const b = pick(at, ['behavior.ts', 'behavior.js'])
    if (!m || !b) continue
    // a folder keeps its models and textures as assets/<sha256>.<ext> files the manifest names (core/parts/partAssets.ts)
    const joined = joinAssetFiles(readFileSync(m, 'utf8'), (p) => (isPartAssetPath(p) && existsSync(join(at, p)) ? new Uint8Array(readFileSync(join(at, p))) : undefined))
    if (joined.error !== undefined) continue // like a part that does not bake: left out of the catalog
    const r = validatePart(JSON.parse(joined.manifestJson), readFileSync(b, 'utf8'))
    if (r.ok && r.package) bundled.set(r.package.id, r.package)
  }
  return bundled
}

/** Bake an authored part folder: { pkg, manifestPath, behaviorPath } or { error, exit }. */
export async function bakeFolder(vite, arg) {
  const { validatePart, formatPartDiagnostics } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
  const m = pick(arg, ['manifest.json', 'rig.json'])
  const b = pick(arg, ['behavior.js', 'behavior.ts'])
  if (!m || !b) return { error: `${arg}: needs manifest.json (or rig.json) + behavior.js (or behavior.ts)`, exit: 2 }
  // a part written as one part.js: what gets copied is its built files, so they must be what it builds now, or an
  // edit to part.js that was never built goes nowhere with no word why
  if (hasPartSource(arg)) {
    const { instantiatePartScript } = await vite.ssrLoadModule('/src/core/parts/partScript.ts')
    const { compileRig } = await vite.ssrLoadModule('/src/core/rig/rigCompile.ts')
    const built = buildPart(arg, repo, { instantiatePartScript, compileRig })
    if (!built.files) return { error: `${arg}: its part.js does not build - fix it first (npm run check-part -- ${arg}):\n  ${built.problems.join('\n  ')}`, exit: 1 }
    const stale = built.files.filter((f) => !existsSync(join(arg, f.name)) || readFileSync(join(arg, f.name), 'utf8').replace(/\r\n/g, '\n') !== f.text).map((f) => f.name)
    if (stale.length > 0) {
      return {
        error: `${arg}: ${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} not what its part.js builds. If part.js changed, build it first (npm run build-parts -- ${arg}). If ${stale.length > 1 ? 'they were' : 'it was'} edited (by hand, the Part Editor or an agent tool), move that change into part.js, or the next build undoes it`,
        exit: 1,
      }
    }
  }
  // a folder keeps its models and textures as assets/<sha256>.<ext> files the manifest names (core/parts/partAssets.ts)
  const { joinAssetFiles, isPartAssetPath } = await vite.ssrLoadModule('/src/core/parts/partAssets.ts')
  const joined = joinAssetFiles(readFileSync(m, 'utf8'), (p) => (isPartAssetPath(p) && existsSync(join(arg, p)) ? new Uint8Array(readFileSync(join(arg, p))) : undefined))
  if (joined.error !== undefined) return { error: `${arg}: ${joined.error}`, exit: 1 }
  const r = validatePart(JSON.parse(joined.manifestJson), readFileSync(b, 'utf8'))
  if (!r.ok || !r.package) return { error: `${arg} does not bake - fix it first (npm run check-part -- ${arg}):\n${formatPartDiagnostics(r.diagnostics)}`, exit: 1 }
  return { pkg: r.package, manifestPath: m, behaviorPath: b }
}

export const isFolder = (arg) => existsSync(arg) && statSync(arg).isDirectory()

/**
 * A FRESH part's params: explicit values for the booleans whose absence means something else (`whenAbsent`, the
 * legacy reading a saved part without the key gets). An empty `params: {}` would be read as an OLD part - the
 * roller conveyor's `fpmUnits` flips units that way - so a placed part states them. A units switch
 * (`imperialUnits`) takes the scene's Units instead, as a part placed in the app does (absent = metric).
 */
export function freshParams(pkg, units) {
  const out = {}
  for (const [k, spec] of Object.entries(pkg?.params ?? {})) {
    if (spec?.type === 'boolean' && spec.imperialUnits === true) out[k] = units === 'imperial'
    else if (spec?.type === 'boolean' && typeof spec.whenAbsent === 'boolean') out[k] = spec.default
  }
  return out
}

/** Open the project in `folder` (creating a minimal one when `create`), with its library writers. Throws an Error
 *  with `exit: 2` for a folder it cannot write into. */
export async function projectLibrary(vite, folder, { create = true, log = console.log } = {}) {
  const { emptyScene } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
  const { PROJECT_VERSION } = await vite.ssrLoadModule('/src/core/project/project.ts')
  const { manifestOfPackage, packageDependencies, productRefsOf } = await vite.ssrLoadModule('/src/core/parts/partPackage.ts')
  const { partFingerprint, withOrigin } = await vite.ssrLoadModule('/src/core/parts/partOrigin.ts')
  const { partFolderPaths } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')

  const manifestPath = join(folder, 'project.json')
  let project
  if (existsSync(manifestPath)) project = readJson(manifestPath)
  else if (create) {
    project = { version: PROJECT_VERSION, name: basename(resolve(folder)), scene: 'scene.json' }
    writeJson(join(folder, 'scene.json'), emptyScene())
    writeJson(manifestPath, project)
    log(`+ created project "${project.name}" with an empty scene (${folder})`)
  } else throw Object.assign(new Error(`${folder} has no project.json`), { exit: 2 })
  // A project holds one scene since format 4: the manifest itself names its scene and program files. A folder
  // from before then lists scenes; opening it in the app converts it (and splits a multi-scene one), and this
  // writes into the format it reads, so it asks for that first rather than write a mix of the two.
  if (typeof project.scene !== 'string') {
    throw Object.assign(
      new Error(
        Array.isArray(project.scenes)
          ? `${manifestPath} is a project folder from before a project held one scene (it lists "scenes"). Open it in the app once to convert it, then run this again.`
          : `${manifestPath} names no scene file ("scene")`,
      ),
      { exit: 2 },
    )
  }
  const scenePath = join(folder, project.scene)
  const scene = readJson(scenePath)
  scene.parts ??= []
  project.packages ??= []

  const bundled = await bakeBundled(vite)
  const listed = (id) => project.packages.includes(`parts/${id}`)
  const visited = new Set()
  // This project's own copy of a built-in, at the app's current version (skipped when it has one), then the parts
  // that one names.
  const copyBuiltIn = (pkg, why) => {
    if (visited.has(pkg.id)) return
    visited.add(pkg.id)
    if (!listed(pkg.id)) {
      const copy = withOrigin(pkg, 'app', partFingerprint(pkg))
      const dest = join(folder, 'parts', pkg.id)
      writeJson(join(dest, 'manifest.json'), manifestOfPackage(copy))
      writeFileSync(join(dest, 'behavior.js'), pkg.behavior)
      project.packages.push(`parts/${pkg.id}`)
      log(`+ ${pkg.id}: built-in part${why} → parts/${pkg.id}/ (this project's own copy, listed in project.json "packages")`)
    } else if (!why) {
      log(`= ${pkg.id}: this project already has its own copy (parts/${pkg.id}/), kept as it is`)
    }
    copyNamed(pkg)
  }
  const copyNamed = (pkg) => {
    for (const id of packageDependencies(pkg)) {
      const dep = bundled.get(id)
      if (dep) copyBuiltIn(dep, `, named by ${pkg.id}`)
    }
  }

  // The folder the app keeps a part in (core/project/projectFolder.ts partFolderPaths), project-relative, `/`-separated.
  const homeOf = (id) => partFolderPaths([{ id }]).get(id)
  const partsRoot = resolve(folder, 'parts')
  const inParts = (dir) => {
    const rel = relative(partsRoot, resolve(dir))
    return rel !== '' && !rel.startsWith('..') && !rel.includes(sep) && !rel.includes('/')
  }
  const refOf = (dir) => relative(resolve(folder), resolve(dir)).split(sep).join('/')

  // A part folder under parts/ whose manifest has the id `id`, listed or not: a part authored in the project is found
  // by its id, as a built-in is.
  const ownFolder = (id) => {
    if (!existsSync(partsRoot)) return undefined
    for (const e of readdirSync(partsRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('_')) continue
      const m = pick(join(partsRoot, e.name), ['manifest.json', 'rig.json'])
      try {
        if (m && readJson(m).id === id) return join(partsRoot, e.name)
      } catch {
        // a manifest that does not parse names no id; bakeFolder says why if the folder is named directly
      }
    }
    return undefined
  }

  /**
   * What `arg` adds, checked and nothing written: { pkg, from? } or { error, exit }. `from` is the authored folder
   * it comes from. A folder already under parts/ is the project's own part: it is listed where the app keeps it,
   * never copied beside itself.
   */
  const resolvePart = async (arg) => {
    const dir = isFolder(arg) ? arg : bundled.has(arg) ? undefined : ownFolder(arg)
    if (dir === undefined) {
      const pkg = bundled.get(arg)
      if (pkg) return { pkg }
      const near = [...bundled.keys()].filter((id) => id.includes(arg.replace(/^oip\./, '')))
      return { error: `"${arg}" is neither a folder, a built-in part id, nor the id of a part in ${join(folder, 'parts')}${near.length ? ` - did you mean ${near.join(', ')}?` : ' (npm run catalog lists the built-ins)'}`, exit: 1 }
    }
    const baked = await bakeFolder(vite, dir)
    if (baked.error) return baked
    const pkg = baked.pkg
    if (bundled.has(pkg.id)) {
      return { error: `${dir}: id "${pkg.id}" is a BUILT-IN id - an authored part under it would shadow the bundled part. Give your part its own id (e.g. "acme.${pkg.id.replace(/^oip\./, '')}").`, exit: 1 }
    }
    const home = join(folder, homeOf(pkg.id))
    if (inParts(dir) && resolve(dir) !== resolve(home) && existsSync(home)) {
      return { error: `${refOf(dir)}/ and ${homeOf(pkg.id)}/ both hold "${pkg.id}". Keep one: the app reads ${homeOf(pkg.id)}/.`, exit: 1 }
    }
    return { pkg, from: { dir, baked } }
  }

  /** Add a built-in id, the project's own part id, or an authored part folder to the library: { pkg } or { error, exit }. */
  const addPart = async (arg) => {
    const r = await resolvePart(arg)
    if (r.error) return r
    const { pkg, from } = r
    if (!from) {
      // a stale copy an older save left in the scene is dropped: the project's copy is the one in parts/
      if (Array.isArray(scene.packages)) scene.packages = scene.packages.filter((p) => p?.id !== pkg.id)
      copyBuiltIn(pkg, '')
      return { pkg }
    }
    const ref = homeOf(pkg.id)
    const dest = join(folder, ref)
    if (resolve(dest) !== resolve(from.dir)) {
      if (inParts(from.dir)) {
        // the project's own part under another folder name: moved, with its part.js and assets, to where the app
        // reads it, so no unlisted copy stays behind
        const old = refOf(from.dir)
        renameSync(from.dir, dest)
        project.packages = project.packages.filter((p) => p !== old)
        log(`  ${pkg.id}: moved ${old}/ to ${ref}/, the folder the app keeps it in`)
      } else {
        mkdirSync(dest, { recursive: true })
        copyFileSync(from.baked.manifestPath, join(dest, 'manifest.json'))
        copyFileSync(from.baked.behaviorPath, join(dest, 'behavior.js'))
        // the models and textures its manifest names as assets/<sha256>.<ext>
        if (existsSync(join(from.dir, 'assets'))) cpSync(join(from.dir, 'assets'), join(dest, 'assets'), { recursive: true })
      }
    }
    const listedBefore = project.packages.includes(ref)
    if (!listedBefore) project.packages.push(ref)
    log(`${listedBefore ? '=' : '+'} ${pkg.id}: authored part → ${ref}/ (${listedBefore ? 'already listed' : 'listed'} in project.json "packages")`)
    copyNamed(pkg)
    return { pkg }
  }

  /** A fresh scene part for `pkg` at the origin, under `id` or the next free `<stem>-<n>`. Not pushed. */
  const place = (pkg, id) => {
    const taken = new Set(scene.parts.map((p) => p.id))
    if (!id) {
      const stem = pkg.id.split('.').pop()
      let n = 1
      while (taken.has(`${stem}-${n}`)) n++
      id = `${stem}-${n}`
    }
    return { id, type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params: freshParams(pkg, scene.units) }
  }

  const save = () => {
    // a product a placed part's params name (a spawner set to totes) is the project's own copy too (core productRefsOf)
    for (const part of scene.parts) {
      const own = part?.type === 'part' ? bundled.get(part.packageId) : undefined
      for (const id of own ? productRefsOf(part.params ?? {}, own) : []) {
        const dep = bundled.get(id)
        if (dep) copyBuiltIn(dep, `, made by ${part.id}`)
      }
    }
    if (Array.isArray(scene.packages) && scene.packages.length === 0) delete scene.packages
    const out = { ...project }
    if (out.packages.length === 0) delete out.packages
    // written in the current format: a folder this wrote copies into is format 5's (an older one is read and completed)
    out.version = PROJECT_VERSION
    writeJson(scenePath, scene)
    writeJson(manifestPath, out)
  }

  return { project, scene, scenePath, manifestPath, bundled, resolvePart, addPart, place, save }
}

/**
 * Load a project folder the way the app does (core/project/projectFolder.ts folderFilesToProject) and register its part
 * library over the built-ins, so the registry resolves each package to the PROJECT's copy. Call declareBuiltIns
 * (scripts/lib/builtIns.mjs) first. Returns { project } (core ProjectJSON) or { errors }.
 */
export async function loadProject(vite, folder) {
  const { folderFilesToProject } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
  const { validatePart, formatPartDiagnostics } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
  const { registerPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
  const bakePart = (manifestJson, behaviorJs) => {
    let manifest
    try {
      manifest = JSON.parse(manifestJson)
    } catch {
      return { error: 'manifest.json is not valid JSON' }
    }
    const result = validatePart(manifest, behaviorJs)
    return result.ok && result.package ? { package: result.package } : { error: formatPartDiagnostics(result.diagnostics) }
  }
  const result = folderFilesToProject(readProjectFolder(folder), { bakePart })
  if (!result.ok) return { errors: result.errors }
  for (const p of result.project.packages ?? []) registerPackage(p, true)
  for (const p of result.project.scene.packages ?? []) registerPackage(p)
  return { project: result.project }
}

/**
 * Open an EXISTING project to change its placed parts (scripts/edit-part.mjs, scripts/duplicate-parts.mjs): the
 * built-ins declared, the project's own part library registered over them (so a param spec is the project copy's,
 * not the app's), and its raw scene + save() from projectLibrary. Throws an Error with `exit` like projectLibrary;
 * a project that does not load is `exit: 1`, naming why.
 */
export async function openProjectForEdit(vite, folder, { log = console.log } = {}) {
  const { declareBuiltIns } = await import('./builtIns.mjs')
  const lib = await projectLibrary(vite, folder, { create: false, log })
  await declareBuiltIns(vite)
  const loaded = await loadProject(vite, folder)
  if (loaded.errors) throw Object.assign(new Error(`${folder} does not load:\n  ${loaded.errors.join('\n  ')}`), { exit: 1 })
  return lib
}
