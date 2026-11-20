// A phone that would open on an empty scene opens on the demo instead.
//
// Phones are view/select/run only (App.tsx: no catalog, no transform tools, no tour), so an empty scene there is a
// dead end: nothing to place, nothing to run, and the one useful thing, the example, three taps away in the Project
// menu. The demo boot (`/app/?scene=demo`, main.tsx) is an ephemeral view that saves nothing until an edit forks it,
// so opening it on a phone loses nothing.
//
// Only on a fresh navigation. Every path that deliberately opens a project reloads into it (documentStore
// openDocument / createDocument, sceneFile leaveDemo), so a reload means someone chose what is on screen; bouncing
// them from an empty project they just made or opened back into the demo would undo that choice.

import { sceneHasWork } from '../tutorial/session'

/** The phone tier: ≤560px on the short side. App.tsx drops authoring below it; tablets keep the full touch editor. */
export const PHONE_QUERY = '(max-width: 560px), (orientation: landscape) and (max-height: 560px)'

export interface PhoneDemoInputs {
  /** the viewport is in the phone tier ({@link PHONE_QUERY}) */
  phone: boolean
  /** this page load is a fresh navigation, not a reload or a back/forward */
  freshNavigation: boolean
  /** the stored project, or null on a first visit */
  stored: { scene: { parts: readonly { type: string }[] }; stProgram: string } | null
  /** a stored project exists but could not be opened: its banner owns the screen, so the boot is left alone */
  unopened: boolean
}

/** Should this solo boot open the demo instead of the stored (or blank) project? */
export function phoneOpensDemo({ phone, freshNavigation, stored, unopened }: PhoneDemoInputs): boolean {
  if (!phone || !freshNavigation || unopened) return false
  return stored === null || !sceneHasWork(stored)
}

/** The browser's verdict on this page load. A missing entry (an old engine) counts as fresh; a throw counts as a
 *  reload, so the stored project opens instead of the demo. */
export function isFreshNavigation(): boolean {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return nav === undefined || nav.type === 'navigate'
  } catch {
    return false
  }
}

/** Is the viewport in the phone tier right now? */
export function isPhoneViewport(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches
  } catch {
    return false
  }
}
