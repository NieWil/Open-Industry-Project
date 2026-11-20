import type { PartInstance } from './types'
import { partFootprint, toWorldXZ } from './parts/partGeometry'

/**
 * Uniform footprint grid for neighbour-derived resolvers.
 *
 * The seam resolvers (guardOpenings, guardExtents) all ask the same question: "which other parts are close
 * enough to this one to interact?" Answering it with a full scan is O(n^2), and since every conveyor is both
 * a candidate and a query, it dominates the per-frame drag cost in a large scene: a full scan measured ~64 ms
 * at 480 conveyors for openings, and 321-454 ms at 800 for extents.
 *
 * Every one of those interactions requires contact within a small tolerance, so a part can only matter if its
 * footprint disc is within (rQuery + rCandidate + tol). Bucketing candidates by the cells their disc covers
 * and querying the cells within the query's own reach is conservative: a real contact can never be dropped,
 * because two discs that close always share a cell, so the resolver's output is bit-identical to the scan.
 * (Each resolver's per-part result must be a function of the set of nearby parts, not their order. Both
 * current callers merge/sort internally, so they are.)
 */

/** cell size (m) - about a short conveyor, so most parts span only a few cells */
const GRID_CELL = 4

/** memo of the disc per part identity (parts are immutable snapshots, so a ref is a valid key). The
 *  disc is derived geometry (partFootprint + a world transform), and both the index build and every
 *  query want it; recomputing it per call is a large slice of the broad phase. */
const discCache = new WeakMap<object, { cx: number; cz: number; r: number }>()

/** a part's rotation-safe footprint bounding disc (world centre + radius) */
export function footprintDisc(p: PartInstance): { cx: number; cz: number; r: number } {
  const hit = discCache.get(p as unknown as object)
  if (hit !== undefined) return hit
  const fp = partFootprint(p)
  const c = toWorldXZ(p, fp.cx ?? 0, fp.cz ?? 0)
  const disc = { cx: c.x, cz: c.z, r: Math.hypot(fp.hx, fp.hz) }
  discCache.set(p as unknown as object, disc)
  return disc
}

/**
 * Index `candidates` by footprint, returning a lookup that yields the ones near a query part. `tol` is the
 * contact tolerance the caller's own gate uses; the lookup widens by the query's radius plus `tol`.
 */
export function buildFootprintGrid(
  candidates: readonly PartInstance[],
): (query: PartInstance, tol: number) => PartInstance[] {
  const cellRange = (lo: number, hi: number): [number, number] => [Math.floor(lo / GRID_CELL), Math.floor(hi / GRID_CELL)]
  const buckets = new Map<string, PartInstance[]>()
  for (const c of candidates) {
    const d = footprintDisc(c)
    const [x0, x1] = cellRange(d.cx - d.r, d.cx + d.r)
    const [z0, z1] = cellRange(d.cz - d.r, d.cz + d.r)
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const key = `${ix}:${iz}`
        const list = buckets.get(key)
        if (list) list.push(c)
        else buckets.set(key, [c])
      }
  }
  return (query: PartInstance, tol: number): PartInstance[] => {
    const q = footprintDisc(query)
    const reach = q.r + tol
    const [x0, x1] = cellRange(q.cx - reach, q.cx + reach)
    const [z0, z1] = cellRange(q.cz - reach, q.cz + reach)
    const near: PartInstance[] = []
    const seen = new Set<string>()
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const list = buckets.get(`${ix}:${iz}`)
        if (!list) continue
        for (const c of list) {
          if (seen.has(c.id)) continue
          seen.add(c.id)
          near.push(c)
        }
      }
    return near
  }
}

