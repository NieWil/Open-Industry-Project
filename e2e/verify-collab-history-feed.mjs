// End-to-end check: the History dock's shared edit feed across two live collaborators.
//
// Stands up a real Hocuspocus collab server + a dev server and drives two isolated browser
// contexts joined to the same ?room=. Client A (display name "Alice") commits an edit; both
// clients' History panels must show the attributed row - "You" on A, "Alice" on B - live over
// the wire. Then B edits and A sees "Bob". Also asserts room rows are read-only (no jump) and
// that a rapid same-key edit run coalesces into one row instead of spamming the feed.
//
// Run: node e2e/verify-collab-history-feed.mjs [--headed]
/* global process, console, setTimeout */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { editSecret, markSeeder } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- start the collab server on a free port and point the client at it via VITE_COLLAB_URL ---
const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-feed-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
collab.stderr.on('data', (d) => process.stderr.write(`[collab] ${d}`))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    process.stdout.write(`[collab] ${d}`)
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

// --- dev server (inherits VITE_COLLAB_URL) ---
// isolated: VITE_COLLAB_URL is set above and a shared server was started without it (see _server.mjs)
const { url: APP_URL, vite } = await startServer({ isolated: true })
const ROOM = editSecret(`verify-history-feed-${collabPort}`)

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 20000 })
const waitForPeers = (page, n) =>
  page.waitForFunction(
    (min) => {
      const el = document.querySelector('.collab-status.connected')
      // the avatars carry the count in their label (PresenceStack: "2 people here")
      const m = el && (el.querySelector('[data-testid=presence]')?.getAttribute('aria-label') ?? '').match(/(\d+)/)
      return !!m && Number(m[1]) >= min
    },
    n,
    { timeout: 20000 },
  )
/** the visible History rows as [{actor, label, static}] */
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.history-row')].map((r) => ({
      actor: r.querySelector('.history-actor')?.textContent ?? null,
      label: r.querySelector('.history-label')?.textContent ?? '',
      isStatic: r.classList.contains('static'),
    })),
  )
/** commit an add of an opaque movable fixture part (a group; needs no package) */
const commitAdd = (page) =>
  page.evaluate(() => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('Add part', {
      ...s,
      parts: [...s.parts, { id: 'rc_e2e', type: 'group', position: [0, 0.75, 0], rotationY: 0, params: {} }],
    })
  })
/** commit a move of the fixture part through the real commit chokepoint */
const commitMove = (page, x, label, coalesceKey) =>
  page.evaluate(
    ({ x, label, coalesceKey }) => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.commit(
        label,
        { ...s, parts: s.parts.map((p) => (p.id === 'rc_e2e' ? { ...p, position: [x, p.position[1], p.position[2]] } : p)) },
        coalesceKey ? { coalesceKey } : undefined,
      )
    },
    { x, label, coalesceKey },
  )
/** wait until a page's scene has the fixture part at the given x (the scene sync landed) */
const waitForX = (page, x) =>
  page.waitForFunction(
    (x) => window.__oip.store.getState().scene.parts.some((p) => p.id === 'rc_e2e' && p.position[0] === x),
    x,
    { timeout: 15000 },
  )
const waitForRow = (page, label, actor) =>
  page.waitForFunction(
    ({ label, actor }) =>
      [...document.querySelectorAll('.history-row')].some(
        (r) =>
          r.querySelector('.history-label')?.textContent === label &&
          r.querySelector('.history-actor')?.textContent === actor,
      ),
    { label, actor },
    { timeout: 15000 },
  )

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // display names must be set before the room boots (they're read at join); also skip the tour
  await ctxA.addInitScript(() => {
    localStorage.setItem('oip-web/display-name', 'Alice')
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await ctxB.addInitScript(() => {
    localStorage.setItem('oip-web/display-name', 'Bob')
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  for (const [tag, p] of [['A', a], ['B', b]]) {
    p.on('console', (m) => m.type() === 'error' && console.log(`[${tag} console.error] ${m.text()}`))
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))
  }

  // both join the same room (A first, so A's scene seeds it)
  await markSeeder(a, ROOM)
  await a.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(a)
  await b.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(b)
  await waitForPeers(a, 2)
  await waitForPeers(b, 2)
  check('both clients connected and see each other (peers = 2)', true)

  // open the History tab in both
  for (const p of [a, b]) await p.locator('.dock-slot-tab', { hasText: /^History$/ }).click()
  check('History tab opens in a room (no notice, empty feed)', (await rows(a)).length === 0)

  // A authors a part, then moves it → both feeds show the rows, attributed correctly per side
  await commitAdd(a)
  await commitMove(a, 12, 'Move part')
  await waitForRow(a, 'Move part', 'You')
  await waitForRow(b, 'Move part', 'Alice')
  await waitForX(b, 12) // the edit itself (not just its feed row) landed on B
  const bRows = await rows(b)
  check("A's edits reach B attributed to Alice", bRows.some((r) => r.actor === 'Alice' && r.label === 'Move part'))
  check('room rows are read-only (static, no jump)', bRows.length > 0 && bRows.every((r) => r.isStatic))
  check("A sees its own rows as 'You'", (await rows(a)).some((r) => r.actor === 'You' && r.label === 'Move part'))

  // B commits → A sees Bob's row appended after its own
  await commitMove(b, 14, 'Nudge part')
  await waitForRow(a, 'Nudge part', 'Bob')
  const aRows = await rows(a)
  check(
    "B's edit reaches A attributed to Bob, in order",
    aRows.map((r) => r.actor).join(',') === 'You,You,Bob',
    aRows.map((r) => `${r.actor}:${r.label}`).join(' | '),
  )

  // A rapid same-key run (an inspector drag fires commits back-to-back in one JS stream)
  // coalesces into one row on the peer. One evaluate = one stream; three separate evaluate
  // round-trips on a loaded headless page can exceed the 800 ms coalesce window and would
  // test nothing real.
  await a.evaluate(() => {
    const st = window.__oip.store
    for (const x of [15, 16, 17]) {
      const s = st.getState().scene
      st.commit(
        'Edit Length',
        { ...s, parts: s.parts.map((p) => (p.id === 'rc_e2e' ? { ...p, position: [x, p.position[1], p.position[2]] } : p)) },
        { coalesceKey: 'len:e2e' },
      )
    }
  })
  await waitForRow(b, 'Edit Length', 'Alice')
  await b.waitForTimeout(500) // let any (wrong) extra rows arrive before counting
  const lenRows = (await rows(b)).filter((r) => r.label === 'Edit Length')
  check('rapid same-key edits coalesce to one feed row', lenRows.length === 1, `rows=${lenRows.length}`)

  // the part actually moved on B too (the feed rides alongside the scene sync, not instead of it)
  const synced = await waitForX(b, 17).then(() => true).catch(() => false)
  check('the edits themselves synced too', synced)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
}
process.exit(failures ? 1 : 0)
