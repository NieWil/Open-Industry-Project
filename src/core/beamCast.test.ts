import { describe, expect, it } from 'vitest'
import { castBeamFrame, castsCrossRows, changedCargoRows, rayAabb, rayCapsuleY, rayObb } from './beamCast'
import type { BoxFrame } from './frame'
import { qFromAxisAngle } from './rig/rigPose'
import type { Quat } from './rig/rigPose'

describe('beamCast - ray vs box (C-sensing)', () => {
  it('rayAabb returns the entry distance for a hit and null for a miss', () => {
    // ray from -2 along +X at a 1×1×1 (half 0.5) box at origin → enters at x=-0.5, distance 1.5
    expect(rayAabb([-2, 0, 0], [1, 0, 0], [0.5, 0.5, 0.5])).toBeCloseTo(1.5, 9)
    expect(rayAabb([-2, 2, 0], [1, 0, 0], [0.5, 0.5, 0.5])).toBeNull() // passes above the box
    expect(rayAabb([2, 0, 0], [1, 0, 0], [0.5, 0.5, 0.5])).toBeNull() // box behind the origin
  })

  it('rayAabb returns 0 when the origin is inside the box', () => {
    expect(rayAabb([0, 0, 0], [1, 0, 0], [0.5, 0.5, 0.5])).toBe(0)
  })

  it('rayObb accounts for the box position + orientation', () => {
    // a box at (3,0,0), unrotated: ray from origin along +X enters at x=2.5 → distance 2.5
    const I: Quat = [0, 0, 0, 1]
    expect(rayObb([0, 0, 0], [1, 0, 0], [3, 0, 0], I, [0.5, 0.5, 0.5])).toBeCloseTo(2.5, 9)
    // rotate the box 45° about Y: a corner now faces the ray, reaching √2·0.5 along X, so it's hit sooner
    const r45 = qFromAxisAngle([0, 1, 0], Math.PI / 4)
    const d = rayObb([0, 0, 0], [1, 0, 0], [3, 0, 0], r45, [0.5, 0.5, 0.5])
    expect(d).not.toBeNull()
    expect(d!).toBeCloseTo(3 - Math.SQRT2 * 0.5, 6)
  })

  it('rayObb misses a box the ray is aimed away from', () => {
    expect(rayObb([0, 0, 0], [0, 0, 1], [3, 0, 0], [0, 0, 0, 1], [0.5, 0.5, 0.5])).toBeNull()
  })
})

// a minimal BoxFrame with cargo boxes at the given poses (identity quats unless given)
function frameOf(boxes: { pos: [number, number, number]; half: [number, number, number]; quat?: Quat }[]): BoxFrame {
  const count = boxes.length
  const positions = new Float32Array(count * 3)
  const quats = new Float32Array(count * 4)
  const halfExtents = new Float32Array(count * 3)
  boxes.forEach((b, i) => {
    positions.set(b.pos, i * 3)
    quats.set(b.quat ?? [0, 0, 0, 1], i * 4)
    halfExtents.set(b.half, i * 3)
  })
  return {
    count,
    ids: new Uint32Array(count),
    positions,
    quats,
    halfExtents,
    colors: new Float32Array(count * 3),
    kinds: new Uint8Array(count),
    partIds: new Array<string | null>(count).fill(null),
    simTime: 0,
  }
}

describe('castBeamFrame - beam vs a BoxFrame (stopped-editor twin of the sim castBeam)', () => {
  it('returns the nearest box index + entry distance', () => {
    const f = frameOf([
      { pos: [5, 0, 0], half: [0.5, 0.5, 0.5] },
      { pos: [2, 0, 0], half: [0.5, 0.5, 0.5] }, // nearer
    ])
    const hit = castBeamFrame([0, 0, 0], [1, 0, 0], 10, f)
    expect(hit).not.toBeNull()
    expect(hit!.index).toBe(1)
    expect(hit!.distance).toBeCloseTo(1.5, 6)
  })

  it('ignores boxes beyond the beam range and off the ray', () => {
    const f = frameOf([
      { pos: [5, 0, 0], half: [0.5, 0.5, 0.5] }, // beyond range 3
      { pos: [2, 3, 0], half: [0.5, 0.5, 0.5] }, // above the ray
    ])
    expect(castBeamFrame([0, 0, 0], [1, 0, 0], 3, f)).toBeNull()
  })

  it('respects box orientation (yawed box face reaches the ray sooner)', () => {
    const f = frameOf([{ pos: [3, 0, 0], half: [0.5, 0.5, 0.5], quat: qFromAxisAngle([0, 1, 0], Math.PI / 4) }])
    const hit = castBeamFrame([0, 0, 0], [1, 0, 0], 10, f)
    expect(hit).not.toBeNull()
    expect(hit!.distance).toBeCloseTo(3 - Math.SQRT2 * 0.5, 6)
  })

  it('returns null on an empty frame', () => {
    expect(castBeamFrame([0, 0, 0], [1, 0, 0], 10, frameOf([]))).toBeNull()
  })
})