/**
 * The same grid, but persistent across calls and versioned per cell.
 *
 * `buildFootprintGrid` re-indexes every candidate and re-walks every query on each call, so a
 * resolver over a streamed drag runs the whole broad phase 60x/second even though one part moved.
 * This keeps the buckets between calls: `sync` reconciles them against the new candidate list by
 * part identity (only parts whose ref actually changed are re-bucketed), and every touched cell's
 * version is bumped. A caller can then cache the cell keys a query consulted plus their combined
 * version stamp, and skip the query entirely while that stamp holds - versions only ever increase,
 * so a stamp can't collide back to a stale value.
 */
export interface FootprintIndex {
  /** reconcile the buckets with `candidates`; O(refs changed) after an O(n) identity scan */
  sync(candidates: readonly PartInstance[]): void
  /** the cell keys `query` reaches - stable while the query part's ref is unchanged */
  queryKeys(query: PartInstance, tol: number): string[]
  /** combined version of `keys`; changes whenever any of those cells' contents changed */
  stamp(keys: readonly string[]): number
  /** the deduped parts held in `keys` */
  gather(keys: readonly string[]): PartInstance[]
}

export function createFootprintIndex(): FootprintIndex {
  const cellRange = (lo: number, hi: number): [number, number] => [Math.floor(lo / GRID_CELL), Math.floor(hi / GRID_CELL)]
  const buckets = new Map<string, PartInstance[]>()
  const versions = new Map<string, number>()
  const placed = new Map<string, { part: PartInstance; keys: string[] }>()
  // per-call membership token, so the removal sweep needs no per-call Set allocation
  const seenTok = new Map<string, number>()
  let tok = 0

  const bump = (key: string): void => { versions.set(key, (versions.get(key) ?? 0) + 1) }

  const cellsOf = (p: PartInstance): string[] => {
    const d = footprintDisc(p)
    const [x0, x1] = cellRange(d.cx - d.r, d.cx + d.r)
    const [z0, z1] = cellRange(d.cz - d.r, d.cz + d.r)
    const keys: string[] = []
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) keys.push(`${ix}:${iz}`)
    return keys
  }

  const unplace = (id: string, pl: { part: PartInstance; keys: string[] }): void => {
    for (const key of pl.keys) {
      const list = buckets.get(key)
      if (!list) continue
      const i = list.indexOf(pl.part)
      // splice keeps the surviving parts' relative order, so an untouched target's gathered
      // neighbour list stays ref-for-ref identical and its cached derivation still matches
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) buckets.delete(key)
      bump(key)
    }
    placed.delete(id)
  }

  return {
    sync(candidates) {
      tok++
      for (const c of candidates) {
        seenTok.set(c.id, tok)
        const prev = placed.get(c.id)
        if (prev !== undefined && prev.part === c) continue // unchanged ref - buckets already correct
        if (prev !== undefined) unplace(c.id, prev)
        const keys = cellsOf(c)
        for (const key of keys) {
          const list = buckets.get(key)
          if (list) list.push(c)
          else buckets.set(key, [c])
          bump(key)
        }
        placed.set(c.id, { part: c, keys })
      }
      // anything still placed but not seen this call was removed from the scene. Only possible when
      // placed outgrew the candidate list, so the common (steady-membership) path never sweeps.
      if (placed.size > candidates.length) {
        for (const [id, pl] of [...placed]) if (seenTok.get(id) !== tok) unplace(id, pl)
      }
    },
    queryKeys(query, tol) {
      const q = footprintDisc(query)
      const reach = q.r + tol
      const [x0, x1] = cellRange(q.cx - reach, q.cx + reach)
      const [z0, z1] = cellRange(q.cz - reach, q.cz + reach)
      const keys: string[] = []
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) keys.push(`${ix}:${iz}`)
      return keys
    },
    stamp(keys) {
      let s = 0
      for (const key of keys) s += versions.get(key) ?? 0
      return s
    },
    gather(keys) {
      const near: PartInstance[] = []
      for (const key of keys) {
        const list = buckets.get(key)
        if (!list) continue
        for (const c of list) if (!near.includes(c)) near.push(c)
      }
      return near
    },
  }
}
