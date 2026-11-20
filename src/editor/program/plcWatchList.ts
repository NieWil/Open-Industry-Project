// The Watch dock's list (components/plc/WatchPanel.tsx): the variables a reader picked to follow while the program runs, looked up in the running
// program's variable image (EditorController.plcWatch), and remembered per project in this browser.
//
// The list is debugging state, not part of the program: picking a variable must not be an edit (no undo step, no
// autosave, nothing in a room's feed; docs/document-and-run.md). So it lives in localStorage like the organizer's width,
// with a copy in memory that every surface adding to it goes through (the dock, and the text's and the rungs' Add to
// Watch), so an open dock hears of an addition and a storage that throws still keeps the list for the session.

import { KEYWORDS } from '../../plc'
import type { TagValue } from '../../plc'
import { keySetOf } from '../../core/watchKeys'
import { watchElementKey, watchElementsUnder, watchKeysOf } from '../../core/watchTable'
import { currentDocumentId } from '../project/documentStore'
import { ownSharedProject } from '../project/sharedProject'

/** One watched name as the image answers it. */
export interface WatchRow {
  /** the name as the reader wrote it */
  name: string
  /** the image's own spelling of it, when it holds the name as one value (the key a write goes by) */
  key: string | null
  value: TagValue | undefined
  /** a structure, an array or a program instance: the values under the name, in the image's order */
  members: readonly { key: string; value: TagValue }[]
  /** members past {@link MAX_MEMBERS} that are not listed */
  more: number
}

/** Most values one row lists under a structured name. A large array has thousands; the rest are counted. */
export const MAX_MEMBERS = 64

// What a name resolves to depends on the image's keys alone, so it is kept per key set (core/watchKeys.ts), not per
// image: the client replaces the image on every frame that brings a new table, with the same keys.
interface KeyIndex {
  /** the keys by their upper-case spelling: ST names are case-insensitive */
  upper: Map<string, string>
  /** upper-case name -> the one instance variable it means without its instance, or null */
  owners: Map<string, string | null>
  /** upper-case name -> the keys under it (the first {@link MAX_MEMBERS}) and how many more there are */
  members: Map<string, { keys: readonly string[]; more: number }>
}
const indexes = new WeakMap<object, KeyIndex>()
function keyIndex(watch: Readonly<Record<string, TagValue>>): KeyIndex {
  const set = keySetOf(watch)
  let ix = indexes.get(set)
  if (!ix) {
    const upper = new Map<string, string>()
    for (const k of watchKeysOf(watch)) upper.set(k.toUpperCase(), k)
    ix = { upper, owners: new Map(), members: new Map() }
    indexes.set(set, ix)
  }
  return ix
}
function upperIndex(watch: Readonly<Record<string, TagValue>>): Map<string, string> {
  return keyIndex(watch).upper
}

/** Look one watched name up in the running image. */
export function resolveWatch(name: string, watch: Readonly<Record<string, TagValue>>): WatchRow {
  // (an element of an array too long to be among the keys is asked of the table: core/watchTable.ts)
  const key = upperIndex(watch).get(name.toUpperCase()) ?? watchElementKey(watch, name)
  if (key !== null) return { name, key, value: watch[key], members: [], more: 0 }
  // `Status.3`: one bit of a word, which the image holds as the word (the toggle and write paths read it the same way,
  // controller/program.ts)
  const bit = /^(.+)\.([0-9]+)$/.exec(name)
  const wordKey = bit ? upperIndex(watch).get(bit[1]!.toUpperCase()) : undefined
  const word = wordKey !== undefined ? watch[wordKey] : undefined
  if (bit && typeof word === 'number' && Number(bit[2]) < 32) {
    return { name, key: `${wordKey}.${bit[2]}`, value: ((word >>> Number(bit[2])) & 1) === 1, members: [], more: 0 }
  }
  const prefix = name.toUpperCase()
  // a variable of a program instance, written without the instance (`Count` for `Line.Count`), as the code beside it
  // spells it: taken when exactly one instance holds the name
  const suffix = `.${prefix}`
  const ix = keyIndex(watch)
  let owner = ix.owners.get(prefix)
  if (owner === undefined) {
    owner = null
    let owners = 0
    for (const [u, k] of ix.upper) {
      if (!u.endsWith(suffix)) continue
      owner = k
      if (++owners > 1) {
        owner = null
        break
      }
    }
    ix.owners.set(prefix, owner)
  }
  if (owner !== null) return { name, key: owner, value: watch[owner], members: [], more: 0 }
  let under = ix.members.get(prefix)
  if (!under) {
    const keys: string[] = []
    let more = 0
    for (const [u, k] of ix.upper) {
      if (u.length <= prefix.length || !u.startsWith(prefix)) continue
      const next = u[prefix.length]
      if (next !== '.' && next !== '[') continue
      if (keys.length < MAX_MEMBERS) keys.push(k)
      else more++
    }
    // an array too long to be among the keys (or a structure in one): its first elements, asked of the table
    under = (keys.length === 0 ? watchElementsUnder(watch, name, MAX_MEMBERS) : null) ?? { keys, more }
    ix.members.set(prefix, under)
  }
  return { name, key: null, value: undefined, members: under.keys.map((key) => ({ key, value: watch[key]! })), more: under.more }
}

