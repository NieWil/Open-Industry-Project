import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SdkPart, PartInstance } from './types'
import type { PartPackage } from './parts/partPackage'
import { clearPackages, getPackage, registerPackage } from './parts/partRegistry'
import { computeSceneOpenings } from './guards/guardOpenings'
import { computeSceneExtents } from './guards/guardExtents'
import { memoizeLocalized } from './memoParts'
import { PACKAGE_FORMAT } from './parts/partPackage'

/**
 * Soundness of the per-target incremental memo (memoParts.ts `memoizeLocalized`).
 *
 * An all-or-nothing memo is stale-free by construction. This one reuses a target's result whenever
 * its own ref and its near-influencer refs are unchanged, so these tests check that the cached stream
 * never diverges from a full recompute, over long sequences of the mutations a real session produces
 * (drags, rotations, adds, removes, resizes), not just a single step.
 *
 * Method: run a deterministic mutation sequence through the live (incremental) resolver, recording
 * every output; then replay the same states with all-fresh part identities, which forces a full
 * recompute on every call, and require the two streams to be equal. A radius/dependency mistake in
 * the cache shows up here as a divergence at the step where the seam changed.
 */

function beltPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.belt',
    name: 'Acme Belt', conveyor: { bed: 'path', surface: 'belt' },
    params: {
      segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
      width: { type: 'number', default: 0.6 },
      height: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
  } as PartPackage
}

const belt = (id: string, x: number, z: number, rot = 0, length = 4): SdkPart =>
  ({
    id, type: 'part', packageId: 'acme.belt', position: [x, 0.75, z], rotationY: rot,
    params: { segments: [[length, 0]], width: 0.6, height: 0.5, leftGuard: true, rightGuard: true },
  }) as unknown as SdkPart

/** all-new object identities, same values - forces the memo's uncached path */
const freshClones = (parts: readonly PartInstance[]): PartInstance[] =>
  parts.map((p) => JSON.parse(JSON.stringify(p)) as PartInstance)

/** deterministic PRNG, so a failure is reproducible */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/**
 * A compact serialization of a resolver's output that compares values, not incidental ordering:
 * map entries sorted by id, and object keys sorted. A result object's key insertion order legitimately
 * varies with the order the broad phase hands over neighbours, and nothing downstream can see it: the
 * change-signatures (`extentsKey`, `openingsKey`) read their fields in a fixed order. Comparing raw
 * JSON here would fail on that difference alone and hide whether the values ever diverge.
 */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])]))
  }
  return v
}
const snap = (m: Map<string, unknown>): string =>
  JSON.stringify([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, stable(v)]))

/**
 * A mutation sequence over a grid of belts: moves that make and break seams (the interesting case,
 * where a target's influencer set changes), plus rotations, resizes, adds and removes.
 */
function mutationStates(steps: number): PartInstance[][] {
  const rand = rng(20260728)
  // a lattice tight enough that small moves repeatedly form and break real junctions
  let parts: PartInstance[] = []
  for (let i = 0; i < 12; i++) parts.push(belt(`b${i}`, (i % 4) * 4, Math.floor(i / 4) * 2))
  const states: PartInstance[][] = []
  let added = 0
  for (let step = 0; step < steps; step++) {
    const roll = rand()
    if (roll < 0.6 && parts.length > 0) {
      // move one part a little - the drag frame, and the case that makes/breaks seams
      const i = Math.floor(rand() * parts.length)
      const p = parts[i]!
      const d = (rand() - 0.5) * 3
      parts = parts.map((q, j) =>
        j === i ? ({ ...q, position: [(p.position[0] as number) + d, p.position[1], (p.position[2] as number) + (rand() - 0.5) * 1.2] } as PartInstance) : q)
    } else if (roll < 0.75 && parts.length > 0) {
      const i = Math.floor(rand() * parts.length)
      parts = parts.map((q, j) => (j === i ? ({ ...q, rotationY: rand() * Math.PI * 2 } as PartInstance) : q))
    } else if (roll < 0.85 && parts.length > 0) {
      // resize: changes the part's own footprint, so its reach over neighbours changes too
      const i = Math.floor(rand() * parts.length)
      const q = parts[i]! as SdkPart
      parts = parts.map((r, j) =>
        j === i ? ({ ...q, params: { ...q.params, segments: [[2 + rand() * 4, 0]] } } as unknown as PartInstance) : r)
    } else if (roll < 0.94) {
      parts = [...parts, belt(`add${added++}`, rand() * 14, rand() * 6, rand() * Math.PI)]
    } else if (parts.length > 3) {
      const i = Math.floor(rand() * parts.length)
      parts = parts.filter((_, j) => j !== i)
    }
    states.push(parts)
  }
  return states
}

describe('memoizeLocalized soundness', () => {
  beforeEach(() => registerPackage(beltPkg()))
  afterEach(() => clearPackages())

  /**
   * `isTarget`/`isInfluencer` are memoized on part identity, so what a part is must be re-decided when
   * the package registry moves. A package can arrive after the first resolve (async load, author-mode
   * edit, a peer's part syncing in) under unchanged part refs. A stale `false` here would exclude the
   * part forever, which is the "it never gets its seams" class of bug.
   *
   * The seam resolvers' own `derive` re-checks the package internally, which masks a stale `true`. So
   * this drives the memo directly to catch the stale `false`, which nothing else would catch.
   */
  it('re-classifies parts when their package arrives after the first call (identical refs)', () => {
    clearPackages()
    const resolve = memoizeLocalized<string>({
      isTarget: (p) => getPackage((p as SdkPart).packageId) !== undefined,
      isInfluencer: (p) => getPackage((p as SdkPart).packageId) !== undefined,
      tolerance: 1,
      derive: (target) => target.id,
    })
    const parts = [belt('a', 0, 0), belt('b', 1, 0)]
    expect(resolve(parts).size).toBe(0) // package not registered yet - neither part participates
    registerPackage(beltPkg())
    expect(resolve(parts).size).toBe(2) // same refs, but they are parts now
  })

  for (const [name, fn] of [
    ['computeSceneOpenings', computeSceneOpenings],
    ['computeSceneExtents', computeSceneExtents],
  ] as const) {
    it(`${name}: the incremental stream matches a full recompute at every step`, () => {
      const states = mutationStates(60)
      const incremental = states.map((s) => snap(fn(s) as Map<string, unknown>))
      // every call below sees all-new refs, so nothing can be reused - these are full recomputes
      const reference = states.map((s) => snap(fn(freshClones(s)) as Map<string, unknown>))
      for (let i = 0; i < states.length; i++) {
        expect(incremental[i], `diverged at step ${i} (${states[i]!.length} parts)`).toBe(reference[i])
      }
      // the fixture must actually exercise the resolver, or this proves nothing
      expect(incremental.some((s) => s !== '[]')).toBe(true)
    })
  }
})
