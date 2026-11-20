// Verifies that the app shows which document it opened, and that the name can be changed and persists.
//
// /app/ boots straight into the project autosave (src/editor/main.tsx), so without a visible name a
// returning user has nothing in the window that identifies the document they are in.
//
// The name does not go in the toolbar row: that row is measured to the pixel (verify-toolbar-fit.mjs
// sweeps its heaviest state at 1239px and the ladder already drops the wordmark at 1050 to keep the
// scene picker readable), so a chip there would cost an action button. It goes where it takes no
// width: the window title (the browser tab; the desktop shell hides the OS title bar, so there it is
// the taskbar entry) and the project menu's own label.
//
// Asserted here, in a real browser, because none of it can be checked from a unit test:
//   - a fresh visit names the default project in the title and in the project menu's label
//   - a rename reaches both, immediately
//   - a reload still shows it: rename -> project autosave -> boot -> identity, the whole loop
//   - "Rename Project" is reachable from the command palette, not just present in the registry
//   - the ?scene=demo boot names itself as the built-in example (a project of its own, with no way
//     "back"; leaving it means opening another project), and a rename attempt there cannot fork it into
//     a project (persistProject would stash the demo, so a label change would create a document)
// Run: node e2e/verify-project-identity.mjs
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { openProjectMenu } from './_projectMenu.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

const APP_TITLE = 'Open Industry Project'
const DEMO_SCENE_NAME = 'Palletizing demo' // src/editor/demo/demoScenes.ts

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: 20000 })
}

/** the project menu's own label: the project's name ("Palletizing demo" during the demo, tagged "Example") */
const groupLabel = (page) => page.evaluate(() => document.querySelector('.project-name')?.textContent ?? null)
const documentId = (page) => page.evaluate(() => localStorage.getItem('oip-web/document-id'))

async function freshVisit(page) {
  console.log('--- a fresh visit names the document ---')
  expect((await page.title()) === `Untitled Project - ${APP_TITLE}`, `title names the default project (${await page.title()})`)
  expect((await groupLabel(page)) === 'Untitled Project', 'the project menu is labelled with the project name')
}

async function rename(page) {
  console.log('--- renaming reaches both surfaces ---')
  await page.evaluate(() => window.__oip.store.renameProject('  Line 4 Rebuild  '))
  await page.waitForTimeout(200)
  expect((await page.title()) === `Line 4 Rebuild - ${APP_TITLE}`, `the title follows the rename, trimmed (${await page.title()})`)
  expect((await groupLabel(page)) === 'Line 4 Rebuild', 'the project menu follows the rename')

  // The rename has to be reachable from the UI, not just callable from a test hook. The palette exists on
  // every surface (the File menu only exists in the desktop shell); the project menu has it too.
  await page.keyboard.press('Control+Shift+P')
  await page.waitForSelector('.palette-input', { timeout: 5000 })
  await page.fill('.palette-input', 'rename project')
  await page.waitForTimeout(200)
  const hits = await page.evaluate(() => [...document.querySelectorAll('.palette-item .palette-label')].map((e) => e.textContent.trim()))
  expect(
    hits.some((h) => /Rename Project/i.test(h)),
    `the command palette offers Rename Project (${JSON.stringify(hits.slice(0, 4))})`,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
}

async function survivesReload(page) {
  console.log('--- and it is still there when you come back ---')
  await page.reload()
  await waitForApp(page)
  await page.waitForTimeout(400)
  expect((await page.title()) === `Line 4 Rebuild - ${APP_TITLE}`, `a returning visit is told which document it opened (${await page.title()})`)
  expect((await groupLabel(page)) === 'Line 4 Rebuild', 'the project menu is still labelled with it')
}

async function demoPreview(page) {
  console.log('--- the demo names itself as the example, and a rename cannot fork it ---')
  await page.goto(`http://localhost:${PORT}/app/?scene=demo`)
  await waitForApp(page)
  await page.waitForFunction(() => window.__oip.store.getState().demoSession === true, { timeout: 20000 })
  await page.waitForTimeout(400)
  expect((await page.title()) === `${DEMO_SCENE_NAME} (example) - ${APP_TITLE}`, `the demo says what it is (${await page.title()})`)

  const docBefore = await documentId(page)
  await page.evaluate(() => window.__oip.store.renameProject('Renamed while previewing'))
  await page.waitForTimeout(300)
  expect((await page.title()) === `${DEMO_SCENE_NAME} (example) - ${APP_TITLE}`, 'the rename is refused, so the title does not move')
  expect(await page.evaluate(() => window.__oip.store.getState().demoSession), 'still the example: the rename did not fork it')
  const docAfter = await documentId(page)
  expect(docAfter === docBefore, `no project was minted by a rename (${docBefore} -> ${docAfter})`)
  // The demo is a project of its own, the built-in example: the label names it and is tagged as the example, and
  // the menu has no way "back"; leaving it means opening another project.
  expect((await groupLabel(page)) === DEMO_SCENE_NAME, `the label names the demo (${await groupLabel(page)})`)
  const tag = await page.evaluate(() => document.querySelector('[data-testid="project-tag"]')?.textContent ?? null)
  expect(tag === 'Example', `...tagged as the example (${tag})`)
  await openProjectMenu(page)
  const back = await page.evaluate(() => document.querySelectorAll('[role="menu"] [data-testid="demo-back"]').length)
  expect(back === 0, `the menu has no "Back to" row (${back})`)
  await page.keyboard.press('Escape')
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage - the tour just shows up, harmless here */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`)
    await waitForApp(page)
    await page.waitForTimeout(600)

    await freshVisit(page)
    await rename(page)
    await survivesReload(page)
    await demoPreview(page)
    await page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall project-identity checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
