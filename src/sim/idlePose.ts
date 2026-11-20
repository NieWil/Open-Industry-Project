// Static idle actuation preview: the stopped-sim twin of the running frame's per-tick joint output.
//
// While the sim runs, a device's motion lives in its behavior `step()` and reaches the rig via the sim
// frame (world.ts → applyBoxFrame). While stopped there is no frame, so without this a placed device (blade
// stop, safety gate, diverter) would sit at its zero rest pose and look identical however it's configured,
// and you could not see it actuate to check placement without pressing Play. This settles a throwaway behavior
// instance to the steady pose it would hold for the authored params, so the editor can render that pose
// statically at rest (see EditorController.refreshIdlePoses).
//
// It runs the real behavior on the main thread, deterministic and instance-isolated (partScript gives
// each create() a fresh closure), so it can't disturb the sim worker's own instances (a separate realm)
// and only ever runs while stopped (the two are mutually exclusive in time). Neutral input: no Use/click,
// no PLC tags. The preview reflects the authored params (e.g. the blade stop's `active` toggle), not any
// live signal a stopped scene can't provide. The one scene input it can get is `zones`: the authored cargo in
// each detection zone (core/zoneCounts), which the editor passes for a part that stores cargo (PartPackage.holds),
// so a machine whose state is what it holds (a pallet dispenser's magazine) previews holding it.

import { create, destroy, stepDirect } from './embeddedBehavior'
import type { ParamValue } from '../core/parts/partApi'
import { jointRestValue } from '../core/parts/partGeometry'
import type { InstancePose, SubPose } from '../core/rig/rigPose'

/** A settled device pose to apply to a rig at rest: `joints` in the sim's units (rad / m), `subPoses` the
 *  free-form link overrides, `lamps` the emissive states (a maintained button's lit cap) - the joint/subPose/
 *  lamp halves of a sim frame, minus everything physics-driven. */
export interface IdlePose {
  joints: Record<string, number>
  subPoses: Record<string, SubPose>
  /** emissive lamp states at this pose; absent = leave the lamps at rest */
  lamps?: Record<string, boolean>
}

const DT = 1 / 60 // fixed preview step (matches the sim's nominal tick); the pose is a settled value, not timed
const MAX_STEPS = 300 // 5 sim-seconds - ample for any device tween (blade stop settles in 1 step) to converge
const SETTLE_EPS = 1e-4 // per-joint change (rad / m) below which a joint counts as settled between two steps
// A device can hold perfectly still mid-actuation (the momentary push button pins its cap down for a 0.3 s =
// 18-tick pulse window before springing back), so one quiet tick can't mean "settled" - convergence requires
// this many consecutive still ticks, long enough to out-wait any such hold.
const STILL_TICKS = 30
// A replayed press waits for the device to settle from the one before, but no longer than this (2 s): a device
// that never settles (a spun turntable) still gets every press, in order.
const PULSE_GAP_MAX = 120

/**
 * When to deliver the `pulses` replayed presses of a settle (settleIdlePose's usePulses): the first at once, each
 * next one only once the device has settled from the last. On consecutive ticks only a device that flips on every
 * press would come out right: the emergency stop ignores a press that arrives mid-twist. A person cannot press
 * twice in one tick.
 */
function pulseReplay(pulses: number): { press(i: number, still: number): boolean; readonly done: boolean; readonly budget: number } {
  let left = pulses
  let since = 0
  return {
    press(i, still) {
      since++
      if (left === 0 || !(i === 0 || still >= STILL_TICKS || since >= PULSE_GAP_MAX)) return false
      left--
      since = 0
      return true
    },
    get done() {
      return left === 0
    },
    // the settle's step cap, grown by the most each press can wait
    budget: MAX_STEPS + pulses * PULSE_GAP_MAX,
  }
}

/** max absolute per-joint change from pose `a` to pose `b` (0 when a joint is absent from either). */
function maxJointDelta(a: Record<string, number>, b: Record<string, number>): number {
  let m = 0
  for (const k of Object.keys(b)) {
    const d = Math.abs((b[k] ?? 0) - (a[k] ?? 0))
    if (d > m) m = d
  }
  return m
}

