import { beforeEach, describe, expect, it } from 'vitest'
import type { SdkPart } from './types'
import { FRAME_WALL_THICKNESS } from './types'
import type { PartPackage } from './parts/partPackage'
import { clearPackages, registerPackage } from './parts/partRegistry'
import { conveyorEndsOf } from './parts/partGeometry'
import { findSnap } from './snap/snapFeatures'
import { resolveRollerGrids } from './conveyor/rollerGrid'
import { deriveGuardOpenings } from './guards/guardOpenings'
import { PACKAGE_FORMAT } from './parts/partPackage'

// Snapping across an inclined junction (docs/conveyor-incline.md). A tilted straight pivots about its bed
// centre, so its head sits (L/2)·cos out in plan and (L/2)·sin up, its tail the same down. Ends reported as if
// flat (±L/2 at deck height) would put a neighbour snapped onto the head a few cm too far out and a third of a
// metre too low. These pin the ends, the end-mate onto them in both directions, a nose-over chain, and two rules:
// nothing side-merges onto an incline's sloping flank, and a change of grade doesn't share one roller pitch line.

const W = 0.6
const Y = 1
const DEG = Math.PI / 180

const rollerPkg = {
  format: PACKAGE_FORMAT,
  id: 'acme.roller',
  name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller' },
  params: {
    length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x' } },
    width: { type: 'number', default: W, handle: { kind: 'face', axis: 'z' } },
    tiltDeg: { type: 'number', default: 0 },
  },
  behavior: 'definePart({ step(){} })',
  geometry: {
    kind: 'rig',
    inclineParam: 'tiltDeg',
    links: [
      { name: 'deck', shape: { kind: 'box', size: [2, 0.04, W] }, conveys: true },
      // a world-phase roller bank, so the part is a roller-grid bed (isWorldPhaseRollerBed)
      { name: 'rollerGrid', shape: { kind: 'frame' }, offset: [0, -0.024, 0], array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: 0.075, worldPhase: true } } },
    ],
    joints: [],
    bounds: { length: 2, width: W, top: 0.9 },
  },
} as unknown as PartPackage

const roller = (id: string, pos: [number, number, number], length: number, tiltDeg = 0, rot = 0): SdkPart =>
  ({ id, type: 'part', packageId: 'acme.roller', position: pos, rotationY: rot, params: { length, width: W, tiltDeg } }) as unknown as SdkPart

const endOf = (p: SdkPart, which: 'front' | 'back') => conveyorEndsOf(p).find((e) => e.end === which)!
const snapped = (moving: SdkPart, others: SdkPart[]): SdkPart => {
  const c = findSnap(moving, { position: moving.position, rotationY: moving.rotationY }, others)
  if (!c) throw new Error('no snap')
  return { ...moving, position: c.pose.position, rotationY: c.pose.rotationY }
}
const expectAt = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): void => {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.y).toBeCloseTo(b.y, 6)
  expect(a.z).toBeCloseTo(b.z, 6)
}

beforeEach(() => {
  clearPackages()
  registerPackage(rollerPkg)
})

describe('an inclined straight reports its ends where they are', () => {
  it('head (L/2)cos out and (L/2)sin up, tail the same down', () => {
    const t = 15 * DEG
    const p = roller('p', [0, Y, 0], 3, 15)
    expectAt(endOf(p, 'front'), { x: 1.5 * Math.cos(t), y: Y + 1.5 * Math.sin(t), z: 0 })
    expectAt(endOf(p, 'back'), { x: -1.5 * Math.cos(t), y: Y - 1.5 * Math.sin(t), z: 0 })
  })
})

