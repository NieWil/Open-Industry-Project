import type { PartInstance } from './types'
import { registryRevision } from './parts/partRegistry'
import { createFootprintIndex } from './footprintGrid'

/**
 * Memoize a scene-wide derivation (parts → neighbour-relation map) on the reference identity
 * of the parts that can affect its output.
 *
 * A drag replaces only the moved part objects, so every untouched part keeps its identity: comparing the
 * participants' refs to the previous call is an exact change signal. A non-participant drag (a box through a
 * conveyor field) reuses the map; any participant edit swaps a ref (or the subset length) and recomputes. Scene
 * load, undo and collab present fresh objects, so the gate fails open to a recompute, never stale.
 *
 * Invariants this relies on (enforced, not assumed):
 * - Parts are immutable snapshots; the store deep-freezes scene parts in dev so an in-place mutation throws at
 *   its own call site instead of serving stale derivations (store.setState).
 * - `participates` must cover every part `compute` reads (the *.test.ts equivalence suites lock this).
 * - Output may also depend on the participants' packages, which change under identical refs (author-mode edit,
 *   hot reload): the cache keys on {@link registryRevision} for that.
 *
 * The returned map is shared across frames: callers must treat it as immutable.
 */
export function memoizeByParticipants<T>(
  participates: (p: PartInstance) => boolean,
  compute: (parts: readonly PartInstance[]) => T,
): (parts: readonly PartInstance[]) => T {
  let lastSubset: PartInstance[] | null = null
  let lastRegistryRev = -1
  let lastResult!: T // assigned before any read: the cache-hit branch requires lastSubset !== null
  return (parts) => {
    const subset: PartInstance[] = []
    for (const p of parts) if (participates(p)) subset.push(p)
    const rev = registryRevision()
    if (
      lastSubset !== null &&
      rev === lastRegistryRev &&
      subset.length === lastSubset.length &&
      subset.every((p, i) => p === lastSubset![i])
    ) {
      return lastResult
    }
    lastSubset = subset
    lastRegistryRev = rev
    lastResult = compute(parts)
    return lastResult
  }
}

/** A neighbour-derived resolver in the one shape they all share (see docs/seam-resolvers.md). */
export interface LocalizedSpec<T> {
  /** parts that receive a result */
  isTarget: (p: PartInstance) => boolean
  /** parts that can affect a target's result */
  isInfluencer: (p: PartInstance) => boolean
  /** contact tolerance handed to the footprint-grid broad phase */
  tolerance: number
  /** the per-target derivation. Must be pure in (target, the set of near influencers) + the package
   *  registry: that purity is what makes the cache below sound. Return undefined for "no result". */
  derive: (target: PartInstance, near: readonly PartInstance[]) => T | undefined
}

