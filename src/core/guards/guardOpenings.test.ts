import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SdkPart, PartInstance } from '../types'
import type { PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { computeSceneOpenings, deriveGuardOpenings, keptSegments } from './guardOpenings'
import { toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// deriveGuardOpenings opens either a belt-like custom host (a path bed: tail-origin bed 0..extent, guards at
// ±width/2) or a straight roller/face-handle bed (a straight bed: centre-origin bed ±length/2, guards at
// ±width/2). An opener is any custom conveyor (isConveyorLike). So the host fixtures below are belt-like SDK belts
// (and one straight roller host), and the perpendicular openers are centre-origin SDK rollers. Their ends are
// flush at ±length/2, so an opener origin sits length/2 back off the edge. keptSegments is pure.

// a belt-like custom/SDK host (declares a `path` handle) - flat length-L bed, width 0.6, height-0.5 pulleys.
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

// a straight SDK roller opener: `conveys` rig + length/width `face` handles, centre-origin (flush ends at
// ±length/2).
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
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.04, 0.6] }, conveys: true }], joints: [], bounds: { length: 2, width: 0.6, top: 0.9 } },
  } as unknown as PartPackage
}
// centre-origin: front end at local x = +length/2. To land the front on a host's +Z edge (z=0.3) at host-local
// x, place the opener origin length/2 back off the edge (z = 0.3 + length/2 for a π/2 yaw pointing −Z).
function sdkRoller(id: string, x: number, z: number, rot = 0, length = 2): SdkPart {
  return { id, type: 'part', packageId: 'acme.roller', position: [x, 0.75, z], rotationY: rot, params: { length, width: 0.6, speed: 0.5 } } as unknown as SdkPart
}

// a custom device that mounts against a conveyor guard, its push side (arms) crossing it: the pop-up diverter.
// face 'out' → local +Z away from the belt; `at` (local −Z) is the push-side edge that lands on the guard.
function diverterPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.diverter',
    name: 'Acme Diverter',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.73, width: 2.36, top: 0.82 } },
    snap: { mounts: [{ at: [0, 0, -1.0635], accepts: 'conveyorGuard', face: 'out', yOffset: 0.2, outwardOffset: 0.05, opens: true }] },
  } as unknown as PartPackage
}
// mounted on the host's +Z (right) guard at host-local x: the push-side `at` lands at (x, 0.3 + 0.05), so the
// origin sits push-half (1.0635) further out at z = x-edge + 1.0635 (rotationY 0, body extending +Z).
function diverter(id: string, x: number, z = 0.3 + 0.05 + 1.0635, rot = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.diverter', position: [x, 0.55, z], rotationY: rot, params: {} } as unknown as SdkPart
}

// an inward-facing sensor mount (beam across the belt). It is not a pusher and must never open the guard.
function sensorPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.sensor',
    name: 'Acme Sensor',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.1, width: 0.1, top: 0.1 } },
    snap: { mounts: [{ at: [0, 0, 0.05], accepts: 'conveyorGuard', face: 'in', fitRangeParam: 'maxRange' }] },
  } as unknown as PartPackage
}
function sensor(id: string, x: number, z: number): SdkPart {
  return { id, type: 'part', packageId: 'acme.sensor', position: [x, 0.75, z], rotationY: 0, params: {} } as unknown as SdkPart
}

describe('keptSegments', () => {
  it('returns the whole span with no openings', () => {
    expect(keptSegments(-2, 2, [])).toEqual([[-2, 2]])
  })

  it('removes a central opening, leaving two solid spans', () => {
    expect(keptSegments(-2, 2, [[-0.5, 0.5]])).toEqual([
      [-2, -0.5],
      [0.5, 2],
    ])
  })

  it('drops a span fully covered by an opening', () => {
    expect(keptSegments(-2, 2, [[-3, 3]])).toEqual([])
  })

  it('merges overlapping openings before inverting', () => {
    expect(keptSegments(-2, 2, [[-1, 0], [-0.5, 1]])).toEqual([
      [-2, -1],
      [1, 2],
    ])
  })

  it('clamps openings to the span and trims edge-flush ones', () => {
    expect(keptSegments(-2, 2, [[-2, -0.5]])).toEqual([[-0.5, 2]])
  })
})

