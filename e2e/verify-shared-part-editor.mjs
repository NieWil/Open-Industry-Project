// Verify the Part Editor and deleting parts in a shared project, with two people in it (collab/bridge.ts keeps the
// room's line in the editor's parked document while the editor shows the part alone).
//
// Against a real collab server, it asserts:
//   - New part opens the Part Editor in a shared project; the room's line is untouched, for the other person too
//   - the new part, and an edit to it made in the editor, reach the other person
//   - the other person's edit to the line made meanwhile lands in the parked line, and is there after Back
//   - Back writes nothing: both people end with the same line, nobody's work lost
//   - ✎ on a catalog card opens the editor in a shared project, and leaves the other person's line alone
//   - deleting the part takes it out of the other person's parts
//
// Run: node e2e/verify-shared-part-editor.mjs [--headed]
/* global process, console, window, localStorage, URL, setTimeout, clearTimeout */
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
  env: { ...process.env, PORT: String(collabPort), DB_PATH: join(tmpdir(), `oip-collab-part-editor-${collabPort}.sqlite`) },
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
const addPart = (page, id, x) =>
  page.evaluate(
    ([pid, px]) => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.commit('Add part', { ...s, parts: [...s.parts, { id: pid, type: 'group', position: [px, 0.75, 0], rotationY: 0, params: {} }] })
    },
    [id, x],
  )
const movePart = (page, id, x) =>
  page.evaluate(
    ([pid, px]) => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.commit('Move', { ...s, parts: s.parts.map((p) => (p.id === pid ? { ...p, position: [px, 0.75, 0] } : p)) })
    },
    [id, x],
  )
/** the line as this person has it: the scene, or the one parked while the Part Editor is open */
const lineOf = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    const scene = s.packageEdit?.document ?? s.scene
    return Object.fromEntries(scene.parts.filter((p) => p.id.startsWith('line_')).map((p) => [p.id, p.position[0]]))
  })
const hasPart = (page, id) => page.evaluate((pid) => window.__oip.store.getState().userPackages.some((p) => p.id === pid), id)

const browser = await chromium.launch({ headless: !HEADED })
const other = await chromium.launch({ headless: !HEADED })
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const a = await ctx.newPage()
  a.on('dialog', (d) => void d.accept())
  await a.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(a)
  await addPart(a, 'line_a', 1)
  await addPart(a, 'line_b', 3)

  // ── A shares, B joins with the edit link ──
  await a.locator('button.share-button').click()
  await a.locator('button.share-option', { hasText: 'Can edit' }).click()
  await a.waitForFunction(() => window.__oip.store.getState().collab, undefined, { timeout: 30000 })
  await a.waitForSelector('.collab-status.connected', { timeout: 30000 })
  await a.keyboard.press('Escape')
  const room = new URL(a.url()).searchParams.get('room')
  const octx = await other.newContext({ viewport: { width: 1400, height: 900 } })
  await octx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const b = await octx.newPage()
  await b.goto(`${APP_URL}?room=${room}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await waitForApp(b)
  await b.waitForFunction(() => window.__oip.store.getState().scene.parts.some((p) => p.id === 'line_b'), undefined, { timeout: 30000 })
  const before = await lineOf(b)

  // ── A: New part opens the Part Editor, in the shared project ──
  const newBtn = a.locator('button.catalog-author', { hasText: 'New part' })
  check('New part is enabled in a shared project', await newBtn.isEnabled())
  await newBtn.click()
  await a.waitForFunction(() => !!window.__oip.store.getState().packageEdit, undefined, { timeout: 15000 }).catch(() => {})
  const session = await a.evaluate(() => ({ open: !!window.__oip.store.getState().packageEdit, id: window.__oip.store.getState().packageEdit?.packageId, parts: window.__oip.store.getState().scene.parts.length }))
  check('...and opens the Part Editor, showing the part alone', session.open && session.parts === 1, JSON.stringify(session))
  await b.waitForTimeout(1500)
  check("the other person's line is untouched", JSON.stringify(await lineOf(b)) === JSON.stringify(before), JSON.stringify(await lineOf(b)))
  check('...and the throwaway part is not in it', !(await b.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => !p.id.startsWith('line_') && p.type !== 'building'))))
  await b.waitForFunction((id) => window.__oip.store.getState().userPackages.some((p) => p.id === id), session.id, { timeout: 15000 }).catch(() => {})
  check('the new part reaches the other person', await hasPart(b, session.id))

  // ── an edit to the part in the editor, and B's edit to the line meanwhile ──
  await a.evaluate((id) => window.__oip.controller.setPartInfo(id, { name: 'Lifter' }), session.id)
  await b.waitForFunction((id) => window.__oip.store.getState().userPackages.find((p) => p.id === id)?.name === 'Lifter', session.id, { timeout: 15000 }).catch(() => {})
  check('an edit made in the Part Editor reaches the other person', (await b.evaluate((id) => window.__oip.store.getState().userPackages.find((p) => p.id === id)?.name, session.id)) === 'Lifter')
  await movePart(b, 'line_b', 7)
  await a.waitForFunction(() => window.__oip.store.getState().packageEdit?.document.parts.find((p) => p.id === 'line_b')?.position[0] === 7, undefined, { timeout: 15000 }).catch(() => {})
  check("the other person's edit lands in the parked line", (await lineOf(a)).line_b === 7, JSON.stringify(await lineOf(a)))
  check('...while the editor still shows the part alone', await a.evaluate(() => !!window.__oip.store.getState().packageEdit && window.__oip.store.getState().scene.parts.length === 1))

  // ── Back ──
  await a.evaluate(() => window.__oip.store.exitPartFocus())
  await a.waitForTimeout(1500)
  const lineA = await lineOf(a)
  const lineB = await lineOf(b)
  check('after Back the line has the edit made meanwhile', lineA.line_b === 7, JSON.stringify(lineA))
  check('...and both people have the same line', JSON.stringify(lineA) === JSON.stringify(lineB), JSON.stringify({ lineA, lineB }))
  check('...with no part lost or added', Object.keys(lineB).sort().join() === 'line_a,line_b')

  // ── B: ✎ on a catalog card ──
  const card = b.locator('.catalog-card-edit').first()
  check('✎ is enabled in a shared project', await card.isEnabled())
  await card.click()
  await b.waitForFunction(() => !!window.__oip.store.getState().packageEdit, undefined, { timeout: 15000 }).catch(() => {})
  check('...and opens the Part Editor', await b.evaluate(() => !!window.__oip.store.getState().packageEdit))
  await movePart(a, 'line_a', 5)
  await a.waitForTimeout(1500)
  check("the editor leaves the other person's line alone", JSON.stringify(await lineOf(a)) === JSON.stringify({ line_a: 5, line_b: 7 }), JSON.stringify(await lineOf(a)))
  await b.evaluate(() => window.__oip.store.exitPartFocus())
  await b.waitForTimeout(1500)
  check('...and after Back it has their edit', (await lineOf(b)).line_a === 5, JSON.stringify(await lineOf(b)))

  // ── deleting the part ──
  check('the part can be deleted in a shared project', await a.evaluate((id) => window.__oip.store.removeUserPackage(id), session.id))
  await b.waitForFunction((id) => !window.__oip.store.getState().userPackages.some((p) => p.id === id), session.id, { timeout: 15000 }).catch(() => {})
  check("...and it leaves the other person's parts", !(await hasPart(b, session.id)))
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
