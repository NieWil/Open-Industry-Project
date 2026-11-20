// End-to-end check: other people's part code in a room runs sandboxed, and a held room asks before it runs.
//
// A part's behavior is JavaScript, and a room syncs every peer's packages, so joining downloads and runs
// everyone's part code, view-only viewers included. The page and the sim worker run under SES lockdown and
// part code compiles inside a Compartment (docs/part-sandbox.md): in a browser a room's code
// runs by default, sandboxed, with nothing shown; a safe open (`?nocode`, or after an open that never finished)
// holds its code (src/collab/codeTrust.ts) until it is allowed.
//
// Stands up a real Hocuspocus server + a dev server and drives two isolated browser contexts. A (an editor) authors
// a part whose script tries the classic escape - reach the host global, raise a flag there, broadcast on a
// BroadcastChannel that reaches the page from the main thread or the sim worker - and then, escaped or not, shows
// `ran: yes` on its own display plate. That one script tells the two things apart: the plate proves the code ran
// (so a clean flag means the sandbox stopped it, not that nothing evaluated), the flag proves whether it got out.
// B joins by a view link, the case where "anyone who opens the link" is most literal.
//
// Run: node e2e/verify-collab-code-trust.mjs [--headed]
/* global process, console, setTimeout, clearTimeout, URL, window, document, location, BroadcastChannel, localStorage */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { docNameFor, editSecret, markSeeder } from './_collabRoom.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port; the client picks it up via VITE_COLLAB_URL ---
// While someone is editing src/, an HMR reload can land mid-run: then set OIP_COLLAB_PORT, serve a no-watch vite
// with VITE_COLLAB_URL=ws://localhost:$OIP_COLLAB_PORT, and point OIP_SHARED_PORT at it.
const collabPort = Number(process.env.OIP_COLLAB_PORT) || (await freePort())
// per run, not per port: a pinned OIP_COLLAB_PORT would otherwise reopen the last run's room, payload and all
const RUN = `${collabPort}-${Date.now().toString(36)}`
const dbPath = join(tmpdir(), `oip-collab-trust-${RUN}.sqlite`)
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

// isolated: VITE_COLLAB_URL is set above, and a shared server was started without it (see _server.mjs) - unless
// OIP_SHARED_PORT names one started with it (above)
const { url: APP_URL, vite } = await startServer({ isolated: !process.env.OIP_SHARED_PORT })
// A holds the edit secret (and seeds the room, as the tab that minted it); B opens the view link, the derived doc name
const ROOM = editSecret(`verify-code-trust-${RUN}`)
const VIEW = docNameFor(ROOM)

// the classic escape, attempted inside a try so the part still loads when it is stopped, then a broadcast that
// would reach the page from the main thread OR the worker; step() shows on the part's display plate that it ran
const PAYLOAD = [
  'let host = null',
  "try { host = (() => {}).constructor('return this')() } catch (e) {}",
  'if (host) {',
  '  host.__oipRoomPwned = true',
  "  try { new host.BroadcastChannel('oip-room-pwned').postMessage(1) } catch (e) {}",
  '}',
  // a geometry() too, so the main-thread render path has a reason to evaluate it (it may not for a plain rig)
  "definePart({ geometry() { return [] }, step(ctx) { ctx.display('ran', 'yes') } })",
  '',
].join('\n')
const PKG = {
  format: 3,
  id: 'peer.pwn',
  name: 'Innocent Crate',
  params: { size: { type: 'number', default: 0.5 } },
  behavior: PAYLOAD,
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.5, 0.5, 0.5] }, offset: [0, 0.25, 0] }], joints: [] },
}

// A first load is CPU-bound and runs 9-46 s on software WebGL (AGENTS.md), longer on a busy machine: a join or a
// reload gets that long before its absence means anything
const LOAD_MS = 90000
const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), null, { timeout: LOAD_MS, polling: 250 })
const flags = (page) =>
  page.evaluate(() => ({ pwned: window.__oipRoomPwned === true, msgs: window.__pwnedMsgs ?? 0 }))
