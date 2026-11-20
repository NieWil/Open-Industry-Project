// End-to-end check: server-enforced room access on the collab server (no browser needed).
//
// Spawns the real server/index.mjs on a free port with a temp SQLite db and connects raw
// Hocuspocus providers (same package the frontend uses). Asserts the access matrix of the
// room-link scheme (src/collab/rooms.ts + server onAuthenticate):
//   - edit secret  -> read-write
//   - doc-name only (view link, or a view link with ?view stripped) -> readonly, and its
//     writes are dropped server-side (the CRDT never propagates them)
//   - any other doc name (the retired legacy rooms, a garbled r-) -> refused before a room exists
//   - GET /healthz -> 200 for uptime monitors
//
// Run: node e2e/verify-collab-auth.mjs
/* global process, console, setTimeout, fetch */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const here = fileURLToPath(new URL('.', import.meta.url))

const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const port = await freePort()
const dbPath = join(mkdtempSync(join(tmpdir(), 'oip-collab-smoke-')), 'db.sqlite')
const server = spawn(process.execPath, ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 15000)
  server.stdout.on('data', (d) => {
    process.stdout.write(`[server] ${d}`)
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

const url = `ws://localhost:${port}`
const secret = 'e-11111111-2222-3333-4444-555555555555'
const docName = 'r-' + createHash('sha256').update(secret, 'utf8').digest('hex')

const connect = (name, token) => {
  const document = new Y.Doc()
  const provider = new HocuspocusProvider({ url, name, token, document })
  const authed = new Promise((resolve) => provider.on('authenticated', ({ scope }) => resolve(scope ?? 'unknown')))
  const synced = new Promise((resolve) => provider.on('synced', resolve))
  const denied = new Promise((resolve) => provider.on('authenticationFailed', ({ reason }) => resolve(reason)))
  return { document, provider, authed, synced, denied }
}
const timeout = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms))

