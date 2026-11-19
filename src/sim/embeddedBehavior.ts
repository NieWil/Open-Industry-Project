// Flat, FFI-friendly façade over the custom-part behavior runtime - the behavior twin of
// embeddedPlc.ts. A host (the browser sim worker, locked down so part code compiles inside an SES
// Compartment: docs/part-sandbox.md) evaluates this bundle once, then drives user part scripts through strings +
// numbers only. No objects cross the boundary and no host APIs (Date.now / Math.random / window /
// fetch) are used, so the same part script runs across both shipping surfaces (browser + Electron) and
// runs deterministically inside the fixed-timestep SimCore (see src/core/simCore.ts, src/core/parts/partApi.ts).
// The string-only boundary serves the determinism discipline (docs/custom-part-capability-surface.md)
// and the sandbox's copy-in / validate-out rule (docs/part-sandbox.md).
//
// Boundary (everything a host needs):
//   create(source, paramsJson[, jointsJson[, arraysJson]]) -> handle (>0), or 0 on error (see error()); jointsJson = the
//                                  rig's joints (RigJoint[]): the instance runs the motion of those with a `servo`,
//                                  and a part that declares `robot` drives them through its controller;
//                                  arraysJson = its posable array links (PosableArraySpec[]), what ctx.arrayCount reads
//   meta(handle)                -> JSON {param: {type, default, ...}} - drives the Inspector
//   step(handle, inputJson, dt) -> JSON {surfaceVelocity:[x,y,z], tags:{name:bool}, joints:{name:number}, grips:{name:bool}, lamps:{name:bool}, subPoses:{link:{position?,rotation?,instances?}}}
//   destroy(handle)             -> void
//   error()                     -> last error message (and clears it)
//
// input JSON: {simTime:number, position:[x,y,z], forward:[x,y,z], tags:{name:bool}, joints:{name:number}}
//   joints = host-applied (clamped) joint pose from the previous tick - closed-loop feedback for ctx.measured.joints

import { createGeometryBuilder } from '../core/geometry/geometryBuilder'
import { canonicalMeshParts } from '../core/geometry/geometryEval'
import { hostCopy } from '../core/hostCopy'
import { canonicalAddress } from '../core/io/iecAddress'
import { instantiatePartScript, resolvePartParams } from '../core/parts/partScript'
import { Rng } from '../core/rng'
import { arrayInstanceDeltas, copyGripName, jointLimits, type PosableArraySpec, type RigParams, type SubPose } from '../core/rig/rigPose'
import type { RigJoint } from '../core/parts/partPackage'
import { createRobot, robotDeclOf, type RobotDecl } from '../core/robot/robotController'
import { robotToolParts } from '../core/robot/robotTools'
import {
  axisCommandAborted, axisCommandDone, axisCommandQueued, axisFollow, axisHalt, axisHome, axisInPosition, axisMoveAbsolute, axisMoveRelative, axisMoveVelocity,
  axisPosition, axisPower, axisReleaseStop, axisReset, axisStop, createAxis, stepAxis, type Axis, type ModuloDirection,
} from '../core/motionAxis'
import type { ZoneMix, ZoneTally } from '../core/frame'
import type { GeometryContext, ParamSchema, ParamsOf, ParamValue, PartContext, PartDefinition, Servo, SnapSpec, UnitLoadDecl, Vec3 } from '../core/parts/partApi'

// the runtime's writable view of the context the script sees as readonly
type MutableContext = { -readonly [K in keyof PartContext]: PartContext[K] }

interface Instance {
  def: PartDefinition
  ctx: MutableContext
  /** init() is still owed: it runs at the start of the first step, not in create() - see create() */
  needsInit: boolean
  /** the part asked to be called on the next step (ctx.again) */
  again: { v: boolean }
  /** the part read a conveyor's speed this step: one that did not is not called for a speed changing (partSleep.ts) */
  readSpeeds: { v: boolean }
  out: {
    sv: [number, number, number]
    tags: Record<string, TagVal>
    joints: Record<string, number>
    grips: Record<string, boolean>
    lamps: Record<string, boolean>
    values: Record<string, TagVal>
    displays: Record<string, number | boolean | string>
    subPoses: Record<string, SubPose>
    spawns: SpawnReq[]
    despawns: string[]
    cargo: CargoOp[]
    drive: { forward: number; turn: number } | null
    arc: { cx: number; cz: number; omega: number } | null
    deckSpeed: number | number[] | null
    copySpeeds: Record<string, number[]> | null
  }
  /** host tag tables held by reference (never copied): cur = this tick's, prev = last tick's (backs
   *  ctx.rising/falling), driven = the controller's output-ownership set. Safe to share because hosts
   *  replace a table object when its values change (never mutate one in place) and the ctx closures only
   *  read elements, so a script can never reach the objects. stepDirect pointer-swaps these each tick. */
  tags: { cur: Record<string, TagVal>; prev: Record<string, TagVal>; driven: Record<string, TagVal> }
  /** host-applied (clamped) joint state from the previous tick, read by ctx.measured.joints (closed-loop feedback) */
  measuredJoints: Record<string, number>
  /** host gripper held-state from the previous tick (true = actually carrying cargo), read by ctx.measured.grips */
  measuredGrips: Record<string, boolean>
  /** this tick's sensing tables, held by reference like `tags` and pointer-swapped each tick (clearing with
   *  `delete` and refilling would be the largest cost of a sensing part's call). Safe for the
   *  same reasons: the host builds fresh tables every tick, and the ctx accessors return copies or numbers, so a
   *  script never reaches the objects. beams = beam hits by name; zones = cargo count per detection zone
   *  (C-despawn); zoneAges = summed cargo age per zone (ctx.zoneAge); zoneMarks = per zone, how many cargo
   *  bodies in it carry each truthy mark (ctx.marked); zoneMix = per zone, its count and age by product and by kind
   *  (ctx.zone's filter); weights = kg on each load-cell link (ctx.weight). */
  sensed: { beams: Record<string, BeamHit>; zones: Record<string, number>; zoneAges: Record<string, number>; zoneMarks: Record<string, Record<string, number>>; zoneMix: Record<string, ZoneMix>; weights: Record<string, number> }
  /** holder so step() can set the per-tick "used" flag that ctx.used() (a create-time closure) reads */
  inUsed: { used: boolean }
  /** holder for the scene's live conveyor speeds (partId → commanded speed), so ctx.conveyorRunning(id) - the
   *  spawner interlock - reads whether a referenced conveyor is running. Reference-swapped each tick (not copied). */
  inConveyorSpeeds: { v: Record<string, number> }
  /** the rig's servo axes by joint name: commanded through ctx.servos, stepped after step(), posing their joints */
  servos: Map<string, Axis>
  /** this tick's held-load reach per gripper (StepInput.gripWidths), for the robot controller */
  heldWidths: { v: Record<string, number> | undefined }
}

/** A PLC tag value crossing the behavior boundary: BOOL or a number (INT/REAL). */
type TagVal = number | boolean

