// The Electron shell's `window.oipParts` surface (apps/desktop/preload.cjs): the part-folder payloads and the
// typed accessor for the preload API. This is the only module that touches the browser global. A folder of parts
// is something to import into the project's parts (editor/parts/packageSource.ts), and a library part's files are the
// project folder's, kept by the folder sync (editor/parts/externalEditor.ts) - the shell keeps no parts of its own. On the
// web (no window.oipParts) getOipPartsApi() returns null and every desktop entry point is an inert no-op.

/** One part folder as read by the main process (apps/desktop/partsWorkspace.cjs). */
export interface PartFile {
  dir: string
  id: string
  name: string
  manifestJson: string
  behaviorSource: string
}

/** A folder of parts as the shell scanned it (Import part > A folder of parts…, window.oipParts.pickWorkspace). */
export interface WorkspaceScan {
  root: string
  parts: PartFile[]
  problems: { dir: string; message: string }[]
}

/** The surface preload.cjs exposes on window. Kept in sync with apps/desktop/preload.cjs by hand. */
export interface OipPartsApi {
  /** Pick a folder of parts and scan it (null: cancelled). The renderer imports what it finds. */
  pickWorkspace(): Promise<WorkspaceScan | null>
  /** Open a part folder's behavior.js in an external editor ('' or a reason). Optional: absent on older preloads. */
  openScript?(dir: string): Promise<string>
  /** The parts in the old profile-wide custom-parts folder, names only, to mention once. Optional: older preloads. */
  legacyParts?(): Promise<{ root: string; names: string[] }>
  /** Reveal a part folder's behavior.js in the OS file manager. Optional: absent on older preload builds. */
  revealPart?(dir: string): Promise<string>
}

declare global {
  interface Window {
    oipParts?: OipPartsApi
  }
}

/** The desktop parts API, or null when not running inside the Electron shell (i.e. the browser). */
export function getOipPartsApi(): OipPartsApi | null {
  return typeof window !== 'undefined' && window.oipParts ? window.oipParts : null
}
