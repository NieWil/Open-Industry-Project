// Build one part from its part.js, in memory: the two files the app loads. build-parts writes them, check-part checks
// what would be written.
//
// A part.js's definePart() holds the whole part: `manifest` (the manifest minus its geometry, or with a static
// `manifest.geometry`), `rig(params)` (links, joints and bounds computed from the params), the params, geometry() and
// step(). It may import other modules by relative path. From it:
//   the behavior   part.js with its imports joined in and `manifest` / `rig()` left out (bundlePart.mjs)
//   the manifest   `manifest`, its rig compiled from rig() (src/core/rig/rigCompile.ts)
//
// The file names depend on where the part lives. A part folder anywhere (a project's parts/<slug>/, a library's source
// folder) gets manifest.json + behavior.js, the names the app reads (docs/projects.md), and its banners and problems
// name files relative to the part folder. This repo's examples/parts/<dir>/ keep rig.json + behavior.ts and name files
// from the repo root, with no newline after the manifest, so the built-ins' committed bytes stay as they are.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bundlePart } from './bundlePart.mjs'

/** Is `dir` one of this repo's examples/parts/<dir>/ folders? */
export function isExamplePart(dir, repo) {
  return dirname(resolve(dir)) === resolve(repo, 'examples', 'parts')
}

/** The names the build writes in `dir`: `{ behavior, manifest }`. */
export function partOutputNames(dir, repo) {
  return isExamplePart(dir, repo) ? { behavior: 'behavior.ts', manifest: 'rig.json' } : { behavior: 'behavior.js', manifest: 'manifest.json' }
}

/** Does `dir` hold a part.js? */
export function hasPartSource(dir) {
  return existsSync(join(dir, 'part.js'))
}

/**
 * Build the part whose source is `dir`/part.js. `core` holds src/core's `instantiatePartScript` and `compileRig`
 * (TypeScript, so the caller loads them through vite). Returns `{ files, modules }`, `files` being `[{ name, text }]`
 * (the behavior, then the manifest) and `modules` every source file read, or `{ problems }`.
 */
export function buildPart(dir, repo, core) {
  const example = isExamplePart(dir, repo)
  const names = partOutputNames(dir, repo)
  const base = example ? repo : resolve(dir)
  const entry = join(dir, 'part.js')
  // The build reads the whole part; the app gets it without `manifest` and `rig()`. No "generated" header: the
  // shipped text travels into every project's copy and every library download, where it IS the file to edit, so
  // a line pointing at part.js would be wrong there. The part.js beside it and --check say so.
  const full = bundlePart(entry, base, '', { shipped: false })
  const bundled = bundlePart(entry, base)
  if (!full.source || !bundled.source) return { problems: full.problems ?? bundled.problems }
  const { def, error } = core.instantiatePartScript(full.source)
  if (!def) return { problems: [error] }
  if (!def.manifest) return { problems: ['definePart() needs a `manifest`'] }
  const { materials = [], assets, geometry: fixed, ...head } = def.manifest
  let geometry = fixed
  if (typeof def.rig === 'function') {
    if (fixed) return { problems: ['give the geometry as rig() or as manifest.geometry, not both'] }
    const result = core.compileRig(def.rig, def.params ?? {})
    if (!result.geometry) return { problems: result.problems }
    geometry = result.geometry
  }
  if (!geometry) return { problems: ['definePart() needs rig() or manifest.geometry'] }
  // the head, then geometry, materials and assets: the key order the committed manifests have
  const manifest = { ...head, geometry, materials }
  if (assets?.length) manifest.assets = assets
  return {
    files: [
      { name: names.behavior, text: bundled.source },
      // a part folder's manifest ends in a newline, as the app writes one (core/project/projectFolder.ts)
      { name: names.manifest, text: JSON.stringify(manifest, null, 2) + (example ? '' : '\n') },
    ],
    modules: bundled.modules,
  }
}