/** A sensor beam's nearest-cargo result for this tick (C-sensing), handed in by the host. */
type BeamHit = { hit: boolean; distance: number; color: [number, number, number]; marks?: Readonly<Record<string, CargoMark>> }
const CLEAR_BEAM: BeamHit = { hit: false, distance: 0, color: [0, 0, 0] }
const EMPTY_SPEEDS: Record<string, number> = {} // shared empty conveyor-speed map (scene has no conveyors this tick)
// Cap on a published display string. A display crosses the worker boundary every tick it changes, so an
// unbounded string is a per-tick postMessage cost a part could set arbitrarily high; a panel field that
// needs more than this has outgrown a readout.
const MAX_DISPLAY_CHARS = 64
const EMPTY_TAGS: Record<string, TagVal> = {} // shared empty tag table (host sent none this tick)
// shared empty sensing tables (host sent none this tick); frozen, since every instance holds the same ones
const NO_BEAMS: Record<string, BeamHit> = Object.freeze({})
const NO_COUNTS: Record<string, number> = Object.freeze({})
const NO_MARKS: Record<string, Record<string, number>> = Object.freeze({})
const NO_MIX: Record<string, ZoneMix> = Object.freeze({})

/**
 * The key a behavior's tag name is stored under. A direct address (`%qx100.0`, core/io/iecAddress.ts) is one
 * I/O point in any spelling, and the tag tables hold its canonical one, so a part whose tag was typed in
 * lower case still meets the PLC. Checked here, at every read and write, because not every way a tag
 * enters a scene goes through the scene's normalisation. Cached: a part reads the same few names every tick.
 */
const addressKeys = new Map<string, string>()
function tagKey(name: string): string {
  if (name.charCodeAt(0) !== 37 /* % */) return name
  let key = addressKeys.get(name)
  if (key === undefined) {
    key = canonicalAddress(name) ?? name
    if (addressKeys.size < 4096) addressKeys.set(name, key)
  }
  return key
}

/** A cargo-spawn request this tick (C-spawn); the host fulfills it after step(). */
type SpawnReq = { part?: string; params?: Record<string, number | boolean | string>; kind?: 'box' | 'pallet' | 'tote'; size?: [number, number, number]; color?: [number, number, number]; mass?: number; offset?: [number, number, number]; marks?: Record<string, CargoMark> }
/** one ctx.wrap request: stretch-wrap the load in `zone` up to `upTo` m above the part origin */
/** a mark a machine leaves on cargo (ctx.mark) */
type CargoMark = number | boolean | string
/** One product-state request (ctx.mark / dress / join / split), applied by the host in call order after the tick. */
export type CargoOp =
  | { op: 'mark'; zone: string; key: string; value: CargoMark }
  | { op: 'markHit'; beam: string; key: string; value: CargoMark }
  | { op: 'dress'; zone: string; id: string; material: string; opacity?: number; upTo?: number; web?: { link: string; offset: [number, number, number]; height: number } }
  | { op: 'join'; zone: string }
const MAX_SPAWNS_PER_TICK = 8 // a buggy behavior can't flood the world in one tick
// Values a part hands to ctx are read once into locals and validated there. Checking a field and then reading it
// again lets a getter (or a Proxy, or the part's own `.every`) pass the check and hand back NaN or an object on the
// second read, straight into Jolt or the frame (docs/part-sandbox.md).
const finiteOrUndef = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** the first three entries of `v`, each read once, when all are finite numbers */
function readVec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v)) return null
  const a = finiteOrUndef(v[0])
  const b = finiteOrUndef(v[1])
  const c = finiteOrUndef(v[2])
  return a === undefined || b === undefined || c === undefined ? null : [a, b, c]
}
/** the first four entries of `v` as a unit quaternion, each read once, when all are finite and not all zero */
function readQuat(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v)) return null
  const q = [finiteOrUndef(v[0]), finiteOrUndef(v[1]), finiteOrUndef(v[2]), finiteOrUndef(v[3])]
  if (q.some((c) => c === undefined)) return null
  const [x, y, z, w] = q as number[]
  const len = Math.hypot(x!, y!, z!, w!)
  return len > 1e-9 ? [x! / len, y! / len, z! / len, w! / len] : null
}
/** The servo axes of a rig's servo joints, limits resolved against this instance's params, each starting at its
 *  joint's rest value (clamped into its limits). Bad entries are skipped: validatePart reports them. */
/** Each posable array link's instance count for these params: the count the sim builds its instance bodies to. */
function buildArrayCounts(arraysJson: string | undefined, params: Record<string, ParamValue>): Map<string, number> {
  const counts = new Map<string, number>()
  if (!arraysJson) return counts
  for (const a of JSON.parse(arraysJson) as PosableArraySpec[]) counts.set(a.name, arrayInstanceDeltas(a.array, params as RigParams, undefined, a.showParam).length)
  return counts
}

/** The rig's joints from create()'s jointsJson, or none. */
function rigJointsOf(jointsJson: string | undefined): RigJoint[] {
  if (!jointsJson) return []
  const joints = JSON.parse(jointsJson) as RigJoint[]
  return Array.isArray(joints) ? joints : []
}

function buildServos(joints: readonly RigJoint[], params: Record<string, ParamValue>): Map<string, Axis> {
  const servos = new Map<string, Axis>()
  for (const j of joints) {
    const sv = j?.servo
    if (!sv || typeof j.name !== 'string' || !Number.isFinite(j.min) || !Number.isFinite(j.max)) continue
    const [lo, hi] = jointLimits(j, params as RigParams)
    let rest = 0
    if (j.rest) {
      const p = params[j.rest.param]
      if (typeof p === 'number') rest = p * (j.rest.scale ?? 1) + (j.rest.add ?? 0)
    }
    const at = sv.modulo ? rest : Math.min(Math.max(rest, lo), hi)
    servos.set(j.name, createAxis({ min: lo, max: hi, maxVelocity: sv.maxVelocity, maxAccel: sv.maxAccel, maxDecel: sv.maxDecel, modulo: sv.modulo }, at))
  }
  return servos
}

const DIRECTIONS: readonly ModuloDirection[] = ['shortest', 'positive', 'negative', 'current']

/** The handle part code drives one servo through. Every argument is read once into a local and checked there
 *  (a getter or Proxy must not pass the check and then hand the kernel something else: docs/part-sandbox.md);
 *  a non-number reaches the kernel as NaN, which it refuses. */
