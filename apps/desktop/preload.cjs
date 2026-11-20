// Preload bridge: the only channel between the sandboxed renderer (the oip-web app) and the Node main
// process. Runs in an isolated context with contextIsolation on, so the renderer never gets raw Node.
// It sees only the small, explicit `window.oip*` surfaces below.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('oipParts', {
  /**
   * Show a native folder picker, then scan the chosen folder for parts, for the renderer to import into the open
   * project's parts (the shell keeps no parts of its own).
   * @returns {Promise<null | { root: string, parts: Array<{dir,id,name,manifestJson,behaviorSource}>, problems: Array<{dir,message}> }>}
   *   null if the user cancelled the dialog.
   */
  pickWorkspace: () => ipcRenderer.invoke('parts:pickFolder'),

  /**
   * Open a part's behavior.js for editing - in $OIP_EDITOR/$VISUAL/$EDITOR if set, else the OS default app
   * ("open in external editor"). @param {string} dir the part's folder.
   * @returns {Promise<string>} '' on success, else a short error message.
   */
  openScript: (dir) => ipcRenderer.invoke('parts:openScript', dir),

  /**
   * The parts in the old profile-wide custom-parts folder, which no project loads on its own. Names only, so the
   * app can tell the user once where they are and how to import them.
   * @returns {Promise<{ root: string, names: string[] }>}
   */
  legacyParts: () => ipcRenderer.invoke('parts:legacyParts'),

  /**
   * Reveal a part's behavior.js in the OS file manager. @param {string} dir the part's folder.
   * @returns {Promise<string>} '' on success, else a short error message.
   */
  revealPart: (dir) => ipcRenderer.invoke('parts:revealPart', dir),
})

// The parts shelf (apps/desktop/partsShelf.cjs; src/editor/parts/partShelf.ts is the typed twin): parts kept outside
// any project, for projects to copy from. No paths cross: the page lists the shelf, and hands a part over by id.
// Model import (editor/usdImport.ts): a USD model file is often one layer of several in its folder, which a page can
// only read when handed them all. Here the picked file's own path leads main to the layers and images beside it.
contextBridge.exposeInMainWorld('oipModel', {
  /** the file's path on disk ('' for a file that has none, such as one built in the page) */
  pathOf: (file) => webUtils.getPathForFile(file),
  /** a .usd / .usda / .usdc root layer with the USD layers and images under its folder (mcpServer.cjs readModel) */
  readUsd: (path) => ipcRenderer.invoke('model:readUsd', path),
})

contextBridge.exposeInMainWorld('oipShelf', {
  /** @returns {Promise<{ root: string, parts: Array<{dir,id,name,manifestJson,behaviorSource,thumbnail?}>, problems: Array<{dir,message}> }>} */
  list: () => ipcRenderer.invoke('shelf:list'),
  /** The shelf's files by name, size and change time, to tell cheaply whether it changed. @returns {Promise<string>} */
  signature: () => ipcRenderer.invoke('shelf:signature'),
  /** Put a part on the shelf (replacing that id's folder), with its card image as a PNG data URL. @returns {Promise<string>} '' or the error to show */
  write: (id, manifestJson, behaviorSource, thumbnail) => ipcRenderer.invoke('shelf:write', id, manifestJson, behaviorSource, thumbnail),
  /** Choose another shelf folder. @returns {Promise<null | { root, parts, problems }>} null when cancelled */
  pickFolder: () => ipcRenderer.invoke('shelf:pickFolder'),
  /** Show the shelf folder in the OS file manager. @returns {Promise<string>} '' or the OS's reason */
  reveal: () => ipcRenderer.invoke('shelf:reveal'),
})

