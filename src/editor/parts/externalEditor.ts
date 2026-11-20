// A part definition's files on the desktop, and "Open in external editor".
//
// There is one place a project's part definitions live: its own copies (store.userPackages), stored with the project -
// on the desktop, in the project folder's parts/<slug>/, which the project folder sync writes as you edit and reads
// back when something outside the app (VS Code, an agent) changes it. So a part's folder is where the sync
// keeps it, and opening it in an external editor means: make sure the part is in this project's parts (a
// built-in becomes this project's own version, the same copy-on-write an in-app edit makes), make sure the project
// has a folder, let the sync write it, and open its behavior.js. An edit saved there comes back through the sync.
// The shell keeps no parts folder of its own: with two homes, which copy of a part wins is load order, and a part
// edited in one project leaks into another.

import { getPackage } from '../../core/parts/partRegistry'
import { partFolderPaths } from '../../core/project/projectFolder'
import { getOipPartsApi } from '../desktop/desktopPartsBridge'
import { ensureProjectFolder, syncFolderNow, syncedFolderPath } from '../project/projectFolderSync'
import { libraryCopyOf } from '../store/storePackages'
import type { EditorState, EditorStore } from '../store/store'

/** The folder one of this project's parts lives in on disk, or null (no project folder, not a library part). */
export function partFolderOf(state: Pick<EditorState, 'userPackages'>, packageId: string): string | null {
  const root = syncedFolderPath()
  if (!root) return null
  const rel = partFolderPaths(state.userPackages).get(packageId)
  if (!rel) return null
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`
}

/** Can this part be opened in the external editor here? The desktop app, and a part the app has. */
export function canOpenExternal(packageId: string): boolean {
  return !!getOipPartsApi()?.openScript && !!getPackage(packageId)
}

/** Open it: '' on success, else a short reason to show. */
export async function openExternal(packageId: string, store: EditorStore | null): Promise<string> {
  const api = getOipPartsApi()
  const pkg = getPackage(packageId)
  if (!api?.openScript || !pkg || !store) return 'Opening a part in an external editor needs the desktop app.'
  try {
    // this project's own version of the part (a no-op when it already is one)
    if (!store.getState().userPackages.some((p) => p.id === packageId)) store.addUserPackage(libraryCopyOf(store.getState(), pkg))
    if (!(await ensureProjectFolder(store))) {
      return 'This project has no folder to keep its parts in. Save it to a folder (File > Save Project to Folder…), then open the part.'
    }
    await syncFolderNow() // the sync writes parts/<slug>/ now, so the file is there to open
    const dir = partFolderOf(store.getState(), packageId)
    if (!dir) return "Couldn't find this part's folder in the project."
    return await api.openScript(dir)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
