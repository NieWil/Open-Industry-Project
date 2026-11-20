// Links that open the desktop app from a browser: `openindustry://open?room=<room>` (src/editor/desktop/desktopLink.ts
// builds them). The installer registers the scheme with the OS (package.json `build.protocols`), so a click in
// any browser launches the app, or hands the link to the copy already running (main.cjs `second-instance`).
//
// A link is untrusted input: any web page can fire one. So it can say exactly three things: "open the app", "join
// this collab room" and "take the project waiting in this hand-over document". The room or document must have
// the exact shape Share mints (src/collab/rooms.ts). It never names a file or folder. A room opens under the room
// rules (peers' part code held until the room is allowed); a hand-over is imported only after the app asks whether
// it was sent from the user's own browser (src/editor/desktop/desktopHandoff.ts).

const SCHEME = 'openindustry'

// An edit secret is `e-` + crypto.randomUUID(); a view link carries the derived doc name, `r-` + a sha256.
// Stricter than rooms.ts resolveRoom: that accepts what a browser address bar might hold, this only
// what Share has ever minted.
const EDIT_ROOM_RE = /^e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VIEW_ROOM_RE = /^r-[0-9a-f]{64}$/
// The collab server a room or hand-over lives on, when it is not the build's (src/collab/collabServer.ts). The app
// tells the user when a link takes it to another server.
const SERVER_RE = /^wss?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/

/** True when a command-line argument is one of our links (and so must never be read as a folder). */
function isDeepLinkArg(arg) {
  return typeof arg === 'string' && arg.toLowerCase().startsWith(`${SCHEME}:`)
}

/**
 * What a link asks for: `{ room: null }` (just open the app), `{ room, view }` (join that room), or null for
 * anything that is not a link this app understands, which is then ignored.
 */
function parseDeepLink(text) {
  if (!isDeepLinkArg(text) || text.length > 512) return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  // a non-special scheme's host keeps its case, and a hand-typed link may not be lower case
  if (url.hostname.toLowerCase() !== 'open' || (url.pathname !== '' && url.pathname !== '/')) return null
  const room = url.searchParams.get('room')
  const handoff = url.searchParams.get('handoff')
  const server = url.searchParams.get('server')
  if (server !== null && (server.length > 256 || !SERVER_RE.test(server))) return null
  const on = server === null ? {} : { server }
  // a hand-over (src/collab/handoff.ts): a browser's project waiting in a private document, named by its edit secret
  if (handoff !== null) return room === null && EDIT_ROOM_RE.test(handoff) ? { room: null, handoff, ...on } : null
  if (room === null) return server === null ? { room: null } : null
  if (EDIT_ROOM_RE.test(room)) return { room, view: false, ...on }
  if (VIEW_ROOM_RE.test(room)) return { room, view: true, ...on }
  return null
}

/**
 * The app URL a link asks for, from `base` (where the window's app is served): in the link's room, or booting to
 * receive its hand-over (src/editor/desktop/desktopHandoff.ts), or `base` itself for a bare "open the app".
 */
function linkUrl(base, link) {
  if (link.room) return roomUrl(base, link)
  if (!link.handoff) return base
  const url = new URL(base)
  for (const p of ['room', 'view', 'scene', 'handoff', 'server']) url.searchParams.delete(p)
  url.searchParams.set('handoff', link.handoff)
  if (link.server) url.searchParams.set('server', link.server)
  url.hash = ''
  return url.toString()
}

/** The first link on a command line (a launch or a second launch), parsed; null when there is none. */
function deepLinkFromArgv(argv) {
  for (const arg of argv.slice(1)) if (isDeepLinkArg(arg)) return parseDeepLink(arg)
  return null
}

/**
 * The app URL that joins the link's room: `base` (where the window's app is served) with `?room=` set and the
 * entry params of whatever it showed before dropped. The same URL a browser tab opened from the room link loads.
 */
function roomUrl(base, link) {
  const url = new URL(base)
  url.searchParams.delete('scene')
  url.searchParams.delete('view')
  url.searchParams.delete('handoff')
  url.searchParams.delete('server')
  url.searchParams.set('room', link.room)
  // `view` only labels a view link; the r- doc name alone is what makes it view-only (rooms.ts)
  if (link.view) url.searchParams.set('view', '1')
  if (link.server) url.searchParams.set('server', link.server)
  url.hash = ''
  return url.toString()
}

/** The room a window's URL is in, or null. */
function roomOf(href) {
  try {
    return new URL(href).searchParams.get('room')
  } catch {
    return null
  }
}

module.exports = { SCHEME, isDeepLinkArg, parseDeepLink, deepLinkFromArgv, linkUrl, roomUrl, roomOf }