/** max absolute component change between two poses (a channel absent from one side reads 0) */
function maxPoseDelta(a: InstancePose | null | undefined, b: InstancePose | null | undefined): number {
  let m = 0
  for (const ch of ['position', 'rotation', 'quat'] as const) {
    const va = a?.[ch]
    const vb = b?.[ch]
    if (!va && !vb) continue
    for (let i = 0; i < (va ?? vb)!.length; i++) {
      const d = Math.abs((vb?.[i] ?? 0) - (va?.[i] ?? 0))
      if (d > m) m = d
    }
  }
  return m
}

/** max absolute component change between two subPose maps (a link/channel/instance absent from one side reads 0). */
function maxSubPoseDelta(a: IdlePose['subPoses'], b: IdlePose['subPoses']): number {
  let m = 0
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    m = Math.max(m, maxPoseDelta(a[k], b[k]))
    const ia = a[k]?.instances ?? []
    const ib = b[k]?.instances ?? []
    for (let i = 0; i < Math.max(ia.length, ib.length); i++) m = Math.max(m, maxPoseDelta(ia[i], ib[i]))
  }
  return m
}

/** the posable-array instance poses of `subPoses`, without any whole-link pose */
function instancePosesOnly(subPoses: IdlePose['subPoses']): IdlePose['subPoses'] {
  const out: IdlePose['subPoses'] = {}
  for (const [k, v] of Object.entries(subPoses)) if (v.instances) out[k] = { instances: v.instances }
  return out
}

/** Settle a fresh instance through `prePulses` presses to its resting pose (the pose on screen). */
function settleTo(handle: number, prePulses: number, zones?: Record<string, number>): IdlePose | null {
  let last: Record<string, number> = {}
  let lastSub: IdlePose['subPoses'] = {}
  let lastLamps: Record<string, boolean> = {}
  let still = 0
  const replay = pulseReplay(prePulses)
  for (let i = 0; i < replay.budget; i++) {
    const used = replay.press(i, still)
    const out = stepDirect(handle, { used, ...(zones ? { zones } : {}) }, DT)
    if (!out) return null
    const moving = maxJointDelta(last, out.joints) >= SETTLE_EPS || maxSubPoseDelta(lastSub, out.subPoses) >= SETTLE_EPS
    last = out.joints
    lastSub = out.subPoses
    lastLamps = out.lamps
    still = moving || used ? 0 : still + 1
    if (replay.done && i > 0 && still >= STILL_TICKS) break
  }
  return { joints: { ...last }, subPoses: lastSub, ...(Object.keys(lastLamps).length > 0 ? { lamps: { ...lastLamps } } : {}) }
}

/**
 * Settle a part's behavior to the static pose it holds for `params` under neutral input, for a stopped-sim
 * actuation preview. Steps a throwaway instance until the commanded joints converge (early-exit) or a cap;
 * a joint that never settles is in continuous motion (a turntable's spin, a conveyor) and is dropped so it
 * falls back to rest rather than freezing at some arbitrary mid-motion angle. Returns null when the part
 * fails to instantiate or commands nothing to preview (the common case for a plain conveyor / a device
 * whose actuator is off); the caller then leaves the rig at its zero rest pose.
 *
 * `usePulses` settles the state after that many `ctx.used()` presses, each delivered once the device has
 * settled from the last (see pulseReplay). The editor always passes 0, because a press on a stopped device is a
 * live session (IdleUseSession), not a replay. So this is a headless "what does it do after N presses" answer.
 */
