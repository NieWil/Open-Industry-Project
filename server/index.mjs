// Self-hosted Hocuspocus (Yjs) backend for oip-web live collaborative editing.
//
// One Yjs document per room (one shared project: its scene, program and parts), keyed by the
// document name the client passes.
// SQLite gives durable persistence so a room survives restarts and a late joiner gets
// the current state.
//
// Access model (no accounts - see src/collab/rooms.ts for the client half):
//   - Every room: doc name `r-<sha256(secret)>`, edit secret `e-<uuid>`. onAuthenticate
//     grants write access only when sha256(token) matches the doc name; every other connection
//     is read-only at the protocol level (view links carry no secret).
//   - Any other doc name is refused in onConnect, before a room can be created. That includes
//     a name that would be both the room id and the credential. Rows the db holds under such
//     names are unreachable, and the idle GC removes them in time.
//
// Hardening (all limits overridable via env, see the constants below):
//   - binds to loopback (HOST) by default: Caddy on the same box is the only way in, which is
//     also what makes its X-Forwarded-For trustworthy
//   - per-IP live-connection cap and new-room creation throttle (onConnect); an IPv6 client
//     counts by its /64, the block one subscriber is handed
//   - per-message and per-document size caps (ws maxPayload + beforeHandleMessage), and a
//     separate, much smaller cap on awareness (presence) messages
//   - stateless messages carry only live share (liveRelay.mjs): a writer's run, sent by the server to the
//     connections following it, and anyone's follow and catch-up requests. BroadcastStateless is refused,
//     because it would let any viewer relay arbitrary text to every connection in a room
//   - idle-room GC: rooms untouched for ROOM_TTL_DAYS are deleted (daily sweep)
//   - periodic snapshots of each active room into a `snapshots` table (restore = one
//     UPDATE, see server/DEPLOY.md); a room whose bytes equal its newest snapshot is skipped
//   - a room's owner token (roomOwners.mjs): the browser that shared a project may close its room, which is then
//     deleted and refused, so Stop sharing makes its links stop working, and may ask everyone to watch its run
//     (the spotlight); an editor of the room can do neither
//   - GET /healthz for uptime monitoring
//   - /assets/<sha256>: the bytes of parts' embedded models, so a room's document carries only their hashes
//     (assets.mjs: public GET by hash, PUT only with a room edit secret, capped per file and per IP per hour, and
//     swept daily once no stored room or snapshot names them)
//
// Deploy notes: expose over wss:// (Caddy) and point the frontend at it via
// VITE_COLLAB_URL. See docs/collab.md + server/DEPLOY.md.
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Server } from '@hocuspocus/server'
import { SQLite, upsertQuery } from '@hocuspocus/extension-sqlite'
import sqlite3 from 'sqlite3'
import { encodeStateAsUpdate } from 'yjs'
import {
  MSG_AWARENESS,
  MSG_BROADCAST_STATELESS,
  MSG_STATELESS,
  MSG_SYNC,
  MSG_SYNC_REPLY,
  SYNC_STEP2,
  SYNC_UPDATE,
  clientIp,
  readMessageHead,
} from './guards.mjs'
import { createAssetStore } from './assets.mjs'
import { LiveRelay, MAX_SNAPSHOT_CHARS } from './liveRelay.mjs'
import { handleRoomMessage, ROOM_PREFIX } from './roomOwners.mjs'

const port = Number(process.env.PORT ?? 1234)
// Loopback by default. Caddy on the same VM terminates TLS and proxies to 127.0.0.1:PORT, so
// nothing else ever needs to reach the port; bound to every interface, anyone who can route to
// it would skip TLS and could forge the X-Forwarded-For the per-IP limits key on. Set HOST=0.0.0.0
// (or ::) only for a box with no proxy in front.
const host = process.env.HOST ?? '127.0.0.1'
const database = process.env.DB_PATH ?? 'collab.sqlite'

