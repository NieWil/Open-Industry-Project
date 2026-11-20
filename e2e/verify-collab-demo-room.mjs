// Verify that a room shared from the demo shows the current demo, until someone edits it.
//
// The reported bug: "I sent a coworker this link but it loads a very old version of the demo." If Share copies
// whatever the tab shows into the room once, a link made from the demo keeps opening the demo as it was on the
// day it was made. A room shared from the untouched demo holds the demo itself (collab/demoRoom.ts): an editor
// on a build whose demo is newer brings it up to date, and the first edit makes it an ordinary room that
// nothing replaces again.
//
// Against a real Hocuspocus server, this asserts:
//   1. Share from the untouched demo makes a demo room, carrying the demo, without forking the demo into the
//      sharer's own project (flushing an autosave on Share would do that).
//   2. A room an older build shared (planted here: the demo with a different program and fewer parts, written by the
//      same seeding code) opens as the current demo for someone following its edit link.
//   3. Once that person edits it, the next visitor gets their edit, not a fresh demo.
//
// Run: node e2e/verify-collab-demo-room.mjs [--headed]
/* global process, console, window, localStorage, location, URL, setTimeout, clearTimeout */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port; the client picks it up via VITE_COLLAB_URL ---
const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-demo-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

// isolated: VITE_COLLAB_URL is set above and a shared server was started without it (see _server.mjs)
const { url: APP_URL, vite } = await startServer({ isolated: true })

// NB: waitForFunction is (fn, arg, options)
async function waitForApp(page, timeout = 60000) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), undefined, { timeout, polling: 500 })
}

const docOf = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { parts: s.scene.parts.length, program: s.stProgram, collab: s.collab, readOnly: s.readOnly }
  })

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const newContext = () => browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  try {
    // ── 1. Share from the untouched demo ──
    const hostCtx = await newContext()
    const A = await hostCtx.newPage()
    await A.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(A)
    await A.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 5, undefined, { timeout: 30000, polling: 500 })
    const demo = await docOf(A)
    console.log(`the current demo: ${demo.parts} parts, ${demo.program.length} chars of program`)

    await A.locator('button.share-button').click()
    await A.locator('button.share-option', { hasText: 'Can edit' }).click()
    await A.waitForFunction(() => new URL(location.href).searchParams.has('room'), undefined, { timeout: 15000, polling: 500 })
    await waitForApp(A)
    await A.waitForFunction(() => window.__oip.store.getState().collab === true, undefined, { timeout: 15000, polling: 500 })
    await A.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 5, undefined, { timeout: 30000, polling: 500 })
    const shared = await docOf(A)
    check('the shared room holds the demo', shared.parts === demo.parts && shared.program === demo.program, `${shared.parts} parts`)
    const forked = await A.evaluate(async () => (await window.__oip.savedProject()))
    check('sharing the demo did not fork it into the sharer’s own project', forked === null, forked === null ? '' : `${forked.length} chars written`)

    // ── the demo, shared, opens in its room again, so its sharer can always get back to stop sharing it ──
    const sharedRoom = await A.evaluate(() => new URL(location.href).searchParams.get('room'))
    await A.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(A)
    await A.waitForFunction(() => window.__oip.store.getState().collab === true, undefined, { timeout: 30000, polling: 500 }).catch(() => {})
    const again = await A.evaluate(() => ({ collab: window.__oip.store.getState().collab, room: new URL(location.href).searchParams.get('room') }))
    check('opening the demo again opens the room it was shared in', again.collab && again.room === sharedRoom, JSON.stringify({ collab: again.collab, sameRoom: again.room === sharedRoom }))
    A.on('dialog', (d) => void d.accept())
    await A.locator('button.share-button').click()
    await A.locator('[data-testid=share-stop-sharing]').click()
    await A.waitForURL((u) => u.searchParams.get('scene') === 'demo' && !u.searchParams.has('room'), { timeout: 30000 })
    await waitForApp(A)
    await A.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(A)
    const after = await A.evaluate(() => ({ collab: window.__oip.store.getState().collab, room: new URL(location.href).searchParams.get('room') }))
    check('...until it stops sharing: then the demo opens on its own', !after.collab && after.room === null, JSON.stringify(after))
    await hostCtx.close()

    // ── 2. a room an older build shared from its demo ──
    // Planted with the app's own seeding code, imported from the dev server, into a room nobody has opened: the
    // demo with a different program and a third of its parts is what an older build's demo looks like to this one.
    const secret = `e-${randomUUID()}`
    const plantCtx = await newContext()
    const P = await plantCtx.newPage()
    await P.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
    const planted = await P.evaluate(async (room) => {
      const [{ connectRoom }, { resolveRoom }, { syncDemoRoom }, demos, { DEFAULT_SCAN_MS }] = await Promise.all([
        import('/src/collab/provider.ts'),
        import('/src/collab/rooms.ts'),
        import('/src/collab/demoRoom.ts'),
        import('/src/editor/demo/demoScenes.ts'),
        import('/src/editor/program/stProgram.ts'),
      ])
      const { ydoc, whenSynced, serverSynced, provider } = connectRoom(await resolveRoom(room, false))
      await whenSynced
      if (!serverSynced()) return { error: 'the planting client never reached the collab server' }
      const scene = demos.createPlcDemoScene()
      const old = {
        scene: { ...scene, parts: scene.parts.slice(0, Math.ceil(scene.parts.length / 3)) },
        stProgram: `(* the demo, as an older build had it *)\n${demos.DEMO_PROGRAM}`,
        stScanMs: DEFAULT_SCAN_MS,
        controller: demos.DEMO_CONTROLLER,
        simHz: 60,
      }
      const result = syncDemoRoom(ydoc, old, { minted: true, serverSynced: true })
      // let the write reach the server before this page goes away
      await new Promise((r) => setTimeout(r, 1500))
      provider.destroy()
      return { result, parts: old.scene.parts.length }
    }, secret)
    check('planted an older build’s demo room', planted.result === 'seeded', JSON.stringify(planted))
    await plantCtx.close()

    const B = await (await newContext()).newPage()
    await B.goto(`${APP_URL}?scene=demo&room=${secret}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(B, 90000)
    await B.waitForFunction(() => window.__oip.store.getState().collab === true, undefined, { timeout: 30000, polling: 500 })
    const opened = await docOf(B)
    check('the edit link opens the CURRENT demo, not the one the room was shared with', opened.program === demo.program, `${opened.program.slice(0, 50)}...`)
    check('with all of the current demo’s parts', opened.parts === demo.parts, `${opened.parts} of ${demo.parts} (the old one had ${planted.parts})`)
    check('and the person following it can edit', opened.collab && !opened.readOnly)

    // ── 3. edit it: from now on it is theirs ──
    const renamed = await B.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      const target = scene.parts.find((p) => p.type !== 'building')
      store.commit('Rename', { ...scene, parts: scene.parts.map((p) => (p.id === target.id ? { ...p, name: 'Edited in the room' } : p)) })
      return target.id
    })
    await B.waitForTimeout(1500) // the edit reaches the server
    await B.close()

    const C = await (await newContext()).newPage()
    await C.goto(`${APP_URL}?scene=demo&room=${secret}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(C, 90000)
    await C.waitForFunction(() => window.__oip.store.getState().collab === true, undefined, { timeout: 30000, polling: 500 })
    const name = await C.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id)?.name ?? null, renamed)
    check('the next visitor gets the edit, not a fresh demo over it', name === 'Edited in the room', String(name))
  } finally {
    await browser.close()
    vite.kill()
    collab.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  vite.kill()
  collab.kill()
  process.exit(1)
})
