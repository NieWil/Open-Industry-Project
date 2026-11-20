# The desktop shell: design notes

The Electron shell ([apps/desktop/](../apps/desktop/)) wraps the same TS core as the web app. The commands to
run, package and release it are in [its README](../apps/desktop/README.md). This doc explains how the shell
works: its window, what a packaged build changes, updates, signing, links and files from outside, and which
pages may reach the main process.

## What a launch shows

The window is shown as soon as it is created, painted in `--bg` by `backgroundColor`, and the page
fills it in. The boot skeleton in `app/index.html` draws the app's outline from static markup at
~600-700ms, React commits the real shell over it, and `ViewportLoadingCover` holds the viewport until
the building is textured. There is no `ready-to-show` wait. Showing early is safe because the frame
paints before any document does, so there is no white flash to hide.

There is no splash window, because it would have nothing to cover. The wait it would cover (the dev
server) happens before Electron starts at all, since `launch.cmd` polls `:5173` first, and the skeleton
covers the few hundred ms after that. See the note at the top of `main.cjs` for the full reasoning,
including why a splash could never be sized to line up with the page.

## Icon

`oip-logo.ico` is passed as `icon:` to the window. Without it Electron falls back to the icon
compiled into `electron.exe` (the Electron atom) in the taskbar, alt-tab and window corner.

Regenerate it with `npm run desktop-icon` ([scripts/gen-desktop-icon.mjs](../scripts/gen-desktop-icon.mjs)),
which renders each size from the vector `public/oip-icon.svg`. Read that file's header before
changing it. Trimming the artboard margin, reducing through a supersample rather than rasterizing
straight to 16px, and sharpening after reduction each decide whether the small sizes
read as boxes-on-a-pallet or as a brown blob. It emits 16/24/32/48/64/128/256. The 24 is the Windows
taskbar size at 100% scaling; without it, Windows synthesizes it from the 32.