const promptShown = (page) => page.evaluate(() => !!document.querySelector('[data-testid="room-code-prompt"]'))
const bannerShown = (page) => page.evaluate(() => !!document.querySelector('[data-testid="room-code-banner"]'))
const shownNothing = async (page) => !(await promptShown(page)) && !(await bannerShown(page))
/** run the sim until the part's plate says it ran (or `ms` passes), stop, and report: did it run, did it get out */
async function runAndRead(page, ms = 20000) {
  await page.evaluate(() => window.__oip.controller.run())
  await page
    .waitForFunction(() => window.__oip.controller.displaysOf('pwn_1').ran === 'yes', null, { timeout: ms, polling: 250 })
    .catch(() => {})
  const ran = await page.evaluate(() => window.__oip.controller.displaysOf('pwn_1').ran === 'yes')
  await page.evaluate(() => window.__oip.controller.stop())
  const f = await flags(page)
  return { ran, escaped: f.pwned || f.msgs > 0, ...f }
}
const joined = (page) =>
  page.waitForFunction(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'pwn_1'), null, { timeout: LOAD_MS, polling: 250 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Polled on a timer and clicked from inside the page: a headless WebGL page can paint below 1 fps, and
// Playwright's waitForSelector / click wait on animation frames, so they stall on a node that is plainly visible.
const waitShown = (page, testId, timeout) =>
  page.waitForFunction((id) => !!document.querySelector(`[data-testid="${id}"]`), testId, { timeout, polling: 250 })
const clickIn = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`nothing to click at ${sel}`)
    el.click()
  }, selector)

