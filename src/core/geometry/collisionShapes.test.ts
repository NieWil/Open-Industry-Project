import { describe, expect, it } from 'vitest'
import type { CollisionShape } from './collisionShapes'
import { runningSurfaceNormal } from './collisionShapes'

/** a facet at the given pose; only the rotation matters to the normal */
function facet(qx: number, qy: number, qz: number, qw: number): CollisionShape {
  return { box: { hx: 1, hy: 0.01, hz: 0.5 }, lx: 3, ly: 2, lz: 1, qx, qy, qz, qw }
}

/** quaternion for a rotation of `rad` about the given unit axis */
function axisAngle(ax: number, ay: number, az: number, rad: number): [number, number, number, number] {
  const s = Math.sin(rad / 2)
  return [ax * s, ay * s, az * s, Math.cos(rad / 2)]
}

describe('runningSurfaceNormal', () => {
  it('is world up for an unrotated facet, wherever it sits', () => {
    const n = runningSurfaceNormal(facet(0, 0, 0, 1))
    expect(n.x).toBeCloseTo(0, 12)
    expect(n.y).toBeCloseTo(1, 12)
    expect(n.z).toBeCloseTo(0, 12)
  })

  it('tilts with an inclined run, by exactly the roll applied', () => {
    // An inclined belt run is rolled about +Z, so its surface leans by the same angle: this is the
    // value the sim hands the contact listener, and the gate it feeds is only 45 degrees wide, so a
    // normal left at world up would stop a steep run conveying its own deck.
    const deg = 12
    const [qx, qy, qz, qw] = axisAngle(0, 0, 1, (deg * Math.PI) / 180)
    const n = runningSurfaceNormal(facet(qx, qy, qz, qw))
    expect((Math.acos(n.y) * 180) / Math.PI).toBeCloseTo(deg, 10)
    expect(n.x).toBeCloseTo(-Math.sin((deg * Math.PI) / 180), 10)
    expect(n.z).toBeCloseTo(0, 12)
  })

  it('yaw alone leaves it up, since yaw cannot tilt a running surface', () => {
    const [qx, qy, qz, qw] = axisAngle(0, 1, 0, 0.9)
    const n = runningSurfaceNormal(facet(qx, qy, qz, qw))
    expect(n.y).toBeCloseTo(1, 12)
  })

  it('follows a facet rolled onto its side', () => {
    // Not a shape any conveyor family authors today, but the listener rotates this into world space
    // per contact, so it has to stay a faithful unit normal at any pose rather than a fudged up.
    const [qx, qy, qz, qw] = axisAngle(0, 0, 1, Math.PI / 2)
    const n = runningSurfaceNormal(facet(qx, qy, qz, qw))
    expect(n.x).toBeCloseTo(-1, 12)
    expect(n.y).toBeCloseTo(0, 12)
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12)
  })
})
