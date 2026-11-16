// The desktop's project-as-a-folder flows: File > Open Project Folder, Save Project to Folder, Open
// Recent, a folder named on the command line, and the shelf's folder rows. On the desktop a project
// lives in its folder (docs/projects.md). Once opened or saved, the app keeps the two in sync both ways
// (projectFolderSync.ts). The shell only moves raw {path, contents} files (apps/desktop/preload.cjs,
// typed in desktopProjectApi.ts); the format lives in core/project/projectFolder.ts, shared with the browser and
// the CLIs. On the web getOipProjectApi() returns null and none of this is reachable.

import { folderFilesToProject, projectToFolderFiles } from '../../core/project/projectFolder'
import type { ProjectJSON } from '../../core/project/project'
import { bakePart } from '../parts/bakePart'
import { adoptImportedProject, dropV1Snapshots } from '../project/projectFile'
import { storeLocalAssets } from '../project/localAssets'
import {
  clearEntryParams,
  currentDocumentId,
  documentsOpenInTabs,
  fileOutgoingDocument,
  mintDocumentId,
  onCurrentDocumentChange,
  openDocument,
  supportsDocumentLibrary,
  writeDocument,
} from '../project/documentStore'
import { folderDisplayName, getOipProjectApi } from './desktopProjectApi'
import type { FolderRead } from './desktopProjectApi'
import { saveIntoFolder, saveToFolderNow, syncFolderNow, syncedFolderPath } from '../project/projectFolderSync'
import type { SceneSwapGuard } from '../project/projectFolderLink'
import type { EditorStore } from '../store/store'

export { getOipProjectApi } from './desktopProjectApi'
export type { OipProjectApi } from './desktopProjectApi'

/** File > Open Project Folder…: pick a folder and open the project in it. */
export async function openProjectFromFolder(store: EditorStore): Promise<void> {
  const api = getOipProjectApi()
  // a shared project is left for the one opened, as any open project is (adoptFolderProject clears its room)
  if (!api) return
  const picked = await api.pickOpenFolder()
  if (picked) await openFolderRead(store, picked)
}

/** Open a folder the app already knows the path of: File > Open Recent, a second launch naming one. */
export async function openProjectFolderPath(store: EditorStore, root: string): Promise<void> {
  const api = getOipProjectApi()
  if (!api) return
  const read = await api.readAt(root)
  if (read) await openFolderRead(store, read)
}

/**
 * Open a folder's project as the document that folder is. A folder the app has opened before is the
 * same document again (the shell remembers it by path), so opening it twice never makes two projects;
 * a new one gets a fresh document. Either way it goes through the one boot path (write, then reload),
 * and the folder is recorded against the document before the reload so the next boot keeps it in sync.
 */
async function openFolderRead(store: EditorStore, read: FolderRead): Promise<void> {
  const ready = await readyToOpen(store, read)
  if ('error' in ready) {
    alert(ready.error)
    return
  }
  if (ready.already) return
  const { result } = ready
  if (read.docId === null) {
    // Same wording split as the web import: with a library this opens the folder beside the project on
    // screen; without one it is a replacement, and the question has to say so.
    const ask = supportsDocumentLibrary()
      ? `Open "${result.project.name}"? The project you have open now is kept under Projects.`
      : `Open "${result.project.name}"? This replaces the current project (its autosave is overwritten).`
    if (!confirm(ask)) return
  }
  const error = await adoptFolderProject(store, read.root, read.docId, result)
  if (error !== null) alert(`Couldn't open "${result.project.name}":\n${error}`)
}

/**
 * An agent's open_project (apps/desktop/agentProjects.cjs). Main has already decided the folder may open and
 * granted it, so nothing here asks the person, and a refusal comes back as text rather than an alert. Resolves to
 * 'already' (it is the project on screen) or 'reloading' (the page is about to reload into it).
 */
