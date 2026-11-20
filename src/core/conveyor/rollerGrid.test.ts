import { afterEach, describe, expect, it } from 'vitest'
import { ARC_END_EXT, CURVED_ROLLER_END_EXT, ROLLER_PITCH, ROLLER_RADIUS } from '../types'
import type { SdkPart, PartInstance } from '../types'
import { forwardXZ } from '../math'
import { resolveRollerGrids, rollerStations } from './rollerGrid'
import type { RollerGrid } from './rollerGrid'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// ---- SDK fixtures (hoisted) ----------------------------------------------------------------------------------
// Conveyors are `custom` parts on the public SDK (docs/architecture.md), so every fixture is an SDK custom part the
// seam resolver recognizes through partGeometry: a worldPhase roller bed (isWorldPhaseRollerBed +
// a straight bed) and an SDK curved roller (an arc bed with an `endGap` below the belt half-pulley)
// that seeds the shared world pitch grid.

const ROLLER_PKG = 'test.sdk-roller'
const CURVE_PKG = 'test.sdk-curve-roller'
const BELT_PKG = 'test.sdk-curve-belt'

// a worldPhase roller bed: a rig with a `conveys` deck link + a `roller` array-link whose distribute locks its
// copies to the world pitch grid (`worldPhase`, maxSpacing = the roller pitch). length/width `face` handles make
// it a centre-origin straight conveyor. `maxSpacing` is overridable so tests can vary the roller pitch per bed.
const rollerPkg = (id = ROLLER_PKG, maxSpacing = ROLLER_PITCH): PartPackage => ({
  format: PACKAGE_FORMAT,
  id,
  name: 'SDK Roller', conveyor: { bed: 'straight', surface: 'roller' },
  category: 'Equipment',
  params: {
    length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } },
    width: { type: 'number', default: 1, handle: { kind: 'face', axis: 'z' } },
  },
  behavior: 'definePart({ step(){} })',
  geometry: {
    kind: 'rig',
    links: [
      { name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1] }, offset: [0, -0.02, 0], conveys: true },
      // the world-phase roller grid that marks this as an SDK roller bed
      { name: 'rollerGrid', shape: { kind: 'frame' }, offset: [0, -0.024, 0], array: { distribute: { axis: 0, spanParam: 'length', maxSpacing, worldPhase: true } } },
    ],
    joints: [],
    bounds: { length: 3, width: 1.1, top: 1.2 },
  },
})

// centre-origin custom straight roller bed (ends at ±length/2)
const sdkRoller = (id: string, x: number, z: number, rotationY = 0, length = 3, pkgId = ROLLER_PKG): SdkPart => ({
  id,
  type: 'part',
  packageId: pkgId,
  position: [x, 0.75, z],
  rotationY,
  params: { length, width: 1 },
})

// an SDK curved conveyor: a `function`/`conveys` part whose sweep param declares an `arc` handle. Pass
// `endGap: CURVED_ROLLER_END_EXT` for a curved roller (a grid anchor); omit it for a curved belt (not an anchor).
const curvePkg = (id: string, endGap?: number): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id,
    name: 'SDK Curve', conveyor: { bed: 'arc', surface: 'roller', speedParam: 'speed' },
    category: 'Equipment',
    params: {
      innerRadius: { type: 'number', default: 0.6 },
      width: { type: 'number', default: 0.6 },
      sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width', ...(endGap !== undefined ? { endGap } : {}) } },
      speed: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2, width: 2, top: 0.5 }, conveys: true },
  }) as unknown as PartPackage

// SDK curve at origin (rot 0): centreline radius rc = innerRadius + width/2 = 0.9. Its back (entry) end sits at
// world (rc, +endExt) = (0.9, 0.002); a straight whose end sits there butts it. Its front end is at (-0.002, -0.9).
const sdkCurve = (id: string, pkgId: string): SdkPart =>
  ({ id, type: 'part', packageId: pkgId, position: [0, 0.75, 0], rotationY: 0, params: { innerRadius: 0.6, width: 0.6, sweepDeg: 90, speed: 0.5 } }) as unknown as SdkPart

/** signed position of a part's origin along its own conveying axis */
function axisOrigin(part: PartInstance): number {
  const f = forwardXZ(part.rotationY)
  return part.position[0] * f.x + part.position[2] * f.z
}

