import type Jolt from 'jolt-physics'
import { CARGO_KIND_BOX, cargoFriction, cargoRefKey, cargoView, kindSpawnRef, partQuat } from '../core/frame'
import { unitPieces } from '../core/frame'
import type { BoxFrame, FrameBeamHit, FrameDressing, ZoneMix } from '../core/frame'
import type { CargoPiece } from '../core/cargoBody'
import type { FlowFact } from '../core/flow/flowFacts'
import type { Measurements, SimCore } from '../core/simCore'
import { hexToRgb } from '../core/math'
import { bedOf, faceHandleOfPkg, pathHandleOfPkg, rigInclineRad, sdkSpurCorners } from '../core/parts/partGeometry'
import type { SpurConveyorView } from '../core/parts/partGeometry'
import { beltGuardWalls } from '../core/guards/beltGuards'
import { curvedGuardWalls } from '../core/guards/curvedGuards'
import { functionStaticHulls, functionStaticWalls } from '../core/guards/functionGuards'
import { rotateXZ } from '../core/transforms'
import { resolvePartParams } from '../core/geometry/geometryEval'
import { clearPartDiagnostics, reportPartDiagnostic } from '../core/parts/partDiagnostics'
import type { ParamValue } from '../core/parts/partApi'
import { conveyorSpeedParams } from '../core/conveyor/conveyorDirection'
import { conveyorSurfaceFriction, packageSurfaceFriction } from '../core/conveyor/conveyorFriction'
import type { GuardOpenings } from '../core/guards/guardOpenings'
import type { GuardExtents } from '../core/guards/guardExtents'
import type { StructureConnections } from '../core/structureConnections'
import { structureCutGeo } from '../core/structureCuts'
import type { DeckCluster } from '../core/deckClusters'
import type { GuardRun } from '../core/guards/guardRuns'
import { resolveScene, simResolvedKey } from '../core/scene/sceneResolve'
import type { ResolvedContext } from '../core/scene/sceneResolve'
import { beltDeckSubsLocal, conveyorDeckSubs, worldSub } from '../core/geometry/collisionShapes'
import type { ConveyorEntry, ConveyorSubShape } from '../core/geometry/collisionShapes'
import type { BeltSegmentSpec } from '../core/types'
import type { PartPackage } from '../core/parts/partPackage'
import { isCargoPackage, rigJointsJson, subPosedLinkNames } from '../core/parts/partPackage'
import * as behavior from './embeddedBehavior'
import { getPackage, registerNewScenePackages, registerScenePackages } from '../core/parts/partRegistry'
import { arrayInstanceDeltas, linkHalfExtents, pitchCapMessage, posableArraysJson, qApply, qFromAxisAngle, qMul, rigWorldPoses } from '../core/rig/rigPose'
import type { RigParams } from '../core/rig/rigPose'
import type { Vec3 } from '../core/rig/rigPose'
import type {
  BuildingPart,
  SdkPart,
  PartInstance,
  PartType,
  SceneJSON,
  SimRate,
} from '../core/types'
import {
  BOX_FRICTION,
  BOX_MASS,
  CONVEYOR_BODY_THICKNESS,
  CONVEYOR_FRICTION,
  BELT_FRICTION,
  GROUND_SIZE,
  toSimRate,
} from '../core/types'
import { BehaviorBus } from './behaviorBus'
import { BUILDING_FRICTION, deckFriction, GROUND_FRICTION } from './bodyFactory'
import { BodyHolds } from './bodyHolds'
import { buildingBoxes, groundHalfExtent } from './buildingColliders'
import { CargoFlow } from './cargoFlow'
import { CargoRegistry } from './cargoRegistry'
import { DECK_AXES } from './conveyorContacts'
import { ConveyorFacets } from './conveyorFacets'
import { newSleepState, noteCall, waits } from './partSleep'
import { driveDeckEntries } from './deckDrive'
import { SimFlowFacts } from './flowFacts'
import { buildFrame } from './frameBuild'
import { LAYER_MOVING, LAYER_NON_MOVING, NUM_BROAD_PHASE_LAYERS, NUM_OBJECT_LAYERS } from './layers'
import { BodyTableFull, PartBodies } from './partBodies'
import { PilotCapsule } from './pilotCapsule'
import { buildRigBodies, linkMovesAtRuntime } from './rigBuild'
import type { RigBodySink } from './rigBuild'
import { RigDriver } from './rigDriver'
import { SensorRegistry } from './sensorRegistry'
import { LoadCells } from './loadCells'
import { cargoContacts } from './cargoContacts'
import { behaviorRecord, marksOf, partPackageRev, partSignature } from './worldTypes'
import type { BehaviorRecord, BodyHolder, JoltModule, KinematicScratch, LiveBox, PartGroup, RigBody, StepClock, UnitLoad } from './worldTypes'

export type { JoltModule } from './worldTypes'

/** the part's bundle of neighbour-derived inputs a builder may need (resolveScene); mirrors buildPart's arg. */
interface PartBuildContext {
  ctx?: ResolvedContext
}

/**
 * Builds the physics bodies for one part into the world's current PartGroup.
 * The sim-side analogue of render's PartVisualFactory: one entry per part type
 * that has a physical footprint. The discriminant on the registry key
 * guarantees the `part` cast inside each builder.
 */
type PartBuilder = (world: SimWorld, part: PartInstance, ctx: PartBuildContext) => void

const CULL_Y = -5
/** how far past a starting deck's bounds its cargo wake reaches (wakeCargoOn): contact scale, not a search radius */
const CARGO_WAKE_MARGIN = 0.05
/** one 60 Hz frame: a step() slower than this is a visible hitch whatever the average says (overBudgetSteps) */
const STEP_BUDGET_MS = 1000 / 60
// Resting penetration the solver tolerates (Jolt default 0.02). Lowered so cargo
// rests ~flush on the deck instead of sunk ~2 cm; kept >> contact scale so stacks
// don't jitter. See the 'rests flush and stacks stably' test.
const PENETRATION_SLOP = 0.005
/** Coerce a `function`-belt's `segments` param (a numberList → number[][] of [length, tiltDeg] rows) to
 *  BeltSegmentSpec[], or null when it's absent/empty/malformed (the part is then treated as a flat deck). */
function parseBeltSegments(v: unknown): BeltSegmentSpec[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: BeltSegmentSpec[] = []
  for (const row of v) {
    if (!Array.isArray(row) || typeof row[0] !== 'number' || typeof row[1] !== 'number' || !(row[0] > 0)) return null
    out.push({ length: row[0], tiltDeg: row[1] })
  }
  return out
}

/**
 * The running physics world: one Jolt system, the scene's parts built into it, and the step that drives them. It is
 * the composition root of src/sim's run-time owners - the conveyor facet table, the part bodies, the cargo registry,
 * the holds, the pilot's capsule, the sensors, the rigs, the behavior bus and the cargo flow, each of which keeps its
 * own state - and wires each to the others it needs. What stays here is what ties them together: building a part
 * (each builder below files into the owners), the step (cull, tickBehaviors, the drives, the facet sync, the solver),
 * the live-edit reconcile (updateScene), the public message API, and teardown.
 */
export class SimWorld implements SimCore<BoxFrame> {
  /**
   * Sim-side build dispatch - the mirror of render/parts/registry.ts. One entry
   * per part type with a physical footprint; types with no bodies (group) are
   * absent and build to nothing. An SDK part's bodies come from its
   * package (addSdkPart), whether or not it has a physical footprint.
   */
  private static readonly partBuilders = new Map<PartType, PartBuilder>([
    ['building', (w, p) => w.addBuilding(p as BuildingPart)],
    ['part', (w, p, c) => w.addSdkPart(p as SdkPart, c.ctx?.cluster, c.ctx?.openings, c.ctx?.extents, c.ctx?.structConn, c.ctx?.guardRun)],
  ])

  private readonly J: JoltModule
  private readonly joltInterface: Jolt.JoltInterface
  private readonly system: Jolt.PhysicsSystem
  private readonly bodyInterface: Jolt.BodyInterface
  /** every conveyor body's surface-velocity entries + the contact listener that reads them (conveyorFacets.ts) */
  private readonly facets: ConveyorFacets
  /** the live cargo - bodies, unit loads, dressings - and the per-step caches over it (cargoRegistry.ts) */
  private readonly cargo: CargoRegistry
  /** who holds each cargo body, and the pilot's carry (bodyHolds.ts) */
  private readonly holds: BodyHolds
  /**
   * Read-only views of what the two owners above keep, for the step loops here and for tests that look inside the
   * world (unitLoad, palletDispenser, stretchWrapper, ... reach `boxes`, `units` and `holders` through a cast):
   * the same objects, never a copy, so a read is as cheap as reading a field of the world.
   */
  private readonly boxes: readonly LiveBox[]
  private readonly units: ReadonlySet<UnitLoad>
  private readonly dressings: ReadonlyMap<number, ReadonlyMap<string, FrameDressing>>
  private readonly holders: ReadonlyMap<number, BodyHolder>
  private readonly axisY: Jolt.Vec3
  /** accept-everything layer filters for the deck-start cargo wake (wakeCargoOn); static bodies it also finds
   *  have nothing to activate */
  private readonly anyBroadPhaseLayer: Jolt.BroadPhaseLayerFilter
  private readonly anyObjectLayer: Jolt.ObjectLayerFilter
  /** reusable kinematic-pose temporaries (worldTypes KinematicScratch), shared with the holds */
  private readonly kin: KinematicScratch
  /** the attached behaviors, the tag bus, pending uses and the conveyor speeds (behaviorBus.ts) */
  private readonly bus = new BehaviorBus()
  /** the bus's conveyor speeds, read-only: the frame's source, and what conveyorComms / sdkConveyorParity
   *  tests reach through a cast */
  private readonly conveyorSpeeds: ReadonlyMap<string, number> = this.bus.conveyorSpeeds
  /** the custom rig parts: link bodies driven from FK each step, and their grippers (rigDriver.ts) */
  private readonly rigDriver: RigDriver
  /** the sensing parts' beams and zones, and the casts/counts over the cargo (sensorRegistry.ts) */
  private readonly sensors: SensorRegistry
  /** the rigs' load-cell links and what they read (loadCells.ts, ctx.weight) */
  private readonly loadCells: LoadCells
  /** every part's bodies, filed by part, and the constructors that file them (partBodies.ts) */
  private readonly bodies: PartBodies
  /** the part groups, read-only (PartBodies.groups): updateScene's reconcile reads them, and sdkConveyorParity
   *  reaches them through a cast */
  private readonly partGroups: ReadonlyMap<string, PartGroup>
  /** the scene as authored (parts + their parents): what an authored unit load's membership is read from */
  private sceneParts: readonly PartInstance[] = []
  /** spawns, despawns (the line's completions), product state and authored unit loads (cargoFlow.ts) */
  private readonly flow: CargoFlow
  /** what physically happened to the cargo, collected after every step (sim/flowFacts.ts); null when turned off */
  private readonly flowFacts: SimFlowFacts | null
  /** the kinematic capsule that lets the pilot's body shove cargo (pilotCapsule.ts) */
  private readonly pilot: PilotCapsule
  /** the step counter (stepCount), shared with the cargo registry's step-keyed caches */
  private readonly clock: StepClock = { step: 0 }
  /** how many physics steps this world has taken: 0 until its parts have run once and published their tags */
  get stepCount(): number {
    return this.clock.step
  }
  /** This world's physics step rate (Hz), fixed for its lifetime: the scene's `simHz`, whole Hz within MIN_SIM_HZ..MAX_SIM_HZ.
   *  Everything here that turns steps into seconds reads it (or `dt`) - never DEFAULT_SIM_HZ, which is
   *  only what a scene that names no rate runs at. */
  readonly hz: SimRate
  /** one step of sim time, s (1 / hz): the Jolt step, the behaviors' ctx.dt, a kinematic move's dt */
  private readonly dt: number
  /** cumulative per-phase step() cost since world build (all ms) - shipped as StepStats.phases so
   *  probes can window-diff where step time goes. beams/zones are subsets of behaviors (the sensing
   *  casts happen inside tickBehaviors); the remaining phases partition step() end to end. */
  readonly phaseMs = { cull: 0, behaviors: 0, beams: 0, zones: 0, script: 0, drives: 0, facets: 0, solver: 0, flow: 0 }
  /** The single slowest step() since world build, split by the same phases. Averages hide a stall: one 180 ms
   *  step in a thousand moves the mean by 0.2 ms and is a visible freeze. `step` is its stepCount, `boxes` the
   *  cargo count going in. Only written on a new maximum, so the cost is one compare per step. */
  readonly worstStep = { ms: 0, step: -1, boxes: 0, cull: 0, behaviors: 0, drives: 0, facets: 0, solver: 0 }
  /** steps whose step() alone overran one 60 Hz frame (STEP_BUDGET_MS) */
  overBudgetSteps = 0
  /** per-part cumulative cost (ms since world build), keyed by part id ('#anon' for keyless attaches):
   *  script = this part's behavior.stepDirect body, rig = its RigDriver.drive iteration (FK + kinematic
   *  moves + grips). Lets probes rank which parts the phase totals go to - see e2e/probes/phys-breakdown.mjs. */
  readonly scriptMsByPart = new Map<string, number>()
  readonly rigMsByPart = new Map<string, number>()
  /** the single slowest behavior.stepDirect call (perfParts only): which part, which step. Set against
   *  worstStep.behaviors, it says whether a behaviors-phase stall was a script or the host work around it. */
  readonly worstScriptCall = { ms: 0, partId: '', step: -1 }
  /** Per-part profiling (the two maps above + the `script` phase + the beams/zones sub-phases), off by
   *  default and opt-in via `?perfparts`. Unlike the step-level phase timers (a handful of reads per step,
   *  negligible) these are O(parts): a worker-thread performance.now() is ~350 ns, and a sensor part makes
   *  8 of them per step, ~2.8 us, most of its reported cost. That overhead makes the per-part script floor
   *  look flat and body-independent. Probes turn it on; shipping runs leave it off. */
  perfParts = false
  private readonly wakeAllParts: boolean // a test's check: call every reactive part on every step
  private disposed = false