// The project-as-a-folder surface (src/editor/desktop/desktopProjectBridge.ts is the typed twin). The shell
// only moves raw {path, contents} text files between disk and the renderer. The format lives in
// src/core/project/projectFolder.ts and the sync rules in src/core/project/folderSync.ts, shared with the web and the CLIs.
contextBridge.exposeInMainWorld('oipProject', {
  /**
   * Show a native folder picker and read the chosen project folder's files.
   * @returns {Promise<null | { root: string, files: Array<{path: string, contents: string}>, docId: string | null, error?: string }>}
   *   null if the user cancelled the dialog; `error` set when the folder couldn't be read; `docId` is the
   *   document that folder already is, if the app has opened it before.
   */
  pickOpenFolder: () => ipcRenderer.invoke('project:pickOpenFolder'),

  /**
   * Show a native folder picker for saving into. Writes nothing: the renderer writes it after asking.
   * @returns {Promise<null | { root: string, hasProject: boolean, docId: string | null }>} null if cancelled.
   */
  pickSaveFolder: () => ipcRenderer.invoke('project:pickSaveFolder'),

  /** Read a known folder, same answer as pickOpenFolder. @param {string} root */
  readAt: (root) => ipcRenderer.invoke('project:readAt', root),

  /** The folder's change fingerprint. @returns {Promise<{ signature: string } | { error: string }>} */
  signature: (root) => ipcRenderer.invoke('project:signature', root),

  /**
   * Guarded writes (src/core/project/folderSync.ts FolderWriteOp[]).
   * @returns {Promise<{ moved: string[], failed: string[], error: string | null }>}
   */
  write: (root, ops) => ipcRenderer.invoke('project:write', root, ops),

  /** The same, synchronously - for the last write before the window goes away. */
  writeSync: (root, ops) => ipcRenderer.sendSync('project:writeSync', root, ops),

  /** A new, empty folder for a project: under the default projects folder, or beside `beside` (a folder the app
   *  already works in). @returns {Promise<{root: string} | {error: string}>} */
  createFolder: (name, beside) => ipcRenderer.invoke('project:createFolder', name, beside),

  /** Tell the shell which folder the window is working in (pickers start there; its parts/ goes live). */
  attach: (root) => ipcRenderer.send('project:attach', root),

  /** Show the folder in the OS file manager. @returns {Promise<string>} '' on success. */
  reveal: (root) => ipcRenderer.invoke('project:reveal', root),

  /** The folder remembered for a document, or null. */
  recall: (docId) => ipcRenderer.invoke('project:recall', docId),

  /** Every remembered folder, most recently used first. */
  folders: () => ipcRenderer.invoke('project:folders'),

  /** Remember or update a document's folder: { path?, name?, signature?, baseline?, touch? }. */
  remember: (docId, patch) => ipcRenderer.invoke('project:remember', docId, patch),

  /** The same, synchronously. */
  rememberSync: (docId, patch) => ipcRenderer.sendSync('project:rememberSync', docId, patch),

  /** The user unlinked this document from its folder on purpose. */
  detach: (docId) => ipcRenderer.invoke('project:detach', docId),

  /** Drop this document's row entirely. */
  forget: (docId) => ipcRenderer.invoke('project:forget', docId),

  /** A folder named on the command line at launch, once; null after that. */
  takePendingOpen: () => ipcRenderer.invoke('project:takePendingOpen'),

  /**
   * Hear a request to open a folder that did not come from the renderer: File > Open Recent, or a second
   * launch naming one. Returns an unsubscribe fn. @param {(root: string) => void} cb
   */
  onOpenPath: (cb) => {
    const listener = (_event, root) => cb(root)
    ipcRenderer.on('project:openPath', listener)
    return () => ipcRenderer.removeListener('project:openPath', listener)
  },

  /** Hear a folder to open in a window of its own (a second launch naming one). Returns an unsubscribe fn. */
  onOpenPathInNewWindow: (cb) => {
    const listener = (_event, root) => cb(root)
    ipcRenderer.on('project:openPathInNewWindow', listener)
    return () => ipcRenderer.removeListener('project:openPathInNewWindow', listener)
  },

  /** Tell the shell which document this window has open (null for none), so it is never opened in two windows. */
  showingDocument: (docId) => ipcRenderer.send('window:document', docId),

  /** Bring forward the window with this document open, else open one on it. @returns {Promise<'focused' | 'opened'>} */
  openWindow: (docId) => ipcRenderer.invoke('window:openDocument', docId),

  /** Bring forward the window working in this folder. @returns {Promise<boolean>} false when no window is. */
  focusFolder: (root) => ipcRenderer.invoke('window:focusFolder', root),

  /** The next project or part file waiting to be opened, as `{ name, kind, bytes }` or `{ error }`; null when none waits. */
  takePendingFile: () => ipcRenderer.invoke('file:takePendingOpen'),

  /**
   * Hear a project or part file opened while the app runs (a double-click on a .oip / .oippart). The main process
   * keeps each file until it is taken, so one that arrived before this listener (the editor still starting) is
   * taken here as it connects.
   * @param {(file: { name: string, kind: 'project' | 'part', bytes: Uint8Array } | { error: string }) => void} cb
   */
  onOpenFile: (cb) => {
    const take = () =>
      void ipcRenderer.invoke('file:takePendingOpen').then((file) => {
        if (!file) return
        cb(file)
        take()
      })
    const listener = () => take()
    ipcRenderer.on('file:pending', listener)
    take()
    return () => ipcRenderer.removeListener('file:pending', listener)
  },
})