// limits - generous for legitimate use (a heavy scene with embedded GLB packages is a
// few MB), tight enough that a vandal can't fill the disk or hog the box
const MAX_DOC_MB = Number(process.env.MAX_DOC_MB ?? 25)
const MAX_DOC_BYTES = MAX_DOC_MB * 1024 * 1024
const MAX_MESSAGE_BYTES = MAX_DOC_BYTES // first sync of a full doc arrives as one message
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP ?? 32)
const MAX_NEW_ROOMS_PER_IP_HOUR = Number(process.env.MAX_NEW_ROOMS_PER_IP_HOUR ?? 60)
const ROOM_TTL_DAYS = Number(process.env.ROOM_TTL_DAYS ?? 90) // 0 disables the GC sweep
const SNAPSHOT_MINUTES = Number(process.env.SNAPSHOT_MINUTES ?? 30) // 0 disables snapshots
const SNAPSHOT_KEEP = Number(process.env.SNAPSHOT_KEEP ?? 24) // per room
// One awareness message carries a client's whole presence state as JSON. Measured weights: name +
// color ~60 B, cursor or pilot pose ~80 B, and the heavy fields, the selection (~15 B per part id)
// and the live poses of a multi-part drag (~100 B per part, ~230 B at worst). The client publishes
// at most 500 entries of each, ids of at most 64 characters (src/collab/session.ts PRESENCE_MAX_IDS),
// which serializes to ~155 KB in the worst case (session.test.ts measures it). A bigger message is
// not presence, it is someone using the relay as a broadcast pipe: viewers may send awareness too
// (they show cursors), so this is the only bound on what a read-only link can make the server fan
// out to every peer.
const MAX_AWARENESS_BYTES = Number(process.env.MAX_AWARENESS_KB ?? 256) * 1024
// The asset store (assets.mjs): one model is rarely past a few MB once the app has optimized it, and the hourly
// budget is what one person importing a whole cell's custom parts needs, not what fills a disk.
const ASSET_DIR = process.env.ASSET_DIR ?? join(dirname(database), 'assets')
const MAX_ASSET_MB = Number(process.env.MAX_ASSET_MB ?? 25)
const MAX_ASSET_MB_PER_IP_HOUR = Number(process.env.MAX_ASSET_MB_PER_IP_HOUR ?? 200)

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const assets = createAssetStore({
  dir: ASSET_DIR,
  maxAssetBytes: MAX_ASSET_MB * 1024 * 1024,
  maxBytesPerIpHour: MAX_ASSET_MB_PER_IP_HOUR * 1024 * 1024,
  clientIp,
})
// the only document names a client may open (src/collab/rooms.ts DOC_NAME_RE)
const DOC_NAME_RE = /^r-[0-9a-f]{64}$/
// thrown from a hook, it reaches the client as a permission-denied message with this reason
// (its provider's `authenticationFailed` event), and the document is never set up
const notARoom = () => Object.assign(new Error('not a room'), { reason: 'not-a-room' })
const roomClosed = () => Object.assign(new Error('room closed'), { reason: 'room-closed' })

// --- our own handle on the same SQLite file, for room metadata + snapshots + GC.
// The Hocuspocus SQLite extension owns the `documents` table; we only read it (sizes,
// snapshot copies) and delete stale rows from it (GC). Writes are rare and tiny, so two
// connections on one file are fine with a busy timeout.
const db = new sqlite3.Database(database)
db.configure('busyTimeout', 5000)
const dbRun = (sql, params = {}) =>
  new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())))
const dbGet = (sql, params = {}) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))))
const dbAll = (sql, params = {}) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))))

await dbRun(`CREATE TABLE IF NOT EXISTS room_meta (
  name TEXT PRIMARY KEY,
  last_access INTEGER NOT NULL
)`)
await dbRun(`CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  data BLOB NOT NULL
)`)
await dbRun('CREATE INDEX IF NOT EXISTS snapshots_name_ts ON snapshots(name, ts)')
// who may close a room (roomOwners.mjs), and the rooms closed by their owners, which stay refused
await dbRun(`CREATE TABLE IF NOT EXISTS room_owners (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL
)`)
await dbRun(`CREATE TABLE IF NOT EXISTS closed_rooms (
  name TEXT PRIMARY KEY,
  at INTEGER NOT NULL
)`)

