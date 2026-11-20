// The parts shelf on disk (docs/parts-shelf.md): a folder of part folders, kept outside any project, for projects to
// copy from. The same layout a project's parts/ uses and a folder import (Import part > A folder of parts…) reads (partsWorkspace.cjs), so a
// shelf can be a shared drive or a git repository a team keeps its standard parts in.
//
// The renderer never names a path here. It asks for the listing, and hands a part over by id to be written. The
// shelf folder is main's, and the part's folder on it is found by id (a hand-made folder keeps its name) or made
// from the id. Building and checking a part stays the renderer's (src/sim/buildPackage.ts), as for every import.
//
// No Electron here, so it runs under plain Node: `node apps/desktop/partsShelf.test.cjs`.

const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { listWorkspace, splitAssetFiles } = require('./partsWorkspace.cjs')

// The card image beside a part: a part that is only on the shelf is not loaded in the project, so the app cannot render
// its card, and reads this file instead. It is not part of the part's content (not in the manifest), so writing it never
// changes what version a project's copy reads as.
const THUMBNAIL = 'thumbnail.png'
// a card image is a few tens of KB; anything far larger is not one the app wrote, and is left unread
const MAX_THUMBNAIL_BYTES = 1024 * 1024
const PNG_DATA_URL = 'data:image/png;base64,'

/** The shelf's parts, or none while the folder does not exist yet (nothing has been put on it). */
function listShelf(root) {
  if (!existsSync(root)) return { root, parts: [], problems: [] }
  const listed = listWorkspace(root)
  for (const part of listed.parts) {
    try {
      const bytes = readFileSync(join(part.dir, THUMBNAIL))
      if (bytes.length <= MAX_THUMBNAIL_BYTES) part.thumbnail = PNG_DATA_URL + bytes.toString('base64')
    } catch {
      // no card image: the card shows the generic glyph
    }
  }
  return { root, ...listed }
}

/** A file's name, size and change time, or that it is missing. */
function fileStamp(path) {
  try {
    const s = statSync(path)
    return `${path}:${s.size}:${s.mtimeMs}`
  } catch {
    return `${path}:-`
  }
}

/**
 * What the shelf's files are, by name, size and change time, with none of their contents. The renderer reads the shelf
 * again on every window focus; it compares this first, so an unchanged shelf is not read and sent whole (a team's
 * version of a built-in carries its model, several MB).
 */
function shelfSignature(root) {
  let entries
  try {
    entries = readdirSync(root).sort()
  } catch {
    return `${root}|unreadable`
  }
  const out = [root]
  for (const entry of entries) {
    const dir = join(root, entry)
    for (const file of ['manifest.json', 'behavior.js', THUMBNAIL]) out.push(fileStamp(join(dir, file)))
    try {
      for (const name of readdirSync(join(dir, 'assets')).sort()) out.push(fileStamp(join(dir, 'assets', name)))
    } catch {
      // no assets folder
    }
  }
  return out.join('\n')
}

/**
 * A folder name for a part id that every OS accepts and cannot climb out of the shelf: the id's own characters
 * where they are safe, `-` for the rest. Ids are dotted names (`acme.transfer`), which pass through unchanged.
 */
function folderNameForId(id) {
  const base = String(id).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').replace(/[. ]+$/, '')
  return base === '' ? 'part' : base
}

/** Write a file whole: to a sibling first, then renamed over, so a reader never sees half a part. */
function writeWhole(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, contents)
  renameSync(tmp, path)
}

/**
 * Put a part on the shelf: its manifest.json and behavior.js, in the folder that already holds that id, else a new
 * one named for it, and its card image when `thumbnail` is a PNG data URL. Returns '' or the error to show.
 * `manifestJson` must name `id`.
 */
function writeShelfPart(root, id, manifestJson, behaviorSource, thumbnail) {
  if (typeof id !== 'string' || id === '') return 'A part needs an id to go on the shelf.'
  if (typeof manifestJson !== 'string' || typeof behaviorSource !== 'string') return 'The part could not be read.'
  let manifest
  try {
    manifest = JSON.parse(manifestJson)
  } catch {
    return 'The part could not be read.'
  }
  if (!manifest || manifest.id !== id) return 'The part could not be read.'
  try {
    mkdirSync(root, { recursive: true })
    const existing = listShelf(root).parts.find((p) => p.id === id)
    let dir = existing?.dir
    if (!dir) {
      // a new folder: named for the id, numbered past a folder of that name holding something else
      const base = folderNameForId(id)
      dir = join(root, base)
      for (let n = 2; existsSync(dir); n++) dir = join(root, `${base}-${n}`)
      mkdirSync(dir)
    }
    // embedded assets go on the shelf as hash-named files beside the manifest, the layout a project's parts/ uses
    // (src/core/parts/partAssets.ts); files the new version no longer names are removed, so the folder holds one version
    const split = splitAssetFiles(manifest)
    const keep = new Set(split.files.map((f) => f.path.slice('assets/'.length)))
    for (const f of split.files) {
      mkdirSync(join(dir, 'assets'), { recursive: true })
      if (!existsSync(join(dir, ...f.path.split('/')))) writeWhole(join(dir, ...f.path.split('/')), f.bytes)
    }
    writeWhole(join(dir, 'manifest.json'), split.files.length > 0 ? JSON.stringify(split.manifest, null, 2) + '\n' : manifestJson)
    writeWhole(join(dir, 'behavior.js'), behaviorSource)
    // an image of the version before would show the wrong part, so a version written without one drops it
    if (typeof thumbnail === 'string' && thumbnail.startsWith(PNG_DATA_URL)) writeWhole(join(dir, THUMBNAIL), Buffer.from(thumbnail.slice(PNG_DATA_URL.length), 'base64'))
    else if (existsSync(join(dir, THUMBNAIL))) unlinkSync(join(dir, THUMBNAIL))
    if (existsSync(join(dir, 'assets'))) {
      for (const name of readdirSync(join(dir, 'assets'))) {
        if (/^[0-9a-f]{64}\.[a-z0-9]+$/.test(name) && !keep.has(name)) unlinkSync(join(dir, 'assets', name))
      }
    }
    return ''
  } catch (e) {
    return `The part could not be put on the shelf: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** The shelf folder the user chose (`<userData>/parts-shelf.json`), else null. */
function readChosenShelf(settingsFile) {
  try {
    const path = JSON.parse(readFileSync(settingsFile, 'utf8')).path
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    return null
  }
}

function writeChosenShelf(settingsFile, path) {
  writeWhole(settingsFile, JSON.stringify({ path }, null, 2) + '\n')
}

module.exports = { listShelf, shelfSignature, writeShelfPart, folderNameForId, readChosenShelf, writeChosenShelf }
