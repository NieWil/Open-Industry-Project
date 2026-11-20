// The demo fork's host: what happens to the user's project when an edit makes the demo theirs.
//
// The demo becomes a project of its own (store.stashDemoSession), so the project it was opened from has to be
// put away untouched: filed in the library under its own id, its folder let go of, and the screen given a new
// document id. The store asks for that through setDemoForkHost and does the rest itself (the new project's one
// scene, the notice); this module is the part that knows about the library and folders, which the store does
// not import.
//
// No reload: the scene on screen is already the new project's, so this is not the in-place project swap the
// reload-based switches exist to avoid (projectFile.adoptImportedProject) - nothing is loaded, and the only
// library change is dropping the outgoing project's custom parts, which the demo does not use.

import { uniqueName } from '../../core/parts/partDisplayName'
import { DEMO_SCENE_NAME } from './demoScenes'
import { forkCurrentDocument, listDocuments } from '../project/documentStore'
import { releaseFolder, restoreFolderSync, syncedFolderPath } from '../project/projectFolderSync'
import type { SceneSwapGuard } from '../project/projectFolderLink'
import type { EditorStore } from '../store/store'

export function installDemoForkHost(store: EditorStore, controller: SceneSwapGuard): () => void {
  // The library's project names, so a second fork is "Palletizing demo 2" rather than a twin row in the projects
  // list. The fork runs inside an edit and cannot wait for IndexedDB, so the names are read ahead: whenever a
  // preview opens, which is always well before anyone edits it.
  let names: ReadonlySet<string> = new Set()
  let previewing = false
  const readNames = (): void =>
    void listDocuments()
      .then((docs) => {
        names = new Set(docs.map((d) => d.name))
      })
      .catch((e: unknown) => console.warn('[oip] listing projects failed', e))
  const stopWatching = store.subscribe(() => {
    const now = store.getState().demoSession
    if (now && !previewing) readNames()
    previewing = now
  })
  if (store.getState().demoSession) readNames()

  store.setDemoForkHost((outgoing) => {
    // no library to file the user's project into: decline, and the demo forks into a scene of theirs
    const forked = forkCurrentDocument(outgoing)
    if (forked === null) return null
    // The folder being followed is the outgoing project's. Stop at once, before the persist this fork runs in
    // can write the demo into it; theirs was written when the demo opened (the bank), and nothing of theirs has
    // changed since. A paused browser link is theirs too.
    if (syncedFolderPath() !== null) releaseFolder(store)
    store.setFolderPaused(null)
    // The new project is a project like any other: on the desktop it gets a folder of its own on its next real
    // edit, unasked (restoreFolderSync arms that for the document now open). A no-op in the browser.
    void restoreFolderSync(store, controller)
    const name = uniqueName(new Set([...names, outgoing.name]), DEMO_SCENE_NAME)
    // The read-ahead may not finish before an edit made the moment the demo's page is up (Open Demo reloads into
    // it), so the name is checked again once the library answers, and renumbered if it turned out to be taken.
    void listDocuments()
      .then((docs) => {
        const taken = new Set([...docs.filter((d) => d.id !== forked).map((d) => d.name), outgoing.name])
        if (store.getState().projectName === name && taken.has(name)) store.renameDemoFork(uniqueName(taken, DEMO_SCENE_NAME))
      })
      .catch(() => {
        // no library to read (storage blocked mid-session): the name stands, as it would have without this check
      })
    return name
  })
  return () => {
    stopWatching()
    store.setDemoForkHost(null)
  }
}