describe('deriveGuardOpenings', () => {
  beforeEach(() => {
    registerPackage(customBeltPkg())
    registerPackage(sdkRollerPkg())
  })
  afterEach(() => clearPackages())

  it('opens the side a perpendicular conveyor butts against', () => {
    // belt-like host: bed runs host-local x 0..4; place the contact mid-bed at x=2. a centre-origin roller
    // (length 2, front end at local x=1) rotated π/2 lands its front on the host's +Z edge (z=0.3).
    const host = belt('host', 0, 0)
    const incoming = sdkRoller('in', 2, 0.3 + 1, Math.PI / 2, 2)
    const op = deriveGuardOpenings(host, [host, incoming])
    expect(op.left).toEqual([])
    expect(op.right).toHaveLength(1)
    const [lo, hi] = op.right[0]!
    // opening spans the incoming 0.6 mouth (+ margin both sides), centred at host-local x=2
    expect(lo).toBeCloseTo(1.69, 3)
    expect(hi).toBeCloseTo(2.31, 3)
  })

  it('opens the left side and positions the gap at the contact x', () => {
    const host = belt('host', 0, 0)
    // incoming front end at host-local (1.0, -0.3): body extends -Z (rot = -π/2). Centre-origin front is at
    // local x=1, so the origin sits length/2 (=1) further out.
    const incoming = sdkRoller('in', 1.0, -(0.3 + 1), -Math.PI / 2, 2)
    const op = deriveGuardOpenings(host, [host, incoming])
    expect(op.right).toEqual([])
    expect(op.left).toHaveLength(1)
    const [lo, hi] = op.left[0]!
    expect((lo + hi) / 2).toBeCloseTo(1.0, 3)
  })

  it('does not open for a collinear end-to-end neighbour', () => {
    const host = belt('host', 0, 0) // belt front end at ~4.25
    const next = sdkRoller('next', 5.25, 0, 0, 2) // back end (local x=-1) meets host front end, same axis, z=0
    const op = deriveGuardOpenings(host, [host, next])
    expect(op.left).toEqual([])
    expect(op.right).toEqual([])
  })

  it('opens a straight roller host where a perpendicular conveyor butts its side', () => {
    // a straight SDK roller is centre-origin (bed ±length/2, guards at ±width/2), so it hosts side
    // openings like the belt. host length 4 → bed ±2, width 0.6 → guards at ±0.3. The incoming roller
    // (front end at local x=1) rotated π/2 lands its front on the host's +Z edge at host-local x=0.
    const host = sdkRoller('host', 0, 0, 0, 4)
    const incoming = sdkRoller('in', 0, 0.3 + 1, Math.PI / 2, 2)
    const op = deriveGuardOpenings(host, [host, incoming])
    expect(op.left).toEqual([])
    expect(op.right).toHaveLength(1)
    const [lo, hi] = op.right[0]!
    // opening spans the incoming 0.6 mouth (+ 0.01 margin each side), centred at host-local x=0
    expect(lo).toBeCloseTo(-0.31, 3)
    expect(hi).toBeCloseTo(0.31, 3)
    // and surfaces through the scene-level map keyed by the roller host
    expect([...computeSceneOpenings([host, incoming]).keys()]).toEqual(['host'])
  })

  it('merges two incoming ends that overlap on the same side', () => {
    // belt-like host bed [0, 6]; place both contacts mid-bed (x≈3) so the mouths overlap
    const host = belt('host', 0, 0, 0, 6)
    const a = sdkRoller('a', 2.8, 0.3 + 1, Math.PI / 2, 2)
    const b = sdkRoller('b', 3.2, 0.3 + 1, Math.PI / 2, 2)
    const op = deriveGuardOpenings(host, [host, a, b])
    expect(op.right).toHaveLength(1)
  })
})

