// Two-way sync between the open project and its folder on disk: the pure decision half.
//
// On the desktop a project is a folder (docs/projects.md "The folder is the project (two-way sync)"), which
// an agent, an editor or a `git checkout` can change underneath the app. This module decides, file by file, which
// way each change flows; it owns no I/O or timers (the engine is editor/project/projectFolderSync.ts).
//
// The rule, per file, against a baseline of the last time the two agreed:
//
//   changed only in the app        -> write it to the folder
//   changed only on disk           -> load it into the app
//   changed in both, differently   -> a conflict; nothing moves until the user picks a side
//   changed in both, identically   -> already agreed
//
// There are two baselines: what the disk held and what the app rendered. The app's rendering is not
// always byte-identical to what it loaded (filled defaults, a refreshed part snapshot, an agent's own JSON style).
// With one baseline that difference reads as an edit, so opening an agent-written folder would rewrite its files
// and every later sync would look like a conflict. A file is "changed in the app" only when the app's own
// rendering moved.
//
// Baselines are hashes: every question is "same as before?", and a manifest can be megabytes (base64 models).

import { AGENT_GUIDE, isPartSourceFile, PROGRAM_DIR, PROJECT_MANIFEST } from './projectFolder'
import type { ProjectFolderFile } from './projectFolder'
import { hashContents } from '../hash'
import { hashText } from '../hash'

export { hashText }

/** Folder-relative path -> {@link hashContents} of its contents (text, or an asset file's bytes). */
export type FileHashes = Record<string, string>

/** What the folder held, and what the app rendered, the last time the two agreed. */
export interface FolderBaseline {
  disk: FileHashes
  mine: FileHashes
}

/** What one sync round should do. `write` and `remove` go to the folder; `take` comes from it. */
export interface FolderSyncPlan {
  /** app-side edits to put on disk */
  write: ProjectFolderFile[]
  /** files the app stopped producing (a deleted scene, a removed part) that the disk still holds unchanged */
  remove: string[]
  /** paths the disk changed and the app did not: load them */
  take: string[]
  /** paths both sides changed, differently. When non-empty the round must do nothing else. */
  conflicts: string[]
}

/**
 * One write the host performs, guarded: `expect` is the {@link hashContents} the file must currently have,
 * null when it must not exist yet, or '*' for an unconditional write (the generated agent guide, and a
 * folder being saved into for the first time). `contents` undefined means delete.
 *
 * The guard is what makes a write safe against an agent writing the same file at the same moment. The
 * plan was made from a read that may be a second old; checking the file's current hash immediately
 * before replacing it closes that window, and a file that moved is reported back instead of
 * overwritten, so the next round sees both changes and calls it a conflict.
 */
export interface FolderWriteOp {
  path: string
  contents?: string | Uint8Array
  expect: string | null
}

/** The host's answer to a batch of {@link FolderWriteOp}s. */
export interface FolderWriteResult {
  /** paths skipped because the file no longer matched `expect` - someone else changed it first */
  moved: string[]
  /** paths that could not be written at all (permissions, a lock that outlived the retries) */
  failed: string[]
  /** the first failure's message, for the banner; null when every op was written or was a guard miss */
  error: string | null
}

/** The files a sync compares. The agent guide is excluded: it is generated from the project, so it is
 *  never an edit to carry either way. The engine rewrites it alongside any real write. A part's build sources (a
 *  `part.js`, a `parts/_shared/` module: {@link isPartSourceFile}) are excluded because the app never reads them, so
 *  no round writes, takes or removes one, and an edit to one does not reload the project. */
function syncable(files: readonly ProjectFolderFile[]): Map<string, string | Uint8Array> {
  const out = new Map<string, string | Uint8Array>()
  for (const f of files) if (f.path !== AGENT_GUIDE && !isPartSourceFile(f.path)) out.set(f.path, f.contents)
  return out
}

/** Hash every syncable file. */
export function hashFiles(files: readonly ProjectFolderFile[]): FileHashes {
  const out: FileHashes = {}
  for (const [path, contents] of syncable(files)) out[path] = hashContents(contents)
  return out
}

/** A baseline at which the two sides are agreed: nothing either holds reads as an edit. The one
 *  for a folder the app has just opened, or just written in full. */
export function agreedBaseline(mine: readonly ProjectFolderFile[], theirs: readonly ProjectFolderFile[]): FolderBaseline {
  return { disk: hashFiles(theirs), mine: hashFiles(mine) }
}

/**
 * Plan one round. `mine` is the app's rendering of the project now (projectToFolderFiles), `theirs` a
 * fresh read of the folder. Deterministic: paths are visited in sorted order, so a plan (and the
 * conflict list a banner shows) does not depend on how the folder happened to be walked.
 */