export async function openFolderForAgent(store: EditorStore, root: string): Promise<{ error: string } | 'already' | 'reloading'> {
  const api = getOipProjectApi()
  if (!api) return { error: 'Opening a project folder needs the desktop app.' }
  const read = await api.readAt(root)
  if (!read) return { error: `Couldn't read ${root}: no answer from the app shell` }
  const ready = await readyToOpen(store, read)
  if ('error' in ready) return ready
  if (ready.already) return 'already'
  // without a library the open project's only copy would be overwritten, which the person has to agree to
  if (read.docId === null && !supportsDocumentLibrary()) return { error: 'opening it would replace the open project, which has no other copy; the person opens it from File > Open Project Folder' }
  const error = await adoptFolderProject(store, read.root, read.docId, ready.result)
  return error === null ? 'reloading' : { error: `Couldn't open "${ready.result.project.name}": ${error}` }
}

/** A folder read checked as a project: why it cannot open, that it is the open project already, or the project. */
async function readyToOpen(
  store: EditorStore,
  read: FolderRead,
): Promise<{ error: string } | { already: true } | { already: false; result: Extract<ReturnType<typeof folderFilesToProject>, { ok: true }> }> {
  if (read.error !== undefined) return { error: `Couldn't read the project folder:\n${read.error}` }
  const result = folderFilesToProject(read.files, { bakePart })
  if (!result.ok) return { error: `Couldn't open the project folder:\n${result.errors.join('\n')}` }
  if (read.docId !== null && read.docId === currentDocumentId() && !store.getState().demoSession) {
    // already the project on screen: the sync is following that folder, so there is nothing to open
    await syncFolderNow()
    return { already: true }
  }
  // open in another window: that window is brought forward, and this one keeps its project
  if (await openElsewhere(read)) return { already: true }
  return { already: false, result }
}

/** Bring forward the other window that has this folder's project open, if one does. */
async function openElsewhere(read: FolderRead): Promise<boolean> {
  const api = getOipProjectApi()
  if (!api?.openWindow || !api.focusFolder) return false
  if (await api.focusFolder(read.root)) return true
  if (read.docId === null || !(await documentsOpenInTabs())?.has(read.docId)) return false
  await api.openWindow(read.docId)
  return true
}

/**
 * Make a folder's project the open document and reload into it. `docId` null mints one. Returns an
 * error, having replaced nothing, or null (and the page reloads).
 */
async function adoptFolderProject(
  store: EditorStore,
  root: string,
  docId: string | null,
  result: { project: ProjectJSON; migratedFromV1?: true },
): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api) return 'Opening a project folder needs the desktop app.'
  // file the project being left before anything replaces it (documentStore.fileOutgoingDocument)
  const refused = await fileOutgoingDocument(store.outgoingProject())
  if (refused !== null) return refused
  const id = docId ?? (supportsDocumentLibrary() ? mintDocumentId() : undefined)
  // baseline null: the working copy is about to be built from this folder, so the next boot starts with
  // the two agreed rather than reading the app's rendering of every file as an edit
  if (id !== undefined) await api.remember(id, { path: root, name: result.project.name, baseline: null, signature: '', touch: true })
  clearEntryParams() // a ?scene=demo or ?room= entry URL would reload straight back into the demo or the shared project
  // its models go to the asset store first, so the working copy can name them by hash (localAssets.ts)
  await storeLocalAssets(result.project)
  // adopt = write-then-reload; a failed write returns instead of reloading, so say why
  const adopted = await adoptImportedProject(result, id !== undefined ? { docId: id } : undefined)
  return adopted.ok ? null : adopted.message
}

/**
 * Open a project from the shelf by its folder, not by the copy in the app's library: on the desktop the
 * folder is the store of record, and the library copy can be a few seconds behind it.
 */
export async function openFolderDocument(store: EditorStore, docId: string, root: string): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api) return 'Opening a project folder needs the desktop app.'
  const read = await api.readAt(root)
  if (!read || read.error !== undefined) return `Couldn't read ${root}:\n${read?.error ?? 'no answer from the app shell'}`
  const result = folderFilesToProject(read.files, { bakePart })
  if (!result.ok) return `Couldn't open ${root}:\n${result.errors.join('\n')}`
  return adoptFolderProject(store, root, docId, result)
}

