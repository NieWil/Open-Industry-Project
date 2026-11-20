// Main process of the desktop app: loads the oip-web editor in an Electron window and gives it the native
// surfaces the browser lacks (project folders, the parts shelf, file associations, deep links, the native menu,
// the agent door). Physics runs in the renderer as WASM, the same as in the browser.
const { app, BrowserWindow, Menu, dialog, ipcMain: electronIpcMain, nativeTheme, protocol, session, shell, screen } = require('electron')
const { basename, dirname, join, resolve } = require('node:path')
const { existsSync, mkdirSync, realpathSync, writeFileSync, readFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { listWorkspace } = require('./partsWorkspace.cjs')
const { listShelf, readChosenShelf, shelfSignature, writeChosenShelf, writeShelfPart } = require('./partsShelf.cjs')
const { documentFileArg, readDocumentFile } = require('./fileOpen.cjs')
const { applyFolderWrites, folderSignature, hasProjectManifest, readProjectFolder } = require('./projectFolderIo.cjs')
const { createFolderRegistry, samePath } = require('./folderRegistry.cjs')
const { createFolderGrants } = require('./folderGrants.cjs')
const { createEndpointConsent } = require('./endpointConsent.cjs')
const { registerPlcIo } = require('./plcIo.cjs')
const { registerOpcUaIo } = require('./opcUaIo.cjs')
const { registerEipIo, shutdownEip } = require('./eipIo.cjs')
const { registerAdsIo, shutdownAds } = require('./adsIo.cjs')
const { registerOpcUaServer } = require('./opcUaServer.cjs')
const { AgentHost, DEFAULT_PORT: MCP_DEFAULT_PORT, readModel, registerAgentHost, startMcpServer } = require('./mcpServer.cjs')
const { createProjectTools } = require('./agentProjects.cjs')
const { guardIpc, isAppUrl, isTrustedSender, navigateDisposition, openDisposition, originOf } = require('./shellTrust.cjs')
const { APP_URL, registerScheme, serve: serveDistProtocol } = require('./distProtocol.cjs')
const { distIsBuilt } = require('./pagesHost.cjs')
const { doorAtStartup, readDoorSetting, writeDoorSetting } = require('./agentDoorSetting.cjs')
const { setupUpdater } = require('./updater.cjs')
const { SCHEME: LINK_SCHEME, deepLinkFromArgv, isDeepLinkArg, linkUrl, parseDeepLink, roomOf } = require('./deepLink.cjs')

// The shell keeps NO parts of its own. A project's part definitions are its own copies, stored with the project
// - on the desktop in its folder's parts/, which the renderer's folder sync writes and reads back like any other
// project file (src/editor/parts/externalEditor.ts). This side only scans a folder the user picks (to IMPORT its parts
// into the open project) and opens or reveals a part's file. It keeps no live part folders: with a second home for
// parts, a part edited in one project surfaces in another, and load order decides which copy wins.

// The old profile-wide parts folder: read only, to tell the user once what is still in it (parts:legacyParts).
function defaultPartsRoot() {
  return join(app.getPath('userData'), 'custom-parts')
}

// Where the window's app comes from.
//
// A PACKAGED app (an installer's) always serves the build it carries, through its own scheme
// (distProtocol.cjs), and no environment variable can point its window anywhere else: a window here holds
// the preload's folder and socket bridges, so where it loads is not something to leave to whatever
// happens to be in the user's environment.
//
// Unpackaged (this folder, `npm start`) it is a development shell: the running Vite dev server by default
// (run `npm run dev` in the repo root first), or DESKTOP_URL - which every e2e gate sets - or the repo's
// own dist/ through the same scheme as an installed app (OIP_DESKTOP_PROD=1, launch-prod.cmd). We load
// dev by URL, not file://, because the Vite build uses absolute asset paths.
// The desktop shell opens the EDITOR: since the landing/app split, `/` is the marketing page and the
// editor lives at `/app/`. A bare origin (default or DESKTOP_URL) gets /app/ appended - query flags like
// ?webgpu survive - while a DESKTOP_URL with an explicit path (e.g. /app/?scene=demo from the e2e
// harness) is loaded as-is.
function editorUrl(base) {
  try {
    const url = new URL(base)
    if (url.pathname === '/') url.pathname = '/app/'
    return url.toString()
  } catch {
    return base // unparseable override - let loadURL surface the error
  }
}
const packaged = app.isPackaged
const devUrl = packaged ? '' : process.env.DESKTOP_URL || ''
const TARGET_URL = editorUrl(devUrl || 'http://localhost:5173')
const prodMode = packaged || (process.env.OIP_DESKTOP_PROD === '1' && !devUrl)
// The build a prod-mode window serves: the installer's copy (electron-builder `extraResources`), or the
// repo's dist/ for launch-prod.cmd.
const DIST_DIR = packaged ? join(process.resourcesPath, 'dist') : join(__dirname, '..', '..', 'dist')

// Privileged schemes must be declared before the app is ready, so this runs at load in every mode.
registerScheme(protocol)

// Must match electron-builder's `appId` (package.json `build`): Windows groups the taskbar button, pins
// and names toast notifications by it. Packaged only - an AUMID with no installed Start Menu shortcut
// behind it has pinning quirks of its own (docs/desktop-shell.md, Icon).
const APP_ID = 'org.openindustryproject.simulator'
if (packaged && process.platform === 'win32') app.setAppUserModelId(APP_ID)

function prodUrl() {
  if (!distIsBuilt(DIST_DIR)) {
    throw new Error(
      packaged ? `the app's bundled build is missing (${DIST_DIR}) - reinstall` : 'dist/ is not built - run `npm run build` in the repo root',
    )
  }
  serveDistProtocol(protocol, DIST_DIR)
  return APP_URL
}

// One line per launch in <userData>/launch-times.log: seconds since this process started at each
// milestone, so a launch can be judged by number and not by feel. `painted` is the boot skeleton.
const launchMarks = []
function markLaunch(name) {
  launchMarks.push(`${name}=${process.uptime().toFixed(2)}s`)
  if (name !== 'loaded') return
  try {
    const line = `${new Date().toISOString()} ${prodMode ? 'prod' : 'dev'} ${launchMarks.join(' ')}\n`
    writeFileSync(join(app.getPath('userData'), 'launch-times.log'), line, { flag: 'a' })
  } catch {
    /* best-effort */
  }
}

// Window/taskbar/alt-tab icon. Without this Electron uses the icon compiled into electron.exe - the
// Electron atom - so the desktop app announces itself as somebody else's sample app. The .ico carries
// 16/24/32/48/64/128/256, each drawn at size by scripts/gen-desktop-icon.mjs, so Windows picks one per
// surface instead of rescaling a single bitmap (24 is the taskbar at 100% scaling).
// This is the RUNTIME icon only: the icon on the .exe/shortcut, before anything launches, comes from
// packaging (electron-builder et al) and isn't something an unpackaged dev run can set.
const APP_ICON = join(__dirname, 'oip-logo.ico')
// Missing asset → omit the option rather than hand Electron a dead path (which silently yields a
// blank icon on some Windows builds instead of falling back).
const iconOption = existsSync(APP_ICON) ? { icon: APP_ICON } : {}

// Persisted window geometry (un-maximized bounds + maximized flag) so the app reopens where the user
// left it - proper desktop UX for a workspace-heavy editor. Lives next to the custom-parts folder in
// userData. Absence (first run) means "no memory yet" → we maximize to fill the screen.
const WINDOW_STATE_FILE = join(app.getPath('userData'), 'window-state.json')
// Un-maximized fallback size - also the restore size before the user has ever resized the window.
const DEFAULT_BOUNDS = { width: 1600, height: 1000 }

function loadWindowState() {
  try {
    return JSON.parse(readFileSync(WINDOW_STATE_FILE, 'utf8'))
  } catch {
    return null // first run, or a corrupt/hand-deleted file - fall back to first-run behavior
  }
}

// Keep the restore rect on a currently-connected display. If the monitor it was last on is gone (laptop
// undocked), an off-screen window reads as a lost app; snap it back onto the nearest live display instead.
function visibleBounds(bounds) {
  if (!bounds) return DEFAULT_BOUNDS
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const onScreen =
    bounds.x != null &&
    bounds.y != null &&
    bounds.x + width > area.x &&
    bounds.y + height > area.y &&
    bounds.x < area.x + area.width &&
    bounds.y < area.y + area.height
  return onScreen ? { ...bounds, width, height } : { width, height }
}

// ── What a launch looks like before the app exists ────────────────────────────────────────────────
// The window is shown the moment it is created, painted in this colour, and the page fills it in:
// the boot skeleton (app/index.html) lands the app's silhouette from static markup at ~600-700ms,
// React commits the real shell over it, and ViewportLoadingCover holds the viewport until the
// building is textured. Nothing here waits for ready-to-show - showing early is safe precisely
// because backgroundColor paints before any document does, so there is no white flash to hide from.
//
// There is no splash window. launch.cmd polls :5173 and only starts Electron once the dev server
// answers, so there is no server wait to cover. A splash can't be sized to line up with this window
// either: window geometry is not settled that early (a window asked for 1536x864 arrives 1487x840, and
// setBounds converges rather than lands - measured). If this window sits blank too long, get the
// document there sooner rather than putting another window in front of it.
// The page has a light and a dark theme (src/editor/appearance.ts), and every colour main paints is one
// of the page's, so each comes in both. Values = styles.css :root, light-dark(<light>, <dark>).
const SHELL = {
  // popoutBar: the PLC panel's header row (StEditor.tsx headerRow), the row a popped-out window's buttons sit in
  dark: { bg: '#17181b', panel: '#202225', text: '#d7dade', popout: '#1f2023', popoutBar: '#212327' }, // --bg, --panel, --text
  light: { bg: '#ffffff', panel: '#f5f6f7', text: '#212428', popout: '#f7f7f8', popoutBar: '#f4f4f5' },
}
// Which one, before a page has said. The page reports what it resolved on its first paint ('shell:painted')
// and on every change after ('shell:theme'), but a window is on screen ~700 ms before that, so a launch
// starts from what is known without it: an explicit Light or Dark the person picked, remembered from the
// last session in window-state.json, or else the OS's, which is exactly what a page left on 'System'
// resolves to. Only an EXPLICIT choice is remembered, so a 'System' user whose OS flipped between launches
// still starts in the OS's theme rather than in last session's.
let shellTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
let shellChoice = null // 'light' | 'dark' when the page has an explicit choice, null when it follows the OS
function startingTheme(saved) {
  const t = saved && saved.theme
  shellChoice = t === 'light' || t === 'dark' ? t : null
  shellTheme = shellChoice || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
}

// Window-name prefix the renderer stamps on a popped-out panel (see components/PopoutWindow.tsx).
// Matched rather than compared exactly because the suffix identifies WHICH panel popped out.
const POPOUT_FRAME_PREFIX = 'oip-popout'

// A popped-out panel is a PORTAL TARGET, not an app: its window is about:blank, and the React tree,
// the store and every IPC listener it is drawn by live in the window that opened it. So anything main
// sends to "the focused window" - a menu command, its accelerator (F5 Run), a folder
// to open, About - was sent to a page with nobody listening the moment the user's focus was in the
// popup, and silently did nothing. `appWindow` is the window that actually runs the app for a given one.
const popoutOwner = new Map() // popup BrowserWindow id -> the app window that opened it
const popoutByName = new Map() // popup window name (oip-popout-*) -> its BrowserWindow, for its caption strip
function appWindow(focused, fallback) {
  const owner = focused ? popoutOwner.get(focused.id) : undefined
  if (owner && !owner.isDestroyed()) return owner
  return focused || fallback
}

const isMac = process.platform === 'darwin'

// ── One row of chrome ─────────────────────────────────────────────────────────────────────────────
// Windows stacked THREE bars above the scene: OS title bar, menu bar, then the app's own 48px toolbar
// - ~105px spent before a single pixel of viewport, all of it naming an app the taskbar already names.
// `titleBarStyle: 'hidden'` drops the OS bar and `titleBarOverlay` repaints only minimize/maximize/close
// over the app's toolbar, which becomes the drag region (styles.css `.desktop-shell`, which also reserves
// the button strip via env(titlebar-area-*)). The menu bar goes with it - `autoHideMenuBar` keeps Alt as
// the keyboard path and the toolbar's menu button pops the SAME Menu, so there is still one definition.
// Colours have to match `.toolbar`'s --panel/--text or the buttons sit on a patch of the wrong grey.
// macOS is different: the menu belongs to the SCREEN there, not the window, so it keeps the
// system menu bar and only needs the traffic lights floated onto the toolbar - that's `hiddenInset`.
// The strip has TWO right answers, because it outlives the page. Windows paints it the instant the
// window exists - seconds before there is a toolbar under it, and ~700 ms before the renderer paints
// at all (measured) - so a strip fixed to the toolbar's grey spends the whole load as a patch of the
// wrong shade in a corner with nothing around it, which is exactly what it looked like. It starts as
// the colour the FRAME paints instead (backgroundColor, = --bg), leaving an empty window one flat
// shade, and moves to the toolbar's grey when that row becomes the toolbar (preload's 'shell:painted',
// which the boot skeleton satisfies well before React does).
// ONE LESS than the .toolbar grid row (48px in styles.css): the row's 1px border-bottom sits inside those
// 48px (border-box), and the strip paints OVER the page, so a full-height strip cut the separator line
// off where the caption buttons begin.
const TITLE_BAR_HEIGHT = 47
// A function, not a constant: its colours are the starting theme's, settled per window (startingTheme).
const titleBar = () =>
  isMac
    ? { titleBarStyle: 'hiddenInset' }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: SHELL[shellTheme].bg, symbolColor: SHELL[shellTheme].text, height: TITLE_BAR_HEIGHT },
        autoHideMenuBar: true,
      }

