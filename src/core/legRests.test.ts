import { afterEach, describe, expect, it } from 'vitest'
import { computeSceneLegRests, legRestDyAt, legRestsKey, withLegRests } from './legRests'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartPackage } from './parts/partPackage'
import type { ParamValue } from './parts/partApi'
import type { PartInstance } from './types'
import { PACKAGE_FORMAT } from './parts/partPackage'

// fixture packages: a function-geometry belt declaring the host-fed `legRests` param (+ the
// rest:'surfaceBelow' stand), a rig roller with a kind:'leg' link, and the SDK platform (deck surface)
function beltPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT, id: 'acme.belt', name: 'Belt',
    params: {
      standHeight: { type: 'number', default: 0.75, rest: 'surfaceBelow' },
      legRests: { type: 'numberList', arity: 3, default: [] },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 6, width: 1, top: 0.5 } },
  } as unknown as PartPackage
}
function rollerPkg(arc = false): PartPackage {
  return {
    format: PACKAGE_FORMAT, id: 'acme.roller', name: 'Roller',
    params: { length: { type: 'number', default: 4 }, width: { type: 'number', default: 1 }, standHeight: { type: 'number', default: 0.75, rest: 'surfaceBelow' } },
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [{ name: 'legs', shape: { kind: 'leg', spanParam: 'length', widthParam: 'width', standParam: 'standHeight', frameDepth: 0.2, ...(arc ? { arc: { radiusParam: 'length', sweepDeg: 90 } } : {}) }, offset: [0, 0, 0] }],
      joints: [], bounds: { length: 4, width: 1, top: 0.5 },
    },
  } as unknown as PartPackage
}
function platformPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT, id: 'acme.platform', name: 'Platform',
    params: { length: { type: 'number', default: 4 }, width: { type: 'number', default: 4 }, height: { type: 'number', default: 2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.006, 4] }, offset: [0, -0.003, 0], finish: 'deck', notchable: true }], joints: [], bounds: { length: 4, width: 4, top: 1.07 } },
    snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width', heightParam: 'height' }] },
  } as unknown as PartPackage
}
const belt = (id: string, x: number, y: number, z: number, rot = 0, standHeight = 2): PartInstance =>
  ({ id, type: 'part', packageId: 'acme.belt', position: [x, y, z], rotationY: rot, params: { standHeight } }) as unknown as PartInstance
const roller = (id: string, x: number, y: number, z: number, standHeight = 2): PartInstance =>
  ({ id, type: 'part', packageId: 'acme.roller', position: [x, y, z], rotationY: 0, params: { length: 4, width: 1, standHeight } }) as unknown as PartInstance
const platform = (id: string, x: number, z: number, height: number, rot = 0): PartInstance =>
  ({ id, type: 'part', packageId: 'acme.platform', position: [x, height, z], rotationY: rot, params: { length: 4, width: 4, height } }) as unknown as PartInstance

function register(...pkgs: PartPackage[]): void {
  for (const p of pkgs) registerPackage(p)
}