// An external PLC reaches the app over TCP, which the sandboxed renderer cannot open: main listens or
// connects (plcIo.cjs) and carries raw bytes. src/editor/links/externalPlc.ts is the typed twin; the protocol is the app's.
// Every call and push names the window's link it is for (`link`, one per controller: linkKeys.cjs), 0 when absent;
// src/editor/links/linkHosts.ts fills it in.
contextBridge.exposeInMainWorld('oipPlcIo', {
  /** @param {{link?: number, host: string, port: number}} opts @returns {Promise<{error: string}>} '' once listening */
  listen: (opts) => ipcRenderer.invoke('plcio:listen', opts),
  /** @param {{link?: number, host: string, port: number}} opts @returns {Promise<{error: string, id: number}>} connect to a PLC's server */
  connect: (opts) => ipcRenderer.invoke('plcio:connect', opts),
  /** stop listening and drop every connection @param {{link?: number}} [opts] */
  close: (opts) => ipcRenderer.invoke('plcio:close', opts),
  /** @param {(e: {link: number, id: number, remote: string, open: boolean}) => void} cb @returns {() => void} unsubscribe */
  onConnection: (cb) => {
    const listener = (_event, e) => cb(e)
    ipcRenderer.on('plcio:connection', listener)
    return () => ipcRenderer.removeListener('plcio:connection', listener)
  },
  /** @param {(e: {link: number, id: number, bytes: Uint8Array}) => void} cb @returns {() => void} unsubscribe */
  onData: (cb) => {
    const listener = (_event, e) => cb(e)
    ipcRenderer.on('plcio:data', listener)
    return () => ipcRenderer.removeListener('plcio:data', listener)
  },
  /** @param {number} id @param {Uint8Array} bytes */
  write: (id, bytes) => ipcRenderer.send('plcio:write', { id, bytes }),
  /** @param {number} id */
  drop: (id) => ipcRenderer.send('plcio:drop', { id }),
})

