// SimWorld's internal records - live cargo, unit loads, body holders, part groups, behavior records, rig
// instances - and the small helpers that build, compare or read them. Internal to src/sim (world.ts re-exports
// JoltModule).
import type Jolt from 'jolt-physics'
import type { FrameBeamHit } from '../core/frame'
import type { CargoMarkValue, PartPackage } from '../core/parts/partPackage'
import type { BehaviorInput } from './embeddedBehavior'
import type { ConveyorEntry } from '../core/geometry/collisionShapes'
import { packageRev } from '../core/parts/partRegistry'
import { copySubPose, subPoseEq } from '../core/rig/rigPose'
import type { Quat, RigParams, SubPose, Vec3 } from '../core/rig/rigPose'
import type { PartInstance } from '../core/types'

export type JoltModule = Awaited<ReturnType<typeof Jolt>>

/** The world's step counter, shared by reference with the owners that stamp or cache by step (SimWorld advances it
 *  once per step(), after the solver). */
export interface StepClock {
  step: number
}

/** The reusable kinematic-pose temporaries: MoveKinematic/SetPositionAndRotation copy the values out synchronously,
 *  so one pair serves every per-step pose write (rig links, pilot, grabbed cargo) instead of a WASM new+destroy pair
 *  per call. Single-threaded: each user fills and consumes them in one go. */
export interface KinematicScratch {
  readonly pos: Jolt.RVec3
  readonly quat: Jolt.Quat
}

/** CargoRegistry.placeBody: the one writer of a cargo body's pose (position, rotation or both) outside the solver */
export type PlaceBody = (id: Jolt.BodyID, pos: Jolt.RVec3 | null, rot: Jolt.Quat | null) => void

/** a body's frame / registry key: its BodyID's index and sequence number */
export function bodyKey(body: Jolt.Body): number {
  return body.GetID().GetIndexAndSequenceNumber()
}

export interface LiveBox {
  id: number
  body: Jolt.Body
  /** raw BodyID bits (GetIndexAndSequenceNumber), cached for the batched BodySnapshot reader */
  key: number
  hx: number
  hy: number
  hz: number
  kind: number
  /** scene part this body belongs to (authored or promoted); null for transient spawner boxes */
  partId: string | null
  /** sRGB 0..1 tint sent to the renderer's per-instance color */
  color: [number, number, number]
  /** sim-time (s) when this item was created - for cycle-time measurement */
  spawnTime: number
  /** the mass (kg) and friction its own body is built with: what a split rebuilds it from */
  mass: number
  friction: number
  /** The unit load this piece is part of (ctx.join), or null. While it is, `body`/`key` are the unit's (one rigid
   *  compound for the whole load) and `local` is this piece's fixed pose in it; everything that reads poses goes
   *  through the batched snapshot, which composes the two (snapshotBoxes), so a piece is still drawn, counted and
   *  sensed where it stands. */
  unit: UnitLoad | null
  local: { p: Vec3; q: Quat } | null
  /** facts machines left on it (ctx.mark); a unit's own marks apply on top (marksOf) */
  marks: Record<string, CargoMarkValue> | null
  /** the kinds of the product attributes its package declares (a mark of one must match), null for a bare body */
  attrTypes: Record<string, 'boolean' | 'number' | 'string'> | null
  /** the unit load whose own piece this is (a load that stacks itself, core/frame unitPieces), else null. Such a piece
   *  is no scene part (partId null), but its frame row names the load, so a click on it selects the load. */
  ownerId: string | null
  /** the product it is: the package id of the cargo part it was placed or spawned as (a kind-only spawn is the
   *  built-in part of its kind). What ctx.zone's `part` filter matches. */
  product: string
  /** what it is, as a key into the registry's refs (core/frame.ts cargoRefKey; a part with its own body: its shape key,
   *  core/cargoBody.ts cargoShapeKey, which a unit join or split rebuilds its collider from). Absent for a body nothing
   *  made as a product (a test's spawnBoxAt). */
  shapeKey?: string
  /** CARGO_CAP_* bits (core/frame.ts cargoCapsOf): what it is to the machines around it, read instead of its kind */
  caps: number
}