// --- per-IP accounting (in memory; resets on restart, which is fine for abuse control)

const connsByIp = new Map() // ip -> live connection count
const connIp = new Map() // `${socketId}/${documentName}` -> ip
const roomMints = new Map() // ip -> { count, windowStart } (new-room creations this hour)

function allowRoomCreation(ip) {
  const now = Date.now()
  const slot = roomMints.get(ip)
  if (!slot || now - slot.windowStart > 3600_000) {
    roomMints.set(ip, { count: 1, windowStart: now })
    return true
  }
  slot.count += 1
  return slot.count <= MAX_NEW_ROOMS_PER_IP_HOUR
}

// --- room metadata: last-access touches (throttled), persisted doc sizes, snapshots

// The document size cap needs a size that is current at every message, and the persisted size is
// not: the store is debounced (2 s, at most 10 s while edits keep coming), so on its own it lets a
// burst of large updates into memory well past the cap before the next store reports it. The
// estimate is persisted size + the bytes of every update accepted since. It over-counts (an update
// that overwrites or deletes takes less than its own length once stored, and one that changes
// nothing triggers no store at all), so before it refuses anything it is re-derived from the live
// document; each store also resets it to the bytes just written (storeDocument below).
const docBytes = new Map() // documentName -> size in bytes, as last stored or re-derived
const pendingBytes = new Map() // documentName -> bytes of updates accepted since that size was taken
// documentName -> bumped on every re-derivation, so a store that encoded the document before one
// (and is still writing) does not then overwrite the newer size with its older one
const ledgerEpoch = new Map()
// documentName -> ms of the last re-derivation. An encode of a full room blocks the event loop for
// ~200 ms, and a writer can make every message trigger one (replaying content the room already
// holds is accepted, stores nothing, and puts the pending bytes right back), so it is rationed by
// time per room. Between re-derivations the estimate alone decides, which only ever over-counts.
const lastRederive = new Map()
const REDERIVE_EVERY_MS = 10_000
const estimatedDocBytes = (name) => (docBytes.get(name) ?? 0) + (pendingBytes.get(name) ?? 0)
const lastTouch = new Map() // documentName -> ms of last room_meta write
const lastSnapshot = new Map() // documentName -> ms of last snapshot (lazily seeded from db)

function touchRoom(name) {
  const now = Date.now()
  if (now - (lastTouch.get(name) ?? 0) < 10 * 60_000) return
  lastTouch.set(name, now)
  dbRun(
    `INSERT INTO room_meta (name, last_access) VALUES ($name, $now)
       ON CONFLICT(name) DO UPDATE SET last_access = $now`,
    { $name: name, $now: now },
  ).catch((err) => console.error('[meta] touch failed:', err.message))
}

async function refreshDocSize(name) {
  try {
    const row = await dbGet('SELECT length(data) AS n FROM documents WHERE name = $name', { $name: name })
    if (row?.n != null) docBytes.set(name, row.n)
  } catch {
    /* documents table not created yet (first boot, no store) - nothing to size */
  }
}

async function maybeSnapshot(name) {
  if (!SNAPSHOT_MINUTES) return
  const now = Date.now()
  let last = lastSnapshot.get(name)
  if (last === undefined) {
    const row = await dbGet('SELECT MAX(ts) AS ts FROM snapshots WHERE name = $name', { $name: name })
    last = row?.ts ?? 0
  }
  if (now - last < SNAPSHOT_MINUTES * 60_000) {
    lastSnapshot.set(name, last)
    return
  }
  lastSnapshot.set(name, now)
  // Skip the copy when the document's bytes equal its newest snapshot: SNAPSHOT_KEEP full copies of
  // one unchanged state would only multiply its disk use, and would push the older, different
  // states (the ones a restore actually needs) out of the kept window. The blobs are compared
  // inside SQLite, so the document never round-trips through JS.
  await dbRun(
    `INSERT INTO snapshots (name, ts, data)
       SELECT d.name, $ts, d.data FROM documents d WHERE d.name = $name AND NOT EXISTS (
         SELECT 1 FROM snapshots s WHERE s.id = (
           SELECT id FROM snapshots WHERE name = $name ORDER BY ts DESC, id DESC LIMIT 1
         ) AND s.data = d.data
       )`,
    { $ts: now, $name: name },
  )
  await dbRun(
    `DELETE FROM snapshots WHERE name = $name AND id NOT IN
       (SELECT id FROM snapshots WHERE name = $name ORDER BY ts DESC LIMIT $keep)`,
    { $name: name, $keep: SNAPSHOT_KEEP },
  )
}

