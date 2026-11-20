import { conveyorSpeedOf } from './conveyorDirection'
import { bedOf } from './conveyorBeds'
import { toLocalXZ } from '../transforms'
import type { PartInstance } from '../types'

export interface SurfaceVelocity {
  vx: number
  vz: number
}

/**
 * Horizontal (world XZ) surface velocity a conveyor imparts at the world point
 * (x, z), or null if the part is not a conveyor or is stopped. This mirrors the
 * surface velocities baked into the sim bodies in sim/world.ts, so a body the
 * pilot stands on is carried exactly like cargo resting on the same surface.
 *
 * The sim is the source of truth for *cargo*; replicating it here is what lets
 * the raycast-based pilot (render/pilot.ts) ride a conveyor the way a character
 * controller rides a static body with a constant surface velocity.
 *
 * Each bed kind mirrors the field its behavior drives in the sim (setSurfaceVelocity /
 * setArcSurfaceVelocity); conveyorBeds.ts has the per-kind field:
 *   - STRAIGHT, SPUR and BELT (`path`): a constant forward carry along the part's +X × `speed`.
 *   - CURVED (`arc`): rigid rotation about the arc centre (the part origin),
 *     omega = speed / centreline-radius - the position-dependent tangent field
 *     v = omega × (p − centre), so the pilot is carried around the sweep.
 *   - ROTATING DECK (turntable): the settled carry along the deck's resting angle. The transient
 *     slew field isn't mirrored (the pilot rarely stands on a mid-slew platter).
 *
 * As with the sim mirror, this reads the `speed` param directly and ignores comms /
 * interlock gating - a placed-and-running approximation, same fidelity as cargo at rest.
 */
export function conveyorSurfaceVelocity(part: PartInstance, x: number, z: number): SurfaceVelocity | null {
  if (part.type !== 'part') return null
  // `speed` is the reserved conveyor param name (see PartContext.setSurfaceVelocity): the one param
  // convention this static mirror shares with the render scroll/spin and the sim's interlock seed. Folded
  // with the snap-owned `reverse` flag, so the pilot walks a snapped-reversed curve the right way.
  const bed = bedOf(part)
  if (!bed) return null
  const speed = conveyorSpeedOf(part)
  if (speed === 0) return null
  return bed.surfaceVelocity(part, speed, x, z)
}

/** the true conveying-surface plane at a world XZ: its height and outward (upward) normal */
export interface ConveyingSurface {
  y: number
  normal: [number, number, number]
}

/**
 * The exact conveying-surface plane of a conveyor part at the world point (x, z), or null when the part
 * isn't a conveyor or the point isn't over its bed. This is the plane cargo rests on when the sim runs,
 * unlike the viewport's pick/rest proxies, whose footprint boxes carry a selection pad above the rollers
 * (partFootprint's +0.05 y1). The editor's Alt face snap uses this to seat a part exactly on the rollers
 * so it doesn't drop when the sim starts.
 *
 * Mirrored per bed kind (conveyorBeds.ts):
 *   - STRAIGHT and SPUR: flat bed at the origin height, tilted about the centre origin by the rig
 *     `inclineParam` - height rises with local X, the normal leans back by the tilt.
 *   - BELT (`path`): the segment profile - height and slope from the belt path at the local X.
 *   - CURVED (`arc`) and ROTATING DECK (turntable): flat at the origin height over the annulus / platter.
 */
export function conveyingSurfaceAt(part: PartInstance, x: number, z: number): ConveyingSurface | null {
  const bed = bedOf(part)
  if (!bed) return null
  const local = toLocalXZ(part, x, z)
  return bed.surfaceAt(part, local.x, local.z)
}