That is the **runtime** icon only. The icon on the `.exe` comes from packaging (`build.win.icon`, the
same file; see the README's "Package" section). For an unpackaged shell:
- The desktop shortcut. It targets `launch.vbs`, so it shows the Windows Script Host icon until you
  set it by hand: shortcut → Properties → Change Icon… → point at the shell folder's `oip-logo.ico`.

Unpackaged, Windows groups the taskbar button under `electron.exe`'s identity. A packaged app sets its
AUMID (`app.setAppUserModelId()`); the unpackaged one doesn't, because an AUMID with no
installed Start Menu shortcut behind it has its own pinning quirks.

## Window chrome: one row, not three

Without changes, Windows stacks an OS title bar, a menu bar and the app's own 48px toolbar before the first
pixel of viewport. `TITLE_BAR` in [main.cjs](../apps/desktop/main.cjs) collapses that. `titleBarStyle: 'hidden'`
drops the OS bar, `titleBarOverlay` repaints just minimize/maximize/close over the app's toolbar, and
`autoHideMenuBar` hides the menu row (Alt still shows it). macOS is different, because its menu belongs to the
screen, not the window. So it gets `hiddenInset` and keeps the system menu bar, and the traffic lights float
over the same toolbar.

That gives the page two jobs the frame would otherwise do, both in `styles.css` under `.app.desktop-shell`
(the class App.tsx stamps from `DESKTOP_SHELL`):

- **Drag.** `-webkit-app-region: drag` on `.toolbar`, and `no-drag` on every control inside it. If the
  opt-out is missing, the control still looks right but its clicks move the window instead, with no error.
  So [e2e/verify-desktop-titlebar.mjs](../e2e/verify-desktop-titlebar.mjs) asserts both regions
  and that Run still starts the sim.
- **Room for the buttons.** The caption strip is inside the row, so the toolbar's right padding
  comes from `env(titlebar-area-*)`, Chromium's own report of what the overlay took.

The row also carries less here than on the web. New / Save / Load / Demo are hidden, because on the
desktop they're File-menu items with accelerators and the menu is one click away in the same row. The caption
strip takes about 150px and hiding those four gives about 300px back, which is why the right-hand controls still clear
the window buttons on a 1000px window. The browser keeps them, because it has no menu and the toolbar is the
only place they exist.

With the menu bar hidden, the toolbar's mark is the only pointer path to File/Edit/Simulation.
It calls `showAppMenu` (preload) → `menu:popup` (main) → `Menu.getApplicationMenu().popup()`, so it
pops the one application menu rather than a copy that could drift. Accelerators are unaffected, because a
hidden menu bar still registers them.

A **popped-out panel** (the PLC panel's own window) gets the same one row on Windows/Linux.
`popoutTitleBar` hides its OS bar and paints the buttons over the panel's header row (`[data-titlebar]`).
`.popout-titlebar` in `styles.css` moves that row to the top edge, pins it to `POPOUT_TITLE_BAR_HEIGHT` and
makes it the drag region. One difference: the popup is `about:blank`, where **this preload never runs**, so its
strip colour is reported by the opener ([popoutStrip.ts](../src/editor/components/popoutStrip.ts) →
`setPopoutStrip` → `shell:popout-strip`, routed by window name). macOS keeps the system bar on a popout.
Gated by [e2e/verify-popout-titlebar-electron.mjs](../e2e/verify-popout-titlebar-electron.mjs).

## The menu is the renderer's

`buildMenu()` in main holds no app labels. [src/editor/commands.ts](../src/editor/commands.ts) is the
registry: every app-level command's label, chord and the single rule for when it's allowed, plus the
File/Edit/Simulation/View/Help structure that arranges them. The renderer sends that across as data
(`menu:model`) and main renders it. When editor state changes what's allowed, `menu:enabled` carries
`{commandId: enabled}` and main updates the matching items. Clicking one sends its **command id** back
on `menu:command`, which the renderer dispatches through the same registry the toolbar and the
command palette use.

Main still owns what never touches the document: Electron roles, quit, and
the Help links. Before the model arrives (a second or two against a cold dev server) those are the
whole menu, rather than a stand-in copy of the app menu whose commands would dispatch
into a renderer that isn't listening yet.

Two rules worth knowing before you add an item:

- **`accelerator` vs `keys`.** A command with `accelerator` (Ctrl+N, F5) is one the menu binds. A
  command with `keys` names a [keymap.ts](../src/core/keymap.ts) action the app already binds, so
  main displays the chord with `registerAccelerator: false`. Registered in both places, every
  press would fire the command twice. `commands.test.ts` refuses a command that sets both, and
  [e2e/verify-desktop-menu.mjs](../e2e/verify-desktop-menu.mjs) checks that Ctrl+Z still undoes once.
- **Enablement belongs to the command.** Main cannot see the selection, so a menu item main enabled on its
  own (such as a hand-written Edit → Cut) would always be clickable and would silently do nothing.

## Several windows

Each window has one project open, and a project is open in one window at most. The app stays one process per
profile (`requestSingleInstanceLock`), and that process keeps which document and which folder each window has
(`windowDocs` / `windowRoots` in main.cjs; the page reports them on `window:document` and `project:attach`).

- **Opening a project that a window has open brings that window forward.** That covers a second launch naming the
  folder, Open Recent, File > Open Project Folder, a row in the projects list and the agent's `open_project`.
- **A second launch naming another folder opens a new window** (`openFolderWindow`). Main asks the focused window's
  page to do it (`project:openPathInNewWindow`), because the page owns the project format: it reads the folder, files
  it in the library under the folder's document, then asks main for a window on that document (`window:openDocument`,
  `desktopProjectBridge.openFolderInNewWindow`). The new window loads the app at `?doc=<id>` and boots straight into
  that document ([libraryDb.ts](../src/editor/project/libraryDb.ts) `pinTabDocument`). It never boots another
  window's project first, which would file that project's row from a stale copy.
- **The projects list** marks a project open in another window and brings that window forward when it is clicked.
  Each row has an "Open in a new window" button.
- **The menu shows the focused window's state.** `menu:enabled` is kept per window and applied when a window takes the
  focus (`browser-window-focus`). The menu bar itself is one, and a click goes to the focused window, as before.
- **The agent door drives the focused window** ([agent-tools.md](agent-tools.md)).
- **Ports are the user's to settle.** The PLC link settings, and with them the OPC UA server's and the Modbus
  listener's ports, are per machine, so two windows ask for the same port. The second one is told the port is in use
  by another window (`linkKeys.cjs` `heldByAnotherWindow`), and the user gives it a different port. Moving it on its own
  would leave a SCADA or a PLC set up for that port talking to the other project.

Gated by [e2e/verify-desktop-windows-electron.mjs](../e2e/verify-desktop-windows-electron.mjs).

## Which server the window loads

In the development shell (`npm start` in `apps/desktop/`) the window loads the dev server at
`http://localhost:5173`. Two environment variables change that:

- `OIP_DESKTOP_PROD=1` serves `dist/` through the app's own `oip://app/` scheme
  ([distProtocol.cjs](../apps/desktop/distProtocol.cjs)), the way an installed app does. `launch-prod.cmd` sets
  it. The scheme applies the same `_headers`, `_redirects` and `404.html` rules as the website
  ([pagesHost.cjs](../apps/desktop/pagesHost.cjs), shared with `e2e/_edge-server.mjs`).
- `DESKTOP_URL=<url>` points the window at any other server. Every e2e gate launches this way.
  `DESKTOP_COI=1` adds COOP/COEP headers to every response, so the page is cross-origin isolated whatever
  server it comes from.

## What a packaged build changes

The config is the `build` field of [apps/desktop/package.json](../apps/desktop/package.json) (electron-builder).
What a packaged app does differently from `npm start` is all in [main.cjs](../apps/desktop/main.cjs):

- **It always serves the build it carries** (`resources/dist`), over `oip://app/`. `DESKTOP_URL`,
  `DESKTOP_COI` and `OIP_DESKTOP_PROD` are ignored. A window here holds the preload's folder and socket bridges,
  so the user's environment must not choose what it loads.
- **The origin never changes.** The working project lives in the origin's storage, so the origin must stay the
  same across versions. That is why it is a scheme and not a loopback port. With a port, a taken port would
  mean a fresh, empty origin, and whatever held the port first would look like the app to the window.
- **Its own userData folder** (`%APPDATA%\Open Industry Project`, via `extraMetadata.productName`), apart from
  the development shell's, so trying a build never touches your development profile.
- **AUMID** `org.openindustryproject.simulator` (the `appId`), so the taskbar groups and pins it as itself.
- **Electron fuses** are set at package time: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`,
  asar integrity checked, and the app loaded only from its asar. So Playwright cannot launch a packaged build
  (`_electron` needs `--inspect`), and the e2e gates drive the development shell instead. A script can still
  attach over Chromium's `--remote-debugging-port`, which no fuse covers.
  [scripts/desktop-smoke.mjs](../scripts/desktop-smoke.mjs) `<executable>` starts a packaged build that way
  and checks that it boots: `oip://app/`, cross-origin isolation, the preload bridges, the native PLC links,
  and the loading cover lifting on a rendered scene. EtherNet/IP's libplctag ships with the app, so every run
  checks that it loads. ADS's TcAdsDll comes from the user's TwinCAT installation, so on a machine without
  TwinCAT (every CI runner) the smoke checks only that the channel is wired. Loading the DLL from a packaged
  build is checked only by running the smoke on a machine where TwinCAT is installed. The AI agent connection
  works against a packaged build too (`OIP_MCP_PORT` + `--user-data-dir`).
- **Every licence it redistributes travels with it**, shown under Help > Third-Party Licenses: the app's
  LICENSE and THIRD_PARTY_NOTICES.md, the texts of what the web build bundles (`dist/THIRD_PARTY_LICENSES.txt`,
  generated by the build), the texts of the shell's own dependencies (`THIRD_PARTY_LICENSES.desktop.txt`,
  generated by `npm run licenses`, which `pack` and `dist` run first), Electron's, and a link to Chromium's.
  Gated by `e2e/verify-desktop-licenses-electron.mjs`.