// ...and through OPC UA, whose protocol node-opcua speaks in main (opcUaIo.cjs). The app decides which tag
// is which node (src/core/io/opcUa.ts); these are the service calls it makes.
contextBridge.exposeInMainWorld('oipOpcUa', {
  /** @param {{endpoint: string}} opts @returns {Promise<{error: string, discovery?: {name: string, urls: string[]}[]}>} discovery: a discovery server, not a PLC */
  connect: (opts) => ipcRenderer.invoke('opcua:connect', opts),
  /** @param {{link?: number, roots?: ({path: string[]} | {nodeId: string})[]}} [opts] @returns {Promise<{error: string, variables?: {path: string[], nodeId: string}[], truncated?: boolean, skipped?: string[]}>} */
  browse: (opts) => ipcRenderer.invoke('opcua:browse', opts),
  /** @param {{nodeIds: string[]}} opts @returns {Promise<{error: string, nodes?: {dataType: string, access: number}[]}>} */
  describe: (opts) => ipcRenderer.invoke('opcua:describe', opts),
  /** @param {{writes: {nodeId: string, builtin: number, value: boolean|number}[], reads: string[]}} opts */
  exchange: (opts) => ipcRenderer.invoke('opcua:exchange', opts),
  /** @param {{link?: number}} [opts] */
  close: (opts) => ipcRenderer.invoke('opcua:close', opts),
  /** @param {(e: {link: number, why: string}) => void} cb @returns {() => void} unsubscribe */
  onClosed: (cb) => {
    const listener = (_event, e) => cb(e)
    ipcRenderer.on('opcua:closed', listener)
    return () => ipcRenderer.removeListener('opcua:closed', listener)
  },
  /** @param {(e: {link: number, found: number}) => void} cb @returns {() => void} unsubscribe; a browse under way, and how many variables it has found */
  onProgress: (cb) => {
    const listener = (_event, e) => cb(e)
    ipcRenderer.on('opcua:progress', listener)
    return () => ipcRenderer.removeListener('opcua:progress', listener)
  },
})

// ...and through EtherNet/IP to a Logix controller, whose protocol libplctag speaks in main (eipIo.cjs). The app
// decides which tags travel and what their values mean (src/core/io/eip.ts); these are the library calls it makes.
contextBridge.exposeInMainWorld('oipEip', {
  /** @param {{gateway: string, path: string}} opts @returns {Promise<{error: string}>} */
  open: (opts) => ipcRenderer.invoke('eip:open', opts),
  /** @param {{tags: {name: string, bit: boolean}[]}} opts @returns {Promise<{error: string, tags?: {status: string, cip: number|null}[]}>} */
  bind: (opts) => ipcRenderer.invoke('eip:bind', opts),
  /** @param {{writes: {name: string, value: boolean|number}[], reads: string[]}} opts */
  exchange: (opts) => ipcRenderer.invoke('eip:exchange', opts),
  /** @param {{link?: number}} [opts] @returns {Promise<{error: string, status?: string, tags?: {name: string, type: number}[]}>} */
  tags: (opts) => ipcRenderer.invoke('eip:tags', opts),
  /** @param {{link?: number}} [opts] */
  close: (opts) => ipcRenderer.invoke('eip:close', opts),
})

// ...and over ADS to a TwinCAT runtime, through TwinCAT's own router by Beckhoff's TcAdsDll in main (adsIo.cjs). The app
// decides which symbols travel and what their values mean (src/core/io/ads.ts); these are the calls it makes.
contextBridge.exposeInMainWorld('oipAds', {
  /** @param {{netId: string, port: number}} opts @returns {Promise<{error: string, localNetId?: string, target?: string}>} */
  open: (opts) => ipcRenderer.invoke('ads:open', opts),
  /** @param {{tags: {name: string}[]}} opts @returns {Promise<{error: string, tags?: {code: number, adsType?: number, size?: number, typeName?: string}[]}>} */
  bind: (opts) => ipcRenderer.invoke('ads:bind', opts),
  /** @param {{writes: {name: string, value: boolean|number}[], reads: string[]}} opts */
  exchange: (opts) => ipcRenderer.invoke('ads:exchange', opts),
  /** @param {{link?: number}} [opts] @returns {Promise<{error: string, code?: number, symbols?: {name: string, adsType: number, size: number, typeName: string}[]}>} */
  symbols: (opts) => ipcRenderer.invoke('ads:symbols', opts),
  /** @param {{link?: number}} [opts] */
  close: (opts) => ipcRenderer.invoke('ads:close', opts),
})