// --- idle-room GC: delete rooms (doc + snapshots + meta) untouched for ROOM_TTL_DAYS

let hocuspocus = null // captured in onListen, used to skip rooms that are live in memory

async function sweepIdleRooms() {
  if (!ROOM_TTL_DAYS) return
  try {
    const now = Date.now()
    // a document with no last-access row gets one dated now, so it has a full TTL from today
    await dbRun('INSERT OR IGNORE INTO room_meta (name, last_access) SELECT name, $now FROM documents', { $now: now })
    const cutoff = now - ROOM_TTL_DAYS * 86400_000
    const stale = await dbAll('SELECT name FROM room_meta WHERE last_access < $cutoff', { $cutoff: cutoff })
    let removed = 0
    for (const { name } of stale) {
      if (hocuspocus?.documents.has(name)) continue // live right now; its touch will refresh it
      await dbRun('DELETE FROM documents WHERE name = $name', { $name: name })
      await dbRun('DELETE FROM snapshots WHERE name = $name', { $name: name })
      await dbRun('DELETE FROM room_meta WHERE name = $name', { $name: name })
      await dbRun('DELETE FROM room_owners WHERE name = $name', { $name: name })
      docBytes.delete(name)
      pendingBytes.delete(name)
      ledgerEpoch.delete(name)
      lastRederive.delete(name)
      lastTouch.delete(name)
      lastSnapshot.delete(name)
      removed += 1
    }
    if (removed > 0) console.log(`[gc] removed ${removed} rooms idle > ${ROOM_TTL_DAYS} days`)
  } catch (err) {
    console.error('[gc] sweep failed:', err.message)
  }
  // assets no stored room or snapshot names any more (after the rooms above, so theirs go the same day)
  try {
    const eachRow = (sql, visit) =>
      new Promise((resolve, reject) => db.each(sql, (err, row) => (err ? reject(err) : visit(row.data)), (err) => (err ? reject(err) : resolve())))
    const removed = await assets.sweep(async (visit) => {
      await eachRow('SELECT data FROM documents', visit)
      await eachRow('SELECT data FROM snapshots', visit)
    })
    if (removed > 0) console.log(`[gc] removed ${removed} assets no room names`)
  } catch (err) {
    console.error('[gc] asset sweep failed:', err.message)
  }
}
setTimeout(sweepIdleRooms, 60_000)
setInterval(sweepIdleRooms, 24 * 3600_000)

const startedAt = Date.now()

// The SQLite extension's own `store` fires its upsert without waiting for it (no callback), so the
// row is not yet written when afterStoreDocument runs: a size read there would be one store behind and a
// snapshot would copy the previous state. This replacement runs the extension's own upsert and resolves
// only once SQLite has it, then records the size it wrote. It is called synchronously right after
// the extension encodes the document, so the pending bytes read at its start are exactly the ones
// that encoding covers; whatever is accepted while the write is in flight stays pending.
//
// It never rejects. Hocuspocus rethrows a store error from inside its debounce timer, where nothing
// catches it, so one SQLITE_BUSY (this connection racing the snapshot copy or the GC sweep on the
// server's own handle) would end the process. A failed write is retried a few times, then logged
// and given up: the ledger is left untouched, and the room's next edit stores its full state again.
const STORE_ATTEMPTS = 3
/** rooms closed while this process runs: their last state is not stored back as their connections end */
const closedHere = new Set()

