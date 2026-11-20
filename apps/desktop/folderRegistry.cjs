// Which folder each project lives in: the desktop's record of its project folders.
//
// On the desktop a project is a folder (docs/projects.md). The renderer names documents by id (its
// library, src/editor/project/documentStore.ts). This file maps each id to the folder holding it, plus what the
// two-way sync needs to resume after a restart: the folder's fingerprint and the
// per-file baselines (src/core/project/folderSync.ts). File > Open Recent is built from it too.
//
// Kept in main, in userData, rather than in the renderer's IndexedDB, for three reasons:
//   - main builds the menu that lists it and has no access to the renderer's storage;
//   - a write from here is synchronous, so the sync's last write before the window closes is recorded reliably
//     (an IndexedDB write started from an unloading page may never commit);
//   - it survives a cleared renderer profile, where losing the map would turn every project back into an app-only
//     document.
//
// A detached row (no path) records that the user unlinked the project from its folder on purpose, so
// the app does not quietly give it a new one on the next edit. Plain Node - testable with
// `node apps/desktop/folderRegistry.test.cjs`.

const { readFileSync, renameSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const VERSION = 1

/** Path identity: resolved, and case-folded where the filesystem is case-insensitive. */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const norm = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p))
  return norm(a) === norm(b)
}

/**
 * Open (or start) the registry kept in `file`. Every mutation is written through at once - the file is
 * a few KB, and a registry that lags the folder is how a restart would re-offer work already on disk.
 */
function createFolderRegistry(file) {
  let rows = []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data && Array.isArray(data.folders)) rows = data.folders.filter((r) => r && typeof r.docId === 'string')
  } catch {
    // first run, or a corrupt file: start empty. Projects are not lost - they are still folders, and
    // opening one registers it again.
  }

  const save = () => {
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ version: VERSION, folders: rows }, null, 2))
      renameSync(tmp, file)
    } catch {
      // best-effort: an unwritable userData loses the record across restarts, never the open project
    }
  }

  const find = (docId) => rows.find((r) => r.docId === docId) ?? null

  return {
    /** The row for a document, or null. */
    recall(docId) {
      return find(docId)
    },

    /** The row whose folder is `path`, or null - so opening a folder twice opens one project. */
    byPath(path) {
      return rows.find((r) => r.path && samePath(r.path, path)) ?? null
    },

    /** Every attached folder, most recently used first. */
    list() {
      return rows.filter((r) => typeof r.path === 'string' && r.path !== '').sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
    },

    /**
     * Record (or update) a document's folder. `patch` may carry path, name, signature, baseline,
     * trustDisk (see src/editor/project/projectFolderSync.ts), and `touch: true` to move it to the top of Open
     * Recent. A path another row held moves to this one: a folder belongs to one document at a time.
     */
    remember(docId, patch = {}) {
      if (typeof docId !== 'string' || docId === '') return
      if (typeof patch.path === 'string') rows = rows.filter((r) => r.docId === docId || !samePath(r.path, patch.path))
      let row = find(docId)
      if (!row) {
        row = { docId }
        rows.push(row)
      }
      for (const key of ['path', 'name', 'signature', 'baseline', 'trustDisk']) if (patch[key] !== undefined) row[key] = patch[key]
      if (typeof patch.path === 'string') delete row.detached
      if (patch.touch) row.openedAt = Date.now()
      save()
    },

    /** Unlink on purpose: keep the row as detached so the project is not given a folder again unasked. */
    detach(docId) {
      const row = find(docId)
      rows = rows.filter((r) => r.docId !== docId)
      rows.push({ docId, detached: true, ...(row && row.name ? { name: row.name } : {}) })
      save()
    },

    /** Drop a document's row entirely (the project was removed from the list). */
    forget(docId) {
      const before = rows.length
      rows = rows.filter((r) => r.docId !== docId)
      if (rows.length !== before) save()
    },
  }
}

module.exports = { createFolderRegistry, samePath }