function servoHandle(ax: Axis): Servo {
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)
  const optNum = (v: unknown): number | undefined => (v === undefined ? undefined : num(v))
  const move = (m: unknown) => {
    const o = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>
    const velocity = num(o.velocity)
    const accel = optNum(o.accel)
    const decel = optNum(o.decel)
    const buffered = o.buffered === true
    const d = o.direction
    return { dyn: { velocity, accel, decel, buffered }, direction: (DIRECTIONS as readonly unknown[]).includes(d) ? (d as ModuloDirection) : 'shortest' }
  }
  return Object.freeze({
    get position() { return axisPosition(ax) },
    get velocity() { return ax.v },
    get state() { return ax.state },
    get powered() { return ax.powered },
    get homed() { return ax.homed },
    get error() { return ax.error },
    get inPosition() { return axisInPosition(ax) },
    power: (on: boolean) => axisPower(ax, on === true),
    moveAbsolute: (position: number, m: unknown) => {
      const p = num(position)
      const { dyn, direction } = move(m)
      return axisMoveAbsolute(ax, p, dyn, direction)
    },
    moveRelative: (distance: number, m: unknown) => {
      const d = num(distance)
      return axisMoveRelative(ax, d, move(m).dyn)
    },
    moveVelocity: (velocity: number, m?: unknown) => {
      const v = num(velocity)
      const { dyn } = move(m)
      return axisMoveVelocity(ax, v, { accel: dyn.accel, decel: dyn.decel, buffered: dyn.buffered })
    },
    follow: (setpoint: number) => axisFollow(ax, num(setpoint)),
    halt: (decel?: number) => axisHalt(ax, optNum(decel)),
    stop: (decel?: number) => axisStop(ax, optNum(decel)),
    releaseStop: () => axisReleaseStop(ax),
    reset: () => axisReset(ax),
    home: (position?: number) => axisHome(ax, position === undefined ? 0 : num(position)),
    done: (id: number) => axisCommandDone(ax, num(id)),
    aborted: (id: number) => axisCommandAborted(ax, num(id)),
    queued: (id: number) => axisCommandQueued(ax, num(id)),
  }) as Servo
}

/** the longest per-bed speed array a part may hand setSurfaceSpeed */
const MAX_DECK_SPEEDS = 1024

// the pure motion utilities behind ctx.clamp/angleDelta/approachAngle/steer (module scope so the ctx
// methods can share them). All deterministic, all total: bad input degrades to a safe value, never throws.
const clampNum = (v: number, lo: number, hi: number): number => (Number.isNaN(v) ? lo : Math.min(Math.max(v, lo), hi))
const angleDeltaNum = (from: number, to: number): number => Math.atan2(Math.sin(to - from), Math.cos(to - from))

/**
 * The per-tick input a host hands a behavior - the object form of the `step` input JSON, shared with the
 * in-process host (src/sim/world.ts) so the hot path passes this struct directly instead of round-tripping
 * it through `JSON.stringify`/`JSON.parse`. `joints` = host-applied (clamped) joint pose from the previous
 * tick (closed-loop feedback → ctx.measured.joints); `grips` = previous-tick held-state.
 */
export interface BehaviorInput {
  simTime?: number
  position?: [number, number, number]
  forward?: [number, number, number]
  tags?: Record<string, TagVal>
  /** controller-driven (program output) tags, keyed like `tags` - values unused, presence = driven */
  driven?: Record<string, TagVal>
  beams?: Record<string, BeamHit>
  zones?: Record<string, number>
  /** summed age (sim seconds) of the cargo counted in `zones`, keyed alike */
  zoneAges?: Record<string, number>
  /** per zone, how many cargo bodies in it carry each truthy mark (ctx.marked), keyed alike; absent when none do */
  zoneMarks?: Record<string, Record<string, number>>
  /** per zone, its count and summed age by product and by kind (ctx.zone's filter), keyed alike; absent when empty */
  zoneMix?: Record<string, ZoneMix>
  /** kg resting on each load-cell link this tick (ctx.weight), keyed by link name; absent when the part has none */
  weights?: Record<string, number>
  joints?: Record<string, number>
  grips?: Record<string, boolean>
  /** each holding gripper's load reach along its X (m), for the robot controller's grip joint; not part of ctx */
  gripWidths?: Record<string, number>
  used?: boolean
  /** the scene's live conveyor speeds (partId → commanded m/s or arc omega), for ctx.conveyorRunning(id) - the
   *  spawner "pause when conveyor stopped" interlock. Absent when the scene has no conveyors. */
  conveyorSpeeds?: Record<string, number>
}

/**
 * The per-tick commands a behavior emits - the object form of the `step` output JSON (see {@link BehaviorInput}).
 * `surfaceVelocity` is omitted only on the error path so the host leaves the last conveyor velocity in place;
 * the maps/arrays are always present (possibly empty) on success. `drive`/`arc` are present only when commanded.
 */
export interface BehaviorOutput {
  surfaceVelocity?: [number, number, number]
  tags: Record<string, TagVal>
  joints: Record<string, number>
  grips: Record<string, boolean>
  lamps: Record<string, boolean>
  /** Effective param values the behavior reported this tick (ctx.report) - what it is actually using
   *  for each named param, which is not the authored value whenever a tag replaced it. Keyed by param. */
  values: Record<string, TagVal>
  /** Named display values the behavior published this tick (ctx.display) - what its own screens/labels show.
   *  Strings allowed (a display is shown on the part, never sent to a PLC). Keyed by display name. */
  displays: Record<string, number | boolean | string>
  subPoses: Record<string, SubPose>
  spawns: SpawnReq[]
  despawns: string[]
  /** product-state requests this tick (ctx.mark / dress / join / split), in call order. Present only when there are
   *  some, like drive/arc, so a part that never touches cargo leaves `cargoOps` undefined */
  cargoOps?: CargoOp[]
  drive?: { forward: number; turn: number }
  arc?: { cx: number; cz: number; omega: number }
  /** ctx.setSurfaceSpeed: every conveying deck runs along its own local +X at this speed - or, as an array, each deck
   *  (in the rig's `conveys` link order) at its own, a missing entry standing still */
  deckSpeed?: number | number[]
  /** ctx.setSurfaceSpeed(speed, link, i): each copy of a posable conveying array at its own speed along its own
   *  local +X, by link, in copy order (0 = stopped). Present only when commanded this tick. */
  copySpeeds?: Record<string, number[]>
  /** a reactive part (definePart's `react`) that did not ask to be called again: the host calls it next when
   *  something it is handed changes (partSleep.ts). Never set for a part with `step`. */
  idle?: boolean
  /** the part read a conveyor's speed this step (ctx.conveyorRunning / conveyorSpeed) */
  readSpeeds?: boolean
}

const instances = new Map<number, Instance>()
let nextHandle = 1
let lastError = ''

// Cumulative cost split of stepDirect across all instances, ms - the in-process host ships it in
// StepStats.phases (as scriptTags/scriptSetup/scriptBody, subsets of phases.script) so perf probes can
// window-diff it. The timer no-ops in a host without a performance API (the QuickJS embedding): the
// counters just stay 0 there, and nothing behavioral depends on them.
// Off by default: these four timers sit inside the region world.ts times as
// `phases.script`, and a worker-thread performance.now() takes ~350 ns. With them on, ~1.4 us of every
// part's reported ~5-7 us/step script cost is the measurement itself (a constant per-call overhead, which
// makes the floor look flat and body-independent). `setPerfEnabled` turns them on for a profiling
// run; the shipping path calls no timer. See docs / the phys-thread ledger.
let perfEnabled = false
const now: () => number = typeof performance !== 'undefined' ? () => (perfEnabled ? performance.now() : 0) : () => 0

/** Enable the per-call cost split (profiling runs only - it measurably inflates what it measures). */
export function setPerfEnabled(on: boolean): void {
  perfEnabled = on
}
const perf = { tagsMs: 0, setupMs: 0, bodyMs: 0 }

