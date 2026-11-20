// Which collab server a tab talks to (docs/collab.md "Self-hosting"). Kept apart from provider.ts, which loads the
// collaboration stack, so the toolbar and Settings can read and set it without pulling that into a solo session.

/** the production collab server, which every production build talks to unless VITE_COLLAB_URL says otherwise */
const PRODUCTION_COLLAB_URL = 'wss://collab.openindustryproject.org'

/**
 * The build's collab server; dev falls back to a local server. A production build defaults to the real one rather
 * than to localhost. Only deploy-pages.yml sets VITE_COLLAB_URL, so a desktop installer would otherwise point at
 * ws://localhost:1234, where a browser's Open in Desktop App hand-over (handoff.ts) never arrives.
 */
export function defaultCollabUrl(): string {
  const url = import.meta.env.VITE_COLLAB_URL as string | undefined
  if (url && url !== '') return url
  return import.meta.env.PROD ? PRODUCTION_COLLAB_URL : 'ws://localhost:1234'
}

/** where this computer's own choice of server is kept (Settings > Live editing); unset = the build's */
const SERVER_PREF_KEY = 'oip-web/collab-server'
/** the query parameter a room link names its server with, when that is not the build's */
export const SERVER_PARAM = 'server'

/** A collab server address this app will connect to: ws:// or wss://, with no credentials, query or fragment. */
export function isCollabServerUrl(text: string): boolean {
  if (text.length > 256) return false
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password && !url.search && !url.hash && url.hostname !== ''
}

/** this computer's chosen server, or null for the build's */
export function collabServerPref(): string | null {
  try {
    const v = localStorage.getItem(SERVER_PREF_KEY)
    return v && isCollabServerUrl(v) ? v : null
  } catch {
    return null
  }
}

/** choose this computer's server for rooms it starts; null or the build's own goes back to the build's */
export function setCollabServerPref(url: string | null): void {
  try {
    if (url === null || url === defaultCollabUrl()) localStorage.removeItem(SERVER_PREF_KEY)
    else if (isCollabServerUrl(url)) localStorage.setItem(SERVER_PREF_KEY, url)
  } catch {
    /* no storage: the build's server stays */
  }
}

/** the server the page's own link names (a room shared from a self-hosted server), or null */
export function linkCollabServer(href: string = typeof location === 'undefined' ? '' : location.href): string | null {
  try {
    const v = new URL(href).searchParams.get(SERVER_PARAM)
    return v && isCollabServerUrl(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The collab server this tab talks to: the one its room link names, else this computer's choice, else the build's.
 * A room lives on one server, so a link to a room on another server says which; a room started here goes to the
 * server chosen here (Settings), and the links Share copies name it (Toolbar copyShareLink).
 */
export function collabUrl(): string {
  return linkCollabServer() ?? collabServerPref() ?? defaultCollabUrl()
}

/** the web app, where a link copied in the desktop app has to point: its own oip:// address opens nowhere else */
const PUBLIC_APP_URL = 'https://www.openindustryproject.org/app/'

/** `link` as someone else can open it: a page served over http(s) keeps its own address, the desktop app's goes to the web app */
export function shareableLink(link: URL): URL {
  if (link.protocol === 'http:' || link.protocol === 'https:') return link
  const out = new URL(PUBLIC_APP_URL)
  out.search = link.search
  return out
}

/** true when this tab talks to a server other than the build's own, which its links must then name */
export function onOtherCollabServer(): boolean {
  return collabUrl() !== defaultCollabUrl()
}