export function planFolderSync(
  baseline: FolderBaseline,
  mine: readonly ProjectFolderFile[],
  theirs: readonly ProjectFolderFile[],
): FolderSyncPlan {
  const m = syncable(mine)
  const t = syncable(theirs)
  const paths = new Set<string>([...m.keys(), ...t.keys(), ...Object.keys(baseline.mine), ...Object.keys(baseline.disk)])
  const plan: FolderSyncPlan = { write: [], remove: [], take: [], conflicts: [] }
  for (const path of [...paths].sort()) {
    const mineText = m.get(path)
    const diskText = t.get(path)
    const mineHash = mineText === undefined ? undefined : hashContents(mineText)
    const diskHash = diskText === undefined ? undefined : hashContents(diskText)
    if (mineHash === diskHash) continue // agreed, however either side got there
    const mineChanged = mineHash !== baseline.mine[path]
    const diskChanged = diskHash !== baseline.disk[path]
    if (mineChanged && diskChanged) plan.conflicts.push(path)
    else if (mineChanged) {
      if (mineText !== undefined) plan.write.push({ path, contents: mineText })
      else if (diskText !== undefined) plan.remove.push(path)
    } else if (diskChanged) plan.take.push(path)
    // neither changed yet they differ: the two sides render the same content differently (defaults
    // the store fills in, formatting an agent chose). Leave both alone - that is the whole point of
    // keeping two baselines.
  }
  return plan
}

/** The guarded ops that carry out a plan's writes and removes against `baseline.disk`. */
export function writeOpsFor(plan: FolderSyncPlan, baseline: FolderBaseline): FolderWriteOp[] {
  return [
    ...plan.write.map((f) => ({ path: f.path, contents: f.contents, expect: baseline.disk[f.path] ?? null })),
    ...plan.remove.map((path) => ({ path, expect: baseline.disk[path] ?? null })),
  ]
}

/** The folder as it will be once a plan's writes and removes land (the disk read, with ours applied). */
export function diskAfter(theirs: readonly ProjectFolderFile[], plan: FolderSyncPlan, skipped: readonly string[] = []): ProjectFolderFile[] {
  const out = new Map<string, string | Uint8Array>()
  for (const f of theirs) out.set(f.path, f.contents)
  const skip = new Set(skipped)
  for (const f of plan.write) if (!skip.has(f.path)) out.set(f.path, f.contents)
  for (const path of plan.remove) if (!skip.has(path)) out.delete(path)
  return [...out].map(([path, contents]) => ({ path, contents }))
}

/**
 * The baseline after a round: agreed on everything except the paths whose guarded write found the
 * file already moved. Those keep their old entries on both sides, so the next round, reading the
 * folder again, sees both changes and reports a conflict rather than guessing.
 */
export function advanceBaseline(
  previous: FolderBaseline,
  mineNow: readonly ProjectFolderFile[],
  diskNow: readonly ProjectFolderFile[],
  moved: readonly string[] = [],
): FolderBaseline {
  const next = agreedBaseline(mineNow, diskNow)
  for (const path of moved) {
    for (const side of ['disk', 'mine'] as const) {
      const was = previous[side][path]
      if (was === undefined) delete next[side][path]
      else next[side][path] = was
    }
  }
  return next
}

/**
 * Settle conflicted paths by picking a side, as a baseline change rather than as a second code path:
 * 'disk' forgets that the app changed them (so the next plan loads them), 'mine' forgets that the disk
 * did (so the next plan writes them). The ordinary round then does the rest, guards included.
 */
export function resolveConflicts(
  baseline: FolderBaseline,
  paths: readonly string[],
  side: 'disk' | 'mine',
  mine: readonly ProjectFolderFile[],
  theirs: readonly ProjectFolderFile[],
): FolderBaseline {
  const next: FolderBaseline = { disk: { ...baseline.disk }, mine: { ...baseline.mine } }
  const source = syncable(side === 'disk' ? mine : theirs)
  const target = side === 'disk' ? next.mine : next.disk
  for (const path of paths) {
    const contents = source.get(path)
    if (contents === undefined) delete target[path]
    else target[path] = hashContents(contents)
  }
  return next
}

interface ManifestMachine {
  scene?: unknown
  program?: unknown
  tests?: unknown
  stProgram?: unknown
  scenes?: unknown
  stScanMs?: unknown
  controller?: unknown
  stDialect?: unknown
  simHz?: unknown
  packages?: unknown
}

