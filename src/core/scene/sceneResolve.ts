import type { PartInstance } from '../types'
import { resolveRollerGrids, gridSignature } from '../conveyor/rollerGrid'
import type { RollerGrid } from '../conveyor/rollerGrid'
import { computeSceneOpenings, openingsKey } from '../guards/guardOpenings'
import type { GuardOpenings } from '../guards/guardOpenings'
import { computeSceneExtents, extentsKey } from '../guards/guardExtents'
import type { GuardExtents } from '../guards/guardExtents'
import { computeDeckClusters, deckClusterKey } from '../deckClusters'
import type { DeckCluster } from '../deckClusters'
import { computeStructureConnections } from '../structureConnections'
import type { StructureConnections } from '../structureConnections'
import { structureCutKey } from '../structureCuts'
import { computeSceneLegRests, legRestsKey } from '../legRests'
import type { LegRestRows } from '../legRests'
import { computeGuardRuns, guardRunsKey } from '../guards/guardRuns'
import type { GuardRun } from '../guards/guardRuns'
import { computeSceneGuardHoles, guardHolesKey } from '../guards/guardHoles'
import type { GuardHoles } from '../guards/guardHoles'

/**
 * One per-part bundle of every host-computed, neighbour-derived input a part's geometry consumes at scene-edit
 * time (docs/seam-resolvers.md). The roller-grid / guard-opening / spur-extent /
 * deck-cluster / stair-cut inputs share one struct + one change-signature, so render (viewSync.ts →
 * PartVisual.update) and sim (world.ts → buildPart) each pass one value instead of N. Adding another
 * neighbour-effect means adding a field, a resolver and a key contribution. Passing each effect separately takes
 * edits in five files, and missing one leaves a fully-implemented effect wired to nothing.
 *
 * Fields are optional and consumer-specific. Render reads grid/openings/extents/structConn; sim reads
 * openings/extents/cluster/structConn (it has no roller-grid seam, and render has no deck-merge). The two
 * `*ResolvedKey` helpers below select exactly the fields each consumer rebuilds on, so sharing one struct
 * doesn't widen either side's rebuild triggers. `structConn` is the whole scene map (structureCutGeo/Key slice
 * it by part id); it's attached only to the parts a cut actually touches.
 */
export interface ResolvedContext {
  /** straight roller bed's world-pitch grid (render only; sim rollers are position-derived) */
  grid?: RollerGrid
  /** neighbour-derived side-guard cutouts (render + sim) */
  openings?: GuardOpenings
  /** spur snap end-overrides that reach rails/guards to the host wall (render + sim) */
  extents?: GuardExtents
  /** butted-belt deck-merge group (sim only - render draws members individually) */
  cluster?: DeckCluster
  /** scene-wide stair→platform structure connections (render + sim), attached to the parts a cut touches */
  structConn?: StructureConnections
  /** per-leg footing rows for a legged bed crossing a platform (render only - legs have no colliders) */
  legRests?: LegRestRows
  /** merged side-guard span overrides for butted collinear guards (sim only - the merge is a collision
   *  concern; two butted guards already draw as one continuous wall, so render keeps its per-part meshes) */
  guardRun?: GuardRun
  /** sensor-beam holes through this bed's side guards (render only - beams aren't physical, so the collider
   *  stays whole; core/guards/guardHoles.ts) */
  holes?: GuardHoles
}

/**
 * Which side is asking. Render and sim read mostly disjoint subsets of ResolvedContext (render: grid,
 * openings, extents, structConn, legRests, holes; sim: openings, extents, cluster, structConn, guardRun).
 * Running a resolver whose field the caller never reads wastes time on every scene change.
 */
export type ResolveConsumer = 'render' | 'sim'

/**
 * Run the resolvers this consumer reads and fold their outputs into a single ResolvedContext. Each
 * underlying resolver is memoizeByParticipants-memoized, so an unchanged scene recomputes nothing. That
 * memo is all-or-nothing, so any change re-runs the resolver over the whole scene. Under streamed motion (a
 * gizmo drag, a peer's drag, an Inspector scrub) every frame is a change, so each consumer runs only its own
 * resolvers. The render thread and the sim worker call this independently (separate module state), so it is a
 * shared function, not shared state.
 */
export function resolveScene(parts: readonly PartInstance[], consumer: ResolveConsumer): Map<string, ResolvedContext> {
  const render = consumer === 'render'
  const sim = consumer === 'sim'
  const out = new Map<string, ResolvedContext>()
  const patch = (id: string, mut: (c: ResolvedContext) => void): void => {
    let c = out.get(id)
    if (!c) { c = {}; out.set(id, c) }
    mut(c)
  }
  // Each resolver runs only if this consumer reads its field (the two *ResolvedKey helpers define who
  // reads what). The memos below are all-or-nothing, so a single moved part re-runs every resolver over
  // the whole scene, and a drag does that every frame. Running the sim-only deckClusters + guardRuns in
  // render costs 20 of its 29 ms per frame at 240 parts. See e2e/verify-collab-presence-cost.mjs.
  if (render) for (const [id, grid] of resolveRollerGrids(parts)) patch(id, (c) => { c.grid = grid })
  for (const [id, o] of computeSceneOpenings(parts)) patch(id, (c) => { c.openings = o })
  for (const [id, e] of computeSceneExtents(parts)) patch(id, (c) => { c.extents = e })
  if (sim) for (const [id, cl] of computeDeckClusters(parts)) patch(id, (c) => { c.cluster = cl })
  if (render) for (const [id, lr] of computeSceneLegRests(parts)) patch(id, (c) => { c.legRests = lr })
  if (sim) for (const [id, gr] of computeGuardRuns(parts)) patch(id, (c) => { c.guardRun = gr })
  if (render) for (const [id, h] of computeSceneGuardHoles(parts)) patch(id, (c) => { c.holes = h })
  const structConn = computeStructureConnections(parts)
  // structConn is scene-global; attach it only to the parts a cut touches (a host platform or a connected
  // stair) so their ctx is non-empty and the change-signature picks the cut up. Others slice to '' anyway.
  for (const id of structConn.platform.keys()) patch(id, (c) => { c.structConn = structConn })
  for (const id of structConn.stairTopConnected.keys()) patch(id, (c) => { c.structConn = structConn })
  return out
}

/** Render's change-signature: the fields the viewport rig rebuild/reflow depends on. '' when none apply, so a
 *  cluster-only member (sim's concern) never trips a render rebuild. */
export function renderResolvedKey(partId: string, ctx: ResolvedContext | undefined): string {
  if (!ctx) return ''
  const g = gridSignature(ctx.grid)
  const o = openingsKey(ctx.openings)
  const e = extentsKey(ctx.extents)
  const s = structureCutKey(partId, ctx.structConn)
  const l = legRestsKey(ctx.legRests)
  const h = guardHolesKey(ctx.holes)
  return g || o || e || s || l || h ? `${g}|${o}|${e}|${s}|${l}|${h}` : ''
}

/** Sim's change-signature: the fields the physics body build depends on (no roller grid - sim rollers are
 *  position-derived; plus the deck-merge cluster render ignores). Folded into partSignature. */
export function simResolvedKey(partId: string, ctx: ResolvedContext | undefined): string {
  return `${openingsKey(ctx?.openings)}|${extentsKey(ctx?.extents)}|${deckClusterKey(ctx?.cluster)}|${structureCutKey(partId, ctx?.structConn)}|${guardRunsKey(ctx?.guardRun)}`
}