describe('end-mates across a change of grade', () => {
  it('a flat run dropped by an incline head seats on it: same point, same height', () => {
    const incline = roller('i', [0, Y, 0], 3, 15)
    const flat = snapped(roller('f', [2.6, Y + 0.3, 0], 2), [incline])
    expectAt(endOf(flat, 'back'), endOf(incline, 'front'))
    // ...and, seated there, it does not overlap the incline: the incline's footprint ends where its head does
    // ((L/2)·cos in plan). A footprint of L/2 would overhang the head, so a correctly butted neighbour would read as
    // overlapping, which puts its snap in the distance-blind priority tier ahead of genuinely closer targets.
    const again = findSnap(flat, { position: flat.position, rotationY: flat.rotationY }, [incline])
    expect(again?.override ?? false).toBe(false)
  })

  it('a flat run dropped by an incline tail seats on it', () => {
    const incline = roller('i', [0, Y, 0], 3, 15)
    const flat = snapped(roller('f', [-2.6, Y - 0.3, 0], 2), [incline])
    expectAt(endOf(flat, 'front'), endOf(incline, 'back'))
  })

  it('an incline dropped by a flat run seats its tail on the run\'s discharge end', () => {
    const flat = roller('f', [0, Y, 0], 2)
    const incline = snapped(roller('i', [2.5, Y + 0.4, 0], 3, 15), [flat])
    expectAt(endOf(incline, 'back'), endOf(flat, 'front'))
  })

  it('a nose-over chain (flat, incline, flat) lifts the last run by exactly the incline\'s rise', () => {
    const a = roller('a', [0, Y, 0], 2)
    const incline = snapped(roller('i', [2.5, Y + 0.4, 0], 3, 15), [a])
    const b = snapped(roller('b', [incline.position[0] + 2.5, Y + 0.8, 0], 2), [incline])
    expect(b.position[1] - a.position[1]).toBeCloseTo(3 * Math.sin(15 * DEG), 6)
    expectAt(endOf(b, 'back'), endOf(incline, 'front'))
  })
})

describe('side merges and an incline', () => {
  it('nothing side-merges onto an inclined bed: its flank climbs, so it takes end-mates only', () => {
    const incline = roller('i', [0, Y, 0], 4, 15)
    // perpendicular, approaching the +Z flank beside the middle of the bed: on a flat bed this side-merges
    const probe = roller('p', [0.3, Y, 1.4], 2, 0, Math.PI / 2)
    const flatHost = roller('h', [0, Y, 0], 4)
    const onFlat = snapped(probe, [flatHost])
    // control: the flat bed takes it on its flank (a square T seats its end on the host frame's outer wall face)
    expect(endOf(onFlat, 'front').z).toBeCloseTo(W / 2 + FRAME_WALL_THICKNESS, 6)
    const c = findSnap(probe, { position: probe.position, rotationY: probe.rotationY }, [incline])
    // from mid-flank that means no snap at all (the incline's ends are out of reach); a snap, if any, is to an end
    if (c) {
      const seated = { ...probe, position: c.pose.position, rotationY: c.pose.rotationY }
      const ends = conveyorEndsOf(seated)
      const onEnd = ends.some((e) => [endOf(incline, 'front'), endOf(incline, 'back')].some((t) => Math.hypot(e.x - t.x, e.y - t.y, e.z - t.z) < 1e-6))
      expect(onEnd).toBe(true)
    }
  })

  it('an incline still side-merges onto a flat bed, its raised head seated on the bed at its edge', () => {
    const host = roller('h', [0, Y, 0], 4)
    // flowing -Z (yaw pi/2), tilted down toward the host: the head (front) is the low end here
    const incline = snapped(roller('i', [0.3, Y + 0.5, 1.9], 3, -15, Math.PI / 2), [host])
    const head = endOf(incline, 'front')
    expect(head.z).toBeCloseTo(W / 2 + FRAME_WALL_THICKNESS, 6) // on the host frame's outer wall face
    expect(head.y).toBeCloseTo(Y, 6)
  })
})

describe('the roller grid across a change of grade', () => {
  it('two flat runs butted in line share one pitch (no edge nudge at the seam); flat onto an incline does not', () => {
    const a = roller('a', [0, Y, 0], 2)
    const flat = snapped(roller('f', [2.1, Y, 0], 2), [a])
    const gFlat = resolveRollerGrids([a, flat])
    expect(gFlat.get('a')!.nudgeHi).toBe(false) // control: a collinear butt suppresses the seam nudge

    const incline = snapped(roller('i', [2.5, Y + 0.4, 0], 3, 15), [a])
    const gBend = resolveRollerGrids([a, incline])
    expect(gBend.get('a')!.nudgeHi).toBe(true) // the grade changes at the seam: each bank keeps its own edge
    expect(gBend.get('i')!.nudgeLo).toBe(true)
  })
})

