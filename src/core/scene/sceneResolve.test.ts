import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveScene } from './sceneResolve'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import type { SdkPart, PartInstance } from '../types'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// Two butted belt-like SDK parts: enough to make the deck-merge (sim-only) and the roller-grid /
// leg-rest (render-only) resolvers have something to say. Mirrors deckClusters.test.ts's fixture.
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

const belt = (id: string, x: number): SdkPart =>
  ({ id, type: 'part', packageId: 'acme.belt', position: [x, 2, 0], rotationY: 0, params: { segments: [[4, 0]], width: 0.6, height: 0.5 } }) as unknown as SdkPart

/**
 * Render and sim read mostly disjoint slices of ResolvedContext, and resolveScene runs only the
 * resolvers its caller reads. This is a performance contract: the resolvers are memoized
 * all-or-nothing, so under streamed motion (a drag) every frame re-runs whichever ones are
 * wired up. Computing the other side's fields costs render ~20 ms per frame at 240 parts.
 *
 * If a consumer starts reading a field it doesn't get here, add it to that consumer's branch in
 * resolveScene and to its *ResolvedKey. Don't just widen this test.
 */
describe('resolveScene consumer split', () => {
  beforeEach(() => registerPackage(customBeltPkg()))
  afterEach(() => clearPackages())

  const parts: PartInstance[] = [belt('a', 0), belt('b', 4)]

  it('render never pays for the sim-only fields', () => {
    for (const ctx of resolveScene(parts, 'render').values()) {
      expect(ctx.cluster).toBeUndefined()
      expect(ctx.guardRun).toBeUndefined()
    }
  })

  it('sim never pays for the render-only fields', () => {
    for (const ctx of resolveScene(parts, 'sim').values()) {
      expect(ctx.grid).toBeUndefined()
      expect(ctx.legRests).toBeUndefined()
    }
  })

  it('sim still resolves the deck-merge cluster it depends on', () => {
    const sim = resolveScene(parts, 'sim')
    // the two belts butt end-to-end, so they merge into one deck cluster
    expect([...sim.values()].some((c) => c.cluster !== undefined)).toBe(true)
  })

  it('render resolves nothing for a scene whose only seam effect is sim-only', () => {
    // Two butted belts: the deck merge is the only neighbour effect here, and it is sim's alone.
    // Render's context is therefore empty, so render never computes that merge only to discard it
    // on every drag frame.
    expect(resolveScene(parts, 'render').size).toBe(0)
    expect(resolveScene(parts, 'sim').size).toBeGreaterThan(0)
  })
})

/**
 * A part's own authored guard openings go into the same ResolvedContext.openings both consumers read, so the
 * rendered guard mesh (render/parts/sdk/rig.ts guardSplitLinks) and the guard collider (sim/rigBuild.ts
 * buildRigBodies) cut identically. That is why they are folded in at guardOpenings.deriveGuardOpenings rather
 * than at each consumer. Assert both sides see them, with no neighbour in the scene at all.
 */
describe('authored guard openings reach both consumers', () => {
  function rollerPkg(): PartPackage {
    return {
      format: PACKAGE_FORMAT,
      id: 'acme.roller',
      name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
      params: {
        length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
        width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
        speed: { type: 'number', default: 0.5 },
        guardOpenings: { type: 'numberList', arity: 3, default: [] },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.04, 0.6] }, offset: [0, 0, 0], conveys: true }], joints: [], bounds: { length: 4, width: 0.6, top: 0.9 } },
    } as unknown as PartPackage
  }
  const roller: PartInstance = {
    id: 'r', type: 'part', packageId: 'acme.roller', position: [0, 2, 0], rotationY: 0,
    params: { length: 4, width: 0.6, speed: 0.5, guardOpenings: [[1, 1.5, -1]] },
  } as unknown as SdkPart

  beforeEach(() => registerPackage(rollerPkg()))
  afterEach(() => clearPackages())

  for (const consumer of ['render', 'sim'] as const) {
    it(`${consumer} sees the authored opening, shifted into the bed's centre origin`, () => {
      const ctx = resolveScene([roller], consumer).get('r')
      expect(ctx?.openings).toEqual({ left: [[-1, -0.5]], right: [] })
    })
  }
})