const browser = await chromium.launch({ headless: !HEADED })
let a = null
let b = null
try {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  for (const ctx of [ctxA, ctxB]) {
    await ctx.addInitScript(() => {
      localStorage.setItem('oip-web/tutorial-done', '1')
      window.__pwnedMsgs = 0
      new BroadcastChannel('oip-room-pwned').onmessage = () => {
        window.__pwnedMsgs++
      }
    })
  }
  a = await ctxA.newPage()
  b = await ctxB.newPage()
  for (const [tag, p] of [['A', a], ['B', b]]) {
    p.on('pageerror', (e) => console.log(`[${tag} pageerror] ${e.message}`))
  }

  // --- A opens the room, authors the part and places one
  await markSeeder(a, ROOM)
  await a.goto(`${APP_URL}?room=${ROOM}`, { timeout: LOAD_MS })
  await waitForApp(a)
  await a.evaluate((pkg) => {
    const store = window.__oip.store
    store.addUserPackage(pkg)
    const part = { id: 'pwn_1', type: 'part', packageId: pkg.id, position: [2, 0, 2], rotationY: 0, params: {} }
    // embedded like a real placement does, or this page's own sim has no package to build the part from
    const scene = store.getState().scene
    store.commit('Add part', { ...scene, parts: [...scene.parts, part], packages: [...(scene.packages ?? []), pkg] })
  }, PKG)
  // A wrote this code, so A runs it, sandboxed like everyone's: the plate proves it ran, the flag that it stayed in
  const authored = await runAndRead(a)
  check("the author's part runs (its plate shows it), so a clean flag below means stopped, not skipped", authored.ran, JSON.stringify(authored))
  check("the author's own page does not let the escape out either (main thread and sim worker)", !authored.escaped, JSON.stringify(authored))
  check('the author is shown nothing about its own code', await shownNothing(a))

  // --- B joins by a view link: the room's code runs, sandboxed, without a question
  await b.goto(`${APP_URL}?room=${VIEW}&view`, { timeout: LOAD_MS })
  await waitForApp(b)
  await joined(b)
  await sleep(1500)
  check('a viewer is not stopped by a question', await shownNothing(b))
  const viewer = await runAndRead(b)
  check("the viewer runs the room's part (its plate shows it)", viewer.ran, JSON.stringify(viewer))
  check('nothing from the room got out on the viewer, main thread or sim worker', !viewer.escaped, JSON.stringify(viewer))

  // --- staying openable when a room's code freezes the page (SES confines code, it cannot stop it spinning) ---
  const reason = (page) => page.evaluate(() => document.querySelector('[data-testid="room-code-reason"]')?.textContent ?? '')
  // 1. the link asks: `&nocode` opens the room with its code held, and asks (worded for the sandbox)
  await b.goto(`${APP_URL}?room=${VIEW}&view&nocode`, { timeout: LOAD_MS })
  await waitForApp(b)
  await joined(b)
  await waitShown(b, 'room-code-prompt', 30000).catch(() => {})
  check('a nocode link holds the room\'s code and says why', (await promptShown(b)) && (await reason(b)).includes('nocode'), (await reason(b)).slice(0, 120))
  const promptText = await b.evaluate(() => document.querySelector('[data-testid="room-code-prompt"]')?.textContent ?? '')
  check('the question names the part and says the code would run in a sandbox', promptText.includes('Innocent Crate') && promptText.includes('sandbox'), promptText.slice(0, 160))
  const heldCode = await b.evaluate(() => window.__oip.getPackage('peer.pwn')?.behavior ?? '')
  check("a held room's registry holds a stand-in, not the author's code", heldCode !== '' && !heldCode.includes('oip-room-pwned'))
  await clickIn(b, '[data-testid="room-code-keep"]')
  const viaLink = await runAndRead(b, 4000)
  check('a nocode open runs none of it', !viaLink.ran && !viaLink.escaped, JSON.stringify(viaLink))
  // Review, then allow: the code runs (sandboxed)
  await clickIn(b, '[data-testid="room-code-banner"] button')
  await waitShown(b, 'room-code-prompt', 5000)
  await clickIn(b, '[data-testid="room-code-allow"]')
  const allowed = await runAndRead(b)
  check('allowing a held room runs its code, still contained', allowed.ran && !allowed.escaped, JSON.stringify(allowed))
  // 2. the last open never finished (what a frozen or crashed tab leaves behind): the next open holds the code
  // planted from a page of the same origin that is not the room: leaving the room normally (pagehide) clears the mark,
  // as intended, so it is set after that leave, as a frozen tab's open would have left it
  await b.goto(new URL('/', APP_URL).href, { timeout: LOAD_MS })
  await b.evaluate((room) => localStorage.setItem('oip-web/room-opening', JSON.stringify({ [room]: 1 })), VIEW) // keyed by doc name (codeTrust.ts)
  await b.goto(`${APP_URL}?room=${VIEW}&view`, { timeout: LOAD_MS })
  await waitForApp(b)
  await joined(b)
  await waitShown(b, 'room-code-prompt', 30000).catch(() => {})
  check('after an open that never finished, the room opens with its code held and says why', (await promptShown(b)) && (await reason(b)).includes('did not finish opening'), (await reason(b)).slice(0, 120))
  await clickIn(b, '[data-testid="room-code-allow"]')
  const recovered = await runAndRead(b)
  check('allowing it from there runs the code, still contained', recovered.ran && !recovered.escaped, JSON.stringify(recovered))
  await b.reload({ timeout: LOAD_MS }) // a normal leave (pagehide) clears the mark
  await waitForApp(b)
  await joined(b)
  await sleep(1500)
  check('an open that finished leaves no mark: the next one asks nothing', await shownNothing(b))

  // the author reopening the room: its own code, remembered by fingerprint, so nothing to say
  await a.reload({ timeout: LOAD_MS })
  await waitForApp(a)
  await joined(a)
  await sleep(1500)
  check("the author reopening the room is shown nothing about its own code", await shownNothing(a))
} catch (e) {
  failures++
  console.log(`FAIL  threw: ${e?.stack ?? e}`)
  for (const [tag, page] of [['A', a], ['B', b]]) {
    if (!page) continue
    // raced against a timer: a page whose main thread is stuck never answers an evaluate
    const state = await Promise.race([
      page.evaluate(() => ({
        url: location.search,
        parts: window.__oip?.store?.getState().scene.parts.map((p) => p.id),
        prompt: !!document.querySelector('[data-testid="room-code-prompt"]'),
        banner: !!document.querySelector('[data-testid="room-code-banner"]'),
      })),
      sleep(60000).then(() => 'no answer in 60 s (main thread stuck)'),
    ]).catch((err) => `unreadable: ${err.message}`)
    console.log(`      ${tag}: ${JSON.stringify(state)}`)
  }
} finally {
  await browser.close().catch(() => {})
  vite.kill()
  // spawned with shell:true, so on Windows collab.kill() reaps only the cmd.exe wrapper and the server keeps its port
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(collab.pid), '/T', '/F'], { stdio: 'ignore' })
  else collab.kill()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
