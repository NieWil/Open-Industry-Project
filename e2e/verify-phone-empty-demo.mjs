// Verifies that a phone which would open on an empty scene opens on the demo instead (src/editor/demo/phoneDemo.ts).
//
// A phone can't author (no catalog, no transform tools, no tour), so an empty scene there is a dead end. The boot
// opens the same ephemeral demo view as the landing CTA instead, with `?scene=demo` in the address bar so
// everything after treats it as that boot.
//
// Asserts three things that can regress independently:
//   - phone, fresh visit: opens the demo session, the param is in the URL, a notice says what this is
//   - phone, reload without the param (what leaving the demo, opening or creating a project does): stays on the
//     empty project; a deliberate choice is never sent back into the demo
//   - desktop, fresh visit: the blank scene (on a desktop the tour handles an empty scene)
// Run: node e2e/verify-phone-empty-demo.mjs
/* global process, console, window, localStorage, location, history */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store), undefined, { timeout: 60000, polling: 250 })
  // a cold vite full-reloads the page as it discovers lazy deps; let it go quiet first
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store), undefined, { timeout: 60000, polling: 250 })
}

const demoSession = (page) => page.evaluate(() => window.__oip.store.getState().demoSession === true)
const sceneParam = (page) => page.evaluate(() => new URLSearchParams(location.search).get('scene'))

async function main() {
  const browser = await chromium.launch({ headless: true })
  const errors = []
  try {
    // ---- phone, fresh visit ----
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
    phone.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
    await phone.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await waitForApp(phone)
    expect(await demoSession(phone), 'a blank phone visit opens the demo')
    expect((await sceneParam(phone)) === 'demo', 'the demo param is in the address bar')
    const notice = await phone.evaluate(() => window.__oip.store.getState().saveNotice)
    expect(!!notice && /example/i.test(notice.title + ' ' + notice.message), 'a notice says this is the example')

    // ---- phone, reload without the param: the leave-demo / open-project path ----
    await phone.evaluate(() => {
      const url = new URL(location.href)
      url.searchParams.delete('scene')
      history.replaceState(history.state, '', url.pathname + url.search + url.hash)
      location.reload()
    })
    await phone.waitForLoadState('domcontentloaded')
    await waitForApp(phone)
    expect(!(await demoSession(phone)), 'a reload into the empty project is respected')
    expect((await sceneParam(phone)) === null, 'no demo param after the reload')
    await phone.close()

    // ---- desktop, fresh visit: unchanged ----
    const desk = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    desk.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
    await desk.addInitScript(() => {
      try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* storage disabled */ }
    })
    await desk.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await waitForApp(desk)
    expect(!(await demoSession(desk)), 'a blank desktop visit stays blank')
    expect((await sceneParam(desk)) === null, 'no demo param on desktop')
    await desk.close()

    expect(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
