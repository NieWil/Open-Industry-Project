// Save in the browser (src/editor/project/saveProject.ts), in a real browser:
//
//   - Ctrl+S is the app's Save. Unhandled, it reaches the browser's own "Save page as", which saves the
//     app's HTML. It must be prevented (from inside a text field too) and answered with "Saved in this browser" (on the first Save only).
//   - the working copy holds the edit when Save says so
//   - "Download a copy" on that toast downloads the whole project as an .oip (a zip), not one scene
//   - the toolbar's Save is the same Save, not a single-scene download
//   - the palette offers one export, Export Project (.oip); there is no Export Scene (a project holds one scene)
//   - Export Project asks what to leave out when there is something (a test, here), and the file leaves it out
//
// Run: node e2e/verify-browser-save.mjs
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { projectMenuItem } from './_projectMenu.mjs'
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const noticeTitle = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="save-notice"] .part-build-toast-title')?.textContent ?? null)

async function waitForNotice(page, title) {
  await page.waitForFunction(
    (t) => document.querySelector('[data-testid="save-notice"] .part-build-toast-title')?.textContent === t,
    title,
    // headless renders this app at ~2 fps and every task waits behind a frame, so generous, not tight
    { timeout: 60000 },
  )
}


async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage */
      }
      // Runs in the bubble phase on window, so after the app's capture listener: records whether the
      // app kept the browser's own Save dialog out of it.
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && (e.key === 's' || e.key === 'S')) window.__savePrevented = e.defaultPrevented
      })
    })
    await page.goto(`http://localhost:${PORT}/app/`)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: 30000 })
    await page.waitForTimeout(600)

    console.log('--- Ctrl+S saves, in this browser, and says so ---')
    await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      store.commit('Add group', { ...scene, parts: [...scene.parts, { id: 'saved-by-ctrl-s', type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} }] })
    })
    await page.locator('canvas').first().click({ position: { x: 5, y: 5 }, force: true }).catch(() => {})
    await page.keyboard.press('Control+s')
    await waitForNotice(page, 'Saved in this browser')
    expect((await page.evaluate(() => window.__savePrevented)) === true, 'the browser\'s own "Save page as" was prevented')
    expect(
      await page.evaluate(async () => ((await window.__oip.savedProject()) ?? '').includes('saved-by-ctrl-s')),
      'the working copy holds the edit Save confirmed',
    )

    console.log('--- "Download a copy" is the whole project ---')
    const [download] = await Promise.all([
      // the .oip zipper is a lazy chunk: importing it and zipping takes many tasks at headless frame rates
      page.waitForEvent('download', { timeout: 60000 }),
      // a DOM click, not locator.click: Playwright waits two animation frames for "stable", which at
      // headless frame rates outlasts the toast's own auto-dismiss
      page.evaluate(() => document.querySelector('[data-testid="save-notice"] .part-build-toast-action').click()),
    ])
    const name = download.suggestedFilename()
    expect(name.endsWith('.oip'), `it downloads a project file (${name})`)
    const stream = await download.createReadStream()
    const head = await new Promise((resolve) => stream.once('data', (chunk) => resolve(chunk.subarray(0, 2).toString('latin1'))))
    stream.destroy()
    expect(head === 'PK', 'as the zipped project folder')
    expect((await noticeTitle(page)) === null, 'and the toast closes behind it')

    console.log('--- Ctrl+S from inside a text field ---')
    await page.evaluate(() => (window.__savePrevented = undefined))
    await page.evaluate(() => document.querySelector('input[placeholder="Filter parts"]').focus())
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => window.__savePrevented !== undefined, null, { timeout: 10000 }).catch(() => {})
    expect((await page.evaluate(() => window.__savePrevented)) === true, 'the browser dialog is kept out of text fields too')
    await page.waitForTimeout(1000)
    expect((await noticeTitle(page)) === null, 'and a Save after the first says nothing: the project autosaves')
    // leave the field: the palette's Ctrl+Shift+P deliberately does nothing inside a text field
    await page.evaluate(() => document.activeElement?.blur())

    console.log('--- the project menu Save is the same Save ---')
    const save = await projectMenuItem(page, 'file.save')
    expect(((await save.getAttribute('title')) ?? '').includes('Ctrl+S'), `the row names its shortcut (${await save.getAttribute('title')})`)
    let downloaded = false
    page.once('download', () => (downloaded = true))
    await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      store.commit('Add group', { ...scene, parts: [...scene.parts, { id: 'saved-by-menu', type: 'group', position: [0, 0.2, 0], rotationY: 0, params: {} }] })
    })
    await save.click()
    for (const end = Date.now() + 10000; Date.now() < end; await page.waitForTimeout(250)) {
      if (await page.evaluate(async () => ((await window.__oip.savedProject()) ?? '').includes('saved-by-menu'))) break
    }
    expect(await page.evaluate(async () => ((await window.__oip.savedProject()) ?? '').includes('saved-by-menu')), 'it saves the edit')
    await page.waitForTimeout(3000)
    expect(!downloaded, 'and it downloads nothing - a file is Export Project')

    console.log('--- the palette offers one export ---')
    await page.keyboard.press('Control+Shift+P')
    await page.waitForSelector('.palette-input', { timeout: 60000 })
    await page.fill('.palette-input', 'export')
    await page.waitForTimeout(2000)
    const hits = await page.evaluate(() => [...document.querySelectorAll('.palette-item .palette-label')].map((e) => e.textContent.trim()))
    expect(hits.some((h) => /Export Project \(\.oip\)/.test(h)), `Export Project (${JSON.stringify(hits.slice(0, 6))})`)
    expect(!hits.some((h) => /Export Scene/.test(h)), `and no Export Scene (${JSON.stringify(hits.slice(0, 6))})`)
    await page.keyboard.press('Escape')

    console.log('--- Export Project asks what to leave out, and leaves it out ---')
    // a project test: something the scene does not show, so the export asks first
    await page.evaluate(() => window.__oip.store.saveProjectTest({ name: 'runs', duration: 1, checks: [{ always: true, tag: 'Never', equals: false }] }))
    await (await projectMenuItem(page, 'file.exportProject')).click()
    const dialog = page.getByTestId('export-project-dialog')
    await dialog.waitFor({ timeout: 10000 })
    expect(await page.getByTestId('export-tests').isChecked(), 'the test is ticked: a backup is whole unless told otherwise')
    await page.getByTestId('export-tests').uncheck()
    const [oip] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByTestId('export-project-confirm').click()])
    const files = unzipSync(new Uint8Array(readFileSync(await oip.path())))
    const manifest = JSON.parse(strFromU8(files['project.json']))
    expect(oip.suggestedFilename().endsWith('.oip'), `it is an .oip (${oip.suggestedFilename()})`)
    expect(manifest.tests === undefined && !Object.keys(files).some((f) => f.startsWith('tests/')), `and the unticked test is not in it (${Object.keys(files).join(', ')})`)
    expect(typeof manifest.scene === 'string' && files[manifest.scene] !== undefined, 'while the scene is')
    expect((await dialog.count()) === 0, 'the dialog closes on Export')
    expect((await page.evaluate(() => window.__oip.store.getState().testCount)) === 1, "and the project keeps its test: only the file left it out")
    await page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall browser-save checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
