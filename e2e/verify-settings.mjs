// The Settings dialog (src/editor/components/SettingsOverlay.tsx).
//
// The app carries ~24 stored preferences and twenty-odd URL flags, and without this dialog several
// features are reachable only by typing a flag. So the assertion that matters here is not "a checkbox
// moved" but "the thing it controls reached the screen, from the dialog, and was still there after a
// reload", checked through the Performance read-out, the one live switch in the Graphics group.
// (A line's throughput numbers are the despawner's own read-out, per sink; see examples/parts/despawner.)
//
// The graphics rows fail differently: both are resolved once at module load (a live shadow-map resize
// destroys a texture that recorded WebGPU bundles hold by handle; see render/quality.ts), so a control
// that changed them with no feedback would just appear broken. This checks that the dialog says when
// the change applies, and that the choice is persisted for the next load. For the same reason the
// viewport toolbar has no Graphics popover.
//
// Run: node e2e/verify-settings.mjs
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { url, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const dialogUp = (page, want) =>
  page
    .waitForFunction((w) => !!document.querySelector('[data-shortcuts-overlay]') === w, want, { timeout: 8000, polling: 100 })
    .then(() => true)
    .catch(() => false)

const tabOf = (page) => page.evaluate(() => document.querySelector('[data-shortcuts-overlay]')?.dataset.settingsTab ?? null)

async function open(page) {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => !!document.querySelector('.palette'), { timeout: 8000, polling: 100 })
  await page.locator('.palette-input').fill('settings', { force: true })
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await dialogUp(page, true)
}

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  // the tour captures the keyboard on a fresh profile and would consume the chord (see verify-keymap)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      /* private-mode storage */
    }
  })
  await page.goto(`${url}?scene=demo`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 60000 })

  // ── the two ways to open it, and which tab each opens on ───────────────────────────────────────
  await open(page)
  expect((await tabOf(page)) === 'preferences', 'the Settings command opens on Preferences')
  const groups = await page.locator('.settings-group h3').allInnerTexts()
  expect(groups.length >= 2, `it groups its rows (${groups.join(', ')})`)
  await page.keyboard.press('Escape')
  await dialogUp(page, false)

  await page.keyboard.press('Shift+/')
  expect(await dialogUp(page, true), 'the ? chord still opens the same dialog')
  expect((await tabOf(page)) === 'shortcuts', 'and lands on Keyboard, because ? is a question about the keys')
  expect((await page.locator('.shortcut-row').count()) > 30, 'the keyboard table is intact')
  await page.locator('.settings-tab', { hasText: 'Preferences' }).click({ force: true })
  expect((await tabOf(page)) === 'preferences', 'the tabs switch')

  // ── a live switch: it writes, persists, and reaches the screen ──────────────────────────────────
  expect(!(await page.evaluate(() => window.__oip.store.getState().showStats)), 'baseline: the performance read-out is off')
  await page.locator('.setting-row', { hasText: 'Performance read-out' }).locator('.setting-switch input').click({ force: true })
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__oip.store.getState().showStats), 'the switch turns it on')
  expect((await page.evaluate(() => localStorage.getItem('oip-web/showstats'))) === 'true', 'and persists it')
  await page.keyboard.press('Escape')
  await dialogUp(page, false)

  const statsUp = await page
    .waitForFunction(() => !!document.querySelector('.stats-overlay'), { timeout: 20000, polling: 200 })
    .then(() => true)
    .catch(() => false)
  expect(statsUp, 'the read-out appears in the viewport')
  const statsText = statsUp ? await page.locator('.stats-overlay').innerText() : ''
  expect(/\d/.test(statsText), `and carries live numbers (${JSON.stringify(statsText.replace(/\n/g, ' ').slice(0, 60))})`)

  // ── graphics: persisted, and clear about when it applies ──────────────────────────────────────
  await open(page)
  expect((await page.locator('.settings-note').count()) === 0, 'no reload note before anything changes')
  await page.locator('.setting-row', { hasText: 'Quality' }).locator('.setting-select').selectOption('mobile')
  await page.waitForTimeout(200)
  expect(
    (await page.evaluate(() => localStorage.getItem('oip-web/graphics-tier'))) === 'mobile',
    'the quality choice is persisted for the next load',
  )
  const note = await page.locator('.settings-note').innerText().catch(() => '')
  expect(/next load/i.test(note), `and the dialog says when it applies (${JSON.stringify(note.replace(/\n/g, ' '))})`)
  expect((await page.locator('.settings-note-action').count()) === 1, 'with a way to reload now')

  await page.locator('.setting-row', { hasText: 'Shadow detail' }).locator('.setting-select').selectOption('high')
  await page.waitForTimeout(200)
  expect(
    (await page.evaluate(() => localStorage.getItem('oip-web/shadowquality'))) === 'high',
    'shadow detail persists too - setShadowQualityPref finally has a caller',
  )
  // the renderer: the way to turn off WebGPU on a surface with no address bar to type ?nowebgpu into
  const rendererHint = await page.locator('.setting-row', { hasText: 'Renderer' }).locator('.setting-hint').innerText()
  expect(/this window runs (WebGPU|WebGL)/.test(rendererHint), `the renderer row says what this window runs (${JSON.stringify(rendererHint)})`)
  await page.locator('[data-testid="setting-renderer"]').selectOption('webgl')
  await page.waitForTimeout(200)
  expect((await page.evaluate(() => localStorage.getItem('oip-web/renderer'))) === 'webgl', 'a WebGL-only choice is persisted')

  // putting quality back to Automatic clears the key rather than storing a third state
  await page.locator('.setting-row', { hasText: 'Quality' }).locator('.setting-select').selectOption('auto')
  await page.waitForTimeout(200)
  expect(
    (await page.evaluate(() => localStorage.getItem('oip-web/graphics-tier'))) === null,
    'and Automatic clears the override rather than storing one',
  )

  // ── live editing: the name, and taking back the room-code answers ───────────────────────────────
  expect((await page.locator('[data-testid="setting-forget-trusted"]').count()) === 0, 'with no room-code answers stored, their row is not shown')
  await page.keyboard.press('Escape')
  await dialogUp(page, false)
  await page.evaluate(() => localStorage.setItem('oip-web/trusted-rooms', JSON.stringify(['r-a', 'r-b'])))
  await open(page)
  const nameInput = page.locator('[data-testid="setting-display-name"]')
  await nameInput.fill('Line tester')
  expect((await page.evaluate(() => localStorage.getItem('oip-web/display-name'))) === 'Line tester', 'the name field saves your name')
  expect(await dialogUp(page, true), 'and typing in it leaves the dialog open')
  const trustedRow = page.locator('.setting-row', { hasText: 'allowed to run part code' })
  const trustedHint = await trustedRow.locator('.setting-hint').innerText()
  expect(/^2 shared projects/.test(trustedHint), `the allowed shared projects are counted (${JSON.stringify(trustedHint)})`)
  await page.locator('[data-testid="setting-forget-trusted"]').click({ force: true })
  expect((await page.evaluate(() => localStorage.getItem('oip-web/trusted-rooms'))) === null, 'Forget all clears every Allow')
  expect(await page.locator('[data-testid="setting-forget-trusted"]').isDisabled(), 'and the button greys out with nothing left')
  await page.keyboard.press('Escape')
  await dialogUp(page, false)

  // ── survives a reload ───────────────────────────────────────────────────────────────────────────
  await page.reload()
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: 60000 })
  expect(await page.evaluate(() => window.__oip.store.getState().showStats), 'the read-out preference survives a reload')
  await open(page)
  const shadowAfter = await page.locator('.setting-row', { hasText: 'Shadow detail' }).locator('.setting-select').inputValue()
  expect(shadowAfter === 'high', `and the dialog reopens showing the stored graphics choice (${shadowAfter})`)
  const nameAfter = await page.locator('[data-testid="setting-display-name"]').inputValue()
  expect(nameAfter === 'Line tester', `and your name (${JSON.stringify(nameAfter)})`)
  const rendererAfter = await page.locator('[data-testid="setting-renderer"]').inputValue()
  const rendererHintAfter = await page.locator('.setting-row', { hasText: 'Renderer' }).locator('.setting-hint').innerText()
  expect(rendererAfter === 'webgl' && /runs WebGL/.test(rendererHintAfter), `and the WebGL-only choice, which the reload honoured (${JSON.stringify(rendererHintAfter)})`)
  await page.locator('[data-testid="setting-renderer"]').selectOption('auto')
  await page.waitForTimeout(200)
  expect((await page.evaluate(() => localStorage.getItem('oip-web/renderer'))) === null, 'and Automatic clears it')
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures === 0 ? '\nPASS verify-settings' : `\nFAIL verify-settings (${failures})`)
process.exit(failures === 0 ? 0 : 1)
