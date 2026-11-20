// A notice toast's copy button puts the toast's title and message on the clipboard, and the Inspector's text
// fields show their whole value on hover.
// Run: node e2e/verify-toast-copy.mjs [--headed]
/* global process, console, window, document, navigator, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const ORIGIN = `http://localhost:${PORT}`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const browser = await chromium.launch({ headless: !HEADED })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
try {
  await page.goto(`${ORIGIN}/app/`)
  const ready = () => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), null, { timeout: 60000 })
  await ready()
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
  await page.reload()
  await ready()

  await page.evaluate(() => navigator.clipboard.writeText('before'))
  await page.evaluate(() => window.__oip.store.showSaveNotice('Saved somewhere', 'The reason, in two\nlines.'))
  const copy = page.locator('[data-testid="save-notice"] [data-testid="toast-copy"]')
  await copy.waitFor({ state: 'visible', timeout: 5000 })
  check('the toast has a copy button', true)
  check('the clipboard is untouched until it is clicked', (await page.evaluate(() => navigator.clipboard.readText())) === 'before')
  await page.bringToFront()
  await copy.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="toast-copy"]')?.title === 'Copied', null, { timeout: 5000 }).catch(() => {})
  // Windows hands the clipboard back with CRLF line ends
  const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
  check('clicking it copies the title and the message', text === 'Saved somewhere\nThe reason, in two\nlines.', JSON.stringify(text))
  check('the button says it copied', (await copy.getAttribute('title')) === 'Copied', await copy.getAttribute('title'))
  check('copying does not dismiss the toast', (await page.locator('[data-testid="save-notice"]').count()) === 1)

  // the Inspector's text field: the input carries its whole value as its tooltip
  const LONG = 'Line 3 infeed, east mezzanine, replaces the unit removed in the spring shutdown'
  const titled = await page.evaluate((name) => {
    const { store, getPackage } = window.__oip
    const pkg = getPackage('oip.roller-conveyor')
    if (!pkg) return 'no roller package'
    const params = {}
    for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
    store.loadScene({ version: store.getState().scene.version, parts: [{ id: 'p1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, name, params }], packages: [pkg] })
    store.select('p1')
    return 'ok'
  }, LONG)
  check('a part with a long name is selected', titled === 'ok', titled)
  await page.waitForFunction((v) => [...document.querySelectorAll('input[type="text"]')].some((i) => i.value === v), LONG, { timeout: 10000 }).catch(() => {})
  const title = await page.evaluate((v) => [...document.querySelectorAll('input[type="text"]')].find((i) => i.value === v)?.title ?? null, LONG)
  check('a text field holding a long value shows all of it on hover', title === LONG, JSON.stringify(title))

  check('no page errors', errors.length === 0, errors[0] ?? '')
} finally {
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
  await browser.close()
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