describe('computeSceneOpenings', () => {
  beforeEach(() => {
    registerPackage(customBeltPkg())
    registerPackage(sdkRollerPkg())
  })
  afterEach(() => clearPackages())

  it('maps only conveyors that actually have openings', () => {
    const host = belt('host', 0, 0)
    const incoming = sdkRoller('in', 2, 0.3 + 1, Math.PI / 2, 2)
    const lonely = belt('lonely', 20, 20) // a belt-like host with no opener near it
    const map = computeSceneOpenings([host, incoming, lonely])
    expect([...map.keys()]).toEqual(['host'])
  })

  // The spatial broad-phase must find every contact an O(n^2) all-pairs scan finds, across grid-cell
  // boundaries and at scale. Brute-force reference = deriveGuardOpenings against every part (it filters
  // openers/hosts internally).
  it('equals the brute-force all-pairs scan on a large mixed scene', () => {
    const all: PartInstance[] = []
    // 40 belt-like hosts butted along a row (span ~160m → many cells), z = 0, length 4
    for (let i = 0; i < 40; i++) all.push(belt(`h${i}`, i * 4, 0, 0, 4))
    // perpendicular roller openers landing mid-bed on assorted hosts (each opens that host's +Z guard)
    for (const i of [0, 1, 5, 12, 13, 20, 27, 33, 39]) all.push(sdkRoller(`in${i}`, i * 4 + 2, 0.3 + 1, Math.PI / 2, 2))
    // far-away lonely belt-like hosts that must remain openingless
    for (let i = 0; i < 6; i++) all.push(belt(`far${i}`, i * 30, 200, 0, 4))

    const brute = new Map<string, unknown>()
    for (const p of all) {
      const op = deriveGuardOpenings(p, all) // internal host/opener filters → same as passing the openers set
      if (op.left.length > 0 || op.right.length > 0) brute.set(p.id, op)
    }
    const fast = computeSceneOpenings(all)

    expect([...fast.keys()].sort()).toEqual([...brute.keys()].sort())
    for (const id of brute.keys()) expect(fast.get(id)).toEqual(brute.get(id))
    expect(brute.size).toBeGreaterThan(5) // guard: the fixture actually produces openings
  })
})

describe('belt-like custom/SDK hosts + openers', () => {
  afterEach(() => clearPackages())

  it('a belt-like custom host opens its guard where a neighbour butts', () => {
    registerPackage(customBeltPkg())
    registerPackage(sdkRollerPkg())
    const host = belt('host', 0, 0)
    const incoming = sdkRoller('in', 2, 0.3 + 1, Math.PI / 2, 2) // butts host +Z edge mid-bed (x=2)
    const op = deriveGuardOpenings(host, [host, incoming])
    expect(op.left).toEqual([])
    expect(op.right).toHaveLength(1)
    expect(op.right[0]![0]).toBeCloseTo(1.69, 2)
    expect(op.right[0]![1]).toBeCloseTo(2.31, 2)
    expect([...computeSceneOpenings([host, incoming]).keys()]).toEqual(['host'])
  })

  it('a belt-like custom part is an opener - a belt-like host it butts gets the opening', () => {
    // two flat length-4 belts butted end-to-side: the custom belt 'in' (tail-origin front end at +X 4.25) is
    // turned 90° so that end lands on the host belt's +Z edge mid-bed, opening the host's right guard.
    registerPackage(customBeltPkg())
    const host = belt('host', 0, 0, 0, 4)
    const incoming = belt('in', 2, 0.3 + 4.25, Math.PI / 2) // height 0.5 → pulley 0.25, length 4 → front at 4.25
    const op = deriveGuardOpenings(host, [host, incoming])
    expect(op.right).toHaveLength(1)
  })

  it('an SDK spur is an opener, with the gap sized to its sheared (wider) end face', () => {
    // an SDK spur (centre-origin, front face at local x = +1, splayed 30°): rotated 60° so the angled face's
    // outward normal points straight at the host's +Z wall, its front end landing mid-bed at (2, 0.3).
    registerPackage(customBeltPkg())
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'test.sdkspur',
      name: 'SDK Spur', conveyor: { bed: 'spur', surface: 'roller' },
      params: {
        length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg' } },
        width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
        angleFrontDeg: { type: 'number', default: 0 },
        angleBackDeg: { type: 'number', default: 0 },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'drawn', bounds: { length: 2, width: 0.6, top: 0.5 }, conveys: true },
    } as unknown as PartPackage)
    const host = belt('host', 0, 0)
    const fa = Math.PI / 6 // 30° front splay
    const rot = Math.PI / 2 - fa // outward (cos fa, −sin fa) rotated to world −Z
    const spur = {
      id: 'sp',
      type: 'part',
      packageId: 'test.sdkspur',
      position: [2 - Math.cos(rot), 0.75, 0.3 + Math.sin(rot)],
      rotationY: rot,
      params: { length: 2, width: 0.6, angleFrontDeg: 30, angleBackDeg: 0 },
    } as unknown as SdkPart
    const op = deriveGuardOpenings(host, [host, spur])
    expect(op.left).toEqual([])
    expect(op.right).toHaveLength(1)
    const [lo, hi] = op.right[0]!

    // The opening must land exactly on the spur's own guard lines, so the host's guard ends where the
    // spur's begins. Derived here independently of the resolver: intersect each guard line (the spur's
    // +X axis at local z = ±(w/2 + wall)) with the host's outer wall plane (host-local z = 0.3 + 0.01),
    // then read the host-local X of the two hits.
    //
    // Asserting the bed mouth ± a symmetric margin is wrong on a splayed face: the guard offset projects
    // asymmetrically onto the host axis, so that formula leaves a hole at one corner and an overlap at the
    // other. It is right only when the faces are parallel.
    const WALL = 0.01
    const corners = [-1, 1].map((s) => {
      const zGuard = s * (0.6 / 2 + WALL)
      // two points on this guard line, in world, then intersect with the host wall plane z_host = 0.31
      const a = toWorldXZ(spur, 0, zGuard)
      const b = toWorldXZ(spur, 1, zGuard)
      const la = toLocalXZ(host, a.x, a.z)
      const lb = toLocalXZ(host, b.x, b.z)
      const t = (0.3 + WALL - la.z) / (lb.z - la.z)
      return la.x + (lb.x - la.x) * t
    })
    expect(lo).toBeCloseTo(Math.min(...corners), 3)
    expect(hi).toBeCloseTo(Math.max(...corners), 3)
    // ...and it still clears the sheared bed mouth (0.6/cos30° ≈ 0.693) that has to transfer through it
    expect(hi - lo).toBeGreaterThan(0.6 / Math.cos(Math.PI / 6))
  })
})

