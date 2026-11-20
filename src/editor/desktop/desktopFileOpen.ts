// A project or part file opened from outside the app (desktop only): a double-click on a `.oip` / `.oippart`, "Open
// with", or a path on the command line. The shell reads the file and hands over its bytes (apps/desktop/fileOpen.cjs);
// this imports them through the same doors the app's own Import Project and Import part use, so a file opened this way
// behaves exactly like one picked in the app. A `.oip` opens as a project of its own; a `.oippart` goes into the open
// project's parts.

import type { EditorController } from '../controller'
import { getOipProjectApi } from './desktopProjectApi'
import type { OpenedDocumentFile } from './desktopProjectApi'
import { importProjectFile } from '../project/importProjectFile'
import type { EditorStore } from '../store/store'

/** Why a file cannot be imported right now, or null when it can (the same rules as File > Import Project). */
function blockedReason(store: EditorStore): string | null {
  const s = store.getState()
  if (s.running) return 'Stop the simulation first, then open the file again.'
  if (s.readOnly) return 'This window is view-only.'
  return null
}

/** Import one opened file. Exported for its unit test. */
export async function openDocumentFile(store: EditorStore, controller: EditorController | null, file: OpenedDocumentFile): Promise<void> {
  if ('error' in file) {
    alert(file.error)
    return
  }
  const blocked = blockedReason(store)
  if (blocked !== null) {
    alert(`Couldn't open “${file.name}”. ${blocked}`)
    return
  }
  if (file.kind === 'project') {
    await importProjectFile(store, controller, file.bytes, file.name)
    return
  }
  if (!controller) return
  const error = await controller.importPart(file.bytes, (name) => confirm(`A part “${name}” is already in this project. Replace it with the one from “${file.name}”?`))
  if (error) alert(`Couldn't import “${file.name}”:\n${error}`)
  else store.showSaveNotice('Part imported', `“${file.name}” is in this project's parts now.`)
}

/**
 * Take the file the app was launched with (once), and every file opened while it runs. Call once at mount; returns
 * the unsubscribe. A no-op in the browser, and with a shell from before file opening existed.
 */
export function connectDesktopFileOpens(store: EditorStore, controller: EditorController | null): () => void {
  const api = getOipProjectApi()
  if (!api?.takePendingFile || !api.onOpenFile) return () => {}
  void api
    .takePendingFile()
    .then((file) => {
      if (file) void openDocumentFile(store, controller, file)
    })
    .catch((e: unknown) => console.warn('[oip] opening the file the app was started with failed', e))
  return api.onOpenFile((file) => void openDocumentFile(store, controller, file))
}