const sqliteStore = new SQLite({
  database,
  store: async ({ documentName, state }) => {
    if (closedHere.has(documentName)) return
    const covered = pendingBytes.get(documentName) ?? 0
    const epoch = ledgerEpoch.get(documentName) ?? 0
    for (let attempt = 1; ; attempt++) {
      try {
        await new Promise((resolve, reject) =>
          sqliteStore.db.run(upsertQuery, { $name: documentName, $data: state }, (err) => (err ? reject(err) : resolve())),
        )
        break
      } catch (err) {
        if (attempt >= STORE_ATTEMPTS) {
          console.error(`[store] ${documentName} not stored after ${attempt} attempts:`, err.message)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
    if ((ledgerEpoch.get(documentName) ?? 0) !== epoch) return // re-derived meanwhile, from a newer state
    docBytes.set(documentName, state.byteLength)
    pendingBytes.set(documentName, Math.max(0, (pendingBytes.get(documentName) ?? 0) - covered))
  },
})

const live = new LiveRelay()
/** the relay's messages for particular connections of a document, by socket id */
const sendTo = (document, sends) => {
  for (const c of document.getConnections()) for (const p of sends.get(c.socketId) ?? []) c.sendStateless(p)
}
const owners = {
  ownerOf: async (name) => (await dbGet('SELECT token_hash FROM room_owners WHERE name = $name', { $name: name }))?.token_hash ?? null,
  setOwner: (name, hash) => dbRun('INSERT OR IGNORE INTO room_owners (name, token_hash) VALUES ($name, $hash)', { $name: name, $hash: hash }),
  close: async (name) => {
    closedHere.add(name)
    await dbRun('INSERT OR REPLACE INTO closed_rooms (name, at) VALUES ($name, $at)', { $name: name, $at: Date.now() })
    await dbRun('DELETE FROM documents WHERE name = $name', { $name: name })
    await dbRun('DELETE FROM snapshots WHERE name = $name', { $name: name })
    await dbRun('DELETE FROM room_meta WHERE name = $name', { $name: name })
    await dbRun('DELETE FROM room_owners WHERE name = $name', { $name: name })
    live.unload(name)
  },
}
const isClosed = async (name) => closedHere.has(name) || (await dbGet('SELECT 1 AS one FROM closed_rooms WHERE name = $name', { $name: name })) != null
/** a view-only connection may send only a resync request, which is a few dozen bytes */
const MAX_VIEWER_STATELESS_BYTES = 256

const server = new Server({
  port,
  // Hocuspocus hands this to http.Server#listen as `address`, which Node ignores (the option is
  // `host`), so on its own it binds every interface; see the listen call at the bottom.
  address: host,
  extensions: [sqliteStore],

  async onListen({ instance }) {
    hocuspocus = instance
    // The extension opens its own connection (in its onConfigure, before this) with no busy timeout,
    // so any moment the server's handle holds a write lock it would fail at once with SQLITE_BUSY.
    sqliteStore.db.configure('busyTimeout', 5000)
    console.log(`oip-web collab server listening on ${host}:${port} (db: ${database})`)
  },

  // Write access requires the matching edit secret as the token; everyone else is
  // protocol-level read-only (the server drops their sync updates - see
  // Connection.readOnly in @hocuspocus/server). We never throw here: viewers are welcome,
  // just not writable. (A name that is not a room was already refused in onConnect; the
  // check is repeated so this hook stays safe on its own.)
  async onAuthenticate({ documentName, token, connectionConfig }) {
    if (!DOC_NAME_RE.test(documentName)) throw notARoom()
    const holdsSecret = typeof token === 'string' && token.length > 0 && `r-${sha256Hex(token)}` === documentName
    if (!holdsSecret) connectionConfig.readOnly = true
  },

  async onConnect({ request, socketId, documentName, instance }) {
    // Only `r-<sha256>` names are rooms. Refused first, so a bare or legacy name never
    // creates a document, counts against an IP, or reaches a row persisted under it.
    if (!DOC_NAME_RE.test(documentName)) throw notARoom()
    // closed by its owner (roomOwners.mjs): every link to it stops working
    if (await isClosed(documentName)) throw roomClosed()
    const ip = clientIp(request)
    if ((connsByIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
      throw new Error(`too many connections from ${ip}`)
    }
    // a "new room" is one neither live in memory nor persisted - throttle creations per IP
    if (!instance.documents.has(documentName)) {
      let exists = false
      try {
        exists = (await dbGet('SELECT 1 AS one FROM documents WHERE name = $name', { $name: documentName })) != null
      } catch {
        /* documents table not created yet - treat as new */
      }
      if (!exists && !allowRoomCreation(ip)) {
        throw new Error(`new-room rate limit exceeded for ${ip}`)
      }
    }
    // count only after every check passed (a throw above must not leak a slot)
    connsByIp.set(ip, (connsByIp.get(ip) ?? 0) + 1)
    connIp.set(`${socketId}/${documentName}`, ip)
  },

  // a connection joining is told who owns the room and whether they asked everyone to watch; runs are followed by asking
  async connected({ documentName, connection }) {
    for (const payload of live.joinMessages(documentName)) connection.sendStateless(payload)
  },

  async onStateless({ connection, documentName, document, payload }) {
    if (typeof payload === 'string' && payload.startsWith(ROOM_PREFIX)) {
      let result
      try {
        result = await handleRoomMessage(owners, documentName, payload, { readOnly: connection.readOnly })
      } catch (err) {
        console.warn(`[room] refused from ${connection.socketId}: ${err.message}`)
        connection.close({ code: 4403, reason: 'room message refused' })
        return
      }
      connection.sendStateless(result.reply)
      // who owns the room, and the spotlight, are the relay's to keep and everyone's to know (liveRelay.mjs `o`)
      const state =
        result.owner !== undefined
          ? live.setOwner(documentName, connection.socketId, result.owner)
          : result.spotlight !== undefined
            ? live.setSpotlight(documentName, connection.socketId, result.spotlight)
            : null
      if (state) document.broadcastStateless(state)
      if (result.close) {
        // everyone in it is told, then let go; their reconnects meet onConnect's refusal
        document.broadcastStateless(`${ROOM_PREFIX}closed|`)
        for (const c of document.getConnections()) c.close({ code: 4404, reason: 'room-closed' })
      }
      return
    }
    let out
    try {
      out = live.handle(documentName, payload, { readOnly: connection.readOnly, key: connection.socketId })
    } catch (err) {
      console.warn(`[live] refused from ${connection.socketId}: ${err.message}`)
      connection.close({ code: 4403, reason: 'live-share message refused' })
      return
    }
    if (out.reply) for (const p of out.reply) connection.sendStateless(p)
    if (out.send) sendTo(document, out.send)
  },

  async onDisconnect({ socketId, documentName, document }) {
    const gone = live.disconnected(documentName, socketId)
    if (document && gone.send) sendTo(document, gone.send)
    if (document && gone.broadcast) document.broadcastStateless(gone.broadcast)
    const key = `${socketId}/${documentName}`
    const ip = connIp.get(key)
    if (ip === undefined) return
    connIp.delete(key)
    const left = (connsByIp.get(ip) ?? 1) - 1
    if (left <= 0) connsByIp.delete(ip)
    else connsByIp.set(ip, left)
  },

  // Size caps. Throwing closes the offending connection. Oversized frames never get this far:
  // ws refuses anything over maxPayload (below) before buffering it. Here, per kind of message:
  //   - document content (sync step 2 / update) from a writer is refused when it would take the
  //     room past MAX_DOC_BYTES, judged on the running estimate rather than the last stored size.
  //     A read-only connection's content is dropped by Hocuspocus unapplied, so it is not counted,
  //     and step 1 (a request to be sent the doc) is never refused: a full room stays readable.
  //   - awareness (presence) is capped at MAX_AWARENESS_BYTES, from viewers and writers alike.
  //   - stateless messages: BroadcastStateless is refused; a plain stateless message is capped at a live
  //     snapshot's size from a writer and a resync request's from a viewer (onStateless checks the rest).
  async beforeHandleMessage({ documentName, document, update, connection }) {
    if (update.byteLength > MAX_MESSAGE_BYTES) {
      throw new Error(`message exceeds ${MAX_DOC_MB} MB`)
    }
    const head = readMessageHead(update)
    if (head === null) throw new Error('malformed message')
    if (head.type === MSG_AWARENESS) {
      if (update.byteLength > MAX_AWARENESS_BYTES) {
        throw new Error(`awareness message exceeds ${MAX_AWARENESS_BYTES} bytes`)
      }
      return
    }
    if (head.type === MSG_BROADCAST_STATELESS) throw new Error('broadcast stateless messages are not accepted')
    if (head.type === MSG_STATELESS) {
      const cap = connection?.readOnly ? MAX_VIEWER_STATELESS_BYTES : MAX_SNAPSHOT_CHARS + 1024
      if (update.byteLength > cap) throw new Error(`stateless message exceeds ${cap} bytes`)
      return
    }
    const content =
      (head.type === MSG_SYNC || head.type === MSG_SYNC_REPLY) &&
      (head.step === SYNC_STEP2 || head.step === SYNC_UPDATE)
    if (!content || connection?.readOnly) return
    const now = Date.now()
    if (
      estimatedDocBytes(documentName) + update.byteLength > MAX_DOC_BYTES &&
      (pendingBytes.get(documentName) ?? 0) > 0 &&
      now - (lastRederive.get(documentName) ?? 0) >= REDERIVE_EVERY_MS
    ) {
      // Before refusing, replace the estimate with the document's real encoded size. Pending bytes
      // only ever over-count, and some never clear: content that changes nothing (a reconnecting
      // client's sync reply carrying only deletes the room already has) triggers no store, so
      // without this a room near the cap could stay write-locked until everyone left. Rationed to
      // once per REDERIVE_EVERY_MS per room (lastRederive above): a write refused inside that
      // window succeeds when retried after it.
      lastRederive.set(documentName, now)
      docBytes.set(documentName, encodeStateAsUpdate(document).byteLength)
      pendingBytes.set(documentName, 0)
      ledgerEpoch.set(documentName, (ledgerEpoch.get(documentName) ?? 0) + 1)
    }
    if (estimatedDocBytes(documentName) + update.byteLength > MAX_DOC_BYTES) {
      throw new Error(`document ${documentName} would exceed ${MAX_DOC_MB} MB`)
    }
    pendingBytes.set(documentName, (pendingBytes.get(documentName) ?? 0) + update.byteLength)
  },

  async afterLoadDocument({ documentName }) {
    touchRoom(documentName)
    pendingBytes.delete(documentName)
    await refreshDocSize(documentName)
  },

  async afterStoreDocument({ documentName }) {
    // the size ledger was settled by the store itself (sqliteStore), and the row is written, so the
    // snapshot below copies the state just stored
    touchRoom(documentName)
    try {
      await maybeSnapshot(documentName)
    } catch (err) {
      console.error('[snapshot] failed:', err.message)
    }
  },

  async afterUnloadDocument({ documentName }) {
    live.unload(documentName)
    pendingBytes.delete(documentName)
    lastRederive.delete(documentName)
  },

  // GET /healthz for uptime monitors (Caddy proxies it alongside the WebSocket), and /assets/* (assets.mjs)
  async onRequest({ request, response, instance }) {
    if (await assets.handle(request, response)) throw null // handled - skip Hocuspocus's default responder
    if (request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          openDocs: instance.documents.size,
        }),
      )
      throw null // handled - skip Hocuspocus's default responder
    }
  },
}, {
  // ws's own frame limit, checked as the frame header arrives. Without it ws buffers up to its 100 MiB
  // default before beforeHandleMessage can look at a single byte, so the per-message cap above
  // would only ever run after the memory was allocated.
  maxPayload: MAX_MESSAGE_BYTES,
})

// Hocuspocus's listen() passes the bind address under a key Node ignores (see `address` above), so
// the http server is told the host directly, keeping the rest of listen() (onListen, signals) as is.
const httpListen = server.httpServer.listen.bind(server.httpServer)
server.httpServer.listen = (options, callback) => httpListen({ ...options, host }, callback)
server.listen()