// A straight roller bed that opts in to authored openings by declaring the `guardOpenings` param - the same
// param, rows and meaning the belt uses (measured from the tail), folded into the neighbour-derived map by
// deriveGuardOpenings so render/sim/merge all cut on one set. The roller's guards are rig links, so unlike
// the belt nothing in its geometry() reads the param: the host does.
function authoringRollerPkg(): PartPackage {
  const pkg = sdkRollerPkg() as unknown as { params: Record<string, unknown> }
  pkg.params.guardOpenings = { type: 'numberList', arity: 3, default: [] }
  return pkg as unknown as PartPackage
}
function authoringRoller(id: string, rows: number[][], length = 4): SdkPart {
  return { id, type: 'part', packageId: 'acme.roller', position: [0, 0.75, 0], rotationY: 0, params: { length, width: 0.6, speed: 0.5, guardOpenings: rows } } as unknown as SdkPart
}

describe('authored guard openings (params.guardOpenings)', () => {
  afterEach(() => clearPackages())

  it('shifts a straight bed\'s tail-relative rows into its centre-origin local X', () => {
    registerPackage(authoringRollerPkg())
    // length 4 → bed local X spans ±2, so a row 1.0..1.5 m from the tail lands at −1.0..−0.5
    const op = deriveGuardOpenings(authoringRoller('r', [[1, 1.5, -1]]), [])
    expect(op.left).toEqual([[-1, -0.5]])
    expect(op.right).toEqual([])
  })

  it('side 0 cuts both walls, and rows are clamped to the bed', () => {
    registerPackage(authoringRollerPkg())
    const op = deriveGuardOpenings(authoringRoller('r', [[3, 99, 0]]), [])
    expect(op.left).toEqual([[1, 2]])
    expect(op.right).toEqual([[1, 2]])
  })

  it('merges with a neighbour-derived opening instead of replacing it', () => {
    registerPackage(authoringRollerPkg())
    // authored hole near the tail on +Z, plus a perpendicular roller butting +Z at host-local x=0
    const host = authoringRoller('host', [[0.5, 1, 1]])
    const incoming = sdkRoller('in', 0, 0.3 + 1, Math.PI / 2, 2)
    const op = deriveGuardOpenings(host, [host, incoming])
    expect(op.left).toEqual([])
    expect(op.right).toHaveLength(2)
    expect(op.right[0]).toEqual([-1.5, -1]) // authored, shifted
    expect(op.right[1]![0]).toBeCloseTo(-0.31, 3) // neighbour-derived, unchanged
  })

  it('surfaces through computeSceneOpenings with no neighbour at all', () => {
    registerPackage(authoringRollerPkg())
    const lone = authoringRoller('lone', [[1, 2, 0]])
    expect([...computeSceneOpenings([lone]).keys()]).toEqual(['lone'])
  })

  it('is inert for a part that does not declare the param (rows are junk data)', () => {
    registerPackage(sdkRollerPkg()) // no guardOpenings param
    expect(deriveGuardOpenings(authoringRoller('r', [[1, 2, 0]]), [])).toEqual({ left: [], right: [] })
  })

  it('does not fold on a belt-like host - its geometry() consumes the rows in arc space', () => {
    // double-folding would cut the belt twice, and in the wrong space once the path bends
    // (render/parts/sdk/functionMesh.ts withNeighborOpenings appends the neighbour rows to the same param).
    const pkg = customBeltPkg() as unknown as { params: Record<string, unknown> }
    pkg.params.guardOpenings = { type: 'numberList', arity: 3, default: [] }
    registerPackage(pkg as unknown as PartPackage)
    const host = { ...belt('b', 0, 0), params: { segments: [[4, 0]], width: 0.6, height: 0.5, guardOpenings: [[1, 2, 0]] } } as unknown as SdkPart
    expect(deriveGuardOpenings(host, [])).toEqual({ left: [], right: [] })
  })
})