- **No service worker.** The app skips `UpdatePrompt` in the desktop shell. It is updated as an app, and a
  worker would be a second cache that could serve the build an update just replaced.

## Installing and updating

The Windows installer is one-click and per-user (`nsis.oneClick`). It installs to
`%LOCALAPPDATA%\Programs\open-industry-project` with no wizard and no admin rights, so there is no UAC prompt on
every update, which an all-users install would need.

Installed apps update themselves from the release feed (`build.publish`: Cloudflare R2 at
`downloads.openindustryproject.org/desktop/`) through [updater.cjs](../apps/desktop/updater.cjs). The app checks
quietly at launch and every few hours, downloads in the background, then shows a notice in the page
(`DesktopUpdateToast`) with a Restart button. It never shows a dialog, because a dialog that waits for an answer
blocks its window. Restart installs and reopens the new version. Otherwise the update installs when the app
quits. Both install silently (`quitAndInstall(true, true)`), so the installer's wizard never appears.
Help > Check for Updates... runs the same check and reports the result. Gated by
`e2e/verify-desktop-update-electron.mjs`.

An installed signed app refuses an update whose publisher is not `build.win.signtoolOptions.publisherName`. An
unsigned build, such as one tried against a local feed, has no publisher to check.

## Releasing and signing

[scripts/desktop-release.mjs](../scripts/desktop-release.mjs) holds every step of the Desktop workflow and says
what each step refuses. The workflow computes one version, builds Windows (signed) and Linux from the same commit
in parallel, launches each, and only then uploads. Every versioned file goes first, then both feed files, so the
two platforms move to the new version at the same moment. Without `upload` the run ends in a check of the files
instead. It still signs the Windows build, so each such run uses signatures. A push that touches the shell builds
and launches Linux only.

