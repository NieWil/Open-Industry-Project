import type { PartInstance } from './types'
import { conveyorEndsOf, isBeltLike } from './parts/partGeometry'
import { memoizeByParticipants } from './memoParts'

/**
 * Deck-merge clustering: conveyors butted end-to-end should have their running
 * surfaces built as one physics body so Jolt's enhanced internal edge removal
 * spans the seam (cargo flagged with edge removal never sees the seam as a real
 * lip, so it can't pop/snag crossing it, just as run<->bend seams within a
 * single belt ride flat). Edge removal does not cross separate bodies, so
 * without merging the seam between two parts produces ghost collisions.
 *
 * This finds the connected components of belt-like conveyors whose ends coincide and face into each other (a
 * collinear end-to-end butt - not a perpendicular T, which is a side merge handled by guard openings). The sim
 * builds one merged deck per multi-member cluster; lone conveyors are unaffected. Spurs/turntables/chain
 * transfers are excluded - they don't form end-to-end flow seams.
 */

export interface DeckCluster {
  /** the member whose build emits the merged deck body (lowest id, deterministic) */
  ownerId: string
  /** all conveyors in the cluster, sorted by id (length 1 = a lone conveyor) */
  members: PartInstance[]
}

/** ends within this distance (XZ and Y) are treated as touching */
const BUTT_TOL = 0.05
/** outward end normals must point into each other (collinear butt, not a side T) */
const OPPOSED_DOT = -0.9

type Ends = ReturnType<typeof conveyorEndsOf>

function endsButt(endsA: Ends, endsB: Ends): boolean {
  for (const ea of endsA) {
    for (const eb of endsB) {
      const dx = ea.x - eb.x
      const dz = ea.z - eb.z
      if (dx * dx + dz * dz > BUTT_TOL * BUTT_TOL) continue
      if (Math.abs(ea.y - eb.y) > BUTT_TOL) continue
      if (ea.outX * eb.outX + ea.outZ * eb.outZ > OPPOSED_DOT) continue
      return true
    }
  }
  return false
}

/** a part eligible to merge: a belt-like custom/SDK part (declares a `path` handle, so it has belt ends + a
 *  mergeable deck), which butts another SDK belt seamlessly. Only belt-like custom parts merge: they're the
 *  custom family whose deck facets participate in the merged compound (collisionShapes.ts conveyorDeckSubs). A
 *  straight `face`-handle SDK conveyor (spur / rig roller bed) contributes no cluster facets, because its deck is
 *  built by its own scripted/rig spawn path. Admitting it would leave the cluster with no deck whenever it
 *  becomes the lowest-id owner (non-owner members early-return). */
function isMergeable(p: PartInstance): boolean {
  return p.type === 'part' && isBeltLike(p)
}

/** Memoized on mergeable-belt part identity (memoParts.ts) - see computeDeckClustersUncached. */
export const computeDeckClusters = memoizeByParticipants(isMergeable, computeDeckClustersUncached)

function computeDeckClustersUncached(parts: readonly PartInstance[]): Map<string, DeckCluster> {
  const conveyors = parts.filter(isMergeable)
  // union-find over conveyor ids
  const parent = new Map<string, string>(conveyors.map((b) => [b.id, b.id]))
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    for (let c = x; parent.get(c) !== root; ) {
      const next = parent.get(c)!
      parent.set(c, root)
      c = next
    }
    return root
  }
  // each conveyor's ends once, not once per pair it is tested in
  const ends = conveyors.map((c) => conveyorEndsOf(c))
  for (let i = 0; i < conveyors.length; i++) {
    for (let j = i + 1; j < conveyors.length; j++) {
      if (endsButt(ends[i]!, ends[j]!)) parent.set(find(conveyors[i]!.id), find(conveyors[j]!.id))
    }
  }
  const groups = new Map<string, PartInstance[]>()
  for (const b of conveyors) {
    const root = find(b.id)
    const arr = groups.get(root)
    if (arr) arr.push(b)
    else groups.set(root, [b])
  }
  const result = new Map<string, DeckCluster>()
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const cluster: DeckCluster = { ownerId: arr[0]!.id, members: arr }
    for (const m of arr) result.set(m.id, cluster)
  }
  return result
}

/**
 * Signature of a cluster's deck-relevant geometry, folded into each member's
 * part signature so the owner rebuilds the merged deck (and members re-evaluate
 * ownership) whenever a member is added/removed/moved or its deck params change.
 * Empty for a lone belt - its deck is built the plain single-body way.
 */
export function deckClusterKey(cluster: DeckCluster | undefined): string {
  if (!cluster || cluster.members.length < 2) return ''
  // type + pose + params per member: any change to a member's deck geometry,
  // surface speed or membership flips this so the owner rebuilds the merged deck.
  return JSON.stringify(cluster.members.map((m) => [m.id, m.type, m.position, m.rotationY, m.params]))
}
