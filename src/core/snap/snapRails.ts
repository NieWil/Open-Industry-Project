// Rail snapping for findSnap (snapFeatures.ts): a device (a sensor, a diverter, any mount) seated on a
// conveyor's guards or a declared surface.

import { SNAP_CONVEYOR_VISIBLE_THRESHOLD, SNAP_FACING_PRESERVED_DOT } from '../types'
import type { PartInstance } from '../types'
import { forwardXZ, normalizeAngle } from '../math'
import { rotateXZ as rotXZ } from '../transforms'
import type { SnapMount, SnapSurface } from '../parts/partApi'
import { bedView, isTailOriginConveyor, rectangleBedOf, resolveInclineRad, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { beltHorizontalExtent, beltXToS, buildBeltPath, sampleBeltPath } from '../conveyor/beltPath'
import { bodyOverlapsXZ, closestOnSegXZ, numParamOf, posedClone, snapOf } from './snapShared'
import type { SnapCandidate, SnapPose } from './snapFeatures'

// --- devices (sensors / diverter / any mount) onto rails: a conveyor's guards, a declared surface ---

/** A mount's declaration in the working shape {@link seatOnRail} reads (defaults applied). */
interface DeviceMount {
  /** device-local point that sits on the guard contact */
  localPos: { x: number; y: number; z: number }
  /** device local +Z faces inward (toward belt, sensors) vs outward (away, diverter) */
  faceInward: boolean
  /** Y offset: origin drops by this below the contact (sensor lift is negative) */
  yOffset: number
  /** push out from the guard along its outward normal */
  outwardOffset: number
  /** sensor: fit the range param so the beam spans the belt and reaches the far guard */
  autoFitRange: boolean
  /** which `number` param the auto-fit range writes (the mount's `fitRangeParam`; set whenever autoFitRange is) */
  fitRangeParam?: string
  /** the surface kind this device mounts on (the mount's `accepts`; a built-in device = `'conveyorGuard'`) */
  accepts: string
  /** committing the mount also soft-parents the device under its host (the mount's `attach`) */
  attach: boolean
}

/** Read one declared mount into the engine's working shape. The caller picks which mount (evalAgainst tries
 *  them all); this is a pure translation of the declaration - `at` is the local contact point, `face` whether
 *  local +Z aims at the host, `accepts` the surface kind it seeks (matched in railSocketsOf). */
function deviceMount(m: SnapMount): DeviceMount {
  return {
    localPos: { x: m.at[0], y: m.at[1], z: m.at[2] },
    faceInward: m.face !== 'out',
    yOffset: m.yOffset ?? 0,
    outwardOffset: m.outwardOffset ?? 0,
    autoFitRange: typeof m.fitRangeParam === 'string',
    fitRangeParam: m.fitRangeParam,
    accepts: m.accepts,
    attach: m.attach === true,
  }
}

/** the running surface's height above a host's origin at a plan local X (a device seats on its guard there) */
type SurfaceYAt = (localX: number) => number

/**
 * A straight conveyor a device can mount onto: its bed's plan length + width, and, where the bed does not lie
 * flat, the surface height along it, so a device seats at the guard's local elevation. A belt reads that off its
 * path (tilted segments); an inclined straight (tiltDeg) is one plane pivoted about its centre, so its guard
 * runs (L/2)·cos out in plan and climbs x·tan along it (docs/conveyor-incline.md). Covers the built-in
 * roller/belt and a belt-like or straight custom/SDK conveyor, so an SDK sensor mounts on any of them (and a
 * device mounts on an SDK conveyor). Returns null for a non-conveyor target - the `'conveyorGuard'` surface a
 * mount accepts. */
function straightGuardHost(target: PartInstance): { bedLen: number; width: number; surfaceYAt: SurfaceYAt | null } | null {
  const bl = bedView(target, 'path')
  if (bl) {
    const path = buildBeltPath(bl.segments, bl.height)
    return { bedLen: Math.max(beltHorizontalExtent(bl.segments), 1e-3), width: bl.width, surfaceYAt: (x) => sampleBeltPath(path, beltXToS(path, x)).y }
  }
  const sv = rectangleBedOf(target)
  if (sv) {
    const th = resolveInclineRad(target)
    if (th === 0) return { bedLen: sv.length, width: sv.width, surfaceYAt: null }
    const tan = Math.tan(th)
    return { bedLen: sv.length * Math.cos(th), width: sv.width, surfaceYAt: (x) => x * tan }
  }
  return null
}

/**
 * One rail a device seats on, resolved in world space for a given approach: its plan segment a..b, the outward
 * side (unit, away from the host), and its world height at a contact on it.
 */
interface RailSeat {
  a: { x: number; z: number }
  b: { x: number; z: number }
  outward: { x: number; z: number }
  yAt: (contact: { x: number; z: number }) => number
}

/**
 * A rail socket on a host: `seat` picks the rail an approach at (px, pz) seats on. Every socket is a pair (a
 * conveyor's guards, a declared surface): two rails, and an approach takes the nearer side. `span` is the pair's
 * width, which a mount's `fitRangeParam` spans.
 */
interface RailSocket {
  label: string
  seat: (px: number, pz: number) => RailSeat
  span: number
}

/**
 * Every rail socket of a kind a target offers, for a mount that `accepts` it:
 *
 * - `'conveyorGuard'` on a conveyor: its guard pair, inferred from the bed (straightGuardHost) in that bed's own
 *   origin convention (isTailOriginConveyor): belt-like runs x 0..length from
 *   its tail, other straights are centre-origin. Assuming the tail form would shift the mountable band half a
 *   bed forward on every centre-origin host.
 * - each declared surface of that kind (definePart({ snap: { surfaces } })): a pair at z = ±width/2, centre-
 *   origin (x −L/2..+L/2, matching a custom part's centred footprint), flat, at the origin's height.
 *
 * Empty when the target offers nothing of that kind, which makes `accepts` a live dispatch key: a device seeking
 * an unknown kind snaps to nothing, even over a conveyor.
 */
export function railSocketsOf(target: PartInstance, kind: string): RailSocket[] {
  const out: RailSocket[] = []
  if (kind === 'conveyorGuard') {
    const conv = straightGuardHost(target)
    if (conv) {
      const tail = isTailOriginConveyor(target)
      out.push(railPair(target, 'conveyorGuard', tail ? 0 : -conv.bedLen / 2, tail ? conv.bedLen : conv.bedLen / 2, conv.width, conv.surfaceYAt))
    }
  }
  const snap = snapOf(target)
  snap?.surfaces?.forEach((surface: SnapSurface, i) => {
    if (surface.kind !== kind) return
    const len = numParamOf(target, surface.lengthParam)
    const width = numParamOf(target, surface.widthParam)
    if (len !== null && width !== null && len > 0 && width > 0) out.push(railPair(target, `surfaces[${i}]`, -len / 2, len / 2, width, null))
  })
  return out
}

/** the two side rails of a host bed, local x0..x1 at z = ±width/2; an approach takes the nearer side, judged at
 *  the rails' midpoints (their x is shared, so this compares lateral distance only) */
function railPair(target: PartInstance, label: string, x0: number, x1: number, width: number, surfaceYAt: SurfaceYAt | null): RailSocket {
  const xm = (x0 + x1) / 2
  const hw = width / 2
  const ty = target.position[1]
  return {
    label,
    span: width,
    seat: (px, pz) => {
      const lc = toWorldXZ(target, xm, -hw)
      const rc = toWorldXZ(target, xm, hw)
      const left = Math.hypot(px - lc.x, pz - lc.z) <= Math.hypot(px - rc.x, pz - rc.z)
      const sideZ = left ? -hw : hw
      return {
        a: toWorldXZ(target, x0, sideZ),
        b: toWorldXZ(target, x1, sideZ),
        outward: rotXZ(0, left ? -1 : 1, target.rotationY), // unit, away from the belt
        // A multi-segment belt inclines/declines (tilt rotates the belt vertically about +Z), and an inclined
        // straight is one tilted plane, so the side guard rises and falls in Y along its length. The guard's plan
        // view (X-Z) is still the straight line a..b, so the contact's X-Z is right - but the device must seat at
        // the guard's local elevation at that point, not the flat origin height, or it floats off the rail (or sinks
        // into it) away from the pivot. Map the contact's local X to the surface Y.
        yAt: (c) => ty + (surfaceYAt ? surfaceYAt(toLocalXZ(target, c.x, c.z).x) : 0),
      }
    },
  }
}

/**
 * The point-to-segment mount: a device places its declared local mount point on a host rail (the nearer
 * side guard of a conveyor, or a declared surface's nearer rail) - e.g. a sensor mounts with
 * its beam (local +Z) facing inward across the belt, max range auto-fit to span the bed; a diverter mounts its
 * push side facing outward, lifted/nudged off the guard. The device basis is yaw-only: its local +Z aligns with
 * the chosen facing direction.
 */
export function seatOnRail(moving: PartInstance, proposed: SnapPose, target: PartInstance, spec: SnapMount, socket: RailSocket): SnapCandidate | null {
  const mount = deviceMount(spec)
  const [px, , pz] = proposed.position
  const rail = socket.seat(px, pz)
  const contact = closestOnSegXZ(px, pz, rail.a.x, rail.a.z, rail.b.x, rail.b.z)
  const guardY = rail.yAt(contact)
  const outward = rail.outward

  // device local +Z aligns to this direction; yaw so rotXZ(0,1,yaw) == dirZ
  const dirZ = mount.faceInward ? { x: -outward.x, z: -outward.z } : outward
  const yaw = normalizeAngle(Math.atan2(dirZ.x, dirZ.z))
  const r = rotXZ(mount.localPos.x, mount.localPos.z, yaw)
  const x = contact.x - r.x + outward.x * mount.outwardOffset
  const z = contact.z - r.z + outward.z * mount.outwardOffset
  const y = guardY - mount.localPos.y - mount.yOffset

  // Devices mount on the rail anywhere along its length. The contact is the closest point on the rail
  // segment, so the device slides along the rail as the cursor moves. Engagement mirrors the conveyor
  // gate: a body overlapping the host snaps on 3-D origin distance (override - so a device dropped over the
  // belt still mounts on the rail), otherwise the mount point must come within the conveyor threshold of the
  // rail. The facing gate applies only to an out-facing mount (a diverter, whose yaw picks the push direction):
  // past the threshold its facing must be preserved. An in-facing mount (a sensor) has no facing gate: its yaw
  // is always auto-set to face inward across the belt, so "facing preserved" is never meaningfully true. There
  // is no tight over-the-guard lateral band either; it would wrongly refuse to snap a sensor resting over the belt.
  const fm = forwardXZ(proposed.rotationY)
  const fc = forwardXZ(yaw)
  const alignment = fm.x * fc.x + fm.z * fc.z
  const rankDist = Math.hypot(x - px, y - proposed.position[1], z - pz)
  const override = bodyOverlapsXZ(moving, proposed, target)
  const seat = toWorldXZ(posedClone(moving, proposed), mount.localPos.x, mount.localPos.z)
  const gateDist = override ? rankDist : Math.hypot(seat.x - contact.x, seat.z - contact.z)
  if (!mount.faceInward && alignment < SNAP_FACING_PRESERVED_DOT && gateDist > SNAP_CONVEYOR_VISIBLE_THRESHOLD) return null
  if (!override && gateDist > SNAP_CONVEYOR_VISIBLE_THRESHOLD) return null
  // range auto-fit: range = 2 × half-width + 2 × outward offset, written to the param the mount names
  // (mount.fitRangeParam). A single rail has no far side to span, so it fits nothing.
  const fitParam = mount.autoFitRange ? mount.fitRangeParam : undefined
  return {
    pose: { position: [x, y, z], rotationY: yaw },
    targetId: target.id,
    cost: rankDist + (1 - alignment) * 2,
    junction: { x: contact.x, y: guardY, z: contact.z },
    override,
    ...(fitParam !== undefined ? { paramOverrides: { [fitParam]: socket.span + 2 * mount.outwardOffset } } : {}),
    ...(mount.attach ? { attach: true } : {}),
  }
}