/** cumulative stepDirect cost split: tags = the input-refresh churn (prevTags/inTags/driven/beams/zones),
 *  setup = the rest of the pre-step work (feedback merges + output resets), body = the script's own step() */
export function perfStats(): { scriptTags: number; scriptSetup: number; scriptBody: number } {
  return { scriptTags: perf.tagsMs, scriptSetup: perf.setupMs, scriptBody: perf.bodyMs }
}

export function resetPerfStats(): void {
  perf.tagsMs = perf.setupMs = perf.bodyMs = 0
}

function fail(message: string): void {
  lastError = message
}

// Deterministic seed from the resolved params: same params → same rng stream, so a fresh run
// reproduces it exactly. No Math.random / Date - determinism is a hard requirement (FNV-1a hash). To
// decorrelate two otherwise-identical instances, give them a distinct `seed` param.
function seedFrom(paramsJson: string): number {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < paramsJson.length; i++) {
    h ^= paramsJson.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function create(source: string, paramsJson = '{}', jointsJson?: string, arraysJson?: string): number {
  try {
    // The one eval chokepoint for part code lives in core/parts/partScript.ts, shared with the render/headless
    // geometry evaluator so the two can never drift: the determinism scan rejects Date/Math.random/fetch
    // before the source runs, shadowed-global shims catch what the scan can't see, and each create() runs
    // a fresh top level so module-level closures stay instance-isolated. In-process here, which is not
    // isolation: running the identical bundle inside QuickJS (a bare host has no globals to reach) is the
    // unbuilt tier that would make shared parts safe to run. Until then, a room holds peers' part code
    // back until the user allows it (collab/codeTrust.ts), and SECURITY.md says what that leaves open.
    const { def: captured, error: compileError } = instantiatePartScript(source)
    if (!captured) {
      fail(compileError)
      return 0
    }
    const def: PartDefinition = captured
    const handle = nextHandle++
    const overrides = JSON.parse(paramsJson) as Record<string, ParamValue>
    const params = resolvePartParams(def.params, overrides)
    const rng = new Rng(seedFrom(JSON.stringify(params)))
    const rigJoints = rigJointsOf(jointsJson)
    const servos = buildServos(rigJoints, params)
    const robotDecl = robotDeclOf(def.robot)
    const robot = robotDecl ? createRobot(robotDecl, rigJoints) : null
    // the held loads' reach this tick, read by the robot controller's grip joint (ref-swapped each step)
    const heldWidths: { v: Record<string, number> | undefined } = { v: undefined }
    const arrayCounts = buildArrayCounts(arraysJson, params)
    const servoHandles: Record<string, Servo> = {}
    for (const [name, ax] of servos) servoHandles[name] = servoHandle(ax)
    Object.freeze(servoHandles)
    const out = {
      sv: [0, 0, 0] as [number, number, number],
      tags: {} as Record<string, TagVal>,
      joints: {} as Record<string, number>,
      grips: {} as Record<string, boolean>,
      lamps: {} as Record<string, boolean>,
      values: {} as Record<string, TagVal>,
      displays: {} as Record<string, number | boolean | string>,
      subPoses: {} as Record<string, SubPose>,
      spawns: [] as SpawnReq[],
      despawns: [] as string[],
      cargo: [] as CargoOp[],
      drive: null as { forward: number; turn: number } | null,
      arc: null as { cx: number; cz: number; omega: number } | null,
      deckSpeed: null as number | number[] | null,
      copySpeeds: null as Record<string, number[]> | null,
    }
    // host tag tables by reference (cur = this tick, prev = last tick, driven = output ownership) - the
    // ctx closures below read through this box, so stepDirect retargets the references each tick (same
    // ref-swap pattern as inConveyorSpeeds) instead of copying tables per part per tick
    const tagsBox: { cur: Record<string, TagVal>; prev: Record<string, TagVal>; driven: Record<string, TagVal> } = { cur: {}, prev: {}, driven: {} }
    const readBoolTag = (v: TagVal | undefined): boolean => (typeof v === 'number' ? v !== 0 : (v ?? false))
    const sensed: Instance['sensed'] = { beams: NO_BEAMS, zones: NO_COUNTS, zoneAges: NO_COUNTS, zoneMarks: NO_MARKS, zoneMix: NO_MIX, weights: NO_COUNTS }
    // the tally a zone filter picks out (ZoneFilter), or undefined for no usable filter: read field by field, so the
    // script's object is never kept
    const filtered = (zone: string, filter: unknown): ZoneTally | null | undefined => {
      if (typeof filter !== 'object' || filter === null) return undefined
      const { part, kind } = filter as { part?: unknown; kind?: unknown }
      const mix = sensed.zoneMix[zone]
      if (typeof part === 'string' && part) return mix?.products[part] ?? null
      if (kind === 'box' || kind === 'pallet' || kind === 'tote') return mix?.kinds[kind] ?? null
      return undefined
    }
    const inUsed = { used: false }
    const inConveyorSpeeds: { v: Record<string, number> } = { v: EMPTY_SPEEDS } // ref-swapped each tick from input
    // Persistent last-commanded pose, separate from `out` (which carries only this tick's commands). Declared
    // joints/grippers seed to their rest state (0 / open) so reading a declared name never returns undefined -
    // `ctx.joints.shoulder` reflects what the part last commanded. The host-applied (clamped) pose is a
    // separate read channel: `ctx.measured.joints` (see `measuredJoints` below).
    const jointState: Record<string, number> = {}
    for (const j of def.joints ?? []) jointState[j] = 0
    const gripState: Record<string, boolean> = {}
    for (const g of def.grippers ?? []) gripState[g] = false
    const lampState: Record<string, boolean> = {}
    for (const l of def.lamps ?? []) lampState[l] = false
    // host-applied joint feedback (closed-loop read half of `joints`): seeded to rest (0) for declared
    // joints so ctx.measured.joints.<name> never reads undefined; refreshed each tick from step()'s input.
    const measuredJoints: Record<string, number> = {}
    for (const j of def.joints ?? []) measuredJoints[j] = 0
    // host-applied gripper feedback (closed-loop read half of `grips`): true only when the gripper is
    // actually carrying cargo. Seeded false for declared grippers; refreshed each tick from step()'s input.
    const measuredGrips: Record<string, boolean> = {}
    for (const g of def.grippers ?? []) measuredGrips[g] = false
    const commandJoint = (name: string, value: number): void => {
      // a servo poses its own joint from its profile; a direct write would fight it, so it is ignored
      if (Number.isFinite(value) && !servos.has(name)) {
        jointState[name] = value
        out.joints[name] = value
      }
    }
    const commandGrip = (name: string, on: boolean): void => {
      const v = on === true
      gripState[name] = v
      out.grips[name] = v
    }
    const commandLamp = (name: string, on: boolean): void => {
      const v = on === true
      lampState[name] = v
      out.lamps[name] = v
    }
    const again = { v: false }
    const readSpeeds = { v: false }
    const ctx: MutableContext = {
      dt: 0,
      simTime: 0,
      params,
      position: { x: 0, y: 0, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
      rng: () => rng.next(),
      approach: (current: number, target: number, maxDelta: number): number => {
        if (!Number.isFinite(current) || !Number.isFinite(target) || !Number.isFinite(maxDelta)) return current
        const step = Math.abs(maxDelta)
        const d = target - current
        if (d > step) return current + step
        if (d < -step) return current - step
        return target
      },
      approachAngle: (current: number, target: number, maxDelta: number): number => {
        if (!Number.isFinite(current) || !Number.isFinite(target) || !Number.isFinite(maxDelta)) return current
        const step = Math.abs(maxDelta)
        const d = angleDeltaNum(current, target) // shortest signed arc, so the slew never goes the long way
        if (d > step) return current + step
        if (d < -step) return current - step
        return current + d // snap: equals target modulo 2π, continuous with current (no wrap jump)
      },
      approachVec: (current: readonly number[], target: readonly number[], maxDelta: number): number[] => {
        const step = Number.isFinite(maxDelta) ? Math.abs(maxDelta) : 0
        // per-element spans, tracking the dominant distance so every element arrives on the same tick
        let maxAbs = 0
        const spans = current.map((c, i) => {
          const t = target[i]
          const d = Number.isFinite(c) && typeof t === 'number' && Number.isFinite(t) ? t - c : 0
          const a = Math.abs(d)
          if (a > maxAbs) maxAbs = a
          return d
        })
        const s = maxAbs > step && maxAbs > 0 ? step / maxAbs : 1 // 1 = within reach → snap onto the target
        return current.map((c, i) => c + spans[i]! * s)
      },
      angleDelta: (from: number, to: number): number => angleDeltaNum(from, to),
      clamp: (v: number, lo: number, hi: number): number => clampNum(v, lo, hi),
      heading: (): number => Math.atan2(-ctx.forward.z, ctx.forward.x),
      steer: (target: { x: number; z: number }, opts: { speed: number; turnRate: number }): { forward: number; turn: number; distance: number } => {
        const dx = target?.x - ctx.position.x
        const dz = target?.z - ctx.position.z
        const speed = Math.abs(opts?.speed)
        const turnRate = Math.abs(opts?.turnRate)
        if (!Number.isFinite(dx) || !Number.isFinite(dz) || !Number.isFinite(speed) || !Number.isFinite(turnRate)) {
          return { forward: 0, turn: 0, distance: 0 } // bad input commands a stop, deterministically
        }
        const distance = Math.hypot(dx, dz)
        const dt = ctx.dt > 0 ? ctx.dt : 1 / 60 // steer before the first step() tick still returns finite commands
        const err = angleDeltaNum(Math.atan2(-ctx.forward.z, ctx.forward.x), Math.atan2(-dz, dx))
        const turn = clampNum(err / dt, -turnRate, turnRate)
        // facing-away drives 0 (turn in place); the dist/dt cap ends the final tick exactly on the point
        const forward = Math.min(speed, distance / dt) * Math.max(0, Math.cos(err))
        return { forward, turn, distance }
      },
      setSurfaceVelocity: (v: Vec3) => {
        // NaN / Infinity reached Jolt as a NaN cargo position; ignore the call, like the other ctx utilities' bad input
        const x = finiteOrUndef(v?.x)
        const y = finiteOrUndef(v?.y)
        const z = finiteOrUndef(v?.z)
        if (x === undefined || y === undefined || z === undefined) return
        out.sv[0] = x
        out.sv[1] = y
        out.sv[2] = z
      },
      setArcSurfaceVelocity: (opts: { center: { x: number; z: number }; omega: number }) => {
        const center = opts?.center
        const cx = finiteOrUndef(center?.x)
        const cz = finiteOrUndef(center?.z)
        const omega = finiteOrUndef(opts?.omega)
        if (cx !== undefined && cz !== undefined && omega !== undefined) out.arc = { cx, cz, omega }
      },
      setSurfaceSpeed: (speed: number | readonly number[], link?: string, index?: number) => {
        if (link !== undefined) {
          // one copy (or, with no index, every copy) of a posable conveying array
          const n = typeof link === 'string' ? (arrayCounts.get(link) ?? 0) : 0
          const s = finiteOrUndef(speed as number)
          if (n === 0 || s === undefined) return
          const copies = ((out.copySpeeds ??= {})[link] ??= new Array<number>(n).fill(0))
          if (index === undefined) copies.fill(s)
          else if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < n) copies[index] = s
          return
        }
        if (Array.isArray(speed)) {
          const n = Math.min(Number(speed.length) >>> 0, MAX_DECK_SPEEDS)
          const deck: number[] = []
          for (let i = 0; i < n; i++) deck.push(finiteOrUndef(speed[i]) ?? 0)
          out.deckSpeed = deck
        } else {
          const s = finiteOrUndef(speed)
          if (s !== undefined) out.deckSpeed = s
        }
      },
      drive: (forward: number, turn: number) => {
        if (Number.isFinite(forward) && Number.isFinite(turn)) out.drive = { forward, turn }
      },
      setJoint: commandJoint,
      setGrip: (name: string, on: boolean, index?: number) => {
        if (index === undefined) return commandGrip(name, on)
        // one copy of a posable array: it grips under the name link#index (an index outside the row is ignored)
        const n = typeof name === 'string' ? (arrayCounts.get(name) ?? 0) : 0
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < n) commandGrip(copyGripName(name, index), on)
      },
      setEmissive: commandLamp,
      setSubPose: (link: string, pose: { position?: [number, number, number]; rotation?: [number, number, number]; quat?: [number, number, number, number] }, index?: number) => {
        if (typeof link !== 'string' || link === '' || link === '__proto__') return
        const p: { position?: [number, number, number]; rotation?: [number, number, number]; quat?: [number, number, number, number] } = {}
        const position = readVec3(pose?.position)
        const rotation = readVec3(pose?.rotation)
        const quat = readQuat(pose?.quat)
        if (position) p.position = position
        if (quat) p.quat = quat
        else if (rotation) p.rotation = rotation
        const prev = out.subPoses[link]
        if (index === undefined) {
          out.subPoses[link] = prev?.instances ? { ...p, instances: prev.instances } : p
          return
        }
        // one instance of a posable array: an index outside the row (or a link that is not a posable array) is ignored
        const n = arrayCounts.get(link) ?? 0
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= n) return
        const sub = prev ?? (out.subPoses[link] = {})
        const list = (sub.instances ??= new Array<null>(n).fill(null))
        list[index] = p
      },
      arrayCount: (link: string) => (typeof link === 'string' ? (arrayCounts.get(link) ?? 0) : 0),
      // typed property bags: `ctx.joints.shoulder = v` / `ctx.grips.hand = true`. Writes funnel through the
      // same validated command path as setJoint/setGrip; reads return the last-commanded state.
      joints: new Proxy(jointState, {
        get: (t, name) => (typeof name === 'string' ? t[name] : undefined),
        set: (_t, name, value) => {
          if (typeof name === 'string' && typeof value === 'number') commandJoint(name, value)
          return true
        },
      }),
      grips: new Proxy(gripState, {
        get: (t, name) => (typeof name === 'string' ? t[name] : undefined),
        set: (_t, name, on) => {
          if (typeof name === 'string') commandGrip(name, on === true)
          return true
        },
      }),
      lamps: new Proxy(lampState, {
        get: (t, name) => (typeof name === 'string' ? t[name] : undefined),
        set: (_t, name, on) => {
          if (typeof name === 'string') commandLamp(name, on === true)
          return true
        },
      }),
      servos: servoHandles,
      robot: robot ? Object.freeze({ step: () => robot.step(ctx, { heldReach: (g: string) => heldWidths.v?.[g] }) }) : undefined,
      servo: (name: string) => (typeof name === 'string' && Object.hasOwn(servoHandles, name) ? servoHandles[name] : undefined),
      // closed-loop reads of the host-applied state (previous tick). Read-only: writes go through the
      // command bags (`ctx.joints` / `ctx.grips`); a write here is silently ignored, not an error.
      measured: {
        joints: new Proxy(measuredJoints, {
          get: (t, name) => (typeof name === 'string' ? t[name] : undefined),
          set: () => true,
        }),
        grips: new Proxy(measuredGrips, {
          get: (t, name) => (typeof name === 'string' ? t[name] : undefined),
          set: () => true,
        }),
      },
      // A copy every call: the hit's `color` is the live box's own array (sensorRegistry.ts castBeam) and a miss is
      // one module-level object, so a part writing into what it sensed would repaint the box or poison every other
      // part's clear beam.
      sense: (beam: string): BeamHit => {
        const h = sensed.beams[beam] ?? CLEAR_BEAM
        return { hit: h.hit, distance: h.distance, color: [h.color[0], h.color[1], h.color[2]], ...(h.marks ? { marks: Object.freeze({ ...h.marks }) } : {}) }
      },
      zone: (zone: string, filter?: unknown): number => {
        const t = filtered(zone, filter)
        return t === undefined ? (sensed.zones[zone] ?? 0) : (t?.n ?? 0)
      },
      weight: (link: string): number => sensed.weights[link] ?? 0,
      zoneAge: (zone: string, filter?: unknown): number => {
        const t = filtered(zone, filter)
        return t === undefined ? (sensed.zoneAges[zone] ?? 0) : (t?.age ?? 0)
      },
      despawn: (zone: string) => { if (typeof zone === 'string' && zone) out.despawns.push(zone) },
      // product state: every request is copied field by field, so nothing the script holds is shared with the host
      mark: (zone: string, key: string, value: CargoMark) => {
        if (typeof zone !== 'string' || !zone || typeof key !== 'string' || !key) return
        if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string') return
        if (typeof value === 'number' && !Number.isFinite(value)) return
        out.cargo.push({ op: 'mark', zone, key, value })
      },
      markHit: (beam: string, key: string, value: CargoMark) => {
        if (typeof beam !== 'string' || !beam || typeof key !== 'string' || !key) return
        if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string') return
        if (typeof value === 'number' && !Number.isFinite(value)) return
        out.cargo.push({ op: 'markHit', beam, key, value })
      },
      marked: (zone: string, key: string): number => sensed.zoneMarks[zone]?.[key] ?? 0,
      dress: (zone: string, spec: { id?: unknown; material?: unknown; opacity?: unknown; upTo?: unknown; web?: { link?: unknown; offset?: unknown; height?: unknown } }) => {
        if (typeof zone !== 'string' || !zone || !spec) return
        const id = spec.id
        const material = spec.material
        if (typeof id !== 'string' || !id || typeof material !== 'string' || !material) return
        const opacity = finiteOrUndef(spec.opacity)
        const upTo = finiteOrUndef(spec.upTo)
        const w = spec.web
        const wLink = w?.link
        const wOffset = w?.offset
        const o = Array.isArray(wOffset) ? [wOffset[0], wOffset[1], wOffset[2]] : []
        const height = finiteOrUndef(w?.height)
        const web = typeof wLink === 'string' && wLink && height !== undefined && height > 0
          ? { link: wLink, offset: [Number(o[0]) || 0, Number(o[1]) || 0, Number(o[2]) || 0] as [number, number, number], height }
          : undefined
        out.cargo.push({
          op: 'dress', zone, id, material,
          ...(opacity !== undefined ? { opacity: Math.min(1, Math.max(0.01, opacity)) } : {}),
          ...(upTo !== undefined ? { upTo } : {}),
          ...(web ? { web } : {}),
        })
      },
      join: (zone: string) => { if (typeof zone === 'string' && zone) out.cargo.push({ op: 'join', zone }) },
      readTag: (name: string) => {
        const v = tagsBox.cur[tagKey(name)]
        return typeof v === 'number' ? v !== 0 : (v ?? false)
      },
      // presence-keyed: the host hands in the controller's output tags projected exactly like the value
      // table, so this resolves scoped/absolute names identically to readTag
      tagDriven: (name: string) => tagsBox.driven[tagKey(name)] !== undefined,
      // a number goes the way writeNumber sends it; anything else that is not `true` writes FALSE
      writeTag: (name: string, value: boolean | number) => {
        if (typeof value === 'number') {
          if (Number.isFinite(value)) out.tags[tagKey(name)] = value
        } else out.tags[tagKey(name)] = value === true
      },
      readNumber: (name: string) => {
        const v = tagsBox.cur[tagKey(name)]
        return typeof v === 'number' ? v : v === true ? 1 : 0
      },
      writeNumber: (name: string, value: number) => {
        if (Number.isFinite(value)) out.tags[tagKey(name)] = value
      },
      // Effective-value feedback: what this part is actually using for a named param, published from the
      // one expression that computed it. Nothing downstream re-derives it, so it cannot drift the way a
      // host-side replay of the comms convention would. Param names are not tag names: no scope projection.
      report: (param: string, value: number | boolean) => {
        if (typeof value === 'boolean') out.values[param] = value
        else if (Number.isFinite(value)) out.values[param] = value
      },
      // C-display: a named readout for this part's own screens/labels. Strings pass through (a display is
      // shown on the part, never sent to a PLC; plcHost.driveable drops strings on the tag path because
      // a tag does reach the PLC). A non-finite number is dropped rather than published as NaN: the widget then
      // renders unbound, which is the right reading of a value the step failed to compute.
      display: (name: string, value: number | boolean | string) => {
        if (typeof name !== 'string' || name === '') return
        if (typeof value === 'string') out.displays[name] = value.length > MAX_DISPLAY_CHARS ? value.slice(0, MAX_DISPLAY_CHARS) : value
        else if (typeof value === 'boolean') out.displays[name] = value
        else if (Number.isFinite(value)) out.displays[name] = value
      },
      // synchronous edge detection over the begin-of-tick tag tables (prev = last tick, cur = this tick).
      // No callbacks/refs - same value every part reads, so it stays deterministic + order-independent.
      rising: (name: string) => readBoolTag(tagsBox.cur[name]) && !readBoolTag(tagsBox.prev[name]),
      falling: (name: string) => !readBoolTag(tagsBox.cur[name]) && readBoolTag(tagsBox.prev[name]),
      used: () => inUsed.used,
      again: () => {
        again.v = true
      },
      conveyorRunning: (id: string): boolean => {
        if (typeof id !== 'string' || id === '') return true // unset ⇒ no interlock
        readSpeeds.v = true
        const s = inConveyorSpeeds.v[id]
        return s === undefined ? true : s !== 0 // dangling / non-conveyor ⇒ inert; only a real stopped conveyor ⇒ false
      },
      spawn: (opts) => {
        if (out.spawns.length >= MAX_SPAWNS_PER_TICK) return
        const req: SpawnReq = {}
        if (typeof opts?.part === 'string' && opts.part) {
          req.part = opts.part
          // the product's param overrides, copied value by value: only plain finite values cross to the host
          const given = opts.params
          if (typeof given === 'object' && given !== null) {
            const params: Record<string, number | boolean | string> = {}
            for (const k of Object.keys(given)) {
              const v = (given as Record<string, unknown>)[k]
              if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) params[k] = v
            }
            req.params = params
          }
        }
        if (opts?.kind === 'pallet' || opts?.kind === 'tote') req.kind = opts.kind
        // a size must be positive as well as finite: a negative extent builds an inside-out body that Jolt launches ~30 m
        const size = readVec3(opts?.size)
        if (size && size[0] > 0 && size[1] > 0 && size[2] > 0) req.size = size
        const color = readVec3(opts?.color)
        if (color) req.color = color
        const offset = readVec3(opts?.offset)
        if (offset) req.offset = offset
        const mass = finiteOrUndef(opts?.mass)
        if (mass !== undefined && mass > 0) req.mass = mass
        // the facts it starts with, copied value by value like `params`
        const given = opts?.marks
        if (typeof given === 'object' && given !== null) {
          const marks: Record<string, CargoMark> = {}
          for (const k of Object.keys(given)) {
            const v = (given as Record<string, unknown>)[k]
            if (k && (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) marks[k] = v
          }
          if (Object.keys(marks).length > 0) req.marks = marks
        }
        out.spawns.push(req)
      },
    }
    // init() is deferred to the first step (stepDirect). Run here, it would see the part at the origin with dt 0
    // and no inputs (the host hasn't placed it yet), and the first tick's output reset would wipe every command it
    // gave (a joint, a lamp), so an author's "start pose" would silently never happen; a throw would also leave the
    // half-built instance registered. At the first step it sees the real pose, params and tags, and its commands
    // stay in that tick's output unless step() overrides them.
    instances.set(handle, { def, ctx, out, tags: tagsBox, measuredJoints, measuredGrips, heldWidths, sensed, inUsed, inConveyorSpeeds, servos, again, readSpeeds, needsInit: typeof def.init === 'function' })
    return handle
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return 0
  }
}