function parseManifest(text: string | undefined): ManifestMachine | null {
  if (text === undefined) return null
  try {
    const m = JSON.parse(text) as unknown
    return typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as ManifestMachine) : null
  } catch {
    // an unreadable manifest is unknown, and every caller then takes the cautious path
    return null
  }
}

/**
 * Does loading `taken` leave the scene exactly as it is on screen? Then the engine keeps the live scene (its undo
 * history, its selection) and only the rest of the project moves.
 *
 * Asked of the files, not of the reassembled project, for the same reason the baselines are split: the store's copy
 * of the scene is a rendering of it, and comparing renderings calls an untouched scene changed. The scene is
 * disturbed when its scene or program file was taken, when the manifest's machine fields moved (a new scan time, a
 * controller table, a dialect, a step rate, a different file), or when any part folder was - the library is what its
 * parts resolve against. A rename is not a disturbance: the name moves without reloading anything.
 */
export function sceneUntouched(taken: readonly string[], manifestBefore: string | undefined, manifestAfter: string | undefined): boolean {
  if (taken.some((p) => p.startsWith('parts/') || p.startsWith(`${PROGRAM_DIR}/`))) return false
  const after = parseManifest(manifestAfter)
  if (!after || after.scene === undefined) return false
  if (taken.includes(String(after.scene)) || (after.stProgram !== undefined && taken.includes(String(after.stProgram)))) return false
  if (!taken.includes(PROJECT_MANIFEST)) return true
  const before = parseManifest(manifestBefore)
  if (!before) return false
  const shape = (e: ManifestMachine): string =>
    JSON.stringify([e.scene, e.program ?? null, e.stProgram ?? null, e.stScanMs ?? null, e.controller ?? null, e.stDialect ?? null, e.simHz ?? null, e.packages ?? []])
  return shape(before) === shape(after)
}

/** The files a manifest names for each kind the app lays out itself, in order: the program (format 7's `program`
 *  list, or the one `stProgram` of formats 4-6) and the tests (one file per test, named from the test's name). */
function layoutPathsOf(files: readonly ProjectFolderFile[]): { program: string[]; tests: string[] } | null {
  const text = files.find((f) => f.path === PROJECT_MANIFEST)?.contents
  const m = parseManifest(typeof text === 'string' ? text : undefined)
  // a folder listing scenes is split before it is synced (editor/project/projectSplit.ts)
  if (!m || m.scenes !== undefined) return null
  const norm = (p: unknown): string => String(p).replace(/\\/g, '/').replace(/^\.\//, '')
  const program = Array.isArray(m.program) ? m.program.map(norm) : typeof m.stProgram === 'string' ? [norm(m.stProgram)] : []
  return { program, tests: Array.isArray(m.tests) ? m.tests.map(norm) : [] }
}

/**
 * `baseline`, made to rewrite the folder's layout when it names other program or test files than the app writes: the
 * one `program.st` of formats 4-6, POUs an agent put in one file, or a test file not named from its test's name. The
 * manifest and every file of that kind on either side then read as changed in the app, so the round writes the app's
 * files and the manifest naming them and removes the folder's others, each guarded like any write. Null when the two
 * name the same files, and while the folder has changed any of them since the baseline: that change is loaded first,
 * and the next round lays it out.
 *
 * Without this the rule that leaves a file the app only renders differently alone would leave the folder's layout, and
 * a later edit would write only the app's files, which the folder's manifest does not name: the next open would read
 * the stale program or test.
 */
export function layoutBaseline(baseline: FolderBaseline, mine: readonly ProjectFolderFile[], theirs: readonly ProjectFolderFile[]): FolderBaseline | null {
  const minePaths = layoutPathsOf(mine)
  const diskPaths = layoutPathsOf(theirs)
  if (minePaths === null || diskPaths === null) return null
  // each kind on its own, so a renamed test never rewrites the program files
  const kinds = (['program', 'tests'] as const).filter((k) => JSON.stringify(minePaths[k]) !== JSON.stringify(diskPaths[k]))
  if (kinds.length === 0) return null
  const moving = [...new Set([PROJECT_MANIFEST, ...kinds.flatMap((k) => [...minePaths[k], ...diskPaths[k]])])]
  const disk = syncable(theirs)
  const unchangedOnDisk = (path: string): boolean => {
    const contents = disk.get(path)
    return (contents === undefined ? undefined : hashContents(contents)) === baseline.disk[path]
  }
  if (!moving.every(unchangedOnDisk)) return null
  const next: FolderBaseline = { disk: { ...baseline.disk }, mine: { ...baseline.mine } }
  // a hash no file has: each of these reads as changed in the app, so the plan writes or removes it
  for (const path of moving) next.mine[path] = ''
  return next
}
