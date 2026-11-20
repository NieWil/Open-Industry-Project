import type { EditorController } from '../controller'
import type { FollowState } from '../store/store'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('follow', {
  title: 'Click to stop following this part as it moves (or press F again).',
  following: 'Following {label}',
})

interface FollowBadgeProps {
  following: FollowState | null
  controller: EditorController | null
}

/**
 * The "Following X" viewport chrome. Shows in the top-left of the viewport while double-F follow
 * mode is tracking the selection; clicking the button stops following (as does pressing F again).
 */
export function FollowBadge({ following, controller }: FollowBadgeProps) {
  if (!following) return null
  return (
    <button
      type="button"
      className="follow-badge"
      title={t(M.title)}
      onClick={() => controller?.stopFollowing()}
    >
      {/* a target: ring + centre dot + four ticks, filled like every other editor icon */}
      <svg viewBox="0 0 16 16" fill="currentColor" fillRule="evenodd" aria-hidden="true">
        <path d="M8 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 1 0 0-7.6zm0 1.6a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 1 1 0-4.4zM7 8a1 1 0 1 0 2 0 1 1 0 1 0-2 0zM7.2.5h1.6v2.7H7.2zm0 12.3h1.6v2.7H7.2zM.5 7.2h2.7v1.6H.5zm12.3 0h2.7v1.6h-2.7z" />
      </svg>
      {t(M.following, { label: following.label })}
    </button>
  )
}