/** Repaint the caption strip in the toolbar's grey, in the page's theme, and the frame behind the page
 *  with it (what shows while a window resizes). No-op on macOS, which has no strip to paint. */
function matchTitleBarToPage(win, theme, explicit) {
  if (theme === 'light' || theme === 'dark') {
    shellTheme = theme
    shellChoice = explicit ? theme : null
  }
  if (win.isDestroyed()) return
  const c = SHELL[shellTheme]
  win.setBackgroundColor(c.bg)
  if (isMac) return
  win.setTitleBarOverlay({ color: c.panel, symbolColor: c.text, height: TITLE_BAR_HEIGHT })
}

/** The strip as the page shows the toolbar under it right now (preload.cjs stripColours): dimmed by a
 *  dialog's scrim, or null = the plain toolbar again. The page sends it after every 'shell:theme', so it
 *  always lands on top of matchTitleBarToPage's repaint. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/i
function tintTitleBar(win, color, symbol, popout = false) {
  if (win.isDestroyed() || isMac) return
  const c = SHELL[shellTheme]
  win.setTitleBarOverlay({
    color: HEX_COLOUR.test(color) ? color : popout ? c.popoutBar : c.panel,
    symbolColor: HEX_COLOUR.test(symbol) ? symbol : c.text,
    height: popout ? POPOUT_TITLE_BAR_HEIGHT : TITLE_BAR_HEIGHT,
  })
}

// A popped-out panel gets the same one row of chrome: no OS bar, the buttons painted over the panel's own header
// row, which is the drag region (styles.css `.popout-titlebar`, stamped by PopoutWindow.tsx). Its height is that
// row's, pinned there to this number. The strip's colour is the page's to say: the OPENER reports the header's
// colours (scrim and theme included) on 'shell:popout-strip', so main never has to know what theme the popup is in.
const POPOUT_TITLE_BAR_HEIGHT = 32
const popoutTitleBar = () =>
  isMac
    ? {} // the traffic lights would need room carved out of the header's left end; the system bar stays
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: SHELL[shellTheme].popoutBar, symbolColor: SHELL[shellTheme].text, height: POPOUT_TITLE_BAR_HEIGHT },
      }

// ── Who may talk to main (shellTrust.cjs) ─────────────────────────────────────────────────────────
// The app's origin, known once the URL resolves (prod mode's server picks its port first). Until then
// nothing is trusted, which costs nothing: no page has loaded to ask.
let appOrigin = null
// The webContents of popped-out panels. They are about:blank, so they have no origin of their own to judge.
const popoutContents = new Set()

function isAppContents(wc, url) {
  return isAppUrl(url, appOrigin) || popoutContents.has(wc.id)
}

// Every webContents the app ever creates - the main window, a popped-out panel, anything a page opens -
// gets the same rules, so no window can slip past them by being made a different way.
app.on('web-contents-created', (_event, contents) => {
  // A popped-out panel (Dock menu → "Pop out to a window") arrives as an ordinary window.open. Electron's
  // DEFAULT handler builds that child from the features string alone and does not inherit `icon` from
  // the opener, so only identity/chrome is overridden: size and position must keep coming from the
  // features string, which carries the rect the user last left the window at. Another page of the app
  // opens as itself; a web link goes to the OS browser; anything else opens nowhere.
  contents.setWindowOpenHandler(({ url, frameName }) => {
    switch (openDisposition(url, frameName, appOrigin, POPOUT_FRAME_PREFIX)) {
      case 'popout':
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            ...iconOption,
            ...popoutTitleBar(),
            backgroundColor: SHELL[shellTheme].popout, // the panel's own ground, so there is no flash of the other theme
            autoHideMenuBar: true, // it hosts one panel; the app menu belongs to the main window
          },
        }
      case 'app':
        return { action: 'allow', overrideBrowserWindowOptions: { ...iconOption } }
      case 'external':
        void shell.openExternal(url)
        return { action: 'deny' }
      default:
        return { action: 'deny' }
    }
  })
  // A window never leaves the app: a link that would take it elsewhere opens in the OS browser instead.
  const guardNavigation = (event, url) => {
    // the licenses window's one link: Chromium's own license page, a local file beside the exe
    if (licenseContents.has(contents.id) && url === pathToFileURL(chromiumLicensesFile()).href) return
    const verdict = navigateDisposition(url, appOrigin)
    if (verdict === 'allow') return
    event.preventDefault()
    if (verdict === 'external') void shell.openExternal(url)
  }
  contents.on('will-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

function createWindow(url = TARGET_URL) {
  const saved = loadWindowState()
  startingTheme(saved)
  // a second window opens over the focused one, moved down and across so both title bars show
  const beside = focusedAppWindow()
  const near = beside?.getNormalBounds()
  const win = new BrowserWindow({
    ...visibleBounds(near ? { ...near, x: near.x + 32, y: near.y + 32 } : saved?.bounds),
    ...iconOption,
    ...titleBar(),
    // …only until the geometry below is applied - NOT until ready-to-show. A window shown before
    // maximize() paints once at its restore size and snaps, and there is nothing else to wait for:
    // backgroundColor paints the instant the window exists, so there is no white flash to hide from.
    show: false,
    // What the frame paints until the renderer does - and, through titleBar(), what the caption strip
    // paints too. Same value as --bg and as the boot skeleton's ground, so the window → first paint
    // handoff has no colour step anywhere.
    backgroundColor: SHELL[shellTheme].bg,
    webPreferences: {
      // The renderer stays sandboxed (no Node), reaching the main process only through preload.cjs's
      // explicit `window.oipParts` surface.
      contextIsolation: true,
      nodeIntegration: false,
      // Explicit, not left to Electron's default: the preload needs nothing beyond `electron`'s
      // contextBridge/ipcRenderer, which a sandboxed preload keeps.
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  })

  // ...and remembered, so what the menu sends while that window has the focus reaches THIS one (appWindow)
  win.webContents.on('did-create-window', (child, details) => {
    if (!details.frameName || !details.frameName.startsWith(POPOUT_FRAME_PREFIX)) return
    const id = child.id
    const contentsId = child.webContents.id
    popoutOwner.set(id, win)
    popoutContents.add(contentsId)
    popoutByName.set(details.frameName, child)
    child.once('closed', () => {
      popoutOwner.delete(id)
      popoutContents.delete(contentsId)
      if (popoutByName.get(details.frameName) === child) popoutByName.delete(details.frameName)
    })
  })

  // The toolbar has arrived, so the row the caption buttons sit in stops being the empty frame and
  // starts being .toolbar - repaint the strip to match. Scoped to THIS window's channel, so a popped-out
  // panel (same preload, its own strip on its own channel above) cannot drive it.
  //
  // And ONLY on this signal. ready-to-show looks like a sensible backstop and is a trap: it fires when
  // the RENDERER is ready, which for a window that is already visible is ~1s before the page's first
  // frame - repainting there put the toolbar's grey back on an empty window, every run.
  win.webContents.ipc.on('shell:painted', (_event, theme, explicit) => {
    matchTitleBarToPage(win, theme, explicit)
    if (!launchMarks.some((m) => m.startsWith('painted='))) markLaunch('painted')
  })
  win.webContents.once('did-finish-load', () => markLaunch('loaded'))
  // the person switched Light / Dark in Settings, or the OS flipped under 'System'. The preload only
  // starts reporting once the page has painted (followPageTheme), so the strip is the toolbar's by then.
  win.webContents.ipc.on('shell:theme', (_event, theme, explicit) => matchTitleBarToPage(win, theme, explicit))
  // a dialog's scrim opened or closed over the toolbar: the strip dims with it (tintTitleBar)
  win.webContents.ipc.on('shell:strip', (_event, color, symbol) => tintTitleBar(win, color, symbol))
  // ...and a popped-out panel's, which THIS window reports (components/popoutStrip.ts): the popup is about:blank and
  // the preload never runs there. Only a popup this window opened.
  win.webContents.ipc.on('shell:popout-strip', (_event, name, color, symbol) => {
    const child = popoutByName.get(name)
    if (child && popoutOwner.get(child.id) === win) tintTitleBar(child, color, symbol, true)
  })

  // First run (no memory) → maximize; otherwise restore whatever maximized state the user left. A second window
  // follows the one it opened beside.
  if (beside ? beside.isMaximized() : !saved || saved.maximized) win.maximize()

  // which project this window has: forgotten when its page goes, until the new page reports again
  const contentsId = win.webContents.id
  const forget = () => {
    windowDocs.delete(contentsId)
    windowRoots.delete(contentsId)
  }
  win.webContents.on('did-navigate', forget)
  win.webContents.once('destroyed', () => {
    forget()
    enabledByWindow.delete(contentsId)
  })

  // On screen from ~320ms - a second before the renderer paints, and that is the point: a window IS
  // the "it launched" signal, and the alternative measured as ~700ms of nothing at all. What must not
  // leak is that it is EMPTY until the document lands, which two things cover: titleBar() (an empty
  // window is one flat shade, caption buttons and all) and the boot skeleton, which fills it.
  win.show()
  markLaunch('shown')

  // Persist on close. getNormalBounds() is the UN-maximized rect, so maximizing doesn't overwrite the
  // restore size - using getBounds() here would let the restore size drift to full-screen over time.
  const saveWindowState = () => {
    if (win.isDestroyed()) return
    try {
      writeFileSync(
        WINDOW_STATE_FILE,
        JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized(), ...(shellChoice ? { theme: shellChoice } : {}) }),
      )
    } catch {
      /* best-effort: a failed write just means we forget geometry this once */
    }
  }
  win.on('close', saveWindowState)

  // A fullscreen window has no frame, so the caption buttons go, but Chromium keeps reporting their strip
  // as env(titlebar-area-*) and the toolbar would keep an empty gap for them. The page drops its inset on
  // this instead (preload.cjs, toolbar.css). Covers F11 and the page's own requestFullscreen. Each event
  // sends its own state: on Windows, F11's enter/leave events fire while isFullScreen() still reads the old one.
  const sendFullScreen = (on) => {
    if (!win.isDestroyed()) win.webContents.send('shell:fullscreen', on)
  }
  for (const [ev, on] of [['enter-full-screen', true], ['leave-full-screen', false], ['enter-html-full-screen', true], ['leave-html-full-screen', false]]) {
    win.on(ev, () => sendFullScreen(on))
  }
  win.webContents.on('did-finish-load', () => {
    if (win.isFullScreen()) sendFullScreen(true)
  })

  // `url` may be a promise (a caller resolving where the app is): the window is on screen meanwhile.
  Promise.resolve(url).then(
    (u) => {
      appOrigin = originOf(u)
      return win.loadURL(u)
    },
    (err) => {
      dialog.showErrorBox('Open Industry Project', `Could not serve the built app: ${err.message}`)
      app.quit()
    },
  )
  // win.webContents.openDevTools() // uncomment to debug the renderer
  return win
}

