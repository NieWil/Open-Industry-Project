import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SdkPart, PartInstance } from './types'
import type { PartPackage } from './parts/partPackage'
import { clearPackages, registerPackage, unregisterPackage } from './parts/partRegistry'
import { memoizeByParticipants, memoizeLocalized } from './memoParts'
import { computeSceneOpenings } from './guards/guardOpenings'
import { resolveRollerGrids } from './conveyor/rollerGrid'
import { computeSceneExtents } from './guards/guardExtents'
import { computeDeckClusters } from './deckClusters'
import { PACKAGE_FORMAT } from './parts/partPackage'

// The identity-memo layer over the scene-wide neighbour passes (memoParts.ts). The invariant under
// test: a transient scene that replaces only non-participant part objects (a dragged cargo box) must
// reuse the cached map, and a cached map must stay byte-equivalent to a fresh recompute, locked by
// re-running each pass on deep clones (all-new refs force the uncached path).

// Fixtures mirror guardOpenings.test.ts: a belt-like SDK host, a straight SDK roller
// (opener / grid node), and a plain box package that participates in no scene-wide pass.
function customBeltPkg(): PartPackage {
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
function belt(id: string, x: number, z: number, rot = 0, length = 4): SdkPart {
  return { id, type: 'part', packageId: 'acme.belt', position: [x, 0.75, z], rotationY: rot, params: { segments: [[length, 0]], width: 0.6, height: 0.5, leftGuard: true, rightGuard: true } } as unknown as SdkPart
}

function sdkRollerPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.roller',
    name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.04, 0.6] }, conveys: true, array: { count: 9, distribute: { axis: 'x', maxSpacing: 0.25, worldPhase: true } } }], joints: [], bounds: { length: 2, width: 0.6, top: 0.9 } },
  } as unknown as PartPackage
}
function sdkRoller(id: string, x: number, z: number, rot = 0, length = 2): SdkPart {
  return { id, type: 'part', packageId: 'acme.roller', position: [x, 0.75, z], rotationY: rot, params: { length, width: 0.6, speed: 0.5 } } as unknown as SdkPart
}

// a cargo box: no handles, no conveys, no mounts, so it participates in no scene-wide pass
function boxPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.box',
    name: 'Acme Box',
    params: { length: { type: 'number', default: 0.4 }, width: { type: 'number', default: 0.4 }, height: { type: 'number', default: 0.4 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.4, width: 0.4, top: 0.4 } },
  } as PartPackage
}
function box(id: string, x: number, z: number): SdkPart {
  return { id, type: 'part', packageId: 'acme.box', position: [x, 0.2, z], rotationY: 0, params: {} } as unknown as SdkPart
}

/** the transient-drag scene shape: same array mapping, moved part replaced, everything else by ref */
function movePart(parts: readonly PartInstance[], id: string, dx: number): PartInstance[] {
  return parts.map((p) => (p.id === id ? ({ ...p, position: [p.position[0] + dx, p.position[1], p.position[2]] } as PartInstance) : p))
}

/** all-new object graph - forces the memo's uncached path (the fresh-recompute reference) */
function freshClones(parts: readonly PartInstance[]): PartInstance[] {
  return JSON.parse(JSON.stringify(parts)) as PartInstance[]
}

describe('memoizeByParticipants', () => {
  afterEach(() => clearPackages())

  const conveyorish = (p: PartInstance): boolean => p.id.startsWith('c')
  const mkParts = (): PartInstance[] => [box('b1', 0, 0), belt('c1', 0, 0), belt('c2', 8, 0)]

  it('caches while participant refs are unchanged, even as non-participants churn', () => {
    let calls = 0
    const fn = memoizeByParticipants(conveyorish, (parts) => {
      calls++
      return parts.filter(conveyorish).map((p) => p.id)
    })
    const parts = mkParts()
    const r1 = fn(parts)
    const r2 = fn(movePart(parts, 'b1', 1)) // box replaced, conveyors by ref
    expect(r2).toBe(r1)
    expect(calls).toBe(1)
  })

  it('recomputes when a participant ref is replaced', () => {
    let calls = 0
    const fn = memoizeByParticipants(conveyorish, () => ++calls)
    const parts = mkParts()
    fn(parts)
    expect(fn(movePart(parts, 'c1', 1))).toBe(2)
  })

  it('recomputes when a participant is added or removed', () => {
    let calls = 0
    const fn = memoizeByParticipants(conveyorish, () => ++calls)
    const parts = mkParts()
    fn(parts)
    expect(fn([...parts, belt('c3', 16, 0)])).toBe(2)
    expect(fn(parts.filter((p) => p.id !== 'c2'))).toBe(3)
  })

  it('recomputes when the package registry changes under identical part refs', () => {
    let calls = 0
    const fn = memoizeByParticipants(conveyorish, () => ++calls)
    const parts = mkParts()
    fn(parts)
    expect(fn(parts)).toBe(1) // baseline: identical call hits
    registerPackage(customBeltPkg())
    expect(fn(parts)).toBe(2) // register invalidates
    registerPackage(customBeltPkg())
    expect(fn(parts)).toBe(2) // content-identical re-register is a no-op (no rev bump)
    unregisterPackage('acme.belt')
    expect(fn(parts)).toBe(3) // unregister invalidates
  })
})

