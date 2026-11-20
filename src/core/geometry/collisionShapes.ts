import { rotateXZ } from '../transforms'
import { conveyorSpeedParams } from '../conveyor/conveyorDirection'
import { bedOf, bedView, DEG, partFootprint, rectangleBedOf, resolveInclineRad } from '../parts/partGeometry'
import { beltColliders, buildBeltPath } from '../conveyor/beltPath'
import type { BeltSegmentSpec } from '../types'
import { ARC_END_EXT, BELT_MIN_RUN_LENGTH, CONVEYOR_BODY_THICKNESS, GUARD_COLLISION_THICKNESS } from '../types'
import type { PartInstance } from '../types'

/**
 * Engine-agnostic collision-shape model: the single source of truth for a part's
 * *physical* geometry (as opposed to its cosmetic render mesh). The sim layer
 * (`SimWorld`) turns these into Jolt bodies; the editor builds invisible raycast
 * proxies and vertex-snap points from the same definitions, so drop placement,
 * snapping, and physics can never drift from one another.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * A collision solid in part-local space: exactly one of box / hull, placed at a
 * local pose. The shared geometric primitive behind every consumer - physics
 * bodies (`ConveyorSubShape`), the editor's vertex-snap points
 * (`collisionVerticesLocal`), and the drop-raycast proxy (`collisionProxy`).
 */
export interface CollisionShape {
  /** exactly one of box / hull describes the geometry (part-local, pre-pose) */
  box?: { hx: number; hy: number; hz: number }
  hull?: readonly Vec3[]
  /** part-local position */
  lx: number
  ly: number
  lz: number
  /** part-local rotation quaternion (identity = 0,0,0,1) */
  qx: number
  qy: number
  qz: number
  qw: number
}

export type ConveyorEntry =
  // vx/vy/vz is the world surface velocity for cargo on this facet. `tan` (optional) is the facet's belt-local
  // tangent {x: along-belt horizontal, y: vertical}: when present, a behavior-driven belt recomputes vx/vy/vz
  // each tick from its commanded speed × this tangent (rotated by the part's forward), so cargo is carried up
  // an incline run rather than pushed flat. Absent ⇒ vx/vy/vz are used directly (a flat deck / static belt).
  // `friction` (optional) is the facet's own surface friction, for a merged deck whose members grip differently: the
  // contact listener combines it with the cargo's in place of the body's. Absent ⇒ the body's friction applies.
  | { kind: 'linear'; vx: number; vy: number; vz: number; tan?: { x: number; y: number }; friction?: number }
  | { kind: 'arc'; cx: number; cz: number; omega: number; friction?: number }

/**
 * One sub-shape of a compound conveyor body: a CollisionShape that also carries a
 * surface-velocity entry. Collecting a conveyor's whole running surface into one
 * body lets Jolt's enhanced internal edge removal suppress the ghost collisions
 * that arise at the seams between the many convex facets (curve chords, belt run
 * boxes + bend prisms).
 */
export interface ConveyorSubShape extends CollisionShape {
  /** world-space surface velocity for cargo on this facet, or null for plain collision */
  entry: ConveyorEntry | null
}

/** max arc-segment angle when tessellating a curved deck into chord facets */
export const MAX_SEGMENT_DEG = 10


/**
 * A side guard's collider cross-section, normalized across every conveyor family.
 *
 * Guards are authored at their visual thickness, and the families differ: belts and curves build colliders
 * at GUARD_COLLISION_THICKNESS (0.05) while a rig roller's and a spur's guard links carry the 0.005 sheet-metal
 * thickness straight through to collision. All four put the inner face at `width/2 + FRAME_WALL_THICKNESS`, so
 * cargo rides the same plane, but without this the collider boxes differ 10x in thickness and 22.5 mm in centre.
 *
 * That causes two problems. A 5 mm collision wall is thin enough for fast cargo to tunnel through. And because
 * guardRuns matches walls on cross-section + centre, every heterogeneous butt is unmergeable: a skew-driven box
 * crossing a roller->belt seam is knocked 33 mm off the wall, the bug the merge exists to prevent. Normalizing
 * here (never shrinking, growing outward so the inner face is untouched) gives rollers and spurs the same
 * envelope as belts, and the existing merge then handles cross-family butts.
 *
 * Visuals are unaffected: this is applied when building bodies, not to the authored link/mesh size.
 */
