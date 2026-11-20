import { getPackage, registryRevision } from './partRegistry'
import type { PartInstance } from '../types'

// --- derivation memos --------------------------------------------------------
// The scene resolvers (guard openings/extents/grids), the snap engine and the render diff all
// re-derive the part views below many times per part per frame during a transient drag stream.
// That is the measured dominant multi-part drag cost (e2e/probes/shiftdup-perf.mjs). Both memos are
// exact under the invariants memoParts.ts documents: parts/params are immutable snapshots (the
// editor store deep-freezes them in dev), and registerPackage always replaces a package object
// on a content change, never mutates one in place. Cached values are shared across calls, so
// treat every returned view/array as immutable (partGeometryMemo.test.ts locks equivalence).

/** Memoize a pure package-level derivation on the package object's identity. Object identity is
 *  an exact change signal (a content-changing register installs a fresh object), and the WeakMap
 *  keeps retired packages collectable. `undefined` packages bypass the cache (callers keep their
 *  own no-package fallbacks). */
export function memoByPkg<T>(compute: (pkg: NonNullable<ReturnType<typeof getPackage>>) => T): (pkg: ReturnType<typeof getPackage>) => T | undefined {
  const cache = new WeakMap<NonNullable<ReturnType<typeof getPackage>>, T>()
  return (pkg) => {
    if (!pkg) return undefined
    if (cache.has(pkg)) return cache.get(pkg) as T
    const value = compute(pkg)
    cache.set(pkg, value)
    return value
  }
}

/**
 * Memoize a pure per-part geometry derivation on the identity of the part's `params` object.
 * The transient stream of a gizmo drag re-poses parts as `{ ...p, position, rotationY }`, so a
 * moved part keeps its `params` reference every frame. With a params-keyed WeakMap, local geometry
 * is derived once per drag instead of once per frame. `compute` must read only
 * `type` / `packageId` / `params` (never pose, id or parent); the entry revalidates on
 * type/packageId (params objects can outlive a part, e.g. shared rows after clonePart) and on
 * {@link registryRevision} (same params, edited/hot-reloaded package). Unknown shapes (a part
 * without object params) bypass the cache and recompute, so they are never stale.
 */
export function memoByParams<T>(compute: (part: PartInstance) => T): (part: PartInstance) => T {
  const cache = new WeakMap<object, { rev: number; type: string; packageId: string | undefined; value: T }>()
  return (part) => {
    const key = part.params as unknown
    if (key === null || typeof key !== 'object') return compute(part)
    const rev = registryRevision()
    const packageId = part.type === 'part' ? part.packageId : undefined
    const hit = cache.get(key as object)
    if (hit && hit.rev === rev && hit.type === part.type && hit.packageId === packageId) return hit.value
    const value = compute(part)
    cache.set(key as object, { rev, type: part.type, packageId, value })
    return value
  }
}
