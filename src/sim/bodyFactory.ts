// Jolt shape and body construction for SimWorld: box, hull and pallet shapes, the conveyor compound, and the static,
// kinematic and dynamic-cargo bodies. Creation only - SimWorld files each body under its part group and registers
// conveyors.
import type Jolt from 'jolt-physics'
import { runningSurfaceFlow, runningSurfaceNormal } from '../core/geometry/collisionShapes'
import type { ConveyorEntry, ConveyorSubShape } from '../core/geometry/collisionShapes'
import type { CargoPiece } from '../core/cargoBody'
import { conveyorSurfaceFriction } from '../core/conveyor/conveyorFriction'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import type { PartInstance } from '../core/types'
import { BOX_RESTITUTION, CONVEYOR_FRICTION, PALLET_SIZE } from '../core/types'
import { palletCollider } from '../core/pallet'
import { toteCollider } from '../core/tote'
import { axesAgree } from './conveyorContacts'
import type { FacetAxes } from './conveyorContacts'
import { LAYER_MOVING, LAYER_NON_MOVING } from './layers'
import type { JoltModule } from './worldTypes'

/** A merged deck's body friction: its members' when they agree, else the lowest. A member's own grip reaches its
 *  facets through their entries' `friction` (see SimWorld.addConveyorDeck), so the body's value only serves
 *  contacts no facet conveys (a flank), and a listener build that predates per-facet friction. */
export function deckFriction(parts: readonly PartInstance[]): number {
  let lo = Infinity
  for (const p of parts) lo = Math.min(lo, conveyorSurfaceFriction(p))
  return lo === Infinity ? CONVEYOR_FRICTION : lo
}

export const GROUND_FRICTION = 0.6
export const BUILDING_FRICTION = 0.5

// Solver iterations for any island holding a pallet, as a per-body override. Jolt runs an island at the
// highest override among its bodies, and cargo riding a conveyor forms its own island (static and kinematic
// decks never join one), so only islands with a pallet run the extra iterations. The defaults (10 velocity /
// 2 position) cannot hold a loaded pallet. It stands on nine 0.1 m blocks under a load up to ~75x its own 20 kg,
// and on a running deck the surface-velocity friction competes for the same iterations. With the defaults the
// blocks sink into the deck until the pallet's top board rests on it, ~12 cm down, where the rollers can no
// longer drive it. It is not a thin-collider push-through: a 0.2 m deck sinks the same way. Measured on a running
// roller deck: with the defaults 1050 kg sank at 60 Hz and 600 kg at 45 and 75 Hz (and the demo cell's
// 150 kg stalled its line at 29-40 Hz); with 40/10, 150-1500 kg held at every rate from 60 to 500 Hz, worst
// 1.2 cm at 60 Hz / 1500 kg. The velocity iterations are what matter (10/10 sank exactly like the
// defaults), yet 40/2 still sank 1500 kg at 60 Hz (5.7 cm), 30/6 left 2.8 cm there, and 20/4 did not hold.
// 40/10 held only from some start positions: over 48 placed 2 mm apart, 1500 kg at 60 Hz sank past 4 cm from 13-20
// of them and went through the deck from 1-3, with or without cargo damping. 60/10 holds from all 48, worst 1.4 cm,
// for ~6% more solver time on that scene than 40/10. At 75 Hz 40/10 already held from all 48 (worst 1.0 cm).
// Cost of 40/10 over the defaults on the demo cell, whose bodies are mostly cases standing on pallets: solver
// ~8.5 -> ~13 ms and the whole step ~17 -> ~20 ms per sim-second at 60 Hz, headless. Below 60 Hz heavy loads sink
// even with this, which is why MIN_SIM_HZ is 60. palletLoad.test.ts guards it, with a control that sinks without it.
const PALLET_VELOCITY_STEPS = 60
const PALLET_POSITION_STEPS = 10

/**
 * The pallet's collision shape: a top deck slab on nine blocks and three runners, leaving the fork channels open.
 * It is read off the same pieces the drawn pallet is built from (core/pallet.ts), and it lets a fork truck get
 * under the pallet.
 *
 * Not one solid BoxShape. That is right for a box, but a pallet's pockets are the one feature another machine
 * has to pass through. With them filled in, the AGV would have nowhere to put its blades and would reach the load by
 * raising them up through the staging conveyor instead, with no error, only a wrong picture. The AGV's tine is sized
 * against the same numbers (core/types PALLET_*); palletForkFit.test.ts asserts the blade still fits the pocket.
 *
 * Built once per footprint and shared by every pallet body of that size (cargoRegistry). Jolt shapes are
 * ref-counted, so the sub-shapes take one shape per size in the scene, not a dozen per pallet.
 */
