// The live snap's stickiness policy: which snap the preview shows on this pointer-move, given the join it showed on
// the last one. Pure, so it is tested without a controller (liveSnap.test.ts); controller/snapRest.ts applyLiveSnap feeds it.

import type { SnapCandidate } from '../../core/snap/snapFeatures'
import { SNAP_MIN_SWITCH_MS, SNAP_SWITCH_MARGIN, SNAP_SWITCH_MIN_GAIN } from '../../core/types'

/** a join's identity: the target, the connector that made it, and (a conveyor) which ends meet */
export function joinKey(c: SnapCandidate | null): string | null {
  return c === null ? null : `${c.targetId}|${c.via ?? ''}|${c.join ?? ''}`
}

/** `best` beats `held` by enough to be worth moving the preview: a fraction of the held cost, and a floor so
 *  two near-zero costs never trade places */
export function clearlyBetter(best: SnapCandidate, held: SnapCandidate): boolean {
  return best.cost < held.cost - Math.max(SNAP_SWITCH_MIN_GAIN, SNAP_SWITCH_MARGIN * held.cost)
}

/**
 * Which snap to show.
 *
 * `held` is the join the preview showed last, re-solved at this pose (findSnapToTarget with `opts.hold`, which keeps
 * a conveyor join engaged out to its release distance), or null when it no longer engages at all. `best` is a
 * fresh search at the ordinary engage distance. The held join stays until something clearly cheaper appears and
 * the last switch is at least SNAP_MIN_SWITCH_MS old, which covers another join on the same conveyor (its end vs
 * its flank) as much as another part: a preview that flips between two near-equal joins on every small correction
 * is exactly what the user is trying to settle when they let go.
 */
export function chooseLiveSnap(
  held: SnapCandidate | null,
  best: SnapCandidate | null,
  now: number,
  lastChange: number,
): SnapCandidate | null {
  if (held === null) return best
  if (best === null || joinKey(best) === joinKey(held)) return held
  return clearlyBetter(best, held) && now - lastChange >= SNAP_MIN_SWITCH_MS ? best : held
}
