import type { PartInstance } from './types'
import { STAIRS_LANDING_DEPTH } from './types'
import { getPackage, isAuthoritativePackage } from './parts/partRegistry'
import { toWorldXZ } from './parts/partGeometry'
import { computeStructureConnections } from './structureConnections'

export const STAIRS_PACKAGE_ID = 'oip.stairs'

/**
 * The app's Stairs meet a platform with the top of the flight, and the deck is the landing
 * (docs/part-snap-stairs.md). Older apps snapped the far end of the stair's own top landing to the edge instead, so the
 * flight stood STAIRS_LANDING_DEPTH out from the deck. A document names the built-in by id, so such a stair in an older
 * document stands a landing's depth short of the edge and connects to nothing.
 *
 * This finds those and moves each in by the landing depth: a stair running the app's built-in that meets no deck edge
 * where it stands, but would one landing depth further along its own +X. That pose is exactly what an older app's snap
 * produced, so a stair placed there on purpose was also a connected stair to its author. Idempotent: a moved stair
 * meets the edge, and is never a candidate again. A project's own copy of the part (`runsAsEmbedded`) keeps its seat.
 *
 * Returns the indices it moved; `parts` is updated in place.
 */
export function reseatOlderStairs(parts: PartInstance[], runsAsEmbedded: ReadonlySet<string>): number[] {
  if (runsAsEmbedded.has(STAIRS_PACKAGE_ID) || !isAuthoritativePackage(STAIRS_PACKAGE_ID)) return []
  // only an app whose stairs seat their flight top (contact x at the flight's run, no landing past it)
  const at = getPackage(STAIRS_PACKAGE_ID)?.snap?.edgeMount?.at
  if (!at || at[0] !== 0) return []
  const candidates = parts.flatMap((p, i) => (p.type === 'part' && p.packageId === STAIRS_PACKAGE_ID ? [i] : []))
  if (candidates.length === 0) return []
  const now = computeStructureConnections(parts)
  const moved: number[] = []
  for (const i of candidates) {
    const stair = parts[i]!
    if (now.stairTopConnected.has(stair.id)) continue
    const w = toWorldXZ(stair, STAIRS_LANDING_DEPTH, 0)
    const shifted: PartInstance = { ...stair, position: [w.x, stair.position[1], w.z] }
    const trial = parts.map((p, j) => (j === i ? shifted : p))
    if (!computeStructureConnections(trial).stairTopConnected.has(stair.id)) continue
    parts[i] = shifted
    moved.push(i)
  }
  return moved
}