export function buildPalletShape(J: JoltModule, length: number, width: number): Jolt.Shape {
  const sx = length
  const sy = PALLET_SIZE[1]
  const sz = width
  const c = palletCollider(length, width)
  const settings = new J.StaticCompoundShapeSettings()
  const add = (shape: Jolt.Shape, y: number, x = 0, z = 0): void => {
    const pos = new J.Vec3(x, y, z)
    const rot = new J.Quat(0, 0, 0, 1)
    settings.AddShapeShape(pos, rot, shape, 0)
    J.destroy(pos)
    J.destroy(rot)
  }
  // deck slab across the whole footprint: its underside is the pocket ceiling, and its top face, at the top of
  // the pallet's bounding box, is what a stack stands on
  add(makeBoxShape(J, sx / 2, c.deckThickness / 2, sz / 2), sy / 2 - c.deckThickness / 2)
  // ...on 3x3 blocks. The gaps between them are the fork channels, both ways round (a four-way pallet).
  //
  // Each block is a column the full pallet height, running up through the deck to its top face, not a block
  // that stops at the deck's underside. Inside the deck the overlap changes nothing (same body, no pocket
  // there), but it is what holds a stack of pallets up. The pallet above stands on nine block feet, each right
  // over one of these blocks. Over a plain deck a foot meets only 29.5 mm of slab: a stack settles further into
  // the penetration slop on every wake, and once it leans the low feet pass the slab's midplane, the contact
  // normal flips downward and the stack falls through itself. Over a column the foot meets 135 mm of solid
  // (palletStack.test.ts).
  for (const b of c.blocks) add(makeBoxShape(J, b.hx, sy / 2, b.hz), 0, b.x, b.z)
  // The runners under the blocks, the full width. The space between them is the path of a fork entering the long
  // face, open from the floor; a fork entering the short face has to pass over them.
  for (const r of c.runners) add(makeBoxShape(J, r.halfWidth, r.thickness / 2, sz / 2), -sy / 2 + r.thickness / 2, r.x)
  const result = settings.Create()
  if (result.HasError()) throw new Error(`pallet compound: ${result.GetError().c_str()}`)
  const shape = result.Get()
  J.destroy(settings) // the transient settings only - the shape is ref-counted and now held by the caller
  return shape
}

/**
 * A cargo part's own collider (docs/cargo-bodies.md): a static compound of its rig's pieces (core/cargoBody.ts), each
 * at its part-local pose. A cylinder piece is a Jolt cylinder, round about its local +Y, so a drum on its side rolls.
 * Built once per shape key and shared by every body of that shape, like the pallet's and the tote's.
 */
export function buildPartCargoShape(J: JoltModule, pieces: readonly CargoPiece[]): Jolt.Shape {
  const settings = new J.StaticCompoundShapeSettings()
  for (const p of pieces) {
    const pos = new J.Vec3(p.pos[0], p.pos[1], p.pos[2])
    const rot = new J.Quat(p.quat[0], p.quat[1], p.quat[2], p.quat[3])
    // the convex radius rounds the edges; it must stay under every half dimension of the piece
    const shape =
      p.shape === 'cylinder'
        ? new J.CylinderShape(p.halfHeight, p.radius, Math.min(0.02, 0.4 * Math.min(p.radius, p.halfHeight)))
        : makeBoxShape(J, p.half[0], p.half[1], p.half[2])
    settings.AddShapeShape(pos, rot, shape, 0)
    J.destroy(pos)
    J.destroy(rot)
  }
  const result = settings.Create()
  if (result.HasError()) throw new Error(`cargo part compound: ${result.GetError().c_str()}`)
  const shape = result.Get()
  J.destroy(settings) // the transient settings only - the shape is ref-counted and now held by the caller
  return shape
}

/**
 * The tote's collider: a static compound of the boxes core/tote.ts toteCollider lists (foot, floor, four walls), so it
 * is open at the top and cargo can be put in it. Built once per size and shared, like the pallet's.
 */
