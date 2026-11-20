// Filesystem I/O for the on-disk project folder (docs/projects.md "the same manifest spilled into a
// folder"). This module only moves raw {path, contents} files between disk and the renderer (text, or bytes for a
// part's asset file). The format (manifest refs, validation, reassembly) lives in src/core/project/projectFolder.ts, and
// the sync rules (what to write, what to load) in src/core/project/folderSync.ts, so the desktop shell never has a
// second opinion about what a project is. Plain Node (no Electron), so it is testable with
// `node apps/desktop/projectFolderIo.test.cjs`.
// The CLIs read a folder through this same walk (scripts/lib/projectFolderFiles.mjs).

const { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

// The files a project folder is made of: the root manifest plus everything under the codec-owned
// subfolders. Text-extension filtered so a stray binary (a screenshot, a .glb someone dropped in)
// is never read into memory; unreferenced text files are ignored by the codec. The one binary
// read is a part's asset file, which the format names by its hash (src/core/parts/partAssets.ts).
// `.js` = each part folder's behavior.js (parts/<id>/ is the parts-workspace two-file layout); `.st` / `.ld` = the
// program's files (plc/, and the one-file program.st of formats 4-6).
const MANIFEST = 'project.json'
// the root files and subfolders (src/core/project/projectFolder.ts PROJECT_ROOT_FILES / PROJECT_SUBDIRS - keep in sync;
// projectFolder.test.ts pins this copy)
const ROOT_FILES = [MANIFEST, 'scene.json', 'program.st']
const SUBDIRS = ['plc', 'scenes', 'parts', 'tests', 'assemblies']
const TEXT_EXTENSIONS = ['.json', '.st', '.ld', '.js']
const MAX_DEPTH = 3 // parts/ may later hold per-part folders; a runaway symlink loop must not

function isTextFile(name) {
  return TEXT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
}

/** A part's asset file: `<part>/assets/<sha256>.<ext>` (src/core/parts/partAssets.ts isAssetFileInTree - keep in sync). */
function isAssetFile(rel) {
  return /(^|\/)assets\/[0-9a-f]{64}\.[a-z0-9]+$/.test(rel)
}

/** A file's contents in the codec's form: an asset file's bytes, every other file's text. */
function readContents(rel, abs) {
  return isAssetFile(rel) ? new Uint8Array(readFileSync(abs)) : readFileSync(abs, 'utf8')
}

const isContents = (c) => typeof c === 'string' || c instanceof Uint8Array

/** Visit the root files and every text file under the subfolders: `visit(relPosixPath, absPath)`. */
function walkProject(root, visit) {
  for (const name of ROOT_FILES) {
    try {
      statSync(join(root, name))
      visit(name, join(root, name))
    } catch {
      // absent: fall through with whatever else is there; the codec names the real problem
    }
  }
  const walk = (dir, rel, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // absent/unreadable subfolder - same story as the manifest above
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(join(dir, entry.name), `${rel}/${entry.name}`, depth + 1)
      } else if (entry.isFile() && (isTextFile(entry.name) || isAssetFile(`${rel}/${entry.name}`))) {
        visit(`${rel}/${entry.name}`, join(dir, entry.name))
      }
    }
  }
  for (const sub of SUBDIRS) walk(join(root, sub), sub, 1)
}

/**
 * Read a project folder's files for the renderer-side codec. Returns {path, contents}[] with
 * folder-relative POSIX paths. A missing manifest or subfolder is not an error here; the codec reports
 * "not a project folder" with a better message than a thrown ENOENT. A folder that is not there at
 * all is an error: a project whose folder was moved or deleted must say so rather than read as empty.
 */
function readProjectFolder(root) {
  statSync(root) // throws ENOENT for a folder that is gone
  const files = []
  walkProject(root, (rel, abs) => files.push({ path: rel, contents: readContents(rel, abs) }))
  return files
}

/**
 * A cheap fingerprint of the folder (every project file's path, size and mtime, sorted), so the
 * renderer's once-a-second check reads no file contents unless something changed. Same shape as the
 * browser's (src/editor/project/projectFolderLink.ts folderSignature). Throws when the folder is gone.
 */
function folderSignature(root) {
  statSync(root)
  const parts = []
  walkProject(root, (rel, abs) => {
    try {
      const s = statSync(abs)
      parts.push(`${rel}:${s.size}:${Math.floor(s.mtimeMs)}`)
    } catch {
      // deleted between the listing and the stat: the next check sees it gone
    }
  })
  return parts.sort().join('\n')
}

/**
 * The content hash the renderer's baselines are made of: an exact copy of hashText in
 * src/core/project/folderSync.ts (cyrb53, length-prefixed). Both test suites pin the same vectors. If they
 * ever disagreed, every guarded write would read as "someone else changed this file" and none would be written.
 */
function hashText(text) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

