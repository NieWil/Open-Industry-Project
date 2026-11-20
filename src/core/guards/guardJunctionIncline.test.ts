import { beforeEach, describe, expect, it } from 'vitest'
import type { SdkPart } from '../types'
import { FRAME_WALL_THICKNESS } from '../types'
import type { PartPackage } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { deriveGuardOpenings } from './guardOpenings'
import { deriveGuardExtents } from './guardExtents'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// Side junctions (guard openings on the host, rail/guard extents on the mover) are found in plan, but an
// inclined straight rig lays its guards along its slope and its consumers read both results as distances along
// it. These pin the two conversions, and the height gate that keeps a conveyor passing over or under another
// from opening its guard.

const W = 0.6
const EDGE = W / 2
const WALL = EDGE + FRAME_WALL_THICKNESS // the host's outer wall plane, where the mover's guards meet it
const Y = 0.75

// a straight SDK roller that can incline: `conveys` rig + length/width face handles + a rig inclineParam
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
    links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.04, W] }, conveys: true }],
    joints: [],
    bounds: { length: 2, width: W, top: 0.9 },
  },
} as unknown as PartPackage

const roller = (id: string, pos: [number, number, number], rot: number, length: number, tiltDeg = 0): SdkPart =>
  ({ id, type: 'part', packageId: 'acme.roller', position: pos, rotationY: rot, params: { length, width: W, tiltDeg } }) as unknown as SdkPart

const DEG = Math.PI / 180

beforeEach(() => {
  clearPackages()
  registerPackage(rollerPkg)
})

/** a flat roller pointing -Z (yaw pi/2) whose front end lands on the host's +Z bed edge at plan x, at height y */
const feeder = (planX: number, y: number, length = 2): SdkPart => roller('f', [planX, y, EDGE + length / 2], Math.PI / 2, length)

describe('guard junctions on an inclined bed', () => {
  it('a tilted host opens its guard at the mouth, measured along its slope', () => {
    const tilt = 20 * DEG
    const host = roller('h', [0, Y, 0], 0, 4, 20)
    const x = 1.2 // plan distance of the mouth from the host centre
    // the feeder has to arrive at the host's surface height there, or the height gate rightly ignores it
    const ops = deriveGuardOpenings(host, [feeder(x, Y + x * Math.tan(tilt))])
    expect(ops.right).toHaveLength(1)
    const [lo, hi] = ops.right[0]!
    // the mouth's corners are where the feeder's guard lines cross the host's wall: x +- (edge + wall) in plan,
    // so along the slope they are those over cos. Measured in plan they would be ~7 cm short at this spot.
    expect(lo).toBeCloseTo((x - WALL) / Math.cos(tilt), 3)
    expect(hi).toBeCloseTo((x + WALL) / Math.cos(tilt), 3)
  })

  it('a flat host is unchanged (the conversion is exactly 1 without an incline)', () => {
    const ops = deriveGuardOpenings(roller('h', [0, Y, 0], 0, 4), [feeder(1.2, Y)])
    expect(ops.right[0]![0]).toBeCloseTo(1.2 - WALL, 3)
    expect(ops.right[0]![1]).toBeCloseTo(1.2 + WALL, 3)
  })

  it('a tilted mover butting a flat host retracts its guards to the wall, measured along its own slope', () => {
    const tilt = 20 * DEG
    const L = 2
    // yaw pi/2 = flow toward -Z; its head (raised (L/2) sin by the centre pivot) lands flush on the host's
    // +Z bed edge in plan, at the host's surface height
    const mover = roller('m', [0, Y - (L / 2) * Math.sin(tilt), EDGE + (L / 2) * Math.cos(tilt)], Math.PI / 2, L, 20)
    const host = roller('h', [0, Y, 0], 0, 4)
    const ext = deriveGuardExtents(mover, [host])
    // the wall plane sits `wall` past the head in plan, so the head retracts by that over cos along the slope
    const want = L / 2 - FRAME_WALL_THICKNESS / Math.cos(tilt)
    expect(ext.leftFront).toBeCloseTo(want, 4)
    expect(ext.rightFront).toBeCloseTo(want, 4)
    // and the host opens for it: the height gate must see the raised head, not the deck-height ends
    // conveyorEndsOf reports for an inclined bed
    expect(deriveGuardOpenings(host, [mover]).right).toHaveLength(1)
  })
})

describe('guard junctions need the two surfaces at one height', () => {
  it('a conveyor ending over (or under) another does not open its guard or retract to it', () => {
    const host = roller('h', [0, Y, 0], 0, 4)
    for (const dy of [1.5, -1.5]) {
      const f = feeder(0.5, Y + dy)
      expect(deriveGuardOpenings(host, [f])).toEqual({ left: [], right: [] })
      expect(deriveGuardExtents(f, [host])).toEqual({})
    }
  })

  it('a small step (within a guard height) still makes the junction', () => {
    const host = roller('h', [0, Y, 0], 0, 4)
    const f = feeder(0.5, Y + 0.1)
    expect(deriveGuardOpenings(host, [f]).right).toHaveLength(1)
    expect(deriveGuardExtents(f, [host]).leftFront).toBeDefined()
  })
})
