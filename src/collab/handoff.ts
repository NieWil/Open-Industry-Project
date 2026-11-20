/**
 * HAND-OVER: a browser's project, moved to the desktop app (editor/desktop/desktopLink.ts sends, editor/desktop/desktopHandoff.ts
 * receives). A link cannot carry a project, so the browser puts the project's `.oip` bytes - the full project, every
 * scene, program, test and authored part, in the format File > Export writes - into a private document on the collab
 * server, and the link carries only that document's edit secret. The desktop reads the bytes, imports them like a
 * file, and clears the document.
 *
 * The document is a room by the server's rules (rooms.ts: `r-<sha256(secret)>`, writable only with the secret), but
 * not one anybody joins: it holds one map, never the room schema, and no editor ever boots into it. Clearing it
 * removes the bytes from the live document; the server's own snapshots of it still age out with its idle-room GC
 * (server/index.mjs ROOM_TTL_DAYS), as a room Share made does.
 */

import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { collabUrl } from './provider'
import { docNameForSecret } from './rooms'

/** the one map a hand-over document holds */
const HANDOFF_MAP = 'handoff'

export interface Handoff {
  /** the project as a `.oip` file's bytes */
  oip: Uint8Array
  /** its name, for the receiver's question before it imports anything */
  name: string
}

interface Connection {
  provider: HocuspocusProvider
  map: Y.Map<unknown>
}

async function connect(secret: string): Promise<Connection> {
  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({ url: collabUrl(), name: await docNameForSecret(secret), document: ydoc, token: secret })
  return { provider, map: ydoc.getMap(HANDOFF_MAP) }
}

/** Resolves true once every local change has reached the server (or false at `deadline`). */
function flushed(provider: HocuspocusProvider, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (provider.isSynced && !provider.hasUnsyncedChanges) return resolve(true)
    const check = (): void => {
      if (!provider.isSynced || provider.hasUnsyncedChanges) return
      done(true)
    }
    const timer = setTimeout(() => done(false), Math.max(0, deadline - Date.now()))
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      provider.off('unsyncedChanges', check)
      provider.off('synced', check)
      resolve(ok)
    }
    provider.on('unsyncedChanges', check)
    provider.on('synced', check)
  })
}

/** Resolves once the first sync with the server is done (or false at `deadline`). */
function synced(provider: HocuspocusProvider, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (provider.isSynced) return resolve(true)
    const timer = setTimeout(() => done(false), Math.max(0, deadline - Date.now()))
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      provider.off('synced', onSynced)
      resolve(ok)
    }
    const onSynced = (): void => done(true)
    provider.on('synced', onSynced)
  })
}

/** Put a project in the hand-over document. Returns why it could not, or null once the server holds it. */
export async function sendHandoff(secret: string, handoff: Handoff, timeoutMs = 30000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  const { provider, map } = await connect(secret)
  try {
    if (!(await synced(provider, deadline))) return 'The collaboration server could not be reached.'
    map.doc!.transact(() => {
      map.set('oip', handoff.oip)
      map.set('name', handoff.name)
    })
    return (await flushed(provider, deadline)) ? null : 'The project did not finish uploading.'
  } finally {
    provider.destroy()
  }
}

/** Empty the hand-over document: what the receiver does once it has the project, and the sender when nobody came. */
export async function clearHandoff(secret: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const { provider, map } = await connect(secret)
  try {
    if (!(await synced(provider, deadline))) return
    clearMap(map)
    await flushed(provider, deadline)
  } finally {
    provider.destroy()
  }
}

function clearMap(map: Y.Map<unknown>): void {
  map.doc!.transact(() => {
    for (const key of [...map.keys()]) map.delete(key)
  })
}

/**
 * Wait for a project to arrive in the hand-over document (the browser fires the link BEFORE its upload finishes, so
 * the link stays inside the click that made it), take it, and clear the document. null when nothing arrived in time.
 */
export async function receiveHandoff(secret: string, timeoutMs = 60000): Promise<Handoff | null> {
  const deadline = Date.now() + timeoutMs
  const { provider, map } = await connect(secret)
  try {
    const read = (): Handoff | null => {
      const oip = map.get('oip')
      const name = map.get('name')
      return oip instanceof Uint8Array && oip.byteLength > 0 ? { oip, name: typeof name === 'string' ? name : 'Untitled Project' } : null
    }
    const got = await new Promise<Handoff | null>((resolve) => {
      const check = (): void => {
        const h = provider.isSynced ? read() : null
        if (h) done(h)
      }
      const timer = setTimeout(() => done(null), Math.max(0, deadline - Date.now()))
      const done = (h: Handoff | null): void => {
        clearTimeout(timer)
        map.unobserve(check)
        provider.off('synced', check)
        resolve(h)
      }
      map.observe(check)
      provider.on('synced', check)
      check()
    })
    if (got) {
      // a copy: the map's value is about to be deleted out from under it
      const taken = { oip: got.oip.slice(), name: got.name }
      clearMap(map)
      await flushed(provider, Date.now() + 10000)
      return taken
    }
    return null
  } finally {
    provider.destroy()
  }
}