Signing is DigiCert KeyLocker through `smctl` ([sign.cjs](../apps/desktop/sign.cjs), used only by
[electron-builder.release.cjs](../apps/desktop/electron-builder.release.cjs), sha256 only so each file uses one
signature). The key stays in DigiCert's HSM. The runner holds only what lets it ask for a signature, in the
repository secrets `SM_API_KEY`, `SM_CLIENT_CERT_FILE_B64` (the client certificate's .p12, base64) and
`SM_CLIENT_CERT_PASSWORD`. Every executable is verified, timestamp included, and its publisher must be
`build.win.signtoolOptions.publisherName`, which installed apps check every update against.

As a fallback, `npm run desktop:release` (`-- --upload`) builds, signs and publishes Windows alone from a machine
with smctl set up. It uploads over that machine's own connection.

## Installers and collaboration rooms

A collab room is claimed by the newest build that joins it, and older clients go view-only
(`ROOM_BUILD_META` in `src/collab/schema.ts`). On the web this resolves itself, because a deploy follows every
push and a reload loads it. An installer carries its build, so it does not:

- An installer made from a commit the site has not deployed would claim every room it joins, and every browser
  in those rooms would go view-only until a deploy catches up. So `npm run desktop:dist` runs
  [scripts/desktop-release-check.mjs](../scripts/desktop-release-check.mjs) first. It requires a clean tree and
  HEAD already on origin/main. `OIP_DESKTOP_UNRELEASED=1` overrides it, for an installer that will never join a
  shared room. `npm run pack` is unchecked, for trying a build locally.
- An older installed app in a newer room is told to update the app, not to reload, because a reload loads the
  same version and the banner comes straight back. That is `NewerBuildBanner`'s desktop variant. Its button runs
  the shell's own update check (`getDesktopUpdate` in `src/editor/desktop/desktopMenuBridge.ts`, then
  [updater.cjs](../apps/desktop/updater.cjs)). `DESKTOP_UPDATE_URL` (the site, opened in the OS browser) is only
  the fallback for a shell with no update bridge.

## Linux packages

The Desktop workflow's `linux` job (`desktop-release.mjs --linux`, on Ubuntu 24.04) builds two packages, because
one package cannot serve every distribution:

- **`.deb` (Debian and Ubuntu).** Ubuntu 24.04 and later restrict unprivileged user namespaces, which Chromium's
  sandbox needs. The .deb's install script (electron-builder's own postinst) adds an AppArmor profile that allows
  the app. Updates install through `pkexec`, so the user is asked for their password.
- **AppImage (other distributions).** It runs without installing but needs `libfuse2` (`libfuse2t64` on Ubuntu
  24.04). It cannot carry an AppArmor profile, so Ubuntu 24.04 and later refuse its sandbox. Point Ubuntu users at
  the .deb. An AppImage updates itself in place: the file is swapped for the new version's and relaunched.

The workflow launches both the way a user would, with `scripts/desktop-smoke.mjs`: the .deb installed with apt
under Ubuntu's namespace rules, and the AppImage under the same rules as an informational step that is expected to
fail. Nothing is signed. Linux has no publisher check, and electron-updater checks each download against the
feed's sha512 over HTTPS.

To try a package locally on Windows, build it in WSL (Ubuntu 24.04 with WSLg runs it): copy `apps/desktop`,
`dist/` and `public/icons/` into WSL's own filesystem, run `npm ci` there, and run electron-builder. WSL's kernel
has AppArmor off, so it cannot show the Ubuntu sandbox refusal. CI can.

macOS has a `mac` block in `build` but is not built. macOS will not open an unsigned, un-notarized app, so it
needs an Apple Developer ID certificate, notarization and a Mac to build on.

## Which pages may reach the main process