describe('changedCargoRows - what a cargo edit can change for a beam', () => {
  const half: [number, number, number] = [0.5, 0.5, 0.5]

  it('lists only the rows whose pose, size or tint moved', () => {
    const a = frameOf([{ pos: [0, 0, 0], half }, { pos: [2, 0, 0], half }, { pos: [4, 0, 0], half }, { pos: [6, 0, 0], half }])
    const b = frameOf([{ pos: [0, 0, 0], half }, { pos: [2.1, 0, 0], half }, { pos: [4, 0, 0], half: [0.5, 0.6, 0.5] }, { pos: [6, 0, 0], half }])
    b.colors[9] = 1 // row 3's tint
    expect(changedCargoRows(a, b)).toEqual([1, 2, 3])
    expect(changedCargoRows(a, a)).toEqual([])
  })

  it('has no row-for-row answer when the row count changed', () => {
    expect(changedCargoRows(frameOf([{ pos: [0, 0, 0], half }]), frameOf([]))).toBeNull()
  })
})

describe('castsCrossRows - does a recorded beam enter a given row', () => {
  const f = frameOf([
    { pos: [2, 0, 0], half: [0.5, 0.5, 0.5] }, // on the first cast's ray
    { pos: [0, 5, 0], half: [0.5, 0.5, 0.5] }, // on the second cast's ray, beyond its range
    { pos: [0, 0, 9], half: [0.5, 0.5, 0.5] }, // on no ray
  ])
  // origin xyz, dir xyz, range: one cast along +X (range 10), one along +Y (range 3)
  const casts = [0, 0, 0, 1, 0, 0, 10, 0, 0, 0, 0, 1, 0, 3]

  it('is true for a row on a cast within its range', () => {
    expect(castsCrossRows(casts, f, [0])).toBe(true)
  })

  it('is false for rows off every cast or beyond its range, and for no rows or no casts', () => {
    expect(castsCrossRows(casts, f, [1, 2])).toBe(false)
    expect(castsCrossRows(casts, f, [])).toBe(false)
    expect(castsCrossRows([], f, [0, 1, 2])).toBe(false)
  })
})

describe('rayCapsuleY - a beam vs the pilot body', () => {
  // capsule centred at (3, 1, 0): straight section y 0.5..1.5, radius 0.3
  const hit = (o: [number, number, number], d: [number, number, number]) => rayCapsuleY(o, d, 3, 1, 0, 0.5, 0.3)

  it('enters the side of the straight section', () => {
    expect(hit([0, 1, 0], [1, 0, 0])).toBeCloseTo(2.7, 9)
  })

  it('enters an end sphere above and below the straight section', () => {
    expect(hit([0, 1.6, 0], [1, 0, 0])).toBeCloseTo(3 - Math.sqrt(0.09 - 0.01), 9)
    expect(hit([3, -2, 0], [0, 1, 0])).toBeCloseTo(2.2, 9) // straight up into the bottom cap
  })

  it('misses beside and above, and when the capsule is behind the emitter', () => {
    expect(hit([0, 1, 0.31], [1, 0, 0])).toBeNull()
    expect(hit([0, 1.81, 0], [1, 0, 0])).toBeNull()
    expect(hit([4, 1, 0], [1, 0, 0])).toBeNull()
  })

  it('returns 0 from inside', () => {
    expect(hit([3.1, 1.7, 0], [1, 0, 0])).toBe(0)
  })
})
