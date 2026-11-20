// A project of the user's own, shared (docs/live-share.md "Sharing a project"). Sharing is a property of the project,
// not a place the user goes: the project keeps its name and its place in the Projects list, and while it is shared its
// room is where everyone edits it. This browser, which owns the project, takes the room's document back into the
// project as it changes (startWriteBack), so the project never falls behind the room and there is no copy to return to.
// Opening the project again rejoins its room (main.tsx). Stop sharing makes it the user's alone again.
//
// Which projects are shared, and with which room, is this browser's record. Its owner token, registered with the room
// when it is shared (server/roomOwners.mjs), is what lets this browser close the room, so that Stop sharing makes the
// links stop working: the edit secret cannot, since every editor holds it. The token never leaves this browser except to
// the room's server.

import { serializeProject } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { currentDocumentId, writeDocument } from './documentStore'
import { flushWorkingCopy, loadStoredProject, saveStoredProject } from './projectFile'
import { soloUrl } from './roomCopy'
import type { EditorStore } from '../store/store'
import { documentSceneOf } from '../store/storeDocument'

export interface SharedProject {
  /** the project's record in the library; null in a browser without one (the working copy is then the project) */
  docId: string | null
  /** the room's edit secret */
  room: string
  /** the project's name, which the room's document does not carry */
  project: string
  /** the collab server the room is on, when it is not the build's */
  server: string | null
  /** this browser's proof of ownership to the room's server (server/roomOwners.mjs); minted when it is shared */
  ownerToken?: string
  /**
   * The untouched demo, shared: owned, so its sharer can stop sharing it and nobody else can claim it, but not a project
   * of the user's. It stays the current demo until someone edits it (collab/demoRoom.ts), so nothing is written back.
   */
  demo?: true
}

/** a new owner token for a project being shared */
export const mintOwnerToken = (): string => `o-${crypto.randomUUID()}`

const SHARED_KEY = 'oip-web/shared-projects'

function readAll(): SharedProject[] {
  try {
    const v = JSON.parse(localStorage.getItem(SHARED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((e): e is SharedProject => !!e && typeof e.room === 'string' && typeof e.project === 'string') : []
  } catch {
    return []
  }
}

function writeAll(all: SharedProject[]): void {
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify(all))
  } catch {
    /* no storage: the project opens solo next time, and its room is still there by its link */
  }
}

/** this browser shared one of its projects into `entry.room` */
export function noteSharedProject(entry: SharedProject): void {
  writeAll([...readAll().filter((e) => e.room !== entry.room && (entry.docId === null || e.docId !== entry.docId)), entry])
}

/**
 * Rename a shared project of this browser's: its record, which names what the write-back saves (so the old name does
 * not come back), and the open project's name when it is this one. True when it is a shared project of this browser's.
 */
export function renameSharedProject(store: EditorStore, docId: string | null, name: string): boolean {
  const trimmed = name.trim()
  const all = readAll()
  const entry = docId === null ? null : all.find((e) => e.docId === docId)
  if (!entry || trimmed === '') return false
  writeAll(all.map((e) => (e === entry ? { ...e, project: trimmed } : e)))
  if (store.getState().collab && ownSharedProject()?.room === entry.room) {
    store.setState({ projectName: trimmed })
    writeBack(store, { ...entry, project: trimmed })
    nameLine?.(trimmed) // everyone in the room sees the new name
  }
  return true
}

let nameLine: ((name: string) => void) | null = null

/** main.tsx, for the owner in its room: how a name reaches the room's document (collab/schema.ts PROJECT_NAME_META) */
export function setRoomNameWriter(write: ((name: string) => void) | null): void {
  nameLine = write
}

export function forgetSharedProject(room: string): void {
  writeAll(readAll().filter((e) => e.room !== room))
}

/** the room a project of this browser's is shared in, or null */
export function sharedProjectOf(docId: string | null): SharedProject | null {
  return docId === null ? null : (readAll().find((e) => e.docId === docId) ?? null)
}

/** the demo, when this browser shared it and has not stopped sharing it */
export function sharedDemo(): SharedProject | null {
  return readAll().find((e) => e.demo) ?? null
}

/** The project of this browser's own that the room in `href` holds, or null: another's room, or no room. */
export function ownSharedProject(href: string = typeof location === 'undefined' ? '' : location.href): SharedProject | null {
  try {
    const room = new URL(href).searchParams.get('room')
    return room === null ? null : (readAll().find((e) => e.room === room) ?? null)
  } catch {
    return null
  }
}

/** the room's document as the project it is, under the project's own name (a deep copy: snapshotProject hands back the store's own) */
function projectNow(store: EditorStore, shared: SharedProject): ProjectJSON {
  const p = JSON.parse(serializeProject(store.snapshotProject(), { pretty: false })) as ProjectJSON
  p.name = shared.project
  // A room carries the scene, the program and the parts, not everything a project holds (its tests, for one). A tab
  // that opened the project straight into its room never loaded the rest, so it is kept from the project as last saved:
  // writing the room back must never take away what the room does not carry.
  const saved = shared.docId === null || currentDocumentId() === shared.docId ? loadStoredProject()?.project : undefined
  if (saved) for (const [k, v] of Object.entries(saved)) if (!(k in p)) (p as unknown as Record<string, unknown>)[k] = v
  return p
}

/** A shared project as it is now, to save or render (the desktop folder, projectFolderSync.ts): its room, plus what the
 *  room does not carry, under the project's own name. */