/** roller stations projected to world positions along the conveying axis */
function worldStations(part: PartInstance, grid?: RollerGrid): number[] {
  const s = axisOrigin(part)
  return rollerStations(part, grid).map((o) => o + s)
}

afterEach(() => clearPackages())

describe('rollerStations (default world-pitch grid, no neighbours)', () => {
  it('ascends exactly one pitch apart and stays within the centre-origin bed [-length/2, length/2]', () => {
    registerPackage(rollerPkg())
    const radius = ROLLER_RADIUS
    const pitch = ROLLER_PITCH
    const offsets = rollerStations(sdkRoller('s1', 0.1, 0, 0, 3))
    expect(offsets.length).toBe(40)
    // centre-origin: offsets run within [-1.5, 1.5]. The bed origin (x=0.1) phases the rollers onto the shared world grid, so both edge rollers clear the footprint.
    expect(offsets[0]).toBeCloseTo(-1.45, 10)
    expect(offsets[offsets.length - 1]).toBeCloseTo(1.475, 10)
    for (const o of offsets) {
      expect(o).toBeGreaterThanOrEqual(-1.5 + radius - 1e-9)
      expect(o).toBeLessThanOrEqual(1.5 - radius + 1e-9)
    }
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]! - offsets[i - 1]!).toBeCloseTo(pitch, 10)
    }
  })

  it('places interior stations on world-grid multiples of the roller pitch (any bed spacing)', () => {
    // an SDK bed declares any maxSpacing directly, rather than picking from fixed roller classes
    for (const [i, maxSpacing] of [0.075, 0.1, 0.13].entries()) {
      const pkgId = `${ROLLER_PKG}.${i}`
      registerPackage(rollerPkg(pkgId, maxSpacing))
      const part = sdkRoller('s1', 0.926, -0.382, 0, 3, pkgId)
      const stations = worldStations(part)
      expect(stations.length).toBeGreaterThan(10)
      // first/last may be nudged off-grid; interior stations are pure grid lines
      for (const s of stations.slice(1, -1)) {
        expect(s).toBeCloseTo(Math.round(s / maxSpacing) * maxSpacing, 9)
      }
    }
  })

  it('nudges edge rollers inward by the roller radius (constant radius across bed spacings)', () => {
    // the SDK bed uses ROLLER_RADIUS for every spacing
    const radius = ROLLER_RADIUS
    for (const [i, maxSpacing] of [0.075, 0.1, 0.13].entries()) {
      const pkgId = `${ROLLER_PKG}.${i}`
      registerPackage(rollerPkg(pkgId, maxSpacing))
      const part = sdkRoller('s1', 0.37, 0.21, 0.4, 4, pkgId)
      // centre-origin bed [-2, 2]; every roller keeps >= the roller radius clearance from each end
      for (const o of rollerStations(part)) {
        expect(o).toBeGreaterThanOrEqual(-2 + radius - 1e-9)
        expect(o).toBeLessThanOrEqual(2 - radius + 1e-9)
      }
    }
  })

  it('is invariant under translation by exactly one pitch along the axis', () => {
    for (const [i, pitch] of [0.075, 0.1, 0.13].entries()) {
      const pkgId = `${ROLLER_PKG}.${i}`
      registerPackage(rollerPkg(pkgId, pitch))
      const rot = 0.6
      const f = forwardXZ(rot)
      const part = sdkRoller('s1', 0.2, -0.3, rot, 4, pkgId)
      const moved = sdkRoller('s1', 0.2 + pitch * f.x, -0.3 + pitch * f.z, rot, 4, pkgId)
      const a = rollerStations(part)
      const b = rollerStations(moved)
      expect(b.length).toBe(a.length)
      for (let j = 0; j < a.length; j++) expect(b[j]).toBeCloseTo(a[j]!, 9)
    }
  })
})

