// Verify a lost collab server is explained (components/PresenceStack.tsx): a blip only says "Connecting…", but a
// connection failing for longer says the server cannot be reached, names it, says the changes are kept, and offers
// Retry; once the server is back the tab reconnects and the message goes.
//
// Run: node e2e/verify-collab-offline.mjs [--headed]
/* global process, console, window, localStorage, setTimeout, clearTimeout */
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
const dbPath = join(tmpdir(), `oip-collab-offline-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
/** the collab server, started again on the same port and database to come back */
const startCollab = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.mjs'], {
      cwd: join(here, '..', 'server'),
      env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t)
        resolve(child)
      }
    })
  })
let collab = await startCollab()
const { url: APP_URL } = await startServer({ isolated: true })

const browser = await chromium.launch({ headless: !HEADED })
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  await ctx.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const page = await ctx.newPage()
  await page.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), undefined, { timeout: 120000, polling: 500 })
  await page.locator('button.share-button').click()
  await page.locator('button.share-option', { hasText: 'Can edit' }).click()
  await page.waitForSelector('.collab-status.connected', { timeout: 30000 })
  await page.keyboard.press('Escape')
  check('connected: no offline message', (await page.locator('[data-testid=presence-offline]').count()) === 0)

  // ── the server goes away ──
  collab.kill()
  await page.waitForSelector('.collab-status.connecting', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(2000)
  check('a blip only says Connecting…', (await page.locator('[data-testid=presence-offline]').count()) === 0 && /Connecting/.test((await page.locator('[data-testid=presence]').getAttribute('title')) ?? ''))
  await page.waitForSelector('[data-testid=presence-offline]', { timeout: 15000 }).catch(() => {})
  check('past a blip, the people button says Offline', (await page.locator('[data-testid=presence-offline]').count()) === 1)
  await page.locator('[data-testid=presence]').click()
  const note = await page.locator('.people-offline-note').innerText().catch(() => '')
  check('...and the people list names the server and says the changes are kept, with Retry', note.includes(`localhost:${collabPort}`) && /changes are kept/.test(note) && (await page.locator('[data-testid=presence-retry]').count()) === 1, note.replace(/\n/g, ' '))

  // ── it comes back ──
  collab = await startCollab()
  await page.locator('[data-testid=presence-retry]').click()
  await page.waitForSelector('.collab-status.connected', { timeout: 20000 }).catch(() => {})
  check('Retry reconnects once the server is back, and the message goes', (await page.locator('.collab-status.connected').count()) === 1 && (await page.locator('[data-testid=presence-offline]').count()) === 0)
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack ?? err}`)
} finally {
  await browser.close()
  collab.kill()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