describe('leg rests (per-leg footing where a bed crosses a platform)', () => {
  afterEach(() => clearPackages())

  it('a floor-standing belt crossing a platform gets a deck row (dy = deck top − floor) over the covered span', () => {
    register(beltPkg(), platformPkg())
    // belt centred at origin (span x ∈ [−3, 3]) standing on the floor (y 2.01, stand 2 → own floor 0.01);
    // a 1.2 m platform centred at x=2 covers world x ∈ [0, 4] → rows clip to the bed span
    const rests = computeSceneLegRests([belt('b', 0, 2.01, 0), platform('p', 2, 0, 1.2)])
    expect(rests.get('b')).toEqual([[0, 3, 1.19]])
  })

  it('no platforms in the scene ⇒ no rows (single-plane legs, the flat fast path)', () => {
    register(beltPkg(), platformPkg())
    expect(computeSceneLegRests([belt('b', 0, 2.01, 0)]).size).toBe(0)
  })

  it('a platform nowhere near the bed ⇒ no rows', () => {
    register(beltPkg(), platformPkg())
    expect(computeSceneLegRests([belt('b', 0, 2.01, 0), platform('p', 30, 0, 1.2)]).size).toBe(0)
  })

  it('a belt standing on a deck drops its overhanging feet to the warehouse floor (dy < 0)', () => {
    register(beltPkg(), platformPkg())
    // platform top 1.2 centred at x=−2 (covers x ∈ [−4, 0]); belt rests on it (y = 1.2 + 0.75) and
    // overhangs x ∈ [0, 3]: the covered stretch matches its own plane (no row), the overhang falls to the floor
    const rests = computeSceneLegRests([belt('b', 0, 1.95, 0, 0, 0.75), platform('p', -2, 0, 1.2)])
    expect(rests.get('b')).toEqual([[0, 3, -1.2]]) // all the way down to the floor at y=0 (FLOOR_SURFACE_Y)
  })

  it('a raised bed over no deck keeps single-plane legs - the uncovered floor never applies to a part not standing on a deck', () => {
    register(beltPkg(), platformPkg())
    // belt floats at own-floor 1.0 (resting on something that is not a platform - a conveyor, a rack);
    // the far-away platform participates but nothing is under the bed → no rows, feet stay on the part's plane
    const rests = computeSceneLegRests([belt('b', 0, 3.0, 0), platform('p', 30, 0, 1.2)])
    expect(rests.size).toBe(0)
  })

  it('an overhead deck (top above the bed) is not a support', () => {
    register(beltPkg(), platformPkg())
    const rests = computeSceneLegRests([belt('b', 0, 2.01, 0), platform('p', 2, 0, 3)])
    expect(rests.size).toBe(0)
  })

  it('the highest covering deck wins where platforms overlap, and equal-dy segments merge', () => {
    register(beltPkg(), platformPkg())
    // A (top 0.6) covers x ∈ [−4, 0] ∩ span, B (top 1.0) covers x ∈ [−1, 3] ∩ span; B shades A in the overlap
    const rests = computeSceneLegRests([belt('b', 0, 2.01, 0), platform('a', -2, 0, 0.6), platform('bb', 1, 0, 1.0)])
    expect(rests.get('b')).toEqual([[-3, -1, 0.59], [-1, 3, 0.99]])
  })

  it('a rotated bed clips the deck along its own local X', () => {
    register(beltPkg(), platformPkg())
    // belt yawed +90° (local +X → world −Z); platform centred at world z=−2 covers local x ∈ [0, 4] ∩ span
    const rests = computeSceneLegRests([belt('b', 0, 2.01, 0, Math.PI / 2), platform('p', 0, -2, 1.2)])
    expect(rests.get('b')).toEqual([[0, 3, 1.19]])
  })

  it('a rig part with a straight kind:leg link participates via its standParam (no legRests param needed)', () => {
    register(rollerPkg(), platformPkg())
    const rests = computeSceneLegRests([roller('r', 0, 2.01, 0), platform('p', 1.5, 0, 1.2)])
    expect(rests.get('r')).toEqual([[-0.5, 2, 1.19]])
  })

  it('an arc leg link does not participate (curved beds keep single-plane legs)', () => {
    register(rollerPkg(true), platformPkg())
    expect(computeSceneLegRests([roller('r', 0, 2.01, 0), platform('p', 1.5, 0, 1.2)]).size).toBe(0)
  })

  it('withLegRests folds rows only into a package declaring the legRests param', () => {
    register(beltPkg(), rollerPkg(), platformPkg())
    const rows = [[0, 3, 1.19]]
    const base: Record<string, ParamValue> = { standHeight: 2 }
    expect(withLegRests(belt('b', 0, 2.01, 0), base, rows)).toEqual({ standHeight: 2, legRests: rows })
    expect(withLegRests(roller('r', 0, 2.01, 0), base, rows)).toBe(base) // rig parts consume rows directly
    expect(withLegRests(belt('b', 0, 2.01, 0), base, [])).toBe(base)
    expect(withLegRests(belt('b', 0, 2.01, 0), base, undefined)).toBe(base)
  })

  it('legRestDyAt picks the row containing the station, else 0; legRestsKey is stable and empty-safe', () => {
    const rows = [[-2, 0, 0.59], [0, 3, 0.99]]
    expect(legRestDyAt(rows, -1)).toBe(0.59)
    expect(legRestDyAt(rows, 2)).toBe(0.99)
    expect(legRestDyAt(rows, -2.5)).toBe(0)
    expect(legRestDyAt(undefined, 1)).toBe(0)
    expect(legRestsKey(rows)).toBe(JSON.stringify(rows))
    expect(legRestsKey(undefined)).toBe('')
    expect(legRestsKey([])).toBe('')
  })
})