export function settleIdlePose(source: string, params: Record<string, ParamValue>, usePulses = 0, zones?: Record<string, number>, jointsJson?: string, arraysJson?: string): IdlePose | null {
  const handle = create(source, JSON.stringify(params ?? {}), jointsJson, arraysJson)
  if (handle === 0) return null
  try {
    let prev: Record<string, number> = {}
    let last: Record<string, number> = {}
    let prevSub: IdlePose['subPoses'] = {}
    let lastSub: IdlePose['subPoses'] = {}
    let lastLamps: Record<string, boolean> = {}
    let converged = false
    let still = 0
    const replay = pulseReplay(usePulses)
    for (let i = 0; i < replay.budget; i++) {
      const used = replay.press(i, still) // the presses so far, each once the device has settled from the last
      const out = stepDirect(handle, { used, ...(zones ? { zones } : {}) }, DT)
      if (!out) break // a throwing behavior - nothing to preview
      prev = last
      last = out.joints
      prevSub = lastSub
      lastSub = out.subPoses
      lastLamps = out.lamps
      // converged once nothing (joint or subPose) has moved for STILL_TICKS straight - a single quiet tick
      // isn't enough, a device can hold mid-actuation (the momentary button's pulse window) - and never
      // before the pulses end
      still = used || maxJointDelta(prev, last) >= SETTLE_EPS || maxSubPoseDelta(prevSub, lastSub) >= SETTLE_EPS ? 0 : still + 1
      if (replay.done && i > 0 && still >= STILL_TICKS) {
        converged = true
        break
      }
    }
    // keep only joints that have stopped moving (a still-moving joint is continuous → omit → rests via applyJoints)
    const joints: Record<string, number> = {}
    for (const name of Object.keys(last)) {
      if (Math.abs((last[name] ?? 0) - (prev[name] ?? 0)) < SETTLE_EPS) joints[name] = last[name]!
    }
    // subPoses/lamps are all-or-nothing: only a converged device has a truthful settled value for them
    // (a still-moving one would freeze mid-hold / mid-blink). Except a posable array's copies: their rest row is
    // not a pose the machine ever has (a sorter's carriers belong round its chain), so a part that never settles
    // keeps where its copies stood at the end of the settle, and only its whole-link poses go back to rest.
    const subPoses = converged ? lastSub : instancePosesOnly(lastSub)
    const lamps = converged ? lastLamps : {}
    const hasJoints = Object.keys(joints).length > 0
    const hasSubPoses = Object.keys(subPoses).length > 0
    const hasLamps = Object.keys(lamps).length > 0
    return hasJoints || hasSubPoses || hasLamps ? { joints, subPoses, ...(hasLamps ? { lamps } : {}) } : null
  } finally {
    destroy(handle) // no retained handle - the memoized result, not the instance, is what the caller keeps
  }
}

/**
 * Fill in the joints a settle could not pin from their declared `rest` param bindings. settleIdlePose drops a
 * joint still moving at its 5 s cap (continuous motion must not freeze mid-spin), but a slow discrete move is
 * dropped too: a turntable deck slewing 150 degrees at 20 deg/s with its ramps takes ~8 s. Without this it would
 * fall back to 0, and the stopped editor would show the deck square while the Inspector (and the conveying
 * surface, which reads the same binding through the turntable bed's view) said 150. A joint that declares where it
 * settles is taken at its word; a joint the behavior did settle keeps the behavior's value. Null only when there is nothing to pose.
 */
export function withJointRests(
  pose: IdlePose | null,
  joints: readonly { name: string; rest?: { param: string; scale?: number; add?: number } }[],
  params: Record<string, ParamValue>,
): IdlePose | null {
  const rests: Record<string, number> = {}
  for (const j of joints) {
    if (pose && j.name in pose.joints) continue
    const v = jointRestValue(j, params)
    if (v !== undefined) rests[j.name] = v
  }
  if (Object.keys(rests).length === 0) return pose
  return pose ? { ...pose, joints: { ...rests, ...pose.joints } } : { joints: rests, subPoses: {} }
}

/** How long (preview ticks, 1.5 s) a device must sit quietly at its design before a stopped Use's session ends. */
const REST_TICKS = 90

/** What a device's stopped state is derived from - its behavior, its params, the cargo it holds - as one key: the
 *  idle preview's memo, and the design a stopped Use's session was opened on (a change means the design moved). */
export function idleKey(behavior: string, params: Record<string, ParamValue>, zones?: Record<string, number>): string {
  return `${behavior} ${JSON.stringify(params)} ${zones ? JSON.stringify(zones) : ''}`
}

/**
 * A stopped-scene Use, live: the one model for a press on a device while the sim is stopped, from the editor's C
 * and the walking character's E alike. The first press opens a throwaway instance of the part's real behavior,
 * settled to the state its authored params give it (what was already on screen); every press after that goes to
 * the same instance, and the editor steps it each frame while it moves. So the device does exactly what it would
 * in a run (a gate swings and stays open, an E-stop latches in and twists back out, a press that arrives
 * mid-motion is the behavior's to take or ignore), and nothing is replayed or recorded.
 *
 * It is session state, never the document: the Inspector's params are the design, and this is only what the
 * device is doing now. The editor drops the session when the device is back where the design puts it (`atRest`),
 * when its params change (the Inspector's params take over), on Play (a run starts from the design), or on Reset.
 *
 * Two simpler models get this wrong. A recorded "test stroke" always comes home, so a press could not leave a
 * device in the state a press leaves it in. Replaying a count of presses breaks any device whose response takes
 * time: the E-stop ignores replayed presses that arrive mid-twist and snaps back out after every strike.
 */
