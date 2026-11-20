// End-to-end check: the behavior-editor soft lock across two live collaborators.
//
// Stands up a real Hocuspocus collab server + a dev server (both on free ports, wired via
// VITE_COLLAB_URL) and drives two isolated browser contexts joined to the same ?room=. Client A
// opens a custom part's behavior editor (claiming the soft lock); client B then opens the same part
// and must arrive read-only with a "Take over" affordance - not silently co-editing. Then exercises
// Take over (both see the warn banner) and release-on-close (B's banner clears when A closes).
//
// Run: node e2e/verify-collab-soft-lock.mjs [--headed]
/* global process, console, setTimeout */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
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
const dbPath = join(tmpdir(), `oip-collab-verify-${collabPort}.sqlite`)
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
const ROOM = editSecret(`verify-soft-lock-${collabPort}`)

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
// footer Apply button (scoped so it isn't the "Take over" button in the banner)
const applyDisabled = (page) => page.$eval('.behavior-actions .behavior-btn', (el) => el.disabled)
const hasLock = (page) => page.evaluate(() => !!document.querySelector('.behavior-lock'))
const isWarn = (page) => page.evaluate(() => !!document.querySelector('.behavior-lock.behavior-lock-warn'))

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  for (const [tag, p] of [['A', a], ['B', b]]) {
    p.on('console', (m) => m.type() === 'error' && console.log(`[${tag} console.error] ${m.text()}`))
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))
  }

  // both join the same room
  await markSeeder(a, ROOM)
  await a.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(a)
  await b.goto(`${APP_URL}?room=${ROOM}`)
  await waitForApp(b)
  await waitForPeers(a, 2)
  await waitForPeers(b, 2)
  check('both clients connected and see each other (peers = 2)', true)

  const pkgId = await a.evaluate(() => window.__oip.store.getState().bundledPackages[0].id)
  check('a bundled custom-part package is available', !!pkgId, pkgId)

  // A opens the behavior editor → claims the soft lock
  await a.evaluate((id) => window.__oip.store.openBehaviorEditor(id), pkgId)
  await a.waitForSelector('.behavior-dialog', { timeout: 45000 })
  check('A (first opener) is NOT locked', (await hasLock(a)) === false)
  check('A can edit (Apply enabled)', (await applyDisabled(a)) === false)

  // let A's editing-presence propagate to B before B opens, so B's mount sees the holder
  // (awareness is milliseconds on localhost; the generous settle keeps the assertion deterministic)
  await b.waitForTimeout(1500)

  // B opens the same part → should arrive read-only with the lock banner + Take over
  await b.evaluate((id) => window.__oip.store.openBehaviorEditor(id), pkgId)
  await b.waitForSelector('.behavior-dialog', { timeout: 45000 })
  await b.waitForSelector('.behavior-lock', { timeout: 5000 })
  check('B (second opener) shows the lock banner', await hasLock(b))
  check('B banner is read-only style (info, not warn)', (await isWarn(b)) === false)
  check('B Apply is DISABLED (read-only)', (await applyDisabled(b)) === true)
  const takeOverPresent = await b.evaluate(
    () => !!Array.from(document.querySelectorAll('.behavior-lock button')).find((x) => /take over/i.test(x.textContent)),
  )
  check('B offers a "Take over" button', takeOverPresent)

  // B takes over → B becomes editable, banner flips to the warn style (A is still editing)
  await b.evaluate(() =>
    Array.from(document.querySelectorAll('.behavior-lock button')).find((x) => /take over/i.test(x.textContent)).click(),
  )
  await b.waitForFunction(() => !!document.querySelector('.behavior-lock.behavior-lock-warn'), { timeout: 5000 })
  check('after Take over, B banner switches to warn', true)
  check('after Take over, B Apply is ENABLED', (await applyDisabled(b)) === false)

  // A should now also see the warn banner (a second editor appeared)
  await a.waitForFunction(() => !!document.querySelector('.behavior-lock.behavior-lock-warn'), { timeout: 5000 })
  check('A now sees the warn banner (B is also editing)', true)

  // A closes its editor → its lock releases → B's warn banner clears
  await a.evaluate(() => window.__oip.store.closeBehaviorEditor())
  await b.waitForFunction(() => !document.querySelector('.behavior-lock'), { timeout: 5000 })
  check('B banner clears after A closes (soft lock released)', true)
} catch (e) {
  failures++
  console.log(`FAIL  unexpected error: ${e instanceof Error ? e.stack : e}`)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
  try {
    rmSync(dbPath, { force: true })
  } catch {
    /* ignore */
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
