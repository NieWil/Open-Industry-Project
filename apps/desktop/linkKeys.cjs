// Which of a window's links a PLC call is for. A window runs one link per controller: link 0 is the default
// controller's, and each named controller (`Cell2::%IX0.0`, src/core/io/controllerTag.ts) has a number of its own
// (src/editor/links/linkHosts.ts). A call without `link` is link 0. plcIo.cjs, opcUaIo.cjs, eipIo.cjs and adsIo.cjs
// key their links by window and number through this, and opcUaServer.cjs each simulated controller's OPC UA server.
// A scene has at most 32 controllers (src/core/scene/scenePlcs.ts MAX_SCENE_PLCS, which a unit test ties to MAX_LINKS),
// links 0-31. One more number, BROWSE_LINK, is for the PLC connections window (src/editor/links/linkHosts.ts): a short
// connection that lists a PLC's variables while a run may hold the controller's own link. Only the protocols that can
// list a PLC's variables (adsIo.cjs, eipIo.cjs, opcUaIo.cjs) take it, through listingLinkNo.

const MAX_LINKS = 32
const BROWSE_LINK = MAX_LINKS

/** The link number a call names: a whole number below {@link MAX_LINKS}, 0 when absent, null when malformed. */
function linkNo(opts) {
  const raw = opts?.link
  if (raw === undefined) return 0
  return Number.isInteger(raw) && raw >= 0 && raw < MAX_LINKS ? raw : null
}

/** {@link linkNo}, and BROWSE_LINK as well: for a protocol that lists a PLC's variables. */
function listingLinkNo(opts) {
  return opts?.link === BROWSE_LINK ? BROWSE_LINK : linkNo(opts)
}

/** The map key of a window's link `link`. */
function linkKey(senderId, link) {
  return `${senderId}:${link}`
}

/**
 * Why a port is taken, when another window of this app holds it: each window has a project of its own, and two of
 * them listening on one port is the user's to settle. '' when no other window does.
 */
function heldByAnotherWindow(map, senderId, port) {
  const prefix = `${senderId}:`
  for (const [key, entry] of map) if (!key.startsWith(prefix) && entry.port === port) return `port ${port} is in use by another Open Industry Project window; give this project a different port`
  return ''
}

/** The keys of every link a window holds in `map`. */
function windowKeys(map, senderId) {
  const prefix = `${senderId}:`
  return [...map.keys()].filter((k) => k.startsWith(prefix))
}

/**
 * Run `close(senderId)` once a window's page is gone: the window closed, or its page reloaded or went to another
 * page. A reload keeps the window, so without this the links and servers a page opened would hold their ports past
 * it, and the new page would never close the ones its project no longer has. An in-page hash change is not a
 * navigation here. `watched` keeps it to one hook per page.
 */
function onPageGone(sender, watched, close) {
  if (watched.has(sender.id)) return
  watched.add(sender.id)
  const id = sender.id
  const gone = () => {
    sender.removeListener('did-navigate', gone)
    sender.removeListener('destroyed', gone)
    watched.delete(id)
    close(id)
  }
  sender.once('destroyed', gone)
  sender.on('did-navigate', gone)
}

const BAD_LINK = 'not a link number (0-31)'

module.exports = { MAX_LINKS, BROWSE_LINK, linkNo, listingLinkNo, linkKey, windowKeys, heldByAnotherWindow, onPageGone, BAD_LINK }
