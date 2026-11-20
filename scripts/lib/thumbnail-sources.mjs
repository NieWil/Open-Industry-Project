// What decides a first-party part's catalog picture, hashed, so a picture rendered from older sources is caught
// without a browser. scripts/gen-thumbnails.mjs records the hash of each picture it writes in RECORD_FILE (outside
// public/, so it never ships); src/editor/thumbnailSources.test.ts fails when a part's sources no longer match it.
//
// A part's hash covers its definition (rig.json or manifest.json), its behavior and the raw bytes of every asset its
// definition names. Raw, not optimized: the generator renders against the dev server, which serves public/ as is.
// The renderer itself (lighting, framing) is not covered; a change there needs a full `npm run thumbnails`.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** the record of what each committed picture was rendered from, relative to the repo root */
export const RECORD_FILE = 'src/editor/thumbnailSources.json'

/** Filename-safe form of a package id. MUST match packageThumbFile() in src/core/parts/partPackage.ts. */
export const pkgThumbFile = (id) => id.replace(/[^a-z0-9._-]/gi, '_')

const lf = (s) => s.replace(/\r\n/g, '\n')
const dirs = (at) => (existsSync(at) ? readdirSync(at, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [])

function hashPart(root, definitionText, behaviorText) {
  const h = createHash('sha256')
  h.update(lf(definitionText)).update('\0').update(lf(behaviorText)).update('\0')
  const urls = (JSON.parse(definitionText).assets ?? []).map((a) => a?.url).filter((u) => typeof u === 'string' && u.startsWith('/'))
  for (const url of [...new Set(urls)].sort()) {
    const file = join(root, 'public', url)
    h.update(url).update('\0').update(existsSync(file) ? readFileSync(file) : 'missing').update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

/**
 * Every generated part picture, keyed by its path relative to the repo root, with the hash of its sources:
 * the bundled parts (examples/parts/<dir>, picture in public/thumbnails/pkg/) and the first-party library parts
 * (libraries/<lib>/<part>, picture beside the source). A part whose manifest carries its own thumbnail has no
 * generated picture and is left out.
 */
export function thumbnailSources(root) {
  const out = {}
  const parts = join(root, 'examples', 'parts')
  for (const dir of dirs(parts)) {
    const rig = join(parts, dir, 'rig.json')
    const behavior = join(parts, dir, 'behavior.ts')
    if (!existsSync(rig) || !existsSync(behavior)) continue
    const text = readFileSync(rig, 'utf8')
    const manifest = JSON.parse(text)
    if (manifest.thumbnail) continue
    out[`public/thumbnails/pkg/${pkgThumbFile(manifest.id)}.webp`] = hashPart(root, text, readFileSync(behavior, 'utf8'))
  }
  const libs = join(root, 'libraries')
  for (const lib of dirs(libs)) {
    for (const dir of dirs(join(libs, lib))) {
      const manifest = join(libs, lib, dir, 'manifest.json')
      const behavior = join(libs, lib, dir, 'behavior.js')
      if (!existsSync(manifest) || !existsSync(behavior)) continue
      out[`libraries/${lib}/${dir}/thumbnail.webp`] = hashPart(root, readFileSync(manifest, 'utf8'), readFileSync(behavior, 'utf8'))
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** the hashes the last generator run recorded, or {} */
export function readRecord(root) {
  const file = join(root, RECORD_FILE)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

/** the pictures whose sources changed since they were rendered, or that were never recorded */
export function staleThumbnails(root) {
  const record = readRecord(root)
  return Object.entries(thumbnailSources(root))
    .filter(([path, hash]) => record[path] !== hash)
    .map(([path]) => path)
}
