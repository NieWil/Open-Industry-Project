// The plant's run in a shared project (docs/live-share.md), so a view link shows the cell the outside PLC drives.
//
// The plant joins a collab room as its one editor: it fills an empty room with its scene, then runs in it the way a
// browser does. Its presence says it is running and names its stream, and it sends that stream's frames
// (collab/liveShare.ts) only while someone follows it. A view link to the room follows the only run going, so a visitor
// sees this run, read-only, with nothing of their own to start. The frames carry the plant's tags as the run's watch
// values, so notes and the Watch panel read what the PLC reads and writes.
//
// The room is the one the edit secret names: the same secret gives the same view link across restarts of the plant.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

/** how the plant shows in the room's people list, and the colour of its avatar */
const PLANT_COLOR = '#31a354'

/** The edit secret in `file`, made there on first use, so the plant keeps one room and one view link. */
export function roomSecret(file) {
  if (existsSync(file)) {
    const secret = readFileSync(file, 'utf8').trim()
    if (/^e-[0-9a-f-]{36}$/.test(secret)) return secret
    throw new Error(`${file} holds no room edit secret (e-<uuid>)`)
  }
  const secret = `e-${randomUUID()}`
  writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  return secret
}

/** the room's document name, which is all a view link carries (collab/rooms.ts) */
export function docNameOf(secret) {
  return `r-${createHash('sha256').update(secret).digest('hex')}`
}

/**
 * Join the room at `url` with `secret`, fill it with `scene` if it is empty, and run in it.
 * `ours` holds the collab modules (liveShare, schema), loaded through vite like the rest of the plant.
 * Returns `push(frame, watch)` for each step's frame, and `close()`.
 */
export async function shareRun(ours, { url, secret, scene, name, timeoutMs = 15000 }) {
  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({ url, name: docNameOf(secret), document: ydoc, token: secret })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the collab server at ${url} did not sync within ${timeoutMs} ms`)), timeoutMs)
    provider.on('synced', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  // only an empty room is filled, as Share does (collab/provider.ts seedIfEmpty): a restart finds its scene there
  let empty = false
  ydoc.transact(() => {
    empty = ours.partsMap(ydoc).size === 0
  }, ours.LOCAL_ORIGIN)
  if (empty) ours.sceneToDoc(scene, ydoc, ours.LOCAL_ORIGIN)
  if (ours.readProjectName(ydoc) !== name) ours.writeProjectName(ydoc, name)

  const send = (payload) => provider.sendStateless(payload)
  const sender = new ours.LiveShareSender(send)
  provider.on('stateless', ({ payload }) => {
    const m = ours.parseLiveMessage(payload)
    if (m && (m.kind === 'w' || m.kind === 'q')) sender.accept(m.kind, m.stream, m.body)
  })
  provider.setAwarenessField('user', { name, color: PLANT_COLOR })
  provider.setAwarenessField('running', true)
  provider.setAwarenessField('stream', sender.stream)

  return {
    docName: docNameOf(secret),
    /** how many follow the run, as the server last said */
    followers: () => sender.followers,
    push: (frame, watch) => sender.push(frame, watch),
    close: () => {
      sender.end()
      provider.setAwarenessField('running', false)
      provider.setAwarenessField('stream', null)
      provider.destroy()
    },
  }
}
