// Verify a shared project (project/sharedProject.ts): sharing one of the user's projects keeps it their project, as a
// shared document does elsewhere, rather than leaving them in a separate room.
//
// Against a real collab server, it asserts:
//   - Share > Can edit shares a solo project in place; the project menu keeps its name
//   - an edit in the room reaches the project in storage by itself, a moment later
//   - Stop sharing is offered
//   - opening the app again opens the shared project in its room, with the edit
//   - Stop sharing makes it the user's alone: solo, under its name, with everything done while shared, and it stays solo
//   - Stop sharing closes the room: a collaborator in it is sent back and told, and its link no longer opens it; a room
//     that is not one's own project offers no Stop sharing
//
// Run: node e2e/verify-shared-project.mjs [--headed]
/* global process, console, window, document, localStorage, location, URL, setTimeout, clearTimeout */
import { spawn } from 'node:child_process'
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

const collabPort = await freePort()
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: join(tmpdir(), `oip-collab-shared-${collabPort}.sqlite`) },
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
const { url: APP_URL } = await startServer({ isolated: true })

const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), undefined, { timeout: 120000, polling: 500 })
const stored = (page) => page.evaluate(async () => JSON.parse((await window.__oip.savedProject()) ?? 'null'))
const partIds = (project) => (project?.scene?.parts ?? project?.scenes?.[0]?.scene?.parts ?? []).map((p) => p.id)
const menu = (page) => page.locator('.project-menu').first().innerText().catch(() => '')
const addPart = (page, id) =>
  page.evaluate((pid) => {
    const st = window.__oip.store
    const s = st.getState().scene
    st.commit('Add part', { ...s, parts: [...s.parts, { id: pid, type: 'group', position: [Math.random() * 3, 0.75, 0], rotationY: 0, params: {} }] })
  }, id)

