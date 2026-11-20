import { defineMessages, t } from '../../core/i18n'
import type { EditorStore } from '../store/store'

const M = defineMessages('pilotFab', {
  title: 'Pilot Mode: first-person walk-around',
  enter: 'Enter pilot mode',
})

function PilotIcon() {
  // a standing figure - enter first-person walk-around
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="3" r="2" />
      <path d="M8 6c-1.66 0-3 1.34-3 3v3h1.5v3h3v-3H11V9c0-1.66-1.34-3-3-3z" />
    </svg>
  )
}

/**
 * Floating "enter pilot mode" button for touch devices. The toolbar can't fit its icon buttons on a
 * phone (they overflow off the right edge), so the first-person walk-around gets a dedicated FAB in
 * the bottom-right of the viewport instead. Rendered by App only on touch + when not already piloting;
 * once inside pilot mode the on-screen joystick / Exit button take over.
 */
export function PilotFab({ store }: { store: EditorStore }) {
  return (
    <button
      className="pilot-fab"
      title={t(M.title)}
      aria-label={t(M.enter)}
      onClick={() => store.enterPilot()}
    >
      <PilotIcon />
    </button>
  )
}
