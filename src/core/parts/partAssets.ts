// A part's assets as files beside its manifest (docs/part-sources.md "Assets"). In memory, and in every document
// that is one JSON text (the browser autosave, a room, a scene file), an embedded asset is base64 in `data`. In a
// part folder - a project's parts/<slug>/, the shelf, a .oip - it can instead be a real file named by the SHA-256 of
// its bytes, which the manifest names:
//
//   parts/<slug>/manifest.json            "assets": [{ "id": "body", "mime": "model/gltf-binary", "file": "assets/<sha256>.glb" }]
//   parts/<slug>/assets/<sha256>.glb
//
// Real files keep base64 (a third bigger, one huge JSON line) out of git diffs, merges and the folder sync's hashes,
// and the hash makes a file's name its identity: two parts with the same texture store it once per part, and a
// changed model is a new file plus a one-line change in the manifest.
//
// Every host that reads a part folder joins `file` assets back into `data` before the manifest is baked
// ({@link joinAssetFiles}), so the rest of the app never sees the folder form. The writers ({@link splitAssetFiles})
// produce it from project format 6, which is what makes an older build refuse such a folder by its version. `url`
// assets (an app-served file) pass through both untouched.
//
// Pure: bytes in, bytes out, no filesystem. sha256.ts is the hash, so a name computed here, in the desktop shell or
// in a CLI is the same name.

import { sha256HexOfBytes } from '../sha256'

/** The directory, inside a part folder, that holds its asset files. */
export const PART_ASSETS_DIR = 'assets'

/** The bytes of one asset file, at a path relative to its part folder (`assets/<sha256>.glb`). */
export interface PartAssetFile {
  path: string
  bytes: Uint8Array
}

const EXTENSION_OF_MIME: Readonly<Record<string, string>> = {
  'model/gltf-binary': 'glb',
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/ktx2': 'ktx2',
}

/** The file name an asset's bytes are stored under: their SHA-256, with an extension from the mime type. */
export function assetFileName(bytes: Uint8Array, mime: string): string {
  return `${sha256HexOfBytes(bytes)}.${EXTENSION_OF_MIME[mime] ?? 'bin'}`
}

/** Is `path` (relative to a part folder) where this format keeps an asset file? Hosts that walk a folder use it to
 *  decide which files to read as bytes. */
export function isPartAssetPath(path: string): boolean {
  return /^assets\/[0-9a-f]{64}\.[a-z0-9]+$/.test(path)
}

/** Is `path` an asset file inside any part folder of a larger tree (`parts/<slug>/assets/<sha256>.glb` in a project,
 *  `<slug>/assets/...` on the shelf)? The one test a host walking a folder needs to read a file as bytes, not text. */