export function guardColliderCrossSection(authoredHalfThickness: number): { hz: number; outwardShift: number } {
  const hz = Math.max(authoredHalfThickness, GUARD_COLLISION_THICKNESS / 2)
  return { hz, outwardShift: hz - authoredHalfThickness }
}

/**
 * The belt-deck facets (run boxes + bend prisms) for a behavior-driven belt: a custom/SDK part whose
 * geometry() builds the same multi-segment path. Identical to {@link beltDeckSubs}' shapes, but each facet's
 * surface-velocity entry starts at zero and carries its belt-local `tan` (the run/prism tangent). The host
 * fills vx/vy/vz each tick from the behavior's commanded speed × tan × forward, so a PLC-gated belt
 * stops and a reversed speed reverses. Part-local, so it
 * composes through addCompoundConveyor at the part pose. Takes the raw params a `function`-geometry belt holds
 * (segments + height + width) instead of a BeltConveyorPart.
 */
export function beltDeckSubsLocal(segments: readonly BeltSegmentSpec[], height: number, width: number, minRun = BELT_MIN_RUN_LENGTH): ConveyorSubShape[] {
  const subs: ConveyorSubShape[] = []
  for (const c of beltColliders(buildBeltPath(segments, height), minRun)) {
    const entry: ConveyorEntry = { kind: 'linear', vx: 0, vy: 0, vz: 0, tan: { x: c.tanX, y: c.tanY } }
    if (c.kind === 'box') {
      subs.push({ box: { hx: c.length / 2, hy: c.height / 2, hz: width / 2 }, lx: c.cx, ly: c.cy, lz: 0, qx: 0, qy: 0, qz: Math.sin(c.angle / 2), qw: Math.cos(c.angle / 2), entry })
    } else {
      const pts: { x: number; y: number; z: number }[] = []
      for (const pt of c.points) {
        pts.push({ x: pt.x, y: pt.y, z: -width / 2 })
        pts.push({ x: pt.x, y: pt.y, z: width / 2 })
      }
      subs.push({ hull: pts, lx: 0, ly: 0, lz: 0, qx: 0, qy: 0, qz: 0, qw: 1, entry })
    }
  }
  // Each facet stays one solid: the sim declares its running surface to the contact listener, which
  // drives cargo on the top and walls it on the sides. Splitting it into a conveying slab over
  // a plain housing would add a body per facet and leave a notch cargo catches on at junctions.
  return subs
}

/**
 * Lift a part-local deck facet into world space, for a merged multi-belt compound
 * built at the origin. Position applies the part's +Y yaw + translation (the same
 * mapping as rotateXZ and the body's sRotation), orientation pre-multiplies the
 * part-yaw quaternion onto the facet quat. The facet's surface-velocity entry is
 * already world-space (forwardXZ-baked), so it carries through unchanged. For a
 * hull facet (lz=0, identity quat) this places its part-local points at the part
 * pose, identical to building the body at that pose.
 */
export function worldSub(s: ConveyorSubShape, part: PartInstance): ConveyorSubShape {
  const [px, py, pz] = part.position
  const sy = Math.sin(part.rotationY / 2)
  const cy = Math.cos(part.rotationY / 2)
  const r = rotateXZ(s.lx, s.lz, part.rotationY) // same planar mapping as the body's sRotation
  return {
    ...s,
    lx: px + r.x,
    ly: py + s.ly,
    lz: pz + r.z,
    qx: cy * s.qx + sy * s.qz,
    qy: cy * s.qy + sy * s.qw,
    qz: cy * s.qz - sy * s.qx,
    qw: cy * s.qw - sy * s.qy,
  }
}