/**
 * A unit load (ctx.join): a pallet and everything standing on it as one dynamic body, a static compound of each
 * piece's own shape at its offset from the anchor (the pallet). It is what wrapping or strapping does to a load on a
 * real line, and it is also cheaper than the loose pieces (one body for sixteen) and cannot shed a case. The pieces
 * stay in the cargo list (CargoRegistry.boxes), so rows, zone counts and beams are still per piece; only who owns
 * the body changes. A split (splitUnit) gives each piece its own body back where it stands.
 */
export interface UnitLoad {
  body: Jolt.Body
  key: number
  /** pieces, anchor first */
  members: LiveBox[]
  /** marks on the load as a whole (a mark made while joined is stored here, and applies to every piece) */
  marks: Record<string, CargoMarkValue>
  /** the attribute kinds its own product type declares (an authored unit load), else absent */
  attrTypes?: Record<string, 'boolean' | 'number' | 'string'>
  /** the authored unit-load part it came from (its marks are that part's live attributes), else absent */
  partId?: string
}

/** The one holder of a live cargo body (BodyHolds.holders). `grip` is a rig gripper - `rig` null for the bare
 *  grabBody message API, which has no gripper to empty. `pilot` is the walk-mode carry (dynamic, gravity off,
 *  velocity-driven); `pin` is the Use-key pin and the gizmo drag's freeze (kinematic, steered by moveBody). */
export type BodyHolder =
  | { kind: 'grip'; rig: { grips: Map<string, { bodyId: number }[]>; emptied: Set<string> } | null; gripper: string }
  | { kind: 'pilot'; partId: string }
  | { kind: 'pin' }


/** the marks on a piece: its own, with its unit's on top; null when it has none */
export function marksOf(box: LiveBox): Record<string, CargoMarkValue> | null {
  const u = box.unit?.marks
  if (!u || Object.keys(u).length === 0) return box.marks
  return box.marks ? { ...box.marks, ...u } : u
}

/** everything the sim created for one scene part, so a live edit can rebuild just that part */
export interface PartGroup {
  signature: string
  /** what `signature` was last computed from, so a live edit that left this part untouched (same object,
   *  same resolved neighbours, same package rev) skips re-serialising it (updateScene) */
  sigPart?: PartInstance
  sigKey?: string
  sigRev?: number
  bodies: Jolt.Body[]
  conveyorKeys: number[]
  boxIds: number[]
  /** the behaviors and rigs this part's build attached. A clustered deck's owner attaches every member's behavior,
   *  so they are filed under the owner, which every member's edit rebuilds (deckClusterKey). */
  behaviors?: BehaviorRecord[]
  rigs?: RigInstance[]
}

/** One attached custom-part behavior script. Drives a deck's surface velocity and/or a rig's joints. */
/** The FK inputs a rig last applied, as owned values (the behavior runtime replaces/reuses its output
 *  objects each tick, so references can't be compared or kept) - the idle-rig skip in RigDriver.drive
 *  re-runs FK only when the current commands differ from this snapshot. */
export interface AppliedRigInputs {
  joints: Record<string, number>
  grips: Record<string, boolean>
  subPoses: Record<string, SubPose>
  rx: number
  ry: number
  rz: number
  yaw: number
}

/** value-equality for the flat command records a behavior replaces each tick (fresh object, usually
 *  identical content; identity comparison would report every tick as a change) */
export function flatRecEq(a: Record<string, number | boolean> | undefined, b: Record<string, number | boolean>): boolean {
  const ka = a ? Object.keys(a) : []
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a![k] !== b[k]) return false
  return true
}

export function subPosesEq(a: Record<string, SubPose> | undefined, b: Record<string, SubPose>): boolean {
  const ka = a ? Object.keys(a) : []
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const y = b[k]
    const x = a![k]
    if (!x || !y || !subPoseEq(x, y)) return false
  }
  return true
}

