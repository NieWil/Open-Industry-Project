import { describe, expect, it } from 'vitest'
import { ORBIT_SNAP_STEP, ORBIT_SNAP_THRESHOLD, snapOrbitAngles, wrapAngle } from './orbitSnap'

const DEG = Math.PI / 180
const MIN = 0
const MAX = Math.PI / 2 - 0.05 // the view's orbit clamp, just above the horizon

describe('snapOrbitAngles', () => {
  it('snaps to a diagonal stop within the threshold, and it is not an axis view', () => {
    const s = snapOrbitAngles(47 * DEG, 43 * DEG, MIN, MAX)
    expect(s).not.toBeNull()
    expect(s!.theta).toBeCloseTo(ORBIT_SNAP_STEP)
    expect(s!.phi).toBeCloseTo(ORBIT_SNAP_STEP)
    expect(s!.axis).toBe(false)
  })

  it('needs both angles within the threshold', () => {
    expect(snapOrbitAngles(45 * DEG, 30 * DEG, MIN, MAX)).toBeNull()
    expect(snapOrbitAngles(30 * DEG, 45 * DEG, MIN, MAX)).toBeNull()
    expect(snapOrbitAngles(45 * DEG + ORBIT_SNAP_THRESHOLD * 0.99, 45 * DEG, MIN, MAX)).not.toBeNull()
    expect(snapOrbitAngles(45 * DEG + ORBIT_SNAP_THRESHOLD * 1.01, 45 * DEG, MIN, MAX)).toBeNull()
  })

  it('a side view sits at the orbit clamp and is an axis view', () => {
    const s = snapOrbitAngles(92 * DEG, MAX, MIN, MAX)
    expect(s!.theta).toBeCloseTo(Math.PI / 2)
    expect(s!.phi).toBe(MAX)
    expect(s!.axis).toBe(true)
  })

  it('the top view is an axis view with a straight side up, not with a diagonal one', () => {
    expect(snapOrbitAngles(3 * DEG, 4 * DEG, MIN, MAX)!.axis).toBe(true)
    const diagonalUp = snapOrbitAngles(-133 * DEG, 4 * DEG, MIN, MAX)
    expect(diagonalUp!.phi).toBe(0)
    expect(diagonalUp!.axis).toBe(false)
  })

  it('a diagonal side view (45° round, at the horizon) is not an axis view', () => {
    expect(snapOrbitAngles(-45 * DEG, MAX, MIN, MAX)!.axis).toBe(false)
  })

  it('works on an azimuth that has wound past a full turn', () => {
    const s = snapOrbitAngles(2 * Math.PI + 88 * DEG, MAX, MIN, MAX)
    expect(s!.theta).toBeCloseTo(2 * Math.PI + Math.PI / 2)
    expect(s!.axis).toBe(true)
  })
})

describe('wrapAngle', () => {
  it('takes the short way round', () => {
    expect(wrapAngle(350 * DEG)).toBeCloseTo(-10 * DEG)
    expect(wrapAngle(-350 * DEG)).toBeCloseTo(10 * DEG)
    expect(wrapAngle(5 * DEG)).toBeCloseTo(5 * DEG)
  })
})