/** The same over bytes: an exact copy of hashBytes in src/core/hash.ts, pinned by the same vectors. */
function hashBytes(bytes) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i]
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `b${bytes.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

const hashContents = (c) => (typeof c === 'string' ? hashText(c) : hashBytes(c))

/** Reject absolute/escaping/driveful paths so a malformed renderer payload can't write outside `root`. */
function safeRelPath(p) {
  if (typeof p !== 'string' || p === '') return null
  const segments = p.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes(':')) return null
  }
  return join(...segments)
}

/**
 * Write the codec's files into `root`, creating subfolders as needed. Overwrites what it writes and
 * leaves everything else alone (loading is manifest-driven, so a stale scene file from a rename is
 * inert; deleting unrecognized files could delete a user's notes). Returns '' or an error message.
 */
function writeProjectFolder(root, files) {
  if (!Array.isArray(files) || files.length === 0) return 'nothing to write'
  for (const f of files) {
    const rel = f && safeRelPath(f.path)
    if (!rel || !isContents(f.contents)) return `invalid file entry: ${String(f && f.path)}`
  }
  try {
    for (const f of files) {
      const target = join(root, safeRelPath(f.path))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.contents)
    }
  } catch (e) {
    return `couldn't write project folder: ${e instanceof Error ? e.message : String(e)}`
  }
  return ''
}

// Errors a Windows file briefly held by something else raises: OneDrive syncing the folder (Documents is
// often redirected into it), an antivirus scan, an editor's own save. They clear in milliseconds, so they
// are retried rather than reported.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRY_DELAYS_MS = [15, 40, 90, 200]
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn()
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !TRANSIENT.has(e && e.code)) throw e
      pause(RETRY_DELAYS_MS[attempt])
    }
  }
}

/** Write one file so a reader never sees half of it: a sibling temp file, then a rename over the target.
 *  An agent reading plc/Main.st mid-save gets the old program or the new one, never a torn one. */
function writeAtomically(target, contents) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.oip-tmp`
  writeFileSync(tmp, contents)
  try {
    withRetry(() => renameSync(tmp, target))
  } catch {
    // A lock that outlived the retries: some sync clients refuse a rename over a file they hold yet
    // allow a plain write into it. Fall back to writing in place, and clear the temp file either way.
    try {
      unlinkSync(tmp)
    } catch {
      /* already gone */
    }
    withRetry(() => writeFileSync(target, contents))
  }
}

/** Remove the folders a delete emptied, up to (never including) the format's own subfolders. */
function pruneEmpty(root, fromDir) {
  let dir = fromDir
  while (dir.startsWith(root) && dir !== root && !SUBDIRS.some((s) => dir === join(root, s))) {
    try {
      if (readdirSync(dir).length > 0) return
      rmdirSync(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

/**
 * Carry out guarded writes (src/core/project/folderSync.ts FolderWriteOp): each op replaces or deletes one
 * file only if the file currently hashes to `op.expect` (null = must not exist, '*' = unconditional).
 * A file that changed since the renderer last read it is skipped and reported in `moved`. The renderer
 * then sees both changes and asks the user, instead of this silently writing over an agent's edit.
 *
 * Every op is attempted even when an earlier one fails: they are independent files, and one locked
 * file must not hold back the rest. A failed op is reported in `failed`, with the first error.
 * @returns {{ moved: string[], failed: string[], error: string | null }}
 */
function applyFolderWrites(root, ops) {
  const moved = []
  const failed = []
  let error = null
  if (!Array.isArray(ops)) return { moved, failed, error: 'invalid write batch' }
  for (const op of ops) {
    const rel = op && safeRelPath(op.path)
    if (!rel || (op.contents !== undefined && !isContents(op.contents))) {
      failed.push(String(op && op.path))
      error = error || `invalid file entry: ${String(op && op.path)}`
      continue
    }
    const target = join(root, rel)
    try {
      if (op.expect !== '*') {
        let current = null
        try {
          current = hashContents(readContents(op.path, target))
        } catch (e) {
          if (!e || e.code !== 'ENOENT') throw e
        }
        if (current !== op.expect) {
          moved.push(op.path)
          continue
        }
      }
      if (op.contents === undefined) {
        try {
          withRetry(() => unlinkSync(target))
        } catch (e) {
          if (!e || e.code !== 'ENOENT') throw e
        }
        pruneEmpty(root, dirname(target))
      } else {
        writeAtomically(target, op.contents)
      }
    } catch (e) {
      failed.push(op.path)
      error = error || `couldn't write ${op.path}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { moved, failed, error }
}

/** Does `root` already hold a project? (Asked before writing one over it.) */
function hasProjectManifest(root) {
  try {
    return statSync(join(root, MANIFEST)).isFile()
  } catch {
    return false
  }
}

module.exports = { readProjectFolder, writeProjectFolder, applyFolderWrites, folderSignature, hashText, hashBytes, hasProjectManifest, MANIFEST }