/** The joint/gripper names a part declared (definePart({ joints, grippers })) - for buildPackage to
 *  cross-check them against the rig geometry, making the typed-bag's "typo = error" promise true at build. */
export function declarations(handle: number): { joints: string[]; grippers: string[]; lamps: string[]; servos: string[]; interactive: boolean; hasStep: boolean; hasBoth?: boolean; hasInit: boolean; useParam?: string; snap?: SnapSpec; unit?: UnitLoadDecl; robot?: RobotDecl } {
  const inst = instances.get(handle)
  if (!inst) {
    fail(`oip-behavior: bad handle ${handle}`)
    return { joints: [], grippers: [], lamps: [], servos: [], interactive: false, hasStep: false, hasInit: false }
  }
  // the part's own declarations, each read once and copied: they become package data the host keeps (hostCopy.ts)
  const def = inst.def
  const names = (v: unknown): string[] => {
    const c = hostCopy(v)
    return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : []
  }
  const useParam = hostCopy(def.useParam)
  const snap = hostCopy((def as { snap?: SnapSpec }).snap)
  const unit = hostCopy(def.unit)
  const robot = robotDeclOf(def.robot)
  return {
    joints: names(def.joints),
    grippers: names(def.grippers),
    lamps: names(def.lamps),
    servos: names(def.servos),
    interactive: def.interactive === true,
    hasStep: typeof def.step === 'function' || typeof def.react === 'function',
    hasBoth: typeof def.step === 'function' && typeof def.react === 'function',
    hasInit: typeof def.init === 'function',
    ...(useParam !== undefined ? { useParam } : {}),
    ...(snap ? { snap } : {}),
    ...(unit ? { unit } : {}),
    ...(robot ? { robot } : {}),
  }
}