/**
 * Open a folder project's stored copy, because its folder could not be read (moved, deleted, halfway
 * through an agent's write). A stand-in, so the sync is told to let the folder win once it is readable
 * rather than write this possibly older copy over it (projectFolderSync `trustDisk`).
 */
export async function openLibraryStandIn(store: EditorStore, docId: string): Promise<string | null> {
  await getOipProjectApi()?.remember(docId, { trustDisk: true, baseline: null })
  return openDocument(docId, store.outgoingProject())
}

/**
 * Open one of the library's projects in this window, as the projects list and the project menu's recent rows do.
 * `root` is its folder on the desktop, null for a project stored in the app only. A folder that cannot be read
 * (moved, deleted, mid-edit) must not strand the project: the library's last copy opens as a stand-in, and the
 * sync's banner says what is wrong with the folder. Returns an error, or null (and the page reloads).
 */
export async function openStoredDocument(store: EditorStore, docId: string, root: string | null): Promise<string | null> {
  if (root === null) return openDocument(docId, store.outgoingProject())
  return (await openFolderDocument(store, docId, root)) === null ? null : openLibraryStandIn(store, docId)
}

/**
 * The shelf's New project, on the desktop: a folder of its own under the default projects folder, made
 * and written before the switch, so the new project is on disk from its first moment.
 */
export async function createFolderDocument(store: EditorStore, blank: ProjectJSON): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api) return 'Making a project folder needs the desktop app.'
  const made = await api.createFolder(blank.name)
  if ('error' in made) return made.error
  const written = await api.write(
    made.root,
    projectToFolderFiles(blank).map((f) => ({ path: f.path, contents: f.contents, expect: null })),
  )
  if (written.error !== null) return written.error
  return adoptFolderProject(store, made.root, null, { project: blank })
}

/**
 * File > Save Project to Folder…: write the whole project into a picked folder, and keep it there from
 * now on. The same document, so nothing reloads; if it lived in another folder before, it lives in this
 * one now (the old folder is left as it was).
 */
export async function saveProjectToFolder(store: EditorStore, controller: SceneSwapGuard = null): Promise<void> {
  const api = getOipProjectApi()
  if (!api) return
  const picked = await api.pickSaveFolder()
  if (!picked) return
  if (picked.root === syncedFolderPath() || (picked.docId !== null && picked.docId === currentDocumentId())) {
    await syncFolderNow() // it is this project's own folder: saving means "write what is pending now"
    return
  }
  if (picked.hasProject) {
    const ok = confirm(
      `"${folderDisplayName(picked.root)}" already holds a project. Replace it with "${store.getState().projectName}"?`,
    )
    if (!ok) return
  }
  const error = await saveIntoFolder(store, controller, picked.root, { replace: true })
  if (error !== null) {
    alert(`Couldn't save the project folder:\n${error}`)
    return
  }
  store.showSaveNotice('Saved to folder', `This project now lives in ${picked.root}. Changes save there as you work.`)
}

/**
 * File > Save (Ctrl+S) on the desktop. The project saves itself into its folder as you work, so this
 * writes whatever is still pending and, the first time, shows a Saved notice saying where the work is. A
 * project with no folder gets one: its default folder, or a picker when the user unlinked it on purpose.
 *
 * On the built-in example it keeps a copy first (store.keepDemoCopy): the example is not the user's, and
 * "save" on something you are looking at can only mean "keep this". The fork announces itself, so the
 * Saved toast is skipped then rather than stacked on top of it.
 */
export async function saveProjectNow(store: EditorStore, controller: SceneSwapGuard = null): Promise<void> {
  const forked = store.getState().demoSession
  if (forked) store.keepDemoCopy()
  const outcome = await saveToFolderNow(store)
  if (outcome === 'needsFolder') return saveProjectToFolder(store, controller)
  const path = store.getState().folderPath
  // the desktop knows the folder's full path; a browser only its name
  const where = getOipProjectApi() !== null ? path : `the folder "${path}"`
  if (outcome === 'saved' && path !== null && !forked) showSaveNoticeOnce(store, 'Saved', `All changes are in ${where}.`)
}

