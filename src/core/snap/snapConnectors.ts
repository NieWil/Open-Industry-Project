import type { SnapChain, SnapEdgeMount, SnapMount, SnapSpec, SnapTile, SnapTrack } from '../parts/partApi'

/**
 * The connector model: what a part's `snap` declaration means to the snap engine (docs/part-snap-connectors.md).
 *
 * Every snap kind a part can declare compiles into connectors, and the engine only works with those:
 *
 * - a plug is a mover-side feature: it seeks a socket of a kind (or, for a peer plug, a same-group plug on the
 *   other part) and knows how to seat against it;
 * - a socket is a host-side feature a plug seats on. Sockets are resolved from the host at solve time
 *   (snapFeatures.ts), because most of them are implicit (every part's footprint faces, every conveyor's guard
 *   rails, ends and roller bed). The rest are declared (`surfaces`, and the peer `tile` / `chain`).
 *
 * The engine pairs each plug of the mover with each compatible socket of a target and solves the pair by its
 * (plug shape, socket shape), using the MATES table in snapFeatures.ts. It keeps the best candidate by one rule: a
 * body-overlap snap outranks a non-overlap one, then the lower cost. The same rule ranks one target against
 * another, so a part that declares several kinds uses whichever fits the drop best, never whichever it
 * declared first.
 *
 * This module is pure declaration-to-data (no geometry, no registry): `plugsOf` compiles a SnapSpec once and
 * caches it on the spec object, which the registry keeps for the life of the package.
 */

/** A mover-side connector. `label` names it in a candidate's `via` (e.g. `mounts[1]`, `edgeMount`, `chain`). */
export type Plug =
  /** a device's seat point: onto a guard-rail pair, a declared surface, or (accepts `'face'`) any footprint face */
  | { shape: 'mount'; label: string; mount: SnapMount }
  /** a seat anchored to a roller bed's rendered roller grid (blade stop, chain transfer) */
  | { shape: 'track'; label: 'track'; track: SnapTrack }
  /** a rectangle that tiles edge to edge with a same-group rectangle (peer: floor markings, decks) */
  | { shape: 'rect'; label: 'tile'; tile: SnapTile }
  /** the part's own footprint box, landing flush against any part's footprint faces (ambient `flush`) */
  | { shape: 'footprint'; label: 'flush' }
  /** a linear part chaining end to end / at an L-corner with a same-group line (peer: barriers) */
  | { shape: 'line'; label: 'chain'; chain: SnapChain }
  /** a part seating on a host deck edge: along it (a barrier on a platform rim) or into it (a flight, fitted to
   *  the deck's height when it stands on the floor) */
  | { shape: 'edgeSeat'; label: 'edgeMount'; edgeMount: SnapEdgeMount }

/** the reserved mount kind for "any part's footprint face" (SnapMount.accepts) */
export const FACE_KIND = 'face'

const compiled = new WeakMap<SnapSpec, readonly Plug[]>()
const NONE: readonly Plug[] = []

/**
 * The plugs a snap declaration gives its part as a mover, in a fixed order (it only decides ties of exactly equal
 * cost). A host-only declaration (`surfaces`) is not a plug.
 */
export function plugsOf(snap: SnapSpec | undefined): readonly Plug[] {
  if (!snap) return NONE
  const hit = compiled.get(snap)
  if (hit) return hit
  const out: Plug[] = []
  if (snap.track) out.push({ shape: 'track', label: 'track', track: snap.track })
  if (snap.tile) out.push({ shape: 'rect', label: 'tile', tile: snap.tile })
  if (snap.chain) out.push({ shape: 'line', label: 'chain', chain: snap.chain })
  if (snap.edgeMount) out.push({ shape: 'edgeSeat', label: 'edgeMount', edgeMount: snap.edgeMount })
  snap.mounts?.forEach((mount, i) => out.push({ shape: 'mount', label: `mounts[${i}]`, mount }))
  if (snap.flush === true) out.push({ shape: 'footprint', label: 'flush' })
  compiled.set(snap, out)
  return out
}

/**
 * The point on a part that meets the deck edge ({@link SnapEdgeMount.at} moved by its `atParams`), in the part's
 * local frame, at the given params. Shared by the snap (snapFeatures.ts) and the structure connection (structureConnections.ts), which reads
 * the same contact to open the railing, notch the deck and lift the part, so the snap and the cut agree.
 */
export function edgeMountContact(em: SnapEdgeMount, params: Readonly<Record<string, unknown>>): [number, number, number] {
  const out: [number, number, number] = [em.at?.[0] ?? 0, em.at?.[1] ?? 0, em.at?.[2] ?? 0]
  for (const r of em.atParams ?? []) {
    const v = params[r.param]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    let d = v * (r.scale ?? 1) + (r.add ?? 0)
    if (r.min !== undefined) d = Math.max(d, r.min)
    if (r.max !== undefined) d = Math.min(d, r.max)
    out[r.axis] += d
  }
  return out
}