/**
 * The variable a right-click at `col` of `line` is on: the name there with the names before it that it is a member of
 * (`Line.Fill` for a click on `Fill` in `Line.Fill.ET`), or null on a keyword, a literal, a comment's punctuation or
 * blank space. An index is an expression, so a click in `Bins[i]` on `Bins` gives `Bins`.
 */
export function watchNameAt(line: string, col: number): string | null {
  const word = /[A-Za-z0-9_]/
  let end = col
  while (end < line.length && word.test(line[end]!)) end++
  let start = col
  while (start > 0 && word.test(line[start - 1]!)) start--
  if (start === end) return null
  // the names it is a member of: back over `.name` while a dot joins them
  while (start > 1 && line[start - 1] === '.' && word.test(line[start - 2]!)) {
    let s = start - 1
    while (s > 0 && word.test(line[s - 1]!)) s--
    start = s
  }
  const name = line.slice(start, end)
  const first = name.split('.')[0]!
  // a number, or a typed literal (`T#5s`, `INT#16#FF`) on either side of its #
  if (!/^[A-Za-z_]/.test(first) || line[start - 1] === '#' || line[end] === '#') return null
  if (KEYWORDS.has(first.toUpperCase())) return null
  return name
}

/** A selection that is one place (`Line.Fill.ET`, `Bins[2]`, `Status.3`) as a name to watch; null for anything else. */
export function watchNameOfSelection(text: string): string | null {
  if (!/^\s*[A-Za-z_][A-Za-z0-9_]*(\s*(\.\s*[A-Za-z0-9_]+|\[[^\]]*\]))*\s*$/.test(text)) return null
  const name = text.replace(/\s+/g, '')
  return KEYWORDS.has(name.split(/[.[]/)[0]!.toUpperCase()) ? null : name
}

/** Names typed into the add box: one or several, split on commas and spaces. */
export function parseWatchNames(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** `list` with `names` appended, skipping any it already has (in any case). */
export function addWatchNames(list: readonly string[], names: readonly string[]): string[] {
  const seen = new Set(list.map((n) => n.toUpperCase()))
  const out = [...list]
  for (const n of names) {
    if (seen.has(n.toUpperCase())) continue
    seen.add(n.toUpperCase())
    out.push(n)
  }
  return out
}

// every list read or written this session, by project: what the surfaces share
const memory = new Map<string, string[]>()
const listeners = new Set<(project: string) => void>()

/** Hear of every change to any project's list (the pane re-reads its own). Returns the unsubscribe. */
export function onWatchListChange(fn: (project: string) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Add names to `project`'s list (Add to Watch from the text or the rungs), telling every open pane. */
export function addToWatchList(project: string, names: readonly string[], byName?: string): void {
  saveWatchList(project, addWatchNames(readWatchList(project, byName), names))
}

const WATCH_KEY = 'oip-web/plc-watch'
/** Projects whose lists are kept; the least recently changed goes first. */
const KEPT_PROJECTS = 30

type Stored = Record<string, string[]>

function readAll(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) ?? 'null') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Stored) : {}
  } catch {
    return {}
  }
}

/**
 * The key a project's list is kept under: its document id, so two projects of one name keep apart and a rename keeps
 * the list. In a room, or with no document (a browser that keeps one project), the project's name.
 */
export function watchListKey(docId: string | null, name: string, inRoom: boolean): string {
  return docId !== null && !inRoom ? `doc:${docId}` : name
}

/**
 * This tab's key. A shared project of this browser's own is still its project (project/sharedProject.ts), so it keeps
 * its document's list: sharing must not empty the owner's Watch. Someone else's shared project goes by its name.
 */
export function tabWatchListKey(projectName: string, collab: boolean): string {
  const docId = currentDocumentId()
  const own = collab ? ownSharedProject() : null
  const ours = own !== null && !own.demo && own.docId === docId
  return watchListKey(docId, projectName, collab && !ours)
}

/**
 * The list remembered under `project` (a {@link watchListKey}). Empty when there is none, or no storage. `byName`: the
 * project's name, whose list (kept by name before lists were kept by document) it takes over when it has none yet.
 */
export function readWatchList(project: string, byName?: string): string[] {
  const held = memory.get(project)
  if (held) return [...held]
  const all = readAll()
  const old = byName !== undefined && byName !== project ? byName : undefined
  const v = all[project] ?? (old !== undefined ? (memory.get(old) ?? all[old]) : undefined)
  const list = Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []
  memory.set(project, list)
  return [...list]
}

/** Set `project`'s list, telling every open pane. Kept for the session, and in storage when there is one. */
export function saveWatchList(project: string, names: readonly string[]): void {
  memory.set(project, [...names])
  for (const fn of listeners) fn(project)
  try {
    const all = readAll()
    delete all[project] // re-inserted last, so it is the most recent
    if (names.length > 0) all[project] = [...names]
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - KEPT_PROJECTS))) delete all[k]
    localStorage.setItem(WATCH_KEY, JSON.stringify(all))
  } catch {
    // not remembered: the next visit opens on an empty list
  }
}
