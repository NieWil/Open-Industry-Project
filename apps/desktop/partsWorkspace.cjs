// Reads a "parts workspace" folder from disk: the testable core of the desktop custom-part authoring
// loop. A workspace is a folder whose immediate subfolders are parts; each part folder holds a
// `manifest.json` + `behavior.js` (the shape docs/part-authoring-guide.md "The smallest conveyor" shows).
// This module does no Electron work (no dialog, no IPC), so it can be unit-tested with plain Node. main.cjs
// wires it to a folder picker and IPC.
//
// It returns raw manifest/behavior strings. Baking the param schema and structural validation belong to the
// renderer (src/sim/buildPackage.ts + src/core/parts/partValidate.ts), which must run them on untrusted imports
// anyway. Duplicating them here would risk drift.
//
// The one thing joined here is a part's asset files (`assets/<sha256>.glb`, src/core/parts/partAssets.ts): the manifest that
// names them is handed on with each one back in base64 `data`, the form every baker reads. A port of joinAssetFiles,
// whose tests pin the same rules (partsWorkspace.test.cjs here).

const { createHash } = require('node:crypto')
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const ASSET_PATH = /^assets\/[0-9a-f]{64}\.[a-z0-9]+$/

/** `manifestJson` with each `file` asset read from `dir` into `data`; unchanged when none names a file. Throws a
 *  message naming the asset when its file is missing, outside assets/, or does not hash to its name. */
function joinAssetFiles(manifestJson, dir) {
  if (!manifestJson.includes('"file"')) return manifestJson
  let manifest
  try {
    manifest = JSON.parse(manifestJson)
  } catch {
    return manifestJson // reported below, with its own message
  }
  const assets = manifest && manifest.assets
  if (!Array.isArray(assets) || !assets.some((a) => a && typeof a.file === 'string')) return manifestJson
  const joined = assets.map((a) => {
    if (!a || typeof a.file !== 'string') return a
    if (!ASSET_PATH.test(a.file)) throw new Error(`asset "${a.id}": "${a.file}" is not an asset file path (assets/<sha256>.<ext>)`)
    let bytes
    try {
      bytes = readFileSync(join(dir, ...a.file.split('/')))
    } catch {
      throw new Error(`asset "${a.id}": file "${a.file}" not found in the part folder`)
    }
    const name = a.file.slice('assets/'.length)
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (!name.startsWith(sha)) {
      throw new Error(`asset "${a.id}": "${a.file}" does not match its contents (its name is the SHA-256 of its bytes)`)
    }
    if (a.sha256 !== undefined && a.sha256 !== sha) throw new Error(`asset "${a.id}": its sha256 does not match "${a.file}"`)
    const { file: _file, ...rest } = a
    return { ...rest, data: bytes.toString('base64') }
  })
  return JSON.stringify({ ...manifest, assets: joined })
}

const EXTENSION_OF_MIME = { 'model/gltf-binary': 'glb', 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/ktx2': 'ktx2' }

/**
 * The inverse, for a writer (a port of splitAssetFiles): each embedded asset whose base64 reads back exactly becomes a
 * file named by the SHA-256 of its bytes, and the manifest names the file. `url` assets, and text that would not read
 * back exactly, stay as they are. Returns the manifest object and the files, `{ path: 'assets/<sha256>.glb', bytes }`.
 */
function splitAssetFiles(manifest) {
  if (!manifest || !Array.isArray(manifest.assets)) return { manifest, files: [] }
  const files = new Map()
  const assets = manifest.assets.map((a) => {
    if (!a || typeof a.data !== 'string' || a.data === '') return a
    const bytes = Buffer.from(a.data, 'base64')
    if (bytes.toString('base64') !== a.data) return a
    const path = `assets/${createHash('sha256').update(bytes).digest('hex')}.${EXTENSION_OF_MIME[a.mime] || 'bin'}`
    files.set(path, bytes)
    const { data: _data, ...rest } = a
    return { ...rest, file: path }
  })
  if (files.size === 0) return { manifest, files: [] }
  return { manifest: { ...manifest, assets }, files: [...files].map(([path, bytes]) => ({ path, bytes })) }
}

/**
 * Read a single part folder. Throws with a clear message if it isn't a well-formed part folder.
 * @param {string} dir absolute path to a part folder
 * @returns {{ dir: string, id: string, name: string, manifestJson: string, behaviorSource: string }}
 */
function readPartFolder(dir) {
  let manifestJson
  try {
    manifestJson = readFileSync(join(dir, 'manifest.json'), 'utf8')
  } catch {
    throw new Error('missing manifest.json')
  }
  let behaviorSource
  try {
    behaviorSource = readFileSync(join(dir, 'behavior.js'), 'utf8')
  } catch {
    throw new Error('missing behavior.js')
  }
  let manifest
  try {
    manifest = JSON.parse(manifestJson)
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const id = typeof manifest.id === 'string' ? manifest.id : ''
  if (!id) throw new Error('manifest.json is missing a string "id"')
  const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : id
  return { dir, id, name, manifestJson: joinAssetFiles(manifestJson, dir), behaviorSource }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Scan a workspace folder for parts. Each immediate subfolder containing a manifest.json is read; a
 * subfolder that fails to read is reported in `problems` rather than aborting the whole scan.
 * @param {string} root absolute path to the workspace folder
 * @returns {{ parts: Array<ReturnType<typeof readPartFolder>>, problems: Array<{ dir: string, message: string }> }}
 */
function listWorkspace(root) {
  const parts = []
  const problems = []
  let entries
  try {
    entries = readdirSync(root)
  } catch (e) {
    return { parts, problems: [{ dir: root, message: `cannot read workspace: ${e instanceof Error ? e.message : String(e)}` }] }
  }
  for (const entry of entries.sort()) {
    const dir = join(root, entry)
    if (!isDir(dir)) continue
    // Only treat a subfolder as a part if it declares a manifest; skip unrelated dirs silently.
    if (!isFile(join(dir, 'manifest.json'))) continue
    try {
      parts.push(readPartFolder(dir))
    } catch (e) {
      problems.push({ dir, message: e instanceof Error ? e.message : String(e) })
    }
  }
  parts.sort((a, b) => a.name.localeCompare(b.name))
  return { parts, problems }
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

module.exports = { readPartFolder, listWorkspace, splitAssetFiles }