// The simulated PLC's own OPC UA server, for a SCADA or HMI (opcUaServer.cjs). The app decides what is
// published and what a write does (src/editor/links/opcUaServer.ts); main only keeps the nodes.
contextBridge.exposeInMainWorld('oipOpcUaServer', {
  /** @param {{port: number, network: boolean}} opts @returns {Promise<{error: string, endpoint: string}>} */
  start: (opts) => ipcRenderer.invoke('opcuaserver:start', opts),
  /** @param {{nodes: {name: string, builtin: number, writable: boolean, value: unknown}[]}} opts @returns {Promise<{error: string}>} */
  define: (opts) => ipcRenderer.invoke('opcuaserver:define', opts),
  /** @param {{values: Record<string, unknown>, running: boolean}} opts */
  update: (opts) => ipcRenderer.send('opcuaserver:update', opts),
  stop: (opts) => ipcRenderer.invoke('opcuaserver:stop', opts),
  /** @param {(e: {name: string, value: unknown}) => void} cb @returns {() => void} unsubscribe */
  onWrite: (cb) => {
    const listener = (_event, e) => cb(e)
    ipcRenderer.on('opcuaserver:write', listener)
    return () => ipcRenderer.removeListener('opcuaserver:write', listener)
  },
  /** @param {(e: {clients: string[]}) => void} cb @returns {() => void} unsubscribe */
  onClients: (cb) => {
    const listener = (_event, e) => cb(e)
    ipcRenderer.on('opcuaserver:clients', listener)
    return () => ipcRenderer.removeListener('opcuaserver:clients', listener)
  },
})

// The agent door (mcpServer.cjs): main serves MCP on loopback and forwards each tool call here; the app runs it
// against the open editor (src/editor/agent/) and answers. Main never sees what a tool does.
contextBridge.exposeInMainWorld('oipAgent', {
  /** Announce the tool list; null withdraws it. @param {Array<{name: string, description: string, inputSchema: object}> | null} tools */
  serve: (tools) => ipcRenderer.send('agent:tools', tools),
  /** @param {(call: {id: number, name: string, args: unknown}) => void} cb @returns {() => void} unsubscribe */
  onCall: (cb) => {
    const listener = (_event, call) => cb(call)
    ipcRenderer.on('agent:call', listener)
    return () => ipcRenderer.removeListener('agent:call', listener)
  },
  /** main's own project tools (agentProjects.cjs) asking the editor to open or start a project; answered with reply
   *  @param {(req: {id: number, op: string, args: unknown}) => void} cb @returns {() => void} unsubscribe */
  onShell: (cb) => {
    const listener = (_event, req) => cb(req)
    ipcRenderer.on('agent:shell', listener)
    return () => ipcRenderer.removeListener('agent:shell', listener)
  },
  /** @param {number} id @param {{ok: true, text: string, images?: Array<{data: string, mimeType: string}>} | {ok: false, error: string}} reply */
  reply: (id, reply) => ipcRenderer.send('agent:result', { id, reply }),
  /** the page is about to reload for a reason main cannot see (the dev server); said to an agent whose call it cuts off
   *  @param {string} why */
  leaving: (why) => ipcRenderer.send('agent:leaving', String(why)),
  /** capture_view: this window's pixels inside `rect` (CSS px). @returns {Promise<{data: string, mimeType: string} | null>} */
  capture: (rect) => ipcRenderer.invoke('agent:capture', rect),
  /** import_model: a .glb / .step / .stp file's bytes by absolute path. @returns {Promise<{name: string, bytes: Uint8Array} | {error: string}>} */
  readModel: (path) => ipcRenderer.invoke('agent:readModel', path),
  /** Settings > Agent connections: whether the door is open, and its URL. @returns {Promise<{enabled: boolean, url: string}>} */
  doorState: () => ipcRenderer.invoke('agent:doorState'),
  /** Turn the door on (main asks the user first) or off. @param {boolean} on @returns {Promise<{enabled: boolean, url: string, error?: string}>} */
  setDoor: (on) => ipcRenderer.invoke('agent:setDoor', on === true),
  /** the door opened or shut, from any window. @param {(state: {enabled: boolean, url: string}) => void} cb @returns {() => void} unsubscribe */
  onDoorChange: (cb) => {
    const listener = (_event, state) => cb(state)
    ipcRenderer.on('agent:doorChanged', listener)
    return () => ipcRenderer.removeListener('agent:doorChanged', listener)
  },
})

