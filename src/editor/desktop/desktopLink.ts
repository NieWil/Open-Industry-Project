// "Open in Desktop App": move what this browser tab shows into the installed desktop app, through its link scheme.
// The shell registers `openindustry://` at install (apps/desktop/installer.nsh on Windows, package.json
// `build.protocols` elsewhere) and reads the link in apps/desktop/deepLink.cjs, which accepts exactly the shapes
// built here.
//
// In a room the app joins the same room, as a second tab would. Solo, the project lives in this browser's storage,
// which a link cannot carry, so it is handed over (collab/handoff.ts): the project's .oip bytes go to a private
// document on the collab server, the link names that document, and the desktop imports it as a new project of its
// own. From then on the two are separate copies.

import { collabUrl, onOtherCollabServer } from '../../collab/collabServer'
import { mintEditSecret } from '../../collab/rooms'
import { projectToOipBytes } from '../../core/project/projectArchive'
import type { EditorStore } from '../store/store'
import { warmShippedAssets } from '../parts/shippedAssetCache'
import { FOLDER_OPTIONS } from '../project/folderOptions'

export const DESKTOP_LINK_SCHEME = 'openindustry'

/** Where to get the app: the landing page's download section. */
export const DESKTOP_DOWNLOAD_URL = '/#desktop'

/** How long the page waits to lose focus before deciding the app did not open. */
const NO_APP_AFTER_MS = 2000

/** `&server=` for a room or hand-over on a server other than the build's, which the desktop must use too */
const serverPart = (server: string | null): string => (server === null ? '' : `&server=${encodeURIComponent(server)}`)

/** The link that opens the desktop app on `room` (or just opens it, for null), on `server` when it is not the build's. */
export function desktopLink(room: string | null, server: string | null = null): string {
  const link = `${DESKTOP_LINK_SCHEME}://open`
  return room === null ? link : `${link}?room=${encodeURIComponent(room)}${serverPart(server)}`
}

/** The link that has the desktop app take the project waiting in a hand-over document. */
export function handoffLink(secret: string, server: string | null = null): string {
  return `${DESKTOP_LINK_SCHEME}://open?handoff=${encodeURIComponent(secret)}${serverPart(server)}`
}

/** The room this tab is in, as its address bar names it, or null when it is solo. */
export function currentRoom(href: string = location.href): string | null {
  return new URL(href).searchParams.get('room')
}

/**
 * Fire the link, and say where to get the app when nothing took it. A page cannot ask whether a scheme has a
 * handler, so this uses the one signal there is: an app that opens takes the focus (the browser's own "Open
 * Open Industry Project?" prompt does too), and a page that keeps it for a while had nothing to hand the link to.
 *
 * Solo, the hand-over upload starts after the link is fired, not before: a browser hands a scheme to the OS only
 * inside the click that asked, and an upload can outlast that. The desktop waits for the project to arrive.
 */
export function openInDesktopApp(store: EditorStore, room: string | null = currentRoom()): void {
  const secret = room === null ? mintEditSecret() : null
  let settled = false
  // resolves true when an app took the link, false when none did
  let decide: (opened: boolean) => void = () => {}
  const decided = new Promise<boolean>((resolve) => (decide = resolve))
  const settle = (): void => {
    settled = true
    removeEventListener('blur', opened)
    document.removeEventListener('visibilitychange', opened)
  }
  const opened = (): void => {
    settle()
    decide(true)
  }
  addEventListener('blur', opened)
  document.addEventListener('visibilitychange', opened)
  setTimeout(() => {
    if (settled) return
    settle()
    decide(false)
    store.showSaveNotice(
      'Desktop app did not open',
      'The desktop app does not seem to be installed here, or it is a version from before it could open this.',
      { label: 'Get the Desktop App', command: 'help.getDesktopApp' },
    )
  }, NO_APP_AFTER_MS)
  // A click on a link, the gesture browsers expect before they hand a scheme to the OS. Chromium and WebKit keep
  // this page where it is. Firefox with no handler at all may show its own error page instead (not checked yet).
  // The page saves on pagehide, so even then the document is kept.
  const a = document.createElement('a')
  const server = onOtherCollabServer() ? collabUrl() : null
  a.href = secret === null ? desktopLink(room, server) : handoffLink(secret, server)
  a.click()
  if (secret !== null) void handOver(store, secret, decided)
}

/** Upload this tab's project for the desktop to take; take it back down when no app came for it. */
async function handOver(store: EditorStore, secret: string, decided: Promise<boolean>): Promise<void> {
  const project = store.snapshotProject()
  const { sendHandoff, clearHandoff } = await import('../../collab/handoff')
  // the .oip carries a built-in copy's models as files (the bytes this app ships), once they are at hand
  await warmShippedAssets(project.packages ?? [])
  const oip = await projectToOipBytes(project, FOLDER_OPTIONS)
  const error = await sendHandoff(secret, { oip, name: project.name || 'Untitled Project' })
  // nobody is coming for it: don't leave the project sitting on the server (the no-app notice is already up)
  if (!(await decided)) {
    if (error === null) void clearHandoff(secret)
    return
  }
  if (error !== null) {
    store.showSaveNotice('Could not send the project to the desktop app', `${error} Your work is still here in the browser.`)
    return
  }
  store.showSaveNotice(
    'Sent to the desktop app',
    `"${project.name || 'Untitled Project'}" opens there as a project of its own. This browser keeps its copy, and changes in one do not reach the other.`,
  )
}
