// New project: one door for the projects list's "+ New project", the File > New Project command (Ctrl+N) and
// the tutorial's own project, so they cannot create different things. A new project is a blank document filed beside
// the others, never the current one emptied: the project being left is saved on the way out and stays in
// the list. On the desktop the new project gets a folder of its own from its first moment.
//
// Either way the editor reloads into it (documentStore.createDocument / desktopProjectBridge
// createFolderDocument), so a successful call does not return to its caller in any useful sense; the
// string it resolves to is the reason nothing happened.

import { blankScene } from '../../core/scene/scene'
import { createFolderDocument, openFolderDocument, openLibraryStandIn } from '../desktop/desktopProjectBridge'
import { getOipProjectApi } from '../desktop/desktopProjectApi'
import { createDocument, openDocument, supportsDocumentLibrary } from './documentStore'
import { assembleProject } from './projectFile'
import type { EditorStore } from '../store/store'
import type { ProjectJSON } from '../../core/project/project'

export const UNTITLED_PROJECT = 'Untitled Project'

export function createNewProject(store: EditorStore, name: string): Promise<string | null> {
  return createProjectFrom(store, assembleProject(blankScene(), '', [], name.trim() || UNTITLED_PROJECT))
}

/** File `project` as a new project beside the open one and reload into it (a scene file opened as a project). */
export function createProjectFrom(store: EditorStore, project: ProjectJSON): Promise<string | null> {
  return getOipProjectApi() ? createFolderDocument(store, project) : createDocument(project, store.outgoingProject())
}

/**
 * Can a project be created here? The projects list's own rule (commands.ts file.newProject): not in a room or on
 * a view link, and only where there is a list to add it to - the desktop's folders, or a browser library. With
 * no library, "create" would replace the one project the browser keeps.
 */
export function canCreateProject(store: EditorStore): boolean {
  const s = store.getState()
  // a shared project is left for the new one, as any open project is
  return !s.readOnly && (getOipProjectApi() !== null || supportsDocumentLibrary())
}

/**
 * Open the project filed as `docId`, the way the projects list does: on the desktop from its folder (the store
 * of record), falling back to the library's copy when the folder cannot be read; in the browser from the
 * library. Reloads on success; resolves to the reason nothing happened (a project since deleted, say).
 */
export async function openProjectById(store: EditorStore, docId: string): Promise<string | null> {
  const api = getOipProjectApi()
  if (api !== null) {
    const row = (await api.folders()).find((r) => r.docId === docId)
    if (row?.path) return (await openFolderDocument(store, docId, row.path)) === null ? null : openLibraryStandIn(store, docId)
  }
  return openDocument(docId, store.outgoingProject())
}
