// Verify Make a Copy (src/editor/project/roomCopy.ts): a shared project's document becomes a project of your own.
//
// The alternative, export, leave, import, doesn't work: import is refused inside a room, and a room's held part
// code exports as stand-ins. This drives the real command through the palette against a real Hocuspocus server
// and asserts what the command promises:
//   - the tab ends up outside the room, on a copy that holds what the room held
//   - the project this browser had before joining is still in the library, untouched
//   - an edit to the copy does not reach the room, and Back returns to the room as it was
//
// Run: node e2e/verify-collab-room-copy.mjs [--headed]
/* global process, console, window, indexedDB, localStorage, URL, setTimeout, clearTimeout */
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

const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-copy-${collabPort}.sqlite`)
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
// an edit secret this tab is marked as having minted, so it seeds the room the way Share would, without the dialog
const ROOM = editSecret(`verify-room-copy-${collabPort}`)

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), undefined, { timeout: 60000, polling: 500 })

/** the library as the shelf holds it: [{name, parts: [ids]}] read straight out of IndexedDB */
const library = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web')
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('docPayload')) return resolve([])
          const all = db.transaction('docPayload').objectStore('docPayload').getAll()
          all.onsuccess = () => {
            resolve(all.result.map((r) => ({ ...r, project: r.project ?? JSON.parse(r.text) })).map((r) => ({ id: r.id, name: r.project.name, parts: (r.project.scene?.parts ?? []).map((p) => p.id) })))
            db.close()
          }
        }
      }),
  )

const fixture = (page) =>
  page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'rc_e2e')?.position[0] ?? null)

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  page.on('dialog', (d) => void d.accept())

  // ── 1. a solo project of this browser's own, filed in the library ──
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  await page.evaluate(() => window.__oip.store.renameProject('Mine'))
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('oip-web')
        req.onerror = () => resolve(false)
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('docIndex')) return resolve(false)
          const all = db.transaction('docIndex').objectStore('docIndex').getAll()
          all.onsuccess = () => resolve(all.result.some((r) => r.name === 'Mine'))
        }
      }),
    undefined,
    { timeout: 15000, polling: 500 },
  )

  // ── 2. join a room and edit it ──
  await markSeeder(page, ROOM)
  await page.goto(`${APP_URL}?room=${ROOM}`, { waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().collab === true, undefined, { timeout: 30000 })
  await page.waitForSelector('.collab-status.connected', { timeout: 20000 })
  await page.evaluate(() => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('Add part', { ...s, parts: [...s.parts, { id: 'rc_e2e', type: 'group', position: [0, 0.75, 0], rotationY: 0, params: {} }] })
  })
  await page.waitForTimeout(1500) // the update's round trip to the server
  const roomUrl = page.url()

  // ── 3. Make a Copy, through the palette ──
  await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {})
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette-input').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('.palette-input').fill('Make a Copy')
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !u.searchParams.has('room'), { timeout: 30000 })
  await waitForApp(page)

  const copy = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { collab: s.collab, readOnly: s.readOnly, name: s.projectName }
  })
  check('the copy opens outside the room', copy.collab === false && !new URL(page.url()).searchParams.has('room'), page.url())
  check('the copy is editable', copy.readOnly === false)
  check('the copy is named as one', /^Copy of /.test(copy.name), copy.name)
  check('the copy holds what the room held', (await fixture(page)) === 0)

  const docs = await library(page)
  const mine = docs.find((d) => d.name === 'Mine')
  check('the library holds the copy AND the project from before the room', docs.length === 2 && !!mine && docs.some((d) => d.name === copy.name), JSON.stringify(docs.map((d) => d.name)))
  check("the project from before the room is untouched", !!mine && !mine.parts.includes('rc_e2e'))

  // ── 4. the copy is its own: an edit stays here ──
  await page.evaluate(() => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('Move', { ...s, parts: s.parts.map((p) => (p.id === 'rc_e2e' ? { ...p, position: [5, p.position[1], p.position[2]] } : p)) })
  })
  check('the copy takes an edit', (await fixture(page)) === 5)
  await page.waitForTimeout(2500) // the library's trailing sync

  // ── 5. Back returns to the room, which the copy's edit never reached ──
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().collab === true, undefined, { timeout: 30000 })
  check('Back returns to the room', page.url() === roomUrl, page.url())
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'rc_e2e'), undefined, { timeout: 20000 })
  check("the room is as it was (the copy's edit did not reach it)", (await fixture(page)) === 0)
  check('the copy kept its edit in the library', (await library(page)).find((d) => d.name === copy.name)?.parts.includes('rc_e2e') === true)
} finally {
  await browser.close()
  vite.kill()
  collab.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