// ── Windows, one project each ─────────────────────────────────────────────────────────────────────
// Each app window has its own project open (docs/desktop-shell.md "Several windows"). Main keeps which document and
// which folder each one has, by webContents id, so a project is never open in two windows: opening it again brings
// its window forward. The page reports its document (window:document) and its folder (project:attach); a reload or
// a closed window forgets both until the page reports again.
const windowDocs = new Map()
const windowRoots = new Map()
/** A document id as the page mints them (src/editor/project/libraryDb.ts mintDocumentId). */
const DOC_ID = /^doc-[a-z0-9-]+$/

// The folder the window that attached last is working in: the dialogs' starting point for a window with no folder.
let projectRoot = null

/** The windows running the app: not a popped-out panel, whose page is its opener's, nor the licenses page. */
function appWindows() {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !popoutOwner.has(w.id) && !licenseContents.has(w.webContents.id))
}

/** The app window focused last, so a request from outside any window (a second launch, an agent) goes to it. */
let lastAppWindow = null

/** The app window that has the focus, or had it last. */
function focusedAppWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  const owner = focused ? appWindow(focused) : null
  if (owner && !owner.isDestroyed() && appWindows().includes(owner)) return owner
  if (lastAppWindow && !lastAppWindow.isDestroyed()) return lastAppWindow
  return appWindows()[0] ?? null
}

/** The window the agent door drives: the one whose page serves the tools now (mcpServer.cjs AgentHost). */
function agentWindow() {
  const id = agentHost.servingId()
  return (id !== null && appWindows().find((w) => w.webContents.id === id)) || focusedAppWindow()
}

function bringForward(win) {
  if (win.isMinimized()) win.restore()
  win.focus()
}

/** The app window with document `docId` open, other than `except`, or null. */
function windowWithDocument(docId, except = null) {
  return appWindows().find((w) => w !== except && windowDocs.get(w.webContents.id) === docId) ?? null
}

/** The app window working in folder `root` (by its folder, or by the document the registry knows it as), or null. */
function windowWithFolder(root, except = null) {
  const byRoot = appWindows().find((w) => w !== except && windowRoots.has(w.webContents.id) && samePath(windowRoots.get(w.webContents.id), root))
  if (byRoot) return byRoot
  const docId = registry.byPath(root)?.docId
  return docId ? windowWithDocument(docId, except) : null
}

/** The folder window `win` works in, else the last one attached. */
function rootOf(win) {
  return (win && windowRoots.get(win.webContents.id)) || projectRoot
}

/** Where the app is served, once the app is ready (whenReady); a new window loads it. */
let appUrl = null

/** Bring forward the window with `docId` open, or open a window on it (libraryDb.pinTabDocument reads `?doc=`). */
async function openDocumentWindow(docId) {
  const holder = windowWithDocument(docId)
  if (holder) {
    bringForward(holder)
    return 'focused'
  }
  const base = await appUrl
  const url = new URL(base)
  url.searchParams.set('doc', docId)
  createWindow(url.toString())
  return 'opened'
}

/**
 * A folder opened from outside the app (a second launch, Open Recent from another window's menu): its window comes
 * forward, or `from` opens it in a window of its own. The page does the opening, since it owns the format
 * (desktopProjectBridge.openFolderInNewWindow).
 */
function openFolderWindow(root, from) {
  const holder = windowWithFolder(root)
  if (holder) return bringForward(holder)
  if (!from || from.isDestroyed()) return
  bringForward(from)
  from.webContents.send('project:openPathInNewWindow', root)
}