describe('resolveRollerGrids (neighbour-aware grid)', () => {
  it('a lone roller conveyor gets a default grid (no anchor, both ends nudged)', () => {
    registerPackage(rollerPkg())
    const grids = resolveRollerGrids([sdkRoller('s1', 2, 2)])
    expect(grids.get('s1')).toEqual({ anchor: null, nudgeLo: true, nudgeHi: true })
  })

  it('two collinear butted straights suppress the seam nudge so the bed stays continuous', () => {
    registerPackage(rollerPkg())
    // centre-origin: a's bed spans [1.51, 4.51], b's [4.51, 7.51]; the seam at world x = 4.51 sits just past a
    // grid line (0.01 m, < the roller radius), so a's seam roller lands within radius of its front edge and the
    // un-suppressed edge nudge would pull it inward, opening a gap
    const a = sdkRoller('a', 3.01, 0, 0, 3)
    const b = sdkRoller('b', 6.01, 0, 0, 3)
    const grids = resolveRollerGrids([a, b])
    expect(grids.get('a')!.nudgeHi).toBe(false) // a's front abuts b
    expect(grids.get('b')!.nudgeLo).toBe(false) // b's back abuts a
    expect(grids.get('a')!.nudgeLo).toBe(true) // free ends still nudge
    expect(grids.get('b')!.nudgeHi).toBe(true)

    const pitch = ROLLER_PITCH
    const union = [...worldStations(a, grids.get('a')), ...worldStations(b, grids.get('b'))].sort(
      (p, q) => p - q,
    )
    expect(union.length).toBeGreaterThan(20)
    // the nudge only ever shrinks a gap; the seam must not open a gap wider than one pitch
    for (let i = 1; i < union.length; i++) {
      expect(union[i]! - union[i - 1]!).toBeLessThanOrEqual(pitch + 1e-9)
    }
  })

  it('a straight butted to a curve anchors its grid to the curve end and drops the seam roller', () => {
    registerPackage(rollerPkg())
    registerPackage(curvePkg(CURVE_PKG, CURVED_ROLLER_END_EXT))
    // SDK curve back end world = (rc, +endExt) = (0.9, 0.75, 0.002). A centre-origin bed whose back end
    // (local -length/2) butts that point: rot π/2 sends local +X → world -Z, so back end = pos + (0, +length/2).
    const c = sdkCurve('c', CURVE_PKG)
    const straight = sdkRoller('s', 0.9, CURVED_ROLLER_END_EXT - 1.5, Math.PI / 2, 3)
    const grids = resolveRollerGrids([c, straight])
    const grid = grids.get('s')!
    expect(grid.anchor).not.toBeNull()
    expect(grid.anchor![0]).toBeCloseTo(0.9, 6)
    expect(grid.anchor![2]).toBeCloseTo(CURVED_ROLLER_END_EXT, 6)

    // the anchor projects onto the straight's local axis at its back edge (lo = -length/2); the curve owns that
    // seam roller, so no station lands within half a pitch of it and the first kept roller is one pitch in.
    const pitch = ROLLER_PITCH
    const lo = -1.5
    const stations = rollerStations(straight, grid)
    for (const o of stations) expect(Math.abs(o - lo)).toBeGreaterThanOrEqual(pitch / 2 - 1e-9)
    expect(stations[0]).toBeCloseTo(lo + pitch, 9)
  })

  it('propagates the curve anchor down a chain of collinear straights', () => {
    registerPackage(rollerPkg())
    registerPackage(curvePkg(CURVE_PKG, CURVED_ROLLER_END_EXT))
    const c = sdkCurve('c', CURVE_PKG)
    // a's back (local -length/2) butts the curve back end (0.9, 0.002); b's back butts a's front end, collinear
    const a = sdkRoller('a', 0.9, CURVED_ROLLER_END_EXT - 1.5, Math.PI / 2, 3)
    const b = sdkRoller('b', 0.9, CURVED_ROLLER_END_EXT - 4.5, Math.PI / 2, 3)
    const grids = resolveRollerGrids([c, a, b])
    const ga = grids.get('a')!
    const gb = grids.get('b')!
    expect(ga.anchor).not.toBeNull()
    expect(gb.anchor).not.toBeNull()
    // b inherits a's anchor, so the whole run shares one phase
    expect(gb.anchor![0]).toBeCloseTo(ga.anchor![0], 6)
    expect(gb.anchor![2]).toBeCloseTo(ga.anchor![2], 6)
    expect(ga.nudgeHi).toBe(false) // a's far end abuts b
    expect(gb.nudgeLo).toBe(false) // b's near end abuts a
  })
})