// The native application menu (main.cjs buildMenu) can't reach the editor store directly, so its
// app-level items (New / Open / Save / Undo / Run / …) send a `menu:command` string the renderer
// dispatches. Kept on its own `oipMenu` surface so it stays orthogonal to the parts bridge above.
contextBridge.exposeInMainWorld('oipMenu', {
  /**
   * Subscribe to native-menu commands. Returns an unsubscribe fn.
   * @param {(command: string, viaChord?: boolean) => void} cb
   */
  onCommand: (cb) => {
    const listener = (_event, command, viaChord) => cb(command, viaChord)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  },

  /**
   * Hand main the menu to build: the structure, labels and accelerators resolved from the renderer's
   * command registry (src/editor/commands.ts desktopMenuModel). Sent once, on mount.
   * @param {Array<object>} model
   */
  setMenu: (model) => ipcRenderer.send('menu:model', model),

  /**
   * {commandId: enabled} - main flips the matching menu items, so the native menu greys exactly when
   * the on-screen buttons do. Sent whenever the editor's state changes what's allowed.
   * @param {Record<string, boolean>} enabled
   */
  setMenuEnabled: (enabled) => ipcRenderer.send('menu:enabled', enabled),

  /**
   * Pop the native application menu at a point in the window, from the toolbar's menu button. The shell hides
   * the menu bar (main.cjs TITLE_BAR), so this is the pointer's way to the menu.
   * @param {number} x @param {number} y viewport-relative CSS px; main scales them by the zoom factor.
   */
  showAppMenu: (x, y) => ipcRenderer.send('menu:popup', { x, y }),

  /**
   * Paint a popped-out panel's caption strip (main.cjs popoutTitleBar) in its header row's colours, scrim and theme
   * included. Sent by the opener (components/popoutStrip.ts): the popup is about:blank, where this preload never runs.
   * @param {string} name the popup's window name (oip-popout-*) @param {string} color @param {string} symbol #rrggbb
   */
  setPopoutStrip: (name, color, symbol) => ipcRenderer.send('shell:popout-strip', name, color, symbol),

  /** Help > Check for Updates..., asked from the page (the newer-build banner): main checks and says what it found. */
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),

  /** The update downloaded and waiting to install (apps/desktop/updater.cjs): its version, or null. */
  updateState: () => ipcRenderer.invoke('app:updateState'),

  /** Hear that an update finished downloading. Returns an unsubscribe fn. @param {(version: string) => void} cb */
  onUpdateReady: (cb) => {
    const listener = (_event, version) => cb(version)
    ipcRenderer.on('app:updateReady', listener)
    return () => ipcRenderer.removeListener('app:updateReady', listener)
  },

  /** Restart onto the downloaded update. */
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),

  /** 'win32' | 'darwin' | 'linux' - the renderer insets its toolbar differently per platform's chrome. */
  platform: process.platform,
})

// Fullscreen drops the caption buttons (main.cjs sendFullScreen); toolbar.css stops reserving their room.
ipcRenderer.on('shell:fullscreen', (_event, on) => {
  document.documentElement.toggleAttribute('data-shell-fullscreen', on === true)
})

// The frame the app's toolbar first paints on. Until then this window is empty, or holds a bare
// document while the module graph loads, and the shell paints the caption strip to match that background
// (main.cjs TITLE_BAR). From then on the row those buttons sit in is the toolbar, so main repaints the
// strip in the toolbar's grey.
//
// Every cheaper signal is wrong, and each one was measured wrong here:
//   - ready-to-show fires when the renderer is ready, ~1s before the page's first frame for a window that
//     is already on screen;
//   - a bare requestAnimationFrame fires on the first frame of a document that has not been parsed yet, and on
//     the about:blank a BrowserWindow starts on;
//   - DOMContentLoaded fires after the module graph but before React has committed anything.
// The strip matches the toolbar, so the signal is the toolbar: #root gaining a child, plus a frame for it to
// paint in.
const FIRST_PAINT_GIVE_UP_FRAMES = 1800 // ~30s at 60Hz; an app that never mounts keeps the empty-window strip

