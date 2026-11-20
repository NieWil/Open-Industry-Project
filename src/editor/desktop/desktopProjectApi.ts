// The Electron shell's `window.oipProject` surface, typed (apps/desktop/preload.cjs is the other half,
// kept in sync by hand). A leaf module: the folder flows (desktopProjectBridge.ts) and the
// two-way sync (projectFolderSync.ts) both need it, and each needs the other, so the surface cannot
// live in either without a cycle.
//
// The shell only moves files and remembers which document lives in which folder. What a project is
// (core/project/projectFolder.ts) and which way a change flows (core/project/folderSync.ts) are decided in the
// renderer, so the shell never has a second opinion about either.

import type { ProjectFolderFile } from '../../core/project/projectFolder'
import type { FolderBaseline, FolderWriteOp, FolderWriteResult } from '../../core/project/folderSync'

/** A folder read for the renderer: its project files, and the document that folder already is. */
export interface FolderRead {
  root: string
  files: ProjectFolderFile[]
  /** the document id the app already knows this folder as, or null for a folder it has never opened */
  docId: string | null
  error?: string
}

/** What the shell remembers per document (apps/desktop/folderRegistry.cjs). */
export interface FolderRecord {
  docId: string
  /** absent on a detached row: the user unlinked the project from its folder on purpose */
  path?: string
  name?: string
  signature?: string
  /** null right after the app wrote the working copy from the folder: the next sync starts with the two equal */
  baseline?: FolderBaseline | null
  /** the working copy is the library's stand-in for an unreadable folder: the folder wins once readable */
  trustDisk?: boolean
  openedAt?: number
  detached?: boolean
}

export interface FolderRecordPatch {
  path?: string
  name?: string
  signature?: string
  baseline?: FolderBaseline | null
  trustDisk?: boolean
  /** move it to the top of File > Open Recent */
  touch?: boolean
}

export interface OipProjectApi {
  /** Native folder picker, then read it. null when cancelled; `error` on a read failure. */
  pickOpenFolder(): Promise<FolderRead | null>
  /** Native folder picker for saving into. Writes nothing. null when cancelled. */
  pickSaveFolder(): Promise<null | { root: string; hasProject: boolean; docId: string | null }>
  readAt(root: string): Promise<FolderRead | null>
  signature(root: string): Promise<{ signature: string } | { error: string }>
  write(root: string, ops: FolderWriteOp[]): Promise<FolderWriteResult>
  writeSync(root: string, ops: FolderWriteOp[]): FolderWriteResult
  /** a new, empty project folder: under the default projects folder, or beside `beside` (a folder the app already
   *  works in - the scenes split out of an older project go next to it, projectSplit.ts) */
  createFolder(name: string, beside?: string): Promise<{ root: string } | { error: string }>
  attach(root: string): void
  reveal(root: string): Promise<string>
  recall(docId: string): Promise<FolderRecord | null>
  folders(): Promise<FolderRecord[]>
  remember(docId: string, patch: FolderRecordPatch): Promise<void>
  rememberSync(docId: string, patch: FolderRecordPatch): boolean
  detach(docId: string): Promise<void>
  forget(docId: string): Promise<void>
  takePendingOpen(): Promise<string | null>
  onOpenPath(cb: (root: string) => void): () => void
  /** A folder to open in a window of its own (a second launch naming one). Absent on older shells. */
  onOpenPathInNewWindow?(cb: (root: string) => void): () => void
  /** Tell the shell which document this window has open, so it can bring that window forward instead of opening it
   *  twice. Absent on older shells. */
  showingDocument?(docId: string | null): void
  /** Bring forward the window that has document `docId` open, or open a new window on it. Absent on older shells. */
  openWindow?(docId: string): Promise<'focused' | 'opened'>
  /** Bring forward the window working in folder `root`; false when no window is. Absent on older shells. */
  focusFolder?(root: string): Promise<boolean>
  /** A project or part file the app was launched to open, once (apps/desktop/fileOpen.cjs). Absent on older shells. */
  takePendingFile?(): Promise<OpenedDocumentFile | null>
  /** A project or part file opened while the app runs (a double-click). Absent on older shells. */
  onOpenFile?(cb: (file: OpenedDocumentFile) => void): () => void
}

/** A project or part file the shell read for the renderer: its bytes and what it is, never its path. */
export type OpenedDocumentFile = { name: string; kind: 'project' | 'part'; bytes: Uint8Array } | { error: string }

declare global {
  interface Window {
    oipProject?: OipProjectApi
  }
}

/** The desktop project API, or null when not running inside the Electron shell (i.e. the browser). */
export function getOipProjectApi(): OipProjectApi | null {
  return typeof window !== 'undefined' && window.oipProject ? window.oipProject : null
}

/** The last segment of a folder path, for display ("C:\Projects\Line A" -> "Line A"). */
export function folderDisplayName(root: string): string {
  const parts = root.split(/[\\/]+/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? root
}
