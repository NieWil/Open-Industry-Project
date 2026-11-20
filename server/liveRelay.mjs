// The live-share relay (docs/live-share.md): anyone running in a room can be watched. The server sends each run only
// to the connections following it, and a runner sends frames only while someone follows, so a run nobody watches
// costs nothing.
//
// Messages are Hocuspocus stateless strings, `live2|<kind>|<stream>|<body>`.
// From a writer, about its own run:
//   a  announce: this connection runs under this stream id (one at a time; a new one ends the last)
//   s  snapshot: everything a viewer needs to start (src/core/live/liveFrameWire.ts). Sent to followers waiting for
//      one, and kept for followers who join later; never relayed to followers already drawing the run
//   d  delta: one frame's changes. Sent to the stream's followers, and kept after the snapshot for later joiners
//   e  end: the run stopped. Sent to its followers, and the stream is dropped
// From anyone, view links included:
//   f  follow this stream (one at a time per connection)
//   u  stop following it
//   r  resync: a follower missed a delta and wants the snapshot and the deltas after it
// From the server:
//   w  to a runner: how many follow its stream now
//   q  to a runner: send a snapshot with the next frame
//   e  to a follower of a stream the server does not know (it ended)
//   o  to everyone: `o|<owner's client id, or ->|<1 while the owner asks everyone to watch>`
// The owner and the spotlight are set by roomOwners.mjs messages, which prove the owner token; the relay only keeps
// them. It never reads a frame's body: it is opaque base64 to the server.

export const LIVE_PREFIX = 'live2|'
/** the protocol before following: an old build's messages are ignored, never refused, so its editing keeps working */
const OLD_PREFIX = 'live1|'
export const MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024
export const MAX_DELTA_CHARS = 1024 * 1024
/** past this much backlog after the snapshot, the runner is asked for a fresh one, so a joiner's catch-up stays small */
export const REBASE_BACKLOG_CHARS = 1024 * 1024
/** a runner that ignores the request: past this, joiners are not served from the backlog at all */
export const MAX_BACKLOG_CHARS = 16 * 1024 * 1024
/** a kept snapshot is current only while deltas keep coming; a runner goes quiet a while after its last follower leaves */
export const FRESH_MS = 1000
/** at most one snapshot request per stream this often, so following and unfollowing cannot make a runner upload */
export const ASK_EVERY_MS = 2000
export const RESYNC_EVERY_MS = 1000
const STREAM_RE = /^[A-Za-z0-9-]{1,64}$/
const CLIENT_RE = /^[0-9]{1,16}$/
const FROM_WRITER = ['a', 's', 'd', 'e']
const FROM_ANYONE = ['f', 'u', 'r']

/** Parse a live message from a client. null = not one (the caller refuses it). */
export function parseLive(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(LIVE_PREFIX)) return null
  const rest = payload.slice(LIVE_PREFIX.length)
  const a = rest.indexOf('|')
  const b = a < 0 ? -1 : rest.indexOf('|', a + 1)
  if (b < 0) return null
  const kind = rest.slice(0, a)
  const stream = rest.slice(a + 1, b)
  if (![...FROM_WRITER, ...FROM_ANYONE].includes(kind) || !STREAM_RE.test(stream)) return null
  return { kind, stream, bodyChars: rest.length - b - 1 }
}

const msg = (kind, stream, body = '') => `${LIVE_PREFIX}${kind}|${stream}|${body}`

export class LiveRelay {
  constructor(now = () => Date.now()) {
    this.now = now
    /**
     * documentName -> {
     *   streams: stream id -> { id, owner, followers: key -> 'ready' | 'waiting', snapshot, backlog, backlogChars, lastDelta, askedAt },
     *   following: key -> stream id, owner: { key, client } | null, spotlight }
     */
    this.rooms = new Map()
    /** connection key -> last resync or follow time */
    this.resyncAt = new Map()
  }