  /** benchRaw (?joltraw, bench-only): skip the contact listener entirely and disable sleeping, so
   *  e2e/threaded-jolt-bench.mjs can measure pure solver scaling. Conveyor carry, ghost-collision
   *  gating and sensors are dead in this mode.
   *  forceJsListener (?jsconveyor): use the per-contact JS ContactListenerJS even when the forked
   *  build's native ConveyorContactListener is available - the rollback hatch / A-B lever.
   *  hz: the scene's physics step rate; absent steps at DEFAULT_SIM_HZ; anything else goes through toSimRate.
   *  flowFacts: false skips collecting flow facts (sim/flowFacts.ts): the A/B lever that shows they cost little and
   *  change nothing. */
  constructor(jolt: JoltModule, scene: SceneJSON, opts: { benchRaw?: boolean; forceJsListener?: boolean; perfParts?: boolean; hz?: number; flowFacts?: boolean; wakeAllParts?: boolean } = {}) {
    this.wakeAllParts = opts.wakeAllParts === true
    const J = jolt
    this.J = J
    this.hz = toSimRate(opts.hz)
    this.dt = 1 / this.hz
    // fresh run, fresh behavior-runtime perf counters (module-global, like this world's own phaseMs)
    this.perfParts = opts.perfParts === true
    behavior.setPerfEnabled(this.perfParts)
    behavior.resetPerfStats()
    const benchRaw = opts.benchRaw === true

    const settings = new J.JoltSettings()
    const objectFilter = new J.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS)
    objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING)
    objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING)
    const bpInterface = new J.BroadPhaseLayerInterfaceTable(NUM_OBJECT_LAYERS, NUM_BROAD_PHASE_LAYERS)
    const bpNonMoving = new J.BroadPhaseLayer(LAYER_NON_MOVING)
    const bpMoving = new J.BroadPhaseLayer(LAYER_MOVING)
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, bpNonMoving)
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, bpMoving)
    J.destroy(bpNonMoving)
    J.destroy(bpMoving)
    settings.mObjectLayerPairFilter = objectFilter
    settings.mBroadPhaseLayerInterface = bpInterface
    settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(
      bpInterface,
      NUM_BROAD_PHASE_LAYERS,
      objectFilter,
      NUM_OBJECT_LAYERS,
    )
    // Cap the job system (multithreaded build only; the single-thread build ignores this).
    // Jolt's default is cores−1, which on big machines grabs 15 threads for a solver that
    // saturates well before that - and starves the render/main threads. cores−2 leaves them
    // room; 8 is the saturation ceiling for our body counts. Must stay ≤ the build's
    // PTHREAD_POOL_SIZE (runtime-sized to match in the fork) or thread spawn deadlocks the
    // blocked main thread. Determinism is thread-count-independent (mtDeterminism.test.ts).
    settings.mMaxWorkerThreads = Math.max(1, Math.min((globalThis.navigator?.hardwareConcurrency ?? 4) - 2, 8))
    this.joltInterface = new J.JoltInterface(settings)
    J.destroy(settings)
    this.system = this.joltInterface.GetPhysicsSystem()
    this.bodyInterface = this.system.GetBodyInterface()

    // Cargo dropped onto a deck settles into the penetration slop; Jolt's 0.02 m
    // default leaves boxes visibly sunk ~2 cm into the belt. Tighten it so cargo
    // rests near-flush - still well above the scale where the solver would jitter
    // resting/stacked contacts (validated by the 'rests flush and stacks stably' test).
    const physicsSettings = this.system.GetPhysicsSettings()
    physicsSettings.mPenetrationSlop = PENETRATION_SLOP
    if (benchRaw) physicsSettings.mAllowSleeping = false
    this.system.SetPhysicsSettings(physicsSettings)

    // the JS contact listener's temporaries, made here (before the world's own) so the Jolt allocations keep their
    // order; the facet table owns them from its construction below
    const surfaceVel = new J.Vec3(0, 0, 0)
    const angularVel = new J.Vec3(0, 0, 0)
    this.axisY = new J.Vec3(0, 1, 0)
    this.anyBroadPhaseLayer = new J.BroadPhaseLayerFilter()
    this.anyObjectLayer = new J.ObjectLayerFilter()
    this.kin = { pos: new J.RVec3(0, 0, 0), quat: new J.Quat(0, 0, 0, 1) }
    this.facets = new ConveyorFacets(J, this.system, surfaceVel, angularVel, { benchRaw, forceJsListener: opts.forceJsListener === true })
    this.bodies = new PartBodies(J, this.bodyInterface, this.axisY, this.facets)
    this.partGroups = this.bodies.groups
    // The run-time owners, wired to each other through the narrow parts they need. None makes a Jolt object as it
    // is constructed (the cargo snapshot and the pilot's capsule come on first use), so their order here is only
    // the order of their dependencies. The cargo list is the registry's to fill; the holds, sensors, rigs and flow
    // read it, and so does everything here (`boxes`).
    const boxes: LiveBox[] = []
    this.holds = new BodyHolds(J, this.bodyInterface, this.axisY, this.kin, boxes, this.partGroups, (id, pos, rot) => this.cargo.placeBody(id, pos, rot))
    this.pilot = new PilotCapsule(J, this.bodyInterface, this.axisY, this.kin)
    this.cargo = new CargoRegistry(J, this.system, this.bodyInterface, this.axisY, this.clock, this.hz, boxes, this.holds, this.partGroups)
    this.sensors = new SensorRegistry(this.cargo, boxes, this.holds, this.pilot, this.clock, this.hz)
    this.loadCells = new LoadCells(J, this.system, this.bodyInterface, this.cargo, boxes, this.holds, this.dt)
    this.rigDriver = new RigDriver(this.bodyInterface, this.kin, this.dt, boxes, this.cargo, this.holds, this.sensors, this.rigMsByPart)
    this.flow = new CargoFlow(this.cargo, boxes, this.holds, this.sensors, this.rigDriver.rigs, this.partGroups, this.cargo.dressings, this.clock, this.hz)
    this.flowFacts = opts.flowFacts === false ? null : new SimFlowFacts(scene.parts, this.cargo, boxes, this.holds, this.sensors, this.bus, this.clock, this.hz)
    this.boxes = boxes
    this.units = this.cargo.units
    this.dressings = this.cargo.dressings
    this.holders = this.holds.holders

    this.bodies.fitGround(groundHalfExtent(scene.parts, GROUND_SIZE / 2), GROUND_FRICTION)

    // The sim runs in a worker with its own module state, so the scene's embedded custom-part packages
    // must be registered here for the 'part' builder to resolve them (the main-thread registry that
    // feeds rendering is a separate instance). Idempotent replace, so re-registering on rebuild is fine.
    registerScenePackages(scene.packages)
    this.sceneParts = scene.parts
    // the tracker finds conveyors through the registry, which in a fresh worker is empty until the line above: read
    // the parts again now, or the first run's facts name no conveyor at all (a drop reads as "over no conveyor")
    this.flowFacts?.tracker.setParts(scene.parts)

    // a part whose build throws fails the whole world; free what was made here, since the worker that catches the
    // error outlives the run and never sees this object
    try {
      const resolved = resolveScene(scene.parts, 'sim')
      for (const part of scene.parts)
        this.buildPart(part, resolved.get(part.id))
    } catch (e) {
      this.dispose()
      throw e
    }

    this.system.OptimizeBroadPhase()
  }

  /** build the physics bodies for one part, registering them under its id */
  private buildPart(part: PartInstance, ctx?: ResolvedContext): void {
    const sigKey = simResolvedKey(part.id, ctx)
    const group: PartGroup = {
      signature: partSignature(part, sigKey),
      sigPart: part,
      sigKey,
      sigRev: partPackageRev(part),
      bodies: [],
      conveyorKeys: [],
      boxIds: [],
    }
    // a (re)build starts this part's runtime diagnostics fresh - anything still wrong re-reports
    clearPartDiagnostics(part.id)
    this.bodies.begin(part.id, group)
    // track any speed-bearing part's commanded speed so a spawner can interlock against it
    // ("pause when conveyor stopped"). Rewritten on every rebuild, incl. PLC speed edits.
    // the speed param is the one the conveyor declares (conveyor.speedParam) - this seed only covers the window
    // before the behavior's first tick overwrites it with the live commanded speed.
    const speedKey = conveyorSpeedParams(part).speed
    const speedParam = speedKey ? (part.params as Record<string, unknown>)[speedKey] : undefined
    if (typeof speedParam === 'number') this.bus.setConveyorSpeed(part.id, speedParam)
    // the bus and the rig list only append, so what this build attaches is what lands past these marks
    const behaviorsFrom = this.bus.behaviors.length
    const rigsFrom = this.rigDriver.rigs.length
    const fileAttached = (): void => {
      if (this.bus.behaviors.length > behaviorsFrom) group.behaviors = this.bus.behaviors.slice(behaviorsFrom)
      if (this.rigDriver.rigs.length > rigsFrom) group.rigs = this.rigDriver.rigs.slice(rigsFrom)
    }
    try {
      // dispatch table mirrors render/parts/registry.ts; types with no physics
      // bodies (sensors, controls, manipulators, floor_marking, group) have no
      // entry and fall through as a no-op.
      const builder = SimWorld.partBuilders.get(part.type)
      builder?.(this, part, { ctx })
      fileAttached()
    } catch (e) {
      if (!(e instanceof BodyTableFull)) throw e
      fileAttached()
      this.bodies.end()
      // take down what the part had built, then file it bodiless under the same signature: it builds again on its
      // next edit or the next run, not on every scene update while the world stays full
      this.destroyPart(part.id)
      this.bodies.begin(part.id, { signature: group.signature, sigPart: group.sigPart, sigKey: group.sigKey, sigRev: group.sigRev, bodies: [], conveyorKeys: [], boxIds: [] })
      reportPartDiagnostic({ source: 'build', partId: part.id, message: 'the physics world holds as many bodies as it can, so this part was built without collision. Stop clears the cargo that filled it.' })
    } finally {
      this.bodies.end()
    }
  }

  step(): void {
    const t0 = performance.now()
    const boxesIn = this.boxes.length
    this.cargo.beginStep()
    if (this.flow.seedDue) this.flow.seedAuthoredUnits(this.sceneParts)
    // Cull cargo that has fallen off the world (SDK sinks remove in-zone cargo via CargoFlow.fulfillDespawns).
    // Heights come from the batched pose snapshot when the forked build provides one - one WASM
    // crossing for every body, shared with beams via the step snapshot (CargoRegistry.stepSnapshot) - instead of two
    // getters per box. Downward iteration keeps row i aligned with boxes[i] across removals, and a
    // removal bumps boxesRev so any later consumer re-snapshots rather than reading shifted rows.
    const cargo = this.cargo
    const boxes = this.boxes
    const cullSnap = cargo.stepSnapshot()
    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i]
      if (!box) continue
      const y = cullSnap ? (cullSnap[i * 7 + 1] as number) : box.body.GetPosition().GetY()
      if (y < CULL_Y) {
        if (this.flowFacts) {
          const p = box.body.GetPosition()
          this.flowFacts.culled(box, p.GetX(), y, p.GetZ())
        }
        cargo.removeBox(i)
      }
    }
    const t1 = performance.now()
    this.tickBehaviors()
    const t2 = performance.now()
    // flow facts read the rows as the behaviors just sensed them (the same snapshot) and the beams they were handed
    this.flowFacts?.step()
    const tf = this.flowFacts ? performance.now() : t2
    this.holds.drive()
    this.pilot.drive(this.dt)
    this.rigDriver.drive(this.perfParts)
    const t3 = performance.now()
    for (const b of this.called) this.facets.syncPart(b) // only a called part drove an entry; the solver reads the table next
    const t4 = performance.now()
    this.joltInterface.Step(this.dt, 1)
    const p = this.phaseMs
    p.cull += t1 - t0
    p.behaviors += t2 - t1
    p.flow += tf - t2
    p.drives += t3 - tf
    p.facets += t4 - t3
    const t5 = performance.now()
    p.solver += t5 - t4
    const ms = t5 - t0
    if (ms > STEP_BUDGET_MS) this.overBudgetSteps++
    const w = this.worstStep
    if (ms > w.ms) {
      w.ms = ms
      w.step = this.clock.step
      w.boxes = boxesIn
      w.cull = t1 - t0
      w.behaviors = t2 - t1
      w.drives = t3 - t2
      w.facets = t4 - t3
      w.solver = t5 - t4
    }
    this.cargo.endStep()
    this.clock.step++
  }

  // Run each attached custom-part script and fold its surface-velocity output into the live conveyor
  // entry, before the physics Step so cargo is dragged this tick. Event-cheap: a handful of parts, a
  // flat JSON in/out per part - dwarfed by the solver. simTime/dt are sim time (deterministic).
  private readonly called: BehaviorRecord[] = [] // this tick: every `step` part, and the `react` parts with a reason
  private tickBehaviors(): void {
    const bus = this.bus
    const behaviors = bus.behaviors
    if (behaviors.length === 0) return
    // a film web lasts one tick: a wrapper that is still wrapping asks for it again below (fulfillWraps)
    for (const m of this.dressings.values()) for (const d of m.values()) if (d.web) delete d.web
    const dt = this.dt
    const simTime = this.clock.step / this.hz
    // the PLC→part half of the device-IO bus: the latest ST tag values, the same flat (global) map for every
    // behavior; a behavior reads the tag names it knows from its params.
    const tags = bus.tags
    const driven = bus.driven // (output ownership: set between steps, never inside one)
    // the conveying decks that went stopped→running this tick: a box that slept on a stopped belt must be woken
    // or the surface velocity below never reaches it (see wakeCargoOn). Edge-triggered, so no work at steady state.
    const started: BehaviorRecord[] = []
    const startedDecks: Jolt.Body[] = [] // single decks of a zoned bed that started (see wasDeckConveying)
    // Snapshot every conveying part's commanded speed once, before the loop, so a spawner's interlock
    // (ctx.conveyorRunning) reads the same values regardless of behavior order - a deterministic 1-tick lag on
    // this tick's conveyor updates (which happen below), invisible at spawn cadences. undefined ⇒ no conveyors.
    const conveyorSpeeds = bus.speedSnapshot()
    const sensors = this.sensors
    this.called.length = 0
    for (const b of behaviors) {
      // C-sensing: cast this part's sensor beams against cargo and hand the nearest hits in as `input.beams`
      const emitters = b.partId ? sensors.beamsOf(b.partId) : undefined
      let beams: Record<string, FrameBeamHit> | undefined
      if (emitters) {
        const tb = this.perfParts ? performance.now() : 0
        // The record by link name is built again only on a step where a beam reads something new. Most beams
        // read the same on most steps, and on a line with 840 of them building every entry each step cost a third of
        // the time this loop spends outside the parts.
        const list = (b.beamList ??= [])
        const n = emitters.length
        let changed = b.beamHits === undefined || list.length !== n
        let hitBoxes: Record<string, LiveBox> | undefined
        for (let i = 0; i < n; i++) {
          const e = emitters[i]!
          const was = list[i]
          const now = sensors.castBeam(e.origin, e.dir, e.range, was)
          const hit = sensors.lastBeamHit.box
          if (hit) (hitBoxes ??= {})[e.name] = hit
          if (now !== was) {
            changed = true
            list[i] = now
          }
        }
        if (changed) {
          list.length = n
          beams = {}
          for (let i = 0; i < n; i++) beams[emitters[i]!.name] = list[i]!
        } else beams = b.beamHits
        b.beamHits = beams // captured for the frame - the view draws beams from this, never re-casting
        b.beamBoxes = hitBoxes // what ctx.markHit marks, so the mark lands on the body the part saw
        if (this.perfParts) this.phaseMs.beams += performance.now() - tb
      }
      const zoneList = b.partId ? sensors.zonesOf(b.partId) : undefined // C-despawn
      let zones: Record<string, number> | undefined
      let zoneAges: Record<string, number> | undefined
      let zoneMarks: Record<string, Record<string, number>> | undefined
      let zoneMix: Record<string, ZoneMix> | undefined
      if (zoneList) {
        const tz = this.perfParts ? performance.now() : 0
        zones = {}
        zoneAges = {}
        for (const z of zoneList) {
          zones[z.name] = sensors.countZone(z)
          zoneAges[z.name] = sensors.lastZoneAge
          if (sensors.lastZoneMarks) (zoneMarks ??= {})[z.name] = sensors.lastZoneMarks
          if (sensors.lastZoneMix) (zoneMix ??= {})[z.name] = sensors.lastZoneMix
        }
        if (this.perfParts) this.phaseMs.zones += performance.now() - tz
      }
      const used = b.partId ? bus.wasUsed(b.partId) : false // C-interaction: a click this tick
      // In-process hot path: hand a reused input struct straight to the behavior runtime - no per-tick JSON
      // round-trip and no per-tick object churn (the string `behavior.step` boundary stays for an
      // out-of-process/sandboxed host). Every field is overwritten each tick (so a value absent this tick -
      // e.g. beams - clears last tick's), and the runtime copies them into its own state, so sharing the
      // b.pos / tag-table references here is safe. `null` = bad handle / script threw this tick → skip,
      // leaving the last velocity/joints/rig pose in place.
      const inp = (b.input ??= { simTime, position: b.pos, forward: b.fwd })
      inp.simTime = simTime
      inp.position = b.pos
      inp.forward = b.fwd
      inp.tags = tags
      inp.driven = driven
      inp.beams = beams
      inp.zones = zones
      inp.zoneAges = zoneAges
      inp.zoneMarks = zoneMarks
      inp.zoneMix = zoneMix
      inp.weights = b.partId ? this.loadCells.readingsOf(b.partId) : undefined // ctx.weight
      inp.joints = b.measuredJoints
      inp.grips = b.heldGrips
      inp.gripWidths = b.heldWidths
      inp.used = used
      inp.conveyorSpeeds = conveyorSpeeds
      // A reactive part with nothing new to answer is not called, and its outputs stand (partSleep.ts)
      const sl = (b.sleep ??= newSleepState())
      if (waits(sl, inp, this.wakeAllParts)) continue
      this.called.push(b)
      const ts = this.perfParts ? performance.now() : 0
      const parsed = behavior.stepDirect(b.handle, inp, dt)
      if (this.perfParts) {
        const tsd = performance.now() - ts
        this.phaseMs.script += tsd
        const sk = b.partId ?? '#anon'
        this.scriptMsByPart.set(sk, (this.scriptMsByPart.get(sk) ?? 0) + tsd)
        if (tsd > this.worstScriptCall.ms) {
          this.worstScriptCall.ms = tsd
          this.worstScriptCall.partId = sk
          this.worstScriptCall.step = this.clock.step
        }
      }
      if (!parsed) {
        // a throwing step() would vanish here - report it (deduped: one entry, a bumped count) so the
        // author sees why the part froze at its last-good output instead of debugging a silent stall.
        const msg = behavior.error()
        if (msg) reportPartDiagnostic({ source: 'step', partId: b.partId ?? '', message: msg, simTime })
        continue
      }
      try {
        const sv = parsed.surfaceVelocity
        driveDeckEntries(b, parsed, sv) // C-convey (deckDrive.ts): every conveying deck, in place, arc over linear
        if (b.copyDecks) {
          // a copy whose belt starts wakes the cargo asleep on it, as a zone of an accumulating bed does
          for (const cd of b.copyDecks) {
            const speeds = parsed.copySpeeds?.[cd.link]
            for (let i = 0; i < cd.bodies.length; i++) {
              const on = (speeds?.[i] ?? 0) !== 0
              if (on && !cd.was[i]) startedDecks.push(cd.bodies[i]!)
              cd.was[i] = on
            }
          }
        }
        // stopped→running edge for this deck (linear speed = sv·forward, or arc omega): flag a cargo wake below.
        if (b.conveyorEntries || b.entry) {
          const conveying = parsed.arc ? parsed.arc.omega !== 0 : parsed.deckSpeed !== undefined ? (typeof parsed.deckSpeed === 'number' ? parsed.deckSpeed !== 0 : parsed.deckSpeed.some((v) => v !== 0)) : sv ? sv[0] * b.fwd[0] + sv[2] * b.fwd[2] !== 0 : false
          if (conveying && !b.wasConveying) started.push(b)
          b.wasConveying = conveying
          if (Array.isArray(parsed.deckSpeed) && b.deckBodies) {
            const was = (b.wasDeckConveying ??= [])
            const decks = b.deckBodies
            for (let i = 0; i < decks.length; i++) {
              const on = parsed.deckSpeed[i] !== undefined && parsed.deckSpeed[i] !== 0
              if (on && !was[i] && b.wasConveying) startedDecks.push(decks[i]!)
              was[i] = on
            }
          }
        }
        // live interlock speed: a spawner gating on this conveyor reads the behavior's commanded (PLC-gated /
        // reversed) forward speed, not just the saved param - so spawning pauses the moment a run tag stops the
        // belt, and resumes when it runs again. Only for conveying parts (a jointed rig commands no sv).
        // An arc-driving behavior (SDK curved conveyor) commands `arc.omega` (rad/s), not a linear sv; record
        // the signed omega as its speed (arc takes precedence over sv, mirroring the entry drive above): the interlock gate
        // only compares against 0, and omega is nonzero exactly while the curve runs.
        if (b.partId && (b.conveyorEntries || b.entry)) {
          // per-deck speeds (an accumulating bed): the part reads as running while its infeed deck (the first) runs
          const deckRun = parsed.deckSpeed === undefined ? undefined : typeof parsed.deckSpeed === 'number' ? parsed.deckSpeed : (parsed.deckSpeed[0] ?? 0)
          bus.setConveyorSpeed(b.partId, parsed.arc ? parsed.arc.omega : deckRun !== undefined ? deckRun : sv ? sv[0] * b.fwd[0] + sv[2] * b.fwd[2] : 0)
        }
        // capture commanded joints/grips/lamps/subPoses (rig) for parts tracked by id; frame() carries them to the view
        if (b.partId) {
          b.joints = parsed.joints ?? {}
          b.grips = parsed.grips ?? {}
          b.lamps = parsed.lamps ?? {}
          b.values = parsed.values ?? {}
          b.displays = parsed.displays ?? {}
          b.subPoses = parsed.subPoses ?? {}
          if (b.copyDecks) b.copySpeeds = parsed.copySpeeds ?? {}
        }
        // a behavior's tag writes are captured for any part (deck or rig): the part→PLC half of the bus.
        b.tags = parsed.tags ?? {}
        // C-spawn: fulfill cargo-spawn requests at the part's pose + (rotated) local offset
        if (parsed.spawns && parsed.spawns.length > 0) {
          const before = this.boxes.length
          this.flow.fulfillSpawns(b, parsed.spawns)
          if (this.flowFacts && b.partId) this.flowFacts.spawned(before, b.partId) // a fact about the box can name where it came from
        }
        // C-despawn: remove cargo in the requested zones (a sink)
        if (parsed.despawns && parsed.despawns.length > 0) this.flow.fulfillDespawns(b, parsed.despawns)
        // product state: mark / dress / join / split the cargo in a zone (ctx.mark etc.), in call order
        if (parsed.cargoOps && parsed.cargoOps.length > 0) this.flow.fulfillCargoOps(b, parsed.cargoOps)
        // C-drive: integrate the base velocity into the part's live root pose (b.pos/b.fwd), so its rig bodies
        // follow + the behavior reads the new pose next tick (ctx.position/forward). Marks the part mobile.
        if (parsed.drive) {
          const yaw = Math.atan2(-b.fwd[2], b.fwd[0]) + parsed.drive.turn * dt
          b.fwd = [Math.cos(yaw), 0, -Math.sin(yaw)]
          const v = parsed.drive.forward * dt
          b.pos = [b.pos[0] + b.fwd[0] * v, b.pos[1], b.pos[2] + b.fwd[2] * v]
          b.mobile = true
        }
        noteCall(sl, inp, parsed)
      } catch {
        // a script error already surfaced via behavior.error(); leave the last velocity/joints in place
      }
    }
    for (const b of started) this.wakeCargoOn(b)
    if (startedDecks.length) this.wakeCargoOnDecks(startedDecks)
    bus.clearUses() // each "use" pulses ctx.used() for exactly the tick after the click
  }

  /**
   * A deck just started: wake the cargo resting on it, so a box that slept on the stopped belt starts riding again
   * (a sleeping body gets no contact callbacks, so the deck's surface velocity can't reach it otherwise). Anything
   * stacked on that cargo wakes with it next step, as Jolt wakes a sleeping body an active one touches.
   *
   * Only the cargo on that deck: waking every cargo body in the scene has a cost. Each wake settles a resting
   * stack a little further into the penetration slop, so the demo's floor stock of empty pallets, woken at every
   * start, would ratchet down and lean until it fell through itself (palletStack.test.ts; bodyFactory.ts
   * buildPalletShape holds that stack up either way), and every sleeping pile would rejoin the solver on the tick
   * the line starts.
   */
  private wakeCargoOn(b: BehaviorRecord): void {
    this.wakeCargoOnDecks(b.deckBodies ?? (b.body ? [b.body] : []))
  }

  private wakeCargoOnDecks(decks: readonly Jolt.Body[]): void {
    const J = this.J
    const m = CARGO_WAKE_MARGIN
    for (const deck of decks) {
      // a copy of the deck's bounds (GetWorldSpaceBounds is a reference into the body), grown so cargo resting on
      // the top face, whose bounds only touch the deck's, is inside for certain
      const bounds = deck.GetWorldSpaceBounds()
      const lo = new J.Vec3(bounds.mMin.GetX() - m, bounds.mMin.GetY() - m, bounds.mMin.GetZ() - m)
      const hi = new J.Vec3(bounds.mMax.GetX() + m, bounds.mMax.GetY() + m, bounds.mMax.GetZ() + m)
      const box = new J.AABox(lo, hi)
      this.bodyInterface.ActivateBodiesInAABox(box, this.anyBroadPhaseLayer, this.anyObjectLayer)
      J.destroy(box)
      J.destroy(lo)
      J.destroy(hi)
    }
  }

  /** PLC→part: hold the latest ST tag values so the next tickBehaviors feeds them to behaviors as inputs.
   *  Value-diffed: a push that changes nothing keeps the current table object, which matters because
   *  behaviors hold tag tables by reference (embeddedBehavior ref-swaps cur/prev - replacing the object
   *  is the change signal). */
  setBehaviorInputTags(tags: Record<string, number | boolean>): void {
    this.bus.setInputTags(tags)
  }

  /** PLC→part from the links to PLCs outside the app (the main thread's setTags): a layer of its own beside the
   *  program's, so a run with both keeps both (sim/behaviorBus.ts). */
  setBehaviorLinkTags(tags: Record<string, number | boolean>): void {
    this.bus.setLinkTags(tags)
  }

  /** part→PLC: the tags behaviors wrote on the last step, flattened across parts - the in-worker
   *  PLC scan's %I source (PlcHost.interleave). Same order + last-wins as frame().tags, and the
   *  same partId gate, so the scan reads exactly what a main-thread controller would. */
  behaviorTagWrites(): Record<string, number | boolean> {
    return this.bus.tagWrites()
  }

  /** Output ownership: hold the global tag keys the attached controller drives (ctx.tagDriven). */
  setBehaviorDrivenTags(tags: string[]): void {
    this.bus.setDrivenTags(tags)
  }

  /** C-interaction: register a pilot-mode "use" on a custom interactive part; ctx.used() reads true next tick. */
  usePart(partId: string): void {
    this.bus.use(partId)
  }

  // C-convey: build a static conveyor body for each `conveys` (box) link of a rig - a powered deck whose top
  // carries cargo. The behavior's setSurfaceVelocity drives the (first) link's ConveyorEntry, so a belt's deck
  // conveys exactly like the deck-geometry path, but inside a rich rig (frame, guards, …).
  // Returns the deck bodies by link name.
  private attachRigConveyors(rec: BehaviorRecord, part: SdkPart, geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, scale: number, bodies: RigBody[], inclineRad = 0, behaviorSource?: string): Map<string, Jolt.Body> {
    const built = new Map<string, Jolt.Body>()
    // a box deck, or a frame with a collision box: a deck that draws nothing, its look attached from geometry()
    const decks = geo.links.filter((l) => l.conveys && (l.shape.kind === 'box' || (l.shape.kind === 'frame' && typeof l.collision === 'object')))
    if (decks.length === 0) return built
    const partQuat = qFromAxisAngle([0, 1, 0], part.rotationY)
    const rest = rigWorldPoses(geo, {}, undefined, scale, part.params as RigParams, inclineRad)
    // an inclined deck tilts about the rig root: the FK already lifted lp.pos + rolled lp.quat, so the static
    // box gets the full world orientation (partYaw ∘ link tilt) and the surface velocity gets the deck tangent
    // {cos, sin}; tickBehaviors then carries cargo up the grade (× commanded speed), same path as a tilted belt run.
    const tan = inclineRad !== 0 ? { x: Math.cos(inclineRad), y: Math.sin(inclineRad) } : undefined
    const friction = conveyorSurfaceFriction(part) // its friction param's grip, else its declared surface's
    const subPosed = subPosedLinkNames(behaviorSource)
    for (const link of decks) {
      const lp = rest.get(link.name)
      if (!lp) continue
      if (link.array?.posable) {
        // a posable conveying array (a cross-belt sorter's carriers): one kinematic deck per copy, each with its own
        // entry, posed by RigDriver.drive like any posable instance and run only by setSurfaceSpeed(speed, link, i)
        const he = linkHalfExtents(link, part.params as RigParams)
        const copies: NonNullable<BehaviorRecord['copyDecks']>[number] = { link: link.name, entries: [], bodies: [], was: [] }
        const dq = qMul(partQuat, lp.quat) // the row's world orientation
        const wp = qApply(partQuat, lp.pos)
        arrayInstanceDeltas(link.array, part.params as RigParams, undefined, link.showParam).forEach((delta, i) => {
          // built at its rest place in the row; the driver poses it from the first step
          const d = qApply(dq, delta)
          const body = this.bodies.addKinematicBoxQuat(he[0], he[1], he[2], [part.position[0] + wp[0] + d[0], part.position[1] + wp[1] + d[1], part.position[2] + wp[2] + d[2]], dq, friction)
          const entry: Extract<ConveyorEntry, { kind: 'linear' }> = { kind: 'linear', vx: 0, vy: 0, vz: 0 }
          this.bodies.registerConveyorBody(body, [entry], DECK_AXES)
          copies.entries.push(entry)
          copies.bodies.push(body)
          copies.was.push(false)
          bodies.push({ name: link.name, body, id: body.GetID(), instance: i, rest: delta })
        })
        ;(rec.copyDecks ??= []).push(copies)
        continue
      }
      const wp = qApply(partQuat, lp.pos)
      const he = linkHalfExtents(link, part.params as RigParams) // resolved box half-extents (C-paramgeo aware)
      const cx = part.position[0] + wp[0], cy = part.position[1] + wp[1], cz = part.position[2] + wp[2]
      const dq = qMul(partQuat, lp.quat) // world deck orientation: part yaw ∘ bed tilt
      // A deck whose link rides a joint (the chain transfer's `lift`) must physically move with it, not sit
      // static at rest height; otherwise the pop-up is cosmetic and cargo riding a higher surface (a host roller
      // bed, or fed above the deck) rolls straight over it. Build it kinematic and register it in the rig's
      // `bodies` so RigDriver.drive re-poses it each tick from FK: it then both lifts cargo (kinematic push) and
      // carries it (surface velocity). A plain (unjointed) belt/roller deck stays static: a moving body would
      // shove its cargo (buildRigBodies skips conveys links for exactly that reason).
      // ...and so must one the behavior poses with setSubPose, or a deck under a posed link (a shuttle's top)
      const jointDriven = linkMovesAtRuntime(geo, link.name, subPosed)
      // One body at the declared box. Conveying is scoped to the running surface by the facet axes
      // below, not by geometry: the listener drives only contacts on the deck's top face, and treats
      // a contact on a side as the wall it is. One body works because the listener can keep a
      // contact's collision and drop its conveying; with only accept-or-disable it would take a thin inset
      // slab in a proud plain housing: two bodies per deck, a 5 mm notch at every junction.
      // A deck whose link is turned in the part (a side belt standing on its edge, a deck tipped onto a slope or yawed
      // across the bed) is built at that turn, as a jointed one is: its running face is its local +Y wherever that
      // points. Built from the part's yaw alone, the turn was dropped without a word.
      const turned = Math.abs(lp.quat[0]) > 1e-9 || Math.abs(lp.quat[1]) > 1e-9 || Math.abs(lp.quat[2]) > 1e-9
      const body = jointDriven
        ? this.bodies.addKinematicBoxQuat(he[0], he[1], he[2], [cx, cy, cz], dq, friction)
        : tan || turned
          ? this.bodies.addStaticBoxQuat(he[0], he[1], he[2], cx, cy, cz, { x: dq[0], y: dq[1], z: dq[2], w: dq[3] }, friction)
          : this.bodies.addStaticBox(he[0], he[1], he[2], cx, cy, cz, part.rotationY, friction)
      const entry: ConveyorEntry = { kind: 'linear', vx: 0, vy: 0, vz: 0, ...(tan ? { tan } : {}) }
      // The box is axis-aligned within the body, so its running surface is local +Y and cargo runs
      // along local +X - the same convention the compound facets follow (runningSurfaceNormal).
      this.bodies.registerConveyorBody(body, [entry], DECK_AXES)
      // every conveying deck is driven each tick (linear or arc): a belt has one, a curved conveyor's fanned
      // segments many, all sharing the behavior's surface/arc command.
      ;(rec.conveyorEntries ??= []).push(entry)
      ;(rec.deckBodies ??= []).push(body)
      built.set(link.name, body)
      // a joint-driven deck is re-posed each tick by RigDriver.drive (the body centre is the link origin).
      if (jointDriven) bodies.push({ name: link.name, body, id: body.GetID() })
    }
    // Seed the interlock speed at 0 (stopped) so a spawner referencing this conveyor (ctx.conveyorRunning) holds
    // until the conveyor's behavior first commands a non-zero speed - a real-but-not-yet-ticked conveyor reads
    // "stopped", not "unknown" (which a dangling id reads). Overwritten each tick by tickBehaviors.
    this.bus.setConveyorSpeed(part.id, 0)
    return built
  }

  /** the new box's frame id, or -1 when the physics system has no room left for another body */
  spawnBoxAt(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    yaw = 0,
    mass = BOX_MASS,
    color: [number, number, number] = [1, 1, 1],
  ): number {
    // a box of its size, as a kind-only spawn is (core/frame.ts kindSpawnRef), so selecting it makes it that box
    const ref = kindSpawnRef(CARGO_KIND_BOX, [hx * 2, hy * 2, hz * 2])
    const own = { key: cargoRefKey(ref.packageId, ref.params), product: ref.packageId, params: ref.params as Record<string, ParamValue> }
    return this.cargo.createDynamicBox(x, y, z, hx, hy, hz, yaw, mass, BOX_FRICTION, CARGO_KIND_BOX, null, color, own)
  }

  /**
   * Attach a custom-part behavior script to a deck body. The script's `setSurfaceVelocity` output is
   * applied to a live conveyor entry each tick, so cargo resting on `body` is conveyed by whatever the
   * script computes. Returns false if the script failed to compile (see embeddedBehavior.error()).
   * This is the runtime seam for user-authored parts - the same contract runs in native via QuickJS.
   */
  attachBehavior(
    body: Jolt.Body,
    source: string,
    paramsJson: string,
    position: [number, number, number],
    forward: [number, number, number],
  ): boolean {
    return this.attachBehaviorRecord(body, source, paramsJson, position, forward, null) !== null
  }

  // Core attach: compile the script and wire it to a live conveyor entry on `body`. Returns the record
  // (so a keyed caller can track it) or null if the script failed to compile.
  private attachBehaviorRecord(
    body: Jolt.Body,
    source: string,
    paramsJson: string,
    position: [number, number, number],
    forward: [number, number, number],
    key: string | null,
  ): BehaviorRecord | null {
    const handle = behavior.create(source, paramsJson)
    if (handle <= 0) return null
    const entry: Extract<ConveyorEntry, { kind: 'linear' }> = { kind: 'linear', vx: 0, vy: 0, vz: 0 }
    // a spur prism / scripted flat deck: laid out in part-local space, so the shared deck axes apply
    this.bodies.registerConveyorBody(body, [entry], DECK_AXES)
    const rec = behaviorRecord(handle, position, forward, key, { entry, conveyorEntries: [entry], body })
    this.bus.add(rec)
    return rec
  }

  /**
   * Build a flat deck driven by a custom-part script: the simplest end-to-end use of the scripting path.
   * `position` is the deck-top centre; cargo resting on it is conveyed by the script's output. Returns
   * false if the script failed to compile.
   */
  spawnScriptedConveyor(
    position: [number, number, number],
    rotationY: number,
    length: number,
    width: number,
    source: string,
    paramsJson = '{}',
    friction = CONVEYOR_FRICTION,
  ): boolean {
    const [x, y, z] = position
    const hy = 0.05
    const body = this.bodies.addStaticBox(length / 2, hy, width / 2, x, y - hy, z, rotationY, friction)
    // the part's local +X (flow) axis rotated into world space about Y
    const forward: [number, number, number] = [Math.cos(rotationY), 0, -Math.sin(rotationY)]
    return this.attachBehavior(body, source, paramsJson, position, forward)
  }

  /**
   * Build a bent multi-segment belt deck driven by a custom-part script - the per-segment collision twin of
   * spawnScriptedConveyor for a `function`-geometry belt (geometry() builds the matching visual). One compound
   * conveyor body of run boxes + bend prisms (beltDeckSubsLocal), each facet carrying its own tangent; the
   * script's commanded surface velocity is distributed per-facet each tick (see tickBehaviors' `tan` branch),
   * so cargo rides up/over the inclines and a PLC run-gate actually stops it. Returns 'no-runs' when the
   * segments are degenerate (nothing was built, so the caller may build a flat deck instead) and 'script-failed'
   * when the deck was built but the script failed to compile (no fallback: it would add a second deck).
   */
  spawnScriptedBeltConveyor(
    position: [number, number, number],
    rotationY: number,
    segments: readonly BeltSegmentSpec[],
    height: number,
    width: number,
    source: string,
    paramsJson = '{}',
    friction = BELT_FRICTION,
  ): 'built' | 'no-runs' | 'script-failed' {
    const subs = beltDeckSubsLocal(segments, height, width)
    if (subs.length === 0) return 'no-runs'
    const [x, y, z] = position
    // a path bed's surface grip: the caller passes the part's declared surface (a belt, as the belt conveyor is)
    const body = this.bodies.addCompoundConveyor(subs, x, y, z, rotationY, friction)
    // (the deck only; the side-guard static walls are built by addSdkPart → addCustomBeltGuards, which also
    // folds in neighbour-derived openings - the one place guards are built on both the lone and clustered path.)
    const forward: [number, number, number] = [Math.cos(rotationY), 0, -Math.sin(rotationY)]
    const handle = behavior.create(source, paramsJson)
    if (handle <= 0) return 'script-failed'
    // the same entry objects addCompoundConveyor registered in the conveyors map - driving them per tick
    // mutates what the live contact listener reads (in place), exactly like a flat deck's single entry.
    const entries: ConveyorEntry[] = []
    const seen = new Set<ConveyorEntry>()
    for (const s of subs) if (s.entry && !seen.has(s.entry)) { seen.add(s.entry); entries.push(s.entry) }
    this.bus.add(behaviorRecord(handle, position, forward, null, { conveyorEntries: entries, body }))
    return 'built'
  }

  /**
   * Build a curved SDK conveyor's arc deck (chord-box facets + lead-in/out stubs, the same as the built-in
   * curved belt via conveyorDeckSubs) and attach its behavior - the arc analogue of spawnScriptedBeltConveyor.
   * The behavior re-drives the arc field each tick (setArcSurfaceVelocity), so cargo is carried around the sweep
   * and a PLC run-gate stops it. Returns false if there are no facets or the script failed to compile.
   */
  private spawnCurvedConveyor(part: SdkPart, pkg: PartPackage): boolean {
    const subs = conveyorDeckSubs(part)
    if (subs.length === 0) return false
    const [x, y, z] = part.position
    // its friction param's grip, else its declared surface's
    const friction = conveyorSurfaceFriction(part)
    const body = this.bodies.addCompoundConveyor(subs, x, y, z, part.rotationY, friction)
    const handle = behavior.create(pkg.behavior, JSON.stringify(part.params))
    if (handle <= 0) return false
    const forward: [number, number, number] = [Math.cos(part.rotationY), 0, -Math.sin(part.rotationY)]
    // drive the same entry objects addCompoundConveyor registered (in place), like the belt/flat-deck path
    const entries: ConveyorEntry[] = []
    const seen = new Set<ConveyorEntry>()
    for (const s of subs) if (s.entry && !seen.has(s.entry)) { seen.add(s.entry); entries.push(s.entry) }
    this.bus.add(behaviorRecord(handle, part.position, forward, null, { conveyorEntries: entries, body }))
    return true
  }

  /**
   * Instantiate a custom part from an imported package - the runtime side of the External-IDE+SDK
   * model. Builds the package's geometry/collision and attaches its behavior script. Returns false if
   * the geometry kind is unsupported or the behavior failed to compile.
   */
  spawnFromPackage(pkg: PartPackage, position: [number, number, number], rotationY: number, paramsJson = '{}'): boolean {
    if (pkg.geometry.kind === 'drawn' && pkg.geometry.conveys) {
      // a procedural (geometry()) conveying bed. A belt-shaped one declares a `path` handle on its segments
      // numberList: build the bent per-segment deck so cargo rides its inclines (spawnScriptedBeltConveyor).
      // Any other conveying function part gets a flat deck sized to its declared face-handle params, else the
      // baked bounds. Every geometry-driving param name comes from the package's own handle declarations
      // (pathHandleOfPkg / faceHandleOfPkg); the engine assumes none. Read each value as the instance
      // override, else the package's baked schema default (a belt left at its default segments must still
      // build its bent deck, not silently fall back to flat).
      const overrides = JSON.parse(paramsJson) as Record<string, unknown>
      const resolved = (k: string | undefined): unknown => (k === undefined ? undefined : overrides[k] !== undefined ? overrides[k] : pkg.params[k]?.default)
      const path = pathHandleOfPkg(pkg)
      const face = faceHandleOfPkg(pkg)
      const wv = resolved(path?.widthKey ?? face.widthKey)
      const wid = typeof wv === 'number' && wv > 0 ? wv : pkg.geometry.bounds.width
      const segs = path ? parseBeltSegments(resolved(path.key)) : null
      if (segs && path) {
        const hv = resolved(path.heightKey)
        const height = typeof hv === 'number' && hv > 0 ? hv : pkg.geometry.bounds.top
        const belt = this.spawnScriptedBeltConveyor(position, rotationY, segs, height, wid, pkg.behavior, paramsJson, packageSurfaceFriction(pkg, overrides))
        // only a belt that built nothing falls back to the flat deck; a failed script already has its bent deck
        if (belt !== 'no-runs') return belt === 'built'
      }
      const lv = resolved(face.lengthKey)
      const len = typeof lv === 'number' && lv > 0 ? lv : pkg.geometry.bounds.length
      // the flat fallback still serves belt-bedded parts (the SDK spur belt has no segments): its friction param's
      // grip, else its declared surface's
      const friction = packageSurfaceFriction(pkg, overrides)
      return this.spawnScriptedConveyor(position, rotationY, len, wid, pkg.behavior, paramsJson, friction)
    }
    return false
  }

  /**
   * Scene builder for a `part` instance (registered in partBuilders): resolve its package from the registry
   * and spawn the scripted deck so it conveys cargo on Play - driving the same thin behavior surface as
   * the desktop authoring loop. An unresolved package (not embedded/registered) is skipped; the part
   * still renders as a fallback deck (createCustomVisual), it just won't simulate. Keyed hot-reload of
   * live scene instances is a later phase; this is anonymous like the other scene builders.
   */
  private addSdkPart(part: SdkPart, cluster?: DeckCluster, openings?: GuardOpenings, extents?: GuardExtents, structConn?: StructureConnections, guardRun?: GuardRun): void {
    const pkg = getPackage(part.packageId)
    if (!pkg) {
      // The render resolves packages on the main thread, so the part still draws. Without this report a conveyor
      // with no package here looks normal and cargo falls through it.
      reportPartDiagnostic({ source: 'build', partId: part.id, packageId: part.packageId, message: `the sim was not given part package "${part.packageId}", so this part has no collision or behavior` })
      return
    }
    if (isCargoPackage(pkg)) {
      // C-cargo: the part is dynamic cargo (a box, pallet or tote, or a rig with its own body, core/cargoBody.ts), one dynamic body through the same pipeline as the built-in
      // box/pallet (frame → instanced batch render, gizmo grab/freeze, pilot carry). No behavior attach:
      // cargo is passive payload (its step is empty by convention).
      const view = cargoView(part)
      if (view) {
        const [px, py, pz] = part.position
        const friction = view.body?.friction ?? cargoFriction(view.kind)
        const own = view.body
          ? { key: view.body.key, pieces: view.body.pieces, product: part.packageId, params: view.body.params }
          : { key: cargoRefKey(part.packageId, part.params), product: part.packageId, params: part.params as Record<string, ParamValue> }
        const id = this.createDynamicBox(px, py, pz, view.halfExtents[0], view.halfExtents[1], view.halfExtents[2], partQuat(part), view.mass, friction, view.kind, true, part.id, hexToRgb(view.color), own, view.caps)
        // a product starts the run carrying its authored attributes, as its marks
        const born = id >= 0 ? this.boxes[this.boxes.length - 1] : undefined
        if (born) born.product = part.packageId
        if (born && Object.keys(view.attributeTypes).length) {
          born.attrTypes = view.attributeTypes
          if (Object.keys(view.attributes).length) born.marks = { ...view.attributes }
        }
      }
      return
    }
    if (pkg.unit) {
      // a unit load that stacks itself (core/frame unitPieces): its pallet and cases, as cargo bodies of its own, filed
      // on its part group so a rebuild or a delete takes them with it. Seeded (joined, dressed, marked) at the next step.
      for (const piece of unitPieces(this.sceneParts, part)) {
        const view = cargoView(piece)
        if (!view) continue
        const [px, py, pz] = piece.position
        const friction = view.body?.friction ?? cargoFriction(view.kind)
        const own =
          piece.type !== 'part'
            ? undefined
            : view.body
              ? { key: view.body.key, pieces: view.body.pieces, product: piece.packageId, params: view.body.params }
              : { key: cargoRefKey(piece.packageId, piece.params), product: piece.packageId, params: piece.params as Record<string, ParamValue> }
        const id = this.createDynamicBox(px, py, pz, view.halfExtents[0], view.halfExtents[1], view.halfExtents[2], partQuat(piece), view.mass, friction, view.kind, true, null, hexToRgb(view.color), own, view.caps)
        const born = id >= 0 ? this.boxes[this.boxes.length - 1] : undefined
        if (born) {
          born.ownerId = part.id
          if (piece.type === 'part') born.product = piece.packageId
        }
      }
      this.flow.noteUnitRebuilt(part.id)
    }
    if (pkg.geometry.kind === 'drawn' && pkg.geometry.conveys) {
      const bed = bedOf(part)
      if (bed?.kind === 'path' && cluster && cluster.members.length > 1) {
        // Clustered belt (butted end-to-end with another conveyor): the merged deck + this member's conveying
        // behavior are built by the cluster owner (addConveyorDeck: order-independent, attaches every custom
        // member). It rides one compound so Jolt's edge removal spans the seam (no cargo snag). Guards stay per-part
        // (they don't merge), so build this member's here (with any neighbour openings).
        this.addConveyorDeck(part, cluster)
        this.addCustomBeltGuards(part, openings, extents, guardRun)
        return
      }
      if (bed?.kind === 'arc') {
        // a curve: build the arc chord + stub deck (curvedDeckSubs, via conveyorDeckSubs) and attach its behavior,
        // so it both collides and carries cargo around the sweep (setArcSurfaceVelocity each tick). The flat-deck
        // fallback in spawnFromPackage would put a straight box at the origin, missing the arc.
        if (this.spawnCurvedConveyor(part, pkg)) {
          const rec = this.bus.last()
          if (rec) rec.partId = part.id
        } else this.reportAttachFailure(part)
        // the arc's inner/outer guard walls (+ tangent stubs)
        this.addCustomCurvedGuards(part, guardRun)
        return
      }
      if (bed?.kind === 'spur') {
        // a spur: build the parallelogram hull deck. The flat length×width fallback box misses the splay overhang
        // past ±length/2, so cargo crossing the angled discharge/infeed face would fall off a bed that looks solid.
        // Guards go through the general static-box channel with the host's snap extents folded in, so a merged
        // junction's guard colliders reach the host wall like the visual.
        if (this.spawnSdkSpurConveyor(part, pkg, bed.view.spur)) {
          const rec = this.bus.last()
          if (rec) rec.partId = part.id
        } else this.reportAttachFailure(part)
        this.addFunctionStaticColliders(part, pkg, { extents, openings, guardRun })
        return
      }
      // any other drawn conveying bed (a lone belt, a drawn straight, a deck with no declared bed): a conveying
      // body + behavior; tag the just-pushed record with the part id so any joint output is routed to its visual
      // (decks/beds emit none, harmless).
      if (this.spawnFromPackage(pkg, part.position, part.rotationY, JSON.stringify(part.params))) {
        const rec = this.bus.last()
        if (rec) rec.partId = part.id
      } else this.reportAttachFailure(part)
      // a belt gets its path-aware side guards here (one place for both the lone + clustered path). Anything else
      // gets the general AABB-box channel for its collision:'box' guards: the same coarse static colliders a
      // non-conveying function part gets, so cargo can't leave its bed.
      if (bed?.kind === 'path') this.addCustomBeltGuards(part, openings, extents, guardRun)
      else this.addFunctionStaticColliders(part, pkg, { openings })
    } else if (pkg.geometry.kind === 'drawn') {
      // a non-conveying function part: realize its declared solids, collision:'box' submeshes as AABB
      // boxes, collision:'hull' ones as convex hulls (the general collision channel; a conveying belt
      // instead gets the finer path-aware guard walls in spawnFromPackage). Neither declared ⇒ inert.
      this.addFunctionStaticColliders(part, pkg)
    } else if (pkg.geometry.kind === 'rig') {
      // rig: a joint-emitting behavior + a kinematic collision body per link. tickBehaviors captures the
      // joints, RigDriver.drive runs FK (shared with the renderer) and MoveKinematic's each body so the
      // links both push cargo and animate the visual identically.
      const rec = this.attachJointBehavior(part.id, pkg.behavior, JSON.stringify(part.params), part.position, part.rotationY, rigJointsJson(pkg.geometry), posableArraysJson(pkg.geometry))
      if (!rec) this.reportAttachFailure(part)
      if (rec) {
        // The bodies are built from the default-resolved params, as the renderer draws the links (rig.ts refresh): a
        // part saved without a size param collides at its default, where it is drawn, not at the link's static
        // size. The driver keeps this object for the run; an edit replaces the part and rebuilds it.
        const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
        const resolved = { ...part, params } as SdkPart
        // per-instance cut geometry: a platform with a snapped stair opens its railing + carves its deck; a
        // top-connected stair retracts its top handrail. Colliders build from the same cut links the renderer
        // rebuilds its meshes from (structureCutGeo), so the physical footprint can't drift from the visual.
        const geo = structConn ? structureCutGeo(pkg.geometry, part.id, params, structConn) : pkg.geometry
        const scale = typeof params.scale === 'number' && params.scale > 0 ? params.scale : 1
        const inclineRad = rigInclineRad(geo, params)
        const bodies = this.buildRigBodies(geo, part.position, part.rotationY, scale, params as RigParams, pkg.params, inclineRad, openings, extents, guardRun)
        for (const link of geo.links) {
          const capped = pitchCapMessage(link, params as RigParams)
          if (capped) reportPartDiagnostic({ source: 'geometry', partId: part.id, packageId: pkg.id, message: capped })
        }
        this.rigDriver.add({ rec, geo, pkg, pos: part.position, rotationY: part.rotationY, scale, params: params as RigParams, inclineRad, bodies, grips: new Map(), emptied: new Set() })
        this.sensors.collectBeams(resolved, geo, scale, params)
        this.sensors.collectZones(resolved, geo, scale)
        const decks = this.attachRigConveyors(rec, resolved, geo, scale, bodies, inclineRad, pkg.behavior)
        const cells: { name: string; body: Jolt.Body; he: Vec3 }[] = []
        for (const link of geo.links) {
          if (!link.loadCell) continue
          const body = decks.get(link.name) ?? bodies.find((rb) => rb.name === link.name)?.body
          if (body) cells.push({ name: link.name, body, he: linkHalfExtents(link, params as RigParams) })
        }
        this.loadCells.set(part.id, cells)
      }
    }
  }

  /** A part whose behavior failed to attach: surface the runtime's error (a compile/eval failure) as a
   *  part diagnostic instead of letting the part silently sit inert. `error()` reads empty when the
   *  failure wasn't the script (e.g. degenerate geometry) - then there's nothing to report. */
  private reportAttachFailure(part: SdkPart): void {
    const msg = behavior.error()
    if (msg) reportPartDiagnostic({ source: 'compile', partId: part.id, packageId: part.packageId, message: msg })
  }

  /** Attach a clustered SDK belt's behavior to the merged-deck entries it owns inside `body`, so a belt that
   *  butts another conveyor still conveys + PLC-gates, driving its own facets within the shared compound. */
  private attachClusterBeltBehavior(part: SdkPart, entries: ConveyorEntry[], body: Jolt.Body): void {
    const pkg = getPackage(part.packageId)
    if (!pkg) return
    const handle = behavior.create(pkg.behavior, JSON.stringify(part.params))
    if (handle <= 0) {
      this.reportAttachFailure(part)
      return
    }
    const fwd: [number, number, number] = [Math.cos(part.rotationY), 0, -Math.sin(part.rotationY)]
    this.bus.add(behaviorRecord(handle, part.position, fwd, null, { conveyorEntries: entries, body, partId: part.id }))
  }

  /** Static side-guard walls for a belt-like custom part, resolved from its package params - used on the
   *  clustered build path, where spawnScriptedBeltConveyor (which normally builds them) is bypassed. */
  private addCustomBeltGuards(part: SdkPart, neighbor?: GuardOpenings, extents?: GuardExtents, guardRun?: GuardRun): void {
    const pkg = getPackage(part.packageId)
    if (!pkg) return
    // Walls (with the neighbour openings + this part's own snap extents already folded in, and collinear
    // chords already collapsed) come from beltGuardWalls - the same enumeration guardRuns.ts reads, so a
    // merge decision keyed by wall applies to the wall the resolver meant.
    for (const w of beltGuardWalls(part, pkg, neighbor, extents)) {
      // Merged run: this wall butts a collinear neighbour's, so the run's owner emits one box covering both
      // and every other member emits nothing. Two bodies meeting at the seam would ram cargo riding the
      // wall, because enhanced internal edge removal does not span separate bodies.
      const override = guardRun?.walls[w.key]
      const spans = override ?? [[-w.halfLen, w.halfLen] as [number, number]]
      for (const [lo, hi] of spans) {
        if (hi - lo <= 1e-4) continue
        // span midpoint along the wall's own local +X, rotated into world by the wall's orientation
        const mid = (lo + hi) / 2
        const d = qApply(w.quat, [mid, 0, 0])
        this.bodies.addStaticBoxQuat((hi - lo) / 2, w.hy, w.hz, w.pos[0] + d[0], w.pos[1] + d[1], w.pos[2] + d[2], { x: w.quat[0], y: w.quat[1], z: w.quat[2], w: w.quat[3] }, 0)
      }
    }
  }

  /** Static inner/outer side-guard walls for an SDK curved conveying part (curved belt/roller): the collision
   *  twin of the built-in addCurvedSideGuards, but driven by the arc bed's view
   *  instead of a built-in part type, so cargo can't leave the band. Self-gates out for a non-curved part (the
   *  belt path builds those). SDK arc convention: P(t) = (r·cos t, 0, −r·sin t), the box yaw = t + π/2. */
  private addCustomCurvedGuards(part: SdkPart, guardRun?: GuardRun): void {
    // Walls come from core/guards/curvedGuards.ts, the same enumeration guardRuns.ts reads, so a merge decision
    // keyed by wall applies to the box the resolver meant. Only the straight tangent stubs can ever merge (the
    // arc chords turn, and sameWall's parallel test drops them), which is what a butted straight meets.
    for (const w of curvedGuardWalls(part)) {
      const override = guardRun?.walls[w.key]
      const spans = override ?? [[-w.halfLen, w.halfLen] as [number, number]]
      for (const [lo, hi] of spans) {
        if (hi - lo <= 1e-4) continue
        const d = qApply(w.quat, [(lo + hi) / 2, 0, 0])
        this.bodies.addStaticBoxQuat((hi - lo) / 2, w.hy, w.hz, w.pos[0] + d[0], w.pos[1] + d[1], w.pos[2] + d[2], { x: w.quat[0], y: w.quat[1], z: w.quat[2], w: w.quat[3] }, 0)
      }
    }
  }
  /** Build an SDK spur's parallelogram hull deck (the centre-origin twin of addSpurConveyor's) and attach its
   *  behavior, so the splay overhang past ±length/2 is real conveying deck, not air, and cargo rides the
   *  sheared bed across the merge. A declared belt surface grips like the built-in spur belt (BELT_FRICTION). */
  private spawnSdkSpurConveyor(part: SdkPart, pkg: PartPackage, view: SpurConveyorView): boolean {
    const friction = conveyorSurfaceFriction(part)
    const [px, py, pz] = part.position
    const corners = sdkSpurCorners(view)
    // One prism. The sheared bed's flanks wall rather than convey because the facet declares its
    // running surface (below), not because the geometry hides them: the listener keeps a contact's
    // collision while dropping its conveying, so no narrowed conveying prism over a full-width plain
    // twin is needed.
    const prism = (): { x: number; y: number; z: number }[] => {
      const pts: { x: number; y: number; z: number }[] = []
      for (const c of corners) for (const y of [0, -CONVEYOR_BODY_THICKNESS]) pts.push({ x: c.x, y, z: c.z })
      return pts
    }
    const body = this.bodies.addStaticHull(prism(), px, py, pz, part.rotationY, friction)
    const forward: [number, number, number] = [Math.cos(part.rotationY), 0, -Math.sin(part.rotationY)]
    return this.attachBehavior(body, pkg.behavior, JSON.stringify(part.params), part.position, forward)
  }

  /** Realize a `function`-geometry part's declared solids - the general collision channel. Each
   *  collision:'box' submesh becomes a static AABB box (the submesh's local AABB, yaw-placed at the part
   *  pose); each collision:'hull' one becomes a convex hull (addFunctionStaticHulls), the channel for a
   *  solid whose AABB would be a lie. Used both for a non-conveying function part and for a conveying one that
   *  isn't belt-like/curved (the spur's side guards), where the path-aware guard builders don't apply. The box
   *  channel is coarse for a very non-boxy solid, but a real wall, and the only one a guard merge can span.
   *  `extents` (snap extents) and `openings` (as `guardGaps`) are folded into the params first, so a merged
   *  mover's guard colliders reach the host wall plane exactly like its rendered rails/guards (a spur extends to
   *  it, a flush straight/belt retracts to it), and a diverter's gap is open in the collider too. Each fold is a
   *  no-op for a part that does not declare its param. */
  private addFunctionStaticColliders(part: SdkPart, pkg: PartPackage, facts: { extents?: GuardExtents; openings?: GuardOpenings; guardRun?: GuardRun } = {}): void {
    const { extents, openings, guardRun } = facts
    this.addFunctionStaticHulls(part, pkg)
    // walls come from the shared enumeration guardRuns.ts also reads, so a merge override keyed by wall
    // applies to the box the resolver meant (core/guards/functionGuards.ts)
    for (const w of functionStaticWalls(part, pkg, extents, openings)) {
      // Merged run: a sideGuard box butting a collinear neighbour's guard (a spur butted to a roller) is
      // emitted once by the run's owner covering both, and skipped by every other member. Two bodies meeting
      // at the seam would ram cargo riding the wall.
      const override = guardRun?.walls[w.key]
      const spans = override ?? [[-w.hx, w.hx] as [number, number]]
      for (const [lo, hi] of spans) {
        if (hi - lo <= 1e-4) continue
        // span midpoint along the box's own local +X, then the whole local offset rotated into world
        const r = rotateXZ(w.localCx + (lo + hi) / 2, w.localCz, part.rotationY)
        this.bodies.addStaticBox((hi - lo) / 2, w.hy, w.hz, part.position[0] + r.x, part.position[1] + w.localCy, part.position[2] + r.z, part.rotationY, w.friction ?? 0)
      }
    }
  }

  /** Realize each `collision: 'hull'` submesh of a `function`-geometry part as a static convex hull at the
   *  part pose: the channel for a solid an AABB would misrepresent (a round pillar, a wedge/ramp). The hull points
   *  are the submesh's own vertices, so the collider is the visible surface; addStaticHull composes them with the
   *  part's position + yaw exactly like the box channel. Unlike guards these never merge across parts, so there
   *  is no run/override to consult. Friction is the submesh's declared surface (MeshPart.friction: a slide chute's
   *  plate), else the building shell's - a hulled solid is scenery cargo bumps into or slides down, not a guard rail
   *  it should skate along frictionlessly. */
  private addFunctionStaticHulls(part: SdkPart, pkg: PartPackage): void {
    for (const h of functionStaticHulls(part, pkg)) {
      this.bodies.addStaticHull(h.points, part.position[0], part.position[1], part.position[2], part.rotationY, h.friction ?? BUILDING_FRICTION)
    }
  }

  /** Attach a joint-only rig behavior (no deck body/conveyor entry), tracked by part id for the frame. */
  private attachJointBehavior(partId: string, source: string, paramsJson: string, position: [number, number, number], rotationY: number, jointsJson?: string, arraysJson?: string): BehaviorRecord | null {
    const handle = behavior.create(source, paramsJson, jointsJson, arraysJson)
    if (handle <= 0) return null
    const rec = behaviorRecord(handle, position, [Math.cos(rotationY), 0, -Math.sin(rotationY)], null, { partId, joints: {} })
    this.bus.add(rec)
    return rec
  }

  // One kinematic box (LAYER_MOVING) per link at its rest world pose (rigBuild buildRigBodies), made by this
  // world's own constructors so each body is filed in the part group being built.
  private buildRigBodies(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, pos: [number, number, number], rotationY: number, scale = 1, params: RigParams = {}, paramSpecs?: PartPackage['params'], inclineRad = 0, openings?: GuardOpenings, extents?: GuardExtents, guardRun?: GuardRun): RigBody[] {
    const sink: RigBodySink = {
      kinematicBoxQuat: (hx, hy, hz, p, q, friction) => this.bodies.addKinematicBoxQuat(hx, hy, hz, p, q, friction),
      staticBox: (hx, hy, hz, x, y, z, rotY, friction) => this.bodies.addStaticBox(hx, hy, hz, x, y, z, rotY, friction),
      registerConveyor: (body, entries) => this.bodies.registerConveyorBody(body, entries),
    }
    return buildRigBodies(sink, geo, pos, rotationY, scale, params, paramSpecs, inclineRad, openings, extents, guardRun)
  }

  frame(): BoxFrame {
    // one WASM call for all pos+quats, kept as the next step's snapshot (frameSnapshot); null = stock-build fallback,
    // read per box in buildFrame
    return buildFrame(this.boxes, this.cargo.frameSnapshot(), this.bus.behaviors, this.units, this.dressings, this.conveyorSpeeds, this.clock.step / this.hz, this.cargo.shapeRefs)
  }

  /** each cargo row's marks (ctx.mark, markHit, product attributes), index-aligned with frame(); null for a row with
   *  none. The frame carries marks only for authored parts, and a test's `marked` filter reads spawned cargo too */
  cargoMarks(): (Readonly<Record<string, number | boolean | string>> | null)[] {
    return this.boxes.map((b) => marksOf(b))
  }

  /** What each cargo body touches, by frame id (cargoContacts.ts). For a test run's snapshots only: it runs a
   *  collision query per body. */
  cargoContacts(): Map<number, string[]> {
    return cargoContacts(this.J, { system: this.system, boxes: this.boxes, groups: this.bodies.groups, ground: this.bodies.ground })
  }

  /** Each cargo row's frame id and linear velocity in m/s (x, y, z), index-aligned with frame(). A unit load's pieces
   *  read the load's body, so a piece on a spinning load shows the load's centre velocity. */
  cargoVelocities(): { ids: Uint32Array; velocities: Float32Array } {
    const ids = new Uint32Array(this.boxes.length)
    const velocities = new Float32Array(this.boxes.length * 3)
    for (const [i, b] of this.boxes.entries()) {
      const v = b.body.GetLinearVelocity()
      ids[i] = b.id
      velocities[i * 3] = v.GetX()
      velocities[i * 3 + 1] = v.GetY()
      velocities[i * 3 + 2] = v.GetZ()
    }
    return { ids, velocities }
  }

  /** cumulative stepDirect cost split from the behavior runtime - merged into StepStats.phases
   *  (scriptTags/scriptSetup/scriptBody, subsets of phases.script) for the perf probes */
  scriptPerf(): { scriptTags: number; scriptSetup: number; scriptBody: number } {
    return behavior.perfStats()
  }

  /** Live body counts for perf probes (worker frame step-stats): total bodies incl. statics, and awake
   *  rigid bodies - plus how many behavior scripts and rigs the per-step loops actually iterate, so a
   *  probe can turn the phase totals into per-part costs. */
  bodyStats(): { bodies: number; active: number; behaviorCount: number; rigCount: number } {
    return {
      bodies: this.system.GetNumBodies(),
      active: this.system.GetNumActiveBodies(this.J.EBodyType_RigidBody),
      behaviorCount: this.bus.behaviors.length,
      rigCount: this.rigDriver.rigs.length,
    }
  }

  /** Aggregate twin measurements derived from the deterministic sim state. See core/simCore.ts. */
  measurements(): Measurements {
    const simSeconds = this.clock.step / this.hz
    const spawnedTotal = this.cargo.spawnedTotal
    const perMin = (n: number): number => (simSeconds > 0 ? (n / simSeconds) * 60 : 0)
    return {
      simSeconds,
      spawnedTotal,
      completedTotal: this.flow.completed,
      liveCount: this.boxes.length,
      throughputPerMin: perMin(this.flow.completed),
      spawnThroughputPerMin: perMin(spawnedTotal),
      avgCycleSeconds: this.flow.completed > 0 ? this.flow.cycleSeconds / this.flow.completed : 0,
    }
  }

  /**
   * Reconcile the running world with an edited scene: rebuild only the parts
   * that were added, removed, or changed, leaving spawned boxes (and untouched
   * parts) in place so the simulation keeps flowing while you edit.
   */
  updateScene(scene: SceneJSON, syncPackages = false): void {
    if (this.disposed) return
    // Part hot-reload (running-sim half): a package was edited (HMR / authoring), so refresh the worker's
    // registry from the scene's embedded packages - the caller embedded fresh registry copies. registerPackage
    // only bumps a package's rev when its content actually changed, and partSignature folds that rev in, so
    // the changed package's parts (and only those) rebuild through the ordinary reconcile below. Gated by
    // `syncPackages` because ordinary live edits stream stale embedded snapshots (per drag frame) that are
    // not worth content-diffing - and must never overwrite a hot-reloaded package with an older copy.
    if (syncPackages) registerScenePackages(scene.packages)
    // A live edit can introduce a package the worker was never told about, e.g. dragging the first box
    // into a scene that had no cargo (so oip.box was never embedded at Play). Register any such new id
    // (register-if-absent) so addSdkPart can resolve it and build the body; without this the part silently
    // fails to spawn and a dragged-in cargo box renders invisible. Never replaces a known package, so it's
    // safe on every ordinary update (the syncPackages path above owns hot-reload replacement).
    else registerNewScenePackages(scene.packages)
    this.sceneParts = scene.parts
    this.flowFacts?.tracker.setParts(scene.parts)
    const incoming = new Set(scene.parts.map((p) => p.id))
    const resolved = resolveScene(scene.parts, 'sim')
    let structural = false
    for (const id of [...this.partGroups.keys()]) {
      if (!incoming.has(id)) {
        this.destroyPart(id)
        structural = true
      }
    }
    for (const part of scene.parts) {
      const group = this.partGroups.get(part.id)
      const ctx = resolved.get(part.id)
      if (!group) {
        this.buildPart(part, ctx)
        structural = true
      } else if (this.isLiveCargo(part, group)) {
        // an authored/promoted box or pallet already has a dynamic body whose
        // transform is owned by physics; never rebuild it from the (stale) authored
        // pose mid-run, or an edit elsewhere would teleport a box that's mid-flight
        continue
      } else {
        const sigKey = simResolvedKey(part.id, ctx)
        const sigRev = partPackageRev(part)
        // the same part object (a patched update keeps untouched parts' identity), neighbours and package
        // rev as last time cannot have a different signature - skip the stringify
        if (group.sigPart === part && group.sigKey === sigKey && group.sigRev === sigRev) continue
        if (group.signature !== partSignature(part, sigKey)) {
          // signature mismatch (pose/params/neighbours/stair-cut - or a custom part's package rev) → rebuild
          this.destroyPart(part.id)
          this.buildPart(part, ctx)
          structural = true
        } else {
          group.sigPart = part
          group.sigKey = sigKey
          group.sigRev = sigRev
        }
      }
    }
    // a building grown, moved or added mid-run takes the floor with it
    if (this.bodies.fitGround(groundHalfExtent(scene.parts, GROUND_SIZE / 2), GROUND_FRICTION)) structural = true
    // a static body that moved out from under a sleeping box won't wake it on its
    // own; keep cargo responsive so it follows the geometry being edited
    if (structural) {
      for (const box of this.boxes) this.bodyInterface.ActivateBody(box.body.GetID())
    }
  }

  /** The flow facts added or updated since the last call (the worker ships them on each frame; protocol.ts). A fact
   *  that is still unfolding (a stall) comes again under its id when it ends. */
  drainFlowFacts(): FlowFact[] {
    return this.flowFacts?.tracker.drain() ?? []
  }

  /** Every flow fact of this run so far, and how many were not kept past the cap. `finish` closes what is still going
   *  (a stall), as the end of a run does: call it once, when nothing will step again. */
  flowFactsOf(opts?: { finish?: boolean }): { facts: readonly FlowFact[]; overflow: number } {
    if (!this.flowFacts) return { facts: [], overflow: 0 }
    if (opts?.finish) this.flowFacts.finish()
    return { facts: this.flowFacts.facts(), overflow: this.flowFacts.tracker.overflow }
  }

  /** @internal test hook: remove cargo row `index` (CargoRegistry.removeBox) */
  private removeBox(index: number): void {
    this.cargo.removeBox(index)
  }

  /** @internal test hook: take a unit load apart (CargoRegistry.splitUnit) */
  private splitUnit(unit: UnitLoad): void {
    this.cargo.splitUnit(unit)
  }

  private isLiveCargo(part: PartInstance, group: PartGroup): boolean {
    // built-in box/pallet or a C-cargo custom part - one recognizer (core/frame cargoView)
    return cargoView(part) !== null && group.boxIds.length > 0
  }

  /**
   * Teleport a cargo part's live body (gizmo grab while running). Position only by
   * default so a moved box keeps its tumble; pass a rotation quaternion to also set
   * its full orientation (the editor composes it from the part's YXZ rotations, so
   * tilt rings work on live cargo). Velocity is zeroed so the grabbed body stays
   * put instead of flinging away.
   */
  moveBody(partId: string, position: [number, number, number], rotation: [number, number, number, number] | null): void {
    if (this.disposed) return
    const group = this.partGroups.get(partId)
    if (!group) return
    const J = this.J
    const pos = new J.RVec3(position[0], position[1], position[2])
    const zero = new J.Vec3(0, 0, 0)
    for (const boxId of group.boxIds) {
      const box = this.boxes.find((b) => b.id === boxId)
      if (!box) continue
      if (box.unit) this.cargo.splitUnit(box.unit) // a hand moving one piece takes the load apart
      const id = box.body.GetID()
      if (rotation === null) {
        this.cargo.placeBody(id, pos, null)
      } else {
        const rot = new J.Quat(rotation[0], rotation[1], rotation[2], rotation[3])
        this.cargo.placeBody(id, pos, rot)
        J.destroy(rot)
      }
      this.bodyInterface.SetLinearAndAngularVelocity(id, zero, zero)
    }
    J.destroy(pos)
    J.destroy(zero)
  }

  /**
   * Freeze/unfreeze a cargo part's live body for a gizmo grab. Frozen, it goes
   * kinematic so gravity and conveyor contacts can't fight the drag; released, it
   * returns to dynamic and settles from where it was placed. Velocity is zeroed
   * both ways so it neither drifts while held nor keeps stale momentum on release.
   * A pin is a holder like any other (BodyHolds.claim): pinning a box a robot carries takes it out of the gripper,
   * and unpinning releases only a pin - a body something else holds is left to it.
   */
  freezeBody(partId: string, frozen: boolean): void {
    if (this.disposed) return
    const group = this.partGroups.get(partId)
    if (!group) return
    for (const boxId of [...group.boxIds]) {
      const box = this.boxes.find((b) => b.id === boxId)
      if (!box) continue
      const pinned = this.holders.get(boxId)?.kind === 'pin'
      if (frozen && !pinned && box.unit) this.cargo.splitUnit(box.unit) // pinning one piece takes the load apart
      if (frozen && !pinned) this.holds.claim(box, { kind: 'pin' })
      else if (!frozen && pinned) this.holds.drop(boxId)
    }
  }

  /**
   * Pin/unpin one live cargo body by its body id (a project test's `jam` fault): the same `pin` holder
   * {@link freezeBody} uses, so the body goes kinematic where it stands and everything behind it backs up against
   * it for real. Unlike freezeBody it reaches spawned boxes too, which have no part id. A unit load is pinned whole,
   * as a jammed pallet would be. Pinning refuses a body something already holds (a gripper, the pilot, a pin) -
   * held cargo is not loose on a conveyor to jam - and unpinning releases only a pin. Returns whether it acted.
   */
  pinBody(bodyId: number, pinned: boolean): boolean {
    if (this.disposed) return false
    const box = this.boxes.find((b) => b.id === bodyId)
    if (!box) return false
    const holder = this.holders.get(bodyId)
    if (pinned) {
      if (holder) return false
      this.holds.claim(box, { kind: 'pin' })
      return true
    }
    if (holder?.kind !== 'pin') return false
    this.holds.drop(bodyId)
    return true
  }

  /**
   * Pilot carry: hold/release a cargo part. Unlike the gizmo grab (which goes
   * kinematic + teleports), the held body stays *dynamic* with gravity off and is
   * velocity-driven toward the hold point in {@link driveHeldBodies} - so a
   * conveyor, guard, or wall under the hold point stops it instead of it
   * teleporting through. Released, gravity returns and it drops from where it sits.
   * The pick-up takes the body from whoever held it (BodyHolds.claim) - off an AGV's forks, out of a robot's
   * gripper, off a pin - so the pilot is never left steering a body another holder keeps teleporting.
   */
  holdBody(partId: string, held: boolean): void {
    if (this.disposed) return
    const group = this.partGroups.get(partId)
    if (!group) return
    if (!held) {
      this.holds.dropPilotPart(partId)
      return
    }
    for (const boxId of [...group.boxIds]) {
      const box = this.boxes.find((b) => b.id === boxId)
      if (box?.unit) this.cargo.splitUnit(box.unit) // picking one piece up takes the load apart
      if (box && this.holders.get(boxId)?.kind !== 'pilot') this.holds.claim(box, { kind: 'pilot', partId })
    }
    // seed the target at the body's current pose so it doesn't lurch before the
    // first setHoldTarget arrives
    const box = this.boxes.find((b) => b.id === group.boxIds[0])
    const p = box?.body.GetPosition()
    if (p) this.holds.holdTarget(partId, p.GetX(), p.GetY(), p.GetZ())
    else this.holds.holdTarget(partId, 0, 0, 0)
  }

  /** update where a pilot-held part should chase to (its hold point in front of the camera) */
  setHoldTarget(partId: string, position: [number, number, number], rotationY: number): void {
    this.holds.setHoldTarget(partId, position, rotationY)
  }

  /**
   * Track the walking pilot with a kinematic capsule so the player's body can
   * shove cargo. `position` is the pilot's feet (null when the pilot leaves: tear
   * the body down). The capsule is created at the first position so it doesn't
   * sweep in from the origin and fling everything in its path; thereafter
   * PilotCapsule.drive eases it to the latest target each step.
   */
  setPilotBody(position: [number, number, number] | null): void {
    if (this.disposed) return
    this.pilot.set(position)
  }

  /**
   * Manipulator grip: take a live body (by its frame body id) kinematic so a
   * gripper can carry it. Transient spawner bodies stay transient (no scene
   * part), so a live edit's updateScene leaves them be - no scene pollution,
   * unlike the pilot carry. Refuses a body something already holds, like a rig
   * gripper's own search does.
   */
  grabBody(bodyId: number): void {
    if (this.disposed || this.holders.has(bodyId)) return
    const box = this.boxes.find((b) => b.id === bodyId)
    if (box?.unit) this.cargo.splitUnit(box.unit) // a bare grab by body id takes one piece: the load comes apart
    if (box) this.holds.claim(box, { kind: 'grip', rig: null, gripper: '' })
  }

  /** set a grabbed body's full kinematic pose (gripper transform) each step */
  setGrabbedPose(bodyId: number, position: [number, number, number], quat: [number, number, number, number]): void {
    if (this.disposed) return
    this.holds.setGrabbedPose(bodyId, position, quat)
  }

  /** release a grabbed body back to dynamic (gravity takes over from where it sits); only a grip - a body the
   *  pilot or a pin holds is theirs to release */
  releaseBody(bodyId: number): void {
    if (this.disposed || this.holders.get(bodyId)?.kind !== 'grip') return
    this.holds.letGo(bodyId)
  }

  /** bind an existing live body to a newly-authored part so updateScene leaves it be */
  adopt(bodyId: number, partId: string): void {
    if (this.disposed) return
    const box = this.boxes.find((b) => b.id === bodyId)
    if (!box) return
    box.partId = partId
    this.bodies.adoptBox(partId, bodyId)
  }

  private destroyPart(id: string): void {
    const group = this.partGroups.get(id)
    if (!group) return
    // its grippers let go first: a body still held by a removed rig stays kinematic and can't be grabbed again
    for (const rig of group.rigs ?? []) this.holds.releaseRig(rig)
    this.bodies.destroyBodies(group)
    // its scripts stop with it: a stale one would keep writing its old PLC tags
    if (group.behaviors) this.bus.remove(group.behaviors)
    if (group.rigs) this.rigDriver.remove(group.rigs)
    this.sensors.forget(id)
    this.bus.deleteConveyorSpeed(id) // a speed-bearing part no longer exists to interlock against
    this.loadCells.set(id, []) // its platforms' bodies are gone
    this.holds.forgetPart(id)
    for (const boxId of [...group.boxIds]) {
      const i = this.boxes.findIndex((b) => b.id === boxId)
      if (i >= 0) this.cargo.removeBox(i)
    }
    this.bodies.forget(id)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const J = this.J
    this.cargo.removeAll()
    this.pilot.remove()
    this.bodies.destroyAll()
    this.facets.clear()
    this.bus.destroyAll()
    this.rigDriver.clear() // bodies are torn down via their part group; just drop the stale refs
    this.sensors.clear()
    this.loadCells.clear()
    this.loadCells.dispose()
    J.destroy(this.joltInterface)
    this.facets.dispose()
    this.cargo.dispose()
    J.destroy(this.axisY)
    J.destroy(this.anyBroadPhaseLayer)
    J.destroy(this.anyObjectLayer)
    J.destroy(this.kin.pos)
    J.destroy(this.kin.quat)
  }

  /**
   * Build a conveyor's running-surface body. Belts/rollers/curves butted
   * end-to-end (a `cluster` of >1 member) merge their decks into one compound,
   * built once by the cluster owner with every member's facets lifted to world
   * space (worldSub) - so Jolt's enhanced internal edge removal spans the seams
   * between the otherwise-separate bodies and cargo can't pop/snag crossing them.
   * A lone conveyor (or a non-owner member) builds just its own deck at its pose.
   */
  private addConveyorDeck(part: PartInstance, cluster?: DeckCluster): void {
    if (cluster && cluster.members.length > 1) {
      if (part.id !== cluster.ownerId) return
      const subs: ConveyorSubShape[] = []
      // a behavior-driven (SDK) belt member carries zero-velocity `tan` facets the host drives each tick; keep
      // each such member's entries so the owner can attach its script to drive them inside the merged body.
      const customMembers: { part: SdkPart; entries: ConveyorEntry[] }[] = []
      // members that grip differently stamp their own friction on their facets; one body has one friction
      const frictions = cluster.members.map(conveyorSurfaceFriction)
      const mixed = frictions.some((f) => f !== frictions[0])
      cluster.members.forEach((m, i) => {
        const memberSubs = conveyorDeckSubs(m).map((s) => worldSub(s, m))
        if (mixed) for (const s of memberSubs) if (s.entry) s.entry.friction = frictions[i]
        for (const s of memberSubs) subs.push(s)
        if (m.type === 'part') {
          const entries: ConveyorEntry[] = []
          const seen = new Set<ConveyorEntry>()
          for (const s of memberSubs) if (s.entry && !seen.has(s.entry)) { seen.add(s.entry); entries.push(s.entry) }
          if (entries.length > 0) customMembers.push({ part: m as SdkPart, entries })
        }
      })
      if (subs.length === 0) return
      const body = this.bodies.addCompoundConveyor(subs, 0, 0, 0, 0, deckFriction(cluster.members))
      // the owner attaches every custom member's behavior (a non-owner member skips this branch entirely), so
      // each SDK belt in the cluster still conveys/PLC-gates - driving its own facets inside the shared compound.
      for (const cm of customMembers) this.attachClusterBeltBehavior(cm.part, cm.entries, body)
      return
    }
    const subs = conveyorDeckSubs(part)
    if (subs.length > 0) {
      const [px, py, pz] = part.position
      this.bodies.addCompoundConveyor(subs, px, py, pz, part.rotationY, deckFriction([part]))
    }
  }

  /** four static perimeter walls + the interior column grid; visibility booleans are viewing aids only */
  private addBuilding(part: BuildingPart): void {
    for (const b of buildingBoxes(part)) this.bodies.addStaticBox(b.hx, b.hy, b.hz, b.x, b.y, b.z, part.rotationY, BUILDING_FRICTION)
  }

  private createDynamicBox(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    rotation: number | [number, number, number, number], // yaw, or a full orientation quat (tilted authored cargo)
    mass: number,
    friction: number,
    kind: number,
    cargoPart: boolean,
    partId: string | null,
    color: [number, number, number] = [1, 1, 1],
    own?: { key: string; pieces?: readonly CargoPiece[]; product: string; params: Readonly<Record<string, ParamValue>> },
    caps?: number,
  ): number {
    const id = this.cargo.createDynamicBox(x, y, z, hx, hy, hz, rotation, mass, friction, kind, partId, color, own, caps)
    if (id < 0) return -1
    if (cargoPart) this.bodies.fileBox(id)
    return id
  }
}
