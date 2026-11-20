// Splitting an older project: where the other scenes of a multi-scene project go (docs/projects.md).
//
// A project holds one scene since format 4. An older document that held several splits when it is read
// (core/project/project.ts validateProject): the scene that was active stays the project, and every other scene comes
// back as a project of its own (`splitOff`, named "<project> - <scene>", each with copies of the library parts its
// scene places and the tests that named it; the library stays whole in the kept project). Whoever read the document parks those before anything saves over
// it (projectFile.parkSplitOff: the boot, an import, a library document opened); this module files them, once, at
// the next boot:
//
//   desktop, the project lives in a folder  ask once, listing the folders it will make. Yes: each scene gets a
//                                           folder of its own beside the project's, and the project's folder is
//                                           rewritten in the format-4 layout (its scenes/ files removed - they
//                                           moved). No: the session goes read-only, nothing is written, and the
//                                           next launch asks again.
//   anywhere else                           each becomes a document in the projects list (a desktop one gets its
//                                           folder on its first edit, like any app-only project), and a notice
//                                           names them.
//   a browser with no library               they stay parked (nothing is lost), and the notice offers each as a
//                                           .oip download (file.exportSplitOff).
//
// The folder case has to finish before the folder sync starts (App.tsx waits on it): the sync's first round would
// otherwise remove the moved scenes' files from the project's folder before their own folders exist.

import { hashContents } from '../../core/hash'
import type { FolderWriteOp } from '../../core/project/folderSync'
import { projectToFolderFiles } from '../../core/project/projectFolder'
import type { ProjectJSON } from '../../core/project/project'
import { getOipProjectApi } from '../desktop/desktopProjectApi'
import { currentDocumentId, mintDocumentId, supportsDocumentLibrary, writeDocument } from './documentStore'
import { clearParkedSplitOff, readParkedSplitOff, unparkSplitOff } from './projectFile'
import type { EditorStore } from '../store/store'
import { FOLDER_OPTIONS } from './folderOptions'

const names = (projects: readonly ProjectJSON[]): string => projects.map((p) => `“${p.name}”`).join(', ')

/** The confirm text for the desktop's one question (exported for the gate that answers it). */
export function folderSplitQuestion(project: string, parent: string, projects: readonly ProjectJSON[]): string {
  return [
    `“${project}” holds ${projects.length + 1} scenes. A project now holds one, so the others become projects of their own, each in a folder beside this one:`,
    '',
    ...projects.map((p) => `  ${parent}${p.name}`),
    '',
    'Make these folders now? Cancel opens the project read-only and changes nothing; it asks again next time.',
  ].join('\n')
}

let filing: Promise<void> = Promise.resolve()

/** Start filing what the boot parked (main.tsx); {@link splitFiling} is the wait for it. */
export function startSplitFiling(store: EditorStore): void {
  filing = fileSplitOff(store)
}

/** Resolves once the boot's filing is done - what the desktop folder sync waits on before its first round. */
export function splitFiling(): Promise<void> {
  return filing
}

/**
 * File the parked split-off projects (see the module header). Resolves once the folders are made, or the library
 * written, or the user said no. Never throws: a failure leaves them parked, and says so.
 */
export async function fileSplitOff(store: EditorStore): Promise<void> {
  const parked = readParkedSplitOff()
  if (parked.length === 0) return
  try {
    const api = getOipProjectApi()
    const docId = currentDocumentId()
    const row = api !== null && docId !== null ? await api.recall(docId) : null
    if (api !== null && docId !== null && row?.path) {
      const root = row.path
      const parent = root.replace(/[\\/][^\\/]+$/, '') + (root.includes('\\') ? '\\' : '/')
      if (typeof confirm === 'function' && !confirm(folderSplitQuestion(store.getState().projectName, parent, parked))) {
        store.setReadOnly(true)
        store.showSaveNotice(
          'Opened read-only',
          `This project still holds ${parked.length + 1} scenes in its folder. Nothing was changed; reopen it to split them into projects of their own.`,
        )
        return
      }
      const unlisted: ProjectJSON[] = []
      for (const project of parked) {
        const made = await api.createFolder(project.name, root)
        if ('error' in made) throw new Error(made.error)
        const written = await api.write(
          made.root,
          projectToFolderFiles(project, FOLDER_OPTIONS).map((f) => ({ path: f.path, contents: f.contents, expect: null })),
        )
        if (written.error !== null) throw new Error(written.error)
        const id = mintDocumentId()
        await api.remember(id, { path: made.root, name: project.name, baseline: null, signature: '', touch: true })
        // Its folder holds it now, so it is filed either way: failing here would make the folder again on the retry.
        // The library row is only what lists it under Projects; without it, the folder still opens.
        if (!(await writeDocument(id, project))) unlisted.push(project)
        unparkSplitOff(1) // filed: a failure on a later one must not make this folder again on the retry
      }
      // The project's own folder, in the format-4 layout: its files written whole, and the scenes/ files it no longer
      // has removed (they moved to their own folders above). Guarded on what was read, like every folder write, so a
      // file someone changed in the meantime is left alone rather than lost. The sync then starts with the two equal
      // (baseline null): the folder was just written from the project on screen.
      const read = await api.readAt(root)
      const mine = projectToFolderFiles(store.snapshotProject(), FOLDER_OPTIONS)
      const keep = new Set(mine.map((f) => f.path))
      const ops: FolderWriteOp[] = [
        ...mine.map((f) => ({ path: f.path, contents: f.contents, expect: '*' })),
        ...(read?.files ?? [])
          .filter((f) => f.path.startsWith('scenes/') && !keep.has(f.path))
          .map((f) => ({ path: f.path, expect: hashContents(f.contents) })),
      ]
      const rewritten = await api.write(root, ops)
      if (rewritten.error !== null) throw new Error(rewritten.error)
      await api.remember(docId, { baseline: null, signature: '' })
      clearParkedSplitOff()
      store.showSaveNotice(
        'Split into projects',
        `Each of ${names(parked)} is a project now, in a folder beside this one.` +
          (unlisted.length > 0 ? ` ${names(unlisted)} could not be added to your projects list: open ${unlisted.length === 1 ? 'it' : 'them'} with Open Project Folder.` : ''),
        { label: 'Projects', command: 'file.projects' },
      )
      return
    }
    if (api === null && !supportsDocumentLibrary()) {
      store.showSaveNotice(
        'Some scenes are waiting',
        `This project held other scenes - ${names(parked)}. This browser keeps one project, so they are kept for you to download as files of their own.`,
        { label: 'Download them', command: 'file.exportSplitOff' },
      )
      return
    }
    for (const project of parked) {
      if (!(await writeDocument(mintDocumentId(), project))) throw new Error(`“${project.name}” could not be saved`)
      unparkSplitOff(1)
    }
    clearParkedSplitOff()
    store.showSaveNotice('Split into projects', `This project held other scenes. Each of ${names(parked)} is a project of its own now.`, {
      label: 'Projects',
      command: 'file.projects',
    })
  } catch (e) {
    store.showSaveNotice(
      'Some scenes are waiting',
      `This project's other scenes (${names(readParkedSplitOff())}) could not be made projects of their own: ${e instanceof Error ? e.message : String(e)}. They are kept, and the app tries again next time.`,
    )
  }
}