const sameRefs = (a: readonly PartInstance[], b: readonly PartInstance[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Like {@link memoizeByParticipants}, but memoized per target instead of all-or-nothing.
 *
 * The whole-scene memo re-runs the entire resolver when one part moves. That is fine for a discrete edit, but under
 * streamed motion (a gizmo drag, a peer's drag, an Inspector scrub) the cost then scales with scene size.
 *
 * Each target caches its exact input set (its own ref plus the refs of the influencers the broad phase handed it)
 * and re-derives only when those differ. A dependency cannot be missed: anything `derive` may read is in the key.
 *
 * The broad phase is incremental too ({@link createFootprintIndex}): buckets persist, only changed refs re-bucket,
 * and each cell carries a version. A target whose cells kept their versions is reused without gathering at all.
 *
 * Net: one O(n) classification pass plus O(cells touched) per target. Measured on `computeSceneOpenings` with one
 * part moving: flat ~0.4-0.6 ms per call from 60 to 480 parts, against 2.6 -> 17.8 ms without this caching.
 *
 * The returned map is rebuilt per call, but the values are shared across frames: treat as immutable.
 */
export function memoizeLocalized<T>(spec: LocalizedSpec<T>): (parts: readonly PartInstance[]) => Map<string, T> {
  interface Entry {
    target: PartInstance
    /** the grid cells this target reaches - stable while its own ref is */
    keys: string[]
    /** combined version of those cells when `near` was gathered */
    stamp: number
    near: readonly PartInstance[]
    result: T | undefined
  }
  const index = createFootprintIndex()
  // `isTarget`/`isInfluencer` are not cheap: they build geometry views (bedOf, moverShapeOf,
  // hostGeom) to decide what a part is. Asking every part every call would be an O(scene) term with
  // a real constant. They are pure in (part, package registry), and parts are immutable snapshots, so
  // the answer is cached on identity and dropped wholesale when the registry revision changes.
  let isTargetMemo = new WeakMap<object, boolean>()
  let isInfluencerMemo = new WeakMap<object, boolean>()
  let cache = new Map<string, Entry>()
  // the last map handed out. Returned unchanged when nothing was re-derived, so callers keep the
  // same by-identity cache-hit contract as memoizeByParticipants (memoParts.test.ts locks it).
  let lastOut = new Map<string, T>()
  let lastRegistryRev = -1
  return (parts) => {
    const rev = registryRevision()
    let dirty = false
    // a package edit can change any derivation under identical part refs, so drop everything
    if (rev !== lastRegistryRev) {
      cache = new Map()
      isTargetMemo = new WeakMap()
      isInfluencerMemo = new WeakMap()
      lastRegistryRev = rev
      dirty = true
    }
    const influencers: PartInstance[] = []
    const targets: PartInstance[] = []
    for (const p of parts) {
      const key = p as unknown as object
      let inf = isInfluencerMemo.get(key)
      if (inf === undefined) {
        inf = spec.isInfluencer(p)
        isInfluencerMemo.set(key, inf)
      }
      if (inf) influencers.push(p)
      let tgt = isTargetMemo.get(key)
      if (tgt === undefined) {
        tgt = spec.isTarget(p)
        isTargetMemo.set(key, tgt)
      }
      if (tgt) targets.push(p)
    }
    index.sync(influencers) // reconcile the persistent buckets; only changed refs are re-bucketed
    if (influencers.length === 0 || targets.length === 0) {
      // nothing can be derived; don't strand entries that would never be revisited. A registry change above has
      // already emptied `cache`, so `lastOut` is checked too, or the previous scene's map would come back.
      if (cache.size > 0 || lastOut.size > 0) {
        cache = new Map()
        lastOut = new Map()
      }
      return lastOut
    }
    const next = new Map<string, Entry>()
    const out = new Map<string, T>()
    for (const target of targets) {
      const prev = cache.get(target.id)
      let entry: Entry
      if (prev !== undefined && prev.target === target) {
        // The target itself hasn't moved, so it reaches the same cells. If none of those cells has
        // changed, nothing it can see has moved either: reuse without touching the buckets at all.
        const stamp = index.stamp(prev.keys)
        if (stamp === prev.stamp) {
          entry = prev
        } else {
          const near = index.gather(prev.keys)
          if (sameRefs(prev.near, near)) {
            entry = { ...prev, stamp } // a cell churned, but this target's neighbour set did not
          } else {
            entry = { target, keys: prev.keys, stamp, near, result: near.length === 0 ? undefined : spec.derive(target, near) }
            dirty = true
          }
        }
      } else {
        const keys = index.queryKeys(target, spec.tolerance)
        const near = index.gather(keys)
        const stamp = index.stamp(keys)
        entry = { target, keys, stamp, near, result: near.length === 0 ? undefined : spec.derive(target, near) }
        dirty = true
      }
      next.set(target.id, entry)
      if (entry.result !== undefined) out.set(target.id, entry.result)
    }
    if (next.size !== cache.size) dirty = true // a target entered or left the scene
    cache = next // entries for vanished targets drop out here
    if (!dirty) return lastOut
    lastOut = out
    return out
  }
}