// ── Project folders ───────────────────────────────────────────────────────────────────────────────
// On the desktop a project IS a folder (docs/projects.md): the renderer keeps it in step both ways
// (src/editor/project/projectFolderSync.ts), and this side only moves files and remembers which document lives
// in which folder (folderRegistry.cjs). The format and the sync rules stay in src/core, so the shell
// never has a second opinion about either.
const registry = createFolderRegistry(join(app.getPath('userData'), 'project-folders.json'))

// The folders the user has handed the app (folderGrants.cjs): every channel that takes a path from the page
// acts only inside one. Seeded from the registry ONCE, here - after launch the registry can be told any path
// (project:remember), so only what main itself witnesses grants a folder from then on.
const grants = createFolderGrants()
for (const row of registry.list()) grants.grant(row.path)
function refusePath(channel, path) {
  console.warn(`[ipc] ${channel} refused a folder the user has not opened: ${String(path)}`)
}

// Where a project gets its folder when the user has not picked one: a New Project, or an app-only
// project's first edit. OIP_PROJECTS_DIR moves it outright. A profile launched with its own
// --user-data-dir is an ISOLATED one - every e2e gate launches that way, as would a second profile kept
// apart on purpose - so its new projects stay inside it instead of landing in the shared Documents.
function defaultProjectsRoot() {
  if (process.env.OIP_PROJECTS_DIR) return process.env.OIP_PROJECTS_DIR
  if (app.commandLine.hasSwitch('user-data-dir')) return join(app.getPath('userData'), 'Projects')
  return join(app.getPath('documents'), 'Open Industry Project')
}

// The parts shelf (partsShelf.cjs): the folder the user chose, else one beside their projects. "Parts Shelf", not
// "Shelf": projects are made as folders in the same place, so the name says it is not one. An isolated profile (every
// e2e gate) keeps it inside the profile, like its projects; OIP_SHELF_DIR moves it outright.
const SHELF_SETTINGS_FILE = join(app.getPath('userData'), 'parts-shelf.json')
function shelfRoot() {
  if (process.env.OIP_SHELF_DIR) return process.env.OIP_SHELF_DIR
  const chosen = readChosenShelf(SHELF_SETTINGS_FILE)
  if (chosen) return chosen
  if (app.commandLine.hasSwitch('user-data-dir')) return join(app.getPath('userData'), 'Parts Shelf')
  return join(app.getPath('documents'), 'Open Industry Project', 'Parts Shelf')
}

// A folder name Windows, macOS and Linux all accept: no reserved characters, no trailing dot or space,
// none of the DOS device names. The project's own name is kept as-is inside project.json.
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i
function folderNameFor(name) {
  let base = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/, '')
    .trim()
  if (base === '' || RESERVED_NAMES.test(base)) base = 'Untitled Project'
  return base.slice(0, 80)
}

