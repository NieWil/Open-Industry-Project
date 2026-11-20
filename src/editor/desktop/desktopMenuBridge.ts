// The Electron shell's native application menu, as the renderer sees it. Traffic runs both ways:
// the renderer hands main the menu to build (structure, labels and accelerators resolved from
// editor/commands.ts, plus an enablement map as state changes), and main sends back the command id of
// whatever the user picked. That direction is what keeps a single definition - main holds no labels of
// its own beyond the items it owns outright (roles, parts folder, quit, help links).
// On the web (no window.oipMenu) getOipMenuApi() returns null and none of it is wired.


/** The surface preload.cjs exposes on window. Kept in sync with apps/desktop/preload.cjs by hand. */
export interface OipMenuApi {
  /** Subscribe to native-menu commands - the payload is a command id (editor/commands.ts). */
  onCommand(cb: (command: string, viaChord?: boolean) => void): () => void
  /**
   * Hand main the menu to build: labels, accelerators and structure resolved from the command
   * registry (commands.desktopMenuModel). Optional - a running shell can predate this bundle, and
   * then it keeps the bootstrap menu it built for itself.
   */
  setMenu?(model: unknown): void
  /** {commandId: enabled} - main flips the matching items, so the menu greys like the buttons do. */
  setMenuEnabled?(enabled: Record<string, boolean>): void
  /**
   * Pop the native application menu at a viewport point (CSS px) - the toolbar's menu button. Optional
   * because a running shell can be older than this bundle (the dev shell loads the vite server live),
   * and a missing menu button is better than a TypeError in the toolbar.
   */
  showAppMenu?(x: number, y: number): void
  /** Paint a popped-out panel's caption strip (#rrggbb), naming the popup by its window name (components/popoutStrip.ts).
   *  Optional for the same reason as showAppMenu. */
  setPopoutStrip?(name: string, color: string, symbol: string): void
  /** Help > Check for Updates..., asked from the page: main checks and says what it found (apps/desktop/updater.cjs). */
  checkForUpdates?(): Promise<void>
  /** The update downloaded and waiting to install: its version, or null (DesktopUpdateToast). */
  updateState?(): Promise<string | null>
  /** Hear that an update finished downloading. Returns an unsubscribe fn. */
  onUpdateReady?(cb: (version: string) => void): () => void
  /** Restart onto the downloaded update. */
  installUpdate?(): Promise<void>
  /** Host OS, for the per-platform window-chrome insets. Optional for the same reason as showAppMenu. */
  platform?: string
}

declare global {
  interface Window {
    oipMenu?: OipMenuApi
  }
}

/** The desktop menu API, or null when not running inside the Electron shell (i.e. the browser). */
export function getOipMenuApi(): OipMenuApi | null {
  return typeof window !== 'undefined' && window.oipMenu ? window.oipMenu : null
}

/**
 * Running inside the Electron shell? Read once at module load - preload injects window.oipMenu before
 * any of this bundle runs, so it can't flip later. The UI uses it wherever the desktop frame already
 * does a job the web page has to do itself: naming the app, and hosting the window controls.
 */
export const DESKTOP_SHELL = getOipMenuApi() !== null

/** True only in the shell on macOS, whose chrome differs (screen menu bar, traffic lights inset left). */
export const DESKTOP_MAC = getOipMenuApi()?.platform === 'darwin'

/**
 * Where a desktop user gets a newer build of the app (NewerBuildBanner): the shell's own update check, which
 * downloads and offers a restart (apps/desktop/updater.cjs). The site is the fallback for a shell too old to
 * have one.
 */
export const DESKTOP_UPDATE_URL = 'https://www.openindustryproject.org/'

export function getDesktopUpdate(): void {
  const check = getOipMenuApi()?.checkForUpdates
  if (check) void check()
  else window.open(DESKTOP_UPDATE_URL, '_blank')
}