const toldSaved = new WeakSet<EditorStore>()

/**
 * Save's answer, given on the first Save of the page only. The project autosaves, so the first answer says where the
 * work is, and a habitual Ctrl+S after that has nothing new to report. Keyed by store: opening another project
 * reloads the page, so this is once per opened project.
 */
export function showSaveNoticeOnce(store: EditorStore, ...notice: Parameters<EditorStore['showSaveNotice']>): void {
  if (toldSaved.has(store)) return
  toldSaved.add(store)
  store.showSaveNotice(...notice)
}

/**
 * Open a folder's project in a window of its own, leaving this window's project as it is. A folder some window
 * already works in is brought forward instead. The new window boots into the document written here
 * (libraryDb.pinTabDocument), so it never files or replaces another window's project on the way. Returns an error,
 * or null.
 */
export async function openFolderInNewWindow(root: string): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api?.openWindow || !api.focusFolder) return 'This version of the desktop app cannot open a second window.'
  if (await api.focusFolder(root)) return null
  const read = await api.readAt(root)
  if (!read || read.error !== undefined) return `Couldn't read ${root}:\n${read?.error ?? 'no answer from the app shell'}`
  if (read.docId !== null && read.docId === currentDocumentId()) return null // this window's own project
  // open in a window that is not working in the folder (a library stand-in): bring that one forward, writing nothing
  if (read.docId !== null && (await documentsOpenInTabs())?.has(read.docId)) {
    await api.openWindow(read.docId)
    return null
  }
  const result = folderFilesToProject(read.files, { bakePart })
  if (!result.ok) return `Couldn't open ${root}:\n${result.errors.join('\n')}`
  dropV1Snapshots(result)
  const id = read.docId ?? mintDocumentId()
  // as adoptFolderProject: the new window's working copy is built from the folder, so the two start agreed
  await api.remember(id, { path: root, name: result.project.name, baseline: null, signature: '', touch: true })
  await storeLocalAssets(result.project)
  if (!(await writeDocument(id, result.project))) return 'This app would not store the project, so no window was opened.'
  await api.openWindow(id)
  return null
}

/**
 * Open a project the library holds in a window of its own, or bring forward the window that has it open. A project
 * with a folder opens from the folder, the store of record. Returns an error, or null.
 */
export async function openDocumentInNewWindow(docId: string, root: string | null): Promise<string | null> {
  const api = getOipProjectApi()
  if (!api?.openWindow) return 'This version of the desktop app cannot open a second window.'
  if (root === null) {
    await api.openWindow(docId)
    return null
  }
  return openFolderInNewWindow(root)
}

/**
 * The folder-open requests that do not start in the renderer: a folder named on the command line at
 * launch (once), File > Open Recent, and a second launch while running, which opens a window of its own. Also tells
 * the shell which document this window has open. Call once at mount; returns the unsubscribe.
 */
export function connectDesktopOpenRequests(store: EditorStore): () => void {
  const api = getOipProjectApi()
  if (!api) return () => {}
  void api
    .takePendingOpen()
    .then((root) => {
      if (root) void openProjectFolderPath(store, root)
    })
    .catch((e: unknown) => console.warn('[oip] opening the folder the app was started with failed', e))
  api.showingDocument?.(currentDocumentId())
  const offs = [
    api.onOpenPath((root) => void openProjectFolderPath(store, root)),
    onCurrentDocumentChange((id) => api.showingDocument?.(id)),
    api.onOpenPathInNewWindow?.(
      (root) =>
        void openFolderInNewWindow(root)
          .then((error) => {
            if (error !== null) alert(error)
          })
          .catch((e: unknown) => alert(e instanceof Error ? e.message : String(e))),
    ),
  ]
  return () => offs.forEach((off) => off?.())
}