describe('diverter (guard-mounting pusher) openings', () => {
  beforeEach(() => {
    registerPackage(customBeltPkg())
    registerPackage(diverterPkg())
    registerPackage(sensorPkg())
  })
  afterEach(() => clearPackages())

  it('opens the guard on the side a diverter mounts against, so its arms can cross it', () => {
    // diverter mounted mid-bed (host-local x=2) on the host's +Z guard; body extends +Z (outward).
    const host = belt('host', 0, 0)
    const dv = diverter('dv', 2)
    const op = deriveGuardOpenings(host, [host, dv])
    expect(op.left).toEqual([])
    expect(op.right).toHaveLength(1)
    const [lo, hi] = op.right[0]!
    // opening spans the diverter footprint length 0.73 (± 0.365 + 0.01 margin), centred at host-local x=2
    expect(lo).toBeCloseTo(2 - 0.365 - 0.01, 3)
    expect(hi).toBeCloseTo(2 + 0.365 + 0.01, 3)
  })

  it('surfaces through computeSceneOpenings, keyed by the host conveyor', () => {
    const host = belt('host', 0, 0)
    const dv = diverter('dv', 2)
    expect([...computeSceneOpenings([host, dv]).keys()]).toEqual(['host'])
  })

  it('does not open for an inward-facing sensor mount (its beam cuts the guard separately)', () => {
    const host = belt('host', 0, 0)
    const sen = sensor('sen', 2, 0.3) // seated on the +Z guard, but face 'in' → not a pusher
    const op = deriveGuardOpenings(host, [host, sen])
    expect(op).toEqual({ left: [], right: [] })
    expect([...computeSceneOpenings([host, sen]).keys()]).toEqual([])
  })
})

// A spur is itself a merge and takes end joins only, so no conveyor end opens its guards. A device mounted on its
// guard still does: a diverter's arms cross it like any other bed's.
describe('a spur host', () => {
  beforeEach(() => {
    registerPackage(sdkRollerPkg())
    registerPackage(diverterPkg())
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'test.spurhost',
      name: 'Spur', conveyor: { bed: 'spur', surface: 'roller' },
      params: {
        length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg' } },
        width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
        angleFrontDeg: { type: 'number', default: 30 },
        angleBackDeg: { type: 'number', default: 0 },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'drawn', bounds: { length: 2, width: 0.6, top: 0.5 }, conveys: true },
    } as unknown as PartPackage)
  })
  afterEach(() => clearPackages())
  const spur = (): SdkPart =>
    ({ id: 'spur', type: 'part', packageId: 'test.spurhost', position: [0, 0.75, 0], rotationY: 0, params: { length: 2, width: 0.6, angleFrontDeg: 30, angleBackDeg: 0 } }) as unknown as SdkPart

  it('keeps its guard closed where a conveyor end meets its side', () => {
    // a perpendicular roller whose front end lands mid-side on the spur's +Z edge
    const butt = sdkRoller('butt', 0, 0.3 + 1, Math.PI / 2)
    expect(deriveGuardOpenings(spur(), [spur(), butt])).toEqual({ left: [], right: [] })
    expect(computeSceneOpenings([spur(), butt]).has('spur')).toBe(false)
  })

  it('still opens where a diverter mounts on its guard', () => {
    const op = deriveGuardOpenings(spur(), [spur(), diverter('dv', 0)])
    expect(op.left).toEqual([])
    expect(op.right).toHaveLength(1)
  })
})