  /**
   * One stateless message from a connection. Returns what to send:
   *   { reply: payload[] }       to the sender
   *   { send: Map<key, payload[]> } to other connections of the document, by key
   * Throws for a message the connection may not send, which closes it.
   */
  handle(documentName, payload, { readOnly, key }) {
    if (typeof payload === 'string' && payload.startsWith(OLD_PREFIX)) return {}
    const m = parseLive(payload)
    if (!m) throw new Error('stateless message is not a live-share message')
    if (FROM_WRITER.includes(m.kind) && readOnly) throw new Error('a view-only connection cannot share a live run')
    const out = new Out()
    const room = this.room(documentName)
    const t = this.now()
    switch (m.kind) {
      case 'a': {
        const mine = this.streamOf(room, key)
        if (mine) this.endStream(room, mine, out)
        room.streams.set(m.stream, { id: m.stream, owner: key, followers: new Map(), snapshot: null, backlog: [], backlogChars: 0, lastDelta: -Infinity, askedAt: -Infinity })
        break
      }
      case 's': {
        if (m.bodyChars > MAX_SNAPSHOT_CHARS) throw new Error('live snapshot too large')
        const st = this.owned(room, m.stream, key)
        if (!st) break
        st.snapshot = payload
        st.backlog = []
        st.backlogChars = 0
        st.lastDelta = t
        for (const [k, state] of st.followers) {
          if (state !== 'waiting') continue
          st.followers.set(k, 'ready')
          out.to(k, payload)
        }
        break
      }
      case 'd': {
        if (m.bodyChars > MAX_DELTA_CHARS) throw new Error('live delta too large')
        const st = this.owned(room, m.stream, key)
        if (!st) break
        st.lastDelta = t
        for (const [k, state] of st.followers) if (state === 'ready') out.to(k, payload)
        if (st.snapshot !== null) {
          st.backlog.push(payload)
          st.backlogChars += payload.length
          if (st.backlogChars > MAX_BACKLOG_CHARS) this.dropSnapshot(st)
          else if (st.backlogChars > REBASE_BACKLOG_CHARS) this.ask(st, out)
        }
        // a follower still waiting (its request was held back by the rate limit) is asked for again
        if ([...st.followers.values()].includes('waiting')) this.ask(st, out)
        break
      }
      case 'e': {
        const st = this.owned(room, m.stream, key)
        if (st) this.endStream(room, st, out)
        break
      }
      case 'f': {
        // not rate-limited: a dropped follow would leave a viewer waiting. What it can cost a runner is limited in ask().
        this.unfollow(room, key, out)
        const st = room.streams.get(m.stream)
        if (!st) {
          out.reply(msg('e', m.stream))
          break
        }
        room.following.set(key, st.id)
        this.serve(st, key, out)
        out.to(st.owner, msg('w', st.id, String(st.followers.size)))
        break
      }
      case 'u': {
        if (room.following.get(key) === m.stream) this.unfollow(room, key, out)
        break
      }
      case 'r': {
        if (t - (this.resyncAt.get(key) ?? -Infinity) < RESYNC_EVERY_MS) break
        this.resyncAt.set(key, t)
        const st = room.streams.get(m.stream)
        if (st && st.followers.has(key)) this.serve(st, key, out)
        break
      }
    }
    if (room.streams.size === 0 && room.following.size === 0 && !room.owner) this.rooms.delete(documentName)
    return out.result(key)
  }

  /** what a connection joining the document is told: who owns it and whether they asked everyone to watch */
  joinMessages(documentName) {
    const room = this.rooms.get(documentName)
    return room?.owner ? [this.roomState(room)] : []
  }

  /** the owner's tab proved its token (roomOwners.mjs claim): returns the state to tell everyone */
  setOwner(documentName, key, client) {
    if (!CLIENT_RE.test(String(client))) return null
    const room = this.room(documentName)
    if (room.owner?.key !== key) room.spotlight = false
    room.owner = { key, client: String(client) }
    return this.roomState(room)
  }