/**
 * Curved-conveyor deck facets in the SDK arc convention: the mirror of {@link curvedDeckSubsParams} for an SDK
 * curved conveyor (a `function`-geometry custom part whose sweep param declares an `arc` handle). The built-in
 * curve sweeps from local +Z toward +X (curvePointLocal); the SDK curve enters at local +X and sweeps toward −Z:
 * P(t) = (rc·cos t, −rc·sin t), t ∈ [0, sweep] - matching the curved-conveyor behavior + build script + snap ends
 * (see docs/part-gizmos.md, sdkCurvedLocalEnds). Same arc surface-velocity field (cx/cz world, omega = speed/rc,
 * rotation-invariant about the centre), so the behavior's setArcSurfaceVelocity drives it identically. Each facet's
 * yaw is derived from its chord direction so the box's local +X follows the flow; the lead-in/out stubs extend the
 * inlet/outlet tangents (like the built-in), so cargo enters/leaves flush. `stub` is their length: ARC_END_EXT, or
 * a deep curved belt's longer drum radius (its snap `endExt`), so the deck still reaches its end.
 */
export function sdkCurvedDeckSubs(
  innerRadius: number,
  width: number,
  sweepDeg: number,
  speed: number,
  worldX: number,
  worldZ: number,
  rotationY: number,
  stub: number = ARC_END_EXT,
): ConveyorSubShape[] {
  const r = innerRadius + width / 2
  const sweep = sweepDeg * DEG
  const segs = Math.max(1, Math.ceil(sweepDeg / MAX_SEGMENT_DEG))
  const dt = sweep / segs
  const chord = 2 * r * Math.sin(dt / 2)
  const entry: ConveyorEntry = { kind: 'arc', cx: worldX, cz: worldZ, omega: speed / r }
  // SDK arc point: entry at local +X (t=0), sweeping toward −Z.
  const P = (t: number): { x: number; z: number } => ({ x: r * Math.cos(t), z: -r * Math.sin(t) })
  // yaw whose local +X (forwardXZ: (cos θ, −sin θ)) aligns with the XZ direction (dx, dz)
  const yawFor = (dx: number, dz: number): { qy: number; qw: number } => {
    const th = Math.atan2(-dz, dx)
    return { qy: Math.sin(th / 2), qw: Math.cos(th / 2) }
  }
  const subs: ConveyorSubShape[] = []
  for (let i = 0; i < segs; i++) {
    const a = P(i * dt)
    const b = P((i + 1) * dt)
    const q = yawFor(b.x - a.x, b.z - a.z)
    subs.push({
      box: { hx: chord / 2 + 0.01, hy: CONVEYOR_BODY_THICKNESS / 2, hz: width / 2 },
      lx: (a.x + b.x) / 2, ly: -CONVEYOR_BODY_THICKNESS / 2, lz: (a.z + b.z) / 2,
      qx: 0, qy: q.qy, qz: 0, qw: q.qw, entry,
    })
  }
  // lead-in/out collision stubs mirror the built-in curved deck (curvedDeckSubsParams): a uniform ARC_END_EXT
  // ramp on both families (belt and roller), so cargo carries smoothly onto/off the arc. (Only the snap ends
  // shorten to CURVED_ROLLER_END_EXT for a roller; the collision stub stays 0.25, exactly like the built-in.)
  if (stub > 0) {
    // back stub: at the inlet P(0)=(r,0); the flow-in tangent is −Z, so the stub extends upstream (+Z).
    const bq = yawFor(0, -1)
    const bwv = rotateXZ(0, -1, rotationY) // world flow direction at the inlet (−Z, part-local)
    subs.push({
      box: { hx: stub / 2, hy: CONVEYOR_BODY_THICKNESS / 2, hz: width / 2 },
      lx: r, ly: -CONVEYOR_BODY_THICKNESS / 2, lz: stub / 2,
      qx: 0, qy: bq.qy, qz: 0, qw: bq.qw,
      entry: { kind: 'linear', vx: bwv.x * speed, vy: 0, vz: bwv.z * speed },
    })
    // front stub: at the outlet P(sweep); the flow-out tangent T(sweep) = (−sin, −cos), extended downstream.
    const exit = P(sweep)
    const tlx = -Math.sin(sweep)
    const tlz = -Math.cos(sweep)
    const fq = yawFor(tlx, tlz)
    const fwv = rotateXZ(tlx, tlz, rotationY)
    subs.push({
      box: { hx: stub / 2, hy: CONVEYOR_BODY_THICKNESS / 2, hz: width / 2 },
      lx: exit.x + tlx * (stub / 2), ly: -CONVEYOR_BODY_THICKNESS / 2, lz: exit.z + tlz * (stub / 2),
      qx: 0, qy: fq.qy, qz: 0, qw: fq.qw,
      entry: { kind: 'linear', vx: fwv.x * speed, vy: 0, vz: fwv.z * speed },
    })
  }
  // same rule as the belt bed: one solid per facet, with the inner/outer arc flanks walled by the
  // declared running surface rather than by a nested housing.
  return subs
}