/**
 * Realize the part's procedural geometry (docs/procedural-geometry.md, Tier 2) for the given param
 * overrides → a portable MeshDescription as JSON, or `''` when the part declares no `geometry()` callback
 * (its geometry is fully manifest-described) or the call fails (see {@link error}). Param-driven and
 * side-effect-free: the host calls this at author time + on a param change, never per tick. The geometry
 * function is the same determinism-gated source as `step` (checked at {@link create}), and every builder op
 * is vertex-budget-capped - so a runaway/non-deterministic geometry function can't escape the sandbox.
 *
 * `ctxJson` carries the host-resolved seam facts ({@link GeometryContext} - the resolved world-phase roller
 * grid) across this portable boundary, so a shell that knows where the part sits gets the same
 * placement-aware geometry the browser rig does. Omitted ⇒ empty, i.e. the placement-free geometry.
 */
export function geometry(handle: number, paramsJson = '{}', ctxJson = '{}'): string {
  const inst = instances.get(handle)
  if (!inst) {
    fail(`oip-behavior: bad handle ${handle}`)
    return ''
  }
  const tool = robotDeclOf(inst.def.robot)?.tool
  if (!inst.def.geometry && !tool) return '' // no procedural geometry - fully manifest-described
  try {
    const overrides = JSON.parse(paramsJson) as Record<string, ParamValue>
    const params = resolvePartParams(inst.def.params, overrides) as ParamsOf<ParamSchema>
    const out = inst.def.geometry ? inst.def.geometry(createGeometryBuilder(), params, JSON.parse(ctxJson) as GeometryContext) : []
    // normalize to MeshPart[] (a bare description = one role-less part) in the current spelling, so render + sim
    // see one shape whatever format the script was written for (core/geometry/geometryEval canonicalMeshParts); a
    // robot's tool, drawn by the host, follows the part's own meshes
    const own = Array.isArray(out) ? out : [{ desc: out }]
    const parts = canonicalMeshParts(tool ? [...own, ...robotToolParts(createGeometryBuilder(), params, tool)] : own)
    return JSON.stringify(parts)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return ''
  }
}

