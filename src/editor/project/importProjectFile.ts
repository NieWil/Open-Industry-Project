// Import a project file the person chose: a `.oip` (zipped folder or the older one-file JSON) or a scene `.json`, both
// opening as a project of their own. One function for every way a file arrives, so they cannot drift apart: the
// Import Project picker (App.tsx), and a file double-clicked or opened with the desktop app (desktopFileOpen.ts).

import { fileOutgoingDocument, supportsDocumentLibrary } from './documentStore'
import { importProjectData } from './projectFile'
import { importSceneText, isSceneFileText } from './sceneFile'
import type { EditorController } from '../controller'
import type { EditorStore } from '../store/store'

/** Import `bytes` (a file named `fileName`) as a project; asks before replacing anything and says what went wrong. */
export async function importProjectFile(store: EditorStore, controller: EditorController | null, bytes: Uint8Array, fileName: string): Promise<void> {
  // A scene file opens as a new project named after the file, asking nothing: the project that was open is kept in
  // the projects list (sceneFile.importSceneText says so when it cannot be).
  // An .oip is a zip ("PK"): never a scene file, and not worth decoding as text to find that out.
  const text = bytes[0] === 0x50 && bytes[1] === 0x4b ? '' : new TextDecoder().decode(bytes)
  if (text !== '' && isSceneFileText(text)) {
    const error = await importSceneText(store, text, fileName, controller)
    if (error) alert(error)
    return
  }
  // With a library the import is an addition: it opens as its own document and the project you are in keeps its row
  // (projectFile.forgetCurrentDocument). Without one (no IndexedDB, so no library) the import replaces the current
  // project, so the prompt has to say which of the two will happen.
  const ask = supportsDocumentLibrary()
    ? `Import “${fileName}”? It opens as a new project - the one you have open now is kept under Projects.`
    : `Import “${fileName}”? It replaces the current project. Export first to keep it.`
  if (!confirm(ask)) return
  // zipped-folder or legacy JSON .oip, sniffed by content; success reloads into the import. The project being left is
  // filed first, once the file has validated, so "kept under Projects" is a fact.
  const error = await importProjectData(store, bytes, {
    beforeAdopt: () => fileOutgoingDocument(store.outgoingProject()),
  })
  if (error) alert(error)
}
