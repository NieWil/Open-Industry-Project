import { afterEach, describe, expect, it } from 'vitest'
import { computeStructureConnections, platformConnectionKey } from './structureConnections'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartPackage } from './parts/partPackage'
import type { PartInstance } from './types'
import { STAIRS_LANDING_DEPTH, STAIRS_STANDARD_RISE, STAIRS_STANDARD_TREAD } from './types'
import { PACKAGE_FORMAT } from './parts/partPackage'

// fixture packages mirroring the shipped SDK platform (a `deck` surface with heightParam) + stairs (an edgeMount facing
// into the deck: the contact is the landing end, `landingDepth` along X and `topOffset` up, as the format 3 upgrade maps it)
function platformPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT, id: 'acme.platform', name: 'Platform',
    params: { length: { type: 'number', default: 4 }, width: { type: 'number', default: 4 }, height: { type: 'number', default: 2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.006, 4] }, offset: [0, -0.003, 0], finish: 'deck', notchable: true }], joints: [], bounds: { length: 4, width: 4, top: 1.07 } },
    snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width', heightParam: 'height' }] },
  } as unknown as PartPackage
}
function stairPkg(extras: { landingDepth?: number; topOffset?: number } = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT, id: 'acme.stairs', name: 'Stairs',
    params: { numSteps: { type: 'number', default: 11, min: 2, max: 40 }, width: { type: 'number', default: 1.2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'tread', shape: { kind: 'box', size: [0.3, 0.05, 1.2] }, offset: [0.14, 0.178, 0] }], joints: [], bounds: { length: 3.18, width: 1.4, top: 3 } },
    snap: {
      edgeMount: {
        accepts: 'deck', alongParam: 'width', reach: 3, facing: 'into',
        at: [extras.landingDepth ?? 0, extras.topOffset ?? 0, 0],
        atParams: [{ axis: 0, param: 'numSteps', scale: STAIRS_STANDARD_TREAD }, { axis: 1, param: 'numSteps', scale: STAIRS_STANDARD_RISE }],
        fromFloor: { param: 'numSteps' },
        opens: true, notch: true, lift: true,
      },
    },
  } as unknown as PartPackage
}
const platform = (id: string, x: number, z: number, height = 2, rot = 0): PartInstance =>
  ({ id, type: 'part', packageId: 'acme.platform', position: [x, height, z], rotationY: rot, params: { length: 4, width: 4, height } }) as unknown as PartInstance
const stair = (id: string, x: number, y: number, z: number, rot: number, numSteps = 11, width = 1.2): PartInstance =>
  ({ id, type: 'part', packageId: 'acme.stairs', position: [x, y, z], rotationY: rot, params: { numSteps, width } }) as unknown as PartInstance

const RUN = 11 * STAIRS_STANDARD_TREAD // 3.08
const RISE_TOTAL = 11 * STAIRS_STANDARD_RISE // 1.958