/** Part-local deck facets for any mergeable conveyor type; [] for the rest. */
export function conveyorDeckSubs(part: PartInstance): ConveyorSubShape[] {
  const bed = bedOf(part)
  if (bed === null) return []
  switch (bed.kind) {
    case 'path':
      // a belt merges into a butted cluster: its facets carry tan, driven each tick by the part's behavior
      return beltDeckSubsLocal(bed.view.segments, bed.view.height, bed.view.width)
    case 'arc': {
      // arc chord + stub facets, so it collides and carries cargo around the sweep (its behavior re-drives the arc
      // field each tick via setArcSurfaceVelocity). cx/cz seed to the part's world XZ.
      const key = conveyorSpeedParams(part).speed
      const sp = key ? (part.params as unknown as Record<string, unknown>)[key] : undefined
      const speed = typeof sp === 'number' ? sp : 0
      const v = bed.view
      return sdkCurvedDeckSubs(v.innerRadius, v.width, v.sweepDeg, speed, part.position[0], part.position[2], part.rotationY, Math.max(ARC_END_EXT, v.endExt))
    }
    case 'straight':
    case 'spur':
    case 'turntable':
      // their decks are built from their own geometry, part by part, and never merge
      return []
  }
}

// --- editor collision proxy ------------------------------------------------
//
// A coarse per-part collision solid, distinct from the fine conveyorDeckSubs
// facets above: the editor uses it for vertex snapping and for the
// drop-placement raycast, where a single deck reads better than the many physics
// facets. Both granularities live here so they can never drift from each other.

const IDENTITY = { lx: 0, ly: 0, lz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } as const

/**
 * The eight corners of the part's footprint oriented box (local frame).
 *
 * An inclined straight roller conveyor is the exception: its render deck tilts about the centre
 * (rigWorldPoses `inclineRad`, docs/conveyor-incline.md), but partFootprint reports a rise-expanded
 * axis-aligned AABB (a flat top at head height across the whole bed). Handing that AABB to the drop-raycast
 * proxy / vertex-snap would make a box dropped over the tail float up to head height (and, cast down an angled
 * camera ray, end up displaced to the side). So for a tilt we un-expand the AABB back to the flat deck slab and
 * rotate its corners by Rz(θ) about the local origin (the exact tilt render + sim apply), so the proxy top
 * follows the true deck.
 */
function footprintHull(part: PartInstance): Vec3[] {
  const fp = partFootprint(part)
  const cx = fp.cx ?? 0
  const cz = fp.cz ?? 0
  const straight = rectangleBedOf(part)
  const incline = straight ? resolveInclineRad(part) : 0
  if (straight && incline !== 0) {
    // the slab is the bed's slope length; the footprint's hx is its plan length ((L/2)·cos), so read the bed
    const half = straight.length / 2
    const rise = half * Math.abs(Math.sin(incline)) // the vertical growth partFootprint added both ways
    const y0 = fp.y0 + rise // un-expand to the flat deck slab (centre-origin, pre-tilt)
    const y1 = fp.y1 - rise
    const c = Math.cos(incline)
    const s = Math.sin(incline)
    const out: Vec3[] = []
    for (const sx of [-1, 1]) {
      const x = cx + sx * half
      for (const y of [y0, y1]) {
        // Rz(θ) about the local origin: matches rigWorldPoses' qFromAxisAngle([0,0,1], inclineRad)
        for (const sz of [-1, 1]) out.push({ x: x * c - y * s, y: x * s + y * c, z: cz + sz * fp.hz })
      }
    }
    return out
  }
  const out: Vec3[] = []
  for (const sx of [-1, 1]) {
    for (const y of [fp.y0, fp.y1]) {
      for (const sz of [-1, 1]) out.push({ x: cx + sx * fp.hx, y, z: cz + sz * fp.hz })
    }
  }
  return out
}

