// Is this part code one this app has shipped, in this build or an earlier one? A collab room keeps a snapshot of
// every built-in part it places, code included, so after a deploy changes a built-in's behavior every older room
// holds code this build does not ship. Without this, the room's code-trust gate (collab/codeTrust.ts) would take
// that for a stranger's code and ask about it, which would be the most common prompt in a room of only built-ins.
//
// shippedBehaviorHashes.ts is the SHA-256 of every first-party behavior.ts in git history plus the working tree,
// written by scripts/shipped-behaviors.mjs and append-only (shippedBehaviors.test.ts fails when a current behavior
// is missing). Loaded only when joining a room, so a solo session never fetches it.

import { sha256Hex } from '../../core/sha256'

/** resolves to a test for "this source is first-party code from some build", memoized per source */
export async function loadShippedBehaviors(): Promise<(source: string) => boolean> {
  const { SHIPPED_BEHAVIOR_HASHES } = await import('./shippedBehaviorHashes')
  const known = new Set(SHIPPED_BEHAVIOR_HASHES)
  const seen = new Map<string, boolean>()
  return (source) => {
    let shipped = seen.get(source)
    if (shipped === undefined) {
      shipped = known.has(sha256Hex(source))
      seen.set(source, shipped)
    }
    return shipped
  }
}