export function sharedProjectNow(store: EditorStore, shared: SharedProject): ProjectJSON {
  return projectNow(store, shared)
}

const writeListeners = new Set<() => void>()

/** after each write-back: the desktop folder of a shared project follows it (projectFolderSync.ts) */
export function onSharedWriteBack(cb: () => void): () => void {
  writeListeners.add(cb)
  return () => writeListeners.delete(cb)
}

/** Write the room's document into the project now: its library record, and the working copy while it is the open one. */
function writeBack(store: EditorStore, shared: SharedProject): void {
  if (!store.getState().collab || shared.demo) return
  const p = projectNow(store, shared)
  if (shared.docId !== null) void writeDocument(shared.docId, p)
  if (shared.docId === null || currentDocumentId() === shared.docId) saveStoredProject(p)
  for (const cb of writeListeners) cb()
}

/**
 * Keep the project in step with its room while this tab is in it: a write a moment after each change to the document
 * (the scene, the program, the parts), and one before the page goes. Returns the immediate write.
 */
export function startWriteBack(store: EditorStore, shared: SharedProject): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const now = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    // the record as it is now: a rename while shared changes the name this saves under (renameSharedProject)
    writeBack(store, readAll().find((e) => e.room === shared.room) ?? shared)
  }
  // A room carries no tests, so the owner's tab takes the project's own: they run, change and are written back here as
  // anywhere (store.saveProjectTest)
  const saved = shared.docId === null || currentDocumentId() === shared.docId ? loadStoredProject()?.project : undefined
  if (store.projectTests().length === 0) for (const spec of saved?.tests ?? []) store.saveProjectTest(spec)
  const doc = () => {
    const s = store.getState()
    return [documentSceneOf(s), s.stProgram, s.userPackages, store.projectTests()] as const
  }
  let last = doc()
  store.subscribe(() => {
    const next = doc()
    if (next.every((v, i) => v === last[i])) return
    last = next
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(now, 1000)
  })
  if (typeof addEventListener === 'function') addEventListener('pagehide', now)
  now() // the room may hold edits made while this browser was away
  return now
}

// The room's server, as the owner reaches it (main.tsx connects it once the room has synced): send a message, and hear
// the room's own messages back.
let ownerLine: { send(payload: string): void; listen(cb: (payload: string) => void): () => void } | null = null
let stopping = false

/** this browser owns the room it is in, so the project's tests are kept here (store.saveProjectTest); not the demo's */
export function keepsSharedTests(): boolean {
  const own = ownSharedProject()
  return own !== null && !own.demo
}

/** true while this tab is closing its own room, so the room's "closed" message is not news to it */
export const isStoppingSharing = (): boolean => stopping

/**
 * The owner's tab is in its room: register the owner token with the server, minting one for a project shared before
 * tokens existed. Harmless when already registered; a room another browser claimed first answers "taken".
 */
export function claimRoom(shared: SharedProject, line: NonNullable<typeof ownerLine>, client: number): void {
  ownerLine = line
  let token = shared.ownerToken
  if (!token) {
    token = mintOwnerToken()
    noteSharedProject({ ...shared, ownerToken: token })
  }
  // the presence id lets the server tell everyone who the owner is (the spotlight, a view link's default run)
  line.send(`room1|claim|${token}|${client}`)
}

/** Ask everyone in the owner's room to watch its run, or stop (server/roomOwners.mjs spotlight). */
export function setSpotlight(on: boolean): void {
  const token = ownSharedProject()?.ownerToken
  if (ownerLine && token) ownerLine.send(`room1|spotlight|${token}|${on ? 1 : 0}`)
}

/** Ask the room's server to close the room. True once it has; false when it refused, or did not answer in time. */
function closeRoom(shared: SharedProject): Promise<boolean> {
  const line = ownerLine
  if (!line || !shared.ownerToken) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), 5000)
    const stop = line.listen((payload) => {
      if (payload === 'room1|close|ok') done(true)
      else if (payload === 'room1|close|refused') done(false)
    })
    function done(ok: boolean): void {
      clearTimeout(timer)
      stop()
      resolve(ok)
    }
    line.send(`room1|close|${shared.ownerToken}`)
  })
}

/**
 * Stop sharing the project this tab is in: the room is closed, so the links handed out stop working; the project,
 * already up to date, becomes the user's alone again; and the tab opens it solo. Where the server cannot close the room
 * (one from before owner tokens, or an older server), the user is asked whether to stop anyway, since the links would
 * then still open it. Returns why it could not, having changed nothing, or null when the page is on its way.
 */
export async function stopSharing(store: EditorStore, shared: SharedProject): Promise<string | null> {
  if (store.getState().running) return 'Stop the simulation first.'
  writeBack(store, shared)
  stopping = true
  const closed = await closeRoom(shared)
  if (!closed && !confirm("The server could not stop sharing this project, so the links you gave out would still open it as it is now. Stop sharing anyway?")) {
    stopping = false
    return null
  }
  forgetSharedProject(shared.room)
  // the write-back above lands before the page goes
  await flushWorkingCopy()
  // the demo goes back to being the demo on its own; a project, to being the user's alone
  const solo = new URL(soloUrl(location.href), location.href)
  if (shared.demo) solo.searchParams.set('scene', 'demo')
  location.assign(solo.pathname + solo.search + solo.hash)
  return null
}