  /** the owner asks everyone to watch its run, or stops: returns the state to tell everyone, or null if not the owner */
  setSpotlight(documentName, key, on) {
    const room = this.rooms.get(documentName)
    if (!room?.owner || room.owner.key !== key) return null
    room.spotlight = on
    return this.roomState(room)
  }

  /**
   * A connection left: its follow ends, its run ends for its followers, and an owner leaving takes the spotlight with it.
   * Returns { send: Map<key, payload[]>, broadcast?: payload }.
   */
  disconnected(documentName, key) {
    this.resyncAt.delete(key)
    const out = new Out()
    const room = this.rooms.get(documentName)
    if (!room) return out.result(key)
    this.unfollow(room, key, out)
    const mine = this.streamOf(room, key)
    if (mine) this.endStream(room, mine, out)
    let broadcast
    if (room.owner?.key === key) {
      room.owner = null
      room.spotlight = false
      broadcast = msg('o', '-', '0')
    }
    if (room.streams.size === 0 && room.following.size === 0 && !room.owner) this.rooms.delete(documentName)
    return { ...out.result(key), ...(broadcast ? { broadcast } : {}) }
  }

  unload(documentName) {
    this.rooms.delete(documentName)
  }

  room(documentName) {
    let room = this.rooms.get(documentName)
    if (!room) this.rooms.set(documentName, (room = { streams: new Map(), following: new Map(), owner: null, spotlight: false }))
    return room
  }

  roomState(room) {
    return msg('o', room.owner?.client ?? '-', room.spotlight ? '1' : '0')
  }

  streamOf(room, key) {
    for (const st of room.streams.values()) if (st.owner === key) return st
    return null
  }

  owned(room, id, key) {
    const st = room.streams.get(id)
    return st && st.owner === key ? st : null
  }

  /** start a follower: from the kept snapshot while it is current, else ask the runner for one */
  serve(st, key, out) {
    if (st.snapshot !== null && this.now() - st.lastDelta > FRESH_MS) this.dropSnapshot(st)
    if (st.snapshot !== null) {
      st.followers.set(key, 'ready')
      out.reply(st.snapshot, ...st.backlog)
    } else {
      st.followers.set(key, 'waiting')
      this.ask(st, out)
    }
  }

  ask(st, out) {
    const t = this.now()
    if (t - st.askedAt < ASK_EVERY_MS) return
    st.askedAt = t
    out.to(st.owner, msg('q', st.id))
  }

  dropSnapshot(st) {
    st.snapshot = null
    st.backlog = []
    st.backlogChars = 0
    for (const k of st.followers.keys()) st.followers.set(k, 'waiting')
  }

  unfollow(room, key, out) {
    const id = room.following.get(key)
    if (id === undefined) return
    room.following.delete(key)
    const st = room.streams.get(id)
    if (!st || !st.followers.delete(key)) return
    out.to(st.owner, msg('w', st.id, String(st.followers.size)))
  }

  endStream(room, st, out) {
    room.streams.delete(st.id)
    for (const k of st.followers.keys()) {
      room.following.delete(k)
      out.to(k, msg('e', st.id))
    }
  }
}

/** what one message makes the server send */
class Out {
  constructor() {
    this.replies = []
    this.sends = new Map()
  }

  reply(...payloads) {
    this.replies.push(...payloads)
  }

  to(key, payload) {
    const list = this.sends.get(key)
    if (list) list.push(payload)
    else this.sends.set(key, [payload])
  }

  /** the sender's own messages go back as its reply */
  result(sender) {
    const mine = this.sends.get(sender)
    if (mine) {
      this.sends.delete(sender)
      this.replies.push(...mine)
    }
    return { ...(this.replies.length ? { reply: this.replies } : {}), ...(this.sends.size ? { send: this.sends } : {}) }
  }
}