// Make a NEW, empty folder for a project under the default root: "Line A", then "Line A (2)", ...
// Never an existing folder - this is for projects that have no files yet.
function createProjectFolder(name, beside) {
  // Beside a folder the app already works in (the scenes split out of an older project go next to it,
  // src/editor/project/projectSplit.ts), else under the default projects folder. Only beside a GRANTED folder: the
  // renderer names the folder, and a grant is what says this app was given it.
  const root = typeof beside === 'string' && beside !== '' && grants.allows(beside) ? dirname(beside) : defaultProjectsRoot()
  const base = folderNameFor(name)
  try {
    mkdirSync(root, { recursive: true })
    for (let n = 1; n < 1000; n++) {
      const dir = join(root, n === 1 ? base : `${base} (${n})`)
      if (existsSync(dir)) continue
      mkdirSync(dir)
      const made = canonicalRoot(dir)
      grants.grant(made)
      return { root: made }
    }
    return { error: `no free folder name for "${base}" in ${root}` }
  } catch (e) {
    return { error: `couldn't create a project folder in ${root}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// Canonicalize a picked folder (expands Windows 8.3 short names like PROGRA~1). fs.watch reports
// change paths relative to the LONG form, so watching a short-path root garbles every filename and
// the watcher silently drops all events. Best-effort: an unreadable path passes through unchanged.
function canonicalRoot(root) {
  try {
    return realpathSync.native(root)
  } catch {
    return root
  }
}

// Read a folder for the renderer: its project files, plus the document that folder already is (so
// opening it twice opens ONE project). Used by the Open picker, Open Recent, a folder named on the
// command line, and the shelf.
function readProjectAt(root) {
  try {
    const files = readProjectFolder(root)
    const row = registry.byPath(root)
    return { root, files, docId: row ? row.docId : null }
  } catch (e) {
    return { root, files: [], docId: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// File → Open Project Folder…: pick a folder and hand its raw files to the renderer, which reassembles
// + validates them through the one codec (src/core/project/projectFolder.ts). The shell stays format-blind.
async function pickOpenProjectFolder(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Project Folder',
    defaultPath: rootOf(win) || defaultProjectsRoot(),
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const root = canonicalRoot(result.filePaths[0])
  grants.grant(root)
  return readProjectAt(root)
}

// File → Save Project to Folder…: pick (or create) the folder only. The renderer writes it through the
// same guarded path every later save takes, after asking about a project already there.
async function pickSaveProjectFolder(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Save Project to Folder',
    buttonLabel: 'Save Here',
    defaultPath: rootOf(win) || defaultProjectsRoot(),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const root = canonicalRoot(result.filePaths[0])
  grants.grant(root)
  const row = registry.byPath(root)
  return { root, hasProject: hasProjectManifest(root), docId: row ? row.docId : null }
}

// A folder named on the command line (`electron . <folder>`, or a shortcut / "Open with" pointing at
// one), opened once the renderer asks for it. Only a folder that holds a project counts - the app's own
// path is on the command line too.
function projectFolderArg(argv) {
  for (const arg of argv.slice(1)) {
    // a browser link is web input, never a folder: `openindustry:/../<path>` would otherwise resolve to one
    if (typeof arg !== 'string' || arg.startsWith('-') || isDeepLinkArg(arg)) continue
    try {
      if (existsSync(join(arg, 'project.json'))) return canonicalRoot(arg)
    } catch {
      /* not a path */
    }
  }
  return null
}
let pendingOpen = projectFolderArg(process.argv)
if (pendingOpen) grants.grant(pendingOpen)
// A project or part FILE the app was launched to open (a double-click on a .oip / .oippart, "Open with", or macOS's
// open-file before the window exists), handed to the renderer as bytes once it asks (fileOpen.cjs). No grant: the
// renderer never learns the path, so the folder the file sat in stays out of its reach.
// Every file waits here until the renderer takes it. Sending the bytes outright lost a file opened while the renderer
// was still starting (its listener connects only once the editor exists), with no word to the person.
const pendingFiles = []
const launchFile = documentFileArg(process.argv)
if (launchFile) pendingFiles.push(launchFile)

/** Keep a project or part file for the window, bring the window forward, and tell it a file is waiting. */
function openDocumentFile(path) {
  pendingFiles.push(path)
  const win = focusedAppWindow()
  if (!win || win.isDestroyed()) return
  bringForward(win)
  if (!win.webContents.isLoading()) win.webContents.send('file:pending')
}

// Pick a folder of parts and scan it (null if cancelled), for the renderer to IMPORT into the open project's parts
// (src/editor/parts/packageSource.ts, Import part > A folder of parts…). Read once: the folder is a source, not a live
// second home for those parts.
async function pickWorkspace(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Import Parts from Folder',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const root = canonicalRoot(result.filePaths[0])
  return { root, ...listWorkspace(root) }
}

// A part folder's editable script. Mirrors partsWorkspace.cjs, which reads behavior.js from each folder.
function behaviorPath(dir) {
  return join(dir, 'behavior.js')
}

// Resolve the editor command to launch. Precedence is deliberate:
//   1. $OIP_EDITOR - our OWN explicit override; nothing else sets it, so it's trustworthy.
//   2. a detected VS Code (absolute code.cmd) - the project's editor and this feature's intent.
//   3. $VISUAL / $EDITOR - generic fallbacks, but ONLY after VS Code, because they get polluted: running
//      under `npm start` injects npm's `editor` config (default C:\Windows\notepad.exe on Windows) as
//      $EDITOR, which would send every launch to Notepad.
//   4. bare `code` on PATH.
// We resolve VS Code by absolute path rather than trusting PATH because Electron's inherited PATH varies
// with how the app was started (a bash launcher leaves a POSIX-format PATH cmd.exe can't read; launchers
// reshape it), which would silently drop us to the OS default app (Notepad for .js).
function resolveEditor() {
  if (process.env.OIP_EDITOR) return process.env.OIP_EDITOR
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
    for (const root of roots) {
      const cmd = join(root, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') // user install (LOCALAPPDATA)
      if (existsSync(cmd)) return cmd
      const sys = join(root, 'Microsoft VS Code', 'bin', 'code.cmd') // system install (Program Files)
      if (existsSync(sys)) return sys
    }
  }
  return process.env.VISUAL || process.env.EDITOR || 'code'
}

// Characters a path may not carry through cmd.exe: a quote ends the quoting, and %VAR% expands even inside it.
// (A quote cannot occur in a Windows path at all, so this refuses nothing real.)
const UNSAFE_FOR_CMD = /["%\r\n]/

// Start `editor` on `file` without ever pasting the path into a command line a shell parses: the path comes from
// the page (parts:openScript), and a page can run room code. POSIX hands the file over as a positional argument
// (the editor string may still carry its own flags, e.g. `code --wait`); Windows needs cmd.exe for a .cmd shim, so
// it refuses any path that could break out of the quotes. detached + unref so the editor outlives this process.
function launchEditor(editor, file) {
  if (process.platform !== 'win32') {
    return spawn('/bin/sh', ['-c', 'exec $OIP_RESOLVED_EDITOR "$1"', 'sh', file], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, OIP_RESOLVED_EDITOR: editor },
    })
  }
  if (/\.exe$/i.test(editor) && existsSync(editor)) return spawn(editor, [file], { detached: true, stdio: 'ignore' })
  if (UNSAFE_FOR_CMD.test(editor) || UNSAFE_FOR_CMD.test(file)) throw new Error('refusing a path the command shell could misread')
  // shell:true so a bare command (`code` shim, `subl`, ...) resolves on PATH and a .cmd shim runs at all; both are
  // quoted because a resolved absolute path contains spaces ("...\Microsoft VS Code\bin\code.cmd").
  return spawn(`"${editor}" "${file}"`, { detached: true, stdio: 'ignore', shell: true })
}

// Open a part's behavior script for editing - the desktop equivalent of "open in external editor".
// Uses resolveEditor(); if that launch fails it REVEALS the file in the file manager instead. Never the OS
// default app: on Windows the default for a .js file is Windows Script Host, which RUNS it. Returns ''
// immediately (fire-and-forget) or a short error string the renderer can surface.
async function openScript(dir) {
  if (!dir) return 'no part folder'
  const file = behaviorPath(dir)
  const editor = resolveEditor()
  const reveal = (why) => {
    console.error(`[oip] ${why}; revealing the script instead`)
    shell.showItemInFolder(file)
  }
  try {
    const child = launchEditor(editor, file)
    // If the editor command isn't found the shell exits non-zero almost immediately. With resolveEditor()
    // returning a verified absolute code.cmd this won't fire for VS Code (it exits 0 whether VS Code was cold or
    // already running); it only guards the bare-`code` fallback.
    child.on('exit', (code) => {
      if (code) reveal(`editor exited ${code} (not found?)`)
    })
    child.on('error', (e) => reveal(`editor launch error: ${e.message}`))
    child.unref()
    return ''
  } catch (e) {
    shell.showItemInFolder(file)
    return `couldn't start an editor (${e instanceof Error ? e.message : String(e)}); the script is shown in its folder`
  }
}

// Record a document's folder, and rebuild the menu when Open Recent would read differently. Most calls
// are the sync's baseline updates (several a minute while editing), which change nothing the menu shows.
function rememberFolder(event, docId, patch) {
  // the registry seeds the folder grants at the next launch, so it may only learn folders already granted
  if (patch && typeof patch.path === 'string' && !grants.allows(patch.path)) {
    refusePath('project:remember', patch.path)
    const { path: _refused, ...rest } = patch
    patch = rest
  }
  const before = registry.recall(docId)
  const listed = (r) => (r ? `${r.path || ''}|${r.name || ''}|${r.openedAt || 0}` : '')
  const was = listed(before)
  registry.remember(docId, patch || {})
  if (listed(registry.recall(docId)) !== was) refreshMenu(BrowserWindow.fromWebContents(event.sender))
}

function registerIpc() {
  // Every channel below, and every registrar's, goes through this: only the app's own top frame is heard.
  const ipcMain = guardIpc(
    electronIpcMain,
    (event) => isTrustedSender(event, appOrigin),
    (channel, event) => console.warn(`[ipc] refused ${channel} from ${event.senderFrame?.url ?? 'a gone frame'}`),
  )
  ipcMain.handle('parts:pickFolder', (event) => pickWorkspace(BrowserWindow.fromWebContents(event.sender)))
  // The parts sitting in the old profile-wide folder (defaultPartsRoot), names only, so the renderer can say once
  // where they are and how to import them into a project.
  ipcMain.handle('parts:legacyParts', () => {
    const root = defaultPartsRoot()
    if (!existsSync(root)) return { root, names: [] }
    return { root, names: listWorkspace(root).parts.map((p) => p.name) }
  })
  // The project as a folder on disk: pickers, then the plain moves the renderer's sync makes - read,
  // fingerprint, guarded writes. The sync decides WHAT to move (src/core/project/folderSync.ts); this only moves it.
  ipcMain.handle('project:pickOpenFolder', (event) => pickOpenProjectFolder(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('project:pickSaveFolder', (event) => pickSaveProjectFolder(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('project:readAt', (_event, root) => {
    if (typeof root !== 'string' || root === '') return null
    if (!grants.allows(root)) {
      refusePath('project:readAt', root)
      return { root, files: [], docId: null, error: 'this folder has not been opened in the app' }
    }
    return readProjectAt(root)
  })
  ipcMain.handle('project:signature', (_event, root) => {
    if (!grants.allows(root)) return { error: 'this folder has not been opened in the app' }
    try {
      return { signature: folderSignature(root) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  const grantedWrites = (channel, root, ops) => {
    if (grants.allows(root)) return applyFolderWrites(root, ops)
    refusePath(channel, root)
    return { moved: [], failed: Array.isArray(ops) ? ops.map((op) => String(op && op.path)) : [], error: 'this folder has not been opened in the app' }
  }
  ipcMain.handle('project:write', (_event, root, ops) => grantedWrites('project:write', root, ops))
  // Synchronous twin for the window's LAST write: an async invoke started from an unloading page may
  // never be answered, and the edit it carries would reach the folder only on the next launch.
  ipcMain.on('project:writeSync', (event, root, ops) => {
    event.returnValue = grantedWrites('project:writeSync', root, ops)
  })
  ipcMain.handle('project:createFolder', (_event, name, beside) => createProjectFolder(name, beside))
  // The project folder the window is now working in: remember it as the pickers' starting point. (Its parts/ is
  // the folder sync's to read and write - the shell watches nothing of its own.)
  ipcMain.on('project:attach', (event, root) => {
    if (typeof root !== 'string' || root === '') return
    if (!grants.allows(root)) return refusePath('project:attach', root)
    projectRoot = root
    windowRoots.set(event.sender.id, root)
  })
  // Several windows, one project each (windowDocs above). The page reports which document it has open, and asks
  // for a document's window (brought forward, or opened) or a folder's (brought forward only).
  ipcMain.on('window:document', (event, docId) => {
    if (typeof docId === 'string' && DOC_ID.test(docId)) windowDocs.set(event.sender.id, docId)
    else windowDocs.delete(event.sender.id)
  })
  ipcMain.handle('window:openDocument', (_event, docId) => {
    if (typeof docId !== 'string' || !DOC_ID.test(docId)) return 'refused'
    return openDocumentWindow(docId)
  })
  ipcMain.handle('window:focusFolder', (event, root) => {
    if (typeof root !== 'string' || root === '') return false
    const holder = windowWithFolder(root, BrowserWindow.fromWebContents(event.sender))
    if (holder) bringForward(holder)
    return holder !== null
  })
  ipcMain.handle('project:reveal', (_event, root) => {
    if (typeof root !== 'string' || root === '') return 'no folder'
    if (!grants.allows(root)) return 'this folder has not been opened in the app'
    shell.showItemInFolder(join(root, 'project.json'))
    return ''
  })
  // Which document lives in which folder (folderRegistry.cjs). The changes that move Open Recent rebuild
  // the menu.
  ipcMain.handle('project:recall', (_event, docId) => registry.recall(docId))
  ipcMain.handle('project:folders', () => registry.list())
  ipcMain.handle('project:remember', (event, docId, patch) => {
    rememberFolder(event, docId, patch)
  })
  ipcMain.on('project:rememberSync', (event, docId, patch) => {
    rememberFolder(event, docId, patch)
    event.returnValue = true
  })
  ipcMain.handle('project:detach', (event, docId) => {
    registry.detach(docId)
    refreshMenu(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.handle('project:forget', (event, docId) => {
    registry.forget(docId)
    refreshMenu(BrowserWindow.fromWebContents(event.sender))
  })
  // A folder named on the command line at launch, handed over once (see projectFolderArg).
  ipcMain.handle('project:takePendingOpen', () => {
    const root = pendingOpen
    pendingOpen = null
    return root
  })
  // The next project or part file waiting to be opened, as bytes (fileOpen.cjs), or null. Each is handed over once.
  ipcMain.handle('file:takePendingOpen', () => {
    const path = pendingFiles.shift()
    return path ? readDocumentFile(path) : null
  })
  // Edit / reveal a custom part's behavior script from the editor UI (Inspector buttons).
  ipcMain.handle('parts:openScript', (_event, dir) => {
    if (!grants.allows(dir)) return 'this part folder is not in a folder opened in the app'
    return openScript(dir)
  })
  ipcMain.handle('parts:revealPart', (_event, dir) => {
    if (!dir) return 'no part folder'
    if (!grants.allows(dir)) return 'this part folder is not in a folder opened in the app'
    shell.showItemInFolder(behaviorPath(dir)) // highlights behavior.js in the OS file manager
    return ''
  })
  // The parts SHELF (partsShelf.cjs, docs/parts-shelf.md): parts kept outside any project, for projects to copy
  // from. The page never names a path: it lists the shelf, and hands a part over by id to be written into it.
  ipcMain.handle('shelf:list', () => listShelf(shelfRoot()))
  ipcMain.handle('shelf:signature', () => shelfSignature(shelfRoot()))
  ipcMain.handle('shelf:write', (_event, id, manifestJson, behaviorSource, thumbnail) => writeShelfPart(shelfRoot(), id, manifestJson, behaviorSource, thumbnail))
  ipcMain.handle('shelf:pickFolder', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose Parts Shelf Folder',
      defaultPath: shelfRoot(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    writeChosenShelf(SHELF_SETTINGS_FILE, canonicalRoot(result.filePaths[0]))
    return listShelf(shelfRoot())
  })
  ipcMain.handle('shelf:reveal', async () => {
    mkdirSync(shelfRoot(), { recursive: true })
    return shell.openPath(shelfRoot()) // '' on success, else the OS's reason
  })
  // Every socket below that reaches off this machine is the USER's call, asked natively the first time
  // (endpointConsent.cjs): the page asking is not enough, since the page can run a collab room's part code.
  const consent = createEndpointConsent({
    file: join(app.getPath('userData'), 'network-endpoints.json'),
    trustAll: process.env.OIP_TRUST_ENDPOINTS === '1',
    ask: async ({ what }, sender) => {
      const win = sender ? BrowserWindow.fromWebContents(sender) : null
      const options = {
        type: 'warning',
        title: 'Network connection',
        message: `Allow Open Industry Project to ${what}?`,
        detail:
          'Allow this only if you set up this connection yourself. A connection to real equipment lets the simulator ' +
          'read and write it. The app remembers a yes for this address.',
        buttons: ['Allow', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }
      const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return response === 0
    },
  })
  const allows = (target, sender) => consent.allows(target, sender)
  // An external PLC's Modbus master connects to the app through a socket main opens (plcIo.cjs).
  registerPlcIo(ipcMain, { consent: allows })
  // ...or through OPC UA, which node-opcua speaks here (opcUaIo.cjs); its client certificate store lives
  // with the app's data, since node-opcua keeps one even for an unsecured connection
  registerOpcUaIo(ipcMain, { pkiRoot: join(app.getPath('userData'), 'opcua-pki'), consent: allows })
  // ...or through EtherNet/IP to a Logix controller, which libplctag speaks here (eipIo.cjs)
  registerEipIo(ipcMain, { consent: allows })
  // ...or over ADS to a TwinCAT runtime, through TwinCAT's own router on this PC (adsIo.cjs)
  registerAdsIo(ipcMain, { consent: allows })
  // The simulated PLC's own OPC UA server, for a SCADA or HMI (opcUaServer.cjs); its server
  // certificate lives beside the client's
  registerOpcUaServer(ipcMain, { pkiRoot: join(app.getPath('userData'), 'opcua-pki'), consent: allows })
  // The agent door: tool calls from the MCP server (mcpServer.cjs) go to the editor window that serves them
  registerAgentHost(ipcMain, agentHost)
  // The Inspector's USD import: a root layer the person picked, read with the layers and images beside it. USD layers
  // only, the one kind whose model is spread over its folder (editor/usdImport.ts)
  ipcMain.handle('model:readUsd', (_event, path) => (typeof path === 'string' && /\.(usd|usda|usdc)$/i.test(path) ? readModel(path) : { error: 'not a USD layer file' }))
  // Help > Check for Updates..., and the newer-build banner's "Get the update" (updater.cjs)
  // the downloaded update the page's notice offers (DesktopUpdateToast): which version, and its Restart
  ipcMain.handle('app:updateState', () => updater?.readyVersion() ?? null)
  ipcMain.handle('app:installUpdate', () => updater?.install())
  ipcMain.handle('app:checkForUpdates', (event) => updater?.checkInteractive(appWindow(BrowserWindow.fromWebContents(event.sender))))
  // whether the agent door is open, and turning it on or off: main owns the server and the choice (setAgentDoor)
  ipcMain.handle('agent:doorState', () => agentDoorState())
  ipcMain.handle('agent:setDoor', (event, on) => setAgentDoor(appWindow(BrowserWindow.fromWebContents(event.sender)), on === true))
  // The renderer's menu model (editor/commands.ts) - rebuild the application menu from it.
  ipcMain.on('menu:model', (event, model) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) buildMenu(win, model)
  })
  // {commandId: enabled}, pushed whenever the editor's state changes what's allowed.
  // Each window's own: the menu shows the focused window's (browser-window-focus in whenReady).
  ipcMain.on('menu:enabled', (event, map) => {
    if (!map || typeof map !== 'object') return
    const id = event.sender.id
    const now = { ...(enabledByWindow.get(id) ?? {}), ...map }
    enabledByWindow.set(id, now)
    if (menuWindowId !== null && menuWindowId !== id) return
    menuWindowId = id
    lastEnabled = now
    applyEnabled(map)
  })

  // The toolbar's menu button (Windows/Linux, where titleBar() hid the menu bar): pop the application
  // menu itself, so the pointer path and the Alt path show the one menu buildMenu() defines.
  ipcMain.on('menu:popup', (event, pos) => {
    const menu = Menu.getApplicationMenu()
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!menu || !win) return
    // popup() wants window coordinates in DIP; the renderer measures CSS px, which View → Zoom scales.
    const zoom = event.sender.getZoomFactor()
    menu.popup({ window: win, x: Math.round((pos?.x || 0) * zoom), y: Math.round((pos?.y || 0) * zoom) })
  })
}

// Tell the renderer to run an app-level command (New/Open/Undo/Run/…). The renderer dispatches it to
// the SAME store/controller verbs the toolbar + keyboard use (see src/editor/desktop/desktopMenuBridge.ts), so
// the menu never drifts from the on-screen affordances.
function sendCommand(win, command, viaChord = false) {
  if (win && !win.isDestroyed()) win.webContents.send('menu:command', command, viaChord)
}

// ── Third-party licenses (Help > Third-Party Licenses) ───────────────────────────────────────────────
// Everything the app redistributes, in one window: the app's own license and THIRD_PARTY_NOTICES.md, the
// license texts of what the web build bundles (dist/THIRD_PARTY_LICENSES.txt, generated by the build) and of
// the shell's own main-process dependencies (THIRD_PARTY_LICENSES.desktop.txt, generated before packaging by
// scripts/desktop-licenses.mjs), and Electron's. Chromium's is a 20 MB page of its own, linked rather than
// inlined. The window has no preload: it is text, and needs nothing from main.
const licenseContents = new Set()

function chromiumLicensesFile() {
  return join(dirname(process.execPath), 'LICENSES.chromium.html')
}

function licenseSections() {
  const repo = join(__dirname, '..', '..')
  const first = (...paths) => paths.find((p) => existsSync(p)) ?? paths[0]
  const exeDir = dirname(process.execPath)
  return [
    ['Open Industry Project', first(join(DIST_DIR, 'LICENSE'), join(repo, 'LICENSE'))],
    ['Third-party notices', first(join(DIST_DIR, 'THIRD_PARTY_NOTICES.md'), join(repo, 'THIRD_PARTY_NOTICES.md'))],
    ['Third-party code in the app', join(DIST_DIR, 'THIRD_PARTY_LICENSES.txt')],
    ['Third-party code in the desktop shell', join(__dirname, 'THIRD_PARTY_LICENSES.desktop.txt')],
    // electron-builder renames Electron's LICENSE; an unpackaged shell still has the original name
    ['Electron', first(join(exeDir, 'LICENSE.electron.txt'), join(exeDir, 'LICENSE'))],
  ]
}

function showLicenses(parent) {
  const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = licenseSections()
    .map(([title, file]) => {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        text = `(not found: ${file}${packaged ? '' : ' - run `npm run build`, and `npm run pack` in apps/desktop, to generate it'})`
      }
      return `<h2>${escape(title)}</h2><pre>${escape(text)}</pre>`
    })
    .join('\n')
  const chromium = existsSync(chromiumLicensesFile())
    ? `<p><a href="${pathToFileURL(chromiumLicensesFile()).href}">Chromium's licenses</a> (a large page; it opens in this window)</p>`
    : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Third-Party Licenses</title>
<style>:root{color-scheme:${shellChoice || 'light dark'}}
body{background:light-dark(${SHELL.light.bg},${SHELL.dark.bg});color:light-dark(${SHELL.light.text},${SHELL.dark.text});font:13px system-ui,sans-serif;margin:24px;max-width:960px}
h1{font-size:18px}h2{font-size:15px;margin-top:28px;border-bottom:1px solid light-dark(#d8dadd,#33363b);padding-bottom:4px}
pre{white-space:pre-wrap;font:12px ui-monospace,Consolas,monospace;color:light-dark(#393c40,#c3c6ca)}a{color:light-dark(#226fce,#7cb7ff)}</style></head>
<body><h1>Third-Party Licenses</h1><p>Open Industry Project ${escape(app.getVersion())} and the software it includes.</p>${chromium}${body}</body></html>`
  const file = join(app.getPath('userData'), 'licenses.html')
  try {
    writeFileSync(file, html)
  } catch (e) {
    dialog.showErrorBox('Third-Party Licenses', `Could not write ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    ...iconOption,
    title: 'Third-Party Licenses',
    backgroundColor: SHELL[shellTheme].bg, // = the page's body in the app's theme, so it opens without a flash
    autoHideMenuBar: true,
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const id = win.webContents.id
  licenseContents.add(id)
  win.once('closed', () => licenseContents.delete(id))
  void win.loadFile(file)
}

function showAbout(win) {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'About Open Industry Project',
    message: 'Open Industry Project - Simulator',
    detail:
      `Design, program, and simulate industrial automation - free and open.\n\n` +
      `Early release: an update can change how projects, custom parts and PLC programs behave. ` +
      `Keep a copy of any project you care about.\n\n` +
      `Shell ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: ['OK'],
  })
}

// ── The menu ──────────────────────────────────────────────────────────────────────────────────────
// The RENDERER owns it. src/editor/commands.ts holds every app-level command - label, chord, and the
// one rule for when it's allowed - plus the structure that arranges them into File/Edit/Simulation/
// View/Help. It ships that across as plain data (menu:model) and this file renders it. Main keeps
// only the items it owns outright: Electron's roles, the parts workspace, quit, and the Help links -
// none of which touch the document.
//
// The direction matters. A template here would be a second copy of every label and every enablement
// rule, and copies drift: a native Edit → Cut would stay clickable with nothing selected (main can't
// see the selection) while the app's own context menu greys it. Enablement arrives on
// menu:enabled whenever the editor's state changes, so the native menu greys exactly when the
// on-screen buttons do.

/** Items main owns outright - nothing here needs the renderer's state. */
function shellMenuItem(kind, win) {
  switch (kind) {
    case 'recent': {
      // Main owns this one because it owns the list (folderRegistry.cjs). A click hands the folder to the
      // renderer, which opens it exactly as if it had been picked.
      const rows = registry.list().slice(0, 10)
      const escape = (text) => String(text).replace(/&/g, '&&') // Windows reads & as a mnemonic marker
      return {
        label: 'Open Recent',
        submenu:
          rows.length === 0
            ? [{ label: 'No recent projects', enabled: false }]
            : rows.map((row) => ({
                label: escape(`${row.name || basename(row.path)} - ${row.path}`),
                click: (_i, w) => {
                  const target = appWindow(w, win)
                  grants.grant(row.path) // the user picked it from the menu
                  // open in another window: that one comes forward, and this one keeps its project
                  const holder = windowWithFolder(row.path, target)
                  if (holder) return bringForward(holder)
                  if (target && !target.isDestroyed()) target.webContents.send('project:openPath', row.path)
                },
              })),
      }
    }
    case 'quit':
      return isMac ? { role: 'close' } : { role: 'quit' }
    case 'docs':
      return { label: 'Documentation', click: () => shell.openExternal('https://www.openindustryproject.org') }
    case 'github':
      return {
        label: 'View on GitHub',
        click: () => shell.openExternal('https://github.com/Open-Industry-Project/Open-Industry-Project'),
      }
    case 'issues':
      return {
        label: 'Report an Issue…',
        click: () => shell.openExternal('https://github.com/Open-Industry-Project/Open-Industry-Project/issues'),
      }
    case 'updates':
      return { label: 'Check for Updates…', click: (_i, w) => void updater?.checkInteractive(appWindow(w, win)) }
    case 'licenses':
      return { label: 'Third-Party Licenses', click: (_i, w) => showLicenses(appWindow(w, win)) }
    case 'about':
      // macOS keeps About in the app menu, where the platform puts it
      return isMac ? null : { label: 'About', click: (_i, w) => showAbout(appWindow(w, win)) }
    default:
      return null
  }
}

// Roles this shell will render. An allowlist because the model crosses IPC and Electron THROWS on an
// unknown role - a typo in the renderer should cost one item, not the entire menu.
const MENU_ROLES = new Set([
  'reload',
  'forceReload',
  'toggleDevTools',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'togglefullscreen',
  'minimize',
  'close',
  'quit',
  'windowMenu',
  'zoom',
  'front',
])
// Roles only macOS draws; elsewhere Electron would show a dead item. Dropped there (Electron then
// collapses the separators left dangling).
const MAC_ONLY_ROLES = new Set(['zoom', 'front'])
// A role a SUBMENU with items may carry: `window` makes it macOS's Window menu, filled with the open windows.
const SECTION_ROLES = new Set(['window'])

/** One model entry → one Electron MenuItem, or null to drop it (unknown role, bad shape). */
function menuItemFromModel(item, win) {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'separator') return { type: 'separator' }
  if (item.type === 'role') {
    if (!MENU_ROLES.has(item.role) || (MAC_ONLY_ROLES.has(item.role) && !isMac)) return null
    // an accelerator on a role REPLACES the role's own: Close is moved off Ctrl+W
    return { role: item.role, ...(item.label ? { label: item.label } : {}), ...(item.accelerator ? { accelerator: item.accelerator } : {}) }
  }
  if (item.type === 'shell') return shellMenuItem(item.id, win)
  if (item.type !== 'command' || typeof item.id !== 'string' || typeof item.label !== 'string') return null
  return {
    id: item.id, // so menu:enabled can find it again
    label: item.label,
    enabled: item.enabled !== false,
    // `register` marks the accelerators the MENU owns (Ctrl+N, F5…). The rest are the app's own
    // keydown bindings, shown as a hint only - registering those would fire the command twice.
    ...(item.accelerator
      ? { accelerator: item.accelerator, registerAccelerator: item.register === true }
      : {}),
    // to the window that RUNS the app: with a panel popped out, the focused window is only its canvas
    // ...and HOW it was asked for (the accelerator or the item clicked)
    click: (_i, w, event) => sendCommand(appWindow(w, win), item.id, event?.triggeredByAccelerator === true),
  }
}

// Until the renderer's model lands (a second or two against a cold dev server) the shell shows only
// what it owns. Not a stand-in copy of the app menu: a copy is the thing this design
// removes, and every command in one would dispatch into a renderer that isn't listening yet.
const BOOTSTRAP_MENU = [
  {
    label: 'File',
    items: [
      { type: 'shell', id: 'quit' },
    ],
  },
  {
    label: 'View',
    items: [
      { type: 'role', role: 'reload' },
      { type: 'role', role: 'forceReload' },
      { type: 'role', role: 'toggleDevTools' },
      { type: 'separator' },
      { type: 'role', role: 'togglefullscreen' },
    ],
  },
  {
    label: 'Window',
    role: 'window',
    items: [
      { type: 'role', role: 'minimize' },
      { type: 'role', role: 'zoom' },
      { type: 'separator' },
      { type: 'role', role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
      { type: 'separator' },
      { type: 'role', role: 'front' },
    ],
  },
  {
    label: 'Help',
    items: [
      { type: 'shell', id: 'docs' },
      { type: 'shell', id: 'github' },
      { type: 'shell', id: 'issues' },
      { type: 'shell', id: 'updates' },
      { type: 'shell', id: 'licenses' },
      { type: 'shell', id: 'about' },
    ],
  },
]

// The last model the renderer sent, so a second window (or macOS re-activate) rebuilds the real menu
// instead of dropping back to the bootstrap one.
let menuModel = BOOTSTRAP_MENU
// The latest {commandId: enabled} the focused window pushed. A rebuild (Open Recent changing) starts from the
// model's snapshot, which is as old as the model, so the live flags are put back on top of it.
let lastEnabled = {}
/** Every window's latest {commandId: enabled}, by webContents id, and the window whose the menu shows. */
const enabledByWindow = new Map()
let menuWindowId = null

function applyEnabled(map) {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const [id, on] of Object.entries(map)) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = !!on
  }
}

function refreshMenu(win) {
  const target = win || focusedAppWindow()
  if (!target) return
  buildMenu(target)
  applyEnabled(lastEnabled)
}

function buildMenu(win, model) {
  if (Array.isArray(model)) menuModel = model
  const template = [
    // macOS convention puts an app menu (About/Quit) first; Windows/Linux fold those into File/Help.
    ...(isMac ? [{ role: 'appMenu' }] : []),
    ...menuModel.flatMap((section) => {
      if (!section || typeof section !== 'object') return []
      if (section.role && !section.items) return MENU_ROLES.has(section.role) ? [{ role: section.role, label: section.label }] : []
      const submenu = (section.items ?? []).map((i) => menuItemFromModel(i, win)).filter(Boolean)
      const role = isMac && SECTION_ROLES.has(section.role) ? { role: section.role } : {}
      return submenu.length ? [{ label: String(section.label ?? ''), ...role, submenu }] : []
    }),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Unpackaged runs only, opt-in with DESKTOP_COI=1: adds COOP/COEP to every response, so the renderer is
// crossOriginIsolated (SharedArrayBuffer) whatever the loaded server sends. Off by default because COEP
// `require-corp` blocks cross-origin assets lacking CORP headers.
function enableCrossOriginIsolation() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    })
  })
}

// ── Links from a browser (deepLink.cjs) ──────────────────────────────────────────────────────────
// `openindustry://open?room=...`: the installer registers the scheme (package.json `build.protocols`). A link
// that launches the app goes into the first URL the window loads; one that arrives while it runs (a second
// launch on Windows / Linux, `open-url` on macOS) moves the window into that room, or, for `?handoff=`, reloads it
// to receive a browser's project (src/editor/desktop/desktopHandoff.ts, which asks before importing). Leaving the document it showed
// loses nothing: the page saves on `pagehide` (main.tsx flushPersist, projectFolderSync's flush), exactly as when
// Share moves a window into a new room.
// A development shell registers only when asked (OIP_DEEP_LINK=1): registering writes the OS's per-user handler
// for the scheme, which would otherwise point at whichever checkout last ran `npm start`.
if (!packaged && process.env.OIP_DEEP_LINK === '1') {
  app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [resolve(process.argv[1] || '.')])
}
/** a link that arrived before there was a window to take it (a launch, or macOS's open-url before ready) */
let launchLink = deepLinkFromArgv(process.argv)

/** The app URL a launch loads: `base`, in the launch link's room or receiving its hand-over when there is one. */
function withLaunchLink(base) {
  const link = launchLink
  launchLink = null
  return link ? linkUrl(base, link) : base
}

/**
 * Bring the window forward and, for a room link, move it into that room (unless it is there already); for a
 * hand-over, reload it to receive the project (the page asks before importing anything).
 */
function openLinkIn(win, link) {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.focus()
  if (!link.room && !link.handoff) return
  const current = win.webContents.getURL()
  // not the app yet (still on about:blank, or a load that failed): nothing to navigate from
  if (!isAppUrl(current, appOrigin) || (link.room && roomOf(current) === link.room)) return
  void win.loadURL(linkUrl(current, link))
}

// macOS opens a file by event, not argv: a double-click on a .oip / .oippart, before or after the window exists
app.on('open-file', (event, path) => {
  event.preventDefault()
  openDocumentFile(path)
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  const link = parseDeepLink(url)
  if (!link) return
  const win = focusedAppWindow()
  if (win) openLinkIn(win, link)
  else launchLink = link
})

// One process per profile: it owns which window has which project, so a project is never open in two. A second
// launch hands what it named to this one: a browser link or a file goes to the focused window, and a folder opens in
// a window of its own, or brings forward the window that has it.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const win = focusedAppWindow()
    if (!win) return
    const link = deepLinkFromArgv(argv)
    if (link) return openLinkIn(win, link)
    // a project or part file double-clicked while the app runs
    const file = documentFileArg(argv)
    if (file) return openDocumentFile(file)
    const root = projectFolderArg(argv)
    if (!root) return bringForward(win)
    grants.grant(root) // named on a second launch's command line
    openFolderWindow(root, win)
  })
}

// ── The agent door (mcpServer.cjs, docs/agent-tools.md) ──────────────────────────────────────────
// An MCP server on loopback, so an agent the user runs (Claude Desktop, Claude Code, ...) can drive the open editor.
// At a FIXED port, because a client is configured with the URL once. Whether it is open is the user's choice
// (agentDoorSetting.cjs: an installed app starts shut, the development shell open; OIP_MCP=0 / OIP_MCP_PORT
// override), made and changed in Settings > Agent connections (setAgentDoor) and remembered in userData.
// list_projects, open_project and new_project run here (agentProjects.cjs): main owns which folders may open
const agentHost = new AgentHost({
  shellTools: createProjectTools({
    registry,
    grants,
    projectsRoot: defaultProjectsRoot,
    currentRoot: () => rootOf(agentWindow()),
    // a project open in another window: the agent moves to that window rather than open it twice
    driveWindowWith: (root) => {
      const holder = windowWithFolder(root, agentWindow())
      if (!holder) return false
      bringForward(holder)
      agentHost.focus(holder.webContents.id)
      return true
    },
    openElsewhere: (root) => windowWithFolder(root, agentWindow()) !== null,
    canonical: canonicalRoot,
    askToOpen: askAgentOpen,
  }),
})

// open_project on a folder outside Open Recent and the projects folder: the user says whether the agent may open it
async function askAgentOpen(root, name) {
  const win = agentWindow()
  if (win) bringForward(win)
  const opts = {
    type: 'question',
    title: 'Open Project',
    message: `An AI agent asks to open "${name}".`,
    detail: `${root}\n\nThis folder is not one you have opened in the app. The project you have open now stays saved.`,
    buttons: ['Open', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
  return response === 0
}
const DOOR_SETTING_FILE = join(app.getPath('userData'), 'agent-door.json')
const doorStart = doorAtStartup({
  env: process.env,
  packaged,
  isolated: app.commandLine.hasSwitch('user-data-dir'),
  saved: readDoorSetting(DOOR_SETTING_FILE),
  defaultPort: MCP_DEFAULT_PORT,
})
/** updater.cjs: { checkInteractive(win) }, set once the app is ready */
let updater = null
/** the open door, { url, close }, or null while it is shut */
let agentDoor = null

async function openAgentDoor() {
  if (agentDoor) return { url: agentDoor.url }
  const started = await startMcpServer(agentHost, { port: doorStart.port, version: app.getVersion() })
  if (started.error) return { error: started.error }
  agentDoor = started
  return { url: started.url }
}

async function closeAgentDoor() {
  const door = agentDoor
  agentDoor = null
  if (door) await door.close()
}

async function startAgentDoor() {
  if (!doorStart.serve) {
    console.log(`[mcp] agent door shut (${doorStart.why})`)
    return
  }
  const opened = await openAgentDoor()
  if (opened.error) console.warn(`[mcp] agent door not served: ${opened.error}`)
  else console.log(`[mcp] agent door at ${opened.url}`)
}

/** Whether the door is open, and its URL: what Settings > Agent connections shows. */
function agentDoorState() {
  return { enabled: agentDoor !== null, url: agentDoor ? agentDoor.url : `http://127.0.0.1:${doorStart.port}/mcp` }
}

/** Tell every app window the door opened or shut, so a Settings dialog open in another window shows it. */
function broadcastAgentDoor() {
  const state = agentDoorState()
  for (const w of appWindows()) w.webContents.send('agent:doorChanged', state)
}

// Settings > Agent connections turns the door on or off. Turning it on asks first in a native dialog, because main
// owns the server and the choice, and a page must not be able to open the door without the person's answer.
// Turning it off needs no question. The renderer only asks for this (preload oipAgent.setDoor).
async function setAgentDoor(win, on) {
  if (!on) {
    await closeAgentDoor()
    writeDoorSetting(DOOR_SETTING_FILE, false)
    broadcastAgentDoor()
    return agentDoorState()
  }
  if (agentDoor) return agentDoorState()
  const parent = win && !win.isDestroyed() ? win : undefined
  const ask = (opts) => (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))
  const { response } = await ask({
    type: 'question',
    title: 'Agent Connections',
    message: 'Allow AI agents to connect to this app?',
    detail:
      'An AI agent you run on this computer (any MCP client, such as Claude Desktop or Claude Code) can then see ' +
      'and edit the open project, run the simulation and change its PLC program. Its edits are saved like yours, ' +
      "including to the project's folder.\n\n" +
      'Any program on this computer can connect while this is on. Web pages and other computers cannot.',
    buttons: ['Allow', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) return agentDoorState()
  const opened = await openAgentDoor()
  if (opened.error) return { ...agentDoorState(), error: opened.error }
  writeDoorSetting(DOOR_SETTING_FILE, true)
  broadcastAgentDoor()
  return agentDoorState()
}

app.whenReady().then(() => {
  markLaunch('ready')
  // Electron grants every permission by default. Keep that for the app (pointer lock for walk mode, WebXR,
  // fullscreen, clipboard ...) and refuse it to anything else.
  session.defaultSession.setPermissionRequestHandler((contents, _permission, callback, details) =>
    callback(isAppContents(contents, details.requestingUrl || contents.getURL())),
  )
  session.defaultSession.setPermissionCheckHandler((contents, _permission, requestingOrigin) =>
    contents ? isAppContents(contents, requestingOrigin) : isAppUrl(requestingOrigin, appOrigin),
  )
  if (!packaged && process.env.DESKTOP_COI) enableCrossOriginIsolation()
  registerIpc()
  void startAgentDoor()
  // a promise either way, so a missing build reaches createWindow's error box instead of throwing here
  const url = prodMode ? Promise.resolve().then(prodUrl) : TARGET_URL
  appUrl = Promise.resolve(url)
  // the launch link's room applies to this first window only; `activate` re-creates at the plain URL
  const win = createWindow(Promise.resolve(url).then(withLaunchLink))
  buildMenu(win)
  // after the window, so a launch's check never competes with its first frame (updater.cjs waits further still)
  updater = setupUpdater({
    app,
    dialog,
    getWindow: () => focusedAppWindow(),
    // to every window running the app (not a popped-out panel, whose page is the opener's, nor the licenses page)
    notifyReady: (version) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed() || popoutOwner.has(w.id) || licenseContents.has(w.webContents.id)) continue
        w.webContents.send('app:updateReady', version)
      }
    },
  })
  // The focused window is the one the menu's enablement, the agent door and a second launch speak for. A popped-out
  // panel stands for the window that opened it.
  app.on('browser-window-focus', (_event, focused) => {
    const owner = appWindow(focused)
    if (!owner || owner.isDestroyed() || !appWindows().includes(owner)) return
    lastAppWindow = owner
    const id = owner.webContents.id
    agentHost.focus(id)
    if (menuWindowId === id) return
    menuWindowId = id
    lastEnabled = enabledByWindow.get(id) ?? {}
    applyEnabled(lastEnabled)
  })
  app.on('activate', () => {
    // a macOS open-url with no window open leaves its link for this one
    if (BrowserWindow.getAllWindows().length === 0) buildMenu(createWindow(Promise.resolve(url).then(withLaunchLink)))
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// libplctag runs a thread of its own once used; let it go before the process does
app.on('will-quit', () => {
  shutdownEip()
  void shutdownAds()
})