// Devices that mount on a conveyor's side guard (a photo-eye, a pop-up diverter) seat on the guard at the
// point along it nearest the drop. On an inclined bed that guard climbs, so the seat must too: a seat at the
// bed's centre height is 39 cm off at the end of a 3 m bed at 15 degrees.
describe('guard-mounted devices on an inclined bed', () => {
  const sensorPkg = {
    format: PACKAGE_FORMAT,
    id: 'acme.sensor',
    name: 'Acme Sensor',
    params: { range: { type: 'number', default: 1 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.1, width: 0.1, top: 0.1 } },
    snap: { mounts: [{ at: [0, 0, 0.05], accepts: 'conveyorGuard', face: 'in', fitRangeParam: 'range' }] },
  } as unknown as PartPackage
  const diverterPkg = {
    format: PACKAGE_FORMAT,
    id: 'acme.diverter',
    name: 'Acme Diverter',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.73, width: 2.36, top: 0.82 } },
    snap: { mounts: [{ at: [0, 0, -1.0635], accepts: 'conveyorGuard', face: 'out', yOffset: 0.2, outwardOffset: 0.05, opens: true }] },
  } as unknown as PartPackage
  const bladePkg = {
    format: PACKAGE_FORMAT,
    id: 'acme.blade',
    name: 'Acme Blade Stop',
    params: { width: { type: 'number', default: 0.6, min: 0.1, max: 2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 0.2, width: 2, top: 0.5 } },
    snap: { track: { fitWidthParam: 'width' } },
  } as unknown as PartPackage
  const device = (id: string, pkg: string, pos: [number, number, number]): SdkPart =>
    ({ id, type: 'part', packageId: pkg, position: pos, rotationY: 0, params: {} }) as unknown as SdkPart
  const snapOf = (moving: SdkPart, host: SdkPart) => findSnap(moving, { position: moving.position, rotationY: moving.rotationY }, [host])
  const t = 15 * DEG

  beforeEach(() => {
    registerPackage(sensorPkg)
    registerPackage(diverterPkg)
    registerPackage(bladePkg)
  })

  it("a sensor seats on the sloping guard at its height there, not the bed centre's", () => {
    const host = roller('h', [0, Y, 0], 4, 15)
    const c = snapOf(device('s', 'acme.sensor', [1.2, Y + 0.3, 0.4]), host)!
    expect(c).not.toBeNull()
    expect(c.junction.x).toBeCloseTo(1.2, 6)
    expect(c.junction.y).toBeCloseTo(Y + 1.2 * Math.tan(t), 6)
    expect(c.pose.position[1]).toBeCloseTo(Y + 1.2 * Math.tan(t), 6)
    // the same drop on a flat bed seats at the bed height (control)
    expect(snapOf(device('s', 'acme.sensor', [1.2, Y + 0.3, 0.4]), roller('h', [0, Y, 0], 4))!.pose.position[1]).toBeCloseTo(Y, 6)
  })

  it("...and slides only as far as the guard really reaches in plan ((L/2)cos), seated at the head's height", () => {
    const host = roller('h', [0, Y, 0], 4, 15)
    const c = snapOf(device('s', 'acme.sensor', [1.99, Y + 0.5, 0.4]), host)!
    expect(c.junction.x).toBeCloseTo(2 * Math.cos(t), 6)
    expect(c.junction.y).toBeCloseTo(endOf(host, 'front').y, 6)
  })

  it("a diverter seated on the sloping guard still opens it (the opening's height check agrees with the seat)", () => {
    const host = roller('h', [0, Y, 0], 4, 15)
    const c = snapOf(device('d', 'acme.diverter', [1, Y + 0.2, 1.4]), host)!
    expect(c).not.toBeNull()
    const seated = { ...device('d', 'acme.diverter', [0, 0, 0]), position: c.pose.position, rotationY: c.pose.rotationY }
    expect(deriveGuardOpenings(host, [seated]).right).toHaveLength(1)
  })

  it('a blade stop (a track device) is not fitted to an incline, only to a level bed', () => {
    const blade = device('b', 'acme.blade', [0.4, Y, 0.02])
    expect(snapOf(blade, roller('h', [0, Y, 0], 4))).not.toBeNull() // control
    expect(snapOf(blade, roller('h', [0, Y, 0], 4, 15))).toBeNull()
  })
})