/** own-value snapshot of the FK inputs about to be applied - see AppliedRigInputs */
export function snapshotRigInputs(rec: BehaviorRecord, rootPos: [number, number, number], rootYaw: number): AppliedRigInputs {
  const subPoses: Record<string, SubPose> = {}
  if (rec.subPoses) {
    for (const [k, v] of Object.entries(rec.subPoses)) subPoses[k] = copySubPose(v)
  }
  return { joints: { ...(rec.joints ?? {}) }, grips: { ...(rec.grips ?? {}) }, subPoses, rx: rootPos[0], ry: rootPos[1], rz: rootPos[2], yaw: rootYaw }
}

export interface BehaviorRecord {
  handle: number
  /** conveyor surface entry (deck parts); absent for a joint-only rig behavior */
  entry?: Extract<ConveyorEntry, { kind: 'linear' }>
  /** All of this part's conveying-deck entries (a flat deck has one; a rig can have several, e.g. a curved
   *  conveyor's fanned segments). Driven each tick by ctx.setSurfaceVelocity (linear) or setArcSurfaceVelocity
   *  (arc); mutated in place so the live contact listener reads the new velocity without a map rebuild. */
  conveyorEntries?: ConveyorEntry[]
  /** was this behavior's deck moving last tick? A resting box on a stopped conveyor sleeps (Jolt), and a
   *  sleeping body gets no contact callbacks, so when the conveyor later starts, the surface velocity would
   *  never reach it. Tracked so tickBehaviors can wake cargo on the stopped→running edge (see there). */
  wasConveying?: boolean
  /** ...and per deck, for a part that runs its decks at their own speeds (ctx.setSurfaceSpeed with an array: an
   *  accumulating bed's zones). The part as a whole never stops there, so its edge above never fires, while the
   *  zone that restarts is exactly the one whose cargo went to sleep. */
  wasDeckConveying?: boolean[]
  /** a rig conveyor's deck bodies (one per `conveys` link), which it drives through `conveyorEntries` but does
   *  not hold as `body` - what the stopped→running wake has to search above (see wakeCargoOn) */
  deckBodies?: Jolt.Body[]
  /** a posable conveying array's decks, one per copy (a cross-belt sorter's carriers): each driven only by
   *  ctx.setSurfaceSpeed(speed, link, i), never by the part-wide surface commands. `was` is each copy's last
   *  running state, for the stopped->running wake. */
  copyDecks?: { link: string; entries: Extract<ConveyorEntry, { kind: 'linear' }>[]; bodies: Jolt.Body[]; was: boolean[] }[]
  pos: [number, number, number]
  fwd: [number, number, number]
  /** the deck body this script drives - held so a keyed part can be torn down on reload; absent for a joint-only rig */
  body?: Jolt.Body
  /** package id for a hot-reloadable scripted part, or null for an anonymous/test part */
  key: string | null
  /** scene part id - routes this part's joint output to its render visual; absent for anonymous/test parts */
  partId?: string
  /** latest joint commands from the script this step (rig), captured in tickBehaviors for the frame */
  joints?: Record<string, number>
  /** host-applied (clamped) joint pose from the previous tick, fed back as ctx.measured.joints for
   *  closed-loop control. Written in RigDriver.drive after FK; rig parts only. */
  measuredJoints?: Record<string, number>
  /** gripper held-state from the previous tick (true = actually carrying cargo), fed back as
   *  ctx.measured.grips so a behavior can confirm a pick. Written in handleGrips; rig parts only. */
  heldGrips?: Record<string, boolean>
  /** for each gripper holding cargo, how far its load reaches from the gripper along the gripper's X, either side (m):
   *  what a clamp's pads close to (the robot controller's grip joint). Written in handleGrips; rig parts only. */
  heldWidths?: Record<string, number>
  /** latest gripper open/close commands this step (rig), captured in tickBehaviors */
  grips?: Record<string, boolean>
  /** latest emissive lamp states this step (rig setEmissive/ctx.lamps), captured for the frame (render-only) */
  lamps?: Record<string, boolean>
  /** effective param values the behavior reported this step (ctx.report): what it is actually using for
   *  each of its own params, published from the expression that computed it. Carried to the frame so the
   *  Inspector can read out the number the part acted on instead of re-deriving it from the tag table. */
  values?: Record<string, number | boolean>
  /** latest named display values this step (ctx.display): what this part's own screens/labels show.
   *  Carried to the frame beside `values`; a name the behavior stops publishing stops appearing,
   *  which is how a screen goes blank rather than stale. */
  displays?: Record<string, number | boolean | string>
  /** latest sensor-beam results this step (beam link name → nearest-cargo hit), captured in tickBehaviors
   *  for the frame: the same castBeam output handed to the behavior as ctx.sense */
  beamHits?: Record<string, FrameBeamHit>
  /** the cargo body each beam hit this step, for the beams that hit one (ctx.markHit marks it); absent when none did */
  beamBoxes?: Record<string, LiveBox>
  /** latest free-form link pose overrides this step (rig setSubPose), captured in tickBehaviors */
  subPoses?: Record<string, SubPose>
  /** a posable conveying array's copy speeds this tick (ctx.setSurfaceSpeed(speed, link, i)), by link; {} when the
   *  part has conveying copies and ran none, so the view stops their belts */
  copySpeeds?: Record<string, number[]>
  /** latest PLC tags this script wrote this step (ctx.writeTag/writeNumber), captured for the frame */
  tags?: Record<string, number | boolean>
  /** set once the behavior has driven its base (ctx.drive) - the live root pos/fwd has moved off the saved
   *  scene pose, so the frame must emit a basePose for this part and RigDriver.drive must compose from it */
  mobile?: boolean
  /** reusable per-tick input struct handed to behavior.stepDirect - allocated once, fields overwritten each
   *  tick (no per-tick object churn). The runtime copies every field into its own persistent state, so it's
   *  safe to reuse / share references (b.pos, the tag tables) here. */
  input?: BehaviorInput
  /** a reactive part's last inputs, and whether it is waiting for one to change (sim/partSleep.ts) */
  sleep?: import('./partSleep').SleepState
  /** where this part's conveyor entries are in the native facet table (ConveyorFacets.syncPart) */
  facetSlots?: { rev: number; entries: ConveyorEntry[]; slots: number[] }
}