// Light or dark, as the page resolved it, so main can paint the caption strip and the frame to match.
// The page's own choice is <html data-theme> (src/editor/appearance.ts, stamped before the boot skeleton
// paints); without one it follows the OS, which is what prefers-color-scheme reports in here. Read from
// the page rather than asked of it, so the renderer needs no idea it is running in a shell.
// The second half says whether that was the person's explicit choice: main remembers only an explicit one
// for the next launch's first frame, so a 'System' page keeps following the OS from launch to launch.
function pageChoice() {
  const t = document.documentElement && document.documentElement.dataset.theme
  return t === 'light' || t === 'dark' ? t : null
}

function pageTheme() {
  return pageChoice() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
}

function followPageTheme() {
  // keyed on the choice too: Light -> System on a light OS changes nothing on screen, but it changes
  // what the next launch should start in
  const key = () => `${pageTheme()}|${pageChoice()}`
  let last = key()
  const check = () => {
    const now = key()
    if (now === last) return
    last = now
    ipcRenderer.send('shell:theme', pageTheme(), pageChoice() !== null)
    // main just repainted the strip undimmed in the new theme; a scrim still over it (Settings is where
    // the theme is switched) has to be re-applied on top. getComputedStyle already sees the new theme.
    refreshStrip(true)
  }
  new MutationObserver(check).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', check)
}

// The OS paints the caption strip on top of the page. A dialog's scrim (.author-backdrop and similar
// translucent layers over the whole window) dims the toolbar but cannot dim the strip, which would stay
// at full brightness in the corner until the dialog closes. So the strip copies what the page shows
// under it: hit-test the point beneath the buttons, composite every layer stacked above the toolbar
// there over the toolbar's own colours, and send main the result (null = nothing above it, the
// plain toolbar). Read from the page rather than from a list of dialogs, so a new modal needs nothing.
const STRIP_PROBE_FROM_RIGHT = 24 // px in from the right edge, y below: inside the button strip
const STRIP_PROBE_Y = 20

/** A computed CSS colour as [r, g, b (0-255), a (0-1)], or null for anything this doesn't read. */
function parseColor(s) {
  const m = /^(rgba?|color)\((.*)\)$/.exec(String(s).trim())
  if (!m) return null
  let body = m[2]
  const srgb = m[1] === 'color'
  if (srgb) {
    if (!body.startsWith('srgb ')) return null
    body = body.slice(5)
  }
  const n = body.split(/[\s,/]+/).filter(Boolean).map(Number)
  if (n.length < 3 || n.some(Number.isNaN)) return null
  const k = srgb ? 255 : 1
  return [n[0] * k, n[1] * k, n[2] * k, n.length > 3 ? n[3] : 1]
}

const over = (top, a, under) => [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a))
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

/** Dims the hit test cannot see, declared by the page with `data-strip-dim`: "fill" = a pointer-events:none
 *  layer (elementsFromPoint skips those) whose background covers its own box, "shadow" = a spotlight whose
 *  spread box-shadow dims everything outside its box (the tutorial's). Each as an [r, g, b, a] over the strip. */
function declaredDims() {
  const x = innerWidth - STRIP_PROBE_FROM_RIGHT
  const y = STRIP_PROBE_Y
  const out = []
  for (const el of document.querySelectorAll('[data-strip-dim]')) {
    const r = el.getBoundingClientRect()
    const inside = x >= r.left && x < r.right && y >= r.top && y < r.bottom
    const s = getComputedStyle(el)
    let c = null
    // a fill the hit test can see is already composited by stripColours
    if (el.dataset.stripDim === 'fill' && inside && s.pointerEvents === 'none') c = parseColor(s.backgroundColor)
    else if (el.dataset.stripDim === 'shadow' && !inside) {
      const m = /^(rgba?\([^)]*\)|color\([^)]*\))/.exec(s.boxShadow)
      c = m && parseColor(m[1])
    }
    const a = c ? c[3] * Number(s.opacity) : 0
    if (a > 0) out.push([c[0], c[1], c[2], a])
  }
  return out
}

