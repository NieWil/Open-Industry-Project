// Make a copy of a live room: the room's document as it is now becomes a new project of your own, in this
// browser's library, and the tab opens it. The room is not touched, and its link still opens it (Back does too).
//
// It is the export-leave-import round trip done as one step, because two steps of that trip fail in a room.
// Importing is refused inside a room. A room whose part code this browser has not allowed exports stand-ins
// for those parts (sceneFile.noticeHeldCodeInExport), and says so only after the file is written. Here the held
// code refuses the copy up front, so a copy is never a project whose parts silently do nothing.
//
// Not a fork that stays linked: no "pull the room's changes", no merge. The copy is an ordinary
// document from the moment it exists.
//
// The sequence is the shelf's New (documentStore.createDocument), with one difference: the working copy in
// localStorage is not the room (a room never autosaves there). It is the solo project this browser had before
// joining. So that is what gets filed as the outgoing document, read fresh from storage, before the copy takes
// its place.

import { getRoomCodeGate } from '../../collab/session'
import { serializeProject } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { createDocument, supportsDocumentLibrary } from './documentStore'
import { loadStoredProject } from './projectFile'
import type { EditorStore } from '../store/store'

/** The URL a copy boots at: this one without the room, so the load is a solo one. */
export function soloUrl(href: string): string {
  const url = new URL(href)
  for (const p of ['room', 'view', 'scene', 'server']) url.searchParams.delete(p)
  return url.pathname + url.search + url.hash
}

/** The room's document as a detached project named for a copy. A deep copy: snapshotProject hands back the store's own. */
export function roomCopyProject(store: EditorStore): ProjectJSON {
  const copy = JSON.parse(serializeProject(store.snapshotProject(), { pretty: false })) as ProjectJSON
  copy.name = `Copy of ${copy.name}`
  return copy
}

/**
 * Copy the open room into a new project and boot into it. Returns why it could not, having changed nothing, or
 * null when the page is on its way to the copy.
 */
/** Why the room's document cannot be taken out as a project now, or null when it can. */
function takeOutRefusal(store: EditorStore): string | null {
  const state = store.getState()
  if (!state.collab) return 'Only a shared project is copied this way.'
  if (state.running) return 'Stop the simulation first: a copy is of the project, not of a run.'
  const held = getRoomCodeGate()?.getHeld() ?? []
  if (held.length > 0) {
    return held.length === 1
      ? `“${held[0]!.name}” isn't running its own code here, so a copy would hold it without that code. Allow its part code, then make the copy.`
      : `${held.length} part types in this shared project aren't running their own code here, so a copy would hold them without it. Allow their part code, then make the copy.`
  }
  return null
}

export async function copyRoomToProjects(store: EditorStore): Promise<string | null> {
  const refused = takeOutRefusal(store)
  if (refused !== null) return refused
  if (!supportsDocumentLibrary()) return 'This browser cannot store projects. Export Project (.oip) makes a copy you can import after leaving the room.'
  const copy = roomCopyProject(store)
  // the solo project this browser had before it joined: filed first, so the copy replacing it loses nothing
  const outgoing = loadStoredProject()?.project ?? null
  return createDocument(copy, outgoing, soloUrl(location.href))
}