/**
 * A new behavior record with every field present from the start, in one order. Records built from different
 * literals, growing optional fields in whatever order a part's first tick reaches them, end up with several hidden
 * classes, making every read in tickBehaviors (the per-part loop) a megamorphic lookup. One constructor keeps them
 * on one.
 */
export function behaviorRecord(handle: number, pos: [number, number, number], fwd: [number, number, number], key: string | null, init: Pick<BehaviorRecord, 'entry' | 'conveyorEntries' | 'body' | 'partId' | 'joints'> = {}): BehaviorRecord {
  return {
    handle,
    entry: init.entry,
    conveyorEntries: init.conveyorEntries,
    wasConveying: undefined,
    wasDeckConveying: undefined,
    deckBodies: undefined,
    copyDecks: undefined,
    pos,
    fwd,
    body: init.body,
    key,
    partId: init.partId,
    joints: init.joints,
    measuredJoints: undefined,
    heldGrips: undefined,
    heldWidths: undefined,
    grips: undefined,
    lamps: undefined,
    values: undefined,
    displays: undefined,
    beamHits: undefined,
    beamBoxes: undefined,
    subPoses: undefined,
    copySpeeds: undefined,
    tags: undefined,
    mobile: undefined,
    input: undefined,
    sleep: undefined,
    facetSlots: undefined,
  }
}

/** one rig link's collision body: `id` captured once at build (see RigInstance.bodies) */
export interface RigBody {
  name: string
  body: Jolt.Body
  id: Jolt.BodyID
  offset?: Vec3
  /** a posable array instance's index, and its rest place in the link's frame (its array delta) */
  instance?: number
  rest?: Vec3
}