export function buildToteShape(J: JoltModule, length: number, height: number, width: number): Jolt.Shape {
  const settings = new J.StaticCompoundShapeSettings()
  for (const p of toteCollider(length, height, width)) {
    const pos = new J.Vec3(p.center[0], p.center[1], p.center[2])
    const rot = new J.Quat(0, 0, 0, 1)
    settings.AddShapeShape(pos, rot, makeBoxShape(J, p.half[0], p.half[1], p.half[2]), 0)
    J.destroy(pos)
    J.destroy(rot)
  }
  const result = settings.Create()
  if (result.HasError()) throw new Error(`tote compound: ${result.GetError().c_str()}`)
  const shape = result.Get()
  J.destroy(settings) // the transient settings only - the shape is ref-counted and now held by the caller
  return shape
}

/** convex box shape with the standard edge-rounding convex radius */
export function makeBoxShape(J: JoltModule, hx: number, hy: number, hz: number): Jolt.Shape {
  const halfExtent = new J.Vec3(hx, hy, hz)
  const shape = new J.BoxShape(halfExtent, Math.min(0.02, 0.4 * Math.min(hx, hy, hz)))
  J.destroy(halfExtent)
  return shape
}

/**
 * Convex hull shape from part-local points. Only the transient settings is
 * destroyed; the created shape is owned by whatever body/compound takes a ref,
 * so callers must not destroy it (and must keep the returned ShapeResult alive
 * until that ref is taken - Jolt shapes are ref-counted and freed by GC).
 */
export function makeHull(J: JoltModule, points: readonly { x: number; y: number; z: number }[]): {
  shape: Jolt.Shape
  result: unknown
} {
  const settings = new J.ConvexHullShapeSettings()
  const pts = settings.mPoints
  for (const p of points) {
    const v = new J.Vec3(p.x, p.y, p.z)
    pts.push_back(v)
    J.destroy(v)
  }
  const result = settings.Create()
  if (result.HasError()) throw new Error(`hull shape: ${result.GetError().c_str()}`)
  const shape = result.Get()
  J.destroy(settings)
  return { shape, result }
}

/**
 * Build one static body whose collision is a StaticCompoundShape of all the
 * given sub-shapes, placed at the part pose. Distinct surface-velocity entries
 * are stored per body and tagged onto each sub-shape via its user data so the
 * contact listener can recover the right one; identical entry objects share an
 * index (so a uniform conveyor like a curve collapses to a single entry).
 * Combining the facets into one body is what lets Jolt remove the inter-facet
 * ghost collisions for cargo flagged with enhanced internal edge removal.
 */
export function compoundConveyorShape(
  J: JoltModule,
  subs: readonly ConveyorSubShape[],
): { shape: Jolt.Shape; entries: ConveyorEntry[]; axes: (FacetAxes | null)[]; keepAlive: unknown[] } {
  const settings = new J.StaticCompoundShapeSettings()
  const entries: ConveyorEntry[] = []
  const slotsFor = new Map<ConveyorEntry, number[]>()
  // Facet axes per entry, not per sub-shape: facets sharing one entry object share a facet slot
  // (the dedup below), so they must agree on how the surface is oriented. They do wherever it
  // matters (a belt's inclined runs each carry their own tilted entry), but rather than rely on
  // that, a disagreement demotes the slot to undeclared, i.e. a facet with no axes. A curve is the
  // case that needs the flow test: its chords share
  // one arc entry while each faces a different way round the sweep, so the flow axes disagree and
  // the slot correctly declines to claim one (the normals, being coplanar, would have agreed).
  const axes: (FacetAxes | null)[] = []
  // Child shapes (and a hull's ShapeResult) are ref-counted; AddShapeShape
  // takes a ref. Destroying them here corrupts the compound. Keep the hull ShapeResults referenced until the build is done so
  // GC can't reclaim a shape before its ref is taken; GC frees them afterwards.
  const keepAlive: unknown[] = []
  for (const s of subs) {
    let userData = 0
    if (s.entry) {
      const n = runningSurfaceNormal(s)
      const f = runningSurfaceFlow(s)
      const mine: FacetAxes = { n: [n.x, n.y, n.z], f: [f.x, f.y, f.z] }
      // Reuse a slot only when both the entry and the orientation match; a curve's chords share one arc
      // entry while each faces a different way round the sweep, so they take a slot each rather
      // than blurring into one set of axes. Slots are cheap (4096) next to losing the gates.
      const slots = slotsFor.get(s.entry)
      let idx = slots?.find((c) => axesAgree(axes[c - 1], mine))
      if (idx === undefined) {
        entries.push(s.entry)
        axes.push(mine)
        idx = entries.length // 1-based
        if (slots) slots.push(idx)
        else slotsFor.set(s.entry, [idx])
      }
      userData = idx
    }
    let shape: Jolt.Shape
    if (s.box) {
      shape = makeBoxShape(J, s.box.hx, s.box.hy, s.box.hz)
    } else {
      const made = makeHull(J, s.hull ?? [])
      shape = made.shape
      keepAlive.push(made.result)
    }
    // GetSubShapeUserData recurses to the leaf shape's user data, so tag the
    // facet shape itself (the compound's per-sub-shape user data is separate).
    shape.SetUserData(userData)
    const pos = new J.Vec3(s.lx, s.ly, s.lz)
    const rot = new J.Quat(s.qx, s.qy, s.qz, s.qw)
    settings.AddShapeShape(pos, rot, shape, userData)
    J.destroy(pos)
    J.destroy(rot)
  }
  const result = settings.Create()
  if (result.HasError()) throw new Error(`conveyor compound: ${result.GetError().c_str()}`)
  const shape = result.Get()
  J.destroy(settings) // only the transient compound settings; not shapes/results
  return { shape, entries, axes, keepAlive }
}