/** [strip colour, symbol colour] as #rrggbb, or null when nothing covers the toolbar there. */
function stripColours() {
  const bar = document.querySelector('.toolbar')
  if (!bar) return null
  const above = []
  for (const el of document.elementsFromPoint(innerWidth - STRIP_PROBE_FROM_RIGHT, STRIP_PROBE_Y)) {
    if (bar.contains(el) || el === document.body || el === document.documentElement) break
    above.push(el)
  }
  const dims = declaredDims()
  if (!above.length && !dims.length) return null
  const barStyle = getComputedStyle(bar)
  let bg = parseColor(barStyle.backgroundColor)
  let fg = parseColor(barStyle.color)
  if (!bg || !fg) return null
  let covered = false
  // declared dims first, as the bottom layers: a dialog stacked over the tour composites on top of them
  for (const c of dims) {
    covered = true
    bg = over(c, c[3], bg)
    fg = over(c, c[3], fg)
  }
  for (let i = above.length - 1; i >= 0; i--) {
    const s = getComputedStyle(above[i])
    const c = parseColor(s.backgroundColor)
    const a = c ? c[3] * Number(s.opacity) : 0
    if (!(a > 0)) continue
    covered = true
    bg = over(c, a, bg)
    // a scrim dims the buttons with everything else; an opaque layer has its own text colour instead,
    // and compositing onto it would draw the buttons in the layer's own colour - invisibly
    const text = a >= 1 ? parseColor(s.color) : null
    fg = text || over(c, a, fg)
  }
  return covered ? [hex(bg), hex(fg)] : null
}

let lastStrip = null
let stripQueued = false
function refreshStrip(force) {
  const colours = stripColours()
  const key = colours ? colours.join() : ''
  if (!force && key === lastStrip) return
  lastStrip = key
  ipcRenderer.send('shell:strip', colours ? colours[0] : null, colours ? colours[1] : null)
}

function watchStrip() {
  // one hit test per frame at most, however many mutations a React commit makes
  const queue = () => {
    if (stripQueued) return
    stripQueued = true
    requestAnimationFrame(() => {
      stripQueued = false
      refreshStrip(false)
    })
  }
  new MutationObserver(queue).observe(document.body, { childList: true, subtree: true })
  // a declared dim can switch its surround on and off by class without remounting (the tour's `dim: false` steps)
  new MutationObserver(queue).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'data-strip-dim'] })
  // a scrim that fades in reads transparent on the frame it mounts; re-read when the fade ends
  document.addEventListener('transitionend', queue, true)
  document.addEventListener('animationend', queue, true)
  addEventListener('resize', queue)
}
// The app's document, served either way: http(s) from a dev or preview server, or the packaged app's own
// scheme (distProtocol.cjs, shellTrust.cjs APP_SCHEME). Not a popout's about:blank or the licenses file://.
if (location.protocol.startsWith('http') || location.protocol === 'oip:') {
  let frames = 0
  const watch = () => {
    // Either shell counts, because the strip matches the row it sits in and both draw that row. The boot
    // skeleton paints a 48px --panel band from static markup (app/index.html), and the real toolbar
    // replaces it in the same frame the skeleton is removed. Watching only #root would leave the strip
    // on the loading grey for the ~1s between them: a dark patch in a band that is already the
    // toolbar's colour. verify-desktop-launch.mjs checks for that mismatch.
    const root = document.getElementById('root')
    if (document.getElementById('boot-skeleton') || (root && root.children.length)) {
      requestAnimationFrame(() => ipcRenderer.send('shell:painted', pageTheme(), pageChoice() !== null))
      followPageTheme()
      watchStrip()
      return
    }
    if (++frames < FIRST_PAINT_GIVE_UP_FRAMES) requestAnimationFrame(watch)
  }
  requestAnimationFrame(watch)
}