/** One custom rig part in the running world (RigDriver.rigs). */
export interface RigInstance {
  rec: BehaviorRecord
  geo: Extract<PartPackage['geometry'], { kind: 'rig' }>
  /** the package this rig was built from: its behavior + param schema say which lamps its geometry() draws (a
   *  rig's joint behavior carries no package key, so `rec.key` cannot answer that) */
  pkg: PartPackage
  pos: [number, number, number]
  rotationY: number
  /** uniform scale about the rig root (the `scale` custom-part param convention; 1 = native) */
  scale: number
  /** instance params - resolves C-paramgeo size/offset overrides in the FK (a length-driven hinge) */
  params: RigParams
  /** whole-bed incline (rad) for an `inclineParam` conveyor rig; 0 for every other rig. Threaded into the
   *  per-step FK so the tilted wall/guard bodies hold their incline each tick (not just at build). */
  inclineRad: number
  /** `id` = the body's BodyID captured once at build - GetID() is a WASM crossing per call, and the
   *  MoveKinematic loop + park path hit every link every step. The wrapper points at the body's own
   *  member (WebIDL-binder reference return), so it lives exactly as long as `body`; never destroy it. */
  bodies: RigBody[]
  /** gripper link name → the cargo it holds, each with its pose offset in the gripper frame. A list because a
   *  C-multigrab gripper holds every cargo body in its volume at once: a palletizer layer head lifting a formed
   *  layer, a fork carrying a pallet plus the stack on it. A tool no bigger than one load finds one body
   *  in its volume, so the ordinary path is a one-element list. */
  grips: Map<string, { bodyId: number; offPos: Vec3; offQuat: Quat; reachX?: number }[]>
  /** grippers whose load was taken out of them (takeFromGripper) while still commanded closed. They stay open
   *  until the behavior opens them: without the latch a closed, empty gripper re-seeks every step and would
   *  re-grab the stack it just let fall before it had fallen at all. */
  emptied: Set<string>
  /** per-rig FK scratch (POSE_STRIDE floats per link), reused every step so the hot path allocates
   *  nothing; owned per instance because two rigs can share one geometry. Filled by RigDriver.drive. */
  poseBuf?: Float64Array
  /** idle-rig skip: the FK inputs last applied (undefined until the first apply) */
  applied?: AppliedRigInputs
  /** idle-rig skip state: 0 = applying (inputs changing), 1 = settle pass done (same pose re-applied
   *  once, MoveKinematic velocities ~0), 2 = parked (bodies asleep, RigDriver.drive skips the rig) */
  settleSteps?: 0 | 1 | 2
}

/**
 * Identity of a part's physics-relevant fields; a change means rebuild the
 * part's bodies. `resolvedKey` (simResolvedKey) folds in every neighbour-derived
 * input the bodies depend on - side-guard openings, spur end extents, the
 * butted-belt deck-merge cluster, and the stair→platform structure cut - so a
 * conveyor's guard colliders / merged deck / a platform's cut deck rebuild when a
 * neighbour butts/leaves or a stair snaps, even though its own pose/params are unchanged.
 *
 * A custom part also folds in its package's registration rev (this registry
 * instance's - the worker's), so a hot-reloaded package (registerScenePackages
 * bumped the rev on real content change) rebuilds its parts through this same
 * reconcile - no force-rebuild path, and an unchanged package rebuilds nothing.
 */
export function partSignature(part: PartInstance, resolvedKey = ''): string {
  return JSON.stringify([part.type, part.position, part.rotationY, part.params, partPackageRev(part), resolvedKey])
}

/** the registration rev of a custom part's package (0 for anything else) - the part of a signature that
 *  can change without the part itself changing */
export function partPackageRev(part: PartInstance): number {
  return part.type === 'part' ? packageRev((part as { packageId?: string }).packageId ?? '') : 0
}
