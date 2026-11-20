// Proves the desktop shell's one-row chrome: the OS title bar and menu bar are gone, and the app's own
// toolbar does both of their jobs (drag the window, host the window buttons) without swallowing
// its own controls' clicks. Launches the real Electron shell: the assertions are about the window the
// OS actually made, so nothing here can be faked from the page alone.
//
//   node e2e/verify-desktop-titlebar.mjs
//
// The problem it guards: `-webkit-app-region: drag` on the toolbar makes every descendant draggable unless
// it opts out, and a draggable button doesn't receive clicks. It fails silently (the click
// just moves the window), so it needs a machine check, not an eyeball.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { startServer } from './_server.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')
const electronPath = require(join(desktopDir, 'node_modules', 'electron'))

let failed = false
const check = (label, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
}

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-titlebar-'))
let app
try {
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, `--user-data-dir=${profileDir}`],
    env,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.toolbar', { timeout: 60000 })

  // ── 1. the window itself: no frame above the page, no menu bar row ──────────────────────────────
  const win = await app.evaluate(async ({ BrowserWindow, Menu }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const bounds = w.getBounds()
    const content = w.getContentBounds()
    return {
      frameHeight: bounds.height - content.height,
      menuBarVisible: w.isMenuBarVisible(),
      hasAppMenu: Menu.getApplicationMenu() !== null,
    }
  })
  // Windows keeps an invisible ~8px resize border on a hidden-title-bar window; what must be gone is the
  // ~32px caption. So this is a threshold, not a zero.
  check('no OS title bar above the page', win.frameHeight < 24, `frame adds ${win.frameHeight}px`)
  check('menu bar row is gone', win.menuBarVisible === false)
  // hidden, not removed: the menu still owns Ctrl+N/O/S and F5, and the toolbar button pops this object
  check('the application menu still exists', win.hasAppMenu)

  // ── 2. the page picked up the shell chrome ──────────────────────────────────────────────────────
  const ui = await page.evaluate(() => {
    const app = document.querySelector('.app')
    const toolbar = document.querySelector('.toolbar')
    const run = document.querySelector('.toolbar-run .run-button')
    const menuBtn = document.querySelector('.toolbar-menu-btn')
    const region = (el) => (el ? getComputedStyle(el).webkitAppRegion : null)
    const overlay = navigator.windowControlsOverlay
    const rect = overlay?.getTitlebarAreaRect?.()
    return {
      shellClass: app?.className ?? '',
      toolbarRegion: region(toolbar),
      runRegion: region(run),
      menuBtnRegion: region(menuBtn),
      menuBtnLabel: menuBtn?.getAttribute('aria-label') ?? null,
      // any control the opt-out missed - `display: contents` wrappers are the way this goes wrong,
      // since they generate no box and so can't carry the exclusion for the controls inside them
      stillDraggable: [...document.querySelectorAll('.toolbar button, .toolbar a, .toolbar select, .toolbar input')]
        .filter((el) => getComputedStyle(el).webkitAppRegion !== 'no-drag')
        .map((el) => `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`),
      // the project menu: the row's one file control, the same on the desktop as on the web
      projectMenu: document.querySelector('[data-testid="project-menu"]')?.offsetParent != null,
      canPopMenu: typeof window.oipMenu?.showAppMenu === 'function',
      brandTitle: document.querySelector('.toolbar-title') !== null,
      toolbarTop: toolbar?.getBoundingClientRect().top ?? -1,
      overlayVisible: overlay?.visible ?? false,
      // how far the Run/Pause/Stop cluster sits from the window's centre - reserving the caption strip
      // by padding .toolbar (rather than insetting the right-hand group) moves the whole grid's centre
      runOffCentre: (() => {
        const r = document.querySelector('.toolbar-run')?.getBoundingClientRect()
        return r ? Math.round(Math.abs((r.left + r.right) / 2 - window.innerWidth / 2)) : -1
      })(),
      // width the caption buttons took out of the row, per Chromium
      controlsWidth: rect ? Math.round(window.innerWidth - rect.width - rect.x) : -1,
      rightEdge: Math.round(window.innerWidth - (document.querySelector('.toolbar-right')?.getBoundingClientRect().right ?? 0)),
    }
  })
  check('app root is flagged as the desktop shell', ui.shellClass.includes('desktop-shell'), ui.shellClass)
  check('toolbar is the drag region', ui.toolbarRegion === 'drag', String(ui.toolbarRegion))
  check('run buttons opt back out of dragging', ui.runRegion === 'no-drag', String(ui.runRegion))
  check('menu button opts back out of dragging', ui.menuBtnRegion === 'no-drag', String(ui.menuBtnRegion))
  check('menu button is labelled', ui.menuBtnLabel === 'Menu', String(ui.menuBtnLabel))
  check('no toolbar control is left draggable', ui.stillDraggable.length === 0, ui.stillDraggable.join(', '))
  check('the project menu is in the row', ui.projectMenu)
  check('menu button has a channel to the native menu', ui.canPopMenu)
  check('the duplicate app title is gone', ui.brandTitle === false)
  check('toolbar starts at the top of the window', ui.toolbarTop === 0, `top=${ui.toolbarTop}`)

  // ── 3. the window buttons have room: the row ends before them ───────────────────────────────────
  check('window-controls overlay is up', ui.overlayVisible === true)
  check(
    'right-hand controls clear the caption buttons',
    ui.controlsWidth > 0 && ui.rightEdge >= ui.controlsWidth,
    `gap ${ui.rightEdge}px vs controls ${ui.controlsWidth}px`,
  )
  // …and that clearance must not shift the rest of the row: Run/Pause/Stop reads as the
  // centre of the window, so it must stay on the window's midline, not the midline of what's left.
  check('Run cluster stays centred on the window', ui.runOffCentre >= 0 && ui.runOffCentre <= 2, `${ui.runOffCentre}px off centre`)

  // ── 4. a click on a toolbar button still reaches the button ─────────────────────────────────────
  // The regression this guards: with the drag region swallowing it, .click() goes to the window and
  // the sim never starts.
  await page.locator('.toolbar-run .run-button.play').click()
  await page.waitForFunction(() => window.__oip?.store?.getState().running === true, null, { timeout: 20000 }).catch(() => {})
  const running = await page.evaluate(() => window.__oip?.store?.getState().running === true)
  check('Run button still clicks (not swallowed by the drag region)', running)
  await page.locator('.toolbar-run .run-button.stop').click()

  // ── 4b. the Help menu: its button sits in the drag region, its entries hang below it ─────────────
  // Shortcuts, the tour and the GitHub link moved behind one Help button. The button is a toolbar
  // control like Run (a swallowed click would open nothing), and its entries are rendered inside
  // .toolbar too, so they need the same opt-out to act rather than drag.
  await page.locator('.help-button').click()
  const helpOpen = await page
    .waitForSelector('.help-popover', { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  check('Help button opens its menu (not swallowed by the drag region)', helpOpen)
  const helpDraggable = await page.evaluate(() =>
    [...document.querySelectorAll('.help-popover [role="menuitem"]')]
      .filter((el) => getComputedStyle(el).webkitAppRegion !== 'no-drag')
      .map((el) => el.textContent.trim()),
  )
  check('Help menu entries opt out of dragging', helpOpen && helpDraggable.length === 0, helpDraggable.join(', '))
  if (helpOpen) {
    await page.locator('.help-popover [role="menuitem"]', { hasText: /shortcuts/i }).click()
    const shortcuts = await page
      .waitForSelector('.shortcuts-groups', { timeout: 10000 })
      .then(() => true)
      .catch(() => false)
    check('Help → Keyboard Shortcuts opens the reference', shortcuts)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-shortcuts-overlay]', { state: 'detached', timeout: 5000 }).catch(() => {})
  }

  // ── 5. the menu button pops the real application menu ───────────────────────────────────────────
  // The menu bar is hidden, so this button is the only pointer path to File/Edit/Simulation - worth an
  // assertion rather than a code read. Safe unattended because a Windows popup does not hold the main
  // process's message loop (measured: main answers while it is open), so closePopup() can dismiss the
  // menu that nothing here could click away.
  await app.evaluate(({ Menu }) => {
    globalThis.__menuShown = 0
    Menu.getApplicationMenu().on('menu-will-show', () => {
      globalThis.__menuShown++
    })
  })
  await page.locator('.toolbar-menu-btn').click()
  const popped = await Promise.race([
    app.evaluate(({ Menu, BrowserWindow }) => {
      const shown = globalThis.__menuShown
      Menu.getApplicationMenu().closePopup(BrowserWindow.getAllWindows()[0])
      return shown
    }),
    new Promise((r) => setTimeout(() => r(-1), 8000)),
  ])
  check(
    'menu button pops the native application menu',
    popped === 1,
    popped === -1 ? 'main never answered - the popup held the loop' : `menu-will-show fired ${popped}x`,
  )

  // ── 6. the row's file actions really are in the menu ────────────────────────────────────────────
  // New/Open/Save are menu items with accelerators; Demo must be one too, or hiding the toolbar's file
  // group would remove it outright. Driven down the real menu:command channel.
  // What arriving looks like: the demo opens as a preview, which becomes a project of its own only once
  // edited. Opening it reloads the page into ?scene=demo (sceneFile.ts openDemoScene), so the test hook is
  // gone until the new page boots: every read here uses ?. and waits through the reload.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.openDemo')
  })
  const demoOpened = await page
    .waitForFunction(() => window.__oip?.store?.getState().demoSession === true, null, { timeout: 90000, polling: 200 })
    .then(() => true)
    .catch(() => false)
  const projectName = await page.evaluate(() => window.__oip?.store?.getState().projectName)
  check('File → Open Demo shows the demo preview', demoOpened, `project: ${projectName}`)

  // ── 7. a small window: the row must still fit entirely beside the caption buttons ───────────────
  // The reservation only holds while the row's content fits what is left of the width. With New/Save/
  // Load/Demo in the row its natural minimum would be ~987px, so anything under ~1150px would slide the
  // rightmost icons under the window buttons, where the native overlay takes the clicks and the
  // button is dead. Half-screen snapping on a 1920 display gives 960px, so this is a real
  // window size, not an extreme case.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w.isMaximized()) w.unmaximize()
    w.setContentSize(1000, 800)
  })
  await page.waitForTimeout(500)
  const narrow = await page.evaluate(() => {
    const rect = navigator.windowControlsOverlay?.getTitlebarAreaRect?.()
    const captionFrom = rect ? rect.x + rect.width : window.innerWidth
    const bar = document.querySelector('.toolbar')
    return {
      width: window.innerWidth,
      under: [...document.querySelectorAll('.toolbar button, .toolbar a, .toolbar select, .toolbar input')]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().right > captionFrom)
        .map((el) => el.getAttribute('title') || el.textContent.trim() || el.className),
      overflow: bar.scrollWidth - bar.clientWidth,
    }
  })
  check(`no control under the window buttons at ${narrow.width}px`, narrow.under.length === 0, narrow.under.join(' · '))
  check(`row does not overflow at ${narrow.width}px`, narrow.overflow === 0, `${narrow.overflow}px over`)

  // Maximize, and wait until the page has caught up, not a fixed 500 ms. A fixed wait can read the width
  // while the window is still growing, so the shot is a mid-resize frame (a ~1082px layout clipped to 1000,
  // with the run cluster pushed onto Share) that looks like a layout bug and is not one. Settled
  // means: the viewport is the maximized content width and the caption strip has its measured width
  // again, since env(titlebar-area-*) - which the right-hand inset reads - updates on its own event.
  const maxWidth = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w.isMaximized()) {
      await new Promise((resolve) => {
        w.once('maximize', resolve)
        w.maximize()
      })
    }
    return w.getContentBounds().width
  })
  const settled = await page
    .waitForFunction(
      ({ width, controls }) => {
        const rect = navigator.windowControlsOverlay?.getTitlebarAreaRect?.()
        return window.innerWidth === width && !!rect && Math.round(window.innerWidth - rect.width - rect.x) === controls
      },
      { width: maxWidth, controls: ui.controlsWidth },
      { timeout: 10000, polling: 100 },
    )
    .then(() => true)
    .catch(() => false)
  check('the window settles maximized before the shot', settled, `content ${maxWidth}px`)
  // and at rest the run cluster is back on the midline - the state the shot is meant to show
  const restOffCentre = await page.evaluate(() => {
    const r = document.querySelector('.toolbar-run')?.getBoundingClientRect()
    return r ? Math.round(Math.abs((r.left + r.right) / 2 - window.innerWidth / 2)) : -1
  })
  check('Run cluster is centred again once maximized', restOffCentre >= 0 && restOffCentre <= 2, `${restOffCentre}px off centre`)

  // the whole row, full width: the caption buttons are painted by the native overlay and never appear
  // in a page screenshot, so the empty strip at the right is the reservation this gate measured
  const shotWidth = await page.evaluate(() => window.innerWidth)
  await page.screenshot({ path: join(here, 'out', 'desktop-titlebar.png'), clip: { x: 0, y: 0, width: shotWidth, height: 96 } })
  console.log('shot → e2e/out/desktop-titlebar.png')
} catch (err) {
  failed = true
  console.log('FAIL', err?.message || err)
} finally {
  if (app) await app.close().catch(() => {})
  vite.kill()
  rmSync(profileDir, { recursive: true, force: true })
}

console.log(failed ? '\nFAIL' : '\nPASS')
process.exit(failed ? 1 : 0)