// The spatial-hash neighbour scan (cell == NEIGHBOUR_CENTER_RADIUS, 3x3 block) must find every neighbour an
// all-pairs scan finds, across cell boundaries and at scale, and stay order-deterministic.
describe('resolveRollerGrids - spatial bucketing (large scene equivalence)', () => {
  // a long collinear chain of butted conveyors spans many hash cells; interior seams must all suppress
  const CHAIN = 60 // length-3 beds butt every 3m; cell is 8m → ~15 cells, lots of cross-cell seams
  // centre-origin: bed i is centred at x = 3 + 3i, so bed i spans [1.5 + 3i, 4.5 + 3i] and butts its neighbours
  const chain = (): SdkPart[] => Array.from({ length: CHAIN }, (_, i) => sdkRoller(`c${i}`, 3 + i * 3, 0, 0, 3))

  it('suppresses every interior seam nudge down a chain that crosses many cells', () => {
    registerPackage(rollerPkg())
    const grids = resolveRollerGrids(chain())
    for (let i = 0; i < CHAIN; i++) {
      const g = grids.get(`c${i}`)!
      expect(g.anchor).toBeNull()
      expect(g.nudgeLo).toBe(i === 0) // only the first bed's back is a free end
      expect(g.nudgeHi).toBe(i === CHAIN - 1) // only the last bed's front is free
    }
  })

  it('is order-invariant: shuffling the parts array yields identical grids', () => {
    registerPackage(rollerPkg())
    const parts = chain()
    const shuffled = [...parts].reverse() // reverse feeds `nodes` in the opposite order
    const a = resolveRollerGrids(parts)
    const b = resolveRollerGrids(shuffled)
    for (const p of parts) expect(b.get(p.id)).toEqual(a.get(p.id))
  })

  it('leaves beds spaced farther than the neighbour radius on the default grid (no false neighbours across cells)', () => {
    registerPackage(rollerPkg())
    // 200 isolated beds on a coarse grid, each > NEIGHBOUR_CENTER_RADIUS (8m) from any other
    const parts = Array.from({ length: 200 }, (_, i) => sdkRoller(`i${i}`, (i % 20) * 12, Math.floor(i / 20) * 12, 0, 3))
    const grids = resolveRollerGrids(parts)
    for (const p of parts) expect(grids.get(p.id)).toEqual({ anchor: null, nudgeLo: true, nudgeHi: true })
  })

  it('propagates a curve anchor down a long chain spanning many cells', () => {
    registerPackage(rollerPkg())
    registerPackage(curvePkg(CURVE_PKG, CURVED_ROLLER_END_EXT))
    const c = sdkCurve('c', CURVE_PKG) // back end at (0.9, 0.002); chain runs along -Z (rotationY π/2)
    const beds = Array.from({ length: 40 }, (_, i) => sdkRoller(`s${i}`, 0.9, CURVED_ROLLER_END_EXT - 1.5 - i * 3, Math.PI / 2, 3))
    const grids = resolveRollerGrids([c, ...beds])
    const first = grids.get('s0')!
    expect(first.anchor).not.toBeNull()
    for (let i = 1; i < beds.length; i++) {
      const g = grids.get(`s${i}`)!
      expect(g.anchor).not.toBeNull() // the anchor reached the far end of the chain
      expect(g.anchor![0]).toBeCloseTo(first.anchor![0], 6)
      expect(g.anchor![2]).toBeCloseTo(first.anchor![2], 6)
    }
  })
})

