// The desktop app's half of a hand-over (collab/handoff.ts): a browser's Open in Desktop App sent its project, and
// the shell booted this window at `?handoff=<secret>` (apps/desktop/deepLink.cjs). Take the project, ask, and
// import it exactly as File > Import Project would: it opens as a new project, and the one open now is filed under
// Projects first.
//
// The ask is not a formality. The link is web input: any page can fire one, with a document it filled itself, and a
// project carries part code that runs here with the desktop's file and network access. The user is the only one who
// knows whether they just pressed the button, so they are asked before anything is imported.

import { fileOutgoingDocument, supportsDocumentLibrary } from '../project/documentStore'
import { importProjectData } from '../project/projectFile'
import type { EditorStore } from '../store/store'

/** Take the address bar's `?handoff=` away, so a reload is an ordinary one rather than a second hand-over. */
function forgetHandoffParam(): void {
  const url = new URL(location.href)
  url.searchParams.delete('handoff')
  history.replaceState(history.state, '', url)
}

export async function receiveDesktopHandoff(store: EditorStore, secret: string): Promise<void> {
  forgetHandoffParam()
  store.showSaveNotice('Receiving a project from your browser', 'It opens here as soon as it arrives.')
  const { receiveHandoff } = await import('../../collab/handoff')
  const handoff = await receiveHandoff(secret)
  if (!handoff) {
    store.showSaveNotice(
      'Nothing arrived from the browser',
      'The project did not reach this app. Check that this computer is online, then try Open in Desktop App again.',
    )
    return
  }
  store.dismissSaveNotice()
  const kept = supportsDocumentLibrary() ? 'The project you have open now is kept under Projects.' : 'It replaces the project you have open now.'
  const ask =
    `Open "${handoff.name}" from your browser?\n\n` +
    `It opens here as a new project, separate from the browser's copy. ${kept}\n\n` +
    'Only continue if you just chose Open in Desktop App in your browser: a project can carry part code that runs on this computer.'
  if (!confirm(ask)) return
  const error = await importProjectData(store, handoff.oip, { beforeAdopt: () => fileOutgoingDocument(store.outgoingProject()) })
  if (error) alert(error)
}
