// Opening a project or part file from outside the app: a double-click on a `.oip` / `.oippart` (the installer
// registers both, package.json build.fileAssociations), "Open with", or a path on the command line.
//
// Main reads the file and hands the renderer its bytes, never a path. The renderer imports them exactly as its own
// Import Project / Import part would (src/editor/desktop/desktopFileOpen.ts), and gets no access to the folder the file sat
// in. A `.oip` becomes a project of its own (its folder is made on its first edit, like any new project); a `.oippart`
// goes into the open project's parts. Neither edits the file: a `.oip` is a way in and out, never a place a project
// lives (docs/part-sources.md).
//
// Plain Node, no Electron, so `node apps/desktop/fileOpen.test.cjs` runs it.

const { readFileSync, statSync } = require('node:fs')
const { basename, extname } = require('node:path')

/** The extensions the app opens, and what each is. */
const DOCUMENT_KINDS = { '.oip': 'project', '.oippart': 'part' }

// A .oip carries its models as files, so it can be large; past this it is not a project anyone made in the app.
const MAX_DOCUMENT_BYTES = 1024 * 1024 * 1024

/** What a path names, by its extension: 'project', 'part', or null. */
function documentKind(path) {
  return DOCUMENT_KINDS[extname(String(path)).toLowerCase()] ?? null
}

/**
 * The first project or part file named on a command line, or null. Flags, links and the app's own path are skipped
 * (they never end in one of the extensions); a path that does not exist as a file is skipped too.
 */
function documentFileArg(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg.startsWith('-') || documentKind(arg) === null) continue
    try {
      if (statSync(arg).isFile()) return arg
    } catch {
      /* not there */
    }
  }
  return null
}

/** Read a document file for the renderer: `{ name, kind, bytes }`, or `{ error }` naming what is wrong. */
function readDocumentFile(path) {
  const kind = documentKind(path)
  if (kind === null) return { error: `${basename(path)} is not a project or part file` }
  try {
    const size = statSync(path).size
    if (size > MAX_DOCUMENT_BYTES) return { error: `${basename(path)} is too large to open (${Math.round(size / 1048576)} MB)` }
    return { name: basename(path), kind, bytes: new Uint8Array(readFileSync(path)) }
  } catch (e) {
    return { error: `couldn't read ${basename(path)}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

module.exports = { documentKind, documentFileArg, readDocumentFile, MAX_DOCUMENT_BYTES }