const browser = await chromium.launch({ headless: !HEADED })
const other = await chromium.launch({ headless: !HEADED })
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']) // Share's links copy as they share
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  page.on('dialog', (d) => void d.accept())

  // ── a solo project of the user's own ──
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  await page.evaluate(() => window.__oip.store.renameProject('Mine'))
  await addPart(page, 'solo_part')
  await page.evaluate(() => window.__oip.store.flushAutosave())
  check('the solo project is saved', partIds(await stored(page)).includes('solo_part'))

  // ── shared from Share > Can edit, in place ──
  await page.locator('button.share-button').click()
  await page.locator('button.share-option', { hasText: 'Can edit' }).click()
  await page.waitForFunction(() => window.__oip.store.getState().collab, undefined, { timeout: 30000 })
  await page.waitForSelector('.collab-status.connected', { timeout: 30000 })
  const room = new URL(page.url()).searchParams.get('room')
  const status = await page.locator('.share-popover-status').innerText().catch(() => '')
  check('sharing says the project is now shared', /now shared/.test(status), status)
  await page.keyboard.press('Escape')
  const m1 = await menu(page)
  check('the project menu keeps its name', m1.trim() === 'Mine', m1.replace(/\n/g, ' '))

  // ── an edit in the room reaches the project by itself ──
  await addPart(page, 'room_part')
  await page.waitForTimeout(2500) // the write-back trails an edit by a second
  check('an edit in the room reaches the project in storage', partIds(await stored(page)).includes('room_part'))
  const storedName = (await stored(page))?.name
  check('...under the project\'s own name', storedName === 'Mine', storedName)

  await page.locator('button.share-button').click()
  check('Stop sharing is offered', (await page.locator('[data-testid=share-stop-sharing]').count()) === 1)
  await page.keyboard.press('Escape')

  // ── opening the app again opens the shared project in its room ──
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().collab, undefined, { timeout: 30000 }).catch(() => {})
  const reopened = await page.evaluate(() => ({ collab: window.__oip.store.getState().collab, room: new URL(location.href).searchParams.get('room'), parts: window.__oip.store.getState().scene.parts.map((p) => p.id) }))
  check('opening the app again opens the shared project in its room', reopened.collab && reopened.room === room, JSON.stringify({ collab: reopened.collab, sameRoom: reopened.room === room }))
  check('...with what was done while it was shared', reopened.parts.includes('room_part') && reopened.parts.includes('solo_part'))
  // the room carries no tests: the owner keeps the project's, and one added in the room is saved into the project
  const keptTest = await page.evaluate(() => window.__oip.store.saveProjectTest({ name: 'kept', duration: 1, checks: [{ tag: 'Done', at: 0.5, equals: true }] }))
  for (const end = Date.now() + 10000; Date.now() < end && !((await stored(page))?.tests ?? []).some((t) => t.name === 'kept'); await page.waitForTimeout(250));
  check('the owner keeps a test in its room, saved into the project', keptTest && ((await stored(page))?.tests ?? []).some((t) => t.name === 'kept'))

  // ── another project from inside a shared one: New Project leaves it, and Projects brings it back ──
  await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {})
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette-input').fill('New Project')
  await page.keyboard.press('Enter')
  await page.locator('.name-dialog input').fill('Other')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 }).catch(() => {})
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().projectName === 'Other', undefined, { timeout: 30000 }).catch(() => {})
  check('New Project from inside a shared project opens the new one, solo', await page.evaluate(() => !window.__oip.store.getState().collab && window.__oip.store.getState().projectName === 'Other'))
  await page.locator('.project-button').first().click()
  await page.getByText('Projects…', { exact: true }).click()
  const row = page.locator('.projects-name', { hasText: 'Mine' })
  await row.waitFor({ timeout: 15000 })
  check('the Projects list marks the shared project', (await row.locator('.projects-shared').count()) === 1)
  await row.click()
  await page.waitForFunction(() => new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 }).catch(() => {})
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().collab, undefined, { timeout: 30000 }).catch(() => {})
  const back = await page.evaluate(() => ({ collab: window.__oip.store.getState().collab, room: new URL(location.href).searchParams.get('room'), parts: window.__oip.store.getState().scene.parts.map((p) => p.id) }))
  check('opening it from Projects rejoins its room, with its edits', back.collab && back.room === room && back.parts.includes('room_part'), JSON.stringify({ collab: back.collab, sameRoom: back.room === room }))

  // ── a collaborator with the edit link edits it; the owner's project gets that too ──
  const octx = await other.newContext({ viewport: { width: 1200, height: 800 } })
  await octx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const o = await octx.newPage()
  await o.goto(`${APP_URL}?room=${room}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(o)
  await o.waitForFunction(() => window.__oip.store.getState().collab, undefined, { timeout: 30000 })
  await o.waitForTimeout(1500)
  await addPart(o, 'their_part')
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'their_part'), undefined, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(2500)
  check("a collaborator's edit reaches the owner's project", partIds(await stored(page)).includes('their_part'))
  const theirMenu = await o.locator('.project-menu').first().innerText().catch(() => '')
  check("the collaborator sees the owner's project by its name", theirMenu.trim() === 'Mine', theirMenu)
  check('the collaborator sees no Stop sharing: it is not their project', await (async () => {
    await o.locator('button.share-button').click()
    return (await o.locator('[data-testid=share-stop-sharing]').count()) === 0
  })())

  // ── Stop sharing ──
  await page.locator('button.share-button').click()
  await page.locator('[data-testid=share-stop-sharing]').click()
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 })
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'solo_part'), undefined, { timeout: 30000 })
  const solo = await page.evaluate(() => ({ collab: window.__oip.store.getState().collab, name: window.__oip.store.getState().projectName, parts: window.__oip.store.getState().scene.parts.map((p) => p.id) }))
  check('Stop sharing opens the project solo, under its name', !solo.collab && solo.name === 'Mine', JSON.stringify({ collab: solo.collab, name: solo.name }))
  check('...with everything done while it was shared', ['solo_part', 'room_part', 'their_part'].every((id) => solo.parts.includes(id)))
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(page)
  await page.waitForTimeout(1500)
  check('and it stays solo when opened again', !(await page.evaluate(() => window.__oip.store.getState().collab)))
  // Stop sharing closed the room (server/roomOwners.mjs): the collaborator in it is sent back, and told
  await o.waitForFunction(() => !new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 }).catch(() => {})
  await waitForApp(o)
  const told = await o.evaluate(() => ({ room: new URL(location.href).searchParams.get('room'), notice: document.body.innerText }))
  check('a collaborator still in the room is sent back when it closes', told.room === null && !(await o.evaluate(() => window.__oip.store.getState().collab)), JSON.stringify({ room: told.room }))
  check('...and told why', /shared project was closed/.test(told.notice))
  // and the link no longer opens it, not even from the copy this browser cached
  await o.goto(`${APP_URL}?room=${room}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await o.waitForFunction(() => !new URL(location.href).searchParams.has('room'), undefined, { timeout: 30000 }).catch(() => {})
  await waitForApp(o)
  check('the edit link no longer opens the room', !(await o.evaluate(() => window.__oip.store.getState().collab)) && !(await o.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'their_part'))))
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack ?? err}`)
} finally {
  await browser.close()
  await other.close()
  collab.kill()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
