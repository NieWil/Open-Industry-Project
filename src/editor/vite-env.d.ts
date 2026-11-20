/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /** wss:// URL of the self-hosted Hocuspocus collaboration server (see docs/collab.md) */
  readonly VITE_COLLAB_URL?: string
}

import type { IRenderViewTestSurface } from '../render/viewport/view'
import type { SimClient } from '../sim/client'
import type { EditorController } from './controller'
import type { EditorStore } from './store/store'

declare global {
  /** the build's git identity, injected by vite.config.ts `define` - see editor/bench.ts */
  const __BUILD_ID__: string
  /** when the build's source was committed (unix seconds), which orders builds; 0 without git. vite.config.ts */
  const __BUILD_TIME__: number

  interface Window {
    /** dev/E2E hook, assembled in main.tsx and App's viewport effect */
    __oip?: {
      store?: EditorStore
      sim?: SimClient
      /** The E2E-visible view surface - IRenderView plus the members the verify fleet drives.
       *  Typed so `npm run check:e2e` can prove the fleet still agrees with the app (see
       *  IRenderViewTestSurface for why it is narrow). */
      view?: IRenderViewTestSurface
      controller?: EditorController
      /** offline catalog-thumbnail generator hook (npm run thumbnails) - renders every built-in card */
      getPartThumbnails?: () => Promise<Map<import('../core/types').PartType, string>>
      /** offline generator hook: renders every first-party bundled package card, as [packageId, dataUrl][] */
      getBundledThumbnails?: () => Promise<[string, string][]>
      /** registry lookup, exposed for E2E so a test can assert a package's live (edited) content */
      getPackage?: (id: string) => import('../core/parts/partPackage').PartPackage | undefined
      /** registry insert, exposed for E2E so a test can stand up a synthetic package (e.g. an SDK
       *  capability no shipped part opts into) without editing a built-in's declaration */
      registerPackage?: (pkg: import('../core/parts/partPackage').PartPackage, authoritative?: boolean) => boolean
      /** the ?xremu emulated WebXR headset (IWER XRDevice), for console/E2E driving */
      xrDevice?: import('iwer').XRDevice
      /** Open a project folder and keep it in sync both ways, bypassing the picker. showDirectoryPicker
       *  is a native OS dialog and cannot be driven from a test browser, so this takes the same structural
       *  handle the module works against (projectFolderLink.beginFolderLink). */
      linkFolder?: (dir: unknown) => Promise<string | null>
      /** the boot half of a folder link on its own (the restore that runs at mount), and Unlink */
      restoreFolder?: () => Promise<void>
      unlinkFolder?: () => void
      /** Save Project to Folder without its picker: write the project into a directory handle and keep the
       *  two in sync (projectFolderLink.saveProjectToFolderHandle). Returns an error, or null. */
      saveFolder?: (dir: unknown) => Promise<string | null>
      /** every URL a speculative warm fetched (catalog sweep, hover preload, thumbnails), with start
       *  times - the first-load gate uses it to tell the user's own bytes from speculation */
      speculativeFetches?: () => readonly { url: string; at: number }[]
      /** true while part GLBs / textures are still arriving. The positive settle signal a gate that
       *  counts or screenshots the finished scene waits on. A timed wait screenshots a half-built scene and
       *  still reads as a passing gate (see docs/e2e-and-budgets.md on the draw budget's staircase). Exposed in App.tsx. */
      assetsBusy?: () => boolean
      /** ?bench: the device benchmark's live result blob (editor/bench.ts), for verify-bench-mode */
      bench?: () => import('./bench').BenchResult | null
      /** The scene file's text, and Import Project's scene-file path: opening one as a new project named after
       *  `fileName` (returns an error message, or null). Exposed so a gate can prove a scene file re-opens and
       *  runs, PLC program included. No menu writes a scene file (Export Project does, trimmed); they still
       *  import, and the CLIs and agents read them. */
      sceneFileText?: () => string
      importSceneText?: (text: string, fileName: string) => Promise<string | null>
      /** Load a scene file over the active scene (no surface does this): how gates put a fixture
       *  on screen without growing the project's scene list. */
      loadSceneText?: (text: string) => string | null
      /** The two-way project folder (projectFolderSync.ts), for the gates: run a sync round now, settle a
       *  conflict, and read the folder the project lives in (a path on the desktop, a name in the browser). */
      folderSync?: {
        now: () => Promise<void>
        resolve: (side: 'disk' | 'mine') => Promise<void>
        path: () => string | null
      }
    }
  }
}
