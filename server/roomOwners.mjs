// Who owns a room (docs/live-share.md "Sharing a project"). Sharing one of the user's projects makes a room, and
// Stop sharing has to make its links stop working. A link cannot be taken back without accounts, so the browser that
// shares a project registers an owner token with the room: a secret of its own, apart from the edit secret, which
// every editor holds. Closing the room and the spotlight take that token, so an editor cannot do either.
//
// Messages are Hocuspocus stateless strings from a writer, `room1|<kind>|<token>[|<arg>]`:
//   claim      register the token as the room's owner, when it has none (or say whether it is this one). Its arg is
//              the owner tab's presence client id, so everyone can be told who the owner is (liveRelay.mjs `o`)
//   close      close the room, when the token is its owner's
//   spotlight  arg 1 or 0: the owner asks everyone to watch its run, or stops
// The server keeps only a hash of the token. A closed room is deleted, and refused from then on.

import { createHash } from 'node:crypto'

export const ROOM_PREFIX = 'room1|'
const TOKEN_RE = /^[A-Za-z0-9-]{16,128}$/
const CLIENT_RE = /^[0-9]{1,16}$/

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Parse a room message. null = not one. */
export function parseRoomMessage(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(ROOM_PREFIX)) return null
  const [kind, token, arg, ...rest] = payload.slice(ROOM_PREFIX.length).split('|')
  if (rest.length > 0 || !TOKEN_RE.test(token ?? '')) return null
  if (kind === 'close' && arg === undefined) return { kind, token }
  // an older build claims with no client id
  if (kind === 'claim' && (arg === undefined || CLIENT_RE.test(arg))) return { kind, token, client: arg ?? null }
  if (kind === 'spotlight' && (arg === '1' || arg === '0')) return { kind, token, on: arg === '1' }
  return null
}

/**
 * One room message from a connection, against `store` ({ ownerOf(name), setOwner(name, hash), close(name) }, async).
 * Returns { reply } for the sender, and:
 *   close: true        the room was closed (the caller ends its connections)
 *   owner: client id   the owner proved its token and said who it is (the caller tells everyone)
 *   spotlight: boolean the owner turned the spotlight on or off
 * Throws for a message the connection may not send.
 */
export async function handleRoomMessage(store, documentName, payload, { readOnly }) {
  const msg = parseRoomMessage(payload)
  if (!msg) throw new Error('not a room message')
  if (readOnly) throw new Error('a view-only connection cannot claim or close a room')
  const hash = sha256Hex(msg.token)
  const owner = await store.ownerOf(documentName)
  if (msg.kind === 'claim') {
    if (owner === null) await store.setOwner(documentName, hash)
    const ok = owner === null || owner === hash
    return { reply: `${ROOM_PREFIX}claim|${ok ? 'ok' : 'taken'}`, ...(ok && msg.client !== null ? { owner: msg.client } : {}) }
  }
  if (owner === null || owner !== hash) return { reply: `${ROOM_PREFIX}${msg.kind}|refused` }
  if (msg.kind === 'spotlight') return { reply: `${ROOM_PREFIX}spotlight|ok`, spotlight: msg.on }
  await store.close(documentName)
  return { reply: `${ROOM_PREFIX}close|ok`, close: true }
}
