import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { SceneJSON, SimRate } from '../core/types'
import type { Controller } from '../core/controller'
import type { ResolvedRoom } from './rooms'
import { LOCAL_ORIGIN, partsMap, sceneToDoc, writeSimHz, writeStDoc } from './schema'
import { collabUrl, defaultCollabUrl } from './collabServer'

// re-exported: main.tsx and the room code read it from here
export { collabUrl } from './collabServer'

export interface RoomConnection {
  ydoc: Y.Doc
  provider: HocuspocusProvider
  idb: IndexeddbPersistence
  /** resolves once local (IndexedDB) state is loaded and the server has synced (or timed out) */
  whenSynced: Promise<void>
  /** true once the SERVER has synced, so the doc is the room as it is now rather than this browser's cached copy */
  serverSynced(): boolean
}

/** how long to wait on the server before booting offline from the IndexedDB cache */
const SERVER_SYNC_TIMEOUT_MS = 4000

/**
 * Open a collaborative room: a Y.Doc backed by IndexedDB (offline cache + instant load) and
 * a Hocuspocus WebSocket connection. The document name and auth token come pre-resolved
 * from the ?room= value (see rooms.ts): the token is the edit secret when we hold one, and
 * the server grants read-only otherwise. `whenSynced` resolves once the local cache is
 * loaded AND the server has synced - or, if the server is unreachable, after a short
 * timeout so the editor still opens offline and replays on reconnect.
 */
export function connectRoom(resolved: ResolvedRoom): RoomConnection {
  const ydoc = new Y.Doc()
  // a room's offline copy is kept per server: the same room name on two servers is two rooms
  const server = collabUrl()
  const idb = new IndexeddbPersistence(server === defaultCollabUrl() ? `oip-room-${resolved.docName}` : `oip-room-${new URL(server).host}-${resolved.docName}`, ydoc)
  const provider = new HocuspocusProvider({
    url: server,
    name: resolved.docName,
    document: ydoc,
    token: resolved.token,
  })

  let serverDone = false
  const whenSynced = new Promise<void>((resolve) => {
    let idbDone = false
    let timedOut = false
    let resolved = false
    const tryResolve = (): void => {
      if (!resolved && idbDone && (serverDone || timedOut)) {
        resolved = true
        resolve()
      }
    }
    idb.once('synced', () => {
      idbDone = true
      tryResolve()
    })
    provider.on('synced', () => {
      serverDone = true
      tryResolve()
    })
    setTimeout(() => {
      timedOut = true
      tryResolve()
    }, SERVER_SYNC_TIMEOUT_MS)
  })

  return { ydoc, provider, idb, whenSynced, serverSynced: () => serverDone }
}

/**
 * Seed a freshly-opened room from `scene` + its PLC program if (and only if) it has no parts yet.
 * Re-checks emptiness inside the transaction so two simultaneous first-joiners can't both
 * seed. This is how Share carries the creator's current scene and PLC logic into the room.
 * Returns true if it seeded.
 *
 * The program comes from the same document the editor is showing (the caller reads it out of the
 * stored project), not the legacy localStorage key, which the demo boot never writes: from
 * there, sharing a demo would produce a room with the layout and no logic.
 */
export function seedIfEmpty(
  ydoc: Y.Doc,
  scene: SceneJSON,
  stProgram?: string,
  stScanMs?: number,
  simHz?: SimRate,
  controller?: Controller | null,
  /** the program's dialect (core/dialect.ts); absent or 'iec' seeds none */
  stDialect?: string,
  /** the creator's own authored/forked package ids, seeded as edits rather than snapshots (schema.editedPackageIds) */
  edited?: ReadonlySet<string>,
): boolean {
  let seeded = false
  ydoc.transact(() => {
    if (partsMap(ydoc).size > 0) return
    seeded = true
  }, LOCAL_ORIGIN)
  if (seeded) {
    sceneToDoc(scene, ydoc, LOCAL_ORIGIN, edited)
    // no scan time supplied -> the room carries none, and every peer keeps its own default
    // ...and its controller table rides with the program, so a room gets the tasks along with the logic, and its
    // dialect too, so a program this build cannot run reaches the room as what it is rather than as IEC
    if (stProgram && stProgram !== '') writeStDoc(ydoc, stProgram, stScanMs, undefined, controller ?? undefined, stDialect)
    // the step rate belongs to the project, so it seeds whether or not there is a program (a default-rate
    // seed writes nothing: absent already reads as the default)
    if (simHz !== undefined) writeSimHz(ydoc, simHz)
  }
  return seeded
}
