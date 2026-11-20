import { defineMessages, t } from '../../core/i18n'
import type { EditorState, EditorStore } from '../store/store'

const M = defineMessages('guardOpenings', {
  hintSelected: 'Opening selected: Delete removes it, or drag inside it to slide it.',
  hint: 'Drag along a guard to cut an opening. Drag a dot to resize one, drag inside it to slide it, click it to select.',
  title: 'Guard openings',
  doneTitle: 'Leave guard-openings mode (Esc or G)',
  done: 'Done',
})

interface GuardOpeningsBannerProps {
  store: EditorStore
  state: EditorState
}

/**
 * What says guard-openings mode (G) is on and how to work it. The mode swaps a conveyor's size handles for its
 * openings' dots and hides the move gizmo, so without this a person who pressed G by accident sees a conveyor that
 * has stopped resizing and no reason why. Shown only while the mode is on (store.sideGuardMode), which already
 * ends by itself when the selection leaves the conveyor.
 */
export function GuardOpeningsBanner({ store, state }: GuardOpeningsBannerProps) {
  if (!state.sideGuardMode) return null
  const hint = state.selectedGuardOpening
    ? t(M.hintSelected)
    : t(M.hint)
  return (
    <div className="guard-openings-banner" role="status" data-testid="guard-openings-banner">
      <span className="guard-openings-title">{t(M.title)}</span>
      <span className="guard-openings-hint">{hint}</span>
      <button type="button" className="guard-openings-done" title={t(M.doneTitle)} onClick={() => store.setSideGuardMode(false)}>
        {t(M.done)}
      </button>
    </div>
  )
}
