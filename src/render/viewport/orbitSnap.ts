// Orbit snapping: with Alt held through an orbit, the camera shows the nearest 45° view while the orbit is within
// ORBIT_SNAP_THRESHOLD of it on both angles. The straight views (top, and the four sides) are axis views, which turn
// the projection orthographic the way an orbit-gizmo axis click does. viewCamera.applyOrbitSnap drives it.

/** the angle between snap stops: the straight views and the diagonals between them */
export const ORBIT_SNAP_STEP = Math.PI / 4
/** how close (radians, on each angle) the orbit has to come to a stop before it snaps there: 10° */
export const ORBIT_SNAP_THRESHOLD = (10 * Math.PI) / 180

export interface OrbitSnapStop {
  theta: number
  phi: number
  /** a straight view: top (any side up) or one of the four sides */
  axis: boolean
}

/**
 * The stop the orbit (theta = azimuth about +Y, phi = polar angle from +Y) snaps to, or null when it is not within the
 * threshold of one on both angles. phi lands inside [minPhi, maxPhi], the orbit's own clamp: the side views sit at the
 * clamp just above the horizon, which is where an axis click leaves them too.
 */
export function snapOrbitAngles(theta: number, phi: number, minPhi: number, maxPhi: number): OrbitSnapStop | null {
  const ti = Math.round(theta / ORBIT_SNAP_STEP)
  const pi = Math.round(phi / ORBIT_SNAP_STEP)
  if (Math.abs(theta - ti * ORBIT_SNAP_STEP) >= ORBIT_SNAP_THRESHOLD) return null
  if (Math.abs(phi - pi * ORBIT_SNAP_STEP) >= ORBIT_SNAP_THRESHOLD) return null
  const straightSide = ti % 2 === 0
  return {
    theta: ti * ORBIT_SNAP_STEP,
    phi: Math.min(Math.max(pi * ORBIT_SNAP_STEP, minPhi), maxPhi),
    axis: straightSide && (pi === 0 || pi === 2),
  }
}

/** `a` folded into (-PI, PI]: the short way round between two azimuths */
export function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}