describe('memoizeLocalized', () => {
  afterEach(() => clearPackages())

  it('returns an empty map, not the last one, when a registry change meets a scene with nothing to derive', () => {
    registerPackage(customBeltPkg())
    registerPackage(boxPkg())
    const conveyorish = (p: PartInstance): boolean => p.id.startsWith('c')
    const fn = memoizeLocalized<string>({ isTarget: conveyorish, isInfluencer: conveyorish, tolerance: 0.05, derive: (t) => t.id })
    expect([...fn([box('b1', 0, 0), belt('c1', 0, 0), belt('c2', 4, 0)]).keys()]).toEqual(['c1', 'c2'])
    registerPackage(sdkRollerPkg()) // bumps the registry revision, which empties the per-target cache
    expect(fn([box('b1', 0, 0)]).size).toBe(0)
  })
})

// Each wrapped pass: (1) non-participant churn returns the cached map by identity, (2) the cached
// map deep-equals a fresh recompute (clones = all-new refs), (3) moving a participant recomputes
// to a result that again deep-equals its own fresh recompute.
describe('memoized scene-wide passes', () => {
  beforeEach(() => {
    registerPackage(customBeltPkg())
    registerPackage(sdkRollerPkg())
    registerPackage(boxPkg())
  })
  afterEach(() => clearPackages())

  interface Case {
    name: string
    fn: (parts: readonly PartInstance[]) => Map<string, unknown>
    parts: () => PartInstance[]
    participantId: string
    /** sanity: the fixture must actually produce a non-trivial result */
    expectNonEmpty: boolean
  }
  const cases: Case[] = [
    {
      name: 'computeSceneOpenings',
      // perpendicular roller butts the belt host's +Z guard mid-bed (guardOpenings.test.ts geometry)
      parts: () => [belt('host', 0, 0), sdkRoller('in', 2, 0.3 + 1, Math.PI / 2, 2), box('b1', 10, 10)],
      fn: computeSceneOpenings,
      participantId: 'in',
      expectNonEmpty: true,
    },
    {
      name: 'resolveRollerGrids',
      // two collinear butted world-phase roller beds (ends meet at x=1) + a box
      parts: () => [sdkRoller('r1', 0, 0, 0, 2), sdkRoller('r2', 2, 0, 0, 2), box('b1', 5, 5)],
      fn: resolveRollerGrids,
      participantId: 'r2',
      expectNonEmpty: true,
    },
    {
      name: 'computeSceneExtents',
      parts: () => [belt('host', 0, 0), sdkRoller('in', 2, 0.3 + 1, Math.PI / 2, 2), box('b1', 10, 10)],
      fn: computeSceneExtents,
      participantId: 'in',
      expectNonEmpty: false, // no spur in the fixture - an empty map is still a cacheable result
    },
    {
      name: 'computeDeckClusters',
      parts: () => [belt('a', 0, 0), belt('b', 4.5, 0), box('b1', 10, 10)],
      fn: computeDeckClusters,
      participantId: 'b',
      expectNonEmpty: true,
    },
  ]

  for (const c of cases) {
    describe(c.name, () => {
      it('reuses the cached map by identity when only a non-participant moved', () => {
        const parts = c.parts()
        const r1 = c.fn(parts)
        if (c.expectNonEmpty) expect(r1.size).toBeGreaterThan(0)
        const r2 = c.fn(movePart(parts, 'b1', 1)) // the box-drag transient frame
        expect(r2).toBe(r1)
      })

      it('cached result equals a fresh recompute (clone-forced uncached path)', () => {
        const parts = c.parts()
        const cached = c.fn(parts)
        const fresh = c.fn(freshClones(parts))
        expect(fresh).not.toBe(cached)
        expect(fresh).toEqual(cached)
      })

      it('recomputes when a participant moves, matching its own fresh recompute', () => {
        const parts = c.parts()
        const r1 = c.fn(parts)
        const moved = movePart(parts, c.participantId, 50)
        const r2 = c.fn(moved)
        expect(r2).not.toBe(r1)
        expect(c.fn(freshClones(moved))).toEqual(r2)
      })
    })
  }

  it('computeSceneOpenings invalidates when the opener package is unregistered (same part refs)', () => {
    const parts = [belt('host', 0, 0), sdkRoller('in', 2, 0.3 + 1, Math.PI / 2, 2)]
    const before = computeSceneOpenings(parts)
    expect(before.size).toBe(1)
    unregisterPackage('acme.roller') // 'in' stops being an opener - output must change with identical refs
    const after = computeSceneOpenings(parts)
    expect(after).not.toBe(before)
    expect(after.size).toBe(0)
  })
})