export class IdleUseSession {
  /** the pose on screen: where the instance is now */
  pose: IdlePose
  private readonly rest: IdlePose
  private acc = 0
  private still = REST_TICKS // opened at the design, settled: nothing moves until a press
  private queued = 0
  private dead = false

  private constructor(
    private readonly handle: number,
    start: IdlePose,
    private readonly zones: Record<string, number> | undefined,
  ) {
    this.pose = start
    this.rest = start
  }

  /** Open a session at the authored state (null when the behavior does not instantiate). */
  static open(source: string, params: Record<string, ParamValue>, zones?: Record<string, number>, jointsJson?: string, arraysJson?: string): IdleUseSession | null {
    const handle = create(source, JSON.stringify(params ?? {}), jointsJson, arraysJson)
    if (handle === 0) return null
    const start = settleTo(handle, 0, zones)
    if (!start) {
      destroy(handle)
      return null
    }
    return new IdleUseSession(handle, start, zones)
  }

  /** A Use: delivered as `ctx.used()` on the next tick, like the running sim delivers it. */
  press(): void {
    if (this.dead) return
    this.queued++
    this.still = 0
  }

  /**
   * Advance by `dt` seconds of wall clock (clamped, so a stalled frame does not fast-forward the device) in fixed
   * preview ticks. True when the pose changed and should be re-applied. It steps for as long as the session lives,
   * quiet or not: a device can hold still (or hold a lamp) mid-cycle and then carry on, and a session that stopped
   * stepping on the first quiet spell would freeze it there. Sessions are few and a step is cheap.
   */
  advance(dt: number): boolean {
    if (this.dead) return false
    this.acc += Math.min(dt, 0.1)
    let changed = false
    while (this.acc >= DT) {
      this.acc -= DT
      const used = this.queued > 0
      if (used) this.queued--
      const out = stepDirect(this.handle, { used, ...(this.zones ? { zones: this.zones } : {}) }, DT)
      if (!out) {
        this.dead = true // a throwing behavior: hold the last good pose
        return changed
      }
      const moving = maxJointDelta(this.pose.joints, out.joints) >= SETTLE_EPS || maxSubPoseDelta(this.pose.subPoses, out.subPoses) >= SETTLE_EPS
      const lamps = Object.keys(out.lamps).length > 0 ? { ...out.lamps } : undefined
      const relit = JSON.stringify(lamps ?? {}) !== JSON.stringify(this.pose.lamps ?? {})
      if (moving || relit) changed = true
      this.pose = { joints: { ...out.joints }, subPoses: out.subPoses, ...(lamps ? { lamps } : {}) }
      this.still = moving || relit || used ? 0 : this.still + 1
    }
    return changed
  }

  /** Nothing queued, and nothing has moved or changed its lamps for a while. */
  get settled(): boolean {
    return this.dead || (this.queued === 0 && this.still >= STILL_TICKS)
  }

  /**
   * Settled back in the state the design gives it, and quiet for long enough to trust it: the press no longer holds
   * anything, and the session can go. The wait is longer than `settled`'s, because ending a session drops whatever
   * the device would still have done: a device that answers a press after a pause would lose the press.
   */
  get atRest(): boolean {
    if (this.dead || this.queued > 0 || this.still < REST_TICKS) return false
    const a = this.pose
    const b = this.rest
    return (
      maxJointDelta(a.joints, b.joints) < SETTLE_EPS &&
      maxJointDelta(b.joints, a.joints) < SETTLE_EPS &&
      maxSubPoseDelta(a.subPoses, b.subPoses) < SETTLE_EPS &&
      JSON.stringify(a.lamps ?? {}) === JSON.stringify(b.lamps ?? {})
    )
  }

  dispose(): void {
    destroy(this.handle)
    this.dead = true
  }
}