/** a static body on the non-moving layer at a yawed pose (the caller files it under its part group) */
export function createStaticBody(
  J: JoltModule,
  bodyInterface: Jolt.BodyInterface,
  axisY: Jolt.Vec3,
  shape: Jolt.Shape,
  x: number,
  y: number,
  z: number,
  rotationY: number,
  friction: number,
): Jolt.Body {
  const pos = new J.RVec3(x, y, z)
  const rot = J.Quat.prototype.sRotation(axisY, rotationY)
  const bcs = new J.BodyCreationSettings(shape, pos, rot, J.EMotionType_Static, LAYER_NON_MOVING)
  J.destroy(pos)
  bcs.mFriction = friction
  bcs.mRestitution = 0
  const body = bodyInterface.CreateBody(bcs)
  J.destroy(bcs)
  // a NULL body (the body table is full, see makeCargoBody) has no id to add; PartBodies reports it
  if (J.getPointer(body) !== 0) bodyInterface.AddBody(body.GetID(), J.EActivation_DontActivate)
  return body
}

/** static box with an arbitrary orientation quaternion (tilted belt run/guard) */
export function createStaticBoxQuat(
  J: JoltModule,
  bodyInterface: Jolt.BodyInterface,
  hx: number,
  hy: number,
  hz: number,
  x: number,
  y: number,
  z: number,
  q: { x: number; y: number; z: number; w: number },
  friction: number,
): Jolt.Body {
  const halfExtent = new J.Vec3(hx, hy, hz)
  const shape = new J.BoxShape(halfExtent, Math.min(0.02, 0.4 * Math.min(hx, hy, hz)))
  J.destroy(halfExtent)
  const pos = new J.RVec3(x, y, z)
  const rot = new J.Quat(q.x, q.y, q.z, q.w)
  const bcs = new J.BodyCreationSettings(shape, pos, rot, J.EMotionType_Static, LAYER_NON_MOVING)
  J.destroy(pos)
  J.destroy(rot)
  bcs.mFriction = friction
  bcs.mRestitution = 0
  const body = bodyInterface.CreateBody(bcs)
  J.destroy(bcs)
  // a NULL body (the body table is full, see makeCargoBody) has no id to add; PartBodies reports it
  if (J.getPointer(body) !== 0) bodyInterface.AddBody(body.GetID(), J.EActivation_DontActivate)
  return body
}

// Kinematic box on the moving layer (rig link colliders), with a full orientation - rig links can be
// arbitrarily rotated, not just yawed. Driven each step by the behavior's joint output via MoveKinematic.
export function createKinematicBoxQuat(J: JoltModule, bodyInterface: Jolt.BodyInterface, hx: number, hy: number, hz: number, pos: Vec3, quat: Quat, friction: number): Jolt.Body {
  const p = new J.RVec3(pos[0], pos[1], pos[2])
  const r = new J.Quat(quat[0], quat[1], quat[2], quat[3])
  const bcs = new J.BodyCreationSettings(makeBoxShape(J, hx, hy, hz), p, r, J.EMotionType_Kinematic, LAYER_MOVING)
  J.destroy(p)
  J.destroy(r)
  bcs.mFriction = friction
  bcs.mRestitution = 0
  const body = bodyInterface.CreateBody(bcs)
  J.destroy(bcs)
  if (J.getPointer(body) !== 0) bodyInterface.AddBody(body.GetID(), J.EActivation_Activate)
  return body
}