The rules are in [shellTrust.cjs](../apps/desktop/shellTrust.cjs). Every page in one of these windows gets the
preload's bridges, and `project:write` takes an absolute path, so only the app's own page may use them:

- `window.open` and `target=_blank`: a popped-out panel opens in a window, a web link opens in the OS browser,
  and anything else opens nowhere. Without this, a link such as the toolbar's GitHub link would open GitHub in an
  app window with the preload.
- Navigation: a window never leaves the app's origin. A web link goes to the OS browser instead.
- IPC: every handler is registered through `guardIpc`, which refuses anything but the top frame of a page on the
  app's origin. This is a second layer of defence behind the two rules above.
- Permissions (pointer lock, WebXR, fullscreen and so on) are granted to the app's origin only.

Gated by `e2e/verify-desktop-trust-electron.mjs`. The rules themselves are tested by `node shellTrust.test.cjs`.

## Links from a browser

The installer registers `openindustry://` with the OS. On Windows that is
[installer.nsh](../apps/desktop/installer.nsh) (per-user registry keys, removed on uninstall), because
electron-builder's NSIS target ignores `build.protocols`. `build.protocols` covers the `.deb` (an
`x-scheme-handler` line) and macOS. An AppImage registers nothing.

On an installed build, a link fired through the Windows shell handler cold-starts the app in the room. A second
link goes to the running window, which moves rooms while the second copy quits. In a room, the browser's
Help > Open in Desktop App fires `openindustry://open?room=<room>`
([desktopLink.ts](../src/editor/desktop/desktopLink.ts)). Outside a room it hands over the project, since a link cannot
carry it. It fires `openindustry://open?handoff=<secret>` and uploads the project's `.oip` bytes to that private
document on the collab server ([handoff.ts](../src/collab/handoff.ts)). The desktop app boots at `?handoff=`,
waits for the bytes, asks the user (the link is web input, and a project carries part code), imports them as
File > Import would, and clears the document ([desktopHandoff.ts](../src/editor/desktop/desktopHandoff.ts)). From then on
the two are separate copies. If the page keeps the focus for 2 s, it says the app did not open, offers the
download, and clears its upload.

[deepLink.cjs](../apps/desktop/deepLink.cjs) reads the link. It is web input, so it can say only "open" and
"join this room", and the room must have the shape Share creates. A launch link becomes the first window's URL. A
second launch moves the focused window into the room (the page saves on `pagehide`, as when Share moves it). A
link is never read as a folder (`projectFolderArg` skips it). The development shell does not register the scheme
unless `OIP_DEEP_LINK=1` is set, because registering rewrites the OS's per-user handler. Gated by
[e2e/verify-desktop-deep-link-electron.mjs](../e2e/verify-desktop-deep-link-electron.mjs) and
[e2e/verify-desktop-handoff-electron.mjs](../e2e/verify-desktop-handoff-electron.mjs) (against the real collab
server), which pass the link on the command line in place of the OS. The registration itself shows only in an
installed build.

## Project and part files

The installer also registers `.oip` (a project) and `.oippart` (one part) with the OS
(`build.fileAssociations`). On Windows, electron-builder's NSIS target writes them itself, per-user, as
`OpenIndustryProject.Project` and `OpenIndustryProject.Part`. Unlike `protocols`, its NSIS template reads
`fileAssociations` (checked against app-builder-lib 26.15), so no `installer.nsh` entry is needed. A
double-click hands the path to the app on its command line (`open-file` on macOS). A second launch hands it to
the focused window and quits. [fileOpen.cjs](../apps/desktop/fileOpen.cjs) reads the file and gives the
renderer its bytes, never the path. [desktopFileOpen.ts](../src/editor/desktop/desktopFileOpen.ts) imports them
through the app's own import paths: a `.oip` as File > Import Project does (it asks, and the open project is
kept under Projects), and a `.oippart` into the open project's parts as Import part does. Neither file is ever
written back. Gated by `e2e/verify-desktop-file-open-electron.mjs` from the path onward. The registration
itself shows only on an installed build.

## Scripted runs

`electron smoke.cjs` against the dev server checks that the full editor runs in Electron. Physics is WASM Jolt
here too. There is no native Jolt addon or native physics-to-render bridge in this shell.

For scripted or headless runs, clear `ELECTRON_RUN_AS_NODE` first. Otherwise Electron runs the script as plain
Node, and `require('electron')` returns a path string (`app` is undefined).