/** JSON of the part's exported-param schema - the Inspector builds its fields from this. */
export function meta(handle: number): string {
  const inst = instances.get(handle)
  if (!inst) {
    fail(`oip-behavior: bad handle ${handle}`)
    return '{}'
  }
  return JSON.stringify(inst.def.params ?? {})
}

/**
 * The in-process hot path: run one tick from a plain {@link BehaviorInput} object and return a plain
 * {@link BehaviorOutput} (or `null` on a bad handle / script throw - the host then leaves last tick's state
 * in place). The same logic the string {@link step} runs, minus the per-tick JSON round-trip; world.ts calls
 * this directly. The returned object references the instance's persistent `out` buffers, which are valid until
 * the next call (each tick reassigns fresh collections + the host consumes the result synchronously).
 */
export function stepDirect(handle: number, input: BehaviorInput, dt: number): BehaviorOutput | null {
  const inst = instances.get(handle)
  if (!inst) {
    fail(`oip-behavior: bad handle ${handle}`)
    return null
  }
  try {
    const ctx = inst.ctx
    ctx.dt = dt
    ctx.simTime = input.simTime ?? 0
    // copied by index: a destructuring assignment runs the array iterator protocol, per part per tick
    const ip = input.position
    if (ip) {
      const p = ctx.position as Vec3
      p.x = ip[0]
      p.y = ip[1]
      p.z = ip[2]
    }
    const iF = input.forward
    if (iF) {
      const f = ctx.forward as Vec3
      f.x = iF[0]
      f.y = iF[1]
      f.z = iF[2]
    }
    // the cost split is a profiling aid (setPerfEnabled): off, not even the clock function is called
    const timed = perfEnabled
    const t0 = timed ? now() : 0
    // refresh inputs / clear last tick's outputs.
    // Tag tables move by reference, not copy: hosts replace a table object when its values change and
    // never mutate one in place (SimWorld.setBehaviorInputTags value-diffs pushes; the scoped-projection
    // memo hands out fresh objects per change; the JSON path parses a fresh object per tick), and scripts
    // can't reach the objects (ctx closures only read elements). The cur→prev pointer swap gives
    // ctx.rising/falling exactly one tick of edge per change: the same semantics as copying the table every
    // tick, at O(1) per part instead of O(tags).
    const tb = inst.tags
    tb.prev = tb.cur
    tb.cur = input.tags ?? EMPTY_TAGS
    tb.driven = input.driven ?? EMPTY_TAGS
    const sn = inst.sensed
    sn.beams = input.beams ?? NO_BEAMS
    sn.zones = input.zones ?? NO_COUNTS
    sn.zoneAges = input.zoneAges ?? NO_COUNTS
    sn.zoneMarks = input.zoneMarks ?? NO_MARKS
    sn.zoneMix = input.zoneMix ?? NO_MIX
    sn.weights = input.weights ?? NO_COUNTS
    const t1 = timed ? now() : 0
    // refresh joint feedback in place (the proxy reads this object). Merge, not replace: the host sends the
    // host-applied pose per joint each tick, and a joint not reported retains its last measured value.
    if (input.joints) {
      for (const k of Object.keys(input.joints)) {
        const v = input.joints[k]
        if (typeof v === 'number' && Number.isFinite(v)) inst.measuredJoints[k] = v
      }
    }
    // grip held-state feedback (merge, like joints): the host re-reports every commanded-or-held gripper
    // each tick, so a released gripper is sent an explicit false and the merged view never goes stale.
    if (input.grips) {
      for (const k of Object.keys(input.grips)) inst.measuredGrips[k] = input.grips[k] === true
    }
    inst.heldWidths.v = input.gripWidths
    inst.inUsed.used = input.used === true
    inst.inConveyorSpeeds.v = input.conveyorSpeeds ?? EMPTY_SPEEDS // ref-swap (host rebuilds the map once per tick)
    inst.out.sv[0] = inst.out.sv[1] = inst.out.sv[2] = 0
    inst.out.tags = {}
    inst.out.joints = {}
    inst.out.grips = {}
    inst.out.lamps = {}
    inst.out.values = {}
    // cleared every tick like the rest: a display the part stops publishing must go blank, not stale. A
    // panel that keeps showing the last number after its feed dies would misreport the line.
    inst.out.displays = {}
    inst.out.subPoses = {}
    inst.out.spawns = []
    inst.out.despawns = []
    inst.out.cargo = []
    inst.out.drive = null
    inst.out.arc = null
    inst.out.deckSpeed = null
    inst.out.copySpeeds = null
    inst.again.v = false
    inst.readSpeeds.v = false
    const t2 = timed ? now() : 0

    if (inst.needsInit) {
      inst.needsInit = false // once, even if it throws: the throw is this tick's reported error, like step()'s
      inst.def.init!(ctx)
    }
    // dt is also passed positionally for behavior code stored before format 4, whose step(ctx, dt) read it there
    ;((inst.def.react ?? inst.def.step) as (c: typeof ctx, dt: number) => void)(ctx, dt)
    // the servos run after the tick's commands, so a command takes effect this tick, and each poses its joint
    for (const [name, ax] of inst.servos) {
      stepAxis(ax, dt)
      inst.out.joints[name] = axisPosition(ax)
    }
    if (timed) {
      perf.tagsMs += t1 - t0
      perf.setupMs += t2 - t1
      perf.bodyMs += now() - t2
    }
    // every field present, an absent one undefined: built with conditional spreads, the result would come in up
    // to 16 shapes, and the host's reads of it (world.ts tickBehaviors) would go polymorphic. JSON.stringify
    // drops an undefined field, so the string boundary's output omits it.
    const o = inst.out
    return {
      surfaceVelocity: o.sv,
      tags: o.tags,
      joints: o.joints,
      grips: o.grips,
      lamps: o.lamps,
      values: o.values,
      displays: o.displays,
      subPoses: o.subPoses,
      spawns: o.spawns,
      despawns: o.despawns,
      cargoOps: o.cargo.length ? o.cargo : undefined,
      drive: o.drive ?? undefined,
      arc: o.arc ?? undefined,
      deckSpeed: o.deckSpeed ?? undefined,
      copySpeeds: o.copySpeeds ?? undefined,
      // a servo is the host's to move every step, so a part with one is never idle
      // (both absent when false, like the fields above: the string boundary's output is then what it was)
      idle: inst.def.react !== undefined && !inst.again.v && inst.servos.size === 0 ? true : undefined,
      readSpeeds: inst.readSpeeds.v ? true : undefined,
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * The string FFI boundary (`step` of the {@link OipBehavior} contract): a thin JSON wrapper over
 * {@link stepDirect} for an out-of-process host (an isolated V8 realm / QuickJS / WASM instance for sandboxed
 * shared parts), where only strings + numbers may cross. In-process callers should use {@link stepDirect} to
 * skip the round-trip. Returns `'{}'` on parse failure / bad handle / script throw.
 */
export function step(handle: number, inputJson: string, dt: number): string {
  let input: BehaviorInput
  try {
    input = JSON.parse(inputJson) as BehaviorInput
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return '{}'
  }
  const out = stepDirect(handle, input, dt)
  return out ? JSON.stringify(out) : '{}'
}

export function destroy(handle: number): void {
  const inst = instances.get(handle)
  if (inst?.def.dispose) {
    try {
      inst.def.dispose(inst.ctx)
    } catch (e) {
      // teardown is best-effort - the instance goes regardless - but the error is reported (error()), not swallowed
      fail(`dispose() threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  instances.delete(handle)
}

/** Last error message; clears it so a host can poll after a 0/`{}` return. */
export function error(): string {
  const e = lastError
  lastError = ''
  return e
}

export const OipBehavior = { create, meta, geometry, step, stepDirect, destroy, error }

// Expose on globalThis so an embedded host (QuickJS) can reach the API after evaluating the bundle.
;(globalThis as unknown as { OipBehavior?: typeof OipBehavior }).OipBehavior = OipBehavior