try {
  // --- 1. editor (holds the secret): must get read-write and its writes must stick
  const editor = connect(docName, secret)
  const editorScope = await editor.authed
  await editor.synced
  check('editor authenticates read-write', editorScope === 'read-write', `scope=${editorScope}`)
  editor.document.getMap('parts').set('p1', 'conveyor')
  await sleep(500)

  // --- 2. viewer (doc name only, dummy token): must get readonly; writes must not propagate
  const viewer = connect(docName, 'view')
  const viewerScope = await viewer.authed
  await viewer.synced
  check('viewer authenticates readonly', viewerScope === 'readonly', `scope=${viewerScope}`)
  await sleep(300)
  check('viewer sees editor content', viewer.document.getMap('parts').get('p1') === 'conveyor')
  viewer.document.getMap('parts').set('hacked', 'yes')
  await sleep(700)
  check('viewer write does NOT reach editor', editor.document.getMap('parts').get('hacked') === undefined)

  // --- 3. stripping ?view === connecting with no token: still readonly
  const stripper = connect(docName, '')
  const stripperScope = await stripper.authed
  check('secret-less connection is readonly', stripperScope === 'readonly', `scope=${stripperScope}`)
  stripper.provider.destroy()

  // --- 4. anything but r-<sha256> is not a room: refused, never authenticated, never created
  const openBefore = (await fetch(`http://localhost:${port}/healthz`).then((r) => r.json())).openDocs
  const refused = []
  for (const [name, token] of [['legacy-room', 'legacy-room'], ['legacy-room', ''], ['r-not-a-hash', 'view']]) {
    const c = connect(name, token)
    const outcome = await Promise.race([c.authed.then(() => 'authenticated'), c.denied.then((reason) => `denied:${reason}`), timeout(5000, 'timeout')])
    refused.push(c)
    check(`'${name}' (token ${token ? `'${token}'` : 'empty'}) is refused`, outcome === 'denied:not-a-room', `outcome=${outcome}`)
    c.document.getMap('parts').set('p9', 'roller')
  }
  await sleep(500)
  const openAfter = (await fetch(`http://localhost:${port}/healthz`).then((r) => r.json())).openDocs
  check('a refused name opens no document on the server', openAfter === openBefore, `${openBefore} -> ${openAfter}`)
  for (const c of refused) c.provider.destroy()

  // --- 5. live share (server/liveRelay.mjs): a run goes only to its followers, the runner is asked for a snapshot when
  // someone follows, and a viewer may follow but never stream
  const heard = []
  const told = []
  viewer.provider.on('stateless', ({ payload }) => heard.push(payload))
  editor.provider.on('stateless', ({ payload }) => told.push(payload))
  editor.provider.sendStateless('live2|a|run-1|')
  editor.provider.sendStateless('live2|d|run-1|RDA=')
  await sleep(400)
  check('a run nobody follows reaches nobody', heard.length === 0, JSON.stringify(heard))
  viewer.provider.sendStateless('live2|f|run-1|')
  await sleep(400)
  check('following a run asks its runner for a snapshot, and tells it one is watching', told.includes('live2|q|run-1|') && told.includes('live2|w|run-1|1'), JSON.stringify(told))
  editor.provider.sendStateless('live2|d|run-1|RDE=')
  editor.provider.sendStateless('live2|s|run-1|U05BUA==')
  editor.provider.sendStateless('live2|d|run-1|RDI=')
  await sleep(400)
  check('the follower starts from the snapshot, then gets each delta', heard.join(' ') === 'live2|s|run-1|U05BUA== live2|d|run-1|RDI=', JSON.stringify(heard))
  const late = connect(docName, 'view')
  const lateHeard = []
  late.provider.on('stateless', ({ payload }) => lateHeard.push(payload))
  await late.synced
  late.provider.sendStateless('live2|f|run-1|')
  await sleep(500)
  check('a viewer following mid-run is caught up from the kept snapshot', lateHeard.join(' ') === 'live2|s|run-1|U05BUA== live2|d|run-1|RDI=', JSON.stringify(lateHeard))
  const closed = new Promise((resolve) => late.provider.on('close', () => resolve(true)))
  late.provider.sendStateless('live1|r|run-1|')
  check("an old build's live message is ignored, not refused", (await Promise.race([closed, timeout(600, false)])) === false)
  late.provider.sendStateless('live2|d|run-1|SEFDSw==')
  const cut = await Promise.race([closed, timeout(3000, false)])
  await sleep(300)
  check('a viewer that tries to stream is cut off, and nothing it sent is relayed', cut === true && heard.length === 2, `closed=${cut}, viewer heard ${heard.length}`)
  late.provider.destroy()

  // --- 6. room owners (server/roomOwners.mjs): the owner's token closes the room; an editor's guess does not
  const replies = []
  editor.provider.on('stateless', ({ payload }) => replies.push(payload))
  editor.provider.sendStateless('room1|claim|o-11111111-2222-3333-4444-555555555555|4242')
  await sleep(400)
  check('the first claim makes this browser the owner', replies.includes('room1|claim|ok'), JSON.stringify(replies))
  check('...and everyone is told who the owner is', heard.includes('live2|o|4242|0'), JSON.stringify(heard.slice(-2)))
  editor.provider.sendStateless('room1|spotlight|o-99999999-8888-7777-6666-555555555555|1')
  await sleep(300)
  check('a spotlight with any other token is refused', replies.includes('room1|spotlight|refused') && !heard.includes('live2|o|4242|1'))
  editor.provider.sendStateless('room1|spotlight|o-11111111-2222-3333-4444-555555555555|1')
  await sleep(300)
  check("the owner's spotlight reaches everyone", heard.includes('live2|o|4242|1'), JSON.stringify(heard.slice(-2)))
  editor.provider.sendStateless('room1|close|o-99999999-8888-7777-6666-555555555555')
  await sleep(400)
  check('a close with any other token is refused, and the room stays open', replies.includes('room1|close|refused') && (await fetch(`http://localhost:${port}/healthz`).then((r) => r.json())).openDocs >= 1)
  const closedViewer = connect(docName, 'view')
  await closedViewer.authed
  editor.provider.sendStateless('room1|close|o-11111111-2222-3333-4444-555555555555')
  await sleep(800)
  check("the owner's token closes it", replies.includes('room1|close|ok'))
  const refusedNow = connect(docName, 'view')
  const after = await Promise.race([refusedNow.authed.then(() => 'authenticated'), refusedNow.denied.then((r) => `denied:${r}`), timeout(5000, 'timeout')])
  check('a closed room refuses its links from then on', after === 'denied:room-closed', after)
  closedViewer.provider.destroy()
  refusedNow.provider.destroy()

  // --- 7. healthz
  const health = await fetch(`http://localhost:${port}/healthz`).then((r) => r.json())
  check('healthz responds ok', health.ok === true && typeof health.openDocs === 'number', JSON.stringify(health))

  editor.provider.destroy()
  viewer.provider.destroy()
} finally {
  server.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