describe('structure connections (stair → platform railing opening + deck notch + landing raise)', () => {
  afterEach(() => clearPackages())

  it('opens the platform railing over the stair width where the top butts the edge, and flags the stair with its lift', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg())
    // a landing-less flight: foot at floor y=0 (top y = 1.958 ≈ deck top 2), top-of-run on the +X edge (rot π)
    const c = computeStructureConnections([platform('p', 0, 0, 2), stair('s', 2 + RUN, 0, 0, Math.PI)])
    const conn = c.platform.get('p')
    expect(conn).toBeTruthy()
    expect(conn!.openings.posX).toHaveLength(1)
    expect(conn!.openings.posX[0]![0]).toBeCloseTo(-0.6, 3) // stair width ±0.6 projected onto the edge
    expect(conn!.openings.posX[0]![1]).toBeCloseTo(0.6, 3)
    expect(conn!.openings.negX).toEqual([])
    expect(conn!.openings.posZ).toEqual([])
    // flagged connected, and the landing lift = deckTop(2) − flight top(1.958) + 1mm z-fight clearance
    expect(c.stairTopConnected.has('s')).toBe(true)
    expect(c.stairTopConnected.get('s')).toBeCloseTo(2 - RISE_TOTAL + 0.001, 3)
    // edge-flush snap → no deck notch (the footprint only nicks the rim)
    expect(conn!.notches).toEqual([])
  })

  it('a flight declaring a top landing seats the landing end on the edge and lifts by the walking-surface residual', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg({ landingDepth: STAIRS_LANDING_DEPTH, topOffset: 0.025 }))
    // the snap pose for a landing flight: foot = edge + (run + landing) outward, landing end on the edge
    const c = computeStructureConnections([platform('p', 0, 0, 2), stair('s', 2 + RUN + STAIRS_LANDING_DEPTH, 0, 0, Math.PI)])
    const conn = c.platform.get('p')
    expect(conn).toBeTruthy()
    expect(conn!.openings.posX).toHaveLength(1) // opening keyed at the landing end, which butts the edge
    expect(conn!.openings.posX[0]![0]).toBeCloseTo(-0.6, 3)
    expect(conn!.openings.posX[0]![1]).toBeCloseTo(0.6, 3)
    // lift makes the landing top (steps·rise + topOffset) flush with the deck top (+1mm clearance)
    expect(c.stairTopConnected.get('s')).toBeCloseTo(2 - (RISE_TOTAL + 0.025) + 0.001, 3)
    // flight entirely outside the deck → no notch (the edge-flush behavior)
    expect(conn!.notches).toEqual([])
  })

  it('cuts a deck notch when the stair overlaps the deck interior (but no railing edge)', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg())
    // foot at x=1.5, ascending -X → top at x ≈ -1.58 (inside the 4×4 deck), not on an edge
    const c = computeStructureConnections([platform('p', 0, 0, 2), stair('s', 1.5, 0, 0, Math.PI)])
    const conn = c.platform.get('p')
    expect(conn).toBeTruthy()
    expect(conn!.notches).toHaveLength(1)
    expect(conn!.notches[0]!.x1 - conn!.notches[0]!.x0).toBeGreaterThan(1) // a real cut, not a sliver
    expect(conn!.notches[0]!.z0).toBeCloseTo(-0.6, 3)
    expect(conn!.notches[0]!.z1).toBeCloseTo(0.6, 3)
    // the top is interior, so no perimeter edge opens
    expect(conn!.openings.posX).toEqual([])
    expect(conn!.openings.negX).toEqual([])
  })

  it('holes the deck whenever the flight crosses the deck plane - even with the top far above', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg())
    // a 20-step flight (top y = 3.56, well above the 2 m deck) standing over the deck interior: the stairwell
    // is cut wherever the flight passes through the deck plane; the railing/lift stay unengaged
    const c = computeStructureConnections([platform('p', 0, 0, 2), stair('s', 1.5, 0, 0, Math.PI, 20)])
    const conn = c.platform.get('p')
    expect(conn).toBeTruthy()
    expect(conn!.notches).toHaveLength(1)
    expect(c.stairTopConnected.has('s')).toBe(false) // top not at the deck plane → no railing opening, no lift
  })

  it('a stair standing on the deck (foot at deck top) does not hole it', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg())
    const c = computeStructureConnections([platform('p', 0, 0, 2), stair('s', 0, 2, 0, Math.PI)])
    expect(c.platform.size).toBe(0)
  })

  it('no connection when the stair top is nowhere near the deck plane', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg())
    const c = computeStructureConnections([platform('p', 0, 0, 2), stair('s', 2 + RUN, -5, 0, Math.PI)])
    expect(c.platform.size).toBe(0)
    expect(c.stairTopConnected.size).toBe(0)
  })

  it('opens the −Z edge when the stair meets that side, and the key tracks changes', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg())
    // approach the −Z edge (z = −2): stair ascends +Z (rot so local +X = +Z → rotationY = −π/2), top at (0,−2)
    // top center world = origin + rotXZ(run,0,yaw); for local+X=+Z, place foot at z = −2 − run
    const c = computeStructureConnections([platform('p', 0, 0, 2), stair('s', 0, 0, -2 - RUN, -Math.PI / 2)])
    const conn = c.platform.get('p')
    expect(conn).toBeTruthy()
    expect(conn!.openings.negZ).toHaveLength(1)
    expect(conn!.openings.posX).toEqual([])
    const key = platformConnectionKey(conn)
    expect(key).not.toBe(platformConnectionKey(undefined))
    expect(key).toBe(platformConnectionKey(conn)) // stable
  })

  it('empty when no platforms or no stairs are present', () => {
    registerPackage(platformPkg())
    registerPackage(stairPkg())
    expect(computeStructureConnections([platform('p', 0, 0, 2)]).platform.size).toBe(0)
    expect(computeStructureConnections([stair('s', 5, 0, 0, Math.PI)]).platform.size).toBe(0)
  })
})