export function isAssetFileInTree(path: string): boolean {
  return /(^|\/)assets\/[0-9a-f]{64}\.[a-z0-9]+$/.test(path.replace(/\\/g, '/'))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i

/** Standard base64 (with padding) of `bytes`. Our own, so core does not lean on a host's `btoa`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  let chunk = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    const n = (a << 16) | (b << 8) | c
    chunk +=
      B64[(n >> 18) & 63]! +
      B64[(n >> 12) & 63]! +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') +
      (i + 2 < bytes.length ? B64[n & 63]! : '=')
    // a string built by += past a few hundred KB is slow to flatten; flush in pieces
    if (chunk.length >= 0x8000) {
      parts.push(chunk)
      chunk = ''
    }
  }
  parts.push(chunk)
  return parts.join('')
}

/** The bytes of standard base64 text, or null when it is not valid base64 (whitespace is ignored). */
export function base64ToBytes(text: string): Uint8Array | null {
  const s = text.replace(/\s+/g, '')
  if (s.length % 4 !== 0) return null
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
  const out = new Uint8Array((s.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    let n = 0
    for (let j = 0; j < 4; j++) {
      const ch = s.charCodeAt(i + j)
      const v = ch === 61 && i + j >= s.length - pad ? 0 : ch < 128 ? B64_INDEX[ch]! : -1
      if (v < 0) return null
      n = (n << 6) | v
    }
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/**
 * A part manifest with its `file` assets joined back into base64 `data`, the form every baker and validator reads.
 * `read` returns an asset file's bytes by its path relative to the part folder, or undefined when the folder has no
 * such file.
 *
 * Returns the manifest text unchanged when no asset names a file (every folder written so far), so a reader does
 * no extra work until the layout is in use. A file that is missing, or whose bytes do not hash to its name, is an error
 * naming the path: a renamed or truncated model must fail the open, not load a part with a hole in it.
 */
export function joinAssetFiles(
  manifestJson: string,
  read: (path: string) => Uint8Array | undefined,
): { manifestJson: string; error?: undefined } | { error: string } {
  if (!manifestJson.includes('"file"')) return { manifestJson }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestJson)
  } catch {
    return { manifestJson } // the baker reports an unparseable manifest, with its own message
  }
  const assets = (manifest as { assets?: unknown } | null)?.assets
  if (!Array.isArray(assets) || !assets.some((a) => typeof (a as { file?: unknown } | null)?.file === 'string')) {
    return { manifestJson }
  }
  const joined: unknown[] = []
  for (const raw of assets) {
    const a = raw as { file?: unknown } & Record<string, unknown>
    if (typeof a?.file !== 'string') {
      joined.push(raw)
      continue
    }
    const path = a.file
    if (!isPartAssetPath(path)) return { error: `asset "${String(a.id)}": "${path}" is not an asset file path (assets/<sha256>.<ext>)` }
    const bytes = read(path)
    if (bytes === undefined) return { error: `asset "${String(a.id)}": file "${path}" not found in the part folder` }
    const name = path.slice(PART_ASSETS_DIR.length + 1)
    const sha = sha256HexOfBytes(bytes)
    if (!name.startsWith(sha)) return { error: `asset "${String(a.id)}": "${path}" does not match its contents (its name is the SHA-256 of its bytes)` }
    if (a.sha256 !== undefined && a.sha256 !== sha) return { error: `asset "${String(a.id)}": its sha256 does not match "${path}"` }
    const { file: _file, ...rest } = a
    joined.push({ ...rest, data: bytesToBase64(bytes) })
  }
  return { manifestJson: JSON.stringify({ ...(manifest as object), assets: joined }) }
}

/** Options for a writer. */
export interface SplitOptions {
  /**
   * The bytes of an app-served asset by its SHA-256, when the host has them at hand (a synchronous lookup: the folder
   * sync writes as the window closes, which cannot wait for a fetch). A `url` asset that names its `sha256` is then
   * written as a file like an embedded one; without the bytes it stays a `url`, which is still valid.
   */
  assetBytes?: (sha256: string) => Uint8Array | undefined
}

// The folder sync renders the whole project every round (a second or so apart), so the same embedded model would be
// decoded, re-encoded and hashed each time. Keyed by the base64 text, which is what the work is a function of.
const SPLIT_CACHE_MAX = 64
// The key is the data string itself (the same string object the package holds, so no copy of it is made).
const splitCache = new Map<string, { mime: string; out: { path: string; bytes: Uint8Array } | null }>()

function splitData(data: string, mime: string): { path: string; bytes: Uint8Array } | null {
  const known = splitCache.get(data)
  if (known !== undefined && known.mime === mime) return known.out
  const bytes = base64ToBytes(data)
  // only text that reads back exactly (canonical base64): the package in memory, and so its fingerprint and every
  // origin stamp made from it, must be the same after a folder round trip
  const out = bytes === null || bytesToBase64(bytes) !== data ? null : { path: `${PART_ASSETS_DIR}/${assetFileName(bytes, mime)}`, bytes }
  if (splitCache.size >= SPLIT_CACHE_MAX) splitCache.delete(splitCache.keys().next().value!)
  splitCache.set(data, { mime, out })
  return out
}

/** The extension a `url` asset's file takes: from its mime type, else from the url (`/part-assets/<sha>.glb`). */
function extensionOf(mime: string, url: string): string {
  return EXTENSION_OF_MIME[mime] ?? /\.([a-z0-9]+)$/.exec(url)?.[1] ?? 'bin'
}

/**
 * The inverse, for a writer: each embedded (`data`) asset of a manifest object becomes a file named by its hash, and
 * the manifest names the file instead, keeping the asset's other fields (a `sha256` included). A `url` asset with a
 * `sha256` the host has bytes for ({@link SplitOptions.assetBytes}) is written the same way; other `url` assets, and
 * anything that is not canonical base64, are left as they are. Two assets with the same bytes share one file.
 */
export function splitAssetFiles<M extends { assets?: readonly unknown[] }>(manifest: M, opts?: SplitOptions): { manifest: M; files: PartAssetFile[] } {
  if (!Array.isArray(manifest.assets)) return { manifest, files: [] }
  const files = new Map<string, Uint8Array>()
  let changed = false
  const assets = manifest.assets.map((raw) => {
    const a = raw as { data?: unknown; mime?: unknown; url?: unknown; sha256?: unknown } & Record<string, unknown>
    const mime = typeof a?.mime === 'string' ? a.mime : ''
    if (typeof a?.data === 'string' && a.data !== '') {
      const split = splitData(a.data, mime)
      if (split === null) return raw
      files.set(split.path, split.bytes)
      changed = true
      const { data: _data, ...rest } = a
      return { ...rest, file: split.path }
    }
    if (typeof a?.url === 'string' && typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256) && opts?.assetBytes) {
      const bytes = opts.assetBytes(a.sha256)
      if (bytes === undefined) return raw
      const path = `${PART_ASSETS_DIR}/${a.sha256}.${extensionOf(mime, a.url)}`
      files.set(path, bytes)
      changed = true
      const { url: _url, ...rest } = a
      return { ...rest, file: path }
    }
    return raw
  })
  if (!changed) return { manifest, files: [] }
  return { manifest: { ...manifest, assets }, files: [...files].map(([path, bytes]) => ({ path, bytes })) }
}