/** create + add one dynamic cargo body (a piece, or a unit load's compound); null when Jolt's body table is full */
export function makeCargoBody(
  J: JoltModule,
  bodyInterface: Jolt.BodyInterface,
  axisY: Jolt.Vec3,
  shape: Jolt.Shape,
  x: number,
  y: number,
  z: number,
  rotation: number | [number, number, number, number],
  mass: number,
  friction: number,
  heavyIsland: boolean,
  separateManifolds = false,
): Jolt.Body | null {
  const pos = new J.RVec3(x, y, z)
  const rot =
    typeof rotation === 'number'
      ? J.Quat.prototype.sRotation(axisY, rotation)
      : new J.Quat(rotation[0], rotation[1], rotation[2], rotation[3])
  const bcs = new J.BodyCreationSettings(shape, pos, rot, J.EMotionType_Dynamic, LAYER_MOVING)
  J.destroy(pos)
  bcs.mFriction = friction
  bcs.mRestitution = BOX_RESTITUTION
  // No linear damping: cargo loses no measurable speed to air at conveyor speeds. Jolt's default (0.05 per second)
  // slows a box by 0.05 v on top of friction, which read as friction 0.01-0.02 above the surface's
  // (conveyorFrictionFidelity.test.ts). Angular damping keeps its default: Jolt has no rolling resistance, and it is
  // what slows a drum rolling on a floor.
  bcs.mLinearDamping = 0
  // Cargo slides across conveyor surfaces built as compound bodies (curve
  // chords, belt run boxes + bend prisms); this makes Jolt drop the internal
  // edges between those facets so the box doesn't snag at every seam.
  bcs.mEnhancedInternalEdgeRemoval = true
  // Discrete collision (60 Hz) lets a fast body tunnel a thin static collider:
  // a hard spawn drop, or a box shoved into a 0.05 m guard above ~3 m/s, moves
  // more than the wall is thick in one step. Linear-cast (CCD) sweeps the body
  // so cargo can't escape through a guard/wall.
  bcs.mMotionQuality = J.EMotionQuality_LinearCast
  bcs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia
  bcs.mMassPropertiesOverride.mMass = mass
  // A pallet carries a stack many times its own mass on nine small blocks: its island needs more solver
  // iterations than the defaults or the load sinks it into the deck (see PALLET_VELOCITY_STEPS). Kept on the
  // body, so a gizmo freeze (SetMotionType) round-trips it. A unit load stands on the same nine blocks.
  // Manifold reduction merges the contacts of sub-shapes whose normals agree, keeping one depth for them all. A
  // tote's floor hovers 15 mm over the ground beside its foot, inside the speculative contact distance, so the merged
  // contact read the foot as barely touching and the tote sank 8-13 mm into what it stood on (toteCollider.test.ts).
  if (separateManifolds) bcs.mUseManifoldReduction = false
  if (heavyIsland) {
    bcs.mNumVelocityStepsOverride = PALLET_VELOCITY_STEPS
    bcs.mNumPositionStepsOverride = PALLET_POSITION_STEPS
  }
  const body = bodyInterface.CreateBody(bcs)
  J.destroy(bcs)
  // Nothing caps cargo: a line with no outlet piles up in the sim the way it would on a real floor, and
  // Stop clears it. What does run out is Jolt's own body table (JoltSettings.mMaxBodies, 10240 by default,
  // static bodies included). Past it CreateBody returns a NULL body and nothing throws: GetID reads
  // garbage, AddBody silently does nothing, and the box would sit in this list with no physics behind it.
  if (J.getPointer(body) === 0) return null
  bodyInterface.AddBody(body.GetID(), J.EActivation_Activate)
  return body
}

/** take a body out of the physics system and free it */
export function destroyBody(bodyInterface: Jolt.BodyInterface, body: Jolt.Body): void {
  const id = body.GetID()
  bodyInterface.RemoveBody(id)
  bodyInterface.DestroyBody(id)
}