// Seam resolver (docs/seam-resolvers.md, step 3): an SDK custom straight roller bed (a rig with a world-phase
// array grid) is recognized as a straight node, so its grid phase inherits a butted curve's anchor and propagates
// down a collinear chain.
describe('resolveRollerGrids - SDK custom roller bed recognition', () => {
  it('is recognized as a straight roller node (gets a default grid entry)', () => {
    registerPackage(rollerPkg())
    const grids = resolveRollerGrids([sdkRoller('s1', 0, 0)])
    expect(grids.get('s1')).toEqual({ anchor: null, nudgeLo: true, nudgeHi: true })
  })

  it('a custom part without a world-phase grid is not treated as a roller bed', () => {
    const beltish = rollerPkg()
    beltish.geometry = { ...beltish.geometry, links: [(beltish.geometry as { links: unknown[] }).links[0]] } as PartPackage['geometry'] // deck only, no roller grid
    registerPackage(beltish)
    expect(resolveRollerGrids([sdkRoller('s1', 0, 0)]).get('s1')).toBeUndefined()
  })

  it("inherits a butted curve's anchor (curve-phased grid on the SDK bed)", () => {
    registerPackage(rollerPkg())
    registerPackage(curvePkg(CURVE_PKG, CURVED_ROLLER_END_EXT))
    // the SDK curve back end is (0.9, 0.002). A centre-origin bed whose back butts it sits half a length past
    // it (bed runs -Z), rotationY = π/2.
    const c = sdkCurve('c', CURVE_PKG)
    const s = sdkRoller('s', 0.9, CURVED_ROLLER_END_EXT - 1.5, Math.PI / 2, 3)
    const grid = resolveRollerGrids([c, s]).get('s')!
    expect(grid.anchor).not.toBeNull()
    expect(grid.anchor![0]).toBeCloseTo(0.9, 6)
    expect(grid.anchor![2]).toBeCloseTo(CURVED_ROLLER_END_EXT, 6)
  })

  it('propagates the curve anchor to a second collinear SDK bed down the chain', () => {
    registerPackage(rollerPkg())
    registerPackage(curvePkg(CURVE_PKG, CURVED_ROLLER_END_EXT))
    const c = sdkCurve('c', CURVE_PKG)
    const a = sdkRoller('a', 0.9, CURVED_ROLLER_END_EXT - 1.5, Math.PI / 2, 3) // back butts the curve back end
    const b = sdkRoller('b', 0.9, CURVED_ROLLER_END_EXT - 4.5, Math.PI / 2, 3) // back butts a's far end, collinear
    const grids = resolveRollerGrids([c, a, b])
    const ga = grids.get('a')!
    const gb = grids.get('b')!
    expect(ga.anchor).not.toBeNull()
    expect(gb.anchor).not.toBeNull()
    expect(gb.anchor![0]).toBeCloseTo(ga.anchor![0], 6) // b inherits a's anchor - one phase down the run
    expect(gb.anchor![2]).toBeCloseTo(ga.anchor![2], 6)
    expect(ga.nudgeHi).toBe(false) // a's far end abuts b (collinear straight-straight seam)
    expect(gb.nudgeLo).toBe(false)
  })
})

// An SDK curved roller (a `function`-geometry arc part whose handle declares endGap = CURVED_ROLLER_END_EXT) is
// a roller-grid anchor source too, so a straight butting it phases its rollers onto the curve seam, like the
// built-in curved roller. A curved belt (default belt endGap) has no rollers and stays excluded.
describe('resolveRollerGrids - SDK curved roller as anchor source', () => {
  it('a straight butted to an SDK curved roller inherits its end as the grid anchor', () => {
    registerPackage(rollerPkg())
    registerPackage(curvePkg(CURVE_PKG, CURVED_ROLLER_END_EXT))
    // curve back end world (0.9, 0.75, 0.002); the SDK straight's back end (local -length/2) sits exactly there
    const straight = sdkRoller('s', 0.9, CURVED_ROLLER_END_EXT - 1.5, Math.PI / 2, 3)
    const grid = resolveRollerGrids([sdkCurve('cv', CURVE_PKG), straight]).get('s')!
    expect(grid.anchor).not.toBeNull()
    expect(grid.anchor![0]).toBeCloseTo(0.9, 6)
    expect(grid.anchor![2]).toBeCloseTo(CURVED_ROLLER_END_EXT, 6)
  })

  it('an SDK curved belt (belt end gap, no rollers) is not an anchor source', () => {
    registerPackage(rollerPkg())
    registerPackage(curvePkg(BELT_PKG)) // no endGap → belt half-pulley (ARC_END_EXT)
    // the straight's back end sits on the belt curve's real back end (0.9, ARC_END_EXT) - genuine contact, yet no
    // anchor, because a curved belt is excluded from the roller grid (only the roller curve above anchors).
    const straight = sdkRoller('s', 0.9, ARC_END_EXT - 1.5, Math.PI / 2, 3)
    const grid = resolveRollerGrids([sdkCurve('cv', BELT_PKG), straight]).get('s')!
    expect(grid.anchor).toBeNull()
  })
})