/**
 * The part's editor collision proxy: a simplified solid used as the vertex-snap
 * source and drop-raycast target - the footprint oriented box (partFootprint already reflows a custom/SDK
 * conveyor's true bed). A path-bed belt is its physics deck facets instead: its footprint is one box topped at
 * the highest run, so on a Z-frame or nose-over a cursor ray hit that phantom top over the low run (or its side)
 * and the drop landed away from the cursor.
 */
export function collisionProxy(part: PartInstance): CollisionShape[] {
  const belt = bedView(part, 'path')
  if (belt) return beltDeckSubsLocal(belt.segments, belt.height, belt.width)
  return [{ hull: footprintHull(part), ...IDENTITY }]
}

/** the eight corners of a box's local-frame extent */
function boxCorners(b: { hx: number; hy: number; hz: number }): Vec3[] {
  const out: Vec3[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) out.push({ x: sx * b.hx, y: sy * b.hy, z: sz * b.hz })
    }
  }
  return out
}

/** rotate a part-local point by the (qx,qy,qz,qw) quaternion (identity = no-op, exact) */
function rotateByQuat(p: Vec3, qx: number, qy: number, qz: number, qw: number): Vec3 {
  const tx = 2 * (qy * p.z - qz * p.y)
  const ty = 2 * (qz * p.x - qx * p.z)
  const tz = 2 * (qx * p.y - qy * p.x)
  return {
    x: p.x + qw * tx + (qy * tz - qz * ty),
    y: p.y + qw * ty + (qz * tx - qx * tz),
    z: p.z + qw * tz + (qx * ty - qy * tx),
  }
}

/**
 * The outward normal of the surface cargo rides on this facet, in the frame the facet's pose is
 * expressed in - its own local +Y carried through its pose, so an inclined belt run or a rolled
 * bend prism reports the tilted surface rather than world up.
 *
 * Every conveying facet is authored top-up, so this is derivable rather than authored. The sim
 * hands it to the contact listener to gate which contacts a facet conveys: surface velocity
 * belongs to the running surface, not to the whole solid, so cargo that hits a deck's flank is
 * walled instead of dragged along the flow. The frame the pose sits in is the body's, for both
 * conveyor paths - a lone part's facets are part-local within a body carrying the part's pose,
 * and a merged cluster's are lifted to world within a body built at the origin - so the result is
 * body-local either way, which is what the listener rotates by the body's orientation.
 */
export function runningSurfaceNormal(sub: CollisionShape): Vec3 {
  return rotateByQuat({ x: 0, y: 1, z: 0 }, sub.qx, sub.qy, sub.qz, sub.qw)
}

/**
 * The direction cargo travels along this facet, in the same frame as {@link runningSurfaceNormal}.
 *
 * Local +X, by the same convention that makes local +Y up: a belt run box is built with its length
 * on x and rolled about z to incline, a curve's chord facets take "yaw derived from the chord
 * direction so the box's local +X follows the flow" (sdkCurvedDeckSubs), and a bend prism extrudes
 * across z. Sign does not matter - every consumer compares |dot| - so a reversed belt needs nothing.
 *
 * Paired with the normal this tells the contact listener which face a contact is on, which is what
 * lets a deck be one body: a face perpendicular to both is a side wall, and must keep its collision
 * however shallow the contact, where the ghost gates would otherwise drop it as a leading-edge ram.
 */
export function runningSurfaceFlow(sub: CollisionShape): Vec3 {
  return rotateByQuat({ x: 1, y: 0, z: 0 }, sub.qx, sub.qy, sub.qz, sub.qw)
}

/** Corner points of a collision shape in the part's root-local frame (pose applied). */
export function shapeCornersLocal(shape: CollisionShape): Vec3[] {
  const local = shape.hull ?? boxCorners(shape.box!)
  return local.map((p) => {
    const r = rotateByQuat(p, shape.qx, shape.qy, shape.qz, shape.qw)
    return { x: r.x + shape.lx, y: r.y + shape.ly, z: r.z + shape.lz }
  })
}
